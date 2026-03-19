// ── /api/calendar ─────────────────────────────────────────────────────────
const FF_URL = 'https://nfs.faireconomy.media/ff_calendar_thisweek.json';

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
const BC_CURRENCIES = {fed:'USD',ecb:'EUR',boe:'GBP',boj:'JPY',boc:'CAD',rba:'AUD',snb:'CHF',copom:'BRL'};

function identifyBC(title='',currency=''){
  const t=title.toLowerCase();
  for(const [bc,kws] of Object.entries(BC_KEYWORDS)){if(kws.some(kw=>t.includes(kw)))return bc;}
  if(t.includes('rate')||t.includes('decision')){for(const [bc,cur] of Object.entries(BC_CURRENCIES)){if(cur===currency)return bc;}}
  return null;
}

export default async function handler(req,res){
  res.setHeader('Access-Control-Allow-Origin','*');
  res.setHeader('Content-Type','application/json');
  res.setHeader('Cache-Control','s-maxage=300,stale-while-revalidate=60');
  if(req.method==='OPTIONS') return res.status(200).end();
  try{
    const r=await fetch(FF_URL,{headers:{'User-Agent':'CBMonitor/1.0'},signal:AbortSignal.timeout(8000)});
    if(!r.ok) throw new Error(`FF ${r.status}`);
    const text=await r.text();
    if(text.trim().startsWith('<')) throw new Error('FF rate limited');
    const events=JSON.parse(text);
    const bcUpdates={};
    events.forEach(e=>{
      if(!e.actual) return;
      const bc=identifyBC(e.title,e.country);
      if(!bc) return;
      const m=String(e.actual).match(/([\d.]+)/);
      bcUpdates[bc]={actual:e.actual,rateValue:m?parseFloat(m[1]):null,date:e.date,title:e.title};
    });
    return res.status(200).json({ok:true,events,bcUpdates,fetchedAt:new Date().toISOString()});
  }catch(err){
    return res.status(200).json({ok:false,error:err.message,events:[],bcUpdates:{}});
  }
}
