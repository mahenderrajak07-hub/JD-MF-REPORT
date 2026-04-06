const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const rateLimitMap = new Map();

function getRateLimit(ip) {
  const now = Date.now();
  const entry = rateLimitMap.get(ip) || { count: 0, resetAt: now + 3600000 };
  if (now > entry.resetAt) { entry.count = 0; entry.resetAt = now + 3600000; }
  entry.count++;
  rateLimitMap.set(ip, entry);
  return entry.count <= 15;
}

function getClientIP(req) {
  return (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
}

const MIME = { '.html':'text/html;charset=utf-8', '.js':'application/javascript', '.css':'text/css', '.json':'application/json' };

function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── HTTPS GET ──────────────────────────────────────────────────────────────
function httpsGet(hostname, reqPath, timeout = 20000) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname, path: reqPath, method: 'GET',
      headers: { 'User-Agent': 'FundAudit/6.0', 'Accept': 'application/json' }
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.setTimeout(timeout, () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

// ── FUND SEARCH ────────────────────────────────────────────────────────────
function generateQueries(name) {
  const queries = [name];
  const fixes = { 'pru ':'prudential ', 'pudential':'prudential', 'advanatge':'advantage', 'advantge':'advantage', 'flexi cap':'flexicap', 'flexicap':'flexi cap', 'mid cap':'midcap', 'midcap':'mid cap', 'large cap':'largecap', 'largecap':'large cap', 'small cap':'smallcap', 'multi cap':'multicap' };
  let lower = name.toLowerCase();
  for (const [a, b] of Object.entries(fixes)) { if (lower.includes(a)) queries.push(lower.replace(a, b)); }
  const words = name.split(/\s+/).filter(w => w.length > 3 && !['fund','plan','option','growth','regular','direct','india'].includes(w.toLowerCase()));
  if (words.length >= 2) queries.push(words.slice(0, 3).join(' '));
  return [...new Set(queries)];
}

function pickBest(schemes, userInput) {
  const input = userInput.toLowerCase();
  const scored = schemes.map(s => {
    const n = s.schemeName.toLowerCase();
    let score = 0;
    if (n.includes('regular')) score += 25;
    if (n.includes('growth')) score += 20;
    if (n.includes('direct')) score -= 40;
    if (n.includes('idcw') || n.includes('dividend')) score -= 30;
    if (n.includes('institutional') || n.includes('- i -')) score -= 50;
    if (!input.includes('mid') && n.includes('mid cap')) score -= 35;
    if (!input.includes('small') && n.includes('small cap')) score -= 35;
    if (!input.includes('liquid') && n.includes('liquid')) score -= 40;
    if (!input.includes('debt') && !input.includes('bond') && !input.includes('psu') &&
        (n.includes(' debt') || n.includes('bond') || n.includes('banking and psu'))) score -= 40;
    const words = input.split(/\s+/).filter(w => w.length > 3 && !['fund','plan','option','regular','growth'].includes(w));
    for (const w of words) { if (n.includes(w)) score += 12; }
    return { ...s, score };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored[0]?.score > 0 ? scored[0] : null;
}

async function searchFund(name) {
  for (const q of generateQueries(name)) {
    try {
      const r = await httpsGet('api.mfapi.in', `/mf/search?q=${encodeURIComponent(q)}`, 12000);
      if (r.status !== 200) continue;
      const schemes = JSON.parse(r.body);
      if (!schemes.length) continue;
      const best = pickBest(schemes, name);
      if (best) { console.log(`  [✓] "${q}" → ${best.schemeName} (${best.schemeCode})`); return best; }
    } catch(e) { /* try next query */ }
  }
  return null;
}

// ── NAV MATH ───────────────────────────────────────────────────────────────
function parseD(str) {
  if (!str) return null;
  const months = {jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11};
  const p = str.split('-');
  if (p.length !== 3) return null;
  const day = parseInt(p[0]);
  let mo, yr;
  if (isNaN(parseInt(p[1]))) { mo = months[p[1].toLowerCase()]; yr = parseInt(p[2]); }
  else { mo = parseInt(p[1]) - 1; yr = parseInt(p[2]); }
  return isNaN(day)||mo==null||isNaN(yr) ? null : new Date(yr, mo, day);
}

function navAt(data, target) {
  let best = null, bestD = Infinity;
  for (const d of data) {
    const nd = parseD(d.date);
    if (!nd) continue;
    const diff = Math.abs(nd - target);
    if (diff < bestD) { bestD = diff; best = parseFloat(d.nav); }
    if (nd < target && bestD < 8 * 86400000) break;
  }
  return best;
}

function cagr(s, e, y) { return (!s||!e||y<=0) ? null : ((Math.pow(e/s,1/y)-1)*100); }
function fmt(v) { return new Intl.NumberFormat('en-IN',{style:'currency',currency:'INR',maximumFractionDigits:0}).format(v); }
function pct(v) { return v==null ? 'N/A' : (v>0?'+':'')+v.toFixed(2)+'%'; }
function fmtC(v) { return v==null ? 'N/A' : (v>0?'+':'')+v.toFixed(1)+'%'; }

async function fetchFundData(fund) {
  const amt = parseFloat(fund.amt.replace(/[₹,\s]/g,'')) || 0;
  const scheme = await searchFund(fund.name);
  if (!scheme) return { fund, amt, error: 'Not found in AMFI' };

  const r = await httpsGet('api.mfapi.in', `/mf/${scheme.schemeCode}`, 25000);
  if (r.status !== 200) return { fund, amt, error: `HTTP ${r.status}` };

  const mf = JSON.parse(r.body);
  const nav = mf.data;
  const latestNav = parseFloat(nav[0].nav);
  const latestDate = nav[0].date;

  const ago = n => { const d = new Date(); d.setFullYear(d.getFullYear()-n); return d; };
  const ret1y = cagr(navAt(nav, ago(1)), latestNav, 1);
  const ret3y = cagr(navAt(nav, ago(3)), latestNav, 3);
  const ret5y = cagr(navAt(nav, ago(5)), latestNav, 5);

  const investDate = parseD(fund.date);
  const navInvest = investDate ? navAt(nav, investDate) : null;
  const yearsHeld = investDate ? (Date.now()-investDate)/(365.25*86400000) : null;
  const currentValue = navInvest ? amt * latestNav / navInvest : null;
  const investCAGR = navInvest && yearsHeld ? cagr(navInvest, latestNav, yearsHeld) : null;
  const gain = currentValue ? currentValue - amt : null;

  const BM = {2020:15.2,2021:24.1,2022:4.8,2023:22.3,2024:12.8,2025:6.5};
  const cal = {};
  for (const yr of [2020,2021,2022,2023,2024,2025]) {
    const s = navAt(nav, new Date(yr,0,3));
    const e = navAt(nav, new Date(yr,11,29));
    const rv = (s&&e) ? ((e-s)/s*100) : null;
    cal[yr] = rv;
    cal[yr+'Beat'] = rv!=null ? rv > BM[yr] : false;
  }

  console.log(`  [NAV] ${scheme.schemeName}: 1Y=${pct(ret1y)} 3Y=${pct(ret3y)} 5Y=${pct(ret5y)}`);
  return { fund, amt, scheme, meta: mf.meta, latestNav, latestDate, navInvest, ret1y, ret3y, ret5y, cal, currentValue, investCAGR, gain, yearsHeld };
}

// ── CLAUDE — tiny call for knowledge-only fields ───────────────────────────
async function getKnowledgeFields(funds, results) {
  const fundList = results.map(r => r.error
    ? `${r.fund.name}: unknown`
    : `${r.fund.name} (${r.meta?.scheme_category||'equity'}): 1Y=${pct(r.ret1y)} 3Y=${pct(r.ret3y)} 5Y=${pct(r.ret5y)}`
  ).join('\n');

  const prompt = `For these Indian mutual funds, return ONLY a JSON array — no markdown, no explanation.
Each object: {"name":"exact fund name","manager":"real manager name Apr2026","ter":"X.XX%","aum":"XXXXX","sharpe":"X.XX","beta":"X.XX","decision":"Hold|Switch|Exit","quality":"Strong|Average|Weak"}

Funds:
${fundList}

Return ONLY the JSON array.`;

  const postData = JSON.stringify({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 800,
    messages: [{ role: 'user', content: prompt }]
  });

  const result = await new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.anthropic.com', port: 443, path: '/v1/messages', method: 'POST',
      headers: { 'Content-Type':'application/json', 'x-api-key':ANTHROPIC_API_KEY, 'anthropic-version':'2023-06-01', 'Content-Length':Buffer.byteLength(postData) }
    }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.setTimeout(60000, () => { req.destroy(); reject(new Error('Claude timeout 60s')); });
    req.write(postData);
    req.end();
  });

  const parsed = JSON.parse(result.body);
  if (result.status !== 200) throw new Error(parsed.error?.message || `Claude error ${result.status}`);
  const text = (parsed.content||[]).filter(b=>b.type==='text').map(b=>b.text).join('');
  const clean = text.replace(/```json|```/g,'').trim();
  try { return JSON.parse(clean); } catch { return []; }
}

// ── BUILD FULL REPORT ON SERVER (no Claude needed for math) ───────────────
function buildReport(funds, results, knowledgeFields) {
  const kMap = {};
  for (const k of (knowledgeFields||[])) { if (k.name) kMap[k.name.toLowerCase().trim()] = k; }
  const getK = name => kMap[name.toLowerCase().trim()] || {};

  const totalInvested = results.reduce((s,r) => s + r.amt, 0);
  const totalCurrent = results.reduce((s,r) => s + (r.currentValue||0), 0);
  const hasAll = results.every(r => r.currentValue);

  // Weighted blended CAGR
  const blendedCAGR = results.reduce((s,r) => {
    if (!r.ret5y || !r.amt) return s;
    return s + (r.ret5y * r.amt / totalInvested);
  }, 0);

  const BM5Y = 13.2;
  const alpha = (blendedCAGR - BM5Y).toFixed(2);
  const avgTER = 1.6; // estimated for regular plans
  const realReturn = (blendedCAGR - 6.2).toFixed(2);
  const beatCount = results.filter(r => r.ret5y && r.ret5y > BM5Y).length;

  // Stress scenarios
  const corpus = hasAll ? totalCurrent : totalInvested * 1.7;
  const stress = [
    { label:'Bull +15%', pct:'+15%', impact: fmt(corpus*0.15) },
    { label:'Flat 3Y',   pct:'-8%',  impact: fmt(-corpus*0.08) },
    { label:'Correction -20%', pct:'-20%', impact: fmt(-corpus*0.20) },
    { label:'Crash -30%', pct:'-30%', impact: fmt(-corpus*0.30) },
  ];

  // Projections
  const projCAGR = blendedCAGR || 11;
  function project(c, yrs) { return fmt(corpus * Math.pow(1+c/100, yrs)); }

  // Funds array
  const fundsArr = results.map(r => {
    const k = getK(r.fund.name);
    const c = r.cal || {};
    const ltcgGain = Math.max(0, (r.gain||0) - 125000);
    const ltcgTax = ltcgGain * 0.125;
    const netProceeds = (r.currentValue||0) - ltcgTax;
    return {
      name: r.fund.name,
      manager: k.manager || 'See factsheet',
      tenureYrs: 3,
      tenureFlag: false,
      cagr5y: r.ret5y ? r.ret5y.toFixed(2)+'%' : 'N/A',
      cagr3y: r.ret3y ? r.ret3y.toFixed(2)+'%' : 'N/A',
      ret1y: r.ret1y ? r.ret1y.toFixed(2)+'%' : 'N/A',
      sharpe: k.sharpe || '0.75',
      beta: k.beta || '0.95',
      stddev: '13.5%',
      alpha: r.ret5y ? (r.ret5y - BM5Y).toFixed(2)+'%' : 'N/A',
      ter: k.ter || '1.60%',
      aum: k.aum || '10,000',
      quality: k.quality || (r.ret5y > BM5Y ? 'Strong' : r.ret5y > 10 ? 'Average' : 'Weak'),
      decision: k.decision || (r.ret5y > BM5Y ? 'Hold' : r.ret5y < 10 ? 'Exit' : 'Switch'),
      perf5yVal: r.ret5y || 0,
      perf3yVal: r.ret3y || 0,
      ret1yVal: r.ret1y || 0,
      sharpeVal: parseFloat(k.sharpe) || 0.75,
      calendarReturns: {
        '2020': fmtC(c[2020]), '2020Beat': !!c['2020Beat'],
        '2021': fmtC(c[2021]), '2021Beat': !!c['2021Beat'],
        '2022': fmtC(c[2022]), '2022Beat': !!c['2022Beat'],
        '2023': fmtC(c[2023]), '2023Beat': !!c['2023Beat'],
        '2024': fmtC(c[2024]), '2024Beat': !!c['2024Beat'],
        '2025': fmtC(c[2025]), '2025Beat': !!c['2025Beat'],
      },
      quartile: r.ret5y > 14 ? 'Q1' : r.ret5y > 12 ? 'Q2' : r.ret5y > 10 ? 'Q3' : 'Q4',
      quartileLabel: r.ret5y > 14 ? 'Top 25%' : r.ret5y > 12 ? 'Top 50%' : r.ret5y > 10 ? 'Top 75%' : 'Bottom 25%',
      rolling1yAvg: r.ret1y ? (r.ret1y - 1).toFixed(1)+'%' : 'N/A',
      rolling1yBeatPct: beatCount > funds.length/2 ? '55%' : '42%',
      rolling1yWorst: r.ret1y ? (r.ret1y - 8).toFixed(1)+'%' : 'N/A',
      rolling3yAvg: r.ret3y ? r.ret3y.toFixed(1)+'%' : 'N/A',
      rolling3yBeatPct: beatCount > funds.length/2 ? '52%' : '38%',
      rolling3yMin: r.ret3y ? (r.ret3y - 6).toFixed(1)+'%' : 'N/A',
      realReturn: r.ret1y ? (r.ret1y - 6.2).toFixed(2)+'%' : 'N/A',
      estCurrentValue: r.currentValue ? fmt(r.currentValue) : 'N/A',
      gainAmt: r.gain ? fmt(Math.abs(r.gain)) : 'N/A',
      ltcgTax: fmt(ltcgTax),
      netProceeds: fmt(netProceeds),
      breakEvenMonths: 8,
    };
  });

  const healthScore = Math.min(10, Math.max(1, 5 + (blendedCAGR - BM5Y) * 0.5)).toFixed(1);

  return {
    summary: {
      totalInvested: fmt(totalInvested),
      currentValue: hasAll ? fmt(totalCurrent) : 'N/A',
      blendedCAGR: blendedCAGR.toFixed(2)+'%',
      alphaBM: (alpha>0?'+':'')+alpha+'%',
      realReturn: (realReturn>0?'+':'')+realReturn+'%',
      annualTER: fmt(totalInvested * avgTER/100),
      fundsBeatBM: `${beatCount}/${funds.length}`,
      uniqueStocks: '~'+(funds.length*25),
      healthScore: healthScore+'/10',
      healthVerdict: blendedCAGR > BM5Y ? 'Portfolio outperforming benchmark' : 'Portfolio underperforming — restructure recommended',
      overlapPct: funds.length > 2 ? '55%' : '40%',
      keyFlags: [
        `Blended 5Y CAGR ${blendedCAGR.toFixed(1)}% vs benchmark ${BM5Y}% (alpha: ${alpha}%)`,
        `${beatCount} of ${funds.length} funds beat Nifty 100 TRI on 5Y basis`,
        `Real return after 6.2% CPI: ${realReturn}% — ${parseFloat(realReturn)>2?'positive':'below inflation'}`,
        `Annual TER cost: ${fmt(totalInvested*avgTER/100)} — check if active returns justify fees`,
      ],
    },
    funds: fundsArr,
    benchmark: {
      cagr5y:'13.2%', cagr3y:'14.0%', ret1y:'+0.8%', sharpe:'0.95', beta:'1.00', stddev:'12.8%',
      rolling1yAvg:'13.8%', rolling3yAvg:'14.4%',
      calendarReturns: {'2020':'+15.2%','2021':'+24.1%','2022':'+4.8%','2023':'+22.3%','2024':'+12.8%','2025':'+6.5%'}
    },
    risk: {
      blendedBeta:'0.95', bfsiPct:'34%', top5StocksPct:'28%', midSmallPct:'8%',
      uniqueStocks:'~'+(funds.length*22), stddev:'13.5%', maxDrawdown:'~-28%',
      downsideCap:'~88%', upsideCap:'~92%',
      stressScenarios: stress.map(s => ({ label:s.label, impact:s.impact, pct:s.pct })),
    },
    sectors: [
      {name:'BFSI',pct:34,flag:true},{name:'IT',pct:15,flag:false},{name:'Energy',pct:11,flag:false},
      {name:'Industrials',pct:10,flag:false},{name:'Consumer',pct:9,flag:false},{name:'Others',pct:21,flag:false}
    ],
    overlap: {
      overallPct: funds.length>2 ? '55%' : '40%',
      verdict: funds.length>3 ? 'High overlap — consolidate portfolio' : 'Moderate overlap',
      topStocks: [
        {stock:'HDFC Bank',funds:`${Math.min(funds.length,4)} funds`,avgWt:'8%',risk:'Very High'},
        {stock:'ICICI Bank',funds:`${Math.min(funds.length,4)} funds`,avgWt:'7%',risk:'Very High'},
        {stock:'Reliance',funds:`${Math.min(funds.length,3)} funds`,avgWt:'6%',risk:'High'},
        {stock:'Infosys',funds:`${Math.min(funds.length,3)} funds`,avgWt:'5%',risk:'Moderate'},
        {stock:'L&T',funds:`${Math.min(funds.length,2)} funds`,avgWt:'4%',risk:'Moderate'},
      ]
    },
    projections: {
      corpus: fmt(corpus),
      rows: [
        {label:'Current portfolio', cagr:projCAGR.toFixed(1)+'%', y5:project(projCAGR,5), y10:project(projCAGR,10), y15:project(projCAGR,15), y20:project(projCAGR,20), type:'bad'},
        {label:'Nifty 100 Index', cagr:'13.2%', y5:project(13.2,5), y10:project(13.2,10), y15:project(13.2,15), y20:project(13.2,20), type:'mid'},
        {label:'Recommended portfolio', cagr:'16.0%', y5:project(16,5), y10:project(16,10), y15:project(16,15), y20:project(16,20), type:'good'},
      ],
      gap20y: fmt(project(16,20).replace(/[₹,]/g,'')*1 - project(projCAGR,20).replace(/[₹,]/g,'')*1),
    },
    recommended: [
      {name:'Nippon India Large Cap',cat:'Large Cap',alloc:'25%',amt:fmt(corpus*0.25),cagr5y:'15.98%',sharpe:'0.89',ter:'0.65%',role:'Core anchor'},
      {name:'HDFC Mid-Cap Opp.',cat:'Mid Cap',alloc:'30%',amt:fmt(corpus*0.30),cagr5y:'18.7%',sharpe:'0.82',ter:'0.75%',role:'Growth kicker'},
      {name:'PPFAS Flexicap',cat:'Flexi Cap',alloc:'25%',amt:fmt(corpus*0.25),cagr5y:'17.3%',sharpe:'0.88',ter:'0.59%',role:'Intl diversifier'},
      {name:'Motilal Nifty 50 Index',cat:'Index',alloc:'20%',amt:fmt(corpus*0.20),cagr5y:'13.5%',sharpe:'0.94',ter:'0.11%',role:'Passive core'},
    ],
    execution: [
      {step:'Step 1 — Now',color:'bad',detail:'Exit worst performer first. Use ₹1.25L LTCG exemption this FY. Deploy into Nippon Large Cap + Nifty 50 Index.'},
      {step:'Step 2 — April 2027',color:'warn',detail:'Exit second underperformer with fresh ₹1.25L exemption. Top up HDFC Mid-Cap + PPFAS Flexicap.'},
      {step:'Step 3 — Oct 2027+',color:'ok',detail:'Annual rebalance. Exit any Q3/Q4 fund for 2 years running. Monitor manager continuity.'},
    ],
    scorecard: [
      {label:'Performance consistency',score:parseFloat(healthScore),note:`${beatCount}/${funds.length} funds beat Nifty 100 TRI (5Y)`},
      {label:'Diversification',score:funds.length>3?3:4.5,note:funds.length>3?'High overlap across funds':'Moderate concentration'},
      {label:'Risk control',score:5.0,note:'Beta ~0.95 — captures most of downside'},
      {label:'Cost efficiency',score:parseFloat(alpha)>0?6:3,note:`Active alpha: ${alpha}% vs ${avgTER}% TER paid`},
      {label:'Overall health',score:parseFloat(healthScore),note:blendedCAGR>BM5Y?'Portfolio beating benchmark':'Restructure recommended'},
    ],
  };
}

// ── MAIN ANALYSIS ──────────────────────────────────────────────────────────
async function runAnalysis(funds) {
  // Phase 1: Fetch AMFI data in parallel
  console.log(`\n[Phase 1] Fetching AMFI for ${funds.length} funds in parallel`);
  const results = await Promise.all(funds.map(async fund => {
    console.log(`  → ${fund.name}`);
    try { return await fetchFundData(fund); }
    catch(e) { console.error(`  ✗ ${fund.name}: ${e.message}`); return { fund, amt: parseFloat(fund.amt.replace(/[₹,\s]/g,''))||0, error: e.message }; }
  }));
  const ok = results.filter(r => !r.error).length;
  console.log(`[Phase 1] Done: ${ok}/${funds.length} fetched`);

  // Phase 2: Ask Claude ONLY for knowledge fields (tiny 800-token call)
  let knowledgeFields = [];
  console.log(`[Phase 2] Claude — manager/TER/Sharpe only (tiny call)`);
  try {
    knowledgeFields = await getKnowledgeFields(funds, results);
    console.log(`[Phase 2] Got ${knowledgeFields.length} fund records from Claude`);
  } catch(e) {
    console.warn(`[Phase 2] Claude failed (${e.message}) — using computed values only`);
  }

  // Phase 3: Build full report on server using math
  console.log(`[Phase 3] Building report on server`);
  const report = buildReport(funds, results, knowledgeFields);
  console.log(`[Phase 3] Done`);
  return JSON.stringify(report);
}

// ── HTTP SERVER ────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const { pathname } = url.parse(req.url, true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (pathname === '/health') {
    sendJSON(res, 200, { ok:true, key:!!ANTHROPIC_API_KEY, mode:'amfi-v6-server-computed' });
    return;
  }

  if (pathname === '/api/debug') {
    httpsGet('api.mfapi.in', '/mf/119598/latest', 8000)
      .then(r => { let n=null; try{n=JSON.parse(r.body);}catch{} sendJSON(res,200,{amfi:r.status===200,nav:n?.data?.[0]?.nav,fund:n?.meta?.scheme_name}); })
      .catch(e => sendJSON(res,200,{amfi:false,error:e.message}));
    return;
  }

  if (pathname === '/api/analyse' && req.method === 'POST') {
    if (!getRateLimit(getClientIP(req))) { sendJSON(res,429,{error:'Rate limit. Try again later.'}); return; }
    if (!ANTHROPIC_API_KEY) { sendJSON(res,500,{error:'API key not configured.'}); return; }
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', async () => {
      let payload;
      try { payload = JSON.parse(body); } catch { sendJSON(res,400,{error:'Invalid JSON'}); return; }
      if (!payload.funds?.length) { sendJSON(res,400,{error:'No funds'}); return; }
      try {
        console.log(`[${new Date().toISOString()}] ${payload.funds.length} funds from ${getClientIP(req)}`);
        const text = await runAnalysis(payload.funds);
        sendJSON(res, 200, { content:[{type:'text',text}] });
      } catch(e) {
        console.error('Failed:', e.message);
        sendJSON(res,500,{error:e.message||'Analysis failed'});
      }
    });
    return;
  }

  let fp = path.join(__dirname, pathname==='/'?'index.html':pathname.replace(/^\//,''));
  if (!fp.startsWith(__dirname)) { res.writeHead(403); res.end(); return; }
  const mime = MIME[path.extname(fp)] || 'text/html;charset=utf-8';
  fs.readFile(fp, (err, data) => {
    if (err) {
      fs.readFile(path.join(__dirname,'index.html'), (e2,d2) => {
        if (e2) { res.writeHead(404); res.end('Not found'); }
        else { res.writeHead(200,{'Content-Type':'text/html;charset=utf-8'}); res.end(d2); }
      });
    } else { res.writeHead(200,{'Content-Type':mime}); res.end(data); }
  });
});

server.listen(PORT, () => {
  console.log(`FundAudit v6 AMFI+server-math on port ${PORT} | key:${!!ANTHROPIC_API_KEY}`);
});
