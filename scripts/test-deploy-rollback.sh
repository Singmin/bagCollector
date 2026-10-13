#!/usr/bin/env bash
# Exercise the actual deploy.sh EXIT rollback without a daemon or production DB.
set -euo pipefail
repo=$(pwd)
mkdir -p .runtime
fixture=$(mktemp -d "$repo/.runtime/rollback-XXXXXXXX")
trap 'rm -rf "$fixture"' EXIT
mkdir -p "$fixture/bin" "$fixture/server/infra"
cp infra/deploy.sh "$fixture/server/infra/deploy.sh"
touch "$fixture/server/infra/docker-compose.yml"
cat > "$fixture/server/infra/.env.deploy" <<'ENV'
POSTGRES_PASSWORD=validpassword123
JWT_SECRET=ci-only-secret-with-at-least-thirty-two-characters
API_IMAGE=bagcollect-api:new
ADMIN_IMAGE=bagcollect-admin:new
VISION_ENABLED=0
ENV
cat > "$fixture/bin/docker" <<'MOCK'
#!/usr/bin/env bash
set -eu
case "$1" in
  info) exit 0 ;;
  image) exit 0 ;;
  inspect)
    if [[ "$3" = '{{.Config.Image}}' ]]; then
      case "$4" in old-api) echo bagcollect-api:previous ;; old-admin) echo bagcollect-admin:previous ;; old-scan) echo bagcollect-api:previous-scan ;; esac
    else echo unhealthy; fi
    exit 0 ;;
  compose) shift ;;
  *) exit 99 ;;
esac
if [ "$1" = version ]; then exit 0; fi
shift 4
printf '%s|%s|%s\n' "${API_IMAGE:-}" "${ADMIN_IMAGE:-}" "$*" >> "$TEST_CALLS"
case "$1" in
  ps)
    if [ "$2" = -q ]; then
      case "$3" in api) echo old-api ;; admin) echo old-admin ;; scan-worker) echo old-scan ;; esac
    fi ;;
  up)
    if [[ "$*" = *--exit-code-from* ]] && [ "$TEST_FAILURE" = migration ]; then exit 29; fi ;;
  logs|stop) ;;
  *) exit 99 ;;
esac
MOCK
chmod +x "$fixture/bin/docker"
export PATH="$fixture/bin:$PATH" BAGCOLLECT_DEPLOY_DIR="$fixture/server" SKIP_IMAGE_PULL=1
export API_IMAGE=bagcollect-api:new ADMIN_IMAGE=bagcollect-admin:new
for scenario in migration health; do
  export TEST_FAILURE=$scenario TEST_CALLS="$fixture/$scenario.calls"
  set +e
  bash "$fixture/server/infra/deploy.sh" > "$fixture/$scenario.log" 2>&1
  result=$?
  set -e
  [ "$result" -ne 0 ]
  grep -Fq 'bagcollect-api:previous|bagcollect-admin:previous|up -d --remove-orphans api worker admin' "$TEST_CALLS"
  grep -Fq 'bagcollect-api:previous-scan|bagcollect-admin:new|up -d --no-deps scan-worker' "$TEST_CALLS"
  ! grep -Eq 'migrate (reset|resolve)|down.*volumes' "$TEST_CALLS"
  echo "PASS: $scenario failure restores prior application/scan images and propagates failure"
done
