"""설치장소 방향 글 '(A→B)' 로 카메라가 찍는 방향을 확인·보정한다 (v123 카메라 개편 2단계).

    py -X utf8 tools/osm_arrows.py D:/osm/south-korea-latest.osm.pbf

osm_cams.py 다음에 돌린다. 원본 설치장소에 '(용인시기흥장애인복지관→용인서부경찰서)' 처럼 적힌 지명 A, B 를
OSM 의 이름 붙은 곳(역·학교·관공서·교차로·아파트 등)에서 카메라 6km 안으로 찾아, A→B 방향(또는 카메라→B, A→카메라)을
카메라가 붙은 길의 두 방향 중 가까운 쪽으로 맞춘다. 그 방향이
  - osm_cams.py 의 기하 판단(dirs[i][0])과 같으면 '확인'
  - 다르면 글을 따른다 ('보정'): A·B 를 둘 다 찾았고 길 방향과 45° 안으로 맞을 때만
  - 기하로 양방향(가운데)이던 카메라는 글의 방향으로 정한다
결과: dirs[i][0], dirs[i][1] 을 고치고, 통계를 출력한다 (확인 비율 = 기하 판단의 정확도 추정).
"""
import json
import math
import os
import re
import sys
from collections import Counter, defaultdict
import runpy

sys.path.insert(0, r'D:\pylib')
import osmium  # noqa: E402

PBF = sys.argv[1] if len(sys.argv) > 1 else r'D:\osm\south-korea-latest.osm.pbf'
ROOT = __file__.rsplit('tools', 1)[0]
FILES = [ROOT + 'data/cameras.json', ROOT + 'data/mobile.json']
KY = 110540.0
SUFFIX = ['사거리', '삼거리', '오거리', '교차로', '네거리', '입구', '정문', '후문', '방면', '방향', '앞', '부근', '사거리방면']


def kx(lat):
    return 111320.0 * math.cos(math.radians(lat))


def norm(s):
    s = re.sub(r'\(.*?\)', '', s or '')
    s = re.sub(r'[\s·\.\-_,@]', '', s).lower()
    return s


def variants(s):
    n = norm(s)
    out = {n}
    for suf in SUFFIX:
        if n.endswith(suf) and len(n) > len(suf) + 1:
            out.add(n[:-len(suf)])
    m = re.match(r'^(.+?)(\d+)번?출구$', n)
    if m:
        out.add(m.group(1))
    if n.endswith('ic') and len(n) > 3:
        out.add(n[:-2] + 'ic')
        out.add(n[:-2] + '나들목')
    return {v for v in out if len(v) >= 2}


datasets = [json.load(open(f, encoding='utf-8')) for f in FILES]
needed = set()
cam_arrows = []   # (dataset, row, A, B)
for di, d in enumerate(datasets):
    an, al = d.get('arrowNames') or [], d.get('arrows') or []
    for k in range(0, len(al) - 2, 3):
        a, b = an[al[k + 1]], an[al[k + 2]]
        cam_arrows.append((di, al[k], a, b))
        needed |= variants(a) | variants(b)
print('cameras with place arrows', len(cam_arrows), 'names to find', len(needed))


class H(osmium.SimpleHandler):
    def __init__(self):
        super().__init__()
        self.pts = defaultdict(list)

    def add(self, tags, lat, lng):
        for key in ('name', 'name:ko', 'alt_name', 'short_name', 'official_name'):
            v = tags.get(key)
            if not v:
                continue
            for x in variants(v):
                if x in needed and len(self.pts[x]) < 400:
                    self.pts[x].append((lat, lng))

    def node(self, n):
        if n.tags:
            self.add(n.tags, n.location.lat, n.location.lon)

    def way(self, w):
        if not w.tags or 'highway' in w.tags and w.tags.get('highway') not in ('motorway_junction',):
            return   # 길 이름은 빼고(길 전체에 퍼져 있다) 건물·시설·땅 이름만
        try:
            n0 = w.nodes[0]
            n1 = w.nodes[len(w.nodes) // 2]
            self.add(w.tags, (n0.lat + n1.lat) / 2, (n0.lon + n1.lon) / 2)
        except (osmium.InvalidLocationError, IndexError):
            return


h = H()
h.apply_file(PBF, locations=True, idx='flex_mem')
print('names found in OSM', len(h.pts))


def find(name, lat, lng, maxd=6000):
    best = None
    KX = kx(lat)
    # v164: 이름 변형은 정해진 순서로(긴 것 = 더 구체적인 것 먼저). 예전엔 set 순서였는데 파이썬 문자열 해시가 실행마다 달라서
    # 다시 돌릴 때마다 찾는 지명이 바뀌어 방향이 뒤집히는 카메라가 있었다 (H9873·H8894·J5819·J6308/J6307·G3164 등 15대)
    for v in sorted(variants(name), key=lambda x: (-len(x), x)):
        for (la, lo) in h.pts.get(v, ()):
            d = math.hypot((la - lat) * KY, (lo - lng) * KX)
            if d <= maxd and (best is None or d < best[0]):
                best = (d, la, lo)
        if best:
            return best
    return best


def brg(a, b):
    la1, lo1, la2, lo2 = map(math.radians, (a[0], a[1], b[0], b[1]))
    y = math.sin(lo2 - lo1) * math.cos(la2)
    x = math.cos(la1) * math.sin(la2) - math.sin(la1) * math.cos(la2) * math.cos(lo2 - lo1)
    return (math.degrees(math.atan2(y, x)) + 360) % 360


def angd(a, b):
    return abs((a - b + 540) % 360 - 180)


st = Counter()
# v164: osm_cams.py 가 행마다 남긴 '반대 방향 차로' 결과(dirsAlt). 글로 방향을 뒤집을 때 방위만 돌리면 분리된 큰길·고속도로는
# 차로 위 점이 건너편(반대 방향) 차로에 남아 경로선에서 15m 넘게 떨어져 안 울렸다. 이제 그 방향 차로 결과로 바꾼다
alt_of = [d.get('dirsAlt') or [None] * len(d['rows']) for d in datasets]
twin = {}
for di, d in enumerate(datasets):
    pl = d.get('pairs') or []
    for k in range(0, len(pl) - 1, 2):
        twin[(di, pl[k])] = pl[k + 1]
        twin[(di, pl[k + 1])] = pl[k]
by_text = set()   # 글이 방향을 정했거나(보정·가운데) 기하를 확인한 행


def set_dir(di, ri, want):
    """행의 찍는 방향을 want 로: 지금 방위와 60° 안이면 방위만, 아니면 반대 방향 차로 결과(dirsAlt)로 바꾼다"""
    dr = datasets[di]['dirs'][ri]
    if angd(dr[0], want) > 60:
        alt = alt_of[di][ri]
        if alt and alt[0] >= 0 and angd(alt[0], want) <= 60:
            old = list(dr)
            dr[:] = list(alt)
            dr[1] = 0
            alt_of[di][ri] = old
            st['(lane) moved to the other carriageway/side'] += 1
            return
    dr[0], dr[1] = int(round(want)) % 360, 0


def text_dir(c, A, B):
    """설치장소 글이 가리키는 방위와 세기: (방위, True 두 지명 모두 찾음 / False 하나만) 또는 None"""
    cam = (c[0], c[1])
    fa, fb = find(A, *cam), find(B, *cam)
    if fa and fb and fa[0] > 30 and fb[0] > 30:
        return brg(fa[1:], fb[1:]), True
    if fb and fb[0] > 80:
        return brg(cam, fb[1:]), False
    if fa and fa[0] > 80:
        return brg(fa[1:], cam), False
    return None


# v215: 한 기둥 짝은 두 줄을 한 덩어리로 글에 맞춘다 (tools/cam_pairs.py). 예전엔 줄마다 따로 보아 글이 약하면 기하를 그대로 두어
# 다시 만들 때마다 짝 17쌍의 방향이 서로 바뀌었다 (어느 줄이 어느 방향인지는 같은 자리라 기하로 알 수 없다)
CP = runpy.run_path(ROOT + 'tools/cam_pairs.py')
tdir = {}   # (di, 행) -> 글 방위·세기
for di, ri, A, B in cam_arrows:
    tdir[(di, ri)] = text_dir(datasets[di]['rows'][ri], A, B)
pair_rows = set()
for di, d in enumerate(datasets):
    pl = d.get('pairs') or []
    pairs_ = sorted((min(pl[k], pl[k + 1]), max(pl[k], pl[k + 1])) for k in range(0, len(pl) - 1, 2))
    ok_pairs = [(i, j) for i, j in pairs_ if CP['orientable'](d['dirs'][i], d['dirs'][j])]
    for i, j in ok_pairs:
        pair_rows.add((di, i)); pair_rows.add((di, j))
    tv = lambda r, di=di: (lambda x: None if x is None else (x[0], 2 if x[1] else 1))(tdir.get((di, r)))
    for k, v in CP['orient_pairs'](d['rows'], d['dirs'], alt_of[di], ok_pairs, tv).items():
        st[k] += v

for di, ri, A, B in cam_arrows:
    d = datasets[di]
    c = d['rows'][ri]
    dr = d['dirs'][ri]
    if dr[0] < 0:
        st['no road'] += 1
        continue
    if (di, ri) in pair_rows:
        by_text.add((di, ri))   # 짝은 위에서 두 줄을 함께 정했다 (아래 짝 맞추기도 건너뛴다)
        continue
    td = tdir.get((di, ri))
    if td is None:
        st['names not found'] += 1
        continue
    v, strong = td
    axis = dr[0]
    cand = axis if angd(axis, v) <= 90 else (axis + 180) % 360
    off = angd(cand, v)
    if dr[1]:   # 기하로는 양방향(길 가운데): 글이 길 방향과 60° 안으로 맞으면 그 방향으로
        if off <= 60:
            set_dir(di, ri, cand)
            by_text.add((di, ri))
            st['centre → text direction'] += 1
        else:
            st['centre, text off-axis'] += 1
        continue
    if cand == axis:
        by_text.add((di, ri))
        st['geometry confirmed'] += 1
    elif strong and off <= 45:
        set_dir(di, ri, cand)
        by_text.add((di, ri))
        st['geometry corrected by text'] += 1
    else:
        st['conflict kept (weak text)'] += 1

# v164 짝(한 기둥의 반대 방향 카메라 두 대)은 늘 서로 반대: 글이 한쪽만 정했으면 다른 쪽을 그 반대로 (osm_cams.py 가 반대로 붙여 두었으니
# 글이 한쪽을 뒤집으면 둘이 같은 방향이 된다)
for (di, i), j in sorted(twin.items()):
    if i > j or (di, i) in pair_rows:
        continue
    a, b = datasets[di]['dirs'][i], datasets[di]['dirs'][j]
    if a[0] < 0 or b[0] < 0 or angd(a[0], b[0]) >= 120:
        continue
    ti, tj = (di, i) in by_text, (di, j) in by_text
    if ti == tj:
        st['pair: same way, text can not tell' if not ti else 'pair: both texts say the same way'] += 1
        continue
    win, lose = (i, j) if ti else (j, i)
    set_dir(di, lose, (datasets[di]['dirs'][win][0] + 180) % 360)
    st['pair: twin turned opposite after text'] += 1

# v215: 시험용 — TNC_PAIR_VOTES 에 파일 이름을 주면 짝마다 [줄, 줄, 방위, 방위, 글 방위·세기, 글 방위·세기] 를 남긴다 (tools/test_cam_build.py)
if os.environ.get('TNC_PAIR_VOTES'):
    out = []
    for di, d in enumerate(datasets):
        pl = d.get('pairs') or []
        for k in range(0, len(pl) - 1, 2):
            i, j = min(pl[k], pl[k + 1]), max(pl[k], pl[k + 1])
            tv = [tdir.get((di, x)) for x in (i, j)]
            out.append([di, i, j, d['dirs'][i][0], d['dirs'][j][0], d['dirs'][i][1], d['dirs'][j][1],
                        [list(x) if x else None for x in tv]])
    with open(os.environ['TNC_PAIR_VOTES'], 'w', encoding='utf-8') as fh:
        json.dump(out, fh)

for di, d in enumerate(datasets):
    d.pop('dirsAlt', None)   # 앱은 쓰지 않는다 (osm_cams.py 가 이 단계에 넘기려고 남긴 것)
    if di == 0:   # v214: 네이버로 확인한 고침(tools/cam_overrides.json)은 cameras.json 을 쓰기 직전에 다시 붙인다 (다시 만들어도 남게)
        print('naver overrides (tools/cam_overrides.json):', runpy.run_path(ROOT + 'tools/cam_overrides.py')['apply'](d))
    with open(FILES[di], 'w', encoding='utf-8') as fh:
        json.dump(d, fh, ensure_ascii=False, separators=(',', ':'))
print(dict(st))
conf, corr = st['geometry confirmed'], st['geometry corrected by text']
if conf + corr:
    print('geometry agreed with place text in %.1f%% of checkable one-direction cameras' % (100.0 * conf / (conf + corr + st['conflict kept (weak text)'])))
