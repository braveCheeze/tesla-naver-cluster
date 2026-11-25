"""고른 2판 분기점 그림(jx2)마다 실제 차로 가운데·폭 (v263, 2026-11-26 운전자 신갈 사진: 둘째 '신갈' 글자가 차로 한쪽 선에 붙어 있다 —
부모 세션 '차로 글자는 그림의 실제 차로 모양으로 가운데에')

AI 그림은 밑그림의 차로 자리를 대체로 지키지만 몇 % 씩 비켜 그린다. 밑그림 자리(app.js JX2_LANES)에 글자를 두면 선 위에 놓이는 차로가 생긴다.
그래서 그림에서 흰 차선을 찾는다:
  - 차로마다 하나씩 있는 흰 노면 화살표는 그림에서도 차로 가운데에 있다. 화살표 띠(보이는 띠 58~82%)의 흰 점을 소실점에서 글자 줄로
    투영하고, 폭이 넓은 덩어리(화살표 — 차선은 좁다)의 무게중심을 그 차로의 가운데로 쓴다. 밑그림 자리에서 차로 폭 절반 안의 것만
  - 차로마다(밑그림 글자 자리 순서) 그 자리 바로 왼쪽·오른쪽 차선 사이의 가운데와 폭. 둘 다 찾지 못하거나 폭이 밑그림의 0.6~1.5 배가 아니면 밑그림 자리
결과: img/ai/jx2_lanes.json {그림 파일: [[가운데 x, 폭, 기울기°, 맞춤 0 밑그림·1 찾음·2 눈금자], …] (JX2_LANES 차례, 그림 폭 비율)}
  — 색 바꾼 그림(_b, _gpp …)도 같은 자리. 앱은 낮·밤 그림마다 따로 글자를 얹는다
사용:  py -X utf8 tools\\jx_lanefit.py            (img/ai/picks.js 의 jx2_* 그림)
       py -X utf8 tools\\jx_lanefit.py --sheet <png>   (검사용 모아 보기: 찾은 차선·글자 자리)
"""
import json
import math
import os
import re
import sys

import numpy as np
from PIL import Image, ImageDraw

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import jx_scene2 as S  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
N = 1024


def white_points(a):
    r, g, b = a[..., 0].astype(int), a[..., 1].astype(int), a[..., 2].astype(int)
    mn = np.minimum(np.minimum(r, g), b)
    mx = np.maximum(np.maximum(r, g), b)
    m = (mn > 170) & (mx - mn < 50)
    y0 = int(S.Y0 + 0.80 * (N - S.Y0))
    m[:y0] = False
    m[N - 3:] = False
    ys, xs = np.nonzero(m)
    return xs.astype(float), ys.astype(float)


def hough_lines(xs, ys, yl, wa):
    """글자 줄(yl) 둘레 띠의 흰 점으로 직선 찾기: x = x0 + (y - yl)·tan φ, (φ, x0) 투표 → 봉우리. 반환 [(x0, 표)] — x0 는 글자 줄에서의 x"""
    if len(xs) > 40000:
        k = np.random.RandomState(1).choice(len(xs), 40000, replace=False)
        xs, ys = xs[k], ys[k]
    phis = np.radians(np.arange(-72, 72.1, 0.75))
    tb = 3.0
    nb = int(N / tb) + 1
    acc = np.zeros((len(phis), nb))
    dy = ys - yl
    for i, ph in enumerate(phis):
        x0 = xs - dy * math.tan(ph)
        idx = np.round(x0 / tb).astype(int)
        ok = (idx >= 0) & (idx < nb)
        acc[i] += np.bincount(idx[ok], minlength=nb)
    # 각도로 접어 x0 마다 가장 센 표, 이웃 x0 는 하나로
    best = acc.max(axis=0)
    sm = np.convolve(best, [1, 2, 1], mode='same') / 4.0
    thr = max(12.0, sm.max() * 0.18)
    out = []
    minsep = max(4, int(0.35 * wa / tb))
    for j in range(1, nb - 1):
        if sm[j] >= thr and sm[j] == sm[max(0, j - minsep):j + minsep + 1].max():
            out.append((j * tb, float(sm[j])))
    return out


def arrow_centres(a, yl, wa):
    """노면 화살표(차로 가운데의 흰 덩어리)의 가운데를 글자 줄(yl)로 내린 x 들 (소실점 쪽으로 투영).
    화살표 띠(보이는 띠 58~82%)의 흰 점을 소실점(밑그림)에서 글자 줄로 투영한 x 의 분포에서, 폭이 넓은 덩어리(화살표)만 — 차선은 좁다"""
    r, g, b = a[..., 0].astype(int), a[..., 1].astype(int), a[..., 2].astype(int)
    mn = np.minimum(np.minimum(r, g), b)
    mx = np.maximum(np.maximum(r, g), b)
    m = (mn > 175) & (mx - mn < 50)
    y0, y1 = int(S.Y0 + 0.58 * (N - S.Y0)), int(S.Y0 + 0.82 * (N - S.Y0))
    m[:y0] = False
    m[y1:] = False
    ys, xs = np.nonzero(m)
    if len(xs) < 50:
        return []
    vx, vy = N / 2.0, S.HZ
    xr = vx + (xs - vx) * (yl - vy) / (ys - vy)
    bw = 2.0
    h, e = np.histogram(xr, bins=np.arange(-N * 0.3, N * 1.3, bw))
    hs = np.convolve(h, np.ones(5) / 5.0, mode='same')
    on = hs > max(1.5, hs.max() * 0.04)
    out = []
    i = 0
    while i < len(on):
        if not on[i]:
            i += 1
            continue
        j = i
        while j < len(on) and on[j]:
            j += 1
        width = (j - i) * bw
        mass = h[i:j].sum()
        if width >= 0.3 * wa and mass >= 80:
            c = ((e[i:j] + bw / 2) * h[i:j]).sum() / max(1, mass)
            out.append((float(c), width, int(mass)))
        i = j
    return out


def fit(path, shape):
    im = Image.open(path).convert('RGB').resize((N, N), Image.BILINEAR)
    a = np.asarray(im)
    anchors = S.lane_anchors(shape)
    yl = S.Y0 + anchors[0][1] * (N - S.Y0)
    wa0 = anchors[0][3] * N
    ac = arrow_centres(a, yl, wa0)
    xs_ = sorted(c for c, _, _ in ac)
    # 그림 안(2~98%)에 보이는 화살표가 차로 수와 같으면 왼쪽부터 차례로 짝짓는다 (AI 가 카메라를 더 가까이 둔 그림: 갈림길·2+2 —
    #   밑그림 자리와 차로 하나 가까이 차이 나도). 아니면 밑그림 자리에서 차로 폭 0.8 안의 가장 가까운 화살표
    vis = [c for c in xs_ if 0.02 * N <= c <= 0.98 * N]
    res = []
    if len(vis) == len(anchors):
        gaps = [vis[k + 1] - vis[k] for k in range(len(vis) - 1)]
        for k, (fx, fy, go, w, ang) in enumerate(anchors):
            g = [gaps[k - 1]] if k > 0 else []
            g += [gaps[k]] if k < len(gaps) else []
            wm = sum(g) / len(g) / N if g else w
            res.append([round(vis[k] / N, 3), round(min(max(wm, 0.6 * w), 1.6 * w), 3), 1])
        return res, (yl, xs_)
    for fx, fy, go, w, ang in anchors:
        xa, wa = fx * N, w * N
        near = [c for c in xs_ if abs(c - xa) <= 0.8 * wa]
        if near:
            c = min(near, key=lambda q: abs(q - xa))
            res.append([round(c / N, 3), w, 1])
        else:
            res.append([fx, w, 0])
    return res, (yl, xs_)


# 화살표가 그림 가장자리에 있거나 AI 가 카메라를 바짝 붙여 그린 그림(갈림길·2+2)은 차로 찾기가 틀린다 — 글자 줄에 눈금자를 대고 읽은
# 차로 가운데(차선 사이, 그림 폭 %, 밑그림 차례)로 정한다 (2026-11-26)
MANUAL = {
    'jx2_x31_day__sunburst26e__2': [24.0, 44.0, 61.5, 83.0],
    'jx2_x22_day__sunburst26e__1': [20.5, 40.5, 60.0, 81.5],
    'jx2_x22_night__sunburst26e__1': [-3.0, 32.0, 65.0, 95.0],
    'jx2_f22_day__flare26e__2': [15.0, 38.0, 62.0, 87.0],
    'jx2_f22_night__sunburst26e__2': [12.0, 37.0, 61.5, 85.0],
    'jx2_f22k_day__flare26e__1': [5.0, 35.0, 65.0, 95.0],
    'jx2_f22k_night__sunburst26e__1': [16.0, 39.0, 60.0, 82.0],
    'jx2_s41_night__sunburst26e__2': [12.0, 30.5, 50.5, 70.5, 91.0],
}


def finish(res, shape):
    """[가운데, 폭, 맞춤] → [가운데(그림 안 9~91% 로), 폭, 기울기°, 맞춤]. 폭은 이웃 가운데와의 거리, 기울기는 가운데에서 다시 셈"""
    sh = S.SHAPES[shape]
    xs = [r[0] for r in res]
    out = []
    for k, (x, w, ok) in enumerate(res):
        g = []
        if k > 0:
            g.append(xs[k] - xs[k - 1])
        if k < len(xs) - 1:
            g.append(xs[k + 1] - xs[k])
        wm = sum(g) / len(g) if g else w
        X = (x - 0.5) * N * sh['lz'] / S.F
        ang = round(math.degrees(math.atan(X / S.CAM_H)), 1)
        out.append([round(min(0.91, max(0.09, x)), 3), round(max(0.1, min(0.3, wm)), 3), ang, ok])   # 반쯤 그림 밖 차로도 글자가 잘리지 않게
    return out


def main():
    picks = open(os.path.join(ROOT, 'img', 'ai', 'picks.js'), encoding='utf-8').read()
    out, sheet = {}, []
    for slot, f in re.findall(r'"(jx2_[a-z0-9]+_(?:day|night))": "([^"]+)"', picks):
        shape = slot[4:].rsplit('_', 1)[0]
        src = os.path.join(ROOT, 'tools', 'icon-src', 'ai', f[:-5] + '.png')
        res, geo = fit(src, shape)
        if f[:-5] in MANUAL:
            m = MANUAL[f[:-5]]
            assert len(m) == len(S.lane_anchors(shape)), f
            res = [[v / 100.0, a[3], 2] for v, a in zip(m, S.lane_anchors(shape))]
            geo = geo or (S.Y0 + S.lane_anchors(shape)[0][1] * (N - S.Y0), [])
        if res is None:
            print('%-16s 흰 점이 모자라 밑그림 자리' % slot)
            continue
        out[f] = finish(res, shape)
        moved = [round(abs(r[0] - a[0]) * 100, 1) for r, a in zip(res, S.lane_anchors(shape))]
        print('%-16s 맞춘 차로 %d/%d  옮긴 정도(그림 폭 %%) %s' % (slot, sum(r[2] for r in res), len(res), moved))
        sheet.append((slot, src, shape, res, geo))
    json.dump(out, open(os.path.join(ROOT, 'img', 'ai', 'jx2_lanes.json'), 'w', encoding='utf-8'), separators=(',', ':'))
    if '--sheet' in sys.argv:
        tiles = []
        for slot, src, shape, res, (yl, xl) in sheet:
            im = Image.open(src).convert('RGB').resize((N, N))
            d = ImageDraw.Draw(im)
            for x in xl:
                d.line([(x, yl - 30), (x, yl + 30)], fill=(255, 0, 0), width=3)   # 화살표에서 내린 가운데
            for (x, w, ok), a in zip([r[:3] for r in res], S.lane_anchors(shape)):
                yl = S.Y0 + a[1] * (N - S.Y0)
                d.ellipse([a[0] * N - 7, yl - 7, a[0] * N + 7, yl + 7], outline=(255, 255, 0), width=3)
                d.ellipse([x * N - 9, yl - 9, x * N + 9, yl + 9], fill=(0, 255, 255) if ok else (255, 0, 255))
            d.text((10, 270), slot, fill=(255, 255, 0))
            tiles.append(im.crop((0, 256, N, N)).resize((480, 360)))
        cols = 4
        rows = (len(tiles) + cols - 1) // cols
        sh = Image.new('RGB', (cols * 484, rows * 364), 'white')
        for i, t in enumerate(tiles):
            sh.paste(t, ((i % cols) * 484, (i // cols) * 364))
        sh.save(sys.argv[sys.argv.index('--sheet') + 1])
    print('jx2_lanes.json', len(out))


if __name__ == '__main__':
    main()
