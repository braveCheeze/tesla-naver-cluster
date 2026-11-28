"""고른 네이버식 분기점 그림(갈 차로 둘: exit2·exit42·fork)의 차로마다 다른 색 그림 (v253, exit42 는 v255)

판교분기점처럼 갈래가 다시 둘로 갈리고 색깔 유도선이 둘(녹색·분홍)인 곳: 앱이 '<그림>_gp.webp'(뒤집기 전 왼쪽 차로 녹색·오른쪽 분홍)를 쓴다.
img/ai/picks.js 에서 고른 jx_exit2_*·jx_fork_* 그림의 원본(tools/icon-src/ai/*.png)으로 만든다.
v256 2판(jx2_*): 경로 차로가 둘 이상인 모양마다 왼쪽 무리·오른쪽 무리 두 색('_gpp' 처럼, 무리 나누기는 모든 자리), 본선 그대로(s31·s41)는
버스전용차로를 칠하지 않은 그림('_nbbb' — 왼쪽 끝 차로 'n', 뒤집힌 그림용 'bbbn' 도)
사용:  py -X utf8 tools/jx_variants.py
"""
import itertools
import os
import re
import sys

from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import jx_scene  # noqa: E402
import jx_scene2  # noqa: E402

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
for slot, f in re.findall(r'"(jx2_[a-z0-9]+_(?:day|night))": "([^"]+)"', picks):
    shape = slot[4:].rsplit('_', 1)[0]
    ngo = jx_scene2.GO_N[shape]
    if ngo < 2:
        continue
    src = os.path.join(ROOT, 'tools', 'icon-src', 'ai', f[:-5] + '.png')
    im = Image.open(src).convert('RGB')
    im.thumbnail((640, 640), Image.LANCZOS)
    combos = set()
    if shape[0] == 's':
        for c in 'gpb':
            combos.add('n' + c * (ngo - 1)); combos.add(c * (ngo - 1) + 'n')
    else:
        for k in range(1, ngo):
            for a, b in itertools.permutations('gpb', 2):
                combos.add(a * k + b * (ngo - k))
            # v285 (운전자 '내가 가고자 하는 방향만 색상을 칠해줘'): 갈 차로 무리가 다시 갈리면 경로 갈래 무리만 칠하고 다른 무리는 회색('n') — '_npp'(판교분기점 구리)·'_gnn'(일산)
            for c in 'gpb':
                combos.add(c * k + 'n' * (ngo - k)); combos.add('n' * k + c * (ngo - k))
    for cols in sorted(combos):
        out = os.path.join(ROOT, 'img', 'ai', f[:-5] + '_' + cols + '.webp')
        if os.path.exists(out) and '--all' not in sys.argv:
            continue   # v285: 이미 있는 그림은 그대로 (다시 만들면 바이트가 바뀌어 저장소만 커진다). 원본을 바꿨으면 --all
        jx_scene2.recolor_lanes(im, shape, list(cols)).save(out, 'WEBP', quality=86)
        n += 1
print('차로마다 다른 색 그림', n)
