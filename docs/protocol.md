# FN Sync 同步协议 v1

客户端：`plugin/`（Obsidian 插件，桌面 + 手机同一份代码）
服务端：`server/`（Go 单二进制 `obsidian-sync-plugins-server`）

设计原则：**到达序 LWW**（服务端 seq 即权威版本序，客户端 mtime 仅展示）、**内容寻址**（SHA-256 blob 去重）、**batchId 幂等**、**分页快照兜底**、**游标断点续传**。

## 鉴权

所有 `/api` 请求带 `Authorization: Bearer <token>`；`/health` 免鉴权。token 由服务端 `OSPS_TOKEN` 配置。

## 接口

### GET /health

```json
{ "ok": true, "docs": 123, "blobs": 456, "blobBytes": 78901234, "uptime": "1h2m" }
```

### PUT /api/v1/blob/{hash}

原始二进制 body（`application/octet-stream`）。服务端流式接收、边收边算 SHA-256，与路径 hash 不符返回 400；超过 `maxBlobSize` 返回 413；超过配额返回 507。已存在则直接返回（内容寻址天然幂等去重）：

```json
{ "ok": true, "existed": false, "size": 1024 }
```

### GET /api/v1/blob/{hash}

`http.ServeContent` 语义：支持 `Range`/`If-Range`（断点续传分片下载）、`ETag`（值为 hash）、`HEAD`。客户端对大文件按 8MB 分片拉取，最终整体校验 SHA-256。

### POST /api/v1/blobs/exists

`{ "hashes": ["<64hex>", ...] }`（≤1000）→ `{ "missing": ["..."] }`。客户端上传前批量查重。

### POST /api/v1/meta/push

```json
{
  "clientId": "obsidian-<设备>",
  "batchId": "<uuid>",              // 幂等键：同 batchId 重试不重复应用
  "ops": [                           // ≤500 条，按序应用
    { "path": "notes/a.md", "hash": "<64hex>", "size": 1024, "mtime": 1764200000000, "deleted": false },
    { "path": "notes/b.md", "hash": "", "size": 0, "mtime": 0, "deleted": true }
  ]
}
```

- path 校验：NFC 规范化、正斜杠、禁 `..`/绝对路径/控制字符/反斜杠，单段 ≤255 字节、全长 ≤1024 字节。
- 大小写/Unicode 归一化冲突：与已有 doc 仅大小写或 NFC 变体不同的 path 被拒，在 `conflicts` 数组中返回（HTTP 仍 200）。
- **引用完整性**：非删除 op 的 blob 必须已存在，否则整批 412 + `missing` 列表；客户端补传后**用同一 batchId 重试**。
- 去重：op 与 doc 现状一致（同 hash 且同删除态）直接跳过，不写变更流（防止客户端自写回传造成空转）。
- 响应：`{ "ok": true, "dup": false, "applied": 2, "skipped": 1, "conflicts": [], "cursor": 42 }`

### GET /api/v1/meta/pull?since=N&limit=500

变更流增量（seq > N，单批 ≤ limit，`cursor` 回落到最后返回的 seq，支持多趟追平）：

```json
{
  "cursor": 42, "minSeq": 12, "maxSeq": 42,
  "needSnapshot": false,
  "changes": [ { "seq": 40, "path": "notes/a.md", "hash": "...", "size": 1024, "mtime": ..., "deleted": false } ]
}
```

三个兜底边界（与 xirang-sync 相同）：`since < minSeq`（新设备/离线超保留期）、`since > maxSeq`（服务端历史回退）、变更流为空但 doc 有数据 → `needSnapshot: true`，客户端转分页快照。

### GET /api/v1/meta/snapshot?after=<path>&limit=500

doc 全量的 path 字典序游标分页（含墓碑），大 vault 不再一次性大 JSON：

```json
{ "cursor": 42, "done": false, "changes": [ ... ] }
```

取完（`done: true`）后以最后一页 `cursor` 续接增量。分页期间 doc 的并发变更会拿到比快照起点更高的 seq，由后续增量 pull 幂等覆盖。

### POST /api/v1/meta/lookup

`{ "paths": ["a.md", ...] }`（≤1000）→ `{ "docs": { "a.md": { seq, path, hash, size, mtime, deleted } } }`。客户端扫描发现未跟踪文件时区分"新增本地文件"与"状态库丢失"，避免误判。

## 客户端状态模型

per-path 记录（IndexedDB，随时可丢、可从快照重建）：

- **磁盘快照** `scan*`：上次扫描所见（mtime+size 短路，变了才算哈希）
- **基线** `base*`：上次同步双方一致的版本 —— 冲突判定只看基线

服务端游标 `cursor` 持久化，每批应用后原子推进。blob 下载失败进持久 pending 队列（游标照常推进），每轮同步开头恢复重试；超过 8 次进隔离区（`failed`），状态栏显式提示，路径在推送扫描中被屏蔽直到解决。

## 冲突处理

判定：磁盘 hash ≠ 基线 且 远端 hash ≠ 基线（双方都改了）。

处理（到达序：远端版本已在服务端，视为胜者）：

1. 本地版本完整复制到 `.conflicts/<原目录>/<名> (conflict <时间戳>).<扩展名>`（随 vault 正常同步，所有设备可见，内容绝不丢）
2. 应用远端版本，基线推进

单方修改自动跟随；"本地改 vs 远端删"保留本地并复活推回。所有被覆盖版本在服务端 changelog 保留期内（默认 30 天）可追溯。

## 数据保留与 GC

- changelog 保留 30 天（`OSPS_LOG_RETENTION_DAYS`）；batch 幂等记录 7 天
- blob GC：不被 doc 引用 且 不被保留期内 changelog 引用 且 文件年龄 > 30 天才删除（覆盖墓碑复用同 hash、落后设备补下载、快照重建三类竞态）
- 服务端每小时清理一次；`/health` 暴露 blobs 数量与字节数供巡检
