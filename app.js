/* 테슬라 지도 클러스터: 계기판 + 네이버 지도 + 단속카메라 경고 + 길안내 */
(() => {
  'use strict';

  const $ = (s) => document.querySelector(s);
  // app.js 가 있는 폴더 주소 (img/ 같은 그림 파일은 이 기준: 테스트 페이지는 /test/ 에서 ../app.js 를 불러온다)
  const APP_BASE = (() => { try { return new URL('.', document.currentScript.src).href; } catch (e) { return ''; } })();
  const NS = 'tnc.';
  const store = {
    get(k) { try { return localStorage.getItem(NS + k); } catch (e) { return null; } },
    set(k, v) {
      try {
        if (v == null || v === '') localStorage.removeItem(NS + k);
        else localStorage.setItem(NS + k, String(v));
      } catch (e) { /* 저장 불가 환경: 이번 세션만 사용 */ }
    },
  };

  const PROXY_DEFAULT = 'https://tesla-nav.cy6789.workers.dev';
  const DEFAULT_CENTER = { lat: 37.5658, lng: 126.9772 }; // 서울시청
  const LEAFLET_JS = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js';
  const LEAFLET_CSS = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css';
  const ICON_MOON = '<svg viewBox="0 0 24 24"><path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/></svg>';
  const ICON_SUN = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';

  const prefs = {
    voice: store.get('voice') !== '0',
    beep: store.get('beep') !== '0',
    cams: store.get('cams') !== '0',
    signalCams: store.get('sigcam') === '1', // 신호 전용 카메라 알림 (기본 끔)
    bumps: store.get('bumps') !== '0',       // 과속방지턱 알림 (기본 켬)
    parking: store.get('parking') !== '0',   // 주정차 단속 카메라: 천천히 갈 때만 표시, 소리 없음 (기본 켬)
    rest: store.get('rest') !== '0',         // 길안내 중 고속도로 휴게소 (기본 켬)
    signs: store.get('signs') !== '0',       // 주의 표지 알림: 미끄러운 도로·낙석·급경사 등 (기본 켬)
    tunnels: store.get('tunnels') !== '0',   // 길안내 중 터널 진입·출구 거리 (기본 켬)
    junction: store.get('junction') !== '0', // 고속도로 진출입·갈림길 그림 (기본 켬)
    traffic: store.get('traffic') !== '0',
    weather: store.get('weather') !== '0',
    car: ({ my: 'tesla_grey', red: 'tesla_red', white: 'tesla_white' })[store.get('car')] || store.get('car') || 'cute',             // 내 차 아이콘 (설정에서 고름)
    headingUp: store.get('hup') !== '0',
    // 멈추면 북쪽 위로: 진행 방향 위 화면은 지도 그림째 돌려서 가게 글자도 눕는다. 3초 넘게 서 있으면 북쪽 위로 돌려 글자를 바로 세운다
    stopNorth: store.get('stopNorth') !== '0',
    tilt: store.get('tilt') !== '0',
    // 벡터(GL) 지도: 지도를 돌려도 글자·아이콘은 똑바로, 밤에는 네이버 다크 지도. 끄면 예전 그림(래스터) 지도 (2026-11-14)
    gl: store.get('gl') !== '0',
    routeOpt: store.get('routeOpt') || 'traoptimal', // 기본은 '추천'(네이버 실시간 최적)
    // 테슬라 모드: 속도는 차 화면에 이미 나오므로 왼쪽 계기판을 없애고 지도를 넓게, 시계·날씨 등은 지도 위 글자로.
    // 테슬라 브라우저는 'X11; Linux x86_64' 로만 보이므로 그때 기본으로 켠다 (설정에서 바꾸면 그 값을 따른다)
    tesla: true,   // 2026-11-14: 테슬라 모드가 유일한 화면 (예전 계기판 화면과 설정의 전환 스위치는 없앴다)
  };
  const proxyUrl = () => (store.get('proxy') || PROXY_DEFAULT).replace(/\/+$/, '');

  // ---------- 운영 모니터링: 접속·오류를 길안내 서버에 짧게 남긴다 (위치는 보내지 않음) ----------
  const APP_VERSION = '2026.11.14-109'; // 배포 때 index.html 의 app.js?v=·icons.js?v= 와 version.json 도 같이 올린다
  // ---------- 아이콘 고르기 (2026-11-14 요청: 아이콘을 목록으로 보고 바꾸고 관리 — 내부 관리 페이지 tools/icons.html) ----------
  // 칸(slot) → img/ai/ 의 그림 파일. 기본은 저장소의 img/ai/picks.js(window.TNC_PICKS), 이 브라우저에서 고른 것은 localStorage
  // 'tnc.iconPick' 이 덮는다('-' 는 앱에 그려 둔 기본 그림). 칸: 안내 아이콘 이름(s, l, inr, tunnel …), 주의 표지 sign_<종류>
  const ICON_PICKS = (() => {
    let o = {};
    try { o = JSON.parse(localStorage.getItem('tnc.iconPick') || '{}') || {}; } catch (e) { o = {}; }
    const out = Object.assign({}, window.TNC_PICKS || {}, o);
    Object.keys(out).forEach((k) => { if (!out[k] || out[k] === '-') delete out[k]; });
    return out;
  })();
  const tele = { sid: Math.random().toString(36).slice(2, 10), sent: 0, seen: new Set(), ctx: null };
  const testPage = /\/test\//.test(location.pathname);
  // 브라우저에 저장된 예전 index.html 이 새 app.js 를 불러온 경우(화면 요소가 맞지 않아 버튼 연결에서 멈춘다):
  // index.html 이 부른 app.js?v= 와 이 파일의 버전이 다르면 새 버전 주소(?v=)로 한 번 다시 연다.
  // (2026-11-14 16:37: PC 크롬에 11-13 화면이 남아 있어 'Cannot set properties of null (setting onclick)' 으로 멈췄다)
  try {
    const tag = [...document.scripts].find((s) => /app\.js(\?|$)/.test(s.src || ''));
    const want = tag ? new URL(tag.src, location.href).searchParams.get('v') : null;
    if (!testPage && want && want !== APP_VERSION && sessionStorage.getItem('tnc.staleHtml') !== APP_VERSION) {
      sessionStorage.setItem('tnc.staleHtml', APP_VERSION);
      const q = new URLSearchParams(location.search);
      q.set('v', APP_VERSION);
      location.replace(location.pathname + '?' + q.toString() + location.hash);
      return;
    }
  } catch (e) { /* 저장소 막힘 등: 그대로 진행 */ }
  const botLike = /bot|crawler|spider|headless/i.test(navigator.userAgent) || navigator.webdriver === true;
  function report(type, data) {
    if (testPage || botLike || tele.sent >= 40) return; // 검색엔진 로봇·자동화 접속은 보고하지 않음
    const key = type + '|' + (data && data.msg);
    if (tele.seen.has(key)) return; // 같은 내용은 세션당 한 번만
    tele.seen.add(key);
    tele.sent++;
    let ctx = {};
    try { ctx = tele.ctx ? tele.ctx() : {}; } catch (e) { /* 초기화 전 오류 */ }
    const body = Object.assign({
      type, sid: tele.sid, v: APP_VERSION, at: Date.now(), page: location.host + location.pathname + location.search.slice(0, 40),
      ua: navigator.userAgent.slice(0, 180),
    }, ctx, data || {});
    try {
      fetch(proxyUrl() + '/event', {
        method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' }, keepalive: true,
      }).catch(() => {});
    } catch (e) { /* 보고 실패는 무시 */ }
  }
  window.addEventListener('error', (e) => {
    report('error', {
      msg: String(e.message || 'error').slice(0, 300),
      src: String(e.filename || '').split('/').pop() + ':' + e.lineno + ':' + e.colno,
      stack: e.error && e.error.stack ? String(e.error.stack).slice(0, 900) : '',
    });
  });
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason || {};
    report('error', { msg: 'unhandled: ' + String(r.message || r).slice(0, 300), stack: r.stack ? String(r.stack).slice(0, 900) : '' });
  });

  const state = {
    fix: null,          // 마지막 위치 {lat,lng,acc,t}
    speedKmh: 0,
    heading: null,
    trip: 0,            // m (초기화 가능)
    driveMs: 0,
    odo: 0,             // m (구간단속 계산용, 초기화 안 함)
    following: true,
    peek: false,        // 주행 화면에서 지도를 끌어 앞길을 보는 중 (방향·기울기는 그대로, 따라가기만 멈춤)
    refollowTimer: 0,
    demoTimer: 0,
    night: store.get('night') === '1',
  };

  // URL에 ?key=... 로 넘기면 저장하고 주소에서는 지운다
  const params = new URLSearchParams(location.search);
  if (params.get('key')) {
    store.set('key', params.get('key').trim());
    params.delete('key');
    const qs = params.toString();
    history.replaceState(null, '', location.pathname + (qs ? '?' + qs : '') + location.hash);
  }

  // ---------- 계산 도우미 ----------
  const toRad = (d) => d * Math.PI / 180;
  const toDeg = (r) => r * 180 / Math.PI;
  function haversine(a, b) {
    const R = 6371000;
    const dLat = toRad(b.lat - a.lat), dLng = toRad(b.lng - a.lng);
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
  }
  function bearing(a, b) {
    const y = Math.sin(toRad(b.lng - a.lng)) * Math.cos(toRad(b.lat));
    const x = Math.cos(toRad(a.lat)) * Math.sin(toRad(b.lat)) -
              Math.sin(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.cos(toRad(b.lng - a.lng));
    return (toDeg(Math.atan2(y, x)) + 360) % 360;
  }
  const angleDiff = (a, b) => Math.abs(((a - b) % 360 + 540) % 360 - 180);
  // 점 p 에서 방향 h(도)로 d 미터 간 점 (짧은 거리용 평면 근사)
  function aheadPt(p, h, d) {
    const kx = Math.cos(toRad(p.lat)) * 111320, ky = 110540;
    return { lat: p.lat + Math.cos(toRad(h)) * d / ky, lng: p.lng + Math.sin(toRad(h)) * d / kx };
  }
  const turn = (a) => (a % 360 + 540) % 360 - 180; // -180..180 로 정규화
  // 점 p 를 선분 a-b 에 투영 (짧은 거리용 평면 근사)
  function projectSeg(p, a, b) {
    const kx = Math.cos(toRad(a.lat)) * 111320, ky = 110540;
    const bx = (b.lng - a.lng) * kx, by = (b.lat - a.lat) * ky;
    const px = (p.lng - a.lng) * kx, py = (p.lat - a.lat) * ky;
    const l2 = bx * bx + by * by;
    let t = l2 > 0 ? (px * bx + py * by) / l2 : 0;
    t = Math.max(0, Math.min(1, t));
    const dx = px - t * bx, dy = py - t * by;
    return { t, dist: Math.sqrt(dx * dx + dy * dy) };
  }
  const DIRS = ['북', '북동', '동', '남동', '남', '남서', '서', '북서'];
  const dirName = (h) => DIRS[Math.round(h / 45) % 8];
  const pad = (n) => String(n).padStart(2, '0');
  const hhmm = (d) => pad(d.getHours()) + ':' + pad(d.getMinutes());
  // 995m 부터는 '1000m' 대신 '1.0km' (10m 단위로 반올림하면 1000이 되므로)
  const fmtDist = (m) => (m >= 995 ? (m / 1000).toFixed(m >= 9950 ? 0 : 1) + 'km' : Math.max(0, Math.round(m / 10) * 10) + 'm');
  const fmtMin = (ms) => {
    const m = Math.max(1, Math.round(ms / 60000));
    return m >= 60 ? Math.floor(m / 60) + '시간 ' + (m % 60) + '분' : m + '분';
  };
  const spokenDist = (m) => (m >= 1000 ? (Math.round(m / 100) / 10) + '킬로미터' : Math.max(10, Math.round(m / 10) * 10) + '미터');
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  function fmtDur(ms) {
    const m = Math.floor(ms / 60000);
    return Math.floor(m / 60) + ':' + pad(m % 60);
  }
  // 350° → 10° 로 갈 때 한 바퀴 돌지 않게 누적 각도로 회전
  function makeRotator(el) {
    let cur = null;
    return (h) => {
      if (cur === null) cur = h;
      else cur += turn(h - cur);
      el.style.transform = 'rotate(' + cur + 'deg)';
    };
  }
  // 경로 소통 정보(sections) → 색칠할 구간 [a..b] 목록. 같은 색이 이어지면 합친다.
  // 바탕(교통 정보가 없는 길 = 대개 차가 거의 없는 한산한 길)은 파랑, 원활 초록, 서행 주황, 정체 빨강
  const ROUTE_BASE = '#2f7dff';
  // 2026-11-14 요청: 검은 테두리를 없애고, 네이버 지도처럼 선 안에 흰 점(점점점), 빛나는 레이저 같은 입체감. 색은 그대로.
  //   빛 번짐(같은 색, 넓고 옅게) → 본선(바탕 파랑 / 교통색) → 가운데 빛(흰색 옅게) → 흰 점
  //   [굵기 px, 불투명도, 겹침 순서]
  const ROUTE_STYLE = { glow: [20, 0.28, 47], base: [9, 1, 50], traffic: [9, 1, 51], shine: [3.4, 0.3, 52], dots: [3.4, 0.95, 53] };
  // 흰 점 무늬 한 칸(굵기 3.4px 의 'dot' = 5배). 차가 움직일 때 점이 차를 따라 흔들리지 않게 이 간격(미터)에 맞춰 자른다
  const DOT_PERIOD_PX = 17;
  // 2026-11-14 요청(네이버·다른 내비처럼 빨강을 여러 단계로): 네이버 길찾기 구간의 혼잡도에 그 구간 평균 속도를 더해 다섯 단계로.
  // 네이버 혼잡도 기준(고속도로 서행 40~70·혼잡 40 미만, 일반 도로 서행 15~30·혼잡 15 미만)의 느린 쪽 절반을 한 단계 더 짙게:
  //   원활 / 서행 / 지체(서행 중 느린 쪽) / 정체 / 심한 정체(거의 멈춤)
  // 2026-11-14 요청('GL 지도가 보여 주는 혼잡도 색을 참고'): 색은 네이버 GL 지도 스타일의 실시간 교통 선 색 그대로.
  //   낮(CTT/ctt_*): 원활 rgb(39,196,65) · 서행 #FF8D00 · 정체 #FF0000
  //   밤(CTT/다크/ctt_*): 원활 rgb(37,137,54) · 서행 #B75804 · 정체 rgb(167,22,22)
  //   지체는 서행과 정체의 가운데, 심한 정체는 정체를 더 어둡게. 지도를 낮/밤으로 바꾸면 경로선도 다시 칠한다
  const TRAFFIC_PAL = {
    day: { 1: '#27c441', 2: '#ff8d00', lag: '#ff4700', 3: '#ff0000', stop: '#b30000' },
    night: { 1: '#258936', 2: '#b75804', lag: '#af370d', 3: '#a71616', stop: '#6b0e0e' },
  };
  const trafficPal = () => TRAFFIC_PAL[state.night ? 'night' : 'day'];
  function trafficColor(s) {
    if (!s) return null;
    const P = trafficPal();
    const hw = /고속도로|고속화|도시고속|자동차전용/.test(s.name || '');
    const v = Number.isFinite(s.speed) && s.speed > 0 ? s.speed : null;
    if (s.cong === 2) return v !== null && v < (hw ? 55 : 22) ? P.lag : P[2];
    if (s.cong === 3) return v !== null && v < (hw ? 20 : 8) ? P.stop : P[3];
    return s.cong === 1 ? P[1] : null;
  }
  function trafficRuns(sections, len) {
    const runs = [];
    (sections || []).filter((s) => s && Number.isFinite(s.i) && Number.isFinite(s.n))
      .sort((x, y) => x.i - y.i)
      .forEach((s) => {
        const color = trafficColor(s);
        const a = Math.max(0, Math.floor(s.i));
        const b = Math.min(len - 1, a + Math.max(1, Math.floor(s.n) - 1));
        if (!color || b <= a) return;
        const last = runs[runs.length - 1];
        if (last && last.color === color && a <= last.b + 1) last.b = Math.max(last.b, b);
        else runs.push({ a, b, color });
      });
    // 바로 붙은 다른 색 구간 사이에 바탕색 틈이 생기지 않게 잇는다
    for (let k = 0; k + 1 < runs.length; k++) if (runs[k + 1].a === runs[k].b + 1) runs[k].b++;
    return runs;
  }
  // 경로선을 300점 단위 조각으로 나눠 그린다. 지나온 조각은 숨기고 차가 있는 조각만 고쳐 그려서,
  // 긴 경로(수천 점)에서도 1초마다 지나온 부분을 지우는 부담이 작다. 조각은 시작·끝 점을 이웃과 공유해 틈이 없다.
  const ROUTE_CHUNK = 300;
  function routePieces(n, sections) {
    const out = [];
    const split = (a, b, kind, color) => { for (let x = a; x < b; x += ROUTE_CHUNK) out.push({ a: x, b: Math.min(b, x + ROUTE_CHUNK), kind, color }); };
    const runs = trafficRuns(sections, n);
    // 빛 번짐은 색끼리 겹쳐 탁해지지 않게 경로를 색별로 나눠서(교통색 구간 + 그 사이 바탕색) 깐다
    let x = 0;
    runs.forEach((r) => {
      if (r.a > x) split(x, r.a, 'glow', ROUTE_BASE);
      if (r.b > Math.max(x, r.a)) split(Math.max(x, r.a), r.b, 'glow', r.color);
      x = Math.max(x, r.b);
    });
    if (x < n - 1) split(x, n - 1, 'glow', ROUTE_BASE);
    split(0, n - 1, 'base', ROUTE_BASE);
    runs.forEach((r) => split(r.a, r.b, 'traffic', r.color));
    split(0, n - 1, 'shine', '#ffffff');
    split(0, n - 1, 'dots', '#ffffff');
    return out;
  }
  // ---------- 경로선 모서리 (2026-11-14 요청: '모서리도 네이버 GL 지도 기반으로 도로에 맞게') ----------
  // 길찾기 경로는 교차로에서 꺾이는 점이 뾰족하고, GL 지도는 선 이음을 둥글게 그려 주지 않아(네이버 교통 선도 miter) 꺾이는 곳이
  // 네모나게 각져 도로 모양과 어긋난다. 그릴 때만 20° 넘게 꺾이는 점을 차가 실제로 도는 것처럼 반지름 약 8m 의 곡선으로 바꾼다
  // (앞뒤 구간 길이의 45% 까지). 안내·위치 계산은 원래 점 그대로. 회전 화살표도 같은 곡선을 따라간다.
  // 결과: pts(그릴 점), along(각 점의 경로 거리 m, 원래 경로 기준), first/last(원래 점 i 를 대신하는 그릴 점 번호 범위)
  const ROUTE_CORNER_M = 8;
  function roundRoute(pts) {
    const n = pts.length, cum = [0];
    for (let i = 1; i < n; i++) cum.push(cum[i - 1] + haversine(pts[i - 1], pts[i]));
    const out = [], along = [], first = new Int32Array(n), last = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      first[i] = out.length;
      let done = false;
      if (i > 0 && i < n - 1) {
        const V = pts[i], kx = Math.cos(toRad(V.lat)) * 111320, ky = 110540;
        const ax = (pts[i - 1].lng - V.lng) * kx, ay = (pts[i - 1].lat - V.lat) * ky;
        const bx = (pts[i + 1].lng - V.lng) * kx, by = (pts[i + 1].lat - V.lat) * ky;
        const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
        if (la > 0.5 && lb > 0.5) {
          const turn = Math.PI - Math.acos(Math.max(-1, Math.min(1, (ax * bx + ay * by) / (la * lb))));
          if (turn > toRad(20)) {
            const t = Math.min(ROUTE_CORNER_M * Math.tan(Math.min(turn, toRad(170)) / 2), la * 0.45, lb * 0.45);
            const p1 = { x: ax / la * t, y: ay / la * t }, p2 = { x: bx / lb * t, y: by / lb * t };
            const N = Math.max(3, Math.ceil(turn / toRad(12)));
            for (let k = 0; k <= N; k++) {
              const u = k / N, w0 = (1 - u) * (1 - u), w2 = u * u;   // 2차 베지어: p1 → (꺾이는 점) → p2
              out.push({ lat: V.lat + (w0 * p1.y + w2 * p2.y) / ky, lng: V.lng + (w0 * p1.x + w2 * p2.x) / kx });
              along.push(cum[i] - t + 2 * t * u);
            }
            done = true;
          }
        }
      }
      if (!done) { out.push(pts[i]); along.push(cum[i]); }
      last[i] = out.length - 1;
    }
    return { pts: out, along, first, last };
  }
  // 그릴 경로에서 거리 at 보다 뒤(along > at)인 첫 점 번호 / 거리 at 자리의 좌표
  function dispIndexAfter(disp, at) {
    let lo = 0, hi = disp.along.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (disp.along[m] <= at) lo = m + 1; else hi = m; }
    return lo;
  }
  function dispPointAt(disp, at) {
    const k = dispIndexAfter(disp, at), A = disp.along, P = disp.pts;
    if (k <= 0) return P[0];
    if (k >= P.length) return P[P.length - 1];
    const r = A[k] > A[k - 1] ? (at - A[k - 1]) / (A[k] - A[k - 1]) : 0;
    return { lat: P[k - 1].lat + (P[k].lat - P[k - 1].lat) * r, lng: P[k - 1].lng + (P[k].lng - P[k - 1].lng) * r };
  }
  // 조각마다: 차(경로 거리 at)보다 뒤면 숨기고, 차가 걸친 조각은 그 자리부터, 앞이면 원래대로 (점·거리는 그릴 경로 disp 기준)
  // ops: { hide(pc), show(pc), setPath(pc, pathArray), point(q) }
  // atDot: 흰 점 조각만 따로 자를 거리 (점 간격에 맞춘 자리: 점이 땅에 붙어 있게)
  function trimPieces(pieces, path, disp, at0, ops, atDot) {
    const pt = {};
    pieces.forEach((pc) => {
      const isDot = pc.kind === 'dots' && atDot != null, at = isDot ? atDot : at0, key = isDot ? 'd' : 'c';
      const k0 = disp.first[pc.a], k1 = disp.last[pc.b];
      if (disp.along[k1] <= at) { if (pc.st !== 'hidden') { ops.hide(pc); pc.st = 'hidden'; } return; }
      if (disp.along[k0] < at) {
        if (!pt[key]) pt[key] = ops.point(dispPointAt(disp, at));
        ops.setPath(pc, [pt[key]].concat(path.slice(dispIndexAfter(disp, at), k1 + 1)));
        if (pc.st === 'hidden') ops.show(pc);
        pc.st = 'part';
        return;
      }
      if (pc.st !== 'full') {
        ops.setPath(pc, path.slice(k0, k1 + 1));
        if (pc.st === 'hidden') ops.show(pc);
        pc.st = 'full';
      }
    });
  }
  function loadScript(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src; s.async = true;
      s.onload = () => resolve();
      s.onerror = () => reject(new Error('load failed: ' + src));
      document.head.appendChild(s);
    });
  }
  function loadCss(href) {
    return new Promise((resolve) => {
      const l = document.createElement('link');
      l.rel = 'stylesheet'; l.href = href;
      l.onload = l.onerror = () => resolve();
      document.head.appendChild(l);
    });
  }

  // ---------- 알림 ----------
  let toastTimer = 0;
  function toast(msg, kind, ms) {
    const t = $('#toast');
    t.textContent = msg;
    t.className = 'toast ' + (kind || '');
    t.hidden = false;
    clearTimeout(toastTimer);
    if (ms !== 0) toastTimer = setTimeout(() => { t.hidden = true; }, ms || 4000);
  }
  $('#toast').addEventListener('click', () => { $('#toast').hidden = true; });

  // ---------- 소리 / 음성 ----------
  // 브라우저는 화면을 한 번 터치하기 전까지 소리(경고음·음성)를 막는다.
  // 화면 어디든 처음 터치할 때 조용히 소리를 켠다 (안내 문구는 띄우지 않음, 켜고 끄기는 설정에서)
  let actx = null, audioUnlocked = false;
  function updateSoundPill() { /* 안내 문구 없음 */ }
  function unlockAudio() {
    const C = window.AudioContext || window.webkitAudioContext;
    if (!actx && C) { try { actx = new C(); } catch (e) { actx = null; } }
    if (actx && actx.state === 'suspended') actx.resume();
    audioUnlocked = true;
  }
  document.addEventListener('pointerdown', unlockAudio, { passive: true, capture: true });
  function beep(times, freq) {
    if (!prefs.beep || !actx) return;
    const t0 = actx.currentTime + 0.02;
    for (let i = 0; i < (times || 1); i++) {
      const o = actx.createOscillator(), g = actx.createGain();
      const s = t0 + i * 0.22;
      o.type = 'sine'; o.frequency.value = freq || 880;
      g.gain.setValueAtTime(0.0001, s);
      g.gain.exponentialRampToValueAtTime(0.5, s + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, s + 0.16);
      o.connect(g); g.connect(actx.destination);
      o.start(s); o.stop(s + 0.18);
    }
  }
  // 단속 구간을 무사히 지나면 '띠링' 한 번 (높은 두 음을 짧게 이어서)
  function chime() {
    if (!prefs.beep || !actx) return;
    const t0 = actx.currentTime + 0.02;
    [[1318.5, 0], [1760, 0.12]].forEach(([freq, dt]) => {
      const o = actx.createOscillator(), g = actx.createGain(), s = t0 + dt;
      o.type = 'sine'; o.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, s);
      g.gain.exponentialRampToValueAtTime(0.35, s + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, s + 0.45);
      o.connect(g); g.connect(actx.destination);
      o.start(s); o.stop(s + 0.5);
    });
  }
  let koVoice = null;
  const hasTTS = 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window;
  function pickVoice() {
    if (!hasTTS) return;
    const vs = speechSynthesis.getVoices();
    koVoice = vs.find((v) => /^ko/i.test(v.lang)) || null;
  }
  let voicesSettled = false; // 음성 목록이 늦게 오는 기기 대비: 2.5초 뒤에도 비어 있으면 음성 없음으로 본다
  if (hasTTS) { pickVoice(); speechSynthesis.onvoiceschanged = pickVoice; }
  setTimeout(() => { voicesSettled = true; pickVoice(); }, 2500);
  function speak(text, urgent, onFail) {
    if (!prefs.voice || !hasTTS || !audioUnlocked) return false;
    // 한국어 음성이 없는 기기에서 외국어 음성으로 읽으면 알아들을 수 없으므로 경고음으로 대신한다
    if (!koVoice && (voicesSettled || speechSynthesis.getVoices().length)) return false;
    try {
      if (urgent) speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'ko-KR';
      if (koVoice) u.voice = koVoice;
      u.rate = 1.05;
      if (onFail) u.onerror = (e) => { if (e.error !== 'interrupted' && e.error !== 'canceled') onFail(); };
      speechSynthesis.speak(u);
      return true;
    } catch (e) { return false; }
  }
  // 최근 안내 기록 (진단·테스트용): 어떤 음성/경고음이 언제 나갔는지
  const alertLog = [];
  function logAlert(kind, text) {
    alertLog.push({ t: Date.now(), kind, text, kmh: Math.round(state.speedKmh) });
    if (alertLog.length > 300) alertLog.shift();
  }
  function say(text, beeps, urgent) {
    const spoke = speak(text, urgent, () => beep(beeps || 1));
    logAlert(spoke ? 'voice' : 'beep', text);
    if (!spoke) beep(beeps || 1);
  }

  // ---------- 마커 요소 ----------
  // 내 차 아이콘 (2026-11-14 요청: 네이버 지도처럼 고를 수 있게, 우리 차 모양도). 모두 앞쪽이 위, viewBox 40×56
  // 테슬라 모델 Y 를 위에서 본 모양: 차체 색만 바꾼다. 같은 그림이 지도와 설정 미리보기에 같이 있어도 그라데이션이
  // 서로 엉키지 않게 id 뒤에 붙일 글자(sfx)를 받는다
  // AI 로 그린 실사 모델 Y (2026-11-14 요청 '테슬라 그 AI 돌려주라': Atlas GPT Image 2.5 Flare, 테슬라 앱 느낌).
  // 분홍 바탕을 빼고 가장자리 색을 되돌린 투명 PNG (tools/build_cars.py → img/car_*.png, 40×56 비율, 앞쪽이 위)
  const carImg = (id) => '<img class="me-arrow car-img car-' + id + '" src="' + APP_BASE + 'img/car_' + id + '.png?v=' + APP_VERSION + '" alt="" draggable="false">';
  const CAR_ICONS = [
    { id: 'cute', name: '초록 꼬마차', svg: () => '<svg class="me-arrow car-cute" viewBox="0 0 40 56">' +
      '<rect x="2.5" y="12" width="6" height="11" rx="3" fill="#232a35"/>' +
      '<rect x="31.5" y="12" width="6" height="11" rx="3" fill="#232a35"/>' +
      '<rect x="2.5" y="37" width="6" height="11" rx="3" fill="#232a35"/>' +
      '<rect x="31.5" y="37" width="6" height="11" rx="3" fill="#232a35"/>' +
      '<rect x="5.5" y="3" width="29" height="50" rx="14" fill="#03c75a" stroke="#fff" stroke-width="2.5"/>' +
      '<path d="M10.5 25 Q20 19.5 29.5 25 L28 31 Q20 28 12 31 Z" fill="#d9f4ff"/>' +
      '<rect x="11.5" y="32" width="17" height="10.5" rx="5" fill="#02b351"/>' +
      '<path d="M12.5 44.5 Q20 47.5 27.5 44.5 L26.5 48.5 Q20 50.5 13.5 48.5 Z" fill="#d9f4ff" opacity=".9"/>' +
      '<circle cx="13" cy="10.5" r="4" fill="#fff"/><circle cx="27" cy="10.5" r="4" fill="#fff"/>' +
      '<circle cx="13.5" cy="9.5" r="2.1" fill="#1b2330"/><circle cx="27.5" cy="9.5" r="2.1" fill="#1b2330"/>' +
      '<circle cx="14.3" cy="8.8" r=".75" fill="#fff"/><circle cx="28.3" cy="8.8" r=".75" fill="#fff"/>' +
      '<circle cx="9.3" cy="16.5" r="1.9" fill="#ff8fa3" opacity=".8"/><circle cx="30.7" cy="16.5" r="1.9" fill="#ff8fa3" opacity=".8"/>' +
      '<path d="M16.8 16.2 Q20 19 23.2 16.2" fill="none" stroke="#0b4a2b" stroke-width="1.7" stroke-linecap="round"/></svg>' },
    // 실사 모델 Y (AI): 사용자 차는 짙은 회색
    // 2026-11-14 '중복 정리, 최신 걸로': 예전에 그린 SVG 모델 Y(my·red·white)는 빼고 AI 실사만 남긴다 (저장된 옛 값은 같은 색 실사로)
    { id: 'tesla_grey', name: '모델 Y 그레이', svg: () => carImg('tesla_grey') },
    { id: 'tesla_red', name: '모델 Y 레드', svg: () => carImg('tesla_red') },
    { id: 'tesla_white', name: '모델 Y 화이트', svg: () => carImg('tesla_white') },
    // 네이버 지도 같은 내비 화살표
    { id: 'arrow', name: '파란 화살표', svg: () => '<svg class="me-arrow car-arrow" viewBox="0 0 40 56">' +
      '<circle cx="20" cy="28" r="15.5" fill="#fff" stroke="#d7dde5" stroke-width="1.2"/>' +
      '<path d="M20 15.5 28.6 38.4 20 33.6 11.4 38.4z" fill="#2f6fe4" stroke="#2f6fe4" stroke-width="1.2" stroke-linejoin="round"/></svg>' },
    { id: 'arrow3d', name: '입체 화살표', svg: () => '<svg class="me-arrow car-arrow3d" viewBox="0 0 40 56">' +
      '<path d="M20 8 31.5 45 20 37.6z" fill="#3d86ff"/><path d="M20 8 8.5 45 20 37.6z" fill="#1c55cf"/>' +
      '<path d="M20 8v29.6" stroke="#0f3c9c" stroke-width=".6" opacity=".6"/></svg>' },
  ];
  // 관리 페이지(tools/icons.html)에서 고른 AI 차 그림은 'ai:<img/ai 의 파일>' 로 저장된다
  const CAR_LEGACY = { my: 'tesla_grey', red: 'tesla_red', white: 'tesla_white' };   // 예전 SVG 모델 Y → 같은 색 실사
  const carIcon = (id0) => { const id = CAR_LEGACY[id0] || id0; return (/^ai:[\w.-]+\.webp$/.test(id || '') ? {
    id, name: 'AI 차', svg: () => '<img class="me-arrow car-img car-ai" src="' + APP_BASE + 'img/ai/' + id.slice(3) + '?v=' + APP_VERSION + '" alt="" draggable="false">',
  } : CAR_ICONS.find((c) => c.id === id) || CAR_ICONS[0]); };
  const meEl = document.createElement('div');
  meEl.className = 'me nohead';
  meEl.innerHTML = '<div class="me-halo"></div><div class="me-dot"></div>' + carIcon(prefs.car).svg('');
  let rotateMe = makeRotator(meEl.querySelector('.me-arrow'));
  // 아이콘을 바꾸면 그림만 갈아 끼우고 지금 방향으로 바로 돌려 둔다
  function setCarIcon(id) {
    prefs.car = carIcon(id).id;   // ai:… 도 그대로
    store.set('car', prefs.car === 'cute' ? null : prefs.car);
    const old = meEl.querySelector('.me-arrow');
    const tmp = document.createElement('div');
    tmp.innerHTML = carIcon(prefs.car).svg('');
    old.replaceWith(tmp.firstChild);
    rotateMe = makeRotator(meEl.querySelector('.me-arrow'));
    if (state.heading !== null) rotateMe(state.heading - (typeof glOn === 'function' && glOn() ? glView.rot : 0));
    renderCarIcons();
  }
  function renderCarIcons() {
    const box = $('#carIcons');
    if (!box) return;
    box.innerHTML = CAR_ICONS.map((c) => '<button type="button" class="ci' + (c.id === prefs.car ? ' on' : '') + '" data-k="' + c.id + '" aria-pressed="' +
      (c.id === prefs.car) + '">' + c.svg('-p').replace('class="me-arrow ', 'class="') + '<span>' + c.name + '</span></button>').join('');
    box.querySelectorAll('.ci').forEach((el) => { el.onclick = () => setCarIcon(el.dataset.k); });
  }
  const rotateCompass = makeRotator($('#compassArrow'));
  function camEl(c) {
    const el = document.createElement('div');
    el.className = 'cammk k' + c[3] + (c[6] ? ' z' + c[6] : ''); // z2 어린이·z1 노인 보호구역은 노란 바탕
    el.textContent = c[2];
    return el;
  }
  // 과속방지턱 주의 표지: 빨간 테두리 흰 삼각형 안에 검은 둔덕
  const SIGN_BUMP = '<svg viewBox="0 0 100 88" aria-hidden="true"><path d="M50 7 L94 82 L6 82 Z" fill="#fff" stroke="#e53935" stroke-width="10" stroke-linejoin="round"/>' +
    '<path d="M25 69 H75" stroke="#111" stroke-width="6" stroke-linecap="round"/><path d="M33 69 Q50 42 67 69 Z" fill="#111"/></svg>';
  // ---------- 지도 위 회전 화살표·목적지 핀 (2026-11-14 요청: 휴대폰 내비처럼) ----------
  // 다음 회전 지점의 경로를 따라 흰 화살표(어두운 테두리). 화살촉은 화면에서 같은 크기로 보이게 지금 배율로 계산한다
  // 2026-11-14 피드백('화살표가 너무 두껍고 투박'): 몸통 15→11px(흰 7px), 화살촉은 좁고 뾰족하게(길이 20·폭 24px),
  // 테두리는 어디서나 2px 로 고르게(안쪽 화살촉을 빗변에서 2px 안으로), 꺾이는 곳은 각지지 않게 둥글린다
  // 2026-11-14 피드백('지도를 축소하면 화살표가 지도에 비해 너무 커서 다른 표시를 덮는다'): 배율 17 아래로는 작게(최소 60%),
  // 14 아래(멀리 보기)는 그리지 않는다. 덮는 길이도 화면 기준: 회전 앞 48px·뒤 30px (최소 45m·30m, 최대 150m·100m)
  // 2026-11-14 두 번째 피드백: '위에 올린(스티커) 느낌보다 경로를 이어 가는 느낌, 조금 더 작게' → 검은 테두리를 없애고
  // 몸통은 경로선과 같은 굵기(9px)·같은 색에 가운데만 흰 줄(5px), 화살촉은 흰색에 그 자리 경로 색 테두리. 경로선이 흰 화살표로 이어진다
  const ARROW_PX = { shaft: 9, inner: 5, len: 16, half: 9.5, rim: 1.6 }, ARROW_STEP = 2.5, ARROW_MIN_ZOOM = 14;
  const arrowScale = (z) => (z >= 17 ? 1 : Math.max(0.6, 1 - (17 - z) * 0.16));
  function arrowSpan(lat, zoom) {
    const mpp = 156543.03392 * Math.cos(toRad(lat)) / Math.pow(2, zoom);
    return { before: Math.min(150, Math.max(35, 40 * mpp)), after: Math.min(100, Math.max(25, 26 * mpp)) };
  }
  function arrowGeom(pts0, zoom, ti) {
    let pts = pts0;
    const sp = arrowSpan(pts0[ti != null ? ti : pts0.length - 1].lat, zoom || 17);
    if (pts0.some((q) => q.rel != null)) pts = pts0.filter((q) => q.rel == null || (q.rel >= -sp.before - 0.01 && q.rel <= sp.after + 0.01));
    else if (ti != null) pts = pts0.slice(Math.max(0, ti - Math.round(sp.before / ARROW_STEP)), Math.min(pts0.length, ti + Math.round(sp.after / ARROW_STEP) + 1));
    if (pts.length < 2) pts = pts0;
    const sc = arrowScale(zoom || 17);
    const E = pts[pts.length - 1], kx = Math.cos(toRad(E.lat)) * 111320, ky = 110540;
    const loc = (q) => ({ x: (q.lng - E.lng) * kx, y: (q.lat - E.lat) * ky });
    const back = (m) => ({ lat: E.lat + m.y / ky, lng: E.lng + m.x / kx });
    // 끝 방향: 끝에서 6m 넘게 떨어진 앞 점으로
    let j = pts.length - 2;
    while (j > 0 && haversine(pts[j], E) < 6) j--;
    const A = loc(pts[j]);
    const n0 = Math.hypot(A.x, A.y) || 1, d = { x: -A.x / n0, y: -A.y / n0 }, nn = { x: -d.y, y: d.x };
    const mpp = 156543.03392 * Math.cos(toRad(E.lat)) / Math.pow(2, zoom || 17);
    const px = (v) => v * sc * mpp;
    const at = (o, along, side) => ({ x: o.x + d.x * along + nn.x * side, y: o.y + d.y * along + nn.y * side });
    const O = { x: 0, y: 0 }, H = ARROW_PX;
    // 바깥(테두리) 화살촉: 끝점보다 4px 앞이 뾰족한 끝. 안쪽 흰 화살촉은 빗변에서 rim 만큼 안쪽
    const T = at(O, px(4), 0), Bo = at(T, -px(H.len), 0);
    const sinA = H.half / Math.hypot(H.half, H.len), tanA = H.half / H.len;
    const tipIn = H.rim / sinA, lenIn = H.len - H.rim - tipIn;
    const Ti = at(T, -px(tipIn), 0), Bi = at(Ti, -px(lenIn), 0);
    const tri = (tip, base, w) => [tip, at(base, 0, w), at(base, 0, -w)].map(back);
    // 몸통은 안쪽 화살촉 밑동 조금 안까지만 (둥근 끝이 화살촉 밖으로 삐져나오지 않게)
    const cut = px(H.len - H.rim - 4 - 2);
    // 꺾이는 곳은 경로선과 똑같이 (둥글리지 않는다): 2026-11-14 피드백 — 화살표만 둥글게 돌면 바깥의 경로선 모서리가
    // 화살표 곡선 밖으로 각지게 튀어나와 '이어지는' 느낌이 깨진다. 같은 점·같은 이음으로 그리면 흰 줄과 경로 테두리가 한 모서리를 공유한다
    const sh = pts.slice(0, -1).filter((q) => haversine(q, E) > cut).map(loc);
    sh.push(at(O, -cut, 0));
    return { shaft: sh.map(back), headOut: tri(T, Bo, px(H.half)), headIn: tri(Ti, Bi, px(lenIn * tanA)), sc, pts, span: sp };
  }
  // 목적지 핀 (사용자가 그린 '도착' 핀이 있으면 그것)
  function destPinEl() {
    const el = document.createElement('div');
    el.className = 'destpin uprt';
    el.innerHTML = (window.TNC_ICONS && window.TNC_ICONS.goal) ? ico('goal') : PIN_ICON;
    return el;
  }
  // 경로 끝(차가 서는 곳)과 실제 목적지 사이 점선 점들 (12m 넘게 떨어졌을 때)
  function destDots(end, d) {
    if (!end || !d) return [];
    const dist = haversine(end, d);
    if (dist < 12) return [];
    const n = Math.min(12, Math.max(1, Math.floor(dist / 8)));
    const out = [];
    for (let i = 1; i <= n; i++) {
      const t = i / (n + 1);
      out.push({ lat: end.lat + (d.lat - end.lat) * t, lng: end.lng + (d.lng - end.lng) * t });
    }
    return out;
  }
  function dotEl() { const el = document.createElement('div'); el.className = 'destdot'; return el; }
  // 휴게소 표지: 파란 네모 + 흰 포크·나이프 (고속도로 휴게소 안내 표지처럼)
  const REST_SVG = '<svg viewBox="0 0 40 40" aria-hidden="true"><rect x="1.5" y="1.5" width="37" height="37" rx="8" fill="#1d4fb8" stroke="#fff" stroke-width="2.5"/>' +
    '<path d="M13 9v9.5c0 1.6 1.2 2.8 2.6 3.1V31c0 1.1.8 1.9 1.7 1.9s1.7-.8 1.7-1.9v-9.4c1.4-.3 2.6-1.5 2.6-3.1V9M15.5 9v7.5M18.5 9v7.5" fill="none" stroke="#fff" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"/>' +
    '<path d="M27.6 9c-2.6 1.2-4.1 4.4-4.1 8.6 0 2 .9 3.3 2.4 3.8V31c0 1.1.8 1.9 1.7 1.9s1.7-.8 1.7-1.9V9z" fill="#fff"/></svg>';
  function restEl() {
    const el = document.createElement('div');
    el.className = 'restmk';
    el.innerHTML = REST_SVG;
    return el;
  }
  // 주정차 금지 표지: 파란 원 + 빨간 테두리 + 빨간 X
  const PARK_SVG = '<svg viewBox="0 0 100 100" aria-hidden="true"><circle cx="50" cy="50" r="42" fill="#1d4fb8" stroke="#e53935" stroke-width="12"/>' +
    '<path d="M24 24 L76 76 M76 24 L24 76" stroke="#e53935" stroke-width="10" stroke-linecap="round"/></svg>';
  function parkEl() {
    const el = document.createElement('div');
    el.className = 'parkmk';
    el.innerHTML = PARK_SVG;
    return el;
  }
  function bumpEl() {
    const el = document.createElement('div');
    el.className = 'bumpmk';
    el.innerHTML = pickImg('sign_bump') || SIGN_BUMP;
    return el;
  }
  // 보호구역 주의 표지 (빨간 테두리 노란 삼각형 + 그림): 어린이보호는 어른과 아이가 손잡고 걷는 모습, 노인보호는 지팡이 짚은 노인
  const SIGN_TRI = '<path d="M50 5 L95 83 L5 83 Z" fill="#e53935" stroke="#e53935" stroke-width="8" stroke-linejoin="round"/>' +
    '<path d="M50 20 L83 77 L17 77 Z" fill="#ffd200" stroke="#ffd200" stroke-width="4" stroke-linejoin="round"/>';
  const SIGN_KID = '<svg viewBox="0 0 100 88" aria-hidden="true">' + SIGN_TRI +
    '<g fill="#111"><circle cx="41" cy="40" r="4.6"/><circle cx="58.5" cy="50" r="3.8"/></g>' +
    '<g stroke="#111" stroke-linecap="round" stroke-linejoin="round" fill="none">' +
    '<path d="M41 47 L41 60" stroke-width="6.5"/><path d="M41 60 L36.5 72 M41 60 L45.5 72" stroke-width="4"/>' +
    '<path d="M41 50 L35 57" stroke-width="3.4"/><path d="M42 50 L54 57" stroke-width="3.2"/>' +
    '<path d="M58.5 55.5 L58.5 64" stroke-width="5.4"/><path d="M58.5 64 L55 72 M58.5 64 L62 72" stroke-width="3.4"/>' +
    '<path d="M59 57.5 L63.5 62" stroke-width="3"/></g></svg>';
  const SIGN_ELDER = '<svg viewBox="0 0 100 88" aria-hidden="true">' + SIGN_TRI +
    '<circle cx="47" cy="38" r="4.6" fill="#111"/>' +
    '<g stroke="#111" stroke-linecap="round" stroke-linejoin="round" fill="none">' +
    '<path d="M46 45 Q47 52 44 60" stroke-width="6.5"/><path d="M44 60 L39.5 72 M44 60 L49.5 72" stroke-width="4"/>' +
    '<path d="M47 48 L56 53" stroke-width="3.4"/><path d="M57 52 L60 72" stroke-width="3"/></g></svg>';

  // ---------- 지도 어댑터 (네이버 / 테스트용 OSM) ----------
  const ALT_LINE = { color: '#8d97a8', weight: 7, opacity: 0.85 }; // 고르지 않은 추천 경로
  const NaverAdapter = {
    drawAlts(list) {
      const N = naver.maps;
      (this.alts || []).forEach((l) => l.setMap(null));
      this.alts = (list || []).map((pts) => new N.Polyline({
        map: this.map, path: pts.map((p) => new N.LatLng(p.lat, p.lng)),
        strokeColor: ALT_LINE.color, strokeWeight: ALT_LINE.weight, strokeOpacity: ALT_LINE.opacity,
        strokeLineCap: 'round', strokeLineJoin: 'round', zIndex: 40, clickable: false,
      }));
    },
    init(el, c) {
      const N = naver.maps;
      this.cams = new Map();
      this.route = null;
      this.gl = glWanted();
      this.darkReady = false; this.dark = false; this._tilt = 0;
      this.map = new N.Map(el, {
        center: new N.LatLng(c.lat, c.lng), zoom: 17, minZoom: 7, gl: this.gl,
        zoomControl: false, mapTypeControl: false, scaleControl: false,
        // 지도 출처 표시(© NAVER Corp. /국토교통부 /경찰청)는 지우지 않고(이용 약관), 왼쪽 아래 구석 로고 옆으로 (오른쪽 아래는 GPS·업데이트 버튼)
        mapDataControlOptions: { position: N.Position.BOTTOM_LEFT },
      });
      // gl:true 로 만들어도 WebGL 이 소프트웨어 렌더러뿐인 PC(예: 'Microsoft Basic Render Driver')에서는 네이버가 조용히 그림(래스터) 지도로
      // 그린다(getOptions('gl') === false, naver.maps.glEnabled 는 그대로 true). 그때 setRotation·setTilt 는 값만 바뀌고 화면은 북쪽 위 그대로라
      // 진행 방향 위가 안 됐다(2026-11-15 모의 주행). 실제로 GL 로 그리는지 보고, 아니면 그림 지도 방식(지도 칸을 CSS 로 돌림)으로
      if (this.gl) {
        let real = true;
        try { real = this.map.getOptions('gl') !== false; } catch (e) { /* 확인 못 하면 GL 로 본다 */ }
        if (!real) { this.gl = false; report('warn', { msg: 'naver gl fell back to raster' }); }
      }
      this.marker = new N.Marker({
        position: new N.LatLng(c.lat, c.lng), map: this.map, visible: false, clickable: false, zIndex: 1000,
        icon: { content: meEl, anchor: new N.Point(28, 28) },
      });
      N.Event.addListener(this.map, 'dragstart', onUserPan);
      // 배율이 바뀌면 회전 화살표의 화살촉 크기를 다시 맞춘다
      N.Event.addListener(this.map, 'zoom_changed', () => { clearTimeout(this._arrowT); this._arrowT = setTimeout(() => this.drawArrow(), 120); });
      this.setTraffic(prefs.traffic);
      if (this.gl) { this.initDark(this.map); this.watchGl(el, this.map); }
    },
    // 차 브라우저에서 WebGL 이 끊기면(context lost) 지도가 하얗게 남는다: 바로 그림(래스터) 지도로 다시 만든다
    watchGl(el, map) {
      let n = 0;
      const hook = () => {
        if (this.map !== map) return;
        const cv = el.querySelector('canvas');
        if (!cv) { if (++n < 20) setTimeout(hook, 250); return; }
        cv.addEventListener('webglcontextlost', () => {
          if (this.map !== map) return;
          glBroken = true;
          report('warn', { msg: 'webgl context lost: raster map' });
          setTimeout(() => { if (mapA === this) useMap(NaverAdapter).then(() => { if (mapA && mapA.setDark) mapA.setDark(state.night, true); }); }, 0);
        }, { once: true });
      };
      hook();
    },
    // GL 지도 회전(진행 방향, 도)·기울기(도). 글자·아이콘은 똑바로 선 채 지도만 돈다
    setView(rot, tilt) {
      if (!this.gl || !this.map) return;
      this.map.setRotation(rot);
      if (Math.abs(tilt - this._tilt) > 0.05) { this.map.setTilt(tilt); this._tilt = tilt; }
    },
    // 밤: 네이버 GL 스타일 안에 들어 있는 다크 지도(dbasic: 어두운 바탕·글자·POI)를 지도 종류로 등록해 바꿔 끼운다.
    // 경로선·카메라·내 차 색은 그대로. 스타일을 못 받으면 지도 캔버스만 어둡게(색은 그대로) 한다
    async initDark(map) {
      try {
        let n = null, url = null;
        for (let k = 0; k < 40 && this.map === map; k++) { // 스타일은 지도를 만든 뒤 따로 받아 온다 (최대 10초)
          n = map.mapTypes && map.mapTypes.normal;
          url = performance.getEntriesByType('resource').map((x) => x.name).find((u) => /\/style\/deployed\/.+\.json/.test(u));
          if (n && n.mapTypeStyle && url) break;
          await new Promise((res) => setTimeout(res, 250));
        }
        if (this.map !== map || !n || !n.mapTypeStyle) throw new Error('no normal style');
        if (!url) url = 'https://map.pstatic.net/resource/api/v2/style/deployed/fd753228-778c-4242-8b6b-24ca6329458a/PCWeb_Real_conv.json';
        const full = await (await fetch(url)).json();
        // 일반 지도 스타일과 같은 방식: 다크 지도 종류의 모든 묶음을 넣고, 바탕·글자·POI·지하철만 켠다.
        // 나머지(실시간 교통 dctt 등)는 꺼 둔 채로 넣어야 교통 레이어 같은 것이 켤 수 있다
        const cats = (((full.metadata || {})['map-types'] || {}).dbasic || {}).categories || {};
        const on = new Set([].concat(cats.default || [], cats.overlay || [], cats.poi || [], cats.transit_subway || []));
        if (!on.size) throw new Error('no dbasic map type');
        const all = new Set([].concat(...Object.values(cats)).filter((g) => g[0] !== '!'));
        const keep = new Set(n.mapTypeStyle.layers.filter((l) => !(l.metadata || {}).group).map((l) => l.id));
        const layers = full.layers.filter((l) => all.has((l.metadata || {}).group) || keep.has(l.id)).map((l) => {
          const c = JSON.parse(JSON.stringify(l));
          if (on.has((l.metadata || {}).group)) c.layout = Object.assign({}, c.layout, { visibility: 'visible' });
          return c;
        });
        const style = Object.assign({}, n.mapTypeStyle, { name: 'dbasic', layers });
        const dark = new n.constructor(style, Object.assign({}, n._options, {
          uid: 'naver:dbasic-vt', name: '야간', darktheme: true, tileSize: n.tileSize, minZoom: n.minZoom, maxZoom: n.maxZoom,
        }));
        if (this.map !== map) return;
        map.mapTypes.set('tncdark', dark);
        this.darkReady = true;
      } catch (e) {
        report('warn', { msg: 'gl dark style: ' + String(e.message || e).slice(0, 120) });
      }
      if (this.map === map) this.setDark(state.night, true);
    },
    setDark(on, force) {
      if (!this.gl || !this.map || (!force && on === this.dark)) return;
      this.dark = on;
      if (this.darkReady) { this.map.setMapTypeId(on ? 'tncdark' : 'normal'); this.reattachTraffic(); }
      $('#map').classList.toggle('gldim', on && !this.darkReady);
    },
    // 지도 종류(낮/밤)를 바꾸면 스타일이 통째로 바뀌어 실시간 교통 선이 빠진다: 다시 붙인다 (스타일이 다 바뀔 때까지 몇 번 확인)
    // 다크 지도 안의 실시간 교통 선은 네이버가 켜 주지 않아(직접 만든 지도 종류) 앱이 켜고 끈다
    darkTraffic(on) {
      try {
        const mb = this.map && this.map._mapbox;
        if (!mb) return;
        mb.getStyle().layers.forEach((l) => {
          if (/^CTT\/다크\//.test(l.id) && mb.getLayoutProperty(l.id, 'visibility') !== (on ? 'visible' : 'none')) mb.setLayoutProperty(l.id, 'visibility', on ? 'visible' : 'none');
        });
      } catch (e) { /* 스타일이 아직 바뀌는 중: 다음 확인 때 */ }
    },
    reattachTraffic() {
      clearTimeout(this._trafficT);
      let n = 0;
      const check = () => {
        if (!this.map || !this.traffic) return;
        if (this.dark && this.darkReady) this.darkTraffic(prefs.traffic); // 다크 지도: 다크용 교통 선(CTT/다크/*)을 직접 켠다
        else if (prefs.traffic) {
          const mb = this.map._mapbox, ids = this.traffic._layerIds || [];
          let missing = true;
          try { missing = !ids.length || ids.some((id) => !mb.getLayer(id)); } catch (e) { missing = true; }
          if (missing) { try { this.traffic.setMap(null); this.traffic.setMap(this.map); } catch (e) { /* 다음 확인 때 */ } }
        }
        if (++n < 8) this._trafficT = setTimeout(check, 750);
      };
      this._trafficT = setTimeout(check, 500);
    },
    // 네이버 실시간 교통 레이어: 도로를 막힘 정도에 따라 색칠 (5분마다 갱신)
    setTraffic(on) {
      if (!this.map || !naver.maps.TrafficLayer) return;
      if (!this.traffic) this.traffic = new naver.maps.TrafficLayer({ interval: 300000 });
      this.traffic.setMap(on ? this.map : null);
      if (this.gl && this.dark) this.darkTraffic(on);
    },
    setMe(lat, lng) {
      this.marker.setPosition(new naver.maps.LatLng(lat, lng));
      this.marker.setVisible(true);
    },
    center(lat, lng, jump) {
      const p = new naver.maps.LatLng(lat, lng);
      if (jump) this.map.setCenter(p); else this.map.panTo(p);
    },
    zoomBy(d) { this.map.setZoom(this.map.getZoom() + d, true); },
    getZoom() { return this.map.getZoom(); },
    setZoom(z) { this.map.setZoom(z, true); },
    // 주행 화면(돌리고 기울인 캔버스)에서는 지도 라이브러리의 손 조작을 끄고 앱이 직접 옮긴다
    // (라이브러리는 화면 좌표를 돌리지 않고 써서 끄는 방향과 지도가 따로 논다)
    setInteract(on) {
      if (this.gl) return; // GL 지도는 돌린 채로도 손 조작이 맞게 움직인다
      this.map.setOptions({ draggable: on, pinchZoom: on, scrollWheel: on, disableDoubleTapZoom: !on, disableDoubleClickZoom: !on });
    },
    // 지도 가운데를 캔버스 픽셀만큼 옮긴다 (애니메이션 없이)
    panPx(dx, dy) {
      const N = naver.maps, proj = this.map.getProjection && this.map.getProjection();
      if (proj && proj.fromCoordToOffset) {
        const o = proj.fromCoordToOffset(this.map.getCenter());
        this.map.setCenter(proj.fromOffsetToCoord(new N.Point(o.x + dx, o.y + dy)));
      } else this.map.panBy(new N.Point(dx, dy));
    },
    getCenter() { const c = this.map.getCenter(); return { lat: c.lat(), lng: c.lng() }; },
    coordAt(px, py) {
      const N = naver.maps, proj = this.map.getProjection(), sz = this.map.getSize();
      const o = proj.fromCoordToOffset(this.map.getCenter());
      const c = proj.fromOffsetToCoord(new N.Point(o.x + px - sz.width / 2, o.y + py - sz.height / 2));
      return { lat: c.lat(), lng: c.lng() };
    },
    stop() { if (this.map.stop) this.map.stop(); }, // 진행 중인 이동·확대 애니메이션을 멈춘다
    // 캔버스 크기가 바뀐 뒤 지도 크기를 맞춘다 (중심 좌표는 유지)
    resize(w, h) {
      const c = this.map.getCenter();
      if (this.map.setSize) this.map.setSize(new naver.maps.Size(w, h));
      else if (this.map.autoResize) this.map.autoResize();
      this.map.setCenter(c);
    },
    drawRoute(pts, sections) {
      this.clearRoute();
      const N = naver.maps;
      const disp = roundRoute(pts);
      const path = disp.pts.map((p) => new N.LatLng(p.lat, p.lng));
      this.routePath = path; this.disp = disp;
      this.route = routePieces(pts.length, sections).map((pc) => {
        const st = ROUTE_STYLE[pc.kind];
        pc.line = new N.Polyline({
          map: this.map, path: path.slice(disp.first[pc.a], disp.last[pc.b] + 1), strokeColor: pc.color, strokeWeight: st[0], strokeOpacity: st[1],
          strokeStyle: pc.kind === 'dots' ? 'dot' : 'solid', strokeLineCap: 'round', strokeLineJoin: 'round', zIndex: st[2], clickable: false,
        });
        pc.st = 'full';
        return pc;
      });
    },
    // 지나온 경로 지우기: 경로 거리 at 부터 앞만 남긴다 (흰 점은 atDot 부터)
    trimRoute(at, atDot) {
      if (!this.route || !this.routePath) return;
      const N = naver.maps, map = this.map;
      trimPieces(this.route, this.routePath, this.disp, at, {
        hide: (pc) => pc.line.setMap(null), show: (pc) => pc.line.setMap(map),
        setPath: (pc, p) => pc.line.setPath(p), point: (q) => new N.LatLng(q.lat, q.lng),
      }, atDot);
    },
    // 지금 배율에서 화면 1px 이 몇 미터인지 (지도 가운데 위도 기준)
    mpp() { return 156543.03392 * Math.cos(toRad(this.map.getCenter().lat())) / Math.pow(2, this.map.getZoom()); },
    clearRoute() {
      if (this.route) this.route.forEach((pc) => pc.line.setMap(null));
      this.route = null; this.routePath = null; this.disp = null;
    },
    fit(pts) {
      const N = naver.maps;
      let s = 90, w = 180, n = -90, e = -180;
      pts.forEach((p) => { s = Math.min(s, p.lat); n = Math.max(n, p.lat); w = Math.min(w, p.lng); e = Math.max(e, p.lng); });
      this.map.fitBounds(new N.LatLngBounds(new N.LatLng(s, w), new N.LatLng(n, e)), { top: 110, right: 110, bottom: 210, left: 60 });
    },
    setCameras(list) {
      const N = naver.maps;
      const keep = new Set(list.map((x) => x.i));
      this.cams.forEach((m, i) => { if (!keep.has(i)) { m.setMap(null); this.cams.delete(i); } });
      list.forEach((x) => {
        if (this.cams.has(x.i)) return;
        this.cams.set(x.i, new N.Marker({
          position: new N.LatLng(x.c[0], x.c[1]), map: this.map, clickable: false, zIndex: 100,
          icon: { content: camEl(x.c), anchor: new N.Point(15, 15) },
        }));
      });
    },
    // 과속방지턱: 작은 빨간 테두리 삼각 표지 (카메라처럼 지도를 돌려도 똑바로 선다)
    setBumps(list) {
      const N = naver.maps;
      if (!this.bumps) this.bumps = new Map();
      const keep = new Set(list.map((x) => x.k));
      this.bumps.forEach((m, k) => { if (!keep.has(k)) { m.setMap(null); this.bumps.delete(k); } });
      list.forEach((x) => {
        if (this.bumps.has(x.k)) return;
        this.bumps.set(x.k, new N.Marker({
          position: new N.LatLng(x.lat, x.lng), map: this.map, clickable: false, zIndex: 90,
          icon: { content: bumpEl(), anchor: new N.Point(11, 10) },
        }));
      });
    },
    setRests(list) {
      const N = naver.maps;
      (this.restMk || []).forEach((m) => m.setMap(null));
      this.restMk = (list || []).map((x) => new N.Marker({ position: new N.LatLng(x.lat, x.lng), map: this.map, clickable: false, zIndex: 88,
        icon: { content: restEl(), anchor: new N.Point(12, 12) } }));
    },
    setTurnArrow(pts, ti, color) { this._arrow = pts; this._arrowTi = ti; this._arrowColor = color; this.drawArrow(); },
    drawArrow() {
      (this._arrowObjs || []).forEach((o) => o.setMap(null));
      this._arrowObjs = []; this._arrowShown = null;
      const pts = this._arrow, z = this.map && this.map.getZoom();
      if (!pts || pts.length < 2 || !this.map || z < ARROW_MIN_ZOOM) return;
      const N = naver.maps, g = arrowGeom(pts, z, this._arrowTi), P = (q) => new N.LatLng(q.lat, q.lng);
      this._arrowShown = g.pts; this._arrowSpan = g.span;
      const line = (w, c, z) => new N.Polyline({ map: this.map, path: g.shaft.map(P), strokeColor: c, strokeWeight: w, strokeOpacity: 1,
        strokeLineCap: 'round', strokeLineJoin: 'round', zIndex: z, clickable: false });
      const head = (tri, c, z) => new N.Polygon({ map: this.map, paths: [tri.map(P)], fillColor: c, fillOpacity: 1, strokeColor: c, strokeOpacity: 1,
        strokeWeight: 1, zIndex: z, clickable: false });
      const H = ARROW_PX, RIM = this._arrowColor || ROUTE_BASE;
      this._arrowObjs.push(line(H.shaft * g.sc, RIM, 70), head(g.headOut, RIM, 70), line(H.inner * g.sc, '#ffffff', 71), head(g.headIn, '#ffffff', 71));
    },
    setDest(d, end) {
      const N = naver.maps;
      (this.destMk || []).forEach((m) => m.setMap(null));
      this.destMk = [];
      if (!d || !this.map) return;
      destDots(end, d).forEach((q) => this.destMk.push(new N.Marker({ position: new N.LatLng(q.lat, q.lng), map: this.map, clickable: false, zIndex: 94,
        icon: { content: dotEl(), anchor: new N.Point(4, 4) } })));
      // 도착 핀은 카메라·방지턱·휴게소·주정차 표지보다 늘 위 (2026-11-14: 명동역 '50' 카메라 표지가 핀을 덮었다)
      this.destMk.push(new N.Marker({ position: new N.LatLng(d.lat, d.lng), map: this.map, clickable: false, zIndex: 300,
        icon: { content: destPinEl(), anchor: new N.Point(17, 33) } }));
    },
    // 주정차 단속 카메라: 작은 주정차 금지 표지
    setParks(list) {
      const N = naver.maps;
      if (!this.parks) this.parks = new Map();
      const keep = new Set(list.map((x) => x.k));
      this.parks.forEach((m, k) => { if (!keep.has(k)) { m.setMap(null); this.parks.delete(k); } });
      list.forEach((x) => {
        if (this.parks.has(x.k)) return;
        this.parks.set(x.k, new N.Marker({
          position: new N.LatLng(x.lat, x.lng), map: this.map, clickable: false, zIndex: 85,
          icon: { content: parkEl(), anchor: new N.Point(9, 9) },
        }));
      });
    },
    destroy() {
      if (this.cams) this.cams.forEach((m) => m.setMap(null));
      if (this.bumps) this.bumps.forEach((m) => m.setMap(null));
      if (this.parks) this.parks.forEach((m) => m.setMap(null));
      this.parks = new Map();
      (this.destMk || []).forEach((m) => m.setMap(null)); this.destMk = [];
      (this.restMk || []).forEach((m) => m.setMap(null)); this.restMk = [];
      (this._arrowObjs || []).forEach((o) => o.setMap(null)); this._arrowObjs = []; this._arrow = null;
      this.cams = new Map(); this.bumps = new Map();
      this.clearRoute();
      if (this.map) this.map.destroy();
      this.map = null; this.marker = null;
    },
  };

  const LeafletAdapter = {
    drawAlts(list) {
      (this.alts || []).forEach((l) => l.remove());
      this.alts = (list || []).map((pts) => L.polyline(pts.map((p) => [p.lat, p.lng]), {
        color: ALT_LINE.color, weight: ALT_LINE.weight, opacity: ALT_LINE.opacity, lineCap: 'round', lineJoin: 'round', interactive: false,
      }).addTo(this.map));
    },
    async init(el, c) {
      await loadCss(LEAFLET_CSS);
      if (!window.L) await loadScript(LEAFLET_JS);
      this.cams = new Map();
      this.route = null;
      this.map = L.map(el, { zoomControl: false }).setView([c.lat, c.lng], 17);
      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19, attribution: '&copy; OpenStreetMap',
      }).addTo(this.map);
      this.marker = null;
      this.map.on('dragstart', onUserPan);
      this.map.on('zoomend', () => this.drawArrow());
    },
    setMe(lat, lng) {
      if (this.marker) { this.marker.setLatLng([lat, lng]); return; }
      this.marker = L.marker([lat, lng], {
        icon: L.divIcon({ html: meEl, className: 'me-wrap', iconSize: [56, 56], iconAnchor: [28, 28] }),
        interactive: false, keyboard: false, zIndexOffset: 1000,
      }).addTo(this.map);
    },
    center(lat, lng, jump) {
      if (jump) this.map.setView([lat, lng], this.map.getZoom(), { animate: false });
      else this.map.panTo([lat, lng], { animate: true, duration: 0.9 });
    },
    zoomBy(d) { this.map.setZoom(this.map.getZoom() + d); },
    getZoom() { return this.map.getZoom(); },
    setZoom(z) { this.map.setZoom(z); },
    setInteract(on) {
      ['dragging', 'touchZoom', 'scrollWheelZoom', 'doubleClickZoom'].forEach((k) => { if (this.map[k]) this.map[k][on ? 'enable' : 'disable'](); });
    },
    panPx(dx, dy) { this.map.panBy([dx, dy], { animate: false }); },
    getCenter() { const c = this.map.getCenter(); return { lat: c.lat, lng: c.lng }; },
    coordAt(px, py) { const c = this.map.containerPointToLatLng([px, py]); return { lat: c.lat, lng: c.lng }; },
    stop() { this.map.stop(); },
    resize() {
      const c = this.map.getCenter();
      this.map.invalidateSize({ pan: false });
      this.map.setView(c, this.map.getZoom(), { animate: false });
    },
    drawRoute(pts, sections) {
      this.clearRoute();
      const disp = roundRoute(pts);
      const path = disp.pts.map((p) => [p.lat, p.lng]);
      this.routePath = path; this.disp = disp;
      // Leaflet 은 나중에 더한 선이 위에 그려지므로 빛 번짐 → 본선 → 교통색 → 가운데 빛 → 흰 점 순서(routePieces 순서)를 지킨다
      this.route = routePieces(pts.length, sections).map((pc) => {
        const st = ROUTE_STYLE[pc.kind];
        pc.line = L.polyline(path.slice(disp.first[pc.a], disp.last[pc.b] + 1), {
          color: pc.color, weight: st[0], opacity: st[1], lineCap: 'round', lineJoin: 'round', interactive: false,
          dashArray: pc.kind === 'dots' ? '0 ' + DOT_PERIOD_PX : null,
        }).addTo(this.map);
        pc.st = 'full';
        return pc;
      });
    },
    trimRoute(at, atDot) {
      if (!this.route || !this.routePath) return;
      const map = this.map;
      trimPieces(this.route, this.routePath, this.disp, at, {
        hide: (pc) => pc.line.remove(),
        show: (pc) => { // 다시 보일 때 겹침 순서를 되돌린다 (차가 잠깐 뒤로 잡힌 경우)
          pc.line.addTo(map);
          if (pc.kind === 'glow') pc.line.bringToBack(); else if (pc.kind !== 'base') pc.line.bringToFront();
        },
        setPath: (pc, p) => pc.line.setLatLngs(p), point: (q) => [q.lat, q.lng],
      }, atDot);
    },
    mpp() { return 156543.03392 * Math.cos(toRad(this.map.getCenter().lat)) / Math.pow(2, this.map.getZoom()); },
    clearRoute() {
      if (this.route) this.route.forEach((pc) => pc.line.remove());
      this.route = null; this.routePath = null; this.disp = null;
    },
    fit(pts) {
      this.map.fitBounds(L.latLngBounds(pts.map((p) => [p.lat, p.lng])), {
        paddingTopLeft: [60, 110], paddingBottomRight: [110, 210],
      });
    },
    setCameras(list) {
      const keep = new Set(list.map((x) => x.i));
      this.cams.forEach((m, i) => { if (!keep.has(i)) { m.remove(); this.cams.delete(i); } });
      list.forEach((x) => {
        if (this.cams.has(x.i)) return;
        this.cams.set(x.i, L.marker([x.c[0], x.c[1]], {
          icon: L.divIcon({ html: camEl(x.c), className: 'me-wrap', iconSize: [30, 30], iconAnchor: [15, 15] }),
          interactive: false, keyboard: false,
        }).addTo(this.map));
      });
    },
    setBumps(list) {
      if (!this.bumps) this.bumps = new Map();
      const keep = new Set(list.map((x) => x.k));
      this.bumps.forEach((m, k) => { if (!keep.has(k)) { m.remove(); this.bumps.delete(k); } });
      list.forEach((x) => {
        if (this.bumps.has(x.k)) return;
        this.bumps.set(x.k, L.marker([x.lat, x.lng], {
          icon: L.divIcon({ html: bumpEl(), className: 'me-wrap', iconSize: [22, 20], iconAnchor: [11, 10] }),
          interactive: false, keyboard: false,
        }).addTo(this.map));
      });
    },
    setRests(list) {
      (this.restMk || []).forEach((m) => m.remove());
      this.restMk = (list || []).map((x) => L.marker([x.lat, x.lng], {
        icon: L.divIcon({ html: '<div class="restmk">' + REST_SVG + '</div>', className: 'me-wrap', iconSize: [24, 24], iconAnchor: [12, 12] }),
        interactive: false, keyboard: false,
      }).addTo(this.map));
    },
    setTurnArrow(pts, ti, color) { this._arrow = pts; this._arrowTi = ti; this._arrowColor = color; this.drawArrow(); },
    drawArrow() {
      (this._arrowObjs || []).forEach((o) => o.remove());
      this._arrowObjs = []; this._arrowShown = null;
      const pts = this._arrow, z = this.map && this.map.getZoom();
      if (!pts || pts.length < 2 || !this.map || z < ARROW_MIN_ZOOM) return;
      const g = arrowGeom(pts, z, this._arrowTi), P = (q) => [q.lat, q.lng];
      this._arrowShown = g.pts; this._arrowSpan = g.span;
      const line = (w, c) => L.polyline(g.shaft.map(P), { color: c, weight: w, opacity: 1, lineCap: 'round', lineJoin: 'round', interactive: false }).addTo(this.map);
      const head = (tri, c) => L.polygon(tri.map(P), { color: c, weight: 1, fillColor: c, fillOpacity: 1, interactive: false }).addTo(this.map);
      const H = ARROW_PX, RIM = this._arrowColor || ROUTE_BASE;
      this._arrowObjs.push(line(H.shaft * g.sc, RIM), head(g.headOut, RIM), line(H.inner * g.sc, '#ffffff'), head(g.headIn, '#ffffff'));
    },
    setDest(d, end) {
      (this.destMk || []).forEach((m) => m.remove());
      this.destMk = [];
      if (!d || !this.map) return;
      destDots(end, d).forEach((q) => this.destMk.push(L.marker([q.lat, q.lng], {
        icon: L.divIcon({ html: '<div class="destdot"></div>', className: 'me-wrap', iconSize: [8, 8], iconAnchor: [4, 4] }), interactive: false, keyboard: false,
      }).addTo(this.map)));
      this.destMk.push(L.marker([d.lat, d.lng], {
        icon: L.divIcon({ html: destPinEl().outerHTML, className: 'me-wrap', iconSize: [34, 34], iconAnchor: [17, 33] }), interactive: false, keyboard: false, zIndexOffset: 2000,
      }).addTo(this.map));
    },
    setParks(list) {
      if (!this.parks) this.parks = new Map();
      const keep = new Set(list.map((x) => x.k));
      this.parks.forEach((m, k) => { if (!keep.has(k)) { m.remove(); this.parks.delete(k); } });
      list.forEach((x) => {
        if (this.parks.has(x.k)) return;
        this.parks.set(x.k, L.marker([x.lat, x.lng], {
          icon: L.divIcon({ html: PARK_SVG, className: 'me-wrap parkmk', iconSize: [18, 18], iconAnchor: [9, 9] }),
          interactive: false, keyboard: false,
        }).addTo(this.map));
      });
    },
    destroy() {
      this.clearRoute();
      if (this.map) this.map.remove();
      this.map = null; this.marker = null; this.cams = new Map(); this.bumps = new Map(); this.parks = new Map();
      this.destMk = []; this._arrowObjs = []; this._arrow = null; this.restMk = [];
    },
  };

  let mapA = null;
  async function useMap(adapter) {
    if (mapA) { try { mapA.destroy(); } catch (e) { /* 무시 */ } mapA = null; }
    const host = $('#map');
    host.querySelectorAll('.mapcanvas').forEach((n) => n.remove());
    const el = document.createElement('div');
    el.className = 'mapcanvas';
    host.prepend(el);
    await adapter.init(el, state.fix || DEFAULT_CENTER);
    mapA = adapter;
    if (state.fix) { const p = mePos(); mapA.setMe(p.lat, p.lng); }
    if (nav.pts) {
      mapA.drawRoute(nav.pts, nav.route && nav.route.sections);
      if (nav.onRoute) { nav.drawnAt = 0; drawRemaining(); }
      if (mapA.setDest && nav.dest) mapA.setDest(nav.dest, nav.pts[nav.pts.length - 1]);
      nav.arrowKey = null; restState.key = '';
    }
    camState.markerAt = null;
    if (state.fix) refreshCamMarkers(state.fix);
    layoutView(true);
  }

  // ---------- 주행 화면 (진행 방향이 위, 차는 화면 아래쪽, 3D 기울기) ----------
  // 네이버 래스터 지도는 회전이 안 되므로 지도 캔버스를 차 위치(회전 중심)를 가운데로 하는
  // 큰 정사각형으로 키우고 CSS transform 으로 돌리고 기울인다. 크기는 어느 각도에서도 화면을 덮도록 계산.
  const VIEW_TILT = 22, VIEW_PERSP = 1400, VIEW_PIVOT = 0.7, VIEW_MARGIN = 32;
  const GL_TILT = 40; // GL 지도 기울기 (도)
  // GL 지도 회전·기울기를 매 프레임 조금씩 목표로 (1초에 한 번 오는 방향이 툭툭 끊기지 않게)
  const glView = { rot: 0, tilt: 0, tRot: 0, tTilt: 0, raf: 0, last: 0 };
  function glAim(rot, tilt) {
    glView.tRot = glView.rot + turn(rot - glView.rot);
    glView.tTilt = tilt;
    if (!glView.raf) { glView.last = performance.now(); glView.raf = requestAnimationFrame(glStep); }
  }
  function glStep(now) {
    const dt = Math.min(0.1, Math.max(0, (now - glView.last) / 1000));
    glView.last = now;
    const k = 1 - Math.exp(-dt / 0.3);
    glView.rot += (glView.tRot - glView.rot) * k;
    glView.tilt += (glView.tTilt - glView.tilt) * k;
    const done = Math.abs(glView.tRot - glView.rot) < 0.05 && Math.abs(glView.tTilt - glView.tilt) < 0.05;
    if (done) { glView.rot = glView.tRot; glView.tilt = glView.tTilt; }
    if (mapA && mapA.gl) {
      mapA.setView(turn(glView.rot), glView.tilt);
      if (state.heading !== null) rotateMe(state.heading - glView.rot); // 내 차 화살표는 지도가 돈 만큼 덜 돌린다
    }
    glView.raf = done ? 0 : requestAnimationFrame(glStep);
  }
  const glOn = () => !!(mapA && mapA.gl);
  const view = { drive: false, key: '', rot: 0, w: 0, h: 0, cs: 0, cx: 0, cy: 0, tilt: 0 };

  function wantDrive() {
    return !!((state.following || state.peek) && prefs.headingUp && state.heading !== null && !nav.preview && !state.stopNorth);
  }
  // 멈춤 판단: 시속 3km 아래로 3초 넘게 있으면 북쪽 위로, 다시 시속 8km 를 넘으면 진행 방향 위로 (서고 가는 사이 흔들리지 않게 차이를 둔다)
  function checkStopNorth(now) {
    let want = state.stopNorth;
    if (!prefs.stopNorth || !prefs.headingUp || glOn()) want = false; // GL 지도는 돌려도 글자가 똑바로라 멈춰도 그대로
    else if (state.speedKmh >= 8) { state.stillAt = 0; want = false; }
    else if (state.speedKmh < 3) {
      if (!state.stillAt) state.stillAt = now;
      if (now - state.stillAt >= 3000) want = true;
    }
    if (want !== state.stopNorth) { state.stopNorth = want; layoutView(); }
  }
  function measureView() {
    const host = $('#map');
    view.w = host.clientWidth; view.h = host.clientHeight;
  }
  function setViewRot() {
    view.rot += turn(-state.heading - view.rot); // 누적 각도: 350°→10° 에서 한 바퀴 돌지 않게
    if (glOn()) { glAim(-view.rot, view.tilt); return; } // GL: 지도 자체를 돌린다 (글자는 똑바로)
    const s = $('#map').style, r = Math.round(view.rot * 100) / 100;
    s.setProperty('--rot', r + 'deg');
    s.setProperty('--crot', -r + 'deg'); // 카메라 마커 숫자는 똑바로
  }
  // 반환값: 차 위치로 지도를 바로 옮겼으면 true
  function layoutView(force) {
    const host = $('#map'), canvas = host.querySelector('.mapcanvas');
    if (force || !view.w) measureView();
    const w = view.w, h = view.h, drive = wantDrive(), gl = glOn();
    let cs = 0, cy = h / 2, tilt = 0;
    if (drive && gl) {
      // GL: 캔버스는 돌리지 않고 아래로 길게(가운데 = 화면 70% 높이, 차 위치) 두고 지도 자체를 돌리고 기울인다
      cy = Math.round(h * VIEW_PIVOT);
      tilt = prefs.tilt ? GL_TILT : 0;
    } else if (drive) {
      cy = Math.round(h * VIEW_PIVOT);
      tilt = prefs.tilt ? VIEW_TILT : 0;
      // 기울였을 때 화면 맨 위에 보이는 지점까지의 거리 yC 와 그 지점에서 필요한 반폭 xC
      let yC = cy, xC = w / 2;
      if (tilt) {
        const t = toRad(tilt), den = VIEW_PERSP * Math.cos(t) - cy * Math.sin(t);
        if (den > VIEW_PERSP * 0.25) {
          yC = cy * VIEW_PERSP / den;
          xC = (w / 2) * (VIEW_PERSP + yC * Math.sin(t)) / VIEW_PERSP;
        } else tilt = 0; // 화면이 너무 길면 기울이지 않는다
      }
      cs = 2 * Math.ceil(Math.hypot(Math.max(xC, w / 2), Math.max(yC, h - cy)) + VIEW_MARGIN);
    }
    const key = (drive ? [w, h, cs, cy, tilt].join() : w + 'x' + h) + (gl ? ':gl' : '');
    const wasDrive = view.drive;
    if (!force && drive === wasDrive && key === view.key) {
      if (drive) setViewRot();
      return false;
    }
    // 주행 화면 안에서 크기만 바뀌면 애니메이션 없이 (들어올 때는 돌아가며 기울어지게 둔다)
    const snap = drive && wasDrive;
    if (snap) host.classList.add('snap');
    Object.assign(view, { drive, key, cs, cx: w / 2, cy, tilt });
    if (drive && gl) {
      host.style.setProperty('--gh', 2 * cy + 'px');
      if (!wasDrive) view.rot = turn(-state.heading);
      setViewRot();
    } else if (drive) {
      const s = host.style;
      s.setProperty('--cl', Math.round(w / 2 - cs / 2) + 'px');
      s.setProperty('--ct', Math.round(cy - cs / 2) + 'px');
      s.setProperty('--cs', cs + 'px');
      s.setProperty('--tilt', tilt + 'deg');
      s.setProperty('--persp', VIEW_PERSP + 'px');
      if (!wasDrive) view.rot = turn(-state.heading); // 들어올 때는 반 바퀴 이내로만 돈다
      setViewRot();
    }
    host.classList.toggle('drive', drive);
    host.classList.toggle('gl', gl);
    if (gl && !drive) glAim(0, 0); // 평면 지도: 북쪽 위, 기울기 없음
    if (mapA && mapA.setInteract) { try { mapA.setInteract(!drive); } catch (e) { /* 다음 배치 때 다시 */ } }
    let jumped = false;
    if (mapA && mapA.resize && w && h) {
      // 지도 라이브러리가 캔버스에 직접 넣은 크기는 지우고 CSS 크기를 따르게 한다
      const clear = () => { if (canvas) { canvas.style.width = ''; canvas.style.height = ''; } };
      clear();
      try { mapA.resize(drive ? (gl ? w : cs) : w, drive ? (gl ? 2 * cy : cs) : h); } catch (e) { /* 다음 배치 때 다시 */ }
      clear();
      if (state.fix && !state.peek && (drive || wasDrive || state.following)) { // 앞길을 보는 중이면 보던 자리 그대로
        const p = mePos();
        mapA.center(p.lat, p.lng, true);
        jumped = true;
      }
    }
    if (snap) { void host.offsetWidth; host.classList.remove('snap'); }
    return jumped;
  }
  let layoutQueued = 0;
  function queueLayout() {
    if (layoutQueued) return;
    layoutQueued = requestAnimationFrame(() => { layoutQueued = 0; measureView(); layoutView(); });
  }

  // 주행 화면에서는 지도가 화면보다 커서 지도 자체의 로고·저작권 표시가 화면 밖으로 나가므로 따로 띄운다
  const attrib = document.createElement('div');
  attrib.className = 'attrib';
  $('#map').appendChild(attrib);
  function setSource(text, warn) {
    const b = $('#source');
    b.textContent = text;
    b.classList.toggle('warn', !!warn);
    b.hidden = !warn; // 정상(네이버 지도)일 때는 숨기고, 테스트 지도·오류일 때만 보인다
    updateAttrib();
  }
  // 주행 화면(지도를 돌린 화면)에서는 네이버 출처 표시가 화면 밖으로 밀리므로 같은 문구를 따로 띄운다
  function updateAttrib() {
    attrib.textContent = mapA === NaverAdapter ? '© NAVER Corp. /국토교통부' + (prefs.traffic ? ' /경찰청(UTIC)' : '')
      : (mapA ? '© OpenStreetMap contributors' : '');
  }

  let fallbackStarted = false;
  async function fallbackMap(reason) {
    if (reason) toast(reason, 'bad', 10000);
    if (fallbackStarted) return; // 인증 실패 콜백과 로드 실패가 겹쳐도 한 번만 전환
    fallbackStarted = true;
    try {
      await useMap(LeafletAdapter);
      setSource('테스트 지도 (OpenStreetMap) · 설정에서 네이버 키 입력', true);
    } catch (e) {
      setSource('지도를 불러오지 못했습니다', true);
    }
  }

  // 네이버 지도 스크립트가 인증 실패 시 호출하는 전역 함수
  let naverFailed = false;
  window.navermap_authFailure = function () {
    if (naverFailed) return;
    naverFailed = true;
    report('warn', { msg: 'naver map auth failure' });
    fallbackMap('네이버 지도 인증 실패: Client ID와 Web 서비스 URL(' + location.origin + ') 등록을 확인하세요.');
  };

  // 길안내 서버에서 지도 키를 받는다. 통신이 잠깐 끊겨도 네이버 지도가 테스트 지도로 떨어지지 않게
  // 몇 번 다시 시도하고, 그래도 안 되면 마지막으로 받았던 키를 쓴다.
  async function fetchMapKey() {
    for (let i = 0; i < 3; i++) {
      try {
        const ctrl = new AbortController();
        const to = setTimeout(() => ctrl.abort(), 6000);
        const r = await fetch(proxyUrl() + '/config', { cache: 'no-store', signal: ctrl.signal });
        clearTimeout(to);
        if (r.ok) {
          const k = String((await r.json()).mapKeyId || '').trim();
          if (k) { store.set('keyCache', k); return k; }
          return store.get('keyCache') || '';
        }
      } catch (e) { /* 잠시 뒤 다시 */ }
      await new Promise((res) => setTimeout(res, 1500 * (i + 1)));
    }
    report('warn', { msg: 'map key fetch failed' + (store.get('keyCache') ? ' (using cached key)' : '') });
    return store.get('keyCache') || '';
  }

  // WebGL 을 쓸 수 있는지 (벡터 지도)
  function webglOk() {
    try { const c = document.createElement('canvas'); return !!(c.getContext('webgl2') || c.getContext('webgl')); } catch (e) { return false; }
  }
  // 지금 지도를 GL 로 만들지: 설정이 켜져 있고, GL 서브모듈이 와 있고, WebGL 이 되면
  let glBroken = false; // 이번 실행 중 WebGL 이 끊긴 적이 있으면 그림(래스터) 지도로
  function glWanted() {
    const N = window.naver && naver.maps;
    if (!prefs.gl || glBroken || !N || !N.jsContentLoaded || !webglOk()) return false;
    try { return typeof N.glEnabled === 'function' ? !!N.glEnabled() : N.glEnabled !== false; } catch (e) { return false; }
  }
  try { performance.setResourceTimingBufferSize(2000); } catch (e) { /* 지원 안 함 */ } // GL 스타일 주소를 찾을 때 쓴다

  async function bootMap() {
    // 설정에 직접 넣은 키가 우선. 없으면 길안내 서버에서 받는다 (저장 안 함: 서버에서 바꾸면 바로 반영)
    let key = store.get('key');
    if (!key) key = await fetchMapKey();
    if (!key) { await fallbackMap(null); return; }
    try {
      // GL(벡터) 서브모듈도 같이 받는다. 실제로 GL 로 그릴지는 지도를 만들 때 정한다 (설정·WebGL 지원)
      const wantGl = webglOk();
      await loadScript('https://oapi.map.naver.com/openapi/v3/maps.js?ncpKeyId=' + encodeURIComponent(key) + (wantGl ? '&submodules=gl' : ''));
      if (!(window.naver && naver.maps && naver.maps.Map)) throw new Error('naver.maps missing');
      // 서브모듈은 maps.js 뒤에 따로 내려온다. 8초 안에 안 오면 래스터 지도로
      if (wantGl && !naver.maps.jsContentLoaded) {
        await new Promise((res) => {
          const prev = naver.maps.onJSContentLoaded;
          naver.maps.onJSContentLoaded = () => { try { if (prev) prev(); } catch (e) { /* 무시 */ } res(); };
          setTimeout(res, 8000);
        });
      }
      if (naverFailed) return;
      await useMap(NaverAdapter);
      setSource('네이버 지도', false);
    } catch (e) {
      if (!naverFailed) await fallbackMap('네이버 지도 스크립트를 불러오지 못했습니다. 네트워크나 키를 확인하세요.');
    }
  }

  // ---------- 길안내 서버 ----------
  async function api(path, query, body, timeoutMs) {
    const u = new URL(proxyUrl() + path);
    Object.keys(query || {}).forEach((k) => u.searchParams.set(k, query[k]));
    const ctrl = new AbortController();
    const to = setTimeout(() => ctrl.abort(), timeoutMs || 12000);
    try {
      const r = await fetch(u.toString(), body ? {
        method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' }, signal: ctrl.signal,
      } : { signal: ctrl.signal });
      let j = {};
      try { j = await r.json(); } catch (e) { /* 빈 응답 */ }
      if (!r.ok) {
        const err = new Error(j.message || j.error || ('HTTP ' + r.status));
        err.detail = j; err.status = r.status;
        throw err;
      }
      return j;
    } finally { clearTimeout(to); }
  }

  // ---------- 단속 카메라 ----------
  const cams = { rows: null, grid: null, date: '', loaded: false };
  const CELL = 0.01;
  // ---------- 과속방지턱 (전국 과속방지턱 표준데이터, data/bumps.json) ----------
  // 길안내 중이면 경로 10m 안의 방지턱을, 아니면 진행 방향 바로 앞(120m, 좌우 8m)의 방지턱을 200m 앞부터 알린다.
  // 지도에는 길안내 중 앞쪽 1.5km 안, 아니면 앞쪽 300m 안의 방지턱을 작은 삼각 표지로
  const bumps = { loaded: false, n: 0, lat: null, lng: null, flag: null, road: null, names: [''], grid: new Map(), date: '' };
  const bumpState = { next: null, markerAt: null, markerKey: '' };
  const BUMP_ALERT = 200, BUMP_ROUTE_M = 10;
  async function loadBumps() {
    try {
      const r = await fetch('data/bumps.json?v=' + APP_VERSION);
      if (!r.ok) return;
      const j = await r.json(), n = j.count, sc = j.scale || 1e5, d = j.d, v2 = (j.v || 1) >= 2;
      // v2: 셋째 값 = 도로 이름 번호 x 2 + 연속형 (tools/build_bumps.py)
      const lat = new Float64Array(n), lng = new Float64Array(n), flag = new Uint8Array(n), road = new Int32Array(n);
      let a = 0, b = 0;
      for (let k = 0; k < n; k++) {
        a += d[3 * k]; b += d[3 * k + 1];
        lat[k] = a / sc; lng[k] = b / sc;
        const x = d[3 * k + 2];
        flag[k] = v2 ? x & 1 : x; road[k] = v2 ? x >> 1 : 0;
        const key = Math.floor(lat[k] * 100) + ':' + Math.floor(lng[k] * 100);
        let cell = bumps.grid.get(key);
        if (!cell) bumps.grid.set(key, cell = []);
        cell.push(k);
      }
      Object.assign(bumps, { n, lat, lng, flag, road, names: (v2 && j.names) || [''], date: j.date || '', loaded: true });
    } catch (e) { /* 방지턱 데이터가 없어도 나머지는 그대로 */ }
  }
  function bumpsNear(la, ln, r) {
    const out = [], cy = Math.floor(la * 100), cx = Math.floor(ln * 100);
    const sy = Math.ceil(r / 1100), sx = Math.ceil(r / 880);
    for (let y = cy - sy; y <= cy + sy; y++) for (let x = cx - sx; x <= cx + sx; x++) {
      const cell = bumps.grid.get(y + ':' + x);
      if (!cell) continue;
      for (const k of cell) {
        const d = haversine({ lat: la, lng: ln }, { lat: bumps.lat[k], lng: bumps.lng[k] });
        if (d <= r) out.push({ k, d });
      }
    }
    return out;
  }
  // 길안내 경로 위 방지턱 (경로 거리순). 카메라처럼 앞쪽 4km 까지만 찾아 두고 달리면서 늘린다
  // ---------- 일반도로 자료(과속방지턱·주의 표지)가 '내가 달리는 그 도로' 것인지 (2026-11-14 다시 설계) ----------
  // 거리만 보면 옆 골목·교차로의 가로 도로·고가(고속도로) 밑 도로의 자료가 섞인다. 사용자: '근처'가 아니라 '내 길'의 데이터인지를 봐야 한다.
  // 실제 경로 점검(하남·송파·판교 경로 40여 개): 경로선 10m 안의 방지턱 189개 중 도로 이름이 같은 것 43, 다른 것 146
  // (덕풍공원로 경로의 덕풍북로·덕풍북로71번길 골목, 수도권제1순환고속도로 밑 거마로7길·오금로57길은 경로선 0.1m 에도 있었다).
  //   1) 고속도로 구간(안내상 진입~출구, 또는 구간 이름이 고속도로)에서는 일반도로 자료를 쓰지 않는다 (지자체 자료라 고속도로 위에는 없다)
  //   2) 자료의 도로 이름이 그 지점 앞뒤의 경로 도로 이름(길찾기 구간 이름 + 앞뒤 40m 안 안내 문구의 도로 이름) 중 하나와 같으면 내 길,
  //      다 다르면 아님. 'OO로12번길'은 'OO로'와 다른 길
  //   3) 경로 쪽 이름을 모르면, 그 지점까지 다음 안내가 없을 때(지금 도로가 이어질 때) 지금 달리는 도로 이름(역지오코딩)과 비교
  //   4) 그래도 모르면 거리로 (곧은 길 10m, 모퉁이 근처 5m)
  const streetKey = (s) => String(s || '').replace(/\s+/g, '');
  function sameStreet(a, b) {
    const x = streetKey(a), y = streetKey(b);
    if (!x || !y) return false;
    if (x === y) return true;
    if (/\d+(번)?길$/.test(x) || /\d+(번)?길$/.test(y)) return false;
    return x.indexOf(y) >= 0 || y.indexOf(x) >= 0;
  }
  const STREET = /^[가-힣][가-힣0-9]*(?:대로|로|길)(?:\d+(?:번)?길)?$/;
  const NOT_STREET = /(교차로|사거리|삼거리|오거리|으로)$/;
  // 경로 at(m) 지점 앞뒤의 도로 이름들
  function routeNamesAt(at) {
    const names = [], last = nav.cum.length - 1;
    for (const s of (nav.route && nav.route.sections) || []) {
      const a = nav.cum[Math.min(s.i, last)], b = nav.cum[Math.min(s.i + Math.max(1, s.n) - 1, last)];
      if (s.name && b >= at - 30 && a <= at + 30) names.push(s.name);
    }
    for (const g of nav.guides || []) {
      if (Math.abs(nav.cum[Math.min(g.i, last)] - at) > 40) continue;
      // 안내 문구의 '…' 안 이름과 'X에서'의 X 중 도로 이름 꼴인 것 ("'덕풍공원로99번길' 방면으로 좌회전")
      const t = String(g.s || '');
      const parts = (t.match(/'[^']*'/g) || []).join(',').replace(/'/g, '').split(/[,\s]+/);
      const m = t.match(/^\s*(\S+?)에서/);
      if (m) parts.push(m[1]);
      for (const x of parts) if (STREET.test(x) && !NOT_STREET.test(x)) names.push(x);
    }
    return names;
  }
  const onHighwayRoute = (at) => onHighwayAt(at) || routeNamesAt(at).some((x) => /고속도로|고속국도/.test(x));
  // 'no' 내 길 아님 · 'yes' 이름까지 같은 내 길 · 'maybe' 이름으로는 모름
  function localOnRoute(at, pn) {
    if (onHighwayRoute(at)) return 'no';
    if (!specificRoad(pn)) return 'maybe';
    const rn = routeNamesAt(at).filter(specificRoad);
    if (!rn.length) return 'maybe';
    return rn.some((x) => sameStreet(x, pn)) ? 'yes' : 'no';
  }
  // 이름으로 모르는(maybe) 자료를 알릴 때: 그 지점 전에 다음 안내가 없으면 지금 달리는 도로 이름과 같아야 한다
  function liveRoadSays(at, pn) {
    if (!specificRoad(road.name) || !specificRoad(pn)) return true;
    const ng = nav.next && nav.cum ? nav.cum[Math.min(nav.next.i, nav.cum.length - 1)] : Infinity;
    if (ng < at) return true;
    return sameStreet(road.name, pn);
  }
  // 길안내 없이 달릴 때: 지금 도로 이름과 자료의 도로 이름이 둘 다 구체적인데 다르면 아님
  const freeRoadOk = (pn) => !(specificRoad(road.name) && specificRoad(pn) && !sameStreet(road.name, pn));
  const bumpRoad = (k) => (bumps.road ? bumps.names[bumps.road[k]] : '') || '';
  // 경로 위 s(m) 지점의 좌표, 그 지점 앞뒤 30m 사이 진행 방향이 몇 도 꺾이는지
  function routePointAt(s) {
    const P = nav.pts, C = nav.cum;
    let lo = 0, hi = C.length - 1;
    s = Math.max(0, Math.min(s, C[hi]));
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (C[m] <= s) lo = m; else hi = m; }
    const L = C[hi] - C[lo], k = L > 0 ? (s - C[lo]) / L : 0;
    return { lat: P[lo].lat + (P[hi].lat - P[lo].lat) * k, lng: P[lo].lng + (P[hi].lng - P[lo].lng) * k };
  }
  function routeTurnAt(s) {
    const a = routePointAt(s - 30), b = routePointAt(s), c = routePointAt(s + 30);
    if (haversine(a, b) < 5 || haversine(b, c) < 5) return 0;   // 경로 처음·끝
    return angleDiff(bearing(a, b), bearing(b, c));
  }
  function ensureRouteBumps() {
    if (!bumps.loaded || !nav.pts || nav.pts.length < 2) return false;
    if (!nav.routeBumps) { nav.routeBumps = []; nav.bumpSeen = new Set(); nav.bumpUpto = 0; }
    const pts = nav.pts, want = nav.along + 4000;
    let i = nav.bumpUpto, added = false;
    for (; i < pts.length - 1 && nav.cum[i] < want; i++) {
      const a = pts[i], b = pts[i + 1], half = (nav.cum[i + 1] - nav.cum[i]) / 2;
      for (const it of bumpsNear((a.lat + b.lat) / 2, (a.lng + b.lng) / 2, half + 15)) {
        if (nav.bumpSeen.has(it.k)) continue;
        const pr = projectSeg({ lat: bumps.lat[it.k], lng: bumps.lng[it.k] }, a, b);
        if (pr.dist > BUMP_ROUTE_M + 2) continue;
        const at = nav.cum[i] + pr.t * (nav.cum[i + 1] - nav.cum[i]);
        // 내 길의 방지턱인지 (위 '일반도로 자료'). 이름이 같은 내 길이면 12m 까지(넓은 길), 이름으로 모르면 10m 까지,
        // 그리고 경로가 꺾이는 곳(앞뒤 30m 사이 진행 방향이 30° 넘게 바뀜)에서는 5m 까지 (2026-11-14 하남 덕풍동: 모퉁이 옆 골목 8.8m)
        const st = localOnRoute(at, bumpRoad(it.k));
        if (st === 'no') continue;
        if (st === 'maybe' && (pr.dist > BUMP_ROUTE_M || (pr.dist > 5 && routeTurnAt(at) > 30))) continue;
        nav.bumpSeen.add(it.k);
        nav.routeBumps.push({ k: it.k, at, st });
        added = true;
      }
    }
    nav.bumpUpto = i;
    if (added) nav.routeBumps.sort((x, y) => x.at - y.at);
    return true;
  }
  function evalBumps(f) {
    let next = null, markers = [];
    if (bumps.loaded && prefs.bumps) {
      if (nav.active && nav.pts && ensureRouteBumps()) {
        const ahead = nav.routeBumps.filter((b) => b.at > nav.along - 8 && b.at < nav.along + 1500 && (b.st !== 'maybe' || liveRoadSays(b.at, bumpRoad(b.k))));
        const first = ahead[0];
        if (first && first.at - nav.along <= BUMP_ALERT) {
          // 첫 방지턱부터 100m 안에 더 있으면 연속
          const series = ahead.filter((b) => b.at - first.at <= 100).length;
          next = { k: first.k, d: Math.max(0, first.at - nav.along), cont: series > 1 || bumps.flag[first.k] === 1 };
        }
        markers = ahead;
      } else if (state.heading !== null && state.speedKmh >= 8) {
        for (const it of bumpsNear(f.lat, f.lng, 300)) {
          const p = { lat: bumps.lat[it.k], lng: bumps.lng[it.k] };
          const diff = angleDiff(bearing(f, p), state.heading);
          if (it.d < 6 || diff > 20 || it.d * Math.sin(toRad(diff)) > 8 || !freeRoadOk(bumpRoad(it.k))) continue;
          markers.push(it);
          if (it.d <= 120 && (!next || it.d < next.d)) next = { k: it.k, d: it.d, cont: bumps.flag[it.k] === 1 };
        }
      }
    }
    bumpState.next = next;
    renderBump();
    // 지도 표시는 50m 움직일 때마다 (또는 목록이 바뀔 때) 다시 고른다
    if (mapA && mapA.setBumps) {
      const key = markers.map((x) => x.k).join(',');
      const moved = !bumpState.markerAt || haversine(bumpState.markerAt, f) > 50;
      if (key !== bumpState.markerKey && (moved || !markers.length)) {
        bumpState.markerAt = { lat: f.lat, lng: f.lng };
        bumpState.markerKey = key;
        mapA.setBumps(markers.slice(0, 60).map((x) => ({ k: x.k, lat: bumps.lat[x.k], lng: bumps.lng[x.k] })));
      }
    }
  }
  function renderBump() {
    const el = $('#bumpCard'), b = bumpState.next;
    el.hidden = !b;
    if (!b) return;
    $('#bumpLabel').textContent = b.cont ? '연속 과속방지턱' : '과속방지턱';
    $('#bumpDist').textContent = fmtDist(b.d);
  }
  // ---------- 고속도로 휴게소 (한국도로공사 휴게소 위치정보 202곳, data/rest.json · tools/build_rest.py, 2026-11-14 요청) ----------
  // 길안내 경로가 고속도로를 지날 때 그 옆 400m 안의 휴게소 중 내 진행 방향 쪽 것만 고른다: 우측 통행이라 경로 오른쪽
  // (이름에 방향이 없거나 '양방향'이면 양쪽에서 들를 수 있는 휴게소). 다음 휴게소가 30km 안이면 이름·거리와 그다음 휴게소를
  // 칸에 보여 주고, 지도에는 앞 20km 안의 휴게소를 작은 표지로
  const rest = { loaded: false, items: [] };
  const REST_NEAR = 400, REST_SHOW = 30000, REST_MAP = 20000;
  async function loadRest() {
    try {
      const r = await fetch('data/rest.json?v=' + APP_VERSION);
      if (!r.ok) return;
      setRestData(await r.json());
    } catch (e) { /* 데이터가 없어도 나머지는 그대로 */ }
  }
  function setRestData(j) {
    rest.items = ((j && j.items) || []).map((x) => ({ lat: x[0], lng: x[1], name: x[2], dir: x[3] || '', route: x[4] || '' }));
    rest.loaded = true;
    nav.routeRest = null;
  }
  function ensureRouteRest() {
    if (!rest.loaded || !nav.pts || nav.pts.length < 2) return [];
    if (nav.routeRest && nav.routeRestFor === nav.route) return nav.routeRest;
    const pts = nav.pts, cum = nav.cum;
    let s0 = 90, w0 = 180, n0 = -90, e0 = -180;
    for (const q of pts) { if (q.lat < s0) s0 = q.lat; if (q.lat > n0) n0 = q.lat; if (q.lng < w0) w0 = q.lng; if (q.lng > e0) e0 = q.lng; }
    const pad = 0.006, out = [];
    for (const r of rest.items) {
      if (r.lat < s0 - pad || r.lat > n0 + pad || r.lng < w0 - pad || r.lng > e0 + pad) continue;
      let best = null;
      for (let i = 0; i < pts.length - 1; i++) {
        const pr = projectSeg(r, pts[i], pts[i + 1]);
        if (!best || pr.dist < best.dist) best = { dist: pr.dist, i, t: pr.t };
      }
      if (!best || best.dist > REST_NEAR) continue;
      const both = !r.dir || /양방향/.test(r.dir);
      if (!both && sideOfSeg(r, pts[best.i], pts[best.i + 1], best.dist) < 0) continue; // 경로 왼쪽 = 반대 방향 휴게소
      const at = cum[best.i] + best.t * (cum[best.i + 1] - cum[best.i]);
      if (!(onHighwayAt(at) || /고속도로|고속국도/.test(routeRoadAt(best.i)))) continue; // 옆 일반도로를 지날 때는 아님
      out.push({ name: r.name, dir: r.dir, at, lat: r.lat, lng: r.lng });
    }
    out.sort((x, y) => x.at - y.at);
    // 같은 자리에 두 이름으로 올라 있는 곳(예: '기흥복합휴게소'와 '기흥휴게소(부산)')은 하나로: 방향이 적힌 쪽을 남긴다
    const merged = [];
    for (const r of out) {
      const prev = merged[merged.length - 1];
      const real = (x) => !!x.dir && x.dir !== '한쪽'; // '한쪽'은 이름에 방향이 없어 짝으로 미루어 본 것
      if (prev && r.at - prev.at < 600) { if (!real(prev) && real(r)) merged[merged.length - 1] = r; continue; }
      merged.push(r);
    }
    nav.routeRest = merged; nav.routeRestFor = nav.route;
    return merged;
  }
  const restState = { key: '' };
  function renderRest() {
    const el = $('#restCard');
    const list = nav.active && prefs.rest ? ensureRouteRest() : [];
    const ahead = list.filter((r) => r.at > nav.along + 30);
    const next = ahead[0];
    const show = !!next && next.at - nav.along <= REST_SHOW;
    el.hidden = !show;
    if (show) {
      $('#restName').textContent = next.name;
      $('#restDist').textContent = fmtDist(next.at - nav.along);
      const n2 = ahead[1];
      $('#restNext').textContent = n2 && n2.at - nav.along <= 100000 ? '다음 ' + n2.name.replace(/휴게소$/, '') + ' ' + fmtDist(n2.at - nav.along) : '';
    }
    if (mapA && mapA.setRests) {
      const marks = ahead.filter((r) => r.at - nav.along <= REST_MAP);
      const key = marks.map((r) => r.name + r.at).join('|');
      if (key !== restState.key) { restState.key = key; mapA.setRests(marks); }
    }
  }
  // ---------- 주정차 단속 카메라 (단속구분 4, data/parking.json · tools/build_parking.py, 2026-11-14 요청) ----------
  // 도심에는 아주 많아서 지나갈 때는 알리지 않고, 내 진행 방향 앞쪽에 있는 것만 본다 (2026-11-14 두 번째 요청).
  //   앞쪽: 길안내 중 경로 위면 경로에서 20m 안이고 경로상 앞, 아니면 진행 방향 ±35° 안이고 옆으로 15m 안.
  //   천천히(시속 30km 아래) 갈 때 앞 100m 안이면 '주정차 단속' 칸을 띄운다 (차를 세우려는 곳이 단속 구역인지). 소리 없음.
  //   10m 넘게 지나치거나 시속 40km 를 넘으면 내린다. 지도에는 시속 45km 아래일 때 앞 300m 안의 것만 작은 주정차 금지 표지로
  const parking = { loaded: false, n: 0, lat: null, lng: null, grid: new Map(), date: '' };
  const parkState = { near: null, markerAt: null, markerKey: '', h: null };
  const PARK_SHOW = 100, PARK_KEEP = 120, PARK_SLOW = 30, PARK_FAST = 40, PARK_MAP_KMH = 45, PARK_MAP_AHEAD = 300;
  // 2026-11-14 요청: 주정차 단속은 차를 세울 목적지 근처에서 필요한 자세한 정보. 길안내 중에는 가는 길 내내 띄우지 않고
  // 목적지까지 700m 안에 들어와서야 보여 준다(카드는 그대로 천천히 갈 때 앞쪽 것, 지도에는 앞쪽 것 + 목적지 둘레 250m 안의 것)
  const PARK_DEST_NEAR = 700, PARK_DEST_R = 250;
  async function loadParking() {
    try {
      const r = await fetch('data/parking.json?v=' + APP_VERSION);
      if (!r.ok) return;
      setParkingData(await r.json());
    } catch (e) { /* 데이터가 없어도 나머지는 그대로 */ }
  }
  function setParkingData(j) {
    const n = j.count, sc = j.scale || 1e5, d = j.d;
    const lat = new Float64Array(n), lng = new Float64Array(n), grid = new Map();
    let a = 0, b = 0;
    for (let k = 0; k < n; k++) {
      a += d[2 * k]; b += d[2 * k + 1];
      lat[k] = a / sc; lng[k] = b / sc;
      const key = Math.floor(lat[k] * 100) + ':' + Math.floor(lng[k] * 100);
      let cell = grid.get(key);
      if (!cell) grid.set(key, cell = []);
      cell.push(k);
    }
    Object.assign(parking, { n, lat, lng, grid, date: j.date || '', loaded: true });
  }
  function parkingNear(la, ln, r) {
    const out = [], cy = Math.floor(la * 100), cx = Math.floor(ln * 100);
    const sy = Math.ceil(r / 1100), sx = Math.ceil(r / 880);
    for (let y = cy - sy; y <= cy + sy; y++) for (let x = cx - sx; x <= cx + sx; x++) {
      const cell = parking.grid.get(y + ':' + x);
      if (!cell) continue;
      for (const k of cell) {
        const d = haversine({ lat: la, lng: ln }, { lat: parking.lat[k], lng: parking.lng[k] });
        if (d <= r) out.push({ k, d });
      }
    }
    return out;
  }
  // 경로 위 위치(경로 거리)와 경로까지 거리: 지금 구간 근처 앞쪽만 본다
  function routeOffset(p, ahead) {
    if (!nav.pts || nav.pts.length < 2) return null;
    const pts = nav.pts, cum = nav.cum, to = nav.along + ahead;
    let best = null;
    for (let i = Math.max(0, nav.seg - 2); i < pts.length - 1 && cum[i] <= to; i++) {
      const pr = projectSeg(p, pts[i], pts[i + 1]);
      if (!best || pr.dist < best.dist) best = { dist: pr.dist, at: cum[i] + pr.t * (cum[i + 1] - cum[i]) };
    }
    return best;
  }
  // 내 앞쪽에 있는 주정차 카메라: [{ k, d(앞으로 남은 거리, m) }]
  function parkAhead(f, list, maxAhead, maxSide) {
    const out = [], h = state.heading !== null ? state.heading : parkState.h;
    const onRoute = !!(nav.active && nav.pts && nav.onRoute);
    for (const x of list) {
      const p = { lat: parking.lat[x.k], lng: parking.lng[x.k] };
      let along;
      if (onRoute) {
        const r = routeOffset(p, maxAhead + 20);
        if (!r || r.dist > 20) continue;
        along = r.at - nav.along;
      } else {
        if (h === null) continue;
        const diff = angleDiff(bearing(f, p), h);
        if (x.d > 12 && diff > 35) continue; // 아주 가까운 것은 옆에 있어도 방향 오차가 커서 거리로만 본다
        if (x.d * Math.sin(toRad(Math.min(diff, 90))) > maxSide) continue;
        along = x.d * Math.cos(toRad(diff));
      }
      if (along < -10 || along > maxAhead) continue;
      out.push({ k: x.k, d: Math.max(0, along) });
    }
    return out.sort((x, y) => x.d - y.d);
  }
  function evalParking(f) {
    let near = null, markers = [];
    if (state.heading !== null && state.speedKmh >= 5) parkState.h = state.heading; // 멈춰 있을 때는 마지막 방향
    const routing = !!(nav.active && nav.dest);
    const nearDest = routing && nav.remain <= PARK_DEST_NEAR;   // 길 따라 남은 거리 (강 건너 직선 거리로는 가까워도 아니다)
    if (parking.loaded && prefs.parking && (!routing || nearDest)) {
      const list = parkingNear(f.lat, f.lng, PARK_MAP_AHEAD + 20);
      const ahead = parkAhead(f, list, PARK_MAP_AHEAD, 30);
      const showing = !!parkState.near;
      const first = parkAhead(f, list, PARK_KEEP, 15)[0];
      if (first && ((state.speedKmh < PARK_SLOW && first.d <= PARK_SHOW) || (showing && state.speedKmh <= PARK_FAST))) near = first;
      if (state.speedKmh < PARK_MAP_KMH) markers = ahead.slice(0, 40);
      if (nearDest) {
        const have = new Set(markers.map((x) => x.k));
        parkingNear(nav.dest.lat, nav.dest.lng, PARK_DEST_R).sort((x, y) => x.d - y.d)
          .forEach((x) => { if (!have.has(x.k) && markers.length < 40) { have.add(x.k); markers.push(x); } });
      }
    }
    parkState.near = near;
    renderPark();
    if (mapA && mapA.setParks) {
      const key = markers.map((x) => x.k).join(',');
      const moved = !parkState.markerAt || haversine(parkState.markerAt, f) > 30;
      if (key !== parkState.markerKey && (moved || !markers.length)) {
        parkState.markerAt = { lat: f.lat, lng: f.lng };
        parkState.markerKey = key;
        mapA.setParks(markers.map((x) => ({ k: x.k, lat: parking.lat[x.k], lng: parking.lng[x.k] })));
      }
    }
  }
  function renderPark() {
    const el = $('#parkCard'), p = parkState.near;
    el.hidden = !p;
    if (p) $('#parkDist').textContent = fmtDist(p.d);
  }
  // ---------- 주의 표지 (전국도로안전표지표준데이터의 주의표지, data/signs.json · tools/build_signs.py) ----------
  // 다른 내비의 '미끄럼 주의'처럼 미끄러운 도로·낙석·급경사 같은 주의 표지를 300m 앞부터 표지 그림 + 거리로 알린다 (2026-11-14 요청).
  // 길안내 중이면 경로 25m 안의 표지를, 아니면 진행 방향 바로 앞(200m)의 표지를. 표지는 도로 오른쪽(우측 통행)에 서므로
  // 경로 왼쪽으로 5m 넘게 떨어진 표지는 반대 방향용으로 보고 뺀다. 오르막·내리막(dir)은 오른쪽에 있을 때만 (2026-11-14 실제 경로 확인:
  // 하남 덕풍공원로 내리막 표지가 남행 오른쪽 3.4m — 북행(오르막)에 '내리막'이 뜨면 안 된다). 지나친 뒤 150m 동안은 '주의'로 남긴다.
  // 이 자료는 표지를 등록한 지자체(전국 약 57곳)만 들어 있어 전국을 다 덮지 못한다
  const SIGN_TRI_PATH = '<path d="M50 5 L95 83 L5 83 Z" fill="#e53935" stroke="#e53935" stroke-width="8" stroke-linejoin="round"/>' +
    '<path d="M50 20 L83 77 L17 77 Z" fill="#ffd200" stroke="#ffd200" stroke-width="4" stroke-linejoin="round"/>';
  const signSvg = (g) => '<svg viewBox="0 0 100 88" aria-hidden="true">' + SIGN_TRI_PATH +
    '<g fill="#111" stroke="#111" stroke-linecap="round" stroke-linejoin="round">' + g + '</g></svg>';
  // 순서는 상관없다 (signs.json 의 types 이름으로 맞춘다). label 은 카드 글자
  const SIGN_TYPES = [
    { id: 'slip', label: '미끄러운 도로', g: '<rect x="40" y="37" width="20" height="11" rx="3" stroke="none"/><rect x="40" y="46" width="5" height="5" rx="1" stroke="none"/><rect x="55" y="46" width="5" height="5" rx="1" stroke="none"/>' +
      '<path d="M44 55 Q37 61 44 66 T44 76 M57 55 Q50 61 57 66 T57 76" fill="none" stroke-width="3.2"/>' },
    { id: 'rock', label: '낙석 주의', g: '<path d="M52 42 L60 42 L76 74 L62 74 L64 62 L56 54 Z" stroke-width="1"/>' +
      '<path d="M38 52 l5 -3 l4 3 l-1 5 l-6 1 z M31 66 l6 -3 l5 3 l-1 6 l-8 1 z" stroke-width="1"/><circle cx="47" cy="43" r="2.4" stroke="none"/>' },
    { id: 'up', label: '오르막 경사', dir: true, g: '<path d="M24 75 L70 75 L70 56 Z" stroke-width="2"/>' },
    { id: 'down', label: '내리막 경사', dir: true, g: '<path d="M30 56 L30 75 L76 75 Z" stroke-width="2"/>' },
    { id: 'rough', label: '노면 고르지 못함', g: '<path d="M24 74 L24 69 Q32 55 40 68 Q50 71 60 68 Q68 55 76 69 L76 74 Z" stroke-width="1.5"/>' },
    { id: 'wind', label: '횡풍 주의', g: '<path d="M38 45 V75" fill="none" stroke-width="3.5"/><path d="M40 47 L64 51 L64 58 L40 62 Z" fill="none" stroke-width="2.2"/>' +
      '<path d="M40 47 L48 48.3 L48 60.7 L40 62 Z M56 49.7 L64 51 L64 58 L56 59.3 Z" stroke-width="1"/>' },
    { id: 'animal', label: '야생동물 주의', g: '<ellipse cx="53" cy="62" rx="12" ry="5.5" transform="rotate(-12 53 62)" stroke="none"/>' +
      '<path d="M45 60 L39.5 51.5" fill="none" stroke-width="4.5"/><ellipse cx="38" cy="50" rx="4.6" ry="3" transform="rotate(-20 38 50)" stroke="none"/>' +
      '<path d="M39 48 L38 42.5 M38.5 45 L42.5 42.5 M45 64 L37 69 L33 68 M47 65 L42 73 M61 62 L69 69 L72 75 M59 64 L63 74 M64 57.5 L68 55" fill="none" stroke-width="2.6"/>' },
    { id: 'narrow', label: '도로 폭 좁아짐', g: '<path d="M34 75 V66 L44 54 V42 M66 75 V66 L56 54 V42" fill="none" stroke-width="5"/>' },
    { id: 'rail', label: '철길 건널목', g: '<rect x="30" y="54" width="33" height="12" rx="1.5" stroke="none"/><rect x="52" y="47" width="11" height="9" stroke="none"/>' +
      '<rect x="35" y="48" width="5" height="7" stroke="none"/><circle cx="36" cy="70.5" r="4" stroke="none"/><circle cx="47" cy="70.5" r="4" stroke="none"/><circle cx="58" cy="70.5" r="4" stroke="none"/>' },
    { id: 'danger', label: '위험 구간', g: '<path d="M50 38 V60" fill="none" stroke-width="8"/><circle cx="50" cy="69.5" r="4.6" stroke="none"/>' },
  ];
  const SIGN_INDEX = Object.fromEntries(SIGN_TYPES.map((x, i) => [x.id, i]));
  const signs = { loaded: false, n: 0, lat: null, lng: null, type: null, road: null, roads: [''], grid: new Map(), date: '' };
  const signRoad = (k) => (signs.road ? signs.roads[signs.road[k]] : '') || '';
  const signState = { next: null, shownKey: '' };
  const SIGN_AHEAD = 300, SIGN_AFTER = 150, SIGN_ROUTE_M = 25, SIGN_LEFT_M = 5;
  function setSignData(j) {
    signs.loaded = false; signs.grid = new Map();
    nav.routeSigns = null; signState.shownKey = '';
    if (!j || !Array.isArray(j.d)) return;
    const n = j.count, sc = j.scale || 1e5, d = j.d, names = j.types || [];
    const w = Array.isArray(j.names) ? 4 : 3;   // v2: [dLat, dLng, type, 도로 이름 번호]
    const lat = new Float64Array(n), lng = new Float64Array(n), type = new Int8Array(n), road = new Int32Array(n);
    let a = 0, b = 0;
    for (let k = 0; k < n; k++) {
      a += d[w * k]; b += d[w * k + 1];
      lat[k] = a / sc; lng[k] = b / sc;
      road[k] = w === 4 ? d[w * k + 3] : 0;
      const ti = SIGN_INDEX[names[d[w * k + 2]]];
      type[k] = ti === undefined ? -1 : ti;
      const key = Math.floor(lat[k] * 100) + ':' + Math.floor(lng[k] * 100);
      let cell = signs.grid.get(key);
      if (!cell) signs.grid.set(key, cell = []);
      cell.push(k);
    }
    Object.assign(signs, { n, lat, lng, type, road, roads: w === 4 ? j.names : [''], date: j.date || '', loaded: true });
  }
  async function loadSigns() {
    try {
      const r = await fetch('data/signs.json?v=' + APP_VERSION);
      if (r.ok) setSignData(await r.json());
    } catch (e) { /* 표지 데이터가 없어도 나머지는 그대로 */ }
  }
  function signsNear(la, ln, r) {
    const out = [], cy = Math.floor(la * 100), cx = Math.floor(ln * 100);
    const sy = Math.ceil(r / 1100), sx = Math.ceil(r / 880);
    for (let y = cy - sy; y <= cy + sy; y++) for (let x = cx - sx; x <= cx + sx; x++) {
      const cell = signs.grid.get(y + ':' + x);
      if (!cell) continue;
      for (const k of cell) {
        if (signs.type[k] < 0) continue;
        const d = haversine({ lat: la, lng: ln }, { lat: signs.lat[k], lng: signs.lng[k] });
        if (d <= r) out.push({ k, d });
      }
    }
    return out;
  }
  // a→b 방향에서 p 가 오른쪽으로 몇 m (왼쪽이면 음수)
  function rightOf(p, a, b) {
    const kx = Math.cos(toRad(a.lat)) * 111320, ky = 110540;
    const bx = (b.lng - a.lng) * kx, by = (b.lat - a.lat) * ky;
    const px = (p.lng - a.lng) * kx, py = (p.lat - a.lat) * ky;
    const len = Math.hypot(bx, by);
    return len > 0 ? (by * px - bx * py) / len : 0;
  }
  // 길안내 경로 위 주의 표지 (경로 거리순). 앞쪽 4km 까지만 찾아 두고 달리면서 늘린다
  function ensureRouteSigns() {
    if (!signs.loaded || !nav.pts || nav.pts.length < 2) return false;
    if (!nav.routeSigns) { nav.routeSigns = []; nav.signSeen = new Set(); nav.signUpto = 0; }
    const pts = nav.pts, want = nav.along + 4000;
    let i = nav.signUpto, added = false;
    for (; i < pts.length - 1 && nav.cum[i] < want; i++) {
      const a = pts[i], b = pts[i + 1], half = (nav.cum[i + 1] - nav.cum[i]) / 2;
      for (const it of signsNear((a.lat + b.lat) / 2, (a.lng + b.lng) / 2, half + SIGN_ROUTE_M + 5)) {
        if (nav.signSeen.has(it.k)) continue;
        const p = { lat: signs.lat[it.k], lng: signs.lng[it.k] };
        const pr = projectSeg(p, a, b);
        if (pr.dist > SIGN_ROUTE_M || rightOf(p, a, b) < (SIGN_TYPES[signs.type[it.k]].dir ? 0 : -SIGN_LEFT_M)) continue;
        const at = nav.cum[i] + pr.t * (nav.cum[i + 1] - nav.cum[i]);
        // 내 길의 표지인지 (위 '일반도로 자료'): 이름이 같으면 25m 까지, 이름으로 모르면 15m 까지(모퉁이 근처 8m)
        const st = localOnRoute(at, signRoad(it.k));
        if (st === 'no') continue;
        if (st === 'maybe' && (pr.dist > 15 || (pr.dist > 8 && routeTurnAt(at) > 30))) continue;
        nav.signSeen.add(it.k);
        nav.routeSigns.push({ k: it.k, at, st });
        added = true;
      }
    }
    nav.signUpto = i;
    if (added) nav.routeSigns.sort((x, y) => x.at - y.at);
    return true;
  }
  function evalSigns(f) {
    let next = null;
    if (signs.loaded && prefs.signs) {
      if (nav.active && nav.pts && ensureRouteSigns()) {
        const live = (s) => s.st !== 'maybe' || liveRoadSays(s.at, signRoad(s.k));
        const up = nav.routeSigns.find((s) => s.at >= nav.along && s.at - nav.along <= SIGN_AHEAD && live(s));
        let past = null;
        if (!up) for (const s of nav.routeSigns) { if (s.at >= nav.along) break; if (nav.along - s.at <= SIGN_AFTER && live(s)) past = s; }
        const s = up || past;
        if (s) next = { k: s.k, type: signs.type[s.k], d: Math.max(0, s.at - nav.along), passed: !up };
      } else if (state.heading !== null && state.speedKmh >= 8) {
        for (const it of signsNear(f.lat, f.lng, 220)) {
          const p = { lat: signs.lat[it.k], lng: signs.lng[it.k] };
          const diff = angleDiff(bearing(f, p), state.heading);
          if (it.d < 8 || diff > 30) continue;
          const side = it.d * Math.sin(toRad(diff)) * (((bearing(f, p) - state.heading + 540) % 360) - 180 >= 0 ? 1 : -1);
          if (side < (SIGN_TYPES[signs.type[it.k]].dir ? 0 : -SIGN_LEFT_M) || side > 20 || !freeRoadOk(signRoad(it.k))) continue;
          if (it.d <= 200 && (!next || it.d < next.d)) next = { k: it.k, type: signs.type[it.k], d: it.d, passed: false };
        }
      }
    }
    signState.next = next;
    renderSign();
  }
  function renderSign() {
    const el = $('#signCard'), s = signState.next;
    if (!el) return;
    el.hidden = !s;
    if (!s) { signState.shownKey = ''; return; }
    const t = SIGN_TYPES[s.type];
    if (signState.shownKey !== t.id) {
      signState.shownKey = t.id;
      $('#signIcon').innerHTML = pickImg('sign_' + t.id) || signSvg(t.g);
      $('#signLabel').textContent = t.label;
      el.dataset.type = t.id;
    }
    $('#signDist').textContent = s.passed ? '주의' : fmtDist(s.d);
  }
  // ---------- 터널 (OpenStreetMap 의 터널 도로, data/tunnels.json · tools/build_tunnels.py) ----------
  // 네이버 길찾기 안내에는 터널이 없다 (지하차도는 있음). 길안내 경로가 지나는 터널을 찾아
  // 안내 패널에 '남한터널 진입 3.5km · 길이 1.2km', 터널 안에서는 '출구까지 799m'를 보여 준다 (2026-11-14 요청)
  const tunnels = { loaded: false, ways: [], grid: new Map(), date: '' };
  const TUNNEL_SHOW = 3000;   // 이만큼 앞부터 보여 준다
  const TUNNEL_NEAR = 9;      // 경로 점이 터널 도로에서 이 안이면 터널 안
  const TUNNEL_STEP = 10;     // 경로를 이 간격으로 훑는다
  const TUNNEL_ICON = '<svg viewBox="0 0 24 24" class="tunnel"><path class="tn-arch" d="M2.5 21V12.5a9.5 9.5 0 0 1 19 0V21z"/>' +
    '<path class="tn-hole" d="M6 21v-8a6 6 0 0 1 12 0v8z"/><path class="tn-road" d="M11.2 21l.4-7h.8l.4 7z"/></svg>';
  const UNDERPASS_GUIDES = new Set([56, 64, 65, 73, 74]); // 네이버가 따로 안내하는 지하차도 진입·옆길
  function setTunnelData(j) {
    tunnels.loaded = false; tunnels.ways = []; tunnels.grid = new Map();
    nav.routeTunnels = null;
    if (!j || !j.w) return;
    const sc = j.scale || 1e5, names = j.names || [];
    j.w.forEach((r, wi) => {
      let a = r[2], b = r[3];
      const pts = [{ lat: a / sc, lng: b / sc }];
      for (let k = 4; k + 1 < r.length; k += 2) { a += r[k]; b += r[k + 1]; pts.push({ lat: a / sc, lng: b / sc }); }
      tunnels.ways.push({ name: r[0] >= 0 ? names[r[0]] || '' : '', oneway: r[1] === 1, pts });
      // 선분마다 지나는 칸(0.01도)에 넣는다. 경계 근처 점도 찾게 20~30m 넉넉히
      for (let s = 0; s < pts.length - 1; s++) {
        const p = pts[s], q = pts[s + 1];
        const y0 = Math.floor((Math.min(p.lat, q.lat) - 0.0002) * 100), y1 = Math.floor((Math.max(p.lat, q.lat) + 0.0002) * 100);
        const x0 = Math.floor((Math.min(p.lng, q.lng) - 0.0003) * 100), x1 = Math.floor((Math.max(p.lng, q.lng) + 0.0003) * 100);
        for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
          const key = y + ':' + x;
          let cell = tunnels.grid.get(key);
          if (!cell) tunnels.grid.set(key, cell = []);
          cell.push(wi, s);
        }
      }
    });
    tunnels.date = j.date || '';
    tunnels.loaded = true;
  }
  async function loadTunnels() {
    try {
      const r = await fetch('data/tunnels.json?v=' + APP_VERSION);
      if (r.ok) setTunnelData(await r.json());
    } catch (e) { /* 터널 데이터가 없어도 나머지는 그대로 */ }
  }
  // 경로 위 점 p(진행 방향 hb)가 터널 도로 위인지: 9m 안 + 방향이 맞아야 (일방이면 같은 방향만)
  function tunnelWayAt(p, hb) {
    const cell = tunnels.grid.get(Math.floor(p.lat * 100) + ':' + Math.floor(p.lng * 100));
    if (!cell) return -1;
    let best = -1, bestD = TUNNEL_NEAR;
    for (let k = 0; k < cell.length; k += 2) {
      const w = tunnels.ways[cell[k]], s = cell[k + 1];
      const q1 = w.pts[s], q2 = w.pts[s + 1];
      const pr = projectSeg(p, q1, q2);
      if (pr.dist > bestD) continue;
      const d = angleDiff(hb, bearing(q1, q2));
      if (w.oneway ? d >= 40 : (d >= 40 && d <= 140)) continue;
      best = cell[k]; bestD = pr.dist;
    }
    return best;
  }
  // 터널 구간 하나를 마무리: 지하차도(네이버가 안내)·짧은 굴다리는 뺀다
  function closeTunnelRun(run) {
    let name = '', top = 0;
    run.names.forEach((n, k) => { if (n > top) { top = n; name = k; } });
    const len = run.s1 - run.s0;   // 터널 끝 9m 밖 점까지 잡히므로 훑는 간격을 더하지 않는다
    if (len < (/터널/.test(name) ? 60 : 150)) return;
    const last = nav.cum.length - 1;
    if (nav.guides.some((g) => UNDERPASS_GUIDES.has(g.t) && Math.abs(nav.cum[Math.min(g.i, last)] - run.s0) < 300)) return;
    nav.routeTunnels.push({ s0: run.s0, s1: run.s1, len, name });
  }
  // 길안내 경로 위 터널 구간 (경로 거리순). 카메라처럼 앞쪽만 찾아 두고 달리면서 늘린다 (긴 터널도 끝까지 알게 9km)
  function ensureRouteTunnels() {
    if (!tunnels.loaded || !nav.pts || nav.pts.length < 2) return false;
    if (!nav.routeTunnels) { nav.routeTunnels = []; nav.tnUpto = 0; nav.tnRun = null; }
    const pts = nav.pts, want = nav.along + TUNNEL_SHOW + 6000;
    let i = nav.tnUpto;
    for (; i < pts.length - 1 && nav.cum[i] < want; i++) {
      const a = pts[i], b = pts[i + 1], L = nav.cum[i + 1] - nav.cum[i];
      if (!(L > 0)) continue;
      const hb = bearing(a, b), n = Math.max(1, Math.ceil(L / TUNNEL_STEP));
      for (let k = 0; k < n; k++) {
        const f = k / n, s = nav.cum[i] + L * f;
        const wi = tunnelWayAt({ lat: a.lat + (b.lat - a.lat) * f, lng: a.lng + (b.lng - a.lng) * f }, hb);
        const run = nav.tnRun;
        if (wi >= 0) {
          const nm = tunnels.ways[wi].name;
          if (run && s - run.s1 <= 30) run.s1 = s;
          else { if (run) closeTunnelRun(run); nav.tnRun = { s0: s, s1: s, names: new Map() }; }
          nav.tnRun.names.set(nm, (nav.tnRun.names.get(nm) || 0) + (nm ? 2 : 1));
        } else if (run && s - run.s1 > 30) { closeTunnelRun(run); nav.tnRun = null; }
      }
    }
    nav.tnUpto = i;
    if (i >= pts.length - 1 && nav.tnRun) { closeTunnelRun(nav.tnRun); nav.tnRun = null; }
    return true;
  }
  // 터널 안에서 위치가 멈추면(신호 끊김) 마지막 속도로 출구까지 거리를 줄여 간다 (안내 패널 표시만)
  const tnDR = { along: -1, at: 0, v: 0 };
  function tunnelAhead() {
    if (!nav.active || !prefs.tunnels || !ensureRouteTunnels()) return null;
    const now = Date.now();
    if (Math.abs(nav.along - tnDR.along) > 1) { tnDR.along = nav.along; tnDR.at = now; tnDR.v = state.speedKmh / 3.6; }
    const list = nav.routeTunnels;
    let along = nav.along;
    const lag = (now - tnDR.at) / 1000;
    const near = list.find((t) => t.s1 > along && t.s0 - along < 150);
    if (near && lag > 1.5 && lag < 180 && tnDR.v > 3 && (now - lastFixWall > 3000 || state.speedKmh >= 10)) {
      along = Math.min(near.s1, tnDR.along + tnDR.v * lag);
    }
    for (const t of list) {
      if (t.s1 <= along) continue;
      if (t.s0 <= along) return { inside: true, t, d: t.s1 - along, p: (along - t.s0) / Math.max(1, t.s1 - t.s0) };
      return t.s0 - along <= TUNNEL_SHOW ? { inside: false, t, d: t.s0 - along } : null;
    }
    return null;
  }
  function renderTunnel() {
    const el = $('#tunnelRow'), a = tunnelAhead();
    el.hidden = !a;
    if (!a) return;
    const ic = $('#tunnelIcon');
    // AI 로 그린 터널 아이콘(icons.js 의 tunnel)이 있으면 그것, 없으면 앱에 그려 둔 아치
    if (!ic.firstChild) ic.innerHTML = pickImg('tunnel') || (window.TNC_ICONS && window.TNC_ICONS.tunnel ? icoBase('tunnel') : TUNNEL_ICON);
    el.classList.toggle('inside', a.inside);
    const name = a.t.name || '터널';
    $('#tunnelDist').textContent = fmtDist(a.d);
    $('#tunnelText').textContent = a.inside ? name + ' 출구까지' : name + ' 진입 · 길이 ' + fmtDist(a.t.len);
    $('#tunnelBar').style.width = a.inside ? Math.round(Math.max(0, Math.min(1, a.p)) * 100) + '%' : '0';
  }
  async function loadCameras() {
    try {
      // 버전을 붙여 새 버전과 함께 바뀐 카메라 데이터를 바로 받는다 (브라우저 10분 캐시 우회)
      const r = await fetch('data/cameras.json?v=' + APP_VERSION);
      const j = await r.json();
      const g = new Map();
      j.rows.forEach((c, i) => {
        const k = Math.floor(c[0] / CELL) + ':' + Math.floor(c[1] / CELL);
        let a = g.get(k);
        if (!a) { a = []; g.set(k, a); }
        a.push(i);
      });
      // 한 방향 카메라의 설치장소 방향 'A→B' (arrows = [행, A 번호, B 번호, ...], 지명은 arrowNames)
      const ar = new Map(), an = j.arrowNames || [], al = j.arrows || [];
      for (let k = 0; k + 2 < al.length; k += 3) if (j.rows[al[k]]) ar.set(j.rows[al[k]], [an[al[k + 1]], an[al[k + 2]]]);
      cams.rows = j.rows; cams.grid = g; cams.date = j.date; cams.roads = j.roads || []; cams.arrows = ar; cams.loaded = true;
    } catch (e) {
      toast('단속 카메라 데이터를 불러오지 못했습니다.', 'bad', 5000);
    }
  }
  function camsNear(lat, lng, radius) {
    const out = [];
    if (!cams.loaded) return out;
    const cy = Math.floor(lat / CELL), cx = Math.floor(lng / CELL);
    const ry = Math.ceil(radius / 1110), rx = Math.ceil(radius / 880);
    const me = { lat, lng };
    for (let dy = -ry; dy <= ry; dy++) {
      for (let dx = -rx; dx <= rx; dx++) {
        const a = cams.grid.get((cy + dy) + ':' + (cx + dx));
        if (!a) continue;
        for (const i of a) {
          const c = cams.rows[i];
          const d = haversine(me, { lat: c[0], lng: c[1] });
          if (d <= radius) out.push({ i, c, d });
        }
      }
    }
    return out;
  }

  const camState = { target: null, passed: new Map(), saidById: new Map(), section: null, markerAt: null, lastOverBeep: 0 };
  // 카메라를 지나간 뒤 경고를 유지하는 거리 (데이터 좌표와 실제 단속 지점이 15m 안팎 다르다)
  const CAM_HOLD = 30;
  // 후면 단속 카메라는 지나간 차의 뒤를 찍으므로 기둥을 지난 뒤가 단속 지점이다: 더 길게(60m) 경고를 유지한다
  const REAR_HOLD = 60;
  // 11번째 값(flags): 1 후면 단속, 2 박스형 (둘 다 원본에 없어 직접 확인한 것만)
  const isRear = (c) => ((c[10] | 0) & 1) === 1;
  const isBox = (c) => ((c[10] | 0) & 2) === 2;
  const camHold = (c) => (isRear(c) ? REAR_HOLD : CAM_HOLD);
  // 카메라 행: [lat, lng, limit, kind, sec, len, zone, road, rtype, dir(, flags)]
  // kind: 1 과속, 2 신호 전용, 3 과속+신호, 9 구간/기타 · rtype: 1 고속국도, 3 일반국도, 4 지방도, 5 시도, 6 기타
  // 8 이동식: 경찰청 공개 데이터는 고정식만 담고 있어 지금은 없다. 이동식 위치 데이터가 생기면 kind 8 로 넣으면 파란색으로 뜬다
  const KIND_NAME = { 1: '과속 단속', 2: '신호 단속', 3: '신호·과속 단속', 8: '이동식 단속', 9: '단속 구간' };
  // 속도를 재는 카메라인지 (신호 전용은 제외. 단, 어린이보호구역은 안전을 위해 속도 단속으로 본다)
  const isSpeedCam = (c) => c[3] !== 2 || c[6] === 2;
  // 경고할 카메라인지: 신호 전용은 설정에서 켰을 때만
  const camWanted = (c) => isSpeedCam(c) || prefs.signalCams;
  function camLabel(c) {
    let s = c[4] === 1 ? '구간단속 시작' : c[4] === 2 ? '구간단속 끝' : (KIND_NAME[c[3]] || '단속 카메라');
    if (c[6] === 2) s = '어린이보호구역 ' + (c[3] === 2 ? '단속' : s);
    else if (c[6] === 1) s = '노인보호구역 ' + s;
    if (isRear(c)) s = s.replace(/ ?단속$/, ' 후면단속');   // 예: '신호·과속 후면단속'
    if (isBox(c)) s = '박스형 ' + s;                        // 예: '박스형 과속 단속' (2026-11-14 팔당 제보)
    return s;
  }
  const camRoad = (c) => (cams.roads && c[7] >= 0 ? cams.roads[c[7]] : '') || '';
  const roadKey = (s) => String(s || '').replace(/\s+/g, '').replace(/고속도로$/, '고속');
  // 두 도로 이름이 같은 도로를 가리키는지 (한쪽이 다른 쪽을 포함하면 같다고 본다)
  function sameRoad(a, b) {
    const x = roadKey(a), y = roadKey(b);
    return !!x && !!y && (x.indexOf(y) >= 0 || y.indexOf(x) >= 0);
  }
  // '19번 국도', '국도1', '국지도70', '지방도333', '국도 제3호선', '고속도로' 처럼 노선 번호·종류만 있는 이름은
  // 실제 도로명(북한강로 등)과 비교할 수 없다 (같은 길이어도 이름이 달라 진짜 카메라를 숨기게 됨)
  const GENERIC_ROAD = /^(\d+번\s*)?(일반국도|국도|국가지원지방도|국지도|지방도|고속도로|고속국도|시도|군도|구도|기타)(\s*제?\s*\d+\s*(호선|번)?)?$|\d+\s*호선$/;
  const specificRoad = (s) => !!s && !GENERIC_ROAD.test(String(s).trim());
  // 둘 다 구체적인 도로명인데 서로 다르면 다른 도로 (하나라도 모르면 다르다고 단정하지 않는다)
  const roadsDiffer = (a, b) => specificRoad(a) && specificRoad(b) && !sameRoad(a, b);
  // 경로 위 지점(점 번호)에 해당하는 도로 이름 (길찾기 응답의 주요 도로 구간 정보)
  function routeRoadAt(idx) {
    const secs = nav.route && nav.route.sections;
    if (!secs) return '';
    for (const s of secs) if (idx >= s.i && idx <= s.i + Math.max(1, s.n) - 1) return s.name || '';
    return '';
  }
  // 경고를 시작하는 거리 (카메라가 서 있는 도로 기준):
  //   고속도로(고속국도) 3km · 고속화도로(제한 80 이상: 도시고속도로·자동차전용도로 등) 1km · 일반도로 400m
  // 첫 음성 안내는 고속도로만 2km 에서, 나머지는 경고 시작과 함께 한다
  function alertRange(c) { return c[8] === 1 ? 3000 : c[2] >= 80 ? 1000 : 400; }
  function voiceRange(c) { return c[8] === 1 ? 2000 : alertRange(c); }
  const CAM_SCAN = 3000; // 가장 긴 경고 거리

  // 반대편 차로 카메라 거르기: 한국은 우측통행이라 내 방향을 찍는 카메라는 오른쪽 길가(또는 머리 위)에 선다.
  // 한 방향만 찍는 카메라(데이터의 도로노선방향 상행/하행)가 내 진행 방향 왼쪽으로 이만큼 넘게 떨어져 있으면
  // 반대편 차로용으로 본다. 양방향 카메라와 방향을 모르는 카메라는 절대 거르지 않는다.
  const OPP_SIDE = 8;
  const oneDir = (c) => c[9] === 1 || c[9] === 2;
  // 굽은 길: 최근 주행 궤적이 휜 정도(곡률 k, 1m 당 라디안, + 는 오른쪽으로 굽음)로 앞길을 원호로 보고,
  // 거리 d 앞 지점이 놓일 방향(현 방향 + 원호의 현이 꺾인 각)을 구한다. 곧은 길이면 지금 방향 그대로
  const curv = { hist: [], k: 0 };
  function pathBearing(d) {
    if (state.heading === null) return null;
    const k = curv.k;
    if (!k || d > 800) return state.heading;
    const half = Math.asin(Math.min(1, d * Math.abs(k) / 2)); // 반지름 1/k 원에서 현 길이 d 의 꺾인 각
    return (state.heading + Math.sign(k) * toDeg(half) + 360) % 360;
  }
  // 앞길(원호) 기준 좌우 거리 (오른쪽 +, 왼쪽 -)
  function sideOf(f, c, d) {
    const pb = pathBearing(d);
    if (pb === null) return 0;
    const a = ((bearing(f, { lat: c[0], lng: c[1] }) - pb) % 360 + 540) % 360 - 180;
    return d * Math.sin(toRad(a));
  }
  // 지금 달리는 도로 이름(역지오코딩)과 카메라의 도로 이름이 같은지 (구체적인 도로명끼리만)
  const onSameRoadName = (c) => specificRoad(road.name) && sameRoad(road.name, camRoad(c));
  // 경로 선분 a→b 기준 p 의 좌우 거리 (오른쪽 +, 왼쪽 -)
  function sideOfSeg(p, a, b, dist) {
    const k = Math.cos(toRad(a.lat));
    const ax = (b.lng - a.lng) * k, ay = b.lat - a.lat, px = (p.lng - a.lng) * k, py = p.lat - a.lat;
    return (ax * py - ay * px) > 0 ? -dist : dist; // 외적이 + 면 왼쪽
  }

  // 내가 달리는 도로의, 진행 방향 앞에 있는 카메라인지
  function isAhead(f, c, d, keep) { // keep: 이미 경고 중인 카메라를 계속 둘지 볼 때 (조금 느슨하게)
    if (!camWanted(c)) return false;
    // 길안내 중에는 안내하는 경로 위의 카메라만 (잠깐 경로를 벗어나도 다른 길 카메라는 알리지 않는다)
    if (nav.active && nav.pts) return camOnRouteAhead(c) || camBesideRouteOnMyRoad(c);
    // 길안내가 없으면 진행 방향 앞(굽은 길이면 휘는 대로 예측한 앞길)의 내 도로 카메라
    if (state.heading === null) return false;
    const same = onSameRoadName(c);
    const diff = angleDiff(bearing(f, { lat: c[0], lng: c[1] }), pathBearing(d));
    if (diff > (same ? 75 : 60) && d > 40) return false;
    // 앞길에서 좌우로 얼마나 떨어져 있는지: 옆 도로(보통 30m 이상 떨어짐)는 빼고, 멀수록 방향 오차를 조금 허용.
    // 지금 달리는 도로와 이름이 같은 카메라는 굽은 길·좌표 오차를 감안해 훨씬 너그럽게 본다
    const lateral = d * Math.sin(toRad(Math.min(diff, 90)));
    const limit = same ? 45 + d * 0.06 : 20 + d * (keep ? 0.03 : 0.015);
    if (lateral > limit) return false;
    // 반대편 차로 카메라. 멀리서는 방향 오차·굽은 길 때문에 좌우를 믿기 어려우므로,
    // 왼쪽으로 보이는 한 방향 카메라는 300m 안으로 들어올 때까지 미뤘다가 그때 판단한다 (멀리서 잠깐 떴다 사라지는 일 방지)
    if (oneDir(c)) {
      const sd = sideOf(f, c, d);
      if (keep) { if (sd < -(OPP_SIDE + d * 0.02)) return false; }
      else if (sd < -OPP_SIDE && (d > 300 || sd < -(OPP_SIDE + d * 0.01))) return false;
    }
    return true;
  }
  // 경로 선분 i 위의 카메라인지 보고, 맞으면 경로 위 거리(m)를 돌려준다.
  // 경로에서 20m 이내면 내 도로로 본다. 단, 도로명이 둘 다 구체적인데 서로 다르면(옆 도로·교차로의 가로 도로) 뺀다.
  // 넓은 도로·고속도로는 카메라가 경로선(도로 가운데)에서 20~40m 떨어져 서 있기도 하다(2026-11-14 전국 16개 경로 점검:
  // 올림픽로 36m·한밭대로 34m·경부고속도로 35m 등). 그래서 내 도로라고 확인되면 40m 까지 인정한다:
  //   경로 구간 이름이 카메라 도로명과 같거나, 구간 이름을 모를 때는 근처(800m 안) 경로 바로 위(20m 안)에 같은 도로의 카메라가 있을 때
  const ROUTE_CAM_NEAR = 20, ROUTE_CAM_FAR = 40;
  // 설치장소에 'A→B'가 적힌 한 방향 카메라: 길안내 경로의 앞뒤 안내 문구로 방향을 가른다 (-1 반대 방향, 1 내 방향, 0 모름).
  // 좌표가 도로 한가운데라 좌우로 못 가르는 경우가 있다 (2026-11-14 하남 창우로 J2735 '(하남ic->팔당대교)' 60:
  // 팔당대교IC → 하남IC 로 가는데 떴다. 지나온 안내에 '팔당대교', 갈 안내에 '하남IC' → 반대 방향).
  // 안내 문구 'X에서 'Y, Z' 방면으로 …'의 X(그 안내 지점)는 지나온 안내면 뒤쪽, 갈 안내면 앞쪽이고, 'Y, Z'(방면)는 늘 앞쪽(가는 곳)이다
  // (2026-11-14 전국 점검: 전주→군산 새만금북로 '전주→군산' 카메라가 지나온 안내의 ''군산' 방면' 때문에 빠졌었다).
  // 뒤쪽에 B(카메라 방향의 끝)가 있거나 앞쪽에 A(시작)가 있으면 반대 방향. 앞뒤에 다 있으면 모름(그대로 알림)
  const ARROW_SPAN = 8000;
  function guideParts(g) {
    const t = String(g.s || '').replace(/\s+/g, '').toLowerCase();
    const q = t.match(/'[^']*'/g) || [];
    const m = t.match(/^(.*?)에서/);
    return { loc: m ? m[1] : (q.length ? '' : t), dirs: q.join('|') };
  }
  function arrowSays(c, at) {
    const ar = cams.arrows && cams.arrows.get(c);
    if (!ar || !nav.guides || !nav.guides.length) return 0;
    const last = nav.cum.length - 1;
    let behind = '', ahead = '';
    for (const g of nav.guides) {
      const s = nav.cum[Math.min(g.i, last)];
      if (s < at - ARROW_SPAN || s > at + ARROW_SPAN) continue;
      const gp = guideParts(g);
      if (s < at - 30) behind += '|' + gp.loc; else if (s > at + 30) ahead += '|' + gp.loc;
      ahead += '|' + gp.dirs;
    }
    const [a, b] = ar, has = (t, k) => t.indexOf(k) >= 0;
    const opp = (has(behind, b) && !has(ahead, b)) || (has(ahead, a) && !has(behind, a));
    const same = (has(behind, a) && !has(ahead, a)) || (has(ahead, b) && !has(behind, b));
    return opp && !same ? -1 : same && !opp ? 1 : 0;
  }
  // 길안내 경로에서 고속도로를 달리는 구간 [시작, 끝](경로 거리): 네이버 안내의 고속도로 진입(50·57·66)부터 출구(51·58·67)까지.
  // 경로 구간 이름(sections)은 긴 주요 도로에만 붙고 경로를 다시 받으면 빠지기도 해서, 이름이 없는 곳에서도 고속도로 위인지 안다
  // (2026-11-14 주행: 수도권제1순환고속도로 송파 거여동에서 바로 밑 문정로의 어린이보호구역 30 카메라가 떴다).
  // 경로 시작이 이미 고속도로 위면(진입 없이 출구가 먼저) 처음부터 그 출구까지
  const HW_IN = new Set([50, 57, 66]), HW_OUT = new Set([51, 58, 67]);
  function highwaySpans() {
    if (nav.hwSpansFor === nav.route && nav.hwSpans) return nav.hwSpans;
    const spans = [], last = nav.cum.length - 1;
    let start = null, seen = false;
    for (const g of nav.guides || []) {
      const s = nav.cum[Math.min(g.i, last)];
      if (HW_IN.has(g.t)) { if (start === null) start = s; seen = true; }
      else if (HW_OUT.has(g.t)) { if (start !== null || !seen) spans.push([start === null ? 0 : start, s]); start = null; seen = true; }
    }
    if (start !== null) spans.push([start, nav.total]);
    nav.hwSpans = spans; nav.hwSpansFor = nav.route;
    return spans;
  }
  const onHighwayAt = (at) => highwaySpans().some(([a, b]) => at >= a && at <= b);
  function camAtSeg(c, i) {
    const p = { lat: c[0], lng: c[1] }, a = nav.pts[i], b = nav.pts[i + 1];
    const pr = projectSeg(p, a, b);
    if (pr.dist >= ROUTE_CAM_FAR) return null;
    const rn = routeRoadAt(i), cn = camRoad(c);
    if (pr.dist > 6 && roadsDiffer(rn, cn)) return null;
    // 경로 왼쪽으로 8m 넘게 떨어진 한 방향 카메라는 반대편 차로용
    if (oneDir(c) && pr.dist > OPP_SIDE && sideOfSeg(p, a, b, pr.dist) < 0) return null;
    const at = nav.cum[i] + pr.t * (nav.cum[i + 1] - nav.cum[i]);
    // 고속도로 구간이면 옆·아래 일반도로의 저속 카메라(제한 70 이하, 고속국도 아님)는 제외. 구간 이름이 고속도로이거나,
    // 이름이 없어도 안내상 고속도로 진입~출구 사이면 고속도로 ('분당수서고속화도로' 같은 고속화도로는 고속도로가 아니다)
    if ((/고속도로|고속국도/.test(rn) || onHighwayAt(at)) && c[8] !== 1 && c[2] <= 70) return null;
    const ok = pr.dist < ROUTE_CAM_NEAR || (specificRoad(rn) ? sameRoad(rn, cn) : specificRoad(cn) && sameRoadCamOnRoute(c, i));
    if (!ok) return null;
    if (oneDir(c) && arrowSays(c, at) < 0) return null;   // 설치장소 방향이 내 길과 반대
    return at;
  }
  // 경로 구간 이름을 모르는 곳: 카메라 c 근처(800m 안)에 같은 도로 이름의 다른 카메라가 경로 바로 위(20m 안)에 있으면
  // 경로가 그 도로를 지나는 것으로 본다 (선분 i 앞뒤 80개 안에서)
  function sameRoadCamOnRoute(c, i) {
    const cn = camRoad(c), pts = nav.pts;
    const lo = Math.max(0, i - 80), hi = Math.min(pts.length - 2, i + 80);
    for (const it of camsNear(c[0], c[1], 800)) {
      if (it.c === c || !sameRoad(camRoad(it.c), cn)) continue;
      const q = { lat: it.c[0], lng: it.c[1] };
      for (let j = lo; j <= hi; j++) if (projectSeg(q, pts[j], pts[j + 1]).dist < ROUTE_CAM_NEAR) return true;
    }
    return false;
  }
  // 길안내 중, 경고 거리 안의 카메라가 경로선에서 20~40m 떨어져 있어 경로 위 카메라로 못 잡은 경우의 마지막 확인:
  // 지금 달리는 도로(역지오코딩) 이름과 카메라 도로명이 같고 남은 경로 앞쪽 옆에 있으면 내 도로 카메라로 본다
  function camBesideRouteOnMyRoad(c) {
    if (!onSameRoadName(c)) return false;
    const p = { lat: c[0], lng: c[1] }, pts = nav.pts;
    const lo = Math.max(0, nav.seg), hi = Math.min(pts.length - 2, nav.seg + 120);
    for (let j = lo; j <= hi && nav.cum[j] < nav.along + CAM_SCAN; j++) {
      const pr = projectSeg(p, pts[j], pts[j + 1]);
      if (pr.dist >= ROUTE_CAM_FAR) continue;
      if (nav.cum[j] + pr.t * (nav.cum[j + 1] - nav.cum[j]) < nav.along - 5) continue;
      if (oneDir(c) && pr.dist > OPP_SIDE && sideOfSeg(p, pts[j], pts[j + 1], pr.dist) < 0) return false;
      const atj = nav.cum[j] + pr.t * (nav.cum[j + 1] - nav.cum[j]);
      if (oneDir(c) && arrowSays(c, atj) < 0) return false;
      // 고속도로 위에서는 지금 도로 이름(역지오코딩)이 아래 일반도로로 잡혀도 일반도로 저속 카메라는 알리지 않는다
      if ((/고속도로|고속국도/.test(routeRoadAt(j)) || onHighwayAt(atj)) && c[8] !== 1 && c[2] <= 70) return false;
      return true;
    }
    return false;
  }
  // 경로 위 카메라 목록: 카메라 행 → 경로 위 거리들, 그리고 거리순 목록.
  // 긴 경로를 한 번에 훑으면 그 순간 화면이 멈칫하므로, 차 앞 21km 까지만 찾아 두고 달리면서 조금씩 늘린다.
  const ROUTE_CAM_AHEAD = 21000;
  function ensureRouteCams() {
    if (!cams.loaded || !nav.pts || nav.pts.length < 2) return false;
    if (!nav.routeCams) { nav.routeCams = new Map(); nav.routeCamList = []; nav.routeCamsUpto = 0; }
    const pts = nav.pts, m = nav.routeCams, list = nav.routeCamList, want = nav.along + ROUTE_CAM_AHEAD;
    let i = nav.routeCamsUpto, added = false;
    for (; i < pts.length - 1 && nav.cum[i] < want; i++) {
      const a = pts[i], b = pts[i + 1], half = (nav.cum[i + 1] - nav.cum[i]) / 2;
      for (const it of camsNear((a.lat + b.lat) / 2, (a.lng + b.lng) / 2, half + 30)) {
        const at = camAtSeg(it.c, i);
        if (at === null) continue;
        const arr = m.get(it.c);
        if (arr && arr.some((x) => Math.abs(x - at) < 100)) continue; // 이웃 선분에서 같은 카메라를 또 찾은 것
        if (arr) arr.push(at); else m.set(it.c, [at]);
        list.push({ i: it.i, c: it.c, at });
        added = true;
      }
    }
    nav.routeCamsUpto = i;
    if (added) list.sort((x, y) => x.at - y.at);
    return true;
  }
  // 길안내 중: 카메라가 남은 경로 위(경고 거리 안)에 있는지
  function camOnRouteAhead(c) {
    if (!ensureRouteCams()) return false;
    const arr = nav.routeCams.get(c);
    return !!arr && arr.some((at) => at > nav.along - 5 && at < nav.along + CAM_SCAN + 300);
  }

  function evalCameras(f) {
    const now = f.t;
    camState.passed.forEach((t, i) => { if (now - t > 120000) camState.passed.delete(i); });
    camState.saidById.forEach((v, i) => { if (now - v.t > 180000) camState.saidById.delete(i); });
    if (!cams.loaded || !prefs.cams) { camState.target = null; camState.section = null; renderCam(); return; }
    const moving = state.speedKmh >= 8;
    let tg = camState.target;

    if (tg) {
      const cp = { lat: tg.c[0], lng: tg.c[1] };
      const d = haversine(f, cp);
      tg.d = d;
      if (d < tg.minD) tg.minD = d;
      // 정지 중 GPS 흔들림을 '지나감'으로 오인하지 않도록, 움직이는 중이고 카메라가 뒤쪽에 있을 때만 인정
      const behind = state.heading === null || angleDiff(bearing(f, cp), state.heading) > 90;
      if (!tg.after && tg.minD < 80 && d > tg.minD + 10 && moving && behind) {   // 카메라를 지나감
        // 같은 자리의 반대 방향 카메라(구간 시점·종점 쌍 등)도 함께 지나간 것으로 처리
        const twins = camsNear(tg.c[0], tg.c[1], 60);
        twins.forEach((x) => camState.passed.set(x.i, now));
        camState.passed.set(tg.i, now);
        if (camState.section && (tg.c[4] === 2 || twins.some((x) => x.c[4] === 2))) endSection();
        else if (tg.c[4] === 1) startSection(tg.c, f);
        tg.after = true; // 카메라 좌표 오차를 감안해 지나간 뒤 CAM_HOLD m (후면 단속은 REAR_HOLD m) 까지 경고를 유지한다
      }
      if (tg.after) {
        if (d >= camHold(tg.c)) { // 단속 지점을 다 지났다: 경고를 내리고 '띠링' 한 번
          camState.target = tg = null;
          chime();
          logAlert('beep', '단속 통과 띠링');
        }
      } else if (d > alertRange(tg.c) + 300) {
        camState.target = tg = null;
      } else if (moving && d > 150 && !isAhead(f, tg.c, d, true)) {
        tg.miss = (tg.miss || 0) + 1;                   // 방향을 틀어 벗어남
        if (tg.miss >= 3) camState.target = tg = null;
      } else if (moving && d > 25 && d <= 150 && oneDir(tg.c) && !nav.active &&
                 sideOf(f, tg.c, d) < -(OPP_SIDE + 2)) {
        // 가까이 와서 보니 왼쪽(반대편 차로) 카메라였다: 길안내 없이 멀리서 방향만 보고 잡은 경우
        tg.miss = (tg.miss || 0) + 1;
        if (tg.miss >= 2) camState.target = tg = null;
      } else {
        tg.miss = 0;
      }
    }

    if (moving && (state.heading !== null || nav.active)) {
      let best = null;
      for (const it of camsNear(f.lat, f.lng, CAM_SCAN)) {
        if (it.d > alertRange(it.c)) continue; // 도로 종류별 경고 거리 밖
        if (camState.passed.has(it.i) || (tg && it.i === tg.i)) continue;
        if (it.c[4] === 2 && !camState.section) continue; // 구간 끝 카메라는 구간 안에서만
        if (it.c[4] === 1 && camState.section) continue;  // 구간 안에서는 (반대 방향) 시작 카메라를 무시
        if (!isAhead(f, it.c, it.d)) continue;
        if (!best || it.d < best.d) best = it;
      }
      if (best && (!tg || best.d < tg.d - 30)) {
        // 굽은 길에서 잠깐 놓쳤다 다시 잡혀도 같은 안내를 반복하지 않게 이전 안내 기록을 이어 쓴다
        let rec = camState.saidById.get(best.i);
        if (!rec) { rec = { said: {}, t: now }; camState.saidById.set(best.i, rec); }
        rec.t = now;
        camState.target = tg = { i: best.i, c: best.c, d: best.d, minD: best.d, first: best.d, said: rec.said };
      }
    }

    const s = camState.section;
    if (s) {
      const done = state.odo - s.d0;
      // 끝 카메라를 못 지나간 것으로 보일 때의 안전장치. 길안내 경로에서 끝 카메라가 앞에 보이면 길이로 끝내지 않는다
      // (데이터의 구간 길이는 어림값이라 실제보다 짧을 수 있다)
      const routeKnows = sectionRemainRoute(s) !== null;
      if ((!routeKnows && s.len && done > s.len * 1.3 + 400) || now - s.t0 > 45 * 60000) endSection();
    }
    if (tg) announceCam(tg, f);
    // 경고 거리 밖의 다음 카메라를 3초마다 미리 찾아 둔다 ('다음 단속 2.4km').
    // 길안내 중에는 경로 위 카메라 중 다음 것(경로 거리, 20km 까지), 아니면 앞쪽 4km 안
    if (!tg && moving && f.t - (camState.peekAt || 0) > 3000) {
      camState.peekAt = f.t;
      let nx = null;
      if (nav.active && nav.pts) {
        ensureRouteCams();
        for (const it of nav.routeCamList || []) {
          const ahead = it.at - nav.along;
          if (ahead <= 0) continue;
          if (ahead > 20000) break;
          if (!camWanted(it.c) || camState.passed.has(it.i) || it.c[4] === 2) continue;
          if (haversine(f, { lat: it.c[0], lng: it.c[1] }) <= alertRange(it.c)) continue;
          nx = { i: it.i, c: it.c, at: it.at };
          break;
        }
      } else {
        for (const it of camsNear(f.lat, f.lng, 4000)) {
          if (it.d <= alertRange(it.c) || camState.passed.has(it.i) || it.c[4] === 2) continue;
          if (!isAhead(f, it.c, it.d)) continue;
          if (!nx || it.d < nx.d) nx = it;
        }
      }
      camState.peek = nx;
    } else if (tg || !moving) {
      camState.peek = null;
    }
    renderCam();
  }

  function announceCam(tg, f) {
    const c = tg.c, limit = c[2], d = tg.d;
    // 단속 카메라 600m 앞부터 지나갈 때까지 제한을 넘으면 주행 기록에 (카메라마다 한 번, 가장 빨랐던 속도로)
    if (isSpeedCam(c) && d < 600 && state.speedKmh > limit + 1) {
      const kmh = Math.round(state.speedKmh);
      if (!tg.said.evt) tg.said.evt = tripEvent({ kind: 'cam', label: camLabel(c), limit, kmh, lat: c[0], lng: c[1] });
      else if (kmh > tg.said.evt.kmh) { tg.said.evt.kmh = kmh; }
    }
    if (tg.after && !(state.speedKmh > limit + 1 && isSpeedCam(c))) return;
    if (!isSpeedCam(c)) { // 신호 전용 카메라: 짧게 한 번만 알린다 (속도 경고 없음)
      if (!tg.said.far && d <= 300) { tg.said.far = true; say('300미터 앞, 신호 단속 카메라입니다.', 1); }
      return;
    }
    const far = voiceRange(c); // 고속도로 2km · 고속화도로 1km · 일반도로 400m
    if (!tg.said.far && d <= far + 30) {
      tg.said.far = true;
      const dd = d >= 950 ? Math.round(d / 1000) + '킬로미터' : Math.max(100, Math.round(d / 100) * 100) + '미터';
      say(dd + ' 앞, ' + camLabel(c).replace('·', ' ') + '. 제한속도 ' + limit + '입니다.', 2);
    }
    const over = state.speedKmh > limit + 1;
    if (!tg.said.near && d <= 250) {
      tg.said.near = true;
      if (over) say('속도를 줄이세요. 제한속도 ' + limit + '.', 3, true);
      else { beep(1, 660); logAlert('beep', '카메라 250m 전 알림음'); }
    } else if (over && (tg.said.near || tg.after) && d <= 300 && f.t - camState.lastOverBeep >= 900) {
      // 과속 중에는 1초에 한 번, 짧게 한 번만 울린다 (GPS 가 1초에 한 번 오므로 900ms 로 둬서 한 번씩 빠지지 않게)
      camState.lastOverBeep = f.t;
      beep(1, 1040);
      logAlert('beep', '과속 반복 경고음 (' + Math.round(d) + 'm)');
    }
  }

  function startSection(c, f) {
    camState.section = { limit: c[2], len: c[5] || 0, t0: f.t, d0: state.odo };
    say('구간단속 시작. 제한속도 ' + c[2] + '.', 2);
  }
  function endSection() {
    const s = camState.section;
    if (!s) return;
    // 구간 평균이 제한을 넘었으면 주행 기록에 남긴다
    const st = sectionStats(s);
    if (st.over && st.avg !== null) {
      tripEvent({ kind: 'sec', label: '구간단속', limit: s.limit, kmh: Math.round(st.avg), km: Math.round(st.done / 100) / 10 });
    }
    camState.section = null;
    say('구간단속이 끝났습니다.', 1);
  }

  function renderCam() {
    const tg = camState.target, card = $('#camCard');
    const pk = camState.peek, nxEl = $('#camNext');
    nxEl.hidden = !(pk && prefs.cams && !tg);
    if (!nxEl.hidden) {
      // 길안내 중이면 경로를 따라간 거리, 아니면 직선 거리
      const d = pk.at != null && nav.active ? Math.max(0, pk.at - nav.along)
        : state.fix ? haversine(state.fix, { lat: pk.c[0], lng: pk.c[1] }) : pk.d;
      // 테슬라 모드에서는 '다음 단속' 글자 없이 제한속도 표지 + 거리만 (표지만 봐도 안다). 글자는 화면 읽기용으로 남긴다
      nxEl.innerHTML = '<span class="mini-sign' + (pk.c[3] === 3 ? ' k3' : '') + '">' + pk.c[2] + '</span><span class="nx-label">다음 단속 </span><b>' + fmtDist(d) + '</b>';
      nxEl.setAttribute('aria-label', '다음 단속 ' + fmtDist(d));
    }
    if (!tg || !prefs.cams) {
      // 테슬라 모드에서 서랍이 열려 있으면 위로 접히는 동안(0.36초)은 내용을 그대로 두었다가 숨긴다.
      // 서랍에 남는 것(구간단속·하이패스)이 있으면 접지 않고 카드만 뺀다
      if (!card.hidden && drawerAnimated() && !drawerKeeps('#camCard')) startDrawerClose();
      else if (!drawer.closing) card.hidden = true;
    } else {
      cancelDrawerClose();
      card.hidden = false;
      const speedCam = isSpeedCam(tg.c);
      $('#camLimit').textContent = speedCam ? tg.c[2] : '신호';
      // 지나간 뒤에도 CAM_HOLD(30m)까지는 카메라 바로 앞인 것처럼 그대로 보여 주고(오차 거리는 따로 알리지 않음), 그 뒤 사라진다
      $('#camType').textContent = camLabel(tg.c);
      $('#camDist').textContent = tg.after ? '0m' : fmtDist(tg.d);
      const span = Math.max(tg.first, 300);
      $('#camBar').style.width = tg.after ? '100%' : Math.max(0, Math.min(100, (1 - tg.d / span) * 100)) + '%';
      card.classList.toggle('over', speedCam && state.speedKmh > tg.c[2] + 1 && tg.d < 600);
      card.classList.toggle('signal', !speedCam);
      card.classList.toggle('mobile', tg.c[3] === 8); // 이동식 단속은 파란색
      card.classList.toggle('box', isBox(tg.c));       // 박스형은 종류 글자를 주황으로
      card.classList.toggle('sigspeed', tg.c[3] === 3); // 신호·과속: 표지 위에 작은 신호등
      // 어린이·노인 보호구역: 도로 주의 표지 모양 타일 (삼각 표지 + 빨간 띠에 남은 거리 + '어린이보호' 와 제한속도)
      const zone = tg.c[6] === 2 ? 'kid' : tg.c[6] === 1 ? 'elder' : '';
      card.classList.toggle('zonecam', !!zone);
      if (zone) {
        const sign = $('#ztSign');
        if (sign.dataset.zone !== zone) { sign.innerHTML = zone === 'kid' ? SIGN_KID : SIGN_ELDER; sign.dataset.zone = zone; }
        $('#ztDist').textContent = tg.after ? '0m' : fmtDist(tg.d);
        $('#ztLabel').textContent = zone === 'kid' ? '어린이보호' : '노인보호';
        $('#ztLimit').textContent = speedCam ? tg.c[2] : '신호';
      }
      // 테슬라 모드: 과속 정보 밑에 작은 주의 표지 (CSS 가 테슬라 모드에서만 보여 준다)
      const zb = $('#zoneBadge');
      zb.hidden = !zone;
      if (zone && zb.dataset.zone !== zone) {
        $('#zbSign').innerHTML = zone === 'kid' ? SIGN_KID : SIGN_ELDER;
        $('#zbLabel').textContent = zone === 'kid' ? '어린이 조심' : '어르신 조심';
        zb.dataset.zone = zone;
      }
    }
    if (card.hidden) $('#zoneBadge').hidden = true;
    renderSection();
    renderCamAvg();
    renderMySpeed();
    renderLimit();
    syncDrawer();
  }
  // ---------- 단속 서랍 (테슬라 모드: 길안내 패널 밑에서 스르륵) ----------
  // 안의 것(단속 카드·내 속도·보호구역 표지·구간단속 카드·하이패스) 중 하나라도 보이면 열고, 다 숨으면 접는다
  const drawer = { t: 0, hideT: 0, closing: false };
  const DRAWER_ITEMS = ['#juncCard', '#camCard', '#mySpeed', '#zoneBadge', '#secCard', '#tollCard'];
  const drawerAnimated = () => !testPage && $('#app').classList.contains('tesla') && $('#camDrawer').classList.contains('open');
  // q 를 빼도 서랍에 남는 것이 있는지 (내 속도·보호구역 표지는 단속 카드에 딸려 함께 빠진다)
  const drawerKeeps = (q) => ['#juncCard', '#secCard', '#tollCard'].some((x) => x !== q && !$(x).hidden) ||
    (q !== '#camCard' && !$('#camCard').hidden);
  function syncDrawer() {
    const dr = $('#camDrawer');
    if (drawer.closing) return;
    const any = DRAWER_ITEMS.some((q) => !$(q).hidden);
    if (any === dr.classList.contains('open')) return;
    clearTimeout(drawer.t);
    // 처음 보일 때 접힌 상태에서 한 번 그린 뒤 열어야 내려오는 움직임이 보인다
    if (any) { if (testPage) dr.classList.add('open'); else drawer.t = setTimeout(() => dr.classList.add('open'), 30); }
    else dr.classList.remove('open');
  }
  function startDrawerClose() {
    if (drawer.closing) return;
    drawer.closing = true;
    $('#camDrawer').classList.remove('open');
    drawer.hideT = setTimeout(() => {
      drawer.closing = false;
      if (!camState.target) $('#camCard').hidden = true;
      if (!tollState.g) $('#tollCard').hidden = true;
      if (!juncState.g) $('#juncCard').hidden = true;
      syncDrawer();
    }, 360);
  }
  function cancelDrawerClose() {
    if (!drawer.closing) return;
    clearTimeout(drawer.hideT);
    drawer.closing = false;
  }
  // 구간단속 계산: 평균 속도, 남은 거리, 평균을 넘었을 때 남은 구간에서 지킬 속도(need)
  function sectionStats(s) {
    const now = state.fix ? state.fix.t : Date.now();
    const dt = (now - s.t0) / 1000, done = state.odo - s.d0;
    const avg = dt >= 8 ? done / dt * 3.6 : null;
    const remain = sectionRemain(s, done);
    const over = avg !== null && avg > s.limit;
    let need = null;
    // 평균이 제한을 넘었으면, 끝까지 남은 거리를 이 속도 이하로 달리면 평균이 제한 안으로 들어온다
    if (over && remain !== null && remain > 150) {
      const leftS = (done + remain) / (s.limit / 3.6) - dt; // 제한속도로 달렸을 때 걸렸을 시간 - 이미 쓴 시간
      need = leftS > 0 ? remain / leftS * 3.6 : 0;
    }
    return { avg, done, remain, over, need };
  }
  function renderSection() {
    const s = camState.section, card = $('#secCard');
    if (!s) { card.hidden = true; return; }
    card.hidden = false;
    const st = sectionStats(s);
    $('#secLimit').textContent = s.limit;
    $('#secAvg').textContent = st.avg === null ? '-' : Math.round(st.avg);
    let line = st.remain !== null ? '남은 거리 ' + fmtDist(st.remain) : fmtDist(st.done) + ' 주행';
    if (st.need !== null) {
      if (st.need >= 20) {
        line += ' · ' + Math.floor(st.need) + ' km/h 이하로';
        if (!s.warned) { s.warned = true; say('구간 평균 속도가 제한을 넘었습니다. 남은 구간은 ' + Math.floor(st.need) + ' 이하로 달리세요.', 2); }
      } else {
        line += ' · 평균 초과';
      }
    }
    $('#secRemain').textContent = line;
    card.classList.toggle('over', st.over);
  }
  // 경고 카드(예: '구간단속 끝 1.4km') 오른쪽 끝에 구간 평균 속도를 붙인다
  // 테슬라 모드에서 단속 경고가 떠 있으면 바로 밑에 내 속도 (구간단속 중이거나 속도 카메라 앞). 제한을 넘으면 빨갛게
  function renderMySpeed() {
    const el = $('#mySpeed'), tg = camState.target, s = camState.section;
    const lim = !prefs.cams ? null : s ? s.limit : tg && isSpeedCam(tg.c) ? tg.c[2] : null;
    if (!lim) { el.hidden = true; return; }
    el.hidden = false;
    $('#mySpeedVal').textContent = Math.round(state.speedKmh);
    $('#mySpeedLim').textContent = '제한 ' + lim;
    el.classList.toggle('over', state.speedKmh > lim + 1);
  }
  function renderCamAvg() {
    const el = $('#camAvg'), hint = $('#camHint'), s = camState.section;
    if (!s || !camState.target) { el.hidden = true; hint.hidden = true; return; }
    const st = sectionStats(s);
    el.hidden = false;
    el.classList.toggle('over', st.over);
    el.innerHTML = '<small>평균</small><b>' + (st.avg === null ? '-' : Math.round(st.avg)) + '</b><i>km/h</i>';
    // 평균을 넘었을 때만 게이지 밑에 한 줄로: 남은 구간에서 지킬 속도
    const need = st.need !== null && st.need >= 20 ? '남은 구간 ' + Math.floor(st.need) + ' km/h 이하로' : st.over ? '구간 평균 초과' : '';
    hint.hidden = !need;
    hint.textContent = need;
  }
  // 구간단속 남은 거리: 길안내 중이면 경로 위 구간 끝 카메라까지의 실제 거리(데이터의 구간 길이는 어림값이거나 비어 있음),
  // 아니면 데이터의 구간 길이 - 달린 거리. 모르면 null
  function sectionRemainRoute(s) {
    if (!(nav.active && nav.pts)) return null;
    ensureRouteCams();
    for (const x of nav.routeCamList || []) {
      if (x.c[4] !== 2 || x.c[2] !== s.limit) continue;
      const ahead = x.at - nav.along;
      if (ahead < -20) continue;
      if (ahead > Math.max(s.len || 0, 5000) * 1.5) break;
      return Math.max(0, ahead);
    }
    return null;
  }
  function sectionRemain(s, done) {
    const r = sectionRemainRoute(s);
    if (r !== null) return r;
    return s.len ? Math.max(0, s.len - done) : null;
  }
  function currentLimit() {
    if (camState.section) return camState.section.limit;
    const tg = camState.target;
    return tg && tg.d < 1000 && isSpeedCam(tg.c) ? tg.c[2] : null;
  }
  function renderLimit() {
    const lim = currentLimit();
    $('#limitSign').hidden = !lim;
    if (lim) $('#limitVal').textContent = lim;
    $('#speed').classList.toggle('over', !!lim && state.speedKmh > lim + 1);
  }
  function refreshCamMarkers(f) {
    if (!mapA || !mapA.setCameras) return;
    if (!cams.loaded || !prefs.cams) { mapA.setCameras([]); camState.markerAt = null; return; }
    // 250m 넘게 움직였거나(길안내 없이는 방향이 30° 넘게 바뀌어도) 다시 고른다
    const turned = !nav.active && state.heading !== null && camState.markerHdg != null && angleDiff(state.heading, camState.markerHdg) > 30;
    if (camState.markerAt && haversine(camState.markerAt, f) < 250 && !turned) return;
    camState.markerAt = { lat: f.lat, lng: f.lng };
    camState.markerHdg = state.heading;
    if (nav.active && nav.pts) {
      // 길안내 중에는 경로 위 카메라만 지도에 (조금 전 지나온 것부터 앞쪽 5km 까지)
      ensureRouteCams();
      mapA.setCameras((nav.routeCamList || []).filter((x) => x.at > nav.along - 100 && x.at < nav.along + 5000 && camWanted(x.c))
        .map((x) => ({ i: x.i, c: x.c, d: x.at - nav.along })).slice(0, 80));
      return;
    }
    // 길안내 없이: 내가 달리는 길·방향 앞의 카메라만 지도에 (반대편 차로·옆 도로·지나온 카메라는 표시하지 않음).
    // 경고 대상을 새로 고를 때와 같은 엄격한 기준을 쓴다: 왼쪽(반대편 차로 쪽)으로 보이는 한 방향 카메라는
    // 300m 안에 들어와 판단될 때까지 지도에도 띄우지 않는다. 방향을 아직 모르면(출발 전) 가까운 카메라를 보여 준다
    const tg = camState.target;
    const list = camsNear(f.lat, f.lng, 2000).filter((x) => camWanted(x.c) &&
      (state.heading === null || (tg && x.i === tg.i) || isAhead(f, x.c, x.d, false)));
    mapA.setCameras(list.sort((a, b) => a.d - b.d).slice(0, 80));
  }

  // ---------- 길안내 ----------
  const nav = {
    active: false, preview: false, dest: null, route: null, pts: null, cum: null, total: 0,
    seg: 0, along: 0, remain: null, next: null, dg: null, gi: 0, guides: [], said: {},
    off: 0, lastReroute: 0, busy: false, lastTraffic: 0, rerouted: false, quickLeft: 0, routeMs: 0,
    onRoute: false, onCount: 0, gap: 12000, gen: 0, byDemo: false,
    routeCams: null, routeCamList: [], // 경로 위 카메라 (경로가 바뀌면 다시 계산)
  };

  function recents() { try { return JSON.parse(store.get('recent') || '[]'); } catch (e) { return []; } }
  function addRecent(p) {
    const list = recents().filter((x) => !(x.name === p.name && Math.abs(x.lat - p.lat) < 1e-5));
    list.unshift({ name: p.name, addr: p.addr || '', category: p.category || '', lat: p.lat, lng: p.lng });
    store.set('recent', JSON.stringify(list.slice(0, 8)));
  }

  // ---------- 즐겨찾기: 집 · 회사 · 별표 장소 (이 차 브라우저에 저장) ----------
  function favs() {
    try {
      const f = JSON.parse(store.get('favs') || '{}');
      return { home: f.home || null, work: f.work || null, list: Array.isArray(f.list) ? f.list : [] };
    } catch (e) { return { home: null, work: null, list: [] }; }
  }
  const samePlace = (a, b) => !!a && !!b && a.name === b.name && Math.abs(a.lat - b.lat) < 1e-4 && Math.abs(a.lng - b.lng) < 1e-4;
  const slimPlace = (p) => ({ name: p.name, addr: p.addr || '', category: p.category || '', lat: p.lat, lng: p.lng });
  function favKind(p) {
    const f = favs();
    if (samePlace(f.home, p)) return 'home';
    if (samePlace(f.work, p)) return 'work';
    return f.list.some((x) => samePlace(x, p)) ? 'fav' : '';
  }
  // kind: 'fav' 별표 · 'home' 집 · 'work' 회사 · 'remove' 빼기
  function setFav(p, kind) {
    const f = favs(), it = slimPlace(p);
    if (kind === 'home') f.home = it;
    else if (kind === 'work') f.work = it;
    else if (kind === 'fav') { if (!f.list.some((x) => samePlace(x, it))) f.list.unshift(it); f.list = f.list.slice(0, 20); }
    else {
      f.list = f.list.filter((x) => !samePlace(x, it));
      if (samePlace(f.home, it)) f.home = null;
      if (samePlace(f.work, it)) f.work = null;
    }
    store.set('favs', JSON.stringify(f));
  }
  const FAV_DONE = { fav: '즐겨찾기에 넣었어요', home: '집으로 저장했어요', work: '회사로 저장했어요', remove: '즐겨찾기에서 뺐어요' };

  let searchView = null; // 지금 보이는 목록 (별표를 바꾼 뒤 그대로 다시 그리기 위해)
  // 검색 용도: 'dest' 목적지, 'via' 길안내 중 경유지 고르기
  let searchFor = 'dest';
  const Q_PLACEHOLDER = $('#q').placeholder;
  function openSearch(mode) {
    searchFor = mode === 'via' ? 'via' : 'dest';
    $('#q').placeholder = searchFor === 'via' ? '경유지 검색 (장소 이름이나 주소)' : Q_PLACEHOLDER;
    $('#searchSheet').hidden = false;
    renderStart();
    setTimeout(() => $('#q').focus(), 50);
  }
  function closeSearch() { $('#searchSheet').hidden = true; }
  // 집·회사 그림 (네이버 지도 즐겨찾기처럼 한 색 그림, 창문·문은 뚫어서 바탕이 비친다). 관리 페이지에서 fav_home·fav_work 로 바꿀 수 있다
  const QUICK_ICON = {
    home: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M12 2.6 1.9 10.7c-.8.6-.3 1.9.7 1.9H4.6v7.9c0 .8.6 1.4 1.4 1.4h4.1v-5.6c0-.5.4-.9.9-.9h2c.5 0 .9.4.9.9v5.6h4.1c.8 0 1.4-.6 1.4-1.4v-7.9h2c1 0 1.5-1.3.7-1.9z"/></svg>',
    work: '<svg viewBox="0 0 24 24"><path fill="currentColor" fill-rule="evenodd" d="M4 21.4V4.4C4 3.6 4.6 3 5.4 3h9.2c.8 0 1.4.6 1.4 1.4V9h2.6c.8 0 1.4.6 1.4 1.4v11zM7 6v2.2h2.2V6zm4 0v2.2h2.2V6zM7 10v2.2h2.2V10zm4 0v2.2h2.2V10zM7 14v2.2h2.2V14zm4 0v2.2h2.2V14zm6-2v2h1.6v-2zm0 3.6v2h1.6v-2zM9 18.2v3.2h3v-3.2z"/></svg>',
  };
  // 검색창을 열었을 때: 집·회사 바로가기, 즐겨찾기, 최근 목적지
  function renderStart() {
    const f = favs();
    // 2026-11-14 요청: 집·회사 버튼 앞에 그림(집 / 회사 건물), 아직 안 정했을 때의 안내 글('검색 결과의 ☆ 로 지정')은 뺀다
    const chip = (key, label, it) => '<button class="qchip' + (it ? '' : ' unset') + '" data-q="' + key + '">' +
      '<i class="qic" aria-hidden="true">' + (pickImg('fav_' + key) || QUICK_ICON[key]) + '</i><span class="qt"><b>' + label + '</b>' +
      (it ? '<span>' + esc(it.name) + '</span>' : '') + '</span></button>';
    const head = '<div class="quick">' + chip('home', '집', f.home) + chip('work', '회사', f.work) + '</div>';
    const rec = recents().filter((r) => !f.list.some((x) => samePlace(x, r)));
    renderSections([{ title: '즐겨찾기', items: f.list }, { title: '최근 목적지', items: rec }],
      '즐겨찾기와 최근 목적지가 없습니다. 장소 이름이나 주소를 검색하세요.', head);
    $('#results').querySelectorAll('.qchip').forEach((b) => {
      b.onclick = () => {
        const it = favs()[b.dataset.q];
        if (it) pickDest(it);
        else toast('장소를 검색한 뒤 결과 옆 ☆ 를 눌러 "' + (b.dataset.q === 'home' ? '집' : '회사') + '으로"를 고르세요.', '', 4500);
      };
    });
  }
  function renderResults(items, title, emptyNote) {
    renderSections([{ title, items }], emptyNote);
  }
  // 목록 그리기: 장소마다 [장소 버튼][☆ 버튼], ☆ 를 누르면 그 밑에 즐겨찾기·집·회사·빼기 고르기
  function renderSections(sections, emptyNote, head) {
    const box = $('#results');
    searchView = { sections, emptyNote, head };
    const flat = [];
    let html = head || '';
    sections.forEach((s) => {
      if (!s.items || !s.items.length) return;
      html += (s.title ? '<div class="rtitle">' + esc(s.title) + '</div>' : '') + s.items.map((it) => {
        const k = flat.push(it) - 1;
        const dist = state.fix ? fmtDist(haversine(state.fix, it)) : '';
        const sub = [it.category, it.addr].filter(Boolean).join(' · ');
        const fk = favKind(it);
        const tag = fk === 'home' ? '<span class="ftag">집</span>' : fk === 'work' ? '<span class="ftag">회사</span>' : '';
        return '<div class="rrow"><button class="result" data-k="' + k + '"><div><div class="nm">' + tag + esc(it.name) + '</div>' +
          (sub ? '<div class="sub">' + esc(sub) + '</div>' : '') + '</div><div class="dist">' + dist + '</div></button>' +
          '<button class="star' + (fk ? ' on' : '') + '" data-k="' + k + '" aria-label="즐겨찾기">' + (fk ? '★' : '☆') + '</button></div>' +
          '<div class="favmenu" data-k="' + k + '" hidden>' +
          '<button data-a="fav">★ 즐겨찾기</button><button data-a="home">집으로</button><button data-a="work">회사로</button>' +
          (fk ? '<button data-a="remove">빼기</button>' : '') + '</div>';
      }).join('');
    });
    if (!flat.length) { box.innerHTML = (head || '') + '<div class="empty">' + esc(emptyNote || '결과가 없습니다.') + '</div>'; return; }
    box.innerHTML = html;
    box.querySelectorAll('.result').forEach((b) => { b.onclick = () => pickDest(flat[+b.dataset.k]); });
    box.querySelectorAll('.star').forEach((b) => {
      b.onclick = () => {
        const m = box.querySelector('.favmenu[data-k="' + b.dataset.k + '"]');
        box.querySelectorAll('.favmenu').forEach((x) => { if (x !== m) x.hidden = true; });
        m.hidden = !m.hidden;
      };
    });
    box.querySelectorAll('.favmenu button').forEach((b) => {
      b.onclick = () => {
        const it = flat[+b.parentNode.dataset.k], a = b.dataset.a;
        setFav(it, a);
        toast(FAV_DONE[a], '', 2000);
        // 검색창이 비어 있으면 첫 화면(집·회사·즐겨찾기)을, 아니면 지금 목록을 다시 그린다
        if (!$('#q').value.trim()) renderStart(); else renderSections(searchView.sections, searchView.emptyNote, searchView.head);
      };
    });
  }
  let searchSeq = 0;
  async function doSearch(live) {
    const q = $('#q').value.trim();
    if (!q) return;
    const seq = ++searchSeq;
    // 입력 중 자동 검색은 이전 결과를 그대로 두고 조용히 바꾼다 (깜빡임 방지)
    if (!live || !$('#results .result')) $('#results').innerHTML = '<div class="empty">검색 중…</div>';
    const near = state.fix ? state.fix.lng.toFixed(6) + ',' + state.fix.lat.toFixed(6) : null;
    const [poi, geo] = await Promise.allSettled([
      api('/search', { query: q }),
      api('/geocode', near ? { query: q, near } : { query: q }),
    ]);
    if (seq !== searchSeq) return; // 더 최근 검색이 있으면 이 결과는 버린다
    const items = [], seen = new Set();
    [poi, geo].forEach((r) => {
      if (r.status !== 'fulfilled') return;
      (r.value.items || []).forEach((it) => {
        if (!isFinite(it.lat) || !isFinite(it.lng) || !it.lat) return;
        const k = it.name + '|' + it.lat.toFixed(4) + ',' + it.lng.toFixed(4);
        if (seen.has(k)) return;
        seen.add(k);
        items.push(it);
      });
    });
    // 장소 이름 검색(네이버 검색 API)이 아직 설정되지 않았으면 주소만 찾힌다는 것을 알려 준다
    const poiOff = poi.status === 'fulfilled' && poi.value.note === 'search api not configured';
    const hint = poiOff ? '지금은 주소만 찾을 수 있어요 (예: 진황도로 14). 가게·건물 이름 검색은 장소 검색 키를 연결하면 됩니다.' : '';
    if (!items.length) {
      const err = geo.status === 'rejected' ? geo.reason : (poi.status === 'rejected' ? poi.reason : null);
      renderResults([], '', err
        ? '검색 서버 오류: ' + err.message
        : (hint || '결과가 없습니다. 다른 이름이나 정확한 주소로 검색해 보세요.'));
      return;
    }
    if (state.fix) items.sort((a, b) => haversine(state.fix, a) - haversine(state.fix, b));
    renderResults(items, '검색 결과');
    if (hint) $('#results').insertAdjacentHTML('beforeend', '<div class="empty">' + esc(hint) + '</div>');
  }
  // 입력하는 동안 0.45초 멈추면 자동으로 찾는다 (2글자부터)
  let qTimer = 0;
  function onQueryInput() {
    clearTimeout(qTimer);
    const v = $('#q').value.trim();
    if (v.length < 2) {
      searchSeq++;
      renderStart();
      return;
    }
    qTimer = setTimeout(() => doSearch(true), 450);
  }
  // ---------- 목적지 주차장 입구 (2026-11-14 요청: 사람이 들어가는 정문이 아니라 차가 들어가는 주차장 입구로) ----------
  // 네이버 장소 검색에는 아파트·백화점 같은 곳의 '…주차장입구'가 '도로시설>방면정보'로 따로 올라 있다
  // (예: '잠실엘스아파트서문방면주차장입구', '기흥역롯데캐슬레이시티주차장입구'). 목적지 이름에서 '101동입구'·'정문' 같은 꼬리를 떼고
  // '<이름> 주차장입구'로 찾아, 이름이 맞고 600m 안에 있는 입구 중 목적지에 가장 가까운 곳으로 경로를 잡는다.
  // 목적지 이름·핀은 그대로 두고, 경로 카드에서 '정문으로'를 누르면 원래 자리로 다시 찾는다
  function placeBase(name) {
    let s = String(name || '').trim();
    for (let k = 0; k < 3; k++) {
      s = s.replace(/\s*(정문|후문|주출입구|출입구|입구|앞)$/, '').replace(/\s*([0-9]+|[A-Za-z])동$/, '').replace(/\s*[0-9]+단지$/, '').trim();
    }
    return s;
  }
  const squash = (x) => String(x || '').replace(/\s+/g, '');
  async function findParking(dest) {
    if (!dest || !dest.name || /주차/.test(dest.name + ' ' + (dest.category || ''))) return null;
    const base = placeBase(dest.name), b = squash(base);
    if (b.length < 3) return null;
    let res;
    try { res = await api('/search', { query: base + ' 주차장입구' }, null, 2500); } catch (e) { return null; }
    const cands = ((res && res.items) || []).filter((it) => {
      const n = squash(it.name);
      if (!/주차.*입구/.test(n) || /출구/.test(n) || !isFinite(it.lat) || !isFinite(it.lng)) return false;
      if (!(n.includes(b) || (b.length >= 5 && n.includes(b.slice(0, b.length - 2))))) return false;
      return haversine(dest, it) <= 600;
    }).map((it) => ({ name: it.name, lat: it.lat, lng: it.lng, d: Math.round(haversine(dest, it)) }));
    cands.sort((x, y) => x.d - y.d);
    return cands[0] || null;
  }
  // 경로의 도착점: 주차장 입구를 찾았으면 그곳 (정문으로 바꾸면 원래 자리)
  const goalOf = (d) => (d.park && !d.parkOff ? d.park : d);
  let pickSeq = 0;
  async function pickDest(it) {
    closeSearch();
    // 길안내 중 경유지 고르기: 목적지는 그대로, 고른 곳을 거쳐 가는 경로로 바로 다시 찾는다
    if (searchFor === 'via' && nav.active && nav.dest) {
      searchFor = 'dest';
      nav.via = [{ name: it.name, lat: it.lat, lng: it.lng }];
      toast('경유지 ' + it.name + ' 을(를) 거쳐 가는 경로를 찾는 중…', '', 3000);
      planRoute(nav.dest, 'via');
      return;
    }
    addRecent(it);
    nav.via = []; // 새 목적지는 경유지 없이
    const seq = ++pickSeq, dest = { name: it.name, addr: it.addr || '', lat: it.lat, lng: it.lng, category: it.category || '' };
    toast('경로를 찾는 중…', '', 3000);
    const park = await findParking(dest);
    if (seq !== pickSeq) return; // 그사이 다른 목적지를 골랐다
    if (park) dest.park = park;
    planRoute(dest, false);
  }

  async function planRoute(dest, reroute) {
    if (!state.fix) { toast('현재 위치를 아직 모릅니다. GPS 신호를 기다려 주세요.', 'bad', 5000); return; }
    if (reroute && nav.busy) return;
    const gen = ++nav.gen; // 새 목적지를 고르거나 안내를 끝내면 늦게 온 이전 응답은 버린다
    nav.busy = true;
    if (!reroute) toast('경로를 찾는 중…', '', 3000);
    try {
      // 처음 길찾기는 추천 경로 여러 개(추천·빠른 길·무료 도로)를 받아 고르게 하고,
      // 교통 갱신은 지금 안내 중인 옵션으로, 경로 이탈 재탐색은 같은 목적지를 '추천' 경로로 다시 묻는다
      // 달리는 중 다시 찾을 때(경로 이탈·재추천)는 답을 기다리는 동안 갈 거리만큼 앞에서 출발하는 경로를 묻는다
      const ahead = reroute === true || reroute === 'manual';
      const startOf = () => { const s0 = ahead ? rerouteStart() : state.fix; return s0.lng.toFixed(6) + ',' + s0.lat.toFixed(6); };
      const q = {
        start: startOf(),
        goal: goalOf(dest).lng.toFixed(6) + ',' + goalOf(dest).lat.toFixed(6),
      };
      // reroute: false 새 목적지(추천 경로 여럿) · 'traffic' 교통 갱신 · 'compare' 길안내 중 경로 비교(추천 경로 여럿, 안내는 계속)
      //          · 'manual' 재추천 버튼 · 'via' 경유지 추가/빼기 · 그 밖 경로 이탈 재탐색
      if (reroute === 'traffic') q.option = nav.option || prefs.routeOpt;
      else if (reroute === 'compare' || !reroute) q.options = ALT_OPTIONS;
      else q.option = rerouteOption();
      // 경유지가 있으면 모든 길찾기(재탐색·교통 갱신·비교 포함)에 같이 보낸다
      if (nav.via && nav.via.length) q.waypoints = nav.via.map((v) => v.lng.toFixed(6) + ',' + v.lat.toFixed(6)).join('|');
      if (reroute === 'compare' || reroute === 'manual') toast(reroute === 'compare' ? '다른 경로를 찾는 중…' : '추천 경로를 다시 찾는 중…', '', 3000);
      // 차량 LTE 가 느릴 수 있어 20초까지 기다리고, 시간 초과면 한 번 더 시도한다.
      // 경로 이탈 재탐색은 늦게 온 답이 이미 쓸모없으므로(차가 그만큼 더 갔다) 9초에 끊고, 지금 자리에서 다시 묻는다
      const waitMs = reroute === true ? 9000 : 20000, t0 = Date.now();
      let res;
      try { res = await api('/route', q, null, waitMs); } catch (e1) {
        if (e1.name !== 'AbortError' && !/abort/i.test(e1.message)) throw e1;
        if (gen !== nav.gen) return;
        if (ahead) q.start = startOf();
        res = await api('/route', q, null, waitMs);
      }
      const took = Date.now() - t0; // 다음 재탐색 출발점을 얼마나 앞에 둘지 정하는 데 쓴다
      nav.routeMs = nav.routeMs ? Math.round(nav.routeMs * 0.6 + took * 0.4) : took;
      if (gen !== nav.gen || (reroute && !nav.active)) return;
      // 응답에 경로가 비어 있으면 지금 안내를 그대로 두고 실패로 처리한다
      const okRoute = (x) => x && Array.isArray(x.path) && x.path.length >= 2;
      if (!(okRoute(res) || (res && Array.isArray(res.alternatives) && res.alternatives.some(okRoute)))) {
        const err = new Error('empty route');
        err.detail = { message: '경로 응답이 비어 있습니다', keys: Object.keys(res || {}).join(',') };
        throw err;
      }
      if (res.alternatives) res.alternatives = res.alternatives.filter(okRoute);
      if (reroute === 'compare') { // 길안내는 그대로 두고 경로 카드에 '지금 경로'와 다른 경로들을 띄운다
        nav.compareBase = { route: nav.route, option: nav.option };
        nav.alts = dedupAlts(res.alternatives || [res]);
        nav.altIdx = -1; // -1 = 지금 경로
        nav.comparing = true;
        $('#toast').hidden = true;
        drawAltLines();
        showRouteCard();
        return;
      }
      let r = res;
      if (!reroute) {
        nav.alts = dedupAlts(res.alternatives || [res]);
        const want = nav.resumeOpt || prefs.routeOpt; // 이어서 안내할 때는 전에 고른 옵션
        const pref = nav.alts.findIndex((a) => a.options.indexOf(want) >= 0);
        nav.altIdx = pref >= 0 ? pref : 0;
        r = nav.alts[nav.altIdx];
      }
      const beforeMs = nav.active && nav.route ? nav.route.duration * ((nav.total - nav.along) / Math.max(1, nav.total)) : null;
      setRoute(r, dest, reroute);
      if (reroute === 'traffic') {
        // 교통 갱신은 조용히. 도착 예정이 3분 넘게 바뀔 때만 알려 준다
        const diff = beforeMs == null ? 0 : r.duration - beforeMs;
        if (Math.abs(diff) >= 180000) {
          say('교통 상황을 반영했습니다. 도착 예정이 ' + Math.round(Math.abs(diff) / 60000) + '분 ' + (diff > 0 ? '늦어졌습니다.' : '빨라졌습니다.'), 1);
        }
        navUpdate(state.fix);
      } else if (reroute) {
        nav.option = q.option; // 이후 교통 갱신도 새로 잡은 추천 경로 기준으로
        const viaNow = reroute === 'via' && nav.via && nav.via[0];
        say(viaNow ? '경유지를 거쳐 가는 경로로 안내합니다.' : '새 경로로 안내합니다.', 1);
        toast((viaNow ? '경유지 ' + viaNow.name + ' 경유 · ' : '새 경로로 안내합니다 · ' + (ALT_LABEL[q.option] || '추천') + ' · ') +
          fmtDist(r.distance || nav.total) + ' · ' + fmtMin(r.duration), '', 4000);
        navUpdate(state.fix);
      } else if (nav.autoStart) {
        // 새 버전으로 바꾸기 전에 안내하던 목적지: 경로 카드 없이 바로 이어서 안내
        nav.autoStart = false; nav.resumeOpt = null;
        $('#toast').hidden = true;
        startNav();
      } else {
        nav.preview = true; nav.active = false;
        $('#toast').hidden = true;
        drawAltLines();
        showRouteCard();
        setFollowing(false, true);
        if (mapA) mapA.fit([].concat(...nav.alts.map((a) => a.path.map((p) => ({ lat: p[1], lng: p[0] })))));
      }
    } catch (e) {
      if (gen !== nav.gen) return;
      const d = e.detail || {};
      report('warn', { msg: 'route failed: ' + String(d.message || d.error || e.message).slice(0, 200), reroute: String(reroute || ''), keys: d.keys || '' });
      if (reroute === 'traffic') return; // 교통 갱신 실패는 지금 경로로 계속 안내 (화면에 띄우지 않음)
      const slow = e.name === 'AbortError' || /abort/i.test(e.message || '');
      if (reroute) { // 재탐색 실패: 지금 경로를 유지하고, 계속 벗어나 있으면 잠시 뒤 다시 시도한다
        toast(slow ? '통신이 느려 경로를 다시 찾지 못했어요. 잠시 후 다시 시도합니다.' : '경로를 다시 찾지 못했어요. 잠시 후 다시 시도합니다.', 'bad', 5000);
        return;
      }
      if (slow) { toast('통신이 느려 경로를 찾지 못했어요. 다시 시도해 주세요.', 'bad', 6000); return; }
      toast('경로를 찾지 못했습니다: ' + (d.message || (d.detail && d.detail.error && d.detail.error.message) || e.message), 'bad', 9000);
    } finally {
      if (gen === nav.gen) nav.busy = false;
    }
  }

  function setRoute(r, dest, keepAlerts) {
    nav.route = r; nav.dest = dest;
    nav.pts = r.path.map((p) => ({ lat: p[1], lng: p[0] }));
    nav.cum = [0];
    for (let i = 1; i < nav.pts.length; i++) nav.cum.push(nav.cum[i - 1] + haversine(nav.pts[i - 1], nav.pts[i]));
    nav.total = nav.cum[nav.cum.length - 1];
    nav.seg = 0; nav.along = 0; nav.off = 0; nav.gi = 0;
    nav.onRoute = false; nav.onCount = 0;
    // 달리는 중 다시 찾은 경로(재탐색·재추천·경유지·교통 갱신)는 출발 직후 유예(주차장 출발용 20초) 없이 바로 벗어남을 센다
    nav.rerouted = !!keepAlerts;
    nav.setAt = state.fix ? state.fix.t : Date.now(); nav.drawnSeg = 0; nav.drawnAlong = 0; nav.drawnAt = 0;
    nav.routeCams = null; nav.routeCamList = []; camState.markerAt = null; // 경로 위 카메라·지도 표시를 새 경로로
    nav.routeBumps = null; bumpState.markerKey = '';
    nav.routeSigns = null; tollState.numsKey = '';
    nav.routeTunnels = null;
    nav.lastTraffic = state.fix ? state.fix.t : Date.now();
    if (!keepAlerts) { nav.said = {}; nav.gap = 10000; }
    nav.remain = nav.total; nav.next = null; nav.dg = null;
    nav.guides = (r.guide || []).filter((g) => g.i < nav.pts.length).sort((a, b) => a.i - b.i);
    if (mapA) mapA.drawRoute(nav.pts, r.sections);
    if (mapA && mapA.setDest) mapA.setDest(dest, nav.pts[nav.pts.length - 1]);
    nav.arrowKey = null;
    if (mapA && mapA.setTurnArrow) mapA.setTurnArrow(null);
    if (!keepAlerts) camState.target = null; // 재탐색 때는 진행 중인 카메라 안내를 유지
  }

  // ---------- 추천 경로 여러 개 ----------
  const ALT_OPTIONS = 'traoptimal:trafast:traavoidtoll'; // 추천을 맨 앞에 (같은 길이면 '추천 · 빠른 길'로 합쳐 보인다)
  // 경로를 벗어나 다시 찾을 때는 같은 목적지를 '추천'(실시간 최적) 경로로. 무료 도로를 골랐으면 그 조건은 지킨다
  const rerouteOption = () => (nav.option === 'traavoidtoll' ? 'traavoidtoll' : 'traoptimal');
  // 재탐색 출발점: 지금 위치에서 진행 방향으로 (속도 × 답이 오기까지 걸리는 시간) 앞, 최대 60m.
  // 지금 자리에서 물으면 답이 왔을 때 차는 이미 그 앞 교차로를 지나 있어 새 경로가 차 뒤에서 시작한다
  // (2026-11-14 신갈: 상갈교사거리를 지나 동쪽으로 가는데 새 경로가 뒤 교차로에서 북쪽으로 시작)
  function rerouteStart() {
    const f = state.fix;
    if (state.heading === null || state.speedKmh < 15) return f;
    const secs = Math.min(4, Math.max(1.5, (nav.routeMs || 2000) / 1000 + 0.5));
    return aheadPt(f, state.heading, Math.min(60, state.speedKmh / 3.6 * secs));
  }
  const ALT_LABEL = { trafast: '빠른 길', traoptimal: '추천', traavoidtoll: '무료 도로', tracomfort: '편한 길', traavoidcaronly: '전용도로 회피' };
  // 사실상 같은 경로(거리·시간이 거의 같음)는 하나로 합치고 이름을 이어 붙인다
  function dedupAlts(list) {
    const out = [];
    list.forEach((a) => {
      const opt = a.option || prefs.routeOpt;
      // 경로 모양(거리·점 개수)이 같으면 예상 시간이 조금 달라도 같은 길로 본다
      const same = out.find((b) => Math.abs(b.distance - a.distance) < 50 &&
        (Math.abs(b.path.length - a.path.length) <= 2 || Math.abs(b.duration - a.duration) < 45000));
      if (same) { same.label += ' · ' + (ALT_LABEL[opt] || opt); same.options.push(opt); return; }
      out.push(Object.assign({}, a, { option: opt, options: [opt], label: ALT_LABEL[opt] || opt }));
    });
    return out;
  }
  function drawAltLines() {
    if (!mapA || !mapA.drawAlts) return;
    const others = (nav.preview || !nav.active || nav.comparing) && nav.alts ? nav.alts.filter((_, k) => k !== nav.altIdx) : [];
    mapA.drawAlts(others.map((a) => a.path.map((p) => ({ lat: p[1], lng: p[0] }))));
  }
  function selectAlt(k) {
    if (nav.comparing) { // 길안내 중 비교: 고르는 즉시 그 경로로 안내 (k = -1 은 원래 경로로)
      if (k === nav.altIdx || (k >= 0 && (!nav.alts || !nav.alts[k]))) return;
      nav.altIdx = k;
      const r = k < 0 ? nav.compareBase.route : nav.alts[k];
      setRoute(r, nav.dest, true);
      nav.option = k < 0 ? nav.compareBase.option : (r.option || nav.option);
      if (state.fix) navUpdate(state.fix);
      drawAltLines();
      showRouteCard();
      return;
    }
    if (!nav.alts || !nav.alts[k] || k === nav.altIdx) return;
    nav.altIdx = k;
    setRoute(nav.alts[k], nav.dest);
    drawAltLines();
    showRouteCard();
  }
  // 비교 끝내기: keep 이면 지금 고른 경로로 계속, 아니면 원래 경로로 되돌린다
  function endCompare(keep) {
    if (!nav.comparing) return;
    const changed = nav.altIdx >= 0;
    if (!keep && changed) selectAlt(-1);
    nav.comparing = false; nav.compareBase = null; nav.alts = null; nav.altIdx = 0;
    drawAltLines();
    $('#routeCard').hidden = true;
    if (keep && changed) say('선택한 경로로 안내합니다.', 1);
  }
  function showRouteCard() {
    const r = nav.route, cmp = !!nav.comparing;
    $('#rcTitle').textContent = (cmp ? '경로 비교 · ' : '') + nav.dest.name;
    const alts = nav.alts && nav.alts.length ? nav.alts : [Object.assign({ label: ALT_LABEL[r.option] || '경로' }, r)];
    // 비교 중이면 맨 앞에 '지금 경로'(남은 거리·시간)
    const base = cmp && nav.compareBase ? nav.compareBase.route : null;
    const baseLeft = base ? { label: '지금 경로', distance: nav.altIdx < 0 ? nav.total - nav.along : base.distance,
      duration: nav.altIdx < 0 ? base.duration * ((nav.total - nav.along) / Math.max(1, nav.total)) : base.duration, tollFare: base.tollFare } : null;
    const rows = (baseLeft ? [[-1, baseLeft]] : []).concat(alts.map((a, k) => [k, a]));
    const fastest = Math.min(...rows.map(([, a]) => a.duration));
    const sel = cmp ? nav.altIdx : (nav.altIdx || 0);
    $('#rcAlts').innerHTML = rows.map(([k, a]) => {
      const diff = a.duration - fastest;
      return '<button class="alt' + (k === sel ? ' on' : '') + '" data-k="' + k + '">' +
        '<span class="alt-label">' + esc(a.label) + '</span>' +
        '<b>' + fmtMin(a.duration) + '</b>' +
        '<span class="alt-sub">' + fmtDist(a.distance) + ' · ' + (a.tollFare ? a.tollFare.toLocaleString('ko-KR') + '원' : '무료') +
        (diff >= 60000 ? ' · +' + Math.round(diff / 60000) + '분' : '') + '</span></button>';
    }).join('');
    $('#rcAlts').querySelectorAll('.alt').forEach((b) => { b.onclick = () => selectAlt(+b.dataset.k); });
    $('#rcMeta').textContent = cmp
      ? '고르면 바로 그 경로로 안내합니다 · 다른 경로는 지도에 회색으로'
      : hhmm(new Date(Date.now() + r.duration)) + ' 도착 예정' + (alts.length > 1 ? ' · 다른 경로는 지도에 회색으로 표시' : '');
    // 주차장 입구로 안내하는 중이면 그 이름과 '정문으로' 버튼 (비교 중에는 숨김)
    const pk = !cmp && nav.dest && nav.dest.park;
    $('#rcPark').hidden = !pk;
    if (pk) {
      $('#rcParkName').textContent = nav.dest.parkOff ? '정문(목적지)으로 안내' : '주차장 입구로 안내 · ' + nav.dest.park.name;
      $('#rcParkBtn').textContent = nav.dest.parkOff ? '주차장 입구로' : '정문으로';
    }
    $('#rcStart').textContent = cmp ? '이 경로로 안내' : '안내 시작';
    $('#rcCancel').textContent = cmp ? '원래 경로로' : '취소';
    $('#routeCard').hidden = false;
  }

  // ---------- 하단 위치 띠 → 버튼 (경로 비교 · 재추천 · 경유지) ----------
  // 위치 띠를 누르면 위로 버튼이 올라온다. 8초 동안 안 누르면 다시 내려간다
  const tray = { timer: 0 };
  function openTray() {
    const el = $('#navTray'), on = !!(nav.active && nav.dest);
    $('#ntCompare').hidden = !on; $('#ntReroute').hidden = !on; $('#ntVia').hidden = !on; $('#ntSearch').hidden = on;
    const v = nav.via && nav.via[0];
    $('#ntViaLabel').textContent = v ? '경유지 빼기' : '경유지 추가';
    $('#ntVia').classList.toggle('on', !!v);
    // 새 버전이 나와 있으면 '새 버전' 버튼 (누르면 바꾸고, 길안내 중이었으면 같은 목적지로 이어서 안내)
    $('#ntUpdate').hidden = !upd.newer;
    $('#ntVer').textContent = '버전 ' + APP_VERSION.slice(5) + (upd.newer ? ' · 새 버전 ' + upd.newer.slice(5) + ' 있음' : '');
    el.hidden = false;
    setTimeout(() => el.classList.add('open'), 16);
    clearTimeout(tray.timer);
    tray.timer = setTimeout(closeTray, 8000);
  }
  function closeTray() {
    const el = $('#navTray');
    clearTimeout(tray.timer);
    el.classList.remove('open');
    setTimeout(() => { if (!el.classList.contains('open')) el.hidden = true; }, 200);
  }
  const toggleTray = () => ($('#navTray').classList.contains('open') ? closeTray() : openTray());
  function startNav() {
    if (!nav.pts) return;
    $('#routeCard').hidden = true;
    nav.option = nav.route.option || prefs.routeOpt; // 재탐색·교통 갱신도 고른 옵션으로
    nav.preview = false; nav.active = true;
    nav.odo0 = state.odo; // 경로 막대의 출발점 (재탐색해도 유지)
    camState.markerAt = null; camState.peekAt = 0; // 지도 카메라 표시를 경로 위 카메라로 바로 바꾼다
    // 안내 시작 전에 잡혀 있던 카메라가 경로 위가 아니면 바로 내린다
    if (camState.target && !camState.target.after && !camOnRouteAhead(camState.target.c)) camState.target = null;
    if (mapA && mapA.drawAlts) mapA.drawAlts([]);
    $('#map').classList.add('navigating');
    setFollowing(true);
    if (mapA) { mapA.setZoom(speedZoom(state.speedKmh)); zoomCtl.manualUntil = 0; }
    if (state.fix) navUpdate(state.fix);
    say('경로 안내를 시작합니다. ' + nav.dest.name + '까지 ' + spokenDist(nav.total) + ', 약 ' + fmtMin(nav.route.duration) + ' 걸립니다.', 1);
    renderNav();
  }
  function endNav() {
    nav.gen++; nav.busy = false; nav.byDemo = false;
    nav.active = false; nav.preview = false;
    nav.route = null; nav.pts = null; nav.cum = null; nav.dest = null; nav.guides = [];
    nav.routeCams = null; nav.routeCamList = []; camState.markerAt = null; camState.peekAt = 0;
    nav.alts = null; nav.altIdx = 0; nav.via = []; nav.comparing = false; nav.compareBase = null;
    if (mapA) { mapA.clearRoute(); if (mapA.drawAlts) mapA.drawAlts([]); }
    if (mapA && mapA.setDest) mapA.setDest(null);
    if (mapA && mapA.setTurnArrow) mapA.setTurnArrow(null);
    nav.arrowKey = null;
    nav.routeRest = null; restState.key = '';
    $('#restCard').hidden = true;
    if (mapA && mapA.setRests) mapA.setRests([]);
    $('#routeCard').hidden = true;
    $('#map').classList.remove('navigating');
    camState.target = null;
    renderNav();
    setFollowing(true);
  }

  // 네이버 길찾기 안내 종류(guide.type) → 아이콘. 2026-11-14 네이버 문서의 '분기점 안내 코드' 표 전체로 다시 맞췄다
  // (로터리 21~34·회전교차로 91~104 는 나가는 방향별, 고가·지하차도 진입/옆길은 꺾는 화살표가 아니라 그쪽 길,
  //  하이패스 전용·원톨링 톨게이트도 톨게이트, 휴게소 진입·페리·전방 고속도로 진입/진출도 각각). 코드가 없을 때만 글자로 본다
  //  v102: 옆길은 고가 옆길(63·72 → oside_)과 지하차도 옆길(65·74 → side_, 예: 염곡사거리에서 꺾을 때)을 따로 (그림을 따로 고를 수 있게)
  function rbKind(n) { // 0 직진, 1 유턴, 2~6 왼쪽 7~11시, 7 12시, 8~12 오른쪽 1~5시, 13 6시
    if (n === 0 || n === 7) return 'rb_s';
    if (n === 1 || n === 13) return 'rb_u';
    return n <= 6 ? 'rb_l' : 'rb_r';
  }
  const KIND_BY_CODE = {
    1: 's', 2: 'l', 3: 'r', 4: 'kl', 5: 'kr', 6: 'u', 8: 'l',
    11: 'sharp_l', 12: 'l', 13: 'sl', 14: 'sr', 15: 'r', 16: 'sharp_r',
    41: 'kl', 42: 'kr', 47: 'rest', 48: 'ferry', 49: 'ferry',
    50: 'ins', 51: 'outs', 52: 'ins', 53: 'outs', 55: 'over_s', 56: 'under_s',
    57: 'inl', 58: 'outl', 59: 'inl', 60: 'outl', 62: 'over_l', 63: 'oside_l', 64: 'under_l', 65: 'side_l',
    66: 'inr', 67: 'outr', 68: 'inr', 69: 'outr', 71: 'over_r', 72: 'oside_r', 73: 'under_r', 74: 'side_r',
    75: 'ins', 76: 'inl', 77: 'inr', 78: 'outs', 79: 'outl', 80: 'outr', 81: 'kl', 82: 'kr',
    87: 'via', 88: 'goal', 121: 'toll', 122: 'toll', 123: 'toll',
  };
  function turnKind(g) {
    const s = g.s || '', t = g.t;
    if (t >= 21 && t <= 34) return rbKind(t - 21);   // 로터리
    if (t >= 91 && t <= 104) return rbKind(t - 91);  // 회전교차로
    if (t === 54) return /왼쪽/.test(s) ? 'kl' : /오른쪽/.test(s) ? 'kr' : 's'; // 전방 분기 도로
    if (KIND_BY_CODE[t]) return KIND_BY_CODE[t];
    // 코드가 없거나 표에 없는 코드: 안내 글자로
    if (/유턴|U턴/i.test(s)) return 'u';
    if (/목적지|도착/.test(s)) return 'goal';
    if (/경유지/.test(s)) return 'via';
    const clock = s.match(/(\d{1,2})시\s*방향/);
    if (clock) {
      const h = +clock[1], rb = /회전교차로|로터리/.test(s);
      if (rb) return h === 12 ? 'rb_s' : h === 6 ? 'rb_u' : h >= 7 ? 'rb_l' : 'rb_r';
      if (h === 10 || h === 11) return 'sl';
      if (h === 1 || h === 2) return 'sr';
      if (h === 7 || h === 8) return 'sharp_l';
      if (h === 4 || h === 5) return 'sharp_r';
      if (h === 9) return 'l';
      if (h === 3) return 'r';
      if (h === 6) return 'u';
      return 's';
    }
    if (/좌회전|왼쪽/.test(s)) return 'l';
    if (/우회전|오른쪽/.test(s)) return 'r';
    return 's';
  }
  // 목적지·경유지 핀 (그다음 칸에서): 빨간 핀 안에 흰 점
  const PIN_ICON = '<svg viewBox="0 0 24 24" class="pin"><path d="M12 2.5a7 7 0 0 0-7 7c0 5.2 7 12 7 12s7-6.8 7-12a7 7 0 0 0-7-7z" fill="#ef4444" stroke="none"/>' +
    '<circle cx="12" cy="9.5" r="2.6" fill="#fff" stroke="none"/></svg>';
  // 고속도로 나가기(OUT)·들어가기(IN) 그림 (2026-11-14 요청: 다른 내비처럼). 톨게이트(TG) 그림과 같은 모양:
  // 어두운 본선 + 갈라져 나가는(또는 들어오는) 어두운 연결로 위에 흰 화살표, 오른쪽 위에 고속도로 방패 모양 OUT/IN 표지.
  // 오른쪽으로 그리고, 왼쪽은 도로·화살표만 좌우로 뒤집고 표지는 왼쪽 위로 옮긴다. 그다음 안내 칸(작은 크기)에서는 표지를 숨긴다
  function rampIcon(out, left) {
    const flip = left ? ' transform="matrix(-1 0 0 1 48 0)"' : '';
    const road = '<path class="rd-f" d="M4 47V3h15v44z" fill="#2b3440" stroke="none"/>' +
      '<path d="M11.5 44V5" stroke="#fff" stroke-width="1.6" stroke-dasharray="4 4" opacity=".55" fill="none"/>' +
      (out ? '<path class="rd-s" d="M14 47C14 35 22 27 37 21" stroke="#2b3440" stroke-width="12" fill="none"/>' +
             '<path d="M13 45C13 34.5 20 28.6 31 23.6" stroke="#fff" stroke-width="4.5" stroke-linecap="round" fill="none"/>' +
             '<path d="M38.5 20.2 33.3 28 29.2 19z" fill="#fff" stroke="none"/>'
           : '<path class="rd-s" d="M38 47C38 35 30 26 15 20" stroke="#2b3440" stroke-width="12" fill="none"/>' +
             '<path d="M36 45C36 34 27 28 15.5 22 12.5 20.3 11.5 18 11.5 14" stroke="#fff" stroke-width="4.5" stroke-linecap="round" fill="none"/>' +
             '<path d="M11.5 4 16.5 12.5H6.5z" fill="#fff" stroke="none"/>');
    const shield = '<g class="shield"' + (left ? ' transform="translate(-24 0)"' : '') + '>' +
      '<path d="M26.5 2.5h19v8.2c0 4.6-4.2 7.4-9.5 9.3-5.3-1.9-9.5-4.7-9.5-9.3z" fill="#1d4fb8" stroke="#fff" stroke-width="1.2"/>' +
      '<path d="M27.1 3.1h17.8v3.6H27.1z" fill="#d93b3b" stroke="none"/>' +
      '<text x="36" y="14.6" text-anchor="middle" font-size="' + (out ? 7.5 : 8.5) + '" font-weight="800" fill="#fff" stroke="none" font-family="Pretendard, sans-serif">' +
      (out ? 'OUT' : 'IN') + '</text></g>';
    return '<svg viewBox="0 0 48 48" class="ramp ' + (out ? 'out' : 'in') + '"><g' + flip + '>' + road + '</g>' + shield + '</svg>';
  }
  const TURN_ICONS = {
    s: '<svg viewBox="0 0 48 48"><path d="M24 43V7M12 19 24 7l12 12"/></svg>',
    l: '<svg viewBox="0 0 48 48"><path d="M32 43V25a9 9 0 0 0-9-9H9M17 8l-8 8 8 8"/></svg>',
    r: '<svg viewBox="0 0 48 48"><path d="M16 43V25a9 9 0 0 1 9-9h14M31 8l8 8-8 8"/></svg>',
    u: '<svg viewBox="0 0 48 48"><path d="M34 43V18a9 9 0 0 0-18 0v20M9 31l7 8 7-8"/></svg>',
    goal: '<svg viewBox="0 0 48 48"><path d="M13 44V5M13 7h23l-6 8 6 8H13"/></svg>',
    // 비켜 가기: 아래에서 올라와 그쪽으로 한 번 비켜서 다시 위로 (갈림길·왼쪽/오른쪽 방향)
    kl: '<svg viewBox="0 0 48 48" class="keep kl"><path d="M31 44V31c0-7-12-9-12-17V7M12 14l7-7 7 7"/></svg>',
    kr: '<svg viewBox="0 0 48 48" class="keep kr"><path d="M17 44V31c0-7 12-9 12-17V7M22 14l7-7 7 7"/></svg>',
    // 나가기(OUT)·들어가기(IN): 아래 rampIcon (톨게이트 그림처럼 어두운 도로 + 흰 화살표 + 고속도로 방패 표지)
    outr: rampIcon(true, false), outl: rampIcon(true, true), inr: rampIcon(false, false), inl: rampIcon(false, true),
    // 톨게이트: 파란 'TG' 표지 + 앞으로 좁아지는 도로 + 흰 화살표 (네이버·다른 내비의 톨게이트 그림처럼)
    toll: '<svg viewBox="0 0 48 48" class="toll"><rect x="6" y="1" width="36" height="17" rx="3.5" fill="#2f6fe4" stroke="none"/>' +
      '<text x="24" y="14.6" text-anchor="middle" font-size="14" font-weight="800" fill="#fff" stroke="none" font-family="Pretendard, sans-serif">TG</text>' +
      '<path class="tg-road" d="M7 47 17 21h14l10 26z" fill="#2b3440" stroke="none"/>' +
      '<path d="M24 43V28M19.5 32.5 24 28l4.5 4.5" fill="none" stroke="#fff" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  };

  // 사용자가 AI 로 그린 아이콘(icons.js, tools/build_icons.py 로 분홍 배경 없이 SVG 로 딴 것)이 있으면 그것으로 바꾼다
  Object.assign(TURN_ICONS, window.TNC_ICONS || {});
  // 아직 그림이 없는 종류는 가장 가까운 그림으로 (꺾는 화살표로 잘못 보이지 않게): 순서대로 채운다
  const ICON_FALLBACK = {
    sl: 'l', sr: 'r', rb: 'r', via: 'goal', rb_l: 'rb', rb_s: 's', rb_r: 'r', rb_u: 'u', sharp_l: 'l', sharp_r: 'r',
    outs: 'outr', ins: 'inr', over_l: 'kl', under_l: 'kl', side_l: 'kl', oside_l: 'kl', over_r: 'kr', under_r: 'kr', side_r: 'kr', oside_r: 'kr',
    over_s: 's', under_s: 's', rest: 'kr', ferry: 's',
  };
  Object.keys(ICON_FALLBACK).forEach((k) => { if (!TURN_ICONS[k]) TURN_ICONS[k] = TURN_ICONS[ICON_FALLBACK[k]] || TURN_ICONS.s; });
  const PLAIN_ROAD = {
    outr: 'kr', outl: 'kl', inr: 'kl', inl: 'kr', outs: 's', ins: 's',
    over_l: 'kl', over_r: 'kr', over_s: 's', under_l: 'kl', under_r: 'kr', under_s: 's',
    side_l: 'kl', side_r: 'kr', oside_l: 'kl', oside_r: 'kr',
  };
  Object.keys(PLAIN_ROAD).forEach((k) => { TURN_ICONS[k] = TURN_ICONS[PLAIN_ROAD[k]]; });
  // 같은 아이콘을 두 곳에 넣어도 그라데이션 id 가 겹치지 않게 넣을 때마다 번호를 붙인다
  let icoN = 0;
  // 고른 AI 그림이 있으면 <img>, 없으면 null
  function pickImg(slot, cls) {
    const f = ICON_PICKS[slot];
    return f ? '<img class="' + (cls || '') + ' aiimg" src="' + APP_BASE + 'img/ai/' + f + '?v=' + APP_VERSION + '" alt="" draggable="false">' : null;
  }
  function ico(k) {
    return pickImg(k, 'ti') || icoBase(k);
  }
  function icoBase(k) {
    const svg = TURN_ICONS[k] || TURN_ICONS.s;
    if (svg.indexOf('id="') < 0) return svg;
    const n = ++icoN;
    return svg.replace(/(id="|url\(#)(tg-[\w-]+)/g, '$1$2-' + n);
  }
  const pinIco = (via) => (window.TNC_ICONS && window.TNC_ICONS[via ? 'via' : 'goal'] ? ico(via ? 'via' : 'goal') : PIN_ICON);

  // 다음 회전 지점 화살표: 회전·비켜 가기·나가기/들어가기·유턴·회전교차로이고 400m 안이면 그 지점 앞뒤 (가까이 보면 35m 앞~25m 뒤,
  // 멀리 볼수록 화면 기준으로 더 길게: 지도 쪽 drawArrow 가 배율에 맞춰 잘라 쓰도록 앞 150m·뒤 100m 를 넘긴다)
  const ARROW_KINDS = new Set(['l', 'r', 'u', 'sl', 'sr', 'sharp_l', 'sharp_r', 'kl', 'kr', 'outl', 'outr', 'outs', 'inl', 'inr', 'ins',
    'rb', 'rb_l', 'rb_s', 'rb_r', 'rb_u', 'over_l', 'over_r', 'over_s', 'under_l', 'under_r', 'under_s', 'side_l', 'side_r', 'oside_l', 'oside_r', 'rest']);
  function renderTurnArrow() {
    if (!mapA || !mapA.setTurnArrow) return;
    const g = nav.active ? nav.next : null;
    const want = !!(g && nav.dg != null && nav.dg <= 400 && ARROW_KINDS.has(turnKind(g)));
    const key = want ? g.i + ':' + g.t : '';
    if (key === nav.arrowKey) return;
    nav.arrowKey = key;
    if (!want) { mapA.setTurnArrow(null); return; }
    const c = nav.cum[Math.min(g.i, nav.cum.length - 1)], pts = [];
    // 2.5m 간격 점 + 그 사이 꼭짓점(회전 지점 포함) 그대로: 간격 점만 쓰면 모서리를 깎아(현) 경로선과 어긋난다.
    // 지도에 그린 경로(모서리를 도로처럼 둥글린 것)가 있으면 그 점들을 따라간다 — 흰 줄과 경로선이 한 곡선을 공유
    const disp = mapA.disp, A = disp ? disp.along : nav.cum;
    const lo = Math.max(0, c - 150), hi = Math.min(nav.total, c + 100), ats = [c];
    for (let at = lo; at <= hi + 0.01; at += ARROW_STEP) ats.push(Math.min(at, hi));
    for (let i = 0; i < A.length; i++) if (A[i] > lo && A[i] < hi) ats.push(A[i]);
    ats.sort((x, y) => x - y);
    let ti = 0, last = -Infinity;
    for (const at of ats) {
      if (at - last < 0.05) continue;
      const q = disp ? dispPointAt(disp, at) : routePointAt(at);
      if (!q) continue;
      last = at;
      if (Math.abs(at - c) < 0.05) ti = pts.length;
      pts.push({ lat: q.lat, lng: q.lng, rel: at - c });   // rel: 회전 지점에서 앞(+)/뒤(-) 거리 — 지도 쪽이 배율에 맞춰 자른다
    }
    // 테두리는 회전 지점 경로 색(교통색 또는 바탕 파랑): 경로선이 흰 화살표로 이어지는 느낌
    const run = trafficRuns(nav.route && nav.route.sections, nav.pts.length).find((x) => x.a <= g.i && g.i <= x.b);
    mapA.setTurnArrow(pts.length >= 2 ? pts : null, ti, run ? run.color : ROUTE_BASE);
  }

  // 남은 경로만 다시 그린다: 지금 위치(경로 위로 붙인 점)부터 목적지까지, 교통 색 구간도 번호를 맞춰 옮긴다
  function drawRemaining() {
    if (!mapA || !nav.pts || !nav.route) return;
    // 다음 GPS 까지 차가 조금 더 나아가므로 0.4초 앞에서 자른다 (자른 끝은 차 아이콘에 가려진다)
    const at = Math.min(nav.total, nav.along + Math.max(0, state.speedKmh / 3.6) * 0.4);
    // 흰 점: 경로 처음부터 점 간격(미터)의 배수 자리에서 자르면 점이 땅에 붙어 있다. 색 선이 시작하는 곳 바로 앞 칸부터
    // (뒤 칸부터 자르면 색 선 없이 점만 차 뒤에 남는다)
    let atDot = null;
    const mpp = mapA.mpp ? mapA.mpp() : 0;
    if (mpp > 0) { const P = DOT_PERIOD_PX * mpp; atDot = Math.min(nav.total, Math.ceil(at / P) * P); }
    // 지도에 그려 둔 경로 조각 중 차가 걸친 조각만 고쳐 그린다 (setRoute 에서 nav.pts 전체를 그려 둠)
    if (mapA.trimRoute) mapA.trimRoute(at, atDot);
    nav.drawnSeg = nav.seg;
    nav.drawnAlong = nav.along;
    nav.drawnAt = state.fix ? state.fix.t : Date.now();
  }

  function navUpdate(f) {
    if (!nav.active || !nav.pts || !f) return;
    // 경유지 근처(150m)를 지나면 목록에서 뺀다 (이후 재탐색이 경유지로 되돌아가지 않게)
    if (nav.via && nav.via.length && haversine(f, nav.via[0]) < 150) {
      const v = nav.via.shift();
      toast('경유지 ' + v.name + ' 을(를) 지났어요', '', 3000);
    }
    const pts = nav.pts;
    let best = { dist: Infinity, seg: nav.seg, t: 0 };
    // 달리는 방향과 반대인 구간(유턴 뒤 맞은편 차로 등)에는 붙지 않는다
    const useHeading = state.heading !== null && state.speedKmh > 10;
    const scan = (from, to) => {
      for (let i = from; i <= to; i++) {
        if (useHeading && nav.cum[i + 1] - nav.cum[i] > 3 &&
            angleDiff(bearing(pts[i], pts[i + 1]), state.heading) > 90) continue;
        const pr = projectSeg(f, pts[i], pts[i + 1]);
        if (pr.dist < best.dist) best = { dist: pr.dist, seg: i, t: pr.t };
      }
    };
    scan(Math.max(0, nav.seg - 3), Math.min(pts.length - 2, nav.seg + 150));
    // 멀리 벗어났을 때만 전체를 다시 보되, 지나온 쪽으로 되돌아가지는 않는다
    if (best.dist > 80) scan(nav.seg, pts.length - 2);

    // 경로에서 이만큼 떨어지면 벗어난 것으로 본다. 테슬라 GPS 는 ±2~5m 로 정확해서
    // 옆으로 나란히 가는 다른 도로(보통 30m 이상)로 잘못 들어선 것도 잡을 수 있게 30m 를 기본으로 한다
    const offLimit = Math.min(50, Math.max(30, (f.acc || 10) * 2));
    // 가장 가까운 경로 구간과 달리는 방향이 50° 넘게 다르고 18m 넘게 떨어졌으면 다른 길로 들어선 것 (30m 를 기다리지 않는다)
    let skew = 0;
    if (useHeading && best.dist > 18 && best.dist < Infinity && nav.cum[best.seg + 1] - nav.cum[best.seg] > 3) {
      skew = angleDiff(bearing(pts[best.seg], pts[best.seg + 1]), state.heading);
    }
    const wrongWay = skew > 50;
    nav.onRoute = best.dist <= offLimit && !wrongWay;
    if (nav.onRoute) {
      nav.seg = best.seg;
      nav.along = nav.cum[best.seg] + best.t * (nav.cum[best.seg + 1] - nav.cum[best.seg]);
      nav.off = 0;
      if (++nav.onCount >= 5) { nav.gap = 10000; nav.quickLeft = 0; } // 경로 위를 잘 따라가면 재탐색 간격 초기화
    } else if ((f.acc || 0) < 60 && state.speedKmh > 3 &&
               (nav.onCount > 0 || nav.rerouted || f.t - (nav.setAt || 0) > 20000)) {
      // 출발점이 도로에서 떨어진 곳(주차장 등)이면 경로에 한 번 올라탄 뒤부터 센다.
      // 다만 20초가 지나도 경로에 못 올라탔다면(엉뚱한 경로) 그때부터는 센다
      nav.off++;
    }
    // 확실히 다른 길(80m 넘게 벗어남·다른 방향)이면 2번, 아니면 3번 연속 확인되면 다시 찾는다
    const need = best.dist > 80 || wrongWay ? 2 : 3;
    // 다시 찾은 경로에 한 번도 못 올라탔으면(답이 오는 사이 차가 경로 시작점을 지나쳤으면) 간격을 기다리지 않고 한 번 바로 다시 찾는다
    const quick = nav.quickLeft > 0 && nav.rerouted && nav.onCount === 0 && f.t - (nav.setAt || 0) > 2500;
    if (nav.off >= need && !nav.busy && (quick || f.t - nav.lastReroute > nav.gap)) {
      nav.lastReroute = f.t;
      nav.off = 0; nav.onCount = 0;
      if (quick) nav.quickLeft = 0;
      else { nav.quickLeft = 1; nav.gap = Math.min(nav.gap * 2, 40000); } // 계속 벗어나면 간격을 늘리되 40초를 넘기지 않는다
      if (!quick) say('경로를 벗어났습니다. 다시 탐색합니다.', 1, true);
      toast(quick ? '지금 위치에 맞춰 경로를 다시 찾는 중…' : '경로를 벗어나 같은 목적지로 다시 찾는 중… (추천 경로)', '', 4000);
      planRoute(nav.dest, true);
    }
    // 지나온 경로는 지운다 (내 차 앞의 남은 경로만 그린다)
    // GPS 가 올 때마다(1초에 한 번 정도) 5m 이상 나아갔으면 다시 자른다. 선은 새로 만들지 않고 경로만 바꾼다
    if (nav.onRoute && mapA && Math.abs(nav.along - (nav.drawnAlong || 0)) > 5 &&
        f.t - (nav.drawnAt || 0) > 800) drawRemaining();

    // 5분마다 지금 위치에서 경로를 다시 받아 교통 상황(막히는 구간·도착 시간)을 갱신한다 (시간당 최대 12회)
    if (nav.onRoute && !nav.busy && nav.total - nav.along > 1500 && f.t - nav.lastTraffic > 5 * 60000) {
      nav.lastTraffic = f.t;
      planRoute(nav.dest, 'traffic');
    }

    nav.remain = Math.max(0, nav.total - nav.along);
    if (nav.remain < 30 || (nav.remain < 300 && haversine(f, nav.dest) < 35)) {
      const name = nav.dest.name;
      say('목적지에 도착했습니다. 안내를 종료합니다.', 2, true);
      endNav();
      toast(name + '에 도착했습니다.', '', 5000);
      return;
    }

    while (nav.gi < nav.guides.length && nav.cum[nav.guides[nav.gi].i] <= nav.along + 3) nav.gi++;
    nav.next = nav.guides[nav.gi] || null;
    nav.dg = nav.next ? nav.cum[nav.next.i] - nav.along : nav.remain;
    if (nav.next) announceTurn(nav.next, nav.dg);
    renderNav();
  }

  // 톨게이트 안내 문구: '남춘천톨게이트 (통행료 3,900원)' → 이름 · 통행료 · 하이패스 안내
  // (하이패스 차로가 몇 번째인지는 길찾기 데이터에 없어 '하이패스 차로 이용'까지만 알린다)
  function tollParts(g) {
    // 요금은 맨 끝 괄호: '남산1호터널톨게이트(도심) (통행료 0원)' → 이름 '남산1호터널톨게이트(도심)', 요금 '통행료 0원'
    // (첫 괄호에서 자르면 요금 칸에 '도심) (통행료 0원'이 나왔다, 2026-11-14 남산1호터널 확인)
    const m = String(g.s || '').match(/^(.*)\((\s*[^()]*)\)\s*$/);
    return { name: (m ? m[1].trim() : g.s) || '톨게이트', fare: m ? m[2].trim() : '' };
  }
  function announceTurn(g, dg) {
    const said = nav.said[g.i] || (nav.said[g.i] = {});
    const fast = state.speedKmh > 60;
    const toll = g.t === 121;
    const text = toll ? (() => { const p = tollParts(g); return p.name + (p.fare ? ', ' + p.fare : '') + '. 하이패스 차로를 이용하세요'; })() : g.s;
    if (toll && dg <= 2050 && dg > 1500 && !said.k2) {
      said.k2 = true;
      say('2킬로미터 앞, ' + text, 1);
    } else if (fast && dg <= 1100 && dg > 700 && !said.k1) {
      said.k1 = true;
      say('1킬로미터 앞, ' + text, 1);
    } else if (dg <= 320 && dg > (fast ? 160 : 90) && !said.m300) {
      said.m300 = true;
      say(spokenDist(Math.round(dg / 100) * 100 || 100) + ' 앞, ' + text, 1);
    } else if (dg <= (fast ? 160 : 90) && !said.now) {
      said.now = true; said.m300 = true;
      if (!toll) say(g.s, 1, true); // 톨게이트는 바로 앞에서 다시 말하지 않는다
    }
  }
  // 하이패스(톨게이트) 카드: 경로 위 다음 톨게이트가 2km 안이면 이름·남은 거리·통행료를 보여 준다
  // ---------- 분기점 그림 (2026-11-14 요청: 다른 내비의 IC·분기점 확대 그림처럼) ----------
  // 실제 교차로 그림은 공개 데이터가 없어서, 네이버 안내 종류(왼쪽/오른쪽 방향, 고속도로·자동차전용도로 진입·진출)로
  // 단순한 갈림길 그림을 그린다: 가야 할 쪽 도로를 파랗게 + 흰 화살표, 위에 방면 이름, 밑에 안내 지점 이름과 남은 거리.
  // 차로 수는 모르므로 그리지 않는다. 길안내 패널 밑 서랍 맨 위에, 안내 지점 800m 앞부터
  const JUNC_FORK = new Set([4, 5, 41, 42, 54]);                                  // 갈림길: 두 갈래
  const JUNC_RAMP = new Set([57, 58, 59, 60, 66, 67, 68, 69, 76, 77, 79, 80]);   // 진입·진출로: 본선 옆으로 빠짐
  const JUNC_LEFT = new Set([4, 41, 57, 58, 59, 60, 76, 79, 62, 63, 64, 65]);
  const JUNC_ENTRY = new Set([57, 59, 66, 68, 76, 77]);               // 진입로: 본선으로 합류 (2026-11-15: 진출 그림이 나오던 것)
  // 고가·지하차도·옆길 (2026-11-15 '안내 표기가 어려우면 밑에처럼 이미지로')
  const JUNC_ROAD = { 55: 'over', 62: 'over', 71: 'over', 56: 'under', 64: 'under', 73: 'under', 63: 'oside', 72: 'oside', 65: 'side', 74: 'side' };
  const JUNC_SHOW = 800;
  const juncState = { g: null, key: '' };
  function juncInfo(g) {
    if (!g || (!JUNC_FORK.has(g.t) && !JUNC_RAMP.has(g.t) && !JUNC_ROAD[g.t])) return null;
    const s = String(g.s || '');
    let left = JUNC_LEFT.has(g.t);
    if (g.t === 54) { if (/왼쪽/.test(s)) left = true; else if (/오른쪽/.test(s)) left = false; else return null; }
    const m = s.match(/^(.*?)에서\s/);
    const q = s.match(/'([^']+)'/);
    // 괄호 부분은 뺀다: '올림픽대로(강일IC)' → '올림픽대로' (2026-11-15: 6자로 자르다 '올림픽대로(' 처럼 괄호만 남았다)
    const names = q ? q[1].split(',').map((x) => (x.replace(/\s*\([^)]*\)?/g, '').trim() || x.trim())).filter(Boolean) : [];
    const short = names.filter((x) => x.length <= 5);   // '수도권제1순환선'·'중부고속도로' 같은 긴 이름보다 '판교'·'호법'
    const label = (short.length ? short : names.map((x) => x.slice(0, 6))).slice(0, 2).join(' · ');
    const kind = JUNC_ROAD[g.t] || (JUNC_ENTRY.has(g.t) ? 'entry' : JUNC_RAMP.has(g.t) ? 'ramp' : 'fork');
    return { kind, left, place: m ? m[1] : '', label,
      hwy: /고속|분기점|IC\b|JC\b|IC에서|JC에서/i.test(s) || (g.t >= 57 && g.t <= 69) };
  }
  // 앞을 내려다본 원근 그림 (2026-11-14 다시 그림: 다른 내비의 분기점 확대 그림처럼 하늘·지평선·멀어질수록 좁아지는 도로).
  // 땅 위 좌표(X 오른쪽 m, Z 앞쪽 m)로 길을 정하고 화면으로 투영한다. 왼쪽으로 갈 때는 X 만 뒤집는다(글자는 CSS 로 반대쪽에)
  const JV = { W: 320, H: 120, HZ: 30, Z0: 26, S: 15 };
  function jvP(X, Z) { const k = JV.Z0 / (Z + JV.Z0); return [JV.W / 2 + X * JV.S * k, JV.HZ + (JV.H - JV.HZ) * k]; }
  // 3차 베지어 중심선 (땅 좌표) → 점 목록
  function jvCurve(p, n) {
    const out = [];
    for (let i = 0; i <= n; i++) {
      const t = i / n, u = 1 - t;
      out.push([u * u * u * p[0][0] + 3 * u * u * t * p[1][0] + 3 * u * t * t * p[2][0] + t * t * t * p[3][0],
        u * u * u * p[0][1] + 3 * u * u * t * p[1][1] + 3 * u * t * t * p[2][1] + t * t * t * p[3][1]]);
    }
    return out;
  }
  // 중심선의 길이 a..b(m) 부분만
  function jvSlice(c, a, b) {
    const s = [0];
    for (let i = 1; i < c.length; i++) s.push(s[i - 1] + Math.hypot(c[i][0] - c[i - 1][0], c[i][1] - c[i - 1][1]));
    const at = (t) => {
      let i = 0;
      while (i < c.length - 2 && s[i + 1] < t) i++;
      const r = Math.max(0, Math.min(1, (t - s[i]) / ((s[i + 1] - s[i]) || 1)));
      return [c[i][0] + (c[i + 1][0] - c[i][0]) * r, c[i][1] + (c[i + 1][1] - c[i][1]) * r];
    };
    const out = [at(a)];
    for (let i = 0; i < c.length; i++) if (s[i] > a && s[i] < b) out.push(c[i]);
    out.push(at(Math.min(b, s[s.length - 1])));
    return out;
  }
  // 중심선을 따라 폭 w (또는 w(i, n)) 인 띠, 중심에서 오른쪽으로 side 만큼 → 화면 다각형
  function jvRibbon(c, w, side) {
    const L = [], R = [], o = side || 0;
    for (let i = 0; i < c.length; i++) {
      const a = c[Math.max(0, i - 1)], b = c[Math.min(c.length - 1, i + 1)];
      let dx = b[0] - a[0], dz = b[1] - a[1];
      const n = Math.hypot(dx, dz) || 1;
      dx /= n; dz /= n;
      const hw = (typeof w === 'function' ? w(i, c.length) : w) / 2;
      L.push(jvP(c[i][0] + dz * (o - hw), c[i][1] - dx * (o - hw)));
      R.push(jvP(c[i][0] + dz * (o + hw), c[i][1] - dx * (o + hw)));
    }
    const f = (q) => q[0].toFixed(1) + ' ' + q[1].toFixed(1);
    return 'M' + L.map(f).join('L') + 'L' + R.reverse().map(f).join('L') + 'Z';
  }
  // 차선 점선: 중심선에서 오른쪽으로 off 만큼, 10m 마다 4m
  function jvDashes(c, off, from, to) {
    let d = '';
    for (let s = from; s < to; s += 10) d += jvRibbon(jvSlice(c, s, s + 4), 0.32, off);
    return d;
  }
  // 굵은 흰 화살표: 중심선을 따라 몸통 + 끝에 화살촉 (땅 위에 칠한 것처럼 원근)
  function jvArrow(c, end) {
    const head = end * 0.3; // 원근으로 먼 쪽이 작아지므로 화살촉을 길게
    return jvRibbon(jvSlice(c, 2, end - head + 1), 1.5) + jvRibbon(jvSlice(c, end - head, end), (i, n) => 4.6 * (1 - i / Math.max(1, n - 1)) + 0.05);
  }
  let jvN = 0;
  function juncSvg(j) {
    const sx = j.left ? -1 : 1;
    const mir = (c) => c.map((q) => [q[0] * sx, q[1]]);
    let roads, lanes, route, end;
    if (j.kind === 'fork') {
      // 갈림길: 12m 도로가 앞에서 두 갈래로. 가는 쪽을 파랗게
      const go = mir(jvCurve([[3, 0], [3, 40], [8, 80], [58, 250]], 48));
      const other = mir(jvCurve([[-3, 0], [-3, 40], [-8, 80], [-58, 250]], 48));
      roads = [[go, 6], [other, 6]];
      lanes = jvDashes(go, 0, 46, 240) + jvDashes(other, 0, 46, 240) + jvDashes(mir(jvCurve([[0, 0], [0, 14], [0, 28], [0, 42]], 8)), 0, 4, 40);
      route = go; end = 62;
    } else {
      // 진출로(·진입로): 본선은 곧게, 오른쪽 차로가 갈라져 나간다. 가는 길(연결로)을 파랗게
      const main = mir(jvCurve([[0, 0], [0, 200], [0, 450], [0, 700]], 70));
      const ramp = mir(jvCurve([[7.6, 0], [7.6, 38], [13, 70], [72, 210]], 48));
      roads = [[main, 11.4], [ramp, 4.6]];
      lanes = jvDashes(main, -1.9, 4, 700) + jvDashes(main, 1.9, 4, 700);
      route = ramp; end = 60;
    }
    const edge = roads.map(([c, w]) => '<path class="jc-edge" d="' + jvRibbon(c, w + 0.8) + '"/>').join('');
    const road = roads.map(([c, w]) => '<path class="jc-road" d="' + jvRibbon(c, w) + '"/>').join('');
    const band = '<path class="jc-hi" d="' + jvRibbon(jvSlice(route, 0, 400), 3.5) + '"/>';
    const arrow = '<path class="jc-arrow" d="' + jvArrow(route, end) + '"/>';
    const id = 'jc' + (++jvN); // 그림마다 그라데이션 id 를 따로 (숨은 그림의 id 를 잘못 가리키지 않게)
    return '<svg viewBox="0 0 ' + JV.W + ' ' + JV.H + '" class="jc jc-' + j.kind + '"><defs>' +
      '<linearGradient id="' + id + 's" x1="0" y1="0" x2="0" y2="1"><stop class="jc-s1" offset="0"/><stop class="jc-s2" offset="1"/></linearGradient>' +
      '<linearGradient id="' + id + 'g" x1="0" y1="0" x2="0" y2="1"><stop class="jc-g1" offset="0"/><stop class="jc-g2" offset="1"/></linearGradient></defs>' +
      '<rect width="' + JV.W + '" height="' + (JV.HZ + 1) + '" fill="url(#' + id + 's)"/>' +
      '<rect y="' + JV.HZ + '" width="' + JV.W + '" height="' + (JV.H - JV.HZ) + '" fill="url(#' + id + 'g)"/>' +
      edge + road + '<path class="jc-lane" d="' + lanes + '"/>' + band + arrow + '</svg>';
  }
  function renderJunction() {
    const el = $('#juncCard');
    const g = nav.active && prefs.junction ? nav.next : null;
    let j = g && nav.dg != null && nav.dg <= JUNC_SHOW ? juncInfo(g) : null;
    if (j && JUNC_ROAD[g.t] && !(ICON_PICKS['junc_' + j.kind + '_day'] && ICON_PICKS['junc_' + j.kind + '_night'])) j = null;
    juncState.g = j ? g : null;
    if (!j) {
      // 서랍에 분기점 그림만 있으면 접히는 동안은 그대로 두었다가 숨긴다
      if (!el.hidden && drawerAnimated() && !drawerKeeps('#juncCard')) startDrawerClose();
      else if (!drawer.closing) el.hidden = true;
      syncDrawer();
      return;
    }
    cancelDrawerClose();
    const key = g.i + ':' + g.t + ':' + g.s;
    if (juncState.key !== key) {
      juncState.key = key;
      // AI 분기점 장면(낮·밤, 오른쪽 그림. 왼쪽은 CSS 로 좌우 뒤집기)을 골라 두었으면 그것을, 아니면 그려 넣은 원근 그림 (2026-11-15 요청)
      const jd = ICON_PICKS['junc_' + j.kind + '_day'], jn = ICON_PICKS['junc_' + j.kind + '_night'];
      const jimg = (f, c) => '<img class="jv-img ' + c + ' jc-' + j.kind + '" src="' + APP_BASE + 'img/ai/' + f + '?v=' + APP_VERSION + '" alt="" draggable="false">';
      $('#juncSvg').innerHTML = jd && jn ? jimg(jd, 'jv-day') + jimg(jn, 'jv-night') : juncSvg(j.kind === 'entry' ? Object.assign({}, j, { kind: 'ramp' }) : j);
      $('#juncLabel').textContent = j.label || (j.left ? '왼쪽' : '오른쪽');
      $('#juncPlace').textContent = j.place;
      el.classList.toggle('left', j.left);
      el.classList.toggle('hwy', j.hwy);
    }
    // 남은 거리는 위 길안내 패널에 크게 나오므로 그림에는 지점 이름만 (2026-11-14: 같은 거리를 또 보여 줄 필요 없음)
    el.hidden = false;
    syncDrawer();
  }
  const tollState = { g: null, numsKey: '', nums: [], code: '', items: 0 };
  // 하이패스 차로 번호 (2026-11-14 요청: '몇 번으로 가야 하이패스'). 한국도로공사 '영업소별 하이패스차로 운영현황'(data.go.kr 15043760,
  // 전국 영업소·방향별 1~25번 차로 종류)을 data/hipass.json 에 담아 둔다 (tools/build_hipass.py). 키·서버 없이 바로 찾는다.
  // (한국도로공사 실시간 API '영업소 하이패스 차로 개폐 현황'은 자율주행 시범 구간 3곳뿐이라 쓰지 않는다)
  const hipass = { loaded: false, o: {}, date: '' };
  const SEOUL = { lat: 37.5665, lng: 126.978 };
  function setHipassData(j) {
    hipass.o = (j && j.o) || {}; hipass.date = (j && j.date) || ''; hipass.loaded = !!(j && j.o);
    tollState.numsKey = '';
  }
  async function loadHipass() {
    try {
      const r = await fetch('data/hipass.json?v=' + APP_VERSION);
      if (r.ok) setHipassData(await r.json());
    } catch (e) { /* 차로 자료가 없으면 번호 없이 */ }
  }
  // 톨게이트 이름 → 영업소 이름: 공백, 끝의 괄호('하남톨게이트(서울방향)'·'(개방식)', v98 부터 tollParts 가 이름에 괄호를 남긴다), '톨게이트' 등을 뗀다
  const hipassKey = (s) => String(s || '').replace(/\s+/g, '').replace(/(\([^()]*\))+$/, '').replace(/(톨게이트|영업소|요금소|TG)$/i, '');
  // 폐쇄식 영업소: 고속도로에 들어가는 톨게이트(앞 4km 안에 고속도로 진입 안내)면 입구 차로, 나오는 곳(앞 3km 안에 출구 안내)이면 출구 차로
  function tollSide(g) {
    const last = nav.cum.length - 1, sg = nav.cum[Math.min(g.i, last)];
    let side = '';
    for (const x of nav.guides || []) {
      const s = nav.cum[Math.min(x.i, last)];
      if (s >= sg) break;
      if (sg - s <= 4000 && HW_IN.has(x.t)) side = '입구';
      if (sg - s <= 3000 && HW_OUT.has(x.t)) side = '출구';
    }
    if (side) return side;
    // 안내로 모르면: 같은 경로에 앞서 지난 폐쇄식 톨게이트가 있으면 이번이 출구, 뒤에 또 있으면 이번이 입구
    let before = false, after = false;
    for (const x of nav.guides || []) {
      if (x === g || x.t !== 121) continue;
      const o = hipass.o[hipassKey(tollParts(x).name)];
      if (!o || o.t) continue;
      if (x.i < g.i) before = true; else after = true;
    }
    return before ? '출구' : after ? '입구' : '';
  }
  // 개방식 영업소(상행·하행)에서 우리 방향: 수도권 방사형 노선(s:1)이면 서울 쪽으로 가면 상행. 애매하면 ''.
  // 톨게이트 앞뒤 400m 로 진행 방향을 잰다 (진입로 굽이에 흔들리지 않게). 실제 경로: 하남IC→중부 상행 6°, 하남IC 출구(하행) 140°, 판교IC→경부 상행 20°
  function tollDir(g, o) {
    if (!o.s || !nav.pts) return '';
    const last = nav.pts.length - 1, i = Math.min(g.i, last), s0 = nav.cum[i];
    let a = i, b = i;
    while (a > 0 && s0 - nav.cum[a] < 400) a--;
    while (b < last && nav.cum[b] - s0 < 400) b++;
    if (a === b) return '';
    const diff = angleDiff(bearing(nav.pts[a], nav.pts[b]), bearing(nav.pts[i], SEOUL));
    return diff <= 50 ? 'u' : diff >= 130 ? 'd' : '';
  }
  // 차로 한 글자씩 (tools/build_hipass.py): H 하이패스 · M 다차로하이패스 · B 하이패스+유인 → 승용차 하이패스(파란 칸),
  // T 유인 · P 정산기 · h/b/t 화물차 차로 → 회색 칸, x 미운영(토목차로)·- 빈 칸 → 흐린 칸
  const LANE_KIND = { H: 'hp', M: 'hp', B: 'hp', T: 'op', P: 'op', h: 'op', b: 'op', t: 'op', x: 'off', '-': 'off' };
  const laneNums = (code) => [...String(code || '')].map((c, k) => (LANE_KIND[c] === 'hp' ? k + 1 : 0)).filter(Boolean);
  // 우리 방향의 차로 줄(code)을 고른다. 방향을 모르면: 두 방향 차로가 같으면 그 줄, 다르면 줄 없이 양쪽 다 하이패스인 번호만 (틀리지 않게)
  function hipassLayout(g) {
    const o = hipass.o[hipassKey(tollParts(g).name)];
    if (!o) return { code: '', nums: [] };
    let a, b, mine = '';
    if (o.t) { const d = tollDir(g, o); mine = d ? o[d] : ''; a = o.u; b = o.d; } else {
      const side = tollSide(g);
      mine = side === '입구' ? o.i : side === '출구' ? o.x : '';
      a = o.i; b = o.x;
    }
    if (!mine && a && a === b) mine = a;
    if (mine) return { code: mine, nums: laneNums(mine) };
    const nb = laneNums(b);
    return { code: '', nums: laneNums(a).filter((n) => nb.indexOf(n) >= 0) };
  }
  const hipassNums = (g) => hipassLayout(g).nums;
  // 하이패스 칸 아래 차로 줄 (2026-11-14 요청: 'hi-pass [2] 번 차로' 대신 톨게이트 차로를 1번부터 칸으로 늘어놓고 하이패스 차로만 파랗게).
  // 미운영 차로가 3개 넘게 이어지면 '⋯' 하나로. 그래도 max 칸보다 많으면 칸을 줄이지 않고 회색 칸 무리를 끝 2칸만 남기고 '⋯'로
  // (2026-11-14 요청: 동서울 25차로가 '2122232425'처럼 좁아지기보다 마지막 2~3개만). 파란 칸은 모두 남긴다
  function laneStripHtml(code, max) {
    const L = [...String(code || '')].map((c, k) => ({ no: k + 1, kind: LANE_KIND[c] || 'off', keep: true }));
    for (let k = 0; k < L.length;) {
      if (L[k].kind !== 'off') { k++; continue; }
      let e = k;
      while (e < L.length && L[e].kind === 'off') e++;
      if (e - k >= 3) for (let j = k; j < e; j++) L[j].keep = false;
      k = e;
    }
    const count = () => { let n = 0, gap = false; for (const x of L) { if (x.keep) { n++; gap = false; } else if (!gap) { n++; gap = true; } } return n; };
    for (let guard = 0; guard < 40 && max && count() > max; guard++) {
      let best = null;   // 가장 긴 회색(파랑 아닌) 칸 무리, 3칸 이상만
      for (let k = 0; k < L.length;) {
        if (!L[k].keep || L[k].kind === 'hp') { k++; continue; }
        let e = k;
        while (e < L.length && L[e].keep && L[e].kind !== 'hp') e++;
        if (e - k > 2 && (!best || e - k > best[1] - best[0])) best = [k, e];
        k = e;
      }
      if (!best) break;
      L[best[0]].keep = false;   // 무리의 앞쪽부터 접어 끝 2칸이 남게
    }
    const out = [];
    let gap = false;
    for (const x of L) {
      if (x.keep) { out.push('<b class="ln ' + x.kind + '">' + x.no + '</b>'); gap = false; } else if (!gap) { out.push('<i class="ln-gap">⋯</i>'); gap = true; }
    }
    return { html: out.join(''), count: out.length };
  }
  function renderTollLanes(g) {
    const el = $('#tollLanes');
    const beside = g === nav.next;   // 톨게이트가 다음 안내면 차로 줄이 배지 옆 한 줄 (좁다)
    const key = g.i + ':' + g.s + ':' + hipass.date + ':' + Math.round(nav.total || 0) + ':' + (nav.pts && nav.pts.length ? nav.pts[0].lat + ',' + nav.pts[0].lng : '') + ':' + beside;
    if (tollState.numsKey !== key) {
      tollState.numsKey = key;
      const lay = hipassLayout(g);
      tollState.nums = lay.nums; tollState.code = lay.code;
      el.dataset.hp = lay.nums.join(',');
      el.dataset.n = lay.code ? String(lay.code.length) : '0';
      if (lay.code) {
        const st = laneStripHtml(lay.code, beside ? 7 : 10);
        el.innerHTML = st.html;
        tollState.items = st.count;
        el.classList.remove('compact');
        el.setAttribute('aria-label', '하이패스 ' + lay.nums.join(', ') + '번 차로 (전체 ' + lay.code.length + '차로)');
      } else {
        el.innerHTML = lay.nums.map((n) => '<b class="ln hp">' + n + '</b>').join('');
        tollState.items = 0;
        el.classList.add('compact');
        el.setAttribute('aria-label', '하이패스 ' + lay.nums.join(', ') + '번 차로');
      }
    }
    // 접어도 칸이 너무 많을 때만(파란 칸이 많은 큰 영업소) 글자를 조금 작게
    el.classList.toggle('dense', (tollState.items || 0) > (beside ? 7 : 10));
    const show = tollState.nums.length > 0;
    el.hidden = !show;
    $('#tollCard').classList.toggle('has-lanes', show);
  }
  function renderToll() {
    const el = $('#tollCard');
    let g = null, ahead = 0;
    if (nav.active && nav.guides && nav.cum) {
      for (const x of nav.guides) {
        if (x.t !== 121) continue;
        const a = nav.cum[Math.min(x.i, nav.cum.length - 1)] - nav.along;
        if (a < -30) continue;  // 이미 지나감
        if (a <= 2000) { g = x; ahead = Math.max(0, a); }
        break;
      }
    }
    tollState.g = g;
    if (!g) {
      // 서랍에 하이패스만 있으면 접히는 동안은 그대로 두었다가 숨긴다
      if (!el.hidden && drawerAnimated() && !drawerKeeps('#tollCard')) startDrawerClose();
      else if (!drawer.closing) el.hidden = true;
      syncDrawer();
      return;
    }
    cancelDrawerClose();
    el.hidden = false;
    const p = tollParts(g);
    $('#tollName').textContent = p.name;
    $('#tollDist').textContent = fmtDist(ahead);
    // 이 톨게이트가 길안내 패널의 다음 안내면 거리가 패널에 크게 나오므로 여기서는 뺀다 (2026-11-14: 같은 미터기는 안 보여도 됨).
    // 그다음 칸('TG 300m')에 나올 때도 뺀다 (2026-11-14 실제 앱 흉내 주행 화면에 사용자가 '700m'에 X 표시: 패널의 'TG 300m'와 겹쳐 헷갈림.
    // 거리를 빼면 이름 '하남톨게이트'도 잘리지 않는다)
    $('#tollDist').hidden = g === nav.next || (!!nav.next && nav.guides[nav.gi + 1] === g);
    // 패널에 이름·통행료가 이미 크게 나오면 여기서는 이름 줄도 빼고 차로 번호를 넓게
    el.classList.toggle('is-next', g === nav.next);
    renderTollLanes(g);
    $('#tollFare').textContent = p.fare.replace(/^통행료\s*/, ''); // '800원'만 (한 줄 카드라 짧게). 하이패스 안내 문구는 둘째 줄에 고정
    syncDrawer();
  }
  // 테슬라 모드에서 단속 경고 묶음을 길안내 패널(없으면 검색 버튼) 바로 밑에 붙이고,
  // 위쪽 버튼(야간·전체화면·설정)은 그 패널(또는 검색 버튼) 바로 오른쪽에 붙인다
  function placeAlerts() {
    const app = $('#app');
    if (!app.classList.contains('tesla')) return;
    const base = app.getBoundingClientRect();
    const setVar = (k, px) => { const v = Math.round(px) + 'px'; if (app.style.getPropertyValue(k) !== v) app.style.setProperty(k, v); };
    const np = $('#navPanel'), sb = $('#searchBtn');
    // 안내 패널(맨 밑 '안내 종료' 줄)과 그 밑 경고 사이를 조금 띄운다 (2026-11-14: 너무 붙어 보임)
    // 단속 서랍은 패널 바로 밑에 붙는다. 그 밑의 다음 단속 등은 서랍 아래 여백(14px)+간격(8px)만큼 떨어진다
    setVar('--tl-top', !np.hidden ? np.getBoundingClientRect().bottom - base.top : 58);
    const anchor = !np.hidden ? np : !sb.hidden ? sb : null;
    if (anchor) {
      const r = anchor.getBoundingClientRect();
      setVar('--tc-left', r.right - base.left + 8);
      setVar('--tc-top', r.top - base.top);
    }
  }

  // 지도 왼쪽 세로 막대: 맨 아래 출발, 맨 위 도착으로 고정. 내 차 점이 올라가고, 지나온 만큼 막대가 줄어든다.
  // 색은 지도 경로선과 같다: 교통 정보 없음 파랑, 원활 초록, 서행 주황, 정체 빨강.
  // 재탐색해도 출발점은 그대로 (전체 = 지금까지 달린 거리 + 남은 거리).
  function renderStrip() {
    const el = $('#routeStrip');
    if (!nav.active || !nav.pts || !nav.route) { el.hidden = true; return; }
    el.hidden = false;
    const along = nav.along, total = nav.total, rem = Math.max(0, total - along);
    const done = Math.max(0, state.odo - (nav.odo0 != null ? nav.odo0 : state.odo));
    const whole = Math.max(1, done + rem);
    const p = Math.min(100, done / whole * 100); // 지나온 비율 (아래에서부터)
    const remMs = nav.route.duration * (rem / Math.max(1, total));
    $('#rsRemain').textContent = fmtDist(rem);
    $('#rsEta').textContent = hhmm(new Date(Date.now() + remMs)) + ' 도착';
    // 색 막대는 내 차(p%)부터 도착(100%)까지만 그린다. 그 안의 위치는 남은 거리 기준 비율
    const left = Math.max(1, rem);
    const at = (x) => (x - along) / left * 100;
    const last = nav.cum.length - 1;
    const runs = [];
    (nav.route.sections || []).forEach((s) => {
      const color = trafficColor(s);
      if (!color || !Number.isFinite(s.i) || !Number.isFinite(s.n)) return;
      const lo = Math.max(nav.cum[Math.min(s.i, last)], along);
      const hi = Math.min(nav.cum[Math.min(s.i + Math.max(1, s.n) - 1, last)], total);
      if (hi > lo) runs.push([at(lo), at(hi), color]);
    });
    runs.sort((a, b) => a[0] - b[0]);
    const base = ROUTE_BASE, stops = [];
    let pos = 0;
    runs.forEach(([p0, p1, c]) => {
      if (p0 > pos) stops.push(base + ' ' + pos.toFixed(1) + '%', base + ' ' + p0.toFixed(1) + '%');
      stops.push(c + ' ' + Math.max(p0, pos).toFixed(1) + '%', c + ' ' + p1.toFixed(1) + '%');
      pos = Math.max(pos, p1);
    });
    if (pos < 100) stops.push(base + ' ' + pos.toFixed(1) + '%', base + ' 100%');
    const bar = $('#rsBar');
    bar.style.background = 'linear-gradient(to top, ' + stops.join(', ') + ')';
    bar.style.bottom = p.toFixed(2) + '%';
    $('#rsMe').style.bottom = p.toFixed(2) + '%';
  }

  function renderNav() {
    renderToll();
    renderJunction();
    renderNavPanel();
    placeAlerts(); // 안내 패널 높이가 바뀌면 그 밑의 단속 경고도 따라 움직인다
    checkTripCover();
  }
  // 테슬라 모드: 서랍(분기점 그림·단속·하이패스)이 길어져 왼쪽 아래 주행 기록·나침반에 닿으면 그동안 그 둘을 숨긴다 (글자가 겹치지 않게)
  function checkTripCover() {
    const app = $('#app');
    if (!app.classList.contains('tesla')) { app.classList.remove('trip-covered'); return; }
    const dr = $('#camDrawer'), tops = [$('.trip'), $('.heading')].filter(Boolean).map((e) => e.getBoundingClientRect().top).filter((v) => v > 0);
    // 서랍 밑에 붙는 다음 단속·과속방지턱·주의 표지 칸도 본다 (2026-11-14: 하이패스 차로 줄로 서랍이 길어지자 '100 14km'가 나침반에 겹침)
    const lows = [dr.classList.contains('open') ? dr : null, $('#camNext'), $('#bumpCard'), $('#signCard'), $('#parkCard'), $('#restCard')]
      .filter((e) => e && !e.hidden && e.offsetParent !== null).map((e) => e.getBoundingClientRect().bottom);
    const covered = tops.length > 0 && lows.length > 0 && Math.max(...lows) > Math.min(...tops) - 6;
    app.classList.toggle('trip-covered', covered);
  }
  function renderNavPanel() {
    const p = $('#navPanel');
    renderStrip();
    if (!nav.active) { p.hidden = true; $('#searchBtn').hidden = false; return; }
    p.hidden = false;
    $('#searchBtn').hidden = true;
    // 맨 위 목적지 줄 (경유지가 있으면 오른쪽에 작게)
    $('#navDestName').textContent = nav.dest ? nav.dest.name : '';
    $('#navDestVia').textContent = nav.via && nav.via[0] ? '경유 ' + nav.via[0].name : '';
    const g = nav.next;
    renderTurnArrow();
    renderRest();
    $('#turnIcon').innerHTML = ico(g ? turnKind(g) : 'goal');
    $('#turnDist').textContent = fmtDist(nav.dg != null ? nav.dg : nav.total);
    if (g && g.t === 121) {
      // 톨게이트: 다른 내비처럼 통행료를 굵게 앞에 ('800원 하남톨게이트'), 아이콘은 TG 표지 (2026-11-14 요청)
      const p = tollParts(g), fee = p.fare.replace(/^통행료\s*/, '');
      $('#turnText').innerHTML = (fee ? '<b class="tt-fare">' + esc(fee) + '</b>' : '') + esc(p.name);
    } else {
      $('#turnText').textContent = g ? g.s : nav.dest.name;
    }
    // 그다음 칸: 이번 회전을 하고 나서 무엇이 얼마 뒤에 오는지 (거리는 이번 안내 지점 → 그다음 안내 지점).
    //   그다음이 회전이면 네이버 지도처럼 그 회전 아이콘 + 거리만 '↰ 1.2km' (2026-11-14: '직진 … 좌회전'처럼 풀어 쓰지 않음)
    //   그다음이 목적지면 연한 빨강 바탕에 빨간 핀 + '20m', 경유지면 주황 (2026-11-14: '도착' 글자는 빼고 핀·바탕색으로만 구분)
    const g2 = g ? nav.guides[nav.gi + 1] : null;
    const nn = $('#nextTurn');
    nn.hidden = !g2;
    if (g2) {
      const last = nav.cum.length - 1;
      const gap = Math.max(0, nav.cum[Math.min(g2.i, last)] - nav.cum[Math.min(g.i, last)]);
      const k2 = turnKind(g2);
      const isVia = g2.t === 87 || /경유지/.test(g2.s || '');
      const isGoal = !isVia && (k2 === 'goal' || k2 === 'via');
      nn.classList.toggle('goal', isGoal);
      nn.classList.toggle('via', isVia);
      if (isGoal || isVia) {
        $('#nextIcon').innerHTML = pinIco(isVia);
        $('#nextDist').textContent = fmtDist(gap);
      } else {
        $('#nextIcon').innerHTML = ico(k2);
        $('#nextDist').textContent = fmtDist(gap);
      }
    }
    const remain = nav.remain != null ? nav.remain : nav.total;
    const remMs = nav.route.duration * (remain / Math.max(1, nav.total));
    renderTunnel();
    // 가까운 것이 위로: 터널(진입·출구까지)이 그다음 칸(지금 안내 지점 + 그 뒤 거리)보다 가까우면 터널 줄을 그다음 칸 위로
    {
      const tr = $('#tunnelRow'), ta = !tr.hidden ? tunnelAhead() : null;
      const chipAt = g2 && nav.dg != null ? nav.dg + Math.max(0, nav.cum[Math.min(g2.i, nav.cum.length - 1)] - nav.cum[Math.min(g.i, nav.cum.length - 1)]) : Infinity;
      const up = !!(ta && !nn.hidden && ta.d < chipAt);
      if (up && tr.nextElementSibling !== nn) nn.parentNode.insertBefore(tr, nn);
      else if (!up && nn.nextElementSibling && nn.nextElementSibling !== tr && tr.nextElementSibling === nn) nn.parentNode.insertBefore(tr, nn.nextElementSibling);
    }
    $('#navRemain').textContent = fmtDist(remain);
    $('#navTime').textContent = fmtMin(remMs);
    $('#navEta').textContent = '도착 ' + hhmm(new Date(Date.now() + remMs));
  }

  // 주행 중 배율: 17 이 기본, 시속 100km 넘으면 16.
  // 2026-11-14 요청('건물이 보일 만큼 가까이 보는 건 도착하는 건물에 가까워질 때, 가는 중 회전마다 할 필요는 없다'):
  // 예전에는 시속 60km 아래와 회전 300m 앞에서 18 로 당겼다. 이제 18 은 목적지까지 남은 길 300m 안에서만
  const zoomCtl = { last: 0, manualUntil: 0, stillSince: 0 };
  const ZOOM_ARRIVE_M = 300;
  const speedZoom = (v) => (v <= 100 ? 17 : 16);
  function autoZoom(f) {
    const v = state.speedKmh;
    if (v >= 5) zoomCtl.stillSince = 0;
    else if (!zoomCtl.stillSince) zoomCtl.stillSince = f.t;
    if (!state.following || !mapA || nav.preview || f.t < zoomCtl.manualUntil) return;
    if (f.t - zoomCtl.last < 4000) return;
    const cur = mapA.getZoom();
    let z;
    if (nav.active && nav.remain != null && nav.remain < ZOOM_ARRIVE_M) z = 18;
    else if (v >= 5) {
      z = speedZoom(v);
      // 경계 속도 근처에서는 줌이 오락가락하지 않게 지금 단계를 유지
      const edge = Math.min(z, cur) === 16 ? 100 : 60;
      if (cur >= 16 && cur <= 18 && Math.abs(z - cur) === 1 && Math.abs(v - edge) < 4) z = cur;
    } else if (f.t - zoomCtl.stillSince >= 10000) z = 17; // 10초 넘게 서 있으면
    else return;
    if (z !== cur) { zoomCtl.last = f.t; mapA.setZoom(z); }
  }
  // +/- 버튼을 누르면 30초 동안 자동 줌을 멈춘다
  function manualZoom(d) {
    if (!mapA) return;
    mapA.zoomBy(d);
    zoomCtl.manualUntil = (state.fix ? state.fix.t : Date.now()) + 30000;
  }

  // ---------- 현재 도로 이름 ----------
  // ---------- 날씨 (Open-Meteo, 키 없음). 위치는 약 10km 단위로 뭉개서 보낸다. 15분마다 갱신 ----------
  const weather = { at: null, t: 0, busy: false, last: null };
  const WMO = [[0, '맑음'], [2, '구름 조금'], [3, '흐림'], [48, '안개'], [57, '이슬비'], [67, '비'], [77, '눈'], [82, '소나기'], [86, '눈 소나기'], [99, '뇌우']];
  const wmoText = (code) => { for (const [max, t] of WMO) if (code <= max) return t; return ''; };
  // 날씨 아이콘 (애플 날씨처럼 단순한 색 아이콘): 해·달은 노랑, 구름은 흰색, 비·이슬비는 파랑, 눈은 흰 점, 번개는 노랑
  const WX_SUN = '<circle cx="12" cy="12" r="4.2" fill="#ffc83d"/><g stroke="#ffc83d" stroke-width="1.8" stroke-linecap="round"><path d="M12 2.6v2.2M12 19.2v2.2M2.6 12h2.2M19.2 12h2.2M5.4 5.4l1.5 1.5M17.1 17.1l1.5 1.5M5.4 18.6l1.5-1.5M17.1 6.9l1.5-1.5"/></g>';
  const WX_MOON = '<path d="M15.5 3.2a8.6 8.6 0 1 0 5.3 13.1A7 7 0 0 1 15.5 3.2z" fill="#f4e7a1"/>';
  const WX_CLOUD = (y, fill) => '<path transform="translate(0 ' + (y || 0) + ')" d="M7.2 19.2h10.1a4.2 4.2 0 0 0 .4-8.4 5.6 5.6 0 0 0-10.7 1.6A3.4 3.4 0 0 0 7.2 19.2z" fill="' + (fill || '#eef2f7') + '"/>';
  function wxIcon(code, night) {
    const sky = night ? WX_MOON : WX_SUN;
    const small = (s) => '<g transform="translate(-3.4 -3.6) scale(.72)">' + s + '</g>';
    const drops = (n, len) => '<g stroke="#5ab0ff" stroke-width="1.7" stroke-linecap="round">' +
      [8.6, 12.2, 15.8].slice(0, n).map((x) => '<path d="M' + x + ' 19.6l-.9 ' + len + '"/>').join('') + '</g>';
    let g;
    if (code === 0) g = sky;
    else if (code <= 2) g = small(sky) + WX_CLOUD(1.4);
    else if (code === 3) g = WX_CLOUD(-0.6, '#cfd6df');
    else if (code <= 48) g = WX_CLOUD(-3, '#cfd6df') + '<g stroke="#aeb7c2" stroke-width="1.6" stroke-linecap="round"><path d="M5 18h14M7 21h10"/></g>';
    else if (code <= 57) g = WX_CLOUD(-3) + '<g fill="#5ab0ff"><circle cx="8.6" cy="19.8" r="1"/><circle cx="12.4" cy="21.2" r="1"/><circle cx="16" cy="19.8" r="1"/></g>'; // 이슬비
    else if (code <= 67 || (code >= 80 && code <= 82)) g = WX_CLOUD(-3) + drops(3, 2.8);
    else if (code <= 77 || code === 85 || code === 86) g = WX_CLOUD(-3) + '<g fill="#ffffff"><circle cx="8.4" cy="20" r="1.2"/><circle cx="12.2" cy="21.6" r="1.2"/><circle cx="16" cy="20" r="1.2"/></g>';
    else g = WX_CLOUD(-3, '#cfd6df') + '<path d="M12.6 16.2l-2.6 4h2.4l-1.2 3.6 3.6-5h-2.5l1.4-2.6z" fill="#ffc83d"/>'; // 뇌우
    return '<svg class="wxicon" viewBox="0 0 24 24" aria-hidden="true">' + g + '</svg>';
  }
  // 우산 표지 (비 확률 앞): 지붕 + 손잡이 + 빗방울 두 개
  const RAIN_ICON = '<svg class="wxumb" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12a9 9 0 0 1 18 0z" fill="currentColor"/>' +
    '<path d="M12 12v6.5a2 2 0 0 1-4 0" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
  function renderWeather() {
    const w = weather.last, el = $('#weather');
    if (!w) return;
    const p = weather.at || state.fix || DEFAULT_CENTER;
    const night = sunElevation(new Date(), p.lat, p.lng) < -2;
    // 기온 → 날씨 아이콘 → 날씨 글자(테슬라 모드에서는 글자 대신 아이콘만) · 비 확률
    const desc = wmoText(w.code);
    el.innerHTML = '<b>' + Math.round(w.temp) + '°</b><span class="wxi" title="' + esc(desc) + '" aria-label="' + esc(desc) + '">' + wxIcon(w.code, night) +
      '</span><span class="wxt">' + esc(desc) + '</span>' +
      // 비 확률: '비' 글자 대신 우산 표지 + 숫자, 흰 글자 (2026-11-14 요청: 파란 '비 93%' 보다 낫다)
      (w.pp != null ? '<span class="wxsep"> · </span><span class="wxpp' + (w.pp >= 50 ? ' rain' : '') + '" aria-label="비 ' + w.pp + '%">' + RAIN_ICON + w.pp + '%</span>' : '');
    el.hidden = !prefs.weather;
  }
  async function updateWeather(f) {
    if (!prefs.weather || weather.busy) return;
    if (weather.at && f.t - weather.t < 15 * 60000 && haversine(weather.at, f) < 10000) return;
    weather.busy = true;
    weather.at = { lat: f.lat, lng: f.lng };
    weather.t = f.t;
    try {
      // 길안내 서버를 거쳐 받는다 (서버가 위치를 약 10km 단위로 뭉개서 Open-Meteo 에 묻는다)
      const j = await api('/weather', { lat: (Math.round(f.lat * 10) / 10).toFixed(1), lng: (Math.round(f.lng * 10) / 10).toFixed(1) });
      const temp = j.temp, code = j.code, pp = Number.isFinite(j.rain) ? j.rain : null;
      if (!Number.isFinite(temp)) throw new Error('no data');
      weather.last = { temp, code: Number(code) || 0, pp };
      renderWeather();
    } catch (e) {
      weather.t = f.t - 10 * 60000; // 실패하면 5분 뒤 다시
    } finally {
      weather.busy = false;
    }
  }

  const road = { at: null, t: 0, fails: 0, busy: false, name: '' }; // name: 지금 달리는 도로 이름 (카메라 판단에도 씀)
  async function updateRoad(f) {
    if (road.busy) return;
    if (road.fails > 3 && f.t - road.t < 300000) return; // 연속 실패하면 5분 쉬었다 다시 시도
    if (road.at && (f.t - road.t < 15000 || (haversine(road.at, f) < 150 && f.t - road.t < 60000))) return;
    road.busy = true;
    road.at = { lat: f.lat, lng: f.lng };
    road.t = f.t;
    try {
      const j = await api('/reverse', { coords: f.lng.toFixed(6) + ',' + f.lat.toFixed(6) });
      road.fails = 0;
      road.name = j.road || '';
      road.area = j.area || '';
      renderRoadPill(j.road || '', j.area || '');
    } catch (e) {
      road.fails++;
    } finally {
      road.busy = false;
    }
  }

  // ---------- 위치 처리 ----------
  // 아래 가운데 지금 위치 띠 (2026-11-15 요청: 글자를 크게 안 보여 줘도 됨, 잘리면 '…' 대신 천천히 밀어서 보여 주기)
  function renderRoadPill(name, area) {
    const el = $('#roadName');
    if (!name && !area) { el.innerHTML = ''; return; }
    el.innerHTML = '<span class="rn-clip"><span class="rn-in">' + esc(name) + (area ? '<small>' + esc(area) + '</small>' : '') + '</span></span>';
    const clip = el.firstChild, inner = clip.firstChild;
    const over = inner.offsetWidth - clip.clientWidth;
    el.classList.toggle('slide', over > 4);
    if (over > 4) {
      inner.style.setProperty('--rn-shift', -over + 'px');
      inner.style.animationDuration = Math.round(7 + over / 25) + 's';   // 넘친 만큼 느긋하게 (한 번에 25px/초 정도)
    }
  }
  function setGps(kind, text) {
    $('#gpsDot').className = 'dot ' + (kind || '');
    $('#gpsText').textContent = text;
  }

  // ---------- 부드러운 이동 ----------
  // GPS 는 보통 1초에 한 번 온다. 그 사이를 속도·방향으로 예측해 매 프레임 조금씩 움직여 툭툭 끊기지 않게 한다.
  const motion = { cur: null, fix: null, v: 0, hdg: null, raf: 0, last: 0 };
  function mePos() { return motion.cur || state.fix; }
  // 길안내 중 경로 위에 있으면 내 차를 경로(도로) 위에 붙이고, 예측도 직선이 아니라 도로를 따라 한다
  function routePointAt(s) {
    const pts = nav.pts, cum = nav.cum;
    if (!pts || pts.length < 2) return null;
    s = Math.max(0, Math.min(s, nav.total));
    let i = Math.max(0, Math.min(nav.seg, pts.length - 2));
    while (i > 0 && cum[i] > s) i--;
    while (i < pts.length - 2 && cum[i + 1] < s) i++;
    const len = cum[i + 1] - cum[i];
    const r = len > 0 ? (s - cum[i]) / len : 0;
    return { lat: pts[i].lat + (pts[i + 1].lat - pts[i].lat) * r, lng: pts[i].lng + (pts[i + 1].lng - pts[i].lng) * r };
  }
  function motionFix(f, jump) {
    motion.fix = { lat: f.lat, lng: f.lng, t: performance.now() };
    motion.v = state.speedKmh / 3.6;
    motion.hdg = state.heading;
    motion.snap = !!(nav.active && nav.pts && nav.onRoute);
    motion.along = nav.along;
    const p = (motion.snap && routePointAt(nav.along)) || f;
    if (jump || !motion.cur || haversine(motion.cur, p) > 150) {
      motion.cur = { lat: p.lat, lng: p.lng };
      if (mapA) { mapA.setMe(p.lat, p.lng); if (state.following) mapA.center(p.lat, p.lng, true); }
    }
    if (!motion.raf) { motion.last = performance.now(); motion.raf = requestAnimationFrame(motionFrame); }
  }
  function motionTarget(now) {
    const fx = motion.fix;
    const dt = Math.min(Math.max(0, (now - fx.t) / 1000), 1.5); // 다음 위치가 늦어도 1.5초까지만 앞질러 예측
    if (motion.snap && nav.pts) {
      const p = routePointAt(motion.along + (motion.v >= 0.5 ? motion.v * dt : 0));
      if (p) return p;
    }
    if (motion.v < 0.5 || motion.hdg === null) return fx;
    const d = motion.v * dt, br = toRad(motion.hdg);
    return { lat: fx.lat + d * Math.cos(br) / 110540, lng: fx.lng + d * Math.sin(br) / (111320 * Math.cos(toRad(fx.lat))) };
  }
  function motionFrame(now) {
    motion.raf = requestAnimationFrame(motionFrame);
    if (now - motion.last < 30) return; // 약 30fps 면 충분히 부드럽고 차량 화면 부담도 적다
    const dt = Math.min((now - motion.last) / 1000, 0.2);
    motion.last = now;
    if (!motion.fix || !motion.cur || !mapA) return;
    const tg = motionTarget(now), cur = motion.cur;
    const dLat = tg.lat - cur.lat, dLng = tg.lng - cur.lng;
    if (Math.abs(dLat) < 1e-7 && Math.abs(dLng) < 1e-7) return; // 멈춰 있으면 지도를 건드리지 않는다
    const k = 1 - Math.exp(-dt / 0.18);
    cur.lat += dLat * k; cur.lng += dLng * k;
    mapA.setMe(cur.lat, cur.lng);
    if (state.following) mapA.center(cur.lat, cur.lng, true);
  }

  // 최근 40~150m 주행 궤적의 방향 변화로 곡률을 잰다 (굽은 길에서 앞쪽 카메라를 찾을 때 씀).
  // 반지름 60m 보다 급한 값은 GPS 흔들림으로 보고 자른다. 멈추면 초기화
  function updateCurvature() {
    if (state.speedKmh < 10 || state.heading === null) {
      if (state.speedKmh < 3) { curv.hist = []; curv.k = 0; }
      return;
    }
    const h = curv.hist;
    h.push({ s: state.odo, hd: state.heading });
    while (h.length > 2 && state.odo - h[0].s > 150) h.shift();
    const ds = state.odo - h[0].s;
    if (ds < 40) return;
    const dh = ((state.heading - h[0].hd) % 360 + 540) % 360 - 180;
    curv.k = Math.max(-1 / 60, Math.min(1 / 60, toRad(dh) / ds));
  }

  // ---------- 주행 기록: 주행마다 거리·시간·속도·과속 위치를 이 차 브라우저에 남긴다 ----------
  // 움직이기 시작하면 주행 시작, 5분 넘게 서 있으면 끝. 새로고침·새 버전으로 바뀌어도 10분 안이면 이어서 쓴다
  const TRIP_GAP = 5 * 60000;
  const tripLog = { cur: null, savedAt: 0 };
  function loadTrips() { try { const a = JSON.parse(store.get('trips') || '[]'); return Array.isArray(a) ? a : []; } catch (e) { return []; } }
  const placeLabel = () => [road.area, road.name].filter(Boolean).join(' ') || '';
  function tripTick(f) {
    if (state.demoTimer) return; // 데모 주행은 기록하지 않는다
    const now = f.t, moving = state.speedKmh >= 8;
    let c = tripLog.cur;
    if (c && now - c.lastMove > TRIP_GAP) { finishTrip(); c = null; }
    if (!c && moving) {
      c = tripLog.cur = { id: now.toString(36), start: now, lastMove: now, odo0: state.odo, drive0: state.driveMs,
        dist: 0, drive: 0, max: 0, from: placeLabel(), to: '', dest: '', events: [] };
    }
    if (!c) return;
    if (moving) c.lastMove = now;
    c.dist = state.odo - c.odo0;
    c.drive = state.driveMs - c.drive0;
    if (state.speedKmh > c.max && state.speedKmh < 250) c.max = Math.round(state.speedKmh);
    const pl = placeLabel();
    if (!c.from && pl) c.from = pl;
    if (pl) c.to = pl;
    if (nav.active && nav.dest) c.dest = nav.dest.name;
    if (now - tripLog.savedAt > 30000) saveCurTrip();
  }
  function saveCurTrip() {
    tripLog.savedAt = state.fix ? state.fix.t : Date.now();
    if (tripLog.cur) store.set('tripCur', JSON.stringify(tripLog.cur));
  }
  function finishTrip() {
    const c = tripLog.cur;
    tripLog.cur = null;
    store.set('tripCur', null);
    if (!c || (c.dist || 0) < 300) return; // 주차장 안에서 조금 움직인 것은 빼고
    const list = loadTrips();
    list.unshift(c);
    store.set('trips', JSON.stringify(list.slice(0, 60)));
  }
  // 과속 같은 일을 지금 주행에 붙인다. 고쳐 쓸 수 있게 그 기록 객체를 돌려준다
  function tripEvent(e) {
    const ev = Object.assign({ t: state.fix ? state.fix.t : Date.now(), place: placeLabel(),
      lat: state.fix ? state.fix.lat : null, lng: state.fix ? state.fix.lng : null }, e);
    const c = tripLog.cur;
    if (c && c.events.length < 100) { c.events.push(ev); saveCurTrip(); }
    return ev;
  }
  // 페이지를 다시 열면: 10분 안에 끊긴 주행은 이어 쓰고(누적 거리 기준을 다시 맞춘다), 오래됐으면 끝난 주행으로 넣는다
  function resumeTrip() {
    let c = null;
    try { c = JSON.parse(store.get('tripCur') || 'null'); } catch (e) { c = null; }
    if (!c) return;
    if (Date.now() - c.lastMove < 10 * 60000) {
      c.odo0 = state.odo - (c.dist || 0);
      c.drive0 = state.driveMs - (c.drive || 0);
      tripLog.cur = c;
    } else {
      tripLog.cur = c;
      finishTrip();
    }
  }
  // 화면의 주행 거리·주행 시간·평균·최고 속도: 새 버전으로 바뀌어도 이어서 센다 (2026-11-14 요청: 업데이트하면 0 이 됐다).
  // 몇 초마다 저장해 두고, 새 버전으로 옮겨 온 것이면(하루 안) 그대로, 그냥 새로고침이면 30분 안일 때만 되살린다
  const TRIPNOW_KEY = 'tripNow';
  let tripNowAt = 0;
  function saveTripNow(force) {
    if (state.demoTimer) return; // 데모 주행 중에는 실제 기록이 따로 보관돼 있다
    const now = Date.now();
    if (!force && now - tripNowAt < 5000) return;
    tripNowAt = now;
    store.set(TRIPNOW_KEY, JSON.stringify({ trip: state.trip, driveMs: state.driveMs, maxKmh: state.maxKmh || 0, odo: state.odo, at: now }));
  }
  function restoreTripNow() {
    let s = null, viaUpdate = false;
    try { s = JSON.parse(store.get(TRIPNOW_KEY) || 'null'); } catch (e) { s = null; }
    try { viaUpdate = sessionStorage.getItem('tnc.updTried') === APP_VERSION; } catch (e) { /* 저장소 막힘 */ }
    if (!s || !(s.at > 0)) return false;
    const age = Date.now() - s.at;
    if (age < 0 || age > (viaUpdate ? 24 * 3600000 : 30 * 60000)) return false;
    state.trip = +s.trip || 0; state.driveMs = +s.driveMs || 0; state.maxKmh = +s.maxKmh || 0; state.odo = +s.odo || 0;
    return true;
  }
  if (!testPage) restoreTripNow();   // resumeTrip 이 누적 거리(odo)를 기준으로 이어 쓰므로 그보다 먼저
  resumeTrip();
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') { saveCurTrip(); saveTripNow(true); } });
  window.addEventListener('pagehide', () => { saveCurTrip(); saveTripNow(true); });

  let lastFixWall = 0;
  function onFix(f) {
    const t0 = performance.now();
    const prev = state.fix;
    if (prev && f.t <= prev.t) return; // 같은 시각이나 더 오래된(캐시된) 위치는 버린다
    lastFixWall = Date.now();
    $('#speed').classList.remove('stale');
    let v = Number.isFinite(f.speed) && f.speed >= 0 ? f.speed : null; // m/s
    let h = Number.isFinite(f.heading) ? f.heading : null;

    if (prev) {
      const dt = (f.t - prev.t) / 1000;
      const d = haversine(prev, f);
      if (dt > 0 && dt < 30) {
        // 브라우저가 속도를 안 주면 두 지점 거리로 계산 (정확도 이내 흔들림은 정지로 본다)
        if (v === null) v = d > Math.max(3, (f.acc || 10) * 0.4) ? d / dt : 0;
        if (v * 3.6 > 3 && d < 70 * dt) { state.trip += d; state.odo += d; state.driveMs += dt * 1000; }
        if (h === null && d > 4) h = bearing(prev, f);
      } else if (dt >= 30 && d < 50 * dt) {
        // 터널 등으로 신호가 오래 끊겼다 돌아오면 그 사이 거리도 더한다 (구간단속 평균속도가 낮게 나오지 않도록)
        state.trip += d; state.odo += d;
        if (d / dt > 1) state.driveMs += dt * 1000;
      }
    }

    const kmh = (v || 0) * 3.6;
    state.speedKmh = kmh < 2 ? 0 : kmh;
    if (state.speedKmh > (state.maxKmh || 0) && state.speedKmh < 250) state.maxKmh = state.speedKmh; // 튀는 값 제외
    if (h !== null && state.speedKmh >= 3) state.heading = h; // 정지 중 GPS 방향은 믿지 않음
    state.fix = f;
    updateCurvature();
    checkStopNorth(f.t);
    if (!prev) applyNight(); // 첫 위치를 알게 되면 그 곳의 해 지는 시각으로 다시 본다

    const acc = Math.round(f.acc || 0);
    setGps(acc <= 25 ? 'ok' : 'warn', 'GPS ±' + acc + 'm');
    render();
    navUpdate(f);        // 경로 위 위치를 먼저 계산해야 내 차를 도로에 붙일 수 있다
    motionFix(f, !prev); // 지도·내 차는 매 프레임 부드럽게 따라간다
    tripTick(f);         // 주행 기록 (과속 기록은 바로 아래 카메라 판단에서 붙는다)
    saveTripNow();       // 화면의 주행 거리·시간·최고 속도 (새 버전으로 바뀌어도 이어서)
    evalCameras(f);
    refreshCamMarkers(f);
    evalBumps(f);
    evalParking(f);
    evalSigns(f);
    autoZoom(f);
    updateRoad(f);
    updateWeather(f);
    diagAfterFix(f, t0);
  }

  function startGps() {
    if (!window.isSecureContext) {
      setGps('bad', 'HTTPS 필요');
      toast('위치는 HTTPS 주소에서만 쓸 수 있습니다.', 'bad', 0);
      return;
    }
    if (!('geolocation' in navigator)) { setGps('bad', '위치 미지원 브라우저'); return; }
    setGps('warn', 'GPS 신호 찾는 중');
    let lastGoodFix = 0, tsReported = false;
    if (gpsWatch != null) navigator.geolocation.clearWatch(gpsWatch);
    gpsWatch = navigator.geolocation.watchPosition((p) => {
      diagRaw(p);
      gpsNotice(false);
      if (state.demoTimer) return;
      const now = Date.now(), acc = p.coords.accuracy;
      // 테슬라 브라우저는 위치 시각(timestamp) 단위가 달라 주행 시간·재탐색 간격 계산이 틀어졌다.
      // 시각은 기기 시계(받은 순간)를 쓰고, 원래 값이 이상하면 한 번 운영 서버에 알린다.
      if (!tsReported && p.timestamp && Math.abs(p.timestamp - now) > 60000) {
        tsReported = true;
        report('warn', { msg: 'odd geolocation timestamp', raw: p.timestamp, now });
      }
      // 가끔 섞여 오는 아주 부정확한 위치(예: ±10km)는 최근 30초 안에 정확한 위치가 있었다면 버린다
      if (!(acc <= 150) && state.fix && now - lastGoodFix < 30000) return;
      if (acc <= 150) lastGoodFix = now;
      onFix({
        lat: p.coords.latitude, lng: p.coords.longitude, acc,
        speed: p.coords.speed, heading: p.coords.heading, t: now,
      });
    }, (err) => {
      if (state.demoTimer) return;
      if (err.code === 1) {
        if (!gpsDeniedReported) { gpsDeniedReported = true; report('warn', { msg: 'gps permission denied' }); }
        setGps('bad', '위치 권한 꺼짐');
        gpsNotice(true);
      } else {
        setGps('warn', err.code === 3 ? 'GPS 신호 약함' : 'GPS 오류');
      }
    }, { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 });
  }
  // 위치 권한이 꺼져 있을 때: 아래 작은 알림(예전 토스트) 대신 지도 가운데에 분명한 안내 카드
  // (2026-11-14 요청 '요거 알림은 띄우는 게 좋지 않을까'). 무엇이 안 되는지·켜는 순서·다시 시도.
  // '다시 시도'를 눌렀는데 여전히 꺼져 있으면 한 줄 더 알려 준다. '나중에'로 닫아도 오른쪽 아래 'GPS 위치 권한 꺼짐'을 누르면 다시 연다.
  // 브라우저 설정에서 허용으로 바뀌면(permissions change) 저절로 닫고 위치를 다시 받는다. 데모 중에는 띄우지 않는다
  let gpsWatch = null, gpsDeniedReported = false, gpsRetried = false, gpsDenied = false;
  function gpsNotice(show) {
    const el = $('#gpsNotice');
    if (!el) return;
    gpsDenied = !!show;
    $('.gps').classList.toggle('tap', gpsDenied);   // 꺼져 있는 동안만 오른쪽 아래 GPS 글자를 눌러 안내를 다시 연다
    if (show && state.demoTimer) return;
    if (show) el.classList.toggle('again', gpsRetried);
    el.hidden = !show;
    if (!show) gpsRetried = false;
  }
  $('#gpsRetry').addEventListener('click', () => { gpsRetried = true; $('#gpsNotice').hidden = true; startGps(); });
  $('#gpsLater').addEventListener('click', () => { gpsRetried = false; $('#gpsNotice').hidden = true; });
  $('.gps').addEventListener('click', () => { if (gpsDenied && !state.demoTimer) { gpsRetried = false; gpsNotice(true); } });
  try {
    if (navigator.permissions && navigator.permissions.query) {
      navigator.permissions.query({ name: 'geolocation' }).then((st) => {
        st.onchange = () => { if (st.state === 'granted' && gpsDenied) { gpsNotice(false); startGps(); } };
      }).catch(() => {});
    }
  } catch (e) { /* 권한 조회가 없는 브라우저 */ }

  // ---------- 화면 갱신 ----------
  function render() {
    $('#speed').textContent = Math.round(state.speedKmh);
    if (state.heading !== null) {
      $('#headingText').textContent = dirName(state.heading) + ' · ' + Math.round(state.heading) + '°';
      rotateCompass(state.heading);
      rotateMe(state.heading - (glOn() ? glView.rot : 0));
      meEl.classList.remove('nohead');
    } else {
      $('#headingText').textContent = '방향 -';
      meEl.classList.add('nohead');
    }
    $('#tripKm').textContent = (state.trip / 1000).toFixed(1);
    $('#tripTime').textContent = fmtDur(state.driveMs);
    $('#tripAvg').textContent = state.driveMs > 60000 ? Math.round(state.trip / (state.driveMs / 1000) * 3.6) : 0;
    $('#tripMax').textContent = Math.round(state.maxKmh || 0);
    layoutView();
  }
  // 안전장치: 지도 칸이 0 크기로 접히면(빈 지도) 스스로 다시 펴고 운영 서버에 알린다
  let mapCheckTick = 0;
  function mapWatchdog() {
    if (++mapCheckTick % 5 || !mapA) return;
    const host = $('#map'), canvas = host.querySelector('.mapcanvas');
    if (!canvas || host.clientHeight < 50) return;
    if (canvas.offsetHeight < 10 || canvas.offsetWidth < 10) {
      canvas.style.position = 'absolute';
      canvas.style.inset = '0';
      canvas.style.width = ''; canvas.style.height = '';
      try { if (mapA.resize) mapA.resize(host.clientWidth, host.clientHeight); } catch (e) { /* 다음 확인 때 다시 */ }
      layoutView(true);
      report('warn', { msg: 'map container collapsed; repaired' });
    }
  }

  // ---------- 새 버전 자동 반영 ----------
  // GitHub Pages 는 페이지를 10분 동안 브라우저에 저장해 두므로, 그냥 링크로 들어오면 예전 화면이 뜰 수 있다.
  // 페이지를 열 때(그리고 차가 잠들었다 깨어났을 때) version.json 을 캐시 없이 받아 보고,
  // 지금보다 새 버전이면 한 번만 새로고침한다. 운전에 방해되지 않게 길안내 중·주행 중·데모 중에는 절대 하지 않는다.
  const upd = { checking: false, hiddenAt: 0, lastTick: 0, touchAt: 0, movedAt: Date.now(), idleAt: 0 };
  document.addEventListener('pointerdown', () => { upd.touchAt = Date.now(); }, { passive: true, capture: true });
  // 주차 중 켜 둔 화면도 새 버전으로: 2분 넘게 서 있고, 2분 넘게 아무것도 안 만졌고, 길안내·검색·설정·경로 고르기가
  // 열려 있지 않으면 10분마다 새 버전을 확인한다. 돌려주는 값은 이유 (테스트용)
  function idleUpdate(now, dry) {
    if (state.speedKmh >= 3) { upd.movedAt = now; return 'moving'; }
    if (now - upd.movedAt < 120000) return 'just-stopped';
    if (now - upd.touchAt < 120000) return 'touched';
    if (nav.active || nav.preview || nav.busy) return 'nav';
    if (['#sheet', '#searchSheet', '#tripSheet', '#routeCard', '#navTray'].some((s) => { const e = $(s); return e && !e.hidden; })) return 'screen-open';
    if (now - upd.idleAt < 10 * 60000) return 'waiting';
    upd.idleAt = now;
    if (!dry) checkForUpdate('idle');
    return 'check';
  }
  const verNum = (v) => String(v || '').split(/[^0-9]+/).filter(Boolean).map(Number);
  function verNewer(a, b) { // a 가 b 보다 새 버전인지 ('2026.11.13-15' > '2026.11.13-9')
    const x = verNum(a), y = verNum(b);
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
      const d = (x[i] || 0) - (y[i] || 0);
      if (d) return d > 0;
    }
    return false;
  }
  const busyDriving = () => nav.active || nav.busy || state.speedKmh >= 3 || !!state.demoTimer;
  // 돌려주는 값: 'reload' 새로고침함 · 'latest' 이미 최신 · 'driving' 운전 중이라 미룸 · 'tried' 이번 창에서 이미 시도함 · 'skip' · 'error'
  // opt.dry: 새로고침 없이 판단만 (테스트용), opt.latest: version.json 대신 쓸 값 (테스트용)
  // 운전·길안내 중에는 바꾸지 않고, 2분마다 새 버전이 있는지 보기만 한다(version.json 몇십 바이트).
  // 있으면 오른쪽 위(날씨 밑)에 작은 '업데이트' 버튼이 늘 보이고, 하단 띠 버튼에도 '새 버전'이 생긴다
  function renderUpdBtn() { const b = $('#updBtn'); if (b) b.hidden = !upd.newer; }
  async function peekVersion() {
    try {
      const r = await fetch('version.json?t=' + Date.now(), { cache: 'no-store' });
      if (!r.ok) return;
      const j = await r.json();
      if (j && verNewer(j.v, APP_VERSION)) { upd.newer = String(j.v); renderUpdBtn(); }
    } catch (e) { /* 오프라인 */ }
  }
  // '새 버전' 버튼: 길안내 중이면 목적지·경유지·옵션을 남겨 두고 새 버전으로. 새 버전이 뜨면 같은 목적지로 바로 이어서 안내한다
  function goUpdate() {
    const v = upd.newer;
    if (!v) return;
    try {
      if (nav.active && nav.dest) {
        const d = nav.dest;
        sessionStorage.setItem('tnc.resume', JSON.stringify({ dest: { name: d.name, addr: d.addr || '', lat: d.lat, lng: d.lng, park: d.park || null, parkOff: !!d.parkOff },
          via: nav.via || [], option: nav.option || null, t: Date.now() }));
      }
      sessionStorage.setItem('tnc.updTried', v);
    } catch (e) { /* 저장소 막힘 */ }
    report('info', { msg: 'manual update', from: APP_VERSION, to: v, nav: !!nav.active });
    saveTripNow(true); saveCurTrip();
    location.replace(updateUrl(v));
  }
  // 새 버전으로 바뀐 직후: 남겨 둔 목적지가 있으면(15분 안) 첫 위치를 받는 대로 경로 카드 없이 이어서 안내
  let resumePending = null;
  try {
    const r = JSON.parse(sessionStorage.getItem('tnc.resume') || 'null');
    sessionStorage.removeItem('tnc.resume');
    if (r && r.dest && Date.now() - r.t < 15 * 60000) resumePending = r;
  } catch (e) { /* 저장소 막힘 */ }
  function maybeResume() {
    if (!resumePending || !state.fix || nav.active || nav.busy || nav.preview) return;
    const r = resumePending;
    resumePending = null;
    nav.via = r.via || [];
    nav.autoStart = true;
    nav.resumeOpt = r.option || null;
    toast('새 버전에서 ' + r.dest.name + ' 안내를 이어 갑니다…', '', 3000);
    planRoute(r.dest, false);
  }
  const resumeFrom = (r) => { resumePending = r; maybeResume(); }; // 테스트용
  // 새 버전으로 옮겨 갈 주소: 지금 주소의 다른 값(debug 등)은 두고 v 만 새 버전으로
  function updateUrl(v, loc) {
    const l = loc || location;
    const qs = new URLSearchParams(l.search);
    qs.set('v', String(v));
    return l.pathname + '?' + qs.toString() + (l.hash || '');
  }
  async function checkForUpdate(why, opt) {
    const o = opt || {};
    if ((testPage && !o.dry) || upd.checking) return 'skip';
    if (busyDriving()) return 'driving';
    upd.checking = true;
    try {
      let v = o.latest;
      if (v === undefined) {
        const r = await fetch('version.json?t=' + Date.now(), { cache: 'no-store' });
        if (!r.ok) return 'error';
        const j = await r.json();
        v = j && j.v;
      }
      if (!verNewer(v, APP_VERSION)) return 'latest';
      let tried = null;
      try { tried = sessionStorage.getItem('tnc.updTried'); } catch (e) { /* 저장소 막힘 */ }
      if (tried === String(v)) return 'tried'; // 새로고침했는데도 그대로면(캐시 서버가 늦는 등) 되풀이하지 않는다
      if (busyDriving()) return 'driving';    // 확인하는 사이 출발했으면 그만둔다
      if (o.dry) return 'reload';
      try { sessionStorage.setItem('tnc.updTried', String(v)); } catch (e) { /* 저장소 막힘 */ }
      report('info', { msg: 'auto update', from: APP_VERSION, to: String(v), why });
      saveTripNow(true); saveCurTrip();
      // 주소에 ?v=새 버전 을 붙여 이동한다. 그냥 새로고침하면 브라우저·CDN 에 저장된 예전 index.html(최대 10분)이
      // 다시 뜰 수 있다(2026-11-14 차에서 새로고침했는데 예전 버전). 주소가 바뀌면 저장된 것을 쓰지 않는다
      location.replace(updateUrl(v));
      return 'reload';
    } catch (e) {
      return 'error'; // 오프라인 등: 지금 버전으로 계속
    } finally {
      upd.checking = false;
    }
  }

  function tickClock() {
    const now = new Date();
    // 1초마다 도는 시계가 5분 넘게 멈췄다면 차가 잠들었다 깨어난 것: 새 버전을 확인한다
    if (upd.lastTick && now - upd.lastTick > 5 * 60000) checkForUpdate('wake');
    upd.lastTick = now.getTime();
    // 자동 야간: 1분마다 해의 높이를 다시 본다
    if (!upd.nightAt || now - upd.nightAt > 60000) { upd.nightAt = now.getTime(); applyNight(); }
    // 서 있을 때는 GPS 가 드문드문 와도 북쪽 위 전환이 늦지 않게 시계로도 본다
    if (state.fix && !state.demoTimer) checkStopNorth(state.fix.t + (Date.now() - lastFixWall));
    if (!state.demoTimer && !testPage) idleUpdate(Date.now());
    if (!testPage && Date.now() - (upd.peekAt || 0) > 2 * 60000) { upd.peekAt = Date.now(); peekVersion(); }
    maybeResume();
    $('#clock').textContent = hhmm(now);
    $('#dateText').textContent = (now.getMonth() + 1) + '월 ' + now.getDate() + '일 (' + '일월화수목금토'[now.getDay()] + ')';
    mapWatchdog();
    // 달리는 중 5초 넘게 위치가 안 오면 (터널 등) 속도를 흐리게 하고 알린다.
    // 멈춰 있으면 브라우저가 위치를 잘 안 보내므로 1분까지 기다린다.
    const silentMs = Date.now() - lastFixWall;
    // 테슬라 브라우저는 위치를 조금 드문드문 줄 때가 있어 달리는 중에도 8초까지는 기다린다
    if (state.fix && !state.demoTimer && silentMs > (state.speedKmh >= 3 ? 8000 : 60000)) {
      $('#speed').classList.add('stale');
      setGps('warn', 'GPS 신호 없음');
    }
    if (nav.active) renderNav(); else checkTripCover();
    if (camState.section) renderSection();
  }

  // ---------- 따라가기 ----------
  // peek: 주행 화면에서 지도를 끌었을 때. 방향·기울기는 그대로 두고 따라가기만 멈춘다
  const REFOLLOW_MS = 5000, REFOLLOW_PARKED_MS = 15000;
  function setFollowing(on, noAutoReturn, peek) {
    state.following = on;
    state.peek = !on && !!peek;
    $('#locate').classList.toggle('alert', !on);
    clearTimeout(state.refollowTimer);
    const jumped = layoutView(); // 주행 화면 ↔ 평면 지도 전환
    if (on && state.fix && mapA && !jumped) { const p = mePos(); mapA.center(p.lat, p.lng, false); }
    renderBackMe();
    if (!on && !noAutoReturn) armRefollow();
  }
  // 손을 떼고 기다리면 내 위치로 돌아간다: 주행 중·길안내 중 5초, 서서 지도를 둘러볼 때 15초.
  // '내 위치로' 아래 막대가 줄어드는 것으로 남은 시간을 보여 준다
  function armRefollow() {
    clearTimeout(state.refollowTimer);
    const b = $('#backMe');
    b.classList.remove('count');
    if (state.following || nav.preview) return;
    const ms = (state.peek || nav.active || state.speedKmh >= 8) ? REFOLLOW_MS : REFOLLOW_PARKED_MS;
    state.refollowTimer = setTimeout(() => setFollowing(true), ms);
    b.style.setProperty('--bm-ms', ms + 'ms');
    void b.offsetWidth;
    b.classList.add('count');
  }
  function holdRefollow() { clearTimeout(state.refollowTimer); $('#backMe').classList.remove('count'); }
  function renderBackMe() { $('#backMe').hidden = state.following || nav.preview || !state.fix; }
  // 지도 라이브러리가 직접 끌기 시작(북쪽 위 평면 지도): 손가락이 닿아 있는 동안은 기다렸다가 뗄 때부터 시간을 잰다
  function onUserPan() { setFollowing(false, nav.preview || gesture.pointers.size > 0, !!(view.drive && glOn())); }
  // 지도 손 조작: 톡 치기는 화면 버튼만 보여 준다.
  // 진행 방향 위 주행 화면에서 10px 넘게 끌면 방향·기울기는 그대로 둔 채 지도만 손가락을 따라 옮긴다(앞길 보기).
  // 두 손가락·휠은 가운데(내 차)를 그대로 두고 한 단계씩 확대/축소. 북쪽 위 평면 지도는 지도 라이브러리가 직접 처리한다.
  const gesture = { x: 0, y: 0, lx: 0, ly: 0, used: false, panning: false, pinch: 0, wheelAt: 0, pointers: new Map() };
  const NOT_MAP = '.btn, .searchbtn, .navpanel, .routecard, .toast, #diagBox, .ctrls, .topctrls, .badge, .soundpill, .navtray, .updbtn, .backme';
  function userMapGesture() {
    gesture.used = true;
    // 손으로 바꾼 배율은 30초 동안 자동 줌이 덮어쓰지 않게 한다
    zoomCtl.manualUntil = (state.fix ? state.fix.t : Date.now()) + 30000;
  }
  // 화면 좌표 → 돌리고 기울인 지도 캔버스 안의 좌표. CSS 변환을 거꾸로 풀어 손가락 아래 지점이 손가락을 그대로 따라오게 한다
  function canvasPoint(sx, sy) {
    const canvas = $('#map .mapcanvas');
    if (!canvas) return null;
    const cs = getComputedStyle(canvas);
    const m = cs.transform && cs.transform !== 'none' ? new DOMMatrix(cs.transform) : new DOMMatrix();
    const o = cs.transformOrigin.split(' ').map(parseFloat);
    const host = $('#map').getBoundingClientRect();
    const ux = sx - host.left - canvas.offsetLeft - o[0], uy = sy - host.top - canvas.offsetTop - o[1];
    const a = m.m11 - ux * m.m14, b = m.m21 - ux * m.m24, c = m.m12 - uy * m.m14, d = m.m22 - uy * m.m24;
    const e = ux * m.m44 - m.m41, f = uy * m.m44 - m.m42, det = a * d - b * c;
    if (Math.abs(det) < 1e-9) return null;
    return { x: (e * d - b * f) / det + o[0], y: (a * f - e * c) / det + o[1] };
  }
  const pinchDist = () => { const [p, q] = [...gesture.pointers.values()]; return Math.hypot(p.x - q.x, p.y - q.y); };
  function onMapDown(e) {
    if (e.target.closest && e.target.closest(NOT_MAP)) return;
    gesture.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    holdRefollow(); // 손가락이 닿아 있는 동안은 돌아가지 않는다
    if (gesture.pointers.size === 1) {
      gesture.x = gesture.lx = e.clientX; gesture.y = gesture.ly = e.clientY;
      gesture.used = false; gesture.panning = false;
    } else if (gesture.pointers.size === 2) { gesture.pinch = pinchDist(); userMapGesture(); }
  }
  function onMapMove(e) {
    const p = gesture.pointers.get(e.pointerId);
    if (!p) return;
    p.x = e.clientX; p.y = e.clientY;
    if (gesture.pointers.size >= 2) {
      // 주행 화면(래스터): 두 손가락 간격이 1.35배 벌어지거나 줄면 한 단계씩 (GL 지도는 지도 라이브러리가 직접)
      if (view.drive && !glOn() && gesture.pinch && mapA) {
        const d = pinchDist(), r = d / gesture.pinch;
        if (r > 1.35 || r < 0.74) { mapA.zoomBy(r > 1 ? 1 : -1); gesture.pinch = d; }
      }
      return;
    }
    if (!gesture.used && Math.hypot(e.clientX - gesture.x, e.clientY - gesture.y) > 10) {
      userMapGesture();
      if (view.drive && !glOn()) {
        gesture.panning = true;
        if (mapA && mapA.stop) mapA.stop(); // '내 위치로' 돌아가는 중이었으면 멈추고 손가락을 따른다
        if (!state.peek) setFollowing(false, true, true); // 주행 화면 그대로 앞길 보기 시작
      }
    }
    if (!gesture.panning || !view.drive || !mapA || !mapA.panPx) return;
    const a = canvasPoint(gesture.lx, gesture.ly), b = canvasPoint(e.clientX, e.clientY);
    if (a && b) mapA.panPx(a.x - b.x, a.y - b.y);
    gesture.lx = e.clientX; gesture.ly = e.clientY;
  }
  function onMapUp(e) {
    if (!gesture.pointers.delete(e.pointerId)) return;
    if (gesture.pointers.size < 2) gesture.pinch = 0;
    // 두 손가락 중 하나만 떼면 남은 손가락 자리부터 이어서 끈다
    if (gesture.pointers.size === 1) { const q = [...gesture.pointers.values()][0]; gesture.lx = q.x; gesture.ly = q.y; }
    if (!gesture.pointers.size && !state.following) armRefollow();
  }
  function onMapWheel(e) {
    if (e.target.closest && e.target.closest(NOT_MAP)) return;
    userMapGesture();
    if (!view.drive || glOn() || !mapA || !e.deltaY) return;
    const now = Date.now();
    if (now - gesture.wheelAt > 250) { gesture.wheelAt = now; mapA.zoomBy(e.deltaY < 0 ? 1 : -1); }
  }

  // ---------- 화면 버튼 자동 숨김: 화면을 한 번 터치하면 3초 동안 보인다 ----------
  const CHROME_MS = 3000;
  let chromeTimer = 0;
  function showChrome() {
    $('#map').classList.remove('chrome-hidden');
    clearTimeout(chromeTimer);
    chromeTimer = setTimeout(hideChrome, CHROME_MS);
  }
  function hideChrome() {
    // 지도를 손으로 보고 있거나(따라가기 꺼짐) 경로 미리보기·설정·검색 창이 열려 있으면 기다린다
    if (!state.following || nav.preview || !$('#sheet').hidden || !$('#searchSheet').hidden) {
      chromeTimer = setTimeout(hideChrome, CHROME_MS);
      return;
    }
    $('#map').classList.add('chrome-hidden');
  }
  document.addEventListener('pointerdown', showChrome, { capture: true, passive: true });

  // 지도 방향: 진행 방향이 위(주행 화면) ↔ 북쪽 고정. 지도 오른쪽 버튼으로 바로 바꾼다.
  const ICON_HUP = '<svg viewBox="0 0 24 24"><path d="M12 3.5 18 19l-6-3.4L6 19z" fill="currentColor" stroke="none"/></svg>';
  const ICON_NUP = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M9.2 15.5v-7l5.6 7v-7"/></svg>';
  function renderHupBtn() {
    const b = $('#hupBtn');
    b.innerHTML = prefs.headingUp ? ICON_HUP : ICON_NUP;
    b.classList.toggle('on', prefs.headingUp);
    b.setAttribute('aria-label', prefs.headingUp ? '진행 방향 위로 (누르면 북쪽 고정)' : '북쪽 고정 (누르면 진행 방향 위로)');
    const opt = $('#optHup');
    if (opt) { opt.checked = prefs.headingUp; $('#optTilt').disabled = !prefs.headingUp; }
  }
  function setHeadingUp(on) {
    prefs.headingUp = on;
    store.set('hup', on ? null : '0');
    renderHupBtn();
    setFollowing(true);
    layoutView();
    toast(on ? '진행 방향이 위로 보이게 바꿨습니다' : '지도를 북쪽 위로 고정했습니다', '', 2000);
  }
  $('#hupBtn').onclick = () => setHeadingUp(!prefs.headingUp);
  $('#map').addEventListener('pointerdown', onMapDown, true);
  $('#map').addEventListener('pointermove', onMapMove, { capture: true, passive: true });
  window.addEventListener('pointerup', onMapUp, true);
  window.addEventListener('pointercancel', onMapUp, true);
  $('#map').addEventListener('wheel', onMapWheel, { capture: true, passive: true });
  window.addEventListener('resize', queueLayout);
  window.addEventListener('orientationchange', queueLayout);
  if (window.ResizeObserver) new ResizeObserver(queueLayout).observe($('#map'));

  // ---------- 진단 (실차 GPS / 화면 반응 측정) ----------
  const diag = { on: false, last: null, intervals: [], delays: [], accs: [], procs: [], paints: [], spdNull: 0, hdgNull: 0, n: 0, log: [] };
  // 첫 로딩 때 튀는 값에 흔들리지 않게 중앙값을 쓴다
  const avg = (a) => {
    if (!a.length) return NaN;
    const s = a.slice().sort((x, y) => x - y), m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };
  const push = (a, v, max) => { a.push(v); if (a.length > (max || 60)) a.shift(); };
  function diagRaw(p) {
    // 브라우저가 주는 원본 위치값 기준으로 측정 (데모 중에도 계속 잰다)
    const now = Date.now();
    diag.n++;
    if (diag.last) push(diag.intervals, p.timestamp - diag.last);
    diag.last = p.timestamp;
    push(diag.delays, now - p.timestamp);
    push(diag.accs, p.coords.accuracy);
    if (p.coords.speed == null || Number.isNaN(p.coords.speed)) diag.spdNull++;
    if (p.coords.heading == null || Number.isNaN(p.coords.heading)) diag.hdgNull++;
    if (diag.on) {
      diag.log.push([now, p.timestamp, +p.coords.latitude.toFixed(6), +p.coords.longitude.toFixed(6),
        Math.round(p.coords.accuracy), p.coords.speed == null ? null : +p.coords.speed.toFixed(2),
        p.coords.heading == null ? null : Math.round(p.coords.heading)]);
      if (diag.log.length > 20000) diag.log.shift();
    }
  }
  function diagAfterFix(f, t0) {
    const proc = performance.now() - t0;
    push(diag.procs, proc);
    // 위치를 받은 뒤 실제로 화면에 그려지기까지 (다음 프레임 2번) 걸린 시간
    requestAnimationFrame(() => requestAnimationFrame(() => {
      push(diag.paints, performance.now() - t0);
      if (diag.on) renderDiag();
    }));
    if (diag.on && diag.log.length && !state.demoTimer) { // 데모 값이 실제 GPS 기록에 섞이지 않게
      const last = diag.log[diag.log.length - 1];
      if (last.length === 7) last.push(Math.round(state.speedKmh), Math.round(proc), state.demoTimer ? 1 : 0);
    }
  }
  function renderDiag() {
    const box = $('#diagBox');
    if (!box) return;
    const iv = avg(diag.intervals), hz = iv > 0 ? 1000 / iv : NaN;
    const n = Math.max(1, diag.n);
    box.innerHTML =
      '<b>진단</b> GPS ' + (Number.isFinite(hz) ? hz.toFixed(2) + 'Hz' : '-') +
      ' (간격 ' + (Number.isFinite(iv) ? Math.round(iv) + 'ms' : '-') + ')' +
      ' · 위치 지연 ' + (diag.delays.length ? Math.round(avg(diag.delays)) + 'ms' : '-') +
      ' · 정확도 ±' + (diag.accs.length ? Math.round(avg(diag.accs)) + 'm' : '-') +
      '<br>속도값 ' + (diag.n ? (100 - Math.round(diag.spdNull / n * 100)) + '% 제공' : '-') +
      ' · 방향값 ' + (diag.n ? (100 - Math.round(diag.hdgNull / n * 100)) + '% 제공' : '-') +
      ' · 처리 ' + (diag.procs.length ? avg(diag.procs).toFixed(1) + 'ms' : '-') +
      ' · 화면 반영 ' + (diag.paints.length ? Math.round(avg(diag.paints)) + 'ms' : '-') +
      ' · 기록 ' + diag.log.length + '개';
  }
  function setDiag(on) {
    diag.on = on;
    store.set('diag', on ? '1' : null);
    let box = $('#diagBox');
    if (on && !box) {
      box = document.createElement('div');
      box.id = 'diagBox';
      box.className = 'diagbox';
      $('#map').appendChild(box);
    }
    if (box) box.hidden = !on;
    if (on) renderDiag();
    $('#diagToggle').textContent = on ? '진단 모드 끄기' : '진단 모드 켜기';
  }
  async function uploadDiag() {
    if (!diag.log.length) { toast('아직 기록이 없습니다. 진단 모드를 켜고 주행해 주세요.', 'bad', 5000); return; }
    toast('기록 올리는 중…', '', 0);
    try {
      const j = await api('/log', null, {
        ua: navigator.userAgent, screen: [screen.width, screen.height, devicePixelRatio],
        viewport: [innerWidth, innerHeight], map: mapA === NaverAdapter ? 'naver' : 'osm',
        fields: ['now', 'gpsTime', 'lat', 'lng', 'acc', 'speed', 'heading', 'shownKmh', 'procMs', 'demo'],
        rows: diag.log,
      }, 90000); // 차량 LTE 로 1MB 넘게 올릴 수 있으니 넉넉히 기다린다
      toast('기록을 올렸습니다. 기록 번호: ' + j.id + ' (이 번호를 알려 주세요)', '', 0);
    } catch (e) {
      toast('기록을 올리지 못했습니다: ' + e.message, 'bad', 8000);
    }
  }

  // ---------- 데모 주행 (차 없이 화면 확인용) ----------
  const DEMO_ROUTE = [
    { lat: 37.5658, lng: 126.9772 }, // 서울시청
    { lat: 37.5712, lng: 126.9769 }, // 세종로 사거리
    { lat: 37.5757, lng: 126.9768 }, // 광화문 앞
    { lat: 37.5762, lng: 126.9806 }, // 동십자각
    { lat: 37.5765, lng: 126.9856 }, // 안국역
    { lat: 37.5706, lng: 126.9880 }, // 종로2가
    { lat: 37.5700, lng: 126.9830 }, // 종각
    { lat: 37.5693, lng: 126.9790 }, // 청계광장
  ];

  // 데모는 경유지를 직선으로 잇지 않고 네이버 길찾기의 실제 도로 경로를 따라 달린다. 한 번 받아 두고 다시 쓴다.
  const llStr = (p) => p.lng.toFixed(6) + ',' + p.lat.toFixed(6);
  let demoRoad = null;
  async function demoRoadPath() {
    if (demoRoad) return demoRoad;
    try {
      const cached = JSON.parse(store.get('demoRoad') || 'null');
      if (cached && cached.v === 1 && cached.pts && cached.pts.length > 10) { demoRoad = cached; return demoRoad; }
    } catch (e) { /* 캐시 없음 */ }
    const W = DEMO_ROUTE;
    const r = await api('/route', {
      start: llStr(W[0]), goal: llStr(W[7]), option: 'trafast',
      waypoints: [W[2], W[4], W[5]].map(llStr).join('|'),
    });
    demoRoad = { v: 1, pts: r.path.map((p) => ({ lat: p[1], lng: p[0] })), turns: (r.guide || []).map((g) => g.i) };
    store.set('demoRoad', JSON.stringify(demoRoad));
    return demoRoad;
  }

  let demoSaved = null, demoGen = 0;
  async function startDemo() {
    stopDemo(true);
    $('#gpsNotice').hidden = true;   // 위치 권한이 꺼져 있어도 데모는 볼 수 있게
    const gen = ++demoGen;
    if (nav.preview) { startNav(); nav.byDemo = true; } // 데모가 시작한 안내는 데모가 끝나면 함께 끝낸다
    const onRoute = !!(nav.active && nav.pts);
    let path, stops, turns;
    if (onRoute) {
      path = nav.pts.slice();
      stops = new Set();
      turns = new Set(nav.guides.map((g) => g.i)); // 회전 지점 감속
    } else {
      let road = null;
      try { toast('데모 경로(실제 도로)를 불러오는 중…', '', 3000); road = await demoRoadPath(); } catch (e) { road = null; }
      if (gen !== demoGen) return; // 불러오는 사이에 멈추거나 다시 시작함
      if (road) {
        path = road.pts;
        turns = new Set(road.turns);
        stops = new Set(road.turns.filter((_, k) => k % 3 === 1)); // 몇몇 교차로에서 신호 대기
      } else {
        path = DEMO_ROUTE.concat([DEMO_ROUTE[0]]); // 서버에 못 닿으면 예전 방식
        turns = new Set();
        stops = new Set([2, 4, 6]);
      }
    }
    const cruise = onRoute ? 17 : 15;                                   // m/s
    demoSaved = { trip: state.trip, driveMs: state.driveMs, odo: state.odo, maxKmh: state.maxKmh }; // 실제 주행 기록은 보관
    state.fix = null; state.trip = 0; state.driveMs = 0; state.heading = null; state.maxKmh = 0;
    let seg = 0, along = 0, v = 0, stopLeft = 0, last = Date.now();

    const lookahead = (set) => {
      if (!set.size) return Infinity;
      let dist = haversine(path[seg], path[seg + 1]) - along;
      for (let j = seg + 1; j < path.length && dist < 400; j++) {
        if (set.has(j)) return dist;
        if (j + 1 < path.length) dist += haversine(path[j], path[j + 1]);
      }
      return Infinity;
    };

    const tick = () => {
      const now = Date.now();
      const dt = Math.min(2, (now - last) / 1000);
      last = now;
      if (seg >= path.length - 1) {
        if (onRoute) { stopDemo(false); return; }
        seg = 0; along = 0;
      }
      if (stopLeft > 0) {
        stopLeft -= dt; v = 0;
      } else {
        const dStop = lookahead(stops), dTurn = lookahead(turns);
        let target = cruise;
        if (dStop < v * v / (2 * 2.5) + 14) target = 0;
        else if (dTurn < 50) target = 7;
        v = target > v ? Math.min(target, v + 2.0 * dt) : Math.max(target, v - 2.8 * dt);
        if (target === 0 && v < 1.2) v = 1.2; // 정지선까지 서행
        along += v * dt;
        while (seg < path.length - 1) {
          const len = haversine(path[seg], path[seg + 1]);
          if (along < len) break;
          along -= len; seg++;
          if (stops.has(seg)) { along = 0; v = 0; stopLeft = 5; break; }
        }
      }
      const a = path[Math.min(seg, path.length - 1)], b = path[Math.min(seg + 1, path.length - 1)];
      const len = haversine(a, b);
      const r = len > 0 ? Math.min(1, along / len) : 0;
      onFix({
        lat: a.lat + (b.lat - a.lat) * r, lng: a.lng + (b.lng - a.lng) * r,
        acc: 5, speed: v, heading: len > 0.5 ? bearing(a, b) : null, t: now,
      });
    };

    tick();
    state.demoTimer = setInterval(tick, 1000);
    $('#app').classList.add('demo');
    toast(onRoute ? '경로를 따라 데모 주행합니다.' : '데모 주행 중 · 설정에서 멈출 수 있어요', '', 3000);
  }

  function stopDemo(silent) {
    demoGen++; // 경로를 불러오는 중인 데모도 취소
    if (!state.demoTimer) return;
    clearInterval(state.demoTimer);
    state.demoTimer = 0;
    state.fix = null; state.speedKmh = 0; state.heading = null;
    camState.target = null; camState.section = null; camState.passed.clear(); camState.saidById.clear();
    if (demoSaved) {
      state.trip = demoSaved.trip; state.driveMs = demoSaved.driveMs; state.odo = demoSaved.odo; state.maxKmh = demoSaved.maxKmh;
      demoSaved = null;
    }
    if (nav.byDemo) endNav();
    render(); renderCam();
    $('#app').classList.remove('demo');
    setGps('warn', 'GPS 신호 찾는 중');
    if (!silent) toast('데모를 멈췄습니다.', '', 2500);
  }

  // ---------- 키보드 모의 주행 (PC 시험용: 주소에 ?sim 이 있을 때만. 차 주소에는 없으므로 차에는 나오지 않는다) ----------
  // 2026-11-15 요청 '내가 직접 wasd 키로 운전하면서 해 보고 싶다. w 누르면 속도가 점점 올라가고 s 누르면 브레이크, w 떼면 점점 줄어듦',
  // 이어서 '모의 주행할 때 도로 벗어나면 안 돼'. 그래서 차는 늘 '길(궤도)' 위로만 간다:
  //  - 길안내 중이면 안내 경로를 따라간다 (W/S 는 속도만)
  //  - 아니면 지금 방향으로 1.2km 앞까지 네이버 길찾기 경로를 받아 그 길을 따라가고, 거의 다 가면 다음 앞길을 또 받는다.
  //    A/D 를 누르면 그쪽(±80°, 250m)으로 가는 길을 받아 다음 갈림길에서 그쪽으로 꺾는다. 길을 받는 동안은 그 자리에 선다
  // W/↑ 가속(빠를수록 천천히 붙음) · S/↓ 브레이크 · 아무것도 안 누르면 서서히 줄어듦 · Space 급정거 · Esc 끝.
  // 키는 자판 위치(e.code)로 읽어 한글 입력 상태에서도 된다. 위치는 실제 GPS 처럼 1초에 한 번 onFix 로 넣는다(길안내·단속·재탐색이 그대로 반응).
  // 데모와 같은 표시(state.demoTimer)를 써서 실제 GPS 는 무시하고, 주행 기록은 보관했다가 끝나면 되돌린다
  const sim = { on: false, lat: 0, lng: 0, h: 0, v: 0, keys: new Set(), last: 0, loop: 0, timer: 0, track: null, s: 0, fetching: false, gen: 0, failAt: 0, note: '', turnFrom: null, straightAt: 0, leftRoute: null, dragging: false };
  const SIM_CAR = { name: 'RS7', grip: 8.6, P: 394000, m: 2075, k: 0.000291, c: 0.15, vmax: 84.75 };
  const SIM_KEYS = { KeyW: 'up', ArrowUp: 'up', KeyS: 'down', ArrowDown: 'down', KeyA: 'left', ArrowLeft: 'left', KeyD: 'right', ArrowRight: 'right', Space: 'stop' };
  function simTrack(pts, src) {
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + haversine(pts[i - 1], pts[i]));
    return { pts, cum, total: cum[cum.length - 1], src };
  }
  function simLocate(tr, p) {   // p 에 가장 가까운 궤도 위 거리
    let best = { d: Infinity, s: 0 };
    for (let i = 0; i < tr.pts.length - 1; i++) {
      const q = projectSeg(p, tr.pts[i], tr.pts[i + 1]);
      if (q.dist < best.d) best = { d: q.dist, s: tr.cum[i] + q.t * (tr.cum[i + 1] - tr.cum[i]) };
    }
    return best.s;
  }
  function simPointAt(tr, s) {
    s = Math.max(0, Math.min(tr.total, s));
    let i = 1;
    while (i < tr.cum.length - 1 && tr.cum[i] < s) i++;
    const a = tr.pts[i - 1], b = tr.pts[i], seg = tr.cum[i] - tr.cum[i - 1], t = seg > 0 ? (s - tr.cum[i - 1]) / seg : 0;
    return { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t };
  }
  // 궤도의 s0~s1 구간 점들
  function simSlice(tr, s0, s1) {
    const out = [simPointAt(tr, s0)];
    for (let i = 0; i < tr.pts.length; i++) if (tr.cum[i] > s0 && tr.cum[i] < s1) out.push(tr.pts[i]);
    out.push(simPointAt(tr, s1));
    return out;
  }
  // 앞길 받기: 지금 궤도에서 lead 미터 앞(지금 달리는 길 위)에서 출발해 방향 dir 로 dist 앞 지점까지 가는 네이버 길찾기 경로를 받아
  // 지금 자리~그 출발점 구간 뒤에 이어 붙인다. 지금 자리에서 바로 물으면 출발점이 옆 큰길에 붙어 차가 그쪽으로 튀었다
  // 받은 길이 처음 200m 안에서 거꾸로(135° 넘게) 도는지 (유턴)
  function simUturn(pts, dir) {
    let d = 0;
    for (let i = 1; i < pts.length && d < 200; i++) {
      const seg = haversine(pts[i - 1], pts[i]);
      if (seg > 3 && angleDiff(bearing(pts[i - 1], pts[i]), dir) > 135) return true;
      d += seg;
    }
    return false;
  }
  function simFetchRoad(dir, dist, why, lead, retry) {
    if (sim.fetching || !sim.on) return;
    sim.fetching = true; sim.note = why || '앞길을 받는 중…'; renderSimHud();
    const tr0 = sim.track && sim.track.src === 'road' ? sim.track : null;
    const startS = tr0 ? Math.min(tr0.total, sim.s + (lead || 0)) : 0;
    // 출발점은 가는 방향 오른쪽으로 6m: 우측 통행이라 중앙분리대 있는 길에서 반대편 차로에 붙지 않게
    const base = tr0 ? simPointAt(tr0, startS) : { lat: sim.lat, lng: sim.lng };
    const from = aheadPt(base, (dir + 90) % 360, 6), to = aheadPt(base, dir, dist);
    const gen = ++sim.gen;
    api('/route', { start: from.lng.toFixed(6) + ',' + from.lat.toFixed(6), goal: to.lng.toFixed(6) + ',' + to.lat.toFixed(6), options: 'traoptimal' }, null, 12000)
      .then((j) => {
        const r = (j.alternatives || [])[0];
        if (!r || gen !== sim.gen || !sim.on || (nav.active && nav.pts && nav.pts !== sim.leftRoute)) return;
        const got = r.path.map((q) => ({ lat: q[1], lng: q[0] }));
        if (got.length < 2) throw new Error('짧은 길');
        // 곧게 갈 앞길이 처음부터 유턴이면 더 먼 곳(3배)으로 한 번 더 묻는다 (짧은 골목 끝에서 돌아 나오는 길을 피하려고)
        if (!retry && simUturn(got, why ? sim.h : dir)) { sim.fetching = false; simFetchRoad(dir, dist * (why ? 2 : 3), why, lead, true); return; }
        if (tr0 && sim.track === tr0 && sim.s <= startS) {
          sim.track = simTrack(simSlice(tr0, sim.s, startS).concat(got), 'road'); sim.s = 0;   // 이어 붙이기 (차는 제자리에서 그대로)
        } else {
          sim.track = simTrack(got, 'road'); sim.s = simLocate(sim.track, { lat: sim.lat, lng: sim.lng });
        }
        sim.note = '';
      })
      .catch(() => { if (gen === sim.gen) { sim.failAt = Date.now(); sim.note = '길을 못 받았어요 · 잠시 뒤 다시'; } })
      .finally(() => { if (gen === sim.gen) sim.fetching = false; renderSimHud(); });
  }
  function simFix() {
    onFix({ lat: sim.lat, lng: sim.lng, acc: 5, speed: sim.v, heading: sim.h, t: Date.now() });
  }
  function simPhysics() {
    if (state.demoTimer !== sim.timer) { simStop(true); return; }   // 설정의 데모 버튼 등으로 멈춘 경우
    const now = performance.now(), dt = Math.min(1, (now - sim.last) / 1000);   // 창이 가려져 타이머가 느려져도 시간은 그대로 흐르게
    sim.last = now;
    if (sim.dragging) return;   // 차를 끄는 동안은 그 자리에
    const k = sim.keys;
    // 궤도 고르기: 길안내 중이면 안내 경로, 아니면 받은 앞길
    // 차를 끌어다 경로 밖에 놓았으면 그 경로는 따르지 않는다 (길을 따라 달리다 재탐색으로 새 경로가 오면 그 경로로)
    const navPts = nav.active && nav.pts && nav.pts.length > 1 && nav.pts !== sim.leftRoute ? nav.pts : null;
    if (navPts && (!sim.track || sim.track.pts !== navPts)) {
      sim.track = simTrack(navPts, 'nav'); sim.s = simLocate(sim.track, { lat: sim.lat, lng: sim.lng }); sim.note = '';
    } else if (!navPts && sim.track && sim.track.src === 'nav') sim.track = null;   // 안내가 끝나면 앞길을 새로 받는다
    const tr = sim.track;
    if (!navPts && !sim.fetching && Date.now() - sim.failAt > 3000 && (!tr || tr.total - sim.s < 150)) {
      const endDir = tr ? bearing(simPointAt(tr, tr.total - 15), simPointAt(tr, tr.total)) : sim.h;
      simFetchRoad(endDir, 1200, null, tr ? tr.total - sim.s : 0);
    }
    // 아우디 RS7 기준 (2026-11-15 요청): 처음엔 타이어 접지 한계(8.6m/s²), 그 뒤엔 바퀴 출력(630마력의 약 85%)으로, 공기 저항이
    // 출력과 맞먹는 305km/h 에서 멈춘다 → 0→100km/h 3.4초, 0→200km/h 약 11초, 최고 305km/h. 떼면 엔진 브레이크 + 공기 저항
    let a;
    if (k.has('stop')) a = -10;
    else if (k.has('down')) a = -8;
    else if (k.has('up')) a = Math.min(SIM_CAR.grip, SIM_CAR.P / (SIM_CAR.m * Math.max(sim.v, 1))) - SIM_CAR.k * sim.v * sim.v - SIM_CAR.c;
    else a = -(0.6 + SIM_CAR.k * sim.v * sim.v);
    sim.v = Math.max(0, Math.min(SIM_CAR.vmax, sim.v + a * dt));
    if (!tr || sim.s >= tr.total - 0.5) {
      sim.v = 0;    // 길이 없거나 길 끝: 그 자리에 선다 (길 밖으로 나가지 않게)
      if (tr && tr.src === 'nav') sim.note = '경로 끝';
    } else {
      sim.s = Math.min(tr.total, sim.s + sim.v * dt);
      const p = simPointAt(tr, sim.s), ahead = simPointAt(tr, sim.s + 8);
      sim.lat = p.lat; sim.lng = p.lng;
      if (haversine(p, ahead) > 1) sim.h = bearing(p, ahead);
      // A/D 로 꺾은 뒤: 다 꺾었으면(55° 넘게 돌았으면) 30m 더 가서 그 길로 곧게 앞길을 새로 받는다
      // (옆 250m 지점까지 가는 길을 끝까지 따르면 일방통행 많은 곳에서 블록을 빙 돌았다)
      if (sim.turnFrom != null && angleDiff(sim.h, sim.turnFrom) > 55) { sim.turnFrom = null; sim.straightAt = sim.s + 30; }
      if (sim.straightAt && sim.s >= sim.straightAt && !sim.fetching) { sim.straightAt = 0; simFetchRoad(sim.h, 1200, null, 20); }
    }
    renderSimHud();
  }
  function simTurn(side) {   // A/D: 다음 갈림길에서 그쪽으로 (길안내 중에는 경로를 따라가므로 쓰지 않는다)
    if (!sim.on) return;
    if (nav.active && nav.pts && nav.pts !== sim.leftRoute) { sim.note = '길안내 중에는 경로를 따라가요'; renderSimHud(); return; }
    sim.gen++; sim.fetching = false;   // 받고 있던 앞길은 버린다
    sim.turnFrom = sim.h; sim.straightAt = 0;
    simFetchRoad((sim.h + side * 70 + 360) % 360, 400, side < 0 ? '왼쪽 길을 찾는 중…' : '오른쪽 길을 찾는 중…', 15);
  }
  function simStart() {
    if (sim.on) return;
    if (state.demoTimer) stopDemo(true);
    const c = state.fix || (mapA && mapA.getCenter && mapA.getCenter()) || { lat: 37.5663, lng: 126.9779 };
    sim.lat = c.lat; sim.lng = c.lng; sim.h = state.heading != null ? state.heading : 0; sim.v = 0;
    sim.track = null; sim.s = 0; sim.fetching = false; sim.failAt = 0; sim.note = ''; sim.turnFrom = null; sim.straightAt = 0; sim.leftRoute = null;
    demoSaved = { trip: state.trip, driveMs: state.driveMs, odo: state.odo, maxKmh: state.maxKmh };
    state.trip = 0; state.driveMs = 0; state.maxKmh = 0;
    $('#gpsNotice').hidden = true;
    sim.on = true; sim.last = performance.now();
    sim.timer = state.demoTimer = setInterval(simFix, 1000);
    sim.loop = setInterval(simPhysics, 50);
    $('#app').classList.add('demo');
    simFix();
    setFollowing(true);
    renderSimHud();
  }
  function simStop(silent) {
    if (!sim.on) return;
    sim.on = false; sim.keys.clear(); sim.v = 0; sim.gen++; sim.track = null; sim.fetching = false;
    clearInterval(sim.loop);
    if (state.demoTimer === sim.timer) stopDemo(true);
    sim.timer = 0;
    renderSimHud();
    if (!silent) toast('모의 주행을 끝냈어요. 다시 W 를 누르면 지도 가운데에서 시작해요.', '', 3000);
  }
  function renderSimHud() {
    const el = $('#simHud');
    if (!el) return;
    const mode = !sim.on ? '' : sim.note ? sim.note : sim.track && sim.track.src === 'nav' ? '안내 경로를 따라감' : '도로를 따라감';
    const help = (nav.active ? 'W 가속 · S 브레이크 · Space 급정거' : 'W 가속 · S 브레이크 · A/D 다음 갈림길에서 꺾기 · Space 급정거') + ' · 차를 끌어 옮기기 · Esc 끝';
    el.innerHTML = sim.on
      ? '<b>모의 주행 · ' + SIM_CAR.name + '</b> <span class="sv">' + Math.round(sim.v * 3.6) + '</span> km/h · ' + dirName(sim.h) + ' ' + Math.round(sim.h) + '° · ' + esc(mode) +
        '<small>' + help + '</small>'
      : '<b>모의 주행</b> W 를 누르면 지도 가운데에서 가까운 도로로 출발<small>' + help + '</small>';
  }
  if (params.has('sim')) {
    const hud = document.createElement('div');
    hud.id = 'simHud'; hud.className = 'simhud';
    $('#app').appendChild(hud);
    renderSimHud();
    const typing = (e) => /^(INPUT|TEXTAREA|SELECT)$/.test((e.target && e.target.tagName) || '') || (e.target && e.target.isContentEditable);
    window.addEventListener('keydown', (e) => {
      if (typing(e)) return;
      if (e.code === 'Escape' && sim.on) { simStop(false); return; }
      const k = SIM_KEYS[e.code];
      if (!k) return;
      e.preventDefault();
      if (!sim.on && k === 'up') simStart();
      if (!sim.on) return;
      if ((k === 'left' || k === 'right') && !e.repeat) simTurn(k === 'left' ? -1 : 1);
      sim.keys.add(k);
    });
    window.addEventListener('keyup', (e) => { const k = SIM_KEYS[e.code]; if (k) sim.keys.delete(k); });
    window.addEventListener('blur', () => sim.keys.clear());   // 창을 벗어나면 누른 키가 남지 않게
    // 차 끌어 옮기기: 내 차 아이콘 위(반지름 36px)에서 누르면 지도를 끌지 않고 차를 끈다. 놓은 자리 = 새 GPS 위치(가까운 도로로 이어 달림).
    // 길안내 중 경로 밖에 놓으면 그 길을 따라 달리고, 앱이 경로 이탈로 재탐색한다
    let ghost = null;
    const onCar = (e) => { const r = meEl.getBoundingClientRect(); return r.width && Math.hypot(e.clientX - (r.left + r.width / 2), e.clientY - (r.top + r.height / 2)) < 36; };
    $('#map').addEventListener('pointerdown', (e) => {
      if (!sim.on || e.button !== 0 || !onCar(e)) return;
      e.stopPropagation(); e.preventDefault();
      sim.dragging = true;
      ghost = document.createElement('div'); ghost.className = 'simghost';
      ghost.style.left = e.clientX + 'px'; ghost.style.top = e.clientY + 'px';
      document.body.appendChild(ghost);
    }, true);
    $('#map').addEventListener('mousedown', (e) => { if (sim.dragging) { e.stopPropagation(); e.preventDefault(); } }, true);
    window.addEventListener('pointermove', (e) => { if (ghost) { ghost.style.left = e.clientX + 'px'; ghost.style.top = e.clientY + 'px'; } });
    window.addEventListener('pointerup', (e) => {
      if (!sim.dragging) return;
      sim.dragging = false;
      if (ghost) { ghost.remove(); ghost = null; }
      const cp = canvasPoint(e.clientX, e.clientY);
      if (!cp || !mapA || !mapA.coordAt) return;
      let p = null;
      try { p = mapA.coordAt(cp.x, cp.y); } catch (err) { p = null; }
      if (p && Number.isFinite(p.lat) && Number.isFinite(p.lng)) simTeleport(p);
    });
  }
  function simTeleport(p) {
    sim.lat = p.lat; sim.lng = p.lng; sim.v = 0;
    sim.gen++; sim.fetching = false; sim.track = null; sim.s = 0; sim.turnFrom = null; sim.straightAt = 0; sim.failAt = 0;
    if (nav.active && nav.pts) sim.leftRoute = nav.pts;   // 놓은 자리에서는 원래 경로를 따르지 않는다
    sim.note = '옮겼어요 · W 로 출발';
    simFix();
    setFollowing(true);
    renderSimHud();
  }

  // ---------- 버튼 ----------
  $('#zin').onclick = () => manualZoom(1);
  $('#zout').onclick = () => manualZoom(-1);
  $('#locate').onclick = () => setFollowing(true);
  $('#backMe').onclick = () => setFollowing(true);
  $('#searchBtn').onclick = () => openSearch('dest');
  $('#searchClose').onclick = closeSearch;
  $('#searchSheet').addEventListener('click', (e) => { if (e.target === $('#searchSheet')) closeSearch(); });
  $('#qBtn').onclick = doSearch;
  $('#q').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) { clearTimeout(qTimer); doSearch(); } });
  $('#q').addEventListener('input', onQueryInput);
  $('#rcStart').onclick = () => (nav.comparing ? endCompare(true) : startNav());
  $('#rcCancel').onclick = () => (nav.comparing ? endCompare(false) : endNav());
  // 경로 카드: 주차장 입구 ↔ 정문(원래 목적지 자리) 바꿔서 다시 찾기
  $('#rcParkBtn').onclick = () => {
    if (!nav.dest || !nav.dest.park || nav.busy) return;
    nav.dest.parkOff = !nav.dest.parkOff;
    planRoute(nav.dest, false);
  };
  // 하단 위치 띠를 누르면 버튼이 올라온다
  $('#roadName').addEventListener('click', toggleTray);
  $('#ntCompare').onclick = () => { closeTray(); if (nav.active && nav.dest) planRoute(nav.dest, 'compare'); };
  $('#ntReroute').onclick = () => { closeTray(); if (nav.active && nav.dest) planRoute(nav.dest, 'manual'); };
  $('#ntVia').onclick = () => {
    closeTray();
    if (!nav.active || !nav.dest) return;
    if (nav.via && nav.via.length) { nav.via = []; planRoute(nav.dest, 'via'); toast('경유지를 뺐어요. 경로를 다시 찾습니다.', '', 3000); }
    else openSearch('via');
  };
  $('#ntSearch').onclick = () => { closeTray(); openSearch('dest'); };
  $('#ntUpdate').onclick = () => { closeTray(); goUpdate(); };
  $('#updBtn').onclick = goUpdate;
  $('#navEnd').onclick = () => { endNav(); say('안내를 종료합니다.', 1); };

  function applyTesla() {
    $('#app').classList.add('tesla');   // 테슬라 모드만 쓴다 (2026-11-14)
    queueLayout(); // 지도 칸 너비가 바뀌므로 다시 배치
    placeAlerts();
  }
  // ---------- 야간 지도: 자동(해가 지면 어둡게) / 항상 밤 / 항상 낮 ----------
  // 해의 높이(고도)를 지금 위치와 시각으로 계산한다 (NOAA 간이식, 오차 1분 안팎). 해가 지평선 아래 2° 보다 내려가면 밤
  function sunElevation(date, lat, lng) {
    const rad = Math.PI / 180;
    const d = date.getTime() / 86400000 + 2440587.5 - 2451545.0; // 2000-01-01 12:00 UTC 부터 지난 날
    const g = (357.529 + 0.98560028 * d) * rad;
    const q = 280.459 + 0.98564736 * d;
    const L = (q + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * rad;
    const e = (23.439 - 0.00000036 * d) * rad;
    const dec = Math.asin(Math.sin(e) * Math.sin(L));
    const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L));
    const gmst = ((18.697374558 + 24.06570982441908 * d) % 24 + 24) % 24;
    const ha = (gmst * 15 + lng) * rad - ra;
    return Math.asin(Math.sin(lat * rad) * Math.sin(dec) + Math.cos(lat * rad) * Math.cos(dec) * Math.cos(ha)) / rad;
  }
  const NIGHT_LABEL = { auto: '자동 (해 지면 어둡게)', on: '항상 어둡게', off: '항상 밝게' };
  function nightMode() { const m = store.get('nightMode'); return m === 'on' || m === 'off' ? m : 'auto'; }
  function isNightAt(date) {
    const m = nightMode();
    if (m !== 'auto') return m === 'on';
    const p = state.fix || DEFAULT_CENTER;
    return sunElevation(date || new Date(), p.lat, p.lng) < -2;
  }
  function applyNight() {
    state.night = isNightAt(new Date());
    const m = nightMode(), b = $('#nightBtn');
    $('#map').classList.toggle('night', state.night);
    if (mapA && mapA.setDark) mapA.setDark(state.night);
    // 교통 색이 낮/밤 팔레트로 바뀌었으면 경로선을 다시 칠한다 (지나온 부분은 다시 잘라 낸다)
    if (applyNight.was !== state.night) {
      const changed = applyNight.was !== undefined;
      applyNight.was = state.night;
      if (changed && mapA && nav.pts && nav.route) {
        mapA.drawRoute(nav.pts, nav.route.sections);
        nav.drawnAt = 0; drawRemaining();
        nav.arrowKey = null; renderTurnArrow();
      }
    }
    b.innerHTML = state.night ? ICON_MOON : ICON_SUN;
    b.classList.toggle('auto', m === 'auto');
    b.setAttribute('aria-label', '야간 지도: ' + NIGHT_LABEL[m]);
    const sel = $('#optNight');
    if (sel && sel.value !== m) sel.value = m;
    renderWeather(); // 해가 지면 날씨 아이콘도 해 → 달로
  }
  function setNightMode(m) {
    store.set('nightMode', m === 'auto' ? null : m);
    applyNight();
  }
  // 버튼: 자동 → 항상 어둡게 → 항상 밝게 → 자동
  $('#nightBtn').onclick = () => {
    const next = { auto: 'on', on: 'off', off: 'auto' }[nightMode()];
    setNightMode(next);
    toast('야간 지도: ' + NIGHT_LABEL[next], '', 2500);
  };

  const d = document;
  if (!(d.fullscreenEnabled || d.webkitFullscreenEnabled)) $('#fsBtn').hidden = true;
  $('#fsBtn').onclick = () => {
    if (d.fullscreenElement || d.webkitFullscreenElement) {
      (d.exitFullscreen || d.webkitExitFullscreen).call(d);
      return;
    }
    const el = d.documentElement;
    const req = el.requestFullscreen || el.webkitRequestFullscreen;
    if (!req) return;
    const p = req.call(el);
    if (p && p.catch) p.catch(() => toast('이 브라우저에서는 전체화면이 막혀 있습니다.', '', 4000));
  };

  // 설정
  const sheet = $('#sheet');
  function updateDemoBtn() { $('#demoBtn').textContent = state.demoTimer ? '데모 주행 멈추기' : '데모 주행 시작'; }
  async function checkProxy() {
    const st = $('#proxyStatus');
    st.textContent = '확인 중…';
    try {
      const j = await api('/health', {});
      st.textContent = '연결됨 · 지도 API 키 ' + (j.ncp ? '있음' : '없음') + ' · 장소 검색 키 ' + (j.search ? '있음' : '없음 (주소 검색만 가능)') +
        (j.logs === false ? ' · 기록 저장소 없음' : '');
    } catch (e) {
      st.textContent = '연결 실패: ' + e.message;
    }
  }
  $('#setBtn').onclick = () => {
    $('#keyInput').value = store.get('key') || '';
    $('#origin').textContent = location.origin;
    $('#optVoice').checked = prefs.voice;
    $('#optBeep').checked = prefs.beep;
    $('#optCams').checked = prefs.cams;
    $('#optSigCams').checked = prefs.signalCams;
    $('#optBumps').checked = prefs.bumps;
    $('#optParking').checked = prefs.parking;
    $('#optRest').checked = prefs.rest;
    $('#optSigns').checked = prefs.signs;
    $('#optTunnels').checked = prefs.tunnels;
    $('#optJunction').checked = prefs.junction;
    $('#optTraffic').checked = prefs.traffic;
    $('#optWeather').checked = prefs.weather;
    $('#optHup').checked = prefs.headingUp;
    $('#optStopNorth').checked = prefs.stopNorth;
    $('#optStopNorth').disabled = glOn();
    $('#optGl').checked = prefs.gl;
    $('#iconAdmin').hidden = !params.has('debug');   // 아이콘 관리 페이지(내부)는 ?debug 일 때만
    renderCarIcons();
    $('#optNight').value = nightMode();
    $('#optTilt').checked = prefs.tilt;
    $('#optTilt').disabled = !prefs.headingUp;
    $('#optRoute').value = prefs.routeOpt;
    $('#proxyInput').value = proxyUrl();
    $('#camCount').textContent = cams.loaded ? cams.rows.length.toLocaleString('ko-KR') : '-';
    $('#camDate').textContent = cams.date || '-';
    updateDemoBtn();
    sheet.hidden = false;
    checkProxy();
  };
  $('#closeSheet').onclick = () => { sheet.hidden = true; };

  // ---------- 주행 기록 화면 ----------
  const fmtDay = (t) => { const d = new Date(t); return (d.getMonth() + 1) + '월 ' + d.getDate() + '일 (' + '일월화수목금토'[d.getDay()] + ')'; };
  function renderTrips() {
    const live = tripLog.cur && tripLog.cur.dist >= 50 ? [tripLog.cur] : [];
    const all = live.concat(loadTrips());
    const box = $('#tripList');
    const totKm = all.reduce((a, c) => a + (c.dist || 0), 0) / 1000;
    const totOver = all.reduce((a, c) => a + (c.events || []).length, 0);
    $('#tripSum').textContent = all.length ? '최근 ' + all.length + '번 주행 · ' + totKm.toFixed(1) + 'km · 과속 ' + totOver + '번 (단속 카메라 앞에서 제한을 넘었거나 구간 평균을 넘은 경우)' : '';
    if (!all.length) { box.innerHTML = '<div class="empty">아직 주행 기록이 없어요. 달리기 시작하면 자동으로 남습니다.</div>'; return; }
    box.innerHTML = all.map((c, k) => {
      const avg = c.drive > 60000 ? Math.round(c.dist / (c.drive / 1000) * 3.6) : 0;
      const ev = c.events || [];
      const isLive = live.length && k === 0;
      const route = esc(c.from || '출발지') + ' → ' + esc(c.dest || c.to || '도착지');
      return '<div class="tripc' + (isLive ? ' live' : '') + '">' +
        '<button class="trip-head" data-k="' + k + '"><div class="tc-top"><b>' + fmtDay(c.start) + ' ' + hhmm(new Date(c.start)) +
        (isLive ? ' · 지금 주행 중' : '–' + hhmm(new Date(c.lastMove))) + '</b>' +
        (ev.length ? '<span class="ovb">과속 ' + ev.length + '</span>' : '<span class="okb">과속 없음</span>') + '</div>' +
        '<div class="tc-route">' + route + '</div>' +
        '<div class="tc-stats">' + ((c.dist || 0) / 1000).toFixed(1) + 'km · ' + fmtDur(c.drive || 0) + ' · 평균 ' + avg + ' · 최고 ' + Math.round(c.max || 0) + ' km/h</div></button>' +
        '<div class="tc-events" data-k="' + k + '" hidden>' + (ev.length ? ev.map((e, j) =>
          '<button class="tev" data-k="' + k + '" data-j="' + j + '"><span class="tev-t">' + hhmm(new Date(e.t)) + '</span>' +
          '<span class="tev-m"><b>' + e.kmh + '</b> / ' + e.limit + ' km/h</span>' +
          '<span class="tev-p">' + esc(e.label || '') + (e.km ? ' ' + e.km + 'km' : '') + (e.place ? ' · ' + esc(e.place) : '') + '</span></button>').join('')
          : '<div class="empty">이 주행에서는 과속이 없었어요.</div>') + '</div></div>';
    }).join('');
    box.querySelectorAll('.trip-head').forEach((b) => {
      b.onclick = () => { const el = box.querySelector('.tc-events[data-k="' + b.dataset.k + '"]'); el.hidden = !el.hidden; };
    });
    // 과속한 곳을 누르면 지도에서 그 자리를 보여 준다 (15초 뒤 다시 내 차를 따라간다)
    box.querySelectorAll('.tev').forEach((b) => {
      b.onclick = () => {
        const e = (all[+b.dataset.k].events || [])[+b.dataset.j];
        if (!e || !Number.isFinite(e.lat) || !mapA) return;
        $('#tripSheet').hidden = true;
        setFollowing(false);
        mapA.center(e.lat, e.lng, false);
        toast(hhmm(new Date(e.t)) + ' ' + (e.place || '') + ' · ' + e.label + ' · ' + e.kmh + '/' + e.limit + ' km/h', '', 5000);
      };
    });
  }
  $('#tripBtn').onclick = () => { saveCurTrip(); renderTrips(); $('#tripSheet').hidden = false; };
  $('#tripClose').onclick = () => { $('#tripSheet').hidden = true; };
  $('#tripSheet').addEventListener('click', (e) => { if (e.target === $('#tripSheet')) $('#tripSheet').hidden = true; });
  // 지우기는 두 번 눌러야 (잘못 눌러 기록을 날리지 않게)
  let tripClearArmed = 0;
  $('#tripClear').onclick = () => {
    if (Date.now() - tripClearArmed > 4000) { tripClearArmed = Date.now(); toast('한 번 더 누르면 주행 기록이 모두 지워집니다.', 'bad', 4000); return; }
    tripClearArmed = 0;
    store.set('trips', null);
    renderTrips();
    toast('주행 기록을 지웠어요.', '', 2500);
  };
  sheet.addEventListener('click', (e) => { if (e.target === sheet) sheet.hidden = true; });
  $('#saveKey').onclick = () => { store.set('key', $('#keyInput').value.trim() || null); location.reload(); };
  $('#clearKey').onclick = () => { store.set('key', null); location.reload(); };
  $('#optVoice').onchange = (e) => { prefs.voice = e.target.checked; store.set('voice', prefs.voice ? null : '0'); updateSoundPill(); };
  $('#optBeep').onchange = (e) => { prefs.beep = e.target.checked; store.set('beep', prefs.beep ? null : '0'); updateSoundPill(); };
  $('#optNight').onchange = (e) => setNightMode(e.target.value);
  $('#optJunction').onchange = (e) => {
    prefs.junction = e.target.checked; store.set('junction', prefs.junction ? null : '0');
    if (nav.active) renderNav();
  };
  $('#optTunnels').onchange = (e) => {
    prefs.tunnels = e.target.checked; store.set('tunnels', prefs.tunnels ? null : '0');
    if (nav.active) renderNav();
  };
  $('#optRest').onchange = (e) => {
    prefs.rest = e.target.checked; store.set('rest', prefs.rest ? null : '0');
    restState.key = '';
    renderRest();
  };
  $('#optParking').onchange = (e) => {
    prefs.parking = e.target.checked; store.set('parking', prefs.parking ? null : '0');
    parkState.markerKey = '';
    if (state.fix) evalParking(state.fix);
  };
  $('#optBumps').onchange = (e) => {
    prefs.bumps = e.target.checked; store.set('bumps', prefs.bumps ? null : '0');
    bumpState.markerKey = '';
    if (state.fix) evalBumps(state.fix);
  };
  $('#optSigns').onchange = (e) => {
    prefs.signs = e.target.checked; store.set('signs', prefs.signs ? null : '0');
    if (state.fix) evalSigns(state.fix);
  };
  $('#optSigCams').onchange = (e) => {
    prefs.signalCams = e.target.checked; store.set('sigcam', prefs.signalCams ? '1' : null);
    camState.markerAt = null;
    if (state.fix) { evalCameras(state.fix); refreshCamMarkers(state.fix); }
  };
  $('#optCams').onchange = (e) => {
    prefs.cams = e.target.checked; store.set('cams', prefs.cams ? null : '0');
    if (state.fix) { evalCameras(state.fix); refreshCamMarkers(state.fix); }
  };
  $('#optTraffic').onchange = (e) => {
    prefs.traffic = e.target.checked; store.set('traffic', prefs.traffic ? null : '0');
    if (mapA && mapA.setTraffic) mapA.setTraffic(prefs.traffic);
    updateAttrib();
  };
  $('#optWeather').onchange = (e) => {
    prefs.weather = e.target.checked; store.set('weather', prefs.weather ? null : '0');
    weather.at = null;
    if (prefs.weather && state.fix) updateWeather(state.fix); else $('#weather').hidden = true;
  };
  $('#optHup').onchange = (e) => {
    prefs.headingUp = e.target.checked; store.set('hup', prefs.headingUp ? null : '0');
    renderHupBtn();
    layoutView();
  };
  $('#optStopNorth').onchange = (e) => {
    prefs.stopNorth = e.target.checked; store.set('stopNorth', prefs.stopNorth ? null : '0');
    if (state.fix) checkStopNorth(state.fix.t);
  };
  $('#optGl').onchange = async (e) => {
    prefs.gl = e.target.checked; store.set('gl', prefs.gl ? null : '0');
    // 지도를 새로 만든다 (경로·카메라는 다시 그린다)
    if (mapA === NaverAdapter && window.naver && naver.maps && naver.maps.Map) {
      await useMap(NaverAdapter);
      if (mapA && mapA.setDark) mapA.setDark(state.night, true);
      $('#optStopNorth').disabled = glOn();
      toast(glOn() ? '벡터 지도로 바꿨습니다 (글자가 똑바로)' : (prefs.gl ? '이 화면에서는 벡터 지도를 쓸 수 없어 그림 지도로 둡니다' : '그림 지도로 바꿨습니다'), '', 3000);
    }
  };
  $('#optTilt').onchange = (e) => { prefs.tilt = e.target.checked; store.set('tilt', prefs.tilt ? null : '0'); layoutView(); };
  $('#optRoute').onchange = (e) => { prefs.routeOpt = e.target.value; store.set('routeOpt', prefs.routeOpt); };
  $('#proxyInput').onchange = (e) => {
    const v = e.target.value.trim();
    store.set('proxy', v && v !== PROXY_DEFAULT ? v : null);
    checkProxy();
  };
  $('#proxyTest').onclick = checkProxy;
  $('#soundTest').onclick = () => {
    unlockAudio();
    if (!speak('음성 안내 테스트입니다. 500미터 앞, 과속 단속. 제한속도 60입니다.', true)) {
      beep(2);
      toast(hasTTS ? '이 기기에는 한국어 음성이 없어 경고음으로 안내합니다.' : '이 브라우저는 음성 안내를 지원하지 않아 경고음으로 안내합니다.', '', 5000);
    }
  };
  $('#resetTrip').onclick = () => {
    state.trip = 0; state.driveMs = 0; state.maxKmh = 0; render();
    saveTripNow(true);
    sheet.hidden = true;
    toast('주행 기록을 초기화했습니다.', '', 2500);
  };
  $('#demoBtn').onclick = () => {
    if (state.demoTimer) stopDemo(false); else startDemo();
    updateDemoBtn();
    sheet.hidden = true;
  };
  $('#diagToggle').onclick = () => setDiag(!diag.on);
  $('#diagUpload').onclick = uploadDiag;

  // ---------- 아이콘 목록 (관리 페이지 tools/icons.html 이 iframe 으로 ?catalog 를 부를 때: 지도·GPS 는 켜지 않는다) ----------
  if (params.has('catalog')) {
    window.__tncCatalog = {
      version: APP_VERSION,
      guide: Object.keys(TURN_ICONS).map((k) => ({ k, html: icoBase(k), borrowed: !!ICON_FALLBACK[k] && !(window.TNC_ICONS || {})[k] ? ICON_FALLBACK[k] : '' })),
      signs: SIGN_TYPES.map((t) => ({ k: 'sign_' + t.id, label: t.label, html: signSvg(t.g) })).concat([{ k: 'sign_bump', label: '과속방지턱', html: SIGN_BUMP }]),
      tunnel: { k: 'tunnel', label: '터널', html: TUNNEL_ICON },
      cars: CAR_ICONS.map((c, i) => ({ id: c.id, name: c.name, html: c.svg('-c' + i) })),
      repoPicks: window.TNC_PICKS || {},
    };
    return;
  }
  // 고른 방지턱 그림은 방지턱 카드에도
  { const b = pickImg('sign_bump'); if (b) { const el = document.querySelector('#bumpCard .bump-sign'); if (el) el.innerHTML = b; } }

  // ---------- 시작 ----------
  tele.ctx = () => ({
    map: mapA === NaverAdapter ? 'naver' : (mapA ? 'osm' : 'none'),
    kmh: Math.round(state.speedKmh), nav: nav.active, demo: !!state.demoTimer, drive: view.drive,
    gps: $('#gpsText').textContent, screen: [innerWidth, innerHeight, devicePixelRatio],
  });
  applyNight();
  applyTesla();
  updateSoundPill();
  renderHupBtn();
  showChrome(); // 처음 3초 동안 버튼을 보여 준 뒤 숨긴다
  setTimeout(() => report('session', { msg: 'open', debug: params.has('debug'), scheme: (window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light', night: nightMode() }), 6000); // 지도·GPS 상태가 잡힌 뒤 접속 기록
  render();
  tickClock();
  setInterval(tickClock, 1000);
  bootMap();
  loadCameras();
  loadBumps();
  loadParking();
  loadRest();
  loadSigns();
  loadHipass();
  loadTunnels();
  startGps();
  if (store.get('diag') === '1' || params.has('diag')) setDiag(true);
  if (params.has('demo')) startDemo();
  checkForUpdate('open');
  // 자동 업데이트로 새 버전이 뜬 직후 한 번 알린다 (바뀐 게 맞는지 운전자가 알 수 있게)
  try {
    if (sessionStorage.getItem('tnc.updTried') === APP_VERSION && sessionStorage.getItem('tnc.updShown') !== APP_VERSION) {
      sessionStorage.setItem('tnc.updShown', APP_VERSION);
      setTimeout(() => toast('새 버전으로 바뀌었어요 · ' + APP_VERSION.slice(5), '', 4000), 1500);
    }
  } catch (e) { /* 저장소 막힘 */ }
  $('#ntVer').textContent = '버전 ' + APP_VERSION.slice(5);
  document.addEventListener('visibilitychange', () => {
    // 화면이 오래(5분 넘게) 가려졌다가 다시 보이면 새 버전을 확인한다 (길안내 중·주행 중이면 하지 않음)
    if (document.visibilityState === 'hidden') upd.hiddenAt = Date.now();
    else if (upd.hiddenAt && Date.now() - upd.hiddenAt > 5 * 60000) checkForUpdate('visible');
  });
  // ?debug 일 때만 내부 상태를 콘솔에서 볼 수 있게 연다 (테스트용)
  if (params.has('debug')) {
    window.__tnc = {
      state, camState, nav, cams, prefs, onFix, setRoute, startNav, endNav, startDemo, stopDemo, renderNav,
      planRoute, doSearch, setFollowing, canvasPoint, gesture, glView, glOn, evalCameras, navUpdate, loadCameras, getMap: () => mapA,
      view, layoutView, zoomCtl, autoZoom, motion, alertLog, checkForUpdate, version: APP_VERSION,
      sunElevation, isNightAt, setNightMode, openSearch, favs, setFav, idleUpdate, upd, openTray, closeTray, endCompare, selectAlt, pickDest, updateUrl, resumeFrom, renderCam, renderUpdBtn, bumps, bumpState, bumpsNear, evalBumps, arrowSays,
      saveTripNow, restoreTripNow, trafficColor, highwaySpans, turnKind, tollState, hipass, setHipassData, loadHipass, hipassKey, hipassNums, hipassLayout, laneNums, laneStripHtml, tunnels, setTunnelData, loadTunnels, ensureRouteTunnels, tunnelAhead, renderTunnel, juncInfo, juncSvg, renderJunction, ico, icoBase, pickImg, iconPicks: ICON_PICKS, tollParts, arrowSpan, routeStyle: ROUTE_STYLE, trafficPal, roundRoute, setCarIcon, carIcons: CAR_ICONS, parking, parkState, setParkingData, loadParking, evalParking, rest, setRestData, loadRest, ensureRouteRest, renderRest, placeBase, findParking, renderTurnArrow,
      signs, signState, setSignData, loadSigns, evalSigns, SIGN_TYPES, road, localOnRoute, routeNamesAt, sameStreet, bumpRoad, signRoad,
      tripLog, loadTrips, finishTrip, renderTrips, wxIcon, renderWeather, weather,
      tripStore: { save: (l) => store.set('trips', l ? JSON.stringify(l) : null) },
    };
  }
})();
