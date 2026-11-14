"""전국 도로안전표지 표준데이터 -> 페이지용 압축 JSON (data/signs.json). 주의표지 중 운전에 쓸모 있는 것만.

원본: 공공데이터포털 '전국도로안전표지표준데이터'(data.go.kr 15028194, 경찰청 소관·지방자치단체 제공, 이용 제한 없음).
  - 그리드 다운로드 CSV(cp949)는 5만 행까지만 받아진다 (2026-11 기준 제공 지자체 57곳 중 27곳만 들어 있음).
  - 전체는 오픈API(tn_pubr_public_road_safety_mark_api)로 받는다: tools/fetch_signs.py 가 받은 JSON 을 그대로 넣으면 된다.
  - 이 데이터는 지자체가 설치한 표지만 들어 있고 제공 지자체도 일부뿐이다 (고속도로·국도 대부분은 없음).
사용법: py -I tools/build_signs.py <전국도로안전표지표준데이터.csv 또는 fetch_signs.py 가 만든 .json> [...] data/signs.json

출력: {"v":1, "scale":100000, "date":"YYYY-MM-DD", "count":N, "types":[...], "d":[dLat, dLng, type, ...]}
  - 좌표는 위도·경도 x 100000 정수(약 1m). 0.02° 칸 순서로 정렬한 뒤 앞 점과의 차이만 적는다 (build_bumps.py 와 같음)
  - type: types 배열의 번호 (아래 TYPES 순서. 앱의 SIGN_TYPES 와 같은 순서여야 한다)
  - 안전표지구분 1(주의표지)만. 지자체마다 '안전표지종별일련번호' 칸에 표지 코드 대신 일련번호를 넣은 곳이 많아서
    '안전표지설명' 글을 먼저 보고, 설명이 없을 때만 코드로 고른다
  - 같은 종류가 15m 안에 겹치면 하나로 합친다 (양면 표지·중복 입력)
  - 과속방지턱(129)은 data/bumps.json 이 따로 있고, 횡단보도·어린이보호·굽은도로·교차로 표지는 너무 흔해서 뺀다
"""
import csv
import io
import json
import math
import re
import sys
from collections import Counter

# (이름, 도로교통법 시행규칙 별표6 주의표지 번호, 설명 글에서 찾을 말)
TYPES = [
    ('slip', '126', r'미끄러|결빙'),
    ('rock', '130', r'낙석'),
    ('up', '116', r'오르막'),
    ('down', '117', r'내리막'),
    ('rough', '128', r'노면\s*고르|고르지\s*못'),
    ('wind', '137', r'횡풍|강풍'),
    ('animal', '139', r'야생\s*동물|동물\s*보호|동물\s*출현'),
    ('narrow', '118', r'도로\s*폭\s*이?\s*좁|폭\s*좁아'),
    ('rail', '110', r'철길|철도\s*건널목|건널목'),
    ('danger', '140', r'^\s*위험|사고\s*(잦은|다발|많은)|위험\s*구간'),
]
NAMES = [t[0] for t in TYPES]
BY_CODE = {t[1]: i for i, t in enumerate(TYPES)}
# 설명이 이런 표지면 위 말이 들어 있어도 고르지 않는다 (보조표지 문구 등)
SKIP_DESC = re.compile(r'과속방지턱|횡단보도|어린이|노인|자전거')

# 오픈API 응답(영문 필드)과 CSV(한글 머리글) 양쪽 이름
FIELDS = {
    'lat': ('위도', 'latitude'),
    'lng': ('경도', 'longitude'),
    'cls': ('안전표지구분', 'sflblSe'),
    'code': ('안전표지종별일련번호', 'asortSn'),
    'desc': ('안전표지설명', 'sflblDc'),
    'date': ('데이터기준일자', 'referenceDate'),
}


def read_rows(path):
    """CSV 또는 fetch_signs.py JSON 을 {필드: 값} 목록으로"""
    raw = open(path, 'rb').read()
    if path.lower().endswith('.json'):
        data = json.loads(raw.decode('utf-8'))
        items = data['items'] if isinstance(data, dict) else data
        return [{k: str(v if v is not None else '') for k, v in it.items()} for it in items]
    for enc in ('utf-8-sig', 'cp949'):
        try:
            text = raw.decode(enc)
            break
        except UnicodeDecodeError:
            continue
    return list(csv.DictReader(io.StringIO(text)))


def pick(row, key):
    for name in FIELDS[key]:
        if name in row:
            return (row[name] or '').strip()
    return ''


def classify(cls, code, desc):
    if cls.lstrip('0') != '1':
        return None
    if desc:
        if SKIP_DESC.search(desc):
            return None
        for i, (_, _, pat) in enumerate(TYPES):
            if re.search(pat, desc):
                return i
        return None
    return BY_CODE.get(code.lstrip('0'))


def dist_m(a, b):
    dy = (a[0] - b[0]) / 1e5 * 110540
    dx = (a[1] - b[1]) / 1e5 * 111320 * math.cos(math.radians(a[0] / 1e5))
    return math.hypot(dx, dy)


def main(srcs, out):
    pts, skipped, dates, kinds = [], Counter(), Counter(), Counter()
    total = 0
    for src in srcs:
        for r in read_rows(src):
            total += 1
            t = classify(pick(r, 'cls'), pick(r, 'code'), pick(r, 'desc'))
            if t is None:
                skipped['type'] += 1
                continue
            try:
                lat, lng = float(pick(r, 'lat')), float(pick(r, 'lng'))
            except ValueError:
                skipped['coord'] += 1
                continue
            if not (33 < lat < 39 and 124 < lng < 132):
                skipped['outside'] += 1
                continue
            pts.append([round(lat * 1e5), round(lng * 1e5), t])
            d = pick(r, 'date')
            if d:
                dates[d[:10]] += 1

    # 같은 종류 15m 안 중복 합치기 (격자 0.0002° ≈ 20m)
    cells, kept = {}, []
    for p in pts:
        cy, cx = p[0] // 20, p[1] // 20
        dup = any(q[2] == p[2] and dist_m(p, q) <= 15
                  for dy in (-1, 0, 1) for dx in (-1, 0, 1) for q in cells.get((cy + dy, cx + dx), ()))
        if dup:
            skipped['merged'] += 1
            continue
        cells.setdefault((cy, cx), []).append(p)
        kept.append(p)
        kinds[NAMES[p[2]]] += 1

    kept.sort(key=lambda p: (p[0] // 2000, p[1] // 2000, p[0], p[1]))
    d, plat, plng = [], 0, 0
    for p in kept:
        d += [p[0] - plat, p[1] - plng, p[2]]
        plat, plng = p[0], p[1]
    latest = max(dates) if dates else ''
    with open(out, 'w', encoding='utf-8') as f:
        json.dump({'v': 1, 'scale': 100000, 'date': latest, 'count': len(kept), 'types': NAMES, 'd': d}, f, separators=(',', ':'))
    print('rows', total, 'kept', len(kept), 'skipped', dict(skipped), 'date', latest)
    print('types', dict(kinds.most_common()))


if __name__ == '__main__':
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    main(sys.argv[1:-1], sys.argv[-1])
