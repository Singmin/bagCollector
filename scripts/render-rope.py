# -*- coding: utf-8 -*-
"""渲染小程序首页挂绳 PNG（替代 SVG，规避微信 image 对 SVG 的留白渲染）。

曲线与 h5-prototype 一致：M0,6 Q200,52 400,6（viewBox 400x40，端点画到画布外保证满宽）。
输出 1600x160 透明 PNG（= viewBox 400x40 的 4 倍，2 倍超采样后缩小抗锯齿）。
"""
from PIL import Image, ImageDraw

S = 4          # viewBox -> 像素倍率
SS = 2         # 超采样倍率
W, H = 400 * S, 40 * S
P0 = (0.0, 6.0)
P1 = (200.0, 52.0)
P2 = (400.0, 6.0)

def bez(t):
    u = 1 - t
    return (u * u * P0[0] + 2 * u * t * P1[0] + t * t * P2[0],
            u * u * P0[1] + 2 * u * t * P1[1] + t * t * P2[1])

# 细采样整条曲线
N = 400
pts = [bez(i / N) for i in range(N + 1)]
# 弧长表（用于虚线沿路径分布）
acc = [0.0]
for a, b in zip(pts, pts[1:]):
    acc.append(acc[-1] + ((b[0] - a[0]) ** 2 + (b[1] - a[1]) ** 2) ** 0.5)
total = acc[-1]

img = Image.new("RGBA", (W * SS, H * SS), (0, 0, 0, 0))
d = ImageDraw.Draw(img)

def to_px(p):
    return (p[0] * S * SS, p[1] * S * SS)

# 主线：深棕
core_w = 3 * S * SS
d.line([to_px(p) for p in pts], fill=(138, 106, 63, 255), width=core_w, joint="curve")
for p in (pts[0], pts[-1]):
    x, y = to_px(p)
    r = core_w / 2
    d.ellipse((x - r, y - r, x + r, y + r), fill=(138, 106, 63, 255))

# 扭纹：浅麻色虚线（沿弧长 dash 1.6 / gap 3.2 viewBox 单位）
twist_w = max(2, round(1.7 * S * SS))
dash, gap = 1.6 * S * SS, 3.2 * S * SS
period = dash + gap
seg: list[tuple[float, float]] = []
on = False
seg_start = 0.0
s = 0.0
while s < total:
    if not on:
        seg_start = s
        on = True
    s_next = min(s + dash, total) if on else s
    if on:
        seg.append((seg_start, s_next))
        s = s_next + gap
    else:
        s += period
# 上面循环逻辑偏绕，直接重写：
seg = []
s = 0.0
while s < total:
    seg.append((s, min(s + dash, total)))
    s += period

def point_at(target):
    lo, hi = 0, len(acc) - 1
    while lo < hi:
        mid = (lo + hi) // 2
        if acc[mid] < target:
            lo = mid + 1
        else:
            hi = mid
    i = max(1, lo)
    a, b = pts[i - 1], pts[i]
    span = acc[i] - acc[i - 1] or 1.0
    k = (target - acc[i - 1]) / span
    return (a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k)

for s0, s1 in seg:
    sub = [point_at(v) for v in [s0 + (s1 - s0) * i / 12 for i in range(13)]]
    d.line([to_px(p) for p in sub], fill=(220, 199, 155, 255), width=twist_w, joint="curve")

img = img.resize((W, H), Image.LANCZOS)
out = r"C:\Users\Singmin\Desktop\code\bagcollect\bagCollection\apps\miniapp\src\static\figma\rail-rope.png"
img.save(out)
print("saved", out, img.size)
