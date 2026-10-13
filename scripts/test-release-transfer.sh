#!/usr/bin/env bash
# Real rsync and server-side bundle checks; only SSH network transport is replaced.
set -euo pipefail
repo=$(cd "$(dirname "$0")/.." && pwd)
mkdir -p "$repo/.runtime"
fixture=$(mktemp -d "$repo/.runtime/release-transfer-XXXXXXXX")
trap 'rm -rf "$fixture"' EXIT
mkdir -p "$fixture/bin" "$fixture/server/releases" "$fixture/payload/infra" "$fixture/objects"
export DEPLOY_HOST=fixture DEPLOY_USER=runner DEPLOY_PATH="$fixture/server"
export GITHUB_SHA=1111111111111111111111111111111111111111
export GITHUB_RUN_ID=2 GITHUB_RUN_ATTEMPT=1
export IMAGE_OBJECTS_DIR="$fixture/objects"
cp "$repo/infra/image-bundle.py" "$fixture/payload/infra/"
python3 - "$fixture" <<'PY'
import importlib.util,pathlib,sys,tarfile,os,io
root=pathlib.Path(sys.argv[1])
spec=importlib.util.spec_from_file_location('bundle',root/'payload/infra/image-bundle.py');b=importlib.util.module_from_spec(spec);spec.loader.exec_module(b)
folder=root/'payload/production-images';folder.mkdir()
for name,data in {'source-sha':os.environ['GITHUB_SHA'],'architecture':'amd64','images.ids':'fixture','images.fingerprints':'fixture'}.items(): (folder/name).write_text(data)
archive=root/'fixture.tar'
with tarfile.open(archive,'w') as tar:
    data=os.urandom(8*1024*1024);info=tarfile.TarInfo('layer.tar');info.size=len(data);tar.addfile(info,io.BytesIO(data))
b.pack(archive,folder,root/'objects')
PY
control="$fixture/bagcollect-control-$GITHUB_SHA.tar"
tar -cf "$control" -C "$fixture/payload" infra production-images
receiving="$DEPLOY_PATH/.image-cache/v2/receiving"
export DEPLOY_DIAGNOSTICS_DIR="$fixture/diagnostics"
mkdir -p "$receiving"
first=$(find "$fixture/objects" -name '*.gz' -printf '%f\n' | sort | head -n 1)
set +e
timeout --kill-after=5 1 rsync --no-whole-file --bwlimit=1024 \
  --partial-dir=.rsync-partial "$fixture/objects/$first" "$receiving/$first" >"$fixture/interrupted.log" 2>&1
result=$?
set -e
[ "$result" -eq 124 ]
test -s "$receiving/.rsync-partial/$first"
cat > "$fixture/bin/ssh" <<'MOCK'
#!/usr/bin/env bash
set -eu
while [[ "$1" = -* ]]; do shift 2; done
shift
if [ "$1" = bash ]; then exec "$@"; fi
exec bash -c "$*"
MOCK
printf '#!/bin/sh\nexit 1\n' > "$fixture/bin/docker"
chmod +x "$fixture/bin/ssh" "$fixture/bin/docker"
export PATH="$fixture/bin:$PATH"
bash "$repo/infra/transfer-release.sh" "$control" > "$fixture/resume.log" 2>&1
module="$DEPLOY_PATH/releases/$GITHUB_SHA-2-1/infra/image-bundle.py"
bundle="$DEPLOY_PATH/releases/$GITHUB_SHA-2-1/production-images"
cache="$DEPLOY_PATH/.image-cache/v2/objects"
python3 "$module" verify --bundle "$bundle" --objects "$cache" --sha "$GITHUB_SHA" --architecture amd64
grep -Eq 'Matched data: [1-9][0-9,]* bytes' "$fixture/resume.log"
echo 'PASS: interrupted object resumes and verified objects survive a new run'
export GITHUB_RUN_ID=3
bash "$repo/infra/transfer-release.sh" "$control" > "$fixture/warm.log" 2>&1
! grep -q '增量传输第' "$fixture/warm.log"
echo 'PASS: warm release sends control metadata only'
printf corrupted > "$cache/$first"
export GITHUB_RUN_ID=4
bash "$repo/infra/transfer-release.sh" "$control" > "$fixture/repair.log" 2>&1
python3 "$module" verify --bundle "$bundle" --objects "$cache"
grep -q '1 个缺失对象' "$fixture/repair.log"
echo 'PASS: corruption downloads only the damaged object'
real_rsync=$(command -v rsync)
printf corrupted > "$cache/$first"
cat > "$fixture/bin/rsync" <<MOCK
#!/usr/bin/env bash
set -eu
for arg in "\$@"; do
  if [[ "\$arg" = --files-from=* ]] && mkdir '$fixture/failed-once' 2>/dev/null; then
    echo 'simulated interrupted batch' >&2
    exit 23
  fi
done
exec '$real_rsync' "\$@"
MOCK
chmod +x "$fixture/bin/rsync"
export GITHUB_RUN_ID=5
bash "$repo/infra/transfer-release.sh" "$control" > "$fixture/retry.log" 2>&1
python3 "$module" verify --bundle "$bundle" --objects "$cache"
python3 - "$fixture/diagnostics/transfer-summary.json" <<'PY'
import json,sys
data=json.load(open(sys.argv[1]))
assert data['attempts']==2 and data['verified_complete']
assert any(w['failures'] for w in data['transfers'][0]['workers'].values())
PY
echo 'PASS: batch failure propagates, preserves verification checkpoints and retries only missing data'
