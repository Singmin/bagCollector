#!/usr/bin/env bash
# Runner only. Reconnect to a per-release detached task without starting it twice.
set -euo pipefail
mode=${1:?prepare or apply}
[[ "$mode" = prepare || "$mode" = apply ]]
started=$SECONDS
diagnostics=${DEPLOY_DIAGNOSTICS_DIR:-.runtime/deploy-diagnostics}
mkdir -p "$diagnostics"
trap 'result=$?; printf "{\"mode\":\"%s\",\"seconds\":%s,\"exit_code\":%s}\n" "$mode" "$((SECONDS - started))" "$result" > "$diagnostics/$mode-summary.json"' EXIT
[[ "$GITHUB_SHA" =~ ^[0-9a-f]{40}$ && "$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT" =~ ^[0-9]+-[0-9]+$ ]]
[[ "$DEPLOY_PATH" =~ ^/[a-zA-Z0-9_./-]+$ && "$DEPLOY_PATH" != / ]]
[[ "/${DEPLOY_PATH#/}/" != *'/../'* && "/${DEPLOY_PATH#/}/" != *'/./'* ]]
for attempt in 1 2 3; do
  set +e
  ssh -i "${DEPLOY_KEY:-$HOME/.ssh/deploy_key}" -p "${DEPLOY_PORT:-22}" \
    -o ConnectTimeout=30 -o BatchMode=yes -o StrictHostKeyChecking=yes \
    -o IPQoS=none -o ServerAliveInterval=15 -o ServerAliveCountMax=4 \
    "$DEPLOY_USER@$DEPLOY_HOST" bash -s -- "$DEPLOY_PATH" "$GITHUB_SHA" \
    "$GITHUB_RUN_ID" "$GITHUB_RUN_ATTEMPT" "$mode" <<'REMOTE'
set -euo pipefail
root=$1; sha=$2; run=$3; attempt=$4; mode=$5
release="$root/releases/$sha-$run-$attempt"
status="/tmp/bagcollect-$mode-$run-$attempt.status"
log="/tmp/bagcollect-$mode-$run-$attempt.log"
if [ ! -f "$status" ] && mkdir "$status.launch" 2>/dev/null; then
  case "$mode" in prepare) flag=--prepare-only ;; apply) flag=--apply ;; esac
  nohup sh -c '
    code=0
    BAGCOLLECT_DEPLOY_DIR="$2" BAGCOLLECT_RELEASE_DIR="$3" BAGCOLLECT_IMAGE_TAG="$4" \
      sh "$3/infra/load-and-deploy.sh" "$5" || code=$?
    printf "%s\n" "$code" > "$1.tmp"
    mv "$1.tmp" "$1"
  ' sh "$status" "$root" "$release" "$sha" "$flag" </dev/null >"$log" 2>&1 &
  echo "$!" > "$status.launch/pid"
fi
for i in $(seq 1 80); do
  [ ! -f "$status" ] || break
  if [ "$i" -gt 1 ] && [ -f "$status.launch/pid" ] && ! kill -0 "$(cat "$status.launch/pid")" 2>/dev/null; then
    [ ! -f "$status" ] || break
    echo '后台任务已退出但缺少结果文件；停止跟进，需要检查日志' >&2
    tail -n 80 "$log" >&2
    exit 1
  fi
  if [ $((i % 3)) -eq 0 ]; then tail -n 10 "$log"; fi
  sleep 10
done
if [ ! -f "$status" ]; then echo "任务状态未知，日志 $log" >&2; exit 124; fi
tail -n 100 "$log"
test "$(cat "$status")" = 0
if [ "$mode" = prepare ]; then grep -q '发布准备完成' "$log"; else grep -q '部署完成' "$log"; fi
echo "已确认 $mode 完成，源码 SHA=$sha"
REMOTE
  result=$?
  set -e
  [ "$result" -ne 0 ] || exit 0
  if [ "$attempt" -lt 3 ] && { [ "$result" -eq 255 ] || [ "$result" -eq 124 ]; }; then
    echo 'SSH 中断或等待超时；重新检查同一任务状态' >&2
    sleep 10
  else
    exit "$result"
  fi
done
