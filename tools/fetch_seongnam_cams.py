"""경기도 성남시_교통단속 카메라(data.go.kr 15111673) OpenAPI 를 받아 경찰청 표준데이터와 대조한다 (2026-11-16 사용자가 보낸 API).

    py -I -X utf8 tools/fetch_seongnam_cams.py <저장할 JSON> <경찰청 CSV(fetch_cams.py 또는 파일 다운로드)> [--refetch]

요청: https://apis.data.go.kr/3780000/trfcCameraService/trfcCameraList ?serviceKey&type=json&pageNo&numOfRows
  (원래 주소 https://openapi2.seongnam.go.kr/trfcCameraService/trfcCameraList. 개발계정 하루 5,000회, 실시간, 이용 제한 없음)
응답 항목(명세): id 연번, latitude, longitude, sfznId 보호구역ID, ctprvnNm, signguNm, sisulNm 대상시설명, policeNm 관할경찰서명,
  referenceDate, image 사진 이름, remark 비고. 단속 종류(과속·신호·유턴·정지선)와 제한속도 항목은 명세에 없다
  → 앱에 바로 넣지 않고, 경찰청 자료의 위치 확인·빠진 카메라 찾기에만 쓴다.
인증키: fetch_cams.py 와 같은 DATA_GO_KR_KEY (이 API 도 data.go.kr 에서 따로 활용신청해야 한다). 키는 출력·저장하지 않는다.
대조: 성남시 카메라마다 경찰청 카메라(주정차 제외, 시군구명에 '성남') 중 가장 가까운 것까지의 거리.
  30m 안 = 같은 카메라, 30~100m = 위치가 다를 수 있음, 100m 넘음 = 경찰청 자료에 없음. 반대로 성남시 자료 100m 안에 없는 경찰청 카메라도 센다.
"""
import json
import math
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fetch_cams import load, service_key  # noqa: E402

API = 'https://apis.data.go.kr/3780000/trfcCameraService/trfcCameraList'
PER = 1000


def page(key, no):
    qs = 'serviceKey=' + key + '&' + urllib.parse.urlencode({'type': 'json', 'pageNo': no, 'numOfRows': PER})
    req = urllib.request.Request(API + '?' + qs, headers={'User-Agent': 'tesla-nav-build/1.0', 'Accept': 'application/json'})
    err = ''
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                raw = r.read().decode('utf-8', 'replace')
            break
        except urllib.error.HTTPError as e:
            err = 'HTTP %d' % e.code
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            err = type(e).__name__
        time.sleep(2 + attempt * 3)
    else:
        sys.exit('page %d: %s (4번 시도)' % (no, err))
    try:
        doc = json.loads(raw)
    except ValueError:
        import re
        m = re.search(r'<(?:returnAuthMsg|resultMsg)>([^<]+)<', raw)
        sys.exit('page %d: JSON 이 아님 (%s)' % (no, m.group(1) if m else raw[:80]))
    res = doc.get('response', doc)
    head = res.get('header', {})
    if str(head.get('resultCode', '00')) not in ('00', '0'):
        if str(head.get('resultCode')) == '03':
            return [], 0
        sys.exit('page %d: %s %s' % (no, head.get('resultCode'), head.get('resultMsg')))
    body = res.get('body', {})
    items = body.get('items') or []
    if isinstance(items, dict):
        items = items.get('item') or []
    if isinstance(items, dict):
        items = [items]
    return items, int(body.get('totalCount') or 0)


def fetch(out):
    key = service_key()
    rows, total, no = [], None, 1
    while True:
        items, tc = page(key, no)
        if total is None:
            total = tc
            print('totalCount', total)
        rows += items
        if not items or len(rows) >= total:
            break
        no += 1
        time.sleep(0.3)
    if rows:
        print('항목', sorted(rows[0].keys()))
    json.dump(rows, open(out, 'w', encoding='utf-8'), ensure_ascii=False, indent=0)
    print('wrote', out, len(rows))


def dist(a, b):
    k = 111320 * math.cos(math.radians(a[0]))
    return math.hypot((a[0] - b[0]) * 110540, (a[1] - b[1]) * k)


def compare(sn_file, police_csv):
    # 실제 응답 항목 이름은 소문자다 (sisulnm, policenm, referencedate …. 2026-11-16 확인) → 명세 이름으로 맞춘다
    NAMES = {k.lower(): k for k in ('id', 'latitude', 'longitude', 'sfznId', 'ctprvnNm', 'signguNm', 'sisulNm', 'policeNm', 'referenceDate', 'image', 'remark')}
    sn = [{NAMES.get(k.lower(), k): v for k, v in it.items()} for it in json.load(open(sn_file, encoding='utf-8'))]
    pts = []
    for it in sn:
        try:
            pts.append((float(it.get('latitude')), float(it.get('longitude')), it))
        except (TypeError, ValueError):
            pass
    pol = []
    for r in load(police_csv):
        if '성남' not in r[2] or '4' in r[12].replace(' ', '').split('+'):
            continue
        try:
            pol.append((float(r[9]), float(r[10]), r))
        except ValueError:
            pass
    near = []
    for la, ln, it in pts:
        d, r = min(((dist((la, ln), (p[0], p[1])), p[2]) for p in pol), default=(1e9, None), key=lambda x: x[0])
        near.append((d, it, r))
    same = [x for x in near if x[0] <= 30]
    off = [x for x in near if 30 < x[0] <= 100]
    miss = [x for x in near if x[0] > 100]
    pol_only = [p for p in pol if not any(dist((p[0], p[1]), (q[0], q[1])) <= 100 for q in pts)]
    print('성남시 %d곳, 경찰청(성남·주정차 제외) %d대' % (len(pts), len(pol)))
    print('같은 카메라(30m 안) %d, 30~100m %d, 경찰청 자료에 없음(100m 넘음) %d, 성남시 자료에 없는 경찰청 카메라 %d' % (
        len(same), len(off), len(miss), len(pol_only)))
    for d, it, r in sorted(off, key=lambda x: -x[0])[:15]:
        print('  %4.0fm  %s / %s  ↔ 경찰청 %s %s (제한 %s)' % (d, it.get('sisulNm'), it.get('policeNm'), r[0], r[11], r[13]))
    print('경찰청 자료에 없는 성남시 카메라:')
    for d, it, r in miss[:40]:
        print('  %s (%s, %s) %s,%s 가장 가까운 경찰청 %dm' % (it.get('sisulNm'), it.get('policeNm'), it.get('remark') or '', it.get('latitude'), it.get('longitude'), d))


if __name__ == '__main__':
    args = [a for a in sys.argv[1:] if a != '--refetch']
    if len(args) < 2:
        sys.exit(__doc__)
    if '--refetch' in sys.argv or not os.path.exists(args[0]):
        fetch(args[0])
    compare(args[0], args[1])
