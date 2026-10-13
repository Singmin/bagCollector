#!/usr/bin/env bash
# Runner only. Control files first, then only missing, independently verified objects.
set -euo pipefail
umask 077
control=${1:?set control archive}
: "${DEPLOY_HOST:?}" "${DEPLOY_USER:?}" "${DEPLOY_PATH:?}" "${GITHUB_SHA:?}" "${GITHUB_RUN_ID:?}" "${GITHUB_RUN_ATTEMPT:?}"
DEPLOY_PORT=${DEPLOY_PORT:-22}
key=${DEPLOY_KEY:-$HOME/.ssh/deploy_key}
[[ "$GITHUB_SHA" =~ ^[0-9a-f]{40}$ ]]
[[ "$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT" =~ ^[0-9]+-[0-9]+$ ]]
[[ "$DEPLOY_PORT" =~ ^[0-9]+$ ]]
[[ "$DEPLOY_HOST" =~ ^[a-zA-Z0-9.-]+$ && "$DEPLOY_USER" =~ ^[a-zA-Z0-9_-]+$ ]]
[[ "$DEPLOY_PATH" =~ ^/[a-zA-Z0-9_./-]+$ && "$DEPLOY_PATH" != / ]]
[[ "/${DEPLOY_PATH#/}/" != *'/../'* && "/${DEPLOY_PATH#/}/" != *'/./'* ]]
[[ "$(basename "$control")" = "bagcollect-control-$GITHUB_SHA.tar" && -s "$control" ]]
root=${DEPLOY_PATH%/}
transfer="$root/incoming/$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT"
release="$root/releases/$GITHUB_SHA-$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT"
objects=${IMAGE_OBJECTS_DIR:-image-objects}
ssh_args=(-i "$key" -p "$DEPLOY_PORT" -o ConnectTimeout=30 -o BatchMode=yes
  -o StrictHostKeyChecking=yes -o IPQoS=none -o ServerAliveInterval=15 -o ServerAliveCountMax=4)
printf -v rsh '%q ' ssh "${ssh_args[@]}"
started=$SECONDS
scratch=$(mktemp -d)
diagnostics=${DEPLOY_DIAGNOSTICS_DIR:-.runtime/deploy-diagnostics}
mkdir -p "$diagnostics"
pids=()
monitor=
cache_seconds=0
upload_seconds=0
verification_seconds=0
attempts=0
cleanup() {
  code=$?
  [ -z "$monitor" ] || kill "$monitor" 2>/dev/null || true
  for pid in "${pids[@]}"; do kill "$pid" 2>/dev/null || true; done
  for socket in "$scratch"/c*; do
    [ ! -S "$socket" ] || ssh "${ssh_args[@]}" -S "$socket" -O exit "$DEPLOY_USER@$DEPLOY_HOST" >/dev/null 2>&1 || true
  done
  python3 - "$diagnostics/transfer-summary.json" "$code" "$GITHUB_SHA" "$attempts" "$cache_seconds" "$upload_seconds" "$verification_seconds" "$((SECONDS - started))" <<'PY'
import json,sys,pathlib
p=pathlib.Path(sys.argv[1]); attempts=[]
for i in range(1,int(sys.argv[4])+1):
 f=p.parent/f'attempt-{i}.json'
 if f.exists(): attempts.append(json.loads(f.read_text()))
p.write_text(json.dumps({'source_sha':sys.argv[3],'exit_code':int(sys.argv[2]),'attempts':int(sys.argv[4]),
 'cache_check_seconds':int(sys.argv[5]),'upload_seconds':int(sys.argv[6]),'verification_seconds':int(sys.argv[7]),
 'total_seconds':int(sys.argv[8]),'verified_complete':int(sys.argv[2])==0,'transfers':attempts},indent=2)+'\n')
PY
  rm -rf "$scratch"
}
trap cleanup EXIT

timeout 60 ssh "${ssh_args[@]}" "$DEPLOY_USER@$DEPLOY_HOST" "command -v python3 >/dev/null && command -v rsync >/dev/null && test ! -L '$root/.image-cache' && test ! -L '$root/.image-cache/v2' && test ! -L '$root/.image-cache/v2/receiving' && mkdir -p '$root/.image-cache/v2/receiving' '$transfer' '$release'"
timeout 90 rsync --checksum --no-whole-file --partial-dir=.rsync-partial --timeout=30 \
  -e "$rsh" "$control" "$DEPLOY_USER@$DEPLOY_HOST:$transfer/control.tar"
checksum=$(sha256sum "$control" | cut -d' ' -f1)
timeout 900 ssh "${ssh_args[@]}" "$DEPLOY_USER@$DEPLOY_HOST" bash -s -- \
  "$root" "$transfer" "$release" "$checksum" "$GITHUB_SHA" <<'REMOTE' > "$scratch/missing.list"
set -euo pipefail
root=$1; transfer=$2; release=$3; checksum=$4; sha=$5
printf '%s  %s\n' "$checksum" "$transfer/control.tar" | sha256sum -c - >&2
python3 - "$transfer/control.tar" "$release" <<'PY'
import sys,tarfile,pathlib
root=pathlib.Path(sys.argv[2]).resolve()
with tarfile.open(sys.argv[1]) as tar:
    items=tar.getmembers()
    if sum(m.size for m in items)>32*1024*1024: raise ValueError('control archive too large')
    for m in items:
        name=pathlib.PurePosixPath(m.name)
        if name.is_absolute() or '..' in name.parts or name.parts[0] not in ('infra','production-images','vision-images') or not (m.isfile() or m.isdir()): raise ValueError('invalid control member')
        dest=root.joinpath(*name.parts)
        if not dest.resolve().is_relative_to(root) or dest.is_symlink(): raise ValueError('control path escape')
        if m.isdir(): dest.mkdir(parents=True,exist_ok=True)
        else:
            dest.parent.mkdir(parents=True,exist_ok=True)
            with tar.extractfile(m) as src,open(dest,'wb') as out:
                import shutil
                shutil.copyfileobj(src,out)
PY
printf '%s\n' "$sha" > "$release/.v2-release"
module="$release/infra/image-bundle.py"
cache="$root/.image-cache/v2/objects"
mkdir -p "$cache"
case "$(uname -m)" in x86_64) arch=amd64 ;; aarch64|arm64) arch=arm64 ;; *) exit 1 ;; esac
bundles=(--bundle "$release/production-images")
if [ -d "$release/vision-images" ]; then bundles+=(--bundle "$release/vision-images"); fi
# Space check precedes cache seeding, network data receipt and image import.
nice -n 19 python3 "$module" space "${bundles[@]}" --objects "$cache" --root "$release" --sha "$sha" --architecture "$arch" >&2
flock "$root/.image-cache/cache.lock" nice -n 19 python3 "$module" bootstrap --objects "$cache" --root "$root" >&2
nice -n 19 python3 "$module" have "${bundles[@]}" --objects "$cache" --sha "$sha" --architecture "$arch"
REMOTE
cache_seconds=$((SECONDS - started))
echo "缓存检查耗时：$cache_seconds 秒"

run_worker() {
  trap - EXIT
  local worker=$1 queue=$2 claim batch bytes list available begin result sent worker_rsh
  local -a worker_ssh=("${ssh_args[@]}" -o ControlMaster=auto -o ControlPersist=60 -o "ControlPath=$scratch/c$worker")
  printf -v worker_rsh '%q ' ssh "${worker_ssh[@]}"
  while true; do
    available=$((1800 - (SECONDS - started)))
    [ "$available" -gt 0 ] || return 124
    claim=$(python3 infra/transfer-queue.py claim --queue "$queue" --worker "$worker")
    [ -n "$claim" ] || return 0
    IFS=$'\t' read -r batch bytes list <<< "$claim"
    echo "[stream $worker] 领取批次 $batch，$bytes 字节"
    begin=$SECONDS
    set +e
    timeout --kill-after=15 "$available" rsync --checksum --no-whole-file \
      --files-from="$list" --partial-dir=.rsync-partial --timeout=90 --outbuf=L \
      --info=progress2 --stats --rsync-path='nice -n 19 rsync' -e "$worker_rsh" \
      "$objects/" "$DEPLOY_USER@$DEPLOY_HOST:$root/.image-cache/v2/receiving/" \
      2>&1 | tr '\r' '\n' | sed -u "s/^/[stream $worker] /" | tee "$queue/batch-$batch.log"
    result=$?
    set -e
    sent=$(awk '/Total bytes sent:/ {gsub(/,/, "", $NF); print $NF}' "$queue/batch-$batch.log")
    python3 infra/transfer-queue.py complete --queue "$queue" --worker "$worker" --batch "$batch" \
      --elapsed "$((SECONDS - begin))" --result "$result" --sent "${sent:-0}"
    [ "$result" -eq 0 ] || return "$result"
  done
}

for attempt in 1 2 3; do
  if [ ! -s "$scratch/missing.list" ]; then break; fi
  remaining=$((1800 - (SECONDS - started)))
  [ "$remaining" -gt 0 ] || { echo '30 分钟传输上限，保留已验证对象供下次续传' >&2; exit 1; }
  attempts=$attempt
  queue="$scratch/queue-$attempt"
  read -r workers pending_bytes pending_objects < <(python3 infra/transfer-queue.py plan \
    --queue "$queue" --missing "$scratch/missing.list" --objects "$objects")
  echo "增量传输第 $attempt/3 次：$pending_objects 个缺失对象，$pending_bytes 字节，$workers 路动态调度，剩余预算 $remaining 秒"
  upload_started=$SECONDS
  pids=()
  for worker in $(seq 1 "$workers"); do
    run_worker "$worker" "$queue" &
    pids+=("$!")
  done
  (trap - EXIT; while true; do sleep 10; python3 infra/transfer-queue.py snapshot --queue "$queue"; done) &
  monitor=$!
  set +e
  result=0
  for pid in "${pids[@]}"; do
    wait "$pid"
    worker_result=$?
    [ "$worker_result" -eq 0 ] || result=$worker_result
  done
  set -e
  kill "$monitor" 2>/dev/null || true
  wait "$monitor" 2>/dev/null || true
  monitor=
  pids=()
  upload_seconds=$((upload_seconds + SECONDS - upload_started))
  python3 infra/transfer-queue.py snapshot --queue "$queue" | tee "$diagnostics/attempt-$attempt.json"
  cp "$queue/state.json" "$diagnostics/attempt-$attempt-events.json"
  verify_started=$SECONDS
  # Cache completed objects even when another file's transfer was interrupted.
  timeout 180 ssh "${ssh_args[@]}" "$DEPLOY_USER@$DEPLOY_HOST" bash -s -- \
    "$root" "$transfer" "$release" "$GITHUB_SHA" <<'REMOTE' > "$scratch/missing.next"
set -euo pipefail
root=$1; transfer=$2; release=$3; sha=$4
module="$release/infra/image-bundle.py"
cache="$root/.image-cache/v2/objects"
bundles=(--bundle "$release/production-images")
if [ -d "$release/vision-images" ]; then bundles+=(--bundle "$release/vision-images"); fi
nice -n 19 python3 "$module" ingest "${bundles[@]}" --objects "$cache" --incoming "$root/.image-cache/v2/receiving" --sha "$sha"
nice -n 19 python3 "$module" have "${bundles[@]}" --objects "$cache" --sha "$sha"
REMOTE
  verification_seconds=$((verification_seconds + SECONDS - verify_started))
  mv "$scratch/missing.next" "$scratch/missing.list"
  [ ! -s "$scratch/missing.list" ] || echo "尚有缺失对象（传输退出码 $result），继续已验证检查点" >&2
 done
[ ! -s "$scratch/missing.list" ] || { echo '增量传输未完成，旧服务保持运行，缓存已保留' >&2; exit 1; }
echo "增量传输及对象校验耗时：$((SECONDS - started)) 秒"
echo "分段耗时：缓存检查 $cache_seconds 秒，上传 $upload_seconds 秒，对象校验 $verification_seconds 秒；重试 $((attempts > 0 ? attempts - 1 : 0)) 次"
