#!/bin/sh
# Production only imports CI images; never build or install dependencies here.
set -eu
DEPLOY_DIR=${BAGCOLLECT_DEPLOY_DIR:-/www/wwwroot/bagcollect}
RELEASE_DIR=${BAGCOLLECT_RELEASE_DIR:?set BAGCOLLECT_RELEASE_DIR}
IMAGE_TAG=${BAGCOLLECT_IMAGE_TAG:?set BAGCOLLECT_IMAGE_TAG}
printf '%s\n' "$IMAGE_TAG" | grep -Eq '^[0-9a-f]{40}$' || { echo "部署标签必须是完整 commit SHA" >&2; exit 1; }
# Resolve paths before checking containment, including symlinks and .. segments.
DEPLOY_DIR=$(cd "$DEPLOY_DIR" && pwd -P)
RELEASE_DIR=$(cd "$RELEASE_DIR" && pwd -P)
case "$RELEASE_DIR" in
  "$DEPLOY_DIR"/releases/*) ;;
  *) echo "发布目录不在 releases 下" >&2; exit 1 ;;
esac
[ -f "$DEPLOY_DIR/infra/.env.deploy" ] || { echo "缺少服务器 .env.deploy" >&2; exit 1; }
command -v flock >/dev/null 2>&1 || { echo "缺少 flock，拒绝并发部署" >&2; exit 1; }
command -v bash >/dev/null 2>&1 || { echo "缺少 bash" >&2; exit 1; }
exec 9>"$DEPLOY_DIR/.deploy.lock"
flock -n 9 || { echo "已有服务器部署任务，拒绝重复启动" >&2; exit 1; }
docker info >/dev/null
case "$(uname -m)" in
  x86_64) architecture=amd64 ;;
  aarch64|arm64) architecture=arm64 ;;
  *) echo "不支持的服务器架构" >&2; exit 1 ;;
esac
API_IMAGE="bagcollect-api:$IMAGE_TAG"
ADMIN_IMAGE="bagcollect-admin:$IMAGE_TAG"
VISION_IMAGE="bagcollect-vision:$IMAGE_TAG"
validate_bundle() {
  bundle=$1
  (cd "$bundle" && sha256sum -c SHA256SUMS)
  [ "$(cat "$bundle/source-sha")" = "$IMAGE_TAG" ] || { echo "镜像产物与部署 SHA 不一致" >&2; exit 1; }
  [ "$(cat "$bundle/architecture")" = "$architecture" ] || { echo "镜像架构与服务器不一致" >&2; exit 1; }
}
validate_bundle "$RELEASE_DIR/production-images"
grep -Eq "^sha256:[0-9a-f]{64} $API_IMAGE$" "$RELEASE_DIR/production-images/images.fingerprints"
grep -Eq "^sha256:[0-9a-f]{64} $ADMIN_IMAGE$" "$RELEASE_DIR/production-images/images.fingerprints"
vision_enabled=0
if grep -Eq '^VISION_ENABLED=1$' "$DEPLOY_DIR/infra/.env.deploy"; then
  vision_enabled=1
  [ -f "$DEPLOY_DIR/data/vision-models/dinov2-small.onnx" ] || { echo "缺少预先准备的 DINO 模型" >&2; exit 1; }
  [ -f "$DEPLOY_DIR/data/vision-models/manifest.json" ] || { echo "缺少模型校验清单" >&2; exit 1; }
  validate_bundle "$RELEASE_DIR/vision-images"
  grep -Eq "^sha256:[0-9a-f]{64} $VISION_IMAGE$" "$RELEASE_DIR/vision-images/images.fingerprints"
fi
echo "导入前服务器资源："
free -m || true
docker_root=$(docker info --format '{{.DockerRootDir}}')
docker info --format 'Docker={{.ServerVersion}} storage={{.Driver}}'
# Reserve space for unpacked layers; retain existing images for rollback.
bundle_kb=$(du -sk "$RELEASE_DIR/production-images" | cut -f1)
if [ "$vision_enabled" -eq 1 ]; then
  bundle_kb=$((bundle_kb + $(du -sk "$RELEASE_DIR/vision-images" | cut -f1)))
fi
required_kb=$((bundle_kb * 5 + 1048576))
available_kb=$(df -Pk "$docker_root" | awk 'END {print $4}')
[ "$available_kb" -ge "$required_kb" ] || { echo "Docker 磁盘空间不足，导入中止" >&2; exit 1; }
load_bundle() {
  bundle=$1
  started=$(date +%s)
  cached=1
  while read -r expected image; do
    actual=$(sh "$RELEASE_DIR/infra/image-fingerprint.sh" "$image" 2>/dev/null || true)
    [ "$actual" = "$expected" ] || cached=0
  done < "$bundle/images.fingerprints"
  if [ "$cached" -eq 0 ]; then
    echo "低优先级导入 CI 镜像：$bundle"
    # Decompress outside the Docker daemon so nice actually covers gzip CPU work.
    if command -v ionice >/dev/null 2>&1; then
      bash -o pipefail -c 'ionice -c 2 -n 7 nice -n 19 gzip -dc "$1" | docker image load' bash "$bundle/images.tar.gz"
    else
      bash -o pipefail -c 'nice -n 19 gzip -dc "$1" | docker image load' bash "$bundle/images.tar.gz"
    fi
  fi
  while read -r expected image; do
    actual=$(sh "$RELEASE_DIR/infra/image-fingerprint.sh" "$image")
    ci_id=$(awk -v image="$image" '$2 == image {print $1}' "$bundle/images.ids")
    server_id=$(docker image inspect --format '{{.Id}}' "$image")
    echo "$image CI ID=$ci_id server ID=$server_id content=$actual"
    [ "$actual" = "$expected" ] || {
      echo "导入镜像层/运行配置与 CI 不一致：$image expected=$expected actual=$actual" >&2; exit 1;
    }
  done < "$bundle/images.fingerprints"
  echo "镜像校验/导入耗时：$(($(date +%s) - started)) 秒"
}
load_bundle "$RELEASE_DIR/production-images"
[ "$vision_enabled" -eq 0 ] || load_bundle "$RELEASE_DIR/vision-images"
# Only validated images may reach the existing backup/migration/rollback flow.
cp "$RELEASE_DIR/infra/docker-compose.yml" "$DEPLOY_DIR/infra/docker-compose.yml"
cp "$RELEASE_DIR/infra/deploy.sh" "$DEPLOY_DIR/infra/deploy.sh"
cp "$RELEASE_DIR/infra/.env.deploy.example" "$DEPLOY_DIR/infra/.env.deploy.example"
export API_IMAGE ADMIN_IMAGE VISION_IMAGE
export BAGCOLLECT_DEPLOY_DIR="$DEPLOY_DIR" SKIP_IMAGE_PULL=1
echo "CI 镜像已校验并导入，开始部署"
cd "$DEPLOY_DIR"
sh infra/deploy.sh
