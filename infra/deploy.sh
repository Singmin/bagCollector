#!/bin/sh
set -eu

DEPLOY_DIR=${BAGCOLLECT_DEPLOY_DIR:-/www/wwwroot/bagcollect}
BACKUP_DIR="$DEPLOY_DIR/backups"
COMPOSE_FILE="$DEPLOY_DIR/infra/docker-compose.yml"
ENV_FILE="$DEPLOY_DIR/infra/.env.deploy"

mkdir -p "$BACKUP_DIR"
cd "$DEPLOY_DIR"

previous_api=$(docker inspect --format '{{.Config.Image}}' "$(docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" ps -q api)" 2>/dev/null || true)
previous_worker=$(docker inspect --format '{{.Config.Image}}' "$(docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" ps -q worker)" 2>/dev/null || true)
previous_admin=$(docker inspect --format '{{.Config.Image}}' "$(docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" ps -q admin)" 2>/dev/null || true)
previous_rembg=$(docker inspect --format '{{.Config.Image}}' "$(docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" ps -q rembg)" 2>/dev/null || true)

rollback() {
  exit_code=$?
  trap - EXIT
  if [ "$exit_code" -ne 0 ] && [ -n "$previous_api" ] && [ -n "$previous_worker" ] && [ -n "$previous_admin" ]; then
    echo "Deployment failed; restoring previous application images. Database migrations are forward-only."
    if [ -n "$previous_rembg" ]; then
      API_IMAGE="$previous_api" WORKER_IMAGE="$previous_worker" ADMIN_IMAGE="$previous_admin" REMBG_IMAGE="$previous_rembg" \
        docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" up -d --remove-orphans rembg api worker admin || true
    else
      API_IMAGE="$previous_api" WORKER_IMAGE="$previous_worker" ADMIN_IMAGE="$previous_admin" \
        docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" up -d --remove-orphans api worker admin || true
    fi
  fi
  exit "$exit_code"
}
trap rollback EXIT

if docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" ps --status running postgres --quiet | grep -q .; then
  docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" exec -T postgres \
    sh -c 'pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB"' | gzip > "$BACKUP_DIR/predeploy-$(date +%Y%m%d-%H%M%S).sql.gz"
fi

docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" pull
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" up --no-deps migrate
docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" up -d --remove-orphans rembg api worker admin

attempt=0
until curl -fsS http://127.0.0.1:${API_HOST_PORT:-3001}/api/health/ready >/dev/null; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 30 ]; then
    docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" logs --tail=120 api worker
    exit 1
  fi
  sleep 2
done

docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" ps
find "$BACKUP_DIR" -type f -name 'predeploy-*.sql.gz' -mtime +14 -delete
trap - EXIT
