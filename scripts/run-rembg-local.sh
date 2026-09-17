#!/bin/sh
set -eu

project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
model_dir=${REMBG_HOME:-"$project_dir/data/rembg-models"}

mkdir -p "$model_dir"
export REMBG_HOME="$model_dir"

exec uvx \
  --python 3.12 \
  --from 'rembg[cpu,cli]==2.0.84' \
  rembg s \
  --host 127.0.0.1 \
  --port "${REMBG_PORT:-7000}" \
  --threads "${REMBG_MAX_CONCURRENCY:-1}" \
  --no-ui
