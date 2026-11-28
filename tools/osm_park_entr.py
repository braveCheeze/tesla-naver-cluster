"""OSM 주차장 입구 (v288, 도착 판정) → data/park_entr.json

2026-11-28 운전자 '어느순간 길안내를 계속 못찾아서': 목적지 블록에 핀 반대쪽으로 들어와 지하 주차장으로 내려갈 때까지 안내가 안 끝났다.
앱은 목적지(핀)·경로 끝 250m 안에 있는 주차장 입구 20m 안으로 시속 25km 아래로 들어가면(경로를 벗어났거나 블록을 도는 경로일 때) 도착으로 본다.

OSM 한국 추출본(D:\\osm\\south-korea-latest.osm.pbf)의 amenity=parking_entrance 점 (2026-11 약 7천 곳). 건물 윤곽(약 138만 개)은 너무 커서 싣지 않는다.
쓰기: {v, date, src, n, p: [위도×1e5, 경도×1e5, ...]} (위도 순, 같은 자리 5m 안은 하나로)

사용:  set TMP=D:\\tmp & py -X utf8 tools/osm_park_entr.py [D:\\osm\\south-korea-latest.osm.pbf]
"""
import datetime
import json
import math
import os
import sys

sys.path.insert(0, r'D:\pylib')
import osmium  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PBF = sys.argv[1] if len(sys.argv) > 1 else r'D:\osm\south-korea-latest.osm.pbf'
OUT = os.path.join(ROOT, 'data', 'park_entr.json')


class H(osmium.SimpleHandler):
    def __init__(self):
        super().__init__()
        self.pts = []

    def node(self, n):
        if n.tags.get('amenity') == 'parking_entrance' and n.location.valid():
            lat, lng = n.location.lat, n.location.lon
            if 33 < lat < 39 and 124 < lng < 132:
                self.pts.append((round(lat * 1e5), round(lng * 1e5)))


def main():
    h = H()
    h.apply_file(PBF)
    pts = sorted(set(h.pts))
    keep = []
    for p in pts:   # 같은 자리 5m 안은 하나로 (위도 순이라 바로 앞 몇 개만 본다)
        dup = False
        for q in keep[-8:]:
            if abs(p[0] - q[0]) <= 5 and abs(p[1] - q[1]) * math.cos(math.radians(p[0] / 1e5)) <= 5:
                dup = True
                break
        if not dup:
            keep.append(p)
    flat = [x for p in keep for x in p]
    out = {'v': 1, 'date': datetime.date.today().isoformat(), 'src': 'OpenStreetMap (ODbL) amenity=parking_entrance', 'n': len(keep), 'p': flat}
    with open(OUT, 'w', encoding='utf-8') as fh:
        json.dump(out, fh, separators=(',', ':'))
    print('parking entrances', len(h.pts), '->', len(keep), OUT, os.path.getsize(OUT), 'bytes')


if __name__ == '__main__':
    main()
