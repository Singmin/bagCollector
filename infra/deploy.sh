#!/bin/sh
# BagCollect 生产部署脚本（宝塔服务器）
#
# 由 .github/workflows/deploy.yml 通过 SSH 调用，也可以在服务器上手动执行：
#   cd /www/wwwroot/bagcollect && sh infra/deploy.sh
#
# 流程：前置检查 → 备份数据库 → 检查本地镜像或拉远程镜像 → 起基础设施
#       → 跑迁移 → 切应用容器
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
require_env ADMIN_IMAGE

if grep -qE '^(POSTGRES_PASSWORD|JWT_SECRET)=.*(replace-|your-)' "$ENV_FILE"; then
  die "$ENV_FILE 里还有没替换的占位值（replace- / your-）"
fi

# 密码会原样拼进 postgresql://user:pass@host/db，特殊字符会破坏连接串。
if ! grep -qE '^POSTGRES_PASSWORD=[A-Za-z0-9]+$' "$ENV_FILE"; then
  die "POSTGRES_PASSWORD 含非字母数字字符。连接串是按 URL 拼接的，请改用 openssl rand -hex 24 生成"
fi

# ---------------------------------------------------------------------------
# 2. 镜像仓库登录（远程镜像模式）
#   GitHub Actions 会把 TCR_USERNAME / TCR_PASSWORD 传进来；手动执行时可以自己 export。
#   TCR 个人版的镜像仓库默认私有（也可在控制台改成公开），不登录 pull 会 unauthorized。
#   仓库地址从 API_IMAGE 里取主机名，避免再维护一个变量（shell 里没导出时就从
#   .env.deploy 读，保证手动执行也能登录成功）。
# ---------------------------------------------------------------------------
registry_host=${API_IMAGE:-$(grep -m1 '^API_IMAGE=' "$ENV_FILE" | cut -d= -f2-)}
registry_host=${registry_host%%/*}
if [ "${SKIP_IMAGE_PULL:-0}" != "1" ] && [ -n "${TCR_PASSWORD:-}" ] && [ -n "${TCR_USERNAME:-}" ]; then
  echo "登录镜像仓库 $registry_host（用户：$TCR_USERNAME）"
  echo "$TCR_PASSWORD" | docker login "$registry_host" -u "$TCR_USERNAME" --password-stdin >/dev/null
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

# api 与 worker 共用同一个镜像（见 infra/Dockerfile 顶部说明），所以只需记录一条
# previous_server —— 两个容器必然是同一次构建的产物，不可能分叉。
#
# ⚠ 回滚跨不过「结构变更点」：合并前 worker 跑的是 bagcollect-worker:<SHA>，那一版
# api 镜像里没有 worker 的 dist，回滚会拿 bagcollect-api:<旧SHA> 去起 worker 然后失败
# （症状：Cannot find module '/app/apps/worker/dist/main.js'）。合并时已核实服务器上
# 没有任何 bagcollect 容器 → previous_* 为空 → 本次不会触发。将来再做同类结构变更
# 时留意这一点。
previous_server=$(current_image api)
previous_admin=$(current_image admin)
previous_scan=$(current_image scan-worker)
image_sides_upgrade=0
image_sides_migrated=0

# Scan-worker may not exist in a pre-upgrade image. Restore its own prior image,
# or stop it on the first upgrade rollback; additive migrations remain in place.
rollback() {
  exit_code=$?
  trap - EXIT
  if [ "$exit_code" -ne 0 ] && [ "$image_sides_upgrade" -eq 1 ] && [ "$image_sides_migrated" -eq 1 ]; then
    echo "双面结构迁移已完成，旧应用不能安全写入新结构；保留新 schema，停止图片应用，修复后向前发布。" >&2
    compose stop api worker scan-worker || true
    exit "$exit_code"
  fi
  if [ "$exit_code" -ne 0 ] && [ -n "$previous_server" ] && [ -n "$previous_admin" ]; then
    echo "部署失败；正在恢复上一组应用镜像。数据库迁移是单向的，不会回退。"
    API_IMAGE="$previous_server" ADMIN_IMAGE="$previous_admin" \
      compose up -d --remove-orphans api worker admin || true
    if [ -n "$previous_scan" ]; then
      API_IMAGE="$previous_scan" compose up -d --no-deps scan-worker || true
    else
      compose stop scan-worker || true
    fi
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
# 5. 拉取镜像（带重试）
#    TCR 个人版在腾讯云大陆地域**默认走内网**，不需要配 VPC / 网络 ACL，
#    正常几秒到几十秒就拉完（换 TCR 之前走 GHCR 是 35KB/s、冷拉要 40 分钟）。
#    重试保留着兜偶发抖动；注意区分两类失败：unauthorized / denied 是没登录，
#    TLS handshake timeout / i/o timeout 才是网络 —— 误判会把排查带偏。
# ---------------------------------------------------------------------------
if [ "${SKIP_IMAGE_PULL:-0}" = "1" ]; then
  echo "使用已校验的本地镜像，跳过镜像仓库拉取"
  docker image inspect "${API_IMAGE:?set API_IMAGE}" >/dev/null 2>&1 || die "本地不存在镜像 $API_IMAGE"
  docker image inspect "${ADMIN_IMAGE:?set ADMIN_IMAGE}" >/dev/null 2>&1 || die "本地不存在镜像 $ADMIN_IMAGE"
else
  PULL_LOG=/tmp/bagcollect-pull.log
  PULL_MAX_ATTEMPTS=3
  pull_attempt=1

  until compose pull > "$PULL_LOG" 2>&1; do
    cat "$PULL_LOG" >&2
    if [ "$pull_attempt" -ge "$PULL_MAX_ATTEMPTS" ]; then
      rm -f "$PULL_LOG"
      cat >&2 <<EOF
拉取镜像失败（已重试 ${PULL_MAX_ATTEMPTS} 次）。按上面的原始报错分两种情况：

  · 报 unauthorized / denied / pull access denied
      鉴权问题：服务器没登录 TCR，或仓库是私有的而没有凭据。手动登录一次：
        echo '<TCR访问凭证密码>' | docker login ${registry_host} -u '<腾讯云账号ID>' --password-stdin
      详见 docs/DEPLOY_BAOTA.md 第 4 节。

  · 报 TLS handshake timeout / net/http / i/o timeout / context deadline exceeded
      网络问题。腾讯云大陆机器访问 TCR 走内网、正常不该出现，先排查：
        getent hosts ${registry_host}          # 能否解析
        echo "${API_IMAGE:-未设置}"             # 镜像地址是否拼对
      详见 docs/DEPLOY_BAOTA.md 第 9 节排错表。
EOF
      exit 1
    fi
    echo "第 ${pull_attempt} 次拉取失败，10 秒后重试……" >&2
    pull_attempt=$((pull_attempt + 1))
    sleep 10
  done
  # 只回显末尾若干行。拉取日志里的进度行是每 200ms 一条，一次全量拉取能攒到
  # 2 万行 / 800KB 以上（首次全量拉取实测 24582 行），整份 cat 进 CI 日志既没有
  # 阅读价值，又让这一步长时间只做输出 —— 首次部署的失败点就在这里：脚本在
  # cat 与 rm 之间被掐断（拉取本身已成功，日志留了下来才得以定位）。
  tail -n 20 "$PULL_LOG"
  rm -f "$PULL_LOG"
fi

# ---------------------------------------------------------------------------
# 6. 先起基础设施，再跑迁移
#   原实现直接 `up --no-deps migrate`，但 --no-deps 不会启动 postgres/redis，
#   全新服务器上这两个容器还不存在 → 迁移连不上库。所以必须分三步。
# ---------------------------------------------------------------------------
echo "启动 postgres 与 redis 并等待健康检查通过"
compose up -d --wait postgres redis

if [ -n "$previous_server" ]; then
  has_image_sides=$(compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -At' <<'SQL'
SELECT to_regclass('"CollectibleImageSide"');
SQL
  )
  if [ -z "$has_image_sides" ]; then
    image_sides_upgrade=1
    echo "首次双面升级：暂停 API 图片写入，等待旧任务完成"
    compose stop api
    compose run -T --rm --no-deps --entrypoint node api apps/api/dist/scripts/drain-image-jobs.js
    compose stop worker scan-worker
  fi
fi

echo "执行数据库迁移"
# --exit-code-from 会连带 --abort-on-container-exit：迁移一旦非 0 退出，
# 整条命令也非 0 退出，trap 里的回滚才会被触发。
compose up --no-deps --exit-code-from migrate migrate
image_sides_migrated=1

if grep -Eq '^VISION_ENABLED=1$' "$ENV_FILE"; then
  export COMPOSE_PROFILES=vision
  compose up -d --wait vision
fi

echo "切换应用容器"
compose up -d --remove-orphans api worker scan-worker admin

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
