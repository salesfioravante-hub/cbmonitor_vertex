// ── /api/rates ────────────────────────────────────────────────────────────
// Retorna taxas atuais dos BCs.
// Fonte primária: Upstash Redis (atualizado pelo cron hourly).
// Fallback: valores hardcoded caso Redis esteja vazio.

const REDIS_URL   = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

// Valores base — usados como fallback se Redis ainda não tiver dados
const BASE_RATES = {
  fed:   { rate: 3.625, display: '3,50–3,75%', lastDecision: '2026-03-18', lastResult: 'HOLD',         nextMeeting: '2026-04-29' },
  copom: { rate: 14.75, display: '14,75%',     lastDecision: '2026-03-18', lastResult: 'CORTE −0,25pp', nextMeeting: '2026-05-06' },
  ecb:   { rate: 2.15,  display: '2,15%',      lastDecision: '2026-03-19', lastResult: '—',             nextMeeting: '2026-04-17' },
  boe:   { rate: 3.75,  display: '3,75%',      lastDecision: '2026-03-19', lastResult: '—',             nextMeeting: '2026-04-30' },
  boj:   { rate: 0.75,  display: '0,75%',      lastDecision: '2026-03-19', lastResult: '—',             nextMeeting: '2026-04-30' },
  snb:   { rate: 0.00,  display: '0,00%',      lastDecision: '2026-03-19', lastResult: '—',             nextMeeting: '2026-06-19' },
  boc:   { rate: 2.25,  display: '2,25%',      lastDecision: '2026-03-18', lastResult: 'HOLD',          nextMeeting: '2026-04-29' },
  rba:   { rate: 4.10,  display: '4,10%',      lastDecision: '2026-03-17', lastResult: 'HIKE +0,25pp',  nextMeeting: '2026-05-05' },
};

async function redisGet(key) {
  if (!REDIS_URL || !REDIS_TOKEN) return null;
  try {
    const r = await fetch(`${REDIS_URL}/get/${key}`, {
      headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
      signal: AbortSignal.timeout(3000),
    });
    const data = await r.json();
    return data.result ? JSON.parse(data.result) : null;
  } catch { return null; }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');

  // Tenta buscar do Redis
  const stored = await redisGet('bc_rates');
  const meta   = await redisGet('bc_meta');

  if (stored) {
    // Merge: Redis tem prioridade sobre BASE_RATES
    const merged = { ...BASE_RATES };
    Object.entries(stored).forEach(([bc, data]) => {
      if (merged[bc]) merged[bc] = { ...merged[bc], ...data };
    });
    return res.status(200).json({
      ok: true,
      rates: merged,
      lastUpdated: meta?.lastUpdated || null,
      source: 'redis',
    });
  }

  // Fallback: retorna valores base
  return res.status(200).json({
    ok: true,
    rates: BASE_RATES,
    lastUpdated: null,
    source: 'fallback',
  });
}
