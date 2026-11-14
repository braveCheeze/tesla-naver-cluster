"""이름 없는 고속도로 터널(OSM)에 한국도로공사 공식 터널 이름을 붙인다 -> tools/kec_tunnel_names.json

OpenStreetMap 의 고속도로 터널 중 약 480개(80m 넘는 것)는 이름이 없다(광지원터널·금사1~5터널·중부1~3터널 등).
한국도로공사 '터널 상세'(고속도로 공공데이터 포털 data.ex.co.kr, 파일 ETC X3: 노선·터널명(방향)·시점/종점 위치(주소)·연장)에는
좌표가 없어서, 거꾸로 OSM 터널 가운데 점을 역지오코딩(우리 Worker /reverse = 네이버)해 읍·면·동을 얻고
  ① 노선이 같고(OSM 도로 이름 'OO고속도로' ↔ 도로공사 'OO선', 괄호 안 다른 이름 포함)
  ② 그 읍·면·동이 도로공사 시점 또는 종점 주소에 들어 있고
  ③ 길이 차이가 30% 안인
도로공사 터널 가운데 길이가 가장 가까운 것의 이름을 쓴다(방향 괄호는 뗀다). 두 이름이 비슷하게 맞으면(5% 안) 붙이지 않는다.
사용법: py -I tools/kec_tunnel_names.py <overpass.json> <ETC_X3_….csv> tools/kec_tunnel_names.json
        (그다음 py -I tools/build_tunnels.py <overpass.json> data/tunnels.json tools/kec_tunnel_names.json)
역지오코딩 결과는 출력 파일의 cache 에 남겨 다시 돌릴 때 재사용한다.
"""
import csv
import io
import json
import math
import os
import re
import sys
import time
import urllib.parse
import urllib.request

WORKER = 'https://tesla-nav.cy6789.workers.dev/reverse'
HEAD = {'Origin': 'https://bravecheeze.github.io', 'User-Agent': 'tesla-nav-tools/1.0'}


def length_m(g):
    return sum(math.hypot((b['lat'] - a['lat']) * 110540, (b['lon'] - a['lon']) * 111320 * math.cos(math.radians(a['lat'])))
               for a, b in zip(g, g[1:]))


def route_keys(s):
    out = set()
    for part in re.split(r'[()]', s or ''):
        part = re.sub(r'\s+', '', part)
        part = re.sub(r'(고속도로|고속국도|선)$', '', part)
        if len(part) >= 2:
            out.add(part)
    return out


def reverse(lat, lng):
    q = urllib.parse.urlencode({'coords': '%.6f,%.6f' % (lng, lat)})
    for attempt in range(3):
        try:
            req = urllib.request.Request(WORKER + '?' + q, headers=HEAD)
            with urllib.request.urlopen(req, timeout=30) as r:
                return json.loads(r.read().decode('utf-8')).get('area', '') or ''
        except OSError:
            time.sleep(2 + attempt * 3)
    return ''


def main(src, kec_csv, out):
    osm = json.load(io.open(src, encoding='utf-8'))
    raw = open(kec_csv, 'rb').read()
    text = next(raw.decode(e) for e in ('utf-8-sig', 'cp949') if _ok(raw, e))
    rows = list(csv.reader(io.StringIO(text)))
    head = rows[0]
    col = {n: i for i, n in enumerate(head)}
    kec = []
    for r in rows[1:]:
        if len(r) != len(head):
            continue   # 칸 안 줄바꿈으로 깨진 줄
        try:
            L = float(r[col['연장']])
        except ValueError:
            continue
        name = re.sub(r'\s+', '', re.sub(r'\(.*?\)', '', r[col['터널명']]))
        if not name or '지하차도' in name or L <= 0:
            continue
        kec.append({'name': name, 'routes': route_keys(r[col['노선']]), 'len': L,
                    'areas': [r[col['시점위치']].split(), r[col['종점위치']].split()]})
    prev = json.load(io.open(out, encoding='utf-8')) if os.path.exists(out) else {}
    cache = prev.get('cache', {})
    names, stats = {}, {'unnamed motorway tunnels': 0, 'named': 0, 'no area': 0, 'no match': 0, 'ambiguous': 0}
    for el in osm.get('elements', []):
        tg = el.get('tags', {})
        if el.get('type') != 'way' or tg.get('tunnel') != 'yes' or tg.get('highway') != 'motorway':
            continue
        if tg.get('tunnel:name') or '터널' in (tg.get('name') or ''):
            continue
        g = [p for p in el.get('geometry') or [] if p]
        if len(g) < 2:
            continue
        L = length_m(g)
        if L < 80:
            continue
        stats['unnamed motorway tunnels'] += 1
        mid = g[len(g) // 2]
        key = '%.5f,%.5f' % (mid['lat'], mid['lon'])
        if key not in cache:
            cache[key] = reverse(mid['lat'], mid['lon'])
            time.sleep(0.15)
        area = cache[key].split()
        if not area:
            stats['no area'] += 1
            continue
        rk = route_keys(tg.get('name', ''))
        cands = []
        for k in kec:
            if rk and not any(a == b or a.startswith(b) or b.startswith(a) for a in rk for b in k['routes']):
                continue
            if not any(all(t in ad for t in area) for ad in k['areas']):
                continue
            d = abs(k['len'] - L) / k['len']
            if d <= (0.3 if rk else 0.15):
                cands.append((d, k['name']))
        if not cands:
            stats['no match'] += 1
            continue
        cands.sort()
        if len(cands) > 1 and cands[1][1] != cands[0][1] and cands[1][0] - cands[0][0] < 0.05:
            stats['ambiguous'] += 1
            continue
        names[str(el['id'])] = cands[0][1]
        stats['named'] += 1
    with io.open(out, 'w', encoding='utf-8', newline='\n') as f:
        json.dump({'src': '한국도로공사 터널 상세(data.ex.co.kr ETC X3) + OSM 위치·역지오코딩', 'stats': stats,
                   'names': names, 'cache': cache}, f, ensure_ascii=False, indent=0)
    print(stats)
    print('examples', sorted(set(names.values()))[:40])


def _ok(raw, enc):
    try:
        raw.decode(enc)
        return True
    except UnicodeDecodeError:
        return False


if __name__ == '__main__':
    if len(sys.argv) != 4:
        sys.exit(__doc__)
    main(sys.argv[1], sys.argv[2], sys.argv[3])
