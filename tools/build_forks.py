"""고속도로 분기점·나들목 앞 차로 막대 자료 (data/forks.json). 2026-11-16 사용자 '차선표기' (신갈분기점에서 네이버처럼).

국토지리정보원 정밀도로지도 고속국도 zip(예: '(B110)정밀도로지도_고속국도_1호선(경부선).zip')의 A2_LINK(차로 중심선) 으로:
  1. 차로 링크를 잇는다. 구간 폴더(SEC01, SEC02 …)마다 노드 번호가 따로라 구간 경계에서는 끝점이 1.5m 안·방향 30° 안인
     다음 구간 링크를 이어 붙인다.
  2. 차로 단면(옆 차로 L_LinkID/R_LinkID 로 이어진 같은 방향 차로들, 왼쪽 1차로부터)마다 차로 하나씩 하류로 DIST m 까지 따라가
     닿는 끝점들을 모은다(갈림이 있으면 모두). 끝점을 150m 안끼리 묶은 것이 '갈래'.
  3. 단면에서 갈래가 둘 이상이면(앞에 분기) 그 단면을 한 줄로 남긴다:
       위치(단면 가운데 차로의 하류 끝), 진행 방향, 차로마다 [화살표 글자, 닿는 갈래 번호들], 갈래마다 끝점 좌표.
     화살표 글자: 본선(진행 방향에 가장 가까운 갈래)은 S, 오른쪽 갈래는 R, 왼쪽은 L (둘 다 가면 'SR'), 버스전용차로(LinkType 4)는 끝에 B.
  앱은 길안내 경로가 실제로 지나는 갈래(끝점이 경로 30m 안)로 가는 차로를 파랗게 칠한다 (출구가 둘이어도 헷갈리지 않게).
  끝이 자료 밖(구간이 끊긴 곳)으로 DIST/2 도 못 가고 끝나는 차로는 '?'(모름).

    py -I -X utf8 tools/build_forks.py data/forks.json <고속국도 zip 또는 푼 폴더> [...]

LinkType (2026-11-16 경부선에서 확인): 4 버스전용차로(LaneNo 가 따로 1부터), 6 일반 차로, 3 톨게이트 차로, 5 가속·감속 차로 쪽.
"""
import collections
import json
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build_lanes as B  # noqa: E402  (zip·shp 읽기, 좌표 바꾸기를 그대로 쓴다)

DIST = 2000.0       # 단면에서 하류로 따라가는 거리
CLUSTER = 150.0     # 끝점 묶기
STITCH = 1.5        # 구간 경계 잇기
SAMPLE = 120.0      # 같은 차로 줄에서 단면을 이만큼마다 하나 (너무 촘촘하지 않게)
KEEP = 1300.0       # 첫 갈림(끝점이 갈라지는 곳)까지 이 안의 단면만


def hd(a, b):
    return math.degrees(math.atan2((b[1] - a[1]) * B_KX(a[0]), (b[0] - a[0]) * 110540.0)) % 360


def B_KX(lat):
    return 111320.0 * math.cos(math.radians(lat))


def dist(a, b):
    return math.hypot((a[0] - b[0]) * 110540.0, (a[1] - b[1]) * B_KX(a[0]))


def adiff(a, b):
    return abs((a - b + 180) % 360 - 180)


def load(srcs):
    links = {}
    for src in srcs:
        for sec, files in B.sections(src).items():
            try:
                rows = B.layer(files, 'A2_LINK')
            except Exception as e:   # noqa: BLE001  (끝이 잘린 shp 가 있는 구간: SEC04_신갈JC_안성IC 의 B2 등)
                print('  건너뜀', sec, type(e).__name__)
                continue
            for g, r in rows:
                if len(g) < 2:
                    continue
                pts = [B.utm_to_ll(x, y) for x, y in g]
                lid = sec + '|' + r['ID']
                links[lid] = {'sec': sec, 'from': sec + '|' + str(r.get('FromNodeID')), 'to': sec + '|' + str(r.get('ToNodeID')),
                              'L': sec + '|' + str(r.get('L_LinkID')) if r.get('L_LinkID') else None,
                              'R': sec + '|' + str(r.get('R_LinkID')) if r.get('R_LinkID') else None,
                              'type': str(r.get('LinkType')), 'lane': r.get('LaneNo'), 'road': str(r.get('RoadNo') or ''),
                              'len': float(r.get('Length') or 0) or sum(dist(pts[i], pts[i + 1]) for i in range(len(pts) - 1)), 'pts': pts}
    return links


def graph(links):
    outs = collections.defaultdict(list)
    for k, l in links.items():
        outs[l['from']].append(k)
    nxt = {k: list(outs.get(l['to'], [])) for k, l in links.items()}
    # 구간 경계 잇기: 끝점 1.5m 안에서 시작하는 다른 구간 링크
    grid = collections.defaultdict(list)
    for k, l in links.items():
        p = l['pts'][0]
        grid[(round(p[0] * 5000), round(p[1] * 5000))].append(k)
    stitched = 0
    for k, l in links.items():
        if nxt[k]:
            continue
        p = l['pts'][-1]
        h = hd(l['pts'][-2], p)
        cy, cx = round(p[0] * 5000), round(p[1] * 5000)
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                for o in grid.get((cy + dy, cx + dx), []):
                    m = links[o]
                    if m['sec'] != l['sec'] and dist(p, m['pts'][0]) <= STITCH and adiff(h, hd(m['pts'][0], m['pts'][1])) < 30:
                        nxt[k].append(o)
                        stitched += 1
    print('links', len(links), 'stitched', stitched)
    return nxt


def ends(links, nxt, k, limit):
    """k 의 하류 끝(k 자신 포함)에서 limit m 까지: [(끝점, 간 거리, 자료 끝에서 멈춤)]"""
    out, stack, seen = [], [(k, 0.0)], set()
    while stack:
        cur, d = stack.pop()
        if (cur, round(d)) in seen or len(seen) > 4000:
            continue
        seen.add((cur, round(d)))
        l = links[cur]
        d2 = d + l['len']
        if d2 >= limit:
            # limit 지점의 점 (링크 안에서 비율로)
            t = max(0.0, min(1.0, (limit - d) / l['len'])) if l['len'] else 1.0
            i = min(len(l['pts']) - 2, int(t * (len(l['pts']) - 1)))
            out.append((l['pts'][i + 1], limit, False, l['road'], l['type']))
            continue
        if not nxt[cur]:
            out.append((l['pts'][-1], d2, True, l['road'], l['type']))
            continue
        for n in nxt[cur]:
            stack.append((n, d2))
    return out


REV_L, REV_R = {}, {}


def side_maps(links):
    for k, l in links.items():
        if l['R'] in links:
            REV_R[l['R']] = k      # k 의 오른쪽이 l['R'] → l['R'] 의 왼쪽은 k
        if l['L'] in links:
            REV_L[l['L']] = k


def left_of(links, k):
    l = links[k]
    return l['L'] if l['L'] in links else REV_R.get(k)


def right_of(links, k):
    l = links[k]
    return l['R'] if l['R'] in links else REV_L.get(k)


def row_of(links, k):
    cur, guard = k, 0
    while left_of(links, cur) and guard < 20:
        cur, guard = left_of(links, cur), guard + 1
    row, seen = [], set()
    while cur and cur in links and cur not in seen and len(row) < 16:
        seen.add(cur)
        row.append(cur)
        cur = right_of(links, cur)
    return row


def build(links, nxt):
    out, done = [], set()
    for k, l in links.items():
        if l['type'] not in ('4', '6', '5') or k in done:
            continue
        row = row_of(links, k)
        if len(row) < 2:
            continue
        for r in row:
            done.add(r)
        mid = links[row[len(row) // 2]]
        p, h = mid['pts'][-1], hd(mid['pts'][-2], mid['pts'][-1])
        per = [ends(links, nxt, r, DIST) for r in row]
        pts = [e for es in per for e in es]
        cl = []
        for e in pts:
            for c in cl:
                if dist(c['p'], e[0]) < CLUSTER:
                    c['n'] += 1
                    c['dead'] = c['dead'] and e[2]
                    c['far'] = max(c['far'], e[1])
                    c['roads'].add(e[3])
                    break
            else:
                cl.append({'p': e[0], 'n': 1, 'dead': e[2], 'far': e[1], 'roads': {e[3]}})
        real = [i for i, c in enumerate(cl) if not (c['dead'] and c['far'] < DIST / 2)]
        if len(real) < 2:
            continue
        # 본선: 진행 방향에 가장 가까운(옆으로 덜 벗어난) 갈래
        def off(c):
            a = hd(p, c['p'])
            return adiff(a, h)
        road0 = mid['road']
        same = [i for i in real if road0 and road0 in cl[i]['roads']]
        reach = {i: sum(1 for es in per if any(dist(cl[i]['p'], e[0]) < CLUSTER for e in es)) for i in real}
        main = max(same, key=lambda i: (reach[i], -off(cl[i]))) if same else min(real, key=lambda i: off(cl[i]))
        # 본선 줄(단면 → 본선 끝점)에서 옆으로 60m 안의 끝점은 갈래가 아니다 (자료가 중간에 끊겨 생긴 끝: 신갈 남행 37.284 의 37.273)
        mh = hd(p, cl[main]['p'])

        def lateral(c):
            d = dist(p, c['p'])
            return abs(math.sin(math.radians(hd(p, c['p']) - mh))) * d

        real = [i for i in real if i == main or lateral(cl[i]) >= 60]
        if len(real) < 2:
            continue
        lanes, lcl = [], []
        gots = []
        for r, es in zip(row, per):
            got = set()
            for e in es:
                j = next(i for i, c in enumerate(cl) if dist(c['p'], e[0]) < CLUSTER or c['p'] == e[0])
                if j in real:
                    got.add(j)
            gots.append(got)
        # 출구 쪽: 그 갈래로 가는 차로가 단면의 오른쪽 절반이면 R, 왼쪽이면 L (고리형·고가 연결로는 끝점이 반대쪽에 있기도 해서 끝점으로 정하지 않는다)
        sidek = {}
        for j in real:
            if j == main:
                continue
            idx = [n for n, g in enumerate(gots) if j in g]
            sidek[j] = 'R' if idx and sum(idx) / len(idx) >= (len(row) - 1) / 2 else 'L'
        for r, got in zip(row, gots):
            s = ''
            if main in got:
                s += 'S'
            for j in sorted(got - {main}):
                s += sidek[j]
            s = ''.join(ch for ch in 'LSR' if ch in s) or '?'
            if links[r]['type'] == '4':
                s += 'B'
            lanes.append(s)
            lcl.append(sorted(got))
        if all(x == lanes[0] for x in lanes):
            continue
        out.append({'p': p, 'h': round(h), 'lanes': lanes, 'cl': lcl, 'ends': [cl[i]['p'] for i in range(len(cl))], 'row': row})
    return out


def thin(entries):
    """같은 자리(25m 안·같은 방향)의 단면은 하나만: 고속국도 zip 에는 같은 구간이 두 판으로 들어 있기도 하다
    (경부선 SEC04_신갈JCT_안성IC 와 SEC04_신갈JC_안성IC, SEC01 과 SEC01-001). 판마다 버스전용차로를 따로 적거나(LinkType 4) 안 적어
    같은 자리에 버스 칸이 있는 줄과 없는 줄이 생긴다 → 차로가 많은 줄(버스 칸 포함)을 남긴다.
    그다음 SAMPLE m 안에서 차로 줄이 같으면 하나만"""
    keep = []
    for e in sorted(entries, key=lambda e: (-len(e['lanes']), -sum('B' in x for x in e['lanes']))):
        if any(dist(e['p'], k['p']) < 40 and adiff(e['h'], k['h']) < 20 for k in keep):
            continue
        keep.append(e)
    # 버스 칸이 없는 줄인데 300m 안 같은 방향 줄에 버스 칸이 있으면 다른 판(버스전용차로를 안 적은 판)의 줄이다 → 뺀다
    bus = [k for k in keep if any('B' in x for x in k['lanes'])]
    keep = [e for e in keep if any('B' in x for x in e['lanes']) or
            not any(dist(e['p'], k['p']) < 300 and adiff(e['h'], k['h']) < 20 for k in bus)]
    out = []
    for e in sorted(keep, key=lambda e: (e['p'][0], e['p'][1])):
        if any(dist(e['p'], k['p']) < SAMPLE and adiff(e['h'], k['h']) < 20 and e['lanes'] == k['lanes'] for k in out[-60:]):
            continue
        out.append(e)
    return out


def main(out, srcs):
    links = load(srcs)
    side_maps(links)
    nxt = graph(links)
    ent = thin(build(links, nxt))
    print('fork cross-sections', len(ent))
    # 끝점 표를 모은다
    pts, pidx = [], {}
    rows = []
    for e in ent:
        ids = []
        for q in e['ends']:
            key = (round(q[0], 5), round(q[1], 5))
            if key not in pidx:
                pidx[key] = len(pts)
                pts.append([round(q[0], 6), round(q[1], 6)])
            ids.append(pidx[key])
        rows.append([round(e['p'][0], 6), round(e['p'][1], 6), e['h'], '|'.join(e['lanes']), [[ids[j] for j in c] for c in e['cl']]])
    doc = {'v': 1, 'src': '국토지리정보원 정밀도로지도 (고속국도)', 'areas': [os.path.basename(s) for s in srcs], 'count': len(rows),
           'fields': ['lat', 'lng', 'heading', 'lanes', 'laneEnds'], 'ends': pts, 'rows': rows}
    with open(out, 'w', encoding='utf-8', newline='\n') as f:
        json.dump(doc, f, ensure_ascii=False, separators=(',', ':'))
    print('wrote', out, len(rows), 'rows', len(pts), 'ends', os.path.getsize(out), 'bytes')


if __name__ == '__main__':
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    main(sys.argv[1], sys.argv[2:])
