# FN Sync — Obsidian vault 源文件同步

自建服务端的 Obsidian 同步方案：**桌面 + 手机同一份插件**，源文件原样同步，冲突自动解决，大 vault 断点续传不从头。

```
┌─────────────────────┐   HTTP/HTTPS    ┌────────────────────────────┐
│ plugin/  (Obsidian) │ ──────────────► │ server/ (obsidian-sync-    │
│ 桌面 + 手机同一代码    │                 │ plugins-server, Go)        │
│ IndexedDB 断点状态    │                 │ SQLite 元数据 + blob 存储   │
└─────────────────────┘                 └────────────────────────────┘
```

## 核心特性

1. **源文件直接同步**：vault 原始文件按 SHA-256 内容寻址上传，不做任何格式转换；同一内容全库只存一份
2. **冲突自动解决**：到达序 LWW（服务端 seq 定胜负，跨设备不可靠的 mtime 不参与判定），被覆盖的一方自动保留 `.conflicts/` 副本，内容绝不丢
3. **触发方式可组合**：启动同步 / 定时同步（桌面与移动端间隔分开配置）/ 保存时同步（防抖）/ 手动命令；状态栏实时显示
4. **大数据量不失败**：游标断点续传（中断后从断点继续，绝不重头）、batchId 幂等重试、per-file pending 补齐、失败隔离区不堵队列、分页快照兜底（状态库丢了也能便宜重建）
5. **手机端支持**：requestUrl 原生网络层；前台定时 + 切回前台自动补一轮；注意 iOS 后台不同步（系统限制）

## 快速开始

1. **部署服务端**：见 [server/README.md](server/README.md)（NAS Docker Compose 一条命令），拿到 `serverUrl` 与 token
2. **装插件**：把 `plugin/` 的 `manifest.json`、`main.js` 复制到 vault 的 `.obsidian/plugins/fnsync/`（本地构建：`cd plugin && npm install && npm run build`）
3. **配置**：插件设置里填服务器地址 + token，「测试连接」通过即可
4. 协议细节：[docs/protocol.md](docs/protocol.md)

## 已知限制（如实告知）

- 手机切后台后 JS 挂起，**后台不同步**；切回前台/重新打开 App 时自动补一轮
- 经系统文件 App / iCloud 的外部修改不触发 Obsidian 事件，靠定时扫描兜底
- 自签名 HTTPS 证书不可用（requestUrl 限制），公网请用 Let's Encrypt；局域网 HTTP 直连可用
- 超过 `maxBlobSize` 的文件跳过同步并显式提示，不进自动重试循环
- `.obsidian/` 默认排除（token 等插件配置不出库）；`.conflicts/` 正常同步

## 目录

- `server/` — Go 服务端（含 Dockerfile / docker-compose / 测试）
- `plugin/` — Obsidian 插件（TypeScript）
- `docs/protocol.md` — 同步协议与冲突/GC 语义
