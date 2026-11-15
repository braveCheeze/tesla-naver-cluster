"""고속도로 휴게소 진입로 갈림점: 휴게소까지의 거리를 '본선에서 휴게소 진입로가 갈라지는 곳'까지로 (v133, 2026-11-16).

    py -X utf8 tools/osm_rest.py D:/osm/south-korea-latest.osm.pbf

한국도로공사 휴게소 좌표는 휴게소 건물·주차장 가운데라 본선 옆 100~300m 안쪽에 있다. 경로에 그 점을 내려 재면
진입로가 갈라지는 곳보다 수백 m 뒤가 되어 네이버보다 길게 나왔다(사용자: 네이버 3km 일 때 우리 3.1~3.2km, '200m 정도 차이').
네이버처럼 진입로 시작점까지 재려고 OSM 도로망에서 휴게소마다 진입로가 본선에서 갈라지는 점을 찾는다:
  1. 휴게소 좌표 700m 안의 휴게소 구역(highway=services/rest_area 닫힌 길)을 고르고, 없으면 좌표 200m 원을 구역으로 본다.
  2. 구역 안(또는 둘레 30m 안)의 연결로·구내 도로 점에서 시작해, 길의 진행 방향을 거슬러(들어오는 쪽으로만) 2.5km 까지 따라가
     처음 닿는 고속도로 본선(motorway/trunk) 점이 진입로 갈림점. 나가는 연결로는 거슬러 갈 수 없어 고르지 않는다.
  3. data/rest.json 에 entries 를 덧붙인다: 휴게소 행마다 [[위도, 경도, 본선 진행 방위각], ...] (양방향 휴게소는 둘)
"""
import json
import math
import sys
import heapq
from collections import defaultdict

sys.path.insert(0, r'D:\pylib')
import osmium  # noqa: E402

PBF = sys.argv[1] if len(sys.argv) > 1 else r'D:\osm\south-korea-latest.osm.pbf'
ROOT = __file__.rsplit('tools', 1)[0]
REST = ROOT + 'data/rest.json'
CELL = 0.01      # 약 1km 격자
MAIN = {'motorway', 'trunk'}
LINK = {'motorway_link', 'trunk_link', 'service', 'unclassified', 'services', 'rest_area', 'living_street'}
KY = 110540.0


def kx(lat):
    return 111320.0 * math.cos(math.radians(lat))


def dist_m(a, b):
    dy = (a[0] - b[0]) * KY
    dx = (a[1] - b[1]) * kx((a[0] + b[0]) / 2)
    return math.hypot(dx, dy)


def bearing(a, b):
    dy = (b[0] - a[0]) * KY
    dx = (b[1] - a[1]) * kx((a[0] + b[0]) / 2)
    return (math.degrees(math.atan2(dx, dy)) + 360) % 360


data = json.load(open(REST, encoding='utf-8'))
items = data['items']
cells = set()
for it in items:
    cy, cx = int(math.floor(it[0] / CELL)), int(math.floor(it[1] / CELL))
    for dy in (-3, -2, -1, 0, 1, 2, 3):
        for dx in (-3, -2, -1, 0, 1, 2, 3):
            cells.add((cy + dy, cx + dx))


class H(osmium.SimpleHandler):
    def __init__(self):
        super().__init__()
        self.ways = []    # (node refs, pts, highway, oneway)
        self.areas = []   # (pts, name)

    def way(self, w):
        hw = w.tags.get('highway')
        if hw not in MAIN and hw not in LINK:
            return
        try:
            nodes = [(n.ref, n.lat, n.lon) for n in w.nodes]
        except osmium.InvalidLocationError:
            return
        if len(nodes) < 2:
            return
        if not any((int(math.floor(la / CELL)), int(math.floor(lo / CELL))) in cells for _, la, lo in nodes):
            return
        if hw in ('services', 'rest_area') or (w.is_closed() and w.tags.get('area') == 'yes' and hw in ('services', 'rest_area')):
            self.areas.append(([(la, lo) for _, la, lo in nodes], w.tags.get('name', '')))
            if w.is_closed():
                return   # 구역 테두리는 길이 아니다
        ow = w.tags.get('oneway', '')
        oneway = 1 if ow in ('yes', '1', 'true') else -1 if ow == '-1' else 0
        if hw in ('motorway', 'motorway_link') and ow != 'no':
            oneway = oneway or 1
        if oneway == -1:
            nodes.reverse()
            oneway = 1
        self.ways.append(([n for n, _, _ in nodes], [(la, lo) for _, la, lo in nodes], hw, oneway))


h = H()
h.apply_file(PBF, locations=True, idx='flex_mem')
print('ways', len(h.ways), 'service areas', len(h.areas))

pos = {}
main_next = {}            # 본선 점 → 그 점에서 나가는 본선 다음 점 (진행 방위각용)
rev = defaultdict(list)   # v → [(u, 길이)]  : u→v 로 갈 수 있다 (연결로·구내 도로만)
link_nodes_by_cell = defaultdict(set)
main_nodes = set()
for refs, pts, hw, oneway in h.ways:
    for r, p in zip(refs, pts):
        pos[r] = p
    if hw in MAIN:
        for k, r in enumerate(refs):
            main_nodes.add(r)
            if k + 1 < len(refs):
                main_next.setdefault(r, refs[k + 1])
            elif k > 0 and r not in main_next:
                main_next[r] = None
        continue
    for k in range(len(refs) - 1):
        a, b = refs[k], refs[k + 1]
        d = dist_m(pts[k], pts[k + 1])
        rev[b].append((a, d))
        if not oneway:
            rev[a].append((b, d))
    for r, (la, lo) in zip(refs, pts):
        link_nodes_by_cell[(int(math.floor(la / CELL)), int(math.floor(lo / CELL)))].add(r)


def inside(poly, p):
    y, x = p
    c = False
    n = len(poly)
    for i in range(n):
        y1, x1 = poly[i]
        y2, x2 = poly[(i + 1) % n]
        if (y1 > y) != (y2 > y) and x < (x2 - x1) * (y - y1) / (y2 - y1) + x1:
            c = not c
    return c


def near_poly(poly, p, m):
    return any(dist_m(q, p) < m for q in poly)


def main_bearing(r):
    nx = main_next.get(r)
    if nx is not None and nx in pos:
        return bearing(pos[r], pos[nx])
    return -1


area_cells = defaultdict(list)
for ai, (poly, _) in enumerate(h.areas):
    la = sum(p[0] for p in poly) / len(poly)
    lo = sum(p[1] for p in poly) / len(poly)
    area_cells[(int(math.floor(la / CELL)), int(math.floor(lo / CELL)))].append((ai, (la, lo)))

found = 0
entries_all = []
for it in items:
    R = (it[0], it[1])
    cy, cx = int(math.floor(R[0] / CELL)), int(math.floor(R[1] / CELL))
    best = None
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            for ai, c in area_cells.get((cy + dy, cx + dx), ()):
                poly = h.areas[ai][0]
                d = 0 if inside(poly, R) else dist_m(c, R)
                if d < 700 and (best is None or d < best[0]):
                    best = (d, ai)
    cand = set()
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            cand |= link_nodes_by_cell.get((cy + dy, cx + dx), set())
    if best is not None:
        poly = h.areas[best[1]][0]
        start = [r for r in cand if r not in main_nodes and (inside(poly, pos[r]) or near_poly(poly, pos[r], 30))]
    else:
        start = [r for r in cand if r not in main_nodes and dist_m(pos[r], R) < 200]
    # 들어오는 쪽으로 거슬러 가며 처음 닿는 본선 점
    dist = {r: 0.0 for r in start}
    pq = [(0.0, r) for r in start]
    heapq.heapify(pq)
    hits = []
    while pq:
        d, v = heapq.heappop(pq)
        if d > dist.get(v, 1e18) or d > 2500:
            continue
        for u, w in rev.get(v, ()):
            nd = d + w
            if u in main_nodes:
                hits.append((nd, u))
                continue
            if nd < dist.get(u, 1e18):
                dist[u] = nd
                heapq.heappush(pq, (nd, u))
    # 본선 진행 방향별로 가장 가까운(구역에서 덜 거슬러 간) 갈림점 하나씩. 같은 방향 50m 안은 하나로
    hits.sort()
    out = []
    for d, u in hits:
        p, b = pos[u], main_bearing(u)
        if any(dist_m(p, (q[0], q[1])) < 50 or (b >= 0 and q[2] >= 0 and min(abs(b - q[2]), 360 - abs(b - q[2])) < 60) for q in out):
            continue
        if dist_m(p, R) > 2000:
            continue
        out.append([round(p[0], 6), round(p[1], 6), round(b) if b >= 0 else -1])
        if len(out) >= 2:
            break
    if out:
        found += 1
    entries_all.append(out)

data['entries'] = entries_all
with open(REST, 'w', encoding='utf-8', newline='\n') as fh:
    json.dump(data, fh, ensure_ascii=False, separators=(',', ':'))
print('rest areas', len(items), 'with entry', found)
for it, e in zip(items, entries_all):
    if any(k in it[2] for k in ('죽전', '서울하이패스', '기흥', '덕평', '안성', '망향')):
        print(it[2], it[3], [(x, round(dist_m(x, (it[0], it[1])))) for x in e])
