// 시험 주행 사진 찍기 (개발용): 화면 없는 크롬으로 앱을 띄워 실제 네이버 경로를 모의로 달리며,
// 안내 지점마다 차 화면 크기(804×638)로 낮·밤 사진을 찍는다. 디자인·가독성 검토용.
//   node tools/tour.mjs <출력 폴더> [경로 이름,…]
// - 앱은 http://localhost:8765 (네이버 지도 허용 주소)에서 열어야 한다. 화면 없는 크롬은 GPU 가 없어 그림(래스터) 지도로 그린다.
// - 출력: <폴더>/<경로>_<번호>_<종류>_<낮|밤>.png 와 shots.json(사진마다 안내 문구·종류·남은 거리·패널 글자)
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const OUT = process.argv[2] || join(tmpdir(), 'tnc-tour');
const ONLY = (process.argv[3] || '').split(',').filter(Boolean);
const APP = 'http://localhost:8765/index.html?debug';
const PORT = 9333;
const CHROME = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(existsSync);

// 경로: [이름, 출발 lng,lat, 도착 lng,lat, 설명]
export const ROUTES = [
  ['yeomgok_under', '127.054000,37.459700', '127.039300,37.466900', '헌릉로 → 염곡지하차도 진입'],
  ['yeomgok_side', '127.054000,37.459700', '127.035500,37.459000', '헌릉로 → 지하차도 옆길 → 염곡사거리 좌회전 → 양재IC 갈림길'],
  ['pungdeok_over', '127.105200,37.322600', '127.128493,37.539549', '죽전 → 풍덕 고가 진입 → 분당수서로(터널·정자지하차도) → 강동'],
  ['hanam_ic', '127.214800,37.539300', '127.442500,37.272000', '하남시청 → 하남IC 진입 → 중부고속도로 → 이천'],
  ['pangyo_jc', '127.111000,37.394700', '127.028600,37.263600', '판교 → 경부/분기점 → 수원'],
  ['namsan_toll', '127.006000,37.534000', '126.985000,37.561000', '한남동 → 남산1호터널 톨게이트 → 명동'],
  ['sejong_rb', '127.289000,36.480000', '127.260000,36.504000', '세종시청 → 회전교차로 → 정부세종청사'],
  ['seongnam_exit', '127.040000,37.480000', '127.150000,37.420000', '강남 → 분당수서/성남 진출'],
];
const KEEP = /^(fork|ramp|entry|over|under|side|oside)$|^rb|^(toll|goal|sharp|u)|^(kl|kr|inl|inr|outl|outr|outs|ins|over_|under_|side_|oside_)/;

async function cdp(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let id = 0;
  const wait = new Map();
  ws.onmessage = (m) => { const j = JSON.parse(m.data); if (j.id && wait.has(j.id)) { wait.get(j.id)(j); wait.delete(j.id); } };
  const send = (method, params = {}) => new Promise((res) => { const i = ++id; wait.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  return { send, close: () => ws.close() };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  mkdirSync(OUT, { recursive: true });
  const prof = join(tmpdir(), 'tnc-tour-profile');
  const chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=' + PORT, '--user-data-dir=' + prof, '--window-size=804,638',
    '--hide-scrollbars', '--no-first-run', '--lang=ko-KR', 'about:blank'], { stdio: 'ignore' });
  let page = null;
  for (let k = 0; k < 50 && !page; k++) {
    await sleep(200);
    try { page = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).find((t) => t.type === 'page'); } catch (e) { /* 아직 */ }
  }
  if (!page) throw new Error('크롬 디버그 포트가 열리지 않음');
  const c = await cdp(page.webSocketDebuggerUrl);
  await c.send('Emulation.setDeviceMetricsOverride', { width: 804, height: 638, deviceScaleFactor: 1, mobile: false });
  await c.send('Emulation.setTimezoneOverride', { timezoneId: 'Asia/Seoul' });
  const ev = async (expr) => {
    const r = await c.send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true, timeout: 120000 });
    if (r.result && r.result.exceptionDetails) throw new Error(JSON.stringify(r.result.exceptionDetails).slice(0, 300));
    return r.result && r.result.result && r.result.result.value;
  };
  const shot = async (file) => {
    const r = await c.send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(OUT, file), Buffer.from(r.result.data, 'base64'));
  };
  const log = [];
  for (const [name, start, goal, desc] of ROUTES) {
    if (ONLY.length && !ONLY.includes(name)) continue;
    await c.send('Page.navigate', { url: APP + '&t=' + Date.now() });
    await sleep(6000);
    // 경로 받기 → 안내 지점 고르기
    const info = await ev(`(async () => {
      const T = window.__tnc; if (!T) return { err: 'no __tnc' };
      const n = document.querySelector('#gpsNotice'); if (n) n.hidden = true;
      const W = 'https://tesla-nav.cy6789.workers.dev';
      const j = await (await fetch(W + '/route?start=${start}&goal=${goal}&options=traoptimal')).json();
      const r = (j.alternatives || [])[0]; if (!r) return { err: 'no route' };
      window.__tour = { r };
      const P = r.path.map((p) => ({ lat: p[1], lng: p[0] }));
      const R = 6371000, k = Math.PI / 180, hav = (a, b) => { const x = Math.sin((b.lat - a.lat) * k / 2) ** 2 + Math.cos(a.lat * k) * Math.cos(b.lat * k) * Math.sin((b.lng - a.lng) * k / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(x)); };
      const cum = [0]; for (let i = 1; i < P.length; i++) cum.push(cum[i - 1] + hav(P[i - 1], P[i]));
      window.__tour.P = P; window.__tour.cum = cum;
      return { km: r.distance / 1000, guides: r.guide.map((g, i) => ({ i, at: cum[Math.min(g.i, cum.length - 1)], t: g.t, s: g.s, kind: T.turnKind(g) })) };
    })()`);
    if (!info || info.err) { log.push({ route: name, err: info && info.err }); continue; }
    // 종류가 다른 안내를 앞에서부터 최대 7개 (같은 종류는 2번까지) + 마지막(도착)
    const seen = {}, picks = [];
    for (const g of info.guides) {
      const kk = g.kind;
      if (!KEEP.test(kk) && !(g.t >= 50 && g.t <= 82)) continue;
      if ((seen[kk] = (seen[kk] || 0) + 1) > 2) continue;
      if (picks.length < 7) picks.push(g);
    }
    const last = info.guides[info.guides.length - 1];
    if (!picks.includes(last)) picks.push(last);
    for (const [pi, g] of picks.entries()) {
      for (const theme of ['day', 'night']) {
        const before = g.kind === 'goal' ? 120 : 350;
        const res = await ev(`(async () => {
          const T = window.__tnc, { r, P, cum } = window.__tour;
          T.endNav(); T.setNightMode('${theme === 'night' ? 'on' : 'off'}');
          const k = Math.PI / 180, brg = (a, b) => { const y = Math.sin((b.lng - a.lng) * k) * Math.cos(b.lat * k), x = Math.cos(a.lat * k) * Math.sin(b.lat * k) - Math.sin(a.lat * k) * Math.cos(b.lat * k) * Math.cos((b.lng - a.lng) * k); return (Math.atan2(y, x) / k + 360) % 360; };
          const at = (s) => { let i = cum.findIndex((c) => c > s); if (i < 1) i = P.length - 1; const a = P[i - 1], b = P[i], t = (s - cum[i - 1]) / Math.max(1e-6, cum[i] - cum[i - 1]); return { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t, h: brg(a, b) }; };
          let clock = (T.state.fix ? T.state.fix.t : Date.now()) + 60000;
          const p0 = at(0); T.onFix({ lat: p0.lat, lng: p0.lng, acc: 5, speed: 0, heading: p0.h, t: clock });
          T.setRoute(r, { name: '${desc.split(' → ').pop().replace(/'/g, '')}', lat: P[P.length - 1].lat, lng: P[P.length - 1].lng }); T.startNav();
          const target = Math.max(0, ${g.at} - ${before}), step = 18;
          for (let s = Math.max(0, target - 1500); s <= target; s += step) { clock += 1000; const p = at(s); T.onFix({ lat: p.lat, lng: p.lng, acc: 5, speed: 18, heading: p.h, t: clock }); }
          const n = document.querySelector('#gpsNotice'); if (n) n.hidden = true;
          await new Promise((res) => setTimeout(res, 2500));
          const txt = (sel) => { const e = document.querySelector(sel); return e && !e.hidden ? e.innerText.replace(/\\s+/g, ' ').trim() : ''; };
          return { next: T.nav.next && T.nav.next.s, nextKind: T.nav.next && T.turnKind(T.nav.next), dg: Math.round(T.nav.dg || 0),
                   panel: txt('.navpanel'), drawer: txt('#camDrawer'), junc: !document.querySelector('#juncCard').hidden, night: document.querySelector('#map').classList.contains('night') };
        })()`);
        const file = `${name}_${String(pi).padStart(2, '0')}_${g.kind}_${theme}.png`;
        await shot(file);
        log.push(Object.assign({ route: name, desc, file, guide: g.s, kind: g.kind, type: g.t, theme }, res));
        process.stdout.write('.');
      }
    }
    process.stdout.write(' ' + name + '\n');
  }
  writeFileSync(join(OUT, 'shots.json'), JSON.stringify(log, null, 1));
  c.close(); chrome.kill();
  console.log('사진 ' + log.filter((x) => x.file).length + '장 → ' + OUT);
}
main().catch((e) => { console.error(e); process.exit(1); });
