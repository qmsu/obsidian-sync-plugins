package main

import (
	"encoding/hex"
	"fmt"
	"strings"
	"unicode"
	"unicode/utf8"

	"golang.org/x/text/unicode/norm"
)

const (
	maxPathBytes    = 1024 // 整条路径上限（字节）
	maxSegmentBytes = 255  // 单段文件名上限（字节，兼容 Android 本地写回）
)

// normalizePath 校验并规范化客户端上报的 vault 相对路径：
// 统一 NFC（跨 macOS NFD / Linux Windows NFC，防止同一文件在服务端裂成两条 doc）、
// 正斜杠分隔；拒绝绝对路径、..、空段、控制字符、反斜杠与超长路径。
func normalizePath(p string) (string, error) {
	if p == "" {
		return "", fmt.Errorf("path 为空")
	}
	if strings.HasPrefix(p, "/") {
		return "", fmt.Errorf("path 不能以 / 开头: %q", p)
	}
	if strings.Contains(p, "\\") {
		return "", fmt.Errorf("path 不能包含反斜杠: %q", p)
	}
	if int64(len(p)) > maxPathBytes {
		return "", fmt.Errorf("path 超长（>%d 字节）", maxPathBytes)
	}
	for _, r := range p {
		if r < 0x20 || r == 0x7f {
			return "", fmt.Errorf("path 含控制字符: %q", p)
		}
		if r == unicode.ReplacementChar && !utf8.ValidString(p) {
			return "", fmt.Errorf("path 不是合法 UTF-8: %q", p)
		}
	}
	for _, seg := range strings.Split(p, "/") {
		if seg == "" {
			return "", fmt.Errorf("path 含空段（连续斜杠）: %q", p)
		}
		if seg == "." || seg == ".." {
			return "", fmt.Errorf("path 含 . 或 ..: %q", p)
		}
		if len(seg) > maxSegmentBytes {
			return "", fmt.Errorf("文件名超长（>%d 字节）: %q", maxSegmentBytes, seg)
		}
	}
	return norm.NFC.String(p), nil
}

// pathKey 归一化键（NFC + 小写）：用于大小写/Unicode 变体冲突检测，
// 避免 `a.md` 与 `A.MD`、`笔记.md`（NFD）与 `笔记.md`（NFC）在服务端互相覆盖。
func pathKey(p string) string { return strings.ToLower(p) }

// validHash 校验 SHA-256 hex（64 位十六进制，统一小写）。
func validHash(h string) bool {
	if len(h) != 64 {
		return false
	}
	_, err := hex.DecodeString(h)
	return err == nil
}
