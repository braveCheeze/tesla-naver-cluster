"""전국도로안전표지표준데이터 오픈API에서 주의표지(안전표지구분 1)만 전부 받아 JSON 하나로 저장한다.

그리드 CSV 다운로드는 5만 행에서 잘리므로 전국 자료는 이 API 로 받는다 (data.go.kr 15028194, 활용신청 자동승인).
  요청주소 https://api.data.go.kr/openapi/tn_pubr_public_road_safety_mark_api
  변수 serviceKey, pageNo, numOfRows(최대 1000), type=json, sflblSe(안전표지구분: 지자체마다 '1' 또는 '01')
사용법 (인증키는 저장소에 넣지 않는다. 환경변수로만):
  set DATA_GO_KR_KEY=<공공데이터포털 일반 인증키(Decoding)>
  py -I tools/fetch_signs.py <저장할 경로.json>
  py -I tools/build_signs.py <저장한 경로.json> data/signs.json
"""
import json
import os
import sys
import time
import urllib.parse
import urllib.request

API = 'https://api.data.go.kr/openapi/tn_pubr_public_road_safety_mark_api'
ROWS = 1000


def get(key, page, se):
    qs = urllib.parse.urlencode({'serviceKey': key, 'pageNo': page, 'numOfRows': ROWS, 'type': 'json', 'sflblSe': se})
    for attempt in range(4):
        try:
            with urllib.request.urlopen(API + '?' + qs, timeout=60) as r:
                body = r.read().decode('utf-8')
            j = json.loads(body)
            resp = j.get('response', j)
            head = resp.get('header', {})
            code = str(head.get('resultCode', ''))
            if code == '03':  # 데이터 없음
                return 0, []
            if code not in ('00', '0'):
                raise RuntimeError('API %s %s' % (code, head.get('resultMsg')))
            b = resp.get('body', {})
            items = b.get('items') or []
            if isinstance(items, dict):
                items = items.get('item') or []
            if isinstance(items, dict):
                items = [items]
            return int(b.get('totalCount') or 0), items
        except (OSError, ValueError) as e:
            if attempt == 3:
                raise
            print('  retry', page, se, type(e).__name__, file=sys.stderr)
            time.sleep(2 + attempt * 3)


def main(out):
    key = os.environ.get('DATA_GO_KR_KEY', '').strip()
    if not key:
        sys.exit('DATA_GO_KR_KEY 환경변수에 공공데이터포털 인증키(Decoding)를 넣어 주세요')
    allitems, seen = [], set()
    for se in ('1', '01'):
        total, items = get(key, 1, se)
        pages = (total + ROWS - 1) // ROWS
        print('sflblSe=%s total %d (%d pages)' % (se, total, pages))
        batch = list(items)
        for page in range(2, pages + 1):
            batch += get(key, page, se)[1]
            time.sleep(0.2)
        for it in batch:
            k = (it.get('insttCode') or it.get('instt_code'), it.get('sflblSn'), it.get('latitude'), it.get('longitude'), it.get('asortSn'), it.get('sflblDc'))
            if k in seen:
                continue
            seen.add(k)
            allitems.append(it)
    with open(out, 'w', encoding='utf-8') as f:
        json.dump({'source': API, 'fetched': time.strftime('%Y-%m-%d'), 'items': allitems}, f, ensure_ascii=False)
    orgs = sorted({str(it.get('insttNm') or it.get('institutionNm') or '') for it in allitems})
    print('saved', len(allitems), 'items from', len(orgs), 'organizations ->', out)


if __name__ == '__main__':
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
