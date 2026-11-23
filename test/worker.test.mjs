// 길안내 서버(worker/worker.js) 시험 — 가짜 KV·가짜 바깥 API·옮길 수 있는 시계. 실제 서버에는 아무것도 보내지 않는다.
// 실행: node test/worker.test.mjs   (v172 보안 + v175 고침 자동 반영)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(here, '..', 'worker', 'worker.js');
const tmp = path.join(os.tmpdir(), 'tnc-worker-' + process.pid + '.mjs');
fs.writeFileSync(tmp, fs.readFileSync(src, 'utf8'));
const W = (await import(pathToFileURL(tmp).href)).default;
fs.unlinkSync(tmp);

// 시계: Worker 는 날짜를 Date.now 로 잰다
const realNow = Date.now.bind(Date);
let shift = 0;
Date.now = () => realNow() + shift;
const DAY = 86400000;

const kv = new Map();
const LOGS = {
  get: async (k) => (kv.has(k) ? kv.get(k) : null),
  put: async (k, v) => { kv.set(k, v); },
  list: async ({ prefix }) => ({ keys: [...kv.keys()].filter((k) => k.startsWith(prefix)).sort().map((name) => ({ name })), list_complete: true }),
};
const TOKEN = 'T'.repeat(40);
// 실제 배포처럼 IP_SALT 없이 ADMIN_TOKEN 만 (v175: 소금은 토큰에서 만든다)
const env = { LOGS, ADMIN_TOKEN: TOKEN, NCP_KEY_ID: 'id', NCP_KEY: 'k' };
const ROUTE1 = { summary: { distance: 1200, duration: 90000, tollFare: 0, fuelPrice: 100 }, path: [[127.1, 37.5], [127.2, 37.6]],
  guide: [{ pointIndex: 1, type: 88, instructions: '목적지', distance: 1200, duration: 90000 }], section: [{ pointIndex: 0, pointCount: 2, name: '테스트로', speed: 40, congestion: 1 }] };
globalThis.fetch = async (u) => {
  u = String(u);
  if (u.includes('map-direction')) {
    const opt = new URL(u).searchParams.get('option') || 'trafast', route = {};
    opt.split(':').forEach((o) => { route[o] = [ROUTE1]; });
    return new Response(JSON.stringify({ code: 0, route }), { status: 200 });
  }
  if (u.includes('reversegeocode') && u.includes('coords=127.3')) {
    return new Response(JSON.stringify({ results: [{ name: 'roadaddr', land: { name: '테스트로' }, region: { area1: { name: '서울특별시' }, area2: { name: '강동구' }, area3: { name: '둔촌동' } } }] }), { status: 200 });
  }
  if (u.includes('reversegeocode')) return new Response(JSON.stringify({ error: { errorCode: '210', message: 'Permission Denied', details: 'secretish detail' } }), { status: 401 });
  if (u.includes('map-geocode')) return new Response(JSON.stringify({ addresses: [{ roadAddress: '서울 강동구 테스트로 1', jibunAddress: '둔촌동 1', x: '127.1', y: '37.5', distance: 0 }] }), { status: 200 });
  if (u.includes('open-meteo')) return new Response(JSON.stringify({ current: { temperature_2m: 5, weather_code: 0 }, hourly: { precipitation_probability: [0, 10] } }), { status: 200 });
  return new Response('{}', { status: 200 });
};
const O = 'https://bravecheeze.github.io';
let ipN = 0;
async function call(method, pth, { body, token, ip, origin = O, e = env } = {}) {
  const h = { Origin: origin, 'CF-Connecting-IP': ip || ('10.0.0.' + (++ipN % 250)) };
  if (token) h.Authorization = 'Bearer ' + token;
  const r = await W.fetch(new Request('https://w.example' + pth, { method, headers: h, body: body ? JSON.stringify(body) : undefined }), e);
  let j = null;
  try { j = await r.clone().json(); } catch (err) { j = null; }
  return { s: r.status, j, h: r.headers };
}
let fail = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fail++; };
const pub = async () => (await call('GET', '/fixes')).j.items;
const all = async (q) => (await call('GET', '/fixes?all=1' + (q || ''), { token: TOKEN })).j;
const send = (dev, ip, items, token) => call('POST', '/fix', { body: { dev, items }, ip, token });

// ---------------- v172 보안 ----------------
ok(/Authorization/.test((await call('OPTIONS', '/events')).h.get('Access-Control-Allow-Headers')), 'preflight allows Authorization');
ok((await call('GET', '/events')).s === 401, '/events without token → 401');
ok((await call('GET', '/events', { token: 'wrong' })).s === 401, '/events wrong token → 401');
ok((await call('GET', '/events', { token: TOKEN })).s === 200, '/events with token → 200');
ok((await call('GET', '/log?id=abc')).s === 401, 'GET /log without token → 401');
ok((await call('POST', '/log', { body: { a: 1 } })).s === 401, 'POST /log without token → 401');
const lp = await call('POST', '/log', { body: { a: 1 }, token: TOKEN });
ok(lp.s === 200 && lp.j.id && (await call('GET', '/log?id=' + lp.j.id, { token: TOKEN })).s === 200, '/log with token → stored and readable');
ok((await call('POST', '/log', { body: { big: 'x'.repeat(600000) }, token: TOKEN, ip: '9.9.9.9' })).s === 413, '/log over 500KB → 413');
await call('POST', '/event', { body: { type: 'warn', msg: 'pub', trace: [[0, 37, 127]] } });
await call('POST', '/event', { body: { type: 'warn', msg: 'op', trace: [[0, 37, 127]] }, token: TOKEN });
const ev = (await call('GET', '/events', { token: TOKEN })).j.items;
ok(!('trace' in ev.find((x) => x.msg === 'pub')) && Array.isArray(ev.find((x) => x.msg === 'op').trace), 'public event trace dropped, operator trace kept');
let codes = [];
for (let i = 0; i < 42; i++) codes.push((await call('GET', '/route?start=127.1,37.5&goal=127.2,37.6&options=trafast', { ip: '2.2.2.2' })).s);
const r41 = await call('GET', '/route?start=127.1,37.5&goal=127.2,37.6&options=trafast', { ip: '2.2.2.2' });
ok(codes.slice(0, 40).every((c) => c === 200) && codes[40] === 429 && r41.j.retryAfter >= 1 && r41.j.retryAfter <= 60, '/route 41st request in a minute from one IP → 429 with retryAfter');
// v175 공유 IP(CGNAT): 같은 IP 뒤의 차 12대가 1분 동안 정상으로 달린다 — 차마다 /reverse 10번, 처음 길찾기 1번, 재탐색 2번(2.5초 간격으로 섞임)
{
  const CG = '100.64.0.7', base = shift, bad = [];
  for (let car = 0; car < 12; car++) {
    for (let k = 0; k < 10; k++) { const r = await call('GET', '/reverse?coords=127.1' + car + ',37.5', { ip: CG }); if (r.s === 429) bad.push('reverse'); }
    const r = await call('GET', '/route?start=127.1,37.5&goal=127.2,37.6&options=trafast:traoptimal', { ip: CG }); if (r.s === 429) bad.push('route');
  }
  for (let k = 0; k < 24; k++) {
    shift = base + k * 2500;
    const r = await call('GET', '/route?start=127.1,37.5&goal=127.2,37.6&option=trafast', { ip: CG });
    if (r.s === 429) bad.push('reroute@' + k);
  }
  shift = base;
  ok(bad.length === 0, '12 cars behind one shared IP: /reverse and /route never rate limited (' + (bad.join(',') || 'none') + ')');
  // 한 대가 미친 듯이 재탐색하면(15초에 7번째) 막힌다
  let burst = [];
  for (let k = 0; k < 7; k++) burst.push((await call('GET', '/route?start=127.1,37.5&goal=127.2,37.6&option=trafast', { ip: '100.64.9.9' })).s);
  ok(burst.slice(0, 6).every((c) => c === 200) && burst[6] === 429, 'single-option reroutes: 7th within 15 s from one IP → 429');
}
codes = [];
for (let i = 0; i < 32; i++) codes.push((await call('GET', '/events', { ip: '3.3.3.3', token: 'bad' })).s);
ok(codes[31] === 429, 'token guessing gets rate limited');
const rv = await call('GET', '/reverse?coords=127.1,37.5');
ok(rv.s === 502 && rv.j.message === 'Permission Denied' && !JSON.stringify(rv.j).includes('secretish'), 'upstream error trimmed');
ok((await call('GET', '/config', { origin: 'https://evil.example' })).s === 403, 'other origin → 403');
const hl = await call('GET', '/health', { origin: '' });
ok(hl.s === 200 && hl.j.autoFix === true, '/health open, autoFix on (salt from ADMIN_TOKEN, no IP_SALT needed)');

// ---------------- 예전 페이지(v158~v174) 호환: 토큰 없이 보내는 요청이 예전과 같은 모양으로 ----------------
{
  const old = (pth, o) => call(o && o.body ? 'POST' : 'GET', pth, Object.assign({ ip: '172.16.0.' + (++ipN % 250) }, o || {}));
  const cfg = await old('/config');
  ok(cfg.s === 200 && cfg.j.mapKeyId === 'id', 'old page: /config gives the map key id');
  const multi = await old('/route?start=127.1,37.5&goal=127.2,37.6&options=trafast:traoptimal:traavoidtoll');
  const a0 = multi.j && multi.j.alternatives && multi.j.alternatives[0];
  ok(multi.s === 200 && multi.j.alternatives.length === 3 && a0.option === 'trafast' && a0.distance === 1200 && a0.path.length === 2 &&
    a0.guide[0].t === 88 && a0.sections[0].name === '테스트로', 'old page: first route search (options=) returns the same alternatives shape');
  const single = await old('/route?start=127.1,37.5&goal=127.2,37.6&option=traoptimal');
  ok(single.s === 200 && single.j.option === 'traoptimal' && single.j.path.length === 2 && !single.j.alternatives, 'old page: reroute (option=) returns a single route as before');
  const rev = await old('/reverse?coords=127.3,37.5');
  ok(rev.s === 200 && rev.j.road === '테스트로' && rev.j.area === '서울특별시 강동구 둔촌동', 'old page: /reverse road name and area');
  const geo = await old('/geocode?query=' + encodeURIComponent('테스트로 1'));
  ok(geo.s === 200 && geo.j.items[0].lat === 37.5 && geo.j.items[0].name === '서울 강동구 테스트로 1', 'old page: /geocode');
  const srch = await old('/search?query=' + encodeURIComponent('카페'));
  ok(srch.s === 200 && Array.isArray(srch.j.items), 'old page: /search (no search key → empty list as before)');
  const wx = await old('/weather?lat=37.5&lng=127.1');
  ok(wx.s === 200 && wx.j.temp === 5 && wx.j.rain === 10, 'old page: /weather');
  ok((await old('/hipass?name=' + encodeURIComponent('하남'))).s === 501, 'old page: /hipass without EX_KEY → 501 as before');
  const rep1 = await old('/event', { body: { type: 'warn', msg: 'user missed @1', user: 'missed', near: [{ i: 1, lat: 37.5, lng: 127.1 }], heading: 90, trace: [[0, 37.5, 127.1]] } });
  ok(rep1.s === 200 && rep1.j.ok === true, 'old page: 놓침 report (/event) accepted');
  const stored = (await call('GET', '/events?user=1', { token: TOKEN })).j.items.find((x) => x.msg === 'user missed @1');
  ok(stored && stored.user === 'missed' && Array.isArray(stored.near) && !('trace' in stored), 'old page: report stored with camera points, without the trace');
  const fx = await old('/fix', { body: { dev: 'oldpage01', items: [{ kind: 'spot', lat: 37.45, lng: 127.05, h: 0 }] } });
  ok(fx.s === 200 && fx.j.ok === true, 'old page: /fix accepted');
  const fl = await old('/fixes');
  ok(fl.s === 200 && fl.j.v === 1 && Array.isArray(fl.j.items), 'old page: /fixes shape {v:1, items}');
  kv.clear();
}

// ---------------- v175 고침 자동 반영 ----------------
const CAM = { kind: 'dir', k: '37.5,127.1', lat: 37.5, lng: 127.1, h: 90 };
// (1) 기기 2대·접속지 2곳 → 후보
await send('devaaaa01', '1.1.1.1', [CAM]);
await send('devbbbb02', '1.1.1.2', [CAM]);
ok((await pub()).length === 0, '2 devices → not public');
// (2) 같은 접속지에서 기기 번호만 바꿔 3번 → 후보
const CAM2 = { kind: 'route', k: '37.51,127.11', lat: 37.51, lng: 127.11, h: 0 };
for (const d of ['solo0001', 'solo0002', 'solo0003', 'solo0004']) await send(d, '7.7.7.7', [CAM2]);
let a = await all();
const c2 = a.items.find((x) => x.k === CAM2.k);
ok(c2 && c2.devs === 4 && c2.ips === 1 && c2.n === 1 && c2.state === 'pending' && !(await pub()).some((x) => x.k === CAM2.k), 'same IP hash with 4 device ids → stays a candidate');
// (3) 셋째 기기·접속지 → 공개 (src auto)
await send('devcccc03', '1.1.1.3', [CAM]);
let p1 = await pub();
ok(p1.length === 1 && p1[0].k === CAM.k && p1[0].src === 'auto', '3 devices from 3 IPs → public as auto');
// (4) 새 지점: 50m 안·±45° 는 한 항목, 80m 떨어지거나 방향이 120° 다르면 따로
const S = (dLat, h) => ({ kind: 'spot', lat: 37.6 + dLat, lng: 127.2, h });
await send('spot0001', '2.0.0.1', [S(0, 10)]);
await send('spot0002', '2.0.0.2', [S(0.0002, 30)]);    // 22m 북쪽, 20° 차이
await send('spot0003', '2.0.0.3', [S(-0.0003, 350)]);  // 33m 남쪽, 20° 차이
await send('spot0004', '2.0.0.4', [S(0.0007, 10)]);    // 77m → 따로
await send('spot0005', '2.0.0.5', [S(0, 130)]);        // 방향 120° → 따로
a = await all('&state=auto');
const spots = (await all()).items.filter((x) => x.kind === 'spot');
ok(spots.length === 3 && a.items.some((x) => x.kind === 'spot' && x.n === 3), 'spot reports within 50 m and ±45° merge; 77 m away or 120° off are separate');
ok((await pub()).filter((x) => x.kind === 'spot').length === 1, 'merged spot with 3 reporters is public');
// (5) 운영자 목록: 신고자 값 없이 수·날짜·상태만
const raw = JSON.stringify(await all());
ok(!/devaaaa01|solo0001|spot0001/.test(raw) && !/"ips":\[/.test(raw) && /"first":"\d{4}-\d\d-\d\d"/.test(raw), 'admin list has counts and dates, no device ids or IP hashes');
ok((await call('GET', '/fixes?all=1')).j.items.every((x) => !('n' in x)), '?all=1 without token gives only the public list');
// (6) 토큰 없이 확인·되돌리기 불가
const id1 = (await all()).items.find((x) => x.k === CAM.k).id;
ok((await call('POST', '/fix/review', { body: { items: [{ id: id1, action: 'revert' }] } })).s === 401, 'review without token → 401');
ok((await call('POST', '/fix/review', { body: { items: [{ id: id1, action: 'revert' }] }, token: 'wrong' })).s === 401, 'review with a wrong token → 401');
// (7) 30일 만료: 25일 뒤는 'expiring'(공개), 31일 뒤는 'expired'(비공개)
shift = 25 * DAY;
let st = (await all()).items.find((x) => x.k === CAM.k);
ok(st.state === 'expiring' && st.public && st.expiresInDays === 5 && (await pub()).some((x) => x.k === CAM.k), 'auto fix after 25 idle days is expiring but still public');
shift = 31 * DAY;
st = (await all()).items.find((x) => x.k === CAM.k);
ok(st.state === 'expired' && !(await pub()).some((x) => x.k === CAM.k), 'auto fix after 31 idle days drops out');
// 새 신고가 오면 다시 공개
await send('devdddd04', '1.1.1.4', [CAM]);
ok((await pub()).some((x) => x.k === CAM.k && x.src === 'auto'), 'a new report revives an expired auto fix');
// (8) 확인한 곳은 만료되지 않는다 (src op)
const r1 = await call('POST', '/fix/review', { body: { items: [{ id: id1, action: 'confirm' }] }, token: TOKEN });
ok(r1.s === 200 && r1.j.done[0].ok && r1.j.done[0].state === 'ok', 'operator confirm');
shift = 200 * DAY;
ok((await pub()).some((x) => x.k === CAM.k && x.src === 'op'), 'confirmed fix still public 170 days later');
// (9) 되돌리기: 공개 안 함, 신고가 더 와도 다시 자동 반영하지 않음, 되살리기
const spotId = (await all()).items.find((x) => x.kind === 'spot' && x.n === 3).id;
shift = 0;
await call('POST', '/fix/review', { body: { items: [{ id: spotId, action: 'revert' }] }, token: TOKEN });
await send('spot0006', '2.0.0.6', [S(0, 10)]);
st = (await all()).items.find((x) => x.id === spotId);
ok(st.state === 'reverted' && st.n === 4 && !(await pub()).some((x) => x.kind === 'spot'), 'reverted stays hidden even with more reports');
await call('POST', '/fix/review', { body: { items: [{ id: spotId, action: 'restore' }] }, token: TOKEN });
ok((await pub()).some((x) => x.kind === 'spot'), 'restore brings it back');
ok((await call('POST', '/fix/review', { body: { items: [{ id: 'nope', action: 'confirm' }] }, token: TOKEN })).j.done[0].error === 'not found', 'unknown id → not found');
// (10) 운영자 토큰으로 보낸 고침은 바로 공개
await send('opdev001', '5.5.5.5', [{ kind: 'signal', k: '37.7,127.3', lat: 37.7, lng: 127.3, h: 0 }], TOKEN);
ok((await pub()).some((x) => x.k === '37.7,127.3' && x.src === 'op'), 'operator-sent fix is public at once');
// (11) 소금이 없으면(IP_SALT·ADMIN_TOKEN 둘 다 없음) 자동 반영하지 않는다. IP_SALT 를 따로 넣으면 그것을 쓴다
kv.clear();
const env2 = { LOGS, NCP_KEY_ID: 'id', NCP_KEY: 'k' };
for (const [d, ip] of [['nos00001', '8.8.8.1'], ['nos00002', '8.8.8.2'], ['nos00003', '8.8.8.3']]) await call('POST', '/fix', { body: { dev: d, items: [CAM] }, ip, e: env2 });
ok((await call('GET', '/fixes', { e: env2 })).j.items.length === 0 && (await call('GET', '/health', { origin: '', e: env2 })).j.autoFix === false, 'without any salt nothing is auto-published');
kv.clear();
const env3 = { ...env, IP_SALT: 'S'.repeat(40) };
for (const [d, ip] of [['sal00001', '8.8.9.1'], ['sal00002', '8.8.9.2'], ['sal00003', '8.8.9.3']]) await call('POST', '/fix', { body: { dev: d, items: [CAM] }, ip, e: env3 });
ok((await call('GET', '/fixes', { e: env3 })).j.items.some((x) => x.src === 'auto'), 'an explicit IP_SALT also works');
// (12) 나쁜 키는 버린다
await send('bad00001', '6.6.6.6', [{ kind: 'dir', k: '<script>', lat: 37.5, lng: 127.1 }]);
ok(!(await all()).items.some((x) => x.k === '<script>'), 'bad key rejected');

// ---------------- v196 카메라 통과 익명 통계 (/pass · /passes, D1 바인딩 STATS) ----------------
// 가짜 D1: node 의 내장 SQLite (prepare/bind/run/all/first, batch)
let sqlite = null;
try { sqlite = await import('node:sqlite'); } catch (e) { sqlite = null; }
if (!sqlite) {
  console.log('SKIP /pass tests (node:sqlite not available in this node)');
} else {
  const db = new sqlite.DatabaseSync(':memory:');
  const st = (sql, args) => ({
    bind: (...a) => st(sql, a),
    run: async () => { db.prepare(sql).run(...(args || [])); return { success: true }; },
    all: async () => ({ results: db.prepare(sql).all(...(args || [])) }),
    first: async () => db.prepare(sql).get(...(args || [])) || null,
    _sync: () => (/^\s*select/i.test(sql) ? db.prepare(sql).all(...(args || [])) : db.prepare(sql).run(...(args || []))),
  });
  const STATS = { prepare: (sql) => st(sql), batch: async (list) => { db.exec('BEGIN'); try { const r = list.map((s) => s._sync()); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } } };
  const envS = { ...env, STATS };
  const rows = (sql, ...a) => db.prepare(sql).all(...a);
  const kst = (ms) => new Date(ms + 9 * 3600e3).toISOString().slice(0, 10);
  const today = () => kst(Date.now());
  const K1 = '37.3066,127.10576|4', K2 = '37.51701,127.14377|2';
  const it = (k, o) => Object.assign({ k, d: today(), lim: 60, kind: 3, a: 0, g: 0, hid: 0, kmh: 60, nav: 0 }, o);
  // (1) D1 이 없으면 저장하지 않고 ok:false
  const off = await call('POST', '/pass', { body: { items: [it(K1, { a: 400 })] } });
  ok(off.s === 200 && off.j.ok === false && off.j.why === 'off', '/pass without STATS → ok:false, nothing stored');
  ok((await call('GET', '/health', { origin: '' })).j.stats === false && (await call('GET', '/health', { origin: '', e: envS })).j.stats === true, '/health shows the stats binding');
  // (2) 합계: 경고 2(거리 400·300) · 같은 자리 1 · 놓침 1 · 제한 모름 1 · 과속 1 · 길안내 1, 다른 카메라 1
  const b1 = { v: 'x', sid: 'leak01', dev: 'leakdev1', lat: 37.123456, lng: 127.654321,
    items: [it(K1, { a: 400, kmh: 75, nav: 1 }), it(K1, { a: 300 }), it(K1, { g: 1 }), it(K1, {}), it(K1, { hid: 1, lim: 0, kmh: 80 }), it(K2, { lim: 50, kind: 1, a: 250 })] };
  const p1 = await call('POST', '/pass', { body: b1, e: envS });
  ok(p1.s === 200 && p1.j.ok === true && p1.j.cams === 2, '/pass stores daily totals per camera');
  let c1 = rows('SELECT * FROM cam_day WHERE cam = ?', K1)[0];
  ok(c1 && c1.n === 5 && c1.alerted === 2 && c1.adist === 700 && c1.covered === 1 && c1.missed === 1 && c1.hidden === 1 && c1.over === 1 && c1.navn === 1,
    'counts: passes 5, alerted 2 (700 m), covered 1, missed 1, hidden 1, over 1, nav 1');
  // 받은 값(sid·기기·위치)은 어디에도 남지 않는다: 표는 정해진 칸뿐이고 값에도 없다
  const dump = JSON.stringify([rows('SELECT * FROM cam_day'), rows('SELECT * FROM cand_day'), rows('SELECT * FROM op_pass')]);
  ok(!/leak01|leakdev1|37\.123456|127\.654321/.test(dump) && rows('SELECT * FROM op_pass').length === 0, 'no sid, device id or car position stored; no operator rows from a public post');
  await call('POST', '/pass', { body: { items: [it(K1, {}), it(K1, { a: 500 })] }, e: envS });
  c1 = rows('SELECT * FROM cam_day WHERE cam = ?', K1)[0];
  ok(c1.n === 7 && c1.missed === 2 && c1.alerted === 3, 'a second batch adds to the same row');
  // (3) 나쁜 값: 한국 밖·이상한 키·큰 묶음
  await call('POST', '/pass', { body: { items: [it('1.0,1.0|4', {}), it('<x>', {}), it('37.5,127.1|9', {}), { k: 5 }, null] }, e: envS });
  ok(rows('SELECT COUNT(*) AS n FROM cam_day')[0].n === 2, 'bad keys, out-of-Korea and bad direction rejected');
  ok((await call('POST', '/pass', { body: { items: [], pad: 'x'.repeat(40000) }, e: envS })).s === 413, 'public batch over 30KB → 413');
  // (4) 날짜: 3일보다 오래되거나 미래면 오늘로
  await call('POST', '/pass', { body: { items: [it(K2, { d: '2020-01-01', lim: 50, kind: 1 })] }, e: envS });
  ok(rows('SELECT day FROM cam_day WHERE cam = ?', K2).every((r) => r.day === today()), 'an old or odd date counts as today');
  // (5) 후보 격자: 서로 다른 날 2번 넘게 + 3번 넘게 모인 것만 /passes 에
  const cand = (c, o, dr, d) => ({ c, o, dr, d: d || today() });
  await call('POST', '/pass', { body: { cand: [cand('37400,127100', 2, 30), cand('37400,127100', 2, 20), cand('37410,127110', 0, 25), cand('99999,999999', 0, 30), cand('37400,127100', 9, 30)] }, e: envS });
  shift += DAY;
  await call('POST', '/pass', { body: { cand: [cand('37400,127100', 2, 40), cand('37410,127110', 0, 25), cand('37410,127110', 0, 25)] }, e: envS });
  ok((await call('GET', '/passes')).s === 401, '/passes without token → 401');
  const ps = (await call('GET', '/passes?days=7&op=1', { token: TOKEN, e: envS })).j;
  ok(ps.stats === true && ps.cams[0].k === K1 && ps.cams[0].missed === 2 && ps.cams[0].missRate === Math.round(2 / 7 * 1000) / 1000 && ps.cams[0].avgAlert === 400 &&
    ps.cams[0].lat === 37.3066 && ps.cams[0].dir === 180, '/passes lists cameras by misses with rate, average alert distance and position');
  const cA = ps.cands.find((x) => x.cell === '37400,127100'), cB = ps.cands.find((x) => x.cell === '37410,127110');
  ok(cA && cA.n === 3 && cA.days === 2 && cA.avgDrop === 30 && cA.dir === 90 && cA.lat === 37.4 && cB && cB.n === 3 && ps.cands.length === 2,
    'candidate cells need 2 days and 3 passes; bad cells dropped');
  ok(ps.daily.length >= 1 && ps.daily.some((d) => d.n >= 7), '/passes gives daily totals');
  // (6) 운영자 차: 통과마다 카메라·시각·궤적, 토큰 없이 보낸 op 는 버린다
  const opRec = (k, o) => Object.assign({ k, d: today(), t: Date.now(), lat: 37.3066, lng: 127.10576, a: 0, g: 0, hid: 0, kmh: 63, minD: 4, trace: [[-3, 37.31, 127.1, 5, 17, 180, 180]] }, o);
  await call('POST', '/pass', { body: { items: [it(K1, {})], op: [opRec(K1, {})] }, e: envS });
  ok(rows('SELECT COUNT(*) AS n FROM op_pass')[0].n === 0, 'operator rows need the token');
  await call('POST', '/pass', { body: { items: [it(K1, {}), it(K2, { a: 300 })], op: [opRec(K1, {}), opRec(K2, { a: 300, trace: undefined })] }, token: TOKEN, e: envS });
  const ps2 = (await call('GET', '/passes?days=7&op=1', { token: TOKEN, e: envS })).j;
  ok(ps2.op.length === 2 && ps2.op[0].k === K1 && Array.isArray(ps2.op[0].trace) && ps2.op[1].a === 300, 'operator passes stored, misses first, with trace');
  // (7) 보관: 운영자 기록 90일, 후보 180일 (그날 첫 /pass 때 지움), 카메라 합계는 그대로
  shift += 100 * DAY;
  await call('POST', '/pass', { body: { items: [] }, e: envS });
  ok(rows('SELECT COUNT(*) AS n FROM op_pass')[0].n === 0 && rows('SELECT COUNT(*) AS n FROM cand_day')[0].n > 0 && rows('SELECT COUNT(*) AS n FROM cam_day')[0].n >= 2,
    'after 100 days operator rows are gone, candidate and camera totals kept');
  shift += 100 * DAY;
  await call('POST', '/pass', { body: { items: [] }, e: envS });
  ok(rows('SELECT COUNT(*) AS n FROM cand_day')[0].n === 0 && rows('SELECT COUNT(*) AS n FROM cam_day')[0].n >= 2, 'after 200 days candidate cells are gone, camera totals kept');
  shift = 0;
}

Date.now = realNow;
console.log(fail ? fail + ' FAILED' : 'ALL PASS');
process.exit(fail ? 1 : 0);
