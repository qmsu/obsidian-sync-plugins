#!/usr/bin/env bash
# 打包 obsidian-sync-plugins-server Docker 镜像，可选一键部署到远程 NAS。
#
# 用法：
#   ./scripts/build-image.sh                          # 本机架构构建 + 导出 tar.gz
#   ./scripts/build-image.sh --platform=linux/amd64   # 跨架构构建（NAS 多为 amd64，需 buildx/qemu）
#   ./scripts/build-image.sh --deploy zg@192.168.1.10 --remote-dir /opt/obsidian-sync
#       # 打包后通过 scp/ssh 传到 NAS：docker load + 写 .env(若无) + docker compose up -d
#
# 产物：release/image/obsidian-sync-server-<版本>-<架构>.tar.gz
# 目标机器（离线导入）：gunzip -c <tar.gz> | docker load
set -euo pipefail

cd "$(dirname "$0")/.."

PLATFORM="native"
DEPLOY_TARGET=""
REMOTE_DIR=""
IMAGE_NAME="obsidian-sync-plugins-server"

for arg in "$@"; do
  case "$arg" in
    --platform=*) PLATFORM="${arg#*=}" ;;
    --deploy=*) DEPLOY_TARGET="${arg#*=}" ;;
    --remote-dir=*) REMOTE_DIR="${arg#*=}" ;;
    *) echo "未知参数: $arg"; exit 1 ;;
  esac
done

# 版本号：优先 git tag，否则用日期
VERSION=$(git describe --tags --abbrev=0 2>/dev/null || true)
[ -z "$VERSION" ] && VERSION="$(date +%Y%m%d)"

# 目标架构标识（进文件名）
case "$PLATFORM" in
  linux/amd64) ARCH="amd64" ;;
  linux/arm64) ARCH="arm64" ;;
  native) ARCH="$(docker version -f '{{.Server.Arch}}' 2>/dev/null || uname -m)" ;;
  *) ARCH="custom" ;;
esac

OUT_DIR="release/image"
mkdir -p "$OUT_DIR"
TAR="$OUT_DIR/${IMAGE_NAME}-${VERSION}-${ARCH}.tar.gz"

BUILD_ARGS=()
if [ "$PLATFORM" != "native" ]; then
  BUILD_ARGS+=(--platform "$PLATFORM")
fi

echo "==> 构建镜像 ${IMAGE_NAME}:${VERSION}（架构：${ARCH}）"
docker build "${BUILD_ARGS[@]}" -t "${IMAGE_NAME}:${VERSION}" -t "${IMAGE_NAME}:latest" .

echo "==> 导出镜像"
docker save "${IMAGE_NAME}:${VERSION}" | gzip > "$TAR"
ls -lh "$TAR"

if [ -n "$DEPLOY_TARGET" ]; then
  if [ -z "$REMOTE_DIR" ]; then
    echo "错误：--deploy 需要 --remote-dir（NAS 上的部署目录，含 docker-compose.yml）"
    exit 1
  fi
  HOST="${DEPLOY_TARGET%%:*}"
  PORT="${DEPLOY_TARGET#*:}"
  SSH_PORT_OPT=()
  if [ "$PORT" != "$HOST" ]; then
    SSH_PORT_OPT=(-p "$PORT")
  fi

  echo "==> 传输镜像到 ${HOST}"
  scp "${SSH_PORT_OPT[@]}" "$TAR" "${DEPLOY_TARGET}:/tmp/"

  echo "==> 远程导入并启动"
  ssh "${SSH_PORT_OPT[@]}" "$HOST" "
    set -e
    gunzip -c /tmp/$(basename "$TAR") | docker load
    rm -f /tmp/$(basename "$TAR")
    mkdir -p '$REMOTE_DIR'
    cd '$REMOTE_DIR'
    [ -f docker-compose.yml ] || echo '警告: $REMOTE_DIR 下没有 docker-compose.yml，请确认部署目录'
    if [ ! -f .env ]; then
      echo '提示：远端没有 .env，已生成模板 —— 记得改 OSPS_TOKEN！'
      printf 'OSPS_TOKEN=change-me-openssl-rand-hex-32\n' > .env
    fi
    docker compose up -d
    docker compose ps
  "

  echo "==> 部署完成。健康检查："
  echo "    ssh ${SSH_PORT_OPT[@]} ${HOST} 'curl -s http://127.0.0.1:8788/health'"
else
  echo "==> 完成。目标机器导入方式："
  echo "    gunzip -c $TAR | docker load"
  echo "    然后在部署目录（含 docker-compose.yml 与 .env）执行：docker compose up -d"
fi
