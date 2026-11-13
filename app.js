/* 테슬라 지도 클러스터: 계기판 + 네이버 지도 + 단속카메라 경고 + 길안내 */
(() => {
  'use strict';

  const $ = (s) => document.querySelector(s);
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
    traffic: store.get('traffic') !== '0',
    weather: store.get('weather') !== '0',
    headingUp: store.get('hup') !== '0',
    tilt: store.get('tilt') !== '0',
    routeOpt: store.get('routeOpt') || 'traoptimal', // 기본은 '추천'(네이버 실시간 최적)
    // 테슬라 모드: 속도는 차 화면에 이미 나오므로 왼쪽 계기판을 없애고 지도를 넓게, 시계·날씨 등은 지도 위 글자로.
    // 테슬라 브라우저는 'X11; Linux x86_64' 로만 보이므로 그때 기본으로 켠다 (설정에서 바꾸면 그 값을 따른다)
    tesla: store.get('tesla') ? store.get('tesla') === '1' : /X11; Linux x86_64/.test(navigator.userAgent),
  };
  const proxyUrl = () => (store.get('proxy') || PROXY_DEFAULT).replace(/\/+$/, '');

  // ---------- 운영 모니터링: 접속·오류를 길안내 서버에 짧게 남긴다 (위치는 보내지 않음) ----------
  const APP_VERSION = '2026.11.13-19'; // 배포 때 index.html 의 app.js?v= 와 version.json 도 같이 올린다
  const tele = { sid: Math.random().toString(36).slice(2, 10), sent: 0, seen: new Set(), ctx: null };
  const testPage = /\/test\//.test(location.pathname);
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
      type, sid: tele.sid, v: APP_VERSION, at: Date.now(), page: location.host + location.pathname,
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
  const fmtDist = (m) => (m >= 1000 ? (m / 1000).toFixed(m >= 10000 ? 0 : 1) + 'km' : Math.max(0, Math.round(m / 10) * 10) + 'm');
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
  const ROUTE_BASE = '#2f7dff', ROUTE_EDGE = '#0d2547';
  const TRAFFIC_COLOR = { 1: '#03c75a', 2: '#f5a623', 3: '#e53935' }; // 1 원활, 2 서행, 3 정체 (0 은 정보 없음 = 바탕색)
  function trafficRuns(sections, len) {
    const runs = [];
    (sections || []).filter((s) => s && Number.isFinite(s.i) && Number.isFinite(s.n))
      .sort((x, y) => x.i - y.i)
      .forEach((s) => {
        const color = TRAFFIC_COLOR[s.cong];
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
    split(0, n - 1, 'edge', ROUTE_EDGE);
    split(0, n - 1, 'base', ROUTE_BASE);
    trafficRuns(sections, n).forEach((r) => split(r.a, r.b, 'traffic', r.color));
    return out;
  }
  // 조각마다: 차(점 번호 s, 위치 cur)보다 뒤면 숨기고, 차가 걸친 조각은 cur 부터, 앞이면 원래대로
  // ops: { hide(pc), show(pc), setPath(pc, pathArray), point(cur) }
  function trimPieces(pieces, path, s, cur, ops) {
    let c = null;
    pieces.forEach((pc) => {
      if (pc.b <= s) { if (pc.st !== 'hidden') { ops.hide(pc); pc.st = 'hidden'; } return; }
      if (pc.a <= s) {
        if (!c) c = ops.point(cur);
        ops.setPath(pc, [c].concat(path.slice(s + 1, pc.b + 1)));
        if (pc.st === 'hidden') ops.show(pc);
        pc.st = 'part';
        return;
      }
      if (pc.st !== 'full') {
        ops.setPath(pc, path.slice(pc.a, pc.b + 1));
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
  const meEl = document.createElement('div');
  meEl.className = 'me nohead';
  // 내 차: 위에서 내려다본 동글동글한 초록 자동차 (헤드라이트 눈, 볼터치, 웃는 입). 앞쪽이 위를 향한다.
  meEl.innerHTML = '<div class="me-halo"></div><div class="me-dot"></div>' +
    '<svg class="me-arrow" viewBox="0 0 40 56">' +
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
      '<path d="M16.8 16.2 Q20 19 23.2 16.2" fill="none" stroke="#0b4a2b" stroke-width="1.7" stroke-linecap="round"/>' +
    '</svg>';
  const rotateMe = makeRotator(meEl.querySelector('.me-arrow'));
  const rotateCompass = makeRotator($('#compassArrow'));
  function camEl(c) {
    const el = document.createElement('div');
    el.className = 'cammk k' + c[3] + (c[6] ? ' z' + c[6] : ''); // z2 어린이·z1 노인 보호구역은 노란 바탕
    el.textContent = c[2];
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
      this.map = new N.Map(el, {
        center: new N.LatLng(c.lat, c.lng), zoom: 17, minZoom: 7,
        zoomControl: false, mapTypeControl: false, scaleControl: false,
      });
      this.marker = new N.Marker({
        position: new N.LatLng(c.lat, c.lng), map: this.map, visible: false, clickable: false, zIndex: 1000,
        icon: { content: meEl, anchor: new N.Point(28, 28) },
      });
      N.Event.addListener(this.map, 'dragstart', onUserPan);
      this.setTraffic(prefs.traffic);
    },
    // 네이버 실시간 교통 레이어: 도로를 막힘 정도에 따라 색칠 (5분마다 갱신)
    setTraffic(on) {
      if (!this.map || !naver.maps.TrafficLayer) return;
      if (!this.traffic) this.traffic = new naver.maps.TrafficLayer({ interval: 300000 });
      this.traffic.setMap(on ? this.map : null);
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
      const path = pts.map((p) => new N.LatLng(p.lat, p.lng));
      const STYLE = { edge: [13, 48], base: [9, 50], traffic: [9, 51] };
      this.routePath = path;
      this.route = routePieces(path.length, sections).map((pc) => {
        pc.line = new N.Polyline({
          map: this.map, path: path.slice(pc.a, pc.b + 1), strokeColor: pc.color, strokeWeight: STYLE[pc.kind][0],
          strokeOpacity: 1, strokeLineCap: 'round', strokeLineJoin: 'round', zIndex: STYLE[pc.kind][1], clickable: false,
        });
        pc.st = 'full';
        return pc;
      });
    },
    // 지나온 경로 지우기: 점 번호 s 와 그 사이 위치 cur 부터 앞만 남긴다
    trimRoute(s, cur) {
      if (!this.route || !this.routePath) return;
      const N = naver.maps, map = this.map;
      trimPieces(this.route, this.routePath, s, cur, {
        hide: (pc) => pc.line.setMap(null), show: (pc) => pc.line.setMap(map),
        setPath: (pc, p) => pc.line.setPath(p), point: (q) => new N.LatLng(q.lat, q.lng),
      });
    },
    clearRoute() {
      if (this.route) this.route.forEach((pc) => pc.line.setMap(null));
      this.route = null; this.routePath = null;
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
    destroy() {
      if (this.cams) this.cams.forEach((m) => m.setMap(null));
      this.cams = new Map();
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
    resize() {
      const c = this.map.getCenter();
      this.map.invalidateSize({ pan: false });
      this.map.setView(c, this.map.getZoom(), { animate: false });
    },
    drawRoute(pts, sections) {
      this.clearRoute();
      const path = pts.map((p) => [p.lat, p.lng]);
      const WEIGHT = { edge: 13, base: 9, traffic: 9 };
      this.routePath = path;
      // Leaflet 은 나중에 더한 선이 위에 그려지므로 테두리 → 본선 → 교통색 순서(routePieces 순서)를 지킨다
      this.route = routePieces(path.length, sections).map((pc) => {
        pc.line = L.polyline(path.slice(pc.a, pc.b + 1), {
          color: pc.color, weight: WEIGHT[pc.kind], opacity: 1, lineCap: 'round', lineJoin: 'round', interactive: false,
        }).addTo(this.map);
        pc.st = 'full';
        return pc;
      });
    },
    trimRoute(s, cur) {
      if (!this.route || !this.routePath) return;
      const map = this.map;
      trimPieces(this.route, this.routePath, s, cur, {
        hide: (pc) => pc.line.remove(),
        show: (pc) => { // 다시 보일 때 겹침 순서를 되돌린다 (차가 잠깐 뒤로 잡힌 경우)
          pc.line.addTo(map);
          if (pc.kind === 'edge') pc.line.bringToBack(); else if (pc.kind === 'traffic') pc.line.bringToFront();
        },
        setPath: (pc, p) => pc.line.setLatLngs(p), point: (q) => [q.lat, q.lng],
      });
    },
    clearRoute() {
      if (this.route) this.route.forEach((pc) => pc.line.remove());
      this.route = null; this.routePath = null;
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
    destroy() {
      this.clearRoute();
      if (this.map) this.map.remove();
      this.map = null; this.marker = null; this.cams = new Map();
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
    }
    camState.markerAt = null;
    if (state.fix) refreshCamMarkers(state.fix);
    layoutView(true);
  }

  // ---------- 주행 화면 (진행 방향이 위, 차는 화면 아래쪽, 3D 기울기) ----------
  // 네이버 래스터 지도는 회전이 안 되므로 지도 캔버스를 차 위치(회전 중심)를 가운데로 하는
  // 큰 정사각형으로 키우고 CSS transform 으로 돌리고 기울인다. 크기는 어느 각도에서도 화면을 덮도록 계산.
  const VIEW_TILT = 22, VIEW_PERSP = 1400, VIEW_PIVOT = 0.7, VIEW_MARGIN = 32;
  const view = { drive: false, key: '', rot: 0, w: 0, h: 0, cs: 0, cx: 0, cy: 0, tilt: 0 };

  function wantDrive() {
    return !!(state.following && prefs.headingUp && state.heading !== null && !nav.preview);
  }
  function measureView() {
    const host = $('#map');
    view.w = host.clientWidth; view.h = host.clientHeight;
  }
  function setViewRot() {
    view.rot += turn(-state.heading - view.rot); // 누적 각도: 350°→10° 에서 한 바퀴 돌지 않게
    const s = $('#map').style, r = Math.round(view.rot * 100) / 100;
    s.setProperty('--rot', r + 'deg');
    s.setProperty('--crot', -r + 'deg'); // 카메라 마커 숫자는 똑바로
  }
  // 반환값: 차 위치로 지도를 바로 옮겼으면 true
  function layoutView(force) {
    const host = $('#map'), canvas = host.querySelector('.mapcanvas');
    if (force || !view.w) measureView();
    const w = view.w, h = view.h, drive = wantDrive();
    let cs = 0, cy = h / 2, tilt = 0;
    if (drive) {
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
    const key = drive ? [w, h, cs, cy, tilt].join() : w + 'x' + h;
    const wasDrive = view.drive;
    if (!force && drive === wasDrive && key === view.key) {
      if (drive) setViewRot();
      return false;
    }
    // 주행 화면 안에서 크기만 바뀌면 애니메이션 없이 (들어올 때는 돌아가며 기울어지게 둔다)
    const snap = drive && wasDrive;
    if (snap) host.classList.add('snap');
    Object.assign(view, { drive, key, cs, cx: w / 2, cy, tilt });
    if (drive) {
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
    let jumped = false;
    if (mapA && mapA.resize && w && h) {
      // 지도 라이브러리가 캔버스에 직접 넣은 크기는 지우고 CSS 크기를 따르게 한다
      const clear = () => { if (canvas) { canvas.style.width = ''; canvas.style.height = ''; } };
      clear();
      try { mapA.resize(drive ? cs : w, drive ? cs : h); } catch (e) { /* 다음 배치 때 다시 */ }
      clear();
      if (state.fix && (drive || wasDrive || state.following)) {
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
    attrib.textContent = mapA === NaverAdapter ? '© NAVER Corp.' : (mapA ? '© OpenStreetMap contributors' : '');
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

  async function bootMap() {
    // 설정에 직접 넣은 키가 우선. 없으면 길안내 서버에서 받는다 (저장 안 함: 서버에서 바꾸면 바로 반영)
    let key = store.get('key');
    if (!key) key = await fetchMapKey();
    if (!key) { await fallbackMap(null); return; }
    try {
      await loadScript('https://oapi.map.naver.com/openapi/v3/maps.js?ncpKeyId=' + encodeURIComponent(key));
      if (!(window.naver && naver.maps && naver.maps.Map)) throw new Error('naver.maps missing');
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
      cams.rows = j.rows; cams.grid = g; cams.date = j.date; cams.roads = j.roads || []; cams.loaded = true;
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
  // 카메라 행: [lat, lng, limit, kind, sec, len, zone, road, rtype]
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
    if (nav.active && nav.pts) return camOnRouteAhead(c);
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
  // 도로명이 같다고 확인되면 카메라 좌표 오차를 감안해 30m 까지 인정한다.
  function camAtSeg(c, i) {
    const p = { lat: c[0], lng: c[1] }, a = nav.pts[i], b = nav.pts[i + 1];
    const pr = projectSeg(p, a, b);
    if (pr.dist >= 30) return null;
    const rn = routeRoadAt(i), cn = camRoad(c);
    if (pr.dist > 6 && roadsDiffer(rn, cn)) return null;
    // 경로 왼쪽으로 8m 넘게 떨어진 한 방향 카메라는 반대편 차로용
    if (oneDir(c) && pr.dist > OPP_SIDE && sideOfSeg(p, a, b, pr.dist) < 0) return null;
    // 고속도로 구간이면 옆 일반도로의 저속 카메라(제한 70 이하, 고속국도 아님)는 제외
    // ('분당수서고속화도로' 같은 고속화도로는 고속도로가 아니므로 이 규칙을 쓰지 않는다)
    if (/고속도로|고속국도/.test(rn) && c[8] !== 1 && c[2] <= 70) return null;
    if (!(pr.dist < 20 || (specificRoad(rn) && sameRoad(rn, cn)))) return null;
    return nav.cum[i] + pr.t * (nav.cum[i + 1] - nav.cum[i]);
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
        tg.after = true; // 카메라 좌표 오차·후면 단속을 감안해 지나간 뒤 CAM_HOLD m 까지 경고를 유지한다
      }
      if (tg.after) {
        if (d >= CAM_HOLD) camState.target = tg = null;
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
      if ((s.len && done > s.len + 400) || now - s.t0 > 45 * 60000) endSection();
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
    if (!camState.section) return;
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
      nxEl.innerHTML = '<span class="mini-sign">' + pk.c[2] + '</span>다음 단속 <b>' + fmtDist(d) + '</b>';
    }
    if (!tg || !prefs.cams) {
      card.hidden = true;
    } else {
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
    }
    renderSection();
    renderLimit();
  }
  function renderSection() {
    const s = camState.section, card = $('#secCard');
    if (!s) { card.hidden = true; return; }
    card.hidden = false;
    const now = state.fix ? state.fix.t : Date.now();
    const dt = (now - s.t0) / 1000, done = state.odo - s.d0;
    const avg = dt >= 8 ? done / dt * 3.6 : null;
    $('#secLimit').textContent = s.limit;
    $('#secAvg').textContent = avg === null ? '-' : Math.round(avg);
    $('#secRemain').textContent = s.len ? '남은 거리 ' + fmtDist(Math.max(0, s.len - done)) : fmtDist(done) + ' 주행';
    card.classList.toggle('over', avg !== null && avg > s.limit);
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
    if (camState.markerAt && haversine(camState.markerAt, f) < 250) return;
    camState.markerAt = { lat: f.lat, lng: f.lng };
    if (nav.active && nav.pts) {
      // 길안내 중에는 경로 위 카메라만 지도에 (조금 전 지나온 것부터 앞쪽 5km 까지)
      ensureRouteCams();
      mapA.setCameras((nav.routeCamList || []).filter((x) => x.at > nav.along - 100 && x.at < nav.along + 5000 && camWanted(x.c))
        .map((x) => ({ i: x.i, c: x.c, d: x.at - nav.along })).slice(0, 80));
      return;
    }
    mapA.setCameras(camsNear(f.lat, f.lng, 2000).filter((x) => camWanted(x.c)).sort((a, b) => a.d - b.d).slice(0, 80));
  }

  // ---------- 길안내 ----------
  const nav = {
    active: false, preview: false, dest: null, route: null, pts: null, cum: null, total: 0,
    seg: 0, along: 0, remain: null, next: null, dg: null, gi: 0, guides: [], said: {},
    off: 0, lastReroute: 0, busy: false, lastTraffic: 0,
    onRoute: false, onCount: 0, gap: 12000, gen: 0, byDemo: false,
    routeCams: null, routeCamList: [], // 경로 위 카메라 (경로가 바뀌면 다시 계산)
  };

  function recents() { try { return JSON.parse(store.get('recent') || '[]'); } catch (e) { return []; } }
  function addRecent(p) {
    const list = recents().filter((x) => !(x.name === p.name && Math.abs(x.lat - p.lat) < 1e-5));
    list.unshift({ name: p.name, addr: p.addr || '', category: p.category || '', lat: p.lat, lng: p.lng });
    store.set('recent', JSON.stringify(list.slice(0, 8)));
  }

  function openSearch() {
    $('#searchSheet').hidden = false;
    renderResults(recents(), '최근 목적지', '최근 목적지가 없습니다. 장소 이름이나 주소를 검색하세요.');
    setTimeout(() => $('#q').focus(), 50);
  }
  function closeSearch() { $('#searchSheet').hidden = true; }
  function renderResults(items, title, emptyNote) {
    const box = $('#results');
    if (!items.length) { box.innerHTML = '<div class="empty">' + esc(emptyNote || '결과가 없습니다.') + '</div>'; return; }
    box.innerHTML = (title ? '<div class="rtitle">' + esc(title) + '</div>' : '') + items.map((it, k) => {
      const dist = state.fix ? fmtDist(haversine(state.fix, it)) : '';
      const sub = [it.category, it.addr].filter(Boolean).join(' · ');
      return '<button class="result" data-k="' + k + '"><div><div class="nm">' + esc(it.name) + '</div>' +
        (sub ? '<div class="sub">' + esc(sub) + '</div>' : '') + '</div><div class="dist">' + dist + '</div></button>';
    }).join('');
    box.querySelectorAll('.result').forEach((b) => { b.onclick = () => pickDest(items[+b.dataset.k]); });
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
      renderResults(recents(), '최근 목적지', '최근 목적지가 없습니다. 장소 이름이나 주소를 검색하세요.');
      return;
    }
    qTimer = setTimeout(() => doSearch(true), 450);
  }
  function pickDest(it) {
    closeSearch();
    addRecent(it);
    planRoute(it, false);
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
      const q = {
        start: state.fix.lng.toFixed(6) + ',' + state.fix.lat.toFixed(6),
        goal: dest.lng.toFixed(6) + ',' + dest.lat.toFixed(6),
      };
      if (reroute === 'traffic') q.option = nav.option || prefs.routeOpt;
      else if (reroute) q.option = rerouteOption();
      else q.options = ALT_OPTIONS;
      // 차량 LTE 가 느릴 수 있어 20초까지 기다리고, 시간 초과면 한 번 더 시도한다
      let res;
      try { res = await api('/route', q, null, 20000); } catch (e1) {
        if (e1.name !== 'AbortError' && !/abort/i.test(e1.message)) throw e1;
        if (gen !== nav.gen) return;
        res = await api('/route', q, null, 20000);
      }
      if (gen !== nav.gen || (reroute && !nav.active)) return;
      // 응답에 경로가 비어 있으면 지금 안내를 그대로 두고 실패로 처리한다
      const okRoute = (x) => x && Array.isArray(x.path) && x.path.length >= 2;
      if (!(okRoute(res) || (res && Array.isArray(res.alternatives) && res.alternatives.some(okRoute)))) {
        const err = new Error('empty route');
        err.detail = { message: '경로 응답이 비어 있습니다', keys: Object.keys(res || {}).join(',') };
        throw err;
      }
      if (res.alternatives) res.alternatives = res.alternatives.filter(okRoute);
      let r = res;
      if (!reroute) {
        nav.alts = dedupAlts(res.alternatives || [res]);
        const pref = nav.alts.findIndex((a) => a.options.indexOf(prefs.routeOpt) >= 0);
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
        say('새 경로로 안내합니다.', 1);
        toast('새 경로로 안내합니다 · ' + (ALT_LABEL[q.option] || '추천') + ' · ' + fmtDist(r.distance || nav.total) + ' · ' + fmtMin(r.duration), '', 4000);
        navUpdate(state.fix);
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
    nav.setAt = state.fix ? state.fix.t : Date.now(); nav.drawnSeg = 0; nav.drawnAlong = 0; nav.drawnAt = 0;
    nav.routeCams = null; nav.routeCamList = []; camState.markerAt = null; // 경로 위 카메라·지도 표시를 새 경로로
    nav.lastTraffic = state.fix ? state.fix.t : Date.now();
    if (!keepAlerts) { nav.said = {}; nav.gap = 10000; }
    nav.remain = nav.total; nav.next = null; nav.dg = null;
    nav.guides = (r.guide || []).filter((g) => g.i < nav.pts.length).sort((a, b) => a.i - b.i);
    if (mapA) mapA.drawRoute(nav.pts, r.sections);
    if (!keepAlerts) camState.target = null; // 재탐색 때는 진행 중인 카메라 안내를 유지
  }

  // ---------- 추천 경로 여러 개 ----------
  const ALT_OPTIONS = 'traoptimal:trafast:traavoidtoll'; // 추천을 맨 앞에 (같은 길이면 '추천 · 빠른 길'로 합쳐 보인다)
  // 경로를 벗어나 다시 찾을 때는 같은 목적지를 '추천'(실시간 최적) 경로로. 무료 도로를 골랐으면 그 조건은 지킨다
  const rerouteOption = () => (nav.option === 'traavoidtoll' ? 'traavoidtoll' : 'traoptimal');
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
    const others = (nav.preview || !nav.active) && nav.alts ? nav.alts.filter((_, k) => k !== nav.altIdx) : [];
    mapA.drawAlts(others.map((a) => a.path.map((p) => ({ lat: p[1], lng: p[0] }))));
  }
  function selectAlt(k) {
    if (!nav.alts || !nav.alts[k] || k === nav.altIdx) return;
    nav.altIdx = k;
    setRoute(nav.alts[k], nav.dest);
    drawAltLines();
    showRouteCard();
  }
  function showRouteCard() {
    const r = nav.route;
    $('#rcTitle').textContent = nav.dest.name;
    const alts = nav.alts && nav.alts.length ? nav.alts : [Object.assign({ label: ALT_LABEL[r.option] || '경로' }, r)];
    const fastest = Math.min(...alts.map((a) => a.duration));
    $('#rcAlts').innerHTML = alts.map((a, k) => {
      const diff = a.duration - fastest;
      return '<button class="alt' + (k === (nav.altIdx || 0) ? ' on' : '') + '" data-k="' + k + '">' +
        '<span class="alt-label">' + esc(a.label) + '</span>' +
        '<b>' + fmtMin(a.duration) + '</b>' +
        '<span class="alt-sub">' + fmtDist(a.distance) + ' · ' + (a.tollFare ? a.tollFare.toLocaleString('ko-KR') + '원' : '무료') +
        (diff >= 60000 ? ' · +' + Math.round(diff / 60000) + '분' : '') + '</span></button>';
    }).join('');
    $('#rcAlts').querySelectorAll('.alt').forEach((b) => { b.onclick = () => selectAlt(+b.dataset.k); });
    $('#rcMeta').textContent = hhmm(new Date(Date.now() + r.duration)) + ' 도착 예정' + (alts.length > 1 ? ' · 다른 경로는 지도에 회색으로 표시' : '');
    $('#routeCard').hidden = false;
  }
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
    nav.alts = null; nav.altIdx = 0;
    if (mapA) { mapA.clearRoute(); if (mapA.drawAlts) mapA.drawAlts([]); }
    $('#routeCard').hidden = true;
    $('#map').classList.remove('navigating');
    camState.target = null;
    renderNav();
    setFollowing(true);
  }

  function turnKind(g) {
    const s = g.s || '', t = g.t;
    if (/유턴|U턴/i.test(s) || t === 6) return 'u';
    if (/목적지|도착/.test(s) || t === 88) return 'goal';
    if (/경유지/.test(s) || t === 87) return 'goal';
    // 회전교차로 'N시 방향': 7~11시는 왼쪽, 1~5시는 오른쪽, 6시는 유턴, 12시는 직진
    const clock = s.match(/(\d{1,2})시\s*방향/);
    if (clock) {
      const h = +clock[1];
      if (h >= 7 && h <= 11) return 'l';
      if (h >= 1 && h <= 5) return 'r';
      if (h === 6) return 'u';
      return 's';
    }
    if (/좌회전|왼쪽/.test(s) || [2, 4, 8, 11, 12, 13].indexOf(t) >= 0) return 'l';
    if (/우회전|오른쪽/.test(s) || [3, 5, 14, 15, 16].indexOf(t) >= 0) return 'r';
    return 's';
  }
  const TURN_ICONS = {
    s: '<svg viewBox="0 0 48 48"><path d="M24 43V7M12 19 24 7l12 12"/></svg>',
    l: '<svg viewBox="0 0 48 48"><path d="M32 43V25a9 9 0 0 0-9-9H9M17 8l-8 8 8 8"/></svg>',
    r: '<svg viewBox="0 0 48 48"><path d="M16 43V25a9 9 0 0 1 9-9h14M31 8l8 8-8 8"/></svg>',
    u: '<svg viewBox="0 0 48 48"><path d="M34 43V18a9 9 0 0 0-18 0v20M9 31l7 8 7-8"/></svg>',
    goal: '<svg viewBox="0 0 48 48"><path d="M13 44V5M13 7h23l-6 8 6 8H13"/></svg>',
  };

  // 남은 경로만 다시 그린다: 지금 위치(경로 위로 붙인 점)부터 목적지까지, 교통 색 구간도 번호를 맞춰 옮긴다
  function drawRemaining() {
    if (!mapA || !nav.pts || !nav.route) return;
    // 다음 GPS 까지 차가 조금 더 나아가므로 0.4초 앞에서 자른다 (자른 끝은 차 아이콘에 가려진다)
    const at = Math.min(nav.total, nav.along + Math.max(0, state.speedKmh / 3.6) * 0.4);
    let s = Math.max(0, Math.min(nav.seg, nav.pts.length - 2));
    while (s < nav.pts.length - 2 && nav.cum[s + 1] <= at) s++;
    const cur = routePointAt(at) || nav.pts[s];
    // 지도에 그려 둔 경로 조각 중 차가 걸친 조각만 고쳐 그린다 (setRoute 에서 nav.pts 전체를 그려 둠)
    if (mapA.trimRoute) mapA.trimRoute(s, cur);
    nav.drawnSeg = nav.seg;
    nav.drawnAlong = nav.along;
    nav.drawnAt = state.fix ? state.fix.t : Date.now();
  }

  function navUpdate(f) {
    if (!nav.active || !nav.pts || !f) return;
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
    nav.onRoute = best.dist <= offLimit;
    if (nav.onRoute) {
      nav.seg = best.seg;
      nav.along = nav.cum[best.seg] + best.t * (nav.cum[best.seg + 1] - nav.cum[best.seg]);
      nav.off = 0;
      if (++nav.onCount >= 5) nav.gap = 10000; // 경로 위를 잘 따라가면 재탐색 간격 초기화
    } else if ((f.acc || 0) < 60 && state.speedKmh > 3 &&
               (nav.onCount > 0 || f.t - (nav.setAt || 0) > 20000)) {
      // 출발점이 도로에서 떨어진 곳(주차장 등)이면 경로에 한 번 올라탄 뒤부터 센다.
      // 다만 20초가 지나도 경로에 못 올라탔다면(엉뚱한 경로) 그때부터는 센다
      nav.off++;
    }
    // 확실히 다른 길(80m 넘게 벗어남)이면 2번, 아니면 3번 연속 확인되면 다시 찾는다
    const need = best.dist > 80 ? 2 : 3;
    if (nav.off >= need && f.t - nav.lastReroute > nav.gap && !nav.busy) {
      nav.lastReroute = f.t;
      nav.off = 0; nav.onCount = 0;
      nav.gap = Math.min(nav.gap * 2, 40000); // 계속 벗어나면 간격을 늘리되 40초를 넘기지 않는다
      say('경로를 벗어났습니다. 다시 탐색합니다.', 1, true);
      toast('경로를 벗어나 같은 목적지로 다시 찾는 중… (추천 경로)', '', 4000);
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

  function announceTurn(g, dg) {
    const said = nav.said[g.i] || (nav.said[g.i] = {});
    const fast = state.speedKmh > 60;
    if (fast && dg <= 1100 && dg > 700 && !said.k1) {
      said.k1 = true;
      say('1킬로미터 앞, ' + g.s, 1);
    } else if (dg <= 320 && dg > (fast ? 160 : 90) && !said.m300) {
      said.m300 = true;
      say(spokenDist(Math.round(dg / 100) * 100 || 100) + ' 앞, ' + g.s, 1);
    } else if (dg <= (fast ? 160 : 90) && !said.now) {
      said.now = true; said.m300 = true;
      say(g.s, 1, true);
    }
  }

  // 지도 왼쪽 세로 막대: 맨 아래 출발, 맨 위 도착으로 고정. 내 차 점이 올라가고, 지나온 만큼 막대가 줄어든다.
  // 색은 지도 경로선과 같다: 교통 정보 없음 파랑, 원활 초록, 서행 주황, 정체 빨강.
  // 재탐색해도 출발점은 그대로 (전체 = 지금까지 달린 거리 + 남은 거리).
  const CONG_COLOR = TRAFFIC_COLOR;
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
      const color = CONG_COLOR[s.cong];
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
    const p = $('#navPanel');
    renderStrip();
    if (!nav.active) { p.hidden = true; $('#searchBtn').hidden = false; return; }
    p.hidden = false;
    $('#searchBtn').hidden = true;
    const g = nav.next;
    $('#turnIcon').innerHTML = TURN_ICONS[g ? turnKind(g) : 'goal'];
    $('#turnDist').textContent = fmtDist(nav.dg != null ? nav.dg : nav.total);
    $('#turnText').textContent = g ? g.s : nav.dest.name;
    // 그다음 안내 지점이 1.5km 안이면 작게 미리 보여 준다 (거리는 현재 위치 기준)
    const g2 = g ? nav.guides[nav.gi + 1] : null;
    const d2 = g2 ? nav.cum[g2.i] - nav.along : Infinity;
    const nn = $('#nextTurn');
    nn.hidden = !(d2 <= 1500);
    if (!nn.hidden) {
      $('#nextIcon').innerHTML = TURN_ICONS[turnKind(g2)];
      $('#nextDist').textContent = fmtDist(d2);
    }
    const remain = nav.remain != null ? nav.remain : nav.total;
    const remMs = nav.route.duration * (remain / Math.max(1, nav.total));
    $('#navRemain').textContent = fmtDist(remain);
    $('#navTime').textContent = fmtMin(remMs);
    $('#navEta').textContent = '도착 ' + hhmm(new Date(Date.now() + remMs));
  }

  // 주행 중에는 가까이 보는 것이 기본. 빠를수록 한 단계씩 넓게, 회전 지점 앞에서는 다시 가깝게
  const zoomCtl = { last: 0, manualUntil: 0, stillSince: 0 };
  const speedZoom = (v) => (v < 5 ? 17 : v < 60 ? 18 : v <= 100 ? 17 : 16);
  function autoZoom(f) {
    const v = state.speedKmh;
    if (v >= 5) zoomCtl.stillSince = 0;
    else if (!zoomCtl.stillSince) zoomCtl.stillSince = f.t;
    if (!state.following || !mapA || nav.preview || f.t < zoomCtl.manualUntil) return;
    if (f.t - zoomCtl.last < 4000) return;
    const cur = mapA.getZoom();
    let z;
    if (nav.active && nav.dg != null && nav.dg < 300) z = 18;
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
  const weather = { at: null, t: 0, busy: false };
  const WMO = [[0, '맑음'], [2, '구름 조금'], [3, '흐림'], [48, '안개'], [57, '이슬비'], [67, '비'], [77, '눈'], [82, '소나기'], [86, '눈 소나기'], [99, '뇌우']];
  const wmoText = (code) => { for (const [max, t] of WMO) if (code <= max) return t; return ''; };
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
      const el = $('#weather');
      el.innerHTML = '<b>' + Math.round(temp) + '°</b> ' + esc(wmoText(code)) +
        (pp != null ? ' · <span class="' + (pp >= 50 ? 'rain' : '') + '">1시간 내 비 ' + pp + '%</span>' : '');
      el.hidden = !prefs.weather;
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
      $('#roadName').innerHTML = esc(j.road || '') + (j.area ? '<small>' + esc(j.area) + '</small>' : '');
    } catch (e) {
      road.fails++;
    } finally {
      road.busy = false;
    }
  }

  // ---------- 위치 처리 ----------
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

    const acc = Math.round(f.acc || 0);
    setGps(acc <= 25 ? 'ok' : 'warn', 'GPS ±' + acc + 'm');
    render();
    navUpdate(f);        // 경로 위 위치를 먼저 계산해야 내 차를 도로에 붙일 수 있다
    motionFix(f, !prev); // 지도·내 차는 매 프레임 부드럽게 따라간다
    evalCameras(f);
    refreshCamMarkers(f);
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
    navigator.geolocation.watchPosition((p) => {
      diagRaw(p);
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
        report('warn', { msg: 'gps permission denied' });
        setGps('bad', '위치 권한 꺼짐');
        toast('위치 권한을 허용해야 속도와 현재 위치가 표시됩니다.', 'bad', 0);
      } else {
        setGps('warn', err.code === 3 ? 'GPS 신호 약함' : 'GPS 오류');
      }
    }, { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 });
  }

  // ---------- 화면 갱신 ----------
  function render() {
    $('#speed').textContent = Math.round(state.speedKmh);
    if (state.heading !== null) {
      $('#headingText').textContent = dirName(state.heading) + ' · ' + Math.round(state.heading) + '°';
      rotateCompass(state.heading);
      rotateMe(state.heading);
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
  const upd = { checking: false, hiddenAt: 0, lastTick: 0 };
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
      // 브라우저에 저장된 예전 페이지를 새로 받아 둔 뒤 새로고침한다
      try { await fetch(location.pathname + location.search, { cache: 'reload' }); } catch (e) { /* 새로고침이 다시 받는다 */ }
      location.reload();
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
    if (nav.active) renderNav();
    if (camState.section) renderSection();
  }

  // ---------- 따라가기 ----------
  function setFollowing(on, noAutoReturn) {
    state.following = on;
    $('#locate').classList.toggle('alert', !on);
    clearTimeout(state.refollowTimer);
    const jumped = layoutView(); // 주행 화면 ↔ 평면 지도 전환
    if (on && state.fix && mapA && !jumped) { const p = mePos(); mapA.center(p.lat, p.lng, false); }
    if (!on && !noAutoReturn) state.refollowTimer = setTimeout(() => setFollowing(true), 15000); // 15초 손 안 대면 복귀
  }
  function onUserPan() { setFollowing(false, nav.preview); }
  // 지도 손 조작: 톡 치기는 화면 버튼만 보여 주고, 실제로 끌거나(10px 이상) 두 손가락을 쓰면
  // 주행 화면을 평면(북쪽 위) 지도로 바꿔 조작을 이어간다
  const gesture = { x: 0, y: 0, used: false, pointers: new Set() };
  const NOT_MAP = '.btn, .searchbtn, .navpanel, .routecard, .toast, #diagBox, .ctrls, .topctrls, .badge, .soundpill';
  function userMapGesture() {
    gesture.used = true;
    // 손으로 바꾼 배율은 30초 동안 자동 줌이 덮어쓰지 않게 한다
    zoomCtl.manualUntil = (state.fix ? state.fix.t : Date.now()) + 30000;
    if (view.drive) setFollowing(false);
  }
  function onMapDown(e) {
    if (e.target.closest && e.target.closest(NOT_MAP)) return;
    gesture.pointers.add(e.pointerId);
    if (gesture.pointers.size === 1) { gesture.x = e.clientX; gesture.y = e.clientY; gesture.used = false; }
    else if (!gesture.used) userMapGesture(); // 두 손가락 = 확대/축소
  }
  function onMapMove(e) {
    if (gesture.used || !gesture.pointers.has(e.pointerId)) return;
    if (Math.hypot(e.clientX - gesture.x, e.clientY - gesture.y) > 10) userMapGesture();
  }
  function onMapUp(e) { gesture.pointers.delete(e.pointerId); }

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
  $('#map').addEventListener('wheel', (e) => { if (!(e.target.closest && e.target.closest(NOT_MAP))) userMapGesture(); }, { capture: true, passive: true });
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

  // ---------- 버튼 ----------
  $('#zin').onclick = () => manualZoom(1);
  $('#zout').onclick = () => manualZoom(-1);
  $('#locate').onclick = () => setFollowing(true);
  $('#searchBtn').onclick = openSearch;
  $('#searchClose').onclick = closeSearch;
  $('#searchSheet').addEventListener('click', (e) => { if (e.target === $('#searchSheet')) closeSearch(); });
  $('#qBtn').onclick = doSearch;
  $('#q').addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) { clearTimeout(qTimer); doSearch(); } });
  $('#q').addEventListener('input', onQueryInput);
  $('#rcStart').onclick = startNav;
  $('#rcCancel').onclick = endNav;
  $('#navEnd').onclick = () => { endNav(); say('안내를 종료합니다.', 1); };

  function applyTesla() {
    $('#app').classList.toggle('tesla', prefs.tesla);
    queueLayout(); // 지도 칸 너비가 바뀌므로 다시 배치
  }
  function applyNight() {
    $('#map').classList.toggle('night', state.night);
    $('#nightBtn').innerHTML = state.night ? ICON_SUN : ICON_MOON;
    $('#nightBtn').setAttribute('aria-label', state.night ? '주간 지도' : '야간 지도');
  }
  $('#nightBtn').onclick = () => {
    state.night = !state.night;
    store.set('night', state.night ? '1' : null);
    applyNight();
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
    $('#optTraffic').checked = prefs.traffic;
    $('#optWeather').checked = prefs.weather;
    $('#optHup').checked = prefs.headingUp;
    $('#optTesla').checked = prefs.tesla;
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
  sheet.addEventListener('click', (e) => { if (e.target === sheet) sheet.hidden = true; });
  $('#saveKey').onclick = () => { store.set('key', $('#keyInput').value.trim() || null); location.reload(); };
  $('#clearKey').onclick = () => { store.set('key', null); location.reload(); };
  $('#optVoice').onchange = (e) => { prefs.voice = e.target.checked; store.set('voice', prefs.voice ? null : '0'); updateSoundPill(); };
  $('#optBeep').onchange = (e) => { prefs.beep = e.target.checked; store.set('beep', prefs.beep ? null : '0'); updateSoundPill(); };
  $('#optTesla').onchange = (e) => {
    prefs.tesla = e.target.checked; store.set('tesla', prefs.tesla ? '1' : '0');
    applyTesla();
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
  setTimeout(() => report('session', { msg: 'open', debug: params.has('debug') }), 6000); // 지도·GPS 상태가 잡힌 뒤 접속 기록
  render();
  tickClock();
  setInterval(tickClock, 1000);
  bootMap();
  loadCameras();
  startGps();
  if (store.get('diag') === '1' || params.has('diag')) setDiag(true);
  if (params.has('demo')) startDemo();
  checkForUpdate('open');
  document.addEventListener('visibilitychange', () => {
    // 화면이 오래(5분 넘게) 가려졌다가 다시 보이면 새 버전을 확인한다 (길안내 중·주행 중이면 하지 않음)
    if (document.visibilityState === 'hidden') upd.hiddenAt = Date.now();
    else if (upd.hiddenAt && Date.now() - upd.hiddenAt > 5 * 60000) checkForUpdate('visible');
  });
  // ?debug 일 때만 내부 상태를 콘솔에서 볼 수 있게 연다 (테스트용)
  if (params.has('debug')) {
    window.__tnc = {
      state, camState, nav, cams, prefs, onFix, setRoute, startNav, endNav, startDemo, stopDemo, renderNav,
      planRoute, doSearch, setFollowing, evalCameras, navUpdate, loadCameras, getMap: () => mapA,
      view, layoutView, zoomCtl, autoZoom, motion, alertLog, checkForUpdate, version: APP_VERSION,
    };
  }
})();
