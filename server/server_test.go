package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func newTestServer(t *testing.T) (*httptest.Server, *Store, *BlobStore) {
	t.Helper()
	st, err := openStore(t.TempDir() + "/test.db")
	if err != nil {
		t.Fatalf("openStore: %v", err)
	}
	t.Cleanup(func() { st.Close() })
	bs := NewBlobStore(t.TempDir(), 1<<20, 0)
	if _, err := bs.Init(); err != nil {
		t.Fatalf("blob init: %v", err)
	}
	srv := &Server{store: st, blobs: bs, token: "testtoken", startTime: time.Now()}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", srv.Health)
	mux.HandleFunc("POST /api/v1/meta/push", srv.Push)
	mux.HandleFunc("GET /api/v1/meta/pull", srv.Pull)
	mux.HandleFunc("GET /api/v1/meta/snapshot", srv.Snapshot)
	mux.HandleFunc("POST /api/v1/meta/lookup", srv.Lookup)
	mux.HandleFunc("POST /api/v1/blobs/exists", srv.BlobsExists)
	mux.HandleFunc("PUT /api/v1/blob/", srv.BlobPut)
	mux.HandleFunc("GET /api/v1/blob/", srv.BlobGet)
	ts := httptest.NewServer(mux)
	t.Cleanup(ts.Close)
	return ts, st, bs
}

func hashOf(t *testing.T, s string) string {
	t.Helper()
	return fmt.Sprintf("%x", sha256Sum([]byte(s)))
}

func doJSON(t *testing.T, ts *httptest.Server, method, path, body string) (*http.Response, map[string]any) {
	t.Helper()
	req, err := http.NewRequest(method, ts.URL+path, strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer testtoken")
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	var m map[string]any
	_ = json.Unmarshal(raw, &m)
	return resp, m
}

func mustPush(t *testing.T, ts *httptest.Server, batch string, ops string) map[string]any {
	t.Helper()
	body := fmt.Sprintf(`{"clientId":"c1","batchId":%q,"ops":[%s]}`, batch, ops)
	resp, m := doJSON(t, ts, "POST", "/api/v1/meta/push", body)
	if resp.StatusCode != 200 {
		t.Fatalf("push status=%d body=%v", resp.StatusCode, m)
	}
	if m["ok"] != true {
		t.Fatalf("push not ok: %v", m)
	}
	return m
}

func TestPathNormalize(t *testing.T) {
	ok := []string{"a.md", "a/b/c.md", "笔记/目录.md"}
	for _, p := range ok {
		if _, err := normalizePath(p); err != nil {
			t.Errorf("normalizePath(%q) 意外报错: %v", p, err)
		}
	}
	bad := []string{"/abs.md", "a/../b.md", "a//b.md", "", "a\\b.md", "a/..hidden.md"}
	for _, p := range bad {
		// "..hidden" 合法（不等于 ".."），单独校验
		if p == "a/..hidden.md" {
			if _, err := normalizePath(p); err != nil {
				t.Errorf("normalizePath(%q) 应合法: %v", p, err)
			}
			continue
		}
		if _, err := normalizePath(p); err == nil {
			t.Errorf("normalizePath(%q) 应报错", p)
		}
	}
	if _, err := normalizePath(strings.Repeat("a", 300) + ".md"); err == nil {
		t.Errorf("超长文件名应报错")
	}
	if norm, _ := normalizePath("a/b.md"); norm != "a/b.md" {
		t.Errorf("NFC 不应改变 ASCII 路径")
	}
}

func TestPushPullLWWArrivalOrder(t *testing.T) {
	ts, _, _ := newTestServer(t)
	h1 := hashOf(t, "content-one")
	h2 := hashOf(t, "content-two")
	mustPutBlob(t, ts, h1, "content-one")
	mustPutBlob(t, ts, h2, "content-two")

	// 设备 A 推 rev 概念上"更旧"的内容（mtime 更小），但后到——按到达序 A 应胜出
	mustPush(t, ts, "b1", fmt.Sprintf(`{"path":"a.md","hash":%q,"size":11,"mtime":1000,"deleted":false}`, h2))
	mustPush(t, ts, "b2", fmt.Sprintf(`{"path":"a.md","hash":%q,"size":11,"mtime":500,"deleted":false}`, h1))

	// 新库 since=0 按协议落在保留窗口外 → 快照；以快照最终状态断言 LWW
	_, m := doJSON(t, ts, "GET", "/api/v1/meta/snapshot?limit=100", "")
	changes := m["changes"].([]any)
	if len(changes) != 1 {
		t.Fatalf("期望 1 条快照记录，得 %d", len(changes))
	}
	doc := changes[0].(map[string]any)
	if doc["hash"] != h1 {
		t.Errorf("到达序 LWW 失败：最后到达者应胜出，得 %v", doc["hash"])
	}
}

func TestPushSkipsUnchanged(t *testing.T) {
	ts, st, _ := newTestServer(t)
	h := hashOf(t, "same")
	mustPutBlob(t, ts, h, "same")
	m1 := mustPush(t, ts, "b1", fmt.Sprintf(`{"path":"x.md","hash":%q,"size":4,"mtime":1,"deleted":false}`, h))
	if m1["applied"].(float64) != 1 {
		t.Fatalf("首次 push 应 applied=1: %v", m1)
	}
	m2 := mustPush(t, ts, "b2", fmt.Sprintf(`{"path":"x.md","hash":%q,"size":4,"mtime":2,"deleted":false}`, h))
	if m2["applied"].(float64) != 0 || m2["skipped"].(float64) != 1 {
		t.Fatalf("同内容 push 应 skip 且不写变更流: %v", m2)
	}
	var n int
	if err := st.db.QueryRow("SELECT COUNT(*) FROM changelog").Scan(&n); err != nil {
		t.Fatal(err)
	}
	if n != 1 {
		t.Errorf("skip 不应产生变更流条目，changelog 应 1 条，得 %d", n)
	}
}

func TestPushBatchIdempotent(t *testing.T) {
	ts, _, _ := newTestServer(t)
	h := hashOf(t, "idem")
	mustPutBlob(t, ts, h, "idem")
	op := fmt.Sprintf(`{"path":"i.md","hash":%q,"size":4,"mtime":1,"deleted":false}`, h)
	m1 := mustPush(t, ts, "same-batch", op)
	m2 := mustPush(t, ts, "same-batch", op)
	if m2["dup"] != true || m2["applied"].(float64) != 0 {
		t.Fatalf("同 batchId 重试应幂等: %v", m2)
	}
	if m1["cursor"].(float64) != m2["cursor"].(float64) {
		t.Errorf("幂等返回的 cursor 应一致")
	}
}

func TestPushBlobMissing412(t *testing.T) {
	ts, _, _ := newTestServer(t)
	h := hashOf(t, "ghost")
	body := fmt.Sprintf(`{"clientId":"c1","batchId":"b1","ops":[{"path":"g.md","hash":%q,"size":5,"mtime":1,"deleted":false}]}`, h)
	resp, m := doJSON(t, ts, "POST", "/api/v1/meta/push", body)
	if resp.StatusCode != 412 {
		t.Fatalf("blob 缺失应 412，得 %d: %v", resp.StatusCode, m)
	}
	missing, ok := m["missing"].([]any)
	if !ok || len(missing) != 1 || missing[0] != h {
		t.Errorf("应返回缺失 hash 列表: %v", m)
	}
}

func TestPushCaseCollision(t *testing.T) {
	ts, _, _ := newTestServer(t)
	h := hashOf(t, "case")
	mustPutBlob(t, ts, h, "case")
	mustPush(t, ts, "b1", fmt.Sprintf(`{"path":"doc/Note.md","hash":%q,"size":4,"mtime":1,"deleted":false}`, h))
	m := mustPush(t, ts, "b2", fmt.Sprintf(`{"path":"doc/note.md","hash":%q,"size":4,"mtime":1,"deleted":false}`, h))
	confl, ok := m["conflicts"].([]any)
	if !ok || len(confl) != 1 || confl[0] != "doc/note.md" {
		t.Fatalf("大小写变体应报冲突: %v", m)
	}
}

func TestPullSnapshotFallbackAndPaging(t *testing.T) {
	ts, st, _ := newTestServer(t)
	// 写 3 个文件产生变更流，再清空变更流模拟"断点落窗口外"
	for i, name := range []string{"a.md", "b.md", "c.md"} {
		h := hashOf(t, name)
		mustPutBlob(t, ts, h, name)
		mustPush(t, ts, fmt.Sprintf("b%d", i), fmt.Sprintf(`{"path":%q,"hash":%q,"size":1,"mtime":1,"deleted":false}`, name, h))
	}
	if _, err := st.db.Exec("DELETE FROM changelog"); err != nil {
		t.Fatal(err)
	}

	// 增量 pull 应回 needSnapshot
	_, m := doJSON(t, ts, "GET", "/api/v1/meta/pull?since=0", "")
	if m["needSnapshot"] != true {
		t.Fatalf("变更流为空但有 doc 应 needSnapshot: %v", m)
	}

	// 分页快照：limit=2 → 两页取完
	_, p1 := doJSON(t, ts, "GET", "/api/v1/meta/snapshot?after=&limit=2", "")
	if len(p1["changes"].([]any)) != 2 || p1["done"] != false {
		t.Fatalf("第一页应 2 条且未完: %v", p1)
	}
	after := p1["changes"].([]any)[1].(map[string]any)["path"].(string)
	_, p2 := doJSON(t, ts, "GET", "/api/v1/meta/snapshot?after="+after+"&limit=2", "")
	ch2 := p2["changes"].([]any)
	if len(ch2) != 1 || p2["done"] != true {
		t.Fatalf("第二页应 1 条且 done: %v", p2)
	}
	if ch2[0].(map[string]any)["path"].(string) <= after {
		t.Errorf("分页游标应按 path 严格递增")
	}
}

func TestBlobPutVerifyAndRange(t *testing.T) {
	ts, _, _ := newTestServer(t)
	content := "hello-blob-content"
	h := hashOf(t, content)

	// 哈希不符 → 400
	resp, _ := doJSON(t, ts, "PUT", "/api/v1/blob/"+hashOf(t, "other"), content)
	if resp.StatusCode != 400 {
		t.Errorf("哈希不符应 400，得 %d", resp.StatusCode)
	}
	// 正确上传 → 200
	resp, m := doJSON(t, ts, "PUT", "/api/v1/blob/"+h, content)
	if resp.StatusCode != 200 || m["existed"] != false {
		t.Errorf("上传失败: %d %v", resp.StatusCode, m)
	}
	// 重复上传 → existed
	_, m = doJSON(t, ts, "PUT", "/api/v1/blob/"+h, content)
	if m["existed"] != true {
		t.Errorf("重复上传应 existed=true: %v", m)
	}
	// Range 下载
	req, _ := http.NewRequest("GET", ts.URL+"/api/v1/blob/"+h, nil)
	req.Header.Set("Authorization", "Bearer testtoken")
	req.Header.Set("Range", "bytes=0-4")
	r2, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := io.ReadAll(r2.Body)
	r2.Body.Close()
	if r2.StatusCode != 206 || string(raw) != "hello" {
		t.Errorf("Range 下载失败: %d %q", r2.StatusCode, raw)
	}
	// exists 批量
	_, m = doJSON(t, ts, "POST", "/api/v1/blobs/exists", fmt.Sprintf(`{"hashes":[%q,%q]}`, h, hashOf(t, "none")))
	missing := m["missing"].([]any)
	if len(missing) != 1 || missing[0] != hashOf(t, "none") {
		t.Errorf("exists 批量判断错误: %v", m)
	}
}

func TestBlobGC(t *testing.T) {
	ts, st, bs := newTestServer(t)
	keep := hashOf(t, "keep-me")
	gone := hashOf(t, "delete-me")
	mustPutBlob(t, ts, keep, "keep-me")
	mustPutBlob(t, ts, gone, "delete-me")
	mustPush(t, ts, "b1", fmt.Sprintf(`{"path":"k.md","hash":%q,"size":7,"mtime":1,"deleted":false}`, keep))
	// gone 无引用，年龄造旧后应被回收
	old := time.Now().Add(-40 * 24 * time.Hour)
	if err := osChtimes(blobPathOf(bs, gone), old, old); err != nil {
		t.Fatal(err)
	}
	if err := osChtimes(blobPathOf(bs, keep), old, old); err != nil {
		t.Fatal(err)
	}
	refs, err := st.referencedHashes(30 * 24 * time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	freed, _, err := bs.GC(refs, 30*24*time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	if freed != 1 {
		t.Fatalf("应回收 1 个 blob，得 %d", freed)
	}
	if !bs.Has(keep) || bs.Has(gone) {
		t.Errorf("被引用的应保留，无引用且过期的应删除")
	}
}

func TestAuthRequired(t *testing.T) {
	ts, _, _ := newTestServer(t)
	resp, err := http.Get(ts.URL + "/api/v1/meta/pull?since=0")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 401 {
		t.Errorf("无 token 应 401，得 %d", resp.StatusCode)
	}
}

func TestHealth(t *testing.T) {
	ts, _, _ := newTestServer(t)
	req, _ := http.NewRequest("GET", ts.URL+"/health", nil) // health 无需鉴权
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var m map[string]any
	_ = json.NewDecoder(resp.Body).Decode(&m)
	if m["ok"] != true {
		t.Errorf("health 应 ok: %v", m)
	}
}
