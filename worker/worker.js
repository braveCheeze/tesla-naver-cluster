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
  '/event': 60, '/log': 3, '/fix': 30, '/fixes': 60, '/events': 30, '/fix/review': 30, '/pass': 20, '/passes': 30 };
const PAID = new Set(['/route', '/geocode', '/reverse', '/search']);
const KV_WRITE = new Set(['/event', '/fix', '/fix/review']);
const DAY_CAP = { paid: 20000, kv: 900, pass: 40000 };   // pass: 하루 통과 기록 건수 (D1 무료 한도 쓰기 하루 10만 행 안)
const hits = new Map();
const day = { d: '', paid: 0, kv: 0, pass: 0 };
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
  if (day.d !== d) { day.d = d; day.paid = 0; day.kv = 0; day.pass = 0; }
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
const PASS_OP_DAYS = 90, PASS_CAND_DAYS = 180;   // 운영자 차 통과 기록·후보 격자 날짜별 합계 보관 일수 (카메라 날짜별 합계는 지우지 않는다)
const inKorea = (lat, lng) => lat > 33 && lat < 39 && lng > 124 && lng < 132;
const intIn = (v, lo, hi) => { const n = Math.round(Number(v)); return Number.isFinite(n) && n >= lo && n <= hi ? n : null; };
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
    ]).then(() => true, (e) => { passReady = null; throw e; });
  }
  await passReady;
  return env.STATS;
}
// 날짜 'YYYY-MM-DD' 가 오늘(한국)부터 3일 전 ~ 1일 뒤면 그대로, 아니면 오늘
function passDay(d, today) {
  if (typeof d !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d)) return today;
  const k = daysBetween(d, today);
  return k >= -1 && k <= 3 ? d : today;
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
    if (req.method !== 'GET' && !isLogPost && !isEventPost && !isFixPost && !isReviewPost && !isPassPost) return json({ error: 'method' }, 405, cors);
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
    if ((url.pathname === '/events' || url.pathname === '/log' || url.pathname === '/passes') && !isAdmin) {
      return json({ error: 'unauthorized' }, 401, cors);
    }
    if (!isAdmin && overDay(url.pathname)) return json({ error: 'daily limit', retryAfter: 3600 }, 429, cors);

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
    if (!allowed) return json({ error: 'origin not allowed' }, 403, cors);

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
          .map(({ e, st }) => ({ kind: e.kind, k: e.k, lat: e.lat, lng: e.lng, h: e.h, src: st === 'ok' ? 'op' : 'auto' }));
        return json({ v: 1, items }, 200, cors, 300);
      }

      // v196 카메라 통과 익명 통계 (2026-11-24 운전자 '앞으로 우리 테슬라클러스터 네비 이용자들 지나간곳 모조리 체크해서 과속 단속 체크해줘
      // 신고를 하지 않았더라도 내역도 남겨놓고'): 앱은 단속 카메라를 지날 때마다 그 차 안에서 경고를 띄웠는지 판정하고, 몇 분씩 모아 순서를 섞어 보낸다.
      // 받은 묶음은 저장하지 않는다. 카메라별·날짜별 합계(통과·경고·같은 자리 다른 행이 경고·놓침·제한 모름으로 숨김·'틀림' 표시·길안내·
      // 과속 통과·경고 거리 합)에 더하기만 한다. 기기 번호·접속 번호·IP·차 위치·시각은 받지도 저장하지도 않는다.
      // 자료에 없는 단속 후보(달리다 크게 줄였다 다시 올린 곳, 400m 안에 우리 카메라 없음)는 약 100m 격자·8방위·감속 폭만 받아 격자·날짜별 합계로 둔다.
      // 운영자 차(토큰)만 통과마다 카메라·시각·가장 가까웠던 거리·놓친 곳의 궤적을 op_pass 에 남긴다.
      // 보관: 카메라 날짜별 합계는 계속, 후보 격자 날짜별 합계 180일, 운영자 차 기록 90일 (그날 첫 /pass 때 지운다).
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
        const ops = isAdmin && Array.isArray(b.op) ? b.op.slice(0, 80) : [];
        if (!isAdmin) {
          day.pass += items.length + cands.length;
          if (day.pass > DAY_CAP.pass) return json({ ok: false, why: 'cap' }, 200, cors);
        }
        const agg = new Map();
        for (const it of items) {
          if (!it || typeof it !== 'object') continue;
          const k = String(it.k || ''), m = PASS_KEY.exec(k);
          if (!m || !inKorea(+m[1], +m[2])) continue;
          const d = passDay(it.d, today), lim = intIn(it.lim, 0, 130) || 0, a = intIn(it.a, 0, 5000) || 0;
          const hid = intIn(it.hid, 0, 3) || 0, kmh = intIn(it.kmh, 0, 250);
          let e = agg.get(d + '#' + k);
          if (!e) {
            e = { day: d, cam: k, lim, kind: PASS_KINDS.has(+it.kind) ? +it.kind : 0, n: 0, alerted: 0, covered: 0, missed: 0, hidden: 0, flagged: 0, navn: 0, over: 0, adist: 0 };
            agg.set(d + '#' + k, e);
          }
          e.n++;
          if (a > 0) { e.alerted++; e.adist += a; }   // 이 카메라 경고 카드를 띄움 (거리 합은 평균 경고 거리용)
          else if (it.g) e.covered++;                  // 같은 자리 다른 행(같은 기둥 다른 제한 등)을 경고하고 함께 지남
          else if (hid === 1) e.hidden++;              // 제한속도를 몰라 일부러 안 알림 (v179)
          else e.missed++;
          if (hid >= 2) e.flagged++;                   // 이 차에서 '틀림'으로 표시한 카메라
          if (it.nav) e.navn++;
          if (kmh !== null && lim > 0 && kmh > lim) e.over++;
        }
        const cagg = new Map();
        for (const c of cands) {
          if (!c || typeof c !== 'object') continue;
          const cell = String(c.c || ''), m = CELL_KEY.exec(cell), o = intIn(c.o, 0, 7), dr = intIn(c.dr, 10, 120);
          if (!m || o === null || dr === null || !inKorea(+m[1] / 1000, +m[2] / 1000)) continue;
          const d = passDay(c.d, today), key = d + '#' + cell + '#' + o;
          const e = cagg.get(key) || { day: d, cell, dir: o, n: 0, dsum: 0 };
          e.n++; e.dsum += dr;
          cagg.set(key, e);
        }
        const stmts = [];
        const UP = 'INSERT INTO cam_day (day, cam, lim, kind, n, alerted, covered, missed, hidden, flagged, navn, over, adist) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
          'ON CONFLICT(day, cam) DO UPDATE SET lim = excluded.lim, kind = excluded.kind, n = n + excluded.n, alerted = alerted + excluded.alerted, ' +
          'covered = covered + excluded.covered, missed = missed + excluded.missed, hidden = hidden + excluded.hidden, flagged = flagged + excluded.flagged, ' +
          'navn = navn + excluded.navn, over = over + excluded.over, adist = adist + excluded.adist';
        for (const e of agg.values()) {
          stmts.push(db.prepare(UP).bind(e.day, e.cam, e.lim, e.kind, e.n, e.alerted, e.covered, e.missed, e.hidden, e.flagged, e.navn, e.over, e.adist));
        }
        const CUP = 'INSERT INTO cand_day (day, cell, dir, n, dsum) VALUES (?, ?, ?, ?, ?) ON CONFLICT(day, cell, dir) DO UPDATE SET n = n + excluded.n, dsum = dsum + excluded.dsum';
        for (const e of cagg.values()) stmts.push(db.prepare(CUP).bind(e.day, e.cell, e.dir, e.n, e.dsum));
        let opN = 0;
        for (const r of ops) {
          if (!r || typeof r !== 'object' || !PASS_KEY.test(String(r.k || ''))) continue;
          const s = JSON.stringify(r);
          if (s.length > 8000) continue;
          const at = Number.isFinite(+r.t) && +r.t > 0 ? Math.round(+r.t) : Date.now();
          const missed = !(r.a > 0) && !r.g && !r.hid ? 1 : 0;
          stmts.push(db.prepare('INSERT INTO op_pass (at, day, cam, missed, rec) VALUES (?, ?, ?, ?, ?)').bind(at, passDay(r.d, today), String(r.k), missed, s));
          opN++;
        }
        if (passCleaned !== today) {
          passCleaned = today;
          stmts.push(db.prepare('DELETE FROM op_pass WHERE day < ?').bind(dayBefore(today, PASS_OP_DAYS)));
          stmts.push(db.prepare('DELETE FROM cand_day WHERE day < ?').bind(dayBefore(today, PASS_CAND_DAYS)));
        }
        if (stmts.length) await db.batch(stmts);
        return json({ ok: true, cams: agg.size, cand: cagg.size, op: opN }, 200, cors);
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
        return json({ v: 1, day: today, from, stats: true, cams, cands, daily: r3.results || [], op }, 200, cors);
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
