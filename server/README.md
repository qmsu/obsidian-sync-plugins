# obsidian-sync-plugins-server

Obsidian vault 文件同步服务端（Go 单二进制）。配套插件在仓库根目录 `plugin/`，协议见 `docs/protocol.md`。

- 单用户多设备；内容寻址 blob 存储（SHA-256 去重）+ path 元数据变更流（到达序 LWW）
- SQLite（WAL）元数据 + 文件系统 blob，断点续传 / batchId 幂等 / 分页快照兜底
- 与 xirang-sync 完全独立：不同端口（默认 8788）、独立 SQLite、独立数据目录，互不影响

## 本地开发

```bash
go test ./...
OSPS_TOKEN='devtoken' go run . -db ./dev.db -blobs ./dev-blobs -bind 127.0.0.1:8788
```

## Docker 部署（NAS 推荐）

```bash
cd server
cp .env.example .env          # 改 OSPS_TOKEN（openssl rand -hex 32）
docker compose up -d --build
```

- 数据持久化在宿主机 `server/data/`（挂载到容器 `/data`，含 SQLite 与 blobs）
- 镜像以 root 运行以兼容任意宿主目录属主（低权限运行需自加 USER 并 chown，否则 SQLite 报 unable to open database file）
- 环境变量（可写进 .env 或 docker-compose.yml）：

| 变量 | 默认 | 说明 |
|---|---|---|
| `OSPS_TOKEN` | 无（必填） | 鉴权 token，客户端设置里填同一个 |
| `OSPS_BIND` | `0.0.0.0:8788` | 监听地址 |
| `OSPS_DB` | `/data/obsidian-sync.db` | SQLite 路径 |
| `OSPS_BLOBS` | `/data/blobs` | blob 目录 |
| `OSPS_MAX_BLOB_MB` | 512 | 单文件上传上限 |
| `OSPS_QUOTA_GB` | 50 | blob 总量配额，0=不限 |
| `OSPS_LOG_RETENTION_DAYS` | 30 | 变更流保留天数（也是 blob GC 宽限期） |
| `OSPS_BATCH_RETENTION_DAYS` | 7 | batch 幂等记录保留天数 |

## 反向代理配置（重要）

服务本体不导 HTTPS。公网/内网穿透部署挂 Nginx（或 frp + Nginx）做 TLS 终止。**Nginx 默认 1MB body 上限会先于服务端限制咬人**（大 blob 上传被切断→客户端重试→再切断），必须放宽：

```nginx
server {
  listen 443 ssl;
  server_name sync.example.com;
  ssl_certificate     /etc/letsencrypt/live/sync.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/sync.example.com/privkey.pem;

  client_max_body_size 1g;          # ≥ OSPS_MAX_BLOB_MB
  proxy_read_timeout  300s;         # 慢链路大文件
  proxy_send_timeout  300s;
  proxy_request_buffering off;      # 大 blob 流式转发，不落盘

  location / {
    proxy_pass http://127.0.0.1:8788;
    proxy_set_header Host $host;
  }
}
```

证书必须是 Let's Encrypt 等真证书——**自签名证书 requestUrl 不接受**。纯局域网 HTTP 直连（`http://192.168.x.x:8788`）也可以用，桌面与手机 App 均允许。

## 巡检

```bash
curl -s http://127.0.0.1:8788/health          # 无需鉴权：docs/blobs/blobBytes
sqlite3 data/obsidian-sync.db "VACUUM INTO 'backup.db'"   # 备份（含 blobs 目录一起备）
```

## 目录结构

- `main.go` 启动与后台维护循环
- `handlers.go` HTTP 接口（鉴权/推送/拉取/快照/blob）
- `store.go` SQLite：doc（当前状态）/ changelog（变更流）/ batch（幂等）
- `blobs.go` 内容寻址存储与 GC
- `path.go` 路径校验与归一化
