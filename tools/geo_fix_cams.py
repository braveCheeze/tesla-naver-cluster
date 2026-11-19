"""경찰청 카메라 원본의 엉뚱한 좌표를 주소로 다시 찾는다 (v164) → tools/cam_coords_fix.json (build_cams.py 가 적용).

    py -I -X utf8 tools/geo_fix_cams.py <원본.csv> data/cameras.json tools/cam_coords_fix.json [--only-sido 서울특별시,경기도]

의심 가는 기록만 찾는다 (2026-11-19 점검):
  1. 같은 좌표를 서로 다른 도로의 카메라가 같이 쓰는 곳 (79곳 177대. 예: 세종포천고속도로 120 K0678~K0681 네 대가
     긴밭뜰삼거리 50 J8015 자리에, 합천 J0005 80 이 J0040/J0041 30 자리에)
  2. 좌표가 그 시군구 카메라들의 가운데에서 25km 넘게 먼 것, 우리나라 밖 좌표 (수원 권선초교 J6049·강남 개포동역 K0377 이 바다에,
     포항 K0215 위도 39.985 = 35.985 오타라 빌드에서 빠짐)
  3. data/cameras.json 에서 45m 안에 차도가 없는 카메라 (osm_cams.py 의 dirs 가 -1)
각 기록의 도로명 주소(없으면 지번 주소)를 길안내 서버(앱과 같은 Worker)의 주소 검색(네이버 지오코딩)으로 찾아서
  - 1·2: 주소 자리가 지금 좌표에서 300m 넘게 멀고, 그 시군구 가운데 25km 안이면 주소 자리로 바꾼다
    (1 은 같은 좌표 무리 중 주소 자리가 그 좌표 150m 안인 기록은 맞는 것으로 보고 그대로 둔다)
  - 3: 옮기지 않는다 (주소 자리도 길에서 먼 경우가 많다). 목록만 세어 둔다
바뀐 좌표는 그 도로 위가 아니라 주소(건물·필지) 자리라 osm_cams.py 가 가까운 같은 이름 길(85m 안)에 붙인다.
주소 검색은 기록마다 한 번, 0.2초 간격. --cache <파일> 을 주면 결과를 남겨 다시 돌릴 때 재사용한다 (저장소 밖에 둔다).
"""
import csv
import io
import json
import math
import os
import sys
import time
import urllib.parse
import urllib.request
from collections import defaultdict

SRC, CAMS, OUT = sys.argv[1], sys.argv[2], sys.argv[3]
ONLY = set(sys.argv[sys.argv.index('--only-sido') + 1].split(',')) if '--only-sido' in sys.argv else None
WORKER = 'https://tesla-nav.cy6789.workers.dev/geocode'
CACHE = sys.argv[sys.argv.index('--cache') + 1] if '--cache' in sys.argv else None
KY = 110540.0


def dist(a, b):
    return math.hypot((a[0] - b[0]) * KY, (a[1] - b[1]) * 111320.0 * math.cos(math.radians((a[0] + b[0]) / 2)))


rows = list(csv.reader(io.StringIO(open(SRC, 'rb').read().decode('cp949'))))[1:]
# build_cams.py 와 같이: 같은 관리번호의 예전 기록(데이터기준일자가 더 이른 것)은 뺀다
_by_id = {}
for r in rows:
    _by_id.setdefault((r[1].strip(), r[2].strip(), r[0].strip()), []).append(r)
_stale = set()
for v in _by_id.values():
    if 2 <= len(v) <= 4:
        newest = max(x[20] for x in v)
        _stale.update(id(x) for x in v if x[20] < newest)
rows = [r for r in rows if id(r) not in _stale]
recs = []
for r in rows:
    try:
        lat, lng = float(r[9]), float(r[10])
    except ValueError:
        lat = lng = None
    recs.append({'id': '%s|%s|%s' % (r[1].strip(), r[2].strip(), r[0].strip()), 'sido': r[1].strip(), 'sgg': r[2].strip(), 'road': r[5].strip(), 'place': r[11].strip(),
                 'addr': (r[7] or '').strip() or (r[8] or '').strip(), 'roadaddr': bool((r[7] or '').strip()),
                 'lat': lat, 'lng': lng, 'code': r[12].strip()})


def ok_kr(p):
    return p[0] is not None and 33 < p[0] < 39 and 124 < p[1] < 132


# 시군구 가운데 (중앙값)
by_sgg = defaultdict(list)
for x in recs:
    if ok_kr((x['lat'], x['lng'])):
        by_sgg[(x['sido'], x['sgg'])].append((x['lat'], x['lng']))
centre = {}
for k, v in by_sgg.items():
    la = sorted(p[0] for p in v)
    lo = sorted(p[1] for p in v)
    centre[k] = (la[len(la) // 2], lo[len(lo) // 2])

sus = {}   # id -> 이유
# 1. 같은 좌표, 다른 도로
grp = defaultdict(list)
for x in recs:
    if ok_kr((x['lat'], x['lng'])):
        grp[(round(x['lat'], 5), round(x['lng'], 5))].append(x)
shared = {}
for k, g in grp.items():
    roads_ = {''.join(x['road'].split()) for x in g if x['road']}
    if len(roads_) >= 2:
        for x in g:
            sus[x['id']] = 'shared'
            shared[x['id']] = k
# 2. 시군구에서 먼 좌표·우리나라 밖
for x in recs:
    c = centre.get((x['sido'], x['sgg']))
    p = (x['lat'], x['lng'])
    if not ok_kr(p):
        sus[x['id']] = 'outside'
    elif c and dist(p, c) > 25000:
        sus[x['id']] = 'far'
# 3. 차도가 45m 안에 없는 카메라 (빌드된 cameras.json 의 좌표로 원본 기록을 찾는다)
cam = json.load(open(CAMS, encoding='utf-8'))
noroad = {(r_[0], r_[1]) for r_, d_ in zip(cam['rows'], cam.get('dirs') or []) if d_[0] < 0}
for x in recs:
    if ok_kr((x['lat'], x['lng'])) and (round(x['lat'], 5), round(x['lng'], 5)) in noroad and x['id'] not in sus:
        sus[x['id']] = 'noroad'
if ONLY:
    sus = {k: v for k, v in sus.items() if next((x for x in recs if x['id'] == k), {}).get('sido') in ONLY}
print('suspicious records', len(sus), {w: sum(1 for v in sus.values() if v == w) for w in ('shared', 'far', 'outside', 'noroad')})

try:
    cache = json.load(open(CACHE, encoding='utf-8')) if CACHE else {}
except (OSError, ValueError):
    cache = {}


def geocode(q):
    if q in cache:
        return cache[q]
    req = urllib.request.Request(WORKER + '?' + urllib.parse.urlencode({'query': q}),
                                 headers={'Origin': 'https://bravecheeze.github.io', 'User-Agent': 'tesla-nav-tools'})
    res = None
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=10) as f:
                j = json.load(f)
            it = (j.get('items') or [None])[0]
            res = [it['lat'], it['lng'], it.get('name') or ''] if it else []
            break
        except Exception:
            time.sleep(1.5 * (attempt + 1))
    time.sleep(0.2)
    if res is not None:
        cache[q] = res
    return res


fix = {}
stats = defaultdict(int)
byid = {x['id']: x for x in recs}
for i, (rid, why) in enumerate(sorted(sus.items())):
    x = byid[rid]
    if not x['addr']:
        stats['no address'] += 1
        continue
    g = geocode(x['addr'])
    if not g:
        stats['address not found'] += 1
        continue
    gp = (g[0], g[1])
    c = centre.get((x['sido'], x['sgg']))
    if c and dist(gp, c) > 25000:
        stats['address result outside its district'] += 1
        continue
    p = (x['lat'], x['lng'])
    d_ = dist(gp, p) if ok_kr(p) else 1e9
    if why == 'shared':
        if d_ <= 150:
            stats['shared: this one is right'] += 1
            continue
        if d_ <= 300:
            stats['shared: close, kept'] += 1
            continue
    elif why in ('far', 'outside'):
        if d_ <= 300:
            stats['far: address agrees, kept'] += 1
            continue
    else:
        # 차도가 없는 카메라는 옮기지 않는다: 주소 자리(건물·필지)도 길에서 먼 경우가 많아 옮겨도 차도가 없었다
        # (이천 아미타운삼거리 ICHEON140 → 경충대로 2091 이 320m 옆인데 거기도 45m 안에 차도 없음). 풍덕천동 747 처럼 여러 카메라가 한 필지로 몰리기도 한다
        stats['noroad: kept (not moved)'] += 1
        continue
    fix[rid] = {'lat': round(gp[0], 6), 'lng': round(gp[1], 6), 'why': why, 'moved_m': None if d_ >= 1e9 else int(d_), 'addr': x['addr']}
    stats['fixed: ' + why] += 1
    if CACHE and i % 50 == 0:
        json.dump(cache, open(CACHE, 'w', encoding='utf-8'), ensure_ascii=False)
if CACHE:
    json.dump(cache, open(CACHE, 'w', encoding='utf-8'), ensure_ascii=False)
# 차도 없는 카메라 고침 중 여러 카메라가 같은 주소 자리로 가는 것은 뺀다 (주소가 그 카메라 자리가 아니라 큰 필지)
_at = {}
for k, v in fix.items():
    _at.setdefault((v['lat'], v['lng']), []).append(k)
for k in [k for ks in _at.values() if len(ks) > 1 for k in ks if fix[k]['why'] == 'noroad']:
    del fix[k]
    stats['noroad: dropped (several cameras to one address)'] += 1
with open(OUT, 'w', encoding='utf-8') as f:
    json.dump({'source': '경찰청 표준데이터 주소(도로명, 없으면 지번)를 네이버 지오코딩으로 찾은 자리 (tools/geo_fix_cams.py)', 'fix': fix},
              f, ensure_ascii=False, indent=0)
print(dict(stats))
print('fixed', len(fix))
