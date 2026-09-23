#!/bin/sh
# ---------------------------------------------------------------------------
# 已废弃（DEPRECATED）：启动自托管 rembg 抠图服务
#
# 2026-09-21 起抠图已切换为腾讯云数据万象（2026-09-22 接口定为通用抠图 AIPicMatting），本脚本不在主链路上：
# Worker 不再引用 matting.ts，配置里也没有 provider 开关，因此启动本服务不会被主链路使用。
# 保留原因与完整清单见 apps/worker/src/matting.ts 顶部注释，
# 方案对比见 docs/TENCENT_CI_MATTING.md 与 docs/OPEN_SOURCE_MATTING.md。
#
# 只有单独做推理实验时才需要它：本服务需要自己写代码调用 apps/worker/src/matting.ts。
# ---------------------------------------------------------------------------
set -eu

project_dir=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)

# Git Bash / MSYS 下 pwd 返回 /c/Users/... 这类 POSIX 路径，原生 Windows Python 会把
# 它当成「当前盘根下的 c\Users\...」，于是 REMBG_HOME 指向不存在的目录，
# 明明本地已缓存模型却会重新联网下载。转成 C:/Users/... 让两边都认。
if command -v cygpath > /dev/null 2>&1; then
  project_dir=$(cygpath -m "$project_dir")
fi

model_dir=${REMBG_HOME:-"$project_dir/data/rembg-models"}

mkdir -p "$model_dir"
export REMBG_HOME="$model_dir"

# 推理线程数由 OMP_NUM_THREADS 决定（--threads 只管并发上限）。实测这个模型是访存带宽
# 瓶颈，限制线程数只会更慢，所以默认不动它，让 onnxruntime 用满可用核心。详见
# infra/rembg-entrypoint.sh。需要覆盖时 export REMBG_OMP_NUM_THREADS=<n> 再跑本脚本。
if [ -n "${REMBG_OMP_NUM_THREADS:-}" ] && [ "${REMBG_OMP_NUM_THREADS}" != "auto" ]; then
  export OMP_NUM_THREADS="${REMBG_OMP_NUM_THREADS}"
fi

exec uvx \
  --python 3.12 \
  --from 'rembg[cpu,cli]==2.0.84' \
  rembg s \
  --host 127.0.0.1 \
  --port "${REMBG_PORT:-7000}" \
  --threads "${REMBG_SERVER_CONCURRENCY:-1}" \
  --no-ui
