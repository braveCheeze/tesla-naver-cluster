"""음성 조각 목록 data/voice_clips.json 을 만든다 (v278, 운전자 '걍 MeloTTS로 다 가자').

테슬라 브라우저에는 음성 엔진이 없어(목소리 0개, speak() → synthesis-failed) 모든 음성 안내가 경고음이었다.
그래서 앱이 하는 말을 조각으로 나눠 미리 소리로 만들어 두고(MeloTTS, 이 PC 에서 한 번 → audio/voice/<id>.*),
앱은 지금 말을 만드는 함수가 만든 문장을 그대로 조각 열쇠로 바꿔(app.js vcPlan) AudioContext 로 잇달아 튼다.
이름(장소·방면·목적지·톨게이트 이름)은 끝이 없어 음성에서 뺀다 (운전자 선택 ①). 화면에는 그대로 나온다.

조각 글은 앱 문장과 글자가 같아야 한다(빈칸·쉼표·마침표는 무시하고 맞춘다). 숫자 조각은 한글로 적는다
(음성 합성기가 숫자를 어떻게 읽든 조각마다 같게 하려고). 실행: py -I tools/build_voice_clips.py
"""
import json
import os
import re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'data', 'voice_clips.json')

DIG = ['', '일', '이', '삼', '사', '오', '육', '칠', '팔', '구']


def ko_num(n):
    """1..99999 를 한자어 수 읽기로 (12 → 십이, 110 → 백십, 1600 → 천육백)."""
    parts = []
    for unit, name in ((10000, '만'), (1000, '천'), (100, '백'), (10, '십')):
        q, n = divmod(n, unit)
        if q:
            parts.append(('' if q == 1 else DIG[q]) + name)
    if n:
        parts.append(DIG[n])
    return ''.join(parts)


NATIVE_HOUR = ['', '한', '두', '세', '네', '다섯', '여섯', '일곱', '여덟', '아홉', '열', '열한', '열두']


def reading(text):
    """소리 만들 때 읽을 글: 숫자를 한글로 (g2pkk 는 '미터'·'시' 같은 단위 앞 숫자만 바꾸고 '제한속도 110입니다'의 110 은
    '일일영'으로 읽었다). 시계 방향은 고유어 ('12시 방향' → '열두 시 방향'), 나머지는 한자어 ('110' → '백십')"""
    t = re.sub(r'(\d+)시 방향', lambda m: NATIVE_HOUR[int(m.group(1))] + ' 시 방향', text)
    return re.sub(r'\d+', lambda m: ko_num(int(m.group(0))), t)


clips = []


def add(cid, text, group, note=''):
    assert all(c['id'] != cid for c in clips), cid
    e = {'id': cid, 'text': text, 'g': group}
    if re.search(r'\d', text):
        e['say'] = reading(text)   # 소리 만들 때만 (앱은 text 로 맞춘다)
    if note:
        e['note'] = note
    clips.append(e)


# 1. 고정 문장 (say 그대로)
FIXED = [
    ('f_route_start', '경로 안내를 시작합니다.'),
    ('f_off_route', '경로를 벗어났습니다. 다시 탐색합니다.'),
    ('f_arrived', '목적지에 도착했습니다. 안내를 종료합니다.'),
    ('f_end', '안내를 종료합니다.'),
    ('f_new_route', '새 경로로 안내합니다.'),
    ('f_via_route', '경유지를 거쳐 가는 경로로 안내합니다.'),
    ('f_other_route', '다른 경로로 안내합니다.'),
    ('f_chosen_route', '선택한 경로로 안내합니다.'),
    ('f_traffic', '교통 상황을 반영했습니다.'),
    ('f_eta', '도착 예정이'),
    ('f_later', '늦어졌습니다.'),
    ('f_sooner', '빨라졌습니다.'),
    ('f_sec_end', '구간단속이 끝났습니다.'),
    ('f_test', '음성 안내 테스트입니다.'),
    ('f_about', '약'),
    ('f_takes', '걸립니다.'),
    ('f_hipass', '하이패스 차로를 이용하세요'),
    ('f_tollgate', '톨게이트'),
    ('f_toll', '통행료'),
    ('f_free', '무료'),
    ('f_fare_unknown', '확인필요'),
    ('f_then', '이어서'),
    ('f_again', '다시'),
    ('f_ahead', '앞'),
    ('f_is', '입니다.'),
    ('f_limit', '제한속도'),
    ('f_sig300', '300미터 앞, 신호 단속 카메라입니다.'),
]
for cid, t in FIXED:
    add(cid, t, 'fixed')

# 2. 카메라 종류 (camSpoken). 보호구역은 앞붙임 조각. 박스형은 지금 말에 없다(camSpoken 이 '단속 카메라'로 말함) — 앞으로 쓸 때를 위해
CAMS = [
    ('c_cam', '단속 카메라'), ('c_signal', '신호 단속 카메라'), ('c_mobile', '이동식 단속'), ('c_section', '구간단속'),
    ('c_sec_start', '구간단속 시작'), ('c_sec_end', '구간단속 끝'), ('c_rear', '후면단속 카메라'), ('c_spot', '신고된 단속 지점'),
    ('c_kid', '어린이보호구역'), ('c_elder', '노인보호구역'),
]
for cid, t in CAMS:
    add(cid, t, 'camera')
add('c_box', '박스형 단속 카메라', 'camera')   # v278: camSpoken 이 박스형 부스를 '박스형 단속 카메라'로 (네이버처럼)

# 3. 제한속도 20~120 (data 의 모든 제한): 카메라 '제한속도 N입니다.' · 구간단속 시작 '제한속도 N.'
for n in range(20, 130, 10):
    add('lim_%d' % n, '제한속도 %d입니다.' % n, 'limit')
for n in range(20, 130, 10):
    add('limq_%d' % n, '제한속도 %d.' % n, 'limit')

# 4. 거리 '… 앞' (카메라 dd · 회전 2km/1km/100~300m · 이어서 10~300m 10 단위)
# 운전자 (2026-11-28) '1km 앞까지 10미터 20미터 30미터 이런식으로 따로따로 분리하고 이어붙이는 것도 좋을 듯': 10m 단위 전부
DIST = list(range(10, 1000, 10))
for m in DIST:
    add('d_%d' % m, '%d미터 앞' % m, 'distance')
for k in (1, 2):
    add('d_%dk' % k, '%d킬로미터 앞' % k, 'distance')

# 5. 안내 동작 (네이버 안내 글에서 장소·방면을 뺀 나머지, 이어서 동작 SOON_ACT 포함)
MAN = ['직진', '좌회전', '우회전', '유턴', '비보호 좌회전', '비보호 유턴', '목적지', '경유지', '분기', '분기도로 진입', '분기 후 합류',
       '진입', '출구', '고가차도 진입', '지하차도 진입', '터널 진입', '고속도로 진입', '고속도로 출구', '도시고속도로 진입', '도시고속도로 출구',
       '자동차전용도로 진입', '자동차전용도로 출구']
for side in ('왼쪽', '오른쪽'):
    for what in ('방향', '도로 주행', '옆길', '진입', '출구', '고가차도 진입', '지하차도 진입', '고속도로 진입', '고속도로 출구',
                 '도시고속도로 진입', '도시고속도로 출구', '자동차전용도로 진입', '자동차전용도로 출구'):
        MAN.append(side + ' ' + what)
    MAN.append('지하차도 ' + side + ' 옆길')
    MAN.append('고가차도 ' + side + ' 옆길')
for h in range(1, 13):
    MAN.append('%d시 방향' % h)
    MAN.append('회전교차로에서 %d시 방향' % h)
for k, t in enumerate(MAN):
    add('m_%03d' % k, t, 'maneuver')

# 6. 숫자·단위 (길안내 시작 'N킬로미터, 약 M분', 도착 예정 'N분', 통행료 'N원'). 1~99 는 통째로, 그 위는 백·천·만 자리 조각
for n in range(1, 100):
    add('n_%d' % n, ko_num(n), 'number')
for n in range(100, 1000, 100):
    add('n_%d' % n, ko_num(n), 'number')
for n in range(1000, 10000, 1000):
    add('n_%d' % n, ko_num(n), 'number')
add('n_man', '만', 'number')
add('n_dot', '점', 'number')
for cid, t in (('u_km', '킬로미터'), ('u_m', '미터'), ('u_min', '분'), ('u_hour', '시간'), ('u_won', '원')):
    add(cid, t, 'unit')

doc = {
    'v': 1, 'date': '2026-11-28', 'audio': 'melotts-kr-s1.1-1',   # 소리 묶음 판: 소리를 다시 만들면 올린다 (앱 Cache Storage 이름)
    'count': len(clips), 'chars': sum(len(c['text']) for c in clips),
    'note': "앱 음성 조각 (app.js vcPlan 이 말 문장을 이 조각들로 바꾼다). 이름(장소·방면·목적지·톨게이트 이름)은 음성에서 뺀다. "
            "소리 파일: audio/voice/<id>.* (MeloTTS 로 이 PC 에서 한 번 만듦). 숫자 조각은 한글 읽기.",
    'clips': clips,
}
with open(OUT, 'w', encoding='utf-8', newline='\n') as fh:   # 한 줄에 조각 하나 (고친 것이 diff 에서 잘 보이게)
    head = {k: v for k, v in doc.items() if k != 'clips'}
    fh.write(json.dumps(head, ensure_ascii=False)[:-1] + ',\n"clips": [\n')
    fh.write(',\n'.join(json.dumps(c, ensure_ascii=False) for c in clips))
    fh.write('\n]}\n')
groups = {}
for c in clips:
    groups[c['g']] = groups.get(c['g'], 0) + 1
print('clips', len(clips), 'chars', doc['chars'], groups)
