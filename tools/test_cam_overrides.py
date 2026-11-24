"""네이버 고침(tools/cam_overrides.json)이 카메라 자료를 다시 만들어도 남는지 보는 시험 (v214).

    py -I tools/test_cam_overrides.py                     지금 data/cameras.json 으로
    py -I tools/test_cam_overrides.py --real <파일>       실제로 다시 만든 cameras.json 도 함께 (고침 값이 다 들어 있는지)

1. 이미 고친 자료에 다시 붙여도 한 글자도 바뀌지 않는다
2. 다시 만든 것처럼: 고침마다 고치기 전 값(was: 자리·찍는 방향·차로 위 점·후면 표시·설치장소 글)으로 되돌린 뒤 붙이면
   지금 data/cameras.json 과 한 글자도 다르지 않다
3. 원본에서 그 카메라가 바뀌면(제한속도가 다르면) 고치지 않고 'MISSING' 으로 알린다 (조용히 넘어가지 않는다)
4. cameras.json 을 쓰는 다섯 단계(build_cams·osm_cams·osm_arrows·osm_stopline·cam_fill)가 모두 쓰기 직전에 붙인다
실패하면 끝 코드 1.
"""
import copy
import json
import os
import runpy
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
CAMS = os.path.join(ROOT, 'data', 'cameras.json')
OV = runpy.run_path(os.path.join(HERE, 'cam_overrides.py'))
apply, load, find0, problems, texts_of = OV['apply'], OV['load'], OV['find'], OV['problems'], OV['texts_of']


def find(d, o):
    return find0(d['rows'], o, texts_of(d))
STAGES = ['build_cams.py', 'osm_cams.py', 'osm_arrows.py', 'osm_stopline.py', 'cam_fill.py']

fails = []


def check(name, ok, detail=''):
    print(('PASS ' if ok else 'FAIL ') + name + (('  ' + detail) if detail and not ok else ''))
    if not ok:
        fails.append(name)


def dump(d):
    return json.dumps(d, ensure_ascii=False, separators=(',', ':'))


def revert(d, spec):
    """고침을 고치기 전 값으로 되돌린다 (경찰청 원본·OSM 으로 다시 만든 자료처럼)"""
    rows, dirs = d['rows'], d.get('dirs')
    for o in spec['cams']:
        hit = find(d, o)
        assert len(hit) == 1, (o['row'], hit)
        i, w, n = hit[0], o['was'], o['now']
        r = rows[i]
        r[0], r[1] = w['lat'], w['lng']
        # v220: 제한·종류·보호구역·꺼짐
        if 'limit' in n:
            r[2] = w['limit']
        if 'kind' in n:
            r[3] = w['kind']
        if 'zone' in n:
            # v224: was 에 zone 이 없으면 원본 보호구역이 빌드마다 다르다 — 다른 값으로 되돌려도 찾아서 고쳐야 한다
            r[6] = w['zone'] if 'zone' in w else (2 if n['zone'] != 2 else 0)
        if len(r) > 10 and r[10] & 8:   # 다시 만든 자료에는 꺼짐(8)이 없다 (v223: 다시 켠 줄도)
            r[10] &= ~8
            if r[10] == 0:
                r.pop()
        if 'flags' in n and len(r) > 10:
            r[10] = (r[10] & ~n['flags']) | w.get('flags', 0)
            if r[10] == 0:
                r.pop()
        if dirs is not None and dirs[i]:
            if 'eb' in w:
                dirs[i][0] = w['eb']
            if 'e2' in w:   # v224: 양방향 표시
                dirs[i][1] = w['e2']
            if 'snap' in w:
                dirs[i][2], dirs[i][3] = w['snap']
        if w.get('arrow'):
            names = d['arrowNames']
            ids = []
            for nm in w['arrow']:
                if nm not in names:
                    names.append(nm)
                ids.append(names.index(nm))
            d['arrows'] += [i] + ids


def main():
    spec = load()
    with open(CAMS, encoding='utf-8', newline='') as fh:
        raw = fh.read()
    now = json.loads(raw)

    # 1. 이미 고친 자료: 그대로
    d1 = copy.deepcopy(now)
    rep1 = apply(d1, spec)
    check('all overrides found in data/cameras.json', not problems(rep1), json.dumps(rep1, ensure_ascii=False))
    check('applying again changes nothing', dump(d1) == raw)

    # 2. 다시 만든 것처럼 되돌렸다가 붙이기
    d2 = copy.deepcopy(now)
    revert(d2, spec)
    check('revert really undoes the fixes', dump(d2) != raw)
    for o in spec['cams']:
        i = find(d2, o)[0]
        r = d2['rows'][i]
        check('reverted %s %s is back at the police point' % (o['ver'], o['row']), [r[0], r[1]] == [o['was']['lat'], o['was']['lng']])
    rep2 = apply(d2, spec)
    check('simulated rebuild: all overrides found', not problems(rep2), json.dumps(rep2, ensure_ascii=False))
    check('simulated rebuild: result is byte-identical to data/cameras.json', dump(d2) == raw)

    # 고침 값이 실제로 들어 있는지 (사람이 읽는 확인)
    rows, dirs = d2['rows'], d2['dirs']
    al = d2['arrows']
    arrow_rows = {al[k] for k in range(0, len(al) - 2, 3)}
    for o in spec['cams']:
        i = find(d2, o)[0]
        n, r, e = o['now'], rows[i], dirs[i]
        ok = True
        if 'lat' in n:
            ok &= [r[0], r[1]] == [n['lat'], n['lng']]
        if 'eb' in n:
            ok &= e[0] == n['eb']
        if 'e2' in n:
            ok &= e[1] == n['e2']
        if 'snap' in n:
            ok &= [e[2], e[3]] == n['snap']
        if 'flags' in n:
            ok &= len(r) > 10 and (r[10] & n['flags']) == n['flags']
        for k, col in (('limit', 2), ('kind', 3), ('zone', 6)):
            if k in n:
                ok &= r[col] == n[k]
        if n.get('off'):
            ok &= len(r) > 10 and (r[10] & 8) == 8
        else:
            ok &= not (len(r) > 10 and r[10] & 8)   # v223: off 가 없는 고침은 켜져 있어야 한다
        if 'arrow' in n and n['arrow'] is None:
            ok &= i not in arrow_rows
        check('%s %s %s has the Naver values' % (o['ver'], o['row'], o['place']), ok)

    # 3. 원본이 바뀌면 알린다
    d3 = copy.deepcopy(now)
    o = spec['cams'][-1]
    d3['rows'][find(d3, o)[0]][2] += 7   # 고치기 전·뒤 어느 제한속도와도 다른 값
    rep3 = apply(d3, spec)
    check('a camera that changed in the source is reported, not silently skipped', rep3.get('%s %s' % (o['ver'], o['row'])) == 'MISSING', json.dumps(rep3, ensure_ascii=False))

    # 4. 다섯 단계 모두 쓰기 직전에 붙인다
    for s in STAGES:
        with open(os.path.join(HERE, s), encoding='utf-8') as fh:
            src = fh.read()
        hook = src.find("cam_overrides.py')['apply']")
        write = src.rfind("json.dump(")
        check('%s applies the overrides before writing cameras.json' % s, 0 <= hook < write)

    # 실제로 다시 만든 파일
    if '--real' in sys.argv:
        path = sys.argv[sys.argv.index('--real') + 1]
        with open(path, encoding='utf-8') as fh:
            real = json.load(fh)
        rep = apply(copy.deepcopy(real), spec)
        check('real rebuild %s: all overrides found' % path, not problems(rep), json.dumps(rep, ensure_ascii=False))
        same = copy.deepcopy(real)
        apply(same, spec)
        check('real rebuild %s: overrides already applied by the stages' % path, dump(same) == dump(real))

    print('%d failed' % len(fails) if fails else 'all passed')
    return 1 if fails else 0


if __name__ == '__main__':
    sys.exit(main())
