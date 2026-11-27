// FN Sync：Obsidian vault 源文件同步插件
// 触发方式（可组合）：启动同步 / 定时同步 / 保存时同步（防抖）/ 手动命令。
// 网络层统一走 requestUrl，桌面与手机同一份代码。
// 移动端现实：进后台 JS 挂起，定时器只在前台活着；本插件在切回前台时补一轮。
import { Plugin, TFile, Notice, PluginSettingTab, App, Setting } from "obsidian";
import { Api } from "./api";
import { SyncEngine, SyncStatus } from "./engine";
import { DEFAULT_SETTINGS, FnSyncSettings } from "./settings";
import { StateDB } from "./state";
import { SyncLog, debounce, formatTime } from "./util";

export default class FnSyncPlugin extends Plugin {
	settings: FnSyncSettings = DEFAULT_SETTINGS;
	state!: StateDB;
	api!: Api;
	engine!: SyncEngine;
	log!: SyncLog;
	private statusEl: HTMLElement | null = null;
	private minuteTimer: number | null = null;
	private saveDebounced: (() => void) | null = null;

	async onload(): Promise<void> {
		await this.loadSettings();

		this.log = new SyncLog(this.settings.logLevel);
		this.state = new StateDB();
		this.api = new Api(this.settings.serverUrl.trim(), this.settings.token.trim());

		this.state
			.open()
			.then(() => {
				this.engine = new SyncEngine(
					this.app,
					this.app.vault,
					this.app.vault.adapter,
					this.state,
					this.api,
					this.settings,
					this.log,
				);
				this.registerTriggers();
				this.registerVaultEvents();
			})
			.catch((err) => {
				this.log.error(`状态库打开失败：${String(err)}`);
				new Notice("fn-sync：IndexedDB 打开失败，同步不可用（详见控制台）");
			});

		this.addCommand({
			id: "sync-now",
			name: "立即同步",
			callback: () => this.engine?.requestSync("手动"),
		});
		this.addCommand({
			id: "retry-failed",
			name: "重试失败项",
			callback: async () => {
				const n = await this.state.retryFailed();
				new Notice(`fn-sync：${n} 个失败项已重新排队`);
				this.engine?.requestSync("重试失败项");
			},
		});
		this.addCommand({
			id: "export-log",
			name: "导出同步日志",
			callback: async () => {
				const text = this.log.exportText();
				await this.app.vault.adapter.write(".fn-sync-log.txt", text);
				new Notice("fn-sync：日志已写入 vault 根目录 .fn-sync-log.txt");
			},
		});
		this.addCommand({
			id: "reset-state",
			name: "重置本地状态库（下次同步走快照重建）",
			callback: async () => {
				if (!this.engine) return;
				await this.engine.resetState();
				new Notice("fn-sync：本地状态库已重置");
			},
		});

		this.addSettingTab(new FnSyncSettingTab(this.app, this));

		this.statusEl = this.addStatusBarItem();
		this.updateStatusBar();
		const timer = window.setInterval(() => this.updateStatusBar(), 1000);
		this.registerInterval(timer);
	}

	onunload(): void {}

	private async loadSettings(): Promise<void> {
		const loaded = (await this.loadData()) as Partial<FnSyncSettings> | null;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, loaded);
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
		this.log?.setLevel(this.settings.logLevel);
		this.api && (this.api.baseUrl = this.settings.serverUrl.trim());
		this.api && (this.api.token = this.settings.token.trim());
		this.engine?.updateSettings(this.settings);
		this.registerTriggers(); // 间隔变了重新挂定时
	}

	// ---- 触发器 ----

	private registerTriggers(): void {
		// 启动同步
		if (this.settings.syncOnStartup) {
			this.app.workspace.onLayoutReady(() => {
				if (this.engine && !this.engine.isSyncing) this.engine.requestSync("启动");
			});
		}
		// 定时同步：每分钟检查是否到期。手机端后台 JS 会挂起，定时器只在前台活着；
		// 配合 visibilitychange 在切回前台时补一轮。
		if (this.minuteTimer !== null) window.clearInterval(this.minuteTimer);
		this.minuteTimer = window.setInterval(() => this.checkIntervalDue(), 60_000);
		this.registerInterval(this.minuteTimer);
		document.removeEventListener("visibilitychange", this.onVisibility);
		document.addEventListener("visibilitychange", this.onVisibility);
	}

	private onVisibility = (): void => {
		if (document.visibilityState === "visible") this.checkIntervalDue(true);
	};

	private checkIntervalDue(force = false): void {
		if (!this.settings.enableInterval || !this.engine) return;
		const mobile = (this.app as unknown as { isMobile: boolean }).isMobile === true;
		const intervalMin = mobile ? this.settings.mobileIntervalMinutes : this.settings.intervalMinutes;
		if (intervalMin <= 0) return;
		const last = this.engine.status.lastSyncTime;
		if (!force && last && Date.now() - last < intervalMin * 60_000) return;
		if (force && this.engine.isSyncing) return;
		this.engine.requestSync(mobile ? "定时（移动端）" : "定时");
	}

	private registerVaultEvents(): void {
		this.registerEvent(
			this.app.vault.on("modify", (file) => {
				if (!(file instanceof TFile)) return;
				if (this.engine?.shouldIgnoreEvent(file.path)) return;
				this.scheduleSaveSync();
			}),
		);
		this.registerEvent(
			this.app.vault.on("delete", (file) => {
				if (this.engine?.shouldIgnoreEvent(file.path)) return;
				this.scheduleSaveSync();
			}),
		);
		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				if (this.engine?.shouldIgnoreEvent(oldPath) && this.engine?.shouldIgnoreEvent(file.path)) return;
				this.engine?.handleRename(oldPath, file.path).then(() => this.scheduleSaveSync());
			}),
		);
	}

	private scheduleSaveSync(): void {
		if (!this.settings.syncOnSave || !this.engine) return;
		if (!this.saveDebounced) {
			this.saveDebounced = debounce(() => this.engine.requestSync("保存"), this.settings.saveDebounceSeconds * 1000);
		}
		this.saveDebounced();
	}

	// ---- 状态栏 ----

	private updateStatusBar(): void {
		if (!this.statusEl || !this.engine) return;
		const s: SyncStatus = this.engine.status;
		let text = "";
		switch (s.phase) {
			case "syncing":
				text = `fn-sync ⟳ 同步中 ↑${s.upOps} ↓${s.downOps}`;
				break;
			case "error":
				text = "fn-sync ⛔ 同步出错";
				break;
			case "partial":
				text = `fn-sync ⚠ 完成（${s.pendingFailures} 项失败）`;
				break;
			case "idle":
				text = s.lastSyncTime ? `fn-sync ✓ ${formatTime(new Date(s.lastSyncTime))}` : "fn-sync ✓";
				break;
		}
		if (this.statusEl.textContent !== text) this.statusEl.textContent = text;
	}
}

class FnSyncSettingTab extends PluginSettingTab {
	constructor(app: App, private plugin: FnSyncPlugin) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		const s = this.plugin.settings;

		new Setting(containerEl).setName("服务端").setHeading();
		new Setting(containerEl)
			.setName("服务器地址")
			.setDesc("如 http://192.168.1.10:8788（局域网）或 https://sync.example.com（公网反代）。注意 requestUrl 不接受自签名证书。")
			.addText((t) =>
				t.setValue(s.serverUrl).onChange(async (v) => {
					s.serverUrl = v;
					await this.plugin.saveSettings();
				}),
			);
		new Setting(containerEl)
			.setName("Token")
			.setDesc("与服务端 OSPS_TOKEN 一致（openssl rand -hex 32 生成）")
			.addText((t) => {
				t.setValue(s.token);
				t.inputEl.type = "password";
				t.onChange(async (v) => {
					s.token = v;
					await this.plugin.saveSettings();
				});
			});
		new Setting(containerEl)
			.setName("测试连接")
			.addButton((b) =>
				b.setButtonText("测试").onClick(async () => {
					try {
						const api = new Api(s.serverUrl.trim(), s.token.trim());
						const h = await api.health();
						new Notice(`连接成功：服务端 ${h.docs} 个文件，${(h.blobBytes / 1048576).toFixed(1)} MB blob`);
					} catch (err) {
						new Notice(`连接失败：${String(err)}`);
					}
				}),
			);

		new Setting(containerEl).setName("触发方式").setHeading();
		new Setting(containerEl)
			.setName("启动时同步")
			.addToggle((t) =>
				t.setValue(s.syncOnStartup).onChange(async (v) => {
					s.syncOnStartup = v;
					await this.plugin.saveSettings();
				}),
			);
		new Setting(containerEl)
			.setName("定时同步")
			.addToggle((t) =>
				t.setValue(s.enableInterval).onChange(async (v) => {
					s.enableInterval = v;
					await this.plugin.saveSettings();
				}),
			);
		new Setting(containerEl)
			.setName("桌面定时间隔（分钟）")
			.addText((t) =>
				t.setValue(String(s.intervalMinutes)).onChange(async (v) => {
					s.intervalMinutes = Math.max(1, parseInt(v) || 5);
					await this.plugin.saveSettings();
				}),
			);
		new Setting(containerEl)
			.setName("移动端定时间隔（分钟）")
			.setDesc("手机端切后台会挂起 JS，定时只在前台有效；切回前台会自动补一轮")
			.addText((t) =>
				t.setValue(String(s.mobileIntervalMinutes)).onChange(async (v) => {
					s.mobileIntervalMinutes = Math.max(1, parseInt(v) || 15);
					await this.plugin.saveSettings();
				}),
			);
		new Setting(containerEl)
			.setName("保存时同步")
			.setDesc("监听文件修改，防抖触发。注意：iOS 上经系统文件 App/iCloud 的外部修改不触发事件，靠定时扫描兜底")
			.addToggle((t) =>
				t.setValue(s.syncOnSave).onChange(async (v) => {
					s.syncOnSave = v;
					await this.plugin.saveSettings();
				}),
			);
		new Setting(containerEl)
			.setName("保存防抖（秒）")
			.addText((t) =>
				t.setValue(String(s.saveDebounceSeconds)).onChange(async (v) => {
					s.saveDebounceSeconds = Math.max(1, parseInt(v) || 3);
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl).setName("同步参数").setHeading();
		new Setting(containerEl)
			.setName("单文件大小上限（MB）")
			.setDesc("超过此大小的文件跳过同步并在状态栏提示，绝不进自动重试循环")
			.addText((t) =>
				t.setValue(String(s.maxBlobSizeMB)).onChange(async (v) => {
					s.maxBlobSizeMB = Math.max(1, parseInt(v) || 100);
					await this.plugin.saveSettings();
				}),
			);
		new Setting(containerEl)
			.setName("排除规则（每行一条，支持 * 通配）")
			.setDesc("默认排除 .obsidian（含 token 等插件配置）、.trash、.fn-sync")
			.addTextArea((t) => {
				t.setValue(s.excludePatterns.join("\n"));
				t.inputEl.rows = 4;
				t.onChange(async (v) => {
					s.excludePatterns = v.split("\n");
					await this.plugin.saveSettings();
				});
			});
		new Setting(containerEl)
			.setName("日志级别")
			.addDropdown((d) =>
				d
					.addOptions({ debug: "debug", info: "info", warn: "warn", error: "error" })
					.setValue(s.logLevel)
					.onChange(async (v) => {
						s.logLevel = v as FnSyncSettings["logLevel"];
						await this.plugin.saveSettings();
					}),
			);
	}
}
