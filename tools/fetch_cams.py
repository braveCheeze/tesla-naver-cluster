"""경찰청 '전국무인교통단속카메라표준데이터'(data.go.kr 15028200)를 OpenAPI 로 받아, 파일 다운로드와 같은 CSV(cp949, 23열)로 저장한다.
build_cams.py · build_parking.py 에 그대로 넣는다 (2026-11-16 사용자 'API 받아주라').

    py -I -X utf8 tools/fetch_cams.py <저장할 CSV> [--compare <예전 CSV>] [--refetch]   (파일이 이미 있으면 받지 않고 비교만)
    py -I -X utf8 tools/build_cams.py <저장한 CSV> data/cameras.json
    py -I -X utf8 tools/build_parking.py <저장한 CSV> data/parking.json

인증키: 환경변수 DATA_GO_KR_KEY (Windows 는 사용자 환경변수 레지스트리 HKCU\\Environment 도 본다). 키는 출력·저장하지 않는다.
  data.go.kr 에서 이 데이터셋의 '활용신청'(자동승인)을 한 뒤 마이페이지의 일반 인증키를 사용자가 직접 넣는다.
  Encoding·Decoding 키 어느 쪽이든 된다('%' 가 있으면 이미 인코딩된 키로 본다).
요청: https://api.data.go.kr/openapi/tn_pubr_public_unmanned_traffic_camera_api ?serviceKey&pageNo&numOfRows(최대 1000)&type=json
  (개발계정 하루 10,000회. 전체 약 4만 5천 건이면 45번)
--compare: 관리번호로 예전 CSV 와 맞대어 늘어난·빠진·바뀐(좌표·단속구분·제한속도 등) 수를 보여 준다.
이 표준데이터는 정의상 이동식 단속카메라를 뺀다 (박스형·이동식은 build_mobile.py).
"""
import csv
import io
import json
import math
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

API = 'https://api.data.go.kr/openapi/tn_pubr_public_unmanned_traffic_camera_api'
FIELDS = ['mnlssRegltCameraManageNo', 'ctprvnNm', 'signguNm', 'roadKnd', 'roadRouteNo', 'roadRouteNm', 'roadRouteDrc', 'rdnmadr', 'lnmadr',
          'latitude', 'longitude', 'itlpc', 'regltSe', 'lmttVe', 'regltSctnLcSe', 'ovrspdRegltSctnLt', 'prtcareaType', 'installationYear',
          'institutionNm', 'phoneNumber', 'referenceDate', 'instt_code', 'instt_nm']
HEAD = ['무인교통단속카메라관리번호', '시도명', '시군구명', '도로종류', '도로노선번호', '도로노선명', '도로노선방향', '소재지도로명주소', '소재지지번주소',
        '위도', '경도', '설치장소', '단속구분', '제한속도', '단속구간위치구분', '과속단속구간길이', '보호구역구분', '설치연도', '관리기관명',
        '관리기관전화번호', '데이터기준일자', '제공기관코드', '제공기관명']
PER = 1000


def service_key():
    k = os.environ.get('DATA_GO_KR_KEY', '').strip()
    if not k and os.name == 'nt':
        try:
            import winreg
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, 'Environment') as h:
                k = str(winreg.QueryValueEx(h, 'DATA_GO_KR_KEY')[0]).strip()
        except OSError:
            k = ''
    if not k:
        sys.exit('DATA_GO_KR_KEY 가 없습니다. data.go.kr 에서 쓸 데이터셋(15028200 경찰청 표준데이터, 15111673 성남시 교통단속 카메라)을 활용신청한 뒤 인증키를 사용자 환경변수 DATA_GO_KR_KEY 로 넣어 주세요.')
    return k if '%' in k else urllib.parse.quote(k, safe='')


def page(key, no):
    qs = 'serviceKey=' + key + '&' + urllib.parse.urlencode({'pageNo': no, 'numOfRows': PER, 'type': 'json'})
    req = urllib.request.Request(API + '?' + qs, headers={'User-Agent': 'tesla-nav-build/1.0', 'Accept': 'application/json'})
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                raw = r.read().decode('utf-8', 'replace')
            break
        except urllib.error.HTTPError as e:      # 주소(키 포함)는 찍지 않는다
            err = 'HTTP %d' % e.code
        except (urllib.error.URLError, TimeoutError, OSError) as e:
            err = type(e).__name__
        time.sleep(2 + attempt * 3)
    else:
        sys.exit('page %d: %s (4번 시도)' % (no, err))
    try:
        doc = json.loads(raw)
    except ValueError:
        # 키 오류는 XML 로 온다: <returnAuthMsg>SERVICE_KEY_IS_NOT_REGISTERED_ERROR</returnAuthMsg>
        import re
        m = re.search(r'<(?:returnAuthMsg|resultMsg)>([^<]+)<', raw)
        sys.exit('page %d: JSON 이 아님 (%s)' % (no, m.group(1) if m else raw[:80].replace(key, '…')))
    res = doc.get('response', doc)
    head = res.get('header', {})
    if str(head.get('resultCode', '00')) not in ('00', '0'):
        if str(head.get('resultCode')) == '03':     # NODATA
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
            print('totalCount', total, 'pages', math.ceil(total / PER) if total else 0)
        rows += [[('' if it.get(f) is None else str(it.get(f)).strip()) for f in FIELDS] for it in items]
        if not items or len(rows) >= total:
            break
        no += 1
        time.sleep(0.3)
    if total and len(rows) != total:
        print('주의: 받은 행 %d / totalCount %d' % (len(rows), total))
    buf = io.StringIO()
    w = csv.writer(buf, lineterminator='\r\n')
    w.writerow(HEAD)
    w.writerows(rows)
    with open(out, 'wb') as fh:
        fh.write(buf.getvalue().encode('cp949', 'replace'))
    dates = {}
    for r in rows:
        dates[r[20]] = dates.get(r[20], 0) + 1
    print('wrote %s: %d rows, 데이터기준일자 %s' % (out, len(rows), sorted(dates.items(), key=lambda x: -x[1])[:4]))
    return out


def load(p):
    rows = list(csv.reader(io.StringIO(open(p, 'rb').read().decode('cp949', 'replace'))))[1:]
    return rows


def compare(new, old):
    a, b = load(old), load(new)
    key = lambda r: (r[0].strip(), r[18].strip())   # 관리번호 + 관리기관명 (기관마다 번호 체계가 달라 겹칠 수 있다)
    A, B = {}, {}
    for r in a:
        A.setdefault(key(r), r)
    for r in b:
        B.setdefault(key(r), r)
    added = [k for k in B if k not in A]
    removed = [k for k in A if k not in B]
    moved = changed = 0
    what = {}
    for k in B:
        if k not in A:
            continue
        x, y = A[k], B[k]
        diff = [HEAD[i] for i in range(min(len(x), len(y), 20)) if x[i].strip() != y[i].strip()]
        if diff:
            changed += 1
            for d in diff:
                what[d] = what.get(d, 0) + 1
            try:
                if abs(float(x[9]) - float(y[9])) > 1e-4 or abs(float(x[10]) - float(y[10])) > 1e-4:
                    moved += 1
            except ValueError:
                pass
    speed = lambda rs, ks: sum(1 for k in ks if '4' not in rs[k][12].replace(' ', '').split('+'))
    print('예전 %d행 → 새 %d행' % (len(a), len(b)))
    print('늘어남 %d (주정차 아닌 것 %d), 빠짐 %d (주정차 아닌 것 %d), 바뀜 %d (그중 10m 넘게 옮긴 것 %d)' % (
        len(added), speed(B, added), len(removed), speed(A, removed), changed, moved))
    print('바뀐 항목', sorted(what.items(), key=lambda x: -x[1])[:10])


if __name__ == '__main__':
    args = sys.argv[1:]
    if not args:
        sys.exit(__doc__)
    old = None
    if '--compare' in args:
        i = args.index('--compare')
        old = args[i + 1]
        del args[i:i + 2]
    refetch = '--refetch' in args
    args = [x for x in args if x != '--refetch']
    out = args[0]
    if refetch or not os.path.exists(out):
        fetch(out)
    if old:
        compare(out, old)
