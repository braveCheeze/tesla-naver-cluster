"""전국무인교통단속카메라표준데이터 CSV -> 페이지용 압축 JSON (v2).

rows: [lat, lng, limit, kind, sec, len, zone, road, rtype, dir(, flags)]
kind : 1 과속, 2 신호 전용, 3 과속+신호, 9 구간단속/기타
       (원본 단속구분: 1=속도, 2=신호, '01+02'=속도+신호, 3=통행위반, 4=주정차, 99=기타)
       원본 '신호(2)'라도 제한속도가 있으면 3(신호·과속)으로 바꾼다 (아래 설명). 2 는 제한속도가 없는 것만 남는다.
sec  : 0 없음, 1 구간 시점, 2 구간 종점
len  : 구간 길이 m
zone : 0 없음, 1 노인보호구역, 2 어린이보호구역
road : roads[] 의 번호 (도로노선명, 없으면 -1)
rtype: 1 고속국도, 3 일반국도, 4 지방도, 5 시도(특별·광역시도 포함), 6 군도·구도·기타
dir  : 도로노선방향 1 상행, 2 하행, 3 양방향, 0 모름 (앱은 이 칸을 쓰지 않는다. 찍는 방향은 dirs: tools/osm_cams.py)
flags: 1 후면 단속 (지나간 뒤 차 뒤를 찍는다), 2 박스형 (단속 부스. 원본 경찰청 데이터에는 없다). 원본에는 이 구분이 없어서
       직접 확인한 것만 있고, 그 줄에만 11번째 값으로 붙는다 (나머지 줄은 10개 그대로). 예전 'rear'(1)와 같은 자리

pairs: [행, 행, ...] 한 기둥에서 서로 반대 방향을 찍는 두 카메라(v164). pairs80: 80m 안에 따로 등록된 상행·하행 쌍 (osm_cams.py 가 쓰고 지운다)

사용법: py -I tools/build_cams.py <원본.csv> data/cameras.json
원본 CSV: data.go.kr '전국무인교통단속카메라표준데이터' (cp949). 새 원본으로 다시 만들어도 아래 FIXES 는 그대로 적용된다.
다시 만들기 (v164): 다시 만들기 전 data/cameras.json·mobile.json 을 다른 폴더(OLD)에 복사해 두고
  build_cams.py → build_mobile.py → osm_cams.py → osm_arrows.py → osm_stopline.py → cam_fill.py --old OLD
  (OSM 단계는 D:/osm/south-korea-latest.osm.pbf, 다 합쳐 약 6분. 같은 원본이면 몇 번을 돌려도 결과가 같다)
v164 (2026-11-19 자료 점검):
  - 같은 자리 기록이 서로 반대 방향(상행·하행, 'A→B'·'B→A', 'A↔B', 경기북부 '양방향')이면 합치지 않고 두 행(짝)으로
    (차로만 다른 기록 '1,2차로'·'3,4차로' 와 같은 곳에서 오거나 가는 글은 한 방향으로 본다)
  - 경기북부 PDF 의 '후면식' 장비번호는 후면 단속(flags 1) (tools/ggb_rear_ids.json)
  - 구간: '99'·구간 길이가 있는 기록도 '시점'·'종점' 글로 가르고, 30km 안에 짝(같은 제한)이 없으면 한 대짜리로, 길이 0 인 시점은 짝까지 직선×1.1,
    100km 넘는 길이는 m 로 본다. '99'만 있고 구간이 아니면 과속(1)
  - 제한속도가 빠진 과속 카메라는 빼지 않는다(보호구역 30, 그 밖은 cam_fill.py 가 채운다)
  - 원본 좌표가 엉뚱한 기록은 tools/cam_coords_fix.json (tools/geo_fix_cams.py) 의 주소 자리로
"""
import csv
import io
import json
import re
import sys
from collections import Counter

src, out = sys.argv[1], sys.argv[2]
rows = list(csv.reader(io.StringIO(open(src, 'rb').read().decode('cp949'))))[1:]

# v164: 같은 관리번호(같은 시군구)가 데이터기준일자만 다르게 두 번 이상 올라 있으면 가장 새 기록만 쓴다.
# 원본에 예전 기록이 그대로 남아 있다: 2,060개 번호(경기 1,183·대전 313(2022-12)·충남 232 …), 예전 기록은 좌표가 1km 넘게 다른 것도 206개
# (포천 G4363 '(포천->철원)' 2026-10-20 / '샛청3교차로' 2025-06-23 이 1.2km). 예전 기록이 엉뚱한 자리의 유령 카메라가 되고,
# 같은 자리면 방향 코드가 달라 '반대 방향 짝'으로 잘못 만들어진다. 기록이 5개 넘는 번호('1'·'2' 같은 시군구 일련번호)와 날짜가 같은 기록은 그대로
_by_id = {}
for r in rows:
    _by_id.setdefault((r[1].strip(), r[2].strip(), r[0].strip()), []).append(r)
_stale = set()
for v in _by_id.values():
    if 2 <= len(v) <= 4:
        newest = max(x[20] for x in v)
        _stale.update(id(x) for x in v if x[20] < newest)
rows = [r for r in rows if id(r) not in _stale]
print('older records of the same camera number dropped:', len(_stale))


# 설치장소의 방향 표시: '(A→B)', 'A->B', 'A⇒B', 'A▶B'
PLACE_ARROW = re.compile(r'→|->|⇒|▶|=>')
ARROW_PAREN = re.compile(r'\(([^()]*?(?:→|->|⇒|▶|=>)[^()]*)\)')
ARROW_SPLIT = re.compile(r'\s*(?:→|->|⇒|▶|=>)\s*')


def arrow_ends(place):
    """설치장소 '창우지하차도 지나 250m 지점(하남ic->팔당대교)' -> ('하남ic', '팔당대교').
    앱이 길안내 경로의 앞뒤 안내 문구('팔당대교IC에서 …', '하남IC에서 …')와 맞춰 한 방향 카메라의 방향을 가른다.
    공백을 빼고 소문자로, 끝의 '방면·방향·쪽'은 뗀다. 두 글자 미만이면 버린다"""
    m = ARROW_PAREN.findall(place)
    parts = ARROW_SPLIT.split(m[-1] if m else place)
    if len(parts) != 2:
        return None
    ends = [re.sub(r'(방면|방향|쪽)$', '', re.sub(r'\s+', '', x).lower()) for x in parts]
    return tuple(ends) if all(len(e) >= 2 for e in ends) else None


def norm(code):
    return code.strip().lstrip('0') or '0'


TWO_WAY = re.compile(r'\(([^()]*?)↔([^()]*?)\)')


def two_way_ends(place):
    """'장현초교 후문 건너편 어린이보호구역(진접농협↔진접성당)' -> ('진접농협', '진접성당'): 한 기둥에서 두 방향을 찍는 카메라"""
    m = TWO_WAY.findall(place)
    if not m:
        return None
    ends = [re.sub(r'(방면|방향|쪽)$', '', re.sub(r'\s+', '', x).lower()) for x in m[-1]]
    return tuple(ends) if all(len(e) >= 2 for e in ends) else None


LANE = re.compile(r'\d+(?:\s*[,~·-]\s*\d+)*\s*(?:차로|차선)|\s+')


def lane_split(t1, t2):
    """차로만 다른 같은 자리 기록('영동고속도로 51.2km 시점 1,2차로' / '… 3,4차로' / '… 5차로'): 한 방향 차로들을 나눠 찍는 카메라"""
    if not t1 or not t2 or not (re.search(r'차로|차선', t1) and re.search(r'차로|차선', t2)):
        return False
    return LANE.sub('', t1) == LANE.sub('', t2)


def opposite(d1, e1, d2, e2, t1=None, t2=None):
    """두 기록이 서로 반대 방향을 찍는지: 설치장소 'A→B'·'B→A', 또는 방향 코드 상행(1)·하행(2) (글이 같은 방향이라고 하지 않을 때).
    차로만 다른 기록은 방향 코드가 1·2 로 섞여 있어도 같은 방향 (원본에 그런 줄이 많다)"""
    if e1 and e2:
        if e1 == e2[::-1]:
            return True
        if e1[0] == e2[0] or e1[1] == e2[1]:
            return False   # 같은 곳에서 오거나 같은 곳으로 가면 같은 방향 ('군산→익산'·'군산→대야')
    if lane_split(t1, t2):
        return False
    return {d1, d2} == {1, 2}


RTYPE = {'고속국도': 1, '일반국도': 3, '국가지원지방도': 4, '지방도': 4, '특별시도': 5, '광역시도': 5, '시도': 5,
         '군도': 6, '구도': 6, '기타': 6}

# 직접 달려 보고 확인한 원본 데이터 보정 (관리번호 -> 바꿀 값).
# 원본에 '신호 전용(2)'으로만 올라 있지만 실제로는 과속도 찍는 카메라는 kind 3(신호·과속)으로 고친다.
# 신호 전용 카메라는 앱에서 기본으로 알리지 않으므로, 이렇게 고쳐야 과속 경고가 나온다.
FIXES = {
    # 2026-11-14 주행 제보: 가평읍 가화로 계량교, 제한 30 과속 단속인데 안 잡힘 (원본: 신호 전용, 제한 30)
    'H4877': {'kind': 3},   # 계량교 지나 50m (마장리→대곡리)
    'H4878': {'kind': 3},   # 승안삼거리 (대곡리→마장리), 같은 교차로 반대 방향
    # 2026-11-20 서울·경기 가상 주행 점검: 용인 세종포천고속도로(광주→안성) 구간단속 시점·종점 네 대가 원본에 '평택시흥고속도로'로
    # 적혀 있다(설치장소도 '평택시흥고속도로 시점 1,2차로(광주→안성)'). 평택시흥고속도로는 20km 넘게 떨어져 있다. 네이버 경로 구간 이름은
    # 세종포천고속도로라 앱의 도로 이름 비교에서 '다른 길'이 된다
    'J8397': {'road': '세종포천고속도로'}, 'J8398': {'road': '세종포천고속도로'},
    'J8399': {'road': '세종포천고속도로'}, 'J8400': {'road': '세종포천고속도로'},
}
fixed = Counter()

# 원본에 아예 없는 카메라 (직접 달려 보고 확인한 것). 좌표는 그 방향 차로 쪽 길가에 둔다:
# 앱은 한 방향 카메라가 내 진행 방향 왼쪽으로 8m 넘게 있으면 반대편 차로용으로 보고 빼기 때문.
ADDS = [
    # 2026-11-14 주행 제보: 가평읍 상색리 경춘로 포회촌마을입구교차로, 가평→서울(남서행) 제한 70 신호·과속 후면단속.
    # 원본에는 같은 교차로의 반대 방향(H7738, 청평→가평군청, 과속 60)만 있다.
    # 남서행 네이버 경로 기준 정지선 쪽(교차로 12m 앞) 오른쪽 12m. 북동행 경로에서는 왼쪽 21m 라 잡히지 않는다.
    {'id': 'U0001', 'lat': 37.79681, 'lng': 127.48014, 'limit': 70, 'kind': 3, 'road': '경춘로', 'rtype': 3, 'dir': 2, 'rear': 1},
    # 2026-11-14 주행 제보: 남양주 와부읍 팔당리 다산로(강변 옛길), 양평→팔당대교IC(북서행) 제한 60 박스형 과속 단속.
    # 원본(경찰청)에는 박스형이 없다. 다른 내비가 팔당대교IC 2km 앞에서 239m 앞으로 알린 자리 = 네이버 경로에서 IC 1.76km 앞(±50m).
    # 북서행 경로 오른쪽 10m. 남동행 경로에서는 왼쪽 10m 라 반대편으로 보고 잡히지 않는다.
    {'id': 'U0002', 'lat': 37.53968, 'lng': 127.25632, 'limit': 60, 'kind': 1, 'road': '다산로', 'rtype': 4, 'dir': 1, 'box': 1},
    # 2026-11-15 밤 주행(성남 → 기흥, 네이버 지도와 같은 순간 사진): 원본에 없는 카메라 셋. 좌표는 실제 네이버 경로 위
    # 해당 지점에서 진행 방향 오른쪽 6m (osm_cams.py 가 그 차로 방향으로 붙인다).
    # 분당수서간도시고속화도로 남행 제한 80 과속: 네이버가 벌말지하차도 입구 24m 앞에 '80 · 과속단속'. 원본엔 북행(21906 '분당구청→탄천ic')만
    {'id': 'U0003', 'lat': 37.4089, 'lng': 127.11853, 'limit': 80, 'kind': 1, 'road': '분당수서간도시고속화도로', 'rtype': 5, 'dir': 2},
    # 용구대로2469번길 삼성르노자동차삼거리 남행 제한 50 신호·과속 (네이버 '50 · 신호과속', 교차로 10m 앞)
    {'id': 'U0004', 'lat': 37.32188, 'lng': 127.10475, 'limit': 50, 'kind': 3, 'road': '용구대로2469번길', 'rtype': 5, 'dir': 2},
    # 용구대로 연원마을사거리 남행 제한 60 후면단속 (네이버 '60 · 후면단속'). 원본의 연원마을사거리(J5490)는 북행 쪽 기둥
    {'id': 'U0005', 'lat': 37.30088, 'lng': 127.10645, 'limit': 60, 'kind': 3, 'road': '용구대로', 'rtype': 4, 'dir': 2, 'rear': 1},
]

# v164: 후면 단속 카메라 관리번호 (경기북부경찰청 무인교통단속장비 PDF '다기능 장비리스트'의 단속방향 '후면식', 2026-10-31 기준).
# 원본 경찰청 CSV 에는 후면 구분이 없다. tools/ggb_rear_ids.json (tools/ggb_rear_ids.py 로 PDF 에서 뽑음)
# 같은 목록의 '양방향' 장비는 한 기둥에서 두 방향을 찍는다: 짝(두 행)으로 만든다
try:
    _gg = json.load(open(__file__.rsplit('build_cams.py', 1)[0] + 'ggb_rear_ids.json', encoding='utf-8'))
    REAR_IDS, BOTH_IDS = set(_gg['rear']), set(_gg.get('both', []))
except (OSError, ValueError, KeyError):
    REAR_IDS, BOTH_IDS = set(), set()
# 원본 좌표가 엉뚱한 카메라 (관리번호 -> 주소로 찾은 자리). 원본 주소가 그대로일 때만 쓴다 (새 원본에서 주소가 바뀌면 다시 찾아야 한다)
try:
    COORD_FIX = json.load(open(__file__.rsplit('build_cams.py', 1)[0] + 'cam_coords_fix.json', encoding='utf-8'))['fix']
except (OSError, ValueError, KeyError):
    COORD_FIX = {}

roads, road_idx = [], {}
seen = {}       # (위도, 경도, 제한, 종류, 구간) -> 그 자리 행들
data = []
arrow_of = {}   # id(row) -> (A, B): 설치장소에 적힌 방향 'A→B'
twin_links = []  # v164: (id(행), id(행)) 한 기둥(또는 80m 안)에서 서로 반대 방향을 찍는 짝
rid_of = {}     # id(행) -> 관리번호 (첫 기록)
text_of = {}    # id(행) -> 설치장소 (첫 기록)
skipped = Counter()
dates = Counter()
for r in rows:
    try:
        lat, lng = float(r[9]), float(r[10])
    except ValueError:
        lat = lng = 0.0
    # v164: 엉뚱한 좌표는 주소로 다시 찾은 자리로 (tools/geo_fix_cams.py → tools/cam_coords_fix.json)
    cf = COORD_FIX.get('%s|%s|%s' % (r[1].strip(), r[2].strip(), r[0].strip()))
    if cf and cf.get('addr', '').replace(' ', '') in ((r[7] or '') + (r[8] or '')).replace(' ', ''):
        lat, lng = cf['lat'], cf['lng']
        skipped['(info) coordinate from address (cam_coords_fix.json)'] += 1
    if not (33 < lat < 39 and 124 < lng < 132):
        skipped['coord'] += 1
        continue
    try:
        limit = int(float(r[13] or 0))
    except ValueError:
        limit = 0
    code = r[12].strip()
    parts = {norm(c) for c in code.replace(' ', '').split('+')}
    sec = {'1': 1, '2': 2}.get(norm(r[14]), 0)
    # 구간단속인데 '단속구간위치구분'이 비어 있고 설치장소에만 '구간 시점/종점'이 적힌 카메라 (2026-11-14 점검: 29대.
    # 예: 영덕 동해대로 '구간 시점(영해휴게소 방면)', 울산 아산로 '아산로구간단속종점1', 세종로 '대곡삼거리 후방 구간단속 시점')
    # v164: '구간'이 없어도 단속구분이 '99 기타'이거나 과속단속구간길이가 적힌 카메라는 설치장소의 '시점'·'종점'으로 가른다
    # (2026-11-19 점검: '99' 58대 — 남해고속도로 44.6K 시점 F8796·통영대전 115.9K 종점 H3914·서해안 98.2K 종점 J9628,
    #  속도·신호 41대 — 황매산터널 시점 H0288 등). '버스종점'은 구간 끝이 아니다
    try:
        has_len = float(r[15] or 0) > 0
    except ValueError:
        has_len = False
    sec_text = '구간' in r[11] or '99' in parts or has_len
    if not sec and sec_text and not ('4' in {norm(c) for c in r[12].replace(' ', '').split('+')} and not r[13].strip('0 ')):
        place_ = r[11].replace('버스종점', '')
        if '시점' in place_:
            sec = 1
            skipped['(info) section start from place text'] += 1
        elif '종점' in place_:
            sec = 2
            skipped['(info) section end from place text'] += 1
    if parts & {'3', '4'} and not parts & {'1', '2'} and not sec:
        skipped['parking/other'] += 1
        continue
    # v164: 구간단속(9)은 시점·종점인 것만. '99 기타'인데 구간이 아닌 300대(교차로 157대, 서산 172·광양 37)가 '구간단속'으로 안내됐다.
    # 그런 것은 속도(1)·신호 코드가 같이 있으면 그대로, '99'만 있으면 과속(1)으로 본다
    if sec:
        kind = 9
    elif '99' in parts and not parts & {'1', '2'}:
        kind = 1
        skipped['(info) 99 (other), not a section → speed'] += 1
    elif '1' in parts and '2' in parts:
        kind = 3
    elif '2' in parts:
        kind = 2
    elif '1' in parts:
        kind = 1
    else:
        skipped['unknown kind'] += 1
        continue
    # 원본의 '신호(2)'는 대부분 교차로 다기능 카메라(신호·과속)다: 신호 전용이 1만 8천여 대인데 99% 넘게 제한속도가 적혀 있고
    # 대부분 2019년 이후 설치. 실제로 달려 보니 계량교(30)·청평 경춘로 카메라들이 과속도 찍는데 '신호'로만 올라 있었다.
    # 그래서 제한속도가 있는 신호 카메라는 신호·과속(3)으로 본다. 제한속도가 없는(0) 것만 신호 전용으로 남긴다.
    if kind == 2 and limit > 0:
        kind = 3
        skipped['(info) signal→signal+speed'] += 1
    fix = FIXES.get(r[0].strip())
    if fix:
        kind = fix.get('kind', kind)
        limit = fix.get('limit', limit)
        fixed[r[0].strip()] += 1
    try:
        length = int(round(float(r[15]) * 1000)) if r[15].strip() else 0
    except ValueError:
        length = 0
    # v164: 과속단속구간길이는 km 인데 m 로 적은 줄이 72개 (순천완주 J9771/J9772 '15834' → 15,834km, 녹색로 K0186/K0187 3,625km).
    # 100km 넘으면 m 로 본다
    if length > 100000:
        length = int(round(length / 1000))
        skipped['(info) section length was in m'] += 1
    zone = {'1': 1, '2': 2}.get(norm(r[16]), 0)
    # 보호구역 코드가 비어 있어도(99 등) 설치장소에 '어린이보호구역'·'스쿨존'·'노인보호구역'이 적혀 있으면 보호구역으로 본다
    if not zone:
        place = r[11]
        if '어린이보호' in place or '스쿨존' in place:
            zone = 2
            skipped['(info) zone from place text'] += 1
        elif '노인보호' in place:
            zone = 1
            skipped['(info) zone from place text'] += 1
    # v164: 제한속도가 빠진 과속 카메라는 빼지 않는다 (예전엔 뺐다: 양산 '116', 인천 남동 '9'·'10' 어린이 구간 시점·종점 등 33대).
    # 어린이보호구역이면 30, 아니면 0 으로 두고 tools/cam_fill.py 가 같은 길 카메라·OSM 제한속도로 채운다
    if limit <= 0 and kind != 2:
        if zone == 2:
            limit = 30
            skipped['(info) limit missing → 30 (school zone)'] += 1
        else:
            skipped['(info) limit missing → filled later'] += 1
    name = r[5].strip()
    if fix and fix.get('road'):
        name = fix['road']
    if name:
        if name not in road_idx:
            road_idx[name] = len(roads)
            roads.append(name)
        ri = road_idx[name]
    else:
        ri = -1
    rtype = RTYPE.get(r[3].strip(), 6)
    # v164: 원본 도로종류가 '고속국도'인데 도로명·설치장소 어디에도 고속도로가 아닌 일반도로 (수석호평로 H4330 60, 분당수서로 G8671 60 등):
    # 고속국도로 두면 앱이 3km 앞에서 알리고, osm_cams 가 옆 고속도로 본선에 붙인다(분당수서로 → 경부고속도로). 시도(5)로 본다
    if rtype == 1 and not re.search(r'고속|순환|선$', name) and not re.search(r'고속도로|고속국도|\d+(\.\d+)?\s*[kK]', r[11]):
        rtype = 5
        skipped['(info) expressway code on a city road → 5'] += 1
    # v165: 도로명이 '…고속도로'(도시고속도로·구고속도로 아님)이고 제한 80 이상인데 도로종류가 시도·기타로 적힌 것은 고속국도
    # (세종포천고속도로 구간 끝 100·대전당진고속도로 110: 3km 가 아니라 1km 앞에서 알렸고, osm_cams 가 고속도로 본선에 붙이지 않았다)
    if rtype != 1 and limit >= 80 and re.search(r'고속도로$', name) and not re.search(r'도시고속|^구고속', name):
        rtype = 1
        skipped['(info) expressway name, limit 80+ → 1'] += 1
    direction = {'1': 1, '2': 2, '3': 3}.get(norm(r[6]), 0)
    # 과속 전용 카메라는 설치장소에 '(A→B)'처럼 방향이 적혀 있으면, 방향 코드가 '양방향(3)'이어도 한 방향만 찍는다.
    # (2026-11-14 주행: 양서면 북한강로 '골용진 입구(용늪삼거리→양평수난구조대)' J2675 는 코드가 양방향이라
    #  반대편(남행)에서도 떴다. 실제로는 북행 전용이고 남행 경로에서 왼쪽 9m.) 한 방향(1)으로 두면 앱이 좌우로 가른다.
    #  교차로 신호·과속(3)은 화살표가 있어도 실제로 여러 방향을 찍는 경우가 많아 그대로 둔다
    if kind == 1 and not sec and direction == 3 and PLACE_ARROW.search(r[11]):
        direction = 1
        skipped['(info) speed-only one-way from place arrow'] += 1
    key = (round(lat, 5), round(lng, 5), limit, kind, sec)
    ends = arrow_ends(r[11]) if PLACE_ARROW.search(r[11]) else None
    both_ends = two_way_ends(r[11]) if not ends else None
    two_way = bool(both_ends) or r[0].strip() in BOTH_IDS
    if two_way and not both_ends and ends:
        both_ends, ends = ends, None
    group = seen.get(key)
    if group:
        # v164: 같은 자리 기록이라도 방향이 반대(상행·하행, 또는 'A→B'·'B→A')면 합치지 않고 두 행(짝)으로 둔다
        hit = next((p for p in group if not opposite(p[9], arrow_of.get(id(p)), direction, ends, text_of.get(id(p)), r[11])), None)
        if hit is not None:
            if hit[9] != direction:
                hit[9] = 3 if (hit[9] and direction) else (hit[9] or direction)
            skipped['dup'] += 1
            continue
    flags = (1 if fix and fix.get('rear') else 0) | (2 if fix and fix.get('box') else 0) | (1 if r[0].strip() in REAR_IDS else 0)
    new = []
    for k_, e in enumerate([both_ends, both_ends[::-1]] if both_ends else [None, None] if two_way else [ends]):
        # 글 없는 양방향 짝은 방향 코드를 1·2 로 (아래 15m 합치기에서 서로 합쳐지지 않게. 앱은 이 칸을 쓰지 않는다)
        dcode = (1, 2)[k_] if two_way and not both_ends else direction
        row = [round(lat, 5), round(lng, 5), limit, kind, sec, length, zone, ri, rtype, dcode]
        if flags:
            row.append(flags)
        if e:
            arrow_of[id(row)] = e
        new.append(row)
        data.append(row)
    if two_way:
        twin_links.append((id(new[0]), id(new[1])))
        skipped['(info) two-way (A↔B text or GGB list) → pair'] += 1
    if group:
        twin_links.append((id(group[0]), id(new[0])))
        skipped['(info) opposite record at the same spot → pair'] += 1
    seen.setdefault(key, []).extend(new)
    for row in new:
        rid_of[id(row)] = r[0].strip()
        text_of[id(row)] = r[11]
    dates[r[20]] += 1

for a in ADDS:
    name = a['road']
    if name not in road_idx:
        road_idx[name] = len(roads)
        roads.append(name)
    row = [a['lat'], a['lng'], a['limit'], a['kind'], 0, 0, a.get('zone', 0), road_idx[name], a['rtype'], a['dir']]
    flags = (1 if a.get('rear') else 0) | (2 if a.get('box') else 0)
    if flags:
        row.append(flags)
    data.append(row)
    fixed[a['id']] += 1
FIXES.update({a['id']: a for a in ADDS})   # 아래 'NOT FOUND' 확인에 함께 넣는다

data.sort()

# 거의 같은 자리(15m 안)에 같은 종류·구간·제한속도의 카메라가 여러 건이면 하나로 합친다
# (같은 단속기를 두 번 등록했거나, 한 기둥에서 양쪽 방향을 찍는 경우). 방향이 서로 다르면 양방향(3)으로.
import math
def dist_m(a, b):
    dy = (a[0] - b[0]) * 110540
    dx = (a[1] - b[1]) * 111320 * math.cos(math.radians(a[0]))
    return math.hypot(dx, dy)
cells = {}
merged = []
dropped = 0
alias = {}      # id(합쳐져 없어진 행) -> id(남은 행)
for row in data:
    cy, cx = int(math.floor(row[0] / 0.001)), int(math.floor(row[1] / 0.001))
    hit = None
    opp = None
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            for o in cells.get((cy + dy, cx + dx), ()):
                if o[2] == row[2] and o[3] == row[3] and o[4] == row[4] and dist_m(o, row) <= 15:
                    # v164: 반대 방향 카메라(한 기둥의 상행·하행)는 합치지 않는다. 예전엔 합쳐 양방향(3)으로 두었지만 osm_cams 가
                    # 방위를 하나만 줘서 반대 방향은 영영 안 울렸다 (1,599행 중 1,298행. 송호마을입구 J4606/J4607 50 등)
                    if opposite(o[9], arrow_of.get(id(o)), row[9], arrow_of.get(id(row)), text_of.get(id(o)), text_of.get(id(row))):
                        opp = opp or o
                        continue
                    hit = o
                    break
            if hit: break
        if hit: break
    if hit is None and opp is not None:
        twin_links.append((id(opp), id(row)))
    if hit:
        alias[id(row)] = id(hit)
        if hit[9] != row[9]:
            hit[9] = 3 if (hit[9] and row[9]) else (hit[9] or row[9])
        hit[5] = max(hit[5], row[5])
        hit[6] = max(hit[6], row[6])
        if hit[7] < 0: hit[7] = row[7]
        dropped += 1
        continue
    cells.setdefault((cy, cx), []).append(row)
    merged.append(row)
print('merged near-identical cameras:', dropped)
data = merged

# v164 구간단속 짝 맞추기: 시점은 30km 안에 같은 제한속도의 종점이, 종점은 시점이 있어야 구간이다. 짝이 없으면 한 대짜리 과속 카메라로 둔다
# (2026-11-19 점검: 짝 없는 시작 16·끝 12. 구례 '간문초정문'·'문척초정문' 30 같은 어린이 카메라가 구간 끝으로 들어가 있었다).
# 길이가 0 인 시점은 가장 가까운 짝 종점까지 직선 거리 × 1.1 로 둔다 (98대)
sec_rows = [r_ for r_ in data if r_[4] in (1, 2)]
sgrid = {}
for r_ in sec_rows:
    sgrid.setdefault((int(r_[0] / 0.1), int(r_[1] / 0.1)), []).append(r_)


def sec_partner(row):
    """짝 후보: 30km 안, 같은 제한속도의 반대 끝(시점↔종점). 같은 도로명(또는 둘 다 고속국도)인 것을 먼저, 없으면 도로명이 달라도
    (원본 도로명이 '516번 지방도'·'첨단로' 처럼 한 구간 안에서 다르게 적힌 경우가 많다)"""
    want = 3 - row[4]
    best = None
    gy, gx = int(row[0] / 0.1), int(row[1] / 0.1)
    for dy in (-3, -2, -1, 0, 1, 2, 3):
        for dx in (-3, -2, -1, 0, 1, 2, 3):
            for o in sgrid.get((gy + dy, gx + dx), ()):
                if o[4] != want or o[2] != row[2]:
                    continue
                d_ = dist_m(o, row)
                if not (150 < d_ <= 30000):
                    continue
                other_road = o[7] >= 0 and row[7] >= 0 and roads[o[7]] != roads[row[7]] and not (o[8] == row[8] == 1)
                key = (1 if other_road else 0, d_)
                if best is None or key < best[0]:
                    best = (key, o)
    return (best[0][1], best[1]) if best else None


orphan = Counter()
for r_ in sec_rows:
    p_ = sec_partner(r_)
    if p_ is None:
        orphan['start' if r_[4] == 1 else 'end'] += 1
        r_[4] = 0
        if r_[3] == 9:
            r_[3] = 1
    elif r_[4] == 1 and not r_[5]:
        r_[5] = int(round(p_[0] * 1.1))
        orphan['start length from partner'] += 1
print('section cameras without a partner → plain camera, start lengths filled:', dict(orphan))

# 교차로 신호·과속 카메라는 원본에 한 방향(상행/하행)만 올라 있어도 실제로는 반대 방향도 찍는 경우가 많다.
# 2026-11-14 가평→청평 주행: 포회촌·수리재마을입구·청평검문소·소돌마을 교차로가 원본엔 '서울→춘천'만 있는데
# 서울 방향에도 카메라가 있었다(다른 내비에는 다 뜸). 앱은 한 방향 카메라가 왼쪽(반대 차로)에 있으면 빼므로 하나도 안 떴다.
# 그래서 같은 도로 150m 안에 반대 방향 카메라가 따로 등록돼 있지 않으면 양방향(3)으로 본다.
# 과속 전용(1)은 구간 중간에 한쪽만 보는 경우가 많아 그대로 둔다. 직접 추가한 카메라(ADDS)도 그대로.
PAIR_R = 150
added = {(a['lat'], a['lng']) for a in ADDS}
pcells = {}
for row in data:
    pcells.setdefault((int(math.floor(row[0] / 0.002)), int(math.floor(row[1] / 0.002))), []).append(row)
def has_opposite(row):
    cy, cx = int(math.floor(row[0] / 0.002)), int(math.floor(row[1] / 0.002))
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            for o in pcells.get((cy + dy, cx + dx), ()):
                if o is row or o[3] == 9 or dist_m(o, row) > PAIR_R:
                    continue
                if not (o[7] == row[7] or o[7] < 0 or row[7] < 0):
                    continue
                if o[9] == 3 or (o[9] and o[9] != row[9]):
                    return True
    return False
# v123 (2026-11-15 밤): 이 변환을 없앤다. 원본의 한 방향 교차로 카메라를 양방향으로 바꾸니 반대편 차로 카메라가 떴다
# (복정동 성남대로 '성남시청->서울' 60 이 남행에서, 경춘로 수리재 '서울→춘천' 이 서울행에서). 이제 찍는 방향은
# osm_cams.py 가 카메라를 OSM 차로에 붙여 정한다(우측통행: 카메라는 자기가 찍는 차로의 오른쪽 길가). 원본 방향 코드는 그대로 둔다
both = []
latest = max(d for d in dates if d)
# 한 방향(1·2) 카메라 중 설치장소에 'A→B'가 적힌 것: [행 번호, A, B]. 좌표가 도로 한가운데라 좌우로 못 가르는 경우
# (2026-11-14 하남 창우로 J2735 '(하남ic->팔당대교)' 60 이 팔당대교→하남IC 로 갈 때 떴다) 앱이 안내 문구로 가른다
# 같은 지명이 많아서 지명 표(arrowNames)의 번호로 적는다: arrows = [행 번호, A 번호, B 번호, ...] 를 한 줄로 이어 붙임
arrow_names, arrow_ni, arrows = [], {}, []
def name_no(x):
    if x not in arrow_ni:
        arrow_ni[x] = len(arrow_names)
        arrow_names.append(x)
    return arrow_ni[x]
for i, row in enumerate(data):
    if id(row) in arrow_of:   # v123: 양방향(3) 코드여도 설치장소 방향 글은 앱이 안내 문구로 가른다 (반대면 뺀다)
        a_, b_ = arrow_of[id(row)]
        arrows += [i, name_no(a_), name_no(b_)]
print('one-way cameras with A-B place text:', len(arrows) // 3, 'names', len(arrow_names))
# v164: 짝(한 기둥의 반대 방향 카메라 두 대) = [행 번호, 행 번호, ...]. osm_cams.py 가 둘의 찍는 방향을 서로 반대로(그 방향 차로에) 붙이고,
# osm_arrows.py 가 설치장소 글로 어느 쪽이 어느 방향인지 가른다. 앱은 이 칸을 읽지 않는다(행이 둘이라 두 방향 다 뜬다)
row_no = {id(r): i for i, r in enumerate(data)}


def survivor(x):
    while x in alias:
        x = alias[x]
    return x


pair_set = set()
for a_, b_ in twin_links:
    a_, b_ = survivor(a_), survivor(b_)
    if a_ != b_ and a_ in row_no and b_ in row_no:
        pair_set.add(tuple(sorted((row_no[a_], row_no[b_]))))
pairs = [v for p in sorted(pair_set) for v in p]
print('opposite-direction pairs (same pole):', len(pair_set))
# 따로 등록된 반대 방향 쌍: 상행(1)·하행(2), 같은 도로·같은 종류, 80m 안 (시골 2차로처럼 한 기둥에 두 방향 카메라를 단 경우가 많다).
# osm_cams.py 가 기하로 같은 방향이 나오면 하나를 반대 방향 차로로 옮긴다. v164: 차로만 다른 기록('1,2차로'·'3,4차로')과
# 설치장소 방향 글이 같은 기록은 뺀다 (방향 코드만 섞인 한 방향 카메라들이다. 예전 osm_cams 는 이것도 뒤집었다)
pgrid = {}
for i, r_ in enumerate(data):
    pgrid.setdefault((int(math.floor(r_[0] / 0.001)), int(math.floor(r_[1] / 0.001))), []).append(i)
pairs80 = []
for i, c in enumerate(data):
    if c[9] != 1:
        continue
    for dy in (-1, 0, 1):
        for dx in (-1, 0, 1):
            for k in pgrid.get((int(math.floor(c[0] / 0.001)) + dy, int(math.floor(c[1] / 0.001)) + dx), ()):
                o = data[k]
                if o[9] != 2 or o[7] != c[7] or o[3] != c[3] or dist_m(o, c) > 80:
                    continue
                p = (min(i, k), max(i, k))
                if p in pair_set:
                    continue
                ea, eb = arrow_of.get(id(c)), arrow_of.get(id(o))
                if (ea and eb and ea == eb) or lane_split(text_of.get(id(c)), text_of.get(id(o))):
                    continue
                pairs80 += list(p)
print('registered up/down pairs within 80 m:', len(pairs80) // 2)
with open(out, 'w', encoding='utf-8') as f:
    json.dump({'v': 2, 'date': latest, 'count': len(data),
               'fields': ['lat', 'lng', 'limit', 'kind', 'sec', 'len', 'zone', 'road', 'rtype', 'dir', 'flags'],
               'roads': roads, 'rows': data, 'arrowNames': arrow_names, 'arrows': arrows, 'pairs': pairs, 'pairs80': pairs80},
              f, ensure_ascii=False, separators=(',', ':'))

print('kept', len(data), 'roads', len(roads), 'skipped', dict(skipped))
print('kinds', Counter(d[3] for d in data))
print('rtypes', Counter(d[8] for d in data))
print('dirs', Counter(d[9] for d in data), 'speed-cam dirs', Counter(d[9] for d in data if d[3] in (1, 3, 9)))
print('latest date', latest)
missing = sorted(set(FIXES) - set(fixed))
print('fixes applied', dict(fixed), 'NOT FOUND' if missing else '', missing if missing else '')
