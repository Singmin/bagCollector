#!/usr/bin/env bash
# Runner only. Resume interrupted uploads and validate the complete release before import.
set -euo pipefail
archive=${1:?set release archive}
: "${DEPLOY_HOST:?}" "${DEPLOY_USER:?}" "${DEPLOY_PATH:?}" "${GITHUB_SHA:?}" "${GITHUB_RUN_ID:?}" "${GITHUB_RUN_ATTEMPT:?}"
DEPLOY_PORT=${DEPLOY_PORT:-22}
key=${DEPLOY_KEY:-$HOME/.ssh/deploy_key}
[[ "$GITHUB_SHA" =~ ^[0-9a-f]{40}$ ]]
[[ "$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT" =~ ^[0-9]+-[0-9]+$ ]]
[[ "$DEPLOY_PORT" =~ ^[0-9]+$ ]]
[[ "$DEPLOY_HOST" =~ ^[a-zA-Z0-9.-]+$ && "$DEPLOY_USER" =~ ^[a-zA-Z0-9_-]+$ ]]
# These paths are also passed to a remote shell and must remain inside incoming/.
[[ "$DEPLOY_PATH" =~ ^/[a-zA-Z0-9_./-]+$ && "$DEPLOY_PATH" != / ]]
[[ "/${DEPLOY_PATH#/}/" != *'/../'* && "/${DEPLOY_PATH#/}/" != *'/./'* ]]
name="bagcollect-release-$GITHUB_SHA.tar"
[[ "$(basename "$archive")" = "$name" && -s "$archive" ]]
target_dir="${DEPLOY_PATH%/}/incoming/$GITHUB_RUN_ID-$GITHUB_RUN_ATTEMPT"
target="$target_dir/$name"
ssh_args=(-i "$key" -p "$DEPLOY_PORT" -o ConnectTimeout=30 -o BatchMode=yes
  -o StrictHostKeyChecking=yes -o IPQoS=none -o ServerAliveInterval=15 -o ServerAliveCountMax=4)
# Quote each argument for rsync's remote shell parser, including paths with spaces.
printf -v rsh '%q ' ssh "${ssh_args[@]}"

timeout 90 ssh "${ssh_args[@]}" "$DEPLOY_USER@$DEPLOY_HOST" bash -s -- \
  "${DEPLOY_PATH%/}" "$target_dir" "$name" <<'REMOTE'
set -euo pipefail
root=$1
target_dir=$2
name=$3
command -v rsync >/dev/null || { echo '服务器缺少 rsync，请安装后重试' >&2; exit 1; }
mkdir -p "$target_dir"
# Reuse the largest checkpoint from previous attempts of this exact source SHA.
# A hard link costs no extra disk space. Rsync writes a temporary file and renames it;
# do not use --inplace or --append, which could corrupt the original checkpoint.
if [ ! -f "$target_dir/$name" ] && [ ! -f "$target_dir/.rsync-partial/$name" ]; then
  best=''
  largest=0
  while IFS= read -r -d '' candidate; do
    bytes=$(stat -c %s "$candidate")
    if [ "$bytes" -gt "$largest" ]; then best=$candidate; largest=$bytes; fi
  done < <(find "$root/incoming" -maxdepth 3 -type f -name "$name" -print0)
  if [ -n "$best" ]; then
    ln "$best" "$target_dir/$name"
    echo "复用已有上传检查点：$largest 字节"
  fi
fi
df -h "$target_dir"
REMOTE

started=$SECONDS
uploaded=0
for attempt in 1 2 3; do
  echo "===== 可续传上传：第 $attempt/3 次（实时进度；中断后保留已传数据）====="
  # Inactivity is bounded separately from total time. TERM allows rsync to save partial data.
  if timeout --kill-after=15 600 rsync --checksum --no-whole-file \
    --partial-dir=.rsync-partial --timeout=90 --info=progress2 --stats \
    --rsync-path='nice -n 19 rsync' -e "$rsh" "$archive" "$DEPLOY_USER@$DEPLOY_HOST:$target"; then
    uploaded=1
    break
  fi
  echo '传输中断；下一次从已传数据继续。' >&2
  [ "$attempt" -eq 3 ] || sleep 5
done
[ "$uploaded" -eq 1 ] || { echo '上传失败，检查点已保留，重新运行可继续传输。' >&2; exit 1; }
digest=$(sha256sum "$archive" | cut -d' ' -f1)
timeout 90 ssh "${ssh_args[@]}" "$DEPLOY_USER@$DEPLOY_HOST" \
  "echo '$digest  $target' | sha256sum -c -"
echo "发布包传输及完整性校验耗时：$((SECONDS - started)) 秒"
