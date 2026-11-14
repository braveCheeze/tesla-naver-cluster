"""전국 과속방지턱을 공공데이터포털 오픈API로 전부 받아, 파일 다운로드와 같은 모양의 CSV 로 저장한다.

예전 원본(file.localdata.go.kr 전체 파일 다운로드)이 2026-11 부터 403 으로 막혀서 만든 대체 경로.
  API: 행정안전부_과속방지턱정보 조회서비스 (data.go.kr 15155087, 활용신청 자동승인, 개발계정 하루 1만 회)
       https://apis.data.go.kr/1741000/speed_bump_info/info?serviceKey=…&pageNo=…&numOfRows=100 (한 번에 100건까지)
  매일 갱신(2일 전 기준). 전국 약 14만 건 → 약 1,400번 부른다.
사용법 (인증키는 저장소에 넣지 않는다. 환경변수로만):
  set DATA_GO_KR_KEY=<공공데이터포털 일반 인증키>
  py -I tools/fetch_bumps.py <저장할 경로.csv>
  py -I tools/build_bumps.py <저장한 경로.csv> data/bumps.json
중간에 끊기면 같은 명령을 다시 실행하면 받은 쪽(<경로>.part.json)부터 이어 받는다.
"""
import csv
import json
import os
import sys
import time
import urllib.parse
import urllib.request

API = 'https://apis.data.go.kr/1741000/speed_bump_info/info'
ROWS = 100
# API 필드 → 파일 다운로드 CSV 머리글 (tools/build_bumps.py 가 읽는 이름)
COLS = [
    ('OPN_ATMY_GRP_CD', '개방자치단체코드'), ('MNG_NO', '관리번호'), ('SPDMDB_MNG_NO', '과속방지턱관리번호'), ('ROAD_NM', '도로명'),
    ('CTPV_NM', '시도명'), ('SGG_NM', '시군구명'), ('LCTN_ROAD_NM_ADDR', '소재지도로명주소'), ('LCTN_LOTNO_ADDR', '소재지지번주소'),
    ('INSTL_PLC', '설치장소'), ('SPDMDB_MATRL', '과속방지턱재료'), ('SPDMDB_SHP_SE', '과속방지턱형태구분'), ('SPDMDB_HGT', '과속방지턱높이'),
    ('SPDMDB_WDT', '과속방지턱폭'), ('SPDMDB_PRLG', '과속방지턱연장'), ('ROAD_TYPE_SE', '도로유형구분'), ('SPCFCT_YN', '규격여부'),
    ('WGS84_LAT', 'WGS84위도'), ('WGS84_LOT', 'WGS84경도'), ('MTRFC_SEPR_YN', '보차분리여부'), ('CNTNS_YN', '연속형여부'),
    ('SPDMDB_INSTL_YR', '과속방지턱설치연도'), ('MNG_INST_NM', '관리기관명'), ('MNG_INST_TELNO', '관리기관전화번호'),
    ('DAT_CRTR_YMD', '데이터기준일자'), ('DAT_UPDT_SE', '데이터갱신구분'), ('DAT_UPDT_PNT', '데이터갱신시점'), ('LAST_MDFCN_PNT', '최종수정시점'),
]


def get(key, page):
    qs = urllib.parse.urlencode({'serviceKey': key, 'pageNo': page, 'numOfRows': ROWS})
    for attempt in range(5):
        try:
            with urllib.request.urlopen(API + '?' + qs, timeout=60) as r:
                j = json.loads(r.read().decode('utf-8'))
            resp = j.get('response') or {}
            code = str((resp.get('header') or {}).get('resultCode', ''))
            if code not in ('0', '00'):
                raise RuntimeError('API %s %s' % (code, (resp.get('header') or {}).get('resultMsg') or j))
            b = resp.get('body') or {}
            items = (b.get('items') or {}).get('item') or []
            if isinstance(items, dict):
                items = [items]
            return int(b.get('totalCount') or 0), items
        except (OSError, ValueError, RuntimeError) as e:
            if attempt == 4:
                raise
            print('  retry page', page, type(e).__name__, str(e)[:80], file=sys.stderr, flush=True)
            time.sleep(3 + attempt * 5)


def main(out):
    key = os.environ.get('DATA_GO_KR_KEY', '').strip()
    if not key:
        sys.exit('DATA_GO_KR_KEY 환경변수에 공공데이터포털 인증키를 넣어 주세요')
    part = out + '.part.json'
    done = json.load(open(part, encoding='utf-8')) if os.path.exists(part) else {'pages': {}}
    total, first = get(key, 1)
    done['pages']['1'] = first
    pages = (total + ROWS - 1) // ROWS
    print('total', total, 'pages', pages, 'already', len(done['pages']), flush=True)
    for page in range(2, pages + 1):
        if str(page) in done['pages']:
            continue
        done['pages'][str(page)] = get(key, page)[1]
        if page % 50 == 0:
            json.dump(done, open(part, 'w', encoding='utf-8'), ensure_ascii=False)
            print('  page', page, '/', pages, flush=True)
        time.sleep(0.05)
    rows = [it for p in sorted(done['pages'], key=int) for it in done['pages'][p]]
    with open(out, 'w', encoding='utf-8-sig', newline='') as f:
        w = csv.writer(f)
        w.writerow([k for _, k in COLS])
        for it in rows:
            w.writerow(['' if it.get(a) is None else str(it.get(a)) for a, _ in COLS])
    if os.path.exists(part):
        os.remove(part)
    print('saved', len(rows), 'rows (total said', total, ') ->', out, flush=True)


if __name__ == '__main__':
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
