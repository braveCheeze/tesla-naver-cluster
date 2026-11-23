"""고속도로 분기점·나들목 노면색깔유도선(바닥의 분홍·녹색 선) → data/colorlines.json
(2026-11-19 운전자 '고속도로나 우회전 좌회전 빠질때 보통 녹색 분홍색 안내선 있는거 알지? 그거에 대한 API 있는지')

자료 (공공데이터포털, 로그인·키 없이 받음):
  현황    한국도로공사_노면색깔유도선 현황 (15118978, 2026-08): 노선명, 시설물 명칭, 방향, 분기형태, 좌·우 선 색, 비고(분기점·나들목…)
  재도색  한국도로공사_노면색깔유도선 재도색 현황 (15142480, 2024-06): 같은 칸 + 노면문자 좌·우 (선 위에 쓰인 방면 글자)
둘 다 좌표가 없다. 그래서 OSM(고속도로·연결로, 분기점·나들목 이름이 붙은 motorway_junction 점, 연결로 destination 태그)으로
자리를 찾고, 자료가 실제 갈래 모양과 맞는지 확인한 곳만 남긴다 — 틀린 색보다 안 보이는 편이 낫다:
  1. 현황 줄(새 자료)이 기준. 같은 (노선, 시설물, 방향) 재도색 줄의 좌·우 색이 현황과 같을 때만 그 줄의 노면문자를 붙인다.
     분기점·나들목·국도접속부만 (휴게소·졸음쉼터·영업소·하이패스는 뺀다). 색은 분홍·녹색·연한녹색만 (청색·주황은 영업소 차로).
  2. OSM 에서 시설물 이름(분기점/JC ↔ 나들목/IC 구별)이 같은 motorway_junction 점마다 본선 진행 방향 하나('접근')를 만들고,
     1km 위에서부터 하류로 모든 갈래를 따라간다(4.5km 까지).
  3. 색이 둘인 줄: 좌·우 글자가 각각 서로 다른 갈래 하나의 destination 과 맞고, 두 갈래가 헤어지는 곳에서 '좌' 글자 갈래가
     실제로 왼쪽이어야 한다. 방향(예: '부산')이 그 접근의 반대쪽을 가리키면 버린다 (2026-11-20 경부 하행 신갈분기점:
     자료는 좌 '인천'·우 '원주' 인데 실제 하행은 왼쪽 원주·오른쪽 인천 → 버림, 상행은 맞음 → 남김).
     색이 하나인 줄(1점1분기): 글자가 맞는 갈래, 글자가 없거나 안 맞으면 방향이 분명한 접근에서 그 나들목으로 나가는 연결로.
  4. 한 접근에 맞는 줄들이 서로 다른 색을 말하면 그 접근은 버린다.
결과 줄: [위도, 경도, 본선 방위각, [[색, 갈래 끝 위도, 갈래 끝 경도], ...], 이름]
  위도·경도 = 색 선이 갈라지기 시작하는 본선 점(첫 갈래가 본선을 떠나는 곳), 갈래 끝 = 그 갈래가 다른 색 갈래(또는 본선)와
  헤어진 뒤 150m 지점. 앱은 길안내 경로가 그 끝점 30m 안을 지나면 그 갈래 색을 1km 앞부터 보여 준다.

    py -I -X utf8 tools/build_colorlines.py <현황.csv> <재도색.csv> <south-korea-latest.osm.pbf> [data/colorlines.json]
"""
import collections
import csv
import io
import json
import math
import os
import re
import sys

sys.path.insert(0, r'D:\pylib')
import osmium  # noqa: E402

ST, RP, PBF = sys.argv[1], sys.argv[2], sys.argv[3]
OUT = sys.argv[4] if len(sys.argv) > 4 else os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'data', 'colorlines.json')
DEBUG = os.environ.get('CL_DEBUG', '')

UP = 1000.0        # 이름 점에서 본선을 거슬러 올라가는 거리
LIMIT = 4500.0     # 하류로 따라가는 거리 (시작점부터)
SEP = 60.0         # 갈래 끝점: 헤어진 뒤 다른 갈래(본선 포함)에서 이만큼 떨어진 첫 점 (앱은 경로가 그 25m 안을 지나는지 본다)
SEP_MAX = 900.0    # 그 점을 이 거리 안에서 찾는다
KY = 110540.0
ROADS = {'motorway', 'motorway_link', 'trunk', 'trunk_link'}   # 연결로가 일반 도로에 닿으면 거기서 길이 끝난다
MAIN = {'motorway', 'trunk'}


def kx(lat):
    return 111320.0 * math.cos(math.radians(lat))


def adiff(a, b):
    return abs((a - b + 180) % 360 - 180)


def turn(h0, h1):
    return (h1 - h0 + 540) % 360 - 180   # + 오른쪽, - 왼쪽


# ---------------------------------------------------------------- 표 읽기
def read_csv(p):
    raw = open(p, 'rb').read()
    for enc in ('utf-8-sig', 'cp949'):
        try:
            return list(csv.DictReader(io.StringIO(raw.decode(enc))))
        except UnicodeDecodeError:
            continue
    raise SystemExit('encoding? ' + p)


def nroute(s):
    return re.sub(r'\s|순환|선$', '', s or '')


SUFFIX = re.compile(r'(분기점|나들목|JCT|JC|IC|I\.C|교차로|톨게이트|TG)$', re.I)


def nplace(s):
    s = re.sub(r'\(.*?\)|\s', '', s or '')
    for _ in range(2):
        s = SUFFIX.sub('', s)
    return s


def is_jc_name(s):
    return bool(re.search(r'분기점|JCT|JC', s or '', re.I))


def ndir(s):
    return re.sub(r'\s', '', (s or '').replace('/', ','))


def ncolor(s):
    s = re.sub(r'\s', '', s or '')
    if not s:
        return None
    if s in ('분홍', '분홍색', '분혹생'):
        return 'p'
    if s in ('녹색', '초록색', '초록'):
        return 'g'
    if s in ('연한녹색', '연녹색', '연두색'):
        return 'lg'
    return '?'


KEEP_KIND = re.compile(r'분기점|나들목|국도접속')
SKIP_FORM = re.compile(r'영업소|진입|진출|하이패스|졸음|TG')
NO_DIR = {'', '진입부', '진출부', '진입', '진출', '양방향'}

status, repaint = read_csv(ST), read_csv(RP)
rp_by = collections.defaultdict(list)
for r in repaint:
    rp_by[(nroute(r['노선명']), nplace(r['시설물 명칭']), ndir(r['방향']))].append(r)

stats = collections.Counter()
rows = []          # 확인할 줄
seen_key = collections.Counter((nroute(r['노선명']), nplace(r['시설물 명칭']), ndir(r['방향'])) for r in status)
for r in status:
    stats['status'] += 1
    kind = r['비고'] or ''
    if not KEEP_KIND.search(kind) or SKIP_FORM.search(r['분기형태'] or '') or ndir(r['방향']) in NO_DIR:
        stats['skip_kind'] += 1
        continue
    key = (nroute(r['노선명']), nplace(r['시설물 명칭']), ndir(r['방향']))
    if seen_key[key] > 1:
        stats['skip_dupkey'] += 1
        continue
    cols = [('L', ncolor(r['좌'])), ('R', ncolor(r['우']))]
    cols = [(s, c) for s, c in cols if c]
    if not cols or any(c == '?' for _, c in cols):
        stats['skip_color'] += 1
        continue
    texts = {}
    rps = rp_by.get(key, [])
    if len(rps) == 1:
        q = rps[0]
        same = [(s, c) for s, c in [('L', ncolor(q['색상 좌'])), ('R', ncolor(q['색상 우']))] if c] == cols
        if same:
            for s, col in (('L', '노면문자 좌'), ('R', '노면문자 우')):
                t = re.sub(r'\s', '', q[col] or '')
                if t:
                    texts[s] = t
        else:
            stats['repaint_color_differs'] += 1
    if len(cols) == 2 and len(texts) < 2:
        stats['skip_two_no_text'] += 1
        continue
    jc = '분기점' in kind and '나들목' not in kind or is_jc_name(r['시설물 명칭'])
    ic_only = '나들목' in kind and '분기점' not in kind and not is_jc_name(r['시설물 명칭'])
    rows.append({'route': key[0], 'place': key[1], 'dir': key[2], 'name': r['시설물 명칭'].strip(), 'line': r['노선명'].strip(),
                 'cols': cols, 'texts': texts, 'cls': 'jc' if jc else 'ic' if ic_only else 'any', 'form': r['분기형태']})
stats['candidates'] = len(rows)


# ---------------------------------------------------------------- OSM
class H(osmium.SimpleHandler):
    def __init__(self):
        super().__init__()
        self.ways, self.junc, self.places = [], [], collections.defaultdict(list)

    def node(self, n):
        t = n.tags
        if t.get('highway') == 'motorway_junction':
            names = {t.get(k) for k in ('name', 'name:ko', 'short_name', 'short_name:ko', 'alt_name') if t.get(k)}
            if names:
                self.junc.append((n.id, n.location.lat, n.location.lon, sorted(names)))
        pl = t.get('place')
        if pl in ('city', 'town', 'village', 'suburb', 'quarter', 'borough'):
            for k in ('name', 'name:ko'):
                v = t.get(k)
                if v:
                    self.places[re.sub(r'(특별자치시|특별자치도|특별시|광역시|시|군|구|읍|면|동)$', '', v.replace(' ', ''))].append(
                        (pl, n.location.lat, n.location.lon))

    def way(self, w):
        hw = w.tags.get('highway')
        if hw not in ROADS:
            return
        try:
            pts = [(n.ref, n.location.lat, n.location.lon) for n in w.nodes]
        except osmium.InvalidLocationError:
            return
        ow = w.tags.get('oneway', '')
        one = ow in ('yes', '1', 'true', '-1') or (hw in ('motorway', 'motorway_link') and ow != 'no') or w.tags.get('junction') == 'roundabout'
        if ow == '-1':
            pts = pts[::-1]
        dest = ';'.join(w.tags.get(k, '') for k in ('destination', 'destination:ko', 'destination:ref', 'destination:street') if w.tags.get(k))
        self.ways.append((hw, w.tags.get('name', '') or '', w.tags.get('ref', '') or '', dest, one, pts))


h = H()
h.apply_file(PBF, locations=True)
pos, out, inc = {}, collections.defaultdict(list), collections.defaultdict(list)
for wi, (hw, name, ref, dest, one, pts) in enumerate(h.ways):
    for n, la, lo in pts:
        pos[n] = (la, lo)
    for i in range(len(pts) - 1):
        a, b = pts[i][0], pts[i + 1][0]
        out[a].append((b, wi))
        inc[b].append((a, wi))
        if not one:
            out[b].append((a, wi))
            inc[a].append((b, wi))
print('osm ways', len(h.ways), 'junction nodes', len(h.junc), 'places', len(h.places))


def brg(a, b):
    pa, pb = pos[a], pos[b]
    return math.degrees(math.atan2((pb[1] - pa[1]) * kx(pa[0]), (pb[0] - pa[0]) * KY)) % 360


def dist(a, b):
    pa, pb = pos[a], pos[b]
    return math.hypot((pb[0] - pa[0]) * KY, (pb[1] - pa[1]) * kx(pa[0]))


def dist_ll(p, q):
    return math.hypot((p[0] - q[0]) * KY, (p[1] - q[1]) * kx(p[0]))


def bearing_ll(p, q):
    return math.degrees(math.atan2((q[1] - p[1]) * kx(p[0]), (q[0] - p[0]) * KY)) % 360


def dest_names(wi):
    d = h.ways[wi][3]
    return {x for x in re.split(r'[;,/·]+', re.sub(r'\s', '', d)) if len(x) >= 2}


def upstream(n, wmain):
    """이름 점 n 에서 같은 본선 도로를 UP m 거슬러 오른 점과 그 첫 간선"""
    cur, d, seen = n, 0.0, {n}
    while d < UP:
        cand = [(a, wi) for a, wi in inc.get(cur, []) if h.ways[wi][0] in MAIN and a not in seen]
        if not cand:
            break
        same = [c for c in cand if h.ways[c[1]][1] == h.ways[wmain][1]] or cand
        a, wi = same[0]
        d += dist(a, cur)
        seen.add(a)
        cur = a
    return cur


def explore(start, wmain):
    """start 에서 하류로 모든 길: [[(노드, 간선의 way 번호)…]]. 본선 = 같은 이름 본선 도로만 따라간 길."""
    paths = []
    stack = [([(start, wmain)], 0.0)]
    while stack:
        p, d = stack.pop()
        cur = p[-1][0]
        prev = p[-2][0] if len(p) > 1 else None
        nxt = [(b, wi) for b, wi in out.get(cur, []) if b != prev and all(b != q[0] for q in p)]
        if d >= LIMIT or not nxt or len(paths) > 400:
            paths.append(p)
            continue
        for b, wi in nxt:
            stack.append((p + [(b, wi)], d + dist(cur, b)))
    return paths


def is_main_step(step, mname):
    hw, name = h.ways[step[1]][0], h.ways[step[1]][1]
    return hw in MAIN and name == mname


# 자료 노선명 → OSM 본선 이름 (2026-11-20 OSM 이름 그대로). 없는 노선은 '<노선>고속도로'·'<노선>순환고속도로'
ALIAS = {'서울외곽': ['수도권제1순환고속도로'], '제2': ['수도권제2순환고속도로'],
         '청주영덕': ['서산영덕고속도로', '당진영덕고속도로'], '당진청주': ['서산영덕고속도로', '당진영덕고속도로'],
         '당진대전': ['서산영덕고속도로', '당진영덕고속도로', '당진대전고속도로'],
         '중앙': ['중앙고속도로', '대구부산고속도로'], '중앙선(대구~부산)': ['대구부산고속도로'], '중앙선의지': ['중앙고속도로지선'],
         '호남지': ['호남고속도로지선'], '중부내륙지': ['중부내륙고속도로지선'], '남해선(영암순천)': ['남해고속도로'],
         '동해선(부산~포항)': ['부산포항고속도로', '동해고속도로'], '부산포항': ['부산포항고속도로', '동해고속도로'],
         '동해': ['동해고속도로', '포항영덕고속도로']}


def route_ok(route, mname):
    return mname in ALIAS.get(route, [route + '고속도로', route + '순환고속도로'])


def approaches_for(row):
    out_ = []
    for jid, la, lo, names in h.junc:
        if not any(nplace(x) == row['place'] for x in names):
            continue
        jc = any(is_jc_name(x) for x in names)
        if row['cls'] == 'jc' and not jc or row['cls'] == 'ic' and jc:
            continue
        mains = [wi for a, wi in inc.get(jid, []) if h.ways[wi][0] in MAIN and route_ok(row['route'], h.ways[wi][1])]
        if not mains:
            continue
        out_.append((jid, mains[0]))
    return out_


def path_len(p, i0, i1):
    return sum(dist(p[k][0], p[k + 1][0]) for k in range(i0, i1))


def point_after(p, i0, m):
    """p 의 i0 노드부터 m 미터 뒤 점 (모자라면 끝 노드)"""
    d = 0.0
    for k in range(i0, len(p) - 1):
        s = dist(p[k][0], p[k + 1][0])
        if d + s >= m:
            t = (m - d) / s if s else 0
            a, b = pos[p[k][0]], pos[p[k + 1][0]]
            return (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t), True
        d += s
    return pos[p[-1][0]], d >= 40


def seg_dist(p, a, b):
    k = kx(a[0])
    bx, by = (b[1] - a[1]) * k, (b[0] - a[0]) * KY
    px, py = (p[1] - a[1]) * k, (p[0] - a[0]) * KY
    l2 = bx * bx + by * by
    t = max(0.0, min(1.0, (px * bx + py * by) / l2)) if l2 else 0.0
    return math.hypot(px - t * bx, py - t * by)


def sep_point(p, i0, others):
    """p 의 i0 노드(갈림)부터 따라가며, others(길 목록, 같은 i0 부터) 어느 것에서도 SEP m 넘게 떨어진 첫 점. 없으면 None"""
    segs = []
    for q in others:
        for k in range(i0, len(q) - 1):
            segs.append((pos[q[k][0]], pos[q[k + 1][0]]))
    d = 0.0
    for k in range(i0, len(p) - 1):
        a, b = pos[p[k][0]], pos[p[k + 1][0]]
        s_ = dist_ll(a, b)
        steps = max(1, int(s_ // 10))
        for q in range(1, steps + 1):
            t = q / steps
            pt = (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)
            dd = d + s_ * t
            if dd > SEP_MAX:
                return None
            if dd >= 40 and all(seg_dist(pt, x, y) > SEP for x, y in segs):
                return pt
        d += s_
    return None


class Approach:
    def __init__(self, jid, wmain):
        self.jid, self.wmain = jid, wmain
        self.mname = h.ways[wmain][1]
        self.start = upstream(jid, wmain)
        self.paths = explore(self.start, wmain)
        # 본선 길: 본선 도로만 가장 길게
        best = None
        for p in self.paths:
            k = 1
            while k < len(p) and is_main_step(p[k], self.mname):
                k += 1
            if best is None or k > best[1]:
                best = (p, k)
        self.main = best[0][:best[1]]
        self.main_nodes = {s[0]: i for i, s in enumerate(self.main)}
        self.cum = [0.0]
        for i in range(1, len(self.main)):
            self.cum.append(self.cum[-1] + dist(self.main[i - 1][0], self.main[i][0]))
        # 이름 점이 본선 위 어디인지
        self.j_at = self.main_nodes.get(jid)
        i = self.j_at if self.j_at is not None else 0
        a, b = self.main[max(0, i - 1)][0], self.main[min(len(self.main) - 1, max(1, i))][0]
        self.heading = brg(a, b) if a != b else brg(self.main[0][0], self.main[-1][0])
        # 갈래(본선을 떠나는 길)마다 떠나는 곳
        self.exits = []   # (path, leave index)
        for p in self.paths:
            k = 1
            while k < len(p) and k < len(self.main) and p[k][0] == self.main[k][0]:
                k += 1
            if k >= len(p) or k >= len(self.main):   # 본선 그대로(이름만 바뀌어 이어지는 길 포함)
                continue
            self.exits.append((p, k - 1))
        # 길마다 칸별 방면 글자: 본선을 떠난 뒤 다른 고속도로에 올라서기 전까지의 연결로 destination
        self.names, self.along = [], {}
        self.kids = collections.defaultdict(lambda: collections.defaultdict(list))   # (칸, 노드) → {다음 노드: [길 번호]}
        for qi, p in enumerate(self.paths):
            k = 1
            while k < len(p) and k < len(self.main) and p[k][0] == self.main[k][0]:
                k += 1
            lv = k - 1
            nm = [frozenset()] * len(p)
            for j in range(lv + 1, len(p)):
                if h.ways[p[j][1]][0] in MAIN:   # 다른 고속도로에 올라서면 그 뒤 연결로 글자는 이 갈래 것이 아니다
                    break
                nm[j] = frozenset(dest_names(p[j][1]))
            suf = [frozenset()] * (len(p) + 1)
            for j in range(len(p) - 1, -1, -1):
                suf[j] = suf[j + 1] | nm[j]
            self.names.append((lv, suf))
            d = 0.0
            for j in range(len(p)):
                if j:
                    d += dist(p[j - 1][0], p[j][0])
                self.along.setdefault((j, p[j][0]), d)
                if j + 1 < len(p):
                    self.kids[(j, p[j][0])][p[j + 1][0]].append(qi)
        self.j_along = self.cum[self.j_at] if self.j_at is not None else 0.0

    def splits(self, lo, hi):
        """갈림 노드들 (시작점에서 거리 순), 이름 점 기준 lo~hi m 안"""
        out_ = []
        for (j, n), ch in self.kids.items():
            if len(ch) >= 2:
                al = self.along[(j, n)]
                if lo <= al - self.j_along <= hi:
                    out_.append((al, j, n))
        return sorted(out_)

    def sub(self, j, qs):
        u = set()
        for qi in qs:
            u |= self.names[qi][1][j + 1]
        return u

    def branch(self, j, qs):
        """갈래(j 다음 노드가 같은 길들)의 공통 앞부분과 본선을 떠난 칸"""
        ps = [self.paths[qi] for qi in qs]
        k = j + 1
        while all(k < len(p) for p in ps) and len({p[k][0] for p in ps}) == 1:
            k += 1
        return ps[0][:k], min(self.names[qi][0] for qi in qs)

    def side(self, j, n, ca, cb):
        """n 에서 ca 쪽이 cb 쪽보다 왼쪽인가"""
        qi = self.kids[(j, n)][ca][0]
        p = self.paths[qi]
        h0 = brg(p[j - 1][0], n) if j >= 1 else brg(n, ca)
        return turn(h0, brg(n, ca)) < turn(h0, brg(n, cb))

    def is_main_child(self, j, n, c):
        return j + 1 < len(self.main) and self.main[j][0] == n and self.main[j + 1][0] == c

    def pair(self, A, B):
        """좌 글자 A·우 글자 B 가 처음으로 서로 다른 갈래로 나뉘는 곳: (j, n, A 쪽 다음 노드, B 쪽 다음 노드) 또는 None"""
        for al, j, n in self.splits(-300, 2500):
            ch = self.kids[(j, n)]
            subs = {c: self.sub(j, qs) for c, qs in ch.items()}
            ca = [c for c, u in subs.items() if tmatch(A, u) and not tmatch(B, u)]
            cb = [c for c, u in subs.items() if tmatch(B, u) and not tmatch(A, u)]
            if len(ca) == 1 and len(cb) == 1:
                return j, n, ca[0], cb[0]
            if any(tmatch(A, u) and tmatch(B, u) for c, u in subs.items()) or len(ca) > 1 or len(cb) > 1:
                continue
            if ca or cb:   # 한쪽만 갈래가 분명하고 다른 쪽 글자는 어디에도 없음 → 모름
                return None
        return None

    def exit_after(self, al0, T):
        """본선에서 거리 al0 뒤, 글자 T 가 맞는 출구(본선을 떠나는 갈래)의 끝점 — 본선 위 다음 갈림들 중 첫 곳, 1.5km 안"""
        for i in range(len(self.main) - 1):
            al = self.along.get((i, self.main[i][0]))
            if al is None or al <= al0 or al > al0 + 1500:
                continue
            ch = self.kids.get((i, self.main[i][0]))
            if not ch or len(ch) < 2:
                continue
            m = [c for c, qs in ch.items() if not self.is_main_child(i, self.main[i][0], c) and tmatch(T, self.sub(i, qs))]
            if not m:
                continue
            if len(m) > 1:
                return None
            rest = [q for c, qs in ch.items() if c != m[0] for q in qs]
            pe, _ = self.branch(i, ch[m[0]])
            return sep_point(pe, i, [self.paths[q] for q in rest])
        return None

    def single(self, T):
        """글자 T 가 처음으로 한 갈래(본선을 떠나는 쪽)에만 맞는 곳: (j, n, 그 다음 노드) 또는 None"""
        for al, j, n in self.splits(-300, 1000):
            ch = self.kids[(j, n)]
            m = [c for c, qs in ch.items() if tmatch(T, self.sub(j, qs))]
            if len(m) == 1:
                return None if self.is_main_child(j, n, m[0]) else (j, n, m[0])
        return None


def tmatch(text, names):
    toks = [t for t in re.split(r'[/,·]+', text) if len(t) >= 2]
    return any(d in text or any(t in d or d in t for t in toks) for d in names)


def split_of(pa, pb):
    """두 길이 헤어지는 곳: (노드 번호 i, a 가 더 왼쪽인가)"""
    k = 0
    while k < len(pa) and k < len(pb) and pa[k][0] == pb[k][0]:
        k += 1
    if k == 0 or k >= len(pa) or k >= len(pb):
        return None, None
    n = pa[k - 1][0]
    h0 = brg(pa[k - 2][0], n) if k >= 2 else brg(n, pa[k][0])
    ta, tb = turn(h0, brg(n, pa[k][0])), turn(h0, brg(n, pb[k][0]))
    return k - 1, ta < tb


def place_dir(row, jpos, heading):
    """방향 글자(첫 이름)가 이 접근 쪽인가: True / False / None(모름)"""
    first = re.split(r',', row['dir'])[0]
    first = re.sub(r'(특별자치시|특별시|광역시|시|군|구|읍|면|동|방향|방면)$', '', first)
    cands = h.places.get(first) or []
    if not cands:
        return None
    rank = {'city': 5, 'town': 4, 'borough': 3, 'suburb': 3, 'village': 2, 'quarter': 2}
    top = max(rank[c[0]] for c in cands)
    cs = [c for c in cands if rank[c[0]] == top]
    c = min(cs, key=lambda c: dist_ll(jpos, (c[1], c[2])))
    if dist_ll(jpos, (c[1], c[2])) < 1500:
        return None
    d = adiff(bearing_ll(jpos, (c[1], c[2])), heading)
    return True if d < 70 else False if d > 110 else None


app_cache = {}


def approach(jid, wmain):
    k = (jid, wmain)
    if k not in app_cache:
        app_cache[k] = Approach(jid, wmain)
    return app_cache[k]


route_pairs = collections.Counter()
results = collections.defaultdict(list)   # 접근(시작 노드, 본선 이름) → [(줄, 갈래들)]
reasons = collections.Counter()
for row in rows:
    aps = approaches_for(row)
    if not aps:
        reasons['no_osm_place'] += 1
        continue
    # 같은 본선 방향의 이름 점이 여럿이면 가장 위쪽(다른 이름 점을 본선에 품는) 것 하나
    objs = []
    for jid, wm in aps:
        try:
            objs.append(approach(jid, wm))
        except (KeyError, IndexError, TypeError):
            continue
    objs = [a for a in objs if len(a.main) > 1]
    objs = [a for a in objs if not any(b is not a and b.j_at is not None and a.jid in b.main_nodes and b.main_nodes[a.jid] > b.j_at
                                        for b in objs)]
    got = []
    dbg = DEBUG and DEBUG != '*' and DEBUG in row['name']
    if dbg:
        print('ROW', row['line'], row['name'], row['dir'], row['cols'], row['texts'], 'approaches', len(objs), 'of', len(aps))
    for a in objs:
        jpos = pos[a.jid]
        pd = place_dir(row, jpos, a.heading)
        if dbg:
            print('  AP', [round(v, 5) for v in jpos], a.mname, round(a.heading), 'dir', pd, 'j_at', a.j_at, 'main', round(a.cum[-1]))
            for al, j, n in a.splits(-300, 2500):
                print('     split', round(al - a.j_along), [round(v, 5) for v in pos[n]],
                      [('M' if a.is_main_child(j, n, c) else '') + ','.join(sorted(a.sub(j, qs))[:6]) for c, qs in a.kids[(j, n)].items()])
        if pd is False:
            continue
        cols = row['cols']
        if len(cols) == 2:
            r2 = a.pair(row['texts']['L'], row['texts']['R'])
            if dbg:
                print('     pair', r2 and (r2[0], [round(v, 5) for v in pos[r2[1]]]))
            if not r2:
                continue
            j, n, ca, cb = r2
            if not a.side(j, n, ca, cb):
                reasons['side_mismatch'] += 1
                if dbg:
                    print('     side mismatch at', [round(v, 5) for v in pos[n]])
                continue
            qa, qb = a.kids[(j, n)][ca], a.kids[(j, n)][cb]
            (pa, la), (pb, lb) = a.branch(j, qa), a.branch(j, qb)
            ea = sep_point(pa, j, [a.paths[q] for q in qb])
            eb = sep_point(pb, j, [a.paths[q] for q in qa])
            # 2점2분기: 한 글자 쪽이 본선 그대로면, 그 선은 본선을 더 가다 다음 출구로 빠진다 → 끝점은 그 출구 위 (본선 위가 아니라)
            for txt, child, idx in ((row['texts']['L'], ca, 0), (row['texts']['R'], cb, 1)):
                if a.is_main_child(j, n, child):
                    deep = a.exit_after(a.along[(j, n)], txt)
                    if dbg:
                        print('     main side', txt, deep and [round(v, 5) for v in deep])
                    if idx == 0:
                        ea = deep
                    else:
                        eb = deep
            if not (ea and eb):
                reasons['too_close'] += 1
                continue
            leave = min(la, lb, len(a.main) - 1)
            got.append((a, pd, [(cols[0][1], ea), (cols[1][1], eb)], leave, False))
        else:
            side, col = cols[0]
            t = row['texts'].get(side) or (list(row['texts'].values())[0] if len(row['texts']) == 1 else None)
            r1 = a.single(t) if t else None
            if dbg:
                print('     single', t, r1 and (r1[0], [round(v, 5) for v in pos[r1[1]]]))
            if r1:
                j, n, c = r1
                pe, leave = a.branch(j, a.kids[(j, n)][c])
                j0 = j
                rest = [qi for c2, lst in a.kids[(j, n)].items() if c2 != c for qi in lst]
            elif pd and a.j_at is not None:
                # 글자가 없거나 안 맞으면: 방향이 분명한 접근에서 그 나들목 점 근처(앞 100m ~ 뒤 600m)에서 본선을 떠나는 곳이 한 곳뿐일 때
                spots = sorted({lv for p, lv in a.exits if -100 <= a.cum[lv] - a.cum[a.j_at] <= 600})
                if len(spots) != 1:
                    continue
                leave = j0 = spots[0]
                n = a.main[leave][0]
                qs = [qi for c, lst in a.kids[(leave, n)].items() if not a.is_main_child(leave, n, c) for qi in lst]
                if not qs:
                    continue
                pe, _ = a.branch(leave, qs)
                rest = [qi for c, lst in a.kids[(leave, n)].items() if a.is_main_child(leave, n, c) for qi in lst]
            else:
                continue
            e = sep_point(pe, j0, [a.paths[q] for q in rest])
            if not e:
                reasons['too_close'] += 1
                continue
            got.append((a, pd, [(col, e)], min(leave, len(a.main) - 1), not r1))
    if not got:
        reasons['no_match'] += 1
        continue
    # 방향이 분명한 접근이 있으면 그것만
    sure = [g for g in got if g[1]]
    if sure:
        got = sure
    if len({id(g[0]) for g in got}) > 1 and (not sure or any(g[4] for g in got)):
        reasons['ambiguous_approach'] += 1   # 글자 없이 고른 나들목 출구가 여러 곳이거나, 방향을 모르는데 여러 접근에 맞음
        continue
    for a, pd, br, leave, _ in got:
        results[(a.start, a.mname)].append((row, a, br, leave))
        route_pairs[(row['route'], a.mname)] += 1

out_rows, kept_names = [], []
for key, lst in results.items():
    a = lst[0][1]
    # 같은 갈래 끝(30m 안)에 다른 색을 말하면 버림
    ends = []
    bad = False
    for row, _, br, _ in lst:
        for c, e in br:
            for c2, e2 in ends:
                if dist_ll(e, e2) < 40 and c2 != c:
                    bad = True
            ends.append((c, e))
    if bad:
        reasons['conflict'] += 1
        if DEBUG == '*':
            print('  CONFLICT', a.mname, [(r['line'], r['name'], r['dir'], r['cols'], r['texts']) for r, *_ in lst])
        continue
    uniq = []
    for c, e in ends:
        if not any(dist_ll(e, e2) < 30 for _, e2 in uniq):
            uniq.append((c, e))
    leave = min(x[3] for x in lst)
    lp = pos[a.main[leave][0]]
    hd = brg(a.main[max(0, leave - 1)][0], a.main[leave][0]) if leave > 0 else a.heading
    nm = lst[0][0]['name']
    out_rows.append([round(lp[0], 6), round(lp[1], 6), round(hd), [[c, round(e[0], 6), round(e[1], 6)] for c, e in uniq], nm])
    kept_names.append('%s %s %s %s' % (lst[0][0]['line'], nm, '/'.join(r['dir'] for r, *_ in lst), ' '.join('%s' % c for c, _ in uniq)))

out_rows.sort()
ded = []
for r in out_rows:
    if any(all(any(c == c2 and dist_ll((la, lo), (la2, lo2)) < 40 for c2, la2, lo2 in q[3]) for c, la, lo in r[3]) for q in ded):
        reasons['dup_out'] += 1
        continue
    ded.append(r)
out_rows = ded
# 네이버 길안내로 확인한 줄 (자료·OSM 짝 맞추기로 못 찾은 곳). 다시 만들어도 남게 여기에 둔다 (위 중복 거르기 뒤에 붙임)
MANUAL = [
    # v201 (2026-11-24 keys 세션, 네이버 에뮬레이터 신갈오거리→진황도로): 경부 상행 판교분기점 1차 갈림('일산, 구리' 오른쪽 방향)에서
    # 네이버 그림의 갈 차로 2개가 분홍. 여기는 본선·연결로가 수십 m 안에 나란히 달려 갈림 바로 뒤 점은 본선 직진 차에도 걸린다
    # (OSM 경부 본선에서 0~22m). 그래서 갈래 끝은 2차 갈림 뒤 구리 쪽 끝(본선 212m·서울/양재 연결로 224m) — 일산으로 가는 차는
    # 1차 분홍 없이 2차의 녹색만 본다 (틀린 색보다 없는 편). 시작점은 갈림 약 300m 앞 본선 위
    [37.398495, 127.1006, 352, [['p', 37.406258, 127.09743]], '판교분기점'],
]
out_rows = out_rows + MANUAL
doc = {'v': 1, 'src': '한국도로공사 노면색깔유도선 현황(2026-08)·재도색 현황(2024-06) + OSM 확인 (tools/build_colorlines.py)',
       'fields': 'lat,lng,heading,[[color(p 분홍 g 녹색 lg 연한녹색),endLat,endLng]...],name', 'rows': out_rows}
with open(OUT, 'w', encoding='utf-8', newline='\n') as f:
    json.dump(doc, f, ensure_ascii=False, separators=(',', ':'))
    f.write('\n')
print('stats', dict(stats))
print('reasons', dict(reasons))
print('rows', len(out_rows), '→', OUT)
if DEBUG:
    print('ROUTES', sorted(route_pairs.items()))
    for s in kept_names:
        if DEBUG == '*' or DEBUG in s:
            print('  ', s)
