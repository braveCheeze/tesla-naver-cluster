"""주소만 있는 이동식 단속 지점 목록(강원·전남 경찰청) → 좌표를 붙인 지점 목록 (<SRC>/<지역>/points.json, build_mobile.py 가 읽는다).

2026-11-16 사용자 '이동식 단속 지점 추가 찾아보셈'. 원본에는 좌표가 없고 '춘천시 서면 당림리 310-6(서울→춘천)' 같은 주소 + 방향뿐이다.

    py -I -X utf8 tools/geo_mobile_addr.py <SRC 폴더> gw|jn [D:/osm/south-korea-latest.osm.pbf]
      gw: <SRC>/gw/gw.xls (강원경찰청 '이동식 단속 지점 현황', 시트 하나: 연번·관할서·단속지점 및 단속방향)
          + <SRC>/gw/gw_school.xls 의 '이동식' 시트(스쿨존 이동식, 있으면)
      jn: <SRC>/jn/jn.xls (전남경찰청 '이동식장비,암행단속 현황': S·경찰서·설치장소)
      dg: <SRC>/dg/*.xlsx·*.pdf (대구 경찰서별 '이동식 단속 사전 예고장소': 중부·동부·남부·성서·달서 엑셀, 달성 PDF. 제한속도 있음)
          (서부 한글 파일·북부·수성·강북 그림 파일은 아직 안 넣음)
      usa: <SRC>/usa/ulju.xlsx(울주서 85곳, 제한속도·부스)·nambu.xlsx 의 Sheet1(남부서 20곳) — 좌표 없는 울산 목록
      cb: <SRC>/cb/cb.csv (data.go.kr 15141314 충북경찰청 이동식 단속 카메라 설치장소: 경찰서·설치장소·도로구분·부스 유무·경도·위도).
          좌표가 있지만 오타가 섞여 있어(위도 37.70 인 오창읍 등) 주소가 있는 줄은 주소 검색 결과와 1km 넘게 다르면 뺀다.
          고속도로 이정 줄('경부선 312.5(상행)-청주 흥덕 옥산 수락리')은 충북 둘레 안이면 원본 좌표 그대로

위치 (확실한 것만, 나머지는 skipped 에 남긴다):
  - 괄호 앞 글(주소)을 지역 이름을 붙여 네이버 주소 검색(앱 Worker /geocode). 그 지역 안의 결과만
  - 가까운 차도(OSM) 80m 안에 붙인다(지번은 땅 가운데라 길에서 수십 m 떨어져 있다). 글에 도로 이름이 있으면 그 길 120m 안
  - 고속도로 이정('호남선 103km', '동해고속도로 32.9km')·'삭제' 줄·주소 없는 표지물만 있는 줄은 넣지 않는다
방향: '(A→B)' 글은 그대로 두고(build_mobile 이 arrows 로), 찍는 방향은 다른 출처처럼 osm_cams·osm_arrows 가 정한다 (지점은 길 가운데).
Worker 는 앱이 쓰는 것을, 로컬 개발용으로 허용된 Origin(http://localhost:8765)으로 부른다. 검색 결과는 <SRC>/<지역>/geo_cache.json.
"""
import json
import math
import os
import re
import sys
import time
import urllib.parse
import urllib.request

sys.path.insert(0, r'D:\pylib')

SRC, AREA = sys.argv[1], sys.argv[2]
PBF = sys.argv[3] if len(sys.argv) > 3 else r'D:\osm\south-korea-latest.osm.pbf'
DIR = os.path.join(SRC, AREA)
WORKER = 'https://tesla-nav.cy6789.workers.dev'
ORIGIN = 'http://localhost:8765'
CONF = {
    'gw': {'box': (36.95, 127.0, 38.65, 129.45), 'prefix': '강원특별자치도', 'names': ('강원',)},
    'jn': {'box': (33.9, 125.0, 35.55, 127.95), 'prefix': '전라남도', 'names': ('전남', '전라남도')},
    'cb': {'box': (35.95, 127.25, 37.30, 128.70), 'prefix': '충청북도', 'names': ('충북', '충청북도')},
    'dg': {'box': (35.55, 128.30, 36.05, 128.80), 'prefix': '대구광역시', 'names': ('대구',)},
    'usa': {'box': (35.30, 128.95, 35.75, 129.50), 'prefix': '울산광역시', 'names': ('울산',)},
}[AREA]
BOX = CONF['box']
ROADS = {'motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'living_street',
         'motorway_link', 'trunk_link', 'primary_link', 'secondary_link', 'tertiary_link', 'road'}
KY = 110540.0


def kx(lat):
    return 111320.0 * math.cos(math.radians(lat))


def norm(s):
    return re.sub(r'\s+', '', s or '')


# ------------------------------------------------------------------ 원본
def cellv(c):
    v = c.value
    return str(int(v)) if isinstance(v, float) and v.is_integer() else str(v)


def entries():
    import xlrd
    out = []
    if AREA == 'gw':
        sh = xlrd.open_workbook(os.path.join(DIR, 'gw.xls')).sheets()[0]
        for i in range(4, sh.nrows):
            r = [cellv(c) for c in sh.row(i)]
            if len(r) >= 3 and r[2].strip():
                out.append({'id': 'GW-' + r[0].strip(), 'station': r[1].strip(), 'text': r[2].strip()})
        p = os.path.join(DIR, 'gw_school.xls')
        if os.path.exists(p):
            b = xlrd.open_workbook(p)
            sh = next((s for s in b.sheets() if s.name.strip() == '이동식'), None)
            st = ''
            for i in range(2, sh.nrows if sh else 0):
                r = [cellv(c) for c in sh.row(i)]
                if len(r) >= 3 and r[2].strip():
                    st = r[1].strip() or st
                    out.append({'id': 'GWS-' + r[0].strip(), 'station': st, 'text': r[2].strip(), 'school': True})
    elif AREA == 'dg':
        import glob
        import openpyxl
        from pypdf import PdfReader
        for f in sorted(glob.glob(os.path.join(DIR, '*.xlsx'))):
            rows = list(openpyxl.load_workbook(f, read_only=True, data_only=True).worksheets[0].iter_rows(values_only=True))
            tag = os.path.basename(f).split('_')[0]
            for k, r in enumerate(rows):
                r = ['' if c is None else (str(int(c)) if isinstance(c, float) and c.is_integer() else str(c)) for c in r]
                if len(r) < 3 or not r[0].strip().isdigit():
                    continue
                if len(r) >= 5 and r[2].strip():          # 연번·관할서·단속지점·도로구분·제한속도
                    lim = re.match(r'\d+', r[4].strip())
                    out.append({'id': 'DG-%s-%s' % (tag, r[0].strip()), 'station': r[1], 'text': r[2].strip(),
                                'limit': int(lim.group()) if lim else 0, 'school': '스쿨' in r[3] or '실버' in r[3]})
                elif r[2].strip():                         # 달서: 연번·경찰서·장소
                    out.append({'id': 'DG-%s-%s' % (tag, r[0].strip()), 'station': r[1], 'text': r[2].strip(), 'limit': 0})
        for f in sorted(glob.glob(os.path.join(DIR, '*.pdf'))):
            for pg in PdfReader(f).pages:
                for ln in (pg.extract_text() or '').splitlines():
                    m = re.match(r'^(\d+)\s+대구\s+\S+경찰서\s+(대구-\S+-\d+)\s+(.*)\s+(\d{2,3})\s*$', ln.strip())
                    if not m:
                        continue
                    body = re.sub(r'\s+(기타 사고다발 지점|기타|\S*존\S*|과속위험\S*|사고예방\S*)\s*$', '', m.group(3))
                    out.append({'id': m.group(2), 'station': '대구달성경찰서', 'text': body.strip(), 'limit': int(m.group(4)),
                                'school': '스쿨' in m.group(3)})
    elif AREA == 'usa':
        import openpyxl
        rows = list(openpyxl.load_workbook(os.path.join(DIR, 'ulju.xlsx'), read_only=True, data_only=True).worksheets[0].iter_rows(values_only=True))
        for r in rows[4:]:
            r = ['' if c is None else (str(int(c)) if isinstance(c, float) and c.is_integer() else str(c)) for c in r]
            if len(r) >= 2 and r[0].strip().isdigit() and r[1].strip():
                lim = re.match(r'\d+', (r[2] if len(r) > 2 else '').strip())
                out.append({'id': 'US-울주-' + r[0].strip(), 'station': '울주경찰서', 'text': '울산 ' + r[1].strip(), 'limit': int(lim.group()) if lim else 0,
                            'booth': (r[3] if len(r) > 3 else '').strip() in ('○', 'O', 'o')})
        wb = openpyxl.load_workbook(os.path.join(DIR, 'nambu.xlsx'), read_only=True, data_only=True)
        ws = next((w for w in wb.worksheets if w.title.strip() == 'Sheet1'), None)
        for r in (list(ws.iter_rows(values_only=True))[1:] if ws else []):
            r = ['' if c is None else str(c) for c in r]
            if len(r) >= 2 and r[0].startswith('울산-') and r[1].strip():
                out.append({'id': r[0].strip() + '-s1', 'station': '울산남부경찰서', 'text': '울산 남구 ' + r[1].strip(), 'limit': 0,
                            'booth': (r[3] if len(r) > 3 else '').strip() in ('○', 'O'), 'school': '스쿨' in (r[2] if len(r) > 2 else '')})
    elif AREA == 'cb':
        import csv
        import io as _io
        rows = list(csv.reader(_io.StringIO(open(os.path.join(DIR, 'cb.csv'), 'rb').read().decode('cp949'))))[1:]
        for i, r in enumerate(rows):
            if len(r) >= 6 and r[1].strip():
                out.append({'id': 'CB-%d' % (i + 1), 'station': r[0].strip(), 'text': r[1].strip(), 'kind': r[2].strip(),
                            'booth': r[3].strip() == '부스', 'lng': r[4].strip(), 'lat': r[5].strip(), 'school': r[2].strip() == '스쿨존'})
    else:
        sh = xlrd.open_workbook(os.path.join(DIR, 'jn.xls')).sheets()[0]
        for i in range(2, sh.nrows):
            r = [cellv(c) for c in sh.row(i)]
            if len(r) >= 3 and r[2].strip():
                out.append({'id': 'JN-' + r[0].strip(), 'station': r[1].strip(), 'text': r[2].strip()})
    return out


# ------------------------------------------------------------------ OSM 길
def load_roads():
    cache = os.path.join(DIR, 'osm_roads.json')
    if os.path.exists(cache):
        return json.load(open(cache, encoding='utf-8'))
    import osmium

    class H(osmium.SimpleHandler):
        def __init__(self):
            super().__init__()
            self.ways = []

        def way(self, w):
            hw = w.tags.get('highway')
            if hw not in ROADS:
                return
            try:
                pts = [(round(n.lat, 6), round(n.lon, 6)) for n in w.nodes]
            except Exception:
                return
            if not any(BOX[0] <= a <= BOX[2] and BOX[1] <= b <= BOX[3] for a, b in pts):
                return
            self.ways.append({'name': w.tags.get('name') or '', 'ref': w.tags.get('ref') or '', 'hw': hw, 'pts': pts})

    h = H()
    h.apply_file(PBF, locations=True)
    json.dump(h.ways, open(cache, 'w', encoding='utf-8'), ensure_ascii=False)
    return h.ways


ROADW = load_roads()
GRID = {}
for wi, w in enumerate(ROADW):
    for a, b in w['pts']:
        GRID.setdefault((int(a * 200), int(b * 200)), set()).add(wi)


def near_ways(lat, lng, radius):
    span = int(radius / 400) + 1
    cand = set()
    gy, gx = int(lat * 200), int(lng * 200)
    for dy in range(-span, span + 1):
        for dx in range(-span, span + 1):
            cand |= GRID.get((gy + dy, gx + dx), set())
    k = kx(lat)
    out = []
    for wi in cand:
        pts = ROADW[wi]['pts']
        best = None
        for i in range(len(pts) - 1):
            ax, ay = (pts[i][1] - lng) * k, (pts[i][0] - lat) * KY
            bx, by = (pts[i + 1][1] - lng) * k, (pts[i + 1][0] - lat) * KY
            dx, dy = bx - ax, by - ay
            L = dx * dx + dy * dy
            t = 0 if L == 0 else max(0, min(1, -(ax * dx + ay * dy) / L))
            px, py = ax + t * dx, ay + t * dy
            d = math.hypot(px, py)
            if best is None or d < best[0]:
                best = (d, wi, px, py)
        if best and best[0] <= radius:
            out.append(best)
    return sorted(out)


# ------------------------------------------------------------------ 검색
CACHE_F = os.path.join(DIR, 'geo_cache.json')
CACHE = json.load(open(CACHE_F, encoding='utf-8')) if os.path.exists(CACHE_F) else {}


def geocode(q):
    key = '/geocode|' + q
    if key in CACHE:
        return CACHE[key]
    url = WORKER + '/geocode?query=' + urllib.parse.quote(q)
    req = urllib.request.Request(url, headers={'Origin': ORIGIN, 'User-Agent': 'tesla-nav-build/1.0'})
    items = None
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=20) as r:
                items = json.loads(r.read().decode('utf-8')).get('items') or []
            break
        except Exception as e:   # noqa: BLE001
            time.sleep(2 + attempt * 3)
            err = e
    if items is None:
        print('  검색 실패', q, type(err).__name__)
        return []
    CACHE[key] = items
    time.sleep(0.1)
    return items


HWY = re.compile(r'(고속도로|고속국도|[가-힣]{1,4}선\s*\d+(\.\d+)?\s*k|\d+(\.\d+)?\s*km|\d+(\.\d+)?k\b|톨게이트|IC\s*(진입|진출))')
ROADNAME = re.compile(r'([가-힣0-9]{1,12}?(?:대로|로|길))\s?\d')
ROAD_NUM = re.compile(r'[가-힣0-9]{1,12}?(?:대로|로|길)\s?\d{1,4}(?:-\d{1,4})?(?![\d.]*\s*[kK]?[mM])')
JIBUN_ANY = re.compile(r'([가-힣0-9]{1,6}(?:동|리|가))\s*((?:산\s?)?\d{1,5}(?:-\d{1,5})?)(?!\s*[mMkK])')


def place_cb(e):
    try:
        lat, lng = float(e['lat']), float(e['lng'])
    except ValueError:
        return None, 'no coords'
    if not (BOX[0] <= lat <= BOX[2] and BOX[1] <= lng <= BOX[3]):
        return None, 'coords outside'
    text = e['text']
    if re.match(r'^[가-힣]{1,6}선\s*\d', text) or HWY.search(text):
        return (lat, lng, '', 0), None
    head = re.split(r'[（(]', text)[0].strip(' ,')
    if re.search(r'\d', head):
        hits = [it for it in geocode(CONF['prefix'] + ' ' + re.sub(r'\s+', ' ', head)[:80]) if BOX[0] <= it['lat'] <= BOX[2] and BOX[1] <= it['lng'] <= BOX[3]]
        if hits:
            d = math.hypot((hits[0]['lat'] - lat) * KY, (hits[0]['lng'] - lng) * kx(lat))
            if d > 1000:
                return None, 'coords disagree with address (%dm)' % d
    return (lat, lng, '', 0), None


def place(e):
    if AREA == 'cb':
        return place_cb(e)
    text = e['text']
    if '삭제' in text or '삭  제' in text:
        return None, 'deleted'
    head = re.split(r'[（(]', text)[0].strip(' ,')
    if HWY.search(text):
        return None, 'highway milepost'
    if not ROAD_NUM.search(head) and not JIBUN_ANY.search(head):
        # 지번이 괄호 안·뒤에 있는 줄: '춘천시 북산면 춘양로(추곡리 924-5, 춘천→양구)', '…교차로 후(문막→소초), 흥업면 대안리 32-7'
        j = JIBUN_ANY.search(text)
        if not j:
            return None, 'no address'
        city = re.search(r'([가-힣]{1,4}(?:시|군))(?=\s|$)', text)
        eup = re.search(r'([가-힣]{1,4}(?:읍|면))(?=\s|$)', text)
        head = ' '.join(x for x in ((city.group(1) if city else ''), (eup.group(1) if eup and eup.start() < j.start() + 40 else ''), j.group(1), j.group(2)) if x)
    q = head if any(head.startswith(n) for n in CONF['names']) else CONF['prefix'] + ' ' + head
    q = re.sub(r'\s+', ' ', q)[:90]
    hits = [it for it in geocode(q) if BOX[0] <= it['lat'] <= BOX[2] and BOX[1] <= it['lng'] <= BOX[3]]
    if not hits:
        return None, 'no geocode'
    it = hits[0]
    m = ROADNAME.search(head)
    road = m.group(1) if m else ''
    near = near_ways(it['lat'], it['lng'], 120)
    named = [x for x in near if road and norm(ROADW[x[1]]['name']).startswith(norm(road))]
    pool = named or [x for x in near if x[0] <= 80]
    if not pool:
        return None, 'no road within 80m'
    d, wi, px, py = pool[0]
    return (it['lat'] + py / KY, it['lng'] + px / kx(it['lat']), ROADW[wi]['name'] or ROADW[wi]['ref'], round(d)), None


def main():
    es = entries()
    print('entries', len(es))
    out, skipped = [], []
    for n, e in enumerate(es):
        res, why = place(e)
        if not res:
            skipped.append({'id': e['id'], 'text': e['text'], 'why': why})
        else:
            lat, lng, road, d = res
            t = e['text']
            out.append({'src': AREA, 'id': e['id'], 'lat': round(lat, 6), 'lng': round(lng, 6), 'text': t, 'booth': e.get('booth', '부스' in t), 'limit': e.get('limit', 0),
                        'school': bool(e.get('school')) or '어린이' in t or '스쿨' in t or '초교' in t or '초등학교' in t, 'road': road, 'snap': d})
        if n % 40 == 0:
            json.dump(CACHE, open(CACHE_F, 'w', encoding='utf-8'), ensure_ascii=False)
    json.dump(CACHE, open(CACHE_F, 'w', encoding='utf-8'), ensure_ascii=False)
    json.dump({'points': out, 'skipped': skipped}, open(os.path.join(DIR, 'points.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=0)
    why = {}
    for s in skipped:
        why[s['why']] = why.get(s['why'], 0) + 1
    print('placed', len(out), 'skipped', len(skipped), why)


if __name__ == '__main__':
    main()
