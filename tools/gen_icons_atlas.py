"""길안내 아이콘·분기점 그림을 Atlas Cloud 이미지 모델로 그리기 (사용자가 직접 실행)

- API 키는 이 파일·채팅에 적지 않는다. 실행하는 사람이 자기 터미널에서 환경 변수로 넣는다:
    PowerShell:  $env:ATLAS_API_KEY = "<새로 발급받은 키>"
    그다음:      py -X utf8 tools\gen_icons_atlas.py
- 참고 그림(스타일·구도): tools/icon-src/ 의 사용자 그림과 ref/ 의 지금 앱 그림. GitHub Pages 주소로 넘기고 안 되면 base64.
- 결과: tools/icon-src/ai/<그림>__<모델>__<번호>.png 와 한눈에 보는 contact.png
- 비용(2026-11-14 Atlas 가격, 장당): GPT Image 2.5 Flare edit $0.005, GPT Image 2.5 Sunburst edit $0.005 (developer 판은 $0.03 으로 더 비쌈),
  GPT Image 2 developer $0.005, GPT Image 1.5 $0.005, GPT Image 2 $0.006, Seedream 5.5 $0.016, Seedream 5.0 Pro $0.036, Nano Banana 2 $0.08.
  기본: GPT Image 2.5 Flare·Sunburst × 그림 19가지 × 1장 = 38장 ≈ $0.19
- 내 차 아이콘만:  py -X utf8 tools\gen_icons_atlas.py --icons car_my,car_red,car_white --per 2   (12장 ≈ $0.06)
- 차 아이콘 전부(테슬라 7색 + 귀여운 차 4색): --icons cars --per 2
- 안내 아이콘 전부(나가기/들어가기·급회전·고가/지하차도·회전교차로·유턴·터널·톨게이트·하이패스·분기점·도착/경유 핀·분기점 그림): --icons guide --per 2
- 주의 표지 11가지(미끄러운 도로·낙석·오르막·내리막·노면 고르지 못함·횡풍·야생동물·도로 폭 좁아짐·철길 건널목·위험·과속방지턱): --icons signs --per 2
- 전부: --icons cars,guide,signs --per 2
  테슬라 앱 차 사진을 tools\icon-src
ef
ef_car_app.png 로 저장해 두면 그 느낌을 따라 그린다 (저장소에는 안 올라감)
- 2026-11-14 다시 그리기(나가기/들어가기·고가·지하차도·옆길 16가지 + 회전교차로 4가지, 디자이너 느낌): --icons redo --per 2
  그림 없이 글로만 그린다(GPT Image 2.6 Flare·Sunburst $0.007, Ideogram v4 $0.025): 120장 약 $1.56
  도로만: --icons roads   회전교차로만: --icons rb   구도 밑그림 다시 그리기: py -I tools\ref_roads.py
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
CARS = ('Top-down view, seen from directly above, of a Tesla Model Y in exactly the style of the official Tesla phone app car '
        'render: realistic 3D render, smooth satin paint with soft studio reflections along the hood and front fenders, one huge '
        'dark tinted glass roof running from the windshield to the rear window with the seats faintly visible through the glass, '
        'thin roof seams, small side mirrors angled back, rounded short nose, wide rear haunches, nose pointing straight up, '
        'perfectly symmetric, centered, filling 85% of the image height. Remove any text, labels, padlock icon and charging cable. '
        'No logos, no ground shadow, no other objects.' + BG + ' ')
# 귀여운 차 (설정의 '초록 꼬마차' 같은 결): 위에서 본 모델 Y 를 동글동글한 스티커 그림으로
CUTE = ('Cute chibi cartoon version of a Tesla Model Y seen from directly above, for a navigation map car icon: rounded '
        'chubby proportions, big friendly headlight eyes on the front, small smile, glossy dark glass roof, soft simple shading, '
        'clean flat vector sticker style with a thick white outline, nose pointing straight up, symmetric, centered, filling 85% '
        'of the image height, no text, no logos, no ground shadow.' + BG + ' ')
# 차 참고 그림: 사용자가 테슬라 앱 화면을 ref/ref_car_app.png 로 저장해 두면 그걸 쓴다 (저장소에는 올리지 않는다: .gitignore)
CAR_APP = os.path.join(SRC, 'ref', 'ref_car_app.png')


def car_ref(c):
    return 'ref/ref_car_app.png' if os.path.exists(CAR_APP) else 'ref/ref_car_%s.png' % c


# 주의 표지 (2026-11-14 요청 '이런 것도 다 잘 만들어 줘, 야생동물은 좀… 전체적으로 퀄리티를 올려 줘'):
# 참고 그림은 빈 삼각형(ref/ref_sign.png: 앱의 빨간 테·노란 바탕). 그림 문자는 문장으로 그리게 한다 → 결과는 세 색으로 따서 SVG 로
SIGN = ('Korean road caution sign (주의표지) as a clean flat vector icon. Keep exactly the triangle of the reference image: an '
        'equilateral triangle with softly rounded corners, a thick red border (#E53935) and a bright yellow inside (#FFD200). '
        'Inside the yellow area draw ONE bold black (#111111) pictogram in the official Korean traffic sign style: ')
SIGN_END = ('. Bold, simple, well-balanced shapes with an even stroke weight that stay readable at 24 px, centered in the yellow '
            'area with comfortable margins. Exactly three flat colors (red, yellow, black). No text, no letters, no numbers, '
            'no extra symbols, no gradients, no shadows, no 3D.' + BG + ' ')
SHIELD = ' Small interstate-style shield (red top band, blue body, white border, bold white letters) in an empty corner'
# 2026-11-14 '자바스크립트로 만든 느낌이 너무 강하다, AI 로 디자이너가 만든 것처럼, 잘 나올 때까지':
# 도로 모양 안내 아이콘·회전교차로는 tools/ref_roads.py 가 그린 구도 밑그림(ref/road_<칸>.png, 갈라지는·합류하는 곳이
# 그림 높이 가운데)을 첫 그림으로, 사용자 원본(outr.webp: 가는 선·작은 방패, 사용자가 고른 느낌)을 둘째 그림으로 보낸다
DESIGN = ('Redraw image 1 as a finished, professional turn-by-turn navigation icon, as if made by a senior icon designer for a '
          'premium car navigation app (Naver Map / Tmap quality). Image 1 is only a rough layout sketch: keep its layout exactly '
          '(the same roads, the same place where the roads split or join in the vertical middle of the icon, the same arrow route, '
          'the same shield corner) but redraw every shape cleanly and beautifully. If a second image is given, match its drawing '
          'style (thin crisp lines, small neat shield). Style: flat vector, crisp and refined. Dark charcoal asphalt roads '
          '(#313B42) with thin crisp white edge lines and fine white dashed lane lines; one slim solid white arrow, narrower than '
          'a lane, following the route, with a neat sharp triangular arrowhead; smooth flowing curves with constant road width, '
          'natural merge and diverge tapers, precise alignment, balanced spacing. No outline around the whole icon, no drop '
          'shadow, no gradients, no texture, no 3D, no extra text or symbols.' + BG + ' ')
RB = ('Redraw image 1 as a finished, professional roundabout turn icon, as if made by a senior icon designer for a premium car '
      'navigation app (Naver Map quality). Keep the layout of the sketch exactly (enter from the bottom, travel counter-clockwise, '
      'same exit), but draw it cleanly: a perfectly round light mint-green ring (#C9ECD6) with four short light mint road stubs '
      '(top, bottom, left, right) and a small light mint center island, and ONE slim solid green arrow (#03C75A) of even width '
      'with a crisp, sharp triangular arrowhead. Flat vector, elegant and precise, no outlines, no shadows, no gradients, '
      'no text.' + BG + ' ')
OUT_SH = ' A small interstate-style shield (red top band, blue body, thin white border, white bold letters "%s") in the %s corner.'
ROAD_STYLE_REF = 'outr.webp'   # 사용자 원본: 그림 느낌

# 2026-11-14 두 번째: 편집(edit) 모델에 밑그림을 넣었더니 밑그림을 조금 다듬은 '거의 그대로'가 나왔다(사용자: '이미지 수정본으로
# 들어가버려서 원하는 게 안 나온다, 참고 안 하고 만들 수 있나'). → 이 20가지는 그림 없이 글로만(text-to-image) 그린다.
# 모양새(색·굵기·비율)를 글로 자세히 정해 칸마다 같은 느낌이 나게 하고, 구도는 칸마다 글로 설명한다
T2I_ROAD = ('Professional flat vector icon for the turn-by-turn panel of a premium car navigation app, designed by a senior icon '
            'designer (Naver Map / Apple Maps / Tmap quality). Top-down map view of roads. Clean geometric vector shapes, smooth '
            'bezier curves, perfectly consistent line weights, crisp edges, balanced composition, generous breathing room. '
            'Visual system: road asphalt dark charcoal #313B42; thin white road edge lines (about 1/45 of the icon width); short '
            'white dashed lane lines; exactly ONE slim solid white route arrow (about 1/16 of the icon width) with a clean, sharp '
            'triangular arrowhead. A three-lane road is about 1/4 of the icon width, a one-lane ramp about 1/7. Roads keep a '
            'constant width and split or merge with smooth, natural tapers like real highway ramps. The drawing fills about 85% '
            'of the canvas, centered. Strictly top-down flat map view: every road keeps exactly the same width from one end to the '
            'other, nothing narrows toward the top, no vanishing point, no sense of height. No perspective, no 3D, no shadows '
            'unless described, no gradients, no texture, no outline '
            'around the whole icon, no text except the letters described.' + BG + ' Layout: ')
T2I_RB = ('Professional flat vector roundabout turn icon for the turn-by-turn panel of a premium car navigation app, designed '
          'by a senior icon designer, in the same visual system as a top-down road-map icon set. Top-down view of a '
          'roundabout: a circular ring road with four straight roads (top, bottom, left, right) joining it through smooth flared '
          'corners, all dark charcoal asphalt (#313B42) with thin white edge lines and short white dashed lane lines (a dashed '
          'circle around the ring, dashed center lines on the four roads). In the middle, a round island of fresh green grass '
          '(#7CC24A) with a thin light grey curb, about one third of the ring width. Exactly ONE slim solid white route arrow '
          '(about 1/16 of the icon width) with a clean, sharp triangular arrowhead, drawn on the asphalt. Right-hand traffic: '
          'the arrow comes up the bottom road, enters the ring turning RIGHT, travels counter-clockwise (seen from above) around '
          'the green island and leaves on the exit road; the arrowhead sits on the exit road just outside the ring and never '
          'touches the canvas edge. The roads fill about 85% of the canvas, centered. Flat, no 3D, no shadows, no gradients, '
          'no text, no extra arrows.' + BG + ' Exit: ')
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
    # 내 차 아이콘: 위에서 본 테슬라 모델 Y (사용자 차). 참고 그림은 앱에 그려 넣은 것 (설정 → 자동차 아이콘)
    'car_my': (car_ref('my'), CARS, 'Paint: dark slate grey metallic with a faint blue tint (Stealth Grey), like the reference.'),
    'car_red': (car_ref('red'), CARS, 'Same car, but paint: deep glossy Ultra Red.'),
    'car_white': (car_ref('white'), CARS, 'Same car, but paint: Pearl White with soft grey shading.'),
    # 2026-11-14 '아이콘 좀 많이': 테슬라 색 더 + 귀여운 차 여러 색 (설정 → 자동차 아이콘 후보)
    'car_blue': (car_ref('my'), CARS, 'Same car, but paint: Deep Blue Metallic.'),
    'car_silver': (car_ref('my'), CARS, 'Same car, but paint: Quicksilver, a bright liquid-metal silver.'),
    'car_black': (car_ref('my'), CARS, 'Same car, but paint: glossy Solid Black with crisp reflections so the shape still reads.'),
    'car_cherry': (car_ref('red'), CARS, 'Same car, but paint: Midnight Cherry Red, a deep wine red metallic.'),
    'cute_green': ('ref/ref_car_my.png', CUTE, 'Body color: fresh green (#03C75A).'),
    'cute_pink': ('ref/ref_car_my.png', CUTE, 'Body color: soft pink (#FF8FB1).'),
    'cute_sky': ('ref/ref_car_my.png', CUTE, 'Body color: sky blue (#5AB4FF).'),
    'cute_yellow': ('ref/ref_car_my.png', CUTE, 'Body color: warm yellow (#FFC83D).'),
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
    # 2026-11-14 '안내 아이콘도 여러 개': 왼쪽 짝·회전교차로 직진/유턴·유턴·터널·톨게이트·하이패스·분기점·도착/경유 핀
    'sharp_l': ('l.webp', ARROW, "A SHARP left turn: the arrow comes up from the bottom and turns back down to the lower left "
                "(about the 8 o'clock direction), arrowhead pointing down-left."),
    'over_l': ('ref/ref_outl.png', ROAD, 'Overpass entry: the left lane rises onto an elevated overpass bridge curving up-left, '
               'while the main road continues straight underneath; the arrow follows the rising overpass ramp. No shield.'),
    'under_s': ('ref/ref_outr.png', ROAD, 'Underpass straight ahead: the middle lanes go down into an underpass tunnel mouth '
                '(a dark rectangular opening) straight ahead; the arrow goes straight up into the underpass. No shield.'),
    'side_l': ('ref/ref_outl.png', ROAD, 'Side road next to an underpass: the middle road goes down into an underpass, and the '
               'arrow stays on the left-hand surface side road that runs alongside and continues up. No shield.'),
    'rb_s': ('rb.webp', ARROW, 'Roundabout, go STRAIGHT through: a pale thin ring with four short pale road stubs; one bold white '
             'arrow enters from the bottom, goes counter-clockwise half way around and exits at the top with a large arrowhead. '
             'Single color, like Naver Map turn icons.'),
    'rb_u': ('rb.webp', ARROW, 'Roundabout U-turn: a pale thin ring with four short pale road stubs; one bold white arrow enters '
             'from the bottom, goes counter-clockwise all the way around and exits back down at the bottom next to where it '
             'entered, with a large arrowhead pointing down. Single color, like Naver Map turn icons.'),
    'u': ('u.webp', ARROW, 'U-turn: one bold white arrow goes straight up, makes a tight rounded turn to the left at the top '
          'and comes back down, arrowhead pointing down. Clean and symmetric, like Naver Map.'),
    'tunnel': ('s.webp', 'Flat vector navigation icon of a road TUNNEL entrance, front view, in the clean style of Naver Map '
               'navigation icons: a rounded concrete tunnel portal (light grey arch with a subtle darker inner rim) set into a '
               'simple green hillside silhouette, a dark tunnel opening with a few small warm yellow lights inside, and a dark '
               'charcoal road with white edge lines and a white dashed center line running straight into the opening, drawn in '
               'gentle perspective. Bold simple shapes that read well at 26 px, crisp edges, no text, no letters, no arrow, '
               'no cars, no shadows on the background.' + CORP + BG + ' ', ''),
    'toll': ('toll.webp', ROAD, 'Toll gate: a straight road leading up to a row of toll booths under a flat canopy roof; '
             'the arrow passes through the middle booth. Keep the style of the reference.'),
    'hipass': ('toll.webp', ROAD, 'Hi-pass (electronic toll) lane: a straight road leading up to toll booths under a canopy; the '
               'middle lane is marked blue with a small white car-and-signal symbol and the arrow passes through it.'),
    'jc_r': ('ref/ref_outr.png', ROAD, 'Highway junction (JC): the highway splits into two equally wide highways, one continuing '
             'up and one curving to the upper right; the arrow follows the right branch.' + SHIELD + ' with "JC".'),
    'jc_l': ('ref/ref_outl.png', ROAD, 'Highway junction (JC): the highway splits into two equally wide highways, one continuing '
             'up and one curving to the upper left; the arrow follows the left branch.' + SHIELD + ' with "JC".'),
    'goal3d': ('goal.webp', 'Navigation destination pin icon in the style of the reference, but more three-dimensional: '
               'glossy red map pin with soft highlight and shading, white round center with a small checkered flag, '
               'a soft oval shadow under the tip. Clean, premium, no text.' + BG + ' ', ''),
    'via3d': ('via.webp', 'Navigation waypoint pin icon in the style of the reference, but more three-dimensional: glossy '
              'blue map pin with soft highlight and shading, white round center, a soft oval shadow under the tip. '
              'Clean, premium, no text.' + BG + ' ', ''),
    'sign_slip': ('ref/ref_sign.png', SIGN, 'slippery road: a car seen from behind, with two wavy skid tracks curving below it' + SIGN_END),
    'sign_rock': ('ref/ref_sign.png', SIGN, 'falling rocks: a steep cliff face on the right with three angular rocks tumbling down toward the lower left' + SIGN_END),
    'sign_up': ('ref/ref_sign.png', SIGN, 'steep ascent: a solid black right-angled wedge whose slope rises from the lower left to the right' + SIGN_END),
    'sign_down': ('ref/ref_sign.png', SIGN, 'steep descent: a solid black right-angled wedge whose slope falls from the upper left to the lower right' + SIGN_END),
    'sign_rough': ('ref/ref_sign.png', SIGN, 'uneven road: a thick road surface line along the bottom with two rounded bumps rising from it' + SIGN_END),
    'sign_wind': ('ref/ref_sign.png', SIGN, 'crosswind: a windsock on a vertical pole, the sock blowing out horizontally to the right' + SIGN_END),
    'sign_animal': ('ref/ref_sign.png', SIGN, 'wild animal crossing: a leaping deer silhouette in side view, facing right, elegant and anatomically correct, slim legs stretched mid-jump, small head with short antlers' + SIGN_END),
    'sign_narrow': ('ref/ref_sign.png', SIGN, 'road narrows: two bold vertical road edge lines that come in symmetrically from wide at the bottom to narrow at the top' + SIGN_END),
    'sign_rail': ('ref/ref_sign.png', SIGN, 'railway level crossing: a simple steam locomotive silhouette in side view facing left, with a chimney and two big wheels' + SIGN_END),
    'sign_danger': ('ref/ref_sign.png', SIGN, 'general danger: one bold black exclamation mark' + SIGN_END),
    'sign_bump': ('ref/ref_sign.png', SIGN, 'speed bump: a thick road line along the bottom with one rounded hump in the middle' + SIGN_END),
}
# 2026-11-14 다시 (위 DESIGN·RB): 같은 이름의 예전 항목을 덮어쓴다. 참고 그림은 (구도 밑그림, 원본 그림 느낌)


def _mirror(t):
    for a, b in (('RIGHT', 'LEFT'), ('right', 'left')):
        t = t.replace(a, '@@').replace(b, a).replace('@@', b)
    return t


_ROADS = {
    'outr': 'Highway EXIT to the RIGHT: a straight three-lane highway runs vertically; in the vertical middle of the icon a single-lane '
            'exit ramp splits off its right side and leaves through the right edge, rising gently. The arrow comes up the middle '
            'lane and curves onto the exit ramp, arrowhead pointing up-right.' + OUT_SH % ('OUT', 'top-left'),
    'inr': 'Highway ENTRANCE from the RIGHT: a vertical three-lane highway runs straight up the left-center of the icon. A '
           'single-lane on-ramp enters from the lower part of the RIGHT edge, runs diagonally up-left and merges into the right '
           'side of the highway in the vertical middle of the icon. The arrow STARTS ON THE ON-RAMP at the lower right (not on '
           'the highway), follows the ramp diagonally up-left, merges into the highway and then turns straight up, arrowhead '
           'pointing up near the top. No arrow on the highway below the merge.' + OUT_SH % ('IN', 'top-right'),
    'outs': 'Highway EXIT STRAIGHT AHEAD, seen flat from directly above: a three-lane highway comes up from the bottom edge; in '
            'the vertical middle of the icon the highway itself bends away to the LEFT and leaves through the left edge (still '
            'three lanes wide), while a one-lane exit road, about as wide as one highway lane, continues perfectly straight up '
            'to the top edge with the same width all the way. A small triangular gore area separates the exit road from the '
            'bending highway. The arrow runs straight up the exit road, arrowhead near the top.' + OUT_SH % ('OUT', 'top-right'),
    'ins': 'Highway ENTRANCE STRAIGHT AHEAD, seen flat from directly above: a one-lane road, about as wide as one highway lane, '
           'comes straight up from the bottom edge; in the vertical middle of the icon a three-lane highway enters from the LEFT '
           'edge, bends upward and runs alongside it, and together they continue straight up to the top edge as one wide road '
           'of constant width (four lanes). The arrow starts on the one-lane road at the bottom and runs straight up, arrowhead '
           'near the top.' + OUT_SH % ('IN', 'top-right'),
    'over_s': 'OVERPASS STRAIGHT AHEAD: a vertical road crosses OVER a horizontal road on a bridge in the middle of the icon. Make '
              'the bridge obvious: short white bridge parapets with flared ends on both sides of the vertical road where it '
              'passes over, and a soft shadow on the road below. The arrow goes straight up over the bridge. No shield.',
    'over_r': 'OVERPASS to the RIGHT: a vertical three-lane road continues straight up; in the vertical middle of the icon a '
              'single-lane ramp branches off to the right and climbs onto a bridge that passes over a horizontal road in the upper '
              'right (white bridge parapets with flared ends, soft shadow below). The arrow follows the ramp over the bridge, '
              'arrowhead pointing up. No shield.',
    'under_s': 'UNDERPASS STRAIGHT AHEAD: a vertical road goes straight into an underpass opening at the top of the icon (front '
               'view of a concrete portal: light grey rounded frame around a dark opening). The arrow goes straight up into the '
               'opening. No shield.',
    'under_r': 'UNDERPASS to the RIGHT: a vertical three-lane road continues straight up; in the vertical middle of the icon a '
               'single-lane road branches off to the right and goes up into an underpass opening (light grey rounded concrete '
               'portal with a dark opening) in the upper right. The arrow follows it into the opening. No shield.',
    'side_r': 'SIDE ROAD beside an UNDERPASS, keep RIGHT: the middle road goes straight up into an underpass opening (light grey '
              'rounded concrete portal with a dark opening) at the top; in the vertical middle of the icon a single-lane side road '
              'branches off to the right and stays at street level beside the portal, continuing straight up. The arrow takes the '
              'right side road and avoids the underpass. No shield.',
    'oside_r': 'SIDE ROAD beside an OVERPASS, keep RIGHT: the middle road climbs onto a bridge (white bridge parapets with flared '
               'ends, soft shadow below) that passes over a horizontal road near the top; in the vertical middle of the icon a '
               'single-lane side road branches off to the right and stays at street level beside it, crossing the horizontal road. '
               'The arrow takes the right side road. No shield.',
}
for _k in [k for k in _ROADS if k.endswith('_r')]:
    _ROADS[_k[:-1] + 'l'] = _mirror(_ROADS[_k])
_ROADS['outl'] = _mirror(_ROADS['outr'])     # 방패도 반대쪽 위 모서리로 (top-left ↔ top-right)
_ROADS['inl'] = _mirror(_ROADS['inr'])
for _k, _t in _ROADS.items():
    JOBS[_k] = ((), T2I_ROAD, _t)   # 글로만 (밑그림 ref/road_<칸>.png 는 사람이 구도를 보는 용도)
_RB = {
    'rb_r': 'The arrow enters from the bottom, goes a quarter turn counter-clockwise around the ring and exits to the RIGHT.',
    'rb_s': 'The arrow enters from the bottom, goes half way around the ring counter-clockwise (along the right side) and exits at the TOP (straight ahead).',
    'rb_l': 'The arrow enters from the bottom, goes three quarters around the ring counter-clockwise (along the right side, over the top) and exits to the LEFT.',
    'rb_u': 'U-turn: the arrow enters from the bottom slightly right of center, goes all the way around the ring counter-clockwise '
            '(right side, top, left side) and exits back DOWN the bottom road slightly left of center, arrowhead pointing down; '
            'keep the incoming and outgoing lines clearly apart.',
}
for _k, _t in _RB.items():
    JOBS[_k] = ((), T2I_RB, _t)
ROADS, RBS = list(_ROADS), list(_RB)
WIDE = {'junc_fork_r', 'junc_exit_r'}


def _gpt25(model):
    return (model, 0.005, lambda p, imgs, wide=False: {'prompt': p, 'images': imgs, 'size': '1536x1024' if wide else '1024x1024',
                                                       'quality': 'medium', 'background': 'opaque', 'output_format': 'png', 'n': 1})


# 모델: 짧은 이름 → (모델 ID, 장당 가격, 요청 본문 만들기)
MODELS = {
    'flare': _gpt25('openai/gpt-image-2.5-flare/edit'),          # 기본 (싸고 최신)
    'sunburst': _gpt25('openai/gpt-image-2.5-sunburst/edit'),    # 기본 (싸고 최신)
    'gptdev': ('openai/gpt-image-2-developer/edit', 0.005,
               lambda p, imgs, wide=False: {'prompt': p, 'images': imgs, 'size': '1536x1024' if wide else '1024x1024',
                                           'quality': 'high', 'output_format': 'png'}),
    'gpt15': ('openai/gpt-image-1.5/edit', 0.005,
              lambda p, imgs, wide=False: {'prompt': p, 'images': imgs, 'size': '1536x1024' if wide else '1024x1024',
                                          'quality': 'high', 'input_fidelity': 'high', 'output_format': 'png'}),
    'gpt': ('openai/gpt-image-2/edit', 0.006,
            lambda p, imgs, wide=False: {'prompt': p, 'images': imgs, 'size': '1536x1024' if wide else '1024x1024',
                                        'quality': 'high', 'output_format': 'png'}),
    's55': ('bytedance/seedream-v5.5/edit', 0.016,
            lambda p, imgs, wide=False: {'prompt': p, 'reference_images': imgs, 'size': '2048*1152' if wide else '1024*1024',
                                        'output_format': 'png', 'background': 'opaque'}),
    's50p': ('bytedance/seedream-v5.0-pro/edit', 0.036,
             lambda p, imgs, wide=False: {'prompt': p, 'images': imgs, 'size': '2048*1152' if wide else '1024*1024',
                                         'output_format': 'png', 'background': 'opaque'}),
    # 글로만 그리는 모델 (참고 그림을 보내지 않는다)
    'flare26': ('openai/gpt-image-2.6-flare/text-to-image', 0.007,
                lambda p, imgs, wide=False: {'prompt': p, 'size': '1536x1024' if wide else '1024x1024', 'quality': 'medium',
                                             'complexity': 'high', 'background': 'opaque', 'output_format': 'png', 'n': 1}),
    'sunburst26': ('openai/gpt-image-2.6-sunburst/text-to-image', 0.007,
                   lambda p, imgs, wide=False: {'prompt': p, 'size': '1536x1024' if wide else '1024x1024', 'quality': 'medium',
                                                'complexity': 'high', 'background': 'opaque', 'output_format': 'png', 'n': 1}),
    'ideo': ('ideogram/v4/quality/text-to-image', 0.025,
             lambda p, imgs, wide=False: {'prompt': p[:2000], 'image_size': 'landscape_4_3' if wide else 'square_hd',
                                          'output_format': 'png'}),
    'nb2': ('google/nano-banana-2/edit', 0.08,
            lambda p, imgs, wide=False: {'prompt': p, 'images': imgs, 'aspect_ratio': '16:9' if wide else '1:1',
                                        'resolution': '1k', 'output_format': 'png'}),
}


T2I_MODELS = {'flare26', 'sunburst26', 'ideo'}


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
    """참고 그림: GitHub Pages 주소가 열리고 내 파일과 같은 크기면 주소, 아니면 base64 data URI
    (밑그림을 고쳐 올린 직후에는 Pages 가 10분쯤 예전 파일을 줄 수 있어 크기로 확인한다)"""
    url = PAGES + rel
    path = os.path.join(SRC, rel)
    try:
        with urllib.request.urlopen(urllib.request.Request(url, method='HEAD', headers={'User-Agent': UA}), timeout=15) as r:
            if r.status == 200 and str(os.path.getsize(path)) == (r.headers.get('Content-Length') or ''):
                return url
    except Exception:
        pass
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
    ap.add_argument('--models', default='')   # 비우면: 참고 그림이 있는 칸은 flare,sunburst / 글로만 쓰는 칸은 flare26,sunburst26,ideo   # 다른 모델도: flare,sunburst,gptdev,gpt15,gpt,s55,s50p,nb2
    ap.add_argument('--icons', default=','.join(JOBS))
    ap.add_argument('--per', type=int, default=1)
    ap.add_argument('--dry', action='store_true')
    a = ap.parse_args()
    models = [m for m in (a.models or 'flare,sunburst,flare26,sunburst26,ideo').split(',') if m in MODELS]
    # 묶음 이름: cars = 모든 차 아이콘(car_*·cute_*), guide = 차가 아닌 안내 아이콘·분기점 그림 전부
    is_car = lambda k: k.startswith(('car_', 'cute_'))
    is_sign = lambda k: k.startswith('sign_')
    groups = {'cars': [k for k in JOBS if is_car(k)], 'signs': [k for k in JOBS if is_sign(k)],
              'guide': [k for k in JOBS if not is_car(k) and not is_sign(k)],
              'roads': ROADS, 'rb': RBS, 'redo': ROADS + RBS}
    want = []
    for i in a.icons.split(','):
        want += groups.get(i, [i])
    icons = [i for i in dict.fromkeys(want) if i in JOBS]
    # 글로만 쓰는 칸(참고 그림 없음)은 글로 그리는 모델로만
    auto = not a.models
    jobs = [(i, m, n) for i in icons for m in models for n in range(1, a.per + 1)
            if (m in T2I_MODELS) == (not JOBS[i][0]) or (not auto and (JOBS[i][0] or m in T2I_MODELS))]
    cost = sum(MODELS[m][1] for _, m, _ in jobs)
    print('만들 그림 %d장, 예상 비용 약 $%.2f  (모델: %s)' % (len(jobs), cost, ', '.join(m for m in models if any(m == x for _, x, _ in jobs))))
    if a.dry:
        return
    key = os.environ.get('ATLAS_API_KEY') or os.environ.get('ATLASCLOUD_API_KEY')
    if not key and os.name == 'nt':
        # setx 로 저장한 키는 이미 열려 있던 창에는 안 보인다: 사용자 환경 변수(레지스트리)에서 직접 읽는다
        try:
            import winreg
            with winreg.OpenKey(winreg.HKEY_CURRENT_USER, 'Environment') as hk:
                key = winreg.QueryValueEx(hk, 'ATLAS_API_KEY')[0]
        except OSError:
            key = None
    if not key:
        sys.exit('ATLAS_API_KEY 환경 변수가 없습니다. PowerShell: $env:ATLAS_API_KEY = "<키>" 를 먼저 입력하세요.')
    os.makedirs(OUT, exist_ok=True)
    as_list = lambda r: [r] if isinstance(r, str) else list(r)
    cache = {}
    refs = {i: [cache.setdefault(r, ref_input(r)) for r in as_list(JOBS[i][0])] for i in icons}
    print('참고 그림:', ', '.join('%s=%s' % (i, '+'.join('URL' if r.startswith('http') else 'b64' for r in rs)) for i, rs in refs.items()))
    pending = []
    for i, m, n in jobs:
        mid, price, mk = MODELS[m]
        try:
            ref, style, extra = JOBS[i]
            try:
                pid = submit(key, mid, mk(style + extra, refs[i], i in WIDE))
            except RuntimeError as e:
                if len(refs[i]) < 2:
                    raise
                print('  (참고 그림 여러 장이 안 돼 밑그림 한 장으로 다시: %s)' % str(e)[:120])
                pid = submit(key, mid, mk(style + extra, refs[i][:1], i in WIDE))
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
