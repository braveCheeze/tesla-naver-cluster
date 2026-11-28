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
const kvCount = { list: 0 };   // v293: 무료 KV 목록은 하루 1,000번 — 자주 불리는 길에서 목록을 부르는지 센다
const LOGS = {
  get: async (k) => (kv.has(k) ? kv.get(k) : null),
  put: async (k, v) => { kv.set(k, v); },
  delete: async (k) => { kv.delete(k); },
  list: async ({ prefix }) => { kvCount.list++; return { keys: [...kv.keys()].filter((k) => k.startsWith(prefix)).sort().map((name) => ({ name })), list_complete: true }; },
};
const TOKEN = 'T'.repeat(40);
// 실제 배포처럼 IP_SALT 없이 ADMIN_TOKEN 만 (v175: 소금은 토큰에서 만든다)
const env = { LOGS, ADMIN_TOKEN: TOKEN, NCP_KEY_ID: 'id', NCP_KEY: 'k' };
const ROUTE1 = { summary: { distance: 1200, duration: 90000, tollFare: 0, fuelPrice: 100 }, path: [[127.1, 37.5], [127.2, 37.6]],
  guide: [{ pointIndex: 1, type: 88, instructions: '목적지', distance: 1200, duration: 90000 }], section: [{ pointIndex: 0, pointCount: 2, name: '테스트로', speed: 40, congestion: 1 }] };
const routeCalls = [], hostCalls = [];
globalThis.fetch = async (u) => {
  u = String(u);
  if (u.includes('map-direction')) {
    const q = new URL(u).searchParams, opt = q.get('option') || 'trafast', route = {};
    const [sx, sy] = (q.get('start') || '').split(',').map(Number);
    routeCalls.push(q.get('start'));
    // v239: 530 한 번 뒤 정상 (127.77,37.77) · 늘 530 (127.78,37.78)
    if (q.get('start') === '127.77,37.77' && routeCalls.filter((s) => s === '127.77,37.77').length === 1) return new Response('error code: 1016', { status: 530 });
    if (q.get('start') === '127.78,37.78') return new Response('error code: 1016', { status: 530 });
    // v269 다른 주소로 묻기: 127.79 = maps 주소만 530 (naveropenapi 주소는 답함) · 127.76 = maps 530, naveropenapi 401 (키 안 받음)
    const host = new URL(u).hostname;
    hostCalls.push(host + ' ' + q.get('start'));
    if (q.get('start') === '127.79,37.79' && host === 'maps.apigw.ntruss.com') return new Response('error code: 1016', { status: 530 });
    if (q.get('start') === '127.76,37.76') return host === 'maps.apigw.ntruss.com' ? new Response('error code: 1016', { status: 530 })
      : new Response(JSON.stringify({ error: { errorCode: '210', message: 'Permission Denied' } }), { status: 401 });
    // v215 자동 확인 길 검사: 바다(경도 129.6 넘게)는 네이버가 오류, 길 밖 시험 점(37.757,128.92)은 300m 떨어진 길로 붙임, 그 밖은 그 자리
    if (sx > 129.6) return new Response(JSON.stringify({ error: { errorCode: '400', message: 'bad start' } }), { status: 400 });
    let r1 = ROUTE1;
    if (q.get('start') !== '127.1,37.5') {
      const snap = Math.abs(sy - 37.757) < 0.001 && Math.abs(sx - 128.92) < 0.001 ? [sx, sy + 0.0027] : [sx, sy];
      r1 = Object.assign({}, ROUTE1, { path: [snap, [sx + 0.001, sy + 0.002]] });
    }
    opt.split(':').forEach((o) => { route[o] = [r1]; });
    return new Response(JSON.stringify({ code: 0, route }), { status: 200 });
  }
  if (u.includes('driver_spots.json')) return new Response(JSON.stringify({ v: 1, rows: [[37.9, 127.9, 90, 60, 60, 3, 2]] }), { status: 200 });
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
// v225: 의견 녹음 — 누구나 하나 올리고(400KB), 같은 qid 는 덮어쓰고, 듣기는 운영자만. 위치는 받지 않는다
{
  const a1 = await call('POST', '/fb', { body: { qid: 'abc-123', mime: 'audio/webm;codecs=opus', sec: 6, v: 't', sid: 's', b64: 'AAAA', lat: 37.5, lng: 127 }, ip: '8.8.1.1' });
  ok(a1.s === 200 && a1.j.id === 'abc-123', 'POST /fb without token → stored under its qid');
  const a2 = await call('POST', '/fb', { body: { qid: 'abc-123', mime: 'audio/webm', sec: 6, b64: 'BBBB' }, ip: '8.8.1.1' });
  ok(a2.s === 200 && a2.j.id === 'abc-123', 'the same qid again overwrites (a retry stays one recording)');
  ok((await call('GET', '/fb?id=abc-123')).s === 401 && (await call('GET', '/fb')).s === 401, 'listening to /fb needs the operator token');
  const g = await call('GET', '/fb?id=abc-123', { token: TOKEN });
  ok(g.s === 200 && g.j.b64 === 'BBBB' && g.j.mime === 'audio/webm' && g.j.lat === undefined && g.j.lng === undefined, '/fb?id= with token → the audio, no position stored');
  const li = await call('GET', '/fb', { token: TOKEN });
  ok(li.s === 200 && li.j.ids.includes('abc-123'), '/fb with token lists ids');
  ok((await call('POST', '/fb', { body: { qid: 'q2', mime: 'text/plain', b64: 'AAAA' }, ip: '8.8.1.2' })).s === 400, '/fb rejects a non-audio type');
  ok((await call('POST', '/fb', { body: { qid: 'q3', mime: 'audio/webm', b64: 'x'.repeat(410000) }, ip: '8.8.1.3' })).s === 413, '/fb over 400KB → 413');
  const xt = await call('POST', '/fb', { body: { qid: 'q4', mime: 'audio/webm', b64: 'AAAA', x: 1 }, ip: '8.8.1.4' });
  ok(xt.s === 200 && xt.j.dropped === 'test' && (await call('GET', '/fb?id=q4', { token: TOKEN })).s === 404, 'a test recording (x) is answered but not stored');
  const dv = await call('POST', '/fb', { body: { qid: 'q5', mime: 'audio/webm', b64: 'AAAA' }, ip: '8.8.1.5', origin: 'http://localhost:8765' });
  ok(dv.s === 200 && dv.j.dropped === 'dev', 'a recording from a localhost page is answered but not stored');
}
// v291 받아쓰기: 바인딩이 없으면 503·/health stt false, 있으면 {text} (Whisper 에 ko, 저장 안 함), 출처·크기·종류 검사
{
  const wav = 'U'.repeat(4000);
  ok((await call('GET', '/health')).j.stt === false, '/health stt false without the AI binding');
  ok((await call('POST', '/stt', { body: { b64: wav, mime: 'audio/wav' }, ip: '8.8.2.1' })).s === 503, '/stt without the AI binding → 503');
  const seen = [];
  const eAI = Object.assign({}, env, { AI: { run: async (m, inp) => { seen.push({ m, lang: inp.language, n: inp.audio.length }); return { text: '  여기 카메라 위치가 \n 틀려요 ' }; } } });
  ok((await call('GET', '/health', { e: eAI })).j.stt === true, '/health stt true with the AI binding');
  const r1 = await call('POST', '/stt', { body: { b64: wav, mime: 'audio/wav', sec: 4 }, ip: '8.8.2.2', e: eAI });
  ok(r1.s === 200 && r1.j.text === '여기 카메라 위치가 틀려요' && seen.length === 1 && seen[0].m === '@cf/openai/whisper-large-v3-turbo' && seen[0].lang === 'ko' && seen[0].n === 4000,
    '/stt → Whisper turbo with language ko, text trimmed to one line');
  ok((await call('POST', '/stt', { body: { b64: wav, mime: 'text/plain' }, ip: '8.8.2.3', e: eAI })).s === 400, '/stt rejects a non-audio type');
  ok((await call('POST', '/stt', { body: { b64: 'U'.repeat(1400001), mime: 'audio/wav' }, ip: '8.8.2.4', e: eAI })).s === 413, '/stt over 1.4MB → 413');
  ok((await call('POST', '/stt', { body: { b64: wav, mime: 'audio/wav' }, ip: '8.8.2.5', e: eAI, origin: 'https://evil.example' })).s === 403, '/stt from another site → 403');
  ok((await call('GET', '/stt', { ip: '8.8.2.6', e: eAI })).s === 405, 'GET /stt → 405');
  const eBad = Object.assign({}, env, { AI: { run: async () => { throw new Error('model busy'); } } });
  ok((await call('POST', '/stt', { body: { b64: wav, mime: 'audio/wav' }, ip: '8.8.2.7', e: eBad })).s === 502, '/stt model failure → 502 (the app falls back to a recording)');
  ok(!(await LOGS.list({ prefix: '' })).keys.some((k) => /stt/i.test(k.name)), '/stt stores nothing');
}
await call('POST', '/event', { body: { type: 'warn', msg: 'pub', trace: [[0, 37, 127]] } });
await call('POST', '/event', { body: { type: 'warn', msg: 'op', trace: [[0, 37, 127]] }, token: TOKEN });
const ev = (await call('GET', '/events', { token: TOKEN })).j.items;
{
  // v293: 관리 화면·모니터가 /events 를 자주 불러도 목록은 60초에 한 번 (이 인스턴스가 새 기록을 쓰면 바로 새로)
  const lc0 = kvCount.list;
  await call('GET', '/events', { token: TOKEN }); await call('GET', '/events?since=1', { token: TOKEN });
  ok(kvCount.list === lc0, 'v293: repeated /events within 60 s reuse one KV list()');
  await call('POST', '/event', { body: { type: 'info', msg: 'v293 fresh', sid: 's1', v: 'x' } });
  const again = (await call('GET', '/events', { token: TOKEN })).j.items;
  ok(kvCount.list === lc0 + 1 && again.some((x) => x.msg === 'v293 fresh'), 'v293: a new event from this instance is listed at once');
}
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
{
  // v239: 길찾기 위쪽이 잠깐 530 이면 Worker 가 다시 묻는다
  const n0 = routeCalls.length;
  const b1 = await call('GET', '/route?start=127.77,37.77&goal=127.2,37.6&option=trafast', { ip: '100.64.7.1' });
  ok(b1.s === 200 && routeCalls.length - n0 === 2, 'upstream 530 once → retried → 200');
  const n1 = routeCalls.length;
  const b2 = await call('GET', '/route?start=127.78,37.78&goal=127.2,37.6&option=trafast', { ip: '100.64.7.2' });
  ok(b2.s === 502 && b2.j.error === 'upstream' && b2.j.status === 530 && routeCalls.length - n1 === 4, 'upstream 530 every time (both hosts) → 3 tries + 1 on the other host → 502 upstream');
  // v269: 다른 주소가 답하면 그 답, 다른 주소가 키를 안 받으면(401) 처음 오류 그대로
  const h0 = hostCalls.length;
  const b4 = await call('GET', '/route?start=127.79,37.79&goal=127.2,37.6&option=trafast', { ip: '100.64.7.4' });
  const hs = hostCalls.slice(h0);
  ok(b4.s === 200 && hs.length === 4 && hs.slice(0, 3).every((x) => x.startsWith('maps.apigw.ntruss.com')) && hs[3].startsWith('naveropenapi.apigw.ntruss.com'),
    'maps host 530 three times → naveropenapi host answers → 200 (' + hs.length + ' calls)');
  const b5 = await call('GET', '/route?start=127.76,37.76&goal=127.2,37.6&option=trafast', { ip: '100.64.7.5' });
  ok(b5.s === 502 && b5.j.error === 'upstream' && b5.j.status === 530, 'other host 401 → the first 530 error unchanged (502 upstream 530)');
  const b3 = await call('GET', '/route?start=127.78,37.78&goal=127.2,37.6&options=traoptimal:trafast', { ip: '100.64.7.3' });
  ok(b3.s === 404 && b3.j.error === 'no route' && b3.j.code == null, 'multi-option call with a dead upstream → no route without a Naver code (the app treats it as upstream)');
}
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
  // (4b) v219: 시험 페이지에서 만든 기록(x)과 오늘보다 뒤 날짜(가짜 시계)는 버린다 — 2026-11-24 운영 통계에 시험 기록이 섞였다
  {
    const sum0 = rows('SELECT SUM(n) AS n FROM cam_day')[0].n, rec0 = rows('SELECT COUNT(*) AS n FROM pass_rec')[0].n;
    const tomorrow = kst(Date.now() + DAY);
    await call('POST', '/pass', { body: { items: [it(K2, { x: 1, a: 300 }), it(K2, { d: tomorrow, a: 300 })],
      cand: [{ c: '37420,127120', o: 1, dr: 30, d: today(), x: 1 }, { c: '37430,127130', o: 1, dr: 30, d: tomorrow }] }, e: envS });
    ok(rows('SELECT SUM(n) AS n FROM cam_day')[0].n === sum0 && rows('SELECT COUNT(*) AS n FROM pass_rec')[0].n === rec0 &&
      rows("SELECT COUNT(*) AS n FROM cand_day WHERE cell IN ('37420,127120', '37430,127130')")[0].n === 0 && !rows('SELECT day FROM cam_day').some((r) => r.day > today()),
      'items marked as made on the test page, and items dated after today, are dropped (passes and candidate cells)');
    const tx = await call('POST', '/trip', { body: { rid: 'testpage000x1', x: 1, d: today(), pts: [[0, 3727000, 12710576, 60, 180], [5, 3727010, 12710576, 60, 180]] }, e: envS });
    ok(tx.s === 200 && tx.j.dropped === 'test' && rows("SELECT COUNT(*) AS n FROM trips WHERE rid = 'testpage000x1'")[0].n === 0, 'a trip marked as made on the test page is answered but not stored');
    // 이 컴퓨터(localhost)에서 연 개발용 페이지가 보낸 것: 받은 것으로 답하고 저장하지 않는다 (운영자 토큰이면 저장)
    const dv = await call('POST', '/pass', { body: { items: [it(K2, { a: 300 })] }, origin: 'http://localhost:8765', e: envS });
    const dt = await call('POST', '/trip', { body: { rid: 'devpage0000001', d: today(), pts: [[0, 3727000, 12710576, 60, 180], [5, 3727010, 12710576, 60, 180]] }, origin: 'http://127.0.0.1:8765', e: envS });
    ok(dv.s === 200 && dv.j.dropped === 'dev' && dt.j.dropped === 'dev' && rows('SELECT SUM(n) AS n FROM cam_day')[0].n === sum0 &&
      rows("SELECT COUNT(*) AS n FROM trips WHERE rid = 'devpage0000001'")[0].n === 0, 'passes and trips from a localhost page are answered but not stored');
  }
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
  // (7) v198 통과 한 건씩 (pass_rec): 판정·경고 거리·앱 버전, 주행 번호·위치·시각 칸은 없다
  await call('POST', '/pass', { body: { v: '2026.11.16-198', items: [it(K2, { a: 350, lim: 50, kind: 1 })] }, e: envS });
  const recs = rows('SELECT * FROM pass_rec');
  const cols = (tb) => db.prepare('PRAGMA table_info(' + tb + ')').all().map((c) => c.name).join(',');
  ok(recs.some((r) => r.cam === K1 && r.res === 'alert' && r.a === 400) && recs.some((r) => r.res === 'miss') && recs.some((r) => r.res === 'hidden') &&
    recs.some((r) => r.res === 'cover') && recs.some((r) => r.cam === K2 && r.v === '2026.11.16-198' && r.a === 350 && r.kmh === 60),
    'each pass kept in pass_rec with its verdict, card distance, speed and app version');
  ok(cols('pass_rec') === 'id,day,cam,v,lim,kind,a,g,hid,kmh,nav,res,flag,at', 'pass_rec has no trip id, session, device or position column (v235: a time column, kept 30 days)');
  // v235: 지난 시각 — 분 단위로 뭉개고, 지금에서 많이 먼 값은 비운다. 카메라마다 최근 통과(운영자만)
  const K3 = '37.4001,127.1002|0', tNow = Date.now();
  await call('POST', '/pass', { body: { v: '2026.11.16-235', items: [it(K3, { a: 420, t: tNow - 3 * 3600e3 + 12345 }), it(K3, { a: 0, t: tNow - 600e3 }),
    it(K3, { a: 300, t: tNow + 3600e3 }), it(K3, { a: 280, t: tNow - 9 * 86400e3 }), it(K3, { a: 250, sid: 'sx', dev: 'dx' })] }, e: envS });
  const r3 = rows('SELECT at FROM pass_rec WHERE cam = ? ORDER BY id', K3).map((x) => x.at);
  ok(r3[0] === Math.round((tNow - 3 * 3600e3 + 12345) / 60000) * 60000 && r3[1] === Math.round((tNow - 600e3) / 60000) * 60000 && r3[2] === null && r3[3] === null && r3[4] === null,
    'a pass time is kept to the minute; one in the future, days old or missing is stored empty');
  ok((await call('GET', '/passes?cam=' + encodeURIComponent(K3))).s === 401, '/passes?cam= needs the operator token');
  ok((await call('GET', '/passes?cam=bad', { token: TOKEN, e: envS })).s === 400, '/passes?cam= with a bad key → 400');
  const pc = (await call('GET', '/passes?cam=' + encodeURIComponent(K3), { token: TOKEN, e: envS })).j;
  ok(pc.cam === K3 && pc.keepTimeDays === 30 && pc.passes.length === 5 && pc.passes[0].at === r3[1] && pc.passes[1].at === r3[0] && pc.passes[0].res === 'miss' && pc.passes[1].res === 'alert' &&
    pc.passes[1].a === 420 && pc.passes[1].kmh === 60 && pc.passes[1].v === '2026.11.16-235' && pc.passes[4].at === null &&
    !pc.passes.some((x) => 'sid' in x || 'dev' in x || 'lat' in x || 'rid' in x), "/passes?cam= gives that camera's passes newest first: time, result, alert distance, speed, nav, version — no session, device, trip or position");
  for (let i = 0; i < 60; i++) await call('POST', '/pass', { body: { items: [it(K3, { a: 100, t: tNow - i * 1000 })] }, e: envS, ip: '10.1.' + i + '.1' });
  ok((await call('GET', '/passes?cam=' + encodeURIComponent(K3), { token: TOKEN, e: envS })).j.passes.length === 50, '/passes?cam= gives at most 50');
  // v236: 그 카메라의 접근로를 달리지 않은 통과 (o 1 꺾어 들어옴 · 2 나란한 다른 길) 는 '경고 없음'이 아니다
  const K4 = '37.4101,127.1202|6';
  await call('POST', '/pass', { body: { items: [it(K4, { a: 0, o: 1 }), it(K4, { a: 0, o: 2 }), it(K4, { a: 0 }), it(K4, { a: 0, o: 9 })] }, e: envS });
  const r4 = rows('SELECT res FROM pass_rec WHERE cam = ? ORDER BY id', K4).map((x) => x.res).join();
  const cd4 = rows('SELECT SUM(n) AS n, SUM(missed) AS missed, SUM(other) AS other FROM cam_day WHERE cam = ?', K4)[0];
  ok(r4 === 'turned,other,miss,miss' && cd4.n === 4 && cd4.missed === 2 && cd4.other === 2, "a pass that turned in or ran on another road is 'turned' / 'other', counted apart from misses (a bad o is a plain miss)");
  const pl4 = (await call('GET', '/passes?days=7', { token: TOKEN, e: envS })).j.cams.find((x) => x.k === K4);
  ok(pl4 && pl4.missed === 2 && pl4.other === 2, '/passes gives other next to missed');
  // (8) v198 테스터 주행 경로: 무작위 주행 번호, 출발부터 도착까지 그대로, 조각으로
  const RID = 'abc123def456ghi7';
  const P = Array.from({ length: 30 }, (_, i) => [i * 5, 3727000 + i * 10, 12710576, 60, 180]);
  ok((await call('POST', '/trip', { body: { rid: 'BAD!', pts: P }, e: envS })).s === 400, '/trip with a bad trip id → 400');
  const camT = (o) => Object.assign({ s: 50, k: K1, lim: 60, kind: 3, a: 0, g: 0, hid: 0, kmh: 60, nav: 0, minD: 3 }, o);
  const nRec0 = rows('SELECT COUNT(*) AS n FROM pass_rec')[0].n;
  const T0 = Date.now() - 600000;   // v231: 조각 첫 점 시각
  const t1 = await call('POST', '/trip', { body: { rid: RID, part: 0, d: today(), v: '2026.11.16-198', ps: 1, pts: P.concat([[150, 100, 100, 0, 0]]), cams: [camT({})], sid: 'sess0002', t0: T0, ua: 'X11 leak', dev: 'devleak1' }, e: envS });
  ok(t1.s === 200 && t1.j.ok && t1.j.stored === 30 && rows('SELECT COUNT(*) AS n FROM pass_rec')[0].n === nRec0, '/trip stores a part (bad points dropped); passes already sent by /pass are not counted twice');
  await call('POST', '/trip', { body: { rid: RID, part: 1, d: today(), end: 1, ps: 0, pts: P.map((q) => [q[0] + 200, q[1] + 400, q[2], q[3], q[4]]), cams: [camT({ s: 230, a: 300 })], sid: 'BAD SID!', t0: Date.now() - 9 * 86400000 }, e: envS });
  ok(rows('SELECT COUNT(*) AS n FROM pass_rec')[0].n === nRec0 + 1, 'a car with pass statistics off: its route passes go to pass_rec at once');
  // v235: 그 통과의 시각 = 조각 t0 - 첫 점의 출발 뒤 초 + 카메라의 출발 뒤 초
  await call('POST', '/trip', { body: { rid: 'tripat000001', part: 0, d: today(), end: 1, ps: 0, t0: T0, pts: P.map((q) => [q[0] + 100, q[1], q[2], q[3], q[4]]), cams: [camT({ s: 130, k: K2 })] }, e: envS });
  const lastRec = rows('SELECT at FROM pass_rec ORDER BY id DESC LIMIT 1')[0];
  ok(lastRec.at === Math.round((T0 - 100 * 1000 + 130 * 1000) / 60000) * 60000, 'a route pass from a car with statistics off gets its time from the part start (t0)');
  // v231 (운전자 '접속만 잇기 (A)'): 접속 번호(sid)와 조각 첫 점 시각(t0)은 남긴다. 기기 번호·브라우저·IP 는 여전히 없다
  ok(cols('trips') === 'id,day,rid,part,endf,op,v,n,km,ncam,misses,pts,cams,sid,t0' && !/leak|devleak1/.test(JSON.stringify(rows('SELECT * FROM trips'))),
    'trips keep the session id and start time, but no device id, browser or IP');
  const tp = rows('SELECT part, sid, t0 FROM trips WHERE rid = ? ORDER BY part', RID);
  ok(tp[0].sid === 'sess0002' && tp[0].t0 === T0 && tp[1].sid === null && tp[1].t0 === null, 'a malformed session id or a start time days away is stored empty');
  ok((await call('GET', '/trips')).s === 401, '/trips without token → 401');
  const tl = (await call('GET', '/trips?days=7', { token: TOKEN, e: envS })).j;
  const tr = tl.trips.find((x) => x.rid === RID);
  ok(tl.keepDays === 30 && tr && tr.parts === 2 && tr.n === 60 && tr.misses === 1 && tr.km > 0.2 && tr.ended === 1, '/trips lists a trip with parts, points, km and misses');
  ok(tr.sids === 'sess0002' && tr.t0 === T0 && !('dev' in tr), '/trips gives the session ids (sids) and the earliest start time (t0), no device id');
  const td = (await call('GET', '/trips?rid=' + RID, { token: TOKEN, e: envS })).j;
  ok(td.parts.length === 2 && td.parts[0].pts[0][1] === 3727000 && td.parts[0].pts.length === 30 && td.parts[1].cams[0].a === 300, '/trips?rid gives the whole route from its start, with camera marks');
  ok(td.parts[0].sid === 'sess0002' && td.parts[0].t0 === T0 && td.parts[1].sid === null, '/trips?rid gives each part its session id and start time');
  // (9) 넘긴 내역: 운영자만, 근거가 있어야
  ok((await call('POST', '/handoff', { body: { items: [{ kind: 'fix', lat: 37.3, lng: 127.1, basis: 'x' }] } })).s === 401, '/handoff without token → 401');
  const ho = await call('POST', '/handoff', { body: { items: [{ kind: 'fix', lat: 37.3066, lng: 127.10576, h: 180, cam: K1, ref: 'trip ' + RID, basis: '경로에서 경고 없이 지남 2번, 60km/h' },
    { kind: 'bad', lat: 37.3, lng: 127.1, basis: 'x' }, { kind: 'spot', lat: 37.3, lng: 127.1 }] }, token: TOKEN, e: envS });
  const hl = (await call('GET', '/passes?days=7', { token: TOKEN, e: envS })).j.handoff;
  ok(ho.j.added === 1 && hl.length === 1 && hl[0].cam === K1 && hl[0].h === 180 && /경고 없이/.test(hl[0].basis), 'handoff stored with place, direction and basis; bad ones dropped');
  // (10) 보관: 경로 원본 30일, 운영자 차 90일 (그날 첫 요청 때 지움). 통과 기록·합계·후보·넘긴 내역은 계속
  const keep = () => ['pass_rec', 'cam_day', 'cand_day', 'handoff'].map((tb) => rows('SELECT COUNT(*) AS n FROM ' + tb)[0].n);
  const k0 = keep();
  shift += 31 * DAY;
  await call('POST', '/pass', { body: { items: [] }, e: envS });
  ok(rows('SELECT COUNT(*) AS n FROM trips')[0].n === 0 && rows('SELECT COUNT(*) AS n FROM op_pass')[0].n > 0 && keep().join() === k0.join(),
    'after 31 days the raw routes are gone; operator rows, pass records, totals, cells and handoffs kept');
  ok(rows('SELECT COUNT(*) AS n FROM pass_rec WHERE at IS NOT NULL')[0].n === 0, 'after 31 days the pass times are cleared (the pass records stay)');
  ok((await call('GET', '/trips?rid=' + RID, { token: TOKEN, e: envS })).j.parts.length === 0, 'an old route is not served');
  shift += 70 * DAY;
  await call('POST', '/pass', { body: { items: [] }, e: envS });
  ok(rows('SELECT COUNT(*) AS n FROM op_pass')[0].n === 0 && keep().join() === k0.join(), 'after 100 days operator rows are gone; the rest kept');
  shift = 0;
}

// ---------------- v202 실시간 신고 확인 (/check · /check/status · /check/next · /check/result · /check/unmatched) ----------------
{
  const job = (id, dev, o) => Object.assign({ id, dev, lat: 37.699451, lng: 127.124144, h: 146, kmh: 58, v: '2026.11.16-202', trail: [[37.69, 127.12], [37.695, 127.122]] }, o || {});
  const lc0 = kvCount.list;
  const q1 = await call('POST', '/check', { body: job('rq0000000001', 'devaaaaaaaa1') });
  ok(q1.s === 200 && q1.j.ok && q1.j.id === 'rq0000000001' && kv.has('chkpend'), 'POST /check queues a report and sets the pending flag');
  ok(kvCount.list === lc0, 'v293: POST /check makes no KV list() (free plan: 1,000 a day)');
  const qk = [...kv.keys()].find((k) => k.startsWith('chkq:0:'));
  ok(qk && JSON.parse(kv.get(qk)).trail.length === 0, 'public report keeps no trail (operator car only)');
  ok((await call('POST', '/check', { body: job('bad id!', 'devaaaaaaaa1') })).s === 400 && (await call('POST', '/check', { body: job('rq0000000002', 'devaaaaaaaa1', { lat: 1 }) })).s === 400,
    'bad id or outside Korea → 400');
  ok((await call('GET', '/check/status?ids=rq0000000001,nothere00001')).j.items.rq0000000001.st === 'queued', '/check/status: queued');
  ok((await call('GET', '/check/next')).s === 401, '/check/next without token → 401');
  const n1 = await call('GET', '/check/next', { token: TOKEN, origin: '' });
  ok(n1.s === 200 && n1.j.job.id === 'rq0000000001' && n1.j.job.kind === 'user' && n1.j.job.heading === 146 && n1.j.job.kmh === 58, '/check/next (operator tool, no Origin) gives the job');
  ok(![...kv.keys()].some((k) => k.startsWith('chkq:')) && (await call('GET', '/check/status?ids=rq0000000001')).j.items.rq0000000001.st === 'checking', 'taken off the queue, now checking');
  ok((await call('GET', '/check/next', { token: TOKEN, origin: '' })).s === 204, 'empty queue (no stats) → 204');
  {
    // v293: 대기열이 비고 표시가 2분 넘게 묵으면 표시를 지우고, 그 뒤 /check/next 는 목록을 부르지 않는다
    shift += 3 * 60000;
    await call('GET', '/check/next', { token: TOKEN, origin: '' });
    ok(!kv.has('chkpend'), 'v293: an empty queue clears the stale pending flag');
    const lc1 = kvCount.list;
    for (let i = 0; i < 5; i++) await call('GET', '/check/next', { token: TOKEN, origin: '' });
    ok(kvCount.list === lc1, 'v293: /check/next without the pending flag makes no KV list()');
    shift -= 3 * 60000;
  }
  // 네이버에 있음 → 모든 사용자 신고 지점(제한·종류)으로
  const r1 = await call('POST', '/check/result', { token: TOKEN, origin: '', body: { id: 'rq0000000001', status: 'found', run: 'emu1',
    cams: [{ lat: 37.6995, lng: 127.1241, heading: 146, limit: 60, kind: '신호과속', rel: -20, shots: 2, evidence: 'a.png' }, { lat: 37.7, lng: 127.12, limit: 0, kind: '표지판 확인' }] } });
  ok(r1.s === 200 && r1.j.applied === 1, "found: one camera applied ('표지판 확인' without a limit is not)");
  const sp = (await pub()).find((x) => x.kind === 'spot' && Math.abs(x.lat - 37.6995) < 1e-6);
  ok(sp && sp.lim === 60 && sp.ck === 3 && sp.src === 'op' && sp.h === 146, '/fixes now lists it for everyone: limit 60, signal+speed, operator');
  const s1 = (await call('GET', '/check/status?ids=rq0000000001')).j.items.rq0000000001;
  ok(s1.st === 'found' && s1.cams.length === 1 && s1.cams[0].limit === 60 && s1.cams[0].kind === '신호과속', 'status: found with what was added');
  // 네이버에도 없음: 서로 다른 기기 2대 → 후보 (앱에는 반영하지 않음)
  for (const [id, dev] of [['rq0000000003', 'devbbbbbbbb1'], ['rq0000000004', 'devcccccccc1']]) {
    await call('POST', '/check', { body: job(id, dev, { lat: 37.5, lng: 127.05, h: 92 }) });
    await call('GET', '/check/next', { token: TOKEN, origin: '' });
    await call('POST', '/check/result', { token: TOKEN, origin: '', body: { id, status: 'none' } });
  }
  const um = (await call('GET', '/check/unmatched', { token: TOKEN })).j.items;
  ok(um.length === 1 && um[0].n === 2 && um[0].devices === 2 && um[0].days === 1 && um[0].candidate && um[0].dir === 90 && um[0].cell === '37500,127050',
    '/check/unmatched: same 100 m cell and direction from 2 devices → candidate');
  ok((await call('GET', '/check/unmatched')).s === 401 && (await call('GET', '/check/results')).s === 401, 'unmatched and results need the token');
  ok(!(await pub()).some((x) => Math.abs(x.lat - 37.5) < 0.001 && Math.abs(x.lng - 127.05) < 0.001), "'none' adds nothing for users");
  ok((await call('GET', '/check/status?ids=rq0000000003')).j.items.rq0000000003.st === 'none', 'status: none');
  const rs = (await call('GET', '/check/results', { token: TOKEN })).j.items;
  ok(rs.length === 3 && rs.every((x) => !('dev' in x)), '/check/results lists results without device ids');
  ok((await call('POST', '/check/result', { token: TOKEN, origin: '', body: { id: 'rq0000000005', status: 'maybe' } })).s === 400, 'bad status → 400');
  // 자동 확인: 통과 통계에서 경고 없이 3일 넘게 지난 카메라를 낮은 순위로, 7일에 한 번
  if (sqlite) {
    const db2 = new sqlite.DatabaseSync(':memory:');
    const st2 = (sql, args) => ({ bind: (...a) => st2(sql, a), run: async () => { db2.prepare(sql).run(...(args || [])); return { success: true }; },
      all: async () => ({ results: db2.prepare(sql).all(...(args || [])) }), first: async () => db2.prepare(sql).get(...(args || [])) || null,
      _sync: () => (/^\s*select/i.test(sql) ? db2.prepare(sql).all(...(args || [])) : db2.prepare(sql).run(...(args || []))) });
    const S2 = { prepare: (sql) => st2(sql), batch: async (list) => { db2.exec('BEGIN'); try { const r = list.map((x) => x._sync()); db2.exec('COMMIT'); return r; } catch (e) { db2.exec('ROLLBACK'); throw e; } } };
    const envA = { ...env, STATS: S2 };
    // (Worker 는 표를 한 번만 만든다 — 앞 시험의 D1 에서 이미 만들었으므로 여기서는 같은 표를 직접)
    db2.exec('CREATE TABLE cam_day (day TEXT NOT NULL, cam TEXT NOT NULL, lim INTEGER, kind INTEGER, n INTEGER NOT NULL DEFAULT 0, alerted INTEGER NOT NULL DEFAULT 0, ' +
      'covered INTEGER NOT NULL DEFAULT 0, missed INTEGER NOT NULL DEFAULT 0, hidden INTEGER NOT NULL DEFAULT 0, flagged INTEGER NOT NULL DEFAULT 0, navn INTEGER NOT NULL DEFAULT 0, ' +
      'over INTEGER NOT NULL DEFAULT 0, adist INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, cam))');
    const kday = (d) => new Date(Date.now() + 9 * 3600e3 - d * 86400000).toISOString().slice(0, 10);
    for (const d of [1, 2, 3]) db2.prepare('INSERT INTO cam_day (day, cam, lim, kind, n, missed) VALUES (?, ?, 50, 3, 1, 1)').run(kday(d), '37.52116,127.1338|7');
    db2.prepare('INSERT INTO cam_day (day, cam, lim, kind, n, alerted) VALUES (?, ?, 60, 1, 5, 5)').run(kday(1), '37.4,127.1|2');
    await call('POST', '/check', { body: job('rq0000000006', 'devdddddddd1'), e: envA });
    const u1 = await call('GET', '/check/next', { token: TOKEN, origin: '', e: envA });
    const a1 = await call('GET', '/check/next', { token: TOKEN, origin: '', e: envA });
    ok(u1.j.job.kind === 'user' && a1.s === 200 && a1.j.job.kind === 'auto' && a1.j.job.cam === '37.52116,127.1338|7' && a1.j.job.heading === 315 && a1.j.job.trail.length === 2 && a1.j.job.missDays === 3,
      'user reports first, then an auto check of a camera passed without a warning on 3 days');
    ok((await call('GET', '/check/next', { token: TOKEN, origin: '', e: envA })).s === 204, 'the same camera is not auto-checked again within 7 days');
    await call('POST', '/check/result', { token: TOKEN, origin: '', e: envA, body: { id: a1.j.job.id, status: 'none' } });
    ok((await call('GET', '/check/unmatched', { token: TOKEN, e: envA })).j.items.length === 1, "an auto check's 'none' is not added to the unmatched list");
    // v215: 바다(울진 앞바다)·길 밖(300m) 후보는 넣지 않고 30일 표시, 운전자 확인 지점 100m 안은 길 검사 없이, 길 위 후보는 넣는다
    for (const d of [1, 2, 3]) {
      for (const cam of ['36.918,129.7|x', '37.757,128.92|4', '37.9004,127.9|2', '37.31,127.05|0']) {
        db2.prepare('INSERT INTO cam_day (day, cam, lim, kind, n, missed) VALUES (?, ?, 60, 1, 1, 1)').run(kday(d), cam);
      }
    }
    routeCalls.length = 0;
    const got = [];
    for (let k = 0; k < 4; k++) {
      const a = await call('GET', '/check/next', { token: TOKEN, origin: '', e: envA });
      if (a.s === 200) got.push(a.j.job.cam);
    }
    ok(got.length === 2 && got.includes('37.9004,127.9|2') && got.includes('37.31,127.05|0'),
      'auto check: the point at sea and the point 300 m off the road are not queued; near a driver spot and on a road are (' + got.join(' ') + ')');
    ok(kv.has('chkx:36.918,129.7|x') && kv.has('chkx:37.757,128.92|4') && !kv.has('chka:36.918,129.7|x') && !kv.has('chkx:37.31,127.05|0'),
      'off-road keys are marked for 30 days (chkx), not as checked');
    ok(!routeCalls.includes('127.9,37.9004'), 'a key within 100 m of a driver spot needs no route call');
    const before = routeCalls.length;
    ok((await call('GET', '/check/next', { token: TOKEN, origin: '', e: envA })).s === 204 && routeCalls.length === before, 'skipped keys are not probed again');
  }
}

// ---------------- v231 예전 trips 표(sid·t0 없음)에 칸을 더한다 ----------------
if (sqlite) {
  const tmp3 = path.join(os.tmpdir(), 'tnc-worker-mig-' + process.pid + '.mjs');
  fs.writeFileSync(tmp3, fs.readFileSync(src, 'utf8'));
  const W3 = (await import(pathToFileURL(tmp3).href)).default;   // 새 모듈 = 표를 아직 안 만든 Worker
  fs.unlinkSync(tmp3);
  const db3 = new sqlite.DatabaseSync(':memory:');
  db3.exec('CREATE TABLE trips (id INTEGER PRIMARY KEY AUTOINCREMENT, day TEXT NOT NULL, rid TEXT NOT NULL, part INTEGER NOT NULL, endf INTEGER NOT NULL, ' +
    'op INTEGER NOT NULL, v TEXT, n INTEGER NOT NULL, km REAL NOT NULL, ncam INTEGER NOT NULL, misses INTEGER NOT NULL, pts TEXT NOT NULL, cams TEXT NOT NULL)');
  const kd = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  db3.prepare("INSERT INTO trips (day, rid, part, endf, op, v, n, km, ncam, misses, pts, cams) VALUES (?, 'oldtrip000001', 0, 1, 0, 'v', 1, 0.1, 0, 0, '[]', '[]')").run(kd);
  // v236: 예전 cam_day (other 없음)
  db3.exec('CREATE TABLE cam_day (day TEXT NOT NULL, cam TEXT NOT NULL, lim INTEGER, kind INTEGER, n INTEGER NOT NULL DEFAULT 0, alerted INTEGER NOT NULL DEFAULT 0, ' +
    'covered INTEGER NOT NULL DEFAULT 0, missed INTEGER NOT NULL DEFAULT 0, hidden INTEGER NOT NULL DEFAULT 0, flagged INTEGER NOT NULL DEFAULT 0, navn INTEGER NOT NULL DEFAULT 0, ' +
    'over INTEGER NOT NULL DEFAULT 0, adist INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, cam))');
  // v235: 예전 pass_rec (at 없음)
  db3.exec('CREATE TABLE pass_rec (id INTEGER PRIMARY KEY AUTOINCREMENT, day TEXT NOT NULL, cam TEXT NOT NULL, v TEXT, lim INTEGER, kind INTEGER, ' +
    'a INTEGER NOT NULL, g INTEGER NOT NULL, hid INTEGER NOT NULL, kmh INTEGER, nav INTEGER NOT NULL, res TEXT NOT NULL, flag INTEGER NOT NULL DEFAULT 0)');
  const st3 = (sql, args) => ({ bind: (...a) => st3(sql, a), run: async () => { db3.prepare(sql).run(...(args || [])); return { success: true }; },
    all: async () => ({ results: db3.prepare(sql).all(...(args || [])) }), first: async () => db3.prepare(sql).get(...(args || [])) || null,
    _sync: () => (/^\s*(select|pragma)/i.test(sql) ? db3.prepare(sql).all(...(args || [])) : db3.prepare(sql).run(...(args || []))) });
  const S3 = { prepare: (sql) => st3(sql), batch: async (list) => { db3.exec('BEGIN'); try { const r = list.map((x) => x._sync()); db3.exec('COMMIT'); return r; } catch (e) { db3.exec('ROLLBACK'); throw e; } } };
  const r3 = await W3.fetch(new Request('https://w.example/trip', { method: 'POST', headers: { Origin: O, 'CF-Connecting-IP': '10.9.9.9' },
    body: JSON.stringify({ rid: 'newtrip000001', part: 0, d: kd, sid: 'sess0003', t0: Date.now(), pts: [[0, 3727000, 12710576, 60, 180], [5, 3727010, 12710576, 60, 180]] }) }), { ...env, STATS: S3 });
  const c3 = db3.prepare('PRAGMA table_info(trips)').all().map((c) => c.name).join(',');
  const old3 = db3.prepare("SELECT sid, t0 FROM trips WHERE rid = 'oldtrip000001'").get(), new3 = db3.prepare("SELECT sid FROM trips WHERE rid = 'newtrip000001'").get();
  ok(r3.status === 200 && c3.endsWith(',sid,t0') && old3 && old3.sid === null && new3 && new3.sid === 'sess0003',
    'an old trips table gets the sid and t0 columns on the first request, old rows kept (empty), new rows filled');
  ok(db3.prepare('PRAGMA table_info(pass_rec)').all().map((c) => c.name).join(',').endsWith(',flag,at'), 'an old pass_rec table gets the at column');
  ok(db3.prepare('PRAGMA table_info(cam_day)').all().map((c) => c.name).join(',').endsWith(',adist,other'), 'an old cam_day table gets the other column');
}

// ---------------- v294 진단·신고 기록(/event · /events)을 D1 로 — 바로 답하고 뒤에서 쓰기, D1 실패면 KV evf:, 옮기기·지우기, 예전 KV 함께 읽기 ----------------
if (sqlite) {
  const dbE = new sqlite.DatabaseSync(':memory:');
  let insCalls = 0, mode = 'ok';
  const stE = (sql, args) => ({
    bind: (...a) => stE(sql, a),
    run: async () => {
      if (mode === 'fail') throw new Error('D1_ERROR: simulated outage');
      if (mode === 'slow') await new Promise((r) => setTimeout(r, 400));
      if (/INSERT OR IGNORE INTO events/.test(sql)) insCalls++;
      const r = dbE.prepare(sql).run(...(args || []));
      return { success: true, meta: { rows_read: 0, rows_written: Number(r.changes) || 0, changes: Number(r.changes) || 0 } };
    },
    all: async () => { if (mode === 'fail') throw new Error('D1_ERROR: simulated outage'); const rs = dbE.prepare(sql).all(...(args || [])); return { results: rs, meta: { rows_read: rs.length } }; },
    first: async () => dbE.prepare(sql).get(...(args || [])) || null,
    _sync: () => { if (mode === 'fail') throw new Error('D1_ERROR: simulated outage'); return /^\s*select/i.test(sql) ? dbE.prepare(sql).all(...(args || [])) : dbE.prepare(sql).run(...(args || [])); },
  });
  const SE = { prepare: (sql) => stE(sql), batch: async (list) => { if (mode === 'fail') throw new Error('D1_ERROR: simulated outage'); dbE.exec('BEGIN'); try { const r = list.map((x) => x._sync()); dbE.exec('COMMIT'); return r; } catch (e) { dbE.exec('ROLLBACK'); throw e; } } };
  const envE = { ...env, STATS: SE };
  const evRows = () => dbE.prepare('SELECT id, at, sid, type, msg, usr FROM events ORDER BY at').all();
  const kvKeys = (pre) => [...kv.keys()].filter((k) => k.startsWith(pre));
  const base = shift;
  // (a) D1 에 넣고, KV evr: 는 새로 쓰지 않는다. 같은 모양으로 읽힌다. 표·인덱스는 처음 쓸 때 저절로
  const evr0 = kvKeys('evr:').length;
  const a1 = await call('POST', '/event', { body: { type: 'warn', msg: 'd1 one', sid: 'sid00001', v: 'x', trace: [[0, 37, 127]] }, e: envE });
  const idx = dbE.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'events'").all().map((x) => x.name).filter((n) => n.startsWith('events_')).sort().join(',');
  ok(a1.s === 200 && a1.j.ok && evRows().some((r) => r.msg === 'd1 one' && r.sid === 'sid00001') && kvKeys('evr:').length === evr0 &&
    idx === 'events_at,events_sid_at,events_usr_at', 'v294: /event goes to the D1 events table (created on first use with indexes at, sid+at, usr+at), not to KV');
  // 옮기기 전에 KV 에 쓴 기록 (7일 동안 함께 읽는다)
  const oldAt = realNow() + base - 3600e3;
  kv.set('evr:' + String(9e15 - oldAt).padStart(16, '0') + ':oldkv1', JSON.stringify({ type: 'warn', msg: 'old kv record', sid: 'sid0000k', serverAt: oldAt }));
  shift = base + 31 * 60e3;   // 예전 evr: 목록은 30분 같은 것을 쓰므로 그 뒤에
  const g1 = (await call('GET', '/events', { token: TOKEN, e: envE })).j.items;
  const d1one = g1.find((x) => x.msg === 'd1 one');
  ok(d1one && d1one.serverAt && !('trace' in d1one) && g1.some((x) => x.msg === 'old kv record'), 'v294: /events reads D1 (same shape, public trace dropped) plus the older KV evr: records');
  // (b) 여러 건을 한 요청으로 → 한 문장
  const i0 = insCalls;
  shift = base + 1000;
  const b1 = await call('POST', '/event', { body: [{ type: 'info', msg: 'batch 1', sid: 'sid00002' }, { type: 'info', msg: 'batch 2', sid: 'sid00002' }, { type: 'user', msg: 'batch 3', sid: 'sid00002', user: true }], e: envE });
  ok(b1.s === 200 && insCalls - i0 === 1 && evRows().filter((r) => /^batch/.test(r.msg)).length === 3, 'v294: an array of events is inserted with one statement');
  const u1 = (await call('GET', '/events?user=1', { token: TOKEN, e: envE })).j.items;
  ok(u1.some((x) => x.msg === 'batch 3') && !u1.some((x) => x.msg === 'batch 1'), 'v294: /events?user=1 filters in D1');
  // (c) before 쪽 넘기기
  const t1 = base + 1000;
  shift = base + 5000;
  await call('POST', '/event', { body: { type: 'info', msg: 'later one', sid: 'sid00003' }, e: envE });
  const pg = (await call('GET', '/events?before=' + (realNow() + base + 3000) + '&limit=3', { token: TOKEN, e: envE })).j;
  ok(pg.items.length === 3 && pg.items.every((x) => x.serverAt < realNow() + base + 3000) && !pg.items.some((x) => x.msg === 'later one') && pg.oldest === pg.items[0].serverAt,
    'v294: before= paging works on D1 (older records, oldest for the next page)');
  // (d) D1 이 실패해도 기록은 KV evf: 로, /events 에 보인다
  mode = 'fail';
  shift = base + 9000;
  const f1 = await call('POST', '/event', { body: { type: 'warn', msg: 'during outage', sid: 'sid00004' }, e: envE });
  const fk = kvKeys('evf:');
  ok(f1.s === 200 && f1.j.ok && fk.length === 1 && JSON.parse(kv.get(fk[0])).msg === 'during outage', 'v294: D1 fails → the event is kept in KV evf: (7 days)');
  const g2 = (await call('GET', '/events', { token: TOKEN, e: envE })).j.items;
  ok(g2.some((x) => x.msg === 'during outage'), 'v294: /events shows the KV fallback record while D1 is down');
  // (e) D1 이 돌아오면 한 시간 안의 다음 쓰기에서 옮기고 지운다 (KV 목록은 한 시간에 한 번)
  mode = 'ok';
  shift = base + 2 * 3600e3;
  await call('POST', '/event', { body: { type: 'info', msg: 'after outage', sid: 'sid00005' }, e: envE });
  ok(kvKeys('evf:').length === 0 && !kv.has('evfpend') && evRows().some((r) => r.msg === 'during outage') && evRows().some((r) => r.msg === 'after outage'),
    'v294: once D1 works again the KV fallback is moved into D1 and deleted (and its flag cleared)');
  const g3 = (await call('GET', '/events?limit=200', { token: TOKEN, e: envE })).j.items;
  ok(g3.filter((x) => x.msg === 'during outage').length === 1, 'v294: the moved record shows once (no duplicate)');
  const lc = kvCount.list;
  shift = base + 2 * 3600e3 + 60e3;
  await call('POST', '/event', { body: { type: 'info', msg: 'no extra list', sid: 'sid00006' }, e: envE });
  ok(kvCount.list === lc, 'v294: no KV list() for the fallback check within the hour');
  const lc2 = kvCount.list;
  for (let k = 0; k < 4; k++) { shift = base + 2 * 3600e3 + 120e3 + k * 61e3; await call('GET', '/events', { token: TOKEN, e: envE }); }
  ok(kvCount.list - lc2 <= 1, 'v294: polling /events every minute makes at most one KV list() in 4 minutes (old evr: list kept 30 min, evf: only with its flag) — ' + (kvCount.list - lc2));
  // (f) D1 이 느려도 앱은 기다리지 않는다 (waitUntil)
  mode = 'slow';
  const waits = [];
  const ctx = { waitUntil: (pr) => waits.push(pr) };
  const tq = realNow();
  const rs = await W.fetch(new Request('https://w.example/event', { method: 'POST', headers: { Origin: O, 'CF-Connecting-IP': '10.7.7.7' }, body: JSON.stringify({ type: 'info', msg: 'slow d1', sid: 'sid00007' }) }), envE, ctx);
  const dt = realNow() - tq;
  ok(rs.status === 200 && dt < 200 && waits.length === 1 && !evRows().some((r) => r.msg === 'slow d1'), 'v294: /event answers at once (' + dt + ' ms) while the D1 write waits in ctx.waitUntil');
  await Promise.all(waits);
  ok(evRows().some((r) => r.msg === 'slow d1'), 'v294: the slow D1 write lands after the answer');
  mode = 'ok';
  // (g) 7일 지난 행은 한 시간에 한 번 500 행까지 지운다
  dbE.prepare("INSERT INTO events (id, at, sid, type, msg, usr, body) VALUES ('evr:old1', ?, 's', 'info', 'very old', 0, '{}')").run(realNow() + base - 9 * 86400e3);
  shift = base + 4 * 3600e3;
  await call('POST', '/event', { body: { type: 'info', msg: 'cleanup trigger', sid: 'sid00008' }, e: envE });
  ok(!evRows().some((r) => r.msg === 'very old') && evRows().some((r) => r.msg === 'cleanup trigger'), 'v294: rows older than 7 days are deleted in small batches (hourly)');
  // (h) /health 에 저장소와 D1 행 수
  const hh = (await call('GET', '/health', { origin: '', e: envE })).j;
  ok(hh.stores && /^d1/.test(hh.stores['/event']) && /kv evf:/.test(hh.stores['/events']) && hh.stores['/pass'] === 'd1' && hh.events && hh.events.inserted >= 7 && hh.events.fallback === 1 && hh.events.moved === 1 && hh.events.rowsWritten > 0,
    '/health shows which store each path uses and the D1 rows written');
  shift = base;
}

Date.now = realNow;
console.log(fail ? fail + ' FAILED' : 'ALL PASS');
process.exit(fail ? 1 : 0);
