#!/bin/sh
# BagCollect 生产部署脚本（宝塔服务器）
#
# 由 .github/workflows/deploy.yml 通过 SSH 调用，也可以在服务器上手动执行：
#   cd /www/wwwroot/bagcollect && sh infra/deploy.sh
#
# 流程：前置检查 → 备份数据库 → 拉镜像 → 起基础设施 → 跑迁移 → 切应用容器
#       → 等健康检查 → 清理旧备份。任何一步失败都会尝试恢复上一组应用镜像。
#
# 设计约束：迁移是「向前兼容」的。镜像回滚不会反向修改数据库，
# 因此 migration 必须保证旧版本代码能在新 schema 上运行。
set -eu

DEPLOY_DIR=${BAGCOLLECT_DEPLOY_DIR:-/www/wwwroot/bagcollect}
BACKUP_DIR="$DEPLOY_DIR/backups"
COMPOSE_FILE="$DEPLOY_DIR/infra/docker-compose.yml"
ENV_FILE="$DEPLOY_DIR/infra/.env.deploy"

mkdir -p "$BACKUP_DIR"
cd "$DEPLOY_DIR"

compose() {
  docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"
}

die() {
  echo "部署中止：$1" >&2
  echo "详见 docs/DEPLOY_BAOTA.md 第 9 节排错表。" >&2
  exit 1
}

# ---------------------------------------------------------------------------
# 1. 前置检查
#   这些失败都发生在动手改任何东西之前，报错信息尽量指到具体动作上，
#   避免把「镜像没登录」这类问题误判成应用崩溃。
# ---------------------------------------------------------------------------
[ -f "$COMPOSE_FILE" ] || die "找不到 $COMPOSE_FILE，确认 DEPLOY_DIR 是 $DEPLOY_DIR"
[ -f "$ENV_FILE" ] || die "找不到 $ENV_FILE。先 cp infra/.env.deploy.example infra/.env.deploy 并按手册填写"

command -v docker >/dev/null 2>&1 || die "服务器上没有 docker。在宝塔面板的软件商店里安装 Docker 管理器"
docker info >/dev/null 2>&1 || die "Docker daemon 没有运行。宝塔面板 → Docker → 启动服务"
# 必须是 compose v2 插件。宝塔若装的是老的 python 版 docker-compose，
# --env-file / --wait / --exit-code-from 都用不了。
docker compose version >/dev/null 2>&1 || die "缺少 docker compose v2 插件。执行：yum install -y docker-compose-plugin（或 apt install -y docker-compose-plugin）"

require_env() {
  key=$1
  if ! grep -qE "^${key}=.+" "$ENV_FILE"; then
    die "$ENV_FILE 里缺少必填项 ${key}"
  fi
}

require_env POSTGRES_PASSWORD
require_env JWT_SECRET
require_env API_IMAGE
require_env WORKER_IMAGE
require_env ADMIN_IMAGE

if grep -qE '^(POSTGRES_PASSWORD|JWT_SECRET)=.*(replace-|your-)' "$ENV_FILE"; then
  die "$ENV_FILE 里还有没替换的占位值（replace- / your-）"
fi

# 密码会原样拼进 postgresql://user:pass@host/db，特殊字符会破坏连接串。
if ! grep -qE '^POSTGRES_PASSWORD=[A-Za-z0-9]+$' "$ENV_FILE"; then
  die "POSTGRES_PASSWORD 含非字母数字字符。连接串是按 URL 拼接的，请改用 openssl rand -hex 24 生成"
fi

# ---------------------------------------------------------------------------
# 2. GHCR 私有镜像登录
#   GitHub Actions 会把 GHCR_TOKEN 传进来；手动执行时可以自己 export。
#   仓库公开不等于 package 公开 —— GHCR 的包默认是私有的。
# ---------------------------------------------------------------------------
if [ -n "${GHCR_TOKEN:-}" ] && [ -n "${GHCR_USER:-}" ]; then
  echo "登录 ghcr.io（用户：$GHCR_USER）"
  echo "$GHCR_TOKEN" | docker login ghcr.io -u "$GHCR_USER" --password-stdin >/dev/null
fi

# ---------------------------------------------------------------------------
# 3. 记录当前镜像，供失败回滚使用
# ---------------------------------------------------------------------------
current_image() {
  container_id=$(compose ps -q "$1" 2>/dev/null || true)
  if [ -n "$container_id" ]; then
    docker inspect --format '{{.Config.Image}}' "$container_id" 2>/dev/null || true
  fi
}

previous_api=$(current_image api)
previous_worker=$(current_image worker)
previous_admin=$(current_image admin)

# 抠图走腾讯云数据万象，部署里没有推理服务容器，因此回滚只需恢复三个应用镜像。
# 历史上存在过的 rembg 容器由下面的 --remove-orphans 清理。详见 docs/TENCENT_CI_MATTING.md。
rollback() {
  exit_code=$?
  trap - EXIT
  if [ "$exit_code" -ne 0 ] && [ -n "$previous_api" ] && [ -n "$previous_worker" ] && [ -n "$previous_admin" ]; then
    echo "部署失败；正在恢复上一组应用镜像。数据库迁移是单向的，不会回退。"
    API_IMAGE="$previous_api" WORKER_IMAGE="$previous_worker" ADMIN_IMAGE="$previous_admin" \
      compose up -d --remove-orphans api worker admin || true
  fi
  exit "$exit_code"
}
trap rollback EXIT

# ---------------------------------------------------------------------------
# 4. 备份数据库
#   先写临时文件再压缩：sh 的管道退出码取的是最后一个命令（gzip），
#   直接 `pg_dump | gzip` 会把 pg_dump 的失败吞掉，产出一个空备份还以为成功。
# ---------------------------------------------------------------------------
if compose ps --status running --quiet postgres | grep -q .; then
  backup_file="$BACKUP_DIR/predeploy-$(date +%Y%m%d-%H%M%S).sql.gz"
  tmp_dump="$BACKUP_DIR/.predeploy-$$.sql"
  echo "备份 PostgreSQL → $backup_file"
  if compose exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB"' > "$tmp_dump"; then
    gzip -c "$tmp_dump" > "$backup_file"
    echo "备份完成（$(du -h "$backup_file" | cut -f1)）"
  else
    echo "警告：pg_dump 失败，本次不生成备份文件。" >&2
  fi
  rm -f "$tmp_dump"
else
  echo "postgres 容器未运行（首次部署），跳过备份。"
fi

# ---------------------------------------------------------------------------
# 5. 拉取镜像
# ---------------------------------------------------------------------------
if ! compose pull; then
  cat >&2 <<'EOF'
拉取镜像失败。私有 GHCR 包最常见的原因是服务器尚未登录：
  echo "$GHCR_TOKEN" | docker login ghcr.io -u <你的GitHub用户名> --password-stdin
GHCR_TOKEN 需要 read:packages 权限。详见 docs/DEPLOY_BAOTA.md 第 5 节。
EOF
  exit 1
fi

# ---------------------------------------------------------------------------
# 6. 先起基础设施，再跑迁移
#   原实现直接 `up --no-deps migrate`，但 --no-deps 不会启动 postgres/redis，
#   全新服务器上这两个容器还不存在 → 迁移连不上库。所以必须分三步。
# ---------------------------------------------------------------------------
echo "启动 postgres 与 redis 并等待健康检查通过"
compose up -d --wait postgres redis

echo "执行数据库迁移"
# --exit-code-from 会连带 --abort-on-container-exit：迁移一旦非 0 退出，
# 整条命令也非 0 退出，trap 里的回滚才会被触发。
compose up --no-deps --exit-code-from migrate migrate

echo "切换应用容器"
compose up -d --remove-orphans api worker admin

# ---------------------------------------------------------------------------
# 7. 等待 API 就绪
#   直接读容器自身的 healthcheck 状态，不依赖宿主机装了 curl。
# ---------------------------------------------------------------------------
api_container=$(compose ps -q api)
[ -n "$api_container" ] || die "api 容器没有起来，检查 image 名称与 .env.deploy"

attempt=0
while :; do
  status=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$api_container" 2>/dev/null || echo unknown)
  if [ "$status" = "healthy" ]; then
    break
  fi
  if [ "$status" = "unhealthy" ]; then
    echo "API 健康检查判定为 unhealthy" >&2
    compose logs --tail=120 api worker
    exit 1
  fi
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 60 ]; then
    echo "API 在 120 秒内未就绪（当前状态：$status）" >&2
    compose logs --tail=120 api worker
    exit 1
  fi
  sleep 2
done

compose ps
echo "部署完成。API → http://127.0.0.1:${API_HOST_PORT:-3001}  Admin → http://127.0.0.1:${ADMIN_HOST_PORT:-8081}"

# ---------------------------------------------------------------------------
# 8. 清理过期备份（保留 14 天）
# ---------------------------------------------------------------------------
find "$BACKUP_DIR" -type f -name 'predeploy-*.sql.gz' -mtime +14 -delete
trap - EXIT
