// ── /api/cron ─────────────────────────────────────────────────────────────
// Vercel Cron Job — roda a cada hora.
// Busca o calendário da Forex Factory, detecta decisões de BC publicadas,
// e salva no Upstash Redis para todos os visitantes.

const FF_URL      = 'https://nfs.faireconomy.media/ff_calendar_thisweek.json';
const REDIS_URL   = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const CRON_SECRET = process.env.CRON_SECRET; // proteção opcional

// Mapeamento: palavras-chave no título → BC
const BC_KEYWORDS = {
  fed:   ['federal funds','fomc rate','fed rate','federal reserve'],
  ecb:   ['ecb rate','main refinancing','deposit facility','ecb interest rate'],
  boe:   ['boe rate','bank rate','bank of england','mpc rate'],
  boj:   ['boj rate','bank of japan','uncollateralized overnight','boj policy'],
  boc:   ['boc rate','overnight rate','bank of canada'],
  rba:   ['rba rate','cash rate','reserve bank of australia'],
  snb:   ['snb rate','swiss national bank','snb policy'],
  copom: ['selic rate','copom','brazil rate','bcb rate'],
};

const BC_CURRENCIES = {
  fed:'USD', ecb:'EUR', boe:'GBP', boj:'JPY',
  boc:'CAD', rba:'AUD', snb:'CHF', copom:'BRL',
};

function identifyBC(title = '', currency = '') {
  const t = title.toLowerCase();
  for (const [bc, kws] of Object.entries(BC_KEYWORDS)) {
    if (kws.some(kw => t.includes(kw))) return bc;
  }
  // Fallback por moeda
  if (t.includes('rate') || t.includes('decision') || t.includes('interest')) {
    for (const [bc, cur] of Object.entries(BC_CURRENCIES)) {
      if (cur === currency) return bc;
    }
  }
  return null;
}

function parseRate(actual = '') {
  const m = String(actual).match(/([\d.]+)/);
  return m ? parseFloat(m[1]) : null;
}

function formatDisplay(value, bc) {
  if (bc === 'fed') {
    // Fed opera em range — ex: 3.625 → exibir como range seria ideal
    // mas sem o range exato, usamos o valor como está
    return `${value.toFixed(2)}%`;
  }
  return `${value.toFixed(2)}%`;
}

function detectResult(prev, curr) {
  if (curr === null || prev === null) return '—';
  const diff = (curr - prev).toFixed(2);
  if (Math.abs(curr - prev) < 0.01) return 'HOLD';
  return curr > prev
    ? `HIKE +${Math.abs(diff)}pp`
    : `CORTE −${Math.abs(diff)}pp`;
}

async function redisSet(key, value) {
  const encoded = encodeURIComponent(JSON.stringify(value));
  const r = await fetch(`${REDIS_URL}/set/${key}/${encoded}`, {
    headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
    signal: AbortSignal.timeout(5000),
  });
  return r.ok;
}

async function redisGet(key) {
  const r = await fetch(`${REDIS_URL}/get/${key}`, {
    headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
    signal: AbortSignal.timeout(3000),
  });
  const data = await r.json();
  return data.result ? JSON.parse(data.result) : null;
}

export default async function handler(req, res) {
  // Verifica autorização (Vercel envia header automático)
  const auth = req.headers['authorization'];
  if (CRON_SECRET && auth !== `Bearer ${CRON_SECRET}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }

  if (!REDIS_URL || !REDIS_TOKEN) {
    return res.status(500).json({ error: 'Redis not configured' });
  }

  const log = [];

  try {
    // 1. Busca calendário da Forex Factory
    log.push('Fetching Forex Factory...');
    const ffRes = await fetch(FF_URL, {
      headers: { 'User-Agent': 'CBMonitor/1.0' },
      signal: AbortSignal.timeout(8000),
    });

    if (!ffRes.ok) throw new Error(`FF responded ${ffRes.status}`);
    const text = await ffRes.text();
    if (text.trim().startsWith('<')) throw new Error('FF rate limited');

    const events = JSON.parse(text);
    log.push(`FF: ${events.length} events fetched`);

    // 2. Carrega taxas atuais do Redis (para comparar)
    const currentRates = (await redisGet('bc_rates')) || {};

    // 3. Detecta decisões com resultado publicado
    const updates = {};
    events.forEach(e => {
      if (!e.actual || !e.title) return;
      const bc = identifyBC(e.title, e.country);
      if (!bc) return;

      const rateValue = parseRate(e.actual);
      const eventDate = e.date ? e.date.split('T')[0] : null;
      const storedDate = currentRates[bc]?.lastDecision;

      // Só atualiza se for uma data mais recente
      if (eventDate && storedDate && eventDate <= storedDate) return;
      if (!eventDate) return;

      const prevRate = currentRates[bc]?.rate ?? null;
      const result   = detectResult(prevRate, rateValue);

      updates[bc] = {
        rate:         rateValue ?? currentRates[bc]?.rate,
        display:      rateValue !== null ? formatDisplay(rateValue, bc) : currentRates[bc]?.display,
        lastDecision: eventDate,
        lastResult:   result,
      };

      log.push(`Updated ${bc}: ${e.actual} (${result}) on ${eventDate}`);
    });

    // 4. Se houver atualizações, salva no Redis
    if (Object.keys(updates).length > 0) {
      const merged = { ...currentRates, ...updates };
      await redisSet('bc_rates', merged);
      await redisSet('bc_meta', {
        lastUpdated: new Date().toISOString(),
        updatedBCs: Object.keys(updates),
      });
      log.push(`Redis updated: ${Object.keys(updates).join(', ')}`);
    } else {
      log.push('No new BC decisions found');
    }

    return res.status(200).json({
      ok: true,
      updatesFound: Object.keys(updates).length,
      updates,
      log,
      runAt: new Date().toISOString(),
    });

  } catch (err) {
    log.push(`Error: ${err.message}`);
    return res.status(200).json({ ok: false, error: err.message, log });
  }
}
