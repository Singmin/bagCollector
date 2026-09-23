"""ONNX Runtime 内存池开关对 BiRefNet-lite 提交内存与耗时的影响。

rembg 的 CLI 不暴露 enable_cpu_mem_arena，只能通过编程方式设置，
所以这里绕过 rembg 直接构建 ORT 会话，对比两种配置。

用法:
  python scripts/diagnose-ort-memory.py --arena off
  python scripts/diagnose-ort-memory.py --arena on
"""
import argparse
import ctypes
import statistics
import time
from ctypes import wintypes

import numpy as np
import onnxruntime as ort

MODEL = (
    "C:/Users/Singmin/Desktop/code/bagcollect/bagCollection/"
    "data/rembg-models/models/birefnet-general-lite/birefnet-general-lite.onnx"
)


class PROCESS_MEMORY_COUNTERS_EX(ctypes.Structure):
    _fields_ = [
        ("cb", wintypes.DWORD),
        ("PageFaultCount", wintypes.DWORD),
        ("PeakWorkingSetSize", ctypes.c_size_t),
        ("WorkingSetSize", ctypes.c_size_t),
        ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
        ("QuotaPagedPoolUsage", ctypes.c_size_t),
        ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
        ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
        ("PagefileUsage", ctypes.c_size_t),
        ("PeakPagefileUsage", ctypes.c_size_t),
        ("PrivateUsage", ctypes.c_size_t),
    ]


_kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
_psapi = ctypes.WinDLL("psapi", use_last_error=True)
_kernel32.GetCurrentProcess.restype = wintypes.HANDLE
_kernel32.GetCurrentProcess.argtypes = []
_psapi.GetProcessMemoryInfo.argtypes = [
    wintypes.HANDLE,
    ctypes.POINTER(PROCESS_MEMORY_COUNTERS_EX),
    wintypes.DWORD,
]
_psapi.GetProcessMemoryInfo.restype = wintypes.BOOL


def mem_snapshot():
    c = PROCESS_MEMORY_COUNTERS_EX()
    c.cb = ctypes.sizeof(c)
    ok = _psapi.GetProcessMemoryInfo(_kernel32.GetCurrentProcess(), ctypes.byref(c), c.cb)
    if not ok:
        raise OSError(f"GetProcessMemoryInfo failed: {ctypes.get_last_error()}")
    return {
        "commit": c.PrivateUsage / 1048576,
        "commit_peak": c.PeakPagefileUsage / 1048576,
        "ws": c.WorkingSetSize / 1048576,
        "ws_peak": c.PeakWorkingSetSize / 1048576,
    }


def fmt(m):
    return f"提交 {m['commit']:7.0f}MB (峰值 {m['commit_peak']:7.0f}MB)  工作集 {m['ws']:6.0f}MB (峰值 {m['ws_peak']:6.0f}MB)"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--arena", choices=["on", "off"], required=True)
    ap.add_argument("--threads", type=int, default=0)
    ap.add_argument("--reps", type=int, default=3)
    args = ap.parse_args()

    opts = ort.SessionOptions()
    opts.enable_cpu_mem_arena = args.arena == "on"
    if args.threads:
        opts.intra_op_num_threads = args.threads
        opts.inter_op_num_threads = args.threads

    thread_label = args.threads if args.threads else "default"
    print(f"arena={args.arena}  intra_op={thread_label}")
    before = mem_snapshot()
    print(f"  加载前     {fmt(before)}")

    sess = ort.InferenceSession(MODEL, sess_opts=opts, providers=["CPUExecutionProvider"])
    after_load = mem_snapshot()
    print(f"  加载模型后 {fmt(after_load)}")

    spec = sess.get_inputs()[0]
    shape = [d if isinstance(d, int) else 1 for d in spec.shape]
    print(f"  模型输入   {spec.name} {shape}  ({spec.type})")
    feed = {spec.name: np.zeros(shape, dtype=np.float32)}

    times = []
    for i in range(args.reps):
        t0 = time.perf_counter()
        sess.run(None, feed)
        dt = time.perf_counter() - t0
        times.append(dt)
        snap = mem_snapshot()
        print(f"  第 {i + 1} 次推理 {dt:6.1f}s   {fmt(snap)}")

    steady = times[1:] if len(times) > 1 else times
    print(f"  => 稳态中位数 {statistics.median(steady):.1f}s  提交峰值 {mem_snapshot()['commit_peak']:.0f}MB")


if __name__ == "__main__":
    main()
