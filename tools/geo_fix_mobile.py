"""고속도로 부스·이동식 지점의 좌표를 설치장소 글에 적힌 주소와 맞춰 본다 (v165) → tools/mobile_coords_fix.json (build_mobile.py 가 적용).

    py -I -X utf8 tools/build_mobile.py <받은 파일 폴더> <아무 출력.json> --dump-points <points.json>
    py -I -X utf8 tools/geo_fix_mobile.py <points.json> tools/mobile_coords_fix.json [--cache <파일>]

고속도로 이정으로 시작하는 지점('서울양양고속도로 19.8K (경기도 양평군 서종면 문호리 586-5) (서울→양양)',
'무광선 21.2K(무안방면) / 나주시 문평면 송산리 산55-8') 중 글에 지번·도로명 주소가 있는 것만, 그 주소를 길안내 서버(네이버 지오코딩)로 찾아
지금 좌표에서 2km 넘게 멀면(100km 안) 주소 자리로 바꾼다. 그 자리는 고속도로 옆 필지라 osm_cams.py 가 200m 안 고속도로 본선에 붙인다.
(2026-11-20 서울·경기 가상 주행 점검: 경기북부 PDF 의 GGB-33 좌표가 광주시 진토길 — 글의 양평 서종면에서 25km)
결과 중 지금 좌표가 이미 그 고속도로 본선 위(osm_cams 결과)인 것은 손으로 뺀다: 주소(필지)가 대략일 수 있다
"""
import json
import math
import re
import sys
import time
import urllib.parse
import urllib.request

PTS, OUT = sys.argv[1], sys.argv[2]
CACHE = sys.argv[sys.argv.index('--cache') + 1] if '--cache' in sys.argv else None
WORKER = 'https://tesla-nav.cy6789.workers.dev/geocode'
HWY = re.compile(r'^\s*[가-힣A-Za-z0-9]+?(?:고속도로|고속국도|선)\s*(?:\([^)]*\))?\s*\d')
ADDR_PAREN = re.compile(r'\(([^()]*?[가-힣]+(?:시|군|구)\s[^()]*?(?:산\s*)?\d+(?:-\d+)?)\s*\)')
ADDR_SLASH = re.compile(r'/\s*([가-힣]+(?:시|군)\s.*?(?:산\s*)?\d+(?:-\d+)?)\s*$')


def dist(a, b):
    return math.hypot((a[0] - b[0]) * 110540, (a[1] - b[1]) * 111320 * math.cos(math.radians((a[0] + b[0]) / 2)))


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
                it = (json.load(f).get('items') or [None])[0]
            res = [it['lat'], it['lng']] if it else []
            break
        except Exception:
            time.sleep(1.5 * (attempt + 1))
    time.sleep(0.2)
    if res is not None:
        cache[q] = res
    return res


pts = json.load(open(PTS, encoding='utf-8'))
fix, st = {}, {'checked': 0, 'no address': 0, 'not found': 0, 'agrees': 0, 'too far to trust': 0, 'fixed': 0}
for p in pts:
    t = p['text']
    if not HWY.match(t):
        continue
    m = ADDR_PAREN.search(t) or ADDR_SLASH.search(t)
    if not m:
        st['no address'] += 1
        continue
    addr = re.sub(r'\s+', ' ', m.group(1)).strip()
    st['checked'] += 1
    g = geocode(addr)
    if not g:
        st['not found'] += 1
        continue
    d_ = dist((p['lat'], p['lng']), g)
    if d_ <= 2000:
        st['agrees'] += 1
    elif d_ > 100000:
        st['too far to trust'] += 1
    else:
        fix[p['src'] + '|' + p['id']] = {'lat': round(g[0], 6), 'lng': round(g[1], 6), 'moved_m': int(d_), 'addr': addr, 'text': t[:80]}
        st['fixed'] += 1
if CACHE:
    json.dump(cache, open(CACHE, 'w', encoding='utf-8'), ensure_ascii=False)
with open(OUT, 'w', encoding='utf-8') as f:
    json.dump({'source': '설치장소 글의 주소를 네이버 지오코딩으로 찾은 자리 (tools/geo_fix_mobile.py)', 'fix': fix}, f, ensure_ascii=False, indent=0)
print(st)
for k, v in fix.items():
    print(' ', k, v['moved_m'], 'm', v['addr'])
