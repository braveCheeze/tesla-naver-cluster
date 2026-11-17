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
- 애매한 칸만 다시(회전교차로·오른쪽 들어가기·직진 나가기/들어가기·지하차도 직진·옆길): --icons fix --per 3  (60장 약 $0.42, 끝나면 img/ai 까지 자동)
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
    'under_s': 'UNDERPASS STRAIGHT AHEAD, seen flat from directly above: a three-lane road of constant width runs straight up '
               'from the bottom edge and ends near the top in an underpass opening, drawn as a small light grey rounded concrete '
               'portal with a dark opening exactly as wide as the road (like a tunnel-mouth symbol at the end of the road). The '
               'arrow runs straight up the middle lane into the opening. No shield.',
    'under_r': 'UNDERPASS to the RIGHT: a vertical three-lane road continues straight up; in the vertical middle of the icon a '
               'single-lane road branches off to the right and goes up into an underpass opening (light grey rounded concrete '
               'portal with a dark opening) in the upper right. The arrow follows it into the opening. No shield.',
    'side_r': 'SIDE ROAD beside an UNDERPASS, keep RIGHT, seen flat from directly above: a three-lane road of constant width '
              'comes up from the bottom edge and continues straight up into an underpass opening near the top (a small light grey '
              'rounded concrete portal with a dark opening as wide as the road). In the vertical middle of the icon a one-lane '
              'side road of constant width branches off to the RIGHT and runs straight up to the top edge beside the portal, at '
              'street level. The arrow starts in the right lane at the bottom, moves onto the side road and runs up it, '
              'arrowhead near the top; it never goes into the opening. No shield.',
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
T2I_ROAD2 = ('Professional navigation turn icon for the turn-by-turn panel of a premium car navigation app, designed by a senior '
             'icon designer (Naver Map / Tmap quality). Top-down bird\'s-eye view with no perspective: every road keeps the same '
             'width end to end and nothing narrows toward the top. Depth comes only from shading and layering: soft shadows under '
             'raised roads, slightly lighter bridge decks, light concrete retaining walls and darker asphalt where a road goes down. '
             'Roads: dark charcoal asphalt (#313B42) with thin crisp white edge lines and short white dashed lane lines; a '
             'three-lane road is about 1/3 of the icon width, a one-lane ramp about 1/6. The ROUTE ARROW is the most important '
             'element: ONE bold solid white arrow, about 1/9 of the icon width, with a large sharp triangular arrowhead and a thin '
             'dark outline so it pops, clearly bigger and brighter than any lane marking. Branch roads stay attached to the main '
             'road and split off gradually along a smooth diagonal, with no gaps and no broken edges. The drawing fills the square '
             'canvas (about 90%), centered, using the full width. Flat vector, crisp, no text except the letters described.' + BG +
             ' Layout: ')
_ROADS3 = {
    'outs': 'Highway EXIT STRAIGHT AHEAD: a three-lane highway comes up from the bottom edge; in the middle of the icon the highway '
            'bends away to the LEFT and leaves through the left edge, while a one-lane exit road continues straight up to the top '
            'edge, splitting off gradually with a small triangular gore. The bold arrow runs straight up the exit road from the '
            'bottom to near the top.' + OUT_SH % ('OUT', 'top-right'),
    'ins': 'Highway ENTRANCE STRAIGHT AHEAD: a one-lane road comes straight up from the bottom edge; in the middle of the icon a '
           'three-lane highway arrives from the LEFT edge, bends upward and joins it into one continuous wide road (one smooth paved '
           'surface, no seams, no gaps) that continues straight up to the top edge. The bold arrow runs straight up from the bottom '
           'to near the top.' + OUT_SH % ('IN', 'top-right'),
    'over_r': 'OVERPASS to the RIGHT: a vertical three-lane road runs straight up the left part of the icon. Its right lane splits '
              'off gradually along a smooth diagonal (attached, no gap) as a one-lane ramp that rises and crosses OVER a horizontal '
              'road in the upper right on a bridge: the bridge deck is slightly lighter, has white parapets and casts a soft shadow '
              'on the road below, so it is clearly raised above it. The bold arrow follows the ramp up onto the bridge, arrowhead '
              'pointing up. No shield.',
    'under_s': 'UNDERPASS STRAIGHT AHEAD: a three-lane road runs straight up from the bottom edge and goes DOWN into an underpass: '
               'light concrete retaining walls along both sides grow wider toward the top, the asphalt gets darker, and at the top a '
               'LARGE underpass portal (concrete frame with a dark opening, about half the icon width) swallows the road. The bold '
               'arrow runs straight up into the dark opening. No shield.',
    'under_r': 'UNDERPASS to the RIGHT: a vertical three-lane road runs straight up the left part of the icon. Its right lane splits '
               'off gradually along a smooth diagonal (attached, no gap) as a one-lane ramp that goes DOWN between light concrete '
               'retaining walls into a LARGE underpass portal (concrete frame, dark opening, about 40% of the icon width) in the '
               'upper right. The bold arrow follows the ramp into the opening. No shield.',
    'side_r': 'SIDE ROAD beside an UNDERPASS, keep RIGHT: a wide road comes up from the bottom edge. Its middle lanes go DOWN between '
              'light concrete retaining walls into a LARGE underpass portal (concrete frame, dark opening) at the top, left of '
              'center. Its right lane splits off gradually along a smooth diagonal (attached, no gap) as a one-lane side road that '
              'stays at street level beside the underpass and continues up to the top edge on the right. The bold arrow starts in '
              'the right lane at the bottom, follows the diagonal side road and points up; it never enters the underpass. No shield.',
    'oside_r': 'SIDE ROAD beside an OVERPASS, keep RIGHT: a wide road comes up from the bottom edge. Its middle lanes rise onto an '
               'overpass bridge (slightly lighter deck, white parapets, soft shadow on the ground) that crosses OVER a horizontal '
               'road near the top. Its right lane splits off gradually along a smooth diagonal (attached, no gap) as a one-lane side '
               'road that stays at ground level beside the bridge, meets the horizontal road at a normal intersection and continues '
               'up to the top edge on the right. The bold arrow starts in the right lane at the bottom, follows the diagonal side '
               'road and points up; it never goes onto the bridge. No shield.',
}
for _k, _t in _ROADS3.items():
    JOBS[_k] = ((), T2I_ROAD2, _t)
EDIT_KEEP = ('Edit this navigation icon. Keep exactly its drawing style, colors, line weights, flat top-down view, proportions, '
             'canvas size and the solid magenta background. ')
RB_EDIT = (EDIT_KEEP + 'Keep the same roundabout: the same ring road, the same four roads and the same green grass island. Remove '
           'the existing route arrow and remove the white dashed lane lines on the ring (keep the thin white edge lines and '
           'the dashed center lines on the four roads). Then draw ONE bold solid white route arrow, about 1/10 of the icon '
           'width, with a large sharp triangular arrowhead, clearly the most visible element of the icon. Right-hand traffic: '
           'it comes up the right half of the bottom road, enters the ring turning RIGHT, follows the ring counter-clockwise '
           'around the green island (never crossing it) and leaves on the exit road; the arrowhead sits on the exit road just '
           'outside the ring. Exit: ')
for _k, _t in _RB.items():
    JOBS[_k] = (('ref/base_rb.png',), RB_EDIT, _t)
# 오른쪽 출구: 2라운드 6장 모두 화살표가 왼쪽·위로 크게 돌아 오른쪽으로 나갔다(시계 방향, 틀림) → 첫 출구·짧은 1/4 바퀴라고 못 박는다
JOBS['rb_r'] = (('ref/base_rb.png',), EDIT_KEEP + 'Keep the same roundabout: the same ring road, the same four roads and the same '
                'green grass island. Remove the existing route arrow and the white dashed lane lines on the ring (keep the thin '
                'white edge lines and the dashed center lines on the four roads). Then draw ONE bold solid white route arrow, about '
                '1/10 of the icon width, with a large sharp triangular arrowhead. FIRST EXIT, a short quarter turn: the arrow comes '
                'up the right half of the bottom road, curves to the right through ONLY the lower-right quarter of the ring and '
                'leaves on the RIGHT road, arrowhead pointing right. It must NOT go around the left side or over the top of the '
                'ring: the left half and the top of the ring stay plain asphalt with no arrow and no white line. One continuous '
                'arrow with exactly one arrowhead.', '')
JOBS['under_s'] = (('ref/base_side_r.png',), EDIT_KEEP,
                   'Change it to UNDERPASS STRAIGHT AHEAD: remove the side road on the right and its arrow completely. Keep the '
                   'main three-lane road, now centered horizontally, running straight up from the bottom edge into the same '
                   'light grey concrete portal with the dark opening at the top, with the same constant width all the way (no '
                   'perspective). Draw one slim solid white arrow straight up the middle lane into the dark opening. No shield.')
# 회전교차로 잔디: 고른 4장(ref/base_rb_<출구>.png)에서 가운데 섬만 진짜 잔디처럼
RB_GRASS = (EDIT_KEEP + 'Change ONLY the round center island: make it look like a real grass lawn seen from above, fresh green turf '
            'with fine grass texture, a few darker green tufts and soft natural shading, surrounded by a thin light grey concrete '
            'curb. Keep the route arrow, the roads, the ring and everything else exactly as they are.')
GRASS = {k: (('ref/base_%s.png' % k,), RB_GRASS, '') for k in RBS}   # --icons grass
JV = ('Junction close-up illustration for the guidance panel of a premium car navigation display (like the Naver Map or Tmap '
      'junction view), polished modern flat-vector illustration with soft gradients and crisp edges, very wide 8:3 panorama. '
      'First-person driver view looking straight ahead along a highway in gentle perspective, horizon at about one quarter from '
      'the top. ')
JV_DAY = ' Daytime: soft light-blue sky gradient, faint distant hills, fresh green grass shoulders, mid-grey asphalt with crisp white lane markings and white edge lines.'
JV_NIGHT = (' Night: deep navy sky gradient with a faint warm glow on the horizon, dark green-grey shoulders, dark asphalt with bright '
            'white lane markings and edge lines, tiny reflective road studs.')
JV_END = (' No text, no letters, no road signs, no route numbers, no cars, no people, no logos, no buildings in the foreground. Keep '
          'the lower-left corner and the upper-right corner calm and simple, because the app places small labels there.')
JV_FORK = ('The road splits ahead into two equally wide branches, one curving gently to the left and one curving gently to the '
           'right. The RIGHT branch is the route: its lane is highlighted in vivid blue (#2F7DFF) with one large clean white arrow '
           'on it that curves into the right branch. The left branch is plain asphalt.')
JV_RAMP = ('A straight multi-lane highway continues ahead to the horizon; on the right, an exit ramp separates from the rightmost '
           'lane and curves away to the right. The exit ramp is the route: highlighted in vivid blue (#2F7DFF) with one large clean '
           'white arrow curving onto it. The main highway lanes are plain asphalt.')
PANO = {'junc_fork_day', 'junc_fork_night', 'junc_ramp_day', 'junc_ramp_night'}
JOBS['junc_fork_day'] = ((), JV, JV_FORK + JV_DAY + JV_END)
JOBS['junc_fork_night'] = ((), JV, JV_FORK + JV_NIGHT + JV_END)
JOBS['junc_ramp_day'] = ((), JV, JV_RAMP + JV_DAY + JV_END)
JOBS['junc_ramp_night'] = ((), JV, JV_RAMP + JV_NIGHT + JV_END)
GREEN_EDIT = ('Edit this navigation icon. Keep exactly the same road layout, the same composition, the same flat top-down bird\'s-eye '
              'view (no perspective, roads keep their width), the same style and the solid magenta background. Make the ROUTE stand out: '
              'recolor the route arrow to vivid green (#03C75A) with a thin dark-green outline, make it about twice as thick with a '
              'bigger, sharper arrowhead, and tint the lane or road the route follows with a soft translucent green. Everything that is '
              'not the route stays grey and white. ')
GREEN_ROAD = {
    'ramp': 'Give the ramp more depth: subtle shading along its edges and a soft shadow where it separates from or joins the '
            'main road, so it reads as a real highway ramp; the green arrow should feel like it is moving along it.',
    'over': 'Make the overpass clearly raised: the bridge deck is slightly lighter, has visible concrete side walls and slim pillars, '
            'and casts a strong soft shadow on the road below; the route visibly climbs up onto the bridge and over the other road.',
    'under': 'Make the underpass clearly go down: the road dips between light concrete retaining walls that grow taller toward the '
             'dark tunnel opening, the asphalt gets darker as it goes under, with depth shading inside the opening; the green route '
             'visibly descends into it.',
    'side': 'Make the structure in the middle read clearly in 3D (concrete walls and shading, a dark tunnel opening or a raised '
            'bridge deck with shadow), while the green route stays on the street-level side road beside it.',
    'rb': 'Keep the green grass island, the ring and the four roads exactly. Only the route arrow changes as described.',
}
GREEN_KIND = {'outr': 'ramp', 'inr': 'ramp', 'outs': 'ramp', 'ins': 'ramp', 'over_s': 'over', 'over_r': 'over', 'under_s': 'under',
              'under_r': 'under', 'side_r': 'side', 'oside_r': 'side', 'rb_l': 'rb', 'rb_s': 'rb', 'rb_r': 'rb', 'rb_u': 'rb'}
GREEN = {k: (('ref/base2_%s.png' % k,), GREEN_EDIT, GREEN_ROAD[v]) for k, v in GREEN_KIND.items()}   # --icons green
# 2026-11-15 사용자: 분기점 그림 '너무 좋은데, 파란 길 경계선이 심해서 은은하게 파란 빛 새어 나오는 느낌으로', 진입로인데 진출 그림이 나옴,
# '안내 표기가 어려우면 밑에처럼 이미지로'(고가·지하차도·옆길도 그림으로). 새 장면은 처음부터 경계를 은은하게
JV_SOFT = (' Keep every white lane marking and dashed lane line exactly as normal. The blue route highlight glows softly: a gentle '
           'translucent blue light spills a little beyond its edges onto the neighboring dark asphalt, filling the dark strip '
           'between the blue lane and the white lane line beside it and the triangular area where the lanes split, fading '
           'smoothly, so there is no harsh dark gap next to the blue lane.')
_JV2 = {
    'entry': 'A straight multi-lane highway runs ahead to the horizon; from the lower right an on-ramp comes in and merges smoothly '
             'into the rightmost lane. The on-ramp and the lane it merges into are the route: highlighted in vivid blue (#2F7DFF) '
             'with one large clean white arrow curving from the on-ramp up into the highway lane. The other lanes are plain asphalt.',
    'over': 'The road ahead splits: the right lanes rise onto an elevated overpass (a flyover bridge with concrete side barriers and '
            'slim pillars, clearly higher than the ground) that climbs ahead over a crossing road, while the left lanes stay at '
            'ground level beside it. The lanes climbing onto the overpass are the route: highlighted in vivid blue (#2F7DFF) with one '
            'large clean white arrow going up onto the bridge.',
    'under': 'The road ahead splits: the right lanes dip down between concrete retaining walls into an underpass, a dark tunnel '
             'opening under a crossing road, while the left lanes stay at ground level beside it. The lanes going down into the '
             'underpass are the route: highlighted in vivid blue (#2F7DFF) with one large clean white arrow going down into the opening.',
    'side': 'The middle lanes ahead dip down between concrete retaining walls into an underpass (a dark tunnel opening under a crossing '
            'road); on the right a side road stays at street level beside it and continues ahead. The street-level side road on the '
            'right is the route: highlighted in vivid blue (#2F7DFF) with one large clean white arrow on it; the underpass lanes are plain.',
    'oside': 'The middle lanes ahead rise onto an elevated overpass (a flyover bridge with concrete barriers and slim pillars); on the '
             'right a side road stays at ground level beside the overpass and continues ahead. The ground-level side road on the right '
             'is the route: highlighted in vivid blue (#2F7DFF) with one large clean white arrow on it; the overpass lanes are plain.',
}
for _k, _t in _JV2.items():
    JOBS['junc_%s_day' % _k] = ((), JV, _t + JV_DAY + JV_SOFT + JV_END)
    JOBS['junc_%s_night' % _k] = ((), JV, _t + JV_NIGHT + JV_SOFT + JV_END)
    PANO |= {'junc_%s_day' % _k, 'junc_%s_night' % _k}
JV2 = ['junc_%s_%s' % (k, t) for k in _JV2 for t in ('day', 'night')]
# 마음에 든 장면 4장은 그대로 두고 파란 길 가장자리만 은은하게 (편집)
SOFT_EDIT = ('Edit this navigation junction illustration. Keep everything exactly the same: composition, roads, every white lane '
             'marking and dashed lane line, sky, colors, the blue route and the white arrow. Only fill the dark asphalt right next '
             'to the blue route (the dark strip between the blue lane and the white lane line beside it, and the triangular area '
             'where the lanes split) with a soft translucent blue glow that fades gently, like blue light spilling over from the '
             'route. The white lines stay clearly visible on top of the glow. No text.')
SOFT = {k: (('ref/base3_%s.png' % k,), SOFT_EDIT, '') for k in ('junc_fork_day', 'junc_fork_night', 'junc_ramp_day', 'junc_ramp_night')}
# 회전교차로: 거리감 ('이미지에 거리감이 좀 부족') — 고른 그림을 뒤에서 내려다본 3D 원근으로
RB_DEPTH = ('Edit this navigation icon. Keep the same roundabout, the same green grass island, the same bold green route arrow and its '
            'exit direction, and the solid magenta background. Change only the view to a 3D perspective like a car navigation 3D map: '
            'the camera is behind and above, looking forward and down at about 50 degrees, so the near (bottom) part of the roundabout '
            'and roads is larger and the far (top) part recedes and gets smaller, with a clear sense of distance. Keep the whole '
            'roundabout and the arrow inside the square, centered. Soft shading, crisp clean vector style, no text.')
RBDEPTH = {k: (('ref/base3_%s.png' % k,), RB_DEPTH, '') for k in ('rb_l', 'rb_s', 'rb_r', 'rb_u')}
# 2026-11-15 사용자: 원래 ramp_day 그림에 동그라미 '이런 식으로 깔끔한 걸 원해', 다른 그림엔 화살표 꼬리를 맨 아래까지 그어 보임
CLEAN_EDIT = ('Edit this navigation junction illustration. Keep the composition, roads, sky, colors, every white lane marking and the '
              'blue route exactly. Make two changes only: (1) extend the white route arrow so its tail starts at the very bottom edge '
              'of the image and it runs as one continuous bold stroke up along the blue lane to the same arrowhead, like a long road '
              'arrow; (2) make the blue lane fill cleanly right up to the white lane line beside it, with no dark gap and no glow, a '
              'clean flat look. No text.')
CLEAN = {k: (('ref/base3_%s.png' % k,), CLEAN_EDIT, '') for k in ('junc_fork_day', 'junc_fork_night', 'junc_ramp_night')}
# 2026-11-15 디자인 검토 3곳 공통: 비켜 가기(kl/kr) 아이콘만 선이 얇다(약 4px, 직진·회전은 약 8px). 고속도로 안내 대부분이 이 아이콘이라
# 직진 화살표(s.webp)와 같은 굵기의 초록 화살표로 다시. 오른쪽(kr)은 앱에서 좌우로 뒤집어 짝을 맞춘다
KL_EDIT = ('Redraw image 1, an S-shaped "keep left" navigation arrow, as a bold solid green (#03C75A) arrow with exactly the same '
           'stroke thickness, rounded tail and big sharp arrowhead as the straight arrow in image 2. Keep image 1 shape and direction: '
           'the stem rises from the bottom, shifts smoothly about one arrow-width to the LEFT with a gentle S-curve in the middle, then '
           'continues straight up into the arrowhead. Clean flat vector, centered, filling about 80% of the height. No outline, no '
           'shadow, no road, no text.' + BG + ' ')
KLBOLD = {'kl': (('kl.webp', 's.webp'), KL_EDIT, '')}
# 급회전(네이버 11·16, '4시 방향'): 지금은 보통 우회전 그림을 빌려 써서 구분이 안 됐다 (디자인 검토 P2). 오른쪽만 그리고 왼쪽은 뒤집는다
SHARP_EDIT = ('Draw a bold solid green (#03C75A) navigation arrow for a SHARP RIGHT turn, with exactly the same stroke thickness, rounded '
              'tail and big sharp arrowhead as the arrow in the reference image. The stem rises straight up from the bottom center, then '
              'bends sharply to the right and comes back DOWN toward the lower right at about the 4 o clock position (a tight hairpin-like turn of '
              'about 135 degrees), ending in the arrowhead pointing down-right. Clean flat vector, centered, no outline, no shadow, no '
              'road, no text.' + BG + ' ')
SHARPBOLD = {'sharp_r': (('s.webp',), SHARP_EDIT, '')}
# 살짝 왼쪽('11시·10시 방향'): 마지막 남은 가는 화살표 (최종 검토 P2). 오른쪽은 뒤집는다
SL_EDIT = ('Draw a bold solid green (#03C75A) navigation arrow for a SLIGHT LEFT turn (bear left at about 11 o clock), with exactly the '
           'same stroke thickness, rounded tail and big sharp arrowhead as the arrow in the reference image. The stem rises straight '
           'up from the bottom center, then bends gently to the upper left by about 40 degrees, ending in the arrowhead pointing '
           'up-left. Clean flat vector, centered, no outline, no shadow, no road, no text.' + BG + ' ')
SLBOLD = {'sl': (('s.webp',), SL_EDIT, '')}
JV_LONG = (' The route arrow is ONE big bold white arrow painted flat on the blue lane like a road marking: its tail starts low '
           'in the image close to the viewer, it sweeps smoothly along the blue lane following its curve without any gap, and '
           'ends in a large clear arrowhead pointing where the route goes. Highly readable at a glance. Show the road details '
           'fully: all lanes, lane markings, edge lines, barriers and the ramp or bridge structure.')
_JV3 = dict(_JV2, fork=JV_FORK, ramp=JV_RAMP)
JUNC3 = {}
for _k, _t in _JV3.items():
    JUNC3['junc_%s_day' % _k] = ((), JV, _t + JV_DAY + JV_SOFT + JV_LONG + JV_END)
    JUNC3['junc_%s_night' % _k] = ((), JV, _t + JV_NIGHT + JV_SOFT + JV_LONG + JV_END)
    PANO |= {'junc_%s_day' % _k, 'junc_%s_night' % _k}
WIDE = {'junc_fork_r', 'junc_exit_r'}

# 2026-11-15 사용자 표시(분기점 그림 표에 빨간 X·동그라미): 고른 그림을 고치기만 한다 (편집, --icons fix4)
FIX4_KEEP = ('Edit this navigation junction illustration. Keep everything else exactly the same: the composition, camera, sky, '
             'colors, roads, every other lane marking, the blue route lane and the big white route arrow. No text. ')
FIX4 = {
    # 밤 갈림길: 파란 길 왼쪽 가장자리에 빨간 줄 → 낮 그림처럼 흰 실선 가장자리
    'junc_fork_night': (('ref/base4_junc_fork_night.png',), FIX4_KEEP,
                        'Add one crisp solid white edge line along the entire left edge of the blue route lane, from the bottom edge '
                        'of the image up to the point where the two branches split, so the blue lane is cleanly bordered by a white '
                        'line on its left exactly like the white edge lines of the other branch.'),
    # 낮 나가기: 본선 점선이 연결로 흰 선 바로 옆에 붙어 X → 점선은 연결로에서 떨어지게, 사이는 흰 실선 하나
    'junc_ramp_day': (('ref/base4_junc_ramp_day.png',), FIX4_KEEP,
                      'Clean up where the exit ramp separates from the highway near the bottom right: remove the dashed lane line '
                      'segments of the main highway that run right next to the exit ramp\'s white edge line, so no dashed line '
                      'squeezes against or touches the ramp. Between the main highway and the blue exit lane there is only ONE '
                      'clean solid white line from the bottom edge up to where they split, and the small triangle where they split '
                      'is neatly filled with white diagonal chevron stripes.'),
    # 밤 나가기: 맨 아래 점선이 파란 길로 파고듦(보라 낙서) → 점선이 파란 길에 닿지 않게
    'junc_ramp_night': (('ref/base4_junc_ramp_night.png',), FIX4_KEEP,
                        'At the bottom of the image, the white dashed lane line of the main highway runs into the blue exit lane: '
                        'remove the dashed line segments that touch or cross the blue lane. The left side of the blue exit lane is '
                        'bounded by one clean continuous solid white line from the bottom edge of the image up to the white chevron '
                        'area where the ramp splits off.'),
    # 낮 고가: 낮 그림 전체 X, 밤 그림 동그라미(좋음) → 밤 그림을 그대로 낮으로
    'junc_over_day': (('ref/base4_junc_over_day.png',), FIX4_KEEP,
                      'Turn this night scene into the very same scene in clear daytime: soft light-blue sky gradient, faint distant '
                      'blue hills with green trees, fresh green grass beside the road, mid-grey asphalt with crisp white lane '
                      'markings, light grey concrete barriers, bridge deck and pillars with soft daylight shading. The blue route '
                      'lane stays the same vivid blue (#2F7DFF) with the same big white arrow climbing onto the overpass.'),
    # 지하차도 진입 낮·밤: 터널 입구 왼쪽의 비스듬한 벽 조각에 X → 깔끔한 낮은 벽 하나
    'junc_under_day': (('ref/base4_junc_under_day.png',), FIX4_KEEP,
                       'Remove the odd angled concrete wall fragment just left of the tunnel opening (the wedge-shaped barrier '
                       'piece between the ground-level lanes and the blue lane). Instead, the left side of the blue lane is a clean, '
                       'simple low concrete wall that runs straight and parallel along the blue lane from the middle of the image '
                       'into the tunnel opening, plus a solid white edge line. The tunnel opening, its frame and the right wall stay '
                       'the same.'),
    'junc_under_night': (('ref/base4_junc_under_night.png',), FIX4_KEEP,
                         'Remove the odd angled concrete wall fragment just left of the tunnel opening (the wedge-shaped barrier '
                         'piece between the ground-level lanes and the blue lane). Instead, the left side of the blue lane is a clean, '
                         'simple low concrete wall that runs straight and parallel along the blue lane from the middle of the image '
                         'into the tunnel opening, plus a solid white edge line. The tunnel opening, its frame and the right wall stay '
                         'the same.'),
}
PANO |= set(FIX4)
# 낮 나가기 2차: 표시한 곳은 맨 아래 '본선 점선과 파란 연결로 사이에 끼어 뾰족해진 어두운 차로'. 그 칸을 파란 길로 채운다 (--icons fix5)
FIX5 = {'junc_ramp_day': (('ref/base4_junc_ramp_day.png',), FIX4_KEEP,
                          'At the bottom of the image, between the long white dashed lane line just right of the center and the '
                          'white edge line on the left of the blue exit lane, there is a thin dark asphalt wedge: the rightmost '
                          'highway lane squeezed to a point. Fix it: paint that whole wedge in the same vivid blue as the route, so '
                          'at the bottom the blue route is the full rightmost lane, bounded on its left by that white dashed lane '
                          'line, and then curves off into the exit ramp. Remove the white edge line that separated the wedge from '
                          'the blue lane near the bottom. Keep the dashed lane line, the arrow and everything else.')}
PANO |= set(FIX5)
# 지하차도 진입 3차 (2026-11-15 사용자: 후보 7장 중 파란 길 왼쪽의 벽·벽 조각마다 X) → 벽을 아예 없애고 흰 실선 하나로 (--icons fix6)
FIX6_UNDER = ('Remove every wall, barrier, curb, divider and concrete piece on the LEFT side of the blue lane, from the bottom of '
              'the image all the way to the tunnel opening: nothing stands between the blue lane and the other lanes. They are '
              'separated only by one clean solid white line painted flat on the asphalt, and the asphalt continues smoothly at '
              'the same level right up to the tunnel opening. The tunnel opening, its concrete frame, the right-side retaining '
              'wall, the blue lane and the big white arrow stay exactly the same.')
FIX6 = {'junc_under_day': (('ref/base4_junc_under_day.png',), FIX4_KEEP, FIX6_UNDER),
        'junc_under_night': (('ref/base4_junc_under_night.png',), FIX4_KEEP, FIX6_UNDER)}
PANO |= set(FIX6)
# v133 (2026-11-16 주행 중 사용자: 신갈분기점 서울 방향은 '구조상 직진이고 오른쪽이 약간 오른쪽으로 헤어지는' 곳이라 직진 그림이 필요):
# 본선을 그대로 가고 옆으로 연결로가 갈라지는 분기점 = 지금 고른 나가기 그림에서 파란 길만 본선 직진으로 옮긴다 (--icons mainline)
MAINLINE_EDIT = ('Change ONLY which road is the route. The exit ramp on the right is NOT the route any more: repaint the whole exit '
                 'ramp as plain asphalt exactly like the other roads, with its normal white edge lines and no blue and no arrow. '
                 'The route now continues STRAIGHT AHEAD on the main highway: highlight the main highway lanes left of the ramp in '
                 'the same vivid blue (#2F7DFF) with the same soft glow, from the bottom edge of the image straight up toward the '
                 'horizon, and paint one big bold white arrow on them pointing straight ahead (tail low near the viewer, large '
                 'arrowhead pointing up the road). Keep the camera, sky, grass, every white lane marking and the ramp geometry exactly.')
MAINLINE = {'junc_main_day': (('ref/base5_junc_ramp_day.png',), FIX4_KEEP.replace(', the blue route lane and the big white route arrow', ''), MAINLINE_EDIT),
            'junc_main_night': (('ref/base5_junc_ramp_night.png',), FIX4_KEEP.replace(', the blue route lane and the big white route arrow', ''), MAINLINE_EDIT)}
PANO |= set(MAINLINE)
# 지하차도 진입 새 구도 (2026-11-15 사용자: '내가 준 레퍼런스 보면 많이 참고될 듯', '그런 구도로 가도 됨' — 카카오·T맵·네이버 분기점 화면처럼
# 높은 곳에서 내려다보는 3D 구도. 벽은 땅 높이에서 시작해 길이 내려가는 만큼 서서히 높아지는 긴 옹벽 하나) --icons under3d
JV3D = ('Junction close-up illustration for the guidance screen of a premium Korean car navigation app, in the style of the 3D '
        'junction views of Kakao Navi, Tmap or Naver Map: a polished, clean 3D-rendered illustration with soft lighting, crisp '
        'edges and simple shapes, very wide 8:3 panorama. Camera: elevated chase view about 12 meters above and behind the car, '
        'looking forward and down at about 30 degrees, so the road surface and every lane are clearly visible and recede in '
        'perspective; the skyline sits near the very top of the image. ')
JV3D_UNDER = ('Scene: a straight six-lane urban expressway. Ahead, the two right lanes slope gently down into an underpass that '
              'passes beneath a crossing road bridge, while the other lanes stay level and continue beside it. Along the left '
              'side of the two descending lanes there is ONE long, continuous concrete retaining wall: it starts flush with the '
              'road surface near the viewer and rises smoothly and gradually as the lanes go down, its top edge a single clean '
              'straight line, until it meets the bridge. No other walls, blocks or barrier pieces between the lanes. The two '
              'descending lanes are the route: highlighted as one vivid blue (#2F7DFF) ribbon that starts at the bottom edge of '
              'the image and runs down into the tunnel opening, with one big bold white arrow painted on it pointing into the '
              'underpass. All other lanes are plain dark-grey asphalt with crisp white lane markings.')
JV3D_DAY = ' Daytime: clear light-blue sky, a few modern buildings and green trees in the distance, light grey concrete.'
JV3D_NIGHT = (' Night: deep navy sky, soft distant city lights, dark asphalt with bright white lane markings, the blue route '
              'glowing softly, warm lights inside the underpass.')
JV3D_END = (' No text, no letters, no road signs, no route numbers, no cars, no people, no logos. Keep the upper-right corner '
            'calm and simple, because the app places a direction sign there.')
UNDER3D = {'junc_under_day': ((), JV3D, JV3D_UNDER + JV3D_DAY + JV3D_END),
           'junc_under_night': ((), JV3D, JV3D_UNDER + JV3D_NIGHT + JV3D_END)}


# 2026-11-15 밤 요청 '터널 고가 안내 같은건 아이콘 만들어서 적용해 줘' (네이버 지도처럼 정면에서 본 입체 그림):
# 안내 줄의 '고가차도 진입'·'지하차도 진입' 직진 아이콘. 위에서 본 십자 모양(over_s)·좁은 입구(under_s)는 작은 칸에서 잘 안 읽혔다
_G3 = (' Bold simple shapes that read well at 26 px, crisp edges, no text, no letters, no numbers, no cars, no people, '
       'no shadows on the background.' + CORP + BG + ' ')
GRADE3 = {
    'over3_s': ('s.webp', 'Flat vector navigation icon for ENTERING AN OVERPASS (an elevated road), front view in gentle perspective, '
                'in the clean style of Naver Map turn-by-turn icons: a dark charcoal road with thin white edge lines starts wide at the '
                'bottom of the icon and runs straight ahead, climbing a short ramp up onto a raised bridge deck that has light grey '
                'concrete side barriers and two slim grey pillars underneath; below the bridge a lower dark road crosses from left to '
                'right. One bold vivid green (#1FC24A) arrow runs up the middle of the road and onto the bridge deck, with a large '
                'arrowhead pointing up. The bridge clearly sits higher than the crossing road.' + _G3, ''),
    'under3_s': ('s.webp', 'Flat vector navigation icon for ENTERING AN UNDERPASS, front view in gentle perspective, in the clean style '
                 'of Naver Map turn-by-turn icons: a dark charcoal road with thin white edge lines starts wide at the bottom of the '
                 'icon and runs straight ahead, dipping down between two light grey concrete retaining walls into a WIDE rectangular '
                 'dark opening under a crossing road; across the top of the opening is a light grey concrete deck that spans almost '
                 'the full width of the icon. One bold vivid green (#1FC24A) arrow runs up the middle of the road into the opening, '
                 'with a large arrowhead pointing up.' + _G3, ''),
}

# 2026-11-15 밤 '너가 보고 거리감이 없으면 다시 만들어, 깨진것도 포함': 위 정면 그림(over3_s·under3_s)은 납작했고,
# 왼쪽·오른쪽·옆길 그림(위에서 본 복잡한 그림)은 56px 칸에서 뭉개져 깨진 것처럼 보였다. 운전석 시점의 강한 원근으로 다시
_G4 = ('Flat vector maneuver icon for the turn-by-turn panel of a premium car navigation app, in the bold, simple style of Naver Map '
       'maneuver icons. Seen from the driver seat, with STRONG PERSPECTIVE and a clear vanishing point in the upper third: a dark charcoal road '
       '(#313B42) with thin white edge lines starts wide across the bottom edge and narrows strongly into the distance, so the icon '
       'has an obvious sense of depth and distance. Exactly one bold vivid green (#1FC24A) route arrow with a large triangular '
       'arrowhead follows the route described. Concrete structures are light grey with simple flat two-tone shading. Only a few '
       'large shapes that still read clearly at 48 px: no small details, no texture, no lane dashes except at most one dashed '
       'center line, no text, no letters, no numbers, no cars, no people, no trees, no sky details.' + CORP + BG + ' Scene: ')
GRADE4 = {
    'under4_s': ((), _G4, 'the road runs straight ahead and dips down into a wide dark rectangular underpass opening in the middle distance, '
                 'under a light grey concrete deck that crosses from left to right above the opening; the green arrow runs up the middle '
                 'of the road and into the dark opening.'),
    'over4_s': ((), _G4, 'the road runs straight ahead up a ramp onto an elevated bridge deck with light grey concrete side barriers that '
                'continues far into the distance; far below the bridge, a lower road crosses from left to right; the green arrow runs up the '
                'middle of the road and onto the raised bridge.'),
    'under4_r': ((), _G4, 'the road ahead splits in two: the RIGHT branch curves slightly right and dips down between light grey concrete walls '
                 'into a dark underpass opening in the distance; the LEFT branch continues straight at ground level; the green arrow follows '
                 'the right branch down into the opening.'),
    'over4_r': ((), _G4, 'the road ahead splits in two: the RIGHT branch rises up a ramp onto an elevated bridge with light grey concrete side '
                'barriers that curves slightly right into the distance; the LEFT branch continues straight at ground level; the green arrow '
                'follows the right branch up onto the bridge.'),
    'side4_r': ((), _G4, 'the middle lanes ahead dip down into a dark underpass opening under a light grey concrete deck in the distance, '
                'while a RIGHT side road stays at ground level and runs beside the underpass on the right; the green arrow follows the right '
                'side road at ground level past the underpass, not into it.'),
    'oside4_r': ((), _G4, 'the middle lanes ahead rise up onto an elevated bridge with light grey concrete side barriers, while a RIGHT side '
                 'road stays at ground level and runs beside and below the bridge on the right; the green arrow follows the right side road '
                 'at ground level, not up onto the bridge.'),
}

# v156 (2026-11-17 운전자 '네이버 지도처럼 아이콘 계산 좀 해줘. 아틀라스 1번 만들어 줘'): 분기 후 합류(네이버 '분기 후 합류', 안내 코드 54
# 방향 없음). 밑그림 ref/road_jc.png (tools/ref_roads.py jc = 앱의 jc 그림)을 네이버 안내 아이콘처럼 다시 그린다 (--icons jc)
JC_EDIT = ('Redraw the reference image as a polished flat vector navigation maneuver icon meaning "the road splits, then merges again", '
           'in the clean bold style of Naver Map maneuver icons. Keep exactly the composition of the reference: one dark charcoal '
           '(#2B3440) road shaped like a tall hexagon: a straight road comes in from the bottom edge, splits into two equal branches '
           'that go around a diamond-shaped island in the middle, and the two branches join again into one straight road that leaves '
           'through the top edge. A thin light grey (#9AA3AD) edge line runs along both outer sides of the road, and the diamond island '
           'is outlined with the same light grey line and filled with the dark road color. ONE bold solid white Y-shaped arrow: a thick '
           'stem rises from the bottom edge, splits below the island into two equal branches that run up along both sides of the island, '
           'and each branch ends in a large sharp triangular arrowhead pointing up and inward toward where the two branches merge again '
           'above the island. Perfectly left-right symmetric, smooth even line widths, crisp edges, no lane dashes, no shadows, no '
           'gradients, no text.' + CORP + BG + ' ')
JCNAVER = {'jc': (('ref/road_jc.png',), JC_EDIT, '')}


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
    'flare26e': ('openai/gpt-image-2.6-flare/edit', 0.008,
                 lambda p, imgs, wide=False: {'prompt': p, 'images': imgs, 'size': 'auto', 'quality': 'medium',
                                              'background': 'opaque', 'output_format': 'png', 'n': 1}),
    'sunburst26e': ('openai/gpt-image-2.6-sunburst/edit', 0.008,
                    lambda p, imgs, wide=False: {'prompt': p, 'images': imgs, 'size': 'auto', 'quality': 'medium',
                                                 'background': 'opaque', 'output_format': 'png', 'n': 1}),
    # 글로만 그리는 모델 (참고 그림을 보내지 않는다)
    'flare26': ('openai/gpt-image-2.6-flare/text-to-image', 0.007,
                lambda p, imgs, wide=False: {'prompt': p, 'size': '1536x576' if wide == 'pano' else '1536x1024' if wide else '1024x1024', 'quality': 'medium',
                                             'complexity': 'high', 'background': 'opaque', 'output_format': 'png', 'n': 1}),
    'sunburst26': ('openai/gpt-image-2.6-sunburst/text-to-image', 0.007,
                   lambda p, imgs, wide=False: {'prompt': p, 'size': '1536x576' if wide == 'pano' else '1536x1024' if wide else '1024x1024', 'quality': 'medium',
                                                'complexity': 'high', 'background': 'opaque', 'output_format': 'png', 'n': 1}),
    'ideo': ('ideogram/v4/quality/text-to-image', 0.025,
             lambda p, imgs, wide=False: {'prompt': p[:2000], 'image_size': 'landscape_4_3' if wide else 'square_hd',
                                          'output_format': 'png'}),
    'nb2': ('google/nano-banana-2/edit', 0.08,
            lambda p, imgs, wide=False: {'prompt': p, 'images': imgs, 'aspect_ratio': '16:9' if wide else '1:1',
                                        'resolution': '1k', 'output_format': 'png'}),
}


MODELS['flare26b'], MODELS['sunburst26b'] = MODELS['flare26'], MODELS['sunburst26']        # 3판(굵은 화살표)
MODELS['flare26g'], MODELS['sunburst26g'] = MODELS['flare26e'], MODELS['sunburst26e']      # 회전교차로 잔디
MODELS['flare26v'], MODELS['sunburst26v'] = MODELS['flare26e'], MODELS['sunburst26e']      # 초록 길·입체감 (2026-11-15)
MODELS['flare26s'], MODELS['sunburst26s'] = MODELS['flare26e'], MODELS['sunburst26e']      # 분기점 그림 파란 빛 은은하게
MODELS['flare26d'], MODELS['sunburst26d'] = MODELS['flare26e'], MODELS['sunburst26e']      # 회전교차로 거리감
MODELS['flare26j'], MODELS['sunburst26j'] = MODELS['flare26'], MODELS['sunburst26']        # 분기점 그림: 길게 이어진 화살표
MODELS['flare26k'], MODELS['sunburst26k'] = MODELS['flare26e'], MODELS['sunburst26e']      # 비켜 가기 굵게
MODELS['flare26x'], MODELS['sunburst26x'] = MODELS['flare26e'], MODELS['sunburst26e']      # 분기점 그림: 깔끔하게·긴 화살표
MODELS['flare26t'], MODELS['sunburst26t'] = MODELS['flare26e'], MODELS['sunburst26e']      # 분기점 그림: 흰 점선 그대로, 옆 틈만 은은하게
MODELS['flare26f'], MODELS['sunburst26f'] = MODELS['flare26e'], MODELS['sunburst26e']      # 분기점 그림: 사용자 표시한 곳만 고치기 (fix4)
MODELS['flare26r'], MODELS['sunburst26r'] = MODELS['flare26e'], MODELS['sunburst26e']      # 낮 나가기 2차 (fix5)
MODELS['flare26w'], MODELS['sunburst26w'] = MODELS['flare26e'], MODELS['sunburst26e']      # 지하차도 진입 벽 없애기 (fix6)
MODELS['flare26u'], MODELS['sunburst26u'] = MODELS['flare26'], MODELS['sunburst26']        # 지하차도 진입 새 구도 (under3d, 글로만)
T2I_MODELS = {'flare26', 'sunburst26', 'ideo', 'flare26b', 'sunburst26b', 'flare26j', 'sunburst26j', 'flare26u', 'sunburst26u'}


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
    ap.add_argument('--models', default='')   # 비우면: 참고 그림이 있는 칸은 flare,sunburst / 글로만 쓰는 칸은 flare26,sunburst26   # 다른 모델도: flare,sunburst,gptdev,gpt15,gpt,s55,s50p,nb2
    ap.add_argument('--icons', default=','.join(JOBS))
    ap.add_argument('--per', type=int, default=1)
    ap.add_argument('--dry', action='store_true')
    a = ap.parse_args()
    if 'grass' in a.icons.split(','):
        JOBS.update(GRASS)   # 회전교차로 4칸을 '잔디' 편집으로
    if 'green' in a.icons.split(','):
        JOBS.update(GREEN)   # 고른 그림을 초록 길·입체감으로 고치기
    if 'soft' in a.icons.split(','):
        JOBS.update(SOFT)    # 분기점 그림 파란 빛 은은하게
    if 'rbdepth' in a.icons.split(','):
        JOBS.update(RBDEPTH)   # 회전교차로 거리감
    if 'slbold' in a.icons.split(','):
        JOBS.update(SLBOLD)   # 살짝 왼쪽 굵게
    if 'sharp' in a.icons.split(','):
        JOBS.update(SHARPBOLD)   # 급회전 굵게
    if 'klbold' in a.icons.split(','):
        JOBS.update(KLBOLD)   # 비켜 가기(왼쪽) 굵게
    if 'clean' in a.icons.split(','):
        JOBS.update(CLEAN)   # 분기점 그림: 깔끔하게, 화살표 꼬리를 맨 아래까지
    if 'under3d' in a.icons.split(','):
        JOBS.update(UNDER3D)   # 지하차도 진입 새 구도
    if 'grade3' in a.icons.split(','):
        JOBS.update(GRADE3)   # 고가·지하차도 진입 정면 입체 아이콘 (2026-11-15)
    if 'grade4' in a.icons.split(','):
        JOBS.update(GRADE4)   # 지하차도·고가·옆길 강한 원근 (2026-11-15)
    if 'mainline' in a.icons.split(','):
        JOBS.update(MAINLINE)   # 본선 직진 분기점 (v133)
    if 'fix6' in a.icons.split(','):
        JOBS.update(FIX6)   # 지하차도 진입 벽 없애기
    if 'fix5' in a.icons.split(','):
        JOBS.update(FIX5)   # 낮 나가기 2차
    if 'fix4' in a.icons.split(','):
        JOBS.update(FIX4)   # 분기점 그림: 사용자가 X·동그라미 친 곳만 고치기
    if 'jc' in a.icons.split(','):
        JOBS.update(JCNAVER)   # 분기 후 합류 (v156)
    if 'junc3' in a.icons.split(','):
        JOBS.update(JUNC3)   # 분기점 그림 14장: 길게 이어진 화살표·은은한 파란 빛
    models = [m for m in (a.models or 'flare,sunburst,flare26,sunburst26').split(',') if m in MODELS]
    # 묶음 이름: cars = 모든 차 아이콘(car_*·cute_*), guide = 차가 아닌 안내 아이콘·분기점 그림 전부
    is_car = lambda k: k.startswith(('car_', 'cute_'))
    is_sign = lambda k: k.startswith('sign_')
    groups = {'cars': [k for k in JOBS if is_car(k)], 'signs': [k for k in JOBS if is_sign(k)],
              'guide': [k for k in JOBS if not is_car(k) and not is_sign(k)],
              'roads': ROADS, 'rb': RBS, 'redo': ROADS + RBS,
              'fix': RBS + ['inr', 'outs', 'ins', 'under_s', 'side_l', 'side_r'], 'fix2': RBS + ['under_s'], 'fix3': ['outs', 'ins', 'over_r', 'under_s', 'under_r', 'side_r', 'oside_r'], 'grass': RBS, 'junc': sorted(PANO), 'green': list(GREEN_KIND), 'junc2': JV2, 'soft': list(SOFT), 'rbdepth': list(RBDEPTH), 'junc3': list(JUNC3), 'clean': list(CLEAN), 'klbold': ['kl'], 'sharp': ['sharp_r'], 'slbold': ['sl'], 'fix4': list(FIX4), 'fix5': list(FIX5), 'fix6': list(FIX6), 'under3d': list(UNDER3D), 'grade3': list(GRADE3), 'grade4': list(GRADE4), 'mainline': list(MAINLINE), 'jc': ['jc']}
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
                pid = submit(key, mid, mk(style + extra, refs[i], 'pano' if i in PANO else i in WIDE))
            except RuntimeError as e:
                if len(refs[i]) < 2:
                    raise
                print('  (참고 그림 여러 장이 안 돼 밑그림 한 장으로 다시: %s)' % str(e)[:120])
                pid = submit(key, mid, mk(style + extra, refs[i][:1], 'pano' if i in PANO else i in WIDE))
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
    if files:
        # 명령 하나로 끝나게: 분홍 바탕을 빼 앱·관리 페이지용 img/ai/*.webp 와 manifest.json 까지 만든다
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        import build_ai_icons
        build_ai_icons.main()
        print('\n다 됐어요. Claude 에게 "다 했어" 라고 알려 주세요.')


if __name__ == '__main__':
    main()
