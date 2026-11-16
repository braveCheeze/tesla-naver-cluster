"""OSM 의 단속 카메라(highway=speed_camera)와 우리 자료(data/cameras.json · mobile.json)를 맞대어 빠진 후보를 센다 (v138 점검).

    py -X utf8 tools/osm_speedcams.py D:/osm/south-korea-latest.osm.pbf [D:/tmp/osm_speedcams.json]

우리 카메라 80m 안에 없는 OSM 카메라를 '빠진 후보'로 목록에 남긴다 (자동으로 넣지는 않는다: OSM 카메라는 찍는 방향·제한속도가
없는 것이 많고 철거된 것도 섞여 있어, 넣으면 오탐이 는다). 2026-11-16 '놓침' 신고 지점 주변 후보도 따로 보여 준다.
"""
import json
import math
import sys

sys.path.insert(0, r'D:\pylib')
import osmium  # noqa: E402

PBF = sys.argv[1] if len(sys.argv) > 1 else r'D:\osm\south-korea-latest.osm.pbf'
OUT = sys.argv[2] if len(sys.argv) > 2 else r'D:\tmp\osm_speedcams.json'
ROOT = __file__.rsplit('tools', 1)[0]
KY = 110540.0
CELL = 0.002


def dist(a, b):
    return math.hypot((a[0] - b[0]) * KY, (a[1] - b[1]) * 111320.0 * math.cos(math.radians(a[0])))


class H(osmium.SimpleHandler):
    def __init__(self):
        super().__init__()
        self.cams = []

    def node(self, n):
        t = n.tags
        if t.get('highway') == 'speed_camera' or t.get('enforcement') == 'maxspeed':
            self.cams.append((n.location.lat, n.location.lon, t.get('maxspeed', ''), t.get('direction', ''), t.get('name', '')))


h = H()
h.apply_file(PBF)
ours = []
for f in ('data/cameras.json', 'data/mobile.json'):
    ours += [(r[0], r[1]) for r in json.load(open(ROOT + f, encoding='utf-8'))['rows']]
grid = {}
for p in ours:
    grid.setdefault((int(math.floor(p[0] / CELL)), int(math.floor(p[1] / CELL))), []).append(p)


def near_ours(p, m):
    cy, cx = int(math.floor(p[0] / CELL)), int(math.floor(p[1] / CELL))
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            for q in grid.get((cy + dy, cx + dx), ()):
                if dist(p, q) <= m:
                    return True
    return False


missing = [c for c in h.cams if not near_ours(c, 80)]
print('OSM speed cameras', len(h.cams), '| within 80 m of ours', len(h.cams) - len(missing), '| missing candidates', len(missing))
json.dump(missing, open(OUT, 'w', encoding='utf-8'), ensure_ascii=False)
reports = [('08:50 경부 죽전', 37.333344, 127.103616), ('08:58 경부 판교', 37.380176, 127.103341), ('09:07 수도권1순환', 37.477825, 127.133371),
           ('09:14 서하남로', 37.519269, 127.139239), ('09:16 강동대로', 37.525228, 127.135383)]
for name, la, lo in reports:
    near = [(round(dist((la, lo), c)), c[2], c[3]) for c in h.cams if dist((la, lo), c) < 2500]
    print(name, 'OSM cameras within 2.5 km:', sorted(near)[:6])
