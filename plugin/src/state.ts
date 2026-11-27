// 本地状态库（IndexedDB）：崩溃安全、桌面/手机通用。
// 三态模型的持久层：
//   meta 表   —— 磁盘快照（scan*）+ 上次双方一致的基线（base*）
//   kv 表     —— 服务端游标 cursor、大文件跳过名单等
//   ops 表    —— 待推送操作队列（rename 对、拉取冲突复活等），按插入序推送
//   pending 表 —— blob 下载失败的重试队列（游标已推进，靠这里补齐，绝不静默丢文件）
//   failed 表 —— 超过重试上限进入隔离区的下载项（状态栏显式提示，手动重试可清）
// 状态库随时可丢：丢后走服务端分页快照 + 本地扫描重建，绝不把本地文件当新增全量上传。
export interface PathState {
	path: string;
	// 磁盘快照：上次扫描所见（mtime+size 短路，变了才算哈希）
	scanMtime: number;
	scanSize: number;
	scanHash: string;
	// 基线：上次同步双方一致的版本
	baseHash: string;
	baseMtime: number;
	baseSize: number;
}

export interface PendingDownload {
	seq: number;
	path: string;
	hash: string;
	size: number;
	mtime: number;
	attempts: number;
	lastError: string;
}

export interface QueuedOp {
	id?: number;
	path: string;
	hash: string; // deleted 时为空串
	size: number;
	mtime: number;
	deleted: boolean;
}

const DB_NAME = "fnsync-state";
const DB_VERSION = 1;
const STORES = ["meta", "kv", "ops", "pending", "failed"] as const;
type StoreName = (typeof STORES)[number];

function openDB(): Promise<IDBDatabase> {
	return new Promise((resolve, reject) => {
		const req = indexedDB.open(DB_NAME, DB_VERSION);
		req.onupgradeneeded = () => {
			const db = req.result;
			if (!db.objectStoreNames.contains("meta")) {
				db.createObjectStore("meta", { keyPath: "path" });
			}
			for (const s of ["kv", "ops", "pending", "failed"]) {
				if (!db.objectStoreNames.contains(s)) {
					db.createObjectStore(s, { keyPath: s === "kv" ? "key" : s === "ops" ? "id" : "seq", autoIncrement: s === "ops" });
				}
			}
		};
		req.onsuccess = () => resolve(req.result);
		req.onerror = () => reject(req.error);
	});
}

function txDone(tx: IDBTransaction): Promise<void> {
	return new Promise((resolve, reject) => {
		tx.oncomplete = () => resolve();
		tx.onerror = () => reject(tx.error);
		tx.onabort = () => reject(tx.error ?? new Error("事务中止"));
	});
}

function reqDone<T>(req: IDBRequest<T>): Promise<void> {
	return new Promise((resolve, reject) => {
		req.onsuccess = () => resolve();
		req.onerror = () => reject(req.error);
	});
}

export class StateDB {
	private db: IDBDatabase | null = null;

	async open(): Promise<void> {
		this.db = await openDB();
	}

	private store(name: StoreName, mode: IDBTransactionMode): IDBObjectStore {
		if (!this.db) throw new Error("状态库未打开");
		return this.db.transaction(name, mode).objectStore(name);
	}

	// ---- meta ----
	async metaGet(path: string): Promise<PathState | undefined> {
		return new Promise((resolve, reject) => {
			const r = this.store("meta", "readonly").get(path);
			r.onsuccess = () => resolve(r.result);
			r.onerror = () => reject(r.error);
		});
	}

	async metaAll(): Promise<Map<string, PathState>> {
		return new Promise((resolve, reject) => {
			const out = new Map<string, PathState>();
			const r = this.store("meta", "readonly").openCursor();
			r.onsuccess = () => {
				const cur = r.result;
				if (!cur) return resolve(out);
				out.set(cur.value.path, cur.value);
				cur.continue();
			};
			r.onerror = () => reject(r.error);
		});
	}

	async metaPut(state: PathState): Promise<void> {
		await reqDone(this.store("meta", "readwrite").put(state));
	}

	async metaDelete(path: string): Promise<void> {
		await reqDone(this.store("meta", "readwrite").delete(path));
	}

	async metaClear(): Promise<void> {
		await reqDone(this.store("meta", "readwrite").clear());
	}

	// ---- kv ----
	async kvGet<T>(key: string): Promise<T | undefined> {
		return new Promise((resolve, reject) => {
			const r = this.store("kv", "readonly").get(key);
			r.onsuccess = () => resolve(r.result?.value as T | undefined);
			r.onerror = () => reject(r.error);
		});
	}

	async kvSet(key: string, value: unknown): Promise<void> {
		await reqDone(this.store("kv", "readwrite").put({ key, value }));
	}

	async kvDelete(key: string): Promise<void> {
		await reqDone(this.store("kv", "readwrite").delete(key));
	}

	// ---- ops（按插入序取全部后清空）----
	async opsDrain(): Promise<QueuedOp[]> {
		if (!this.db) throw new Error("状态库未打开");
		const out: QueuedOp[] = [];
		const tx = this.db.transaction(["ops"], "readwrite");
		const os = tx.objectStore("ops");
		await new Promise<void>((resolve, reject) => {
			const r = os.openCursor();
			r.onsuccess = () => {
				const cur = r.result;
				if (!cur) return resolve();
				out.push(cur.value);
				cur.delete();
				cur.continue();
			};
			r.onerror = () => reject(r.error);
		});
		await txDone(tx);
		return out;
	}

	async opsEnqueue(op: QueuedOp): Promise<void> {
		await reqDone(this.store("ops", "readwrite").add(op));
	}

	// ---- pending / failed ----
	async pendingAll(): Promise<PendingDownload[]> {
		return new Promise((resolve, reject) => {
			const out: PendingDownload[] = [];
			const r = this.store("pending", "readonly").openCursor();
			r.onsuccess = () => {
				const cur = r.result;
				if (!cur) return resolve(out);
				out.push(cur.value);
				cur.continue();
			};
			r.onerror = () => reject(r.error);
		});
	}

	async pendingPut(p: PendingDownload): Promise<void> {
		await reqDone(this.store("pending", "readwrite").put(p));
	}

	async pendingDelete(seq: number): Promise<void> {
		await reqDone(this.store("pending", "readwrite").delete(seq));
	}

	async pendingClear(): Promise<void> {
		await reqDone(this.store("pending", "readwrite").clear());
	}

	async failedAll(): Promise<PendingDownload[]> {
		return new Promise((resolve, reject) => {
			const out: PendingDownload[] = [];
			const r = this.store("failed", "readonly").openCursor();
			r.onsuccess = () => {
				const cur = r.result;
				if (!cur) return resolve(out);
				out.push(cur.value);
				cur.continue();
			};
			r.onerror = () => reject(r.error);
		});
	}

	async failedAdd(p: PendingDownload): Promise<void> {
		await reqDone(this.store("failed", "readwrite").put(p));
	}

	async failedDelete(seq: number): Promise<void> {
		await reqDone(this.store("failed", "readwrite").delete(seq));
	}

	/** 重试失败项：failed → pending，等下一轮恢复 */
	async retryFailed(): Promise<number> {
		const items = await this.failedAll();
		for (const p of items) {
			p.attempts = 0;
			await this.pendingPut(p);
			await this.failedDelete(p.seq);
		}
		return items.length;
	}

	async wipeAll(): Promise<void> {
		for (const s of STORES) {
			await reqDone(this.store(s, "readwrite").clear());
		}
	}
}
