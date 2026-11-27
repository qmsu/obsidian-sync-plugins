// 插件设置
export interface ServerProfile {
	name: string;
	url: string;
	token: string;
}

export interface FnSyncSettings {
	serverUrl: string;
	token: string;
	// 多环境地址方案：保存多组地址+token，手动切换；activeProfile 为空表示手动地址
	profiles: ServerProfile[];
	activeProfile: string;
	// 触发方式（可组合）
	syncOnStartup: boolean;
	enableInterval: boolean;
	intervalMinutes: number; // 桌面定时
	mobileIntervalMinutes: number; // 手机定时（前台有效）
	syncOnSave: boolean;
	saveDebounceSeconds: number;
	// 同步参数
	maxBlobSizeMB: number; // 超限文件跳过并提示，绝不进自动重试循环
	excludePatterns: string[]; // 每行一条，支持 * 通配
	// 其他
	logLevel: "debug" | "info" | "warn" | "error";
	pullBatchSize: number;
}

export const DEFAULT_SETTINGS: FnSyncSettings = {
	serverUrl: "",
	token: "",
	profiles: [],
	activeProfile: "",
	syncOnStartup: true,
	enableInterval: true,
	intervalMinutes: 5,
	mobileIntervalMinutes: 15,
	syncOnSave: true,
	saveDebounceSeconds: 3,
	maxBlobSizeMB: 100,
	excludePatterns: [".obsidian", ".trash", ".fn-sync"],
	logLevel: "info",
	pullBatchSize: 500,
};
