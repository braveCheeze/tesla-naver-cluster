"""경기북부경찰청 무인교통단속장비 PDF 의 장비 목록에서 '후면식'(후면 단속)·'양방향' 장비번호를 뽑는다 (v164).

    py -I -X utf8 tools/ggb_rear_ids.py <ggb.pdf> tools/ggb_rear_ids.json

PDF: https://www.ggbpolice.go.kr/commons/main/files/ggpolice_cctv(261031).pdf (build_mobile.py 의 ggb/ggb.pdf 와 같은 파일).
장비 목록 줄: '연번 [단속방향] 장비번호 단속장소 관할서 [보호구역] 정상운영일자', 단속방향 칸은 비었거나 '후면식'·'양방향'.
장비번호(J4057 등)는 경찰청 표준데이터 CSV 의 관리번호와 같다. 경찰청 CSV 에는 후면 구분이 없어서
build_cams.py 가 이 목록의 '후면식'을 후면 단속(flags 1)으로 붙인다 (2026-11-19 점검: 125대 중 69대가 CSV 행과 맞는데 후면 표시가 없었다.
그중 44대는 신호·과속이라 기둥에서 바로 경고가 꺼졌다. 예: J4057 성모병원입구사거리 50).
"""
import json
import re
import sys

sys.path.insert(0, r'D:\pylib')
from pypdf import PdfReader  # noqa: E402

# 과속 장비 목록은 단속구분 칸이 하나 더 있다: '259 과속 후면식 J4065 …', '413 구간과속 후면식 J8123 …'
LINE = re.compile(r'^\d+\s+(?:[가-힣]*(?:과속|신호|단속)[가-힣]*\s+)?(후면식|양방향)?\s*([A-Z]\d{4})\s')
pdf = PdfReader(sys.argv[1])
rear, both, plain = [], [], 0
for page in pdf.pages:
    for line in (page.extract_text() or '').splitlines():
        m = LINE.match(line.strip())
        if not m:
            continue
        if m.group(1) == '후면식':
            rear.append(m.group(2))
        elif m.group(1) == '양방향':
            both.append(m.group(2))
        else:
            plain += 1
out = {'source': '경기북부경찰청 무인교통단속장비 PDF (2026-10-31 기준) 장비 목록의 단속방향 칸',
       'rear': sorted(set(rear)), 'both': sorted(set(both))}
with open(sys.argv[2], 'w', encoding='utf-8') as f:
    json.dump(out, f, ensure_ascii=False, indent=0)
print('rear', len(out['rear']), 'two-way', len(out['both']), 'other rows', plain)
