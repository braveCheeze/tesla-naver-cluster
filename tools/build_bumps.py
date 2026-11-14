"""전국 과속방지턱 표준데이터 CSV -> 페이지용 압축 JSON (data/bumps.json).

원본: 공공데이터포털 '전국과속방지턱표준데이터'(data.go.kr 15028195, 행정안전부·국토교통부, 이용 제한 없음).
      파일은 https://file.localdata.go.kr/file/speed_bump_info/info 의 '전체 파일 다운로드' (cp949 CSV, WGS84 위도·경도 포함)
사용법: py -I tools/build_bumps.py <과속방지턱정보.csv> data/bumps.json

출력: {"v":2, "scale":100000, "date":"YYYY-MM-DD", "count":N, "names":["", "중앙로", ...], "d":[dLat, dLng, road*2+flag, ...]}
  - 좌표는 위도·경도 x 100000 정수(약 1m). 0.02° 칸 순서로 정렬한 뒤 앞 점과의 차이만 적어 파일을 줄인다
  - 셋째 값: names 의 도로 이름 번호 x 2 + 연속형(1 = 여러 개가 이어진 방지턱). 0번 이름 '' = 도로 이름 모름
  - 도로 이름 (2026-11-14: 거리만 보면 옆 골목·고가 밑 도로의 방지턱이 섞여서, 앱이 경로의 도로 이름과 맞춰 본다):
    '도로명' 칸이 'OO로'·'OO길'·'OO로12번길' 꼴이면 그것, 아니면(동 이름 등) '소재지도로명주소'의 도로 이름
  - 5m 안에 겹친 같은 방지턱은 하나로 합친다
"""
import csv
import io
import json
import math
import re
import sys
from collections import Counter

ROAD_RE = re.compile(r'^[가-힣][가-힣0-9]*(?:대로|로|길)(?:\d+(?:번)?길)?$')


def road_name(*cands):
    for c in cands:
        for t in reversed((c or '').split()):
            t = re.sub(r'[(,].*$', '', t)
            if ROAD_RE.match(t):
                return t
    return ''

src, out = sys.argv[1], sys.argv[2]
raw = open(src, 'rb').read()
for enc in ('utf-8-sig', 'cp949'):
    try:
        text = raw.decode(enc)
        break
    except UnicodeDecodeError:
        continue
rows = list(csv.reader(io.StringIO(text)))
head = rows[0]
col = {name: i for i, name in enumerate(head)}
I_LAT, I_LNG = col['WGS84위도'], col['WGS84경도']
I_CONT, I_DATE = col.get('연속형여부'), col.get('데이터갱신시점')
I_ROAD, I_ADDR = col.get('도로명'), col.get('소재지도로명주소')

pts = []
skipped = Counter()
dates = Counter()
for r in rows[1:]:
    try:
        lat, lng = float(r[I_LAT]), float(r[I_LNG])
    except (ValueError, IndexError):
        skipped['coord'] += 1
        continue
    if not (33 < lat < 39 and 124 < lng < 132):
        skipped['outside'] += 1
        continue
    flag = 1 if I_CONT is not None and r[I_CONT].strip().upper() == 'Y' else 0
    rn = road_name(r[I_ROAD] if I_ROAD is not None else '', r[I_ADDR] if I_ADDR is not None else '')
    pts.append([round(lat * 1e5), round(lng * 1e5), flag, rn])
    if I_DATE is not None and r[I_DATE]:
        dates[r[I_DATE][:10]] += 1

# 5m 안의 같은 방지턱 합치기 (격자 0.0002° ≈ 20m)
def dist_m(a, b):
    dy = (a[0] - b[0]) / 1e5 * 110540
    dx = (a[1] - b[1]) / 1e5 * 111320 * math.cos(math.radians(a[0] / 1e5))
    return math.hypot(dx, dy)
cells, kept = {}, []
for p in pts:
    cy, cx = p[0] // 20, p[1] // 20
    hit = None
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            for q in cells.get((cy + dy, cx + dx), ()):
                if dist_m(p, q) <= 5:
                    hit = q
                    break
            if hit: break
        if hit: break
    if hit:
        hit[2] |= p[2]
        if not hit[3]:
            hit[3] = p[3]
        skipped['merged'] += 1
        continue
    cells.setdefault((cy, cx), []).append(p)
    kept.append(p)

# 0.02° 칸 순서로 정렬 → 차이(delta)로 적기
kept.sort(key=lambda p: (p[0] // 2000, p[1] // 2000, p[0], p[1]))
# 도로 이름 표: 많이 나오는 이름이 작은 번호 (0 = 모름)
freq = Counter(p[3] for p in kept if p[3])
names = [''] + [n for n, _ in freq.most_common()]
idx = {n: i for i, n in enumerate(names)}
d, plat, plng = [], 0, 0
for p in kept:
    d += [p[0] - plat, p[1] - plng, idx[p[3]] * 2 + p[2]]
    plat, plng = p[0], p[1]
latest = max(dates) if dates else ''
with open(out, 'w', encoding='utf-8') as f:
    json.dump({'v': 2, 'scale': 100000, 'date': latest, 'count': len(kept), 'names': names, 'd': d}, f, ensure_ascii=False, separators=(',', ':'))
print('rows', len(rows) - 1, 'kept', len(kept), 'skipped', dict(skipped), 'continuous', sum(p[2] for p in kept), 'date', latest,
      'with road name', sum(1 for p in kept if p[3]), 'names', len(names) - 1)
