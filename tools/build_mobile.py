"""박스형(단속 부스)·이동식 과속 단속 지점 → data/mobile.json (2026-11-15 요청 '박스형 과속단속 같은 것도 찾아보면 좋을듯')

경찰청 전국무인교통단속카메라표준데이터(data.go.kr 15028200)는 정의상 '이동식 무인교통단속카메라는 제외'라 박스형·이동식이 없다.
지방경찰청이 홈페이지에 공개한 목록을 받아 같은 행 모양(cameras.json 의 fields)으로 바꾼다. 앱이 cameras.json 뒤에 붙여 쓴다.

  py -I tools/build_mobile.py <받은 파일 폴더> [data/mobile.json]

폴더 안 파일 (각각 해당 경찰청 페이지에서 받는다. 조사 메모: side-session-notes 의 box-cameras-research.md):
  busan/camlist2.xlsx   부산경찰청 이동식 과속 단속 지점(단속부스 설치여부 O/X, 위도·경도, 제한속도) https://www.bspolice.go.kr/data/contents/camlist2.xlsx
  gn/nt5090_02.csv      경남경찰청 이동식 교통단속장비 운영장소(위도·경도, 방향)              https://www.gnpolice.go.kr/data.do?file=nt5090_02.csv
  ggb/ggb.pdf           경기북부경찰청 무인교통단속장비 PDF 58~64쪽 '이동식 장비리스트'(부스 273곳, 경도·위도)
                        https://www.ggbpolice.go.kr/commons/main/files/ggpolice_cctv(261031).pdf
  ggn/ggn.xls           경기남부경찰청 고속도로순찰대 '이동형 단속 부스'(43곳, 경도·위도, 전부 부스. Referer 헤더가 있어야 받아짐)
                        https://ggpolice.go.kr/include/main/files/고속도로순찰대_이동형 단속 부스.xls
  seoul/seoul.json      서울경찰청 '이동식 단속 사전 예고지점'(PDF 240곳, 좌표 없음)을 tools/geo_mobile_seoul.py 로 좌표를 붙인 것
                        (원본 https://www.smpa.go.kr/user/nd41940.do?View&boardNo=00037233 첨부 '이동식사전예고지점.pdf')
                        v149 (2026-11-16 사용자 '넣어 줘')
  gj/gj.xlsx            광주경찰청 '광주지역 무인 및 이동식 단속장소 안내' zip 안의 '이동식 단속 및 단속부스 설치 지점.xlsx' 하나만
                        (182곳, 위도·경도, 부스 O/X). 같은 zip 의 다른 엑셀에는 장비 내부 정보 시트가 있어 꺼내지도 쓰지도 않는다
                        https://gjpolice.go.kr/cmm/fms/FileDown.do?atchFileId=FILE_000000000010058&fileSn=9
  gw/points.json        강원경찰청 '이동식 단속 지점 현황(26.11월).xls'(281곳)·'스쿨존 현황' 이동식 시트(8곳), 주소만 → tools/geo_mobile_addr.py gw
                        https://www.gwpolice.go.kr/gw/sub05/sub05_02_04.jsp ('강원도내 무인단속장비 운영 장소 알림' 첨부 f_no=2, 3)
  jn/points.json        전남경찰청 '이동식장비,암행단속 현황.XLS'(748곳, 주소만) → tools/geo_mobile_addr.py jn
                        https://www.jnpolice.go.kr/index.jsp?pid=AP0301&mode=view&bbsId=sub0301&bbsBid=441646
  cb/points.json        data.go.kr 15141314 충북경찰청 이동식 단속 카메라 설치장소(420곳, 경도·위도, 부스 유무) → tools/geo_mobile_addr.py cb (좌표 확인)
  us/*.xlsx             울산 경찰서별 '이동식 단속 사전 예고지점'(좌표 있음): 북부(47, 2025-07)·동부(7, 2024-09, 위도·경도 칸이 바뀜)·
                        남부 Sheet2(23, 2026-10)·중부(17, 2024-09, '.cell' 이름의 엑셀, '129.262.949' 처럼 점이 하나 더)
                        https://www.uspolice.go.kr/<서>/board.jsp (각 경찰서 공지)
  dg/points.json        대구 경찰서별 '이동식 단속 사전 예고장소'(중부·동부·남부·성서·달서 엑셀, 달성 PDF) → tools/geo_mobile_addr.py dg
  usa/points.json       울산 울주서(85곳)·남부서 Sheet1(20곳), 주소만 → tools/geo_mobile_addr.py usa
  jb/jb.xls             전북경찰청 '이동식무인교통단속카메라단속장소현황(2026.11.13).xls' (275곳, 경도·위도 순서, 부스 표시 없음)
                        https://www.jbpolice.go.kr/board/view.police?boardId=BBS_0000008&menuCd=DOM_000000202001000000&dataSid=233936
  (광주경찰청 zip 은 내부 장비 정보 시트가 섞여 있어 쓰지 않는다)

규칙
- 부스(경기북부 전부, 부산 'O') → 과속단속 + 박스형(flags 2). 부스 없는 이동식(경남, 부산 'X') → 이동식단속(kind 8, 파란색)
- 제한속도: 원본 값, 없으면 가까운 고정 과속 카메라(일반도로 600m·고속도로 2km 안)의 제한속도, 그것도 없으면 0(모름: 앱은 '?' 로 보여 주고 과속 판단·음성 숫자는 뺀다)
  v159: 설치장소가 '○○고속도로 12.3k'·'○○선 106.3k' 로 시작하는 고속도로 지점은 같은 고속도로 고정 카메라(15km 안, 80 이상) 값, 없으면 100
  (예전 규칙은 옆 일반도로 값 50·60 을 빌려 왔다: 판교JC 1.25k '박스형 60' 틀림, 송파IC 10.3k 50 놓침)
- unflag: 예전 파일과 같은 자리인데 제한속도·종류가 바뀐 지점 목록. 앱이 운전자의 예전 '틀림'(그 방향 숨김)을 한 번 푼다
- 중복: 서로 30m 안이면 하나로, 고정 카메라 30m 안이면 뺀다(이미 있음), 직접 넣은 U0002(팔당) 120m 안이면 뺀다(경기북부 109번이 95m)
- 방향: 설치장소의 '(A→B)'·'A→B방향' → 한 방향(dir 1) + arrows(앱이 안내 문구와 맞춰 반대 방향을 거른다), 없으면 양방향
  v164: 같은 자리를 반대 방향으로 따로 적은 두 줄과 '(A↔B)' 는 방향마다 한 행으로 두고 pairs 로 묶는다(osm_cams 가 서로 반대 방향 차로에 붙인다)
- v164 고속도로 지점: '○○고속도로 12.3k'·'○○선 106.3k'·'경부선 307.6'(단위 없음) 으로 시작하거나 '○○고속도로 (방향) 26.5km' 가 든 것만
  ('경인고속입구'·'해안문 1.1km지점' 같은 일반도로는 아니다). 고속도로 본선 위인데 글로 몰랐던 곳은 cam_fill.py 가 OSM 으로 고친다
- v164 어린이보호구역 지점(원본에 제한 없음): 300m 안 보호구역 고정 카메라 값, 없으면 30 (예전엔 보호구역이 아닌 카메라 값 50~80)
- v164 경기북부 PDF: 이동식 목록 머리줄('설치장소 … 경도 위도') 다음부터 읽는다 (고정식 표가 부스 1번에 붙어 'GGB-1384 어린이보호구역 50')
- 도로 이름은 원본에 주소뿐이라 모름(-1): 앱은 이름이 다르지 않은 것으로 본다
"""
import csv
import io
import json
import math
import os
import re
import sys
from datetime import date

sys.path.insert(0, r'D:\pylib')   # pypdf·xlrd

SRC = sys.argv[1]
OUT = sys.argv[2] if len(sys.argv) > 2 else os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'data', 'mobile.json')
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

ARROW_PAREN = re.compile(r'\(([^()]*?(?:→|->|↔|-&gt;)[^()]*?)\)')
ARROW_SPLIT = re.compile(r'\s*(?:→|->|-&gt;)\s*')


def arrow_ends(place):
    m = ARROW_PAREN.findall(place)
    seg = m[-1] if m else place
    if '↔' in seg:
        # v164: 'A↔B' 는 한 자리에서 두 방향을 찍는다 → ('both', A, B). 아래에서 방향마다 한 행(짝)으로 만든다
        parts = [re.sub(r'(방면|방향|쪽|진행)$', '', re.sub(r'\s+', '', x).lower()) for x in seg.split('↔')]
        parts = [re.sub(r'^.*\s', '', e) for e in parts]
        return ('both',) + tuple(parts) if len(parts) == 2 and all(len(e) >= 2 for e in parts) else 'both'
    parts = ARROW_SPLIT.split(seg)
    if len(parts) != 2:
        return None
    ends = [re.sub(r'(방면|방향|쪽|진행)$', '', re.sub(r'\s+', '', x).lower()) for x in parts]
    ends = [re.sub(r'^.*\s', '', e) for e in ends]
    return tuple(ends) if all(len(e) >= 2 for e in ends) else None


def hav(a, b):
    R, k = 6371000, math.pi / 180
    x = math.sin((b[0] - a[0]) * k / 2) ** 2 + math.cos(a[0] * k) * math.cos(b[0] * k) * math.sin((b[1] - a[1]) * k / 2) ** 2
    return 2 * R * math.asin(math.sqrt(x))


pts = []   # dict(src, id, lat, lng, text, booth, limit)


def ok_coord(lat, lng):
    if 124 < lat < 132 and 33 < lng < 39:   # 위도·경도가 바뀐 줄
        lat, lng = lng, lat
    return (lat, lng) if 33 < lat < 39 and 124 < lng < 132 else None


def num(x):
    try:
        return float(str(x).strip())
    except (TypeError, ValueError):
        return None


def fixdeg(v, lo, hi):
    """소수점이 빠진 좌표('126872284', '350840400')를 범위에 맞게 되살린다. 못 하면 None"""
    if v is None:
        return None
    if lo <= v <= hi:
        return v
    if v > 1000:
        d = str(int(round(v)))
        for k in (2, 3):
            x = float(d[:k] + '.' + d[k:])
            if lo <= x <= hi:
                return x
    return None


def in_box(c, box):
    return box[0] <= c[0] <= box[2] and box[1] <= c[1] <= box[3]


# 부산: 머리 3줄 뒤 [연번, 지방청, 관할서, 서별연번, ID, 단속지점 및 방향, 도로구분, 부스(O/X), 위도, 경도, 제한속도, …]
p = os.path.join(SRC, 'busan', 'camlist2.xlsx')
if os.path.exists(p):
    import openpyxl
    ws = openpyxl.load_workbook(p, read_only=True, data_only=True).worksheets[0]
    for r in ws.iter_rows(values_only=True):
        if not r or not isinstance(r[0], (int, float)) or not r[4]:
            continue
        c = ok_coord(num(r[8]) or 0, num(r[9]) or 0)
        if not c:
            continue
        pts.append({'src': 'busan', 'id': str(r[4]).strip(), 'lat': c[0], 'lng': c[1], 'text': str(r[5] or ''),
                    'booth': str(r[7] or '').strip().upper() == 'O', 'limit': int(num(r[10]) or 0),
                    'school': '스쿨' in str(r[6] or '') or '어린이' in str(r[5] or '')})

# 경남: [연번, 경찰청, 관할서, ID, 단속지점 및 방향, 도로구분, …빈 열…, 위도, 경도] (빈 열이 많아 숫자 두 개를 뒤에서 찾는다)
p = os.path.join(SRC, 'gn', 'nt5090_02.csv')
if os.path.exists(p):
    for r in csv.reader(io.StringIO(open(p, 'rb').read().decode('utf-8-sig', 'replace'))):
        if not r or not r[0].strip().isdigit():
            continue
        vals = [num(x) for x in r[5:]]
        nums = [v for v in vals if v is not None and 30 < v < 135]
        if len(nums) < 2:
            continue
        c = ok_coord(nums[0], nums[1])
        if not c:
            continue
        pts.append({'src': 'gn', 'id': r[3].strip(), 'lat': c[0], 'lng': c[1], 'text': r[4], 'booth': False, 'limit': 0,
                    'school': '어린이' in r[4] or '스쿨' in r[4]})

# 경기북부: PDF 58~64쪽. 줄: '연번 설치장소(방향) 관할서 경도 위도' (경도와 위도가 붙어 나오기도 함: 127.2567337.54048)
p = os.path.join(SRC, 'ggb', 'ggb.pdf')
if os.path.exists(p):
    sys.path[:0] = [os.path.join(os.path.dirname(SRC), 'pylib'), r'D:\pylib']
    from pypdf import PdfReader
    pdf = PdfReader(p)
    COORD = re.compile(r'(12[4-9]\.\d+?)\s*(3[3-8]\.\d{3,})\s*$')
    buf = ''
    # v164: 이동식 목록은 머리줄 '연번 설치장소(약칭) 관할서 경도 위도' 다음부터. 예전엔 57쪽(고정식 '다기능 장비리스트' 끝)부터 읽어서
    # 그 표의 줄들(연번으로 시작, 좌표 없음)이 다음 쪽 부스 1번 줄에 붙었다: 부스 1번(수도권제1순환고속도로 23.5k)이 'GGB-1384' 가 되고
    # 글에 '어람초교 어린이보호구역'이 섞여 고속도로 위 '어린이보호구역 50' 이 됐다
    started = False
    for pg in range(56, len(pdf.pages)):
        for line in (pdf.pages[pg].extract_text() or '').splitlines():
            line = line.strip()
            if not line:
                continue
            if not started:
                started = '설치장소' in line and '경도' in line and '위도' in line
                continue
            buf = (buf + ' ' + line).strip() if buf else line
            m = COORD.search(buf)
            if not m:
                if not re.match(r'^\d+\s', buf):
                    buf = ''
                continue
            head = buf[:m.start()].strip()
            n = re.match(r'^(\d+)\s+(.*)$', head)
            buf = ''
            if not n:
                continue
            body = n.group(2)
            body = re.sub(r'\s+\S*(?:지구대|경찰서|교통과)\s*$', '', body)
            c = ok_coord(float(m.group(2)), float(m.group(1)))
            if not c:
                continue
            pts.append({'src': 'ggb', 'id': 'GGB-' + n.group(1), 'lat': c[0], 'lng': c[1], 'text': body, 'booth': True, 'limit': 0,
                        'school': '어린이' in body or '스쿨' in body})

# 경기남부(고속도로순찰대): xls [연번, 지구대, 설치장소(약칭)=ID, 설치장소('영동고속도로 20.8k (주소) (인천->강릉)'), 도로구분,
#   부스 유무, 경도, 위도, 비고]
p = os.path.join(SRC, 'ggn', 'ggn.xls')
if os.path.exists(p):
    import xlrd
    sh = xlrd.open_workbook(p).sheets()[0]
    for i in range(1, sh.nrows):
        r = [c.value for c in sh.row(i)]
        if len(r) < 8 or not str(r[2]).strip():
            continue
        c = ok_coord(num(r[7]) or 0, num(r[6]) or 0)
        if not c:
            continue
        text = str(r[3])
        pts.append({'src': 'ggn', 'id': str(r[2]).strip(), 'lat': c[0], 'lng': c[1], 'text': text, 'booth': '부스' in str(r[5]),
                    'limit': 0, 'school': '어린이' in text or '스쿨' in str(r[4])})

# 광주: xlsx (read_only 로만 열린다). 머리 4줄 뒤 [_, 연번, 지방청, 관할서, ID, 단속지점 및 단속방향, 도로구분, 부스, 위도, 경도].
#   부스 칸: O·○·'0 (간이)'·'O(설치)' 등 = 부스, X·× = 없음. 광주 둘레(위도 35.0~35.3, 경도 126.6~127.05) 밖 좌표는 뺀다(3곳이 엉뚱한 곳)
p = os.path.join(SRC, 'gj', 'gj.xlsx')
if os.path.exists(p):
    import openpyxl
    ws = openpyxl.load_workbook(p, read_only=True, data_only=True).worksheets[0]
    for k, r in enumerate(ws.iter_rows(values_only=True)):
        if k < 4 or not r or len(r) < 10 or not r[4]:
            continue
        lat, lng = fixdeg(num(r[8]), 33, 39), fixdeg(num(r[9]), 124, 132)
        c = ok_coord(lat or 0, lng or 0)
        if not c or not in_box(c, (35.0, 126.6, 35.3, 127.05)):
            continue
        b = str(r[7] or '').strip().upper()
        pts.append({'src': 'gj', 'id': str(r[4]).strip(), 'lat': c[0], 'lng': c[1], 'text': str(r[5] or ''),
                    'booth': b[:1] in ('O', '○', '0'), 'limit': 0, 'school': '스쿨' in str(r[6] or '') or '어린이' in str(r[5] or '')})

# 전북: xls 시트 '이동식', 머리줄 8번째 줄 [연번, 관할, 단속장소, 경도, 위도, 연락처, 비고]. 경도가 먼저. 전북 둘레 밖 좌표(오타)는 뺀다
p = os.path.join(SRC, 'jb', 'jb.xls')
if os.path.exists(p):
    import xlrd
    sh = xlrd.open_workbook(p).sheets()[0]
    for i in range(8, sh.nrows):
        r = [c.value for c in sh.row(i)]
        if len(r) < 5 or not str(r[2]).strip():
            continue
        lng, lat = fixdeg(num(r[3]), 124, 132), fixdeg(num(r[4]), 33, 39)
        c = ok_coord(lat or 0, lng or 0)
        if not c or not in_box(c, (35.25, 126.35, 36.2, 127.95)):
            continue
        text = str(r[2])
        pts.append({'src': 'jb', 'id': 'JB-%d' % int(num(r[0]) or i), 'lat': c[0], 'lng': c[1], 'text': text, 'booth': False, 'limit': 0,
                    'school': '어린이' in text or '스쿨' in text})

# 울산(좌표 있는 경찰서 파일 네 개). 칸 번호: (ID, 글, 도로구분, 부스, 위도, 경도, 머리 줄 수). 위도·경도가 바뀐 파일은 ok_coord 가 바로잡는다
US = {'bukbu.xlsx': (2, 3, 4, 5, 7, 6, 1), 'dongbu.xlsx': (3, 4, 5, 6, 7, 8, 3), 'jungbu.xlsx': (3, 4, 5, 6, 8, 7, 1)}


def us_deg(v):
    t = str(v or '').strip()
    if t.count('.') > 1:                      # '129.262.949' → 129.262949
        a, b = t.split('.', 1)
        t = a + '.' + b.replace('.', '')
    return num(t)


for fn, (ci, ct, ck, cb_, cla, clo, skip) in list(US.items()) + [('nambu.xlsx', (2, 3, 4, 5, 6, 7, 3))]:
    p = os.path.join(SRC, 'us', fn)
    if not os.path.exists(p):
        continue
    import openpyxl
    wb = openpyxl.load_workbook(p, read_only=True, data_only=True)
    ws = next((w for w in wb.worksheets if w.title.strip() == 'Sheet2'), None) if fn == 'nambu.xlsx' else wb.worksheets[0]
    for r in list(ws.iter_rows(values_only=True))[skip:] if ws else []:
        r = ['' if c is None else str(c) for c in r]
        if len(r) <= max(cla, clo) or not r[ci].strip().startswith('울산-'):
            continue
        c = ok_coord(us_deg(r[cla]) or 0, us_deg(r[clo]) or 0)
        if not c or not in_box(c, (35.30, 128.95, 35.75, 129.50)):
            continue
        b = r[cb_].strip().upper()
        pts.append({'src': 'us', 'id': r[ci].strip(), 'lat': c[0], 'lng': c[1], 'text': r[ct], 'booth': b[:1] in ('O', '○') or b == '부스',
                    'limit': 0, 'school': '스쿨' in r[ck] or '어린이' in r[ct]})

# 서울(tools/geo_mobile_seoul.py)·강원·전남(tools/geo_mobile_addr.py): 주소로 좌표를 붙인 지점 (확실한 것만. 뺀 것은 각 파일의 skipped)
for rel in ('seoul/seoul.json', 'gw/points.json', 'jn/points.json', 'cb/points.json', 'dg/points.json', 'usa/points.json'):
    p = os.path.join(SRC, *rel.split('/'))
    if os.path.exists(p):
        for q in json.load(open(p, encoding='utf-8'))['points']:
            pts.append({k: q[k] for k in ('src', 'id', 'lat', 'lng', 'text', 'booth', 'limit', 'school')})

# v165: 좌표가 설치장소 글의 주소와 크게 다른 부스는 그 주소 자리로 (tools/geo_fix_mobile.py → tools/mobile_coords_fix.json).
# 경기북부 PDF 'GGB-33 서울양양고속도로 19.8K (양평군 서종면 문호리 586-5)' 의 좌표가 광주시(25km 밖)였다. 글이 그대로일 때만 쓴다
if '--dump-points' in sys.argv:
    with open(sys.argv[sys.argv.index('--dump-points') + 1], 'w', encoding='utf-8') as fh:
        json.dump(pts, fh, ensure_ascii=False)
    sys.exit(0)
try:
    MFIX = json.load(open(os.path.join(ROOT, 'tools', 'mobile_coords_fix.json'), encoding='utf-8'))['fix']
except (OSError, ValueError, KeyError):
    MFIX = {}
_mfixed = 0
for p_ in pts:
    f_ = MFIX.get(p_['src'] + '|' + p_['id'])
    if f_ and f_.get('text') == p_['text'][:80]:
        p_['lat'], p_['lng'] = f_['lat'], f_['lng']
        _mfixed += 1

# 고정 카메라 (cameras.json): 중복 빼기·제한속도 빌리기
cam = json.load(open(os.path.join(ROOT, 'data', 'cameras.json'), encoding='utf-8'))
fixed = cam['rows']
grid = {}
for i, c in enumerate(fixed):
    grid.setdefault((int(c[0] * 100), int(c[1] * 100)), []).append(i)


def near_fixed(lat, lng, radius):
    out = []
    gy, gx = int(lat * 100), int(lng * 100)
    span = max(1, int(radius / 900) + 1)
    for dy in range(-span, span + 1):
        for dx in range(-span, span + 1):
            for i in grid.get((gy + dy, gx + dx), []):
                d = hav((lat, lng), (fixed[i][0], fixed[i][1]))
                if d <= radius:
                    out.append((d, fixed[i]))
    return sorted(out, key=lambda x: x[0])


fixed_roads = cam.get('roads') or []
# v159 (2026-11-16~19 놓침·틀림 신고): 고속도로 위 부스·이동식 지점의 제한속도. 원본에 값이 없으면 예전엔 가까운 고정 카메라(2km 안)를 빌려서
# 옆·아래 일반도로 값(30~70)이 들어갔다(판교JC 1.25k '박스형 60', 송파IC 10.3k 50 → 앱은 고속도로 위 저속 카메라로 보고 틀림·놓침).
# 설치장소가 '○○고속도로 12.3k'·'○○선 106.3k' 처럼 노선 이름 + 이정으로 시작하면 같은 고속도로 고정 카메라(15km 안, 제한 80 이상)의 값,
# 없으면 가까운 고속국도 카메라(3km 안), 그것도 없으면 100.
HWY_HEAD = re.compile(r'^\s*([가-힣A-Za-z0-9]+?(?:고속도로|고속국도|선))\s*(?:\([^)]*\))?\s*(?:제\d지선\s*)?(?:[가-힣]+방향\s*)?\d+(?:\.\d+)?\s*(?:km|k|K)')
# v164: 단위 없는 이정 '경부선 307.6(상행)-청주 흥덕 강내 학천리' (충북경찰청 목록 74곳). v159 식은 k 단위가 있어야 해서 못 잡아
# 도로 종류 4·제한 0(65곳) 또는 옆 길 값 50~70(9곳)이 되었고, 앱의 '고속도로 위 70 이하 일반도로 카메라 빼기'에 걸려 안 떴다 (CB-2·CB-4·CB-18·CB-52)
HWY_HEAD2 = re.compile(r'^\s*([가-힣]{2,}(?:선|고속도로|고속국도))\s*(?:\([^)]*\)\s*)?\d+\.\d+\s*(?:\(|$|-|\s)')


def hwy_head(text):
    return HWY_HEAD.match(text) or HWY_HEAD2.match(text)


def hwy_key(name):
    s = re.sub(r'\(.*?\)', '', re.sub(r'\s+', '', name or ''))
    s = s.replace('서울외곽순환', '수도권제1순환')
    s = re.sub(r'(고속도로|고속국도|선)$', '', s)
    return re.sub(r'제(?=\d)', '', s)


def hwy_limit(lat, lng, name):
    key = hwy_key(name)
    near = [(d, c) for d, c in near_fixed(lat, lng, 15000) if c[8] == 1 and c[2] >= 80]
    for d, c in near:
        if c[7] >= 0 and c[7] < len(fixed_roads) and hwy_key(fixed_roads[c[7]]) == key:
            return c[2]
    for d, c in near:
        if d <= 3000:
            return c[2]
    return 100


U0002 = (37.53968, 127.25632)
rows, arrows, names, name_idx, pairs = [], [], [], {}, []
stats = {'in': len(pts), 'dup_self': 0, 'dup_fixed': 0, 'dup_manual': 0, 'no_limit': 0, 'hwy_limit': 0, 'school_limit': 0,
         'pairs_reversed': 0, 'pairs_two_way': 0}
kept = []
# v164: 고속도로 지점 = 설치장소가 '○○고속도로 12.3k'·'○○선 106.3k'·'경부선 307.6' 로 시작하거나 '○○고속도로 (방향) 26.5km' 가 들어 있는 것.
# 예전 규칙('고속'이 들어 있거나 숫자 뒤 k)은 '경인고속입구'(선유로 30, SEOUL-179)·'해안문 1.1km지점'(아산로 50, 울산북부-8) 같은
# 일반도로 13곳을 고속도로로 보았다
HWY_IN = re.compile(r'(?:고속도로|고속국도)\s*(?:\([^)]*\)\s*)?(?:[가-힣]+방향\s*)?\d+(?:\.\d+)?\s*(?:km|k|K)')


def one_way(e):
    return isinstance(e, tuple) and e[0] != 'both'


def add_row(p_, limit, hwy, ends):
    global arrows
    one = one_way(ends)
    row = [round(p_['lat'], 6), round(p_['lng'], 6), int(limit), 1 if p_['booth'] else 8, 0, 0, 2 if p_['school'] else 0, -1,
           1 if hwy else 4, 1 if one else 3, 2 if p_['booth'] else 0]
    if one:
        for e in ends:
            if e not in name_idx:
                name_idx[e] = len(names)
                names.append(e)
        arrows += [len(rows), name_idx[ends[0]], name_idx[ends[1]]]
    rows.append(row)
    return len(rows) - 1


def limit_for(p_):
    xw = hwy_head(p_['text'])
    hwy = bool(xw) or bool(HWY_IN.search(p_['text']))
    limit = p_['limit']
    if not limit and xw:
        limit = hwy_limit(p_['lat'], p_['lng'], xw.group(1))
        stats['hwy_limit'] += 1
    if not limit and p_['school'] and not hwy:
        # v164: 어린이보호구역 지점은 둘레 보호구역 고정 카메라(300m 안) 값, 없으면 30. 예전엔 보호구역이 아닌 고정 카메라 값만 빌려 와서
        # 보호구역 95곳이 50~80 이었다 (송추초 정문 GGB-151 50, 새별초교 광주광산-7 60)
        zc = [c for d, c in near_fixed(p_['lat'], p_['lng'], 300) if c[3] in (1, 3) and c[2] > 0 and c[6] == 2]
        limit = zc[0][2] if zc else 30
        stats['school_limit'] += 1
    if not limit:
        cand = [c for d, c in near_fixed(p_['lat'], p_['lng'], 2000 if hwy else 600) if c[3] in (1, 3) and c[2] > 0 and c[6] == 0
                and (c[8] == 1) == hwy]
        limit = cand[0][2] if cand else 0
    if not limit:
        stats['no_limit'] += 1
    return limit, hwy


for p_ in pts:
    dup = next((q for q in kept if hav((p_['lat'], p_['lng']), (q['lat'], q['lng'])) < 30), None)
    if dup is not None:
        # 같은 자리를 반대 방향으로 따로 적은 줄('(A→B)'·'(B→A)'): v151 은 남긴 줄을 양방향(3) 하나로 합쳤는데 OSM 방향이 하나뿐이라
        # 94곳 중 51곳은 반대 방향이 안 떴다(부산해운대-47 등). v164: 방향마다 한 행으로 두고 짝(pairs)으로 묶는다
        e1, e2 = arrow_ends(p_['text']), dup['_ends']
        if one_way(e1) and one_way(e2) and e1 == e2[::-1] and dup.get('_twin') is None:
            limit, hwy = limit_for(p_)
            r = add_row(p_, limit, hwy, e1)
            pairs += [dup['_row'], r]
            dup['_twin'] = r
            p_['_row'], p_['_ends'], p_['_twin'] = r, e1, dup['_row']
            kept.append(p_)
            stats['pairs_reversed'] += 1
            continue
        stats['dup_self'] += 1
        continue
    if any(d < 30 and c[3] in (1, 3) for d, c in near_fixed(p_['lat'], p_['lng'], 30)):
        stats['dup_fixed'] += 1
        continue
    if hav((p_['lat'], p_['lng']), U0002) < 120:
        stats['dup_manual'] += 1
        continue
    limit, hwy = limit_for(p_)
    ends = arrow_ends(p_['text'])
    p_['_ends'] = ends
    if isinstance(ends, tuple) and ends[0] == 'both':
        # 'A↔B': 한 자리에서 두 방향을 찍는다 → 방향마다 한 행 (짝)
        r1 = add_row(p_, limit, hwy, (ends[1], ends[2]))
        r2 = add_row(p_, limit, hwy, (ends[2], ends[1]))
        pairs += [r1, r2]
        p_['_row'], p_['_twin'] = r1, r2
        stats['pairs_two_way'] += 1
    else:
        p_['_row'] = add_row(p_, limit, hwy, ends)
    kept.append(p_)

by = {}
for p_ in kept:
    k = p_['src'] + (' 부스' if p_['booth'] else ' 이동식')
    by[k] = by.get(k, 0) + 1
out = {'v': 1, 'date': date.today().isoformat(), 'count': len(rows), 'fields': cam['fields'], 'roads': [],
       'sources': {'busan': '부산경찰청 이동식 과속 단속 지점 2026-10-13', 'gn': '경남경찰청 이동식 교통단속장비 운영장소 2026-11-01',
                   'ggb': '경기북부경찰청 이동식 장비 단속부스 2026-10-31',
                   'ggn': '경기남부경찰청 고속도로순찰대 이동형 단속 부스 (2026-11-16 받음)',
                   'seoul': '서울경찰청 이동식 단속 사전 예고지점 2026-10-28 (주소·장소를 좌표로 바꾼 것)',
                   'gj': '광주경찰청 이동식 단속 및 단속부스 설치 지점 (2026-09-15 파일)',
                   'jb': '전북경찰청 이동식 무인교통단속카메라 단속장소 2026-11-13',
                   'gw': '강원경찰청 이동식 단속 지점 현황(26.11월)·스쿨존 이동식 (주소를 좌표로 바꾼 것)',
                   'jn': '전남경찰청 이동식장비·암행단속 현황 2026-03-06 (주소를 좌표로 바꾼 것)',
                   'us': '울산 북부·동부·남부·중부경찰서 이동식 단속 사전 예고지점 (2024-09~2026-10)',
                   'dg': '대구 중부·동부·남부·성서·달서·달성경찰서 이동식 단속 사전 예고장소 (2026-04~07, 주소를 좌표로 바꾼 것)',
                   'usa': '울산 울주·남부경찰서 이동식 단속 지점 (2025-08·2026-10, 주소를 좌표로 바꾼 것)',
                   'cb': '충북경찰청 이동식 단속 카메라 설치장소 (data.go.kr 15141314, 2025-05-14 수정, 주소와 1km 넘게 다른 좌표는 뺌)'},
       'rows': rows, 'arrowNames': names, 'arrows': arrows, 'pairs': pairs}
# v159: 예전 파일과 같은 자리인데 제한속도·종류가 바뀐 지점은 운전자가 예전에 누른 '틀림'(이 방향 숨김)을 앱이 한 번 푼다.
# 틀린 값 때문에 누른 틀림이라 고친 뒤에도 계속 숨기면 그대로 놓친다 (2026-11-18 송파IC 10.3k)
try:
    old = json.load(open(OUT, encoding='utf-8'))
    was = {(r[0], r[1]): (r[2], r[3]) for r in old.get('rows', [])}
    keys = ['%s,%s' % (json.dumps(r[0]), json.dumps(r[1])) for r in rows if (r[0], r[1]) in was and was[(r[0], r[1])] != (r[2], r[3])]
    if keys:
        out['unflag'] = {'id': out['date'] + '-' + str(len(keys)), 'keys': keys}
    elif old.get('unflag'):
        out['unflag'] = old['unflag']
except (OSError, ValueError):
    pass
with open(OUT, 'w', encoding='utf-8') as fh:
    json.dump(out, fh, ensure_ascii=False, separators=(',', ':'))
print(json.dumps(dict(stats, kept=len(rows), by=by, one_way=len(arrows) // 3, coords_from_address=_mfixed), ensure_ascii=False))
