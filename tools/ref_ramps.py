"""v85 OUT/IN 아이콘(tools/build_icons.py ramp_svg 와 같은 모양)을 AI 참고 그림으로: 1024px, 마젠타 배경"""
import math
import os
import sys

from PIL import Image, ImageDraw, ImageFont

OUT_DIR = sys.argv[1]
SS = 2048          # 그린 뒤 1024 로 줄여 가장자리를 부드럽게
PAD = 84           # 1024 기준 여백
K = (SS - 2 * PAD * 2) / 48.0
O = PAD * 2
DARK, WHITE, BLUE, RED, MAG = (49, 59, 66), (245, 247, 248), (13, 82, 162), (228, 33, 33), (255, 0, 255)
FONT = 'C:/Windows/Fonts/arialbd.ttf'


def P(x, y, left):
    if left:
        x = 48 - x
    return (O + x * K, O + y * K)


def bez(p0, p1, p2, p3, n=60):
    out = []
    for i in range(n + 1):
        t = i / n
        u = 1 - t
        out.append((u**3 * p0[0] + 3 * u * u * t * p1[0] + 3 * u * t * t * p2[0] + t**3 * p3[0],
                    u**3 * p0[1] + 3 * u * u * t * p1[1] + 3 * u * t * t * p2[1] + t**3 * p3[1]))
    return out


def stroke(d, pts, w, color, left, round_=False):
    """두꺼운 선을 띠 모양 다각형으로 채운다 (짧은 선분을 이어 그리면 굽은 곳에 틈이 생긴다)"""
    q = [P(x, y, left) for x, y in pts]
    hw = w * K / 2
    L, R = [], []
    for i, c in enumerate(q):
        a, b = q[max(0, i - 1)], q[min(len(q) - 1, i + 1)]
        dx, dy = b[0] - a[0], b[1] - a[1]
        n = math.hypot(dx, dy) or 1
        nx, ny = -dy / n, dx / n
        L.append((c[0] + nx * hw, c[1] + ny * hw))
        R.append((c[0] - nx * hw, c[1] - ny * hw))
    d.polygon(L + R[::-1], fill=color)
    if round_:
        for c in (q[0], q[-1]):
            d.ellipse([c[0] - hw, c[1] - hw, c[0] + hw, c[1] + hw], fill=color)


def draw(key):
    out, left = key.startswith('out'), key.endswith('l')
    im = Image.new('RGB', (SS, SS), MAG)
    d = ImageDraw.Draw(im)
    if out:
        ramp = bez((21, 35), (31, 27.5), (37, 19), (40, -1), 120)
        arrow = [(18.6, 46)] + bez((18.6, 37.5), (18.6, 33.5), (21.5, 31), (25.6, 28.4), 20) + bez((25.6, 28.4), (31, 24.6), (35, 18.6), (36.6, 13.4), 30)
        head = [(38.9, 4.6), (43.5, 14.6), (30.2, 10.6)]
        sh_y, txt, fs = 32.5, 'OUT', 5.3
    else:
        ramp = bez((41, 49), (41, 37), (31, 31), (21, 24), 120)
        arrow = bez((40.2, 46.5), (40.2, 37.5), (31.5, 31.5), (22.4, 25.6), 30) + bez((22.4, 25.6), (19.7, 23.8), (18.6, 21.6), (18.6, 18.6), 15) + [(18.6, 13.2)]
        head = [(18.6, 3.2), (26.6, 13.6), (10.6, 13.6)]
        sh_y, txt, fs = 2.0, 'IN', 7.6
    # 도로: 흰 테두리 → 어두운 바탕 → 점선 차선 → 흰 화살표
    d.rectangle([min(P(3.4, 0, left)[0], P(24.6, 0, left)[0]), P(0, -1, left)[1], max(P(3.4, 0, left)[0], P(24.6, 0, left)[0]), P(0, 49, left)[1]], fill=WHITE)
    stroke(d, ramp, 13.6, WHITE, left)
    d.rectangle([min(P(4.8, 0, left)[0], P(23.2, 0, left)[0]), P(0, -1, left)[1], max(P(4.8, 0, left)[0], P(23.2, 0, left)[0]), P(0, 49, left)[1]], fill=DARK)
    stroke(d, ramp, 10.8, DARK, left)
    y = -1.0
    while y < 49:
        stroke(d, [(14, y), (14, min(49, y + 4))], 1.4, (225, 228, 230), left)
        y += 7.6
    stroke(d, arrow, 4.8, WHITE, left, round_=True)
    d.polygon([P(x, yy, left) for x, yy in head], fill=WHITE)
    # 방패 (뒤집지 않는다)
    sx = 2.0 if left else 30.0
    pts = []
    pts += [(0, 0.6), (16, 0.6), (16, 8.0)]
    pts += bez((16, 8.0), (16, 12.1), (12.4, 14.7), (8, 16.4), 16)[1:]
    pts += bez((8, 16.4), (3.6, 14.7), (0, 12.1), (0, 8.0), 16)[1:]
    sh = [(O + (sx + x) * K, O + (sh_y + yy) * K) for x, yy in pts]
    d.polygon(sh, fill=BLUE, outline=WHITE, width=int(1.3 * K))
    d.rectangle([O + (sx + 0.65) * K, O + (sh_y + 1.25) * K, O + (sx + 15.35) * K, O + (sh_y + 4.65) * K], fill=RED)
    f = ImageFont.truetype(FONT, int(fs * K * 1.05))
    cx, cy = O + (sx + 8) * K, O + (sh_y + 9.6) * K
    d.text((cx, cy), txt, font=f, fill='white', anchor='mm')
    im = im.resize((1024, 1024), Image.LANCZOS)
    path = os.path.join(OUT_DIR, 'ref_%s.png' % key)
    im.save(path)
    return path


for k in ('inr', 'inl', 'outr', 'outl'):
    print(draw(k))
