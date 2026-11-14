"""길안내 아이콘 만들기: 사용자가 AI(Seedream)로 그린 그림(tools/icon-src/*)을 분홍(마젠타) 배경 없이 SVG 로 딴다.

- 배경 빼기(누끼): 마젠타(255,0,255) 섞인 정도를 min(R,B) - G 로 잰다. 흰색·회색·파랑·빨강·주황 모두 이 값이 0 이하라
  배경과 섞인 가장자리도 정확히 투명도로 바뀐다. 이미 누끼를 딴 그림(알파 있음)도 남은 분홍 테두리를 같은 식으로 지운다.
- 색 나누기: 남은 화소를 아이콘마다 정해 둔 색(도로 회색·흰색·방패 파랑/빨강 …) 중 가장 가까운 색으로 나눈다.
- 따기: 색마다 경계선을 마칭 스퀘어(0.5 등고선)로 따서 RDP 로 줄이고, 꺾인 곳(화살촉 끝)은 그대로, 나머지는 곡선으로 잇는다.
- SVG 의 칠 색은 아래 팔레트에서만 나온다. 분홍에 가까운 색이 하나라도 있으면 멈춘다(분홍이 남지 않게).

출력: icons.js (window.TNC_ICONS = { 키: '<svg …>' }) — app.js 의 TURN_ICONS 를 덮어쓴다.
쓰는 법: py -X utf8 tools/build_icons.py
"""
import json
import math
import os
import sys

import numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'tools', 'icon-src')
OUT = os.path.join(ROOT, 'icons.js')

# 키 → (파일, 종류). 종류: arrow(흰 화살표 한 색 → currentColor), ramp(나가기/들어가기), toll, pin
ICONS = {
    's': ('s.webp', 'arrow'), 'l': ('l.webp', 'arrow'), 'r': ('r.webp', 'arrow'), 'u': ('u.webp', 'arrow'),
    'sl': ('sl.png', 'arrow'), 'sr': ('sr.webp', 'arrow'), 'rb': ('rb.webp', 'arrow'),
    'kl': ('kl.webp', 'arrow'), 'kr': ('kr.webp', 'arrow'),
    'outr': ('outr.webp', 'ramp'), 'outl': ('outl.webp', 'ramp'), 'inr': ('inr.webp', 'ramp'), 'inl': ('inl.webp', 'ramp'),
    'toll': ('toll.webp', 'toll'), 'goal': ('goal.webp', 'pin'), 'via': ('via.webp', 'pin'),
}
# 앱이 찾는 class (테스트·CSS 와 맞춘다)
CLASSES = {
    'kl': 'keep kl', 'kr': 'keep kr', 'outr': 'ramp out', 'outl': 'ramp out', 'inr': 'ramp in', 'inl': 'ramp in',
    'toll': 'toll', 'goal': 'pin goal', 'via': 'pin via',
}
PAL = {
    'ramp': {'dark': (49, 59, 66), 'white': (245, 247, 248), 'blue': (13, 82, 162), 'red': (228, 33, 33)},
    'toll': {'dark': (44, 52, 62), 'white': (247, 251, 252), 'blue': (2, 104, 233), 'gray': (160, 173, 184)},
}


def load(path):
    a = np.asarray(Image.open(path).convert('RGBA')).astype(np.float64)
    R, G, B, A = a[..., 0], a[..., 1], a[..., 2], a[..., 3] / 255.0
    s = np.clip((np.minimum(R, B) - G) / 255.0, 0, 1)
    s = np.clip((s - 0.05) / 0.9, 0, 1)            # 마젠타 섞인 정도 (배경 = 1)
    alpha = A * (1 - s)
    # 섞인 배경을 빼서 원래 앞쪽 색을 되살린다 (색 나누기용)
    k = np.clip(1 - s, 0.15, 1)[..., None]
    M = np.array([255.0, 0, 255.0])
    fg = np.clip((a[..., :3] - s[..., None] * M) / k, 0, 255)
    return alpha, fg


def box_blur(f, r):
    if r <= 0:
        return f
    p = np.pad(f, r, mode='edge')
    c = np.cumsum(np.cumsum(p, 0), 1)
    c = np.pad(c, ((1, 0), (1, 0)))
    n = 2 * r + 1
    H, W = f.shape
    return (c[n:n + H, n:n + W] - c[0:H, n:n + W] - c[n:n + H, 0:W] + c[0:H, 0:W]) / (n * n)


def soften(f):
    return box_blur(box_blur(f, 1), 1)


def contours(f, level):
    """마칭 스퀘어: f 의 level 등고선 → 닫힌 다각형 목록 (x, y 픽셀 좌표)"""
    f = np.pad(f, 1)
    H, W = f.shape
    b = f > level
    tl, tr, bl, br = b[:-1, :-1], b[:-1, 1:], b[1:, :-1], b[1:, 1:]
    case = tl * 8 + tr * 4 + br * 2 + bl * 1
    ii, jj = np.nonzero((case != 0) & (case != 15))

    def hpt(i, j):  # (i,j)-(i,j+1)
        a, c = f[i, j], f[i, j + 1]
        t = (level - a) / (c - a)
        return (j + t - 1, i - 1)

    def vpt(i, j):  # (i,j)-(i+1,j)
        a, c = f[i, j], f[i + 1, j]
        t = (level - a) / (c - a)
        return (j - 1, i + t - 1)

    adj = {}
    pts = {}

    def key(kind, i, j):
        k = ((i * W + j) << 1) | kind
        if k not in pts:
            pts[k] = hpt(i, j) if kind == 0 else vpt(i, j)
        return k

    def link(a, c):
        adj.setdefault(a, []).append(c)
        adj.setdefault(c, []).append(a)

    for i, j in zip(ii.tolist(), jj.tolist()):
        cs = int(case[i, j])
        T, Rr, Bm, L = (0, i, j), (1, i, j + 1), (0, i + 1, j), (1, i, j)
        crossed = []
        if tl[i, j] != tr[i, j]: crossed.append(T)
        if tr[i, j] != br[i, j]: crossed.append(Rr)
        if bl[i, j] != br[i, j]: crossed.append(Bm)
        if tl[i, j] != bl[i, j]: crossed.append(L)
        ks = {e: key(*e) for e in crossed}
        if len(crossed) == 2:
            link(ks[crossed[0]], ks[crossed[1]])
        else:  # 안장점: 가운데 값으로 정한다
            center = (f[i, j] + f[i, j + 1] + f[i + 1, j] + f[i + 1, j + 1]) / 4 > level
            if (cs == 5) == center:   # 바깥 모서리(tl·br 또는 tr·bl)를 잘라낸다
                if cs == 5:
                    link(ks[T], ks[L]); link(ks[Bm], ks[Rr])
                else:
                    link(ks[T], ks[Rr]); link(ks[L], ks[Bm])
            else:
                if cs == 5:
                    link(ks[T], ks[Rr]); link(ks[L], ks[Bm])
                else:
                    link(ks[T], ks[L]); link(ks[Bm], ks[Rr])
    seen = set()
    out = []
    for start in adj:
        if start in seen:
            continue
        loop = [start]
        seen.add(start)
        prev, cur = None, start
        while True:
            nb = adj[cur]
            nxt = nb[0] if nb[0] != prev else (nb[1] if len(nb) > 1 else nb[0])
            if nxt == start or nxt in seen:
                break
            seen.add(nxt)
            loop.append(nxt)
            prev, cur = cur, nxt
        if len(loop) >= 6:
            out.append([pts[k] for k in loop])
    return out


def rdp(points, eps):
    if len(points) < 3:
        return points
    P = np.array(points)
    a, b = P[0], P[-1]
    ab = b - a
    n = math.hypot(*ab)
    if n == 0:
        d = np.hypot(*(P - a).T)
    else:
        q = P - a
        d = np.abs(ab[0] * q[:, 1] - ab[1] * q[:, 0]) / n
    i = int(np.argmax(d))
    if d[i] > eps:
        return rdp(points[:i + 1], eps)[:-1] + rdp(points[i:], eps)
    return [points[0], points[-1]]


def simplify_closed(loop, eps):
    P = np.array(loop)
    i = 0
    j = int(np.argmax(np.hypot(*(P - P[0]).T)))
    a = rdp(loop[i:j + 1], eps)
    b = rdp(loop[j:] + loop[:1], eps)
    return a[:-1] + b[:-1]


def area(loop):
    P = np.array(loop)
    x, y = P[:, 0], P[:, 1]
    return 0.5 * abs(np.dot(x, np.roll(y, -1)) - np.dot(y, np.roll(x, -1)))


def path_d(loops, tf, corner_deg=38):
    """닫힌 다각형들 → SVG path. 꺾인 곳은 직선, 나머지는 2차 곡선으로 매끈하게"""
    out = []
    for lp in loops:
        n = len(lp)
        if n < 3:
            continue
        P = [tf(p) for p in lp]

        def mid(a, b):
            return ((a[0] + b[0]) / 2, (a[1] + b[1]) / 2)

        def sharp(i):
            a, b, c = P[i - 1], P[i], P[(i + 1) % n]
            v1 = (b[0] - a[0], b[1] - a[1])
            v2 = (c[0] - b[0], c[1] - b[1])
            n1, n2 = math.hypot(*v1), math.hypot(*v2)
            if n1 == 0 or n2 == 0:
                return True
            cosv = max(-1, min(1, (v1[0] * v2[0] + v1[1] * v2[1]) / (n1 * n2)))
            return math.degrees(math.acos(cosv)) > corner_deg

        f = lambda v: ('%.2f' % v).rstrip('0').rstrip('.')
        start = mid(P[-1], P[0])
        seg = ['M%s %s' % (f(start[0]), f(start[1]))]
        for i in range(n):
            m2 = mid(P[i], P[(i + 1) % n])
            if sharp(i):
                seg.append('L%s %sL%s %s' % (f(P[i][0]), f(P[i][1]), f(m2[0]), f(m2[1])))
            else:
                seg.append('Q%s %s %s %s' % (f(P[i][0]), f(P[i][1]), f(m2[0]), f(m2[1])))
        out.append(''.join(seg) + 'Z')
    return ''.join(out)


def trace(field, level, eps=0.7, min_area=30):
    loops = contours(field, level)
    loops = [simplify_closed(lp, eps) for lp in loops]
    return [lp for lp in loops if len(lp) >= 3 and area(lp) >= min_area]


def hexc(c):
    c = tuple(int(round(v)) for v in c)
    if c[0] > 200 and c[1] < 90 and c[2] > 200:
        raise SystemExit('분홍에 가까운 색이 나왔습니다: %s' % (c,))
    return '#%02x%02x%02x' % c


def frame(mask, pad_ratio=0.04):
    ys, xs = np.nonzero(mask)
    x0, x1, y0, y1 = xs.min(), xs.max() + 1, ys.min(), ys.max() + 1
    side = max(x1 - x0, y1 - y0) * (1 + 2 * pad_ratio)
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    return cx - side / 2, cy - side / 2, side


def make_tf(ox, oy, side, size=48.0):
    k = size / side
    return lambda p: ((p[0] - ox) * k, (p[1] - oy) * k)


def classify(fg, pal):
    names = list(pal)
    C = np.array([pal[n] for n in names], dtype=np.float64)
    d = ((fg[..., None, :] - C[None, None]) ** 2).sum(-1)
    return d.argmin(-1), names


def build_arrow(key, alpha, frm):
    tf = make_tf(*frm)
    loops = trace(soften(alpha), 0.5)
    d = path_d(loops, tf)
    return '<svg viewBox="0 0 48 48" class="ti ti-%s %s"><path fill="currentColor" stroke="none" fill-rule="evenodd" d="%s"/></svg>' % (
        key, CLASSES.get(key, ''), d)


def largest_blob(mask, cell=4):
    """가장 큰 덩어리 하나만 (4픽셀 칸으로 줄여서 이웃 칸끼리 묶는다)"""
    H, W = mask.shape
    h, w = (H + cell - 1) // cell, (W + cell - 1) // cell
    pad = np.zeros((h * cell, w * cell), bool)
    pad[:H, :W] = mask
    g = pad.reshape(h, cell, w, cell).any(axis=(1, 3))
    lab = np.zeros((h, w), int)
    best, best_n, cur = 0, 0, 0
    for y0, x0 in zip(*np.nonzero(g)):
        if lab[y0, x0]:
            continue
        cur += 1
        stack, n = [(y0, x0)], 0
        lab[y0, x0] = cur
        while stack:
            y, x = stack.pop()
            n += 1
            for yy, xx in ((y + 1, x), (y - 1, x), (y, x + 1), (y, x - 1)):
                if 0 <= yy < h and 0 <= xx < w and g[yy, xx] and not lab[yy, xx]:
                    lab[yy, xx] = cur
                    stack.append((yy, xx))
        if n > best_n:
            best, best_n = cur, n
    keep = np.repeat(np.repeat(lab == best, cell, 0), cell, 1)[:H, :W]
    return mask & keep


def region_box(mask, grow):
    # 가장자리에 흩어진 몇 화소(색이 섞인 테두리)는 빼고, 빽빽하게 모인 곳(방패·표지판)만 본다
    dense = box_blur(box_blur(mask.astype(np.float64), 6), 6) > 0.5
    if dense.any():
        # 방패의 빨강 띠·파랑 몸통처럼 가까이 붙은 덩어리는 한 덩어리로 (16px 까지 넓혀서 묶는다)
        near = box_blur(dense.astype(np.float64), 16) > 0.02
        mask = dense & largest_blob(near)
    ys, xs = np.nonzero(mask)
    m = np.zeros_like(mask)
    m[max(0, ys.min() - grow):ys.max() + grow + 1, max(0, xs.min() - grow):xs.max() + grow + 1] = True
    return m


def build_layers(key, kind, alpha, fg):
    pal = PAL[kind]
    lab, names = classify(fg, pal)
    on = alpha > 0.5
    idx = {n: i for i, n in enumerate(names)}
    cls = lambda n: (lab == idx[n]) & on
    tf = make_tf(*frame(on))
    w = lambda m: alpha * m        # 가장자리 부드러움은 투명도에서
    paths = []

    def add(mask, color, level=0.5, extra=''):
        if not mask.any():
            return
        loops = trace(soften(w(mask).astype(np.float64)), level)
        if loops:
            paths.append('<path%s fill="%s" stroke="none" fill-rule="evenodd" d="%s"/>' % (extra, hexc(color), path_d(loops, tf)))

    if kind == 'ramp':
        shield = region_box(cls('red') | cls('blue'), 24)
        road_white = cls('white') & ~shield
        road = (cls('dark') | road_white | (cls('red') & ~shield) | (cls('blue') & ~shield))
        add(road, pal['dark'], 0.45, ' class="rd"')
        add(road_white, pal['white'])
        sh = []
        add(on & shield, pal['white'], 0.45)
        add(cls('red') & shield, pal['red'])
        add(cls('blue') & shield, pal['blue'])
        body = ''.join(paths[:2])
        sh = ''.join(paths[2:])
        return '<svg viewBox="0 0 48 48" class="ti ti-%s %s">%s<g class="shield">%s</g></svg>' % (key, CLASSES[key], body, sh)
    if kind == 'toll':
        sign = region_box(cls('blue'), 10)
        posts = cls('gray') & ~sign
        road_white = cls('white') & ~sign
        road = (cls('dark') | road_white) & ~sign
        add(road, pal['dark'], 0.45, ' class="rd"')
        add(road_white, pal['white'])
        add(posts, pal['gray'])
        add(on & sign, pal['white'], 0.45)
        add(cls('blue') & sign, pal['blue'])
        return '<svg viewBox="0 0 48 48" class="ti ti-%s %s">%s</svg>' % (key, CLASSES[key], ''.join(paths))
    raise ValueError(kind)


def shade(c, k):
    """k>0 밝게(흰색 쪽으로), k<0 어둡게"""
    c = np.array(c, dtype=np.float64)
    return tuple(np.clip(c + (255 - c) * k if k > 0 else c * (1 + k), 0, 255))


def build_pin(key, alpha, fg):
    """도착·경유 핀: 사용자 그림을 따되 입체감을 준다 (2026-11-14 요청 '조금 더 3D, 명도')
    — 왼쪽 위에서 빛이 오는 둥근 그라데이션, 아래쪽 어둡게, 머리 부분 광택, 가장자리 선, 글자 밑 그림자"""
    on = alpha > 0.5
    white = on & (fg.min(-1) > 205) & (np.abs(fg[..., 0] - fg[..., 2]) < 40)
    body = on & ~white
    ys, xs = np.nonzero(body)
    y0, y1 = ys.min(), ys.max()
    top = body & (np.arange(body.shape[0])[:, None] < y0 + (y1 - y0) * 0.25)
    bot = body & (np.arange(body.shape[0])[:, None] > y0 + (y1 - y0) * 0.6)
    c_top, c_bot = fg[top].mean(0), fg[bot].mean(0)
    base = (np.array(c_top) + np.array(c_bot)) / 2
    tf = make_tf(*frame(on))
    g = 'tg-' + key
    sil = path_d(trace(soften(alpha), 0.5), tf)
    txt = path_d(trace(soften(alpha * white), 0.5, eps=0.5, min_area=12), tf)
    bx0, by0 = tf((xs.min(), y0))
    bx1, by1 = tf((xs.max(), y1))
    w, h = bx1 - bx0, by1 - by0
    # 머리(위쪽 둥근 부분) 광택: 왼쪽 위에 흰 타원
    gx, gy, grx, gry = bx0 + w * 0.36, by0 + h * 0.2, w * 0.24, h * 0.12
    return ('<svg viewBox="0 0 48 48" class="ti ti-%s %s"><defs>'
            '<radialGradient id="%s" cx="%.2f" cy="%.2f" r="%.2f" gradientUnits="userSpaceOnUse">'
            '<stop offset="0" stop-color="%s"/><stop offset=".55" stop-color="%s"/><stop offset="1" stop-color="%s"/></radialGradient>'
            '<radialGradient id="%s-gl" cx=".5" cy=".5" r=".5"><stop offset="0" stop-color="#ffffff" stop-opacity=".75"/>'
            '<stop offset="1" stop-color="#ffffff" stop-opacity="0"/></radialGradient>'
            '<clipPath id="%s-c"><path d="%s"/></clipPath></defs>'
            '<path fill="url(#%s)" stroke="%s" stroke-width=".7" stroke-opacity=".55" d="%s"/>'
            '<ellipse cx="%.2f" cy="%.2f" rx="%.2f" ry="%.2f" fill="url(#%s-gl)" clip-path="url(#%s-c)"/>'
            '<path fill="#000000" fill-opacity=".22" stroke="none" fill-rule="evenodd" transform="translate(0 .7)" d="%s"/>'
            '<path fill="#ffffff" stroke="none" fill-rule="evenodd" d="%s"/></svg>') % (
        key, CLASSES[key], g, bx0 + w * 0.35, by0 + h * 0.28, max(w, h) * 0.75,
        hexc(shade(c_top, 0.28)), hexc(base), hexc(shade(c_bot, -0.32)),
        g, g, sil, g, hexc(shade(c_bot, -0.45)), sil,
        gx, gy, grx, gry, g, g, txt, txt)


def rb_svg(key):
    """회전교차로 (2026-11-14, 사용자 요청 '네이버 지도처럼, 기업 내비 느낌'): 한 색(currentColor, 패널 초록) 글리프.
    회전교차로 고리·네 갈래 길은 옅게, 가는 길만 다른 화살표 아이콘과 같은 굵기의 굵은 화살표 + 큰 화살촉.
    아래 길 가운데로 들어와 시계 반대 방향(우측 통행)으로 돌아 나간다. 나가는 방향별 4가지: 왼쪽·직진·오른쪽·유턴"""
    exit_ = key.split('_')[1]
    cx, cy, R = 24.0, 23.0, 11.0
    f = lambda v: ('%.2f' % v).rstrip('0').rstrip('.')
    pt = lambda deg: (cx + R * math.cos(math.radians(deg)), cy + R * math.sin(math.radians(deg)))
    faint = ('<g fill="none" stroke="currentColor" stroke-opacity=".3" stroke-width="6">'
             '<circle cx="24" cy="23" r="11"/><path d="M24 34V48M24 12V0M13 23H0M35 23H48"/></g>'
             '<circle cx="24" cy="23" r="4.6" fill="currentColor" fill-opacity=".22"/>')
    if exit_ == 'u':
        start, end, large, out_dir = 74.2, 105.8 - 360, 1, (0, 1)
        x0 = 27.0
    else:
        start, x0 = 90.0, 24.0
        end, large, out_dir = {'r': (0, 0, (1, 0)), 's': (-90, 0, (0, -1)), 'l': (-180, 1, (-1, 0))}[exit_]
    p0, p1 = pt(start), pt(end)
    stem = 4.0 if exit_ != 'u' else 3.6
    se = (p1[0] + out_dir[0] * stem, p1[1] + out_dir[1] * stem)
    hl, hw = 8.6, 7.4
    tip = (se[0] + out_dir[0] * hl, se[1] + out_dir[1] * hl)
    nx, ny = -out_dir[1], out_dir[0]
    head = [tip, (se[0] + nx * hw, se[1] + ny * hw), (se[0] - nx * hw, se[1] - ny * hw)]
    path = 'M%s 47.5L%s %sA%s %s 0 %d 0 %s %sL%s %s' % (f(x0), f(p0[0]), f(p0[1]), f(R), f(R), large, f(p1[0]), f(p1[1]),
                                                       f(se[0] + out_dir[0] * 0.8), f(se[1] + out_dir[1] * 0.8))
    hd = 'M%s %sL%s %sL%s %sZ' % tuple(f(v) for q in head for v in q)
    return ('<svg viewBox="0 0 48 48" class="ti ti-%s rb">%s'
            '<path d="%s" fill="none" stroke="currentColor" stroke-width="5.4" stroke-linecap="round" stroke-linejoin="round"/>'
            '<path d="%s" fill="currentColor" stroke="currentColor" stroke-width="1" stroke-linejoin="round"/></svg>') % (key, faint, path, hd)


def ramp_svg(key):
    """나가기(OUT)·들어가기(IN) 아이콘을 사용자 그림과 같은 모양새(어두운 도로·흰 가장자리·점선 차선·흰 화살표·방패)로
    다시 그린다 (2026-11-14 요청: 딴 그림은 합류 지점이 맨 아래에 있고 직진 부분이 길어 '직진'으로 오해할 수 있다
    → 도로를 두툼하게, 합류·진출 지점을 가운데에, 직진은 짧게, 화살촉은 크게).
    오른쪽 기준으로 그리고 왼쪽은 도로만 좌우로 뒤집는다 (방패 글자는 뒤집지 않는다)"""
    out = key.startswith('out')
    left = key.endswith('l')
    dark, white, blue, red = '#313b42', '#f5f7f8', '#0d52a2', '#e42121'
    if out:
        # 본선(왼쪽 세로)에서 오른쪽 차로가 갈라져 오른쪽 위로 빠져나간다
        ramp = 'M21 35 C31 27.5 37 19 40 -1'
        arrow = 'M18.6 46 L18.6 37.5 C18.6 33.5 21.5 31 25.6 28.4 C31 24.6 35 18.6 36.6 13.4'
        head = 'M38.9 4.6 L43.5 14.6 L30.2 10.6 Z'
        sh_y, sh_txt = 32.5, 'OUT'
    else:
        # 오른쪽 아래에서 올라온 연결로가 본선 오른쪽 차로로 합류한 뒤 위로
        ramp = 'M41 49 C41 37 31 31 21 24'
        arrow = 'M40.2 46.5 C40.2 37.5 31.5 31.5 22.4 25.6 C19.7 23.8 18.6 21.6 18.6 18.6 L18.6 13.2'
        head = 'M18.6 3.2 L26.6 13.6 L10.6 13.6 Z'
        sh_y, sh_txt = 2.0, 'IN'
    road = ('<rect class="rd-edge" x="3.4" y="-1" width="21.2" height="50" fill="%s" stroke="none"/>' % white +
            '<path d="%s" fill="none" stroke="%s" stroke-width="13.6"/>' % (ramp, white) +
            '<rect class="rd" x="4.8" y="-1" width="18.4" height="50" fill="%s" stroke="none"/>' % dark +
            '<path class="rd-s" d="%s" fill="none" stroke="%s" stroke-width="10.8"/>' % (ramp, dark) +
            '<path d="M14 -1 V49" fill="none" stroke="%s" stroke-width="1.4" stroke-dasharray="4 3.6" opacity=".9"/>' % white +
            '<path d="%s" fill="none" stroke="%s" stroke-width="4.8" stroke-linecap="round" stroke-linejoin="round"/>' % (arrow, white) +
            '<path d="%s" fill="%s" stroke="%s" stroke-width="1" stroke-linejoin="round"/>' % (head, white, white))
    flip = ' transform="matrix(-1 0 0 1 48 0)"' if left else ''
    sx = 2.0 if left else 30.0   # 방패는 비어 있는 쪽 위(IN)·아래(OUT) 모서리에
    shield = ('<g class="shield" transform="translate(%.1f %.1f)">' % (sx, sh_y) +
              '<path d="M0 0.6h16v7.4c0 4.1-3.6 6.7-8 8.4-4.4-1.7-8-4.3-8-8.4z" fill="%s" stroke="#ffffff" stroke-width="1.3"/>' % blue +
              '<path d="M0.65 1.25h14.7v3.4H0.65z" fill="%s" stroke="none"/>' % red +
              '<text x="8" y="11.9" text-anchor="middle" font-size="%s" font-weight="800" fill="#ffffff" stroke="none" font-family="Pretendard, sans-serif">%s</text>' % (
                  '6.6' if out else '7.6', sh_txt) +
              '</g>')
    return '<svg viewBox="0 0 48 48" class="ti ti-%s %s"><g stroke-linecap="butt"%s>%s</g>%s</svg>' % (key, CLASSES[key], flip, road, shield)


def main():
    loaded = {k: load(os.path.join(SRC, f)) for k, (f, kind) in ICONS.items()}
    # 화살표는 모두 같은 틀(크기 비율)로: 굵기가 아이콘마다 달라지지 않게 전체를 덮는 정사각형 하나를 쓴다
    arrows = [k for k, (f, kind) in ICONS.items() if kind == 'arrow']
    union = np.zeros_like(loaded[arrows[0]][0], dtype=bool)
    for k in arrows:
        union |= loaded[k][0] > 0.5
    afrm = frame(union, 0.03)
    out = {}
    for k, (f, kind) in ICONS.items():
        alpha, fg = loaded[k]
        if kind == 'arrow':
            out[k] = build_arrow(k, alpha, afrm)
        elif kind == 'pin':
            out[k] = build_pin(k, alpha, fg)
        elif kind == 'ramp':
            out[k] = ramp_svg(k)   # 딴 그림 대신 같은 모양새로 다시 그린 것 (합류·진출이 잘 보이게)
        else:
            out[k] = build_layers(k, kind, alpha, fg)
        print('%-5s %6d bytes' % (k, len(out[k])))
    for k in ('rb_l', 'rb_s', 'rb_r', 'rb_u'):
        out[k] = rb_svg(k)   # 회전교차로 나가는 방향별 (그려 넣은 것)
        print('%-5s %6d bytes' % (k, len(out[k])))
    js = ('// 자동 생성 파일: tools/build_icons.py (사용자가 AI 로 그린 길안내 아이콘을 분홍 배경 없이 SVG 로 딴 것). 직접 고치지 말 것\n'
          'window.TNC_ICONS = ' + json.dumps(out, ensure_ascii=False, indent=0) + ';\n')
    with open(OUT, 'w', encoding='utf-8', newline='\n') as fh:
        fh.write(js)
    print('icons.js', len(js), 'bytes')


if __name__ == '__main__':
    main()
