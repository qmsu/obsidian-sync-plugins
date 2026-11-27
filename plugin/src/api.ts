// 服务端 API 客户端：全部走 requestUrl（Obsidian 原生网络层，桌面/手机一致，绕过 CORS）。
// 错误分类：网络错误/超时可退避重试；4xx 是确定性错误不重试（401 无限重试是常见卡死形态）。
import { requestUrl } from "obsidian";
import { isValidSyncHash, sha256Hex, withTimeout } from "./util";
import type { QueuedOp } from "./state";

export interface PullChange {
	seq: number;
	path: string;
	hash: string;
	size: number;
	mtime: number;
	deleted: boolean;
}

export interface PullResp {
	cursor: number;
	minSeq: number;
	maxSeq: number;
	needSnapshot: boolean;
	changes: PullChange[];
}

export interface PushOp extends QueuedOp {}

export interface PushResp {
	ok: boolean;
	dup?: boolean;
	applied: number;
	skipped: number;
	conflicts?: string[];
	cursor: number;
}

export class ApiError extends Error {
	constructor(
		public kind: "network" | "timeout" | "http",
		public status: number | undefined,
		message: string,
	) {
		super(message);
	}
	get retryable(): boolean {
		return this.kind !== "http";
	}
}

export class Api {
	constructor(
		public baseUrl: string,
		public token: string,
		private timeoutMs = 60000,
	) {}

	private async req(
		method: string,
		path: string,
		opts: { body?: ArrayBuffer | string; headers?: Record<string, string>; timeoutMs?: number } = {},
	): Promise<{ status: number; body: ArrayBuffer; text: string }> {
		const url = this.baseUrl.replace(/\/+$/, "") + path;
		let resp;
		try {
			resp = await withTimeout(
				requestUrl({
					url,
					method,
					body: opts.body,
					headers: {
						Authorization: `Bearer ${this.token}`,
						...(opts.headers ?? {}),
					},
					throw: false,
				}),
				opts.timeoutMs ?? this.timeoutMs,
				`${method} ${path}`,
			);
		} catch (err) {
			if (err instanceof ApiError) throw err;
			throw new ApiError("network", undefined, `${method} ${path}: ${String(err)}`);
		}
		if (resp.status >= 400) {
			let detail = "";
			try {
				const j = await resp.json;
				detail = j?.error ?? "";
			} catch {
				detail = "";
			}
			throw new ApiError("http", resp.status, `${method} ${path}: HTTP ${resp.status} ${detail}`);
		}
		return { status: resp.status, body: await resp.arrayBuffer, text: await resp.text };
	}

	private async reqJSON<T>(method: string, path: string, body?: unknown, timeoutMs?: number): Promise<T> {
		const r = await this.req(method, path, {
			body: body === undefined ? undefined : JSON.stringify(body),
			headers: { "Content-Type": "application/json" },
			timeoutMs,
		});
		return JSON.parse(r.text) as T;
	}

	// ---- 元数据 ----

	health(): Promise<{ ok: boolean; docs: number; blobs: number; blobBytes: number }> {
		return this.reqJSON("GET", "/health", undefined, 10000);
	}

	/** 鉴权探测：/health 免鉴权测不出 token 对错，用需鉴权的接口真实验证 */
	async authProbe(): Promise<{ ok: boolean }> {
		await this.reqJSON("GET", "/api/v1/meta/pull?since=0&limit=1");
		return { ok: true };
	}

	async pull(since: number, limit: number): Promise<PullResp> {
		return this.reqJSON("GET", `/api/v1/meta/pull?since=${since}&limit=${limit}`);
	}

	snapshotPage(after: string, limit: number): Promise<{ cursor: number; done: boolean; changes: PullChange[] }> {
		const a = after ? encodeURIComponent(after) : "";
		return this.reqJSON("GET", `/api/v1/meta/snapshot?after=${a}&limit=${limit}`);
	}

	push(batchId: string, ops: PushOp[]): Promise<PushResp> {
		return this.reqJSON("POST", "/api/v1/meta/push", {
			clientId: "obsidian",
			batchId,
			ops,
		});
	}

	lookup(paths: string[]): Promise<{ docs: Record<string, PullChange> }> {
		return this.reqJSON("POST", "/api/v1/meta/lookup", { paths });
	}

	// ---- blob ----

	async blobsExist(hashes: string[]): Promise<string[]> {
		if (hashes.length === 0) return [];
		const r = await this.reqJSON<{ missing?: string[] }>("POST", "/api/v1/blobs/exists", { hashes });
		return r.missing ?? [];
	}

	async blobPut(hash: string, data: ArrayBuffer, timeoutMs?: number): Promise<void> {
		await this.req("PUT", `/api/v1/blob/${hash}`, { body: data, timeoutMs });
	}

	/** 下载 blob，>chunkSize 时用 Range 分片（防长链路单请求超时），最后整体校验 SHA-256。 */
	async blobGet(hash: string, size: number, chunkSize = 8 << 20): Promise<ArrayBuffer> {
		if (!isValidSyncHash(hash)) throw new ApiError("http", undefined, "非法 hash");
		if (size > 0 && size <= chunkSize) {
			const r = await this.req("GET", `/api/v1/blob/${hash}`);
			return this.verifyBlob(r.body, hash);
		}
		// 分片下载（size 未知时也走这里，循环到拿不到更多数据为止）
		const chunks: Uint8Array[] = [];
		let start = 0;
		let total = size;
		for (;;) {
			const headers: Record<string, string> = total > 0 ? { Range: `bytes=${start}-${start + chunkSize - 1}` } : {};
			const r = await this.req("GET", `/api/v1/blob/${hash}`, { headers });
			if (r.body.byteLength === 0) break;
			chunks.push(new Uint8Array(r.body));
			start += r.body.byteLength;
			if (total > 0 && start >= total) break;
			if (total === 0 && r.body.byteLength < chunkSize) break;
		}
		const out = new Uint8Array(start);
		let off = 0;
		for (const c of chunks) {
			out.set(c, off);
			off += c.byteLength;
		}
		return this.verifyBlob(out.buffer, hash);
	}

	private async verifyBlob(data: ArrayBuffer, hash: string): Promise<ArrayBuffer> {
		const actual = await sha256Hex(data);
		if (actual !== hash) {
			throw new ApiError("http", undefined, `下载内容哈希不符（${actual.slice(0, 8)}…）`);
		}
		return data;
	}
}
