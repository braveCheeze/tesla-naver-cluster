"""고속도로·도시고속도로 갈림점마다 갈래별 방면 (OSM destination 태그) → data/junc_dest.json

2026-11-25 운전자 (네이버 판교분기점 그림 '일산 안양 | 판교'를 보내며): '여기는 일산 안양 이렇게 알려주잖아, 이런 식으로 알려줘야 해 —
차선이랑 바닥에 있는 것도 저렇게 다르게 나오고'. 우리 경로 자료에는 우리가 가는 갈래의 방면만 있다. 가지 않는 갈래의 방면은
OpenStreetMap(ODbL)의 연결로 destination 태그에서 가져온다. 네이버 그림·표지 글은 쓰지 않는다.

- 갈림점: 한 방향 motorway·motorway_link·trunk·trunk_link 길에서 한 점에서 두 갈래 이상으로 나뉘는 곳
- 갈래마다: 갈림점에서 80·200·350m 간 자리(경로가 어느 갈래로 가는지 앱이 이 자리로 가른다 — 판교분기점은 80m 뒤에도 두 갈래가 9m 거리),
  방면(destination, 없으면 다음 길을 따라가 찾음), 노선 번호(ref)·길 이름(name)
- 줄: [위도, 경도, 들어오는 방향(°), [[80m 위도, 경도, '방면1;방면2', 'ref', '이름', 200m 위도, 경도, 350m 위도, 경도], ...]]
  (길이 먼저 끝나면 뒤 자리는 없다). 방면을 아는 갈래가 하나 이상인 갈림점만
- 사용:  set TMP=D:\\tmp & py -I tools\\osm_junc_dest.py D:\\osm\\south-korea-latest.osm.pbf data\\junc_dest.json
"""
import json
import math
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


class H(osmium.SimpleHandler):
    def __init__(self):
        super().__init__()
        self.ways = {}

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
                           'nm': w.tags.get('name', ''), 'hw': hw}


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


rows = []
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
    rows.append([here[0], here[1], inb, br])

json.dump({'v': 2, 'src': 'OpenStreetMap contributors (ODbL), destination tags', 'ahead': AHEADS, 'rows': rows},
          open(OUT, 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
print('갈림점', len(rows))
