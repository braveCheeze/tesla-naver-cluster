"""서울경찰청 '이동식 단속 사전 예고지점' PDF → 좌표 붙인 지점 목록 (<SRC>/seoul/seoul.json, build_mobile.py 가 읽는다).

2026-11-16 사용자 '넣어 줘' (박스형·이동식 단속 지점에 서울도). 원본에는 좌표가 없고 설치장소 글자만 있다
(예: '동대문구 천호대로 233 신답지하차도(구청R→답십리역R)', '올림픽대로 잠실철교 밑(천호대교→김포공항방향)', '잠실대교 북단(남→북방향)').

    py -I -X utf8 tools/geo_mobile_seoul.py <SRC 폴더> [D:/osm/south-korea-latest.osm.pbf]
      <SRC>/seoul/seoul.pdf 를 읽고 <SRC>/seoul/seoul.json 을 쓴다. 검색 결과는 <SRC>/seoul/geo_cache.json 에 두고 다시 쓰지 않는다.

위치 (확실한 것만. 아니면 빼고 skipped 에 남긴다):
  1. 도로명 주소('천호대로 233', '동일로72길43', '마들로329') → 네이버 주소 검색(앱 Worker /geocode). 그 도로(같은 이름의 OSM 길) 80m 안에 붙인다
  2. 지번 주소('잠원동 116', '신내동 산 52-10') → 주소 검색, 가까운 차도 50m 안(글에 도로 이름이 있으면 그 길 150m 안)
  3. 다리 끝('잠실대교 북단') → OSM 의 그 다리 길에서 북쪽(남쪽·동쪽·서쪽) 끝
  4. 도시고속도로 위 표지물('올림픽대로 잠실철교 밑', '강변북로 테크노마트 앞') → 장소 검색 결과에서 그 도로(OSM 같은 이름) 500m 안
  그 밖(구간만 'A→B', 이름 없는 표지물)은 넣지 않는다.
방향: '(A→B)' 의 A·B 를 장소 검색해(지점 3km 안) 진행 방향을 정한다. 양방향 길이면 그 방향 오른쪽 6m 에 두고(우측통행: osm_cams 가
  찍는 방향을 길 오른쪽으로 본다), 일방통행 길(분리된 도로의 한쪽)이면 그 방향으로 가는 같은 이름의 길에 붙인다. '남→북'은 나침반 방향.
  방향을 못 정하면 길 가운데(양방향). 그 방향으로 가는 길을 못 찾으면 뺀다.
Worker 는 앱이 쓰는 것(https://tesla-nav.cy6789.workers.dev)이고, 로컬 개발용으로 허용된 Origin(http://localhost:8765)으로 부른다.
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

SRC = sys.argv[1]
PBF = sys.argv[2] if len(sys.argv) > 2 else r'D:\osm\south-korea-latest.osm.pbf'
DIR = os.path.join(SRC, 'seoul')
WORKER = 'https://tesla-nav.cy6789.workers.dev'
ORIGIN = 'http://localhost:8765'
BOX = (37.40, 126.75, 37.72, 127.20)          # 서울 둘레
ROADS = {'motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'living_street',
         'motorway_link', 'trunk_link', 'primary_link', 'secondary_link', 'tertiary_link', 'road'}
EXPWAYS = ['올림픽대로', '강변북로', '동부간선도로', '서부간선도로', '내부순환로', '북부간선도로', '남부순환로', '경부고속도로',
           '분당수서로', '강남순환로', '노들로', '양재대로', '헌릉로', '소월로', '원효로', '여의대로', '국회대로']
KY = 110540.0


def kx(lat):
    return 111320.0 * math.cos(math.radians(lat))


def norm(s):
    return re.sub(r'\s+', '', s or '')


# ------------------------------------------------------------------ 원본 읽기
def entries():
    from pypdf import PdfReader
    pdf = PdfReader(os.path.join(DIR, 'seoul.pdf'))
    lines = []
    for pg in pdf.pages:
        lines += [x.strip() for x in (pg.extract_text() or '').splitlines()]
    out, pending, station = [], None, ''
    TAIL = re.compile(r'\s(일반|스쿨존|실버존)\s+(기존|\S*\d\S*)\s*(0\d{1,2}-\d{3,4}-\d{4})?\s*$')
    for ln in lines:
        if not ln or ln.startswith('연번') or ln.startswith('서울청 관서별'):
            continue
        if re.fullmatch(r'0\d{1,2}-\d{3,4}-\d{4}', ln):
            continue
        if re.fullmatch(r'\d{1,3}', ln):
            pending = int(ln)
            continue
        if re.fullmatch(r'\S*(경찰서|순찰대)', ln):
            station = ln
            continue
        m = TAIL.search(ln)
        if not m:
            continue
        body = ln[:m.start()].strip()
        n = re.match(r'^(\d{1,3})\s+(.*)$', body)
        if n:
            num, body = int(n.group(1)), n.group(2)
        elif pending is not None:
            num = pending
        else:
            continue
        pending = None
        st = re.match(r'^(\S*경찰서)\s+(.*)$', body)
        if st:
            station, body = st.group(1), st.group(2)
        out.append({'n': num, 'station': station, 'text': body.strip(), 'kind': m.group(1)})
    return out


# ------------------------------------------------------------------ OSM 길
def load_roads():
    cache = os.path.join(DIR, 'osm_roads3.json')
    if os.path.exists(cache):
        return json.load(open(cache, encoding='utf-8'))
    import osmium

    class H(osmium.SimpleHandler):
        def __init__(self):
            super().__init__()
            self.ways = []
            self.rails = []

        def way(self, w):
            hw = w.tags.get('highway')
            if w.tags.get('railway') in ('rail', 'subway', 'light_rail') and w.tags.get('bridge') == 'yes':
                nm = w.tags.get('bridge:name') or w.tags.get('name') or ''
                if '교' in nm:
                    try:
                        pts = [(round(n.lat, 6), round(n.lon, 6)) for n in w.nodes]
                    except Exception:
                        return
                    if any(BOX[0] <= a <= BOX[2] and BOX[1] <= b <= BOX[3] for a, b in pts):
                        self.rails.append({'name': nm, 'pts': pts})
                return
            if hw not in ROADS:
                return
            try:
                pts = [(round(n.lat, 6), round(n.lon, 6)) for n in w.nodes]
            except Exception:
                return
            if not any(BOX[0] <= a <= BOX[2] and BOX[1] <= b <= BOX[3] for a, b in pts):
                return
            ow = w.tags.get('oneway')
            one = -1 if ow == '-1' else 1 if (ow in ('yes', '1', 'true') or hw == 'motorway' or w.tags.get('junction') == 'roundabout') else 0
            self.ways.append({'name': w.tags.get('name') or '', 'ref': w.tags.get('ref') or '', 'hw': hw, 'one': one,
                              'bridge': w.tags.get('bridge') == 'yes', 'bname': w.tags.get('bridge:name') or '', 'pts': pts})

    h = H()
    h.apply_file(PBF, locations=True)
    doc = {'ways': h.ways, 'rails': h.rails}
    json.dump(doc, open(cache, 'w', encoding='utf-8'), ensure_ascii=False)
    return doc


_OSM = load_roads()
ROADW, RAILS = _OSM['ways'], _OSM['rails']
GRID = {}
for wi, w in enumerate(ROADW):
    for a, b in w['pts']:
        GRID.setdefault((int(a * 200), int(b * 200)), set()).add(wi)   # 약 500m 칸


def near_ways(lat, lng, radius):
    """[(dist, wi, seg, t, px, py)] radius m 안, 길마다 가장 가까운 점"""
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
                best = (d, wi, i, t, px, py)
        if best and best[0] <= radius:
            out.append(best)
    return sorted(out)


def seg_bearing(wi, i):
    a, b = ROADW[wi]['pts'][i], ROADW[wi]['pts'][i + 1]
    return math.degrees(math.atan2((b[1] - a[1]) * kx(a[0]), (b[0] - a[0]) * KY)) % 360


def adiff(a, b):
    return abs((a - b + 180) % 360 - 180)


ALIAS = {'동부간선도로': '동부간선로', '서부간선도로': '서부간선로', '북부간선도로': '북부간선로', '내부순환로': '내부순환로'}


def name_ok(w, road):
    if not road:
        return False
    r = norm(road)
    cands = {r, norm(ALIAS.get(road, road))}
    nm, bn = norm(w['name']), norm(w.get('bname'))
    return any(c and (c == nm or (len(c) >= 3 and nm.startswith(c) and not re.match(r'\d', nm[len(c):len(c) + 1] or 'x')) or c == bn) for c in cands)


# ------------------------------------------------------------------ 검색 (Worker)
CACHE_F = os.path.join(DIR, 'geo_cache.json')
CACHE = json.load(open(CACHE_F, encoding='utf-8')) if os.path.exists(CACHE_F) else {}


def call(path, q):
    key = path + '|' + q
    if key in CACHE:
        return CACHE[key]
    url = WORKER + path + '?query=' + urllib.parse.quote(q)
    req = urllib.request.Request(url, headers={'Origin': ORIGIN, 'User-Agent': 'tesla-nav-build/1.0'})
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            items = json.loads(r.read().decode('utf-8')).get('items') or []
    except Exception as e:   # noqa: BLE001
        print('  검색 실패', path, q, e)
        items = None
    if items is not None:
        CACHE[key] = items
    time.sleep(0.15)
    return items or []


def in_seoul(it):
    return BOX[0] <= it['lat'] <= BOX[2] and BOX[1] <= it['lng'] <= BOX[3]


def search_near(name, lat, lng, within=3000):
    name = re.sub(r'(방향|방면|쪽|진행)$', '', name.strip())
    name = re.sub(r'(?<=[가-힣0-9])R$', '', name)          # '답십리역R' (R = 로터리·교차로)
    name = re.sub(r'@$', '아파트', name)
    if len(norm(name)) < 2 or name in ('남', '북', '동', '서', '남단', '북단'):
        return None
    best = None
    for q in (name, '서울 ' + name):
        for it in call('/search', q):
            if not in_seoul(it):
                continue
            d = math.hypot((it['lat'] - lat) * KY, (it['lng'] - lng) * kx(lat))
            if d <= within and (best is None or d < best[0]):
                best = (d, it['lat'], it['lng'])
        if best:
            break
    return best


# ------------------------------------------------------------------ 한 지점
GU = r'([가-힣]{1,4}구)'
ROAD_ADDR = re.compile(r'(?:' + GU + r'\s*)?([가-힣0-9]{1,12}?(?:대로|로|길)(?:\s?\d{1,4}(?:번)?길)?)\s?(\d{1,4}(?:-\d{1,4})?)(?:번지)?(?![\d가-힣]*(?:길|번길))')
JIBUN = re.compile(GU + r'\s*([가-힣0-9]{1,6}동(?:\d가)?)\s*((?:산\s?)?\d{1,5}(?:-\d{1,5})?)')
ARROW = re.compile(r'(→|->|↔)')
COMPASS = {('남', '북'): 0, ('북', '남'): 180, ('서', '동'): 90, ('동', '서'): 270}


def direction_parts(text):
    """(A, B) 원문 / 'both' / None"""
    segs = re.findall(r'\(([^()]*?(?:→|->|↔)[^()]*?)\)', text)
    seg = segs[-1] if segs else (text if ARROW.search(text) else '')
    if not seg:
        return 'both' if '양방향' in text else None
    if '↔' in seg or '양방향' in seg:
        return 'both'
    parts = re.split(r'\s*(?:→|->)\s*', seg)
    if len(parts) != 2:
        return None
    a = parts[0].strip()
    b = re.sub(r'\s*(방향|방면)\s*$', '', parts[1].strip())
    a = re.sub(r'^.*[,，]\s*', '', a)
    return (a, b)


def road_in_text(text):
    for e in EXPWAYS:
        if e in text:
            return e
    m = ROAD_ADDR.search(text)
    return m.group(2).replace(' ', '') if m else ''


def locate(e):
    text = e['text']
    head = re.split(r'[（(]', text)[0]
    road = road_in_text(text)
    # 3. 다리 끝 ('잠실대교 북단'. 방향 글 '(행주대교남단→김포공항)' 안의 다리는 위치가 아니다)
    br = re.search(r'([가-힣]{1,6}(?:대교|철교|교))\s*(북단|남단|동단|서단)', head)
    if br:
        bp = bridge_pts(br.group(1))
        if bp:
            key = {'북단': lambda p: -p[0], '남단': lambda p: p[0], '동단': lambda p: -p[1], '서단': lambda p: p[1]}[br.group(2)]
            p = min(bp, key=key)
            return p[0], p[1], '', 'bridge'
    # 1. 도로명 주소
    m = ROAD_ADDR.search(head) or ROAD_ADDR.search(text)
    gu = re.search(GU, text)
    if m and not re.search(r'(대교|교|IC)$', m.group(2)):
        q = '서울 ' + ((m.group(1) or (gu.group(1) if gu else '')) + ' ').lstrip() + m.group(2) + ' ' + m.group(3)
        for it in call('/geocode', q):
            if in_seoul(it):
                return it['lat'], it['lng'], m.group(2).replace(' ', ''), 'road'
    # 2. 지번
    j = JIBUN.search(text)
    if j:
        q = '서울 ' + j.group(1) + ' ' + j.group(2) + ' ' + j.group(3).replace(' ', ' ')
        for it in call('/geocode', q):
            if in_seoul(it):
                return it['lat'], it['lng'], road, 'jibun'
    # 4. 도로 위 표지물: '올림픽대로 잠실철교 밑', '공항대로 마곡엠밸리12단지 인근', '동일로 군자교 입구'.
    #    검색 결과 중 그 도로(같은 이름의 OSM 길)에 가장 가까운 것 (테크노마트는 신도림·강변 두 곳)
    exp = next((x for x in EXPWAYS if x in text), '')
    rd = exp or (re.search(r'([가-힣0-9]{1,10}(?:대로|로|길))(?=\s)', head) or [None, ''])[1]
    if rd and not re.search(r'\d', rd):
        lm = head.split(rd, 1)[1] if rd in head else ''
        lm = re.sub(r'(밑|위|앞|인근|부근|지점|하부|상부|입구|출구|\+?-?\d+\s*[Mm]?\s*지점?)', ' ', lm)
        lm = re.sub(r'\s+', ' ', lm).strip(' ,')
        lm = lm.split(' ')[0] if lm else ''
        if len(lm) >= 2 and not re.search(r'(상행|하행|방향|방면|양방향)$', lm):
            if re.search(r'(교|철교|대교)$', lm):
                bp = bridge_pts(lm)
                ends = []
                if bp:
                    # 다리의 긴 축 양 끝
                    a = max(bp, key=lambda q: max(abs(q[0] - r[0]) * KY + abs(q[1] - r[1]) * kx(q[0]) for r in bp[:1]))
                    b = max(bp, key=lambda q: abs(q[0] - a[0]) * KY + abs(q[1] - a[1]) * kx(q[0]))
                    ends = [a, b]
                best = None
                for q in ends + bp:
                    named = [x for x in near_ways(q[0], q[1], 150) if name_ok(ROADW[x[1]], rd)]
                    if named and (best is None or named[0][0] < best[0]):
                        best = (named[0][0], q[0], q[1])
                if best:
                    return best[1], best[2], rd, 'landmark', 150
                return None
            far = 250 if exp else 200
            best = None
            for q in (lm, '서울 ' + lm):
                for it in call('/search', q):
                    if not in_seoul(it):
                        continue
                    named = [x for x in near_ways(it['lat'], it['lng'], far) if name_ok(ROADW[x[1]], rd)]
                    if named and (best is None or named[0][0] < best[0]):
                        best = (named[0][0], it['lat'], it['lng'])
                if best:
                    break
            if best:
                return best[1], best[2], rd, 'landmark' if exp else 'landmark2', far
    return None


def bridge_pts(name):
    n = norm(name)
    pts = [p for w in ROADW if norm(w.get('bname')).startswith(n) for p in w['pts']]
    if not pts:
        pts = [p for r in RAILS if norm(r['name']).startswith(n) for p in r['pts']]
    if not pts:
        for it in call('/search', name):
            if not in_seoul(it) or norm(it['name']) != n:
                continue
            # 검색 위치(다리 가운데)에 가장 가까운 다리 길(80m 안)의 도로 이름으로, 그 이름의 다리 길만 (광진교·천호대교는 200m 떨어져 붙어 있다)
            near = [x for x in near_ways(it['lat'], it['lng'], 600) if ROADW[x[1]]['bridge']]
            if not near or near[0][0] > 80:
                continue
            main = ROADW[near[0][1]]['name']
            pts = [p for x in near if ROADW[x[1]]['name'] == main and x[0] <= 600 for p in ROADW[x[1]]['pts']]
            break
    return pts


def place(e):
    loc = locate(e)
    if not loc:
        return None, 'no location'
    lat, lng, road, how = loc[:4]
    radius = loc[4] if len(loc) > 4 else {'road': 80, 'jibun': 150 if road else 50, 'bridge': 30}[how]
    near = near_ways(lat, lng, radius)
    named = [x for x in near if name_ok(ROADW[x[1]], road)] if road else []
    if road and not named and how in ('landmark', 'landmark2', 'bridge'):
        return None, 'named road not near (' + road + ')'
    if how == 'road' and road and not named:   # 도로명 주소인데 그 이름의 길이 없으면 (옆 골목에 붙이지 않는다)
        return None, 'named road not near (' + road + ')'
    pool = named or [x for x in near if x[0] <= (40 if how == 'road' else 50)]
    if not pool:
        return None, 'no road within %dm' % radius
    d0 = direction_parts(e['text'])
    want = None
    if isinstance(d0, tuple):
        if (d0[0].strip('방향 '), d0[1].strip('방향 ')) in COMPASS:
            want = COMPASS[(d0[0].strip('방향 '), d0[1].strip('방향 '))]
        else:
            wide = how in ('landmark', 'bridge')
            a = search_near(d0[0], lat, lng, 25000 if wide else 3000)
            b = search_near(d0[1], lat, lng, 25000 if wide else 3000)
            if a and b and math.hypot((b[1] - a[1]) * KY, (b[2] - a[2]) * kx(lat)) > 60:
                want = math.degrees(math.atan2((b[2] - a[2]) * kx(lat), (b[1] - a[1]) * KY)) % 360
            elif wide and b and b[0] > 60:
                want = math.degrees(math.atan2((b[2] - lng) * kx(lat), (b[1] - lat) * KY)) % 360
            elif wide and a and a[0] > 60:
                want = (math.degrees(math.atan2((a[2] - lng) * kx(lat), (a[1] - lat) * KY)) + 180) % 360
    k = kx(lat)
    if want is None:
        d, wi, i, t, px, py = pool[0]
        return (lat + py / KY, lng + px / k, 'both' if d0 == 'both' else 'none', how, ROADW[wi]['name']), None
    # 원하는 방향으로 가는 길 (일방통행이면 그 방향, 양방향 길이면 오른쪽 6m)
    best = None
    for d, wi, i, t, px, py in pool:
        w = ROADW[wi]
        hb = seg_bearing(wi, i)
        if w['one']:
            go = hb if w['one'] == 1 else (hb + 180) % 360
            if adiff(go, want) <= (70 if how in ('landmark', 'bridge') else 60) and (best is None or d < best[0]):
                best = (d, wi, px, py, go, 0)
        else:
            go = hb if adiff(hb, want) <= 90 else (hb + 180) % 360
            if adiff(go, want) <= 60 and (best is None or d < best[0]):
                best = (d, wi, px, py, go, 6)
    if not best:
        d, wi, i, t, px, py = pool[0]
        if ROADW[wi]['one']:
            return None, 'no road going %d°' % want
        return (lat + py / KY, lng + px / k, 'none', how, ROADW[wi]['name']), None
    d, wi, px, py, go, off = best
    if off:
        r = math.radians(go + 90)
        px, py = px + off * math.sin(r), py + off * math.cos(r)
    return (lat + py / KY, lng + px / k, 'one', how, ROADW[wi]['name'], round(go)), None


def main():
    es = entries()
    print('entries', len(es), 'numbers', es[0]['n'] if es else '-', '..', es[-1]['n'] if es else '-')
    out, skipped = [], []
    for e in es:
        res, why = place(e)
        if not res:
            skipped.append({'n': e['n'], 'text': e['text'], 'why': why})
            continue
        lat, lng, dmode, how, wname = res[:5]
        out.append({'src': 'seoul', 'id': 'SEOUL-%d' % e['n'], 'lat': round(lat, 6), 'lng': round(lng, 6), 'text': e['text'],
                    'booth': False, 'limit': 0, 'school': e['kind'] == '스쿨존', 'how': how, 'dir': dmode, 'road': wname,
                    'heading': res[5] if len(res) > 5 else None})
        json.dump(CACHE, open(CACHE_F, 'w', encoding='utf-8'), ensure_ascii=False)
    json.dump(CACHE, open(CACHE_F, 'w', encoding='utf-8'), ensure_ascii=False)
    json.dump({'date': '2026-10-28', 'points': out, 'skipped': skipped}, open(os.path.join(DIR, 'seoul.json'), 'w', encoding='utf-8'),
              ensure_ascii=False, indent=0)
    by = {}
    for p in out:
        by[p['how'] + '/' + p['dir']] = by.get(p['how'] + '/' + p['dir'], 0) + 1
    print('placed', len(out), by, 'skipped', len(skipped))
    why = {}
    for s in skipped:
        why[s['why'].split(' (')[0]] = why.get(s['why'].split(' (')[0], 0) + 1
    print('skip reasons', why)


if __name__ == '__main__':
    main()
