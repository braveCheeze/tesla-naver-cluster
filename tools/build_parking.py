"""주정차 단속 카메라: 전국무인교통단속카메라표준데이터 CSV 의 단속구분 4(주정차) → data/parking.json

과속·신호 카메라(data/cameras.json, tools/build_cams.py)와 같은 원본에서 주정차만 뽑는다 (2026-11-14 요청: '주정차금지 저런 것도').
좌표만 담는다 (1e5 배 정수, 위도 순으로 정렬해 앞 값과의 차이로): { date, count, scale, d: [dlat, dlng, ...] }
같은 자리(1m 안)에 여러 대가 있으면 하나로.

사용법: py -I tools/build_parking.py <원본.csv> data/parking.json
"""
import csv
import io
import json
import sys
from datetime import date

src, out = sys.argv[1], sys.argv[2]
rows = list(csv.reader(io.StringIO(open(src, 'rb').read().decode('cp949'))))[1:]
norm = lambda c: c.strip().lstrip('0') or '0'
pts = set()
bad = 0
for r in rows:
    parts = {norm(c) for c in r[12].replace(' ', '').split('+')}
    if '4' not in parts:
        continue
    try:
        la, ln = float(r[9]), float(r[10])
    except ValueError:
        bad += 1
        continue
    if not (33 < la < 39 and 124 < ln < 132):
        bad += 1
        continue
    pts.add((round(la * 1e5), round(ln * 1e5)))
pts = sorted(pts)
d, pa, pb = [], 0, 0
for a, b in pts:
    d += [a - pa, b - pb]
    pa, pb = a, b
with open(out, 'w', encoding='utf-8', newline='\n') as fh:
    json.dump({'date': date.today().isoformat(), 'count': len(pts), 'scale': 100000, 'd': d}, fh, separators=(',', ':'))
print('parking cameras', len(pts), 'skipped (bad coords)', bad)
