/* 지도 클러스터 시나리오 테스트 하네스 (브라우저 안에서 실행)
 *
 * Run: serve the repo root (e.g. `python -m http.server 8765`) and open
 *   http://localhost:8765/test/harness.html?debug
 * (?debug is added automatically if missing; app.js only exposes window.__tnc with it.)
 *
 * What it does
 *  1. Copies index.html's <style>/<link rel=stylesheet> into this page's head and its <body> markup
 *     (minus scripts) into this body, then adds a fixed results panel on top.
 *  2. Before the app loads: localStorage tnc.voice='0', tnc.beep='0', removes tnc.key / tnc.recent / tnc.cams
 *     (Leaflet/OSM fallback map, silent, camera alerts on). The previous values are restored when the run ends.
 *     navigator.geolocation is replaced by a silent stub so real GPS never mixes with synthetic fixes.
 *  3. window.fetch stub: same-origin requests under /test/ (e.g. the app's relative 'data/cameras.json')
 *     are redirected to the repo root; Worker endpoints (/route /geocode /search /reverse /health /log /config)
 *     on the proxy origin are answered with canned JSON in the Worker's shapes and recorded in
 *     __harness.stub.calls. Everything else goes to the real fetch.
 *  4. Loads ../app.js (classic script), waits for __tnc and __tnc.cams.loaded (20 s), then runs S1..S9.
 *     Each scenario resets the app, feeds synthetic fixes through __tnc.onFix with a synthetic clock
 *     (1000 ms steps unless noted), and asserts on the debug API + stable DOM ids only.
 *
 * Output: results table in the panel, window.__testResults = [{name, status, detail}], window.__testsDone = true.
 * Re-run one scenario from the console: await __harness.run('S5')
 */
(() => {
  'use strict';

  // ---------------------------------------------------------------- config
  const PROXY_DEFAULT = 'https://tesla-nav.cy6789.workers.dev';
  const ENDPOINTS = ['/route', '/geocode', '/search', '/reverse', '/health', '/log', '/config', '/hipass', '/check', '/check/status', '/fixes'];   // v202: 실시간 신고 확인
  const BOOT_TIMEOUT_MS = 20000;
  const LS_KEYS = ['tnc.voice', 'tnc.beep', 'tnc.key', 'tnc.recent', 'tnc.cams'];

  // 2026-11-14: 테슬라 모드가 유일한 화면이 되어 설정의 전환 스위치(#optTesla)가 없어졌다. 예전 시나리오의 켜기·끄기는 아무 일도 하지 않는다
  const TESLA_ONLY = { checked: true, dispatchEvent() { return true; } };

  const RESULTS = [];
  window.__testResults = RESULTS;
  window.__testsDone = false;

  // app.js reads location.search once at load; make sure ?debug is there before it runs
  if (!new URLSearchParams(location.search).has('debug')) {
    history.replaceState(null, '', location.pathname + (location.search ? location.search + '&debug' : '?debug') + location.hash);
  }

  const pageErrors = [];
  window.addEventListener('error', (e) => {
    pageErrors.push((e.message || 'error') + (e.filename ? ' @ ' + e.filename.split('/').pop() + ':' + e.lineno : ''));
  });
  window.addEventListener('unhandledrejection', (e) => {
    pageErrors.push('unhandled rejection: ' + (e.reason && e.reason.message ? e.reason.message : String(e.reason)));
  });

  // ---------------------------------------------------------------- small helpers
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function waitFor(fn, ms, step) {
    const t0 = performance.now();
    for (;;) {
      let v = null;
      try { v = fn(); } catch (e) { v = null; }
      if (v) return v;
      if (performance.now() - t0 >= ms) return null;
      await sleep(step || 50);
    }
  }
  function withTimeout(p, ms, what) {
    let to = 0;
    const timer = new Promise((_, rej) => { to = setTimeout(() => rej(new Error(what + ' timed out after ' + ms + ' ms')), ms); });
    return Promise.race([Promise.resolve(p), timer]).finally(() => clearTimeout(to));
  }
  const $ = (s) => document.querySelector(s);
  const text = (s) => { const el = $(s); return el ? String(el.textContent || '').trim() : ''; };
  const num = (s) => parseFloat(text(s));
  const hasCls = (s, c) => { const el = $(s); return !!el && el.classList.contains(c); };
  function visible(s) {
    const el = $(s);
    if (!el || el.hidden) return false;
    return getComputedStyle(el).display !== 'none';
  }
  // app fmtDist(): "850m", "1.2km", "12km"
  function distM(str) {
    const m = /(-?[\d.]+)\s*(km|m)\b/.exec(str || '');
    return m ? parseFloat(m[1]) * (m[2] === 'km' ? 1000 : 1) : NaN;
  }
  const round6 = (n) => Math.round(n * 1e6) / 1e6;
  const r0 = (n) => Math.round(n);

  // ---------------------------------------------------------------- geo (same sphere as app.js haversine)
  const R_EARTH = 6371000;
  const rad = (d) => d * Math.PI / 180, deg = (r) => r * 180 / Math.PI;
  function hav(a, b) {
    const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(s)));
  }
  function brg(a, b) {
    const y = Math.sin(rad(b.lng - a.lng)) * Math.cos(rad(b.lat));
    const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lng - a.lng));
    return (deg(Math.atan2(y, x)) + 360) % 360;
  }
  // point at distance d (m) from p along initial bearing b (deg), great circle
  function dest(p, b, d) {
    const dr = d / R_EARTH, br = rad(b), la = rad(p.lat), lo = rad(p.lng);
    const la2 = Math.asin(Math.sin(la) * Math.cos(dr) + Math.cos(la) * Math.sin(dr) * Math.cos(br));
    const lo2 = lo + Math.atan2(Math.sin(br) * Math.sin(dr) * Math.cos(la), Math.cos(dr) - Math.sin(la) * Math.sin(la2));
    return { lat: deg(la2), lng: deg(lo2) };
  }
  const sameCam = (c, ref) => !!c && Math.abs(c[0] - ref.lat) < 1e-6 && Math.abs(c[1] - ref.lng) < 1e-6;

  // ---------------------------------------------------------------- localStorage (restored at the end)
  const lsSnapshot = {};
  let lsTaken = false;
  function prepStorage() {
    try {
      LS_KEYS.forEach((k) => { lsSnapshot[k] = localStorage.getItem(k); });
      lsTaken = true;
      localStorage.setItem('tnc.voice', '0');
      localStorage.setItem('tnc.beep', '0');
      localStorage.removeItem('tnc.key');
      localStorage.removeItem('tnc.recent');
      localStorage.removeItem('tnc.cams');
    } catch (e) { /* storage blocked: app falls back to defaults (voice/beep on, but no audio unlock happens) */ }
  }
  function restoreStorage() {
    if (!lsTaken) return;
    lsTaken = false;
    Object.keys(lsSnapshot).forEach((k) => {
      try {
        const v = lsSnapshot[k];
        if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, v);
      } catch (e) { /* ignore */ }
    });
  }
  window.addEventListener('pagehide', restoreStorage);

  // ---------------------------------------------------------------- geolocation stub
  function stubGeolocation() {
    const fake = {
      watchPosition() { return 1; },
      clearWatch() {},
      getCurrentPosition() {},
    };
    try { Object.defineProperty(navigator, 'geolocation', { configurable: true, get: () => fake }); } catch (e) { /* ignore */ }
    if (navigator.geolocation !== fake && navigator.geolocation) {
      try { navigator.geolocation.watchPosition = fake.watchPosition; } catch (e) { /* ignore */ }
    }
  }

  // ---------------------------------------------------------------- fetch stub (fake Cloudflare Worker)
  const realFetch = window.fetch.bind(window);
  const harnessDir = new URL('./', location.href).href;   // .../test/
  const rootDir = new URL('../', location.href).href;     // repo root
  function proxyBase() {
    let p = null;
    try { p = localStorage.getItem('tnc.proxy'); } catch (e) { p = null; }
    return (p || PROXY_DEFAULT).replace(/\/+$/, '');
  }
  function defaultCanned() {
    return {
      '/route': { __status: 404, body: { error: 'no route', code: 1, message: 'harness: no canned /route for this scenario' } },
      '/geocode': { items: [] },
      '/search': { items: [] },
      '/reverse': { road: '하네스로', area: '테스트시 테스트구 테스트동' },
      '/health': { ok: true, ncp: true, search: true, logs: false },
      '/log': (q, rec) => (rec.method === 'POST' ? { id: 'harness001' } : { __status: 404, body: { error: 'not found' } }),
      '/config': { mapKeyId: '' },   // empty key -> app keeps the Leaflet/OSM fallback map
      '/hipass': { __status: 501, body: { error: 'hipass key not configured' } },   // 실제 Worker 처럼 인증키 없음
    };
  }
  const stub = {
    calls: [],
    canned: defaultCanned(),
    reset() { this.canned = defaultCanned(); },
    since(i, path) { return this.calls.slice(i).filter((c) => !path || c.path === path); },
    count(path, i) { return this.since(i || 0, path).length; },
  };
  function jsonResponse(body, status) {
    return new Response(JSON.stringify(body == null ? {} : body), {
      status: status || 200,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });
  }
  function endpointOf(u) {
    const base = proxyBase();
    if (u.href.startsWith(base + '/')) {
      const rest = u.href.slice(base.length).split(/[?#]/)[0];
      if (ENDPOINTS.indexOf(rest) >= 0) return rest;
    }
    if (u.origin !== location.origin && ENDPOINTS.indexOf(u.pathname) >= 0) return u.pathname;
    return null;
  }
  function installFetchStub() {
    window.fetch = function harnessFetch(input, init) {
      const raw = typeof input === 'string' ? input : (input && input.url) || String(input);
      let u;
      try { u = new URL(raw, location.href); } catch (e) { return realFetch(input, init); }
      const ep = endpointOf(u);
      if (ep) {
        const method = String((init && init.method) || (typeof input !== 'string' && input && input.method) || 'GET').toUpperCase();
        const query = {};
        u.searchParams.forEach((v, k) => { query[k] = v; });
        let body = init && init.body;
        if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { /* keep text */ } }
        const rec = { path: ep, method, url: u.href, query, body, at: performance.now() };
        stub.calls.push(rec);
        let v = stub.canned[ep];
        try { if (typeof v === 'function') v = v(query, rec); } catch (e) { v = { __status: 500, body: { error: 'proxy', message: 'harness canned fn: ' + e.message } }; }
        if (v && v.__status) return Promise.resolve(jsonResponse(v.body, v.__status));
        return Promise.resolve(jsonResponse(v, 200));
      }
      // the app fetches files relative to the page ('data/cameras.json' -> /test/data/...): serve them from the repo root
      if (u.href.startsWith(harnessDir) && !/\/harness\.(html|js)$/.test(u.pathname)) {
        return realFetch(rootDir + u.href.slice(harnessDir.length), init);
      }
      return realFetch(input, init);
    };
  }

  // ---------------------------------------------------------------- results panel
  let panel = null, tbody = null, summaryEl = null, infoEl = null;
  function makePanel() {
    const css = document.createElement('style');
    css.textContent = [
      '#harnessPanel{position:fixed;top:8px;right:8px;z-index:2147483000;width:min(780px,calc(100vw - 16px));',
      'max-height:calc(100vh - 16px);overflow:auto;background:rgba(9,11,15,.97);color:#e8ecf1;',
      'border:1px solid #3a4250;border-radius:10px;box-shadow:0 8px 30px rgba(0,0,0,.55);',
      'font:12px/1.45 ui-monospace,Consolas,"Malgun Gothic",monospace;-webkit-user-select:text;user-select:text}',
      '#harnessPanel header{position:sticky;top:0;display:flex;gap:10px;align-items:center;padding:8px 10px;',
      'background:#151a21;border-bottom:1px solid #2b323d}',
      '#harnessPanel header b{font-size:13px}',
      '#harnessPanel header span{flex:1;color:#aab3c0}',
      '#harnessPanel header button{font:inherit;background:#232a34;color:#e8ecf1;border:1px solid #3a4250;border-radius:6px;padding:2px 8px;cursor:pointer}',
      '#harnessPanel.min table,#harnessPanel.min .hinfo{display:none}',
      '#harnessPanel .hinfo{padding:6px 10px;color:#8b93a1;white-space:pre-wrap;word-break:break-word;border-bottom:1px solid #2b323d}',
      '#harnessPanel table{width:100%;border-collapse:collapse}',
      '#harnessPanel td,#harnessPanel th{padding:5px 8px;border-bottom:1px solid #222831;vertical-align:top;text-align:left}',
      '#harnessPanel th{color:#8b93a1;font-weight:600}',
      '#harnessPanel td.d{white-space:pre-wrap;word-break:break-word;color:#c9d1dc}',
      '#harnessPanel td.n{white-space:nowrap}',
      '#harnessPanel .PASS{color:#3ddc84;font-weight:700}',
      '#harnessPanel .FAIL{color:#ff5a5f;font-weight:700}',
      '#harnessPanel .SKIP{color:#ffb020;font-weight:700}',
      '#harnessPanel .RUN{color:#8ab4ff}',
    ].join('');
    document.head.appendChild(css);
    panel = document.createElement('div');
    panel.id = 'harnessPanel';
    panel.innerHTML = '<header><b>Scenario tests</b><span id="harnessSummary">starting…</span>' +
      '<button type="button" id="harnessMin">hide</button></header>' +
      '<div class="hinfo" id="harnessInfo"></div>' +
      '<table><thead><tr><th>scenario</th><th>status</th><th>detail</th></tr></thead><tbody></tbody></table>';
    document.body.appendChild(panel);
    tbody = panel.querySelector('tbody');
    summaryEl = panel.querySelector('#harnessSummary');
    infoEl = panel.querySelector('#harnessInfo');
    panel.querySelector('#harnessMin').onclick = (e) => {
      panel.classList.toggle('min');
      e.target.textContent = panel.classList.contains('min') ? 'show' : 'hide';
    };
  }
  function setSummary(s) { if (summaryEl) summaryEl.textContent = s; }
  function addInfo(s) { if (infoEl) infoEl.textContent += (infoEl.textContent ? '\n' : '') + s; }
  function addResult(name, status, detail) {
    const row = { name, status, detail: String(detail || '') };
    const i = RESULTS.findIndex((r) => r.name === name);
    if (i >= 0) RESULTS[i] = row; else RESULTS.push(row);
    if (tbody) {
      let tr = tbody.querySelector('tr[data-name="' + CSS.escape(name) + '"]');
      if (!tr) { tr = document.createElement('tr'); tr.dataset.name = name; tbody.appendChild(tr); }
      tr.innerHTML = '<td class="n"></td><td class="' + status + '">' + status + '</td><td class="d"></td>';
      tr.children[0].textContent = name;
      tr.children[2].textContent = row.detail;
    }
    // eslint-disable-next-line no-console
    console.log('[harness] ' + status + ' ' + name + ' :: ' + row.detail);
  }
  function showRunning(name) {
    if (!tbody) return;
    let tr = tbody.querySelector('tr[data-name="' + CSS.escape(name) + '"]');
    if (!tr) { tr = document.createElement('tr'); tr.dataset.name = name; tbody.appendChild(tr); }
    tr.innerHTML = '<td class="n"></td><td class="RUN">RUN</td><td class="d"></td>';
    tr.children[0].textContent = name;
  }

  // ---------------------------------------------------------------- load index.html markup + app.js
  function addScript(spec) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      if (spec.type) s.type = spec.type;
      if (spec.src) {
        s.async = false;
        // cache-bust so a concurrently edited app.js is always fresh
        s.src = spec.src + (spec.src.indexOf('?') >= 0 ? '&' : '?') + 'harness=' + Date.now();
        s.onload = () => resolve();
        s.onerror = () => reject(new Error('script load failed: ' + spec.src));
        document.body.appendChild(s);
      } else {
        s.textContent = spec.text || '';
        document.body.appendChild(s);
        resolve();
      }
    });
  }
  async function injectApp() {
    const indexUrl = new URL('../index.html', location.href).href;
    const r = await realFetch(indexUrl, { cache: 'no-store' });
    if (!r.ok) throw new Error('index.html HTTP ' + r.status);
    const doc = new DOMParser().parseFromString(await r.text(), 'text/html');
    if (doc.documentElement.lang) document.documentElement.lang = doc.documentElement.lang;
    // styles (anywhere in the document), in order
    doc.querySelectorAll('style, link[rel~="stylesheet"]').forEach((n) => {
      if (n.tagName === 'STYLE') {
        const s = document.createElement('style');
        s.textContent = n.textContent;
        document.head.appendChild(s);
      } else {
        const l = document.createElement('link');
        l.rel = 'stylesheet';
        l.href = new URL(n.getAttribute('href'), indexUrl).href;
        document.head.appendChild(l);
      }
      n.remove();
    });
    // scripts: removed from the markup, loaded afterwards in document order (src resolved against index.html)
    const scripts = [];
    doc.querySelectorAll('script').forEach((n) => {
      const src = n.getAttribute('src');
      scripts.push({ src: src ? new URL(src, indexUrl).href : null, type: n.getAttribute('type'), text: n.textContent });
      n.remove();
    });
    if (!scripts.some((s) => s.src && /(^|\/)app\.js$/.test(new URL(s.src).pathname))) {
      scripts.push({ src: new URL('../app.js', location.href).href, type: null, text: '' });
    }
    for (const a of Array.from(doc.body.attributes)) document.body.setAttribute(a.name, a.value);
    const anchor = panel || null;
    Array.from(doc.body.childNodes).forEach((n) => document.body.insertBefore(document.importNode(n, true), anchor));
    return scripts;
  }

  // ---------------------------------------------------------------- app driving helpers
  const T = () => window.__tnc;
  let clock = Date.now();   // synthetic GPS clock (ms); only moves forward
  function feed(p, speed, heading, opt) {
    const o = opt || {};
    clock += o.dt != null ? o.dt : 1000;
    const f = { lat: p.lat, lng: p.lng, acc: o.acc != null ? o.acc : 5, speed, heading, t: clock };
    T().onFix(f);
    return f;
  }
  async function resetApp() {
    const t = T();
    await waitFor(() => !t.nav.busy, 3000);   // never reset over an in-flight planRoute
    if (t.state.demoTimer) t.stopDemo(true);
    t.endNav();
    t.camState.target = null;
    t.camState.section = null;
    t.camState.passed.clear();
    t.state.fix = null;
    t.state.heading = null;
    t.state.speedKmh = 0;
    // v172: 앞 시험이 터널 근처에서 끝나 '터널 안 어두운 지도'가 켜진 채면 다음 시험의 낮·밤 판정이 흔들린다
    if (t.tnDark && t.tnDark.on) { t.tnDark.on = false; t.tnDark.outAt = 0; t.applyNight(); }
    stub.reset();
    clock += 10 * 60000;   // big gap: reroute throttle / camera 'passed' expiry from earlier scenarios never carries over
  }

  // ---------------------------------------------------------------- scenarios
  // Camera choices: scanned data/cameras.json (2026-10-22, 31091 rows, coords rounded to 5 decimals) with a node script.
  // S1 section pair. Rows: start [37.17466,127.89025,80,9,1,9956,0], end [37.26181,127.90208,80,9,2,9956,0]
  // (the brief's 37.1746581,127.8902541 rounds to the start row; the data coordinates are used so the line hits the
  // cameras exactly). Straight line start->end is 9747 m at bearing 6.2 deg (not 7.5). Along the drive line, the only
  // other camera ever inside the app's look-ahead cone (28 deg; 55 deg under 150 m) is
  // [37.23227,127.89585,80,1,0,0,0], 195 m west of the line at ~6.4 km into the section; it may briefly become
  // the target mid-section and then drops off, without touching the section. (After the end, a school-zone camera
  // [37.27063,127.90521] 1 km past the end may become a target; also harmless.)
  const S1_START = { lat: 37.17466, lng: 127.89025 };
  const S1_END = { lat: 37.26181, lng: 127.90208 };
  // S2: kind-1 speed camera [37.08727,127.80979,80,1,0,0,0]; no other camera within 3.5 km, so any target is this one.
  const CAM_ISO_A = { lat: 37.08727, lng: 127.80979, limit: 80 };
  // S4: kind-1 speed camera [36.85538,127.26662,50,1,0,0,0]; nearest other camera is 3.47 km away. Limit 50, so the
  // test drives at 70 km/h.
  const CAM_ISO_B = { lat: 36.85538, lng: 127.26662, limit: 50 };
  // S3: school-zone (zone 2) signal+speed camera [34.96209,127.26828,30,2,0,0,2]; no other camera within 3.5 km.
  const CAM_SCHOOL = { lat: 34.96209, lng: 127.26828, limit: 30, eb: 119 };   // #1760 쌍향수길 양방향, 길 축 119°/299° (v237: 양방향도 길 축으로 다가가야 뜬다)
  // S5/S6 route origin and S9 drive origin: no camera within 4 km of either point, so camera logic stays quiet.
  const NAV_ORIGIN = { lat: 37.70, lng: 128.30 };
  const TRIP_ORIGIN = { lat: 37.80, lng: 127.90 };
  const SEOUL = { lat: 37.5658, lng: 126.9772 };   // 서울시청 (app DEFAULT_CENTER), dense camera area

  // S1: section enforcement, from 800 m before the start camera to 600 m past the end camera at 25 m/s (90 km/h)
  async function s1() {
    const t = T();
    const L = hav(S1_START, S1_END);
    const A0 = dest(S1_START, (brg(S1_START, S1_END) + 180) % 360, 800);
    const b0 = brg(A0, S1_END);
    const startS = 800, endS = 800 + L, total = endS + 600;
    let startTarget = null, secStartS = null, secObj = null, restarted = false, nullAt = null, mid = null, fixes = 0;
    for (let s = 0; s <= total + 0.01; s += 25) {
      const p = dest(A0, b0, s);
      feed(p, 25, brg(p, dest(A0, b0, s + 25)));
      fixes++;
      const tg = t.camState.target, sec = t.camState.section;
      if (!startTarget && s < startS && tg && tg.c[4] === 1 && sameCam(tg.c, S1_START)) startTarget = { s, d: r0(tg.d) };
      if (sec && secStartS === null) { secStartS = s; secObj = sec; }
      if (secObj && sec && sec !== secObj) restarted = true;
      if (secStartS !== null && !sec && nullAt === null) nullAt = s;
      if (!mid && sec && s >= startS + 5000) {
        mid = { s: r0(s), vis: visible('#secCard'), avg: num('#secAvg'), over: hasCls('#secCard', 'over'), limit: sec.limit, len: sec.len };
      }
    }
    const endSec = t.camState.section, endCard = visible('#secCard');
    const checks = {
      startTargetBeforeStart: !!startTarget,
      sectionStartsAfterStartCam: secStartS !== null && secStartS > startS && secStartS <= startS + 100,
      sectionLimit80: !!secObj && secObj.limit === 80,
      midCardVisible: !!mid && mid.vis,
      midAvg90pm3: !!mid && Math.abs(mid.avg - 90) <= 3,
      midCardOver: !!mid && mid.over,
      noRestart: !restarted,
      endsAtEndCam: nullAt !== null && nullAt >= endS - 10 && nullAt <= endS + 150,
      nullAfterDrive: endSec === null && !endCard,
    };
    const failed = Object.keys(checks).filter((k) => !checks[k]);
    return {
      pass: failed.length === 0,
      detail: (failed.length ? 'FAILED: ' + failed.join(', ') + ' | ' : '') +
        fixes + ' fixes, heading ' + b0.toFixed(1) + 'deg; start cam targeted at ' + (startTarget ? startTarget.d + ' m before' : 'never') +
        '; section from +' + (secStartS === null ? '-' : r0(secStartS - startS)) + ' m past start (limit ' + (secObj ? secObj.limit : '-') +
        ', len ' + (secObj ? secObj.len : '-') + '); mid@' + (mid ? r0(mid.s - startS) + 'm: card ' + (mid.vis ? 'shown' : 'hidden') +
        ', #secAvg ' + mid.avg + ', over=' + mid.over : 'n/a') + '; section null at ' +
        (nullAt === null ? 'never' : (nullAt - endS >= 0 ? '+' : '') + r0(nullAt - endS) + ' m vs end cam') + (restarted ? '; RESTARTED mid-way' : ''),
    };
  }

  // S2: direction filter. A: from 700 m south heading north (15 m/s) -> target. B: same line, heading south, moving away -> none.
  async function s2() {
    const t = T(), C = CAM_ISO_A;
    let hit = null;
    for (let s = 0; s <= 650; s += 15) {
      feed(dest(C, 180, 700 - s), 15, 0);
      const tg = t.camState.target;
      if (!hit && tg && sameCam(tg.c, C)) hit = { s, d: r0(tg.d), card: visible('#camCard'), type: text('#camType') };
    }
    await resetApp();
    let wrong = null, other = null;
    for (let s = 0; s <= 300; s += 15) {
      feed(dest(C, 180, 700 + s), 15, 180);
      const tg = t.camState.target;
      if (tg && sameCam(tg.c, C)) { if (!wrong) wrong = { s, d: r0(tg.d) }; } else if (tg && !other) other = tg.c;
    }
    const cardB = visible('#camCard');
    const pass = !!hit && hit.card && !wrong;
    return {
      pass,
      detail: 'toward: ' + (hit ? 'target at ' + hit.d + ' m, #camCard ' + (hit.card ? 'visible' : 'HIDDEN') + ' ("' + hit.type + '")' : 'NO TARGET') +
        '; away (heading 180): ' + (wrong ? 'WRONG target at ' + wrong.d + ' m' : 'no target') +
        (other ? ', other target ' + JSON.stringify(other) : '') + ', #camCard ' + (cardB ? 'visible' : 'hidden'),
    };
  }

  // S3: school-zone label
  async function s3() {
    const t = T(), C = CAM_SCHOOL;
    let label = null, at = null, tile = null;
    for (let s = 0; s <= 650 && label === null; s += 10) {
      feed(dest(C, (C.eb + 180) % 360, 700 - s), 10, C.eb);
      const tg = t.camState.target;
      if (tg && sameCam(tg.c, C)) {
        label = text('#camType'); at = r0(tg.d);
        // 테슬라 화면(2026-11-14 부터 유일한 화면): 큰 보호구역 타일 대신 경고 밑에 작은 주의 표지 '어린이 조심'
        tile = {
          shown: hasCls('#camCard', 'zonecam') && visible('#zoneBadge'),
          sign: !!document.querySelector('#zbSign svg'), label: text('#zbLabel'), limit: text('#camLimit'), dist: text('#camDist'),
        };
      }
    }
    const tileOk = !!tile && tile.shown && tile.sign && tile.label === '어린이 조심' && tile.limit === '30' && /m$/.test(tile.dist);
    return {
      pass: label !== null && label.indexOf('어린이보호구역') >= 0 && tileOk,
      detail: label === null ? 'camera never became target' : '#camType="' + label + '" at ' + at + ' m (limit ' + text('#camLimit') + ')' +
        '; sign tile ' + (tileOk ? 'shown✓ "' + tile.label + ' ' + tile.limit + '", ' + tile.dist : 'WRONG ' + JSON.stringify(tile)),
    };
  }

  // S4: over-speed at limit+20 km/h, approaching from 1150 m
  async function s4() {
    const t = T(), C = CAM_ISO_B, L = C.limit, v = (L + 20) / 3.6;
    let n1000 = 0, n600 = 0;
    const bad = [];
    for (let s = 0; s <= 1120; s += v) {
      const p = dest(C, 180, 1150 - s);
      feed(p, v, 0);
      const d = hav(p, C);
      if (d >= 390 || d <= 30) continue;   // 일반도로(제한 50) 카메라는 400m 앞부터 경고
      n1000++;
      const tg = t.camState.target;
      const okTarget = !!tg && sameCam(tg.c, C);
      // 제한 속도는 왼쪽 아래 표지 또는 (테슬라 화면) 단속 카드의 '제한 50' 한 곳에만 (2026-11-14: 둘 다 뜨면 겹친다)
      const inCard = visible('#mySpeed') && text('#mySpeedLim') === '제한 ' + L, onSign = visible('#limitSign') && text('#limitVal') === String(L);
      const okSign = inCard !== onSign;
      const okSpeed = hasCls('#speed', 'over');
      if (!okTarget || !okSign || !okSpeed) {
        if (bad.length < 4) bad.push(r0(d) + 'm:' + (!okTarget ? ' no-target' : '') + (!okSign ? ' sign(' + (visible('#limitSign') ? text('#limitVal') : 'hidden') + '/card ' + (inCard ? 'shown' : 'hidden') + ')' : '') + (!okSpeed ? ' speed-not-over' : ''));
        else bad.push('…');
      }
      if (d < 590) {
        n600++;
        if (!hasCls('#camCard', 'over') && bad.length < 8) bad.push(r0(d) + 'm: camCard-not-over');
      }
    }
    return {
      pass: n1000 >= 10 && n600 >= 5 && bad.length === 0,
      detail: 'limit ' + L + ', driving ' + (L + 20) + ' km/h; ' + n1000 + ' samples <390 m, ' + n600 + ' samples <390 m (card over)' +
        (bad.length ? '; problems: ' + bad.join('; ') : '; limit ' + L + ' shown once, #speed.over, #camCard.over all held'),
    };
  }

  // Canned /route: 10 points 120 m apart, 600 m north from NAV_ORIGIN, then a right turn and 480 m east.
  const RIGHT_TURN = "'율곡로' 방면으로 우회전";
  function buildNavRoute() {
    const raw = [];
    for (let k = 0; k <= 5; k++) raw.push(dest(NAV_ORIGIN, 0, 120 * k));
    for (let k = 1; k <= 4; k++) raw.push(dest(raw[5], 90, 120 * k));
    const path = raw.map((p) => [round6(p.lng), round6(p.lat)]);   // Worker shape: [lng, lat], 6 decimals
    const P = path.map((x) => ({ lat: x[1], lng: x[0] }));
    const cum = [0];
    for (let i = 1; i < P.length; i++) cum.push(cum[i - 1] + hav(P[i - 1], P[i]));
    const total = cum[cum.length - 1];
    const ms = (m) => r0(m / 12 * 1000);   // ~43 km/h
    const route = {
      distance: r0(total), duration: ms(total), tollFare: 0, fuelPrice: 160,
      path,
      guide: [
        { i: 2, t: 1, s: '직진', d: r0(cum[2]), ms: ms(cum[2]) },
        { i: 5, t: 3, s: RIGHT_TURN, d: r0(cum[5] - cum[2]), ms: ms(cum[5] - cum[2]) },
        { i: 9, t: 88, s: '목적지', d: r0(cum[9] - cum[5]), ms: ms(cum[9] - cum[5]) },
      ],
      sections: [
        { i: 0, n: 6, name: '테스트로', speed: 45, cong: 1 },
        { i: 5, n: 5, name: '율곡로', speed: 12, cong: 3 },
      ],
    };
    return { route, P, cum, total, dest: { name: '테스트 목적지', addr: '테스트시 율곡로 1', lat: P[9].lat, lng: P[9].lng } };
  }
  // v250: 네이버식 분기점 그림(jx)을 고른 뒤에도 예전 AI 그림(junc_<종류>) 흐름을 보는 시험은 jx 고름을 잠깐 뺀다 (jx 는 S162·S166)
  function stashJx() {
    const t = T(), keep = {};
    Object.keys(t.iconPicks).filter((k) => /^jx2?_/.test(k)).forEach((k) => { keep[k] = t.iconPicks[k]; delete t.iconPicks[k]; });   // v261: 2판(jx2_)도
    t.juncState.key = '';
    return () => { Object.assign(t.iconPicks, keep); t.juncState.key = ''; };
  }
  // v261: 1판 네이버식 그림(jx_)을 보는 시험은 2판 고름(jx2_)만 잠깐 뺀다 (2판이 있으면 1판보다 먼저 쓰인다)
  function stashJx2() {
    const t = T(), keep = {};
    Object.keys(t.iconPicks).filter((k) => /^jx2_/.test(k)).forEach((k) => { keep[k] = t.iconPicks[k]; delete t.iconPicks[k]; });
    t.juncState.key = '';
    return () => { Object.assign(t.iconPicks, keep); t.juncState.key = ''; };
  }
  function pointAt(R, s) {
    const P = R.P, cum = R.cum;
    s = Math.max(0, Math.min(s, cum[cum.length - 1]));
    let i = 0;
    while (i < P.length - 2 && cum[i + 1] < s) i++;
    const len = cum[i + 1] - cum[i], k = len > 0 ? (s - cum[i]) / len : 0;
    return {
      p: { lat: P[i].lat + (P[i + 1].lat - P[i].lat) * k, lng: P[i].lng + (P[i + 1].lng - P[i].lng) * k },
      h: brg(P[i], P[i + 1]),
    };
  }
  async function planAndStart(R) {
    const t = T();
    stub.canned['/route'] = R.route;
    feed(R.P[0], 0, null);
    await withTimeout(t.planRoute(R.dest, false), 5000, 'planRoute');
    const pre = { card: visible('#routeCard'), title: text('#rcTitle'), meta: text('#rcMeta'), preview: !!t.nav.preview };
    t.startNav();
    return pre;
  }

  // S5: plan -> route card -> start -> turn-by-turn along the canned path at 15 m/s -> arrival
  async function s5() {
    const t = T(), R = buildNavRoute();
    const c0 = stub.calls.length;
    const pre = await planAndStart(R);
    const routeCalls = stub.since(c0, '/route');
    const q = routeCalls[0] ? routeCalls[0].query : {};
    const expStart = R.P[0].lng.toFixed(6) + ',' + R.P[0].lat.toFixed(6);
    const expGoal = R.dest.lng.toFixed(6) + ',' + R.dest.lat.toFixed(6);
    const startPanel = visible('#navPanel'), startText = text('#turnText');
    const log = [];
    let arrivedS = null;
    for (let s = 15; s <= R.total + 0.01; s += 15) {
      const a = pointAt(R, s);
      feed(a.p, 15, a.h);
      if (!t.nav.active) { arrivedS = s; break; }
      log.push({ s, txt: text('#turnText'), m: distM(text('#turnDist')) });
    }
    const g1 = R.cum[2], g2 = R.cum[5];
    const beforeOk = log.filter((e) => e.s <= g1 - 10).every((e) => e.txt === '직진');
    const shownRight = T().guideText ? T().guideText(RIGHT_TURN) : RIGHT_TURN;   // v110: 패널은 줄인 문장
    const firstRight = log.find((e) => e.txt === shownRight);
    const rightPhase = log.filter((e) => e.txt === shownRight);
    let mono = rightPhase.length >= 2 && rightPhase[0].m > rightPhase[rightPhase.length - 1].m;
    for (let i = 1; i < rightPhase.length; i++) if (!(rightPhase[i].m <= rightPhase[i - 1].m)) mono = false;
    const afterCorner = log.filter((e) => e.s >= g2 + 10);
    const goalOk = afterCorner.length > 0 && afterCorner.every((e) => e.txt === '목적지');
    const endPanel = visible('#navPanel');
    const checks = {
      routeRequested: routeCalls.length === 1 && q.start === expStart && q.goal === expGoal,
      routeCardShown: pre.card && pre.title === R.dest.name,
      navPanelShown: startPanel,
      firstGuide: startText === '직진',
      straightBeforeG1: beforeOk,
      switchesToRightTurn: !!firstRight && firstRight.s > g1 - 10 && firstRight.s <= g1 + 20,
      turnDistDecreases: mono,
      goalAfterCorner: goalOk,
      arrived: arrivedS !== null && !t.nav.active && !endPanel,
    };
    const failed = Object.keys(checks).filter((k) => !checks[k]);
    return {
      pass: failed.length === 0,
      detail: (failed.length ? 'FAILED: ' + failed.join(', ') + ' | ' : '') +
        'path ' + r0(R.total) + ' m; /route start=' + q.start + ' goal=' + q.goal + '; card "' + pre.title + '" (' + pre.meta + ')' +
        '; first turnText "' + startText + '"; right-turn shown from ' + (firstRight ? firstRight.s + ' m' : 'never') + ' (guide at ' + r0(g1) + ' m passed)' +
        '; #turnDist ' + (rightPhase.length ? rightPhase[0].m + '→' + rightPhase[rightPhase.length - 1].m + ' m over ' + rightPhase.length + ' fixes' : 'n/a') +
        '; arrived at ' + (arrivedS === null ? 'never' : arrivedS + ' m') + ', #navPanel ' + (endPanel ? 'VISIBLE' : 'hidden'),
    };
  }

  // S6: off-route -> reroute (/route called again)
  async function s6() {
    const t = T(), R = buildNavRoute();
    const c0 = stub.calls.length;
    await planAndStart(R);
    for (const s of [15, 30, 45]) { const a = pointAt(R, s); feed(a.p, 10, a.h); }
    const before = stub.count('/route', c0);
    let firedAfter = null, offFix = null;
    for (let k = 0; k < 4; k++) {
      const on = pointAt(R, 60 + 50 * k).p;
      const f = feed(dest(on, 90, 100), 10, 0, { dt: 5000, acc: 5 });   // 100 m east of the northbound leg
      if (firedAfter === null && stub.count('/route', c0) >= 2) { firedAfter = k + 1; offFix = f; }
    }
    const t0 = performance.now();
    const got = await waitFor(() => stub.count('/route', c0) >= 2, 2000, 20);
    const waited = r0(performance.now() - t0);
    await waitFor(() => !t.nav.busy, 2000, 20);   // let the reroute finish before the next reset
    const calls = stub.since(c0, '/route');
    const rq = calls[1] ? calls[1].query : null;
    // 출발점은 벗어난 자리에서 진행 방향(북쪽 0°)으로 조금 앞 (답이 오는 동안 갈 거리, 5–60m)
    let ahead = null;
    if (rq && offFix) {
      const [lng, lat] = rq.start.split(',').map(Number), sp = { lat, lng };
      ahead = { d: r0(hav(offFix, sp)), b: r0(brg(offFix, sp)) };
    }
    const startOk = !!ahead && ahead.d >= 5 && ahead.d <= 60 && (ahead.b <= 10 || ahead.b >= 350);
    return {
      pass: before === 1 && !!got && startOk && t.nav.active,
      detail: '/route calls: ' + before + ' before going off-route, ' + calls.length + ' after' +
        (firedAfter ? ' (reroute fired on off-route fix #' + firedAfter + ', seen after ' + waited + ' ms)' : ' (no reroute)') +
        (rq ? '; reroute start=' + rq.start + (ahead ? ' (' + ahead.d + ' m ahead of the off-route fix at ' + ahead.b + '°)' : '') + (startOk ? '' : ' (MISMATCH)') : '') +
        '; nav.active=' + t.nav.active,
    };
  }

  // S7: /search + /geocode merge, dedupe (name + 4-decimal coords) and sort by distance from the fix
  async function s7() {
    const t = T();
    const search = [
      { name: '테스트카페 시청점', category: '카페,디저트', addr: '서울특별시 중구 세종대로 110', lng: 126.9779, lat: 37.5663 },
      { name: '테스트공원', category: '여행,명소>공원', addr: '서울특별시 중구 을지로 100', lng: 126.9900, lat: 37.5700 },
    ];
    const geo = [
      // same name and same coords to 4 decimals as search[0] -> must be dropped
      { name: '테스트카페 시청점', addr: '서울특별시 중구 태평로1가 31', lng: 126.97791, lat: 37.56631, dist: 83 },
      { name: '서울특별시 중구 세종대로 1', addr: '서울특별시 중구 남대문로4가 1', lng: 126.9750, lat: 37.5600, dist: 672 },
    ];
    stub.canned['/search'] = { items: search };
    stub.canned['/geocode'] = { items: geo };
    feed(SEOUL, 0, null);
    $('#q').value = '테스트';
    const c0 = stub.calls.length;
    await withTimeout(t.doSearch(), 5000, 'doSearch');
    const btns = Array.from(document.querySelectorAll('#results .result'));
    const names = btns.map((b) => ((b.querySelector('.nm') || b).textContent || '').trim());
    // v148: 장소(가까운 순, 둘 다 이름 앞이 '테스트') 다음에 주소. 장소와 같은 이름·자리의 주소 결과는 뺀다
    const expected = search.slice().sort((a, b) => hav(SEOUL, a) - hav(SEOUL, b)).map((it) => it.name).concat([geo[1].name]);
    const sq = stub.since(c0, '/search'), gq = stub.since(c0, '/geocode');
    // v148: 장소 검색은 그대로 + 지금 있는 구·동을 붙인 것 (S90), 주소 검색은 한 번
    const callsOk = sq.length >= 1 && sq.some((c) => c.query.query === '테스트') && sq.every((c) => / ?테스트$/.test(c.query.query)) &&
      gq.length === 1 && gq[0].query.near === SEOUL.lng.toFixed(6) + ',' + SEOUL.lat.toFixed(6);
    const orderOk = names.length === 3 && names.join('|') === expected.join('|');
    return {
      pass: orderOk && callsOk,
      detail: btns.length + ' .result buttons: ' + JSON.stringify(names) + (orderOk ? '' : ' expected ' + JSON.stringify(expected)) +
        '; /search x' + sq.length + ', /geocode x' + gq.length + (gq[0] ? ' near=' + gq[0].query.near : '') + (callsOk ? '' : ' (CALLS WRONG)'),
    };
  }

  // S8: camera markers on the map around Seoul City Hall
  async function s8() {
    const t = T();
    if (t.camState && 'markerAt' in t.camState) t.camState.markerAt = null;
    feed(SEOUL, 0, null);
    const map = await waitFor(() => t.getMap(), 10000, 100);
    if (!map) {
      const src = text('#source');
      return { status: /못했/.test(src) ? 'SKIP' : 'FAIL', detail: 'getMap() still null after 10 s; #source="' + src + '"' };
    }
    if (!('cams' in map)) return { status: 'SKIP', detail: 'getMap() has no cams property; #source="' + text('#source') + '"' };
    if ('markerAt' in t.camState) t.camState.markerAt = null;   // force refreshCamMarkers to redraw
    feed(SEOUL, 0, null);
    const size = map.cams && typeof map.cams.size === 'number' ? map.cams.size : -1;
    return {
      pass: size > 0,
      detail: 'getMap().cams.size=' + size + ' (max 80 nearest within 2 km); map source "' + text('#source') + '"',
    };
  }

  // S9: trip odometer: 1 km at 20 m/s
  async function s9() {
    const t = T();
    feed(TRIP_ORIGIN, 20, 90);
    const km0 = num('#tripKm'), m0 = t.state.trip;
    for (let s = 20; s <= 1000 + 0.01; s += 20) feed(dest(TRIP_ORIGIN, 90, s), 20, 90);
    const km1 = num('#tripKm'), m1 = t.state.trip;
    const dKm = km1 - km0, dM = m1 - m0;
    return {
      pass: Math.abs(dKm - 1.0) <= 0.1001 && Math.abs(dM - 1000) <= 5,
      detail: '#tripKm ' + km0 + ' → ' + km1 + ' (Δ ' + dKm.toFixed(2) + ' km); state.trip Δ ' + dM.toFixed(1) + ' m',
    };
  }

  // ---- S10+ : 2026-11-13 주행 피드백 (지나온 경로 지우기 / 엉뚱한 경로 재탐색 / 후면 단속 70m / 신호 전용 / 옆 도로)
  // 지도 위 경로선(두 번째 선 = 본선)의 점 목록
  // 경로는 300점 조각들로 그려진다: 보이는 본선(base) 조각을 순서대로 이어 붙인다 (이웃 조각은 끝점을 공유)
  function routeLine() {
    const m = T().getMap();
    if (!m || !m.route) return null;
    const out = [];
    m.route.filter((pc) => pc.kind === 'base' && pc.st !== 'hidden').sort((x, y) => x.a - y.a).forEach((pc, k) => {
      let a = pc.line.getPath ? pc.line.getPath() : pc.line.getLatLngs();
      if (a && a.getArray) a = a.getArray();
      const arr = Array.from(a || []).map((q) => ({
        lat: typeof q.lat === 'function' ? q.lat() : q.lat, lng: typeof q.lng === 'function' ? q.lng() : q.lng,
      }));
      out.push(...(k ? arr.slice(1) : arr));
    });
    return out.length ? out : null;
  }
  function lineLen(P) { let s = 0; for (let i = 1; i < P.length; i++) s += hav(P[i - 1], P[i]); return s; }
  function softReset() {
    const t = T();
    t.endNav();
    t.camState.target = null; t.camState.section = null; t.camState.passed.clear();
    clock += 10 * 60000;
  }

  // S10: 지나온 경로는 지도에서 지워지고, 남은 경로선의 시작점이 차 바로 앞에 있다
  async function s10() {
    const t = T(), R = buildNavRoute();
    await planAndStart(R);
    const full = routeLine();
    const bad = [];
    let last = null, samples = 0;
    for (let s = 15; s <= 450; s += 15) {
      const a = pointAt(R, s);
      feed(a.p, 15, a.h);
      if (s < 60) continue;
      const P = routeLine();
      if (!P || P.length < 2) { bad.push(s + 'm: no line'); continue; }
      samples++;
      const head = hav(P[0], a.p), remain = lineLen(P), want = R.total - s;
      if (head > 15) bad.push(s + 'm: head ' + r0(head) + 'm from car');
      if (Math.abs(remain - want) > 20) bad.push(s + 'm: remain ' + r0(remain) + ' vs ' + r0(want));
      last = { s, head: r0(head), remain: r0(remain), pts: P.length };
    }
    const m = t.getMap();
    const trafficKept = !!(m && m.route && m.route.some((pc) => pc.kind === 'traffic' && pc.st !== 'hidden'));   // 율곡로 정체 구간 색은 남아 있어야 한다
    // 경로 막대: 출발(아래)·도착(위) 고정, 내 차 점과 색 막대 아래 끝이 지나온 비율(450/1080 ≈ 42%)만큼 올라가 있어야 한다
    t.renderNav();
    const meB = parseFloat(document.getElementById('rsMe').style.bottom);
    const barB = parseFloat(document.getElementById('rsBar').style.bottom);
    const wantP = 450 / R.total * 100;
    const stripOk = Math.abs(meB - wantP) < 5 && Math.abs(barB - meB) < 0.01;
    return {
      pass: samples >= 20 && bad.length === 0 && trafficKept && !!full && last && last.pts < full.length && stripOk,
      detail: (bad.length ? 'problems: ' + bad.slice(0, 5).join('; ') + ' | ' : '') +
        'full line ' + (full ? full.length + ' pts/' + r0(lineLen(full)) + ' m' : 'none') +
        '; at ' + (last ? last.s + ' m: head ' + last.head + ' m from car, remaining ' + last.remain + ' m, ' + last.pts + ' pts' : 'n/a') +
        '; traffic overlay ' + (trafficKept ? 'kept' : 'LOST') + '; ' + samples + ' samples' +
        '; strip car at ' + (meB || 0).toFixed(1) + '% (want ≈' + wantP.toFixed(1) + '%), bar starts ' + (barB || 0).toFixed(1) + '%' + (stripOk ? '' : ' ✗'),
    };
  }

  // S11: 출발부터 경로에 한 번도 올라타지 못한 채(엉뚱한 경로) 계속 벗어나 있으면 20초 뒤 재탐색한다
  async function s11() {
    const t = T(), R = buildNavRoute();
    const off = dest(R.P[0], 90, 100);   // 경로 시작점에서 동쪽 100m
    stub.canned['/route'] = R.route;
    const c0 = stub.calls.length;
    feed(off, 0, null);
    await withTimeout(t.planRoute(R.dest, false), 5000, 'planRoute');
    t.startNav();
    let firedAt = null;
    for (let k = 1; k <= 8 && firedAt === null; k++) {
      feed(dest(off, 0, 60 * k), 10, 0, { dt: 6000 });   // 북쪽으로 나란히 (경로에서 100m 옆)
      if (stub.count('/route', c0) >= 2) firedAt = k * 6;
    }
    await waitFor(() => !t.nav.busy, 2000, 20);
    return {
      pass: firedAt !== null && firedAt >= 20 && firedAt <= 42 && t.nav.active,
      detail: firedAt === null ? 'NO reroute in 48 s while 100 m off a route never joined' :
        'reroute after ' + firedAt + ' s off-route (never joined; expects 20–42 s); /route calls ' + stub.count('/route', c0),
    };
  }

  // S12: 카메라 70m 앞은 '단속 지점', 지나간 뒤 70m 까지 '후면 단속 주의'로 유지, 그 뒤 사라짐
  async function s12() {
    const t = T(), C = CAM_ISO_A;
    // 2026-11-13 두 번째 피드백: 70m → 30m, 오차 거리(+Xm·'후면' 문구)는 보여 주지 않고 30m 지나면 사라진다
    const seen = { near: null, after: [], cleared: null };
    const mark = t.alertLog[t.alertLog.length - 1];
    for (let s = 0; s <= 800; s += 5) {
      const p = dest(C, 180, 700 - s);   // 700m 남쪽 -> 100m 북쪽, 72 km/h
      feed(p, 20, 0, { dt: 250 });
      const tg = t.camState.target, past = s - 700;
      const mine = tg && sameCam(tg.c, C);
      if (past < 0 && past >= -25 && mine && seen.near === null) seen.near = { past, type: text('#camType'), dist: text('#camDist') };
      if (past >= 15 && past <= 25) {
        seen.after.push({ past, ok: !!mine && visible('#camCard') && text('#camDist') === '통과' && !/후면|단속 지점|\+/.test(text('#camType') + text('#camDist')) });
      }
      if (past >= 35 && seen.cleared === null) seen.cleared = { past, gone: !mine && !visible('#camCard') };
    }
    const nearOk = !!seen.near && !/단속 지점/.test(seen.near.type);
    const afterOk = seen.after.length >= 2 && seen.after.every((x) => x.ok);
    const clearOk = !!seen.cleared && seen.cleared.gone;
    // 단속이 끝나면 '띠링' 한 번만
    const from = mark ? t.alertLog.indexOf(mark) + 1 : 0;
    const chimes = t.alertLog.slice(from).filter((e) => /단속 통과 띠링/.test(e.text)).length;
    return {
      pass: nearOk && afterOk && clearOk && chimes === 1,
      detail: 'before: ' + (seen.near ? seen.near.past + ' m "' + seen.near.type + ' ' + seen.near.dist + '"' : 'NO TARGET within 25 m') +
        '; after +15..+25 m (card kept, "0m", no margin text): ' + seen.after.map((x) => '+' + x.past + (x.ok ? '✓' : '✗')).join(' ') +
        '; at +' + (seen.cleared ? seen.cleared.past + ' m ' + (seen.cleared.gone ? 'cleared' : 'STILL SHOWN') : '?') +
        '; 띠링 x' + chimes + (chimes === 1 ? '✓' : '✗'),
    };
  }

  // S13: 원본 '신호' 카메라 — 제한속도가 있으면 신호·과속으로 기본 알림(교차로 다기능 카메라. 2026-11-14 청평 경춘로 주행 제보),
  //      제한속도가 없는 진짜 신호 전용만 기본 꺼짐이고 설정을 켜면 '신호'로 알림
  // 제주 일주동로 [33.37693,126.87362,50] — 원본 '신호', 5.2km 안에 다른 카메라 없음
  const CAM_SIGNAL = { lat: 33.37693, lng: 126.87362 };
  // 이천 경충대로 [37.25055,127.48265,0,2] — 제한속도 없는 신호 전용. 남남서(200°)에서 다가가면 앞쪽 다른 카메라는 750m 넘게 떨어져 있다
  const CAM_SIGONLY = { lat: 37.25055, lng: 127.48265 };
  // v123: 카메라 기준 좌표 — 카메라가 찍는 진행 방향(eb, 모르면 dflt)과 그 차로 위 점(tools/osm_cams.py).
  //       pt(d, side): 카메라 d m 앞(음수면 지난 뒤), 진행 방향 오른쪽 side m (음수면 왼쪽)
  function camFrame(C, dflt) {
    const c = T().cams.rows.find((x) => sameCam(x, C));
    const h = c && c.eb >= 0 && !c.e2 ? c.eb : (dflt || 0);
    const p0 = c && c.sl != null ? { lat: c.sl, lng: c.sg } : C;
    return { h, p0, pt: (d, side) => { let q = dest(p0, (h + 180) % 360, d); if (side) q = dest(q, (h + 90) % 360, side); return q; } };
  }
  async function s13() {
    const t = T(), prev = t.prefs.signalCams;
    const drive = (C, from) => {
      softReset();
      let hit = null;
      const F = camFrame(C, from === 700 ? 0 : 20);
      for (let s = 0; s <= from - 100; s += 14) {
        feed(F.pt(from - s), 14, F.h);
        const tg = t.camState.target;
        if (tg && sameCam(tg.c, C) && !hit) hit = { d: r0(tg.d), sign: text('#camLimit'), type: text('#camType'), signal: hasCls('#camCard', 'signal'), sig: hasCls('#camCard', 'sigspeed') };
      }
      return hit;
    };
    let withLimit, off, on;
    try {
      t.prefs.signalCams = false;
      withLimit = drive(CAM_SIGNAL, 700);
      off = drive(CAM_SIGONLY, 380);
      t.prefs.signalCams = true;
      on = drive(CAM_SIGONLY, 380);
    } finally {
      t.prefs.signalCams = prev;
      softReset();
    }
    const okLimit = !!withLimit && withLimit.sign === '50' && withLimit.type === '신호·과속단속' && withLimit.sig;
    return {
      pass: okLimit && !off && !!on && on.sign === '신호' && on.signal,
      detail: 'signal camera with limit 50 (default): ' + (withLimit ? JSON.stringify(withLimit) : 'NO ALERT') + (okLimit ? '✓' : '✗') +
        '; no-limit signal-only, setting off: ' + (off ? 'WRONG alert at ' + off.d + ' m' : 'no alert✓') +
        '; setting on: ' + (on ? 'alert at ' + on.d + ' m, sign "' + on.sign + '", .signal=' + on.signal : 'NO ALERT'),
    };
  }

  // S14: 옆 도로 카메라 걸러내기
  //  (a) 길안내 없이: 진행 방향 직선에서 45m 옆(나란한 도로)의 카메라는 잡지 않는다 (CAM_ISO_A)
  //  (b) 길안내 중: 위례성로 카메라(CAM_ISO_B)를 경로 옆 12/25/40m 에 두고 경로 도로명을 바꿔 가며 확인
  function buildRouteBeside(C, east, name) {   // east > 0: 카메라가 경로 왼쪽 east m (v123: 카메라가 찍는 방향으로 놓인 경로)
    const raw = [];
    const F = camFrame(C, 0);
    for (let k = 0; k <= 16; k++) raw.push(F.pt(1000 - 100 * k, east));
    const path = raw.map((p) => [round6(p.lng), round6(p.lat)]);
    const P = path.map((x) => ({ lat: x[1], lng: x[0] }));
    const cum = [0];
    for (let i = 1; i < P.length; i++) cum.push(cum[i - 1] + hav(P[i - 1], P[i]));
    const total = cum[cum.length - 1];
    const route = {
      distance: r0(total), duration: r0(total / 14 * 1000), tollFare: 0, fuelPrice: 200, path,
      guide: [{ i: 16, t: 88, s: '목적지', d: r0(total), ms: r0(total / 14 * 1000) }],
      sections: [{ i: 0, n: 17, name, speed: 50, cong: 1 }],
    };
    return { route, P, cum, total, dest: { name: '옆도로 테스트', addr: name, lat: P[16].lat, lng: P[16].lng } };
  }
  async function s14() {
    const t = T();
    // (a) 길안내 없이 북쪽으로 달린다. east = 내 차 선이 카메라에서 동쪽으로 떨어진 거리 (+ 면 카메라가 내 왼쪽)
    //     CAM_ISO_A 는 한 방향(하행) 카메라
    // v123: side = 내 선이 카메라에서 진행 방향 오른쪽으로 떨어진 거리, opp = 반대 방향으로 달림
    const FA = camFrame(C_A(), 0);
    const noNav = (side, opp) => {
      softReset();
      let hit = null;
      for (let s = 0; s <= 1150; s += 20) {
        if (opp) feed(FA.pt(-(1150 - s), side), 20, (FA.h + 180) % 360);
        else feed(FA.pt(1150 - s, side), 20, FA.h);
        const tg = t.camState.target;
        if (tg && sameCam(tg.c, CAM_ISO_A) && hit === null) hit = r0(tg.d);
      }
      return hit;
    };
    const parallelHit = noNav(45);         // 45m 옆 나란한 도로
    const oppHit = noNav(-14, true);       // 반대 방향 차로 (카메라가 내 왼쪽 14m)
    const mineHit = noNav(-6);             // 카메라가 내 오른쪽 6m = 내 차로 길가
    // (b) 길안내 중: 위례성로 카메라(CAM_ISO_B, 한 방향)를 경로 오른쪽(east<0)·왼쪽(east>0)에 두고 확인
    const cases = [
      { east: -12, name: '위례성로', want: true },
      { east: -12, name: '다른대로', want: false },
      { east: -25, name: '위례성로', want: false },  // v123: 허용 거리 15m (예전 같은 이름이면 40m)
      { east: -40, name: '위례성로', want: false },
      { east: 12, name: '위례성로', want: true },    // v123: 찍는 방향이 내 방향이면 왼쪽 12m(중앙분리대 기둥)도 내 카메라
      { east: 5, name: '위례성로', want: true },
    ];
    const out = [];
    for (const k of cases) {
      softReset();
      const R = buildRouteBeside(CAM_ISO_B, k.east, k.name);
      await planAndStart(R);
      let hit = false;
      for (let s = 14; s <= 900; s += 14) {
        const a = pointAt(R, s);
        feed(a.p, 13, a.h);   // 47 km/h (제한 50 이하)
        const tg = t.camState.target;
        if (tg && sameCam(tg.c, CAM_ISO_B)) hit = true;
      }
      out.push({ k, hit, ok: hit === k.want });
    }
    return {
      pass: parallelHit === null && oppHit === null && mineHit !== null && out.every((x) => x.ok),
      detail: '(a) no nav: 45 m parallel ' + (parallelHit === null ? 'ignored✓' : 'WRONG alert at ' + parallelHit + ' m') +
        ', opposite lane (left 14 m) ' + (oppHit === null ? 'ignored✓' : 'WRONG alert at ' + oppHit + ' m') +
        ', my side (right 6 m) ' + (mineHit !== null ? 'alert at ' + mineHit + ' m✓' : 'MISSED') +
        '; (b) on route (east<0 = camera on my right): ' + out.map((x) => x.k.east + 'm/' + x.k.name + '→' + (x.hit ? 'alert' : 'none') + (x.ok ? '✓' : '✗')).join(', '),
    };
  }

  // S15: 과속 반복 경고음은 1초에 한 번, 짧게 한 번만 (CAM_ISO_B 제한 50, 70 km/h 로 접근)
  async function s15() {
    const t = T(), C = CAM_ISO_B, v = 70 / 3.6;
    const run = (dtMs) => {
      softReset();
      // alertLog 는 300개로 잘려 번호가 밀리고, 두 번의 실행이 같은 ms 안에 끝나 시각으로도 못 가른다 → 마지막 항목을 표시로 쓴다
      const mark = t.alertLog[t.alertLog.length - 1];
      let tSim = 0, inRange = 0;
      for (let s = 0; s <= 1100; s += v * dtMs / 1000) {
        const p = dest(C, 180, 1150 - s);
        feed(p, v, 0, { dt: dtMs });
        if (hav(p, C) <= 240) { inRange++; tSim += dtMs; }
      }
      const from = mark ? t.alertLog.indexOf(mark) + 1 : 0;
      const reps = t.alertLog.slice(from).filter((e) => /제한 넘음 반복/.test(e.text)).length;
      return { reps, secs: tSim / 1000, inRange };
    };
    const a = run(1000), b = run(250);
    // 250m 안내 뒤 50m 앞까지(약 200m, 10초) 1초에 한 번. GPS 가 0.25초마다 와도 1초에 한 번 이하
    const okA = a.reps >= a.secs - 2 && a.reps <= a.secs + 1;
    const okB = b.reps <= b.secs + 1 && b.reps >= b.secs - 2;
    return {
      pass: okA && okB,
      detail: 'GPS 1 Hz: ' + a.reps + ' beeps in ' + a.secs.toFixed(0) + ' s' + (okA ? '✓' : '✗') +
        '; GPS 4 Hz: ' + b.reps + ' beeps in ' + b.secs.toFixed(1) + ' s' + (okB ? '✓' : '✗') + ' (inside 240 m)',
    };
  }

  // S16: 테슬라 모드 — 계기판 칸이 사라지고 지도가 꽉 차며, 속도는 숨기고 시계·날짜는 지도 위 글자로
  async function s16() {
    const t = T(), box = TESLA_ONLY, prev = t.prefs.tesla;
    const set = (on) => { box.checked = on; box.dispatchEvent(new Event('change')); };
    const snap = () => {
      const cl = document.querySelector('.timebox'), map = document.getElementById('map'); // 테슬라 모드에서는 시계 등이 지도 위에 따로 뜬다
      const cs = getComputedStyle(cl);
      return {
        pos: cs.position, mapW: map.clientWidth, appW: document.getElementById('app').clientWidth,
        // 부모가 숨겨져도 잡히게 실제로 그려진 상자가 있는지로 본다
        speedShown: document.getElementById('speed').getClientRects().length > 0,
        date: document.getElementById('dateText').getClientRects().length > 0 ? text('#dateText') : '', clockShown: visible('#clock'),
      };
    };
    let on, off;
    try {
      // 화면 배치는 CSS 로 바로 바뀐다 (창이 가려져 있으면 requestAnimationFrame 이 멈추므로 타이머로 기다린다)
      set(true); await new Promise((r) => setTimeout(r, 60));
      on = snap();
      off = { gone: !document.getElementById('optTesla') };   // 예전 계기판 화면과 전환 스위치는 없앴다 (2026-11-14)
    } finally {
      set(prev);
    }
    // 속도는 차 화면에 나오므로 테슬라 모드에서는 숨김. 단, 화면이 넓으면(1000px 이상: 브라우저를 크게 펼쳐 차 속도계가 가려짐) 왼쪽에 보인다
    const wantSpeed = innerWidth >= 1000;
    const okOn = on.pos === 'absolute' && on.mapW >= on.appW - 2 && on.speedShown === wantSpeed && /월 \d+일/.test(on.date) && on.clockShown;
    const okOff = off.gone && document.getElementById('app').classList.contains('tesla');
    return {
      pass: okOn && okOff,
      detail: 'on: map ' + on.mapW + '/' + on.appW + ' px, cluster ' + on.pos + ', speed ' + (on.speedShown ? 'shown' : 'hidden') + ' (want ' + (wantSpeed ? 'shown, wide' : 'hidden') + '), date "' + on.date + '"' + (okOn ? '✓' : '✗') +
        '; old layout switch removed, always Tesla ' + (okOff ? '✓' : '✗'),
    };
  }
  const C_A = () => CAM_ISO_A;

  // S33: 주차 중 자동 새 버전 — 2분 넘게 서 있고 2분 넘게 안 만졌고 길안내·검색·설정 화면이 없을 때만 확인, 10분에 한 번
  async function s33() {
    const t = T(), u = t.upd, saved = { movedAt: u.movedAt, touchAt: u.touchAt, idleAt: u.idleAt, droveAt: u.droveAt }, savedSec = t.camState.section;
    const r = {};
    try {
      const T0 = 10 * 3600e3;
      u.idleAt = 0; u.touchAt = 0; u.droveAt = 0;
      t.state.speedKmh = 5; r.moving = t.idleUpdate(T0, true);
      t.state.speedKmh = 0; r.justStopped = t.idleUpdate(T0 + 60000, true);
      u.touchAt = T0 + 100000; r.touched = t.idleUpdate(T0 + 130000, true);
      u.touchAt = 0;
      document.getElementById('searchSheet').hidden = false; r.screen = t.idleUpdate(T0 + 130000, true);
      document.getElementById('searchSheet').hidden = true;
      t.nav.preview = true; r.nav = t.idleUpdate(T0 + 130000, true); t.nav.preview = false;
      r.check = t.idleUpdate(T0 + 130000, true);
      r.again = t.idleUpdate(T0 + 190000, true);
      r.later = t.idleUpdate(T0 + 130000 + 10 * 60000 + 1, true);
      // v160: 시속 10 넘게 달린 뒤 신호대기(3분)에는 안 바꾸고, 15분 넘게 서 있으면(주차) 바꾼다. 구간단속 안이면 안 바꾼다
      const T1 = T0 + 3600e3;
      u.idleAt = 0;
      t.state.speedKmh = 40; t.idleUpdate(T1, true);
      t.state.speedKmh = 0; r.redLight = t.idleUpdate(T1 + 3 * 60000, true);
      r.parked = t.idleUpdate(T1 + 16 * 60000, true);
      u.idleAt = 0; t.camState.section = { test: 1 }; r.section = t.idleUpdate(T1 + 40 * 60000, true); t.camState.section = savedSec;
    } finally {
      Object.assign(u, saved);
      t.camState.section = savedSec;
      document.getElementById('searchSheet').hidden = true;
      t.nav.preview = false;
    }
    // 새 버전으로 옮겨 갈 때는 주소에 ?v=새 버전 (저장된 예전 index.html 을 쓰지 않게). 다른 값(debug)과 #은 그대로
    r.url1 = t.updateUrl('2026.11.14-99', { pathname: '/tesla-naver-cluster/', search: '', hash: '' });
    r.url2 = t.updateUrl('2026.11.14-99', { pathname: '/tesla-naver-cluster/', search: '?debug&v=2026.11.14-38', hash: '#x' });
    const want = { moving: 'moving', justStopped: 'just-stopped', touched: 'touched', screen: 'screen-open', nav: 'nav', check: 'check', again: 'waiting', later: 'check',
      redLight: 'drove-recently', parked: 'check', section: 'section',
      url1: '/tesla-naver-cluster/?v=2026.11.14-99', url2: '/tesla-naver-cluster/?debug=&v=2026.11.14-99#x' };
    const bad = Object.keys(want).filter((k) => r[k] !== want[k]);
    return { pass: bad.length === 0, detail: Object.keys(want).map((k) => k + '=' + r[k] + (r[k] === want[k] ? '' : '✗')).join(', ') };
  }

  // S32: 멈추면 북쪽 위로 — 진행 방향 위(동쪽 80°)로 달리다 3초 넘게 서면 북쪽 위 평면 지도(가게 글자 똑바로),
  //      다시 시속 8km 를 넘으면 진행 방향 위로. 설정을 끄면 서 있어도 진행 방향 위 그대로
  async function s32() {
    const t = T(), opt = document.getElementById('optStopNorth'), prevOpt = t.prefs.stopNorth, prevHup = t.prefs.headingUp;
    const set = (on) => { opt.checked = on; opt.dispatchEvent(new Event('change')); };
    const r = {};
    try {
      t.prefs.headingUp = true;
      set(true);
      t.setFollowing(true);
      const o = TRIP_ORIGIN;
      for (let s = 0; s <= 200; s += 15) feed(dest(o, 80, s), 15, 80);
      r.driving = t.view.drive;
      const here = dest(o, 80, 200);
      feed(here, 0, 80); r.after1s = t.view.drive;
      feed(here, 0, 80); feed(here, 0, 80); feed(here, 0, 80);
      r.after4s = t.view.drive;
      feed(here, 1, 80, { dt: 1000 });   // 시속 3.6km: 아직 정지로 본다
      r.creep = t.view.drive;
      for (let s = 15; s <= 60; s += 15) feed(dest(here, 80, s), 15, 80);
      r.movingAgain = t.view.drive;
      // 설정 끔
      set(false);
      const h2 = dest(here, 80, 60);
      for (let k = 0; k < 5; k++) feed(h2, 0, 80);
      r.offStopped = t.view.drive;
    } finally {
      set(prevOpt);
      t.prefs.headingUp = prevHup;
    }
    // 벡터(GL) 지도는 돌려도 글자가 똑바로라 멈춰도 진행 방향 위 그대로 (설정과 상관없이)
    const gl = !!(t.glOn && t.glOn());
    const ok = gl ? (r.driving === true && r.after1s === true && r.after4s === true && r.creep === true && r.movingAgain === true && r.offStopped === true)
      : (r.driving === true && r.after1s === true && r.after4s === false && r.creep === false && r.movingAgain === true && r.offStopped === true);
    return { pass: ok, detail: (gl ? '[GL map: stays heading-up when stopped] ' : '') + 'drive view while driving ' + r.driving + ', stopped 1 s ' + r.after1s + ', stopped 4 s ' + r.after4s + ' (north up), creeping ' + r.creep +
      ', moving again ' + r.movingAgain + ', setting off & stopped ' + r.offStopped };
  }

  // S30: 주행 기록 — 제한 50 카메라(CAM_ISO_B)를 70 km/h 로 지나 2km 달리고 8분 서 있으면
  //      주행 하나가 저장되고(거리·최고 속도), 과속 1건(70/50)이 기록 화면에 뜬다
  async function s30() {
    const t = T();
    const before = t.loadTrips();
    const r = {};
    try {
      t.tripStore.save([]);
      t.tripLog.cur = null;
      const C = CAM_ISO_B, v = 70 / 3.6;
      for (let s = 0; s <= 2000; s += v) feed(dest(C, 180, 1000 - s), v, 0);
      r.liveDist = Math.round(t.tripLog.cur ? t.tripLog.cur.dist : -1);
      const stop = dest(C, 0, 1000);
      for (let k = 0; k < 8; k++) feed(stop, 0, 0, { dt: 60000 });   // 8분 서 있음
      const trips = t.loadTrips();
      const tr = trips[0] || {};
      r.saved = trips.length;
      r.dist = Math.round(tr.dist || 0);
      r.max = tr.max;
      r.events = (tr.events || []).map((e) => e.kmh + '/' + e.limit + ' ' + e.kind);
      // 기록 화면
      document.getElementById('tripBtn').click();
      const head = document.querySelector('#tripList .trip-head');
      r.card = head ? head.textContent.replace(/\s+/g, ' ').slice(0, 90) : '';
      if (head) head.click();
      const ev = document.querySelector('#tripList .tc-events:not([hidden]) .tev');
      r.eventRow = ev ? ev.textContent.replace(/\s+/g, ' ') : '';
    } finally {
      document.getElementById('tripSheet').hidden = true;
      t.tripStore.save(before);
    }
    const ok = r.saved === 1 && Math.abs(r.dist - 2000) < 80 && r.max >= 69 && r.events.length === 1 && /^7\d\/50 cam$/.test(r.events[0]) &&
      /과속 1/.test(r.card) && /\/ 50 km\/h/.test(r.eventRow);
    return { pass: ok, detail: JSON.stringify(r) };
  }

  // S31: 날씨 아이콘 — 날씨 코드별로 해·달·구름·이슬비·비·눈·번개 그림이 맞게 나오고 #weather 에 그려진다
  async function s31() {
    const t = T();
    const has = (code, night, re) => re.test(t.wxIcon(code, night));
    const checks = {
      clearDaySun: has(0, false, /#ffc83d/) && !has(0, false, /#f4e7a1/),
      clearNightMoon: has(0, true, /#f4e7a1/),
      partlyCloud: has(2, false, /#ffc83d/) && has(2, false, /#eef2f7/),
      drizzleDots: has(53, false, /<circle[^>]*r="1"/) && has(53, false, /#5ab0ff/),
      rainLines: has(63, false, /stroke="#5ab0ff"/),
      snowDots: has(73, false, /fill="#ffffff"/),
      thunderBolt: has(95, false, /#ffc83d/) && has(95, false, /#cfd6df/),
    };
    const prev = t.weather.last;
    t.weather.last = { temp: 10.4, code: 53, pp: 25 };
    t.renderWeather();
    const w = document.getElementById('weather');
    checks.rendered = !!w.querySelector('svg.wxicon') && /10°/.test(w.textContent) && /이슬비/.test(w.textContent);
    // 비 확률은 '비' 글자 대신 우산 표지 + 숫자 (2026-11-14)
    checks.rainUmbrella = !!w.querySelector('.wxpp svg.wxumb') && w.querySelector('.wxpp').textContent === '25%' && !/비 25/.test(w.textContent);
    const box = TESLA_ONLY, prevT = t.prefs.tesla, prevW = t.prefs.weather;
    try {
      box.checked = true; box.dispatchEvent(new Event('change'));
      t.prefs.weather = true; t.renderWeather();
      const tb = w.querySelector('b').getBoundingClientRect(), ic = w.querySelector('.wxi svg').getBoundingClientRect();
      checks.teslaIconInPlaceOfText = getComputedStyle(w.querySelector('.wxt')).display === 'none' && ic.left >= tb.right - 1 && ic.width >= 24;
    } finally {
      box.checked = prevT; box.dispatchEvent(new Event('change'));
      t.prefs.weather = prevW;
    }
    t.weather.last = prev;
    t.renderWeather();
    const bad = Object.keys(checks).filter((k) => !checks[k]);
    return { pass: bad.length === 0, detail: Object.keys(checks).map((k) => k + (checks[k] ? '✓' : '✗')).join(', ') };
  }

  // S28: 자동 야간 — 서울의 해 높이(2026-11-13: 해 뜸 07:09, 해 짐 17:20 무렵)로 낮·밤을 가르고,
  //      야간 버튼은 자동 → 항상 어둡게 → 항상 밝게 → 자동. 다크 필터는 지도 타일에만 (경로선·아이콘은 그대로)
  async function s28() {
    const t = T(), seoul = { lat: 37.5665, lng: 126.978 };
    const el = (iso) => t.sunElevation(new Date(iso), seoul.lat, seoul.lng);
    const e = { noon: el('2026-11-13T03:30:00Z'), evening: el('2026-11-13T09:00:00Z'), dawn: el('2026-11-13T21:30:00Z'), morning: el('2026-11-13T23:30:00Z') };
    const sunOk = e.noon > 25 && e.evening < -2 && e.dawn < -2 && e.morning > 0;
    feed(seoul, 0, null);
    const btn = document.getElementById('nightBtn'), map = document.getElementById('map');
    const seq = [];
    t.setNightMode('auto');
    for (let k = 0; k < 3; k++) { btn.click(); seq.push(map.classList.contains('night') ? 'night' : 'day'); }
    // 순서: 항상 어둡게(night) → 항상 밝게(day) → 자동(지금 시각에 따라)
    const autoNow = t.isNightAt(new Date()) ? 'night' : 'day';
    const cycleOk = seq[0] === 'night' && seq[1] === 'day' && seq[2] === autoNow && btn.classList.contains('auto');
    // 다크 필터 범위
    t.setNightMode('on');
    const tile = document.querySelector('#map img[src*="map.naver.net/styles"]');
    const tileF = tile ? getComputedStyle(tile).filter : '(no tile)';
    const me = document.querySelector('#map .me');
    const meF = me ? getComputedStyle(me).filter : 'none';
    const canvasF = getComputedStyle(document.querySelector('#map .mapcanvas')).filter;
    const filterOk = (!tile || /invert|nightRoads/.test(tileF)) && !/invert|nightRoads/.test(meF) && !/invert|nightRoads/.test(canvasF);   // v109: 그림 지도 밤 = #nightRoads
    t.setNightMode('auto');
    return {
      pass: sunOk && cycleOk && filterOk,
      detail: 'Seoul sun elevation 12:30 ' + e.noon.toFixed(1) + '°, 18:00 ' + e.evening.toFixed(1) + '°, 06:30 ' + e.dawn.toFixed(1) + '°, 08:30 ' + e.morning.toFixed(1) + '°' + (sunOk ? '✓' : '✗') +
        '; button cycle ' + seq.join('→') + ' (auto now ' + autoNow + ')' + (cycleOk ? '✓' : '✗') +
        '; dark filter on tiles only ' + (filterOk ? '✓' : '✗ tile=' + tileF + ' me=' + meF + ' canvas=' + canvasF),
    };
  }

  // S29: 즐겨찾기 — 검색 결과의 ☆ → '집으로' → 검색창 첫 화면의 '집' 버튼으로 바로 안내, ★ 즐겨찾기는 목록에 뜬다
  async function s29() {
    const t = T();
    const before = JSON.stringify(t.favs());
    const place = { name: '테스트집', category: '아파트', addr: '테스트시 집로 1', lng: 127.001, lat: 37.501 };
    const place2 = { name: '테스트단골카페', category: '카페', addr: '테스트시 커피로 2', lng: 127.003, lat: 37.503 };
    stub.canned['/search'] = { items: [place, place2] };
    stub.canned['/geocode'] = { items: [] };
    stub.canned['/route'] = buildNavRoute().route;
    feed({ lat: 37.5, lng: 127.0 }, 0, null);
    const r = {};
    try {
      t.openSearch();
      r.unsetChips = document.querySelectorAll('#results .qchip.unset').length;
      // 집·회사 버튼: 그림이 붙고(집·회사 건물), '검색 결과의 ☆ 로 지정' 안내 글은 없다 (2026-11-14)
      r.chipIcons = document.querySelectorAll('#results .qchip .qic svg, #results .qchip .qic img').length;
      r.noHint = !/☆ 로 지정/.test(document.getElementById('results').textContent);
      document.getElementById('q').value = '테스트';
      await t.doSearch(false);
      const stars = document.querySelectorAll('#results .star');
      r.stars = stars.length;
      stars[0].click();
      const homeBtn = document.querySelector('#results .favmenu:not([hidden]) button[data-a="home"]');
      if (homeBtn) homeBtn.click();
      document.querySelectorAll('#results .star')[1].click();
      const favBtn = document.querySelector('#results .favmenu:not([hidden]) button[data-a="fav"]');
      if (favBtn) favBtn.click();
      r.home = (t.favs().home || {}).name;
      r.favList = t.favs().list.map((x) => x.name);
      // 첫 화면: 집 버튼에 이름, 즐겨찾기 목록에 카페
      document.getElementById('q').value = '';
      t.openSearch();
      const homeChip = document.querySelector('#results .qchip[data-q="home"]');
      r.homeChip = homeChip ? homeChip.textContent : '';
      r.favShown = [...document.querySelectorAll('#results .result .nm')].some((n) => /테스트단골카페/.test(n.textContent));
      const c0 = stub.calls.length;
      homeChip.click();
      await waitFor(() => stub.count('/route', c0) >= 1, 2000, 20);
      const q = (stub.since(c0, '/route')[0] || {}).query || {};
      r.routedHome = q.goal === place.lng.toFixed(6) + ',' + place.lat.toFixed(6);
      await waitFor(() => !t.nav.busy, 2000, 20);
    } finally {
      // 원래 즐겨찾기로 되돌린다
      t.setFav(place, 'remove'); t.setFav(place2, 'remove');
      const b = JSON.parse(before);
      if (b.home) t.setFav(b.home, 'home');
      if (b.work) t.setFav(b.work, 'work');
      t.endNav();
      document.getElementById('searchSheet').hidden = true;
    }
    const ok = r.unsetChips >= 0 && r.chipIcons === 2 && r.noHint && r.stars === 2 && r.home === '테스트집' && r.favList.includes('테스트단골카페') &&
      /테스트집/.test(r.homeChip) && r.favShown && r.routedHome;
    return { pass: ok, detail: JSON.stringify(r) };
  }

  // S27: 실제 경로로 구간단속 — 수도권제1순환고속도로 판교 부근 구간(시작 [37.39568,127.04752] → 끝 [37.40004,127.08276], 약 3.1km, 제한 100).
  //      test/fixtures/route-ring1-pangyo.json 은 2026-11-13 에 받은 실제 네이버 경로(평촌 → 성남).
  //      길안내 주행(97 km/h, 112 km/h 과속)과 길안내 없는 주행에서 시작 안내 → 평균 속도 카드 → 끝 안내가 맞게 나오는지
  const SEC_START = { lat: 37.39568, lng: 127.04752 }, SEC_END = { lat: 37.40004, lng: 127.08276 };
  async function s27() {
    const t = T();
    const fx = await (await realFetch(harnessDir + 'fixtures/route-ring1-pangyo.json', { cache: 'no-store' })).json();
    const P = fx.path.map((x) => ({ lat: x[1], lng: x[0] }));
    const cum = [0];
    for (let i = 1; i < P.length; i++) cum.push(cum[i - 1] + hav(P[i - 1], P[i]));
    const total = cum[cum.length - 1];
    const R = { route: fx, P, cum, total, dest: { name: '성남', addr: '', lat: P[P.length - 1].lat, lng: P[P.length - 1].lng } };
    const nearestS = (c) => { let b = 1e9, s = 0; for (let s0 = 0; s0 <= total; s0 += 5) { const d = hav(pointAt(R, s0).p, c); if (d < b) { b = d; s = s0; } } return s; };
    const sStart = nearestS(SEC_START), sEnd = nearestS(SEC_END);
    const run = async (v, withNav) => {
      softReset();
      if (withNav) await planAndStart(R); else feed(P[0], 0, null);
      const mark = t.alertLog[t.alertLog.length - 1];
      const o = { startTarget: null, secAt: null, mid: null, endAt: null, lastSec: null };
      for (let s = Math.max(0, sStart - 3500); s <= Math.min(total, sEnd + 800); s += v) {
        const a = pointAt(R, s);
        feed(a.p, v, a.h);
        const tg = t.camState.target, sec = t.camState.section;
        if (!o.startTarget && tg && tg.c[4] === 1 && hav({ lat: tg.c[0], lng: tg.c[1] }, SEC_START) < 30) o.startTarget = r0(sStart - s);
        if (sec && o.secAt === null) o.secAt = r0(s - sStart);
        if (sec && !o.mid && s >= (sStart + sEnd) / 2) {
          const rm = /남은 거리 ([\d.]+)(km|m)/.exec(text('#secRemain'));
          // v137: 평균은 속도 칸('구간평균 97'), 경고 카드에는 게이지 밑 '남은 시간 01:05' (구간단속 카드는 경고 카드가 있으면 접힘)
          // v252: 구간 안 끝 카메라는 카드가 없어 구간 칸만 본다 (숨긴 창에서는 나타나는 애니메이션이 멈춰 불투명도 0 이라 hidden·자리로 본다)
          o.mid = { avg: num('#secAvg'), over: hasCls('#secCard', 'over'), shown: visible('#secCard') || (!document.getElementById('secCard').hidden && document.getElementById('secCard').getClientRects().length > 0) || (visible('#camHint') && document.getElementById('camHint').getClientRects().length > 0), remain: text('#secRemain'),
            chip: text('#mySpeedLim'), hint: visible('#camHint') ? text('#camHint') : '',
            remainM: rm ? parseFloat(rm[1]) * (rm[2] === 'km' ? 1000 : 1) : null, wantM: sEnd - s };
        }
        if (o.secAt !== null && !sec && o.endAt === null) o.endAt = r0(s - sEnd);
      }
      const from = mark ? t.alertLog.indexOf(mark) + 1 : 0;
      const log = t.alertLog.slice(from).map((e) => e.text);
      o.voiceStart = log.some((x) => /구간단속 시작/.test(x));
      o.voiceEnd = log.some((x) => /구간단속이 끝났습니다/.test(x));
      o.voiceOver = log.filter((x) => /구간 평균 제한 넘음 알림음/.test(x)).length;   // v122: 말 없이 알림음 한 번
      if (withNav) t.endNav();
      return o;
    };
    const a = await run(27, true), b = await run(31, true), c = await run(27, false);
    // 길안내 중이면 남은 거리는 경로 위 끝 카메라까지의 실제 거리(±100m). 과속하면 권장 속도와 음성 한 번
    const ok = (o, over, navOn) => o.startTarget !== null && o.startTarget > 1000 && o.secAt !== null && o.secAt >= 0 && o.secAt < 60 &&
      !!o.mid && o.mid.shown && o.mid.over === over && /^구간평균\s*\d+$/.test(o.mid.chip) && (!o.mid.hint || /^남은 시간 \d\d:\d\d/.test(o.mid.hint)) && o.endAt !== null && o.endAt >= 0 && o.endAt < 80 && o.voiceStart && o.voiceEnd &&
      (!navOn || (o.mid.remainM !== null && Math.abs(o.mid.remainM - o.mid.wantM) < 100)) &&
      (!over || (/km\/h 이하로/.test(o.mid.remain) && o.voiceOver === 1));
    const show = (o) => 'start cam alert ' + (o.startTarget === null ? 'NEVER' : o.startTarget + ' m before') + ', section on at +' + o.secAt + ' m' +
      (o.mid ? ', mid avg ' + o.mid.avg + ' km/h' + (o.mid.over ? ' OVER' : '') + ' "' + o.mid.remain + '" chip "' + o.mid.chip + '" hint "' + o.mid.hint + '" (real ' + r0(o.mid.wantM) + ' m)' : ', NO CARD') +
      ', off at end +' + o.endAt + ' m, voice start ' + o.voiceStart + ' end ' + o.voiceEnd;
    const okA = ok(a, false, true), okB = ok(b, true, true), okC = ok(c, false, false);
    return {
      pass: okA && okB && okC,
      detail: 'section ' + r0(sEnd - sStart) + ' m on real route. nav 97 km/h: ' + show(a) + (okA ? '✓' : '✗') + ' | nav 112 km/h: ' + show(b) + (okB ? '✓' : '✗') +
        ' | no nav 97 km/h: ' + show(c) + (okC ? '✓' : '✗'),
    };
  }

  // S24: 테슬라 모드 배치 — 시계 오른쪽 위, 주소 가운데 아래, GPS 오른쪽 아래, 나침반 왼쪽 아래,
  //      경로 막대 오른쪽 끝(얇게, 가장자리에서 조금 띄워서), 단속 경고는 길안내 패널 바로 밑, 버튼은 70% 크기(40px)
  async function s24() {
    const t = T(), box = TESLA_ONLY, prev = t.prefs.tesla;
    const set = (on) => { box.checked = on; box.dispatchEvent(new Event('change')); };
    let r = {};
    try {
      set(true);
      const R = buildNavRoute();
      await planAndStart(R);
      feed(pointAt(R, 15).p, 15, 0);
      t.renderNav();
      // 길안내 패널은 나타날 때 0.2초 동안 살짝 떠오른다(rise). 화면이 보이는 동안 재면 그 도중이라 위치가 몇 px 다르다.
      // 끝난 뒤 다시 그리고 잰다. 오른쪽 경로 막대도 0.5초 동안 오른쪽에서 미끄러져 들어오므로(2026-11-14) 0.7초 기다린다
      await new Promise((res) => setTimeout(res, 700));
      // 창이 가려져 있으면 애니메이션이 멈춰 있으므로 진행 중인 것을 바로 끝낸다
      try { document.getAnimations().forEach((a) => { try { a.finish(); } catch (e) { /* 무한 반복 등 */ } }); } catch (e) { /* 미지원 */ }
      t.renderNav();
      await new Promise((res) => setTimeout(res, 30));
      const app = document.getElementById('app').getBoundingClientRect();
      const q = (s) => document.querySelector(s).getBoundingClientRect();
      const clock = q('.timebox'), road = q('#roadName'), gps = q('.gps'), head = q('.heading'), strip = q('#routeStrip'),
        bar = q('#rsBar'), alerts = q('.alerts'), np = q('#navPanel'), btn = q('#zin'), tc = q('.topctrls');
      r = {
        clockTopRight: clock.right > app.right - 40 && clock.top < app.top + 40,
        // v263: 길안내 중 아래 띠(남은 거리·도착·안내 종료 + 지금 위치)는 왼쪽 칸(안내 카드)과 오른쪽 아래 주행 기록 카드 사이 가운데
        roadBottomCenter: (() => { const tr = document.querySelector('.trip').getBoundingClientRect(), nb = document.getElementById('navBar').getBoundingClientRect();
          return Math.abs((nb.left + nb.right) / 2 - (np.right + tr.left) / 2) < 4 && nb.bottom > app.bottom - 80 && road.bottom <= nb.bottom + 1; })(),
        gpsBottomRight: gps.right > app.right - 40 && gps.bottom > app.bottom - 60,
        compassBottomLeft: head.right > app.right - 260 && head.bottom > app.bottom - 160, // v263: 나침반 줄은 오른쪽 아래 주행 기록 카드 맨 위
        // 주행 기록은 맨 아래지만 화면 테두리에서 띄워서(아래 24px 이상, 왼쪽 20px 이상), 나침반은 그 위
        tripAtBottom: (() => { const tr = document.querySelector('.trip').getBoundingClientRect();
          return tr.bottom <= app.bottom - 24 && tr.bottom > app.bottom - 60 && tr.right <= app.right - 8 && tr.right > app.right - 40 && head.top >= tr.top - 1 && head.bottom <= tr.top + 64; })(),   // v263: 오른쪽 아래, GPS 줄 위
        // 오른쪽 끝의 가는 막대 (2026-11-14 요청으로 6 → 10px: 그래도 12px 이하)
        stripRight: strip.left > app.right - 80 && bar.width <= 12,
        // 경로 막대는 세로 가운데
        stripMiddle: Math.abs((strip.top + strip.bottom) / 2 - (app.top + app.bottom) / 2) < 12,
        // 오른쪽·위 테두리에서 띄우기: 시계·경로 막대가 테두리에 붙지 않는다
        rightGap: app.right - clock.right >= 30 && clock.top - app.top >= 16 && app.right - strip.right >= 30,
        // 단속 서랍은 패널 바로 밑에 붙고(서랍이 접혀 있으면 그 밑 항목은 22px 떨어짐)
        alertsUnderNav: Math.abs(alerts.top - np.bottom) <= 2 && alerts.left < app.left + 40,
        buttons70: btn.width >= 36 && btn.width <= 42,
        // 길안내 패널 맨 위에 목적지 줄(아이콘 + 이름 + 밑줄), 그 밑에 회전 안내
        destRow: (() => { const d = document.querySelector('.navdest').getBoundingClientRect(), tn = document.querySelector('.turn').getBoundingClientRect();
          return text('#navDestName') === R.dest.name && d.top >= np.top - 1 && d.bottom <= tn.top + 1 && !!document.querySelector('.navdest .nd-icon svg'); })(),
        // 화면이 넓으면(1000px 이상, 테슬라 브라우저를 크게 펼친 1307×747) 왼쪽 나침반 위에 속도계, 보통 크기(804)에서는 숨김
        speedWhenWide: (() => { const sb = document.querySelector('.speedbox'), on = sb.getClientRects().length > 0 && getComputedStyle(sb).display !== 'none';
          if (innerWidth < 1000) return !on;
          const r = sb.getBoundingClientRect(), fb = document.querySelector('.fbcorner').getBoundingClientRect(); return on && r.left < app.left + 60 && r.bottom <= fb.top + 4; })(),   // v263: '의견' 버튼 위
        // 야간·전체화면·설정 버튼은 길안내 패널 바로 오른쪽, 패널 위쪽 높이에
        topButtonsNextToNav: tc.left >= np.right && tc.left - np.right <= 16 && Math.abs(tc.top - np.top) <= 4,
      };
    } finally {
      t.endNav();
      set(prev);
    }
    const bad = Object.keys(r).filter((k) => !r[k]);
    return { pass: bad.length === 0, detail: Object.keys(r).map((k) => k + (r[k] ? '✓' : '✗')).join(', ') };
  }

  // S34: 테슬라 모드 — 단속 경고 밑에 '내 속도 / 제한'. 제한을 넘으면 빨갛게, 안 넘으면 평소색, 단속이 없으면 숨김.
  //      순서: 맨 위 내 속도 띠(2026-11-14 요청) → 보통 과속 단속(제한 표지·거리) → 맨 밑 작은 '어린이 조심' 표지.
  //      큰 보호구역 타일은 안 쓴다. 테슬라 모드가 꺼져 있으면 내 속도는 안 보인다(왼쪽 속도계가 있으니까)
  async function s34() {
    const t = T(), C = CAM_SCHOOL, box = TESLA_ONLY, prev = t.prefs.tesla;
    const set = (on) => { box.checked = on; box.dispatchEvent(new Event('change')); };
    const shown = () => { const e = document.getElementById('mySpeed'); return !e.hidden && e.getClientRects().length > 0; };
    const approach = (kmh) => {
      softReset();
      let o = null;
      for (let s = 0; s <= 400 && !o; s += 10) {
        feed(dest(C, (C.eb + 180) % 360, 600 - s), kmh / 3.6, C.eb);
        const tg = t.camState.target;
        if (tg && sameCam(tg.c, C)) {
          const box = (sel) => { const e = document.querySelector(sel); return e && e.getClientRects().length ? e.getBoundingClientRect() : null; };
          const sign = box('#camCard .cam-sign'), my = box('#mySpeed'), zb = box('#zoneBadge'), tile = box('#camCard .zone-tile'), icon = box('#zbSign svg');
          o = { shown: shown(), over: hasCls('#mySpeed', 'over'), val: text('#mySpeedVal'), lim: text('#mySpeedLim'),
            order: !!sign && !!my && !!zb && my.bottom <= sign.top + 1 && sign.top < zb.top, badge: text('#zbLabel'), iconH: icon ? r0(icon.height) : null, bigTile: !!tile };
        }
      }
      return o;
    };
    let fast, slow, none, off, nextIcon = false;
    try {
      set(true);
      fast = approach(45);
      slow = approach(25);
      softReset();
      feed(dest(C, 180, 6000), 10, 0);
      feed(dest(C, 180, 5990), 10, 0);
      none = shown();
      // 다음 단속 (경고 거리 밖): 테슬라 모드에서는 '다음 단속' 글자 없이 표지 + 거리
      softReset();
      feed(dest(C, 180, 6000), 10, 0);
      t.camState.target = null;
      t.camState.peek = { i: -1, c: [C.lat, C.lng, 70, 3, 0, 0, 0, -1, 3, 3], d: 6000 };
      t.renderCam();
      const nx = document.getElementById('camNext');
      nextIcon = !nx.hidden && getComputedStyle(nx.querySelector('.nx-label')).display === 'none' &&
        nx.querySelector('.mini-sign').textContent === '70' && /\d(\.\d)?k?m$/.test(nx.querySelector('b').textContent) && nx.getAttribute('aria-label').indexOf('다음 단속') === 0;
      t.camState.peek = null;
      off = { removed: true };   // 예전 화면이 없어져 '테슬라 모드 끔' 상태는 없다
    } finally {
      set(prev);
      softReset();
    }
    const okFast = !!fast && fast.shown && fast.over && fast.val === '45' && /제한 30/.test(fast.lim) && fast.order && fast.badge === '어린이 조심' &&
      fast.iconH !== null && fast.iconH <= 32 && !fast.bigTile;
    const okSlow = !!slow && slow.shown && !slow.over && slow.val === '25';
    const okOff = !!off && off.removed;
    return {
      pass: okFast && okSlow && !none && okOff && nextIcon,
      detail: '45 km/h: ' + JSON.stringify(fast) + (okFast ? '✓' : '✗') + ' | 25 km/h: ' + JSON.stringify(slow) + (okSlow ? '✓' : '✗') +
        ' | no camera: ' + (none ? 'SHOWN✗' : 'hidden✓') + ' | tesla off: ' + (okOff ? 'hidden✓' : 'SHOWN✗') + ' | next camera icon only: ' + (nextIcon ? '✓' : '✗'),
    };
  }

  // S35: 가평 계량교(가화로) 제한 30 카메라 — 원본은 '신호 전용'이라 안 잡혔다. 보정 후 신호·과속으로 잡히고
  //      과속이면 빨갛게, 표지 위에 작은 신호등 아이콘. 양방향(마장리→대곡리 H4877, 대곡리→마장리 H4878) 모두
  async function s35() {
    const t = T(), A = { lat: 37.83903, lng: 127.5067 }, B = { lat: 37.84072, lng: 127.50646 };
    const run = (cam, bearing) => {
      softReset();
      const from = dest(cam, (bearing + 180) % 360, 600);
      let o = null;
      for (let s = 0; s <= 590 && !o; s += 10) {
        feed(dest(from, bearing, s), 45 / 3.6, bearing);
        const tg = t.camState.target;
        if (tg && sameCam(tg.c, cam) && tg.d < 300) {
          o = { kind: tg.c[3], limit: tg.c[2], label: text('#camType'), sig: hasCls('#camCard', 'sigspeed'), over: hasCls('#camCard', 'over') };
        }
      }
      return o;
    };
    const south = run(A, 180), north = run(B, 0);
    softReset();
    const ok = (o) => !!o && o.kind === 3 && o.limit === 30 && o.label === '신호·과속단속' && o.sig && o.over;
    return {
      pass: ok(south) && ok(north),
      detail: '계량교 남행(H4877): ' + JSON.stringify(south) + (ok(south) ? '✓' : '✗') + ' | 승안삼거리 북행(H4878): ' + JSON.stringify(north) + (ok(north) ? '✓' : '✗'),
    };
  }

  // S36: 후면 단속 — 가평읍 경춘로 포회촌마을입구교차로, 서울 방향(남서행) 제한 70 신호·과속 후면단속 (원본에 없어 직접 추가한 카메라).
  //      남서행이면 '신호·과속 후면단속'으로 잡히고, 기둥을 지난 뒤에도 60m 까지 경고(과속이면 빨갛게)를 유지했다가 내린다.
  //      반대 방향(북동행, 실제 경로는 9m 남동쪽)에서는 잡히지 않는다.
  //      길안내 중에도 실제 네이버 경로(test/fixtures/route-gapyeong-sw|ne.json, 2026-11-14)로: 남서행은 이 카메라를,
  //      북동행은 원본의 반대 방향 카메라(H7738, 60)만 알린다
  async function s36() {
    const t = T(), CAM = { lat: 37.79681, lng: 127.48014 }, FOOT = { lat: 37.796721, lng: 127.480224 };
    const sw = (() => {
      softReset();
      const from = dest(FOOT, 53, 700);
      const o = { label: null, at: null, past45: null, past45over: null, clearedAt: null };
      for (let s = 0; s <= 800; s += 5) {
        const p = dest(from, 233, s), past = s - 700;
        feed(p, 80 / 3.6, 233);
        const tg = t.camState.target, mine = !!tg && sameCam(tg.c, CAM);
        if (mine && o.label === null) { o.label = text('#camType'); o.at = r0(tg.d); o.limit = tg.c[2]; }
        if (past >= 45 && o.past45 === null) { o.past45 = mine && !!tg.after; o.past45over = hasCls('#camCard', 'over'); }
        if (o.label !== null && !mine && o.clearedAt === null && past > 0) o.clearedAt = past;
      }
      return o;
    })();
    const ne = (() => {
      softReset();
      const lane = dest(FOOT, 143, 9), from = dest(lane, 233, 600);
      let hit = false;
      for (let s = 0; s <= 900; s += 10) {
        feed(dest(from, 53, s), 80 / 3.6, 53);
        const tg = t.camState.target;
        if (tg && sameCam(tg.c, CAM)) hit = true;
      }
      return hit;
    })();
    const H7738 = { lat: 37.79657, lng: 127.4802 };
    const navRun = async (file) => {
      softReset();
      const fx = await (await realFetch(harnessDir + 'fixtures/' + file, { cache: 'no-store' })).json();
      const P = fx.path.map((x) => ({ lat: x[1], lng: x[0] }));
      const cum = [0];
      for (let i = 1; i < P.length; i++) cum.push(cum[i - 1] + hav(P[i - 1], P[i]));
      const total = cum[cum.length - 1];
      const R = { route: fx, P, cum, total, dest: { name: '경춘로', addr: '', lat: P[P.length - 1].lat, lng: P[P.length - 1].lng } };
      await planAndStart(R);
      const o = { rear: false, rearLabel: null, h7738: false };
      for (let s = 0; s <= total - 50; s += 10) {
        const a = pointAt(R, s);
        feed(a.p, 80 / 3.6, a.h);
        const tg = t.camState.target;
        if (tg && sameCam(tg.c, CAM)) { o.rear = true; o.rearLabel = text('#camType'); }
        if (tg && sameCam(tg.c, H7738)) o.h7738 = true;
      }
      t.endNav();
      return o;
    };
    const navSw = await navRun('route-gapyeong-sw.json'), navNe = await navRun('route-gapyeong-ne.json');
    softReset();
    // v264: 후면 카메라는 네이버 배지처럼 '후면단속'(신호·과속이어도), 지난 뒤 100m 까지 '후면단속 중'
    const okNav = navSw.rear && navSw.rearLabel === '후면단속' && !navSw.h7738 && !navNe.rear && navNe.h7738;
    const okSw = sw.label === '후면단속' && sw.limit === 70 && sw.past45 === true && sw.past45over === true && sw.clearedAt !== null && sw.clearedAt >= 95 && sw.clearedAt <= 115;
    return {
      pass: okSw && !ne && okNav,
      detail: '서울 방향 80 km/h: ' + JSON.stringify(sw) + (okSw ? '✓' : '✗') + ' | 반대 방향: ' + (ne ? 'ALERTED✗' : 'not alerted✓') +
        ' | 길안내 남서행 ' + JSON.stringify(navSw) + ', 북동행 ' + JSON.stringify(navNe) + (okNav ? '✓' : '✗'),
    };
  }

  // S37: 가평 → 청평 → 신청평대교 실제 경로 (2026-11-14 주행 제보 "가는 길 단속 10개 중 2개만 떴다").
  //      test/fixtures/route-gapyeong-cheongpyeong.json: 가평읍 가화로(계량교 북쪽) → 경춘로 → 팔각정삼거리 좌회전 → 북한강로.
  //      원본 '신호'인 교차로 카메라가 신호·과속으로 잡혀야 한다. 반대 방향 전용(진동마을 과속, 포회촌·벚꽃길의 서울→춘천 쪽)은 잡히면 안 된다.
  //      v122: 처음엔 반대 방향 등록이 없는 교차로 카메라(수리재·소돌마을)도 양방향으로 잡아야 한다고 봤는데, 이 길에서 방향이 적힌
  //      카메라 쌍은 우리 쪽이 경로 오른쪽 6~12m, 반대쪽이 왼쪽 11~17m 이고 수리재(왼쪽 12m)·소돌마을(왼쪽 16m)이 반대쪽과 같은 자리다
  //      (2026-11-15 사용자 '왼쪽은 반대편 차선인 경우가 많았음'). 그래서 이제 잡히면 안 된다. 청평검문소(왼쪽 10m)는 경계라 따지지 않는다
  async function s37() {
    const t = T();
    const fx = await (await realFetch(harnessDir + 'fixtures/route-gapyeong-cheongpyeong.json', { cache: 'no-store' })).json();
    const P = fx.path.map((x) => ({ lat: x[1], lng: x[0] }));
    const cum = [0];
    for (let i = 1; i < P.length; i++) cum.push(cum[i - 1] + hav(P[i - 1], P[i]));
    const total = cum[cum.length - 1];
    const R = { route: fx, P, cum, total, dest: { name: '북한강로', addr: '', lat: P[P.length - 1].lat, lng: P[P.length - 1].lng } };
    softReset();
    await planAndStart(R);
    const seen = new Map();
    for (let s = 0; s <= total - 30; s += 15) {
      const a = pointAt(R, s);
      feed(a.p, 60 / 3.6, a.h);
      const tg = t.camState.target;
      if (tg) { const k = tg.c[0] + ',' + tg.c[1]; if (!seen.has(k)) seen.set(k, { limit: tg.c[2], type: text('#camType') }); }
    }
    t.endNav();
    softReset();
    const must = {
      '계량교(마장리→대곡리)': ['37.83903,127.5067'], '가평초교(어린이)': ['37.8298,127.51091', '37.82939,127.51094'],
      '포회촌(후면)': ['37.79681,127.48014'], '초옥동': ['37.77894,127.46407'], '청평중학교': ['37.74205,127.42369'],
    };
    const mustNot = { '진동마을(서울→춘천 과속)': '37.81049,127.49785', '포회촌(서울→춘천)': '37.79657,127.4802', '벚꽃길(서울→춘천)': '37.7791,127.46435',
      '수리재(왼쪽 12m)': '37.76907,127.4477', '소돌마을(왼쪽 16m)': '37.72456,127.40855',
      '승안삼거리(대곡리→마장리, 계량교와 반대 방향 쌍)': '37.84072,127.50646' };
    const missing = Object.keys(must).filter((k) => !must[k].some((x) => seen.has(x)));
    const wrong = Object.keys(mustNot).filter((k) => seen.has(mustNot[k]));
    const list = [...seen.entries()].map(([k, v]) => k + ' ' + v.limit + ' ' + v.type);
    return {
      pass: missing.length === 0 && wrong.length === 0,
      detail: seen.size + ' cameras alerted along ' + r0(total / 1000) + ' km: ' + list.join(' | ') +
        (missing.length ? ' — MISSING ' + missing.join(', ') : '') + (wrong.length ? ' — WRONG (opposite) ' + wrong.join(', ') : ''),
    };
  }

  // S38: 넓은 도로는 카메라가 경로선에서 20~40m 떨어져 있기도 하다 (2026-11-14 전국 16개 경로 점검). 실제 대전 경로
  //      (test/fixtures/route-daejeon-yuseong.json, 대전역 → 유성)로:
  //      (a) 계룡로 카메라(12431)는 경로선 오른쪽 26m 이고 그 구간 이름을 모르지만, 800m 안 경로 바로 위에 같은 계룡로 카메라가 있어 잡혀야 한다
  //      (b) v122: 한밭대로(왼쪽 34m)·대전로(왼쪽 30m) 카메라는 넓은 길 건너편, 반대 방향 차로 쪽이라 잡히면 안 된다
  //          (처음엔 도로 이름이 같으면 잡았는데, 2026-11-15 실제 경로 점검에서 넓은 길 왼쪽 20~37m 카메라는 반대 방향용이었다).
  //          지금 달리는 도로(역지오코딩)가 '대전로'여도 마찬가지
  async function s38() {
    const t = T();
    const fx = await (await realFetch(harnessDir + 'fixtures/route-daejeon-yuseong.json', { cache: 'no-store' })).json();
    const P = fx.path.map((x) => ({ lat: x[1], lng: x[0] }));
    const cum = [0];
    for (let i = 1; i < P.length; i++) cum.push(cum[i - 1] + hav(P[i - 1], P[i]));
    const R = { route: fx, P, cum, total: cum[cum.length - 1], dest: { name: '유성', addr: '', lat: P[P.length - 1].lat, lng: P[P.length - 1].lng } };
    const DJ = { lat: 36.33832, lng: 127.42962 }, HB = { lat: 36.35745, lng: 127.40847 }, GR = { lat: 36.35387, lng: 127.34196 };
    const run = async (roadName) => {
      softReset();
      stub.canned['/reverse'] = { road: roadName, area: '대전광역시' };
      await planAndStart(R);
      const o = { daejeonro: false, hanbat: false, gyeryong: false };
      let k = 0;
      for (let s = 0; s <= Math.min(R.total - 30, 12800); s += 15) {
        const a = pointAt(R, s);
        feed(a.p, 50 / 3.6, a.h);
        if (++k % 6 === 0) await new Promise((r) => setTimeout(r, 0));   // 역지오코딩 응답이 들어오게
        const tg = t.camState.target;
        if (tg && sameCam(tg.c, DJ)) o.daejeonro = true;
        if (tg && sameCam(tg.c, HB)) o.hanbat = true;
        if (tg && sameCam(tg.c, GR)) o.gyeryong = true;
      }
      t.endNav();
      return o;
    };
    let a, b;
    try {
      a = await run('대전로');
      b = await run('하네스로');
    } finally {
      stub.reset();
      softReset();
    }
    const ok = !a.daejeonro && !a.hanbat && a.gyeryong && !b.daejeonro && !b.hanbat && b.gyeryong;
    return {
      pass: ok,
      detail: 'driving on 대전로: ' + JSON.stringify(a) + ' | on another road: ' + JSON.stringify(b) + (ok ? '✓' : '✗'),
    };
  }

  // S39: 하단 위치 띠 (2026-11-14 요청: 배경 있는 띠, 누르면 버튼이 올라옴 — 경로 비교·재추천·경유지)
  //      길안내가 없으면 '목적지 검색'만. 재추천은 추천(traoptimal)으로 다시 찾고, 경로 비교는 안내를 멈추지 않고
  //      카드에 '지금 경로' + 다른 경로를 띄워 고르면 바로 그 경로로, '원래 경로로'면 되돌린다.
  //      경유지는 검색해서 고르면 목적지는 그대로 waypoints 를 붙여 다시 찾고, 근처를 지나면 목록에서 빠진다
  async function s39() {
    const t = T(), box = TESLA_ONLY, prev = t.prefs.tesla;
    const set = (on) => { box.checked = on; box.dispatchEvent(new Event('change')); };
    const vis = (q) => { const e = document.querySelector(q); return !!e && !e.hidden && e.getClientRects().length > 0; };
    const click = (q) => document.querySelector(q).click();
    const wait = (ms) => new Promise((res) => setTimeout(res, ms));
    const r = {};
    try {
      set(true);
      softReset();
      const bg = getComputedStyle(document.getElementById('roadName')).backgroundColor;
      r.pillBg = bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent';
      click('#roadName'); await wait(60);
      r.idleTray = vis('#navTray') && vis('#ntSearch') && !vis('#ntCompare');
      t.closeTray(); await wait(250);
      const R = buildNavRoute();
      await planAndStart(R);
      const a30 = pointAt(R, 30);
      feed(a30.p, 10, a30.h);
      click('#roadName'); await wait(60);
      r.navTray = vis('#ntCompare') && vis('#ntReroute') && vis('#ntVia') && !vis('#ntSearch');
      // 재추천
      let c0 = stub.calls.length;
      click('#ntReroute');
      await waitFor(() => !t.nav.busy, 3000, 20);
      let calls = stub.since(c0, '/route');
      r.reroute = calls.length === 1 && calls[0].query.option === 'traoptimal' && t.nav.active;
      // 경로 비교
      const baseRoute = t.nav.route;
      stub.canned['/route'] = { alternatives: [Object.assign({}, R.route, { option: 'traoptimal' }),
        Object.assign({}, R.route, { option: 'trafast', distance: R.route.distance + 1000, duration: R.route.duration + 120000 })] };
      c0 = stub.calls.length;
      click('#roadName'); await wait(60); click('#ntCompare');
      await waitFor(() => !t.nav.busy, 3000, 20);
      calls = stub.since(c0, '/route');
      const alts = [...document.querySelectorAll('#rcAlts .alt')].map((b) => b.textContent);
      r.compareCard = vis('#routeCard') && t.nav.active && !!t.nav.comparing && calls.length === 1 && !!calls[0].query.options &&
        alts.length === 3 && /지금 경로/.test(alts[0]) && text('#rcCancel') === '원래 경로로';
      document.querySelector('#rcAlts .alt[data-k="1"]').click();
      r.switched = t.nav.active && t.nav.route !== baseRoute && t.nav.route.distance === R.route.distance + 1000;
      click('#rcCancel');
      r.restored = !vis('#routeCard') && t.nav.active && t.nav.route === baseRoute && !t.nav.comparing && text('#rcCancel') === '원래 경로로';
      // 경유지
      stub.canned['/route'] = R.route;
      click('#roadName'); await wait(60); click('#ntVia'); await wait(60);
      r.viaSearch = vis('#searchSheet') && /경유지/.test(document.getElementById('q').placeholder);
      const W = dest(NAV_ORIGIN, 90, 300);
      c0 = stub.calls.length;
      t.pickDest({ name: '경유 테스트', lat: W.lat, lng: W.lng });
      await waitFor(() => !t.nav.busy, 3000, 20);
      calls = stub.since(c0, '/route');
      r.viaRoute = calls.length === 1 && calls[0].query.waypoints === W.lng.toFixed(6) + ',' + W.lat.toFixed(6) && t.nav.active && t.nav.dest.name === R.dest.name;
      click('#roadName'); await wait(60);
      r.viaLabel = text('#ntViaLabel') === '경유지 빼기';
      t.closeTray();
      feed(W, 10, 90);
      r.viaPassed = t.nav.via.length === 0;
    } finally {
      t.endNav();
      stub.reset();
      set(prev);
      t.closeTray();
      softReset();
    }
    const bad = Object.keys(r).filter((k) => !r[k]);
    return { pass: bad.length === 0 && Object.keys(r).length === 11, detail: Object.keys(r).map((k) => k + (r[k] ? '✓' : '✗')).join(', ') };
  }

  // S40: 새 버전 (2026-11-14: 차에서 새로고침했다고 생각했지만 열려 있던 화면 그대로라 예전 버전).
  //      운전·길안내 중에는 바꾸지 않고 하단 띠 버튼에 '새 버전'만 띄운다. 누르면 목적지·경유지를 남기고 새 버전으로 가며,
  //      새 버전은 첫 위치를 받는 대로 경로 카드 없이 같은 목적지(경유지 포함)로 이어서 안내한다
  async function s40() {
    const t = T(), wait = (ms) => new Promise((res) => setTimeout(res, ms));
    const vis = (q) => { const e = document.querySelector(q); return !!e && !e.hidden && e.getClientRects().length > 0; };
    const r = {};
    const prevNewer = t.upd.newer;
    try {
      softReset();
      const R = buildNavRoute();
      feed(R.P[0], 0, null);
      t.upd.newer = null; t.renderUpdBtn();
      t.openTray(); await wait(40);
      r.noButton = !vis('#ntUpdate') && !vis('#updBtn');
      t.closeTray(); await wait(220);
      t.upd.newer = '2026.11.14-99'; t.renderUpdBtn();
      // 작은 '업데이트' 버튼은 띠를 안 눌러도 오른쪽 위에 늘 보인다 (운전 중에도)
      const ub = document.getElementById('updBtn').getBoundingClientRect(), app = document.getElementById('app').getBoundingClientRect();
      const trb = document.querySelector('.trip').getBoundingClientRect();
      r.smallBtn = vis('#updBtn') && ub.height <= 34 && ub.right > app.right - 80 && ub.bottom <= trb.top + 1 && ub.bottom > trb.top - 30; // v263: 오른쪽 아래 주행 기록 카드 바로 위
      t.openTray(); await wait(40);
      r.button = vis('#ntUpdate') && /새 버전 11\.14-99/.test(text('#ntVer'));
      t.closeTray(); await wait(220);
      // 이어서 안내
      stub.canned['/route'] = R.route;
      const W = dest(NAV_ORIGIN, 90, 300), c0 = stub.calls.length;
      t.resumeFrom({ dest: { name: '이어가기 테스트', addr: '', lat: R.dest.lat, lng: R.dest.lng }, via: [{ name: '경유', lat: W.lat, lng: W.lng }], option: 'traoptimal', t: Date.now() });
      await waitFor(() => !t.nav.busy && t.nav.active, 3000, 20);
      const calls = stub.since(c0, '/route');
      r.resumed = t.nav.active && !t.nav.preview && !vis('#routeCard') && t.nav.dest.name === '이어가기 테스트' &&
        calls.length === 1 && calls[0].query.waypoints === W.lng.toFixed(6) + ',' + W.lat.toFixed(6);
    } finally {
      t.upd.newer = prevNewer; t.renderUpdBtn();
      t.endNav();
      stub.reset();
      t.closeTray();
      softReset();
    }
    const bad = Object.keys(r).filter((k) => !r[k]);
    return { pass: bad.length === 0 && Object.keys(r).length === 4, detail: Object.keys(r).map((k) => k + (r[k] ? '✓' : '✗')).join(', ') };
  }

  // S41: 과속방지턱 (전국 과속방지턱 표준데이터, data/bumps.json). 실제 가평읍 골목 경로(test/fixtures/route-gapyeong-town.json:
  //      광장로·중앙로·가평제방길 2.5km, 경로 10m 안 방지턱 7곳)로
  //      (a) 길안내 중: 경로 위 방지턱을 200m 앞부터 '과속방지턱 120m'처럼 알리고 지도에 작은 삼각 표지
  //      (b) 길안내 없이 같은 길: 바로 앞 방지턱을 알린다  (c) 설정을 끄면 안 알린다
  async function s41() {
    const t = T();
    await waitFor(() => t.bumps.loaded, 8000, 50);
    if (!t.bumps.loaded) return { status: 'SKIP', detail: 'bumps.json not loaded' };
    const fx = await (await realFetch(harnessDir + 'fixtures/route-gapyeong-town.json', { cache: 'no-store' })).json();
    const P = fx.path.map((x) => ({ lat: x[1], lng: x[0] }));
    const cum = [0];
    for (let i = 1; i < P.length; i++) cum.push(cum[i - 1] + hav(P[i - 1], P[i]));
    const total = cum[cum.length - 1];
    const R = { route: fx, P, cum, total, dest: { name: '가평읍', addr: '', lat: P[P.length - 1].lat, lng: P[P.length - 1].lng } };
    const drive = async (withNav) => {
      softReset();
      if (withNav) await planAndStart(R); else feed(P[0], 0, null);
      const seen = new Set();
      let maxShownD = 0, markers = 0, label = '';
      for (let s = 0; s <= total - 20; s += 8) {
        const a = pointAt(R, s);
        feed(a.p, 30 / 3.6, a.h);
        const b = t.bumpState.next;
        if (b && !document.getElementById('bumpCard').hidden) {
          seen.add(b.k);
          maxShownD = Math.max(maxShownD, b.d);
          label = label || text('#bumpLabel') + ' ' + text('#bumpDist');
        }
        const m = t.getMap();
        if (m && m.bumps) markers = Math.max(markers, m.bumps.size);
      }
      if (withNav) t.endNav();
      return { alerted: seen.size, maxShownD: Math.round(maxShownD), markers, label };
    };
    // 가짜 역지오코딩('하네스로')이 진짜 방지턱 도로 이름(광장로 등)과 달라 길안내 없는 주행이 다 걸러지지 않게, 지금 도로 이름은 모름으로
    const prevRev = stub.canned['/reverse'];
    stub.canned['/reverse'] = { road: '', area: '' }; t.road.name = '';
    const nav = await drive(true), free = await drive(false);
    const prev = t.prefs.bumps;
    t.prefs.bumps = false;
    const off = await drive(true);
    t.prefs.bumps = prev;
    // (d) 경로가 꺾이는 모퉁이 옆 골목 방지턱은 안 잡는다 (2026-11-14 실제 하남 덕풍동 경로: 모퉁이에서 8.8m 떨어진 옆 골목 방지턱이
    //     '과속방지턱 170m'로 떴다). 시험 경로(북쪽 600m → 동쪽)의 모퉁이 너머 북쪽 8m 방지턱은 빼고, 곧은 길 옆 8m 방지턱은 그대로 잡는다
    // (e) 2026-11-14 다시 설계: 방지턱의 도로 이름이 경로 구간 이름(시험 경로: 북쪽 '테스트로', 동쪽 '율곡로')과 다르면 옆 골목 것이라 뺀다.
    //     이름이 같으면 12m 까지 잡는다. 고속도로 구간(안내상 진입~출구)이면 이름이 같아도 일반도로 방지턱은 안 잡는다
    const keep = { n: t.bumps.n, lat: t.bumps.lat, lng: t.bumps.lng, flag: t.bumps.flag, road: t.bumps.road, names: t.bumps.names, grid: t.bumps.grid };
    let corner = null, named = null, highway = null;
    try {
      const nb = (m) => dest(NAV_ORIGIN, 0, m);
      const bp = [[dest(nb(600), 0, 8), 0], [dest(nb(300), 90, 8), 0], [dest(nb(200), 90, 4), 2], [dest(nb(400), 90, 11), 1]];
      const grid = new Map();
      bp.forEach(([p], k) => { const key = Math.floor(p.lat * 100) + ':' + Math.floor(p.lng * 100); if (!grid.has(key)) grid.set(key, []); grid.get(key).push(k); });
      Object.assign(t.bumps, { n: bp.length, lat: Float64Array.from(bp.map((x) => x[0].lat)), lng: Float64Array.from(bp.map((x) => x[0].lng)),
        flag: new Uint8Array(bp.length), road: Int32Array.from(bp.map((x) => x[1])), names: ['', '테스트로', '옆골목길'], grid });
      const drive1 = async (R) => {
        softReset();
        await planAndStart(R);
        feed(pointAt(R, 20).p, 10, 0);
        const v = (t.nav.routeBumps || []).map((x) => x.k + '@' + Math.round(x.at)).join(',');
        t.endNav();
        return v;
      };
      named = await drive1(buildNavRoute());   // 0 모퉁이 옆 골목(이름 모름) 빠짐 · 1 이름 모름 곧은 길 8m 잡음 · 2 '옆골목길' 4m 빠짐 · 3 '테스트로' 11m 잡음
      corner = named;
      const RH = buildNavRoute();
      RH.route = JSON.parse(JSON.stringify(RH.route));
      RH.route.guide = [{ i: 1, t: 66, s: '테스트IC에서 고속도로 진입', d: r0(RH.cum[1]), ms: 10000 }, { i: 8, t: 67, s: '시험IC에서 고속도로 출구', d: r0(RH.cum[8] - RH.cum[1]), ms: 60000 },
        { i: 9, t: 88, s: '목적지', d: r0(RH.cum[9] - RH.cum[8]), ms: 10000 }];
      highway = await drive1(RH);              // 고속도로 구간 안이라 하나도 안 잡음
    } finally {
      Object.assign(t.bumps, keep);
      stub.canned['/reverse'] = prevRev;
    }
    softReset();
    const mapOk = !t.getMap() || nav.markers >= 1;
    const ok = nav.alerted >= 5 && nav.maxShownD <= 200 && mapOk && /과속방지턱 \d+m/.test(nav.label) && free.alerted >= 3 && off.alerted === 0 && named === '1@300,3@400' && highway === '';
    return {
      pass: ok,
      detail: 'with nav: ' + JSON.stringify(nav) + ' | no nav: ' + JSON.stringify(free) + ' | setting off: ' + JSON.stringify(off) + ' | names/corner: ' + named + ' | on highway: ' + JSON.stringify(highway) + (ok ? '✓' : '✗'),
    };
  }

  // S42: 그다음 칸 (2026-11-14 요청). 이번 회전을 하고 나서 무엇이 얼마 뒤에 오는지 (거리는 이번 안내 지점 → 그다음 안내 지점).
  //      그다음이 회전이면 네이버 지도처럼 그 회전 아이콘 + '360m'만, 목적지면 연한 빨강 바탕에 빨간 핀 + '480m' ('도착' 글자 없이), 마지막 안내면 숨김
  async function s42() {
    const t = T(), R = buildNavRoute();
    softReset();
    await planAndStart(R);
    const snap = () => { const nn = document.getElementById('nextTurn');
      return { shown: !nn.hidden && nn.getClientRects().length > 0, text: text('#nextDist'), rightIcon: !!nn.querySelector('#nextIcon svg.ti-r') || /h14M31 8l8 8-8 8/.test((nn.querySelector('#nextIcon path') || {}).getAttribute?.('d') || ''),
        goal: nn.classList.contains('goal'), pin: !!nn.querySelector('svg.pin'), tag: !!nn.querySelector('.arrive-tag') }; };
    const go = (s) => { const a = pointAt(R, s); feed(a.p, 10, a.h); t.renderNav(); };
    go(15);
    const atStart = snap();                 // 이번: 직진(240m) → 360m 뒤 우회전 (우회전 아이콘 + 360m)
    for (let s = 30; s <= 300; s += 15) go(s);
    const beforeTurn = snap();              // 이번: 우회전 → 우회전하고 480m 뒤 도착 (빨간 핀, 글자 없음)
    for (let s = 315; s <= 640; s += 15) go(s);
    const afterTurn = snap();               // 이번: 목적지 → 그다음 없음
    t.endNav();
    softReset();
    const ok = atStart.shown && atStart.text === '360m' && atStart.rightIcon && !atStart.goal &&
      beforeTurn.shown && beforeTurn.goal && beforeTurn.pin && !beforeTurn.tag && beforeTurn.text === '480m' && !afterTurn.shown;
    return { pass: ok, detail: 'start ' + JSON.stringify(atStart) + ' | before the right turn ' + JSON.stringify(beforeTurn) + ' | after ' + JSON.stringify(afterTurn) + (ok ? '✓' : '✗') };
  }

  // S43: 반대편 과속 카메라 (2026-11-14 주행 제보: 양서면 북한강로 '골용진 입구(용늪삼거리→양평수난구조대)' J2675, 제한 60).
  //      원본 방향 코드는 '양방향'인데 설치장소에 방향(→)이 적힌 과속 전용 카메라라 한 방향으로 본다.
  //      실제 경로(test/fixtures/route-yangseo-bukhangang-s|n.json)로: 남행(두물머리 쪽, 카메라가 왼쪽 9m)에서는 안 뜨고, 북행에서는 뜬다
  async function s43() {
    const t = T(), CAM = { lat: 37.5585, lng: 127.32654 };
    const run = async (file, withNav) => {
      const fx = await (await realFetch(harnessDir + 'fixtures/' + file, { cache: 'no-store' })).json();
      const P = fx.path.map((x) => ({ lat: x[1], lng: x[0] }));
      const cum = [0];
      for (let i = 1; i < P.length; i++) cum.push(cum[i - 1] + hav(P[i - 1], P[i]));
      const total = cum[cum.length - 1];
      const R = { route: fx, P, cum, total, dest: { name: '북한강로', addr: '', lat: P[P.length - 1].lat, lng: P[P.length - 1].lng } };
      softReset();
      if (withNav) await planAndStart(R); else feed(P[0], 0, null);
      let hit = false;
      for (let s = 0; s <= total - 30; s += 12) {
        const a = pointAt(R, s);
        feed(a.p, 55 / 3.6, a.h);
        const tg = t.camState.target;
        if (tg && sameCam(tg.c, CAM)) hit = true;
      }
      if (withNav) t.endNav();
      return hit;
    };
    const southNav = await run('route-yangseo-bukhangang-s.json', true), southFree = await run('route-yangseo-bukhangang-s.json', false);
    const northNav = await run('route-yangseo-bukhangang-n.json', true);
    softReset();
    const ok = !southNav && !southFree && northNav;
    return { pass: ok, detail: 'southbound (opposite) nav ' + (southNav ? 'ALERTED✗' : 'quiet✓') + ', no nav ' + (southFree ? 'ALERTED✗' : 'quiet✓') + ' | northbound nav ' + (northNav ? 'alerted✓' : 'MISSED✗') };
  }

  // S44: 터널 (2026-11-14 요청: 터널 몇 m 남았는지). 네이버 안내에는 터널이 없어 OpenStreetMap 터널 도로(data/tunnels.json)로 찾는다.
  //      가짜 터널 데이터로: 경로 북쪽 구간 200~500m 의 일방 '테스트터널'은 잡고, 반대 방향 일방 터널·가로지르는 터널은 안 잡는다.
  //      15m 지점: '테스트터널 진입 · 길이 300m' 190m 앞 / 350m 지점(안): '출구까지' + 초록 막대 /
  //      위치가 멈추면 마지막 속도로 출구까지 거리가 줄어든다 / 터널을 지나면 숨김 / 설정을 끄면 숨김
  async function s44() {
    const t = T(), R = buildNavRoute();
    const north = (m) => dest(NAV_ORIGIN, 0, m);
    const enc = (pts, nameIdx, oneway) => {
      const q = pts.map((x) => [Math.round(x.lat * 1e5), Math.round(x.lng * 1e5)]);
      const row = [nameIdx, oneway ? 1 : 0, q[0][0], q[0][1]];
      for (let k = 1; k < q.length; k++) row.push(q[k][0] - q[k - 1][0], q[k][1] - q[k - 1][1]);
      return row;
    };
    const side = (p, m) => dest(p, 90, m);
    const data = { v: 1, scale: 1e5, names: ['테스트터널', '가로터널', '반대터널'], w: [
      enc([north(200), north(350), north(500)], 0, true),                    // 잡아야 할 터널 (같은 방향 일방)
      enc([side(north(40), 3), side(north(180), 3)].reverse(), 2, true),     // 반대 방향 일방 (남쪽으로) → 안 잡음
      enc([dest(north(100), 270, 200), dest(north(100), 90, 200)], 1, false), // 가로지르는 터널 → 안 잡음
    ] };
    const prevPref = t.prefs.tunnels;
    t.setTunnelData(data);
    // v118: 지금 안내가 직진이면 터널은 안내 줄(큰 줄)에 나온다 ('테스트터널까지' / '테스트터널 출구까지' + 막대). 아니면 작은 터널 줄
    const row = () => {
      const tm = document.querySelector('#navPanel .turn.tn-main');
      if (tm && visible('#navPanel')) {
        return { shown: true, main: true, inside: /출구까지$/.test(text('#turnText')), dist: text('#turnDist'), text: text('#turnText'),
          bar: tm.style.getPropertyValue('--tnp'), icon: !!document.querySelector('#turnIcon svg.tunnel, #turnIcon img.aiimg'), small: visible('#tunnelRow') };
      }
      return { shown: visible('#tunnelRow'), inside: document.getElementById('tunnelRow').classList.contains('inside'),
        dist: text('#tunnelDist'), text: text('#tunnelText'), bar: document.getElementById('tunnelBar').style.width,
        icon: !!document.querySelector('#tunnelIcon svg.tunnel, #tunnelIcon img.aiimg') };   // 앱 그림 또는 고른 AI 그림
    };
    const go = (m, v) => { const a = pointAt(R, m); feed(a.p, v == null ? 15 : v, a.h); t.renderNav(); };
    const r = {};
    try {
      softReset();
      await planAndStart(R);
      go(15);
      r.ahead = row();
      r.found = (t.nav.routeTunnels || []).map((x) => x.name + ':' + Math.round(x.s0) + '-' + Math.round(x.s1));
      for (let m = 30; m <= 350; m += 20) go(m, 20);
      r.inside = row();
      t.prefs.tunnels = false; t.renderNav();
      r.offHidden = !visible('#tunnelRow');                  // 설정을 끄면 숨김
      t.prefs.tunnels = true; t.renderNav();
      await new Promise((res) => setTimeout(res, 2600));   // 터널 안에서 위치가 안 온다
      t.renderNav();
      r.dr = row();
      for (let m = 370; m <= 560; m += 20) go(m);
      r.after = row();
      t.endNav();
    } finally {
      t.prefs.tunnels = prevPref;
      t.setTunnelData(null);
      await t.loadTunnels();
      softReset();
    }
    const m = (s) => parseInt(s, 10) * (/km/.test(s) ? 1000 : 1);
    const ok = r.found.length === 1 && /^테스트터널:2\d\d-5\d\d$/.test(r.found[0]) &&
      r.ahead.shown && !r.ahead.inside && r.ahead.icon && /^1[89]0m$/.test(r.ahead.dist) && /^테스트터널( 입구)?까지$/.test(r.ahead.text) /* v110: 1km 안 되면 길이 없이 · v118: 안내 줄이면 '테스트터널까지' */ && !r.ahead.small &&
      r.inside.shown && r.inside.inside && r.inside.text === '테스트터널 출구까지' && m(r.inside.dist) >= 130 && m(r.inside.dist) <= 170 && parseInt(r.inside.bar, 10) >= 40 &&
      r.dr.inside && m(r.inside.dist) - m(r.dr.dist) >= 30 && !r.after.shown && r.offHidden;
    return { pass: ok, detail: JSON.stringify(r) + (ok ? '✓' : '✗') };
  }

  // S45: 하이패스도 단속 서랍 안에 (2026-11-14 요청). 테슬라 모드에서 톨게이트 1km 앞: 하이패스 카드가 서랍(.cd-in) 안에 보이고
  //      서랍이 열리며 안내 패널 바로 밑에 붙는다. 지도 위 흰 글자(그림자) 대신 패널 글자. 톨게이트를 지나면 카드가 빠지고 서랍이 접힌다
  async function s45() {
    const t = T(), box = TESLA_ONLY, prev = t.prefs.tesla;
    const set = (on) => { box.checked = on; box.dispatchEvent(new Event('change')); };
    const raw = [];
    for (let k = 0; k <= 40; k++) raw.push(dest(NAV_ORIGIN, 0, 100 * k));
    const path = raw.map((p) => [round6(p.lng), round6(p.lat)]);
    const P = path.map((x) => ({ lat: x[1], lng: x[0] }));
    const cum = [0];
    for (let i = 1; i < P.length; i++) cum.push(cum[i - 1] + hav(P[i - 1], P[i]));
    const total = cum[cum.length - 1];
    const R = {
      route: { distance: r0(total), duration: r0(total / 25 * 1000), tollFare: 800, fuelPrice: 300, path,
        guide: [{ i: 25, t: 121, s: '하남톨게이트 (통행료 800원)', d: r0(cum[25]), ms: 100000 },
                { i: 40, t: 88, s: '목적지', d: r0(total - cum[25]), ms: 60000 }],
        sections: [{ i: 0, n: 41, name: '테스트고속도로', speed: 100, cong: 1 }] },
      P, cum, total, dest: { name: '톨 테스트', addr: '', lat: P[40].lat, lng: P[40].lng },
    };
    const r = {};
    try {
      set(true);
      softReset();
      await planAndStart(R);
      for (let s = 25; s <= 1500; s += 25) { const a = pointAt(R, s); feed(a.p, 25, 0); t.renderNav(); }
      const card = document.getElementById('tollCard'), dr = document.getElementById('camDrawer');
      const np = document.getElementById('navPanel').getBoundingClientRect(), db = dr.getBoundingClientRect();
      r.shown = visible('#tollCard');
      r.inDrawer = !!card.closest('#camDrawer .cd-in');
      r.open = dr.classList.contains('open');
      r.underPanel = Math.abs(db.top - np.bottom) <= 2;
      r.noHalo = getComputedStyle(document.getElementById('tollName')).textShadow === 'none';
      r.text = text('#tollName') + ' ' + text('#tollDist') + ' ' + text('#tollFare');
      r.tollIcon = !!document.querySelector('#turnIcon svg.toll');   // 직진 화살표 대신 톨게이트 표지
      const fee = document.querySelector('#turnText .tt-fare');
      r.fareInPanel = !!fee && fee.textContent === '800원' && /하남톨게이트$/.test(text('#turnText'));   // 패널에 굵은 통행료 + 이름
      for (let s = 1525; s <= 2700; s += 25) { const a = pointAt(R, s); feed(a.p, 25, 0); t.renderNav(); }
      r.goneAfter = !visible('#tollCard') && !dr.classList.contains('open');
      t.endNav();
    } finally {
      set(prev);
      softReset();
    }
    const ok = r.shown && r.inDrawer && r.open && r.underPanel && r.noHalo && /하남톨게이트 1\.0km/.test(r.text) && r.tollIcon && r.fareInPanel && r.goneAfter;
    return { pass: ok, detail: JSON.stringify(r) + (ok ? '✓' : '✗') };
  }

  // S46: 박스형 과속 카메라 (2026-11-14 주행 제보: 남양주 와부읍 팔당리 다산로, 양평→팔당대교IC 제한 60).
  //      경찰청 원본에는 박스형이 없어 직접 넣었다 (tools/build_cams.py U0002, flags 2).
  //      실제 네이버 경로(test/fixtures/route-paldang-west|east.json)로: 북서행에서는 '박스형 과속 단속'으로 뜨고, 남동행(반대편)에서는 안 뜬다
  async function s46() {
    const t = T(), CAM = { lat: 37.53968, lng: 127.25632 };
    const run = async (file) => {
      const fx = await (await realFetch(harnessDir + 'fixtures/' + file, { cache: 'no-store' })).json();
      const P = fx.path.map((x) => ({ lat: x[1], lng: x[0] }));
      const cum = [0];
      for (let i = 1; i < P.length; i++) cum.push(cum[i - 1] + hav(P[i - 1], P[i]));
      const total = cum[cum.length - 1];
      const R = { route: fx, P, cum, total, dest: { name: '팔당', addr: '', lat: P[P.length - 1].lat, lng: P[P.length - 1].lng } };
      softReset();
      await planAndStart(R);
      let hit = null;
      for (let s = 0; s <= total - 30; s += 12) {
        const a = pointAt(R, s);
        feed(a.p, 55 / 3.6, a.h);
        const tg = t.camState.target;
        if (!hit && tg && sameCam(tg.c, CAM)) hit = { label: text('#camType'), box: document.getElementById('camCard').classList.contains('box'), dist: text('#camDist') };
      }
      t.endNav();
      return hit;
    };
    const west = await run('route-paldang-west.json'), east = await run('route-paldang-east.json');
    softReset();
    const ok = !!west && west.label === '박스형 과속단속' && west.box && !east;
    return { pass: ok, detail: 'northwest (toward 팔당대교IC) ' + JSON.stringify(west) + ' | southeast (opposite) ' + (east ? 'ALERTED✗' : 'quiet✓') + (ok ? '✓' : '✗') };
  }

  // S47: 설치장소 방향 'A→B'로 한 방향 카메라 가르기 (2026-11-14 주행 제보: 팔당대교IC → 하남IC 로 가는데
  //      창우로 J2735 '창우지하차도 지나 250m(하남ic->팔당대교)' 60 이 떴다. 좌표가 경로선 위(0.7m)라 좌우로 못 가름).
  //      실제 경로로: 남행(route-paldang-hanamic-s: 지나온 안내 '팔당대교IC…', 갈 안내 '하남IC…')에서는 J2735 안 뜨고
  //      같은 길의 J0452 '(팔당대교→하남IC)' 50(사진의 과속단속장비)은 뜬다. 북행(route-hanam-paldang-n)에서는 J2735 가 뜬다
  async function s47() {
    const t = T(), J2735 = { lat: 37.5407, lng: 127.23101 }, J0452 = { lat: 37.53469, lng: 127.22648 };
    const run = async (file, upto) => {
      const fx = await (await realFetch(harnessDir + 'fixtures/' + file, { cache: 'no-store' })).json();
      const P = fx.path.map((x) => ({ lat: x[1], lng: x[0] }));
      const cum = [0];
      for (let i = 1; i < P.length; i++) cum.push(cum[i - 1] + hav(P[i - 1], P[i]));
      const total = Math.min(cum[cum.length - 1], upto || 1e9);
      const R = { route: fx, P, cum, total: cum[cum.length - 1], dest: { name: '하남', addr: '', lat: P[P.length - 1].lat, lng: P[P.length - 1].lng } };
      softReset();
      await planAndStart(R);
      const hit = { J2735: false, J0452: false };
      for (let s = 0; s <= total - 30; s += 12) {
        const a = pointAt(R, s);
        feed(a.p, 50 / 3.6, a.h);
        const tg = t.camState.target;
        if (tg && sameCam(tg.c, J2735)) hit.J2735 = true;
        if (tg && sameCam(tg.c, J0452)) hit.J0452 = true;
      }
      t.endNav();
      return hit;
    };
    const south = await run('route-paldang-hanamic-s.json', 5000), north = await run('route-hanam-paldang-n.json');
    softReset();
    const ok = !south.J2735 && south.J0452 && north.J2735;
    return { pass: ok, detail: '팔당대교IC→하남IC: J2735(하남ic->팔당대교) ' + (south.J2735 ? 'ALERTED✗' : 'quiet✓') + ', J0452(팔당대교→하남IC) ' + (south.J0452 ? 'alerted✓' : 'MISSED✗') +
      ' | 하남→팔당대교: J2735 ' + (north.J2735 ? 'alerted✓' : 'MISSED✗') };
  }

  // S48: 분기점 그림 (2026-11-14 요청). 고속도로 진입(66: 오른쪽)과 분기점(4: 왼쪽 방향)이 있는 경로로, 테슬라 모드에서
  //      안내 지점 600m 앞부터(v248, 예전 800m) 서랍 맨 위에 그림: 진입로는 'ramp'·오른쪽, 방면 '서울 · 대전', 지점 '하남IC'.
  //      분기점은 'fork'·왼쪽, 방면은 짧은 이름 '대전 · 호법'. 900m 앞·지난 뒤에는 없음
  async function s48() {
    const t = T(), box = TESLA_ONLY, prev = t.prefs.tesla;
    const set = (on) => { box.checked = on; box.dispatchEvent(new Event('change')); };
    const raw = [];
    for (let k = 0; k <= 30; k++) raw.push(dest(NAV_ORIGIN, 0, 100 * k));
    const path = raw.map((p) => [round6(p.lng), round6(p.lat)]);
    const P = path.map((x) => ({ lat: x[1], lng: x[0] }));
    const cum = [0];
    for (let i = 1; i < P.length; i++) cum.push(cum[i - 1] + hav(P[i - 1], P[i]));
    const total = cum[cum.length - 1];
    const R = {
      route: { distance: r0(total), duration: r0(total / 20 * 1000), tollFare: 0, fuelPrice: 300, path,
        guide: [{ i: 12, t: 66, s: "하남IC에서 '서울, 대전' 방면으로 오른쪽 고속도로 진입", d: r0(cum[12]), ms: 60000 },
                { i: 20, t: 4, s: "하남분기점에서 '중부고속도로, 대전, 호법' 방면으로 왼쪽 방향", d: r0(cum[20] - cum[12]), ms: 40000 },
                { i: 30, t: 88, s: '목적지', d: r0(total - cum[20]), ms: 50000 }],
        sections: [{ i: 0, n: 21, name: '수도권제1순환고속도로', speed: 60, cong: 1 }, { i: 20, n: 11, name: '중부고속도로', speed: 60, cong: 1 }] },
      P, cum, total, dest: { name: '분기 테스트', addr: '', lat: P[30].lat, lng: P[30].lng },
    };
    const snap = () => { const el = document.getElementById('juncCard');
      return { shown: visible('#juncCard'), kind: (el.querySelector('#juncSvg .jc-entry') ? 'entry' : el.querySelector('#juncSvg .jc-ramp') ? 'ramp' : 'fork'), left: el.classList.contains('left'),
        hwy: el.classList.contains('hwy'), label: document.getElementById('juncLabel').dataset.names || '', sign: text('#juncLabel'), place: text('#juncPlace'), dist: document.getElementById('juncDist') ? text('#juncDist') : '',
        inDrawer: !!el.closest('#camDrawer .cd-in'), open: document.getElementById('camDrawer').classList.contains('open') }; };
    const go = (s) => { const a = pointAt(R, s); feed(a.p, 20, a.h); t.renderNav(); };
    const r = {};
    const unstash = stashJx();   // v250: 예전 AI 그림(junc_<종류>)의 종류·좌우를 본다 (jx 는 S162·S166)
    try {
      set(true);
      softReset();
      await planAndStart(R);
      for (let s = 20; s <= 300; s += 20) go(s);
      r.far = snap();                                   // 하남IC 900m 앞
      for (let s = 320; s <= 620; s += 20) go(s);
      r.ramp = snap();                                  // 하남IC 580m 앞 (v248: 600m 앞부터)
      for (let s = 640; s <= 1300; s += 20) go(s);
      r.fork700 = snap();                               // 하남분기점 700m 앞: v248 부터 아직 없음 (600m 앞부터, 네이버처럼)
      for (let s = 1320; s <= 1420; s += 20) go(s);
      r.fork = snap();                                  // 하남분기점 580m 앞
      for (let s = 1440; s <= 2100; s += 20) go(s);
      r.after = snap();                                 // 분기점 지난 뒤 (그다음은 목적지)
      t.endNav();
    } finally {
      unstash();
      set(prev);
      softReset();
    }
    const ok = !r.far.shown && r.ramp.shown && r.ramp.kind === 'ramp' /* v110: 하남IC '오른쪽 고속도로 진입'은 오른쪽으로 갈라져 들어가는 그림 */ && !r.ramp.left && r.ramp.hwy && r.ramp.label === '서울 · 대전' &&
      r.ramp.place === '하남IC' && r.ramp.dist === '' && r.ramp.inDrawer && r.ramp.open &&
      !r.fork700.shown && r.fork.shown && r.fork.kind === 'fork' && r.fork.left && r.fork.label === '대전 · 호법' && r.fork.place === '하남분기점' && !r.after.shown;
    return { pass: ok, detail: JSON.stringify(r) + (ok ? '✓' : '✗') };
  }

  // S49: 업데이트해도 주행 거리·시간·최고 속도가 이어진다 (2026-11-14 요청). 저장 → 0 으로 → 되살리기.
  //      새 버전으로 옮겨 온 것(tnc.updTried == 지금 버전)이면 2시간 전 기록도 되살리고, 그냥 새로고침이면 30분 넘은 것은 버린다
  async function s49() {
    const t = T(), st = t.state, keep = { trip: st.trip, driveMs: st.driveMs, maxKmh: st.maxKmh, odo: st.odo };
    let prevTried = null;
    try { prevTried = sessionStorage.getItem('tnc.updTried'); } catch (e) { /* */ }
    const zero = () => { st.trip = 0; st.driveMs = 0; st.maxKmh = 0; };
    const r = {};
    try {
      Object.assign(st, { trip: 12345, driveMs: 1800000, maxKmh: 97 });
      t.saveTripNow(true);
      zero(); sessionStorage.removeItem('tnc.updTried');
      r.fresh = t.restoreTripNow() && st.trip === 12345 && st.driveMs === 1800000 && st.maxKmh === 97;
      // 2시간 전 저장
      const raw = JSON.parse(localStorage.getItem(Object.keys(localStorage).find((k) => /tripNow$/.test(k))));
      raw.at = Date.now() - 2 * 3600000;
      localStorage.setItem(Object.keys(localStorage).find((k) => /tripNow$/.test(k)), JSON.stringify(raw));
      zero();
      r.oldReloadIgnored = !t.restoreTripNow() && st.trip === 0;
      sessionStorage.setItem('tnc.updTried', t.version);
      r.oldUpdateKept = t.restoreTripNow() && st.trip === 12345;
    } finally {
      Object.assign(st, keep);
      t.saveTripNow(true);
      try { if (prevTried === null) sessionStorage.removeItem('tnc.updTried'); else sessionStorage.setItem('tnc.updTried', prevTried); } catch (e) { /* */ }
    }
    const ok = r.fresh && r.oldReloadIgnored && r.oldUpdateKept;
    return { pass: ok, detail: JSON.stringify(r) + (ok ? '✓' : '✗') };
  }

  // S50: 교통 색 다섯 단계 (2026-11-14 요청: 빨강을 여러 단계로). 구간 혼잡도 + 평균 속도로
  //      원활 초록 / 서행 노랑 / 지체 주황 / 정체 빨강 / 심한 정체 검붉은색. 지도 경로선 조각에 다섯 색이 다 그려진다
  async function s50() {
    const t = T(), R = buildNavRoute();
    R.route.sections = [
      { i: 0, n: 3, name: '테스트로', speed: 45, cong: 1 },
      { i: 2, n: 2, name: '테스트로', speed: 25, cong: 2 },
      { i: 3, n: 2, name: '테스트로', speed: 18, cong: 2 },
      { i: 4, n: 3, name: '테스트로', speed: 12, cong: 3 },
      { i: 6, n: 4, name: '테스트로', speed: 5, cong: 3 },
    ];
    const hw = (cong, speed) => t.trafficColor({ name: '중부고속도로', cong, speed });
    // 색은 네이버 GL 지도의 교통 선 색 (낮/밤 팔레트, 2026-11-14): 다섯 단계가 서로 달라야 한다
    const P = t.trafficPal();
    const hwOk = hw(2, 60) === P[2] && hw(2, 45) === P.lag && hw(3, 30) === P[3] && hw(3, 12) === P.stop &&
      new Set([P[1], P[2], P.lag, P[3], P.stop]).size === 5;
    await waitFor(() => t.getMap(), 10000, 100);   // 지도가 뜬 뒤 (따로 돌릴 때)
    softReset();
    await planAndStart(R);
    feed(pointAt(R, 15).p, 15, 0);
    t.renderNav();
    const m = t.getMap(), got = new Set();
    (m.route || []).forEach((pc) => { if (pc.kind === 'traffic') got.add(String(pc.color).toLowerCase()); });
    t.endNav(); softReset();
    // v242: 원활(초록)은 지도의 교통 선과 같은 색이라 경로선은 바탕 파랑 그대로 — 서행·지체·정체·심한 정체 네 색만 칠한다
    const want = [P[2], P.lag, P[3], P.stop];
    const ok = hwOk && want.every((c) => got.has(c)) && !got.has(P[1]) && t.trafficColor({ name: '테스트로', cong: 1, speed: 45 }) === P[1];   // (진행 막대는 원활도 초록)
    return { pass: ok, detail: 'line colors ' + [...got].join(' ') + ' | highway thresholds ' + (hwOk ? '✓' : '✗') + (ok ? '✓' : '✗') };
  }

  // S51: 설치장소에 '구간 시점/종점'만 적히고 구간 구분이 빈 카메라도 구간단속으로 (2026-11-14 점검: 울산 아산로 등 29대)
  async function s51() {
    const t = T();
    await waitFor(() => t.cams.loaded, 8000, 50);
    const find = (lat, lng) => t.cams.rows.find((c) => Math.abs(c[0] - lat) < 2e-4 && Math.abs(c[1] - lng) < 2e-4 && c[4]);
    const start = find(35.54796, 129.3602), end = find(35.52517, 129.39049), sj = find(36.72913, 127.16565);
    const ok = !!start && start[4] === 1 && start[3] === 9 && !!end && end[4] === 2 && !!sj && sj[4] === 1;
    return { pass: ok, detail: '아산로 시점 ' + JSON.stringify(start) + ' 종점 ' + JSON.stringify(end) + ' | 세종로 시점 ' + JSON.stringify(sj) + (ok ? '✓' : '✗') };
  }

  // S52: 고속도로 위에서 아래·옆 일반도로 카메라 빼기 (2026-11-14 주행: 수도권제1순환고속도로 송파 거여동에서
  //      바로 밑 문정로 어린이보호구역 30 이 떴다). 실제 경로(route-paldang-hanamic-s)에서 그 구간 이름(sections)을 빼도
  //      안내의 고속도로 진입(하남IC)~출구(성남IC) 사이라 고속도로로 보고 문정로 30 은 안 뜨고, 고속도로 카메라(100)는 뜬다
  async function s52() {
    const t = T(), SCHOOL = { lat: 37.49759, lng: 127.14063 }, HWY = { lat: 37.46302, lng: 127.12536 };
    const fx0 = await (await realFetch(harnessDir + 'fixtures/route-paldang-hanamic-s.json', { cache: 'no-store' })).json();
    const run = async (dropName) => {
      const fx = JSON.parse(JSON.stringify(fx0));
      if (dropName) fx.sections = fx.sections.filter((x) => !/수도권제1순환/.test(x.name));
      const P = fx.path.map((x) => ({ lat: x[1], lng: x[0] }));
      const cum = [0];
      for (let i = 1; i < P.length; i++) cum.push(cum[i - 1] + hav(P[i - 1], P[i]));
      const R = { route: fx, P, cum, total: cum[cum.length - 1], dest: { name: '성남', addr: '', lat: P[P.length - 1].lat, lng: P[P.length - 1].lng } };
      softReset();
      await planAndStart(R);
      const hit = { school: false, hwy: false };
      for (let s = 8000; s <= 19000; s += 15) {
        const a = pointAt(R, s);
        feed(a.p, 80 / 3.6, a.h);
        const tg = t.camState.target;
        if (tg && sameCam(tg.c, SCHOOL)) hit.school = true;
        if (tg && sameCam(tg.c, HWY)) hit.hwy = true;
      }
      const spans = t.highwaySpans().map((x) => x.map(Math.round));
      t.endNav();
      return Object.assign(hit, { spans });
    };
    const named = await run(false), unnamed = await run(true);
    softReset();
    const ok = !named.school && named.hwy && !unnamed.school && unnamed.hwy;
    return { pass: ok, detail: 'with section name ' + JSON.stringify(named) + ' | without ' + JSON.stringify(unnamed) + (ok ? '✓' : '✗') };
  }

  // S53: 하이패스 차로 번호 (2026-11-14 요청: 같은 거리는 빼고 '몇 번으로 가야 하이패스'). 한국도로공사 '영업소별 하이패스차로 운영현황'
  //      (data/hipass.json)으로: (a) 하남IC 고속도로 진입 뒤의 폐쇄식 톨게이트 → 입구 차로 줄 5칸 중 1·2·5번이 파랑. 톨게이트가 패널의 다음 안내나
  //      그다음 칸에 나오면 하이패스 칸의 거리는 숨기고, 그보다 멀면 보인다  (b) 자료에 없는 영업소면 번호 없이 그대로
  //      (c) 개방식(상행·하행) 수도권 영업소: 서울 쪽으로 가면 상행 차로, 반대면 하행 차로  (d) 방향을 모르면 양쪽 다 하이패스인 차로만
  //      (e) 실제 자료: 하남 상행 2번·하행 1번, 군자 입구 1~3번  (f) 실제 팔당→하남IC 경로의 하남톨게이트 → 5칸 중 2번만 파랑
  async function s53() {
    const t = T(), box = TESLA_ONLY, prev = t.prefs.tesla;
    const set = (on) => { box.checked = on; box.dispatchEvent(new Event('change')); };
    const mkRoute = (brgDeg, guides) => {
      const raw = [];
      for (let k = 0; k <= 40; k++) raw.push(dest(NAV_ORIGIN, brgDeg, 100 * k));
      const path = raw.map((p) => [round6(p.lng), round6(p.lat)]);
      const P = path.map((x) => ({ lat: x[1], lng: x[0] }));
      const cum = [0];
      for (let i = 1; i < P.length; i++) cum.push(cum[i - 1] + hav(P[i - 1], P[i]));
      const total = cum[cum.length - 1];
      const guide = guides.map((x, k) => ({ ...x, d: r0(cum[x.i] - (k ? cum[guides[k - 1].i] : 0)), ms: 20000 }));
      return {
        route: { distance: r0(total), duration: r0(total / 25 * 1000), tollFare: 800, fuelPrice: 300, path, guide,
          sections: [{ i: 0, n: 41, name: '테스트로', speed: 60, cong: 1 }] },
        P, cum, total, dest: { name: '하이패스 테스트', addr: '', lat: P[40].lat, lng: P[40].lng },
      };
    };
    const straight = { i: 15, t: 1, s: '직진' };
    const enter = { i: 20, t: 66, s: "하남IC에서 '서울, 대전' 방면으로 오른쪽 고속도로 진입" };
    const end = { i: 40, t: 88, s: '목적지' };
    const toll = (name) => ({ i: 25, t: 121, s: name + '톨게이트 (통행료 800원)' });
    // lanes: '하이패스 번호/그린 차로 수' (차로 줄이면 전체 차로 수, 방향을 몰라 번호만이면 0)
    const laneInfo = () => { const e = document.getElementById('tollLanes'); return e.dataset.hp + '/' + e.dataset.n; };
    const snap = () => ({ card: visible('#tollCard'), lanes: visible('#tollLanes') ? laneInfo() : '', dist: visible('#tollDist') ? text('#tollDist') : '',
      boxes: document.querySelectorAll('#tollLanes .ln').length, blue: document.querySelectorAll('#tollLanes .ln.hp').length });
    const drive = async (R, upto) => {
      await planAndStart(R);
      for (let s = 25; s <= upto; s += 25) { const a = pointAt(R, s); feed(a.p, 25, brg(R.P[0], R.P[40])); t.renderNav(); }
      await new Promise((res) => setTimeout(res, 30)); t.renderNav();
      return snap();
    };
    const data = { v: 2, date: '2026-06-30', o: {
      시험폐쇄: { i: 'HHTxH', x: 'TTPH' },
      시험개방: { t: 1, s: 1, u: 'xHT', d: 'HTT' },
      시험지방: { t: 1, u: 'HTH', d: 'HHT' },
      시험입구: { i: 'HT', x: 'TH' },
      서울: { i: 'MMMMxxxxhtttb', x: 'MMMMxxxxTPPxxHHHxTT' },   // 실제 자료 그대로 (2026-06-30)
      '남양주(본)': { i: 'MMxx', x: 'MMxxH' },
    } };
    const real = { loaded: t.hipass.loaded, count: Object.keys(t.hipass.o).length, 하남: t.hipass.o['하남'], 군자입구: t.laneNums((t.hipass.o['군자'] || {}).i) };
    // v135 네이버 지도처럼: 하이패스 차로만 번호 칸, 그 사이 다른 차로들은 몇 개든 '–' 칸 하나. [n] = 파란 칸
    const strip = (code, max) => t.laneStripHtml(code, max).html.replace(/<b class="ln (\w+)">([^<]+)<\/b>/g, (m0, k, n) => (k === 'hp' ? '[' + n + ']' : n) + ' ').trim();
    const ds = (t.hipass.o['동서울'] || {}).i;
    real.동서울옆 = strip(ds, 7); real.동서울줄 = strip(ds, 10);
    // v98 부터 톨게이트 이름에 괄호가 남는다 ('남산1호터널톨게이트(도심)'). 영업소 이름 찾기는 끝 괄호를 떼고 본다
    real.keys = ['하남톨게이트', '하남 톨게이트(서울방향)', '시흥TG(개방식)', '남산1호터널톨게이트(도심)'].map(t.hipassKey).join(',');
    const r = {};
    try {
      set(true);
      t.setHipassData(data);
      // 서울은 시험 출발점(강원 동쪽)에서 서남서(약 250°) 쪽
      softReset();
      const north = mkRoute(0, [straight, enter, toll('시험폐쇄'), end]);
      await planAndStart(north);
      for (let s = 25; s <= 700; s += 25) { const a = pointAt(north, s); feed(a.p, 25, 0); t.renderNav(); }
      await new Promise((res) => setTimeout(res, 30)); t.renderNav();
      r.far = snap();                               // 톨게이트가 패널에 아직 없음 (다음 직진, 그다음 진입) → 거리 보임
      for (let s = 725; s <= 1700; s += 25) { const a = pointAt(north, s); feed(a.p, 25, 0); t.renderNav(); }
      await new Promise((res) => setTimeout(res, 30)); t.renderNav();
      r.beforeEntry = snap();                       // 다음 안내는 하남IC 진입, 톨게이트는 그다음 칸 ('TG 500m') → 거리 숨김
      for (let s = 1725; s <= 2200; s += 25) { const a = pointAt(north, s); feed(a.p, 25, 0); t.renderNav(); }
      r.tollNext = snap();                          // 다음 안내가 톨게이트 → 거리 숨김
      t.endNav(); softReset();
      r.unknown = await drive(mkRoute(0, [enter, toll('없는곳'), end]), 2200);          // 자료에 없는 영업소
      t.endNav(); softReset();
      r.toSeoul = await drive(mkRoute(250, [toll('시험개방'), end]), 2200);            // 서울 쪽 → 상행 2번
      t.endNav(); softReset();
      r.fromSeoul = await drive(mkRoute(70, [toll('시험개방'), end]), 2200);           // 반대 → 하행 1번
      t.endNav(); softReset();
      r.sideways = await drive(mkRoute(160, [toll('시험개방'), end]), 2200);           // 옆으로 → 양쪽 공통 없음 → 번호 없음
      t.endNav(); softReset();
      r.ruleOff = await drive(mkRoute(250, [toll('시험지방'), end]), 2200);            // 방향 규칙 없는 곳 → 양쪽 공통 1번만
      t.endNav(); softReset();
      // (g) v134 본선 영업소 (2026-11-16 제보: 경부 북행 서울TG 하이패스가 4개만): 서울 쪽이면 출구 줄 1~4·14~16 (바로 앞 IC 진입 안내가
      //     있어도), 반대면 입구 줄 1~4. 네이버 '남양주톨게이트' → 자료 '남양주(본)'. 진입 → 다른 폐쇄식 톨게이트(입구)를 지난 뒤 톨게이트는 출구
      r.mainToSeoul = await drive(mkRoute(250, [enter, toll('서울'), end]), 2200);
      t.endNav(); softReset();
      r.mainFromSeoul = await drive(mkRoute(70, [toll('서울'), end]), 2200);
      t.endNav(); softReset();
      r.mainBon = await drive(mkRoute(250, [toll('남양주'), end]), 2200);
      t.endNav(); softReset();
      r.afterEntryTg = await drive(mkRoute(0, [enter, { i: 25, t: 121, s: '시험입구톨게이트 (통행료 800원)' }, { i: 32, t: 121, s: '시험폐쇄톨게이트 (통행료 800원)' }, end]), 2800);
      t.endNav();
      // (f) 실제 경로·실제 자료 (2026-11-14 실제 앱 흉내 주행에서 번호가 안 나왔던 곳): 팔당→하남IC→중부고속도로(서울 쪽) 하남톨게이트 = 상행 2번
      t.setHipassData(null); await t.loadHipass();
      softReset();
      const fx = await (await realFetch(harnessDir + 'fixtures/route-paldang-hanamic-s.json', { cache: 'no-store' })).json();
      const FP = fx.path.map((x) => ({ lat: x[1], lng: x[0] }));
      const fc = [0];
      for (let k = 1; k < FP.length; k++) fc.push(fc[k - 1] + hav(FP[k - 1], FP[k]));
      const RR = { route: fx, P: FP, cum: fc, total: fc[fc.length - 1], dest: { name: '성남시청', addr: '', lat: FP[FP.length - 1].lat, lng: FP[FP.length - 1].lng } };
      await planAndStart(RR);
      for (let m = 25; m <= fc[110] - 900; m += 25) { const a = pointAt(RR, m); feed(a.p, 25, a.h); t.renderNav(); }
      await new Promise((res) => setTimeout(res, 30)); t.renderNav();
      r.realHanam = snap();
      t.endNav();
      // (h) v134 실제 경로 (2026-11-16 제보 상황): 경부 북행 위에서 시작한 경로(재탐색)는 첫 안내가 '서울톨게이트'이고 앞에 진입 안내도
      //     앞선 톨게이트도 없다 → 본선 영업소 규칙으로 출구 줄 1~4·14~16 (전에는 방향을 몰라 공통 1~4번만). 성남톨게이트 조금 뒤까지만 자른 경로
      softReset();
      const sx = await (await realFetch(harnessDir + 'fixtures/route-seoultg-n.json', { cache: 'no-store' })).json();
      const SP = sx.path.map((x) => ({ lat: x[1], lng: x[0] }));
      const sc = [0];
      for (let k = 1; k < SP.length; k++) sc.push(sc[k - 1] + hav(SP[k - 1], SP[k]));
      const SR = { route: sx, P: SP, cum: sc, total: sc[sc.length - 1], dest: { name: '판교분기점', addr: '', lat: SP[SP.length - 1].lat, lng: SP[SP.length - 1].lng } };
      await planAndStart(SR);
      for (let m = 25; m <= sc[19] - 600; m += 25) { const a = pointAt(SR, m); feed(a.p, 25, a.h); t.renderNav(); }
      await new Promise((res) => setTimeout(res, 30)); t.renderNav();
      r.realSeoulTg = snap();
      // (i) v135 같은 경로를 이어 판교분기점 → 수도권제1순환(구리 쪽) 성남톨게이트: 반시계 방향이라 상행 줄 = 네이버와 같은
      //     1 2 3 – 8 9 – 11 – (11 = 화물차-하이패스). 2026-11-16 제보: 앱은 상행·하행 공통인 1~3번만 보여 줬다
      for (let m = sc[19] - 575; m <= sc[127] - 600; m += 25) { const a = pointAt(SR, m); feed(a.p, 25, a.h); t.renderNav(); }
      await new Promise((res) => setTimeout(res, 30)); t.renderNav();
      r.realSeongnamTg = snap();
      r.realSeongnamStrip = [...document.querySelectorAll('#tollLanes .ln')].map((e) => (e.classList.contains('hp') ? e.textContent : '–')).join(' ');
      t.endNav();
    } finally {
      t.setHipassData(null);
      await t.loadHipass();
      set(prev);
      softReset();
    }
    const ok = r.far.card && /km|m$/.test(r.far.dist) && r.far.lanes === '1,2,5/5' && r.far.boxes === 4 && r.far.blue === 3 &&
      r.beforeEntry.card && r.beforeEntry.lanes === '1,2,5/5' && r.beforeEntry.dist === '' &&
      r.tollNext.card && r.tollNext.lanes === '1,2,5/5' && r.tollNext.dist === '' &&
      r.unknown.card && r.unknown.lanes === '' &&
      r.toSeoul.lanes === '2/3' && r.fromSeoul.lanes === '1/3' && r.sideways.card && r.sideways.lanes === '' && r.ruleOff.lanes === '1/0' &&
      r.realHanam.card && r.realHanam.lanes === '2/5' && r.realHanam.boxes === 3 && r.realHanam.blue === 1 &&
      real.loaded && real.count > 400 && real.하남 && real.하남.u === 'bHPTb' && real.하남.d === 'HPTb' && real.하남.s === 1 && real.군자입구.join(',') === '1,2,3,11' &&
      real.동서울옆 === '[1] [2] [3] [4] – [22] [23] –' && real.동서울줄 === real.동서울옆 &&
      real.keys === '하남,하남,시흥,남산1호터널' &&
      r.mainToSeoul.lanes === '1,2,3,4,14,15,16/19' && r.mainToSeoul.blue === 7 && r.mainToSeoul.boxes === 9 && r.mainFromSeoul.lanes === '1,2,3,4,9/13' &&
      r.realSeongnamTg.card && r.realSeongnamTg.lanes === '1,2,3,8,9,11/13' && r.realSeongnamStrip === '1 2 3 – 8 9 – 11 –' &&
      r.mainBon.lanes === '1,2,5/5' && r.afterEntryTg.lanes === '4/4' &&
      r.realSeoulTg.card && r.realSeoulTg.lanes === '1,2,3,4,14,15,16/19' && r.realSeoulTg.blue === 7;
    return { pass: ok, detail: JSON.stringify(r) + ' | real: ' + JSON.stringify(real) + (ok ? '✓' : '✗') };
  }

  // S54: 비켜 가기·나가기/들어가기 표지 (2026-11-14 요청: '신갈분기점에서 대전 방면으로 왼쪽 도로 주행'이 좌회전 화살표로 나왔다.
  //      좌회전이 아니라 왼쪽 길로 붙어 계속 가는 것). 왼쪽/오른쪽 방향·도로 주행은 비켜 가는 화살표, 고속도로 출구는 OUT, 진입은 IN.
  //      진짜 좌·우회전은 그대로. 길안내 패널에 실제로 그 그림이 그려진다
  async function s54() {
    const t = T(), k = (tt, s) => t.turnKind({ t: tt, s: s || '' });
    const map = {
      keepLeft41: k(41, "신갈분기점에서 '대전' 방면으로 왼쪽 도로 주행") === 'kl', keepLeft4: k(4, "'서울' 방면으로 왼쪽 방향") === 'kl',
      keepRight5: k(5, "팔당대교IC에서 '광주, 하남' 방면으로 오른쪽 방향") === 'kr', keepRight42: k(42) === 'kr',
      exitRight67: k(67, "성남IC에서 '성남, 광주' 방면으로 오른쪽 고속도로 출구") === 'outr', exitLeft58: k(58) === 'outl',
      entryRight66: k(66, "하남IC에서 '서울, 대전' 방면으로 오른쪽 고속도로 진입") === 'inr', entryLeft57: k(57) === 'inl',
      leftTurnStays: k(2, '좌회전') === 'l', rightTurnStays: k(3, '우회전') === 'r', toll: k(121) === 'toll', goal: k(88) === 'goal',
    };
    const R = buildNavRoute();
    R.route.guide = [{ i: 5, t: 41, s: "신갈분기점에서 '대전' 방면으로 왼쪽 도로 주행", d: 600, ms: 40000 },
                     { i: 9, t: 67, s: "성남IC에서 '성남, 광주' 방면으로 오른쪽 고속도로 출구", d: 480, ms: 30000 }];
    softReset();
    await planAndStart(R);
    const a = pointAt(R, 30); feed(a.p, 15, a.h); t.renderNav();
    // v143: '왼쪽 도로 주행'(41)은 네이버 '도로 주행' 그림(직진 화살표 밑동이 오른쪽에서 넘어옴, ml)
    const drawn = { main: !!document.querySelector('#turnIcon svg.keep2.ml'),
      next: !!document.querySelector('#nextIcon svg.ramp.out, #nextIcon img[src*="img/ai/outr__"], #nextIcon svg.keep.kr, #nextIcon img[src*="img/ai/kr__"]') };   // v110: 굵은 비켜 가기 그림   // v109: 나가기는 기본 화살표(오른쪽 길로)
    t.endNav(); softReset();
    const bad = Object.keys(map).filter((x) => !map[x]);
    const ok = !bad.length && drawn.main && drawn.next;
    return { pass: ok, detail: (bad.length ? 'wrong: ' + bad.join(', ') : 'mapping ✓') + ' | panel keep-left ' + (drawn.main ? '✓' : '✗') + ', next chip OUT ' + (drawn.next ? '✓' : '✗') };
  }

  // S56: 주행 화면(진행 방향 위)에서 지도를 끌면 (2026-11-14 요청)
  //   - 방향·기울기는 그대로 두고 지도만 손가락을 따라간다 (손가락 아래 지점이 그대로 손가락 아래에)
  //   - 아래 가운데 '내 위치로'가 뜨고, 새 GPS 가 와도 보던 자리 그대로
  //   - '내 위치로'를 누르거나 손을 떼고 5초 지나면 내 위치로 돌아간다
  //   - 톡 치기(10px 안)는 따라가기를 안 끊고, 두 손가락·휠 확대/축소도 주행 화면·따라가기 그대로
  async function s56() {
    if (T().glOn && T().glOn()) return s56gl();
    const t = T(), r = {}, prevHup = t.prefs.headingUp, prevStop = t.prefs.stopNorth;
    const lmap = () => t.getMap().map;
    const cv = () => document.querySelector('#map .mapcanvas');
    const fire = (type, id, x, y) => cv().dispatchEvent(new PointerEvent(type, { pointerId: id, clientX: x, clientY: y, bubbles: true, cancelable: true, pointerType: 'touch', isPrimary: id === 1 }));
    const finish = () => document.getAnimations().forEach((a) => { try { a.finish(); } catch (e) { /* 무한 애니메이션 */ } });
    const center = () => t.getMap().getCenter();
    // 화면 (x, y) 손가락 아래의 지도 좌표 (네이버 지도 / Leaflet 둘 다)
    const under = (x, y) => {
      const p = t.canvasPoint(x, y), m = lmap(), el = cv();
      if (m.containerPointToLatLng) { const ll = m.containerPointToLatLng([p.x, p.y]); return { lat: ll.lat, lng: ll.lng }; }
      const proj = m.getProjection(), o = proj.fromCoordToOffset(m.getCenter());
      const ll = proj.fromOffsetToCoord(new naver.maps.Point(o.x + p.x - el.offsetWidth / 2, o.y + p.y - el.offsetHeight / 2));
      return { lat: ll.lat(), lng: ll.lng() };
    };
    const drag = async (x0, y0, dx, dy) => {
      fire('pointerdown', 1, x0, y0);
      for (let k = 1; k <= 4; k++) { fire('pointermove', 1, x0 + dx * k / 4, y0 + dy * k / 4); await sleep(16); }
    };
    // 창이 가려져 있으면 Leaflet 애니메이션(requestAnimationFrame)이 멈춘다: 확대/축소는 바로, 옮기기는 시간이 지나면 끝까지 돌린다
    // (Leaflet 일 때만 해당. 네이버 지도는 배율이 바로 바뀌고 옮기기도 끝난다)
    const zoomAnim = lmap()._zoomAnimated;
    if (zoomAnim !== undefined) lmap()._zoomAnimated = false;
    const endPan = () => { const pa = lmap()._panAnim; if (pa && pa._inProgress) pa._step(); };
    let pos = TRIP_ORIGIN;
    const drive = (n) => { for (let k = 0; k < n; k++) { pos = dest(pos, 80, 15); feed(pos, 15, 80); } };
    try {
      t.prefs.headingUp = true; t.prefs.stopNorth = true;
      t.setFollowing(true);
      drive(8);
      // 앞 시나리오 자리에서 넘어오는 지도 이동이 끝나게 차 자리로 바로 옮겨 놓고 시작
      // 자동 줌이 끌기 도중에 배율을 바꾸지 않게 고정 (앱도 앞길을 보는 동안은 자동 줌을 멈춘다)
      t.zoomCtl.manualUntil = clock + 1e9;
      t.getMap().stop(); t.getMap().setZoom(17); t.getMap().center(t.state.fix.lat, t.state.fix.lng, true);
      await sleep(700); t.getMap().stop(); finish();
      r.drive0 = t.view.drive;
      const c0 = center();
      const host = document.getElementById('map').getBoundingClientRect();
      const sx = host.left + host.width * 0.5, sy = host.top + host.height * 0.42;
      // 톡 치기: 4px 만 움직이면 그대로 따라간다
      fire('pointerdown', 1, sx, sy); fire('pointermove', 1, sx + 3, sy + 2); fire('pointerup', 1, sx + 3, sy + 2);
      r.tapKeeps = t.state.following === true && t.view.drive === true;
      // 끌기
      const L0 = under(sx, sy), rot0 = t.view.rot;
      await drag(sx, sy, 70, 110);
      r.peek = t.state.peek === true && t.state.following === false;
      r.stillDrive = t.view.drive === true && document.getElementById('map').classList.contains('drive');
      const L1 = under(sx + 70, sy + 110);
      r.followsFinger = hav(L0, L1);          // 손가락 아래 지점이 손가락을 따라왔는지 (m)
      r.moved = hav(center(), c0);            // 지도 가운데가 옮겨졌는지 (m)
      r.pill = visible('#backMe');
      // 끌고 있는 중에 GPS 가 와도 보던 자리 그대로, 방향은 진행 방향 그대로
      const c1 = center(); drive(1); finish();
      r.stays = hav(c1, center());
      r.rotKept = Math.abs(t.view.rot - rot0) < 1;
      fire('pointerup', 1, sx + 70, sy + 110);
      r.counting = document.getElementById('backMe').classList.contains('count');
      // '내 위치로' 누르기
      document.getElementById('backMe').click();
      r.btnBack = t.state.following === true && t.state.peek === false && !visible('#backMe');
      // 돌아가는 곳은 지도 위 내 차 표시 자리 (GPS 점을 부드럽게 이은 위치)
      const meAt = () => t.motion.cur || t.state.fix;
      await waitFor(() => { finish(); endPan(); return hav(center(), meAt()) < 3; }, 3000);
      r.btnCenter = hav(center(), meAt());
      // 5초 뒤 저절로 복귀
      await drag(sx, sy, -80, 60);
      fire('pointerup', 1, sx - 80, sy + 60);
      r.peek2 = t.state.peek === true;
      await sleep(4500);
      r.notYet = t.state.following === false;
      await waitFor(() => t.state.following, 2500);
      r.autoBack = t.state.following === true && !visible('#backMe') && t.view.drive === true;
      // 휠: 주행 화면·따라가기 그대로 한 단계 확대
      await sleep(300);
      const z0 = lmap().getZoom();
      cv().dispatchEvent(new WheelEvent('wheel', { deltaY: -120, clientX: sx, clientY: sy, bubbles: true, cancelable: true }));
      await waitFor(() => { finish(); return lmap().getZoom() === z0 + 1; }, 2000);
      r.wheel = lmap().getZoom() - z0;
      r.wheelKeeps = t.state.following === true && t.view.drive === true;
      // 두 손가락 벌리기: 한 단계 축소 후 확대 확인 대신, 벌리면 +1
      await sleep(300);
      const z1 = lmap().getZoom();
      fire('pointerdown', 1, sx - 40, sy); fire('pointerdown', 2, sx + 40, sy);
      fire('pointermove', 1, sx - 80, sy); fire('pointermove', 2, sx + 80, sy);
      fire('pointerup', 1, sx - 80, sy); fire('pointerup', 2, sx + 80, sy);
      await waitFor(() => { finish(); return lmap().getZoom() === z1 + 1; }, 2000);
      r.pinch = lmap().getZoom() - z1;
      r.pinchKeeps = t.state.following === true && t.view.drive === true;
    } finally {
      ['pointerup'].forEach((ty) => { fire(ty, 1, 0, 0); fire(ty, 2, 0, 0); });
      t.prefs.headingUp = prevHup; t.prefs.stopNorth = prevStop;
      t.zoomCtl.manualUntil = 0;
      t.setFollowing(true);
      if (zoomAnim !== undefined) lmap()._zoomAnimated = zoomAnim;
    }
    const ok = r.drive0 && r.tapKeeps && r.peek && r.stillDrive && r.followsFinger < 4 && r.moved > 20 && r.pill && r.stays < 1 && r.rotKept &&
      r.counting && r.btnBack && r.btnCenter < 3 && r.peek2 && r.notYet && r.autoBack && r.wheel === 1 && r.wheelKeeps && r.pinch === 1 && r.pinchKeeps;
    const m = (v) => (typeof v === 'number' ? Math.round(v * 10) / 10 : v);
    return { pass: !!ok, detail: Object.keys(r).map((k) => k + '=' + m(r[k])).join(', ') };
  }

  // S25: 하이패스 — 경로 안내에 톨게이트(type 121)가 있으면 2km 앞부터 카드(이름·거리·통행료·하이패스 차로 이용)와 음성
  async function s25() {
    const t = T();
    const raw = [];
    const o = dest(NAV_ORIGIN, 0, 0);
    for (let k = 0; k <= 40; k++) raw.push(dest(o, 0, 100 * k));   // 북쪽으로 4km, 톨게이트는 2.5km 지점
    const path = raw.map((p) => [round6(p.lng), round6(p.lat)]);
    const P = path.map((x) => ({ lat: x[1], lng: x[0] }));
    const cum = [0];
    for (let i = 1; i < P.length; i++) cum.push(cum[i - 1] + hav(P[i - 1], P[i]));
    const total = cum[cum.length - 1];
    const R = {
      route: { distance: r0(total), duration: r0(total / 25 * 1000), tollFare: 3900, fuelPrice: 300, path,
        guide: [{ i: 25, t: 121, s: '테스트톨게이트 (통행료 3,900원)', d: r0(cum[25]), ms: 100000 },
                { i: 40, t: 88, s: '목적지', d: r0(total - cum[25]), ms: 60000 }],
        sections: [{ i: 0, n: 41, name: '테스트고속도로', speed: 100, cong: 1 }] },
      P, cum, total, dest: { name: '톨 테스트', addr: '', lat: P[40].lat, lng: P[40].lng },
    };
    await planAndStart(R);
    const mark = t.alertLog[t.alertLog.length - 1];
    let shownAt = null, card = null, voice = null;
    for (let s = 25; s <= 2500; s += 25) {
      const a = pointAt(R, s);
      feed(a.p, 25, 0);   // 90 km/h
      t.renderNav();
      if (shownAt === null && visible('#tollCard')) { shownAt = r0(cum[25] - s); card = { name: text('#tollName'), dist: text('#tollDist'), fare: text('#tollFare') + ' ' + text('#tollCard .toll-hint') }; }
      if (!voice) {
        const from = mark ? t.alertLog.indexOf(mark) + 1 : 0;
        const v = t.alertLog.slice(from).find((e) => /테스트톨게이트/.test(e.text));
        if (v) voice = { at: r0(cum[25] - s), text: v.text };
      }
    }
    const ok = shownAt !== null && shownAt <= 2000 && shownAt > 1950 && card.name === '테스트톨게이트' && /3,900원/.test(card.fare) &&
      /하이패스/.test(card.fare) && !!voice && /2킬로미터 앞/.test(voice.text) && /하이패스 차로를 이용하세요/.test(voice.text);
    return {
      pass: ok,
      detail: 'card ' + (shownAt === null ? 'NEVER' : 'from ' + shownAt + ' m: "' + card.name + ' ' + card.dist + ' ' + card.fare + '"') +
        '; voice ' + (voice ? 'at ' + voice.at + ' m "' + voice.text + '"' : 'NONE'),
    };
  }

  // S26: 길안내 없이 지도에는 내 진행 방향 앞의 카메라만 (뒤쪽·반대편 차로 카메라는 표시하지 않음)
  async function s26() {
    const t = T(), C = CAM_ISO_A;   // 한 방향(하행) 카메라
    const m = await waitFor(() => t.getMap(), 5000, 100);
    if (!m || !('cams' in m)) return { status: 'SKIP', detail: 'no map' };
    const shownAfter = (fn) => { softReset(); t.camState.markerAt = null; fn(); return m.cams.size; };
    // v123: 카메라가 찍는 방향(F.h) 기준. (a) 카메라를 향해 (1.5km 앞에서 1.2km 앞까지)
    const F = camFrame(C, 0), back = (F.h + 180) % 360;
    const ahead = shownAfter(() => { for (let s = 0; s <= 300; s += 20) feed(F.pt(1500 - s), 20, F.h); });
    // (b) 카메라를 지나 계속 (뒤에 있음)
    const behind = shownAfter(() => { for (let s = 0; s <= 300; s += 20) feed(F.pt(-(200 + s)), 20, F.h); });
    // (c) 반대 방향 차로(카메라가 내 왼쪽 18m, 300m 안)
    const opposite = shownAfter(() => { for (let s = 0; s <= 200; s += 20) feed(F.pt(-(300 - s), -18), 20, back); });
    // (d) 멀리(1.8km→1.5km 앞) 반대 방향 차로(왼쪽 25m). 멀리 있어도 지도에 띄우지 않는다
    const farOpposite = shownAfter(() => { for (let s = 0; s <= 300; s += 25) feed(F.pt(-(1800 - s), -25), 25, back); });
    const pass = ahead >= 1 && behind === 0 && opposite === 0 && farOpposite === 0;
    return { pass, detail: 'markers: heading to camera ' + ahead + (ahead >= 1 ? '✓' : '✗') + ', camera behind ' + behind + (behind === 0 ? '✓' : '✗') +
      ', opposite lane ' + opposite + (opposite === 0 ? '✓' : '✗') + ', far opposite lane ' + farOpposite + (farOpposite === 0 ? '✓' : '✗') };
  }

  // S23: 경로 이탈 → 같은 목적지를 '추천'(traoptimal) 경로로 다시 찾는다. 80m 넘게 벗어나면 2번째 위치에서 바로.
  //      처음에 무료 도로를 골랐으면 다시 찾을 때도 무료 도로(traavoidtoll)
  async function s23() {
    const t = T();
    const run = async (chosen) => {
      softReset();
      const R = buildNavRoute();
      const c0 = stub.calls.length;
      await planAndStart(R);
      if (chosen) t.nav.option = chosen;
      for (const s of [15, 30, 45]) { const a = pointAt(R, s); feed(a.p, 10, a.h); }
      let firedOn = null;
      for (let k = 0; k < 4 && firedOn === null; k++) {
        const on = pointAt(R, 60 + 30 * k).p;
        feed(dest(on, 90, 120), 10, 0, { dt: 3000 });   // 경로에서 동쪽 120m
        if (stub.count('/route', c0) >= 2) firedOn = k + 1;
      }
      await waitFor(() => !t.nav.busy, 2000, 20);
      const calls = stub.since(c0, '/route'), q = calls[1] ? calls[1].query : {};
      const goal = R.dest.lng.toFixed(6) + ',' + R.dest.lat.toFixed(6);
      return { firedOn, option: q.option, sameGoal: q.goal === goal, optionAfter: t.nav.option, active: t.nav.active };
    };
    const a = await run(null), b = await run('traavoidtoll');
    const okA = a.firedOn === 2 && a.option === 'traoptimal' && a.sameGoal && a.optionAfter === 'traoptimal' && a.active;
    const okB = b.option === 'traavoidtoll' && b.sameGoal && b.active;
    return {
      pass: okA && okB,
      detail: 'default: reroute on off-route fix #' + a.firedOn + ', option=' + a.option + ', same goal ' + a.sameGoal + (okA ? '✓' : '✗') +
        '; chose 무료 도로: option=' + b.option + ', same goal ' + b.sameGoal + (okB ? '✓' : '✗'),
    };
  }

  // S20: 길안내 없이 굽은 길 — 반지름 250m 로 왼쪽·오른쪽으로 계속 굽는 길 끝의 카메라(CAM_ISO_B, 400m 경고)를
  //      직선이 아니라 휘는 앞길로 예측해서 300m 넘게 앞에서 잡아야 한다 (예전에는 옆 도로·반대편 차로로 오인해 놓침)
  async function s20() {
    const t = T(), C = CAM_ISO_B, R = 250;
    const drive = (left) => {
      softReset();
      // v123: 카메라가 찍는 방향(h)으로 카메라에 닿도록 원을 둔다. 왼쪽 굽음은 중심이 진행 방향 왼쪽(반시계로 달림)
      const F = camFrame(C, 90), h = F.h;
      const center = dest(F.p0, (h + (left ? 270 : 90)) % 360, R);
      const th0 = (h + (left ? 90 : 270)) % 360;
      let first = null;
      for (let deg = 140; deg >= 0; deg -= (13 / R) * 180 / Math.PI) {
        const th = (th0 + (left ? deg : -deg) + 360) % 360;
        const p = dest(center, th, R);
        const head = ((left ? th - 90 : th + 90) + 360) % 360;
        feed(p, 13, head);
        const tg = t.camState.target;
        if (first === null && tg && sameCam(tg.c, C)) first = r0(hav(p, F.p0));
      }
      return first;
    };
    const l = drive(true), r = drive(false);
    return {
      pass: l !== null && l >= 300 && r !== null && r >= 300,
      detail: 'R=250 m curve, camera at the end (400 m range): left curve alert at ' + (l === null ? 'NEVER' : l + ' m') + (l >= 300 ? '✓' : '✗') +
        ', right curve alert at ' + (r === null ? 'NEVER' : r + ' m') + (r >= 300 ? '✓' : '✗'),
    };
  }

  // S21: 길안내 경로의 도로명이 '국도43' 처럼 노선 번호만 있어도, 이름이 다르다고 카메라를 숨기지 않는다
  async function s21() {
    const t = T(), out = [];
    for (const name of ['국도43', '국지도70', '지방도333', '다른대로']) {
      softReset();
      const R = buildRouteBeside(CAM_ISO_B, -12, name);   // 카메라가 경로 오른쪽 12m
      await planAndStart(R);
      let hit = false;
      for (let s = 14; s <= 900; s += 14) {
        const a = pointAt(R, s);
        feed(a.p, 13, a.h);
        const tg = t.camState.target;
        if (tg && sameCam(tg.c, CAM_ISO_B)) hit = true;
      }
      out.push({ name, hit, ok: hit === (name !== '다른대로') });
    }
    return {
      pass: out.every((x) => x.ok),
      detail: 'camera road 위례성로, 12 m right of route named: ' + out.map((x) => x.name + '→' + (x.hit ? 'alert' : 'none') + (x.ok ? '✓' : '✗')).join(', '),
    };
  }

  // S22: 경로 색 — 교통 정보 없는 길 파랑, 원활 초록, 정체 빨강 (지도 경로선과 왼쪽 막대 모두)
  async function s22() {
    const t = T(), R = buildNavRoute();   // 테스트로 cong 1(원활) 0~5점, 율곡로 cong 3(정체) 5~9점
    await planAndStart(R);
    feed(pointAt(R, 15).p, 15, 0);
    t.renderNav();
    const m = t.getMap();
    const colors = {};
    (m.route || []).forEach((pc) => { colors[pc.kind] = colors[pc.kind] || new Set(); colors[pc.kind].add(String(pc.color).toLowerCase()); });
    const has = (k, c) => !!colors[k] && colors[k].has(c);
    const bar = (document.getElementById('rsBar').style.background || '').toLowerCase();
    // 색은 네이버 GL 지도의 교통 선 색 (지금 낮/밤 팔레트)
    const P = t.trafficPal(), rgb = (h) => 'rgb(' + [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)).join(', ') + ')';
    const inBar = (h) => bar.includes(rgb(h)) || bar.includes(h);
    const blueBase = has('base', '#2f7dff'), green = !has('traffic', P[1]), red = has('traffic', P[3]);   // v242: 원활 구간은 경로선 바탕 파랑 그대로 (지도 교통 초록과 겹치지 않게)
    // 막대: 원활(초록)·정체(빨강) 구간이 그려진다. 이 경로는 정보 없는 구간이 없으므로 파랑은 없어도 된다
    const barOk = inBar(P[1]) && inBar(P[3]);
    // 정보 없는 경로: 구간 정보를 빼면 막대가 파랑
    t.endNav(); softReset();
    const R2 = buildNavRoute(); R2.route.sections = [];
    await planAndStart(R2);
    feed(pointAt(R2, 15).p, 15, 0);
    t.renderNav();
    const bar2 = (document.getElementById('rsBar').style.background || '').toLowerCase();
    const blueBar = /rgb\(47, 125, 255\)|#2f7dff/.test(bar2) && !bar2.includes(rgb(P[1]));
    return {
      pass: blueBase && green && red && barOk && blueBar,
      detail: 'line: base blue ' + (blueBase ? '✓' : '✗') + ', free-flow stays blue ' + (green ? '✓' : '✗') + ', jam red ' + (red ? '✓' : '✗') +
        '; strip: green+red ' + (barOk ? '✓' : '✗') + ', no-data route all blue ' + (blueBar ? '✓' : '✗'),
    };
  }

  // S19: 그냥 링크로 들어와도 최신 버전 — 버전 세 곳(app.js·index.html·version.json)이 맞는지,
  //      그리고 새 버전 판단(새로고침 / 이미 최신 / 운전 중 미룸 / 같은 창 재시도 안 함)이 맞는지
  async function s19() {
    const t = T();
    const vj = await (await realFetch(rootDir + 'version.json', { cache: 'no-store' })).json();
    const html = await (await realFetch(rootDir + 'index.html', { cache: 'no-store' })).text();
    const m = html.match(/app\.js\?v=([0-9.\-]+)/);
    const same = vj.v === t.version && m && m[1] === t.version;
    const bump = (v) => v.replace(/(\d+)$/, (x) => String(+x + 1));
    const older = t.version.replace(/(\d+)$/, (x) => String(Math.max(0, +x - 1)));
    let saved = null;
    try { saved = sessionStorage.getItem('tnc.updTried'); sessionStorage.removeItem('tnc.updTried'); } catch (e) { /* 막힘 */ }
    const r = {};
    r.newer = await t.checkForUpdate('test', { dry: true, latest: bump(t.version) });
    r.same = await t.checkForUpdate('test', { dry: true, latest: t.version });
    r.older = await t.checkForUpdate('test', { dry: true, latest: older });
    // 숫자로 비교 (글자 순서 아님): 지금이 두 자리면 -100 > -16. 세 자리 이상(v100~)이면 위 'older'(99 < 100)가 같은 함정을 본다
    const nv = +(t.version.match(/-(\d+)$/) || [0, 0])[1];
    r.numeric = await t.checkForUpdate('test', { dry: true, latest: t.version.replace(/-(\d+)$/, '-' + (nv < 100 ? 100 : nv * 10)) });
    t.state.speedKmh = 40;
    r.moving = await t.checkForUpdate('test', { dry: true, latest: bump(t.version) });
    t.state.speedKmh = 0;
    try { sessionStorage.setItem('tnc.updTried', bump(t.version)); } catch (e) { /* 막힘 */ }
    r.tried = await t.checkForUpdate('test', { dry: true, latest: bump(t.version) });
    try { if (saved === null) sessionStorage.removeItem('tnc.updTried'); else sessionStorage.setItem('tnc.updTried', saved); } catch (e) { /* 막힘 */ }
    r.realOnTestPage = await t.checkForUpdate('test'); // 테스트 페이지에서는 실제로는 아무것도 하지 않는다
    const want = { newer: 'reload', same: 'latest', older: 'latest', numeric: 'reload', moving: 'driving', tried: 'tried', realOnTestPage: 'skip' };
    const okLogic = Object.keys(want).every((k) => r[k] === want[k]);
    return {
      pass: same && okLogic,
      detail: 'versions app.js ' + t.version + ' / index.html ' + (m ? m[1] : '?') + ' / version.json ' + vj.v + (same ? '✓' : ' ✗ MISMATCH') +
        '; decisions ' + Object.keys(want).map((k) => k + '=' + r[k] + (r[k] === want[k] ? '' : '✗')).join(', '),
    };
  }

  // S17: 도로 종류별 경고 거리 — 고속도로 3km(음성 2km) · 고속화도로(제한 80+) 1km · 일반도로 400m
  // 고속도로: 서울양양고속도로 [37.72753,127.59605,100,1,0,0,0,88,1,2]. 가장 가까운 다른 카메라는 북동쪽 3.6km 의
  // 신호 전용과 남쪽 4km 의 어린이보호구역(400m 경고)이라, 북서쪽(300°)에서 다가가면 이 카메라만 잡힌다.
  const CAM_HWY = { lat: 37.72753, lng: 127.59605 };
  async function s17() {
    const t = T();
    const approach = (C, from, brgFrom, v) => {
      softReset();
      const mark = t.alertLog[t.alertLog.length - 1];
      let first = null, voiceAt = null;
      const F = camFrame(C, (brgFrom + 180) % 360), head = F.h;
      for (let s = 0; s <= from - 100; s += v) {
        const p = F.pt(from - s);
        feed(p, v, head);
        const tg = t.camState.target, d = hav(p, F.p0);
        if (first === null && tg && sameCam(tg.c, C)) first = r0(d);
        if (voiceAt === null) {
          const from0 = mark ? t.alertLog.indexOf(mark) + 1 : 0;
          const hit = t.alertLog.slice(from0).find((e) => /앞, /.test(e.text));
          if (hit) voiceAt = { d: r0(d), text: hit.text };
        }
      }
      return { first, voiceAt };
    };
    const hw = approach(CAM_HWY, 3400, 300, 27);      // 고속도로, 97 km/h
    const ex = approach(CAM_ISO_A, 1300, 180, 22);    // 제한 80 국도
    const gn = approach(CAM_ISO_B, 800, 180, 13);     // 제한 50 일반도로
    const okHw = hw.first !== null && hw.first <= 3000 && hw.first > 2940 && !!hw.voiceAt && /2킬로미터/.test(hw.voiceAt.text) && hw.voiceAt.d <= 2030 && hw.voiceAt.d > 1960;
    const okEx = ex.first !== null && ex.first <= 1000 && ex.first > 970 && !!ex.voiceAt && /1킬로미터/.test(ex.voiceAt.text);
    const okGn = gn.first !== null && gn.first <= 400 && gn.first > 380 && !!gn.voiceAt && /400미터/.test(gn.voiceAt.text);
    const show = (x) => (x.first === null ? 'NO ALERT' : 'card at ' + x.first + ' m') + (x.voiceAt ? ', voice at ' + x.voiceAt.d + ' m "' + x.voiceAt.text.split(',')[0] + '"' : ', no voice');
    return {
      pass: okHw && okEx && okGn,
      detail: 'highway: ' + show(hw) + (okHw ? '✓' : '✗') + '; limit 80: ' + show(ex) + (okEx ? '✓' : '✗') + '; limit 50: ' + show(gn) + (okGn ? '✓' : '✗'),
    };
  }

  // S18: 길안내 중에는 안내 경로 위 카메라만 (경고·지도 표시·'다음 단속' 모두). 길안내가 없으면 앞쪽 카메라 아무거나
  async function s18() {
    const t = T(), C = CAM_ISO_B;
    const start = dest(C, 180, 1000);
    // (a) 경로는 동쪽으로 가는데 차는 북쪽(카메라 정면)으로 달린다 = 경로 밖 카메라
    const raw = [];
    for (let k = 0; k <= 12; k++) raw.push(dest(start, 90, 100 * k));
    const path = raw.map((p) => [round6(p.lng), round6(p.lat)]);
    const P = path.map((x) => ({ lat: x[1], lng: x[0] }));
    const cum = [0];
    for (let i = 1; i < P.length; i++) cum.push(cum[i - 1] + hav(P[i - 1], P[i]));
    const total = cum[cum.length - 1];
    const R = {
      route: { distance: r0(total), duration: r0(total / 14 * 1000), tollFare: 0, fuelPrice: 100, path,
        guide: [{ i: 12, t: 88, s: '목적지', d: r0(total), ms: r0(total / 14 * 1000) }],
        sections: [{ i: 0, n: 13, name: '동쪽길', speed: 50, cong: 1 }] },
      P, cum, total, dest: { name: '동쪽 목적지', addr: '', lat: P[12].lat, lng: P[12].lng },
    };
    await planAndStart(R);
    let offHit = null;
    for (let s = 14; s <= 900; s += 14) {
      feed(dest(start, 0, s), 13, 0);
      const tg = t.camState.target;
      if (tg && sameCam(tg.c, C) && offHit === null) offHit = r0(1000 - s);
    }
    const m = t.getMap();
    const offMarkers = m && m.cams ? m.cams.size : -1;
    await waitFor(() => !t.nav.busy, 2000, 20);
    // (b) 같은 길을 길안내 없이 달리면 알린다
    softReset();
    let freeHit = null;
    for (let s = 14; s <= 900; s += 14) {
      feed(dest(start, 0, s), 13, 0);
      const tg = t.camState.target;
      if (tg && sameCam(tg.c, C) && freeHit === null) freeHit = r0(1000 - s);
    }
    // (c) 카메라를 지나는 경로로 안내하면 경고 + 지도 표시 + 경고 거리 밖에서는 '다음 단속'(경로 거리)
    softReset();
    const R2 = buildRouteBeside(C, -6, '위례성로');
    await planAndStart(R2);
    let nextTxt = null, onHit = null, onMarkers = -1;
    for (let s = 14; s <= 900; s += 14) {
      const a = pointAt(R2, s);
      feed(a.p, 13, a.h, { dt: 1100 });
      if (nextTxt === null && visible('#camNext')) nextTxt = text('#camNext');
      const tg = t.camState.target;
      if (tg && sameCam(tg.c, C) && onHit === null) { onHit = r0(1000 - s); onMarkers = m && m.cams ? m.cams.size : -1; }
    }
    // v161 (2026-11-20 점검 4): 경로를 2.5초 넘게 벗어나 다른 길을 달리면 그 길의 카메라를 알린다(예전엔 경로 밖이라 끝내 안 알렸다). 지도 표시는 경로 위 카메라만
    const pass = offHit !== null && offMarkers === 0 && freeHit !== null && onHit !== null && onMarkers >= 1 && !!nextTxt && /다음 단속/.test(nextTxt);
    return {
      pass,
      detail: '(a) navigating but driving off the route toward a camera: ' + (offHit !== null ? 'alert at ' + offHit + ' m (off route 2.5 s+ → road ahead)✓' : 'MISSED') +
        ', map markers ' + offMarkers + (offMarkers === 0 ? '✓' : '✗') +
        '; (b) same drive without nav: ' + (freeHit !== null ? 'alert at ' + freeHit + ' m✓' : 'MISSED') +
        '; (c) route through camera: ' + (onHit !== null ? 'alert at ' + onHit + ' m, markers ' + onMarkers : 'MISSED') + ', preview "' + (nextTxt || 'none') + '"',
    };
  }

  const SCENARIOS = [
    { id: 'S1', name: 'S1 section enforcement', fn: s1 },
    { id: 'S2', name: 'S2 direction filtering', fn: s2 },
    { id: 'S3', name: 'S3 school-zone label', fn: s3 },
    { id: 'S4', name: 'S4 over-speed', fn: s4 },
    { id: 'S5', name: 'S5 navigation flow', fn: s5 },
    { id: 'S6', name: 'S6 off-route reroute', fn: s6 },
    { id: 'S7', name: 'S7 search merge', fn: s7 },
    { id: 'S8', name: 'S8 camera markers', fn: s8 },
    { id: 'S9', name: 'S9 trip odometer', fn: s9 },
    { id: 'S10', name: 'S10 route behind car erased', fn: s10 },
    { id: 'S11', name: 'S11 reroute when never on route', fn: s11 },
    { id: 'S12', name: 'S12 camera hold 30 m after', fn: s12 },
    { id: 'S13', name: 'S13 signal cameras: with a limit = 신호·과속 by default; no-limit signal-only off', fn: s13 },
    { id: 'S14', name: 'S14 adjacent-road / opposite-lane cameras', fn: s14 },
    { id: 'S15', name: 'S15 over-speed beep once a second', fn: s15 },
    { id: 'S16', name: 'S16 Tesla mode layout', fn: s16 },
    { id: 'S17', name: 'S17 alert range by road type', fn: s17 },
    { id: 'S18', name: 'S18 navigation: route cameras on the map; off the route for 2.5 s+ the road actually driven is watched (v161 audit)', fn: s18 },
    { id: 'S19', name: 'S19 latest version from plain link', fn: s19 },
    { id: 'S20', name: 'S20 curved road camera (no nav)', fn: s20 },
    { id: 'S21', name: 'S21 route-number road names', fn: s21 },
    { id: 'S22', name: 'S22 route colours (blue = no traffic data; v242: free-flow keeps the line blue, the side strip stays green)', fn: s22 },
    { id: 'S23', name: 'S23 off-route reroute: same goal, 추천', fn: s23 },
    { id: 'S24', name: 'S24 Tesla mode placement', fn: s24 },
    { id: 'S25', name: 'S25 toll gate (하이패스) card + voice', fn: s25 },
    { id: 'S26', name: 'S26 map shows only my-direction cameras', fn: s26 },
    { id: 'S27', name: 'S27 section enforcement on a real route', fn: s27 },
    { id: 'S28', name: 'S28 auto night (sun) + dark map', fn: s28 },
    { id: 'S29', name: 'S29 favourites: 집 · 회사 · ★', fn: s29 },
    { id: 'S30', name: 'S30 trip log with speeding events', fn: s30 },
    { id: 'S31', name: 'S31 weather icons', fn: s31 },
    { id: 'S32', name: 'S32 stopped → north up (labels upright)', fn: s32 },
    { id: 'S33', name: 'S33 parked & untouched → check for new version; not at a red light after driving (v160: 15 min since 10+ km/h) or inside a speed section', fn: s33 },
    { id: 'S34', name: 'S34 Tesla mode: camera → my speed → small zone sign, red when over', fn: s34 },
    { id: 'S35', name: 'S35 Gapyeong 계량교 30 camera (data fix): 신호·과속, alerts when over', fn: s35 },
    { id: 'S36', name: 'S36 rear-enforcement camera (가평 포회촌, added): held 60 m past the pole, one direction only', fn: s36 },
    { id: 'S37', name: 'S37 가평→청평 real route: every camera in our direction alerts (signal→신호·과속); cameras on the opposite side (left 11-17 m) do not', fn: s37 },
    { id: 'S38', name: 'S38 wide roads: a camera 26 m right of the route line is caught by its road; cameras 30-34 m left (opposite carriageway) are not', fn: s38 },
    { id: 'S39', name: 'S39 bottom location bar → 경로 비교 · 재추천 · 경유지', fn: s39 },
    { id: 'S40', name: 'S40 new version while driving: tray button, resume the same guidance after updating', fn: s40 },
    { id: 'S41', name: 'S41 speed bumps (national data): route bumps 200 m ahead + map signs, also without nav', fn: s41 },
    { id: 'S42', name: "S42 next-step chip: Naver-style '↱ 360m', or a red pin '480m' when the destination is next", fn: s42 },
    { id: 'S43', name: 'S43 one-way speed camera marked both ways in the data (양서면 북한강로): quiet on the opposite side', fn: s43 },
    { id: 'S44', name: 'S44 tunnel row: entry distance + length, then distance to the exit (OSM tunnels)', fn: s44 },
    { id: 'S45', name: 'S45 hi-pass card sits in the camera drawer under the nav panel (Tesla mode) + toll gate icon', fn: s45 },
    { id: 'S46', name: 'S46 box-type speed camera added by hand (팔당 다산로): shown as 박스형 one way only', fn: s46 },
    { id: 'S47', name: "S47 one-way camera direction from its 'A→B' place text vs the route's guide text (하남 창우로)", fn: s47 },
    { id: 'S48', name: 'S48 junction picture: highway ramp / fork drawn from the guide type, in the drawer 800m ahead', fn: s48 },
    { id: 'S49', name: 'S49 trip distance/time/max speed survive an update reload', fn: s49 },
    { id: 'S50', name: 'S50 traffic colors in five steps (green, yellow, orange, red, dark red) from section speed; v242: free-flow sections keep the route blue (green would match the map traffic lines), only slow/jam get colour', fn: s50 },
    { id: 'S51', name: "S51 section cameras found from '구간 시점/종점' place text", fn: s51 },
    { id: 'S52', name: 'S52 on the expressway (entry→exit guides) street cameras below stay quiet even without a section name', fn: s52 },
    { id: 'S53', name: 'S53 hi-pass lane strip from data/hipass.json (all lanes, hi-pass blue): entry/exit, 상행/하행 toward Seoul, common lanes when unsure; mainline tollgates (서울TG) by direction; ring road counter-clockwise = 상행 (성남TG 1 2 3 – 8 9 – 11 –)', fn: s53 },
    { id: 'S54', name: 'S54 keep-left/right arrows for 왼쪽/오른쪽 방향·도로 주행, OUT/IN for highway exit/entry', fn: s54 },
    { id: 'S55', name: "S55 road caution signs (slippery, rockfall…): 300 m ahead on our side of the route, '주의' just after, setting off", fn: s55 },
    { id: 'S56', name: "S56 dragging the heading-up map keeps the direction, shows '내 위치로', returns after 5 s; pinch/wheel zoom keeps following", fn: s56 },
    { id: 'S59', name: "S59 destination → its parking entrance ('…주차장입구' from place search), '정문으로' switches back; no entrance = unchanged", fn: s59 },
    { id: 'S60', name: 'S60 white turn arrow on the map at the next turn (400 m before), destination pin + dots from the route end', fn: s60 },
    { id: 'S61', name: 'S61 highway rest areas on the route: only my side (right) or both-way ones, duplicates merged, next within 30 km + the one after; not on local roads', fn: s61 },
    { id: 'S62', name: 'S62 Naver guide codes → icons: roundabout exits, overpass/underpass/side road not as turns, hi-pass/one-toll gates, rest area, entry/exit ahead', fn: s62 },
    { id: 'S63', name: 'S63 car icon choice (cute car, AI photo Model Y grey/red/white, arrows; old drawn Model Y ids map to the photo ones): marker swaps, keeps the heading, saved', fn: s63 },
    { id: 'S64', name: 'S64 no-parking cameras while navigating: nothing on the way, only within 700 m of the destination (ahead + around the destination)', fn: s64 },
    { id: 'S67', name: 'S67 icon picks: repo picks (img/ai/picks.js) used for signs and tunnel, ?catalog gives icon definitions without map/GPS, an ai: car works as my car', fn: s67 },
    { id: 'S66', name: 'S66 toll gate name/fare split at the last parenthesis (남산1호터널톨게이트(도심) (통행료 0원))', fn: s66 },
    { id: 'S65', name: 'S65 auto zoom: 17 while driving even before a turn; the close-up 18 only within 300 m of the destination', fn: s65 },
    { id: 'S58', name: "S58 no-parking cameras: '주정차 단속' only ahead in my direction, when slow (no sound); not behind or on a side street; setting off", fn: s58 },
    { id: 'S57', name: 'S57 fast reroute: wrong-way turn caught in 2 fixes, start asked ahead of the car, a new route that starts behind the car is retried at once (only once)', fn: s57 },
    { id: 'S76', name: "S76 turn lane guidance (trial, NGII HD map → data/lanes.json): lane boxes under the turn row 500 m ahead, lanes for this turn blue; skips approaches without that turn; setting off", fn: s76 },
    { id: 'S77', name: "S77 straight-through lane guidance: the nearer intersection's straight lanes (300 m, with distance) before the turn's lanes; opposite/side-road approaches ignored; 7-10 lanes fit the drawer as square tiles", fn: s77 },
    { id: 'S78', name: "S78 mainline junction (v133): keep-left/right where the route stays on the same expressway section and goes straight is shown as straight ('신갈분기점에서 직진 · 서울 방면', main-straight junction scene, straight sign); a fork onto another expressway stays a fork; v245: the junction slot is the driver's AI picture (junc_main), no drawn scene", fn: s78 },
    { id: 'S79', name: 'S79 rest areas (v133): distance to where the entry ramp leaves the mainline (OSM), not the rest-area centre; within 3 km and no turn within 1 km the top row becomes the rest area (blue), next row = the guidance after it', fn: s79 },
    { id: 'S117', name: "S117 speech judgement (v183): with a fake speech engine — one that waits 6 s before speaking is not cancelled and gets no fallback beep, an utterance that silently vanishes (not pending, not speaking, no events) is replaced by a beep but speech stays on, two real errors switch to beeps until a Korean voice arrives, and the sound test always tries speech", fn: s117 },
    { id: 'S116', name: "S116 map fallback badge (v182): when the Naver map could not be loaded the badge says '네이버 지도를 불러오지 못했어요 · 누르면 다시 시도' (not the old '설정에서 네이버 키 입력'), stays visible when the buttons hide, and a tap reloads only when parked — while guided or moving it says to stop first", fn: s116 },
    { id: 'S115', name: "S115 no false off-route (v181, driver: 'I never left the route but it keeps saying off-route now and then'): a 5-minute traffic refresh whose new route starts on a parallel road 45 m away (Naver snapping the start to the wrong road) is not applied and driving on raises no reroute; a refresh on the same road is applied; a car still behind a reroute's start (slowed in traffic) is on route, not off; a real turn-off still reroutes within about 3 s / 30 m; each reroute leaves a location-free reason record", fn: s115 },
    { id: 'S114', name: "S114 unknown limits (v179, driver: 'don't show speed cameras with ?'): a speed camera with limit 0 is never alerted or drawn, the same camera with 60 is; a signal-only camera follows the setting and shows '신호'; a reported spot takes the limit of a same-road, same-direction camera (1.5 km), else 100 on an expressway, else stays hidden and the settings list says '제한속도 모름이라 숨김' — and shows once a camera appears", fn: s114 },
    { id: 'S113', name: "S113 '내 위치로' (v177, driver: 'it doesn't seem to work well'): pressing the real button (what is under its centre) puts the map on my car at once (no animation needed) and gives back the auto zoom — after looking ahead, after a pinch zoom, while guided, in route preview (the corner locate button), after GPS stops and after the page comes back; with no position yet it says so", fn: s113 },
    { id: 'S112', name: "S112 crowd fixes (v175, driver: 'auto-apply spots 3+ drivers reported, AI checks them again'): from /fixes, a fix marked src 'auto' (3+ drivers, not yet confirmed) still changes the camera but its card says '사용자 제보', an auto spot shows '사용자 제보 단속 지점' with the limit of a nearby same-direction camera (v179), a confirmed spot (src 'op' or an old server without src) shows '운전자 신고 단속 지점'; my own reported spot at an auto spot reads '여러 운전자 신고로 반영됨(확인 전)'", fn: s112 },
    { id: 'S111', name: "S111 cafe tester feedback (v174): on a guided route the car icon stays on the route line within 14 m but a parallel road 25 m beside it (still 'on route' for rerouting) and the straight road 40 m beside an exit stretch show the real position, and it snaps back once on the route again; a pinch or +/- zoom holds for 2 minutes against the speed and arrival auto zoom; a voice engine that never starts is reported in settings '소리' and falls back to beeps; coming back from a hidden page (reverse camera) keeps guidance", fn: s111 },
    { id: 'S109', name: "S109 tunnel dark map (v172, driver: 'dark mode in a tunnel, back on exit, stays dark at night'): with night map 'auto', driving into a named tunnel turns the map dark at once, leaving it keeps it dark until 4 s outside and 8 s in total, then light again; GPS lost 100 m before the entrance at speed counts as inside, standing there does not; a parallel road 30 m beside the tunnel, an unnamed tunnel way and 'always light' never darken; on a guided route the route's tunnel stretch darkens", fn: s109 },
    { id: 'S110', name: "S110 public-release privacy (v172 security review): without the operator token a '놓침' report carries nearby camera points and heading but no trace or speed, the token adds the trace and the Authorization header; with '놓침·틀림 위치 보내기' off nothing is sent and the button reads '✓ 저장'; diagnostic upload needs the token; settings have no Naver Client ID or tunnel switch and no per-source credits (v173: OSM and 공공데이터포털 sit beside the map's Naver credit), the server address, diagnostics, demo, sound test and icon admin sit in the developer menu, and every switch is a big toggle", fn: s110 },
    { id: 'S108', name: "S108 '놓침' diagnosis (v171, driver: 'fix it right away when I press 놓침'): pressing after passing a camera hidden by '틀림' unhides it, a camera written for the other direction becomes two-way on this car, a camera 30 m beside the route is taken onto the route — each alerts on the next pass; with no camera nearby a reported spot is saved; settings list undoes a fix; shared fixes (/fixes) apply a direction fix and add a reported spot", fn: s108 },
    { id: 'S107', name: "S107 off-route near turns (v170, driver: rerouted to straight before turning at roundabouts and right exits): a right exit whose route line cuts the corner 100 m early, driven on the outer lane, causes no reroute; missing that exit reroutes within 200 m past it; one extra lap of a 25 m roundabout before the 3 o'clock exit causes no reroute", fn: s107 },
    { id: 'S106', name: "S106 reported spots (v169, driver: '놓침 spots never get updated'): '놓침' saves the spot on this car ~2.5 s back along the trace, the next pass in the same direction shows '내가 신고한 단속 지점' (limit ?) from 500 m, not the other way; settings list shows '이 차에서만 알림' and deleting stops it; spots the driver reported on two days (data/driver_spots.json) alert every user", fn: s106 },
    { id: 'S105', name: "S105 after the v165 sweep (v167): rows passed together are judged by lane points — a point 50 is not passed with a signal 50 whose stop line is 51 m earlier (보개원삼로), a 60 sharing the 50's lane point does not show after it (복합물류로); with no route section name an elevated/underground camera on a fast road parallel to the route stays (a street-named section still drops it)", fn: s105 },
    { id: 'S104', name: "S104 camera pick, 2nd audit (v165): road names match across notation (분당-수서간고속화도로 = 분당수서로, 동부간선도로 = 동부간선로; 중앙로 ≠ 중앙고속도로); a route within 15 m of the raw position (stop-line-moved lane point 18.8 m) or within 20 m with the same road name keeps the camera (25 m still dropped, S14); expressway booths typed as ordinary roads stay on an expressway route; an entry-only highway span ends where the section name becomes a street; elevated/underground cameras stay on fast roads; opposite rows aren't passed; curve tangent", fn: s104 },
    { id: 'S103', name: "S103 tunnel cameras (v163 audit 8): on the route, a camera 3.6 km inside a tunnel is alerted from 300 m before the entrance (beyond the 3 km scan), and with GPS lost inside, a 1 s dead-reckoning tick along the route at the last speed counts the distance down and passes it", fn: s103 },
    { id: 'S102', name: "S102 report outbox & camera data retry (v163 audit 9/10): a '놓침' the server did not take reads '저장함' and stays queued, is resent later, '✓ 보냄' only on 200; with no camera data a '단속 카메라 자료 없음 · 다시 받는 중' pill shows while driving and goes once the data loads again", fn: s102 },
    { id: 'S100', name: "S100 road colour guide lines (v162, 운전자 '녹색 분홍색 안내선'): within 1 km of a highway fork whose painted line the route really follows, the card shows '분홍색 유도선 따라가기' in that colour; the main line, both branches or neither → nothing; gone after the branch end; real data keeps 경부 북행 신갈분기점 (녹색 인천·분홍 원주) but drops 하행 (좌우가 실제 갈래와 반대); real routes 서울TG→판교분기점(구리) and 팔당→하남분기점(판교·서하남) show 분홍색; v245: the colour row and its split picture are never drawn (driver's hard rule) — which colour line is followed is still worked out (data only)", fn: s100 },
    { id: 'S99', name: "S99 '틀림' (v161 audit + driver 'wrong may be a wrong limit'): a press within 1 s of the card changing is ignored; one press keeps the camera dimmed with limit '?' and no sound (miss button still there); a second press on another day hides it, except child/elder zone cameras; one-time flags expire after 14 days; settings list undoes them", fn: s99 },
    { id: 'S98', name: "S98 speed sections (v161 audit): a section end that is the next section's start (중부내륙 110) closes and reopens; a new start 56 m before the old end (세종포천/구리포천) is not closed by that end; a stale open section (50) is replaced at the next start (서해안 100); section lengths 1,000× too big are scaled back, 0 = unknown", fn: s98 },
    { id: 'S97', name: "S97 camera pick & pass (v161 audit, real rows): same spot 80 + child 30 shows 30; 50 with child 30 5 m on shows 30 and passes both; child 30 is kept next to a 60; 50 62 m after a 60 shows from 300 m+; passing a 30 does not mark a camera 20 m further on as passed", fn: s97 },
    { id: 'S96', name: "S96 sound-locked notice (v160 audit: after a reload or '새 버전' voice and beeps stay off until the screen is touched, with nothing on screen): parked → nothing (as asked 2026-11-13), driving while locked → '소리 꺼짐 · 화면을 한 번 누르세요', gone on the first touch, not shown when both sounds are off", fn: s96 },
    { id: 'S101', name: "S101 camera data v164/v166 (2026-11-19 data audit, driver '과속단속만 완벽하면 이제 그냥 네비임', '서울 경기 전역을 일단 한번 해봐바'): a pole with a camera for each direction is two rows that point opposite ways on their own lanes and each alerts only its own direction (경수대로 어바인퍼스트 앞 60 both ways, was one row = one direction); lane-split records of one carriageway are not paired (영동고속도로 51.2km 1,2·3,4·5차로); the 수도권제1순환 23.5k booth is 100 on the expressway, not '어린이보호구역 50' (PDF table glued to it); 경부선 307.6 booth (no 'k') is an expressway 100; a school-zone booth is 30; GGB rear cameras read '후면'; section lengths are not 1000× too long; older records of the same camera number are gone (권선초교 J6049's old copy sat in the sea at 125.70) and misplaced ones moved to their address (세종포천 120 ×4 off 긴밭뜰삼거리 50, 개포동역 K0377); changed spots are in unflag; v166: 50s on city roads off the expressway mainline, the 서울양양 19.8K booth at its address, the 세종포천 section end with a direction, no level flags on mobile spots", fn: s101 },
    { id: 'S95', name: "S95 expressway booth limits (v159, 놓침·틀림 reports 11-16~19): the 경기남부 고속도로순찰대 booth list has no limits, so the nearest street camera's 50/60 was used — the 송파IC 10.3k booth never showed (missed twice) and the 판교JC 1.25k booth read '박스형 60' (wrong twice); on a straight 수도권제1순환고속도로 route through each booth at 90 km/h both now show from 500 m+ with the expressway limit 100", fn: s95 },
    { id: 'S94', name: "S94 closer rows on top (v158, 이배재터널 안 '370m 터널 출구까지' above '↗ 230m' looked upside down — 230m was measured from the left turn, 2.0 km from the car): card rows (tunnel, rest, next guide, parking entrance), drawer cards (lanes, junction, camera, section, hi-pass) and small chips are ordered by distance from the car; the next row keeps Naver's distance from the guide above but says so ('230m 좌회전 후', '830m 터널 지나'); rows within 25 m keep their place, the order changes only once on a 1 km sweep, hidden rows go back to HTML order", fn: s94 },
    { id: 'S93', name:"S93 U-turn picks the approach camera (v157, 송파IC 진출램프 끝 유턴: we showed 위례중앙로 50, Naver and the road show 30): after the highway exit guide a section still named '수도권제1순환고속도로' no longer hides the ramp's signal+speed 30, the card 80 m before the U-turn reads 30, and the 50 on the road we turn into is dropped; with equal limits the 50 is dropped too (v237: a stop-line signal camera of the road we turn into, whatever its limit)", fn: s93 },
    { id: 'S92', name: "S92 split-then-merge (v156, 수도권1순환 북행 '분기도로 진입' showed '직진'): a direction-less fork on the mainline reads '분기 후 합류' like Naver, with the JC icon whose two arrows go round both sides of the island (symmetric, two arrowheads) and no junction picture; a keep-left on the same mainline is still '직진'", fn: s92 },
    { id: 'S91', name: "S91 highway fork lanes (v153, 신갈분기점 '차선표기'): the next fork cross-section within 1 km shows its lanes in the drawer; the lanes that lead to the branch the route really takes are blue (exit → only the exit lane, main → the through lanes without the bus lane); nothing when neither branch is on the route; real data/forks.json loads", fn: s91 },
    { id: 'S85', name: "S85 hi-pass lanes only for the direction you are driving (v142, driver '가는 방향이 있어 확실히 있는 거야?'): the real 경부·수도권제1순환 route both ways (서울TG exit 1-4,14-16 / entry 1-4,9; 성남TG 상행 1 2 3 8 9 11 / 하행 1 2 3 6 7 9), ring road near-sideways heading = common lanes only, same name for a closed and an open office (대동·서영암·가락) = no lanes", fn: s85 },
    { id: 'S84', name: "S84 hi-pass lane row never cut off (v142, 성남TG 하행 1 2 3 – 6 7 – 9 ran past the card): few cells stay beside the badge, many go under a centred badge, centred, and wrap or shrink so every number shows (4, 9, 12, 14, 16 cells; toll next and toll second)", fn: s84 },
    { id: 'S82', name: "S82 bus-only lanes and the map lane callout (v139, user saw Naver's '[↰][↑][↑][bus]'): bus lanes drawn as a grey bus and never blue unless the turn exists only there; a white callout at the next turn's stop line from 1 km, blue lanes for this turn, left of the stop line for right turns; nothing where there is no lane data", fn: s82 },
    { id: 'S80', name: 'S80 real Gyeongbu northbound route (v135): opposite-carriageway rest stop dropped, section-end camera alerted without its start, no reroute in the Seoul toll plaza or on 0.3 s of 10 Hz jitter, reroute 60 m off outside it', fn: s80 },
    { id: 'S81', name: 'S81 signal cameras sit at the stop line of the approach they enforce (v138, 길동사거리 left turn): our approach camera is warned, camera distance ≤ turn distance, the cross street camera is not', fn: s81 },
    { id: 'S87', name: "S87 the '놓침' button shows it was pressed (v147): at least 116×52, turns blue '✓ 보냄' at once, a second press within 2.5 s sends nothing, then back to '놓침'", fn: s87 },
    { id: 'S86', name:"S86 destination parking entrance (v145, '기흥역엘리시아트윈101동입구' looped the block): '…101동주차장입출구' counts as an entrance and wins over the nearer 102동 one, the 8 m turn into it is not announced, a 'P 101동 주차장 입출구' row near arrival and a P mark at the route end", fn: s86 },
    { id: 'S88', name: "S88 zoom keeps following (v148, driver '확대 축소하면 갑자기 내 방향이 풀려버린다'): while following, pinch / double tap / wheel zoom is done by the app around the car (library zoom off), following and the heading-up drive view stay, even when the first finger slid before the second; free look gives zoom back to the map library", fn: s88 },
    { id: 'S89', name: "S89 long-press place card (v148, '지도를 찍어서 선택하면 간단한 정보랑 위치 찍을 수 있게, 경유지나'): a short tap or a moving finger opens nothing; a long press (or right click) drops a blue pin and a card with the place name, category and distance; '여기로 안내' routes to the place; while navigating '목적지로' and '경유지로' (adds a waypoint and reroutes)", fn: s89 },
    { id: 'S90', name: "S90 destination search (v148, '목적지 검색이 너무 어렵다'): plain + district + neighbourhood queries merged, name match then distance (13 km downtown stores last, a non-matching hit after the matching ones), a typed region is searched as is, address-looking text puts addresses first, quick category buttons, waypoint search ranks by distance to the route ahead", fn: s90 },
    { id: 'S83', name:"S83 one left/right per guidance (v141, 송파IC '오른쪽 진입' drawn as a left exit): every sided icon's arrow tip is on its side, and on 20 real Naver routes the sentence's side = icon kind = drawn arrow = junction picture; a code/sentence conflict follows the sentence", fn: s83 },
    { id: 'S75', name: 'S75 (info) cameras alerted on every saved real route, for comparing versions', fn: s75 },
    { id: 'S74', name: 'S74 camera score on 2026-11-15 real cases (13): false alerts / misses / wrong type, with and without navigation', fn: s74 },
    { id: 'S73', name: 'S73 no spoken overspeed words (과속/초과): limit beeps and the red card only', fn: s73 },
    { id: 'S72', name: 'S72 opposite-lane cameras: two-way cameras more than 10 m left of the route are skipped (Munjeong, Bokjeong, Geumgok IC regressions)', fn: s72 },
    { id: 'S71', name: 'S71 signal camera alert clears as the car passes it (2 m past), even with fixes 17 m apart, on route too', fn: s71 },
    { id: 'S70', name: 'S70 a reroute refused by the route server (429) retries quietly after the given time, no failure message; v175: a first route search refused with 429 also retries once quietly and shows the route card', fn: s70 },
    { id: 'S69', name: 'S69 signal cameras: warning kept only 5 m after passing; no spoken speeding line (beep instead); straight underpass entry shows the tunnel icon and "OO지하차도까지"', fn: s69 },
    { id: 'S68', name: 'S68 free drive with a wrong GPS heading still catches the speed camera ahead (track bearing); a camera passed without an alert is counted as missed', fn: s68 },
    // v184·v186: 멀리(경로 시작점에서 80km) 주행 화면으로 달리므로 맨 끝에 (앞에 두면 S86→S88 의 지도 상태가 흔들린다)
    { id: 'S119', name: "S119 cameras the driver confirmed (v186, data/driver_spots.json with a limit: 신중부대로·남북대로 80): a row's own limit is kept, it alerts as '운전자 신고 단속 지점' 80 from 900 m along a route in its direction, not on the way back; v188: my own '놓침' spot 75 m behind it in the same direction is the same camera (one row, status '모든 사용자에게 반영됨'), facing the other way it is not", fn: s119 },
    { id: 'S121', name: "S121 side-road slow cameras beside any fast road (v190, driver 2026-11-23 '정확히 우리길이 아닌데 잡는 경우 확실하게 개선'): guided on 올림픽대로 an unnamed school-zone 30 10 m off is not on the route while an unnamed 80 10 m off and a 30 named 올림픽대로 10 m off are; guided on an unnamed local route at 80 km/h an unnamed 30 10 m off is on the route but not alerted, at 40 km/h it is; free drive with reverse-geocode giving the side road name, at 80 km/h a 30 named after that side road 10 m off does not alert while a 30 2 m off the path does, and at 40 km/h the 10 m one alerts", fn: s121 },
    { id: 'S120', name: "S120 side-road cameras beside an expressway (v187, driver's '틀림' 2026-11-23 on 경부 southbound south of 신갈JC at 50 km/h: the 신정로 상미사거리 school-zone 30 #20526, 23 m beside 경부, showed because a '놓침' three days earlier had put a 'route' fix on it): with that fix it is still not on a 경부 route; a '놓침' pressed after passing it fixes nothing on it; free drive on 경부 at 50 km/h drops a school-zone 30 10 m to the side; expressway cameras (on the line, and 25 m off with a 'route' fix) still alert, guided and free", fn: s120 },
    { id: 'S122', name: "S122 camera signs from the AI atlas (v192, driver: '이런거는 ai 아틀라스로 만들고', '원래 우리 스타일대로 해 줘'): the warning card keeps our original layout (long kind name, distance, gauge; ring red, blue for mobile/box/reported); map markers are 36 px with a small camera (traffic light for signal+speed); a picked AI atlas sign (img/ai/cam_*) replaces the drawn sign on the card and the map marker with the limit on top, a sign drawn with its number (cam_speed_80) is shown as it is with the overlaid number hidden; a 구간단속 camera keeps the drawn sign", fn: s122 },
    { id: 'S123', name: "S123 tunnel dark in one go and no white flash (v193, driver: 'GL 모드에서 터널에 들어가 다크 모드로 바뀔 때 너무 느리게 탁 탁 탁 … 한번에 딱', '가끔 주행 중 화면이 하얀색으로 번쩍'): a daytime tunnel keeps the day map style and only inverts the GL canvas (instant, day route palette, night UI), undone at once on exit; at night the dark style is used and the map box background is dark instead of the light rgb(248,249,250) that showed through", fn: s123 },
    { id: 'S124', name: "S124 spots checked on Naver guidance (v194, driver: '네이버지도 과속단속을 나는 제일 신뢰하니까 저걸 기반으로 넣어줘'): place text 'A→B' saying my direction no longer keeps a camera that crosses the route at 77° (둔촌사거리 25557) — along (0°) or written the other way (180°) it still decides; a driver spot with kind 3 reads '운전자 신고 신호·과속단속', with the rear flag '운전자 신고 후면단속' and after passing '후면단속 중'", fn: s124 },
    { id: 'S125', name: "S125 other-route bubble during guidance (v195, driver: '가능하면 이런 기능도 있으면 좋을거 같긴 해' — Naver's '3분 증가 · 874m 증가 · 통행료 없음'): the traffic refresh asks for several options in one request, keeps the current option's route, and offers the other one that branches 1.2 km ahead as a light line and a bubble (time, distance, toll, traffic bar); tapping it switches to that route, passing the branch without tapping clears it; going south and west the bubble stands upright over its tail (raster and Leaflet maps rotate the map box, keys session saw it upside down)", fn: s125 },
    { id: 'S126', name: "S126 anonymous camera pass records (v196, driver '지나간곳 모조리 체크해서 과속 단속 체크해줘 신고를 하지 않았더라도 내역도 남겨놓고'): passing a camera in its direction records alerted (card distance) or missed, the other direction is not counted, an unknown limit counts as hidden; the batch has only camera number, alert, 5 km/h speed, limit, nav, date — no position, time or sid; a 90→60→90 dip with no camera within 400 m is a 100 m-cell candidate, a jam is not; the operator car adds the camera spot and trace; the settings switch stops it", fn: s126 },
    // S130 (그린 분기 그림 시험) — v245 고정 규칙(운전자 AI 그림만)으로 빠짐, S160 이 대신 확인
    { id: 'S131', name: "S131 resume after reversing (v200, driver '직진했다가 후진할때 후방카메라가 켜지는데 브라우저가 꺼져도 세션이 남게해서 유지할수는 없나'; /events show the Tesla reopens the page with a new sid about 80 s apart at 0 km/h): guidance, the section start time and distance, and a manual zoom are kept in localStorage every 5 s and on hide/close; a reopened page picks the guidance up at the first fix with no route card, no route request and no start speech, the sound pill shows while locked; without the stored route it quietly asks once; older than 30 min or after ending guidance nothing is kept", fn: s131 },
    { id: 'S132', name: "S132 Naver two-way check, round 1 (v201, keys session emulator; driver rule '다르거나 없으면 네이버대로') and the 판교분기점 first-split pink line: driving straight past each spot in Naver's direction puts its camera on the route — 별내 송산로 southbound 60 signal+speed, 강동대로 north southbound child-zone 30, 25719 westbound 30, 둔촌사거리 25557 (moved 85 m to Naver's point) east- and westbound 50, 난곡로 23871 south-westbound 30; on the real 서울TG→판교분기점 route the first colour line starts about 300 m before the split, pink", fn: s132 },
    { id: 'S133', name: "S133 one '잘못된 정보 신고' button and the live check (v202, driver '틀림 놓침에서 틀림 없애고 놓침을 잘못 된 정보 신고로', '신고 반영 완료 … 3초', '확인완료 … 신고 접수 완료'): one button, the old one hidden, no '놓침'/'틀림' on screen; pressed while a warning card has been up for a second it reports that camera (dimmed 14 days, no check request); pressed with no card it says '신고 접수 완료' and sends /check (spot, heading, speed, device; no trail off the operator car) keeping the id; a found result reads '신고 반영 완료 · 60 신호·과속단속 추가' and reloads shared fixes, a none result reads '확인 완료'", fn: s133 },
    { id: 'S134', name: "S134 voice feedback above the compass (v203, driver '그 나침반 위에 피드백 버튼 … 음성으로 텍스트 형태로 … 다시 음성을 누르거나 다른 곳을 누르면 취소', 'Ai 대화모드처럼'): with a fake speech recogniser — a 52 px round button right above the compass; a tap starts Korean listening with the green spinning ring and '듣는 중…'; 1.5 s after the words stop the text is sent at once (with place, heading, speed, guidance and the cards on screen) and '보냈어요' shows; a tap elsewhere or a second tap cancels without sending; a browser without speech recognition says so", fn: s134 },
    { id: 'S135', name: "S135 time-limited school zones (v204, driver '이것도 중요하긴 해'; Naver shows 50 at night after '표지판 확인') and the 경부 northbound mobile 110s: around the real child-zone camera 25719, a test school with 30 from 08–20 and 50 otherwise makes it 50 at 22:00 (the warning card too) and 30 at 10:00, cameras outside the radius stay; weekday-only rows give 50 on a Sunday; windows across midnight work; clearing the data restores 30; the 죽전 mobile 110 moved 71 m north to Naver's point and a 판교 northbound mobile 110 was added, both '운전자 신고 이동식 단속'", fn: s135 },
    { id: 'S136', name: "S136 camera card sign alignment (v205, driver '가운데로 정렬 해서 보여줘야 되는 거 아니야 110 너무 밑에 있는 느낌이다'): in the Tesla drawer the round sign's top meets the label's top and its bottom meets the distance's bottom (the bar sits below), for section-end, fixed, mobile and child-zone cards alike; v244: the number in a non-picture sign (section cards) sits in the middle of the ring (an empty icon slot pushed it about 5 px down), and a card the driver reported reads '내가 신고함' with '?'", fn: s136 },
    { id: 'S137', name: "S137 voice feedback reachable and readable (v206, driver '피드백 음성 버튼이 일단 무슨 버튼인지 잘 모를 거 같고 눌러도 반응이 없어'): during guidance with a camera card, the mic sits in the glass card's compass row, a real tap lands on it and never on the '잘못된 정보 신고' pill (if the pill reaches the card, the card hides and the mic takes no taps); the card is opaque enough over map labels; every failure is shown and logged by stage: start() throwing, a 'network' error, and no onstart within 4 s; a good start logs tap, start, onstart, onaudiostart", fn: s137 },
    // S138 (그린 분기 그림 시험) — v245 고정 규칙(운전자 AI 그림만)으로 빠짐, S160 이 대신 확인
    { id: 'S139', name: "S139 Naver-checked driver spots look like normal cameras (v208, driver: '운전자 신고 신호 과속 단속 이라고 파란 글씨로 나오는데 … 네이버 지도는 신호 과속 이라고만 표기 하는데'); route line and turn arrow thicker with zoom and a black outline (v208, '여기도 네이버지도처럼 약간 두껍게', '검정색 테두리로 통일하자'): rows with flag 2 read '신호·과속단속' / '이동식단속' with the red (or real-mobile blue) card, sign and voice of normal cameras, flag 4 makes a child zone, /check finds count as checked, unchecked rows keep '운전자 신고 …' in blue; in the data all 20 rows are checked (v210); the route width grows with zoom (9 → 14 → 17 px at 15/17/18) under a black casing 4 px wider, and the arrow's rim is black", fn: s139 },
    { id: 'S140', name: "S140 arrival like Naver (v209, driver '네이버 지도 보면은 도착지점 거의 도착할 때 화살표로 알려 주잖아', '도착 건물에만 나오면 될 거 같아 화살표로 들어가는 것까지 표기 해 주면 좋을 것 같다'): the last turn before the goal stays its own row (row 2 shows ↰ with its distance, then the goal pin); from where the route ends a thick white arrow with a black outline goes into the building instead of the dotted line, and the goal distance counts to the building; with no turn left, the row says which side the building is on ('목적지 · 왼쪽/오른쪽' with an arrow-and-pin icon); a walk from a parking entrance keeps the dots; v246 (driver at 더샵강동센트럴시티오피스텔: the straight arrow cut through the apartment blocks): the arrow into the building is at most 20 m, then dots to the pin", fn: s140 },
    { id: 'S141', name: "S141 arrow size has a limit (v211, driver '저 확대한다고해서 저화살표가 계속 커지는게 아니고 어느정도 한계가 있다고봐야 해 크기가 너무 커져도 이상해져버리니까'): route line and arrows stop growing at zoom 18 (16px); on the GL map the arrow head is sized for the GL scale (it was drawn twice as big as meant); an arrow that was removed stays hidden even if the map puts it back; a last turn just before the route end joins the building arrow into one arrow (all arrows go away on arrival); a short stretch after the last turn still points the head the way you turn", fn: s141 },
    { id: 'S142', name: "S142 wider trip card and a gap above the speed (v212, driver '너무 붙어있는 느낌이라 조금 와이드하게 UI 개선해주고 속도도 조금 갭을 줘'): the bottom-left glass card is wider with even cells and a thin line under the compass row; on a wide screen the big speed sits the card's height plus 18 px above it (it used to touch the card), and only the speed hides when the drawer or report button reaches it", fn: s142 },
    { id: 'S143', name: "S143 old driver reports checked on Naver both ways (v213): 용구대로 60 (row 21232) moves to Naver's northbound point and faces north, without the old '보정역→구성역' place text; 남북대로 80 (row 19618) is a rear camera like Naver; a missing 신호·과속 50 on 비룡로 (남양주 화도) is added as a checked spot; 신갈JC has one 이동식 110 spot, moved 210 m north to Naver's point in v214", fn: s143 },
    { id: 'S144', name: "S144 report's nearby cameras say where each came from (v215, keys 2026-11-24: an 울산 report listed the driver's own 놓침 spot, limit 0 and no direction, and the admin page showed it as a real camera '과속 제한 모름'): src 'cam' for police fixed cameras, 'mobile' for box and mobile points, 'spot' for spots the app adds, with who ('mine' this car, 'driver' driver or shared spot, 'crowd') and nv for Naver-checked", fn: s144 },
    { id: 'S145', name: "S145 single-pole camera pairs follow their place text (v216): in 184 pairs the two records swap directions so each direction matches its own 'A→B' text (lane point moves with the direction); 6 pairs stay as before (5 where the two records differ in school or elder zone, until Naver shows which way the zone is, and 6741/6742)", fn: s145 },
    { id: 'S146', name: "S146 test runs never reach the real server (v219: synthetic passes reached production when a non-test page on the same origin — the S67 catalog frame or a hand-opened index.html — read the harness's saved queue): on the test page the send queues are stored under their own '@test' names, records made here carry x: 1, and pass records dated after today (a fake clock) are dropped before sending", fn: s146 },
    { id: 'S147', name: "S147 Naver verdicts on zone pairs and duplicate poles (v220-v223): labels, limits and rear flags follow Naver's badges, and duplicate records Naver does not show are switched off (kept in the data, left out of lookups) — 평인일주로 138° is a school-zone speed camera, 신재로 is school zone both ways, 해안로 is a school-zone signal-and-speed camera both ways, 적중로 is 50 (253° rear), 17755 moves to Naver's point without its place text", fn: s147 },
    { id: 'S148', name: "S148 Naver verdicts on the 18 single cameras (v224): wrong directions turned to Naver's, two-way cameras lose their one-way place text, records Naver does not show (and 30 duplicates of 40 or signal cameras) are switched off, 예술공원로 is a rear camera 35 m on", fn: s148 },
    { id: 'S149', name: "S149 feedback button panel (v225): when speech recognition fails like on the Tesla (network), the panel opens with a record button and five picture buttons, later taps open it directly, one tap sends with the cards from the moment 의견 was tapped, a recording is queued until the server takes it, and a denied microphone leaves the picture buttons", fn: s149 },
    { id: 'S150', name: "S150 heading-aware routing (v227): stopped at a light heading north with the destination behind, every route request starts ahead of the car; a route that starts by reversing is asked again further ahead (first route and reroute), a reversing traffic update is dropped, and a car parked over 3 minutes is not given a heading", fn: s150 },
    // S151 (그린 분기 그림 시험) — v245 고정 규칙(운전자 AI 그림만)으로 빠짐, S160 이 대신 확인
    { id: 'S152', name: "S152 arrival pin on the building (v228): a destination that is a building's entrance puts the 도착 pin on that building (its N동, else the complex), the route still ends at the parking entrance or the chosen entrance, the dotted walk and the arrival arrow go to the building, and plain places or far namesakes are left alone", fn: s152 },
    { id: 'S153', name: "S153 trip end and continuation (v229): an 11-minute stop while navigating stays one trip, a reload keeps the trip while navigating (ends without), arrival ends it after a minute stopped even without further GPS, and closing the page after arrival sends the end with keepalive while a mid-drive reload does not end it", fn: s153 },
    { id: 'S154', name: "S154 dark from the first frame (v230): index.html decides night before any CSS or script (setting, or sun height at the last rough position), the page background is dark at once, the font CSS does not block painting, a night GL map hides its day style until the dark style is ready, and /event carries the anonymous device id", fn: s154 },
    { id: 'S155', name: "S155 intersection cameras only for their approach (v236, the driver's 강동세무서 drawing): turning left into the direction of a camera that enforces the leg before the junction gives no alert and is not a miss; going straight on that leg alerts; a camera on the new road past the junction alerts; passing a 30 camera on a parallel road at 90 km/h is recorded as another road, not a miss", fn: s155 },
    { id: 'S156', name: "S156 the intersection camera rule everywhere (v237, driver '그런 건 전국에 다 해당되는 건 알지?', '직진으로 오는 차였으면 저기에 50 단속이 있으면 감지해주는 게 맞고'): on seven synthetic junctions (4-way left and right, T-junction, 60 and 120 deg skewed lefts, a U-turn on a divided road, two-way cameras on a crossing road), guided and free: a camera at the stop line of the leg the car turns into (one-way or two-way) never alerts, a camera on the new road past the junction and on the car's own approach does, straight through on the camera's leg alerts with limit 50 at the normal 400 m; a two-way camera on a crossing road does not alert or record a pass for straight-through traffic; a left-turn pass of the stop-line camera is 'turned', the new-road camera is a normal pass", fn: s156 },
    { id: 'S157', name: "S157 riding out a route server blip (v239, 2026-11-25 Worker /route failed for minutes with Naver 530): the first search falls back from options= to one option= after an upstream 'no route' and retries a 502 after a short backoff, then shows the route card; a reroute that keeps failing retries 3 times and stops, keeping the current route and guidance (no red failure toast, a small status chip, a diag note) and guidance keeps advancing; the next good reroute clears the chip; a 400, Naver's own 'no route' (with a code) and the traffic refresh are not retried", fn: s157 },
    { id: 'S158', name: "S158 junction lane colours match Naver (v243, Naver comparison table cases 8 and 13): the ring road's southbound 성남IC exit to '성남, 광주' gets a green colour line from about 300 m before the split and the junction picture paints the lanes green (the separate colour row hides); 판교분기점 '일산, 구리' paints pink; an 일산-bound car now sees the first-split pink too (OSM shape), while going straight on 경부 (서울·양재) or straight past 성남IC southbound gets neither; v245: the junction slot shows only the driver's AI picture (no painted lanes) while the colour data stays", fn: s158 },
    { id: 'S159', name: "S159 taking back a mistaken report (v244, driver on 경부 상행 near 서울TG: '잘못된 정보 신고' on a section-end card left a lingering '?' card, then '근데 내가 잘못 신고 한거 같애'): after reporting, the dimmed '?' card reads '내가 신고함' and the button becomes '↩ 신고 취소'; pressing it brings back 110 and clears this car's mark and the settings list; a report from another day keeps the normal button; the release clears the mistaken 22040 mark made before its cut-off but keeps later ones", fn: s159 },
    { id: 'S160', name: "S160 hard rule — junction pictures are only the driver's AI images, in the drawer (v245, driver 2026-11-25 '내가 만든 AI 그림으로만 밑에다 보여 주는 거지. 저렇게 보여 주면 안 돼', first said 2026-11-15 v108/v109): 100 m before 판교분기점 '일산, 구리' the drawer slot holds just the two AI pictures (day/night) with the sign fully shown, no drawn svg, no perspective or top-down scene, no split picture or colour row on the guidance card while the pink line is still worked out; without the AI picture for that kind there is no junction slot at all (no drawn fallback); the 성남IC exit is AI-only too; v246: the sign of the branch we do not take is shown too (the road we leave, '① 경부 ↑')", fn: s160 },
    { id: 'S161', name: "S161 turns that follow closely (v246, driver '우회전하고 또 우회전 하는 상황, 성남으로 들어올 때 좀 많이 헷갈리게 돼 있더라. 미리 보여주는 거 조금 개선이 필요해', 성남 여수사거리 east: right, 30 m left, 220 m right): 150 m before the first turn the next row becomes a green '이어서' row with a big arrow, '30m' and '› 220m' for the turn after; the 300 m voice adds '이어서 30미터 앞 왼쪽 방향, 다시 220미터 앞 오른쪽 방향'; a next turn 400 m away keeps the small row", fn: s161 },
    { id: 'S162', name: "S162 Naver-style junction picture jx (2026-11-25, driver sent Naver's 성남IC junction view: '그냥 네이버지도처럼 만들어 달라니까, 자바스크립트로 그리지 말고 AI로 — 헷갈리고 사고 날 것 같아 방향 잘못 틀어서'): with jx AI pictures picked, 100 m before 판교분기점 '일산, 구리' the drawer slot is the 3:2 AI picture (day/night, no drawn svg, not mirrored), the route sign '일산' sits on the right board and the other branch '경부' on the left board, both inside the picture and not cut, and '일산' is painted under the green lanes on the right; at the same junction from 학의 ('구리, 성남', keep left on the main road) the 'stay' picture is used as is with the route sign on the left board; without jx pictures the old AI picture is used; the left fork '서울' (팔당→하남IC) mirrors the fork picture and swaps boards and the painted name", fn: s162 },
    { id: 'S163', name: "S163 joining a section after its start camera (2026-11-25, driver's rule '시작점 뒤에서 들어오면 구간단속은 해당 안 됨'; real case: 신갈동 → 경부 상행 about 1.7 km past the 신갈→죽전 110 start camera, the end camera was still shown as '구간 110' from 2200 m): synthetic OSM-shaped routes — the control route from 2 km before the start camera opens the 110 section and shows the end camera as the section end; the join route must show no section card, no average meter and no section voice; v251, as Naver does (keys session check): the end camera is an ordinary '110 과속단속' camera (red 110 sign, yellow '과속단속' tag, voice '단속 카메라. 제한속도 110')", fn: s163 },
    { id: 'S164', name: "S164 cameras past a U-turn point (v248, driver 2026-11-25 08:41 at 야탑역사거리 southbound on 성남대로: '이건 유턴이라서 지나가는 게 아니라 안 나와도 돼, 네이버지도 봐봐'): the southbound signal/speed 60 (#22941) has its stop line 11 m past the U-turn point, so on the U-turn route it never shows; on a straight route through the same spot it is still announced", fn: s164 },
    { id: 'S165', name: "S165 '비보호' badge and square lane boxes (v248, driver 2026-11-25: '우리는 비보호를 여기다가 써줘도 좋을 거 같아' at the top right of the guidance row, and '네이버지도 화살표 안내 쟤네는 정사각형인데 우린 약간 세로로 길잖아'): an unprotected left turn shows a blue '비보호' badge at the top right of the turn row and drops the word from the text ('좌회전 · …'), the next guide has no badge; the map lane tip draws every lane as its own 30×30 box with a 3 px gap", fn: s165 },
    { id: 'S166', name: "S166 the branch we do not take, lane names and lane colour (v249, driver 2026-11-25 with Naver's 판교분기점 '일산 안양 | 판교': '여기는 일산 안양 이렇게 알려주잖아 … 차선이랑 바닥에 있는 것도 저렇게 다르게', and 신갈분기점 '초록색 따라가게끔'): at 판교분기점 from 학의 ('구리, 성남', staying on the main road) the other sign shows the OSM ramp destinations '부산 대전'; with Naver-style pictures the other board says '부산 대전', the route lanes are painted '구리/성남' and the other lanes '부산/대전', and the picture is the sky-blue variant (no colour line); at 판교분기점 from 서울TG ('일산, 구리', pink colour line) the pink variant is used", fn: s166 },
    { id: 'S167', name: "S167 junction pictures matched to Naver (v253, jx comparison table): no picture for a main-road stay without lane data (판교JC from 학의) or an unnamed city fork (팔당 '서울'); a picture for 신갈JC '대전' (stay with lane data) naming the ramp '인천, 원주'; 서하남교차로 keeps Naver's '왼쪽 방향' and names 하남 on the other board; 기흥IC exit is 2+2 pink, 신갈JC '원주, 인천' 4+1 green, 판교IC 2+2 with both route lanes '분당/판교'", fn: s167 },
    { id: 'S168', name: "S168 lane counts from OSM where there is no HD-map lane data (v255, parent session: Naver 하남분기점 4+2, 서하남IC 2-lane exit): at 하남분기점 (중부 westbound, '판교, 서하남') and 서하남IC ('강동, 서하남') OSM gives 2 route lanes + 4 other lanes, so the picture is 4+2 when one is picked and the closest existing shape (2+2) until then; 성남IC (ramp lanes not in OSM) stays 4+1; 판교IC (HD-map 'SB|S|S|S|S|R|R') becomes 4+2 too once picked", fn: s168 },
    { id: 'S169', name: "S169 Naver-style junction picture v2 (v256, parent session checklist after the driver's 성남IC complaint '봐바 이거 안돼 … 비슷하게 좀 만들어 줘'): with v2 pictures picked, the picture is 4:3 and as wide as the drawer; the shape follows the real lane counts (성남IC 4+1, 판교분기점 from 서울TG 4 + 1 + 2, 하남분기점 4+2, 신갈분기점 '대전' main road 4 + exit 1 with the bus lane not painted); every visible lane carries a bold label about a third of the lane width tall, the lanes not taken say the OSM destination at that split ('서울') or else the road name ('중부', board '수도권제1순환'; v257: never a rest-area direction city), the exit board has no route shield and an exit-number tab ('2B 성남'), and the route lanes at 판교분기점 are green 1 + pink 2", fn: s169 },
    { id: 'S170', name: "S170 driver feedback after the v262 night drive (2026-11-26): with the turn 3.4 km away the '이어서' row leaves the card and becomes a chip beside it ('↱ 160m'), near the turn the row stays; a far rest area is a chip under the turn chips (closest first); remaining distance, time, ETA and '안내 종료' sit in the bottom-centre bar, not in the card; with a waypoint the top line is the waypoint with an orange '경유' tag and the destination below; the trip card is bottom right, the feedback button bottom left; lane labels follow each picture's measured lane centres (day and night sets)", fn: s170 },
    { id: 'S171', name: "S171 camera fixes from the Naver check of the night-drive reports (2026-11-26): rear cameras look like Naver's '60 후면단속' — black band '후면단속', voice '후면단속 카메라', after passing '후면단속 중' with the speed warning for about 100 m (마북 삼거리 #21024 southbound); the 분당수서로 signal camera #22322 above 백현지하도로 is not given to a car in the underpass below (Naver's 백현지하차도 entry guide 1.24 km before; the same route driven on the surface — section 분당수서로, entry guides turned into straight guides — still gets it); 탄천 80 #22931/#22952 sit on Naver's pole and the warning distance matches it; the four Naver rear cameras carry the rear flag", fn: s171 },
    { id: 'S172', name: "S172 junction-picture lane labels like Naver (v267–v268, parent session side by side with Naver's 330 m pictures): one label size per picture (two-line labels 86% of it), the label row low in the picture with no label below the picture's bottom edge, no two labels overlapping (2 px apart at most), labels centred inside the picture; through lanes say what Naver says at the checked spots — 서하남IC '구리 대전' (board still '구리'), 판교IC '대전 부산'", fn: s172 },
    { id: 'S127', name: "S127 tester routes (v198, driver '어차피 다 테스터이고 익명이라서', '출발지 도착지 모두 남는 방향으로 … 원본은 30일 뒤에 자동으로 지우는걸로'): the one-line notice shows only when parked (nothing recorded while driving before it); the route is kept from start to end at 2–5 s, camera passes carry the card distance, every trip gets a new random id, no device or session id; pass statistics off marks the parts ps 0; the settings switch clears and stops it", fn: s127 },
  ];

  // S55: 주의 표지 (전국도로안전표지표준데이터의 주의표지, data/signs.json · tools/build_signs.py, 2026-11-14 요청).
  //      시험 경로(북쪽 600m → 동쪽 480m)에 표지를 직접 넣어
  //      (a) 경로 오른쪽 6m 미끄러운 도로 표지(450m)는 300m 앞부터 '미끄러운 도로 250m', 지나친 뒤 150m 는 '주의'
  //      (b) 경로 왼쪽 9m 오르막 표지(250m)는 반대 방향용 → 안 알림  (c) 300m 떨어진 표지 → 안 알림
  //      (d) 꺾은 뒤 동쪽 길 오른쪽(남쪽) 7m 낙석 표지 → '낙석 주의'  (e) 길안내 없이 같은 길: 바로 앞 표지만
  //      (f) 설정을 끄면 숨김  (g) 실제 data/signs.json 이 읽힌다 (지자체 자료 있는 곳만)
  // S57: 길을 벗어나면 빠르게 다시 찾는다 (2026-11-14 신갈 주행: 새 경로가 이미 지나친 교차로에서 북쪽으로 시작해
  //      차는 동쪽으로 가는데 20초 넘게 엉뚱한 경로를 보여 줌)
  //   (a) 북쪽으로 가다 오른쪽(동쪽) 길로 꺾으면 30m 를 기다리지 않고 2번(2초) 만에 벗어남으로 본다
  //   (b) 재탐색 출발점은 차 앞쪽(동쪽)
  //   (c) 새 경로가 차 뒤에서 시작해(그 교차로에서 북쪽으로) 한 번도 못 올라타면 20초를 기다리지 않고 바로 한 번 더 찾는다
  //   (d) 그 다음 경로도 엉뚱하면 그때는 간격(20초)을 지킨다 (끝없이 묻지 않게)
  //   (e) 올바른 경로가 오면 올라타고 더 묻지 않는다
  async function s57() {
    const t = T(), R = buildNavRoute(), r = {};
    const mk = (pts) => {   // 점들로 만든 경로 응답 (Worker 모양)
      const path = pts.map((p) => [round6(p.lng), round6(p.lat)]);
      const P = path.map((x) => ({ lat: x[1], lng: x[0] }));
      let tot = 0; for (let i = 1; i < P.length; i++) tot += hav(P[i - 1], P[i]);
      return { distance: r0(tot), duration: r0(tot / 12 * 1000), tollFare: 0, fuelPrice: 0, path,
        guide: [{ i: P.length - 1, t: 88, s: '목적지', d: r0(tot), ms: r0(tot / 12 * 1000) }], sections: [] };
    };
    await planAndStart(R);
    for (let s = 15; s <= 90; s += 15) { const a = pointAt(R, s); feed(a.p, 15, a.h); }
    const A = pointAt(R, 90).p;   // 여기서 북쪽 경로를 두고 동쪽 길로 꺾는다
    // 재탐색 답: 1·3번째는 차 뒤 교차로(A)에서 북쪽으로 시작하는 엉뚱한 경로, 4번째는 차 앞에서 동쪽으로 가는 올바른 경로
    const stale = mk([A, dest(A, 0, 150), dest(A, 0, 300), dest(dest(A, 0, 300), 90, 300)]);
    let good = null, n = 0;
    stub.canned['/route'] = () => { n++; return n === 3 && good ? good : stale; };
    const c0 = stub.calls.length;
    let pos = A, k = 0, firstAt = null, trigFix = null;
    const step = () => { k++; pos = dest(pos, 90, 15); return feed(pos, 15, 90); };
    while (k < 6 && firstAt === null) { const f = step(); if (stub.count('/route', c0) >= 1) { firstAt = k; trigFix = f; } }
    r.caughtAfter = firstAt;                                         // (a) 꺾은 뒤 몇 번째 GPS 에서
    const q1 = stub.since(c0, '/route')[0];
    if (q1) {
      const [lng, lat] = q1.query.start.split(',').map(Number);
      r.startAhead = r0(hav(trigFix, { lat, lng })); r.startBrg = r0(brg(trigFix, { lat, lng }));   // (b)
    }
    await waitFor(() => !t.nav.busy, 2000, 20);
    // (c) 새(엉뚱한) 경로가 온 뒤 다시 묻기까지
    const k1 = k;
    while (k < k1 + 10 && stub.count('/route', c0) < 2) { step(); await waitFor(() => !t.nav.busy, 2000, 20); }
    r.retryAfter = stub.count('/route', c0) >= 2 ? k - k1 : null;
    const q2 = stub.since(c0, '/route')[1];
    // 다음 답을 위해 올바른 경로(지금 차 자리에서 동쪽)를 준비: 세 번째 질문의 답
    good = mk([pos, dest(pos, 90, 200), dest(pos, 90, 400), dest(pos, 90, 600)]);
    // (d) 두 번째 답도 엉뚱한 경로 → 세 번째 질문은 간격(20초)을 지켜야 한다
    const k2 = k;
    while (k < k2 + 30 && stub.count('/route', c0) < 3) { step(); await waitFor(() => !t.nav.busy, 2000, 20); }
    r.thirdAfter = stub.count('/route', c0) >= 3 ? k - k2 : null;
    // 세 번째 답(올바른 경로)은 질문 때 만든 good 이 아니라 차가 더 간 자리라 차 뒤에서 시작하지만, 같은 길(동쪽) 위라 올라탄다
    const k3 = k;
    for (let j = 0; j < 8; j++) { step(); await waitFor(() => !t.nav.busy, 2000, 20); }
    r.joined = t.nav.onRoute === true;
    r.extraCalls = stub.count('/route', c0) - 3;
    r.active = t.nav.active;
    t.endNav(); softReset();
    const ok = r.caughtAfter !== null && r.caughtAfter <= 3 && r.startAhead >= 5 && r.startAhead <= 60 && Math.abs(r.startBrg - 90) <= 10 &&
      r.retryAfter !== null && r.retryAfter <= 5 && r.thirdAfter !== null && r.thirdAfter >= 15 && r.joined && r.extraCalls === 0 && r.active;
    return { pass: !!ok, detail: 'caught after ' + r.caughtAfter + ' fixes (want ≤3); start ' + r.startAhead + ' m ahead at ' + r.startBrg + '°; ' +
      'stale route retried after ' + r.retryAfter + ' s (want ≤5); next retry after ' + r.thirdAfter + ' s (want ≥15); joined good route ' + r.joined +
      ', extra calls ' + r.extraCalls + (k3 ? '' : '') };
  }

  // S56 (벡터 GL 지도): 지도 라이브러리가 돌린 지도를 직접 끈다. 끄는 동안 방향(지도 회전)은 그대로, '내 위치로', 5초 뒤 복귀
  async function s56gl() {
    // GL 지도의 회전·이동·확대는 requestAnimationFrame 으로 움직인다. 창이 가려져 프레임이 멈춰 있으면 확인할 수 없다
    const rafOk = await new Promise((res) => { let ok = false; requestAnimationFrame(() => { ok = true; res(true); }); setTimeout(() => { if (!ok) res(false); }, 1200); });
    if (!rafOk) return { status: 'SKIP', detail: 'animation frames are paused (hidden pane): GL rotation/pan cannot be checked; run S56 again with the pane visible' };
    const t = T(), r = { gl: true }, prevHup = t.prefs.headingUp;
    const gm = () => t.getMap().map, mb = () => gm()._mapbox;
    const cv = () => document.querySelector('#map .mapcanvas canvas');
    const center = () => t.getMap().getCenter();
    const under = (x, y) => { const b = cv().getBoundingClientRect(); const ll = mb().unproject([x - b.left, y - b.top]); return { lat: ll.lat, lng: ll.lng }; };
    const me = (type, x, y, tg) => (tg || cv()).dispatchEvent(new MouseEvent(type, { clientX: x, clientY: y, bubbles: true, cancelable: true, button: 0, buttons: type === 'mouseup' ? 0 : 1, view: window }));
    const pe = (type, x, y) => cv().dispatchEvent(new PointerEvent(type, { pointerId: 1, clientX: x, clientY: y, bubbles: true, cancelable: true, pointerType: 'mouse', button: 0, buttons: type === 'pointerup' ? 0 : 1 }));
    const drag = async (x0, y0, dx, dy) => {
      pe('pointerdown', x0, y0); me('mousedown', x0, y0);
      for (let k = 1; k <= 6; k++) { const x = x0 + dx * k / 6, y = y0 + dy * k / 6; pe('pointermove', x, y); me('mousemove', x, y, window); me('mousemove', x, y); await sleep(30); }
    };
    const up = (x, y) => { pe('pointerup', x, y); me('mouseup', x, y, window); me('mouseup', x, y); };
    let pos = TRIP_ORIGIN;
    const drive = (n) => { for (let k = 0; k < n; k++) { pos = dest(pos, 80, 15); feed(pos, 15, 80); } };
    try {
      t.prefs.headingUp = true;
      t.setFollowing(true);
      drive(8);
      t.zoomCtl.manualUntil = clock + 1e9;
      await waitFor(() => Math.abs(gm().getRotation() - 80) < 0.3, 4000);   // 들어올 때 돌아가는 애니메이션이 끝날 때까지
      r.drive0 = t.view.drive;
      r.rot0 = Math.round(gm().getRotation());              // 진행 방향 80° 가 위 (지도 회전 = 80)
      const host = document.getElementById('map').getBoundingClientRect();
      const sx = host.left + host.width * 0.5, sy = host.top + host.height * 0.42;
      const c0 = center(), L0 = under(sx, sy);
      await drag(sx, sy, 70, 110);
      r.peek = t.state.peek === true && t.state.following === false;
      r.stillDrive = t.view.drive === true;
      r.followsFinger = hav(L0, under(sx + 70, sy + 110));   // 손가락 아래 지점이 손가락을 따라왔는지 (m)
      r.moved = hav(center(), c0);
      r.pill = visible('#backMe');
      const c1 = center(); drive(1); await sleep(400);
      r.stays = hav(c1, center());                          // 새 GPS 가 와도 보던 자리 그대로
      r.rotKept = Math.abs(gm().getRotation() - 80) < 2;    // 방향은 그대로
      up(sx + 70, sy + 110);
      await sleep(100);
      r.counting = document.getElementById('backMe').classList.contains('count');
      document.getElementById('backMe').click();
      r.btnBack = t.state.following === true && t.state.peek === false && !visible('#backMe');
      const meAt = () => t.motion.cur || t.state.fix;
      await waitFor(() => hav(center(), meAt()) < 3, 3000);
      r.btnCenter = hav(center(), meAt());
      await drag(sx, sy, -80, 60); up(sx - 80, sy + 60);
      r.peek2 = t.state.peek === true;
      await sleep(4500);
      r.notYet = t.state.following === false;
      await waitFor(() => t.state.following, 2500);
      r.autoBack = t.state.following === true && !visible('#backMe') && t.view.drive === true;
      // 휠 확대: 주행 화면·따라가기 그대로
      await sleep(300);
      const z0 = gm().getZoom();
      cv().dispatchEvent(new WheelEvent('wheel', { deltaY: -240, deltaMode: 0, clientX: sx, clientY: sy, bubbles: true, cancelable: true }));
      await waitFor(() => gm().getZoom() > z0 + 0.1, 2000);
      r.wheelUp = gm().getZoom() > z0 + 0.1;
      r.wheelKeeps = t.state.following === true && t.view.drive === true;
    } finally {
      up(0, 0);
      t.prefs.headingUp = prevHup;
      t.zoomCtl.manualUntil = 0;
      t.setFollowing(true);
    }
    const ok = r.drive0 && r.rot0 === 80 && r.peek && r.stillDrive && r.followsFinger < 6 && r.moved > 20 && r.pill && r.stays < 1 && r.rotKept &&
      r.counting && r.btnBack && r.btnCenter < 3 && r.peek2 && r.notYet && r.autoBack && r.wheelUp && r.wheelKeeps;
    const m = (v) => (typeof v === 'number' ? Math.round(v * 10) / 10 : v);
    return { pass: !!ok, detail: Object.keys(r).map((k) => k + '=' + m(r[k])).join(', ') };
  }

  // S58: 주정차 단속 카메라 (2026-11-14 요청 '주정차금지 저런 것도'). 도심에 아주 많아 지나갈 때는 조용히,
  //      천천히(25km/h 아래) 갈 때 80m 안이면 칸을 띄우고 35km/h 를 넘으면 내린다. 지도 표지는 40km/h 아래에서만
  async function s58() {
    const t = T(), r = {}, prev = t.prefs.parking;
    const P = dest(TRIP_ORIGIN, 0, 300);
    t.setParkingData({ count: 1, scale: 1e5, d: [Math.round(P.lat * 1e5), Math.round(P.lng * 1e5)] });
    const card = () => visible('#parkCard');
    const marks = () => { const m = t.getMap(); return m && m.parks ? m.parks.size : -1; };
    try {
      t.prefs.parking = true;
      // 시속 60km 로 옆(15m)을 지나간다: 조용히
      let seen = false;
      for (let s = 0; s <= 600; s += 17) { feed(dest(dest(TRIP_ORIGIN, 90, 15), 0, s), 16.7, 0); if (card()) seen = true; }
      r.fastQuiet = !seen;
      // 천천히(15km/h) 다가가 60m 앞
      const Q = dest(P, 180, 60);
      feed(dest(Q, 180, 8), 4.2, 0); feed(Q, 4.2, 0);
      r.slowShown = card();
      r.dist = text('#parkDist');
      r.markers = marks();
      // 30km/h 로 100m 안: 그대로
      feed(dest(P, 180, 30), 8.3, 0);
      r.keep30 = card();
      // 43km/h: 내린다, 지도 표지도 없앤다 (40km/h 넘으면)
      feed(dest(P, 0, 10), 12, 0); feed(dest(P, 0, 22), 12, 0);
      r.gone40 = !card();
      r.markersFast = marks();
      // 설정 끔: 천천히 가도 안 뜬다
      t.prefs.parking = false;
      feed(dest(P, 180, 20), 3, 0); feed(dest(P, 180, 15), 3, 0);
      r.offHidden = !card();
      t.prefs.parking = true;
      // 진행 방향 뒤 (지나와서 멀어지는 중, 40m 뒤): 안 뜬다 (2026-11-14 요청: 내 진행 방향 앞쪽 것만)
      feed(dest(P, 0, 35), 3, 0); feed(dest(P, 0, 40), 3, 0);
      r.behindHidden = !card();
      // 옆길 (60m 옆을 나란히 북쪽으로): 안 뜬다
      const side = dest(P, 90, 60);
      feed(dest(side, 180, 50), 3, 0); feed(dest(side, 180, 45), 3, 0);
      r.sideHidden = !card();
      r.sideMarkers = marks();
    } finally {
      t.prefs.parking = prev;
      try { const j = await (await realFetch(new URL('../data/parking.json', location.href).href)).json(); t.setParkingData(j); } catch (e) { /* 다음 실행 때 다시 */ }
    }
    const ok = r.fastQuiet && r.slowShown && /^(5\d|6\d)m$/.test(r.dist) && r.markers === 1 && r.keep30 && r.gone40 && r.markersFast === 0 && r.offHidden &&
      r.behindHidden && r.sideHidden && r.sideMarkers === 0;
    return { pass: !!ok, detail: Object.keys(r).map((k) => k + '=' + r[k]).join(', ') };
  }


  // S68: 길안내 없이 달릴 때 차 GPS 방향 값이 틀려도(반대쪽을 가리켜도) 지나온 궤적 방향으로 앞의 단속 카메라를 잡고,
  //      경고 없이 카메라 20m 안을 지나치면 '놓친 카메라'로 센다 (v117, 2026-11-15 보정동 60km 단속 2번 놓침)
  async function s68() {
    const t = T();
    await resetApp();
    const CAM = { lat: 37.44165, lng: 126.8467 };   // 광명로 60 신호·과속 (data/cameras.json 23339). v213: 예전 용구대로 보정 21232 는 네이버대로 북행으로 바뀌어 이 카메라로
    const A0 = dest(CAM, 0, 600), r = {};   // 이 카메라는 원본 '광명스피돔→광명ic입구' 남행(196°)이라 북쪽에서 남쪽으로 달린다
    let hit = null;
    for (let s = 0; s <= 720; s += 17) {
      const p = dest(A0, 180, s);
      feed(p, 16.7, 0);                       // 기기 방향은 정반대(0°)로 틀리게
      const tg = t.camState.target;
      if (!hit && tg && sameCam(tg.c, CAM)) hit = { s, d: r0(tg.d) };
    }
    r.hit = hit ? hit.d : 'none';
    r.heading = r0(t.state.heading);
    r.badCount = t.hdgFix.bad;
    // 맞는 방향 값은 그대로 쓴다
    await resetApp();
    const bad0 = t.hdgFix.bad;
    for (let s = 0; s <= 300; s += 17) feed(dest(A0, 180, s), 16.7, 182);
    r.goodKept = r0(t.state.heading) === 182 && t.hdgFix.bad === bad0;
    // 놓친 카메라 세기: 경고가 없던 것으로 하고 카메라 옆(5m)을 지나 80m 멀어지면 1번
    await resetApp();
    const sent0 = t.camMiss.sent;
    t.camMiss.near.clear();
    t.state.speedKmh = 60;
    t.camState.target = null; t.camState.passed.clear(); t.camState.saidById.clear();
    const road0 = t.road.name; t.road.name = '';
    t.state.heading = 180;
    t.camMissCheck({ lat: dest(CAM, 270, 5).lat, lng: dest(CAM, 270, 5).lng, t: Date.now() });
    t.camMissCheck({ ...dest(CAM, 180, 80), t: Date.now() + 5000 });
    r.missCounted = t.camMiss.sent >= sent0 + 1;
    t.road.name = road0;
    const ok = typeof r.hit === 'number' && r.hit > 60 && Math.abs(r.heading - 180) < 20 && r.badCount >= 10 && r.goodKept && r.missCounted;
    return { pass: ok, detail: JSON.stringify(r) };
  }

  // S69: (v118, 2026-11-15 주행 중 요청) 신호·과속 카메라는 지나간 뒤 5m 만 경고 유지(예전 30m), 과속이어도 '속도를 줄이세요' 음성 없이
  //      경고음만, 직진 지하차도 진입(56)은 안내 줄에 터널 아이콘 + 'OO지하차도까지'
  async function s69() {
    const t = T(), r = {};
    await resetApp();
    const CAM = { lat: 37.44165, lng: 126.8467 };   // 광명로 신호·과속 60 (23339, v213 전에는 용구대로 보정 21232)
    const mark = t.alertLog[t.alertLog.length - 1];
    let shown = false, clearedAt = null;
    for (let s = 0; s <= 700; s += 5) {
      const past = s - 600;
      feed(dest(CAM, 0, 600 - s), 75 / 3.6, 180, { dt: 250 });   // 이 카메라는 원본 '광명스피돔→광명ic입구' 남행(196°)이라 북쪽에서 남쪽으로 달린다
      const tg = t.camState.target, mine = !!tg && sameCam(tg.c, CAM);
      if (mine) shown = true;
      if (past > 0 && shown && !mine && clearedAt === null) clearedAt = past;
    }
    const from = mark ? t.alertLog.indexOf(mark) + 1 : 0;
    const log = t.alertLog.slice(from).map((e) => e.text);
    r.shown = shown; r.clearedAt = clearedAt;
    r.voice = log.some((x) => /속도를 줄이세요/.test(x));
    r.beep = log.some((x) => /제한 넘음 경고음/.test(x));
    // 직진 지하차도 진입 안내
    const raw = [];
    for (let k = 0; k <= 30; k++) raw.push(dest(NAV_ORIGIN, 0, 100 * k));
    const path = raw.map((p) => [round6(p.lng), round6(p.lat)]);
    const P = path.map((x) => ({ lat: x[1], lng: x[0] }));
    const cum = [0];
    for (let i = 1; i < P.length; i++) cum.push(cum[i - 1] + hav(P[i - 1], P[i]));
    const total = cum[cum.length - 1];
    const R = {
      route: { distance: r0(total), duration: r0(total / 20 * 1000), tollFare: 0, fuelPrice: 300, path,
        // v140: 방면이 있는 진입은 방면 이름 ('송파지하차도에서 '성남, 가락시장역' 방면으로 지하차도 진입' → '성남, 가락시장역 방면', 네이버 '가락시장역')
        guide: [{ i: 12, t: 56, s: '벌말지하차도에서 지하차도 진입', d: r0(cum[12]), ms: 60000 }, { i: 20, t: 55, s: "금곡고가차도에서 '성남, 가락시장역' 방면으로 고가차도 진입", d: r0(cum[20] - cum[12]), ms: 40000 },
          { i: 30, t: 88, s: '목적지', d: r0(total - cum[20]), ms: 50000 }],
        sections: [{ i: 0, n: 31, name: '테스트로', speed: 60, cong: 1 }] },
      P, cum, total, dest: { name: '터널 테스트', addr: '', lat: P[30].lat, lng: P[30].lng },
    };
    try {
      softReset();
      await planAndStart(R);
      for (let s = 20; s <= 500; s += 20) { const a = pointAt(R, s); feed(a.p, 20, a.h); }
      t.renderNav();
      r.turnText = text('#turnText');
      r.tunnelIcon = !!document.querySelector('#turnIcon img[src*="under"], #turnIcon img.tn-ai, #turnIcon svg.tunnel');
      // v124: 그다음 칸의 고가차도 진입(55)은 고가 그림, 지하차도를 지나면 큰 줄이 'OO고가차도까지' + 고가 그림
      r.nextOver = !!document.querySelector('#nextIcon img[src*="over"]');
      for (let s = 520; s <= 1500; s += 20) { const a = pointAt(R, s); feed(a.p, 20, a.h); }
      t.renderNav();
      r.overText = text('#turnText');
      r.overIcon = !!document.querySelector('#turnIcon img[src*="over"]');
    } finally { t.endNav(); softReset(); }
    const ok = r.shown && r.clearedAt !== null && r.clearedAt <= 20 && !r.voice && r.beep && r.turnText === '벌말지하차도까지' && r.tunnelIcon &&
      r.nextOver && String(r.overText).replace(/ /g, ' ') === '성남, 가락시장역 방면' && r.overIcon;
    return { pass: ok, detail: JSON.stringify(r) };
  }

  // S72: (v122) 반대편 차로 카메라 (2026-11-15 밤 주행 제보 두 건, 사용자 '왼쪽은 반대편 차선인 경우가 많았음').
  //      데이터에 '양방향'(3)으로 적힌 카메라도 경로 왼쪽으로 10m 넘게 떨어져 있으면 반대편 차로용이라 알리지 않는다.
  //      실제 네이버 경로(2026-11-15, 출발·도착 근처는 잘라 냄):
  //      (a) 송파대로·성남대로 남행(route-songpa-seongnam-s): 복정동 성남대로 60(22595, 왼쪽 27m: 사진 제보)·송파대로 50(23401, 왼쪽 32m)은
  //          안 뜨고, 송파대로 50(23221, 오른쪽 36m: 문정동 사진에서 맞게 뜬 것)·성남대로 60 한 방향(22644 '서울→성남시청', 오른쪽 8m)은 뜬다.
  //      (b) 송파대로 북행(route-songpa-n): 반대로 23221(왼쪽 36m)은 안 뜨고 23401(오른쪽 32m)은 뜬다.
  //      (c) 성남대로 북행(route-bokjeong-n): 22595(오른쪽 5m)는 뜨고, 22644(한 방향 남행, 왼쪽 28m)는 안 뜬다.
  //      (d) v120 금곡IC: 분당수서로 북행(route-bundang-suseo-n)에 3km 전 ''성남, 용인시청' 방면' 안내를 넣어도
  //          '용인→분당경찰서' 80(20929)은 뜨고, 분당수서로 60 양방향 중 왼쪽 30m(21198)는 안 뜬다
  //          (오른쪽 16m 의 21189 는 옆 지상 도로 '분당수서로' 카메라라 고속화도로를 달리는 이 경로에서는 원래 안 뜬다: 기록만).
  //      (e) 길안내 없이 (a)의 길을 달려도 22595 는 안 뜨고 22644 는 뜬다, (c)의 길이면 22595 가 뜬다
  async function s72() {
    const t = T(), r = {};
    const C = {
      c23221: { lat: 37.48219, lng: 127.12397 }, c23401: { lat: 37.48625, lng: 127.1227 },
      c22595: { lat: 37.46002, lng: 127.12606 }, c22644: { lat: 37.46216, lng: 127.12578 }, c22450: { lat: 37.45073, lng: 127.1269 },
      c20929: { lat: 37.35405, lng: 127.10454 }, c21189: { lat: 37.35996, lng: 127.10697 }, c21198: { lat: 37.35996, lng: 127.10697 },
    };
    // 21189·21198 좌표는 데이터에서 바로 읽는다 (같은 교차로의 두 카메라)
    const rows = t.cams.rows;
    for (const k of ['21189', '21198']) C['c' + k] = { lat: rows[+k][0], lng: rows[+k][1] };
    const load = async (file, edit) => {
      const fx = await (await realFetch(harnessDir + 'fixtures/' + file, { cache: 'no-store' })).json();
      if (edit) edit(fx);
      const P = fx.path.map((x) => ({ lat: x[1], lng: x[0] }));
      const cum = [0];
      for (let i = 1; i < P.length; i++) cum.push(cum[i - 1] + hav(P[i - 1], P[i]));
      const total = cum[cum.length - 1];
      return { route: fx, P, cum, total, dest: { name: '시험', addr: '', lat: P[P.length - 1].lat, lng: P[P.length - 1].lng } };
    };
    const drive = (R, keys) => {
      const hit = {};
      for (const k of keys) hit[k] = false;
      for (let s = 0; s <= R.total - 30; s += 12) {
        const a = pointAt(R, s);
        feed(a.p, 60 / 3.6, a.h, { dt: 720 });
        const tg = t.camState.target;
        if (tg) for (const k of keys) if (sameCam(tg.c, C[k])) hit[k] = true;
      }
      return hit;
    };
    const navRun = async (file, keys, edit) => {
      await resetApp();
      softReset();
      const R = await load(file, edit);
      await planAndStart(R);
      try { return drive(R, keys); } finally { t.endNav(); }
    };
    const freeRun = async (file, keys) => {
      await resetApp();
      softReset();
      return drive(await load(file), keys);
    };
    try {
      r.a = await navRun('route-songpa-seongnam-s.json', ['c23221', 'c23401', 'c22595', 'c22644', 'c22450']);
      r.b = await navRun('route-songpa-n.json', ['c23221', 'c23401']);
      r.c = await navRun('route-bokjeong-n.json', ['c22595', 'c22644']);
      r.d = await navRun('route-bundang-suseo-n.json', ['c20929', 'c21189', 'c21198'], (fx) => {
        // 보정교차로삼거리(40)와 '성남' 방면 고가차도 진입(95) 사이에 '용인시청' 방면 안내를 넣는다 (v120 이 고친 경우)
        fx.guide.splice(1, 0, { i: 70, t: 2, s: "금곡교차로에서 '성남, 용인시청' 방면으로 좌회전", d: 0, ms: 0 });
      });
      r.e1 = await freeRun('route-songpa-seongnam-s.json', ['c22595', 'c22644']);
      r.e2 = await freeRun('route-bokjeong-n.json', ['c22595']);
    } finally { await resetApp(); softReset(); }
    const ok = r.a.c23221 && !r.a.c23401 && !r.a.c22595 && r.a.c22644 && !r.a.c22450 &&
      !r.b.c23221 && r.b.c23401 &&
      r.c.c22595 && !r.c.c22644 &&
      r.d.c20929 && !r.d.c21198 &&
      !r.e1.c22595 && r.e1.c22644 && r.e2.c22595;
    return { pass: ok, detail: JSON.stringify(r) };
  }


  // S74: (v123) 단속 카메라 점수 — 2026-11-15 실제 주행 사례 13건 (사용자 확인·네이버 지도 비교). 실제 네이버 경로로 길안내 있음·없음 둘 다.
  //      잘못 뜸(오탐)·놓침·종류 틀림을 센다. 같은 시험을 옛 버전에도 돌려 비교한다(harness.html?only=S74).
  //      경로: route-night-seongnam-giheung(태평동 수정로 → 분당수서로 → 분당수서간도시고속화도로 → 용구대로2469번길 → 용구대로, 21km),
  //            route-songpa-seongnam-s(송파대로·성남대로 남행), route-bundang-suseo-n(분당수서로 북행, 금곡IC)
  const SCORE_CASES = [
    { file: 'route-night-seongnam-giheung.json', cams: [
      ['중앙시장사거리 옆길 50', 37.44093, 127.13197, 'no'],
      ['벌말 남행 80 (원본에 없음, v264 네이버 자리)', 37.409916, 127.118459, 'yes'],
      ['백현지하도로 위 분당수서로 남행 60 신호·과속 (#22322, v264)', 37.37226, 127.10391, 'navno'],   // 길안내 없이는 층을 모른다 (OSM 지하도로 자료 없음)
      ['삼성르노삼거리 50 (원본에 없음)', 37.32188, 127.10475, 'yes'],
      ['장애인복지관 앞 50 (북행)', 37.31518, 127.10526, 'no'],
      ['미키주유소앞 50', 37.31171, 127.10494, 'yes'],
      ['그린주유소앞 60 (북행)', 37.30272, 127.10593, 'no'],
      ['연원마을 60 북행 기둥', 37.30094, 127.10668, 'no'],
      ['연원마을 60 남행 후면', 37.30088, 127.10645, 'rear'],
    ] },
    { file: 'route-songpa-seongnam-s.json', cams: [
      ['문정역 50 (북행)', 37.48625, 127.1227, 'no'],
      ['건영아파트앞 50', 37.48219, 127.12397, 'yes'],
      ['복정 동서울대 60 (북행)', 37.46002, 127.12606, 'no'],
      ['서울→성남시청 60', 37.46216, 127.12578, 'yes'],
    ] },
    { file: 'route-bundang-suseo-n.json', guide: [1, { i: 70, t: 2, s: "금곡교차로에서 '성남, 용인시청' 방면으로 좌회전", d: 0, ms: 0 }], cams: [
      ['금곡IC 80 (용인→분당경찰서)', 37.35405, 127.10454, 'yes'],
    ] },    // v138 (2026-11-16 09:20 길동사거리 제보): 양재대로 북행에서 좌회전. 우리 접근로를 찍는 북행 카메라는 알리고, 좌회전 뒤 천호대로를
    // 찍는 서행 카메라(동쪽 접근로)는 알리지 않는다
    { file: 'route-gildong-left.json', cams: [
      ['길동사거리 양재대로 북행 50 (좌회전 전)', 37.53408, 127.13883, 'yes'],
      ['길동사거리 천호대로 서행 50 (다른 접근로)', 37.53426, 127.13841, 'no'],
    ] },
  ];
  async function scoreRun(withNav) {
    const t = T(), out = { fp: 0, miss: 0, type: 0, alerts: 0, bad: [] };
    for (const sc of SCORE_CASES) {
      await resetApp();
      softReset();
      const fx = await (await realFetch(harnessDir + 'fixtures/' + sc.file, { cache: 'no-store' })).json();
      if (sc.guide) fx.guide.splice(sc.guide[0], 0, sc.guide[1]);
      const P = fx.path.map((x) => ({ lat: x[1], lng: x[0] }));
      const cum = [0];
      for (let i = 1; i < P.length; i++) cum.push(cum[i - 1] + hav(P[i - 1], P[i]));
      const R = { route: fx, P, cum, total: cum[cum.length - 1], dest: { name: '점수', addr: '', lat: P[P.length - 1].lat, lng: P[P.length - 1].lng } };
      if (withNav) await planAndStart(R);
      const seen = new Map(), all = new Set();
      try {
        for (let s = 0; s <= R.total - 30; s += 10) {
          const a = pointAt(R, s);
          feed(a.p, 55 / 3.6, a.h, { dt: 650 });
          const tg = t.camState.target;
          if (!tg) continue;
          all.add(tg.c[0] + ',' + tg.c[1]);
          for (const [name, la, lo] of sc.cams) {
            if (sameCam(tg.c, { lat: la, lng: lo }) && !seen.has(name)) seen.set(name, text('#camType'));
          }
        }
      } finally { if (withNav) t.endNav(); }
      out.alerts += all.size;
      for (const [name, , , want] of sc.cams) {
        const got = seen.has(name), label = seen.get(name) || '';
        if ((want === 'no' || (want === 'navno' && withNav)) && got) { out.fp++; out.bad.push('오탐 ' + name); }
        if (want !== 'no' && want !== 'navno' && !got) { out.miss++; out.bad.push('놓침 ' + name); }
        if (want === 'rear' && got && !/후면/.test(label)) { out.type++; out.bad.push('종류 ' + name + ' "' + label + '"'); }
      }
    }
    await resetApp();
    softReset();
    return out;
  }
  async function s74() {
    const nav = await scoreRun(true), free = await scoreRun(false);
    const sum = (o) => o.fp + o.miss + o.type;
    return { pass: sum(nav) === 0 && sum(free) === 0, detail: String((document.querySelector('script[src*="app.js"]') || {}).src || '').replace(/^.*\//, '') + ' 길안내 ' + JSON.stringify(nav) + ' | 길안내 없음 ' + JSON.stringify(free) };
  }


  // S75: (정보) 저장된 실제 경로마다 길안내로 달리며 알린 카메라 목록. 버전끼리 비교용(harness.html?only=S75 → window.__alertLists)
  const ALERT_LIST_FILES = ['route-night-seongnam-giheung.json', 'route-songpa-seongnam-s.json', 'route-songpa-n.json', 'route-bokjeong-n.json',
    'route-bundang-suseo-n.json', 'route-daejeon-yuseong.json', 'route-gapyeong-cheongpyeong.json', 'route-gapyeong-ne.json', 'route-gapyeong-sw.json',
    'route-gapyeong-town.json', 'route-hanam-paldang-n.json', 'route-paldang-east.json', 'route-paldang-hanamic-s.json', 'route-paldang-west.json',
    'route-ring1-pangyo.json', 'route-yangseo-bukhangang-n.json', 'route-yangseo-bukhangang-s.json'];
  async function s75() {
    const t = T(), lists = {};
    const routes = [];
    for (const f of ALERT_LIST_FILES) routes.push([f, await (await realFetch(harnessDir + 'fixtures/' + f, { cache: 'no-store' })).json()]);
    try {   // 저장소에 올리지 않는 비교용 경로 묶음 (있으면)
      const r = await realFetch(harnessDir + 'fixtures/_tmp_routes.json', { cache: 'no-store' });
      if (r.ok) { const j = await r.json(); for (const k of Object.keys(j)) routes.push([k, j[k]]); }
    } catch (e) { /* 없음 */ }
    for (const [name, fx] of routes) {
      await resetApp();
      softReset();
      const P = fx.path.map((x) => ({ lat: x[1], lng: x[0] }));
      const cum = [0];
      for (let i = 1; i < P.length; i++) cum.push(cum[i - 1] + hav(P[i - 1], P[i]));
      const R = { route: fx, P, cum, total: cum[cum.length - 1], dest: { name: '목록', addr: '', lat: P[P.length - 1].lat, lng: P[P.length - 1].lng } };
      await planAndStart(R);
      const seen = new Set();
      try {
        for (let s = 0; s <= R.total - 30; s += 10) {
          const a = pointAt(R, s);
          feed(a.p, 55 / 3.6, a.h, { dt: 650 });
          const tg = t.camState.target;
          if (tg) seen.add(tg.c[0] + ',' + tg.c[1] + '|' + tg.c[2] + '|' + text('#camType'));
        }
      } finally { t.endNav(); }
      lists[name] = [...seen];
    }
    await resetApp();
    softReset();
    window.__alertLists = lists;
    return { pass: true, detail: Object.keys(lists).length + ' routes, ' + Object.values(lists).reduce((a, b) => a + b.length, 0) + ' alerts' };
  }

  // S73: (v122) 음성에 '과속'·'초과'가 없다 (2026-11-15 밤 '속도 초과라는 말 없애줘 놀란다 자꾸'). 제한을 넘어 신호·과속 카메라와
  //      과속 카메라에 다가가도 안내 음성은 'N미터 앞, 신호 단속 카메라. 제한속도 60입니다.' 처럼 말하고, 넘었다는 건 소리·빨간 카드로만
  async function s73() {
    const t = T(), r = {};
    await resetApp();
    const mark = t.alertLog[t.alertLog.length - 1];
    const CAM = { lat: 37.44165, lng: 126.8467 };   // 광명로 신호·과속 60 (23339, v213 전에는 용구대로 보정 21232)
    for (let a = 600; a >= -80; a -= 20) feed(dest(CAM, 0, a), 80 / 3.6, 180);   // 이 카메라는 원본 '광명스피돔→광명ic입구' 남행(196°)이라 북쪽에서 남쪽으로 달린다
    r.overCard = null;
    await resetApp();
    for (let a = 800; a >= -80; a -= 20) {
      feed(dest(CAM_ISO_B, 180, a), 75 / 3.6, 0);
      if (a === 200) r.overCard = hasCls('#camCard', 'over');
    }
    const from = mark ? t.alertLog.indexOf(mark) + 1 : 0;
    const log = t.alertLog.slice(from).map((e) => e.text);
    r.spoken = log.filter((x) => /앞, /.test(x));
    r.bad = log.filter((x) => /초과|과속|속도를 줄이세요/.test(x));
    r.overBeep = log.some((x) => /제한 넘음 경고음/.test(x));
    await resetApp();
    const ok = r.spoken.length >= 2 && r.bad.length === 0 && r.overBeep && r.overCard === true;
    return { pass: ok, detail: JSON.stringify(r) };
  }

  // S71: (v121) 신호·과속 카메라 경고는 옆을 지나는 순간 꺼진다. 위치가 1초에 한 번(시속 60km 면 17m 간격) 와도
  //      (a) 카메라를 3m 지난 위치에서 바로 꺼지고 (전에는 다음 위치, 약 20m 지나서), (b) 카메라 6m 앞 위치 다음에는
  //      새 위치를 기다리지 않고 지나갈 시각에 꺼지며, (c) 길안내 중에도 경로 거리로 같다 (2026-11-15 요청 '오차 25 미터를 줄여')
  async function s71() {
    const t = T(), r = {};
    const CAM = { lat: 37.44165, lng: 126.8467 };   // 광명로 신호·과속 60 (23339, v213 전에는 용구대로 보정 21232)
    const V = 60 / 3.6, STEP = V;                    // 1초에 16.7m
    const mine = () => !!t.camState.target && sameCam(t.camState.target.c, CAM);
    const F = camFrame(CAM, 180);   // v123: 카메라 차로 위 점·찍는 방향 기준으로 지난 거리를 잰다
    // a0 m 앞에서 시작해 1초마다 17m 씩 북쪽으로: 카메라를 지난 뒤 처음 꺼진 위치(지난 거리)
    const run = (a0, upto, at) => {
      let shown = false, cleared = null;
      for (let k = 0; ; k++) {
        const a = a0 - STEP * k;
        if (-a > upto) break;
        feed(at ? at(a) : F.pt(a), V, F.h);   // 이 카메라는 원본 '광명스피돔→광명ic입구' 남행(196°)이라 북쪽에서 남쪽으로 달린다
        if (mine()) shown = true;
        if (a < 0 && shown && !mine() && cleared === null) cleared = Math.round(-a * 10) / 10;
      }
      return { shown, cleared };
    };
    await resetApp();
    r.a = run(STEP * 36 - 3, 40);                    // 36번째 위치가 카메라 3m 지나
    await resetApp();
    // (b) 마지막 위치가 카메라 6m 앞: 0.48초 뒤에 꺼져야 한다
    let shownB = false;
    for (let k = 0; k <= 36; k++) { feed(F.pt(6 + STEP * (36 - k)), V, F.h); if (mine()) shownB = true; }
    r.bShown = shownB; r.bBefore = mine();
    const mark = t.alertLog[t.alertLog.length - 1];
    await new Promise((res) => setTimeout(res, 800));
    r.bAfter = mine();
    r.bChime = t.alertLog.slice(mark ? t.alertLog.indexOf(mark) + 1 : 0).filter((e) => /단속 통과 띠링/.test(e.text)).length;
    feed(F.pt(-(STEP - 6)), V, F.h);                 // 다음 위치(10.7m 지나): 다시 뜨지 않는다
    r.bAgain = mine();
    // (c) 길안내: 카메라를 지나는 곧은 경로
    const raw = [];
    for (let k = 0; k <= 12; k++) raw.push(F.pt(800 - 100 * k));
    const path = raw.map((p) => [round6(p.lng), round6(p.lat)]);
    const P = path.map((x) => ({ lat: x[1], lng: x[0] }));
    const cum = [0];
    for (let i = 1; i < P.length; i++) cum.push(cum[i - 1] + hav(P[i - 1], P[i]));
    const total = cum[cum.length - 1];
    const R = {
      route: { distance: r0(total), duration: r0(total / 15 * 1000), tollFare: 0, fuelPrice: 300, path,
        guide: [{ i: 12, t: 88, s: '목적지', d: r0(total), ms: 80000 }],
        sections: [{ i: 0, n: 13, name: '용구대로', speed: 60, cong: 1 }] },
      P, cum, total, dest: { name: '신호 카메라 시험', addr: '', lat: P[12].lat, lng: P[12].lng },
    };
    try {
      await resetApp();
      softReset();
      await planAndStart(R);
      r.c = run(STEP * 36 - 3, 40, (a) => F.pt(a));
    } finally { t.endNav(); softReset(); }
    const ok = r.a.shown && r.a.cleared !== null && r.a.cleared <= 5 &&
      r.bShown && r.bBefore && !r.bAfter && r.bChime === 1 && !r.bAgain &&
      r.c.shown && r.c.cleared !== null && r.c.cleared <= 5;
    return { pass: ok, detail: JSON.stringify(r) };
  }

  // S70: (v119) 재탐색이 길찾기 서버의 '잠시 후 다시'(429, 60초에 4번)에 막히면 실패 안내 없이 알려 준 시간 뒤 조용히 다시 찾고,
  //      교통 갱신은 그냥 넘긴다 (2026-11-15 12:18 차에서 재탐색 실패)
  async function s70() {
    const t = T(), R = buildNavRoute(), r = {};
    try {
      softReset();
      await planAndStart(R);
      const okRoute = R.route;
      let n = 0;
      stub.canned['/route'] = () => (++n === 1 ? { __status: 429, body: { error: 'rate limited', message: '잠시 후 다시 시도합니다', retryAfter: 1 } } : okRoute);
      feed(dest(NAV_ORIGIN, 90, 400), 15, 0);   // 경로에서 400m 옆: 벗어남
      const c0 = stub.count('/route');
      await t.planRoute(t.nav.dest, true);
      r.toast = text('#toast');
      r.failToast = /찾지 못했어요/.test(r.toast);
      r.callsNow = stub.count('/route') - c0;
      await new Promise((res) => setTimeout(res, 1700));
      await waitFor(() => !t.nav.busy, 3000);
      r.callsLater = stub.count('/route') - c0;
      t.endNav();
      // v175: 처음 길찾기도 429 면 실패 안내 없이 한 번 다시 (같은 통신사 IP 를 여러 차가 쓸 때)
      softReset();
      n = 0;
      const okAlts = { alternatives: [Object.assign({ option: 'traoptimal' }, okRoute)] };
      stub.canned['/route'] = () => (++n === 1 ? { __status: 429, body: { error: 'rate limited', message: '잠시 후 다시 시도합니다', retryAfter: 1 } } : okAlts);
      feed(R.P[0], 0, null);
      const c1 = stub.count('/route');
      await t.planRoute(R.dest, false);
      r.first = { toast: text('#toast'), fail: /찾지 못했어요|연결하지 못했어요/.test(text('#toast')), calls: stub.count('/route') - c1 };
      await new Promise((res) => setTimeout(res, 1700));
      await waitFor(() => !t.nav.busy && t.nav.preview, 3000);
      r.first.later = stub.count('/route') - c1; r.first.card = visible('#routeCard');
      t.endNav();
    } finally { softReset(); }
    const ok = !r.failToast && /다시 찾습니다/.test(r.toast) && r.callsNow === 1 && r.callsLater === 2 &&
      !r.first.fail && /몰려/.test(r.first.toast) && r.first.calls === 1 && r.first.later === 2 && r.first.card;
    return { pass: ok, detail: JSON.stringify(r) };
  }

  // S67: 아이콘 고르기 (2026-11-14 요청: 아이콘 목록을 보고 바꾸고 관리) — 저장소 기본(img/ai/picks.js)이 앱에 쓰이고,
  //      관리 페이지가 쓰는 ?catalog 는 지도·GPS 없이 아이콘 정의만 내주고, 'ai:' 차 그림도 내 차로 쓸 수 있다
  async function s67() {
    const t = T(), r = {}, P = window.TNC_PICKS || {};
    const loads = (src) => new Promise((res) => { const im = new Image(); im.onload = () => res(im.naturalWidth + 'x' + im.naturalHeight); im.onerror = () => res('err'); im.src = src; });
    const srcOf = (html) => ((html || '').match(/src="([^"]+)"/) || [])[1];
    r.repo = Object.keys(P).length;
    r.signPick = t.iconPicks.sign_animal === P.sign_animal;
    const sImg = srcOf(t.pickImg('sign_animal')), tImg = srcOf(t.pickImg('tunnel'));
    r.signImg = sImg ? await loads(sImg) : 'none';
    r.tunnelImg = tImg ? await loads(tImg) : 'none';
    r.guideDefault = !t.pickImg('s') && /<svg/.test(t.ico('s'));      // 안내 아이콘은 고른 것이 없으면 앱 그림 그대로
    // 관리 페이지용 목록 (?catalog): 지도·GPS 를 켜지 않는다
    const fr = document.createElement('iframe');
    fr.style.cssText = 'position:fixed;left:-2000px;top:0;width:400px;height:300px';
    fr.src = new URL('../index.html?catalog', location.href).href;
    document.body.appendChild(fr);
    let cat = null;
    for (let i = 0; i < 80 && !cat; i++) { await sleep(100); try { cat = fr.contentWindow.__tncCatalog; } catch (e) { cat = null; } }
    r.catalog = cat ? cat.signs.length + ' signs/' + cat.guide.length + ' guide/' + cat.cars.length + ' cars' : 'none';
    r.noMap = cat ? !fr.contentDocument.querySelector('#map .mapcanvas') : false;
    fr.remove();
    // 관리 페이지에서 고른 AI 차 ('ai:<파일>')
    const prev = localStorage.getItem('tnc.car');
    try {
      t.setCarIcon('ai:car_my__flare__1.webp');
      const im = document.querySelector('.me .me-arrow');
      r.aiCar = im.tagName === 'IMG' && /img\/ai\/car_my__flare__1\.webp/.test(im.getAttribute('src')) ? await loads(im.src) : 'no';
      r.aiSaved = localStorage.getItem('tnc.car') === 'ai:car_my__flare__1.webp';
    } finally {
      if (prev) t.setCarIcon(prev); else t.setCarIcon('cute');
    }
    const ok = r.repo >= 12 && r.signPick && r.signImg === '192x192' && r.tunnelImg === '192x192' && r.guideDefault &&
      /^11 signs\/\d+ guide\/6 cars$/.test(r.catalog) && r.noMap && r.aiCar === '200x280' && r.aiSaved;
    return { pass: !!ok, detail: Object.keys(r).map((k) => k + '=' + r[k]).join(', ') };
  }

  // S66: 톨게이트 이름·요금은 맨 끝 괄호에서 나눈다 (2026-11-14 남산1호터널톨게이트(도심) (통행료 0원))
  async function s66() {
    const t = T(), f = (x) => { const p = t.tollParts({ s: x }); return p.name + '|' + p.fare; };
    const r = { namsan: f('남산1호터널톨게이트(도심) (통행료 0원)'), seoul: f('서울톨게이트 (통행료 1,800원)'), plain: f('판교톨게이트') };
    const ok = r.namsan === '남산1호터널톨게이트|통행료 0원' /* v110: 끝 괄호 뺌 */ && r.seoul === '서울톨게이트|통행료 1,800원' && r.plain === '판교톨게이트|';
    return { pass: ok, detail: Object.keys(r).map((k) => k + '=' + r[k]).join(', ') };
  }

  // S65: 자동 배율 — 가는 중에는 회전 앞이라도 17, 건물이 보일 만큼(18)은 목적지 300m 안에서만 (2026-11-14 요청)
  async function s65() {
    const t = T(), R = buildNavRoute(), r = {}, m = t.getMap(), orig = m.setZoom;
    const calls = [];
    try {
      await planAndStart(R);
      t.setFollowing(true);
      m.setZoom = function (z) { calls.push(z); return orig.call(this, z); };
      const run = (from, to) => { t.zoomCtl.last = 0; t.zoomCtl.manualUntil = 0; for (let s = from; s <= to; s += 12) { const a = pointAt(R, s); feed(a.p, 12, a.h); } };
      run(380, 420);                        // 우회전(600m) 200m 앞, 시속 43km
      r.turn = calls.length ? calls.slice(-1)[0] : Math.round(m.getZoom());   // 이미 17 이면 바꾸지 않는다
      r.turnNo18 = !calls.includes(18);
      const nCalls = calls.length;
      run(R.total - 300, R.total - 250);    // 목적지 250m 앞
      // 이미 18 이면 다시 부르지 않는다 (앞 시험이 목적지 가까이에서 끝나 18 로 남아 있을 때) — 위 r.turn 과 같은 방식
      r.arrive = calls.length > nCalls ? calls.slice(-1)[0] : Math.round(m.getZoom());
    } finally {
      m.setZoom = orig;
      t.endNav(); softReset();
    }
    const ok = r.turn === 17 && r.turnNo18 && r.arrive === 18;
    return { pass: !!ok, detail: Object.keys(r).map((k) => k + '=' + r[k]).join(', ') };
  }

  // S64: 길안내 중 주정차 단속은 목적지 가까이(남은 길 700m)에서만 (2026-11-14 요청: 목적지에 거의 다 와서 필요한 자세한 정보)
  async function s64() {
    const t = T(), R = buildNavRoute(), r = {}, prev = t.prefs.parking;
    const cams = [pointAt(R, 200).p, pointAt(R, R.total - 150).p, dest(R.dest, 180, 120)];   // 가는 길 · 목적지 150m 앞 · 목적지 남쪽 120m(경로 밖)
    const d = [];
    let la = 0, ln = 0;
    cams.forEach((c) => { const a = Math.round(c.lat * 1e5), b = Math.round(c.lng * 1e5); d.push(a - la, b - ln); la = a; ln = b; });
    const marks = () => { const m = t.getMap(); return m && m.parks ? m.parks.size : -1; };
    try {
      t.prefs.parking = true;
      t.setParkingData({ count: cams.length, scale: 1e5, d });
      await planAndStart(R);
      // 출발 130m (목적지까지 950m): 천천히 가고 카메라가 70m 앞이어도 안 띄운다
      let a = pointAt(R, 120); feed(a.p, 4, a.h); a = pointAt(R, 130); feed(a.p, 4, a.h);
      r.farCard = visible('#parkCard'); r.farMarks = marks();
      // 목적지 220m 앞: 앞 70m 카메라 카드 + 지도에는 그것과 목적지 둘레 것
      a = pointAt(R, R.total - 230); feed(a.p, 4, a.h); a = pointAt(R, R.total - 220); feed(a.p, 4, a.h);
      r.nearCard = visible('#parkCard'); r.nearDist = text('#parkDist'); r.nearMarks = marks();
    } finally {
      t.endNav(); softReset();
      t.prefs.parking = prev;
      try { const j = await (await realFetch(new URL('../data/parking.json', location.href).href)).json(); t.setParkingData(j); } catch (e) { /* 다음 실행 때 다시 */ }
    }
    const ok = !r.farCard && r.farMarks === 0 && r.nearCard && /^(6\d|7\d)m$/.test(r.nearDist) && r.nearMarks === 2;
    return { pass: !!ok, detail: Object.keys(r).map((k) => k + '=' + r[k]).join(', ') };
  }

  // S59: 목적지 주차장 입구 (2026-11-14 요청: 사람이 들어가는 정문이 아니라 차가 들어가는 주차장 입구로)
  async function s59() {
    const t = T(), R = buildNavRoute(), r = {}, D = R.dest;
    const ent = dest(D, 270, 120), exitP = dest(D, 270, 60), other = dest(D, 180, 80), far = dest(D, 0, 900);
    const pt = (q) => q.lng.toFixed(6) + ',' + q.lat.toFixed(6);
    stub.canned['/search'] = (q) => (/주차장입구/.test(q.query || '') ? { items: [
      { name: '테스트아파트주차장출구', category: '도로시설>방면정보', addr: '', lat: exitP.lat, lng: exitP.lng },
      { name: '다른단지주차장입구', category: '도로시설>방면정보', addr: '', lat: other.lat, lng: other.lng },
      { name: '테스트아파트서문주차장입구', category: '도로시설>방면정보', addr: '', lat: ent.lat, lng: ent.lng },
      { name: '테스트아파트동문주차장입구', category: '도로시설>방면정보', addr: '', lat: far.lat, lng: far.lng },
    ] } : { items: [] });
    stub.canned['/route'] = R.route;
    feed(R.P[0], 0, null);
    try {
      const c0 = stub.calls.length;
      await withTimeout(t.pickDest({ name: '테스트아파트101동입구', addr: '', lat: D.lat, lng: D.lng, category: '' }), 5000, 'pickDest');
      await waitFor(() => stub.count('/route', c0) >= 1 && !t.nav.busy, 3000);
      const q1 = stub.since(c0, '/route')[0];
      r.base = t.placeBase('테스트아파트101동입구');
      r.query = (stub.since(c0, '/search')[0] || { query: {} }).query.query;
      r.goalEntrance = !!q1 && q1.query.goal === pt(ent);
      r.card = visible('#rcPark') && /서문주차장입구/.test(text('#rcParkName'));
      r.btn = text('#rcParkBtn');
      const c1 = stub.calls.length;
      document.getElementById('rcParkBtn').click();
      await waitFor(() => stub.count('/route', c1) >= 1 && !t.nav.busy, 3000);
      const q2 = stub.since(c1, '/route')[0];
      r.goalMain = !!q2 && q2.query.goal === pt(D);
      r.btn2 = text('#rcParkBtn');
      // 주차장 입구가 없는 가게: 그대로
      stub.canned['/search'] = { items: [] };
      const c2 = stub.calls.length;
      await withTimeout(t.pickDest({ name: '테스트카페', addr: '', lat: D.lat, lng: D.lng, category: '카페' }), 5000, 'pickDest');
      await waitFor(() => stub.count('/route', c2) >= 1 && !t.nav.busy, 3000);
      const q3 = stub.since(c2, '/route')[0];
      r.noPark = !!q3 && q3.query.goal === pt(D) && !visible('#rcPark');
    } finally {
      t.endNav(); softReset();
    }
    const ok = r.base === '테스트아파트' && r.query === '테스트아파트 주차장입구' && r.goalEntrance && r.card && r.btn === '정문으로' &&
      r.goalMain && r.btn2 === '주차장 입구로' && r.noPark;
    return { pass: !!ok, detail: Object.keys(r).map((k) => k + '=' + r[k]).join(', ') };
  }

  // S86: 목적지 주차장 입구 v145 (2026-11-16 '기흥역엘리시아트윈101동입구'에서 블록 한 바퀴: 네이버엔 '…101동주차장입출구'로 올라 있는데
  //      '입구'만 찾고 '출구'가 든 이름을 빼던 규칙에 걸려 못 찾았다. 운전자 '입구를 보고 입구로 안내해줘야 해'). 실제 좌표 없이 같은 모양으로:
  //      (a) '입출구'도 입구, 나가기만 하는 '출구'는 뺀다  (b) 목적지가 '101동입구'면 핀에 더 가까운 102동 입구보다 101동 입구
  //      (c) 경로 끝 8m 앞 우회전(주차장으로 꺾어 들어감)도 안내한다 (v209: 네이버처럼 마지막 회전을 따로 — 예전 v145 는 빼고 '좌회전 후 도착')
  //      (d) 도착 700m 안에서 안내 칸에 'P 101동 주차장 입출구 · 거리' 줄, 지도 경로 끝에 P 표지
  async function s86() {
    const t = T(), r = {};
    const raw = [];
    for (let k = 0; k <= 29; k++) raw.push(dest(NAV_ORIGIN, 0, 10 * k));
    raw.push(dest(raw[29], 270, 8));
    const path = raw.map((p) => [round6(p.lng), round6(p.lat)]);
    const P = path.map((x) => ({ lat: x[1], lng: x[0] }));
    const cum = [0];
    for (let i = 1; i < P.length; i++) cum.push(cum[i - 1] + hav(P[i - 1], P[i]));
    const total = cum[cum.length - 1];
    const route = { distance: r0(total), duration: r0(total / 8 * 1000), tollFare: 0, fuelPrice: 0, path,
      guide: [{ i: 14, t: 2, s: '좌회전', d: r0(cum[14]), ms: 20000 }, { i: 29, t: 3, s: '우회전', d: r0(cum[29] - cum[14]), ms: 15000 },
              { i: 30, t: 88, s: '목적지', d: r0(cum[30] - cum[29]), ms: 1000 }],
      sections: [{ i: 0, n: 31, name: '테스트로', speed: 30, cong: 1 }] };
    const R = { route, P, cum, total };
    const D = dest(P[30], 0, 60), e101 = P[30], e102 = dest(D, 90, 50), exitOnly = dest(D, 180, 20);
    const pt = (q) => q.lng.toFixed(6) + ',' + q.lat.toFixed(6);
    stub.canned['/search'] = (q) => (/주차장입구/.test(q.query || '') ? { items: [
      { name: '테스트아파트주차장출구', category: '도로시설>방면정보', addr: '', lat: exitOnly.lat, lng: exitOnly.lng },
      { name: '테스트아파트102동주차장입출구', category: '도로시설>방면정보', addr: '', lat: e102.lat, lng: e102.lng },
      { name: '테스트아파트101동주차장입출구', category: '도로시설>방면정보', addr: '', lat: e101.lat, lng: e101.lng },
    ] } : { items: [] });
    stub.canned['/route'] = route;
    feed(P[0], 0, null);
    try {
      const c0 = stub.calls.length;
      await withTimeout(t.pickDest({ name: '테스트아파트101동입구', addr: '', lat: D.lat, lng: D.lng, category: '도로시설>방면정보' }), 5000, 'pickDest');
      await waitFor(() => stub.count('/route', c0) >= 1 && !t.nav.busy, 3000);
      const q1 = stub.since(c0, '/route')[0];
      r.goal = !q1 ? 'none' : q1.query.goal === pt(e101) ? '101' : q1.query.goal === pt(e102) ? '102' : q1.query.goal === pt(D) ? 'pin' : q1.query.goal;
      if (!t.nav.active) t.startNav();
      r.guides = (t.nav.guides || []).map((g) => g.t).join(',');
      for (let s = 10; s <= 100; s += 10) { const a = pointAt(R, s); feed(a.p, 8, a.h); }
      t.renderNav();
      r.row = visible('#parkGoal') ? text('#parkGoalName') + ' ' + text('#parkGoalDist') : 'hidden';
      r.nextGoal = document.getElementById('nextTurn').classList.contains('goal');
      const mk = (t.getMap() && t.getMap().destMk) || null;
      // 네이버 지도 Marker.getIcon() = { content: 요소 }, OSM(Leaflet) 대체 지도 = L.divIcon (html 은 options.html)
      const hasP = (list) => list.some((m) => { try { const ic = m.getIcon ? m.getIcon() : m.options.icon; const html = ic.content ? ic.content.className || ic.content.outerHTML : (ic.options && ic.options.html) || ic.html || ''; return /parkpin/.test(html); } catch (e) { return false; } });
      r.pMark = !mk ? 'nomap' : hasP(mk);
      t.endNav(); softReset();
      // (e) v148 '그 건물 입구에 해당하면 됨 (없는 경우)': 주차장 입구가 없는 건물은 그 건물 입구로 — 차량 출입구 먼저, 나가기만 하는 출구는 빼고.
      //     다른 주차장은 찾지 않는다. 'P' 줄·P 표지 없음, 경로 카드 '입구로 안내 · …'
      const gNear = dest(D, 90, 40), gCar = dest(D, 270, 80), gExit = dest(D, 0, 20);
      const qs = [];
      stub.canned['/search'] = (q) => { qs.push(q.query); return /주차장입구/.test(q.query || '') ? { items: [] } : / 입구$/.test(q.query || '') ? { items: [
        { name: '테스트오피스텔101동입구', category: '도로시설>방면정보', addr: '', lat: gNear.lat, lng: gNear.lng },
        { name: '테스트오피스텔후문출구', category: '도로시설>방면정보', addr: '', lat: gExit.lat, lng: gExit.lng },
        { name: '테스트오피스텔차량출입구', category: '도로시설>방면정보', addr: '', lat: gCar.lat, lng: gCar.lng },
      ] } : { items: [] }; };
      const c1 = stub.calls.length;
      await withTimeout(t.pickDest({ name: '테스트오피스텔', addr: '', lat: D.lat, lng: D.lng, category: '주택>오피스텔' }), 5000, 'pickDest');
      await waitFor(() => stub.count('/route', c1) >= 1 && !t.nav.busy, 3000);
      const q2 = stub.since(c1, '/route')[0];
      r.gateGoal = !q2 ? 'none' : q2.query.goal === pt(gCar) ? 'car' : q2.query.goal === pt(gNear) ? 'near' : q2.query.goal === pt(gExit) ? 'exit' : q2.query.goal === pt(D) ? 'pin' : q2.query.goal;
      r.gateQueries = qs.join('|');
      r.gateCard = text('#rcParkName');
      if (!t.nav.active) t.startNav();
      for (let s = 10; s <= 100; s += 10) { const a = pointAt(R, s); feed(a.p, 8, a.h); }
      t.renderNav();
      r.gateRow = visible('#parkGoal');
      r.gateP = !mk ? 'nomap' : hasP((t.getMap() && t.getMap().destMk) || []);
      t.endNav(); softReset();
      // (f) 목적지가 이미 입구(…101동입구)인데 주차장 입구가 없으면 건물 입구를 또 찾지 않고 그 자리로
      qs.length = 0;
      const c2 = stub.calls.length;
      await withTimeout(t.pickDest({ name: '테스트오피스텔101동입구', addr: '', lat: gNear.lat, lng: gNear.lng, category: '도로시설>방면정보' }), 5000, 'pickDest');
      await waitFor(() => stub.count('/route', c2) >= 1 && !t.nav.busy, 3000);
      const q3 = stub.since(c2, '/route')[0];
      r.entranceKept = !!q3 && q3.query.goal === pt(gNear) && !qs.some((x) => / 입구$/.test(x));   // v228: 건물 찾기 검색은 있어도 입구를 또 찾지는 않는다
    } finally {
      t.endNav(); softReset();
      stub.canned['/search'] = { items: [] };
    }
    const ok = r.goal === '101' && r.guides === '2,3,88' /* v209: 마지막 회전도 안내 */ && /^101동 주차장 입출구 2\d0m$/.test(r.row) && !r.nextGoal && r.pMark !== false &&
      r.gateGoal === 'car' && r.gateQueries === '테스트오피스텔 주차장입구|테스트오피스텔 입구' && /^입구로 안내 · 테스트오피스텔차량출입구$/.test(r.gateCard) &&
      !r.gateRow && r.gateP !== true && r.entranceKept;
    return { pass: !!ok, detail: JSON.stringify(r) };
  }

  // S87: '놓침' 버튼 (v147, 2026-11-16 '누를때 알람만 밑에 떠서 누른지 모르겠거든? 누르면 파란색 뜨게 … 좀만 길게 … 크게'):
  //      116×52 이상, 누르면 바로 파란 바탕 '✓ 보냄' + 아래 알림, 2.5초 안에 또 누르면 다시 보내지 않고(알림도 없음), 2.5초 뒤 '놓침'으로
  async function s87() {
    const t = T(), r = {}, b = document.getElementById('camMissBtn'), toastEl = document.getElementById('toast');
    const prevHidden = b.hidden, keepSpots = t.mySpots.slice(), keepSpotRaw = t.store.get('mySpots');
    try {
      b.hidden = false;
      const rc = b.getBoundingClientRect();
      r.size = Math.round(rc.width) + 'x' + Math.round(rc.height);
      b.click();
      // v163: 서버가 받았다고 할 때 '✓ 보냄' (시험 페이지는 보내지 않아 바로 답이 온다)
      await waitFor(() => !b.classList.contains('sending') && /놓친 단속/.test(toastEl.hidden ? '' : toastEl.textContent), 2000, 10);
      r.text1 = b.textContent; r.blue = getComputedStyle(b).backgroundColor === 'rgb(29, 79, 184)';
      r.toast1 = !toastEl.hidden && /신고 접수 완료/.test(toastEl.textContent);   // v202
      toastEl.hidden = true;
      b.click();
      r.toast2 = !toastEl.hidden;
      await new Promise((res) => setTimeout(res, 2700));
      r.text3 = b.textContent; r.sentAfter = b.classList.contains('sent');
    } finally {
      clearTimeout(b._sentT); b.classList.remove('sent', 'saved', 'sending'); b.textContent = '잘못된 정보 신고'; b.hidden = prevHidden; toastEl.hidden = true;
      t.mySpots.length = 0; keepSpots.forEach((x) => t.mySpots.push(x)); t.store.set('mySpots', keepSpotRaw); t.applyUserSpots();   // v169
    }
    const [w, h] = r.size.split('x').map(Number);
    const ok = w >= 116 && h >= 52 && r.text1 === '✓ 보냄' && r.blue && r.toast1 && !r.toast2 && r.text3 === '잘못된 정보 신고' /* v202 */ && !r.sentAfter;
    return { pass: ok, detail: JSON.stringify(r) };
  }

  // ---- v148 지도 손 조작 도우미: #map 캔버스에 손가락(포인터) 이벤트를 보낸다
  function mapFinger() {
    const el = document.querySelector('#map .mapcanvas') || document.getElementById('map');
    const box = document.getElementById('map').getBoundingClientRect();
    const cx = box.left + box.width / 2, cy = box.top + box.height / 2;
    const P = (type, id, x, y) => el.dispatchEvent(new PointerEvent(type, { pointerId: id, clientX: x, clientY: y, button: 0,
      buttons: type === 'pointerup' ? 0 : 1, pointerType: 'touch', isPrimary: id === 1, bubbles: true, cancelable: true, composed: true }));
    return { el, cx, cy, P };
  }
  // S88: 따라가는 동안 확대·축소해도 따라가기·진행 방향이 풀리지 않는다 (v148, 사용자 '확대 축소하면 갑자기 내 방향이 풀려버린다')
  async function s88() {
    const t = T(), r = {};
    await waitFor(() => t.getMap(), 5000);
    const m = t.getMap(), f = mapFinger();
    const hup0 = t.prefs.headingUp;
    // 숨은 창에서는 애니메이션 프레임이 돌지 않아 지도의 부드러운 확대가 끝나지 않는다(배율 값이 그대로).
    // 그래서 배율 대신 앱이 지도에 시킨 확대 단계(zoomBy)를 센다. 테스트 지도(Leaflet)든 네이버 지도(Pages)든 같게
    const isL = m.map._leaflet_id != null;
    const anim0 = m.map._zoomAnimated;
    if (isL) m.map._zoomAnimated = false;
    const zb0 = m.zoomBy;
    let dz = 0;
    m.zoomBy = function (d) { dz += d; return zb0.call(this, d); };
    const steps = async (fn) => { dz = 0; await fn(); return dz; };
    const lib = () => (isL ? [m.map.touchZoom.enabled(), m.map.scrollWheelZoom.enabled(), m.map.doubleClickZoom.enabled()]
      : [m.map.getOptions('pinchZoom'), m.map.getOptions('scrollWheel'), !m.map.getOptions('disableDoubleTapZoom')]).map(Boolean);
    const setZ = (z) => { if (m.map.setZoom) m.map.setZoom(z, isL ? { animate: false } : false); };
    const pinch = async (grow, preMove) => {
      f.P('pointerdown', 1, f.cx - 30, f.cy);
      if (preMove) f.P('pointermove', 1, f.cx - 30 - preMove, f.cy);
      f.P('pointerdown', 2, f.cx + 30, f.cy);
      for (let k = 1; k <= 6; k++) f.P('pointermove', 2, f.cx + 30 + (grow ? 12 : -8) * k, f.cy);
      f.P('pointerup', 2, f.cx + 30, f.cy); f.P('pointerup', 1, f.cx - 30, f.cy);
      await sleep(400);
    };
    try {
      // 가: 북쪽 위 평면 지도(서 있을 때 같은 화면), 따라가는 중
      t.prefs.headingUp = false;
      feed(SEOUL, 0, null);
      t.setFollowing(true); t.layoutView(true);
      await sleep(150);
      r.ownFlat = t.ownZoom();
      r.libOff = lib().every((x) => !x);
      setZ(15); await sleep(100);
      r.zoomIn = await steps(() => pinch(true, 0)); r.followA = t.state.following;
      r.centerA = r0(hav(m.getCenter(), SEOUL));
      // 나: 첫 손가락이 15px 먼저 미끄러진 뒤 둘째 손가락 (실제 손가락은 동시에 닿지 않는다)
      r.zoomOut = -(await steps(() => pinch(false, 15))); r.followB = t.state.following;
      // 다: 두 번 톡 = 한 단계 확대, 따라가기 그대로
      setZ(15); await sleep(100);
      r.dbl = await steps(async () => {
        for (let k = 0; k < 2; k++) { f.P('pointerdown', 1, f.cx, f.cy); f.P('pointerup', 1, f.cx, f.cy); }
        await sleep(400);
      });
      r.followC = t.state.following;
      // 라: 손으로 지도를 둘러보는 중(따라가기 꺼짐)이면 확대는 다시 지도 라이브러리가 (손가락 사이를 중심으로)
      t.setFollowing(false, true);
      r.libBack = lib().every(Boolean);
      // 마: 진행 방향 위 주행 화면, 달리는 중: 첫 손가락이 먼저 움직여(앞길 보기로 바뀌어도) 확대가 끝나면 바로 따라가기·주행 화면
      t.prefs.headingUp = true;
      let p = SEOUL;
      for (let k = 0; k < 4; k++) { p = dest(p, 90, 12); feed(p, 40, 90); }
      t.setFollowing(true); t.layoutView(true);
      await sleep(200);
      r.drive = t.view.drive;
      setZ(15); await sleep(100);
      r.driveZoom = await steps(() => pinch(true, 15));
      r.driveFollow = t.state.following; r.driveView = t.view.drive;
      r.backMe = !document.getElementById('backMe').hidden;
      r.map = isL ? 'leaflet' : (m.gl ? 'naver-gl' : 'naver');
    } finally {
      t.prefs.headingUp = hup0;
      m.zoomBy = zb0;
      if (isL) m.map._zoomAnimated = anim0;
      t.setFollowing(true); t.layoutView(true);
      softReset();
    }
    const ok = r.ownFlat && r.libOff && r.zoomIn >= 1 && r.followA && r.centerA < 30 && r.zoomOut >= 1 && r.followB &&
      r.dbl === 1 && r.followC && r.libBack && r.drive && r.driveZoom >= 1 && r.driveFollow && r.driveView && !r.backMe;
    return { pass: !!ok, detail: JSON.stringify(r) };
  }

  // S89: 지도를 길게 누르면 그 자리 카드 (v148, 사용자 '지도를 찍어서 선택하면 간단한 정보랑 위치 찍을 수 있게, 경유지나')
  async function s89() {
    const t = T(), r = {};
    await waitFor(() => t.getMap(), 5000);
    const f = mapFinger(), poi = dest(SEOUL, 45, 20);
    const pt = (q) => q.lng.toFixed(6) + ',' + q.lat.toFixed(6);
    // 테스트 지도(Leaflet)는 길안내 서버 /reverse 를, 네이버 지도(Pages 에서 돌릴 때)는 네이버 지오코더를 쓴다: 둘 다 같은 답으로 바꿔 둔다
    const N = window.naver && naver.maps, isL = t.getMap().map._leaflet_id != null;
    let rg0 = null;
    if (N && !isL) {
      await t.describeAt(SEOUL);   // 지오코더를 받아 둔다
      if (N.Service && N.Service.reverseGeocode) {
        rg0 = N.Service.reverseGeocode;
        N.Service.reverseGeocode = (opt, cb) => setTimeout(() => cb(N.Service.Status.OK, { v2: {
          address: { roadAddress: '서울특별시 중구 세종대로 110 서울특별시청', jibunAddress: '서울특별시 중구 태평로1가 31' },
          results: [{ name: 'roadaddr', land: { name: '세종대로', number1: '110', addition0: { type: 'building', value: '서울특별시청' } } }],
        } }), 0);
      }
    }
    stub.canned['/reverse'] = { road: '세종대로', area: '서울특별시 중구 태평로1가' };
    // 장소 검색은 위치를 안 받는다: 건물 이름만 치면 둘레 '○○ 서울특별시청점' 식당만 나오고(강동구청에서 실제로 그랬다),
    // '<구> 건물 이름'을 쳐야 시청이 나온다 (v154). 주소(세종대로)로 찾으면 시청도 나온다 (OSM 지도 길)
    const far = dest(SEOUL, 0, 500), eat = dest(SEOUL, 300, 20);
    const FAR = { name: '먼 곳', category: '', addr: '', lat: far.lat, lng: far.lng };
    const EAT = { name: '한식당 서울특별시청점', category: '음식점>한식', addr: '서울특별시 중구 무교로 1', lat: eat.lat, lng: eat.lng };
    const HALL = { name: '서울특별시청', category: '공공,사회기관>특별,광역시청', addr: '서울특별시 중구 세종대로 110', lat: poi.lat, lng: poi.lng };
    const gh = dest(SEOUL, 120, 30), GUHALL = { name: '중구청', category: '공공,사회기관>구청', addr: '서울특별시 중구 창경궁로 17', lat: gh.lat, lng: gh.lng };
    stub.canned['/search'] = (q) => {
      const s = q.query || '';
      return { items: /세종대로/.test(s) ? [FAR, HALL] : /^중구 서울특별시청$/.test(s) ? [HALL, EAT, FAR] : s === '서울특별시청' ? [EAT, FAR]
        : s === '중구 중구청' ? [GUHALL, EAT] : s === '중구청' ? [EAT, FAR] : [] };
    };
    const press = async (ms, move, up) => {
      const y = f.cy - (up || 0);
      f.P('pointerdown', 1, f.cx, y);
      if (move) f.P('pointermove', 1, f.cx + move, y);
      await sleep(ms);
      f.P('pointerup', 1, f.cx + (move || 0), y);
    };
    try {
      // 건물 이름만으로는 식당만 나와도 '<구> 건물 이름' 결과의 시청(이름이 같음)을 고른다. 카드 분류는 끝말만
      const hall = await t.placeNear(SEOUL, '서울특별시청', '중구 세종대로 110');
      r.near = hall ? hall.name : 'none';
      r.nearQs = stub.since(0, '/search').slice(-2).map((c) => c.query.query).sort().join('|');
      r.tail = t.catTail('공공,사회기관>특별,광역시청');
      // v155: 건물 이름이 구 이름을 품어도('중구청' ⊃ '중구') '중구 중구청'을 찾는다 (강동구청에서 실제로 빠졌다)
      const gu = await t.placeNear(SEOUL, '중구청', '중구 창경궁로 17');
      r.guHall = gu ? gu.name : 'none';
      feed(SEOUL, 0, null);
      t.setFollowing(true); t.layoutView(true);
      await sleep(150);
      // 짧게 톡: 카드 없음
      await press(120);
      r.tapNone = !visible('#pickCard');
      // 손가락이 움직이면 길게 눌러도 카드 없음
      await press(700, 25);
      r.moveNone = !visible('#pickCard');
      t.setFollowing(true); await sleep(100);
      // 길게 누르기
      await press(700);
      r.shown = visible('#pickCard'); r.pin = !!document.querySelector('.pickpin');
      await waitFor(() => text('#pkName') === '서울특별시청', 3000);
      r.name = text('#pkName'); r.sub = text('#pkSub'); r.dist = text('#pkDist');
      r.go = text('#pkGo'); r.viaHidden = !visible('#pkVia'); r.follow = t.state.following;
      // 닫기
      document.getElementById('pkClose').click();
      r.closed = !visible('#pickCard') && !document.querySelector('.pickpin');
      // PC 오른쪽 클릭도 같은 카드 → [여기로 안내] = 찾은 장소 좌표로 길찾기
      f.el.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 9, clientX: f.cx, clientY: f.cy, button: 2, buttons: 2, pointerType: 'mouse', isPrimary: true, bubbles: true, cancelable: true }));
      f.el.dispatchEvent(new MouseEvent('contextmenu', { clientX: f.cx, clientY: f.cy, button: 2, bubbles: true, cancelable: true }));
      f.el.dispatchEvent(new PointerEvent('pointerup', { pointerId: 9, clientX: f.cx, clientY: f.cy, button: 2, buttons: 0, pointerType: 'mouse', isPrimary: true, bubbles: true, cancelable: true }));
      r.ctx = visible('#pickCard');
      await waitFor(() => text('#pkName') === '서울특별시청', 3000);
      const R = buildNavRoute();
      stub.canned['/route'] = R.route;
      const c0 = stub.calls.length;
      document.getElementById('pkGo').click();
      await waitFor(() => stub.count('/route', c0) >= 1 && !t.nav.busy, 4000);
      const q1 = stub.since(c0, '/route')[0];
      r.goal = q1 ? q1.query.goal === pt(poi) : 'none';
      r.destName = t.nav.dest ? t.nav.dest.name : '';
      r.cardGone = !visible('#pickCard');
      t.endNav();
      // 길안내 중: [목적지로] + [경유지로] → 경유지 넣고 다시 찾기
      await planAndStart(R);
      await sleep(150);
      await press(700, 0, 200);   // 차에서 200px 떨어진 곳 (테스트 지도는 약 200m. 차 바로 옆이면 경유지를 곧바로 지난 것으로 친다)
      r.navShown = visible('#pickCard');
      await waitFor(() => !/찾는 중/.test(text('#pkSub')), 3000);
      r.navGo = text('#pkGo'); r.navVia = visible('#pkVia') ? text('#pkVia') : 'hidden';
      // 네이버 지도(Pages)는 주행 화면 배율이 커서 200px 이 약 94m: 경유지 150m 안이면 곧바로 '통과'로 빼므로 그때는 고른 자리를 300m 앞으로
      const fx = t.state.fix, pk = t.state.pick;
      if (fx && pk && hav(fx, pk) < 200) { const fwd = dest(fx, 0, 300); pk.lat = fwd.lat; pk.lng = fwd.lng; pk.placeLat = null; }
      const c1 = stub.calls.length;
      document.getElementById('pkVia').click();
      await waitFor(() => stub.count('/route', c1) >= 1 && !t.nav.busy, 4000);
      const q2 = stub.since(c1, '/route')[0];
      r.waypoint = !!(q2 && q2.query.waypoints && t.nav.via && t.nav.via.length === 1);
      if (!r.waypoint) r.viaDbg = { via: (t.nav.via || []).length, busy: t.nav.busy, active: t.nav.active, routes: stub.count('/route', c1), q: q2 && q2.query, toast: text('#toast') };
    } finally {
      if (rg0) N.Service.reverseGeocode = rg0;
      t.closePick();
      t.endNav(); softReset();
      stub.canned['/search'] = { items: [] };
    }
    const ok = r.near === '서울특별시청' && r.nearQs === '서울특별시청|중구 서울특별시청' && r.tail === '특별,광역시청' && r.guHall === '중구청' &&
      r.tapNone && r.moveNone && r.shown && r.pin && r.name === '서울특별시청' && /^특별,광역시청 · /.test(r.sub) && /m$/.test(r.dist) &&
      r.go === '여기로 안내' && r.viaHidden && r.follow && r.closed && r.ctx && r.goal === true && r.destName === '서울특별시청' && r.cardGone &&
      r.navShown && r.navGo === '목적지로' && r.navVia === '경유지로' && r.waypoint;
    return { pass: !!ok, detail: JSON.stringify(r) };
  }

  // S90: 목적지 검색 (v148, 사용자 '목적지 검색할 때 너무 어렵다'): 그대로·구·동 붙인 검색을 합쳐 이름이 맞고 가까운 순서,
  // 지역을 이미 적었으면 그대로 한 번만, 주소처럼 보이면 주소 먼저, 자주 찾는 종류 버튼, 경유지 찾기는 경로에서 가까운 순서
  async function s90() {
    const t = T(), r = {};
    const near1 = dest(SEOUL, 90, 800), near2 = dest(SEOUL, 0, 1200), noise = dest(SEOUL, 180, 300);
    const far1 = dest(SEOUL, 270, 13000), far2 = dest(SEOUL, 260, 13500);
    const it = (name, p, category) => ({ name, category: category || '음식점>카페,디저트', addr: '테스트시 테스트로 1', lat: p.lat, lng: p.lng });
    const R = buildNavRoute();
    const onRoute = dest(R.P[7], 0, 40), offRoute = dest(R.P[0], 270, 250);
    stub.canned['/search'] = (q) => {
      const s = q.query || '';
      if (s === '스타벅스' && t.nav.active) return { items: [it('스타벅스 경로옆점', onRoute), it('스타벅스 출발옆점', offRoute)] };
      if (s === '스타벅스') return { items: [it('스타벅스 시청점', far1), it('스타벅스 무교로점', far2)] };
      if (s === '강동구 스타벅스') return { items: [it('스타벅스 강동역점', near2), it('스타벅스 올림픽공원점', near1)] };
      if (s === '성내동 스타벅스') return { items: [it('스타벅스 올림픽공원점', near1), it('제이스크린골프존', noise, '스포츠,오락>골프연습장')] };
      if (s === '하남 코스트코') return { items: [it('코스트코코리아 하남점', far1, '쇼핑,유통>대형마트')] };
      return { items: [] };
    };
    stub.canned['/geocode'] = (q) => (/성내로\s*25/.test(q.query || '') ? { items: [{ name: '서울특별시 강동구 성내로 25', addr: '서울특별시 강동구 성내동 540', lat: near1.lat, lng: near1.lng }] } : { items: [] });
    const names = () => [...document.querySelectorAll('#results .result .nm')].map((e) => e.textContent).join(',');
    const area0 = t.road.area;
    try {
      feed(SEOUL, 0, null);
      t.road.area = '서울특별시 강동구 성내동';
      t.openSearch('dest');
      r.cats = [...document.querySelectorAll('#results .qcat')].map((b) => b.textContent).join(',');
      const q = document.getElementById('q');
      q.value = '스타벅스';
      let c0 = stub.calls.length;
      await t.doSearch();
      r.queries = stub.since(c0, '/search').map((c) => c.query.query).sort().join('|');
      r.order = names();
      r.title = text('#results .rtitle');
      q.value = '하남 코스트코'; c0 = stub.calls.length;
      await t.doSearch();
      r.hanam = stub.since(c0, '/search').map((c) => c.query.query).join('|');
      // v155: '강동구청'은 '강동구'를 글자로 품어도 지역을 적은 게 아니다 → 구·동 붙인 검색도 한다. '강동구 카페'처럼 낱말이면 그대로
      t.road.area = '서울특별시 강동구 성내동';
      r.guHall = t.queryVariants('강동구청').join('|');
      r.guWord = t.queryVariants('스타벅스 강동구').join('|');
      q.value = '성내로 25';
      await t.doSearch();
      r.addrFirst = text('#results .rtitle');
      // 자주 찾는 종류 버튼
      q.value = ''; t.openSearch('dest');
      c0 = stub.calls.length;
      const chip = document.querySelector('#results .qcat');
      if (chip) chip.click();
      await waitFor(() => stub.count('/search', c0) >= 1, 2000);
      r.chip = (stub.since(c0, '/search')[0] || { query: {} }).query.query;
      await waitFor(() => !/검색 중/.test(text('#results')), 2000);
      document.getElementById('searchClose').click();
      // 길안내 중 경유지 찾기: 경로에서 가까운 곳이 먼저, 거리는 '경로 …'
      await planAndStart(R);
      t.road.area = '';
      t.openSearch('via');
      q.value = '스타벅스';
      await t.doSearch();
      r.viaOrder = names();
      r.viaDist = text('#results .result .dist');
      document.getElementById('searchClose').click();
    } finally {
      t.road.area = area0;
      t.endNav(); softReset();
      stub.canned['/search'] = { items: [] }; stub.canned['/geocode'] = { items: [] };
    }
    const ok = r.cats.startsWith('수퍼차저,') && r.queries === '강동구 스타벅스|성내동 스타벅스|스타벅스' &&
      r.order === '스타벅스 올림픽공원점,스타벅스 강동역점,제이스크린골프존,스타벅스 시청점,스타벅스 무교로점' && r.title === '장소' &&
      r.hanam === '하남 코스트코' && r.addrFirst === '주소' && r.chip === '수퍼차저' &&
      r.guHall === '강동구청|강동구 강동구청|성내동 강동구청' && r.guWord === '스타벅스 강동구|성내동 스타벅스 강동구' &&
      r.viaOrder === '스타벅스 경로옆점,스타벅스 출발옆점' && /^경로 (3\d|4\d)m$/.test(r.viaDist);
    return { pass: !!ok, detail: JSON.stringify(r) };
  }

  // S60: 지도 위 회전 화살표 + 목적지 핀·점선 (2026-11-14 요청: 휴대폰 내비처럼)
  async function s60() {
    const t = T(), R = buildNavRoute(), r = {};
    const bld = dest(R.P[9], 0, 40);   // 경로 끝에서 40m 떨어진 건물
    R.dest = Object.assign({}, R.dest, { lat: bld.lat, lng: bld.lng });
    // 새로 연 숨은 창(0×0)에서 맨 먼저 돌면 지도가 아직 없다 (S82 와 같은 출발 경쟁, 'reading route of null')
    await waitFor(() => t.getMap(), 5000);
    try {
      await planAndStart(R);
      const m = t.getMap();
      r.pin = !!document.querySelector('.destpin');
      r.dots = document.querySelectorAll('.destdot').length;
      r.leg = (t.getMap()._legObjs || []).length;   // v209: 경로 끝에서 건물로 들어가는 화살표 (테두리·흰 몸통·화살촉)
      // 경로선 (v92 요청): 검은 테두리 없이 빛 번짐·본선·가운데 빛·흰 점
      r.kinds = [...new Set((m.route || []).map((pc) => pc.kind))].sort().join('+');
      let a = pointAt(R, 100); feed(a.p, 15, a.h); t.renderNav();
      r.farNone = !(m._arrowObjs || []).length;                 // 다음 안내가 직진이거나 400m 밖
      a = pointAt(R, 300); feed(a.p, 15, a.h); t.renderNav();   // 우회전 300m 앞
      r.near = (m._arrowObjs || []).length;                     // 테두리 몸통·화살촉 + 흰 몸통·화살촉
      // 모서리 (2026-11-14 요청: 도로처럼): 90° 로 꺾이는 점 R.P[5] 를 경로선·화살표 모두 같은 곡선으로 돌아간다 (꼭짓점에서 약 2.8m 안쪽)
      const minTo = (L, q) => Math.min(...(L || []).map((x) => hav(x, q)));
      r.corner = m.disp ? Math.round(minTo(m.disp.pts, R.P[5]) * 10) / 10 : -1;
      r.arrowCorner = Math.round(minTo(m._arrowShown, R.P[5]) * 10) / 10;
      // 회전 지점 뒤로 배율에 맞춘 길이(가까이 30m, 멀리 볼수록 화면 30px 만큼·최대 100m)까지
      const shown = m._arrowShown || [], end = shown[shown.length - 1], span = m._arrowSpan || {};
      r.span = Math.round(span.after || -1);
      r.endFromTurn = end ? Math.round(hav(end, dest(R.P[5], 90, span.after))) : -1;
      // 멀리 보면(배율 14 아래) 화살표를 그리지 않고, 다시 가까이 보면 다시 그린다 (v92 피드백: 축소하면 지도에 비해 너무 큼)
      // 애니메이션 없이 배율 바꾸기 (네이버: setZoom(z, false), Leaflet 대체 지도: { animate: false })
      const z0 = m.map.getZoom(), setZ = (z) => m.map.setZoom(z, m.map._leaflet_id != null ? { animate: false } : false);
      setZ(13); m.drawArrow();
      r.zoomOutHidden = !(m._arrowObjs || []).length;
      setZ(z0); m.drawArrow();
      r.zoomBack = (m._arrowObjs || []).length;
      a = pointAt(R, R.cum[5] + 40); feed(a.p, 15, a.h); t.renderNav();
      r.after = (m._arrowObjs || []).length;                    // 그다음은 목적지: 화살표 없음
      t.endNav();
      r.cleared = !(m.destMk || []).length && !(m._arrowObjs || []).length && !(m._legObjs || []).length && !document.querySelector('.destpin');
    } finally {
      softReset();
    }
    const ok = r.pin && r.dots >= 1 /* v246: 건물 쪽 20m 화살표 뒤 점선 */ && r.leg === 4 && /^base\+dots\+glow\+shine/.test(r.kinds) && r.farNone && r.near === 4 && r.corner >= 2 && r.corner <= 4 && Math.abs(r.arrowCorner - r.corner) < 0.3 && r.span >= 25 && r.span <= 100 && r.endFromTurn >= 0 && r.endFromTurn <= 3 &&
      r.zoomOutHidden && r.zoomBack === 4 && r.after === 0 && r.cleared;
    return { pass: !!ok, detail: Object.keys(r).map((k) => k + '=' + r[k]).join(', ') };
  }

  // S78: 본선 그대로 가는 분기점은 직진 (v133, 2026-11-16 주행 중 신갈분기점 '서울' 방면). 북쪽으로 곧은 3km 고속도로:
  //      1.5km 신갈분기점 '왼쪽 도로 주행'(경부고속도로 구간이 앞뒤로 이어짐) → 직진, 2.5km 판교분기점 '오른쪽 방향'(구간이 바뀜) → 비켜 가기
  async function s78() {
    const t = T(), r = {};
    const raw = [];
    for (let k = 0; k <= 30; k++) raw.push(dest(NAV_ORIGIN, 0, 100 * k));
    const path = raw.map((p) => [round6(p.lng), round6(p.lat)]);
    const P = path.map((x) => ({ lat: x[1], lng: x[0] }));
    const cum = [0];
    for (let i = 1; i < P.length; i++) cum.push(cum[i - 1] + hav(P[i - 1], P[i]));
    const total = cum[cum.length - 1];
    const R = {
      route: { distance: r0(total), duration: r0(total / 25 * 1000), tollFare: 0, fuelPrice: 300, path,
        guide: [{ i: 3, t: 66, s: "오산IC에서 '서울' 방면으로 오른쪽 고속도로 진입", d: r0(cum[3]), ms: 10000 },
                { i: 15, t: 41, s: "신갈분기점에서 '서울' 방면으로 왼쪽 도로 주행", d: r0(cum[15] - cum[3]), ms: 40000 },
                { i: 25, t: 5, s: "판교분기점에서 '일산, 구리' 방면으로 오른쪽 방향", d: r0(cum[25] - cum[15]), ms: 40000 },
                { i: 30, t: 88, s: '목적지', d: r0(total - cum[25]), ms: 20000 }],
        sections: [{ i: 3, n: 23, name: '경부고속도로', speed: 80, cong: 1 }, { i: 25, n: 6, name: '수도권제1순환고속도로', speed: 80, cong: 1 }] },
      P, cum, total, dest: { name: '본선 테스트', addr: '', lat: P[30].lat, lng: P[30].lng },
    };
    const go = (s) => { const a = pointAt(R, s); feed(a.p, 25, a.h); t.renderNav(); };
    const snap = () => {
      const el = document.getElementById('juncCard'), img = el.querySelector('#juncSvg img.jv-day');
      return { text: text('#turnText'), kind: t.turnKind(t.nav.next), junc: visible('#juncCard'), main: el.classList.contains('main'), left: el.classList.contains('left'),
        img: img ? img.getAttribute('src').replace(/^.*\/img\/ai\//, '').replace(/\?.*$/, '') : '', flip: img ? getComputedStyle(img).transform : '',
        // v197: 본선 그대로는 네이버식 장면 jc-main (본선 차로를 칠함), 표지판에 경부 방패 1
        scene: (() => { const sv = el.querySelector('#juncSvg svg.nv'); return sv ? sv.getAttribute('class').replace(/^nv /, '') + ':' + sv.dataset.go : ''; })(),
        straightSign: !!el.querySelector('#juncLabel .sg-arrow path[d^="M12 28V10"]'), sign: text('#juncLabel'),
        // v143: 안내 칸 그림 — 본선 그대로는 네이버 '도로 주행' 그림(ml/mr), '오른쪽 방향'은 굵은 화살표 하나(sr 그림)
        icon: (() => { const ti = document.querySelector('#turnIcon svg, #turnIcon img'); if (!ti) return ''; if (ti.tagName === 'IMG') return ti.getAttribute('src').replace(/^.*\/img\/ai\//, '').split('__')[0]; return (ti.getAttribute('class') || '').replace(/\s+/g, ' ').trim(); })() };
    };
    const unstash = stashJx();
    try {
      softReset();
      await planAndStart(R);
      for (let s = 20; s <= 920; s += 20) go(s);
      r.singal = snap();                     // 신갈분기점 580m 앞 (v248: 분기점 그림은 600m 앞부터)
      for (let s = 940; s <= 2000; s += 20) go(s);
      r.pangyo = snap();                     // 판교분기점 500m 앞
    } finally {
      unstash();
      t.endNav(); softReset();
    }
    const a = r.singal, b = r.pangyo;
    // v253 (jx 비교표 1번): 차로 단면이 없는 본선 그대로(이 합성 길)는 네이버처럼 분기점 그림 칸이 없다 — 글·아이콘은 그대로 '직진'
    const ok = !!a && !!b && a.kind === 's' && a.text === '신갈분기점에서 직진 · 서울 방면' && !a.junc && a.scene === '' &&
      b.kind === 'kr' && /오른쪽 방향/.test(b.text) && b.junc && !b.main && !b.straightSign &&
      /\bml\b/.test(a.icon) && b.icon === 'sr';
    return { pass: ok, detail: JSON.stringify(r) };
  }

  // S79: 휴게소 진입로 갈림점 + 위로 올리기 (v133, 2026-11-16 주행 중 '200m 정도 차이', '네이버처럼 위로').
  //      북쪽으로 곧은 12km 고속도로. 휴게소 가운데는 5km 지점 오른쪽 150m, 진입로 갈림점은 4.75km 지점(본선 위, 진행 방향 0°).
  //      톨게이트 5.3km. 1km: 밑 파란 줄 3.8km(3,750m). 2km: 위 줄이 휴게소 2.8km(2,750m), 그다음 칸은 톨게이트 550m(휴게소 → 톨게이트).
  //      4.4km: 톨게이트 900m(1km 안)라 위 줄은 톨게이트, 휴게소는 밑 파란 줄 350m. 4.8km(갈림점 지남): 휴게소 없음
  async function s79() {
    const t = T(), r = {};
    const raw = [];
    for (let k = 0; k <= 120; k++) raw.push(dest(NAV_ORIGIN, 0, 100 * k));
    const path = raw.map((p) => [round6(p.lng), round6(p.lat)]);
    const P = path.map((x) => ({ lat: x[1], lng: x[0] }));
    const cum = [0];
    for (let i = 1; i < P.length; i++) cum.push(cum[i - 1] + hav(P[i - 1], P[i]));
    const total = cum[cum.length - 1];
    const R = {
      route: { distance: r0(total), duration: r0(total / 25 * 1000), tollFare: 0, fuelPrice: 300, path,
        guide: [{ i: 3, t: 66, s: "기흥IC에서 '서울' 방면으로 오른쪽 고속도로 진입", d: r0(cum[3]), ms: 10000 },
                { i: 53, t: 121, s: '서울톨게이트 (통행료 2,600원)', d: r0(cum[53] - cum[3]), ms: 200000 },
                { i: 120, t: 88, s: '목적지', d: r0(total - cum[53]), ms: 300000 }],
        sections: [{ i: 3, n: 118, name: '경부고속도로', speed: 90, cong: 1 }] },
      P, cum, total, dest: { name: '휴게소 테스트', addr: '', lat: P[120].lat, lng: P[120].lng },
    };
    const C = dest(pointAt(R, 5000).p, 90, 150), E = pointAt(R, 4750).p;
    const go = (s) => { const a = pointAt(R, s); feed(a.p, 25, a.h); t.renderNav(); };
    const snap = () => ({ top: document.querySelector('#navPanel .turn').classList.contains('rest-main'), dist: text('#turnDist'), text: text('#turnText'),
      next: visible('#nextTurn') ? text('#nextDist') : '', nextToll: !!document.querySelector('#nextIcon .toll, #nextIcon img[src*="toll"]'),
      row: visible('#restCard') ? text('#restName') + ' ' + text('#restDist') : '' });
    try {
      t.setRestData({ count: 1, items: [[C.lat, C.lng, '테스트휴게소', '서울', '경부선']], entries: [[[round6(E.lat), round6(E.lng), 0]]] });
      softReset();
      await planAndStart(R);
      const list = t.ensureRouteRest() || [];
      r.at = list[0] ? Math.round(list[0].at) : null; r.mid = list[0] ? Math.round(list[0].mid) : null;
      for (let s = 20; s <= 1000; s += 20) go(s);
      r.km1 = snap();
      for (let s = 1020; s <= 2000; s += 20) go(s);
      r.km2 = snap();
      for (let s = 2020; s <= 4400; s += 20) go(s);
      r.km44 = snap();
      for (let s = 4420; s <= 4800; s += 20) go(s);
      r.km48 = snap();
      // v140 (2026-11-16 잠실 석촌호수사거리에서 '서울하이패스센터쉼터 19km'): 시내에서는 휴게소 줄 없음.
      //      같은 길인데 고속도로 진입이 4.0km 지점이면 1km 에서는 없고(진입 3km 앞), 2.2km 에서(진입 1.8km 앞) 나온다
      t.endNav(); softReset();
      const R3 = { ...R, route: { ...R.route, guide: [{ ...R.route.guide[0], i: 40, d: r0(cum[40]) }, ...R.route.guide.slice(1).map((g) => ({ ...g }))],
        sections: [{ i: 40, n: 81, name: '경부고속도로', speed: 90, cong: 1 }] } };
      await planAndStart(R3);
      for (let s = 20; s <= 1000; s += 20) go(s);
      r.city = snap().row;
      for (let s = 1020; s <= 2200; s += 20) go(s);
      r.nearIn = snap().row;
    } finally {
      t.endNav(); softReset();
      try { const j = await (await realFetch(new URL('../data/rest.json', location.href).href, { cache: 'no-store' })).json(); t.setRestData(j); } catch (e) { /* 다음 실행 때 */ }
    }
    const ok = r.at != null && Math.abs(r.at - 4750) <= 3 && Math.abs(r.mid - 5000) <= 3 &&
      !r.km1.top && r.km1.row === '테스트휴게소 3.8km' &&
      r.km2.top && r.km2.dist === '2.8km' && r.km2.text === '테스트휴게소' && r.km2.next === '550m' && r.km2.nextToll && r.km2.row === '' &&
      !r.km44.top && r.km44.dist === '900m' && /서울톨게이트/.test(r.km44.text) && r.km44.row === '테스트휴게소 350m' &&
      !r.km48.top && r.km48.row === '' && r.city === '' && r.nearIn === '테스트휴게소 2.6km';
    return { pass: ok, detail: JSON.stringify(r) };
  }

  // S83: 좌우는 한 값 (v141, 2026-11-16 송파IC '오른쪽 진입'인데 IN 그림이 왼쪽으로 빠지는 모양, 운전자 '로직 잘 좀 봐줘').
  //      (a) 좌우가 있는 아이콘 종류마다 그려진 화살표 끝(가장 위의 흰 점, 도로·방패·차선 점선은 뺌)이 그쪽 절반에 있다.
  //          AI 그림(<img>)은 파일 이름(… '_l__' / 'kl__')의 좌우가 같다
  //      (b) 저장된 실제 네이버 경로 20개의 모든 안내: 문장 동작('오른쪽 고속도로 진입')의 좌우 = 아이콘 종류의 좌우 = 그려진 화살표 끝 쪽 = 분기점 그림 좌우
  //      (c) 하남IC '오른쪽 고속도로 진입' 600m 앞에서 안내 칸(#turnIcon)의 화살표 끝이 오른쪽
  //      (d) 코드와 문장이 어긋나면 문장을 따른다 (66 인데 '왼쪽 고속도로 진입' → inl)
  async function s83() {
    const t = T(), r = { tips: {}, bad: [], guides: 0, sided: 0, junc: 0 };
    const KINDS = ['l', 'r', 'sl', 'sr', 'sharp_l', 'sharp_r', 'kl', 'kr', 'ml', 'mr', 'inl', 'inr', 'outl', 'outr', 'rb_l', 'rb_r',
      'over_l', 'over_r', 'under_l', 'under_r', 'side_l', 'side_r', 'oside_l', 'oside_r'];
    const box = document.createElement('div');
    box.className = 'turnicon';
    box.style.cssText = 'position:fixed;left:0;top:0;width:96px;height:96px;opacity:0;pointer-events:none';
    document.body.appendChild(box);
    const tipOf = (root) => {
      const img = root.querySelector('img');
      if (img) { const base = decodeURIComponent(img.src.split('/').pop().split('?')[0]).split('__')[0]; const c = base.slice(-1); return c === 'l' || c === 'r' ? c : '?' + base; }
      const svg = root.querySelector('svg');
      if (!svg) return '?none';
      if (root === box) { svg.style.width = '96px'; svg.style.height = '96px'; }
      const rc = svg.getBoundingClientRect(), cx = rc.left + rc.width / 2;
      let top = null;
      for (const el of svg.querySelectorAll('path,polygon,polyline,line,rect,circle,ellipse')) {
        if (el.closest('.shield') || /\b(rd-f|rd-s|jc-rd|jc-isl|tg-road)\b/.test(el.getAttribute('class') || '') || el.hasAttribute('stroke-dasharray')) continue;
        const len = el.getTotalLength ? el.getTotalLength() : 0, m = el.getScreenCTM();
        if (!len || !m) continue;
        for (let k = 0; k <= 80; k++) {
          const q = el.getPointAtLength(len * k / 80), p = new DOMPoint(q.x, q.y).matrixTransform(m);
          if (!top || p.y < top.y - 0.01) top = p;
        }
      }
      if (!top) return '?empty';
      return top.x < cx - 2 ? 'l' : top.x > cx + 2 ? 'r' : 'c';
    };
    const drawn = (html) => { box.innerHTML = html; return tipOf(box); };
    try {
      for (const k of KINDS) {
        const s = drawn(t.ico(k));
        r.tips[k] = s;
        if (s !== k.slice(-1)) r.bad.push('icon ' + k + ' drawn ' + s);
      }
      const FILES = ['route-night-seongnam-giheung', 'route-songpa-seongnam-s', 'route-songpa-n', 'route-bokjeong-n', 'route-bundang-suseo-n', 'route-daejeon-yuseong',
        'route-gapyeong-cheongpyeong', 'route-gapyeong-ne', 'route-gapyeong-sw', 'route-gapyeong-town', 'route-hanam-paldang-n', 'route-paldang-east',
        'route-paldang-hanamic-s', 'route-paldang-west', 'route-ring1-pangyo', 'route-yangseo-bukhangang-n', 'route-yangseo-bukhangang-s',
        'route-gildong-left', 'route-gyeongbu-jukjeon-n', 'route-seoultg-n'];
      r.files = 0;
      for (const f of FILES) {
        let fx = null;
        try { fx = await (await realFetch(harnessDir + 'fixtures/' + f + '.json', { cache: 'no-store' })).json(); } catch (e) { r.bad.push('load ' + f); continue; }
        const route = fx.path ? fx : fx.route && fx.route.path ? fx.route : fx.alternatives ? fx.alternatives[0] : null;
        if (!route || !route.guide) { r.bad.push('shape ' + f); continue; }
        r.files++;
        for (const g of route.guide) {
          r.guides++;
          const ts = t.textSide(g.s);
          if (!ts) continue;
          r.sided++;
          const k = t.turnKind0(g), ks = t.kindSide(k), dr = drawn(t.ico(t.iconKind(g)));
          if (ks !== ts || dr !== ts) r.bad.push(f + ' "' + g.s + '" text ' + ts + ' kind ' + k + ' drawn ' + dr);
          const j = t.juncInfo(g);
          if (j) { r.junc++; if (j.left !== (ts === 'l')) r.bad.push(f + ' junction "' + g.s + '" left=' + j.left); }
        }
      }
      // (c) 실제 안내 칸: 하남IC 오른쪽 고속도로 진입 600m 앞
      const fx = await (await realFetch(harnessDir + 'fixtures/route-paldang-hanamic-s.json', { cache: 'no-store' })).json();
      const P = fx.path.map((x) => ({ lat: x[1], lng: x[0] }));
      const cum = [0];
      for (let i = 1; i < P.length; i++) cum.push(cum[i - 1] + hav(P[i - 1], P[i]));
      const R = { route: fx, P, cum, total: cum[cum.length - 1], dest: { name: '하남', addr: '', lat: P[P.length - 1].lat, lng: P[P.length - 1].lng } };
      const gIn = fx.guide.find((g) => g.t === 66);
      const at = cum[Math.min(gIn.i, cum.length - 1)];
      softReset();
      await planAndStart(R);
      for (let s = Math.max(0, at - 1500); s <= at - 600; s += 20) { const a = pointAt(R, s); feed(a.p, 15, a.h); }
      t.renderNav();
      r.panelText = text('#turnText');
      r.panelTip = tipOf(document.getElementById('turnIcon'));
      t.endNav(); softReset();
      // (d)
      r.conflict = t.turnKind0({ t: 66, i: 0, s: "X에서 'Y' 방면으로 왼쪽 고속도로 진입" });
      r.songpa = t.turnKind0({ t: 66, i: 0, s: "송파IC에서 '판교, 성남' 방면으로 오른쪽 고속도로 진입" });
      // v143 판교분기점(20:31 네이버 '4.1km 대전' 굵은 화살표 하나, '1.6km' 도로 주행 그림)
      r.pgJc = t.iconKind({ t: 5, i: 0, s: "판교분기점에서 '경부고속도로, 대전, 판교' 방면으로 오른쪽 방향" });
      r.pgIc = t.iconKind({ t: 42, i: 0, s: "판교IC에서 '대전, 신갈분기점' 방면으로 오른쪽 도로 주행" });
      r.pgJcImg = (/src="[^"]*\/img\/ai\/([^"?]+)/.exec(t.ico(r.pgJc)) || [])[1] || '';
    } finally { box.remove(); t.endNav(); softReset(); }
    const ok = !r.bad.length && r.files === 20 && r.sided >= 90 && r.junc >= 25 && /오른쪽 진입/.test(r.panelText) && r.panelTip === 'r' &&
      r.conflict === 'inl' && r.songpa === 'inr' && r.pgJc === 'kr' && /^sr__/.test(r.pgJcImg) && r.pgIc === 'mr';
    return { pass: ok, detail: JSON.stringify(r) };
  }

  // S81: 신호 카메라는 찍는 방향의 접근로 정지선에 (v138, 2026-11-16 길동사거리: 원본 좌표가 교차로 한가운데라 좌회전하는 경로에서
  //      우리 접근로 카메라가 빠지고 좌회전 뒤 천호대로 카메라가 '240m'로 잡혔다. 네이버 211m, 회전 60m 일 때 카메라 90m).
  //      좌회전 300m·100m 앞에서 경고 카메라는 양재대로 북행(25009)이고, 카메라 거리 ≤ 회전 거리, 회전 뒤에는 천호대로 카메라를 알리지 않는다
  async function s81() {
    const t = T(), r = {};
    const fx = await (await realFetch(harnessDir + 'fixtures/route-gildong-left.json', { cache: 'no-store' })).json();
    const P = fx.path.map((x) => ({ lat: x[1], lng: x[0] }));
    const cum = [0];
    for (let i = 1; i < P.length; i++) cum.push(cum[i - 1] + hav(P[i - 1], P[i]));
    const R = { route: fx, P, cum, total: cum[cum.length - 1], dest: { name: '천호', addr: '', lat: P[P.length - 1].lat, lng: P[P.length - 1].lng } };
    const turnS = cum[fx.guide.find((g) => g.t === 2).i];
    const N = { lat: 37.53408, lng: 127.13883 }, W = { lat: 37.53426, lng: 127.13841 };
    const snap = () => { const tg = t.camState.target; return { cam: tg ? (sameCam(tg.c, N) ? 'N' : sameCam(tg.c, W) ? 'W' : tg.c[0] + ',' + tg.c[1]) : '-', camM: distM(text('#camDist')), turnM: distM(text('#turnDist')) }; };
    try {
      softReset();
      await planAndStart(R);
      for (let s = 0; s <= turnS - 300; s += 15) { const a = pointAt(R, s); feed(a.p, 12, a.h); }
      t.renderNav(); r.at300 = snap();
      for (let s = turnS - 285; s <= turnS - 100; s += 15) { const a = pointAt(R, s); feed(a.p, 12, a.h); }
      t.renderNav(); r.at100 = snap();
      let west = false;
      for (let s = turnS - 85; s <= Math.min(R.total - 30, turnS + 300); s += 15) {
        const a = pointAt(R, s); feed(a.p, 12, a.h);
        const tg = t.camState.target;
        if (s > turnS + 10 && tg && sameCam(tg.c, W)) west = true;
      }
      r.westAfterTurn = west;
    } finally {
      t.endNav(); softReset();
    }
    const okAt = (o) => o.cam === 'N' && o.camM !== null && o.turnM !== null && o.camM <= o.turnM;
    const ok = okAt(r.at300) && okAt(r.at100) && !r.westAfterTurn;
    return { pass: ok, detail: JSON.stringify(r) };
  }

  // S80: 2026-11-16 아침 경부 상행 실제 경로(죽전 → 서울TG → 판교 앞, test/fixtures/route-gyeongbu-jukjeon-n.json)로 v135 세 가지:
  //      (a) 서울하이패스센터쉼터는 하행 본선에서만 들어가는 곳(OSM 갈림점 179°)이라 상행 경로 휴게소에서 빠진다
  //      (b) 구간단속 끝 카메라(20926, 제한 110, 찍는 방향 359°)는 구간 시작을 못 봤어도(수원신갈IC 로 중간에 들어옴) 지점 카메라로 알린다
  //      (c) 서울톨게이트 광장(안내 지점 ±600m)에서는 경로선에서 60m 떨어져 달려도 재탐색하지 않는다. 광장 밖에서 60m 면 재탐색
  //      (d) 10Hz GPS 로 0.3초(3번)만 40m 벗어난 것은 재탐색하지 않는다
  async function s80() {
    const t = T(), r = {};
    const fx = await (await realFetch(harnessDir + 'fixtures/route-gyeongbu-jukjeon-n.json', { cache: 'no-store' })).json();
    const P = fx.path.map((x) => ({ lat: x[1], lng: x[0] }));
    const cum = [0];
    for (let i = 1; i < P.length; i++) cum.push(cum[i - 1] + hav(P[i - 1], P[i]));
    const R = { route: fx, P, cum, total: cum[cum.length - 1], dest: { name: '경부 상행', addr: '', lat: P[P.length - 1].lat, lng: P[P.length - 1].lng } };
    const CAM = { lat: 37.3539, lng: 127.10339 };
    let camS = 0, camD = Infinity;
    for (let s = 0; s <= R.total; s += 5) { const d = hav(pointAt(R, s).p, CAM); if (d < camD) { camD = d; camS = s; } }
    const tgS = cum[fx.guide.find((g) => g.t === 121).i];
    try {
      t.setRestData(await (await realFetch(new URL('../data/rest.json', location.href).href, { cache: 'no-store' })).json());   // 진입로 갈림점(entries)이 든 지금 자료
      softReset();
      await planAndStart(R);
      r.rest = (t.ensureRouteRest() || []).map((x) => x.name).join(',') || '-';
      let alertAt = null;
      for (let s = 0; s <= camS + 60; s += 25) {
        const a = pointAt(R, s); feed(a.p, 25, a.h);
        const tg = t.camState.target;
        if (alertAt === null && tg && sameCam(tg.c, CAM)) alertAt = s;
      }
      r.camBefore = alertAt === null ? null : Math.round(camS - alertAt);
      r.section = !!t.camState.section;
      // (d) 0.3초 동안 40m 옆
      const c1 = stub.calls.length;
      { const a = pointAt(R, camS + 100); for (let k = 0; k < 3; k++) feed(dest(a.p, a.h + 90, 40), 25, a.h, { dt: 100 }); }
      for (let s = camS + 110; s <= tgS - 700; s += 25) { const a = pointAt(R, s); feed(a.p, 25, a.h); }
      r.jitterReroutes = stub.since(c1, '/route').length;
      // (c) 광장: 60m 옆으로 1km
      const c2 = stub.calls.length;
      let onAll = true;
      for (let s = tgS - 680; s <= tgS + 500; s += 20) {
        const a = pointAt(R, s), off = s >= tgS - 500;
        feed(off ? dest(a.p, a.h + 90, 60) : a.p, 20, a.h);
        if (off && !t.nav.onRoute) onAll = false;
      }
      r.plazaReroutes = stub.since(c2, '/route').length; r.plazaOnRoute = onAll;
      for (let s = tgS + 520; s <= tgS + 700; s += 20) { const a = pointAt(R, s); feed(a.p, 20, a.h); }
      // 광장 밖 60m 옆: 재탐색
      const c3 = stub.calls.length;
      for (let s = tgS + 720; s <= Math.min(R.total - 50, tgS + 900); s += 20) { const a = pointAt(R, s); feed(dest(a.p, a.h + 90, 60), 20, a.h); }
      await sleep(50);
      r.outsideReroutes = stub.since(c3, '/route').length;
    } finally {
      t.endNav(); softReset();
    }
    const ok = !/서울하이패스센터쉼터/.test(r.rest) && r.camBefore !== null && r.camBefore >= 250 && !r.section &&
      r.jitterReroutes === 0 && r.plazaReroutes === 0 && r.plazaOnRoute && r.outsideReroutes >= 1;
    return { pass: ok, detail: JSON.stringify(r) + ' (camera at ' + Math.round(camS) + ' m, toll at ' + Math.round(tgS) + ' m)' };
  }

  // S61: 고속도로 휴게소 (2026-11-14 요청). 북쪽→동쪽으로 가는 경로 옆: 오른쪽 휴게소·양방향 휴게소만, 왼쪽(반대 방향)·먼 것은 빼고,
  //      같은 자리 두 이름(복합휴게소 + 방향 휴게소)은 하나로
  async function s61() {
    const t = T(), r = {};
    const mkRest = (R) => {
      const at = (s, side, m) => dest(pointAt(R, s).p, side, m);
      const D = at(100, 270, 100), B = at(300, 270, 150), A = at(760, 180, 120), A2 = at(780, 180, 110), E = at(350, 90, 900);
      return { count: 5, items: [[D.lat, D.lng, '양방향휴게소', '', '테스트선'], [B.lat, B.lng, '왼쪽휴게소', '서울', '테스트선'],
        [A.lat, A.lng, '오른쪽휴게소', '부산', '테스트선'], [A2.lat, A2.lng, '오른쪽복합휴게소', '', '테스트선'], [E.lat, E.lng, '먼휴게소', '부산', '테스트선']] };
    };
    try {
      const R = buildNavRoute();
      R.route.sections = [{ i: 0, n: 9, name: '테스트고속도로', speed: 90, cong: 1 }];
      t.setRestData(mkRest(R));
      await planAndStart(R);
      let a = pointAt(R, 50); feed(a.p, 25, a.h); t.renderNav();
      r.found = (t.ensureRouteRest() || []).map((x) => x.name).join(',');
      r.card1 = visible('#restCard') ? text('#restName') + ' ' + text('#restDist') + ' / ' + text('#restNext') : 'hidden';
      r.markers = (t.getMap().restMk || []).length;
      // v132: 안내 카드 안, 터널 줄 밑 '안내 종료' 줄 바로 위 파란 줄. 그다음 휴게소 이름이 길어도 거리는 카드 안에 보인다
      { const el = document.getElementById('restCard'), nx = document.getElementById('restNext');
        // v158: 카드 안 줄은 차에서부터 가까운 순서 — 휴게소(50m)가 그다음 칸(우회전, 차에서 550m)보다 위, 맨 밑은 '안내 종료' 줄
        r.order = [...document.getElementById('navPanel').children].filter((e) => !e.hidden && getComputedStyle(e).display !== 'none')
          .map((e) => e.id || e.className.split(' ')[0]).join('>');
        r.place = el.parentElement.id === 'navPanel' && r.order === 'navdest>turn>restCard>nextTurn';   // v263: 남은 거리 줄(navmeta)은 아래 가운데 띠로
        r.blue = getComputedStyle(el).backgroundColor === 'rgb(29, 79, 184)';
        const sp = nx.querySelector('span'); const keep = sp.textContent; sp.textContent = '다음 서울하이패스센터쉼터아주아주긴이름';
        const pr = document.getElementById('navPanel').getBoundingClientRect(), db = nx.querySelector('b').getBoundingClientRect(), nb = document.getElementById('restDist').getBoundingClientRect();
        r.fits = db.width > 0 && db.right <= pr.right - 4 && nb.right <= pr.right - 4; sp.textContent = keep; }
      a = pointAt(R, 330); feed(a.p, 25, a.h); t.renderNav();
      r.card2 = visible('#restCard') ? text('#restName') + ' ' + text('#restDist') : 'hidden';
      t.endNav(); softReset();
      r.endHidden = !visible('#restCard') && !(t.getMap().restMk || []).length;
      // 같은 경로가 일반도로면 휴게소 없음
      const R2 = buildNavRoute();
      t.setRestData(mkRest(R2));
      await planAndStart(R2);
      a = pointAt(R2, 50); feed(a.p, 15, a.h); t.renderNav();
      r.localNone = !visible('#restCard') && !(t.ensureRouteRest() || []).length;
    } finally {
      t.endNav(); softReset();
      try { const j = await (await realFetch(new URL('../data/rest.json', location.href).href, { cache: 'no-store' })).json(); t.setRestData(j); } catch (e) { /* 다음 실행 때 */ }
    }
    const ok = r.found === '양방향휴게소,오른쪽휴게소' && /^양방향휴게소 50m \/ 다음 오른쪽 7\d0m$/.test(r.card1) && r.markers === 2 && r.place && r.blue && r.fits &&
      /^오른쪽휴게소 4\d0m$/.test(r.card2) && r.endHidden && r.localNone;
    return { pass: !!ok, detail: Object.keys(r).map((k) => k + '=' + r[k]).join(', ') };
  }

  // S62: 네이버 '분기점 안내 코드' 표 전체로 맞춘 아이콘 (2026-11-14). 고가·지하차도 진입/옆길이 좌·우회전 화살표로 나오던 것,
  //      회전교차로가 나가는 방향과 상관없이 한 그림이던 것, 하이패스 전용·원톨링 톨게이트가 직진으로 나오던 것을 바로잡았다
  async function s62() {
    const t = T(), k = (tt, s) => t.turnKind({ t: tt, s: s || '' });
    const want = {
      23: 'rb_l', 27: 'rb_l', 21: 'rb_s', 28: 'rb_s', 29: 'rb_r', 33: 'rb_r', 22: 'rb_u', 34: 'rb_u',
      93: 'rb_l', 98: 'rb_s', 101: 'rb_r', 104: 'rb_u', 121: 'toll', 122: 'toll', 123: 'toll',
      62: 'over_l', 71: 'over_r', 55: 'over_s', 64: 'under_l', 73: 'under_r', 56: 'under_s', 63: 'oside_l', 72: 'oside_r', 65: 'side_l', 74: 'side_r',
      47: 'rest', 48: 'ferry', 50: 'ins', 52: 'ins', 75: 'ins', 51: 'outs', 78: 'outs', 11: 'sharp_l', 16: 'sharp_r',
      13: 'sl', 14: 'sr', 12: 'l', 15: 'r', 8: 'l', 1: 's', 2: 'l', 3: 'r', 6: 'u', 87: 'via', 88: 'goal',
      41: 'kl', 42: 'kr', 81: 'kl', 82: 'kr', 57: 'inl', 66: 'inr', 58: 'outl', 67: 'outr',
      54: 'jc',   // v137: 방향 없는 전방 분기 = 분기 후 합류(JC) 그림
    };
    const bad = Object.keys(want).filter((c) => k(+c, '') !== want[c]).map((c) => c + '→' + k(+c, '') + '≠' + want[c]);
    // 코드가 없을 때 글자로: 회전교차로 3시 → 오른쪽 출구, 로터리 9시 → 왼쪽, 고가차도 글자는 꺾는 화살표가 아님
    const txt = { r3: k(0, '회전교차로에서 3시 방향') === 'rb_r', l9: k(0, '로터리에서 9시 방향') === 'rb_l', u6: k(0, '회전교차로에서 6시 방향') === 'rb_u' };
    // 모든 종류에 그림이 있다 (없으면 가까운 그림으로)
    const kinds = [...new Set(Object.values(want))];
    // v105: 고른 AI 그림(img/ai/<칸>__*.webp)도 그림. 회전교차로는 AI 그림이 없을 때의 앱 그림(icoBase)도 방향별로 있어야 한다
    const noIcon = kinds.filter((x) => !(/<svg/.test(t.ico(x) || '') || /<img[^>]+img\/ai\//.test(t.ico(x) || '')));   // v110: 기본 화살표 칸의 AI 그림(kl/kr)도
    const rbIcons = ['rb_l', 'rb_s', 'rb_r', 'rb_u'].every((x) => new RegExp('ti-' + x + '\\b').test(t.icoBase(x)));
    const ok = !bad.length && txt.r3 && txt.l9 && txt.u6 && !noIcon.length && rbIcons;
    return { pass: ok, detail: (bad.length ? 'wrong: ' + bad.join(', ') : Object.keys(want).length + ' codes ✓') +
      ' | text ' + JSON.stringify(txt) + ' | icons ' + (noIcon.length ? 'missing ' + noIcon.join(',') : 'all ✓') + ' | roundabout icons ' + (rbIcons ? '✓' : '✗') };
  }

  // S63: 내 차 아이콘 고르기 (2026-11-14 요청: 네이버 지도처럼, 우리 차 모양으로)
  async function s63() {
    const t = T(), r = {}, prev = localStorage.getItem('tnc.car');
    const arrow = () => document.querySelector('.me .me-arrow');
    try {
      feed(dest(TRIP_ORIGIN, 90, 30), 10, 90);
      // 예전 값 'my'(SVG 모델 Y, 2026-11-14 정리됨)는 같은 색 실사로
      t.setCarIcon('my');
      r.swapped = /car-tesla_grey/.test(arrow().getAttribute('class'));
      r.saved = localStorage.getItem('tnc.car') === 'tesla_grey';
      feed(dest(TRIP_ORIGIN, 90, 45), 10, 90);
      r.rotated = /rotate\(/.test(arrow().style.transform);
      r.options = t.carIcons.map((c) => c.id).join(',');
      // AI 실사 차(PNG): 그림이 실제로 불러와지고, 바꿔도 방향은 그대로
      t.setCarIcon('tesla_grey');
      const im = arrow();
      r.aiImg = im.tagName === 'IMG' && /car-tesla_grey/.test(im.getAttribute('class')) && /rotate\(/.test(im.style.transform);
      await waitFor(() => im.complete, 3000);
      r.aiLoaded = im.complete && im.naturalWidth === 200 && im.naturalHeight === 280;
      t.setCarIcon('cute');
      r.back = /car-cute/.test(arrow().getAttribute('class')) && localStorage.getItem('tnc.car') === null;
    } finally {
      if (prev) t.setCarIcon(prev); else t.setCarIcon('cute');
    }
    const ok = r.swapped && r.saved && r.rotated && r.back && r.options === 'cute,tesla_grey,tesla_red,tesla_white,arrow,arrow3d' &&
      r.aiImg && r.aiLoaded;
    return { pass: !!ok, detail: Object.keys(r).map((k) => k + '=' + r[k]).join(', ') };
  }

  async function s55() {
    const t = T(), R = buildNavRoute();
    const north = (m) => dest(NAV_ORIGIN, 0, m);
    const turn = R.P[5];
    const pts = [
      ['slip', dest(north(450), 90, 6)],
      ['up', dest(north(250), 270, 9)],
      ['down', dest(north(350), 270, 3)],     // 왼쪽 3m 내리막: 오르막·내리막은 오른쪽만 → 안 잡음
      ['narrow', dest(dest(turn, 90, 450), 0, 3)],   // 동쪽 길 왼쪽(북쪽) 3m 도로 폭 좁아짐: 방향 없는 표지는 5m 까지 → 잡음
      ['animal', dest(north(150), 90, 6)],           // 오른쪽 6m 지만 도로 이름이 '옆골목길' → 옆 골목 표지라 안 잡음
      ['danger', dest(north(300), 90, 300)],
      ['rock', dest(dest(turn, 90, 300), 180, 7)],
    ];
    const types = pts.map((x) => x[0]);
    const d = [];
    let pa = 0, pb = 0;
    pts.forEach((x, i) => {
      const a = Math.round(x[1].lat * 1e5), b = Math.round(x[1].lng * 1e5);
      d.push(a - pa, b - pb, i); pa = a; pb = b;
    });
    const card = () => ({ shown: visible('#signCard'), label: text('#signLabel'), dist: text('#signDist'),
      icon: !!document.querySelector('#signIcon svg, #signIcon img.aiimg'), type: document.getElementById('signCard').dataset.type || '' });
    const go = (m, v) => { const a = pointAt(R, m); feed(a.p, v == null ? 15 : v, a.h); };
    const prevPref = t.prefs.signs;
    const r = {};
    try {
      // 표지 도로 이름(v2): 미끄러운 도로·낙석은 경로 구간 이름과 같고, '옆골목길' 동물 표지는 경로 오른쪽 6m 지만 다른 길이라 빠진다
      const roadOf = { slip: 1, rock: 2, animal: 3 };
      const d2 = [];
      for (let k = 0; k < pts.length; k++) d2.push(d[3 * k], d[3 * k + 1], d[3 * k + 2], roadOf[types[k]] || 0);
      stub.canned['/reverse'] = { road: '', area: '' }; t.road.name = '';
      t.setSignData({ v: 2, scale: 1e5, date: '2026-11-14', count: pts.length, types, names: ['', '테스트로', '율곡로', '옆골목길'], d: d2 });
      softReset();
      await planAndStart(R);
      go(15); go(100);
      r.at100 = card();                                   // 왼쪽 오르막(반대 방향)·멀리 있는 표지는 안 알림
      for (let m = 120; m <= 200; m += 20) go(m);
      r.at200 = card();                                   // 미끄러운 도로 250m
      r.found = (t.nav.routeSigns || []).map((x) => t.SIGN_TYPES[t.signs.type[x.k]].id + '@' + Math.round(x.at));
      for (let m = 220; m <= 500; m += 20) go(m);
      r.at500 = card();                                   // 지나친 뒤 '주의'
      for (let m = 520; m <= 610; m += 15) go(m);
      r.at610 = card();                                   // 낙석 주의 (동쪽 길 오른쪽)
      t.prefs.signs = false; go(625);
      r.off = card();
      t.prefs.signs = true;
      t.endNav();
      softReset();
      feed(R.P[0], 0, null);
      for (let m = 0; m <= 150; m += 15) go(m);
      r.free150 = card();                                 // 길안내 없이: 앞 100m 왼쪽 오르막은 반대 방향 → 안 알림
      for (let m = 165; m <= 300; m += 15) go(m);
      r.free300 = card();                                 // 앞 150m 오른쪽 미끄러운 도로
    } finally {
      t.prefs.signs = prevPref;
      stub.canned['/reverse'] = { road: '하네스로', area: '테스트시 테스트구 테스트동' };
      t.setSignData(null);
      await t.loadSigns();
      softReset();
    }
    r.real = { loaded: t.signs.loaded, n: t.signs.n, date: t.signs.date };
    const ok = !r.at100.shown &&
      r.at200.shown && r.at200.label === '미끄러운 도로' && r.at200.dist === '250m' && r.at200.icon && r.at200.type === 'slip' &&
      r.found.join(',') === 'slip@450,rock@900,narrow@1050' &&
      r.at500.shown && r.at500.label === '미끄러운 도로' && r.at500.dist === '주의' &&
      r.at610.shown && r.at610.label === '낙석 주의' && /^\d+m$/.test(r.at610.dist) && r.at610.type === 'rock' &&
      !r.off.shown && !r.free150.shown && r.free300.shown && r.free300.type === 'slip' &&
      r.real.loaded && r.real.n > 100;
    return { pass: ok, detail: JSON.stringify(r) + (ok ? ' ✓' : ' ✗') };
  }

  // S76: 회전 차로 안내 (시험판, 정밀도로지도 → data/lanes.json · tools/build_lanes.py, 2026-11-15 요청 '좌회전·우회전 몇 번 차로').
  //      시험 경로(북쪽 600m → 우회전 → 동쪽)에 진입부를 직접 넣어
  //      (a) 회전 500m 밖에서는 안 보임  (b) 500m 안: 회전 지점 40m 앞 북쪽 방향 진입부 'LU|L|S|SR' → 4칸, 4차로만 파랑,
  //          길안내 패널 바로 밑 단속 서랍 맨 위 (2026-11-16 사용자: 서랍처럼 내려오게, 네모 칸)
  //          (12m 앞 'S|S' 진입부는 회전 차로가 없어 건너뜀 — 따로 갈라지는 회전 전용 차로 같은 곳; 남쪽 방향 진입부는 방향이 달라 무시)
  //      (c) 설정을 끄면 숨김  (d) 회전을 지나면(다음 안내 = 목적지) 숨김  (e) 같은 곳이 좌회전 안내면 1·2차로
  //      (f) 진입부가 없는 회전(자료 밖)은 아무것도 안 보임  (g) 실제 data/lanes.json 이 읽힌다
  async function s76() {
    const t = T(), R = buildNavRoute();
    // 240m 의 '직진' 안내를 빼서 출발부터 다음 안내가 우회전(600m)이게
    R.route = JSON.parse(JSON.stringify(R.route));
    R.route.guide = R.route.guide.filter((g) => g.t !== 1);
    const turn = R.P[5];
    const aps = [
      [dest(turn, 180, 40), 0, 'LU|L|S|SR'],
      [dest(turn, 180, 12), 0, 'S|S'],
      [dest(dest(turn, 0, 25), 90, 8), 180, 'R|S|L'],
    ];
    const pats = [], d = [];
    let pa = 0, pb = 0;
    aps.forEach(([p, h, pat]) => {
      if (pats.indexOf(pat) < 0) pats.push(pat);
      const a = Math.round(p.lat * 1e5), b = Math.round(p.lng * 1e5);
      d.push(a - pa, b - pb, h, pats.indexOf(pat)); pa = a; pb = b;
    });
    const row = () => ({ shown: visible('#laneRow'), n: document.querySelectorAll('#laneRow .lg').length,
      go: (document.getElementById('laneRow').dataset.go || ''), lanes: document.getElementById('laneRow').dataset.lanes || '',
      blue: document.querySelectorAll('#laneRow .lg.go').length, arrows: document.querySelectorAll('#laneRow .lg svg').length,
      // 갈 차로 안에서 파란 조각(줄기·이번 방향 가지)과 회색으로 남는 다른 가지 수
      onParts: document.querySelectorAll('#laneRow .lg.go .pt.on').length, offInGo: document.querySelectorAll('#laneRow .lg.go .pt:not(.on)').length,
      onOutside: document.querySelectorAll('#laneRow .lg:not(.go) .pt.on').length,
      // 서랍(맨 위 칸)이 패널 바로 밑에 열림 (서랍 안은 내려오는 움직임 중이라 서랍 자체 위치로 본다, S45 와 같게)
      underPanel: (() => { const dr = document.getElementById('camDrawer'), a = dr.getBoundingClientRect(), p = document.getElementById('navPanel').getBoundingClientRect();
        return visible('#laneRow') ? !!document.getElementById('laneRow').closest('#camDrawer.open') && Math.abs(a.top - p.bottom) <= 2 &&
          !document.getElementById('laneRow').previousElementSibling : null; })(),
      blueColor: (() => { const g = document.querySelector('#laneRow .lg.go .pt.on'), o = document.querySelector('#laneRow .lg:not(.go) .pt');
        return g && o ? getComputedStyle(g).color !== getComputedStyle(o).color : null; })() });
    const go = (m, v) => { const a = pointAt(R, m); feed(a.p, v == null ? 15 : v, a.h); };
    const prevPref = t.prefs.lanes;
    const r = {};
    try {
      t.setLaneData({ v: 1, scale: 1e5, date: '2025-09', areas: ['시험'], count: aps.length, pats, d });
      softReset();
      await planAndStart(R);
      go(15); go(60);
      r.far = row();                                   // 회전까지 540m: 안 보임
      for (let m = 80; m <= 200; m += 20) go(m);
      r.near = row();                                  // 400m: 4칸, 4차로 파랑
      t.prefs.lanes = false; go(215);
      r.off = row();
      t.prefs.lanes = true; go(230);
      r.on = row();
      r.text = text('#turnText');
      for (let m = 250; m <= 700; m += 25) go(m);
      r.after = row();                                 // 우회전 뒤: 다음 안내는 목적지 → 안 보임
      t.endNav();
      // 같은 곳이 좌회전 안내라면 1·2차로
      const RL = buildNavRoute();
      RL.route = JSON.parse(JSON.stringify(R.route));
      RL.route.guide[0].t = 2; RL.route.guide[0].s = "'시험로' 방면으로 좌회전";
      softReset();
      await planAndStart(RL);
      for (let m = 15; m <= 300; m += 25) { const a = pointAt(RL, m); feed(a.p, 15, a.h); }
      r.left = row();
      t.endNav();
      // 같은 곳이 유턴 안내라면 좌+유턴 1차로, 그 칸의 유턴 가지만 파랑
      const RU = buildNavRoute();
      RU.route = JSON.parse(JSON.stringify(R.route));
      RU.route.guide[0].t = 6; RU.route.guide[0].s = '유턴';
      softReset();
      await planAndStart(RU);
      for (let m = 15; m <= 300; m += 25) { const a = pointAt(RU, m); feed(a.p, 15, a.h); }
      r.uturn = row();
      t.endNav();
      // 진입부가 없는 곳
      t.setLaneData({ v: 1, scale: 1e5, date: '2025-09', areas: ['시험'], count: 1, pats: ['L|S|R'], d: [Math.round(dest(turn, 0, 3000).lat * 1e5), Math.round(turn.lng * 1e5), 0, 0] });
      softReset();
      await planAndStart(R);
      for (let m = 15; m <= 300; m += 25) go(m);
      r.none = row();
      t.endNav();
    } finally {
      t.prefs.lanes = prevPref;
      t.setLaneData(null);
      await t.loadLanes();
      softReset();
    }
    r.real = { loaded: t.lanesData.loaded, n: t.lanesData.n, date: t.lanesData.date, areas: (t.lanesData.areas || []).join(',') };
    const ok = !r.far.shown &&
      r.near.shown && r.near.n === 4 && r.near.go === '4' && r.near.blue === 1 && r.near.lanes === 'LU|L|S|SR' && r.near.arrows === 4 &&
      r.near.underPanel === true && r.near.blueColor === true &&
      r.near.onParts === 2 && r.near.offInGo === 1 && r.near.onOutside === 0 &&     // 직우 칸: 줄기·우 가지만 파랑, 직진 가지는 회색
      !r.off.shown && r.on.shown && !r.after.shown &&
      r.left.shown && r.left.go === '1,2' && r.left.blue === 2 &&
      r.left.onParts === 4 && r.left.offInGo === 1 &&                                 // 좌+유턴 칸의 유턴 가지는 회색
      // 유턴이면 1차로 유턴 가지와 그 아래 줄기만 파랑, 좌회전 가지와 그쪽으로 이어진 줄기 윗부분은 회색 (2026-11-16 사용자 표시)
      r.uturn.shown && r.uturn.go === '1' && r.uturn.onParts === 2 && r.uturn.offInGo === 2 &&
      !r.none.shown &&
      r.real.loaded && r.real.n > 100;
    return { pass: ok, detail: JSON.stringify(r) + (ok ? ' ✓' : ' ✗') };
  }

  // S91: 고속도로 분기 앞 차로 (v153, 2026-11-16 사용자 '차선표기' — 경부 신갈분기점에서 네이버처럼 [버스][↑][↑][↑][↱][↱][↱]).
  //      시험 경로(북쪽 600m → 우회전) 북쪽 300m 에 단면 하나 'SB|S|S|S|R' (1차로 버스전용, 5차로는 출구). 갈래 끝점 둘:
  //      (a) 출구 끝점이 경로 위(우회전 뒤 400m), 본선 끝점은 경로 밖(직진 800m) → 5차로만 파랗게, 화살표는 R
  //      (b) 본선 끝점이 경로 위 → 2·3·4차로 파랗게 (버스 칸 1차로는 빼고), 화살표는 S
  //      (c) 두 끝점 다 경로 밖 → 칸 없음   (d) 실제 data/forks.json: 경부선 단면이 300개 넘고 버스 칸·출구가 있는 줄이 있다
  async function s91() {
    const t = T(), R = buildNavRoute();
    R.route = JSON.parse(JSON.stringify(R.route));
    R.route.guide = R.route.guide.filter((g) => g.t !== 1);
    const turn = R.P[5], sec = dest(NAV_ORIGIN, 0, 300);
    const onRoute = dest(turn, 90, 400), offRoute = dest(turn, 0, 800), side = dest(turn, 270, 500);
    const fork = (mainEnd, exitEnd) => t.setForkData({ v: 1, rows: [[sec.lat, sec.lng, 0, 'SB|S|S|S|R', [[0], [0], [0], [0], [1]]]],
      ends: [[mainEnd.lat, mainEnd.lng], [exitEnd.lat, exitEnd.lng]] });
    const el = () => document.getElementById('laneRow');
    const row = () => ({ shown: visible('#laneRow'), fork: el().dataset.fork || '', lanes: el().dataset.lanes || '', go: el().dataset.go || '',
      bus: el().dataset.bus || '', move: el().dataset.move || '', head: (el().querySelector('.lh span') || {}).textContent || '',
      dist: (el().querySelector('.ld') || {}).textContent || '' });
    const go = (m) => { const a = pointAt(R, m); feed(a.p, 25, a.h); };
    const drive = async (mainEnd, exitEnd) => {
      fork(mainEnd, exitEnd);
      softReset();
      await planAndStart(R);
      for (let m = 15; m <= 150; m += 15) go(m);
      return row();
    };
    const r = {};
    try {
      t.setLaneData(null);
      r.exit = await drive(offRoute, onRoute);
      for (let m = 170; m <= 330; m += 20) go(m);
      r.exitPassed = row();                       // 단면을 지나면 (다음 단면 없음) 칸 없음
      t.endNav();
      r.main = await drive(onRoute, offRoute);
      t.endNav();
      r.none = await drive(offRoute, side);
      t.endNav();
    } finally {
      t.setForkData(null);
      await t.loadForks();
      await t.loadLanes();
      softReset();
    }
    const fd = t.forksData;
    r.real = { loaded: fd.loaded, rows: fd.rows.length, bus: fd.rows.filter((x) => x.lanes.some((m) => m.indexOf('B') >= 0)).length,
      exit: fd.rows.filter((x) => x.lanes.some((m) => /R/.test(m))).length };
    const ok = r.exit.shown && r.exit.fork === '1' && r.exit.lanes === 'SB|S|S|S|R' && r.exit.go === '5' && r.exit.move === 'R' && r.exit.bus === '1' &&
      r.exit.head === '갈림길 차로' && /m$/.test(r.exit.dist) &&
      !r.exitPassed.shown &&
      r.main.shown && r.main.go === '2,3,4' && r.main.move === 'S' &&
      !r.none.shown &&
      r.real.loaded && r.real.rows > 300 && r.real.bus > 20 && r.real.exit > 100;
    return { pass: ok, detail: JSON.stringify(r) + (ok ? ' ✓' : ' ✗') };
  }

  // S100: 노면 색깔 유도선 (v162, 2026-11-19 운전자 '고속도로나 우회전 좌회전 빠질때 보통 녹색 분홍색 안내선 … API 있는지').
  //      data/colorlines.json = 한국도로공사 노면색깔유도선 현황·재도색 현황을 OSM 갈래 모양으로 확인한 것 (tools/build_colorlines.py).
  //      시험 경로(북쪽 600m → 우회전 480m) 북쪽 300m 에 유도선 자리 하나, 갈래 둘(분홍 끝점·녹색 끝점):
  //      (a) 분홍 끝점이 경로 위(우회전 뒤 200m), 녹색은 경로 밖(직진 800m) → '분홍색 유도선 따라가기' + 거리, 색 띠 분홍
  //      (b) 분홍 끝점을 지나면 줄 없음  (c) 녹색이 경로 위 → '녹색'  (d) 둘 다 경로 밖(본선 그대로) → 없음  (e) 둘 다 경로 위 → 모름, 없음
  //      (f) 실제 자료: 경부 북행 신갈분기점(녹색 = 왼쪽 인천, 분홍 = 오른쪽 원주)은 있고, 하행(자료는 좌 인천·우 원주인데 실제 하행은 왼쪽이 원주)은 없다
  //      (g) 실제 경로 route-seoultg-n (서울TG → 판교분기점 '일산, 구리' → '구리, 성남' 직진): 판교나들목은 본선 그대로라 없고, 판교분기점 분홍(구리),
  //          1.3km 앞에서는 아직 없고 600m 앞에서 보인다 (위 안내 줄이 바로 그 분기점이라 거리 숫자는 안 씀)   (h) 실제 경로 route-paldang-hanamic-s (하남분기점 '수도권제1순환선, 판교, 서하남'): 분홍
  async function s100() {
    const t = T(), R = buildNavRoute();
    R.route = JSON.parse(JSON.stringify(R.route));
    R.route.guide = R.route.guide.filter((g) => g.t !== 1);
    const turn = R.P[5], spot = dest(NAV_ORIGIN, 0, 300);
    const onA = dest(turn, 90, 200), onB = dest(turn, 90, 400), off = dest(turn, 0, 800), side = dest(turn, 270, 500);
    const data = (pEnd, gEnd) => t.setColorLines({ v: 1, rows: [[spot.lat, spot.lng, 0, [['g', gEnd.lat, gEnd.lng], ['p', pEnd.lat, pEnd.lng]], '시험분기점']] });
    const el = () => document.getElementById('colorRow');
    // v245 고정 규칙: 유도선 갈림 그림(안내 카드 맨 위)은 그리지 않는다 — 줄은 늘 숨김, 어느 색 선을 따라가는지는 자료(colorLineAhead)로 본다
    const ahead = () => t.colorLineAhead() || {};
    const row = () => ({ shown: visible('#colorRow'), c: ahead().c || '', name: ahead().name || '', side: ahead().side || '',
      pic: !!document.querySelector('svg.sp-pic:not([hidden])') && visible('#colorRow'),
      scene: (() => { const p = document.querySelector('#juncCard:not([hidden]) svg.nv .nv-cl'); return p ? p.style.fill : ''; })() });
    const go = (RR, m) => { const a = pointAt(RR, m); feed(a.p, 25, a.h); t.renderNav(); };
    const drive = async (pEnd, gEnd, upto) => {
      data(pEnd, gEnd);
      softReset();
      await planAndStart(R);
      for (let m = 15; m <= upto; m += 15) go(R, m);
      return row();
    };
    const realRoute = async (file, name) => {
      const fx = await (await realFetch(harnessDir + 'fixtures/' + file, { cache: 'no-store' })).json();
      const P = fx.path.map((x) => ({ lat: x[1], lng: x[0] }));
      const cum = [0];
      for (let k = 1; k < P.length; k++) cum.push(cum[k - 1] + hav(P[k - 1], P[k]));
      return { route: fx, P, cum, total: cum[cum.length - 1], dest: { name, addr: '', lat: P[P.length - 1].lat, lng: P[P.length - 1].lng } };
    };
    const r = {};
    try {
      r.pink = await drive(onA, off, 150);
      for (let m = 165; m <= 840; m += 15) go(R, m);
      r.passed = row();
      t.endNav();
      r.green = await drive(off, onA, 150);
      t.endNav();
      r.mainline = await drive(off, side, 150);
      t.endNav();
      r.both = await drive(onA, onB, 150);
      t.endNav();
      // 실제 자료
      t.setColorLines(null);
      await t.loadColorLines();
      const cd = t.clData;
      const near = (row, lat, lng, m) => hav(row, { lat, lng }) <= m;
      const sgN = cd.rows.find((x) => x.name === '신갈분기점' && near(x, 37.28315, 127.10385, 300) && Math.abs(((x.h - 0) + 540) % 360 - 180) <= 20);
      r.real = { loaded: cd.loaded, rows: cd.rows.length,
        singalN: sgN ? sgN.br.map((b) => b.c).join('') + (sgN.br.length === 2 && sgN.br.find((b) => b.c === 'g').lng < sgN.br.find((b) => b.c === 'p').lng ? ':g-west' : ':?') : '',
        // v253: 공사 자료의 하행 줄(글자 좌우가 갈래와 반대)은 여전히 빼고, 네이버 비교로 더한 하행 출구 녹색 줄(원주·인천 둘 다 녹색, 좌우 없음) 하나만
        singalS: cd.rows.filter((x) => x.name === '신갈분기점' && near(x, 37.2954, 127.1036, 1500) && Math.abs(((x.h - 180) + 540) % 360 - 180) <= 30)
          .map((x) => x.br.map((b) => b.c).join('')).join(',') };
      // 실제 경로 (g) 서울TG → 판교분기점
      softReset();
      const SR = await realRoute('route-seoultg-n.json', '판교분기점');
      await planAndStart(SR);
      const list = t.ensureRouteColorLines().map((x) => x.name + ':' + x.c);
      const pg = t.ensureRouteColorLines().find((x) => x.name === '판교분기점');
      r.seoulTg = { list: list.join(',') };
      if (pg) {
        for (let m = 50; m <= pg.at - 1300; m += 50) go(SR, m);
        r.seoulTg.far = row();
        for (let m = pg.at - 1250; m <= pg.at - 600; m += 25) go(SR, m);
        r.seoulTg.near = row();
      }
      t.endNav();
      // (h) 팔당 → 하남IC → 하남분기점
      softReset();
      const HR = await realRoute('route-paldang-hanamic-s.json', '성남시청');
      await planAndStart(HR);
      r.hanam = t.ensureRouteColorLines().map((x) => x.name + ':' + x.c).join(',');
      t.endNav();
    } finally {
      t.setColorLines(null);
      await t.loadColorLines();
      softReset();
    }
    // v245: 줄·그림은 어디에도 없다(shown·pic·scene 모두 거짓) — 고르는 규칙(자료)은 그대로
    const none = (x) => x && !x.shown && !x.pic && !x.scene;
    const ok = none(r.pink) && r.pink.c === 'p' && r.pink.side === 'r' && r.pink.name === '시험분기점' &&
      none(r.passed) && r.passed.c === '' &&
      none(r.green) && r.green.c === 'g' &&
      none(r.mainline) && r.mainline.c === '' && none(r.both) && r.both.c === '' &&
      r.real.loaded && r.real.rows > 150 && r.real.singalN === 'gp:g-west' && r.real.singalS === 'gg' &&
      r.seoulTg.list.indexOf('판교분기점:p') >= 0 && r.seoulTg.list.indexOf('판교나들목') < 0 &&
      none(r.seoulTg.far) && r.seoulTg.far.c === '' && none(r.seoulTg.near) && r.seoulTg.near.c === 'p' && r.seoulTg.near.name === '판교분기점' &&
      /^하남:p/.test(r.hanam);
    return { pass: ok, detail: JSON.stringify(r) + (ok ? ' ✓' : ' ✗') };
  }

  // S92: 분기 후 합류 (v156, 2026-11-17 주행 중 수도권1순환 북행 — 서하남IC 출구 2.4km 앞 '분기도로 진입'(54, 방향 없음):
  //      네이버 '6.2km 분기 후 합류…' + 섬 양옆으로 갈라졌다 합쳐지는 그림, 우리는 '6.0km 직진'). 북쪽으로 곧은 4km 고속도로,
  //      2km 지점 54 (고속도로 구간이 앞뒤로 이어져 본선 그대로) → 글은 '분기 후 합류', 그림은 jc(두 갈래 화살표가 좌우 대칭), 분기점 그림 없음.
  //      같은 곳의 '왼쪽 도로 주행'(41)은 S78 처럼 그대로 직진
  async function s92() {
    const t = T(), r = {};
    const raw = [];
    for (let k = 0; k <= 40; k++) raw.push(dest(NAV_ORIGIN, 0, 100 * k));
    const path = raw.map((p) => [round6(p.lng), round6(p.lat)]);
    const P = path.map((x) => ({ lat: x[1], lng: x[0] }));
    const cum = [0];
    for (let i = 1; i < P.length; i++) cum.push(cum[i - 1] + hav(P[i - 1], P[i]));
    const total = cum[cum.length - 1];
    const mk = (g20) => ({
      route: { distance: r0(total), duration: r0(total / 25 * 1000), tollFare: 0, fuelPrice: 300, path,
        guide: [{ i: 3, t: 66, s: "송파IC에서 '구리' 방면으로 오른쪽 고속도로 진입", d: r0(cum[3]), ms: 10000 },
                Object.assign({ i: 20, d: r0(cum[20] - cum[3]), ms: 60000 }, g20),
                { i: 30, t: 67, s: "서하남IC에서 '강동, 서하남' 방면으로 오른쪽 고속도로 출구", d: r0(cum[30] - cum[20]), ms: 60000 },
                { i: 40, t: 88, s: '목적지', d: r0(total - cum[30]), ms: 30000 }],
        sections: [{ i: 3, n: 30, name: '수도권제1순환고속도로', speed: 80, cong: 1 }] },
      P, cum, total, dest: { name: '분기 후 합류 테스트', addr: '', lat: P[40].lat, lng: P[40].lng },
    });
    const icon = (sel) => { const ti = document.querySelector(sel + ' svg, ' + sel + ' img'); if (!ti) return '';
      return ti.tagName === 'IMG' ? 'img:' + ti.getAttribute('src').replace(/^.*\/img\/ai\//, '').split('__')[0] : (ti.getAttribute('class') || '').replace(/\s+/g, ' ').trim(); };
    const run = async (R) => {
      softReset();
      await planAndStart(R);
      for (let s = 20; s <= 1400; s += 20) { const a = pointAt(R, s); feed(a.p, 25, a.h); t.renderNav(); }
      return { text: text('#turnText'), kind: t.turnKind(t.nav.next), ik: t.iconKind(t.nav.next), icon: icon('#turnIcon'),
        junc: visible('#juncCard'), next: icon('#nextIcon'), nextDist: text('#nextDist') };
    };
    try {
      r.jc = await run(mk({ t: 54, s: '분기도로 진입' }));
      t.endNav();
      r.keep = await run(mk({ t: 41, s: "'구리' 방면으로 왼쪽 도로 주행" }));
    } finally {
      t.endNav(); softReset();
    }
    // 그림: 흰 화살표가 섬 양옆으로 (흰 부분의 왼쪽 끝과 오른쪽 끝이 가운데 24 를 두고 대칭), 화살촉 두 개
    const box = document.createElement('div');
    box.style.cssText = 'position:absolute;left:0;top:0;width:96px;height:96px;opacity:0;pointer-events:none';
    box.innerHTML = t.icoBase('jc');
    document.body.appendChild(box);
    let lo = 99, hi = -99, heads = 0;
    try {
      box.querySelectorAll('path').forEach((el) => {
        if (el.getAttribute('stroke') !== '#fff' && el.getAttribute('fill') !== '#fff') return;
        const b = el.getBBox(); lo = Math.min(lo, b.x); hi = Math.max(hi, b.x + b.width);
        if (el.getAttribute('fill') === '#fff') heads += (el.getAttribute('d').match(/z/gi) || []).length;
      });
    } finally { box.remove(); }
    r.svg = { lo: +lo.toFixed(1), hi: +hi.toFixed(1), heads };
    const a = r.jc, b = r.keep;
    const ok = a.text === '분기 후 합류' && a.kind === 'jc' && a.ik === 'jc' && (a.icon === 'img:jc' || /\bjc\b/.test(a.icon)) && !a.junc &&
      /\bramp\b.*\bout\b|img:outr/.test(a.next) && a.nextDist === '1.0km' &&
      /직진/.test(b.text) && b.kind === 's' &&
      heads === 2 && lo < 14 && hi > 34 && Math.abs((lo + hi) / 2 - 24) < 0.6;
    return { pass: !!ok, detail: JSON.stringify(r) };
  }

  // S93: (v157, 2026-11-17 14:01 송파IC 진출램프 끝 유턴 → 위례중앙로 '위례' 방면) 운전자 '여기는 유턴 구간 이기 때문에 30으로 봐야 해'.
  //      실제 네이버 경로(수도권1순환 → 송파IC 출구 → 램프 끝 유턴): 구간 이름이 유턴 지점까지 '수도권제1순환고속도로'라 램프의 신호·과속 30
  //      ('송파IC 진출램프', 원본 도로명 '서울외곽순환고속도로')이 고속도로 규칙으로 빠지고 유턴 뒤 위례중앙로 50 만 떴다.
  //      이제: 출구 안내를 지났으니 램프 30 은 경로 위 카메라, 유턴 80m 앞 카드는 30, 위례중앙로 50(꺾어 들어간 길의 카메라)은 안 뜬다.
  //      대조: 램프 카메라를 50 으로 바꿔도(제한속도가 같아도) 위례중앙로 50 은 뺀다 — v237 (운전자 '그런 건 전국에 다 해당되는 건 알지?'):
  //      유턴 지점에서 나가는 방향으로 5.7m 인 꺾어 들어간 길의 정지선 신호 카메라는 제한속도와 상관없이 그 접근로를 곧장 온 차를 찍는다 (예전 v157 은 남겼다)
  async function s93() {
    const t = T(), RAMP30 = { lat: 37.47585, lng: 127.12836 }, ROAD50 = { lat: 37.47555, lng: 127.12838 };
    const rows = t.cams.rows, ramp = rows.find((c) => sameCam(c, RAMP30)), road = rows.find((c) => sameCam(c, ROAD50));
    if (!ramp || !road) return { pass: false, detail: 'cameras not in data/cameras.json' };
    const fx = await (await realFetch(harnessDir + 'fixtures/route-songpaic-uturn.json', { cache: 'no-store' })).json();
    const P = fx.path.map((x) => ({ lat: x[1], lng: x[0] }));
    const cum = [0];
    for (let i = 1; i < P.length; i++) cum.push(cum[i - 1] + hav(P[i - 1], P[i]));
    const R = { route: fx, P, cum, total: cum[cum.length - 1], dest: { name: '위례', addr: '', lat: P[P.length - 1].lat, lng: P[P.length - 1].lng } };
    const U = cum[fx.guide.find((g) => g.t === 6).i];
    const run = async () => {
      await resetApp();
      softReset();
      await planAndStart(R);
      const o = { ramp: null, road: false, at80: null, drops: 0 };
      try {
        t.ensureRouteCams();
        o.onRoute = { ramp: t.nav.routeCams.has(ramp), road: t.nav.routeCams.has(road) };
        o.drops = t.nav.turnCamDrops || 0;
        for (let s = 0; s <= R.total - 30; s += 10) {
          const a = pointAt(R, s);
          feed(a.p, 40 / 3.6, a.h, { dt: 900 });
          const tg = t.camState.target;
          if (tg && sameCam(tg.c, RAMP30) && !o.ramp) o.ramp = { s, d: r0(U - s), limit: text('#camLimit') };
          if (tg && sameCam(tg.c, ROAD50)) o.road = true;
          if (o.at80 === null && s >= U - 80) o.at80 = tg ? text('#camLimit') : '';
        }
      } finally { t.endNav(); }
      return o;
    };
    const r = {};
    try {
      r.real = await run();
      const keep = ramp[2];
      ramp[2] = 50;
      try { r.same = await run(); } finally { ramp[2] = keep; }
    } finally { await resetApp(); softReset(); }
    const a = r.real, b = r.same;
    const ok = a.ramp && a.ramp.limit === '30' && a.at80 === '30' && !a.road && a.onRoute.ramp && !a.onRoute.road && a.drops >= 1 &&
      b.onRoute.ramp && !b.onRoute.road && b.drops >= 1;
    return { pass: !!ok, detail: 'U-turn at ' + r0(U) + ' m ' + JSON.stringify(r) };
  }

  // v161 공통: 길안내 없이 카메라 차로 위 점을 지나는 곧은 길을 달린다 (from m 앞 → to m 뒤, step m, kmh). 매 걸음 onStep(s, f)
  async function driveThrough(pt, h, from, to, kmh, step, onStep) {
    const t = T();
    await resetApp(); softReset();
    t.alertLog.length = 0;
    const v = kmh / 3.6, dt = step / v * 1000;
    for (let s = -from; s <= to; s += step) {
      const p = dest(pt, s < 0 ? (h + 180) % 360 : h, Math.abs(s));
      const f = feed(p, v, h, { dt, acc: 3 });
      if (onStep) onStep(s, f);
    }
  }
  const lanePt = (c) => ({ lat: c.sl != null ? c.sl : c[0], lng: c.sg != null ? c.sg : c[1] });
  const camAt = (lat, lng) => T().cams.rows.find((x) => sameCam(x, { lat, lng }));

  // S97: 단속 카메라 고르기·지남 (v161, 2026-11-20 점검의 실제 행들)
  //  (a) 대한로 80(#6064)과 어린이 30(#6063)이 같은 자리: 30 을 보여 주고, 지나면 둘 다 지남
  //  (b) 북한강로 50(#25702) 뒤 5m 에 어린이 30(#25701): 30 을 보여 주고(예전엔 50 을 지나며 30 까지 지남으로 쳐 경고 없음), 지나면 둘 다 지남
  //  (c) 어린이 30(#17164) 옆 60(#17162): 30 을 지날 때까지 30 (예전엔 11m 뒤 60 으로 바뀌며 30 이 사라짐)
  //  (d) 중앙로 60(#16985) 뒤 62m 에 50(#16982): 50 이 300m 넘게 앞에서부터 (예전엔 29m 앞에서야)
  //  (e) passCam: 30 을 지날 때 진행 방향으로 20m 앞에 둔 가짜 60 은 지남이 아니다 — 30 을 다 지나면 60 이 뜬다
  async function s97() {
    const t = T(), r = {};
    const run = async (k, a, b, h, kmh) => {
      const A = camAt(a[0], a[1]), B = b ? camAt(b[0], b[1]) : null;
      if (!A || (b && !B)) { r[k] = 'not in data'; return; }
      const o = { shown: [], firstB: null, lastBefore: null };
      await driveThrough(lanePt(A), h, 700, 80, kmh, 5, (s) => {
        const tg = t.camState.target;
        const lab = tg ? text('#camLimit') : '';
        if (o.shown[o.shown.length - 1] !== lab) o.shown.push(lab);
        if (B && tg && tg.c === B && o.firstB === null) o.firstB = Math.round(-s);
        if (s < 0 && tg) o.lastBefore = lab;
      });
      o.passedA = t.camState.passed.has(t.cams.rows.indexOf(A));
      if (B) o.passedB = t.camState.passed.has(t.cams.rows.indexOf(B));
      o.voice = t.alertLog.filter((x) => x.kind === 'voice').map((x) => x.text).slice(0, 3);
      r[k] = o;
    };
    await run('a', [35.51725, 128.17371], [35.51725, 128.17371], 157, 60);
    await run('b', [37.5646, 127.319], [37.5646, 127.31894], 234, 50);
    await run('c', [37.04209, 127.02696], null, 49, 40);
    await run('d', [37.01297, 127.23748], [37.01272, 127.2381], 112, 50);
    // (e) 가짜 60 을 30 의 20m 앞에 하나 붙인다 (행·격자에 넣었다가 뺀다)
    {
      const A = camAt(37.04209, 127.02696);
      if (A) {
        const lp = lanePt(A), q = dest(lp, 49, 20);
        const fake = [round6(q.lat), round6(q.lng), 60, 1, 0, 0, 0, -1, 5, 1];
        fake.eb = 49; fake.e2 = 0; fake.lv = 0; fake.sl = fake[0]; fake.sg = fake[1];
        const rows = t.cams.rows, fi = rows.length; rows.push(fake);
        const key = Math.floor(fake[0] / 0.01) + ':' + Math.floor(fake[1] / 0.01);
        const cell = t.cams.grid.get(key) || []; cell.push(fi); t.cams.grid.set(key, cell);
        try {
          const o = { seenFake: null, passedFakeAtA: null };
          await driveThrough(lp, 49, 500, 60, 40, 3, (s) => {
            const tg = t.camState.target;
            if (o.passedFakeAtA === null && t.camState.passed.has(rows.indexOf(A))) o.passedFakeAtA = t.camState.passed.has(fi);
            if (tg && tg.c === fake && o.seenFake === null) o.seenFake = Math.round(s);
          });
          r.e = o;
        } finally { rows.pop(); cell.pop(); if (!cell.length) t.cams.grid.delete(key); t.camMiss.near.delete(fi); t.camState.passed.delete(fi); }
      }
    }
    await resetApp(); softReset();
    const ok = r.a.lastBefore === '30' && r.a.passedA && r.a.passedB &&
      r.b.lastBefore === '30' && r.b.passedA && r.b.passedB &&
      r.c.lastBefore === '30' &&
      r.d.firstB !== null && r.d.firstB >= 300 &&
      r.e && r.e.passedFakeAtA === false && r.e.seenFake !== null && r.e.seenFake > 0 && r.e.seenFake <= 20;
    return { pass: !!ok, detail: JSON.stringify(r) };
  }

  // S98: 구간단속 시작·끝 (v161, 2026-11-20 점검)
  //  (a) 중부내륙 110: 앞 구간 끝(#15907)과 다음 구간 시작(#15906)이 같은 자리 — 열린 구간을 닫고 바로 새 구간을 연다
  //  (b) 세종포천 시작(#26733) 56m 뒤에 구리포천 끝(#26744): 새 구간이 앞 구간의 끝에 닫히지 않는다
  //  (c) 끝을 놓쳐 옛 구간(제한 50)이 열린 채로 서해안 100 구간 시작(#714)을 지나면 새 구간(100)
  //  (d) 구간 길이: 1,000배 큰 값(#2626 15,834,000)은 15.8km, 0 은 모름
  async function s98() {
    const t = T(), r = {};
    const open = (lim) => { t.camState.section = { limit: lim, len: 20000, t0: clock, d0: t.state.odo - 9000 }; };
    const run = async (k, a, h, kmh, before) => {
      const A = camAt(a[0], a[1]);
      if (!A) { r[k] = 'not in data'; return; }
      const o = {};
      let opened = false;
      await driveThrough(lanePt(A), h, 900, 200, kmh, 10, (s) => {
        if (!opened && s >= -600) { opened = true; if (before) before(); }
      });
      const sec = t.camState.section;
      o.sec = sec ? { limit: sec.limit, done: Math.round(t.state.odo - sec.d0) } : null;
      o.voice = t.alertLog.filter((x) => /구간단속/.test(x.text)).map((x) => x.text);
      r[k] = o;
    };
    await run('a', [36.87084, 127.91236], 292, 100, () => open(110));
    await run('b', [37.62497, 127.1179], 50, 90, () => open(100));
    await run('c', [34.77867, 127.03662], 237, 120, () => open(50));
    r.d = { big: t.secLen([0, 0, 100, 9, 1, 15834000]), zero: t.secLen([0, 0, 100, 9, 1, 0]), ok: t.secLen([0, 0, 100, 9, 1, 11000]) };
    await resetApp(); softReset();
    const ok = r.a.sec && r.a.sec.limit === 110 && r.a.sec.done < 400 && r.a.voice.some((x) => /시작/.test(x)) &&
      r.b.sec && r.b.sec.limit === 100 && r.b.sec.done < 400 &&
      r.c.sec && r.c.sec.limit === 100 && r.c.voice.some((x) => /시작/.test(x)) &&
      r.d.big === 15834 && r.d.zero === 0 && r.d.ok === 11000;
    return { pass: !!ok, detail: JSON.stringify(r) };
  }

  // S99: '틀림' (v161, 2026-11-20 점검 + 운전자 '틀림이 속도가 틀린걸수도 있음'). 북한강로 어린이 30(#25701) 쪽으로 달리며
  //  (a) 카드가 막 바뀐 1초 안의 누름은 무시 (b) 한 번 누르면 숨기지 않고 흐리게·제한 '?'·소리 없음·놓침 버튼은 그대로 보임
  //  (c) 다른 날 또 누르면 숨김 — 다만 보호구역 카메라는 흐리게만 (d) 보호구역 아닌 카메라는 숨김
  //  (e) 14일 지난 한 번짜리는 풀림 (f) 설정 목록에 보이고 '되돌리기'로 풀림 (g) 예전 영원히 숨김(tnc.camNo)은 14일 의심으로 옮겨짐
  async function s99() {
    const t = T(), r = {};
    const keepMap = new Map(t.camNoMap), keepOld = t.store.get('camNo'), keepRaw = t.store.get('camNo2');
    const A = camAt(37.5646, 127.31894), B = camAt(37.5646, 127.319);   // A 어린이 30, B 50
    if (!A || !B) return { pass: false, detail: 'cameras not in data' };
    try {
      t.camNoMap.clear();
      const lp = lanePt(A);
      const toward = async (stopAt) => { await driveThrough(lp, 234, 380, -stopAt, 50, 5); };
      await toward(200);
      const tg = t.camState.target;
      r.target = tg ? text('#camLimit') : null;
      // (a) 카드가 방금 바뀐 것처럼
      const card = document.getElementById('camCard');
      card._camAt = Date.now();
      document.getElementById('camWrong').click();
      r.a = { ignored: !t.camFlag(A, 234) };
      card._camAt = Date.now() - 5000;
      // (b) 한 번 누름
      document.getElementById('camWrong').click();
      const tg2 = t.camState.target;
      r.b = { flag: t.camFlag(tg2 ? tg2.c : A, 234), still: !!tg2, limit: text('#camLimit'), dim: card.classList.contains('doubt'),
        miss: !document.getElementById('camMissBtn').hidden };
      t.alertLog.length = 0;
      for (let k = 0; k < 20; k++) { const p = dest(lp, 54, 190 - k * 5); feed(p, 50 / 3.6, 234, { dt: 360, acc: 3 }); }
      r.b.sounds = t.alertLog.filter((x) => /단속|경고음|알림음/.test(x.text)).length;
      // (c) 다른 날 또 → 보호구역이라 흐리게만
      const e = t.camNoMap.get(A[0] + ',' + A[1]);
      if (e && e[0]) e[0].days = ['2026-11-1', '2026-11-2'];
      r.c = t.camFlag(A, 234);
      // (d) 보호구역 아닌 50 은 다른 날 두 번이면 숨김
      t.camFlagAdd(B, 234, Date.now() - 3 * 86400e3);
      r.d = { one: t.camFlag(B, 234), two: t.camFlagAdd(B, 234), userNo: t.camUserNo(B, 234), otherWay: t.camFlag(B, 54) };
      // (e) 14일 지난 한 번짜리
      t.camNoMap.set('1,1', [{ h: 0, t0: 0, t1: Date.now() - 15 * 86400e3, days: ['x'], lim: 50, name: 'x' }]);
      r.e = t.camFlag([1, 1, 50, 1, 0, 0, 0, -1, 5, 1], 0);
      // (f) 설정 목록
      t.renderCamFlags();
      const items = [...document.querySelectorAll('#camFlagList li')];
      r.f = { box: !document.getElementById('camFlagBox').hidden, n: items.length, first: items[0] ? items[0].textContent : '' };
      const undo = items.find((li) => /50/.test(li.textContent) && /숨김/.test(li.textContent));
      if (undo) undo.querySelector('button').click();
      r.f.afterUndo = t.camFlag(B, 234);
      // (g) 예전 형식 옮기기: 앱을 다시 띄우지 않고 같은 규칙을 확인할 수 없으므로 저장 형식만 확인
      r.g = { v2: !!t.store.get('camNo2'), old: t.store.get('camNo') };
    } finally {
      t.camNoMap.clear(); keepMap.forEach((v, k) => t.camNoMap.set(k, v));
      t.store.set('camNo', keepOld); t.store.set('camNo2', keepRaw);   // 저장소에 쓴 표시도 되돌린다 (다음에 열 때 다시 읽힌다)
      await resetApp(); softReset();
    }
    const ok = r.target === '30' && r.a.ignored && r.b.flag === 'doubt' && r.b.still && r.b.limit === '?' && r.b.dim && r.b.miss && r.b.sounds === 0 &&
      r.c === 'doubt' && r.d.one === 'doubt' && r.d.two === 'hide' && r.d.userNo && r.d.otherWay === null && r.e === null &&
      r.f.box && r.f.n >= 2 && r.f.afterUndo === null && r.g.v2 && !r.g.old;
    return { pass: !!ok, detail: JSON.stringify(r) };
  }

  // S102: 신고 보낼 함·단속 자료 다시 받기 (v163, 2026-11-20 점검 9·10)
  //  (a) 서버가 못 받으면 '놓침'은 '저장함'이고 함에 남는다 (b) 연결되면 다시 보내 함이 빈다, 받았을 때만 '✓ 보냄'
  //  (c) 카메라 자료를 못 받으면 주행 중 '단속 카메라 자료 없음 · 다시 받는 중', 다시 받으면 사라지고 행 수가 돌아온다
  async function s102() {
    const t = T(), r = {}, ob = t.outbox, keepPost = ob.post, keepBox = t.store.get('outbox');
    const keepSpots = t.mySpots.slice(), keepSpotRaw = t.store.get('mySpots');   // v169: 놓침을 누르면 신고 지점이 저장된다
    const btn = document.getElementById('camMissBtn');
    let keep = null;
    const realF = window.fetch;
    try {
      ob.inTest = true; t.store.set('outbox', null);
      ob.post = async () => ({ ok: false });
      btn.click();
      await waitFor(() => !btn.classList.contains('sending'), 2000, 20);
      r.a = { label: btn.textContent, saved: btn.classList.contains('saved'), box: JSON.parse(t.store.get('outbox') || '[]').length };
      let posted = 0;
      ob.post = async () => { posted++; return { ok: true }; };
      r.b = { flush: await t.outboxFlush(), box: JSON.parse(t.store.get('outbox') || '[]').length, posted };
      await new Promise((res) => setTimeout(res, 2700));   // 앞 표시가 사라지길 기다림
      btn.click();
      await waitFor(() => !btn.classList.contains('sending'), 2000, 20);
      r.b.label = btn.textContent; r.b.saved = btn.classList.contains('saved');
      // (c) 자료 못 받음 → 표시 → 다시 받음 (놓침으로 저장된 신고 지점은 먼저 되돌려 행 수를 맞춘다)
      t.mySpots.length = 0; keepSpots.forEach((x) => t.mySpots.push(x)); t.applyUserSpots();
      keep = { loaded: t.cams.loaded, mobile: t.cams.mobile, n: t.cams.rows.length };
      window.fetch = (u, o) => (/data\/(cameras|mobile)\.json/.test(String(u)) ? Promise.resolve(new Response('no', { status: 503 })) : realF(u, o));
      t.cams.loaded = false; t.cams.mobile = 0;
      await t.loadCameras();
      t.state.speedKmh = 30; t.renderCamStatus();
      const pill = () => { const e = document.getElementById('camStatus'); return e && !e.hidden ? e.textContent : ''; };
      r.c = { failed: t.cams.failed, pill: pill(), timer: !!t.camLoad.timer };
      window.fetch = realF;
      await t.loadCameras();
      t.renderCamStatus();
      r.c.after = { failed: t.cams.failed, loaded: t.cams.loaded, pill: pill(), rows: t.cams.rows.length === keep.n, tries: t.camLoad.tries };
    } finally {
      window.fetch = realF;
      clearTimeout(t.camLoad.timer); t.camLoad.tries = 0;
      if (!t.cams.loaded) await t.loadCameras();
      ob.post = keepPost; ob.inTest = false; t.store.set('outbox', keepBox);
      t.mySpots.length = 0; keepSpots.forEach((x) => t.mySpots.push(x)); t.store.set('mySpots', keepSpotRaw); t.applyUserSpots();
      clearTimeout(btn._sentT); btn.classList.remove('sent', 'saved', 'sending'); btn.textContent = '잘못된 정보 신고';
      const te = document.getElementById('toast'); if (te) te.hidden = true;
      t.state.speedKmh = 0; t.renderCamStatus();
      await resetApp(); softReset();
    }
    const ok = r.a.label === '저장함' && r.a.saved && r.a.box === 1 && r.b.flush === true && r.b.box === 0 && r.b.posted === 1 &&
      r.b.label === '✓ 보냄' && !r.b.saved && r.c.failed && /자료 없음/.test(r.c.pill) && r.c.timer &&
      !r.c.after.failed && r.c.after.loaded && r.c.after.pill === '' && r.c.after.rows && r.c.after.tries === 0;
    return { pass: !!ok, detail: JSON.stringify(r) };
  }

  // S103: 터널 안 단속 카메라 (v163, 2026-11-20 점검 8: 터널 안 카메라 58대 중 12대가 경고 거리보다 깊고, 터널 안에서는 GPS 가 끊긴다).
  //  북쪽 6km 경로, 1,000~5,000m 터널, 4,600m 에 과속 80 (입구에서 3.6km 안). 입구 300m 앞(700m)부터 알리고,
  //  1,000m 에서 GPS 가 끊긴 뒤 1초마다 마지막 속도(시속 60)로 경로를 따라 나아가 거리가 줄고, 카메라를 지나면 지남으로 친다
  async function s103() {
    const t = T(), r = {};
    const P = [];
    for (let k = 0; k <= 600; k++) { const p = dest(NAV_ORIGIN, 0, 10 * k); P.push({ lat: round6(p.lat), lng: round6(p.lng) }); }
    const cum = [0];
    for (let i = 1; i < P.length; i++) cum.push(cum[i - 1] + hav(P[i - 1], P[i]));
    const total = cum[cum.length - 1];
    const R = { route: { distance: r0(total), duration: r0(total / 17 * 1000), tollFare: 0, fuelPrice: 0, path: P.map((p) => [p.lng, p.lat]),
      guide: [{ i: 600, t: 88, s: '목적지', d: r0(total), ms: r0(total / 17 * 1000) }], sections: [{ i: 0, n: 601, name: '테스트터널로', speed: 60, cong: 1 }] },
      P, cum, total, dest: { name: '테스트', addr: '', lat: P[600].lat, lng: P[600].lng } };
    const enc = (pts) => { const q = pts.map((x) => [Math.round(x.lat * 1e5), Math.round(x.lng * 1e5)]); const row = [0, 1, q[0][0], q[0][1]];
      for (let k = 1; k < q.length; k++) row.push(q[k][0] - q[k - 1][0], q[k][1] - q[k - 1][1]); return row; };
    const north = (m) => dest(NAV_ORIGIN, 0, m);
    const cp = north(4600);
    const fake = [round6(cp.lat), round6(cp.lng), 80, 1, 0, 0, 0, -1, 3, 1];
    fake.eb = 0; fake.e2 = 0; fake.lv = 0; fake.sl = fake[0]; fake.sg = fake[1];
    const rows = t.cams.rows, fi = rows.length;
    const key = Math.floor(fake[0] / 0.01) + ':' + Math.floor(fake[1] / 0.01);
    const cell = t.cams.grid.get(key) || [];
    const prevT = t.prefs.tunnels;
    try {
      rows.push(fake); cell.push(fi); t.cams.grid.set(key, cell);
      t.prefs.tunnels = true;
      t.setTunnelData({ v: 1, scale: 1e5, names: ['테스트터널'], w: [enc([north(1000), north(3000), north(5000)])] });
      await resetApp(); softReset();
      await planAndStart(R);
      let first = null;
      for (let s = 0; s <= 1000; s += 20) {
        const a = pointAt(R, s);
        feed(a.p, 60 / 3.6, a.h, { dt: 1200 });
        const tg = t.camState.target;
        if (tg && tg.c === fake && first === null) first = s;
      }
      r.first = first;
      const tg0 = t.camState.target;
      r.atEntrance = tg0 && tg0.c === fake ? { dist: text('#camDist'), limit: text('#camLimit') } : null;
      // GPS 끊김: 1초마다 (실제 시계를 앞으로 돌린 것처럼)
      const base = Date.now();
      const dists = [];
      let passedAt = null;
      for (let k = 2; k <= 260; k += 2) {
        t.tunnelCamTick(base + k * 1000);
        const tg = t.camState.target;
        if (k % 20 === 0) dists.push(tg && tg.c === fake ? Math.round(tg.r) : null);
        if (passedAt === null && t.camState.passed.has(fi)) passedAt = k;
      }
      r.dists = dists; r.passedAt = passedAt;
    } finally {
      t.endNav();
      rows.pop(); cell.pop(); if (!cell.length) t.cams.grid.delete(key);
      t.camMiss.near.delete(fi); t.camState.passed.delete(fi);
      t.prefs.tunnels = prevT; t.setTunnelData(null); await t.loadTunnels();
      await resetApp(); softReset();
    }
    // 입구 300m 앞(700m) 무렵부터 경고, 끊긴 뒤 거리가 줄고, 약 216초(3,600m ÷ 16.7m/s) 무렵 지남
    const dec = r.dists.filter((x) => x !== null);
    const ok = r.first !== null && r.first <= 760 && r.atEntrance && r.atEntrance.limit === '80' &&
      dec.length >= 3 && dec.every((x, k) => k === 0 || x < dec[k - 1]) && r.passedAt !== null && r.passedAt >= 200 && r.passedAt <= 240;
    return { pass: !!ok, detail: JSON.stringify(r) };
  }

  // S104: 카메라 고르기 2차 점검 (v165, 2026-11-20 — 실제 네이버 경로 21개·서울경기 전 카메라 가상 주행)
  //  (a) 도로 이름 표기 맞추기 (b) 경로 옆 15m 예외: 원래 좌표 15m 안(용구대로 60 #20115, 정지선으로 옮긴 차로 위 점 18.8m)·같은 이름 30m
  //  (c) 고속도로 위 박스형(도로 종류가 일반으로 들어간 행)이 고속도로 경로에서 빠지지 않는다 (d) 진입 안내만 있는 고속도로 구간은 일반도로 이름에서 끝난다
  //  (e) 빠른 길 구간에서는 고가·지하 표시 카메라를 남긴다 (f) 반대 방향 행은 지남으로 치지 않는다 (g) 굽은 길의 그 자리 방향
  async function s104() {
    const t = T(), r = {};
    r.a = {
      bundang: t.sameRoad('분당-수서간고속화도로', '분당수서간도시고속화도로'), bundangName: t.sameRoad('분당수서로', '분당-수서간도시고속화도로'),
      dongbu: t.sameRoad('동부간선도로', '동부간선로'), ring: t.sameRoad('서울외곽순환고속도로', '수도권1순환고속도로'),
      notCentral: !t.sameRoad('중앙로', '중앙고속도로'), notSongpa: !t.sameRoad('송파대로', '송파로'),
    };
    const routeThrough = (pt, h, name, side) => {
      const off = side ? dest(pt, (h + 270) % 360, side) : pt;   // 경로선을 왼쪽으로 side m 옮긴다
      const start = dest(off, (h + 180) % 360, 1000), P = [];
      for (let k = 0; k <= 150; k++) { const p = dest(start, h, 10 * k); P.push({ lat: round6(p.lat), lng: round6(p.lng) }); }
      const cum = [0];
      for (let i = 1; i < P.length; i++) cum.push(cum[i - 1] + hav(P[i - 1], P[i]));
      const total = cum[cum.length - 1];
      return { route: { distance: r0(total), duration: r0(total / 20 * 1000), tollFare: 0, fuelPrice: 0, path: P.map((p) => [p.lng, p.lat]),
        guide: [{ i: 150, t: 88, s: '목적지', d: r0(total), ms: r0(total / 20 * 1000) }], sections: [{ i: 0, n: 151, name, speed: 60, cong: 1 }] },
        P, cum, total, dest: { name: '테스트', addr: '', lat: P[150].lat, lng: P[150].lng } };
    };
    const onRoute = async (c, R) => { await resetApp(); softReset(); await planAndStart(R); t.ensureRouteCams(); const ok = t.nav.routeCams.has(c); t.endNav(); return ok; };
    try {
      // (b) 원래 좌표 15m 안: 경로선을 원래 좌표로 (차로 위 점에서 18.8m)
      const Y = t.cams.rows.find((c) => Math.abs(c[0] - 37.30088) < 2e-5 && Math.abs(c[1] - 127.10645) < 2e-5 && c[2] === 60) ||
        t.cams.rows[20115];
      const yb = Y && Y.eb >= 0 ? Y.eb : 0;
      r.b = { lane: Y ? Math.round(hav({ lat: Y[0], lng: Y[1] }, lanePt(Y))) : null };
      r.b.raw = Y ? await onRoute(Y, routeThrough({ lat: Y[0], lng: Y[1] }, yb, '용구대로')) : null;
      // 같은 이름이면 차로 위 점에서 18m 떨어진 경로도, 다른 이름이면 아니다 (원래 좌표와 차로 위 점이 같은 카메라로: 대한로 어린이 30)
      const K = camAt(35.51725, 128.17371) && t.cams.rows.find((c) => sameCam(c, { lat: 35.51725, lng: 128.17371 }) && c[2] === 30);
      if (K) {
        r.b.same22 = await onRoute(K, routeThrough(lanePt(K), K.eb, '대한로', 18));
        r.b.other22 = await onRoute(K, routeThrough(lanePt(K), K.eb, '다른길', 18));
      }
      // (c) 박스형: OSM 길 이름이 고속도로인데 도로 종류가 일반·제한 70 이하로 들어간 행
      const base = t.cams.rows.length - (t.cams.mobile || 0);
      let M = null;
      for (let i = base; i < t.cams.rows.length; i++) { const c = t.cams.rows[i]; if (/중부고속도로|경부고속도로/.test(c.on || '') && c[8] !== 1 && c[2] <= 70 && c.eb >= 0) { M = c; break; } }
      r.c = M ? { name: M.on, lim: M[2], rtype: M[8], on: await onRoute(M, routeThrough(lanePt(M), M.eb, M.on)) } : 'none in data';
      // (d) 고속도로 진입 안내만 있고 출구가 없다: 구간 이름이 '한남대로'로 바뀌면 거기서 끝
      {
        const R = routeThrough(NAV_ORIGIN, 0, '경부고속도로');
        R.route.guide = [{ i: 10, t: 50, s: '고속도로 진입', d: 100, ms: 5000 }, { i: 150, t: 88, s: '목적지', d: 1400, ms: 70000 }];
        R.route.sections = [{ i: 0, n: 80, name: '경부고속도로', speed: 90, cong: 1 }, { i: 80, n: 71, name: '한남대로', speed: 40, cong: 1 }];
        await resetApp(); softReset(); await planAndStart(R);
        r.d = { spans: JSON.stringify(t.highwaySpans().map((x) => x.map(Math.round))), at500: t.onHighwayAt(500), at1200: t.onHighwayAt(1200) };
        t.endNav();
      }
      // (e) 고가·지하 카메라(층 16): 빠른 길이면 남기고 일반 길이면 뺀다 (지하·고가 안내 없음)
      const L16 = [0, 0, 100, 9, 0, 0, 0, -1, 5, 1]; L16.lv = 16;
      r.e = { fast: t.camLevelOk(L16, 500, '수도권제1순환고속도로', false), inner: t.camLevelOk(L16, 500, '내부순환로', false),
        street: t.camLevelOk(L16, 500, '문정로', false), hwSpan: t.camLevelOk(L16, 500, '', true) };
      // (f) 반대 방향 행은 지남으로 치지 않는다: 북한강로 50(#25702)을 지날 때 같은 자리에 반대 방향 가짜 행
      {
        const A = camAt(37.5646, 127.319);
        if (A) {
          const fake = [A[0], A[1], 50, 3, 0, 0, 0, -1, 5, 1]; fake.eb = (A.eb + 180) % 360; fake.e2 = 0; fake.lv = 0; fake.sl = A[0]; fake.sg = A[1];
          const rows = t.cams.rows, fi = rows.length; rows.push(fake);
          const key = Math.floor(fake[0] / 0.01) + ':' + Math.floor(fake[1] / 0.01), cell = t.cams.grid.get(key) || []; cell.push(fi); t.cams.grid.set(key, cell);
          try {
            await driveThrough(lanePt(A), A.eb, 300, 60, 50, 5);
            r.f = { passedA: t.camState.passed.has(rows.indexOf(A)), passedOpp: t.camState.passed.has(fi) };
          } finally { rows.pop(); cell.pop(); if (!cell.length) t.cams.grid.delete(key); t.camMiss.near.delete(fi); t.camState.passed.delete(fi); }
        }
      }
      // (g) 굽은 길: 오른쪽으로 1m 당 0.01 rad 굽으면 200m 앞의 진행 방향은 +115°
      {
        const keepK = t.curv.k, keepH = t.state.heading;
        t.curv.k = 0.01; t.state.heading = 10;
        r.g = Math.round(t.pathTangent(200));
        t.curv.k = keepK; t.state.heading = keepH;
      }
    } finally { await resetApp(); softReset(); }
    const ok = Object.values(r.a).every(Boolean) && r.b.raw === true && (r.b.same22 === undefined || (r.b.same22 && !r.b.other22)) &&
      (r.c === 'none in data' || r.c.on === true) &&
      r.d.at500 === true && r.d.at1200 === false &&
      r.e.fast && r.e.inner && !r.e.street && r.e.hwSpan &&
      r.f && r.f.passedA && !r.f.passedOpp && r.g === 125;
    return { pass: !!ok, detail: JSON.stringify(r) };
  }

  // S105: v165 가상 주행 뒤 (v167) — 같이 지남은 차로 위 점(정지선)으로 잰다, 구간 이름이 빈 경로의 고가·지하 카메라
  //  (a) 보개원삼로 50(점)과 정지선이 51m 앞인 신호 50: 신호를 지나도 점 카메라는 제자리까지 남는다
  //  (b) 복합물류로 50·60 은 원래 좌표 38m 지만 차로 위 점이 같다: 50 을 지나면 60 이 뜨지 않는다
  //  (c) 구간 이름이 없는 경로에서도 빠른 길(내부순환로 등) 위 고가·지하 카메라가 경로와 나란하면 남는다
  async function s105() {
    const t = T(), r = {};
    const at = (la, ln) => t.cams.rows.find((c) => Math.abs(c[0] - la) < 2e-5 && Math.abs(c[1] - ln) < 2e-5);
    try {
      const A = at(37.02239, 127.28875), S = at(37.02251, 127.28875);
      if (A && S) {
        let passedAt = null;
        await driveThrough(lanePt(A), A.eb >= 0 ? A.eb : 189, 500, 60, 50, 3, (s) => {
          if (passedAt === null && t.camState.passed.has(t.cams.rows.indexOf(A))) passedAt = s;
        });
        r.a = { passedAt, laneGap: Math.round(hav(lanePt(A), lanePt(S))) };
      } else r.a = 'not in data';
      const B50 = at(37.33512, 126.93686), B60 = at(37.33497, 126.93725);
      if (B50 && B60) {
        const shown = [];
        await driveThrough(lanePt(B50), B50.eb >= 0 ? B50.eb : 101, 500, 80, 50, 4, () => {
          const tg = t.camState.target, lab = tg ? text('#camLimit') : '';
          if (shown[shown.length - 1] !== lab) shown.push(lab);
        });
        r.b = { shown, laneGap: Math.round(hav(lanePt(B50), lanePt(B60))) };
      } else r.b = 'not in data';
      // (c) 고가·지하(층 16) 빠른 길 카메라를 구간 이름 없는 경로로
      let L = null;
      for (const c of t.cams.rows) if ((c.lv & 16) && c.eb >= 0 && /내부순환로|강변북로|북부간선/.test(c.on || '')) { L = c; break; }
      if (L) {
        const start = dest(lanePt(L), (L.eb + 180) % 360, 1000), P = [];
        for (let k = 0; k <= 150; k++) { const p = dest(start, L.eb, 10 * k); P.push({ lat: round6(p.lat), lng: round6(p.lng) }); }
        const cum = [0];
        for (let i = 1; i < P.length; i++) cum.push(cum[i - 1] + hav(P[i - 1], P[i]));
        const total = cum[cum.length - 1];
        const mk = (name) => ({ route: { distance: r0(total), duration: r0(total / 20 * 1000), tollFare: 0, fuelPrice: 0, path: P.map((p) => [p.lng, p.lat]),
          guide: [{ i: 150, t: 88, s: '목적지', d: r0(total), ms: r0(total / 20 * 1000) }], sections: name === null ? [] : [{ i: 0, n: 151, name, speed: 60, cong: 1 }] },
          P, cum, total, dest: { name: '테스트', addr: '', lat: P[150].lat, lng: P[150].lng } });
        const onR = async (name) => { await resetApp(); softReset(); await planAndStart(mk(name)); t.ensureRouteCams(); const ok = t.nav.routeCams.has(L); t.endNav(); return ok; };
        r.c = { name: L.on, lim: L[2], noSection: await onR(null), street: await onR('테스트골목길') };
      } else r.c = 'none in data';
    } finally { await resetApp(); softReset(); }
    const okA = r.a === 'not in data' || (r.a.passedAt !== null && r.a.passedAt >= -8);
    const okB = r.b === 'not in data' || r.b.laneGap > 12 || !r.b.shown.join(',').includes('50,60');
    const okC = r.c === 'none in data' || (r.c.noSection === true && r.c.street === false);
    return { pass: okA && okB && okC, detail: JSON.stringify(r) };
  }

  // S106: 신고한 단속 지점 (v169, 2026-11-20 운전자 '놓침 몇 개 눌렀는데 거긴 항상 업데이트가 안 되더라')
  //  (a) 북쪽으로 시속 60 으로 달리다 '놓침' → 이 기기에 저장, 자리는 누른 곳보다 약 2.5초(40m) 전
  //  (b) 다음에 같은 방향으로 지나면 500m 안에서 '내가 신고한 단속 지점' (v179: 제한속도를 근처 같은 방향 카메라에서 채웠을 때만, 못 채우면 숨김) (c) 반대 방향으로는 안 뜬다
  //  (d) 설정 목록에 '이 차에서만 알림'으로 보이고 지우면 안 뜬다 (e) 운전자가 두 번 넘게 누른 자리(data/driver_spots.json)는 모든 사용자에게 뜬다
  async function s106() {
    const t = T(), r = {}, keepRaw = t.store.get('mySpots'), keepArr = t.mySpots.slice();
    let fakeCam = null, fakeI = -1;
    const keepDrv6 = t.driverSpots.rows.slice(), keepSh6 = t.sharedSpots.slice();
    // 가짜 카메라는 사용자 행(신고 지점) 앞에 넣어야 한다: 사용자 행을 모두 뺀 뒤 넣고 다시 붙인다
    const userRowsOff = () => { t.mySpots.length = 0; t.driverSpots.rows.length = 0; t.sharedSpots.length = 0; t.applyUserSpots(); };
    const O = dest(NAV_ORIGIN, 90, 30000);   // 카메라가 없는 곳
    const pressAt = dest(O, 0, 1000);
    try {
      t.mySpots.length = 0; t.applyUserSpots();
      await driveThrough(pressAt, 0, 600, 0, 60, 16.7);   // 1초에 한 번
      document.getElementById('camMissBtn').click();
      await waitFor(() => !document.getElementById('camMissBtn').classList.contains('sending'), 2000, 10);
      const m = t.mySpots[0];
      r.a = m ? { n: t.mySpots.length, back: Math.round(hav(m, pressAt)), h: m.h, status: t.mySpotStatus(m), stored: !!t.store.get('mySpots') } : null;
      r.a.toast = text('#toast');
      const btn = document.getElementById('camMissBtn'); clearTimeout(btn._sentT); btn.classList.remove('sent', 'saved', 'sending'); btn.textContent = '잘못된 정보 신고';
      // (b) v178: 근처에 카메라가 없어 제한속도를 모르면 숨김 → 같은 방향 카메라(70)를 200m 뒤에 두면 채워져 보인다
      let first = null, label = '', limit = '';
      if (m) {
        r.a.lim0 = m.lim || 0;
        const F = dest(m, 180, 200);
        fakeCam = [round6(F.lat), round6(F.lng), 70, 1, 0, 0, 0, -1, 4, 1];
        fakeCam.eb = 0; fakeCam.e2 = 0; fakeCam.lv = 0; fakeCam.sl = fakeCam[0]; fakeCam.sg = fakeCam[1]; fakeCam.on = m.rn || '';   // 신고한 길과 같은 이름
        const keepSpots = t.mySpots.slice();
        userRowsOff();
        fakeI = t.cams.rows.length; t.cams.rows.push(fakeCam);
        const fk = Math.floor(fakeCam[0] / 0.01) + ':' + Math.floor(fakeCam[1] / 0.01);
        if (!t.cams.grid.has(fk)) t.cams.grid.set(fk, []); t.cams.grid.get(fk).push(fakeI);
        t.cams.userBase = null;
        keepSpots.forEach((x) => t.mySpots.push(x)); keepDrv6.forEach((x) => t.driverSpots.rows.push(x)); keepSh6.forEach((x) => t.sharedSpots.push(x));
        t.applyUserSpots();
        r.a.lim1 = m.lim;
        await driveThrough(m, 0, 900, 60, 60, 10, (s) => {
          const tg = t.camState.target;
          if (tg && t.isUserSpot(tg.c) && first === null) { first = -s; label = text('#camType'); limit = text('#camLimit'); }
        });
        // 가짜 카메라를 지나기 전에 신고 지점이 먼저 보일 수는 없다(200m 뒤) — 첫 표시 거리는 신고 지점 기준
        r.b = { first, label, limit };
        // (c) 반대 방향
        let opp = false;
        await driveThrough(m, 180, 900, 60, 60, 10, () => { const tg = t.camState.target; if (tg && t.isUserSpot(tg.c)) opp = true; });
        r.c = { opp };
        // (d) 설정 목록 → 지우기
        t.renderMySpots();
        const li = document.querySelector('#mySpotList li');
        r.d = { box: !document.getElementById('mySpotBox').hidden, text: li ? li.textContent : '' };
        if (li) li.querySelector('button').click();
        let after = false;
        await driveThrough(m, 0, 900, 60, 60, 10, () => { const tg = t.camState.target; if (tg && t.isUserSpot(tg.c)) after = true; });
        r.d.afterDelete = after; r.d.left = t.mySpots.length;
      }
      // (e) 모든 사용자: 강동대로 둔촌동 북서행 — v178: 제한속도를 채웠으면 보이고, 못 채웠으면 숨김.
      //     v194: 네이버 길안내로 확인해 자리를 옮기고(37.519472) 제한 50·신호·과속으로 적었다 → '운전자 신고 신호·과속단속'
      const D = t.driverSpots.rows.find((x) => Math.abs(x[0] - 37.519472) < 1e-4 || Math.abs(x[0] - 37.51902) < 1e-4);
      if (D) {
        let seen = '';
        const lim = D[4] > 0 ? D[4] : t.spotLimit({ lat: D[0], lng: D[1], h: D[2] }, '');
        await driveThrough({ lat: D[0], lng: D[1] }, D[2], 800, 40, 50, 10, () => { const tg = t.camState.target; if (tg && t.isUserSpot(tg.c) && !seen) seen = text('#camType'); });
        r.e = { rows: t.driverSpots.rows.length, seen, lim, nv: !!((D[6] | 0) & 2) };
      } else r.e = 'no driver spots';
    } finally {
      if (fakeI >= 0) {
        userRowsOff();
        const fk = Math.floor(fakeCam[0] / 0.01) + ':' + Math.floor(fakeCam[1] / 0.01), a = t.cams.grid.get(fk);
        if (a) { const j = a.indexOf(fakeI); if (j >= 0) a.splice(j, 1); }
        t.camState.passed.delete(fakeI); t.camMiss.near.delete(fakeI);
        t.cams.rows.length = fakeI; t.cams.userBase = null;
      }
      t.driverSpots.rows.length = 0; keepDrv6.forEach((x) => t.driverSpots.rows.push(x));
      t.sharedSpots.length = 0; keepSh6.forEach((x) => t.sharedSpots.push(x));
      t.mySpots.length = 0; keepArr.forEach((x) => t.mySpots.push(x));
      t.store.set('mySpots', keepRaw); t.applyUserSpots();
      await resetApp(); softReset();
    }
    const ok = r.a && r.a.n === 1 && r.a.back >= 25 && r.a.back <= 75 && r.a.stored && r.a.status === 'nolimit' && /제한속도를 몰라/.test(r.a.toast) &&
      r.a.lim0 === 0 && r.a.lim1 === 70 &&
      r.b.first !== null && r.b.first <= 520 && /내가 신고한 단속 지점/.test(r.b.label) && r.b.limit === '70' && !r.c.opp &&
      r.d.box && /이 차에서만 알림/.test(r.d.text) && !r.d.afterDelete && r.d.left === 0 &&
      r.e.rows >= 5 && (r.e.lim > 0 ? (r.e.nv ? r.e.seen === '신호·과속단속' : /운전자 신고 (단속 지점|신호·과속단속)/.test(r.e.seen)) : !r.e.seen);   // v208: 네이버 확인 지점은 보통 이름
    return { pass: !!ok, detail: JSON.stringify(r) };
  }

  // S107: 회전 앞 경로 이탈 (v170, 2026-11-20 운전자 '회전교차로나 우회전 고속도로 나갈 때 이탈이 잘 되는 느낌 … 직진 차로로 갑자기 경로가 바뀌어버려').
  //  (a) 우회전 진출: 네이버 경로선은 실제 갈림(1,000m)보다 100m 앞(900m)에서 대각선으로 질러 간다. 차는 오른쪽 바깥 차로(5m)로 곧장 가다
  //      1,000m 에서 오른쪽으로 꺾는다 → 재탐색이 없어야 한다 (예전엔 950m 쯤 경로선 32m·방향 45° 로 2초 만에 이탈)
  //  (b) 같은 경로에서 진출로를 지나쳐 곧장 가면 → 갈림을 지나 200m 안에 재탐색 (c) 회전교차로(반지름 25m)를 한 바퀴 더 돌고 3시 방향으로 나가도 재탐색 없음
  async function s107() {
    const t = T(), r = {};
    const at = (x, y) => dest(dest(NAV_ORIGIN, 90, x), 0, y);   // 동쪽 x m, 북쪽 y m
    const mkRoute = (pts, guide) => {
      const P = pts.map((p) => ({ lat: round6(p.lat), lng: round6(p.lng) }));
      const cum = [0];
      for (let i = 1; i < P.length; i++) cum.push(cum[i - 1] + hav(P[i - 1], P[i]));
      const total = cum[cum.length - 1];
      guide.push({ i: P.length - 1, t: 88, s: '목적지', d: 0, ms: 0 });
      return { route: { distance: r0(total), duration: r0(total / 14 * 1000), tollFare: 0, fuelPrice: 0, path: P.map((p) => [p.lng, p.lat]), guide,
        sections: [{ i: 0, n: P.length, name: '', speed: 50, cong: 1 }] }, P, cum, total, dest: { name: '테스트', addr: '', lat: P[P.length - 1].lat, lng: P[P.length - 1].lng } };
    };
    const reroutes = (c0) => stub.count('/route', c0);
    const drive = async (R, path) => {
      await resetApp(); softReset();
      await planAndStart(R);
      const c0 = stub.calls.length;
      let firstAt = null;
      for (const [p, h, label] of path) {
        feed(p, 50 / 3.6, h, { dt: 1000, acc: 3 });
        if (firstAt === null && reroutes(c0) > 0) firstAt = label;
        await waitFor(() => !t.nav.busy, 1000, 10);
      }
      t.endNav();
      return { reroutes: reroutes(c0), firstAt };
    };
    try {
      // (a)(b) 우회전 진출 — 경로선: 북쪽 900m, 대각선으로 (100, 1000), 동쪽 300m
      const pts = [];
      for (let y = 0; y <= 900; y += 10) pts.push(at(0, y));
      for (let k = 1; k <= 10; k++) pts.push(at(10 * k, 900 + 10 * k));
      for (let x = 110; x <= 400; x += 10) pts.push(at(x, 1000));
      const gi = 90;   // 900m 점
      const R = mkRoute(pts, [{ i: gi, t: 3, s: "'테스트IC' 방면으로 오른쪽 출구", d: 900, ms: 60000 }]);
      const pathA = [];
      for (let y = 300; y <= 1000; y += 14) pathA.push([at(5, y), 0, 'y' + y]);
      for (let x = 19; x <= 300; x += 14) pathA.push([at(x, 1000), 90, 'x' + x]);
      r.a = await drive(R, pathA);
      const pathB = [];
      for (let y = 300; y <= 1400; y += 14) pathB.push([at(5, y), 0, y]);
      r.b = await drive(mkRoute(pts.slice(), [{ i: gi, t: 3, s: "'테스트IC' 방면으로 오른쪽 출구", d: 900, ms: 60000 }]), pathB);
      // (c) 회전교차로: 남쪽에서 북쪽으로 800m, 반지름 25m 원(중심 (0, 825)), 3시 방향(동쪽)으로 나가 300m
      const C = { x: 0, y: 825 }, Rr = 25;
      const rpts = [];
      for (let y = 0; y <= 800; y += 10) rpts.push(at(0, y));
      for (let a = -90; a <= 0; a += 15) rpts.push(at(C.x + Rr * Math.cos(a * Math.PI / 180), C.y + Rr * Math.sin(a * Math.PI / 180)));   // 반시계(동쪽으로) 1/4 바퀴
      for (let x = 35; x <= 330; x += 10) rpts.push(at(x, C.y));
      const Rc = mkRoute(rpts, [{ i: 80, t: 94, s: '회전교차로에서 3시 방향', d: 800, ms: 60000 }]);
      const pathC = [];
      for (let y = 300; y <= 800; y += 14) pathC.push([at(0, y), 0, 'y' + y]);
      for (let a = -90; a <= 360; a += 12) {   // 1과 1/4 바퀴
        const rad = a * Math.PI / 180;
        pathC.push([at(C.x + Rr * Math.cos(rad), C.y + Rr * Math.sin(rad)), ((360 - a) % 360 + 360) % 360, 'a' + a]);   // 반시계로 돌 때 진행 방향
      }
      for (let x = 35; x <= 300; x += 14) pathC.push([at(x, C.y), 90, 'x' + x]);
      r.c = await drive(Rc, pathC);
    } finally { await resetApp(); softReset(); }
    const bAt = r.b.firstAt;
    const ok = r.a.reroutes === 0 && r.b.reroutes >= 1 && typeof bAt === 'number' && bAt > 1000 && bAt <= 1200 && r.c.reroutes === 0;
    return { pass: ok, detail: JSON.stringify(r) };
  }

  // S108: '놓침' 진단·고침 (v171, 2026-11-20 운전자 '놓침을 누르면 … 바로 반영될 수 있었으면'). 카메라 없는 곳에 가짜 카메라를 두고
  //  (a) '틀림'으로 숨긴 카메라를 지나 놓침 → 'flag' 를 풀고 다음엔 뜬다 (b) 방향이 반대로 적힌 카메라 → 'dir' 이 차에서 양방향, 다음엔 뜬다
  //  (c) 근처에 카메라가 없으면 '새 단속 지점으로 저장' (d) 길안내 중 경로선 30m 옆 카메라 → 'route' 경로 위로 본다
  //  (e) 설정 목록 '고친 카메라' 되돌리기 (f) 모든 사용자 고침(/fixes): 방향 고침과 신고 지점을 받아 적용
  async function s108() {
    const t = T(), r = {};
    const O = dest(NAV_ORIGIN, 90, 45000), at = (x, y) => dest(dest(O, 90, x), 0, y);
    const keep = { drv: t.driverSpots.rows.slice(), shared: t.sharedSpots.slice(), mine: t.mySpots.slice(), mineRaw: t.store.get('mySpots'),
      fixRaw: t.store.get('camFix'), noMap: new Map(t.camNoMap), noRaw: t.store.get('camNo2') };
    const btn = document.getElementById('camMissBtn');
    const press = async () => {
      btn.click();
      await waitFor(() => !btn.classList.contains('sending'), 2000, 10);
      const msg = document.getElementById('toast').textContent;
      clearTimeout(btn._sentT); btn.classList.remove('sent', 'saved', 'sending'); btn.textContent = '잘못된 정보 신고';
      return msg;
    };
    const fakes = [];
    const mk = (p, eb, lim) => { const c = [round6(p.lat), round6(p.lng), lim, 1, 0, 0, 0, -1, 4, 1]; c.eb = eb; c.e2 = 0; c.lv = 0; c.sl = c[0]; c.sg = c[1]; c.on = ''; return c; };
    let base0 = null;
    try {
      // 신고 지점을 잠시 비우고 가짜 카메라를 사용자 행 앞에 넣는다
      t.driverSpots.rows.length = 0; t.sharedSpots.length = 0; t.mySpots.length = 0; t.camFixes.clear();
      t.applyUserSpots(); base0 = t.cams.rows.length;
      const A = mk(at(0, 1000), 0, 50), B = mk(at(0, 3000), 180, 60), D = mk(at(30, 5500), 0, 70);   // A 북행 50, B 남행으로 적힌 60, D 경로 30m 옆
      for (const c of [A, B, D]) { const i = t.cams.rows.length; t.cams.rows.push(c); fakes.push(i); const k = Math.floor(c[0] / 0.01) + ':' + Math.floor(c[1] / 0.01); if (!t.cams.grid.has(k)) t.cams.grid.set(k, []); t.cams.grid.get(k).push(i); }
      t.cams.userBase = null; t.applyUserSpots();
      const alerted = (c) => async (y0, y1) => { let hit = false; await driveThrough(at(c === D ? 30 : 0, y1), 0, y1 - y0, 0, 60, 16.7, () => { const tg = t.camState.target; if (tg && tg.c === c) hit = true; }); return hit; };
      // (a) 숨긴 A
      t.camNoMap.set(A[0] + ',' + A[1], [{ h: 0, t0: Date.now(), t1: Date.now(), days: ['x', 'y'], lim: 50, name: '' }]);
      const a0 = await alerted(A)(500, 1100);
      const msgA = await press();
      const a1 = await alerted(A)(500, 1100);
      r.a = { before: a0, msg: msgA, after: a1, flag: t.camFlag(A, 0) };
      // (b) 남행으로 적힌 B 를 북행으로
      const b0 = await alerted(B)(2500, 3100);
      const msgB = await press();
      const b1 = await alerted(B)(2500, 3100);
      r.b = { before: b0, msg: msgB, after: b1, e2: B.e2, fix: [...(t.camFixes.get(B[0] + ',' + B[1]) || [])] };
      // (c) 카메라 없는 곳
      await driveThrough(at(0, 8000), 0, 600, 0, 60, 16.7);
      const msgC = await press();
      r.c = { msg: msgC, spots: t.mySpots.length };
      // (d) 길안내 중 경로선(북쪽 직선) 30m 옆 D
      {
        const P = []; for (let y = 4500; y <= 6500; y += 10) P.push(at(0, y));
        const PP = P.map((p) => ({ lat: round6(p.lat), lng: round6(p.lng) })), cum = [0];
        for (let i = 1; i < PP.length; i++) cum.push(cum[i - 1] + hav(PP[i - 1], PP[i]));
        const total = cum[cum.length - 1];
        const R = { route: { distance: r0(total), duration: r0(total / 16 * 1000), tollFare: 0, fuelPrice: 0, path: PP.map((p) => [p.lng, p.lat]),
          guide: [{ i: PP.length - 1, t: 88, s: '목적지', d: r0(total), ms: r0(total / 16 * 1000) }], sections: [{ i: 0, n: PP.length, name: '', speed: 60, cong: 1 }] },
          P: PP, cum, total, dest: { name: '테스트', addr: '', lat: PP[PP.length - 1].lat, lng: PP[PP.length - 1].lng } };
        await resetApp(); softReset(); await planAndStart(R); t.ensureRouteCams();
        const d0 = t.nav.routeCams.has(D);
        for (let s = 0; s <= 1100; s += 16.7) { const a2 = pointAt(R, s); feed(a2.p, 60 / 3.6, a2.h, { dt: 1000, acc: 3 }); }
        const msgD = await press();
        t.ensureRouteCams();
        r.d = { before: d0, msg: msgD, after: t.nav.routeCams.has(D) };
        t.endNav();
      }
      // (e) 설정 목록
      t.renderMySpots();
      const fixLi = [...document.querySelectorAll('#mySpotList li')].filter((li) => /고친 카메라/.test(li.textContent));
      r.e = { fixes: fixLi.length, text: fixLi.map((li) => li.textContent).join(' | ') };
      const undo = fixLi.find((li) => /양방향/.test(li.textContent));
      if (undo) undo.querySelector('button').click();
      r.e.e2After = B.e2;
      // (f) 모든 사용자 고침
      const realF = window.fetch;
      window.fetch = (u, o) => (/\/fixes(\?|$)/.test(String(u)) ? Promise.resolve(new Response(JSON.stringify({ v: 1, items: [
        { kind: 'dir', k: B[0] + ',' + B[1], lat: B[0], lng: B[1], h: 0 }, { kind: 'spot', lat: at(0, 9000).lat, lng: at(0, 9000).lng, h: 0 }] }), { status: 200 })) : realF(u, o));
      try { r.f = { ok: await t.loadSharedFixes() }; } finally { window.fetch = realF; }
      r.f.e2 = B.e2; r.f.shared = t.sharedSpots.length;
      r.f.userRow = t.cams.rows.slice(t.cams.userBase).some((c) => Math.abs(c[0] - round6(at(0, 9000).lat)) < 1e-5);
    } finally {
      t.sharedFixes.clear(); t.sharedSpots.length = 0;
      t.driverSpots.rows.length = 0; t.mySpots.length = 0; t.applyUserSpots();   // 사용자 행 빼기
      if (base0 !== null) {
        for (const i of fakes.slice().reverse()) { const c = t.cams.rows[i]; if (!c) continue; const k = Math.floor(c[0] / 0.01) + ':' + Math.floor(c[1] / 0.01); const a = t.cams.grid.get(k); if (a) { const j = a.indexOf(i); if (j >= 0) a.splice(j, 1); } t.camMiss.near.delete(i); t.camState.passed.delete(i); t.camState.saidById.delete(i); }
        t.cams.rows.length = base0; t.cams.userBase = null;
      }
      t.camFixes.clear(); t.store.set('camFix', keep.fixRaw);
      t.camNoMap.clear(); keep.noMap.forEach((v, k) => t.camNoMap.set(k, v)); t.store.set('camNo2', keep.noRaw);
      keep.drv.forEach((x) => t.driverSpots.rows.push(x)); keep.shared.forEach((x) => t.sharedSpots.push(x)); keep.mine.forEach((x) => t.mySpots.push(x));
      t.store.set('mySpots', keep.mineRaw);
      t.applyUserSpots(); t.applyCamFixes();
      const te = document.getElementById('toast'); if (te) te.hidden = true;
      await resetApp(); softReset();
    }
    const ok = r.a.before === false && /신고로 숨겨/.test(r.a.msg) && r.a.after === true && !r.a.flag &&
      r.b.before === false && /방향이 반대/.test(r.b.msg) && r.b.after === true && r.b.e2 === 1 &&
      /새 단속 지점/.test(r.c.msg) && r.c.spots === 1 &&
      r.d.before === false && /경로 밖으로/.test(r.d.msg) && r.d.after === true &&
      r.e.fixes >= 2 && r.e.e2After === 0 &&
      r.f.ok && r.f.e2 === 1 && r.f.shared === 1 && r.f.userRow;
    return { pass: !!ok, detail: JSON.stringify(r) };
  }

  // S119: 운전자가 확인한 단속 지점의 제한속도 (v186, 2026-11-22 신중부대로·남북대로 80 여섯 곳 — 경찰청 자료·OSM 에 없음)
  //   (a) data/driver_spots.json 에서 다섯째 값(제한속도)이 있는 행은 그 값 그대로 (근처 카메라 값으로 바꾸지 않음)
  //   (b) 남행 곧은 경로의 1,500m 자리 오른쪽 3m 지점(진행 방향 180): 경로 위, 900m 넘게 앞에서 '운전자 신고 단속 지점' · 80
  //   (c) 같은 길 북행: 경로 위 아님, 뜨지 않음
  async function s119() {
    const t = T(), r = {};
    const O = dest(NAV_ORIGIN, 90, 80000);
    const mk = (north) => {
      const P = [];
      for (let k = 0; k <= 120; k++) { const q = dest(O, 180, 20 * (north ? 120 - k : k)); P.push({ lat: round6(q.lat), lng: round6(q.lng) }); }
      const cum = [0];
      for (let i = 1; i < P.length; i++) cum.push(cum[i - 1] + hav(P[i - 1], P[i]));
      const total = cum[cum.length - 1];
      return { route: { distance: r0(total), duration: r0(total / 22 * 1000), tollFare: 0, fuelPrice: 0, path: P.map((q) => [q.lng, q.lat]),
        guide: [{ i: 120, t: 88, s: '목적지', d: r0(total), ms: r0(total / 22 * 1000) }],
        sections: [{ i: 0, n: 121, name: '시험대로', speed: 70, cong: 1 }] },
        P, cum, total, dest: { name: '확인 지점 시험', addr: '', lat: P[120].lat, lng: P[120].lng } };
    };
    const spotP = dest(dest(O, 180, 1500), 270, 3);
    const keep = { mine: t.mySpots.slice(), drv: t.driverSpots.rows.slice(), shared: t.sharedSpots.slice() };
    try {
      // (a) 실제 자료
      t.applyUserSpots();
      const base = t.cams.userBase, users = t.cams.rows.slice(base);
      const confirmed = keep.drv.filter((x) => x[4] > 0);
      r.data = { confirmed: confirmed.length, kept: confirmed.every((x) => users.some((c) => Math.abs(c[0] - x[0]) < 1e-6 && Math.abs(c[1] - x[1]) < 1e-6 && c[2] === x[4])) };
      // (b)·(c) 시험 지점 하나만
      t.mySpots.length = 0; t.sharedSpots.length = 0; t.driverSpots.rows.length = 0;
      t.driverSpots.rows.push([round6(spotP.lat), round6(spotP.lng), 180, 80, 80]);
      t.applyUserSpots();
      const row = t.cams.rows[t.cams.userBase];
      const run = async (north) => {
        const R = mk(north), at = north ? R.total - 1500 : 1500;
        await resetApp(); softReset();
        await planAndStart(R);
        t.ensureRouteCams();
        const on = !!(t.nav.routeCams && t.nav.routeCams.has(row));
        let seen = null, label = '', limit = '';
        for (let s = 0; s <= at + 40; s += 20) {
          const q = pointAt(R, s); feed(q.p, 22, q.h);
          const tg = t.camState.target;
          if (tg && tg.c === row && seen === null) { seen = Math.round(at - s); label = text('#camType'); limit = text('#camLimit'); }
        }
        t.endNav();
        return { on, seen, label, limit };
      };
      r.south = await run(false);
      r.north = await run(true);
      // (d) v188: 같은 방향 75m 뒤의 내 신고 지점('놓침'은 약 3초 전 자리)은 같은 카메라 — 한 번만. 반대 방향이면 다른 지점
      t.mySpots.length = 0;
      const back = dest(spotP, 0, 75);   // 남행이므로 북쪽이 뒤
      t.mySpots.push({ lat: round6(back.lat), lng: round6(back.lng), h: 180, t: Date.now(), days: ['x'], kmh: 90, lim: 100, rn: '' });
      t.applyUserSpots();
      const rowsD = t.cams.rows.slice(t.cams.userBase);
      r.mine = { rows: rowsD.length, who: rowsD.map((c) => c.who).join(','), status: t.mySpotStatus(t.mySpots[0]) };
      t.mySpots[0].h = 0; t.applyUserSpots();
      r.mine.oppRows = t.cams.rows.length - t.cams.userBase;
      // v191: 빠른 길(시속 90)에서 370m 뒤면 같은 카메라(다른 내비가 앞에서 알릴 때 누름), 시속 40·이름 없는 길이면 다른 지점
      const back2 = dest(spotP, 0, 370);
      t.mySpots.length = 0;
      t.mySpots.push({ lat: round6(back2.lat), lng: round6(back2.lng), h: 180, t: Date.now(), days: ['x'], kmh: 90, lim: 100, rn: '' });
      t.applyUserSpots();
      r.mine.far = t.cams.rows.length - t.cams.userBase;
      t.mySpots[0].kmh = 40; t.applyUserSpots();
      r.mine.farSlow = t.cams.rows.length - t.cams.userBase;
    } finally {
      t.mySpots.length = 0; keep.mine.forEach((x) => t.mySpots.push(x));
      t.driverSpots.rows.length = 0; keep.drv.forEach((x) => t.driverSpots.rows.push(x));
      t.sharedSpots.length = 0; keep.shared.forEach((x) => t.sharedSpots.push(x));
      t.applyUserSpots();
      await resetApp(); softReset();
    }
    const ok = r.data.confirmed >= 6 && r.data.kept && r.south.on && r.south.seen !== null && r.south.seen >= 900 && /운전자 신고 단속 지점/.test(r.south.label) && /80/.test(r.south.limit) && !r.north.on && r.north.seen === null &&
      r.mine.rows === 1 && r.mine.who === 'driver' && r.mine.status === 'driver' && r.mine.oppRows === 2 && r.mine.far === 1 && r.mine.farSlow === 2;
    return { pass: !!ok, detail: JSON.stringify(r) };
  }

  // S121: 빠른 길 옆 저속 일반도로 카메라 (v190). 합성 북행 곧은 길 4km, 실제 카메라가 없는 동해 위(36.90, 129.70)
  async function s121() {
    const t = T(), r = {};
    const O = { lat: 36.90, lng: 129.70 };
    const along = (s) => dest(O, 0, s);
    const P = [];
    for (let k = 0; k <= 200; k++) { const q = along(20 * k); P.push({ lat: round6(q.lat), lng: round6(q.lng) }); }
    const cum = [0];
    for (let i = 1; i < P.length; i++) cum.push(cum[i - 1] + hav(P[i - 1], P[i]));
    const total = cum[cum.length - 1];
    const mkR = (name) => ({ route: { distance: r0(total), duration: r0(total / 14 * 1000), tollFare: 0, fuelPrice: 0, path: P.map((q) => [q.lng, q.lat]),
      guide: [{ i: 200, t: 88, s: '목적지', d: r0(total), ms: r0(total / 14 * 1000) }],
      sections: name ? [{ i: 0, n: 201, name, speed: 60, cong: 1 }] : [] },
      P, cum, total, dest: { name: 'S121 시험', addr: '', lat: P[200].lat, lng: P[200].lng } });
    // 북행: 진행 방향 오른쪽은 동쪽(90°)
    const mk = (s, off, lim, zone, on) => { const p = dest(along(s), 90, off); const c = [round6(p.lat), round6(p.lng), lim, zone ? 3 : 1, 0, 0, zone, -1, 5, 1]; c.eb = 0; c.e2 = 0; c.lv = 0; c.sl = c[0]; c.sg = c[1]; c.on = on; return c; };
    const S30 = mk(2000, 10, 30, 2, '');          // 이름 없는 어린이 30, 10m 옆
    const F80 = mk(2600, 10, 80, 0, '');          // 이름 없는 80, 10m 옆
    const O30 = mk(3000, 10, 30, 2, '올림픽대로'); // 올림픽대로 이름의 30, 10m 옆
    const N30 = mk(2300, 10, 30, 2, '신정로');     // 자유 주행: 옆길 이름 30, 10m 옆
    const L30 = mk(3300, 2, 30, 2, '');           // 자유 주행: 앞길 2m 옆 30 (내 길)
    const all = { S30, F80, O30, N30, L30 };
    const fakes = []; let base0 = null;
    const keep = { road: t.road.name };
    const guided = async (R, kmh) => {
      await resetApp(); softReset();
      await planAndStart(R);
      t.ensureRouteCams();
      const on = {}; for (const k in all) on[k] = t.nav.routeCams.has(all[k]);
      const seen = {}; const other = new Set(); const v = kmh / 3.6;
      for (let s = 1200; s <= 3400; s += v) {
        const q = pointAt(R, s); feed(q.p, v, q.h, { dt: 1000, acc: 3 });
        const tg = t.camState.target; if (!tg) continue;
        const k = Object.keys(all).find((x) => all[x] === tg.c);
        if (k) { if (!(k in seen)) seen[k] = Math.round(s); } else other.add(tg.i);
      }
      return { on, seen, other: [...other].join(' ') };
    };
    const free = async (kmh) => {
      await resetApp(); softReset();
      stub.canned['/reverse'] = { road: '신정로', area: '시험' };
      const R = mkR(''), seen = {}, v = kmh / 3.6;
      for (let s = 1200; s <= 3400; s += v) {
        t.road.name = '신정로';
        const q = pointAt(R, s); feed(q.p, v, q.h, { dt: 1000, acc: 3 });
        const tg = t.camState.target; if (!tg) continue;
        const k = Object.keys(all).find((x) => all[x] === tg.c);
        if (k && !(k in seen)) seen[k] = Math.round(s);
      }
      return seen;
    };
    try {
      base0 = t.cams.rows.length;
      for (const c of Object.values(all)) { const i = t.cams.rows.length; t.cams.rows.push(c); fakes.push(i); const k = Math.floor(c[0] / 0.01) + ':' + Math.floor(c[1] / 0.01); if (!t.cams.grid.has(k)) t.cams.grid.set(k, []); t.cams.grid.get(k).push(i); }
      r.olym = await guided(mkR('올림픽대로'), 60); t.endNav();
      r.local80 = await guided(mkR(''), 80); t.endNav();
      r.local40 = await guided(mkR(''), 40); t.endNav();
      r.free80 = await free(80);
      r.free40 = await free(40);
    } finally {
      stub.reset();
      t.road.name = keep.road;
      if (base0 !== null) {
        for (const i of fakes.slice().reverse()) { const c = t.cams.rows[i]; if (!c) continue; const k = Math.floor(c[0] / 0.01) + ':' + Math.floor(c[1] / 0.01); const a2 = t.cams.grid.get(k); if (a2) { const j = a2.indexOf(i); if (j >= 0) a2.splice(j, 1); } t.camMiss.near.delete(i); t.camState.passed.delete(i); t.camState.saidById.delete(i); }
        t.cams.rows.length = base0; t.cams.userBase = null;
      }
      await resetApp(); softReset();
    }
    const ok = !r.olym.on.S30 && r.olym.on.F80 && r.olym.on.O30 && !('S30' in r.olym.seen) && ('F80' in r.olym.seen) && ('O30' in r.olym.seen) &&
      r.local80.on.S30 && !('S30' in r.local80.seen) && ('L30' in r.local80.seen) &&
      ('S30' in r.local40.seen) &&
      !('N30' in r.free80) && ('L30' in r.free80) && ('N30' in r.free40);
    return { pass: !!ok, detail: JSON.stringify(r) };
  }

  // S120: 고속도로 옆 일반도로 카메라 (v187, 2026-11-23 운전자 '틀림': 경부 하행 신갈JC 남쪽 50km/h 에서 300m 앞 '어린이보호구역 신호·과속' 30)
  //   실제 카메라 #20526(신정로 상미사거리, 남행 181°)은 네이버 경부 하행 경로선 오른쪽 23m(차로 위 점). 11-20 '놓침' 진단이 이 카메라에 '경로 위' 고침을 붙여
  //   (고친 카메라는 40m 까지·고속도로 거르기 없이) 그 뒤 경부에서 떴다. 합성 경로: 카메라 서쪽 28m 를 지나는 남행 곧은 '경부고속도로' 4km
  //   (a) '경로 위' 고침이 있어도 경로 위 아님·안 뜸  (b) 고침 없이 지나 '놓침' → 이 카메라에는 아무 고침도 없음
  //   (c) 길안내 없이 경부 50km/h: 앞길 10m 옆 신정로 어린이 30(가짜) 안 뜸  (d) 고속도로 카메라(가짜: 선 옆 4m, '경로 위' 고침 있는 25m)는 뜸
  async function s120() {
    const t = T(), r = {};
    const REAL = { lat: 37.27451, lng: 127.10331 };
    const cam = t.cams.rows.find((x) => sameCam(x, REAL) && x[2] === 30);
    if (!cam) return { pass: false, detail: 'camera 20526 (신정로 상미사거리 30) not in data' };
    const camI = t.cams.rows.indexOf(cam);
    const L0 = dest(REAL, 270, 28);
    const along = (s) => dest(dest(L0, 0, 2500), 180, s);   // 경로 거리 s 의 선 위 점 (카메라는 s≈2500)
    const P = [];
    for (let k = 0; k <= 200; k++) { const q = along(20 * k); P.push({ lat: round6(q.lat), lng: round6(q.lng) }); }
    const cum = [0];
    for (let i = 1; i < P.length; i++) cum.push(cum[i - 1] + hav(P[i - 1], P[i]));
    const total = cum[cum.length - 1];
    const R = { route: { distance: r0(total), duration: r0(total / 14 * 1000), tollFare: 0, fuelPrice: 0, path: P.map((q) => [q.lng, q.lat]),
      guide: [{ i: 200, t: 88, s: '목적지', d: r0(total), ms: r0(total / 14 * 1000) }],
      sections: [{ i: 0, n: 201, name: '경부고속도로', speed: 50, cong: 2 }] },
      P, cum, total, dest: { name: '경부 시험', addr: '', lat: P[200].lat, lng: P[200].lng } };
    const mk = (p, lim, kind, zone, rtype, on) => { const c = [round6(p.lat), round6(p.lng), lim, kind, 0, 0, zone, -1, rtype, 1]; c.eb = 180; c.e2 = 0; c.lv = 0; c.sl = c[0]; c.sg = c[1]; c.on = on; return c; };
    // 남행이므로 진행 방향 오른쪽은 서쪽(270°)
    const E1 = mk(dest(along(3300), 270, 4), 100, 1, 0, 1, '경부고속도로');    // 선 오른쪽 4m
    const E2 = mk(dest(along(3700), 270, 25), 100, 1, 0, 1, '경부고속도로');   // 25m — '경로 위' 고침이 있어야 잡힘
    const F = mk(dest(along(2900), 270, 10), 30, 3, 2, 5, '신정로');           // 길안내 없을 때 앞길 10m 옆 어린이 30
    const keep = { drv: t.driverSpots.rows.slice(), shared: t.sharedSpots.slice(), mine: t.mySpots.slice(), mineRaw: t.store.get('mySpots'), fixRaw: t.store.get('camFix'), road: t.road.name };
    const fakes = [];
    let base0 = null;
    const key = (c) => c[0] + ',' + c[1];
    const setFix = (c, on) => { if (on) t.camFixes.set(key(c), new Set(['route'])); else t.camFixes.delete(key(c)); t.applyCamFixes(); };
    const drive = async (s0, s1) => {
      await resetApp(); softReset();
      await planAndStart(R);
      t.ensureRouteCams();
      const on = { cam: t.nav.routeCams.has(cam), E1: t.nav.routeCams.has(E1), E2: t.nav.routeCams.has(E2) };
      const seen = { cam: null, E1: null, E2: null, other: new Set() };
      for (let s = s0; s <= s1; s += 14) {
        const q = pointAt(R, s); feed(q.p, 14, q.h, { dt: 1000, acc: 3 });
        const tg = t.camState.target;
        if (!tg) continue;
        if (tg.c === cam) { if (seen.cam === null) seen.cam = Math.round(2500 - s); }
        else if (tg.c === E1) { if (seen.E1 === null) seen.E1 = Math.round(3300 - s); }
        else if (tg.c === E2) { if (seen.E2 === null) seen.E2 = Math.round(3700 - s); }
        else seen.other.add(tg.i + ':' + tg.c[2]);
      }
      return { on, seen: { cam: seen.cam, E1: seen.E1, E2: seen.E2, other: [...seen.other].join(' ') } };
    };
    try {
      t.driverSpots.rows.length = 0; t.sharedSpots.length = 0; t.mySpots.length = 0; t.camFixes.clear();
      t.applyUserSpots(); base0 = t.cams.rows.length;
      for (const c of [E1, E2, F]) { const i = t.cams.rows.length; t.cams.rows.push(c); fakes.push(i); const k = Math.floor(c[0] / 0.01) + ':' + Math.floor(c[1] / 0.01); if (!t.cams.grid.has(k)) t.cams.grid.set(k, []); t.cams.grid.get(k).push(i); }
      t.cams.userBase = null; t.applyUserSpots();
      // (a)·(d) 길안내: 20526 과 E2 에 '경로 위' 고침
      setFix(cam, true); setFix(E2, true);
      r.a = await drive(1500, 3900);
      t.endNav();
      // (b) 고침 없이 지나 '놓침'
      t.camFixes.clear(); t.applyCamFixes();
      await drive(1800, 2620);
      const out = t.fixFromMiss();
      const d0 = (out.diag || []).find((x) => x.cam === camI);
      r.b = { fixed: out.fixed || null, why20526: d0 ? d0.why : 'not listed', fixOnCam: t.camFixes.has(key(cam)), fixes: [...t.camFixes.keys()].length };
      t.endNav();
      // (c)·(d) 길안내 없이 경부 50km/h (지금 도로 이름 경부고속도로)
      t.camFixes.clear(); t.applyCamFixes();
      stub.canned['/reverse'] = { road: '경부고속도로', area: '경기도 용인시 기흥구' };
      let fSeen = null, e1Free = null, camFree = null;
      await resetApp(); softReset();
      for (let s = 1500; s <= 3400; s += 14) {
        t.road.name = '경부고속도로';
        const q = pointAt(R, s); feed(q.p, 14, q.h, { dt: 1000, acc: 3 });
        const tg = t.camState.target;
        if (tg && tg.c === F && fSeen === null) fSeen = Math.round(2900 - s);
        if (tg && tg.c === E1 && e1Free === null) e1Free = Math.round(3300 - s);
        if (tg && tg.c === cam && camFree === null) camFree = Math.round(2500 - s);
      }
      r.c = { school10m: fSeen, cam: camFree, E1: e1Free };
    } finally {
      stub.reset();
      t.road.name = keep.road;
      t.sharedFixes.clear(); t.sharedSpots.length = 0;
      t.driverSpots.rows.length = 0; t.mySpots.length = 0; t.applyUserSpots();
      if (base0 !== null) {
        for (const i of fakes.slice().reverse()) { const c = t.cams.rows[i]; if (!c) continue; const k = Math.floor(c[0] / 0.01) + ':' + Math.floor(c[1] / 0.01); const a2 = t.cams.grid.get(k); if (a2) { const j = a2.indexOf(i); if (j >= 0) a2.splice(j, 1); } t.camMiss.near.delete(i); t.camState.passed.delete(i); t.camState.saidById.delete(i); }
        t.cams.rows.length = base0; t.cams.userBase = null;
      }
      t.camFixes.clear(); t.store.set('camFix', keep.fixRaw);
      keep.drv.forEach((x) => t.driverSpots.rows.push(x)); keep.shared.forEach((x) => t.sharedSpots.push(x)); keep.mine.forEach((x) => t.mySpots.push(x));
      t.store.set('mySpots', keep.mineRaw);
      t.applyUserSpots(); t.applyCamFixes();
      const te = document.getElementById('toast'); if (te) te.hidden = true;
      await resetApp(); softReset();
    }
    const ok = !r.a.on.cam && r.a.seen.cam === null && r.a.on.E1 && r.a.seen.E1 !== null && r.a.on.E2 && r.a.seen.E2 !== null &&
      r.b.why20526 !== 'route' && !r.b.fixOnCam && !(r.b.fixed && r.b.fixed.cam === camI) &&
      r.c.school10m === null && r.c.cam === null && r.c.E1 !== null;
    return { pass: !!ok, detail: JSON.stringify(r) };
  }

  // S122: 네이버 길안내 같은 단속 배지 (v191, 2026-11-23 운전자 '아이콘이나 UI … 네이버지도가 가장 정확해')
  //   남행 곧은 합성 경로에 가짜 카메라 넷(과속 80·신호과속 50·이동식 60·박스형 80)과 운전자 신고 지점 하나를 1km 간격으로 두고 차례로 지나며
  //   카드: 원 안 아이콘(과속·이동식·박스형·신고 지점은 카메라, 신호·과속은 신호등) · 제한속도 · 빨간 거리 띠 · 종류 띠('과속단속' 노랑, '신호과속' 노랑,
  //   '이동식' 흰색, '박스형' 노랑, '신고 지점' 흰색), 이동식·박스형·신고 지점은 파란 테(v114), 보통 경고에는 게이지 없음.
  //   지도 표시: 36px 원 안 위 작은 아이콘(신호·과속은 신호등)
  async function s122() {
    const t = T(), r = {};
    const O = dest(NAV_ORIGIN, 90, 120000);
    const along = (s) => dest(O, 180, s);
    const P = [];
    for (let k = 0; k <= 300; k++) { const q = along(20 * k); P.push({ lat: round6(q.lat), lng: round6(q.lng) }); }
    const cum = [0];
    for (let i = 1; i < P.length; i++) cum.push(cum[i - 1] + hav(P[i - 1], P[i]));
    const total = cum[cum.length - 1];
    const R = { route: { distance: r0(total), duration: r0(total / 22 * 1000), tollFare: 0, fuelPrice: 0, path: P.map((q) => [q.lng, q.lat]),
      guide: [{ i: 300, t: 88, s: '목적지', d: r0(total), ms: r0(total / 22 * 1000) }],
      sections: [{ i: 0, n: 301, name: '배지시험로', speed: 70, cong: 1 }] },
      P, cum, total, dest: { name: '배지 시험', addr: '', lat: P[300].lat, lng: P[300].lng } };
    const mk = (s, lim, kind, flags) => { const q = dest(along(s), 270, 3); const c = [round6(q.lat), round6(q.lng), lim, kind, 0, 0, 0, -1, 4, 1]; if (flags) c.push(flags); c.eb = 180; c.e2 = 0; c.lv = 0; c.sl = c[0]; c.sg = c[1]; c.on = '배지시험로'; return c; };
    const cams = [{ s: 1000, c: mk(1000, 80, 1) }, { s: 2000, c: mk(2000, 50, 3) }, { s: 3000, c: mk(3000, 60, 8) }, { s: 4000, c: mk(4000, 80, 1, 2) }];
    // v192: 구간단속 시작(6000) — 예전 카드 그대로 (운전자 '구간단속은 기존께 더 좋은거 같아')
    const secC = mk(5600, 100, 9); secC[4] = 1; secC[5] = 2000;
    cams.push({ s: 5600, c: secC });
    // v192: AI 아틀라스 표지 그림 칸은 이 시험 동안 비운다 (CSS 그림을 본다). 끝에서 따로 켜 본다
    const keepPicks = {};
    for (const k of Object.keys(t.iconPicks)) if (/^cam_/.test(k)) { keepPicks[k] = t.iconPicks[k]; delete t.iconPicks[k]; }
    const spotP = dest(along(5000), 270, 3);
    const keep = { drv: t.driverSpots.rows.slice(), shared: t.sharedSpots.slice(), mine: t.mySpots.slice() };
    const fakes = [];
    let base0 = null;
    const cardOf = () => {
      const card = document.getElementById('camCard'), sign = card.querySelector('.cam-sign'), ico = card.querySelector('.cam-ico');
      const cs = (el, pseudo) => (el ? getComputedStyle(el, pseudo) : null);
      const bar = card.querySelector('.cam-bar');
      return { limit: text('#camLimit'), type: text('#camType'), typeShown: cs(card.querySelector('.cam-type')).display, kindShown: cs(card.querySelector('.cam-kind')).display,
        ring: cs(sign).borderTopColor, dist: text('#camDist'), bar: cs(bar).display, cardBg: cs(card).backgroundColor };
    };
    try {
      t.driverSpots.rows.length = 0; t.sharedSpots.length = 0; t.mySpots.length = 0;
      t.applyUserSpots(); base0 = t.cams.rows.length;
      for (const x of cams) { const i = t.cams.rows.length; t.cams.rows.push(x.c); fakes.push(i); const k = Math.floor(x.c[0] / 0.01) + ':' + Math.floor(x.c[1] / 0.01); if (!t.cams.grid.has(k)) t.cams.grid.set(k, []); t.cams.grid.get(k).push(i); }
      t.cams.userBase = null;
      t.driverSpots.rows.push([round6(spotP.lat), round6(spotP.lng), 180, 90, 100]);
      t.applyUserSpots();
      const spotRow = t.cams.rows[t.cams.userBase];
      await waitFor(() => t.getMap(), 10000, 100);   // 지도 표시는 지도가 뜬 뒤에 그려진다
      await resetApp(); softReset();
      await planAndStart(R);
      const seen = {};
      const want = [...cams, { s: 5000, c: spotRow }];
      // 보통은 시속 43 (제한 50 아래), 이동식 60 앞뒤만 시속 90 — 제한을 넘으면 빨간 거리 띠가 깜박인다
      for (let s = 0, v = 12; s <= 5650; v = s >= 2550 && s < 3050 ? 25 : 12, s += v) {
        const q = pointAt(R, s); feed(q.p, v, q.h, { dt: 1000 });
        const tg = t.camState.target;
        if (!tg) continue;
        const w = want.find((x) => x.c === tg.c);
        if (w && !seen[w.s] && w.s - s <= 450) {
          await new Promise((res) => requestAnimationFrame(() => res()));
          seen[w.s] = cardOf();
          if (w.s === 3000) { const card = document.getElementById('camCard'); seen[w.s].over = card.classList.contains('over'); seen[w.s].distColor = getComputedStyle(card.querySelector('.cam-dist')).color; }
          if (w.s === 1000) seen[w.s].distColor0 = getComputedStyle(document.querySelector('#camCard .cam-dist')).color;
          if (w.s === 5600) { const card = document.getElementById('camCard'); seen[w.s].seccam = card.classList.contains('seccam'); seen[w.s].aisign = card.classList.contains('aisign'); }
          // 지도 표시 (보이는 것 하나)
          if (w.s === 2000) {
            const m = [...document.querySelectorAll('#map .cammk')].find((el) => el.classList.contains('k3')) || null;
            const mm = [...document.querySelectorAll('#map .cammk')].find((el) => !el.classList.contains('k3')) || null;
            const pb = (el) => (el ? getComputedStyle(el, '::before').backgroundImage : '');
            r.marker = { n: document.querySelectorAll('#map .cammk').length, size: mm ? getComputedStyle(mm).width : '', camIcon: /svg/.test(pb(mm)) && !/ff3b30/.test(pb(mm)), sigIcon: m ? /ff3b30/.test(pb(m)) : null };
          }
        }
      }
      t.endNav();
      r.cards = seen;
      // v192: '안내 시작' 때 목적지가 비어 있어도(2026-11-23 테슬라 오류) 마지막 목적지로 채워 그대로 안내한다
      await resetApp(); softReset();
      stub.canned['/route'] = R.route; feed(R.P[0], 0, null);
      await t.planRoute(R.dest, false);
      t.nav.dest = null;
      let nodestErr = null;
      try { t.startNav(); } catch (e) { nodestErr = String(e); }
      r.nodest = { err: nodestErr, active: !!t.nav.active, name: t.nav.dest ? t.nav.dest.name : null };
      t.endNav();
      // v192: 표지 그림을 고르면 카드·지도 표시가 그 그림(img/ai/…)을 쓰고 숫자만 얹는다
      t.iconPicks.cam_speed = 'cam_speed__test__1.webp';
      const clearMarks = () => { const m = t.getMap(); if (m && m.setCameras) m.setCameras([]); };   // 지도 표시는 카메라마다 한 번 만들어 둔다 — 그림을 바꿨으니 새로
      clearMarks();
      await resetApp(); softReset();
      await planAndStart(R);
      for (let s = 0; s <= 700; s += 20) { const q = pointAt(R, s); feed(q.p, 12, q.h, { dt: 1000 }); }
      await new Promise((res) => requestAnimationFrame(() => res()));
      const card = document.getElementById('camCard'), sg = card.querySelector('.cam-sign');
      const mk1 = [...document.querySelectorAll('#map .cammk')].find((el) => el.textContent === '80' && el.classList.contains('k1'));
      r.ai = { aisign: card.classList.contains('aisign'), img: /img\/ai\/cam_speed__test__1\.webp/.test(sg.style.backgroundImage), border: getComputedStyle(sg).borderTopWidth,
        limit: text('#camLimit'), marker: mk1 ? mk1.classList.contains('ai') && /cam_speed__test__1/.test(mk1.style.backgroundImage) : null,
        numShown: getComputedStyle(document.getElementById('camLimit')).opacity };
      t.endNav();
      // 숫자까지 그린 그림(cam_speed_80)이 있으면 그 그림, 얹은 숫자는 숨김 (글은 남김)
      t.iconPicks.cam_speed_80 = 'cam_speed_80__test__1.webp';
      clearMarks();
      await resetApp(); softReset();
      await planAndStart(R);
      for (let s = 0; s <= 700; s += 20) { const q = pointAt(R, s); feed(q.p, 12, q.h, { dt: 1000 }); }
      await new Promise((res) => requestAnimationFrame(() => res()));
      const mk2 = [...document.querySelectorAll('#map .cammk')].find((el) => el.textContent === '80' && el.classList.contains('k1'));
      r.ainum = { ainum: card.classList.contains('ainum'), img: /cam_speed_80__test__1/.test(sg.style.backgroundImage), numOpacity: getComputedStyle(document.getElementById('camLimit')).opacity,
        limit: text('#camLimit'), marker: mk2 ? mk2.classList.contains('ainum') && /cam_speed_80__test__1/.test(mk2.style.backgroundImage) : null };
      t.endNav();
    } finally {
      delete t.iconPicks.cam_speed; delete t.iconPicks.cam_speed_80;
      Object.assign(t.iconPicks, keepPicks);
      t.driverSpots.rows.length = 0; t.mySpots.length = 0; t.sharedSpots.length = 0; t.applyUserSpots();
      if (base0 !== null) {
        for (const i of fakes.slice().reverse()) { const c = t.cams.rows[i]; if (!c) continue; const k = Math.floor(c[0] / 0.01) + ':' + Math.floor(c[1] / 0.01); const a2 = t.cams.grid.get(k); if (a2) { const j = a2.indexOf(i); if (j >= 0) a2.splice(j, 1); } t.camMiss.near.delete(i); t.camState.passed.delete(i); t.camState.saidById.delete(i); }
        t.cams.rows.length = base0; t.cams.userBase = null;
      }
      keep.drv.forEach((x) => t.driverSpots.rows.push(x)); keep.shared.forEach((x) => t.sharedSpots.push(x)); keep.mine.forEach((x) => t.mySpots.push(x));
      t.applyUserSpots();
      await resetApp(); softReset();
    }
    const BLUE = 'rgb(41, 121, 255)';
    const c = r.cards || {};
    // 원래 카드 (운전자 '원래 우리 스타일대로 해 줘'): 긴 종류 이름 글·거리 글·게이지, 종류 띠 없음, 카드 바탕 없음. 표지 테는 원래 색(빨강·이동식 파랑)
    const RED0 = 'rgb(229, 57, 53)';
    const chk = (k, type, ring, limit) => !!c[k] && c[k].type === type && c[k].typeShown !== 'none' && c[k].kindShown === 'none' && c[k].ring === ring && c[k].limit === limit &&
      c[k].bar === 'block' && /^\d+m$/.test(c[k].dist) && c[k].cardBg === 'rgba(0, 0, 0, 0)';
    const ok = chk(1000, '과속단속', RED0, '80') && chk(2000, '신호·과속단속', RED0, '50') &&
      chk(3000, '이동식단속', BLUE, '60') && chk(4000, '박스형 과속단속', BLUE, '80') && chk(5000, '운전자 신고 단속 지점', BLUE, '100') &&
      !!c[3000] && c[3000].over === true && c[3000].distColor !== c[1000].distColor0 &&
      !!c[5600] && c[5600].seccam === true && c[5600].aisign === false && c[5600].type === '구간단속 시작' &&
      !!r.ai && r.ai.aisign && r.ai.img && r.ai.border === '0px' && r.ai.limit === '80' && r.ai.marker === true &&
      !!r.nodest && r.nodest.err === null && r.nodest.active && r.nodest.name === '배지 시험' &&
      r.ai.numShown === '1' && !!r.ainum && r.ainum.ainum && r.ainum.img && r.ainum.numOpacity === '0' && r.ainum.limit === '80' && r.ainum.marker === true &&
      !!r.marker && r.marker.size === '36px' && r.marker.camIcon && r.marker.sigIcon === true;
    return { pass: !!ok, detail: JSON.stringify(r) };
  }

  // S123: 낮 터널은 한 번에 어둡게 · 밤에 하얀 번쩍임 없음 (v193, 운전자 'GL 모드에서 터널에 들어가 다크 모드로 바뀔 때 너무 느리게 탁 탁 탁 …
  //       한번에 딱 바뀌었으면', '가끔 주행 중 화면이 하얀색으로 번쩍')
  //   (a) 지금 해가 떠 있는 곳(경도를 골라)에서 터널 어둡게(tnDark): GL 이면 지도 종류는 낮(normal) 그대로, #map.tndark 로 캔버스만 뒤집고
  //       경로선은 낮 팔레트, 화면(카드)은 밤 색. 터널을 나오면 같은 자리에서 바로 풀린다. GL 이 아니면 예전처럼 밤 스타일
  //   (b) 밤(늘 어둡게): 밤 지도 스타일, 뒤집기 없음, 지도 칸 바탕은 어두운 색(예전엔 밝은 rgb(248,249,250) 이 비쳤다)
  async function s123() {
    const t = T(), r = {};
    await waitFor(() => t.getMap() && document.querySelector('#map .mapcanvas'), 10000, 100);   // 지도가 뜬 뒤에
    if (t.glOn && t.glOn()) await waitFor(() => t.getMap().darkReady, 10000, 100);
    const a = t.getMap(), host = document.querySelector('#map .mapcanvas');
    const keep = { mode: t.store.get('nightMode'), fix: t.state.fix, on: t.tnDark.on, at: t.tnDark.at, outAt: t.tnDark.outAt };
    // 지금 해가 높이 떠 있는 경도 (위도 0)
    let day = null;
    for (let lng = -180; lng < 180; lng += 15) { if (t.sunElevation(new Date(), 0, lng) > 20) { day = { lat: 0, lng }; break; } }
    const look = () => {
      const cv = document.querySelector('#map canvas.mapboxgl-canvas');
      return { night: !!t.state.night, tndark: document.getElementById('map').classList.contains('tndark'), mapDark: t.mapNight(), gl: !!(a && a.gl),
        type: a && a.map && a.map.getMapTypeId ? a.map.getMapTypeId() : '', filter: cv ? getComputedStyle(cv).filter : 'no-canvas', hostBg: host ? getComputedStyle(host).backgroundColor : '',
        pal: t.trafficColor({ cong: 1, name: '' }) };
    };
    try {
      t.store.set('nightMode', null);   // 자동
      if (!day) return { pass: false, detail: 'no daylight longitude found' };
      t.state.fix = Object.assign({}, t.state.fix || {}, { lat: day.lat, lng: day.lng, t: Date.now(), acc: 5 });
      t.tnDark.on = false; t.applyNight();
      r.dayBefore = look();
      t.tnDark.on = true; t.tnDark.at = Date.now(); t.applyNight();   // 터널 안
      r.tunnel = look();
      t.tnDark.on = false; t.applyNight();                               // 터널 밖
      r.after = look();
      t.store.set('nightMode', 'on'); t.applyNight();                     // 밤
      r.night = look();
    } finally {
      t.store.set('nightMode', keep.mode);
      t.state.fix = keep.fix; t.tnDark.on = keep.on; t.tnDark.at = keep.at; t.tnDark.outAt = keep.outAt;
      t.applyNight();
    }
    const DAYPAL = '#27c441';
    const gl = r.tunnel.gl;
    const tunnelOk = gl
      ? r.tunnel.night && r.tunnel.tndark && !r.tunnel.mapDark && r.tunnel.type === 'normal' && /invert/.test(r.tunnel.filter) && r.tunnel.pal === DAYPAL
      : r.tunnel.night && !r.tunnel.tndark && r.tunnel.mapDark;
    const ok = !r.dayBefore.night && !r.dayBefore.tndark && tunnelOk &&
      !r.after.night && !r.after.tndark && !/invert/.test(r.after.filter) && (!gl || r.after.type === 'normal') &&
      r.night.night && !r.night.tndark && r.night.mapDark && r.night.hostBg === 'rgb(28, 30, 34)' && (!gl || r.night.type === 'tncdark' || !a.darkReady);
    return { pass: !!ok, detail: JSON.stringify(r) };
  }

  // S124: 네이버 길안내로 확인한 자리 (v194, 운전자 '네이버지도 과속단속을 나는 제일 신뢰하니까 저걸 기반으로 넣어줘')
  //   (a) 설치장소 'A→B' 가 안내 문구로 내 방향이어도 카메라가 경로를 가로지르는 방향(77°)이면 경로 위가 아님 (둔촌사거리 25557 틀림)
  //       — 같은 방향(0°)·반대로 적힌 방향(180°)은 예전처럼 글이 가른다(하남 창우로 J2735)
  //   (b) 운전자 지점 종류: 신호·과속(6째 값 3)은 '운전자 신고 신호·과속단속', 후면단속(7째 값 1)은 '운전자 신고 후면단속'이고 지난 뒤 '후면단속 중'
  async function s124() {
    const t = T(), r = {};
    const O = dest(NAV_ORIGIN, 90, 160000);
    const along = (s) => dest(O, 180, s);
    const P = [];
    for (let k = 0; k <= 130; k++) { const q = along(20 * k); P.push({ lat: round6(q.lat), lng: round6(q.lng) }); }
    const cum = [0];
    for (let i = 1; i < P.length; i++) cum.push(cum[i - 1] + hav(P[i - 1], P[i]));
    const total = cum[cum.length - 1];
    const R = { route: { distance: r0(total), duration: r0(total / 20 * 1000), tollFare: 0, fuelPrice: 0, path: P.map((q) => [q.lng, q.lat]),
      guide: [{ i: 70, t: 1, s: "시험교차로에서 '시험역' 방면으로 직진", d: r0(cum[70]), ms: r0(cum[70] / 20 * 1000) }, { i: 130, t: 88, s: '목적지', d: r0(total), ms: r0(total / 20 * 1000) }],
      sections: [{ i: 0, n: 131, name: '시험로', speed: 60, cong: 1 }] },
      P, cum, total, dest: { name: '시험 목적지', addr: '', lat: P[130].lat, lng: P[130].lng } };
    const q0 = dest(along(1000), 270, 3);
    const X = [round6(q0.lat), round6(q0.lng), 50, 3, 0, 0, 0, -1, 5, 1]; X.e2 = 0; X.lv = 0; X.sl = X[0]; X.sg = X[1]; X.on = '시험로';
    const keep = { drv: t.driverSpots.rows.slice(), shared: t.sharedSpots.slice(), mine: t.mySpots.slice() };
    let base0 = null, fakeI = -1;
    try {
      t.driverSpots.rows.length = 0; t.sharedSpots.length = 0; t.mySpots.length = 0; t.applyUserSpots();
      base0 = t.cams.rows.length; fakeI = base0; t.cams.rows.push(X);
      const gk = Math.floor(X[0] / 0.01) + ':' + Math.floor(X[1] / 0.01); if (!t.cams.grid.has(gk)) t.cams.grid.set(gk, []); t.cams.grid.get(gk).push(fakeI);
      t.cams.arrows.set(X, ['시험출발', '시험역']);
      t.cams.userBase = null; t.applyUserSpots();
      const on = async (eb) => { X.eb = eb; await resetApp(); softReset(); await planAndStart(R); t.ensureRouteCams(); const v = !!(t.nav.routeCams && t.nav.routeCams.has(X)); t.endNav(); return v; };
      r.arrow = { cross77: await on(257), along: await on(180), opposite: await on(0) };
      // (b) 운전자 지점: 신호·과속 50 (1600m), 후면단속 80 (2000m)
      const s1 = dest(along(1600), 270, 3), s2 = dest(along(2000), 270, 3);
      t.driverSpots.rows.push([round6(s1.lat), round6(s1.lng), 180, 60, 50, 3], [round6(s2.lat), round6(s2.lng), 180, 79, 80, 1, 1]);
      t.applyUserSpots();
      const u = t.cams.rows.slice(t.cams.userBase);
      r.rows = u.map((c) => c[3] + '/' + (c[10] | 0) + '/' + c[2]);
      await resetApp(); softReset(); await planAndStart(R);
      const seen = {};
      for (let s = 1100; s <= 2040; s += 10) {
        const q = pointAt(R, s); feed(q.p, 15, q.h, { dt: 700 });
        const tg = t.camState.target; if (!tg) continue;
        const k = tg.c === u[0] ? 'sig' : tg.c === u[1] ? 'rear' : null; if (!k) continue;
        const lb = text('#camType'), dist = text('#camDist');
        if (!seen[k]) seen[k] = { label: lb, limit: text('#camLimit') };
        if (k === 'rear' && s > 2010) seen.rearAfter = dist;
      }
      t.endNav();
      r.spots = seen;
    } finally {
      t.driverSpots.rows.length = 0; t.mySpots.length = 0; t.sharedSpots.length = 0; t.applyUserSpots();
      if (fakeI >= 0) {
        t.cams.arrows.delete(X);
        const gk = Math.floor(X[0] / 0.01) + ':' + Math.floor(X[1] / 0.01), a2 = t.cams.grid.get(gk); if (a2) { const j = a2.indexOf(fakeI); if (j >= 0) a2.splice(j, 1); }
        t.camState.passed.delete(fakeI); t.camMiss.near.delete(fakeI); t.camState.saidById.delete(fakeI);
        t.cams.rows.length = base0; t.cams.userBase = null;
      }
      keep.drv.forEach((x) => t.driverSpots.rows.push(x)); keep.shared.forEach((x) => t.sharedSpots.push(x)); keep.mine.forEach((x) => t.mySpots.push(x));
      t.applyUserSpots();
      await resetApp(); softReset();
    }
    const sp = r.spots || {};
    const ok = r.arrow.cross77 === false && r.arrow.along === true && r.arrow.opposite === true &&
      r.rows[0] === '3/4/50' && r.rows[1] === '1/5/80' &&
      !!sp.sig && sp.sig.label === '운전자 신고 신호·과속단속' && sp.sig.limit === '50' &&
      !!sp.rear && sp.rear.label === '운전자 신고 후면단속' && sp.rear.limit === '80' && sp.rearAfter === '후면단속 중';
    return { pass: !!ok, detail: JSON.stringify(r) };
  }

  // S125: 길안내 중 다른 경로 말풍선 (v195, 운전자 '가능하면 이런 기능도 있으면 좋을거 같긴 해' — 네이버 길안내의 '3분 증가 · 874m 증가 · 통행료 없음')
  //   남행 곧은 지금 경로(통행료 1,200원)와, 1,200m 에서 동쪽으로 갈라졌다가 2,600m 에서 다시 만나는 다른 경로(3분 더, 통행료 없음)를
  //   교통 갱신(옵션 여럿 한 요청)이 함께 준다. (a) 지금 경로는 그대로, 말풍선 '3분 증가 · …m 증가 · 통행료 없음' + 연한 선
  //   (b) 말풍선을 누르면 그 경로로 바뀐다 (c) 누르지 않고 갈라지는 곳을 지나면 사라진다
  //   (d) 2026-11-24 keys 세션: 남쪽으로 갈 때 말풍선이 180° 뒤집혀 보였다(그림·Leaflet 지도는 지도 칸째 돌림). 남행(a)·서행(d) 모두
  //       말풍선이 꼬리(갈림 200m 뒤 점) 위에 똑바로 선다 — 상자 밑이 꼬리보다 위, 가운데가 꼬리와 같은 x
  async function s125() {
    const t = T(), r = {};
    const O = dest(NAV_ORIGIN, 90, 200000);
    const mkRoute = (pts, opt, extraMs, toll) => {
      const P = pts.map((q) => ({ lat: round6(q.lat), lng: round6(q.lng) }));
      let d = 0; for (let i = 1; i < P.length; i++) d += hav(P[i - 1], P[i]);
      return { option: opt, distance: r0(d), duration: r0(d / 16 * 1000 + (extraMs || 0)), tollFare: toll || 0, fuelPrice: 0, path: P.map((q) => [q.lng, q.lat]),
        guide: [{ i: P.length - 1, t: 88, s: '목적지', d: r0(d), ms: r0(d / 16 * 1000) }], sections: [{ i: 0, n: P.length, name: '시험로', speed: 60, cong: 1 }] };
    };
    // 진행 방향 h 로 곧은 지금 경로와, 1,200m 에서 왼쪽(h-90)으로 갈라졌다 2,600m 에서 만나는 다른 경로
    const build = (h) => {
      const S = (s, side) => dest(dest(O, h, s), h - 90, side || 0);
      const mainPts = []; for (let s = 0; s <= 4000; s += 20) mainPts.push(S(s));
      const altPts = [];
      for (let s = 0; s <= 1200; s += 20) altPts.push(S(s));
      for (let s = 1240; s <= 2560; s += 40) altPts.push(S(s, s < 1300 || s > 2500 ? 40 : 90));
      for (let s = 2600; s <= 4000; s += 20) altPts.push(S(s));
      const MAIN = mkRoute(mainPts, 'traoptimal', 0, 1200);
      const ALT = mkRoute(altPts, 'trafast', 180000, 0);
      ALT.sections = [{ i: 0, n: 60, name: '시험로', speed: 60, cong: 1 }, { i: 60, n: 20, name: '옆길', speed: 20, cong: 2 }, { i: 80, n: altPts.length - 80, name: '시험로', speed: 60, cong: 1 }];
      const P = mainPts.map((q) => ({ lat: round6(q.lat), lng: round6(q.lng) }));
      const cum = [0]; for (let i = 1; i < P.length; i++) cum.push(cum[i - 1] + hav(P[i - 1], P[i]));
      return { MAIN, ALT, R: { route: MAIN, P, cum, total: cum[cum.length - 1], dest: { name: '갈림 시험', addr: '', lat: P[P.length - 1].lat, lng: P[P.length - 1].lng } } };
    };
    const { MAIN, ALT, R } = build(180);
    const W = build(270);
    const drive = (s0, s1, RR) => { for (let s = s0; s <= s1; s += 16) { const q = pointAt(RR || R, s); feed(q.p, 16, q.h); } };
    const bub = () => document.querySelector('#map .altbub');
    // 말풍선이 꼬리 위에 똑바로 섰는가 (화면 기준). 그림·Leaflet 지도는 uprt 로 지도 회전을 되돌린다
    // (그림 지도는 표지를 다음 그리기 때 붙이므로 상자가 화면에 잡힐 때까지 기다린다)
    const upright = async () => {
      await waitFor(() => { const i = bub() && bub().querySelector('.ab-in'); return !!i && i.getBoundingClientRect().height > 0; }, 3000, 50).catch(() => null);
      const b = bub(), i = b && b.querySelector('.ab-in');
      if (!i) return null;
      // 지도 칸 회전은 0.9초에 걸쳐 돈다: 다 돈 뒤의 모습으로 잰다 (앱의 snap = 애니메이션 없이 바로)
      const host = $('#map'), had = host.classList.contains('snap');
      host.classList.add('snap'); void host.offsetWidth;
      const a = b.getBoundingClientRect(), q = i.getBoundingClientRect();
      if (!had) host.classList.remove('snap');
      return { above: q.bottom <= a.y + 2 && q.top < a.y, centred: Math.abs((q.left + q.right) / 2 - a.x) < 4, gl: !!(t.getMap() && t.getMap().gl),
        tr: getComputedStyle(b).transform, rot: $('#map').style.getPropertyValue('--rot') };
    };
    try {
      await waitFor(() => t.getMap(), 10000, 100);   // 선·말풍선은 지도가 뜬 뒤에 그려진다
      await resetApp(); softReset();
      await planAndStart(R);
      drive(0, 300);
      // 교통 갱신: 옵션 여럿을 한 번에 → 지금 옵션(추천)과 다른 경로(빠른 길)
      let q = null;
      stub.canned['/route'] = (query) => { q = query; return { alternatives: [MAIN, ALT] }; };
      await t.planRoute(t.nav.dest, 'traffic');
      const b = bub();
      const isR = (x, R0) => !!x && x.option === R0.option && x.distance === R0.distance;   // 서버 답은 JSON 으로 복사돼 오므로 옵션·거리로 본다
      r.a = { options: q && q.options, kept: isR(t.nav.route, MAIN), offered: isR(t.sideAlt.r, ALT), at: Math.round(t.sideAlt.at), text: b ? b.textContent : null,
        bar: b ? b.querySelectorAll('.ab-bar i').length : 0, line: !!(t.getMap() && t.getMap().sideLine), up: await upright() };
      // (b) 누르면 그 경로로
      if (b) b.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      r.b = { route: isR(t.nav.route, ALT), option: t.nav.option, bubble: !!bub(), line: !!(t.getMap() && t.getMap().sideLine) };
      t.endNav();
      // (c) 누르지 않고 갈라지는 곳을 지나면 사라진다
      await resetApp(); softReset();
      stub.canned['/route'] = MAIN;
      await planAndStart(R);
      drive(0, 300);
      stub.canned['/route'] = () => ({ alternatives: [MAIN, ALT] });
      await t.planRoute(t.nav.dest, 'traffic');
      const before = !!bub();
      drive(316, 1300);
      r.c = { before, after: !!bub(), route: isR(t.nav.route, MAIN) };
      t.endNav();
      // (d) 서쪽으로
      await resetApp(); softReset();
      stub.canned['/route'] = W.MAIN;
      await planAndStart(W.R);
      drive(0, 300, W.R);
      stub.canned['/route'] = () => ({ alternatives: [W.MAIN, W.ALT] });
      await t.planRoute(t.nav.dest, 'traffic');
      r.d = { offered: isR(t.sideAlt.r, W.ALT), up: await upright() };
      t.endNav();
    } finally {
      stub.reset();
      await resetApp(); softReset();
    }
    const ok = r.a.options === 'traoptimal:trafast:traavoidtoll' && r.a.kept && r.a.offered && Math.abs(r.a.at - 1200) <= 60 && r.a.line &&
      /3분 증가/.test(r.a.text || '') && /m 증가/.test(r.a.text || '') && /통행료 없음/.test(r.a.text || '') && r.a.bar >= 2 &&
      r.b.route && r.b.option === 'trafast' && !r.b.bubble && !r.b.line &&
      r.c.before && !r.c.after && r.c.route &&
      r.a.up && r.a.up.above && r.a.up.centred && r.d.offered && r.d.up && r.d.up.above && r.d.up.centred;
    return { pass: !!ok, detail: JSON.stringify(r) };
  }

  // S126: (v196, 운전자 '앞으로 우리 테슬라클러스터 네비 이용자들 지나간곳 모조리 체크해서 과속 단속 체크해줘 신고를 하지 않았더라도 내역도 남겨놓고')
  //       카메라를 지날 때마다 익명 통과 기록 — 경고함·놓침·반대 방향은 안 셈·제한 모름 숨김, 보내는 묶음에 위치·sid 없음,
  //       자료에 없는 감속 후보(격자·방위·감속 폭), 운영자 차는 궤적, 설정에서 끄면 기록 없음
  async function s126() {
    const t = T(), r = {}, ps = t.passStats;
    const CAM = { lat: 37.44165, lng: 126.8467 };   // 광명로 60 신호·과속 남행 (S68, 23339)
    const keep = { post: ps.post, pref: t.prefs.passStats, tok: t.store.get('adminToken'), q: t.store.get('passQ'), road: t.road.name };
    const bodies = [];
    const pick = (k) => ps.q.filter((x) => x.k === k).map((x) => ({ a: x.a, g: x.g, hid: x.hid, kmh: x.kmh, lim: x.lim }));
    // 경고 판정 없이 카메라 옆을 바로 지나가게 한다 (passTick 만): 북쪽 150m 에서 남쪽 120m 까지, 또는 그 반대로
    const direct = (north) => {
      ps.near.clear(); ps.shown.clear();
      t.camState.target = null; t.camState.passed.clear(); t.camState.saidById.clear();
      t.road.name = ''; t.state.speedKmh = 62; t.state.heading = north ? 0 : 180;
      const top = dest(CAM, 0, 150);
      let tt = Date.now();
      for (let s = 0; s <= 270; s += 10) { tt += 600; const p = dest(top, 180, north ? 270 - s : s); t.passTick({ lat: p.lat, lng: p.lng, t: tt }); }
    };
    let row = null;
    try {
      ps.inTest = true;
      ps.post = async (b) => { bodies.push(JSON.parse(JSON.stringify(b))); return { ok: true, status: 200 }; };
      t.store.set('adminToken', null); t.prefs.passStats = true; t.passClear();
      row = t.cams.rows.find((c) => sameCam(c, CAM));
      const key = row ? t.passKey(row) : null;
      r.key = key;
      // (a) 길안내 없이 남쪽으로 시속 60km: 경고 카드를 띄우고 지남 (앞 시험이 남긴 도로 이름은 지운다: 다른 길이면 세지 않으므로)
      await resetApp(); softReset();
      t.road.name = '';
      const A0 = dest(CAM, 0, 600);
      for (let s = 0; s <= 760; s += 17) feed(dest(A0, 180, s), 16.7, 180);
      r.a = pick(key);
      // (b) 경고 없이 같은 방향으로 지남 = 놓침, (c) 반대 방향은 안 셈, (d) 제한속도를 모르면 '숨김'
      ps.q.length = 0;
      direct(false); r.b = pick(key);
      ps.q.length = 0;
      direct(true); r.c = pick(key);
      ps.q.length = 0;
      const lim0 = row[2]; row[2] = 0;
      try { direct(false); } finally { row[2] = lim0; }
      r.d = pick(key);
      // (e) 보내는 묶음: 정해진 칸뿐, 위치·sid·기기 없음(v235: 시각 t 는 분 단위로 뭉개서), 받으면 함이 빈다
      ps.q.length = 0;
      direct(false);
      ps.nextAt = 0;
      const sent = await t.passFlush(true);
      const b = bodies[bodies.length - 1] || {};
      const okKeys = (o, allow) => Object.keys(o).every((k) => allow.includes(k));
      r.e = { sent, body: Object.keys(b).sort().join(','), items: (b.items || []).length,
        itemKeys: (b.items || []).every((x) => okKeys(x, ['k', 'd', 't', 'lim', 'kind', 'a', 'g', 'hid', 'kmh', 'nav', 'x'])),
        tMin: (b.items || []).length > 0 && (b.items || []).every((x) => Number.isFinite(x.t) && x.t % 60000 === 0),
        synth: (b.items || []).length > 0 && (b.items || []).every((x) => x.x === 1),   // v219: 시험 페이지에서 만든 기록은 x: 1 (서버가 버린다)
        kmh5: (b.items || []).every((x) => x.kmh % 5 === 0), noSid: !/"(sid|dev|lat|lng|trace|rid)"/.test(JSON.stringify(b)), left: ps.q.length, stored: t.store.get('passQ') };
      // (f) 자료에 없는 감속: 시속 90 → 60 → 90 (곧은 길, 400m 안 카메라 없음) 이면 후보 1, 막힘처럼 시속 18까지 줄면 아님
      const O = dest(NAV_ORIGIN, 90, 80000);
      const prof = [];
      for (let k = 0; k < 20; k++) prof.push(25);
      [23.3, 21.7, 20, 18.3, 16.7, 16.7, 16.7, 17.7, 18.7, 19.7, 20.7, 21.7, 22.7, 23.7, 25, 25, 25, 25, 25].forEach((v) => prof.push(v));
      const drive = async (vs, at) => {
        await resetApp(); softReset();
        ps.cand.length = 0; ps.sp.length = 0; ps.lastCandOdo = -1e9;
        let p = at; const pts = [];
        for (const v of vs) { p = dest(p, 0, v); pts.push(p); feed(p, v, 0); }
        return pts;
      };
      const pts = await drive(prof, O);
      const cells = [25, 26].map((k) => Math.round(pts[k].lat * 1000) + ',' + Math.round(pts[k].lng * 1000));
      r.f = { cand: ps.cand.map((x) => ({ c: x.c, o: x.o, dr: x.dr })), cells };
      const jam = prof.map((v) => (v < 25 ? Math.max(5, v - 12) : v));
      await drive(jam, dest(O, 0, 3000));
      r.f.jam = ps.cand.length;
      ps.cand.length = 0;
      // (g) 운영자 차(토큰): 놓친 곳은 카메라 자리·궤적까지
      t.store.set('adminToken', 'T'.repeat(24));
      ps.q.length = 0; ps.op.length = 0; ps.opTr = 0;
      direct(false);
      const op = ps.op.find((x) => x.k === key);
      ps.nextAt = 0;
      await t.passFlush(true);
      const bo = bodies[bodies.length - 1] || {};
      r.g = { op: op ? { miss: op.miss, lat: op.lat, trace: Array.isArray(op.trace) ? op.trace.length : 0, minD: op.minD } : 'none',
        sentOp: (bo.op || []).length, pubLat: (bo.items || []).some((x) => 'lat' in x || 'trace' in x) };
      t.store.set('adminToken', null);
      // (h) 설정에서 끄면 함을 비우고 더 기록하지 않는다
      const cb = document.getElementById('optPassStats');
      ps.q.length = 0; direct(false);
      cb.checked = false; cb.onchange({ target: cb });
      const offNow = { pref: t.prefs.passStats, stored: t.store.get('passStats'), left: ps.q.length };
      direct(false);
      r.h = Object.assign(offNow, { after: ps.q.length, label: cb.closest('label') ? cb.closest('label').textContent.trim() : '' });
      cb.checked = true; cb.onchange({ target: cb });
      r.h.back = t.prefs.passStats && t.store.get('passStats') == null;
    } finally {
      ps.post = keep.post; ps.inTest = false; t.prefs.passStats = keep.pref;
      t.store.set('adminToken', keep.tok); t.passClear(); t.store.set('passQ', keep.q); t.road.name = keep.road;
      await resetApp(); softReset();
    }
    const one = (a) => Array.isArray(a) && a.length === 1 ? a[0] : null;
    const A = one(r.a), B = one(r.b), D = one(r.d), F = one(r.f.cand);
    const ok = !!r.key && A && A.a >= 100 && A.g === 0 && A.hid === 0 && A.kmh === 60 && A.lim === 60 &&
      B && B.a === 0 && B.g === 0 && B.hid === 0 && B.kmh === 60 &&
      r.c.length === 0 && D && D.hid === 1 && D.a === 0 &&
      r.e.sent === true && r.e.body === 'cand,items,v' && r.e.items >= 1 && r.e.itemKeys && r.e.tMin && r.e.synth && r.e.kmh5 && r.e.noSid && r.e.left === 0 && r.e.stored == null &&
      F && F.dr === 30 && F.o === 0 && r.f.cells.includes(F.c) && r.f.jam === 0 &&
      r.g.op !== 'none' && r.g.op.miss === 1 && r.g.op.lat === CAM.lat && r.g.op.trace > 0 && r.g.sentOp >= 1 && !r.g.pubLat &&
      r.h.pref === false && r.h.stored === '0' && r.h.left === 0 && r.h.after === 0 && /통계/.test(r.h.label) && r.h.back;
    return { pass: !!ok, detail: JSON.stringify(r) };
  }

  // S130: 네이버식 분기점 장면 (v197, 운전자가 네이버 경부 하행 신갈JC '571m 대전' 확대 그림을 보내며 '이런거 참고해주고 적용해줘',
  //       '우리 방식 대로 AI이미지 활용을 해서', 유도선은 '글씨로 보여주는것보다 그림이 훨씬'). 북쪽으로 곧은 3km 경부고속도로, 1.5km 신갈분기점.
  //   (a) '원주, 인천' 오른쪽 방향 + 분기 단면(SB|S|S|S|R|R, 경로는 R 갈래) + 분홍 유도선: 600m 앞 그림이 6차로, 5·6차로를 분홍으로 칠함(네이버처럼), 버스 차선 파랑,
  //       표지판 둘(오른쪽 '[50] 원주 인천 ↗', 왼쪽 경부 '[1] ↑'), 차로 칸·유도선 줄은 숨김 (그림에 있으니)
  //   (b) 같은 곳, 자료 없음: 갈림길 2 + 2, 오른쪽 둘 칠함, 다른 갈래 표지는 모르니 없음
  //   (c) '서울' 본선 그대로(왼쪽 도로 주행) + 단면(경로는 본선): 본선 2·3·4차로 칠함(버스 칸 빼고), 왼쪽 '[1] 서울 ↑' 하나
  //   (d) 밤에는 칠한 차로가 밤 색, AI 풍경이 밤 그림   (e) 그림을 끄면(설정) 유도선은 줄로 — 글자 없이 작은 도로 그림 + 오른쪽
  async function s130() {
    const t = T(), r = {}, prevJ = t.prefs.junction;
    const raw = [];
    for (let k = 0; k <= 30; k++) raw.push(dest(NAV_ORIGIN, 0, 100 * k));
    const path = raw.map((p) => [round6(p.lng), round6(p.lat)]);
    const P = path.map((x) => ({ lat: x[1], lng: x[0] }));
    const cum = [0];
    for (let i = 1; i < P.length; i++) cum.push(cum[i - 1] + hav(P[i - 1], P[i]));
    const total = cum[cum.length - 1];
    const mkR = (g) => ({
      route: { distance: r0(total), duration: r0(total / 25 * 1000), tollFare: 0, fuelPrice: 300, path,
        guide: [Object.assign({ i: 15, d: r0(cum[15]), ms: 60000 }, g), { i: 30, t: 88, s: '목적지', d: r0(total - cum[15]), ms: 60000 }],
        sections: g.t === 41 ? [{ i: 0, n: 31, name: '경부고속도로', speed: 80, cong: 1 }]   // 본선 그대로: 한 구간이 안내 지점을 지나 이어짐 (mainKeep)
          : [{ i: 0, n: 16, name: '경부고속도로', speed: 80, cong: 1 }, { i: 15, n: 16, name: '영동고속도로', speed: 80, cong: 1 }] },
      P, cum, total, dest: { name: '분기점 장면', addr: '', lat: P[30].lat, lng: P[30].lng } });
    const EXIT = mkR({ t: 5, s: "신갈분기점에서 '원주, 인천' 방면으로 오른쪽 방향" });
    const MAIN = mkR({ t: 41, s: "신갈분기점에서 '서울' 방면으로 왼쪽 도로 주행" });
    const on = dest(NAV_ORIGIN, 0, 2000), off = dest(dest(NAV_ORIGIN, 0, 1700), 270, 300), sec = dest(NAV_ORIGIN, 0, 1350);
    const forks = (toExit) => ({ rows: [[sec.lat, sec.lng, 0, 'SB|S|S|S|R|R', [[0], [0], [0], [0], [1], [1]]]],
      ends: (toExit ? [off, on] : [on, off]).map((p) => [p.lat, p.lng]) });
    const cls = (c) => { const a = dest(NAV_ORIGIN, 0, 1450), b = dest(NAV_ORIGIN, 0, 1900);
      return { v: 1, rows: [[a.lat, a.lng, 0, [[c, b.lat, b.lng], [c === 'p' ? 'g' : 'p', off.lat, off.lng]], '신갈분기점']] }; };
    const go = (R, s) => { const a = pointAt(R, s); feed(a.p, 25, a.h); t.renderNav(); };
    const snap = () => {
      const el = document.getElementById('juncCard'), sv = el.querySelector('#juncSvg svg.nv'), l1 = document.getElementById('juncLabel'), l2 = document.getElementById('juncLabel2');
      const cl = sv && sv.querySelector('.nv-cl'), goP = sv && sv.querySelector('.nv-go'), bg = el.querySelector('#juncSvg img.nv-bg.jv-night');
      return { shown: visible('#juncCard'), nv: el.classList.contains('nv'), kind: sv ? sv.getAttribute('class').replace(/^nv /, '').replace(/ nv-data/, '') : '', data: !!(sv && sv.classList.contains('nv-data')),
        lanes: sv ? sv.dataset.lanes : '', go: sv ? sv.dataset.go : '', bus: !!(sv && sv.querySelector('.nv-bus')), cl: cl ? cl.style.fill : '',
        sign1: text('#juncLabel'), side1: /\bsr\b/.test(l1.className) ? 'r' : /\bsl\b/.test(l1.className) ? 'l' : '', straight1: !!l1.querySelector('.sg-arrow path[d^="M12 28V10"]'),
        sign2: visible('#juncLabel2') ? text('#juncLabel2') : '', side2: /\bsr\b/.test(l2.className) ? 'r' : /\bsl\b/.test(l2.className) ? 'l' : '', straight2: !!l2.querySelector('.sg-arrow path[d^="M12 28V10"]'),
        goFill: goP ? getComputedStyle(goP).fill : '', bgNight: bg ? getComputedStyle(bg).display : '', place: getComputedStyle(el.querySelector('.jc-head')).display !== 'none',
        laneRow: visible('#laneRow'), colorRow: visible('#colorRow') };
    };
    try {
      // (a)
      t.setForkData(forks(true)); t.setColorLines(cls('p'));
      softReset();
      await planAndStart(EXIT);
      for (let s = 20; s <= 900; s += 20) go(EXIT, s);
      r.a = snap();
      for (let s = 920; s <= 1620; s += 20) go(EXIT, s);
      r.aPast = { shown: visible('#juncCard'), laneRow: visible('#laneRow') };
      t.endNav();
      // (b)
      t.setForkData(null); t.setColorLines(null);
      softReset();
      await planAndStart(EXIT);
      for (let s = 20; s <= 900; s += 20) go(EXIT, s);
      r.b = snap();
      t.endNav();
      // (c)
      t.setForkData(forks(false));
      softReset();
      await planAndStart(MAIN);
      for (let s = 20; s <= 900; s += 20) go(MAIN, s);
      r.c = snap();
      // (d) 밤
      t.setNightMode('on');
      r.d = snap();
      t.setNightMode('off');
      r.dDay = snap().goFill;
      t.endNav();
      // (e) 그림 끔 → 유도선 줄
      t.setForkData(null); t.setColorLines(cls('p'));
      t.prefs.junction = false;
      softReset();
      await planAndStart(EXIT);
      for (let s = 20; s <= 700; s += 20) go(EXIT, s);
      const row = document.getElementById('colorRow'), sw = row.querySelector('.cl-sw svg');
      r.e = { shown: visible('#colorRow'), text: text('#colorText'), icon: !!row.querySelector('.cl-sw svg.sp-pic .sp-band') && !row.querySelector('.cli-cl'), side: row.dataset.side || '',
        flip: sw ? getComputedStyle(sw).transform : '', aria: row.getAttribute('aria-label') || '', junc: visible('#juncCard') };
      t.endNav();
    } finally {
      t.prefs.junction = prevJ;
      t.setNightMode('auto');
      t.setForkData(null); await t.loadForks();
      t.setColorLines(null); await t.loadColorLines();
      softReset();
    }
    const a = r.a || {}, b = r.b || {}, c = r.c || {}, d = r.d || {}, e = r.e || {};
    const ok = a.shown && a.nv && a.kind === 'jc-fork' && a.data && a.lanes === '6' && a.go === '5,6' && a.bus && /246, 140, 192/.test(a.cl) &&
      a.sign1 === '50원주인천' && a.side1 === 'r' && !a.straight1 && a.sign2 === '1경부' && a.side2 === 'l' && a.straight2 && !a.place &&
      !a.laneRow && !a.colorRow && r.aPast && !r.aPast.shown &&
      b.shown && b.nv && !b.data && b.lanes === '4' && b.go === '3,4' && !b.cl && b.sign1 === '50원주인천' && b.sign2 === '1경부' /* v207: 갈림길도 다른 갈래 표지 */ &&
      c.shown && c.kind === 'jc-main' && c.data && c.go === '2,3,4' && c.sign1 === '1서울' && c.side1 === 'l' && c.straight1 && c.sign2 === '' && !c.laneRow &&
      d.shown && d.goFill && d.goFill !== r.dDay && d.bgNight === 'block' &&
      e.shown && !e.junc && e.text === '' && e.icon && e.side === 'r' && e.flip === 'none' && /분홍색 유도선 따라가기/.test(e.aria);
    return { pass: !!ok, detail: JSON.stringify(r) };
  }

  // S131: 후진(후방 카메라) 뒤 이어 가기 (v200, 운전자 '직진했다가 후진할때 후방카메라가 켜지는데 브라우저가 꺼져도 세션이 남게해서 유지할수는 없나').
  //       /events 로 보면 테슬라는 그때 페이지를 새로 연다(새 sid, 80초 남짓 간격, 속도 0) → 길안내 상태를 localStorage 에 남겨 이어 간다.
  //   (a) 안내 중 600m · 구간단속 1.5km 간 상태 · 손으로 바꾼 배율 15 → 5초마다/가려질 때 'tnc.live'(+ 경로 'tnc.liveRoute') 에 남음
  //   (b) 새로 열린 것처럼(메모리만 비움) → 50m 옆 첫 위치에서 경로 카드·길찾기 요청 없이 같은 목적지로 안내 계속, 구간단속 시작 시각 그대로
  //       ·간 거리 1.5km + 50m, 배율 15 유지, '안내를 이어 갑니다', 소리가 막혀 있으면 '소리 꺼짐' 알약
  //   (c) 남긴 경로가 없으면 조용히 다시 찾아 이어 감(카드 없이)  (d) 30분 넘은 것은 버림  (e) 안내를 끝내면 지움  (f) 닫힐 때(pagehide)도 남김
  async function s131() {
    const t = T(), r = {}, L = t.live, prevOn = L.on, prevUnlocked = t.sound.unlocked, prevVoice = t.prefs.voice;
    const raw = [];
    for (let k = 0; k <= 30; k++) raw.push(dest(NAV_ORIGIN, 0, 100 * k));
    const path = raw.map((p) => [round6(p.lng), round6(p.lat)]);
    const P = path.map((x) => ({ lat: x[1], lng: x[0] }));
    const cum = [0];
    for (let i = 1; i < P.length; i++) cum.push(cum[i - 1] + hav(P[i - 1], P[i]));
    const total = cum[cum.length - 1];
    const R = { route: { option: 'traoptimal', distance: r0(total), duration: r0(total / 15 * 1000), tollFare: 0, fuelPrice: 0, path,
        guide: [{ i: 30, t: 88, s: '목적지', d: r0(total), ms: r0(total / 15 * 1000) }], sections: [{ i: 0, n: 31, name: '시험로', speed: 60, cong: 1 }] },
      P, cum, total, dest: { name: '후진 시험', addr: '', lat: P[30].lat, lng: P[30].lng } };
    const go = (s) => { const a = pointAt(R, s); feed(a.p, 15, a.h); };
    const got = () => { try { return JSON.parse(localStorage.getItem('tnc.live') || 'null'); } catch (e) { return null; } };
    const routeCalls = () => stub.count('/route');
    // 새로 열린 페이지처럼: 남긴 것은 그대로 두고 메모리(안내·구간)만 비운다
    const reopen = () => { L.pending = t.liveLoad(); t.endNav(); t.camState.section = null; t.nav.dest = null; };
    try {
      await waitFor(() => t.getMap(), 10000, 100);   // 배율은 지도가 뜬 뒤에
      L.on = true;
      t.sound.unlocked = false; t.prefs.voice = true;
      softReset();
      await planAndStart(R);
      for (let s = 15; s <= 600; s += 15) go(s);
      const now = Date.now();
      t.camState.section = { limit: 100, len: 5000, t0: now - 60000, d0: t.state.odo - 1500 };
      // 손으로 바꾼 배율 15 (시험 창이 가려지면 지도 애니메이션이 안 끝나므로 배율은 읽는 값·부른 값으로 본다)
      const m = t.getMap(), gz = m.getZoom, sz = m.setZoom, zoomCalls = [];
      t.zoomCtl.manualUntil = t.state.fix.t + 100000;
      m.getZoom = () => 15;
      t.liveSave(true);
      m.getZoom = gz;
      m.setZoom = function (z) { zoomCalls.push(z); return sz.call(this, z); };
      const sv = got(), rr = JSON.parse(localStorage.getItem('tnc.liveRoute') || 'null');
      r.a = { saved: !!sv, dest: sv && sv.dest.name, rk: !!(sv && rr && sv.rk && rr.k === sv.rk), pts: rr && rr.r && rr.r.path.length, sec: sv && sv.sec && Math.round(sv.sec.done), zoom: sv && sv.zoom && sv.zoom.z };
      // (b) 다시 열림
      reopen();
      const c0 = routeCalls();
      const a2 = pointAt(R, 600);
      feed(dest(a2.p, 90, 50), 0, null);   // 후진·주차로 50m 옆
      t.maybeResume();
      await sleep(50);
      m.setZoom = sz;
      const s2 = t.camState.section;
      r.b = { active: t.nav.active, dest: t.nav.dest && t.nav.dest.name, card: visible('#routeCard'), calls: routeCalls() - c0, secT0: s2 ? s2.t0 === now - 60000 : false,
        secDone: s2 ? Math.round(t.state.odo - s2.d0) : null, zoom: zoomCalls[zoomCalls.length - 1], manual: t.zoomCtl.manualUntil > t.state.fix.t + 60000, toast: text('#toast'), pill: visible('#soundPill'),
        pending: !!L.pending };
      // (f) 닫힐 때도 남김
      localStorage.removeItem('tnc.live');
      window.dispatchEvent(new Event('pagehide'));
      r.f = { saved: !!got(), dest: got() && got().dest.name };
      // (e) 안내를 끝내면 지움
      t.endNav();
      r.e = { live: localStorage.getItem('tnc.live'), route: localStorage.getItem('tnc.liveRoute') };
      // (c) 남긴 경로가 없으면 다시 찾아 이어 감
      softReset();
      await planAndStart(R);
      for (let s = 15; s <= 300; s += 15) go(s);
      t.liveSave(true);
      localStorage.removeItem('tnc.liveRoute');
      reopen();
      stub.canned['/route'] = R.route;
      const c1 = routeCalls();
      feed(pointAt(R, 320).p, 0, null);
      t.maybeResume();
      await waitFor(() => t.nav.active, 3000, 50);
      r.c = { active: t.nav.active, dest: t.nav.dest && t.nav.dest.name, card: visible('#routeCard'), calls: routeCalls() - c1 };
      t.endNav();
      // (d) 30분 넘은 것
      softReset();
      await planAndStart(R);
      for (let s = 15; s <= 300; s += 15) go(s);
      t.liveSave(true);
      const old = got(); old.t = Date.now() - 31 * 60000; localStorage.setItem('tnc.live', JSON.stringify(old));
      r.d = { loaded: !!t.liveLoad(), left: localStorage.getItem('tnc.live') };
      t.endNav();
    } finally {
      L.pending = null;
      t.liveClear();
      L.on = prevOn;
      t.sound.unlocked = prevUnlocked; t.prefs.voice = prevVoice; t.updateSoundPill();
      t.zoomCtl.manualUntil = 0;
      stub.reset();
      softReset();
    }
    const a = r.a || {}, b = r.b || {}, c = r.c || {}, d = r.d || {}, e = r.e || {}, f = r.f || {};
    const ok = a.saved && a.dest === '후진 시험' && a.rk && a.pts === 31 && a.sec === 1500 && a.zoom === 15 &&
      b.active && b.dest === '후진 시험' && !b.card && b.calls === 0 && b.secT0 && b.secDone >= 1540 && b.secDone <= 1560 && b.zoom === 15 && b.manual &&
      /안내를 이어 갑니다/.test(b.toast) && b.pill && !b.pending &&
      f.saved && f.dest === '후진 시험' && e.live === null && e.route === null &&
      c.active && c.dest === '후진 시험' && !c.card && c.calls === 1 &&
      !d.loaded && d.left === null;
    return { pass: !!ok, detail: JSON.stringify(r) };
  }

  // S132: 네이버 양방향 확인 1차 (v201, keys 세션 에뮬레이터 — 운전자 규칙 '다르거나 없으면 네이버대로')와 판교분기점 1차 유도선. 실제 자료로:
  //   곧은 길을 네이버가 띄운 방향으로 그 자리 1.5km 앞에서 지나가면 그 카메라가 경로 위 카메라에 든다 —
  //   별내 송산로 남행 60 신호·과속, 강동대로 북쪽 남행 어린이 30 신호·과속, 25719 서행 30, 둔촌사거리 25557(네이버 자리로 85m 옮김) 동행·서행 50,
  //   난곡로 23871 남서행 30. 판교분기점 1차: 경부 상행 실제 경로(서울TG→판교분기점 '일산, 구리')에서 유도선 첫 줄이 갈림 300m 앞에서 시작하는 분홍
  async function s132() {
    const t = T(), r = {};
    const pass = async (lat, lng, h) => {
      const at = { lat, lng }, A = dest(at, h + 180, 1500), P = [];
      for (let s = 0; s <= 2000; s += 20) { const q = dest(A, h, s); P.push({ lat: round6(q.lat), lng: round6(q.lng) }); }
      const cum = [0]; for (let i = 1; i < P.length; i++) cum.push(cum[i - 1] + hav(P[i - 1], P[i]));
      const total = cum[cum.length - 1];
      const R = { route: { distance: r0(total), duration: r0(total / 14 * 1000), tollFare: 0, fuelPrice: 0, path: P.map((q) => [q.lng, q.lat]),
        guide: [{ i: P.length - 1, t: 88, s: '목적지', d: r0(total), ms: r0(total / 14 * 1000) }], sections: [{ i: 0, n: P.length, name: '', speed: 50, cong: 1 }] },
        P, cum, total, dest: { name: '확인', addr: '', lat: P[P.length - 1].lat, lng: P[P.length - 1].lng } };
      await resetApp(); softReset(); await planAndStart(R); t.ensureRouteCams();
      const hit = [...(t.nav.routeCams ? t.nav.routeCams.keys() : [])].map((c) => ({ c, d: hav(at, { lat: c[0], lng: c[1] }) })).filter((x) => x.d <= 40).sort((a, b) => a.d - b.d)[0];
      t.endNav();
      return hit ? hit.c[2] + '/' + hit.c[3] + '@' + Math.round(hit.d) : '';
    };
    try {
      await waitFor(() => t.cams.loaded, 10000, 100);
      r.songsanS = await pass(37.699451, 127.124144, 146);
      r.gangdongN = await pass(37.521355, 127.139616, 199);
      r.c25719W = await pass(37.52777, 127.1405, 290);
      r.c25557E = await pass(37.52116, 127.1338, 119);
      r.c25557W = await pass(37.52116, 127.1338, 299);
      r.c23871SW = await pass(37.4704, 126.919729, 252);
      const row = t.cams.rows[25557];
      r.row25557 = row ? [row[0], row[1], row[2], row[3]].join(',') : '';
      // 판교분기점 1차 유도선
      const fx = await (await realFetch(harnessDir + 'fixtures/route-seoultg-n.json', { cache: 'no-store' })).json();
      const P = fx.path.map((x) => ({ lat: x[1], lng: x[0] }));
      const cum = [0]; for (let k = 1; k < P.length; k++) cum.push(cum[k - 1] + hav(P[k - 1], P[k]));
      await resetApp(); softReset();
      await planAndStart({ route: fx, P, cum, total: cum[cum.length - 1], dest: { name: '판교', addr: '', lat: P[P.length - 1].lat, lng: P[P.length - 1].lng } });
      const g = fx.guide.find((x) => /판교분기점에서 '일산, 구리'/.test(x.s));
      const list = t.ensureRouteColorLines();
      r.pangyo = list.map((x) => x.name + ':' + x.c + ':' + Math.round(x.at - cum[g.i])).join(',');
      t.endNav();
    } finally {
      await resetApp(); softReset();
    }
    const first = (r.pangyo || '').split(',')[0].split(':');
    const ok = /^60\/3@/.test(r.songsanS) && /^30\/3@/.test(r.gangdongN) && /^30\/3@/.test(r.c25719W) && /^50\/3@/.test(r.c25557E) && /^50\/3@/.test(r.c25557W) &&
      /^30\/3@/.test(r.c23871SW) && r.row25557 === '37.52116,127.1338,50,3' &&
      first[0] === '판교분기점' && first[1] === 'p' && +first[2] >= -350 && +first[2] <= -250;
    return { pass: !!ok, detail: JSON.stringify(r) };
  }

  // S133: '잘못된 정보 신고' 하나 + 실시간 확인 (v202, 운전자 '틀림 놓침에서 틀림 없애고 놓침을 잘못 된 정보 신고로', '경고없을때 눌렀을때 에뮬레이터가 …
  //       신고 반영 완료를 … 3초', '네이버에 없을때 확인완료로만 … 신고 접수 완료 로').
  //   (a) 버튼은 하나('잘못된 정보 신고'), 예전 '틀림'은 숨김, 화면 어디에도 '놓침'·'틀림' 글자 없음
  //   (b) 경고 카드가 1초 넘게 떠 있을 때 누르면 그 카메라 신고(서버 기록 user 'wrong', 14일 흐리게) — 네이버 확인 요청은 안 보냄
  //   (c) 카드가 없을 때 누르면 '신고 접수 완료' + /check 요청(자리·방향·속도·기기, 운영자 차가 아니면 궤적 없음), 요청 번호를 남김
  //   (d) 1분 뒤 상태가 '네이버에 있음'이면 '신고 반영 완료 · 60 신호·과속단속 추가'(3초) + 모든 사용자 고침을 다시 받음, 요청 번호 지움
  //   (e) '네이버에도 없음'이면 '확인 완료'
  async function s133() {
    const t = T(), r = {}, b = document.getElementById('camMissBtn'), keepShare = t.prefs.share, keepChecks = t.store.get('checks'), keepNo = t.store.get('camNo2'), keepSpots = t.store.get('mySpots'), keepArr = t.mySpots.slice(), keepFix = t.store.get('camFix');
    let flagKey = null;
    const R = buildNavRoute();
    const visibleText = () => { const p = document.getElementById('harnessPanel'), d = p ? p.style.display : ''; if (p) p.style.display = 'none'; const x = document.body.innerText; if (p) p.style.display = d; return x; };
    try {
      t.checkSt.inTest = true; t.prefs.share = true; t.store.set('checks', null);
      softReset();
      await planAndStart(R);
      for (let s = 15; s <= 300; s += 15) { const a = pointAt(R, s); feed(a.p, 15, a.h); }
      b.hidden = false;
      r.a = { label: b.textContent, aria: b.getAttribute('aria-label'), wrongHidden: document.getElementById('camWrong').hidden, words: /놓침|틀림/.test(visibleText()) };
      // (b) 카드가 떠 있을 때: 가짜 카메라를 경고 대상으로
      const card = document.getElementById('camCard');
      const tgRow = t.cams.rows.find((c) => c[2] === 60) || t.cams.rows[0];
      const i = t.cams.rows.indexOf(tgRow);
      t.camState.target = { i, c: tgRow, d: 300, r: 300, minD: 300, after: false, t0: Date.now() };
      t.renderCam();
      card._camI = i; card._camAt = Date.now() - 2000; card.hidden = false;
      const c0 = stub.calls.length;
      b.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await sleep(30);
      r.b = { toast: text('#toast'), flag: t.camState.target ? t.camState.target.flag : 'gone', check: stub.since(c0, '/check').length };
      clearTimeout(b._sentT); b.classList.remove('sent', 'saved', 'sending'); b.textContent = '잘못된 정보 신고';
      flagKey = tgRow[0] + ',' + tgRow[1];
      t.camState.target = null; card.hidden = true; t.renderCam();
      // (c) 카드가 없을 때 (Worker 가 받음)
      stub.canned['/check'] = (q, rec) => ({ ok: true, id: rec.body && rec.body.id, pos: 1 });
      const c1 = stub.calls.length;
      b.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await waitFor(() => !b.classList.contains('sending'), 2000, 10);
      const ck = stub.since(c1, '/check')[0];
      await waitFor(() => t.checksLoad().length > 0, 2000, 10);
      const saved = t.checksLoad();
      r.c = { toast: text('#toast'), sent: !!ck, method: ck && ck.method, keys: ck && ck.body ? Object.keys(ck.body).sort().join(',') : '', trail: !!(ck && ck.body && ck.body.trail),
        saved: saved.length, sameId: !!(ck && saved[0] && saved[0].id === ck.body.id) };
      clearTimeout(b._sentT); b.classList.remove('sent', 'saved', 'sending'); b.textContent = '잘못된 정보 신고';
      // (d) 네이버에 있음
      const id = saved[0] && saved[0].id;
      stub.canned['/check/status'] = (q) => ({ items: { [id]: { st: 'found', cams: [{ limit: 60, kind: '신호과속' }] } } });   // (POST /check 는 기본 답 {} — ok 가 없으면 번호를 안 남기므로 아래 canned)
      stub.canned['/fixes'] = { v: 1, items: [] };
      const c2 = stub.calls.length;
      await t.checkPoll(true);
      r.d = { toast: text('#toast'), fixes: stub.since(c2, '/fixes').length, left: t.checksLoad().length, askedId: ((stub.since(c2, '/check/status')[0] || {}).query || {}).ids === id };
      // (e) 네이버에도 없음
      t.store.set('checks', JSON.stringify([{ id: 'zz00000000001', at: Date.now() }]));
      stub.canned['/check/status'] = () => ({ items: { zz00000000001: { st: 'none' } } });
      await t.checkPoll(true);
      r.e = { toast: text('#toast'), left: t.checksLoad().length };
      t.endNav();
    } finally {
      t.checkSt.inTest = false; t.prefs.share = keepShare; t.store.set('checks', keepChecks);
      if (flagKey) t.camNoMap.delete(flagKey);
      t.camFixes.clear(); t.store.set('camFix', keepFix); t.applyCamFixes();   // (c) 의 차 안 진단이 고친 것
      t.mySpots.length = 0; keepArr.forEach((m) => t.mySpots.push(m)); t.store.set('mySpots', keepSpots); t.applyUserSpots(); t.renderMySpots();
      t.store.set('camNo2', keepNo); t.renderCamFlags();
      stub.reset();
      clearTimeout(b._sentT); b.classList.remove('sent', 'saved', 'sending'); b.textContent = '잘못된 정보 신고';
      softReset();
    }
    const a = r.a || {}, bb = r.b || {}, c = r.c || {}, d = r.d || {}, e = r.e || {};
    const ok = a.label === '잘못된 정보 신고' && a.aria === '잘못된 정보 신고' && a.wrongHidden && !a.words &&
      /^신고 접수 완료/.test(bb.toast) && (bb.flag === 'doubt' || bb.flag === 'hide') && bb.check === 0 &&
      /^신고 접수 완료/.test(c.toast) && c.sent && c.method === 'POST' && c.keys === 'dev,h,id,kmh,lat,lng,v' && !c.trail && c.saved === 1 && c.sameId &&
      d.toast === '신고 반영 완료 · 60 신호·과속단속 추가' && d.fixes === 1 && d.left === 0 && d.askedId &&
      e.toast === '확인 완료' && e.left === 0;
    return { pass: !!ok, detail: JSON.stringify(r) };
  }

  // S134: 나침반 위 음성 피드백 (v203, 운전자 '그 나침반 위에 피드백 버튼 띄어서 클릭하면 음성으로 텍스트 형태로 전달 … 다시 음성을 누르거나 다른 곳을 누르면 취소',
  //       '녹음 초록색 느낌처럼 빙글 빙글 도는거? Ai 대화모드처럼'). 브라우저 음성 인식 대신 가짜를 끼워서:
  //   (a) 버튼은 나침반 바로 위(52px 원)  (b) 누르면 한국어로 듣기 시작, 초록 고리·'듣는 중…'
  //   (c) 말이 끝나고 1.5초 조용하면 글자를 바로 보냄(위치·방향·속도·길안내·떠 있던 카드 포함) → '보냈어요', 버튼 원래대로
  //   (d) 듣는 중 화면 다른 곳을 누르면 취소(듣기 멈춤, '취소했어요')  (e) 다시 누르면 취소  (f) 음성 인식이 없는 브라우저면 알려 줌
  async function s134() {
    const t = T(), r = {}, keepSR = window.SpeechRecognition, keepW = window.webkitSpeechRecognition;
    const recs = [];
    class FakeSR {
      constructor() { this.started = false; this.aborted = false; recs.push(this); }
      start() { this.started = true; Promise.resolve().then(() => { if (this.onstart) this.onstart(); }); }
      stop() { this.stopped = true; if (this.onend) this.onend(); }
      abort() { this.aborted = true; if (this.onend) this.onend(); }
      say(text) { const res = [{ transcript: text }]; res.isFinal = true; this.onresult({ resultIndex: 0, results: [res] }); }
    }
    const btn = document.getElementById('fbBtn'), lab = document.getElementById('fbLabel');
    const R = buildNavRoute();
    try {
      window.SpeechRecognition = FakeSR; window.webkitSpeechRecognition = undefined;
      t.fb.inTest = true;
      softReset();
      await planAndStart(R);
      for (let s = 15; s <= 300; s += 15) { const a = pointAt(R, s); feed(a.p, 15, a.h); }
      const fbR = btn.getBoundingClientRect(), ht = document.getElementById('headingText').getBoundingClientRect();
      const cp = document.querySelector('#app .heading .compass').getBoundingClientRect();
      const hp = document.getElementById('harnessPanel'), hpd = hp ? hp.style.display : '';
      if (hp) hp.style.display = 'none';   // 좁은 화면에서는 시험 결과 칸이 앱을 덮는다
      const hit = document.elementFromPoint((fbR.left + fbR.right) / 2, (fbR.top + fbR.bottom) / 2);
      if (hp) hp.style.display = hpd;
      // v206: 주행 기록 카드 안 나침반 줄 오른쪽 끝 (46px, 말풍선 속 마이크 + '의견'), 진짜 누름이 버튼에 닿는다
      // v263 (운전자: 주행 기록 카드는 오른쪽 아래, 왼쪽 아래에는 초록 '의견' 버튼만): 왼쪽 아래 모서리 50px, 진짜 누름이 버튼에 닿는다
      const appR = document.getElementById('app').getBoundingClientRect();
      r.a = { w: Math.round(fbR.width), h: Math.round(fbR.height), right: fbR.left < appR.left + 40, row: fbR.bottom > appR.bottom - 60,
        inCard: !!btn.closest('.fbcorner'), cap: text('.fb-cap'), hit: !!(hit && hit.closest && hit.closest('#fbBtn')), shown: getComputedStyle(btn.parentElement).display !== 'none' };
      // (b)·(c)
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      const rec = recs[recs.length - 1];
      r.b = { listening: btn.classList.contains('listening'), label: lab.textContent, started: !!(rec && rec.started), lang: rec && rec.lang, ring: getComputedStyle(btn.querySelector('.fb-ring')).animationName };
      rec.say('이 카메라 위치가 틀려요');
      const tSaid = Date.now();
      await waitFor(() => !!t.fb.last, 4000, 50);
      const waited = Date.now() - tSaid;
      await waitFor(() => !btn.classList.contains('sending') && !btn.classList.contains('listening'), 3000, 50);
      const p = t.fb.last || {};
      r.c = { text: p.text, waited, navOn: p.navOn, hasPos: p.lat != null && p.lng != null, kmh: p.kmh, cards: !!p.cards, toast: text('#toast'), label: lab.hidden, aborted: !!rec.aborted };
      // (d) 다른 곳을 누르면 취소
      t.fb.last = null;
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      const rec2 = recs[recs.length - 1];
      document.getElementById('map').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      r.d = { listening: btn.classList.contains('listening'), aborted: !!rec2.aborted, toast: text('#toast'), sent: !!t.fb.last };
      // (e) 다시 누르면 취소
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      const rec3 = recs[recs.length - 1];
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      r.e = { listening: btn.classList.contains('listening'), aborted: !!rec3.aborted, sent: !!t.fb.last };
      // (f) 음성 인식 없음
      window.SpeechRecognition = undefined;
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      r.f = { listening: btn.classList.contains('listening'), toast: text('#fbPanel .fbp-cap'), panel: t.fbP.open };   // v225: 까닭은 버튼판 위 글
      t.endNav();
    } finally {
      t.fbCancel(true);
      t.fbPanelClose(); t.store.set('fbMode', null);   // v225: 음성 인식이 없으면 버튼판이 열린다
      t.fb.inTest = false; t.fb.last = null;
      window.SpeechRecognition = keepSR; window.webkitSpeechRecognition = keepW;
      softReset();
    }
    const a = r.a || {}, b = r.b || {}, c = r.c || {}, d = r.d || {}, e = r.e || {}, f = r.f || {};
    const ok = a.w === 50 && a.h === 50 && a.right && a.row && a.inCard && a.cap === '의견' && a.hit && a.shown &&
      b.listening && b.label === '듣는 중…' && b.started && b.lang === 'ko-KR' && b.ring === 'fbspin' &&
      c.text === '이 카메라 위치가 틀려요' && c.waited >= 1400 && c.navOn === true && c.hasPos && c.cards && c.toast === '보냈어요' && c.label && c.aborted &&
      !d.listening && d.aborted && d.toast === '취소했어요' && !d.sent &&
      !e.listening && e.aborted && !e.sent &&
      !f.listening && /음성 인식을 지원하지 않아요/.test(f.toast) && f.panel;
    return { pass: !!ok, detail: JSON.stringify(r) };
  }

  // S135: 시간제 스쿨존 (v204, 운전자 '이것도 중요하긴 해' — 네이버는 '표지판 확인' 뒤 밤에는 50) 과 경부 상행 이동식 110 (keys 세션 네이버 확인).
  //   실제 어린이보호구역 카메라 25719(30) 둘레에 시험 학교 하나: 08~20시 30, 그 밖 50, 매일
  //   (a) 22시면 50, 10시면 30, 반경 밖 카메라는 그대로  (b) 밤 50 이면 경고 카드도 50  (c) 월~금만이면 일요일 10시는 50
  //   (d) 밤을 넘는 시간대(21~07시 50, 그 밖 30): 23시·06시 50, 12시 30  (e) 자료를 비우면 원래 30
  //   (f) 운전자 지점: 죽전 이동식 110 은 네이버 자리(71m 북)로, 판교 부근 북행 이동식 110 추가 — 둘 다 '운전자 신고 이동식 단속'
  async function s135() {
    const t = T(), r = {}, keep = JSON.parse(JSON.stringify({ rows: [] }));
    const at = (h, m, wd) => { const d = new Date(2026, 10, 22 + (wd == null ? 0 : wd), h, m || 0); return d.getTime(); };   // 2026-11-22 은 일요일
    try {
      await waitFor(() => t.cams.loaded, 10000, 100);
      const c = t.cams.rows[25719], far = t.cams.rows.find((x, i) => i < t.cams.userBase && x[6] === 2 && x[2] === 30 && hav({ lat: x[0], lng: x[1] }, { lat: c[0], lng: c[1] }) > 2000);
      t.setSchoolTimes({ v: 1, rows: [[c[0], c[1], null, 200, [[800, 2000, 30]], 50, '0-6', '시험초']] });
      t.applySchoolTimes(true, at(22, 0, 1)); r.night = c[2]; r.farNight = far[2];
      t.camState.target = { i: 25719, c, d: 300, r: 300, minD: 300, after: false, t0: Date.now() };
      t.renderCam(); r.card = text('#camLimit');
      t.camState.target = null; t.renderCam();
      t.applySchoolTimes(true, at(10, 0, 1)); r.day = c[2];
      t.setSchoolTimes({ v: 1, rows: [[c[0], c[1], null, 200, [[800, 2000, 30]], 50, '1-5', '시험초']] });
      t.applySchoolTimes(true, at(10, 0, 0)); r.sunday = c[2];
      t.applySchoolTimes(true, at(10, 0, 1)); r.monday = c[2];
      t.setSchoolTimes({ v: 1, rows: [[c[0], c[1], null, 200, [[2100, 700, 50]], 30, '0-6', '시험초']] });
      t.applySchoolTimes(true, at(23, 0, 1)); r.n23 = c[2];
      t.applySchoolTimes(true, at(6, 0, 1)); r.n06 = c[2];
      t.applySchoolTimes(true, at(12, 0, 1)); r.n12 = c[2];
      t.applySchoolTimes(true, at(23, 0, 1));
      t.setSchoolTimes({ v: 1, rows: [] }); r.cleared = c[2]; r.timed = !!c.timed;
      // (f) 운전자 지점
      const u = t.cams.rows.slice(t.cams.userBase);
      const near = (lat, lng) => u.find((x) => hav({ lat, lng }, { lat: x[0], lng: x[1] }) < 15);
      const jj = near(37.334139, 127.103549), pg = near(37.377688, 127.103352), old = near(37.3335, 127.103614);
      r.spots = { jukjeon: jj ? jj[2] + '/' + jj[3] + ' ' + t.camLabel(jj) : '', pangyo: pg ? pg[2] + '/' + pg[3] + ' ' + t.camLabel(pg) : '', old: !!old };
    } finally {
      t.setSchoolTimes(keep);
      await t.loadSchoolTimes();
      t.camState.target = null; t.renderCam();
    }
    const ok = r.night === 50 && r.farNight === 30 && r.card === '50' && r.day === 30 && r.sunday === 50 && r.monday === 30 &&
      r.n23 === 50 && r.n06 === 50 && r.n12 === 30 && r.cleared === 30 && !r.timed &&
      r.spots.jukjeon === '110/8 이동식단속' && r.spots.pangyo === '110/8 이동식단속' && !r.spots.old;   // v208: 네이버 확인 → 보통 이동식 이름
    return { pass: !!ok, detail: JSON.stringify(r) };
  }

  // S136: 단속 카드 표지 정렬 (v205, 운전자 '가운데로 정렬 해서 보여줘야 되는 거 아니야 110 너무 밑에 있는 느낌이다').
  //   테슬라 서랍 안 카드에서 동그란 표지 위 끝 = 종류 글씨 위 끝, 아래 끝 = 거리 숫자 아래 끝 (띠는 그 밑).
  //   구간단속 끝·고정식·이동식·보호구역 카드가 모두 같다
  async function s136() {
    await waitFor(() => T().cams.loaded, 10000, 100);   // 카메라 자료가 늦게 오면 카드를 못 고른다
    const t = T(), r = {};
    // v252: 구간 안 끝 카메라는 카드가 없다 → 구간단속 '시작' 카드로 본다
    const pick = { sec: (x) => x[4] === 1 && x[2] === 110, fixed: (x) => !x[4] && x[3] === 1 && x[6] !== 2, mobile: (x) => !x[4] && x[3] === 8, zone: (x) => !x[4] && x[6] === 2 && x[2] === 30 };
    const card = document.getElementById('camCard');
    const B = (el) => el.getBoundingClientRect();
    try {
      await waitFor(() => t.cams.loaded, 10000, 100);
      // v244: 'secDoubt' = 운전자가 '잘못된 정보 신고'를 누른 구간단속 끝 (흐리게, 제한속도 '?', 종류 글씨 뒤 '내가 신고함')
      for (const k of Object.keys(pick).concat(['secDoubt'])) {
        const i = t.cams.rows.findIndex((x, j) => j < t.cams.userBase && pick[k === 'secDoubt' ? 'sec' : k](x));
        if (i < 0) { r[k] = 'none'; continue; }
        const c = t.cams.rows[i];
        t.camState.section = null;   // 구간단속 시작 카드는 구간이 열리기 전에 뜬다
        t.camState.target = { i, c, d: 2000, r: 2000, minD: 2000, after: false, t0: Date.now(), first: 2600, flag: k === 'secDoubt' ? 'doubt' : undefined };
        t.renderCam();
        const sg = B(card.querySelector('.cam-sign')), lb = B(document.getElementById('camType')), ds = B(document.getElementById('camDist')), bar = B(card.querySelector('.cam-bar'));
        const lm = B(document.getElementById('camLimit'));
        r[k] = { inDrawer: !!card.closest('#camDrawer .cd-in'), top: Math.round(sg.top - lb.top), bottom: Math.round(sg.bottom - ds.bottom), barBelow: bar.top >= ds.bottom - 1, h: Math.round(sg.height),
          // v244: AI 그림이 아닌 표지(구간단속)의 숫자는 동그라미 한가운데 — 예전엔 빈 아이콘 칸 때문에 약 5px 아래였다 (AI 그림은 그림의 숫자 자리 57% 에 둔다)
          ai: card.classList.contains('aisign'), num: Math.round(((lm.top + lm.bottom) / 2 - (sg.top + sg.bottom) / 2) * 10) / 10,
          limit: text('#camLimit'), after: getComputedStyle(document.getElementById('camType'), '::after').content };
      }
    } finally {
      t.camState.section = null; t.camState.target = null; t.renderCam();
    }
    const sd = r.secDoubt || {};
    const ok = Object.values(r).every((x) => x && x.inDrawer && Math.abs(x.top) <= 1 && Math.abs(x.bottom) <= 2 && x.barBelow && x.h >= 50 && (x.ai || Math.abs(x.num) <= 1.5)) &&
      !r.sec.ai && sd.limit === '?' && /내가 신고함/.test(sd.after) && r.sec.limit === '110';
    return { pass: !!ok, detail: JSON.stringify(r) };
  }

  // S137: 의견 버튼이 눌리고 읽히는지 (v206, 운전자 '피드백 음성 버튼이 일단 무슨 버튼인지 잘 모를 거 같고 눌러도 반응이 없어').
  //   예전: 버튼이 '터치는 지도로' 칸 안에 있어 누름이 지도로 갔고, 길안내 중엔 '잘못된 정보 신고'가 그 위를 덮었다.
  //   (a) 길안내 + 단속 카드: 버튼은 유리 카드 나침반 줄, 진짜 누름(elementFromPoint)이 버튼에 닿고 신고 버튼과 겹치지 않는다. 카드 바탕은 불투명(알파 ≥ .7)
  //   (b) 신고 버튼이 카드까지 내려오면 카드를 숨기고(trip-covered) 버튼은 누름을 받지 않는다
  //   (c) 실패는 늘 알린다: start() 예외 → '음성 인식을 시작하지 못했어요', 'network' → '음성 인식 서버에 연결하지 못했어요', 4초 안에 onstart 없음 → '응답하지 않아요'
  //   (d) 잘 되면 단계 기록: tap → start → onstart → onaudiostart
  async function s137() {
    const t = T(), r = {}, keepSR = window.SpeechRecognition, keepW = window.webkitSpeechRecognition;
    // v263: '의견' 버튼은 왼쪽 아래 모서리(.fbcorner), 가림 표시는 fb-covered. 버튼 바탕은 유리(알파 ≥ .5)
    const btn = document.getElementById('fbBtn'), pill = document.getElementById('camMissBtn'), trip = document.querySelector('.fbcorner');
    const R = buildNavRoute();
    const alpha = (c) => { const m = String(c).match(/rgba?\(([^)]+)\)/); if (!m) return 0; const p = m[1].split(',').map(Number); return p.length > 3 ? p[3] : 1; };
    // 시험 결과 칸(#harnessPanel)이 좁은 화면에서는 앱 위를 덮으므로 잴 때만 잠깐 치운다
    const tapAt = () => { const hp = document.getElementById('harnessPanel'), d = hp ? hp.style.display : ''; if (hp) hp.style.display = 'none';
      const bb = btn.getBoundingClientRect(), el = document.elementFromPoint((bb.left + bb.right) / 2, (bb.top + bb.bottom) / 2); if (hp) hp.style.display = d; return el; };
    try {
      t.fb.inTest = true;
      softReset();
      await planAndStart(R);
      for (let s = 15; s <= 150; s += 15) { const a = pointAt(R, s); feed(a.p, 15, a.h); }
      const i = t.cams.rows.findIndex((x, j) => j < t.cams.userBase && x[4] === 1 && x[2] === 100);
      t.camState.target = { i, c: t.cams.rows[i], d: 2200, r: 2200, minD: 2200, after: false, t0: Date.now(), first: 2600 };
      t.renderCam(); t.renderNav();
      try { document.getAnimations().forEach((a) => { try { a.finish(); } catch (e) { /* 무한 */ } }); } catch (e) { /* 미지원 */ }
      await sleep(60); t.renderNav();
      const app = document.getElementById('app'), b = btn.getBoundingClientRect(), p = pill.getBoundingClientRect(), hit = tapAt();
      const covered = app.classList.contains('fb-covered');
      r.a = { pill: !pill.hidden, covered, hit: !!(hit && hit.closest && hit.closest('#fbBtn')), onPill: !!(hit && hit.closest && hit.closest('#camMissBtn')),
        overlap: !pill.hidden && !(p.bottom <= b.top || p.top >= b.bottom || p.right <= b.left || p.left >= b.right), alpha: alpha(getComputedStyle(btn).backgroundColor) };
      // (b) 신고 버튼이 카드까지 내려온 경우
      const tr = trip.getBoundingClientRect();
      pill.style.marginTop = Math.max(0, Math.round(tr.top - p.bottom + 20)) + 'px';
      t.checkTripCover();
      const hit2 = tapAt();
      r.b = { covered: app.classList.contains('fb-covered'), takes: !!(hit2 && hit2.closest && hit2.closest('#fbBtn')), pe: getComputedStyle(btn).pointerEvents };
      pill.style.marginTop = ''; t.checkTripCover();
      // (c) 실패는 늘 보인다
      const steps = () => t.fb.steps.slice();
      const clr = () => { t.fbPanelClose(); t.store.set('fbMode', null); };   // v225: 실패하면 버튼판이 열리고 이 기기는 버튼판으로 기억된다
      t.store.set('fbMode', null);
      t.fb.steps.length = 0;
      window.webkitSpeechRecognition = undefined;
      window.SpeechRecognition = class { start() { throw new DOMException('busy', 'InvalidStateError'); } abort() {} };
      t.fbStart();
      r.c1 = { on: t.fb.on, toast: text('#fbPanel .fbp-cap'), steps: steps(), listening: btn.classList.contains('listening'), panel: t.fbP.open };
      clr();
      t.fb.steps.length = 0;
      window.SpeechRecognition = class { start() { setTimeout(() => { if (this.onstart) this.onstart(); if (this.onerror) this.onerror({ error: 'network' }); if (this.onend) this.onend(); }, 5); } abort() {} };
      t.fbStart();
      await waitFor(() => !t.fb.on, 1000, 10);
      r.c2 = { on: t.fb.on, toast: text('#fbPanel .fbp-cap'), steps: steps(), panel: t.fbP.open };
      clr();
      t.fb.steps.length = 0;
      window.SpeechRecognition = class { start() {} abort() {} };
      t.fbStart();
      t.fb.t0 -= 4500; t.fbTick();
      r.c3 = { on: t.fb.on, toast: text('#fbPanel .fbp-cap'), steps: steps(), panel: t.fbP.open };
      clr();
      // (d) 잘 되는 경우 (진짜 누름 자리에서 click)
      t.fb.steps.length = 0;
      window.SpeechRecognition = class { start() { setTimeout(() => { if (this.onstart) this.onstart(); if (this.onaudiostart) this.onaudiostart(); }, 5); } abort() {} };
      const h = tapAt();
      if (h) h.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await waitFor(() => t.fb.steps.includes('onaudiostart'), 1000, 10);
      r.d = { on: t.fb.on, steps: steps() };
      t.fbCancel(true);
      t.endNav();
    } finally {
      t.fbCancel(true);
      t.fbPanelClose(); t.store.set('fbMode', null);
      pill.style.marginTop = '';
      t.camState.target = null; t.renderCam();
      t.fb.inTest = false; t.fb.last = null;
      window.SpeechRecognition = keepSR; window.webkitSpeechRecognition = keepW;
      softReset();
    }
    const a = r.a || {}, b = r.b || {}, c1 = r.c1 || {}, c2 = r.c2 || {}, c3 = r.c3 || {}, d = r.d || {};
    const has = (arr, v) => Array.isArray(arr) && arr.includes(v);
    const ok = a.pill && !a.onPill && !a.overlap && (a.covered ? !a.hit : a.hit) && a.alpha >= 0.5 &&
      b.covered && !b.takes && b.pe === 'none' &&
      !c1.on && c1.toast === '음성 인식을 시작하지 못했어요 · 버튼으로 보내 주세요' && has(c1.steps, 'tap') && has(c1.steps, 'fail start InvalidStateError') && !c1.listening &&
      !c2.on && c2.toast === '음성 인식 서버에 연결하지 못했어요 · 버튼으로 보내 주세요' && has(c2.steps, 'onstart') && has(c2.steps, 'error network') && has(c2.steps, 'fail network') &&
      !c3.on && c3.toast === '음성 인식이 응답하지 않아요 · 버튼으로 보내 주세요' && has(c3.steps, 'fail nostart') && c1.panel && c2.panel && c3.panel &&
      d.on && ['tap', 'start', 'onstart', 'onaudiostart'].every((x) => has(d.steps, x));
    return { pass: !!ok, detail: JSON.stringify(r) };
  }

  // S138: 색깔 유도선 = 갈림 그림, 맨 위 (v207, 운전자 '이럴 때는 분홍색을 첫 번째 있는 걸로 보여 주고 저 분홍색 선 좌회전 하는 거 보다 그림을 알려 주는 게
  //       훨씬 더 좋아', '굳이 그림이 표기돼 있으면은 분홍색 화살표로 안 바꿔도 돼', '그리고 우리가 가지 않는 방향이라고 해도 그림에서 표지판에 표기를 해 주는 게 좋아').
  //   실제 경로 route-seoultg-n (서울TG → 판교분기점 '일산, 구리' 오른쪽 → '구리, 성남' 직진). 2026-11-24 09:39 사진: 990m 앞 안내 밑에 왼쪽으로 휜 분홍 화살표만 있었다.
  //   (a) 990m 앞: 안내 카드 맨 위(회전 줄 위)에 갈림 그림 — 경부 본선은 곧게(흐린 '① 경부'), 우리 갈래는 오른쪽(분홍 선, 진한 '[100] 일산 · 구리').
  //       분홍 화살표 없음, 회전 줄은 원래 초록 화살표·거리 그대로, 그림에는 거리 숫자 없음(바로 밑 줄에 있다)
  //   (b) 600m 앞: 분기점 확대 그림이 맡는다 — 분홍 차로, 표지 둘(우리 '100일산구리', 다른 갈래 '1경부'), 그림 줄은 숨김
  //   (c) 밤: 그림의 길이 어두운 색
  async function s138() {
    const t = T(), r = {};
    const fx = await (await realFetch(harnessDir + 'fixtures/route-seoultg-n.json', { cache: 'no-store' })).json();
    const P = fx.path.map((x) => ({ lat: x[1], lng: x[0] }));
    const cum = [0];
    for (let k = 1; k < P.length; k++) cum.push(cum[k - 1] + hav(P[k - 1], P[k]));
    const SR = { route: fx, P, cum, total: cum[cum.length - 1], dest: { name: '판교분기점', addr: '', lat: P[P.length - 1].lat, lng: P[P.length - 1].lng } };
    const go = (m) => { const a = pointAt(SR, m); feed(a.p, 25, a.h); t.renderNav(); };
    const el = () => document.getElementById('colorRow');
    const snap = () => {
      const row = el(), turn = document.querySelector('#navPanel .turn');
      return { shown: visible('#colorRow'), first: !!(row.nextElementSibling && row.nextElementSibling === turn), kind: row.dataset.kind || '', side: row.dataset.side || '',
        pic: !!row.querySelector('svg.sp-pic .sp-band'), arrow: !!row.querySelector('.cli-cl'), dist: text('#colorDist'),
        ours: (row.querySelector('.sp-ours') || {}).textContent || '', oursNo: !!row.querySelector('.sp-ours .sg-shield'),
        other: (row.querySelector('.sp-other') || {}).textContent || '', otherDim: (() => { const o = row.querySelector('.sp-other'); return o ? +getComputedStyle(o).opacity : 1; })(),
        turnDist: text('#turnDist'), turnGreen: !!document.querySelector('#turnIcon svg, #turnIcon img') && !document.querySelector('#turnIcon .cli-cl'),
        road: (() => { const q = row.querySelector('.sp-road'); return q ? getComputedStyle(q).stroke : ''; })() };
    };
    try {
      softReset();
      await planAndStart(SR);
      const g55 = cum[55];
      for (let m = 50; m <= g55 - 990; m += 30) go(m);
      go(g55 - 990);
      // v215: 해가 진 뒤에는 지도가 이미 밤이라 낮 색과 밤 색을 견줄 수 없었다 — 낮으로 놓고 잰다
      document.getElementById('map').classList.remove('night');
      t.renderNav();
      r.a = snap();
      document.getElementById('map').classList.add('night');
      t.renderNav();
      r.c = { road: snap().road };
      document.getElementById('map').classList.remove('night');
      t.renderNav();
      for (let m = g55 - 960; m <= g55 - 600; m += 30) go(m);
      try { document.getAnimations().forEach((a) => { try { a.finish(); } catch (e) { /* 무한 */ } }); } catch (e) { /* 미지원 */ }
      t.renderNav();
      r.b = { row: visible('#colorRow'), junc: visible('#juncCard'), cl: !!document.querySelector('#juncCard:not([hidden]) svg.nv .nv-cl'),
        sign1: text('#juncLabel'), sign2: visible('#juncLabel2') ? text('#juncLabel2') : '', dim2: +getComputedStyle(document.getElementById('juncLabel2')).opacity };
      t.endNav();
    } finally {
      document.getElementById('map').classList.remove('night');
      t.applyNight();   // v215: 지금 시각의 낮·밤으로 되돌린다
      softReset();
    }
    const a = r.a || {}, b = r.b || {}, c = r.c || {};
    const ok = a.shown && a.first && a.kind === 'ramp' && a.side === 'r' && a.pic && !a.arrow && a.dist === '' &&
      a.ours === '100일산 · 구리' && a.oursNo && a.other === '1경부' && a.otherDim < 0.9 && /^1\.0km$|^990m$/.test(a.turnDist) && a.turnGreen &&
      b.junc && !b.row && b.cl && b.sign1 === '100일산구리' && b.sign2 === '1경부' && b.dim2 < 0.9 &&
      c.road && c.road !== a.road;
    return { pass: !!ok, detail: JSON.stringify(r) };
  }

  // S139: 네이버로 확인한 운전자 지점은 보통 카메라처럼 (v208, 운전자 '운전자 신고 신호 과속 단속 이라고 파란 글씨로 나오는데 그냥 신호 단속 구간인데
  //       네이버 지도는 신호 과속 이라고만 표기 하는데 … 다 그렇게 표기 하는 게 맞아?') + 경로선·회전 화살표 굵게·검정 테두리
  //       ('여기도 네이버지도처럼 약간 두껍게 가능?확대 축소에 따라 조금씩 조정되긴 해', '그리고 검정색 테두리로 통일하자').
  //   (a) 표시 2(네이버 확인) 신호·과속 50: '신호·과속단속', 파란 카드 아님, 신호등 표지, 짧은 이름 '신호과속', 노란 띠, 음성 '신호 단속 카메라'
  //   (b) 표시 2 이동식 110: '이동식단속', 파란 카드(진짜 이동식)  (c) 표시 6(확인 + 어린이보호구역) 30: '어린이보호구역 신호·과속단속'
  //   (d) 표시 없는 운전자 지점: 예전처럼 '운전자 신고 신호·과속단속', 파란 카드  (e) /check 로 찾은 공유 지점(ck): 확인됨
  //   (f) 실제 자료: 21줄 모두 확인됨(v210 20줄, v213 비룡로 1줄), 그중 3줄이 보호구역
  //   (g) 경로선 굵기: 배율 15·17·18 에서 9·14·16px (v211: 18 에서 16px 이 끝), 검정 테두리 = 굵기 + 4, 화살표 테두리는 검정
  async function s139() {
    const t = T(), r = {};
    const keep = { drv: t.driverSpots.rows.slice(), shared: t.sharedSpots.slice(), mine: t.mySpots.slice() };
    const card = document.getElementById('camCard');
    const show = (c, i) => {
      t.camState.target = { i, c, d: 400, r: 400, minD: 400, after: false, t0: Date.now() };
      t.renderCam();
      return { label: text('#camType'), blue: card.classList.contains('mobile'), slot: t.camSignSlot(c), short: t.camShort(c), band: t.camBand(c), voice: t.camSpoken(c), zone: c[6] };
    };
    try {
      await waitFor(() => t.cams.loaded, 10000, 100);
      r.f = { rows: keep.drv.length, checked: keep.drv.filter((x) => (x[6] | 0) & 2).length, zone: keep.drv.filter((x) => (x[6] | 0) & 4).length };
      t.mySpots.length = 0; t.sharedSpots.length = 0; t.driverSpots.rows.length = 0;
      t.driverSpots.rows.push([37.51, 127.11, 300, 50, 50, 3, 2], [37.52, 127.12, 0, 110, 110, 8, 2], [37.53, 127.13, 199, 30, 30, 3, 6], [37.54, 127.14, 15, 50, 50, 3]);
      t.sharedSpots.push({ lat: 37.55, lng: 127.15, h: 90, lim: 60, ck: 1, src: 'check' });
      t.applyUserSpots();
      const b = t.cams.userBase, u = t.cams.rows.slice(b);
      r.a = show(u[0], b); r.b = show(u[1], b + 1); r.c = show(u[2], b + 2); r.d = show(u[3], b + 3); r.e = show(u[4], b + 4);
      // (g) 경로선 굵기·테두리
      r.g = { w15: t.routeWeight('base', 15), w17: t.routeWeight('base', 17), w18: t.routeWeight('base', 18), w165: t.routeWeight('base', 16.5),
        casing17: t.routeWeight('glow', 17), dots: t.routeWeight('dots', 18), casingColor: t.ROUTE_CASING, arrow17: t.arrowPx(17) };
    } finally {
      t.camState.target = null; t.renderCam();
      t.driverSpots.rows.length = 0; keep.drv.forEach((x) => t.driverSpots.rows.push(x));
      t.sharedSpots.length = 0; keep.shared.forEach((x) => t.sharedSpots.push(x));
      t.mySpots.length = 0; keep.mine.forEach((x) => t.mySpots.push(x));
      t.applyUserSpots();
      softReset();
    }
    const a = r.a || {}, b = r.b || {}, c = r.c || {}, d = r.d || {}, e = r.e || {}, f = r.f || {}, g = r.g || {};
    const ok = a.label === '신호·과속단속' && !a.blue && a.slot === 'cam_signal' && a.short === '신호과속' && a.band === 'yellow' && a.voice === '신호 단속 카메라' &&
      b.label === '이동식단속' && b.blue && b.slot === 'cam_mobile' &&
      c.label === '어린이보호구역 신호·과속단속' && c.zone === 2 && !c.blue &&
      d.label === '운전자 신고 신호·과속단속' && d.blue && d.short === '신고 지점' && d.voice === '신고된 단속 지점' &&
      e.label === '과속단속' && !e.blue &&
      f.rows === 26 && f.checked === 26 && f.zone === 3 &&   // v210: keys 네이버 확인 — 구갈·삼가 남동 확인(네이버 자리로), 판교JC 하행 합류는 없음(뺌). v213: 비룡로 신호·과속 50 더함. v233: 동해대로 80 174° 더함
      g.w15 === 9 && g.w17 === 14 && g.w18 === 16 && g.w165 === 12.5 && g.casing17 === 18 && g.dots === 3.4 && g.casingColor === '#141414' &&
      g.arrow17 && g.arrow17.inner === 14 && g.arrow17.shaft === 18;
    return { pass: !!ok, detail: JSON.stringify(r) };
  }

  // S140: 도착을 네이버처럼 (v209, 운전자 '네이버 지도 보면은 도착지점 거의 도착할 때 화살표로 알려 주잖아. 그것처럼 우리도 그렇게 알려 주면 좋지 않을까?',
  //       '도착 건물에만 나오면 될 거 같아 화살표로 들어가는 것까지 표기 해 주면 좋을 것 같다').
  //   시험 경로: 북쪽 600m → 우회전 → 동쪽 480m, 끝 8m 앞에 좌회전(건물 쪽으로 꺾어 들어감)
  //   (a) 마지막 회전도 안내: 우회전 뒤 큰 줄 '좌회전', 그다음 칸은 도착 핀 + 건물까지 거리
  //   (b) 경로 끝 → 건물(북쪽 60m): 점선 대신 굵은 화살표(검정 테두리·흰 몸통), 거리는 건물까지(경로 끝 + 60m)
  //   (c) 회전이 없고 건물이 경로 끝 왼쪽이면 '목적지 · 왼쪽' + 화살표 옆 핀 그림, 오른쪽이면 '오른쪽', 거의 앞이면 쪽 없이 원래 핀
  //   (d) 주차장 입구로 가는 길(걸어가는 거리)은 점선 그대로, 거리에 더하지 않음
  async function s140() {
    const t = T(), r = {};
    const mk = (finalTurn, bldBrg, bldM) => {
      const R = buildNavRoute();
      R.route = JSON.parse(JSON.stringify(R.route));
      const last = R.P.length - 1;
      if (finalTurn) {
        // 끝 바로 앞(8m)에 좌회전: 마지막 점을 북쪽으로 8m 옮긴다
        const pre = dest(R.P[last], 270, 8), end = dest(pre, 0, 8);
        R.route.path[last] = [round6(pre.lng), round6(pre.lat)];
        R.route.path.push([round6(end.lng), round6(end.lat)]);
        R.route.guide = R.route.guide.filter((g) => g.t !== 88).concat([{ i: last, t: 2, s: '좌회전', d: 0, ms: 2000 }, { i: last + 1, t: 88, s: '목적지', d: 8, ms: 2000 }]);
      }
      R.P = R.route.path.map((x) => ({ lat: x[1], lng: x[0] }));
      R.cum = [0];
      for (let i = 1; i < R.P.length; i++) R.cum.push(R.cum[i - 1] + hav(R.P[i - 1], R.P[i]));
      R.total = R.cum[R.cum.length - 1];
      const E = R.P[R.P.length - 1], b = dest(E, bldBrg, bldM);
      R.dest = Object.assign({}, R.dest, { lat: b.lat, lng: b.lng });
      return R;
    };
    const snap = () => ({ turn: text('#turnDist') + ' ' + text('#turnText'), icon: (() => { const q = document.querySelector('#turnIcon svg'); return q ? q.getAttribute('class') || '' : ''; })(),
      next: visible('#nextTurn') ? text('#nextDist') + '|' + (document.getElementById('nextTurn').classList.contains('goal') ? 'goal' : 'turn') : '',
      remain: text('#navRemain'), leg: (t.getMap()._legObjs || []).length, dots: document.querySelectorAll('.destdot').length,
      legLen: t.getMap()._leg ? Math.round(hav(t.getMap()._leg[0], t.getMap()._leg[1])) : 0 });
    try {
      await waitFor(() => t.getMap(), 5000);
      // (a)(b) 마지막 좌회전 + 건물 북쪽 60m
      softReset();
      const A = mk(true, 0, 60);
      await planAndStart(A);
      let p = pointAt(A, A.cum[5] + 60); feed(p.p, 10, p.h); t.renderNav();
      r.a = snap(); r.a.guides = t.nav.guides.map((g) => g.t).join(','); r.a.legM = t.nav.leg;
      t.endNav();
      // (c) 회전 없음: 건물이 끝에서 왼쪽(북쪽 50m) · 오른쪽(남쪽 50m) · 앞(동쪽 20m)
      for (const [k, brg] of [['left', 0], ['right', 180], ['ahead', 90]]) {
        softReset();
        const C = mk(false, brg, brg === 90 ? 20 : 50);
        await planAndStart(C);
        p = pointAt(C, C.cum[5] + 300); feed(p.p, 10, p.h); t.renderNav();
        r[k] = snap(); r[k].side = t.nav.goalSide;
        t.endNav();
      }
      // (d) 주차장 입구로 (걸어가는 길): 점선, 거리 더하지 않음
      softReset();
      const D = mk(false, 0, 60);
      D.dest = Object.assign({}, D.dest, { park: { name: '시험 주차장입구', lat: D.P[D.P.length - 1].lat, lng: D.P[D.P.length - 1].lng, d: 60 } });
      await planAndStart(D);
      p = pointAt(D, D.cum[5] + 300); feed(p.p, 10, p.h); t.renderNav();
      r.park = snap(); r.park.legM = t.nav.leg;
      t.endNav();
    } finally {
      t.endNav(); softReset();
    }
    const a = r.a || {}, L = r.left || {}, Rr = r.right || {}, S = r.ahead || {}, P = r.park || {};
    const num = (x) => { const m = String(x || '').match(/([\d.]+)(k?m)/); return m ? +m[1] * (m[2] === 'km' ? 1000 : 1) : -1; };
    const ok = a.guides === '1,3,2,88' && /좌회전$/.test(a.turn) && a.next.endsWith('|goal') && num(a.next) >= 60 && num(a.next) <= 80 && a.leg === 4 && a.legLen >= 19 && a.legLen <= 21 && a.dots >= 3 /* v246: 화살표는 건물 쪽 20m, 나머지 점선 */ && a.legM === 60 &&
      L.side === 'l' && /목적지 · 왼쪽$/.test(L.turn) && /goal-side gs-l/.test(L.icon) && num(L.turn) >= 220 && num(L.turn) <= 240 &&
      Rr.side === 'r' && /목적지 · 오른쪽$/.test(Rr.turn) && /goal-side gs-r/.test(Rr.icon) &&
      S.side === 's' && /목적지$/.test(S.turn) && !/goal-side/.test(S.icon) &&
      P.legM === 0 && P.leg === 0 && P.dots >= 3;
    return { pass: !!ok, detail: JSON.stringify(r) };
  }

  // S141: 화살표 크기 한계 (v211, 운전자 '저 확대한다고해서 저화살표가 계속 커지는게 아니고 어느정도 한계가 있다고봐야 해 크기가 너무 커져도 이상해져버리니까').
  //   2026-11-24 강동 더샵 센트럴시티 화면: 화살촉만 아주 크고 몸통은 가늘었다. 원인 셋:
  //   - 네이버 GL 지도는 같은 배율 숫자에서 래스터의 두 배로 그린다 → 화살촉(미터로 그림)이 화면에서 두 배
  //   - 지운 화살표를 네이버 GL 이 잠시 뒤 다시 붙이는 때가 있다 → 먼 배율에서 그린 큰 화살표가 남았다
  //   - 마지막 회전 6m 뒤 경로가 끝나 회전 화살표와 건물 화살표가 겹쳤다
  //   (a) 굵기 한계: 배율 18·19·20·21 모두 16px, 화살표 크기도 18 과 20 이 같다
  //   (b) GL 이면 화살촉을 미터로 바꿀 때 배율 + 1 (래스터는 그대로): 화살촉 밑변(미터) = 2×half px × 그 배율의 1px 미터. 몸통 테두리 = W + 4
  //       (화면 픽셀로 재면 3D 기울기에 따라 달라서 미터로 잰다. GL 이 같은 배율에서 두 배로 그리는 것은 2026-11-24 기울기 0 에서 확인: 15·17·19 모두 2.000)
  //   (c) 지운 화살표를 지도에 다시 붙여도 보이지 않고, 잠시 뒤(1.5초) 다시 떨어진다
  //   (d) 마지막 좌회전 8m 뒤 경로 끝 + 건물 60m: 회전 → 경로 끝 → 건물 한 화살표(화살촉이 건물), 따로 그리던 건물 화살표는 숨김.
  //       회전을 지나면 경로 끝 30m 안이라 도착 — 안내가 끝나고 화살표가 모두 지워진다 (남는 화살표 없음)
  //   (e) 건물 화살표 없이(목적지 = 경로 끝) 좌회전 5m 뒤 끝: 화살촉이 회전 뒤 방향(북쪽)을 가리킨다 (예전엔 회전 전 방향이 섞였다)
  async function s141() {
    const t = T(), r = {};
    const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
    const mk = (bldM, afterM) => {
      const R = buildNavRoute();
      R.route = JSON.parse(JSON.stringify(R.route));
      const last = R.P.length - 1;
      const pre = dest(R.P[last], 270, afterM), end = dest(pre, 0, afterM);
      R.route.path[last] = [round6(pre.lng), round6(pre.lat)];
      R.route.path.push([round6(end.lng), round6(end.lat)]);
      R.route.guide = R.route.guide.filter((g) => g.t !== 88).concat([{ i: last, t: 2, s: '좌회전', d: 0, ms: 2000 }, { i: last + 1, t: 88, s: '목적지', d: afterM, ms: 2000 }]);
      R.P = R.route.path.map((x) => ({ lat: x[1], lng: x[0] }));
      R.cum = [0];
      for (let i = 1; i < R.P.length; i++) R.cum.push(R.cum[i - 1] + hav(R.P[i - 1], R.P[i]));
      R.total = R.cum[R.cum.length - 1];
      const E = R.P[R.P.length - 1], b = bldM ? dest(E, 0, bldM) : E;
      R.dest = Object.assign({}, R.dest, { lat: b.lat, lng: b.lng });
      return R;
    };
    const tri = (o) => { const a = []; o.getPaths().getAt(0).forEach((q) => a.push({ lat: q.lat(), lng: q.lng() })); return a; };
    r.a = { w18: t.routeW(18), w19: t.routeW(19), w20: t.routeW(20), w21: t.routeW(21), a18: JSON.stringify(t.arrowPx(18)), a20: JSON.stringify(t.arrowPx(20)) };
    try {
      await waitFor(() => t.getMap(), 5000);
      const m = t.getMap();
      const naverOn = !!(m.map && window.naver && naver.maps && m.map.getProjection);
      // (d) 한 화살표
      softReset();
      const D = mk(60, 8);
      await planAndStart(D);
      let p = pointAt(D, D.cum[5] + 300); feed(p.p, 10, p.h); t.renderNav();
      if (naverOn) { m.map.setZoom(18, false); await sleep(350); }
      const head = m._arrowObjs && m._arrowObjs[1];
      r.d = { arrow: (m._arrowObjs || []).length, leg: (m._legObjs || []).length, joined: !!m._arrowJoined,
        tipToBld: head && naverOn ? Math.round(hav(tri(head)[0], D.dest) * 10) / 10 : -1 };
      // (b) GL 배율: 화살촉 밑변을 미터로 재서 그 배율(GL 이면 + 1)의 1px 미터와 비교
      r.b = { gl: !!m.gl, px18: m.pxZoom ? m.pxZoom(18) : null };
      if (naverOn && m._arrowObjs && m._arrowObjs[1]) {
        const h = tri(m._arrowObjs[1]), z = m.map.getZoom(), zp = m.pxZoom(z);
        const mpp = 156543.03392 * Math.cos(h[0].lat * Math.PI / 180) / Math.pow(2, zp);
        r.b.z = z; r.b.headPx = Math.round(hav(h[1], h[2]) / mpp * 10) / 10; r.b.want = Math.round(2 * t.arrowPx(z).half * 10) / 10;
        r.b.shaft = m._arrowObjs[0].getOptions('strokeWeight'); r.b.wantShaft = t.arrowPx(z).shaft;
      }
      // (c) 지운 화살표를 다시 붙여 본다 (네이버 GL 이 잠시 뒤 다시 붙이는 것 흉내)
      if (naverOn) {
        const old = (m._arrowObjs || []).slice();
        m.drawArrow();
        old.forEach((o) => o.setMap(m.map));
        r.c = { n: old.length, hidden: old.every((o) => o.getVisible && !o.getVisible()), now: (m._arrowObjs || []).length };
        await sleep(1700);
        r.c.gone = old.every((o) => !o.getMap());
      }
      // (d) 회전을 지나면 도착 (경로 끝 30m 안): 화살표가 모두 지워진다
      p = pointAt(D, D.total - 2); feed(p.p, 5, p.h); t.renderNav();
      await sleep(50);
      r.d.after = { arrow: (m._arrowObjs || []).length, leg: (m._legObjs || []).length, joined: !!m._arrowJoined, active: !!t.nav.active };
      t.endNav();
      // (e) 건물 화살표 없이 회전 5m 뒤 끝
      softReset();
      const E = mk(0, 5);
      await planAndStart(E);
      p = pointAt(E, E.cum[5] + 300); feed(p.p, 10, p.h); t.renderNav();
      const he = m._arrowObjs && m._arrowObjs[1];
      r.e = { arrow: (m._arrowObjs || []).length, leg: (m._legObjs || []).length, joined: !!m._arrowJoined, legM: t.nav.leg };
      if (he && naverOn) {
        const q = tri(he), mid = { lat: (q[1].lat + q[2].lat) / 2, lng: (q[1].lng + q[2].lng) / 2 };
        r.e.dir = Math.round(((brg(mid, q[0]) + 540) % 360) - 180);   // 북쪽이 0
      }
      t.endNav();
    } finally {
      t.endNav(); softReset();
    }
    const a = r.a || {}, b = r.b || {}, c = r.c || {}, d = r.d || {}, e = r.e || {}, da = d.after || {};
    const ok = a.w18 === 16 && a.w19 === 16 && a.w20 === 16 && a.w21 === 16 && a.a18 === a.a20 &&
      b.px18 === (b.gl ? 19 : 18) && (!b.gl || (Math.abs(b.headPx - b.want) <= 1 && b.shaft === b.wantShaft)) &&
      (c.n == null || (c.n === 4 && c.hidden && c.gone && c.now === 4)) &&
      d.arrow === 4 && d.leg === 0 && d.joined && d.tipToBld >= 36 && d.tipToBld <= 44 /* v246: 건물(60m) 쪽으로 20m 까지만, 나머지는 점선 */ &&
      da.arrow === 0 && da.leg === 0 && !da.joined && !da.active &&
      e.arrow === 4 && e.leg === 0 && !e.joined && e.legM === 0 && Math.abs(e.dir) <= 30;
    return { pass: !!ok, detail: JSON.stringify(r) };
  }

  // S142 (v263 에 맞춤): 왼쪽 아래 카드 넓게 + 속도와 간격 (v212, 운전자 '너무 붙어있는 느낌이라 조금 와이드하게 UI 개선해주고 속도도 조금 갭을 줘').
  //   (a) 카드: 칸 사이 36px, 칸 최소 84px(카드 폭 220px 넘게), 나침반 줄 밑 얇은 줄. 앱이 카드 높이를 --trip-h 로 잰다
  //   (b) 넓은 화면(1000px 넘게, 시험은 1280×800)의 큰 속도: 숫자 칸 밑과 카드 위 사이 18px (예전엔 바닥에서 172px 고정이라 카드에 붙었다)
  //   (c) 다른 칸이 속도 숫자까지만 내려오면 숫자만 숨기고(speed-covered) 카드는 그대로, 카드까지 오면 카드도(trip-covered)
  //   (d) 804×638 에서는 속도 숫자가 없다(차 계기판에 있음) — 이 시험 창 폭에서는 넓은 화면만 본다
  async function s142() {
    const t = T(), r = {}, app = document.getElementById('app');
    const trip = document.querySelector('.trip'), head = trip && trip.querySelector('.heading'), sb = document.querySelector('.speedbox');
    const sign = document.getElementById('signCard'), keep = sign ? { hidden: sign.hidden, style: sign.getAttribute('style') } : null;
    try {
      feed({ lat: NAV_ORIGIN.lat, lng: NAV_ORIGIN.lng }, 12, 0);
      t.checkTripCover();
      await new Promise((ok) => setTimeout(ok, 80));
      const cs = getComputedStyle(trip), tr = trip.getBoundingClientRect();
      r.a = { colGap: cs.columnGap, w: Math.round(tr.width), line: getComputedStyle(head).borderBottomStyle, tripH: app.style.getPropertyValue('--trip-h'), h: Math.round(trip.offsetHeight) };
      r.wide = innerWidth >= 1000;
      if (r.wide) {
        const sr = sb.getBoundingClientRect(), fbr = document.querySelector('.fbcorner').getBoundingClientRect();
        r.b = { gap: Math.round(fbr.top - sr.bottom), shown: getComputedStyle(sb).display !== 'none' };   // v263: 속도 밑 = 왼쪽 아래 '의견' 버튼 위
        // (c) 주의 표지 칸을 속도 숫자 높이에만 걸치게
        // 제자리에서 보이게 한 뒤 위아래로만 옮긴다 (fixed 로 띄우면 offsetParent 가 없어 검사에서 빠진다)
        sign.hidden = false;
        const moveTo = (bottom) => { sign.style.transform = ''; const r0 = sign.getBoundingClientRect(); sign.style.transform = 'translateY(' + Math.round(bottom - r0.bottom) + 'px)'; };
        moveTo(sr.top + 10);
        t.checkTripCover();
        r.signOn = sign.offsetParent !== null;
        r.c1 = { speed: app.classList.contains('speed-covered'), trip: app.classList.contains('fb-covered') };
        moveTo(fbr.top + 20);
        t.checkTripCover();
        r.c2 = { speed: app.classList.contains('speed-covered'), trip: app.classList.contains('fb-covered'), op: getComputedStyle(sb).opacity };
      }
    } finally {
      if (sign && keep) { sign.hidden = keep.hidden; if (keep.style == null) sign.removeAttribute('style'); else sign.setAttribute('style', keep.style); }
      t.checkTripCover();
    }
    r.after = { speed: app.classList.contains('speed-covered'), trip: app.classList.contains('fb-covered') };
    const a = r.a || {}, b = r.b || {}, c1 = r.c1 || {}, c2 = r.c2 || {};
    // v263 (운전자 '표는 좀 작게, 조금 투명하게 blur'): 주행 기록 카드는 오른쪽 아래 작은 유리 (칸 사이 16px, 폭 140px 넘게), 가림 표시는 왼쪽 아래 '의견' 버튼(fb-covered)
    const ok = a.colGap === '16px' && a.w >= 140 && a.line === 'solid' && a.tripH === a.h + 'px' &&
      (!r.wide || (b.shown && b.gap >= 16 && b.gap <= 20 && c1.speed && !c1.trip && c2.speed && c2.trip)) &&
      !r.after.speed && !r.after.trip;
    return { pass: !!ok, detail: JSON.stringify(r) };
  }

  // S143: 예전 '놓침·틀림' 신고 25건을 keys 가 네이버 길안내로 양방향 확인 (v213). 실제 자료로 본다
  //   (a) 21232 용구대로 60 신호·과속: 네이버는 북행만(37.305554,127.105888, 116m 남쪽). 그 자리로, 찍는 방향 2°, 차로 위 점 옮김 없음,
  //       경찰 자료의 '보정역→구성역'(남행) 글은 뺀다 — 남아 있으면 글이 기하보다 먼저라 남행에 뜨고 북행에서 빠진다
  //   (b) 19618 남북대로 80: 네이버 '후면단속'(197°) → 후면 표시, 이름 '후면 과속단속'
  //   (c) 남양주 화도 비룡로 신호·과속 50 (37.687098,127.311909, 61°): 공공자료에 없던 것, 네이버 확인 지점으로 더함 (보통 카메라처럼)
  //   (d) 신갈JC 하행 이동식 110: 한 대뿐 (v214, keys 가 네이버 '목적지까지 남은 거리' 칸으로 다시 잼: 37.29103,127.10356).
  //       v191 자리(37.289158)에서 210m 북쪽으로 옮겼고, 두 번째 지점은 넣지 않는다
  async function s143() {
    const t = T(), r = {};
    await waitFor(() => t.cams.loaded, 10000, 100);
    const rows = t.cams.rows;
    const a = rows[21232], b = rows[19618];
    r.a = { lat: a[0], lng: a[1], eb: a.eb, sl: a.sl, sg: a.sg, arrow: t.cams.arrows.has(a), lim: a[2] };
    r.b = { rear: ((b[10] | 0) & 1) === 1, eb: b.eb, label: t.camLabel(b) };
    const base = t.cams.userBase || 0;
    const nv = rows.slice(base).filter((c) => Math.abs(c[0] - 37.687098) < 1e-6 && Math.abs(c[1] - 127.311909) < 1e-6);
    r.c = nv.length ? { n: nv.length, lim: nv[0][2], kind: nv[0][3], eb: nv[0].eb, nv: !!nv[0].nv, unchecked: t.spotUnchecked(nv[0]), label: t.camLabel(nv[0]) } : { n: 0 };
    const hv = (x, la, lo) => hav({ lat: x[0], lng: x[1] }, { lat: la, lng: lo });
    const d110 = t.driverSpots.rows.filter((x) => hv(x, 37.290964, 127.103557) < 400 && x[4] === 110);
    r.d = d110.length; r.dAt = d110[0] ? [d110[0][0], d110[0][1], d110[0][2], d110[0][5]] : null;
    // (e) v217: keys 가 네이버 '남은 거리' 칸으로 다시 잰 운전자 지점 22곳 중 30m 넘게 다른 것은 6번 줄 하나 — 43m 앞(37.229751,127.182203)으로
    r.e = t.driverSpots.rows[6] ? t.driverSpots.rows[6].slice(0, 5) : null;
    // (f) v218: 8번 줄(80, 208°)은 길을 따라 놓은 경로로 다시 달려 네이버 자리 34m 뒤(37.149254,127.203004)로. 2번 줄(경부 죽전 110 이동식)은 28m 라 그대로
    r.f = [t.driverSpots.rows[8] ? t.driverSpots.rows[8].slice(0, 5) : null, t.driverSpots.rows[2] ? t.driverSpots.rows[2].slice(0, 2) : null];
    const A = r.a, B = r.b, C = r.c;
    const ok = A.lat === 37.305554 && A.lng === 127.105888 && A.eb === 2 && A.sl === A.lat && A.sg === A.lng && !A.arrow && A.lim === 60 &&
      B.rear && B.eb === 197 && /후면/.test(B.label) &&
      C.n === 1 && C.lim === 50 && C.kind === 3 && C.eb === 61 && C.nv && !C.unchecked && !/운전자/.test(C.label) &&
      r.d === 1 && JSON.stringify(r.dAt) === '[37.29103,127.10356,180,8]' && JSON.stringify(r.e) === '[37.229751,127.182203,122,84,80]' &&
      JSON.stringify(r.f) === '[[37.149254,127.203004,208,84,80],[37.334139,127.103549]]';
    return { pass: !!ok, detail: JSON.stringify(r) };
  }

  // S144: 신고 기록의 주변 카메라 출처 (v215). 광명로 23339 고정 카메라 자리에서 이 차의 '놓침' 지점을 하나 두고 신고하면
  //   주변 목록에 23339 는 src 'cam', 놓침 지점은 src 'spot'·who 'mine'. 박스형·이동식 줄은 'mobile', 운전자 확인 지점은 'spot'·'driver'·nv 1
  async function s144() {
    const t = T(), r = {}, ob = t.outbox, keepPost = ob.post, keepBox = t.store.get('outbox'), keepShare = t.prefs.share;
    const keepSpots = t.mySpots.slice(), keepSpotRaw = t.store.get('mySpots');
    const CAM = { lat: 37.44165, lng: 126.8467 };
    const bodies = [];
    try {
      await waitFor(() => t.cams.loaded, 10000, 100);
      ob.inTest = true; t.store.set('outbox', null);
      ob.post = async (b) => { bodies.push(b); return { ok: true }; };
      t.prefs.share = true;
      await resetApp();
      t.mySpots.length = 0;
      t.mySpots.push({ lat: CAM.lat + 0.0003, lng: CAM.lng, h: null, kmh: 50, lim: 0, t: Date.now(), days: [], rn: '' });
      t.applyUserSpots();
      feed({ lat: CAM.lat + 0.0003, lng: CAM.lng }, 0, null);
      await t.userReport('miss');
      const b = bodies[bodies.length - 1] || {}, near = b.near || [];
      const base = near.find((x) => x.i === 23339), mine = near.find((x) => x.src === 'spot' && x.who === 'mine');
      r.base = base ? base.src : null; r.mine = mine ? { who: mine.who, lim: mine.lim, eb: mine.eb, nv: mine.nv } : null;
      r.allHaveSrc = near.length > 0 && near.every((x) => ['cam', 'mobile', 'spot'].includes(x.src));
      r.noWhoOnCams = near.filter((x) => x.src !== 'spot').every((x) => !('who' in x));
      // 박스형·이동식, 운전자 확인 지점
      const ub = t.cams.userBase, fx = t.cams.fixed;
      r.mobile = t.cams.mobile ? t.camSrc(fx, t.cams.rows[fx]) + '/' + t.camSrc(fx - 1, t.cams.rows[fx - 1]) : 'none';
      r.firstCam = t.camSrc(0, t.cams.rows[0]);
      const dv = t.cams.rows.slice(ub).find((c) => c.who === 'driver' && c.nv);
      r.driver = dv ? t.camSrc(t.cams.rows.indexOf(dv), dv) : 'none';
    } finally {
      ob.post = keepPost; ob.inTest = false; t.store.set('outbox', keepBox); t.prefs.share = keepShare;
      t.mySpots.length = 0; keepSpots.forEach((x) => t.mySpots.push(x)); t.store.set('mySpots', keepSpotRaw); t.applyUserSpots();
      softReset();
    }
    const ok = r.base === 'cam' && r.mine && r.mine.who === 'mine' && r.mine.eb === -1 && !r.mine.nv && r.allHaveSrc && r.noWhoOnCams &&
      r.mobile === 'mobile/cam' && r.firstCam === 'cam' && r.driver === 'spot';
    return { pass: !!ok, detail: JSON.stringify(r) };
  }

  // S145: 한 기둥 짝 (v216). 184 쌍은 줄마다 설치장소 글 방향으로 (두 줄의 방향 칸을 맞바꿈, 차로 위 점도 따라감), 6 쌍은 그대로
  //   (a) 129/130 완도 청해진서로 30: 129 '완도읍→군외면' 은 273°, 130 '군외면→완도읍' 은 93° (예전 93°·273°), 차로 위 점은 방향을 따라감
  //   (b) 보류: 1115/1116 평인일주로(보호구역 다름) 318°·138°, 6741/6742 68° 문제 248°·68° 그대로
  async function s145() {
    const t = T(), r = {};
    await waitFor(() => t.cams.loaded, 10000, 100);
    const rows = t.cams.rows, at = (i) => ({ eb: rows[i].eb, lane: [Math.round(rows[i].sl * 1e5), Math.round(rows[i].sg * 1e5)] });
    r.a = { r129: at(129), r130: at(130) };
    r.b = { r1115: rows[1115].eb, r1116: rows[1116].eb, r6741: rows[6741].eb, r6742: rows[6742].eb };
    const a = r.a, b = r.b;
    const ok = a.r129.eb === 273 && a.r130.eb === 93 && a.r129.lane.join() === '3432457,12670131' && a.r130.lane.join() === '3432458,12670123' &&
      b.r1115 === 318 && b.r1116 === 138 && b.r6741 === 248 && b.r6742 === 68;
    return { pass: !!ok, detail: JSON.stringify(r) };
  }

  // S146: 시험 주행이 실제 서버로 가지 않게 (v219, 2026-11-24 운영 통계: 바다 위 합성 길·가짜 시계 11-25·S1 구간 같은 시험 기록이 섞임).
  //   (a) 시험 페이지의 보낼 함(passQ·routeCur·routeOut·outbox·checks)은 'tnc.<이름>@test' 로 — 같은 주소의 다른 페이지는 'tnc.<이름>' 만 본다
  //   (b) 오늘(한국 날짜)보다 뒤 날짜 통과 기록은 보내지 않고 버린다 (기기 시계가 틀렸거나 시험의 가짜 시계)
  async function s146() {
    const t = T(), r = {}, ps = t.passStats;
    const keep = { post: ps.post, q: ps.q.slice(), cand: ps.cand.slice(), op: ps.op.slice(), pref: t.prefs.passStats, raw: localStorage.getItem('tnc.passQ@test') };
    const bodies = [];
    try {
      t.store.set('passQ', JSON.stringify({ q: [{ k: '1,1|0', d: '2000-01-01' }] }));
      r.a = { plain: localStorage.getItem('tnc.passQ'), test: !!localStorage.getItem('tnc.passQ@test'), outboxPlain: localStorage.getItem('tnc.outbox'), routePlain: localStorage.getItem('tnc.routeOut') };
      ps.inTest = true; t.prefs.passStats = true;
      ps.post = async (b) => { bodies.push(JSON.parse(JSON.stringify(b))); return { ok: true, status: 200 }; };
      const day = (n) => new Date(Date.now() + 9 * 3600e3 + n * 86400e3).toISOString().slice(0, 10);
      ps.q = [{ k: '37.5,127|0', d: day(0), lim: 50, kind: 1, a: 300, g: 0, hid: 0, kmh: 50, nav: 0, x: 1 }, { k: '37.6,127|0', d: day(1), lim: 50, kind: 1, a: 300, g: 0, hid: 0, kmh: 50, nav: 0, x: 1 }];
      ps.cand = [{ c: '37500,127000', o: 0, dr: 30, d: day(1), x: 1 }]; ps.op = []; ps.nextAt = 0;
      const sent = await t.passFlush(true);
      const b = bodies[bodies.length - 1] || {};
      r.b = { sent, items: (b.items || []).map((x) => x.k + '@' + (x.d === day(0) ? 'today' : x.d)), cand: (b.cand || []).length, left: ps.q.length + ps.cand.length };
    } finally {
      ps.post = keep.post; ps.inTest = false; t.prefs.passStats = keep.pref;
      ps.q = keep.q; ps.cand = keep.cand; ps.op = keep.op;
      if (keep.raw == null) localStorage.removeItem('tnc.passQ@test'); else localStorage.setItem('tnc.passQ@test', keep.raw);
    }
    const a = r.a, b = r.b;
    const ok = a.plain === null && a.test && a.outboxPlain === null && a.routePlain === null &&
      b.sent === true && b.items.join() === '37.5,127|0@today' && b.cand === 0 && b.left === 0;
    return { pass: !!ok, detail: JSON.stringify(r) };
  }

  // S147: keys 네이버 판정 1부 (v220) — 보호구역 짝·같은 기둥 중복 줄
  async function s147() {
    const t = T(), r = {};
    await waitFor(() => t.cams.loaded, 10000, 100);
    const rows = t.cams.rows, L = (i) => t.camLabel(rows[i]);
    const inGrid = (i) => { const c = rows[i]; return t.camsNear(c[0], c[1], 5).some((x) => x.i === i); };
    r.labels = { r1115: L(1115), r1116: L(1116), r2066: L(2066), r2067: L(2067), r26256: L(26256), r26257: L(26257), r6998: L(6998) + ' ' + rows[6998][2], r6999: L(6999) + ' ' + rows[6999][2] };
    r.off = [6743, 7628, 7629, 17756, 17757, 26263, 7543, 6006].filter((i) => inGrid(i));
    r.kept = [6741, 6742, 7621, 7623, 17755, 26256, 26257, 7539, 6003, 6007].filter((i) => !inGrid(i));
    const c = rows[17755];
    r.r17755 = { at: [c[0], c[1]], eb: c.eb, text: t.cams.arrows.has(c) };
    // v221: 7623 (295° 어린이 30) 은 네이버 자리 35.628158,128.32214 진행 방향 296 — 기둥 점보다 104m 앞
    const c2 = rows[7623];
    r.r7623 = { at: [c2[0], c2[1]], eb: c2.eb, lane: [c2.sl, c2.sg], label: t.camLabel(c2) };
    // v222: 재주행 판정 — 고주로 215°·합천 96° 는 카메라 없음(끔), 학동로 서행은 네이버 자리 244°
    // v223: 거제북로 기둥에는 179° 카메라가 없고, 다가가는 두 길에 노인보호 30 이 한 대씩 — 2027 은 서남서 길 66°, 2028 은 남쪽 길 2°
    r.off2 = [5313, 7265, 7269].filter((i) => inGrid(i));
    r.kept2 = [5312, 2027, 2028, 7267, 7268, 25548, 25549].filter((i) => !inGrid(i));
    const c3 = rows[25548];
    r.r25548 = { at: [c3[0], c3[1]], eb: c3.eb, lane: [c3.sl, c3.sg], label: t.camLabel(c3), e66: rows[25549].eb };
    const gj = (i) => { const c = rows[i]; return { at: [c[0], c[1]], eb: c.eb, lane: [c.sl, c.sg], label: t.camLabel(c), text: t.cams.arrows.has(c) }; };
    r.r2027 = gj(2027); r.r2028 = gj(2028);
    const ok = r.off2.length === 0 && r.kept2.length === 0 &&
      r.r25548.at.join() === '37.520509,127.058439' && r.r25548.eb === 244 && r.r25548.lane.join() === '37.520509,127.058439' &&
      r.r25548.label === '어린이보호구역 신호·과속단속' && r.r25548.e66 === 66 &&
      r.r2027.at.join() === '35.010499,128.683334' && r.r2027.eb === 66 && r.r2027.lane.join() === r.r2027.at.join() && r.r2027.label === '노인보호구역 과속단속' && !r.r2027.text &&
      r.r2028.at.join() === '35.009746,128.684449' && r.r2028.eb === 2 && r.r2028.lane.join() === r.r2028.at.join() && r.r2028.label === '노인보호구역 과속단속' && r.r2028.text &&
      r.labels.r1115 === '어린이보호구역 신호·과속단속' && r.labels.r1116 === '어린이보호구역 과속단속' &&
      r.labels.r2066 === '어린이보호구역 과속단속' && r.labels.r2067 === '어린이보호구역 과속단속' &&
      r.labels.r26256 === '어린이보호구역 신호·과속단속' && r.labels.r26257 === '어린이보호구역 신호·과속단속' &&
      r.labels.r6998 === '과속단속 50' && /후면/.test(r.labels.r6999) && / 50$/.test(r.labels.r6999) &&
      r.off.length === 0 && r.kept.length === 0 &&
      r.r17755.at.join() === '36.978956,127.257243' && r.r17755.eb === 254 && !r.r17755.text &&
      r.r7623.at.join() === '35.628158,128.32214' && r.r7623.eb === 296 && r.r7623.lane.join() === '35.628158,128.32214' && r.r7623.label === '어린이보호구역 과속단속';
    return { pass: !!ok, detail: JSON.stringify(r) };
  }

  // S148: keys 네이버 판정 — 단독 18 (v224)
  async function s148() {
    const t = T(), r = {};
    await waitFor(() => t.cams.loaded, 10000, 100);
    const rows = t.cams.rows;
    const inGrid = (i) => { const c = rows[i]; return t.camsNear(c[0], c[1], 5).some((x) => x.i === i); };
    const g = (i) => { const c = rows[i]; return [c.eb, c.e2, t.cams.arrows.has(c) ? 'T' : '-'].join(); };
    r.off = [1756, 1553, 25831, 16084, 16086, 21331, 18062].filter((i) => inGrid(i));
    r.kept = [743, 17901, 21632, 23035, 23272, 27681, 812, 1143, 2075, 29494, 16085, 22693, 21328, 21329, 18060, 18063].filter((i) => !inGrid(i));
    r.dir = { r743: g(743), r17901: g(17901), r21632: g(21632), r23272: g(23272), r27681: g(27681), r812: g(812), r1143: g(1143), r2075: g(2075), r29494: g(29494), r16085: g(16085), r22693: g(22693) };
    const c = rows[23035];
    r.r23035 = { at: [c[0], c[1]], eb: c.eb, lane: [c.sl, c.sg], label: t.camLabel(c), text: t.cams.arrows.has(c) };
    r.lane17901 = [rows[17901].sl, rows[17901].sg].join() === [rows[17901][0], rows[17901][1]].join();
    r.lim40 = [rows[21328][2], rows[21329][2]];
    // v232: 7번국도 동해대로 80 과속 — 네이버 자리 112° 한 방향 (경찰 자료는 201m 아래·292° 로 거꾸로였다)
    const c18 = rows[18495];
    r.r18495 = { at: [c18[0], c18[1]], eb: c18.eb, lane: [c18.sl, c18.sg], lim: c18[2], text: t.cams.arrows.has(c18) };
    // v233: 그 1.7km 남쪽 174° 80 과속 — 우리 자료에 없어 네이버 확인 지점으로 (18364·18370 은 확인 전 그대로)
    const ds = t.cams.rows.slice(t.cams.userBase).find((x) => hav({ lat: x[0], lng: x[1] }, { lat: 37.056037, lng: 129.405295 }) < 3);
    r.spot174 = ds ? { eb: ds.eb, lim: ds[2], kind: ds[3] } : null;
    r.kept18364 = [rows[18364].eb, rows[18364][2], rows[18370].eb, rows[18370][2]].join();
    // v234: keys 네이버 판정 — 18364(175°)는 없음(끔), 18370(355°)은 있음(4m). 천호 50 신호과속 145°·324°, 올림픽로 50 신호과속 206°·후면 26°
    r.off18364 = !inGrid(18364) && inGrid(18370);
    const uRows = t.cams.rows.slice(t.cams.userBase);
    const spotAt = (lat, lng) => { const x = uRows.find((q) => hav({ lat: q[0], lng: q[1] }, { lat, lng }) < 3); return x ? [x.eb, x[2], x[3], /후면/.test(t.camLabel(x)) ? 'rear' : ''].join() : 'none'; };
    r.v234 = [spotAt(37.500405, 127.11154), spotAt(37.500305, 127.111628), spotAt(37.520222, 127.114359), spotAt(37.519582, 127.113968)];
    const D = r.dir;
    const ok = r.off.length === 0 && r.kept.length === 0 &&
      D.r743 === '108,0,-' && D.r17901 === '186,0,-' && D.r21632 === '115,0,-' && D.r23272 === '321,0,T' && D.r27681 === '117,0,-' &&
      D.r812 === '27,1,-' && D.r1143 === '290,1,-' && D.r2075 === '98,1,-' && D.r29494 === '139,1,-' && D.r16085 === '9,0,T' && D.r22693 === '337,0,-' &&
      r.r23035.at.join() === '37.417022,126.917881' && r.r23035.eb === 6 && r.r23035.lane.join() === '37.417022,126.917881' &&   // v226: keys 재확인 — 어린이 표시, 네이버 자리
      /후면/.test(r.r23035.label) && /어린이보호구역/.test(r.r23035.label) && !r.r23035.text &&
      r.lane17901 && r.lim40.join() === '40,40' &&
      r.r18495.at.join() === '37.068206,129.391278' && r.r18495.eb === 112 && r.r18495.lane.join() === '37.068206,129.391278' && r.r18495.lim === 80 && r.r18495.text &&
      !!r.spot174 && r.spot174.eb === 174 && r.spot174.lim === 80 && r.spot174.kind === 1 && r.kept18364 === '175,80,355,80' &&
      r.off18364 && r.v234.join('|') === '145,50,3,|324,50,3,|206,50,3,|26,50,1,rear';
    return { pass: !!ok, detail: JSON.stringify(r) };
  }

  // S149: 의견 버튼판 (v225, 2026-11-24 21:05 운전자 테슬라 '의견을 보내고 싶은데도 못 보내네' — '음성 인식 서버에 연결하지 못했어요').
  //   (a) 음성 인식이 network 로 끝나면 알림 + 그 자리에서 버튼판(녹음 + 다섯), 이 기기는 fbMode 'panel'. 버튼은 88×72 이상, 진짜 누름이 닿는다, 길안내 카드와 겹치지 않는다
  //   (b) 다음 누름은 음성 인식을 만들지 않고 바로 버튼판
  //   (c) 버튼 하나 = 보내기 한 번: 글 '[카메라 이상]', 카드·위치는 '의견'을 누른 순간 것(그 뒤 카드가 사라져도), 판이 닫히고 '보냈어요'
  //   (d) 판 밖을 누르면 보내지 않고 닫힘, (e) '의견'을 다시 누르면 닫힘
  //   (f) 녹음: 누르고 → 다시 누르면 끝 → 녹음 함 → 올리고 번호를 받아 같은 qid 로 의견, 함은 빔. 못 올리면 함에 남고 '저장했어요 · 연결되면 보내요', 다음 보내기에서 빠짐
  //   (g) 마이크 권한 거부: '마이크 권한이 꺼져 있어요', 녹음 칸은 숨고 그림 버튼은 그대로
  async function s149() {
    const t = T(), r = {}, keepSR = window.SpeechRecognition, keepW = window.webkitSpeechRecognition;
    const md = navigator.mediaDevices, keepGum = md && md.getUserMedia, keepPost = t.fbA.post;
    const btn = document.getElementById('fbBtn'), P = () => document.getElementById('fbPanel');
    const R = buildNavRoute();
    let made = 0, ac = null;
    const hide = () => { const hp = document.getElementById('harnessPanel'); const d = hp ? hp.style.display : ''; if (hp) hp.style.display = 'none'; return () => { if (hp) hp.style.display = d; }; };
    const B = (el) => el.getBoundingClientRect();
    try {
      t.fb.inTest = true;
      t.store.set('fbMode', null); t.fb.micDenied = false; t.fbA.save([]);
      softReset();
      await planAndStart(R);
      for (let s = 15; s <= 150; s += 15) { const a = pointAt(R, s); feed(a.p, 15, a.h); }
      t.renderNav();
      // (a)
      window.webkitSpeechRecognition = undefined;
      window.SpeechRecognition = class { constructor() { made++; } start() { setTimeout(() => { if (this.onstart) this.onstart(); if (this.onaudiostart) this.onaudiostart(); if (this.onerror) this.onerror({ error: 'network' }); if (this.onend) this.onend(); }, 5); } abort() {} };
      const i = t.cams.rows.findIndex((x, j) => j < t.cams.userBase && x[4] === 0 && x[2] === 60 && x[3] === 1);
      t.camState.target = { i, c: t.cams.rows[i], d: 400, r: 400, minD: 400, after: false, t0: Date.now(), first: 600 };
      t.renderCam();
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await waitFor(() => t.fbP.open, 1000, 10);
      const bs = [...P().querySelectorAll('.fbp-btn')].filter((x) => !x.hidden);
      const pick = document.getElementById('pickCard'), pickWas = pick.hidden;
      pick.hidden = false;   // 지도에서 고른 곳 카드가 떠 있어도 버튼이 눌린다 (전체 시험에서 앞 시험이 남긴 카드가 덮었다)
      const restore = hide();
      const who = [];
      const hits = bs.map((x) => { const b = B(x); const el = document.elementFromPoint((b.left + b.right) / 2, (b.top + b.bottom) / 2); const ok = !!(el && el.closest && el.closest('.fbp-btn') === x);
        if (!ok) who.push(el ? (el.id || el.className || el.tagName) + '<' + ((el.parentElement && (el.parentElement.id || el.parentElement.className)) || '') : 'none'); return ok; });
      const np = document.getElementById('navPanel'), pb = B(P()), nb = B(np), cd = document.getElementById('camDrawer'), fbb = B(btn);
      const over = (x, y) => !(x.bottom <= y.top || x.top >= y.bottom || x.right <= y.left || x.left >= y.right);
      restore();
      pick.hidden = pickWas;
      if (/[?&]hold=1/.test(location.search)) await sleep(12000);   // 눈으로 볼 때만: 버튼판이 열린 길안내 화면을 잠깐 둔다
      r.a = { open: t.fbP.open, toast: text('#fbPanel .fbp-cap'), toastBox: !document.getElementById('toast').hidden, mode: t.store.get('fbMode'), labels: bs.map((x) => x.textContent), minW: Math.round(Math.min(...bs.map((x) => B(x).width))), minH: Math.round(Math.min(...bs.map((x) => B(x).height))),
        hits: hits.every(Boolean), who, overNav: !np.hidden && over(pb, nb), overCam: !!cd && !cd.hidden && cd.getClientRects().length > 0 && over(pb, B(cd)), overBtn: over(pb, fbb),
        inView: pb.left >= 0 && pb.right <= innerWidth && pb.top >= 0 && pb.bottom <= innerHeight, camShown: !!cd && cd.getClientRects().length > 0, pressed: btn.classList.contains('open') };
      // (c) 카드가 사라진 뒤 눌러도 '의견'을 누른 때의 카드
      t.camState.target = null; t.renderCam();
      t.fb.last = null;
      P().querySelector('.fbp-btn[data-k="cam"]').dispatchEvent(new MouseEvent('click', { bubbles: true }));
      const p = t.fb.last || {};
      await waitFor(() => /보냈어요/.test(text('#toast')), 2000, 20);
      r.c = { text: p.text, preset: p.preset, navOn: p.navOn, cam: p.cards && p.cards.cam ? p.cards.cam.limit : null, hasPos: p.lat != null, closed: !t.fbP.open && P().hidden, toast: text('#toast') };
      // (b) 다음 누름은 바로 버튼판 (음성 인식을 만들지 않는다)
      const made0 = made;
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      r.b = { open: t.fbP.open, made: made - made0 };
      // (d) 판 밖을 누르면 닫힘, 보내지 않음
      t.fb.last = null;
      document.getElementById('map').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      r.d = { open: t.fbP.open, sent: !!t.fb.last };
      // (e) '의견'을 다시 누르면 닫힘
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      const o1 = t.fbP.open;
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      r.e = { opened: o1, open: t.fbP.open };
      // (f) 녹음 — 진짜 MediaRecorder 에 소리 나는 가짜 마이크
      ac = new AudioContext();
      const dst = ac.createMediaStreamDestination(), osc = ac.createOscillator();
      osc.frequency.value = 220; osc.connect(dst); osc.start();
      md.getUserMedia = async () => dst.stream.clone();
      const posts = [];
      let fail = true;
      t.fbA.post = async (item) => { posts.push(item); return fail ? null : { id: 'A' + posts.length, via: 'fb' }; };
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      const recBtn = P().querySelector('.fbp-btn.rec');
      r.f = { recShown: !recBtn.hidden };
      recBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await waitFor(() => !!t.fbP.rec, 2000, 20);
      r.f.recording = !!t.fbP.rec && recBtn.classList.contains('on') && /^보내기 \d+$/.test(recBtn.textContent);
      await sleep(1200);
      t.fb.lastAudio = null;
      recBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));   // 다시 누르면 끝내고 보낸다 (못 올림)
      await waitFor(() => posts.length >= 1, 3000, 20);
      await waitFor(() => /저장했어요/.test(text('#toast')), 2000, 20);
      const q1 = t.fbA.load();
      const ev = t.fb.last || {};
      r.f.queued = { n: q1.length, mime: q1[0] && q1[0].mime, b64: !!(q1[0] && q1[0].b64 && q1[0].b64.length > 100), sec: q1[0] && q1[0].sec, x: q1[0] && q1[0].x, closed: !t.fbP.open, toast: text('#toast'), sent: !!t.fb.lastAudio,
        ev: { text: ev.text, how: ev.how, qid: ev.qid === (q1[0] && q1[0].qid), navOn: ev.navOn, pos: ev.lat != null } };
      fail = false;
      const fr = await t.fbAudioFlush();
      const la = t.fb.lastAudio || {};
      r.f.flushed = { r: fr, left: t.fbA.load().length, audio: la.audio, qid: la.qid === (q1[0] && q1[0].qid), msg: la.msg, via: la.audioVia, pos: la.lat != null };
      // (g) 마이크 권한 거부
      md.getUserMedia = async () => { throw new DOMException('denied', 'NotAllowedError'); };
      btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      P().querySelector('.fbp-btn.rec').dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await waitFor(() => /마이크 권한/.test(text('#fbPanel .fbp-cap')), 2000, 20);
      r.g = { toast: text('#fbPanel .fbp-cap'), recHidden: P().querySelector('.fbp-btn.rec').hidden, presets: [...P().querySelectorAll('.fbp-btn:not(.rec)')].filter((x) => !x.hidden).length, open: t.fbP.open };
      t.fbPanelClose();
      t.endNav();
    } finally {
      t.fbPanelClose();
      t.fbCancel(true);
      t.camState.target = null; t.renderCam();
      t.fbA.post = keepPost; t.fbA.save([]);
      if (md) md.getUserMedia = keepGum;
      if (ac) { try { ac.close(); } catch (e) { /* 닫힘 */ } }
      t.store.set('fbMode', null); t.fb.micDenied = false;
      t.fb.inTest = false; t.fb.last = null; t.fb.lastAudio = null;
      window.SpeechRecognition = keepSR; window.webkitSpeechRecognition = keepW;
      softReset();
    }
    const a = r.a || {}, b = r.b || {}, c = r.c || {}, d = r.d || {}, e = r.e || {}, f = r.f || {}, g = r.g || {};
    const q = f.queued || {}, fl = f.flushed || {};
    const ok = a.open && a.toast === '음성 인식 서버에 연결하지 못했어요 · 버튼으로 보내 주세요' && !a.toastBox && a.mode === 'panel' &&
      a.labels.join() === '녹음,카메라,길안내,화면,소리,좋아요' && a.minW >= 68 && a.minH >= 72 && a.hits && !a.overNav && !a.overCam && a.camShown && !a.overBtn && a.inView && a.pressed &&
      c.text === '[카메라 이상]' && c.preset === 'cam' && c.navOn === true && c.cam === 60 && c.hasPos && c.closed && c.toast === '보냈어요' &&
      b.open && b.made === 0 && !d.open && !d.sent && e.opened && !e.open &&
      f.recShown && f.recording && q.n === 1 && /^audio\//.test(q.mime || '') && q.b64 && q.sec >= 1 && q.x === 1 && q.closed && q.toast === '저장했어요 · 연결되면 보내요' && !q.sent &&
      q.ev && /^\(녹음 [\d.]+초\)$/.test(q.ev.text || '') && q.ev.how === 'audio' && q.ev.qid && q.ev.navOn === true && q.ev.pos &&
      fl.r === true && fl.left === 0 && fl.audio === 'A2' && fl.qid && fl.msg === 'feedback audio' && fl.via === 'fb' && !fl.pos &&
      g.toast === '마이크 권한이 꺼져 있어요 · 버튼으로 보내 주세요' && g.recHidden && g.presets === 5 && g.open;
    return { pass: !!ok, detail: JSON.stringify(r) };
  }

  // S150: 진행 방향대로 길찾기 (v227, 2026-11-24 21:22 운전자 성남대로 북행 신호 대기 중 '여기서 바로 유턴안돼',
  //   '내가 가는 진행방향 기준으로 길을 알려줘야지' — 새 경로가 차 자리에서 바로 남쪽(뒤)으로 돌았다. 네이버는 175m 앞 사거리 유턴).
  //   나란한 두 차로(북행·남행)인 길을 북쪽으로 달리다 신호에 멈춤, 목적지는 차 뒤(남쪽). 가짜 길찾기 서버: 25m 앞 출발은 반대편 차로에 붙어
  //   뒤로 도는 경로, 60m 넘게 앞이면 175m 앞 교차로에서 유턴하는 경로.
  //   (a) 멈춰 있어도 진행 방향을 안다  (b) 처음 길찾기: 출발점은 차 앞(북쪽) 25m → 뒤로 도는 답이면 70m 앞에서 다시 → 고른 경로는 북쪽으로 출발
  //   (c) 교통 갱신 답이 뒤로 돌면 버리고 지금 경로 그대로  (d) 경로 이탈 재탐색(느린 속도)도 앞에서 출발해 북쪽으로
  //   (e) 3분 넘게 세워 둔 차는 진행 방향을 쓰지 않는다(앞뒤로 움직여 나갈 수 있다) — 출발점 = 차 자리
  async function s150() {
    const t = T(), r = {}, keepRoute = stub.canned['/route'];
    const A = dest(NAV_ORIGIN, 180, 3000), C = dest(A, 0, 300), D = dest(A, 180, 900), U = dest(C, 0, 175);
    const mk = (pts) => {
      const path = pts.map((p) => [round6(p.lng), round6(p.lat)]);
      const P = path.map((x) => ({ lat: x[1], lng: x[0] }));
      let tot = 0; for (let i = 1; i < P.length; i++) tot += hav(P[i - 1], P[i]);
      return { distance: r0(tot), duration: r0(tot / 12 * 1000), tollFare: 0, fuelPrice: 0, path,
        guide: [{ i: P.length - 1, t: 88, s: '목적지', d: r0(tot), ms: r0(tot / 12 * 1000) }], sections: [{ i: 0, n: P.length - 1, name: '시험대로', speed: 40, cong: 1 }] };
    };
    const reversed = (s) => mk([s, dest(s, 180, 120), D]);
    const forward = (s) => { const u2 = dest(U, 90, 15); return mk([s, dest(s, 0, 20), U, u2, dest(C, 90, 15), D]); };
    let mode = 'snap', asks = [];
    const aheadOf = (q) => { const [lng, lat] = q.start.split(',').map(Number), s = { lat, lng }; const d = hav(C, s); return { s, d: d < 1 ? 0 : (Math.cos(brg(C, s) * Math.PI / 180) >= 0 ? d : -d) }; };
    stub.canned['/route'] = (q) => { const a = aheadOf(q); asks.push(Math.round(a.d)); return mode === 'rev' || a.d < 60 ? reversed(a.s) : forward(a.s); };
    const first = (route) => { const p = route && route.path; return p ? r0(brg({ lat: p[0][1], lng: p[0][0] }, { lat: p[1][1], lng: p[1][0] })) : null; };
    const goal = { name: '시험 목적지', addr: '', lat: D.lat, lng: D.lng };
    try {
      softReset();
      for (let s = 0; s <= 300; s += 15) feed(dest(A, 0, s), 12, 0);
      for (let k = 0; k < 4; k++) feed(C, 0, 0, { dt: 3000 });   // 신호 대기
      r.a = { heading: t.routeHeading(), kmh: t.state.speedKmh };
      // (b) 처음 길찾기
      asks = [];
      await withTimeout(t.planRoute(goal, false), 5000, 'planRoute');
      const alt = t.nav.alts && t.nav.alts[t.nav.altIdx];
      r.b = { asks: asks.slice(), first: first(alt), preview: !!t.nav.preview };
      t.startNav();
      // (c) 교통 갱신 답이 뒤로 돈다
      const before = t.nav.route;
      mode = 'rev'; asks = [];
      await withTimeout(t.planRoute(goal, 'traffic'), 5000, 'traffic');
      r.c = { asks: asks.slice(), kept: t.nav.route === before };
      // (d) 경로 이탈 재탐색 (멈춘 채)
      mode = 'snap'; asks = [];
      await waitFor(() => !t.nav.busy, 2000, 20);
      await withTimeout(t.planRoute(goal, true), 5000, 'reroute');
      r.d = { asks: asks.slice(), first: first(t.nav.route), active: t.nav.active };
      t.endNav();
      // (e) 3분 넘게 세워 둠
      feed(C, 0, 0, { dt: 200000 });
      asks = [];
      await withTimeout(t.planRoute(goal, false), 5000, 'parked');
      r.e = { heading: t.routeHeading(), asks: asks.slice() };
      // 판정 함수: 첫 12m 가 진행 방향과 110° 넘게 다르면 뒤로 도는 것, 출발점에서 60m 넘게 떨어져 시작하면 따지지 않는다
      const P = (pts) => pts.map((p) => [p.lng, p.lat]);
      r.f = { rev: t.startsReversed(P([C, dest(C, 180, 30)]), C, 0), fwd: t.startsReversed(P([C, dest(C, 0, 30)]), C, 0),
        side: t.startsReversed(P([C, dest(C, 270, 30)]), C, 0), far: t.startsReversed(P([dest(C, 180, 200), dest(C, 180, 260)]), C, 0) };
    } finally {
      stub.canned['/route'] = keepRoute;
      await waitFor(() => !t.nav.busy, 2000, 20);
      softReset();
    }
    const a = r.a || {}, b = r.b || {}, c = r.c || {}, d = r.d || {}, e = r.e || {}, f = r.f || {};
    const ok = a.heading === 0 && a.kmh === 0 &&
      b.asks.join() === '25,70' && b.first === 0 && b.preview &&
      c.asks.join() === '25' && c.kept &&
      d.asks.join() === '25,70' && d.first === 0 && d.active &&
      e.heading === null && e.asks.join() === '0' &&
      f.rev && !f.fwd && !f.side && !f.far;
    return { pass: !!ok, detail: JSON.stringify(r) };
  }

  // S151: 갈림 그림은 실제 길 모양, 표지 글자는 자르지 않는다 (v227, 2026-11-24 운전자 성남IC '그림은 너무 이상하게 표기',
  //   판교IC '대.. 신갈분...' — '내용이 길더라도 그거를 보여 주는 방법은 없으니까').
  //   (a) 일반도로(경충대로)에서 고리 연결로로 들어가는 진입(57 왼쪽 진입): 하늘·고속도로 장면이 아니라 위에서 본 경로 그림(고리 그대로, 270° 넘게 휨),
  //       표지 '일산 · 판교' 다 보임
  //   (b) 고속도로 위 곧은 진입은 그대로 원근 장면, 아주 긴 방면 이름도 글자마다 다 보이고 그림 칸 안
  //   (c) 유도선 갈림 그림 표지(fitSigns): 좁은 칸에서 다른 갈래 표지를 빼고 넓히고 줄여서라도 이름을 다 보인다
  async function s151() {
    const t = T(), box = TESLA_ONLY, prev = t.prefs.tesla, r = {};
    const set = (on) => { box.checked = on; box.dispatchEvent(new Event('change')); };
    const build = (raw, guide, sections, name) => {
      const path = raw.map((p) => [round6(p.lng), round6(p.lat)]);
      const P = path.map((x) => ({ lat: x[1], lng: x[0] }));
      const cum = [0];
      for (let i = 1; i < P.length; i++) cum.push(cum[i - 1] + hav(P[i - 1], P[i]));
      const total = cum[cum.length - 1];
      guide.forEach((g) => { g.d = r0(cum[g.i]); g.ms = 30000; });
      return { route: { distance: r0(total), duration: r0(total / 15 * 1000), tollFare: 0, fuelPrice: 300, path, guide, sections },
        P, cum, total, dest: { name, addr: '', lat: P[P.length - 1].lat, lng: P[P.length - 1].lng } };
    };
    const signOk = () => {
      const card = document.getElementById('juncCard'), lab = document.getElementById('juncLabel');
      const cb = card.getBoundingClientRect(), lb = lab.getBoundingClientRect();
      const names = [...lab.querySelectorAll('.sg-row b')];
      return { text: names.map((b) => b.textContent).join('|'), cut: names.some((b) => b.scrollWidth > b.clientWidth + 1) || lab.scrollWidth > lab.clientWidth + 1 || /…|\.\./.test(lab.textContent),
        inside: lb.left >= cb.left - 1 && lb.right <= cb.right + 1, fs: Math.round(parseFloat(getComputedStyle(names[0] || lab).fontSize) * 10) / 10 };
    };
    const drive = async (R, upto) => { for (let s = 20; s <= upto; s += 20) { const a = pointAt(R, s); feed(a.p, 15, a.h); t.renderNav(); } await sleep(30); t.renderNav(); };
    try {
      set(true);
      // (a) 경충대로 북행 600m → 성남IC: 오른쪽으로 빠져 시계 방향 270° 고리 → 서쪽 고속도로
      const raw = [];
      for (let k = 0; k <= 12; k++) raw.push(dest(NAV_ORIGIN, 0, 50 * k));
      const iG = raw.length - 1;
      let q = dest(raw[iG], 0, 40), h = 0;
      raw.push(q);
      while (h < 270) { h += 10; q = dest(q, h, 7); raw.push(q); }
      for (let k = 1; k <= 6; k++) raw.push(dest(q, 270, 50 * k));
      const R1 = build(raw, [{ i: iG, t: 57, s: "성남IC에서 '일산, 판교' 방면으로 왼쪽 진입" }, { i: raw.length - 1, t: 88, s: '목적지' }],
        [{ i: 0, n: iG + 1, name: '경충대로', speed: 40, cong: 1 }, { i: iG, n: raw.length - iG, name: '수도권제1순환고속도로', speed: 70, cong: 1 }], '고리 시험');
      softReset();
      await planAndStart(R1);
      await drive(R1, 300);
      const el = document.getElementById('juncCard'), sv = el.querySelector('#juncSvg svg');
      r.a = { shown: visible('#juncCard'), plan: !!(sv && sv.classList.contains('plan')), nv: el.classList.contains('nv'), turn: sv ? Number(sv.dataset.turn) : 0,
        go: !!(sv && sv.querySelector('.plan-go') && sv.querySelector('.plan-go').getAttribute('d').length > 50), place: text('#juncPlace'), sign: signOk(),
        // v238: 비스듬히 내려다본 그림 — 흰 화살표. v240: 문형 틀(nv-gan)에 표지판 — 우리 표지는 갈 쪽(왼쪽 진입 → 왼쪽),
        //   지금 길(경충대로)이 다른 길로 이어지니 반대쪽에 그 길 표지, 표지판 어디에도 길·칠·화살표가 없다(가리지 않는다)
        p3: !!(sv && sv.classList.contains('plan3')), arrow: !!(sv && sv.querySelector('.plan-ar') && sv.querySelector('.plan-ar').getAttribute('d').length > 50),
        // v242: 문형 띠 없이 그림 전체 높이 — 길 그림이 그림 높이의 60% 넘게 차지한다
        tall: sv ? Math.round(sv.querySelector('.plan-road').getBBox().height / 240 * 100) : 0,
        mineShown: !document.getElementById('juncLabel').classList.contains('sg-off'),
        // 표지판(우리 것·다른 갈래)은 모서리에 있어도 그림 칸 안에 다 들어간다 (위·아래·좌·우 2px 넘게 나가지 않는다)
        inCard: (() => { const cb = el.getBoundingClientRect(); return [document.getElementById('juncLabel'), document.getElementById('juncLabel2')].every((lab) => {
          if (!lab.innerHTML || lab.classList.contains('sg-off') || !lab.getClientRects().length) return true;
          const b = lab.getBoundingClientRect(); return b.left >= cb.left + 2 && b.right <= cb.right - 2 && b.top >= cb.top + 2 && b.bottom <= cb.bottom - 2; }); })(),
        labelSide: document.getElementById('juncLabel').classList.contains('sr') ? 'r' : document.getElementById('juncLabel').classList.contains('sl') ? 'l' : '',
        other: text('#juncLabel2'), otherSide: document.getElementById('juncLabel2').classList.contains('sr') ? 'r' : '',
        cover: (() => {
          if (!sv) return -1;
          const parts = [...sv.querySelectorAll('.plan-road,.plan-go,.plan-ar')], ctm = sv.getScreenCTM().inverse();
          let hit = 0;
          for (const lab of [document.getElementById('juncLabel'), document.getElementById('juncLabel2')]) {
            if (!lab.innerHTML || lab.classList.contains('sg-off') || !lab.getClientRects().length) continue;
            const b = lab.getBoundingClientRect();
            for (let i = 0; i <= 8; i++) for (let k = 0; k <= 4; k++) {
              const q = new DOMPoint(b.left + b.width * i / 8, b.top + b.height * k / 4).matrixTransform(ctm);
              if (parts.some((el) => el.isPointInFill(q))) hit++;
            }
          }
          return hit;
        })() };
      if (/[?&]hold=1/.test(location.search)) await sleep(9000);   // 눈으로 볼 때만
      t.endNav();
      // (b) 고속도로 위 곧은 진입, 아주 긴 방면 이름
      const raw2 = [];
      for (let k = 0; k <= 30; k++) raw2.push(dest(NAV_ORIGIN, 0, 100 * k));
      const long = "'인천국제공항, 영종대교기념관'";   // 방면은 두 이름까지, 5자 넘는 이름만 있을 때 가장 길다 (dirNames)
      const R2 = build(raw2, [{ i: 12, t: 66, s: '판교IC에서 ' + long + ' 방면으로 오른쪽 고속도로 진입' }, { i: 30, t: 88, s: '목적지' }],
        [{ i: 0, n: 31, name: '경부고속도로', speed: 80, cong: 1 }], '긴 이름 시험');
      softReset();
      await planAndStart(R2);
      await drive(R2, 600);
      const sv2 = document.querySelector('#juncCard #juncSvg svg');
      r.b = { shown: visible('#juncCard'), nv: !!(sv2 && sv2.classList.contains('nv')), sign: signOk() };
      if (/[?&]hold=1/.test(location.search)) await sleep(9000);   // 눈으로 볼 때만
      t.endNav();
      // (c) 유도선 갈림 그림 표지 — 좁은 칸
      const host = document.getElementById('colorRow').cloneNode(false);
      host.id = 'fitTest'; host.className = 'colorrow split'; host.hidden = false;
      host.style.cssText = 'position:fixed;left:10px;top:10px;width:260px;z-index:5000;display:block';
      host.innerHTML = '<div class="cl-sw" style="width:250px;height:70px">' +
        '<span class="sp-sign sp-ours sp-far"><i class="sg-shield">' + '</i><span class="sp-names"><b>인천국제공항</b><b>영종대교기념관</b></span></span>' +
        '<span class="sp-sign sp-other sp-mid"><b>서울외곽순환고속도로</b></span></div>';
      document.body.appendChild(host);
      const sw = host.querySelector('.cl-sw'), ours = sw.querySelector('.sp-ours'), oth = sw.querySelector('.sp-other');
      const fitted = t.fitSigns(sw, ours, [oth]);
      const sb = sw.getBoundingClientRect(), ob = ours.getBoundingClientRect();
      r.c = { fitted, inside: ob.left >= sb.left - 1 && ob.right <= sb.right + 1, cut: [...ours.querySelectorAll('b')].some((b) => b.scrollWidth > b.clientWidth + 1) || ours.scrollWidth > ours.clientWidth + 1,
        names: [...ours.querySelectorAll('b')].map((b) => b.textContent).join('|'), otherOff: oth.classList.contains('sg-off') || !oth.getClientRects().length || (() => { const q = oth.getBoundingClientRect(); return ob.right + 4 <= q.left || q.right + 4 <= ob.left; })() };
      host.remove();
    } finally {
      set(prev);
      softReset();
    }
    const a = r.a || {}, b = r.b || {}, c = r.c || {};
    const ok = a.shown && a.plan && !a.nv && a.turn >= 200 && a.go && a.place === '성남IC' && a.sign.text === '일산|판교' && !a.sign.cut && a.sign.inside &&
      a.p3 && a.arrow && a.tall >= 60 && a.mineShown && a.inCard && a.labelSide === 'l' && a.other === '경충대로' && a.cover === 0 &&
      b.shown && b.nv && b.sign.text === '인천국제공항|영종대교기념관' && !b.sign.cut && b.sign.inside && b.sign.fs >= 10.5 &&
      c.fitted && c.inside && !c.cut && c.names === '인천국제공항|영종대교기념관' && c.otherOff;
    return { pass: !!ok, detail: JSON.stringify(r) };
  }

  // S152: 도착 핀은 건물에 (v228, 2026-11-24 '기흥역엘리시아트원101동입구' 도착: 핀이 블록 서쪽 길 위(입구 검색 좌표)에 —
  //   운전자 '도착을 이 표시 엘리아 있는 거에다가 찍어 줘야 돼').
  //   (a) 고른 곳이 '…101동입구'고 주차장 입출구가 있으면: 경로는 주차장 입구로, 도착 핀은 '테스트아파트 101동' 건물 자리, 점선은 P → 건물
  //   (b) 주차장 입구가 없으면: 경로 끝은 고른 입구, 핀은 건물, 도착 화살표(v209)가 건물까지
  //   (c) 'N동'이 없으면 단지 자리  (d) 입구가 아닌 곳(가게)은 건물을 찾지 않는다  (e) 400m 넘게 먼 같은 이름은 쓰지 않는다
  async function s152() {
    const t = T(), r = {};
    const raw = [];
    for (let k = 0; k <= 29; k++) raw.push(dest(NAV_ORIGIN, 0, 10 * k));
    raw.push(dest(raw[29], 270, 8));
    const path = raw.map((p) => [round6(p.lng), round6(p.lat)]);
    const P = path.map((x) => ({ lat: x[1], lng: x[0] }));
    const cum = [0];
    for (let i = 1; i < P.length; i++) cum.push(cum[i - 1] + hav(P[i - 1], P[i]));
    const total = cum[cum.length - 1];
    const route = { distance: r0(total), duration: r0(total / 8 * 1000), tollFare: 0, fuelPrice: 0, path,
      guide: [{ i: 29, t: 3, s: '우회전', d: r0(cum[29]), ms: 30000 }, { i: 30, t: 88, s: '목적지', d: r0(cum[30] - cum[29]), ms: 1000 }],
      sections: [{ i: 0, n: 31, name: '테스트로', speed: 30, cong: 1 }] };
    const E = P[30], D = dest(E, 300, 70), B = dest(E, 290, 32), C = dest(E, 250, 45), FAR = dest(E, 0, 900);
    const pt = (q) => q.lng.toFixed(6) + ',' + q.lat.toFixed(6);
    const near = (a, b, m) => !!a && !!b && hav(a, b) <= (m || 2);
    let parks = true, dongItems = true, complexFar = false;
    const qs = [];
    stub.canned['/search'] = (q) => {
      const s = q.query || ''; qs.push(s);
      if (/주차장입구/.test(s)) return { items: parks ? [{ name: '테스트아파트101동주차장입출구', category: '도로시설>방면정보', addr: '', lat: E.lat, lng: E.lng }] : [] };
      if (/ 101동$/.test(s)) return { items: dongItems ? [{ name: '테스트아파트101동입구', category: '도로시설>방면정보', addr: '', lat: D.lat, lng: D.lng },
        { name: '테스트아파트 101동', category: '부동산>아파트', addr: '', lat: B.lat, lng: B.lng }] : [] };
      if (s === '테스트아파트') return { items: [{ name: '테스트아파트', category: '부동산>아파트', addr: '', lat: (complexFar ? FAR : C).lat, lng: (complexFar ? FAR : C).lng }] };
      return { items: [] };
    };
    stub.canned['/route'] = route;
    const markers = () => { const m = t.getMap(); return (m && m.destMk) || []; };
    const htmlOf = (mk) => { try { const ic = mk.getIcon ? mk.getIcon() : mk.options.icon; return ic.content ? ic.content.outerHTML : (ic.options && ic.options.html) || ''; } catch (e) { return ''; } };
    const posOf = (mk) => { const ll = mk.getLatLng ? mk.getLatLng() : mk.getPosition(); return { lat: typeof ll.lat === 'function' ? ll.lat() : ll.lat, lng: typeof ll.lng === 'function' ? ll.lng() : ll.lng }; };
    const pin = () => { const mk = markers().find((x) => /destpin/.test(htmlOf(x))); return mk ? posOf(mk) : null; };
    const dots = () => markers().filter((x) => /destdot/.test(htmlOf(x))).map(posOf);
    const go = async (item) => {
      feed(P[0], 0, null);
      const c0 = stub.calls.length;
      await withTimeout(t.pickDest(item), 5000, 'pickDest');
      await waitFor(() => stub.count('/route', c0) >= 1 && !t.nav.busy, 3000);
      const q = stub.since(c0, '/route')[0];
      if (!t.nav.active) t.startNav();
      return q ? q.query.goal : 'none';
    };
    const entrance = { name: '테스트아파트101동입구', addr: '', lat: D.lat, lng: D.lng, category: '도로시설>방면정보' };
    try {
      await waitFor(() => t.getMap(), 10000, 100);   // 핀은 지도가 있어야 그려진다 (이 시험이 맨 먼저 돌 때)
      softReset();
      // (a)
      const g1 = await go(entrance);
      const d1 = t.nav.dest || {}, ds = dots();
      r.a = { goal: g1 === pt(E) ? 'park' : g1 === pt(D) ? 'entrance' : g1, dest: near(d1, B) ? 'building' : near(d1, D) ? 'entrance' : 'other', entry: near(d1.entry, D), bld: d1.bld,
        pin: near(pin(), B) ? 'building' : near(pin(), D) ? 'entrance' : String(!!pin()), dots: ds.length, dotsLine: ds.length > 0 && ds.every((q) => hav(q, E) < hav(E, B) && hav(q, B) < hav(E, B)), name: d1.name };
      t.endNav(); softReset();
      // (b) 주차장 입구 없음
      parks = false;
      const g2 = await go(entrance);
      const d2 = t.nav.dest || {}, m2 = t.getMap();
      r.b = { goal: g2 === pt(D) ? 'entrance' : g2 === pt(E) ? 'park' : g2, dest: near(d2, B) ? 'building' : 'other', gate: !!(d2.park && d2.park.gate),
        // v246: 건물 쪽으로 20m 꺾어 들어가는 화살표(끝이 건물 쪽) + 그 뒤 점선 — 20m 안이면 건물까지
        leg: !!(m2 && m2._leg && (near(m2._leg[1], B) || (hav(m2._leg[1], B) < hav(m2._leg[0], B) && hav(m2._leg[0], m2._leg[1]) <= 21 && (dots().length > 0 || hav(m2._leg[1], B) < 12)))),
        legEnd: m2 && m2._leg ? Math.round(hav(m2._leg[1], B)) : -1, pin: near(pin(), B) };
      t.endNav(); softReset();
      // (c) 'N동' 없음 → 단지
      parks = true; dongItems = false;
      await go(entrance);
      r.c = { dest: near(t.nav.dest, C) ? 'complex' : near(t.nav.dest, D) ? 'entrance' : 'other' };
      t.endNav(); softReset();
      // (e) 단지가 900m 밖
      complexFar = true;
      await go(entrance);
      r.e = { dest: near(t.nav.dest, D) ? 'entrance' : 'other', entry: !!(t.nav.dest && t.nav.dest.entry) };
      t.endNav(); softReset();
      // (d) 입구가 아닌 가게
      qs.length = 0;
      const shop = dest(E, 270, 40);
      await go({ name: '테스트카페', addr: '', lat: shop.lat, lng: shop.lng, category: '음식점>카페' });
      r.d = { dest: near(t.nav.dest, shop) ? 'shop' : 'other', bldQueries: qs.filter((x) => / 101동$/.test(x) || x === '테스트카페').length };
      t.endNav(); softReset();
    } finally {
      t.endNav(); softReset();
      stub.canned['/search'] = { items: [] };
    }
    const a = r.a || {}, b = r.b || {}, c = r.c || {}, d = r.d || {}, e = r.e || {};
    const ok = a.goal === 'park' && a.dest === 'building' && a.entry && a.bld === '테스트아파트 101동' && a.pin === 'building' && a.dots > 0 && a.dotsLine && a.name === '테스트아파트101동입구' &&
      b.goal === 'entrance' && b.dest === 'building' && b.gate && b.leg && b.pin &&
      c.dest === 'complex' && e.dest === 'entrance' && !e.entry && d.dest === 'shop' && d.bldQueries === 0;
    return { pass: !!ok, detail: JSON.stringify(r) };
  }

  // S153: 주행 기록 끝·이어 가기 (v229, 2026-11-24 D1 에 운전자 한 주행이 둘로 — 강동→성남(끝남)·성남→기흥(21:46 도착·주차 뒤 21:52 에도 안 끝남)).
  //   (a) 길안내 중 11분 서 있다가 다시 달려도 같은 주행 번호 (예전엔 5분이면 끝)
  //   (b) 길안내 중 7분 멈춘 뒤 페이지를 다시 열면('새 버전') 같은 주행, 길안내 없이 7분이면 끝
  //   (c) 목적지에 도착해 1분 서 있으면 끝(end 1)
  //   (d) 도착 뒤 위치가 더 오지 않아도(지하 주차장) 시계로 1분이 지나면 끝
  //   (e) 도착 뒤 화면을 닫으면 바로 끝을 keepalive 로 보낸다. 달리는 중 화면을 닫으면(새로고침) 끝내지 않는다
  async function s153() {
    const t = T(), r = {}, rr = t.routeRec;
    const keep = { post: rr.post, pref: t.prefs.routeShare, note: t.store.get('routeNote') };
    const bodies = [];
    const R = buildNavRoute();
    const ends = (rid) => bodies.some((b) => b.end === 1 && (!rid || b.rid === rid));
    const arrive = async () => {
      await planAndStart(R);
      for (let s = 15; s <= R.total; s += 15) { const a = pointAt(R, s); feed(a.p, 12, a.h); if (!t.nav.active) break; }
      return !t.nav.active;
    };
    try {
      rr.inTest = true;
      rr.post = async (b) => { bodies.push(Object.assign(JSON.parse(JSON.stringify(b)), { keepalive: !!rr.keep })); return { ok: true, status: 200 }; };
      t.prefs.routeShare = true; t.routeClear(); t.store.set('routeNote', '1');
      softReset();
      // (a)
      await planAndStart(R);
      for (let s = 15; s <= 300; s += 15) { const a = pointAt(R, s); feed(a.p, 12, a.h); }
      const rid0 = rr.cur && rr.cur.rid, stopAt = pointAt(R, 300).p;
      for (let k = 0; k < 11; k++) feed(stopAt, 0, 0, { dt: 60000 });
      for (let s = 315; s <= 420; s += 15) { const a = pointAt(R, s); feed(a.p, 12, a.h); }
      r.a = { rid: !!rid0, same: !!rr.cur && rr.cur.rid === rid0, ended: ends(rid0), navTo: !!(rr.cur && rr.cur.navTo) };
      // (b) 다시 열기
      const c = rr.cur;
      t.routeStartup(c.lastMove + 7 * 60000);
      r.b = { kept: rr.cur === c && !ends(rid0) };
      rr.cur.navTo = 0;
      t.routeStartup(rr.cur.lastMove + 7 * 60000);
      r.b.endedNoNav = !rr.cur && ends(rid0);
      t.endNav(); softReset();
      // (c) 도착 → 1분
      bodies.length = 0;
      r.c = { arrived: await arrive() };
      const rid1 = rr.cur && rr.cur.rid;
      r.c.arrivedMark = !!(rr.cur && rr.cur.arrivedAt);
      const endP = pointAt(R, R.total).p;
      feed(endP, 0, 0, { dt: 30000 });
      r.c.at30 = !ends(rid1);
      feed(endP, 0, 0, { dt: 40000 });
      r.c.ended = !rr.cur && ends(rid1);
      softReset();
      // (d) 도착 뒤 위치가 오지 않음 — 시계로 1분
      bodies.length = 0;
      r.d = { arrived: await arrive() };
      const rid2 = rr.cur && rr.cur.rid;
      r.d.at30 = !t.routeIdleCheck(Date.now() + 30000) && !!rr.cur;
      r.d.ended = t.routeIdleCheck(Date.now() + 75000) && !rr.cur && ends(rid2);
      softReset();
      // (e) 도착 뒤 화면 닫기 / 달리는 중 화면 닫기
      bodies.length = 0;
      r.e = { arrived: await arrive() };
      const rid3 = rr.cur && rr.cur.rid;
      t.routeHide();
      const eb = bodies.find((b) => b.end === 1 && b.rid === rid3);
      r.e.ended = !rr.cur && !!eb; r.e.keepalive = !!(eb && eb.keepalive); r.e.keepOff = !rr.keep; r.e.outEmpty = rr.out.length === 0; r.e.once = bodies.filter((b) => b.rid === rid3 && b.end === 1).length === 1;
      softReset();
      await planAndStart(R);
      for (let s = 15; s <= 300; s += 15) { const a = pointAt(R, s); feed(a.p, 12, a.h); }
      const c4 = rr.cur;
      bodies.length = 0;
      t.routeHide();
      r.e.movingKept = !!c4 && rr.cur === c4 && !ends();
      t.endNav();
    } finally {
      rr.post = keep.post; rr.inTest = false; rr.keep = false; t.prefs.routeShare = keep.pref;
      t.routeClear(); t.store.set('routeNote', keep.note);
      softReset();
    }
    const a = r.a || {}, b = r.b || {}, c = r.c || {}, d = r.d || {}, e = r.e || {};
    const ok = a.rid && a.same && !a.ended && a.navTo && b.kept && b.endedNoNav &&
      c.arrived && c.arrivedMark && c.at30 && c.ended && d.arrived && d.at30 && d.ended &&
      e.arrived && e.ended && e.keepalive && e.keepOff && e.outEmpty && e.once && e.movingKept;
    return { pass: !!ok, detail: JSON.stringify(r) };
  }

  // S154: 밤이면 처음 그리는 화면부터 어둡게 (v230, 2026-11-24 운전자 '업데이트하고 브라우저 다시 켜질 때 다크모드 유지하고 있을 때
  //   켜지면 다크모드에서 켜져야 해. 갑자기 너무 밝아') + 이벤트의 익명 기기 번호.
  //   (a) index.html: 밤 판단 스크립트와 어두운 바탕 style 이 모든 바깥 CSS·스크립트보다 앞, 글꼴 CSS 는 그리기를 막지 않음(media print → all),
  //       밤 GL 지도는 다크 스타일 전까지 그림을 숨기는 규칙
  //   (b) 그 스크립트만 따로 돌려 보면: 늘 어둡게 → 밤, 늘 밝게 → 낮, 자동은 지난번 대략 위치의 해 높이 (서울 22시 밤·12시 낮·18시 밤, 부산 위치도)
  //   (c) 늘 어둡게로 저장된 채 index.html 을 열면 앱이 돌기 전 <html> 이 boot-night, 바탕이 어둡다 (늘 밝게면 표시 없음)
  //   (d) 낮이 되면 앱이 표시와 지도 숨김을 걷는다  (e) /event 에 익명 기기 번호(dev = devId)
  async function s154() {
    const t = T(), r = {}, keepMode = localStorage.getItem('tnc.nightMode'), keepPos = localStorage.getItem('tnc.sunPos');
    const html = await (await realFetch(rootDir + 'index.html', { cache: 'no-store' })).text();
    const at = (re) => { const m = html.search(re); return m < 0 ? Infinity : m; };
    const iBoot = at(/<script>\s*\(function \(\) \{\s*var night = false;/), iStyle = at(/<style>html \{ background: #0b0d10; \}/);
    const iLink = at(/<link rel="stylesheet"/), iScript = at(/<script src=/);
    r.a = { bootFirst: iBoot < iLink && iBoot < iScript, styleFirst: iStyle < iLink && iStyle < iScript,
      fontAsync: /pretendard[^>]+media="print" onload="this\.media='all'"/.test(html), waitRule: /#map\.night-wait \.mapcanvas canvas \{ visibility: hidden; \}/.test(html) };
    // (b) 스크립트만 따로
    const code = (html.match(/<script>\s*(\(function \(\) \{\s*var night = false;[\s\S]*?\}\)\(\);)\s*<\/script>/) || [])[1] || '';
    const run = (mode, pos, ms) => {
      const store = { 'tnc.nightMode': mode, 'tnc.sunPos': pos }, de = { className: '', style: {} };
      const D = { now: () => ms };
      try { new Function('localStorage', 'document', 'Date', code)({ getItem: (k) => (k in store ? store[k] : null) }, { documentElement: de }, D); } catch (e) { return 'ERR ' + e.message; }
      return /boot-night/.test(de.className) ? 'night' + (de.style.colorScheme === 'dark' ? '+dark' : '') : 'day';
    };
    const kst = (h) => Date.UTC(2026, 10, 24, h - 9, 0, 0);
    r.b = { on: run('on', null, kst(12)), off: run('off', null, kst(22)), s22: run(null, null, kst(22)), s12: run(null, null, kst(12)), s18: run(null, null, kst(18)),
      busan12: run(null, '35.1,129.0', kst(12)), busan22: run(null, '35.1,129.0', kst(22)), junk: run(null, 'x,y', kst(22)), len: code.length };
    // (c) 저장된 설정으로 index.html 열기 (?catalog: 지도·GPS 는 켜지 않는다)
    const open = (mode) => new Promise((res) => {
      if (mode) localStorage.setItem('tnc.nightMode', mode); else localStorage.removeItem('tnc.nightMode');
      const f = document.createElement('iframe');
      f.style.cssText = 'position:fixed;left:-2000px;top:0;width:804px;height:638px;border:0';
      f.src = '../index.html?catalog&r=' + Date.now();
      let done = false;
      const finish = () => {
        if (done) return; done = true;
        let out = {};
        try {
          const de = f.contentDocument.documentElement, bg = f.contentWindow.getComputedStyle(de).backgroundColor;
          const m = bg.match(/\d+(\.\d+)?/g) || ['255', '255', '255'], lum = (0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2]) / 255;
          out = { boot: de.classList.contains('boot-night'), lum: Math.round(lum * 100) / 100 };
        } catch (e) { out = { err: e.message }; }
        f.remove();
        res(out);
      };
      // 앱 스크립트를 기다리지 않고: 문서가 읽히자마자(DOMContentLoaded 전에도) 본다
      f.addEventListener('load', finish);
      const poll = setInterval(() => { try { if (f.contentDocument && f.contentDocument.documentElement && f.contentDocument.head && f.contentDocument.head.querySelector('style')) { clearInterval(poll); finish(); } } catch (e) { /* 아직 */ } }, 5);
      setTimeout(() => { clearInterval(poll); finish(); }, 8000);
      document.body.appendChild(f);
    });
    try {
      r.c = { on: await open('on'), off: await open('off') };
      // (d) 낮이 되면 걷는다
      const map = document.getElementById('map');
      map.classList.add('night-wait');
      t.setNightMode('off');
      r.d = { boot: document.documentElement.classList.contains('boot-night'), wait: map.classList.contains('night-wait'), cs: document.documentElement.style.colorScheme };
      t.setNightMode('on');
      r.d.bootOn = document.documentElement.classList.contains('boot-night');
      // (e) 익명 기기 번호
      const ev = t.eventBody('info', { msg: 'x' });
      r.e = { dev: ev.dev, same: !!ev.dev && ev.dev === t.devId, keys: Object.keys(ev).filter((k) => /name|account|email/i.test(k)).length };
    } finally {
      if (keepMode) localStorage.setItem('tnc.nightMode', keepMode); else localStorage.removeItem('tnc.nightMode');
      if (keepPos) localStorage.setItem('tnc.sunPos', keepPos); else localStorage.removeItem('tnc.sunPos');
      t.setNightMode(keepMode || 'auto');
    }
    const a = r.a, b = r.b, c = r.c || {}, d = r.d || {}, e = r.e || {};
    const ok = a.bootFirst && a.styleFirst && a.fontAsync && a.waitRule &&
      b.on === 'night+dark' && b.off === 'day' && b.s22 === 'night+dark' && b.s12 === 'day' && b.s18 === 'night+dark' && b.busan12 === 'day' && b.busan22 === 'night+dark' && b.junk === 'night+dark' &&
      c.on && c.on.boot && c.on.lum < 0.1 && c.off && !c.off.boot && c.off.lum < 0.1 &&
      !d.boot && !d.wait && d.cs === '' && d.bootOn &&
      e.same && e.keys === 0;
    return { pass: !!ok, detail: JSON.stringify(r) };
  }

  // S155: 교차로 카메라는 그 접근로를 달린 차에만 (v236, 운전자가 그린 강동세무서 사거리 천호대로 × 양재대로 — 천호대로 동쪽에서 서쪽을 찍는 카메라,
  //   양재대로로 올라와 좌회전: '좌회전 하고 난 방향에서 전진 교차로 넘기 전 차량을 찍는 거면 안 보여줘도 됨',
  //   '교차로를 넘어가고 좌회전이랑 동일한 방향으로 가는 … 그런 경우는 거의 없지만 그럼 보여주고').
  //   합성 교차로 X: K = 동쪽 접근로 정지선(X 동쪽 18m) 서향 50 신호·과속, W = 서쪽 길 X 지나 60m 서향 50 과속, R = 다른 곳 30 과속 북향.
  //   (a) 남쪽에서 올라와 좌회전하는 길안내: K 는 경로 위 목록에서 빠지고 뜨지 않는다, W 는 뜬다
  //   (b) 천호대로를 서쪽으로 곧장 지나는 길안내: K 가 뜬다
  //   (c) 통과 통계: 좌회전해 K 옆을 지난 것은 o 1(꺾어 들어옴, '경고 없음' 아님), 곧장 지난 것은 o 없음
  //   (d) 카메라 30 을 12m 옆 길로 90km/h 로 지난 것은 o 2(나란한 다른 길)
  async function s155() {
    const t = T(), r = {}, ps = t.passStats;
    const X = { lat: 36.95, lng: 129.75 };   // 바다 위 (실제 카메라 없음)
    const at = (b, m) => dest(X, b, m);
    const en = (e, n) => dest(dest(X, e >= 0 ? 90 : 270, Math.abs(e)), n >= 0 ? 0 : 180, Math.abs(n));   // X 에서 동쪽 e·북쪽 n 미터
    const keep = { drv: t.driverSpots.rows.slice(), shared: t.sharedSpots.slice(), mine: t.mySpots.slice(), post: ps.post, pref: t.prefs.passStats, q: t.store.get('passQ') };
    const fakes = [];
    const mk = (p, eb, lim, kind) => { const c = [round6(p.lat), round6(p.lng), lim, kind, 0, 0, 0, -1, 4, 1]; c.eb = eb; c.e2 = 0; c.lv = 0; c.sl = c[0]; c.sg = c[1]; c.on = ''; return c; };
    const route = (pts, guide) => {
      const PP = pts.map((p) => ({ lat: round6(p.lat), lng: round6(p.lng) })), cum = [0];
      for (let i = 1; i < PP.length; i++) cum.push(cum[i - 1] + hav(PP[i - 1], PP[i]));
      const total = cum[cum.length - 1];
      const g = guide.map((x) => Object.assign({ d: r0(cum[x.i]), ms: 10000 }, x)).concat([{ i: PP.length - 1, t: 88, s: '목적지', d: r0(total), ms: 1000 }]);
      return { route: { distance: r0(total), duration: r0(total / 14 * 1000), tollFare: 0, fuelPrice: 0, path: PP.map((p) => [p.lng, p.lat]), guide: g,
        sections: [{ i: 0, n: PP.length, name: '', speed: 50, cong: 1 }] }, P: PP, cum, total, dest: { name: '시험', addr: '', lat: PP[PP.length - 1].lat, lng: PP[PP.length - 1].lng } };
    };
    const line = (b0, from, to, step) => { const out = []; for (let m = from; to > from ? m <= to : m >= to; m += step) out.push(m >= 0 ? at(b0, m) : at((b0 + 180) % 360, -m)); return out; };
    let base0 = null, K = null, W = null, R = null;
    const drive = async (R2, kmh, nav) => {
      const hit = new Set();
      hit.onRoute = new Set();   // 길안내를 시작한 뒤 경로 위 카메라 (도착하면 길안내가 끝나 목록이 사라지므로 미리)
      if (nav) { softReset(); await planAndStart(R2); t.ensureRouteCams(); for (const x of t.nav.routeCamList || []) hit.onRoute.add(x.c); } else { await resetApp(); softReset(); }
      for (let s = 0; s <= R2.total; s += kmh / 3.6) {
        const a = pointAt(R2, s);
        feed(a.p, kmh / 3.6, a.h, { dt: 1000, acc: 3 });
        const tg = t.camState.target;
        if (tg && tg.c) hit.add(tg.c);
      }
      for (let k = 0; k < 3; k++) { const a = pointAt(R2, R2.total); feed(dest(a.p, a.h, 80 * (k + 1)), kmh / 3.6, a.h, { dt: 1000, acc: 3 }); }   // 카메라에서 멀어져 통과로 센다
      return hit;
    };
    try {
      t.driverSpots.rows.length = 0; t.sharedSpots.length = 0; t.mySpots.length = 0;
      t.applyUserSpots(); base0 = t.cams.rows.length;
      // K: 동쪽 접근로 정지선(교차로 모서리, X 에서 동 8m·북 6m — 서행 차로), W: 서쪽 길 X 지나 60m, R: 30 과속
      K = mk(en(8, 6), 270, 50, 3); W = mk(at(270, 60), 270, 50, 1); R = mk(dest(at(0, 3000), 90, 12), 0, 30, 1);
      for (const c of [K, W, R]) { const i = t.cams.rows.length; t.cams.rows.push(c); fakes.push(i); const k = Math.floor(c[0] / 0.01) + ':' + Math.floor(c[1] / 0.01); if (!t.cams.grid.has(k)) t.cams.grid.set(k, []); t.cams.grid.get(k).push(i); }
      t.cams.userBase = null; t.applyUserSpots();
      ps.inTest = true; t.prefs.passStats = true; ps.post = async () => ({ ok: true, status: 200 }); ps.q.length = 0;
      // 남쪽 500m 에서 북행, X 에서 반지름 15m 로 좌회전해 서행 500m (실제 차처럼 돌며 지나간다 — 카메라에 가장 가까울 때 이미 서쪽을 반쯤 본다)
      const arc = []; for (let th = 0; th <= 90; th += 7.5) arc.push(en(-15 + 15 * Math.cos(th * Math.PI / 180), -15 + 15 * Math.sin(th * Math.PI / 180)));
      const south = []; for (let n = -500; n < -15; n += 20) south.push(en(0, n));
      const west = []; for (let e = -35; e >= -500; e -= 20) west.push(en(e, 0));
      const left = route(south.concat(arc, west), [{ i: south.length + 6, t: 2, s: '좌회전' }]);
      const straight = route(line(90, 500, 0, -20).concat(line(270, 20, 500, 20)), [{ i: 25, t: 1, s: '직진' }]);
      // (a)
      const hitA = await drive(left, 50, true);
      r.a = { kOnRoute: hitA.onRoute.has(K), wOnRoute: hitA.onRoute.has(W), kAlert: hitA.has(K), wAlert: hitA.has(W) };
      t.endNav();
      // (b)
      const hitB = await drive(straight, 50, true);
      r.b = { kOnRoute: hitB.onRoute.has(K), kAlert: hitB.has(K) };
      t.endNav();
      // (c) 통과 통계 (길안내 없이)
      const recOf = (c) => ps.q.filter((x) => x.k === c[0] + ',' + c[1] + '|' + (Math.round(c.eb / 45) % 8));
      ps.q.length = 0;
      await drive(left, 50, false);
      const kl = recOf(K);
      ps.q.length = 0;
      await drive(straight, 50, false);
      const ks = recOf(K);
      r.c = { left: kl.map((x) => ({ o: x.o || 0, a: x.a })), straight: ks.map((x) => ({ o: x.o || 0, a: x.a })) };
      // (d) 12m 옆 길로 90km/h
      ps.q.length = 0;
      const side = route(line(0, 2000, 3600, 20), []);
      await drive(side, 90, false);
      r.d = recOf(R).map((x) => ({ o: x.o || 0, a: x.a, kmh: x.kmh }));
    } finally {
      ps.post = keep.post; ps.inTest = false; t.prefs.passStats = keep.pref; ps.q.length = 0; t.store.set('passQ', keep.q);
      t.endNav();
      t.driverSpots.rows.length = 0; t.mySpots.length = 0; t.sharedSpots.length = 0; t.applyUserSpots();
      if (base0 !== null) {
        for (const i of fakes.slice().reverse()) { const c = t.cams.rows[i]; if (!c) continue; const k = Math.floor(c[0] / 0.01) + ':' + Math.floor(c[1] / 0.01); const a = t.cams.grid.get(k); if (a) { const j = a.indexOf(i); if (j >= 0) a.splice(j, 1); } t.camMiss.near.delete(i); t.camState.passed.delete(i); t.camState.saidById.delete(i); ps.near.delete(i); ps.shown.delete(i); }
        t.cams.rows.length = base0; t.cams.userBase = null;
      }
      keep.drv.forEach((x) => t.driverSpots.rows.push(x)); keep.shared.forEach((x) => t.sharedSpots.push(x)); keep.mine.forEach((x) => t.mySpots.push(x));
      t.applyUserSpots();
      await resetApp(); softReset();
    }
    const a = r.a || {}, b = r.b || {}, c = r.c || {}, d = r.d || [];
    const ok = !a.kOnRoute && a.wOnRoute && !a.kAlert && a.wAlert &&
      b.kOnRoute && b.kAlert &&
      c.left.length === 1 && c.left[0].o === 1 && c.left[0].a === 0 && c.straight.length === 1 && c.straight[0].o === 0 &&
      d.length === 1 && d[0].o === 2;
    return { pass: !!ok, detail: JSON.stringify(r) };
  }

  // S156: 교차로 카메라 규칙은 전국 모든 교차로에 (v237, 운전자 '그런 건 전국에 다 해당되는 건 알지?', '만약 저게 좌회전이 아니라
  //   직진으로 오는 차였으면 저기에 50 단속이 있으면 감지해주는 게 맞고'). 바다 위 합성 교차로 7곳, 길 모양과 경로(길안내)·궤적(길안내 없이)만으로:
  //   A 사거리 좌회전(남→서): 꺾어 들어간 길의 접근로 정지선 카메라 K(한 방향)·Kt(양방향) 안 뜸, 지나간 새 길 60m 카메라 W·내 접근로 카메라 A 뜸,
  //     교차로를 막 지난(회전점 2.5m 뒤) 새 길의 과속 30 S 도 길안내에서 뜬다(전국 1,017대 — 신호 카메라만 회전점 8m 뒤까지 뺀다).
  //     같은 K 를 천호대로처럼 서쪽으로 곧장 지나면 뜬다 — 제한 50, 경고 거리 400m 그대로. 통과 통계: 좌회전 K 는 '꺾어 들어옴'(o 1), W·S 는 보통(o 0)
  //   B 사거리 우회전(북→서), C 삼거리(동행 큰길에서 남쪽 옆길로 우회전: 내 접근로 E 뜸, 서행 접근 K·옆길 북행 접근 N 안 뜸 / 서행 곧장: K 뜸),
  //   D 60° 비스듬한 좌회전, E 120° 비스듬한 좌회전, F 중앙분리대 있는 길 유턴(건너편 차로 교차로 앞 K 안 뜸, 유턴 뒤 W·내 접근로 A 뜸),
  //   G 양방향 카메라: 가로지르는 길의 양방향 Kt 는 곧장 지나는 차에 안 뜸(길안내·길안내 없이 모두, 통과 기록도 없음), 내 길의 양방향 O 는 뜸
  async function s156() {
    const t = T(), r = {}, ps = t.passStats;
    const X0 = { lat: 36.8, lng: 129.8 };   // 바다 위 (실제 카메라 없음)
    const XAt = (k) => dest(X0, 90, 6000 * k);
    const en = (X, e, n) => dest(dest(X, e >= 0 ? 90 : 270, Math.abs(e)), n >= 0 ? 0 : 180, Math.abs(n));   // X 에서 동쪽 e·북쪽 n 미터
    const keep = { drv: t.driverSpots.rows.slice(), shared: t.sharedSpots.slice(), mine: t.mySpots.slice(), post: ps.post, pref: t.prefs.passStats, q: t.store.get('passQ') };
    const fakes = [], fakeCams = [];
    let base0 = null;
    const mk = (p, eb, lim, kind, two) => { const c = [round6(p.lat), round6(p.lng), lim, kind, 0, 0, 0, -1, 4, 1]; c.eb = eb; c.e2 = two ? 1 : 0; c.lv = 0; c.sl = c[0]; c.sg = c[1]; c.on = ''; return c; };
    const route = (pts, gi, gt, gs) => {
      const PP = pts.map((p) => ({ lat: round6(p.lat), lng: round6(p.lng) })), cum = [0];
      for (let i = 1; i < PP.length; i++) cum.push(cum[i - 1] + hav(PP[i - 1], PP[i]));
      const total = cum[cum.length - 1];
      const g = [{ i: gi, t: gt, s: gs, d: r0(cum[gi]), ms: 10000 }, { i: PP.length - 1, t: 88, s: '목적지', d: r0(total), ms: 1000 }];
      return { route: { distance: r0(total), duration: r0(total / 14 * 1000), tollFare: 0, fuelPrice: 0, path: PP.map((p) => [p.lng, p.lat]), guide: g,
        sections: [{ i: 0, n: PP.length, name: '', speed: 50, cong: 1 }] }, P: PP, cum, total, dest: { name: '시험', addr: '', lat: PP[PP.length - 1].lat, lng: PP[PP.length - 1].lng } };
    };
    // hin 방향으로 X 에 들어와 hout 방향으로 나가는 경로 (모서리는 X 앞뒤 10m 를 잇는 곡선)
    const turnPath = (X, hin, hout, gt, gs) => {
      const pts = [];
      for (let m = 500; m > 10; m -= 20) pts.push(dest(X, (hin + 180) % 360, m));
      const P0 = dest(X, (hin + 180) % 360, 10), P2 = dest(X, hout, 10), gi = pts.length + 4;
      for (let k = 0; k <= 8; k++) { const u = k / 8, a = (1 - u) * (1 - u), b = 2 * u * (1 - u), c = u * u; pts.push({ lat: a * P0.lat + b * X.lat + c * P2.lat, lng: a * P0.lng + b * X.lng + c * P2.lng }); }
      for (let m = 30; m <= 500; m += 20) pts.push(dest(X, hout, m));
      return route(pts, gi, gt, gs);
    };
    const add = (c) => { const i = t.cams.rows.length; t.cams.rows.push(c); fakes.push(i); const k = Math.floor(c[0] / 0.01) + ':' + Math.floor(c[1] / 0.01); if (!t.cams.grid.has(k)) t.cams.grid.set(k, []); t.cams.grid.get(k).push(i); return c; };
    const drive = async (R2, nav) => {
      const hit = new Map();
      hit.onRoute = new Set(); hit.drops = 0;
      if (nav) {
        softReset(); await planAndStart(R2); t.ensureRouteCams();
        for (const x of t.nav.routeCamList || []) hit.onRoute.add(x.c);
        hit.drops = t.nav.turnCamDrops || 0;
      } else { await resetApp(); softReset(); }
      hit.close = new Map();   // 카메라마다 가장 가까웠던 때 { d, t, h }
      for (let s = 0; s <= R2.total; s += 50 / 3.6) {
        const a = pointAt(R2, s);
        const fx = feed(a.p, 50 / 3.6, a.h, { dt: 1000, acc: 3 });
        for (const c of fakeCams) { const d = hav(a.p, { lat: c[0], lng: c[1] }), o = hit.close.get(c); if (!o || d < o.d) hit.close.set(c, { d, t: fx.t, h: a.h }); }
        const tg = t.camState.target;
        if (tg && tg.c && !hit.has(tg.c)) hit.set(tg.c, { first: Math.round(tg.first), lim: text('#camLimit') });
      }
      for (let k = 0; k < 3; k++) { const a = pointAt(R2, R2.total); feed(dest(a.p, a.h, 80 * (k + 1)), 50 / 3.6, a.h, { dt: 1000, acc: 3 }); }
      if (nav) t.endNav();
      return hit;
    };
    const recOf = (c) => ps.q.filter((x) => x.k === c[0] + ',' + c[1] + '|' + (Math.round(c.eb / 45) % 8)).map((x) => ({ o: x.o || 0, a: x.a }));
    const say = (hit, cs) => { const o = {}; for (const [n, c] of Object.entries(cs)) o[n] = hit.has(c) ? 1 : 0; return o; };
    try {
      t.driverSpots.rows.length = 0; t.sharedSpots.length = 0; t.mySpots.length = 0;
      t.applyUserSpots(); base0 = t.cams.rows.length;
      const X = [0, 1, 2, 3, 4, 5, 6].map(XAt);
      const cs = {
        A: { K: mk(en(X[0], 6, 4), 270, 50, 3), Kt: mk(en(X[0], 10, 0), 90, 60, 1, true), W: mk(en(X[0], -60, 0), 270, 50, 1), A: mk(en(X[0], 3, -50), 0, 60, 1), S: mk(en(X[0], -5, 0), 270, 30, 1) },
        B: { K: mk(en(X[1], 6, 4), 270, 50, 3), W: mk(en(X[1], -60, 0), 270, 50, 1) },
        C: { K: mk(en(X[2], 6, 4), 270, 50, 3), E: mk(en(X[2], -6, -4), 90, 50, 3), N: mk(en(X[2], -4, -6), 0, 50, 3) },
        D: { K: mk(en(X[3], 6, 4), 270, 50, 3), W: mk(en(X[3], -60, 0), 270, 50, 1) },
        E: { K: mk(en(X[4], 6, 4), 270, 50, 3), W: mk(en(X[4], -60, 0), 270, 50, 1) },
        F: { K: mk(en(X[5], 14, 6), 270, 50, 3), W: mk(en(X[5], -25, 6), 270, 50, 1), A: mk(en(X[5], -40, -6), 90, 60, 1) },
        G: { Kt: mk(en(X[6], 10, 0), 90, 50, 1, true), O: mk(en(X[6], 3, -60), 0, 60, 1, true), K: mk(en(X[6], 6, 4), 270, 50, 3) },
      };
      for (const s of Object.values(cs)) for (const c of Object.values(s)) { add(c); fakeCams.push(c); }
      t.cams.userBase = null; t.applyUserSpots();
      ps.inTest = true; t.prefs.passStats = true; ps.post = async () => ({ ok: true, status: 200 }); ps.q.length = 0;
      // 중앙분리대 있는 길: 동행 차로 y=-6, 서행 차로 y=+6. 동행으로 와서 X 에서 반지름 6m 유턴
      const uPts = [];
      for (let x = -500; x <= 0; x += 20) uPts.push(en(X[5], x, -6));
      const ugi = uPts.length + 5;
      for (let th = -75; th <= 90; th += 15) uPts.push(en(X[5], 6 * Math.cos(th * Math.PI / 180), 6 * Math.sin(th * Math.PI / 180)));
      for (let x = -20; x >= -500; x -= 20) uPts.push(en(X[5], x, 6));
      const R = {
        A: turnPath(X[0], 0, 270, 2, '좌회전'), Astr: turnPath(X[0], 270, 270, 1, '직진'),
        B: turnPath(X[1], 180, 270, 3, '우회전'),
        C: turnPath(X[2], 90, 180, 3, '우회전'), Cstr: turnPath(X[2], 270, 270, 1, '직진'),
        D: turnPath(X[3], 330, 270, 2, '좌회전'), E: turnPath(X[4], 30, 270, 2, '좌회전'),
        F: route(uPts, ugi, 6, '유턴'),
        G: turnPath(X[6], 0, 0, 1, '직진'),
      };
      for (const k of Object.keys(R)) {
        const sc = cs[k[0]];
        const g = await drive(R[k], true);
        ps.q.length = 0;
        const f = await drive(R[k], false);
        r[k] = { nav: say(g, sc), free: say(f, sc), drops: g.drops, route: say({ has: (c) => g.onRoute.has(c) }, sc) };
        if (k === 'Astr' || k === 'Cstr') r[k].K = { nav: g.get(sc.K) || null, free: f.get(sc.K) || null };
        if (k === 'A') {
          r[k].pass = { K: recOf(sc.K), W: recOf(sc.W), S: recOf(sc.S) };
          // 통과 통계 판정(passWhy)을 바로 본다: 가장 가까웠던 때의 궤적으로 (기록은 1초 간격이라 모서리 카메라는 방향이 안 맞아 안 남기도 한다)
          const why = (c) => { const o = f.close.get(c); return o ? t.passWhy(c, { t: o.t, hdg: o.h, kmh: 50, side: 0, road: '' }) : -1; };
          r[k].why = { K: why(sc.K), Kt: why(sc.Kt), W: why(sc.W), S: why(sc.S) };
        }
        if (k === 'Astr') { const o = f.close.get(sc.K); r[k].why = { K: o ? t.passWhy(sc.K, { t: o.t, hdg: o.h, kmh: 50, side: 0, road: '' }) : -1 }; }
        if (k === 'G') r[k].pass = { Kt: recOf(sc.Kt), O: recOf(sc.O) };
      }
    } finally {
      ps.post = keep.post; ps.inTest = false; t.prefs.passStats = keep.pref; ps.q.length = 0; t.store.set('passQ', keep.q);
      t.endNav();
      t.driverSpots.rows.length = 0; t.mySpots.length = 0; t.sharedSpots.length = 0; t.applyUserSpots();
      if (base0 !== null) {
        for (const i of fakes.slice().reverse()) { const c = t.cams.rows[i]; if (!c) continue; const k = Math.floor(c[0] / 0.01) + ':' + Math.floor(c[1] / 0.01); const a = t.cams.grid.get(k); if (a) { const j = a.indexOf(i); if (j >= 0) a.splice(j, 1); } t.camMiss.near.delete(i); t.camState.passed.delete(i); t.camState.saidById.delete(i); ps.near.delete(i); ps.shown.delete(i); }
        t.cams.rows.length = base0; t.cams.userBase = null;
      }
      keep.drv.forEach((x) => t.driverSpots.rows.push(x)); keep.shared.forEach((x) => t.sharedSpots.push(x)); keep.mine.forEach((x) => t.mySpots.push(x));
      t.applyUserSpots();
      await resetApp(); softReset();
    }
    const eq = (o, want) => !!o && Object.entries(want).every(([k, v]) => o[k] === v);
    const both = (x, want) => !!x && eq(x.nav, want) && eq(x.free, want);
    const strOk = (x) => !!x && ['nav', 'free'].every((m) => x[m] && x[m].lim === '50' && x[m].first > 385 && x[m].first <= 400);
    const A = r.A || {}, G = r.G || {};
    const ok = both(A, { K: 0, Kt: 0, W: 1, A: 1 }) && A.nav.S === 1 && A.drops >= 2 && eq(A.route, { K: 0, Kt: 0, W: 1, A: 1, S: 1 }) &&
      A.pass.K.every((x) => x.o === 1) && A.pass.W.length === 1 && A.pass.W[0].o === 0 && A.pass.S.every((x) => x.o === 0) &&
      eq(A.why, { K: 1, W: 0, S: 0 }) &&
      both(r.Astr, { K: 1, W: 1, A: 0, S: 1 }) && r.Astr.route.Kt === 1 && strOk(r.Astr.K) && r.Astr.why.K === 0 &&
      both(r.B, { K: 0, W: 1 }) && r.B.drops >= 1 &&
      both(r.C, { K: 0, E: 1, N: 0 }) && both(r.Cstr, { K: 1, E: 0, N: 0 }) && strOk(r.Cstr.K) &&
      both(r.D, { K: 0, W: 1 }) && r.D.drops >= 1 && both(r.E, { K: 0, W: 1 }) && r.E.drops >= 1 &&
      both(r.F, { K: 0, W: 1, A: 1 }) && r.F.drops >= 1 &&
      both(G, { Kt: 0, O: 1, K: 0 }) && G.pass.Kt.length === 0 && G.pass.O.length === 1;
    return { pass: !!ok, detail: JSON.stringify(r) };
  }

  // S157: 경로 서버 일시 장애에 버티기 (v239, 2026-11-25 Worker /route 가 몇 분 동안 네이버 길찾기 530 으로 모두 실패했다)
  //   (a) 처음 길찾기: 여러 옵션 묻기가 '경로 없음'(네이버 답 코드 없음)이면 한 가지 옵션 묻기로 바로 바꾸고, 그것도 502 면 잠시 뒤 다시 → 경로 카드
  //   (b) 길안내 중 재탐색: 계속 502 면 정해진 만큼(3번) 다시 묻고 멈춘다 — 지금 경로·안내는 그대로, 빨간 실패 안내 없이 작은 상태 표시, 진단 기록
  //   (c) 다음 재탐색이 되면 상태 표시가 사라진다
  //   (d) 잘못된 요청(400)·네이버가 답한 '경로 없음'(code 있음)·교통 갱신은 다시 묻지 않는다
  async function s157() {
    const t = T(), R = buildNavRoute(), r = {}, net = t.routeNet, keep = net.backoff.slice();
    const pill = () => { const el = document.getElementById('routeNetPill'); return !!el && !el.hidden; };
    const seq = (list) => { let k = 0; return (q) => { const v = list[Math.min(k, list.length - 1)]; k++; return typeof v === 'function' ? v(q) : v; }; };
    const E502 = { __status: 502, body: { error: 'upstream', status: 530, message: '' } };
    const NOROUTE = { __status: 404, body: { error: 'no route', message: '' } };
    try {
      net.backoff.splice(0, net.backoff.length, 30, 60, 90);
      net.log.length = 0;
      // (a)
      await resetApp(); softReset();
      feed(R.P[0], 0, null);
      let c0 = stub.calls.length;
      stub.canned['/route'] = seq([NOROUTE, E502, R.route]);
      await withTimeout(t.planRoute(R.dest, false), 8000, 'planRoute a');
      const ca = stub.since(c0, '/route').map((c) => (c.query.options ? 'multi' : 'single:' + c.query.option));
      r.a = { calls: ca, preview: !!t.nav.preview, alts: (t.nav.alts || []).length, card: visible('#routeCard'), log: net.log.map((x) => x.kind + ':' + x.fallback) };
      t.endNav();
      // (b) 길안내 중 재탐색이 계속 502
      stub.canned['/route'] = R.route;
      softReset();
      await planAndStart(R);
      for (let s = 20; s <= 200; s += 20) { const a = pointAt(R, s); feed(a.p, 14, a.h, { dt: s === 20 ? 65000 : 1000 }); }   // (한 가지 옵션 길찾기 60초 4번 창을 비운다)
      const route0 = t.nav.route, along0 = t.nav.along;
      net.log.length = 0;
      c0 = stub.calls.length;
      stub.canned['/route'] = E502;
      await withTimeout(t.planRoute(R.dest, true), 8000, 'planRoute b');
      const tEl = document.getElementById('toast');
      r.b = { calls: stub.since(c0, '/route').length, active: !!t.nav.active, same: t.nav.route === route0, pill: pill(),
        redToast: !!tEl && !tEl.hidden && tEl.classList.contains('bad'), panel: visible('#navPanel'), turn: text('#turnText').length > 0,
        log: net.log.map((x) => x.kind + ':' + x.waits) };
      // 안내는 계속된다: 경로를 따라 더 가면 남은 거리가 줄어든다
      for (let s = 220; s <= 300; s += 20) { const a = pointAt(R, s); feed(a.p, 14, a.h, { dt: s === 220 ? 65000 : 1000 }); }
      r.b.moved = t.nav.along > along0 + 50;
      // (c) 다음 재탐색이 되면 상태 표시가 사라진다
      stub.canned['/route'] = R.route;
      await withTimeout(t.planRoute(R.dest, true), 8000, 'planRoute c');
      r.c = { pill: pill(), active: !!t.nav.active };
      // (d) 다시 묻지 않는 경우
      { const a = pointAt(R, 300); feed(a.p, 14, a.h, { dt: 65000 }); }
      const once = async (resp, mode) => { const k0 = stub.calls.length; stub.canned['/route'] = resp; await withTimeout(t.planRoute(R.dest, mode), 8000, 'planRoute d'); return stub.since(k0, '/route').length; };
      r.d = {
        bad400: await once({ __status: 400, body: { error: 'bad coords' } }, 'compare'),
        naverNo: await once({ __status: 404, body: { error: 'no route', code: 1, message: '출발지와 도착지가 같습니다' } }, 'compare'),
        traffic: await once(E502, 'traffic'),
        upstream: [502, 530, 404].map((st) => t.routeUpstream({ status: st, detail: st === 404 ? { error: 'no route' } : {} })),
      };
      t.endNav();
      r.d.pillAfterEnd = pill();
    } finally {
      net.backoff.splice(0, net.backoff.length, ...keep);
      stub.canned['/route'] = R.route;
      t.endNav();
      await resetApp(); softReset();
    }
    const a = r.a || {}, b = r.b || {}, c = r.c || {}, d = r.d || {};
    const ok = a.calls.join(',') === 'multi,single:traoptimal,single:traoptimal' && a.preview && a.alts >= 1 && a.log.join(',') === 'recovered:1' &&
      b.calls === 4 && b.active && b.same && b.pill && !b.redToast && b.panel && b.turn && b.log.join(',') === 'failed:3' && b.moved &&
      !c.pill && c.active &&
      d.bad400 === 1 && d.naverNo === 1 && d.traffic === 1 && d.upstream.every(Boolean) && !d.pillAfterEnd;
    return { pass: !!ok, detail: JSON.stringify(r) };
  }

  // S172: 2판 분기점 그림 차로 글자 (v267·v268, 부모 세션 네이버 대조) — 고른 2판 그림 그대로, 지금 보이는(낮) 글자만
  async function s172() {
    const t = T(), r = {};
    const fixture = async (f) => {
      const fx = await (await realFetch(harnessDir + 'fixtures/' + f, { cache: 'no-store' })).json();
      const P = fx.path.map((x) => ({ lat: x[1], lng: x[0] }));
      const cum = [0]; for (let k = 1; k < P.length; k++) cum.push(cum[k - 1] + hav(P[k - 1], P[k]));
      return { route: fx, P, cum, total: cum[cum.length - 1], dest: { name: '시험', addr: '', lat: P[P.length - 1].lat, lng: P[P.length - 1].lng } };
    };
    const view = () => {
      const sv = document.getElementById('juncSvg'), img = [...sv.querySelectorAll('img')].find((i) => i.getBoundingClientRect().width);
      const ib = img ? img.getBoundingClientRect() : null;
      const ls = [...sv.querySelectorAll('.jx-lane')].filter((x) => x.getClientRects().length);
      const one = new Set(), two = new Set(), boxes = [];
      for (const x of ls) {
        const bs = [...x.querySelectorAll('b')];
        (bs.length > 1 ? two : one).add(parseFloat(getComputedStyle(bs[0]).fontSize).toFixed(2));
        const q = bs.map((b) => b.getBoundingClientRect());
        // 가운데 줄 높이에서의 글자 폭 = 기울이기 전 폭 (offsetWidth) — 기울인 글자의 바깥 상자는 실제 글자보다 넓다
        boxes.push([Math.min(...q.map((v) => v.left)), Math.min(...q.map((v) => v.top)), Math.max(...q.map((v) => v.right)), Math.max(...q.map((v) => v.bottom)), Math.max(...bs.map((b) => b.offsetWidth))]);
      }
      const ctr = ib ? boxes.map((q) => (q[0] + q[2]) / 2) : [];
      let overlap = 0;
      for (let k = 1; k < boxes.length; k++) if (ctr[k] - ctr[k - 1] < (boxes[k][4] + boxes[k - 1][4]) / 2 - 0.5) overlap++;
      return { n: ls.length, lanes: ls.map((x) => (x.classList.contains('go') ? '*' : '') + [...x.querySelectorAll('b')].map((b) => b.textContent).join('/')).join(' '),
        one: [...one], two: [...two], overlap, below: ib ? Math.round(Math.max(...boxes.map((q) => q[3])) - ib.bottom) : 99,
        inside: ib ? ctr.every((c) => c > ib.left && c < ib.right) : false, fs: ls.length ? ls[0].style.getPropertyValue('--fs') : '',
        sign: document.getElementById('juncLabel').textContent.trim(), other: document.getElementById('juncLabel2').textContent.trim() };
    };
    const at = async (f, re, before) => {
      const R = await fixture(f);
      await resetApp(); softReset(); t.setNightMode('off'); await planAndStart(R);
      const g = R.route.guide.find((x) => re.test(x.s)), sg = R.cum[Math.min(g.i, R.cum.length - 1)];
      for (let s = Math.max(0, sg - before - 900); s <= sg - before; s += 20) { const a = pointAt(R, s); feed(a.p, 20, a.h); }
      const a = pointAt(R, sg - before); feed(a.p, 20, a.h); t.juncState.key = ''; t.renderNav(); await sleep(80); t.renderNav();
      await waitFor(() => [...document.querySelectorAll('#juncSvg img')].some((i) => i.complete && i.naturalWidth), 3000, 50).catch(() => {}); await sleep(40);
      const o = view();
      t.endNav();
      return o;
    };
    try {
      await waitFor(() => t.jdData.loaded && t.forksData.loaded && t.clData.loaded, 10000, 100);
      r.sh = await at('route-seohanam-ic-n.json', /서하남IC에서 '강동, 서하남'/, 330);
      r.pi = await at('route-pangyo-ic-s.json', /판교IC에서 '분당, 판교'/, 330);
      r.sn = await at('route-paldang-hanamic-s.json', /성남IC에서 '성남, 광주'/, 330);
      r.gh = await at('route-giheung-ic-s.json', /기흥IC에서 '기흥'/, 330);
    } finally {
      t.setNightMode('auto'); await resetApp(); softReset();
    }
    const { sh = {}, pi = {}, sn = {}, gh = {} } = r;
    const sizeOk = (o) => o.n > 0 && o.one.length <= 1 && o.two.length <= 1 && (!o.one.length || !o.two.length || Math.abs(+o.two[0] / +o.one[0] - 0.86) < 0.02);
    const shapeOk = (o) => sizeOk(o) && o.overlap === 0 && o.below <= 1 && o.inside;
    const ok = [sh, pi, sn, gh].every(shapeOk) &&
      sh.lanes === '구리/대전 구리/대전 구리/대전 구리/대전 *강동/서하남 *강동/서하남' && /구리/.test(sh.other) && !/대전/.test(sh.other) &&
      pi.lanes === '대전/부산 대전/부산 대전/부산 대전/부산 *분당/판교 *분당/판교' &&
      sn.lanes === '일산 일산 일산 일산 *성남/광주' && gh.lanes === '대전 대전 대전 대전 *기흥 *기흥';
    return { pass: !!ok, detail: JSON.stringify(r) };
  }

  // S171: v262 밤 주행 신고의 네이버 확인 (keys 2026-11-26)
  //   (a) 마북 삼거리 남행 60 (#21024, 후면): 종류 줄 '후면단속'(검은 띠 rear), 음성 '후면단속 카메라', 지난 뒤 '후면단속 중'·과속 빨강, 95~115m 에서 내림
  //   (b) 성남→기흥 밤 경로(분당수서간도시고속화도로 남행, 백현지하도로): #22322 분당수서로 신호·과속 60 안 뜸. 구간 이름을 '분당수서로'로 바꾸면 뜸
  //   (c) 탄천 80 남행 #22931: 네이버 기둥 100m 앞에서 거리 100m 안팎
  //   (d) 자료: #22931·#22952 네이버 자리, #21024·#20912·#21121·#22313 후면
  async function s171() {
    const t = T(), r = {};
    const MABUK = { lat: 37.29611, lng: 127.1096 }, FOOT = { lat: 37.29611 - 0.00019, lng: 127.1096 + 0.00022 }, C22322 = { lat: 37.37226, lng: 127.10391 }, TANCHEON = { lat: 37.409916, lng: 127.118459 };
    try {
      await waitFor(() => t.cams.loaded, 10000, 100);
      // (a)
      softReset();
      const from = dest(FOOT, 348, 600);
      const a = { label: null, kind: null, rear: null, past60: null, past60over: null, clearedAt: null };
      for (let s = 0; s <= 760; s += 5) {
        feed(dest(from, 168, s), 72 / 3.6, 168);
        const past = s - 600, tg = t.camState.target, mine = !!tg && sameCam(tg.c, MABUK);
        if (mine && a.label === null) { a.label = text('#camType'); a.kind = text('#camKind'); a.rear = hasCls('#camCard', 'rear'); }
        if (past >= 60 && a.past60 === null) { a.past60 = mine ? text('#camDist') : ''; a.past60over = hasCls('#camCard', 'over'); }
        if (a.label !== null && !mine && a.clearedAt === null && past > 0) a.clearedAt = past;
      }
      a.said = [t.camSpoken(t.cams.rows[21024]), t.camSpoken(t.cams.rows[22313])];
      r.a = a;
      // (b)·(c) 길안내
      const run = async (rename) => {
        await resetApp(); softReset();
        const fx = await (await realFetch(harnessDir + 'fixtures/route-night-seongnam-giheung.json', { cache: 'no-store' })).json();
        // 대조: 지상 분당수서로로 달린 것처럼 (구간 이름 '분당수서로', 지하차도 진입 안내를 직진 안내로) — 그러면 이 신호 카메라를 알린다
        if (rename) { fx.sections.forEach((x) => { if (/고속화/.test(x.name)) x.name = '분당수서로'; }); fx.guide.forEach((g) => { if (g.t === 56) g.t = 1; }); }   // 진입 안내 → 직진 (방면 글은 그대로 — 설치장소 'A→B' 판단용)
        const P = fx.path.map((x) => ({ lat: x[1], lng: x[0] }));
        const cum = [0]; for (let k = 1; k < P.length; k++) cum.push(cum[k - 1] + hav(P[k - 1], P[k]));
        const R = { route: fx, P, cum, total: cum[cum.length - 1], dest: { name: '시험', addr: '', lat: P[P.length - 1].lat, lng: P[P.length - 1].lng } };
        await planAndStart(R);
        let sT = 0, best = 1e9;
        for (let s = 0; s <= R.total; s += 5) { const d = hav(pointAt(R, s).p, TANCHEON); if (d < best) { best = d; sT = s; } }
        const o = { c22322: false, tanDist: null };
        try {
          for (let s = Math.max(0, sT - 1200); s <= Math.min(R.total - 30, sT + 6000); s += 10) {
            const q = pointAt(R, s);
            feed(q.p, 80 / 3.6, q.h, { dt: 450 });
            const tg = t.camState.target;
            if (tg && sameCam(tg.c, C22322)) o.c22322 = true;
            if (o.tanDist === null && s >= sT - 100 && tg && sameCam(tg.c, TANCHEON)) o.tanDist = text('#camDist');
          }
        } finally { t.endNav(); }
        return o;
      };
      r.b = await run(false);
      r.b2 = await run(true);
      // (d)
      const rows = t.cams.rows, row = (i) => rows[i].slice(0, 4).concat([rows[i][10] | 0]);
      r.d = { 22931: row(22931), 22952: row(22952), rear: [21024, 20912, 21121, 22313, 21120].map((i) => rows[i][10] & 1) };
    } finally {
      await resetApp(); softReset();
    }
    const { a = {}, b = {}, b2 = {}, d = {} } = r;
    const tan = parseInt(String(b.tanDist || '').replace(/[^0-9]/g, ''), 10);
    const ok = a.label === '후면단속' && a.kind === '후면단속' && a.rear === true && a.past60 === '후면단속 중' && a.past60over === true &&
      a.clearedAt !== null && a.clearedAt >= 95 && a.clearedAt <= 115 && a.said.every((x) => x === '후면단속 카메라') &&
      b.c22322 === false && b2.c22322 === true && tan >= 80 && tan <= 120 &&
      d[22931] && d[22931][0] === 37.409916 && d[22931][1] === 127.118459 && d[22952][0] === 37.409804 && d[22952][1] === 127.11862 &&
      d.rear.every((x) => x === 1);
    return { pass: !!ok, detail: JSON.stringify(r) };
  }

  // S170: v262 밤 주행 뒤 운전자 피드백 (2026-11-26)
  //   (a) 가평 팔각정삼거리 좌회전 3.4km 앞: 카드 안 '이어서' 줄 없음, 카드 오른쪽 칩 '160m' (회전 아이콘)
  //   (b) 같은 곳 600m 앞: '이어서' 줄이 카드 안에, 칩 없음
  //   (c) 휴게소 21km (멀다): 카드 안 파란 줄 대신 칩, 회전 칩 밑 (가까운 순서)
  //   (d) 남은 거리·시간·도착·안내 종료는 아래 가운데 띠 (카드 안 줄은 숨김), 띠와 왼쪽 칸·주행 기록 카드가 겹치지 않음
  //   (e) 경유지: 맨 위 줄 = 경유지 + '경유' 표, 밑 줄 = '도착 <목적지>'
  //   (f) 주행 기록 카드는 오른쪽 아래, '의견' 버튼은 왼쪽 아래 모서리 / GPS 는 카드 밖 오른쪽 아래
  //   (g) 2판 그림 차로 글자: 낮·밤 두 벌, 그림마다 잰 자리 (jx2_lanes.json)
  async function s170() {
    const t = T(), r = {};
    const fixture = async (f) => {
      const fx = await (await realFetch(harnessDir + 'fixtures/' + f, { cache: 'no-store' })).json();
      const P = fx.path.map((x) => ({ lat: x[1], lng: x[0] }));
      const cum = [0]; for (let k = 1; k < P.length; k++) cum.push(cum[k - 1] + hav(P[k - 1], P[k]));
      return { route: fx, P, cum, total: cum[cum.length - 1], dest: { name: '시험 목적지', addr: '', lat: P[P.length - 1].lat, lng: P[P.length - 1].lng } };
    };
    const box = (sel) => { const e = document.querySelector(sel); if (!e || e.hidden || !e.getClientRects().length) return null; const q = e.getBoundingClientRect(); return [q.left, q.top, q.right, q.bottom]; };
    const hit = (a, b) => !!(a && b && a[0] < b[2] - 1 && b[0] < a[2] - 1 && a[1] < b[3] - 1 && b[1] < a[3] - 1);
    const chips = () => [...document.querySelectorAll('#navChips .nchip')].map((c) => (c.classList.contains('rest') ? 'R' : '') + c.textContent.trim());
    try {
      await waitFor(() => t.jdData.loaded, 10000, 100);
      const R = await fixture('route-gapyeong-cheongpyeong.json');
      // 휴게소 줄은 고속도로 위에서만 뜬다 — 이 시험에서는 구간 이름을 고속도로로 (칩 차례를 보려고)
      R.route = Object.assign({}, R.route, { sections: [{ i: 0, n: R.P.length, name: '시험고속도로', speed: 80, cong: 1 }] });
      await resetApp(); softReset(); await planAndStart(R);
      const g = R.route.guide.find((x) => /팔각정삼거리에서/.test(x.s)), sg = R.cum[Math.min(g.i, R.cum.length - 1)];
      for (let s = Math.max(0, sg - 4200); s <= sg - 3400; s += 40) { const a = pointAt(R, s); feed(a.p, 20, a.h); }
      t.renderNav(); await sleep(60);
      r.a = { row: visible('#nextTurn'), chips: chips(), meta: visible('#nbMeta') ? text('#nbMeta') : '', cardMeta: visible('#navPanel .navmeta') };
      // (c) 먼 휴게소를 넣어 본다
      t.nav.routeRest = [{ at: t.nav.along + 21000, name: '시험쉼터휴게소', lat: R.P[0].lat, lng: R.P[0].lng }]; t.nav.routeRestFor = t.nav.route;
      t.renderNav(); await sleep(30);
      r.c = { chips: chips(), restRow: visible('#restCard') };
      for (let s = sg - 3400; s <= sg - 600; s += 40) { const a = pointAt(R, s); feed(a.p, 20, a.h); }
      t.renderNav(); await sleep(60);
      r.b = { row: visible('#nextTurn'), chips: chips(), lead: visible('#nextLead'), restRow: visible('#restCard') };
      r.d = { bar: box('#navBar'), panel: box('#navPanel'), drawer: box('#camDrawer'), trip: box('.trip'), fb: box('.fbcorner') };
      r.d.overlap = ['panel', 'drawer', 'trip'].filter((k) => hit(r.d.bar, r.d[k]));
      r.f = { tripRight: r.d.trip ? Math.round(window.innerWidth - r.d.trip[2]) : -1, fbLeft: r.d.fb ? Math.round(r.d.fb[0]) : -1,
        gpsInTrip: !!document.querySelector('.trip .gps'), gps: visible('.gps') };
      t.endNav();
      // (e) 경유지
      await resetApp(); softReset(); await planAndStart(R);
      t.nav.via = [{ name: '시험 경유지', lat: R.P[5].lat, lng: R.P[5].lng }];
      t.renderNav(); await sleep(30);
      r.e = { name: text('#navDestName'), tag: visible('#navDestTag'), sub: text('#navDestVia') };
      t.nav.via = [];
      t.endNav();
      // (g)
      const fit = await (await realFetch(harnessDir + '../img/ai/jx2_lanes.json', { cache: 'no-store' })).json();
      r.g = { files: Object.keys(fit).length, x41sDay: (fit[t.iconPicks.jx2_x41s_day] || []).length };
    } finally {
      await resetApp(); softReset();
    }
    const { a = {}, b = {}, c = {}, d = {}, e = {}, f = {}, g = {} } = r;
    const ok = !a.row && a.chips.length === 1 && /160m/.test(a.chips[0]) && /안내 종료/.test(a.meta) && !a.cardMeta &&
      c.chips.length === 2 && /160m/.test(c.chips[0]) && /^R21km$/.test(c.chips[1]) && !c.restRow &&
      b.row && b.lead && b.chips.length === 1 && /^R/.test(b.chips[0]) &&
      d.bar && d.overlap.length === 0 &&
      f.tripRight >= 0 && f.tripRight < 40 && f.fbLeft >= 0 && f.fbLeft < 40 && !f.gpsInTrip &&
      e.name === '시험 경유지' && e.tag && e.sub === '도착 시험 목적지' &&
      g.files >= 19 && g.x41sDay === 5;
    return { pass: !!ok, detail: JSON.stringify(r) };
  }

  // S169: 네이버식 분기점 그림 2판 (v256, 부모 세션 점검표 — 운전자 성남IC '봐바 이거 안돼, 비슷하게 좀 만들어 줘')
  //   2판 그림(jx2_*)을 고른 것으로 하고 (a) 성남IC '성남, 광주': 4+1(x41), 4:3, 서랍 폭, 출구 차로 '*성남/광주', 글자 높이 ≥ 차로 폭의 1/4,
  //   출구 표지에 노선 방패 없음, 나들목 번호 띠 '2B', 다른 표지 길 이름 '수도권제1순환' (v257: OSM 방면이 없으면 도시 이름을 쓰지 않는다)
  //   (b) 서울TG → 판교분기점 '일산, 구리': 4 + 3(x43), 차로 색 녹색 1 + 분홍 2('gpp'), 다른 표지 '서울'
  //   (c) 하남분기점: 4+2(x42) 분홍  (d) 신갈분기점 '대전'(본선 그대로): s41, 버스전용차로 칠 안 함('nbbb'), 출구 표지 위 나들목 번호 띠
  async function s169() {
    const t = T(), r = {};
    const fixture = async (f) => {
      const fx = await (await realFetch(harnessDir + 'fixtures/' + f, { cache: 'no-store' })).json();
      const P = fx.path.map((x) => ({ lat: x[1], lng: x[0] }));
      const cum = [0]; for (let k = 1; k < P.length; k++) cum.push(cum[k - 1] + hav(P[k - 1], P[k]));
      return { route: fx, P, cum, total: cum[cum.length - 1], dest: { name: '시험', addr: '', lat: P[P.length - 1].lat, lng: P[P.length - 1].lng } };
    };
    const K2 = ['x31', 'x41', 'x41s', 'x22', 'x42', 'x42s', 'x43', 's31', 's41', 'f22', 'f22k'].flatMap((k) => ['jx2_' + k + '_day', 'jx2_' + k + '_night']), keep = {};
    // 그림 파일은 있는 것(1판 4+1 그림)을 빌려 쓴다 — 비율·폭을 재려면 그림이 실제로 떠야 한다 (색 바꾼 파일 이름은 없어도 됨)
    for (const k of K2) { keep[k] = t.iconPicks[k]; t.iconPicks[k] = /_night$/.test(k) ? 'jx_exit4_night__sunburst26e__1.webp' : 'jx_exit4_day__sunburst26e__1.webp'; }
    const view = () => {
      const el = document.getElementById('juncCard'), sv = document.getElementById('juncSvg'), img = [...sv.querySelectorAll('img')].find((i) => i.getBoundingClientRect().width) || sv.querySelector('img.jv-day');
      const ib = img ? img.getBoundingClientRect() : { width: 0, height: 0 }, db = document.querySelector('#app.tesla .cd-in') ? document.querySelector('#app.tesla .cd-in').getBoundingClientRect() : ib;
      const lanes = [...sv.querySelectorAll('.jx-lane')];
      const sizes = lanes.map((x) => { const b = x.querySelector('b'); return b ? parseFloat(getComputedStyle(b).fontSize) / (parseFloat(x.style.getPropertyValue('--lw')) * ib.width) : 0; });
      return { shown: visible('#juncCard'), jx2: el.classList.contains('jx2'), shape: t.jxShape2(t.juncInfo(t.nav.next), t.nav.next), lc: el.dataset.lc || '',
        ratio: ib.height ? +(ib.width / ib.height).toFixed(2) : 0, wide: Math.round(db.width - ib.width),
        lanes: lanes.map((x) => (x.classList.contains('go') ? '*' : '') + [...x.querySelectorAll('b')].map((b) => b.textContent).join('/')).join(' '),
        minK: sizes.length ? +Math.min(...sizes).toFixed(2) : 0, tab: [...sv.querySelectorAll('.jx-tab')].map((x) => x.textContent).join('|'),
        sign: document.getElementById('juncLabel').textContent.trim(), other: document.getElementById('juncLabel2').textContent.trim(),
        hwy: el.classList.contains('hwy'), otherLeft: document.getElementById('juncLabel2').getBoundingClientRect().left < document.getElementById('juncLabel').getBoundingClientRect().left,
        img: sv.querySelector('img.jv-day') ? sv.querySelector('img.jv-day').getAttribute('src').replace(/^.*\/img\/ai\//, '').replace(/\?.*$/, '') : '' };
    };
    const at = async (f, re, before) => {
      const R = await fixture(f);
      await resetApp(); softReset(); await planAndStart(R);
      const g = R.route.guide.find((x) => re.test(x.s)), sg = R.cum[Math.min(g.i, R.cum.length - 1)];
      for (let s = Math.max(0, sg - before - 900); s <= sg - before; s += 20) { const a = pointAt(R, s); feed(a.p, 20, a.h); }
      const a = pointAt(R, sg - before); feed(a.p, 20, a.h); t.juncState.key = ''; t.renderNav(); await sleep(80); t.renderNav();
      await waitFor(() => [...document.querySelectorAll('#juncSvg img')].some((i) => i.complete && i.naturalWidth), 3000, 50).catch(() => {}); await sleep(40);
      const o = view();
      t.endNav();
      return o;
    };
    try {
      await waitFor(() => t.jdData.loaded && t.forksData.loaded && t.clData.loaded, 10000, 100);
      r.a = await at('route-paldang-hanamic-s.json', /성남IC에서 '성남, 광주'/, 330);
      r.b = await at('route-seoultg-n.json', /판교분기점에서 '일산, 구리'/, 330);
      r.c = await at('route-paldang-hanamic-s.json', /하남분기점에서 '수도권제1순환선, 판교, 서하남'/, 330);
      r.d = await at('route-giheung-ic-s.json', /신갈분기점에서 '대전'/, 330);
      // v260: 서하남교차로 '강동' — 네이버처럼 강동 두 차로는 곧게, 하남 두 차로가 멀리서 오른쪽으로 비킨다 (경로 = 곧게 가는 쪽 f22k, 뒤집지 않음)
      r.e = await at('route-seohanam-ic-n.json', /서하남교차로에서 '강동'/, 330);
      r.e.m = document.getElementById('juncCard').classList.contains('jx-m');
      // v262: 서하남교차로는 고속도로 연결로 위 갈림 — 초록(도로공사) 표지. 기흥IC 는 연결로가 다시 갈려 출구 표지 두 장(43A 기흥 · 43B 동탄), 본선 표지 없음
      r.f = await at('route-giheung-ic-s.json', /기흥IC에서 '기흥'/, 330);
    } finally {
      for (const k of K2) { if (keep[k]) t.iconPicks[k] = keep[k]; else delete t.iconPicks[k]; }
      await resetApp(); softReset();
    }
    const { a = {}, b = {}, c = {}, d = {}, e = {}, f = {} } = r;
    // v257 (부모 세션 '틀린 도시는 안 된다'): 휴게소 방향 '부산'은 어디에도 없다. v259: 지시도시는 네이버와 맞춘 확인 표에서만 —
    //   성남IC '일산'(×4, 네이버 같음), 하남분기점 '구리 상일', 경부 하행 '대전'. 차로는 비우지 않는다
    const noCity = [a, b, c, d].every((x) => !/부산/.test(x.lanes || '') && !/부산/.test(x.other || ''));
    // v258: 성남IC 는 230m 앞에서 2A(판교) 연결로가 먼저 갈라져 '오른쪽 옆 연결로' 그림(x41s, 네이버 성남IC 그림 오른쪽처럼)
    // v259 (③): 네이버처럼 본선 표지 없이 출구 표지 두 장 — '2B 성남 | 성남 광주 ↗' · '2A 성남 | 판교 ↗' (방패 없음)
    const ok = noCity && a.shown && a.jx2 && a.shape === 'x41s' && a.ratio === 1.33 && Math.abs(a.wide) <= 2 && a.lanes === '일산 일산 일산 일산 *성남/광주' && a.minK >= 0.25 &&
      /^2B성남\|2A/.test(a.tab) && !/\d/.test(a.sign) && a.other === '판교' &&
      b.shown && b.shape === 'x43' && b.lc === 'gpp' && /_gpp\.webp/.test(b.img) && /서울/.test(b.other) &&
      c.shown && c.shape === 'x42' && c.lc === 'p' && /구리상일/.test(c.other) && /^구리\/상일 구리\/상일 구리\/상일 구리\/상일 /.test(c.lanes) &&
      e.shown && e.shape === 'f22k' && !e.m && e.lanes === '*강동 *강동 하남 하남' && e.hwy &&
      f.shown && f.shape === 'x42' && f.other === '동탄' && f.otherLeft && /^43A기흥\|43B/.test(f.tab) && /^대전 대전 대전 대전 \*기흥 \*기흥$/.test(f.lanes) &&
      d.shown && d.shape === 's41' && d.lc === 'nbbb' && /_nbbb\.webp/.test(d.img) && /^45A/.test(d.tab) && /대전/.test(d.sign);
    return { pass: !!ok, detail: JSON.stringify(r) };
  }

  // S168: OSM 차로 수로 그림 모양 (v255, 부모 세션 'OSM lanes 대체' — 네이버 하남분기점 4+2, 서하남IC 출구 2차로)
  //   (a) 하남분기점 중부 서행 '수도권제1순환선, 판교, 서하남': OSM 갈래 차로 수 경로 2 · 다른 4 → 4+2 그림이 아직 없으면 2+2(가까운 모양),
  //       4+2 를 고르면 4+2 (차로 글자 여섯, 갈 차로 둘)
  //   (b) 서하남IC 북행 '강동, 서하남': 연결로 차로 수는 LANES_FIX 2 · 본선 4 → (a) 와 같다
  //   (c) 성남IC '성남, 광주': 연결로 차로 수는 LANES_FIX 1 (v256, 네이버 4+1) · 본선 4 → 4+1
  //   (d) 판교IC '분당, 판교': 정밀도로지도 단면 'SB|S|S|S|S|R|R'(갈 차로 2, 다른 5) → 지금은 2+2, 4+2 를 고르면 4+2 (네이버도 버스 + 4 + 출구 2)
  //   (e) 모양 고르기: 1+1 갈림길은 갈림길 그림, 출구 1 + 본선 3 은 3+1, 출구 1 + 본선 4 는 4+1
  async function s168() {
    const t = T(), r = {};
    const unJx2 = stashJx2();   // v261: 1판 그림을 본다
    const fixture = async (f) => {
      const fx = await (await realFetch(harnessDir + 'fixtures/' + f, { cache: 'no-store' })).json();
      const P = fx.path.map((x) => ({ lat: x[1], lng: x[0] }));
      const cum = [0]; for (let k = 1; k < P.length; k++) cum.push(cum[k - 1] + hav(P[k - 1], P[k]));
      return { route: fx, P, cum, total: cum[cum.length - 1], dest: { name: '시험', addr: '', lat: P[P.length - 1].lat, lng: P[P.length - 1].lng } };
    };
    const K42 = ['jx_exit42_day', 'jx_exit42_night'], keep = {};
    for (const k of K42) keep[k] = t.iconPicks[k];
    const set42 = (on) => { for (const k of K42) { if (on) t.iconPicks[k] = /_night$/.test(k) ? 'jxn__t__1.webp' : 'jxd__t__1.webp'; else delete t.iconPicks[k]; } t.juncState.key = ''; };
    const view = () => {
      const el = document.getElementById('juncCard'), sv = document.getElementById('juncSvg');
      const ln = [...sv.querySelectorAll('.jx-lane')], shape = t.jxShape(t.juncInfo(t.nav.next), t.nav.next);
      // 차로 칸 수는 그림 모양의 차로 자리 수 (이름을 모르는 차로에는 글자가 없다: 서하남IC 본선 '수도권제1순환'은 네 글자가 넘음)
      return { shown: visible('#juncCard'), shape, osm: t.jxOsmLanes(t.nav.next),
        lanes: shape ? t.JX_LANES[shape].length : 0, go: ln.filter((x) => x.classList.contains('go')).length, img: ((sv.querySelector('img.jv-day') || {}).getAttribute ? sv.querySelector('img.jv-day').getAttribute('src') : '').replace(/^.*\/img\/ai\//, '').replace(/\?.*$/, '') };
    };
    const at = async (f, re, before) => {
      const R = await fixture(f);
      await resetApp(); softReset(); await planAndStart(R);
      const g = R.route.guide.find((x) => re.test(x.s)), sg = R.cum[Math.min(g.i, R.cum.length - 1)];
      for (let s = Math.max(0, sg - before - 900); s <= sg - before; s += 20) { const a = pointAt(R, s); feed(a.p, 20, a.h); }
      const a = pointAt(R, sg - before); feed(a.p, 20, a.h);
      set42(false); t.renderNav(); await sleep(60); t.renderNav(); await sleep(30);
      const now = view();
      set42(true); t.renderNav(); await sleep(40);
      const with42 = view();
      set42(false); t.renderNav();
      t.endNav();
      return { now, with42 };
    };
    try {
      await waitFor(() => t.jdData.loaded && t.forksData.loaded, 10000, 100);
      r.a = await at('route-paldang-hanamic-s.json', /하남분기점에서 '수도권제1순환선, 판교, 서하남'/, 330);
      r.b = await at('route-seohanam-ic-n.json', /서하남IC에서 '강동, 서하남'/, 330);
      r.c = await at('route-paldang-hanamic-s.json', /성남IC에서 '성남, 광주'/, 330);
      r.d = await at('route-pangyo-ic-s.json', /판교IC에서 '분당, 판교'/, 330);
      // (e) 모양 고르기 (그림은 지금 고른 것: 4+2 없음)
      r.e = [t.jxByLanes(1, 1, 'fork'), t.jxByLanes(1, 3, 'fork'), t.jxByLanes(1, 4, 'ramp'), t.jxByLanes(2, 2, 'fork'), t.jxByLanes(2, 5, 'ramp')].join(',');
    } finally {
      unJx2();
      for (const k of K42) { if (keep[k]) t.iconPicks[k] = keep[k]; else delete t.iconPicks[k]; }
      await resetApp(); softReset();
    }
    const { a = {}, b = {}, c = {}, d = {} } = r;
    const four2 = (x) => x && x.now && x.now.shown && x.now.shape === 'exit2' && x.now.lanes === 4 && x.now.go === 2 && /^jx_exit2_day/.test(x.now.img) &&
      x.with42.shown && x.with42.shape === 'exit42' && x.with42.lanes === 6 && x.with42.go === 2 && /^jxd__t__1_/.test(x.with42.img);
    const ok = four2(a) && a.now.osm && a.now.osm.go === 2 && a.now.osm.other === 4 &&
      four2(b) && b.now.osm && b.now.osm.go === 2 && b.now.osm.other === 4 &&
      c.now && c.now.shown && c.now.shape === 'exit4' && c.now.osm && c.now.osm.go === 1 && c.now.osm.other === 4 && c.with42.shape === 'exit4' &&   /* v256: LANES_FIX 출구 1 */
      four2(d) &&
      r.e === 'fork,exit,exit4,fork,exit2';
    return { pass: !!ok, detail: JSON.stringify(r) };
  }

  // S167: 네이버 분기점 그림과 맞춤 (v253, jx 비교표 — 부모 세션 '네이버가 기준')
  //   (a) 학의→판교분기점 '구리, 성남'(본선 그대로, 차로 단면 없음) · (b) 팔당 '서울' 방면 왼쪽 방향(이름 없는 일반 갈림): 그림 칸 없음
  //   (c) 경부 하행 신갈분기점 '대전'(본선 그대로, 단면 'SB|S|S|S|R'): 그림 있음 · 본선 그대로 · 다른 갈래 '인천, 원주'
  //   (d) 서하남IC 출구 뒤 서하남교차로 '강동': 글은 네이버 그대로 '왼쪽 방향'(예전 '직진'), 다른 갈래 '하남', 방패 없음
  //   (e) 경부 하행 기흥IC '기흥'(단면 출구 2차로): 2+2 그림, 분홍 · (f) 신갈분기점 '원주, 인천'(단면 본선 4 + 출구 1): 4+1 그림, 녹색
  //   (g) 경부 하행 판교IC '분당, 판교'(출구 2차로): 2+2 그림, 갈 차로 둘 다 '분당/판교' (본선 갈림을 두 번째 갈림으로 잡지 않음)
  async function s167() {
    const t = T(), r = {};
    const fixture = async (f) => {
      const fx = await (await realFetch(harnessDir + 'fixtures/' + f, { cache: 'no-store' })).json();
      const P = fx.path.map((x) => ({ lat: x[1], lng: x[0] }));
      const cum = [0]; for (let k = 1; k < P.length; k++) cum.push(cum[k - 1] + hav(P[k - 1], P[k]));
      return { route: fx, P, cum, total: cum[cum.length - 1], dest: { name: '시험', addr: '', lat: P[P.length - 1].lat, lng: P[P.length - 1].lng } };
    };
    const at = async (f, re, before) => {
      const R = await fixture(f);
      await resetApp(); softReset(); await planAndStart(R);
      const g = R.route.guide.find((x) => re.test(x.s)), sg = R.cum[Math.min(g.i, R.cum.length - 1)];
      for (let s = Math.max(0, sg - before - 900); s <= sg - before; s += 20) { const a = pointAt(R, s); feed(a.p, 20, a.h); }
      const a = pointAt(R, sg - before); feed(a.p, 20, a.h); t.juncState.key = ''; t.renderNav(); await sleep(60); t.renderNav(); await sleep(30);
      const el = document.getElementById('juncCard'), sv = document.getElementById('juncSvg');
      const o = { shown: visible('#juncCard'), shape: t.jxShape(t.juncInfo(t.nav.next), t.nav.next), m: el.classList.contains('jx-m'), lc: el.dataset.lc || '', turn: text('#turnText'),
        sign: text('#juncLabel'), other: document.getElementById('juncLabel2').getAttribute('aria-label') || '',
        lanes: [...sv.querySelectorAll('.jx-lane')].map((x) => (x.classList.contains('go') ? '*' : '') + [...x.querySelectorAll('b')].map((b) => b.textContent).join('/')).join(' ') };
      t.endNav();
      return o;
    };
    try {
      await waitFor(() => t.clData.loaded && t.jdData.loaded && t.forksData.loaded, 10000, 100);
      r.a = await at('route-ring1-pangyo.json', /판교분기점에서 '구리, 성남'/, 330);
      r.b = await at('route-paldang-hanamic-s.json', /^'서울' 방면으로 왼쪽 방향/, 330);
      r.c = await at('route-giheung-ic-s.json', /신갈분기점에서 '대전'/, 330);
      r.d = await at('route-seohanam-ic-n.json', /서하남교차로에서 '강동'/, 330);
      r.e = await at('route-giheung-ic-s.json', /기흥IC에서 '기흥'/, 330);
      r.f = await at('route-singal-jc-s.json', /신갈분기점에서 '원주, 인천'/, 330);
      r.g = await at('route-pangyo-ic-s.json', /판교IC에서 '분당, 판교'/, 330);
    } finally {
      await resetApp(); softReset();
    }
    const { a = {}, b = {}, c = {}, d = {}, e = {}, f = {}, g = {} } = r;
    const ok = !a.shown && !b.shown &&
      c.shown && c.shape === 'stay' && /인천/.test(c.other) && /원주/.test(c.other) &&
      d.shown && /왼쪽 방향/.test(d.turn) && !/직진/.test(d.turn) && /하남/.test(d.other) && !/^\d/.test(d.sign) &&
      e.shown && e.shape === 'exit2' && e.lc === 'p' &&
      f.shown && f.shape === 'exit4' && f.lc === 'g' &&
      g.shown && g.shape === 'exit2' && g.lanes.split(' ').filter((x) => x[0] === '*').every((x) => x === '*분당/판교');
    return { pass: !!ok, detail: JSON.stringify(r) };
  }

  // S166: 가지 않는 갈래의 방면 · 차로마다 방면 · 갈 차로 색 (v249, 2026-11-25 운전자: 네이버 판교분기점 '일산 안양 | 판교' — '여기는 일산 안양
  //   이렇게 알려주잖아, 이런 식으로 알려줘야 해, 차선이랑 바닥에 있는 것도 저렇게 다르게 나오고', 신갈분기점 '여기는 초록색 따라가게끔 나와 있지 이것도 부탁해')
  //   (a) 학의→판교분기점 '구리, 성남'(본선 그대로): AI 그림 칸의 다른 갈래 표지가 OSM 연결로 방면 '부산 대전'
  //   (b) 같은 곳 네이버식 그림(jx): 다른 갈래 판 '부산 대전', 경로 차로 바닥 '구리/성남', 다른 차로 바닥 '부산/대전'. 유도선이 없으면 하늘색 그림(_b)
  //   (c) 서울TG→판교분기점 '일산, 구리'(분홍 유도선): 분홍 그림(_p)
  async function s166() {
    const t = T(), r = {};
    const unJx2 = stashJx2();   // v261: 1판 그림을 본다
    const fixture = async (f) => {
      const fx = await (await realFetch(harnessDir + 'fixtures/' + f, { cache: 'no-store' })).json();
      const P = fx.path.map((x) => ({ lat: x[1], lng: x[0] }));
      const cum = [0]; for (let k = 1; k < P.length; k++) cum.push(cum[k - 1] + hav(P[k - 1], P[k]));
      return { route: fx, P, cum, total: cum[cum.length - 1], dest: { name: '시험', addr: '', lat: P[P.length - 1].lat, lng: P[P.length - 1].lng } };
    };
    const driveTo = async (R, re, before) => {
      const g = R.route.guide.find((x) => re.test(x.s)), sg = R.cum[Math.min(g.i, R.cum.length - 1)];
      for (let s = Math.max(0, sg - before - 800); s <= sg - before; s += 20) { const a = pointAt(R, s); feed(a.p, 20, a.h); }
      const a = pointAt(R, sg - before); feed(a.p, 20, a.h); t.juncState.key = ''; t.renderNav(); await sleep(60); t.renderNav(); await sleep(30);
    };
    const JX = ['exit', 'exit4', 'exit2', 'stay', 'fork'].flatMap((k) => ['jx_' + k + '_day', 'jx_' + k + '_night']);
    const keep = {};
    const view = () => {
      const el = document.getElementById('juncCard'), sv = document.getElementById('juncSvg'), o = document.getElementById('juncLabel2');
      return { shown: visible('#juncCard'), jx: el.classList.contains('jx'), other: o.textContent.trim(), othL: o.classList.contains('oth-l'),
        lanes: [...sv.querySelectorAll('.jx-lane')].map((x) => (x.classList.contains('go') ? '*' : '') + [...x.querySelectorAll('b')].map((b) => b.textContent).join('/')).join(' '),
        img: ((sv.querySelector('img.jv-day') || {}).getAttribute ? sv.querySelector('img.jv-day').getAttribute('src') : '').replace(/^.*\/img\/ai\//, '').replace(/\?.*$/, ''), lc: el.dataset.lc || '' };
    };
    try {
      await waitFor(() => t.clData.loaded && t.jdData.loaded, 10000, 100);
      // v253: 판교JC 학의 쪽(본선 그대로, 차로 단면 없음)은 그림이 없어 — 차로 단면이 있는 경부 하행 신갈분기점 '대전'(본선 그대로)에서 본다
      const C = await fixture('route-giheung-ic-s.json');
      softReset(); await planAndStart(C);
      const unstash = stashJx();   // (a) 는 예전 AI 그림 칸
      await driveTo(C, /신갈분기점에서 '대전'/, 300);
      r.a = view();
      unstash();
      for (const k of JX) { keep[k] = t.iconPicks[k]; t.iconPicks[k] = /_night$/.test(k) ? 'jxn__t__1.webp' : 'jxd__t__1.webp'; }
      t.juncState.key = ''; t.renderNav(); await sleep(40);
      r.b = view();
      t.endNav();
      const B = await fixture('route-seoultg-n.json');
      await resetApp(); softReset(); await planAndStart(B);
      await driveTo(B, /판교분기점에서 '일산, 구리'/, 150);
      r.c = view();
      t.endNav();
    } finally {
      unJx2();
      for (const k of JX) { if (keep[k]) t.iconPicks[k] = keep[k]; else delete t.iconPicks[k]; }
      await resetApp(); softReset();
    }
    const a = r.a || {}, b = r.b || {}, c = r.c || {};
    // (a)(b) 다른 갈래(연결로)의 OSM 방면 '인천 원주' — 연결로가 곧 다시 갈려 갈래 자리가 하나뿐이어도 갈림 모양(본선 그대로 = 가장 곧은 갈래)으로 가른다
    // (c) v253: 판교분기점은 색깔 유도선이 둘(녹색 일산·분홍 구리) — 차로마다 색('_gp')·방면
    const ok = a.shown && !a.jx && /인천/.test(a.other) && /원주/.test(a.other) &&
      b.shown && b.jx && /인천/.test(b.other) && /원주/.test(b.other) && /\*대전/.test(b.lanes) && /(^| )인천\/원주/.test(b.lanes) && b.lc === 'b' && /_b\.webp$/.test(b.img) &&
      c.shown && c.jx && c.lc === 'gp' && /_gp\.webp$/.test(c.img) && /\*일산\/평촌 \*구리\/성남/.test(c.lanes);
    return { pass: !!ok, detail: JSON.stringify(r) };
  }

  // S165: '비보호' 표와 정사각형 차로 칸 (v248, 2026-11-25 운전자)
  //   (a) '비보호 좌회전' 안내: 안내 줄 오른쪽 위에 파란 '비보호' 표, 글에서는 '비보호'를 뺀다 ('좌회전 · …'). 다음 안내(우회전)로 넘어가면 표가 없다
  //   (b) 지도 위 차로 말풍선: 차로마다 따로 정사각형 칸 (네이버처럼, '쟤네는 정사각형인데 우린 약간 세로로 길잖아')
  async function s165() {
    const t = T(), r = {};
    try {
      const R = buildNavRoute();
      R.route.guide[1] = Object.assign({}, R.route.guide[1], { t: 2, s: "'양재대로' 방면으로 비보호 좌회전" });
      softReset(); await planAndStart(R);
      for (let s = 20; s <= R.cum[5] - 100; s += 20) { const a = pointAt(R, s); feed(a.p, 12, a.h); }
      t.renderNav();
      const b = document.getElementById('turnBadge'), row = document.querySelector('#navPanel .turn');
      const bb = b.getBoundingClientRect(), rr = row.getBoundingClientRect(), dd = document.getElementById('turnDist').getBoundingClientRect();
      r.a = { shown: visible('#turnBadge'), text: b.textContent, turn: text('#turnText'), right: Math.round(rr.right - bb.right), top: Math.round(bb.top - rr.top),
        noOverlap: bb.left >= dd.right, bg: getComputedStyle(b).backgroundColor };
      for (let s = R.cum[5] + 20; s <= R.cum[5] + 120; s += 20) { const a = pointAt(R, s); feed(a.p, 12, a.h); }
      t.renderNav();
      r.after = { shown: visible('#turnBadge') };
      t.endNav();
      // (b) 말풍선 칸
      const tip = document.createElement('div');
      tip.className = 'lanetip';
      tip.innerHTML = t.laneCell('L', true, 'L', 'tl') + t.laneCell('S', false, 'L', 'tl') + t.laneCell('S', false, 'L', 'tl');
      document.getElementById('map').appendChild(tip);
      const cells = [...tip.querySelectorAll('.tl')].map((c) => c.getBoundingClientRect());
      r.b = { sizes: cells.map((q) => Math.round(q.width) + 'x' + Math.round(q.height)).join(' '), gap: Math.round(cells[1].left - cells[0].right),
        cellBg: getComputedStyle(tip.querySelector('.tl')).backgroundColor, tipBg: getComputedStyle(tip).backgroundColor };
      tip.remove();
    } finally {
      await resetApp(); softReset();
    }
    const a = r.a || {}, bq = r.b || {};
    const ok = a.shown && a.text === '비보호' && /^좌회전/.test(a.turn) && !/비보호/.test(a.turn) && a.right >= 0 && a.right <= 20 && a.top >= 0 && a.top <= 16 && a.noOverlap &&
      r.after && !r.after.shown &&
      bq.sizes === '30x30 30x30 30x30' && bq.gap === 3 && bq.cellBg !== 'rgba(0, 0, 0, 0)' && bq.tipBg === 'rgba(0, 0, 0, 0)';
    return { pass: !!ok, detail: JSON.stringify(r) };
  }

  // S164: 유턴 지점 너머 카메라 (v248, 2026-11-25 08:41 운전자: 성남대로 남행 야탑역사거리 유턴 60m 앞에서 신호·과속 60 카드 —
  //   '이건 유턴이라서 지나가는 게 아니라 안 나와도 돼, 네이버지도 봐봐'). 남행 60(#22941)의 정지선이 유턴 지점 11m 너머라 지나지 않는다.
  //   (a) 유턴 경로(route-yatap-uturn, 네이버 응답 앞부분): 유턴까지 가는 동안 이 카메라가 한 번도 뜨지 않는다
  //   (b) 대조군(route-yatap-straight, 같은 자리를 곧게 남쪽으로): 그대로 알린다
  async function s164() {
    const t = T(), r = {};
    const CAM = { lat: 37.40964, lng: 127.12854 };
    const fixture = async (f) => {
      const fx = await (await realFetch(harnessDir + 'fixtures/' + f, { cache: 'no-store' })).json();
      const P = fx.path.map((x) => ({ lat: x[1], lng: x[0] }));
      const cum = [0]; for (let k = 1; k < P.length; k++) cum.push(cum[k - 1] + hav(P[k - 1], P[k]));
      return { route: fx, P, cum, total: cum[cum.length - 1], dest: { name: '시험', addr: '', lat: P[P.length - 1].lat, lng: P[P.length - 1].lng } };
    };
    const drive = async (R, until) => {
      await planAndStart(R);
      const o = { seen: null, card: '' };
      for (let s = 0; s <= until; s += 10) {
        const a = pointAt(R, s); feed(a.p, 12, a.h);
        const tg = t.camState.target;
        if (tg && sameCam(tg.c, CAM) && o.seen === null) { o.seen = s; t.renderCam(); o.card = text('#camType') + ' ' + text('#camDist'); }
      }
      t.endNav();
      return o;
    };
    try {
      await waitFor(() => t.cams.loaded, 10000, 100);
      const U = await fixture('route-yatap-uturn.json');
      softReset(); r.uturn = await drive(U, U.cum[U.route.guide[0].i] - 5);
      const S = await fixture('route-yatap-straight.json');
      await resetApp(); softReset(); r.straight = await drive(S, S.total - 20);
    } finally {
      await resetApp(); softReset();
    }
    const ok = r.uturn && r.uturn.seen === null && r.straight && r.straight.seen !== null && /60|신호/.test(r.straight.card);
    return { pass: !!ok, detail: JSON.stringify(r) };
  }

  // S163: 구간단속 중간 합류 (2026-11-25, 운전자 규칙 '시작점 뒤에서 들어오면 구간단속은 해당 안 됨'). 실제 사례: 신갈동에서 출발해
  //   경부 상행 구간단속(신갈→죽전 110, 시작 #20098 · 끝 #22040) 시작 카메라 약 1.7km 뒤로 들어왔는데 끝 카메라를 '구간 110'으로
  //   2200m 앞부터 알렸다(v244). 궤적은 저장소에 넣지 않고 OSM 경부 상행 본선 모양의 합성 경로 두 개로 시험한다:
  //   대조군(route-gyeongbu-secfull-n: 시작 카메라 2km 앞부터) — 시작 카메라에서 구간이 열리고 끝 카메라는 '구간단속 끝'
  //   합류(route-gyeongbu-secjoin-n: 시작 카메라 1.7km 뒤부터) — 구간 카드·평균 속도·'구간단속 끝' 경고가 없어야 한다.
  //   끝 카메라를 지점 카메라로 알릴지는 네이버 확인 뒤 정한다. 규칙이 들어가기 전(t.SEC_JOIN_RULE 없음)에는 대조군만 보고
  //   합류는 지금 동작을 적어 SKIP 으로 둔다
  async function s163() {
    const t = T(), r = {};
    const START = { lat: 37.25084, lng: 127.10393 }, END = { lat: 37.3539, lng: 127.10339 };
    const fixture = async (f) => {
      const fx = await (await realFetch(harnessDir + 'fixtures/' + f, { cache: 'no-store' })).json();
      const P = fx.path.map((x) => ({ lat: x[1], lng: x[0] }));
      const cum = [0]; for (let k = 1; k < P.length; k++) cum.push(cum[k - 1] + hav(P[k - 1], P[k]));
      return { route: fx, P, cum, total: cum[cum.length - 1], dest: { name: '시험', addr: '', lat: P[P.length - 1].lat, lng: P[P.length - 1].lng } };
    };
    const drive = async (R) => {
      let endS = 0, endD = Infinity;
      for (let s = 0; s <= R.total; s += 5) { const d = hav(pointAt(R, s).p, END); if (d < endD) { endD = d; endS = s; } }
      const o = { sec: false, secLimit: null, avg: false, endAt: null, endType: '', endKind: '', endLimit: '', endShown: null, secCard: false, voice: [] };
      const seen = new Set(t.alertLog);   // 로그는 길이가 정해져 있어 앞이 잘린다: 새로 들어온 줄만
      await planAndStart(R);
      for (let s = 0; s <= Math.min(R.total, endS + 80); s += 25) {
        const a = pointAt(R, s); feed(a.p, 25, a.h);
        if (t.camState.section) { o.sec = true; o.secLimit = t.camState.section.limit; }
        if (visible('#camAvg')) o.avg = true;
        const tg = t.camState.target;
        if (tg && sameCam(tg.c, END) && o.endAt === null) { o.endAt = Math.round(endS - s); t.renderCam(); o.endShown = visible('#camCard'); o.endType = o.endShown ? text('#camType') : ''; o.endKind = o.endShown ? text('#camKind') : ''; o.endLimit = o.endShown ? text('#camLimit') : ''; o.secCard = !document.getElementById('secCard').hidden; }
      }
      o.voice = t.alertLog.filter((x) => !seen.has(x)).map((x) => String(x.text || x.msg || x)).filter((x) => /단속/.test(x)).slice(0, 6);
      t.endNav();
      return o;
    };
    try {
      await waitFor(() => t.cams.loaded, 10000, 100);
      softReset(); r.full = await drive(await fixture('route-gyeongbu-secfull-n.json'));
      await resetApp(); softReset(); r.join = await drive(await fixture('route-gyeongbu-secjoin-n.json'));
    } finally {
      await resetApp(); softReset();
    }
    const f = r.full || {}, j = r.join || {};
    // v252: 구간 안에서는 끝 카메라 카드·'구간단속 끝' 음성이 없고(네이버처럼), 지나면 '구간단속이 끝났습니다'
    const fullOk = f.sec && f.secLimit === 110 && f.endAt !== null && !f.endShown && !f.voice.some((x) => /구간단속 끝/.test(x)) && f.voice.some((x) => /구간단속이 끝났습니다/.test(x)) && f.secCard;
    if (!fullOk) return { pass: false, detail: 'control route (full section) did not open the section: ' + JSON.stringify(r) };
    if (!t.SEC_JOIN_RULE) return { status: 'SKIP', detail: 'join rule waits for the Naver check (구간단속 중간 합류); current behaviour on the join route: ' + JSON.stringify(r) };
    // v251 (keys 세션 네이버 확인): 합류면 구간 없이 끝 카메라를 보통 지점 카메라 '110 과속단속'으로 (2km 앞 고속도로 지점 카메라 음성 그대로)
    const joinOk = !j.sec && !j.avg && !/구간/.test(j.endType) && !j.voice.some((x) => /구간/.test(x)) &&
      j.endAt !== null && j.endType === '과속단속' && j.endKind === '과속단속' && j.endLimit === '110' && j.voice.some((x) => /단속 카메라. 제한속도 110/.test(x));
    return { pass: !!joinOk, detail: JSON.stringify(r) };
  }

  // S162: 네이버식 분기점 그림 jx (2026-11-25 운전자가 네이버 성남IC 확대 그림을 보내며 '그냥 네이버지도처럼 만들어 달라니까, 자바스크립트로
  //   그리지 말고 AI로 — 헷갈리고 사고 날 것 같아 저렇게 그리면 방향 잘못 틀어서'). AI 그림 자리는 아무 그림으로 시험한다 (모양·자리만 본다)
  //   (a) 서울TG→판교분기점 '일산, 구리'(오른쪽) 100m 앞: 서랍 칸이 jx (3:2), 그림 두 장(그 모양의 낮·밤), 그린 svg 없음, 뒤집지 않음.
  //       표지판 둘이 그림 속 판 자리에: 경로 갈래(일산) 오른쪽 판, 다른 갈래(v256: 방면 '서울', 예전 '경부') 왼쪽 판 — 둘 다 그림 안, 글자 잘림 없음.
  //       초록 차로 아래 노면 글자 '일산'이 경로 갈래 쪽(오른쪽 절반)에
  //   (b) 학의→판교분기점 '구리, 성남'(본선 그대로 왼쪽): '본선 그대로' 그림(경로 차로가 왼쪽, 연결로가 오른쪽) 그대로, 경로 표지는 왼쪽 판,
  //       노면 글자는 왼쪽 절반
  //   (c) jx 그림을 고르지 않았으면 예전 AI 그림(junc_<종류>)
  //   (d) 팔당→하남IC '서울' 방면 왼쪽 방향(왼쪽 갈림길): 갈림길 그림을 좌우로 뒤집고(jx-m), 경로 표지는 왼쪽 판, 노면 글자 '서울'은 왼쪽 절반
  async function s162() {
    const t = T(), r = {};
    const unJx2 = stashJx2();   // v261: 1판 그림을 본다
    const fixture = async (f) => {
      const fx = await (await realFetch(harnessDir + 'fixtures/' + f, { cache: 'no-store' })).json();
      const P = fx.path.map((x) => ({ lat: x[1], lng: x[0] }));
      const cum = [0]; for (let k = 1; k < P.length; k++) cum.push(cum[k - 1] + hav(P[k - 1], P[k]));
      return { route: fx, P, cum, total: cum[cum.length - 1], dest: { name: '시험', addr: '', lat: P[P.length - 1].lat, lng: P[P.length - 1].lng } };
    };
    const driveTo = async (R, re, before) => {
      const g = R.route.guide.find((x) => re.test(x.s)), sg = R.cum[Math.min(g.i, R.cum.length - 1)];
      for (let s = Math.max(0, sg - before - 800); s <= sg - before; s += 20) { const a = pointAt(R, s); feed(a.p, 20, a.h); }
      const a = pointAt(R, sg - before); feed(a.p, 20, a.h); t.renderNav(); await sleep(60); t.renderNav(); await sleep(30);
    };
    const pick = 'junc_fork_day__flare26x__2.webp', pickN = 'junc_fork_night__sunburst26f__1.webp';
    const keep = {};
    // v256: 1판 모양 전부 (4+1·4+2 포함 — 판교분기점은 이제 차로 수 4 + 3 이라 1판에서는 2+2 그림)
    const JX = ['exit', 'exit2', 'exit4', 'exit42', 'stay', 'fork'].flatMap((k) => ['jx_' + k + '_day', 'jx_' + k + '_night']);
    const view = () => {
      const el = document.getElementById('juncCard'), sv = document.getElementById('juncSvg'), cr = el.getBoundingClientRect();
      const lab = document.getElementById('juncLabel'), oth = document.getElementById('juncLabel2');
      const box = (x) => { const q = x.getBoundingClientRect(); return { l: +((q.left - cr.left) / cr.width).toFixed(3), r: +((q.right - cr.left) / cr.width).toFixed(3), t: +((q.top - cr.top) / cr.height).toFixed(3), b: +((q.bottom - cr.top) / cr.height).toFixed(3), w: Math.round(q.width) }; };
      // 낮·밤 중 지금 보이는 그림 (해가 지면 낮 그림은 display:none 이라 뒤집기 값이 안 잡힌다)
      const img = [...sv.querySelectorAll('img')].find((i) => i.getClientRects().length > 0) || sv.querySelector('img.jv-day') || sv.querySelector('img');
      // v249: 차로마다 방면 (.jx-lane, 두 줄까지 '일산/구리')
      const road = [...sv.querySelectorAll('.jx-lane')].map((x) => ({ c: x.classList.contains('go') ? 'go' : 'ot', t: [...x.querySelectorAll('b')].map((b) => b.textContent).join('/'), x: +((x.getBoundingClientRect().left + x.getBoundingClientRect().width / 2 - cr.left) / cr.width).toFixed(3) }));
      return { shown: visible('#juncCard'), jx: el.classList.contains('jx'), m: el.classList.contains('jx-m'), left: el.classList.contains('left'),
        shape: t.jxShape(t.juncInfo(t.nav.next)), ratio: +(cr.width / cr.height).toFixed(2), w: Math.round(cr.width),
        imgs: [...sv.querySelectorAll('img')].map((i) => (i.getAttribute('src') || '').replace(/^.*\/img\/ai\//, '').replace(/\?.*$/, '').replace(/_[bpg]{1,2}\.webp$/, '.webp')).join(','),
        flip: img ? getComputedStyle(img).transform : '', svg: sv.querySelectorAll('svg').length,
        sign: lab.textContent.trim(), sb: box(lab), other: oth.textContent.trim(), ob: box(oth), road,
        cut: [lab, oth].some((x) => x.scrollWidth > x.clientWidth + 1 || x.scrollHeight > x.clientHeight + 1 || [...x.querySelectorAll('.sg-row, .sg-names')].some((b) => b.scrollWidth > b.clientWidth + 1)),
        // 이름끼리 겹치지 않는다 (줄이 줄어들어 글자가 옆 이름에 닿으면 안 된다)
        overlap: [lab, oth].some((x) => { const q = [...x.querySelectorAll('.sg-row b')].map((b) => b.getBoundingClientRect()); return q.some((p, i) => q.some((o, k) => k > i && p.right > o.left + 1 && o.right > p.left + 1 && p.bottom > o.top + 1 && o.bottom > p.top + 1)); }) };
    };
    try {
      for (const k of JX) { keep[k] = t.iconPicks[k]; t.iconPicks[k] = /_night$/.test(k) ? pickN : pick; }
      await waitFor(() => t.clData.loaded, 10000, 100);
      const B = await fixture('route-seoultg-n.json');
      await resetApp(); softReset(); await planAndStart(B);
      t.juncState.key = '';
      await driveTo(B, /판교분기점에서 '일산, 구리'/, 100);
      r.a = view();
      t.endNav();
      // (c) jx 그림을 빼면 예전 AI 그림 (같은 판교분기점을 다시 달린다 — 위에서 안내를 끝냈다)
      for (const k of JX) delete t.iconPicks[k];
      await resetApp(); softReset(); await planAndStart(B);
      t.juncState.key = '';
      await driveTo(B, /판교분기점에서 '일산, 구리'/, 100);
      r.c = view();
      t.endNav();
      for (const k of JX) t.iconPicks[k] = /_night$/.test(k) ? pickN : pick;
      // (b) v253: 학의→판교분기점 '구리, 성남'(본선 그대로, 차로 단면 없음) — 네이버처럼 그림 칸이 없다
      const C = await fixture('route-ring1-pangyo.json');
      await resetApp(); softReset(); await planAndStart(C);
      t.juncState.key = '';
      await driveTo(C, /판교분기점에서 '구리, 성남'/, 120);
      r.b = view();
      t.endNav();
      // (d) 왼쪽 갈림 (v253: 서하남IC 출구 뒤 서하남교차로 '강동' 방면 왼쪽 방향): 갈림길 그림을 좌우로 뒤집는다
      const D = await fixture('route-seohanam-ic-n.json');
      await resetApp(); softReset(); await planAndStart(D);
      t.juncState.key = '';
      await driveTo(D, /서하남교차로에서 '강동'/, 330);
      r.d = view();
      t.endNav();
    } finally {
      unJx2();
      for (const k of JX) { if (keep[k]) t.iconPicks[k] = keep[k]; else delete t.iconPicks[k]; }
      await resetApp(); softReset();
    }
    const inside = (q) => q.l >= 0 && q.r <= 1 && q.t >= 0 && q.b <= 1;
    const a = r.a || {}, b = r.b || {}, c = r.c || {}, d = r.d || {};
    const goA = a.road && a.road.find((x) => x.c === 'go'), goB = b.road && b.road.find((x) => x.c === 'go'), goD = d.road && d.road.find((x) => x.c === 'go');
    const allGo = (o, f) => o.road.filter((x) => x.c === 'go').every(f);
    const ok = a.shown && a.jx && !a.m && !a.left && a.shape && a.ratio >= 1.45 && a.ratio <= 1.55 && a.imgs === pick + ',' + pickN && a.svg === 0 && a.flip === 'none' &&
      // v256 (점검표 6): 다른 갈래 표지는 길 이름('경부')이 아니라 방면 — OSM 본선 갈래 방면 '서울'
      /일산/.test(a.sign) && a.sb.l > 0.48 && inside(a.sb) && /서울/.test(a.other) && a.ob.r < 0.52 && inside(a.ob) && !a.cut && !a.overlap &&
      // v253: 갈래가 다시 갈려 차로마다 방면 — 왼쪽 '일산/평촌', 오른쪽 '구리/성남'
      a.road.filter((x) => x.c === 'go').map((x) => x.t).join(',') === '일산/평촌,구리/성남' && allGo(a, (x) => x.x > 0.5) &&
      !b.shown &&
      c.shown && !c.jx && !c.m && /^junc_fork_day__/.test(c.imgs) && c.road.length === 0 &&
      d.shown && d.jx && d.m && d.shape === 'fork' && /^matrix\(-1/.test(d.flip) && /강동/.test(d.sign) && /하남/.test(d.other) && d.sb.r < 0.52 && inside(d.sb) && d.ob.l > 0.48 && inside(d.ob) && !d.cut &&
      goD && goD.t === '강동' && allGo(d, (x) => x.x < 0.5);
    return { pass: !!ok, detail: JSON.stringify(r) };
  }

  // S161: 가까이 이어지는 회전 ('이어서', v246, 운전자 '우회전하고 또 우회전 하는 상황, 성남으로 들어올 때 좀 많이 헷갈리게 돼 있더라. 미리 보여주는 거 조금 개선이 필요해')
  //   성남 여수사거리 동쪽처럼 오른쪽 방향 → 30m 왼쪽 방향 → 220m 오른쪽 방향: 첫 안내 150m 앞에서 그다음 줄이 '이어서' 줄
  //   (초록 '이어서' 표, ↖ 30m, › ↱ 220m), 300m 앞 음성은 '… 이어서 30미터 앞 왼쪽 방향, 다시 220미터 앞 오른쪽 방향'.
  //   그다음이 400m 뒤면 예전처럼 작은 줄('갈림길 지나')
  async function s161() {
    const t = T(), r = {};
    const build = (gap2, gap3) => {
      const raw = [];
      for (let k = 0; k <= 160; k++) raw.push(dest(NAV_ORIGIN, 0, 10 * k));
      const i1 = 60, i2 = i1 + gap2 / 10, i3 = i2 + gap3 / 10;
      const path = raw.map((p) => [round6(p.lng), round6(p.lat)]);
      const P = path.map((x) => ({ lat: x[1], lng: x[0] }));
      const cum = [0]; for (let i = 1; i < P.length; i++) cum.push(cum[i - 1] + hav(P[i - 1], P[i]));
      const guide = [{ i: i1, t: 5, s: "여수사거리에서 '광주, 성남IC' 방면으로 오른쪽 방향" }, { i: i2, t: 4, s: "여수사거리에서 '이천, 광주' 방면으로 왼쪽 방향" },
        { i: i3, t: 5, s: "여수사거리에서 '이천, 광주' 방면으로 오른쪽 방향" }, { i: P.length - 1, t: 88, s: '목적지' }].map((g) => Object.assign({ d: r0(cum[g.i]), ms: 20000 }, g));
      const total = cum[cum.length - 1];
      return { route: { distance: r0(total), duration: r0(total / 12 * 1000), tollFare: 0, fuelPrice: 0, path, guide, sections: [{ i: 0, n: P.length, name: '성남대로', speed: 40, cong: 1 }] },
        P, cum, total, dest: { name: '이어서 시험', addr: '', lat: P[P.length - 1].lat, lng: P[P.length - 1].lng } };
    };
    const row = () => ({ soon: document.getElementById('nextTurn').classList.contains('soon'), lead: visible('#nextLead'), dist: text('#nextDist'), after: text('#nextAfter'),
      chain: visible('#nextChain') ? text('#nextChain').replace(/\s+/g, '') : '', aria: document.getElementById('nextTurn').getAttribute('aria-label') || '' });
    try {
      for (const [key, g2, g3] of [['close', 30, 220], ['far', 400, 400]]) {
        const R = build(g2, g3);
        await resetApp(); softReset(); await planAndStart(R);
        const from = t.alertLog.length ? t.alertLog[t.alertLog.length - 1] : null;
        for (let s = 20; s <= 450; s += 20) { const a = pointAt(R, s); feed(a.p, 12, a.h); t.renderNav(); }
        const said = t.alertLog.slice(from ? t.alertLog.indexOf(from) + 1 : 0).map((e) => e.text);
        const v300 = said.find((x) => /미터 앞, 여수사거리/.test(x)) || said.join(' | ');
        r[key] = Object.assign(row(), { v300 });
        t.endNav();
      }
    } finally {
      await resetApp(); softReset();
    }
    const c = r.close || {}, f = r.far || {};
    const ok = c.soon && c.lead && c.dist === '30m' && c.after === '' && /^›?220m$/.test(c.chain.replace(/[^›0-9m]/g, '')) &&
      /이어서 30미터 앞 왼쪽 방향, 다시 220미터 앞 오른쪽 방향/.test(c.v300) && /이어서 30m 왼쪽 방향, 다시 220m 오른쪽 방향/.test(c.aria) &&
      !f.soon && !f.lead && f.dist === '400m' && f.after === '갈림길 지나' && f.chain === '' && !/이어서/.test(f.v300);
    return { pass: !!ok, detail: JSON.stringify(r) };
  }

  // S160: ★ 고정 규칙 — 갈림 그림은 운전자 AI 그림만, 아래 서랍에 (v245, 운전자 2026-11-25 '내가 만든 AI 그림으로만 밑에다 보여 주는 거지.
  //   저렇게 보여 주면 안 돼', '저번에도 말했던 거 같은데' — 처음은 2026-11-15 v108·v109). S130·S138·S151(그린 그림 시험)은 이 시험으로 바뀌었다.
  //   (a) 서울TG→판교분기점 '일산, 구리' 100m 앞: 분기 칸은 서랍에 AI 그림 두 장(낮·밤)뿐이고 그린 그림(svg)·장면(nv)·내려다본 그림(plan)이 없다.
  //       안내 카드(위)에는 유도선 갈림 그림이 없고 유도선 줄도 숨김 — 그래도 분홍 색 선 자료는 계산한다. 방면 표지는 그림 위에 다 보인다
  //   (b) 그 종류 AI 그림을 빼면 분기 칸이 아예 없다 (그린 그림으로 대신하지 않음)
  //   (c) 팔당→하남IC 남행 성남IC '성남, 광주' 출구 300m 앞도 AI 그림만
  async function s160() {
    const t = T(), r = {};
    const fixture = async (f) => {
      const fx = await (await realFetch(harnessDir + 'fixtures/' + f, { cache: 'no-store' })).json();
      const P = fx.path.map((x) => ({ lat: x[1], lng: x[0] }));
      const cum = [0]; for (let k = 1; k < P.length; k++) cum.push(cum[k - 1] + hav(P[k - 1], P[k]));
      return { route: fx, P, cum, total: cum[cum.length - 1], dest: { name: '시험', addr: '', lat: P[P.length - 1].lat, lng: P[P.length - 1].lng } };
    };
    const driveTo = async (R, re, before) => {
      const g = R.route.guide.find((x) => re.test(x.s)), sg = R.cum[Math.min(g.i, R.cum.length - 1)];
      for (let s = Math.max(0, sg - before - 800); s <= sg - before; s += 20) { const a = pointAt(R, s); feed(a.p, 20, a.h); }
      const a = pointAt(R, sg - before); feed(a.p, 20, a.h); t.renderNav(); await sleep(30); t.renderNav();
    };
    const view = () => {
      const el = document.getElementById('juncCard'), sv = document.getElementById('juncSvg');
      const imgs = [...sv.querySelectorAll('img')].map((i) => (i.getAttribute('src') || '').replace(/^.*\/img\/ai\//, '').replace(/\?.*$/, '').replace(/__.*$/, ''));
      const panel = document.querySelector('.navpanel');
      return { shown: visible('#juncCard'), inDrawer: !!el.closest('#camDrawer .cd-in'), imgs: imgs.join(','), svg: sv.querySelectorAll('svg').length, nv: el.classList.contains('nv'), plan: el.classList.contains('plan'),
        sign: text('#juncLabel'), other: visible('#juncLabel2') ? text('#juncLabel2') : '', signCut: (() => { const lab = document.getElementById('juncLabel'); return [...lab.querySelectorAll('b')].some((b) => b.scrollWidth > b.clientWidth + 1); })(),
        colorRow: visible('#colorRow'), splitPic: !!(panel && panel.querySelector('svg.sp-pic')) && visible('#colorRow'), cl: (t.colorLineAhead() || {}).c || '' };
    };
    const unstash = stashJx();
    try {
      await waitFor(() => t.clData.loaded, 10000, 100);
      const B = await fixture('route-seoultg-n.json');
      await resetApp(); softReset(); await planAndStart(B);
      await driveTo(B, /판교분기점에서 '일산, 구리'/, 100);
      r.a = view();
      // (b) 이 종류의 AI 그림을 잠깐 빼고 다시 그린다
      const kind = (t.juncInfo(t.nav.next) || {}).kind, keep = {};
      for (const k of ['junc_' + kind + '_day', 'junc_' + kind + '_night']) { keep[k] = t.iconPicks[k]; delete t.iconPicks[k]; }
      t.juncState.key = ''; t.renderNav(); await sleep(30); t.renderNav();
      r.b = Object.assign({ kind }, view());
      Object.assign(t.iconPicks, keep);
      t.juncState.key = ''; t.renderNav();
      t.endNav();
      const A = await fixture('route-paldang-hanamic-s.json');
      await resetApp(); softReset(); await planAndStart(A);
      await driveTo(A, /성남IC에서 '성남, 광주'/, 300);
      r.c = view();
      t.endNav();
    } finally {
      unstash(); await resetApp(); softReset();
    }
    const aiOnly = (x) => x && x.shown && x.inDrawer && /^junc_[a-z]+_day,junc_[a-z]+_night$/.test(x.imgs) && x.svg === 0 && !x.nv && !x.plan && !x.colorRow && !x.splitPic;
    // v246: 가지 않는 갈래도 표지 — 지금 길(경부)이 다른 쪽으로 이어지니 '① 경부 ↑' 를 반대쪽에
    const ok = aiOnly(r.a) && r.a.cl === 'p' && /일산/.test(r.a.sign) && !r.a.signCut && /서울/.test(r.a.other) &&   /* v256: 다른 갈래 표지는 길 이름('경부')이 아니라 OSM 본선 방면 '서울' */
      r.b && !r.b.shown && r.b.svg === 0 && !r.b.colorRow &&
      aiOnly(r.c) && r.c.cl === 'g';
    return { pass: !!ok, detail: JSON.stringify(r) };
  }

  // S159: 잘못 누른 신고를 되돌림 (v244, 운전자: 서울TG 앞 구간단속 끝에서 '잘못된 정보 신고' → '?' 카드로 남음, '근데 내가 잘못 신고 한거 같애')
  //   (a) 구간단속 끝 카드에서 신고 → 흐리게·'?'·'내가 신고함', 보냄 표시가 끝나면 아래 버튼이 '↩ 신고 취소'
  //   (b) '↩ 신고 취소' → 카드가 원래대로(110, 흐리게 아님), 이 차의 신고 표시가 없어지고 설정 목록도 비고, 버튼은 다시 '잘못된 정보 신고'
  //   (c) 다른 날 누른 신고로 흐려진 카드는 예전처럼 '잘못된 정보 신고' (또 누르면 숨김 — 되돌리기는 설정에서)
  //   (d) 새 버전이 열릴 때 지우는 목록(CAM_FLAG_CLEAR): 그 시각 전 22040 신고 표시는 지우고, 그 뒤 누른 것은 남긴다
  async function s159() {
    const t = T(), r = {}, b = document.getElementById('camMissBtn'), card = document.getElementById('camCard');
    const keepNo = t.store.get('camNo2'), keepMap = new Map([...t.camNoMap].map(([k, v]) => [k, v.map((e) => Object.assign({}, e, { days: e.days.slice() }))]));
    const keepShare = t.prefs.share;
    const settle = () => { clearTimeout(b._sentT); b.classList.remove('sent', 'saved', 'sending'); t.renderCam(); };
    const view = () => ({ limit: text('#camLimit'), doubt: card.classList.contains('doubt'), after: getComputedStyle(document.getElementById('camType'), '::after').content,
      btn: b.textContent, undo: b.classList.contains('undo'), flag: t.camState.target ? t.camState.target.flag || null : 'none',
      mine: (t.camNoMap.get('37.3539,127.10339') || []).length, list: document.querySelectorAll('#camFlagList li').length });
    try {
      t.prefs.share = false;   // 시험 중에는 서버로 보내지 않는다
      await waitFor(() => t.cams.loaded, 10000, 100);
      const R = buildNavRoute();
      softReset(); await planAndStart(R);
      for (let s = 15; s <= 90; s += 15) { const a = pointAt(R, s); feed(a.p, 15, 0); }
      t.camNoMap.delete('37.3539,127.10339');
      const i = 22040, c = t.cams.rows[i];
      const show = (flag) => { t.camState.target = { i, c, d: 670, r: 670, minD: 670, after: false, t0: Date.now(), first: 2600, flag }; t.renderCam(); card._camAt = Date.now() - 2000; };
      show(undefined);
      r.before = view();
      // (a) 신고
      b.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      r.sentBtn = b.textContent;
      settle();
      r.a = view();
      // (b) 신고 취소
      card._camAt = Date.now() - 2000;
      b.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      r.undoBtn = b.textContent;
      settle();
      r.b = view();
      // (c) 다른 날 누른 신고
      const old = Date.now() - 3 * 86400e3, d = new Date(old);
      t.camNoMap.set('37.3539,127.10339', [{ h: null, t0: old, t1: old, days: [d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate()], lim: 110, name: '구간단속 끝' }]);
      show(t.camFlag(c, 0));
      r.c = view();
      // (d) 새 버전이 열릴 때 지우는 목록
      const cut = Date.parse(t.CAM_FLAG_CLEAR['37.3539,127.10339']);
      t.camNoMap.set('37.3539,127.10339', [{ h: 0, t0: cut - 3000e3, t1: cut - 1800e3, days: ['2026-11-25'], lim: 110, name: '구간단속 끝' },
        { h: 180, t0: cut + 60e3, t1: cut + 60e3, days: ['2026-11-25'], lim: 110, name: '구간단속 끝' }]);
      r.d = { removed: t.clearConfirmedFlags(), left: (t.camNoMap.get('37.3539,127.10339') || []).map((e) => e.h) };
    } finally {
      t.camState.target = null;
      t.camNoMap.clear(); keepMap.forEach((v, k) => t.camNoMap.set(k, v));
      t.store.set('camNo2', keepNo);
      t.prefs.share = keepShare;
      settle(); t.renderCamFlags();
      await resetApp(); softReset();
    }
    const a = r.a || {}, bb = r.b || {}, c = r.c || {}, d = r.d || {};
    const ok = r.before && r.before.limit === '110' && !r.before.doubt && r.before.btn === '잘못된 정보 신고' &&
      r.sentBtn === '✓ 보냄' && a.limit === '?' && a.doubt && /내가 신고함/.test(a.after) && a.btn === '↩ 신고 취소' && a.undo && a.mine === 1 && a.list === 1 &&
      r.undoBtn === '✓ 취소함' && bb.limit === '110' && !bb.doubt && bb.flag === null && bb.mine === 0 && bb.list === 0 && bb.btn === '잘못된 정보 신고' && !bb.undo &&
      c.doubt && c.limit === '?' && c.btn === '잘못된 정보 신고' && !c.undo &&
      d.removed === 1 && d.left.join(',') === '180';
    return { pass: !!ok, detail: JSON.stringify(r) };
  }

  // S158: 분기점 그림의 갈 차로 색을 네이버에 맞춤 (v243, 2026-11-25 네이버 비교표 8번·13번 — 둘 다 우리는 기본 하늘색이었다)
  //   (a) 수도권제1순환 남행 성남IC '성남, 광주' 출구 (route-paldang-hanamic-s): 색 선 줄 '성남IC' 녹색이 갈림 약 300m 앞부터,
  //       300m 앞 분기점 그림의 갈 차로가 녹색으로 칠해지고 따로 뜨는 유도선 줄은 숨는다
  //   (b) 경부 상행 판교분기점 '일산, 구리' (route-seoultg-n): 100m 앞 그림의 갈 차로가 분홍
  //   (c) OSM 길 모양으로 만든 일산행(1차 갈림 → 일산·구리 공통 연결로 → 일산 쪽): 1차 분홍이 보인다 (예전엔 구리행에만)
  //   (d) 같은 곳 경부 본선 직진(서울·양재)과 성남IC 남행 본선 직진에는 그 색이 안 붙는다
  async function s158() {
    const t = T(), r = {};
    const fromPath = (path, guide, name) => {
      const P = path.map((x) => ({ lat: x[1], lng: x[0] }));
      const cum = [0]; for (let k = 1; k < P.length; k++) cum.push(cum[k - 1] + hav(P[k - 1], P[k]));
      const total = cum[cum.length - 1];
      const route = { distance: r0(total), duration: r0(total / 20 * 1000), tollFare: 0, fuelPrice: 0, path,
        guide: guide.map((g) => Object.assign({ d: r0(cum[g.i]), ms: 20000 }, g)), sections: [{ i: 0, n: P.length, name: '', speed: 80, cong: 1 }] };
      return { route, P, cum, total, dest: { name, addr: '', lat: P[P.length - 1].lat, lng: P[P.length - 1].lng } };
    };
    const fixture = async (f) => {
      const fx = await (await realFetch(harnessDir + 'fixtures/' + f, { cache: 'no-store' })).json();
      const P = fx.path.map((x) => ({ lat: x[1], lng: x[0] }));
      const cum = [0]; for (let k = 1; k < P.length; k++) cum.push(cum[k - 1] + hav(P[k - 1], P[k]));
      return { route: fx, P, cum, total: cum[cum.length - 1], dest: { name: '시험', addr: '', lat: P[P.length - 1].lat, lng: P[P.length - 1].lng } };
    };
    const lines = (R, re) => t.ensureRouteColorLines().filter((x) => re.test(x.name)).map((x) => x.name + ':' + x.c);
    // 안내 지점 before m 앞까지 몰고 가서 분기점 그림의 갈 차로 색
    const paintAt = async (R, re, before) => {
      const g = R.route.guide.find((x) => re.test(x.s)), sg = R.cum[Math.min(g.i, R.cum.length - 1)];
      for (let s = Math.max(0, sg - before - 800); s <= sg - before; s += 20) { const a = pointAt(R, s); feed(a.p, 20, a.h); }
      const a = pointAt(R, sg - before); feed(a.p, 20, a.h); t.renderNav();
      await sleep(30); t.renderNav();
      const go = document.querySelector('#juncSvg .nv-go'), card = document.getElementById('juncCard');
      return { nv: visible('#juncCard') && card.classList.contains('nv'), fill: go && go.classList.contains('nv-cl') ? go.style.fill.replace(/\s/g, '') : '',
        row: !document.getElementById('colorRow').hidden, ai: visible('#juncCard') && !!document.querySelector('#juncSvg img.jv-day') && !document.querySelector('#juncSvg svg'),
        cl: (t.colorLineAhead() || {}).c || '' };
    };
        try {
      await waitFor(() => t.clData.loaded, 10000, 100);
      // (a) 성남IC 남행 출구
      const A = await fixture('route-paldang-hanamic-s.json');
      await resetApp(); softReset(); await planAndStart(A);
      const ga = A.route.guide.find((x) => /성남IC에서 '성남, 광주'/.test(x.s));
      const la = t.ensureRouteColorLines().find((x) => x.name === '성남IC');
      r.a = { list: lines(A, /성남IC/), start: la ? Math.round(la.at - A.cum[ga.i]) : null, at300: await paintAt(A, /성남IC에서 '성남, 광주'/, 300) };
      t.endNav();
      // (b) 판교분기점 '일산, 구리'
      const B = await fixture('route-seoultg-n.json');
      await resetApp(); softReset(); await planAndStart(B);
      r.b = { at100: await paintAt(B, /판교분기점에서 '일산, 구리'/, 100) };
      t.endNav();
      // (c) 일산행: 경부 상행 본선 → 1차 갈림(OSM 37.401851 부터 일산·구리 공통) → 1110773683 → 일산 쪽 연결로 59242893
      const NB = [[37.388515, 127.102479], [37.391162, 127.101986], [37.392182, 127.101794], [37.393447, 127.101556], [37.394273, 127.101389], [37.394821, 127.101293],
        [37.396643, 127.10097], [37.397731, 127.100747], [37.398689, 127.100566], [37.399313, 127.100455], [37.399819, 127.100336], [37.400323, 127.100115],
        [37.400651, 127.099926], [37.401035, 127.099673], [37.401395, 127.099403], [37.401851, 127.09909], [37.402633, 127.098161], [37.403286, 127.097474]];
      const ILSAN = [[37.403779, 127.09712], [37.404087, 127.096937], [37.404383, 127.096846], [37.404715, 127.096832], [37.404978, 127.09686], [37.405245, 127.096881],
        [37.405433, 127.096867], [37.405606, 127.096853], [37.405829, 127.09679], [37.406038, 127.096695], [37.406206, 127.096551], [37.406354, 127.0964],
        [37.406534, 127.096108], [37.406645, 127.095818], [37.406722, 127.095528], [37.406779, 127.095007], [37.406785, 127.094625]];
      const SEOUL = [[37.403749, 127.096909], [37.40423, 127.096398], [37.406612, 127.094006], [37.407199, 127.093337], [37.408215, 127.092254]];
      const path = (a) => a.map((p) => [p[1], p[0]]);
      const C = fromPath(path(NB.concat(ILSAN)), [{ i: 13, t: 67, s: "판교분기점에서 '일산, 구리' 방면으로 오른쪽 방향" }, { i: NB.length + ILSAN.length - 1, t: 88, s: '목적지' }], '일산 쪽');
      await resetApp(); softReset(); await planAndStart(C);
      r.c = lines(C, /판교분기점/);
      t.endNav();
      // (d) 본선 직진 둘
      const D = fromPath(path(NB.concat(SEOUL)), [{ i: NB.length + SEOUL.length - 1, t: 88, s: '목적지' }], '서울 쪽');
      await resetApp(); softReset(); await planAndStart(D);
      r.dSeoul = lines(D, /판교분기점/);
      t.endNav();
      const SB = [[37.439519, 127.122484], [37.43904, 127.122503], [37.438523, 127.122538], [37.437879, 127.122611], [37.437811, 127.122622], [37.435551, 127.122991],
        [37.434927, 127.1231], [37.43386, 127.123327], [37.433453, 127.123385], [37.433032, 127.123404], [37.432549, 127.123408], [37.430502, 127.123402],
        [37.42985, 127.123387], [37.429482, 127.123382], [37.427552, 127.123356], [37.42683, 127.123322], [37.425665, 127.123341], [37.425371, 127.123338],
        [37.424504, 127.123329], [37.423836, 127.123326], [37.423548, 127.123329], [37.421937, 127.12331]];
      const E = fromPath(path(SB), [{ i: SB.length - 1, t: 88, s: '목적지' }], '남행 직진');
      await resetApp(); softReset(); await planAndStart(E);
      r.dSouth = lines(E, /성남IC/);
      t.endNav();
    } finally {
      await resetApp(); softReset();
    }
    const a = r.a || {}, b = r.b || {};
    // 안내 지점은 갈림 약 40m 뒤 (네이버 guide 점) — 색 선 시작은 안내 지점 약 340m 앞
    const ok = a.list && a.list.join(',') === '성남IC:g' && a.start >= -370 && a.start <= -290 &&
      // v245 고정 규칙: 분기 칸은 운전자 AI 그림만(칠한 차로·안내 카드 맨 위 유도선 그림 없음). 색 자료는 그대로 계산한다
      a.at300.ai && !a.at300.nv && a.at300.fill === '' && !a.at300.row && a.at300.cl === 'g' &&
      b.at100 && b.at100.ai && !b.at100.nv && b.at100.fill === '' && !b.at100.row && b.at100.cl === 'p' &&
      Array.isArray(r.c) && r.c[0] === '판교분기점:g' &&   /* v253: 네이버 비교표 — 일산 쪽 차로는 녹색(구리 쪽 분홍) */
      Array.isArray(r.dSeoul) && r.dSeoul.length === 0 && Array.isArray(r.dSouth) && r.dSouth.length === 0;
    return { pass: !!ok, detail: JSON.stringify(r) };
  }

  // S127: (v198, 운전자 '어차피 다 테스터이고 익명이라서 누군지는 몰라 그래서 쓸 수 있음', 테스터 쪽지 동의, '출발지 도착지 모두 남는 방향으로 해 줘
  //       원본은 30일 뒤에 자동으로 지우는걸로') 테스터 주행 경로 — 처음 안내는 멈춰 있을 때만(운전 중엔 안 띄우고 기록도 안 함),
  //       출발부터 도착까지 2~5초 간격, 카메라 통과(경고 거리) 표시, 주행마다 새 무작위 번호, 기기·접속 번호 없음, 끄면 지움
  async function s127() {
    const t = T(), r = {}, rr = t.routeRec;
    const CAM = { lat: 37.44165, lng: 126.8467 };   // 광명로 60 신호·과속 남행 (S68, 23339)
    const keep = { post: rr.post, pref: t.prefs.routeShare, pass: t.prefs.passStats, note: t.store.get('routeNote'), road: t.road.name };
    const bodies = [];
    const parked = async (p, n, dt) => { for (let k = 0; k < n; k++) feed(p, 0, 180, { dt }); await waitFor(() => !rr.busy, 2000, 20); };
    const allPts = () => bodies.reduce((a, b) => a.concat(b.pts || []), []);
    try {
      rr.inTest = true;
      rr.post = async (b) => { bodies.push(JSON.parse(JSON.stringify(b))); return { ok: true, status: 200 }; };
      t.prefs.routeShare = true; t.prefs.passStats = true; t.routeClear(); t.store.set('routeNote', null);
      await resetApp(); softReset(); t.road.name = '';
      const A0 = dest(CAM, 0, 1500);
      // (a) 달리는 중에는 안내도 기록도 없고, 1분 넘게 멈춰 있을 때 한 번 안내
      for (let s = 0; s <= 170; s += 17) feed(dest(A0, 180, s), 16.7, 180);
      r.a = { whileDriving: t.store.get('routeNote'), cur: !!rr.cur };
      await parked(dest(A0, 180, 170), 8, 10000);
      r.a.parked = t.store.get('routeNote');
      r.a.toast = /주행 경로를 익명으로/.test(text('#toast'));
      // (b) 카메라를 지나 3km, 6분 멈추면 주행 끝 → 처음부터 끝까지 보냄
      const S0 = dest(A0, 180, 187), E0 = dest(A0, 180, 3000);
      for (let s = 187; s <= 3000; s += 17) feed(dest(A0, 180, s), 16.7, 180);
      await parked(E0, 7, 60000);
      await waitFor(() => bodies.some((b) => b.end === 1), 2000, 20);
      const P = allPts(), b0 = bodies[0] || {}, last = bodies[bodies.length - 1] || {};
      const gaps = P.slice(1).map((q, k) => q[0] - P[k][0]);
      const cm = bodies.reduce((a, b) => a.concat(b.cams || []), []).find((x) => x.k && x.k.indexOf('37.44165,126.8467|') === 0);
      r.b = { parts: bodies.length, n: P.length, rid: b0.rid, end: last.end, ps: b0.ps,
        startM: P.length ? Math.round(hav({ lat: P[0][1] / 1e5, lng: P[0][2] / 1e5 }, S0)) : -1,
        endM: P.length ? Math.round(hav({ lat: P[P.length - 1][1] / 1e5, lng: P[P.length - 1][2] / 1e5 }, E0)) : -1,
        s0: P.length ? P[0][0] : -1, gapMin: Math.min(...gaps), gapMax: Math.max(...gaps),
        keys: [...new Set(bodies.reduce((a, b) => a.concat(Object.keys(b)), []))].sort().join(','), cam: cm ? { a: cm.a, kmh: cm.kmh, lim: cm.lim } : 'none' };
      // (c) 다음 주행은 새 번호, 통과 통계를 끈 차는 ps 0
      bodies.length = 0;
      t.prefs.passStats = false;
      for (let s = 3000; s >= 2400; s -= 17) feed(dest(A0, 180, s), 16.7, 0);
      await parked(dest(A0, 180, 2400), 7, 60000);
      await waitFor(() => bodies.some((b) => b.end === 1), 2000, 20);
      r.c = { rid: (bodies[0] || {}).rid, ps: (bodies[0] || {}).ps };
      t.prefs.passStats = true;
      // (d) 설정에서 끄면 모은 것을 지우고 더 기록하지 않는다
      bodies.length = 0;
      for (let s = 2400; s <= 2700; s += 17) feed(dest(A0, 180, s), 16.7, 180);
      const cb = document.getElementById('optRouteShare');
      cb.checked = false; cb.onchange({ target: cb });
      const off = { pref: t.prefs.routeShare, stored: t.store.get('routeShare'), cur: !!rr.cur, saved: t.store.get('routeCur') };
      for (let s = 2700; s <= 3000; s += 17) feed(dest(A0, 180, s), 16.7, 180);
      r.d = Object.assign(off, { after: !!rr.cur, sent: bodies.length, label: cb.closest('label') ? cb.closest('label').textContent.trim() : '' });
      cb.checked = true; cb.onchange({ target: cb });
      r.d.back = t.prefs.routeShare && t.store.get('routeShare') == null;
    } finally {
      rr.post = keep.post; rr.inTest = false; t.prefs.routeShare = keep.pref; t.prefs.passStats = keep.pass;
      t.routeClear(); t.store.set('routeNote', keep.note); t.road.name = keep.road;
      const te = document.getElementById('toast'); if (te) te.hidden = true;
      await resetApp(); softReset();
    }
    const ok = r.a.whileDriving == null && !r.a.cur && r.a.parked === '1' && r.a.toast &&
      r.b.parts >= 1 && r.b.end === 1 && /^[a-z0-9]{12}$/.test(r.b.rid || '') && r.b.ps === 1 && r.b.startM <= 40 && r.b.endM <= 40 && r.b.s0 >= 0 &&
      r.b.gapMin >= 2 && r.b.gapMax <= 5 && r.b.keys === 'cams,d,end,part,ps,pts,rid,sid,t0,v,x' /* v231: 접속 번호·첫 점 시각 (기기 번호 없음) */ && r.b.cam !== 'none' && r.b.cam.a >= 100 && r.b.cam.lim === 60 &&
      /^[a-z0-9]{12}$/.test(r.c.rid || '') && r.c.rid !== r.b.rid && r.c.ps === 0 &&
      r.d.pref === false && r.d.stored === '0' && !r.d.cur && r.d.saved == null && !r.d.after && r.d.sent === 0 && /주행 경로/.test(r.d.label) && r.d.back;
    return { pass: !!ok, detail: JSON.stringify(r) };
  }

  // S117: 음성 판정 (v183) — 가짜 음성 엔진으로
  async function s117() {
    const t = T(), r = {};
    const desc = Object.getOwnPropertyDescriptor(window, 'speechSynthesis');
    const keep = { voice: t.prefs.voice, unlocked: t.sound.unlocked, broken: t.tts.broken, failed: t.tts.failed, started: t.tts.started, noticed: t.tts.noticed, dropped: t.tts.dropped };
    const mkEngine = (mode) => {
      const E = { pending: false, speaking: false, paused: false, voices: [], cancels: 0, onvoiceschanged: null,
        getVoices() { return this.voices; }, cancel() { this.cancels++; this.pending = false; this.speaking = false; }, resume() {},
        speak(u) {
          if (mode === 'slow') { this.pending = true; setTimeout(() => { if (!this.pending) return; this.pending = false; this.speaking = true; u.onstart && u.onstart({}); setTimeout(() => { this.speaking = false; u.onend && u.onend({}); }, 300); }, 6000); }
          else if (mode === 'error') setTimeout(() => { u.onerror && u.onerror({ error: 'synthesis-failed' }); }, 50);
          // 'drop': 아무 일도 없음
        } };
      return E;
    };
    const appVoicesHandler = window.speechSynthesis ? window.speechSynthesis.onvoiceschanged : null;   // 앱이 걸어 둔 음성 목록 알림
    const use = (E) => { E.onvoiceschanged = appVoicesHandler; Object.defineProperty(window, 'speechSynthesis', { value: E, configurable: true, writable: true }); };
    const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
    try {
      t.prefs.voice = true; t.sound.unlocked = true;
      t.tts.broken = false; t.tts.failed = 0; t.tts.started = 0; t.tts.noticed = true; t.tts.dropped = 0;
      // (a) 느린 엔진
      let E = mkEngine('slow'); use(E);
      let fails = 0;
      r.slowSpoke = t.speak('시험 하나', false, () => { fails++; });
      await sleep(4600);
      r.slowAt46 = { fails, cancels: E.cancels, broken: t.tts.broken };
      await sleep(2200);
      r.slowStarted = t.tts.started; r.slowFails = fails;
      // (b) 말이 사라짐
      E = mkEngine('drop'); use(E); fails = 0;
      t.tts.started = 0;
      t.speak('시험 둘', false, () => { fails++; });
      t.speak('시험 셋', false, () => { fails++; });
      await sleep(4600);
      r.drop = { fails, broken: t.tts.broken, dropped: t.tts.dropped, cancels: E.cancels, still: t.speak('시험 넷', false, () => {}) };
      // (c) 진짜 오류 두 번 → 경고음으로만, 한국어 음성이 오면 다시
      E = mkEngine('error'); use(E); fails = 0; t.tts.failed = 0; t.tts.started = 0;
      t.speak('오류 하나', false, () => { fails++; });
      t.speak('오류 둘', false, () => { fails++; });
      await sleep(400);
      r.err = { fails, broken: t.tts.broken, refuses: t.speak('오류 셋', false, () => {}) === false, test: t.speak('소리 테스트', true, null, null, true) };
      E.voices = [{ lang: 'ko-KR', name: '시험 한국어' }];
      if (typeof window.speechSynthesis.onvoiceschanged === 'function') window.speechSynthesis.onvoiceschanged();
      r.err.afterKo = t.tts.broken;
    } finally {
      if (desc) Object.defineProperty(window, 'speechSynthesis', desc); else delete window.speechSynthesis;
      if (typeof appVoicesHandler === 'function') { try { appVoicesHandler(); } catch (e) { /* 없음 */ } }   // 진짜 음성 목록으로 되돌린다
      Object.assign(t.tts, { broken: keep.broken, failed: keep.failed, started: keep.started, noticed: keep.noticed, dropped: keep.dropped });
      t.prefs.voice = keep.voice; t.sound.unlocked = keep.unlocked;
      try { window.speechSynthesis.cancel(); } catch (e) { /* 없음 */ }
    }
    const ok = r.slowSpoke && r.slowAt46.fails === 0 && r.slowAt46.cancels === 0 && !r.slowAt46.broken && r.slowStarted >= 1 && r.slowFails === 0 &&
      r.drop.fails === 2 && !r.drop.broken && r.drop.dropped >= 2 && r.drop.cancels === 0 && r.drop.still === true &&
      r.err.fails === 2 && r.err.broken && r.err.refuses && r.err.test === true && r.err.afterKo === false;
    return { pass: !!ok, detail: JSON.stringify(r) };
  }

  // S116: 지도 못 불러옴 띠 (v182)
  async function s116() {
    const t = T(), r = {}, el = document.getElementById('source');
    const keep = { text: el.textContent, hidden: el.hidden, warn: el.classList.contains('warn'), reload: t.pageCtl.reload };
    let reloads = 0;
    try {
      t.pageCtl.reload = () => { reloads++; };
      const leaflet = !(t.getMap() && 'initDark' in t.getMap());
      r.leaflet = leaflet;
      if (leaflet) r.text = el.textContent;   // 이 하네스가 네이버 지도를 못 받아 기본 지도로 떴으면 새 문구
      el.textContent = '네이버 지도를 불러오지 못했어요 · 누르면 다시 시도'; el.classList.add('warn'); el.hidden = false;
      document.getElementById('map').classList.add('chrome-hidden');
      r.visibleHidden = getComputedStyle(el).opacity === '1' && getComputedStyle(el).pointerEvents !== 'none';
      document.getElementById('map').classList.remove('chrome-hidden');
      // 길안내 중이면 다시 불러오지 않는다
      const R = buildNavRoute();
      await planAndStart(R);
      el.click();
      r.navToast = text('#toast'); r.navReloads = reloads;
      t.endNav();
      t.state.speedKmh = 0;
      el.click();
      r.parkedReloads = reloads;
    } finally {
      t.pageCtl.reload = keep.reload;
      el.textContent = keep.text; el.hidden = keep.hidden; el.classList.toggle('warn', keep.warn);
      await resetApp();
    }
    const ok = (!r.leaflet || /누르면 다시 시도/.test(r.text)) && r.visibleHidden && /멈춘 뒤 눌러/.test(r.navToast) && r.navReloads === 0 && r.parkedReloads === 1;
    return { pass: !!ok, detail: JSON.stringify(r) };
  }

  // S115: 잘못된 이탈 (v181, 2026-11-20 운전자 '네비 잘 설정해서 가고 있는데 벗어난 적도 없는데 한 번씩 계속 이탈된다')
  async function s115() {
    const t = T(), r = {};
    // 북쪽으로 3km 곧은 길 (회전 없음)
    const mk = (from, len, east) => {
      const P = [];
      for (let k = 0; k <= len / 20; k++) { const q = dest(dest(from, 0, 20 * k), 90, east || 0); P.push({ lat: round6(q.lat), lng: round6(q.lng) }); }
      const cum = [0];
      for (let i = 1; i < P.length; i++) cum.push(cum[i - 1] + hav(P[i - 1], P[i]));
      const total = cum[cum.length - 1], n = P.length;
      return { route: { distance: r0(total), duration: r0(total / 16 * 1000), tollFare: 0, fuelPrice: 0, path: P.map((q) => [q.lng, q.lat]),
        guide: [{ i: n - 1, t: 88, s: '목적지', d: r0(total), ms: r0(total / 16 * 1000) }], sections: [{ i: 0, n, name: '곧은로', speed: 60, cong: 1 }] },
        P, cum, total, dest: { name: '곧은 목적지', addr: '', lat: P[n - 1].lat, lng: P[n - 1].lng } };
    };
    const O = dest(NAV_ORIGIN, 90, 70000);
    const R = mk(O, 3000);
    const reroutes = () => stub.since(c0, '/route').length;
    let c0 = 0;
    const drive = (m0, m1, step, v, east) => { for (let m = m0; m <= m1; m += step) feed(dest(dest(O, 0, m), 90, east || 0), v, 0, { dt: step / v * 1000 }); };
    try {
      await resetApp(); softReset();
      await planAndStart(R);
      drive(20, 400, 16, 16);
      // (a) 교통 갱신 경로가 45m 옆 나란한 길에서 시작한다
      const here = t.state.fix;
      const bad = mk(dest(here, 0, -40), 2600, 45);
      stub.canned['/route'] = bad.route;
      const route0 = t.nav.route;
      c0 = stub.calls.length;
      await t.planRoute(R.dest, 'traffic');
      r.badApplied = t.nav.route !== route0;
      c0 = stub.calls.length;
      drive(416, 600, 16, 16);
      r.badReroutes = reroutes();
      r.badToast = /벗어났/.test(text('#toast'));
      // (b) 같은 길의 교통 갱신은 바꾼다
      const good = mk(dest(t.state.fix, 0, -30), 2400, 0);
      stub.canned['/route'] = good.route;
      const route1 = t.nav.route;
      await t.planRoute(R.dest, 'traffic');
      r.goodApplied = t.nav.route !== route1 && t.nav.setKind === 'traffic';
      c0 = stub.calls.length;
      drive(616, 800, 16, 16);
      r.goodReroutes = reroutes();
      r.goodOn = t.nav.onRoute;
      // (c) 재탐색 경로가 차 앞 70m 에서 시작 — 막혀서 천천히 가면 한동안 출발점 뒤
      const ahead = mk(dest(t.state.fix, 0, 70), 2000, 0);
      stub.canned['/route'] = ahead.route;
      await t.planRoute(R.dest, true);
      c0 = stub.calls.length;
      const m0 = 800;
      let behindSeen = false, offSeen = false;
      for (let k = 1; k <= 10; k++) { feed(dest(dest(O, 0, m0 + 4 * k), 90, 0), 4, 0, { dt: 1000 }); if (t.nav.behindStart) behindSeen = true; if (!t.nav.onRoute) offSeen = true; }
      r.behind = { seen: behindSeen, off: offSeen, reroutes: reroutes() };
      drive(m0 + 56, m0 + 200, 16, 16);
      r.behind.alongAfter = Math.round(t.nav.along);
      r.behind.reroutesAfter = reroutes();
      // (d) 진짜로 벗어남: 동쪽으로 꺾어 간다 → 3초·30m 안에 재탐색
      stub.canned['/route'] = mk(t.state.fix, 1500, 0).route;
      c0 = stub.calls.length;
      const turnAt = t.state.fix;
      let firedAt = null;
      for (let k = 1; k <= 12 && firedAt === null; k++) {
        feed(dest(turnAt, 90, 12 * k), 12, 90, { dt: 1000 });
        if (reroutes() > 0) firedAt = { k, m: 12 * k };
      }
      r.realOff = firedAt;
      t.endNav();
    } finally {
      await resetApp(); softReset();
    }
    const ok = !r.badApplied && r.badReroutes === 0 && !r.badToast &&
      r.goodApplied && r.goodReroutes === 0 && r.goodOn &&
      r.behind.seen && !r.behind.off && r.behind.reroutes === 0 && r.behind.alongAfter > 50 && r.behind.reroutesAfter === 0 &&
      r.realOff && r.realOff.k <= 4 && r.realOff.m <= 48;
    return { pass: !!ok, detail: JSON.stringify(r) };
  }

  // S114: 제한속도 모름 (v179, 2026-11-20 운전자 '물음표 나오는 과속단속은 안 나오게 해 주라. 차라리 그게 더 헷갈린다')
  async function s114() {
    const t = T(), r = {};
    const O = dest(NAV_ORIGIN, 90, 52000), at = (y) => dest(O, 0, y);
    const keep = { mine: t.mySpots.slice(), mineRaw: t.store.get('mySpots'), sig: t.prefs.signalCams, drv: t.driverSpots.rows.slice(), shared: t.sharedSpots.slice() };
    const fakes = [];
    let base0 = null;
    const add = (c) => { const i = t.cams.rows.length; t.cams.rows.push(c); fakes.push(i); const k = Math.floor(c[0] / 0.01) + ':' + Math.floor(c[1] / 0.01); if (!t.cams.grid.has(k)) t.cams.grid.set(k, []); t.cams.grid.get(k).push(i); return c; };
    const mk = (p, lim, kind, name) => { const c = [round6(p.lat), round6(p.lng), lim, kind, 0, 0, 0, -1, 4, 1]; c.eb = 0; c.e2 = 0; c.lv = 0; c.sl = c[0]; c.sg = c[1]; c.on = name || ''; return c; };
    const pass = async (c) => { let seen = null; await driveThrough({ lat: c[0], lng: c[1] }, 0, 600, 0, 60, 16.7, () => { const tg = t.camState.target; if (tg && tg.c === c && !seen) seen = { limit: text('#camLimit'), type: text('#camType') }; }); return seen; };
    try {
      t.mySpots.length = 0; t.driverSpots.rows.length = 0; t.sharedSpots.length = 0; t.applyUserSpots();
      base0 = t.cams.rows.length;
      const Z = add(mk(at(2000), 0, 1)), S = add(mk(at(4000), 0, 2)), Y = add(mk(at(6000), 70, 1, '시험대로'));
      t.cams.userBase = null; t.applyUserSpots();
      // (a) 제한 0 과속 카메라
      r.zero = { wanted: t.camWanted(Z), seen: await pass(Z) };
      Z[2] = 60;
      r.filled = { wanted: t.camWanted(Z), seen: await pass(Z) };
      // (b) 신호 전용
      t.prefs.signalCams = false;
      r.sigOff = { seen: await pass(S) };
      t.prefs.signalCams = true;
      r.sigOn = { seen: await pass(S) };
      t.prefs.signalCams = keep.sig;
      // (c) 신고 지점 제한속도 채우기
      const P = at(6800);
      r.fill = { sameRoad: t.spotLimit({ lat: P.lat, lng: P.lng, h: 0 }, '시험대로'), otherRoad: t.spotLimit({ lat: P.lat, lng: P.lng, h: 0 }, '다른로'),
        noName: t.spotLimit({ lat: P.lat, lng: P.lng, h: 0 }, ''), opposite: t.spotLimit({ lat: P.lat, lng: P.lng, h: 180 }, '시험대로'),
        expwy: t.spotLimit({ lat: at(20000).lat, lng: at(20000).lng, h: 0 }, '시험고속도로'), unknown: t.spotLimit({ lat: at(20000).lat, lng: at(20000).lng, h: 0 }, '골목길') };
      // (d) 제한을 모르는 신고 지점: 숨김 + 목록 표시 → 근처에 카메라가 생기면 보임
      const Q = at(12000);
      t.mySpots.push({ lat: Q.lat, lng: Q.lng, h: 0, t: Date.now(), days: ['x'], kmh: 50, lim: 0, rn: '' });
      t.applyUserSpots();
      const row = () => t.cams.rows.slice(t.cams.userBase).find((c) => Math.abs(c[0] - Q.lat) < 1e-5);
      t.renderMySpots();
      r.hidden = { wanted: t.camWanted(row()), status: t.mySpotStatus(t.mySpots[0]), list: (document.querySelector('#mySpotList') || {}).textContent || '' };
      // 근처(200m 뒤) 같은 방향 카메라 55 를 넣는다 (사용자 행 앞에 넣으려고 사용자 행을 다시 만든다)
      t.mySpots.length = 0; t.applyUserSpots();
      add(mk(at(11800), 55, 1));
      t.cams.userBase = null;
      t.mySpots.push({ lat: Q.lat, lng: Q.lng, h: 0, t: Date.now(), days: ['x'], kmh: 50, lim: 0, rn: '' });
      t.applyUserSpots();
      r.shown = { wanted: t.camWanted(row()), lim: row()[2], saved: t.mySpots[0].lim, status: t.mySpotStatus(t.mySpots[0]) };
    } finally {
      t.prefs.signalCams = keep.sig;
      t.mySpots.length = 0; t.driverSpots.rows.length = 0; t.sharedSpots.length = 0; t.applyUserSpots();
      if (base0 !== null) {
        for (const i of fakes.slice().reverse()) { const c = t.cams.rows[i]; if (!c) continue; const k = Math.floor(c[0] / 0.01) + ':' + Math.floor(c[1] / 0.01); const a = t.cams.grid.get(k); if (a) { const j = a.indexOf(i); if (j >= 0) a.splice(j, 1); } t.camMiss.near.delete(i); t.camState.passed.delete(i); t.camState.saidById.delete(i); }
        t.cams.rows.length = base0; t.cams.userBase = null;
      }
      keep.mine.forEach((x) => t.mySpots.push(x)); keep.drv.forEach((x) => t.driverSpots.rows.push(x)); keep.shared.forEach((x) => t.sharedSpots.push(x));
      t.store.set('mySpots', keep.mineRaw); t.applyUserSpots();
      await resetApp();
    }
    const ok = !r.zero.wanted && !r.zero.seen && r.filled.wanted && r.filled.seen && r.filled.seen.limit === '60' &&
      !r.sigOff.seen && r.sigOn.seen && r.sigOn.seen.limit === '신호' &&
      r.fill.sameRoad === 70 && r.fill.otherRoad === 0 && r.fill.noName === 0 && r.fill.opposite === 0 && r.fill.expwy === 100 && r.fill.unknown === 0 &&
      !r.hidden.wanted && r.hidden.status === 'nolimit' && /제한속도 모름이라 숨김/.test(r.hidden.list) &&
      r.shown.wanted && r.shown.lim === 55 && r.shown.saved === 55 && r.shown.status !== 'nolimit';
    return { pass: !!ok, detail: JSON.stringify(r) };
  }

  // S113: '내 위치로' (v177, 2026-11-20 운전자 '내 위치로 작동이 잘 안 먹는 거 같애서')
  async function s113() {
    const t = T(), r = {}, R = buildNavRoute();
    const m = () => t.getMap();
    await waitFor(() => t.getMap(), 10000);
    const meNow = () => t.motion.cur || t.state.fix;
    const away = () => { const me = meNow(); m().center(me.lat + 0.0027, me.lng + 0.002, true); };
    const calls = [];
    const setZ = m().setZoom;
    m().setZoom = function (z) { calls.push(z); return setZ.call(this, z); };
    const press = (id) => {
      const b = document.getElementById(id), rc = b.getBoundingClientRect(), shown = !b.hidden && rc.width > 0;   // 누르기 전에
      const x = rc.left + rc.width / 2, y = rc.top + rc.height / 2;
      const top = document.elementFromPoint(x, y);
      const byHarness = !!(top && top.closest && top.closest('[id^="harness"], [class*="harness"]'));
      const el = top && top.closest && top.closest('#' + id) ? top : b;
      const ev = (type) => el.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerType: 'touch', pointerId: 9, isPrimary: true }));
      const c0 = calls.length;
      ev('pointerdown'); ev('pointerup'); el.click();
      const me = meNow();
      return { shown, covered: !!top && !(top.closest && top.closest('#' + id)) && !byHarness,
        off: me ? Math.round(hav(m().getCenter(), me)) : null, following: t.state.following, manual: t.zoomCtl.manualUntil, zoomCalls: calls.slice(c0) };
    };
    try {
      // (a) 앞길 보기(끌기) 뒤
      await resetApp();
      let pos = TRIP_ORIGIN;
      for (let k = 0; k < 8; k++) { pos = dest(pos, 80, 12); feed(pos, 12, 80); }
      t.setFollowing(false, true, true); away();
      r.peek = press('backMe');
      // (b) 두 손가락 확대 뒤 (손 배율 2분) — 누르면 자동 배율로
      t.manualZoom(1); t.setFollowing(false, true, true); away();
      const manual0 = t.zoomCtl.manualUntil > 0;
      r.pinch = Object.assign(press('backMe'), { manual0 });
      // (c) 길안내 중
      softReset();
      await planAndStart(R);
      for (let s2 = 30; s2 <= 150; s2 += 15) { const a = pointAt(R, s2); feed(a.p, 12, a.h); }
      t.setFollowing(false, true, true); away();
      r.nav = press('backMe');
      // (d) GPS 끊김 뒤 (위치가 더 안 온다) · (e) 화면이 가려졌다 돌아온 뒤
      t.setFollowing(false, true, true); away();
      r.gpsLost = press('backMe');
      t.resumeVisible(); t.setFollowing(false, true, true); away();
      r.resumed = press('backMe');
      t.endNav();
      // (f) 경로 미리보기 중: 아래 '내 위치로' 는 없고 오른쪽 위치 버튼
      softReset();
      stub.canned['/route'] = { alternatives: [Object.assign({ option: 'traoptimal' }, R.route)] };
      feed(R.P[0], 0, null);
      await t.planRoute(R.dest, false);
      away();
      r.preview = Object.assign(press('locate'), { preview: t.nav.preview, backMeHidden: document.getElementById('backMe').hidden });
      t.endNav();
      // (g) 위치를 아직 모를 때
      t.state.fix = null;
      t.motion.cur = null;
      document.getElementById('toast').hidden = true;
      document.getElementById('locate').click();
      r.noFix = { toast: text('#toast'), following: t.state.following };
    } finally {
      m().setZoom = setZ;
      await resetApp();
    }
    const good = (x) => x && x.following && x.off !== null && x.off <= 5 && x.manual === 0 && !x.covered;
    const ok = good(r.peek) && r.peek.shown && good(r.pinch) && r.pinch.manual0 && good(r.nav) && r.nav.shown && good(r.gpsLost) && good(r.resumed) &&
      good(r.preview) && r.preview.preview && r.preview.backMeHidden && /아직 내 위치를 몰라요/.test(r.noFix.toast);
    return { pass: !!ok, detail: JSON.stringify(r) };
  }

  // S112: 여러 운전자 신고 자동 반영 (v175, 2026-11-20 운전자 '3명 이상 신고된 곳은 자동 반영해도 좋을 거 같아 한번 더 검증하면 되니까 AI가')
  async function s112() {
    const t = T(), r = {};
    const O = dest(NAV_ORIGIN, 90, 48000), at = (x, y) => dest(dest(O, 90, x), 0, y);
    const keep = { drv: t.driverSpots.rows.slice(), shared: t.sharedSpots.slice(), mine: t.mySpots.slice(), mineRaw: t.store.get('mySpots'),
      fixRaw: t.store.get('camFix') };
    const fakes = [];
    let base0 = null;
    const realF = window.fetch;
    const label = () => ({ type: text('#camType'), limit: text('#camLimit'), crowd: document.getElementById('camCard').classList.contains('crowd') });
    try {
      t.driverSpots.rows.length = 0; t.sharedSpots.length = 0; t.mySpots.length = 0; t.camFixes.clear(); t.sharedFixes.clear();
      t.applyUserSpots(); base0 = t.cams.rows.length;
      // 남행으로 적힌 60 카메라 B — 북쪽으로 가면 원래는 안 알린다. 자동 반영 '양방향' 고침이 오면 알린다
      const B = [round6(at(0, 3000).lat), round6(at(0, 3000).lng), 60, 1, 0, 0, 0, -1, 4, 1];
      B.eb = 180; B.e2 = 0; B.lv = 0; B.sl = B[0]; B.sg = B[1]; B.on = '';
      { const i = t.cams.rows.length; t.cams.rows.push(B); fakes.push(i); const k = Math.floor(B[0] / 0.01) + ':' + Math.floor(B[1] / 0.01); if (!t.cams.grid.has(k)) t.cams.grid.set(k, []); t.cams.grid.get(k).push(i); }
      t.cams.userBase = null; t.applyUserSpots();
      const A = at(0, 6000), C = at(0, 9000), D = at(0, 12000);
      // v178: 신고 지점은 근처(300m) 같은 방향 카메라의 제한속도를 받아야 보인다 — 각 지점 200m 뒤에 둔다
      for (const [y, lim] of [[5800, 80], [8800, 70], [11800, 50]]) {
        const F = [round6(at(0, y).lat), round6(at(0, y).lng), lim, 1, 0, 0, 0, -1, 4, 1]; F.eb = 0; F.e2 = 0; F.lv = 0; F.sl = F[0]; F.sg = F[1]; F.on = '';
        const i = t.cams.rows.length; t.cams.rows.push(F); fakes.push(i); const k = Math.floor(F[0] / 0.01) + ':' + Math.floor(F[1] / 0.01); if (!t.cams.grid.has(k)) t.cams.grid.set(k, []); t.cams.grid.get(k).push(i);
      }
      t.cams.userBase = null; t.applyUserSpots();
      window.fetch = (u, o) => (/\/fixes(\?|$)/.test(String(u)) ? Promise.resolve(new Response(JSON.stringify({ v: 1, items: [
        { kind: 'dir', k: B[0] + ',' + B[1], lat: B[0], lng: B[1], h: 0, src: 'auto' },
        { kind: 'spot', lat: A.lat, lng: A.lng, h: 0, src: 'auto' },
        { kind: 'spot', lat: C.lat, lng: C.lng, h: 0, src: 'op' },
        { kind: 'spot', lat: D.lat, lng: D.lng, h: 0 }] }), { status: 200 })) : realF(u, o));
      r.load = await t.loadSharedFixes();
      window.fetch = realF;
      r.fix = { e2: B.e2, crowd: !!B.crowd };
      const pass = async (pt) => { let seen = null; await driveThrough(pt, 0, 700, 0, 60, 16.7, () => { const tg = t.camState.target; if (tg && !seen && Math.abs(tg.c[0] - round6(pt.lat)) < 1e-4) seen = label(); }); return seen; };
      r.cam = await pass(at(0, 3000));
      r.auto = await pass(A);
      r.op = await pass(C);
      r.old = await pass(D);
      // 내가 신고한 지점이 자동 반영 지점과 같은 자리면
      t.mySpots.push({ lat: A.lat, lng: A.lng, h: 0, t: Date.now(), days: ['x'], kmh: 60 });
      r.status = t.mySpotStatus(t.mySpots[t.mySpots.length - 1]);
    } finally {
      window.fetch = realF;
      t.sharedFixes.clear(); t.sharedSpots.length = 0;
      t.driverSpots.rows.length = 0; t.mySpots.length = 0; t.applyUserSpots();
      if (base0 !== null) {
        for (const i of fakes.slice().reverse()) { const c = t.cams.rows[i]; if (!c) continue; const k = Math.floor(c[0] / 0.01) + ':' + Math.floor(c[1] / 0.01); const a = t.cams.grid.get(k); if (a) { const j = a.indexOf(i); if (j >= 0) a.splice(j, 1); } t.camMiss.near.delete(i); t.camState.passed.delete(i); t.camState.saidById.delete(i); }
        t.cams.rows.length = base0; t.cams.userBase = null;
      }
      t.camFixes.clear(); t.store.set('camFix', keep.fixRaw);
      keep.drv.forEach((x) => t.driverSpots.rows.push(x)); keep.shared.forEach((x) => t.sharedSpots.push(x)); keep.mine.forEach((x) => t.mySpots.push(x));
      t.store.set('mySpots', keep.mineRaw);
      t.applyUserSpots(); t.applyCamFixes();
      await resetApp();
    }
    const ok = r.load && r.fix.e2 === 1 && r.fix.crowd &&
      r.cam && r.cam.crowd && r.cam.limit === '60' &&
      r.auto && r.auto.type === '사용자 제보 단속 지점' && r.auto.limit === '80' && !r.auto.crowd &&
      r.op && r.op.type === '운전자 신고 단속 지점' && r.old && r.old.type === '운전자 신고 단속 지점' &&
      r.status === 'crowd';
    return { pass: !!ok, detail: JSON.stringify(r) };
  }

  // S111: 카페 시험자 피드백 (v174, 2026-11-20)
  async function s111() {
    const t = T(), r = {}, R = buildNavRoute();
    const keepBroken = t.tts.broken, keepNoticed = t.tts.noticed, keepVoice = t.prefs.voice;
    try {
      await planAndStart(R);
      // 화면의 내 차가 가는 곳: 붙었으면 경로 위 점, 아니면 GPS 점 (motion.cur 는 그쪽으로 부드럽게 따라간다)
      const me = () => (t.motion.snap ? t.routePointAt(t.nav.along) : t.motion.fix);
      const go = (m, side, v) => { const a = pointAt(R, m); const q = side ? dest(a.p, a.h + 90, side) : a.p; feed(q, v == null ? 15 : v, a.h); return { a, q }; };
      // (a) 경로 위 → 붙음
      for (let m = 60; m <= 200; m += 20) go(m, 6);
      const on = go(220, 6);
      r.near = { onRoute: t.nav.onRoute, snap: t.nav.snap, toLine: Math.round(hav(me(), on.a.p)) };
      // (b) 25m 옆 나란한 길: 이탈 판정 전(경로 위로 봄)이어도 아이콘은 실제 자리
      let par = null;
      for (let m = 240; m <= 300; m += 20) par = go(m, 25);
      r.parallel = { onRoute: t.nav.onRoute, snap: t.nav.snap, toReal: Math.round(hav(me(), par.q)), toLine: Math.round(hav(me(), par.a.p)) };
      // 다시 경로 위로 → 붙음
      let back = null;
      for (let m = 320; m <= 380; m += 20) back = go(m, 3);
      r.back = { snap: t.nav.snap, toLine: Math.round(hav(me(), back.a.p)) };
      // (c) 회전 구간(우회전 600m 앞 300m 안): 40m 옆 — 이탈 허용 60m 라 경로 위로 보지만 아이콘은 실제 자리
      let ex = null;
      for (let m = 440; m <= 500; m += 20) ex = go(m, 40);
      r.exit = { onRoute: t.nav.onRoute, snap: t.nav.snap, toReal: Math.round(hav(me(), ex.q)) };
      // (d) 확대: 손으로 바꾸면 2분 동안 자동 줌이 덮어쓰지 않는다
      for (let m = 520; m <= 560; m += 20) go(m, 0);
      await waitFor(() => t.getMap(), 10000);   // 짧게 돌릴 때는 지도가 아직 안 떴을 수 있다
      const m0 = t.getMap();
      t.zoomCtl.manualUntil = 0; t.zoomCtl.last = 0;
      // (화면이 숨겨져 있으면 지도 확대 애니메이션이 끝나지 않으므로 배율 값 대신 '언제까지 손 배율' 과 자동 줌 호출을 본다)
      const f0 = t.state.fix.t;
      t.manualZoom(-1);
      const z1 = t.zoomCtl.manualUntil - f0;
      const calls = [], setZ = m0.setZoom;
      m0.setZoom = function (z) { calls.push(z); return setZ.call(this, z); };
      try {
        // 자동 줌이 바꿀 값이 지금 배율과 다르게: 지금 17 이면 시속 120(→16), 아니면 시속 40(→17)
        const want = Math.round(m0.getZoom()) === 17 ? 16 : 17;
        t.state.speedKmh = want === 16 ? 120 : 40;
        r.want = want;
        t.autoZoom({ ...t.state.fix, t: f0 + 60000 });
        const at60 = calls.slice();
        t.autoZoom({ ...t.state.fix, t: f0 + 121000 });
        r.zoom = { manual: z1, at60s: at60, at121s: calls.slice(at60.length), hold: t.MANUAL_ZOOM_MS };
      } finally { m0.setZoom = setZ; }
      // (e) 음성이 안 나오는 브라우저: 설정 '소리'에 이유, 경고음으로
      t.prefs.voice = true; t.tts.broken = true; t.tts.noticed = true;
      t.renderVoiceState();
      const vs = document.getElementById('voiceState');
      r.voice = { shown: !vs.hidden, text: vs.textContent, status: t.ttsStatus() };
      // (f) 화면 복귀
      t.resumeVisible();
      r.resume = { nav: t.nav.active, panel: visible('#navPanel') };
      t.endNav();
    } finally {
      t.tts.broken = keepBroken; t.tts.noticed = keepNoticed; t.prefs.voice = keepVoice; t.renderVoiceState();
      t.zoomCtl.manualUntil = 0;
      await resetApp();
    }
    const ok = r.near.onRoute && r.near.snap && r.near.toLine <= 3 &&
      r.parallel.onRoute && !r.parallel.snap && r.parallel.toReal <= 6 && r.parallel.toLine >= 18 &&
      r.back.snap && r.back.toLine <= 3 &&
      r.exit.onRoute && !r.exit.snap && r.exit.toReal <= 6 &&
      r.zoom.manual === 120000 && !r.zoom.at60s.length && r.zoom.at121s[0] === r.want && r.zoom.hold === 120000 &&
      r.voice.shown && /음성이 나오지 않아/.test(r.voice.text) && r.voice.status === 'broken' &&
      r.resume.nav && r.resume.panel;
    return { pass: !!ok, detail: JSON.stringify(r) };
  }

  // S109: 터널 다크 (v172, 2026-11-20 운전자: '터널 들어가면 다크모드로 되게끔 해 줘 나가면 풀리던가 (밤이면 그대로)')
  async function s109() {
    const t = T(), r = {};
    const O = dest(NAV_ORIGIN, 90, 60000), north = (m) => dest(O, 0, m);
    const enc = (pts, nameIdx, oneway) => { const q = pts.map((x) => [Math.round(x.lat * 1e5), Math.round(x.lng * 1e5)]); const row = [nameIdx, oneway ? 1 : 0, q[0][0], q[0][1]];
      for (let k = 1; k < q.length; k++) row.push(q[k][0] - q[k - 1][0], q[k][1] - q[k - 1][1]); return row; };
    const keepMode = t.store.get('nightMode');
    const darkNow = () => ({ on: t.tnDark.on, map: document.getElementById('map').classList.contains('night') });
    const drive = (y0, y1, x) => { for (let y = y0; y <= y1; y += 20) feed(dest(north(y), 90, x || 0), 16.7, 0); };
    try {
      t.store.set('nightMode', null); t.applyNight();
      let sunNight = t.isNightAt(new Date());   // 지금 실제로 밤이면 지도는 원래 어둡다 (터널 표시 tnDark 로 본다)
      r.sunNight = sunNight;
      t.setTunnelData({ v: 1, scale: 1e5, names: ['테스트터널', ''], w: [
        enc([north(1000), north(1300), north(1600)], 0, true),
        enc([dest(north(3000), 90, 0), dest(north(3600), 90, 0)], 1, true),   // 이름 없는 터널 길 (지하차도일 수 있음)
      ] });
      // (a) 자유 주행: 터널 앞 → 안 → 밖
      await resetApp(); t.tnDark.on = false; t.tnDark.outAt = 0; t.applyNight();
      drive(600, 940);
      // v215: 밤인지는 이 시험 자리(앞 시험 자리에서 60km 동쪽)에서 다시 본다 — 해 질 무렵(2026-11-24 17:19)에는 앞 자리는 낮, 여기는 밤이라 실패했다
      sunNight = t.isNightAt(new Date()); r.sunNight = sunNight;
      r.before = darkNow();
      drive(960, 1200);
      r.inside = darkNow();
      r.insideMap = sunNight ? true : r.inside.map;
      drive(1220, 1640);
      drive(1660, 1760);
      const now = Date.now();
      t.tunnelDarkTick(now);
      r.justOut = t.tnDark.on;
      t.tunnelDarkTick(now + 3000);
      r.out3s = t.tnDark.on;
      t.tunnelDarkTick(now + 9000);
      r.out9s = darkNow();
      // (b) GPS 끊김: 입구 100m 앞에서 위치가 안 온다
      await resetApp(); t.tnDark.on = false; t.tnDark.outAt = 0; t.applyNight();
      drive(700, 900);
      t.tunnelDarkTick(Date.now() + 1500);
      r.lost1s = t.tnDark.on;
      t.tunnelDarkTick(Date.now() + 4500);
      r.lost4s = t.tnDark.on;
      // 입구 100m 앞에 서 있다(신호 대기) — 위치가 드문드문 와도 어두워지지 않는다
      await resetApp(); t.tnDark.on = false; t.tnDark.outAt = 0;
      drive(700, 880);
      for (let k = 0; k < 4; k++) feed(north(900), 0, 0);
      t.tunnelDarkTick(Date.now() + 6000);
      r.parked = t.tnDark.on;
      // (c) 터널 옆 30m 나란한 길 · 이름 없는 터널 길 · '항상 밝게'
      await resetApp(); t.tnDark.on = false; t.tnDark.outAt = 0; t.applyNight();
      drive(900, 1500, 30);
      r.beside = t.tnDark.on;
      await resetApp(); t.tnDark.on = false; t.tnDark.outAt = 0;
      drive(2900, 3400);
      r.unnamed = t.tnDark.on;
      await resetApp(); t.tnDark.on = false; t.tnDark.outAt = 0;
      t.store.set('nightMode', 'off'); t.applyNight();
      drive(900, 1300);
      r.alwaysLight = darkNow();
      t.store.set('nightMode', null); t.applyNight();
      // (d) 길안내: 경로가 지나는 터널 구간
      const P = [];
      for (let k = 0; k <= 300; k++) { const q = north(10 * k); P.push({ lat: round6(q.lat), lng: round6(q.lng) }); }
      const cum = [0];
      for (let i = 1; i < P.length; i++) cum.push(cum[i - 1] + hav(P[i - 1], P[i]));
      const total = cum[cum.length - 1];
      const R = { route: { distance: r0(total), duration: r0(total / 17 * 1000), tollFare: 0, fuelPrice: 0, path: P.map((q) => [q.lng, q.lat]),
        guide: [{ i: 300, t: 88, s: '목적지', d: r0(total), ms: r0(total / 17 * 1000) }], sections: [{ i: 0, n: 301, name: '테스트터널로', speed: 60, cong: 1 }] },
        P, cum, total, dest: { name: '테스트', addr: '', lat: P[300].lat, lng: P[300].lng } };
      await resetApp(); softReset(); t.tnDark.on = false; t.tnDark.outAt = 0;
      await planAndStart(R);
      for (let m = 600; m <= 940; m += 20) { const a = pointAt(R, m); feed(a.p, 16.7, a.h); }
      r.navBefore = t.tnDark.on;
      for (let m = 960; m <= 1200; m += 20) { const a = pointAt(R, m); feed(a.p, 16.7, a.h); }
      r.navInside = t.tnDark.on;
      t.endNav();
    } finally {
      t.store.set('nightMode', keepMode);
      t.setTunnelData(null);
      await t.loadTunnels();
      await resetApp();
      t.tnDark.on = false; t.tnDark.outAt = 0; t.applyNight();
    }
    const ok = !r.before.on && r.inside.on && r.insideMap && r.justOut && r.out3s && !r.out9s.on && (r.sunNight || !r.out9s.map) &&
      !r.lost1s && r.lost4s && !r.parked && !r.beside && !r.unnamed && !r.alwaysLight.on && (r.sunNight || !r.alwaysLight.map) &&
      !r.navBefore && r.navInside;
    return { pass: !!ok, detail: JSON.stringify(r) };
  }

  // S110: 공개 전 보안 점검 (v172): 공개 사용자 신고에는 궤적이 없다 · 토큰이 있으면 궤적과 Authorization · 보내기를 끄면 안 보냄 ·
  //       진단 올리기는 토큰이 있어야 · 설정에서 Client ID 칸과 터널 스위치가 없고 서버·진단·데모·소리 테스트·아이콘 관리는 개발자 메뉴 안
  async function s110() {
    const t = T(), r = {}, ob = t.outbox, keepPost = ob.post, keepBox = t.store.get('outbox');
    const keepTok = t.store.get('adminToken'), keepShare = t.prefs.share;
    const keepSpots = t.mySpots.slice(), keepSpotRaw = t.store.get('mySpots'), keepFix = t.store.get('camFix');
    const btn = document.getElementById('camMissBtn');
    const bodies = [];
    try {
      ob.inTest = true; t.store.set('outbox', null);
      ob.post = async (b) => { bodies.push(b); return { ok: true }; };
      await resetApp();
      for (let y = 0; y <= 200; y += 20) feed(dest(NAV_ORIGIN, 0, y), 16.7, 0);
      // (a) 토큰 없음
      t.store.set('adminToken', null); t.prefs.share = true;
      await t.userReport('wrong');
      const b0 = bodies[bodies.length - 1] || {};
      r.pub = { sent: bodies.length, trace: 'trace' in b0 && b0.trace !== undefined, kmh: b0.kmhNow !== undefined, heading: b0.heading, near: Array.isArray(b0.near),
        auth: !!t.authHeaders({}).Authorization };
      // (b) 운영자 토큰
      t.store.set('adminToken', 'x'.repeat(24));
      await t.userReport('wrong');
      const b1 = bodies[bodies.length - 1] || {};
      r.op = { trace: Array.isArray(b1.trace) && b1.trace.length > 0, auth: t.authHeaders({ a: 1 }).Authorization === 'Bearer ' + 'x'.repeat(24) };
      t.store.set('adminToken', null);
      // (c) 보내기 끔
      t.prefs.share = false;
      const n0 = bodies.length;
      r.offRet = await t.userReport('wrong');
      btn.click();
      await waitFor(() => !btn.classList.contains('sending'), 2000, 20);
      r.off = { ret: r.offRet, sent: bodies.length - n0, label: btn.textContent };
      clearTimeout(btn._sentT); btn.classList.remove('sent', 'saved', 'sending'); btn.textContent = '잘못된 정보 신고';
      t.prefs.share = true;
      // (d) 진단 올리기
      const keepLog = t.diag.log.slice();
      t.diag.log.push([1, 2, 37, 127, 5, 10, 0, 0, 1, 0]);
      await t.uploadDiag();
      r.diagMsg = document.getElementById('toast').textContent;
      t.diag.log.length = 0; keepLog.forEach((x) => t.diag.log.push(x));
      // (e) 설정 화면
      const $ = (q) => document.querySelector(q), inDev = (id) => !!document.getElementById(id) && !!document.getElementById(id).closest('#devMenu');
      const labels = [...document.querySelectorAll('#sheet .tgl > span')].map((x) => x.textContent);
      r.ui = { key: !!$('#keyInput') || !!$('#saveKey') || !!$('#clearKey'), tunnelSw: !!$('#optTunnels'),
        dev: ['proxyInput', 'proxyTest', 'diagToggle', 'diagUpload', 'demoBtn', 'resetTrip', 'soundTest', 'iconAdmin', 'adminInput'].every(inDev),
        plainChecks: document.querySelectorAll('#sheet input[type=checkbox]:not(.tgl input)').length,
        toggles: labels.length, paren: labels.filter((x) => /\(/.test(x) && x !== '차로 안내(회전·직진)'),
        share: !!$('#optShare'), ver: !!$('#verText'),
        // v173: 설정에는 자료별 출처가 없고(운전자 '악용한다고'), 지도 출처 표시에 OSM·공공데이터 이름만
        srcText: /경찰청|국토지리정보원|한국도로공사|Open-Meteo|ODbL/.test(document.querySelector('#sheet .set-group.info').textContent),
        credit: /OpenStreetMap/.test(($('#map .attrib') || {}).textContent || '') && /OpenStreetMap/.test(($('#map .attrib-own') || {}).textContent || ''), groups: [...document.querySelectorAll('#sheet .set-group h3')].map((x) => x.textContent).join('/') };
    } finally {
      ob.post = keepPost; ob.inTest = false; t.store.set('outbox', keepBox);
      t.store.set('adminToken', keepTok); t.prefs.share = keepShare;
      t.mySpots.length = 0; keepSpots.forEach((x) => t.mySpots.push(x)); t.store.set('mySpots', keepSpotRaw); t.applyUserSpots();
      t.store.set('camFix', keepFix); t.camFixes.clear(); t.applyCamFixes();
      await resetApp();
    }
    const ok = r.pub.sent >= 1 && !r.pub.trace && !r.pub.kmh && r.pub.heading === 0 && r.pub.near && !r.pub.auth &&
      r.op.trace && r.op.auth && r.off.ret === null && r.off.sent === 0 && r.off.label === '✓ 저장' && /운영자 토큰/.test(r.diagMsg) &&
      !r.ui.key && !r.ui.tunnelSw && r.ui.dev && r.ui.plainChecks === 0 && r.ui.toggles >= 16 && !r.ui.paren.length && r.ui.share && r.ui.ver &&
      r.ui.groups === '소리/단속·경고/길안내 화면/지도/경로/내 신고/정보/개발자 메뉴' && !r.ui.srcText && r.ui.credit;
    return { pass: !!ok, detail: JSON.stringify(r) };
  }

  // S96: 소리 잠김 표시 (v160, 2026-11-20 점검: 새로고침·'새 버전' 뒤 화면을 누를 때까지 음성·경고음이 모두 꺼져 있는데 표시가 없었다).
  //      주차 중(길안내 없음·시속 0)에는 안 띄우고, 달리기 시작하면(시속 30) '소리 꺼짐 · 화면을 한 번 누르세요', 손을 떼면 사라진다.
  //      소리를 둘 다 꺼 두었으면 안 띄운다
  async function s96() {
    const t = T(), r = {}, keep = { u: t.sound.unlocked, v: t.prefs.voice, b: t.prefs.beep, k: t.state.speedKmh };
    const pill = () => { const e = document.getElementById('soundPill'); return e && !e.hidden ? e.textContent : ''; };
    try {
      t.prefs.voice = true; t.prefs.beep = true;
      t.sound.unlocked = false;
      t.state.speedKmh = 0; t.updateSoundPill(); r.parked = pill();
      t.state.speedKmh = 30; t.updateSoundPill(); r.driving = pill();
      document.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerType: 'touch' }));
      r.afterTouch = pill(); r.unlocked = t.sound.unlocked;
      t.sound.unlocked = false; t.prefs.voice = false; t.prefs.beep = false; t.updateSoundPill(); r.soundOff = pill();
    } finally {
      t.sound.unlocked = keep.u; t.prefs.voice = keep.v; t.prefs.beep = keep.b; t.state.speedKmh = keep.k; t.updateSoundPill();
    }
    const ok = r.parked === '' && /소리 꺼짐/.test(r.driving) && r.afterTouch === '' && r.unlocked === true && r.soundOff === '';
    return { pass: ok, detail: JSON.stringify(r) };
  }
  // S101: 단속 카메라 자료 v164 (2026-11-19 자료 점검. 운전자 '과속단속만 완벽하면 이제 그냥 네비임', '서울 경기 전역을 일단 한번 해봐바').
  //  - 한 기둥에 두 방향 카메라: 예전엔 한 행으로 합쳐 OSM 방향이 하나라 반대 방향은 영영 안 울렸다(1,599행 중 1,298행). 이제 두 행, 서로 반대 방향,
  //    각자 제 차로 점. 경수대로 어바인퍼스트 앞 60(서울→수원 / 수원→서울)을 두 방향으로 지나면 각 방향에서 그 방향 행이 뜬다
  //  - 차로만 다른 한 방향 기록(영동고속도로 51.2km 시점 1,2·3,4·5차로, 방향 코드가 1·2 로 섞임)은 짝으로 만들지 않는다
  //  - 자료 값: 수도권제1순환 23.5k 부스(PDF 표가 붙어 '어린이보호구역 50' 이던 것) 100·고속국도, 충북 '경부선 307.6' 부스 100·고속국도,
  //    송추초 정문 어린이보호구역 부스 30, 경기북부 후면 카메라(성모병원입구사거리 J4057) 후면, 녹색로 구간 길이 3.6km(3,625km 아님),
  //    바뀐 자리는 mobile.json unflag 에 있다
  async function s101() {
    const t = T(), rows = t.cams.rows, r = {};
    const near = (lat, lng, m, f) => rows.filter((c) => hav({ lat, lng }, { lat: c[0], lng: c[1] }) <= m && (!f || f(c)));
    const angd = (a, b) => Math.abs(((a - b) % 360 + 540) % 360 - 180);
    const mob = await (await realFetch(new URL('../data/mobile.json', location.href).href, { cache: 'no-store' })).json();
    const unflag = new Set((mob.unflag && mob.unflag.keys) || []);
    // 차로 위 점을 지나는 곧은 2.4km 경로(카메라 1.4km 앞에서 시작)를 시속 kmh 로: 처음 뜬 거리·카메라·제한
    async function drive(c, h, road, kmh) {
      const lane = { lat: c.sl != null ? c.sl : c[0], lng: c.sg != null ? c.sg : c[1] };
      const start = dest(lane, (h + 180) % 360, 1400);
      const P = [];
      for (let k = 0; k <= 240; k++) { const p = dest(start, h, 10 * k); P.push({ lat: round6(p.lat), lng: round6(p.lng) }); }
      const cum = [0];
      for (let i = 1; i < P.length; i++) cum.push(cum[i - 1] + hav(P[i - 1], P[i]));
      const total = cum[cum.length - 1];
      const R = { route: { distance: r0(total), duration: r0(total / 15 * 1000), tollFare: 0, fuelPrice: 0, path: P.map((p) => [p.lng, p.lat]),
        guide: [{ i: 240, t: 88, s: '목적지', d: r0(total), ms: r0(total / 15 * 1000) }],
        sections: [{ i: 0, n: 241, name: road, speed: kmh, cong: 1 }] },
        P, cum, total, dest: { name: '테스트', addr: '', lat: P[240].lat, lng: P[240].lng } };
      await resetApp(); softReset();
      await planAndStart(R);
      const o = { first: null, cam: null, limit: null };
      try {
        for (let s = 0; s <= 1390; s += 20) {
          const a = pointAt(R, s);
          feed(a.p, kmh / 3.6, a.h, { dt: 20 / (kmh / 3.6) * 1000 });
          const tg = t.camState.target;
          if (tg && o.first === null && hav(lane, { lat: tg.c[0], lng: tg.c[1] }) < 80) { o.first = r0(1400 - s); o.cam = tg.c; o.limit = text('#camLimit'); o.label = text('#camType'); }
        }
      } finally { t.endNav(); }
      return o;
    }
    try {
      // 1. 경수대로 어바인퍼스트 앞 60: 두 행, 서로 반대, 각 방향에서 제 행
      const two = near(37.3745, 126.9585, 150, (c) => c[2] === 60 && c.eb >= 0 && !c.e2);
      const pair = [];
      for (const a of two) for (const b of two) if (a !== b && angd(a.eb, b.eb) >= 150 && hav({ lat: a[0], lng: a[1] }, { lat: b[0], lng: b[1] }) < 30) pair.push([a, b]);
      r.pairRows = two.length; r.pairFound = pair.length > 0;
      if (pair.length) {
        const [a, b] = pair[0];
        const da = await drive(a, a.eb, '경수대로', 50), db = await drive(b, b.eb, '경수대로', 50);
        r.dirA = { first: da.first, own: da.cam === a, limit: da.limit };
        r.dirB = { first: db.first, own: db.cam === b, limit: db.limit };
      }
      // 2. 차로만 다른 한 방향 기록은 짝이 아니다 (영동고속도로 51.2km 시점)
      const lanes = near(37.262, 127.198, 80, (c) => c[2] === 100 && c[3] === 9 && c.eb >= 0);
      r.laneRows = lanes.length;
      r.laneSameWay = lanes.length >= 1 && lanes.every((c) => angd(c.eb, lanes[0].eb) < 60);
      // 3. 자료 값
      const g1 = near(37.560956, 127.174292, 20, (c) => isBoxRow(c))[0];
      r.ggb1 = g1 ? { lim: g1[2], zone: g1[6], rtype: g1[8], unflag: unflag.has(g1[0] + ',' + g1[1]) } : 'none';
      const cb2 = near(36.65214, 127.373223, 20)[0];
      r.cb2 = cb2 ? { lim: cb2[2], rtype: cb2[8] } : 'none';
      const school = near(37.715797, 126.971141, 20)[0];
      r.school = school ? { lim: school[2], zone: school[6] } : 'none';
      const rear = near(37.7565, 127.0798, 60, (c) => c[2] === 50);
      r.rear = rear.length ? rear.some((c) => ((c[10] | 0) & 1) === 1) : 'none';
      const sec = near(34.736, 126.51, 300, (c) => c[4] === 1 && c[2] === 80);
      r.secLen = sec.length ? sec.map((c) => c[5]) : 'none';
      // 4. 좌표: 같은 관리번호의 예전 기록은 빼고(권선초교 J6049 예전 기록은 경도 125.70 = 바다), 엉뚱한 좌표는 주소 자리로
      //    (세종포천고속도로 120 네 대가 긴밭뜰삼거리 50 자리에 → 용인 원삼면, 강남 개포동역 K0377 이 바다에 → 개포로 416)
      r.seaGone = near(37.2625045, 125.7021377, 2000).length === 0;
      r.ghost120 = near(37.3444581, 127.2519161, 80, (c) => c[2] === 120).length;
      r.kaepo = near(37.487982, 127.065552, 120).length;
      // 5. 도로 종류·이름 (2026-11-20 서울·경기 가상 주행 점검): 경부고속도로 서울 구간 80 은 고속국도(3km 앞부터), 원본이 '고속국도'인
      //    분당수서로 60 은 일반도로, 세종포천 위 '평택시흥고속도로' 2대는 세종포천, 오타 '호극로'는 '호국로'
      const roadOf = (c) => (t.cams.roads && c[7] >= 0 ? t.cams.roads[c[7]] : '') || '';
      const gb = near(37.48256, 127.02654, 30, (c) => c[2] === 80)[0];
      r.gyeongbuSeoul = gb ? gb[8] : 'none';
      const bd = near(37.37226, 127.10391, 30, (c) => c[2] === 60)[0];
      r.bundangSuseo = bd ? bd[8] : 'none';
      const sp = near(37.26291, 127.25048, 30, (c) => c[2] === 110)[0];
      r.sejongPocheon = sp ? roadOf(sp) : 'none';
      r.typo = rows.some((c) => roadOf(c) === '호극로') ? 'still 호극로' : rows.some((c) => roadOf(c) === '호국로') ? '호국로' : 'none';
      // 6. v166 (2026-11-20 v165 가상 주행): 일반도로 50 카메라는 고속도로 본선에 붙지 않는다(번영로 50 이 영동고속도로 위에 있었다:
      //    차로 위 점이 본선 쪽이면 번영로 경로에서 15m 밖), 경기북부 부스 GGB-33(서울양양 19.8K)은 광주 진토길이 아니라 양평 서종면,
      //    세종포천 구간 끝 100 은 고속국도이고 방향이 있다, 이동식은 층 표시가 없다(IC 고가 부스가 지상 경로에서 빠졌다)
      const by = near(37.32915, 126.93012, 30, (c) => c[2] === 50)[0];
      // v164 자료의 차로 위 점(영동고속도로 본선 위) 37.32877,126.93027 에서 떨어졌는지
      r.beonyeong = by ? (by.eb < 0 ? 'no road' : hav({ lat: by.sl, lng: by.sg }, { lat: 37.32877, lng: 126.93027 }) > 30 ? 'street' : 'motorway lane') : 'none';
      r.ggb33 = { old: near(37.380274, 127.214705, 300, (c) => c[2] === 100).length, now: near(37.633843, 127.362978, 300, (c) => c[2] === 100).length };
      const sp2 = near(37.50804, 127.17323, 30, (c) => c[2] === 100 && c[4] === 2)[0];
      r.sejongEnd = sp2 ? { rtype: sp2[8], eb: sp2.eb } : 'none';
      r.mobileLv = rows.slice(rows.length - (t.cams.mobile || 0)).filter((c) => c.lv).length;
      // 7. v168 (v167 가상 주행): 포천 산정호수로 어린이 60 자리의 유령 80(의정부 J4981 기록이 좌표·주소를 베낌), 부인터사거리 60 자리의
      //    예전 기록 80(F7376 2025-06, 같은 자리 새 기록 60) 이 없다 — 1km 앞부터 80 으로 알리던 곳
      r.ghost80 = near(38.07141, 127.30083, 20, (c) => c[2] === 80).length + near(37.80533, 127.13137, 20, (c) => c[2] === 80).length;
      // 8. v178 (2026-11-20 19:28 운전자 '정지선 기준으로 과속단속을 잡는게 좋아', 티맵과 비교): 서하남IC입구교차로 신호·과속 50(J3195)은
      //    기둥이 교차로 남동쪽 우회전 연결로 옆인데 차로 위 점이 서하남로 동행 건너편 횡단보도 너머(37.5169,127.14442)였다 — 강동대로 동행 정지선에
      //    선 차에 '90m'. 이제 강동대로 동행 정지선(교차로 노드 127.14386 서쪽 8m 안팎, 37.51701,127.14377)
      const sh = near(37.5167, 127.14425, 15, (c) => c[2] === 50 && (c[3] === 3 || c[3] === 2))[0];
      r.seohanam = sh ? { eb: sh.eb, lng: Math.round(sh.sg * 1e5) / 1e5, toStop: Math.round(hav({ lat: sh.sl, lng: sh.sg }, { lat: 37.51701, lng: 127.14377 })) } : 'none';
      // 9. v180 (운전자 '물음표 나오는 과속단속은 안 나오게' — 앱이 '?' 를 숨긴다): 자료에서 채워 '?' 로 남는 과속 카메라는 600곳 아래
      r.unknownLimits = rows.filter((c) => !c[2] && c[3] !== 2).length;
      // 10. v185 (keys 세션 전달, 운전자 '넘겨 줘'): 서울 이동식 '영동대교 남단(북→남방향)' 같은 한 글자 방위 글이 양방향(3)으로 들어갔다.
      //     한 방향(1), 찍는 방향은 그 방위 — 남단은 남행(205°), 북단은 북행(20°)
      const yd = (lat, lng) => near(lat, lng, 5, (c) => c[3] === 8)[0];
      const yS = yd(37.52618, 127.054889), yN = yd(37.534773, 127.05987);
      r.yeongdong = yS && yN ? { sDir: yS[9], sEb: yS.eb, nDir: yN[9], nEb: yN.eb } : 'none';
      // 11. v189 (keys 세션 '전체적으로 봐줘야 하지 않아?'): 같은 자리라 빠진 한 글자 방위 줄을 남은 줄의 방향 단서로 — 대구 남산초등학교 앞은 북행
      //     ('계대네거리→신남네거리'·'남→북', 예전엔 남행 177°), 크레텍 앞은 남행·북행 두 줄
      const ns = near(35.862237, 128.582448, 5, (c) => c[3] === 8)[0];
      const kr = near(35.873857, 128.582069, 5, (c) => c[3] === 8);
      r.daegu = { namsan: ns ? ns.eb : 'none', cretec: kr.map((c) => c.eb) };
    } finally {
      await resetApp(); softReset();
    }
    const okDir = (o) => o && o.own && o.first >= 250 && o.limit === '60';
    const ok = r.pairFound && okDir(r.dirA) && okDir(r.dirB) && r.laneRows >= 1 && r.laneSameWay &&
      r.ggb1 !== 'none' && r.ggb1.lim === 100 && r.ggb1.zone === 0 && r.ggb1.rtype === 1 && r.ggb1.unflag &&
      r.cb2 !== 'none' && r.cb2.lim >= 100 && r.cb2.rtype === 1 && r.school !== 'none' && r.school.lim === 30 && r.school.zone === 2 &&
      r.rear === true && Array.isArray(r.secLen) && r.secLen.every((x) => x > 1000 && x < 20000) &&
      r.seaGone && r.ghost120 === 0 && r.kaepo >= 1 &&
      r.gyeongbuSeoul === 1 && r.bundangSuseo !== 'none' && r.bundangSuseo !== 1 && /세종포천/.test(r.sejongPocheon) && r.typo === '호국로' &&
      r.beonyeong !== 'none' && r.beonyeong !== 'motorway lane' && r.ggb33.old === 0 && r.ggb33.now >= 1 &&
      r.sejongEnd !== 'none' && r.sejongEnd.rtype === 1 && r.sejongEnd.eb >= 0 && r.mobileLv === 0 && r.ghost80 === 0 &&
      r.seohanam !== 'none' && angd(r.seohanam.eb, 101) <= 30 && r.seohanam.lng < 127.14386 && r.seohanam.toStop <= 12 && r.unknownLimits < 600 &&
      r.yeongdong !== 'none' && r.yeongdong.sDir === 1 && r.yeongdong.nDir === 1 && angd(r.yeongdong.sEb, 205) <= 30 && angd(r.yeongdong.nEb, 20) <= 30 &&
      r.daegu.namsan !== 'none' && angd(r.daegu.namsan, 0) <= 40 && r.daegu.cretec.length === 2 && angd(r.daegu.cretec[0], r.daegu.cretec[1]) >= 120;
    return { pass: !!ok, detail: JSON.stringify(r) };
  }
  const isBoxRow = (c) => ((c[10] | 0) & 2) === 2;

  // S95: 고속도로 박스형 부스의 제한속도 (v159, 2026-11-16~19 놓침·틀림 신고): 경기남부 고속도로순찰대 '이동형 단속 부스' 목록엔 제한속도가 없어
  //      옆 일반도로 고정 카메라 값(50·60)이 들어갔다. 송파IC 10.3k(퇴계원방향)는 앞 93m 에서도 안 떴고(놓침 2번), 판교JC 1.25k 는 '박스형 60'(틀림 2번).
  //      부스 자리를 지나는 곧은 2.4km 수도권제1순환고속도로 경로(부스 1.4km)를 시속 90 으로: 두 부스 다 뜨고 제한속도는 고속도로 값(100)
  //      예전 값 때문에 누른 '틀림'(그 방향 숨김)이 남아 있으면 고쳐도 놓친다: mobile.json unflag 에 두 부스가 있고, 앱이 한 번만 풀고, 풀린 뒤 다시 뜬다
  async function s95() {
    const t = T(), rows = t.cams.rows;
    const B = [{ k: 'songpa', lat: 37.478647, lng: 127.134273, h: 31 }, { k: 'pangyo', lat: 37.407853, lng: 127.108583, h: 269 }];
    const r = {};
    const mob = await (await realFetch(new URL('../data/mobile.json', location.href).href, { cache: 'no-store' })).json();
    const unflagKeys = new Set((mob.unflag && mob.unflag.keys) || []);
    const keepNo = new Map(t.camNoMap), keepFlag = t.store.get('camNoUnflag'), keepRaw = t.store.get('camNo2');
    try {
      for (const b of B) {
        const c = rows.find((x) => sameCam(x, b));
        if (!c) { r[b.k] = 'not in data'; continue; }
        // 틀림 표시: 숨김 → 한 번 풀림(같은 id 로는 다시 안 풂)
        const key = c[0] + ',' + c[1], two = () => [{ h: b.h, t0: Date.now(), t1: Date.now(), days: ['d1', 'd2'], lim: 0, name: '' }];
        t.camNoMap.set(key, two());
        const u = { listed: unflagKeys.has(key), hidden: t.camUserNo(c, b.h) };
        t.store.set('camNoUnflag', '');
        const id = 'S95-' + b.k;
        u.n1 = t.camNoUnflag({ id, keys: [key] });
        u.after = t.camUserNo(c, b.h);
        t.camNoMap.set(key, two());
        u.n2 = t.camNoUnflag({ id, keys: [key] });
        t.camNoMap.delete(key);
        const lane = { lat: c.sl != null ? c.sl : c[0], lng: c.sg != null ? c.sg : c[1] };
        const start = dest(lane, (b.h + 180) % 360, 1400);
        const P = [];
        for (let k = 0; k <= 240; k++) { const p = dest(start, b.h, 10 * k); P.push({ lat: round6(p.lat), lng: round6(p.lng) }); }
        const cum = [0];
        for (let i = 1; i < P.length; i++) cum.push(cum[i - 1] + hav(P[i - 1], P[i]));
        const total = cum[cum.length - 1];
        const R = { route: { distance: r0(total), duration: r0(total / 25 * 1000), tollFare: 0, fuelPrice: 0, path: P.map((p) => [p.lng, p.lat]),
          guide: [{ i: 240, t: 88, s: '목적지', d: r0(total), ms: r0(total / 25 * 1000) }],
          sections: [{ i: 0, n: 241, name: '수도권제1순환고속도로', speed: 90, cong: 1 }] },
          P, cum, total, dest: { name: '테스트', addr: '', lat: P[240].lat, lng: P[240].lng } };
        await resetApp(); softReset();
        await planAndStart(R);
        const o = { lim: c[2], dir: c[9], first: null, limit: null, unflag: u };
        try {
          t.ensureRouteCams();
          o.onRoute = t.nav.routeCams.has(c);
          for (let s = 0; s <= 1390; s += 20) {
            const a = pointAt(R, s);
            feed(a.p, 90 / 3.6, a.h, { dt: 800 });
            const tg = t.camState.target;
            if (tg && tg.c === c && o.first === null) { o.first = r0(1400 - s); o.limit = text('#camLimit'); o.label = text('#camType'); }
          }
        } finally { t.endNav(); }
        r[b.k] = o;
      }
    } finally {
      t.camNoMap.clear(); keepNo.forEach((v, k) => t.camNoMap.set(k, v)); t.store.set('camNo2', keepRaw);
      t.store.set('camNoUnflag', keepFlag || '');
      await resetApp(); softReset();
    }
    const ok = B.every((b) => { const o = r[b.k], u = o && o.unflag;
      return o && o.onRoute && o.first >= 500 && o.limit === '100' && u.listed && u.hidden && u.n1 === 1 && !u.after && u.n2 === 0; });
    return { pass: ok, detail: JSON.stringify(r) };
  }

  // S94: 가까운 것이 위로 (v158, 2026-11-17 20:04 이배재터널 안 서행: '1.8km 좌회전' 밑 '370m 이배재터널 출구까지', 그 밑 '↗ 230m' —
  //      운전자 '우리 가까운 순서가 위로 올라오기로 했는데 … 전체적으로 확인해볼래'. 230m 는 좌회전 지점부터 잰 거리(차에서 2.0km)였다).
  //      북쪽 2.6km 고속도로 구간: 1.8km 좌회전 · 2,030m 1시 방향 · 2.6km 도착, 300~970m 터널, 1.9km 오른쪽 휴게소.
  //      (a) 터널 안 600m: 카드 줄 순서 터널(370m) > 휴게소(1.3km) > 그다음(↗ '230m 좌회전 후', 차에서 1.43km)
  //      (b) 200 → 1,250m 를 10m 씩: 줄 순서가 바뀌는 건 터널을 나올 때 한 번뿐 (오르내림 없음)
  //      (c) 위 안내가 직진이라 터널이 안내 줄에 오르면 그다음 칸은 터널 출구부터: '830m 터널 지나' (차에서 1.2km 라 휴게소 1.3km 보다 위)
  //      (d) 같은 함수: 25m 안으로 비슷하면 자리를 그대로, 넘게 차이 나면 바꾸고, 숨은 칸은 밑으로 (가짜 칸 세 개)
  //      (e) 서랍: 단속(200m)이 하이패스(800m)보다 위, 하이패스가 더 가까우면 하이패스가 위, 다 숨으면 처음(HTML) 순서로
  async function s94() {
    const t = T(), r = {};
    const P = [];
    for (let k = 0; k <= 260; k++) { const p = dest(NAV_ORIGIN, 0, 10 * k); P.push({ lat: round6(p.lat), lng: round6(p.lng) }); }
    const cum = [0];
    for (let i = 1; i < P.length; i++) cum.push(cum[i - 1] + hav(P[i - 1], P[i]));
    const total = cum[cum.length - 1];
    const ms = (m) => r0(m / 20 * 1000);
    const mkR = (straightFirst) => {
      const gl = [
        { i: 180, t: 2, s: "이배재사거리에서 '성남시청' 방면으로 좌회전" },
        { i: 203, t: 14, s: "'시청' 방면으로 1시 방향" },
        { i: 260, t: 88, s: '목적지' },
      ];
      if (straightFirst) gl.unshift({ i: 120, t: 1, s: '직진' });
      let prev = 0;
      const guide = gl.map((g) => { const x = Object.assign({ d: r0(cum[g.i] - prev), ms: ms(cum[g.i] - prev) }, g); prev = cum[g.i]; return x; });
      return { route: { distance: r0(total), duration: ms(total), tollFare: 0, fuelPrice: 160, path: P.map((p) => [p.lng, p.lat]), guide,
        sections: [{ i: 0, n: 261, name: '테스트고속도로', speed: 80, cong: 1 }] },
        P, cum, total, dest: { name: '테스트 목적지', addr: '', lat: P[260].lat, lng: P[260].lng } };
    };
    const north = (m) => dest(NAV_ORIGIN, 0, m);
    const enc = (pts) => {
      const q = pts.map((x) => [Math.round(x.lat * 1e5), Math.round(x.lng * 1e5)]);
      const row = [0, 1, q[0][0], q[0][1]];
      for (let k = 1; k < q.length; k++) row.push(q[k][0] - q[k - 1][0], q[k][1] - q[k - 1][1]);
      return row;
    };
    const cardOrder = () => [...document.getElementById('navPanel').children].filter((e) => !e.hidden && getComputedStyle(e).display !== 'none')
      .map((e) => e.id || e.className.split(' ')[0]).join('>');
    const drawerOrder = (all) => [...document.querySelector('#camDrawer .cd-in').children].filter((e) => all || !e.hidden).map((e) => e.id).join('>');
    const prevT = t.prefs.tunnels, prevR = t.prefs.rest;
    try {
      t.prefs.tunnels = true; t.prefs.rest = true;
      t.setTunnelData({ v: 1, scale: 1e5, names: ['이배재터널'], w: [enc([north(300), north(600), north(970)])] });
      const RS = dest(north(1900), 90, 90);
      t.setRestData({ count: 1, items: [[RS.lat, RS.lng, '테스트휴게소', '', '테스트선']] });
      let R = mkR(false);
      softReset();
      await planAndStart(R);
      const go = (s) => { const a = pointAt(R, s); feed(a.p, 20, a.h); t.renderNav(); };
      for (let s = 100; s <= 600; s += 20) go(s);
      r.a = { order: cardOrder(), main: text('#turnDist') + ' ' + text('#turnText'), tunnel: text('#tunnelDist') + ' ' + text('#tunnelText'),
        rest: text('#restName') + ' ' + text('#restDist'), next: text('#nextDist') + ' ' + text('#nextAfter') };
      t.endNav(); softReset();
      // (b) 줄 순서가 바뀌는 횟수
      await planAndStart(R);
      const seen = [];
      for (let s = 200; s <= 1250; s += 10) { go(s); const o = cardOrder(); if (seen[seen.length - 1] !== o) seen.push(o); }
      r.b = seen;
      t.endNav(); softReset();
      // (c) 위 안내가 직진 → 터널이 안내 줄, 그다음 칸은 터널 출구부터
      R = mkR(true);
      await planAndStart(R);
      for (let s = 100; s <= 600; s += 20) go(s);
      r.c = { order: cardOrder(), main: text('#turnDist') + ' ' + text('#turnText'), next: text('#nextDist') + ' ' + text('#nextAfter') };
      t.endNav(); softReset();
    } finally {
      t.prefs.tunnels = prevT; t.prefs.rest = prevR;
      t.setTunnelData(null);
      await t.loadTunnels();
      try { const j = await (await realFetch(new URL('../data/rest.json', location.href).href, { cache: 'no-store' })).json(); t.setRestData(j); } catch (e) { /* 다음 실행 때 */ }
      softReset();
    }
    // (d) 거리 비슷함·숨김
    {
      const box = document.createElement('div');
      const mk = (id, d) => { const e = document.createElement('div'); e.id = 'x' + id; e._d = d; box.appendChild(e); return e; };
      const A = mk('A', 100), B = mk('B', 300), C = mk('C', 500), G = [[A], [B], [C]];
      const ord = () => [...box.children].map((e) => (e.hidden ? '-' : '') + e.id.slice(1)).join('');
      const step = () => { t.orderByDist(G); return ord(); };
      r.d = [step()];
      C._d = 290; r.d.push(step());          // 10m 차이: 그대로 ABC
      C._d = 260; r.d.push(step());          // 40m 차이: ACB
      B._d = 250; r.d.push(step());          // 10m 차이: 그대로 ACB
      A.hidden = true; r.d.push(step());     // 숨은 칸은 밑으로: CB-A
      A.hidden = false; A._d = 20; r.d.push(step());   // 다시 보이며 가장 가까움: ACB
    }
    // (e) 서랍 칸 (길안내 없이 거리만 넣어서)
    {
      const cam = document.getElementById('camCard'), toll = document.getElementById('tollCard');
      const keep = [cam.hidden, toll.hidden];
      try {
        cam.hidden = false; toll.hidden = false;
        cam._d = 200; toll._d = 800; t.orderAlerts(); r.e1 = drawerOrder();
        cam._d = 900; toll._d = 300; t.orderAlerts(); r.e2 = drawerOrder();
      } finally {
        cam.hidden = keep[0]; toll.hidden = keep[1];
        t.orderAlerts();
        r.e3 = drawerOrder(true);
      }
    }
    const a = r.a || {}, c = r.c || {};
    // v263 (운전자 '3.4km 남았는데 이어서 줄은 필요 없다'): 지금 안내가 1km 넘게 남으면 그다음 칸은 카드 오른쪽 칩 — 1.2km 앞에서는 카드에 없고
    //   1km 안으로 들어오면 카드에 나타난다. 남은 거리 줄(navmeta)은 아래 가운데 띠로 옮겨 카드 줄 순서에 없다
    const ok = a.order === 'navdest>turn>tunnelRow>restCard' && /^1\.2km 이배재사거리에서 좌회전/.test(a.main) &&
      /^3[6-8]0m 이배재터널 출구까지$/.test(a.tunnel) && /^테스트휴게소 1\.[23]km$/.test(a.rest) && a.next === '230m 오른쪽 방향' /* v246: 300m 안에 이어지는 회전은 '이어서' 줄 (동작 이름) */ &&
      r.b.length === 3 && r.b[0] === 'navdest>turn>tunnelRow>restCard' && r.b[1] === 'navdest>turn>tunnelRow>restCard>nextTurn' && r.b[2] === 'navdest>turn>restCard>nextTurn' &&
      c.order === 'navdest>turn>nextTurn>restCard' && /^3[6-8]0m 이배재터널 출구까지$/.test(c.main) && /^8[2-4]0m 터널 지나$/.test(c.next) &&
      r.d.join(',') === 'ABC,ABC,ACB,ACB,CB-A,ACB' &&
      r.e1 === 'camCard>tollCard' && r.e2 === 'tollCard>camCard' && r.e3 === 'laneRow>juncCard>camCard>mySpeed>zoneBadge>secCard>tollCard';
    return { pass: !!ok, detail: JSON.stringify(r) };
  }

  // S85: 하이패스 차로는 지금 가는 방향 것만 (v142, 2026-11-16 20:30 성남TG 남행에서 운전자 '하이패스 없는데 왜 자꾸 하이패스
  //      보여 주는 거야 가는 방향이 있어 확실히 있는 거야?'). 실제 자료(data/hipass.json)로:
  //      (a) 실제 경로 경부 북행 → 판교JC → 수도권제1순환 북행 (아침 09:03 네이버 '1 2 3 – 8 9 – 11 –'): 서울TG 출구, 성남TG 상행
  //      (b) 같은 길을 거꾸로 (저녁 귀갓길: 성남TG 남행 → 판교JC → 경부 남행): 성남TG 하행 1 2 3 – 6 7 – 9 –, 서울TG 입구 1 2 3 4 – 9 –
  //      (c) 순환선 영업소를 접선과 거의 직각(72°)으로 지나면 방향 모름 → 양쪽 공통(성남 1·2·3·9)만. 40°면 상행, 140°면 하행
  //      (d) 같은 이름에 폐쇄식·개방식 영업소가 따로 있는 대동·서영암·가락: 어느 쪽인지 몰라 차로 칸 없음 (카드는 보임)
  async function s85() {
    const t = T(), box = TESLA_ONLY, prev = t.prefs.tesla;
    const set = (on) => { box.checked = on; box.dispatchEvent(new Event('change')); };
    const lanes = () => { const e = document.getElementById('tollLanes'); return visible('#tollLanes') ? e.dataset.hp + '/' + e.dataset.n : ''; };
    const snap = () => ({ card: visible('#tollCard'), lanes: lanes(), strip: [...document.querySelectorAll('#tollLanes .ln')].map((e) => (e.classList.contains('hp') ? e.textContent : '–')).join(' ') });
    const mk = (path, guides, sections) => {
      const P = path.map((x) => ({ lat: x[1], lng: x[0] }));
      const cum = [0];
      for (let i = 1; i < P.length; i++) cum.push(cum[i - 1] + hav(P[i - 1], P[i]));
      const guide = guides.map((x, k) => ({ ...x, d: r0(cum[x.i] - (k ? cum[guides[k - 1].i] : 0)), ms: 60000 }));
      const total = cum[cum.length - 1];
      return { route: { distance: r0(total), duration: r0(total / 20 * 1000), tollFare: 900, fuelPrice: 3000, path, guide, sections }, P, cum, total,
        dest: { name: '방향 시험', addr: '', lat: P[P.length - 1].lat, lng: P[P.length - 1].lng } };
    };
    const driveTo = (R, from, upto) => { for (let m = from; m <= upto; m += 25) { const a = pointAt(R, m); feed(a.p, 25, a.h); t.renderNav(); } };
    const settle = async () => { await new Promise((res) => setTimeout(res, 30)); t.renderNav(); };
    // 순환선 방향 판정에 쓰는 각도 (앱 ringDir 과 같은 셈: 톨게이트 앞뒤 400m 진행 방향 vs 서울에서 본 방향 + 270°)
    const ringDiff = (R, i) => {
      const s0 = R.cum[i];
      let a = i, b = i;
      while (a > 0 && s0 - R.cum[a] < 400) a--;
      while (b < R.P.length - 1 && R.cum[b] - s0 < 400) b++;
      const d = Math.abs(((brg(R.P[a], R.P[b]) - (brg(SEOUL, R.P[i]) + 270)) % 360 + 540) % 360 - 180);
      return Math.round(d);
    };
    const r = {};
    try {
      set(true);
      t.setHipassData(null); await t.loadHipass();
      const fx = await (await realFetch(harnessDir + 'fixtures/route-seoultg-n.json', { cache: 'no-store' })).json();
      const N = fx.path.length;
      const iSeoul = fx.guide.find((g) => /서울톨게이트/.test(g.s)).i, iSeongnam = fx.guide.find((g) => /성남톨게이트/.test(g.s)).i;
      // (a) 북행 (실제 경로 그대로)
      softReset();
      const F = mk(fx.path, fx.guide.map((g) => ({ i: g.i, t: g.t, s: g.s })), fx.sections);
      await planAndStart(F);
      driveTo(F, 25, F.cum[iSeoul] - 600); await settle();
      r.northSeoul = snap();
      driveTo(F, F.cum[iSeoul] - 575, F.cum[iSeongnam] - 600); await settle();
      r.northSeongnam = snap();
      r.northDiff = ringDiff(F, iSeongnam);
      t.endNav();
      // (b) 거꾸로 (남행): 길·안내 번호를 뒤집는다. 회전 안내는 방향이 달라 빼고 톨게이트·목적지만
      softReset();
      const rv = (i) => N - 1 - i;
      const B = mk(fx.path.slice().reverse(),
        [{ i: rv(iSeongnam), t: 121, s: '성남톨게이트 (통행료 500원)' }, { i: rv(iSeoul), t: 121, s: '서울톨게이트' }, { i: N - 1, t: 88, s: '목적지' }],
        [{ i: 0, n: rv(55) + 1, name: '수도권제1순환고속도로', speed: 70, cong: 1 }, { i: rv(55), n: 56, name: '경부고속도로', speed: 70, cong: 1 }]);
      await planAndStart(B);
      driveTo(B, 25, B.cum[rv(iSeongnam)] - 300); await settle();
      r.southSeongnam = snap();
      r.southDiff = ringDiff(B, rv(iSeongnam));
      driveTo(B, B.cum[rv(iSeongnam)] - 275, B.cum[rv(iSeoul)] - 600); await settle();
      r.southSeoul = snap();
      t.endNav();
      // (c) 순환선 영업소(성남)를 접선과 40°·72°·140° 로 지남 (시험 출발점 둘레의 직선 길)
      const tangent = (brg(SEOUL, NAV_ORIGIN) + 270) % 360;
      for (const [k, off] of [['ring40', 40], ['ring72', 72], ['ring140', 140]]) {
        softReset();
        const h = (tangent + off) % 360, raw = [];
        for (let q = 0; q <= 40; q++) raw.push(dest(NAV_ORIGIN, h, 100 * q));
        const R = mk(raw.map((x) => [round6(x.lng), round6(x.lat)]), [{ i: 25, t: 121, s: '성남톨게이트 (통행료 500원)' }, { i: 40, t: 88, s: '목적지' }],
          [{ i: 0, n: 41, name: '수도권제1순환고속도로', speed: 70, cong: 1 }]);
        await planAndStart(R);
        driveTo(R, 25, 2200); await settle();
        r[k] = snap(); r[k].diff = ringDiff(R, 25);
        t.endNav();
      }
      // (d) 같은 이름의 폐쇄식·개방식 영업소
      for (const name of ['대동', '서영암', '가락']) {
        softReset();
        const raw = [];
        for (let q = 0; q <= 40; q++) raw.push(dest(NAV_ORIGIN, 0, 100 * q));
        const R = mk(raw.map((x) => [round6(x.lng), round6(x.lat)]),
          [{ i: 20, t: 66, s: "시험IC에서 '부산' 방면으로 오른쪽 고속도로 진입" }, { i: 25, t: 121, s: name + '톨게이트' }, { i: 40, t: 88, s: '목적지' }],
          [{ i: 0, n: 41, name: '시험고속도로', speed: 70, cong: 1 }]);
        await planAndStart(R);
        driveTo(R, 25, 2200); await settle();
        r[name] = snap();
        t.endNav();
      }
      r.mixedData = ['대동', '서영암', '가락'].every((k) => { const o = t.hipass.o[k]; return o && (o.i || o.x) && (o.u || o.d); });
    } finally {
      t.setHipassData(null);
      await t.loadHipass();
      set(prev);
      softReset();
    }
    const ok = r.northSeoul.lanes === '1,2,3,4,14,15,16/19' && r.northSeongnam.lanes === '1,2,3,8,9,11/13' && r.northSeongnam.strip === '1 2 3 – 8 9 – 11 –' &&
      r.southSeongnam.lanes === '1,2,3,6,7,9/12' && r.southSeongnam.strip === '1 2 3 – 6 7 – 9 –' &&
      r.southSeoul.lanes === '1,2,3,4,9/13' && r.southSeoul.strip === '1 2 3 4 – 9 –' &&
      r.northDiff <= 65 && r.southDiff >= 115 &&
      r.ring40.lanes === '1,2,3,8,9,11/13' && r.ring72.card && r.ring72.lanes === '1,2,3,9/0' && r.ring140.lanes === '1,2,3,6,7,9/12' &&
      r.mixedData && ['대동', '서영암', '가락'].every((k) => r[k].card && r[k].lanes === '');
    return { pass: ok, detail: JSON.stringify(r) + (ok ? ' ✓' : ' ✗') };
  }

  // S84: 하이패스 차로 줄이 카드 밖으로 넘치지 않음 (v142, 2026-11-16 20:30 성남TG 1.6km 앞 남행: 배지 옆 한 줄
  //      '1 2 3 – 6 7 – 9'에서 9가 반쯤 잘리고 뒤 '–'는 안 보임. 운전자 '이게 많으면 그냥 가운데 밑에다가 보여줘 … 꼭 숫자를').
  //      804×638 테슬라 서랍에서 칸 4·9(성남 하행 실제 줄)·12(서서울 출구 실제 줄)·14·16개를, 톨게이트가 다음 안내일 때(배지 옆)와
  //      그다음 안내일 때(따로 한 줄) 모두: 모든 칸이 카드 안, 숫자가 칸 안에 다 보임(글자 12px 이상), 칸 수 그대로.
  //      칸이 적으면(4) 배지 옆 한 줄, 많으면 배지가 가운데 위 + 그 아래 줄에 칸을 가운데로 (넘치면 줄을 바꿔 가운데)
  async function s84() {
    // 칸 자리를 재는 시험이라 화면 크기가 있어야 한다 (창을 숨기면 페이지가 0×0 이라 카드 폭이 24px 로 나온다)
    if (innerWidth < 600 || innerHeight < 400) return { status: 'SKIP', detail: 'page is ' + innerWidth + '×' + innerHeight + ' (hidden pane): lane cell layout cannot be measured; run S84 again with the pane visible at 804×638' };
    const t = T(), box = TESLA_ONLY, prev = t.prefs.tesla;
    const set = (on) => { box.checked = on; box.dispatchEvent(new Event('change')); };
    const mkRoute = (guides) => {
      const raw = [];
      for (let k = 0; k <= 40; k++) raw.push(dest(NAV_ORIGIN, 0, 100 * k));
      const path = raw.map((p) => [round6(p.lng), round6(p.lat)]);
      const P = path.map((x) => ({ lat: x[1], lng: x[0] }));
      const cum = [0];
      for (let i = 1; i < P.length; i++) cum.push(cum[i - 1] + hav(P[i - 1], P[i]));
      const total = cum[cum.length - 1];
      const guide = guides.map((x, k) => ({ ...x, d: r0(cum[x.i] - (k ? cum[guides[k - 1].i] : 0)), ms: 20000 }));
      return {
        route: { distance: r0(total), duration: r0(total / 25 * 1000), tollFare: 500, fuelPrice: 300, path, guide,
          sections: [{ i: 0, n: 41, name: '테스트로', speed: 60, cong: 1 }] },
        P, cum, total, dest: { name: '하이패스 칸 시험', addr: '', lat: P[40].lat, lng: P[40].lng },
      };
    };
    const enter = { i: 20, t: 66, s: "시험IC에서 '서울' 방면으로 오른쪽 고속도로 진입" };
    const end = { i: 40, t: 88, s: '목적지' };
    const toll = (name) => ({ i: 25, t: 121, s: name + '톨게이트 (통행료 500원)' });
    const codes = {
      칸4: 'HHTxH',                                  // 1 2 – 5
      칸9: 'MMMxTHHThttb',                           // 성남 하행 실제 줄: 1 2 3 – 6 7 – 9 –
      칸12: 'xMMMMxxPPxHHHxPTBxx',                   // 서서울 출구 실제 줄: – 2 3 4 5 – 11 12 13 – 17 –
      칸14: 'HHHHxHxHxHxHHH',                        // 1 2 3 4 – 6 – 8 – 10 – 12 13 14
      칸16: 'xxxHHxHxHHxHxHHxHH',                    // – 4 5 – 7 – 9 10 – 12 – 14 15 – 17 18
    };
    const data = { v: 2, date: '2026-06-30', o: {} };
    for (const [k, c] of Object.entries(codes)) data.o['시험' + k] = { i: c, x: c };
    // 방향을 몰라 양쪽 공통 번호만 보일 때 (실제 자료에서 가장 많은 시흥·김포 6개): 번호 칸도 넘치지 않게
    data.o.시험번호6 = { t: 1, u: 'HHHHHHT', d: 'HHHHHHP' };
    // ?hold=칸9옆 : 그 상태에서 6초 멈춤 (눈으로 확인·사진용)
    const hold = new URLSearchParams(location.search).get('hold');
    const meas = () => {
      const card = document.getElementById('tollCard'), lanes = document.getElementById('tollLanes'), badge = card.querySelector('.toll-badge');
      if (!visible('#tollCard') || !visible('#tollLanes')) return { shown: false };
      const c = card.getBoundingClientRect(), b = badge.getBoundingClientRect(), cs = getComputedStyle(card);
      const inL = c.left + parseFloat(cs.paddingLeft), inR = c.right - parseFloat(cs.paddingRight);
      const cells = [...lanes.querySelectorAll('.ln')];
      const R = cells.map((e) => e.getBoundingClientRect());
      const out = R.filter((q) => q.left < c.left - 0.5 || q.right > c.right + 0.5 || q.left < 0 || q.right > window.innerWidth).length;
      const cut = cells.filter((e) => e.scrollWidth > e.clientWidth + 0.5 || e.scrollHeight > e.clientHeight + 0.5).length;
      const font = Math.min(...cells.map((e) => parseFloat(getComputedStyle(e).fontSize)));
      const minW = Math.min(...R.map((q) => q.width));
      const rows = [...new Set(R.map((q) => Math.round(q.top)))];
      const below = R.every((q) => q.top >= b.bottom - 0.5);
      const beside = R.every((q) => q.top < b.bottom && q.bottom > b.top && q.left >= b.right);
      // 가운데: 줄마다 왼쪽 여백 ≈ 오른쪽 여백, 배지도 가운데
      const off = rows.map((y) => { const rr = R.filter((q) => Math.round(q.top) === y);
        return Math.abs((Math.min(...rr.map((q) => q.left)) - inL) - (inR - Math.max(...rr.map((q) => q.right)))); });
      return { shown: true, n: cells.length, out, cut, font, minW: Math.round(minW * 10) / 10, rows: rows.length, below, beside,
        centred: Math.max(...off) <= 3, badgeMid: Math.abs((b.left + b.right) / 2 - (inL + inR) / 2) <= 3,
        text: cells.map((e) => (e.classList.contains('hp') ? e.textContent : '–')).join(' '), cardW: Math.round(c.width), cardH: Math.round(c.height) };
    };
    const drive = async (R, upto) => {
      await planAndStart(R);
      for (let s = 25; s <= upto; s += 25) { const a = pointAt(R, s); feed(a.p, 25, 0); t.renderNav(); }
      await new Promise((res) => setTimeout(res, 40)); t.renderNav();
      return meas();
    };
    const r = {};
    try {
      set(true);
      t.setHipassData(data);
      for (const k of [...Object.keys(codes), '번호6']) {
        softReset();
        r[k + '옆'] = await drive(mkRoute([toll('시험' + k), end]), 2200);           // 톨게이트가 다음 안내 (배지 옆 자리)
        if (hold === k + '옆') await new Promise((res) => setTimeout(res, 6000));
        t.endNav(); softReset();
        r[k + '줄'] = await drive(mkRoute([enter, toll('시험' + k), end]), 1700);    // 그다음 안내 (따로 한 줄)
        if (hold === k + '줄') await new Promise((res) => setTimeout(res, 6000));
        t.endNav();
      }
    } finally {
      t.setHipassData(null);
      await t.loadHipass();
      set(prev);
      softReset();
    }
    const want = { 칸4: 4, 칸9: 9, 칸12: 12, 칸14: 14, 칸16: 16, 번호6: 6 };
    const okAll = Object.keys(want).every((k) => ['옆', '줄'].every((w) => { const m = r[k + w];
      return m.shown && m.n === want[k] && m.out === 0 && m.cut === 0 && m.font >= 12 && m.minW >= 18; }));
    const ok = okAll && r.칸4옆.beside && r.칸4옆.rows === 1 &&
      r.칸9옆.text === '1 2 3 – 6 7 – 9 –' &&
      ['칸9옆', '칸12옆', '칸14옆', '칸16옆'].every((k) => r[k].below && r[k].badgeMid && r[k].centred) &&
      ['칸12줄', '칸14줄', '칸16줄'].every((k) => r[k].centred) && r.번호6옆.text === '1 2 3 4 5 6';
    return { pass: ok, detail: JSON.stringify(r) + (ok ? ' ✓' : ' ✗') };
  }

  // S82: 버스전용차로 칸 + 지도 위 차로 말풍선 (v139, 2026-11-16 사용자가 네이버 길안내 화면을 보고 '우리도 이런거 있음 좋겠다').
  //      시험 경로(북쪽 600m → 우회전)의 우회전 진입부(회전 지점 40m 앞)와 450m 직진 교차로에
  //      (a) 우회전 'L|S|SR|SB'(4차로 버스전용): 3차로만 파랑, 4차로는 회색 버스 그림(화살표 없음)
  //      (b) 직진 교차로 'S|S|SB': 다 직진이어도 버스 칸이 있으니 보이고 1·2차로만 파랑
  //      (c) 우회전이 버스전용차로에만 'S|S|SRB': 그 차로를 파랗게 + 구석 작은 버스
  //      (d) 지도 말풍선: 1km 안에서 회전 진입부 정지선에(꼬리 끝 = 정지선), 칸 수 = 차로 수, 갈 차로 파랑, 우회전이면 정지선 왼쪽(.tip-l),
  //          좌회전이면 오른쪽, 회전을 지나면·설정을 끄면·안내를 끝내면 없어짐  (e) 자료가 없는 회전은 말풍선 없음
  async function s82() {
    const t = T(), R = buildNavRoute();
    // 새로 연 페이지에서 첫 시험으로 돌면 지도가 아직 없을 수 있다 (창을 숨긴 0×0 페이지에서 말풍선이 하나도 안 생겼다): 지도부터 기다린다
    await waitFor(() => t.getMap(), 5000);
    R.route = JSON.parse(JSON.stringify(R.route));
    R.route.guide = R.route.guide.filter((g) => g.t !== 1);   // 다음 안내가 바로 우회전(600m)
    const north = (m) => dest(NAV_ORIGIN, 0, m), turn = R.P[5], stop = dest(turn, 180, 40);
    const data = (list) => {
      const pats = [], d = [];
      let pa = 0, pb = 0;
      list.forEach(([q, h, pat]) => {
        if (pats.indexOf(pat) < 0) pats.push(pat);
        const a = Math.round(q.lat * 1e5), b = Math.round(q.lng * 1e5);
        d.push(a - pa, b - pb, h, pats.indexOf(pat)); pa = a; pb = b;
      });
      t.setLaneData({ v: 1, scale: 1e5, date: '2025-09', areas: ['시험'], count: list.length, pats, d });
    };
    const el = () => document.getElementById('laneRow');
    const row = () => ({ shown: visible('#laneRow'), lanes: el().dataset.lanes || '', go: el().dataset.go || '', bus: el().dataset.bus || '',
      busTiles: document.querySelectorAll('#laneRow .lg.bus').length, busIcons: document.querySelectorAll('#laneRow .lg.bus:not(.go) .pt.bus').length,
      busArrows: document.querySelectorAll('#laneRow .lg.bus:not(.go) .pt:not(.bus)').length, busBlue: document.querySelectorAll('#laneRow .lg.bus:not(.go) .pt.on').length,
      goBus: document.querySelectorAll('#laneRow .lg.go.bus .lbus').length, move: el().dataset.move || '' });
    const tip = () => {
      const m = t.getMap(), box = document.querySelector('#map .lanetip');
      if (!box) return { shown: false, obj: !!(m && m._tip) };
      const b = box.getBoundingClientRect(), cp = t.canvasPoint ? null : null;
      return { shown: visible('#map .lanetip'), obj: !!(m && m._tip), cells: box.querySelectorAll('.tl').length, go: box.querySelectorAll('.tl.go').length,
        goIdx: Array.from(box.querySelectorAll('.tl')).map((c, i) => (c.classList.contains('go') ? i + 1 : 0)).filter(Boolean).join(','),
        bus: box.querySelectorAll('.tl.bus:not(.go) .pt.bus').length, left: box.classList.contains('tip-l'),
        blue: (() => { const g = box.querySelector('.tl.go .pt.on'), o = box.querySelector('.tl:not(.go) .pt');
          return g && o ? getComputedStyle(g).color !== getComputedStyle(o).color : null; })(),
        w: Math.round(b.width), h: Math.round(b.height), cp };
    };
    const go = (Rx, m) => { const a = pointAt(Rx, m); feed(a.p, 15, a.h); };
    const prevPref = t.prefs.lanes;
    const r = {};
    try {
      // (a) 우회전 + 4차로 버스전용, (b) 450m 직진 교차로 'S|S|SB'
      data([[stop, 0, 'L|S|SR|SB'], [dest(north(450), 90, 6), 0, 'S|S|SB']]);
      softReset();
      await planAndStart(R);
      go(R, 15); go(R, 60);
      r.tipFar = tip();                                // 우회전까지 540m: 말풍선은 1km 안이라 보임
      for (let m = 110; m <= 200; m += 15) go(R, m);
      r.straight = row();                              // 직진 교차로 250m 앞
      for (let m = 230; m <= 470; m += 20) go(R, m);
      r.right = row();                                 // 직진 교차로 지나 우회전 130m 앞
      r.tipNear = tip();
      t.prefs.lanes = false; go(R, 480);
      r.tipOff = tip();
      t.prefs.lanes = true; go(R, 490);
      r.tipOn = tip();
      for (let m = 510; m <= 700; m += 25) go(R, m);
      r.tipAfter = tip();                              // 우회전 지나 다음 안내 = 목적지
      t.endNav();
      r.tipEnded = tip();
      // (c) 우회전이 버스전용차로에만
      data([[stop, 0, 'S|S|SRB']]);
      softReset();
      await planAndStart(R);
      for (let m = 15; m <= 470; m += 25) go(R, m);
      r.busOnly = row();
      r.tipBusOnly = tip();
      t.endNav();
      // 같은 곳이 좌회전 안내면 말풍선은 정지선 오른쪽
      data([[stop, 0, 'LU|L|S|SB']]);
      const RL = JSON.parse(JSON.stringify(R));
      RL.route.guide[0].t = 2; RL.route.guide[0].s = "'시험로' 방면으로 좌회전";
      softReset();
      await planAndStart(RL);
      for (let m = 15; m <= 470; m += 25) go(RL, m);
      r.leftTip = tip();
      r.left = row();
      t.endNav();
      // (e) 자료 밖 회전
      data([[dest(turn, 0, 3000), 0, 'L|S|R']]);
      softReset();
      await planAndStart(R);
      for (let m = 15; m <= 470; m += 25) go(R, m);
      r.tipNone = tip();
      t.endNav();
    } finally {
      t.prefs.lanes = prevPref;
      t.setLaneData(null);
      await t.loadLanes();
      softReset();
    }
    r.realBus = (t.lanesData.pats || []).filter((p) => p.join('|').indexOf('B') >= 0).length;
    const ok = r.tipFar.shown && r.tipFar.cells === 4 &&
      r.straight.shown && r.straight.move === 'S' && r.straight.go === '1,2' && r.straight.bus === '3' && r.straight.busIcons === 1 && r.straight.busArrows === 0 &&
      r.right.shown && r.right.go === '3' && r.right.bus === '4' && r.right.busIcons === 1 && r.right.busArrows === 0 && r.right.busBlue === 0 &&
      r.tipNear.shown && r.tipNear.cells === 4 && r.tipNear.goIdx === '3' && r.tipNear.bus === 1 && r.tipNear.left === true && r.tipNear.blue === true &&
      r.tipNear.w === 4 * 30 + 3 * 3 && r.tipNear.h === 30 &&   /* v248: 차로마다 따로 30×30 칸 (네이버처럼) */
      !r.tipOff.shown && !r.tipOff.obj && r.tipOn.shown && !r.tipAfter.shown && !r.tipEnded.shown && !r.tipEnded.obj &&
      r.busOnly.shown && r.busOnly.go === '3' && r.busOnly.goBus === 1 && r.tipBusOnly.shown && r.tipBusOnly.goIdx === '3' &&
      r.leftTip.shown && r.leftTip.left === false && r.leftTip.goIdx === '1,2' && r.left.go === '1,2' && r.left.bus === '4' &&
      !r.tipNone.shown && !r.tipNone.obj &&
      r.realBus > 10;
    return { pass: ok, detail: JSON.stringify(r) + (ok ? ' ✓' : ' ✗') };
  }

  // S77: 직진 차로 안내 (2026-11-16 요청 '직진 차로도 안내'). 시험 경로(북쪽 600m → 우회전)에 진입부를 넣어
  //      (a) 450m 의 북쪽 방향 직진 교차로 'L|S|S|R'(1차로 좌회전 전용·4차로 우회전 전용): 300m 밖이면 안 보이고, 300m 안이면
  //          2·3차로 파랑(직진 가지), 1·4차로 회색, 칸 오른쪽에 남은 거리 — 우회전 500m 안이어도 더 가까운 직진 교차로가 먼저
  //      (b) 그 교차로를 지나면 우회전 진입부(40m 앞 'LU|L|S|SR')의 4차로  (c) 반대 방향(남쪽)·옆길(30m 옆) 진입부는 무시
  //      (d) 경로에 회전 안내 없이 '직진' 안내만 있어도 그 너머 직진 교차로를 보여 줌  (e) 설정을 끄면 숨김
  //      (f) 7·10차로도 서랍 안에 모든 차로가 한 줄(정사각형 칸, '⋯' 없음), 좌·우회전 화살표는 칸 가운데 (2026-11-16 요청)
  //      (g) 고속·도시고속도로 진입~출구 안내 사이의 진입부(고가 아래·옆 일반도로)는 직진 차로로 찾지 않음 (v131)
  async function s77() {
    const t = T(), R = buildNavRoute();   // 240m '직진' 안내는 그대로 둔다 (d)
    const north = (m) => dest(NAV_ORIGIN, 0, m), turn = R.P[5];
    const aps = [
      [dest(north(450), 90, 6), 0, 'L|S|S|R'],
      [dest(north(350), 270, 6), 180, 'R|S|L'],
      [dest(north(300), 90, 30), 0, 'L|S'],
      [dest(turn, 180, 40), 0, 'LU|L|S|SR'],
    ];
    const pats = [], d = [];
    let pa = 0, pb = 0;
    aps.forEach(([p, h, pat]) => {
      if (pats.indexOf(pat) < 0) pats.push(pat);
      const a = Math.round(p.lat * 1e5), b = Math.round(p.lng * 1e5);
      d.push(a - pa, b - pb, h, pats.indexOf(pat)); pa = a; pb = b;
    });
    const el = () => document.getElementById('laneRow');
    const row = () => ({ shown: visible('#laneRow'), lanes: el().dataset.lanes || '', go: el().dataset.go || '', move: el().dataset.move || '',
      dist: (el().querySelector('.ld') || {}).textContent || '', onParts: document.querySelectorAll('#laneRow .lg.go .pt.on').length,
      onOutside: document.querySelectorAll('#laneRow .lg:not(.go) .pt.on').length, tiles: document.querySelectorAll('#laneRow .lg').length,
      inDrawer: !!el().closest('#camDrawer.open') });
    const go = (m) => { const a = pointAt(R, m); feed(a.p, 15, a.h); };
    const prevPref = t.prefs.lanes;
    const r = {};
    try {
      t.setLaneData({ v: 1, scale: 1e5, date: '2025-09', areas: ['시험'], count: aps.length, pats, d });
      softReset();
      await planAndStart(R);
      go(15); go(60); go(90);
      r.far = row();                                   // 직진 교차로 360m · 우회전 510m: 안 보임
      for (let m = 110; m <= 200; m += 15) go(m);
      r.straight = row();                              // 직진 교차로 250m: 2·3차로
      r.list = (t.nav.laneStraight || []).map((x) => x.lanes.join('|') + '@' + Math.round(x.at)).join(',');
      t.prefs.lanes = false; go(215);
      r.off = row();
      t.prefs.lanes = true;
      for (let m = 230; m <= 470; m += 20) go(m);
      r.turn = row();                                  // 직진 교차로를 지나 우회전 130m: 우회전 진입부 4차로
      t.endNav();
      r.ended = row();
      // (f) 7·10차로 진입부도 서랍 안에 '⋯' 없이 모든 차로가 한 줄로, 칸은 정사각형이고 서랍 밖으로 안 나간다 (2026-11-16 사용자:
      //     아래 가운데 띠는 '운전자를 가리는 느낌', '⋯으로 맞추는 건 안 돼', '많아 봐야 10차선'). 좌·우회전 화살표는 칸 가운데
      const many = async (pat) => {
        const wp = dest(turn, 180, 40);
        t.setLaneData({ v: 1, scale: 1e5, date: '2025-09', areas: ['시험'], count: 1, pats: [pat], d: [Math.round(wp.lat * 1e5), Math.round(wp.lng * 1e5), 0, 0] });
        softReset();
        await planAndStart(R);
        for (let m = 15; m <= 470; m += 25) go(m);
        const box = document.getElementById('laneRow'), cd = document.querySelector('#camDrawer .cd-in').getBoundingClientRect();
        const tiles = Array.from(box.querySelectorAll('.lg')).map((x) => x.getBoundingClientRect());
        // 화살표 모양(가지·촉) 전체의 가운데가 칸 가운데에 오는지 (첫 칸 좌회전, 끝 칸 우회전)
        const centred = [0, tiles.length - 1].every((k) => {
          const tile = box.querySelectorAll('.lg')[k], gb = tile.querySelector('svg > g').getBoundingClientRect(), tb = tiles[k];
          return Math.abs((gb.left + gb.right) / 2 - (tb.left + tb.right) / 2) <= 2.5;
        });
        const res = { shown: visible('#laneRow'), tiles: tiles.length, gaps: box.querySelectorAll('.lgap').length, go: box.dataset.go,
          oneLine: tiles.every((b) => Math.abs(b.top - tiles[0].top) < 1), square: tiles.every((b) => Math.abs(b.width - b.height) < 1.5),
          inside: tiles[0].left >= cd.left - 1 && tiles[tiles.length - 1].right <= cd.right + 1, w: Math.round(tiles[0].width), centred,
          wideGone: !document.getElementById('laneWide') };
        t.endNav();
        return res;
      };
      r.seven = await many('L|L|S|S|S|S|R');
      r.ten = await many('L|L|S|S|S|S|S|S|S|R');
      // (g) 도시고속도로 진입(120m)~출구(480m) 사이의 450m 직진 교차로는 고가 아래·옆 일반도로 것이라 찾지 않는다 (v131: 서울 전체 자료)
      t.setLaneData({ v: 1, scale: 1e5, date: '2025-09', areas: ['시험'], count: aps.length, pats, d });
      const H = JSON.parse(JSON.stringify(R)), g0 = R.route.guide;
      H.route.guide = [{ i: 1, t: 52, s: '도시고속도로 진입', d: r0(R.cum[1]), ms: 10000 }, g0[0],
        { i: 4, t: 53, s: '도시고속도로 출구', d: r0(R.cum[4] - R.cum[2]), ms: 20000 }, g0[1], g0[2]];
      softReset();
      await planAndStart(H);
      go(15); go(60);
      r.fast = { computed: Array.isArray(t.nav.laneStraight), list: (t.nav.laneStraight || []).map((x) => x.lanes.join('|') + '@' + Math.round(x.at)).join(',') };
      t.endNav();
    } finally {
      t.prefs.lanes = prevPref;
      t.setLaneData(null);
      await t.loadLanes();
      softReset();
    }
    const ok = !r.far.shown &&
      r.straight.shown && r.straight.lanes === 'L|S|S|R' && r.straight.go === '2,3' && r.straight.move === 'S' && r.straight.dist === '250m' &&
      r.straight.onParts === 4 && r.straight.onOutside === 0 && r.straight.tiles === 4 && r.straight.inDrawer &&
      /^L\|S\|S\|R@(449|450|451)$/.test(r.list) && !r.off.shown &&
      r.turn.shown && r.turn.lanes === 'LU|L|S|SR' && r.turn.go === '4' && r.turn.move === 'R' && r.turn.dist === '' &&
      !r.ended.shown &&
      [r.seven, r.ten].every((x) => x.shown && x.gaps === 0 && x.oneLine && x.square && x.inside && x.centred && x.wideGone) &&
      r.seven.tiles === 7 && r.seven.go === '7' && r.ten.tiles === 10 && r.ten.go === '10' && r.ten.w >= 20 &&
      r.fast.computed && r.fast.list === '';
    return { pass: ok, detail: JSON.stringify(r) + (ok ? ' ✓' : ' ✗') };
  }

  // ---------------------------------------------------------------- runner
  async function runOne(id) {
    const sc = SCENARIOS.find((s) => s.id === id || s.name === id);
    if (!sc) throw new Error('unknown scenario ' + id);
    showRunning(sc.name);
    const t0 = performance.now();
    let res;
    try {
      await resetApp();
      res = await sc.fn();
    } catch (e) {
      res = { pass: false, detail: 'exception: ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : String(e)) };
    }
    const status = res.status || (res.pass ? 'PASS' : 'FAIL');
    addResult(sc.name, status, (res.detail || '') + ' [' + r0(performance.now() - t0) + ' ms]');
    return RESULTS.find((r) => r.name === sc.name);
  }
  function summarize(extra) {
    const c = { PASS: 0, FAIL: 0, SKIP: 0 };
    RESULTS.forEach((r) => { c[r.status] = (c[r.status] || 0) + 1; });
    setSummary(c.PASS + ' pass · ' + c.FAIL + ' fail · ' + c.SKIP + ' skip' + (extra ? ' · ' + extra : ''));
  }

  async function main() {
    const tStart = performance.now();
    makePanel();
    prepStorage();
    stubGeolocation();
    installFetchStub();
    try {
      setSummary('loading index.html…');
      const scripts = await injectApp();
      setSummary('loading app.js…');
      for (const s of scripts) await addScript(s);
      setSummary('waiting for __tnc + cameras…');
      const ok = await waitFor(() => window.__tnc && window.__tnc.cams && window.__tnc.cams.loaded, BOOT_TIMEOUT_MS, 50);
      if (!ok) {
        const why = !window.__tnc ? 'window.__tnc never appeared (app.js error or no ?debug)' : '__tnc.cams.loaded stayed false';
        addResult('boot', 'FAIL', why + '. toast="' + text('#toast') + '" errors=' + JSON.stringify(pageErrors.slice(0, 5)));
      } else {
        const t = T();
        addInfo('booted in ' + r0(performance.now() - tStart) + ' ms · cameras ' + t.cams.rows.length + ' (' + t.cams.date + ')' +
          ' · __tnc keys: ' + Object.keys(t).join(','));
        const only = (new URLSearchParams(location.search).get('only') || '').split(',').filter(Boolean);   // ?only=S74,S72
        for (const sc of SCENARIOS) {
          if (only.length && !only.includes(sc.id)) continue;
          await runOne(sc.id);
          summarize('running');
          await sleep(0);
        }
        try { await resetApp(); } catch (e) { /* ignore */ }
        const byEp = {};
        stub.calls.forEach((c) => { byEp[c.path] = (byEp[c.path] || 0) + 1; });
        addInfo('stub calls: ' + JSON.stringify(byEp) + ' · map source: "' + text('#source') + '"' +
          (pageErrors.length ? ' · page errors: ' + JSON.stringify(pageErrors.slice(0, 5)) : ''));
      }
    } catch (e) {
      addResult('boot', 'FAIL', 'exception: ' + (e && e.message ? e.message : String(e)));
    } finally {
      restoreStorage();
      summarize('done in ' + (r0(performance.now() - tStart) / 1000).toFixed(1) + ' s');
      window.__testsDone = true;
    }
  }

  window.__harness = { stub, run: runOne, reset: resetApp, feed, scenarios: () => SCENARIOS.map((s) => s.id), geo: { hav, brg, dest } };
  main();
})();
