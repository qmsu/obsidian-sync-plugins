package main

import (
	"compress/gzip"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

type Server struct {
	store     *Store
	blobs     *BlobStore
	token     string
	startTime time.Time

	statsMu  sync.Mutex
	blobStat BlobStats
}

func (s *Server) setBlobStats(st BlobStats) {
	s.statsMu.Lock()
	s.blobStat = st
	s.statsMu.Unlock()
}

// ---- 协议类型 ----

type PushReq struct {
	ClientID string `json:"clientId"`
	BatchID  string `json:"batchId"`
	Ops      []Op   `json:"ops"`
}

type PullResp struct {
	Cursor       int64       `json:"cursor"`
	MinSeq       int64       `json:"minSeq"`
	MaxSeq       int64       `json:"maxSeq"`
	NeedSnapshot bool        `json:"needSnapshot"`
	Changes      []OutChange `json:"changes"`
}

// ---- 鉴权 ----

func (s *Server) authorized(r *http.Request) bool {
	if s.token == "" {
		return false // 未配置则禁用
	}
	h := r.Header.Get("Authorization")
	if !strings.HasPrefix(h, "Bearer ") {
		return false
	}
	got := strings.TrimSpace(strings.TrimPrefix(h, "Bearer "))
	return subtle.ConstantTimeCompare([]byte(got), []byte(s.token)) == 1
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, code int, msg string) {
	writeJSON(w, code, map[string]string{"error": msg})
}

// ---- 健康检查（无需鉴权，带巡检统计：方便核对 DB 与 blobs 目录一致性）----

func (s *Server) Health(w http.ResponseWriter, r *http.Request) {
	docs, _ := s.store.docCount()
	s.statsMu.Lock()
	stats := s.blobStat
	s.statsMu.Unlock()
	writeJSON(w, 200, map[string]any{
		"ok":        true,
		"docs":      docs,
		"blobs":     stats.Count,
		"blobBytes": stats.Bytes,
		"uptime":    time.Since(s.startTime).String(),
	})
}

// ---- POST /api/v1/meta/push ----
// 到达序 LWW：seq 即权威版本序，mtime 仅展示。blob 缺失时整批拒绝（412），
// 客户端补传后原 batchId 重试（幂等），杜绝悬空 meta 引用。
func (s *Server) Push(w http.ResponseWriter, r *http.Request) {
	if !s.authorized(r) {
		writeErr(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 5<<20)
	var req PushReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "bad json body")
		return
	}
	if req.BatchID == "" {
		writeErr(w, http.StatusBadRequest, "batchId required")
		return
	}
	if len(req.Ops) > 500 {
		writeErr(w, http.StatusBadRequest, "too many ops in one batch (max 500)")
		return
	}

	hashes := make([]string, 0, len(req.Ops))
	for i := range req.Ops {
		op := &req.Ops[i]
		norm, err := normalizePath(op.Path)
		if err != nil {
			writeErr(w, http.StatusBadRequest, fmt.Sprintf("op[%d]: %v", i, err))
			return
		}
		op.Path = norm
		if op.Deleted {
			op.Hash = ""
			op.Size = 0
		} else {
			if !validHash(op.Hash) {
				writeErr(w, http.StatusBadRequest, fmt.Sprintf("op[%d]: 非法 hash", i))
				return
			}
			if op.Size < 0 {
				writeErr(w, http.StatusBadRequest, fmt.Sprintf("op[%d]: size < 0", i))
				return
			}
			hashes = append(hashes, op.Hash)
		}
	}

	if missing := s.blobs.HasMany(hashes); len(missing) > 0 {
		writeJSON(w, http.StatusPreconditionFailed, map[string]any{
			"error":   "blob missing, upload then retry with same batchId",
			"missing": missing,
		})
		return
	}

	res, err := s.store.applyBatch(req.BatchID, req.Ops)
	if err != nil {
		log.Printf("[error] applyBatch: %v", err)
		writeErr(w, http.StatusInternalServerError, "store error")
		return
	}
	writeJSON(w, 200, map[string]any{
		"ok":        true,
		"dup":       res.Dup,
		"applied":   res.Applied,
		"skipped":   res.Skipped,
		"conflicts": res.Conflicts,
		"cursor":    res.Cursor,
	})
}

// ---- GET /api/v1/meta/pull?since=N&limit=500 ----
// 与 xirang-sync 相同的三个兜底边界：断点落在保留窗口之外（含服务端历史回退）、
// 变更流为空但 doc 有数据 → 返回 needSnapshot，客户端改走分页快照对齐。
func (s *Server) Pull(w http.ResponseWriter, r *http.Request) {
	if !s.authorized(r) {
		writeErr(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	since := int64(0)
	if v := r.URL.Query().Get("since"); v != "" {
		n, err := strconv.ParseInt(v, 10, 64)
		if err != nil || n < 0 {
			writeErr(w, http.StatusBadRequest, "since must be a non-negative integer")
			return
		}
		since = n
	}
	limit := 500
	if v := r.URL.Query().Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 && n <= 2000 {
			limit = n
		}
	}

	minSeq, maxSeq, err := s.store.logWindow()
	if err != nil {
		log.Printf("[error] logWindow: %v", err)
		writeErr(w, http.StatusInternalServerError, "store error")
		return
	}

	needSnapshot := since < minSeq || since > maxSeq
	if !needSnapshot && maxSeq == 0 {
		n, err := s.store.docCount()
		if err != nil {
			log.Printf("[error] docCount: %v", err)
			writeErr(w, http.StatusInternalServerError, "store error")
			return
		}
		needSnapshot = n > 0
	}
	if needSnapshot {
		writeJSON(w, 200, PullResp{
			Cursor: maxSeq, MinSeq: minSeq, MaxSeq: maxSeq,
			NeedSnapshot: true, Changes: []OutChange{},
		})
		return
	}

	cursor, changes, err := s.store.resume(since, limit)
	if err != nil {
		log.Printf("[error] resume: %v", err)
		writeErr(w, http.StatusInternalServerError, "store error")
		return
	}
	writeJSON(w, 200, PullResp{Cursor: cursor, MinSeq: minSeq, MaxSeq: maxSeq, Changes: changes})
}

// ---- GET /api/v1/meta/snapshot?after=<path>&limit=500 ----
// doc 全量的 path 游标分页（含墓碑）。done=true 表示取完，cursor 用最后一页的。
// 分页期间 doc 的并发变更会拿到比快照起点更高的 seq，由后续增量 pull 幂等覆盖。
func (s *Server) Snapshot(w http.ResponseWriter, r *http.Request) {
	if !s.authorized(r) {
		writeErr(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	after := r.URL.Query().Get("after")
	limit := 500
	if v := r.URL.Query().Get("limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 && n <= 2000 {
			limit = n
		}
	}
	docs, err := s.store.snapshotPage(after, limit)
	if err != nil {
		log.Printf("[error] snapshotPage: %v", err)
		writeErr(w, http.StatusInternalServerError, "store error")
		return
	}
	maxSeq, err := s.store.currentSeq()
	if err != nil {
		log.Printf("[error] currentSeq: %v", err)
		writeErr(w, http.StatusInternalServerError, "store error")
		return
	}
	writeJSON(w, 200, map[string]any{
		"cursor": maxSeq,
		"done":   len(docs) < limit,
		"changes": docs,
	})
}

// ---- POST /api/v1/meta/lookup {paths:[...]} ----
// 批量精确查询 doc 当前状态（客户端扫描发现未跟踪文件时，区分"新增本地文件"与"状态库丢失"）。
func (s *Server) Lookup(w http.ResponseWriter, r *http.Request) {
	if !s.authorized(r) {
		writeErr(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 1<<20)
	var req struct {
		Paths []string `json:"paths"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "bad json body")
		return
	}
	if len(req.Paths) > 1000 {
		writeErr(w, http.StatusBadRequest, "too many paths (max 1000)")
		return
	}
	paths := make([]string, 0, len(req.Paths))
	for _, p := range req.Paths {
		norm, err := normalizePath(p)
		if err != nil {
			writeErr(w, http.StatusBadRequest, err.Error())
			return
		}
		paths = append(paths, norm)
	}
	docs, err := s.store.lookup(paths)
	if err != nil {
		log.Printf("[error] lookup: %v", err)
		writeErr(w, http.StatusInternalServerError, "store error")
		return
	}
	writeJSON(w, 200, map[string]any{"docs": docs})
}

// ---- POST /api/v1/blobs/exists {hashes:[...]} → {missing:[...]} ----
func (s *Server) BlobsExists(w http.ResponseWriter, r *http.Request) {
	if !s.authorized(r) {
		writeErr(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 128<<10)
	var req struct {
		Hashes []string `json:"hashes"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeErr(w, http.StatusBadRequest, "bad json body")
		return
	}
	if len(req.Hashes) > 1000 {
		writeErr(w, http.StatusBadRequest, "too many hashes (max 1000)")
		return
	}
	writeJSON(w, 200, map[string]any{"missing": s.blobs.HasMany(req.Hashes)})
}

// ---- PUT /api/v1/blob/{hash} ----
// 原始二进制流式上传；服务端边收边算 SHA-256，哈希不符拒绝（400），
// 防止内容损坏静默入库。
func (s *Server) BlobPut(w http.ResponseWriter, r *http.Request) {
	if !s.authorized(r) {
		writeErr(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	hash := strings.TrimPrefix(r.URL.Path, "/api/v1/blob/")
	hash = strings.ToLower(hash)
	if !validHash(hash) {
		writeErr(w, http.StatusBadRequest, "invalid blob hash")
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, s.maxBlobBytes()+1)
	existed, size, err := s.blobs.Put(hash, r.Body)
	switch {
	case errors.Is(err, ErrBlobTooLarge):
		writeErr(w, http.StatusRequestEntityTooLarge, "blob too large")
		return
	case errors.Is(err, ErrBlobQuota):
		writeErr(w, http.StatusInsufficientStorage, "quota exceeded")
		return
	case errors.Is(err, ErrBlobHashMismatch):
		writeErr(w, http.StatusBadRequest, "content hash mismatch")
		return
	case err != nil:
		log.Printf("[error] blob put: %v", err)
		writeErr(w, http.StatusInternalServerError, "blob store error")
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true, "existed": existed, "size": size})
}

// ---- GET/HEAD /api/v1/blob/{hash} ----
// http.ServeContent 自带 Range/If-Range/ETag，客户端可分片断点续传。
func (s *Server) BlobGet(w http.ResponseWriter, r *http.Request) {
	if !s.authorized(r) {
		writeErr(w, http.StatusUnauthorized, "unauthorized")
		return
	}
	hash := strings.TrimPrefix(r.URL.Path, "/api/v1/blob/")
	hash = strings.ToLower(hash)
	f, st, err := s.blobs.Open(hash)
	if err != nil {
		writeErr(w, http.StatusNotFound, "blob not found")
		return
	}
	defer f.Close()
	w.Header().Set("ETag", `"`+hash+`"`)
	w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	w.Header().Set("Content-Type", "application/octet-stream")
	http.ServeContent(w, r, "blob", st.ModTime(), f)
}

func (s *Server) maxBlobBytes() int64 { return s.blobs.maxBlob }

// ---- 中间件：JSON 接口 gzip（pull/snapshot 的 path 列表压缩比很高）----

type gzipWriter struct {
	http.ResponseWriter
	gz *gzip.Writer
}

func (g *gzipWriter) Write(p []byte) (int, error) { return g.gz.Write(p) }

func (g *gzipWriter) Flush() {
	g.gz.Flush()
	if f, ok := g.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

func gzipJSON(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.Contains(r.Header.Get("Accept-Encoding"), "gzip") {
			next.ServeHTTP(w, r)
			return
		}
		w.Header().Set("Content-Encoding", "gzip")
		gz := gzip.NewWriter(w)
		defer func() {
			if err := gz.Close(); err != nil {
				log.Printf("[error] gzip close: %v", err)
			}
		}()
		next.ServeHTTP(&gzipWriter{ResponseWriter: w, gz: gz}, r)
	})
}
