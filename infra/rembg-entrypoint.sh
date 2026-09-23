#!/bin/sh
set -eu

# rembg 2.0.84 里这两个开关的作用完全不同，别混为一谈：
#   --threads        只设置 anyio 的并发请求上限（CapacityLimiter），不影响单次推理速度。
#   OMP_NUM_THREADS  才是真正决定 onnxruntime intra/inter-op 线程数的开关
#                    （见 rembg/session_factory.py：读该变量并写入 sess_opts）。
#
# 实测数据（16 核机器，birefnet-general-lite，模型输入固定 1024x1024，同一张 256px 图）：
#   不设 OMP_NUM_THREADS → 10.4~11.1s    设 4 → 11.3~31.2s
#   设 1 → 约 21.5s                      设 8 → 24.6~42.8s
# 即线程数与耗时并非线性：这个模型是访存带宽瓶颈，线程开多了反而互相抢带宽。
# 所以默认不设置 OMP_NUM_THREADS，交给 onnxruntime 按可用核数自行决定（实测最快）。
# 只有当容器被 --cpus 限流、onnxruntime 会误判可用核数时，才需要显式指定：
#   REMBG_OMP_NUM_THREADS=4    （留空或写 auto 都表示「不设置」）
if [ -n "${REMBG_OMP_NUM_THREADS:-}" ] && [ "${REMBG_OMP_NUM_THREADS}" != "auto" ]; then
  export OMP_NUM_THREADS="${REMBG_OMP_NUM_THREADS}"
fi

# --threads 只是服务端并发推理的上限。并发跑多个请求时每个都会试图吃满全部核心，
# 结果总吞吐不升、单张延迟明显变差，所以默认取 1。
exec rembg s \
  --host 0.0.0.0 \
  --port 7000 \
  --threads "${REMBG_SERVER_CONCURRENCY:-1}" \
  --no-ui
