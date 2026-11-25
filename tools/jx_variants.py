"""고른 네이버식 분기점 그림(갈 차로 둘: exit2·exit42·fork)의 차로마다 다른 색 그림 (v253, exit42 는 v255)

판교분기점처럼 갈래가 다시 둘로 갈리고 색깔 유도선이 둘(녹색·분홍)인 곳: 앱이 '<그림>_gp.webp'(뒤집기 전 왼쪽 차로 녹색·오른쪽 분홍)를 쓴다.
img/ai/picks.js 에서 고른 jx_exit2_*·jx_fork_* 그림의 원본(tools/icon-src/ai/*.png)으로 만든다.
사용:  py -X utf8 tools/jx_variants.py
"""
import itertools
import os
import re
import sys

from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import jx_scene  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
picks = open(os.path.join(ROOT, 'img', 'ai', 'picks.js'), encoding='utf-8').read()
n = 0
for slot, f in re.findall(r'"(jx_(?:exit2|exit42|fork)_(?:day|night))": "([^"]+)"', picks):
    shape = slot[3:].rsplit('_', 1)[0]
    src = os.path.join(ROOT, 'tools', 'icon-src', 'ai', f[:-5] + '.png')
    im = Image.open(src).convert('RGB')
    im.thumbnail((720, 480), Image.LANCZOS)
    for a, b in itertools.permutations('gpb', 2):
        out = os.path.join(ROOT, 'img', 'ai', f[:-5] + '_' + a + b + '.webp')
        jx_scene.recolor_lanes(im, shape, [a, b]).save(out, 'WEBP', quality=86)
        n += 1
print('차로마다 다른 색 그림', n)
