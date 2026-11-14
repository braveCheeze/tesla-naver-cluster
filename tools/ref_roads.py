"""AI 참고용 밑그림: 도로 모양 안내 아이콘(나가기·들어가기·고가·지하차도·옆길)과 회전교차로의 구도를 그려
tools/icon-src/ref/road_<칸>.png (1024px, 마젠타 바탕)로 저장한다. 앱에는 넣지 않는다.

2026-11-14 사용자: '자바스크립트로 만든 느낌이 너무 강하다, AI 로 디자이너가 만든 것처럼 깔끔하게, 잘 나올 때까지'.
→ 구도(갈라지는·합류하는 곳이 그림 높이 가운데, 옆 테두리로 빠져나감 — 사용자 스케치 '기준은 이 가운데로')만 여기서 정하고,
  그림은 tools/gen_icons_atlas.py 가 이 밑그림 + 사용자 원본(tools/icon-src/outr.webp 등, 그림 느낌)으로 AI 에게 다시 그리게 한다.

- 밑그림 모양: 어두운 도로(#313b42) + 얇은 흰 가장자리 선 + 흰 점선 차로 + 흰 화살표, 고속도로 방패(OUT/IN)
- 좌표는 48×48. 경로는 선분·3차 곡선을 점으로 펴서 다룬다(화살 끝 자르기·차로 점선 평행 이동)
- 그리기: 설치된 Chrome(또는 Edge)을 화면 없이(headless) 띄워 SVG 를 찍는다
쓰는 법: py -I tools/ref_roads.py            (전부)   py -I tools/ref_roads.py over_r,rb_l   (일부)
"""
import math

import numpy as np

DARK, WHITE, BLUE, RED = '#313b42', '#f5f7f8', '#0d52a2', '#e42121'
EDGE = 0.9          # 도로 가장자리 흰 선 굵기
LANE = 4.0          # 차로 폭
ARROW_W = 2.7       # 화살표 몸통 굵기
HEAD_L, HEAD_W = 6.6, 4.1   # 화살촉 길이·반폭

f = lambda v: ('%.2f' % v).rstrip('0').rstrip('.') if abs(v) > 0.004 else '0'


def pts(spec, n=28):
    """spec: [('M',(x,y)), ('L',(x,y)), ('C',(c1),(c2),(p))] → (k,2) 점 배열"""
    out = []
    cur = None
    for s in spec:
        if s[0] == 'M':
            cur = np.array(s[1], float)
            out.append(cur)
        elif s[0] == 'L':
            p = np.array(s[1], float)
            for t in np.linspace(0, 1, 8)[1:]:
                out.append(cur + (p - cur) * t)
            cur = p
        else:
            c1, c2, p = (np.array(x, float) for x in s[1:])
            for t in np.linspace(0, 1, n)[1:]:
                u = 1 - t
                out.append(u ** 3 * cur + 3 * u * u * t * c1 + 3 * u * t * t * c2 + t ** 3 * p)
            cur = p
    return np.array(out)


def d(p, close=False):
    s = 'M' + ' L'.join('%s %s' % (f(x), f(y)) for x, y in p)
    return s + ('Z' if close else '')


def seglen(p):
    return np.hypot(*np.diff(p, axis=0).T)


def trim(p, start=0.0, end=0.0):
    """길이로 앞·뒤를 잘라 낸 점들"""
    L = np.concatenate([[0], np.cumsum(seglen(p))])
    a, b = start, L[-1] - end
    keep = [i for i in range(len(p)) if a < L[i] < b]

    def at(s):
        i = max(0, min(len(L) - 2, np.searchsorted(L, s) - 1))
        t = (s - L[i]) / max(1e-9, L[i + 1] - L[i])
        return p[i] + (p[i + 1] - p[i]) * t
    return np.array([at(a)] + [p[i] for i in keep] + [at(b)])


def normals(p):
    t = np.gradient(p, axis=0)
    t /= np.maximum(1e-9, np.hypot(*t.T))[:, None]
    return np.stack([-t[:, 1], t[:, 0]], 1)   # 진행 방향 왼쪽이 +


def offset(p, dist):
    return p + normals(p) * dist


def road(p, width, cls='rd-s'):
    """흰 테(아래 층) 와 어두운 칠(위 층) 두 조각을 돌려준다"""
    under = '<path d="%s" fill="none" stroke="%s" stroke-width="%s"/>' % (d(p), WHITE, f(width + 2 * EDGE))
    top = '<path class="%s" d="%s" fill="none" stroke="%s" stroke-width="%s"/>' % (cls, d(p), DARK, f(width))
    return under, top


def lanes(p, width, n, skip=()):
    """차로 점선: 가운데 선에서 차로 경계만큼 평행 이동"""
    out = ''
    for i in range(1, n):
        if i in skip:
            continue
        off = -width / 2 + width * i / n
        out += '<path d="%s" fill="none" stroke="%s" stroke-width=".8" stroke-dasharray="2.6 2.4" opacity=".85"/>' % (d(offset(p, off)), WHITE)
    return out


def arrow(p, start=0.0, end=0.0, w=ARROW_W, hl=HEAD_L, hw=HEAD_W, color=WHITE):
    """p 를 따라가는 화살표: start·end 만큼 잘라 내고, 끝에 화살촉(끝점이 화살촉 꼭짓점)"""
    q = trim(p, start, end)
    tip = q[-1]
    dv = q[-1] - q[-4]
    dv = dv / np.hypot(*dv)
    body = trim(q, 0, hl * 0.82)
    base = tip - dv * hl
    nv = np.array([-dv[1], dv[0]])
    head = np.array([tip, base + nv * hw, base - nv * hw])
    return ('<path d="%s" fill="none" stroke="%s" stroke-width="%s" stroke-linecap="round" stroke-linejoin="round"/>'
            '<path d="%s" fill="%s" stroke="%s" stroke-width=".6" stroke-linejoin="round"/>') % (
        d(body), color, f(w), d(head, True), color, color)


def shield(x, y, txt, w=11.6):
    """고속도로 방패(빨간 띠·파란 몸·흰 테·흰 글자). x,y 는 왼쪽 위"""
    k = w / 16.0
    fs = {'OUT': 6.4, 'IN': 7.6, 'JC': 7.2}.get(txt, 7)
    return ('<g class="shield" transform="translate(%s %s) scale(%s)">' % (f(x), f(y), f(k)) +
            '<path d="M0 0.6h16v7.4c0 4.1-3.6 6.7-8 8.4-4.4-1.7-8-4.3-8-8.4z" fill="%s" stroke="#ffffff" stroke-width="1.2"/>' % BLUE +
            '<path d="M0.6 1.2h14.8v3.3H0.6z" fill="%s" stroke="none"/>' % RED +
            '<text x="8" y="12" text-anchor="middle" font-size="%s" font-weight="800" fill="#ffffff" stroke="none" '
            'font-family="Pretendard, sans-serif">%s</text></g>' % (fs, txt))


def portal(cx, y_top, w, h):
    """지하차도 입구(앞에서 본 콘크리트 틀 + 어두운 구멍). 도로가 아래에서 들어간다"""
    x0, x1, y1 = cx - w / 2, cx + w / 2, y_top + h
    r = w / 2
    frame = 'M%s %sV%sA%s %s 0 0 1 %s %sV%sZ' % (f(x0), f(y1), f(y_top + r * 0.62), f(r), f(r * 0.62), f(x1), f(y_top + r * 0.62), f(y1))
    iw = w - 4.4
    ir = iw / 2
    hole = 'M%s %sV%sA%s %s 0 0 1 %s %sV%sZ' % (f(cx - ir), f(y1), f(y_top + 2.2 + ir * 0.6), f(ir), f(ir * 0.6), f(cx + ir), f(y_top + 2.2 + ir * 0.6), f(y1))
    return ('<path class="pt" d="%s" fill="#9aa6b2" stroke="#ffffff" stroke-width=".7"/>' % frame +
            '<path d="%s" fill="#0f1418" stroke="none"/>' % hole)


def svg(key, cls, body, extra='', left=False):
    flip = ' transform="matrix(-1 0 0 1 48 0)"' if left else ''
    return ('<svg viewBox="0 0 48 48" class="ti ti-%s %s"><g stroke-linecap="butt" stroke-linejoin="round"%s>%s</g>%s</svg>'
            % (key, cls, flip, body, extra))


# ------------------------------------------------------------------ 나가기·들어가기
MAIN_X, MAIN_W = 19.0, 12.0       # 본선(3차로) 가운데 x·폭: 원본처럼 왼쪽 위 모서리에 방패 자리를 둔다


def ramp(key):
    out, left = key.startswith('out'), key.endswith('l')
    main = pts([('M', (MAIN_X, 49.5)), ('L', (MAIN_X, -1.5))])
    if key[-1] == 's':
        return straight_ramp(key, out)
    # 2026-11-14 사용자 스케치('기준은 이 가운데로'): 갈라지는·합류하는 연결로가 그림 높이의 가운데에 오고,
    # 옆 테두리로 빠져나간다(들어온다). 나가기는 본선 가장자리 y 20~34 → 오른쪽 테두리 y 11~21, 들어가기는 오른쪽 y 26~44 → 본선 y 12~30
    if out:
        dv = np.array([0.902, -0.431])                     # 위로 약 26°
        p = np.array([27.0, 26.3])
        r = pts([('M', (MAIN_X, 49.5)), ('L', (MAIN_X, 38)), ('C', (MAIN_X, 33), tuple(p - dv * 4.5), tuple(p)), ('L', tuple(p + dv * 30))])
        a = arrow(r, start=3.2, end=13.2)
        sh = shield(1.0, 1.6, 'OUT')
    else:
        dv = np.array([-0.857, -0.515])                    # 오른쪽에서 왼쪽 위로 약 31°
        p = np.array([27.6, 22.4])
        r = pts([('M', tuple(p - dv * 30)), ('L', tuple(p)), ('C', tuple(p + dv * 4.6), (MAIN_X, 17.6), (MAIN_X, 12.6)), ('L', (MAIN_X, -1.5))])
        a = arrow(r, start=12.6, end=5.4)
        sh = shield(48 - 1.0 - 11.6, 1.6, 'IN')
    w1, t1 = road(main, MAIN_W, 'rd')
    w2, t2 = road(r, 7.2)
    body = w1 + w2 + t1 + t2 + lanes(main, MAIN_W, 3) + a
    if left:
        sh = sh.replace('translate(%s ' % f(1.0), 'translate(%s ' % f(48 - 1.0 - 11.6)) if out else sh.replace(
            'translate(%s ' % f(48 - 1.0 - 11.6), 'translate(%s ' % f(1.0))
    return svg(key, 'ramp ' + ('out' if out else 'in'), body, sh, left)


def straight_ramp(key, out):
    """직진으로 나가기(outs)·들어가기(ins): 화살표는 곧게 위로, 본선이 옆(왼쪽 위로 휘어 나감·왼쪽 아래에서 합류)"""
    cx = 21.0
    straight = pts([('M', (cx, 49.5)), ('L', (cx, -1.5))])
    if out:
        # 본선은 가운데 높이에서 왼쪽 테두리로 휘어 나가고, 나가는 길은 곧게 위로
        dv = np.array([-0.877, -0.48])
        p = np.array([13.6, 25.2])
        hw = pts([('M', (cx, 49.5)), ('L', (cx, 36.5)), ('C', (cx, 31.5), tuple(p - dv * 4.6), tuple(p)), ('L', tuple(p + dv * 22))])
        w1, t1 = road(hw, MAIN_W)
        w2, t2 = road(trim(straight, 0, 0), 7.2)
        body = w1 + w2 + t1 + t2 + lanes(trim(hw, 0, 0), MAIN_W, 3) + arrow(straight, start=3.4, end=4.4)
        sh = shield(48 - 1.0 - 11.6, 1.6, 'OUT')
    else:
        # 본선이 왼쪽 테두리 가운데 아래에서 들어와 가운데 높이에서 합류, 화살표는 곧게 위로
        dv = np.array([0.877, -0.48])
        p = np.array([13.6, 29.4])
        hw = pts([('M', tuple(p - dv * 22)), ('L', tuple(p)), ('C', tuple(p + dv * 4.6), (cx, 24.5), (cx, 19.5)), ('L', (cx, -1.5))])
        up = pts([('M', (cx, 49.5)), ('L', (cx, 18))])
        w1, t1 = road(hw, MAIN_W)
        w2, t2 = road(up, 7.2)
        body = w2 + w1 + t2 + t1 + lanes(hw, MAIN_W, 3) + arrow(straight, start=3.4, end=4.4)
        sh = shield(48 - 1.0 - 11.6, 1.6, 'IN')
    return svg(key, 'ramp ' + ('out' if out else 'in'), body, sh)


# ------------------------------------------------------------------ 고가차도·지하차도·옆길
def span_over(p, cy, half):
    """경로 p 중 가로 길(가운데 y=cy, 반폭 half)을 넘는 부분"""
    m = np.abs(p[:, 1] - cy) <= half + 2.2
    idx = np.nonzero(m)[0]
    return p[idx.min():idx.max() + 1]


def shadow(span, width):
    """다리 밑 그림자: 오른쪽 아래로 살짝 비켜 깐 반투명 검정 (가로 길 위에만 보인다)"""
    return '<path d="%s" fill="none" stroke="#000000" stroke-opacity=".32" stroke-width="%s" transform="translate(1.1 1.3)"/>' % (
        d(span), f(width + 2 * EDGE + 1.6))


def parapets(span, width):
    """다리 난간: 지도 기호 같은 )( 모양 (끝이 바깥으로 벌어진 선). 흰 바탕(낮 패널)에서도 보이게 어두운 테 + 흰 선"""
    nv = normals(span)
    tv = np.gradient(span, axis=0)
    tv /= np.maximum(1e-9, np.hypot(*tv.T))[:, None]
    under, top = '', ''
    for s_ in (-1, 1):
        q = span + nv * s_ * (width / 2 + 1.35)
        a = q[0] - tv[0] * 0.6 + (nv[0] * s_ - tv[0]) * 2.0
        b = q[-1] + tv[-1] * 0.6 + (nv[-1] * s_ + tv[-1]) * 2.0
        line = d(np.vstack([a, q[0] - tv[0] * 0.6, q, q[-1] + tv[-1] * 0.6, b]))
        under += '<path class="rd-s" d="%s" fill="none" stroke="%s" stroke-width="2.7" stroke-linecap="round" stroke-linejoin="round"/>' % (line, DARK)
        top += '<path d="%s" fill="none" stroke="%s" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round"/>' % (line, WHITE)
    return under + top


def cross_road(y, w=10.0, x0=-1.5, x1=49.5):
    p = pts([('M', (x0, y)), ('L', (x1, y))])
    a, b = road(p, w)
    return a + b + '<path d="%s" fill="none" stroke="%s" stroke-width=".8" stroke-dasharray="2.6 2.4" opacity=".85"/>' % (d(p), WHITE)


def over(key):
    """고가차도 진입: 지나가는 길(가로) 위를 다리로 넘는다. _s 곧게, _l/_r 본선에서 그쪽으로 갈라져 올라간다"""
    side = key[-1]
    if side == 's':
        p = pts([('M', (24, 49.5)), ('L', (24, -1.5))])
        w1, t1 = road(p, MAIN_W)
        sp = span_over(p, 21, 5.25)
        body = (cross_road(21, 10.5) + shadow(sp, MAIN_W) + w1 + t1 + parapets(sp, MAIN_W) +
                lanes(p, MAIN_W, 3, skip=(1, 2)) + arrow(p, start=3.4, end=4.4))
        return svg(key, 'over', body)
    main = pts([('M', (15, 49.5)), ('L', (15, -1.5))])
    r = pts([('M', (15, 49.5)), ('L', (15, 34)), ('C', (15, 27), (22, 24), (28, 21.5)), ('C', (32.5, 19.6), (35, 16.5), (35, 11)), ('L', (35, -1.5))])
    w1, t1 = road(main, MAIN_W, 'rd')
    w2, t2 = road(r, 7.2)
    sp = span_over(r, 12, 4.75)
    body = (cross_road(12, 9.5, 21.5) + shadow(sp, 7.2) + w1 + w2 + t1 + t2 + lanes(main, MAIN_W, 3) + parapets(sp, 7.2) +
            arrow(r, start=3.4, end=3.6))
    return svg(key, 'over', body, left=(side == 'l'))


def under(key):
    """지하차도 진입: 도로가 앞에서 본 지하차도 입구(콘크리트 틀·어두운 구멍)로 들어간다"""
    side = key[-1]
    if side == 's':
        p = pts([('M', (24, 49.5)), ('L', (24, 15))])
        w1, t1 = road(p, MAIN_W)
        body = w1 + t1 + lanes(p, MAIN_W, 3, skip=(1, 2)) + portal(24, 2.5, 22, 14.5) + arrow(p, start=3.4, end=-2.6)
        return svg(key, 'under', body)
    main = pts([('M', (14.5, 49.5)), ('L', (14.5, -1.5))])
    r = pts([('M', (14.5, 49.5)), ('L', (14.5, 35)), ('C', (14.5, 28), (34, 30), (34, 22.5)), ('L', (34, 15.5))])
    w1, t1 = road(main, MAIN_W, 'rd')
    w2, t2 = road(r, 7.6)
    body = w1 + w2 + t1 + t2 + lanes(main, MAIN_W, 3) + portal(34, 3.2, 14.5, 12.8) + arrow(r, start=3.4, end=-2.4)
    return svg(key, 'under', body, left=(side == 'l'))


def side(key, kind):
    """옆길: 가운데 길은 지하차도로 들어가거나(side_) 고가로 올라가고(oside_), 화살표는 그 옆 땅 위 길로 곧게 간다"""
    left = key.endswith('l')
    mid = pts([('M', (19, 49.5)), ('L', (19, -1.5))])
    sr = pts([('M', (21, 49.5)), ('L', (21, 37)), ('C', (21, 30.5), (33.5, 31.5), (33.5, 24.5)), ('L', (33.5, -1.5))])
    w1, t1 = road(mid, MAIN_W, 'rd')
    w2, t2 = road(sr, 7.2)
    if kind == 'under':
        mid_up = trim(mid, 0, 17.2)   # 아래에서 지하차도 입구(아래 끝 y≈15.8)까지
        w1, t1 = road(mid_up, MAIN_W, 'rd')
        body = w1 + w2 + t1 + t2 + lanes(mid_up, MAIN_W, 3) + portal(19, 3.4, 15.5, 12.4) + arrow(sr, start=3.4, end=4.4)
    else:
        sp = span_over(mid, 11, 4.75)
        body = (cross_road(11, 9.5) + w2 + t2 + shadow(sp, MAIN_W) + w1 + t1 + parapets(sp, MAIN_W) + lanes(mid, MAIN_W, 3) +
                arrow(sr, start=3.4, end=4.4))
    return svg(key, 'side', body, left=left)


def rb(key):
    """회전교차로 (2026-11-14 다시: '화살표가 너무 두껍고 대충 만든 것 같다'): 한 색(currentColor) 글리프.
    옅은 고리·네 갈래 길 + 가는 화살표(굵기 3.4)와 뾰족한 화살촉. 아래 길로 들어와 시계 반대 방향(우측 통행)으로 돌아 나간다"""
    ex = key.split('_')[1]
    cx, cy, R = 24.0, 23.5, 10.5
    faint = ('<g fill="none" stroke="currentColor" stroke-opacity=".26"><circle cx="24" cy="23.5" r="10.5" stroke-width="5.2"/>'
             '<path d="M24 34.5V49M24 12.5V-1M13.5 23.5H-1M34.5 23.5H49" stroke-width="5.2"/></g>'
             '<circle cx="24" cy="23.5" r="4.2" fill="currentColor" fill-opacity=".16" stroke="none"/>')
    pt = lambda a: (cx + R * math.cos(math.radians(a)), cy + R * math.sin(math.radians(a)))
    x0 = 26.2 if ex == 'u' else 24.0
    a0 = math.degrees(math.acos((x0 - cx) / R))          # 들어오는 아래 길이 고리와 만나는 각
    a1 = {'r': 0, 's': -90, 'l': -180, 'u': -360 + (180 - a0)}[ex]
    od = {'r': (1, 0), 's': (0, -1), 'l': (-1, 0), 'u': (0, 1)}[ex]
    spec = [('M', (x0, 49)), ('L', pt(a0))]
    # 원호를 3차 곡선 여러 개로
    steps = max(2, int(abs(a1 - a0) / 30))
    angs = np.linspace(a0, a1, steps + 1)
    for i in range(steps):
        t0, t1 = math.radians(angs[i]), math.radians(angs[i + 1])
        k = 4 / 3 * math.tan((t1 - t0) / 4)
        p0, p1 = np.array(pt(angs[i])), np.array(pt(angs[i + 1]))
        c1 = p0 + k * R * np.array([-math.sin(t0), math.cos(t0)])
        c2 = p1 - k * R * np.array([-math.sin(t1), math.cos(t1)])
        spec.append(('C', tuple(c1), tuple(c2), tuple(p1)))
    end = np.array(pt(a1))
    spec.append(('L', tuple(end + np.array(od) * (12.5 if ex != 'u' else 14.5))))
    p = pts(spec, 10)
    a = arrow(p, start=1.0, end=0.6, w=3.4, hl=7.6, hw=5.0, color='currentColor')
    return '<svg viewBox="0 0 48 48" class="ti ti-%s rb">%s%s</svg>' % (key, faint, a)


def build():
    out = {}
    for k in ('outr', 'outl', 'inr', 'inl', 'outs', 'ins'):
        out[k] = ramp(k)
    for k in ('over_s', 'over_l', 'over_r'):
        out[k] = over(k)
    for k in ('under_s', 'under_l', 'under_r'):
        out[k] = under(k)
    for k in ('side_l', 'side_r'):
        out[k] = side(k, 'under')
    for k in ('oside_l', 'oside_r'):
        out[k] = side(k, 'over')
    for k in ('rb_l', 'rb_s', 'rb_r', 'rb_u'):
        out[k] = rb(k)
    return out


def render(keys=None):
    """밑그림을 1024px PNG 로 (마젠타 바탕, 그림은 가운데 약 88%)"""
    import os
    import subprocess
    import tempfile
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    out_dir = os.path.join(root, 'tools', 'icon-src', 'ref')
    exe = next((x for x in (r'C:\Program Files\Google\Chrome\Application\chrome.exe',
                            r'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe') if os.path.exists(x)), None)
    if not exe:
        raise SystemExit('Chrome/Edge 가 없습니다')
    icons = build()
    tmp = tempfile.mkdtemp(prefix='ref_roads_')
    for k, svg_ in icons.items():
        if keys and k not in keys:
            continue
        if k.startswith('rb_'):
            svg_ = (svg_.replace('stroke="currentColor" stroke-opacity=".26"', 'stroke="#c9ecd6"')
                    .replace('fill="currentColor" fill-opacity=".16"', 'fill="#c9ecd6"'))
        html = os.path.join(tmp, k + '.html')
        with open(html, 'w', encoding='utf-8') as fh:
            fh.write('<!doctype html><meta charset="utf-8"><style>html,body{margin:0;background:#ff00ff}'
                     'body{width:1024px;height:1024px;display:flex;align-items:center;justify-content:center;color:#03c75a}'
                     'svg{width:900px;height:900px;display:block}</style>' + svg_)
        png = os.path.join(out_dir, 'road_%s.png' % k)
        subprocess.run([exe, '--headless=new', '--disable-gpu', '--hide-scrollbars', '--user-data-dir=' + os.path.join(tmp, 'prof'),
                        '--window-size=1024,1024', '--default-background-color=FF00FFFF', '--screenshot=' + png,
                        'file:///' + html.replace(os.sep, '/')], check=True, capture_output=True, timeout=60)
        print('road_%s.png' % k)


if __name__ == '__main__':
    import sys
    render(set(sys.argv[1].split(',')) if len(sys.argv) > 1 else None)
