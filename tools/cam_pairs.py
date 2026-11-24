"""한 기둥 짝(pairs: 같은 자리에서 서로 반대 방향을 찍는 두 카메라)의 어느 줄이 어느 방향인지를 설치장소 글로 정한다 (v215).

osm_cams.py 는 짝의 두 줄을 같은 자리에서 서로 반대 방향으로 붙이는데, 어느 줄이 어느 방향을 갖는지는 기하로 알 수 없다
(두 줄의 자리가 같다). 그래서 믿음값이 같으면 앞 줄이 기하 방향을 가졌다. 예전 osm_arrows.py 는 짝의 두 줄을 따로 보고,
글이 약하면(지명 하나만 찾음) 기하를 그대로 두어 두 줄의 글('A→B'·'B→A')이 모두 지금 방향과 반대여도 고치지 않았다 —
다시 만들 때마다 짝 17쌍의 방향이 서로 바뀌었다(2026-11-24 확인).

여기서는 짝을 한 덩어리로 본다:
  - 줄마다 글이 가리키는 방위 v 와 세기(두 지명 모두 찾음 2, 하나만 1)를 받아, 지금 그 줄의 방향이 v 와 60° 안이면 +세기,
    120° 넘게 다르면 -세기, 그 사이(길과 거의 직각)면 0
  - 두 줄의 합이 0 보다 작으면 두 줄의 방향 칸(dirs: 방위·양방향·차로 위 점·층·길 이름)을 서로 바꾼다 —
    같은 기둥이라 바꿔도 차로 위 점은 그 방향 차로에 그대로 있고, 줄마다 글·제한·종류는 제 줄에 남는다
  - 0 이면(글이 없거나 서로 맞서면) 그대로 (osm_cams.py 가 정한 대로: 믿음값, 같으면 앞 줄)
글이 정하면 결과는 줄의 순서와 상관없다: 두 줄을 바꿔 넣어도 줄마다 같은 방향이 나온다 (tools/test_cam_build.py).
글이 정하지 못하면(0) osm_cams.py 의 결과 그대로 — 같은 입력이면 늘 같다.
"""


def angd(a, b):
    return abs((a - b + 540) % 360 - 180)


def vote(eb, tv):
    """그 줄의 방향 eb 에 대한 글의 표: tv = (방위, 세기) 또는 None.
    글 방위가 길과 거의 직각(60~120°)이면 표를 주지 않는다 — 지명이 길 옆쪽에 있어 앞뒤를 가르지 못한다"""
    if tv is None or eb is None or eb < 0:
        return 0
    v, w = tv
    a = angd(eb, v)
    return w if a <= 60 else -w if a >= 120 else 0


def pair_score(dirs_i, dirs_j, tv_i, tv_j):
    return vote(dirs_i[0], tv_i) + vote(dirs_j[0], tv_j)


def swap_dirs(rows, dirs, alts, i, j):
    """두 줄의 방향 칸을 바꾼다. 차로 위 점(dirs[2]·[3], 줄 자리에서의 차 1e-5도)은 절대 자리가 그대로 있게 다시 잰다"""
    def absolute(r, d):
        return (r[0] + d[2] / 1e5, r[1] + d[3] / 1e5)
    ri, rj = rows[i], rows[j]
    di, dj = list(dirs[i]), list(dirs[j])
    pi, pj = absolute(ri, di), absolute(rj, dj)
    dj[2], dj[3] = int(round((pj[0] - ri[0]) * 1e5)), int(round((pj[1] - ri[1]) * 1e5))
    di[2], di[3] = int(round((pi[0] - rj[0]) * 1e5)), int(round((pi[1] - rj[1]) * 1e5))
    dirs[i], dirs[j] = dj, di
    if alts is not None:
        ai, aj = alts[i], alts[j]
        if ai is not None and len(ai) > 3:
            ai = list(ai)
            p = absolute(ri, ai)
            ai[2], ai[3] = int(round((p[0] - rj[0]) * 1e5)), int(round((p[1] - rj[1]) * 1e5))
        if aj is not None and len(aj) > 3:
            aj = list(aj)
            p = absolute(rj, aj)
            aj[2], aj[3] = int(round((p[0] - ri[0]) * 1e5)), int(round((p[1] - ri[1]) * 1e5))
        alts[i], alts[j] = aj, ai


def orientable(dirs_i, dirs_j):
    """글로 가를 수 있는 짝: 두 줄 모두 길에 붙었고, 한 방향씩이고, 서로 반대(120° 넘게)"""
    return (dirs_i[0] >= 0 and dirs_j[0] >= 0 and not dirs_i[1] and not dirs_j[1]
            and angd(dirs_i[0], dirs_j[0]) >= 120)


def orient_pairs(rows, dirs, alts, pairs, text_vote):
    """pairs: [(i, j), ...], text_vote(i) -> (방위, 세기) 또는 None. 고친 짝 수 등 통계를 돌려준다"""
    st = {'pair: text agrees': 0, 'pair: swapped to match text': 0, 'pair: text can not tell': 0, 'pair: not orientable': 0}
    for i, j in pairs:
        if not orientable(dirs[i], dirs[j]):
            st['pair: not orientable'] += 1
            continue
        s = pair_score(dirs[i], dirs[j], text_vote(i), text_vote(j))
        if s < 0:
            swap_dirs(rows, dirs, alts, i, j)
            st['pair: swapped to match text'] += 1
        elif s > 0:
            st['pair: text agrees'] += 1
        else:
            st['pair: text can not tell'] += 1
    return st
