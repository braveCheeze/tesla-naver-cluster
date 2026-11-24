// 테슬라 지도 클러스터용 길안내 프록시 (Cloudflare Worker)
// 비밀키는 코드에 넣지 않는다. Cloudflare 대시보드 > Worker > Settings > Variables and Secrets 에
//   NCP_KEY_ID          네이버 클라우드 Maps Client ID
//   NCP_KEY             네이버 클라우드 Maps Client Secret
//   NAVER_SEARCH_ID     (선택) 네이버 개발자센터 검색 API Client ID
//   NAVER_SEARCH_SECRET (선택) 네이버 개발자센터 검색 API Client Secret
//   EX_KEY              (선택) 한국도로공사 고속도로 공공데이터 포털(data.ex.co.kr) 인증키 — 하이패스 차로 번호
// 를 Secret 으로 넣는다.
// 진단 기록 저장(선택): Bindings 에 KV namespace 를 변수명 LOGS 로 연결한다. 기록은 30일 뒤 자동 삭제.
//   ADMIN_TOKEN         (2026-11-20 공개 전 보안 점검) 운영자 토큰. 32자 넘는 아무 글자. 이 값을 'Authorization: Bearer <값>' 으로 보낼 때만
//                       /events·/log 읽기, 진단 기록 올리기, 운영자 고침(바로 모든 사용자 적용), 놓침 궤적 저장을 허락한다.
//                       값은 운전자가 직접 만들어 대시보드 Secret 과 운전자 PC 환경 변수 TNC_ADMIN_TOKEN, 운전자 차 앱(개발자 메뉴)에만 넣는다.
//   IP_SALT             (v175, 선택) 고침 자동 반영에서 접속지를 셀 때 IP 에 섞는 소금. 없으면 ADMIN_TOKEN 에서 만들어 쓴다(새 Secret 불필요).
//                       둘 다 없으면 자동 반영을 하지 않는다
// 요청 제한(선택): Bindings 에 Rate Limiting 을 변수명 RL 로(예: 60초에 120번) 연결하면 함께 쓴다. 없으면 메모리 기준으로만 막는다.
// 카메라 통과 통계(v196, 선택): Storage & Databases > D1 에서 데이터베이스(이름 아무거나, 예: tnc-stats)를 만들고,
//   이 Worker > Settings > Bindings > Add > D1 database 로 변수명 STATS 에 연결한다. 표는 처음 쓸 때 Worker 가 만든다.
//   없으면 /pass 는 {ok:false} 만 돌려주고 아무것도 저장하지 않는다 (앱은 그 묶음을 버린다).

const ALLOWED_ORIGINS = [
  'https://bravecheeze.github.io',
  'http://localhost:8765',
];
const NCP = 'https://maps.apigw.ntruss.com';
const COORD = /^-?\d{1,3}(\.\d+)?,-?\d{1,3}(\.\d+)?$/;
const ROUTE_OPTIONS = new Set(['trafast', 'tracomfort', 'traoptimal', 'traavoidtoll', 'traavoidcaronly']);
// 재탐색·교통 갱신(단일 옵션 경로)은 같은 접속지에서 15초에 ROUTE_BURST 번까지만 (호출 폭주로 무료 한도를 쓰지 않게).
// v175 (2026-11-20 운전자 '멀티로 사용해도 문제없지?'): 예전엔 15초에 한 번이라, 테슬라 LTE 처럼 여러 차가 통신사 공유 IP(CGNAT)로
// 나가면 다른 차의 재탐색이 막혔다. 15초에 6번으로 (같은 IP 뒤 차 12대가 1분에 두 번씩 재탐색해도 된다). 메모리 기반이라 어림
const ROUTE_GAP_MS = 15000, ROUTE_BURST = 6;
// 접속 기록 키: 최신이 KV 목록 맨 앞에 오도록 (EVR_BASE - 시각) 으로 저장한다
const EVR_BASE = 9e15;
const routeHits = new Map();
// v172 (2026-11-20 공개 전 보안 점검): 경로마다 접속지(IP)별 1분 창 제한 + 하루 상한(이 Worker 인스턴스 기준, 어림).
// Origin 은 위조할 수 있으므로 유료 API(네이버 클라우드)와 KV 쓰기를 이것으로 지킨다.
// v175: 공유 IP(CGNAT) 뒤의 여러 차가 정상으로 써도 막히지 않게 넉넉히 (비용은 하루 상한이 지킨다)
const LIMITS = { '/route': 40, '/geocode': 60, '/reverse': 150, '/search': 60, '/hipass': 60, '/weather': 60, '/config': 120,
  '/event': 60, '/log': 3, '/fb': 6, '/fix': 30, '/fixes': 60, '/events': 30, '/fix/review': 30, '/pass': 20, '/passes': 30, '/trip': 30, '/trips': 60, '/handoff': 30,
  '/check': 10, '/check/status': 30, '/check/next': 120, '/check/result': 120, '/check/unmatched': 30, '/check/results': 30 };
const PAID = new Set(['/route', '/geocode', '/reverse', '/search']);
const KV_WRITE = new Set(['/event', '/fix', '/fix/review', '/check', '/fb']);
const DAY_CAP = { paid: 20000, kv: 900, pass: 30000, trip: 3000 };   // pass: 하루 통과 기록 건수, trip: 경로 조각 수 (D1 무료 한도 쓰기 하루 10만 행 안)
const hits = new Map();
const day = { d: '', paid: 0, kv: 0, pass: 0, trip: 0 };
// 넘었으면 다시 해도 되는 데까지 남은 초(1~60), 아니면 0
function overLimit(ip, path) {
  const lim = LIMITS[path];
  if (!lim) return 0;
  const now = Date.now(), k = path + '|' + ip;
  let h = hits.get(k);
  if (!h || now - h.t > 60000) { h = { t: now, n: 0 }; hits.set(k, h); if (hits.size > 20000) hits.clear(); }
  return ++h.n > lim ? Math.max(1, Math.ceil((h.t + 60000 - now) / 1000)) : 0;
}
function overDay(path) {
  const d = new Date().toISOString().slice(0, 10);
  if (day.d !== d) { day.d = d; day.paid = 0; day.kv = 0; day.pass = 0; day.trip = 0; }
  if (PAID.has(path)) return ++day.paid > DAY_CAP.paid;
  if (KV_WRITE.has(path)) return ++day.kv > DAY_CAP.kv;
  return false;
}
// ---- v175 고침 자동 반영 (아래 /fix 설명) ----
const FIX_KEY = 'fixes:v1';
const FIX_AUTO_MIN = 3;      // 서로 다른 기기 3대 + 서로 다른 접속지 3곳
const FIX_TTL_DAYS = 30;     // 자동 반영은 마지막 신고 뒤 30일이 지나면 빠진다
const FIX_NEAR_M = 50, FIX_NEAR_DEG = 45, FIX_MAX = 2000;
const FIX_PUBLIC = new Set(['ok', 'auto', 'expiring']);
// 한국 날짜 'YYYY-MM-DD' (Date.now 기준이라 시험에서 시계를 옮길 수 있다)
const kstDay = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
function distM(a, b) {
  const kx = Math.cos(a.lat * Math.PI / 180) * 111320, ky = 110540;
  return Math.hypot((a.lng - b.lng) * kx, (a.lat - b.lat) * ky);
}
function headOk(a, b) {
  if (a == null || b == null) return true;
  const d = Math.abs((((a - b) % 360) + 540) % 360 - 180);
  return d <= FIX_NEAR_DEG;
}
const fixCount = (e) => Math.min(e.devs.length, (e.ips || []).length);
// 항목 번호: 종류·키로 정해지는 짧은 글자 (저장하지 않아도 늘 같다)
function fixId(e) {
  let x = 0x811c9dc5;
  const str = e.kind + '|' + e.k;
  for (let i = 0; i < str.length; i++) { x ^= str.charCodeAt(i); x = Math.imul(x, 0x01000193) >>> 0; }
  return x.toString(36).padStart(7, '0');
}
function fixState(e, day) {
  if (e.rev) return 'reverted';
  if (e.op || e.ok) return 'ok';
  if (!e.auto) return 'pending';
  const idle = daysBetween(e.last || e.auto, day);
  return idle > FIX_TTL_DAYS ? 'expired' : idle > FIX_TTL_DAYS - 7 ? 'expiring' : 'auto';
}
// ---- v202 실시간 신고 확인 (아래 /check 설명) ----
// KV 키: 'chkq:<순위 0 신고>:<시각 13자리>:<id>' 대기열 · 'chks:<id>' 상태(14일) · 'chka:<카메라>' 자동 확인 표시(7일) ·
//        'unm:<격자 y,x>:<8방위>' 네이버에도 없는 신고 모음(지우지 않음) · 'chkr:<뒤집은 시각>:<id>' 결과 기록(90일)
const CHECK_ID = /^[a-z0-9]{8,24}$/;
const CHECK_STATE_TTL = 14 * 86400, CHECK_RES_TTL = 90 * 86400, CHECK_AUTO_TTL = 7 * 86400;
// 네이버 종류 → 앱 신고 지점 종류(1 과속·3 신호·과속)와 표시(1 후면단속). 구간단속·'표지판 확인'(시간제)·제한 모름은 자동으로 넣지 않는다
const CHECK_KIND = { '신호과속': [3, 0], '과속단속': [1, 0], '박스형': [1, 0], '이동식': [8, 0], '후면단속': [1, 1] };   // v204: 이동식은 앱 종류 8
const dir8 = (h) => (h == null || !Number.isFinite(+h) ? 'x' : String(Math.round(((+h % 360) + 360) % 360 / 45) % 8));
const headOf = (v) => (v == null || v === '' || !Number.isFinite(+v) ? null : ((Math.round(+v) % 360) + 360) % 360);
function checkPt(o) {
  const lat = +((o && (o.lat != null ? o.lat : o[0])) || NaN), lng = +((o && (o.lng != null ? o.lng : o[1])) || NaN);
  return lat > 33 && lat < 39 && lng > 124 && lng < 132 ? { lat: +lat.toFixed(6), lng: +lng.toFixed(6) } : null;
}
// h 방향으로 m 미터 (짧은 거리용)
function offsetPt(p, h, m) {
  const r = h * Math.PI / 180;
  return { lat: +(p.lat + Math.cos(r) * m / 110540).toFixed(6), lng: +(p.lng + Math.sin(r) * m / (Math.cos(p.lat * Math.PI / 180) * 111320)).toFixed(6) };
}
async function checkState(env, id) { try { return JSON.parse((await env.LOGS.get('chks:' + id)) || 'null'); } catch (e) { return null; } }
const putCheckState = (env, id, st) => env.LOGS.put('chks:' + id, JSON.stringify(st), { expirationTtl: CHECK_STATE_TTL });
// v215 자동 확인 후보 거르기 (2026-11-24 keys: 울진 앞바다 36.918,129.700 은 길찾기가 502, 강릉 후보는 길에서 150~590m 떨어져 확인할 수 없었다).
//   운전자 확인 지점(앱 data/driver_spots.json) 100m 안이면 넣는다. 아니면 네이버 길찾기로 그 점에서 100m 안에 길이 있는지 본다:
//   그 점에서 찍는 방향(모르면 북)으로 300m 앞까지 길을 찾아, 경로 첫 점(네이버가 길 위로 붙인 출발점)이 100m 안이면 길 위.
//   네이버가 길이 없다고 하면(길 주변이 아님 등 4xx·code≠0) 길 밖. 길 밖 키는 30일 동안 다시 보지 않는다(chkx:).
//   네이버가 답하지 않으면(5xx·네트워크) 이번에는 넘기기만 하고 표시하지 않는다.
//   (고정 카메라 자료 cameras.json 은 2.7MB 라 여기서 읽지 않는다 — 고정 카메라는 길 위에 있어 길 검사로 남는다)
const AUTO_NEAR_M = 100, AUTO_SKIP_TTL = 30 * 86400, AUTO_ROUTE_M = 300;
const APP_DATA = 'https://bravecheeze.github.io/tesla-naver-cluster/data/';
let spotCache = { at: 0, rows: [] };
async function driverSpotRows() {
  if (Date.now() - spotCache.at < 3600e3) return spotCache.rows;
  let rows = [];
  try {
    const r = await fetch(APP_DATA + 'driver_spots.json');
    const j = r.ok ? await r.json() : null;
    rows = j && Array.isArray(j.rows) ? j.rows.filter((x) => Array.isArray(x) && Number.isFinite(+x[0]) && Number.isFinite(+x[1])) : [];
  } catch (e) { rows = []; }
  spotCache = { at: Date.now(), rows };
  return rows;
}
// 그 점에서 가장 가까운 길까지의 거리(m). 길이 없다고 하면 Infinity, 모르면 null
async function roadGapM(env, at, h) {
  const hdr = { 'x-ncp-apigw-api-key-id': env.NCP_KEY_ID || '', 'x-ncp-apigw-api-key': env.NCP_KEY || '' };
  const goal = offsetPt(at, h == null ? 0 : h, AUTO_ROUTE_M);
  const qs = new URLSearchParams({ start: at.lng + ',' + at.lat, goal: goal.lng + ',' + goal.lat, option: 'trafast' });
  let r;
  try { r = await upstream(NCP + '/map-direction/v1/driving?' + qs, hdr); } catch (e) { return null; }
  if (!r.ok) return r.status >= 500 ? null : Infinity;
  const d = r.data || {};
  if (d.code === 1) return 0;   // 출발·도착이 같은 길 점으로 붙음 = 길 위
  const p0 = d.code === 0 && d.route && d.route.trafast && d.route.trafast[0] && d.route.trafast[0].path && d.route.trafast[0].path[0];
  return p0 ? distM(at, { lat: +p0[1], lng: +p0[0] }) : Infinity;
}
// 자동 확인에 넣을 만한 점인지: true 넣음, false 길 밖(30일 표시), null 모름(이번엔 넘김)
async function autoCheckable(env, at, h) {
  const spots = await driverSpotRows();
  if (spots.some((x) => distM(at, { lat: +x[0], lng: +x[1] }) <= AUTO_NEAR_M)) return true;
  const gap = await roadGapM(env, at, h);
  return gap == null ? null : gap <= AUTO_NEAR_M;
}
// 자동 확인 후보: v196 통과 통계(cam_day)에서 최근 30일 경고 없이 지난 것(missed)이 서로 다른 날 2번 넘게, 또는 통과 3번 이상 중 30% 넘게
async function autoCheckJob(env) {
  if (!env.STATS) return null;
  let rows = [];
  try {
    const db = await passDb(env);
    const since = new Date(Date.now() + 9 * 3600e3 - 30 * 86400000).toISOString().slice(0, 10);
    const q = await db.prepare('SELECT cam, SUM(n) AS n, SUM(missed) AS m, COUNT(DISTINCT CASE WHEN missed > 0 THEN day END) AS md, MAX(lim) AS lim, MAX(kind) AS kind ' +
      'FROM cam_day WHERE day >= ? GROUP BY cam HAVING md > 2 OR (n >= 3 AND m * 10 > n * 3) ORDER BY md DESC, m DESC LIMIT 30').bind(since).all();
    rows = (q && q.results) || [];
  } catch (e) { return null; }
  let probes = 0;
  for (const r of rows) {
    const m = PASS_KEY.exec(String(r.cam || ''));
    if (!m) continue;
    if (await env.LOGS.get('chka:' + r.cam)) continue;   // 7일에 한 번
    if (await env.LOGS.get('chkx:' + r.cam)) continue;   // v215: 길 밖으로 본 키 (30일)
    if (++probes > 5) break;   // 한 번 부를 때 길 검사는 5번까지 (나머지는 다음에: 응답을 빨리, 바깥 호출 수 제한 안에서)
    const at = { lat: +m[1], lng: +m[2] }, h = m[3] === 'x' ? null : +m[3] * 45;
    const usable = await autoCheckable(env, at, h);
    if (usable === false) { await env.LOGS.put('chkx:' + r.cam, '1', { expirationTtl: AUTO_SKIP_TTL }); continue; }
    if (usable === null) continue;
    await env.LOGS.put('chka:' + r.cam, '1', { expirationTtl: CHECK_AUTO_TTL });
    const id = 'a' + crypto.randomUUID().replace(/-/g, '').slice(0, 15);
    const job = { id, kind: 'auto', lat: at.lat, lng: at.lng, heading: h, cam: r.cam, limit: r.lim || null, camKind: r.kind || null,
      passes: r.n, missed: r.m, missDays: r.md, trail: h == null ? [] : [[offsetPt(at, (h + 180) % 360, 450).lat, offsetPt(at, (h + 180) % 360, 450).lng], [at.lat, at.lng]], at: Date.now() };
    await putCheckState(env, id, { st: 'checking', kind: 'auto', at: Date.now(), job });
    return job;
  }
  return null;
}
// 소금: Secret IP_SALT, 없으면 ADMIN_TOKEN 에서 (둘 다 비밀이라 해시로 IP 를 거꾸로 찾을 수 없다)
const ipSalt = (env) => (env.IP_SALT ? String(env.IP_SALT) : env.ADMIN_TOKEN ? 'tnc-ip-v1|' + String(env.ADMIN_TOKEN) : '');
async function ipHash(env, ip) {
  const salt = ipSalt(env);
  if (!salt || !ip || ip === 'x') return '';
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(salt + '|' + ip));
  return [...new Uint8Array(d)].slice(0, 8).map((v) => v.toString(16).padStart(2, '0')).join('');
}
async function loadFixes(env) {
  try { const l = JSON.parse((await env.LOGS.get(FIX_KEY)) || '[]'); return Array.isArray(l) ? l : []; } catch (e) { return []; }
}
const saveFixes = (env, list) => env.LOGS.put(FIX_KEY, JSON.stringify(list), { expirationTtl: 60 * 60 * 24 * 90 });
// ---- v196 카메라 통과 익명 통계 (아래 /pass 설명) ----
// 카메라 번호: 카메라 자리 'lat,lng' + '|' + 찍는 방향 8방위(0 북 … 7 북서, x 모름). 후보 격자: 위도·경도 × 1000 반올림 'y,x'
const PASS_KEY = /^(-?\d{1,3}\.\d{1,8}),(-?\d{1,3}\.\d{1,8})\|([0-7x])$/;
const CELL_KEY = /^(\d{5}),(\d{6})$/;
const PASS_KINDS = new Set([1, 2, 3, 8, 9]);
// 보관 (v198, 운전자 '원본은 30일 뒤에 자동으로 지우는걸로 하고 대신에 저 경로 원본이 지워지더라도 참고했던 과속단속 정보는 남아있어야 해'):
//   테스터 주행 경로 원본(trips) 30일, 운영자 차 통과 기록(op_pass) 90일. 그 밖의 표(통과 기록 pass_rec, 카메라 날짜별 합계 cam_day,
//   자료에 없는 단속 후보 격자 cand_day, 넘긴 내역 handoff)는 원본과 따로 두고 지우지 않는다.
const PASS_OP_DAYS = 90, TRIP_DAYS = 30;
const inKorea = (lat, lng) => lat > 33 && lat < 39 && lng > 124 && lng < 132;
const intIn = (v, lo, hi) => { const n = Math.round(Number(v)); return Number.isFinite(n) && n >= lo && n <= hi ? n : null; };
const appVer = (v) => (typeof v === 'string' && /^[0-9][0-9.\-]{0,23}$/.test(v) ? v : '');
// 통과 한 건의 판정: 경고함 · 같은 자리 다른 행을 경고 · 제한 모름(일부러 안 알림) · 놓침. '틀림' 표시는 따로(flag)
const passRes = (a, g, hid) => (a > 0 ? 'alert' : g ? 'cover' : hid === 1 ? 'hidden' : 'miss');
let passReady = null, passCleaned = '';
async function passDb(env) {
  if (!env.STATS) return null;
  if (!passReady) {
    const S = env.STATS;
    passReady = S.batch([
      S.prepare('CREATE TABLE IF NOT EXISTS cam_day (day TEXT NOT NULL, cam TEXT NOT NULL, lim INTEGER, kind INTEGER, n INTEGER NOT NULL DEFAULT 0, ' +
        'alerted INTEGER NOT NULL DEFAULT 0, covered INTEGER NOT NULL DEFAULT 0, missed INTEGER NOT NULL DEFAULT 0, hidden INTEGER NOT NULL DEFAULT 0, ' +
        'flagged INTEGER NOT NULL DEFAULT 0, navn INTEGER NOT NULL DEFAULT 0, over INTEGER NOT NULL DEFAULT 0, adist INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, cam))'),
      S.prepare('CREATE TABLE IF NOT EXISTS cand_day (day TEXT NOT NULL, cell TEXT NOT NULL, dir INTEGER NOT NULL, n INTEGER NOT NULL DEFAULT 0, ' +
        'dsum INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, cell, dir))'),
      S.prepare('CREATE TABLE IF NOT EXISTS op_pass (id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, day TEXT NOT NULL, cam TEXT NOT NULL, missed INTEGER NOT NULL, rec TEXT NOT NULL)'),
      S.prepare('CREATE INDEX IF NOT EXISTS op_pass_at ON op_pass (at)'),
      // v198: 통과 한 건씩 (주행 번호·시각·위치 없이) — 지우지 않는다
      S.prepare('CREATE TABLE IF NOT EXISTS pass_rec (id INTEGER PRIMARY KEY AUTOINCREMENT, day TEXT NOT NULL, cam TEXT NOT NULL, v TEXT, lim INTEGER, kind INTEGER, ' +
        'a INTEGER NOT NULL, g INTEGER NOT NULL, hid INTEGER NOT NULL, kmh INTEGER, nav INTEGER NOT NULL, res TEXT NOT NULL, flag INTEGER NOT NULL DEFAULT 0)'),
      S.prepare('CREATE INDEX IF NOT EXISTS pass_rec_day ON pass_rec (day)'),
      S.prepare('CREATE INDEX IF NOT EXISTS pass_rec_cam ON pass_rec (cam)'),
      // v198: 테스터 주행 경로 원본 (주행마다 무작위 번호 rid, 조각 part). 30일 뒤 지운다
      S.prepare('CREATE TABLE IF NOT EXISTS trips (id INTEGER PRIMARY KEY AUTOINCREMENT, day TEXT NOT NULL, rid TEXT NOT NULL, part INTEGER NOT NULL, endf INTEGER NOT NULL, ' +
        'op INTEGER NOT NULL, v TEXT, n INTEGER NOT NULL, km REAL NOT NULL, ncam INTEGER NOT NULL, misses INTEGER NOT NULL, pts TEXT NOT NULL, cams TEXT NOT NULL)'),
      S.prepare('CREATE INDEX IF NOT EXISTS trips_day ON trips (day)'),
      S.prepare('CREATE INDEX IF NOT EXISTS trips_rid ON trips (rid)'),
      // v198: 원본에서 찾아 고침 후보·신고 지점으로 넘긴 내역 (어디, 어느 방향, 근거) — 지우지 않는다
      S.prepare('CREATE TABLE IF NOT EXISTS handoff (id INTEGER PRIMARY KEY AUTOINCREMENT, day TEXT NOT NULL, kind TEXT NOT NULL, lat REAL NOT NULL, lng REAL NOT NULL, ' +
        'h INTEGER, cam TEXT, ref TEXT, basis TEXT NOT NULL)'),
    ]).then(async () => {
      // v231 (운전자 '접속만 잇기 (A)'): 주행 조각에 접속 번호(sid, 페이지를 열 때마다 새 무작위 값)와 조각 첫 점 시각(t0, 밀리초) —
      // 관리 화면의 접속 창에서 그 주행 경로·거리를 그린다. 기기 번호(dev)는 넣지 않는다. 예전 표에 없으면 칸을 더한다
      const have = new Set(((await S.prepare('PRAGMA table_info(trips)').all()).results || []).map((c) => c.name));
      const add = [];
      if (!have.has('sid')) add.push(S.prepare('ALTER TABLE trips ADD COLUMN sid TEXT'));
      if (!have.has('t0')) add.push(S.prepare('ALTER TABLE trips ADD COLUMN t0 INTEGER'));
      if (add.length) await S.batch(add);
      return true;
    }).then(() => true, (e) => { passReady = null; throw e; });
  }
  await passReady;
  return env.STATS;
}
// 통과 기록 → 카메라 날짜별 합계(cam_day)·통과 기록(pass_rec) 문장. D1 무료는 요청마다 쿼리 50번까지라 표마다 한 문장(json_each)으로 넣는다
const CAM_UP = 'INSERT INTO cam_day (day, cam, lim, kind, n, alerted, covered, missed, hidden, flagged, navn, over, adist) ' +
  "SELECT json_extract(value, '$.day'), json_extract(value, '$.cam'), json_extract(value, '$.lim'), json_extract(value, '$.kind'), json_extract(value, '$.n'), " +
  "json_extract(value, '$.alerted'), json_extract(value, '$.covered'), json_extract(value, '$.missed'), json_extract(value, '$.hidden'), json_extract(value, '$.flagged'), " +
  "json_extract(value, '$.navn'), json_extract(value, '$.over'), json_extract(value, '$.adist') FROM json_each(?) WHERE true " +
  'ON CONFLICT(day, cam) DO UPDATE SET lim = excluded.lim, kind = excluded.kind, n = n + excluded.n, alerted = alerted + excluded.alerted, ' +
  'covered = covered + excluded.covered, missed = missed + excluded.missed, hidden = hidden + excluded.hidden, flagged = flagged + excluded.flagged, ' +
  'navn = navn + excluded.navn, over = over + excluded.over, adist = adist + excluded.adist';
const REC_INS = 'INSERT INTO pass_rec (day, cam, v, lim, kind, a, g, hid, kmh, nav, res, flag) ' +
  "SELECT json_extract(value, '$.day'), json_extract(value, '$.cam'), json_extract(value, '$.v'), json_extract(value, '$.lim'), json_extract(value, '$.kind'), " +
  "json_extract(value, '$.a'), json_extract(value, '$.g'), json_extract(value, '$.hid'), json_extract(value, '$.kmh'), json_extract(value, '$.nav'), " +
  "json_extract(value, '$.res'), json_extract(value, '$.flag') FROM json_each(?)";
function passStmts(db, items, dayOf, v, stmts) {
  const agg = new Map(), recs = [];
  for (const it of items) {
    if (!it || typeof it !== 'object') continue;
    if (it.x) continue;   // v219: 시험 페이지에서 만든 기록
    const k = String(it.k || ''), m = PASS_KEY.exec(k);
    if (!m || !inKorea(+m[1], +m[2])) continue;
    const d = dayOf(it.d), lim = intIn(it.lim, 0, 130) || 0, a = intIn(it.a, 0, 5000) || 0;
    if (d === null) continue;   // v219: 오늘보다 뒤 날짜
    const hid = intIn(it.hid, 0, 3) || 0, kmh = intIn(it.kmh, 0, 250), g = it.g ? 1 : 0, nav = it.nav ? 1 : 0;
    const kind = PASS_KINDS.has(+it.kind) ? +it.kind : 0, res = passRes(a, g, hid);
    let e = agg.get(d + '#' + k);
    if (!e) {
      e = { day: d, cam: k, lim, kind, n: 0, alerted: 0, covered: 0, missed: 0, hidden: 0, flagged: 0, navn: 0, over: 0, adist: 0 };
      agg.set(d + '#' + k, e);
    }
    e.n++;
    if (res === 'alert') { e.alerted++; e.adist += a; }   // 이 카메라 경고 카드를 띄움 (거리 합은 평균 경고 거리용)
    else if (res === 'cover') e.covered++;               // 같은 자리 다른 행(같은 기둥 다른 제한 등)을 경고하고 함께 지남
    else if (res === 'hidden') e.hidden++;               // 제한속도를 몰라 일부러 안 알림 (v179)
    else e.missed++;
    if (hid >= 2) e.flagged++;                           // 이 차에서 '틀림'으로 표시한 카메라
    if (nav) e.navn++;
    if (kmh !== null && lim > 0 && kmh > lim) e.over++;
    recs.push({ day: d, cam: k, v, lim, kind, a, g, hid, kmh, nav, res, flag: hid >= 2 ? 1 : 0 });
  }
  if (agg.size) stmts.push(db.prepare(CAM_UP).bind(JSON.stringify([...agg.values()])));
  if (recs.length) stmts.push(db.prepare(REC_INS).bind(JSON.stringify(recs)));
  return agg.size;
}
// 그날 첫 요청 때 보관 기간이 지난 원본을 지운다 (경로 30일, 운영자 차 90일). 합계·통과 기록·후보·넘긴 내역은 지우지 않는다
function passCleanup(db, today, stmts) {
  if (passCleaned === today) return;
  passCleaned = today;
  stmts.push(db.prepare('DELETE FROM op_pass WHERE day < ?').bind(dayBefore(today, PASS_OP_DAYS)));
  stmts.push(db.prepare('DELETE FROM trips WHERE day < ?').bind(dayBefore(today, TRIP_DAYS)));
}
// 날짜 'YYYY-MM-DD' 가 오늘(한국)부터 3일 전 ~ 1일 뒤면 그대로, 아니면 오늘
// v219: 오늘(한국 날짜)보다 뒤 날짜는 받지 않는다 (null: 버림). 2026-11-24 운영 통계에 시험 페이지의 가짜 시계 기록(11-25)이 들어왔다.
// 예전엔 하루 뒤까지 받았다. 날짜가 없거나 사흘 넘게 지난 것은 예전처럼 오늘로
function passDay(d, today) {
  if (typeof d !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return today;
  const k = daysBetween(d, today);
  return k < 0 ? null : k <= 3 ? d : today;
}
const dayBefore = (today, n) => new Date(Date.parse(today) - n * 86400000).toISOString().slice(0, 10);
// 바깥 API 오류는 상태와 짧은 글만 돌려준다 (응답 전체를 그대로 내보내지 않게)
function brief(d) {
  if (!d || typeof d !== 'object') return '';
  const e = d.error && typeof d.error === 'object' ? d.error : d;
  return String(e.message || e.errorMessage || d.message || d.errorMessage || '').slice(0, 120);
}
// 같은 길이 비교로 토큰을 맞춰 본다 (글자마다 시간이 달라지지 않게)
function sameToken(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let x = 0;
  for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return x === 0;
}
// 하이패스 차로 목록 (전국 영업소, 실시간). 5분 동안 메모리에 두고 다시 받는다
const hipassCache = { list: null, at: 0 };
const HIPASS_API = 'https://data.ex.co.kr/openapi/trafficOprgPrcd/tolofHipasCrgwOpclPrssList';
// data.ex.co.kr 는 User-Agent 가 없거나 curl 이면 '400 Request Blocked' 로 막는다 (2026-11-14 확인). Worker fetch 는 기본 UA 가 없으므로 넣는다
const HIPASS_HEADERS = { 'User-Agent': 'Mozilla/5.0 (compatible; tesla-nav/1.0; +https://bravecheeze.github.io/tesla-naver-cluster/)', 'Accept': 'application/json' };

function json(body, status, cors, cacheSeconds) {
  const headers = { 'Content-Type': 'application/json; charset=utf-8', ...cors };
  if (cacheSeconds) headers['Cache-Control'] = 'public, max-age=' + cacheSeconds;
  return new Response(JSON.stringify(body), { status, headers });
}

function round6(n) { return Math.round(n * 1e6) / 1e6; }

async function upstream(url, headers) {
  const r = await fetch(url, { headers });
  const text = await r.text();
  let data;
  try { data = JSON.parse(text); } catch (e) { data = { raw: text.slice(0, 300) }; }
  return { ok: r.ok, status: r.status, data };
}

export default {
  async fetch(req, env) {
    const origin = req.headers.get('Origin') || '';
    const allowed = ALLOWED_ORIGINS.includes(origin);
    const cors = {
      'Access-Control-Allow-Origin': allowed ? origin : ALLOWED_ORIGINS[0],
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Vary': 'Origin',
    };
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    const url = new URL(req.url);
    const p = url.searchParams;
    const isLogPost = req.method === 'POST' && url.pathname === '/log';
    const isEventPost = req.method === 'POST' && url.pathname === '/event';
    const isFixPost = req.method === 'POST' && url.pathname === '/fix';
    const isReviewPost = req.method === 'POST' && url.pathname === '/fix/review';
    const isPassPost = req.method === 'POST' && url.pathname === '/pass';
    const isTripPost = req.method === 'POST' && url.pathname === '/trip';
    const isHandoffPost = req.method === 'POST' && url.pathname === '/handoff';
    const isCheckPost = req.method === 'POST' && (url.pathname === '/check' || url.pathname === '/check/result');
    const isFbPost = req.method === 'POST' && url.pathname === '/fb';   // v225: 의견 녹음
    if (req.method !== 'GET' && !isLogPost && !isEventPost && !isFixPost && !isReviewPost && !isPassPost && !isTripPost && !isHandoffPost && !isCheckPost && !isFbPost) return json({ error: 'method' }, 405, cors);
    // v172: 접속지(IP)별 횟수 제한 → 하루 상한 → 운영자 토큰 순서 (토큰 맞히기 시도도 횟수 제한에 걸린다)
    const ip = req.headers.get('CF-Connecting-IP') || 'x';
    const wait = overLimit(ip, url.pathname);
    if (wait) return json({ error: 'rate limited', message: '잠시 후 다시 시도합니다', retryAfter: wait }, 429, cors);
    if (env.RL && env.RL.limit && url.pathname !== '/health') {
      try { const r0 = await env.RL.limit({ key: ip }); if (r0 && r0.success === false) return json({ error: 'rate limited', retryAfter: 60 }, 429, cors); } catch (e) { /* 바인딩 없음 */ }
    }
    const bearer = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
    const isAdmin = !!env.ADMIN_TOKEN && String(env.ADMIN_TOKEN).length >= 16 && sameToken(bearer, String(env.ADMIN_TOKEN));
    // 남의 신고·진단 기록을 읽거나 진단 기록을 올리는 것은 운영자만 (Origin 은 위조할 수 있다)
    if ((url.pathname === '/events' || url.pathname === '/log' || url.pathname === '/passes' || url.pathname === '/trips' || url.pathname === '/handoff' ||
      url.pathname === '/check/next' || url.pathname === '/check/result' || url.pathname === '/check/unmatched' || url.pathname === '/check/results' ||
      (url.pathname === '/fb' && !isFbPost)) && !isAdmin) {
      return json({ error: 'unauthorized' }, 401, cors);
    }
    if (!isAdmin && overDay(url.pathname)) return json({ error: 'daily limit', retryAfter: 3600 }, 429, cors);
    // v219: 개발용 페이지(이 컴퓨터의 localhost)에서 온 통과 기록·주행 경로·고침·실시간 확인 요청은 받은 것으로 답하고 저장하지 않는다
    // (2026-11-24 운영 통계에 시험 주행 — 바다 위 합성 길·가짜 시계·S1 구간 — 이 섞였다. 실제 차는 Pages 주소에서 보낸다)
    if (!isAdmin && /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin) &&
      (isPassPost || isTripPost || isFixPost || isFbPost || (req.method === 'POST' && url.pathname === '/check'))) {
      return json({ ok: true, dropped: 'dev' }, 200, cors);
    }

    if (url.pathname === '/health') {
      return json({
        ok: true,
        ncp: !!(env.NCP_KEY_ID && env.NCP_KEY),
        search: !!(env.NAVER_SEARCH_ID && env.NAVER_SEARCH_SECRET),
        logs: !!env.LOGS,
        hipass: !!env.EX_KEY,
        autoFix: !!ipSalt(env),
        stats: !!env.STATS,
      }, 200, cors);
    }
    // 브라우저가 아닌 곳에서 마구 부르는 것을 1차로 막는다 (Origin 은 위조 가능하므로 완벽하진 않음)
    if (!allowed && !isAdmin) return json({ error: 'origin not allowed' }, 403, cors);   // v202: 운영자 도구(에뮬레이터 실행기)는 Origin 없이 토큰으로

    const ncpHeaders = { 'x-ncp-apigw-api-key-id': env.NCP_KEY_ID || '', 'x-ncp-apigw-api-key': env.NCP_KEY || '' };

    try {
      // 지도 표시용 Client ID 는 원래 웹페이지에 공개되는 값이라 내려준다 (Secret 은 절대 내려주지 않음)
      if (url.pathname === '/config') {
        return json({ mapKeyId: env.NCP_KEY_ID || '' }, 200, cors, 300);
      }

      // 날씨 (Open-Meteo). 위치는 약 10km 단위로 뭉개서 보낸다. 10분 캐시
      if (url.pathname === '/weather') {
        const lat = Number(p.get('lat')), lng = Number(p.get('lng'));
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) return json({ error: 'bad coords' }, 400, cors);
        const qs = new URLSearchParams({
          latitude: (Math.round(lat * 10) / 10).toFixed(1), longitude: (Math.round(lng * 10) / 10).toFixed(1),
          current: 'temperature_2m,weather_code', hourly: 'precipitation_probability', forecast_hours: '2', timezone: 'Asia/Seoul',
        });
        const r = await upstream('https://api.open-meteo.com/v1/forecast?' + qs, {});
        if (!r.ok || !r.data.current) return json({ error: 'upstream', status: r.status }, 502, cors);
        const pp = (r.data.hourly && r.data.hourly.precipitation_probability) || [];
        return json({
          temp: r.data.current.temperature_2m, code: r.data.current.weather_code,
          rain: pp.length ? Math.max(...pp.slice(0, 2).filter(Number.isFinite)) : null,
        }, 200, cors, 600);
      }

      // 하이패스 차로: 한국도로공사 '영업소 하이패스 차로 개폐 현황'(실시간). ?name=하남 (톨게이트·영업소 글자는 떼고)
      // → 그 영업소의 하이패스 차로 [{no 토목차로번호, cls 입구/출구, type 차로유형명, open 개방 여부}]. 인증키는 Secret EX_KEY
      if (url.pathname === '/hipass') {
        if (!env.EX_KEY) return json({ error: 'hipass key not configured' }, 501, cors);
        const name = (p.get('name') || '').replace(/\s+/g, '').replace(/(톨게이트|영업소|요금소|TG)$/i, '');
        if (!name || name.length > 20) return json({ error: 'bad name' }, 400, cors);
        const now = Date.now();
        if (!hipassCache.list || now - hipassCache.at > 5 * 60000) {
          const r = await upstream(HIPASS_API + '?key=' + encodeURIComponent(env.EX_KEY) + '&type=json', HIPASS_HEADERS);
          const rows = r.data && (r.data.lcsTrafficLists || r.data.list);
          if (!r.ok || !Array.isArray(rows)) {
            if (!hipassCache.list) return json({ error: 'upstream', status: r.status, code: r.data && r.data.code, message: brief(r.data) }, 502, cors);
          } else {
            hipassCache.list = rows; hipassCache.at = now;
          }
        }
        const key = (x) => String(x || '').replace(/\s+/g, '').replace(/(영업소|요금소)$/, '');
        const lanes = hipassCache.list.filter((x) => key(x.tolofNm) === name).map((x) => ({
          no: parseInt(x.cvenCrgwNo, 10) || parseInt(x.crgwNo, 10) || 0,
          cls: String(x.crgwClssNm || ''), type: String(x.crgwTypeNm || ''), open: String(x.lcsStat) === '01',
        })).filter((x) => x.no > 0);
        return json({ name, at: hipassCache.at, lanes }, 200, cors, 60);
      }

      // v171 단속 카메라 고침 목록 (2026-11-20 운전자 '놓침을 누르면 … 바로 반영될 수 있었으면'):
      // 앱이 '놓침' 진단으로 찾은 고침(방향·경로 위로 보기·신호 전용 알림·틀림 풀기·새 신고 지점)을 기기 번호와 함께 보낸다.
      // 저장은 KV 한 값 'fixes:v1' = [{ kind, k, lat, lng, h, devs, ips, first, last, op, ok, auto, rev }] (카메라 점·방향·종류·날짜만, 궤적 없음, 90일).
      // v175 (2026-11-20 운전자 '3명 이상 신고된 곳은 자동 반영해도 좋을 거 같아 한번 더 검증하면 되니까 AI가'):
      //   같은 고침(카메라 고침은 같은 카메라, 새 지점은 50m 안·방향 ±45°)을 서로 다른 기기 3대 + 서로 다른 접속지 3곳에서 보내면
      //   운영자 없이 /fixes 공개 목록에 넣는다(auto). 접속지는 원래 IP 가 아니라 Secret IP_SALT 를 섞은 해시 앞 16자만 저장한다
      //   (IP_SALT 가 없으면 ADMIN_TOKEN 에서 만든 소금. 둘 다 없으면 자동 반영하지 않는다). 자동 반영은 30일 동안 새 신고가 없으면 빠진다(이동식 단속처럼 없어지는 곳).
      //   운영자 토큰으로 보낸 고침(op)과 운영자가 '확인'한 곳(ok)은 만료되지 않는다. '되돌리기'(rev)는 공개하지 않고 다시 자동 반영하지도 않는다.
      //   운영자 통로(토큰): GET /fixes?all=1[&state=auto,pending,expiring,…] 목록, POST /fix/review {items:[{id, action: confirm|revert|restore}]}
      if (url.pathname === '/fix' && isFixPost) {
        if (!env.LOGS) return json({ ok: false }, 200, cors);
        const text = await req.text();
        if (text.length > 4000) return json({ error: 'too large' }, 413, cors);
        let b;
        try { b = JSON.parse(text); } catch (e) { return json({ error: 'bad json' }, 400, cors); }
        const dev = String((b && b.dev) || '');
        if (!/^[a-z0-9]{8,24}$/.test(dev) || !Array.isArray(b.items)) return json({ error: 'bad fix' }, 400, cors);
        const KINDS = new Set(['dir', 'route', 'signal', 'flag', 'spot']);
        const KEY = /^-?\d{1,3}(\.\d{1,8})?,-?\d{1,3}(\.\d{1,8})?$/;
        const iph = await ipHash(env, ip);
        const day = kstDay();
        const list = await loadFixes(env);
        let added = 0;
        for (const it of b.items.slice(0, 5)) {
          const lat = +it.lat, lng = +it.lng, h = it.h == null || !Number.isFinite(+it.h) ? null : ((Math.round(+it.h) % 360) + 360) % 360;
          if (!KINDS.has(it.kind) || !(lat > 33 && lat < 39 && lng > 124 && lng < 132)) continue;
          const k = it.kind === 'spot' ? lat.toFixed(4) + ',' + lng.toFixed(4) + ',' + (h == null ? 'x' : Math.round(h / 45) % 8) : String(it.k || '').slice(0, 40);
          if (!k || (it.kind !== 'spot' && !KEY.test(k))) continue;
          const here = { lat, lng, h };
          // 같은 고침: 카메라 고침은 같은 카메라(k)·방향 ±45°, 새 지점은 50m 안·방향 ±45°
          let e = list.find((x) => x.kind === it.kind && (it.kind === 'spot' ? distM(x, here) <= FIX_NEAR_M : x.k === k) && headOk(x.h, h));
          if (!e) {
            if (list.length >= FIX_MAX) {
              // 가득 차면 가장 오래 신고가 없던 후보(공개 안 된 것)를 밀어낸다
              let old = -1;
              list.forEach((x, i) => { if (fixState(x, day) === 'pending' && (old < 0 || String(x.last || '') < String(list[old].last || ''))) old = i; });
              if (old < 0) continue;
              list.splice(old, 1);
            }
            e = { kind: it.kind, k, lat: +lat.toFixed(6), lng: +lng.toFixed(6), h, devs: [], ips: [], first: day, last: day };
            list.push(e);
            added++;
          }
          if (!e.ips) e.ips = [];
          if (e.last !== day) { e.last = day; added++; }
          if (!e.first) e.first = day;
          if (!e.devs.includes(dev) && e.devs.length < 20) { e.devs.push(dev); added++; }
          if (iph && !e.ips.includes(iph) && e.ips.length < 20) { e.ips.push(iph); added++; }
          if (isAdmin && !e.op) { e.op = true; e.ok = e.ok || day; delete e.rev; added++; }   // 운영자가 보낸 고침은 바로 모든 사용자에게
          if (!e.auto && !e.rev && !e.op && !e.ok && fixCount(e) >= FIX_AUTO_MIN) { e.auto = day; added++; }
        }
        if (added) await saveFixes(env, list);
        return json({ ok: true, added }, 200, cors);
      }
      // 운영자 검토: 확인(만료 없이 공개) · 되돌리기(공개 안 함, 다시 자동 반영도 안 함) · 되살리기(되돌리기 취소)
      if (url.pathname === '/fix/review' && isReviewPost) {
        if (!isAdmin) return json({ error: 'unauthorized' }, 401, cors);
        if (!env.LOGS) return json({ ok: false }, 200, cors);
        const text = await req.text();
        if (text.length > 8000) return json({ error: 'too large' }, 413, cors);
        let b;
        try { b = JSON.parse(text); } catch (e) { return json({ error: 'bad json' }, 400, cors); }
        const acts = Array.isArray(b && b.items) ? b.items : (b && b.id ? [b] : []);
        const day = kstDay();
        const list = await loadFixes(env);
        const done = [];
        for (const a of acts.slice(0, 50)) {
          const e = list.find((x) => fixId(x) === String(a.id || ''));
          if (!e) { done.push({ id: a.id, ok: false, error: 'not found' }); continue; }
          if (a.action === 'confirm') { e.ok = day; delete e.rev; }
          else if (a.action === 'revert') { e.rev = day; delete e.ok; delete e.op; }
          else if (a.action === 'restore') { delete e.rev; }
          else { done.push({ id: a.id, ok: false, error: 'bad action' }); continue; }
          done.push({ id: a.id, ok: true, state: fixState(e, day) });
        }
        if (done.some((x) => x.ok)) await saveFixes(env, list);
        return json({ ok: true, done }, 200, cors);
      }
      if (url.pathname === '/fixes') {
        if (!env.LOGS) return json({ v: 1, items: [] }, 200, cors);
        const day = kstDay();
        const list = await loadFixes(env);
        // 운영자: 모든 항목과 상태 (신고 기기·접속지 값은 내보내지 않고 수만). state=auto,pending,expiring,expired,ok,reverted 로 거를 수 있다
        if (isAdmin && p.get('all') === '1') {
          const want = new Set(String(p.get('state') || '').split(',').map((x) => x.trim()).filter(Boolean));
          const items = list.map((e) => {
            const st = fixState(e, day), idle = e.last ? daysBetween(e.last, day) : null;
            return {
              id: fixId(e), kind: e.kind, k: e.k, lat: e.lat, lng: e.lng, h: e.h, state: st, public: FIX_PUBLIC.has(st),
              n: fixCount(e), devs: e.devs.length, ips: (e.ips || []).length, first: e.first || null, last: e.last || null,
              auto: e.auto || null, ok: e.ok || null, rev: e.rev || null, op: !!e.op,
              expiresInDays: e.auto && !e.ok && !e.op && !e.rev && idle != null ? Math.max(0, FIX_TTL_DAYS - idle) : null,
            };
          }).filter((x) => !want.size || want.has(x.state));
          const counts = {};
          list.forEach((e) => { const st = fixState(e, day); counts[st] = (counts[st] || 0) + 1; });
          return json({ v: 2, day, autoEnabled: !!ipSalt(env), counts, items }, 200, cors);
        }
        // 모든 사용자: 운영자 고침·확인한 곳(src 'op')과 아직 확인 전인 자동 반영(src 'auto', 앱이 '사용자 제보'로 표시)
        const items = list.map((e) => ({ e, st: fixState(e, day) })).filter((x) => FIX_PUBLIC.has(x.st))
          .map(({ e, st }) => Object.assign({ kind: e.kind, k: e.k, lat: e.lat, lng: e.lng, h: e.h, src: st === 'ok' ? 'op' : 'auto' },
            e.lim ? { lim: e.lim } : {}, e.ck ? { ck: e.ck } : {}, e.fl ? { fl: e.fl } : {}));   // v202: 네이버 확인으로 넣은 지점은 제한·종류·후면
        return json({ v: 1, items }, 200, cors, 300);
      }

      // v202 실시간 신고 확인 (2026-11-24 운전자 '단속경보나 경고없을때 눌렀을때 에뮬레이터가 일을 하지 않는다면 찾아서 적용하고 그 사용자에게
      // 신고 반영 완료를 작게나마 알림 토스트로 가볍게 3초 띄어주고 … 바로바로 실시간으로 적용되게'):
      //   POST /check            앱: 경고 없이 누른 '잘못된 정보 신고' {id, dev, lat, lng, h, kmh[, trail(운영자 차만)]} → 대기열. {ok, id, pos}
      //   GET  /check/status?ids 앱: 내 요청들의 상태 {items:{id:{st:'queued'|'checking'|'found'|'none'|'unchecked'|'unknown', cams?:[{limit,kind}]}}}
      //   GET  /check/next       운영자(에뮬레이터 실행기): 하나 꺼냄 {job:{id, kind:'user'|'auto', lat, lng, heading, kmh?, trail:[[lat,lng]…], …}}, 없으면 204.
      //                          사용자 신고가 없으면 통과 통계에서 경고 없이 자주 지난 카메라를 낮은 순위로 (한 카메라 7일에 한 번)
      //   POST /check/result     운영자: {id, status:'found'|'none'|'unchecked', cams:[{lat,lng,heading,limit,kind,rel,shots,evidence}], run, checked, reason}
      //                          'found' 는 그 자리·방향·제한·종류를 운영자 고침(신고 지점, 바로 모든 사용자)으로 넣는다. 'none' 도 버리지 않고 사용자 신고면
      //                          약 100m 격자·8방위로 모은다(신고 수·기기 수·날 수). 지우는 것은 없음(양방향 두 번 규칙은 운영자가)
      //   GET  /check/unmatched  운영자: 네이버에도 없는데 신고가 몰리는 곳 {v:1, items:[{cell, lat, lng, dir, n, devices, days, last, candidate}]}
      //   GET  /check/results    운영자: 최근 결과 100개
      if (url.pathname === '/check' && isCheckPost) {
        if (!env.LOGS) return json({ ok: false }, 200, cors);
        const text = await req.text();
        if (text.length > (isAdmin ? 60000 : 4000)) return json({ error: 'too large' }, 413, cors);
        let b;
        try { b = JSON.parse(text); } catch (e) { return json({ error: 'bad json' }, 400, cors); }
        const id = String((b && b.id) || ''), dev = String((b && b.dev) || ''), at = checkPt(b);
        if (!CHECK_ID.test(id) || !CHECK_ID.test(dev) || !at) return json({ error: 'bad check' }, 400, cors);
        if (await checkState(env, id)) return json({ ok: true, id, dup: true }, 200, cors);
        // 궤적은 운영자 차만 (v172 위치정보 최소 수집: 공개 사용자는 신고 자리·방향·속도만)
        const trail = isAdmin && Array.isArray(b.trail) ? b.trail.slice(-120).map(checkPt).filter(Boolean).map((q) => [q.lat, q.lng]) : [];
        const job = { id, kind: 'user', dev, lat: at.lat, lng: at.lng, heading: headOf(b.h), kmh: intIn(b.kmh, 0, 250), trail, v: appVer(b.v), at: Date.now() };
        const qk = 'chkq:0:' + String(Date.now()).padStart(13, '0') + ':' + id;
        await env.LOGS.put(qk, JSON.stringify(job), { expirationTtl: CHECK_STATE_TTL });
        await putCheckState(env, id, { st: 'queued', kind: 'user', at: Date.now(), q: qk, dev, lat: at.lat, lng: at.lng, h: job.heading });
        let pos = 1;
        try { pos = (await env.LOGS.list({ prefix: 'chkq:', limit: 1000 })).keys.length || 1; } catch (e) { /* 모름 */ }
        return json({ ok: true, id, pos }, 200, cors);
      }
      if (url.pathname === '/check/status') {
        if (!env.LOGS) return json({ items: {} }, 200, cors);
        const ids = String(p.get('ids') || '').split(',').filter((x) => CHECK_ID.test(x)).slice(0, 10);
        const items = {};
        for (const id of ids) {
          const st = await checkState(env, id);
          items[id] = !st ? { st: 'unknown' } : Object.assign({ st: st.st }, st.cams ? { cams: st.cams } : {});
        }
        return json({ items }, 200, cors);
      }
      if (url.pathname === '/check/next') {
        if (!env.LOGS) return new Response(null, { status: 204, headers: cors });
        const l = await env.LOGS.list({ prefix: 'chkq:', limit: 20 });
        for (const k of l.keys) {
          const raw = await env.LOGS.get(k.name);
          if (env.LOGS.delete) await env.LOGS.delete(k.name); else await env.LOGS.put(k.name, '', { expirationTtl: 60 });
          let job = null;
          try { job = JSON.parse(raw || 'null'); } catch (e) { job = null; }
          if (!job || !job.id) continue;
          const st = (await checkState(env, job.id)) || {};
          await putCheckState(env, job.id, Object.assign(st, { st: 'checking', taken: Date.now(), job }));
          return json({ job }, 200, cors);
        }
        const auto = await autoCheckJob(env);
        return auto ? json({ job: auto }, 200, cors) : new Response(null, { status: 204, headers: cors });
      }
      if (url.pathname === '/check/result' && isCheckPost) {
        if (!env.LOGS) return json({ ok: false }, 200, cors);
        const text = await req.text();
        if (text.length > 60000) return json({ error: 'too large' }, 413, cors);
        let b;
        try { b = JSON.parse(text); } catch (e) { return json({ error: 'bad json' }, 400, cors); }
        const id = String((b && b.id) || ''), status = String((b && b.status) || '');
        if (!CHECK_ID.test(id) || !['found', 'none', 'unchecked'].includes(status)) return json({ error: 'bad result' }, 400, cors);
        const st = (await checkState(env, id)) || { kind: 'user', at: Date.now() };
        const job = st.job || {};
        const day = kstDay();
        const applied = [];
        if (status === 'found' && Array.isArray(b.cams)) {
          const list = await loadFixes(env);
          for (const c of b.cams.slice(0, 6)) {
            const pt = checkPt(c), lim = intIn(c && c.limit, 20, 130), map = CHECK_KIND[String((c && c.kind) || '').replace(/\s+/g, '')];
            if (!pt || !lim || !map) continue;
            const h = headOf(c.heading != null ? c.heading : job.heading);
            const here = { lat: pt.lat, lng: pt.lng, h };
            let e = list.find((x) => x.kind === 'spot' && distM(x, here) <= FIX_NEAR_M && headOk(x.h, h));
            if (!e) {
              if (list.length >= FIX_MAX) continue;
              e = { kind: 'spot', k: pt.lat.toFixed(4) + ',' + pt.lng.toFixed(4) + ',' + dir8(h), lat: pt.lat, lng: pt.lng, h, devs: [], ips: [], first: day, last: day };
              list.push(e);
            }
            e.lim = lim; e.ck = map[0]; if (map[1]) e.fl = map[1]; else delete e.fl;
            e.op = true; e.ok = e.ok || day; e.last = day; e.src = 'check'; delete e.rev;
            if (job.dev && !e.devs.includes(job.dev) && e.devs.length < 20) e.devs.push(job.dev);
            applied.push({ limit: lim, kind: String(c.kind).replace(/\s+/g, '') });
          }
          if (applied.length) await saveFixes(env, list);
        }
        // 네이버에도 없음: 사용자 신고면 격자·방위로 모은다 (앱에는 반영하지 않음, 운영자 화면용)
        if (status === 'none' && st.kind !== 'auto') {
          const ref = checkPt(job) || checkPt(st);
          if (ref) {
            const h = job.heading != null ? job.heading : st.h;
            const cell = Math.floor(ref.lat * 1000) + ',' + Math.floor(ref.lng * 1000), key = 'unm:' + cell + ':' + dir8(h);
            let u = null;
            try { u = JSON.parse((await env.LOGS.get(key)) || 'null'); } catch (e) { u = null; }
            if (!u) u = { n: 0, devs: [], days: [], last: day };
            u.n++; u.last = day;
            const dv = job.dev || st.dev;
            if (dv && !u.devs.includes(dv) && u.devs.length < 50) u.devs.push(dv);
            if (!u.days.includes(day)) { u.days.push(day); if (u.days.length > 60) u.days.shift(); }
            await env.LOGS.put(key, JSON.stringify(u));
          }
        }
        const res = { st: status, kind: st.kind || 'user', at: st.at, done: Date.now(), cams: applied, dev: st.dev, lat: st.lat != null ? st.lat : job.lat, lng: st.lng != null ? st.lng : job.lng, h: st.h != null ? st.h : job.heading };
        await putCheckState(env, id, res);
        await env.LOGS.put('chkr:' + String(EVR_BASE - Date.now()).padStart(16, '0') + ':' + id, JSON.stringify(Object.assign({ id, reason: b.reason ? String(b.reason).slice(0, 200) : undefined,
          run: b.run ? String(b.run).slice(0, 80) : undefined, found: Array.isArray(b.cams) ? b.cams.slice(0, 6) : [] }, res, { dev: undefined })), { expirationTtl: CHECK_RES_TTL });
        return json({ ok: true, applied: applied.length }, 200, cors);
      }
      if (url.pathname === '/check/unmatched') {
        if (!env.LOGS) return json({ v: 1, items: [] }, 200, cors);
        const l = await env.LOGS.list({ prefix: 'unm:', limit: 1000 });
        const items = [];
        for (const k of l.keys) {
          let u = null;
          try { u = JSON.parse((await env.LOGS.get(k.name)) || 'null'); } catch (e) { u = null; }
          if (!u) continue;
          const m = /^unm:(-?\d+),(-?\d+):([0-7x])$/.exec(k.name);
          if (!m) continue;
          const devices = u.devs.length, days = u.days.length;
          items.push({ cell: m[1] + ',' + m[2], lat: (+m[1] + 0.5) / 1000, lng: (+m[2] + 0.5) / 1000, dir: m[3] === 'x' ? null : +m[3] * 45,
            n: u.n, devices, days, last: u.last, candidate: devices >= 2 || days >= 2 });
        }
        items.sort((a, b) => (b.candidate - a.candidate) || (b.n - a.n));
        return json({ v: 1, items }, 200, cors);
      }
      if (url.pathname === '/check/results') {
        if (!env.LOGS) return json({ items: [] }, 200, cors);
        const l = await env.LOGS.list({ prefix: 'chkr:', limit: 100 });
        const items = (await Promise.all(l.keys.map((k) => env.LOGS.get(k.name)))).filter(Boolean).map((v) => { try { return JSON.parse(v); } catch (e) { return null; } }).filter(Boolean);
        return json({ items }, 200, cors);
      }

      // v196 카메라 통과 익명 통계 (2026-11-24 운전자 '앞으로 우리 테슬라클러스터 네비 이용자들 지나간곳 모조리 체크해서 과속 단속 체크해줘
      // 신고를 하지 않았더라도 내역도 남겨놓고'): 앱은 단속 카메라를 지날 때마다 그 차 안에서 경고를 띄웠는지 판정하고, 몇 분씩 모아 순서를 섞어 보낸다.
      // 받은 묶음은 저장하지 않는다. 카메라별·날짜별 합계(통과·경고·같은 자리 다른 행이 경고·놓침·제한 모름으로 숨김·'틀림' 표시·길안내·
      // 과속 통과·경고 거리 합)에 더하기만 한다. 기기 번호·접속 번호·IP·차 위치·시각은 받지도 저장하지도 않는다.
      // 자료에 없는 단속 후보(달리다 크게 줄였다 다시 올린 곳, 400m 안에 우리 카메라 없음)는 약 100m 격자·8방위·감속 폭만 받아 격자·날짜별 합계로 둔다.
      // 운영자 차(토큰)만 통과마다 카메라·시각·가장 가까웠던 거리·놓친 곳의 궤적을 op_pass 에 남긴다.
      // v198: 통과 한 건씩도 pass_rec 에 남긴다(카메라·날짜·앱 버전·경고 여부·경고 거리·속도·제한·길안내·판정, 주행 번호·시각·위치 없이).
      // 보관: 통과 기록·카메라 날짜별 합계·후보 격자는 지우지 않고, 운영자 차 기록 90일 (그날 첫 요청 때 지운다).
      // 운영자 통로(토큰): GET /passes?days=30[&op=1&opDays=7&candDays=2&candN=3]
      if (url.pathname === '/pass' && isPassPost) {
        const text = await req.text();
        if (text.length > (isAdmin ? 300000 : 30000)) return json({ error: 'too large' }, 413, cors);
        let b;
        try { b = JSON.parse(text); } catch (e) { return json({ error: 'bad json' }, 400, cors); }
        if (!b || typeof b !== 'object') return json({ error: 'bad pass' }, 400, cors);
        const db = await passDb(env);
        if (!db) return json({ ok: false, why: 'off' }, 200, cors);
        const today = kstDay();
        const items = Array.isArray(b.items) ? b.items.slice(0, 150) : [];
        const cands = Array.isArray(b.cand) ? b.cand.slice(0, 20) : [];
        const ops = isAdmin && Array.isArray(b.op) ? b.op.slice(0, 30) : [];
        if (!isAdmin) {
          day.pass += items.length + cands.length;
          if (day.pass > DAY_CAP.pass) return json({ ok: false, why: 'cap' }, 200, cors);
        }
        const stmts = [];
        const nCams = passStmts(db, items, (d) => passDay(d, today), appVer(b.v), stmts);
        const cagg = new Map();
        for (const c of cands) {
          if (!c || typeof c !== 'object' || c.x) continue;   // v219: 시험 페이지 기록은 버린다
          const cell = String(c.c || ''), m = CELL_KEY.exec(cell), o = intIn(c.o, 0, 7), dr = intIn(c.dr, 10, 120);
          if (!m || o === null || dr === null || !inKorea(+m[1] / 1000, +m[2] / 1000)) continue;
          const d = passDay(c.d, today), key = d + '#' + cell + '#' + o;
          if (d === null) continue;
          const e = cagg.get(key) || { day: d, cell, dir: o, n: 0, dsum: 0 };
          e.n++; e.dsum += dr;
          cagg.set(key, e);
        }
        if (cagg.size) {
          stmts.push(db.prepare('INSERT INTO cand_day (day, cell, dir, n, dsum) ' +
            "SELECT json_extract(value, '$.day'), json_extract(value, '$.cell'), json_extract(value, '$.dir'), json_extract(value, '$.n'), json_extract(value, '$.dsum') " +
            'FROM json_each(?) WHERE true ON CONFLICT(day, cell, dir) DO UPDATE SET n = n + excluded.n, dsum = dsum + excluded.dsum').bind(JSON.stringify([...cagg.values()])));
        }
        const opRows = [];
        for (const r of ops) {
          if (!r || typeof r !== 'object' || r.x || !PASS_KEY.test(String(r.k || ''))) continue;
          if (passDay(r.d, today) === null) continue;   // v219
          const s = JSON.stringify(r);
          if (s.length > 8000) continue;
          const at = Number.isFinite(+r.t) && +r.t > 0 ? Math.round(+r.t) : Date.now();
          opRows.push({ at, day: passDay(r.d, today), cam: String(r.k), missed: !(r.a > 0) && !r.g && !r.hid ? 1 : 0, rec: s });
        }
        if (opRows.length) {
          stmts.push(db.prepare('INSERT INTO op_pass (at, day, cam, missed, rec) ' +
            "SELECT json_extract(value, '$.at'), json_extract(value, '$.day'), json_extract(value, '$.cam'), json_extract(value, '$.missed'), json_extract(value, '$.rec') " +
            'FROM json_each(?)').bind(JSON.stringify(opRows)));
        }
        passCleanup(db, today, stmts);
        if (stmts.length) await db.batch(stmts);
        return json({ ok: true, cams: nCams, cand: cagg.size, op: opRows.length }, 200, cors);
      }
      if (url.pathname === '/passes') {
        const today = kstDay();
        const db = await passDb(env);
        if (!db) return json({ v: 1, day: today, stats: false, cams: [], cands: [], daily: [], op: [] }, 200, cors);
        const days = intIn(p.get('days'), 1, 400) || 30, from = dayBefore(today, days - 1);
        const candDays = intIn(p.get('candDays'), 1, 30) || 2, candN = intIn(p.get('candN'), 1, 1000) || 3;
        const [r1, r2, r3] = await Promise.all([
          db.prepare('SELECT cam, MAX(lim) AS lim, MAX(kind) AS kind, SUM(n) AS n, SUM(alerted) AS alerted, SUM(covered) AS covered, SUM(missed) AS missed, ' +
            'SUM(hidden) AS hidden, SUM(flagged) AS flagged, SUM(navn) AS navn, SUM(over) AS over, SUM(adist) AS adist, COUNT(*) AS days, MAX(day) AS last ' +
            'FROM cam_day WHERE day >= ? GROUP BY cam ORDER BY SUM(missed) DESC, SUM(n) DESC LIMIT 3000').bind(from).all(),
          db.prepare('SELECT cell, dir, SUM(n) AS n, SUM(dsum) AS dsum, COUNT(DISTINCT day) AS days, MAX(day) AS last FROM cand_day WHERE day >= ? ' +
            'GROUP BY cell, dir HAVING COUNT(DISTINCT day) >= ? AND SUM(n) >= ? ORDER BY SUM(n) DESC LIMIT 500').bind(from, candDays, candN).all(),
          db.prepare('SELECT day, SUM(n) AS n, SUM(alerted) AS alerted, SUM(covered) AS covered, SUM(missed) AS missed, SUM(hidden) AS hidden ' +
            'FROM cam_day WHERE day >= ? GROUP BY day ORDER BY day').bind(from).all(),
        ]);
        const cams = (r1.results || []).map((r) => {
          const m = PASS_KEY.exec(r.cam) || [];
          return { k: r.cam, lat: +m[1], lng: +m[2], dir: m[3] && m[3] !== 'x' ? +m[3] * 45 : null, lim: r.lim, kind: r.kind, n: r.n,
            alerted: r.alerted, covered: r.covered, missed: r.missed, hidden: r.hidden, flagged: r.flagged, nav: r.navn, over: r.over,
            missRate: r.n ? Math.round(r.missed / r.n * 1000) / 1000 : 0, overRate: r.n ? Math.round(r.over / r.n * 1000) / 1000 : 0,
            avgAlert: r.alerted ? Math.round(r.adist / r.alerted) : null, days: r.days, last: r.last };
        });
        const cands = (r2.results || []).map((r) => {
          const m = CELL_KEY.exec(r.cell) || [];
          return { cell: r.cell, lat: +m[1] / 1000, lng: +m[2] / 1000, dir: r.dir * 45, n: r.n, days: r.days, avgDrop: r.n ? Math.round(r.dsum / r.n) : 0, last: r.last };
        });
        let op = [];
        if (p.get('op') === '1') {
          const opDays = intIn(p.get('opDays'), 1, PASS_OP_DAYS) || 7;
          const r4 = await db.prepare('SELECT rec FROM op_pass WHERE day >= ? ORDER BY missed DESC, at DESC LIMIT 400').bind(dayBefore(today, opDays - 1)).all();
          op = (r4.results || []).map((r) => { try { return JSON.parse(r.rec); } catch (e) { return null; } }).filter(Boolean);
        }
        const r5 = await db.prepare('SELECT id, day, kind, lat, lng, h, cam, ref, basis FROM handoff ORDER BY id DESC LIMIT 300').all();
        const clean = [];
        passCleanup(db, today, clean);
        if (clean.length) await db.batch(clean);
        return json({ v: 1, day: today, from, stats: true, cams, cands, daily: r3.results || [], op, handoff: r5.results || [] }, 200, cors);
      }

      // v198 테스터 주행 경로 (2026-11-24 운전자 '어차피 다 테스터이고 익명이라서 누군지는 몰라 그래서 쓸 수 있음', 테스터 전원 쪽지 동의,
      // '출발지 도착지 모두 남는 방향으로 해 줘 원본은 30일 뒤에 자동으로 지우는걸로 하고 대신에 저 경로 원본이 지워지더라도 참고했던 과속단속 정보는 남아있어야 해'):
      // 앱이 주행마다 무작위 번호(rid)로 10분마다·주행 끝에 조각(part)을 보낸다. 점 [출발 뒤 초, 위도·경도 10만 배 정수, 속도, 방향], 카메라 통과 표시.
      // 원본은 trips 에 30일 (그날 첫 요청 때 지움). 기기 번호·IP·브라우저는 받지도 저장하지도 않는다.
      // 받을 때 바로 처리: 그 차가 통과 통계(/pass)를 끈 경우(ps 0)에만 조각의 카메라 통과를 pass_rec·cam_day 에 넣는다 (켠 차는 /pass 로 이미 보냄, 두 번 세지 않게).
      // 운영자 통로(토큰): GET /trips?days=7 | ?day=YYYY-MM-DD (주행 목록) · GET /trips?rid=… (한 주행의 조각 모두)
      if (url.pathname === '/trip' && isTripPost) {
        const text = await req.text();
        if (text.length > 150000) return json({ error: 'too large' }, 413, cors);
        let b;
        try { b = JSON.parse(text); } catch (e) { return json({ error: 'bad json' }, 400, cors); }
        const rid = String((b && b.rid) || '');
        if (!/^[a-z0-9]{8,24}$/.test(rid)) return json({ error: 'bad trip' }, 400, cors);
        if (b.x) return json({ ok: true, dropped: 'test' }, 200, cors);   // v219: 시험 페이지에서 만든 주행 (받은 것으로 알려 다시 보내지 않게)
        const db = await passDb(env);
        if (!db) return json({ ok: false, why: 'off' }, 200, cors);
        if (!isAdmin && ++day.trip > DAY_CAP.trip) return json({ ok: false, why: 'cap' }, 200, cors);
        const today = kstDay();
        const d = typeof b.d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(b.d) && daysBetween(b.d, today) >= -1 && daysBetween(b.d, today) <= TRIP_DAYS ? b.d : today;
        const pts = [];
        let km = 0, prev = null;
        for (const q of (Array.isArray(b.pts) ? b.pts.slice(0, 3000) : [])) {
          if (!Array.isArray(q)) continue;
          const s = intIn(q[0], 0, 172800), la = intIn(q[1], 3300000, 3900000), lo = intIn(q[2], 12400000, 13200000);
          if (s === null || la === null || lo === null) continue;
          const pt = [s, la, lo, intIn(q[3], 0, 300) || 0, intIn(q[4], -1, 359) ?? -1];
          if (prev) km += distM({ lat: prev[1] / 1e5, lng: prev[2] / 1e5 }, { lat: la / 1e5, lng: lo / 1e5 }) / 1000;
          prev = pt;
          pts.push(pt);
        }
        const cams = [];
        for (const c of (Array.isArray(b.cams) ? b.cams.slice(0, 400) : [])) {
          if (!c || typeof c !== 'object' || !PASS_KEY.test(String(c.k || ''))) continue;
          cams.push({ s: intIn(c.s, 0, 172800) || 0, k: String(c.k), lim: intIn(c.lim, 0, 130) || 0, kind: PASS_KINDS.has(+c.kind) ? +c.kind : 0, a: intIn(c.a, 0, 5000) || 0,
            g: c.g ? 1 : 0, hid: intIn(c.hid, 0, 3) || 0, kmh: intIn(c.kmh, 0, 250) || 0, nav: c.nav ? 1 : 0, minD: intIn(c.minD, 0, 100) });
        }
        if (!pts.length && !cams.length) return json({ ok: true, stored: 0 }, 200, cors);
        const misses = cams.filter((c) => passRes(c.a, c.g, c.hid) === 'miss').length;
        // v231: 접속 번호(sid)·조각 첫 점 시각(t0). 모양이 다르거나 시각이 지금에서 사흘 넘게 멀면 비운다
        const sid = /^[a-z0-9]{1,16}$/.test(String(b.sid || '')) ? String(b.sid) : null;
        const t0n = Number(b.t0), t0 = Number.isFinite(t0n) && Math.abs(Date.now() - t0n) <= 3 * 86400000 ? Math.round(t0n) : null;
        const stmts = [db.prepare('INSERT INTO trips (day, rid, part, endf, op, v, n, km, ncam, misses, pts, cams, sid, t0) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .bind(d, rid, intIn(b.part, 0, 100000) || 0, b.end ? 1 : 0, isAdmin ? 1 : 0, appVer(b.v), pts.length, Math.round(km * 100) / 100, cams.length, misses,
            JSON.stringify(pts), JSON.stringify(cams), sid, t0)];
        if (b.ps === 0) passStmts(db, cams, () => d, appVer(b.v), stmts);   // 통과 통계를 끈 차: 경로 조각에서 바로 통과 기록을 남긴다
        passCleanup(db, today, stmts);
        await db.batch(stmts);
        return json({ ok: true, stored: pts.length, cams: cams.length }, 200, cors);
      }
      if (url.pathname === '/trips') {
        const today = kstDay(), from = dayBefore(today, TRIP_DAYS);
        const db = await passDb(env);
        if (!db) return json({ v: 1, stats: false, trips: [] }, 200, cors);
        const rid = String(p.get('rid') || '');
        if (rid) {
          if (!/^[a-z0-9]{8,24}$/.test(rid)) return json({ error: 'bad rid' }, 400, cors);
          const r = await db.prepare('SELECT day, part, endf, op, v, sid, t0, pts, cams FROM trips WHERE rid = ? AND day >= ? ORDER BY part').bind(rid, from).all();
          const parts = (r.results || []).map((x) => ({ day: x.day, part: x.part, end: x.endf, op: x.op, v: x.v, sid: x.sid || null, t0: x.t0 == null ? null : x.t0,
            pts: JSON.parse(x.pts || '[]'), cams: JSON.parse(x.cams || '[]') }));
          return json({ v: 1, rid, parts }, 200, cors);
        }
        const one = /^\d{4}-\d{2}-\d{2}$/.test(p.get('day') || '') ? p.get('day') : null;
        const days = intIn(p.get('days'), 1, TRIP_DAYS) || 7;
        const lo = one || dayBefore(today, days - 1), hi = one || today;
        // v231: sids = 그 주행 조각들의 접속 번호(새로고침하면 여럿, 쉼표로), t0 = 가장 이른 조각 첫 점 시각
        const r = await db.prepare('SELECT rid, MIN(day) AS day, COUNT(*) AS parts, SUM(n) AS n, SUM(km) AS km, SUM(ncam) AS ncam, SUM(misses) AS misses, ' +
          'MAX(op) AS op, MAX(v) AS v, MAX(endf) AS ended, GROUP_CONCAT(DISTINCT sid) AS sids, MIN(t0) AS t0 FROM trips WHERE day >= ? AND day >= ? AND day <= ? GROUP BY rid ORDER BY MIN(id) DESC LIMIT 300')
          .bind(from, lo, hi).all();
        return json({ v: 1, stats: true, keepDays: TRIP_DAYS, trips: (r.results || []).map((x) => Object.assign(x, { km: Math.round(x.km * 10) / 10 })) }, 200, cors);
      }
      // v198 넘긴 내역: 주행 원본에서 찾아 고침 후보·신고 지점으로 넘긴 것을 남긴다(어디, 어느 방향, 근거). 원본과 따로, 지우지 않는다.
      // 운영자(토큰)만: POST /handoff {items:[{kind: fix|spot|miss|cand|note, lat, lng, h, cam, ref, basis}]}. 읽기는 /passes 의 handoff
      if (url.pathname === '/handoff' && isHandoffPost) {
        const text = await req.text();
        if (text.length > 40000) return json({ error: 'too large' }, 413, cors);
        let b;
        try { b = JSON.parse(text); } catch (e) { return json({ error: 'bad json' }, 400, cors); }
        const db = await passDb(env);
        if (!db) return json({ ok: false, why: 'off' }, 200, cors);
        const today = kstDay(), KINDS = new Set(['fix', 'spot', 'miss', 'cand', 'note']), rows = [];
        for (const it of (Array.isArray(b && b.items) ? b.items.slice(0, 50) : [])) {
          if (!it || typeof it !== 'object' || !KINDS.has(it.kind)) continue;
          const lat = +it.lat, lng = +it.lng, basis = String(it.basis || '').slice(0, 600);
          if (!inKorea(lat, lng) || !basis) continue;
          rows.push({ day: today, kind: it.kind, lat: +lat.toFixed(6), lng: +lng.toFixed(6), h: intIn(it.h, 0, 359), cam: PASS_KEY.test(String(it.cam || '')) ? String(it.cam) : null,
            ref: String(it.ref || '').slice(0, 80), basis });
        }
        if (rows.length) {
          await db.prepare('INSERT INTO handoff (day, kind, lat, lng, h, cam, ref, basis) ' +
            "SELECT json_extract(value, '$.day'), json_extract(value, '$.kind'), json_extract(value, '$.lat'), json_extract(value, '$.lng'), json_extract(value, '$.h'), " +
            "json_extract(value, '$.cam'), json_extract(value, '$.ref'), json_extract(value, '$.basis') FROM json_each(?)").bind(JSON.stringify(rows)).run();
        }
        return json({ ok: true, added: rows.length }, 200, cors);
      }

      // 운영 모니터링: 페이지가 보내는 접속·오류 이벤트 (위치 없음, 7일 보관)
      if (url.pathname === '/event' && isEventPost) {
        if (!env.LOGS) return json({ ok: false }, 200, cors);
        const text = await req.text();
        if (text.length > 20000) return json({ error: 'too large' }, 413, cors);
        let ev;
        try { ev = JSON.parse(text); } catch (e) { return json({ error: 'bad json' }, 400, cors); }
        if (!ev || typeof ev !== 'object') return json({ error: 'bad event' }, 400, cors);
        Object.keys(ev).forEach((k) => { if (typeof ev[k] === 'string') ev[k] = ev[k].slice(0, 1000); });
        // v172: 운영자 차가 아니면 위치 궤적은 저장하지 않는다 (위치정보 최소 수집. 앱도 공개 사용자는 궤적을 보내지 않는다)
        if (!isAdmin) { delete ev.trace; delete ev.track; }
        const ts = Date.now();
        ev.serverAt = ts;
        ev.country = (req.cf && req.cf.country) || '';
        // KV 목록은 키 이름 순서로 앞에서부터 1000개만 준다. 예전처럼 시각 오름차순 키('evt:')면 기록이 1000개를 넘는 순간
        // 새 기록이 목록에 안 보인다(2026-11-14 실제로 11:30 뒤 기록이 안 보였음). 그래서 최신이 맨 앞에 오도록 뒤집은 시각으로 저장한다
        const key = 'evr:' + String(EVR_BASE - ts).padStart(16, '0') + ':' + crypto.randomUUID().slice(0, 6);
        await env.LOGS.put(key, JSON.stringify(ev), { expirationTtl: 60 * 60 * 24 * 7 });
        return json({ ok: true }, 200, cors);
      }
      if (url.pathname === '/events') {
        if (!env.LOGS) return json({ items: [] }, 200, cors);
        const since = Number(p.get('since')) || 0;
        // v161 (2026-11-20): 예전엔 최신 50건만 줘서 그보다 오래된 놓침·틀림 신고를 볼 수 없었다.
        // before=<ms> 를 주면 그 시각보다 오래된 것 중 최신부터 limit 개(기본 50, 최대 200)를 시간순으로 준다(목록을 최대 10쪽까지 넘김).
        // 답의 oldest 를 다음 before 로 주면 더 예전으로 간다. before 가 없으면 예전과 똑같다(최신 50건, since 보다 새 것만)
        const before = Number(p.get('before')) || 0;
        const lim = Math.min(200, Math.max(1, Number(p.get('limit')) || 50));
        const tOf = (n) => EVR_BASE - Number(n.split(':')[1]);
        let keys;
        if (before) {
          keys = [];
          let cur;
          for (let page = 0; page < 10 && keys.length < lim; page++) {
            const l = await env.LOGS.list({ prefix: 'evr:', limit: 1000, cursor: cur });
            for (const k of l.keys) {
              const t = tOf(k.name);
              if (t < before && t > since) { keys.push(k.name); if (keys.length >= lim) break; }
            }
            if (l.list_complete || !l.cursor) break;
            cur = l.cursor;
          }
          keys.reverse();
        } else {
          // 최신 기록부터 (목록 한 번). since 보다 새 것만, 최대 limit(기본 50)개를 시간순으로
          const listed = await env.LOGS.list({ prefix: 'evr:', limit: 1000 });
          keys = listed.keys.map((k) => k.name).filter((n) => tOf(n) > since).slice(0, lim).reverse();
        }
        // 예전 형식('evt:') 기록: legacy=1 일 때만 끝까지 넘겨 가며 찾는다 (목록 호출이 여러 번 들어 평소엔 안 씀. 7일 뒤 모두 사라짐)
        if (p.get('legacy') === '1') {
          let cursor, old = [];
          for (let page = 0; page < 10; page++) {
            const l = await env.LOGS.list({ prefix: 'evt:', limit: 1000, cursor });
            old = old.concat(l.keys.map((k) => k.name).filter((n) => Number(n.split(':')[1]) > since));
            if (l.list_complete || !l.cursor) break;
            cursor = l.cursor;
          }
          keys = old.sort().slice(-50).concat(keys).slice(-50);
        }
        let items = (await Promise.all(keys.map((k) => env.LOGS.get(k)))).filter(Boolean).map((v) => {
          try { return JSON.parse(v); } catch (e) { return { raw: v }; }
        }).sort((a, b) => (a.serverAt || 0) - (b.serverAt || 0));
        const oldest = items.length ? items[0].serverAt || null : null;
        if (p.get('user') === '1') items = items.filter((e) => e.user);   // 운전자가 누른 '놓침'·'틀림'만
        return json(before ? { items, oldest } : { items }, 200, cors);
      }

      // v225 (2026-11-24 운전자 테슬라 '의견을 보내고 싶은데도 못 보내네'): 테슬라 브라우저는 음성 인식 서버에 닿지 못해(network) 말을 글자로 못 바꾼다.
      // 그래서 앱이 녹음(MediaRecorder)을 올린다. 누구나 한 번에 하나(400KB 까지), 30일 보관, 같은 qid 로 다시 보내면 덮어쓴다(재시도해도 하나).
      // 위치·카드는 받지 않는다 — 그건 같은 qid 의 /event 'feedback' 에 있다. 듣기(GET)는 운영자만: /fb (목록), /fb?id=
      if (url.pathname === '/fb') {
        if (!env.LOGS) return json({ error: 'storage not configured' }, 501, cors);
        if (isFbPost) {
          const text = await req.text();
          if (text.length > 400000) return json({ error: 'too large' }, 413, cors);
          let b;
          try { b = JSON.parse(text); } catch (e) { return json({ error: 'bad json' }, 400, cors); }
          if (!b || typeof b.b64 !== 'string' || !b.b64 || !/^audio\/[a-z0-9.+-]+/i.test(String(b.mime || ''))) return json({ error: 'bad audio' }, 400, cors);
          if (b.x) return json({ ok: true, dropped: 'test' }, 200, cors);
          const id = String(b.qid || '').replace(/[^a-z0-9-]/gi, '').slice(0, 40) || crypto.randomUUID().replace(/-/g, '').slice(0, 12);
          const rec = { at: Date.now(), mime: String(b.mime).slice(0, 60), sec: Math.max(0, Math.min(60, Number(b.sec) || 0)), v: String(b.v || '').slice(0, 30),
            sid: String(b.sid || '').slice(0, 20), qid: id, country: (req.cf && req.cf.country) || '', b64: b.b64 };
          await env.LOGS.put('fba:' + id, JSON.stringify(rec), { expirationTtl: 60 * 60 * 24 * 30 });
          return json({ ok: true, id }, 200, cors);
        }
        const id = (p.get('id') || '').replace(/[^a-z0-9-]/gi, '');
        if (id) {
          const v = await env.LOGS.get('fba:' + id);
          return v ? new Response(v, { status: 200, headers: { ...cors, 'Content-Type': 'application/json' } }) : json({ error: 'not found' }, 404, cors);
        }
        const l = await env.LOGS.list({ prefix: 'fba:', limit: 200 });
        return json({ ids: l.keys.map((k) => k.name.slice(4)) }, 200, cors);
      }

      if (url.pathname === '/log') {
        if (!env.LOGS) return json({ error: 'log storage not configured' }, 501, cors);
        if (isLogPost) {
          const text = await req.text();
          if (text.length > 500000) return json({ error: 'too large' }, 413, cors);   // v172: 5MB → 500KB
          let body;
          try { body = JSON.parse(text); } catch (e) { return json({ error: 'bad json' }, 400, cors); }
          const id = crypto.randomUUID().replace(/-/g, '').slice(0, 10);
          await env.LOGS.put('log:' + id, JSON.stringify({ at: new Date().toISOString(), ...body }), { expirationTtl: 60 * 60 * 24 * 30 });
          return json({ id }, 200, cors);
        }
        const id = (p.get('id') || '').replace(/[^a-z0-9]/gi, '');
        const v = id ? await env.LOGS.get('log:' + id) : null;
        if (!v) return json({ error: 'not found' }, 404, cors);
        return new Response(v, { headers: { 'Content-Type': 'application/json; charset=utf-8', ...cors } });
      }

      if (url.pathname === '/route') {
        const start = p.get('start') || '', goal = p.get('goal') || '';
        if (!COORD.test(start) || !COORD.test(goal)) return json({ error: 'bad coords' }, 400, cors);
        // options=trafast:traoptimal:traavoidtoll 처럼 여러 개(최대 3)를 주면 경로 추천 목록(alternatives)을 돌려준다.
        // option=하나 만 주면 예전과 같은 단일 경로 응답 (예전 페이지 호환)
        const multi = [...new Set((p.get('options') || '').split(':').filter((o) => ROUTE_OPTIONS.has(o)))].slice(0, 3);
        const single = ROUTE_OPTIONS.has(p.get('option')) ? p.get('option') : 'trafast';
        const way = (p.get('waypoints') || '').split('|').filter((w) => COORD.test(w)).slice(0, 5);
        const slim = (route, opt) => ({
          option: opt,
          distance: route.summary.distance,           // m
          duration: route.summary.duration,           // ms
          tollFare: route.summary.tollFare || 0,
          fuelPrice: route.summary.fuelPrice || 0,
          path: route.path.map(([x, y]) => [round6(x), round6(y)]),  // [lng, lat]
          guide: (route.guide || []).map((g) => ({ i: g.pointIndex, t: g.type, s: g.instructions, d: g.distance, ms: g.duration })),
          sections: (route.section || []).map((s) => ({ i: s.pointIndex, n: s.pointCount, name: s.name, speed: s.speed, cong: s.congestion })),
        });
        const call = (opt) => {
          const qs = new URLSearchParams({ start, goal, option: opt });
          if (way.length) qs.set('waypoints', way.join('|'));
          return upstream(NCP + '/map-direction/v1/driving?' + qs, ncpHeaders);
        };

        if (multi.length) {
          // 한 번에 여러 옵션을 묻고, 빠진 옵션이 있으면 그것만 따로 묻는다
          const r = await call(multi.join(':'));
          const got = {};
          if (r.ok && r.data.code === 0 && r.data.route) multi.forEach((o) => { if (r.data.route[o] && r.data.route[o][0]) got[o] = r.data.route[o][0]; });
          const missing = multi.filter((o) => !got[o]);
          if (missing.length) {
            const more = await Promise.all(missing.map((o) => call(o)));
            more.forEach((m, k) => { if (m.ok && m.data.code === 0 && m.data.route && m.data.route[missing[k]]) got[missing[k]] = m.data.route[missing[k]][0]; });
          }
          const alternatives = multi.filter((o) => got[o]).map((o) => slim(got[o], o));
          if (!alternatives.length) return json({ error: 'no route', code: r.data && r.data.code, message: brief(r.data) }, 404, cors);
          return json({ alternatives }, 200, cors);
        }

        // v175: 같은 접속지에서 15초에 ROUTE_BURST 번까지 (예전 ROUTE_LIMIT 바인딩·15초 한 번은 공유 IP 의 여러 차를 막아서 쓰지 않는다)
        {
          const now = Date.now();
          let rh = routeHits.get(ip);
          if (!rh || now - rh.t > ROUTE_GAP_MS) { rh = { t: now, n: 0 }; routeHits.set(ip, rh); if (routeHits.size > 5000) routeHits.clear(); }
          if (++rh.n > ROUTE_BURST) {
            return json({ error: 'rate limited', message: '잠시 후 다시 시도합니다', retryAfter: Math.max(1, Math.ceil((rh.t + ROUTE_GAP_MS - now) / 1000)) }, 429, cors);
          }
        }
        const r = await call(single);
        if (!r.ok) return json({ error: 'upstream', status: r.status, message: brief(r.data) }, 502, cors);
        if (r.data.code !== 0 || !r.data.route) return json({ error: 'no route', code: r.data.code, message: r.data.message }, 404, cors);
        return json(slim(r.data.route[single][0], single), 200, cors);
      }

      if (url.pathname === '/geocode') {
        const query = (p.get('query') || '').slice(0, 100);
        if (!query) return json({ error: 'query' }, 400, cors);
        const qs = new URLSearchParams({ query });
        if (COORD.test(p.get('near') || '')) qs.set('coordinate', p.get('near'));
        const r = await upstream(NCP + '/map-geocode/v2/geocode?' + qs, ncpHeaders);
        if (!r.ok) return json({ error: 'upstream', status: r.status, message: brief(r.data) }, 502, cors);
        return json({
          items: (r.data.addresses || []).slice(0, 5).map((a) => ({
            name: a.roadAddress || a.jibunAddress, addr: a.jibunAddress, lng: +a.x, lat: +a.y, dist: a.distance,
          })),
        }, 200, cors, 86400);
      }

      if (url.pathname === '/reverse') {
        const coords = p.get('coords') || '';
        if (!COORD.test(coords)) return json({ error: 'bad coords' }, 400, cors);
        const qs = new URLSearchParams({ coords, output: 'json', orders: 'roadaddr,addr' });
        const r = await upstream(NCP + '/map-reversegeocode/v2/gc?' + qs, ncpHeaders);
        if (!r.ok) return json({ error: 'upstream', status: r.status, message: brief(r.data) }, 502, cors);
        const res = r.data.results || [];
        const road = res.find((x) => x.name === 'roadaddr');
        const addr = res.find((x) => x.name === 'addr');
        const area = (road || addr || {}).region || {};
        return json({
          road: road && road.land ? road.land.name : '',
          area: [area.area1, area.area2, area.area3].map((a) => (a && a.name) || '').filter(Boolean).join(' '),
        }, 200, cors, 300);
      }

      if (url.pathname === '/search') {
        const query = (p.get('query') || '').slice(0, 100);
        if (!query) return json({ error: 'query' }, 400, cors);
        if (!env.NAVER_SEARCH_ID || !env.NAVER_SEARCH_SECRET) return json({ items: [], note: 'search api not configured' }, 200, cors);
        const qs = new URLSearchParams({ query, display: '5', sort: 'random' });
        const r = await upstream('https://openapi.naver.com/v1/search/local.json?' + qs, {
          'X-Naver-Client-Id': env.NAVER_SEARCH_ID, 'X-Naver-Client-Secret': env.NAVER_SEARCH_SECRET,
        });
        if (!r.ok) return json({ error: 'upstream', status: r.status, message: brief(r.data) }, 502, cors);
        const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
        const strip = (s) => (s || '').replace(/<[^>]+>/g, '')
          .replace(/&#(\d+);/g, (m, n) => String.fromCharCode(+n))
          .replace(/&#x([0-9a-f]+);/gi, (m, n) => String.fromCharCode(parseInt(n, 16)))
          .replace(/&([a-z]+);/gi, (m, n) => (n.toLowerCase() in ENT ? ENT[n.toLowerCase()] : m));
        return json({
          items: (r.data.items || []).map((it) => ({
            name: strip(it.title), category: it.category, addr: it.roadAddress || it.address,
            lng: +it.mapx / 1e7, lat: +it.mapy / 1e7,
          })),
        }, 200, cors, 3600);
      }

      return json({ error: 'not found' }, 404, cors);
    } catch (e) {
      return json({ error: 'proxy', message: String(e && e.message || e).slice(0, 120) }, 500, cors);
    }
  },
};
