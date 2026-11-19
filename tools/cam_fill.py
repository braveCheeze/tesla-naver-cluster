"""단속 카메라 자료 마지막 단계 (v164): 도로 종류·빈 제한속도를 OSM 길과 같은 길 카메라로 채우고, 운전자 '틀림' 풀 목록을 만든다.

    py -I -X utf8 tools/cam_fill.py D:/osm/south-korea-latest.osm.pbf --old <예전 cameras.json·mobile.json 이 있는 폴더>

순서: build_cams.py → build_mobile.py → osm_cams.py → osm_arrows.py → osm_stopline.py → cam_fill.py
(--old 에는 다시 만들기 전 data/ 의 두 파일을 복사해 둔 폴더를 준다. 없으면 unflag 는 예전 것을 그대로 둔다)

1. 도로 종류 (이동식·부스, mobile.json): 카메라가 붙은 차로(dirs 의 차로 위 점)가 OSM 고속도로 본선(motorway, 이름이 '…고속도로'·'…고속국도',
   도시고속도로 제외)이면 고속국도(1). 원본 글에 '고속'·'NNk' 가 없어 지방도(4)로 들어간 고속도로 부스 57곳(경부·중부·중부내륙·평택제천·
   중앙·서산영덕·당진청주)이 앱의 '고속도로 위 70 이하 일반도로 카메라 빼기'에 걸려 안 떴다. 고속국도(1)로 바뀐 지점의 제한이 70 이하이면
   같은 고속도로 고정 카메라(15km 안, 80 이상) 값, 없으면 가까운 고속국도 카메라(3km 안), 그것도 없으면 100.
2. 빈 제한속도 (이동식 2,616곳 중 1,186곳이 0 이라 화면에 '?', 과속 경고 없음 / 고정 카메라 중 원본에 제한이 빠진 것):
   a. 같은 OSM 길(이름) 위, 찍는 방향이 50° 안인 고정 과속 카메라(1·3)가 1.2km 안에 있으면 가장 가까운 것의 값 (보호구역 여부도 같은 것)
   b. 없으면 그 OSM 길의 maxspeed (20~120), 그것도 없으면 450m 안 같은 이름 길 조각들의 maxspeed 중 가장 많은 값
   c. 없으면 어린이보호구역이면 30
   d. 그래도 없으면 0 그대로 ('?')
3. unflag (mobile.json): --old 와 같은 자리(위도·경도)인데 제한속도·종류가 바뀐 행의 '위도,경도' + 예전 unflag 목록.
   앱은 운전자가 그 자리에 예전에 누른 '틀림'(그 방향 숨김)을 한 번 푼다 (틀린 값 때문에 누른 틀림이 고친 뒤에도 남으면 그대로 놓친다).
"""
import json
import math
import os
import re
import sys
from collections import Counter, defaultdict
from datetime import date

sys.path.insert(0, r'D:\pylib')
import osmium  # noqa: E402

PBF = sys.argv[1] if len(sys.argv) > 1 and not sys.argv[1].startswith('--') else r'D:\osm\south-korea-latest.osm.pbf'
OLD = sys.argv[sys.argv.index('--old') + 1] if '--old' in sys.argv else None
ROOT = __file__.rsplit('tools', 1)[0]
FILES = [ROOT + 'data/cameras.json', ROOT + 'data/mobile.json']
ROADS = {'motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'living_street',
         'motorway_link', 'trunk_link', 'primary_link', 'secondary_link', 'tertiary_link', 'road'}
CELL = 0.001
KY = 110540.0
SNAP = 12.0       # 차로 위 점에서 이 안의 길


def kx(lat):
    return 111320.0 * math.cos(math.radians(lat))


def dist(a, b):
    return math.hypot((a[0] - b[0]) * KY, (a[1] - b[1]) * kx((a[0] + b[0]) / 2))


def angd(a, b):
    return abs((a - b + 540) % 360 - 180)


def squash(s):
    return re.sub(r'\s+', '', s or '')


def is_expressway(name):
    n = squash(name)
    return bool(re.search(r'고속도로|고속국도', n)) and '도시고속' not in n


def hwy_key(name):
    s = re.sub(r'\(.*?\)', '', squash(name))
    s = s.replace('서울외곽순환', '수도권제1순환')
    s = re.sub(r'(고속도로|고속국도|선)$', '', s)
    return re.sub(r'제(?=\d)', '', s)


def maxspeed(v):
    m = re.match(r'^\s*(\d{2,3})\s*$', v or '')
    return int(m.group(1)) if m and 20 <= int(m.group(1)) <= 120 else 0


cam, mob = [json.load(open(f, encoding='utf-8')) for f in FILES]
names = cam['osmNames']


def lane(c, d):
    return (c[0] + d[2] / 1e5, c[1] + d[3] / 1e5) if d and d[0] >= 0 else (c[0], c[1])


# 고칠 대상: 이동식 전부 + 제한이 0 인 고정 카메라
targets = [(1, i) for i in range(len(mob['rows']))] + [(0, i) for i, c in enumerate(cam['rows']) if c[2] == 0 and c[3] != 2]
cells = set()
wide = set()   # 제한이 0 인 대상 둘레 약 400m: 같은 이름 길의 maxspeed 를 찾는다
WIDE = 4
for di, i in targets:
    d = (cam, mob)[di]
    p = lane(d['rows'][i], d['dirs'][i])
    cy, cx = int(math.floor(p[0] / CELL)), int(math.floor(p[1] / CELL))
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            cells.add((cy + dy, cx + dx))
    if d['rows'][i][2] == 0:
        for dy in range(-WIDE, WIDE + 1):
            for dx in range(-WIDE, WIDE + 1):
                wide.add((cy + dy, cx + dx))


class H(osmium.SimpleHandler):
    def __init__(self):
        super().__init__()
        self.ways = []
        self.named = {}   # 이름 -> [(점 열, maxspeed)] (넓은 둘레, maxspeed 있는 길만)
        self.all_names = set()   # 전국 차도 이름 (오타 판단: 원본 도로명이 OSM 어디에도 없을 때만 오타)


    def way(self, w):
        hw = w.tags.get('highway')
        if hw not in ROADS:
            return
        try:
            pts = [(n.lat, n.lon) for n in w.nodes]
        except osmium.InvalidLocationError:
            return
        if len(pts) < 2:
            return
        hit = far = False
        for k in range(len(pts) - 1):
            (la1, lo1), (la2, lo2) = pts[k], pts[k + 1]
            for cy in range(int(math.floor(min(la1, la2) / CELL)), int(math.floor(max(la1, la2) / CELL)) + 1):
                for cx in range(int(math.floor(min(lo1, lo2) / CELL)), int(math.floor(max(lo1, lo2) / CELL)) + 1):
                    if (cy, cx) in cells:
                        hit = True
                        break
                    if (cy, cx) in wide:
                        far = True
                if hit:
                    break
            if hit:
                break
        ms, nm = maxspeed(w.tags.get('maxspeed')), w.tags.get('name', '') or ''
        if nm:
            self.all_names.add(squash(nm))
        if hit:
            self.ways.append((pts, hw, nm, w.tags.get('ref', '') or '', ms))
        elif far and ms and nm:
            self.named.setdefault(squash(nm), []).append((pts, ms))


h = H()
h.apply_file(PBF, locations=True, idx='flex_mem')
ways = h.ways
seg_grid = defaultdict(list)
for wi, (pts, *_r) in enumerate(ways):
    for k in range(len(pts) - 1):
        (la1, lo1), (la2, lo2) = pts[k], pts[k + 1]
        for cy in range(int(math.floor(min(la1, la2) / CELL)), int(math.floor(max(la1, la2) / CELL)) + 1):
            for cx in range(int(math.floor(min(lo1, lo2) / CELL)), int(math.floor(max(lo1, lo2) / CELL)) + 1):
                seg_grid[(cy, cx)].append((wi, k))
print('ways', len(ways), 'targets', len(targets))


def way_at(p, want_name):
    """차로 위 점 p 에서 SNAP 안의 길: 이름이 같은 것 먼저, 그다음 가까운 것 → (hw, name, ref, maxspeed)"""
    best = None
    KX = kx(p[0])
    cy, cx = int(math.floor(p[0] / CELL)), int(math.floor(p[1] / CELL))
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            for wi, k in seg_grid.get((cy + dy, cx + dx), ()):
                pts = ways[wi][0]
                (la1, lo1), (la2, lo2) = pts[k], pts[k + 1]
                ax, ay = (lo1 - p[1]) * KX, (la1 - p[0]) * KY
                bx, by = (lo2 - p[1]) * KX, (la2 - p[0]) * KY
                vx, vy = bx - ax, by - ay
                L2 = vx * vx + vy * vy
                t = 0.0 if not L2 else max(0.0, min(1.0, -(ax * vx + ay * vy) / L2))
                dd = math.hypot(ax + t * vx, ay + t * vy)
                if dd > SNAP:
                    continue
                key = (0 if want_name and squash(ways[wi][2] or ways[wi][3]) == squash(want_name) else 1, dd)
                if best is None or key < best[0]:
                    best = (key, wi)
    return ways[best[1]][1:] if best else None


def named_maxspeed(p, name, r=450.0):
    """그 길에 maxspeed 가 없을 때: 같은 이름 길 조각(r 안)의 maxspeed 중 가장 많은 값 (붙은 조각에만 적힌 경우가 많다)"""
    vals = Counter()
    for pts, ms in list(h.named.get(squash(name), [])) + [(w[0], w[4]) for w in ways if w[4] and squash(w[2]) == squash(name)]:
        if any(dist(p, q) <= r for q in pts):
            vals[ms] += 1
    return vals.most_common(1)[0][0] if vals else 0


# 고정 카메라: 같은 OSM 길 이름·같은 방향에서 값 빌리기
fixed = cam['rows']
fgrid = defaultdict(list)
for i, c in enumerate(fixed):
    if c[3] in (1, 3) and c[2] > 0:
        fgrid[(int(math.floor(c[0] / 0.01)), int(math.floor(c[1] / 0.01)))].append(i)
froads = cam.get('roads') or []


def same_road_limit(c, d, zone):
    if not d or d[0] < 0 or d[5] < 0:
        return 0
    nm = names[d[5]]
    if not nm:
        return 0
    p = lane(c, d)
    best = None
    gy, gx = int(math.floor(p[0] / 0.01)), int(math.floor(p[1] / 0.01))
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            for i in fgrid.get((gy + dy, gx + dx), ()):
                o, od = fixed[i], cam['dirs'][i]
                if od[0] < 0 or od[5] < 0 or names[od[5]] != nm or (o[6] == 2) != (zone == 2):
                    continue
                if not od[1] and not d[1] and angd(od[0], d[0]) > 50:
                    continue
                dd = dist(p, lane(o, od))
                if dd <= 1200 and (best is None or dd < best[0]):
                    best = (dd, o[2])
    return best[1] if best else 0


def hwy_limit(c, name):
    key = hwy_key(name)
    near = sorted((dist((c[0], c[1]), (o[0], o[1])), o) for o in fixed if o[8] == 1 and o[2] >= 80
                  and abs(o[0] - c[0]) < 0.15 and abs(o[1] - c[1]) < 0.18)
    near = [(dd, o) for dd, o in near if dd <= 15000]
    for dd, o in near:
        if 0 <= o[7] < len(froads) and hwy_key(froads[o[7]]) == key:
            return o[2]
    for dd, o in near:
        if dd <= 3000:
            return o[2]
    return 100


st = Counter()
for di, i in targets:
    d = (cam, mob)[di]
    c, dr = d['rows'][i], d['dirs'][i]
    w = way_at(lane(c, dr), names[dr[5]] if dr and dr[5] >= 0 else '')
    hw, wname, wref, wmax = w if w else ('', '', '', 0)
    if di == 1 and hw == 'motorway' and (is_expressway(wname) or (not wname and re.match(r'^\d+$', wref or ''))) and c[8] != 1:
        c[8] = 1
        st['mobile: expressway by OSM (rtype → 1)'] += 1
        if c[2] <= 70:
            c[2] = hwy_limit(c, wname)
            st['mobile: expressway limit set'] += 1
    if c[2] == 0:
        v = same_road_limit(c, dr, c[6])
        how = 'same road camera'
        if not v and wmax:
            v, how = wmax, 'OSM maxspeed'
        if not v and (wname or (dr and dr[5] >= 0 and names[dr[5]])):
            v = named_maxspeed(lane(c, dr), wname or names[dr[5]])
            how = 'OSM maxspeed of the same road nearby'
        if not v and c[8] == 1 and hw == 'motorway':
            v, how = hwy_limit(c, wname), 'expressway'
        if not v and c[6] == 2:
            v, how = 30, 'school zone'
        if v:
            c[2] = v
            st[('mobile' if di else 'fixed') + ' limit from ' + how] += 1
        else:
            st[('mobile' if di else 'fixed') + ' limit still unknown'] += 1

# 고정 카메라 도로 종류·도로 이름 (v164, 2026-11-20 서울·경기 가상 주행 점검)
#  - OSM 고속도로 본선(motorway, 또는 이름이 '…고속도로'인 trunk)에 붙었는데 원본이 시도(5) 등인 카메라 → 고속국도(1) (경부고속도로 서울 구간 80,
#    수원광명 100: 앱이 3km 가 아니라 1km 앞에서 알렸다). 원본 도로명이 고속도로이거나 비었거나 OSM 이름과 같을 때만
#    (고속도로 이름은 OSM·경찰청·네이버 표기가 서로 달라(동해/부산포항, 중앙지선/대구부산) 자동으로 바꾸지 않는다. 틀린 것은 build_cams.py FIXES)
#  - 원본 도로명이 OSM 이름과 한 글자만 다르고(숫자 아님) 그 원본 이름의 길이 OSM 전국 어디에도 없으면 오타로 보고 OSM 이름으로
#    ('호극로'→'호국로', '송타공원로'→'송탄공원로', '안성만춤대로'→'안성맞춤대로'. '대학로'·'목동동로' 처럼 있는 길은 그대로).
#    바꾼 목록은 cameras.json 의 roadFix
hwc = cam.pop('dirsHw', None) or []
mob.pop('dirsHw', None)
froads = cam['roads']
road_no = {n: k for k, n in enumerate(froads)}


def road_index(n):
    if n not in road_no:
        road_no[n] = len(froads)
        froads.append(n)
    return road_no[n]


def one_char_typo(a, b):
    a, b = squash(a), squash(b)
    if len(a) != len(b) or len(a) < 3 or a == b:
        return False
    diff = [(x, y) for x, y in zip(a, b) if x != y]
    return len(diff) == 1 and not (diff[0][0].isdigit() or diff[0][1].isdigit())


road_fix = Counter()
for i, c in enumerate(fixed):
    d = cam['dirs'][i]
    if not d or d[0] < 0 or d[5] < 0:
        continue
    on = names[d[5]]
    pn = froads[c[7]] if c[7] >= 0 else ''
    hw = hwc[i] if i < len(hwc) else ''
    if hw in ('m', 't') and is_expressway(on):   # 경부고속도로 서울 구간은 OSM 에 trunk
        if c[8] != 1 and (not pn or re.search('고속', pn) or squash(pn) == squash(on)):
            c[8] = 1
            st['fixed: expressway by OSM (rtype → 1)'] += 1
    if pn and on and one_char_typo(pn, on) and squash(pn) not in h.all_names:
        road_fix[pn + ' → ' + on] += 1
        c[7] = road_index(on)
        st['fixed: one-letter road name typo'] += 1
# 같은 오타가 두 행 넘게 고쳐졌으면 그 이름의 나머지 행도 (OSM 이름 없는 길에 붙은 행: 호극로 8대 중 1대)
typo_map = {}
for k, v in road_fix.items():
    a_, b_ = k.split(' → ')
    if v >= 2 and squash(a_) not in h.all_names:
        typo_map[a_] = b_
for i, c in enumerate(fixed):
    pn = froads[c[7]] if c[7] >= 0 else ''
    if pn in typo_map:
        road_fix[pn + ' → ' + typo_map[pn]] += 1
        c[7] = road_index(typo_map[pn])
        st['fixed: one-letter road name typo (same name elsewhere)'] += 1
cam['roads'] = froads
if road_fix:
    cam['roadFix'] = dict(sorted(road_fix.items()))

# unflag
if OLD and os.path.isdir(OLD):
    keys = set()
    for f, d in zip(('cameras.json', 'mobile.json'), (cam, mob)):
        try:
            old = json.load(open(os.path.join(OLD, f), encoding='utf-8'))
        except (OSError, ValueError):
            continue
        was = defaultdict(set)
        for r in old.get('rows', []):
            was[(r[0], r[1])].add((r[2], r[3]))
        for r in d['rows']:
            k = (r[0], r[1])
            if k in was and (r[2], r[3]) not in was[k]:
                keys.add('%s,%s' % (json.dumps(r[0]), json.dumps(r[1])))
        if f == 'mobile.json' and old.get('unflag'):
            prev = set(old['unflag'].get('keys') or [])
            st['unflag: kept from before'] = len(prev - keys)
            keys |= prev
    if keys:
        mob['unflag'] = {'id': date.today().isoformat() + '-' + str(len(keys)), 'keys': sorted(keys)}
    st['unflag keys'] = len(keys)
for f, d in zip(FILES, (cam, mob)):
    d['count'] = len(d['rows'])
    with open(f, 'w', encoding='utf-8') as fh:
        json.dump(d, fh, ensure_ascii=False, separators=(',', ':'))
print(dict(st))
print('mobile limit 0 left', sum(1 for c in mob['rows'] if c[2] == 0), 'of', len(mob['rows']),
      '· fixed limit 0 left', sum(1 for c in cam['rows'] if c[2] == 0 and c[3] != 2))
