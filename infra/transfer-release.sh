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
trap 'rm -rf "$scratch"' EXIT

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

for attempt in 1 2 3; do
  if [ ! -s "$scratch/missing.list" ]; then break; fi
  remaining=$((1800 - (SECONDS - started)))
  [ "$remaining" -gt 0 ] || { echo '30 分钟传输上限，保留已验证对象供下次续传' >&2; exit 1; }
  echo "增量传输第 $attempt/3 次：$(wc -l < "$scratch/missing.list") 个缺失对象，剩余预算 $remaining 秒"
  # Bound concurrency to four SSH streams. Each object belongs to exactly one
  # stream, so partial files remain independently resumable without write races.
  workers=$(wc -l < "$scratch/missing.list")
  [ "$workers" -le 4 ] || workers=4
  pids=()
  for worker in $(seq 1 "$workers"); do
    awk -v count="$workers" -v worker="$worker" '(NR-1)%count==worker-1' "$scratch/missing.list" > "$scratch/missing.$worker"
    timeout --kill-after=15 "$remaining" rsync --checksum --no-whole-file \
      --files-from="$scratch/missing.$worker" --partial-dir=.rsync-partial --timeout=90 \
      --info=progress2 --stats --rsync-path='nice -n 19 rsync' -e "$rsh" \
      "$objects/" "$DEPLOY_USER@$DEPLOY_HOST:$root/.image-cache/v2/receiving/" \
      2>&1 | tr '\r' '\n' | sed -u "s/^/[stream $worker] /" &
    pids+=("$!")
  done
  set +e
  result=0
  for pid in "${pids[@]}"; do
    wait "$pid"
    worker_result=$?
    [ "$worker_result" -eq 0 ] || result=$worker_result
  done
  set -e
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
  mv "$scratch/missing.next" "$scratch/missing.list"
  [ ! -s "$scratch/missing.list" ] || echo "尚有缺失对象（传输退出码 $result），继续已验证检查点" >&2
 done
[ ! -s "$scratch/missing.list" ] || { echo '增量传输未完成，旧服务保持运行，缓存已保留' >&2; exit 1; }
echo "增量传输及对象校验耗时：$((SECONDS - started)) 秒"
