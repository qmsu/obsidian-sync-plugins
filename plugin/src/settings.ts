// 插件设置
export interface FnSyncSettings {
	serverUrl: string;
	token: string;
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
