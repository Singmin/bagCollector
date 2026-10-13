#!/usr/bin/env bash
# CI only: build disposable business changes; never export these images for deployment.
set -euo pipefail
fixture_sha=ffffffffffffffffffffffffffffffffffffffff
scratch=.runtime/business-image-delta
mkdir -p "$scratch"
cp apps/api/src/main.ts "$scratch/api-main.ts"
cp admin-artifact/assets/index.html "$scratch/admin-index.html"
cp apps/api/prisma/schema.prisma "$scratch/schema.prisma"
cp package.json "$scratch/package.json"
find image-objects -maxdepth 1 -name '*.gz' -printf '%f\n' | sort > "$scratch/before-objects"
cleanup() {
  cp "$scratch/api-main.ts" apps/api/src/main.ts
  cp "$scratch/admin-index.html" admin-artifact/assets/index.html
  cp "$scratch/schema.prisma" apps/api/prisma/schema.prisma
  cp "$scratch/package.json" package.json
  python3 - "$scratch/before-objects" <<'PY'
import pathlib,sys
known=set(pathlib.Path(sys.argv[1]).read_text().splitlines())
for path in pathlib.Path('image-objects').glob('*.gz'):
    if path.name not in known: path.unlink()
PY
}
trap cleanup EXIT
printf '\nconsole.info("incremental build acceptance fixture");\n' >> apps/api/src/main.ts
python3 - <<'PY'
from pathlib import Path
path=Path('admin-artifact/assets/index.html')
text=path.read_text()
assert '</title>' in text
path.write_text(text.replace('</title>', ' incremental acceptance</title>', 1))
PY
for target in api admin; do
  docker buildx build --file infra/Dockerfile --target "$target" --platform linux/amd64 \
    --provenance=false --build-arg SOURCE_DATE_EPOCH=1704067200 \
    --output "type=docker,dest=$scratch/$target.tar,rewrite-timestamp=true" \
    --tag "bagcollect-$target:$fixture_sha" .
  docker image load --input "$scratch/$target.tar"
done
GITHUB_SHA=$fixture_sha bash infra/export-images.sh "$scratch/images" \
  "bagcollect-api:$fixture_sha" "bagcollect-admin:$fixture_sha"
python3 - "$scratch" <<'PY'
import importlib.util,pathlib,sys
spec=importlib.util.spec_from_file_location('bundle', 'infra/image-bundle.py')
b=importlib.util.module_from_spec(spec); spec.loader.exec_module(b)
root=pathlib.Path(sys.argv[1])
before=b.load('production-images')
after=b.load(root/'images')
large=lambda m:{member['sha256'] for member in m['members'] if member['type'] in ('0','\0') and member['size']>=10*1024*1024}
assert large(before), 'fixture must include real large runtime layers'
assert large(before)==large(after), 'ordinary business change regenerated a large dependency layer'
known=set((root/'before-objects').read_text().splitlines())
changed=[c for sha,c in b.chunks(after).items() if sha+'.gz' not in known]
uploaded=sum(c['compressed_size'] for c in changed)
print(f'Actual API source + Admin text change: {len(changed)} new objects, {uploaded} bytes; large layers unchanged')
assert 0<uploaded<=10*1024*1024, 'ordinary business change exceeded 10 MiB incremental transfer budget'
PY

# Keep these regressions in normal PR acceptance too, independent of historical
# Actions artifacts used by the one-time real-version replay.
cp "$scratch/api-main.ts" apps/api/src/main.ts
cp "$scratch/admin-index.html" admin-artifact/assets/index.html
for scenario in schema root-script; do
  cp "$scratch/schema.prisma" apps/api/prisma/schema.prisma
  cp "$scratch/package.json" package.json
  if [ "$scenario" = schema ]; then
    printf '\nmodel DeploymentLayerRegression {\n  id String @id\n}\n' >> apps/api/prisma/schema.prisma
  else
    node -e 'const fs=require("fs");const m=JSON.parse(fs.readFileSync("package.json"));m.scripts["test:layer-fixture"]="node fixture-only.js";fs.writeFileSync("package.json",JSON.stringify(m,null,2)+"\n")'
  fi
  docker buildx build --file infra/Dockerfile --target api --platform linux/amd64 \
    --provenance=false --build-arg SOURCE_DATE_EPOCH=1704067200 \
    --output "type=docker,dest=$scratch/$scenario.tar,rewrite-timestamp=true" \
    --tag "bagcollect-api:$fixture_sha" .
  docker image load --input "$scratch/$scenario.tar"
  docker run --rm --network host -e DATABASE_URL "bagcollect-api:$fixture_sha" sh -c \
    'cd apps/api && node -e '\''const {PrismaClient}=require("@prisma/client");const p=new PrismaClient();p.$queryRawUnsafe("SELECT 1").then(()=>p.$disconnect()).catch(e=>{console.error(e);process.exit(1)})'\'''
  GITHUB_SHA=$fixture_sha bash infra/export-images.sh "$scratch/$scenario/production-images" \
    "bagcollect-api:$fixture_sha" "bagcollect-admin:$GITHUB_SHA"
  python3 scripts/assert-deployment-delta.py --before . --after "$scratch/$scenario" --objects image-objects \
    --case "$scenario" --output ".runtime/deploy-diagnostics/$scenario.json"
done
