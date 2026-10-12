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
for image in "$@"; do
  docker image inspect --format "{{.Id}} $image" "$image" >> "$output/images.ids"
done
docker image save "$@" | gzip -6 > "$output/images.tar.gz"
(cd "$output" && sha256sum images.tar.gz images.ids source-sha architecture > SHA256SUMS)
du -h "$output/images.tar.gz"
