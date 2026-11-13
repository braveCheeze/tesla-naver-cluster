// 테슬라 지도 클러스터용 길안내 프록시 (Cloudflare Worker)
// 비밀키는 코드에 넣지 않는다. Cloudflare 대시보드 > Worker > Settings > Variables and Secrets 에
//   NCP_KEY_ID          네이버 클라우드 Maps Client ID
//   NCP_KEY             네이버 클라우드 Maps Client Secret
//   NAVER_SEARCH_ID     (선택) 네이버 개발자센터 검색 API Client ID
//   NAVER_SEARCH_SECRET (선택) 네이버 개발자센터 검색 API Client Secret
// 를 Secret 으로 넣는다.
// 진단 기록 저장(선택): Bindings 에 KV namespace 를 변수명 LOGS 로 연결한다. 기록은 30일 뒤 자동 삭제.

const ALLOWED_ORIGINS = [
  'https://bravecheeze.github.io',
  'http://localhost:8765',
];
const NCP = 'https://maps.apigw.ntruss.com';
const COORD = /^-?\d{1,3}(\.\d+)?,-?\d{1,3}(\.\d+)?$/;
const ROUTE_OPTIONS = new Set(['trafast', 'tracomfort', 'traoptimal', 'traavoidtoll', 'traavoidcaronly']);
// 재탐색·교통 갱신(단일 옵션 경로)은 같은 접속지에서 15초에 한 번까지만 (호출 폭주로 무료 한도를 쓰지 않게).
// 처음 길찾기(여러 경로)는 제한하지 않는다. 메모리 기반이라 완벽하진 않지만 폭주는 막는다.
const ROUTE_GAP_MS = 15000;
const routeHits = new Map();

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
      'Access-Control-Allow-Headers': 'Content-Type',
      'Vary': 'Origin',
    };
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    const url = new URL(req.url);
    const p = url.searchParams;
    const isLogPost = req.method === 'POST' && url.pathname === '/log';
    const isEventPost = req.method === 'POST' && url.pathname === '/event';
    if (req.method !== 'GET' && !isLogPost && !isEventPost) return json({ error: 'method' }, 405, cors);

    if (url.pathname === '/health') {
      return json({
        ok: true,
        ncp: !!(env.NCP_KEY_ID && env.NCP_KEY),
        search: !!(env.NAVER_SEARCH_ID && env.NAVER_SEARCH_SECRET),
        logs: !!env.LOGS,
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

      // 운영 모니터링: 페이지가 보내는 접속·오류 이벤트 (위치 없음, 7일 보관)
      if (url.pathname === '/event' && isEventPost) {
        if (!env.LOGS) return json({ ok: false }, 200, cors);
        const text = await req.text();
        if (text.length > 20000) return json({ error: 'too large' }, 413, cors);
        let ev;
        try { ev = JSON.parse(text); } catch (e) { return json({ error: 'bad json' }, 400, cors); }
        if (!ev || typeof ev !== 'object') return json({ error: 'bad event' }, 400, cors);
        Object.keys(ev).forEach((k) => { if (typeof ev[k] === 'string') ev[k] = ev[k].slice(0, 1000); });
        const ts = Date.now();
        ev.serverAt = ts;
        ev.country = (req.cf && req.cf.country) || '';
        const key = 'evt:' + String(ts).padStart(15, '0') + ':' + crypto.randomUUID().slice(0, 6);
        await env.LOGS.put(key, JSON.stringify(ev), { expirationTtl: 60 * 60 * 24 * 7 });
        return json({ ok: true }, 200, cors);
      }
      if (url.pathname === '/events') {
        if (!env.LOGS) return json({ items: [] }, 200, cors);
        const since = Number(p.get('since')) || 0;
        const listed = await env.LOGS.list({ prefix: 'evt:', limit: 1000 });
        const keys = listed.keys.map((k) => k.name).filter((n) => Number(n.split(':')[1]) > since).sort().slice(-50);
        const items = (await Promise.all(keys.map((k) => env.LOGS.get(k)))).filter(Boolean).map((v) => {
          try { return JSON.parse(v); } catch (e) { return { raw: v }; }
        });
        return json({ items }, 200, cors);
      }

      if (url.pathname === '/log') {
        if (!env.LOGS) return json({ error: 'log storage not configured' }, 501, cors);
        if (isLogPost) {
          const text = await req.text();
          if (text.length > 5000000) return json({ error: 'too large' }, 413, cors);
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
          if (!alternatives.length) return json({ error: 'no route', code: r.data && r.data.code, message: r.data && r.data.message }, 404, cors);
          return json({ alternatives }, 200, cors);
        }

        const ip = req.headers.get('CF-Connecting-IP') || 'anon';
        // Cloudflare Rate limiter 바인딩(ROUTE_LIMIT, 예: 60초에 4회)이 있으면 그것을 쓰고, 없으면 메모리 기준으로 막는다
        if (env.ROUTE_LIMIT) {
          const { success } = await env.ROUTE_LIMIT.limit({ key: 'route:' + ip });
          if (!success) return json({ error: 'rate limited', message: '잠시 후 다시 시도합니다', retryAfter: 15 }, 429, cors);
        } else {
          const now = Date.now(), last = routeHits.get(ip) || 0;
          if (now - last < ROUTE_GAP_MS) {
            return json({ error: 'rate limited', message: '잠시 후 다시 시도합니다', retryAfter: Math.ceil((ROUTE_GAP_MS - (now - last)) / 1000) }, 429, cors);
          }
          routeHits.set(ip, now);
          if (routeHits.size > 5000) routeHits.clear();
        }
        const r = await call(single);
        if (!r.ok) return json({ error: 'upstream', status: r.status, detail: r.data }, 502, cors);
        if (r.data.code !== 0 || !r.data.route) return json({ error: 'no route', code: r.data.code, message: r.data.message }, 404, cors);
        return json(slim(r.data.route[single][0], single), 200, cors);
      }

      if (url.pathname === '/geocode') {
        const query = (p.get('query') || '').slice(0, 100);
        if (!query) return json({ error: 'query' }, 400, cors);
        const qs = new URLSearchParams({ query });
        if (COORD.test(p.get('near') || '')) qs.set('coordinate', p.get('near'));
        const r = await upstream(NCP + '/map-geocode/v2/geocode?' + qs, ncpHeaders);
        if (!r.ok) return json({ error: 'upstream', status: r.status, detail: r.data }, 502, cors);
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
        if (!r.ok) return json({ error: 'upstream', status: r.status, detail: r.data }, 502, cors);
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
        if (!r.ok) return json({ error: 'upstream', status: r.status, detail: r.data }, 502, cors);
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
      return json({ error: 'proxy', message: String(e && e.message || e) }, 500, cors);
    }
  },
};
