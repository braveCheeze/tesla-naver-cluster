"""박스형(단속 부스)·이동식 과속 단속 지점 → data/mobile.json (2026-11-15 요청 '박스형 과속단속 같은 것도 찾아보면 좋을듯')

경찰청 전국무인교통단속카메라표준데이터(data.go.kr 15028200)는 정의상 '이동식 무인교통단속카메라는 제외'라 박스형·이동식이 없다.
지방경찰청이 홈페이지에 공개한 목록을 받아 같은 행 모양(cameras.json 의 fields)으로 바꾼다. 앱이 cameras.json 뒤에 붙여 쓴다.

  py -I tools/build_mobile.py <받은 파일 폴더> [data/mobile.json]

폴더 안 파일 (각각 해당 경찰청 페이지에서 받는다. 조사 메모: side-session-notes 의 box-cameras-research.md):
  busan/camlist2.xlsx   부산경찰청 이동식 과속 단속 지점(단속부스 설치여부 O/X, 위도·경도, 제한속도) https://www.bspolice.go.kr/data/contents/camlist2.xlsx
  gn/nt5090_02.csv      경남경찰청 이동식 교통단속장비 운영장소(위도·경도, 방향)              https://www.gnpolice.go.kr/data.do?file=nt5090_02.csv
  ggb/ggb.pdf           경기북부경찰청 무인교통단속장비 PDF 58~64쪽 '이동식 장비리스트'(부스 273곳, 경도·위도)
                        https://www.ggbpolice.go.kr/commons/main/files/ggpolice_cctv(261031).pdf
  (광주경찰청 zip 은 내부 장비 정보 시트가 섞여 있어 쓰지 않는다)

규칙
- 부스(경기북부 전부, 부산 'O') → 과속단속 + 박스형(flags 2). 부스 없는 이동식(경남, 부산 'X') → 이동식단속(kind 8, 파란색)
- 제한속도: 원본 값, 없으면 가까운 고정 과속 카메라(일반도로 600m·고속도로 2km 안)의 제한속도, 그것도 없으면 0(모름: 앱은 '?' 로 보여 주고 과속 판단·음성 숫자는 뺀다)
- 중복: 서로 30m 안이면 하나로, 고정 카메라 30m 안이면 뺀다(이미 있음), 직접 넣은 U0002(팔당) 120m 안이면 뺀다(경기북부 109번이 95m)
- 방향: 설치장소의 '(A→B)'·'A→B방향' → 한 방향(dir 1) + arrows(앱이 안내 문구와 맞춰 반대 방향을 거른다), 없으면 양방향
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

SRC = sys.argv[1]
OUT = sys.argv[2] if len(sys.argv) > 2 else os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'data', 'mobile.json')
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

ARROW_PAREN = re.compile(r'\(([^()]*?(?:→|->|↔|-&gt;)[^()]*?)\)')
ARROW_SPLIT = re.compile(r'\s*(?:→|->|-&gt;)\s*')


def arrow_ends(place):
    m = ARROW_PAREN.findall(place)
    seg = m[-1] if m else place
    if '↔' in seg:
        return 'both'
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
    sys.path.insert(0, os.path.join(os.path.dirname(SRC), 'pylib'))
    from pypdf import PdfReader
    pdf = PdfReader(p)
    COORD = re.compile(r'(12[4-9]\.\d+?)\s*(3[3-8]\.\d{3,})\s*$')
    buf = ''
    for pg in range(56, len(pdf.pages)):
        for line in (pdf.pages[pg].extract_text() or '').splitlines():
            line = line.strip()
            if not line:
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


U0002 = (37.53968, 127.25632)
rows, arrows, names, name_idx = [], [], [], {}
stats = {'in': len(pts), 'dup_self': 0, 'dup_fixed': 0, 'dup_manual': 0, 'no_limit': 0}
kept = []
for p_ in pts:
    if any(hav((p_['lat'], p_['lng']), (q['lat'], q['lng'])) < 30 for q in kept):
        stats['dup_self'] += 1
        continue
    if any(d < 30 and c[3] in (1, 3) for d, c in near_fixed(p_['lat'], p_['lng'], 30)):
        stats['dup_fixed'] += 1
        continue
    if hav((p_['lat'], p_['lng']), U0002) < 120:
        stats['dup_manual'] += 1
        continue
    hwy = '고속' in p_['text'] or bool(re.search(r'\d+(\.\d+)?\s*k', p_['text']))
    limit = p_['limit']
    if not limit:
        cand = [c for d, c in near_fixed(p_['lat'], p_['lng'], 2000 if hwy else 600) if c[3] in (1, 3) and c[2] > 0 and c[6] == 0]
        limit = cand[0][2] if cand else (30 if p_['school'] else 0)
    if not limit:
        stats['no_limit'] += 1
    kept.append(p_)
    ends = arrow_ends(p_['text'])
    one = isinstance(ends, tuple)
    row = [round(p_['lat'], 6), round(p_['lng'], 6), int(limit), 1 if p_['booth'] else 8, 0, 0, 2 if p_['school'] else 0, -1,
           1 if hwy else 4, 1 if one else 3, 2 if p_['booth'] else 0]
    if one:
        for e in ends:
            if e not in name_idx:
                name_idx[e] = len(names)
                names.append(e)
        arrows += [len(rows), name_idx[ends[0]], name_idx[ends[1]]]
    rows.append(row)

by = {}
for p_ in kept:
    k = p_['src'] + (' 부스' if p_['booth'] else ' 이동식')
    by[k] = by.get(k, 0) + 1
out = {'v': 1, 'date': date.today().isoformat(), 'count': len(rows), 'fields': cam['fields'], 'roads': [],
       'sources': {'busan': '부산경찰청 이동식 과속 단속 지점 2026-10-13', 'gn': '경남경찰청 이동식 교통단속장비 운영장소 2026-11-01',
                   'ggb': '경기북부경찰청 이동식 장비 단속부스 2026-10-31'},
       'rows': rows, 'arrowNames': names, 'arrows': arrows}
with open(OUT, 'w', encoding='utf-8') as fh:
    json.dump(out, fh, ensure_ascii=False, separators=(',', ':'))
print(json.dumps(dict(stats, kept=len(rows), by=by, one_way=len(arrows) // 3), ensure_ascii=False))
