package main

import (
	"database/sql"
	"fmt"
	"time"

	_ "modernc.org/sqlite"
)

// Store 封装 SQLite 元数据访问（doc 当前状态 + changelog 变更流 + batch 幂等）。
// 单用户低并发，MaxOpenConns=1 串行化写，WAL + busy_timeout 兜底。
type Store struct{ db *sql.DB }

func openStore(path string) (*Store, error) {
	db, err := sql.Open("sqlite", path+"?_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)&_pragma=synchronous(NORMAL)")
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	const schema = `
CREATE TABLE IF NOT EXISTS doc (
  path       TEXT PRIMARY KEY,      -- 归一化后的 vault 相对路径
  path_key   TEXT NOT NULL,         -- NFC+小写键，大小写/Unicode 变体冲突检测
  hash       TEXT NOT NULL,         -- 内容 SHA-256；墓碑时为空串
  size       INTEGER NOT NULL,
  mtime      INTEGER NOT NULL,      -- 客户端上报，仅展示用，不参与胜负判定
  deleted    INTEGER NOT NULL,      -- 0/1，1=墓碑
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_doc_pathkey ON doc(path_key);
CREATE TABLE IF NOT EXISTS changelog (
  seq     INTEGER PRIMARY KEY AUTOINCREMENT,
  path    TEXT NOT NULL,
  hash    TEXT NOT NULL,
  size    INTEGER NOT NULL,
  mtime   INTEGER NOT NULL,
  deleted INTEGER NOT NULL,
  ts      INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS batch (
  batch_id   TEXT PRIMARY KEY,
  applied_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_batch_applied ON batch(applied_at);
`
	if _, err := db.Exec(schema); err != nil {
		db.Close()
		return nil, fmt.Errorf("init schema: %w", err)
	}
	return &Store{db: db}, nil
}

func (s *Store) Close() { _ = s.db.Close() }

// Op 客户端推送的单条元数据操作。
type Op struct {
	Path    string `json:"path"`
	Hash    string `json:"hash"`
	Size    int64  `json:"size"`
	Mtime   int64  `json:"mtime"`
	Deleted bool   `json:"deleted"`
}

// OutChange 变更流/快照返回的一条记录。
type OutChange struct {
	Seq     int64  `json:"seq"`
	Path    string `json:"path"`
	Hash    string `json:"hash"`
	Size    int64  `json:"size"`
	Mtime   int64  `json:"mtime"`
	Deleted bool   `json:"deleted"`
}

// ApplyResult 一次批量落库的结果。conflicts 是大小写/Unicode 变体冲突被拒的 path 列表。
type ApplyResult struct {
	Dup       bool
	Applied   int
	Skipped   int
	Conflicts []string
	Cursor    int64
}

// applyBatch 把一批元数据按到达序落库（后到覆盖，seq 即权威版本序）。
// 内容没变的 op 直接跳过、不写 changelog（掐断客户端自写回传造成的空转）。
// batchID 已应用过则幂等返回 (Dup=true, cursor)。
func (s *Store) applyBatch(batchID string, ops []Op) (ApplyResult, error) {
	tx, err := s.db.Begin()
	if err != nil {
		return ApplyResult{}, err
	}
	defer tx.Rollback()

	var one int
	switch err := tx.QueryRow("SELECT 1 FROM batch WHERE batch_id = ?", batchID).Scan(&one); err {
	case nil:
		cursor, err := maxSeq(tx)
		return ApplyResult{Dup: true, Cursor: cursor}, err
	case sql.ErrNoRows:
		// 继续
	default:
		return ApplyResult{}, err
	}

	now := time.Now().UnixMilli()
	res := ApplyResult{}
	for _, op := range ops {
		var existingPath string
		err := tx.QueryRow("SELECT path FROM doc WHERE path_key = ?", pathKey(op.Path)).Scan(&existingPath)
		if err == nil && existingPath != op.Path {
			// 大小写/Unicode 归一化后撞了另一个已存在的 path：拒绝该 op，防止互相覆盖
			res.Conflicts = append(res.Conflicts, op.Path)
			continue
		} else if err != nil && err != sql.ErrNoRows {
			return ApplyResult{}, err
		}

		var curHash string
		var curDeleted int
		err = tx.QueryRow("SELECT hash, deleted FROM doc WHERE path = ?", op.Path).Scan(&curHash, &curDeleted)
		curIsDeleted := err == nil && curDeleted == 1
		if err == nil && curHash == op.Hash && curIsDeleted == op.Deleted {
			res.Skipped++ // 内容与现状一致，不产生变更流条目
			continue
		} else if err != nil && err != sql.ErrNoRows {
			return ApplyResult{}, err
		}

		if _, err := tx.Exec(
			`INSERT INTO doc(path, path_key, hash, size, mtime, deleted, updated_at)
			 VALUES(?,?,?,?,?,?,?)
			 ON CONFLICT(path) DO UPDATE SET hash=excluded.hash, size=excluded.size,
			   mtime=excluded.mtime, deleted=excluded.deleted, updated_at=excluded.updated_at`,
			op.Path, pathKey(op.Path), op.Hash, op.Size, op.Mtime, boolInt(op.Deleted), now,
		); err != nil {
			return ApplyResult{}, err
		}
		if _, err := tx.Exec(
			`INSERT INTO changelog(path, hash, size, mtime, deleted, ts) VALUES(?,?,?,?,?,?)`,
			op.Path, op.Hash, op.Size, op.Mtime, boolInt(op.Deleted), now,
		); err != nil {
			return ApplyResult{}, err
		}
		res.Applied++
	}
	if _, err := tx.Exec("INSERT INTO batch(batch_id, applied_at) VALUES(?,?)", batchID, now); err != nil {
		return ApplyResult{}, err
	}
	if err := tx.Commit(); err != nil {
		return ApplyResult{}, err
	}
	res.Cursor, err = s.currentSeq()
	return res, err
}

func boolInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

func maxSeq(tx *sql.Tx) (int64, error) {
	var n sql.NullInt64
	if err := tx.QueryRow("SELECT MAX(seq) FROM changelog").Scan(&n); err != nil {
		return 0, err
	}
	return n.Int64, nil
}

func (s *Store) currentSeq() (int64, error) {
	var n sql.NullInt64
	err := s.db.QueryRow("SELECT MAX(seq) FROM changelog").Scan(&n)
	if err != nil {
		return 0, err
	}
	return n.Int64, nil
}

// logWindow 返回 changelog 当前保留的 seq 区间；为空时返回 (0, 0)。
// 客户端断点落在窗口之外时无法靠增量追平，须走分页快照。
func (s *Store) logWindow() (int64, int64, error) {
	var min, max sql.NullInt64
	if err := s.db.QueryRow("SELECT MIN(seq), MAX(seq) FROM changelog").Scan(&min, &max); err != nil {
		return 0, 0, err
	}
	return min.Int64, max.Int64, nil
}

// docCount 当前 doc 行数（判断"有数据但变更流为空"用：如变更流被清空而 doc 保留）。
func (s *Store) docCount() (int64, error) {
	var n int64
	err := s.db.QueryRow("SELECT COUNT(*) FROM doc").Scan(&n)
	return n, err
}

// resume 取 seq > since 的增量（单批上限 limit；cursor 回落到最后返回的 seq，支持多趟追平）。
func (s *Store) resume(since int64, limit int) (int64, []OutChange, error) {
	rows, err := s.db.Query(
		`SELECT seq, path, hash, size, mtime, deleted FROM changelog
		 WHERE seq > ? ORDER BY seq LIMIT ?`, since, limit,
	)
	if err != nil {
		return 0, nil, err
	}
	defer rows.Close()

	// 用空切片而非 nil：nil 序列化成 JSON null，客户端遍历会炸
	out := make([]OutChange, 0, limit)
	cursor := since
	for rows.Next() {
		var oc OutChange
		var deleted int
		if err := rows.Scan(&oc.Seq, &oc.Path, &oc.Hash, &oc.Size, &oc.Mtime, &deleted); err != nil {
			return 0, nil, err
		}
		oc.Deleted = deleted == 1
		cursor = oc.Seq
		out = append(out, oc)
	}
	return cursor, out, rows.Err()
}

// snapshotPage 按 path 字典序返回 doc 全量的游标分页（path > after，含墓碑），
// 供新设备/断点落窗口外的客户端分页重建，避免大 vault 一次性大 JSON。
func (s *Store) snapshotPage(after string, limit int) ([]OutChange, error) {
	rows, err := s.db.Query(
		`SELECT 0, path, hash, size, mtime, deleted FROM doc
		 WHERE path > ? ORDER BY path LIMIT ?`,
		after, limit,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := make([]OutChange, 0, limit)
	for rows.Next() {
		var oc OutChange
		var deleted int
		if err := rows.Scan(&oc.Seq, &oc.Path, &oc.Hash, &oc.Size, &oc.Mtime, &deleted); err != nil {
			return nil, err
		}
		oc.Deleted = deleted == 1
		out = append(out, oc)
	}
	return out, rows.Err()
}

// lookup 按 path 精确查询当前状态（客户端扫描发现未跟踪文件时，判断服务端是否已有该文件）。
// 返回 map[path]，不存在的 path 不在 map 里。
func (s *Store) lookup(paths []string) (map[string]OutChange, error) {
	out := make(map[string]OutChange, len(paths))
	stmt, err := s.db.Prepare("SELECT hash, size, mtime, deleted FROM doc WHERE path = ?")
	if err != nil {
		return nil, err
	}
	defer stmt.Close()
	for _, p := range paths {
		var oc OutChange
		oc.Path = p
		var deleted int
		err := stmt.QueryRow(p).Scan(&oc.Hash, &oc.Size, &oc.Mtime, &deleted)
		if err == sql.ErrNoRows {
			continue
		} else if err != nil {
			return nil, err
		}
		oc.Deleted = deleted == 1
		out[p] = oc
	}
	return out, nil
}

// referencedHashes 收集 blob GC 引用集合：doc 全量 hash + 保留期内 changelog hash。
func (s *Store) referencedHashes(retention time.Duration) (map[string]bool, error) {
	refs := make(map[string]bool)
	rows, err := s.db.Query("SELECT DISTINCT hash FROM doc WHERE deleted = 0 AND hash != ''")
	if err != nil {
		return nil, err
	}
	if err := scanHashRows(rows, refs); err != nil {
		return nil, err
	}
	rows, err = s.db.Query(
		"SELECT DISTINCT hash FROM changelog WHERE hash != '' AND ts >= ?",
		time.Now().Add(-retention).UnixMilli(),
	)
	if err != nil {
		return nil, err
	}
	return refs, scanHashRows(rows, refs)
}

func scanHashRows(rows *sql.Rows, refs map[string]bool) error {
	defer rows.Close()
	for rows.Next() {
		var h string
		if err := rows.Scan(&h); err != nil {
			return err
		}
		if h != "" {
			refs[h] = true
		}
	}
	return rows.Err()
}

// prune 清过期的变更流与 batch 幂等记录
func (s *Store) prune(logRetention, batchRetention time.Duration) error {
	now := time.Now().UnixMilli()
	if _, err := s.db.Exec("DELETE FROM changelog WHERE ts < ?", now-logRetention.Milliseconds()); err != nil {
		return err
	}
	_, err := s.db.Exec("DELETE FROM batch WHERE applied_at < ?", now-batchRetention.Milliseconds())
	return err
}
