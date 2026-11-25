"""네이버식 분기점 그림(jx) 밑그림 · 검사 (2026-11-25 운전자 '그냥 네이버지도처럼 만들어 달라니까, 자바스크립트로 그리지 말고 AI로 —
헷갈리고 방향 잘못 틀어서 사고 날 것 같아')

앱이 보여 주는 것은 AI 그림뿐이다(README v245 고정 규칙). 이 파일은 AI 에게 넘길 '구도 밑그림'만 그린다:
차로 수, 어느 쪽으로 갈라지는지, 가야 할 차로(초록), 문형 표지 틀의 표지판 두 장 자리. AI(편집 모델)가 이 구도를 지킨 채
네이버 분기점 확대 그림처럼 입체로 다시 그리고, 앱은 표지판 자리에 글자 표지(방면·화살표)를 얹는다.

- 모양(오른쪽으로 가는 그림 하나씩. 왼쪽이면 앱이 좌우로 뒤집는다):
    exit   본선 3차로 직진 + 오른쪽 1차로 출구 — 출구가 경로 (IC 나가기, 일반도로에서 연결로로)
    exit2  본선 2차로 직진 + 오른쪽 2차로 출구 — 출구가 경로 (분기점에서 큰 연결로로)
    stay   본선 3차로 직진 + 오른쪽 1차로 출구 — 본선이 경로 (갈림길에서 본선 그대로)
    fork   4차로가 2 + 2 로 갈라짐 — 오른쪽 갈래가 경로
- 결과: tools/icon-src/ref/jx_<모양>.png (1536×1024, 3:2) — gen_icons_atlas.py --icons jx 가 낮·밤 두 장씩 그리게 한다
- 검사(build_ai_icons.py 가 부른다): AI 그림에서 초록이 경로 차로에 있고 다른 차로에는 없는지, 표지판 두 장이 제자리에 있는지.
  틀리면 manifest 에 bad 로 적어 관리 페이지에서 고를 수 없다 (방향이 틀린 그림은 절대 쓰지 않는다)
- 사용:  py -X utf8 tools\jx_scene.py      (밑그림 다시 그리기)
"""
import math
import os

import numpy as np
from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
REF = os.path.join(ROOT, 'tools', 'icon-src', 'ref')
W, H = 1536, 1024
HZ = 0.40 * H          # 지평선
CAM_H = 7.5            # 눈높이 (m): 조금 위에서 내려다본다 (네이버 그림처럼)
F = (H - HZ) * 8.0 / CAM_H   # Z=8m 가 그림 맨 아래
LW = 3.6               # 차로 폭 (m)
ZS = 17.0              # 갈라지는 곳 (m): 그림 높이 68% 쯤
Z0, Z1 = 7.2, 900.0

# 표지판 두 장 (그림에 대한 비율 x0, y0, x1, y1). 앱(app.js JX_LAYOUT)과 같은 값
BOARD_L = (0.12, 0.10, 0.49, 0.34)
BOARD_R = (0.51, 0.10, 0.88, 0.34)
# 노면 글자 자리 (경로 차로 가운데 Z=10m) 는 모양마다 SHAPES[..]['text'] 에

# 모양: lanes = [(왼쪽 X, 오른쪽 X, 갈래)], 갈래: 0 본선 직진, 1 오른쪽으로 휨, -1 왼쪽으로 휨. go = 칠할 갈래
# bend = 갈래마다 (곧게 비키는 정도 a, 휘는 정도 k): 갈라진 뒤 옆 이동 = a·d + k·d² (d = Z - ZS). 카메라는 두 갈래 사이를 보므로
# 본선도 살짝 왼쪽으로 비켜 소실점이 가운데보다 왼쪽(네이버 그림처럼 가운데가 갈라지는 곳)
EXIT_BEND = {0: (-0.15, 0.0), 1: (0.0, 0.03)}
SHAPES = {
    'exit':  {'lanes': [(-10.8, -7.2, 0), (-7.2, -3.6, 0), (-3.6, 0, 0), (0, 3.6, 1)], 'go': 1, 'bend': EXIT_BEND},
    'exit2': {'lanes': [(-7.2, -3.6, 0), (-3.6, 0, 0), (0, 3.6, 1), (3.6, 7.2, 1)], 'go': 1, 'bend': {0: (-0.15, 0.0), 1: (0.0, 0.024)}},
    # 2026-11-25 운전자 성남IC·판교분기점·신갈분기점 네이버 그림이 모두 본선 4차로 + 출구 1차로 ('일산 일산 일산 일산 | 성남')
    'exit4': {'lanes': [(-10.8, -7.2, 0), (-7.2, -3.6, 0), (-3.6, 0, 0), (0, 3.6, 0), (3.6, 7.2, 1)], 'go': 1, 'bend': EXIT_BEND},
    'stay':  {'lanes': [(-10.8, -7.2, 0), (-7.2, -3.6, 0), (-3.6, 0, 0), (0, 3.6, 1)], 'go': 0, 'bend': EXIT_BEND},
    'fork':  {'lanes': [(-7.2, -3.6, -1), (-3.6, 0, -1), (0, 3.6, 1), (3.6, 7.2, 1)], 'go': 1, 'bend': {-1: (-0.2, -0.006), 1: (0.05, 0.016)}},
}


def proj(X, Z):
    return (W / 2 + F * X / Z, HZ + F * CAM_H / Z)


def shift(Z, side, sh):
    """갈래의 옆 이동 (m): 갈라지는 곳(ZS) 뒤로 포물선"""
    if Z <= ZS or side not in sh['bend']:
        return 0.0
    a, k = sh['bend'][side]
    d = Z - ZS
    return a * d + k * d * d


def zs():
    out, z = [], Z0
    while z < Z1:
        out.append(z)
        z *= 1.035
    return out + [Z1]


def strip(x0, x1, side, sh, za=Z0, zb=Z1):
    """땅 위 띠 (X 범위 x0..x1, 갈래 side) → 화면 다각형"""
    Zs = [za] + [z for z in zs() if za < z < zb] + [zb]
    L = [proj(x0 + shift(z, side, sh), z) for z in Zs]
    R = [proj(x1 + shift(z, side, sh), z) for z in Zs]
    return L + R[::-1]


def lane_line(x, side, sh, dashed, d, col, wid=0.18):
    za = Z0
    while za < 400:
        zb = za + (4.0 if dashed else 400)
        d.polygon(strip(x - wid, x + wid, side, sh, za, min(zb, Z1)), fill=col)
        za += 10.0 if dashed else 400


def arrow_poly(cx, side, sh, z0, z1, turn):
    """노면 화살표 (땅 위): 몸통 + 화살촉. turn: 0 직진, 1 오른쪽으로 꺾임"""
    pts = []
    body = 0.30
    n = 14
    zz = [z0 + (z1 - z0) * i / n for i in range(n + 1)]
    cxs = [cx + shift(z, side, sh) + (turn * 1.1 * ((z - z0) / (z1 - z0)) ** 2) for z in zz]
    zh = z0 + (z1 - z0) * 0.62
    Lb = [proj(c - body, z) for c, z in zip(cxs, zz) if z <= zh]
    Rb = [proj(c + body, z) for c, z in zip(cxs, zz) if z <= zh]
    ch = cx + shift(zh, side, sh) + turn * 1.1 * 0.62 ** 2
    tip = proj(cxs[-1], z1)
    head = [proj(ch - 0.95, zh), tip, proj(ch + 0.95, zh)]
    pts = Lb + [head[0], head[1], head[2]] + Rb[::-1]
    return pts


def lane_groups(sh):
    """갈래별 (왼쪽 X, 오른쪽 X)"""
    g = {}
    for x0, x1, s in sh['lanes']:
        a, b = g.get(s, (x0, x1))
        g[s] = (min(a, x0), max(b, x1))
    return g


def draw_base(name):
    sh = SHAPES[name]
    im = Image.new('RGB', (W, H))
    d = ImageDraw.Draw(im)
    # 하늘·땅
    for y in range(int(HZ)):
        t = y / HZ
        d.line([(0, y), (W, y)], fill=(int(120 + 100 * t), int(175 + 60 * t), int(235 + 15 * t)))
    d.rectangle([0, HZ, W, H], fill=(128, 170, 96))
    # 먼 건물 (자리만)
    for i, (x, w, h) in enumerate([(40, 150, 90), (210, 120, 60), (1080, 170, 110), (1270, 110, 70), (1390, 140, 95)]):
        d.rectangle([x, HZ - h, x + w, HZ], fill=(205, 210, 218))
    groups = lane_groups(sh)
    asphalt, green, white = (74, 79, 87), (0, 178, 80), (250, 250, 250)
    # 길 바닥 (갈래마다, 어깨 0.8m)
    for s, (x0, x1) in groups.items():
        d.polygon(strip(x0 - 0.8, x1 + 0.8, s, sh), fill=asphalt)
    # 갈라지는 곳 앞은 한 판
    allx0 = min(x0 for x0, _ in groups.values()); allx1 = max(x1 for _, x1 in groups.values())
    d.polygon(strip(allx0 - 0.8, allx1 + 0.8, 0, sh, Z0, ZS), fill=asphalt)
    # 갈라진 틈(갈래 사이) 빗금은 밑그림에 그리지 않는다 (2026-11-25 운전자가 갈림 바로 뒤 짧은 흰 가로 막대에 '?' — 빗금 한 줄이
    # 갈래 사이를 가로질러 이상한 선처럼 보였다). 빗금은 AI 가 갈래 사이에 그리게 글로만 시킨다 (JX_EDIT 'white chevron hatching in the gore')
    keys = []
    for a, b in zip(keys, keys[1:]):
        xa, xb = groups[a][1], groups[b][0]
        for z in [ZS + 3 + 6 * i for i in range(14)]:
            gap0, gap1 = xa + shift(z, a, sh), xb + shift(z, b, sh)
            if 1.0 < gap1 - gap0 < 9.0:
                d.polygon([proj(gap0 + 0.2, z), proj(gap1 - 0.2, z + 1.2), proj(gap1 - 0.2, z + 2.4), proj(gap0 + 0.2, z + 1.2)], fill=white)
    # 경로 차로 초록
    for x0, x1, s in sh['lanes']:
        if s == sh['go']:
            d.polygon(strip(x0 + 0.15, x1 - 0.15, s, sh), fill=green)
    # 차선: 가장자리 실선, 같은 갈래 안은 점선, 갈래 경계는 실선
    for s, (x0, x1) in groups.items():
        lane_line(x0, s, sh, False, d, white, 0.16)
        lane_line(x1, s, sh, False, d, white, 0.16)
    for i, (x0, x1, s) in enumerate(sh['lanes'][1:], 1):
        ps = sh['lanes'][i - 1][2]
        if ps == s:
            lane_line(x0, s, sh, True, d, white, 0.14)
        else:
            # 갈라지기 전 경계: 점선 (차로 바꾸기 가능 구간), 갈라진 뒤는 위에서 그린 실선
            za = Z0
            while za < ZS:
                d.polygon(strip(x0 - 0.13, x0 + 0.13, 0, sh, za, min(za + 2.5, ZS)), fill=white)
                za += 5.0
    # 노면 화살표 (경로 차로는 흰 굽은 화살표, 나머지는 흰 직진 화살표)
    for x0, x1, s in sh['lanes']:
        cx = (x0 + x1) / 2
        turn = 0 if s == 0 else (1 if s > 0 else -1)
        d.polygon(arrow_poly(cx, s, sh, 11.0, 16.0, turn * (1 if s == sh['go'] else 0.6)), fill=white)
    # 문형 표지 틀: 위 보 + 양쪽 기둥, 표지판 두 장 (빈 초록판, 흰 안쪽 테)
    gray = (120, 128, 138)
    d.rectangle([0.05 * W, 0.065 * H, 0.95 * W, 0.095 * H], fill=gray)
    d.rectangle([0.055 * W, 0.065 * H, 0.075 * W, 0.62 * H], fill=gray)
    d.rectangle([0.925 * W, 0.065 * H, 0.945 * W, 0.62 * H], fill=gray)
    for bx in (BOARD_L, BOARD_R):
        x0, y0, x1, y1 = bx[0] * W, bx[1] * H, bx[2] * W, bx[3] * H
        d.rounded_rectangle([x0, y0, x1, y1], radius=14, fill=(11, 122, 67))
        d.rounded_rectangle([x0 + 10, y0 + 10, x1 - 10, y1 - 10], radius=9, outline=(255, 255, 255), width=5)
    return im


def text_anchor(name):
    """노면 글자 자리 (경로 갈래 가운데 · 다른 갈래 가운데, Z=8.9m: 화살표 아래) → 그림 비율 (x, y)"""
    sh = SHAPES[name]
    g = lane_groups(sh)
    go = g[sh['go']]
    oth = [v for k, v in g.items() if k != sh['go']][0]
    z = 8.9
    p = proj((go[0] + go[1]) / 2 + shift(z, sh['go'], sh), z)
    o = proj((oth[0] + oth[1]) / 2, z)
    return (round(p[0] / W, 3), round(p[1] / H, 3)), (round(o[0] / W, 3), round(o[1] / H, 3))


def lane_anchors(name, z=8.9):
    """차로마다 노면 방면 글자 자리 (그림 비율 x, y, 경로 차로인가) — 그림 안(4%~96%)에 보이는 차로만"""
    sh = SHAPES[name]
    out = []
    for x0, x1, s in sh['lanes']:
        p = proj((x0 + x1) / 2 + shift(z, s, sh), z)
        fx = p[0] / W
        if 0.04 <= fx <= 0.96:
            out.append([round(fx, 3), round(p[1] / H, 3), 1 if s == sh['go'] else 0])
    return out


def masks(name):
    """검사용: 경로 차로 · 다른 차로 (그림 아래 60%에서, 차선·화살표에서 조금 떨어진 안쪽만)"""
    sh = SHAPES[name]
    mg = Image.new('L', (W, H)); mo = Image.new('L', (W, H))
    dg, do = ImageDraw.Draw(mg), ImageDraw.Draw(mo)
    for x0, x1, s in sh['lanes']:
        poly = strip(x0 + 0.7, x1 - 0.7, s, sh, 7.0, 60.0)
        (dg if s == sh['go'] else do).polygon(poly, fill=255)
    a = np.array(mg) > 0; b = np.array(mo) > 0
    cut = int(0.45 * H)
    a[:cut] = False; b[:cut] = False
    return a, b


def route_region(name, size=(W, H)):
    """경로 차로 전체(갈래 끝까지, 양옆 0.35m 더) → 그림 크기의 참/거짓 배열 (색 바꾸기용)"""
    sh = SHAPES[name]
    m = Image.new('L', (W, H))
    d = ImageDraw.Draw(m)
    for x0, x1, s in sh['lanes']:
        if s == sh['go']:
            d.polygon(strip(x0 - 0.35, x1 + 0.35, s, sh), fill=255)
    if size != (W, H):
        m = m.resize(size, Image.NEAREST)
    return np.array(m) > 0


# 네이버처럼 갈 차로 색: 노면 색깔 유도선이 없으면 하늘색(b), 분홍 유도선이면 분홍(p). AI 그림은 초록(g)으로 그린다
LANE_HUE = {'b': 196, 'p': 329}
LANE_SV = {'b': (0.85, 1.32), 'p': (0.62, 1.3)}   # (채도, 밝기) 배


def recolor(im, name, c):
    """AI 그림(PIL RGB)의 경로 차로 초록만 같은 채도·밝기로 색만 바꾼 새 그림. 흰 화살표·차선은 그대로 (초록이 아니므로)"""
    a = np.asarray(im.convert('RGB'))
    mask = route_region(name, im.size) & is_green(a)
    hsv = np.array(im.convert('RGB').convert('HSV'))
    hsv[..., 0][mask] = int(LANE_HUE[c] / 360 * 255)
    # 네이버 분기점 그림의 밝은 하늘색(#22bff2)·연분홍(#f68cc0)처럼: 채도는 조금 낮추고 밝기는 올린다
    ks, kv = LANE_SV[c]
    for ch, k in ((1, ks), (2, kv)):
        v = hsv[..., ch].astype(float)
        v[mask] = np.minimum(255, v[mask] * k)
        hsv[..., ch] = v.astype(np.uint8)
    return Image.fromarray(hsv, 'HSV').convert('RGB')


def is_green(rgb):
    r, g, b = rgb[..., 0].astype(int), rgb[..., 1].astype(int), rgb[..., 2].astype(int)
    # 밤 그림은 초록 차로가 어두울 수 있다 (g 60 이상). 낮 풀밭도 초록이지만 검사 자리는 차로 안쪽뿐이다
    return (g > 60) & (g - r > 35) & (g - b > 12)


def check(path, name):
    """AI 그림이 구도를 지켰는지: (ok, 이유). 그림 크기는 아무거나 (밑그림 비율로 맞춰 본다)"""
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
        inner = gr[y0 + 25:y1 - 25, x0 + 30:x1 - 30]
        if inner.mean() < 0.35:
            why.append('%s 표지판 자리 초록 %.0f%%' % (nm, inner.mean() * 100))
    return (not why, ', '.join(why), round(float(go), 2), round(float(ot), 2))


def main():
    os.makedirs(REF, exist_ok=True)
    for name in SHAPES:
        p = os.path.join(REF, 'jx_%s.png' % name)
        draw_base(name).save(p)
        ok, why, go, ot = check(p, name)
        print('%-6s → %s  (밑그림 검사 %s %s, 경로 %.2f 다른 %.2f)  차로 글자 %s' % (name, os.path.relpath(p, ROOT), 'OK' if ok else '✗', why, go, ot, lane_anchors(name)))


if __name__ == '__main__':
    main()
