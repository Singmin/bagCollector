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
mkdir -p .runtime
scratch=$(mktemp -d .runtime/image-export-XXXXXXXX)
trap 'rm -rf "$scratch"' EXIT
# v2 already compresses each object. A whole-archive gzip pass followed by an
# immediate decompression in pack adds CPU work without reducing upload bytes.
docker image save "$@" > "$scratch/images.tar"
python3 infra/image-bundle.py pack --archive "$scratch/images.tar" --bundle "$output" --objects image-objects
echo 'Raw image export (transport uses compressed v2 objects):'
du -h "$scratch/images.tar"
