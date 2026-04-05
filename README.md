# FundAudit — Deploy Your Own Shareable Link

A free, no-login mutual fund portfolio analyser. Users just enter fund name, amount, and date — they get a full institutional-grade visual audit without needing any API key.

---

## Deploy in 5 minutes on Render (free)

### Step 1 — Upload to GitHub

1. Go to https://github.com and sign in (or create a free account)
2. Click **New repository** → name it `fundaudit` → click **Create repository**
3. Click **uploading an existing file** on the next screen
4. Drag and drop these files from this folder:
   - `server.js`
   - `package.json`
   - `render.yaml`
   - The entire `public/` folder (drag the folder itself)
5. Click **Commit changes**

### Step 2 — Deploy on Render

1. Go to https://render.com and sign in with your GitHub account
2. Click **New** → **Web Service**
3. Connect your GitHub account if prompted
4. Select your `fundaudit` repository
5. Render auto-detects the settings. Click **Create Web Service**
6. **IMPORTANT:** Before clicking deploy, go to **Environment** tab and add:
   - Key: `ANTHROPIC_API_KEY`
   - Value: your API key (starts with `sk-ant-api03-...`)
7. Click **Save Changes** then **Deploy**

### Step 3 — Get your link

After ~2 minutes, Render gives you a URL like:
`https://fundaudit-xxxx.onrender.com`

**Share this link with anyone.** They can use it immediately — no API key, no login, no setup.

---

## What users see

- Clean landing page with fund name / amount / date form
- 4 example portfolios to try instantly
- 10-step progress bar while analysis runs
- Full visual dashboard: KPIs, heatmap, rolling returns, sector chart, overlap matrix, stress test, tax analysis, goal projections, recommended portfolio, execution plan, scorecard
- Download report as HTML

---

## Rate limiting

The server limits each IP address to **10 analyses per hour** to prevent API cost overruns. You can change this in `server.js`:

```js
const RATE_LIMIT_MAX = 10; // change this number
const RATE_LIMIT_WINDOW = 60 * 60 * 1000; // 1 hour in ms
```

---

## Cost estimate

- Render free tier: **$0/month** (spins down after 15 min inactivity, ~30s cold start)
- Anthropic API: ~$0.01–0.03 per analysis with claude-sonnet-4-5
- 100 analyses/day ≈ $1–3/day

To upgrade to always-on (no cold start): Render Starter plan is $7/month.

---

## Alternative free hosts

| Host | Free tier | Notes |
|------|-----------|-------|
| Render | ✅ Yes | Best option, auto-deploy from GitHub |
| Railway | ✅ Yes | $5 credit/month, easy setup |
| Fly.io | ✅ Yes | More technical but very fast |
| Vercel | ❌ No | Node.js servers need Pro plan |

---

## Local testing

```bash
# Set your API key
export ANTHROPIC_API_KEY=sk-ant-api03-...

# Start the server
node server.js

# Open http://localhost:3000
```
