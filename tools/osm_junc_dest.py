"""고속도로·도시고속도로 갈림점마다 갈래별 방면 (OSM destination 태그) → data/junc_dest.json

2026-11-25 운전자 (네이버 판교분기점 그림 '일산 안양 | 판교'를 보내며): '여기는 일산 안양 이렇게 알려주잖아, 이런 식으로 알려줘야 해 —
차선이랑 바닥에 있는 것도 저렇게 다르게 나오고'. 우리 경로 자료에는 우리가 가는 갈래의 방면만 있다. 가지 않는 갈래의 방면은
OpenStreetMap(ODbL)의 연결로 destination 태그에서 가져온다. 네이버 그림·표지 글은 쓰지 않는다.

- 갈림점: 한 방향 motorway·motorway_link·trunk·trunk_link 길에서 한 점에서 두 갈래 이상으로 나뉘는 곳
- 갈래마다: 갈림점에서 80·200·350m 간 자리(경로가 어느 갈래로 가는지 앱이 이 자리로 가른다 — 판교분기점은 80m 뒤에도 두 갈래가 9m 거리),
  방면(destination, 없으면 다음 길을 따라가 찾음), 노선 번호(ref)·길 이름(name)
- 줄: [위도, 경도, 들어오는 방향(°), [[80m 위도, 경도, '방면1;방면2', 'ref', '이름', 200m 위도, 경도, 350m 위도, 경도], ...], [갈래마다 차로 수]]
  (길이 먼저 끝나면 뒤 자리는 없다). 방면을 아는 갈래가 하나 이상인 갈림점만
- v3 (v255, 2026-11-25 부모 세션 'OSM lanes 대체'): 갈래마다 갈림 바로 뒤 길의 lanes 태그(차로 수, 없으면 0). 정밀도로지도 분기 단면
  (data/forks.json, 경부만)이 없는 곳에서 앱이 분기점 그림 모양(4+2, 2+2, 4+1, 3+1)을 고른다. 네이버 확대 그림의 차로 수와 맞다:
  하남분기점 중부 서행 본선 4 + '판교;서하남' 2. 연결로에 lanes 가 없는 곳은 LANES_FIX 로 채운다(서하남IC)
- v4 (v256, 부모 세션 '네이버처럼' 점검표 — 성남IC 네이버 '일산 일산 일산 일산 | 성남 광주', 표지 '2B 성남'): 여섯째 칸 {…}
    (v257: v256 의 'a' 앞쪽 방면 — 앞쪽 본선 destination · 휴게소 방향 이름 — 은 뺐다. 부모 세션: 휴게소 'X방향'은 끝 도시라 표지판 방면이
     아니다(경부 하행 '부산', 네이버 '대전'). 운전자 '이런거 실수나오면 안 된다'. 도시 이름은 그 갈림점의 OSM destination 이나 확인된 표만)
    x  나들목 번호 (OSM motorway_junction ref, 갈림점이나 들어오는 길 700m 안·연결로 900m 안의 가장 가까운 것: 서하남 '4', 성남 '2')
    xn 그 나들목 이름
    m  1 = 들어오는 길이 motorway·motorway_link (v262, 초록 표지)
    s  갈래 안에서 다시 갈리는 차로 수 {갈래 번호: [왼쪽 차로 수, 오른쪽 차로 수]} (판교분기점 경부 북행 '일산;구리' 3 = 일산 1 + 구리 2)
    i  들어오는 길(갈림 바로 앞)의 lanes 태그 (v292, 부모 세션 09:04 '2차선인데 4차선 팝업': 그림의 곧게 가는 차로가 들어오는 길의
       차로 수보다 많지 않게). 모르면 넣지 않는다
    l  1 = 들어오는 길이 연결로(motorway_link·trunk_link) — 연결로 안 갈림 (v293, 부모 세션: 차로 수를 모르는 일반도로·연결로 안 갈림은
       2 + 2 갈림길 그림 대신 차로 수 없는 갈림 그림. 고속도로 본선 갈림은 그대로)
- 사용:  set TMP=D:\\tmp & py -I tools\\osm_junc_dest.py D:\\osm\\south-korea-latest.osm.pbf data\\junc_dest.json
"""
import json
import math
import os
import sys

sys.path.insert(0, r'D:\pylib')
import osmium  # noqa: E402

PBF, OUT = sys.argv[1:3]
HW = {'motorway', 'motorway_link', 'trunk', 'trunk_link'}
AHEADS = (80.0, 200.0, 350.0)   # 갈래마다 이 거리 자리 (갈림 바로 뒤에는 두 갈래가 붙어 있어 멀리서 가른다)


def hav(a, b):
    k = math.pi / 180
    x = math.sin((b[0] - a[0]) * k / 2) ** 2 + math.cos(a[0] * k) * math.cos(b[0] * k) * math.sin((b[1] - a[1]) * k / 2) ** 2
    return 2 * 6371000 * math.asin(math.sqrt(x))


def brg(a, b):
    k = math.pi / 180
    y = math.sin((b[1] - a[1]) * k) * math.cos(b[0] * k)
    x = math.cos(a[0] * k) * math.sin(b[0] * k) - math.sin(a[0] * k) * math.cos(b[0] * k) * math.cos((b[1] - a[1]) * k)
    return (math.atan2(y, x) / k + 360) % 360


def lanes_of(v):
    try:
        return max(0, min(12, int(str(v).split(';')[0].strip())))
    except ValueError:
        return 0


# OSM 연결로에 lanes 태그가 없어 차로 수를 모르는 갈래 (갈림점 위도, 경도, 갈래 방면에 든 글자, 차로 수, 까닭) — 갈림점 30m 안
LANES_FIX = [
    # 서하남IC 수도권제1순환 북행 출구 '강동;서하남': OSM 연결로(70986691)에 lanes 없음. 진출 차로 2 — 네이버 확대 그림·차로 줄
    # (2026-11-25 jx 비교표: 본선 '구리 대전' 4 + '강동 서하남' 2, 차로 줄 '↑↑↑↑↱↱'), 부모 세션 확인
    (37.511727, 127.150406, '서하남', 2, '서하남IC 북행 출구 진출 2차로 (jx 비교표)'),
    # v256 (부모 세션 점검표: '성남IC is 4 through + 1 exit; 판교JC from 서울TG is 4 + 1 + 2' — 네이버 확대 그림·차로 줄의 차로 수)
    (37.430502, 127.123402, '성남;광주', 1, '성남IC 남행 출구 1차로 (jx 비교표)'),
    (37.400568, 127.100206, '서울', 4, '판교분기점 경부 북행 본선 4차로 (jx 비교표, 버스전용차로 빼고)'),
    (37.400568, 127.100206, '일산;구리', 3, '판교분기점 경부 북행 연결로 3차로 = 일산 1 + 구리 2 (jx 비교표)', [1, 2]),
]


class H(osmium.SimpleHandler):
    def __init__(self):
        super().__init__()
        self.ways = {}
        self.mj = {}   # 나들목 점: id → (번호, 이름)

    def node(self, n):
        if n.tags.get('highway') == 'motorway_junction' and n.tags.get('ref'):
            self.mj[n.id] = (n.tags.get('ref'), n.tags.get('name', ''))

    def way(self, w):
        hw = w.tags.get('highway')
        if hw not in HW:
            return
        ow = w.tags.get('oneway', '')
        # motorway 는 따로 적지 않아도 한 방향. trunk 는 oneway=yes 만 (양방향 길의 갈림은 뺀다)
        if ow == '-1' or (hw.startswith('trunk') and ow != 'yes') or ow == 'no':
            return
        try:
            pts = [(round(n.lat, 6), round(n.lon, 6)) for n in w.nodes]
        except osmium.InvalidLocationError:
            return
        self.ways[w.id] = {'n': [n.ref for n in w.nodes], 'p': pts, 'd': w.tags.get('destination', ''), 'r': w.tags.get('ref', ''),
                           'nm': w.tags.get('name', ''), 'hw': hw, 'ln': lanes_of(w.tags.get('lanes', ''))}


h = H()
h.apply_file(PBF, locations=True, idx='flex_mem')
W = h.ways
starts, through, ends = {}, {}, {}
for wid, w in W.items():
    for k, nid in enumerate(w['n']):
        if k < len(w['n']) - 1:
            through.setdefault(nid, []).append((wid, k))   # 이 점에서 나가는 이어짐
        if k > 0:
            ends.setdefault(nid, []).append((wid, k))      # 이 점으로 들어오는 이어짐
    starts.setdefault(w['n'][0], []).append(wid)


def follow(wid, k):
    """(길, 시작 번호)에서 앞으로 점들을 이어 붙이며 AHEAD m 자리와 방면을 찾는다"""
    pts, dest, ref, nm = [], '', '', ''
    seen = set()
    cur, kk = wid, k
    for hop in range(10):
        w = W[cur]
        seen.add(cur)
        seg = w['p'][kk:]
        pts += seg if not pts else seg[1:]
        if not dest and w['d']:
            dest = w['d']
        ref = ref or w['r']
        nm = nm or w['nm']
        dist = sum(hav(pts[i - 1], pts[i]) for i in range(1, len(pts)))
        if dist >= AHEADS[-1] and (dest or hop >= 3):
            break
        nxt = [x for x in starts.get(w['n'][-1], []) if x not in seen]
        if len(nxt) != 1:   # 또 갈라지거나 끝나면 멈춘다
            # 방면을 못 찾은 채 연결로가 다시 갈라지면 갈래마다 첫 방면을 모은다 (신갈분기점 경부 하행 출구: '인천;안산;동수원' + '원주;마성·에버랜드' → '인천;원주')
            if not dest and len(nxt) >= 2:
                subs = []
                for x in nxt[:3]:
                    d2, c2, h2 = '', x, set()
                    for _ in range(4):
                        if W[c2]['d']:
                            d2 = W[c2]['d']; break
                        h2.add(c2)
                        n2 = [y for y in starts.get(W[c2]['n'][-1], []) if y not in h2]
                        if len(n2) != 1: break
                        c2 = n2[0]
                    if d2: subs.append(d2.split(';')[0])
                if subs:
                    dest = ';'.join(dict.fromkeys(subs))
            break
        cur, kk = nxt[0], 0
    # AHEADS m 자리들 (길이 모자라면 그 자리는 없음, 첫 자리만은 끝점)
    ats = []
    for ah in AHEADS:
        acc, at = 0.0, None
        for i in range(1, len(pts)):
            d = hav(pts[i - 1], pts[i])
            if acc + d >= ah:
                t = (ah - acc) / d
                at = (round(pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t, 6), round(pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t, 6))
                break
            acc += d
        if at is None:
            if not ats:
                ats.append(pts[-1])
            break
        ats.append(at)
    return ats, dest, ref, nm


def exit_ref(nid, wi, ki, links):
    """갈림점의 나들목 번호: 갈림점 → 들어오는 길을 거슬러 700m → 연결로 900m 안의 나들목 점 중 가장 가까운 것"""
    if nid in MJ:
        return MJ[nid]
    best = None
    # 거슬러 올라가기
    cur, k, d, seen = wi, ki, 0.0, set()
    while cur is not None and d < 700:
        w = W[cur]
        seen.add(cur)
        for j in range(k - 1, -1, -1):
            d += hav(w['p'][j], w['p'][j + 1])
            if d > 700:
                break
            if w['n'][j] in MJ and (best is None or d < best[0]):
                best = (d, MJ[w['n'][j]])
        prev = [x for x in ends.get(w['n'][0], []) if x[0] not in seen]
        same = [x for x in prev if W[x[0]]['r'] == W[wi]['r']] or prev
        cur, k = (same[0] if same else (None, 0))
    # 연결로 따라가기
    for wid, k in links:
        cur, kk, d, seen = wid, k, 0.0, set()
        while cur is not None and d < 900:
            w = W[cur]
            seen.add(cur)
            for j in range(kk + 1, len(w['n'])):
                d += hav(w['p'][j - 1], w['p'][j])
                if d > 900:
                    break
                if w['n'][j] in MJ and (best is None or d < best[0]):
                    best = (d, MJ[w['n'][j]])
            nx = [x for x in starts.get(w['n'][-1], []) if x not in seen]
            cur, kk = (nx[0], 0) if len(nx) == 1 else (None, 0)
    return best[1] if best else None


MJ = h.mj
rows, fixed = [], []
for nid, outs in through.items():
    if len(outs) < 2:
        continue
    ins = ends.get(nid, [])
    if not ins:
        continue
    wi, ki = ins[0]
    p0, p1 = W[wi]['p'][ki - 1], W[wi]['p'][ki]
    inb = round(brg(p0, p1))
    br = []
    for wid, k in outs:
        ats, dest, ref, nm = follow(wid, k)
        b = [ats[0][0], ats[0][1], dest, ref, nm]
        for a in ats[1:]:
            b += [a[0], a[1]]
        br.append(b)
    if not any(b[2] for b in br):
        continue
    here = W[outs[0][0]]['p'][outs[0][1]]
    lanes = [W[wid]['ln'] for wid, k in outs]
    extra = {}
    for fx in LANES_FIX:
        la, lo, key, n, why = fx[:5]
        if hav(here, (la, lo)) <= 30:
            for i, b in enumerate(br):
                if key in b[2]:
                    lanes[i] = n
                    if len(fx) > 5:
                        extra.setdefault('s', {})[str(i)] = fx[5]
                    fixed.append((why, here, b[2], n))
    # v4: 나들목 번호 (v257: 앞쪽 방면 'a' 는 뺐다)
    if W[wi]['ln'] > 0:
        extra['i'] = W[wi]['ln']   # v292: 들어오는 길 차로 수
    if W[wi]['hw'].endswith('_link'):
        extra['l'] = 1   # v293: 연결로 안 갈림
    if W[wi]['hw'].startswith('motorway'):
        extra['m'] = 1   # v262: 고속도로·고속도로 연결로 위 갈림 (앱은 한국도로공사 초록 표지)
    xr = exit_ref(nid, wi, ki, [(wid, k) for (wid, k), b in zip(outs, br) if W[wid]['hw'].endswith('_link')])
    if xr:
        extra['x'], extra['xn'] = xr
    rows.append([here[0], here[1], inb, br, lanes, extra])

json.dump({'v': 4, 'src': 'OpenStreetMap contributors (ODbL), destination·lanes tags, motorway_junction ref', 'ahead': AHEADS, 'rows': rows},
          open(OUT, 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
print('갈림점', len(rows), '· 갈래 차로 수를 다 아는 곳', sum(1 for r in rows if all(r[4])), '· 나들목 번호', sum(1 for r in rows if r[5].get('x')))
for f in fixed:
    print('  LANES_FIX', f)
if len(fixed) != len(LANES_FIX):
    sys.exit('LANES_FIX 중 맞는 갈림점이 없는 줄이 있습니다')
