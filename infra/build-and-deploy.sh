#!/bin/sh
# 在生产服务器上从已验证的 commit 源码与 CI 编译的 Admin 产物构建镜像，然后调用
# deploy.sh 完成备份、迁移、容器切换、健康检查和失败回滚。
set -eu

DEPLOY_DIR=${BAGCOLLECT_DEPLOY_DIR:-/www/wwwroot/bagcollect}
RELEASE_DIR=${BAGCOLLECT_RELEASE_DIR:?set BAGCOLLECT_RELEASE_DIR}
IMAGE_TAG=${BAGCOLLECT_IMAGE_TAG:?set BAGCOLLECT_IMAGE_TAG}

# 只允许在固定 releases 子目录里构建，避免变量填错后把任意目录当成构建上下文。
case "$RELEASE_DIR" in
  "$DEPLOY_DIR"/releases/*) ;;
  *)
    echo "构建中止：RELEASE_DIR 不在 $DEPLOY_DIR/releases 下：$RELEASE_DIR" >&2
    exit 1
    ;;
esac

[ -f "$RELEASE_DIR/infra/Dockerfile" ] || {
  echo "构建中止：找不到 $RELEASE_DIR/infra/Dockerfile" >&2
  exit 1
}
# 必须在任何镜像构建/部署之前检查产物，避免缺失或混入其他 commit 的后台。
[ -s "$RELEASE_DIR/admin-artifact/assets/index.html" ] || {
  echo "构建中止：缺少 CI 编译的 Admin 产物" >&2
  exit 1
}
[ -f "$RELEASE_DIR/admin-artifact/source-sha" ] && \
  [ "$(cat "$RELEASE_DIR/admin-artifact/source-sha")" = "$IMAGE_TAG" ] || {
  echo "构建中止：Admin 产物与部署 commit 不一致" >&2
  exit 1
}
[ -f "$DEPLOY_DIR/infra/.env.deploy" ] || {
  echo "构建中止：找不到 $DEPLOY_DIR/infra/.env.deploy" >&2
  exit 1
}
command -v docker >/dev/null 2>&1 || {
  echo "构建中止：服务器没有 docker" >&2
  exit 1
}
docker info >/dev/null 2>&1 || {
  echo "构建中止：Docker daemon 没有运行" >&2
  exit 1
}

API_IMAGE="bagcollect-api:$IMAGE_TAG"
ADMIN_IMAGE="bagcollect-admin:$IMAGE_TAG"
VISION_IMAGE="bagcollect-vision:$IMAGE_TAG"

echo "构建 API/Worker 镜像：$API_IMAGE"
DOCKER_BUILDKIT=1 docker build --progress=plain \
  --target api \
  --tag "$API_IMAGE" \
  --file "$RELEASE_DIR/infra/Dockerfile" \
  "$RELEASE_DIR"

echo "打包 CI 编译的 Admin 产物：$ADMIN_IMAGE"
DOCKER_BUILDKIT=1 docker build --progress=plain \
  --target admin \
  --tag "$ADMIN_IMAGE" \
  --file "$RELEASE_DIR/infra/Dockerfile" \
  "$RELEASE_DIR"

# Model files live in the persistent deployment directory; runtime never downloads them.
if grep -Eq '^VISION_ENABLED=1$' "$DEPLOY_DIR/infra/.env.deploy"; then
  [ -f "$DEPLOY_DIR/data/vision-models/dinov2-small.onnx" ] || { echo "缺少预先准备的 DINO 模型" >&2; exit 1; }
  [ -f "$DEPLOY_DIR/data/vision-models/manifest.json" ] || { echo "缺少模型校验清单" >&2; exit 1; }
  docker build --file "$RELEASE_DIR/apps/vision/Dockerfile" --tag "$VISION_IMAGE" "$RELEASE_DIR"
fi

# 两个镜像都构建成功后才更新稳定部署定义；构建失败不会碰当前运行环境。
mkdir -p "$DEPLOY_DIR/infra"
cp "$RELEASE_DIR/infra/docker-compose.yml" "$DEPLOY_DIR/infra/docker-compose.yml"
cp "$RELEASE_DIR/infra/deploy.sh" "$DEPLOY_DIR/infra/deploy.sh"
cp "$RELEASE_DIR/infra/.env.deploy.example" "$DEPLOY_DIR/infra/.env.deploy.example"

export API_IMAGE ADMIN_IMAGE VISION_IMAGE
export BAGCOLLECT_DEPLOY_DIR="$DEPLOY_DIR"
export SKIP_IMAGE_PULL=1

echo "镜像构建完成，开始部署本地镜像"
cd "$DEPLOY_DIR"
sh infra/deploy.sh
