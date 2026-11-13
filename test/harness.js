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
    let label = null, at = null;
    for (let s = 0; s <= 650 && label === null; s += 10) {
      feed(dest(C, 180, 700 - s), 10, 0);
      const tg = t.camState.target;
      if (tg && sameCam(tg.c, C)) { label = text('#camType'); at = r0(tg.d); }
    }
    return {
      pass: label !== null && label.indexOf('어린이보호구역') >= 0,
      detail: label === null ? 'camera never became target' : '#camType="' + label + '" at ' + at + ' m (limit ' + text('#camLimit') + ')',
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
    return {
      pass: nearOk && afterOk && clearOk,
      detail: 'before: ' + (seen.near ? seen.near.past + ' m "' + seen.near.type + ' ' + seen.near.dist + '"' : 'NO TARGET within 25 m') +
        '; after +15..+25 m (card kept, "0m", no margin text): ' + seen.after.map((x) => '+' + x.past + (x.ok ? '✓' : '✗')).join(' ') +
        '; at +' + (seen.cleared ? seen.cleared.past + ' m ' + (seen.cleared.gone ? 'cleared' : 'STILL SHOWN') : '?'),
    };
  }

  // S13: 신호 위반 전용 카메라는 기본 꺼짐, 설정을 켜면 '신호'로 알림
  // 제주 일주동로 [33.37693,126.87362,50,2,0,0,0] — 5.2km 안에 다른 카메라 없음
  const CAM_SIGNAL = { lat: 33.37693, lng: 126.87362 };
  async function s13() {
    const t = T(), C = CAM_SIGNAL, prev = t.prefs.signalCams;
    const drive = () => {
      let hit = null;
      for (let s = 0; s <= 600; s += 14) {
        feed(dest(C, 180, 700 - s), 14, 0);
        const tg = t.camState.target;
        if (tg && sameCam(tg.c, C) && !hit) hit = { d: r0(tg.d), sign: text('#camLimit'), signal: hasCls('#camCard', 'signal') };
      }
      return hit;
    };
    let off, on;
    try {
      t.prefs.signalCams = false;
      off = drive();
      softReset();
      t.prefs.signalCams = true;
      on = drive();
    } finally {
      t.prefs.signalCams = prev;
    }
    return {
      pass: !off && !!on && on.sign === '신호' && on.signal,
      detail: 'setting off: ' + (off ? 'WRONG alert at ' + off.d + ' m' : 'no alert') +
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
      const cl = document.getElementById('cluster'), map = document.getElementById('map');
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
    const okOn = on.pos === 'absolute' && on.mapW >= on.appW - 2 && !on.speedShown && /월 \d+일/.test(on.date) && on.clockShown;
    const okOff = off.pos !== 'absolute' && off.mapW < off.appW - 100 && off.speedShown && !off.date;
    return {
      pass: okOn && okOff,
      detail: 'on: map ' + on.mapW + '/' + on.appW + ' px, cluster ' + on.pos + ', speed ' + (on.speedShown ? 'SHOWN' : 'hidden') + ', date "' + on.date + '"' + (okOn ? '✓' : '✗') +
        '; off: map ' + off.mapW + '/' + off.appW + ' px, speed ' + (off.speedShown ? 'shown' : 'HIDDEN') + (okOff ? '✓' : '✗'),
    };
  }
  const C_A = () => CAM_ISO_A;

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
    { id: 'S13', name: 'S13 signal-only cameras', fn: s13 },
    { id: 'S14', name: 'S14 adjacent-road / opposite-lane cameras', fn: s14 },
    { id: 'S15', name: 'S15 over-speed beep once a second', fn: s15 },
    { id: 'S16', name: 'S16 Tesla mode layout', fn: s16 },
    { id: 'S17', name: 'S17 alert range by road type', fn: s17 },
    { id: 'S18', name: 'S18 navigation: route cameras only', fn: s18 },
    { id: 'S19', name: 'S19 latest version from plain link', fn: s19 },
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
