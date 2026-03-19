// ── /api/generate-macro ───────────────────────────────────────────────────
// Chamado pelo cron semanal (domingo) ou manualmente.
// Claude API + web_search gera o viés macro atualizado para cada par FX.
// Resultado salvo no Redis — frontend lê automaticamente.

const REDIS_URL   = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const ANTH_KEY    = process.env.ANTHROPIC_API_KEY;
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

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');

  if (!ANTH_KEY) return res.status(200).json({ ok: false, error: 'ANTHROPIC_API_KEY não configurada' });

  const today = new Date().toLocaleDateString('pt-BR', { day: '2-digit', month: 'short', year: 'numeric' }).toUpperCase();

  const prompt = `Você é um analista macro sênior especializado em Forex. Data de hoje: ${today}.

Faça uma busca rápida sobre: taxas dos principais bancos centrais hoje, DXY atual, níveis de USD/JPY EUR/USD GBP/USD AUD/USD USD/CAD XAU/USD, e qualquer evento macro relevante recente (decisões de BC, NFP, CPI).

Com base nos dados encontrados, gere um JSON com o viés macro ATUAL para cada par abaixo.
Retorne APENAS JSON válido, sem texto antes ou depois:

{
  "generatedAt": "${today}",
  "pairs": [
    {
      "pair": "EUR/USD",
      "macroVies": "BEARISH",
      "macroColor": "var(--red)",
      "macroReason": "2-3 frases explicando o viés macro atual baseado em diferenciais de juros, dados e decisões de BC recentes.",
      "gatilho": "Eventos específicos que podem mudar o viés nas próximas semanas."
    },
    { "pair": "USD/JPY", ... },
    { "pair": "GBP/USD", ... },
    { "pair": "AUD/USD", ... },
    { "pair": "USD/CAD", ... },
    { "pair": "XAU/USD", ... }
  ]
}

Para macroVies use apenas: "BULLISH", "BEARISH" ou "NEUTRO/WATCH".
Para macroColor: "var(--green)" para bullish, "var(--red)" para bearish, "var(--amber)" para neutro.
Base os 6 pares nesta ordem: EUR/USD, USD/JPY, GBP/USD, AUD/USD, USD/CAD, XAU/USD.`;

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTH_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 2000,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: AbortSignal.timeout(45000),
    });

    if (!r.ok) throw new Error(`Claude API ${r.status}`);
    const data = await r.json();

    const text = data.content
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('');

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('JSON não encontrado');

    const macro = JSON.parse(jsonMatch[0]);
    if (!macro.pairs?.length) throw new Error('Pairs vazio');

    // Carrega dados existentes (preserva o técnico do professor)
    const existing = (await redisGet(MACRO_KEY)) || {};
    const merged = { ...existing, macro };

    // Reconstrói pares preservando análise técnica do professor
    if (existing.pairs) {
      macro.pairs = macro.pairs.map(newPair => {
        const old = existing.pairs?.find(p => p.pair === newPair.pair) || {};
        return {
          ...newPair,
          // Preserva campos técnicos do professor
          d1:          old.d1          || '',
          h4:          old.h4          || '',
          nivelChave:  old.nivelChave  || '',
          confluencia: old.confluencia || '',
        };
      });
    } else {
      macro.pairs = macro.pairs.map(p => ({
        ...p, d1: '', h4: '', nivelChave: '', confluencia: '',
      }));
    }

    await redisSet(MACRO_KEY, macro);

    return res.status(200).json({ ok: true, generatedAt: today, pairs: macro.pairs.length });

  } catch (err) {
    return res.status(200).json({ ok: false, error: err.message });
  }
}
