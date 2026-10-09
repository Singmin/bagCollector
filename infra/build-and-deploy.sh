#!/bin/sh
# 在生产服务器上从 GitHub Actions 传来的、已验证的 commit 源码构建镜像，然后调用
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

# 版本号（git commit SHA）与构建时间注入前端静态资源，后台右上角据此核对线上版本。
BUILD_VERSION="$IMAGE_TAG"
BUILD_TIME=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
BUILD_ARGS="--build-arg BUILD_VERSION=$BUILD_VERSION --build-arg BUILD_TIME=$BUILD_TIME"

echo "构建 API/Worker 镜像：$API_IMAGE"
DOCKER_BUILDKIT=1 docker build --progress=plain \
  $BUILD_ARGS \
  --target api \
  --tag "$API_IMAGE" \
  --file "$RELEASE_DIR/infra/Dockerfile" \
  "$RELEASE_DIR"

echo "构建 Admin 镜像：$ADMIN_IMAGE"
DOCKER_BUILDKIT=1 docker build --progress=plain \
  $BUILD_ARGS \
  --target admin \
  --tag "$ADMIN_IMAGE" \
  --file "$RELEASE_DIR/infra/Dockerfile" \
  "$RELEASE_DIR"

# 两个镜像都构建成功后才更新稳定部署定义；构建失败不会碰当前运行环境。
mkdir -p "$DEPLOY_DIR/infra"
cp "$RELEASE_DIR/infra/docker-compose.yml" "$DEPLOY_DIR/infra/docker-compose.yml"
cp "$RELEASE_DIR/infra/deploy.sh" "$DEPLOY_DIR/infra/deploy.sh"
cp "$RELEASE_DIR/infra/.env.deploy.example" "$DEPLOY_DIR/infra/.env.deploy.example"

export API_IMAGE ADMIN_IMAGE
export BAGCOLLECT_DEPLOY_DIR="$DEPLOY_DIR"
export SKIP_IMAGE_PULL=1

echo "镜像构建完成，开始部署本地镜像"
cd "$DEPLOY_DIR"
sh infra/deploy.sh
