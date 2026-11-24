"""네이버로 확인한 고정 카메라 고침(tools/cam_overrides.json)을 cameras.json 자료에 다시 붙인다 (v214).

경찰청 원본·OSM 으로 카메라 자료를 다시 만들면(build_cams.py → osm_cams.py → osm_arrows.py → osm_stopline.py → cam_fill.py)
손으로 고친 줄(v194 난곡로 방향, v201 둔촌사거리 자리, v213 용구대로 북행·남북대로 후면)이 사라진다.
그래서 cameras.json 을 쓰는 다섯 단계가 모두 파일을 쓰기 직전에 apply() 를 부른다 — 어느 단계만 다시 돌려도 고침이 남는다.

  - 찾기: 고치기 전(was) 자리 또는 고친 뒤(now) 자리에서 3m 안, 제한속도·종류가 같은 줄이 꼭 하나일 때만 고친다.
    없거나(원본에서 빠짐·제한이 바뀜) 둘 이상이면 고치지 않고 알린다 — 사람이 네이버로 다시 볼 일
  - 고치는 것: 자리(lat·lng), 찍는 방향(dirs[0]), 양방향(dirs[1]), 차로 위 점 차(dirs[2]·dirs[3]), 후면 표시(flags, 덧붙임),
    설치장소 글 'A→B'(arrow: null 이면 뺀다). dirs 가 아직 없는 단계(build_cams)에서는 dirs 쪽만 건너뛴다
  - 몇 번을 붙여도 같다 (이미 고친 자료에 다시 붙여도 그대로)

다른 단계에서 쓰기:
    OVR = runpy.run_path(ROOT + 'tools/cam_overrides.py')['apply']
    print('naver overrides:', OVR(data))

혼자 돌리기 (지금 자료에 붙이고 결과를 알림):
    py -I tools/cam_overrides.py [data/cameras.json]
시험 (다시 만든 것처럼 고침을 풀었다가 붙여서 지금 자료와 한 글자도 다르지 않은지): py -I tools/test_cam_overrides.py
"""
import json
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SPEC = os.path.join(HERE, 'cam_overrides.json')
NEAR_M = 3.0


def load(path=SPEC):
    with open(path, encoding='utf-8') as fh:
        return json.load(fh)


def dist_m(a_lat, a_lng, b_lat, b_lng):
    return math.hypot((a_lat - b_lat) * 110540.0, (a_lng - b_lng) * 111320.0 * math.cos(math.radians((a_lat + b_lat) / 2)))


def texts_of(d):
    """줄 번호 -> 설치장소 글 [A, B] (없으면 없음)"""
    al, an = d.get('arrows') or [], d.get('arrowNames') or []
    return {al[k]: [an[al[k + 1]], an[al[k + 2]]] for k in range(0, len(al) - 2, 3)}


OFF = 8   # v220: flags 8 — 네이버에 없는 줄 (앱이 찾기·지도·경고에서 뺀다)


def _keys_ok(r, w, n):
    """제한·종류·보호구역이 고치기 전(was) 또는 고친 뒤(now) 값과 같은지 (v220: now 에 limit·kind·zone 이 있을 수 있다)"""
    def same(lim, kind, zone):
        return r[2] == lim and r[3] == kind and (zone is None or r[6] == zone)
    wz = w.get('zone')
    return same(w['limit'], w['kind'], wz) or same(n.get('limit', w['limit']), n.get('kind', w['kind']), n.get('zone', wz))


def find(rows, o, texts=None):
    """v215: 한 기둥 짝의 두 줄은 자리·제한·종류가 같아서, was 에 zone(보호구역)·text(설치장소 글, null 이면 글 없음)가 있으면 그것도 맞춘다"""
    w, n = o['was'], o['now']
    spots = [(w['lat'], w['lng'])] + ([(n['lat'], n['lng'])] if 'lat' in n else [])
    out = []
    for i, r in enumerate(rows):
        if not _keys_ok(r, w, n):
            continue
        if 'text' in w and (texts or {}).get(i) not in (w['text'], n.get('arrow', w['text']) if 'arrow' in n else w['text']):
            continue
        if any(dist_m(r[0], r[1], la, lo) <= NEAR_M for la, lo in spots):
            out.append(i)
    return out


def drop_arrow(d, i):
    al = d.get('arrows')
    if not al:
        return False
    keep, gone = [], False
    for k in range(0, len(al) - 2, 3):
        if al[k] == i:
            gone = True
            continue
        keep += al[k:k + 3]
    if gone:
        d['arrows'] = keep
    return gone


def apply(d, spec=None):
    """d: cameras.json 자료(dict). 고친 줄마다 결과 {'row 21232': 'ok 21232', ...}, 못 찾으면 'MISSING'·'AMBIGUOUS [..]'"""
    spec = spec or load()
    rows, dirs = d['rows'], d.get('dirs')
    texts = texts_of(d)
    report = {}
    for o in spec['cams']:
        key = '%s %s' % (o['ver'], o['row'])
        hit = find(rows, o, texts)
        if len(hit) != 1:
            report[key] = 'MISSING' if not hit else 'AMBIGUOUS %s' % hit
            continue
        i, n = hit[0], o['now']
        r = rows[i]
        if 'lat' in n:
            r[0], r[1] = n['lat'], n['lng']
        if 'limit' in n:
            r[2] = n['limit']
        if 'kind' in n:
            r[3] = n['kind']
        if 'zone' in n:
            r[6] = n['zone']
        if n.get('off'):
            f = (r[10] if len(r) > 10 else 0) | OFF
            if len(r) > 10:
                r[10] = f
            else:
                r.append(f)
        elif len(r) > 10 and r[10] & OFF:
            # v223: 판정이 바뀌어 다시 켠 줄 — 꺼짐(8)은 이 파일만 정한다(경찰 원본·OSM 단계에는 없다)
            r[10] &= ~OFF
            if not r[10]:
                r.pop()
        if 'flags' in n:
            f = (r[10] if len(r) > 10 else 0) | n['flags']
            if len(r) > 10:
                r[10] = f
            elif f:
                r.append(f)
        if dirs is not None and i < len(dirs) and dirs[i]:
            e = dirs[i]
            if 'eb' in n:
                e[0] = n['eb']
            if 'e2' in n:
                e[1] = n['e2']
            if 'snap' in n and len(e) > 3:
                e[2], e[3] = n['snap']
        if 'arrow' in n and n['arrow'] is None:
            drop_arrow(d, i)
        report[key] = 'ok %d' % i
    return report


def problems(report):
    return {k: v for k, v in report.items() if not v.startswith('ok')}


if __name__ == '__main__':
    path = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(HERE), 'data', 'cameras.json')
    with open(path, encoding='utf-8', newline='') as fh:
        raw = fh.read()
    data = json.loads(raw)
    rep = apply(data)
    out = json.dumps(data, ensure_ascii=False, separators=(',', ':'))
    if out != raw:
        with open(path, 'w', encoding='utf-8', newline='') as fh:
            fh.write(out)
        print('written', path)
    else:
        print('already applied', path)
    print(json.dumps(rep, ensure_ascii=False))
    sys.exit(1 if problems(rep) else 0)
