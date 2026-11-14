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
  const ENDPOINTS = ['/route', '/geocode', '/search', '/reverse', '/health', '/log', '/config'];
  const BOOT_TIMEOUT_MS = 20000;
  const LS_KEYS = ['tnc.voice', 'tnc.beep', 'tnc.key', 'tnc.recent', 'tnc.cams'];

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
  const CAM_SCHOOL = { lat: 34.96209, lng: 127.26828, limit: 30 };
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
      feed(dest(C, 180, 700 - s), 10, 0);
      const tg = t.camState.target;
      if (tg && sameCam(tg.c, C)) {
        label = text('#camType'); at = r0(tg.d);
        // 도로 주의 표지 모양 타일: 삼각 표지 + 빨간 띠의 남은 거리 + '어린이보호' + 제한속도
        const el = document.querySelector('#camCard .zone-tile');
        tile = {
          shown: hasCls('#camCard', 'zonecam') && !!el && el.getClientRects().length > 0,
          sign: !!document.querySelector('#ztSign svg'), label: text('#ztLabel'), limit: text('#ztLimit'), dist: text('#ztDist'),
        };
      }
    }
    const tileOk = !!tile && tile.shown && tile.sign && tile.label === '어린이보호' && tile.limit === '30' && /m$/.test(tile.dist);
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
      const okSign = visible('#limitSign') && text('#limitVal') === String(L);
      const okSpeed = hasCls('#speed', 'over');
      if (!okTarget || !okSign || !okSpeed) {
        if (bad.length < 4) bad.push(r0(d) + 'm:' + (!okTarget ? ' no-target' : '') + (!okSign ? ' sign(' + (visible('#limitSign') ? text('#limitVal') : 'hidden') + ')' : '') + (!okSpeed ? ' speed-not-over' : ''));
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
        (bad.length ? '; problems: ' + bad.join('; ') : '; #limitSign=' + L + ', #speed.over, #camCard.over all held'),
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
    const firstRight = log.find((e) => e.txt === RIGHT_TURN);
    const rightPhase = log.filter((e) => e.txt === RIGHT_TURN);
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
    const startOk = !!rq && !!offFix && rq.start === offFix.lng.toFixed(6) + ',' + offFix.lat.toFixed(6);
    return {
      pass: before === 1 && !!got && startOk && t.nav.active,
      detail: '/route calls: ' + before + ' before going off-route, ' + calls.length + ' after' +
        (firedAfter ? ' (reroute fired on off-route fix #' + firedAfter + ', seen after ' + waited + ' ms)' : ' (no reroute)') +
        (rq ? '; reroute start=' + rq.start + (startOk ? ' (= off-route fix)' : ' (MISMATCH)') : '') +
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
    const seen = new Set(), merged = [];
    search.concat(geo).forEach((it) => {
      const k = it.name + '|' + it.lat.toFixed(4) + ',' + it.lng.toFixed(4);
      if (!seen.has(k)) { seen.add(k); merged.push(it); }
    });
    const expected = merged.sort((a, b) => hav(SEOUL, a) - hav(SEOUL, b)).map((it) => it.name);
    const sq = stub.since(c0, '/search'), gq = stub.since(c0, '/geocode');
    const callsOk = sq.length === 1 && gq.length === 1 && sq[0].query.query === '테스트' &&
      gq[0].query.near === SEOUL.lng.toFixed(6) + ',' + SEOUL.lat.toFixed(6);
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
        seen.after.push({ past, ok: !!mine && visible('#camCard') && text('#camDist') === '0m' && !/후면|단속 지점|\+/.test(text('#camType') + text('#camDist')) });
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
  async function s13() {
    const t = T(), prev = t.prefs.signalCams;
    const drive = (C, from) => {
      softReset();
      let hit = null;
      for (let s = 0; s <= from - 100; s += 14) {
        feed(dest(C, from === 700 ? 180 : 200, from - s), 14, from === 700 ? 0 : 20);
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
    const okLimit = !!withLimit && withLimit.sign === '50' && withLimit.type === '신호·과속 단속' && withLimit.sig;
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
  function buildRouteBeside(C, east, name) {
    const raw = [];
    const o = dest(dest(C, 180, 1000), 90, east);
    for (let k = 0; k <= 16; k++) raw.push(dest(o, 0, 100 * k));
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
    const noNav = (east) => {
      softReset();
      let hit = null;
      for (let s = 0; s <= 1150; s += 20) {
        feed(dest(dest(C_A(), 180, 1150 - s), 90, east), 20, 0);
        const tg = t.camState.target;
        if (tg && sameCam(tg.c, CAM_ISO_A) && hit === null) hit = r0(tg.d);
      }
      return hit;
    };
    const parallelHit = noNav(45);   // 45m 옆 나란한 도로
    const oppHit = noNav(14);        // 왼쪽 14m = 반대편 차로
    const mineHit = noNav(-6);       // 오른쪽 6m = 내 차로 길가
    // (b) 길안내 중: 위례성로 카메라(CAM_ISO_B, 한 방향)를 경로 오른쪽(east<0)·왼쪽(east>0)에 두고 확인
    const cases = [
      { east: -12, name: '위례성로', want: true },
      { east: -12, name: '다른대로', want: false },
      { east: -25, name: '위례성로', want: true },
      { east: -40, name: '위례성로', want: false },
      { east: 12, name: '위례성로', want: false },   // 왼쪽 12m: 반대편 차로
      { east: 5, name: '위례성로', want: true },     // 왼쪽 5m: 중앙선 근처, 거르지 않는다
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
      const reps = t.alertLog.slice(from).filter((e) => /과속 반복/.test(e.text)).length;
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
    const t = T(), box = document.getElementById('optTesla'), prev = t.prefs.tesla;
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
      set(false); await new Promise((r) => setTimeout(r, 60));
      off = snap();
    } finally {
      set(prev);
    }
    // 속도는 차 화면에 나오므로 테슬라 모드에서는 숨김. 단, 화면이 넓으면(1000px 이상: 브라우저를 크게 펼쳐 차 속도계가 가려짐) 왼쪽에 보인다
    const wantSpeed = innerWidth >= 1000;
    const okOn = on.pos === 'absolute' && on.mapW >= on.appW - 2 && on.speedShown === wantSpeed && /월 \d+일/.test(on.date) && on.clockShown;
    const okOff = off.pos !== 'absolute' && off.mapW < off.appW - 100 && off.speedShown && !off.date;
    return {
      pass: okOn && okOff,
      detail: 'on: map ' + on.mapW + '/' + on.appW + ' px, cluster ' + on.pos + ', speed ' + (on.speedShown ? 'shown' : 'hidden') + ' (want ' + (wantSpeed ? 'shown, wide' : 'hidden') + '), date "' + on.date + '"' + (okOn ? '✓' : '✗') +
        '; off: map ' + off.mapW + '/' + off.appW + ' px, speed ' + (off.speedShown ? 'shown' : 'HIDDEN') + (okOff ? '✓' : '✗'),
    };
  }
  const C_A = () => CAM_ISO_A;

  // S33: 주차 중 자동 새 버전 — 2분 넘게 서 있고 2분 넘게 안 만졌고 길안내·검색·설정 화면이 없을 때만 확인, 10분에 한 번
  async function s33() {
    const t = T(), u = t.upd, saved = { movedAt: u.movedAt, touchAt: u.touchAt, idleAt: u.idleAt };
    const r = {};
    try {
      const T0 = 10 * 3600e3;
      u.idleAt = 0; u.touchAt = 0;
      t.state.speedKmh = 40; r.moving = t.idleUpdate(T0, true);
      t.state.speedKmh = 0; r.justStopped = t.idleUpdate(T0 + 60000, true);
      u.touchAt = T0 + 100000; r.touched = t.idleUpdate(T0 + 130000, true);
      u.touchAt = 0;
      document.getElementById('searchSheet').hidden = false; r.screen = t.idleUpdate(T0 + 130000, true);
      document.getElementById('searchSheet').hidden = true;
      t.nav.preview = true; r.nav = t.idleUpdate(T0 + 130000, true); t.nav.preview = false;
      r.check = t.idleUpdate(T0 + 130000, true);
      r.again = t.idleUpdate(T0 + 190000, true);
      r.later = t.idleUpdate(T0 + 130000 + 10 * 60000 + 1, true);
    } finally {
      Object.assign(u, saved);
      document.getElementById('searchSheet').hidden = true;
      t.nav.preview = false;
    }
    // 새 버전으로 옮겨 갈 때는 주소에 ?v=새 버전 (저장된 예전 index.html 을 쓰지 않게). 다른 값(debug)과 #은 그대로
    r.url1 = t.updateUrl('2026.11.14-99', { pathname: '/tesla-naver-cluster/', search: '', hash: '' });
    r.url2 = t.updateUrl('2026.11.14-99', { pathname: '/tesla-naver-cluster/', search: '?debug&v=2026.11.14-38', hash: '#x' });
    const want = { moving: 'moving', justStopped: 'just-stopped', touched: 'touched', screen: 'screen-open', nav: 'nav', check: 'check', again: 'waiting', later: 'check',
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
    const ok = r.driving === true && r.after1s === true && r.after4s === false && r.creep === false && r.movingAgain === true && r.offStopped === true;
    return { pass: ok, detail: 'drive view while driving ' + r.driving + ', stopped 1 s ' + r.after1s + ', stopped 4 s ' + r.after4s + ' (north up), creeping ' + r.creep +
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
    const box = document.getElementById('optTesla'), prevT = t.prefs.tesla, prevW = t.prefs.weather;
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
    const filterOk = (!tile || /invert/.test(tileF)) && !/invert/.test(meF) && !/invert/.test(canvasF);
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
    const ok = r.unsetChips >= 0 && r.stars === 2 && r.home === '테스트집' && r.favList.includes('테스트단골카페') &&
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
          o.mid = { avg: num('#secAvg'), over: hasCls('#secCard', 'over'), shown: visible('#secCard') || (visible('#camAvg') && document.getElementById('camAvg').getClientRects().length > 0), remain: text('#secRemain'),
            remainM: rm ? parseFloat(rm[1]) * (rm[2] === 'km' ? 1000 : 1) : null, wantM: sEnd - s };
        }
        if (o.secAt !== null && !sec && o.endAt === null) o.endAt = r0(s - sEnd);
      }
      const from = mark ? t.alertLog.indexOf(mark) + 1 : 0;
      const log = t.alertLog.slice(from).map((e) => e.text);
      o.voiceStart = log.some((x) => /구간단속 시작/.test(x));
      o.voiceEnd = log.some((x) => /구간단속이 끝났습니다/.test(x));
      o.voiceOver = log.filter((x) => /구간 평균 속도가 제한을 넘었습니다/.test(x)).length;
      if (withNav) t.endNav();
      return o;
    };
    const a = await run(27, true), b = await run(31, true), c = await run(27, false);
    // 길안내 중이면 남은 거리는 경로 위 끝 카메라까지의 실제 거리(±100m). 과속하면 권장 속도와 음성 한 번
    const ok = (o, over, navOn) => o.startTarget !== null && o.startTarget > 1000 && o.secAt !== null && o.secAt >= 0 && o.secAt < 60 &&
      !!o.mid && o.mid.shown && o.mid.over === over && o.endAt !== null && o.endAt >= 0 && o.endAt < 80 && o.voiceStart && o.voiceEnd &&
      (!navOn || (o.mid.remainM !== null && Math.abs(o.mid.remainM - o.mid.wantM) < 100)) &&
      (!over || (/km\/h 이하로/.test(o.mid.remain) && o.voiceOver === 1));
    const show = (o) => 'start cam alert ' + (o.startTarget === null ? 'NEVER' : o.startTarget + ' m before') + ', section on at +' + o.secAt + ' m' +
      (o.mid ? ', mid avg ' + o.mid.avg + ' km/h' + (o.mid.over ? ' OVER' : '') + ' "' + o.mid.remain + '" (real ' + r0(o.mid.wantM) + ' m)' : ', NO CARD') +
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
    const t = T(), box = document.getElementById('optTesla'), prev = t.prefs.tesla;
    const set = (on) => { box.checked = on; box.dispatchEvent(new Event('change')); };
    let r = {};
    try {
      set(true);
      const R = buildNavRoute();
      await planAndStart(R);
      feed(pointAt(R, 15).p, 15, 0);
      t.renderNav();
      await new Promise((res) => setTimeout(res, 60));
      const app = document.getElementById('app').getBoundingClientRect();
      const q = (s) => document.querySelector(s).getBoundingClientRect();
      const clock = q('.timebox'), road = q('#roadName'), gps = q('.gps'), head = q('.heading'), strip = q('#routeStrip'),
        bar = q('#rsBar'), alerts = q('.alerts'), np = q('#navPanel'), btn = q('#zin'), tc = q('.topctrls');
      r = {
        clockTopRight: clock.right > app.right - 40 && clock.top < app.top + 40,
        roadBottomCenter: Math.abs((road.left + road.right) / 2 - (app.left + app.right) / 2) < 30 && road.bottom > app.bottom - 40,
        gpsBottomRight: gps.right > app.right - 40 && gps.bottom > app.bottom - 60,
        compassBottomLeft: head.left < app.left + 40 && head.bottom > app.bottom - 140, // 나침반은 맨 아래 주행 기록 바로 위
        // 주행 기록은 맨 아래지만 화면 테두리에서 띄워서(아래 24px 이상, 왼쪽 20px 이상), 나침반은 그 위
        tripAtBottom: (() => { const tr = document.querySelector('.trip').getBoundingClientRect();
          return tr.bottom <= app.bottom - 24 && tr.bottom > app.bottom - 60 && tr.left >= app.left + 20 && head.bottom <= tr.top + 6; })(),
        stripRight: strip.left > app.right - 80 && bar.width <= 8,
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
          const r = sb.getBoundingClientRect(); return on && r.left < app.left + 60 && r.bottom <= head.top + 4; })(),
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
    const t = T(), C = CAM_SCHOOL, box = document.getElementById('optTesla'), prev = t.prefs.tesla;
    const set = (on) => { box.checked = on; box.dispatchEvent(new Event('change')); };
    const shown = () => { const e = document.getElementById('mySpeed'); return !e.hidden && e.getClientRects().length > 0; };
    const approach = (kmh) => {
      softReset();
      let o = null;
      for (let s = 0; s <= 400 && !o; s += 10) {
        feed(dest(C, 180, 600 - s), kmh / 3.6, 0);
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
      set(false);
      off = approach(45);
    } finally {
      set(prev);
      softReset();
    }
    const okFast = !!fast && fast.shown && fast.over && fast.val === '45' && /제한 30/.test(fast.lim) && fast.order && fast.badge === '어린이 조심' &&
      fast.iconH !== null && fast.iconH <= 32 && !fast.bigTile;
    const okSlow = !!slow && slow.shown && !slow.over && slow.val === '25';
    const okOff = !!off && !off.shown && off.bigTile;
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
    const ok = (o) => !!o && o.kind === 3 && o.limit === 30 && o.label === '신호·과속 단속' && o.sig && o.over;
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
    const okNav = navSw.rear && navSw.rearLabel === '신호·과속 후면단속' && !navSw.h7738 && !navNe.rear && navNe.h7738;
    const okSw = sw.label === '신호·과속 후면단속' && sw.limit === 70 && sw.past45 === true && sw.past45over === true && sw.clearedAt !== null && sw.clearedAt >= 55 && sw.clearedAt <= 75;
    return {
      pass: okSw && !ne && okNav,
      detail: '서울 방향 80 km/h: ' + JSON.stringify(sw) + (okSw ? '✓' : '✗') + ' | 반대 방향: ' + (ne ? 'ALERTED✗' : 'not alerted✓') +
        ' | 길안내 남서행 ' + JSON.stringify(navSw) + ', 북동행 ' + JSON.stringify(navNe) + (okNav ? '✓' : '✗'),
    };
  }

  // S37: 가평 → 청평 → 신청평대교 실제 경로 (2026-11-14 주행 제보 "가는 길 단속 10개 중 2개만 떴다").
  //      test/fixtures/route-gapyeong-cheongpyeong.json: 가평읍 가화로(계량교 북쪽) → 경춘로 → 팔각정삼거리 좌회전 → 북한강로.
  //      원본 '신호'인 교차로 카메라가 신호·과속으로, 반대 방향 등록이 없는 교차로 카메라(수리재·청평검문소·소돌마을)는
  //      양방향으로 잡혀야 한다. 반대 방향 전용(진동마을 과속, 포회촌·벚꽃길의 서울→춘천 쪽)은 잡히면 안 된다
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
      '승안삼거리': ['37.84072,127.50646'], '계량교': ['37.83903,127.5067'], '가평초교(어린이)': ['37.8298,127.51091', '37.82939,127.51094'],
      '포회촌(후면)': ['37.79681,127.48014'], '초옥동': ['37.77894,127.46407'], '수리재': ['37.76907,127.4477'],
      '청평검문소': ['37.74711,127.42867'], '청평중학교': ['37.74205,127.42369'], '소돌마을': ['37.72456,127.40855'],
    };
    const mustNot = { '진동마을(서울→춘천 과속)': '37.81049,127.49785', '포회촌(서울→춘천)': '37.79657,127.4802', '벚꽃길(서울→춘천)': '37.7791,127.46435' };
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
  //      (a) 한밭대로 카메라는 경로선 왼쪽 34m 지만 경로 구간 이름이 '한밭대로'라 잡혀야 한다
  //      (b) 대전로 카메라는 왼쪽 30m 이고 그 구간 이름을 모른다: 지금 달리는 도로(역지오코딩)가 '대전로'면 잡고, 다른 도로면 안 잡는다
  async function s38() {
    const t = T();
    const fx = await (await realFetch(harnessDir + 'fixtures/route-daejeon-yuseong.json', { cache: 'no-store' })).json();
    const P = fx.path.map((x) => ({ lat: x[1], lng: x[0] }));
    const cum = [0];
    for (let i = 1; i < P.length; i++) cum.push(cum[i - 1] + hav(P[i - 1], P[i]));
    const R = { route: fx, P, cum, total: cum[cum.length - 1], dest: { name: '유성', addr: '', lat: P[P.length - 1].lat, lng: P[P.length - 1].lng } };
    const DJ = { lat: 36.33832, lng: 127.42962 }, HB = { lat: 36.35745, lng: 127.40847 };
    const run = async (roadName) => {
      softReset();
      stub.canned['/reverse'] = { road: roadName, area: '대전광역시' };
      await planAndStart(R);
      const o = { daejeonro: false, hanbat: false };
      let k = 0;
      for (let s = 0; s <= 4700; s += 15) {
        const a = pointAt(R, s);
        feed(a.p, 50 / 3.6, a.h);
        if (++k % 6 === 0) await new Promise((r) => setTimeout(r, 0));   // 역지오코딩 응답이 들어오게
        const tg = t.camState.target;
        if (tg && sameCam(tg.c, DJ)) o.daejeonro = true;
        if (tg && sameCam(tg.c, HB)) o.hanbat = true;
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
    const ok = a.daejeonro && a.hanbat && !b.daejeonro && b.hanbat;
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
    const t = T(), box = document.getElementById('optTesla'), prev = t.prefs.tesla;
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
      r.smallBtn = vis('#updBtn') && ub.height <= 34 && ub.right > app.right - 80 && ub.bottom > app.bottom - 90; // 오른쪽 아래 GPS 바로 위
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
    const nav = await drive(true), free = await drive(false);
    const prev = t.prefs.bumps;
    t.prefs.bumps = false;
    const off = await drive(true);
    t.prefs.bumps = prev;
    softReset();
    const mapOk = !t.getMap() || nav.markers >= 1;
    const ok = nav.alerted >= 5 && nav.maxShownD <= 200 && mapOk && /과속방지턱 \d+m/.test(nav.label) && free.alerted >= 3 && off.alerted === 0;
    return {
      pass: ok,
      detail: 'with nav: ' + JSON.stringify(nav) + ' | no nav: ' + JSON.stringify(free) + ' | setting off: ' + JSON.stringify(off) + (ok ? '✓' : '✗'),
    };
  }

  // S42: 그다음 칸 (2026-11-14 요청). 이번 회전을 하고 나서 무엇이 얼마 뒤에 오는지 (거리는 이번 안내 지점 → 그다음 안내 지점).
  //      그다음이 회전이면 네이버 지도처럼 그 회전 아이콘 + '360m'만, 목적지면 연한 빨강 바탕에 빨간 핀 + '480m' ('도착' 글자 없이), 마지막 안내면 숨김
  async function s42() {
    const t = T(), R = buildNavRoute();
    softReset();
    await planAndStart(R);
    const snap = () => { const nn = document.getElementById('nextTurn');
      return { shown: !nn.hidden && nn.getClientRects().length > 0, text: text('#nextDist'), rightIcon: /h14M31 8l8 8-8 8/.test((nn.querySelector('#nextIcon path') || {}).getAttribute?.('d') || ''),
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
    const row = () => ({ shown: visible('#tunnelRow'), inside: document.getElementById('tunnelRow').classList.contains('inside'),
      dist: text('#tunnelDist'), text: text('#tunnelText'), bar: document.getElementById('tunnelBar').style.width,
      icon: !!document.querySelector('#tunnelIcon svg.tunnel') });
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
      r.ahead.shown && !r.ahead.inside && r.ahead.icon && /^1[89]0m$/.test(r.ahead.dist) && /^테스트터널 진입 · 길이 (29|30|31)0m$/.test(r.ahead.text) &&
      r.inside.shown && r.inside.inside && r.inside.text === '테스트터널 출구까지' && m(r.inside.dist) >= 130 && m(r.inside.dist) <= 170 && parseInt(r.inside.bar, 10) >= 40 &&
      r.dr.inside && m(r.inside.dist) - m(r.dr.dist) >= 30 && !r.after.shown && r.offHidden;
    return { pass: ok, detail: JSON.stringify(r) + (ok ? '✓' : '✗') };
  }

  // S45: 하이패스도 단속 서랍 안에 (2026-11-14 요청). 테슬라 모드에서 톨게이트 1km 앞: 하이패스 카드가 서랍(.cd-in) 안에 보이고
  //      서랍이 열리며 안내 패널 바로 밑에 붙는다. 지도 위 흰 글자(그림자) 대신 패널 글자. 톨게이트를 지나면 카드가 빠지고 서랍이 접힌다
  async function s45() {
    const t = T(), box = document.getElementById('optTesla'), prev = t.prefs.tesla;
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
      for (let s = 1525; s <= 2700; s += 25) { const a = pointAt(R, s); feed(a.p, 25, 0); t.renderNav(); }
      r.goneAfter = !visible('#tollCard') && !dr.classList.contains('open');
      t.endNav();
    } finally {
      set(prev);
      softReset();
    }
    const ok = r.shown && r.inDrawer && r.open && r.underPanel && r.noHalo && /하남톨게이트 1\.0km/.test(r.text) && r.tollIcon && r.goneAfter;
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
    const ok = !!west && west.label === '박스형 과속 단속' && west.box && !east;
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
  //      안내 지점 800m 앞부터 서랍 맨 위에 그림: 진입로는 'ramp'·오른쪽, 방면 '서울 · 대전', 지점 '하남IC'.
  //      분기점은 'fork'·왼쪽, 방면은 짧은 이름 '대전 · 호법'. 900m 앞·지난 뒤에는 없음
  async function s48() {
    const t = T(), box = document.getElementById('optTesla'), prev = t.prefs.tesla;
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
        sections: [{ i: 0, n: 31, name: '테스트로', speed: 60, cong: 1 }] },
      P, cum, total, dest: { name: '분기 테스트', addr: '', lat: P[30].lat, lng: P[30].lng },
    };
    const snap = () => { const el = document.getElementById('juncCard');
      return { shown: visible('#juncCard'), kind: (el.querySelector('#juncSvg path.jc-edge + path.jc-edge') ? 'ramp' : 'fork'), left: el.classList.contains('left'),
        hwy: el.classList.contains('hwy'), label: text('#juncLabel'), place: text('#juncPlace'), dist: text('#juncDist'),
        inDrawer: !!el.closest('#camDrawer .cd-in'), open: document.getElementById('camDrawer').classList.contains('open') }; };
    const go = (s) => { const a = pointAt(R, s); feed(a.p, 20, a.h); t.renderNav(); };
    const r = {};
    try {
      set(true);
      softReset();
      await planAndStart(R);
      for (let s = 20; s <= 300; s += 20) go(s);
      r.far = snap();                                   // 하남IC 900m 앞
      for (let s = 320; s <= 600; s += 20) go(s);
      r.ramp = snap();                                  // 하남IC 600m 앞
      for (let s = 620; s <= 1300; s += 20) go(s);
      r.fork = snap();                                  // 하남분기점 700m 앞
      for (let s = 1320; s <= 2100; s += 20) go(s);
      r.after = snap();                                 // 분기점 지난 뒤 (그다음은 목적지)
      t.endNav();
    } finally {
      set(prev);
      softReset();
    }
    const ok = !r.far.shown && r.ramp.shown && r.ramp.kind === 'ramp' && !r.ramp.left && r.ramp.hwy && r.ramp.label === '서울 · 대전' &&
      r.ramp.place === '하남IC' && /^600m$/.test(r.ramp.dist) && r.ramp.inDrawer && r.ramp.open &&
      r.fork.shown && r.fork.kind === 'fork' && r.fork.left && r.fork.label === '대전 · 호법' && r.fork.place === '하남분기점' && !r.after.shown;
    return { pass: ok, detail: JSON.stringify(r) + (ok ? '✓' : '✗') };
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
    // (a) 카메라를 향해 북쪽으로 (1.5km 남쪽에서 1.2km 남쪽까지)
    const ahead = shownAfter(() => { for (let s = 0; s <= 300; s += 20) feed(dest(C, 180, 1500 - s), 20, 0); });
    // (b) 카메라를 지나 북쪽으로 계속 (뒤에 있음)
    const behind = shownAfter(() => { for (let s = 0; s <= 300; s += 20) feed(dest(C, 0, 200 + s), 20, 0); });
    // (c) 왼쪽 18m 옆으로 나란히 = 반대편 차로 (300m 안)
    const opposite = shownAfter(() => { for (let s = 0; s <= 200; s += 20) feed(dest(dest(C, 180, 300 - s), 90, 18), 20, 0); });
    // (d) 멀리(1.8km→1.5km 앞) 왼쪽 25m = 고속도로 반대편 차로의 카메라. 멀리 있어도 지도에 띄우지 않는다
    const farOpposite = shownAfter(() => { for (let s = 0; s <= 300; s += 25) feed(dest(dest(C, 180, 1800 - s), 90, 25), 25, 0); });
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
      // 카메라가 원 위(중심에서 북쪽)에 오도록 중심을 둔다. 왼쪽 굽음: 중심 각을 140°→0° 로 줄이며(반시계) 달린다
      const center = dest(C, 180, R);
      let first = null;
      for (let deg = 140; deg >= 0; deg -= (13 / R) * 180 / Math.PI) {
        const phi = left ? deg : -deg;
        const p = dest(center, (phi + 360) % 360, R);
        const head = ((left ? phi - 90 : phi + 90) + 360) % 360;
        feed(p, 13, head);
        const tg = t.camState.target;
        if (first === null && tg && sameCam(tg.c, C)) first = r0(hav(p, C));
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
    const blueBase = has('base', '#2f7dff'), green = has('traffic', '#03c75a'), red = has('traffic', '#e53935');
    // 막대: 원활(초록)·정체(빨강) 구간이 그려진다. 이 경로는 정보 없는 구간이 없으므로 파랑은 없어도 된다
    const barOk = /rgb\(3, 199, 90\)|#03c75a/.test(bar) && /rgb\(229, 57, 53\)|#e53935/.test(bar);
    // 정보 없는 경로: 구간 정보를 빼면 막대가 파랑
    t.endNav(); softReset();
    const R2 = buildNavRoute(); R2.route.sections = [];
    await planAndStart(R2);
    feed(pointAt(R2, 15).p, 15, 0);
    t.renderNav();
    const bar2 = (document.getElementById('rsBar').style.background || '').toLowerCase();
    const blueBar = /rgb\(47, 125, 255\)|#2f7dff/.test(bar2) && !/rgb\(3, 199, 90\)/.test(bar2);
    return {
      pass: blueBase && green && red && barOk && blueBar,
      detail: 'line: base blue ' + (blueBase ? '✓' : '✗') + ', free-flow green ' + (green ? '✓' : '✗') + ', jam red ' + (red ? '✓' : '✗') +
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
    r.numeric = await t.checkForUpdate('test', { dry: true, latest: t.version.replace(/-(\d+)$/, '-100') }); // -100 > -16 (글자 순서 아님)
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
      const head = (brgFrom + 180) % 360;
      for (let s = 0; s <= from - 100; s += v) {
        const p = dest(C, brgFrom, from - s);
        feed(p, v, head);
        const tg = t.camState.target, d = hav(p, C);
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
    const pass = offHit === null && offMarkers === 0 && freeHit !== null && onHit !== null && onMarkers >= 1 && !!nextTxt && /다음 단속/.test(nextTxt);
    return {
      pass,
      detail: '(a) navigating, camera off the route straight ahead: ' + (offHit === null ? 'ignored✓' : 'WRONG alert at ' + offHit + ' m') +
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
    { id: 'S18', name: 'S18 navigation: route cameras only', fn: s18 },
    { id: 'S19', name: 'S19 latest version from plain link', fn: s19 },
    { id: 'S20', name: 'S20 curved road camera (no nav)', fn: s20 },
    { id: 'S21', name: 'S21 route-number road names', fn: s21 },
    { id: 'S22', name: 'S22 route colours (blue = no traffic data)', fn: s22 },
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
    { id: 'S33', name: 'S33 parked & untouched → check for new version', fn: s33 },
    { id: 'S34', name: 'S34 Tesla mode: camera → my speed → small zone sign, red when over', fn: s34 },
    { id: 'S35', name: 'S35 Gapyeong 계량교 30 camera (data fix): 신호·과속, alerts when over', fn: s35 },
    { id: 'S36', name: 'S36 rear-enforcement camera (가평 포회촌, added): held 60 m past the pole, one direction only', fn: s36 },
    { id: 'S37', name: 'S37 가평→청평 real route: every camera in our direction alerts (signal→신호·과속, lone intersection cams both ways)', fn: s37 },
    { id: 'S38', name: 'S38 wide roads: cameras 20–40 m off the route line (same section name / current road name)', fn: s38 },
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
  ];

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
        for (const sc of SCENARIOS) {
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
