const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = process.env.PORT || 3000;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW = 60 * 60 * 1000;
const RATE_LIMIT_MAX = 15;

function getRateLimit(ip) {
  const now = Date.now();
  const entry = rateLimitMap.get(ip) || { count: 0, resetAt: now + RATE_LIMIT_WINDOW };
  if (now > entry.resetAt) { entry.count = 0; entry.resetAt = now + RATE_LIMIT_WINDOW; }
  entry.count++;
  rateLimitMap.set(ip, entry);
  return { count: entry.count, resetAt: entry.resetAt, limit: RATE_LIMIT_MAX };
}

function getClientIP(req) {
  return (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.ico': 'image/x-icon',
};

function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Generic HTTPS GET
function httpsGet(hostname, path) {
  return new Promise((resolve, reject) => {
    const req = https.request({ hostname, path, method: 'GET',
      headers: { 'User-Agent': 'FundAudit/1.0' }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

// Search for fund scheme code on mfapi.in
async function searchFundCode(fundName) {
  try {
    const query = encodeURIComponent(fundName);
    const result = await httpsGet('api.mfapi.in', `/mf/search?q=${query}`);
    if (result.status !== 200) return null;
    const schemes = JSON.parse(result.body);
    if (!schemes || schemes.length === 0) return null;

    // Prefer regular plan growth over direct
    const preferred = schemes.find(s =>
      s.schemeName.toLowerCase().includes('regular') &&
      (s.schemeName.toLowerCase().includes('growth') || s.schemeName.toLowerCase().includes('gr'))
    ) || schemes.find(s =>
      !s.schemeName.toLowerCase().includes('direct') &&
      (s.schemeName.toLowerCase().includes('growth') || s.schemeName.toLowerCase().includes('gr'))
    ) || schemes[0];

    return preferred;
  } catch(e) {
    console.warn(`Search failed for ${fundName}: ${e.message}`);
    return null;
  }
}

// Get NAV history and compute returns
async function getFundData(schemeCode, investmentDate) {
  try {
    const result = await httpsGet('api.mfapi.in', `/mf/${schemeCode}`);
    if (result.status !== 200) return null;
    const fund = JSON.parse(result.body);
    if (!fund || !fund.data || fund.data.length === 0) return null;

    const navData = fund.data; // [{date, nav}] newest first
    const latestNAV = parseFloat(navData[0].nav);
    const latestDate = navData[0].date;

    // Helper: find NAV closest to a target date
    function navOnDate(targetDateStr) {
      // targetDateStr: DD-MMM-YYYY or DD-MM-YYYY
      const target = parseDate(targetDateStr);
      if (!target) return null;
      let closest = null, minDiff = Infinity;
      for (const d of navData) {
        const nd = parseDate(d.date);
        if (!nd) continue;
        const diff = Math.abs(nd - target);
        if (diff < minDiff) { minDiff = diff; closest = d; }
        if (diff > minDiff) break; // data is sorted desc, once increasing stop
      }
      return closest ? parseFloat(closest.nav) : null;
    }

    function parseDate(str) {
      if (!str) return null;
      // Formats: DD-MMM-YYYY (01-Apr-2020), DD-MM-YYYY (01-04-2020)
      const months = {jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11};
      const parts = str.split('-');
      if (parts.length !== 3) return null;
      let day = parseInt(parts[0]);
      let month, year;
      if (parts[1].length === 3 && isNaN(parts[1])) {
        month = months[parts[1].toLowerCase()];
        year = parseInt(parts[2]);
      } else {
        month = parseInt(parts[1]) - 1;
        year = parseInt(parts[2]);
      }
      if (isNaN(day) || month === undefined || isNaN(year)) return null;
      return new Date(year, month, day);
    }

    function dateNYearsAgo(n) {
      const d = new Date();
      d.setFullYear(d.getFullYear() - n);
      return `${String(d.getDate()).padStart(2,'0')}-${String(d.getMonth()+1).padStart(2,'0')}-${d.getFullYear()}`;
    }

    function cagr(startNav, endNav, years) {
      if (!startNav || !endNav || years <= 0) return null;
      return (Math.pow(endNav / startNav, 1 / years) - 1) * 100;
    }

    const nav1yAgo = navOnDate(dateNYearsAgo(1));
    const nav3yAgo = navOnDate(dateNYearsAgo(3));
    const nav5yAgo = navOnDate(dateNYearsAgo(5));
    const navAtInvestment = investmentDate ? navOnDate(investmentDate) : null;

    const ret1y = nav1yAgo ? cagr(nav1yAgo, latestNAV, 1) : null;
    const ret3y = nav3yAgo ? cagr(nav3yAgo, latestNAV, 3) : null;
    const ret5y = nav5yAgo ? cagr(nav5yAgo, latestNAV, 5) : null;

    // Calendar year returns
    function calendarYearReturn(year) {
      const startNav = navOnDate(`01-01-${year}`);
      const endNav = navOnDate(`31-12-${year}`);
      if (!startNav || !endNav) return null;
      return ((endNav - startNav) / startNav) * 100;
    }

    const calReturns = {};
    for (const yr of [2020, 2021, 2022, 2023, 2024, 2025]) {
      const r = calendarYearReturn(yr);
      calReturns[yr] = r !== null ? r.toFixed(1) : null;
    }

    // Investment growth
    let currentValue = null, absoluteReturn = null, investmentCAGR = null;
    if (navAtInvestment) {
      const investDate = parseDate(investmentDate);
      const yearsHeld = investDate ? (Date.now() - investDate) / (365.25 * 24 * 3600 * 1000) : null;
      currentValue = latestNAV / navAtInvestment;
      absoluteReturn = ((latestNAV - navAtInvestment) / navAtInvestment) * 100;
      investmentCAGR = yearsHeld ? cagr(navAtInvestment, latestNAV, yearsHeld) : null;
    }

    return {
      schemeCode,
      schemeName: fund.meta.scheme_name,
      fundHouse: fund.meta.fund_house,
      schemeCategory: fund.meta.scheme_category,
      latestNAV: latestNAV.toFixed(4),
      latestDate,
      navAtInvestment: navAtInvestment ? navAtInvestment.toFixed(4) : null,
      ret1y: ret1y ? ret1y.toFixed(2) : null,
      ret3y: ret3y ? ret3y.toFixed(2) : null,
      ret5y: ret5y ? ret5y.toFixed(2) : null,
      calReturns,
      currentValueMultiple: currentValue ? currentValue.toFixed(4) : null,
      absoluteReturn: absoluteReturn ? absoluteReturn.toFixed(2) : null,
      investmentCAGR: investmentCAGR ? investmentCAGR.toFixed(2) : null,
    };
  } catch(e) {
    console.warn(`NAV fetch failed for ${schemeCode}: ${e.message}`);
    return null;
  }
}

// Call Anthropic with retry
async function callAnthropic(messages, retries = 3) {
  const payload = { model: 'claude-sonnet-4-5', max_tokens: 7000, messages };
  const postData = JSON.stringify(payload);
  const opts = {
    hostname: 'api.anthropic.com', port: 443, path: '/v1/messages', method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'Content-Length': Buffer.byteLength(postData)
    }
  };

  for (let attempt = 1; attempt <= retries; attempt++) {
    const result = await new Promise((resolve, reject) => {
      const req = https.request(opts, res => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      });
      req.on('error', reject);
      req.setTimeout(120000, () => { req.destroy(); reject(new Error('Timed out')); });
      req.write(postData);
      req.end();
    });

    const parsed = JSON.parse(result.body);
    if (result.status === 529 || result.status === 500) {
      if (attempt < retries) { await sleep(attempt * 20000); continue; }
      throw new Error('Servers busy. Try again in a few minutes.');
    }
    if (result.status === 429) {
      const msg = parsed.error?.message || '';
      if (msg.includes('rate limit') || msg.includes('tokens')) {
        throw new Error('Rate limit hit. Please wait 1 minute and try again.');
      }
      if (attempt < retries) { await sleep(attempt * 20000); continue; }
    }
    if (result.status !== 200) throw new Error(parsed.error?.message || `API error ${result.status}`);
    return parsed;
  }
}

async function runAnalysis(funds) {
  const total = funds.reduce((s, f) => {
    const n = parseFloat(f.amt.replace(/[₹,\s]/g, ''));
    return s + (isNaN(n) ? 0 : n);
  }, 0);
  const fmt = v => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(v);

  // PHASE 1: Fetch real NAV data from AMFI via mfapi.in
  console.log(`[Phase 1] Fetching live AMFI data for ${funds.length} funds`);
  const liveData = [];

  for (const fund of funds) {
    console.log(`  Searching: ${fund.name}`);
    const scheme = await searchFundCode(fund.name);
    if (scheme) {
      console.log(`  Found: ${scheme.schemeName} (code: ${scheme.schemeCode})`);
      const data = await getFundData(scheme.schemeCode, fund.date);
      if (data) {
        liveData.push({ fund, scheme, data });
        console.log(`  NAV: ${data.latestNAV} | 1Y: ${data.ret1y}% | 3Y: ${data.ret3y}% | 5Y: ${data.ret5y}%`);
      } else {
        liveData.push({ fund, scheme: null, data: null });
        console.warn(`  NAV data unavailable`);
      }
    } else {
      liveData.push({ fund, scheme: null, data: null });
      console.warn(`  Fund not found on AMFI`);
    }
  }

  // Build live data summary for Claude
  const liveDataStr = liveData.map(({ fund, scheme, data }) => {
    const amt = parseFloat(fund.amt.replace(/[₹,\s]/g, ''));
    if (!data) return `${fund.name}: AMFI data not found — use training knowledge`;

    const currentVal = data.navAtInvestment
      ? fmt(amt * parseFloat(data.currentValueMultiple))
      : 'unknown';

    const calStr = Object.entries(data.calReturns)
      .map(([yr, ret]) => `${yr}: ${ret ? ret+'%' : 'N/A'}`)
      .join(', ');

    return `
FUND: ${fund.name}
AMFI Scheme: ${data.schemeName}
Fund House: ${data.fundHouse}
Category: ${data.schemeCategory}
Latest NAV: ₹${data.latestNAV} (as of ${data.latestDate})
NAV on investment date (${fund.date}): ₹${data.navAtInvestment || 'N/A'}
Amount invested: ${fund.amt}
Current value: ${currentVal}
Absolute return since investment: ${data.absoluteReturn ? data.absoluteReturn+'%' : 'N/A'}
CAGR since investment: ${data.investmentCAGR ? data.investmentCAGR+'%' : 'N/A'}
1Y CAGR (trailing): ${data.ret1y ? data.ret1y+'%' : 'N/A'}
3Y CAGR (trailing): ${data.ret3y ? data.ret3y+'%' : 'N/A'}
5Y CAGR (trailing): ${data.ret5y ? data.ret5y+'%' : 'N/A'}
Calendar returns: ${calStr}`;
  }).join('\n\n---\n');

  console.log(`[Phase 1] Done. Live data fetched for ${liveData.filter(d => d.data).length}/${funds.length} funds`);

  // Compute portfolio totals
  let totalCurrentValue = 0;
  let allHaveCurrent = true;
  for (const { fund, data } of liveData) {
    if (data && data.currentValueMultiple && data.navAtInvestment) {
      const amt = parseFloat(fund.amt.replace(/[₹,\s]/g, ''));
      totalCurrentValue += amt * parseFloat(data.currentValueMultiple);
    } else {
      allHaveCurrent = false;
    }
  }
  const estCurrentValue = allHaveCurrent ? fmt(totalCurrentValue) : 'calculated below';
  const estCorpus = allHaveCurrent ? fmt(totalCurrentValue) : fmt(total * 1.72);

  // PHASE 2: Claude analysis using real data
  console.log(`[Phase 2] Generating analysis with real AMFI data`);

  const ft = liveData.map(({ fund, data }) => {
    const ret1y = data?.ret1y || 'X';
    const ret3y = data?.ret3y || 'X';
    const ret5y = data?.ret5y || 'X';
    const ret1yVal = parseFloat(data?.ret1y) || 0;
    const ret3yVal = parseFloat(data?.ret3y) || 0;
    const ret5yVal = parseFloat(data?.ret5y) || 0;
    const calR = data?.calReturns || {};

    return `{"name":"${fund.name}","manager":"FILL_FROM_KNOWLEDGE","tenureYrs":0,"tenureFlag":false,"cagr5y":"${ret5y}%","cagr3y":"${ret3y}%","ret1y":"${ret1y}%","sharpe":"FILL","beta":"FILL","stddev":"FILL%","alpha":"FILL%","ter":"FILL%","aum":"FILL","quality":"Average","decision":"Hold","perf5yVal":${ret5yVal},"perf3yVal":${ret3yVal},"ret1yVal":${ret1yVal},"sharpeVal":0,"calendarReturns":{"2020":"${calR[2020]||'X'}%","2020Beat":${parseFloat(calR[2020]||0)>15.2},"2021":"${calR[2021]||'X'}%","2021Beat":${parseFloat(calR[2021]||0)>24.1},"2022":"${calR[2022]||'X'}%","2022Beat":${parseFloat(calR[2022]||0)>4.8},"2023":"${calR[2023]||'X'}%","2023Beat":${parseFloat(calR[2023]||0)>22.3},"2024":"${calR[2024]||'X'}%","2024Beat":${parseFloat(calR[2024]||0)>12.8},"2025":"${calR[2025]||'X'}%","2025Beat":${parseFloat(calR[2025]||0)>6.5}},"quartile":"Q2","quartileLabel":"FILL","rolling1yAvg":"FILL%","rolling1yBeatPct":"FILL%","rolling1yWorst":"FILL%","rolling3yAvg":"FILL%","rolling3yBeatPct":"FILL%","rolling3yMin":"FILL%","realReturn":"FILL%","estCurrentValue":"FILL","gainAmt":"FILL","ltcgTax":"FILL","netProceeds":"FILL","breakEvenMonths":3}`;
  }).join(',');

  const prompt = `You are a CFA-level Indian mutual fund analyst. I have fetched REAL live data from AMFI's official API (mfapi.in) for each fund. The NAV-based returns below are 100% accurate — computed from actual historical NAV data.

REAL AMFI DATA (computed from actual NAV history):
${liveDataStr}

PORTFOLIO TOTALS:
Total invested: ${fmt(total)}
Estimated current value: ${estCurrentValue}

Your task:
1. Use the AMFI return figures EXACTLY as given — do NOT change 1Y/3Y/5Y CAGR values
2. Fill in the remaining fields from your knowledge: Sharpe ratio, Beta, Std Dev, Alpha, TER, AUM, Fund manager name & tenure, peer quartile, rolling returns, sector allocation, overlap
3. For Sharpe, Beta, Std Dev: use Value Research / Moneycontrol figures you know for these specific funds
4. Calculate tax, net proceeds, break-even from the real investment and current values
5. Make Hold/Switch/Exit decisions based on the REAL performance data

Return ONLY a single valid JSON — no markdown, no explanation:

{"summary":{"totalInvested":"${fmt(total)}","currentValue":"${estCurrentValue}","blendedCAGR":"CALC_FROM_REAL_DATA","alphaBM":"CALC_VS_13.2%","realReturn":"CALC_MINUS_6.2%_CPI","annualTER":"CALC","fundsBeatBM":"X/${funds.length}","uniqueStocks":"~X","healthScore":"X/10","healthVerdict":"ONE_LINE","overlapPct":"X%","keyFlags":["SPECIFIC_REAL_FINDING","SPECIFIC_REAL_FINDING","SPECIFIC_REAL_FINDING","SPECIFIC_REAL_FINDING"]},"funds":[${ft}],"benchmark":{"cagr5y":"13.2%","cagr3y":"14.0%","ret1y":"+0.8%","sharpe":"0.95","beta":"1.00","stddev":"12.8%","rolling1yAvg":"13.8%","rolling3yAvg":"14.4%","calendarReturns":{"2020":"+15.2%","2021":"+24.1%","2022":"+4.8%","2023":"+22.3%","2024":"+12.8%","2025":"+6.5%"}},"risk":{"blendedBeta":"X","bfsiPct":"X%","top5StocksPct":"X%","midSmallPct":"X%","uniqueStocks":"~X","stddev":"X%","maxDrawdown":"~-X%","downsideCap":"~X%","upsideCap":"~X%","stressScenarios":[{"label":"Bull +15%","impact":"+₹XL","pct":"+X%"},{"label":"Flat 3Y","impact":"-₹XL","pct":"-X%"},{"label":"Correction -20%","impact":"-₹XL","pct":"-X%"},{"label":"Crash -30%","impact":"-₹XL","pct":"-X%"}]},"sectors":[{"name":"BFSI","pct":35,"flag":true},{"name":"IT","pct":14,"flag":false},{"name":"Energy","pct":11,"flag":false},{"name":"Industrials","pct":10,"flag":false},{"name":"Consumer","pct":9,"flag":false},{"name":"Others","pct":21,"flag":false}],"overlap":{"overallPct":"X%","verdict":"X","topStocks":[{"stock":"HDFC Bank","funds":"X funds","avgWt":"X%","risk":"Very High"},{"stock":"ICICI Bank","funds":"X funds","avgWt":"X%","risk":"Very High"},{"stock":"Reliance","funds":"X funds","avgWt":"X%","risk":"High"},{"stock":"Infosys","funds":"X funds","avgWt":"X%","risk":"Moderate"},{"stock":"L&T","funds":"X funds","avgWt":"X%","risk":"Moderate"}]},"projections":{"corpus":"${estCorpus}","rows":[{"label":"Current portfolio","cagr":"X%","y5":"₹XL","y10":"₹XL","y15":"₹XL","y20":"₹XL","type":"bad"},{"label":"Nifty 100 Index","cagr":"13.2%","y5":"₹XL","y10":"₹XL","y15":"₹XL","y20":"₹XL","type":"mid"},{"label":"Recommended portfolio","cagr":"X%","y5":"₹XL","y10":"₹XL","y15":"₹XL","y20":"₹XL","type":"good"}],"gap20y":"₹X Crore"},"recommended":[{"name":"Nippon India Large Cap","cat":"Large Cap","alloc":"25%","amt":"₹XL","cagr5y":"15.98%","sharpe":"0.89","ter":"0.65%","role":"Core anchor"},{"name":"HDFC Mid-Cap Opp.","cat":"Mid Cap","alloc":"30%","amt":"₹XL","cagr5y":"18.7%","sharpe":"0.82","ter":"0.75%","role":"Growth kicker"},{"name":"PPFAS Flexicap","cat":"Flexi Cap","alloc":"25%","amt":"₹XL","cagr5y":"17.3%","sharpe":"0.88","ter":"0.59%","role":"Intl diversifier"},{"name":"Motilal Nifty 50 Index","cat":"Index","alloc":"20%","amt":"₹XL","cagr5y":"13.5%","sharpe":"0.94","ter":"0.11%","role":"Passive core"}],"execution":[{"step":"Step 1 — April 2026","color":"bad","detail":"Exit worst performer first. Use ₹1.25L LTCG exemption. Redeploy into recommended funds."},{"step":"Step 2 — April 2027","color":"warn","detail":"Exit second underperformer. Fresh ₹1.25L exemption. Top up mid-cap and flexi-cap."},{"step":"Step 3 — Oct 2027+","color":"ok","detail":"Annual rebalance. Exit any Q3/Q4 fund 2 years running. Monitor manager changes."}],"scorecard":[{"label":"Performance consistency","score":3.5,"note":"Based on real AMFI rolling returns"},{"label":"Diversification","score":2.0,"note":"Overlap and category concentration"},{"label":"Risk control","score":5.0,"note":"Downside vs upside capture"},{"label":"Cost efficiency","score":2.5,"note":"TER vs alpha delivered"},{"label":"Overall health","score":3.8,"note":"Restructure recommended"}]}

CRITICAL: The 1Y/3Y/5Y CAGR values in the funds array are pre-filled from real AMFI data. Do NOT change them. Only fill in the FILL placeholders using your knowledge.`;

  const response = await callAnthropic([{ role: 'user', content: prompt }]);
  const text = (response.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  console.log(`[Phase 2] Done. Response: ${text.length} chars`);
  return text;
}

const server = http.createServer((req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (pathname === '/health') {
    sendJSON(res, 200, { ok: true, key: !!ANTHROPIC_API_KEY, mode: 'amfi-live-data' });
    return;
  }

  if (pathname === '/api/analyse' && req.method === 'POST') {
    const ip = getClientIP(req);
    const rl = getRateLimit(ip);
    if (rl.count > rl.limit) {
      sendJSON(res, 429, { error: `Rate limit: ${rl.limit} analyses/hour.` }); return;
    }
    if (!ANTHROPIC_API_KEY) {
      sendJSON(res, 500, { error: 'API key not configured.' }); return;
    }

    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', async () => {
      let payload;
      try { payload = JSON.parse(body); } catch {
        sendJSON(res, 400, { error: 'Invalid request' }); return;
      }
      if (!payload.funds || !Array.isArray(payload.funds)) {
        sendJSON(res, 400, { error: 'Missing funds array' }); return;
      }

      try {
        console.log(`[${new Date().toISOString()}] Request: ${payload.funds.length} funds from ${ip}`);
        const result = await runAnalysis(payload.funds);
        sendJSON(res, 200, { content: [{ type: 'text', text: result }] });
      } catch (err) {
        console.error('Error:', err.message);
        sendJSON(res, 500, { error: err.message || 'Analysis failed. Please retry.' });
      }
    });
    return;
  }

  let filePath = path.join(__dirname, pathname === '/' ? 'index.html' : pathname.replace(/^\//, ''));
  if (!filePath.startsWith(__dirname)) { res.writeHead(403); res.end('Forbidden'); return; }
  const ext = path.extname(filePath);
  const mime = MIME[ext] || 'text/html; charset=utf-8';
  fs.readFile(filePath, (err, data) => {
    if (err) {
      fs.readFile(path.join(__dirname, 'index.html'), (err2, data2) => {
        if (err2) { res.writeHead(404); res.end('Not found'); }
        else { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(data2); }
      });
    } else { res.writeHead(200, { 'Content-Type': mime }); res.end(data); }
  });
});

server.listen(PORT, () => {
  console.log(`FundAudit AMFI-live running on port ${PORT}`);
  console.log(`API key: ${ANTHROPIC_API_KEY ? 'configured' : 'MISSING'}`);
});
