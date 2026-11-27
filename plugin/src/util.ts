// 通用工具：路径规范化、哈希、日志、防抖、超时
import { normalizePath as obsidianNormalizePath } from "obsidian";

/** vault 相对路径 → 同步路径：obsidian normalize（去首尾斜杠、反斜杠转正斜杠）+ NFC 统一 */
export function toSyncPath(raw: string): string {
	return obsidianNormalizePath(raw).normalize("NFC");
}

export function isValidSyncHash(h: string): boolean {
	return /^[0-9a-f]{64}$/.test(h);
}

export async function sha256Hex(data: ArrayBuffer): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", data);
	return Array.from(new Uint8Array(digest))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

export function uuid(): string {
	if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
	// 兜底：Android WebView 低版本可能没有 randomUUID
	return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
		const r = (Math.random() * 16) | 0;
		const v = c === "x" ? r : (r & 0x3) | 0x8;
		return v.toString(16);
	});
}

export function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

/** 给 Promise 加超时。超时后原 promise 继续在后台跑（requestUrl 无法取消），只放弃等待。 */
export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
	let timer: ReturnType<typeof setTimeout>;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`${label} 超时（${ms}ms）`)), ms);
	});
	p.catch(() => {}); // 防止被放弃的 promise 产生 unhandled rejection
	return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

export function debounce<T extends (...args: any[]) => void>(fn: T, ms: number): T {
	let timer: ReturnType<typeof setTimeout> | null = null;
	return ((...args: any[]) => {
		if (timer) clearTimeout(timer);
		timer = setTimeout(() => {
			timer = null;
			fn(...args);
		}, ms);
	}) as T;
}

export function formatStamp(d: Date): string {
	const p = (n: number) => String(n).padStart(2, "0");
	return (
		`${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
		`-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
	);
}

export function formatTime(d: Date): string {
	const p = (n: number) => String(n).padStart(2, "0");
	return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 简单通配排除规则：`*` 匹配除 / 外任意字符；无通配符时按前缀目录匹配 */
export class Excluder {
	private regexes: { source: string; re: RegExp }[] = [];
	constructor(patterns: string[]) {
		for (const raw of patterns) {
			const pat = raw.trim().normalize("NFC");
			if (!pat || pat.startsWith("#")) continue;
			const escaped = pat
				.replace(/[.+^${}()|[\]\\]/g, "\\$&")
				.replace(/\*/g, "[^/]*")
				.replace(/\?/g, "[^/]");
			this.regexes.push({ source: pat, re: new RegExp(`^${escaped}$`) });
		}
	}
	match(path: string): boolean {
		const p = path.normalize("NFC");
		for (const { source, re } of this.regexes) {
			if (re.test(p)) return true;
			// 无通配符的规则同时匹配其目录前缀（`.obsidian` 排除整个目录）
			if (!source.includes("*") && !source.includes("?") && p.startsWith(source + "/")) {
				return true;
			}
		}
		return false;
	}
}

export type LogLevel = "debug" | "info" | "warn" | "error";
export const LOG_LEVEL_ORDER: Record<LogLevel, number> = {
	debug: 0,
	info: 1,
	warn: 2,
	error: 3,
};

/** 内存环形日志 + 导出。诊断"某个文件为什么没同步"就靠它。 */
export class SyncLog {
	private entries: { ts: number; level: LogLevel; msg: string }[] = [];
	private capacity = 800;
	constructor(public minLevel: LogLevel = "info") {}
	setLevel(level: LogLevel) {
		this.minLevel = level;
	}
	log(level: LogLevel, msg: string) {
		if (LOG_LEVEL_ORDER[level] < LOG_LEVEL_ORDER[this.minLevel]) return;
		this.entries.push({ ts: Date.now(), level, msg });
		if (this.entries.length > this.capacity) this.entries.shift();
	}
	debug(msg: string) { this.log("debug", msg); }
	info(msg: string) { this.log("info", msg); }
	warn(msg: string) { this.log("warn", msg); }
	error(msg: string) { this.log("error", msg); }
	exportText(): string {
		return this.entries
			.map((e) => `${new Date(e.ts).toISOString()} [${e.level.toUpperCase()}] ${e.msg}`)
			.join("\n");
	}
}
