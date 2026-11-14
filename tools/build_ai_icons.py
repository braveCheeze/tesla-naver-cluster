"""AI 로 그린 그림(tools/icon-src/ai/<칸>__<모델>__<번호>.png, 분홍 바탕) → 앱·관리 페이지가 쓰는 투명 그림(img/ai/*.webp)

- 분홍 빼기·가장자리 색 되돌리기는 build_cars.py 와 같다 (분홍 기가 남은 그림은 manifest 에 pink 로 표시해 고를 수 없게 한다).
- 아이콘은 192×192 가운데(그림이 176px 안에), 차는 200×280(차 길이 260), 분기점 그림(가로로 넓은 장면)은 분홍이 없으니 그대로 줄인다.
- img/ai/manifest.json: 칸별 후보 목록. 관리 페이지(tools/icons.html)가 읽는다.
- 사용:  py -X utf8 tools/build_ai_icons.py      (새로 생성한 뒤 다시 돌리면 된다)
"""
import json
import os
import re
import sys
from datetime import date

import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build_cars  # noqa: E402  (key, check_pink 같이 쓴다)

ROOT = build_cars.ROOT
AI = build_cars.AI
OUT = os.path.join(ROOT, 'img', 'ai')
NAME = re.compile(r'^(?P<slot>[a-z0-9_]+?)__(?P<model>[a-z0-9]+)__(?P<n>\d+)\.png$')
# 생성 칸 이름 → 앱 칸 이름 (나머지는 같은 이름)
SLOT_ALIAS = {'goal3d': 'goal', 'via3d': 'via'}


def pink_count(rgba):
    A = rgba[..., 3]
    R, G, B = rgba[..., 0], rgba[..., 1], rgba[..., 2]
    return int(((A > 40) & (np.minimum(R, B) - G > 60) & (R > 150) & (B > 150)).sum())


def fit_square(rgba, size=192, inner=176):
    A = rgba[..., 3]
    ys, xs = np.nonzero((A > 128).sum(1) > 4)[0], np.nonzero((A > 128).sum(0) > 4)[0]
    if not len(ys) or not len(xs):
        return None
    y0, y1 = max(0, ys.min() - 3), min(A.shape[0], ys.max() + 4)
    x0, x1 = max(0, xs.min() - 3), min(A.shape[1], xs.max() + 4)
    crop = Image.fromarray(rgba[y0:y1, x0:x1].astype(np.uint8), 'RGBA')
    k = inner / max(crop.width, crop.height)
    w, h = max(1, round(crop.width * k)), max(1, round(crop.height * k))
    small = crop.convert('RGBa').resize((w, h), Image.LANCZOS).convert('RGBA')
    can = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    can.alpha_composite(small, ((size - w) // 2, (size - h) // 2))
    return can


def main():
    os.makedirs(OUT, exist_ok=True)
    items = []
    for fn in sorted(os.listdir(AI)):
        m = NAME.match(fn)
        if not m:
            continue
        slot = SLOT_ALIAS.get(m['slot'], m['slot'])
        src = os.path.join(AI, fn)
        out = fn[:-4] + '.webp'
        path = os.path.join(OUT, out)
        kind = 'car' if slot.startswith(('car_', 'cute_')) else 'scene' if slot.startswith('junc_') else 'sign' if slot.startswith('sign_') else 'icon'
        pink = 0
        if kind == 'scene':
            im = Image.open(src).convert('RGB')
            im.thumbnail((480, 320), Image.LANCZOS)
            im.save(path, 'WEBP', quality=86)
        else:
            try:
                rgba = build_cars.key(src)
            except Exception as e:
                print('  ✗ 바탕을 못 뺌 %s: %s' % (fn, e))
                continue
            pink = pink_count(rgba)
            if kind == 'car':
                im, _ = build_cars.place(rgba)
            else:
                im = fit_square(rgba)
                if im is None:
                    print('  ✗ 빈 그림', fn)
                    continue
            im.save(path, 'WEBP', quality=90, method=6)
        items.append({'slot': slot, 'kind': kind, 'file': out, 'model': m['model'], 'n': int(m['n']), 'pink': pink})
        print('%-6s %-14s %-34s 분홍 %3d  %d KB' % (kind, slot, out, pink, os.path.getsize(path) // 1024))
    man = {'date': date.today().isoformat(), 'items': items}
    with open(os.path.join(OUT, 'manifest.json'), 'w', encoding='utf-8') as fh:
        json.dump(man, fh, ensure_ascii=False, indent=1)
    print('후보 %d개 → img/ai/manifest.json' % len(items))


if __name__ == '__main__':
    main()
