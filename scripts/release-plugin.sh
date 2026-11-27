#!/usr/bin/env bash
# 发布插件新版本：改版本号 → 构建校验 → 提交 → 打 tag → 推送（触发 GitHub Actions 自动发 Release）。
#
# 用法：
#   ./scripts/release-plugin.sh 0.1.1            # 发布 0.1.1
#   ./scripts/release-plugin.sh 0.2.0 --dry-run  # 只在本地走一遍（提交+打tag），不推送
#
# 注意：tag 必须与 manifest.json 的 version 完全一致（Obsidian 市场要求），本脚本已保证。
set -euo pipefail
cd "$(dirname "$0")/.."

if [ $# -lt 1 ]; then
  echo "用法: $0 <版本号 x.y.z> [--dry-run]"
  exit 1
fi
VERSION="$1"
DRY_RUN="${2:-}"

if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "错误：版本号必须是 x.y.z 格式，如 0.1.1"
  exit 1
fi
if [ -n "$(git status --porcelain)" ]; then
  echo "错误：工作区有未提交的改动，先 commit 再发版："
  git status --short
  exit 1
fi
if git rev-parse "$VERSION" >/dev/null 2>&1; then
  echo "错误：tag $VERSION 已存在"
  exit 1
fi

# 同步更新 manifest / package / versions（versions.json 是市场要求的 minAppVersion 历史）
node -e "
const fs = require('fs');
const manifestPath = 'plugin/manifest.json';
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
manifest.version = '$VERSION';
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
const pkgPath = 'plugin/package.json';
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
pkg.version = '$VERSION';
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
const versionsPath = 'plugin/versions.json';
const versions = fs.existsSync(versionsPath) ? JSON.parse(fs.readFileSync(versionsPath, 'utf8')) : {};
versions['$VERSION'] = manifest.minAppVersion;
fs.writeFileSync(versionsPath, JSON.stringify(versions, null, 2) + '\n');
console.log('版本号已更新: $VERSION (minAppVersion ' + manifest.minAppVersion + ')');
"

# 构建校验，确保能编译过才发
npm --prefix plugin run build
echo "==> 构建通过"

git add plugin/manifest.json plugin/package.json plugin/versions.json
git commit -m "release: v$VERSION

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
git tag "$VERSION"
echo "==> 已提交并打 tag $VERSION"

if [ "$DRY_RUN" = "--dry-run" ]; then
  echo "==> dry-run 模式：未推送。如确认无误，手动执行:"
  echo "    git push origin main $VERSION"
  exit 0
fi

git push origin main "$VERSION"
echo "==> 已推送，GitHub Actions 构建中: https://github.com/qmsu/obsidian-sync-plugins/actions"
echo "    完成后 Release 页面会出现 main.js / manifest.json 附件"
