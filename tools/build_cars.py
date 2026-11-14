"""AI 로 그린 내 차 그림(tools/icon-src/ai/, 분홍 #FF00FF 바탕)을 지도 마커용 투명 PNG(img/car_*.png)로

- 분홍 정도 = min(R, B) - G (회색·빨강·흰 차에서는 0 근처). 이것으로 투명도를 정하고, 가장자리의 섞인 색은
  분홍을 덜어 원래 색으로 되돌린다(despill). 분홍 기가 남은 점이 있으면 멈춘다.
- 차만 잘라(앞쪽이 위) 앱의 다른 차 아이콘(viewBox 40×56, 차 길이 52)과 같은 비율의 200×280 캔버스 가운데에 놓는다.
- 사용:  py -X utf8 tools/build_cars.py   (고른 그림은 PICKS)
"""
import os
import sys

import numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
AI = os.path.join(ROOT, 'tools', 'icon-src', 'ai')
OUT = os.path.join(ROOT, 'img')
W, H, CAR_H = 200, 280, 260          # 40×56 의 5배, 차 길이 52 의 5배
# 앱 아이콘 id → 고른 AI 그림 (2026-11-14 첫 생성분 12장 중)
PICKS = {
    'tesla_grey': 'car_my__flare__2.png',
    'tesla_red': 'car_red__flare__2.png',
    'tesla_white': 'car_white__flare__2.png',
}


def key(path):
    a = np.asarray(Image.open(path).convert('RGB')).astype(np.float32)
    R, G, B = a[..., 0], a[..., 1], a[..., 2]
    m = np.clip(np.minimum(R, B) - G, 0, 255)          # 분홍 정도 0..255
    # 바탕 분홍은 완전한 #FF00FF 가 아니다(예: 248,5,247 → 분홍 정도 약 240): 테두리 띠에서 바탕색과 그 분홍 정도를 잰다
    border = np.concatenate([a[:16].reshape(-1, 3), a[-16:].reshape(-1, 3), a[:, :16].reshape(-1, 3), a[:, -16:].reshape(-1, 3)])
    bm = np.clip(np.minimum(border[:, 0], border[:, 2]) - border[:, 1], 0, 255)
    bgm = bm > 90    # 2026-11-15: AI 가 진분홍(239,2,119) 바탕으로 줄 때도 있어 150 → 90
    if not bgm.any():
        raise ValueError('테두리에 분홍 바탕이 없음')
    M = np.median(border[bgm], axis=0).astype(np.float32)
    hi = float(np.percentile(bm[bgm], 2)) - 6       # 이 위는 완전히 바탕
    lo = 24                                                # 이 아래는 차 (아주 옅은 분홍빛 반사는 그대로)
    alpha = 1.0 - np.clip((m - lo) / (hi - lo), 0, 1)
    # 섞인 색 되돌리기: P = a*C + (1-a)*M  →  C = (P - (1-a)*M) / a
    am = np.maximum(alpha, 1e-3)[..., None]
    C = np.clip((a - (1 - am) * M) / am, 0, 255)
    rgba = np.concatenate([C, (alpha * 255)[..., None]], axis=-1)
    rgba[alpha < 0.02] = 0
    return rgba


def check_pink(rgba, name):
    A = rgba[..., 3]
    R, G, B = rgba[..., 0], rgba[..., 1], rgba[..., 2]
    pink = (A > 40) & (np.minimum(R, B) - G > 60) & (R > 150) & (B > 150)
    n = int(pink.sum())
    if n > 30:
        sys.exit('%s: 분홍 기가 남은 점 %d 개 — 고르지 않는다' % (name, n))
    return n


def place(rgba):
    A = rgba[..., 3]
    # 차 범위: 불투명한 점이 10개 넘는 줄·칸 (모서리의 외톨이 점 무시), 둘레 4px 여유. 그 밖은 지운다
    ys, xs = np.nonzero((A > 128).sum(1) > 10)[0], np.nonzero((A > 128).sum(0) > 10)[0]
    y0, y1 = max(0, ys.min() - 4), min(A.shape[0], ys.max() + 5)
    x0, x1 = max(0, xs.min() - 4), min(A.shape[1], xs.max() + 5)
    crop = Image.fromarray(rgba[y0:y1, x0:x1].astype(np.uint8), 'RGBA')
    k = CAR_H / crop.height
    w = max(1, round(crop.width * k))
    # 투명 가장자리가 어둡게 번지지 않게 미리 곱한 알파로 줄인다
    small = crop.convert('RGBa').resize((w, CAR_H), Image.LANCZOS).convert('RGBA')
    can = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    can.alpha_composite(small, ((W - w) // 2, (H - CAR_H) // 2))
    return can, (crop.width, crop.height)


def main():
    os.makedirs(OUT, exist_ok=True)
    for cid, fn in PICKS.items():
        rgba = key(os.path.join(AI, fn))
        n = check_pink(rgba, fn)
        img, size = place(rgba)
        path = os.path.join(OUT, 'car_%s.png' % cid)
        img.save(path, optimize=True)
        print('%-12s ← %-26s 차 %dx%d · 분홍 기 %d · %s (%d KB)' % (cid, fn, size[0], size[1], n,
              os.path.relpath(path, ROOT), os.path.getsize(path) // 1024))


if __name__ == '__main__':
    main()
