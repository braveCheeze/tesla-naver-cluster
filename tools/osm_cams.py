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
v164:
  - 고속국도 카메라(rtype 1)는 80m 안 고속도로 본선(motorway)에 붙인다 (옆 국도·마을길에 붙어 본선 경로에서 안 뜨던 것)
  - 짝(pairs: 한 기둥의 반대 방향 카메라 두 대, pairs80: 80m 안에 따로 등록된 상행·하행)은 방위를 서로 반대로, 각자 그 방향 차로에 붙인다
  - dirsAlt: 행마다 '반대 방향 차로' 결과. osm_arrows.py 가 설치장소 글로 방향을 뒤집을 때 쓰고 지운다
  - 길은 카메라 둘레 칸을 지나는 선분이 있으면 읽는다(예전엔 칸 안에 노드가 있는 길만: 다른 카메라가 늘면 결과가 바뀌었다)
"""
import json
import math
import re
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
        # v164: 카메라 둘레 칸을 지나는 선분이 하나라도 있으면 읽는다. 예전엔 칸 안에 '노드'가 있는 길만 읽어서, 노드가 드문 긴 고가·다리는
        # 다른 카메라(이동식 추가 등) 덕에 읽히기도 하고 안 읽히기도 했다 (개롱초교 30 J2140/G5681 의 고가 표시가 그래서 바뀜)
        if not seg_in_cells(pts, cells):
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


def candidates(lat, lng, r=R):
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
                if d > r:
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
alts = [[None] * len(d['rows']) for d in datasets]
conf = [[0.0] * len(d['rows']) for d in datasets]
hwcls = [[''] * len(d['rows']) for d in datasets]   # 붙인 길의 종류 (m 고속도로 본선 · ml 연결로 · t 국도 간선 · tl). cam_fill.py 가 쓰고 지운다
HWY_R = 80.0      # v164: 고속국도 카메라는 이 안의 고속도로 본선(motorway)에 붙인다
HWY_R_MOBILE = 200.0   # v165: 이동식·부스(좌표가 거칠다. 경기북부 PDF·충북 목록)는 200m 안 본선
FAR_R = 85.0      # v164: 45m 안에 길이 없을 때 같은 이름 길을 찾는 거리 (칸 하나가 약 88~110m 라 둘레 칸 안)


def name_no(nm):
    if nm not in name_idx:
        name_idx[nm] = len(names)
        names.append(nm)
    return name_idx[nm]


def prep(lat, lng, rname, hwy, slow=False, mobile=False):
    """후보 길과 고를 무리(pool). 고속국도 카메라는 80m 안 고속도로 본선이 있으면 그것만 (v164: 서해안 256.8k J2284/J2283 이
    78m 옆 길에, 경부 166.1k H1880/H1879 가 53m 옆 길에 붙어 있었다. 본선이 45m 밖이면 옆 국도·마을길에 붙었다)"""
    if hwy:
        cs = [c for c in candidates(lat, lng, HWY_R_MOBILE if mobile else HWY_R) if ways[c['wi']][3] == 'motorway']
        if cs:
            stats['highway: on motorway'] += 1
        else:
            cs = candidates(lat, lng)
    else:
        cs = candidates(lat, lng)
    if slow and not hwy:
        # v165: 제한 70 이하 일반도로 카메라는 고속도로 본선에 붙이지 않는다 (다른 길이 있으면). 원본 '신기대로 50' 이 위
        # 수도권제1순환고속도로에, '번영로 50' 이 영동고속도로에 붙어 일반도로 경로에서 안 떴다
        non_mw = [c for c in cs if ways[c['wi']][3] != 'motorway']
        if len(non_mw) < len(cs):
            # 본선만 있으면 비운다: 아래에서 85m 안 같은 이름 길을 찾고, 없으면 '길 없음'(방향 모름)이 본선보다 낫다
            cs = non_mw
            stats['slow street camera: motorway mainline skipped'] += 1
    rn = norm_name(rname) if rname else ''

    def tag(cs_):
        for c in cs_:
            nm = norm_name(ways[c['wi']][2])
            c['same'] = bool(rn) and bool(nm) and (rn in nm or nm in rn)
            c['tunnel'] = ways[c['wi']][4] & 1
        return cs_
    tag(cs)
    if not cs and rn:
        # v164: 45m 안에 차도가 없으면 85m 안의 같은 이름 길에 붙인다 (원본 좌표가 길에서 조금 먼 것·주소로 다시 찾은 자리)
        cs = [c for c in tag(candidates(lat, lng, FAR_R)) if c['same']]
        if cs:
            stats['no road in 45 m: same-name road within 85 m'] += 1
    # 지상 길을 먼저: 터널(지하차도) 안 길은 지상 길이 45m 안에 없을 때만 (신호 카메라는 교차로, 곧 지상에 선다.
    # 2026-11-15 21198: 정자지하차도 들어가는 길에 붙어 지하차도 경로에서 뜰 뻔했다)
    surface = [c for c in cs if not c['tunnel']]
    pool = surface or cs
    same = [c for c in pool if c['same']]
    if not same and re.search('지하|터널', rname or ''):
        # v164: 원본 도로명이 지하도로·터널이고 지상에 같은 이름 길이 없으면 그 이름의 터널 안 길 (신월여의지하도로 J4388/J4389 80 이
        # 위 국회대로에 붙어 국회대로 50 과 같은 자리 중복이 되었다). 이름이 지하도로가 아니면 예전처럼 지상 길 (동탄원천로 어린이 30 이
        # 같은 이름 지하차도에 붙어 지상 경로에서 빠졌다)
        same = [c for c in cs if c['same'] and c['tunnel']]
    return cs, (same or pool), bool(same)


def level_bits(cs, best):
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
    return lv


HW_CODE = {'motorway': 'm', 'motorway_link': 'ml', 'trunk': 't', 'trunk_link': 'tl'}
LAST_HW = ['']


def finish(lat, lng, cs, best, brg, both):
    LAST_HW[0] = HW_CODE.get(ways[best['wi']][3], '')
    KX = kx(lat)
    slat = lat + best['py'] / KY
    slng = lng + best['px'] / KX
    return [int(round(brg)) % 360, both, int(round((slat - lat) * 1e5)), int(round((slng - lng) * 1e5)),
            level_bits(cs, best), name_no(ways[best['wi']][2])]


def snap(lat, lng, rname, hwy, slow=False, mobile=False):
    """한 카메라: [방위, 양방향, 위도 차, 경도 차, 층, 길 이름 번호], 믿음(짝에서 어느 쪽 기하를 따를지), 통계 이름"""
    cs, pool, by_name = prep(lat, lng, rname, hwy, slow, mobile)
    if not cs:
        LAST_HW[0] = ''
        return [-1, 0, 0, 0, 0, -1], 0.0, 'no road'
    if by_name:
        stats['by name'] += 1
    best = min(pool, key=lambda c: c['d'])
    oneway = ways[best['wi']][1]
    both = 0
    if oneway:
        brg = best['brg']
        if best['side'] < -CENTER:
            # 일방통행 차로의 왼쪽(분리대 쪽): 같은 이름의 반대 방향 차로가 가까이 있고 카메라가 그 차로 오른쪽이면 그쪽
            opp = [c for c in pool if ways[c['wi']][1] and angdiff(c['brg'], brg) > 120 and c['side'] > -CENTER]
            if opp:
                o = min(opp, key=lambda c: c['d'])
                best, brg = o, o['brg']
                st, cf = 'oneway: other carriageway', 2.5
            else:
                st, cf = 'oneway: median side', 1.0
        else:
            st, cf = 'oneway', 3.0
    else:
        if abs(best['side']) <= CENTER:
            brg, both = best['brg'], 1
            st, cf = 'two-way: centre', 0.0
        elif best['side'] > 0:
            brg = best['brg']
            st, cf = 'two-way: right', 1.5 + min(abs(best['side']), 10.0) / 20
        else:
            brg = (best['brg'] + 180) % 360
            st, cf = 'two-way: left', 1.5 + min(abs(best['side']), 10.0) / 20
    return finish(lat, lng, cs, best, brg, both), cf, st


def snap_dir(lat, lng, rname, hwy, want, slow=False, mobile=False):
    """찍는 방향이 want 인 차로에 붙인 결과 (그 방향으로 달릴 수 있는 길: 일방통행은 그 방향, 양방향은 어느 쪽이든, 60° 안).
    짝의 반대쪽 카메라, 그리고 osm_arrows.py 가 설치장소 글로 방향을 뒤집을 때 쓴다(분리된 큰길은 건너편 차로로 옮겨야 한다)"""
    cs, pool, _ = prep(lat, lng, rname, hwy, slow, mobile)
    for group in (pool, cs):
        opts = []
        for c in group:
            if angdiff(c['brg'], want) <= 60:
                opts.append((c['d'], c['brg'], c))
            elif not ways[c['wi']][1] and angdiff(c['brg'] + 180, want) <= 60:
                opts.append((c['d'], (c['brg'] + 180) % 360, c))
        if opts:
            d_, b_, c = min(opts, key=lambda x: x[0])
            return finish(lat, lng, cs, c, b_, 0)
    return None


rname_of = {}
for di, ri, lat, lng, rname, kind in cams:
    rname_of[(di, ri)] = rname
    row_ = datasets[di]['rows'][ri]
    hwy = row_[8] == 1
    slow = 0 < row_[2] <= 70 and not re.search('고속', rname or '')
    res, cf, st = snap(lat, lng, rname, hwy, slow, di == 1)
    results[di][ri], conf[di][ri] = res, cf
    hwcls[di][ri] = LAST_HW[0]
    stats[st] += 1
    if res[0] >= 0:
        alts[di][ri] = snap_dir(lat, lng, rname, hwy, (res[0] + 180) % 360, slow, di == 1)


def angd(a, b):
    return abs((a - b + 540) % 360 - 180)


# v164 짝: 한 기둥(또는 80m 안)에서 서로 반대 방향을 찍는 두 카메라는 방위를 서로 반대로, 각자 그 방향 차로에 붙인다.
#  - 같은 자리 짝(build_cams.py / build_mobile.py 의 pairs): 예전엔 한 행으로 합쳐 방위가 하나뿐이라 반대 방향은 안 울렸다
#  - 원본에 상행(1)·하행(2)으로 따로 올라 있는 같은 도로·같은 종류 카메라(80m 안)가 기하로 같은 방향으로 나오는 경우 (시골 2차로처럼
#    한 기둥에 두 방향 카메라를 단 경우): 예전엔 방위만 뒤집고 차로 위 점은 그대로 두어 분리된 길이면 건너편 차로 점이 아니었다
# 믿음이 큰 쪽(분리된 길의 제 차로 오른쪽 > 양방향 길의 한쪽 > 가운데)의 기하를 따르고, 다른 쪽은 그 반대 방향 차로에 다시 붙인다.
# 어느 쪽이 어느 방향인지는 다음 단계 osm_arrows.py 가 설치장소 글로 가른다(필요하면 둘을 바꾼다)
pair_stats = Counter()
for di, d in enumerate(datasets):
    rows_ = d['rows']
    pl = d.get('pairs') or []
    explicit = [(pl[k], pl[k + 1]) for k in range(0, len(pl) - 1, 2)]
    # 따로 등록된 상행·하행 쌍(80m 안)은 build_cams.py 가 'pairs80' 으로 준다 (차로만 다른 기록·같은 방향 글은 빼고)
    pl = d.get('pairs80') or []
    in_pole = {x for p in explicit for x in p}
    # 한 기둥 짝에 든 행은 따로 등록된 쌍으로 다시 만지지 않는다 (나중에 다시 붙이면 짝이 같은 방향이 되었다)
    auto = [(pl[k], pl[k + 1]) for k in range(0, len(pl) - 1, 2) if pl[k] not in in_pole and pl[k + 1] not in in_pole]
    for (i, j), same_pole in [(p, True) for p in explicit] + [(p, False) for p in auto]:
        a, b = results[di][i], results[di][j]
        if a[0] < 0 and b[0] < 0:
            pair_stats['no road'] += 1
            continue
        if not same_pole and (a[0] < 0 or b[0] < 0 or a[1] or b[1] or angd(a[0], b[0]) >= 60):
            continue   # 따로 등록된 쌍: 예전처럼 둘 다 한 방향이고 같은 쪽(60° 안)을 가리킬 때만 (교차로의 다른 접근로는 그대로)
        if a[0] >= 0 and b[0] >= 0 and not a[1] and not b[1] and angd(a[0], b[0]) >= 120:
            pair_stats['already opposite'] += 1
            continue
        if b[0] < 0 or (a[0] >= 0 and conf[di][i] >= conf[di][j]):
            anc, oth = i, j
        else:
            anc, oth = j, i
        A = results[di][anc]
        A[1] = 0
        want = (A[0] + 180) % 360
        c = rows_[oth]
        r2 = snap_dir(c[0], c[1], rname_of[(di, oth)], c[8] == 1, want,
                      0 < c[2] <= 70 and not re.search('고속', rname_of[(di, oth)] or ''), di == 1)
        if r2 is not None:
            hwcls[di][oth] = LAST_HW[0]
        if r2 is None:
            B = results[di][oth] if results[di][oth][0] >= 0 else A
            r2 = [want, 0, B[2], B[3], B[4], B[5]]
            pair_stats['set opposite (same lane point)'] += 1
        else:
            pair_stats['set opposite (own lane)'] += 1
        results[di][oth] = r2
        alts[di][oth] = list(A)
        alts[di][anc] = list(r2)
        pair_stats['same pole' if same_pole else 'registered 1/2 pair'] += 1
stats.update({'pair: ' + k: v for k, v in pair_stats.items()})

# v165 구간단속 카메라인데 차도에 못 붙어 방향이 없는 것: 짝(시점↔종점, 같은 제한, 30km 안)의 방향으로 시점→종점 방위를 준다
# (세종포천고속도로 구간 끝 100: 방향이 없어 시작을 못 본 경로에서 건너뛰었다)
rows0 = datasets[0]['rows']
secs = [i for i, c in enumerate(rows0) if c[4] in (1, 2)]
for i in secs:
    if results[0][i][0] >= 0:
        continue
    c = rows0[i]
    best = None
    for k in secs:
        o = rows0[k]
        if o[4] != 3 - c[4] or o[2] != c[2]:
            continue
        dd = math.hypot((o[0] - c[0]) * KY, (o[1] - c[1]) * kx(c[0]))
        if 150 < dd <= 30000 and (best is None or dd < best[0]):
            best = (dd, o)
    if best:
        a_, b_ = (c, best[1]) if c[4] == 1 else (best[1], c)
        eb = (math.degrees(math.atan2((b_[1] - a_[1]) * kx(a_[0]), (b_[0] - a_[0]) * KY)) + 360) % 360
        results[0][i] = [int(round(eb)) % 360, 0, 0, 0, 0, -1]
        stats['section camera without road: bearing from its partner'] += 1
# v165 이동식·부스는 층(고가·지하차도 옆) 표시를 하지 않는다: 좌표가 거칠어(수십 m) OSM 층 판단이 맞지 않고, 표시가 있으면 앱이
# 지상 경로에서 뺀다 (경기북부 한류월드IC·킨텍스IC·이산포IC·강매IC 고가아래 부스가 이름 없는 연결로 고가에 붙어 빠졌다)
for r in results[1] + alts[1]:
    if r and r[4]:
        r[4] = 0
        stats['mobile: level flags cleared'] += 1

for di, d in enumerate(datasets):
    d['dirs'] = results[di]
    d['osmNames'] = names
    # 반대 방향 차로 결과(osm_arrows.py 가 쓰고 지운다. 앱은 읽지 않는다)
    d['dirsAlt'] = alts[di]
    d['dirsHw'] = hwcls[di]
    d.pop('pairs80', None)
    with open(FILES[di], 'w', encoding='utf-8') as fh:
        json.dump(d, fh, ensure_ascii=False, separators=(',', ':'))
print(dict(stats))
