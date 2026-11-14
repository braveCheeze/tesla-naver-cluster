"""OpenStreetMap 터널 도로 -> data/tunnels.json

네이버 길찾기 안내에는 터널이 없어서 (지하차도는 있음) 앱이 길안내 경로가 지나는 터널을 직접 찾는다.
입력은 Overpass API 결과(JSON, `out geom`) 하나:

  [out:json][timeout:300];
  area["ISO3166-1"="KR"][admin_level=2]->.kr;
  way(area.kr)[highway~"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|road|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link)$"][tunnel=yes];
  out tags geom qt;

사용: py -I tools/build_tunnels.py <overpass.json> data/tunnels.json

출력: {"v":1,"src":"© OpenStreetMap contributors (ODbL)","date","count","scale":1e5,"names":[...],
       "w":[[이름번호(-1 없음), 일방(0/1), lat0, lng0, dLat1, dLng1, ...], ...]}  (정수, 1e5 배)
- 지하차도·지하도는 뺀다 (네이버가 따로 안내한다)
- 이름은 tunnel:name, 없으면 '터널'이 들어간 name. 도로 이름(경강로 등)은 터널 이름으로 쓰지 않는다
- 일방: oneway=yes/1/true, 고속도로·연결로, 회전교차로. oneway=-1 은 뒤집어서 일방
- 모양은 2m 안쪽으로 단순화 (Ramer-Douglas-Peucker)
"""
import io
import json
import math
import re
import sys

SCALE = 1e5
UNDERPASS = re.compile(r'지하차도|지하도|지하보도|굴다리|underpass', re.I)


def plane(pts):
    lat0 = pts[0][0]
    kx = math.cos(math.radians(lat0)) * 111320.0
    return [((p[1] - pts[0][1]) * kx, (p[0] - pts[0][0]) * 110540.0) for p in pts]


def rdp(pts, tol=2.0):
    if len(pts) < 3:
        return pts
    xy = plane(pts)
    keep = [False] * len(pts)
    keep[0] = keep[-1] = True
    stack = [(0, len(pts) - 1)]
    while stack:
        a, b = stack.pop()
        ax, ay = xy[a]
        bx, by = xy[b]
        dx, dy = bx - ax, by - ay
        l2 = dx * dx + dy * dy
        best, bi = -1.0, -1
        for i in range(a + 1, b):
            px, py = xy[i]
            if l2 > 0:
                t = max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / l2))
                qx, qy = ax + t * dx, ay + t * dy
            else:
                qx, qy = ax, ay
            d = math.hypot(px - qx, py - qy)
            if d > best:
                best, bi = d, i
        if best > tol:
            keep[bi] = True
            stack.append((a, bi))
            stack.append((bi, b))
    return [p for p, k in zip(pts, keep) if k]


def length_m(pts):
    xy = plane(pts)
    return sum(math.hypot(xy[i + 1][0] - xy[i][0], xy[i + 1][1] - xy[i][1]) for i in range(len(xy) - 1))


def main(src, dst):
    j = json.load(io.open(src, encoding='utf-8'))
    date = (j.get('osm3s') or {}).get('timestamp_osm_base', '')[:10]
    names, name_idx, rows = [], {}, []
    skipped = {'underpass': 0, 'short': 0}
    total_len = 0.0
    for el in j.get('elements', []):
        if el.get('type') != 'way' or not el.get('geometry'):
            continue
        tg = el.get('tags', {})
        if tg.get('tunnel') != 'yes':
            continue
        raw_name = tg.get('name', '') or ''
        tname = tg.get('tunnel:name') or tg.get('tunnel:name:ko') or (raw_name if '터널' in raw_name else '')
        if UNDERPASS.search(tname) or UNDERPASS.search(raw_name):
            skipped['underpass'] += 1
            continue
        pts = [(g['lat'], g['lon']) for g in el['geometry'] if g]
        if len(pts) < 2:
            continue
        ow = str(tg.get('oneway', '')).lower()
        oneway = ow in ('yes', '1', 'true') or tg.get('highway') in ('motorway', 'motorway_link') or tg.get('junction') == 'roundabout'
        if ow == '-1':
            pts.reverse()
            oneway = True
        if ow == 'no':
            oneway = False
        L = length_m(pts)
        if L < 15:
            skipped['short'] += 1
            continue
        total_len += L
        pts = rdp(pts)
        ni = -1
        if tname:
            if tname not in name_idx:
                name_idx[tname] = len(names)
                names.append(tname)
            ni = name_idx[tname]
        ints = [(round(p[0] * SCALE), round(p[1] * SCALE)) for p in pts]
        row = [ni, 1 if oneway else 0, ints[0][0], ints[0][1]]
        for k in range(1, len(ints)):
            row += [ints[k][0] - ints[k - 1][0], ints[k][1] - ints[k - 1][1]]
        rows.append(row)
    out = {'v': 1, 'src': '© OpenStreetMap contributors (ODbL)', 'date': date, 'count': len(rows),
           'scale': SCALE, 'names': names, 'w': rows}
    with io.open(dst, 'w', encoding='utf-8', newline='\n') as f:
        json.dump(out, f, ensure_ascii=False, separators=(',', ':'))
    print('ways', len(rows), 'names', len(names), 'km', round(total_len / 1000), 'skipped', skipped, 'date', date)


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
