#!/usr/bin/env bash
# Disposable contexts/images only: these fixtures must never be deployed.
set -euo pipefail
before_sha=b70eb2a8cefc3197007d2993a63251900f4ef553
after_sha=83638ff4a76301d4d0fab3ece473a8b6d73c2508
scratch=.runtime/deployment-delta
reports=.runtime/deploy-diagnostics
mkdir -p "$scratch" "$reports"
mkdir -p image-objects
cp -n .runtime/baseline/before/image-objects/* image-objects/
cp -n .runtime/baseline/after/image-objects/* image-objects/
python3 scripts/image-delta-report.py --before .runtime/baseline/before --after .runtime/baseline/after \
  --objects .runtime/baseline/after/image-objects --output "$reports/original-delta.json"
for version in before after; do
  root=".runtime/baseline/$version"
  python3 infra/image-bundle.py rebuild --bundle "$root/production-images" --objects "$root/image-objects" --output "$scratch/original-$version.tar.gz"
  docker image load --input "$scratch/original-$version.tar.gz"
  rm "$scratch/original-$version.tar.gz"
done
for version in before after; do
  if [ "$version" = before ]; then sha=$before_sha; else sha=$after_sha; fi
  context="$scratch/$version-context"
  mkdir -p "$context"
  git archive "$sha" | tar -xf - -C "$context"
  for file in Dockerfile prune-runtime-deps.mjs normalize-production-manifest.mjs split-prisma-client.mjs; do
    cp "infra/$file" "$context/infra/$file"
  done
  cp .dockerignore "$context/.dockerignore"
done
build_api() {
  local sha=$1 context=$2 destination=$3
  shift 3
  docker buildx build --file "$context/infra/Dockerfile" --target api --platform linux/amd64 \
    --provenance=false --build-arg SOURCE_DATE_EPOCH=1704067200 "$@" \
    --output "type=docker,dest=$scratch/current-api.tar,rewrite-timestamp=true" --tag "bagcollect-api:$sha" "$context"
  docker image load --input "$scratch/current-api.tar"
  GITHUB_SHA=$sha bash infra/export-images.sh "$destination/production-images" "bagcollect-api:$sha" "bagcollect-admin:$after_sha"
}
# Both replay endpoints use exactly the optimized infra. Preserve each endpoint's
# original verified Admin image; frontend compilation is not being changed here.
build_api "$before_sha" "$scratch/before-context" "$scratch/optimized-before"
# Replace the Admin tag in the before bundle with the genuinely older artifact.
GITHUB_SHA=$before_sha bash infra/export-images.sh "$scratch/optimized-before/production-images" "bagcollect-api:$before_sha" "bagcollect-admin:$before_sha"
build_api "$after_sha" "$scratch/after-context" "$scratch/optimized-after" --no-cache
cp -R .runtime/baseline/before/vision-images "$scratch/optimized-before/"
cp -R .runtime/baseline/after/vision-images "$scratch/optimized-after/"
python3 scripts/assert-deployment-delta.py --before "$scratch/optimized-before" --after "$scratch/optimized-after" \
  --objects image-objects --case real-replay --output "$reports/optimized-real-replay.json"

# Validate generated clients by querying the real isolated CI database through
# both project resolution paths, not merely by inspecting copied files.
docker run --rm --network host -e DATABASE_URL "bagcollect-api:$after_sha" \
  node apps/api/node_modules/prisma/build/index.js migrate deploy --schema apps/api/prisma/schema.prisma
runtime_check() {
  local sha=$1
  for app in api worker; do
    docker run --rm --network host -e DATABASE_URL "bagcollect-api:$sha" sh -c \
      "cd apps/$app && node -e 'const {PrismaClient}=require(\"@prisma/client\");const p=new PrismaClient();p.\$queryRawUnsafe(\"SELECT 1\").then(()=>p.\$disconnect()).catch(e=>{console.error(e);process.exit(1)})'"
  done
  docker run --rm "bagcollect-api:$sha" sh -c 'cd apps/worker && node --input-type=module -e "import sharp from \"sharp\";await sharp({create:{width:8,height:8,channels:3,background:\"red\"}}).png().toBuffer()"'
}
runtime_check "$after_sha"
docker run -d --name delta-worker --network host -e DATABASE_URL -e REDIS_URL -e NODE_ENV=test -e STORAGE_DRIVER=local \
  "bagcollect-api:$after_sha" node apps/worker/dist/main.js
docker run -d --name delta-scan-worker --network host -e DATABASE_URL -e REDIS_URL -e NODE_ENV=test -e STORAGE_DRIVER=local \
  "bagcollect-api:$after_sha" node apps/worker/dist/scan-main.js
trap 'docker logs delta-worker; docker logs delta-scan-worker; docker rm -f delta-worker delta-scan-worker >/dev/null' EXIT
sleep 10
test "$(docker inspect --format '{{.State.Running}}' delta-worker)" = true
test "$(docker inspect --format '{{.State.Running}}' delta-scan-worker)" = true
! docker logs delta-worker 2>&1 | grep -E 'reconcile_error|embedding_reconcile_error'
! docker logs delta-scan-worker 2>&1 | grep -E 'scan_sweep_error|scan_worker_error'

context="$scratch/after-context"
cp "$context/apps/api/src/main.ts" "$scratch/api-main.ts"
cp "$context/apps/api/prisma/schema.prisma" "$scratch/schema.prisma"
cp "$context/package.json" "$scratch/package.json"
index=0
for scenario in business schema root-script cold-repeat; do
  index=$((index+1))
  sha=$(printf '%040d' "$index")
  cp "$scratch/api-main.ts" "$context/apps/api/src/main.ts"
  cp "$scratch/schema.prisma" "$context/apps/api/prisma/schema.prisma"
  cp "$scratch/package.json" "$context/package.json"
  options=()
  case "$scenario" in
    business) printf '\nconsole.info("deployment delta fixture");\n' >> "$context/apps/api/src/main.ts" ;;
    schema) printf '\nmodel DeploymentDeltaFixture {\n  id String @id\n}\n' >> "$context/apps/api/prisma/schema.prisma" ;;
    root-script) python3 - "$context/package.json" <<'PY'
import json,sys,pathlib
p=pathlib.Path(sys.argv[1]);m=json.loads(p.read_text());m['scripts']['test:deployment-fixture']='node fixture-only.js';p.write_text(json.dumps(m,indent=2)+'\n')
PY
      ;;
    cold-repeat) options=(--no-cache) ;;
  esac
  build_api "$sha" "$context" "$scratch/$scenario" "${options[@]}"
  python3 scripts/assert-deployment-delta.py --before "$scratch/optimized-after" --after "$scratch/$scenario" \
    --objects image-objects --case "$scenario" --output "$reports/$scenario.json"
  runtime_check "$sha"
done
echo 'PASS: real replay, schema changes, root scripts and two cold builds stay within incremental budget'
