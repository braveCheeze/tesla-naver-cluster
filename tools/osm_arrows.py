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
import re
import sys
from collections import Counter, defaultdict

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
    for v in variants(name):
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
for di, ri, A, B in cam_arrows:
    d = datasets[di]
    c = d['rows'][ri]
    dr = d['dirs'][ri]
    if dr[0] < 0:
        st['no road'] += 1
        continue
    cam = (c[0], c[1])
    fa, fb = find(A, *cam), find(B, *cam)
    if fa and fb and fa[0] > 30 and fb[0] > 30:
        v = brg(fa[1:], fb[1:])
        strong = True
    elif fb and fb[0] > 80:
        v = brg(cam, fb[1:])
        strong = False
    elif fa and fa[0] > 80:
        v = brg(fa[1:], cam)
        strong = False
    else:
        st['names not found'] += 1
        continue
    axis = dr[0]
    cand = axis if angd(axis, v) <= 90 else (axis + 180) % 360
    off = angd(cand, v)
    if dr[1]:   # 기하로는 양방향(길 가운데): 글이 길 방향과 60° 안으로 맞으면 그 방향으로
        if off <= 60:
            dr[0], dr[1] = int(round(cand)) % 360, 0
            st['centre → text direction'] += 1
        else:
            st['centre, text off-axis'] += 1
        continue
    if cand == axis:
        st['geometry confirmed'] += 1
    elif strong and off <= 45:
        dr[0] = int(round(cand)) % 360
        st['geometry corrected by text'] += 1
    else:
        st['conflict kept (weak text)'] += 1

for di, d in enumerate(datasets):
    with open(FILES[di], 'w', encoding='utf-8') as fh:
        json.dump(d, fh, ensure_ascii=False, separators=(',', ':'))
print(dict(st))
conf, corr = st['geometry confirmed'], st['geometry corrected by text']
if conf + corr:
    print('geometry agreed with place text in %.1f%% of checkable one-direction cameras' % (100.0 * conf / (conf + corr + st['conflict kept (weak text)'])))
