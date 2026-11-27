package main

import (
	"crypto/sha256"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"
)

func sha256Sum(b []byte) []byte { h := sha256.Sum256(b); return h[:] }

func mustPutBlob(t *testing.T, ts *httptest.Server, hash, content string) {
	t.Helper()
	req, err := http.NewRequest("PUT", ts.URL+"/api/v1/blob/"+hash, strings.NewReader(content))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Authorization", "Bearer testtoken")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("blob 上传失败 %s: %d", hash, resp.StatusCode)
	}
}

func blobPathOf(bs *BlobStore, hash string) string { return blobPath(bs.dir, hash) }

func osChtimes(path string, atime, mtime time.Time) error {
	return os.Chtimes(path, atime, mtime)
}
