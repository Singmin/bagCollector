#!/usr/bin/env bash
# Exercise actual rsync sender/receiver locally; only replace the SSH network transport.
set -euo pipefail
repo=$(cd "$(dirname "$0")/.." && pwd)
fixture=$(mktemp -d)
trap 'rm -rf "$fixture"' EXIT
mkdir -p "$fixture/bin" "$fixture/server/incoming/1-1"
export DEPLOY_HOST=fixture DEPLOY_USER=runner DEPLOY_PATH="$fixture/server"
export GITHUB_SHA=1111111111111111111111111111111111111111
export GITHUB_RUN_ID=2 GITHUB_RUN_ATTEMPT=1
name="bagcollect-release-$GITHUB_SHA.tar"
archive="$fixture/$name"
dd if=/dev/urandom of="$archive" bs=1M count=8 status=none
old="$DEPLOY_PATH/incoming/1-1"

# Interrupt a real transfer and ensure rsync saves a partial checkpoint.
set +e
timeout --kill-after=5 1 rsync --no-whole-file --bwlimit=1024 \
  --partial-dir=.rsync-partial "$archive" "$old/$name" >"$fixture/interrupted.log" 2>&1
rc=$?
set -e
[ "$rc" -eq 124 ]
checkpoint="$old/.rsync-partial/$name"
test -s "$checkpoint"
test "$(stat -c %s "$checkpoint")" -lt "$(stat -c %s "$archive")"
checkpoint_digest=$(sha256sum "$checkpoint" | cut -d' ' -f1)

cat > "$fixture/bin/ssh" <<'MOCK'
#!/usr/bin/env bash
set -eu
while [[ "$1" = -* ]]; do shift 2; done
shift # remote host
if [ "${MOCK_BAD_CHECKSUM:-0}" = 1 ] && [[ "$*" = *'sha256sum -c'* ]]; then exit 1; fi
if [ "$1" = bash ]; then exec "$@"; fi
# Real rsync server, or the helper's fixed checksum command, on the same filesystem.
exec bash -c "$*"
MOCK
chmod +x "$fixture/bin/ssh"
export PATH="$fixture/bin:$PATH"
bash "$repo/infra/transfer-release.sh" "$archive" > "$fixture/resume.log"
target="$DEPLOY_PATH/incoming/2-1/$name"
cmp "$archive" "$target"
grep -Eq 'Matched data: [1-9][0-9,]* bytes' "$fixture/resume.log"
test "$checkpoint_digest" = "$(sha256sum "$checkpoint" | cut -d' ' -f1)"
echo 'PASS: interrupted upload resumes using existing bytes; original checkpoint unchanged'

# Same size and mtime must not cause a corrupt completed file to be silently skipped.
cp -p "$target" "$fixture/timestamp"
printf 'corruption' | dd of="$target" bs=1 seek=256 conv=notrunc status=none
touch -r "$fixture/timestamp" "$target"
bash "$repo/infra/transfer-release.sh" "$archive" > "$fixture/repair.log"
cmp "$archive" "$target"
test "$checkpoint_digest" = "$(sha256sum "$checkpoint" | cut -d' ' -f1)"
echo 'PASS: same-size corrupted upload is repaired and checked'

if MOCK_BAD_CHECKSUM=1 bash "$repo/infra/transfer-release.sh" "$archive" > "$fixture/rejected.log" 2>&1; then
  echo 'checksum failure was accepted' >&2
  exit 1
fi
echo 'PASS: failed final checksum prevents a successful transfer result'
