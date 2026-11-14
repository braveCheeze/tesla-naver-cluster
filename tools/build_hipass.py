"""한국도로공사 '영업소별 하이패스차로 운영현황' CSV -> 페이지용 JSON (data/hipass.json).

원본: 공공데이터포털 파일데이터 15043760 (한국도로공사, 이용 제한 없음, 연 1회 갱신, 로그인·인증키 필요 없음)
      https://www.data.go.kr/data/15043760/fileData.do  (2026-06-30 기준 889행, 영업소 446곳)
      열: 구분(폐쇄식/개방식), 본부, 지사, 영업소, 방향(입구/출구 또는 상행/하행), 1차로 … 25차로(차로 종류)
사용법: py -I tools/build_hipass.py <한국도로공사_영업소별 하이패스차로 운영현황.csv> data/hipass.json [기준일 YYYY-MM-DD]

출력: {"v":2, "date":"2026-06-30", "count":N, "o": {"하남": {"u":"bHPTb", "t":1, "s":1, "d":"HPTb"}, "군자": {"i":"MMMxxxxxxTbbtt", ...}, ...}}
  - 이름: 영업소 이름에서 공백·'(개방식)'을 뺀 것 (네이버 안내 '하남톨게이트' 에서 '톨게이트'를 뗀 이름과 맞춘다)
  - i 입구 / x 출구 (폐쇄식), u 상행 / d 하행 (개방식, t:1): 1차로부터 차로마다 한 글자 (앱이 차로 칸 줄로 그린다)
    H 하이패스 · M 다차로하이패스(2·3차로형)·다차로(4) · B 하이패스+TCS유인수납  ← 승용차 하이패스 (파란 칸)
    T TCS유인수납 · P 통행료정산기 · h 화물차-하이패스 · b 화물차-하이패스+TCS유인수납 · t 화물차-TCS유인수납 · x 미운영(토목차로) · - 빈 칸
  - 같은 영업소·방향이 두 번 나오는 행(구분 칸이 빈, 미운영 차로 하나짜리)은 버린다
  - s:1 = 수도권 방사형 노선의 개방식 영업소. '서울 쪽으로 가면 상행'으로 방향을 골라도 되는 곳 (순환선·지방은 방향 규칙이 달라서 안 씀)
"""
import csv
import io
import json
import re
import sys

CODE = {'하이패스': 'H', '다차로하이패스(2차로형)': 'M', '다차로하이패스(3차로형)': 'M', '다차로(4)': 'M', '하이패스+TCS유인수납': 'B',
        'TCS유인수납': 'T', '통행료정산기': 'P', '화물차-하이패스': 'h', '화물차-하이패스+TCS유인수납': 'b', '화물차-TCS유인수납': 't',
        '미운영(토목차로)': 'x'}
DIRS = {'입구': 'i', '출구': 'x', '상행': 'u', '하행': 'd'}
SEOUL_HQ = {'수도권', '서울경기'}
# 수도권제1순환선(옛 서울외곽순환) 위 개방식 영업소: 상행·하행이 '서울 쪽'과 맞지 않는다
RING = {'구리남양주', '성남', '청계', '토평', '시흥', '김포', '남인천', '인천'}


def key(name):
    return re.sub(r'\(개방식\)$', '', re.sub(r'\s+', '', name))


def main(src, out, date):
    raw = open(src, 'rb').read()
    for enc in ('utf-8-sig', 'cp949'):
        try:
            text = raw.decode(enc)
            break
        except UnicodeDecodeError:
            continue
    rows = list(csv.reader(io.StringIO(text)))
    head = rows[0]
    col = {name.strip(): i for i, name in enumerate(head)}
    lane_cols = [(int(re.match(r'(\d+)', h).group(1)), i) for i, h in enumerate(head) if re.fullmatch(r'\d+차로', h.strip())]
    offices, clash, unknown = {}, [], set()
    for r in rows[1:]:
        if len(r) < len(head):
            r = r + [''] * (len(head) - len(r))
        name, d = key(r[col['영업소']]), DIRS.get(r[col['방향']].strip())
        if not name or not d:
            continue
        o = offices.setdefault(name, {})
        if d in o:
            clash.append(name)
            continue
        cells = [r[i].strip() for no, i in sorted(lane_cols)]
        unknown.update(v for v in cells if v and v not in CODE)
        o[d] = ''.join(CODE.get(v, '-') for v in cells).rstrip('-')
        if r[col['구분']].strip() == '개방식' or d in ('u', 'd'):
            o['t'] = 1
            if r[col['본부']].strip() in SEOUL_HQ and name not in RING:
                o['s'] = 1
    with open(out, 'w', encoding='utf-8') as f:
        json.dump({'v': 2, 'date': date, 'count': len(offices), 'o': offices}, f, ensure_ascii=False, separators=(',', ':'))
    with_lanes = sum(1 for o in offices.values() if any(set(o.get(k, '')) & set('HMB') for k in 'ixud'))
    print('rows', len(rows) - 1, 'offices', len(offices), 'with car hi-pass lanes', with_lanes,
          'open', sum(1 for o in offices.values() if o.get('t')), 'seoul-rule', sum(1 for o in offices.values() if o.get('s')),
          'duplicate rows', clash, 'unknown lane types', sorted(unknown))


if __name__ == '__main__':
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    main(sys.argv[1], sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else '')
