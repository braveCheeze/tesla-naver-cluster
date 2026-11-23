"""단속 표지 밑그림 (AI 아틀라스 편집용 구도만, 분홍 바탕) → tools/icon-src/ref/ref_cam_<칸>.png

- 숫자 없는 틀: ref_cam_speed·ref_cam_signal·ref_cam_mobile (흰 원·두꺼운 테·위쪽 작은 그림)
- 숫자 있는 표지: ref_cam_<speed|signal|mobile>_<제한> — 네이버 길안내 배지 비율(2026-11-23 운전자 '110을 저기 규격에 잘 맞춰주고'):
  원 지름 D 에 대해 그림 가운데 높이 27%, 숫자 대문자 높이 29%·가운데 높이 57%, 숫자 폭은 흰 원 안에 여유를 두고
- 사용:  py -I tools/ref_cams.py   그다음  py -X utf8 tools/gen_icons_atlas.py --icons camnum
"""
import os
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'tools', 'icon-src', 'ref')
S = 1024
C, R, W = S // 2, 430, 96          # 원 가운데·반지름·테 두께
RED, BLUE = (232, 32, 42), (41, 121, 255)
# 20~130 (2026-11-23 운전자 '혹시모르니 130까지는 만들어 놔'): 세 종류 모두 같은 범위
LIMITS = {k: tuple(range(20, 140, 10)) for k in ('speed', 'signal', 'mobile')}


def font(px):
    for f in ('arialbd.ttf', 'C:/Windows/Fonts/arialbd.ttf', 'DejaVuSans-Bold.ttf'):
        try:
            return ImageFont.truetype(f, px)
        except OSError:
            continue
    return ImageFont.load_default()


def badge(ring, pict, num=None):
    im = Image.new('RGB', (S, S), (255, 0, 255))
    d = ImageDraw.Draw(im)
    d.ellipse([C - R, C - R, C + R, C + R], fill=ring)
    d.ellipse([C - R + W, C - R + W, C + R - W, C + R - W], fill=(255, 255, 255))
    top = C - R + round(0.27 * 2 * R)       # 그림 가운데 높이 27%
    if pict == 'cam':
        d.rounded_rectangle([C - 105, top - 50, C + 45, top + 50], radius=26, fill=(17, 17, 17))
        d.polygon([(C + 40, top), (C + 110, top - 44), (C + 110, top + 44)], fill=(17, 17, 17))
        for x in (C - 66, C + 6):
            d.ellipse([x - 22, top - 22, x + 22, top + 22], fill=(255, 255, 255))
    else:
        d.rounded_rectangle([C - 130, top - 44, C + 130, top + 44], radius=40, fill=(34, 34, 34))
        for x, col in ((C - 80, (255, 59, 48)), (C, (255, 204, 0)), (C + 80, (52, 199, 89))):
            d.ellipse([x - 30, top - 30, x + 30, top + 30], fill=col)
    if num is not None:
        txt = str(num)
        cap = round(0.29 * 2 * R)          # 숫자 대문자 높이 29%
        cy = C - R + round(0.57 * 2 * R)   # 숫자 가운데 높이 57%
        f = font(round(cap / 0.716))
        x0, y0, x1, y1 = d.textbbox((0, 0), txt, font=f)
        maxw = 2 * R - 2 * W - 70           # 흰 원 안 여유
        if x1 - x0 > maxw:                  # 세 자리가 넘치면 글자 폭만 줄인다 (높이는 그대로)
            tmp = Image.new('L', (x1 - x0 + 4, y1 - y0 + 4), 0)
            ImageDraw.Draw(tmp).text((-x0 + 2, -y0 + 2), txt, font=f, fill=255)
            tmp = tmp.resize((maxw, tmp.height), Image.LANCZOS)
            im.paste((17, 17, 17), (C - maxw // 2, cy - tmp.height // 2), tmp)
        else:
            d.text((C - (x1 - x0) / 2 - x0, cy - (y1 - y0) / 2 - y0), txt, font=f, fill=(17, 17, 17))
    return im


def main():
    os.makedirs(OUT, exist_ok=True)
    kinds = {'speed': (RED, 'cam'), 'signal': (RED, 'sig'), 'mobile': (BLUE, 'cam')}
    n = 0
    for k, (ring, pict) in kinds.items():
        badge(ring, pict).save(os.path.join(OUT, 'ref_cam_%s.png' % k))
        n += 1
        for lim in LIMITS[k]:
            badge(ring, pict, lim).save(os.path.join(OUT, 'ref_cam_%s_%d.png' % (k, lim)))
            n += 1
    print('밑그림 %d장 → %s' % (n, os.path.relpath(OUT, ROOT)))


if __name__ == '__main__':
    main()
