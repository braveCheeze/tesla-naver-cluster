"""고속도로 나가기(OUT)·들어가기(IN) 아이콘을 Atlas Cloud 이미지 모델 여러 개로 다시 그리기 (사용자가 직접 실행)

- API 키는 이 파일·채팅에 적지 않는다. 실행하는 사람이 자기 터미널에서 환경 변수로 넣는다:
    PowerShell:  $env:ATLAS_API_KEY = "<새로 발급받은 키>"
    그다음:      py -X utf8 tools\\gen_icons_atlas.py
- 참고 그림: tools/icon-src/ref/ref_<아이콘>.png (지금 앱 아이콘과 같은 구도, 마젠타 배경. tools/ref_ramps.py 로 만듦).
  GitHub Pages 주소로 넘기고, 주소를 못 받으면 base64 로 넘긴다.
- 결과: tools/icon-src/ai/<아이콘>__<모델>__<번호>.png 와 한눈에 보는 contact.png
- 비용(2026-11-14 Atlas 가격, 장당): GPT Image 2 developer edit $0.005, GPT Image 1.5 edit $0.005, GPT Image 2 edit $0.006,
  Seedream v5.5 edit $0.016, Seedream v5.0 Pro edit $0.036, Nano Banana 2 edit $0.08.
  기본은 싸고 효율 좋은 두 모델(gptdev, gpt15) × 4아이콘 × 2장 = 16장 ≈ $0.08
- 옵션: --models gpt,s55   --per 1   --icons inr,outr   --dry (요청 없이 계획과 예상 비용만)
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
REF = os.path.join(ROOT, 'tools', 'icon-src', 'ref')
OUT = os.path.join(ROOT, 'tools', 'icon-src', 'ai')
PAGES = 'https://bravecheeze.github.io/tesla-naver-cluster/tools/icon-src/ref/'
API = 'https://api.atlascloud.ai/api/v1/model'
UA = 'tesla-naver-cluster-icons/1.0'

COMMON = ('Redraw this navigation icon as a clean, polished flat vector illustration, keeping exactly the same composition, '
          'proportions and positions: thick dark charcoal road (#313B42) with white edge lines and a white dashed lane line, '
          'the curved ramp, the big white arrow with a large triangular arrowhead, and the interstate-style shield '
          '(red top band, blue body, white border, bold white letters). Smooth even curves, crisp edges, consistent line widths, '
          'no shadows, no gradients, no texture, no 3D, no extra objects, no extra text. Keep the solid flat magenta background '
          '(#FF00FF) everywhere outside the icon. Square 1:1. ')
EXTRA = {
    'inr': 'The ramp comes from the bottom right and merges into the right lane of the highway in the middle of the image; '
           'the arrow follows the ramp and then points straight up. Shield at the top right with the word "IN".',
    'inl': 'The ramp comes from the bottom left and merges into the left lane of the highway in the middle of the image; '
           'the arrow follows the ramp and then points straight up. Shield at the top left with the word "IN".',
    'outr': 'The right lane splits off in the middle and curves to the top right; the arrow starts in the right lane at the bottom '
            'and follows the exit ramp, arrowhead pointing up-right. Shield at the bottom right with the word "OUT".',
    'outl': 'The left lane splits off in the middle and curves to the top left; the arrow starts in the left lane at the bottom '
            'and follows the exit ramp, arrowhead pointing up-left. Shield at the bottom left with the word "OUT".',
}
# 모델: (짧은 이름, 모델 ID, 장당 가격, 요청 본문 만들기)
MODELS = {
    # 싸고 효율 좋은 것 (기본): GPT Image 2 developer $0.005, GPT Image 1.5 $0.005 (참고 그림을 충실히 따르는 input_fidelity high)
    'gptdev': ('openai/gpt-image-2-developer/edit', 0.005,
               lambda p, img: {'prompt': p, 'images': [img], 'size': '1024x1024', 'quality': 'high', 'output_format': 'png'}),
    'gpt15': ('openai/gpt-image-1.5/edit', 0.005,
              lambda p, img: {'prompt': p, 'images': [img], 'size': '1024x1024', 'quality': 'high', 'input_fidelity': 'high', 'output_format': 'png'}),
    'gpt': ('openai/gpt-image-2/edit', 0.006,
            lambda p, img: {'prompt': p, 'images': [img], 'size': '1024x1024', 'quality': 'high', 'output_format': 'png'}),
    's55': ('bytedance/seedream-v5.5/edit', 0.016,
            lambda p, img: {'prompt': p, 'reference_images': [img], 'size': '1024*1024', 'output_format': 'png', 'background': 'opaque'}),
    's50p': ('bytedance/seedream-v5.0-pro/edit', 0.036,
             lambda p, img: {'prompt': p, 'images': [img], 'size': '1024*1024', 'output_format': 'png', 'background': 'opaque'}),
    'nb2': ('google/nano-banana-2/edit', 0.08,
            lambda p, img: {'prompt': p, 'images': [img], 'aspect_ratio': '1:1', 'resolution': '1k', 'output_format': 'png'}),
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


def ref_input(icon):
    """참고 그림: GitHub Pages 주소가 열리면 주소, 아니면 base64 data URI"""
    url = PAGES + 'ref_%s.png' % icon
    try:
        with urllib.request.urlopen(urllib.request.Request(url, method='HEAD', headers={'User-Agent': UA}), timeout=15) as r:
            if r.status == 200:
                return url
    except Exception:
        pass
    with open(os.path.join(REF, 'ref_%s.png' % icon), 'rb') as fh:
        return 'data:image/png;base64,' + base64.b64encode(fh.read()).decode('ascii')


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
    ap.add_argument('--models', default='gptdev,gpt15')   # 다른 모델도 보려면: --models gptdev,gpt15,gpt,s55,s50p,nb2
    ap.add_argument('--icons', default='inr,inl,outr,outl')
    ap.add_argument('--per', type=int, default=2)
    ap.add_argument('--dry', action='store_true')
    a = ap.parse_args()
    models = [m for m in a.models.split(',') if m in MODELS]
    icons = [i for i in a.icons.split(',') if i in EXTRA]
    jobs = [(i, m, n) for i in icons for m in models for n in range(1, a.per + 1)]
    cost = sum(MODELS[m][1] for _, m, _ in jobs)
    print('만들 그림 %d장, 예상 비용 약 $%.2f  (모델: %s)' % (len(jobs), cost, ', '.join(models)))
    if a.dry:
        return
    key = os.environ.get('ATLAS_API_KEY') or os.environ.get('ATLASCLOUD_API_KEY')
    if not key:
        sys.exit('ATLAS_API_KEY 환경 변수가 없습니다. PowerShell: $env:ATLAS_API_KEY = "<키>" 를 먼저 입력하세요.')
    os.makedirs(OUT, exist_ok=True)
    refs = {i: ref_input(i) for i in icons}
    print('참고 그림:', ', '.join('%s=%s' % (i, 'URL' if r.startswith('http') else 'base64') for i, r in refs.items()))
    pending = []
    for i, m, n in jobs:
        mid, price, mk = MODELS[m]
        try:
            pid = submit(key, mid, mk(COMMON + EXTRA[i], refs[i]))
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
