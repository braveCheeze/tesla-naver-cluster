"""카메라 자료 만들기 시험 (v215): 같은 입력이면 한 글자도 같은 결과, 한 기둥 짝의 방향은 제 줄의 설치장소 글과 맞게.

    py -I tools/test_cam_build.py                                   짝 맞추기 단위 시험만 (빠름)
    py -I tools/test_cam_build.py --build <경찰청 CSV> <OSM pbf>     + 실제로 두 번 다시 만들어 비교 (약 10분)
          [--work <폴더>]   두 번 만든 결과를 둘 곳 (기본: 임시 폴더, 끝나면 남겨 둔다)

--build 는 저장소의 tools/ 와 data/mobile.json 을 작업 폴더 두 곳(a·b)에 복사해 build_cams → osm_cams → osm_arrows →
osm_stopline → cam_fill 을 파이썬 문자열 해시 씨앗을 달리해(1·2) 따로 돌리고 확인한다:
  1. 두 cameras.json 이 바이트까지 같다 (mobile.json 도)
  2. 한 기둥 짝마다 두 줄의 글 표(글 방위와 90° 안이면 +세기, 아니면 -세기)의 합이 0 보다 작지 않다 — 글과 거꾸로인 짝이 없다
  3. 뒤 단계(osm_stopline·cam_fill·네이버 고침)가 짝의 방향을 바꾸지 않는다
  4. 네이버 고침(tools/cam_overrides.json)이 다 들어 있다
저장소의 data/ 는 건드리지 않는다. 실패하면 끝 코드 1.
"""
import json
import os
import runpy
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
CP = runpy.run_path(os.path.join(HERE, 'cam_pairs.py'))
fails = []


def check(name, ok, detail=''):
    print(('PASS ' if ok else 'FAIL ') + name + (('  ' + str(detail)[:600]) if detail and not ok else ''))
    if not ok:
        fails.append(name)


# ---------------- 단위 시험: 짝 맞추기 ----------------
def unit():
    rows = [[37.5, 127.0, 50, 3], [37.5, 127.0, 50, 3], [37.6, 127.1, 60, 3], [37.6, 127.1, 60, 3]]

    def fresh():
        # 줄 0·1: 같은 기둥, 줄 0 은 북(0°)·차로 위 점 +10, 줄 1 은 남(180°)·-10. 줄 2·3: 같은 기둥
        return ([[0, 0, 10, 0, 0, 7, 1], [180, 0, -10, 0, 0, 8, 1], [90, 0, 0, 5, 0, 9], [270, 0, 0, -5, 0, 9]],
                [[180, 0, -10, 0, 0, 8], [0, 0, 10, 0, 0, 7], None, None])

    # (a) 두 줄의 글이 모두 지금 방향과 반대(줄 0 글은 남쪽, 줄 1 글은 북쪽, 약한 글) → 바꾼다, 차로 위 점은 방향을 따라간다
    d, a = fresh()
    tv = {0: (175, 1), 1: (5, 1)}
    st = CP['orient_pairs'](rows, d, a, [(0, 1)], tv.get)
    check('pair whose two texts both disagree is swapped', st['pair: swapped to match text'] == 1 and d[0][0] == 180 and d[1][0] == 0)
    check('lane point and road name move with the direction', d[0][2] == -10 and d[0][5] == 8 and d[1][2] == 10 and d[1][5] == 7)
    check('the alternative lane results are swapped too', a[0][0] == 0 and a[1][0] == 180)
    # (b) 줄 순서와 상관없다: (1, 0) 으로 줘도 같은 결과
    d2, a2 = fresh()
    CP['orient_pairs'](rows, d2, a2, [(1, 0)], tv.get)
    check('result does not depend on the order the pair is given in', d2 == d)
    # (c) 같은 짝을 줄을 바꿔 넣은 자료(줄 0 ↔ 1, 글도 함께)에서도 글마다 같은 방향
    d3 = [[180, 0, -10, 0, 0, 8, 1], [0, 0, 10, 0, 0, 7, 1]]
    tv3 = {0: (5, 1), 1: (175, 1)}
    CP['orient_pairs'](rows[:2], d3, None, [(0, 1)], tv3.get)
    check('each text gets the same direction when the two rows come in the other order', d3[0][0] == 0 and d3[1][0] == 180)
    # (d) 센 글이 약한 글을 이긴다, 맞서면(0) 그대로
    d4, _ = fresh()
    st4 = CP['orient_pairs'](rows, d4, None, [(0, 1)], {0: (5, 2), 1: (10, 1)}.get)   # 줄 0 센 글 맞음(+2), 줄 1 약한 글 틀림(-1)
    check('a strong text outweighs a weak one (kept)', st4['pair: text agrees'] == 1 and d4[0][0] == 0)
    d5, _ = fresh()
    st5 = CP['orient_pairs'](rows, d5, None, [(0, 1)], {0: (5, 1), 1: (10, 1)}.get)
    check('texts that cancel out leave the pair as it is', st5['pair: text can not tell'] == 1 and d5[0][0] == 0 and d5[1][0] == 180)
    d6, _ = fresh()
    st6 = CP['orient_pairs'](rows, d6, None, [(0, 1)], {}.get)
    check('no text: the pair stays as the geometry step left it', st6['pair: text can not tell'] == 1 and d6[0][0] == 0)
    # (d2) 글 방위가 길과 거의 직각(60~120°)이면 표가 없다 — 지명이 길 옆이라 앞뒤를 못 가른다
    d9, _ = fresh()
    st9 = CP['orient_pairs'](rows, d9, None, [(0, 1)], {0: (95, 2), 1: (265, 2)}.get)
    check('a text pointing across the road does not vote', st9['pair: text can not tell'] == 1 and d9[0][0] == 0 and CP['vote'](0, (100, 2)) == 0)
    # (e) 길에 못 붙은 줄이 있거나 같은 방향이면 손대지 않는다
    d7 = [[-1, 0, 0, 0, 0, -1], [180, 0, 0, 0, 0, 3]]
    st7 = CP['orient_pairs'](rows[:2], d7, None, [(0, 1)], {0: (0, 2), 1: (0, 2)}.get)
    check('a pair with a row off the road is not touched', st7['pair: not orientable'] == 1 and d7[1][0] == 180)
    # (f) 기둥이 몇 m 다른 짝: 바꿔도 차로 위 점의 절대 자리는 그대로
    rr = [[37.50000, 127.00000, 50, 3], [37.50003, 127.00002, 50, 3]]
    d8 = [[0, 0, 4, 1, 0, 1], [180, 0, -2, -3, 0, 1]]
    before = {(round(rr[k][0] + d8[k][2] / 1e5, 6), round(rr[k][1] + d8[k][3] / 1e5, 6), d8[k][0]) for k in (0, 1)}
    CP['orient_pairs'](rr, d8, None, [(0, 1)], {0: (180, 2), 1: (0, 2)}.get)
    after = {(round(rr[k][0] + d8[k][2] / 1e5, 6), round(rr[k][1] + d8[k][3] / 1e5, 6), d8[k][0]) for k in (0, 1)}
    check('swapping keeps each direction on its own lane point', before == after and d8[0][0] == 180)


# ---------------- 실제로 두 번 만들기 ----------------
STAGES = [
    ('build_cams', ['-I', '-X', 'utf8', 'tools/build_cams.py', '{csv}', 'data/cameras.json']),
    ('osm_cams', ['-X', 'utf8', 'tools/osm_cams.py', '{pbf}']),
    ('osm_arrows', ['-X', 'utf8', 'tools/osm_arrows.py', '{pbf}']),
    ('osm_stopline', ['-X', 'utf8', 'tools/osm_stopline.py', '{pbf}']),
    ('cam_fill', ['-I', '-X', 'utf8', 'tools/cam_fill.py', '{pbf}', '--old', '{old}']),
]


def prepare(work, name):
    d = os.path.join(work, name)
    os.makedirs(os.path.join(d, 'data'), exist_ok=True)
    shutil.copytree(HERE, os.path.join(d, 'tools'), ignore=shutil.ignore_patterns('__pycache__', 'icon-src', 'lanes-src'), dirs_exist_ok=True)
    shutil.copy(os.path.join(ROOT, 'data', 'mobile.json'), os.path.join(d, 'data', 'mobile.json'))
    old = os.path.join(d, 'old')
    os.makedirs(old, exist_ok=True)
    for f in ('cameras.json', 'mobile.json'):
        shutil.copy(os.path.join(ROOT, 'data', f), os.path.join(old, f))
    return d


def run_chain(d, seed, csv, pbf):
    env = dict(os.environ, PYTHONHASHSEED=str(seed), TNC_PAIR_VOTES=os.path.join(d, 'pair_votes.json'))
    py = shutil.which('py') or sys.executable
    log = open(os.path.join(d, 'build.log'), 'w', encoding='utf-8')
    for name, args in STAGES:
        args = [a.format(csv=csv, pbf=pbf, old=os.path.join(d, 'old')) for a in args]
        log.write('== %s\n' % name)
        log.flush()
        r = subprocess.run([py] + args, cwd=d, env=env, stdout=log, stderr=subprocess.STDOUT)
        if r.returncode:
            log.close()
            return name
        if name == 'osm_arrows':
            shutil.copy(os.path.join(d, 'data', 'cameras.json'), os.path.join(d, 'after_arrows.json'))
    log.close()
    return None


def build(csv, pbf, work):
    import threading
    a, b = prepare(work, 'a'), prepare(work, 'b')
    errs = {}
    ts = [threading.Thread(target=lambda d=d, s=s: errs.__setitem__(d, run_chain(d, s, csv, pbf))) for d, s in ((a, 1), (b, 2))]
    for t in ts:
        t.start()
    for t in ts:
        t.join()
    check('both rebuilds finished', not any(errs.values()), errs)
    if any(errs.values()):
        return
    for f in ('cameras.json', 'mobile.json'):
        x = open(os.path.join(a, 'data', f), 'rb').read()
        y = open(os.path.join(b, 'data', f), 'rb').read()
        check('two rebuilds give a byte-identical %s (hash seeds 1 and 2)' % f, x == y, '%d vs %d bytes' % (len(x), len(y)))
    cam = json.load(open(os.path.join(a, 'data', 'cameras.json'), encoding='utf-8'))
    votes = json.load(open(os.path.join(a, 'pair_votes.json'), encoding='utf-8'))
    bad, moved, decided = [], [], 0
    for di, i, j, ei, ej, ci, cj, tv in votes:
        if di != 0:
            continue
        if ei < 0 or ej < 0 or ci or cj:
            continue
        t = [None if x is None else (x[0], 2 if x[1] else 1) for x in tv]
        s = CP['vote'](ei, t[0]) + CP['vote'](ej, t[1])
        if t[0] or t[1]:
            decided += 1
        if s < 0:
            bad.append((i, j, ei, ej, tv))
        fi, fj = cam['dirs'][i][0], cam['dirs'][j][0]
        if CP['angd'](fi, ei) > 60 or CP['angd'](fj, ej) > 60:
            moved.append((i, j, ei, fi, ej, fj))
    check('every pole pair agrees with its place text (%d pairs with text)' % decided, not bad, bad[:10])
    check('later stages do not turn pole pairs around', not moved, moved[:10])
    ov = runpy.run_path(os.path.join(HERE, 'cam_overrides.py'))
    rep = ov['apply'](json.loads(json.dumps(cam)))
    check('Naver overrides are in the rebuilt file', not ov['problems'](rep), rep)
    print('rebuilt files kept in', work)


def main():
    unit()
    if '--build' in sys.argv:
        k = sys.argv.index('--build')
        csv, pbf = sys.argv[k + 1], sys.argv[k + 2]
        work = sys.argv[sys.argv.index('--work') + 1] if '--work' in sys.argv else tempfile.mkdtemp(prefix='tnc-cambuild-')
        build(csv, pbf, work)
    print('%d failed' % len(fails) if fails else 'all passed')
    return 1 if fails else 0


if __name__ == '__main__':
    sys.exit(main())
