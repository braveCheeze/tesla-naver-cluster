"""단속 카메라를 OSM 도로망에 붙여 '어느 도로의 어느 진행 방향을 찍는지'를 계산한다 (v123 카메라 개편).

    py -X utf8 tools/osm_cams.py D:/osm/south-korea-latest.osm.pbf

data/cameras.json 과 data/mobile.json 의 각 카메라에 대해:
  1. 45m 안의 차도(motorway~residential, *_link) 중 하나를 고른다. 원본 도로명과 이름이 같은 길을 먼저, 그다음 가까운 길.
     터널(지하차도) 안 길은 카메라가 터널 안에 있을 때만 (이름이 같거나 바깥 길이 없을 때).
  2. 찍는 방향(진행 방위각)을 정한다. 한국은 우측통행이라 카메라는 자기가 찍는 차로의 오른쪽 길가(또는 머리 위)에 선다.
     - 일방통행 길(고속도로·분리된 큰길의 한쪽 차로): 그 길의 진행 방향. 단, 카메라가 그 길 왼쪽에 있고 반대쪽 차로 길이
       가까이 있으면 그쪽을 찍는 것으로 본다(분리대 건너편).
     - 양방향 길: 길 가운데선에서 오른쪽(+)이면 정방향, 왼쪽(-)이면 역방향, 가운데 2.5m 안이면 양방향.
  3. 결과를 cameras.json / mobile.json 에 덧붙인다:
     dirs: 행마다 [방위각(0~359, 모르면 -1), 양방향(1/0), 붙인 점 위도 차(1e-5도), 경도 차(1e-5도), 층(1 터널·2 다리), 길 이름 번호]
     osmNames: 길 이름 표
"""
import json
import math
import sys
from collections import Counter, defaultdict

sys.path.insert(0, r'D:\pylib')
import osmium  # noqa: E402

PBF = sys.argv[1] if len(sys.argv) > 1 else r'D:\osm\south-korea-latest.osm.pbf'
ROOT = __file__.rsplit('tools', 1)[0]
FILES = [ROOT + 'data/cameras.json', ROOT + 'data/mobile.json']
ROADS = {'motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'living_street',
         'motorway_link', 'trunk_link', 'primary_link', 'secondary_link', 'tertiary_link', 'road'}
R = 45.0          # 카메라에서 이 거리 안의 길만
CENTER = 2.5      # 양방향 길 가운데선에서 이 안이면 양방향
CELL = 0.001      # 약 100m 격자

KY = 110540.0


def kx(lat):
    return 111320.0 * math.cos(math.radians(lat))


datasets = []
for f in FILES:
    with open(f, encoding='utf-8') as fh:
        datasets.append(json.load(fh))
cams = []   # (dataset index, row index, lat, lng, road name, kind)
for di, d in enumerate(datasets):
    roads = d.get('roads') or []
    for ri, c in enumerate(d['rows']):
        name = roads[c[7]] if isinstance(c[7], int) and 0 <= c[7] < len(roads) else ''
        cams.append((di, ri, c[0], c[1], name, c[3]))
cells = set()
for _, _, lat, lng, _, _ in cams:
    cy, cx = int(math.floor(lat / CELL)), int(math.floor(lng / CELL))
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            cells.add((cy + dy, cx + dx))
print('cameras', len(cams), 'cells', len(cells))


class H(osmium.SimpleHandler):
    def __init__(self):
        super().__init__()
        self.ways = []

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
        if not any((int(math.floor(la / CELL)), int(math.floor(lo / CELL))) in cells for la, lo in pts):
            return
        ow = w.tags.get('oneway', '')
        oneway = 1 if ow in ('yes', '1', 'true') else -1 if ow == '-1' else 0
        if hw in ('motorway', 'motorway_link') and ow != 'no':
            oneway = oneway or 1
        if w.tags.get('junction') in ('roundabout', 'circular'):
            oneway = oneway or 1
        if oneway == -1:
            pts.reverse()
            oneway = 1
        tunnel = w.tags.get('tunnel') in ('yes', 'building_passage', 'culvert') or w.tags.get('covered') == 'yes'
        bridge = w.tags.get('bridge') not in (None, 'no')
        try:
            layer = int(w.tags.get('layer', '0'))
        except ValueError:
            layer = 0
        self.ways.append((pts, oneway, w.tags.get('name', '') or w.tags.get('ref', ''), hw,
                          (1 if tunnel or layer < 0 else 0) | (2 if bridge or layer > 0 else 0)))


h = H()
h.apply_file(PBF, locations=True, idx='flex_mem')
ways = h.ways
print('ways near cameras', len(ways))

# 선분 격자
seg_grid = defaultdict(list)
for wi, (pts, *_rest) in enumerate(ways):
    for k in range(len(pts) - 1):
        (la1, lo1), (la2, lo2) = pts[k], pts[k + 1]
        for cy in range(int(math.floor(min(la1, la2) / CELL)), int(math.floor(max(la1, la2) / CELL)) + 1):
            for cx in range(int(math.floor(min(lo1, lo2) / CELL)), int(math.floor(max(lo1, lo2) / CELL)) + 1):
                seg_grid[(cy, cx)].append((wi, k))


def norm_name(s):
    return ''.join(s.split()).replace('번길', '').replace('길', '')


def candidates(lat, lng):
    out = {}
    cy, cx = int(math.floor(lat / CELL)), int(math.floor(lng / CELL))
    KX = kx(lat)
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            for wi, k in seg_grid.get((cy + dy, cx + dx), ()):
                pts = ways[wi][0]
                (la1, lo1), (la2, lo2) = pts[k], pts[k + 1]
                ax, ay = (lo1 - lng) * KX, (la1 - lat) * KY
                bx, by = (lo2 - lng) * KX, (la2 - lat) * KY
                vx, vy = bx - ax, by - ay
                L2 = vx * vx + vy * vy
                if not L2:
                    continue
                t = max(0.0, min(1.0, -(ax * vx + ay * vy) / L2))
                px, py = ax + t * vx, ay + t * vy
                d = math.hypot(px, py)
                if d > R:
                    continue
                cross = vx * (0 - ay) - vy * (0 - ax)   # >0 이면 카메라가 진행 방향 왼쪽
                side = -d if cross > 0 else d           # 오른쪽 +
                brg = (math.degrees(math.atan2(vx, vy)) + 360) % 360
                prev = out.get(wi)
                if prev is None or d < prev['d']:
                    out[wi] = {'wi': wi, 'd': d, 'side': side, 'brg': brg, 'px': px, 'py': py, 'end': t in (0.0, 1.0)}
    return list(out.values())


def angdiff(a, b):
    return abs((a - b + 540) % 360 - 180)


name_idx, names = {}, []
stats = Counter()
results = [[None] * len(d['rows']) for d in datasets]
for di, ri, lat, lng, rname, kind in cams:
    cs = candidates(lat, lng)
    if not cs:
        results[di][ri] = [-1, 0, 0, 0, 0, -1]
        stats['no road'] += 1
        continue
    rn = norm_name(rname) if rname else ''
    for c in cs:
        nm = norm_name(ways[c['wi']][2])
        c['same'] = bool(rn) and bool(nm) and (rn in nm or nm in rn)
        c['tunnel'] = ways[c['wi']][4] & 1
    surface = [c for c in cs if not c['tunnel']]
    pool = cs
    # 지상 길을 먼저: 터널(지하차도) 안 길은 지상 길이 45m 안에 없을 때만 (신호 카메라는 교차로, 곧 지상에 선다.
    # 2026-11-15 21198: 정자지하차도 들어가는 길에 붙어 지하차도 경로에서 뜰 뻔했다)
    if surface:
        pool = surface
    all_cs = cs
    same = [c for c in pool if c['same']]
    if same:
        pool = same
        stats['by name'] += 1
    best = min(pool, key=lambda c: c['d'])
    w = ways[best['wi']]
    oneway = w[1]
    both = 0
    if oneway:
        brg = best['brg']
        if best['side'] < -CENTER:
            # 일방통행 차로의 왼쪽(분리대 쪽): 같은 이름의 반대 방향 차로가 가까이 있고 카메라가 그 차로 오른쪽이면 그쪽
            opp = [c for c in pool if ways[c['wi']][1] and angdiff(c['brg'], brg) > 120 and c['side'] > -CENTER]
            if opp:
                o = min(opp, key=lambda c: c['d'])
                best, brg = o, o['brg']
                stats['oneway: other carriageway'] += 1
            else:
                stats['oneway: median side'] += 1
        else:
            stats['oneway'] += 1
    else:
        if abs(best['side']) <= CENTER:
            brg, both = best['brg'], 1
            stats['two-way: centre'] += 1
        elif best['side'] > 0:
            brg = best['brg']
            stats['two-way: right'] += 1
        else:
            brg = (best['brg'] + 180) % 360
            stats['two-way: left'] += 1
    # 층이 다른 나란한 길: 지상 카메라 옆(35m 안)을 지나는 지하차도(4)·고가(8), 지하차도·고가 위 카메라 옆의 지상 길(16).
    # 앱은 경로가 그 자리에서 지하차도·고가로 들어가면(네이버 안내) 지상 교차로 카메라를 빼고, 지상으로 가면 지하·고가 카메라를 뺀다
    lvb = ways[best['wi']][4]
    lv = lvb
    for c in cs:
        if c['wi'] == best['wi'] or c['d'] > 35:
            continue
        a = angdiff(c['brg'], best['brg'])
        if 30 < a < 150:
            continue
        lvc = ways[c['wi']][4]
        if not (lvb & 3) and (lvc & 1):
            lv |= 4
        elif not (lvb & 3) and (lvc & 2):
            lv |= 8
        elif (lvb & 3) and not (lvc & 3):
            lv |= 16
    nm = ways[best['wi']][2]
    if nm not in name_idx:
        name_idx[nm] = len(names)
        names.append(nm)
    KX = kx(lat)
    slat = lat + best['py'] / KY
    slng = lng + best['px'] / KX
    results[di][ri] = [int(round(brg)) % 360, both, int(round((slat - lat) * 1e5)), int(round((slng - lng) * 1e5)),
                       lv, name_idx[nm]]

# 원본에 서로 반대 방향(상행 1·하행 2)으로 따로 올라 있는 같은 도로·같은 종류 카메라 쌍(80m 안)이 기하로는 같은 방향으로 나오면
# (시골 2차로처럼 한 기둥에 두 방향 카메라를 단 경우) 하나를 반대 방향으로 돌린다. 둘 다 같은 방향을 찍는다고 보면 한쪽 방향이 빠진다
def angd(a, b):
    return abs((a - b + 540) % 360 - 180)
rows0 = datasets[0]['rows']
grid = defaultdict(list)
for i, c in enumerate(rows0):
    grid[(int(math.floor(c[0] / CELL)), int(math.floor(c[1] / CELL)))].append(i)
fixed_pairs = 0
for i, c in enumerate(rows0):
    if c[9] != 1:
        continue
    a = results[0][i]
    if a[0] < 0 or a[1]:
        continue
    cy, cx = int(math.floor(c[0] / CELL)), int(math.floor(c[1] / CELL))
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            for k in grid.get((cy + dy, cx + dx), ()):
                o = rows0[k]
                b = results[0][k]
                if o[9] != 2 or o[7] != c[7] or o[3] != c[3] or b[0] < 0 or b[1]:
                    continue
                if math.hypot((o[0] - c[0]) * KY, (o[1] - c[1]) * kx(c[0])) > 80:
                    continue
                if angd(a[0], b[0]) < 60:
                    b[0] = (a[0] + 180) % 360
                    fixed_pairs += 1
stats['registered pair turned opposite'] = fixed_pairs

for di, d in enumerate(datasets):
    d['dirs'] = results[di]
    d['osmNames'] = names
    with open(FILES[di], 'w', encoding='utf-8') as fh:
        json.dump(d, fh, ensure_ascii=False, separators=(',', ':'))
print(dict(stats))
