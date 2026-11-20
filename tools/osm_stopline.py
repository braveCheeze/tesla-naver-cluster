"""신호·신호과속 카메라를 '찍는 방향의 접근로 정지선'으로 옮긴다 (v138, 2026-11-16 전국 재보정).

    py -X utf8 tools/osm_stopline.py D:/osm/south-korea-latest.osm.pbf

osm_cams.py · osm_arrows.py 다음에 돌린다. 신호 카메라는 교차로에 들어가는 차를 정지선에서 찍는데, 원본 좌표는 교차로 한가운데나
건너편에 찍힌 것이 많다. 그 점을 가장 가까운 길에 붙이면 꺾은 뒤의 길(또는 다른 접근로)에 붙어
  - 좌회전하는 경로에서 우리 접근로 카메라는 경로선에서 15m 넘게 떨어져 빠지고,
  - 좌회전 뒤 길(다른 방향 접근로를 찍는 카메라)이 대신 잡혔다 (2026-11-16 길동사거리: 앱 240m, 네이버 211m, 회전 60m 일 때 카메라 90m).
그래서 신호 카메라(종류 2·3, 후면 제외, 찍는 방향을 아는 것)마다:
  1. 지금 붙은 점 30m 안에서 찍는 방향(dirs[i][0])으로 달릴 수 있는 길(일방통행은 그 방향, 양방향은 두 방향 중 맞는 쪽, 45° 안)을 고르고
     (같은 이름 길이 있으면 그 길), 그 방향으로 앞뒤 120m 씩 곧게 이어지는 길을 따라간다.
  2. 그 길 위에서 원본 좌표 55m 안의 교차로를 찾는다: 신호 노드(highway=traffic_signals)가 있으면 가장 앞(상류)의 신호 노드,
     없으면 원본 좌표에 가장 가까운 갈림 노드(길 3개 이상)에서 30m 안으로 이어진 큰 갈림(4갈래 이상) 중 가장 앞의 것.
  3. 그 교차로 8m 앞(상류)을 카메라 자리로 한다 (정지선·횡단보도 앞). 원래 붙은 점에서 60m 넘게 옮겨야 하면 그대로 둔다.
  v178: 2 의 갈림 노드는 '가로지르는 길'(연결로 아닌 길, 45~135°)이 있는 노드만, 그중 기둥에 가까운 것에서 40m 안 앞쪽(우리 쪽) 노드로.
        우리 쪽 횡단보도가 25m 안에 있으면 그 3m 앞. 기둥에서 80m 넘게 옮겨야 하면 그대로 두고 목록을 찍는다
결과: dirs[i][2], dirs[i][3] (붙인 점의 위도·경도 차, 1e-5도)을 고치고 dirs[i] 에 7번째 값 1(정지선으로 옮김)을 붙인다.
"""
import json
import math
import sys
from collections import Counter, defaultdict

sys.path.insert(0, r'D:\pylib')
import osmium  # noqa: E402

PBF = sys.argv[1] if len(sys.argv) > 1 else r'D:\osm\south-korea-latest.osm.pbf'
ROOT = __file__.rsplit('tools', 1)[0]
FILE = ROOT + 'data/cameras.json'
ROADS = {'motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'living_street',
         'motorway_link', 'trunk_link', 'primary_link', 'secondary_link', 'tertiary_link', 'road'}
CELL = 0.002
KY = 110540.0
BACK = 8.0        # 교차로(신호 노드·갈림 노드)에서 이만큼 앞이 정지선
NEAR_RAW = 55.0   # 원본 좌표에서 이 안의 교차로만
MAX_FROM_RAW = 80.0   # v178: 원래(기둥) 좌표에서 이보다 멀리 옮기지 않는다 (예전엔 붙은 점에서 60m). 넘으면 그대로 두고 목록에 남긴다
SNAP = 30.0       # 지금 붙은 점에서 이 안의 길


def kx(lat):
    return 111320.0 * math.cos(math.radians(lat))


def dist(a, b):
    return math.hypot((a[0] - b[0]) * KY, (a[1] - b[1]) * kx((a[0] + b[0]) / 2))


def brg(a, b):
    return (math.degrees(math.atan2((b[1] - a[1]) * kx(a[0]), (b[0] - a[0]) * KY)) + 360) % 360


def angd(a, b):
    return abs((a - b + 540) % 360 - 180)


def norm(s):
    return ''.join((s or '').split())


data = json.load(open(FILE, encoding='utf-8'))
rows, dirs, osm_names = data['rows'], data['dirs'], data['osmNames']
targets = []
for i, c in enumerate(rows):
    if c[3] not in (2, 3) or ((c[10] if len(c) > 10 else 0) | 0) & 1:
        continue
    d = dirs[i]
    if d[0] < 0 or d[1]:
        continue
    targets.append(i)
cells = set()
for i in targets:
    c = rows[i]
    cy, cx = int(math.floor(c[0] / CELL)), int(math.floor(c[1] / CELL))
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            cells.add((cy + dy, cx + dx))
print('signal cameras with a direction', len(targets))


def seg_in_cells(pts, cells, cell=CELL):
    """길(점 열)의 선분 중 하나라도 cells 의 칸을 지나는지 (선분의 둘레 상자로 본다)"""
    for la, lo in pts:
        if (int(math.floor(la / cell)), int(math.floor(lo / cell))) in cells:
            return True
    for k in range(len(pts) - 1):
        (la1, lo1), (la2, lo2) = pts[k], pts[k + 1]
        y0, y1 = int(math.floor(min(la1, la2) / cell)), int(math.floor(max(la1, la2) / cell))
        x0, x1 = int(math.floor(min(lo1, lo2) / cell)), int(math.floor(max(lo1, lo2) / cell))
        if y0 == y1 and x0 == x1:
            continue
        for cy in range(y0, y1 + 1):
            for cx in range(x0, x1 + 1):
                if (cy, cx) in cells:
                    return True
    return False


class H(osmium.SimpleHandler):
    def __init__(self):
        super().__init__()
        self.ways = []          # (refs, pts, oneway, name, highway)
        self.signals = set()
        self.crossings = set()  # v178: 횡단보도 노드 (정지선은 우리 쪽 횡단보도 바로 앞)

    def node(self, n):
        t = n.tags
        if t.get('highway') == 'traffic_signals' or t.get('crossing') == 'traffic_signals':
            la, lo = n.location.lat, n.location.lon
            if (int(math.floor(la / CELL)), int(math.floor(lo / CELL))) in cells:
                self.signals.add(n.id)
        if t.get('highway') == 'crossing' or (t.get('crossing') and t.get('crossing') != 'no'):
            la, lo = n.location.lat, n.location.lon
            if (int(math.floor(la / CELL)), int(math.floor(lo / CELL))) in cells:
                self.crossings.add(n.id)

    def way(self, w):
        hw = w.tags.get('highway')
        if hw not in ROADS:
            return
        try:
            nodes = [(n.ref, n.lat, n.lon) for n in w.nodes]
        except osmium.InvalidLocationError:
            return
        if len(nodes) < 2 or not seg_in_cells([(la, lo) for _, la, lo in nodes], cells):
            return   # v164: 노드가 아니라 선분으로 (osm_cams.py 와 같은 이유)
        ow = w.tags.get('oneway', '')
        oneway = 1 if ow in ('yes', '1', 'true') else -1 if ow == '-1' else 0
        if hw in ('motorway', 'motorway_link') and ow != 'no':
            oneway = oneway or 1
        if w.tags.get('junction') in ('roundabout', 'circular'):
            oneway = oneway or 1
        if oneway == -1:
            nodes.reverse()
            oneway = 1
        self.ways.append(([r for r, _, _ in nodes], [(la, lo) for _, la, lo in nodes], oneway, w.tags.get('name', '') or '', hw))


h = H()
h.apply_file(PBF, locations=True, idx='flex_mem')
ways, signals, crossings = h.ways, h.signals, h.crossings
print('ways', len(ways), 'signal nodes', len(signals))

pos = {}
deg = Counter()
at_node = defaultdict(list)   # 노드 → [(길 번호, 길 안의 자리)]
seg_grid = defaultdict(list)
for wi, (refs, pts, ow, nm, _hw) in enumerate(ways):
    for k, r in enumerate(refs):
        pos[r] = pts[k]
        at_node[r].append((wi, k))
        deg[r] += 1 if k in (0, len(refs) - 1) else 2
    for k in range(len(pts) - 1):
        (la1, lo1), (la2, lo2) = pts[k], pts[k + 1]
        for cy in range(int(math.floor(min(la1, la2) / CELL)), int(math.floor(max(la1, la2) / CELL)) + 1):
            for cx in range(int(math.floor(min(lo1, lo2) / CELL)), int(math.floor(max(lo1, lo2) / CELL)) + 1):
                seg_grid[(cy, cx)].append((wi, k))


def proj(p, a, b):
    KX = kx(p[0])
    ax, ay = (a[1] - p[1]) * KX, (a[0] - p[0]) * KY
    bx, by = (b[1] - p[1]) * KX, (b[0] - p[0]) * KY
    vx, vy = bx - ax, by - ay
    L2 = vx * vx + vy * vy
    t = 0.0 if not L2 else max(0.0, min(1.0, -(ax * vx + ay * vy) / L2))
    return math.hypot(ax + t * vx, ay + t * vy), t


def step(node, prev_node, forward, cur_brg):
    """node 에서 진행 방향(forward=True: 앞으로, False: 뒤로 거슬러)으로 가장 곧게 이어지는 다음 노드"""
    best = None
    for wi, k in at_node.get(node, ()):
        refs, pts, ow, _, _ = ways[wi]
        cand = []
        if forward:
            if k + 1 < len(refs):
                cand.append(k + 1)
            if not ow and k - 1 >= 0:
                cand.append(k - 1)
        else:
            if k - 1 >= 0:
                cand.append(k - 1)
            if not ow and k + 1 < len(refs):
                cand.append(k + 1)
        for kk in cand:
            nxt = refs[kk]
            if nxt == prev_node:
                continue
            b = brg(pos[node], pos[nxt]) if forward else brg(pos[nxt], pos[node])
            a = angd(b, cur_brg)
            if a < 40 and (best is None or a < best[0]):
                best = (a, nxt, b)
    return best


stats = Counter()
moves = []
far = []
LINKS = {'motorway_link', 'trunk_link', 'primary_link', 'secondary_link', 'tertiary_link'}


def crossing_road_at(seq, q):
    """노드 seq[q] 에서 연결로가 아닌 길이 진행 방향(앞뒤 노드)과 45~135° 로 갈라지는지 = 가로지르는 길이 있는 교차로"""
    node = seq[q]
    cur = brg(pos[seq[q - 1]], pos[seq[q + 1]])
    for wi, k in at_node.get(node, ()):
        refs, pts, ow, nm, hw = ways[wi]
        if hw in LINKS:
            continue
        for kk in (k - 1, k + 1):
            if 0 <= kk < len(refs) and refs[kk] not in (seq[q - 1], seq[q + 1]):
                if 45 <= angd(brg(pos[node], pos[refs[kk]]), cur) <= 135:
                    return True
    return False

for i in targets:
    c, d = rows[i], dirs[i]
    raw = (c[0], c[1])
    s0 = (c[0] + d[2] / 1e5, c[1] + d[3] / 1e5)
    eb = d[0]
    want = norm(osm_names[d[5]]) if d[5] >= 0 else ''
    cy, cx = int(math.floor(s0[0] / CELL)), int(math.floor(s0[1] / CELL))
    cands = []
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            for wi, k in seg_grid.get((cy + dy, cx + dx), ()):
                refs, pts, ow, nm, _ = ways[wi]
                dd, t = proj(s0, pts[k], pts[k + 1])
                if dd > SNAP:
                    continue
                b = brg(pts[k], pts[k + 1])
                if angd(b, eb) <= 45:
                    fwd = True
                elif not ow and angd(b, eb + 180) <= 45:
                    fwd = False
                else:
                    continue
                cands.append((dd, wi, k, t, fwd, norm(nm) == want and bool(want)))
    if not cands:
        stats['no road in direction'] += 1
        continue
    same = [x for x in cands if x[5]]
    dd, wi, k, t, fwd, _ = min(same or cands)
    refs, pts, ow, nm, _ = ways[wi]
    # 진행 방향으로 정렬한 노드 열: a(뒤) → b(앞), 투영점은 그 사이
    a_n, b_n = (refs[k], refs[k + 1]) if fwd else (refs[k + 1], refs[k])
    tt = t if fwd else 1 - t
    seq = [a_n, b_n]
    cur = brg(pos[a_n], pos[b_n])
    # 앞으로 120m
    run, prev, node = dist(pos[a_n], pos[b_n]) * (1 - tt), a_n, b_n
    while run < 120:
        nx = step(node, prev, True, cur)
        if not nx:
            break
        run += dist(pos[node], pos[nx[1]])
        prev, node, cur = node, nx[1], nx[2]
        seq.append(node)
    # 뒤로 120m
    cur = brg(pos[a_n], pos[b_n])
    run, prev, node = dist(pos[a_n], pos[b_n]) * tt, b_n, a_n
    while run < 120:
        nx = step(node, prev, False, cur)
        if not nx:
            break
        run += dist(pos[nx[1]], pos[node])
        prev, node, cur = node, nx[1], nx[2]
        seq.insert(0, node)
    cum = [0.0]
    for q in range(1, len(seq)):
        cum.append(cum[-1] + dist(pos[seq[q - 1]], pos[seq[q]]))
    ia = seq.index(a_n)
    a0 = cum[ia] + tt * (cum[ia + 1] - cum[ia])
    inner = [q for q in range(1, len(seq) - 1) if abs(cum[q] - a0) <= 70 and dist(pos[seq[q]], raw) <= NEAR_RAW]
    sig = [q for q in inner if seq[q] in signals]
    junc = [q for q in inner if deg[seq[q]] >= 3]
    # v178: 교차로는 '가로지르는 길'(연결로가 아닌 길이 찍는 방향과 45~135°)이 만나는 노드로 찾는다. 예전엔 신호 노드가 없으면 기둥에
    # 가장 가까운 갈림 노드를 썼는데, 우회전 연결로가 다시 합쳐지는 노드가 기둥에 더 가까우면 교차로를 지난 자리가 되었다
    # (2026-11-20 서하남IC입구교차로 J3195 50: 강동대로 동행 정지선에 선 차에 '90m', 아이콘은 건너편 횡단보도 너머. 티맵은 우리 정지선)
    # 기둥보다 30m 넘게 앞(하류)의 교차로는 그 카메라 교차로가 아니다 (기둥은 정지선 앞이거나 교차로 건너편에 선다)
    xj = [q for q in junc if crossing_road_at(seq, q) and cum[q] - a0 <= 30]
    J = None
    if sig:
        J = min(sig)
        stats['by signal node'] += 1
    elif xj:
        q0 = min(xj, key=lambda q: dist(pos[seq[q]], raw))
        # 같은 교차로의 앞쪽(우리 쪽) 노드: 가로지르는 길이 분리 도로면 노드가 둘이다. 40m 안으로 앞에 있는 교차 노드로
        while True:
            up = [q for q in xj if q < q0 and cum[q0] - cum[q] <= 40]
            if not up:
                break
            q0 = max(up)
        J = q0
        stats['by crossing road'] += 1
    elif junc:
        q0 = min(junc, key=lambda q: dist(pos[seq[q]], raw))
        # 같은 교차로(분리된 큰길은 노드가 여럿): 30m 안으로 앞쪽에 이어진 4갈래 이상 갈림이면 그쪽으로
        while True:
            up = [q for q in junc if q < q0 and cum[q0] - cum[q] <= 30 and deg[seq[q]] >= 4]
            if not up:
                break
            q0 = max(up)
        J = q0
        stats['by junction node'] += 1
    else:
        stats['no junction near'] += 1
        continue
    target = cum[J] - BACK
    # 우리 쪽 횡단보도가 교차로 25m 앞 안에 있으면 그 바로 앞(3m)이 정지선
    xw = [q for q in range(len(seq)) if seq[q] in crossings and 0 < cum[J] - cum[q] <= 25]
    if xw:
        target = min(target, cum[max(xw)] - 3)
        stats['stop line before the crosswalk'] += 1
    q = max(0, J - 1)
    while q > 0 and cum[q] > target:
        q -= 1
    seg_len = cum[q + 1] - cum[q]
    f = 0 if seg_len <= 0 else max(0.0, min(1.0, (target - cum[q]) / seg_len))
    pa, pb = pos[seq[q]], pos[seq[q + 1]]
    S = (pa[0] + (pb[0] - pa[0]) * f, pa[1] + (pb[1] - pa[1]) * f)
    mv = dist(S, s0)
    if dist(S, raw) > MAX_FROM_RAW:
        stats['too far from the pole, kept'] += 1
        far.append((i, int(dist(S, raw))))
        continue
    d[2] = int(round((S[0] - c[0]) * 1e5))
    d[3] = int(round((S[1] - c[1]) * 1e5))
    while len(d) < 7:
        d.append(0)
    d[6] = 1
    moves.append(mv)
    stats['moved'] += 1

moves.sort()
if moves:
    print('moved', len(moves), 'median %.1f m, p90 %.1f m, max %.1f m' % (moves[len(moves) // 2], moves[int(len(moves) * 0.9)], moves[-1]))
print(dict(stats))
if far:
    print('not moved (stop line over %d m from the pole):' % MAX_FROM_RAW, len(far), far[:20])
with open(FILE, 'w', encoding='utf-8') as fh:
    json.dump(data, fh, ensure_ascii=False, separators=(',', ':'))
for i in (25009, 25014):
    c, d = rows[i], dirs[i]
    print(i, c[:4], 'eb', d[0], 'point', round(c[0] + d[2] / 1e5, 6), round(c[1] + d[3] / 1e5, 6), 'stopline' if len(d) > 6 and d[6] else '')
