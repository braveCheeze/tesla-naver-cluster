"""고속도로 휴게소: 한국도로공사 '휴게소 위치정보' → data/rest.json (2026-11-14 요청)

원본: data.ex.co.kr OpenAPI locationinfo/locationinfoRest (휴게소명·노선·좌표, 203곳. 민자고속도로 휴게소는 없음)
  https://data.ex.co.kr/openapi/locationinfo/locationinfoRest?key=test&type=json&numOfRows=99&pageNo=1..3
  (key=test 는 공개 견본 키. 페이지 셋을 받아 한 목록(JSON 배열)으로 저장해 두고 이 스크립트에 넘긴다)
휴게소명 '서울만남(부산)휴게소' → 이름 '서울만남휴게소', 방향 '부산' (괄호가 없거나 '양방향'이면 양쪽에서 들른다)

출력: { date, count, items: [[lat, lng, name, dir, route], ...] }
사용법: py -I tools/build_rest.py <받은 목록.json> data/rest.json
"""
import json
import math
import re
import sys
from datetime import date

# 원본 좌표가 틀린 곳은 뺀다 (2026-11-14 점검: 같은 노선 휴게소들과 300km 떨어진 곳)
DROP = {
    ('홍천휴게소', '양양'),   # 서울양양선인데 좌표가 부산(35.27, 129.00)으로 올라 있다
}
src, out = sys.argv[1], sys.argv[2]
rows = json.load(open(src, encoding='utf-8'))
items, seen = [], set()
for r in rows:
    try:
        lat, lng = float(r['yValue']), float(r['xValue'])
    except (KeyError, ValueError, TypeError):
        continue
    if not (33 < lat < 39 and 124 < lng < 132):
        continue
    raw = (r.get('unitName') or '').strip()
    m = re.search(r'\(([^)]*)\)', raw)
    d = m.group(1).strip() if m else ''
    name = re.sub(r'\s*\([^)]*\)\s*', '', raw).strip()
    if not name.endswith('휴게소'):
        name += '휴게소'
    if (name, d) in DROP:
        continue
    key = (round(lat, 5), round(lng, 5))
    if key in seen:
        continue
    seen.add(key)
    items.append([round(lat, 6), round(lng, 6), name, d, (r.get('routeName') or '').strip()])


# 이름에 방향이 없는데 500m 안에 다른 휴게소가 있으면(같은 곳의 다른 이름이거나 반대편 짝) 한쪽 방향 휴게소로 본다
# (예: '기흥복합휴게소'는 '기흥휴게소(부산)'과 같은 자리라 서울 방향에서는 들를 수 없다, '부안상쉼터'·'부안하쉼터'는 서로 반대편).
# 앱은 방향이 적힌 휴게소를 경로 오른쪽에 있을 때만 쓴다. 혼자 있는 곳(덕평·하남드림 등)만 양방향으로 둔다
def dist_m(a, b):
    la1, lo1, la2, lo2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    h = math.sin((la2 - la1) / 2) ** 2 + math.cos(la1) * math.cos(la2) * math.sin((lo2 - lo1) / 2) ** 2
    return 2 * 6371000 * math.asin(math.sqrt(h))


for x in items:
    if not x[3] and any(y is not x and dist_m(x, y) < 500 for y in items):
        x[3] = '한쪽'
items.sort()
with open(out, 'w', encoding='utf-8', newline='\n') as fh:
    json.dump({'date': date.today().isoformat(), 'count': len(items), 'items': items}, fh, ensure_ascii=False, separators=(',', ':'))
print('rest areas', len(items))
