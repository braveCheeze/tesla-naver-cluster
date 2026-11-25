"""네이버식 분기점 그림 2판 (jx2) 밑그림 · 검사 · 색 바꾸기 (v256, 2026-11-25 부모 세션 점검표 — 운전자가 네이버 성남IC 확대 그림과
우리 그림을 나란히 보내며 '봐바 이거 안돼, 그대로 쓰는 건 아니지만 비슷하게 좀 만들어 줘')

앱이 보여 주는 것은 AI 그림뿐이다(README v245 고정 규칙). 이 파일은 AI 에게 넘길 구도 밑그림만 그린다. 1판(jx_scene.py, 3:2 낮은 띠)과 다른 점:
- 그림 비율: 정사각형으로 그리게 하고(1024×1024) 앱은 위 1/4(하늘)을 잘라 4:3 으로, 안내 카드 폭에 꽉 차게 보여 준다 (네이버처럼 키 큰 그림)
- 차로 수를 실제 길에 맞춘다: 모양 = 곧게 가는 차로 수 + 나가는 차로 수 (정밀도로지도 단면 → OSM lanes 로 앱이 고른다)
    x31 본선 3 + 출구 1          x41 본선 4 + 출구 1 (성남IC·신갈분기점 '원주 인천')
    x22 본선 2 + 출구 2          x42 본선 4 + 출구 2 (하남분기점·서하남IC·판교IC·기흥IC)
    x43 본선 4 + 출구 3 (출구 안에서 나중에 다시 갈림 — 차로 색은 앱이 차로마다: 판교분기점 서울TG 쪽 '일산 안양' 1 + '구리 성남' 2)
    s31 본선 3(경로) + 출구 1     s41 본선 4(경로) + 출구 1 (신갈분기점 '대전')
    f22 갈림길 2 + 2 (v260: 왼쪽 둘은 곧게, 오른쪽 둘이 멀리서 오른쪽으로 비킴 — 경로가 비키는 쪽) · f22k (같은 그림, 경로가 곧게 가는 쪽)
  모두 오른쪽으로 나가는 그림이고 왼쪽이면 앱이 좌우로 뒤집는다
- v258 (운전자가 성남IC 미리보기에 '오른쪽이 이런 식으로 나오는데 우린 왜 오른쪽으로 빠지도록 나와 있어', 부모 세션): 네이버 330m 그림처럼
  앞쪽은 모든 차로가 곧게 나란히(출구 차로는 차선 하나로만 나뉜 감속 차로, 화살표도 곧게), 고어는 멀리(길 바닥 위쪽 1/4), 연결로는 고어
  뒤에서야 오른쪽으로 휜다. 연결로가 다시 갈리는 곳(성남IC 2B·2A)은 그 뒤에 두 번째 갈림:
    x41s·x42s  오른쪽 가드레일 너머에 이미 갈라진 다른 연결로가 그림 가운데쯤에서 오른쪽으로 휜다 (네이버 성남IC 오른쪽의 2A 판교 연결로).
               연결로가 고어 뒤에서 다시 갈리는 것(ZS2)은 330m 에서는 지평선에 묻혀 보이지 않는다 — 판교분기점 '일산' 1 + '구리' 2 는 차로 색으로
- 같은 방향 차로 사이는 흰 점선, 갈라지는 곳(고어)과 길 가장자리는 실선. 경로 차로는 고어 너머까지 초록
- 문형 표지 틀에 빈 표지판 두 장(왼쪽 = 본선 위, 오른쪽 = 출구 위). 앱이 글자 표지(방면·화살표·나들목 번호 띠)를 얹는다
- 차로마다 아래쪽에 방면 글자 자리(앱이 굵은 흰 글씨로, 차로 폭의 1/3 높이)
결과: tools/icon-src/ref/jx2_<모양>.png (1024×1024) — gen_icons_atlas.py --icons jx2 가 낮·밤으로 그리게 한다
검사(build_ai_icons.py): 초록이 경로 차로에만 있는지, 표지판 두 장이 제자리인지. 틀리면 bad 로 적어 고를 수 없다
사용:  py -X utf8 tools\\jx_scene2.py
"""
import math
import os

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REF = os.path.join(ROOT, 'tools', 'icon-src', 'ref')
W = H = 1024
CROP = 0.25            # 앱은 위 1/4 을 잘라 4:3 으로 보여 준다 (그 위는 하늘만)
Y0 = CROP * H          # 보이는 띠의 맨 위
HZ = Y0 + 0.42 * (H - Y0)   # 지평선 (보이는 띠 42%)
CAM_H = 7.0            # 눈높이 (m)
F = 403.0              # 초점 (px) — 라벨 줄(Z≈8m)에서 차로 여섯이 보이게
LW = 3.6               # 차로 폭 (m)
ZS = 29.0              # 고어 (갈라지는 곳, m) — v258: 앞쪽은 곧게, 고어는 길 바닥 높이의 22% (지평선에서). 네이버 330m 그림:
                       #   하남JC 26% · 서하남IC 30% · 판교JC 27% · 신갈JC 19% · 성남IC 5% (성남IC 만 지평선 가까이)
ZS2 = 72.0             # 연결로가 다시 갈리는 곳 (x42s·x43s)
Z0, Z1 = F * CAM_H / (H - HZ), 900.0

# 표지판 두 장 (그림 비율 x0, y0, x1, y1 — 정사각형 기준). 앱(app.js JX2_BOARD)은 보이는 띠 기준으로 바꿔 쓴다
BOARD_L = (0.08, 0.335, 0.47, 0.515)
BOARD_R = (0.53, 0.335, 0.92, 0.515)
BEAM = (0.03, 0.300, 0.97, 0.330)

# 갈래마다 휘는 항 [(a, k, 시작 Z)]: 옆 이동 = Σ a·d + k·d² (d = Z - 시작). 본선(0)은 곧게.
#   1 = 연결로 (고어 ZS 뒤에서 오른쪽으로), 2 = 연결로가 ZS2 에서 다시 갈려 더 오른쪽으로,
#   3 = 이미 갈라져 오른쪽에 따로 가는 다른 연결로 (네이버 성남IC 오른쪽의 2A 판교 연결로) — 그림 가운데쯤에서 오른쪽으로 휜다
RAMP = (0.15, 0.012, ZS)   # 고어 뒤 연결로가 그림 위쪽 가운데쯤에서 오른쪽으로 휘어 오른쪽 끝으로
EXIT_BEND = {0: [], 1: [RAMP], 2: [RAMP, (0.40, 0.020, ZS2)], 3: [(0.9, 0.04, 20.0)]}


def _exit(T, E, go_exit=True, lz=8.0, split=None):
    """본선 T + 출구 E. 차로 묶음 가운데가 카메라(X=0) 가까이 오게.
    split: None | 'side' (오른쪽에 이미 갈라진 다른 연결로 하나 — 칠 안 함)
           | ('half', k, 'stop'|'all') (출구 차로가 ZS2 에서 왼쪽 k 차로 · 나머지로 다시 갈림. 'stop' 은 칠을 ZS2 까지만 — 어느 갈래가 경로인지 그림에 정하지 않는다)"""
    b = (T - E) * LW / 2.0
    lanes = [(b - (T - i) * LW, b - (T - i - 1) * LW, 0) for i in range(T)]
    sh = {'bend': EXIT_BEND, 'lz': lz, 'paint_to': Z1}
    if split and split[0] == 'half':
        k = split[1]
        lanes += [(b + i * LW, b + (i + 1) * LW, 1 if i < k else 2) for i in range(E)]
        sh['go'] = (1, 2) if go_exit else (0,)
        if split[2] == 'stop':
            sh['paint_to'] = ZS2
    else:
        lanes += [(b + i * LW, b + (i + 1) * LW, 1) for i in range(E)]
        sh['go'] = (1,) if go_exit else (0,)
        if split == 'side':
            x = b + E * LW + 5.0   # 가드레일 너머 (출구 차로와 떨어져)
            lanes.append((x, x + LW, 3, 14.0))   # 앞쪽 차로 수·글자에 넣지 않는다 — 출구 연결로보다 먼저 오른쪽으로 빠진다
    sh['lanes'] = lanes
    return sh


SHAPES = {
    'x31': _exit(3, 1),
    'x41': _exit(4, 1),
    'x41s': _exit(4, 1, split='side'),
    'x22': _exit(2, 2),
    'x42': _exit(4, 2, lz=8.6),
    'x42s': _exit(4, 2, lz=8.6, split='side'),
    'x43': _exit(4, 3, lz=9.6),
    's31': _exit(3, 1, go_exit=False),
    's41': _exit(4, 1, go_exit=False),
    # 일반도로 갈림길 2 + 2 (v260, 부모 세션 — 네이버 서하남교차로): 대칭 Y 가 아니다. 왼쪽 두 차로는 지평선까지 곧게, 오른쪽 두 차로는
    #   곧게 가다가 멀리서야 오른쪽으로 비킨다. 두 무리 사이는 점선. 경로가 비키는 쪽이면 f22, 곧게 가는 쪽이면 f22k (왼쪽으로 비키면 앱이 뒤집는다)
    'f22': {'lanes': [(-7.2, -3.6, 0), (-3.6, 0, 0), (0, 3.6, 1), (3.6, 7.2, 1)], 'go': (1,), 'bend': EXIT_BEND, 'lz': 8.0, 'paint_to': Z1, 'city': True},
    'f22k': {'lanes': [(-7.2, -3.6, 0), (-3.6, 0, 0), (0, 3.6, 1), (3.6, 7.2, 1)], 'go': (0,), 'bend': EXIT_BEND, 'lz': 8.0, 'paint_to': Z1, 'city': True},
}
GO_N = {k: sum(1 for ln in v['lanes'] if ln[2] in v['go'] and len(ln) < 4) for k, v in SHAPES.items()}


def lane_za(ln):
    return ln[3] if len(ln) > 3 else None


def proj(X, Z):
    return (W / 2 + F * X / Z, HZ + F * CAM_H / Z)


def shift(Z, side, sh):
    out = 0.0
    for a, k, z0 in sh['bend'].get(side, ()):
        if Z > z0:
            d = Z - z0
            out += a * d + k * d * d
    return out


def zs():
    out, z = [], Z0
    while z < Z1:
        out.append(z)
        z *= 1.03
    return out + [Z1]


def strip(x0, x1, side, sh, za=None, zb=Z1):
    za = Z0 if za is None else za
    Zs = [za] + [z for z in zs() if za < z < zb] + [zb]
    L = [proj(x0 + shift(z, side, sh), z) for z in Zs]
    R = [proj(x1 + shift(z, side, sh), z) for z in Zs]
    return L + R[::-1]


def lane_line(x, side, sh, dashed, d, col, wid=0.15, za=None, zb=400):
    za = Z0 if za is None else za
    while za < zb:
        z2 = za + (3.0 if dashed else zb)
        d.polygon(strip(x - wid, x + wid, side, sh, za, min(z2, Z1)), fill=col)
        za += 9.0 if dashed else zb


def arrow_poly(cx, side, sh, z0, z1, turn):
    body, n = 0.28, 14
    zz = [z0 + (z1 - z0) * i / n for i in range(n + 1)]
    cxs = [cx + shift(z, side, sh) + (turn * 1.0 * ((z - z0) / (z1 - z0)) ** 2) for z in zz]
    zh = z0 + (z1 - z0) * 0.62
    Lb = [proj(c - body, z) for c, z in zip(cxs, zz) if z <= zh]
    Rb = [proj(c + body, z) for c, z in zip(cxs, zz) if z <= zh]
    ch = cx + shift(zh, side, sh) + turn * 1.0 * 0.62 ** 2
    head = [proj(ch - 0.9, zh), proj(cxs[-1], z1), proj(ch + 0.9, zh)]
    return Lb + head + Rb[::-1]


def lane_groups(sh):
    """갈래별 (왼쪽 X, 오른쪽 X, 시작 Z)"""
    g = {}
    for ln in sh['lanes']:
        x0, x1, s = ln[:3]
        za = lane_za(ln) or Z0
        a, b, z = g.get(s, (x0, x1, za))
        g[s] = (min(a, x0), max(b, x1), min(z, za))
    return g


def draw_base(name):
    sh = SHAPES[name]
    im = Image.new('RGB', (W, H))
    d = ImageDraw.Draw(im)
    for y in range(int(HZ)):
        t = y / HZ
        d.line([(0, y), (W, y)], fill=(int(110 + 110 * t), int(165 + 70 * t), int(232 + 18 * t)))
    d.rectangle([0, HZ, W, H], fill=(128, 170, 96))
    for x, w, h in [(30, 110, 70), (160, 90, 45), (720, 130, 85), (870, 80, 55), (960, 60, 75)]:
        d.rectangle([x, HZ - h, x + w, HZ], fill=(205, 210, 218))
    groups = lane_groups(sh)
    asphalt, green, white = (74, 79, 87), (0, 178, 80), (250, 250, 250)
    zs0 = sh.get('zs', ZS)
    # 갈래마다 길 바닥 (어깨 0.8m) — 갈래가 시작하는 곳(ZS2 에서 생기는 갈래)부터
    for s, (x0, x1, za) in groups.items():
        d.polygon(strip(x0 - 0.8, x1 + 0.8, s, sh, za), fill=asphalt)
    fg = [g for g in groups.values() if g[2] <= Z0 + 0.01]
    allx0 = min(g[0] for g in fg); allx1 = max(g[1] for g in fg)
    d.polygon(strip(allx0 - 0.8, allx1 + 0.8, 0, sh, Z0, zs0), fill=asphalt)   # 고어 앞은 한 판 (모든 차로가 곧게 나란히)
    go = sh['go']
    for ln in sh['lanes']:
        x0, x1, s = ln[:3]
        if s in go and not lane_za(ln):
            d.polygon(strip(x0 + 0.15, x1 - 0.15, s, sh, Z0, sh['paint_to']), fill=green)
    # 차선: 길 가장자리·갈래 경계(고어 뒤)는 실선, 같은 갈래 안은 점선, 고어 앞 갈래 경계(본선 | 출구)는 굵은 점선
    # v260: 두 갈래가 맞닿은 경계(본선 | 출구, 갈림길 두 무리 사이)는 고어 전까지 굵은 점선뿐 — 실선은 고어부터 (네이버 성남IC·서하남교차로)
    shared = set()
    for s1, (a0, a1, _za) in groups.items():
        for s2, (b0, b1, _zb) in groups.items():
            if s1 != s2 and abs(a1 - b0) < 0.01:
                shared.add((s1, 'r')); shared.add((s2, 'l'))
    for s, (x0, x1, za) in groups.items():
        lane_line(x0, s, sh, False, d, white, 0.16, zs0 if (s, 'l') in shared else za)
        lane_line(x1, s, sh, False, d, white, 0.16, zs0 if (s, 'r') in shared else za)
    for i, ln in enumerate(sh['lanes'][1:], 1):
        x0, x1, s = ln[:3]
        ps = sh['lanes'][i - 1][2]
        if lane_za(ln):
            continue
        if ps == s:
            lane_line(x0, s, sh, True, d, white, 0.13)
        elif ps == 0 or s == 0:
            lane_line(x0, 0, sh, True, d, white, 0.2, Z0, zs0)
        else:
            lane_line(x0, 1, sh, True, d, white, 0.13, Z0, ZS2)   # 출구 안 두 무리: 다시 갈리기 전까지는 같은 연결로
    # 노면 화살표: 앞쪽은 모두 곧게 (네이버 330m — 출구 차로도 아직 감속 차로)
    for ln in sh['lanes']:
        if lane_za(ln):
            continue
        x0, x1, s = ln[:3]
        d.polygon(arrow_poly((x0 + x1) / 2, s, sh, 10.2, 14.5, 0), fill=white)
    gray = (120, 128, 138)
    d.rectangle([BEAM[0] * W, BEAM[1] * H, BEAM[2] * W, BEAM[3] * H], fill=gray)
    d.rectangle([0.035 * W, BEAM[1] * H, 0.055 * W, HZ + 40], fill=gray)
    d.rectangle([0.945 * W, BEAM[1] * H, 0.965 * W, HZ + 40], fill=gray)
    for bx in (BOARD_L, BOARD_R):
        x0, y0, x1, y1 = bx[0] * W, bx[1] * H, bx[2] * W, bx[3] * H
        d.rounded_rectangle([x0, y0, x1, y1], radius=10, fill=(11, 122, 67))
        d.rounded_rectangle([x0 + 7, y0 + 7, x1 - 7, y1 - 7], radius=6, outline=(255, 255, 255), width=4)
    return im


def vis_y(y):
    """정사각형 y(px) → 보이는 4:3 띠의 비율"""
    return (y - Y0) / (H - Y0)


def lane_anchors(name):
    """차로마다 방면 글자 자리: [x 비율, 보이는 띠 y 비율, 경로 차로 1/0, 차로 폭(그림 폭 비율), 기울기(°, CSS skewX)] — 그림 안(2%~98%)만"""
    sh = SHAPES[name]
    z = sh['lz']
    out = []
    for ln in sh['lanes']:
        if lane_za(ln):
            continue
        x0, x1, s = ln[:3]
        cx = (x0 + x1) / 2 + shift(z, s, sh)
        p = proj(cx, z)
        fx = p[0] / W
        w = (proj(x1 + shift(z, s, sh), z)[0] - proj(x0 + shift(z, s, sh), z)[0]) / W
        ang = math.degrees(math.atan(cx / CAM_H))
        if 0.02 <= fx <= 0.98:
            out.append([round(fx, 3), round(vis_y(p[1]), 3), 1 if s in sh['go'] else 0, round(w, 3), round(ang, 1)])
    return out


def boards_vis():
    """표지판 두 장 → 보이는 띠 비율 (x0, y0, x1, y1)"""
    return [[b[0], round(vis_y(b[1] * H), 3), b[2], round(vis_y(b[3] * H), 3)] for b in (BOARD_L, BOARD_R)]


def masks(name):
    sh = SHAPES[name]
    mg = Image.new('L', (W, H)); mo = Image.new('L', (W, H))
    dg, do = ImageDraw.Draw(mg), ImageDraw.Draw(mo)
    for ln in sh['lanes']:
        if lane_za(ln):
            continue
        x0, x1, s = ln[:3]
        poly = strip(x0 + 0.7, x1 - 0.7, s, sh, Z0, 45.0)
        (dg if s in sh['go'] else do).polygon(poly, fill=255)
    a = np.array(mg) > 0; b = np.array(mo) > 0
    cut = int(HZ + 0.12 * (H - HZ))
    a[:cut] = False; b[:cut] = False
    return a, b


OUTER = 3.6   # v262: 바깥쪽(옆에 다른 차로가 없는 쪽)은 차로 하나 폭만큼 더 — AI 가 경로 차로를 밑그림보다 바깥으로 넓게 칠하는 일이 있다 (f22k 낮 왼쪽 초록 쐐기)


def _outer(sh, x0, x1):
    """이 차로 왼쪽·오른쪽에 다른 차로(앞쪽)가 있는가 → 바깥으로 넓힐 폭 (왼쪽, 오른쪽)"""
    fg = [ln for ln in sh['lanes'] if not lane_za(ln)]
    left = any(ln[1] <= x0 + 0.01 for ln in fg if ln[0] < x0 - 0.01)
    right = any(ln[0] >= x1 - 0.01 for ln in fg if ln[1] > x1 + 0.01)
    return (0.35 if left else OUTER), (0.35 if right else OUTER)


def route_region(name, size=(W, H)):
    sh = SHAPES[name]
    m = Image.new('L', (W, H))
    d = ImageDraw.Draw(m)
    for ln in sh['lanes']:
        x0, x1, s = ln[:3]
        if s in sh['go'] and not lane_za(ln):
            el, er = _outer(sh, x0, x1)
            d.polygon(strip(x0 - el, x1 + er, s, sh, Z0, sh['paint_to']), fill=255)
    if size != (W, H):
        m = m.resize(size, Image.NEAREST)
    return np.array(m) > 0


LANE_HUE = {'b': 196, 'p': 329}
LANE_SV = {'b': (0.85, 1.32), 'p': (0.62, 1.3)}
TOP = (HZ - 10) / H    # 이 위(하늘·표지판)는 색을 바꾸지 않는다


def _paint(a):
    r, g, b = a[..., 0].astype(int), a[..., 1].astype(int), a[..., 2].astype(int)
    p = (g > 110) & (g - r > 70) & (g - b > 35)
    p[: int(TOP * a.shape[0])] = False
    return p


def _apply(hsv, mask, c, rgb):
    if c == 'n':
        # 경로가 아닌 차로(버스전용차로)로: 초록 칠을 아스팔트 회색으로 (밝기는 낮춘다)
        rgb[mask] = (np.array([78, 83, 91]) * (0.65 + 0.35 * hsv[..., 2][mask, None] / 255.0)).astype(np.uint8)
        return
    hsv[..., 0][mask] = int(LANE_HUE[c] / 360 * 255)
    ks, kv = LANE_SV[c]
    for ch, f in ((1, ks), (2, kv)):
        v = hsv[..., ch].astype(float)
        v[mask] = np.minimum(255, v[mask] * f)
        hsv[..., ch] = v.astype(np.uint8)


def recolor(im, name, c):
    a = np.asarray(im.convert('RGB'))
    reg = Image.fromarray((route_region(name, im.size) * 255).astype(np.uint8), 'L')
    k = max(3, int(im.size[0] * 0.05) | 1)
    reg = np.array(reg.filter(ImageFilter.MaxFilter(k))) > 0
    mask = reg & _paint(a)
    hsv = np.array(im.convert('RGB').convert('HSV'))
    _apply(hsv, mask, c, None)
    return Image.fromarray(hsv, 'HSV').convert('RGB')


def lane_region(name, k, size=(W, H)):
    sh = SHAPES[name]
    go = [ln for ln in sh['lanes'] if ln[2] in sh['go'] and not lane_za(ln)]
    x0, x1, s = go[k][:3]
    m = Image.new('L', (W, H))
    d = ImageDraw.Draw(m)
    el, er = _outer(sh, x0, x1)
    d.polygon(strip(x0 - (el if k == 0 else 0.0), x1 + (er if k == len(go) - 1 else 0.0), s, sh, Z0, sh['paint_to']), fill=255)
    if size != (W, H):
        m = m.resize(size, Image.NEAREST)
    return m


def recolor_lanes(im, name, cols):
    """경로 차로마다 색 (뒤집기 전 왼쪽부터 'g'|'p'|'b'|'n'): 판교분기점 '일산' 녹색 1 + '구리' 분홍 2 = 'gpp', 신갈분기점 '대전' 버스전용차로 'nbbb'"""
    out = im.convert('RGB')
    a = np.asarray(out)
    paint = _paint(a)
    hsv = np.array(out.convert('HSV'))
    kk = max(3, int(im.size[0] * 0.05) | 1)
    full = np.array(Image.fromarray((route_region(name, im.size) * 255).astype(np.uint8), 'L').filter(ImageFilter.MaxFilter(kk))) > 0
    regs = [np.array(lane_region(name, k, im.size)) > 0 for k in range(len(cols))]
    xs = np.arange(im.size[0])[None, :].repeat(im.size[1], 0)
    cx = [xs[rg].mean() if rg.any() else 0 for rg in regs]
    grey = []
    for k, c in enumerate(cols):
        if c == 'g':
            continue
        own = regs[k] | (full & ~np.any(regs, axis=0) & (np.abs(xs - cx[k]) <= np.min([np.abs(xs - x) for x in cx], axis=0)))
        mask = own & paint
        if c == 'n':
            grey.append(mask)
            continue
        _apply(hsv, mask, c, None)
    res = np.array(Image.fromarray(hsv, 'HSV').convert('RGB'))
    for mask in grey:
        v = np.asarray(out.convert('HSV'))[..., 2][mask].astype(float)
        res[mask] = (np.array([78, 83, 91])[None, :] * (0.7 + 0.3 * v[:, None] / 255.0)).astype(np.uint8)
    return Image.fromarray(res)


def is_green(rgb):
    r, g, b = rgb[..., 0].astype(int), rgb[..., 1].astype(int), rgb[..., 2].astype(int)
    return (g > 60) & (g - r > 35) & (g - b > 12)


def check(path, name):
    """AI 그림이 구도를 지켰는지: (ok, 이유, 경로 초록 비율, 다른 차로 초록 비율)"""
    im = Image.open(path).convert('RGB').resize((W, H), Image.BILINEAR)
    a = np.asarray(im)
    gr = is_green(a)
    mg, mo = masks(name)
    go = gr[mg].mean() if mg.any() else 0
    ot = gr[mo].mean() if mo.any() else 0
    why = []
    if go < 0.45:
        why.append('경로 차로 초록 %.0f%%' % (go * 100))
    if ot > 0.12:
        why.append('다른 차로에 초록 %.0f%%' % (ot * 100))
    for nm, bx in (('왼쪽', BOARD_L), ('오른쪽', BOARD_R)):
        x0, y0, x1, y1 = int(bx[0] * W), int(bx[1] * H), int(bx[2] * W), int(bx[3] * H)
        inner = gr[y0 + 18:y1 - 18, x0 + 22:x1 - 22]
        if inner.mean() < 0.35:
            why.append('%s 표지판 자리 초록 %.0f%%' % (nm, inner.mean() * 100))
    return (not why, ', '.join(why), round(float(go), 2), round(float(ot), 2))


def main():
    os.makedirs(REF, exist_ok=True)
    for name in SHAPES:
        p = os.path.join(REF, 'jx2_%s.png' % name)
        draw_base(name).save(p)
        ok, why, go, ot = check(p, name)
        print('%-4s → %s  (밑그림 검사 %s %s, 경로 %.2f 다른 %.2f)' % (name, os.path.relpath(p, ROOT), 'OK' if ok else '✗', why, go, ot))
        print('      차로 글자', lane_anchors(name))
    print('표지판(보이는 띠)', boards_vis())


if __name__ == '__main__':
    main()
