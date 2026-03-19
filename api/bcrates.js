// ── /api/bcrates ──────────────────────────────────────────────────────────
// 1. Lê taxas do Redis
// 2. Busca FF desta semana → detecta decisões novas
// 3. Salva no Redis + dispara geração de conteúdo via Claude API
// 4. Retorna rates + content para o frontend

const FF_URL     = 'https://nfs.faireconomy.media/ff_calendar_thisweek.json';
const REDIS_URL  = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN= process.env.UPSTASH_REDIS_REST_TOKEN;
const RATES_KEY  = 'cb_monitor_rates_v1';
const CONTENT_KEY= 'cb_monitor_content_v1';

const BASE = {
  fed:   { rate:3.625, display:'3,50–3,75%', lastDecision:'2026-03-18', lastResult:'HOLD',         nextMeeting:'2026-04-29' },
  copom: { rate:14.75, display:'14,75%',     lastDecision:'2026-03-18', lastResult:'CORTE −0,25pp', nextMeeting:'2026-05-06' },
  ecb:   { rate:2.15,  display:'2,15%',      lastDecision:'2026-03-19', lastResult:'HOLD',          nextMeeting:'2026-04-17' },
  boe:   { rate:3.75,  display:'3,75%',      lastDecision:'2026-03-19', lastResult:'HOLD',          nextMeeting:'2026-04-30' },
  boj:   { rate:0.75,  display:'0,75%',      lastDecision:'2026-03-19', lastResult:'HOLD',          nextMeeting:'2026-04-30' },
  snb:   { rate:0.00,  display:'0,00%',      lastDecision:'2026-03-19', lastResult:'HOLD',          nextMeeting:'2026-06-19' },
  boc:   { rate:2.25,  display:'2,25%',      lastDecision:'2026-03-18', lastResult:'HOLD',          nextMeeting:'2026-04-29' },
  rba:   { rate:4.10,  display:'4,10%',      lastDecision:'2026-03-17', lastResult:'HIKE +0,25pp',  nextMeeting:'2026-05-05' },
};

const BC_MAP = [
  { bc:'fed',   cur:'USD', keys:['federal funds rate','fomc rate','fed interest rate'] },
  { bc:'ecb',   cur:'EUR', keys:['ecb main refinancing','ecb interest rate','ecb rate decision'] },
  { bc:'boe',   cur:'GBP', keys:['boe bank rate','mpc official bank rate','bank of england rate'] },
  { bc:'boj',   cur:'JPY', keys:['boj policy rate','boj interest rate','uncollateralized overnight'] },
  { bc:'boc',   cur:'CAD', keys:['boc rate','overnight rate','bank of canada rate'] },
  { bc:'rba',   cur:'AUD', keys:['rba rate','cash rate','reserve bank of australia rate'] },
  { bc:'snb',   cur:'CHF', keys:['snb policy rate','snb interest rate','swiss national bank rate'] },
  { bc:'copom', cur:'BRL', keys:['selic rate','copom rate','bcb rate'] },
];

async function redisGet(key) {
  if (!REDIS_URL || !REDIS_TOKEN) return null;
  try {
    const r = await fetch(`${REDIS_URL}/get/${key}`, {
      headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
      signal: AbortSignal.timeout(3000),
    });
    const j = await r.json();
    return j.result ? JSON.parse(j.result) : null;
  } catch { return null; }
}

async function redisSet(key, data) {
  if (!REDIS_URL || !REDIS_TOKEN) return;
  try {
    await fetch(`${REDIS_URL}/set/${key}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ value: JSON.stringify(data) }),
      signal: AbortSignal.timeout(5000),
    });
  } catch {}
}

function identifyBC(title='', country='') {
  const t = title.toLowerCase();
  for (const def of BC_MAP) {
    if (def.keys.some(k => t.includes(k))) return def.bc;
  }
  if (t.includes('rate') || t.includes('decision')) {
    const m = BC_MAP.find(d => d.cur === country);
    if (m) return m.bc;
  }
  return null;
}

function parseRate(s='') {
  const m = String(s).replace(',','.').match(/([\d.]+)/);
  return m ? parseFloat(m[1]) : null;
}

function detectResult(prev, curr) {
  if (curr === null) return null;
  if (prev === null || Math.abs(curr - prev) < 0.005) return 'HOLD';
  const diff = Math.abs(curr - prev).toFixed(2);
  return curr > prev ? `HIKE +${diff}pp` : `CORTE −${diff}pp`;
}

function formatDisplay(value, bc) {
  if (bc === 'fed') return `${(value-0.125).toFixed(2)}–${(value+0.125).toFixed(2)}%`;
  return `${value.toFixed(2)}%`;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=60');

  // 1. Carrega dados persistidos do Redis
  const [stored, content] = await Promise.all([
    redisGet(RATES_KEY),
    redisGet(CONTENT_KEY),
  ]);

  const rates = stored ? { ...BASE, ...stored } : { ...BASE };

  // 2. Busca FF (sem await blocking — não queremos timeout no response)
  let newDecisions = 0;
  let ffOk = false;

  try {
    const r = await fetch(FF_URL, {
      headers: { 'User-Agent': 'CBMonitor/1.0' },
      signal: AbortSignal.timeout(6000),
    });
    if (!r.ok) throw new Error(`FF:${r.status}`);
    const text = await r.text();
    if (text.trim().startsWith('<')) throw new Error('FF:rate_limited');

    const events = JSON.parse(text);
    ffOk = true;

    const updates = {};
    events.forEach(e => {
      if (!e.actual || String(e.actual).trim() === '') return;
      const bc = identifyBC(e.title || '', e.country || '');
      if (!bc) return;
      const date = e.date ? String(e.date).split('T')[0] : null;
      if (!date || date < rates[bc].lastDecision) return;

      const newRate = parseRate(e.actual);
      const result  = detectResult(rates[bc].rate, newRate);
      if (!result) return;

      updates[bc] = {
        ...rates[bc],
        rate:         newRate ?? rates[bc].rate,
        display:      newRate !== null ? formatDisplay(newRate, bc) : rates[bc].display,
        lastDecision: date,
        lastResult:   result,
      };
      newDecisions++;
    });

    if (newDecisions > 0) {
      const toStore = { ...stored, ...updates };
      Object.assign(rates, updates);
      await redisSet(RATES_KEY, toStore);

      // 3. Dispara geração de conteúdo em background (não bloqueia resposta)
      const host = req.headers['x-forwarded-host'] || req.headers.host || '';
      const proto = req.headers['x-forwarded-proto'] || 'https';
      fetch(`${proto}://${host}/api/generate-bc-content`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      }).catch(() => {}); // silencioso — background job
    }
  } catch {}

  return res.status(200).json({
    ok:              true,
    rates,
    content:         content || {},
    ffOk,
    newDecisions,
    redisConfigured: !!(REDIS_URL && REDIS_TOKEN),
    servedAt:        new Date().toISOString(),
  });
}
