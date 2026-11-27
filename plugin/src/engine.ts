// 同步引擎：单飞队列 + 游标断点续传 + 到达序 LWW 冲突处理。
//
// 每轮 syncOnce 顺序固定：
//   1. recoverPending   —— 先补齐上轮下载失败/中断的文件（per-file 持久 pending，
//                          崩溃恢复后从断点继续，绝不重头、绝不静默丢文件）
//   2. pullPhase        —— 服务端游标增量；断点落窗口外走分页快照对齐
//   3. pushPhase        —— 扫描（mtime+size 短路）→ 差异 → 确保上传 blob → batchId 幂等推送
//   4. pushQueuedOps    —— rename/复活等预排操作
//
// 冲突判定永远基于基线（baseHash，上次双方一致的版本）：
//   本地改了（磁盘≠基线）且远端也改了（远端≠基线）→ 冲突：
//   本地版本落 .conflicts/ 副本（可找回，且会同步到其他设备），然后应用远端版本。
//   只有单方改动时自动跟随，不算冲突。
//
// 自写抑制：插件自己写盘的文件记录在 inFlight，命中 Obsidian modify/create 事件则
// 跳过触发同步，防止"拉取落盘→误判本地修改→空转回传"死循环。
import { App, TFile, Vault, DataAdapter, Notice } from "obsidian";
import { Api, ApiError, PullChange } from "./api";
import { FnSyncSettings } from "./settings";
import { PathState, QueuedOp, StateDB } from "./state";
import { Excluder, SyncLog, formatStamp, sha256Hex, sleep, toSyncPath, uuid } from "./util";

export interface SyncStatus {
	phase: "idle" | "syncing" | "error" | "partial";
	upOps: number;
	downOps: number;
	pendingFailures: number;
	lastSyncTime: number | null;
	lastError: string | null;
}

const MAX_PENDING_ATTEMPTS = 8;
const CONFLICT_DIR = ".conflicts";

/** 手动停止信号：协作式取消，在各阶段边界检查 */
export class StopSignal extends Error {}

export class SyncEngine {
	status: SyncStatus = {
		phase: "idle",
		upOps: 0,
		downOps: 0,
		pendingFailures: 0,
		lastSyncTime: null,
		lastError: null,
	};

	private syncing = false;
	private dirty = false;
	private stopRequested = false;
	private paused = false;
	private inFlight = new Set<string>();
	private blockedPaths = new Set<string>(); // pending/failed 下载中的路径：推送扫描时屏蔽，防回环
	private excluder: Excluder;
	private lastLargeSkipped = new Set<string>();

	constructor(
		private app: App,
		private vault: Vault,
		private adapter: DataAdapter,
		private state: StateDB,
		private api: Api,
		private settings: FnSyncSettings,
		public log: SyncLog,
	) {
		this.excluder = new Excluder(settings.excludePatterns);
	}

	updateSettings(settings: FnSyncSettings) {
		this.settings = settings;
		this.excluder = new Excluder(settings.excludePatterns);
	}

	private get maxBlobBytes(): number {
		return this.settings.maxBlobSizeMB << 20;
	}

	// ---- 调度：单飞队列。同步中的新变更置 dirty，本轮结束立即补一轮 ----

	async requestSync(reason: string): Promise<void> {
		this.dirty = true;
		this.log.debug(`requestSync: ${reason}`);
		if (this.syncing) return;
		this.syncing = true;
		this.stopRequested = false;
		try {
			while (this.dirty) {
				this.dirty = false;
				try {
					await this.syncOnce(reason);
				} catch (err) {
					if (err instanceof StopSignal) break; // 手动停止：终止整轮循环
					throw err;
				}
			}
		} finally {
			this.syncing = false;
		}
	}

	get isSyncing(): boolean {
		return this.syncing;
	}

	/** 手动停止本轮同步（当前 HTTP 请求无法中断，之后的步骤不再执行） */
	stopSync(): void {
		if (this.syncing) {
			this.stopRequested = true;
			this.log.info("收到手动停止请求");
		}
	}

	/** 暂停/恢复自动同步（定时/保存/启动触发器）。返回暂停后的状态。 */
	togglePause(): boolean {
		this.paused = !this.paused;
		this.log.info(this.paused ? "已暂停自动同步（手动同步不受影响）" : "已恢复自动同步");
		return this.paused;
	}

	get isPaused(): boolean {
		return this.paused;
	}

	private checkStop(): void {
		if (this.stopRequested) throw new StopSignal();
	}

	// ---- 一轮同步 ----

	private async syncOnce(reason: string): Promise<void> {
		this.status.phase = "syncing";
		this.status.upOps = 0;
		this.status.downOps = 0;
		try {
			// 服务端变更检测（多环境切换 / 手动改地址）：地址变了就重置本地状态，
			// 下一步走快照对齐。同一服务器换地址时，内容哈希一致，重建零成本；
			// 真换了服务器也能安全对齐，绝不拿旧游标污染新服务端。
			const lastUrl = await this.state.kvGet<string>("serverUrl");
			if (lastUrl !== undefined && lastUrl !== this.api.baseUrl) {
				this.log.info(`服务端地址变更：${lastUrl} → ${this.api.baseUrl}，重置本地状态走快照重建`);
				await this.state.wipeAll();
			}
			await this.state.kvSet("serverUrl", this.api.baseUrl);

			// 本轮开始时锁定下载中的路径集合（pending ∪ failed）
			this.blockedPaths = new Set<string>();
			for (const p of await this.state.pendingAll()) this.blockedPaths.add(p.path);
			for (const p of await this.state.failedAll()) this.blockedPaths.add(p.path);

			await this.recoverPending();
			this.checkStop();
			await this.pullPhase();
			this.checkStop();
			await this.pushQueuedOps();
			this.checkStop();
			await this.pushPhase();
			this.status.phase = this.status.pendingFailures > 0 ? "partial" : "idle";
			this.status.lastSyncTime = Date.now();
			this.status.lastError = null;
			this.log.info(`同步完成（${reason}）`);
		} catch (err) {
			if (err instanceof StopSignal) {
				// 停止不算错误：状态归位，交给 runLoop 终止循环
				this.status.phase = this.status.pendingFailures > 0 ? "partial" : "idle";
				this.log.info(`同步已手动停止（${reason}）`);
				throw err;
			}
			const msg = err instanceof Error ? err.message : String(err);
			const isNewError = this.status.lastError !== msg;
			this.status.phase = "error";
			this.status.lastError = msg;
			this.log.error(`同步失败（${reason}）：${msg}`);
			// 失败要显式可见：同一错误只弹一次，换错误再弹
			if (isNewError) {
				new Notice(`fn-sync 同步失败：${msg}`, 8000);
			}
		}
	}

	// ---- 拉取 ----

	private async pullPhase(): Promise<void> {
		let cursor = (await this.state.kvGet<number>("cursor")) ?? 0;
		const resp = await this.api.pull(cursor, this.settings.pullBatchSize);
		if (resp.needSnapshot) {
			this.log.info("断点超出服务端保留窗口（或新设备），走分页快照对齐");
			cursor = await this.snapshotAlign(cursor);
			await this.state.kvSet("cursor", cursor);
			return;
		}
		let since = cursor;
		for (;;) {
			this.checkStop();
			const batch = await this.api.pull(since, this.settings.pullBatchSize);
			if (batch.needSnapshot) {
				// 拉取中途服务端变更流被清理 → 转快照
				cursor = await this.snapshotAlign(batch.cursor);
				break;
			}
			await this.applyChanges(batch.changes);
			since = batch.cursor;
			// 游标在整批应用（含失败进 pending）之后推进；失败项由 pending 队列补齐
			await this.state.kvSet("cursor", since);
			if ((batch.changes ?? []).length < this.settings.pullBatchSize) break;
		}
		await this.state.kvSet("cursor", since);
	}

	/** 分页快照对齐：与本地扫描逐页合并，绝不把本地文件当新增全量上传 */
	private async snapshotAlign(defaultCursor: number): Promise<number> {
		let after = "";
		let cursor = defaultCursor;
		for (;;) {
			this.checkStop();
			const page = await this.api.snapshotPage(after, 500);
			await this.applyChanges(page.changes, true);
			cursor = page.cursor;
			after = page.changes.length ? page.changes[page.changes.length - 1].path : after;
			if (page.done) break;
		}
		return cursor;
	}

	/** 应用一批远端变更。rebuild=true 表示快照页（未知基线按"不可信本地"处理）。 */
	private async applyChanges(changes: PullChange[] | null | undefined, rebuild = false): Promise<void> {
		for (const ch of changes ?? []) {
			this.checkStop();
			if (this.excluder.match(ch.path)) continue;
			try {
				if (ch.deleted) {
					await this.applyRemoteDelete(ch);
				} else {
					await this.applyRemoteUpdate(ch, rebuild);
				}
				this.status.downOps++;
			} catch (err) {
				if (err instanceof ApiError && err.kind === "http") {
					// 确定性错误（如 blob 404）：隔离，不阻塞后续
					this.log.warn(`远端变更无法应用（隔离）：${ch.path}: ${err.message}`);
					this.status.pendingFailures++;
					continue;
				}
				throw err;
			}
		}
	}

	private async applyRemoteDelete(ch: PullChange): Promise<void> {
		const rec = await this.state.metaGet(ch.path);
		const exists = await this.adapter.exists(ch.path);
		if (!exists) {
			if (rec) await this.state.metaDelete(ch.path);
			return;
		}
		const diskHash = await this.currentDiskHash(ch.path, rec);
		const locallyChanged = !rec || diskHash !== rec.baseHash;
		if (!locallyChanged || diskHash === null) {
			// 本地没改过 → 跟随删除
			await this.removeFile(ch.path);
			if (rec) await this.state.metaDelete(ch.path);
		} else {
			// 本地改过 vs 远端删除：保留本地（新修改胜出），复活推回服务端
			this.log.info(`远端已删除但本地有修改，保留并复活：${ch.path}`);
			await this.queueResurrect(ch.path);
		}
	}

	private async applyRemoteUpdate(ch: PullChange, rebuild: boolean): Promise<void> {
		if (ch.size > this.maxBlobBytes) {
			await this.noteLargeSkipped(ch);
			return;
		}
		const rec = await this.state.metaGet(ch.path);
		const exists = await this.adapter.exists(ch.path);
		if (exists) {
			const diskHash = await this.currentDiskHash(ch.path, rec);
			if (diskHash === ch.hash) {
				// 内容已一致：只推进基线
				await this.recordSynced(ch, diskHash);
				return;
			}
			// 基线未知（状态库丢失/新设备/未跟踪文件）或本地有修改 → 冲突处理：
			// 本地版本留 .conflicts 副本，然后应用远端版本（到达序：远端已定胜负）。
			// 注意不提前删基线记录：下载失败时记录仍在，扫描不会把本地旧内容当新变更回推。
			if (rebuild || !rec || diskHash !== rec.baseHash) {
				if (diskHash !== null) {
					this.log.info(`冲突：双方都修改了 ${ch.path}，本地版本保留到 ${CONFLICT_DIR}/`);
					await this.copyToConflicts(ch.path);
				}
				await this.downloadAndWrite(ch);
				return;
			}
			// 本地没改过 → 直接跟随远端（成功后 recordSynced 覆盖基线）
			await this.downloadAndWrite(ch);
			return;
		}
		// 本地无此文件
		if (rec && rec.scanHash === "" && rec.baseHash === "") {
			// 本地刚删除（墓碑待推送）而远端又有新内容：跟随远端（后到胜出）
			await this.state.metaDelete(ch.path);
		}
		await this.downloadAndWrite(ch);
	}

	private async noteLargeSkipped(ch: PullChange) {
		if (!this.lastLargeSkipped.has(ch.path)) {
			this.lastLargeSkipped.add(ch.path);
			this.log.warn(`文件超过 maxBlobSize（${this.settings.maxBlobSizeMB}MB），跳过：${ch.path}（${ch.size} 字节）`);
			new Notice(`fn-sync：文件过大跳过同步 ${ch.path}`);
		}
		this.status.pendingFailures++;
	}

	// ---- pending 恢复：崩溃/断网后从断点继续，不重头 ----

	private async recoverPending(): Promise<void> {
		const pending = await this.state.pendingAll();
		this.status.pendingFailures = 0;
		for (const p of pending) {
			this.checkStop();
			try {
				const data = await this.api.blobGet(p.hash, p.size);
				await this.writeBinarySuppressed(p.path, data, p.hash);
				await this.state.metaPut({
					path: p.path,
					scanMtime: p.mtime,
					scanSize: p.size,
					scanHash: p.hash,
					baseHash: p.hash,
					baseMtime: p.mtime,
					baseSize: p.size,
				});
				await this.state.pendingDelete(p.seq);
				this.log.info(`恢复成功：${p.path}`);
			} catch (err) {
				p.attempts++;
				p.lastError = err instanceof Error ? err.message : String(err);
				if (p.attempts >= MAX_PENDING_ATTEMPTS) {
					await this.state.failedAdd(p);
					await this.state.pendingDelete(p.seq);
					this.log.warn(`进入隔离区（${MAX_PENDING_ATTEMPTS} 次失败）：${p.path}: ${p.lastError}`);
				} else {
					await this.state.pendingPut(p);
					this.log.debug(`恢复重试 ${p.attempts}/${MAX_PENDING_ATTEMPTS}：${p.path}`);
				}
			}
		}
		const failed = await this.state.failedAll();
		this.status.pendingFailures += failed.length;
		if (failed.length > 0) {
			this.log.warn(`${failed.length} 个文件下载失败进入隔离区，可用"重试失败项"命令`);
		}
	}

	private async downloadAndWrite(ch: PullChange): Promise<void> {
		try {
			const data = await this.api.blobGet(ch.hash, ch.size);
			await this.writeBinarySuppressed(ch.path, data, ch.hash);
			await this.recordSynced(ch, ch.hash);
		} catch (err) {
			// 任何失败（网络/超时/blob 404）都进持久 pending 队列：
			// 游标已推进，靠这里补齐；永久失败的进隔离区并在扫描推送时屏蔽该路径，
			// 防止"下载失败的远端版本 ↔ 本地旧内容"来回 ping-pong。
			this.log.warn(`下载失败，进入重试队列：${ch.path}: ${err instanceof Error ? err.message : err}`);
			this.blockedPaths.add(ch.path);
			await this.state.pendingPut({
				seq: ch.seq,
				path: ch.path,
				hash: ch.hash,
				size: ch.size,
				mtime: ch.mtime,
				attempts: 1,
				lastError: err instanceof Error ? err.message : String(err),
			});
		}
	}

	private async recordSynced(ch: PullChange, scanHash: string): Promise<void> {
		await this.state.metaPut({
			path: ch.path,
			scanMtime: ch.mtime,
			scanSize: ch.size,
			scanHash,
			baseHash: ch.hash,
			baseMtime: ch.mtime,
			baseSize: ch.size,
		});
	}

	// ---- 预排操作（rename 对、拉取阶段复活的推送）----

	private async pushQueuedOps(): Promise<void> {
		const ops = await this.state.opsDrain();
		if (ops.length === 0) return;
		this.log.debug(`推送预排操作 ${ops.length} 条`);
		try {
			await this.pushOpBatches(ops);
		} catch (err) {
			// 推送失败：重新入队，不能让预排操作（如 rename 对）丢失
			for (const op of ops) {
				await this.state.opsEnqueue(op);
			}
			throw err;
		}
	}

	private async queueResurrect(path: string): Promise<void> {
		const data = await this.adapter.readBinary(path);
		const hash = await sha256Hex(data);
		const stat = await this.adapter.stat(path);
		const mtime = stat?.mtime ?? Date.now();
		await this.state.opsEnqueue({ path, hash, size: data.byteLength, mtime, deleted: false });
		// 立即推进本地记录，避免下轮扫描重复入队
		await this.state.metaPut({
			path,
			scanMtime: mtime,
			scanSize: data.byteLength,
			scanHash: hash,
			baseHash: hash,
			baseMtime: mtime,
			baseSize: data.byteLength,
		});
	}

	/** rename 事件：旧路径墓碑 + 新路径同内容推送，一次成对入队（保证删除先于新增） */
	async handleRename(oldPath: string, newPath: string): Promise<void> {
		const oldP = toSyncPath(oldPath);
		const newP = toSyncPath(newPath);
		if (this.excluder.match(newP)) {
			if (!this.excluder.match(oldP)) {
				await this.state.opsEnqueue({ path: oldP, hash: "", size: 0, mtime: 0, deleted: true });
			}
			return;
		}
		const rec = await this.state.metaGet(oldP);
		if (rec) await this.state.metaDelete(oldP);
		const exists = await this.adapter.exists(newP);
		if (!exists) return;
		const data = await this.adapter.readBinary(newP);
		const hash = await sha256Hex(data);
		const stat = await this.adapter.stat(newP);
		if (!stat) {
			this.log.warn(`rename 后无法 stat 新路径，跳过：${newP}`);
			return;
		}
		if (!this.excluder.match(oldP)) {
			await this.state.opsEnqueue({ path: oldP, hash: "", size: 0, mtime: 0, deleted: true });
		}
		await this.state.opsEnqueue({ path: newP, hash, size: data.byteLength, mtime: stat.mtime, deleted: false });
		await this.state.metaPut({
			path: newP,
			scanMtime: stat.mtime,
			scanSize: data.byteLength,
			scanHash: hash,
			baseHash: hash,
			baseMtime: stat.mtime,
			baseSize: data.byteLength,
		});
		// baseHash 未知时（未跟踪文件改名）仍需推送新路径；删除旧路径仅在已同步时才有墓碑意义
		this.log.debug(`rename：${oldP} → ${newP}`);
	}

	// ---- 推送 ----

	private async pushPhase(): Promise<void> {
		const files = await this.walkVault();
		const recs = await this.state.metaAll();

		// 反向比对：状态库里有、磁盘上没有 → 本地删除（墓碑）
		// blockedPaths 不动：其远端下载还在重试，不能凭"磁盘暂缺"下墓碑结论
		const tombstones: QueuedOp[] = [];
		for (const [path, rec] of recs) {
			if (this.blockedPaths.has(path)) continue;
			if (!files.has(path)) {
				if (rec.baseHash) {
					tombstones.push({ path, hash: "", size: 0, mtime: 0, deleted: true });
				}
				await this.state.metaDelete(path);
			}
		}
		if (tombstones.length > 0) {
			this.log.info(`本地删除 ${tombstones.length} 个文件，推送墓碑`);
			await this.pushOpBatches(tombstones);
		}

		// 正向扫描：新增/修改（mtime+size 短路，变了才算哈希）
		type Change = { path: string; data: ArrayBuffer; hash: string; size: number; mtime: number };
		const changed: Change[] = [];
		for (const [rawPath, st] of files) {
			if (this.excluder.match(rawPath)) continue;
			if (this.blockedPaths.has(rawPath)) continue; // 下载重试中，不推送
			this.checkStop();
			const rec = recs.get(rawPath);
			if (rec && rec.scanMtime === st.mtime && rec.scanSize === st.size && rec.scanHash === rec.baseHash) {
				continue; // 未变
			}
			if (st.size > this.maxBlobBytes) {
				if (!this.lastLargeSkipped.has(rawPath)) {
					this.lastLargeSkipped.add(rawPath);
					this.log.warn(`文件超过 maxBlobSize，跳过上传：${rawPath}`);
					new Notice(`fn-sync：文件过大跳过同步 ${rawPath}`);
				}
				continue;
			}
			let data: ArrayBuffer;
			try {
				data = await this.adapter.readBinary(rawPath);
			} catch (err) {
				this.log.warn(`读取失败，本轮跳过：${rawPath}: ${String(err)}`);
				continue;
			}
			const hash = await sha256Hex(data);
			if (rec && rec.scanHash === hash && rec.baseHash !== hash) {
				// mtime 变了但内容与上次扫描相同（外部程序触碰）——更新快照即可
				await this.state.metaPut({ ...rec, scanMtime: st.mtime, scanSize: st.size });
				continue;
			}
			if (rec && hash === rec.baseHash) {
				// touch 回基线内容：跟随，无需推送
				await this.state.metaPut({
					...rec,
					scanMtime: st.mtime,
					scanSize: st.size,
					scanHash: hash,
				});
				continue;
			}
			changed.push({ path: rawPath, data, hash, size: data.byteLength, mtime: st.mtime });
		}

		if (changed.length === 0) {
			await this.retryPushConflictsIfAny();
			return;
		}
		this.log.info(`推送 ${changed.length} 个本地变更`);

		// 分块处理，控制内存与请求体积
		const CHUNK = 25;
		for (let i = 0; i < changed.length; i += CHUNK) {
			this.checkStop();
			const group = changed.slice(i, i + CHUNK);
			// 确保服务端已有 blob（内容寻址，同一内容全库只传一次）。
			// 单个上传失败只跳过该文件（下轮自动重试），不拖死同批其他文件。
			const missing = await this.api.blobsExist(group.map((c) => c.hash));
			const ops: QueuedOp[] = [];
			for (const c of group) {
				if (missing.includes(c.hash)) {
					try {
						await this.api.blobPut(c.hash, c.data);
						this.log.debug(`上传 blob：${c.path}（${c.size} 字节）`);
					} catch (err) {
						const msg = err instanceof Error ? err.message : String(err);
						this.log.warn(`上传失败，下轮重试：${c.path}（${c.size} 字节，hash ${c.hash.slice(0, 8)}…）：${msg}`);
						continue;
					}
				}
				ops.push({ path: c.path, hash: c.hash, size: c.size, mtime: c.mtime, deleted: false });
			}
			if (ops.length > 0) {
				await this.pushOpBatches(ops);
			}
		}
		await this.retryPushConflictsIfAny();
	}

	private pushConflictsReported = false;
	private async retryPushConflictsIfAny(): Promise<void> {
		// 占位：冲突 path 的处理在 pushOpBatches 中记录日志，这里统一提示一次
		if (this.pushConflictsReported) {
			new Notice("fn-sync：有 path 被服务端拒绝（大小写/Unicode 冲突），详见同步日志");
			this.pushConflictsReported = false;
		}
	}

	private async pushOpBatches(ops: QueuedOp[]): Promise<void> {
		const BATCH = 200;
		for (let i = 0; i < ops.length; i += BATCH) {
			const batch = ops.slice(i, i + BATCH);
			await this.pushOpBatchWithRetry(batch);
			this.status.upOps += batch.length;
		}
	}

	/** 单批推送：batchId 幂等，412（blob 缺失）补传后同 batchId 重试，4xx 不盲重试 */
	private async pushOpBatchWithRetry(ops: QueuedOp[]): Promise<void> {
		const batchId = uuid();
		for (let attempt = 0; attempt < 4; attempt++) {
			this.checkStop();
			try {
				const resp = await this.api.push(batchId, ops);
				if (resp.conflicts && resp.conflicts.length > 0) {
					this.pushConflictsReported = true;
					for (const p of resp.conflicts) {
						this.log.warn(`服务端拒绝（大小写/Unicode 冲突）：${p} —— 请重命名该文件`);
					}
				}
				// 推送成功：更新基线
				for (const op of ops) {
					if (op.deleted) {
						await this.state.metaDelete(op.path);
					} else {
						const rec = await this.state.metaGet(op.path);
						await this.state.metaPut({
							path: op.path,
							scanMtime: rec?.scanMtime ?? op.mtime,
							scanSize: rec?.scanSize ?? op.size,
							scanHash: rec?.scanHash ?? op.hash,
							baseHash: op.hash,
							baseMtime: op.mtime,
							baseSize: op.size,
						});
					}
				}
				return;
			} catch (err) {
				if (err instanceof ApiError && err.status === 412 && attempt < 3) {
					// blob 在服务端缺失（如被 GC 竞态清走）：补传后重试
					this.log.warn("服务端缺 blob，补传后重试同批次");
					for (const op of ops) {
						if (op.deleted) continue;
						try {
							const data = await this.adapter.readBinary(op.path);
							const hash = await sha256Hex(data);
							if (hash === op.hash) await this.api.blobPut(hash, data);
						} catch {
							// 文件已消失：保持原 hash 重试让服务端裁决
						}
					}
					continue;
				}
				if (err instanceof ApiError && err.kind === "http") throw err;
				if (attempt === 3) throw err;
				await sleep(1000 * (attempt + 1)); // 网络错误退避重试
			}
		}
	}

	// ---- 文件系统操作 ----

	/** 递归遍历 vault（走 adapter，独立于 Obsidian 索引，能捕获外部删除/新增） */
	private async walkVault(): Promise<Map<string, { mtime: number; size: number }>> {
		const out = new Map<string, { mtime: number; size: number }>();
		const walk = async (dir: string): Promise<void> => {
			const res = await this.adapter.list(dir);
			for (const f of res.files) {
				const p = toSyncPath(f);
				if (this.excluder.match(p)) continue;
				try {
					const st = await this.adapter.stat(f);
					if (st) out.set(p, { mtime: st.mtime, size: st.size });
				} catch {
					// stat 失败（如刚被删）：跳过
				}
			}
			for (const d of res.folders) {
				await walk(d);
			}
		};
		await walk("/");
		return out;
	}

	/** 磁盘当前内容 hash：快照命中（mtime+size 一致）直接复用，否则现算 */
	private async currentDiskHash(path: string, rec: PathState | undefined): Promise<string | null> {
		try {
			const st = await this.adapter.stat(path);
			if (!st) return null;
			if (rec && rec.scanMtime === st.mtime && rec.scanSize === st.size && rec.scanHash) {
				return rec.scanHash;
			}
			const data = await this.adapter.readBinary(path);
			return await sha256Hex(data);
		} catch {
			return null;
		}
	}

	/** 冲突副本：`.conflicts/<原目录>/<名> (conflict <时间戳>).<扩展名>`，随 vault 正常同步 */
	private async copyToConflicts(path: string): Promise<void> {
		try {
			const data = await this.adapter.readBinary(path);
			const segs = path.split("/");
			const name = segs.pop()!;
			const dir = segs.length ? segs.join("/") + "/" : "";
			const dot = name.lastIndexOf(".");
			const base = dot > 0 ? name.slice(0, dot) : name;
			const ext = dot > 0 ? name.slice(dot) : "";
			const stamp = formatStamp(new Date());
			let target = `${CONFLICT_DIR}/${dir}${base} (conflict ${stamp})${ext}`;
			let n = 1;
			while (await this.adapter.exists(target)) {
				target = `${CONFLICT_DIR}/${dir}${base} (conflict ${stamp}-${n++})${ext}`;
			}
			await this.writeBinary(target, data); // 不抑制：这是真实的新文件，走正常扫描推送
			this.log.info(`冲突副本已保存：${target}`);
		} catch (err) {
			this.log.error(`保存冲突副本失败（原文件仍会应用远端版本）：${path}: ${String(err)}`);
		}
	}

	/** 插件自己的写盘：登记 inFlight 自写抑制，写后重读校验哈希，防半截内容入库 */
	private async writeBinarySuppressed(path: string, data: ArrayBuffer, expectedHash: string): Promise<void> {
		this.inFlight.add(path);
		try {
			await this.writeBinary(path, data);
			// 校验落盘内容
			const verify = await this.adapter.readBinary(path);
			const actual = await sha256Hex(verify);
			if (actual !== expectedHash) {
				await this.adapter.remove(path).catch(() => {});
				throw new Error(`落盘校验失败：${path}（写入 ${expectedHash.slice(0, 8)}…，读回 ${actual.slice(0, 8)}…）`);
			}
		} finally {
			// 延迟移除，给 Obsidian 的 modify 事件留触发窗口
			const p = path;
			setTimeout(() => this.inFlight.delete(p), 800);
		}
	}

	/** 写文件：优先走 vault API 保持索引/事件一致 */
	async writeBinary(path: string, data: ArrayBuffer): Promise<void> {
		const abstract = this.vault.getAbstractFileByPath(path);
		if (abstract instanceof TFile) {
			await this.vault.modifyBinary(abstract, data);
		} else if (await this.adapter.exists(path)) {
			// 文件存在但未入索引（罕见）：走 adapter 直写
			await this.adapter.writeBinary(path, data);
		} else {
			// 确保父目录存在
			const segs = path.split("/");
			segs.pop();
			if (segs.length) {
				const parent = segs.join("/");
				if (!(await this.adapter.exists(parent))) {
					await this.vault.createFolder(parent);
				}
			}
			await this.vault.createBinary(path, data);
		}
	}

	private async removeFile(path: string): Promise<void> {
		const abstract = this.vault.getAbstractFileByPath(path);
		if (abstract instanceof TFile) {
			await this.vault.trash(abstract, true); // 系统回收站，可找回
			return;
		}
		if (await this.adapter.exists(path)) {
			await this.adapter.remove(path);
		}
	}

	/** Obsidian modify/create 事件入口：自写抑制命中则跳过 */
	shouldIgnoreEvent(path: string): boolean {
		const p = toSyncPath(path);
		if (this.inFlight.has(p)) return true;
		return this.excluder.match(p);
	}

	// ---- 状态库重建 ----

	async resetState(): Promise<void> {
		await this.state.wipeAll();
		this.lastLargeSkipped.clear();
		this.log.info("本地状态库已重置，下次同步将走快照重建");
	}
}
