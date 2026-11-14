"""길안내 아이콘·분기점 그림을 Atlas Cloud 이미지 모델로 그리기 (사용자가 직접 실행)

- API 키는 이 파일·채팅에 적지 않는다. 실행하는 사람이 자기 터미널에서 환경 변수로 넣는다:
    PowerShell:  $env:ATLAS_API_KEY = "<새로 발급받은 키>"
    그다음:      py -X utf8 tools\gen_icons_atlas.py
- 참고 그림(스타일·구도): tools/icon-src/ 의 사용자 그림과 ref/ 의 지금 앱 그림. GitHub Pages 주소로 넘기고 안 되면 base64.
- 결과: tools/icon-src/ai/<그림>__<모델>__<번호>.png 와 한눈에 보는 contact.png
- 비용(2026-11-14 Atlas 가격, 장당): GPT Image 2.5 Flare edit $0.005, GPT Image 2.5 Sunburst edit $0.005 (developer 판은 $0.03 으로 더 비쌈),
  GPT Image 2 developer $0.005, GPT Image 1.5 $0.005, GPT Image 2 $0.006, Seedream 5.5 $0.016, Seedream 5.0 Pro $0.036, Nano Banana 2 $0.08.
  기본: GPT Image 2.5 Flare·Sunburst × 그림 16가지 × 1장 = 32장 ≈ $0.16
- 옵션: --models flare,sunburst,gpt15   --per 2   --icons over_r,junc_fork_r   --dry (요청 없이 계획과 예상 비용만)
"""
import argparse
import base64
import json
import os
import sys
import time
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'tools', 'icon-src')
OUT = os.path.join(SRC, 'ai')
PAGES = 'https://bravecheeze.github.io/tesla-naver-cluster/tools/icon-src/'
API = 'https://api.atlascloud.ai/api/v1/model'
UA = 'tesla-naver-cluster-icons/1.0'

BG = ' Keep a solid flat magenta background (#FF00FF) everywhere outside the icon. Square 1:1, centered, nothing cut off.'
CORP = ' Clean, professional style like the Naver Map or Google Maps navigation app, not cartoonish.'
ROAD = ('Flat vector navigation icon in exactly the style of the reference image: thick dark charcoal asphalt road (#313B42) '
        'with thin white edge lines and a white dashed lane line, one bold white arrow with a large triangular arrowhead showing '
        'the path to take. Smooth even curves, crisp edges, consistent line widths, no shadows, no texture, no extra text.'
        + CORP + BG + ' ')
ARROW = ('Flat vector navigation turn icon in exactly the style of the reference image: one bold solid white arrow with rounded '
         'ends and a sharp triangular arrowhead, clean geometric shapes, no road, no shadows, no gradients, no extra text.'
         + CORP + BG + ' ')
SHIELD = ' Small interstate-style shield (red top band, blue body, white border, bold white letters) in an empty corner'
# 그림 이름 → (참고 그림: tools/icon-src 기준 경로, 스타일 문장, 내용)
JOBS = {
    # 고속도로 들어가기·나가기 (지금 앱 그림과 같은 구도: 두툼한 도로, 합류·진출 지점이 가운데)
    'inr': ('ref/ref_inr.png', ROAD, 'Keep exactly the composition of the reference: the ramp comes from the bottom right and merges '
            'into the right lane of the highway in the middle of the image; the arrow follows the ramp and then points straight up.'
            + SHIELD + ' with "IN".'),
    'inl': ('ref/ref_inl.png', ROAD, 'Keep exactly the composition of the reference: the ramp comes from the bottom left and merges '
            'into the left lane of the highway in the middle; the arrow follows the ramp and then points straight up.' + SHIELD + ' with "IN".'),
    'outr': ('ref/ref_outr.png', ROAD, 'Keep exactly the composition of the reference: the right lane splits off in the middle and '
             'curves to the top right; the arrow follows the exit ramp, arrowhead pointing up-right.' + SHIELD + ' with "OUT".'),
    'outl': ('ref/ref_outl.png', ROAD, 'Keep exactly the composition of the reference: the left lane splits off in the middle and '
             'curves to the top left; the arrow follows the exit ramp, arrowhead pointing up-left.' + SHIELD + ' with "OUT".'),
    'ins': ('ref/ref_inr.png', ROAD, 'Highway entrance straight ahead: a straight vertical road widening into a highway, '
            'the arrow points straight up the middle.' + SHIELD + ' with "IN".'),
    'outs': ('ref/ref_outr.png', ROAD, 'Highway exit straight ahead: the road continues straight up off the highway onto an exit '
             'road; the arrow points straight up.' + SHIELD + ' with "OUT".'),
    # 그림이 아직 없던 것
    'sharp_r': ('r.webp', ARROW, "A SHARP right turn: the arrow comes up from the bottom and turns back down to the lower right "
                "(about the 4 o'clock direction), arrowhead pointing down-right."),
    'over_r': ('ref/ref_outr.png', ROAD, 'Overpass entry: the right lane rises onto an elevated overpass bridge curving up-right, '
               'while the main road continues straight underneath; the arrow follows the rising overpass ramp. No shield.'),
    'under_r': ('ref/ref_outr.png', ROAD, 'Underpass entry: the middle lanes go down into an underpass tunnel mouth (a dark '
                'rectangular opening) straight ahead while side roads stay on the surface; the arrow goes into the underpass. No shield.'),
    'side_r': ('ref/ref_outr.png', ROAD, 'Side road next to an underpass: the middle road goes down into an underpass, and the '
               'arrow stays on the right-hand surface side road that runs alongside and continues up. No shield.'),
    'rest': ('ref/ref_outr.png', ROAD, 'Highway rest area entry: the right lane exits toward a rest area; a small blue square sign '
             'with a white fork and knife in the empty corner; the arrow follows the exit lane. No shield.'),
    'ferry': ('s.webp', ARROW, 'Ferry route: a simple white ferry boat silhouette on two white wave lines, with a white arrow '
              'pointing up above it.'),
    # 회전교차로 (앱에는 네이버 지도 같은 한 색 글리프를 그려 넣었다. 비교용)
    'rb_r': ('rb.webp', ARROW, 'Roundabout, exit to the RIGHT: a pale thin ring with four short pale road stubs (bottom, top, '
             'left, right); one bold white arrow enters from the bottom, goes counter-clockwise around the ring a quarter turn '
             'and exits to the right with a large arrowhead. Single color, like Naver Map turn icons.'),
    'rb_l': ('rb.webp', ARROW, 'Roundabout, exit to the LEFT: a pale thin ring with four short pale road stubs; one bold white '
             'arrow enters from the bottom, goes counter-clockwise three quarters around and exits to the left with a large '
             'arrowhead. Single color, like Naver Map turn icons.'),
    # 분기점 확대 그림 (가로로 넓게, 길안내 패널 밑 서랍에 들어간다: 글자는 넣지 않는다 - 앱이 위에 올린다)
    'junc_fork_r': ('ref/ref_outr.png', 'Navigation junction close-up illustration for a car display, clean flat vector style '
                    'like a premium car navigation, no text, no signs: first-person view of a highway splitting into two '
                    'branches ahead under a light blue sky, grass shoulders, dark asphalt with white lane markings in perspective; '
                    'the right branch is highlighted with a blue lane and a big white arrow curving to the right. '
                    'Wide 3:2 landscape. Do not use magenta.', ''),
    'junc_exit_r': ('ref/ref_outr.png', 'Navigation junction close-up illustration for a car display, clean flat vector style '
                    'like a premium car navigation, no text, no signs: first-person view of a highway going straight ahead '
                    'with an exit ramp leaving on the right under a light blue sky, grass shoulders, white lane markings in '
                    'perspective; the exit ramp lane is highlighted blue with a big white arrow curving to the right. '
                    'Wide 3:2 landscape. Do not use magenta.', ''),
}
WIDE = {'junc_fork_r', 'junc_exit_r'}


def _gpt25(model):
    return (model, 0.005, lambda p, img, wide=False: {'prompt': p, 'images': [img], 'size': '1536x1024' if wide else '1024x1024',
                                                       'quality': 'medium', 'background': 'opaque', 'output_format': 'png', 'n': 1})


# 모델: 짧은 이름 → (모델 ID, 장당 가격, 요청 본문 만들기)
MODELS = {
    'flare': _gpt25('openai/gpt-image-2.5-flare/edit'),          # 기본 (싸고 최신)
    'sunburst': _gpt25('openai/gpt-image-2.5-sunburst/edit'),    # 기본 (싸고 최신)
    'gptdev': ('openai/gpt-image-2-developer/edit', 0.005,
               lambda p, img, wide=False: {'prompt': p, 'images': [img], 'size': '1536x1024' if wide else '1024x1024',
                                           'quality': 'high', 'output_format': 'png'}),
    'gpt15': ('openai/gpt-image-1.5/edit', 0.005,
              lambda p, img, wide=False: {'prompt': p, 'images': [img], 'size': '1536x1024' if wide else '1024x1024',
                                          'quality': 'high', 'input_fidelity': 'high', 'output_format': 'png'}),
    'gpt': ('openai/gpt-image-2/edit', 0.006,
            lambda p, img, wide=False: {'prompt': p, 'images': [img], 'size': '1536x1024' if wide else '1024x1024',
                                        'quality': 'high', 'output_format': 'png'}),
    's55': ('bytedance/seedream-v5.5/edit', 0.016,
            lambda p, img, wide=False: {'prompt': p, 'reference_images': [img], 'size': '2048*1152' if wide else '1024*1024',
                                        'output_format': 'png', 'background': 'opaque'}),
    's50p': ('bytedance/seedream-v5.0-pro/edit', 0.036,
             lambda p, img, wide=False: {'prompt': p, 'images': [img], 'size': '2048*1152' if wide else '1024*1024',
                                         'output_format': 'png', 'background': 'opaque'}),
    'nb2': ('google/nano-banana-2/edit', 0.08,
            lambda p, img, wide=False: {'prompt': p, 'images': [img], 'aspect_ratio': '16:9' if wide else '1:1',
                                        'resolution': '1k', 'output_format': 'png'}),
}


def http(method, url, key, body=None, timeout=60):
    data = json.dumps(body).encode('utf-8') if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={
        'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json', 'User-Agent': UA})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read().decode('utf-8') or '{}')
    except urllib.error.HTTPError as e:
        txt = e.read().decode('utf-8', 'replace')
        try:
            return e.code, json.loads(txt)
        except ValueError:
            return e.code, {'raw': txt[:300]}


def ref_input(rel):
    """참고 그림: GitHub Pages 주소가 열리면 주소, 아니면 base64 data URI"""
    url = PAGES + rel
    try:
        with urllib.request.urlopen(urllib.request.Request(url, method='HEAD', headers={'User-Agent': UA}), timeout=15) as r:
            if r.status == 200:
                return url
    except Exception:
        pass
    path = os.path.join(SRC, rel)
    mime = 'image/webp' if path.endswith('.webp') else 'image/png'
    with open(path, 'rb') as fh:
        return 'data:%s;base64,' % mime + base64.b64encode(fh.read()).decode('ascii')


def submit(key, model_id, body):
    body = dict(body, model=model_id)
    st, j = http('POST', API + '/generateImage', key, body)
    pid = (j.get('data') or {}).get('id') if isinstance(j, dict) else None
    if st != 200 or not pid:
        raise RuntimeError('submit %s: HTTP %s %s' % (model_id, st, json.dumps(j, ensure_ascii=False)[:300]))
    return pid


def wait(key, pid, limit=300):
    t0 = time.time()
    while time.time() - t0 < limit:
        st, j = http('GET', API + '/prediction/' + pid, key)
        d = (j.get('data') or {}) if isinstance(j, dict) else {}
        s = str(d.get('status', '')).lower()
        if s in ('completed', 'succeeded'):
            outs = d.get('outputs') or d.get('urls') or []
            if not outs:
                raise RuntimeError('완료됐는데 결과 주소가 없음: ' + json.dumps(d, ensure_ascii=False)[:300])
            return outs[0]
        if s == 'failed':
            raise RuntimeError('실패: ' + str(d.get('error') or d)[:300])
        time.sleep(3)
    raise RuntimeError('5분 안에 끝나지 않음')


def save(out, path):
    if out.startswith('http'):
        with urllib.request.urlopen(urllib.request.Request(out, headers={'User-Agent': UA}), timeout=60) as r:
            data = r.read()
    else:
        data = base64.b64decode(out.split(',', 1)[-1])
    with open(path, 'wb') as fh:
        fh.write(data)


def contact(files):
    try:
        from PIL import Image, ImageDraw
    except ImportError:
        return None
    icons = sorted({os.path.basename(f).split('__')[0] for f in files})
    cols = sorted({'__'.join(os.path.basename(f).split('__')[1:]) for f in files})
    cell = 220
    sheet = Image.new('RGB', (cell * len(cols), (cell + 18) * len(icons)), (40, 40, 40))
    d = ImageDraw.Draw(sheet)
    for f in files:
        b = os.path.basename(f)
        r, c = icons.index(b.split('__')[0]), cols.index('__'.join(b.split('__')[1:]))
        im = Image.open(f).convert('RGB').resize((cell - 6, cell - 6))
        sheet.paste(im, (c * cell + 3, r * (cell + 18) + 3))
        d.text((c * cell + 6, r * (cell + 18) + cell - 2), b.replace('.png', ''), fill=(230, 230, 230))
    path = os.path.join(OUT, 'contact.png')
    sheet.save(path)
    return path


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--models', default='flare,sunburst')   # 다른 모델도: flare,sunburst,gptdev,gpt15,gpt,s55,s50p,nb2
    ap.add_argument('--icons', default=','.join(JOBS))
    ap.add_argument('--per', type=int, default=1)
    ap.add_argument('--dry', action='store_true')
    a = ap.parse_args()
    models = [m for m in a.models.split(',') if m in MODELS]
    icons = [i for i in a.icons.split(',') if i in JOBS]
    jobs = [(i, m, n) for i in icons for m in models for n in range(1, a.per + 1)]
    cost = sum(MODELS[m][1] for _, m, _ in jobs)
    print('만들 그림 %d장, 예상 비용 약 $%.2f  (모델: %s)' % (len(jobs), cost, ', '.join(models)))
    if a.dry:
        return
    key = os.environ.get('ATLAS_API_KEY') or os.environ.get('ATLASCLOUD_API_KEY')
    if not key:
        sys.exit('ATLAS_API_KEY 환경 변수가 없습니다. PowerShell: $env:ATLAS_API_KEY = "<키>" 를 먼저 입력하세요.')
    os.makedirs(OUT, exist_ok=True)
    refs = {i: ref_input(JOBS[i][0]) for i in icons}
    print('참고 그림:', ', '.join('%s=%s' % (i, 'URL' if r.startswith('http') else 'base64') for i, r in refs.items()))
    pending = []
    for i, m, n in jobs:
        mid, price, mk = MODELS[m]
        try:
            ref, style, extra = JOBS[i]
            pid = submit(key, mid, mk(style + extra, refs[i], i in WIDE))
            pending.append((i, m, n, pid))
            print('  보냄 %-5s %-5s #%d' % (i, m, n))
        except Exception as e:
            print('  ✗ 보내기 실패 %-5s %-5s #%d: %s' % (i, m, n, e))
        time.sleep(0.4)
    files = []
    for i, m, n, pid in pending:
        path = os.path.join(OUT, '%s__%s__%d.png' % (i, m, n))
        try:
            save(wait(key, pid), path)
            files.append(path)
            print('  ✓ %s' % os.path.relpath(path, ROOT))
        except Exception as e:
            print('  ✗ %-5s %-5s #%d: %s' % (i, m, n, e))
    sheet = contact(files) if files else None
    print('\n완료: %d/%d장%s' % (len(files), len(jobs), ('  · 한눈에 보기: ' + os.path.relpath(sheet, ROOT)) if sheet else ''))


if __name__ == '__main__':
    main()
