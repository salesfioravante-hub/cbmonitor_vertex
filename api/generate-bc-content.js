// ── /api/generate-bc-content ──────────────────────────────────────────────
// Chamada interna: quando bcrates.js detecta nova decisão no Redis,
// chama este endpoint para gerar conteúdo educacional via Claude API.
// O conteúdo é salvo no Redis e carregado pelo frontend automaticamente.

const REDIS_URL      = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN    = process.env.UPSTASH_REDIS_REST_TOKEN;
const ANTHROPIC_KEY  = process.env.ANTHROPIC_API_KEY;
const CONTENT_KEY    = 'cb_monitor_content_v1';

const BC_NAMES = {
  fed:   'Federal Reserve (Fed) — EUA',
  ecb:   'Banco Central Europeu (ECB)',
  boe:   'Bank of England (BoE)',
  boj:   'Bank of Japan (BoJ)',
  boc:   'Bank of Canada (BoC)',
  rba:   'Reserve Bank of Australia (RBA)',
  snb:   'Swiss National Bank (SNB)',
  copom: 'Banco Central do Brasil (Copom)',
};

const BC_CURRENCY = {
  fed:'USD', ecb:'EUR', boe:'GBP', boj:'JPY',
  boc:'CAD', rba:'AUD', snb:'CHF', copom:'BRL',
};

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

async function generateContent(bc, decision) {
  const prompt = `Você é um analista de Forex/Futuros experiente criando conteúdo educacional em português brasileiro.

Banco Central: ${BC_NAMES[bc]}
Moeda: ${BC_CURRENCY[bc]}
Data da decisão: ${decision.lastDecision}
Resultado: ${decision.lastResult}
Taxa atual: ${decision.display}
Próxima reunião: ${decision.nextMeeting}

Gere um JSON com exatamente esta estrutura (sem markdown, sem texto extra, apenas JSON válido):
{
  "alertText": "Texto em HTML descrevendo a decisão confirmada. Máximo 2 frases. Use <strong> para destacar pontos-chave. Mencione o resultado real, o tom do comunicado e implicações para a moeda.",
  "scenarios": [
    {
      "t": "hawk",
      "p": "—",
      "title": "Título do cenário hawkish (o que realmente aconteceu ou pode acontecer)",
      "desc": "Descrição em 2 frases do impacto hawkish na moeda e mercados relacionados."
    },
    {
      "t": "hold",
      "p": "—", 
      "title": "Título do cenário neutro/manutenção",
      "desc": "Descrição do cenário base e próximos passos esperados."
    },
    {
      "t": "dove",
      "p": "—",
      "title": "Título do cenário dovish (riscos ou dissidências)",
      "desc": "Descrição de riscos de reversão ou sinalização dovish."
    }
  ],
  "impactAssets": [
    {"asset": "NOME_PAR", "label": "Descrição", "hawk": ["↑/↓ X%", "du/dd/dn"], "hold": ["→", "dn"], "dove": ["↑/↓ X%", "du/dd/dn"]},
    {"asset": "NOME_PAR", "label": "Descrição", "hawk": ["↑/↓ X%", "du/dd/dn"], "hold": ["→", "dn"], "dove": ["↑/↓ X%", "du/dd/dn"]},
    {"asset": "NOME_PAR", "label": "Descrição", "hawk": ["↑/↓ X%", "du/dd/dn"], "hold": ["→", "dn"], "dove": ["↑/↓ X%", "du/dd/dn"]},
    {"asset": "NOME_PAR", "label": "Descrição", "hawk": ["↑/↓ X%", "du/dd/dn"], "hold": ["→", "dn"], "dove": ["↑/↓ X%", "du/dd/dn"]}
  ],
  "note": "Nota educacional sobre o contexto atual. 2-3 frases sobre ciclo monetário, próximos catalisadores e o que monitorar.",
  "scNote": "Fonte e data da decisão em formato: 'Fonte: [BC oficial], [agências] — decisão de DD/MM/AAAA'"
}

Para impactAssets: use "du" (verde/alta), "dd" (vermelho/baixa), "dn" (neutro/cinza).
Escolha os 4 ativos mais relevantes para este BC (pares FX principais, índices, yields).`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1500,
      messages: [{ role: 'user', content: prompt }],
    }),
    signal: AbortSignal.timeout(30000),
  });

  if (!res.ok) throw new Error(`Claude API ${res.status}`);
  const data = await res.json();
  const text = data.content.find(b => b.type === 'text')?.text || '';

  // Parse JSON da resposta
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('JSON não encontrado na resposta');
  return JSON.parse(jsonMatch[0]);
}

export default async function handler(req, res) {
  res.setHeader('Content-Type', 'application/json');

  if (!ANTHROPIC_KEY) {
    return res.status(200).json({ ok: false, error: 'ANTHROPIC_API_KEY não configurada' });
  }

  // Lê taxas do Redis para saber quais BCs precisam de conteúdo gerado
  const rates   = await redisGet('cb_monitor_rates_v1');
  const content = (await redisGet(CONTENT_KEY)) || {};

  if (!rates) {
    return res.status(200).json({ ok: false, error: 'Nenhuma taxa no Redis ainda' });
  }

  const generated = [];
  const errors    = [];

  for (const [bc, decision] of Object.entries(rates)) {
    // Pula se já temos conteúdo para esta data de decisão
    if (content[bc]?.lastDecision === decision.lastDecision) continue;
    // Pula se não há resultado real ainda
    if (!decision.lastResult || decision.lastResult === '—') continue;

    try {
      const bcContent = await generateContent(bc, decision);
      content[bc] = { ...bcContent, lastDecision: decision.lastDecision };
      generated.push(bc);
    } catch (err) {
      errors.push(`${bc}: ${err.message}`);
    }
  }

  if (generated.length > 0) {
    await redisSet(CONTENT_KEY, content);
  }

  return res.status(200).json({
    ok: true,
    generated,
    errors,
    total: Object.keys(content).length,
  });
}
