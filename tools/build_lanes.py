"""국토지리정보원 정밀도로지도(차로 단위 지도)에서 교차로 진입부마다 차로별 갈 수 있는 방향을 뽑는다 -> data/lanes.json

자료: 국토정보플랫폼 정밀도로지도 (map.ngii.go.kr → 정밀도로지도, 시군구·노선별 zip, 로그인 후 내려받기. 공공누리 출처표시)
  zip 안 구간 폴더(SEC001_…)마다 HDMap_UTM52N_타원체고/ 에 SHP 레이어가 있다. 여기서는 셋만 쓴다.
    A2_LINK        차로 하나하나의 중심선. LaneNo(1 = 중앙선 쪽), L_LinkID/R_LinkID(옆 차로), LinkType 1 = 교차로 안 연결선
    B3_SURFACEMARK 노면 표시. Type 1 이 화살표, Kind 5371 직진 5372 좌 5373 우 5374 좌우 5381 직좌 5382 직우 5383 직좌우
                   5391 유턴 5392 좌회전+유턴 (LinkID = 그 화살표가 칠해진 차로)
    A1_NODE        링크 끝점
  zip 의 대부분(GNSS-INS 주행 궤적 txt, 수 GB)은 쓰지 않는다. zip 을 풀지 않고 필요한 SHP 만 메모리로 읽는다.
진입부: 교차로 연결선(LinkType 1)으로 이어지는 차로들(옆 차로끼리 묶음), 정지선 쪽 끝점.
  차로마다 방향 = 정지선 가까이(마지막 화살표에서 15m 안) 칠해진 화살표들. 화살표가 없으면 그 차로에서 나가는 연결선의 방향(유턴 빼고).
  차로가 하나뿐이거나 모든 차로가 같은 진입부(알려 줄 것이 없음)는 뺀다.
출력: {"v":1,"scale":100000,"date","areas":[…],"count","pats":["LU|L|S|RS",…],"d":[dLat,dLng,heading,pat,…]}
  pats 는 차로 줄(왼쪽 1차로부터 '|'로 구분, 한 차로는 L 좌·S 직·R 우·U 유턴 글자들, 모르면 '?'). 위도 순으로 정렬해 차이로 담는다.
사용법: py -I tools/build_lanes.py data/lanes.json [--keep <폴더>] [<정밀도로지도 zip 또는 푼 폴더> ...]
  zip 하나를 처리할 때마다 그 지역에서 뽑은 진입부를 tools/lanes-src/<지역>.json(수십 KB)에 남기고, data/lanes.json 은 그 폴더의
  모든 지역 파일을 합쳐 만든다. 그래서 원본 zip(지역당 수 GB, 대부분 GNSS 주행 궤적)은 처리한 뒤 지워도 되고, 디스크가 모자라면
  몇 개씩 나눠 받아 처리하면 된다 (2026-11-16: 서울·경기를 다 받으면 수백 GB). zip 없이 실행하면 남긴 지역 파일만으로 다시 만든다.
  --keep <폴더>: 원본을 지운 뒤에도 다른 레이어(버스전용차로 B2, 보호구역 A3, 표지 B1, 신호등 C1 …)를 다시 쓸 수 있게 zip 마다
  HDMap_UTM52N_타원체고 폴더들만 <폴더>/<지역>.zip 으로 남긴다 (구 하나에 수 MB). 이 작은 zip 도 그대로 입력으로 쓸 수 있다.
  덜 받은 zip(크기 0, 끝이 잘림, CRC 오류)은 건너뛰고 끝에 목록을 보여 준다.
"""
import collections
import io
import json
import math
import os
import re
import struct
import sys
import zipfile
import zlib

LAYER_DIR = 'HDMap_UTM52N_타원체고'
LAYERS = ('A1_NODE', 'A2_LINK', 'B3_SURFACEMARK')
ARROW = {'5371': 'S', '5372': 'L', '5373': 'R', '5374': 'LR', '5379': 'SU', '5381': 'LS', '5382': 'RS', '5383': 'LRS',
         '5391': 'U', '5392': 'LU'}
CANON = {k.lower(): k for k in ('ID', 'LinkType', 'LaneNo', 'R_LinkID', 'L_LinkID', 'FromNodeID', 'ToNodeID', 'Length', 'LinkID',
                                 'Kind', 'Type', 'UpdateDate')}


# ---------------------------------------------------------------- SHP / DBF (의존성 없이)
def read_dbf(data, enc):
    nrec, hlen, rlen = struct.unpack('<IHH', data[4:12])
    fields, pos = [], 32
    while data[pos] != 0x0D:
        fields.append((data[pos:pos + 11].split(b'\0')[0].decode('ascii', 'replace'), chr(data[pos + 11]), data[pos + 16], data[pos + 17]))
        pos += 32
    rows = []
    for r in range(nrec):
        rec = data[hlen + r * rlen:hlen + (r + 1) * rlen]
        if not rec or rec[:1] == b'*':
            rows.append(None)
            continue
        o, row = 1, {}
        for name, typ, ln, dec in fields:
            s = rec[o:o + ln].decode(enc, 'replace').strip().strip('\0')
            o += ln
            if typ in 'NF':
                try:
                    s = float(s) if (dec or '.' in s) else int(s)
                except ValueError:
                    s = None
            row[CANON.get(name.lower(), name)] = s
        rows.append(row)
    return rows


def read_shp(data):
    pos, out = 100, []
    while pos + 8 <= len(data):
        clen = struct.unpack('>i', data[pos + 4:pos + 8])[0]
        b = data[pos + 8:pos + 8 + clen * 2]
        pos += 8 + clen * 2
        t = struct.unpack('<i', b[:4])[0] if len(b) >= 4 else 0
        if t in (1, 11, 21):
            out.append([struct.unpack('<dd', b[4:20])])
        elif t in (3, 5, 13, 15, 23, 25):
            nparts, npts = struct.unpack('<ii', b[36:44])
            p0 = 44 + 4 * nparts
            first = struct.unpack('<%di' % nparts, b[44:p0]) if nparts else (0,)
            end = first[1] if nparts > 1 else npts   # 첫 부분만 (차로 선·화살표는 한 부분)
            out.append([struct.unpack('<dd', b[p0 + 16 * k:p0 + 16 * k + 16]) for k in range(end)])
        else:
            out.append(None)
    return out


def layer(files, name):
    """files: {basename(lower): bytes} for one section folder"""
    shp, dbf = files.get(name.lower() + '.shp'), files.get(name.lower() + '.dbf')
    if not shp or not dbf:
        return []
    cpg = (files.get(name.lower() + '.cpg') or b'').decode('ascii', 'replace').lower()
    enc = 'utf-8' if 'utf' in cpg else 'cp949'
    return [(g, r) for g, r in zip(read_shp(shp), read_dbf(dbf, enc)) if g and r]


def sections(src, kz=None):
    """{section name: {file: bytes}} for each section folder in a zip or an extracted folder.
    kz: an open ZipFile that gets a copy of every file in the vector layer folders (all layers, not only LAYERS)"""
    groups = collections.defaultdict(dict)
    if os.path.isdir(src):
        for root, dirs, fs in os.walk(src):
            if os.path.basename(root) != LAYER_DIR:
                continue
            sec = os.path.relpath(os.path.dirname(root), src).replace('\\', '/')
            groups[sec]   # noqa: B018  (레이어 파일이 없어도 구간으로 센다)
            for f in fs:
                want = f.rsplit('.', 1)[0].upper() in LAYERS
                if not (want or kz):
                    continue
                with open(os.path.join(root, f), 'rb') as fh:
                    data = fh.read()
                if kz:
                    kz.writestr(sec + '/' + LAYER_DIR + '/' + f, data)
                if want:
                    groups[sec][f.lower()] = data
        return dict(groups)
    with zipfile.ZipFile(src) as z:
        for i in z.infolist():
            n = i.filename
            if not (i.flag_bits & 0x800):
                try:
                    n = n.encode('cp437').decode('cp949')
                except (UnicodeEncodeError, UnicodeDecodeError):
                    pass
            parts = n.replace('\\', '/').split('/')
            if len(parts) < 2 or parts[-2] != LAYER_DIR or not parts[-1]:
                continue
            want = parts[-1].rsplit('.', 1)[0].upper() in LAYERS
            if not (want or kz):
                continue
            data = z.read(i)   # CRC 도 여기서 확인된다 (끝이 잘린 zip 이면 오류)
            if kz:
                kz.writestr('/'.join(parts), data)
            if want:
                groups['/'.join(parts[:-2])][parts[-1].lower()] = data
    return dict(groups)


# ---------------------------------------------------------------- 좌표
def utm_to_ll(x, y, zone=52):
    a, f, k0 = 6378137.0, 1 / 298.257223563, 0.9996
    e2 = f * (2 - f)
    ep2 = e2 / (1 - e2)
    mu = y / k0 / (a * (1 - e2 / 4 - 3 * e2 * e2 / 64 - 5 * e2 ** 3 / 256))
    e1 = (1 - math.sqrt(1 - e2)) / (1 + math.sqrt(1 - e2))
    p = (mu + (3 * e1 / 2 - 27 * e1 ** 3 / 32) * math.sin(2 * mu) + (21 * e1 * e1 / 16 - 55 * e1 ** 4 / 32) * math.sin(4 * mu)
         + (151 * e1 ** 3 / 96) * math.sin(6 * mu) + (1097 * e1 ** 4 / 512) * math.sin(8 * mu))
    c1, t1 = ep2 * math.cos(p) ** 2, math.tan(p) ** 2
    n1 = a / math.sqrt(1 - e2 * math.sin(p) ** 2)
    r1 = a * (1 - e2) / (1 - e2 * math.sin(p) ** 2) ** 1.5
    d = (x - 500000.0) / (n1 * k0)
    lat = p - (n1 * math.tan(p) / r1) * (d * d / 2 - (5 + 3 * t1 + 10 * c1 - 4 * c1 * c1 - 9 * ep2) * d ** 4 / 24
                                         + (61 + 90 * t1 + 298 * c1 + 45 * t1 * t1 - 252 * ep2 - 3 * c1 * c1) * d ** 6 / 720)
    lng = (d - (1 + 2 * t1 + c1) * d ** 3 / 6 + (5 - 2 * c1 + 28 * t1 + 24 * ep2 - 3 * c1 * c1 + 8 * t1 * t1) * d ** 5 / 120) / math.cos(p)
    return math.degrees(lat), (zone - 1) * 6 - 180 + 3 + math.degrees(lng)


def heading(a, b):
    return math.degrees(math.atan2(b[0] - a[0], b[1] - a[1])) % 360   # 0 = 북, 시계 방향


def end_heading(g, back=8.0):
    acc = 0.0
    for k in range(len(g) - 2, -1, -1):
        acc += math.dist(g[k], g[k + 1])
        if acc >= back:
            return heading(g[k], g[-1])
    return heading(g[0], g[-1])


def maneuver(d):
    d = (d + 540) % 360 - 180   # + = 오른쪽
    if abs(d) <= 30:
        return 'S'
    if abs(d) > 150:
        return 'U'
    return 'R' if d > 0 else 'L'


# ---------------------------------------------------------------- 진입부
def approaches(links, marks):
    out_of = collections.defaultdict(list)
    for k, L in links.items():
        out_of[L['FromNodeID']].append(k)
    conn = lambda k: links[k]['LinkType'] == '1'   # noqa: E731
    appr = {}
    for k, L in links.items():
        if conn(k):
            continue
        cs = [o for o in out_of.get(L['ToNodeID'], []) if conn(o)]
        if not cs:
            continue
        h0 = end_heading(L['g'])
        moves = set()
        for c in cs:
            cur, hop = c, 0
            while hop < 4:   # 교차로 안 연결선이 여러 개로 이어져 있으면 끝까지
                nx = [o for o in out_of.get(links[cur]['ToNodeID'], []) if conn(o)]
                if len(nx) != 1:
                    break
                cur, hop = nx[0], hop + 1
            moves.add(maneuver(end_heading(links[cur]['g']) - h0))
        appr[k] = {'h': h0, 'moves': moves - {'U'}, 'arrows': [], 'end': L['g'][-1]}
    # 화살표 → 같은 차로를 따라 앞으로(갈림 없이) 150m 안의 진입 차로, 정지선까지 거리와 함께
    for m in marks:
        if m.get('Type') != '1' or m.get('Kind') not in ARROW or m.get('LinkID') not in links:
            continue
        cur, dist, c = m['LinkID'], 0.0, m['c']
        first = True
        while cur not in appr and dist < 150:
            nx = [o for o in out_of.get(links[cur]['ToNodeID'], []) if not conn(o)]
            if len(nx) != 1:
                break
            g = links[cur]['g']
            dist += (math.dist(c, g[-1]) if first else (links[cur]['Length'] or 0))
            first = False
            cur = nx[0]
        if cur in appr:
            to_stop = (math.dist(c, appr[cur]['end']) if first else dist + (links[cur]['Length'] or 0))
            appr[cur]['arrows'].append((to_stop, ARROW[m['Kind']]))
    # 옆 차로끼리 묶기
    parent = {k: k for k in appr}

    def find(k):
        while parent[k] != k:
            parent[k] = parent[parent[k]]
            k = parent[k]
        return k
    for k in appr:
        for nb in (links[k]['L_LinkID'], links[k]['R_LinkID']):
            if nb in appr and math.dist(appr[k]['end'], appr[nb]['end']) < 25:
                parent[find(k)] = find(nb)
    groups = collections.defaultdict(list)
    for k in appr:
        groups[find(k)].append(k)
    out = []
    for g in groups.values():
        if len(g) < 2:
            continue
        hx = sum(math.sin(math.radians(appr[k]['h'])) for k in g)
        hy = sum(math.cos(math.radians(appr[k]['h'])) for k in g)
        h = math.degrees(math.atan2(hx, hy)) % 360
        cx = sum(appr[k]['end'][0] for k in g) / len(g)
        cy = sum(appr[k]['end'][1] for k in g) / len(g)
        rx, ry = math.cos(math.radians(h)), -math.sin(math.radians(h))   # 진행 방향의 오른쪽
        g.sort(key=lambda k: (appr[k]['end'][0] - cx) * rx + (appr[k]['end'][1] - cy) * ry)
        lanes = []
        for k in g:
            arr = sorted(appr[k]['arrows'])
            if arr:   # 정지선에 가장 가까운 화살표(들)만 (위쪽 차로가 합쳐 들어오며 다른 화살표가 섞이지 않게)
                near = arr[0][0]
                s = set(''.join(a for d, a in arr if d - near <= 15))
            else:
                s = set(appr[k]['moves'])
            lanes.append(''.join(c for c in 'LSRU' if c in s) or '?')
        if len(set(lanes)) < 2:
            continue   # 모든 차로가 같으면 알려 줄 것이 없음
        lat, lng = utm_to_ll(cx, cy)
        out.append((lat, lng, round(h) % 360, '|'.join(lanes)))
    return out


CACHE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'lanes-src')


def extract(src, keepdir=None):
    """zip(또는 푼 폴더) 하나 → tools/lanes-src/<지역>.json (+ keepdir/<지역>.zip). 지역 파일을 만들었으면 True"""
    name = re.sub(r'^\(B110\)정밀도로지도_', '', os.path.basename(src.rstrip('/\\'))).replace('.zip', '')
    kz = kpath = None
    if keepdir and os.path.dirname(os.path.abspath(src)) != os.path.abspath(keepdir):   # 남긴 zip 을 다시 처리할 때는 그대로
        os.makedirs(keepdir, exist_ok=True)
        kpath = os.path.join(keepdir, name + '.zip')
        kz = zipfile.ZipFile(kpath + '.part', 'w', zipfile.ZIP_DEFLATED)
    try:
        secs = sections(src, kz)
    finally:
        if kz:
            kz.close()
    if kz:
        if secs:
            os.replace(kpath + '.part', kpath)
        else:
            os.remove(kpath + '.part')
    links, marks, n, dates = {}, [], len(secs), set()
    for sec in sorted(secs):
        files = secs[sec]
        for g, r in layer(files, 'A2_LINK'):
            r['g'] = g
            links[r['ID']] = r
            if r.get('UpdateDate'):
                dates.add(str(r['UpdateDate'])[:6])
        for g, r in layer(files, 'B3_SURFACEMARK'):
            r['c'] = (sum(p[0] for p in g) / len(g), sum(p[1] for p in g) / len(g))
            marks.append(r)
    ap = approaches(links, marks)
    print('%s: %d sections, %d lane links, %d marks -> %d approaches' % (name, n, len(links), len(marks), len(ap)))
    if not n:
        print('  (구간이 없음: 덜 받은 zip 이거나 정밀도로지도 zip 이 아님 — 지역 파일을 만들지 않음)')
        return False
    os.makedirs(CACHE, exist_ok=True)
    doc = {'area': name, 'date': max(dates) if dates else '', 'sections': n,
           'ap': [[round(a[0], 6), round(a[1], 6), a[2], a[3]] for a in ap]}
    with io.open(os.path.join(CACHE, name + '.json'), 'w', encoding='utf-8', newline='\n') as f:
        json.dump(doc, f, ensure_ascii=False, separators=(',', ':'))
    return True


def main(out, srcs, keepdir=None):
    done, bad = [], []
    for src in srcs:
        try:
            ok = extract(src, keepdir)
        except (zipfile.BadZipFile, zlib.error, EOFError, OSError) as e:
            print('%s: 건너뜀 (%s: %s)' % (os.path.basename(src), type(e).__name__, e))
            ok = False
        (done if ok else bad).append(src)
    if srcs:
        print('처리함 %d: %s' % (len(done), ', '.join(os.path.basename(s) for s in done)))
        if bad:
            print('못 함 %d (다시 받기): %s' % (len(bad), ', '.join(os.path.basename(s) for s in bad)))
    allap, areas, dates = [], [], set()
    for fn in sorted(os.listdir(CACHE)) if os.path.isdir(CACHE) else []:
        if not fn.endswith('.json'):
            continue
        doc = json.load(io.open(os.path.join(CACHE, fn), encoding='utf-8'))
        areas.append(doc['area'])
        if doc.get('date'):
            dates.add(doc['date'])
        allap.extend(tuple(a) for a in doc['ap'])
    # 겹치는 자료(시군구와 노선이 같은 교차로를 담은 경우): 3m 안·같은 방향이면 하나만
    allap.sort()
    keep = []
    for a in allap:
        if any(abs(a[0] - b[0]) < 3e-5 and abs(a[1] - b[1]) < 4e-5 and abs((a[2] - b[2] + 180) % 360 - 180) < 20 for b in keep[-40:]):
            continue
        keep.append(a)
    pats, pidx, d = [], {}, []
    pa = pb = 0
    for lat, lng, h, pat in keep:
        if pat not in pidx:
            pidx[pat] = len(pats)
            pats.append(pat)
        a, b = round(lat * 1e5), round(lng * 1e5)
        d += [a - pa, b - pb, h, pidx[pat]]
        pa, pb = a, b
    date = max(dates) if dates else ''
    doc = {'v': 1, 'scale': 100000, 'date': (date[:4] + '-' + date[4:6]) if len(date) >= 6 else date,
           'src': '국토지리정보원 정밀도로지도', 'areas': areas, 'count': len(keep), 'pats': pats, 'd': d}
    with io.open(out, 'w', encoding='utf-8', newline='\n') as f:
        json.dump(doc, f, ensure_ascii=False, separators=(',', ':'))
    print('wrote %s: %d approaches, %d lane patterns, %d bytes' % (out, len(keep), len(pats), os.path.getsize(out)))


if __name__ == '__main__':
    args, keep = sys.argv[1:], None
    if '--keep' in args:
        i = args.index('--keep')
        keep = args[i + 1]
        del args[i:i + 2]
    if not args:
        sys.exit(__doc__)
    main(args[0], args[1:], keep)
