// obsidian-sync-plugins-server：Obsidian vault 文件同步服务端。
// 单用户多设备：内容寻址 blob 存储 + path 元数据变更流（到达序 LWW）+
// batchId 幂等 + 分页快照兜底 + Bearer token。
// 与 xirang-sync 相互独立：独立端口、独立 SQLite、独立 blob 目录，互不影响。
//
// 命令：OSPS_TOKEN=xxx ./obsidian-sync-plugins-server -db ./obsidian-sync.db -blobs ./blobs -bind 0.0.0.0:8788
package main

import (
	"flag"
	"log"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"
)

func main() {
	dbPath := flag.String("db", envOr("OSPS_DB", "./obsidian-sync.db"), "SQLite 元数据文件路径")
	blobDir := flag.String("blobs", envOr("OSPS_BLOBS", "./blobs"), "blob 内容存储目录")
	bind := flag.String("bind", envOr("OSPS_BIND", "0.0.0.0:8788"), "监听地址")
	maxBlobMB := flag.Int64("max-blob-size", int64(envOrInt("OSPS_MAX_BLOB_MB", 512)), "单个 blob 上传上限（MB）")
	quotaGB := flag.Int64("quota", int64(envOrInt("OSPS_QUOTA_GB", 50)), "blob 总量配额（GB），0=不限")
	logDays := flag.Int("log-retention", envOrInt("OSPS_LOG_RETENTION_DAYS", 30), "变更流保留天数")
	batchDays := flag.Int("batch-retention", envOrInt("OSPS_BATCH_RETENTION_DAYS", 7), "batch 幂等记录保留天数")
	flag.Parse()

	token := strings.TrimSpace(os.Getenv("OSPS_TOKEN"))
	if token == "" {
		log.Println("[warning] 未设置 OSPS_TOKEN：/api 将拒绝所有请求（/health 仍可用）")
	}

	st, err := openStore(*dbPath)
	if err != nil {
		log.Fatalf("打开数据库失败: %v", err)
	}
	defer st.Close()

	bs := NewBlobStore(*blobDir, *maxBlobMB<<20, *quotaGB<<30)
	stats, err := bs.Init()
	if err != nil {
		log.Fatalf("初始化 blob 目录失败: %v", err)
	}
	log.Printf("blob 目录就绪：%d 个文件，共 %d 字节", stats.Count, stats.Bytes)

	srv := &Server{
		store:     st,
		blobs:     bs,
		token:     token,
		startTime: time.Now(),
	}
	srv.setBlobStats(stats)

	// 后台维护：变更流/幂等记录按保留期清理，blob 按引用与宽限期回收
	go func() {
		for {
			logRetention := time.Duration(*logDays) * 24 * time.Hour
			batchRetention := time.Duration(*batchDays) * 24 * time.Hour
			if err := st.prune(logRetention, batchRetention); err != nil {
				log.Printf("[error] 清理变更流失败: %v", err)
			}
			refs, err := st.referencedHashes(logRetention)
			if err != nil {
				log.Printf("[error] 收集 blob 引用失败: %v", err)
			} else {
				freed, gcStats, err := bs.GC(refs, logRetention)
				if err != nil {
					log.Printf("[error] blob GC 失败: %v", err)
				} else {
					srv.setBlobStats(gcStats)
					if freed > 0 {
						log.Printf("blob GC 回收 %d 个文件，现有 %d 个 / %d 字节", freed, gcStats.Count, gcStats.Bytes)
					}
				}
			}
			time.Sleep(1 * time.Hour)
		}
	}()

	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", srv.Health)
	mux.HandleFunc("POST /api/v1/meta/push", srv.Push)
	mux.HandleFunc("GET /api/v1/meta/pull", srv.Pull)
	mux.HandleFunc("GET /api/v1/meta/snapshot", srv.Snapshot)
	mux.HandleFunc("POST /api/v1/meta/lookup", srv.Lookup)
	mux.HandleFunc("POST /api/v1/blobs/exists", srv.BlobsExists)
	mux.HandleFunc("PUT /api/v1/blob/", srv.BlobPut)
	mux.HandleFunc("GET /api/v1/blob/", srv.BlobGet)
	mux.HandleFunc("HEAD /api/v1/blob/", srv.BlobGet)

	log.Printf("obsidian-sync-plugins-server 监听 %s（db=%s blobs=%s）", *bind, *dbPath, *blobDir)
	if err := http.ListenAndServe(*bind, logRequests(gzipJSON(mux))); err != nil {
		log.Fatalf("服务启动失败: %v", err)
	}
}

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func envOrInt(key string, def int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
		log.Printf("[warning] 环境变量 %s=%q 不是数字，使用默认值 %d", key, v, def)
	}
	return def
}

// 简单访问日志
func logRequests(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		next.ServeHTTP(w, r)
		log.Printf("%s %s %s", r.Method, r.URL.Path, time.Since(start))
	})
}
