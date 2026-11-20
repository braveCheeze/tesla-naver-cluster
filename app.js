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
    tunnels: true,   // 길안내 중 터널 진입·출구 거리 (v172: 늘 켬, 설정에서 뺐다)
    junction: store.get('junction') !== '0', // 고속도로 진출입·갈림길 그림 (기본 켬)
    lanes: store.get('lanes') !== '0',       // 회전 차로 안내 (시험판: 정밀도로지도를 받은 곳만, 기본 켬)
    traffic: store.get('traffic') !== '0',
    weather: store.get('weather') !== '0',
    // v172 (2026-11-20 공개 전 보안 점검): '놓침'·'틀림'을 누르면 그 자리 근처 카메라 후보와 진행 방향을 서버로 보낸다 (설정에서 끌 수 있음, 기본 켬)
    share: store.get('share') !== '0',
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
  // v172: 운영자 토큰 — 운전자 차에만 개발자 메뉴에서 한 번 넣는다(이 기기 localStorage). 있으면 진단 기록 올리기, 놓침 궤적,
  // 자동 카메라 점검 기록, 모든 사용자에게 바로 가는 고침을 보낸다. 없으면(공개 사용자) 궤적·자동 기록 없이 누른 신고만 보낸다
  const adminToken = () => store.get('adminToken') || '';
  const isOp = () => adminToken().length >= 16;
  const authHeaders = (h) => (isOp() ? Object.assign({ Authorization: 'Bearer ' + adminToken() }, h) : h);

  // ---------- 운영 모니터링: 접속·오류를 길안내 서버에 짧게 남긴다 (위치는 보내지 않음) ----------
  const APP_VERSION = '2026.11.16-175'; // 배포 때 index.html 의 app.js?v=·icons.js?v= 와 version.json 도 같이 올린다
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
  function eventBody(type, data) {
    let ctx = {};
    try { ctx = tele.ctx ? tele.ctx() : {}; } catch (e) { /* 초기화 전 오류 */ }
    return Object.assign({
      type, sid: tele.sid, v: APP_VERSION, at: Date.now(), page: location.host + location.pathname + location.search.slice(0, 40),
      ua: navigator.userAgent.slice(0, 180),
    }, ctx, data || {});
  }
  // v163 (2026-11-20 점검 9): 운전자가 누른 '놓침'·'틀림'은 꼭 닿게 한다. 예전엔 한 번만 보내고 실패를 삼켰고, 결과와 상관없이 '✓ 보냄',
  // 한 페이지에서 40건이 넘으면 말없이 멈췄다. 이제 보낼 함(tnc.outbox, 최대 30건)에 넣고 서버가 받았다고(200) 할 때만 뺀다.
  // 못 보낸 것은 다음 신고·1분마다·연결이 돌아오면·다음에 앱을 열 때 다시 보낸다
  const OUTBOX_MAX = 30;
  const outbox = {
    busy: false,
    load() { try { return JSON.parse(store.get('outbox') || '[]'); } catch (e) { return []; } },
    save(a) { store.set('outbox', a.length ? JSON.stringify(a.slice(-OUTBOX_MAX)) : null); },
    post: (body) => fetch(proxyUrl() + '/event', { method: 'POST', body: JSON.stringify(body), headers: authHeaders({ 'Content-Type': 'application/json' }) }),
  };
  async function outboxFlush() {
    if (outbox.busy || botLike) return null;
    if (!outbox.load().length) return null;
    outbox.busy = true;
    let last = null;
    try {
      for (const body of outbox.load()) {
        let ok = false;
        try { const r = await outbox.post(body); ok = !!(r && r.ok); } catch (e) { ok = false; }
        if (!ok) { last = false; break; }
        outbox.save(outbox.load().filter((x) => x.qid !== body.qid));
        last = true;
      }
    } finally { outbox.busy = false; }
    return last;
  }
  // 돌려주는 값: true 보냄 · false 못 보내 함에 남김 · null (보내지 않는 환경)
  async function reportSure(type, data) {
    if (botLike || (testPage && !outbox.inTest)) return null;
    const body = eventBody(type, data);
    body.qid = tele.sid + '-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
    const a = outbox.load(); a.push(body); outbox.save(a);
    const r = await outboxFlush();
    return outbox.load().some((x) => x.qid === body.qid) ? false : r !== false;
  }
  window.addEventListener('online', () => { outboxFlush(); });
  function report(type, data) {
    if (testPage || botLike || tele.sent >= 40) return; // 검색엔진 로봇·자동화 접속은 보고하지 않음
    const key = type + '|' + (data && data.msg);
    if (tele.seen.has(key)) return; // 같은 내용은 세션당 한 번만
    tele.seen.add(key);
    tele.sent++;
    const body = eventBody(type, data);
    try {
      fetch(proxyUrl() + '/event', {
        method: 'POST', body: JSON.stringify(body), headers: authHeaders({ 'Content-Type': 'application/json' }), keepalive: true,
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
    // 길찾기 서버 요청의 시간 초과(api() 의 abort)는 통신이 느린 것뿐이라 오류로 올리지 않는다 (2026-11-15 23:34 PC 모의 주행)
    if (r && r.name === 'AbortError') { e.preventDefault(); return; }
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

  // v172: 네이버 지도 Client ID 칸을 설정에서 없앴다 — 예전에 넣어 둔 키는 지우고 길안내 서버 키(/config)만 쓴다.
  // 주소의 ?key=... 는 저장하지 않고 지우기만 한다
  const params = new URLSearchParams(location.search);
  if (store.get('key')) store.set('key', null);
  if (params.get('key')) {
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
    return m >= 60 ? Math.floor(m / 60) + '시간' + (m % 60 ? ' ' + (m % 60) + '분' : '') : m + '분';   // '1시간 0분' → '1시간'
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
  // v160 (2026-11-20 점검: 새로고침·'새 버전' 뒤에는 화면을 누를 때까지 음성·경고음이 모두 꺼져 있는데 표시가 없었다):
  // 주차 중에는 예전처럼 아무것도 안 띄우고(2026-11-13 '터치하면 소리가 켜집니다' 문구를 뺐다), 길안내 중이거나 달리기 시작했는데
  // 아직 소리가 잠겨 있으면 '소리 꺼짐 · 화면을 한 번 누르세요'를 띄운다. 누르면 바로 켜지고 사라진다
  let soundPill = null;
  function updateSoundPill() {
    const want = !audioUnlocked && (prefs.voice || prefs.beep) && (nav.active || (state.speedKmh || 0) >= 5) && !state.demoTimer;
    if (!want) { if (soundPill) soundPill.hidden = true; return; }
    if (!soundPill) {
      soundPill = document.createElement('button');
      soundPill.className = 'soundpill';
      soundPill.id = 'soundPill';
      soundPill.textContent = '소리 꺼짐 · 화면을 한 번 누르세요';
      soundPill.onclick = () => { unlockAudio(); beep(1, 660); };
      $('#map').appendChild(soundPill);
    }
    soundPill.hidden = false;
  }
  function unlockAudio(ev) {
    const C = window.AudioContext || window.webkitAudioContext;
    if (!actx && C) { try { actx = new C(); } catch (e) { actx = null; } }
    if (actx && actx.state === 'suspended') { try { actx.resume(); } catch (e) { /* 다음 누름에 */ } }
    // 터치 화면에서는 pointerdown 이 아직 '사용자 동작'이 아닐 수 있다(손을 뗄 때 인정됨). 떼는 순간에도 다시 부른다
    const ua = navigator.userActivation;
    if (ev && ev.type === 'pointerdown' && ua && !ua.hasBeenActive) return;
    audioUnlocked = true;
    updateSoundPill();
  }
  for (const t of ['pointerdown', 'pointerup', 'touchend', 'click', 'keydown']) document.addEventListener(t, unlockAudio, { passive: true, capture: true });
  // 예전에 이 사이트에서 소리를 낸 적이 있으면 브라우저가 터치 없이도 경고음을 허락하기도 한다
  try { const C = window.AudioContext || window.webkitAudioContext; if (C) actx = new C(); } catch (e) { actx = null; }
  function beep(times, freq) {
    if (!prefs.beep || !actx) return;
    if (actx.state === 'suspended') { try { actx.resume(); } catch (e) { /* 잠김 */ } }
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
    if (actx.state === 'suspended') { try { actx.resume(); } catch (e) { /* 잠김 */ } }
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
  // v174 (2026-11-20 카페 시험자 '설정 값에서는 체크가 되어 있는데 안내 멘트가 나오지 않습니다'):
  // 예전엔 한국어 음성이 없으면 말없이 경고음만 냈고(이유는 설정의 소리 테스트에서만), 말하라고 했는데 소리가 안 나는 브라우저
  // (음성 목록은 있지만 시작이 안 됨)는 알아채지 못해 경고음도 없었다. 이제 4초 안에 말이 시작되지 않으면(말하는 중도 아니면) 그 안내는 경고음으로 대신하고,
  // 두 번 이어지면 이 화면에서는 경고음으로만 안내한다. 이유는 한 번 짧게 알리고 설정 '소리'에 남긴다(위치 없이 서버에도 한 번)
  const tts = { started: 0, failed: 0, broken: false, noticed: false };
  function ttsStatus() {
    if (!hasTTS) return 'none';
    if (tts.broken) return 'broken';
    if (koVoice) return 'ok';
    return voicesSettled || speechSynthesis.getVoices().length ? 'noko' : 'wait';
  }
  const TTS_WHY = {
    none: '이 브라우저에는 음성 기능이 없어 경고음으로 안내해요.',
    noko: '이 브라우저에는 한국어 음성이 없어 경고음으로 안내해요.',
    broken: '이 브라우저에서 음성이 나오지 않아 경고음으로 안내해요.',
  };
  function ttsNotice() {
    const st = ttsStatus();
    if (!TTS_WHY[st] || tts.noticed || !prefs.voice) return;
    tts.noticed = true;
    toast(TTS_WHY[st], '', 5000);
    let n = 0, langs = '';
    try { const vs = hasTTS ? speechSynthesis.getVoices() : []; n = vs.length; langs = [...new Set(vs.map((v) => v.lang))].slice(0, 8).join(','); } catch (e) { /* 없음 */ }
    report('info', { msg: 'tts unavailable: ' + st, voices: n, langs });
    renderVoiceState();
  }
  function renderVoiceState() {
    const el = document.getElementById('voiceState');
    if (!el) return;
    const why = TTS_WHY[ttsStatus()];
    el.hidden = !why;
    el.textContent = why || '';
  }
  // v161 (2026-11-20 점검): 급한 회전 안내(urgent)가 말하던·기다리던 단속 카메라 안내를 끊고 다시 말하지 않았다.
  // 끊긴 카메라 안내는 급한 안내가 끝난 뒤 그 카메라가 아직 앞에 있으면 한 번 다시 말한다
  const camVoice = { text: '', i: null, at: 0, done: true, retried: false };
  function speak(text, urgent, onFail, onEnd) {
    if (!prefs.voice || !audioUnlocked) return false;
    if (!hasTTS || tts.broken) { ttsNotice(); return false; }
    // 한국어 음성이 없는 기기에서 외국어 음성으로 읽으면 알아들을 수 없으므로 경고음으로 대신한다
    if (!koVoice && (voicesSettled || speechSynthesis.getVoices().length)) { ttsNotice(); return false; }
    try {
      let resay = false;
      if (urgent) {
        resay = !camVoice.done && !camVoice.retried && Date.now() - camVoice.at < 12000;
        speechSynthesis.cancel();
      }
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'ko-KR';
      if (koVoice) u.voice = koVoice;
      u.rate = 1.05;
      if (onFail) u.onerror = (e) => { if (e.error !== 'interrupted' && e.error !== 'canceled') onFail(); };
      u.onend = () => {
        if (onEnd) onEnd();
        if (resay) {
          const tg = camState.target;
          if (tg && tg.i === camVoice.i && !tg.after) { camVoice.retried = true; speak(camVoice.text, false, null, () => { camVoice.done = true; }); }
        }
      };
      // v174: 말이 시작됐는지 본다. 앞 안내가 아직 말하는 중이면(차례 기다림) 세지 않는다
      const ok1 = () => { if (!u._st) { u._st = true; tts.started++; tts.failed = 0; } };
      u.onstart = ok1;
      const end0 = u.onend;
      u.onend = (e) => { ok1(); if (end0) end0(e); };   // 시작 알림이 없는 브라우저도 끝남은 성공으로 본다
      const err0 = u.onerror;
      u.onerror = (e) => { u._err = true; if (err0) err0(e); };
      try { if (speechSynthesis.paused) speechSynthesis.resume(); } catch (e) { /* 없음 */ }
      speechSynthesis.speak(u);
      setTimeout(() => {
        if (u._st || u._err || speechSynthesis.speaking) return;   // 말하는 중이면(시작 알림이 없어도) 나오는 것
        tts.failed++;
        try { speechSynthesis.cancel(); } catch (e) { /* 없음 */ }
        if (onFail) onFail();
        if (tts.failed >= 2 && !tts.started) { tts.broken = true; ttsNotice(); }
      }, 4000);
      return true;
    } catch (e) { return false; }
  }
  function sayCam(tg, text, beeps) {
    camVoice.text = text; camVoice.i = tg.i; camVoice.at = Date.now(); camVoice.done = false; camVoice.retried = false;
    const spoke = speak(text, false, () => beep(beeps || 1), () => { camVoice.done = true; });
    if (!spoke) camVoice.done = true;
    logAlert(spoke ? 'voice' : 'beep', text);
    if (!spoke) beep(beeps || 1);
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
    el.className = 'cammk k' + c[3] + (c[6] ? ' z' + c[6] : '') + (c[3] === 8 || ((c[10] | 0) & 2) ? ' mob' : ''); // z2 어린이·z1 노인 보호구역은 노란 바탕
    // v114 (2026-11-15 요청 '이동식은 파란색으로, 빨간 테두리 말고'): 이동식·박스형(부스에 이동식 장비를 넣는 곳)은 파란 테두리
    el.textContent = c[2] || '?';
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
  // v148 길게 눌러 고른 자리 핀: 도착 핀과 같은 모양, 파란색
  function pickPinEl() {
    const el = document.createElement('div');
    el.className = 'destpin pickpin';
    el.innerHTML = PIN_ICON.replace('#ef4444', '#2f7cf6');
    return el;
  }
  // v145 주차장 입구 표지 (지도·안내 칸 같은 그림): 흰 둥근 네모 + 파란 P
  const PARK_P_SVG = '<svg viewBox="0 0 48 48" aria-hidden="true"><rect x="3" y="3" width="42" height="42" rx="10" fill="#fff" stroke="#1d4fb8" stroke-width="2.5"/>' +
    '<path d="M18.5 36V12.5h8a7.3 7.3 0 0 1 0 14.6h-8" fill="none" stroke="#1d4fb8" stroke-width="5.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  function parkPinEl() { const el = document.createElement('div'); el.className = 'parkpin'; el.innerHTML = PARK_P_SVG; return el; }
  const parkGoalOf = (d) => (d && d.park && !d.parkOff ? d.park : null);
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
    // v148 확대·축소를 지도 라이브러리에 맡길지 (syncZoomGestures). 그림 지도 주행 화면은 setInteract 가 이미 다 끈다
    setLibZoom(on) {
      if (!this.map || (!this.gl && view.drive)) return;
      this.map.setOptions({ pinchZoom: on, scrollWheel: on, disableDoubleTapZoom: !on, disableDoubleClickZoom: !on });
    },
    setDrag(on) { if (this.map && !(!this.gl && view.drive)) this.map.setOptions({ draggable: on }); },
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
      const mb = this.gl && this.map._mapbox;
      if (mb && mb.unproject) { const ll = mb.unproject([px, py]); return { lat: ll.lat, lng: ll.lng }; }
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
          // v138: 원본 좌표(교차로 한가운데인 것이 많다) 대신 카메라가 찍는 자리(접근로 정지선·차로 위 점)에 그린다
          position: new N.LatLng(camPt(x.c).lat, camPt(x.c).lng), map: this.map, clickable: false, zIndex: 100,
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
      // v145: 주차장 입구로 안내 중이면 경로 끝(차가 들어가는 곳)에 P 표지
      if (end && parkGoalOf(d) && !parkGoalOf(d).gate) this.destMk.push(new N.Marker({ position: new N.LatLng(end.lat, end.lng), map: this.map, clickable: false, zIndex: 299,
        icon: { content: parkPinEl(), anchor: new N.Point(13, 13) } }));
    },
    // v148 지도를 길게 눌러 고른 자리 핀 (null 이면 지운다)
    setPick(p) {
      if (this._pick) { this._pick.setMap(null); this._pick = null; }
      if (!p || !this.map) return;
      this._pick = new naver.maps.Marker({ position: new naver.maps.LatLng(p.lat, p.lng), map: this.map, clickable: false, zIndex: 310,
        icon: { content: pickPinEl(), anchor: new naver.maps.Point(17, 33) } });
    },
    // 차로 말풍선 (v139): tip = laneTipFor() 결과 또는 null. 같은 말풍선이면 그대로
    setLaneTip(tip) {
      const key = tip ? tip.key : '';
      if (key === this._tipKey && (!tip || this._tip)) return;
      this._tipKey = key;
      if (this._tip) { this._tip.setMap(null); this._tip = null; }
      if (!tip || !this.map) return;
      const N = naver.maps;
      this._tip = new N.Marker({ position: new N.LatLng(tip.lat, tip.lng), map: this.map, clickable: false, zIndex: 150,
        icon: { content: tip.html, size: new N.Size(tip.w, tip.h), anchor: new N.Point(tip.ax, tip.ay) } });
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
      if (this._tip) this._tip.setMap(null);
      this._tip = null; this._tipKey = '';
      if (this._pick) this._pick.setMap(null);
      this._pick = null;
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
    setLibZoom(on) {
      if (!this.map || view.drive) return;
      ['touchZoom', 'scrollWheelZoom', 'doubleClickZoom'].forEach((k) => { if (this.map[k]) this.map[k][on ? 'enable' : 'disable'](); });
    },
    setDrag(on) { if (this.map && !view.drive && this.map.dragging) this.map.dragging[on ? 'enable' : 'disable'](); },
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
        this.cams.set(x.i, L.marker([camPt(x.c).lat, camPt(x.c).lng], {
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
      if (end && parkGoalOf(d) && !parkGoalOf(d).gate) this.destMk.push(L.marker([end.lat, end.lng], {
        icon: L.divIcon({ html: parkPinEl().outerHTML, className: 'me-wrap', iconSize: [26, 26], iconAnchor: [13, 13] }), interactive: false, keyboard: false, zIndexOffset: 1900,
      }).addTo(this.map));
    },
    setPick(p) {
      if (this._pick) { this._pick.remove(); this._pick = null; }
      if (!p || !this.map) return;
      this._pick = L.marker([p.lat, p.lng], {
        icon: L.divIcon({ html: pickPinEl().outerHTML, className: 'me-wrap', iconSize: [34, 34], iconAnchor: [17, 33] }), interactive: false, keyboard: false, zIndexOffset: 2100,
      }).addTo(this.map);
    },
    setLaneTip(tip) {
      const key = tip ? tip.key : '';
      if (key === this._tipKey && (!tip || this._tip)) return;
      this._tipKey = key;
      if (this._tip) { this._tip.remove(); this._tip = null; }
      if (!tip || !this.map) return;
      this._tip = L.marker([tip.lat, tip.lng], {
        icon: L.divIcon({ html: tip.html, className: 'me-wrap', iconSize: [tip.w, tip.h], iconAnchor: [tip.ax, tip.ay] }),
        interactive: false, keyboard: false, zIndexOffset: 1500,
      }).addTo(this.map);
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
      this.destMk = []; this._arrowObjs = []; this._arrow = null; this.restMk = []; this._tip = null; this._tipKey = ''; this._pick = null;
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
    if (state.pick && mapA.setPick) mapA.setPick(state.pick); // v148 길게 눌러 고른 자리 핀 (지도를 다시 만들면 다시 꽂는다)
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
    // 길안내 중 주행 화면: 왼쪽에 안내 패널·서랍이 있어 차를 가운데보다 오른쪽(화면 폭 63%)에 둔다.
    // 가운데면 패널 끝에서 60px 남짓이라 좌회전·유턴 길이 패널 밑으로 사라졌다 (v110 디자인 검토 P1)
    const cx = drive && nav.active && $('#app').classList.contains('tesla') && w > 600 ? Math.round(w * 0.63) : w / 2;
    const dx = Math.abs(cx - w / 2);
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
      cs = 2 * Math.ceil(Math.hypot(Math.max(xC, w / 2) + dx, Math.max(yC, h - cy)) + VIEW_MARGIN);
    }
    const key = (drive ? [w, h, cs, cx, cy, tilt].join() : w + 'x' + h) + (gl ? ':gl' : '');
    const wasDrive = view.drive;
    if (!force && drive === wasDrive && key === view.key) {
      if (drive) setViewRot();
      return false;
    }
    // 주행 화면 안에서 크기만 바뀌면 애니메이션 없이 (들어올 때는 돌아가며 기울어지게 둔다)
    const snap = drive && wasDrive;
    if (snap) host.classList.add('snap');
    Object.assign(view, { drive, key, cs, cx, cy, tilt });
    if (drive && gl) {
      host.style.setProperty('--gh', 2 * cy + 'px');
      host.style.setProperty('--gw', Math.round(2 * Math.max(cx, w - cx)) + 'px');   // 캔버스 가운데 = 차 (cx)
      if (!wasDrive) view.rot = turn(-state.heading);
      setViewRot();
    } else if (drive) {
      const s = host.style;
      s.setProperty('--cl', Math.round(cx - cs / 2) + 'px');
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
    syncZoomGestures();
    let jumped = false;
    if (mapA && mapA.resize && w && h) {
      // 지도 라이브러리가 캔버스에 직접 넣은 크기는 지우고 CSS 크기를 따르게 한다
      const clear = () => { if (canvas) { canvas.style.width = ''; canvas.style.height = ''; } };
      clear();
      try { mapA.resize(drive ? (gl ? Math.round(2 * Math.max(cx, w - cx)) : cs) : w, drive ? (gl ? 2 * cy : cs) : h); } catch (e) { /* 다음 배치 때 다시 */ }
      clear();
      if (state.fix && !state.peek && (drive || wasDrive || state.following)) { // 앞길을 보는 중이면 보던 자리 그대로
        const p = mePos();
        mapA.center(p.lat, p.lng, true);
        jumped = true;
      }
    }
    if (snap) { void host.offsetWidth; host.classList.remove('snap'); }
    placeCredit();   // v173: 주행 화면 ↔ 평면 지도
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
  // v173 (2026-11-20 운전자 '출처 빼라니까 악용한다고'): 설정의 자료별 출처 문단은 뺐다. 다만 OpenStreetMap 자료(터널·도로 모양)는
  // ODbL 이라 공개 화면에 출처가 있어야 하고, 공공데이터(공공누리)도 출처를 적는 게 원칙이라 지도 출처 표시 옆에 이름만 짧게 붙인다
  // (어떤 기능에 쓰는지는 적지 않는다). 네이버 출처 표시(약관)는 건드리지 않는다
  const OWN_CREDIT = '/© OpenStreetMap /공공데이터포털';
  const credit = document.createElement('div');
  credit.className = 'attrib-own';
  credit.textContent = OWN_CREDIT;
  credit.hidden = true;
  $('#map').appendChild(credit);
  function updateAttrib() {
    attrib.textContent = mapA === NaverAdapter ? '© NAVER Corp. /국토교통부' + (prefs.traffic ? ' /경찰청(UTIC)' : '') + ' ' + OWN_CREDIT
      : (mapA ? '© OpenStreetMap contributors /공공데이터포털' : '');
    placeCredit();
  }
  // 평면 지도(주행 화면이 아닐 때)에는 네이버 지도가 왼쪽 아래에 그리는 출처 표시 바로 오른쪽에 같은 글꼴·크기·색으로 둔다.
  // 주행 화면에서는 네이버 표시가 화면 밖이라 위 attrib 한 줄에 함께 들어 있다
  function placeCredit() {
    const m = $('#map');
    const nat = m && !view.drive && mapA === NaverAdapter ? m.querySelector('.map_copyright') : null;
    if (!nat || !nat.offsetWidth) { credit.hidden = true; return; }
    const mr = m.getBoundingClientRect(), nr = nat.getBoundingClientRect();
    let right = 0;
    for (const c of nat.querySelectorAll('*')) { const r = c.getBoundingClientRect(); if (r.width > 0 && r.height > 0 && r.bottom > nr.top) right = Math.max(right, r.right); }
    if (!right) right = nr.right;
    const cs = getComputedStyle(nat);
    credit.style.left = Math.round(right - mr.left + 3) + 'px';
    credit.style.bottom = Math.round(mr.bottom - nr.bottom) + 'px';
    credit.style.height = cs.height; credit.style.lineHeight = cs.lineHeight;
    credit.style.fontSize = cs.fontSize; credit.style.fontFamily = cs.fontFamily; credit.style.color = cs.color;
    credit.hidden = false;
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
    // 길안내 서버에서 받는다 (v172: 설정의 키 칸은 없앴다)
    const key = await fetchMapKey();
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
    el._d = b.d;
    orderAlerts();
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
    const ent = (j && j.entries) || [];
    rest.items = ((j && j.items) || []).map((x, k) => ({ lat: x[0], lng: x[1], name: x[2], dir: x[3] || '', route: x[4] || '', ent: ent[k] || [] }));
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
      const mid = cum[best.i] + best.t * (cum[best.i + 1] - cum[best.i]);
      if (!(onHighwayAt(mid) || /고속도로|고속국도/.test(routeRoadAt(best.i)))) continue; // 옆 일반도로를 지날 때는 아님
      // v133 (2026-11-16 사용자: 네이버 3km 일 때 우리 3.1~3.2km, '200m 정도 차이'): 휴게소 좌표는 건물·주차장 가운데라
      // 경로에 내리면 진입로가 갈라지는 곳보다 수백 m 뒤다(죽전휴게소 245m). 네이버처럼 본선에서 진입로가 갈라지는 점(OSM, tools/osm_rest.py)
      // 까지 잰다: 경로 15m 안·본선 진행 방향 40° 안·휴게소 가운데보다 1.5km 안 앞의 갈림점. 없으면 예전처럼 가운데
      // v135 (2026-11-16 주행 중 '이거 딱 봐도 우리 쉼터 아니지 않아??' — 서울하이패스센터쉼터는 하행 본선에서만 들어간다):
      // 갈림점이 모두 반대 방향 본선(경로 옆 120m 안, 진행 방향이 140° 넘게 다름)에 있으면 우리 방향에서는 못 들어가는 휴게소로 뺀다.
      // 이름에 '양방향'이 있으면 믿고 두고, 갈림점을 모르면(OSM 에 없음) 예전처럼 둔다
      let at = mid, hit = false, opp = 0, unk = 0;
      for (const e of r.ent) {
        const p = { lat: e[0], lng: e[1] };
        let nb = null;
        for (let i = 0; i < pts.length - 1; i++) {
          if (cum[i + 1] < mid - 2000 || cum[i] > mid + 2000) continue;   // 반대 방향 갈림점은 휴게소 가운데보다 우리 쪽에서 보면 뒤에 있다
          const pr = projectSeg(p, pts[i], pts[i + 1]);
          if (!nb || pr.dist < nb.dist) nb = { dist: pr.dist, i, t: pr.t };
          if (pr.dist > 25 || cum[i] > mid + 100) continue;
          if (e[2] >= 0 && angleDiff(e[2], bearing(pts[i], pts[i + 1])) > 40) continue;
          const ea = cum[i] + pr.t * (cum[i + 1] - cum[i]);
          if (ea <= mid + 50 && ea >= mid - 1500) { hit = true; if (at === mid || ea > at) at = Math.min(ea, mid); }
        }
        if (hit) continue;
        if (nb && e[2] >= 0 && nb.dist <= 120 && angleDiff(e[2], bearing(pts[nb.i], pts[nb.i + 1])) >= 140) opp++;
        else unk++;
      }
      if (!hit && opp > 0 && unk === 0 && !/양방향/.test(r.dir)) continue;
      out.push({ name: r.name, dir: r.dir, at, mid, lat: r.lat, lng: r.lng });
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
  const restState = { key: '', next: null };
  const REST_HW_LEAD = 2000;
  function restRoadNear() {
    if (highwaySpans().some(([a, b]) => nav.along >= a - REST_HW_LEAD && nav.along <= b)) return true;
    return /고속도로|고속국도/.test(routeRoadAt(nav.seg || 0));   // 진입 안내 없이 구간 이름만 고속도로인 경로
  }
  // v133 (2026-11-16 주행 중 사용자: '파란색 배경으로 밑에 있다가 키로미터에 따라서 이렇게 네이버처럼 위로 올려 줘야'):
  // 다음 휴게소가 이 안이면 맨 위 안내 줄을 휴게소로 (네이버 지도는 3km 에서 위 큰 칸이 휴게소, 그 밑 작은 칸이 휴게소 다음 안내)
  const REST_TOP = 3000;
  // 휴게소 표지 (v135, 2026-11-16 사용자 '휴게소 아이콘도 하나 만들어 줘'): 흰 둥근 타일 + 굵은 파란 포크·나이프 (파란 줄·파란 안내 칸에서 또렷하게,
  // 흰 바탕에서도 보이게 얇은 파란 테두리). 밑 파란 줄(index.html #restCard)과 같은 그림
  const REST_SIGN = '<svg viewBox="0 0 48 48" class="rest-sign" aria-hidden="true"><rect x="3" y="3" width="42" height="42" rx="10" fill="#fff" stroke="#1d4fb8" stroke-width="2"/><path d="M14.5 8.5v9c0 2 1.5 3.4 3.3 3.8v16.2c0 1.3.9 2.2 1.9 2.2s1.9-.9 1.9-2.2V21.3c1.8-.4 3.3-1.8 3.3-3.8v-9M17.8 8.5v7M21.4 8.5v7" fill="none" stroke="#1d4fb8" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/><path d="M34 8.5c-3.4 1.6-5.3 5.8-5.3 11 0 2.6 1.1 4.2 3.1 4.8v13.2c0 1.3.9 2.2 1.9 2.2s1.9-.9 1.9-2.2V8.5z" fill="#1d4fb8" stroke="none"/></svg>';
  function renderRest() {
    const el = $('#restCard');
    const list = nav.active && prefs.rest ? ensureRouteRest() : [];
    const ahead = list.filter((r) => r.at > nav.along + 30);
    const next = ahead[0];
    // v140 (2026-11-16 잠실→기흥역, 석촌호수사거리에서 '서울하이패스센터쉼터 19km' 파란 줄 — 네이버는 시내에서는 휴게소를 띄우지 않는다):
    // 고속도로 위이거나 고속도로 진입이 REST_HW_LEAD 안으로 다가왔을 때만 보여 준다 (지도 표지는 그대로)
    const show = !!next && next.at - nav.along <= REST_SHOW && restRoadNear();
    el.hidden = !show;
    restState.next = show ? { name: next.name.replace(/쉼터휴게소$/, '쉼터'), d: next.at - nav.along } : null;   // 가까우면 안내 줄로 (renderNavPanel)
    if (show) {
      $('#restName').textContent = next.name.replace(/쉼터휴게소$/, '쉼터');   // '서울하이패스센터쉼터휴게소' → '…쉼터'
      $('#restDist').textContent = fmtDist(next.at - nav.along);
      const n2 = ahead[1];
      const nx = $('#restNext');
      if (n2 && n2.at - nav.along <= 100000) {
        const nm = document.createElement('span'), d = document.createElement('b');
        nm.textContent = '다음 ' + n2.name.replace(/(쉼터)?휴게소$/, '$1'); d.textContent = fmtDist(n2.at - nav.along);
        nx.replaceChildren(nm, ' ', d);   // 이름이 길면 이름만 줄이고 거리는 늘 보이게
      } else nx.replaceChildren();
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
    if (p) { $('#parkDist').textContent = fmtDist(p.d); el._d = p.d; orderAlerts(); }
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
    el._d = s.passed ? 0 : s.d;
    orderAlerts();
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
  // v172 (2026-11-20 운전자: '터널 들어가면 다크모드로 되게끔 해 줘 나가면 풀리던가 (밤이면 그대로)'):
  // 터널 안이면 지도를 밤 지도로, 나오면 되돌린다. 야간 지도가 '자동'일 때만 ('항상 밝게'를 고른 사람은 그 뜻대로, '항상 어둡게'는 이미 어둡다).
  // 터널 안인지: 길안내 중이면 경로 위 터널 구간(v163 tunnels.json) 안, 아니면 진행 방향이 맞는 이름에 '터널'이 든 터널 도로 9m 안.
  // 시속 10km 넘게 달리다 위치가 3초 넘게 안 오면(터널에서 GPS 끊김) 마지막 위치가 터널 안이거나 입구 150m 앞이었을 때 터널 안으로 본다 (15분까지).
  // 깜빡이지 않게: 들어갈 때는 바로, 나올 때는 터널 밖이 4초 이어지고 어두워진 지 8초가 지나야 푼다
  const TN_DARK_OUT_MS = 4000, TN_DARK_MIN_MS = 8000, TN_DARK_SOON = 150;
  const tnDark = { on: false, at: 0, outAt: 0 };
  function namedTunnelAt(p, hb) {
    const wi = tunnelWayAt(p, hb);
    return wi >= 0 && /터널/.test(tunnels.ways[wi].name || '');
  }
  function inTunnelNow(nowWall) {
    if (!tunnels.loaded || !state.fix) return false;
    const lag = ((nowWall || Date.now()) - lastFixWall) / 1000;
    // 멈춰 있으면 브라우저가 위치를 드문드문 준다 — 마지막 속도가 시속 10km 넘을 때만 끊김으로 본다 (터널 입구 앞 신호 대기에서 어두워지지 않게)
    const lost = !state.demoTimer && lastFixWall > 0 && lag > 3 && lag < 900 && state.speedKmh >= 10;
    let here = false, soon = false;
    if (nav.active && nav.pts && nav.onRoute && ensureRouteTunnels()) {
      const t = nav.routeTunnels.find((x) => x.s1 > nav.along && x.s0 - nav.along < TUNNEL_SHOW);
      here = !!t && t.s0 <= nav.along;
      soon = !!t && t.s0 - nav.along <= TN_DARK_SOON;
    } else if (state.heading !== null && (state.speedKmh >= 5 || lost)) {
      here = namedTunnelAt(state.fix, state.heading);
      soon = here;
      for (let d = 25; !soon && d <= TN_DARK_SOON; d += 25) soon = namedTunnelAt(aheadPt(state.fix, state.heading, d), state.heading);
    }
    return here || (lost && soon);
  }
  // 1초마다(시계)와 위치가 올 때. 바뀌면 지도를 다시 칠한다
  function tunnelDarkTick(nowWall) {
    const now = nowWall || Date.now();
    const inside = nightMode() === 'auto' && inTunnelNow(now);
    if (inside) {
      tnDark.outAt = 0;
      if (!tnDark.on) { tnDark.on = true; tnDark.at = now; applyNight(); }
      return tnDark.on;
    }
    if (!tnDark.on) return false;
    if (!tnDark.outAt) tnDark.outAt = now;
    if (nightMode() !== 'auto' || (now - tnDark.outAt >= TN_DARK_OUT_MS && now - tnDark.at >= TN_DARK_MIN_MS)) {
      tnDark.on = false; tnDark.outAt = 0; applyNight();
    }
    return tnDark.on;
  }
  function renderTunnel() {
    const el = $('#tunnelRow'), a = tunnelAhead();
    el.hidden = !a;
    if (!a) return;
    const ic = $('#tunnelIcon');
    // AI 로 그린 터널 아이콘(icons.js 의 tunnel)이 있으면 그것, 없으면 앱에 그려 둔 아치
    if (!ic.firstChild) ic.innerHTML = pickImg('tunnel') || (window.TNC_ICONS && window.TNC_ICONS.tunnel ? icoBase('tunnel') : TUNNEL_ICON);
    el.classList.toggle('inside', a.inside);
    el._d = a.d;   // 줄 순서 (v158): 터널 안이면 출구, 밖이면 입구까지
    const name = a.t.name || '터널';
    $('#tunnelDist').textContent = fmtDist(a.d);
    $('#tunnelText').textContent = a.inside ? name + ' 출구까지' : name + ' 입구까지' + (a.t.len >= 1000 ? ' · 길이 ' + fmtDist(a.t.len) : '');
    $('#tunnelBar').style.width = a.inside ? Math.round(Math.max(0, Math.min(1, a.p)) * 100) + '%' : '0';
  }
  // v163 (2026-11-20 점검 10): 카메라 자료를 못 받으면 다시 받지 않았고, 박스형·이동식(mobile.json)을 못 받아도 아무 표시가 없었다.
  // 10초·30초·1분·2분·5분 뒤 다시 받는다. 카메라는 있고 박스형만 빠졌으면 경고 중·구간단속 중이 아닐 때 다시 받는다
  async function loadCameras() {
    clearTimeout(camLoad.timer);
    let ok = false, mobileOk = false;
    try {
      // 버전을 붙여 새 버전과 함께 바뀐 카메라 데이터를 바로 받는다 (브라우저 10분 캐시 우회)
      const [r, rm, rd] = await Promise.all([fetch('data/cameras.json?v=' + APP_VERSION), fetch('data/mobile.json?v=' + APP_VERSION).catch(() => null),
        fetch('data/driver_spots.json?v=' + APP_VERSION).catch(() => null)]);
      try { const d = rd && rd.ok ? await rd.json() : null; if (d && Array.isArray(d.rows)) driverSpots.rows = d.rows; } catch (e) { /* 없이 */ }
      if (!r.ok) throw new Error('cameras ' + r.status);
      const j = await r.json();
      // 박스형(단속 부스)·이동식 과속 단속 (v112, tools/build_mobile.py): 행 모양이 같아 그대로 붙인다. 도로 이름은 모름(-1)
      try {
        const m = rm && rm.ok ? await rm.json() : null;
        if (m && Array.isArray(m.rows)) {
          const base = j.rows.length, nb = (j.arrowNames || []).length;
          j.rows = j.rows.concat(m.rows);
          j.arrowNames = (j.arrowNames || []).concat(m.arrowNames || []);
          const ma = m.arrows || [];
          const add = [];
          for (let k = 0; k + 2 < ma.length; k += 3) add.push(ma[k] + base, ma[k + 1] + nb, ma[k + 2] + nb);
          j.arrows = (j.arrows || []).concat(add);
          const jd = j.dirs || [];
          jd.length = base;
          // v165: 박스형의 OSM 길 이름 번호는 mobile.json 의 osmNames 기준이다 — 합친 표의 번호로 옮긴다
          const no = (j.osmNames || []).length;
          j.osmNames = (j.osmNames || []).concat(m.osmNames || []);
          j.dirs = jd.concat((m.dirs || []).map((d) => (d && d[5] >= 0 ? d.slice(0, 5).concat([d[5] + no], d.slice(6)) : d)));
          cams.mobile = m.rows.length;
          mobileOk = true;
          try { camNoUnflag(m.unflag); } catch (e) { /* 다음에 */ }
        }
      } catch (e) { /* 박스형 목록 없이 */ }
      // 다시 받다가 박스형만 실패했으면 이미 가진 자료(박스형 포함)를 그대로 둔다
      if (!mobileOk && cams.loaded && cams.mobile) throw new Error('keep');
      // v123: 카메라가 찍는 진행 방향·층·그 차로 위 점 (tools/osm_cams.py)
      const dirs = j.dirs || [], onames = j.osmNames || [];
      j.rows.forEach((c, i) => {
        const d = dirs[i];
        c.eb = d ? d[0] : -1; c.e2 = d ? d[1] : 0; c.lv = d ? d[4] : 0;
        c.on = d && d[5] >= 0 ? onames[d[5]] || '' : '';   // v165: 카메라가 붙은 OSM 길 이름 (박스형은 경찰 자료에 도로 이름이 없다)
        c.sl = d ? c[0] + d[2] / 1e5 : c[0]; c.sg = d ? c[1] + d[3] / 1e5 : c[1];
      });
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
      cams.userBase = null; applyUserSpots();   // v169: 신고한 단속 지점을 카메라 표 끝에 붙인다
      applyCamFixes();                           // v171: '놓침' 진단으로 고친 카메라
      if (!testPage) loadSharedFixes();
      ok = true;
      nav.routeCams = null;   // 길안내 중이면 경로 위 카메라를 새 자료로 다시 찾는다
    } catch (e) {
      if (!cams.loaded && !camLoad.tries) toast('단속 카메라 자료를 받지 못했어요. 잠시 뒤 다시 받아요.', 'bad', 5000);
    }
    cams.failed = !ok && !cams.loaded;
    cams.mobileMissing = cams.loaded && !mobileOk && !cams.mobile;
    if (cams.loaded && cams.mobile) camLoad.tries = 0;   // 카메라·박스형 둘 다 있다 (이번에 받았거나 이미 가진 것)
    else if (camLoad.tries < 30) {
      camLoad.tries++;
      camLoad.timer = setTimeout(retryCameras, [10, 30, 60, 120, 300][Math.min(camLoad.tries - 1, 4)] * 1000);
    }
    renderCamStatus();
  }
  const camLoad = { tries: 0, timer: 0 };   // (loadCameras 는 부팅 끝에 불리므로 여기 선언해도 된다)
  function retryCameras() {
    if (testPage && !camLoad.allowInTest) return;
    // 카메라는 있고 박스형만 빠졌으면 경고 중·구간단속 중에는 자료를 바꾸지 않는다
    if (cams.loaded && (camState.target || camState.section)) { camLoad.timer = setTimeout(retryCameras, 30000); return; }
    loadCameras();
  }
  // ---- v169 (2026-11-20 운전자 '놓침 몇 개 눌렀는데 거긴 항상 업데이트가 안 되더라'): 신고한 단속 지점 ----
  // 박스형·이동식은 공공자료에 없어 '확인된 곳만 추가' 규칙으로는 놓침 자리가 영영 반영되지 않았다. 이제
  //  (1) '놓침'을 누르면 그 차에 바로 '내가 신고한 단속 지점'으로 저장하고(tnc.mySpots, 이 기기에만), 다음에 같은 방향으로 지날 때 미리 알린다.
  //      자리는 누른 곳이 아니라 궤적에서 약 2.5초 전 자리(지나친 뒤에 누르니까). 제한속도는 모름('?'), 과속 경고음 없음
  //  (2) 운전자가 같은 자리·방향에서 다른 날 두 번 넘게 누른 곳은 data/driver_spots.json 으로 모든 사용자에게 알린다(카메라 점만)
  //  (3) 설정 '내가 신고한 단속 지점'에서 상태(단속 자료에 있음 · 모든 사용자에게 반영됨 · 이 차에서만 알림)를 보고 지운다
  // 카메라 표 끝에 같은 모양의 행(flags 4)으로 붙여서 경고·지남·지도는 다른 카메라와 똑같이 처리한다
  const USER_FLAG = 4;
  const isUserSpot = (c) => ((c[10] | 0) & USER_FLAG) === USER_FLAG;
  const driverSpots = { rows: [] };
  const mySpots = [];
  try {
    for (const x of JSON.parse(store.get('mySpots') || '[]')) {
      if (Array.isArray(x) && x.length >= 3) mySpots.push({ lat: x[0], lng: x[1], h: x[2], t: x[3] || 0, days: Array.isArray(x[4]) ? x[4] : [], kmh: x[5] || 0 });
    }
  } catch (e) { /* 없음 */ }
  function saveMySpots() {
    store.set('mySpots', mySpots.length ? JSON.stringify(mySpots.slice(-100).map((x) => [x.lat, x.lng, x.h, x.t, x.days.slice(-5), x.kmh])) : null);
  }
  function userSpotRow(lat, lng, h, kmh, who) {
    const r = [lat, lng, 0, 1, 0, 0, 0, -1, kmh >= 70 ? 1 : 4, 1, USER_FLAG];
    r.eb = h == null ? -1 : h; r.e2 = 0; r.lv = 0; r.sl = lat; r.sg = lng; r.on = ''; r.who = who;
    return r;
  }
  const sameSpot = (a, b) => haversine(a, b) < 60 && (a.h == null || b.h == null || angleDiff(a.h, b.h) <= 45);
  function applyUserSpots() {
    if (!cams.loaded) return;
    const keyOf = (c) => Math.floor(c[0] / CELL) + ':' + Math.floor(c[1] / CELL);
    if (cams.userBase != null) {
      for (let i = cams.rows.length - 1; i >= cams.userBase; i--) {
        const a = cams.grid.get(keyOf(cams.rows[i]));
        if (a) { const k = a.lastIndexOf(i); if (k >= 0) a.splice(k, 1); }
        camState.passed.delete(i);
        if (camState.target && camState.target.i === i) camState.target = null;
      }
      cams.rows.length = cams.userBase;
    }
    cams.userBase = cams.rows.length;
    const add = [];
    for (const d of driverSpots.rows) add.push({ lat: d[0], lng: d[1], h: d[2], kmh: d[3] || 0, who: 'driver' });
    // v171 모든 사용자 신고 지점. v175: 운영자가 확인하기 전 자동 반영(src 'auto', 서로 다른 운전자 3명 넘게)은 '사용자 제보'로 따로 보인다
    for (const d of sharedSpots) if (!add.some((x) => sameSpot(x, d))) add.push({ lat: d.lat, lng: d.lng, h: d.h, kmh: 0, who: d.src === 'auto' ? 'crowd' : 'driver' });
    for (const m of mySpots) if (!add.some((x) => sameSpot(x, m))) add.push({ lat: m.lat, lng: m.lng, h: m.h, kmh: m.kmh, who: 'mine' });
    for (const x of add) {
      const i = cams.rows.length, r = userSpotRow(x.lat, x.lng, x.h, x.kmh, x.who);
      cams.rows.push(r);
      const k = keyOf(r);
      if (!cams.grid.has(k)) cams.grid.set(k, []);
      cams.grid.get(k).push(i);
    }
    nav.routeCams = null;
  }
  // '놓침'을 누른 자리: 궤적에서 약 2.5초 전(천천히 가면 누른 자리), 그 때 방향·속도
  function addMySpot(now) {
    const t = now || Date.now();
    let p = trace1.length ? trace1[trace1.length - 1] : null;
    if (!p && state.fix) p = [state.fix.t, state.fix.lat, state.fix.lng, Math.round(state.speedKmh || 0), state.heading];
    if (!p) return null;
    if (p[3] >= 10) { for (let k = trace1.length - 1; k >= 0; k--) { if (p[0] - trace1[k][0] >= 2500) { p = trace1[k]; break; } } }
    const spot = { lat: p[1], lng: p[2], h: p[4] == null ? null : Math.round(p[4]), t, days: [], kmh: p[3] || 0 };
    let m = mySpots.find((x) => sameSpot(x, spot));
    if (!m) { m = spot; mySpots.push(m); }
    m.t = t;
    const day = dayStr(t);
    if (!m.days.includes(day)) m.days.push(day);
    saveMySpots();
    applyUserSpots();
    return m;
  }
  function removeMySpot(m) {
    const k = mySpots.indexOf(m);
    if (k >= 0) mySpots.splice(k, 1);
    saveMySpots();
    applyUserSpots();
  }
  // ---- v171 (2026-11-20 운전자 '놓침을 누르면 하나 자료를 참고해서 바로 반영될 수 있었으면 좋겠어 … 안 맞는 구간 넣어준다거나') ----
  // '놓침'을 누르는 순간 차 안에서 원인을 찾는다: 최근 궤적(1.5km)과 앞쪽 600m 에서 우리 자료(신고 지점 제외)의 카메라 후보를 찾고,
  // 경고 칸에 오르지 않은 까닭을 붙여 그 차에 바로 고침을 적용한다(tnc.camFix, 이 기기에만. 카메라를 다시 받아도 다시 붙인다).
  //   flag   '틀림'으로 흐리게·숨김 → 표시를 푼다
  //   signal 신호 전용이라 알리지 않음(설정) → 이 카메라는 알린다
  //   dir    찍는 방향이 내 진행 방향과 달라 걸렀다 → 이 차에서는 양방향으로 본다 (같은 자리에 내 방향 카메라가 따로 있으면 고치지 않는다)
  //   route  길안내 경로 위로 보지 않았다(경로선 15~40m·이름 다름·고속도로·높이 거르기) → 이 차에서는 경로 위로 본다
  // 후보가 없거나 까닭을 모르면 '내가 신고한 단속 지점'을 만든다. 고침과 새 지점은 기기 번호와 함께 /fix 로 보낸다(아래 /fixes)
  const camFixes = new Map();   // key → Set(kind) (이 기기)
  const sharedFixes = new Map();   // key → Map(kind → src 'op'|'auto') (모든 사용자: /fixes. v175: auto = 확인 전 자동 반영)
  const sharedSpots = [];
  try { for (const [k, kind] of JSON.parse(store.get('camFix') || '[]')) { if (!camFixes.has(k)) camFixes.set(k, new Set()); camFixes.get(k).add(kind); } } catch (e) { /* 없음 */ }
  function saveCamFixes() {
    const list = [];
    camFixes.forEach((ks, k) => ks.forEach((kind) => list.push([k, kind])));
    store.set('camFix', list.length ? JSON.stringify(list.slice(-200)) : null);
  }
  const camKey = (c) => c[0] + ',' + c[1];
  function applyCamFixes() {
    if (!cams.loaded) return;
    const base = cams.userBase != null ? cams.userBase : cams.rows.length;
    for (let i = 0; i < base; i++) {
      const c = cams.rows[i], k = camKey(c), a = camFixes.get(k), b = sharedFixes.get(k);
      if (!a && !b && !c.fixed) continue;
      const has = (kind) => (a && a.has(kind)) || (b && b.has(kind));
      if (has('dir')) c.e2 = 1;
      else if (c.fixed && c.e2Orig != null) c.e2 = c.e2Orig;
      if (has('dir') && c.e2Orig == null) c.e2Orig = 0;
      c.fixRoute = has('route');
      c.forceWanted = has('signal');
      c.fixed = !!(a || b);
      // v175: 이 카메라를 바꾼 고침이 운영자 확인 전 자동 반영뿐이면(이 차에서 직접 고친 것 말고) 카드에 '사용자 제보'
      c.crowd = !!b && [...b.entries()].some(([kind, src]) => src === 'auto' && !(a && a.has(kind)));
    }
    nav.routeCams = null;
  }
  const devId = (() => {
    let d = store.get('devId');
    if (!d || !/^[a-z0-9]{8,24}$/.test(d)) { d = Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-6); store.set('devId', d); }
    return d;
  })();
  // 진단: 돌려주는 값 [{ i, c, why, d, ago }] (가장 그럴듯한 것부터)
  function diagnoseMiss() {
    const base = cams.userBase != null ? cams.userBase : (cams.rows || []).length;
    if (!cams.loaded || trace1.length < 2) return [];
    const now = Date.now(), seen = new Map();
    const look = (p, h, ago, ahead) => {
      for (const it of camsNear(p.lat, p.lng, 45)) {
        if (it.i >= base || seen.has(it.i)) continue;
        const c = it.c;
        if (c[3] === 4) continue;   // 주정차
        const d = Math.min(it.d, haversine(p, camPt(c)));
        if (d > 40) continue;
        seen.set(it.i, { i: it.i, c, h, d: Math.round(d), ago, ahead });
      }
    };
    // 지나온 길 (끝에서부터 1.5km)
    let dist = 0;
    for (let k = trace1.length - 1; k >= 0; k--) {
      const q = trace1[k], p = { lat: q[1], lng: q[2] };
      if (k < trace1.length - 1) dist += haversine(p, { lat: trace1[k + 1][1], lng: trace1[k + 1][2] });
      if (dist > 1500) break;
      look(p, q[4], Math.round((trace1[trace1.length - 1][0] - q[0]) / 1000), false);
    }
    // 앞쪽 600m (네이버가 먼저 알려 미리 누른 경우): 길안내 중이면 경로를 따라, 아니면 진행 방향으로
    const f = state.fix;
    if (f && state.heading !== null) {
      for (let s = 20; s <= 600; s += 20) {
        let p = null;
        if (nav.active && nav.pts && routeTrusted()) { const q = routePointAt(nav.along + s); if (q) p = q; }
        if (!p) p = aheadPt(f, state.heading, s);
        look(p, state.heading, -Math.round(s / Math.max(5, state.speedKmh / 3.6)), true);
      }
    }
    const res = [];
    for (const x of seen.values()) {
      const said = camState.saidById.get(x.i);
      if (said && now - said.t < 180000) continue;   // 이미 경고 칸에 올랐던 카메라
      const c = x.c, h = x.h;
      let why = 'other';
      if (camFlag(c, h)) why = 'flag';
      else if (!camWanted(c)) why = 'signal';
      else if (camHasDir(c) && h != null && angleDiff(c.eb, h) > CAM_DIR_TOL) {
        // 같은 자리(30m)에 내 방향 카메라가 따로 있으면 이 행은 반대쪽 것이다
        const twin = camsNear(c[0], c[1], 30).some((y) => y.i !== x.i && y.i < base && (!camHasDir(y.c) || angleDiff(y.c.eb, h) <= CAM_DIR_TOL));
        why = twin ? 'twin' : 'dir';
      } else if (nav.active && nav.routeCams && !nav.routeCams.has(c)) why = 'route';
      if (why === 'twin') continue;
      res.push(Object.assign(x, { why }));
    }
    const rank = { flag: 0, signal: 1, route: 2, dir: 3, other: 4 };
    return res.sort((a, b) => rank[a.why] - rank[b.why] || Math.abs(a.ago) - Math.abs(b.ago) || a.d - b.d);
  }
  const FIX_TEXT = {
    flag: '틀림으로 숨겨 둔 카메라였어요. 다시 알리게 했어요.',
    signal: '신호 전용이라 알리지 않던 카메라였어요. 이 카메라는 알릴게요.',
    dir: '카메라 방향이 반대로 돼 있었어요. 이 차에서는 양쪽 방향 모두 알릴게요.',
    route: '경로 밖으로 보던 카메라였어요. 이 차에서는 경로 위로 볼게요.',
  };
  // 진단 결과를 이 차에 적용하고, 보낼 고침 목록과 화면 글자를 돌려준다
  function fixFromMiss() {
    const diag = diagnoseMiss(), top = diag.find((x) => x.why !== 'other');
    const out = { diag: diag.slice(0, 5).map((x) => ({ cam: x.i, why: x.why, d: x.d, ago: x.ago })), items: [], text: '' };
    if (top) {
      const c = top.c, k = camKey(c);
      if (top.why === 'flag') { camNoMap.delete(k); saveCamNo(); }
      else { if (!camFixes.has(k)) camFixes.set(k, new Set()); camFixes.get(k).add(top.why); saveCamFixes(); applyCamFixes(); }
      out.items.push({ kind: top.why, k, lat: c[0], lng: c[1], h: top.h });
      out.text = FIX_TEXT[top.why];
      out.fixed = { cam: top.i, why: top.why };
      return out;
    }
    const m = addMySpot();
    if (m) out.items.push({ kind: 'spot', lat: m.lat, lng: m.lng, h: m.h });
    out.text = m ? '새 단속 지점으로 저장했어요. 다음에 같은 방향으로 지나면 미리 알려 드릴게요.' : '';
    return out;
  }
  // 고침을 기기 번호와 함께 보낸다 (예전 길안내 서버는 405: 그냥 넘어간다)
  // v172: 운영자 토큰이 있으면 모든 사용자에게 바로, 없으면 서버에 후보로만 쌓인다. '신고 위치 보내기'를 끄면 보내지 않는다
  function sendFixes(items) {
    if (!items.length || botLike || testPage || !prefs.share) return;
    try { fetch(proxyUrl() + '/fix', { method: 'POST', body: JSON.stringify({ dev: devId, items }), headers: authHeaders({ 'Content-Type': 'application/json' }) }).catch(() => {}); } catch (e) { /* 없이 */ }
  }
  // 모든 사용자 고침 (길안내 서버 /fixes): 운영자 토큰으로 보냈거나 운영자가 확인한 것(op), 서로 다른 운전자 3명 넘게 보내 자동 반영된 것(auto, v175).
  // 앱을 열 때와 30분마다
  async function loadSharedFixes() {
    if (botLike) return false;
    try {
      const r = await fetch(proxyUrl() + '/fixes', { cache: 'no-store' });
      if (!r.ok) return false;
      const j = await r.json();
      if (!j || !Array.isArray(j.items)) return false;
      sharedFixes.clear(); sharedSpots.length = 0;
      for (const it of j.items) {
        const src = it.src === 'auto' ? 'auto' : 'op';   // 예전 서버는 src 가 없다 = 운영자 고침
        if (it.kind === 'spot') sharedSpots.push(Object.assign({}, it, { src }));
        else if (it.k && it.kind !== 'flag') {
          if (!sharedFixes.has(it.k)) sharedFixes.set(it.k, new Map());
          const m = sharedFixes.get(it.k);
          if (m.get(it.kind) !== 'op') m.set(it.kind, src);
        }
      }
      applyCamFixes(); applyUserSpots();
      return true;
    } catch (e) { return false; }
  }
  // 신고 지점의 상태: 같은 자리(60m)·방향에 진짜 단속 자료가 있으면 'data', 모든 사용자 목록에 있으면 'driver', 다른 날 두 번 넘게면 'twice', 아니면 'mine'
  function mySpotStatus(m) {
    if (cams.loaded) {
      const base = cams.userBase != null ? cams.userBase : cams.rows.length;
      for (const it of camsNear(m.lat, m.lng, 60)) {
        if (it.i >= base || !isSpeedCam(it.c)) continue;
        if (m.h == null || !camHasDir(it.c) || angleDiff(it.c.eb, m.h) <= 50) return 'data';
      }
    }
    if (driverSpots.rows.some((d) => sameSpot({ lat: d[0], lng: d[1], h: d[2] }, m))) return 'driver';
    const sh = sharedSpots.find((d) => sameSpot(d, m));
    if (sh) return sh.src === 'auto' ? 'crowd' : 'driver';
    return m.days.length >= 2 ? 'twice' : 'mine';
  }
  // 단속 자료가 없을 때 주행 중이면 작은 표시 (소리 꺼짐 표시와 같은 모양, 그 밑)
  let camStatusEl = null;
  function renderCamStatus() {
    const txt = !prefs.cams ? '' : cams.failed ? '단속 카메라 자료 없음 · 다시 받는 중' : cams.mobileMissing ? '박스형·이동식 단속 자료 빠짐 · 다시 받는 중' : '';
    const want = !!txt && (nav.active || (state.speedKmh || 0) >= 5);
    if (!want) { if (camStatusEl) camStatusEl.hidden = true; return; }
    if (!camStatusEl) {
      camStatusEl = document.createElement('div');
      camStatusEl.className = 'soundpill campill';
      camStatusEl.id = 'camStatus';
      $('#map').appendChild(camStatusEl);
    }
    camStatusEl.textContent = txt;
    camStatusEl.hidden = false;
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
  // 신호(신호 전용·신호·과속) 카메라는 교차로 정지선 근처라 옆을 지나는 순간(2m 지나면) 바로 경고를 내린다.
  // v118 (요청 '신호 25m만 더 오차범위 줄이고')은 지나간 뒤 유지 거리만 30m → 5m 로 줄였는데, '지나갔다'는 판정이
  // '가장 가까웠던 거리보다 10m 더 멀어지고 카메라가 뒤에 있을 때'라 1초마다 오는 위치로는 시속 60km 에서
  // 여전히 카메라를 20~30m 지나서야 꺼졌다 (2026-11-15 요청 '오차 25 미터를 늘리지 말고 줄여 줘야 해').
  // v121: 경로 위 거리(길안내 중) 또는 진행 방향으로 잰 앞뒤 거리로 판정하고, 다음 위치가 오기 전에 지나갈 거리면 그 시각에 끈다
  const SIGNAL_PAST = 2;
  const isSignalCam = (c) => (c[3] === 2 || c[3] === 3) && !isRear(c);
  const camHold = (c) => (isRear(c) ? REAR_HOLD : isSignalCam(c) ? 0 : CAM_HOLD);
  // 카메라 행: [lat, lng, limit, kind, sec, len, zone, road, rtype, dir(, flags)]
  // kind: 1 과속, 2 신호 전용, 3 과속+신호, 9 구간/기타 · rtype: 1 고속국도, 3 일반국도, 4 지방도, 5 시도, 6 기타
  // 8 이동식: 경찰청 공개 데이터는 고정식만 담고 있어 지금은 없다. 이동식 위치 데이터가 생기면 kind 8 로 넣으면 파란색으로 뜬다
  const KIND_NAME = { 1: '과속단속', 2: '신호단속', 3: '신호·과속단속', 8: '이동식단속', 9: '구간단속' };   // v111: '구간단속'처럼 붙여 씀
  // 속도를 재는 카메라인지 (신호 전용은 제외. 단, 어린이보호구역은 안전을 위해 속도 단속으로 본다)
  const isSpeedCam = (c) => c[3] !== 2 || c[6] === 2;
  // 경고할 카메라인지: 신호 전용은 설정에서 켰을 때만
  const camWanted = (c) => isSpeedCam(c) || prefs.signalCams || !!c.forceWanted;   // v171: '놓침' 진단으로 알리게 한 신호 전용
  // 음성으로 읽는 이름: '과속'이라는 말은 빼고 '단속 카메라'로 (v122, 2026-11-15 밤 '속도 초과라는 말 없애줘 놀란다 자꾸').
  // 화면 글자(camLabel)는 그대로
  function camSpoken(c) {
    if (isUserSpot(c)) return '신고된 단속 지점';
    if (c[4] === 1) return '구간단속 시작';
    if (c[4] === 2) return '구간단속 끝';
    const zone = c[6] === 2 ? '어린이보호구역 ' : c[6] === 1 ? '노인보호구역 ' : '';
    const what = c[3] === 2 || c[3] === 3 ? '신호 단속 카메라' : c[3] === 8 ? '이동식 단속' : c[3] === 9 ? '구간단속' : '단속 카메라';
    return zone + (isRear(c) ? '후면 ' : '') + what;
  }
  function camLabel(c) {
    if (isUserSpot(c)) return c.who === 'mine' ? '내가 신고한 단속 지점' : c.who === 'crowd' ? '사용자 제보 단속 지점' : '운전자 신고 단속 지점';   // v169: 제한속도 모름 · v175 확인 전 자동 반영
    let s = c[4] === 1 ? '구간단속 시작' : c[4] === 2 ? '구간단속 끝' : (KIND_NAME[c[3]] || '단속 카메라');
    if (c[6] === 2) s = '어린이보호구역 ' + (c[3] === 2 ? '단속' : s);
    else if (c[6] === 1) s = '노인보호구역 ' + s;
    if (isRear(c)) s = s.replace(/ ?단속$/, ' 후면단속');   // 예: '신호·과속 후면단속'
    if (isBox(c)) s = '박스형 ' + s;                        // 예: '박스형 과속단속' (2026-11-14 팔당 제보)
    return s;
  }
  const camRoad = (c) => (cams.roads && c[7] >= 0 ? cams.roads[c[7]] : '') || '';
  // v157: '서울외곽순환고속도로'(경찰청 카메라 자료의 옛 이름)는 '수도권제1순환고속도로'(2020년 바뀐 이름, 네이버 경로 구간)와 같은 길
  // v165 (2026-11-20 2차 점검 C): 표기 차이를 맞춘다 — 경찰 '분당-수서간고속화도로'·'분당-수서간도시고속화도로', 네이버 '분당수서간도시고속화도로',
  // 도로명 '분당수서로' / '동부간선도로' 대 '동부간선로' / '구리-포천고속도로' / '수도권제1순환' 대 '수도권1순환' / '고속국도'
  const roadKey = (s) => {
    let k = String(s || '').replace(/[\s\-·ㆍ.]/g, '').replace(/\([^)]*\)/g, '').replace('서울외곽순환', '수도권제1순환').replace(/제(?=\d)/g, '');
    k = k.replace(/고속국도/g, '고속도로').replace(/간(?=(도시)?고속)/, '');
    if (/(도시고속화도로|고속화도로|도시고속도로)$/.test(k)) return k.replace(/(도시고속화도로|고속화도로|도시고속도로)$/, '고속화');
    if (/고속도로$/.test(k)) return k.replace(/고속도로$/, '고속');
    return k.replace(/도로$/, '로');
  };
  // 두 도로 이름이 같은 도로를 가리키는지 (한쪽이 다른 쪽을 포함하면 같다고 본다). 도시고속화도로는 그 도로명('분당수서로')과도 같다
  function sameRoad(a, b) {
    const x = roadKey(a), y = roadKey(b);
    if (!x || !y) return false;
    if (x.indexOf(y) >= 0 || y.indexOf(x) >= 0) return true;
    const x2 = x.replace(/고속화$/, '로'), y2 = y.replace(/고속화$/, '로');
    return x2 === y2;
  }
  // 카메라의 두 이름(경찰 자료 도로 이름·OSM 길 이름) 중 하나라도 같으면 같은 도로
  const camNames = (c) => [camRoad(c), c.on || ''].filter(Boolean);
  const sameCamRoad = (rn, c) => camNames(c).some((n) => sameRoad(rn, n));
  // 둘 다 구체적인 이름이 있는데 카메라의 어느 이름과도 다르면 다른 도로
  const camRoadDiffers = (rn, c) => specificRoad(rn) && camNames(c).some(specificRoad) && !sameCamRoad(rn, c);
  // 고속국도(도시고속도로·고속화도로 빼고)인지
  const isExpwyName = (n) => /고속도로|고속국도/.test(n || '') && !/도시고속|고속화/.test(n || '');
  // 빠른 길(고속도로·도시고속도로·고속화도로·자동차전용 순환·간선로): 고가·지하 구분 안내가 없는 곳
  const isFastRoad = (n) => /고속|순환로|간선|강변북로|올림픽대로|자동차전용/.test(n || '');
  // 이 카메라가 고속도로(경로가 달리는 그 고속도로 rn 포함) 위인지. 이름을 모르면 예전 규칙(고속국도이거나 제한 80 이상)
  function camOnExpwy(c, rn) {
    if (c[8] === 1) return true;
    const ns = camNames(c).filter(specificRoad);
    if (ns.length) return ns.some((n) => isExpwyName(n) || (rn && sameRoad(rn, n)));
    return c[2] > 70;
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
  function alertRange(c) { return isUserSpot(c) ? (c[8] === 1 ? 1000 : 500) : c[8] === 1 ? 3000 : c[2] >= 80 ? 1000 : 400; }
  function voiceRange(c) { return c[8] === 1 ? 2000 : alertRange(c); }
  const CAM_SCAN = 3000; // 가장 긴 경고 거리

  // 반대편 차로 카메라 거르기: 한국은 우측통행이라 내 방향을 찍는 카메라는 오른쪽 길가(또는 머리 위)에 선다.
  // 한 방향만 찍는 카메라(데이터의 도로노선방향 상행/하행)가 내 진행 방향 왼쪽으로 이만큼 넘게 떨어져 있으면
  // 반대편 차로용으로 본다.
  const OPP_SIDE = 8;
  const oneDir = (c) => c[9] === 1 || c[9] === 2;
  // ---- v123 단속 카메라 판정 (2026-11-15 밤 '하나하나 보지말고 전체적 개편이 필요해') ----
  // 카메라마다 찍는 진행 방향(c.eb, 0~359°, 모르면 -1. c.e2 = 1 이면 양방향)과 그 차로 위 점(c.sl, c.sg)을
  // tools/osm_cams.py 가 OSM 도로망에 붙여 정해 둔다 (우측통행이라 카메라는 자기가 찍는 차로의 오른쪽 길가에 선다.
  // 원본 설치장소 'A→B' 와 확인: 미키주유소앞(장애인복지관→서부경찰서) 남행, 장애인복지관 앞(서부경찰서→풍덕천) 북행 등).
  // 그래서 판정은 한 규칙:
  //   그 차로 위 점이 내 경로선(길안내) 또는 예측한 앞길(길안내 없음) 옆 CAM_TOL 안이고, 찍는 방향이 그 자리 내 진행 방향과
  //   CAM_DIR_TOL 안이면 내 카메라. 지하차도·고가로 교차로를 넘어가는 곳의 지상 카메라는 뺀다(camLevelOk).
  // 없앤 것: 한 방향 8m·양방향 10m 왼쪽 규칙, 넓은 길 40m·같은 이름 45m 허용, 11-14 '교차로는 양방향' 변환.
  // 허용 거리 40m → 15m (요청 '신호 25m만 더 오차범위 줄이고'. 경로선과 카메라 차로 위 점 사이 거리)
  const CAM_TOL = 15, CAM_DIR_TOL = 50;
  const camPt = (c) => ({ lat: c.sl != null ? c.sl : c[0], lng: c.sg != null ? c.sg : c[1] });
  const camHasDir = (c) => c.eb != null && c.eb >= 0 && !c.e2;
  const camDirOk = (c, brg) => !camHasDir(c) || brg == null || angleDiff(c.eb, brg) <= CAM_DIR_TOL;
  // 층(c.lv): 1 지하차도 안, 2 고가 위, 4 지상 카메라 옆을 지하차도가 지나감, 8 고가가 지나감, 16 지하차도·고가 카메라 옆에 지상 길.
  // 경로가 그 자리에서 지하차도·고가로 들어가면(네이버 진입 안내) 지상 카메라(4·8)는 빼고, 지상으로 가면 지하·고가 카메라(16)는 뺀다
  // 경로 거리 s0 → s1 사이의 진행 방향
  function routeBearingAt(s0, s1) {
    const pa = routePointAt(Math.max(0, s0)), pb = routePointAt(Math.min(nav.total, s1));
    return pa && pb && haversine(pa, pb) > 3 ? bearing(pa, pb) : null;
  }
  function camLevelOk(c, at, rn, hw) {
    const lv = c.lv | 0;
    if (!(lv & 28)) return true;
    const sep = gradeSepNear(at);
    if ((lv & 12) && sep) return false;
    // v165 (2026-11-20 전 카메라 가상 주행: 고가·지하 카메라 63대가 길안내 중에 모두 빠졌다 — 수도권1순환·평택시흥·내부순환로·강변북로 구간단속 등).
    // 네이버는 고속도로·도시고속도로 본선에서 고가·지하차도 안내를 주지 않는다. 경로 구간이 빠른 길이거나 카메라 길 이름이 구간과 같으면 남긴다
    if ((lv & 16) && !sep) return !!hw || (!!rn && (isFastRoad(rn) || sameCamRoad(rn, c)));
    return true;
  }
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

  // 길안내 경로를 카메라 판단에 믿고 써도 되는지: 경로 위이거나, 벗어난 지 2.5초가 안 됐을 때
  const ROUTE_OFF_MS = 2500;
  function routeTrusted() {
    if (!(nav.active && nav.pts)) return false;
    if (nav.onRoute) return true;
    const t = state.fix ? state.fix.t : Date.now();
    return !!nav.offAt && t - nav.offAt < ROUTE_OFF_MS;
  }
  // 내가 달리는 도로의, 진행 방향 앞에 있는 카메라인지
  function isAhead(f, c, d, keep) { // keep: 이미 경고 중인 카메라를 계속 둘지 볼 때 (조금 느슨하게)
    if (!camWanted(c)) return false;
    // 길안내 중에는 안내하는 경로 위의 카메라만 (잠깐 경로를 벗어나도 다른 길 카메라는 알리지 않는다).
    // v161 (2026-11-20 점검): 경로를 2.5초 넘게 벗어나 있으면(다른 길로 듦·재탐색 실패·재탐색 대기) 경로 위치가 멈춰 있어
    // 실제로 달리는 길의 카메라를 하나도 못 알렸다 — 그때는 길안내가 없을 때처럼 진행 방향 앞에서 고른다
    if (nav.active && nav.pts && routeTrusted()) {
      if (camOnRouteAhead(c)) return true;
      // v165 (2차 점검): 다시 찾은 경로는 차보다 최대 60m 앞에서 시작한다 — 그 사이 카메라는 새 경로에도 없으니 진행 방향으로 본다
      return !!nav.rerouted && nav.along < 80 && freeAhead(f, c, keep);
    }
    return freeAhead(f, c, keep);
  }
  // 길안내 없이: 진행 방향 앞(굽은 길이면 휘는 대로 예측한 앞길)의 내 도로 카메라
  function freeAhead(f, c, keep) {
    if (state.heading === null) return false;
    // v123: 카메라 차로 위 점이 예측한 앞길 옆 15m 안(멀수록 방향 오차만큼 조금 더)이고, 찍는 방향이 그 앞길 방향과 50° 안
    const p = camPt(c), dp = haversine(f, p), pb = pathBearing(dp);
    const dif = angleDiff(bearing(f, p), pb);
    if (dif > 60 && dp > 40) return false;
    // v165 (2차 점검 D): 옆 허용폭은 거리의 2%(유지 3%)만큼 넓히되 40m 까지 (3km 에서 75m 까지 넓어져 81m 옆 경부 '구간단속 끝'이 깜빡였다.
    // 15m 까지로 줄이면 굽은 고속도로에서 구간 시작을 638m 앞에서야 잡았다 — S27)
    const side = dp * Math.sin(toRad(Math.min(dif, 90)));
    if (side > CAM_TOL + Math.min(40, dp * (keep ? 0.03 : 0.02))) return false;
    // (지금 달리는 도로 이름으로 거르기는 하지 않는다: 고속도로 위에서도 역지오코딩이 옆 일반도로 이름을 주곤 해서, 굽은 고속도로의
    //  구간단속 시작을 638m 앞에서야 잡았다 — S27. 경찰 표기도 역지오코딩과 자주 다르다)
    // 고속도로 본선(시속 60 넘게)을 달리는 중이면 고속도로 카메라가 아닌 것(앞길에서 6m 넘게 비켜난 것)은 뺀다 (수도권1순환 위에서 밑 문정로 어린이 30)
    if (isExpwyName(road.name) && state.speedKmh >= 60 && side > 6 && !camOnExpwy(c, road.name)) return false;
    // v165 (2차 점검 G): 굽은 길은 그 자리의 진행 방향(현 방향 + 거리 × 곡률)으로도 본다 (100° 넘게 돈 고리 길 뒤의 카메라가 버려졌다)
    return camDirOk(c, pb) || camDirOk(c, pathTangent(dp));
  }
  function pathTangent(d) {
    if (state.heading === null) return null;
    const k = curv.k;
    if (!k || d > 800) return state.heading;
    return (state.heading + Math.max(-180, Math.min(180, toDeg(k * d))) + 360) % 360;
  }
  // 경로 선분 i 위의 카메라인지 보고, 맞으면 경로 위 거리(m)를 돌려준다 (v123 규칙: 위 CAM_TOL·CAM_DIR_TOL·camLevelOk).
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
    // 방면('Y, Z')은 가는 곳이지만, 지나온 안내 중에서는 바로 앞 것(지금 달리는 길을 정한 안내)의 방면만 쓴다.
    // (v120, 2026-11-15 보정동→성남: 3km 전 ''성남, 용인시청' 방면 좌회전'의 '용인시청' 때문에 분당수서로 '용인→분당경찰서' 80 카메라를
    //  반대 방향으로 보고 뺐다. 그 뒤 경기고속삼거리에서 ''수서, 금곡동' 방면'으로 이미 방향을 틀었다)
    let behind = '', ahead = '', lastDirs = '';
    for (const g of nav.guides) {
      const s = nav.cum[Math.min(g.i, last)];
      if (s < at - ARROW_SPAN || s > at + ARROW_SPAN) continue;
      const gp = guideParts(g);
      if (s < at - 30) { behind += '|' + gp.loc; lastDirs = gp.dirs; continue; }
      if (s > at + 30) ahead += '|' + gp.loc;
      ahead += '|' + gp.dirs;
    }
    ahead += '|' + lastDirs;
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
    if (start !== null) {
      // v165 (2026-11-20 2차 점검 H): 진입 안내만 있고 출구 안내가 없으면(경부→한남대교, 서해안→서부간선처럼 이어지는 곳) 목적지까지 고속도로로 봐서
      // 그 뒤 일반도로 카메라가 모두 빠졌다. 경로 구간 이름이 고속도로가 아닌 구체적인 도로 이름으로 바뀌는 곳에서 끝낸다
      let end = nav.total;
      for (const sec of (nav.route && nav.route.sections) || []) {
        const s0 = nav.cum[Math.min(sec.i, last)];
        if (s0 <= start + 50) continue;
        if (specificRoad(sec.name) && !isExpwyName(sec.name)) { end = s0; break; }
      }
      spans.push([start, end]);
    }
    nav.hwSpans = spans; nav.hwSpansFor = nav.route;
    return spans;
  }
  const onHighwayAt = (at) => highwaySpans().some(([a, b]) => at >= a && at <= b);
  // 경로 거리 at 앞에서 마지막 고속도로 진입·출구 안내가 출구(OUT)인지. v157 (2026-11-17 14:01 송파IC 진출램프 끝 유턴):
  // 네이버 경로는 출구 연결로 끝(유턴 지점)까지 구간 이름을 '수도권제1순환고속도로'로 준다. 그래서 램프 끝 신호·과속 30 카메라
  // ('송파IC 진출램프')가 '고속도로 위 저속 카메라'로 빠지고, 유턴 뒤 위례중앙로 50 만 떴다. 출구 안내를 지났으면 이름만으로 고속도로라 하지 않는다
  function pastHwExit(at) {
    if (nav.hwEvFor !== nav.route || !nav.hwEv) {
      const ev = [], last = nav.cum.length - 1;
      for (const g of nav.guides || []) if (HW_IN.has(g.t) || HW_OUT.has(g.t)) ev.push([nav.cum[Math.min(g.i, last)], HW_OUT.has(g.t)]);
      nav.hwEv = ev; nav.hwEvFor = nav.route;
    }
    let out = false;
    for (const [s, o] of nav.hwEv) { if (s > at) break; out = o; }
    return out;
  }
  function camAtSeg(c, i) {
    const p = camPt(c), a = nav.pts[i], b = nav.pts[i + 1];
    let pr = projectSeg(p, a, b);
    const rn = routeRoadAt(i);
    // 카메라 차로 위 점이 경로선 옆 15m 안. v165 (2026-11-20 2차 점검 B): 원래 좌표가 15m 안이거나(v138 에서 정지선으로 옮긴 신호 카메라:
    // 용구대로 60 #20115 원래 3.3m·차로 위 점 18.8m), 도로 이름이 같으면 20m 까지(송파대로 북행 가락시장역 50 #23719, 18.2m).
    // 25m 는 여전히 뺀다(2026-11-15 요청 '오차범위 줄이고', S14). 경로 위 자리는 그대로 차로 위 점(정지선)으로 잰다
    let near = pr.dist;
    if (pr.dist > CAM_TOL) {
      const raw = projectSeg({ lat: c[0], lng: c[1] }, a, b);
      if (raw.dist <= CAM_TOL) near = raw.dist;
      else if (!(pr.dist <= 20 && sameCamRoad(rn, c)) && !(c.fixRoute && Math.min(pr.dist, raw.dist) <= 40)) return null;   // v171: 고친 카메라는 40m
    }
    if (c.fixRoute) return nav.cum[i] + pr.t * (nav.cum[i + 1] - nav.cum[i]);   // v171: '놓침' 진단으로 경로 위로 보게 한 카메라 (이름·고속도로·높이 거르기 없이)
    if (near > 6 && camRoadDiffers(rn, c)) return null;
    const at = nav.cum[i] + pr.t * (nav.cum[i + 1] - nav.cum[i]);
    // 고속도로 구간이면 옆·아래 일반도로 카메라는 뺀다. 구간 이름이 고속국도이거나, 이름이 없어도 안내상 고속도로 진입~출구 사이면 고속도로
    // ('분당수서고속화도로'·'갑천도시고속도로' 같은 고속화·도시고속도로는 고속도로가 아니다).
    // v165 (2차 점검 A·H): 예전엔 '제한 70 이하이고 고속국도 아님'으로 빼서, 도로 종류를 글자로 정한 고속도로 박스형 57곳(제한 0·50·60·70)과
    // 고속도로 연결로의 70 이 빠졌다. 이제 카메라 도로(경찰 이름·OSM 이름)가 고속도로이거나 경로 구간과 같은 길이면 남기고, 이름을 모를 때만 예전 규칙
    const hwHere = (isExpwyName(rn) && !pastHwExit(at)) || onHighwayAt(at);
    if (hwHere && !camOnExpwy(c, rn)) return null;
    // v167 (v165 가상 주행: 경로 구간 이름이 비면 고가·지하 카메라 67대가 여전히 빠졌다 — 네이버 경로에 구간 이름이 빠지는 일이 있다, S52 거여동):
    // 구간 이름이 없으면 카메라가 빠른 길(이름이 고속·순환로·간선이거나 제한 80 이상) 위에 있고 경로와 나란하면(20° 안) 남긴다
    const fastCam = !specificRoad(rn) && camHasDir(c) && angleDiff(c.eb, bearing(a, b)) <= 20 && (camNames(c).some(isFastRoad) || c[2] >= 80);
    if (!camLevelOk(c, at, rn, hwHere || fastCam)) return null;                // 지하차도·고가로 넘어가는 곳의 지상 카메라 등
    // 찍는 방향이 이 자리 경로 방향과 50° 안. 교차로에서 꺾는 곳이면 들어오는 쪽(30m 전)·나가는 쪽(30m 뒤) 방향도 본다
    // (가락시장역교차로에서 좌회전: 들어오는 송파대로 북행 카메라). 설치장소 'A→B' 가 안내 문구로 갈리면 그게 먼저:
    // 반대면 빼고, 내 방향이라고 나오면 기하 판단과 달라도 알린다 (2026-11-14 하남 창우로 J2735, 11-15 가천대역 '복정역→성남시청')
    const arrow = cams.arrows && cams.arrows.has(c) ? arrowSays(c, at) : 0;
    if (arrow < 0) return null;
    if (arrow <= 0 && !camDirOk(c, bearing(a, b)) && !camDirOk(c, routeBearingAt(at - 30, at)) && !camDirOk(c, routeBearingAt(at, at + 30))) return null;
    return at;
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
      for (const it of camsNear((a.lat + b.lat) / 2, (a.lng + b.lng) / 2, half + CAM_TOL + 70)) {   // 차로 위 점은 원래 좌표에서 65m 안 (v138: 신호 카메라는 접근로 정지선으로 옮겨 최대 63m)
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
    if (added) { list.sort((x, y) => x.at - y.at); pruneTurnCams(); }
    return true;
  }
  // v157 (2026-11-17 14:01 운전자 '여기는 유턴 구간이기 때문에 30으로 봐야 해', 송파IC 진출램프 끝 유턴 → 위례중앙로):
  // 경로가 꺾는(유턴·좌회전·우회전) 교차로에 제한속도가 다른 카메라가 함께 걸리면, 들어가는 쪽(내 접근로)을 찍는 카메라만 남긴다.
  // 꺾어 들어간 길의 신호 카메라는 그 길로 곧장 오는 차를 그 정지선에서 찍는다 (네이버도 램프 30 만 보여 준다).
  // 꺾은 지점 60m 전 ~ 40m 뒤의 카메라 중, 찍는 방향이 들어오는 방향(꺾기 40m 전~3m 전)과 맞는 것이 있으면
  // 꺾은 뒤 방향만 맞는 신호 카메라(제한속도가 그것들과 다른 것)를 경로 위 목록에서 뺀다. 접근로 카메라가 없으면 그대로 둔다
  const TURN_CAM_KINDS = new Set(['u', 'l', 'r', 'sl', 'sr', 'sharp_l', 'sharp_r']);
  function pruneTurnCams() {
    const list = nav.routeCamList, m = nav.routeCams, last = nav.cum.length - 1;
    for (const g of nav.guides || []) {
      if (!TURN_CAM_KINDS.has(turnKind0(g))) continue;
      const T = nav.cum[Math.min(g.i, last)];
      const near = list.filter((x) => x.at >= T - 60 && x.at <= T + 40 && camWanted(x.c));
      if (near.length < 2) continue;
      const inB = routeBearingAt(T - 40, T - 3), outB = routeBearingAt(T + 3, T + 40);
      if (inB === null || outB === null) continue;
      // v165: 접근로 카메라는 경로선 6m 안이거나 접근로 구간과 같은 길이어야 한다 (2026-11-20 카메라 자료 세션: 위례중앙로 50 이 두 행으로
      // 갈리자 서행 쪽 행이 램프 30 의 '접근로 카메라'로 잡혀 꺾어 들어갈 길의 동행 50 이 남았다)
      const apprRoad = routeRoadAt(Math.max(0, routeSegAt(T - 25)));
      // 이름을 알면 이름으로(서행 위례중앙로 50 은 경로선에서 6m 였지만 접근로는 수도권제1순환 램프다), 모르면 경로선 6m 안
      const onAppr = (x) => (specificRoad(apprRoad) && camNames(x.c).some(specificRoad) ? sameCamRoad(apprRoad, x.c)
        : haversine(camPt(x.c), routePointAt(x.at)) <= 6);
      const appr = near.filter((x) => camHasDir(x.c) && x.at <= T + 5 && angleDiff(x.c.eb, inB) <= CAM_DIR_TOL && onAppr(x));
      if (!appr.length) continue;
      const drop = (x) => {
        list.splice(list.indexOf(x), 1);
        const arr = (m.get(x.c) || []).filter((v) => v !== x.at);
        if (arr.length) m.set(x.c, arr); else m.delete(x.c);
        nav.turnCamDrops = (nav.turnCamDrops || 0) + 1;
      };
      for (const x of near.slice()) {
        if (!isSignalCam(x.c) || !camHasDir(x.c) || x.c[6] || appr.includes(x)) continue;
        if (appr.some((a) => a.c[2] === x.c[2])) continue;          // 제한속도가 같으면 그대로 (헷갈릴 일이 없다)
        // v167: 같은 교차로의 다른 진입로 정지선 카메라 — 내 접근 방향과 같은 쪽을 찍지만 길 이름이 접근로와 다르면(램프로 들어가는데
        // 위례중앙로 서행 50) 뺀다. 차로 위 점으로 같이 지남을 재게 되자 램프 30 을 지난 뒤 이 50 이 마지막 13m 떴다 (네이버는 30 만)
        if (x.at >= T - 60 && x.at <= T + 5 && angleDiff(x.c.eb, inB) <= CAM_DIR_TOL && specificRoad(apprRoad) &&
            camNames(x.c).some(specificRoad) && !sameCamRoad(apprRoad, x.c)) { drop(x); continue; }
        // v165 (2차 점검 E): 예전엔 회전 15m 앞 ~ 40m 뒤의 꺾은 뒤 방향 신호 카메라를 모두 뺐다 — 우회전 뒤 35m 다음 교차로 정지선의
        // 어린이 30 까지 빠졌다. 이제 꺾는 교차로 안만 뺀다: 좌·우회전은 회전점 15m 앞 ~ 25m 뒤, 유턴은 교차로가 넓어 45m 뒤까지
        // (송파IC 램프 끝 유턴: 건너편 위례중앙로 동행 50 이 회전점 뒤 20~40m). 어린이·노인 보호구역 카메라는 빼지 않는다
        const after = turnKind0(g) === 'u' ? 45 : 25;
        if (x.at < T - 15 || x.at > T + after) continue;
        if (angleDiff(x.c.eb, inB) <= CAM_DIR_TOL || angleDiff(x.c.eb, outB) > CAM_DIR_TOL) continue;
        drop(x);
      }
    }
  }
  // 길안내 중: 카메라가 남은 경로 위(경고 거리 안)에 있는지
  function camOnRouteAhead(c) {
    if (!ensureRouteCams()) return false;
    const arr = nav.routeCams.get(c);
    return !!arr && arr.some((at) => at > nav.along - 5 && at < nav.along + CAM_SCAN + 300);
  }

  // 카메라를 지나갔다: 같은 자리(60m 안)의 다른 행도 함께 지나간 것으로 처리한다.
  // v161 (2026-11-20 점검): 예전엔 60m 안의 행을 방향·제한속도와 상관없이 모두 지남으로 쳐서, 같은 방향으로 3~60m 뒤에 있는
  // 카메라(전국 1,067쌍)를 못 알렸다 — 북한강로 50 뒤 5m 어린이 30, 지점 카메라 바로 뒤 구간단속 시작(9곳)·구간 끝이 곧 다음 구간 시작(15곳).
  // 이제 진행 방향으로 이 카메라 자리(+3m)까지와 뒤쪽 행, 그리고 반대 방향 행(구간 시점·종점 쌍)만 지남으로 친다.
  // 길안내 경로가 나중에 돌아와 지나갈 반대 방향 행(유턴·고리)은 지남으로 치지 않는다
  function passCam(tg, f, now) {
    clearTimeout(camState.sigT); camState.sigT = null;
    const h = state.heading, cp = camPt(tg.c), same = [tg];
    let oppEnd = false;
    for (const x of camsNear(tg.c[0], tg.c[1], 60)) {
      if (x.i === tg.i) continue;
      const opp = camHasDir(x.c) && h !== null && angleDiff(x.c.eb, h) > 90;
      // v165 (2026-11-20 2차 점검: 반대 방향 짝 3,967개가 120초 동안 지남으로 처리돼 유턴해 돌아오면 놓쳤다): 반대 방향 행은 지남으로 치지 않는다
      // (방향을 아는 반대 방향 카메라는 어차피 방향으로 걸러진다)
      if (opp) { if (x.c[4] === 2) oppEnd = true; continue; }
      // v167 (2026-11-20 v165 가상 주행): 앞뒤·같은 자리는 차로 위 점(신호 카메라는 정지선)으로 잰다. 원래 좌표로 재면
      // 보개원삼로 50 은 정지선이 51m 앞인 신호 카메라와 '같은 기둥'(13m)으로 묶여 카드가 일찍 사라졌고,
      // 복합물류로 50·60 은 원래 좌표가 38m 떨어졌지만 차로 위 점이 같아 50 을 지나자 60 이 떴다
      const xp = camPt(x.c), ld = haversine(cp, xp);
      const along = h === null || ld < 1 ? 0 : ld * Math.cos(toRad(angleDiff(bearing(cp, xp), h)));
      // 이 카메라보다 앞(진행 방향)에 있으면 아직 안 지났다. 같은 자리(차로 위 점 12m 안, 같은 방향)의 행은 함께 지난다
      if (along > 3 && ld > 12) continue;
      camState.passed.set(x.i, now);
      same.push(x);
    }
    camState.passed.set(tg.i, now);
    // 구간: 끝을 지나면 닫고, 같은 자리에 내 방향 시작이 있으면(앞 구간 끝 = 다음 구간 시작) 이어서 연다.
    // 연 지 500m 안에 지나는 끝 카메라는 앞 구간의 끝이다(구리포천→세종포천: 다음 구간 시작이 앞 구간 끝보다 56m 먼저 온다)
    const start = same.find((x) => x.c[4] === 1 && (x === tg || camHasDir(x.c)));
    const sec = camState.section, secDone = sec ? state.odo - sec.d0 : 0;
    if (sec && secDone >= 500 && (same.some((x) => x.c[4] === 2) || (oppEnd && !start))) endSection(!!start);
    if (start) startSection(start.c, f);
    tg.after = true; // 카메라 좌표 오차를 감안해 지나간 뒤 CAM_HOLD m (후면 단속은 REAR_HOLD m, 신호는 0) 까지 경고를 유지한다
  }
  // 경로 거리 s 가 놓인 선분 번호
  function routeSegAt(s) {
    const C = nav.cum;
    if (!C || C.length < 2) return 0;
    let lo = 0, hi = C.length - 1;
    s = Math.max(0, Math.min(s, C[hi]));
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (C[m] <= s) lo = m; else hi = m; }
    return lo;
  }
  // 남은 길안내 경로에서 이 카메라의 가장 가까운 앞 위치(경로 거리, m). 경로를 못 믿거나 경로 위가 아니면 null
  function camRouteAt(c) {
    if (!(nav.active && nav.routeCams && routeTrusted())) return null;
    const arr = nav.routeCams.get(c);
    if (!arr) return null;
    let best = null;
    for (const x of arr) if (x >= nav.along - 5 && (best === null || x < best)) best = x;
    return best;
  }
  // v161: 카메라까지 거리는 한 가지로 잰다 — 길안내 경로 위면 경로를 따라 카메라 자리(차로 위 점의 경로 투영)까지, 아니면 차로 위 점까지 직선.
  // (예전엔 경고 중인 카메라는 차로 위 점, 새 후보는 원래 좌표로 재서 30m 넘게 다른 행 5,221개에서 순서가 엇갈렸다)
  // v137: 굽은 길은 경로 거리가 직선보다 길다(판교→성남TG 구간단속 끝: 경로 2.6km, 직선 2.2km). 직선의 1.6배 + 300m 안일 때만 경로 거리
  // (그보다 멀면 경로가 한참 돌아 나중에 지나가는 자리다: 유턴·고리 경로의 반대 차로 카메라)
  function camDist(f, c) {
    const d = haversine(f, camPt(c)), at = camRouteAt(c);
    if (at !== null) {
      const r = Math.max(0, at - nav.along);
      return r < d * 1.6 + 300 ? r : Infinity;
    }
    return d;
  }
  // v163 (2026-11-20 점검 8): 터널 안에서는 GPS 가 끊겨 카메라를 못 알렸다(터널 안 카메라 58대 중 12대가 경고 거리보다 깊다:
  // 녹사평대로 50 1.6km, 강남순환로 80 4.9km, 영동 100 3.2km). 길안내 경로에서 터널 안 카메라는 터널 입구 300m 앞부터 알리고,
  // 터널 안에서 위치가 안 오면 마지막 속도로 경로를 따라 나아간 자리로 거리·지남을 잰다
  // 경로 위 at 자리를 덮는 터널 구간 { s0, s1 } (60m 안으로 이어진 터널 토막은 하나로 합친다: 긴 터널은 OSM 길이 여러 토막이다)
  function routeTunnelAt(at) {
    if (typeof tunnels === 'undefined' || !(nav.active && nav.pts) || !ensureRouteTunnels()) return null;   // (점검 도구처럼 터널 자료가 없는 곳)
    const list = nav.routeTunnels.slice().sort((x, y) => x.s0 - y.s0);
    let cur = null;
    for (const t of list) {
      if (cur && t.s0 <= cur.s1 + 60) { cur.s1 = Math.max(cur.s1, t.s1); continue; }
      if (cur && at >= cur.s0 - 1 && at <= cur.s1 + 1) return cur;
      cur = { s0: t.s0, s1: t.s1, name: t.name };
    }
    return cur && at >= cur.s0 - 1 && at <= cur.s1 + 1 ? cur : null;
  }
  function camRange(c, r) {
    const base = alertRange(c);
    if (!Number.isFinite(r) || !routeTrusted()) return base;
    const at = nav.along + r, tn = routeTunnelAt(at);
    return tn && at - tn.s0 > base - 300 ? Math.max(base, at - tn.s0 + 300) : base;
  }
  // 경고 카드의 거리 (v123)
  function camShownDist(tg) { return tg.r != null && Number.isFinite(tg.r) ? tg.r : tg.d; }
  // 길안내 경로를 따라 이 카메라를 지난 거리(m, 앞이면 음수). 가장 가까운 경로 위 자리가 200m 안일 때만, 아니면 null
  function routePast(c) {
    if (!(nav.active && nav.routeCams && routeTrusted())) return null;
    const arr = nav.routeCams.get(c);
    if (!arr) return null;
    let at = null;
    for (const x of arr) if (at === null || Math.abs(x - nav.along) < Math.abs(at - nav.along)) at = x;
    return at !== null && Math.abs(at - nav.along) < 200 ? nav.along - at : null;
  }
  // 순위용 제한속도: 속도를 재는 카메라의 제한속도, 모르거나 신호 전용이면 999
  const camEffLimit = (c) => (isSpeedCam(c) && c[2] > 0 ? c[2] : 999);
  const CAM_LOWER_AHEAD = 300;
  // 후보 중 경고 칸에 올릴 카메라: 가장 가까운 것. 다만 그것이 속도 카메라이고 300m 안쪽 뒤에 제한속도가 더 낮은 속도 카메라가 있으면
  // 그중 가장 낮은 것(같으면 보호구역, 그다음 가까운 것)
  function pickCam(cand) {
    let near = null;
    for (const x of cand) if (Number.isFinite(x.r) && (!near || x.r < near.r)) near = x;
    if (!near || camEffLimit(near.c) === 999) return near;
    let best = near;
    for (const x of cand) {
      if (!Number.isFinite(x.r) || x.r > near.r + CAM_LOWER_AHEAD || camEffLimit(x.c) === 999) continue;
      const a = camEffLimit(x.c), b = camEffLimit(best.c);
      if (a < b || (a === b && (x.c[6] | 0) > (best.c[6] | 0) && Math.abs(x.r - best.r) < 30)) best = x;
    }
    return best;
  }
  // v123 (2026-11-15 밤 요청: 운전 중 사진 대신 한 번 눌러 신고): '틀림'·'놓침' 버튼
  const MISS_SENT_MS = 2500;
  // v161 (2026-11-20 점검 + 운전자 '틀림이 속도가 틀린걸수도 있음'): '틀림' 한 번에 카메라를 영원히 숨기지 않는다.
  //  - 한 번 누르면 14일 동안 '의심': 카드는 흐리게 남기고 제한속도는 '?', 음성·경고음은 끈다(카메라가 있다는 건 계속 보인다)
  //  - 서로 다른 날 두 번 넘게 누른 카메라만 숨긴다(설정에서 되돌릴 수 있음). 구간단속·어린이·노인 보호구역 카메라는 숨기지 않는다
  //  - 진행 방향 ±45° 안에서만 (방향을 모르고 누른 것은 모든 방향)
  // 저장: tnc.camNo2 = [[key, 방향|null, 처음 누른 시각, 마지막 시각, [날짜…], 제한속도, 이름], …]. 예전 tnc.camNo(영원히 숨김)는 오늘부터 14일 의심으로 옮긴다
  const CAM_DOUBT_MS = 14 * 86400e3;
  const camNoMap = new Map();   // '위도,경도' → [{ h, t0, t1, days: [...], lim, name }]
  const dayStr = (t) => { const d = new Date(t); return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate(); };
  try {
    for (const [k, h, t0, t1, days, lim, name] of JSON.parse(store.get('camNo2') || '[]')) {
      if (!camNoMap.has(k)) camNoMap.set(k, []);
      camNoMap.get(k).push({ h: h == null ? null : h, t0: t0 || Date.now(), t1: t1 || t0 || Date.now(), days: Array.isArray(days) ? days : [], lim: lim || 0, name: name || '' });
    }
    const oldRaw = store.get('camNo');
    if (oldRaw !== null) {
      const old = JSON.parse(oldRaw || '[]'), now = Date.now();
      for (const [k, h] of old) {
        if (!camNoMap.has(k)) camNoMap.set(k, []);
        camNoMap.get(k).push({ h: h == null ? null : h, t0: now, t1: now, days: [dayStr(now)], lim: 0, name: '' });
      }
      store.set('camNo', null);
      if (old.length) saveCamNo();
    }
  } catch (e) { /* 없음 */ }
  // 이 카메라를 이 방향에서 어떻게 보는지: null(그대로) · 'doubt'(의심: 흐리게·소리 없음·제한속도 ?) · 'hide'(숨김)
  function camFlag(c, h, now) {
    const a = camNoMap.get(c[0] + ',' + c[1]);
    if (!a) return null;
    const t = now || Date.now();
    let st = null;
    for (const e of a) {
      if (e.h !== null && h !== null && h !== undefined && angleDiff(e.h, h) > 45) continue;
      if (e.days.length >= 2) st = 'hide';
      else if (t - e.t1 < CAM_DOUBT_MS && st !== 'hide') st = 'doubt';
    }
    if (st === 'hide' && (c[4] || c[6])) st = 'doubt';   // 구간단속·보호구역은 숨기지 않는다
    return st;
  }
  function camUserNo(c, h) { return camFlag(c, h) === 'hide'; }
  function camFlagAdd(c, h, now) {
    const k = c[0] + ',' + c[1], t = now || Date.now(), day = dayStr(t);
    if (!camNoMap.has(k)) camNoMap.set(k, []);
    const a = camNoMap.get(k);
    let e = a.find((x) => (x.h === null && h === null) || (x.h !== null && h !== null && angleDiff(x.h, h) <= 45));
    if (!e) { e = { h, t0: t, t1: t, days: [], lim: c[2] || 0, name: camLabel(c) }; a.push(e); }
    e.t1 = t;
    if (!e.days.includes(day)) e.days.push(day);
    saveCamNo();
    return camFlag(c, h, t);
  }
  function saveCamNo() {
    const list = [], now = Date.now();
    camNoMap.forEach((es, key) => {
      const keep = es.filter((e) => e.days.length >= 2 || now - e.t1 < CAM_DOUBT_MS);   // 14일 지난 의심은 지운다
      if (!keep.length) { camNoMap.delete(key); return; }
      camNoMap.set(key, keep);
      keep.forEach((e) => list.push([key, e.h, e.t0, e.t1, e.days.slice(-5), e.lim, e.name]));
    });
    store.set('camNo2', JSON.stringify(list.slice(-300)));
  }
  // v159: 자료를 고친 지점(mobile.json unflag: 제한속도·종류가 바뀐 자리)은 예전에 누른 '틀림'을 한 번 푼다.
  // 판교JC·송파IC 고속도로 부스가 옆 일반도로 값(60·50)이라 틀림을 눌렀고, 고친 뒤에도 숨어 있으면 그대로 놓친다 (2026-11-18 송파IC)
  function camNoUnflag(u) {
    if (!u || !u.id || !Array.isArray(u.keys) || store.get('camNoUnflag') === u.id) return 0;
    let n = 0;
    for (const k of u.keys) if (camNoMap.delete(k)) n++;
    if (n) saveCamNo();
    store.set('camNoUnflag', u.id);
    return n;
  }
  function userReport(kind, extra) {
    if (!prefs.share) return null;   // v172: 설정에서 '신고 위치 보내기'를 껐다 (이 차 안의 고침·표시는 그대로)
    const f = state.fix, t0 = f ? f.t : Date.now(), tg = camState.target;
    const near = f ? camsNear(f.lat, f.lng, 400).sort((x, y) => x.d - y.d).slice(0, 12)
      .map((it) => ({ i: it.i, lat: it.c[0], lng: it.c[1], lim: it.c[2], kind: it.c[3], eb: it.c.eb, d: Math.round(it.d) })) : [];
    return reportSure('warn', Object.assign({
      msg: 'user ' + kind + (tg ? ' camera ' + tg.i : '') + ' @' + Math.round(t0 / 1000), user: kind,
      cam: tg ? tg.i : null, camEb: tg ? tg.c.eb : null, camLabel: tg ? camLabel(tg.c) : null, near, navOn: !!nav.active,
      heading: state.heading === null ? null : Math.round(state.heading),
      // v172: 궤적·속도는 운영자 차만 (공개 사용자는 카메라 후보 점과 진행 방향만 — 위치정보 최소 수집. 서버도 운영자 토큰 없는 궤적은 버린다)
      kmhNow: isOp() ? Math.round(state.speedKmh || 0) : undefined,
      trace: isOp() ? trace1.map((e) => [Math.round((e[0] - t0) / 1000)].concat(e.slice(1))) : undefined,
    }, extra || {}));
  }
  function passedChime() { chime(); logAlert('beep', '단속 통과 띠링'); }
  // 신호 카메라를 지난 거리(m, 아직 앞이면 음수). 길안내 중 경로 위면 경로를 따라 잰 거리, 아니면 진행 방향으로 잰 앞뒤 거리
  function camPast(f, tg, d) {
    if (nav.active && nav.onRoute && nav.routeCams) {
      const arr = nav.routeCams.get(tg.c);
      let at = null;
      if (arr) for (const x of arr) if (at === null || Math.abs(x - nav.along) < Math.abs(at - nav.along)) at = x;
      if (at !== null && Math.abs(at - nav.along) < 200) return nav.along - at;
    }
    if (state.heading === null) return null;
    return -d * Math.cos(toRad(angleDiff(bearing(f, camPt(tg.c)), state.heading)));
  }
  // 위치는 1초에 한 번 오므로(시속 60km 면 17m), 다음 위치가 오기 전에 신호 카메라를 2m 지날 거리면 그 시각에 경고를 내린다
  function sigPassSoon(tg, past) {
    clearTimeout(camState.sigT); camState.sigT = null;
    const v = state.speedKmh / 3.6;
    if (state.speedKmh < 20 || tg.c[4]) return;   // 천천히 다가가며 정지선에 설 수 있는 속도, 구간단속 카메라는 위치로만
    const ms = (SIGNAL_PAST - past) / v * 1000;
    if (!(ms > 0 && ms <= 1100)) return;
    camState.sigT = setTimeout(() => {
      camState.sigT = null;
      if (camState.target !== tg || tg.after || state.speedKmh < 20 || !prefs.cams) return;
      passCam(tg, state.fix, state.fix ? state.fix.t + ms : Date.now());
      camState.target = null;
      passedChime();
      renderCam();
    }, ms);
  }

  function evalCameras(f) {
    const now = f.t;
    camState.passed.forEach((t, i) => { if (now - t > 120000) camState.passed.delete(i); });
    camState.saidById.forEach((v, i) => { if (now - v.t > 180000) camState.saidById.delete(i); });
    if (!cams.loaded || !prefs.cams) { camState.target = null; camState.section = null; renderCam(); return; }
    const moving = state.speedKmh >= 8;
    let tg = camState.target;

    if (tg) {
      const cp = camPt(tg.c);
      const d = haversine(f, cp);
      tg.d = d;
      tg.r = camDist(f, tg.c);
      if (d < tg.minD) tg.minD = d;
      // 정지 중 GPS 흔들림을 '지나감'으로 오인하지 않도록, 움직이는 중이고 카메라가 뒤쪽에 있을 때만 인정
      const behind = state.heading === null || angleDiff(bearing(f, cp), state.heading) > 90;
      // v161: 길안내 경로 위면 경로를 따라 지난 거리로 판정한다(유턴·고리 경로에서 옆 차로 카메라 옆을 지나도 '지남'이 아니다)
      const rp = !tg.after ? routePast(tg.c) : null;
      const past = !tg.after && isSignalCam(tg.c) ? (rp !== null ? rp : camPast(f, tg, d)) : null;   // 신호 카메라를 지난 거리 (앞이면 음수)
      // v161: GPS 가 한 번 앞으로 튀어 신호 카메라를 '지난' 것으로 보이면(1초에 갈 수 있는 거리의 두 배 넘게 한꺼번에) 다음 위치로 한 번 더 확인
      const jump = past !== null && tg.lastPast != null && past - tg.lastPast > Math.max(40, state.speedKmh / 3.6 * 2);
      if (past !== null) tg.lastPast = past;
      const sigPass = past !== null && past >= SIGNAL_PAST && tg.minD < 80 && !jump;
      const routePass = rp !== null && !isSignalCam(tg.c) && rp >= 0 && tg.minD < 80;
      const geoPass = rp === null && tg.minD < 80 && d > tg.minD + 10 && behind;
      if (!tg.after && moving && (sigPass || routePass || geoPass)) {   // 카메라를 지나감
        passCam(tg, f, now);
      }
      if (tg.after) {
        const gone = routePast(tg.c);
        if ((gone !== null ? gone : d) >= camHold(tg.c)) { // 단속 지점을 다 지났다: 경고를 내리고 '띠링' 한 번
          camState.target = tg = null;
          passedChime();
        }
      } else if (Math.min(d, tg.r) > camRange(tg.c, tg.r) + 300) {
        camState.target = tg = null;
      } else if (moving && d > 150 && !isAhead(f, tg.c, d, true)) {
        // 방향을 틀어 벗어남. v161: 위치가 1초에 10번 오면 세 번이 0.3초라 카드가 깜빡였다 — 1.5초 넘게 벗어나 있으면 내린다
        if (!tg.missAt) tg.missAt = now;
        if (now - tg.missAt >= 1500) camState.target = tg = null;
      } else if (moving && d > 25 && d <= 150 && camHasDir(tg.c) && !nav.active && state.heading !== null &&
                 angleDiff(tg.c.eb, state.heading) > 120) {
        // 가까이 와서 보니 왼쪽(반대편 차로) 카메라였다: 길안내 없이 멀리서 방향만 보고 잡은 경우
        if (!tg.oppAt) tg.oppAt = now;
        if (now - tg.oppAt >= 800) camState.target = tg = null;
      } else {
        tg.missAt = 0; tg.oppAt = 0;
        if (past !== null && moving) sigPassSoon(tg, past);   // 다음 위치가 오기 전에 지나갈 거리면 그 시각에 끈다
      }
    }

    if (moving && (state.heading !== null || nav.active)) {
      // v161 (2026-11-20 점검): 경고 칸은 하나라 순서를 한 가지 거리(camDist)로 매긴다. 가장 가까운 카메라 뒤 300m 안에
      // 제한속도가 더 낮은 속도 카메라가 있으면 그것을 먼저 보여 준다(50 뒤 62m 의 30 이 29m 앞에서야 떴다 — #16985 → #16982).
      // 같은 자리 행이 여럿(대한로 80 과 어린이 30)이면 가장 낮은 제한속도. 지나간 뒤 남은 30m 동안에도 앞 카메라가 있으면 바로 넘긴다
      const cand = [];
      for (const it of camsNear(f.lat, f.lng, CAM_SCAN)) {
        if (camState.passed.has(it.i)) continue;
        if (tg && it.i === tg.i) { if (!tg.after) cand.push({ i: it.i, c: it.c, r: tg.r, d: tg.d }); continue; }
        if (camUserNo(it.c, state.heading)) continue;          // 사용자가 '틀림'으로 신고한 카메라 (이 방향)
        // 구간 끝 카메라는 구간 안에서만. v135 (2026-11-16 경부 상행 '구간단속 끝 110' 놓침: 수원신갈IC 로 구간 중간에 들어와 시작을 못 봄):
        // 찍는 방향을 아는 끝 카메라는 구간 밖이어도 그 지점 단속 카메라로 알린다 (끝 지점도 속도를 잰다. 반대 방향은 방향으로 걸러진다).
        // v161: 방향을 모르는 끝 카메라도 길안내 경로 위(15m 안)면 알린다
        if (it.c[4] === 2 && !camState.section && !camHasDir(it.c) && !routeTrusted()) continue;
        // 구간 안에서 시작 카메라: 방향을 모르면(반대 방향 시작일 수 있다) 무시, 내 방향이면 새 구간 (v161: 예전엔 모두 무시해 끝을 놓치면 옛 구간이 남았다)
        if (it.c[4] === 1 && camState.section && !camHasDir(it.c)) continue;
        // 연 지 500m 안의 구간 끝 카메라는 앞 구간의 끝이다: '구간단속 시작' 바로 뒤에 '구간단속 끝' 카드를 띄우지 않는다
        if (it.c[4] === 2 && camState.section && state.odo - camState.section.d0 < 500) continue;
        if (it.d > alertRange(it.c) + 400 && !(routeTrusted() && nav.routeCams && nav.routeCams.has(it.c))) continue;
        const r = camDist(f, it.c);
        if (r > camRange(it.c, r)) continue; // 도로 종류별 경고 거리 밖 (터널 안 카메라는 입구 300m 앞부터)
        if (!isAhead(f, it.c, it.d)) continue;
        cand.push({ i: it.i, c: it.c, r, d: haversine(f, camPt(it.c)) });
      }
      // 3km 보다 깊은 터널 안 카메라는 주변 찾기(3km)에 안 잡힌다: 경로 위 카메라 목록에서 더한다
      if (routeTrusted() && ensureRouteCams()) {
        for (const x of nav.routeCamList) {
          const r = x.at - nav.along;
          if (r < 0 || r > 6000) continue;
          if (r <= CAM_SCAN || cand.some((y) => y.i === x.i) || camState.passed.has(x.i) || (tg && x.i === tg.i)) continue;
          if (!camWanted(x.c) || camUserNo(x.c, state.heading) || !routeTunnelAt(x.at) || r > camRange(x.c, r)) continue;
          cand.push({ i: x.i, c: x.c, r, d: haversine(f, camPt(x.c)) });
        }
      }
      const want = pickCam(cand);
      const cur = tg && !tg.after ? cand.find((x) => x.i === tg.i) : null;
      let take = null;
      if (want && (!tg || tg.after)) take = want;
      else if (want && cur && want.i !== cur.i) {
        // 지금 것보다 30m 넘게 가깝거나, 제한속도가 더 낮으면 바꾼다 (둘 다 아니면 그대로: 비슷한 거리의 두 카메라 사이에서 오가지 않게)
        if (want.r < cur.r - 30 || camEffLimit(want.c) < camEffLimit(cur.c)) take = want;
      } else if (want && tg && !cur) take = want;
      if (take && (!tg || take.i !== tg.i)) {
        if (tg && tg.after) passedChime();   // 앞 카메라를 다 지나기 전에 다음 카메라로 넘긴다: '띠링'은 그대로
        // 굽은 길에서 잠깐 놓쳤다 다시 잡혀도 같은 안내를 반복하지 않게 이전 안내 기록을 이어 쓴다
        let rec = camState.saidById.get(take.i);
        if (!rec) { rec = { said: {}, t: now }; camState.saidById.set(take.i, rec); }
        rec.t = now;
        camState.target = tg = { i: take.i, c: take.c, d: take.d, r: take.r, minD: take.d, first: take.r, said: rec.said, at: now, flag: camFlag(take.c, state.heading, now) };
      }
    }

    const s = camState.section;
    if (s) {
      const done = state.odo - s.d0;
      // 끝 카메라를 못 지나간 것으로 보일 때의 안전장치. 길안내 경로에서 끝 카메라가 앞에 보이면 길이로 끝내지 않는다
      // (데이터의 구간 길이는 어림값이라 실제보다 짧을 수 있다)
      const routeKnows = sectionRemainRoute(s) !== null;
      // v161: 길이를 끝내 모르면 40km 를 넘게 가면 닫는다 (예전엔 45분까지 옛 구간 평균·제한속도가 남았다)
      if ((!routeKnows && (s.len ? done > s.len * 1.3 + 400 : done > 40000)) || now - s.t0 > 45 * 60000) endSection();
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
    if (tg.flag === 'doubt') return;   // v161: '틀림'으로 의심 표시한 카메라는 화면에만 (음성·경고음·과속 기록 없음)
    const c = tg.c, limit = c[2], d = camShownDist(tg);   // v161: 화면과 같은 거리(길안내 중이면 경로 거리)로 말하고 울린다
    // 단속 카메라 600m 앞부터 지나갈 때까지 제한을 넘으면 주행 기록에 (카메라마다 한 번, 가장 빨랐던 속도로)
    if (isSpeedCam(c) && limit > 0 && d < 600 && state.speedKmh > limit + 1) {
      const kmh = Math.round(state.speedKmh);
      if (!tg.said.evt) tg.said.evt = tripEvent({ kind: 'cam', label: camLabel(c), limit, kmh, lat: c[0], lng: c[1] });
      else if (kmh > tg.said.evt.kmh) { tg.said.evt.kmh = kmh; }
    }
    if (tg.after && !(limit > 0 && state.speedKmh > limit + 1 && isSpeedCam(c))) return;
    if (!isSpeedCam(c)) { // 신호 전용 카메라: 짧게 한 번만 알린다 (속도 경고 없음)
      if (!tg.said.far && d <= 300) { tg.said.far = true; say('300미터 앞, 신호 단속 카메라입니다.', 1); }
      return;
    }
    const far = voiceRange(c); // 고속도로 2km · 고속화도로 1km · 일반도로 400m
    if (!tg.said.far && d <= far + 30) {
      tg.said.far = true;
      // v161: 100m 안쪽에서 잡힌 카메라를 '100미터 앞'이라 하지 않고 실제 거리(10m 단위)로
      const dd = d >= 950 ? Math.round(d / 1000) + '킬로미터' : d >= 100 ? Math.round(d / 100) * 100 + '미터' : Math.max(10, Math.round(d / 10) * 10) + '미터';
      sayCam(tg, dd + ' 앞, ' + camSpoken(c) + (limit > 0 ? '. 제한속도 ' + limit + '입니다.' : '입니다.'), 2);
    }
    const over = limit > 0 && state.speedKmh > limit + 1;
    if (!tg.said.near && d <= 250) {
      tg.said.near = true;
      // v118 (2026-11-15 주행 중 요청 '속도초과 라는 나레이션 없애줘'): 과속이면 말 대신 높은 경고음 세 번 (빨간 카드·반복 경고음은 그대로)
      if (over) { beep(3, 1040); logAlert('beep', '제한 넘음 경고음 (카메라 250m 전, 음성 없음)'); }
      else { beep(1, 660); logAlert('beep', '카메라 250m 전 알림음'); }
    } else if (over && (tg.said.near || tg.after) && d <= 300 && f.t - camState.lastOverBeep >= 900) {
      // 과속 중에는 1초에 한 번, 짧게 한 번만 울린다 (GPS 가 1초에 한 번 오므로 900ms 로 둬서 한 번씩 빠지지 않게)
      camState.lastOverBeep = f.t;
      beep(1, 1040);
      logAlert('beep', '제한 넘음 반복 경고음 (' + Math.round(d) + 'm)');
    }
  }

  // v161 (2026-11-20 점검): 원본의 구간 길이(m)가 0 인 시작 카메라 98개, 1,000배 큰 것 35개(#2626 은 15,834km).
  // 1,000배는 km 를 m 로 한 번 더 곱한 것으로 보고 되돌리고, 300m~100km 밖이면 모름(0)으로 본다
  function secLen(c) {
    let L = c[5] || 0;
    if (L > 100000) L /= 1000;
    return L >= 300 && L <= 100000 ? L : 0;
  }
  // 길이를 모르면 앞쪽(진행 방향 45° 안) 40km 안의 같은 제한속도 구간 끝 카메라 중 가장 가까운 것까지 직선 거리 × 1.15
  function guessSecLen(c, f) {
    const h = state.heading;
    if (h === null || !f) return 0;
    let best = 0;
    for (const x of camsNear(f.lat, f.lng, 40000)) {
      if (x.c[4] !== 2 || x.c[2] !== c[2] || x.d < 500) continue;
      if (camHasDir(x.c) && angleDiff(x.c.eb, h) > 60) continue;
      if (angleDiff(bearing(f, { lat: x.c[0], lng: x.c[1] }), h) > 45) continue;
      if (!best || x.d < best) best = x.d;
    }
    return best ? best * 1.15 : 0;
  }
  function startSection(c, f) {
    // 앞 구간이 열려 있으면(끝을 못 지난 것으로 보이면) 조용히 닫고 새 구간을 연다
    if (camState.section) endSection(true);
    const len = secLen(c) || guessSecLen(c, f);
    camState.section = { limit: c[2], len, t0: f ? f.t : Date.now(), d0: state.odo };
    say('구간단속 시작. 제한속도 ' + c[2] + '.', 2);
  }
  function endSection(quiet) {
    const s = camState.section;
    if (!s) return;
    // 구간 평균이 제한을 넘었으면 주행 기록에 남긴다
    const st = sectionStats(s);
    if (st.over && st.avg !== null) {
      tripEvent({ kind: 'sec', label: '구간단속', limit: s.limit, kmh: Math.round(st.avg), km: Math.round(st.done / 100) / 10 });
    }
    camState.section = null;
    if (!quiet) say('구간단속이 끝났습니다.', 1);
  }

  function renderCam() {
    const tg = camState.target, card = $('#camCard');
    const pk = camState.peek, nxEl = $('#camNext');
    $('#camMissBtn').hidden = !prefs.cams || !(nav.active || state.speedKmh >= 5);   // v161: 카드가 떠 있어도 (앞 카메라를 알리는 사이 다른 걸 놓쳤을 수 있다)
    nxEl.hidden = !(pk && prefs.cams && !tg);
    if (!nxEl.hidden) {
      // 길안내 중이면 경로를 따라간 거리, 아니면 직선 거리
      const d = pk.at != null && nav.active ? Math.max(0, pk.at - nav.along)
        : state.fix ? haversine(state.fix, { lat: pk.c[0], lng: pk.c[1] }) : pk.d;
      // 테슬라 모드에서는 '다음 단속' 글자 없이 제한속도 표지 + 거리만 (표지만 봐도 안다). 글자는 화면 읽기용으로 남긴다
      nxEl.innerHTML = '<span class="mini-sign' + (pk.c[3] === 3 ? ' k3' : '') + (pk.c[3] === 8 || isBox(pk.c) ? ' mob' : '') + '">' + (pk.c[2] || '?') + '</span><span class="nx-label">다음 단속 </span><b>' + fmtDist(d) + '</b>';
      nxEl.setAttribute('aria-label', '다음 단속 ' + fmtDist(d));
      nxEl._d = d;
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
      const doubt = tg.flag === 'doubt';
      $('#camLimit').textContent = speedCam ? (doubt ? '?' : (tg.c[2] || '?')) : '신호';
      card.classList.toggle('doubt', doubt);
      card.classList.toggle('crowd', !!tg.c.crowd && !isUserSpot(tg.c));   // v175: 확인 전 자동 반영 고침이 바꾼 카메라
      // v161: 틀림 버튼은 화면에 그려진 카메라에 묶는다. 카드가 다른 카메라로 바뀐 뒤 1초 동안은 누름을 무시한다
      if (card._camI !== tg.i) { card._camI = tg.i; card._camAt = Date.now(); }
      // 지나간 뒤에도 CAM_HOLD(30m)까지는 카메라 바로 앞인 것처럼 그대로 보여 주고(오차 거리는 따로 알리지 않음), 그 뒤 사라진다
      $('#camType').textContent = camLabel(tg.c);
      $('#camDist').textContent = tg.after ? '통과' : fmtDist(camShownDist(tg));   // v112: 지나친 뒤 '0m' 대신 (문구 검토)
      const sd = camShownDist(tg);
      card._d = tg.after ? 0 : Math.max(0, sd);   // 서랍 칸 순서 (v158)
      const span = Math.max(Number.isFinite(tg.first) ? tg.first : sd, 300);
      $('#camBar').style.width = tg.after ? '100%' : Math.max(0, Math.min(100, (1 - sd / span) * 100)) + '%';
      card.classList.toggle('over', speedCam && !doubt && tg.c[2] > 0 && state.speedKmh > tg.c[2] + 1 && sd < 600);
      card.classList.toggle('signal', !speedCam);
      card.classList.toggle('mobile', tg.c[3] === 8 || isBox(tg.c) || isUserSpot(tg.c)); // 이동식·박스형·신고 지점은 파란색 (v114, v169)
      card.classList.toggle('box', isBox(tg.c));
      card.classList.toggle('sigspeed', tg.c[3] === 3); // 신호·과속: 표지 위에 작은 신호등
      // 어린이·노인 보호구역: 도로 주의 표지 모양 타일 (삼각 표지 + 빨간 띠에 남은 거리 + '어린이보호' 와 제한속도)
      const zone = tg.c[6] === 2 ? 'kid' : tg.c[6] === 1 ? 'elder' : '';
      card.classList.toggle('zonecam', !!zone);
      if (zone) {
        const sign = $('#ztSign');
        if (sign.dataset.zone !== zone) { sign.innerHTML = zone === 'kid' ? SIGN_KID : SIGN_ELDER; sign.dataset.zone = zone; }
        $('#ztDist').textContent = tg.after ? '통과' : fmtDist(camShownDist(tg));
        $('#ztLabel').textContent = zone === 'kid' ? '어린이보호' : '노인보호';
        $('#ztLimit').textContent = speedCam ? (doubt ? '?' : (tg.c[2] || '?')) : '신호';
      }
      // 테슬라 모드: 과속 정보 밑에 작은 주의 표지 (CSS 가 테슬라 모드에서만 보여 준다)
      const zb = $('#zoneBadge');
      zb.hidden = !zone;
      if (zone && zb.dataset.zone !== zone) {
        $('#zbSign').innerHTML = zone === 'kid' ? SIGN_KID : SIGN_ELDER;
        $('#zbLabel').textContent = zone === 'kid' ? '어린이 조심' : '노인 조심';   // 표지·카드의 '노인보호'와 같은 낱말
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
  const DRAWER_ITEMS = ['#laneRow', '#juncCard', '#camCard', '#mySpeed', '#zoneBadge', '#secCard', '#tollCard'];
  const drawerAnimated = () => !testPage && $('#app').classList.contains('tesla') && $('#camDrawer').classList.contains('open');
  // q 를 빼도 서랍에 남는 것이 있는지 (내 속도·보호구역 표지는 단속 카드에 딸려 함께 빠진다)
  const drawerKeeps = (q) => ['#laneRow', '#juncCard', '#secCard', '#tollCard'].some((x) => x !== q && !$(x).hidden) ||
    (q !== '#camCard' && !$('#camCard').hidden);
  function syncDrawer() {
    const dr = $('#camDrawer');
    orderAlerts();   // v158: 서랍 칸·작은 칸을 가까운 순서로
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
      if (!laneState.rowHit) $('#laneRow').hidden = true;
      syncDrawer();
    }, 360);
  }
  function cancelDrawerClose() {
    if (!drawer.closing) return;
    clearTimeout(drawer.hideT);
    drawer.closing = false;
  }
  // ---------- 가까운 것이 위로 (v158) ----------
  // 2026-11-17 20:04 이배재터널 안 운전자 '우리 가까운 순서가 위로 올라오기로 했는데 … 전체적으로 확인해볼래':
  // 안내 카드 밑 줄(그다음 안내·터널·휴게소·주차장 입구), 단속 서랍 칸(차로·분기점 그림·단속·구간단속·하이패스),
  // 서랍 밑 작은 칸(과속방지턱·주정차 단속·주의 표지·다음 단속)을 각 묶음 안에서 차에서부터 경로를 따라 잰 거리(_d)가 가까운 것이 위로.
  // 이웃한 두 칸은 아래 칸이 ROW_HYST 넘게 더 가까울 때만 자리를 바꾼다 (같은 교차로처럼 거리가 비슷하면 지금 순서 그대로 — 오르내리지 않게).
  // 숨은 칸은 보이는 칸 밑에 처음(HTML) 순서대로 모아 둔다 (새로 뜨는 칸은 맨 밑에서 시작해 더 가까우면 그 자리에서 바로 올라간다).
  // 바꿀 것이 없으면 DOM 을 건드리지 않는다. groups: [[기준 칸, 함께 다니는 칸…], …] (HTML 순서), 기준 칸이 보일 때만 센다
  const ROW_HYST = 25;
  const docBefore = (a, b) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
  function orderByDist(groups) {
    groups = groups.filter((g) => g[0]);
    if (groups.length < 2) return false;
    const shown = (g) => !g[0].hidden && Number.isFinite(g[0]._d);
    const cur = groups.slice().sort((a, b) => (docBefore(a[0], b[0]) ? -1 : 1));   // 지금 DOM 순서
    const want = cur.filter(shown);
    for (let pass = 0; pass < want.length; pass++) {
      let swapped = false;
      for (let k = 0; k + 1 < want.length; k++) {
        if (want[k + 1][0]._d < want[k][0]._d - ROW_HYST) { const t = want[k]; want[k] = want[k + 1]; want[k + 1] = t; swapped = true; }
      }
      if (!swapped) break;
    }
    for (const g of groups) if (!shown(g)) want.push(g);
    const flat = (list) => list.reduce((a, g) => a.concat(g.filter(Boolean)), []);
    const wantEls = flat(want), curEls = flat(cur).sort((a, b) => (docBefore(a, b) ? -1 : 1));
    if (wantEls.every((el, k) => el === curEls[k])) return false;
    const parent = curEls[0].parentNode;
    let at = curEls[0].previousSibling;
    for (const el of wantEls) {
      if (el.parentNode !== parent) continue;
      if (at) at.after(el); else parent.prepend(el);
      at = el;
    }
    return true;
  }
  // 서랍 칸과 서랍 밑 작은 칸 (서랍이 접히는 동안은 그대로). 내 속도 띠는 단속 카드에 딸려 다닌다(테슬라 모드에서는 CSS 로 서랍 맨 위)
  function orderAlerts() {
    if (drawer.closing) return;
    orderByDist([[$('#laneRow')], [$('#juncCard')], [$('#camCard'), $('#mySpeed'), $('#zoneBadge')], [$('#secCard')], [$('#tollCard')]]);
    orderByDist([[$('#bumpCard')], [$('#parkCard')], [$('#signCard')], [$('#camNext')]]);
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
    // v137: 남은 시간 = 구간 전체를 제한속도로 달린 시간 - 이미 쓴 시간 (이보다 빨리 끝 카메라에 닿으면 평균이 제한을 넘는다).
    // 2026-11-16 네이버 '구간평균 84 · 남은 구간 2.6km · 01:32'(2,794m 구간 앞 200m 를 84km/h)와 같은 계산
    const minLeft = remain !== null ? Math.max(0, (done + remain) / (s.limit / 3.6) - dt) : null;
    return { avg, done, remain, over, need, minLeft };
  }
  const mmss = (sec) => { const t = Math.round(sec); return String(Math.floor(t / 60)).padStart(2, '0') + ':' + String(t % 60).padStart(2, '0'); };
  function renderSection() {
    const s = camState.section, card = $('#secCard');
    if (!s) { card.hidden = true; return; }
    card.hidden = false;
    const st = sectionStats(s);
    card._d = st.remain !== null ? st.remain : 0;   // 서랍 칸 순서 (v158): 구간 끝까지
    $('#secLimit').textContent = s.limit;
    $('#secAvg').textContent = st.avg === null ? '-' : Math.round(st.avg);
    let line = st.remain !== null ? '남은 거리 ' + fmtDist(st.remain) + (st.minLeft !== null ? ' · ' + mmss(st.minLeft) : '') : fmtDist(st.done) + ' 주행';
    if (st.need !== null) {
      if (st.need >= 20) {
        line += ' · ' + Math.floor(st.need) + ' km/h 이하로';
        // v122 (2026-11-15 밤 '속도 초과라는 말 없애줘 놀란다 자꾸'): 말 없이 구간마다 한 번 알림음만 (카드의 '평균 초과'·남은 구간 속도는 그대로)
        if (!s.warned) { s.warned = true; beep(2, 880); logAlert('beep', '구간 평균 제한 넘음 알림음 (음성 없음)'); }
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
    const pl = pointLimit();
    const lim = !prefs.cams ? null : s ? (pl && pl < s.limit ? pl : s.limit) : tg && tg.flag !== 'doubt' && isSpeedCam(tg.c) ? (tg.c[2] || null) : null;
    if (!lim) { el.hidden = true; return; }
    el.hidden = false;
    $('#mySpeedVal').textContent = Math.round(state.speedKmh);
    // v137 (2026-11-16 사용자: '제한 백인건 알고 있으니까 그 제한 쪽에다가 평균 속도를 넣어 주면'): 구간단속 중에는 '제한 100' 자리에 구간 평균.
    // 평균이 제한을 넘으면 빨갛게 (칸이 빨가면 노랗게). 제한은 위 빨간 표지에 그대로 보인다
    const em = $('#mySpeedLim');
    if (s && lim === s.limit) {
      const st = sectionStats(s);
      em.innerHTML = '<small>구간평균</small>' + (st.avg === null ? '-' : Math.round(st.avg));
      em.classList.toggle('avg-over', st.over);
    } else { em.textContent = '제한 ' + lim; em.classList.remove('avg-over'); }
    el.classList.toggle('over', state.speedKmh > lim + 1);
  }
  function renderCamAvg() {
    const el = $('#camAvg'), hint = $('#camHint'), s = camState.section;
    if (!s || !camState.target) { el.hidden = true; hint.hidden = true; hint.classList.remove('sec', 'over'); return; }
    const st = sectionStats(s);
    // v137: 평균은 위 속도 칸('구간평균 80')으로 옮겼다. 거리 옆에 붙이면 '틀림' 버튼과 겹쳤다(2026-11-16 사진).
    // 게이지 밑 한 줄: 남은 시간(네이버처럼) + 평균을 넘었으면 남은 구간에서 지킬 속도
    el.hidden = true;
    const need = st.need !== null && st.need >= 20 ? Math.floor(st.need) + ' km/h 이하로' : st.over ? '평균 초과' : '';
    const line = [st.minLeft !== null ? '남은 시간 ' + mmss(st.minLeft) : '', need].filter(Boolean).join(' · ');
    hint.hidden = !line;
    hint.textContent = line;
    hint.classList.add('sec');
    hint.classList.toggle('over', st.over);
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
  // v161 (2026-11-20 점검): 구간단속 안에서도 앞의 지점 카메라(어린이보호구역 30 등)가 더 낮으면 그 값을 보여 준다
  function pointLimit() {
    const tg = camState.target;
    return tg && !tg.after && tg.flag !== 'doubt' && camShownDist(tg) < 1000 && isSpeedCam(tg.c) && tg.c[4] !== 1 && tg.c[4] !== 2 && tg.c[2] > 0 ? tg.c[2] : null;
  }
  function currentLimit() {
    const s = camState.section, p = pointLimit();
    if (s) return p && p < s.limit ? p : s.limit;
    const tg = camState.target;
    return tg && tg.flag !== 'doubt' && camShownDist(tg) < 1000 && isSpeedCam(tg.c) ? (tg.c[2] || null) : null;
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
  const QUICK_CATS = ['수퍼차저', '전기차충전소', '주차장', '카페', '편의점', '화장실'];
  // 검색창을 열었을 때: 집·회사 바로가기, 자주 찾는 종류, 즐겨찾기, 최근 목적지
  function renderStart() {
    const f = favs();
    // 2026-11-14 요청: 집·회사 버튼 앞에 그림(집 / 회사 건물), 아직 안 정했을 때의 안내 글('검색 결과의 ☆ 로 지정')은 뺀다
    const chip = (key, label, it) => '<button class="qchip' + (it ? '' : ' unset') + '" data-q="' + key + '">' +
      '<i class="qic" aria-hidden="true">' + (pickImg('fav_' + key) || QUICK_ICON[key]) + '</i><span class="qt"><b>' + label + '</b>' +
      (it ? '<span>' + esc(it.name) + '</span>' : '') + '</span></button>';
    // v148 자주 찾는 종류는 한 번 눌러 근처(경유지 찾기면 경로 가까운 곳)를 바로 찾는다
    const cats = '<div class="qcats">' + QUICK_CATS.map((c) => '<button class="qcat" data-c="' + esc(c) + '">' + esc(c) + '</button>').join('') + '</div>';
    const head = '<div class="quick">' + chip('home', '집', f.home) + chip('work', '회사', f.work) + '</div>' + cats;
    const rec = recents().filter((r) => !f.list.some((x) => samePlace(x, r)));
    renderSections([{ title: '즐겨찾기', items: f.list }, { title: '최근 목적지', items: rec }],
      '즐겨찾기와 최근 목적지가 없습니다. 장소 이름이나 주소를 검색하세요.', head);
    $('#results').querySelectorAll('.qcat').forEach((b) => {
      b.onclick = () => { $('#q').value = b.dataset.c; clearTimeout(qTimer); doSearch(); };
    });
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
        const dist = it._gap != null ? '경로 ' + fmtDist(it._gap) : (state.fix ? fmtDist(haversine(state.fix, it)) : '');
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
  // ---------- 장소 검색 (v148) ----------
  // 2026-11-16 사용자: '목적지 검색할 때 너무 어렵고 잘 구현이 안 돼 있다 — 검색엔진을 잘 활용해서 더 나은 환경으로'.
  // 네이버 장소 검색(지역 검색 API)은 위치를 받지 않고 한 번에 5개까지라, 강동구청 앞에서 '스타벅스'를 치면 13km 떨어진 시청 앞 가게만,
  // '슈퍼차저'는 김해·대전 것이 나왔다. 그래서 같은 말을 [그대로] · [지금 있는 구 + 말] · [지금 있는 동 + 말] 로 한꺼번에 찾아 합치고
  // (강동구 스타벅스 → 0.8~1.7km 다섯 곳), 이름이 검색어와 맞는 정도와 거리를 같이 보고 줄 세운다. 주소처럼 보이면 주소 결과가 먼저.
  // 길안내 중 경유지 찾기는 내 위치가 아니라 앞으로 갈 경로에서 가까운 순서
  const REGION_WORD = /^(서울|부산|대구|인천|광주|대전|울산|세종|제주|경기|강원|충북|충남|전북|전남|경북|경남|하남|성남|분당|판교|수원|용인|고양|일산|김포|파주|남양주|구리|의정부|안양|부천|광명|시흥|안산|평택|화성|동탄|천안|청주|전주|춘천|강릉|여수|포항|경주|창원|김해|양평|가평|[가-힣]{1,5}(시|구|군|동|읍|면))$/;
  function regionOf(area) {
    const t = String(area || '').split(/\s+/).filter(Boolean);
    const gu = t.filter((x) => /(구|시|군)$/.test(x) && !/(특별시|광역시|특별자치시)$/.test(x)).pop() || '';
    const last = t[t.length - 1] || '';
    return { gu, dong: t.length >= 3 && /(동|읍|면|가|리)$/.test(last) ? last : '' };
  }
  // v155: 지역 이름은 낱말로 견준다 — '강동구청'은 '강동구'를 글자로 품고 있지만 지역을 적은 게 아니다 (글자로 견주면 '강동구 강동구청'을 안 찾았다)
  function queryVariants(q) {
    const out = [q], toks = q.split(/\s+/);
    if (toks.length > 1 && REGION_WORD.test(toks[0])) return out; // '하남 코스트코'처럼 지역을 이미 적었으면 그대로
    const r = regionOf(road.area);
    if (r.gu && !toks.includes(r.gu)) out.push(r.gu + ' ' + q);
    if (r.dong && !toks.includes(r.dong)) out.push(r.dong + ' ' + q);
    return out;
  }
  const looksAddr = (q) => /\d/.test(q) && /(로|길|동|가|리|읍|면)\s*\d/.test(q);
  // 이름이 검색어와 맞는 정도: 4 같음 · 3 앞이 같음 · 2 들어 있음 · 1 낱말이 이름·분류·주소에 다 있음 · 0 그 밖
  function nameTier(it, q) {
    const n = squash(it.name).toLowerCase(), s = squash(q).toLowerCase();
    if (!s) return 0;
    if (n === s) return 4;
    if (n.startsWith(s)) return 3;
    if (n.includes(s)) return 2;
    const hay = squash([it.name, it.category, it.addr].join(' ')).toLowerCase();
    return q.toLowerCase().split(/\s+/).filter(Boolean).every((t) => hay.includes(t)) ? 1 : 0;
  }
  const TIER_W = [6, 2.5, 1, 0.6, 0.35];
  // 경유지 찾기: 지금부터 앞으로 갈 경로(선분)에서 가장 가까운 거리 (그 자리 둘레를 평면으로 보고 m 로)
  function routeGap(it) {
    const P = nav.pts;
    if (!P || P.length < 2) return null;
    const kx = 111320 * Math.cos(it.lat * Math.PI / 180), ky = 110540;
    const xy = (q) => [(q.lng - it.lng) * kx, (q.lat - it.lat) * ky];
    let best = Infinity;
    for (let i = Math.max(0, nav.seg || 0); i < P.length - 1; i++) {
      const [ax, ay] = xy(P[i]), [bx, by] = xy(P[i + 1]);
      const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
      const u = L2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L2)) : 0;
      best = Math.min(best, Math.hypot(ax + u * dx, ay + u * dy));
    }
    return best;
  }
  function rankPlaces(items, q, via) {
    const base = via ? null : (state.fix || null);
    items.forEach((it) => {
      const d = via ? routeGap(it) : (base ? haversine(base, it) : null);
      it._gap = via ? d : null;
      it._key = (d == null ? 5000 : d + 300) * TIER_W[nameTier(it, q)];
    });
    return items.sort((a, b) => a._key - b._key);
  }
  let searchSeq = 0;
  async function doSearch(live) {
    const q = $('#q').value.trim();
    if (!q) return;
    const seq = ++searchSeq;
    // 입력 중 자동 검색은 이전 결과를 그대로 두고 조용히 바꾼다 (깜빡임 방지)
    if (!live || !$('#results .result')) $('#results').innerHTML = '<div class="empty">검색 중…</div>';
    const near = state.fix ? state.fix.lng.toFixed(6) + ',' + state.fix.lat.toFixed(6) : null;
    const variants = queryVariants(q);
    const [geo, ...pois] = await Promise.allSettled([
      api('/geocode', near ? { query: q, near } : { query: q }),
      ...variants.map((v) => api('/search', { query: v })),
    ]);
    if (seq !== searchSeq) return; // 더 최근 검색이 있으면 이 결과는 버린다
    const places = [], addrs = [], seen = new Set();
    const add = (list, it) => {
      if (!isFinite(it.lat) || !isFinite(it.lng) || !it.lat) return;
      // 같은 곳이 여러 검색에 겹쳐 나온다: 이름(띄어쓰기 무시) + 약 50m 칸으로 하나만
      const k = squash(it.name) + '|' + (Math.round(it.lat * 2000) / 2000) + ',' + (Math.round(it.lng * 2000) / 2000);
      if (seen.has(k)) return;
      seen.add(k);
      list.push(it);
    };
    pois.forEach((r) => { if (r.status === 'fulfilled') (r.value.items || []).forEach((it) => add(places, it)); });
    if (geo.status === 'fulfilled') (geo.value.items || []).forEach((it) => add(addrs, it));
    // 장소 이름 검색(네이버 검색 API)이 아직 설정되지 않았으면 주소만 찾힌다는 것을 알려 준다
    const poiOff = pois.length && pois[0].status === 'fulfilled' && pois[0].value.note === 'search api not configured';
    const hint = poiOff ? '지금은 주소만 찾을 수 있어요 (예: 진황도로 14). 가게·건물 이름 검색은 장소 검색 키를 연결하면 됩니다.' : '';
    if (!places.length && !addrs.length) {
      const err = geo.status === 'rejected' ? geo.reason : (pois.some((r) => r.status === 'rejected') ? pois.find((r) => r.status === 'rejected').reason : null);
      renderResults([], '', err
        ? '검색 서버에 연결하지 못했어요. 잠시 후 다시 시도해 주세요.'
        : (hint || '결과가 없습니다. 다른 이름이나 정확한 주소로 검색해 보세요.'));
      return;
    }
    const via = searchFor === 'via' && nav.active && !!nav.pts;
    rankPlaces(places, q, via);
    rankPlaces(addrs, q, via);
    const secs = [{ title: via ? '경로 가까운 곳' : '장소', items: places.slice(0, 15) }, { title: '주소', items: addrs }];
    renderSections(looksAddr(q) ? secs.reverse() : secs, '결과가 없습니다.');
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
    // v145 (2026-11-16 '기흥역엘리시아트윈101동입구'에서 블록을 한 바퀴 돌았다 — 운전자 '입구를 보고 입구로 안내해줘야 해',
    //  '가장 가까운 주차장으로 안내하거나 입구중에 주차장인곳을 알려줘야 해'): 네이버에 '…101동주차장입출구'로 올라 있어
    //  '입구'만 찾고 '출구'가 든 이름을 빼던 규칙에 걸려 못 찾았다. 입출구·출입구·진입로도 입구로 본다(나가기만 하는 '출구'만 뺀다).
    //  목적지 이름에 'N동'이 있으면 같은 동 입구를 먼저(102동 입구가 핀에서 10m 더 가깝지만 그쪽은 600m 를 돌아간다)
    const dong = (String(dest.name || '').match(/([0-9]+|[A-Za-z])동/) || [])[1] || '';
    const cands = ((res && res.items) || []).filter((it) => {
      const n = squash(it.name);
      if (!/주차/.test(n) || !/입구|입출구|출입구|진입/.test(n) || (/출구/.test(n) && !/입출구|출입구/.test(n)) || !isFinite(it.lat) || !isFinite(it.lng)) return false;
      if (!(n.includes(b) || (b.length >= 5 && n.includes(b.slice(0, b.length - 2))))) return false;
      return haversine(dest, it) <= 600;
    }).map((it) => ({ name: it.name, lat: it.lat, lng: it.lng, d: Math.round(haversine(dest, it)),
      same: !!dong && squash(it.name).includes(dong + '동') }));
    cands.sort((x, y) => (y.same - x.same) || (x.d - y.d));
    const c = cands[0];
    if (c) return { name: c.name, lat: c.lat, lng: c.lng, d: c.d };
    return findGate(dest, base, b, dong);
  }
  // v148 (2026-11-16 운전자 '목적지 주변 가장 가까운 주차장 찾기는 그 건물 입구에 해당하면 됨 (없는 경우)'): 주차장 입구가 없으면
  // 다른 주차장을 찾지 않고 그 건물의 입구로 — 차량 출입구 먼저, 그다음 같은 동, 정문·주출입구, 가까운 것. 목적지가 이미 입구(…입구·정문,
  // '도로시설>방면정보')면 그대로 둔다. 건물 입구는 주차장이 아니라 'P' 줄·지도 P 표지는 없고, 경로 카드에 '입구로 안내'
  const isGateName = (n) => /(입구|출입구|정문|후문|진입로)$/.test(squash(n));
  async function findGate(dest, base, b, dong) {
    if (isGateName(dest.name) || /방면정보/.test(dest.category || '')) return null;
    let res;
    try { res = await api('/search', { query: base + ' 입구' }, null, 2500); } catch (e) { return null; }
    const cands = ((res && res.items) || []).filter((it) => {
      const n = squash(it.name);
      if (/주차/.test(n) || !/입구|출입구|정문|진입/.test(n) || (/출구/.test(n) && !/출입구/.test(n)) || !isFinite(it.lat) || !isFinite(it.lng)) return false;
      if (!(n.includes(b) || (b.length >= 5 && n.includes(b.slice(0, b.length - 2))))) return false;
      return haversine(dest, it) <= 300;
    }).map((it) => { const n = squash(it.name); return { name: it.name, lat: it.lat, lng: it.lng, d: Math.round(haversine(dest, it)),
      car: /차량/.test(n), same: !!dong && n.includes(dong + '동'), main: /정문|주출입구/.test(n) }; });
    cands.sort((x, y) => (y.car - x.car) || (y.same - x.same) || (y.main - x.main) || (x.d - y.d));
    const c = cands[0];
    return c ? { name: c.name, lat: c.lat, lng: c.lng, d: c.d, gate: true } : null;
  }
  // 경로의 도착점: 주차장 입구를 찾았으면 그곳 (정문으로 바꾸면 원래 자리)
  const goalOf = (d) => parkGoalOf(d) || d;
  // v145 도착 700m 안에서 안내 칸에 'P 101동 주차장 입출구 250m' 한 줄 (운전자 '입구중에 주차장인곳을 알려줘야 해')
  const PARK_GOAL_SHOW = 700;
  function parkLabel(pk, d) {
    let n = squash(pk.name);
    const b = squash(placeBase(d && d.name));
    if (b && n.startsWith(b)) n = n.slice(b.length);
    n = n.replace(/^([0-9]+|[A-Za-z])동/, '$1동 ').replace(/(지하)?주차장/, (m) => m + ' ').replace(/\s+/g, ' ').trim();
    return n && /주차/.test(n) ? n : '주차장 입구';
  }
  function renderParkGoal() {
    const el = $('#parkGoal');
    if (!el) return;
    const d = nav.active ? nav.dest : null, pk = parkGoalOf(d);
    const remain = nav.remain != null ? nav.remain : nav.total;
    const show = !!pk && !pk.gate && remain != null && remain <= PARK_GOAL_SHOW;   // 건물 입구(v148)는 주차장이 아니라 'P' 줄 없음
    el.hidden = !show;
    if (!show) return;
    $('#parkGoalName').textContent = parkLabel(pk, d);
    $('#parkGoalDist').textContent = fmtDist(Math.max(10, remain));
  }
  let pickSeq = 0;
  async function pickDest(it) {
    closeSearch();
    // 길안내 중 경유지 고르기: 목적지는 그대로, 고른 곳을 거쳐 가는 경로로 바로 다시 찾는다
    if (searchFor === 'via' && nav.active && nav.dest) {
      searchFor = 'dest';
      nav.via = [{ name: it.name, lat: it.lat, lng: it.lng }];
      toast(it.name + ' 경유 경로 찾는 중…', '', 3000);
      planRoute(nav.dest, 'via');
      return;
    }
    addRecent(it);
    nav.via = []; // 새 목적지는 경유지 없이
    const shortAddr = (x) => String(x || '').replace(/^(\S+(?:특별시|광역시|특별자치시|특별자치도|도)\s+)?(\S+(?:시|군)\s+)?(\S+구\s+)?/, '') || x;
    const seq = ++pickSeq, dest = { name: it.category ? it.name : shortAddr(it.name), addr: it.addr || it.name || '', lat: it.lat, lng: it.lng, category: it.category || '' };
    toast('경로를 찾는 중…', '', 3000);
    const park = await findParking(dest);
    if (seq !== pickSeq) return; // 그사이 다른 목적지를 골랐다
    if (park) dest.park = park;
    planRoute(dest, false);
  }

  // ---------- 지도에서 고른 자리 (v148) ----------
  // 2026-11-16 사용자: '지도를 찍어서 선택하면 간단한 정보랑 위치 찍을 수 있게, 경유지나'. 한 번 톡은 화면 버튼을 보여 주는 데 쓰므로
  // 길게 누르면(PC 는 오른쪽 클릭) 그 자리에 파란 핀을 꽂고 아래 카드에 이름(장소·건물)·분류·주소·거리와
  // [여기로 안내](길안내 중이면 [목적지로]) · [경유지로](길안내 중) · [☆ 저장] 을 띄운다. 30초 동안 안 만지면 닫는다.
  // 이름·주소: 네이버 지도 JS 의 지오코더(역지오코딩: '서울특별시 강동구 성내로 25 강동구청'처럼 건물 이름까지)를 처음 쓸 때 받아 쓰고,
  // 건물 이름(없으면 도로명 주소)으로 장소 검색을 한 번 더 해 60m 안의 가게·기관 이름과 분류를 붙인다. 그림 지도(OSM)면 길안내 서버의 역지오코딩
  const PICK_MS = 30000;
  let pickSeq2 = 0, pickTimer = 0, geocoderP = null;
  const shortArea = (x) => String(x || '').replace(/\s+/g, ' ').replace(/^(\S+(?:특별시|광역시|특별자치시|특별자치도|도)\s+)/, '').trim();
  function naverGeocoder() {
    const N = window.naver && naver.maps;
    if (!N || mapA !== NaverAdapter) return Promise.resolve(null);
    if (N.Service && N.Service.reverseGeocode) return Promise.resolve(N.Service);
    if (!geocoderP) {
      geocoderP = loadScript('https://oapi.map.naver.com/openapi/v3/maps-geocoder.js')
        .then(() => (naver.maps.Service && naver.maps.Service.reverseGeocode ? naver.maps.Service : null))
        .catch(() => { geocoderP = null; return null; });
    }
    return geocoderP;
  }
  async function describeAt(p) {
    const S = await naverGeocoder();
    if (S) {
      const r = await new Promise((res) => {
        const t = setTimeout(() => res(null), 5000);
        try {
          S.reverseGeocode({ coords: new naver.maps.LatLng(p.lat, p.lng), orders: [S.OrderType.ROAD_ADDR, S.OrderType.ADDR].join(',') },
            (status, resp) => { clearTimeout(t); res(status === S.Status.OK ? resp : null); });
        } catch (e) { clearTimeout(t); res(null); }
      });
      const a = r && r.v2 && r.v2.address;
      if (a && (a.roadAddress || a.jibunAddress)) {
        const road = (r.v2.results || []).find((x) => x.name === 'roadaddr');
        const ad = road && road.land && road.land.addition0;
        const bld = ad && ad.type === 'building' ? String(ad.value || '').trim() : '';
        let addr = shortArea(a.roadAddress || a.jibunAddress);
        if (bld && addr.endsWith(' ' + bld)) addr = addr.slice(0, -bld.length - 1);
        return { bld, addr, jibun: shortArea(a.jibunAddress) };
      }
    }
    try {
      const j = await api('/reverse', { coords: p.lng.toFixed(6) + ',' + p.lat.toFixed(6) }, null, 6000);
      return { bld: '', addr: shortArea([j.area, j.road].filter(Boolean).join(' ')), jibun: '' };
    } catch (e) { return { bld: '', addr: '', jibun: '' }; }
  }
  // 건물 이름(또는 도로명 주소)으로 장소를 찾아 누른 자리 60m 안에서: 이름(주소)이 맞는 곳 먼저, 같으면 가까운 곳.
  // v154: 장소 검색은 위치를 안 받아서 '강동구청'만 치면 '○○ 강동구청점' 식당 다섯 곳만 나오고 구청은 안 나온다.
  // 그래서 '<구> 건물 이름'(강동구 강동구청 → 강동구청 · 공공,사회기관>구청)도 같이 찾아 합친다
  async function placeNear(p, query, area) {
    if (!query) return null;
    const qs = [query], gu = regionOf(area).gu;
    if (gu && !query.split(/\s+/).includes(gu)) qs.push(gu + ' ' + query);
    const lists = await Promise.all(qs.map((q) => api('/search', { query: q }, null, 4000).then((r) => (r && r.items) || [], () => [])));
    const c = [].concat(...lists).filter((it) => isFinite(it.lat) && isFinite(it.lng) && haversine(p, it) <= 60)
      .map((it) => ({ it, t: nameTier(it, query), d: haversine(p, it) }))
      .sort((a, b) => b.t - a.t || a.d - b.d);
    return c.length ? c[0].it : null;
  }
  // 카드에는 분류의 끝말만 ('공공,사회기관>구청' → '구청')
  const catTail = (c) => String(c || '').split('>').pop().trim();
  function closePick() {
    clearTimeout(pickTimer);
    pickSeq2++;
    state.pick = null;
    $('#pickCard').hidden = true;
    if (mapA && mapA.setPick) mapA.setPick(null);
  }
  function armPickClose() { clearTimeout(pickTimer); pickTimer = setTimeout(closePick, PICK_MS); }
  function renderPick() {
    const p = state.pick;
    if (!p) return;
    const navOn = nav.active && !!nav.dest;
    $('#pkName').textContent = p.name || (p.busy ? '이 위치' : (p.addr || '이 위치'));
    $('#pkSub').textContent = p.busy ? '주소 찾는 중…'
      : ([catTail(p.category), p.name && p.name !== p.addr ? p.addr : (p.jibun || '')].filter(Boolean).join(' · ') || (p.name || p.addr ? '' : '주소 정보 없음'));
    $('#pkDist').textContent = state.fix ? fmtDist(haversine(state.fix, p)) : '';
    $('#pkGo').textContent = navOn ? '목적지로' : '여기로 안내';
    $('#pkVia').hidden = !navOn;
    $('#pkVia').textContent = nav.via && nav.via.length ? '경유지 바꾸기' : '경유지로';
    $('#pkFav').textContent = !p.busy && favKind(pickTarget()) ? '★ 저장됨' : '☆ 저장';
  }
  async function pickAt(sx, sy) {
    const cp = canvasPoint(sx, sy);
    if (!cp || !mapA || !mapA.coordAt) return;
    let ll = null;
    try { ll = mapA.coordAt(cp.x, cp.y); } catch (e) { ll = null; }
    if (!ll || !Number.isFinite(ll.lat) || !Number.isFinite(ll.lng)) return;
    try { if (navigator.vibrate) navigator.vibrate(12); } catch (e) { /* 무시 */ }
    const seq = ++pickSeq2;
    state.pick = { lat: ll.lat, lng: ll.lng, name: '', addr: '', category: '', busy: true };
    if (mapA.setPick) mapA.setPick(state.pick);
    $('#pickCard').hidden = false;
    renderPick();
    armPickClose();
    const info = await describeAt(ll);
    if (seq !== pickSeq2) return;
    const poi = await placeNear(ll, info.bld || info.addr, info.addr || info.jibun);
    if (seq !== pickSeq2) return;
    const p = state.pick;
    p.busy = false;
    p.addr = info.addr || (poi && poi.addr ? shortArea(poi.addr) : '');
    p.jibun = info.jibun || '';
    if (poi && (!info.bld || nameTier(poi, info.bld) >= 1 || haversine(ll, poi) <= 25)) {
      p.name = poi.name; p.category = poi.category || ''; p.placeLat = poi.lat; p.placeLng = poi.lng;
    } else p.name = info.bld || '';
    renderPick();
  }
  // 고른 자리를 목적지·경유지로: 장소를 찾았으면 그 장소 좌표(주차장 입구 찾기가 이름으로 된다), 아니면 누른 자리
  function pickTarget() {
    const p = state.pick;
    if (!p) return null;
    const near = p.placeLat != null && haversine(p, { lat: p.placeLat, lng: p.placeLng }) <= 60;
    return { name: p.name || p.addr || '지도에서 고른 곳', addr: p.addr || '', category: p.category || '',
      lat: near ? p.placeLat : p.lat, lng: near ? p.placeLng : p.lng };
  }
  $('#pkClose').onclick = closePick;
  $('#pickCard').addEventListener('pointerdown', armPickClose);
  $('#pkGo').onclick = () => {
    const t = pickTarget();
    if (!t) return;
    closePick();
    searchFor = 'dest';
    pickDest(t);
  };
  $('#pkVia').onclick = () => {
    const t = pickTarget();
    if (!t || !nav.active || !nav.dest) return;
    closePick();
    nav.via = [{ name: t.name, lat: t.lat, lng: t.lng }];
    toast(t.name + ' 경유 경로 찾는 중…', '', 3000);
    planRoute(nav.dest, 'via');
  };
  $('#pkFav').onclick = () => {
    const t = pickTarget();
    if (!t) return;
    const on = !!favKind(t);
    setFav(t, on ? 'remove' : 'fav');
    toast(FAV_DONE[on ? 'remove' : 'fav'], '', 2000);
    renderPick();
  };

  // 길찾기 서버(Worker)는 한 가지 옵션 길찾기(재탐색·교통 갱신)를 주소마다 60초에 4번까지 받는다 (ROUTE_LIMIT).
  // 2026-11-15 12:18 차에서 재탐색이 '잠시 후 다시 시도합니다'(429)로 막혔다: 재탐색 + 시간 초과 재시도 + 바로 한 번 더 + 교통 갱신이 겹침.
  // 앱도 같이 세어 넘기지 않는다: 교통 갱신은 2번 넘게 남았을 때만, 재탐색은 남은 게 없으면 자리가 나는 때 조용히 다시
  const routeReqs = [];
  const routeNow = () => (state.fix ? state.fix.t : Date.now());
  function routeBudget() {
    const now = routeNow();
    while (routeReqs.length && (now - routeReqs[0] > 60000 || routeReqs[0] > now)) routeReqs.shift();
    return 4 - routeReqs.length;
  }
  const routeWaitMs = () => (routeReqs.length ? Math.max(500, 60000 - (routeNow() - routeReqs[0]) + 300) : 500);
  function retryRouteLater(dest, reroute, ms) {
    clearTimeout(nav.retryT);
    const g0 = nav.gen;
    nav.retryT = setTimeout(() => {
      nav.retryT = null;
      if (nav.active && nav.gen === g0 && !nav.onRoute && !nav.busy) planRoute(dest, reroute);
    }, Math.min(ms, 61000));
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
      if (q.option) {   // 한 가지 옵션 길찾기는 60초에 4번 (위 routeReqs)
        const left = routeBudget();
        if (left <= 0 || (reroute === 'traffic' && left < 2)) {
          if (reroute && reroute !== 'traffic') retryRouteLater(dest, reroute, routeWaitMs());
          return;
        }
        routeReqs.push(routeNow());
      }
      let res;
      try { res = await api('/route', q, null, waitMs); } catch (e1) {
        if (e1.name !== 'AbortError' && !/abort/i.test(e1.message)) throw e1;
        if (gen !== nav.gen) return;
        if (ahead) q.start = startOf();
        if (q.option) { if (routeBudget() <= 0) throw e1; routeReqs.push(routeNow()); }
        res = await api('/route', q, null, waitMs);
      }
      nav.retry429 = false;   // v175: 서버가 받았으면 다음 429 때 다시 한 번 기다려 본다
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
      // 서버가 '잠시 후 다시'(429)로 막으면: 교통 갱신은 그냥 넘기고, 재탐색은 알려 준 시간 뒤 조용히 다시 (실패 안내 없이)
      if (e.status === 429) {
        report('info', { msg: 'route rate limited', reroute: String(reroute || '') });
        if (reroute === 'traffic') return;
        if (reroute) {
          retryRouteLater(dest, reroute, Math.min(61, Math.max(1, Number(d.retryAfter) || 15)) * 1000 + 300);
          toast('잠시 후 경로를 다시 찾습니다…', '', 3000);
          return;
        }
        // v175: 처음 길찾기도 한 번은 알려 준 시간 뒤 조용히 다시 (같은 통신사 IP 를 여러 차가 쓰면 잠깐 몰릴 수 있다)
        if (!nav.retry429) {
          nav.retry429 = true;
          const g1 = nav.gen;
          toast('요청이 몰려 잠시 후 경로를 다시 찾습니다…', '', 4000);
          setTimeout(() => { if (nav.gen === g1 && !nav.active && !nav.busy) planRoute(dest, false); }, Math.min(20, Math.max(1, Number(d.retryAfter) || 5)) * 1000 + 300);
          return;
        }
      }
      nav.retry429 = false;
      report('warn', { msg: 'route failed: ' + String(d.message || d.error || e.message).slice(0, 200), reroute: String(reroute || ''), keys: d.keys || '' });
      if (reroute === 'traffic') return; // 교통 갱신 실패는 지금 경로로 계속 안내 (화면에 띄우지 않음)
      const slow = e.name === 'AbortError' || /abort/i.test(e.message || '');
      if (reroute) { // 재탐색 실패: 지금 경로를 유지하고, 계속 벗어나 있으면 잠시 뒤 다시 시도한다
        toast(slow ? '통신이 느려 경로를 다시 찾지 못했어요. 잠시 후 다시 시도합니다.' : '경로를 다시 찾지 못했어요. 잠시 후 다시 시도합니다.', 'bad', 5000);
        return;
      }
      if (slow) { toast('통신이 느려 경로를 찾지 못했어요. 다시 시도해 주세요.', 'bad', 6000); return; }
      const why = String(d.message || (d.detail && d.detail.error && d.detail.error.message) || '');
      toast(/[가-힣]/.test(why) ? '경로를 찾지 못했어요: ' + why : '경로 서버에 연결하지 못했어요. 잠시 후 다시 시도해 주세요.', 'bad', 9000);
    } finally {
      if (gen === nav.gen) nav.busy = false;
    }
  }

  const FINAL_TURN = new Set(['l', 'r', 'sl', 'sr', 'sharp_l', 'sharp_r', 'kl', 'kr']);
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
    nav.routeCams = null; nav.routeCamList = []; nav.turnCamDrops = 0; camState.markerAt = null; // 경로 위 카메라·지도 표시를 새 경로로
    nav.routeBumps = null; bumpState.markerKey = '';
    nav.routeSigns = null; tollState.numsKey = '';
    nav.routeTunnels = null;
    nav.laneCache = null; nav.laneStraight = null; nav.forkList = null; nav.clList = null; laneState.key = '';
    nav.lastTraffic = state.fix ? state.fix.t : Date.now();
    if (!keepAlerts) { nav.said = {}; nav.gap = 10000; }
    nav.remain = nav.total; nav.next = null; nav.dg = null;
    nav.guides = (r.guide || []).filter((g) => g.i < nav.pts.length).sort((a, b) => a.i - b.i);
    // v145: 도착 20m 앞의 회전(주차장 입구로 들어가는 마지막 꺾음 '우회전 → 8m 도착')은 따로 알리지 않고 도착으로 (네이버처럼 '좌회전 후 도착')
    {
      const n = nav.guides.length, last = nav.cum.length - 1;
      const gl = nav.guides[n - 1], gp = nav.guides[n - 2];
      if (gl && gp && (gl.t === 88 || /목적지/.test(gl.s || '')) && FINAL_TURN.has(turnKind(gp)) &&
          nav.cum[last] - nav.cum[Math.min(gp.i, last)] <= 20) nav.guides.splice(n - 2, 1);
    }
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
      const gate = !!nav.dest.park.gate;   // v148: 주차장 입구가 없어 건물 입구로 안내하는 경우
      $('#rcParkName').textContent = nav.dest.parkOff ? (gate ? '건물 위치(목적지)로 안내' : '정문(목적지)으로 안내') : (gate ? '입구로 안내 · ' : '주차장 입구로 안내 · ') + nav.dest.park.name;
      $('#rcParkBtn').textContent = nav.dest.parkOff ? (gate ? '입구로' : '주차장 입구로') : (gate ? '건물 위치로' : '정문으로');
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
    updateSoundPill();
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
    clearTimeout(nav.retryT); nav.retryT = null;
    nav.active = false; nav.preview = false;
    nav.route = null; nav.pts = null; nav.cum = null; nav.dest = null; nav.guides = [];
    nav.routeCams = null; nav.routeCamList = []; nav.turnCamDrops = 0; camState.markerAt = null; camState.peekAt = 0;
    nav.alts = null; nav.altIdx = 0; nav.via = []; nav.comparing = false; nav.compareBase = null;
    if (mapA) { mapA.clearRoute(); if (mapA.drawAlts) mapA.drawAlts([]); }
    if (mapA && mapA.setDest) mapA.setDest(null);
    if (mapA && mapA.setTurnArrow) mapA.setTurnArrow(null);
    nav.arrowKey = null;
    nav.routeRest = null; restState.key = '';
    $('#restCard').hidden = true;
    nav.clList = null; $('#colorRow').hidden = true;
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
  // v133 (2026-11-16 주행 중 사용자: 신갈분기점 '서울' 방면은 '구조상 서울 직진이고 오른쪽이 약간 오른쪽으로 헤어지는' 곳이라 직진 그림이 필요):
  //   갈림길 안내(왼쪽/오른쪽 방향·도로 주행·전방 분기)인데 경로가 고속도로·도시고속도로 본선을 그대로 가면 비켜 가기가 아니라 직진으로
  //   보여 준다(안내 화살표·문구 '신갈분기점에서 직진 · 서울 방면'·분기점 그림 = 본선 직진 + 옆으로 갈라지는 연결로).
  //   본선 = 길찾기 응답의 도로 구간(경부고속도로 등)이 안내 지점 앞 200m·뒤 300m 넘게 이어지고, 그 앞뒤 방향이 12° 안.
  //   실제 경로(오산IC → 경부 상행, 2026-11-16): 신갈분기점 '서울' 0° → 직진. 판교분기점 '일산, 구리'(구간이 수도권제1순환으로 바뀜) → 그대로
  //   음성은 네이버 문장 그대로('왼쪽 도로 주행': 오른쪽 차로가 연결로로 빠지니 차로를 지키라는 뜻이 있다)
  const MAIN_KEEP_T = new Set([4, 5, 41, 42, 54, 81, 82]);
  function mainKeep(g) {
    if (!g || !MAIN_KEEP_T.has(g.t) || !nav.route || !nav.cum || !nav.cum.length || g.i == null) return false;
    if (g._mkFor === nav.route) return g._mk;
    let ok = false;
    const last = nav.cum.length - 1, i = Math.min(g.i, last), at = nav.cum[i];
    const sec = (nav.route.sections || []).find((s) => i >= s.i && i <= s.i + Math.max(1, s.n) - 1);
    const fast = onHighwayRoute(at) || fastRoadSpans().some(([a, b]) => at >= a && at <= b);
    if (sec && sec.name && fast) {
      const a = nav.cum[Math.min(sec.i, last)], b = nav.cum[Math.min(sec.i + Math.max(1, sec.n) - 1, last)];
      if (at - a >= 200 && b - at >= 300) {
        const b1 = routeBearingAt(at - 200, at), b2 = routeBearingAt(at, at + 300);
        ok = b1 != null && b2 != null && angleDiff(b1, b2) <= 12;
      }
    }
    g._mk = ok; g._mkFor = nav.route;
    return ok;
  }
  function turnKind(g) {
    const k = turnKind0(g);
    return (k === 'kl' || k === 'kr') && mainKeep(g) ? 's' : k;
  }
  // 안내 글을 '직진'으로 바꿔 쓰는 건 방향 있는 갈림길(비켜 가기 kl/kr)을 본선 그대로 갈 때만. v156 (2026-11-17 수도권1순환 북행
  // 서하남IC 2.4km 앞 '분기도로 진입'(54, 방향 없음): 네이버는 '분기 후 합류', 우리는 본선 위라 '직진'이 나왔다) — 방향 없는 전방 분기(jc)는
  // 본선이 섬을 끼고 두 갈래로 갈라졌다 다시 합쳐지는 곳이라 어느 갈래로 가도 되고, 글·그림 모두 '분기 후 합류'
  function mainStraight(g) {
    const k = turnKind0(g);
    return (k === 'kl' || k === 'kr') && mainKeep(g);
  }
  // 안내 칸·그다음 칸에 그릴 그림 (v143, 2026-11-16 판교분기점 운전자 '네이버 지도에 있는 아이콘이 이런 식으로 나오는데 왜 우리는 이런 식으로 나와'):
  // 네이버는 '오른쪽 방향'(4·5, 방향 있는 전방 분기)은 굵은 화살표 하나가 그쪽으로 휘는 그림('4.1km 대전'),
  // '오른쪽 도로 주행'(41·42)과 본선을 그대로 가는 갈림길은 직진 화살표 밑동이 반대쪽에서 살짝 넘어오는 그림('1.6km')이다.
  // 예전엔 둘 다 구불구불한 S 자(kl/kr)였고 본선 그대로는 직진 화살표만이었다. 좌우는 turnKind0 그대로 (종류·차로·지도 화살표는 turnKind 그대로)
  // 그다음 칸 거리의 기준 글자 (v158): 위 안내 줄이 가리키는 곳. 하는 동작이면 '좌회전 후', 지나가는 곳이면 '톨게이트 지나'
  const AFTER_WORD = {
    l: '좌회전 후', sharp_l: '좌회전 후', rb_l: '좌회전 후', r: '우회전 후', sharp_r: '우회전 후', rb_r: '우회전 후',
    u: '유턴 후', rb_u: '유턴 후', s: '직진 후', rb_s: '직진 후',
    sl: '갈림길 지나', sr: '갈림길 지나', kl: '갈림길 지나', kr: '갈림길 지나', jc: '갈림길 지나',
    ins: '진입 후', inl: '진입 후', inr: '진입 후', outs: '진출 후', outl: '진출 후', outr: '진출 후',
    over_s: '고가차도 진입 후', over_l: '고가차도 진입 후', over_r: '고가차도 진입 후',
    under_s: '지하차도 진입 후', under_l: '지하차도 진입 후', under_r: '지하차도 진입 후',
    side_l: '옆길 진입 후', side_r: '옆길 진입 후', oside_l: '옆길 진입 후', oside_r: '옆길 진입 후',
    toll: '톨게이트 지나', rest: '휴게소 지나', via: '경유지 지나', ferry: '도선 후',
  };
  function afterWord(g, under, over) {
    if (under) return '지하차도 진입 후';
    if (over) return '고가차도 진입 후';
    return AFTER_WORD[turnKind(g)] || '앞 안내 후';
  }
  function iconKind(g) {
    if (!g) return 'goal';
    const k0 = turnKind0(g);
    if ((k0 === 'kl' || k0 === 'kr') && (g.t === 41 || g.t === 42 || mainKeep(g))) return k0 === 'kl' ? 'ml' : 'mr';
    return turnKind(g);
  }
  // v141 좌우는 한 곳에서 (2026-11-16 송파IC '오른쪽 진입'인데 IN 그림이 왼쪽으로 빠지는 모양 — 운전자 '로직 잘 좀 봐줘'):
  // 안내 하나의 좌우 = 네이버 안내 코드 → 종류(KIND_BY_CODE). 같은 응답의 문장(동작 부분 '오른쪽 고속도로 진입')이 반대 쪽을 말하면 문장을 따른다
  // (저장된 실제 경로 316개 안내에서 코드와 문장이 어긋난 곳은 0곳 — 안전장치). 아이콘·그다음 칸·분기점 그림(juncInfo)이 모두 이 값을 쓰고,
  // 패널 글·음성은 문장 그대로, 지도 화살표는 경로 모양 그대로라 같은 쪽이 된다
  const SIDE_L = new Set(['l', 'sl', 'sharp_l', 'kl', 'ml', 'inl', 'outl', 'over_l', 'under_l', 'side_l', 'oside_l', 'rb_l']);
  const SIDE_R = new Set(['r', 'sr', 'sharp_r', 'kr', 'mr', 'inr', 'outr', 'over_r', 'under_r', 'side_r', 'oside_r', 'rb_r']);
  const kindSide = (k) => SIDE_L.has(k) ? 'l' : SIDE_R.has(k) ? 'r' : null;
  const mirrorKind = (k) => k === 'l' ? 'r' : k === 'r' ? 'l' : k.replace(/l$/, '\u0000').replace(/r$/, 'l').replace('\u0000', 'r');
  function textSide(s) {
    const m = String(s || '').match(/^(?:(.+?)에서\s+)?(?:'([^']+)'\s*방면으로\s+)?(.+)$/);
    const a = m ? m[3] : String(s || '');
    const h = a.match(/(\d{1,2})시\s*방향/);
    if (h && !/회전교차로|로터리/.test(a)) { const n = +h[1]; if (n >= 7 && n <= 11) return 'l'; if (n >= 1 && n <= 5) return 'r'; }
    const l = /왼쪽|좌회전|좌측/.test(a), r = /오른쪽|우회전|우측/.test(a);
    return l && !r ? 'l' : r && !l ? 'r' : null;
  }
  function turnKind0(g) {
    if (!g) return 's';
    if (g._tkFor === g.s + '|' + g.t) return g._tk;
    let k = turnKind00(g);
    const ks = kindSide(k), ts = textSide(g.s);
    if (ks && ts && ks !== ts && !/^rb_/.test(k)) { k = mirrorKind(k); nav.sideFixes = (nav.sideFixes || 0) + 1; }
    g._tk = k; g._tkFor = g.s + '|' + g.t;
    return k;
  }
  function turnKind00(g) {
    const s = g.s || '', t = g.t;
    if (t >= 21 && t <= 34) return rbKind(t - 21);   // 로터리
    if (t >= 91 && t <= 104) return rbKind(t - 91);  // 회전교차로
    // 전방 분기 도로. 방향이 없으면 v137 (2026-11-16 사용자 '분기 도로합류지점 아이콘도 만들어 줘', 네이버 '분기 후 합류'): JC 그림
    if (t === 54) return /왼쪽/.test(s) ? 'kl' : /오른쪽/.test(s) ? 'kr' : 'jc';
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
    // v141 (2026-11-16 송파IC '오른쪽 진입'에서 운전자 '나는 오른쪽으로 들어가야 되는데 왜 왼쪽으로 빠지라고 나와 있어?'):
    // 들어가기(IN)도 나가기(OUT)처럼 '지금 달리는 길에서 그쪽 연결로로 휘어 들어가는' 그림 하나 (네이버 IN 그림과 같은 짜임).
    // 예전 IN 은 오른쪽 연결로가 왼쪽 본선으로 합쳐지는 그림이라 화살표 끝이 왼쪽 길 위에 있어 왼쪽으로 가라는 것처럼 보였다
    const road = '<path class="rd-f" d="M4 47V3h15v44z" fill="#2b3440" stroke="none"/>' +
      '<path d="M11.5 44V5" stroke="#fff" stroke-width="1.6" stroke-dasharray="4 4" opacity=".55" fill="none"/>' +
      '<path class="rd-s" d="M14 47C14 35 22 27 37 21" stroke="#2b3440" stroke-width="12" fill="none"/>' +
      '<path d="M13 45C13 34.5 20 28.6 31 23.6" stroke="#fff" stroke-width="4.5" stroke-linecap="round" fill="none"/>' +
      '<path d="M38.5 20.2 33.3 28 29.2 19z" fill="#fff" stroke="none"/>';
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
  // v137 (2026-11-16 사용자 '분기 도로합류지점 아이콘도 만들어 줘', 네이버 사진의 JC·OUT 그림): 톨게이트(TG) 그림과 같은 짜임 —
  // 어두운 길 + 흰 화살표. 나가기(OUT)·들어가기(IN, 합류)는 rampIcon(길 하나 + 갈라지는/합쳐지는 연결로 + 고속도로 방패 표지),
  // 분기 후 합류(JC)는 길이 마름모 섬을 끼고 갈라졌다 다시 합쳐지는 모양에 흰 화살표가 오른쪽 갈래로
  Object.assign(TURN_ICONS, { outr: rampIcon(true, false), outl: rampIcon(true, true), inr: rampIcon(false, false), inl: rampIcon(false, true),
    // v156 (2026-11-17 네이버 '분기 후 합류' 그림): 길이 마름모 섬을 끼고 두 갈래로 갈라졌다 위에서 다시 합쳐지고, 흰 화살표도 두 갈래로
    // 섬 양옆을 돌아 위쪽 합류 지점을 가리킨다 (어느 갈래로 가도 된다). 예전 그림은 화살표가 오른쪽 갈래 하나라 '오른쪽으로'처럼 보였다
    jc: '<svg viewBox="0 0 48 48" class="jc"><path class="jc-rd" d="M13 47V39.5L2.5 27v-5L13 9V1h22v8l10.5 13v5L35 39.5V47z" fill="#2b3440" stroke="none"/>' +
      '<path d="M13 47V39.5L2.5 27v-5L13 9V1M35 1v8l10.5 13v5L35 39.5V47" fill="none" stroke="#9aa3ad" stroke-width="1.6" stroke-linejoin="round"/>' +
      '<path class="jc-isl" d="M24 19 29.5 25.5 24 32 18.5 25.5z" fill="none" stroke="#9aa3ad" stroke-width="1.7" stroke-linejoin="round"/>' +
      '<path d="M24 47V38.5" fill="none" stroke="#fff" stroke-width="5.6"/>' +
      '<path d="M24 38.8 12.8 26 16.8 18.6M24 38.8 35.2 26 31.2 18.6" fill="none" stroke="#fff" stroke-width="4.4" stroke-linecap="round" stroke-linejoin="round"/>' +
      '<path d="M19.95 12.8 20.23 20.46 13.37 16.74zM28.05 12.8 27.77 20.46 34.63 16.74z" fill="#fff" stroke="#fff" stroke-width=".8" stroke-linejoin="round"/></svg>' });
  // v143 차로 따라 비켜 가기(도로 주행·본선 그대로, iconKind): 네이버 '1.6km' 그림처럼 직진 화살표의 밑동이 반대쪽에서 살짝 넘어온다.
  // 'ti' 그림(색은 테슬라 모드에서 네이버 초록, 아니면 흰색 — 직진·좌우회전 그림과 같은 굵기)
  const keepIcon = (left) => '<svg viewBox="0 0 48 48" class="ti keep2 ' + (left ? 'ml' : 'mr') + '"><g' + (left ? ' transform="matrix(-1 0 0 1 48 0)"' : '') + '>' +
    '<path d="M18 44.5V36c0-2.3.9-3.8 2.6-5.4l6.8-6.3c1.7-1.6 2.6-3.1 2.6-5.4V15" fill="none" stroke="currentColor" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>' +
    '<path d="M30 3 41.5 17.5h-23z" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></g></svg>';
  Object.assign(TURN_ICONS, { ml: keepIcon(true), mr: keepIcon(false) });
  // 아직 그림이 없는 종류는 가장 가까운 그림으로 (꺾는 화살표로 잘못 보이지 않게): 순서대로 채운다
  const ICON_FALLBACK = {
    sl: 'l', sr: 'r', rb: 'r', via: 'goal', rb_l: 'rb', rb_s: 's', rb_r: 'r', rb_u: 'u', sharp_l: 'l', sharp_r: 'r',
    outs: 'outr', ins: 'inr', over_l: 'kl', under_l: 'kl', side_l: 'kl', oside_l: 'kl', over_r: 'kr', under_r: 'kr', side_r: 'kr', oside_r: 'kr',
    over_s: 's', under_s: 's', rest: 'kr', ferry: 's',
  };
  Object.keys(ICON_FALLBACK).forEach((k) => { if (!TURN_ICONS[k]) TURN_ICONS[k] = TURN_ICONS[ICON_FALLBACK[k]] || TURN_ICONS.s; });
  // 진출입로는 단순한 길 화살표로. v124 (2026-11-15 요청 '터널 고가 안내 같은건 아이콘 만들어서 적용해 줘'):
  // 지하차도·고가·옆길(under_*, over_*, side_*, oside_*)은 전용 그림(img/ai, 초록 경로선)을 쓴다 — 예전엔 여기서 직진·비켜 가기 화살표로 바꿔 그렸다
  const PLAIN_ROAD = {
    outs: 's', ins: 's',   // v137: 오른쪽·왼쪽 나가기/들어가기는 다시 OUT·IN 그림(rampIcon). 곧게 나가기/들어가기만 직진 화살표
    // v125 (2026-11-15 밤): 휴게소 진입은 흰 그림 대신 초록 비켜 가기(오른쪽), 방향 모를 회전교차로는 초록 회전교차로 그림('rb svg는 필요없지 않아?')
    rest: 'kr', rb: 'rb_r',
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
    return pickImg(PLAIN_ROAD[k] || k, 'ti') || icoBase(k);
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

  // 톨게이트 광장 구간(경로 거리): 톨게이트 안내(121~123) 지점 600m 앞 ~ 600m 뒤. 경로마다 한 번
  function tollZones() {
    if (nav.tollZonesFor === nav.route && nav.tollZones) return nav.tollZones;
    const last = nav.cum.length - 1;
    nav.tollZones = (nav.guides || []).filter((g) => g.t >= 121 && g.t <= 123).map((g) => { const s = nav.cum[Math.min(g.i, last)]; return [s - 600, s + 600]; });
    nav.tollZonesFor = nav.route;
    return nav.tollZones;
  }
  // v170 (2026-11-20 운전자 '회전교차로나 우회전 고속도로 나갈 때 이탈이 잘 되는 느낌 … 직진 차로로 갑자기 회전하기 전에 경로가 바뀌어버려'):
  // 네이버 경로선은 진출로·회전교차로·우회전에서 모서리를 질러 간다. 아직 본선 바깥 차로에 있는 차가 경로선에서 18m 넘게 떨어지고 방향이
  // 45°쯤 달라 보여 1~2초 만에 '경로 이탈' → 차 60m 앞(직진 쪽)에서 다시 찾아 회전 없는 직진 경로로 바뀌었다.
  // 회전·진출·갈림길 안내 300m 앞 ~ 120m 뒤(회전교차로는 250m 뒤까지)는 허용폭을 60m 로 넓히고, 거꾸로 가는 것(100° 넘게)만 바로 보고,
  // 회전교차로 안에서는 방향과 관계없이 원 둘레 어디든 경로 위로 본다. 이탈은 시간(2초·회전 구간 4초)과 거리(20m·회전 구간 50m) 둘 다 이어질 때만
  const TURN_ZONE_SKIP = new Set(['s', 'goal', 'via', 'toll', 'rest', 'ferry']);
  function turnZones() {
    if (nav.tzFor === nav.route && nav.tz) return nav.tz;
    const z = [], last = nav.cum.length - 1;
    for (const g of nav.guides || []) {
      const k = turnKind0(g);
      if (!k || TURN_ZONE_SKIP.has(k)) continue;
      const T = nav.cum[Math.min(g.i, last)], rb = /^rb_/.test(k);
      z.push([T - 300, T + (rb ? 250 : 120), rb]);
    }
    nav.tz = z; nav.tzFor = nav.route;
    return z;
  }
  const turnZoneAt = (at) => turnZones().find(([a, b]) => at >= a && at <= b) || null;
  function navUpdate(f) {
    if (!nav.active || !nav.pts || !f) return;
    // 경유지 근처(150m)를 지나면 목록에서 뺀다 (이후 재탐색이 경유지로 되돌아가지 않게)
    if (nav.via && nav.via.length && haversine(f, nav.via[0]) < 150) {
      const v = nav.via.shift();
      toast('경유지 ' + v.name + ' 통과', '', 3000);
    }
    const pts = nav.pts;
    let best = { dist: Infinity, seg: nav.seg, t: 0 };
    const zone = turnZoneAt(nav.along), inRb = !!(zone && zone[2]);
    // 달리는 방향과 반대인 구간(유턴 뒤 맞은편 차로 등)에는 붙지 않는다. v170: 회전교차로 안에서는 둘레 어느 쪽이든 붙는다
    const useHeading = state.heading !== null && state.speedKmh > 10 && !inRb;
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
    // v135 (2026-11-16 주행 중 서울톨게이트에서 '경로 이탈' 오판정): 톨게이트 광장은 차로가 20개 넘게 넓게 퍼져 경로선(한 줄)에서
    // 50m 넘게 떨어져 달리고, 차로를 고르느라 방향도 비스듬하다. 톨게이트 안내 지점 600m 앞 ~ 600m 뒤는 100m 까지 경로 위로 보고,
    // 방향은 100° 넘게 다를 때만(되돌아가는 길) 다른 길로 본다
    const inPlaza = tollZones().some(([a, b]) => nav.along >= a && nav.along <= b);
    const offLimit = inPlaza ? 100 : zone ? 60 : Math.min(50, Math.max(30, (f.acc || 10) * 2));
    // 가장 가까운 경로 구간과 달리는 방향이 50° 넘게 다르고 18m 넘게 떨어졌으면 다른 길로 들어선 것 (30m 를 기다리지 않는다)
    let skew = 0;
    if (useHeading && best.dist > 18 && best.dist < Infinity && nav.cum[best.seg + 1] - nav.cum[best.seg] > 3) {
      skew = angleDiff(bearing(pts[best.seg], pts[best.seg + 1]), state.heading);
    }
    const wrongWay = !inRb && skew > (inPlaza || zone ? 100 : 50);   // 회전교차로 안에서는 한 바퀴 더 돌면 방향이 거꾸로다: 거리로만
    nav.onRoute = best.dist <= offLimit && !wrongWay;
    // v174 (2026-11-20 카페 시험자 '제가 가고 있는 길이 아닌 다른 길에 자동차 아이콘이 표시된 적이 있습니다'):
    // 화면의 내 차를 경로선에 붙이는 기준이 이탈 판정(보통 30~50m, 회전 구간 60m, 톨게이트 100m)과 같아서, 30m 안쪽의 나란한 길·
    // 진출로 옆 본선·고가 옆길을 달려도 아이콘이 경로 위에 그려졌다. 이탈 판정(재탐색)은 그대로 두고, 그리기만 가까울 때 붙인다:
    // 경로선 14m 안 + 방향 30° 안이면 붙이고, 붙어 있다가 22m 넘게 멀어지거나 방향이 40° 넘게 벌어지면(10m 넘게 떨어졌을 때) 실제 위치로
    {
      const segHdg = nav.cum[best.seg + 1] - nav.cum[best.seg] > 3 && best.dist < Infinity ? bearing(pts[best.seg], pts[best.seg + 1]) : null;
      const sk = segHdg !== null && state.heading !== null && state.speedKmh > 10 ? angleDiff(segHdg, state.heading) : 0;
      if (!nav.onRoute) nav.snap = false;
      else if (nav.snap) { if (best.dist > 22 || (inRb ? false : sk > 40 && best.dist > 10)) nav.snap = false; }
      else if (best.dist <= 14 && (inRb || sk <= 30)) nav.snap = true;
      nav.snapD = best.dist;
    }
    if (!nav.onRoute) { if (!nav.offAt) nav.offAt = f.t; } else nav.offAt = 0;   // v161: 경로 밖으로 나간 시각 (단속 카메라 고르기)
    if (nav.onRoute) {
      nav.seg = best.seg;
      nav.along = nav.cum[best.seg] + best.t * (nav.cum[best.seg + 1] - nav.cum[best.seg]);
      nav.off = 0; nav.offSince = 0;
      if (++nav.onCount >= 5) { nav.gap = 10000; nav.quickLeft = 0; } // 경로 위를 잘 따라가면 재탐색 간격 초기화
    } else if ((f.acc || 0) < 60 && state.speedKmh > 3 &&
               (nav.onCount > 0 || nav.rerouted || f.t - (nav.setAt || 0) > 20000)) {
      // 출발점이 도로에서 떨어진 곳(주차장 등)이면 경로에 한 번 올라탄 뒤부터 센다.
      // 다만 20초가 지나도 경로에 못 올라탔다면(엉뚱한 경로) 그때부터는 센다
      if (!nav.off) { nav.offSince = f.t; nav.offOdo = state.odo; }
      nav.off++;
    }
    // 확실히 다른 길(80m 넘게 벗어남·다른 방향)이면 2번, 아니면 3번 연속 확인되면 다시 찾는다.
    // v135: 테슬라 GPS 는 1초에 10번 와서 3번 연속이 0.3초였다 — 벗어난 채로 1초(확실히 다른 길)·2초가 지나야 한다 (1초에 한 번이면 예전과 같다)
    // v170: 시간과 거리 둘 다 — 확실히 다른 길이면 1초·10m(예전과 같이 빠르게), 보통 2초·20m, 회전 구간은 4초·50m
    // (회전 전 바깥 차로에서 서둘러 판정하지 않게. 회전 구간의 '확실히 다른 길'은 80m 넘게 벗어나거나 100° 넘게 거꾸로일 때만)
    const sure = best.dist > 80 || wrongWay;
    const need = sure ? 2 : 3;
    const offMs = sure ? 1000 : zone ? 4000 : 2000, offM = sure ? 10 : zone ? 50 : 20;
    const offLong = nav.off > 0 && f.t - (nav.offSince || f.t) >= offMs && state.odo - (nav.offOdo || state.odo) >= offM;
    // 다시 찾은 경로에 한 번도 못 올라탔으면(답이 오는 사이 차가 경로 시작점을 지나쳤으면) 간격을 기다리지 않고 한 번 바로 다시 찾는다
    const quick = nav.quickLeft > 0 && nav.rerouted && nav.onCount === 0 && f.t - (nav.setAt || 0) > 2500;
    if (nav.off >= need && offLong && !nav.busy && (quick || f.t - nav.lastReroute > nav.gap)) {
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
  // 방면 이름: 쉼표로 나누고 괄호를 빼고, 5자 이하 이름부터 2곳까지. 긴 이름은 자르지 않고 줄임말로 (문구 검토 2026-11-15)
  const ROAD_ABBR = [[/^수도권제1순환(고속도로|선)$/, '수도권1순환'], [/^서울외곽순환(고속도로|선)$/, '외곽순환'], [/고속도로$/, '고속']];
  function dirNames(list) {
    const n = String(list || '').replace(/\s*\([^)]*\)/g, '').split(',').map((x) => x.replace(/\s*\([^)]*$/, '').trim()).filter(Boolean);
    const short = n.filter((x) => x.length <= 5);
    return (short.length ? short : n.map((x) => ROAD_ABBR.reduce((s, [re, to]) => s.replace(re, to), x))).slice(0, 2);
  }
  // 패널 안내 문장: '복정교차로에서 '남한산성, 송파·복정·위례, 잠실역' 방면으로 오른쪽 도시고속도로 출구'
  //   → '복정교차로에서 오른쪽 출구 · 남한산성, 잠실역 방면' (잘려도 동작이 남게). 음성은 원문 그대로
  function guideText(s, straight) {
    const m = String(s || '').match(/^(?:(.+?)에서\s+)?(?:'([^']+)'\s*방면으로\s+)?(.+)$/);
    if (!m) return s;
    let place = m[1] || '', act = straight ? '직진' : m[3];   // v133: 본선 그대로(mainKeep)면 '왼쪽 방향' 대신 '직진'
    act = act.replace(/(왼쪽|오른쪽)\s+(?:도시)?고속도로\s+(출구|진입)$/, '$1 $2')
      .replace(/(왼쪽|오른쪽)\s+도로\s+주행$/, '$1 방향')
      .replace(/^지하차도\s+(왼쪽|오른쪽)\s+옆길$/, '$1 옆길')
      .replace(/^분기\s*도로\s*진입$/, '분기 후 합류');   // v137: 네이버 지도 앱이 같은 안내를 '분기 후 합류'로 보여 준다
    const k = place.match(/(지하차도|고가차도|터널)$/);
    const r = k && act.match(new RegExp('^(?:(왼쪽|오른쪽)\\s+)?' + k[1] + '\\s+진입$'));
    if (r) { act = (r[1] ? r[1] + ' ' : '') + place + ' 진입'; place = ''; }
    const d = dirNames(m[2]);
    return (place ? place + '에서 ' : '') + act + (d.length ? ' · ' + d.join(', ') + '\u00a0방면' : '');   // '방면' 한 낱말만 다음 줄로 떨어지지 않게
  }
  // 통행료 글: '통행료 800원' → '800원', 0원은 '무료'
  const fareText = (f) => { const x = String(f || '').replace(/^통행료\s*/, ''); return /^0\s*원$/.test(x) ? '무료' : x; };
  function tollParts(g) {
    // 요금은 맨 끝 괄호: '남산1호터널톨게이트(도심) (통행료 0원)' → 이름 '남산1호터널톨게이트(도심)', 요금 '통행료 0원'
    // (첫 괄호에서 자르면 요금 칸에 '도심) (통행료 0원'이 나왔다, 2026-11-14 남산1호터널 확인)
    const m = String(g.s || '').match(/^(.*)\((\s*[^()]*)\)\s*$/);
    // 이름 끝의 '(도심)' 같은 괄호는 화면·음성에서 뺀다 (v110 문구 검토). 하이패스 영업소 찾기(hipassKey)도 괄호를 떼고 찾는다
    const name = ((m ? m[1].trim() : g.s) || '').replace(/\s*\([^()]*\)\s*$/, '').trim();
    return { name: name || '톨게이트', fare: m ? m[2].trim() : '' };
  }
  function announceTurn(g, dg) {
    const said = nav.said[g.i] || (nav.said[g.i] = {});
    const fast = state.speedKmh > 60;
    const toll = g.t === 121;
    const text = toll ? (() => { const p = tollParts(g), f = fareText(p.fare); return p.name + (f ? ', ' + (f === '무료' ? '통행료 무료' : '통행료 ' + f) : '') + '. 하이패스 차로를 이용하세요'; })() : g.s;
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
  const JUNC_ENTRY = new Set([57, 59, 66, 68, 76, 77]);               // 진입로: 본선으로 합류 (2026-11-15: 진출 그림이 나오던 것)
  // 고가·지하차도·옆길 (2026-11-15 '안내 표기가 어려우면 밑에처럼 이미지로')
  const JUNC_ROAD = { 62: 'over', 71: 'over', 64: 'under', 73: 'under', 63: 'oside', 72: 'oside', 65: 'side', 74: 'side' };   // v110: 55·56(직진)은 빼다
  const JUNC_SHOW = 800;
  const juncState = { g: null, key: '' };
  function juncInfo(g) {
    if (!g || (!JUNC_FORK.has(g.t) && !JUNC_RAMP.has(g.t) && !JUNC_ROAD[g.t])) return null;
    const s = String(g.s || '');
    // v141: 좌우는 안내 아이콘과 같은 값 (turnKind0 → kindSide). 방향 없는 전방 분기(54 → 'jc')는 그림 없음
    const side = kindSide(turnKind0(g));
    if (!side) return null;
    const left = side === 'l';
    const m = s.match(/^(.*?)에서\s/);
    const q = s.match(/'([^']+)'/);
    const label = dirNames(q ? q[1] : '').join(' · ');   // 패널 문장과 같은 규칙 (dirNames)
    // 진입(57·59·66·68·76·77)도 '그쪽으로 비켜 나가는' 진출 그림: 안내 지점에서는 연결로로 갈라져 들어가므로 (v110, 합류 그림은 뺌)
    // v133: 본선을 그대로 가는 갈림길(mainKeep)은 '본선 직진 + 옆으로 갈라지는 연결로' 그림 (left = 본선이 연결로의 왼쪽)
    const kind = mainKeep(g) ? 'main' : JUNC_ROAD[g.t] || (JUNC_RAMP.has(g.t) ? 'ramp' : 'fork');
    return { kind, left, place: m ? m[1] : '', label, names: dirNames(q ? q[1] : ''),
      hwy: /고속|분기점|IC\b|JC\b|IC에서|JC에서/i.test(s) || (g.t >= 57 && g.t <= 69 && !JUNC_ROAD[g.t]) };
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
    } else if (j.kind === 'main') {
      // v133 본선 직진: 본선은 곧게(파랗게 + 곧은 화살표), 연결로가 오른쪽(본선이 왼쪽이면 j.left)으로 갈라진다. 그림은 연결로가 오른쪽인 모양
      const flip = (c) => (j.left ? c : c.map((q) => [-q[0], q[1]]));
      const main = flip(jvCurve([[0, 0], [0, 200], [0, 450], [0, 700]], 70));
      const ramp = flip(jvCurve([[7.6, 0], [7.6, 38], [13, 70], [72, 210]], 48));
      roads = [[main, 11.4], [ramp, 4.6]];
      lanes = jvDashes(main, -1.9, 4, 700) + jvDashes(main, 1.9, 4, 700);
      route = main; end = 70;
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
  // ---------- 분기점 그림 위 방면 표지판 (v115, 2026-11-15 요청: 카카오·T맵처럼 '이런 식의 안내') ----------
  // (길 위에 방면 글씨를 원근으로 칠하는 것도 해 봤지만, 서랍 그림이 290×110px 이라 글씨가 8px 남짓으로 읽히지 않아 뺐다)
  // 표지판: 고속도로는 초록, 일반 도로는 파랑. 흰 테두리, 가는 방향 화살표(↗/↖), 고속도로 이름이면 노선 번호 방패.
  // 노선 번호는 확실한 것만 (모르면 방패 없이 이름만). '중부내륙'·'제2경인'은 '중부'·'경인'보다 먼저
  const EXPWAY_NO = [[/^중부내륙/, 45], [/^(중부|통영대전)/, 35], [/^제2경인/, 110], [/^경인/, 120], [/^경부/, 1], [/^남해/, 10],
    [/^서해안/, 15], [/^호남/, 25], [/^당진영덕/, 30], [/^평택제천/, 40], [/^영동/, 50], [/^중앙/, 55], [/^서울양양/, 60], [/^동해/, 65],
    [/^(수도권1순환|수도권제1순환|외곽순환|서울외곽)/, 100], [/^인천국제공항/, 130], [/^용인서울/, 171], [/^(수도권2순환|수도권제2순환)/, 400]];
  function expwayNo(name) {
    const n = String(name || '').replace(/\s+/g, '');
    if (!/고속|순환/.test(n)) return 0;
    const hit = EXPWAY_NO.find(([re]) => re.test(n));
    return hit ? hit[1] : 0;
  }
  const shieldSvg = (no) => '<svg viewBox="0 0 26 28" aria-hidden="true"><path d="M2 2h22v14c0 5.6-5.4 8.6-11 10.4C7.4 24.6 2 21.6 2 16z" fill="#1f4fa8" stroke="#fff" stroke-width="1.8"/>' +
    '<path d="M3 3h20v5.4H3z" fill="#d93a2f"/><text x="13" y="20.6" text-anchor="middle" font-size="' + (no >= 100 ? 9.6 : 11.5) + '" font-weight="800" fill="#fff" font-family="system-ui, sans-serif">' + no + '</text></svg>';
  // 표지판 화살표: 곧게 올라가다 오른쪽 위로 꺾임 (왼쪽은 CSS 로 좌우 뒤집기)
  const SIGN_ARROW = '<svg viewBox="0 0 24 30" aria-hidden="true"><path d="M8 28V15.5L16.5 7" fill="none" stroke="#fff" stroke-width="3.6" stroke-linecap="round" stroke-linejoin="round"/>' +
    '<path d="M11.2 3.6 21.6 2.4 20.4 12.8z" fill="#fff" stroke="#fff" stroke-width="1.2" stroke-linejoin="round"/></svg>';
  // v133 본선 직진 표지: 곧게 위로 ('↑ 서울')
  const SIGN_ARROW_S = '<svg viewBox="0 0 24 30" aria-hidden="true"><path d="M12 28V10" fill="none" stroke="#fff" stroke-width="3.6" stroke-linecap="round"/>' +
    '<path d="M12 2.5 19 12H5z" fill="#fff" stroke="#fff" stroke-width="1.2" stroke-linejoin="round"/></svg>';
  function juncSignHtml(names, straight) {
    const one = names.join('').length <= 7;   // 짧으면 한 줄('서울 대전'), 길면 두 줄로 쌓는다 (그림을 덜 가리게)
    const rows = names.map((n) => { const no = expwayNo(n); return '<span class="sg-row">' + (no ? '<i class="sg-shield">' + shieldSvg(no) + '</i>' : '') + '<b>' + esc(n) + '</b></span>'; });
    return '<span class="sg-names' + (one ? ' one' : '') + '">' + rows.join('') + '</span><span class="sg-arrow">' + (straight ? SIGN_ARROW_S : SIGN_ARROW) + '</span>';
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
    el._d = nav.dg;   // 서랍 칸 순서 (v158): 안내 지점까지
    const key = g.i + ':' + g.t + ':' + g.s;
    if (juncState.key !== key) {
      juncState.key = key;
      // AI 분기점 장면(낮·밤, 오른쪽 그림. 왼쪽은 CSS 로 좌우 뒤집기)을 골라 두었으면 그것을, 아니면 그려 넣은 원근 그림 (2026-11-15 요청)
      const jd = ICON_PICKS['junc_' + j.kind + '_day'], jn = ICON_PICKS['junc_' + j.kind + '_night'];
      const jimg = (f, c) => '<img class="jv-img ' + c + ' jc-' + j.kind + '" src="' + APP_BASE + 'img/ai/' + f + '?v=' + APP_VERSION + '" alt="" draggable="false">';
      $('#juncSvg').innerHTML = jd && jn ? jimg(jd, 'jv-day') + jimg(jn, 'jv-night') : juncSvg(j.kind === 'entry' ? Object.assign({}, j, { kind: 'ramp' }) : j);
      // 방면 표지판 (v115). 방면이 없으면 비운다(빈 칸은 CSS 로 숨김). '오른쪽'을 지어 넣지 않는다
      $('#juncLabel').innerHTML = j.names.length ? juncSignHtml(j.names, j.kind === 'main') : '';
      $('#juncLabel').dataset.names = j.label;
      $('#juncLabel').setAttribute('aria-label', j.label ? j.label + ' 방면' : '');
      $('#juncPlace').textContent = j.place;
      el.classList.toggle('left', j.left);
      el.classList.toggle('main', j.kind === 'main');
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
  // 톨게이트 안내 → [영업소 이름, 자료]. 본선 영업소는 자료 이름에 '(본)'이 붙기도 한다 (네이버 '남양주톨게이트' → '남양주(본)')
  // v142 (2026-11-16 운전자 '가는 방향이 있어 확실히 있는 거야?' — 확실할 때만): 같은 이름으로 폐쇄식(입구·출구)과 개방식(상행·하행)
  // 영업소가 따로 있는 곳(전국 자료에서 서영암·대동·가락 3곳)은 네이버 안내가 어느 쪽인지 알 수 없어 차로 자료가 없는 것으로 본다
  // (전에는 둘이 한 이름에 섞여 개방식 줄을 썼다). 카드·'하이패스 차로 이용'은 그대로, 차로 칸만 안 보인다
  const hipassMixed = (o) => !!o && !!(o.i || o.x) && !!(o.u || o.d);
  function hipassOffice(g) {
    const k = hipassKey(tollParts(g).name);
    const [name, o] = hipass.o[k] ? [k, hipass.o[k]] : hipass.o[k + '(본)'] ? [k + '(본)', hipass.o[k + '(본)']] : [k, null];
    return [name, hipassMixed(o) ? null : o];
  }
  // 톨게이트 앞뒤 400m 로 잰 진행 방향이 지점 to 쪽이면 'u', 반대면 'd', 애매하면 '' (진입로 굽이에 흔들리지 않게).
  // 실제 경로: 하남IC→중부 상행 6°, 하남IC 출구(하행) 140°, 판교IC→경부 상행 20°
  function tollHeading(g) {
    if (!nav.pts) return null;
    const last = nav.pts.length - 1, i = Math.min(g.i, last), s0 = nav.cum[i];
    let a = i, b = i;
    while (a > 0 && s0 - nav.cum[a] < 400) a--;
    while (b < last && nav.cum[b] - s0 < 400) b++;
    return a === b ? null : bearing(nav.pts[a], nav.pts[b]);
  }
  function towardDir(g, to) {
    const h = tollHeading(g);
    if (h === null) return '';
    const diff = angleDiff(h, bearing(nav.pts[Math.min(g.i, nav.pts.length - 1)], to));
    return diff <= 50 ? 'u' : diff >= 130 ? 'd' : '';
  }
  // 본선 영업소(고속도로 본선을 가로막는 큰 폐쇄식 톨게이트): 지나가는 방향만으로 입구·출구가 정해진다 — 이 도시 쪽으로 가면 폐쇄식
  // 구간을 나가는 출구, 반대면 들어가는 입구. 진입 안내·앞선 톨게이트로 고르는 규칙보다 먼저 (v134, 2026-11-16 서울TG 제보: 경부 북행인데
  // 하이패스 4개만 — 경로가 경부 위에서 시작하거나 바로 앞 IC 진입 안내 때문에 입구로 보거나 방향을 몰라 입구·출구 공통인 1~4번만 나왔고,
  // 출구 14~16번 하이패스가 빠졌다). 군자·장유·서대구는 어느 쪽이 출구인지 확실하지 않아 넣지 않았다 (모르면 양쪽 공통 차로만)
  const MAIN_TG = { 서울: SEOUL, 동서울: SEOUL, 서서울: SEOUL, '남양주(본)': SEOUL, 부산: { lat: 35.1796, lng: 129.0756 } };
  // 폐쇄식 영업소: 고속도로에 들어가는 톨게이트(앞 4km 안에 고속도로 진입 안내)면 입구 차로, 나오는 곳(앞 3km 안에 출구 안내)이면 출구 차로
  function tollSide(g) {
    const [name] = hipassOffice(g);
    if (MAIN_TG[name]) {
      const d = towardDir(g, MAIN_TG[name]);
      if (d) return d === 'u' ? '출구' : '입구';
    }
    const closed = (x) => { const o = hipassOffice(x)[1]; return !!o && !o.t; };
    const last = nav.cum.length - 1, sg = nav.cum[Math.min(g.i, last)];
    let side = '';
    for (const x of nav.guides || []) {
      const s = nav.cum[Math.min(x.i, last)];
      if (s >= sg) break;
      if (sg - s <= 4000 && HW_IN.has(x.t)) side = '입구';
      if (sg - s <= 3000 && HW_OUT.has(x.t)) side = '출구';
      // 진입 안내 뒤 다른 폐쇄식 톨게이트를 먼저 지나면 그곳이 들어간 입구 — 이번은 나가는 쪽 (수원신갈IC 로 들어와 서울TG 등)
      if (side === '입구' && x.t === 121 && closed(x)) side = '출구';
    }
    if (side) return side;
    // 안내로 모르면: 같은 경로에 앞서 지난 폐쇄식 톨게이트가 있으면 이번이 출구, 뒤에 또 있으면 이번이 입구
    let before = false, after = false;
    for (const x of nav.guides || []) {
      if (x === g || x.t !== 121 || !closed(x)) continue;
      if (x.i < g.i) before = true; else after = true;
    }
    return before ? '출구' : after ? '입구' : '';
  }
  // 수도권제1순환고속도로(옛 외곽순환) 위 개방식 영업소: 거리표가 판교에서 시계 방향으로 늘어나므로 반시계 방향(서울을 왼쪽에 두고
  // 도는 쪽)이 상행 (v135, 2026-11-16 제보 '성남 하이패스가 1·2·3차로만 있는 게 아니다': 판교→하남 쪽 성남TG 를 네이버는
  // 1 2 3 – 8 9 – 11 – 로 보여 주고, 이는 자료의 상행 줄과 같다). 그 전에는 방향 규칙이 없어 상행·하행 공통인 1~3번만 나왔다
  // 본선 영업소만 (토평은 IC 진입로 톨게이트라 진행 방향이 순환선 방향과 맞지 않아 뺀다)
  const RING_TG = new Set(['성남', '청계', '시흥', '김포', '구리남양주']);
  function ringDir(g) {
    const h = tollHeading(g);
    if (h === null) return '';
    const p = nav.pts[Math.min(g.i, nav.pts.length - 1)];
    // 서울에서 본 톨게이트 쪽 방향에서 90° 왼쪽으로 돌린 것이 반시계 방향 (예: 서울 동쪽이면 북쪽). 순환선은 원이 아니어서
    // 길 방향이 이 접선과 50° 넘게 벌어지기도 한다 (성남TG 북행 52°, 남행 128°). v142: 확실할 때만 — 65° 안이면 반시계, 115° 넘으면
    // 시계, 그 사이는 방향 모름(양쪽 공통 하이패스 차로만). 전에는 80°/100° 로 갈랐다
    const diff = angleDiff(h, (bearing(SEOUL, p) + 270) % 360);
    return diff <= 65 ? 'u' : diff >= 115 ? 'd' : '';
  }
  // 개방식 영업소(상행·하행)에서 우리 방향: 수도권 방사형 노선(s:1)이면 서울 쪽으로 가면 상행, 제1순환선이면 반시계가 상행. 애매하면 ''.
  const tollDir = (g, o, name) => (o.s ? towardDir(g, SEOUL) : RING_TG.has(name) ? ringDir(g) : '');
  // 차로 한 글자씩 (tools/build_hipass.py): H 하이패스 · M 다차로하이패스 · B 하이패스+유인 · h 화물차-하이패스 → 하이패스(파란 칸),
  // T 유인 · P 정산기 · b/t 화물차 유인 차로 → 회색 칸, x 미운영(토목차로)·- 빈 칸 → 흐린 칸.
  // v135: 화물차-하이패스(h)도 파랗게 — 네이버 지도가 하이패스로 보여 준다 (성남TG 상행 11번)
  const LANE_KIND = { H: 'hp', M: 'hp', B: 'hp', h: 'hp', T: 'op', P: 'op', b: 'op', t: 'op', x: 'off', '-': 'off' };
  const laneNums = (code) => [...String(code || '')].map((c, k) => (LANE_KIND[c] === 'hp' ? k + 1 : 0)).filter(Boolean);
  // 우리 방향의 차로 줄(code)을 고른다. 방향을 모르면: 두 방향 차로가 같으면 그 줄, 다르면 줄 없이 양쪽 다 하이패스인 번호만 (틀리지 않게)
  function hipassLayout(g) {
    const [name, o] = hipassOffice(g);
    if (!o) return { code: '', nums: [] };
    let a, b, mine = '';
    if (o.t) { const d = tollDir(g, o, name); mine = d ? o[d] : ''; a = o.u; b = o.d; } else {
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
  // 하이패스 칸 아래 차로 줄: 하이패스 차로는 번호를 단 파란 칸, 그 사이 하이패스가 아닌 차로(유인·정산기·화물차 유인·미운영)는
  // 몇 개든 '–' 회색 칸 하나로 (v135, 네이버 지도처럼: 성남TG 1 2 3 – 8 9 – 11 –, 서울TG 출구 1 2 3 4 – 14 15 16 –).
  // 그 전(2026-11-14~v134)에는 모든 차로를 번호 칸으로 늘어놓고 미운영 3개 넘게·긴 회색 무리만 '⋯'로 접어, 큰 영업소에서 칸이 좁고 많았다
  function laneStripHtml(code, max) {   // max: 예전 접기 기준 (쓰지 않음). 칸 배치는 fitTollLanes
    const out = [];
    let run = false;
    [...String(code || '')].forEach((c, k) => {
      if (LANE_KIND[c] === 'hp') { out.push('<b class="ln hp">' + (k + 1) + '</b>'); run = false; } else if (!run) { out.push('<b class="ln dash">–</b>'); run = true; }
    });
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
    const show = tollState.nums.length > 0;
    el.hidden = !show;
    $('#tollCard').classList.toggle('has-lanes', show);
    if (show) fitTollLanes(el, beside);
  }
  // v142 (2026-11-16 20:30 성남TG 1.6km 앞 남행: 배지 옆 한 줄 '1 2 3 – 6 7 – 9'에서 9가 카드 밖으로 반쯤 잘리고 뒤 '–'는 안 보임.
  // 운전자 '이게 많으면 그냥 가운데 밑에다가 보여줘 … 꼭 숫자를'): 칸이 배지 옆에 넉넉히(칸 26px) 안 들어가면 배지는 가운데 위,
  // 칸은 그 아래 줄 가운데로. 아래 줄에서 칸이 22px 밑으로 작아져야 하면 줄을 나눠(줄마다 거의 같은 수) 가운데로 — 글자를 줄이지 않는다.
  // 하이패스가 아닌 차로 '–' 칸은 그대로 둔다 (네이버와 같고, 몇 번 차로인지 세는 데 필요). 방향을 몰라 번호만 보일 때(시흥·김포 6개)도 같게
  const TOLL_FIT = { gap: 3, min: 22, side: 26, name: 90 };
  function fitTollLanes(el, beside) {
    const card = $('#tollCard'), cs = getComputedStyle(card);
    const W = card.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    if (!(W > 0)) return;   // 안 보이는 중 (다음 그리기에서)
    const cells = el.querySelectorAll('.ln'), n = cells.length, compact = el.classList.contains('compact');
    const cg = parseFloat(cs.columnGap) || 0, badge = card.querySelector('.toll-badge').getBoundingClientRect().width;
    const dist = $('#tollDist'), distW = dist.hidden ? 0 : dist.getBoundingClientRect().width + cg;
    // 차로 줄(code)은 톨게이트가 다음 안내일 때만 배지 옆, 아니면 원래 따로 한 줄. 번호만이면 이름 옆
    let under = !beside && !compact;
    if (!under) {
      const need = compact ? [...cells].reduce((s, c) => s + Math.max(26, 12 + 10 * c.textContent.length), 0) + 4 * (n - 1)
        : n * TOLL_FIT.side + TOLL_FIT.gap * (n - 1);
      under = need > W - badge - cg - (beside ? 2 : TOLL_FIT.name + cg + distW);
    }
    card.classList.toggle('lanes-under', under && (beside || compact));
    let per = n;
    if (under) {
      const cell = compact ? 34 : TOLL_FIT.min, g = compact ? 4 : TOLL_FIT.gap;
      const fit = Math.max(1, Math.floor((W + g) / (cell + g)));
      per = Math.ceil(n / Math.ceil(n / fit));
    }
    const rows = Math.ceil(n / per);
    if (el.dataset.per !== String(per) || el.querySelectorAll('.ln-br').length !== rows - 1) {
      el.querySelectorAll('.ln-br').forEach((b) => b.remove());
      for (let k = per; k < n; k += per) { const br = document.createElement('i'); br.className = 'ln-br'; cells[k].before(br); }
      el.dataset.per = String(per);
    }
    el.dataset.rows = String(rows);
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
    el._d = ahead;
    // 이 톨게이트가 길안내 패널의 다음 안내면 거리가 패널에 크게 나오므로 여기서는 뺀다 (2026-11-14: 같은 미터기는 안 보여도 됨).
    // 그다음 칸('TG 300m')에 나올 때도 뺀다 (2026-11-14 실제 앱 흉내 주행 화면에 사용자가 '700m'에 X 표시: 패널의 'TG 300m'와 겹쳐 헷갈림.
    // 거리를 빼면 이름 '하남톨게이트'도 잘리지 않는다)
    $('#tollDist').hidden = g === nav.next || (!!nav.next && nav.guides[nav.gi + 1] === g);
    // 패널에 이름·통행료가 이미 크게 나오면 여기서는 이름 줄도 빼고 차로 번호를 넓게
    el.classList.toggle('is-next', g === nav.next);
    renderTollLanes(g);
    $('#tollFare').textContent = fareText(p.fare); // '800원'만 (한 줄 카드라 짧게). 하이패스 안내 문구는 둘째 줄에 고정
    syncDrawer();
  }
  // ---------- 차로 안내 (시험판, 2026-11-15 요청 '좌회전·우회전은 몇 번 차로'): 국토지리정보원 정밀도로지도(차로 단위 지도)에서
  // 교차로 진입부마다 차로별 갈 수 있는 방향(정지선 앞 노면 화살표, 없으면 교차로 안 차로 연결선)을 뽑아 data/lanes.json 에 담는다
  // (tools/build_lanes.py). 정밀도로지도를 받은 곳만 (처음: 서울 강동구 도로 20구간 · 국도 6호선). 네이버 경로의 회전(좌·우·유턴) 지점
  // 바로 앞(정지선이 회전 지점 8m 뒤~70m 앞, 옆으로 22m 안, 방향 35° 안)의 진입부를 찾아, 회전 500m 앞부터 안내 줄 밑에 차로 칸을 그리고
  // 그 방향으로 갈 수 있는 차로를 파랗게. 그 방향 차로가 없는 진입부(따로 갈라지는 우회전 전용 차로 등)는 아무것도 안 보인다
  const lanesData = { loaded: false, n: 0, lat: null, lng: null, h: null, pat: null, pats: [], grid: new Map(), date: '', areas: [] };
  const laneState = { key: '', hit: null, rowHit: null };
  const LANE_SHOW = 500;
  const LANE_MOVE = { l: 'L', sharp_l: 'L', r: 'R', sharp_r: 'R', u: 'U' };
  function setLaneData(j) {
    lanesData.loaded = false; lanesData.grid = new Map(); laneState.key = ''; nav.laneCache = null; nav.laneStraight = null;
    if (!j || !Array.isArray(j.d) || !Array.isArray(j.pats)) return;
    const n = j.count, sc = j.scale || 1e5, d = j.d;
    const lat = new Float64Array(n), lng = new Float64Array(n), h = new Int16Array(n), pat = new Int32Array(n);
    let a = 0, b = 0;
    for (let k = 0; k < n; k++) {
      a += d[4 * k]; b += d[4 * k + 1];
      lat[k] = a / sc; lng[k] = b / sc; h[k] = d[4 * k + 2]; pat[k] = d[4 * k + 3];
      const key = Math.floor(lat[k] * 100) + ':' + Math.floor(lng[k] * 100);
      let cell = lanesData.grid.get(key);
      if (!cell) lanesData.grid.set(key, cell = []);
      cell.push(k);
    }
    Object.assign(lanesData, { n, lat, lng, h, pat, pats: j.pats.map((p) => String(p).split('|')), date: j.date || '', areas: j.areas || [], loaded: true });
  }
  async function loadLanes() {
    try {
      const r = await fetch('data/lanes.json?v=' + APP_VERSION);
      if (r.ok) setLaneData(await r.json());
    } catch (e) { /* 차로 자료가 없으면 차로 칸 없이 */ }
  }
  // ---------- 고속도로 분기점·나들목 앞 차로 (v153, 2026-11-16 사용자 '차선표기' — 경부 신갈분기점에서 네이버처럼
  // [버스][↑][↑][↑][↱][↱][↱]) ----------
  // data/forks.json (tools/build_forks.py, 국토지리정보원 정밀도로지도 고속국도): 분기 앞 차로 단면마다 차로 글자(S 본선·R/L 출구·
  // 끝 B 버스전용)와 차로마다 하류 2km 에서 닿는 갈래 끝점. 길안내 경로가 실제로 지나는 갈래(끝점이 경로 30m 안)로 가는 차로를
  // 파랗게 칠한다 — 출구가 둘 이상이어도 '오른쪽' 글자로 고르지 않는다. 버스전용차로는 갈 차로에서 뺀다(그 갈래가 버스 칸뿐이면 둔다).
  // 경로 위 다음 단면이 1km 안이면 서랍 차로 칸에 (지나가면 다음 단면으로 바뀐다). 자료가 있는 곳: 경부고속도로
  const forksData = { loaded: false, rows: [], ends: [], grid: new Map(), areas: [] };
  const FORK_SHOW = 1000, FORK_SIDE = 18, FORK_END = 30, FORK_AHEAD = 2600;
  function setForkData(j) {
    forksData.loaded = false; forksData.grid = new Map(); forksData.rows = []; nav.forkList = null; laneState.key = '';
    if (!j || !Array.isArray(j.rows) || !Array.isArray(j.ends)) return;
    forksData.rows = j.rows.map((r) => ({ lat: +r[0], lng: +r[1], h: +r[2], lanes: String(r[3]).split('|'), cl: r[4] || [] }));
    forksData.ends = j.ends;
    forksData.rows.forEach((r, k) => {
      const key = Math.floor(r.lat * 100) + ':' + Math.floor(r.lng * 100);
      let c = forksData.grid.get(key);
      if (!c) forksData.grid.set(key, c = []);
      c.push(k);
    });
    forksData.areas = j.areas || [];
    forksData.loaded = true;
  }
  async function loadForks() {
    try {
      const r = await fetch('data/forks.json?v=' + APP_VERSION);
      if (r.ok) setForkData(await r.json());
    } catch (e) { /* 분기 차로 자료가 없으면 칸 없이 */ }
  }
  // 경로 위 분기 단면들 (경로가 바뀔 때 한 번): [{ at, k, lanes, ok, M }] at 순서
  function ensureRouteForks() {
    if (nav.forkList) return nav.forkList;
    const out = [];
    if (!forksData.loaded || !nav.pts || nav.pts.length < 2) return out;
    const pts = nav.pts, cum = nav.cum, last = pts.length - 1;
    const best = new Map();
    for (let i = 0; i < last; i++) {
      const a = pts[i], b = pts[i + 1], len = cum[i + 1] - cum[i];
      if (len <= 0) continue;
      const brg = bearing(a, b);
      const cells = new Set();
      const steps = Math.max(1, Math.ceil(len / 400));
      for (let q = 0; q <= steps; q++) {
        const la = a.lat + (b.lat - a.lat) * q / steps, ln = a.lng + (b.lng - a.lng) * q / steps;
        for (let y = -1; y <= 1; y++) for (let x = -1; x <= 1; x++) cells.add((Math.floor(la * 100) + y) + ':' + (Math.floor(ln * 100) + x));
      }
      for (const c of cells) for (const k of forksData.grid.get(c) || []) {
        const r = forksData.rows[k];
        if (angleDiff(r.h, brg) > 30) continue;
        const pr = projectSeg(r, a, b);
        if (pr.dist > FORK_SIDE || (pr.t <= 0 && i > 0) || (pr.t >= 1 && i < last - 1)) continue;
        const at = cum[i] + pr.t * len;
        const o = best.get(k);
        if (!o || pr.dist < o.side) best.set(k, { at, side: pr.dist });
      }
    }
    // 끝점이 경로(그 단면 뒤 FORK_AHEAD m 안) 30m 안인가
    const onRoute = (e, from) => {
      const p = { lat: e[0], lng: e[1] };
      for (let i = 0; i < last; i++) {
        if (cum[i + 1] < from || cum[i] > from + FORK_AHEAD) continue;
        if (projectSeg(p, pts[i], pts[i + 1]).dist <= FORK_END) return true;
      }
      return false;
    };
    for (const [k, o] of best) {
      const r = forksData.rows[k];
      const used = [...new Set(r.cl.flat())];
      const hitEnds = new Set(used.filter((e) => forksData.ends[e] && onRoute(forksData.ends[e], o.at)));
      if (!hitEnds.size) continue;                                  // 경로가 어느 갈래로도 안 감 (자료 밖으로 감)
      const all = r.lanes.map((m, i) => ((r.cl[i] || []).some((e) => hitEnds.has(e)) ? i : -1)).filter((i) => i >= 0);
      const car = all.filter((i) => !isBusLane(r.lanes[i]));
      const ok = car.length ? car : all;
      if (!ok.length || ok.length === r.lanes.length) continue;       // 다 갈 수 있으면 알려 줄 것이 없음
      // 본선 끝점: 'S' 만 있는 차로가 닿는 끝점. 경로가 그쪽이면 S, 아니면 그 갈래 차로의 출구 쪽 글자
      const sIdx = r.lanes.findIndex((m) => m.replace('B', '') === 'S');
      const mainE = sIdx >= 0 ? (r.cl[sIdx] || [])[0] : null;
      let M = 'S';
      if (mainE == null || !hitEnds.has(mainE)) {
        const lane = r.lanes[ok[0]].replace('B', '');
        M = lane.indexOf('R') >= 0 ? 'R' : lane.indexOf('L') >= 0 ? 'L' : 'S';
      }
      out.push({ at: o.at, k, lanes: r.lanes, ok, M });
    }
    out.sort((u, v) => u.at - v.at);
    nav.forkList = out;
    return out;
  }
  // 다음 길안내(분기점·나들목·직진 안내) 1km 앞부터, 그 안내 지점보다 앞의 다음 단면 (안내 없이 지나는 나들목 앞에서는 안 띄운다).
  // 경로가 지나는 갈래 끝점이 자료에 없으면(연결로가 다른 노선 자료에 있는 분기점: 경부 북행 판교분기점) 그 단면은 건너뛴다 — 틀린 칸보다 없는 편
  function forkLane() {
    const g = nav.next;
    if (!g || nav.dg == null || nav.dg > FORK_SHOW) return null;
    const sg = nav.cum[Math.min(g.i, nav.cum.length - 1)];
    const list = ensureRouteForks();
    for (const x of list) {
      const d = x.at - nav.along;
      if (d < -5) continue;
      return d <= FORK_SHOW && x.at <= sg + 50 ? Object.assign({ d, fork: true }, x) : null;
    }
    return null;
  }
  // ---------- 노면 색깔 유도선 (v162, 2026-11-19 운전자 '고속도로나 우회전 좌회전 빠질때 보통 녹색 분홍색 안내선 있는거 알지?') ----------
  // data/colorlines.json (tools/build_colorlines.py): 한국도로공사 노면색깔유도선 현황(2026-08, 색)과 재도색 현황(2024-06, 선 위 방면 글자)을
  // OSM 갈래 모양으로 확인한 고속도로 분기점·나들목만 들어 있다 (글자 좌우가 실제 갈래 좌우와 반대인 줄은 빠짐: 경부 하행 신갈분기점).
  // 줄마다 색 선이 갈라지기 시작하는 본선 점·진행 방향과 갈래들(색, 끝점 — 다른 갈래에서 60m 넘게 떨어진 첫 점).
  // 길안내 경로가 그 점을 같은 방향(30°)으로 25m 안에 지나고, 갈래 끝점 하나만 25m 안에 지나면 그 갈래 색을 1km 앞부터
  // 안내 카드 밑 줄에 '분홍색 유도선 따라가기'로 (끝점을 지나면 사라짐). 경로가 어느 갈래에도 안 가면(본선 그대로) 안 보인다 — 틀린 색보다 없는 편
  const clData = { loaded: false, rows: [], grid: new Map() };
  const CL_SHOW = 1000, CL_SIDE = 25, CL_END = 25, CL_AHEAD = 3000;
  const CL_COLORS = { p: { name: '분홍색', css: '#ff4fa3' }, g: { name: '녹색', css: '#16a34a' }, lg: { name: '연한 녹색', css: '#7ed957' } };
  function setColorLines(j) {
    clData.loaded = false; clData.grid = new Map(); clData.rows = []; nav.clList = null;
    if (!j || !Array.isArray(j.rows)) return;
    clData.rows = j.rows.map((r) => ({ lat: +r[0], lng: +r[1], h: +r[2], name: String(r[4] || ''),
      br: (r[3] || []).map((b) => ({ c: String(b[0]), lat: +b[1], lng: +b[2] })) }))
      .filter((r) => r.br.length && r.br.every((b) => CL_COLORS[b.c]));
    clData.rows.forEach((r, k) => {
      const key = Math.floor(r.lat * 100) + ':' + Math.floor(r.lng * 100);
      let c = clData.grid.get(key);
      if (!c) clData.grid.set(key, c = []);
      c.push(k);
    });
    clData.loaded = true;
  }
  async function loadColorLines() {
    try {
      const r = await fetch('data/colorlines.json?v=' + APP_VERSION);
      if (r.ok) setColorLines(await r.json());
    } catch (e) { /* 유도선 자료가 없으면 줄 없이 */ }
  }
  // 경로 위 유도선 자리들 (경로가 바뀔 때 한 번): [{ at, end, c, name, k }] at 순서
  function ensureRouteColorLines() {
    if (nav.clList) return nav.clList;
    const out = [];
    if (!clData.loaded || !nav.pts || nav.pts.length < 2) return out;
    const pts = nav.pts, cum = nav.cum, last = pts.length - 1;
    const best = new Map();
    for (let i = 0; i < last; i++) {
      const a = pts[i], b = pts[i + 1], len = cum[i + 1] - cum[i];
      if (len <= 0) continue;
      const brg = bearing(a, b);
      const cells = new Set();
      const steps = Math.max(1, Math.ceil(len / 400));
      for (let q = 0; q <= steps; q++) {
        const la = a.lat + (b.lat - a.lat) * q / steps, ln = a.lng + (b.lng - a.lng) * q / steps;
        for (let y = -1; y <= 1; y++) for (let x = -1; x <= 1; x++) cells.add((Math.floor(la * 100) + y) + ':' + (Math.floor(ln * 100) + x));
      }
      for (const c of cells) for (const k of clData.grid.get(c) || []) {
        const r = clData.rows[k];
        if (angleDiff(r.h, brg) > 30) continue;
        const pr = projectSeg(r, a, b);
        if (pr.dist > CL_SIDE || (pr.t <= 0 && i > 0) || (pr.t >= 1 && i < last - 1)) continue;
        const o = best.get(k);
        if (!o || pr.dist < o.side) best.set(k, { at: cum[i] + pr.t * len, side: pr.dist });
      }
    }
    // 갈래 끝점이 경로(그 점 뒤 CL_AHEAD m 안) 25m 안이면 그곳의 경로 거리
    const passAt = (e, from) => {
      let hit = null;
      for (let i = 0; i < last; i++) {
        if (cum[i + 1] < from || cum[i] > from + CL_AHEAD) continue;
        const pr = projectSeg(e, pts[i], pts[i + 1]);
        if (pr.dist <= CL_END && (!hit || pr.dist < hit.dist)) hit = { dist: pr.dist, at: cum[i] + pr.t * (cum[i + 1] - cum[i]) };
      }
      return hit;
    };
    for (const [k, o] of best) {
      const r = clData.rows[k];
      const hits = r.br.map((b) => ({ b, h: passAt(b, o.at) })).filter((x) => x.h && x.h.at > o.at);
      if (hits.length !== 1) continue;                // 어느 갈래에도 안 감(본선 그대로) 또는 둘 다 닿음 → 모름
      out.push({ at: o.at, end: hits[0].h.at, c: hits[0].b.c, name: r.name, k });
    }
    out.sort((u, v) => u.at - v.at);
    nav.clList = out;
    return out;
  }
  function colorLineAhead() {
    if (!nav.active || !nav.pts) return null;
    for (const x of ensureRouteColorLines()) {
      if (x.end <= nav.along) continue;              // 갈래 끝을 지났음
      const d = x.at - nav.along;
      return d <= CL_SHOW ? Object.assign({ d }, x) : null;
    }
    return null;
  }
  function renderColorLine() {
    const el = $('#colorRow'), a = colorLineAhead();
    el.hidden = !a;
    if (!a) { el._d = Infinity; return; }
    const col = CL_COLORS[a.c];
    // 지금 안내(분기점·나들목 출구)가 바로 이 갈림이면 거리는 위 안내 줄에 있다 — 여기 거리(색 선이 갈라지는 곳까지)까지 쓰면 숫자가 둘이라
    // 헷갈린다 (서울TG→판교분기점: 위 '150m 오른쪽 방향', 색 선은 출구 뒤 320m 에서 갈라짐). 그때는 거리 없이, 순서는 안내 지점 거리로
    const same = nav.dg != null && a.d - nav.dg > -200 && a.d - nav.dg < 600;
    el._d = same ? nav.dg : Math.max(0, a.d);   // 줄 순서 (v158)
    if (el.dataset.c !== a.c) {
      el.dataset.c = a.c;
      el.style.setProperty('--cl', col.css);
      $('#colorText').innerHTML = '<em>' + col.name + '</em> 유도선 따라가기';
    }
    el.dataset.name = a.name;
    const ds = !same && a.d > 15 ? fmtDist(a.d) : '';
    $('#colorDist').textContent = ds;
    el.setAttribute('aria-label', '노면 색깔 유도선 · ' + col.name + ' 유도선 따라가기' + (a.name ? ' · ' + a.name : '') + (ds ? ' · ' + ds : ''));
  }
  // 버스전용차로 (v139, 2026-11-16 사용자 '우리도 이런거 있음 좋겠다' — 네이버처럼 버스 칸): 자료의 차로 글자 끝 'B'
  // (tools/build_lanes.py: 정밀도로지도 버스전용차선 504). 갈 차로에서 빼되, 그 방향이 버스전용차로에만 있으면(바깥 버스전용차로에서
  // 우회전 — 점선 구간에서 들어가 돈다) 그 차로를 갈 차로로 둔다
  const isBusLane = (l) => String(l).indexOf('B') >= 0;
  function laneOk(lanes, M) {
    const all = lanes.map((l, i) => (l.indexOf(M) >= 0 ? i : -1)).filter((i) => i >= 0);
    const car = all.filter((i) => !isBusLane(lanes[i]));
    return car.length ? car : all;
  }
  // 이 회전 안내에서 갈 차로: { lanes: ['LU','L','S','RS'], ok: [0, 1], k } 또는 null. 경로마다 안내별로 한 번만 찾는다
  function laneGuide(g) {
    const M = g && LANE_MOVE[turnKind(g)];
    if (!M || !lanesData.loaded || !nav.pts || nav.pts.length < 2) return null;
    if (!nav.laneCache) nav.laneCache = new Map();
    const ck = g.i + ':' + g.t;
    if (nav.laneCache.has(ck)) return nav.laneCache.get(ck);
    let res = null;
    const last = nav.cum.length - 1, s0 = nav.cum[Math.min(g.i, last)], p = nav.pts[Math.min(g.i, last)];
    const a = routePointAt(s0 - 30), b = routePointAt(s0 - 3);
    if (a && b && haversine(a, b) > 10) {
      const hin = bearing(a, b), ux = Math.sin(toRad(hin)), uy = Math.cos(toRad(hin));
      const kx = Math.cos(toRad(p.lat)) * 111320, ky = 110540;
      const cy = Math.floor(p.lat * 100), cx = Math.floor(p.lng * 100);
      const cands = [];
      for (let y = cy - 1; y <= cy + 1; y++) for (let x = cx - 1; x <= cx + 1; x++) {
        for (const k of lanesData.grid.get(y + ':' + x) || []) {
          if (angleDiff(lanesData.h[k], hin) > 35) continue;
          const vx = (p.lng - lanesData.lng[k]) * kx, vy = (p.lat - lanesData.lat[k]) * ky;
          const along = vx * ux + vy * uy, side = Math.abs(-vx * uy + vy * ux);   // 정지선 → 회전 지점: 진행 방향으로·옆으로
          if (along < -8 || along > 90 || side > 22) continue;   // 큰 교차로는 정지선 → 네이버 회전 지점이 70m 넘기도 (강일3·6단지 72m)
          const lanes = lanesData.pats[lanesData.pat[k]] || [];
          // 유턴은 노면 유턴 화살표가 있는 차로, 없으면 1차로 (유턴은 1차로에서)
          const ok = laneOk(lanes, M);
          const painted = ok.length > 0;   // 그 방향 화살표가 실제로 칠해진 차로가 있음
          if (M === 'U' && !ok.length) ok.push(Math.max(0, lanes.findIndex((l) => !isBusLane(l))));   // 1차로 (중앙 버스전용차로면 그다음)
          cands.push({ k, lanes, ok, painted, along, far: along > 45 ? 1 : 0 });
        }
      }
      // 그 방향 화살표가 칠해진 진입부 먼저(유턴의 '1차로' 대신 규칙보다), 다음은 회전 지점에 가까운(45m 안) 것, 다음은 거리
      cands.sort((u, v) => (v.painted - u.painted) || (v.ok.length > 0) - (u.ok.length > 0) || u.far - v.far || u.along - v.along);
      const c = cands[0];
      if (c && c.ok.length && c.ok.length < c.lanes.length) res = { lanes: c.lanes, ok: c.ok, k: c.k, M };
    }
    nav.laneCache.set(ck, res);
    return res;
  }
  // 차로 칸 하나의 화살표 (2026-11-15 사용자: '네이버 지도처럼', '좌+유턴 칸에서 우리가 가는 방향이 아닌 유턴은 회색, 유턴하면 유턴을 파랗게').
  // 그 차로에 칠해진 방향들(직진·좌·우·유턴)을 줄기 + 방향별 가지로 나눠 그려, 갈 차로면 줄기와 이번 회전 방향의 가지만 파랗게(.on),
  // 다른 가지와 갈 수 없는 차로는 회색. 모양은 Atlas(GPT Image 2.6)로 받아 본 네이버풍 화살표(가는 줄기, 작고 날카로운 삼각 촉,
  // 둥근 꺾임, 길쭉한 비율)를 본떴다 (AI 그림 한 장으로는 가지별로 칠할 수 없어 벡터로). viewBox 26×32, 줄기는 x=13, 맨 아래에서
  // 2026-11-16 사용자 '줄기를 조금만 더 두껍게': 줄기 3.2(CSS), 촉도 그만큼 넓게
  // 2026-11-16 사용자: '16:9 느낌보다 1:1 느낌으로', '너무 길쭉하고 얇아서 보기 안 좋다' → 28×28 정사각형 안에 굵게(줄기 3.8, CSS),
  // 촉도 넓게. '왼쪽 오른쪽은 라운드를 좀 크게 동글게' → 좌·우 꺾임은 반지름 6(직진과 함께면 5.5)의 1/4 원. 줄기는 x=14, 맨 아래 y=27
  const LANE_HEAD = {
    up: (x, y) => x + ',' + y + ' ' + (x - 5.8) + ',' + (y + 7.4) + ' ' + (x + 5.8) + ',' + (y + 7.4),
    left: (x, y) => x + ',' + y + ' ' + (x + 6.8) + ',' + (y - 5.8) + ' ' + (x + 6.8) + ',' + (y + 5.8),
    right: (x, y) => x + ',' + y + ' ' + (x - 6.8) + ',' + (y - 5.8) + ' ' + (x - 6.8) + ',' + (y + 5.8),
    down: (x, y) => x + ',' + y + ' ' + (x - 5.2) + ',' + (y - 7) + ' ' + (x + 5.2) + ',' + (y - 7),
  };
  // m 의 가지들: [[방향, 선, 촉], …]과 줄기 끝 높이
  function laneParts(m) {
    const S = m.indexOf('S') >= 0, L = m.indexOf('L') >= 0, R = m.indexOf('R') >= 0, U = m.indexOf('U') >= 0;
    const parts = [];
    if (!S && !L && !R && !U) return { parts, top: 12, sx: 14 };
    // 유턴이 다른 방향과 함께면(좌+유턴 등) 줄기를 오른쪽(x=19.5)으로 옮겨 왼쪽에 자리를 내고, 좌회전 꺾임은 위·유턴 고리는 아래로
    // 넉넉히 띄운다 (2026-11-16 사용자: 유턴할 때 좌+유턴 칸이 '뭔가 좀 아쉽다' — 작은 고리가 꺾임에 붙어 무슨 모양인지 안 보였다)
    const withU = U && (S || L || R);
    const sx = withU ? 19.5 : 14;
    const r = withU ? 5 : S ? 5.5 : 6, jy = withU ? 12 : S ? 21.5 : 15;   // 좌·우 꺾임 반지름과 시작 높이
    let top = 27;
    // 가지마다 [방향, 선, 촉, 줄기에서 갈라지는 높이] — 줄기는 이번 방향 가지가 갈라지는 높이까지만 파랗게 (아래 laneArrowSvg)
    if (S) { parts.push(['S', 'M' + sx + ' ' + jy + 'V8.8', LANE_HEAD.up(sx, 1.2), jy]); top = jy; }
    if (L || R) {
      const y = jy - r;
      if (L) parts.push(['L', 'M' + sx + ' ' + jy + 'A' + r + ' ' + r + ' 0 0 0 ' + (sx - r) + ' ' + y + 'H' + (sx - r - 0.2), LANE_HEAD.left(sx - r - 6.8, y), jy]);
      if (R) parts.push(['R', 'M' + sx + ' ' + jy + 'A' + r + ' ' + r + ' 0 0 1 ' + (sx + r) + ' ' + y + 'H' + (sx + r + 0.2), LANE_HEAD.right(sx + r + 6.8, y), jy]);
      top = jy;
    }
    if (U) {
      if (withU) {         // 줄기 아래쪽에서 높이 솟았다가 왼쪽으로 내려오는 아치(∩) — 유턴으로 읽히게, 위 꺾임 촉과는 2 넘게 띄움
        const ux = sx - 10.5;
        parts.push(['U', 'M' + sx + ' 24.5C' + sx + ' 13 ' + ux + ' 13 ' + ux + ' 19.5V21', LANE_HEAD.down(ux, 27.8), 24.5]);
      } else {             // 유턴만: 줄기 끝에서 왼쪽으로 돌아 내려온다
        parts.push(['U', 'M14 10A4.2 4.2 0 0 0 5.6 10V19.4', LANE_HEAD.down(5.6, 26.2), 10]);
        top = 10;
      }
    }
    return { parts, top, sx };
  }
  function laneArrowSvg(m, go, M) {
    const { parts, top, sx } = laneParts(m);
    // 갈 차로인데 이번 방향 가지가 없으면(유턴 화살표가 없는 1차로 등) 전부 파랗게
    const lit = (dir) => go && (dir === M || !parts.some((p) => p[0] === M));
    const g = (on, inner) => '<g class="pt' + (on ? ' on' : '') + '">' + inner + '</g>';
    const draw = (p) => g(lit(p[0]), '<path d="' + p[1] + '"/><polygon points="' + p[2] + '"/>');
    // 줄기: 갈 차로면 이번 방향 가지가 갈라지는 높이까지만 파랗고 그 위(다른 가지로만 이어지는 부분)는 회색
    // (2026-11-16 사용자: 좌+유턴 칸에서 유턴할 때 좌회전 쪽으로 이어진 줄기 윗부분까지 파랬다)
    const litTops = parts.filter((p) => lit(p[0])).map((p) => p[3]);
    const blueTop = go ? (litTops.length ? Math.min(...litTops) : top) : 27;
    const stem = (blueTop > top ? g(false, '<path d="M' + sx + ' ' + blueTop + 'V' + top + '"/>') : '') +
      (go ? g(true, '<path d="M' + sx + ' 27V' + blueTop + '"/>') : '');
    const stemGrey = go ? '' : g(false, '<path d="M' + sx + ' 27V' + top + '"/>');
    // 칸 가운데에 모양 전체(줄기·가지·촉)가 오게 옮긴다 (2026-11-16 사용자: 좌·우회전 칸이 줄기만 가운데라 한쪽으로 쏠려 보임).
    // 너비 = 촉 꼭짓점들과 줄기(굵기 3.8)의 왼쪽·오른쪽 끝
    let x0 = sx - 1.9, x1 = sx + 1.9;
    for (const p of parts) for (const xy of p[2].split(' ')) { const x = +xy.split(',')[0]; if (x < x0) x0 = x; if (x > x1) x1 = x; }
    const dx = Math.round((14 - (x0 + x1) / 2) * 10) / 10;
    // 회색 가지 먼저, 파란 줄기·가지를 위에 (겹친 곳이 파랗게)
    return '<svg viewBox="0 0 28 28" aria-hidden="true"><g' + (dx ? ' transform="translate(' + dx + ' 0)"' : '') + '>' +
      stemGrey + parts.filter((p) => !lit(p[0])).map(draw).join('') + stem + parts.filter((p) => lit(p[0])).map(draw).join('') + '</g></svg>';
  }
  // 버스 칸: 네이버처럼 앞모습 버스 (몸통에 앞유리·전조등 구멍, 바퀴 둘). 28×28, 칸 색(currentColor)으로 칠한다
  const BUS_LANE_SVG = '<svg viewBox="0 0 28 28" aria-hidden="true"><g class="pt bus"><path fill-rule="evenodd" d="M10.2 3H17.8A3.2 3.2 0 0 1 21 6.2V21H7V6.2A3.2 3.2 0 0 1 10.2 3Z' +
    'M9.3 6.2V12.8H18.7V6.2ZM9.2 17.2A1.4 1.4 0 1 0 12 17.2A1.4 1.4 0 1 0 9.2 17.2ZM16 17.2A1.4 1.4 0 1 0 18.8 17.2A1.4 1.4 0 1 0 16 17.2Z' +
    'M7.8 21H11.2V24A1 1 0 0 1 10.2 25H8.8A1 1 0 0 1 7.8 24ZM16.8 21H20.2V24A1 1 0 0 1 19.2 25H17.8A1 1 0 0 1 16.8 24Z"/></g></svg>';
  // 차로 칸 하나 (서랍 칸·지도 말풍선 같이): 버스전용차로는 버스 그림(회색). 버스전용차로가 갈 차로면(그 방향이 거기만 — 우회전)
  // 화살표를 파랗게 그리고 구석에 작은 버스
  function laneCell(m, go, M, cls) {
    const bus = isBusLane(m);
    return '<b class="' + cls + (go ? ' go' : '') + (bus ? ' bus' : '') + '">' +
      (bus && !go ? BUS_LANE_SVG : laneArrowSvg(m, go, M) + (bus ? '<i class="lbus">' + BUS_LANE_SVG + '</i>' : '')) + '</b>';
  }
  // ---------- 직진 차로 (2026-11-16 요청 '직진 차로도 안내') ----------
  // 경로가 곧게 지나가는(회전 안내가 없는) 교차로 진입부 중 일부 차로가 좌·우회전 전용인 곳: 직진할 수 있는 차로를 파랗게.
  // 경로 선에서 옆으로 15m 안, 방향 25° 안, 정지선 20m 뒤 경로가 35° 넘게 꺾이지 않고, 회전 안내(좌·우·유턴)에 쓰인 진입부가 아니고
  // 그 지점 10m 뒤~100m 앞도 아닌 진입부 (실제 경로: 강일3·6단지 좌회전 진입부가 정지선→회전 지점 72m 라 직진으로 먼저 나왔다).
  // 경로마다 한 번 찾아 경로 거리순으로 둔다
  const LANE_STRAIGHT_SHOW = 300;
  // 고속도로·도시고속도로(강변북로·올림픽대로·내부순환로 …) 진입~출구 안내 사이에는 신호 교차로가 없다: 거기서 잡히는 진입부는
  // 고가 아래·옆 일반도로의 것 (v131, 서울 전체 자료로 넓히며). 진입·출구 = 안내 종류 ins/inl/inr · outs/outl/outr
  const FAST_IN = new Set(Object.keys(KIND_BY_CODE).filter((c) => /^in[slr]$/.test(KIND_BY_CODE[c])).map(Number));
  const FAST_OUT = new Set(Object.keys(KIND_BY_CODE).filter((c) => /^out[slr]$/.test(KIND_BY_CODE[c])).map(Number));
  function fastRoadSpans() {
    const spans = [], last = nav.cum.length - 1;
    let start = null, seen = false;
    for (const g of nav.guides || []) {
      const s = nav.cum[Math.min(g.i, last)];
      if (FAST_IN.has(g.t)) { if (start === null) start = s; seen = true; }
      else if (FAST_OUT.has(g.t)) { if (start !== null || !seen) spans.push([start === null ? 0 : start, s]); start = null; seen = true; }
    }
    if (start !== null) spans.push([start, nav.total]);
    return spans;
  }
  // 차로 칸은 늘 서랍 안에 모두 (2026-11-16 사용자: 7차로를 아래 가운데에 띄웠더니 '운전자를 가리는 느낌이 강하다',
  // '차선을 ⋯으로 맞추는 건 안 돼', '보통 8차선, 많아 봐야 10차선'). 칸은 정사각형이고 차로가 많으면 칸·틈이 함께 작아진다
  function ensureRouteLanes() {
    if (nav.laneStraight) return nav.laneStraight;
    const out = [];
    if (!lanesData.loaded || !nav.pts || nav.pts.length < 2) return out;
    const pts = nav.pts, cum = nav.cum, last = cum.length - 1;
    const turnGuides = (nav.guides || []).filter((x) => LANE_MOVE[turnKind(x)]);
    const turns = turnGuides.map((x) => cum[Math.min(x.i, last)]);
    const turnK = new Set(turnGuides.map((x) => laneGuide(x)).filter(Boolean).map((h) => h.k));   // 회전 안내에 쓰인 진입부
    const fast = fastRoadSpans();
    const best = new Map();   // 진입부 → { at, side }
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i], b = pts[i + 1], len = cum[i + 1] - cum[i];
      if (len <= 0) continue;
      const kx = Math.cos(toRad(a.lat)) * 111320, ky = 110540;
      const bx = (b.lng - a.lng) * kx, by = (b.lat - a.lat) * ky, brg = bearing(a, b);
      const cells = new Set();
      const steps = Math.max(1, Math.ceil(len / 400));
      for (let s = 0; s <= steps; s++) {
        const la = a.lat + (b.lat - a.lat) * s / steps, ln = a.lng + (b.lng - a.lng) * s / steps;
        for (let y = -1; y <= 1; y++) for (let x = -1; x <= 1; x++) cells.add((Math.floor(la * 100) + y) + ':' + (Math.floor(ln * 100) + x));
      }
      for (const c of cells) for (const k of lanesData.grid.get(c) || []) {
        if (angleDiff(lanesData.h[k], brg) > 25) continue;
        const px = (lanesData.lng[k] - a.lng) * kx, py = (lanesData.lat[k] - a.lat) * ky;
        const t = (px * bx + py * by) / (len * len);
        if (t < -0.02 || t > 1.02) continue;
        const side = Math.abs(bx * py - by * px) / len;
        if (side > 15) continue;
        const at = cum[i] + Math.max(0, Math.min(1, t)) * len;
        const o = best.get(k);
        if (!o || side < o.side) best.set(k, { at, side });
      }
    }
    for (const [k, o] of best) {
      if (turnK.has(k) || turns.some((s) => s - o.at >= -10 && s - o.at <= 100)) continue;   // 회전 안내의 진입부 (회전 쪽에서 보여 줌)
      if (o.at < 20 || o.at > nav.total - 30) continue;
      if (fast.some(([s, e]) => o.at >= s && o.at <= e)) continue;          // 고속·도시고속도로 위 (아래·옆 일반도로 교차로)
      if (routeTurnAt(o.at + 20) > 35) continue;                            // 경로가 그 교차로에서 꺾임
      const lanes = lanesData.pats[lanesData.pat[k]] || [];
      const ok = laneOk(lanes, 'S');
      if (!ok.length || ok.length === lanes.length) continue;               // 직진 차로가 없거나 다 직진이면 알려 줄 것이 없음 (버스 칸이 있으면 보임)
      out.push({ at: o.at, k, lanes, ok, M: 'S' });
    }
    out.sort((u, v) => u.at - v.at);
    nav.laneStraight = out;
    return out;
  }
  // 앞쪽 300m 안의 다음 직진 진입부 (다음 회전·갈림 안내 지점보다 앞인 것만. '직진' 안내는 넘어간다).
  // 회전 500m 앞이라도 그보다 가까운 직진 교차로가 있으면 그 교차로부터 (가까운 교차로부터 차례로)
  function nextStraightLane() {
    const list = ensureRouteLanes();
    if (!list.length) return null;
    let limit = Infinity;
    for (let j = nav.gi; j < (nav.guides || []).length; j++) {
      if (turnKind(nav.guides[j]) !== 's') { limit = nav.cum[Math.min(nav.guides[j].i, nav.cum.length - 1)]; break; }
    }
    for (const x of list) {
      const d = x.at - nav.along;
      if (d < -5) continue;
      return d <= LANE_STRAIGHT_SHOW && x.at < limit ? Object.assign({ d }, x) : null;
    }
    return null;
  }
  // 차로 칸은 단속 서랍 맨 위에 (2026-11-16 사용자: '그 섹션 안에서처럼 쭈욱 내려오는 느낌', '네모로 하나하나', '네이버 지도처럼').
  // 회전 500m 앞이면 그 회전의 차로, 아니면 300m 안의 직진 교차로 차로(남은 거리도 칸 오른쪽에)
  function renderLanes(g) {
    const el = $('#laneRow');
    if (!el) return;
    let hit = null;
    if (prefs.lanes && nav.active) {
      hit = forkLane();           // 고속도로 분기 앞 (v153)
      if (!hit) hit = nextStraightLane();   // 가까운 직진 교차로가 먼저
      if (!hit) hit = g && nav.dg != null && nav.dg <= LANE_SHOW ? laneGuide(g) : null;
    }
    laneState.hit = hit;
    laneState.rowHit = hit;
    if (!hit) {
      laneState.key = '';
      if (!el.hidden && drawerAnimated() && !drawerKeeps('#laneRow')) startDrawerClose();
      else if (!drawer.closing) el.hidden = true;
      syncDrawer();
      return;
    }
    cancelDrawerClose();
    el.hidden = false;
    el._d = hit.d != null ? hit.d : nav.dg != null ? nav.dg : Infinity;   // 서랍 칸 순서 (v158): 갈림길·직진 교차로는 그곳, 회전 차로는 안내 지점까지
    const box = el;
    const key = (hit.fork ? 'f:' : hit.M === 'S' ? 's:' : g.i + ':' + g.t + ':') + hit.k;
    const head = hit.fork || hit.M === 'S';   // 칸 위 머리줄 (분기 차로·직진 교차로)
    if (laneState.key !== key) {
      laneState.key = key;
      // 직진 교차로: 칸 위 머리줄 (왼쪽 '다음 교차로 · 직진', 오른쪽 끝 남은 거리). 칸은 정사각형, 8차로 넘으면 틈을 좁힘
      box.innerHTML = (head ? '<div class="lh"><span>' + (hit.fork ? '갈림길 차로' : '다음 교차로 · 직진') + '</span><b class="ld"></b></div>' : '') +
        '<div class="lt' + (hit.lanes.length >= 8 ? ' many' : '') + '">' +
        hit.lanes.map((m, i) => laneCell(m, hit.ok.indexOf(i) >= 0, hit.M, 'lg')).join('') + '</div>';
      box.classList.toggle('straight', head);
      box.classList.toggle('fork', !!hit.fork);
      box.dataset.lanes = hit.lanes.join('|');
      box.dataset.go = hit.ok.map((i) => i + 1).join(',');
      box.dataset.move = hit.M;
      box.dataset.fork = hit.fork ? '1' : '';
      const busN = hit.lanes.map((m, i) => (isBusLane(m) ? i + 1 : 0)).filter(Boolean);
      box.dataset.bus = busN.join(',');
      box.setAttribute('aria-label', (hit.M === 'S' ? '직진 ' : '') + hit.lanes.length + '차로 중 ' + hit.ok.map((i) => i + 1).join('·') + '차로' +
        (busN.length ? ', 버스전용 ' + busN.join('·') + '차로' : ''));
    }
    if (head) box.querySelector('.ld').textContent = fmtDist(Math.max(0, hit.fork && nav.dg != null ? nav.dg : hit.d));   // 분기: 다음 안내(분기점)까지
    syncDrawer();
  }
  // ---------- 지도 위 차로 말풍선 (v139, 2026-11-16 사용자 '우리도 이런거 있음 좋겠다' — 네이버 길안내가 다음 회전 교차로에 붙이는
  // 흰 말풍선 [↰][↑][↑][버스]) ----------
  // 다음 회전(좌·우·유턴) 안내의 진입부 자료가 있으면 1km 앞부터 그 교차로 정지선에 말풍선: 갈 차로는 파란 화살표, 나머지 회색,
  // 버스전용차로는 버스 그림. 좌회전·유턴이면 정지선 오른쪽 위, 우회전이면 왼쪽 위 (회전해 나가는 길을 덮지 않게).
  // 자료가 없는 곳(정밀도로지도 밖)은 아무것도 안 그린다
  const LANE_TIP_SHOW = 1000;
  const LANE_TIP = { cell: 28, gap: 2, pad: 4, tail: 7, nose: 12 };
  function laneTipFor(g) {
    if (!prefs.lanes || !nav.active || !g || nav.dg == null || nav.dg > LANE_TIP_SHOW || !LANE_MOVE[turnKind(g)]) return null;
    const hit = laneGuide(g);
    if (!hit) return null;
    const T = LANE_TIP, n = hit.lanes.length, w = n * T.cell + (n - 1) * T.gap + 2 * T.pad, h = T.cell + 2 * T.pad + T.tail;
    const left = hit.M === 'R';
    const html = '<div class="lanetip' + (left ? ' tip-l' : '') + '" style="width:' + w + 'px">' +
      hit.lanes.map((m, i) => laneCell(m, hit.ok.indexOf(i) >= 0, hit.M, 'tl')).join('') + '</div>';
    return { key: g.i + ':' + g.t + ':' + hit.k, lat: lanesData.lat[hit.k], lng: lanesData.lng[hit.k], html, w, h,
      ax: left ? w - T.nose : T.nose, ay: h };
  }
  function renderLaneTip(g) { if (mapA && mapA.setLaneTip) mapA.setLaneTip(laneTipFor(g)); }
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
    orderAlerts();
    placeAlerts(); // 안내 패널 높이가 바뀌면 그 밑의 단속 경고도 따라 움직인다
    checkTripCover();
  }
  // 테슬라 모드: 서랍(분기점 그림·단속·하이패스)이 길어져 왼쪽 아래 주행 기록·나침반에 닿으면 그동안 그 둘을 숨긴다 (글자가 겹치지 않게)
  function checkTripCover() {
    const app = $('#app');
    if (!app.classList.contains('tesla')) { app.classList.remove('trip-covered'); return; }
    const dr = $('#camDrawer'), tops = [$('.trip'), $('.heading')].filter(Boolean).map((e) => e.getBoundingClientRect().top).filter((v) => v > 0);
    // 서랍 밑에 붙는 다음 단속·과속방지턱·주의 표지 칸도 본다 (2026-11-14: 하이패스 차로 줄로 서랍이 길어지자 '100 14km'가 나침반에 겹침)
    const lows = [dr.classList.contains('open') ? dr : null, $('#camNext'), $('#bumpCard'), $('#signCard'), $('#parkCard')]
      .filter((e) => e && !e.hidden && e.offsetParent !== null).map((e) => e.getBoundingClientRect().bottom);
    const covered = tops.length > 0 && lows.length > 0 && Math.max(...lows) > Math.min(...tops) - 6;
    app.classList.toggle('trip-covered', covered);
  }
  function renderNavPanel() {
    const p = $('#navPanel');
    renderStrip();
    if (!nav.active) { p.hidden = true; $('#searchBtn').hidden = false; renderLanes(null); renderLaneTip(null); return; }
    p.hidden = false;
    $('#searchBtn').hidden = true;
    // 맨 위 목적지 줄 (경유지가 있으면 오른쪽에 작게)
    $('#navDestName').textContent = nav.dest ? nav.dest.name : '';
    $('#navDestVia').textContent = nav.via && nav.via[0] ? '경유 ' + nav.via[0].name : '';
    const g = nav.next;
    renderTurnArrow();
    renderRest();
    renderParkGoal();
    // v118 (2026-11-15 주행 중 요청 '터널을 위로 올려 주고, 직진 그다음 터널이면 그냥 터널까지 몇 km 남았는지'):
    //   지금 안내가 직진(직진·직진 지하차도·직진 고가)인데 터널 안이거나 그 전에 터널이 있으면, 안내 줄을 터널로
    //   ('터널 출구까지 680m' + 지나온 만큼 초록 막대 / '남한터널까지 1.2km'). 작은 터널 줄은 숨긴다. 회전·갈림길은 그대로.
    //   직진 지하차도 진입(56)만 있으면 터널 아이콘 + 'OO지하차도까지'
    const kind0 = g ? turnKind(g) : 'goal';
    const straight0 = kind0 === 's' || kind0 === 'under_s' || kind0 === 'over_s';
    const ta0 = straight0 ? tunnelAhead() : null;
    const tnMain0 = !!(ta0 && (ta0.inside || nav.dg == null || ta0.d < nav.dg));
    // v133 휴게소를 위로: 다음 휴게소가 3km 안이고 지금 안내 지점보다 가깝고, 그 안내가 1km 넘게 남았을 때만(회전이 급하면 회전이 위).
    // 터널 줄 올리기와 같은 규칙: 더 가까운 것이 위 (터널 안이거나 터널이 더 가까우면 터널)
    const rs = restState.next;
    const restMain = !!(rs && rs.d <= REST_TOP && nav.dg != null && rs.d < nav.dg && nav.dg > 1000 &&
      !(tnMain0 && (ta0.inside || ta0.d <= rs.d)));
    const tnMain = tnMain0 && !restMain;
    const tunnelStep = !tnMain && !restMain && !!g && g.t === 56;
    // v124: 직진 고가차도 진입(55)도 지하차도처럼 고가 그림 + 'OO고가차도까지' (네이버 지도 '고가도로로 진입')
    const overStep = !tnMain && !restMain && !!g && g.t === 55;
    const underName = (n) => /지하차도|지하도로|언더패스|지하도/.test(n || '');
    const turnRow = p.querySelector('.turn');
    turnRow.classList.toggle('tn-main', tnMain);
    turnRow.classList.toggle('rest-main', restMain);
    if (restMain) $('#restCard').hidden = true;   // 위 안내 줄이 휴게소면 밑 파란 줄은 숨김
    turnRow.style.setProperty('--tnp', tnMain && ta0.inside ? Math.round(Math.max(0, Math.min(1, ta0.p)) * 100) + '%' : '0%');
    // 산 터널은 터널 그림, 지하차도는 지하차도 입구 그림(초록 경로선), 고가는 고가 그림
    $('#turnIcon').innerHTML = restMain ? REST_SIGN : tunnelStep || (tnMain && underName(ta0.t.name)) ? (pickImg('under_s', 'ti') || pickImg('tunnel', 'ti tn-ai') || TUNNEL_ICON)
      : tnMain ? (pickImg('tunnel', 'ti tn-ai') || TUNNEL_ICON) : overStep ? ico('over_s') : ico(g ? iconKind(g) : kind0);
    $('#turnDist').textContent = fmtDist(Math.max(10, restMain ? rs.d : tnMain ? ta0.d : nav.dg != null ? nav.dg : nav.total));   // '0m' 대신 최소 10m (음성과 같게)
    if (restMain) {
      $('#turnText').textContent = rs.name;
    } else if (tnMain) {
      $('#turnText').textContent = (ta0.t.name || '터널') + (ta0.inside ? ' 출구까지' : '까지');
    } else if (g && g.t === 121) {
      // 톨게이트: 다른 내비처럼 통행료를 굵게 앞에 ('800원 하남톨게이트'), 아이콘은 TG 표지 (2026-11-14 요청)
      const p = tollParts(g), fee = fareText(p.fare);
      $('#turnText').innerHTML = (fee ? '<b class="tt-fare">' + esc(fee) + '</b>' : '') + esc(p.name);
    } else if (tunnelStep || overStep) {
      // v140 (2026-11-16 '송파지하차도에서 '성남, 가락시장역' 방면으로 지하차도 진입': 네이버는 '1.6km 가락시장역', 우리는 '송파지하차도까지'):
      // 방면이 있으면 다른 안내 줄처럼 방면 이름을 보여 준다 (지하차도·고가 그림이 이미 무엇인지 알려 준다). 방면이 없으면 예전처럼 'OO지하차도까지'
      const m = /^(.*?)에서\s/.exec(String(g.s || ''));
      const dm = /'([^']+)'\s*방면/.exec(String(g.s || ''));
      const d = dm ? dirNames(dm[1]) : [];
      $('#turnText').textContent = d.length ? d.join(', ') + ' 방면' : (m ? m[1] : tunnelStep ? '지하차도' : '고가차도') + '까지';
    } else {
      $('#turnText').textContent = g ? guideText(g.s, mainStraight(g)) : nav.dest.name;
    }
    renderLanes(tnMain ? null : g);   // 회전 500m 앞부터 차로 칸 (정밀도로지도가 있는 곳만)
    renderLaneTip(g);                 // 지도 위 다음 회전 교차로 말풍선 (1km 앞부터)
    // 그다음 칸: 이번 회전을 하고 나서 무엇이 얼마 뒤에 오는지 (거리는 이번 안내 지점 → 그다음 안내 지점).
    //   그다음이 회전이면 네이버 지도처럼 그 회전 아이콘 + 거리만 '↰ 1.2km' (2026-11-14: '직진 … 좌회전'처럼 풀어 쓰지 않음)
    //   그다음이 목적지면 연한 빨강 바탕에 빨간 핀 + '20m', 경유지면 주황 (2026-11-14: '도착' 글자는 빼고 핀·바탕색으로만 구분)
    // v133: 위 줄이 휴게소면 그다음 칸은 지금 안내 (거리 = 휴게소 진입로 → 그 안내 지점, 네이버 '휴게소 3km' 밑 'TG 3.9km' 처럼)
    // v158 (2026-11-17 20:04 이배재터널 안 '1.8km 좌회전' 밑에 '370m 터널 출구까지', 그 밑 '↗ 230m' — 운전자 '가까운 순서가 위로 올라오기로 했는데'):
    //   230m 는 좌회전 지점부터 잰 거리(차에서는 2.0km)라 순서는 맞았지만 기준이 달라 거꾸로 보였다. 거리는 네이버처럼 위 안내 지점부터 재고
    //   ('휴게소 3km' 밑 'TG 3.9km' 도 휴게소부터), 기준을 옆에 작게 쓴다: '230m 좌회전 후'. 위 줄이 터널이면 터널 출구부터 ('터널 지나')
    const g2 = restMain ? g : g ? nav.guides[nav.gi + 1] : null;
    const nn = $('#nextTurn');
    nn.hidden = !g2;
    if (g2) {
      const last = nav.cum.length - 1;
      const g2at = nav.cum[Math.min(g2.i, last)] - nav.along;   // 차에서 그다음 안내 지점까지 (줄 순서에 쓴다)
      const tnOut = tnMain ? (ta0.inside ? ta0.d : Math.max(ta0.d, ta0.t.s1 - nav.along)) : 0;
      const gap = restMain ? Math.max(0, nav.dg - rs.d) : tnMain ? Math.max(0, g2at - tnOut) : Math.max(0, nav.cum[Math.min(g2.i, last)] - nav.cum[Math.min(g.i, last)]);
      nn._d = restMain ? nav.dg : g2at;
      $('#nextAfter').textContent = restMain ? '휴게소 지나' : tnMain ? '터널 지나' : afterWord(g, tunnelStep, overStep);
      nn.setAttribute('aria-label', '그다음 안내 · ' + $('#nextAfter').textContent + ' ' + fmtDist(gap));
      const k2 = turnKind(g2);
      const isVia = g2.t === 87 || /경유지/.test(g2.s || '');
      const isGoal = !isVia && (k2 === 'goal' || k2 === 'via');
      nn.classList.toggle('goal', isGoal);
      nn.classList.toggle('via', isVia);
      if (isGoal || isVia) {
        $('#nextIcon').innerHTML = pinIco(isVia);
        $('#nextDist').textContent = fmtDist(gap);
      } else {
        $('#nextIcon').innerHTML = ico(iconKind(g2));
        $('#nextDist').textContent = fmtDist(gap);
      }
    }
    const remain = nav.remain != null ? nav.remain : nav.total;
    const remMs = nav.route.duration * (remain / Math.max(1, nav.total));
    renderTunnel();
    if (tnMain) $('#tunnelRow').hidden = true;   // v118: 안내 줄이 터널을 보여 주면 작은 터널 줄은 숨김
    renderColorLine();                           // v162 노면 색깔 유도선
    // 가까운 것이 위로 (v109 터널 줄 → v158 모든 줄): 그다음 안내·터널·휴게소·주차장 입구 줄을 차에서부터 잰 거리 순서로
    $('#restCard')._d = rs ? rs.d : Infinity;
    $('#parkGoal')._d = remain;
    orderByDist([[nn], [$('#colorRow')], [$('#tunnelRow')], [$('#restCard')], [$('#parkGoal')]]);
    $('#navRemain').textContent = fmtDist(remain);
    $('#navTime').textContent = fmtMin(remMs);
    $('#navEta').textContent = hhmm(new Date(Date.now() + remMs)) + ' 도착';   // 오른쪽 막대·경로 카드와 같은 순서
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
  // +/- 버튼·두 손가락·휠로 바꾼 배율은 2분 동안 자동 줌(속도·도착 300m)이 덮어쓰지 않는다.
  // v174 (2026-11-20 카페 시험자 '목적지 설정 후에는 인·아웃이 제대로 안 됩니다'): 예전엔 30초 뒤 자동 줌이 17 로 되돌렸다
  const MANUAL_ZOOM_MS = 120000;
  function manualZoom(d) {
    if (!mapA) return;
    mapA.zoomBy(d);
    zoomCtl.manualUntil = (state.fix ? state.fix.t : Date.now()) + MANUAL_ZOOM_MS;
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
    const key = name + '|' + area;
    if (el.dataset.k === key) return;
    el.dataset.k = key;
    if (!name && !area) { el.innerHTML = ''; if (!$('#backMe').hidden) placeBackMe(); return; }
    el.innerHTML = '<span class="rn-clip"><span class="rn-in">' + esc(name) + (area ? '<small>' + esc(area) + '</small>' : '') + '</span></span>';
    const clip = el.firstChild, inner = clip.firstChild;
    const over = inner.offsetWidth - clip.clientWidth;
    el.classList.toggle('slide', over > 4);
    if (over > 4) {
      inner.style.setProperty('--rn-shift', -over + 'px');
      inner.style.animationDuration = Math.round(7 + over / 25) + 's';   // 넘친 만큼 느긋하게 (한 번에 25px/초 정도)
    }
    if (!$('#backMe').hidden) placeBackMe();   // 띠 폭이 바뀌면 그 왼쪽 '내 위치로'도 따라간다
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
    motion.snap = !!(nav.active && nav.pts && nav.onRoute && nav.snap);   // v174: 경로선 가까이일 때만
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

  // ---------- 놓친 단속 카메라 스스로 알리기 (v117, 2026-11-15 보정동 가는 길 60km 단속 2번 놓침) ----------
  // 운영 서버 기록(/event)에는 원래 위치가 없어 어디서 놓쳤는지 알 수 없었다. 자료에 있는 속도 카메라 20m 안을
  // 경고 없이 지나치면, 그 카메라와 직전 40초 위치·방향 기록을 한 번 올린다 (누를 것 없음, 세션당 5번까지, 7일 보관).
  // 교차로를 가로질러 지난 옆 도로 카메라·반대편 차로용 한 방향 카메라는 빼고 (내 도로 이름과 다르거나 왼쪽 8m 밖)
  const fixLog = [];   // 최근 위치 [시각, 위도, 경도, 정확도, 기기 속도, 기기 방향, 쓴 방향]
  const camMiss = { near: new Map(), sent: 0 };
  const trace1 = [];   // v123: 1초 간격 최근 2분 30초 위치 [시각, 위도, 경도, 속도, 방향] (틀림·놓침 신고용)
  function logFix(f, devH) {
    if (!trace1.length || f.t - trace1[trace1.length - 1][0] >= 1000) {
      trace1.push([f.t, +f.lat.toFixed(6), +f.lng.toFixed(6), Math.round(state.speedKmh || 0), state.heading === null ? null : Math.round(state.heading)]);
      while (trace1.length > 150) trace1.shift();
    }
    fixLog.push([f.t, +f.lat.toFixed(6), +f.lng.toFixed(6), Math.round(f.acc || 0), f.speed == null ? null : +(+f.speed).toFixed(1),
      devH === null ? null : Math.round(devH), state.heading === null ? null : Math.round(state.heading)]);
    while (fixLog.length > 60) fixLog.shift();
  }
  // 최근 궤적이 가리키는 방향: 25m 넘게 떨어진 가장 가까운 과거 위치(12초 안)에서 지금 위치로.
  // 위치가 튄 곳(시속 250km 넘게 건너뜀: 터널 뒤·GPS 튐)을 만나면 거기서 끊고, 마지막 한 걸음의 방향과 30° 넘게 어긋나면 믿지 않는다
  function trackBearing(f) {
    let cur = { lat: f.lat, lng: f.lng, t: f.t }, last = null;
    for (let k = fixLog.length - 1; k >= 0; k--) {
      const e = fixLog[k];
      if (f.t - e[0] > 12000) return null;
      const p = { lat: e[1], lng: e[2] }, step = haversine(p, cur);
      if (step > 70 * Math.max(1, (cur.t - e[0]) / 1000) + 20) return null;
      if (last === null && step >= 4) last = bearing(p, f);
      if (haversine(p, f) >= 25) {
        const tb = bearing(p, f);
        return last !== null && angleDiff(last, tb) <= 30 ? tb : null;
      }
      cur = { lat: p.lat, lng: p.lng, t: e[0] };
    }
    return null;
  }
  // 경로 거리 at 앞뒤(300m 뒤 ~ 400m 앞)에 지하차도·고가차도 진입 안내가 있는지
  const GRADE_SEP = new Set([55, 56, 62, 64, 71, 73]);
  function gradeSepNear(at) {
    const last = nav.cum ? nav.cum.length - 1 : -1;
    if (last < 0) return false;
    return (nav.guides || []).some((g) => GRADE_SEP.has(g.t) && nav.cum[Math.min(g.i, last)] > at - 300 && nav.cum[Math.min(g.i, last)] < at + 400);
  }
  function camMissCheck(f) {
    if (!cams.loaded || !prefs.cams) return;
    const tg = camState.target;
    if (state.speedKmh >= 20) {
      for (const it of camsNear(f.lat, f.lng, 40)) {
        if (!isSpeedCam(it.c) || !camWanted(it.c) || isUserSpot(it.c)) continue;
        let m = camMiss.near.get(it.i);
        if (!m) { m = { minD: 1e9, side: 0, alerted: false }; camMiss.near.set(it.i, m); }
        if (it.d < m.minD) { m.minD = it.d; m.side = sideOf(f, it.c, it.d); m.kmh = Math.round(state.speedKmh); m.hdg = state.heading; }
        if (tg && tg.i === it.i) m.alerted = true;
      }
    }
    camMiss.near.forEach((m, i) => {
      const c = cams.rows[i];
      if (!c) { camMiss.near.delete(i); return; }   // 자료가 바뀌었다(다시 받음·시험)
      if (haversine(f, { lat: c[0], lng: c[1] }) < 60) return;
      camMiss.near.delete(i);
      // v161: '틀림'으로 표시한(흐리게·숨김) 카메라를 지나가면 늘 기록한다 (세션당 20번) — 정말 없는지·제한속도가 다른지 다시 보려고
      const fl = camFlag(c, m.hdg);
      if (fl && m.minD <= 30 && (camMiss.flagSent || 0) < 20) {
        camMiss.flagSent = (camMiss.flagSent || 0) + 1;
        const t2 = f.t;
        if (isOp()) report('warn', {
          msg: 'passed flagged camera ' + i, flag: fl, cam: i, lim: c[2], kind: c[3], dir: c[9], flags: c[10] || 0, camRoad: camRoad(c), myRoad: road.name,
          minD: Math.round(m.minD), side: Math.round(m.side), kmhAt: m.kmh, navOn: !!nav.active,
          trace: fixLog.slice(-40).map((e) => [Math.round((e[0] - t2) / 100) / 10].concat(e.slice(1))),
        });
        return;
      }
      // v123: 알린 카메라가 찍는 방향이 지나갈 때 내 진행 방향과 120° 넘게 다르면(반대 방향 카메라를 알린 것) 궤적을 올린다
      if (m.alerted && camHasDir(c) && m.hdg != null && angleDiff(c.eb, m.hdg) > 120 && (camMiss.leftSent || 0) < 5) {
        camMiss.leftSent = (camMiss.leftSent || 0) + 1;
        const t1 = f.t;
        if (isOp()) report('warn', {
          msg: 'opposite camera alerted ' + i, cam: i, eb: c.eb, hdg: Math.round(m.hdg), lim: c[2], kind: c[3], dir: c[9], flags: c[10] || 0, camRoad: camRoad(c), myRoad: road.name,
          minD: Math.round(m.minD), side: Math.round(m.side), kmhAt: m.kmh, navOn: !!nav.active,
          trace: fixLog.slice(-40).map((e) => [Math.round((e[0] - t1) / 100) / 10].concat(e.slice(1))),
        });
        return;
      }
      if (m.alerted || camState.passed.has(i) || camState.saidById.has(i) || m.minD > 20) return;
      // v122: 길안내가 카메라 앞뒤에서 지하차도·고가차도로 들어가면(교차로를 아래·위로 지나감) 그 교차로 신호 카메라는 놓친 게 아니다
      // (2026-11-15 21:46 분당수서로 남행 정자지하차도 앞, 오른쪽 20m 의 60 신호·과속 21198: 지상 교차로로 가는 차로용)
      if (nav.active && isSignalCam(c) && gradeSepNear(nav.along - 60)) return;
      const cr = camRoad(c);
      if (specificRoad(cr) && specificRoad(road.name) && !sameRoad(cr, road.name)) return;   // 가로지른 옆 도로
      if (!camDirOk(c, m.hdg)) return;                                                          // 내 방향이 아니다
      if (camMiss.sent >= 5) return;
      camMiss.sent++;
      const t0 = f.t;
      if (isOp()) report('warn', {   // v172: 자동 기록(궤적 포함)은 운영자 차만
        msg: 'missed camera ' + i, cam: i, lim: c[2], kind: c[3], dir: c[9], flags: c[10] || 0, camRoad: cr, myRoad: road.name,
        minD: Math.round(m.minD), side: Math.round(m.side), kmhAt: m.kmh, navOn: !!nav.active,
        trace: fixLog.slice(-40).map((e) => [Math.round((e[0] - t0) / 100) / 10].concat(e.slice(1))),
      });
    });
  }
  const hdgFix = { n: 0, bad: 0, sum: 0 };
  function onFix(f) {
    const t0 = performance.now();
    const prev = state.fix;
    if (prev && f.t <= prev.t) return; // 같은 시각이나 더 오래된(캐시된) 위치는 버린다
    lastFixWall = Date.now();
    $('#speed').classList.remove('stale');
    let v = Number.isFinite(f.speed) && f.speed >= 0 ? f.speed : null; // m/s
    let h = Number.isFinite(f.heading) ? f.heading : null;
    const devH = h;

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
    // v117: 차 GPS 의 방향 값이 실제 지나온 궤적(최근 25m 이상)과 45° 넘게 다르면 궤적을 믿는다.
    // 길안내 없이 달릴 때는 이 방향으로 앞의 카메라를 고르므로, 방향 값이 틀리면 단속 경고가 안 뜬다. 처음 20번째에 한 번 알린다
    const tb = devH !== null && kmh >= 15 ? trackBearing(f) : null;
    if (tb !== null) {
      hdgFix.n++;
      const dd = angleDiff(devH, tb);
      if (dd > 45) {
        h = tb; hdgFix.bad++; hdgFix.sum += dd;
        if (hdgFix.bad === 20) report('warn', { msg: 'gps heading disagrees with track', bad: hdgFix.bad, of: hdgFix.n, avgDiff: Math.round(hdgFix.sum / hdgFix.bad) });
      }
    }
    if (state.speedKmh > (state.maxKmh || 0) && state.speedKmh < 250) state.maxKmh = state.speedKmh; // 튀는 값 제외
    if (h !== null && state.speedKmh >= 3) state.heading = h; // 정지 중 GPS 방향은 믿지 않음
    state.fix = f;
    logFix(f, devH);
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
    camMissCheck(f);
    tunnelDarkTick();   // v172
    updateSoundPill();
    if (cams.failed || cams.mobileMissing) renderCamStatus();
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
  // v160 (2026-11-20 점검): 길안내 없이 신호를 2분 넘게 기다리면 새로고침돼 소리가 꺼진 채 달리고 구간단속도 사라졌다.
  // 이 페이지에서 시속 10 넘게 달린 뒤로는 15분 넘게 서 있어야(주차) 바꾼다. 구간단속 안이면 바꾸지 않는다
  function idleUpdate(now, dry) {
    if (state.speedKmh >= 10) upd.droveAt = now;
    if (state.speedKmh >= 3) { upd.movedAt = now; return 'moving'; }
    if (now - upd.movedAt < 120000) return 'just-stopped';
    if (upd.droveAt && now - upd.droveAt < 15 * 60000) return 'drove-recently';
    if (camState.section) return 'section';
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
    tunnelDarkTick(now.getTime());   // v172: 터널 안이면 어둡게
    // 서 있을 때는 GPS 가 드문드문 와도 북쪽 위 전환이 늦지 않게 시계로도 본다
    if (state.fix && !state.demoTimer) checkStopNorth(state.fix.t + (Date.now() - lastFixWall));
    if (!state.demoTimer && !testPage) idleUpdate(Date.now());
    if (!testPage && Date.now() - (outbox.tryAt || 0) > 60000) { outbox.tryAt = Date.now(); if (store.get('outbox')) outboxFlush(); }
    if (!testPage && Date.now() - (upd.peekAt || 0) > 2 * 60000) { upd.peekAt = Date.now(); peekVersion(); }
    maybeResume();
    $('#clock').textContent = hhmm(now);
    $('#dateText').textContent = (now.getMonth() + 1) + '월 ' + now.getDate() + '일 (' + '일월화수목금토'[now.getDay()] + ')';
    mapWatchdog();
    if (now.getSeconds() % 2 === 0) placeCredit();   // v173: 네이버 출처 표시 길이가 바뀌면(교통·다크 지도) 따라간다
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
    tunnelCamTick();
    // v171: 모든 사용자 고침 목록을 30분마다 (주행 중에도 카메라 표 끝만 바뀐다)
    if (!testPage && cams.loaded && Date.now() - (upd.fixesAt || Date.now()) > 30 * 60000) { upd.fixesAt = Date.now(); if (!camState.target) loadSharedFixes(); }
    if (!upd.fixesAt) upd.fixesAt = Date.now();
  }
  // v163: 터널 안에서 1.5초 넘게 위치가 안 오면, 마지막 속도로 경로를 따라 나아간 자리(터널 출구 + 30m 까지)로 단속 카메라를 본다.
  // 다음 GPS 가 오면 그 위치로 돌아간다 (길안내 경로 위에서 달리던 때만, 10분까지)
  function tunnelCamTick(nowWall) {
    const now = nowWall || Date.now(), lag = (now - lastFixWall) / 1000;
    if (!nav.active || !nav.pts || !state.fix || !nav.onRoute || state.demoTimer || !prefs.cams) return false;
    if (lag < 1.5 || lag > 600 || state.speedKmh < 10) return false;   // 긴 터널(4.9km)을 시속 60 으로 지나면 5분 (터널 출구 + 30m 에서 멈춘다)
    const tn = routeTunnelAt(nav.along) || routeTunnelAt(nav.along + 50);
    if (!tn) return false;
    const keep = nav.along, along = Math.min(tn.s1 + 30, keep + state.speedKmh / 3.6 * lag);
    if (along <= keep + 1) return false;
    const p = routePointAt(along);
    const f = { lat: p.lat, lng: p.lng, t: state.fix.t + lag * 1000, acc: 50, dr: true };
    nav.along = along;
    try { evalCameras(f); } finally { nav.along = keep; }
    return true;
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
    syncZoomGestures();
    if (!on && !noAutoReturn) armRefollow();
  }
  // v148 (2026-11-16 사용자: '내비 찍고 갈 때 확대 축소하면 갑자기 내 방향이 풀린다 — 안 풀리고 내 방향에서 되게'):
  // 지도 라이브러리의 두 손가락 확대는 손가락 사이를 중심으로 확대하며 끌기(dragstart)도 내서 따라가기가 꺼졌다.
  // 멈춰서 북쪽 위가 된 지도에서 확대하면 출발해도 진행 방향으로 안 돌아오고 5~15초 그대로였다.
  // 그래서 내 위치를 따라가는 동안(과 주행 화면)은 두 손가락·휠·두 번 톡 확대를 앱이 한다: 내 차를 가운데 둔 채 한 단계씩, 따라가기 그대로
  const ownZoom = () => !!mapA && (view.drive || state.following);
  function syncZoomGestures() {
    if (!mapA || !mapA.setLibZoom) return;
    try { mapA.setLibZoom(!ownZoom()); } catch (e) { /* 다음 배치 때 다시 */ }
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
  function renderBackMe() { $('#backMe').hidden = state.following || nav.preview || !state.fix; placeBackMe(); }
  // 테슬라 모드: '내 위치로'는 맨 아래 줄, 지금 위치 띠(도로 이름) 바로 왼쪽에 같은 높이로 (2026-11-16 사용자 표시: 가운데 위에 뜨면
  // 차 앞길을 가렸다). 왼쪽 아래 주행 기록과 겹치면 버튼이 떠 있는 동안(손 떼고 5초)만 주행 기록을 숨긴다
  function placeBackMe() {
    const b = $('#backMe'), app = $('#app'), road = $('#roadName');
    const side = !b.hidden && app.classList.contains('tesla') && !!road && road.offsetWidth > 0;
    b.classList.toggle('side', side);
    if (!side) { app.classList.remove('bm-trip'); return; }
    const mr = $('#map').getBoundingClientRect(), rr = road.getBoundingClientRect();
    const left = Math.max(8, Math.round(rr.left - mr.left - 10 - b.offsetWidth));
    const bottom = Math.round(mr.bottom - (rr.top + rr.bottom) / 2 - b.offsetHeight / 2);
    b.style.setProperty('--bm-left', left + 'px');
    b.style.setProperty('--bm-bottom', bottom + 'px');
    const tr = $('.trip') ? $('.trip').getBoundingClientRect() : null;
    app.classList.toggle('bm-trip', !!tr && tr.width > 0 && mr.left + left < tr.right + 6 && mr.bottom - bottom - b.offsetHeight < tr.bottom);
  }
  // 지도 라이브러리가 직접 끌기 시작(북쪽 위 평면 지도): 손가락이 닿아 있는 동안은 기다렸다가 뗄 때부터 시간을 잰다
  // 두 손가락(확대) 중에 라이브러리가 내는 끌기는 따라가기를 끄지 않는다 (v148)
  function onUserPan() {
    if (gesture.pointers.size >= 2 || gesture.two) return;
    setFollowing(false, nav.preview || gesture.pointers.size > 0, !!(view.drive && glOn()));
  }
  // 지도 손 조작: 톡 치기는 화면 버튼만 보여 준다.
  // 진행 방향 위 주행 화면에서 10px 넘게 끌면 방향·기울기는 그대로 둔 채 지도만 손가락을 따라 옮긴다(앞길 보기).
  // 두 손가락·휠은 가운데(내 차)를 그대로 두고 한 단계씩 확대/축소. 북쪽 위 평면 지도는 지도 라이브러리가 직접 처리한다.
  // two·own·wasFollowing·prePan (v148): 두 손가락이었는지, 앱이 확대했는지, 시작할 때 따라가던 중이었는지, 둘째 손가락 전에 끈 거리
  // downAt·lastTap: 두 번 톡 확대 · lpT·lp: 길게 눌러 그 자리 정보(v148 pickAt)
  const gesture = { x: 0, y: 0, lx: 0, ly: 0, used: false, panning: false, pinch: 0, wheelAt: 0, pointers: new Map(),
    two: false, own: false, wasFollowing: false, prePan: 0, downAt: 0, lastTap: null, lpT: 0, lp: false };
  const LONG_PRESS_MS = 550;
  function cancelLongPress() { clearTimeout(gesture.lpT); gesture.lpT = 0; }
  const NOT_MAP = '.btn, .searchbtn, .navpanel, .routecard, .toast, #diagBox, .ctrls, .topctrls, .badge, .soundpill, .navtray, .updbtn, .backme';
  function userMapGesture() {
    gesture.used = true;
    // 손으로 바꾼 배율은 2분 동안 자동 줌이 덮어쓰지 않게 한다 (v174)
    zoomCtl.manualUntil = (state.fix ? state.fix.t : Date.now()) + MANUAL_ZOOM_MS;
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
      gesture.two = false; gesture.own = false; gesture.wasFollowing = state.following; gesture.prePan = 0;
      gesture.downAt = Date.now(); gesture.lp = false;
      cancelLongPress();
      if (e.button === 0 || e.pointerType === 'touch') gesture.lpT = setTimeout(onLongPress, LONG_PRESS_MS);
    } else if (gesture.pointers.size === 2) {
      cancelLongPress();
      const first = [...gesture.pointers.values()][0];
      gesture.prePan = Math.hypot(first.x - gesture.x, first.y - gesture.y);
      gesture.two = true;
      // 따라가던 중이었으면(첫 손가락이 조금 먼저 움직여 따라가기가 꺼졌어도) 앱이 내 차 가운데로 확대한다.
      // 라이브러리가 이 두 손가락을 보기 전에(캡처 단계) 라이브러리 확대·끌기를 끈다
      gesture.own = ownZoom() || (gesture.wasFollowing && gesture.prePan < 60);
      if (gesture.own && mapA) {
        try { if (mapA.setLibZoom) mapA.setLibZoom(false); if (mapA.setDrag) mapA.setDrag(false); } catch (err) { /* 무시 */ }
      }
      gesture.pinch = pinchDist(); userMapGesture();
    }
  }
  // 길게 누르기: 그 자리 정보 카드 (손가락이 10px 넘게 움직이거나 두 손가락이면 취소)
  function onLongPress() {
    gesture.lpT = 0;
    if (gesture.pointers.size !== 1 || gesture.used) return;
    gesture.lp = true; gesture.used = true;
    pickAt(gesture.x, gesture.y);
  }
  function onMapMove(e) {
    const p = gesture.pointers.get(e.pointerId);
    if (!p) return;
    p.x = e.clientX; p.y = e.clientY;
    if (gesture.pointers.size >= 2) {
      // 앱이 확대할 때(주행 화면·따라가는 중): 두 손가락 간격이 1.22배 벌어지거나 줄면 내 차를 가운데 둔 채 한 단계씩
      // (v174: 1.35배는 테슬라 화면에서 손가락을 꽤 벌려야 해서 안 되는 것처럼 느껴졌다)
      if (gesture.own && gesture.pinch && mapA) {
        const d = pinchDist(), r = d / gesture.pinch;
        if (r > 1.22 || r < 0.82) { mapA.zoomBy(r > 1 ? 1 : -1); gesture.pinch = d; userMapGesture(); }
      }
      return;
    }
    if (!gesture.used && Math.hypot(e.clientX - gesture.x, e.clientY - gesture.y) > 10) {
      cancelLongPress();
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
    if (gesture.pointers.size) return;
    cancelLongPress();
    if (gesture.two) {
      // 두 손가락을 다 떼면 라이브러리 끌기를 되돌리고, 따라가던 중이었으면 바로 내 위치·진행 방향으로 (5초 기다리지 않는다)
      if (gesture.own && mapA && mapA.setDrag) { try { mapA.setDrag(true); } catch (err) { /* 무시 */ } }
      syncZoomGestures();
      if (gesture.own && gesture.wasFollowing && !nav.preview) { if (!state.following) setFollowing(true); return; }
    } else if (!gesture.used && e.type === 'pointerup' && Date.now() - gesture.downAt < 300) {
      // 두 번 톡: 앱이 확대할 때(따라가는 중·주행 화면)는 내 차를 가운데 둔 채 한 단계 확대
      const now = Date.now(), lt = gesture.lastTap;
      if (ownZoom() && lt && now - lt.t < 350 && Math.hypot(e.clientX - lt.x, e.clientY - lt.y) < 40) {
        gesture.lastTap = null;
        manualZoom(1);
        return;
      }
      gesture.lastTap = { t: now, x: e.clientX, y: e.clientY };
    }
    if (!state.following) armRefollow();
  }
  function onMapWheel(e) {
    if (e.target.closest && e.target.closest(NOT_MAP)) return;
    userMapGesture();
    if (!ownZoom() || !e.deltaY) return;
    const now = Date.now();
    if (now - gesture.wheelAt > 250) { gesture.wheelAt = now; mapA.zoomBy(e.deltaY < 0 ? 1 : -1); }
  }
  // PC 오른쪽 클릭 = 길게 누르기. 길게 누를 때 브라우저 메뉴가 뜨지 않게
  function onMapMenu(e) {
    if (e.target.closest && e.target.closest(NOT_MAP)) return;
    e.preventDefault();
    if (gesture.lp) return; // 길게 누르기로 이미 열었다
    cancelLongPress();
    gesture.used = true;
    pickAt(e.clientX, e.clientY);
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
    toast(on ? '진행 방향 위로' : '북쪽 위로', '', 2000);
  }
  $('#hupBtn').onclick = () => setHeadingUp(!prefs.headingUp);
  $('#map').addEventListener('pointerdown', onMapDown, true);
  $('#map').addEventListener('pointermove', onMapMove, { capture: true, passive: true });
  window.addEventListener('pointerup', onMapUp, true);
  window.addEventListener('pointercancel', onMapUp, true);
  $('#map').addEventListener('wheel', onMapWheel, { capture: true, passive: true });
  $('#map').addEventListener('contextmenu', onMapMenu, true);
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
    if (!isOp()) { toast('운영자 토큰이 있어야 올릴 수 있어요 (개발자 메뉴).', 'bad', 5000); return; }
    toast('기록 올리는 중…', '', 0);
    try {
      // v172: 서버가 500KB 까지만 받는다 → 최근 기록부터 들어가는 만큼
      let rows = diag.log.slice(-5000);
      while (rows.length > 100 && JSON.stringify(rows).length > 470000) rows = rows.slice(Math.floor(rows.length / 4));
      const ctrl = new AbortController(), to = setTimeout(() => ctrl.abort(), 90000);
      const r = await fetch(proxyUrl() + '/log', {
        method: 'POST', signal: ctrl.signal, headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          ua: navigator.userAgent, screen: [screen.width, screen.height, devicePixelRatio],
          viewport: [innerWidth, innerHeight], map: mapA === NaverAdapter ? 'naver' : 'osm',
          fields: ['now', 'gpsTime', 'lat', 'lng', 'acc', 'speed', 'heading', 'shownKmh', 'procMs', 'demo'],
          rows,
        }),
      }).finally(() => clearTimeout(to));
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(r.status === 401 ? '운영자 토큰이 맞지 않아요' : (j.error || 'HTTP ' + r.status));
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
    if (gpsDenied) { setGps('bad', '위치 권한 꺼짐'); gpsNotice(true); } else setGps('warn', 'GPS 신호 찾는 중');
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
    window.addEventListener('pointerdown', (e) => {
      if (!sim.on || e.button !== 0 || !onCar(e)) return;
      e.stopImmediatePropagation(); e.preventDefault();
      sim.dragging = true;
      ghost = document.createElement('div'); ghost.className = 'simghost';
      ghost.style.left = e.clientX + 'px'; ghost.style.top = e.clientY + 'px';
      document.body.appendChild(ghost);
    }, true);
    window.addEventListener('mousedown', (e) => { if (sim.dragging) { e.stopImmediatePropagation(); e.preventDefault(); } }, true);
    window.addEventListener('pointermove', (e) => { if (sim.dragging) e.stopImmediatePropagation(); }, true);
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
    $('#camWrong').onclick = (ev) => {
      ev.stopPropagation();
      const tg = camState.target, card = $('#camCard');
      // v161: 화면에 그려진 카메라에만. 카드가 방금(1초 안) 다른 카메라로 바뀌었으면 누름을 무시한다(엉뚱한 카메라가 표시되지 않게)
      if (!tg || card._camI !== tg.i || Date.now() - (card._camAt || 0) < 1000) {
        toast('카드가 방금 바뀌었어요. 맞으면 한 번 더 눌러 주세요.', '', 2500);
        return;
      }
      userReport('wrong');
      // v169: 내가 신고한 지점이 틀렸으면 그 지점을 지운다
      if (isUserSpot(tg.c) && tg.c.who === 'mine') {
        const m = mySpots.find((x) => sameSpot(x, { lat: tg.c[0], lng: tg.c[1], h: tg.c.eb >= 0 ? tg.c.eb : null }));
        camState.passed.set(tg.i, state.fix ? state.fix.t : Date.now());
        camState.target = null;
        if (m) removeMySpot(m);
        renderCam(); renderMySpots();
        toast('내가 신고한 단속 지점을 지웠어요.', '', 3000);
        return;
      }
      const h = state.heading === null ? null : Math.round(state.heading);
      const st = camFlagAdd(tg.c, h);
      tg.flag = st;
      if (st === 'hide') {
        camState.passed.set(tg.i, state.fix ? state.fix.t : Date.now());
        camState.target = null;
      }
      renderCam();
      renderCamFlags();
      toast(st === 'hide' ? '다른 날에도 틀렸다고 해서 이 방향에서는 숨길게요. 설정에서 되돌릴 수 있어요.'
        : (prefs.share ? '틀린 경고로 보냈어요. ' : '틀린 경고로 표시했어요. ') + '14일 동안 이 카메라는 흐리게, 소리 없이 보여 줄게요(제한속도 ?).', '', 3500);
    };
    // v147: 누른 것이 버튼에서 바로 보이게 — 2.5초 동안 파란 바탕 '✓ 보냄', 그사이 또 누르면 다시 보내지 않는다
    $('#camMissBtn').onclick = (ev) => {
      ev.stopPropagation();
      const b = $('#camMissBtn');
      if (b.classList.contains('sent') || b.classList.contains('sending')) return;
      b.classList.add('sending'); b.textContent = '보내는 중…';
      clearTimeout(b._sentT);
      // v171: 누르는 순간 차 안에서 원인을 찾아 고친다. 우리 자료에 후보가 없으면 '내가 신고한 단속 지점'으로 저장 (v169)
      let fx = { items: [], text: '', diag: [] };
      try { fx = fixFromMiss(); } catch (e) { const m = addMySpot(); fx.text = m ? '새 단속 지점으로 저장했어요.' : ''; }
      const spot = !!fx.text;
      renderMySpots();
      sendFixes(fx.items);
      // v163: 서버가 받았을 때만 파란 '✓ 보냄'. 못 보냈으면 '저장함'(연결되면 보냄)
      Promise.resolve(userReport('missed', { diag: fx.diag, fix: fx.fixed || null })).then((ok) => {
        b.classList.remove('sending');
        const tail = spot ? ' ' + fx.text : '';
        if (!prefs.share) { b.classList.add('sent'); b.textContent = '✓ 저장'; toast((fx.text || '이 차에 표시했어요.') + ' (서버로 보내지 않음)', '', 4000); }
        else if (ok === false) { b.classList.add('sent', 'saved'); b.textContent = '저장함'; toast('연결이 안 돼 저장해 두었어요. 연결되면 보낼게요.' + tail, '', 4000); }
        else { b.classList.add('sent'); b.textContent = '✓ 보냄'; toast('놓친 단속 위치를 보냈어요.' + tail, '', 4000); }
        b._sentT = setTimeout(() => { b.classList.remove('sent', 'saved'); b.textContent = '놓침'; }, MISS_SENT_MS);
      });
    };

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
    state.night = isNightAt(new Date()) || (nightMode() === 'auto' && tnDark.on);   // v172: 터널 안이면 어둡게
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
    $('#optVoice').checked = prefs.voice;
    $('#optBeep').checked = prefs.beep;
    $('#optCams').checked = prefs.cams;
    $('#optSigCams').checked = prefs.signalCams;
    $('#optBumps').checked = prefs.bumps;
    $('#optParking').checked = prefs.parking;
    $('#optRest').checked = prefs.rest;
    $('#optSigns').checked = prefs.signs;
    $('#optJunction').checked = prefs.junction;
    $('#optLanes').checked = prefs.lanes;
    $('#optTraffic').checked = prefs.traffic;
    $('#optWeather').checked = prefs.weather;
    $('#optHup').checked = prefs.headingUp;
    $('#optStopNorth').checked = prefs.stopNorth;
    $('#optStopNorth').disabled = glOn();
    $('#optGl').checked = prefs.gl;
    renderCarIcons();
    $('#optNight').value = nightMode();
    $('#optTilt').checked = prefs.tilt;
    $('#optTilt').disabled = !prefs.headingUp;
    $('#optRoute').value = prefs.routeOpt;
    $('#proxyInput').value = proxyUrl();
    $('#camCount').textContent = cams.loaded ? cams.rows.length.toLocaleString('ko-KR') : '-';
    $('#camDate').textContent = cams.date || '-';
    renderCamFlags();
    renderMySpots();
    $('#optShare').checked = prefs.share;
    renderVoiceState();
    $('#verText').textContent = APP_VERSION;
    renderDevMenu();
    updateDemoBtn();
    sheet.hidden = false;
    $('.settings').scrollTop = 0;
    if (devMenuOn()) checkProxy();
  };
  // v172: 개발자 메뉴 — '정보'의 버전 글자를 5번 톡 누르면 열린다(이 기기에 기억). 메뉴 맨 아래 '개발자 메뉴 숨기기'로 닫는다.
  // 서버 주소·진단·데모·아이콘 관리·소리 테스트·운영자 토큰. 공개 사용자는 토큰이 없으니 열어도 해가 없다
  const devTap = { n: 0, at: 0 };
  const devMenuOn = () => store.get('dev') === '1' || params.has('debug');
  function renderDevMenu() {
    $('#devMenu').hidden = !devMenuOn();
    $('#adminState').textContent = isOp() ? '들어 있음 (이 기기)' : '없음';
    $('#devIdText').textContent = devId;
  }
  $('#verText').onclick = () => {
    const now = Date.now();
    devTap.n = now - devTap.at < 1500 ? devTap.n + 1 : 1;
    devTap.at = now;
    if (devTap.n < 5) return;
    devTap.n = 0;
    if (devMenuOn()) { $('#devMenu').scrollIntoView({ block: 'start' }); return; }
    store.set('dev', '1'); renderDevMenu(); checkProxy();
    toast('개발자 메뉴를 열었어요.', '', 2500);
    $('#devMenu').scrollIntoView({ block: 'start' });
  };
  $('#devHide').onclick = () => { store.set('dev', null); renderDevMenu(); toast('개발자 메뉴를 숨겼어요. 버전 글자를 5번 누르면 다시 열려요.', '', 3000); };
  $('#adminSave').onclick = () => {
    const v = $('#adminInput').value.trim();
    $('#adminInput').value = '';
    if (!v) { toast('토큰을 넣어 주세요.', 'bad', 2500); return; }
    if (v.length < 16) { toast('토큰이 너무 짧아요 (16자 넘게).', 'bad', 3000); return; }
    store.set('adminToken', v); renderDevMenu();
    toast('운영자 토큰을 이 기기에 넣었어요.', '', 2500);
  };
  $('#adminClear').onclick = () => { store.set('adminToken', null); renderDevMenu(); toast('운영자 토큰을 지웠어요.', '', 2500); };
  // 토큰 확인: 운영자만 읽을 수 있는 /events 를 1건만 읽어 본다 (401 = 토큰이 다름, 막힘 = 서버가 아직 예전 Worker)
  $('#adminCheck').onclick = async () => {
    const st = $('#adminState');
    if (!isOp()) { st.textContent = '없음'; return; }
    st.textContent = '확인 중…';
    try {
      const r = await fetch(proxyUrl() + '/events?limit=1', { headers: authHeaders({}), cache: 'no-store' });
      st.textContent = r.ok ? '들어 있음 · 서버와 맞음' : r.status === 401 ? '들어 있음 · 서버 ADMIN_TOKEN 과 다름' : '들어 있음 · 서버 응답 ' + r.status;
    } catch (e) {
      st.textContent = '들어 있음 · 서버가 받지 않음 (예전 Worker 이거나 연결 안 됨)';
    }
  };
  $('#optShare').onchange = (e) => { prefs.share = e.target.checked; store.set('share', prefs.share ? null : '0'); };
  $('#closeSheet').onclick = () => { sheet.hidden = true; };
  // v161: 설정 — '틀림'으로 표시한 카메라 목록 (하나씩·모두 되돌리기)
  function renderCamFlags() {
    const box = $('#camFlagBox'), ul = $('#camFlagList');
    if (!box || !ul) return;
    const now = Date.now(), items = [];
    camNoMap.forEach((es, key) => es.forEach((e) => {
      const st = e.days.length >= 2 ? 'hide' : now - e.t1 < CAM_DOUBT_MS ? 'doubt' : null;
      if (st) items.push({ key, e, st });
    }));
    items.sort((a, b) => b.e.t1 - a.e.t1);
    box.hidden = !items.length;
    ul.innerHTML = '';
    for (const it of items) {
      const li = document.createElement('li');
      const left = Math.max(1, Math.ceil((CAM_DOUBT_MS - (now - it.e.t1)) / 86400e3));
      const d = new Date(it.e.t1);
      const sp = document.createElement('span');
      sp.textContent = (it.e.name || '단속 카메라') + (it.e.lim ? ' ' + it.e.lim : '');
      const sm = document.createElement('small');
      sm.textContent = ' · ' + (d.getMonth() + 1) + '/' + d.getDate() + ' · ' + (it.st === 'hide' ? '숨김' : '흐리게 ' + left + '일 남음');
      sp.appendChild(sm);
      const b = document.createElement('button');
      b.type = 'button'; b.textContent = '되돌리기';
      b.onclick = () => {
        const a = (camNoMap.get(it.key) || []).filter((x) => x !== it.e);
        if (a.length) camNoMap.set(it.key, a); else camNoMap.delete(it.key);
        saveCamNo(); renderCamFlags();
        const tg = camState.target;
        if (tg) { tg.flag = camFlag(tg.c, state.heading); renderCam(); }
      };
      li.appendChild(sp); li.appendChild(b);
      ul.appendChild(li);
    }
  }
  // v169: 설정 — 내가 신고한 단속 지점 (상태와 지우기)
  const SPOT_STATUS = { data: '단속 자료에 있음', driver: '모든 사용자에게 반영됨', crowd: '여러 운전자 신고로 반영됨(확인 전)', twice: '두 번 넘게 신고 · 다음 자료에 넣음', mine: '이 차에서만 알림' };
  const FIX_SHORT = { dir: '양방향으로 봄', route: '경로 위로 봄', signal: '신호 전용도 알림' };
  function renderMySpots() {
    const box = $('#mySpotBox'), ul = $('#mySpotList');
    if (!box || !ul) return;
    box.hidden = !mySpots.length && !camFixes.size;
    ul.innerHTML = '';
    // v171: '놓침' 진단으로 이 차에서 고친 카메라 (되돌리기)
    camFixes.forEach((kinds, k) => {
      const c = cams.loaded ? cams.rows.find((x) => camKey(x) === k) : null;
      const li = document.createElement('li');
      const sp = document.createElement('span');
      sp.textContent = '고친 카메라 · ' + (c ? camLabel(c) + (c[2] ? ' ' + c[2] : '') : k);
      const sm = document.createElement('small');
      sm.textContent = ' · ' + [...kinds].map((x) => FIX_SHORT[x] || x).join(', ');
      sp.appendChild(sm);
      const b = document.createElement('button');
      b.type = 'button'; b.textContent = '되돌리기';
      b.onclick = () => { camFixes.delete(k); saveCamFixes(); applyCamFixes(); renderMySpots(); };
      li.appendChild(sp); li.appendChild(b);
      ul.appendChild(li);
    });
    for (const m of mySpots.slice().sort((a, b) => b.t - a.t)) {
      const li = document.createElement('li');
      const d = new Date(m.t || Date.now());
      const sp = document.createElement('span');
      const D8 = ['북', '북동', '동', '남동', '남', '남서', '서', '북서'];
      sp.textContent = (m.h == null ? '' : D8[Math.round(((m.h % 360) + 360) % 360 / 45) % 8] + '쪽으로 갈 때 ') + '신고한 단속 지점';
      const sm = document.createElement('small');
      sm.textContent = ' · ' + (d.getMonth() + 1) + '/' + d.getDate() + (m.days.length > 1 ? ' 외 ' + (m.days.length - 1) + '번' : '') + ' · ' + SPOT_STATUS[mySpotStatus(m)];
      sp.appendChild(sm);
      const b = document.createElement('button');
      b.type = 'button'; b.textContent = '지우기';
      b.onclick = () => { removeMySpot(m); renderMySpots(); };
      li.appendChild(sp); li.appendChild(b);
      ul.appendChild(li);
    }
  }
  $('#mySpotClear').onclick = () => {
    mySpots.length = 0; saveMySpots(); applyUserSpots();
    camFixes.clear(); saveCamFixes(); applyCamFixes();
    renderMySpots(); toast('내가 신고한 단속 지점과 고친 카메라를 모두 되돌렸어요.', '', 2500);
  };
  $('#camFlagClear').onclick = () => {
    camNoMap.clear(); saveCamNo(); renderCamFlags();
    const tg = camState.target;
    if (tg) { tg.flag = null; renderCam(); }
    toast('틀림 표시를 모두 되돌렸어요.', '', 2500);
  };

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
  $('#optVoice').onchange = (e) => { prefs.voice = e.target.checked; store.set('voice', prefs.voice ? null : '0'); updateSoundPill(); };
  $('#optBeep').onchange = (e) => { prefs.beep = e.target.checked; store.set('beep', prefs.beep ? null : '0'); updateSoundPill(); };
  $('#optNight').onchange = (e) => setNightMode(e.target.value);
  $('#optJunction').onchange = (e) => {
    prefs.junction = e.target.checked; store.set('junction', prefs.junction ? null : '0');
    if (nav.active) renderNav();
  };
  $('#optRest').onchange = (e) => {
    prefs.rest = e.target.checked; store.set('rest', prefs.rest ? null : '0');
    restState.key = '';
    if (nav.active) renderNav(); else renderRest();
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
  $('#optLanes').onchange = (e) => {
    prefs.lanes = e.target.checked; store.set('lanes', prefs.lanes ? null : '0');
    if (nav.active) renderNavPanel();
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
    if (!speak('음성 안내 테스트입니다. 500미터 앞, 단속 카메라. 제한속도 60입니다.', true)) {
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
  setTimeout(() => report('session', { msg: 'open', tts: ttsStatus(), debug: params.has('debug'), scheme: (window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches) ? 'dark' : 'light', night: nightMode() }), 6000); // 지도·GPS 상태가 잡힌 뒤 접속 기록
  render();
  tickClock();
  setInterval(tickClock, 1000);
  bootMap();
  loadCameras();
  loadBumps();
  loadParking();
  loadRest();
  loadSigns();
  loadLanes();
  loadForks();
  loadColorLines();
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
      setTimeout(() => toast('새 버전(' + APP_VERSION.split('-').pop() + ')으로 바뀌었어요', '', 4000), 1500);
    }
  } catch (e) { /* 저장소 막힘 */ }
  $('#ntVer').textContent = '버전 ' + APP_VERSION.slice(5);
  document.addEventListener('visibilitychange', () => {
    // 화면이 오래(5분 넘게) 가려졌다가 다시 보이면 새 버전을 확인한다 (길안내 중·주행 중이면 하지 않음)
    if (document.visibilityState === 'hidden') upd.hiddenAt = Date.now();
    else {
      if (upd.hiddenAt && Date.now() - upd.hiddenAt > 5 * 60000) checkForUpdate('visible');
      resumeVisible();
    }
  });
  // v174 (2026-11-20 카페 시험자 '후진 이후 브라우저를 다시 눌러야 하는데'): 후진하면 테슬라가 후방 카메라를 띄우고, 다시 앞으로 가면
  // 테슬라 지도로 돌아간다(차 소프트웨어 동작이라 웹페이지가 바꿀 수 없음). 브라우저를 다시 눌렀을 때 바로 이어지게:
  // 멈춘 소리(오디오·음성 줄)를 풀고, 위치가 3초 넘게 안 왔으면 위치 받기를 다시 걸고, 지도 크기·배치를 다시 맞춘다. 길안내는 그대로
  function resumeVisible() {
    try { if (actx && actx.state === 'suspended') actx.resume(); } catch (e) { /* 다음 누름에 */ }
    try { if (hasTTS && speechSynthesis.paused) speechSynthesis.resume(); } catch (e) { /* 없음 */ }
    if (!state.demoTimer && !testPage && Date.now() - lastFixWall > 3000) { try { startGps(); } catch (e) { /* 다음 시계에 */ } }
    queueLayout();
    mapCheckTick = 4; mapWatchdog();
    if (nav.active) renderNav();
  }
  window.addEventListener('pageshow', (e) => { if (e.persisted) resumeVisible(); });
  // ?debug 일 때만 내부 상태를 콘솔에서 볼 수 있게 연다 (테스트용)
  if (params.has('debug')) {
    window.__tnc = {
      state, camState, nav, cams, prefs, onFix, setRoute, startNav, endNav, startDemo, stopDemo, renderNav,
      planRoute, doSearch, setFollowing, canvasPoint, gesture, glView, glOn, evalCameras, navUpdate, loadCameras, getMap: () => mapA,
      view, layoutView, zoomCtl, autoZoom, motion, alertLog, checkForUpdate, version: APP_VERSION,
      sunElevation, isNightAt, setNightMode, openSearch, favs, setFav, idleUpdate, upd, openTray, closeTray, endCompare, selectAlt, pickDest, updateUrl, resumeFrom, renderCam, renderUpdBtn, bumps, bumpState, bumpsNear, evalBumps, arrowSays,
      saveTripNow, restoreTripNow, trafficColor, highwaySpans, turnKind, tollState, hipass, setHipassData, loadHipass, hipassKey, hipassNums, hipassLayout, laneNums, laneStripHtml, tunnels, setTunnelData, loadTunnels, ensureRouteTunnels, tunnelAhead, renderTunnel, juncInfo, juncSvg, renderJunction, ico, icoBase, pickImg, iconPicks: ICON_PICKS, tollParts, arrowSpan, routeStyle: ROUTE_STYLE, trafficPal, roundRoute, setCarIcon, carIcons: CAR_ICONS, parking, parkState, setParkingData, loadParking, evalParking, rest, setRestData, loadRest, ensureRouteRest, renderRest, placeBase, findParking, renderTurnArrow,
      lanesData, laneState, setLaneData, loadLanes, laneGuide, laneArrowSvg, laneOk, laneTipFor, laneCell,
      forksData, setForkData, loadForks, ensureRouteForks, forkLane,
      clData, setColorLines, loadColorLines, ensureRouteColorLines, colorLineAhead,
      signs, signState, setSignData, loadSigns, evalSigns, SIGN_TYPES, road, localOnRoute, routeNamesAt, sameStreet, bumpRoad, signRoad,
      tripLog, loadTrips, finishTrip, renderTrips, wxIcon, renderWeather, weather, guideText, dirNames, juncSignHtml, kindSide, textSide, turnKind0, iconKind, findParking, parkLabel, expwayNo, camMiss, camMissCheck, store, tts, ttsStatus, ttsNotice, renderVoiceState, resumeVisible, MANUAL_ZOOM_MS, routePointAt, tnDark, inTunnelNow, tunnelDarkTick, namedTunnelAt, isOp, adminToken, renderDevMenu, devMenuOn, authHeaders, placeCredit, updateAttrib, applyNight, nightMode, userReport, uploadDiag, diag, camFixes, sharedFixes, sharedSpots, applyCamFixes, diagnoseMiss, fixFromMiss, loadSharedFixes, devId, turnZones, turnZoneAt, mySpots, driverSpots, addMySpot, removeMySpot, mySpotStatus, applyUserSpots, renderMySpots, isUserSpot, sameRoad, camLevelOk, highwaySpans, onHighwayAt, pathTangent, camOnExpwy, curv, passCam, tunnelCamTick, routeTunnelAt, camRange, outbox, outboxFlush, reportSure, camLoad, renderCamStatus, camNoMap, camFlag, camFlagAdd, renderCamFlags, secLen, pickCam, camDist, routeTrusted, updateSoundPill, sound: { get unlocked() { return audioUnlocked; }, set unlocked(v) { audioUnlocked = v; } }, camNoUnflag, camUserNo, hdgFix, fixLog, ensureRouteCams,
      tripStore: { save: (l) => store.set('trips', l ? JSON.stringify(l) : null) },
      ownZoom, syncZoomGestures, manualZoom, pickAt, closePick, pickTarget, describeAt, placeNear, catTail, queryVariants, regionOf, nameTier, rankPlaces, looksAddr,
      orderByDist, orderAlerts, afterWord,
    };
  }
})();
