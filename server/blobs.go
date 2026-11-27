package main

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// blob 存储错误：handlers 据此映射 HTTP 状态码
var (
	ErrBlobTooLarge     = errors.New("blob 超过单文件上限")
	ErrBlobHashMismatch = errors.New("blob 内容哈希与路径不符")
	ErrBlobQuota        = errors.New("超过 blob 总量配额")
	ErrBlobInvalidHash  = errors.New("非法 blob 哈希")
)

// BlobStats blob 总量统计。
type BlobStats struct {
	Count int
	Bytes int64
}

// BlobStore 内容寻址存储：blobs/<前2位>/<64位hex>。
// 内容不可变，Put 幂等；写入先落临时文件、边写边算 SHA-256、校验通过才 rename 落位。
type BlobStore struct {
	dir        string
	maxBlob    int64
	quota      int64 // 总量配额，0=不限
	mu         sync.Mutex
	totalBytes int64 // 缓存的 blob 总字节（Init/GC 时刷新）
}

func NewBlobStore(dir string, maxBlob, quota int64) *BlobStore {
	return &BlobStore{dir: dir, maxBlob: maxBlob, quota: quota}
}

// Init 建目录并遍历统计既有 blob 总量。
func (b *BlobStore) Init() (BlobStats, error) {
	if err := os.MkdirAll(filepath.Join(b.dir, "tmp"), 0o755); err != nil {
		return BlobStats{}, err
	}
	stats, err := b.walk()
	if err != nil {
		return BlobStats{}, err
	}
	b.mu.Lock()
	b.totalBytes = stats.Bytes
	b.mu.Unlock()
	return stats, nil
}

func blobPath(bdir, hash string) string { return filepath.Join(bdir, hash[:2], hash) }

// Put 写入一个 blob。已存在则丢弃 body 直接返回（内容寻址，天然幂等去重）。
// 流式写入 + 边写边校验哈希 + 大小/配额限制，绝不落半截内容到正式路径。
func (b *BlobStore) Put(hash string, r io.Reader) (existed bool, size int64, err error) {
	if !validHash(hash) {
		return false, 0, ErrBlobInvalidHash
	}
	final := blobPath(b.dir, hash)
	if st, err := os.Stat(final); err == nil && !st.IsDir() {
		// 已存在：内容寻址不可变，直接排空 body
		_, _ = io.Copy(io.Discard, r)
		return true, st.Size(), nil
	}

	if b.quota > 0 {
		b.mu.Lock()
		total := b.totalBytes
		b.mu.Unlock()
		if total >= b.quota {
			return false, 0, ErrBlobQuota
		}
	}

	tmpPath := filepath.Join(b.dir, "tmp", fmt.Sprintf("put-%d-%s", time.Now().UnixNano(), hash[:8]))
	f, err := os.OpenFile(tmpPath, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0o644)
	if err != nil {
		return false, 0, err
	}
	defer os.Remove(tmpPath) // 成功 rename 后 Remove 是无害的 no-op

	h := sha256.New()
	n, copyErr := io.Copy(f, io.TeeReader(io.LimitReader(r, b.maxBlob+1), h))
	closeErr := f.Close()
	if copyErr != nil {
		return false, 0, copyErr
	}
	if closeErr != nil {
		return false, 0, closeErr
	}
	if n > b.maxBlob {
		return false, 0, ErrBlobTooLarge
	}
	if hex.EncodeToString(h.Sum(nil)) != hash {
		return false, 0, ErrBlobHashMismatch
	}

	if err := os.MkdirAll(filepath.Dir(final), 0o755); err != nil {
		return false, 0, err
	}
	if err := os.Rename(tmpPath, final); err != nil {
		return false, 0, err
	}
	b.mu.Lock()
	b.totalBytes += n
	b.mu.Unlock()
	return false, n, nil
}

// Has 判断 blob 是否存在。
func (b *BlobStore) Has(hash string) bool {
	if !validHash(hash) {
		return false
	}
	st, err := os.Stat(blobPath(b.dir, hash))
	return err == nil && !st.IsDir()
}

// HasMany 批量判断，返回缺失的 hash 列表（保序去重）。
func (b *BlobStore) HasMany(hashes []string) []string {
	seen := make(map[string]bool, len(hashes))
	var missing []string
	for _, h := range hashes {
		if seen[h] {
			continue
		}
		seen[h] = true
		if !b.Has(h) {
			missing = append(missing, h)
		}
	}
	return missing
}

// Open 打开 blob 供下载（http.ServeContent 自带 Range/If-Range 断点支持）；调用方负责 Close。
func (b *BlobStore) Open(hash string) (*os.File, os.FileInfo, error) {
	if !validHash(hash) {
		return nil, nil, ErrBlobInvalidHash
	}
	f, err := os.Open(blobPath(b.dir, hash))
	if err != nil {
		return nil, nil, err
	}
	st, err := f.Stat()
	if err != nil {
		f.Close()
		return nil, nil, err
	}
	return f, st, nil
}

// GC 回收 blob：删除「不被引用集合 refs 覆盖、且文件年龄超过宽限期」的 blob。
// refs 由调用方（Server）从 doc 全量 + 保留期内 changelog 收集——宽限期 = 变更流保留期，
// 覆盖墓碑后新建同名文件复用同一 hash、断点落后的设备补下载、快照兜底重建三类竞态。
// 同时清理超过 1 天的临时文件，并刷新总量统计。
func (b *BlobStore) GC(refs map[string]bool, grace time.Duration) (freed int, stats BlobStats, err error) {
	cutoff := time.Now().Add(-grace)
	// 顺带清理临时目录里的陈旧文件
	if entries, err := os.ReadDir(filepath.Join(b.dir, "tmp")); err == nil {
		for _, e := range entries {
			if info, err := e.Info(); err == nil && info.ModTime().Before(time.Now().Add(-24*time.Hour)) {
				_ = os.Remove(filepath.Join(b.dir, "tmp", e.Name()))
			}
		}
	}

	walkErr := filepath.WalkDir(b.dir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			return nil
		}
		rel, err := filepath.Rel(b.dir, path)
		if err != nil {
			return nil
		}
		if strings.HasPrefix(rel, "tmp"+string(filepath.Separator)) {
			return nil
		}
		hash, ok := relToHash(rel)
		info, err := d.Info()
		if err != nil || !ok {
			return nil // 非法布局文件不统计不删除，留给人巡检
		}
		if info.ModTime().Before(cutoff) && !refs[hash] {
			if rmErr := os.Remove(path); rmErr == nil {
				freed++
				return nil
			}
		}
		stats.Count++
		stats.Bytes += info.Size()
		return nil
	})

	b.mu.Lock()
	b.totalBytes = stats.Bytes
	b.mu.Unlock()
	return freed, stats, walkErr
}

func (b *BlobStore) Stats() BlobStats {
	b.mu.Lock()
	defer b.mu.Unlock()
	return BlobStats{Count: 0, Bytes: b.totalBytes}
}

// relToHash 把相对路径（如 "ab/<64hex>"）解析为 blob 哈希。
// 布局必须是「2 位十六进制子目录 / 64 位十六进制文件名」。
func relToHash(rel string) (string, bool) {
	parts := strings.Split(rel, string(filepath.Separator))
	if len(parts) != 2 || len(parts[0]) != 2 || !validHash(parts[1]) || parts[0] != parts[1][:2] {
		return "", false
	}
	return parts[1], true
}

// walk 遍历 blob 目录统计总量（tmp/ 除外）。
func (b *BlobStore) walk() (BlobStats, error) {
	var stats BlobStats
	err := filepath.WalkDir(b.dir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			return nil
		}
		rel, err := filepath.Rel(b.dir, path)
		if err != nil {
			return nil
		}
		if strings.HasPrefix(rel, "tmp"+string(filepath.Separator)) {
			return nil
		}
		if _, ok := relToHash(rel); !ok {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return nil
		}
		stats.Count++
		stats.Bytes += info.Size()
		return nil
	})
	return stats, err
}
