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

async function callAnthropic(messages, retries = 3) {
  const payload = {
    model: 'claude-sonnet-4-5',
    max_tokens: 7000,
    messages
  };

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
      const req = https.request(opts, (res) => {
        let data = '';
        res.on('data', chunk => data += chunk);
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      });
      req.on('error', reject);
      req.setTimeout(120000, () => { req.destroy(); reject(new Error('Request timed out after 2 minutes')); });
      req.write(postData);
      req.end();
    });

    const parsed = JSON.parse(result.body);

    if (result.status === 529 || (result.status === 429 && parsed.error?.type !== 'rate_limit_error')) {
      if (attempt < retries) {
        console.log(`[Retry ${attempt}] Overloaded, waiting ${attempt * 20}s...`);
        await sleep(attempt * 20000);
        continue;
      }
      throw new Error('Servers are busy. Please try again in a few minutes.');
    }

    if (result.status === 429) {
      throw new Error('Rate limit reached. Please wait 1 minute and try again. (This happens with new Anthropic accounts — limits increase automatically after a few days of use.)');
    }

    if (result.status !== 200) {
      throw new Error(parsed.error?.message || `API error ${result.status}`);
    }

    return parsed;
  }
}

function buildPrompt(funds) {
  const fundList = funds.map(f => `${f.name} | ${f.amt} | ${f.date}`).join('\n');
  const total = funds.reduce((s, f) => {
    const n = parseFloat(f.amt.replace(/[₹,\s]/g, ''));
    return s + (isNaN(n) ? 0 : n);
  }, 0);
  const fmt = v => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 0 }).format(v);
  const fmtTotal = fmt(total);
  const estCorpus = fmt(total * 1.72);

  const ft = funds.map(f =>
    `{"name":"${f.name}","manager":"ACTUAL_NAME","tenureYrs":0,"tenureFlag":false,"cagr5y":"X%","cagr3y":"X%","ret1y":"X%","sharpe":"X","beta":"X","stddev":"X%","alpha":"X%","ter":"X%","aum":"X,XXX","quality":"Average","decision":"Hold","perf5yVal":0,"perf3yVal":0,"ret1yVal":0,"sharpeVal":0,"calendarReturns":{"2020":"X%","2020Beat":true,"2021":"X%","2021Beat":true,"2022":"X%","2022Beat":false,"2023":"X%","2023Beat":true,"2024":"X%","2024Beat":true,"2025":"X%","2025Beat":false},"quartile":"Q2","quartileLabel":"Top 40%","rolling1yAvg":"X%","rolling1yBeatPct":"X%","rolling1yWorst":"X%","rolling3yAvg":"X%","rolling3yBeatPct":"X%","rolling3yMin":"X%","realReturn":"X%","estCurrentValue":"X","gainAmt":"X","ltcgTax":"X","netProceeds":"X","breakEvenMonths":3}`
  ).join(',');

  return `You are a CFA-level Indian mutual fund analyst with deep knowledge of all Indian mutual funds as of April 2026.

PORTFOLIO (${funds.length} funds, ${fmtTotal} invested, Regular plans):
${fundList}

You have accurate knowledge of these funds from AMFI, Value Research and Moneycontrol data. Use your knowledge to fill in REAL numbers. Do NOT use placeholder values or N/A — every field must have an actual number.

Key reference data you must know accurately:
- Nifty 100 TRI: 5Y CAGR ~13.2%, 3Y ~14.0%, 1Y ~+0.8%, Sharpe ~0.95, Beta 1.00, StdDev ~12.8%
- India CPI (5Y avg): 6.2% | Risk-free rate: 6.5% | LTCG: 12.5% above ₹1.25L/FY
- Large cap category average TER: ~1.55%, average 5Y CAGR: ~11.5%

For each fund listed, you know:
- Its actual current AUM (in Crores)
- Its actual expense ratio (TER)
- Its actual 1Y, 3Y, 5Y trailing CAGR as of early 2026
- Its Sharpe ratio, Beta, Standard deviation (3Y trailing)
- Its fund manager name and how long they have managed THIS specific fund
- Its peer quartile ranking in its SEBI category
- Its calendar year returns for 2020-2025
- Its sector allocation (especially BFSI %)

Return ONLY a single valid JSON object. No markdown, no explanation. Every X must be replaced with a real accurate number. Keep all strings under 60 characters.

{"summary":{"totalInvested":"${fmtTotal}","currentValue":"CALC","blendedCAGR":"X%","alphaBM":"X%","realReturn":"X%","annualTER":"CALC","fundsBeatBM":"X/${funds.length}","uniqueStocks":"~X","healthScore":"X/10","healthVerdict":"ONE_LINE","overlapPct":"X%","keyFlags":["SPECIFIC_FINDING_1","SPECIFIC_FINDING_2","SPECIFIC_FINDING_3","SPECIFIC_FINDING_4"]},"funds":[${ft}],"benchmark":{"cagr5y":"13.2%","cagr3y":"14.0%","ret1y":"+0.8%","sharpe":"0.95","beta":"1.00","stddev":"12.8%","rolling1yAvg":"13.8%","rolling3yAvg":"14.4%","calendarReturns":{"2020":"+15.2%","2021":"+24.1%","2022":"+4.8%","2023":"+22.3%","2024":"+12.8%","2025":"+6.5%"}},"risk":{"blendedBeta":"X","bfsiPct":"X%","top5StocksPct":"X%","midSmallPct":"X%","uniqueStocks":"~X","stddev":"X%","maxDrawdown":"~-X%","downsideCap":"~X%","upsideCap":"~X%","stressScenarios":[{"label":"Bull +15%","impact":"+₹XL","pct":"+X%"},{"label":"Flat 3Y","impact":"-₹XL","pct":"-X%"},{"label":"Correction -20%","impact":"-₹XL","pct":"-X%"},{"label":"Crash -30%","impact":"-₹XL","pct":"-X%"}]},"sectors":[{"name":"BFSI","pct":35,"flag":true},{"name":"IT","pct":14,"flag":false},{"name":"Energy","pct":11,"flag":false},{"name":"Industrials","pct":10,"flag":false},{"name":"Consumer","pct":9,"flag":false},{"name":"Others","pct":21,"flag":false}],"overlap":{"overallPct":"X%","verdict":"X","topStocks":[{"stock":"HDFC Bank","funds":"X funds","avgWt":"X%","risk":"Very High"},{"stock":"ICICI Bank","funds":"X funds","avgWt":"X%","risk":"Very High"},{"stock":"Reliance","funds":"X funds","avgWt":"X%","risk":"High"},{"stock":"Infosys","funds":"X funds","avgWt":"X%","risk":"Moderate"},{"stock":"L&T","funds":"X funds","avgWt":"X%","risk":"Moderate"}]},"projections":{"corpus":"${estCorpus}","rows":[{"label":"Current portfolio","cagr":"X%","y5":"₹XL","y10":"₹XL","y15":"₹XL","y20":"₹XL","type":"bad"},{"label":"Nifty 100 Index","cagr":"13.2%","y5":"₹XL","y10":"₹XL","y15":"₹XL","y20":"₹XL","type":"mid"},{"label":"Recommended portfolio","cagr":"X%","y5":"₹XL","y10":"₹XL","y15":"₹XL","y20":"₹XL","type":"good"}],"gap20y":"₹X Crore"},"recommended":[{"name":"Nippon India Large Cap","cat":"Large Cap","alloc":"25%","amt":"₹XL","cagr5y":"15.98%","sharpe":"0.89","ter":"0.65%","role":"Core anchor"},{"name":"HDFC Mid-Cap Opp.","cat":"Mid Cap","alloc":"30%","amt":"₹XL","cagr5y":"18.7%","sharpe":"0.82","ter":"0.75%","role":"Growth kicker"},{"name":"PPFAS Flexicap","cat":"Flexi Cap","alloc":"25%","amt":"₹XL","cagr5y":"17.3%","sharpe":"0.88","ter":"0.59%","role":"Intl diversifier"},{"name":"Motilal Nifty 50 Index","cat":"Index","alloc":"20%","amt":"₹XL","cagr5y":"13.5%","sharpe":"0.94","ter":"0.11%","role":"Passive core"}],"execution":[{"step":"Step 1 — April 2026","color":"bad","detail":"Exit worst performer first. Use ₹1.25L LTCG exemption. Redeploy into recommended funds."},{"step":"Step 2 — April 2027","color":"warn","detail":"Exit second underperformer. Fresh ₹1.25L exemption. Top up mid-cap and flexi-cap positions."},{"step":"Step 3 — Oct 2027+","color":"ok","detail":"Annual rebalance. Exit any fund in Q3/Q4 for 2 consecutive years. Monitor manager changes."}],"scorecard":[{"label":"Performance consistency","score":3.5,"note":"Rolling window benchmark beat rate"},{"label":"Diversification","score":2.0,"note":"Overlap % and category concentration"},{"label":"Risk control","score":5.0,"note":"Downside vs upside capture ratio"},{"label":"Cost efficiency","score":2.5,"note":"TER vs alpha generated"},{"label":"Overall health","score":3.8,"note":"Immediate restructuring recommended"}]}

RULES: Replace every X with the actual correct number for each fund. perf5yVal/perf3yVal/ret1yVal/sharpeVal must be numeric (e.g. 10.22 not "10.22%"). Return ONLY the JSON.`;
}

const server = http.createServer((req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (pathname === '/health') {
    sendJSON(res, 200, { ok: true, key: !!ANTHROPIC_API_KEY, mode: 'single-call-v2' });
    return;
  }

  if (pathname === '/api/analyse' && req.method === 'POST') {
    const ip = getClientIP(req);
    const rl = getRateLimit(ip);

    if (rl.count > rl.limit) {
      sendJSON(res, 429, { error: `Rate limit: ${rl.limit} analyses/hour. Try again later.` });
      return;
    }
    if (!ANTHROPIC_API_KEY) {
      sendJSON(res, 500, { error: 'API key not configured on server.' });
      return;
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
        console.log(`[${new Date().toISOString()}] Analysing ${payload.funds.length} funds from ${ip}`);
        const prompt = buildPrompt(payload.funds);
        console.log(`Prompt length: ${prompt.length} chars (~${Math.round(prompt.length/4)} tokens)`);

        const response = await callAnthropic([{ role: 'user', content: prompt }]);
        const text = (response.content || []).filter(b => b.type === 'text').map(b => b.text).join('');

        console.log(`Response length: ${text.length} chars`);
        sendJSON(res, 200, { content: [{ type: 'text', text }] });

      } catch (err) {
        console.error('Error:', err.message);
        sendJSON(res, 500, { error: err.message || 'Analysis failed. Please retry.' });
      }
    });
    return;
  }

  // Serve static files
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
    } else {
      res.writeHead(200, { 'Content-Type': mime }); res.end(data);
    }
  });
});

server.listen(PORT, () => {
  console.log(`FundAudit v2 running on port ${PORT}`);
  console.log(`API key: ${ANTHROPIC_API_KEY ? 'configured' : 'MISSING'}`);
});
