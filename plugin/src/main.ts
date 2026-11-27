// FN Sync：Obsidian vault 源文件同步插件
// 触发方式（可组合）：启动同步 / 定时同步 / 保存时同步（防抖）/ 手动命令。
// 网络层统一走 requestUrl，桌面与手机同一份代码。
// 移动端现实：进后台 JS 挂起，定时器只在前台活着；本插件在切回前台时补一轮。
import { Plugin, TFile, Notice, PluginSettingTab, App, Setting, Modal, SuggestModal } from "obsidian";
import { Api, ApiError } from "./api";
import { SyncEngine, SyncStatus } from "./engine";
import { DEFAULT_SETTINGS, FnSyncSettings, ServerProfile } from "./settings";
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
			id: "switch-server",
			name: "切换服务器地址",
			callback: () => new SwitchServerModal(this).open(),
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
			id: "view-log",
			name: "查看同步日志",
			callback: () => new LogModal(this.app, () => this.log.exportText()).open(),
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

	// ---- 多环境地址切换 ----

	/** 应用一个地址方案（null = 回到手动地址，即设置里直接填的 serverUrl/token） */
	async applyProfile(profile: ServerProfile | null): Promise<void> {
		if (profile) {
			this.settings.activeProfile = profile.name;
			this.settings.serverUrl = profile.url;
			this.settings.token = profile.token;
		} else {
			this.settings.activeProfile = "";
		}
		await this.saveSettings();
		new Notice(
			profile
				? `fn-sync：已切换到「${profile.name}」${profile.url}`
				: "fn-sync：已切换到手动地址",
		);
		if (this.engine) this.engine.requestSync("切换服务器地址");
	}

	// ---- 状态栏 ----

	private updateStatusBar(): void {
		if (!this.statusEl || !this.engine) return;
		const s: SyncStatus = this.engine.status;
		const tag = this.settings.activeProfile ? `[${this.settings.activeProfile}] ` : "";
		let text = "";
		switch (s.phase) {
			case "syncing":
				text = `${tag}fn-sync ⟳ 同步中 ↑${s.upOps} ↓${s.downOps}`;
				break;
			case "error":
				text = `${tag}fn-sync ⛔ 同步出错`;
				break;
			case "partial":
				text = `${tag}fn-sync ⚠ 完成（${s.pendingFailures} 项失败）`;
				break;
			case "idle":
				text = s.lastSyncTime
					? `${tag}fn-sync ✓ ${formatTime(new Date(s.lastSyncTime))}`
					: `${tag}fn-sync ✓`;
				break;
		}
		if (this.statusEl.textContent !== text) this.statusEl.textContent = text;
	}
}

/** 地址方案切换弹窗：列出已保存方案 + 当前手动地址 */
class SwitchServerModal extends SuggestModal<ServerProfile | { manual: true }> {
	constructor(private plugin: FnSyncPlugin) {
		super(plugin.app);
	}

	getSuggestions(): (ServerProfile | { manual: true })[] {
		const out: (ServerProfile | { manual: true })[] = [];
		if (this.plugin.settings.serverUrl) out.push({ manual: true });
		out.push(...this.plugin.settings.profiles);
		return out;
	}

	renderSuggestion(item: ServerProfile | { manual: true }, el: HTMLElement): void {
		const active = this.plugin.settings.activeProfile;
		if ("manual" in item) {
			el.setText(`手动地址（设置里填写）${active === "" ? " ←当前" : ""}`);
			el.createEl("small", { text: ` ${this.plugin.settings.serverUrl}`, cls: "fnsync-muted" });
		} else {
			el.setText(`${item.name}${active === item.name ? " ←当前" : ""}`);
			el.createEl("small", { text: ` ${item.url}`, cls: "fnsync-muted" });
		}
	}

	onChooseSuggestion(item: ServerProfile | { manual: true }): void {
		if ("manual" in item) {
			this.plugin.applyProfile(null);
		} else {
			this.plugin.applyProfile(item);
		}
	}
}

/** 同步日志查看器：命令面板「查看同步日志」直接弹出，不用导出文件 */
class LogModal extends Modal {
	constructor(
		app: App,
		private getContent: () => string,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.createEl("h3", { text: "fn-sync 同步日志（最近 800 条）" });
		const pre = contentEl.createEl("pre");
		pre.setText(this.getContent() || "（暂无日志）");
		pre.setCssStyles({
			maxHeight: "55vh",
			overflow: "auto",
			fontSize: "12px",
			whiteSpace: "pre-wrap",
			wordBreak: "break-all",
			background: "var(--background-secondary)",
			padding: "10px",
			borderRadius: "6px",
		});
		const btns = contentEl.createDiv();
		btns.setCssStyles({ display: "flex", gap: "8px", marginTop: "10px" });
		btns
			.createEl("button", { text: "刷新" })
			.addEventListener("click", () => pre.setText(this.getContent() || "（暂无日志）"));
		btns.createEl("button", { text: "复制全部" }).addEventListener("click", async () => {
			await navigator.clipboard.writeText(this.getContent());
			new Notice("已复制");
		});
		btns.createEl("button", { text: "导出到文件" }).addEventListener("click", async () => {
			const text = this.getContent();
			// 通过全局 app 引用写文件（Modal 里拿不到插件实例）
			const adapter = (this.app.vault as { adapter: { write(p: string, d: string): Promise<void> } }).adapter;
			await adapter.write(".fn-sync-log.txt", text);
			new Notice("已写入 vault 根目录 .fn-sync-log.txt");
		});
	}

	onClose(): void {
		this.contentEl.empty();
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
					const api = new Api(s.serverUrl.trim(), s.token.trim());
					try {
						const h = await api.health();
						try {
							await api.authProbe();
							new Notice(`连接成功：服务端 ${h.docs} 个文件，${(h.blobBytes / 1048576).toFixed(1)} MB blob，token 验证通过`);
						} catch (err) {
							const msg = err instanceof ApiError && err.status === 401
								? "token 错误（401）—— 与服务端 OSPS_TOKEN 不一致"
								: String(err);
							new Notice(`网络通了，但鉴权失败：${msg}`);
						}
					} catch (err) {
						new Notice(`连接失败：${String(err)}`);
					}
				}),
			);

		new Setting(containerEl).setName("多环境地址方案").setHeading();
		new Setting(containerEl)
			.setName("当前方案")
			.setDesc("切换后自动同步一轮；指向不同服务器时会自动重置本地状态走快照重建")
			.addDropdown((d) => {
				d.addOption("__manual__", "手动地址");
				for (const p of s.profiles) d.addOption(p.name, p.name);
				d.setValue(s.activeProfile || "__manual__").onChange(async (v) => {
					if (v === "__manual__") {
						await this.plugin.applyProfile(null);
					} else {
						const p = s.profiles.find((x) => x.name === v);
						if (p) await this.plugin.applyProfile(p);
					}
					this.display();
				});
			});
		s.profiles.forEach((p, i) => {
			const row = new Setting(containerEl).setName(p.name || "（未命名）");
			row.addText((t) => {
				t.setPlaceholder("方案名").setValue(p.name);
				t.inputEl.style.width = "7em";
				t.onChange(async (v) => {
					const oldName = p.name;
					p.name = v.trim();
					if (s.activeProfile === oldName) {
						s.activeProfile = p.name;
					}
					await this.plugin.saveSettings();
					// 不整页重渲染（会销毁输入框丢焦点）；只更新行标题
					row.setName(p.name || "（未命名）");
				});
			});
			row.addText((t) =>
				t.setPlaceholder("http://192.168.1.10:8788").setValue(p.url).onChange(async (v) => {
					p.url = v.trim();
					if (s.activeProfile === p.name) {
						s.serverUrl = p.url;
					}
					await this.plugin.saveSettings();
				}),
			);
			row.addText((t) => {
				t.setPlaceholder("token").setValue(p.token);
				t.inputEl.type = "password";
				t.onChange(async (v) => {
					p.token = v.trim();
					if (s.activeProfile === p.name) {
						s.token = p.token;
					}
					await this.plugin.saveSettings();
				});
			});
			row.addButton((b) =>
				b.setIcon("trash").setTooltip("删除方案").onClick(async () => {
					s.profiles.splice(i, 1);
					if (s.activeProfile === p.name) s.activeProfile = "";
					await this.plugin.saveSettings();
					this.display();
				}),
			);
		});
		new Setting(containerEl).addButton((b) =>
			b.setButtonText("+ 新增方案").onClick(async () => {
				s.profiles.push({ name: `方案${s.profiles.length + 1}`, url: "", token: "" });
				await this.plugin.saveSettings();
				this.display();
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
