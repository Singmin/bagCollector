#!/bin/bash
# CI only: export images built and tested in this run.
set -euo pipefail
output=${1:?set output directory}
shift
[ "$#" -gt 0 ]
mkdir -p "$output"
printf '%s\n' "${GITHUB_SHA:?set GITHUB_SHA}" > "$output/source-sha"
docker image inspect --format '{{.Architecture}}' "$1" > "$output/architecture"
: > "$output/images.ids"
: > "$output/images.fingerprints"
for image in "$@"; do
  docker image inspect --format "{{.Id}} $image" "$image" >> "$output/images.ids"
  printf '%s %s\n' "$(sh infra/image-fingerprint.sh "$image")" "$image" >> "$output/images.fingerprints"
done
docker image save "$@" | gzip -6 > "$output/images.tar.gz"
python3 infra/image-bundle.py pack --archive "$output/images.tar.gz" --bundle "$output" --objects image-objects
du -h "$output/images.tar.gz"
