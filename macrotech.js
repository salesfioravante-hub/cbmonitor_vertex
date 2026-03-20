// ── /api/macrotech ────────────────────────────────────────────────────────
const REDIS_URL   = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const EDIT_PASS   = process.env.EDITOR_PASSWORD || 'cbmonitor2026';
const MACRO_KEY   = 'cb_monitor_macrotech_v1';

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
    if (!REDIS_URL || !REDIS_TOKEN) return false;
    try {
          await fetch(`${REDIS_URL}/set/${key}`, {
                  method: 'POST',
                  headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
                  body: JSON.stringify({ value: JSON.stringify(data) }),
                  signal: AbortSignal.timeout(5000),
          });
          return true;
    } catch { return false; }
}

const DEFAULT_PAIRS = [
  { pair:'EUR/USD', flag:'🇪🇺🇺🇸', macroVies:'BEARISH',      macroColor:'var(--red)',   macroReason:'Fed hawkish (3,625%) vs ECB em pausa (2,15%). Diferencial favorece USD.',   gatilho:'CPI EUA → short. Dados EUA fracos → aguardar.',              d1:'', h4:'', nivelChave:'', confluencia:'' },
  { pair:'USD/JPY', flag:'🇺🇸🇯🇵', macroVies:'NEUTRO/WATCH', macroColor:'var(--amber)', macroReason:'Fed hawkish favorece USD mas BoJ normalizando. Acima de 159 = zona de intervenção.', gatilho:'BoJ hawkish → short violento. Acima de 161 → cautela.',        d1:'', h4:'', nivelChave:'', confluencia:'' },
  { pair:'GBP/USD', flag:'🇬🇧🇺🇸', macroVies:'NEUTRO',       macroColor:'var(--blue)',  macroReason:'BoE HOLD 3,75% vs Fed 3,625%. Diferencial mínimo. Inflação UK em 3,4%.',     gatilho:'CPI UK acima → long GBP. NFP EUA fraco → long GBP.',         d1:'', h4:'', nivelChave:'', confluencia:'' },
  { pair:'AUD/USD', flag:'🇦🇺🇺🇸', macroVies:'BULLISH',      macroColor:'var(--green)', macroReason:'RBA hawkish 4,10% — segunda alta consecutiva. Diferencial favorece AUD.',    gatilho:'Emprego AU positivo → long. PMI China acima de 50 → long.',  d1:'', h4:'', nivelChave:'', confluencia:'' },
  { pair:'USD/CAD', flag:'🇺🇸🇨🇦', macroVies:'NEUTRO',       macroColor:'var(--blue)',  macroReason:'BoC HOLD 2,25% vs Fed 3,625%. Petróleo a ~$97 atenua diferencial de juros.', gatilho:'EIA petróleo quarta 10:30 ET. PIB Canada mensal.',            d1:'', h4:'', nivelChave:'', confluencia:'' },
  { pair:'XAU/USD', flag:'🥇',     macroVies:'BULLISH',      macroColor:'var(--green)', macroReason:'Stress geopolítico (Irã) + BCs em pausa. Floor elevado acima de $4.500.',    gatilho:'Escalada Irã → long imediato. CPI EUA fraco → long.',        d1:'', h4:'', nivelChave:'', confluencia:'' },
  ];

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Content-Type', 'application/json');
    if (req.method === 'OPTIONS') return res.status(200).end();

  // ── GET ─────────────────────────────────────────────────────────────
  if (req.method === 'GET') {
        res.setHeader('Cache-Control', 'no-store');
        const data = await redisGet(MACRO_KEY);
        return res.status(200).json({
                ok: true,
                generatedAt: data?.generatedAt || null,
                pairs: data?.pairs || DEFAULT_PAIRS,
                source: data ? 'redis' : 'default',
        });
  }

  // ── POST ─────────────────────────────────────────────────────────────
  if (req.method === 'POST') {
        // Lê body — funciona tanto com req.body (auto-parse) quanto com stream
      let body = {};
        try {
                if (req.body !== undefined && req.body !== null) {
                          body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
                } else {
                          // Lê stream manualmente
                  const chunks = [];
                          for await (const chunk of req) chunks.push(chunk);
                          body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
                }
        } catch(e) {
                return res.status(400).json({ ok: false, error: 'Body inválido: ' + e.message });
        }

      const received = body.password || '';
        const expected = EDIT_PASS;
        const trimmed  = received.trim();

      if (trimmed !== expected) {
              return res.status(401).json({
                        ok: false,
                        error: 'Senha incorreta',
                        debug: {
                                    received_length: received.length,
                                    expected_length: expected.length,
                                    match: trimmed === expected,
                                    env_set: !!process.env.EDITOR_PASSWORD,
                        }
              });
      }

      const existing = (await redisGet(MACRO_KEY)) || {};
        const pairs = (existing.pairs || DEFAULT_PAIRS).map(p => {
                const update = (body.pairs || []).find(u => u.pair === p.pair);
                if (!update) return p;
                return {
                          ...p,
                          d1:         update.d1         || p.d1,
                          h4:         update.h4         || p.h4,
                          nivelChave: update.nivelChave || p.nivelChave,
                          confluencia: update.confluencia || p.confluencia,
                };
        });

      await redisSet(MACRO_KEY, { ...existing, pairs, lastEditedAt: new Date().toISOString() });
        return res.status(200).json({ ok: true, saved: pairs.length });
  }

  return res.status(405).json({ ok: false, error: 'Method not allowed' });
}
