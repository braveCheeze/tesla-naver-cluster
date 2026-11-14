"""전국무인교통단속카메라표준데이터 CSV -> 페이지용 압축 JSON (v2).

rows: [lat, lng, limit, kind, sec, len, zone, road, rtype, dir]
kind : 1 과속, 2 신호 전용, 3 과속+신호, 9 구간단속/기타
       (원본 단속구분: 1=속도, 2=신호, '01+02'=속도+신호, 3=통행위반, 4=주정차, 99=기타)
sec  : 0 없음, 1 구간 시점, 2 구간 종점
len  : 구간 길이 m
zone : 0 없음, 1 노인보호구역, 2 어린이보호구역
road : roads[] 의 번호 (도로노선명, 없으면 -1)
rtype: 1 고속국도, 3 일반국도, 4 지방도, 5 시도(특별·광역시도 포함), 6 군도·구도·기타
dir  : 도로노선방향 1 상행, 2 하행, 3 양방향, 0 모름 (같은 자리에 상행·하행이 따로 있으면 3으로 합친다)

사용법: py -I tools/build_cams.py <원본.csv> data/cameras.json
원본 CSV: data.go.kr '전국무인교통단속카메라표준데이터' (cp949). 새 원본으로 다시 만들어도 아래 FIXES 는 그대로 적용된다.
"""
import csv
import io
import json
import sys
from collections import Counter

src, out = sys.argv[1], sys.argv[2]
rows = list(csv.reader(io.StringIO(open(src, 'rb').read().decode('cp949'))))[1:]


def norm(code):
    return code.strip().lstrip('0') or '0'


RTYPE = {'고속국도': 1, '일반국도': 3, '국가지원지방도': 4, '지방도': 4, '특별시도': 5, '광역시도': 5, '시도': 5,
         '군도': 6, '구도': 6, '기타': 6}

# 직접 달려 보고 확인한 원본 데이터 보정 (관리번호 -> 바꿀 값).
# 원본에 '신호 전용(2)'으로만 올라 있지만 실제로는 과속도 찍는 카메라는 kind 3(신호·과속)으로 고친다.
# 신호 전용 카메라는 앱에서 기본으로 알리지 않으므로, 이렇게 고쳐야 과속 경고가 나온다.
FIXES = {
    # 2026-11-14 주행 제보: 가평읍 가화로 계량교, 제한 30 과속 단속인데 안 잡힘 (원본: 신호 전용, 제한 30)
    'H4877': {'kind': 3},   # 계량교 지나 50m (마장리→대곡리)
    'H4878': {'kind': 3},   # 승안삼거리 (대곡리→마장리), 같은 교차로 반대 방향
}
fixed = Counter()

roads, road_idx = [], {}
seen = {}
data = []
skipped = Counter()
dates = Counter()
for r in rows:
    try:
        lat, lng = float(r[9]), float(r[10])
    except ValueError:
        skipped['coord'] += 1
        continue
    if not (33 < lat < 39 and 124 < lng < 132):
        skipped['coord'] += 1
        continue
    try:
        limit = int(float(r[13] or 0))
    except ValueError:
        limit = 0
    code = r[12].strip()
    parts = {norm(c) for c in code.replace(' ', '').split('+')}
    sec = {'1': 1, '2': 2}.get(norm(r[14]), 0)
    if parts & {'3', '4'} and not parts & {'1', '2'} and not sec:
        skipped['parking/other'] += 1
        continue
    if '99' in parts or sec:
        kind = 9
    elif '1' in parts and '2' in parts:
        kind = 3
    elif '2' in parts:
        kind = 2
    elif '1' in parts:
        kind = 1
    else:
        skipped['unknown kind'] += 1
        continue
    fix = FIXES.get(r[0].strip())
    if fix:
        kind = fix.get('kind', kind)
        limit = fix.get('limit', limit)
        fixed[r[0].strip()] += 1
    if limit <= 0 and kind != 2:
        skipped['limit0'] += 1
        continue
    try:
        length = int(round(float(r[15]) * 1000)) if r[15].strip() else 0
    except ValueError:
        length = 0
    zone = {'1': 1, '2': 2}.get(norm(r[16]), 0)
    name = r[5].strip()
    if name:
        if name not in road_idx:
            road_idx[name] = len(roads)
            roads.append(name)
        ri = road_idx[name]
    else:
        ri = -1
    rtype = RTYPE.get(r[3].strip(), 6)
    direction = {'1': 1, '2': 2, '3': 3}.get(norm(r[6]), 0)
    key = (round(lat, 5), round(lng, 5), limit, kind, sec)
    if key in seen:
        prev = seen[key]
        if prev[9] != direction:
            prev[9] = 3 if (prev[9] and direction) else (prev[9] or direction)
        skipped['dup'] += 1
        continue
    row = [round(lat, 5), round(lng, 5), limit, kind, sec, length, zone, ri, rtype, direction]
    seen[key] = row
    data.append(row)
    dates[r[20]] += 1

data.sort()

# 거의 같은 자리(15m 안)에 같은 종류·구간·제한속도의 카메라가 여러 건이면 하나로 합친다
# (같은 단속기를 두 번 등록했거나, 한 기둥에서 양쪽 방향을 찍는 경우). 방향이 서로 다르면 양방향(3)으로.
import math
def dist_m(a, b):
    dy = (a[0] - b[0]) * 110540
    dx = (a[1] - b[1]) * 111320 * math.cos(math.radians(a[0]))
    return math.hypot(dx, dy)
cells = {}
merged = []
dropped = 0
for row in data:
    cy, cx = int(math.floor(row[0] / 0.001)), int(math.floor(row[1] / 0.001))
    hit = None
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            for o in cells.get((cy + dy, cx + dx), ()):
                if o[2] == row[2] and o[3] == row[3] and o[4] == row[4] and dist_m(o, row) <= 15:
                    hit = o
                    break
            if hit: break
        if hit: break
    if hit:
        if hit[9] != row[9]:
            hit[9] = 3 if (hit[9] and row[9]) else (hit[9] or row[9])
        hit[5] = max(hit[5], row[5])
        hit[6] = max(hit[6], row[6])
        if hit[7] < 0: hit[7] = row[7]
        dropped += 1
        continue
    cells.setdefault((cy, cx), []).append(row)
    merged.append(row)
print('merged near-identical cameras:', dropped)
data = merged
latest = max(d for d in dates if d)
with open(out, 'w', encoding='utf-8') as f:
    json.dump({'v': 2, 'date': latest, 'count': len(data),
               'fields': ['lat', 'lng', 'limit', 'kind', 'sec', 'len', 'zone', 'road', 'rtype', 'dir'],
               'roads': roads, 'rows': data}, f, ensure_ascii=False, separators=(',', ':'))

print('kept', len(data), 'roads', len(roads), 'skipped', dict(skipped))
print('kinds', Counter(d[3] for d in data))
print('rtypes', Counter(d[8] for d in data))
print('dirs', Counter(d[9] for d in data), 'speed-cam dirs', Counter(d[9] for d in data if d[3] in (1, 3, 9)))
print('latest date', latest)
missing = sorted(set(FIXES) - set(fixed))
print('fixes applied', dict(fixed), 'NOT FOUND' if missing else '', missing if missing else '')
