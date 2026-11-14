"""전국무인교통단속카메라표준데이터 CSV -> 페이지용 압축 JSON (v2).

rows: [lat, lng, limit, kind, sec, len, zone, road, rtype, dir(, flags)]
kind : 1 과속, 2 신호 전용, 3 과속+신호, 9 구간단속/기타
       (원본 단속구분: 1=속도, 2=신호, '01+02'=속도+신호, 3=통행위반, 4=주정차, 99=기타)
       원본 '신호(2)'라도 제한속도가 있으면 3(신호·과속)으로 바꾼다 (아래 설명). 2 는 제한속도가 없는 것만 남는다.
sec  : 0 없음, 1 구간 시점, 2 구간 종점
len  : 구간 길이 m
zone : 0 없음, 1 노인보호구역, 2 어린이보호구역
road : roads[] 의 번호 (도로노선명, 없으면 -1)
rtype: 1 고속국도, 3 일반국도, 4 지방도, 5 시도(특별·광역시도 포함), 6 군도·구도·기타
dir  : 도로노선방향 1 상행, 2 하행, 3 양방향, 0 모름 (같은 자리에 상행·하행이 따로 있으면 3으로 합친다)
flags: 1 후면 단속 (지나간 뒤 차 뒤를 찍는다), 2 박스형 (단속 부스. 원본 경찰청 데이터에는 없다). 원본에는 이 구분이 없어서
       직접 확인한 것만 있고, 그 줄에만 11번째 값으로 붙는다 (나머지 줄은 10개 그대로). 예전 'rear'(1)와 같은 자리

사용법: py -I tools/build_cams.py <원본.csv> data/cameras.json
원본 CSV: data.go.kr '전국무인교통단속카메라표준데이터' (cp949). 새 원본으로 다시 만들어도 아래 FIXES 는 그대로 적용된다.
"""
import csv
import io
import json
import re
import sys
from collections import Counter

src, out = sys.argv[1], sys.argv[2]
rows = list(csv.reader(io.StringIO(open(src, 'rb').read().decode('cp949'))))[1:]


# 설치장소의 방향 표시: '(A→B)', 'A->B', 'A⇒B', 'A▶B'
PLACE_ARROW = re.compile(r'→|->|⇒|▶|=>')
ARROW_PAREN = re.compile(r'\(([^()]*?(?:→|->|⇒|▶|=>)[^()]*)\)')
ARROW_SPLIT = re.compile(r'\s*(?:→|->|⇒|▶|=>)\s*')


def arrow_ends(place):
    """설치장소 '창우지하차도 지나 250m 지점(하남ic->팔당대교)' -> ('하남ic', '팔당대교').
    앱이 길안내 경로의 앞뒤 안내 문구('팔당대교IC에서 …', '하남IC에서 …')와 맞춰 한 방향 카메라의 방향을 가른다.
    공백을 빼고 소문자로, 끝의 '방면·방향·쪽'은 뗀다. 두 글자 미만이면 버린다"""
    m = ARROW_PAREN.findall(place)
    parts = ARROW_SPLIT.split(m[-1] if m else place)
    if len(parts) != 2:
        return None
    ends = [re.sub(r'(방면|방향|쪽)$', '', re.sub(r'\s+', '', x).lower()) for x in parts]
    return tuple(ends) if all(len(e) >= 2 for e in ends) else None


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

# 원본에 아예 없는 카메라 (직접 달려 보고 확인한 것). 좌표는 그 방향 차로 쪽 길가에 둔다:
# 앱은 한 방향 카메라가 내 진행 방향 왼쪽으로 8m 넘게 있으면 반대편 차로용으로 보고 빼기 때문.
ADDS = [
    # 2026-11-14 주행 제보: 가평읍 상색리 경춘로 포회촌마을입구교차로, 가평→서울(남서행) 제한 70 신호·과속 후면단속.
    # 원본에는 같은 교차로의 반대 방향(H7738, 청평→가평군청, 과속 60)만 있다.
    # 남서행 네이버 경로 기준 정지선 쪽(교차로 12m 앞) 오른쪽 12m. 북동행 경로에서는 왼쪽 21m 라 잡히지 않는다.
    {'id': 'U0001', 'lat': 37.79681, 'lng': 127.48014, 'limit': 70, 'kind': 3, 'road': '경춘로', 'rtype': 3, 'dir': 2, 'rear': 1},
    # 2026-11-14 주행 제보: 남양주 와부읍 팔당리 다산로(강변 옛길), 양평→팔당대교IC(북서행) 제한 60 박스형 과속 단속.
    # 원본(경찰청)에는 박스형이 없다. 다른 내비가 팔당대교IC 2km 앞에서 239m 앞으로 알린 자리 = 네이버 경로에서 IC 1.76km 앞(±50m).
    # 북서행 경로 오른쪽 10m. 남동행 경로에서는 왼쪽 10m 라 반대편으로 보고 잡히지 않는다.
    {'id': 'U0002', 'lat': 37.53968, 'lng': 127.25632, 'limit': 60, 'kind': 1, 'road': '다산로', 'rtype': 4, 'dir': 1, 'box': 1},
]

roads, road_idx = [], {}
seen = {}
data = []
arrow_of = {}   # id(row) -> (A, B): 설치장소에 적힌 방향 'A→B'
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
    # 구간단속인데 '단속구간위치구분'이 비어 있고 설치장소에만 '구간 시점/종점'이 적힌 카메라 (2026-11-14 점검: 29대.
    # 예: 영덕 동해대로 '구간 시점(영해휴게소 방면)', 울산 아산로 '아산로구간단속종점1', 세종로 '대곡삼거리 후방 구간단속 시점')
    if not sec and '구간' in r[11] and not ('4' in {norm(c) for c in r[12].replace(' ', '').split('+')} and not r[13].strip('0 ')):
        if '시점' in r[11]:
            sec = 1
            skipped['(info) section start from place text'] += 1
        elif '종점' in r[11]:
            sec = 2
            skipped['(info) section end from place text'] += 1
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
    # 원본의 '신호(2)'는 대부분 교차로 다기능 카메라(신호·과속)다: 신호 전용이 1만 8천여 대인데 99% 넘게 제한속도가 적혀 있고
    # 대부분 2019년 이후 설치. 실제로 달려 보니 계량교(30)·청평 경춘로 카메라들이 과속도 찍는데 '신호'로만 올라 있었다.
    # 그래서 제한속도가 있는 신호 카메라는 신호·과속(3)으로 본다. 제한속도가 없는(0) 것만 신호 전용으로 남긴다.
    if kind == 2 and limit > 0:
        kind = 3
        skipped['(info) signal→signal+speed'] += 1
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
    # 보호구역 코드가 비어 있어도(99 등) 설치장소에 '어린이보호구역'·'스쿨존'·'노인보호구역'이 적혀 있으면 보호구역으로 본다
    if not zone:
        place = r[11]
        if '어린이보호' in place or '스쿨존' in place:
            zone = 2
            skipped['(info) zone from place text'] += 1
        elif '노인보호' in place:
            zone = 1
            skipped['(info) zone from place text'] += 1
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
    # 과속 전용 카메라는 설치장소에 '(A→B)'처럼 방향이 적혀 있으면, 방향 코드가 '양방향(3)'이어도 한 방향만 찍는다.
    # (2026-11-14 주행: 양서면 북한강로 '골용진 입구(용늪삼거리→양평수난구조대)' J2675 는 코드가 양방향이라
    #  반대편(남행)에서도 떴다. 실제로는 북행 전용이고 남행 경로에서 왼쪽 9m.) 한 방향(1)으로 두면 앱이 좌우로 가른다.
    #  교차로 신호·과속(3)은 화살표가 있어도 실제로 여러 방향을 찍는 경우가 많아 그대로 둔다
    if kind == 1 and not sec and direction == 3 and PLACE_ARROW.search(r[11]):
        direction = 1
        skipped['(info) speed-only one-way from place arrow'] += 1
    key = (round(lat, 5), round(lng, 5), limit, kind, sec)
    if key in seen:
        prev = seen[key]
        if prev[9] != direction:
            prev[9] = 3 if (prev[9] and direction) else (prev[9] or direction)
        skipped['dup'] += 1
        continue
    row = [round(lat, 5), round(lng, 5), limit, kind, sec, length, zone, ri, rtype, direction]
    flags = (1 if fix and fix.get('rear') else 0) | (2 if fix and fix.get('box') else 0)
    if flags:
        row.append(flags)
    ends = arrow_ends(r[11]) if PLACE_ARROW.search(r[11]) else None
    if ends:
        arrow_of[id(row)] = ends
    seen[key] = row
    data.append(row)
    dates[r[20]] += 1

for a in ADDS:
    name = a['road']
    if name not in road_idx:
        road_idx[name] = len(roads)
        roads.append(name)
    row = [a['lat'], a['lng'], a['limit'], a['kind'], 0, 0, a.get('zone', 0), road_idx[name], a['rtype'], a['dir']]
    flags = (1 if a.get('rear') else 0) | (2 if a.get('box') else 0)
    if flags:
        row.append(flags)
    data.append(row)
    fixed[a['id']] += 1
FIXES.update({a['id']: a for a in ADDS})   # 아래 'NOT FOUND' 확인에 함께 넣는다

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

# 교차로 신호·과속 카메라는 원본에 한 방향(상행/하행)만 올라 있어도 실제로는 반대 방향도 찍는 경우가 많다.
# 2026-11-14 가평→청평 주행: 포회촌·수리재마을입구·청평검문소·소돌마을 교차로가 원본엔 '서울→춘천'만 있는데
# 서울 방향에도 카메라가 있었다(다른 내비에는 다 뜸). 앱은 한 방향 카메라가 왼쪽(반대 차로)에 있으면 빼므로 하나도 안 떴다.
# 그래서 같은 도로 150m 안에 반대 방향 카메라가 따로 등록돼 있지 않으면 양방향(3)으로 본다.
# 과속 전용(1)은 구간 중간에 한쪽만 보는 경우가 많아 그대로 둔다. 직접 추가한 카메라(ADDS)도 그대로.
PAIR_R = 150
added = {(a['lat'], a['lng']) for a in ADDS}
pcells = {}
for row in data:
    pcells.setdefault((int(math.floor(row[0] / 0.002)), int(math.floor(row[1] / 0.002))), []).append(row)
def has_opposite(row):
    cy, cx = int(math.floor(row[0] / 0.002)), int(math.floor(row[1] / 0.002))
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            for o in pcells.get((cy + dy, cx + dx), ()):
                if o is row or o[3] == 9 or dist_m(o, row) > PAIR_R:
                    continue
                if not (o[7] == row[7] or o[7] < 0 or row[7] < 0):
                    continue
                if o[9] == 3 or (o[9] and o[9] != row[9]):
                    return True
    return False
both = [row for row in data if row[3] == 3 and row[9] in (1, 2) and not row[4]
        and (row[0], row[1]) not in added and not has_opposite(row)]
for row in both:
    row[9] = 3
print('signal+speed cameras with no opposite-direction partner -> both directions:', len(both))
latest = max(d for d in dates if d)
# 한 방향(1·2) 카메라 중 설치장소에 'A→B'가 적힌 것: [행 번호, A, B]. 좌표가 도로 한가운데라 좌우로 못 가르는 경우
# (2026-11-14 하남 창우로 J2735 '(하남ic->팔당대교)' 60 이 팔당대교→하남IC 로 갈 때 떴다) 앱이 안내 문구로 가른다
# 같은 지명이 많아서 지명 표(arrowNames)의 번호로 적는다: arrows = [행 번호, A 번호, B 번호, ...] 를 한 줄로 이어 붙임
arrow_names, arrow_ni, arrows = [], {}, []
def name_no(x):
    if x not in arrow_ni:
        arrow_ni[x] = len(arrow_names)
        arrow_names.append(x)
    return arrow_ni[x]
for i, row in enumerate(data):
    if id(row) in arrow_of and row[9] in (1, 2):
        a_, b_ = arrow_of[id(row)]
        arrows += [i, name_no(a_), name_no(b_)]
print('one-way cameras with A-B place text:', len(arrows) // 3, 'names', len(arrow_names))
with open(out, 'w', encoding='utf-8') as f:
    json.dump({'v': 2, 'date': latest, 'count': len(data),
               'fields': ['lat', 'lng', 'limit', 'kind', 'sec', 'len', 'zone', 'road', 'rtype', 'dir', 'flags'],
               'roads': roads, 'rows': data, 'arrowNames': arrow_names, 'arrows': arrows}, f, ensure_ascii=False, separators=(',', ':'))

print('kept', len(data), 'roads', len(roads), 'skipped', dict(skipped))
print('kinds', Counter(d[3] for d in data))
print('rtypes', Counter(d[8] for d in data))
print('dirs', Counter(d[9] for d in data), 'speed-cam dirs', Counter(d[9] for d in data if d[3] in (1, 3, 9)))
print('latest date', latest)
missing = sorted(set(FIXES) - set(fixed))
print('fixes applied', dict(fixed), 'NOT FOUND' if missing else '', missing if missing else '')
