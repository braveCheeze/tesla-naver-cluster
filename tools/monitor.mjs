// 운영 모니터: 길안내 서버의 /events 를 30초마다 확인한다.
// 사람 접속은 기록만 하고, 오류(error/warn)가 오면 내용을 출력하고 종료한다 (종료 = 운영자 호출).
// 최대 3시간 돌고 끝난다.
const BASE = 'https://tesla-nav.cy6789.workers.dev';
const ORIGIN = 'https://bravecheeze.github.io';
// v172: /events 는 운영자 토큰이 있어야 읽힌다. 이 PC 의 환경 변수 TNC_ADMIN_TOKEN 에서 읽는다 (값은 출력·기록하지 않는다)
const TOKEN = process.env.TNC_ADMIN_TOKEN || '';
if (!TOKEN) { console.log('환경 변수 TNC_ADMIN_TOKEN 이 없습니다 (setx TNC_ADMIN_TOKEN … 뒤 새 터미널)'); process.exit(2); }
const BOT = /bot|crawler|spider|preview|headless/i;
let since = Date.now() - 30 * 1000;
const started = Date.now();
const seenSessions = new Set();

const fmt = (e) => `${new Date(e.serverAt).toLocaleTimeString('ko-KR', { hour12: false })} ${e.type} ${e.msg || ''}` +
  ` | v${e.v || '?'} map=${e.map || '?'} kmh=${e.kmh ?? '?'} nav=${e.nav ?? '?'} demo=${e.demo ?? '?'} gps="${e.gps || ''}"` +
  ` ${e.country || ''} sid=${e.sid || ''} ua=${(e.ua || '').slice(0, 90)}` +
  (e.src ? ` src=${e.src}` : '') + (e.stack ? `\n    stack: ${String(e.stack).split('\n').slice(0, 4).join(' | ')}` : '');

async function poll() {
  const r = await fetch(`${BASE}/events?since=${since}`, { headers: { Origin: ORIGIN, Authorization: 'Bearer ' + TOKEN } });
  if (r.status === 401) throw new Error('운영자 토큰이 맞지 않습니다 (TNC_ADMIN_TOKEN 과 Worker Secret ADMIN_TOKEN 확인)');
  const j = await r.json();
  const items = (j.items || []).filter((e) => e.serverAt > since);
  if (items.length) since = Math.max(...items.map((e) => e.serverAt));
  // 로봇, 운영자 점검, 내 로컬 테스트(localhost / Claude 앱 내장 브라우저)는 제외
  const human = items.filter((e) => !BOT.test(e.ua || '') && e.sid !== 'operator' &&
    !String(e.page || '').startsWith('localhost') && !/ Claude\//.test(e.ua || ''));
  for (const e of human) {
    if (e.type === 'session' && !seenSessions.has(e.sid)) { seenSessions.add(e.sid); console.log('[접속] ' + fmt(e)); }
  }
  // 테슬라 위치 시각 단위 문제는 v13 에서 처리됐고 접속마다 한 번 오는 진단이므로 무시한다
  const KNOWN = /^odd geolocation timestamp$/;
  const problems = human.filter((e) => (e.type === 'error' || e.type === 'warn') && !KNOWN.test(e.msg || ''));
  if (problems.length) {
    console.log('[문제 발생] ' + problems.length + '건');
    problems.forEach((e) => console.log('  ' + fmt(e)));
    return true;
  }
  return false;
}

console.log('모니터 시작', new Date().toLocaleString('ko-KR'));
for (;;) {
  try { if (await poll()) process.exit(0); } catch (e) { console.log('[모니터 오류] ' + e.message); }
  if (Date.now() - started > 3 * 60 * 60 * 1000) { console.log('3시간 경과, 모니터 종료. 접속 세션 ' + seenSessions.size + '개'); process.exit(0); }
  await new Promise((res) => setTimeout(res, 30000));
}
