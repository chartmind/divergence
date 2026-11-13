// Divergence — daily server-side calibration.
// Runs on a schedule (GitHub Actions), fetches free Yahoo/Binance data,
// re-tests every signal ingredient by market type and publishes JSON for the app.
// The stock universe is dynamic: the fixed core list + the S&P 500 + today's Yahoo
// movers (kept for 10 days). Node 20+, no dependencies.
import { readFile, writeFile, mkdir } from 'node:fs/promises';

import { pathToFileURL } from 'node:url';
const OUT = new URL('data/', pathToFileURL(process.cwd() + '/'));
const BASE = ["SPY","QQQ","IWM","AAPL","MSFT","NVDA","AVGO","ORCL","CRM","ADBE","AMD","INTC","MU","PLTR","CRWD","PANW","NET","SNOW","GOOGL","META","NFLX","DIS","T","VZ","TMUS","SPOT","RDDT","PINS","SNAP","AMZN","TSLA","HD","MCD","WMT","COST","PG","KO","PEP","PM","MDLZ","CL","KHC","TGT","JPM","BAC","WFC","GS","MS","V","MA","AXP","SCHW","HOOD","SOFI","PYPL","LLY","UNH","JNJ","ABBV","MRK","PFE","TMO","ISRG","VRTX","MRNA","HIMS","XOM","CVX","COP","OXY","SLB","EOG","MPC","DVN","HAL","CAT","GE","BA","HON","UPS","RTX","LMT","DE","UBER","RKLB","LIN","FCX","NEM","SHW","DOW","NUE","ALB","MP","NEE","DUK","SO","CEG","VST","OKLO","SMR","CCJ","PLD","AMT","EQIX","O","SPG","DLR","MSTR","COIN","MARA","RIOT","HUT","CLSK","IREN","CIFR","ACN","BB","NOK","BITF","WULF","APLD","CORZ","BTBT","PLUG","LCID","NIO","FUBO","AMC","GME","SNDL","TLRY","OPEN","IONQ","RGTI","QBTS","SOUN","BBAI","ACHR","JOBY","LUNR","ASTS","UPST","AFRM","CHPT","BLNK","QS","RUN","SIRI","GRAB","CELH","RXRX","NVAX","MVIS","CLOV"];
const IDX = ["^GSPC","^NDX","^DJI","^RUT","^VIX","^TNX","^FVX","^TYX","TLT","GC=F","SI=F","CL=F","NG=F","HG=F","ES=F","NQ=F","YM=F","RTY=F","ZN=F","ZB=F","6E=F","BZ=F","BTC-USD","ETH-USD","SOL-USD","DX-Y.NYB","EURUSD=X"];
const INDIA_BUDGET_MS = 12 * 60 * 1000;
const MOVER_SCREENS = ['day_gainers', 'day_losers', 'most_actives', 'small_cap_gainers', 'growth_technology_stocks'];
const MOVER_KEEP_DAYS = 10, MOVER_CAP = 80, MAX_SYMBOLS = 700, TIME_BUDGET_MS = 25 * 60 * 1000, MIN_BARS = 100;
const UA = { 'User-Agent': 'Mozilla/5.0 (compatible; divergence-calibrator/1.0)' };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---- shared logic, copied verbatim from Divergence Terminal.dc.html ----
function ema(a, p) { const k = 2 / (p + 1); const o = []; let e = a[0]; for (let i = 0; i < a.length; i++) { e = i ? a[i] * k + e * (1 - k) : a[0]; o.push(e); } return o; }

function rsi(a, p) {
  const o = new Array(a.length).fill(null); let g = 0, l = 0;
  for (let i = 1; i <= p && i < a.length; i++) { const d = a[i] - a[i - 1]; if (d > 0) g += d; else l -= d; }
  g /= p; l /= p; o[p] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  for (let i = p + 1; i < a.length; i++) { const d = a[i] - a[i - 1]; g = (g * (p - 1) + Math.max(d, 0)) / p; l = (l * (p - 1) + Math.max(-d, 0)) / p; o[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l); }
  return o;
}

function macd(a) { const f = ema(a, 12), s = ema(a, 26), m = a.map((_, i) => f[i] - s[i]), sig = ema(m, 9); return { m, sig, hist: m.map((v, i) => v - sig[i]) }; }

function dayKey(v) { if (v == null) return null; let n = typeof v === 'number' ? v : Date.parse(v); if (!isFinite(n)) return null; if (n < 1e12) n *= 1000; return Math.floor((n - 4 * 3600e3) / 864e5); }

const CAL_REGS = ['bullCalm', 'bullVol', 'bearCalm', 'bearVol'];

const CAL_REG_LBL = { bullCalm: 'Uptrend · calm', bullVol: 'Uptrend · volatile', bearCalm: 'Downtrend · calm', bearVol: 'Downtrend · volatile' };

const CAL_FEATS = [
  ['trendUp', 'EMA stack up (price > 10 > 50 > 200)'], ['trendDn', 'EMA stack down'],
  ['oversold', 'RSI below 30'], ['overbought', 'RSI above 70'],
  ['confirmOS', 'Oversold, then close back above EMA 10'],
  ['bbLow', 'Close below lower Bollinger'], ['bbHigh', 'Close above upper Bollinger'],
  ['bbdcRev', 'BB/DC low + RSI divergence'],
  ['macdUp', 'MACD cross up'], ['macdDn', 'MACD cross down'],
  ['volUp', 'Volume surge on an up day (1.8× avg)'], ['volDn', 'Volume surge on a down day'],
  ['newHigh', 'New 52-week high'],
  ['nearHigh', 'Near 52-week high (within 3%, not at it)'],
  ['mom12', '12-month winner (up 30%+, skipping the last month)'],
  ['momLose', '12-month loser (down 20%+, skipping the last month)'],
  ['rev1m', 'Down 15%+ in one month'],
  ['rev1mUp', 'Up 20%+ in one month'],
  ['golden', 'Golden cross (EMA 50 above EMA 200, last 5 days)'],
  ['death', 'Death cross (EMA 50 below EMA 200, last 5 days)'],
  ['donUp', 'Close above the prior 20-day high'],
  ['donDn', 'Close below the prior 20-day low'],
  ['pullback', 'Uptrend with RSI below 45'],
  ['lowVol', 'Low volatility (under 25% a year)'],
  ['stretched', 'More than 40% above EMA 200'],
  ['deepBelow', 'More than 30% below EMA 200'],
  ['dn3', 'Sharp 3-day drop (8%+)'],
  ['news', 'Active news / shortage theme']
];

function calFeatsAt(cl, hi, lo, v, E10, E50, E200, R, H, k) {
  const f = {}, c = cl[k];
  f.trendUp = c > E10[k] && E10[k] > E50[k] && E50[k] > E200[k];
  f.trendDn = c < E10[k] && E10[k] < E50[k] && E50[k] < E200[k];
  f.oversold = R[k] != null && R[k] < 30; f.overbought = R[k] != null && R[k] > 70;
  let mnR = 100; for (let j = k - 5; j < k; j++) if (R[j] != null) mnR = Math.min(mnR, R[j]);
  f.confirmOS = mnR < 30 && c > E10[k] && cl[k - 1] <= E10[k - 1];
  let s = 0, s2 = 0, mxH = -Infinity, mnL = Infinity; for (let j = k - 19; j <= k; j++) { s += cl[j]; s2 += cl[j] * cl[j]; mxH = Math.max(mxH, hi[j]); mnL = Math.min(mnL, lo[j]); }
  const m = s / 20, sd = Math.sqrt(Math.max(0, s2 / 20 - m * m)), bbL = m - 2 * sd, bbU = m + 2 * sd;
  f.bbLow = c <= bbL; f.bbHigh = c >= bbU;
  let pLo = Infinity, pR = 100; for (let j = k - 15; j <= k - 5; j++) { if (lo[j] < pLo) { pLo = lo[j]; pR = R[j] != null ? R[j] : 100; } }
  f.bbdcRev = lo[k] <= mnL * 1.002 && mnL < bbL && lo[k] < pLo && R[k] != null && R[k] > pR + 2;
  f.macdUp = H[k] > 0 && H[k - 1] <= 0; f.macdDn = H[k] < 0 && H[k - 1] >= 0;
  let va = 0, vn = 0; for (let j = k - 20; j < k; j++) if (v[j]) { va += v[j]; vn++; }
  const surge = vn > 10 && v[k] > 1.8 * va / vn;
  f.volUp = surge && c > cl[k - 1]; f.volDn = surge && c < cl[k - 1];
  let mx = -Infinity; for (let j = Math.max(0, k - 251); j < k; j++) mx = Math.max(mx, cl[j]);
  f.newHigh = c >= mx;
  f.nearHigh = c < mx && c >= mx * 0.97;
  const m12 = k >= 252 ? cl[k - 21] / cl[k - 252] - 1 : null, m1 = c / cl[k - 21] - 1;
  f.mom12 = m12 != null && m12 >= 0.3; f.momLose = m12 != null && m12 <= -0.2;
  f.rev1m = m1 <= -0.15; f.rev1mUp = m1 >= 0.2;
  f.golden = E50[k] > E200[k] && E50[k - 5] <= E200[k - 5]; f.death = E50[k] < E200[k] && E50[k - 5] >= E200[k - 5];
  let h20 = -Infinity, l20 = Infinity; for (let j = k - 20; j < k; j++) { h20 = Math.max(h20, hi[j]); l20 = Math.min(l20, lo[j]); }
  f.donUp = c > h20; f.donDn = c < l20;
  f.pullback = c > E200[k] && E50[k] > E200[k] && R[k] != null && R[k] < 45;
  let sr = 0, sr2 = 0; if (k >= 60) for (let j = k - 59; j <= k; j++) { const r = Math.log(cl[j] / cl[j - 1]); sr += r; sr2 += r * r; }
  f.lowVol = k >= 60 && Math.sqrt(Math.max(0, sr2 / 60 - (sr / 60) * (sr / 60))) * Math.sqrt(252) < 0.25;
  f.stretched = c > E200[k] * 1.4; f.deepBelow = c < E200[k] * 0.7;
  f.dn3 = c / cl[k - 3] - 1 <= -0.08;
  return f;
}

async function runCalibration(barsMap, spyDayClose, prev, newsLog) {
  const syms = Object.keys(barsMap).filter(s => barsMap[s] && barsMap[s].length >= 300 && !/-USD$|\.NS$|\.BO$|^\^/.test(s)).slice(0, MAX_SYMBOLS);
  const ev = {}; CAL_FEATS.forEach(([id]) => { ev[id] = { T: [], V: [] }; });
  let lastDay = 0; Object.values(spyDayClose.map).forEach(() => {}); lastDay = spyDayClose.last;
  const cutoff = lastDay - 120, valEnd = lastDay - 30, H20 = 20, COST = 0.001;
  const sdays = Object.keys(spyDayClose.map).map(Number).sort((a, b) => a - b), scl = sdays.map(d => spyDayClose.map[d]), SE = ema(scl, 200), REG = {}, regDays = {};
  for (let i = 200; i < sdays.length; i++) { let s = 0, s2 = 0; for (let j = i - 19; j <= i; j++) { const r = Math.log(scl[j] / scl[j - 1]); s += r; s2 += r * r; } const vol = Math.sqrt(Math.max(0, s2 / 20 - (s / 20) * (s / 20))) * Math.sqrt(252); const g = (scl[i] > SE[i] ? 'bull' : 'bear') + (vol > 0.2 ? 'Vol' : 'Calm'); REG[sdays[i]] = g; regDays[g] = (regDays[g] || 0) + 1; }
  const regAt = d => { for (let j = 0; j < 5; j++) if (REG[d - j]) return REG[d - j]; return null; };
  const evR = {}; CAL_REGS.forEach(g => { evR[g] = {}; CAL_FEATS.forEach(([id]) => { evR[g][id] = []; }); });
  for (let si = 0; si < syms.length; si++) {
    if (si % 8 === 0) await new Promise(r => setTimeout(r, 0));
    const b = barsMap[syms[si]], n = b.length, cl = b.map(x => x.c), hi = b.map(x => x.h != null ? x.h : x.c), lo = b.map(x => x.l != null ? x.l : x.c), v = b.map(x => x.v || 0);
    if (b.some(x => !isFinite(x.c) || x.c <= 0)) continue;
    const E10 = ema(cl, 10), E50 = ema(cl, 50), E200 = ema(cl, 200), R = rsi(cl, 14), H = macd(cl).hist, nextOk = {};
    for (let k = 220; k < n - H20; k++) {
      const d0 = dayKey(b[k].t), d1 = dayKey(b[k + H20].t); if (d0 == null || d1 == null || d1 > valEnd + 30) continue;
      const s0 = spyDayClose.at(d0), s1 = spyDayClose.at(d1); if (!s0 || !s1) continue;
      const f = calFeatsAt(cl, hi, lo, v, E10, E50, E200, R, H, k);
      const ex = (cl[k + H20] / cl[k] - 1) - (s1 / s0 - 1) - COST;
      for (const id in f) { if (!f[id]) continue; if (k < (nextOk[id] || 0)) continue; nextOk[id] = k + H20; (d0 <= cutoff ? ev[id].T : d0 <= valEnd ? ev[id].V : null)?.push(ex); const rg = regAt(d0); if (rg) evR[rg][id].push({ d: d0, ex }); }
    }
  }
  (newsLog || []).forEach(e => { if (e.ex == null) return; (e.d <= cutoff ? ev.news.T : ev.news.V).push(e.ex); const rg = regAt(e.d); if (rg) evR[rg].news.push({ d: e.d, ex: e.ex }); });
  const halfMeans = A => { const s = A.slice().sort((x, y) => x.d - y.d), h = s.length >> 1, m = z => z.reduce((t, x) => t + x.ex, 0) / Math.max(1, z.length); return [m(s.slice(0, h)), m(s.slice(h)), h, s.length - h]; };
  const stat = a => { const n = a.length; if (!n) return { n: 0, m: 0, hit: 0, sd: 0 }; const m = a.reduce((x, y) => x + y, 0) / n; let s = 0; a.forEach(x => { s += (x - m) * (x - m); }); return { n, m, hit: a.filter(x => x > 0).length / n, sd: Math.sqrt(s / Math.max(1, n - 1)) }; };
  const feats = {}, log = [];
  CAL_FEATS.forEach(([id, label]) => {
    const T = stat(ev[id].T), V = stat(ev[id].V);
    let pts = 0, status = 'active';
    if (T.n < 30) status = 'too few cases';
    else {
      const t = T.m / (T.sd / Math.sqrt(T.n) || 1);
      pts = Math.max(-3, Math.min(3, t)) * 2.5 * Math.min(1, T.n / 200);
      if (Math.abs(t) < 2) { pts = 0; status = 'no edge'; }
      else if (V.n >= 20 && Math.sign(V.m) !== Math.sign(T.m)) { pts = 0; status = 'failed recent test'; }
    }
    const old = prev && prev.feats && prev.feats[id] ? prev.feats[id].pts : 0;
    pts = old + Math.max(-2, Math.min(2, pts - old));
    pts = Math.round(pts * 10) / 10;
    if (Math.abs(pts - old) >= 1) log.push({ id, label, from: old, to: pts, why: status === 'active' ? 'training ' + (T.m * 100).toFixed(2) + '% vs SPY, recent ' + (V.n ? (V.m * 100).toFixed(2) + '%' : 'n/a') : status });
    feats[id] = { label, pts, status, nT: T.n, mT: T.m, hT: T.hit, nV: V.n, mV: V.m, hV: V.hit };
  });
  const byReg = {};
  CAL_REGS.forEach(g => { byReg[g] = {}; CAL_FEATS.forEach(([id]) => {
    const A = evR[g][id], S = stat(A.map(x => x.ex)); let pts = 0, status = 'active';
    if (S.n < 30) status = 'too few cases';
    else { const t = S.m / (S.sd / Math.sqrt(S.n) || 1); pts = Math.max(-3, Math.min(3, t)) * 2.5 * Math.min(1, S.n / 200); if (Math.abs(t) < 2) { pts = 0; status = 'no edge'; } else { const h = halfMeans(A); if (h[2] < 10 || h[3] < 10 || Math.sign(h[0]) !== Math.sign(S.m) || Math.sign(h[1]) !== Math.sign(S.m)) { pts = 0; status = 'inconsistent'; } } }
    const old = prev && prev.byReg && prev.byReg[g] && prev.byReg[g][id] ? prev.byReg[g][id].pts : null;
    if (old != null) pts = old + Math.max(-2, Math.min(2, pts - old));
    byReg[g][id] = { pts: Math.round(pts * 10) / 10, status, n: S.n, m: S.m, hit: S.hit };
  }); });
  const reg = sdays.length ? REG[sdays[sdays.length - 1]] : null;
  if (prev && prev.reg && reg && prev.reg !== reg) log.push({ id: 'regime', label: 'Market condition', from: 0, to: 0, why: CAL_REG_LBL[prev.reg] + ' → ' + CAL_REG_LBL[reg] });
  return { day: lastDay, at: Date.now(), stocks: syms.length, feats, log, byReg, reg, regDays };
}
// ---- end shared logic ----

async function getJSON(url, tries = 4) {
  for (let t = 0; t < tries; t++) {
    try {
      const r = await fetch(url, { headers: UA });
      if (r.status === 429) { await sleep(5000 * (t + 1)); continue; }
      if (!r.ok) throw new Error(r.status + ' ' + url);
      return await r.json();
    } catch (e) { if (t === tries - 1) throw e; await sleep(2000 * (t + 1)); }
  }
  return null;
}
async function getText(url) {
  try { const r = await fetch(url, { headers: UA }); return r.ok ? await r.text() : null; } catch { return null; }
}

// Yahoo chart endpoint: full OHLCV, one symbol per call. Tries query1, then query2.
async function yahooBars(sym, range = '2y') {
  for (const host of ['query1', 'query2']) {
    try {
      const j = await getJSON('https://' + host + '.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(sym) + '?range=' + range + '&interval=1d&includePrePost=false', 3);
      const R = j && j.chart && j.chart.result && j.chart.result[0]; if (!R || !R.timestamp) continue;
      const q = R.indicators.quote[0], out = [];
      R.timestamp.forEach((t, i) => { if (q.close[i] == null) return; out.push({ t: t * 1000, o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i], v: q.volume[i] || 0 }); });
      if (out.length) { out.name = R.meta && (R.meta.shortName || R.meta.longName) || sym; return out; }
    } catch { /* try next host */ }
  }
  return null;
}
// api.binance.com returns 451 (blocked) from US cloud runners; data-api.binance.vision serves the same public market data.
async function bget(path) {
  for (const h of ['https://data-api.binance.vision', 'https://api.binance.com']) { try { return await getJSON(h + path, 1); } catch { /* next host */ } }
  return null;
}
async function binanceBars(sym) {
  const k = await bget('/api/v3/klines?symbol=' + sym.replace('-USD', 'USDT') + '&interval=1d&limit=730');
  return Array.isArray(k) ? k.map(x => ({ t: x[0], o: +x[1], h: +x[2], l: +x[3], c: +x[4], v: +x[5] })) : null;
}

// ---------- dynamic universe ----------
const TICKER = /^[A-Z]{1,5}(-[A-Z])?$/;
function csvRows(t) {
  return t.split(/\r?\n/).filter(Boolean).map(line => { const o = []; let cur = '', q = false; for (const ch of line) { if (ch === '"') q = !q; else if (ch === ',' && !q) { o.push(cur); cur = ''; } else cur += ch; } o.push(cur); return o; });
}
async function sp500() {
  // Source 1: GitHub dataset (CSV). Source 2: Wikipedia's constituents table. Needs 400+ rows to count as valid.
  const t = await getText('https://raw.githubusercontent.com/datasets/s-and-p-500-constituents/main/data/constituents.csv');
  if (t) {
    const rows = csvRows(t), h = rows.shift() || [], iS = h.indexOf('Symbol'), iN = h.indexOf('Security'), iG = h.indexOf('GICS Sector');
    const out = iS < 0 ? [] : rows.map(r => ({ s: (r[iS] || '').trim().toUpperCase().replace(/\./g, '-'), n: r[iN] || '', sec: r[iG] || '' })).filter(x => TICKER.test(x.s));
    if (out.length >= 400) return out;
  }
  const w = await getText('https://en.wikipedia.org/api/rest_v1/page/html/List_of_S%26P_500_companies');
  if (w) {
    const strip = x => x.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&#\d+;|&[a-z]+;/g, ' ').trim();
    const out = [], re = /<tr[^>]*>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>/g; let m;
    while ((m = re.exec(w))) { const s = strip(m[1]).toUpperCase().replace(/\./g, '-'); if (TICKER.test(s)) out.push({ s, n: strip(m[2]), sec: strip(m[3]) }); }
    if (out.length >= 400) return out;
  }
  console.log('sp500: no source worked, using core list and movers only');
  return [];
}
async function movers() {
  const out = new Set();
  const add = a => (a || []).forEach(q => { const s = String(q.symbol || '').toUpperCase(); if (TICKER.test(s)) out.add(s); });
  try { const j = await getJSON('https://query1.finance.yahoo.com/v1/finance/trending/US?count=60', 2); add(j && j.finance && j.finance.result && j.finance.result[0] && j.finance.result[0].quotes); } catch { /* optional */ }
  for (const id of MOVER_SCREENS) {
    try { const j = await getJSON('https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?scrIds=' + id + '&count=50', 2); add(j && j.finance && j.finance.result && j.finance.result[0] && j.finance.result[0].quotes); } catch { /* optional */ }
    await sleep(300);
  }
  return [...out];
}
async function buildUniverse(prevU) {
  const today = new Date().toISOString().slice(0, 10), cutoff = Date.now() - MOVER_KEEP_DAYS * 864e5;
  const keep = ((prevU && prevU.symbols) || []).filter(x => x.src === 'mover' && Date.parse(x.seen) >= cutoff);
  const seen = new Map(keep.map(x => [x.s, x.seen]));
  const fresh = await movers(); fresh.forEach(s => seen.set(s, today));
  const base = new Set(BASE), spx = await sp500(), spxSet = new Set(spx.map(x => x.s));
  const moverList = [...seen.entries()].filter(([s]) => !base.has(s)).sort((a, b) => a[1] < b[1] ? 1 : -1).slice(0, MOVER_CAP);
  const list = [], have = new Set();
  const push = (s, src, extra) => { if (have.has(s) || list.length >= MAX_SYMBOLS) return; have.add(s); list.push(Object.assign({ s, src }, extra || {})); };
  BASE.forEach(s => push(s, 'core'));
  moverList.forEach(([s, d]) => push(s, 'mover', { seen: d }));
  spx.forEach(x => push(x.s, 'sp500', { n: x.n, sec: x.sec }));
  console.log('universe', list.length, '· core', BASE.length, '· movers', moverList.length, '· sp500', spxSet.size, '· fresh movers today', fresh.length);
  return list;
}

// ---------- India (NSE Nifty 500) ----------
// Closes only: the India screener builds its candles from closes. Best effort: a failure here never fails the US job.

// ---------- Canada (TSX): same file format as india.json so the app can score it with the same rules ----------
const CANADA = ('RY|Royal Bank of Canada|Financials;TD|Toronto-Dominion Bank|Financials;BNS|Bank of Nova Scotia|Financials;BMO|Bank of Montreal|Financials;CM|CIBC|Financials;NA|National Bank|Financials;MFC|Manulife|Financials;SLF|Sun Life|Financials;GWO|Great-West Lifeco|Financials;IFC|Intact Financial|Financials;POW|Power Corp|Financials;BN|Brookfield Corp|Financials;BAM|Brookfield Asset Mgmt|Financials;FFH|Fairfax Financial|Financials;EQB|EQB|Financials;X|TMX Group|Financials;IGM|IGM Financial|Financials;ONEX|Onex|Financials;'
 + 'CNQ|Canadian Natural Resources|Energy;SU|Suncor|Energy;CVE|Cenovus|Energy;IMO|Imperial Oil|Energy;TOU|Tourmaline Oil|Energy;ARX|ARC Resources|Energy;WCP|Whitecap Resources|Energy;MEG|MEG Energy|Energy;ENB|Enbridge|Energy;TRP|TC Energy|Energy;PPL|Pembina Pipeline|Energy;KEY|Keyera|Energy;GEI|Gibson Energy|Energy;CPG|Crescent Point|Energy;PEY|Peyto|Energy;'
 + 'ABX|Barrick Gold|Materials;AEM|Agnico Eagle|Materials;WPM|Wheaton Precious Metals|Materials;FNV|Franco-Nevada|Materials;K|Kinross Gold|Materials;AGI|Alamos Gold|Materials;LUG|Lundin Gold|Materials;EDV|Endeavour Mining|Materials;OGC|OceanaGold|Materials;PAAS|Pan American Silver|Materials;NGD|New Gold|Materials;FM|First Quantum|Materials;LUN|Lundin Mining|Materials;HBM|Hudbay Minerals|Materials;TECK-B|Teck Resources|Materials;NTR|Nutrien|Materials;CCO|Cameco|Materials;NXE|NexGen Energy|Materials;IVN|Ivanhoe Mines|Materials;WFG|West Fraser|Materials;CFP|Canfor|Materials;'
 + 'CP|Canadian Pacific Kansas City|Industrials;CNR|Canadian National Railway|Industrials;TFII|TFI International|Industrials;WSP|WSP Global|Industrials;STN|Stantec|Industrials;WCN|Waste Connections|Industrials;GFL|GFL Environmental|Industrials;CAE|CAE|Industrials;AC|Air Canada|Industrials;BBD-B|Bombardier|Industrials;TIH|Toromont|Industrials;FTT|Finning|Industrials;ARE|Aecon|Industrials;CIGI|Colliers|Real Estate;FSV|FirstService|Real Estate;'
 + 'SHOP|Shopify|Technology;CSU|Constellation Software|Technology;GIB-A|CGI|Technology;OTEX|OpenText|Technology;DSG|Descartes|Technology;LSPD|Lightspeed|Technology;KXS|Kinaxis|Technology;CLS|Celestica|Technology;BB|BlackBerry|Technology;'
 + 'FTS|Fortis|Utilities;EMA|Emera|Utilities;H|Hydro One|Utilities;CU|Canadian Utilities|Utilities;AQN|Algonquin Power|Utilities;NPI|Northland Power|Utilities;ALA|AltaGas|Utilities;BLX|Boralex|Utilities;'
 + 'BCE|BCE|Telecom;T|Telus|Telecom;RCI-B|Rogers Communications|Telecom;QBR-B|Quebecor|Telecom;TRI|Thomson Reuters|Industrials;'
 + 'ATD|Alimentation Couche-Tard|Consumer;L|Loblaw|Consumer;MRU|Metro|Consumer;EMP-A|Empire Co|Consumer;DOL|Dollarama|Consumer;QSR|Restaurant Brands|Consumer;GIL|Gildan|Consumer;CTC-A|Canadian Tire|Consumer;MG|Magna|Consumer;PBH|Premium Brands|Consumer;SAP|Saputo|Consumer;WN|George Weston|Consumer;ATZ|Aritzia|Consumer;PKI|Parkland|Energy;'
 + 'CAR-UN|CT REIT Canadian Apartment|Real Estate;REI-UN|RioCan REIT|Real Estate;GRT-UN|Granite REIT|Real Estate;CHP-UN|Choice Properties|Real Estate;AP-UN|Allied Properties|Real Estate;SRU-UN|SmartCentres|Real Estate;'
 + 'WELL|WELL Health|Health;JWEL|Jamieson Wellness|Health;DOO|BRP|Consumer;WTE|Westshore Terminals|Industrials;MDA|MDA Space|Industrials;DIR-UN|Dream Industrial|Real Estate').split(';').map(x => { const [tk, n, sec] = x.split('|'); return { s: tk + '.TO', tk, n, sec }; });
async function canadaStage(now) {
  const list = CANADA, bars = {}, wts = {}, t0 = Date.now(); let next = 0;
  async function worker() {
    while (next < list.length) {
      if (Date.now() - t0 > 6 * 60 * 1000) return;
      const u = list[next++];
      try { const b = await yahooBars(u.s); if (b && b.length >= 60) { bars[u.s] = { t: b.map(x => Math.round(x.t / 1000)), c: b.map(x => Math.round(x.c * 1000) / 1000) }; wts[u.s] = Math.round(b.slice(-20).reduce((a, x) => a + x.c * (x.v || 0), 0) / 20); } } catch { /* skip symbol */ }
      await sleep(250);
    }
  }
  await Promise.all([worker(), worker(), worker()]);
  const ix = await yahooBars('^GSPTSE'); if (ix && ix.length >= 60) bars['^GSPTSE'] = { t: ix.map(x => Math.round(x.t / 1000)), c: ix.map(x => Math.round(x.c * 100) / 100) };
  const symbols = list.filter(u => bars[u.s]).map(u => Object.assign({}, u, { w: wts[u.s] || 0 }));
  console.log('canada', symbols.length, 'of', list.length, 'stocks downloaded' + (bars['^GSPTSE'] ? ' · TSX index ok' : ' · TSX index missing'));
  if (symbols.length < 40) { console.log('canada: too few stocks downloaded, keeping the previous canada.json'); return; }
  await writeFile(new URL('canada.json', OUT), JSON.stringify({ updated: now, symbols, bars }));
}
async function indiaStage(now) {
  let t = null;
  for (const u of ['https://archives.nseindia.com/content/indices/ind_nifty500list.csv', 'https://www.niftyindices.com/IndexConstituent/ind_nifty500list.csv']) {
    t = await getText(u); if (t && t.includes('Symbol')) break; t = null;
  }
  if (!t) { console.log('india: Nifty 500 list unavailable, skipping'); return; }
  const rows = csvRows(t.replace(/^﻿/, '')), h = (rows.shift() || []).map(x => x.trim()), iN = h.indexOf('Company Name'), iI = h.indexOf('Industry'), iS = h.indexOf('Symbol');
  if (iS < 0) { console.log('india: unexpected CSV header, skipping'); return; }
  const list = rows.map(r => { const tk = (r[iS] || '').trim().toUpperCase(); return { s: tk + '.NS', tk, n: (r[iN] || '').trim(), sec: (r[iI] || '').trim() }; }).filter(x => x.tk);
  const bars = {}, wts = {}, t0 = Date.now(); let next = 0;
  async function worker() {
    while (next < list.length) {
      if (Date.now() - t0 > INDIA_BUDGET_MS) return;
      const u = list[next++];
      try { const b = await yahooBars(u.s); if (b && b.length >= 60) { bars[u.s] = { t: b.map(x => Math.round(x.t / 1000)), c: b.map(x => Math.round(x.c * 1000) / 1000) }; wts[u.s] = Math.round(b.slice(-20).reduce((a, x) => a + x.c * (x.v || 0), 0) / 20); } } catch { /* skip symbol */ }
      await sleep(250);
    }
  }
  await Promise.all([worker(), worker(), worker()]);
  const symbols = list.filter(u => bars[u.s]).map(u => Object.assign({}, u, { w: wts[u.s] || 0 }));
  console.log('india', symbols.length, 'of', list.length, 'stocks downloaded');
  if (symbols.length < 100) { console.log('india: too few stocks downloaded, keeping the previous india.json'); return; }
  await writeFile(new URL('india.json', OUT), JSON.stringify({ updated: now, symbols, bars }));
}

// ---------- Earnings (Nasdaq calendar) ----------
// One call per day returns every company that reported (EPS, consensus, % surprise) or will report (consensus, timing).
// We keep the last 6 reports per universe stock, plus the reporters for the next 10 days. Best effort: never fails the job.
const EARN_BACKFILL_DAYS = 400, EARN_PER_RUN = 140;
const NQ_HEADERS = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36', Accept: 'application/json, text/plain, */*', Origin: 'https://www.nasdaq.com', Referer: 'https://www.nasdaq.com/' };
const nq = v => { if (v == null) return null; const s = String(v).trim(); if (!s || /^n\/?a$/i.test(s)) return null; const neg = /^\(.*\)$/.test(s) || s.startsWith('-'); const n = parseFloat(s.replace(/[^0-9.]/g, '')); return isFinite(n) ? (neg ? -n : n) : null; };
async function nasdaqDay(date) {
  for (let t = 0; t < 3; t++) {
    try {
      const r = await fetch('https://api.nasdaq.com/api/calendar/earnings?date=' + date, { headers: NQ_HEADERS, signal: AbortSignal.timeout(20000) });
      if (r.status === 429) { await sleep(4000 * (t + 1)); continue; }
      if (!r.ok) throw new Error(r.status);
      const j = await r.json(), rows = j && j.data && j.data.rows;
      return Array.isArray(rows) ? rows : [];
    } catch { await sleep(1500 * (t + 1)); }
  }
  return null;
}
async function earningsStage(now, symSet) {
  let E = {}; try { E = JSON.parse(await readFile(new URL('earnings.json', OUT), 'utf8')); } catch { /* first run */ }
  const q = E.q || {}, up = {}, done = E.done || {};
  const ymd = d => d.toISOString().slice(0, 10);
  const etToday = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(new Date());
  const base = new Date(etToday + 'T12:00:00Z'), day = n => ymd(new Date(base.getTime() + n * 864e5)), wk = s => { const w = new Date(s + 'T12:00:00Z').getUTCDay(); return w !== 0 && w !== 6; };
  const tm = x => /pre/.test(x || '') ? 'pre' : /after/.test(x || '') ? 'post' : null;
  const oldUp = E.up || {};
  // 1) upcoming: today .. +10 days
  let fails = 0;
  for (let n = 0; n <= 10; n++) {
    const d = day(n); if (!wk(d)) continue;
    const rows = await nasdaqDay(d); await sleep(400);
    if (!rows) { if (++fails >= 3) break; continue; }
    rows.forEach(r => { if (!symSet.has(r.symbol)) return; (up[r.symbol] = up[r.symbol] || []).push({ d, t: tm(r.time), est: nq(r.epsForecast), n: nq(r.noOfEsts), fq: r.fiscalQuarterEnding || null }); });
  }
  if (fails >= 3) { console.log('earnings: Nasdaq not reachable, skipping'); return; }
  // 2) past reports: last 3 days always re-read (EPS can post late), older days once.
  const need = [];
  for (let n = -1; n >= -EARN_BACKFILL_DAYS; n--) { const d = day(n); if (wk(d) && (n >= -3 || !done[d])) need.push(d); }
  let got = 0;
  for (const d of need.slice(0, EARN_PER_RUN)) {
    const rows = await nasdaqDay(d); await sleep(400);
    if (!rows) { if (++fails >= 6) break; continue; }
    rows.forEach(r => {
      if (!symSet.has(r.symbol)) return;
      const eps = nq(r.eps); if (eps == null) return;
      const prevT = ((oldUp[r.symbol] || []).find(u => u.d === d) || {}).t || null;
      const rec = { d, fq: r.fiscalQuarterEnding || null, eps, est: nq(r.epsForecast), sur: nq(r.surprise), t: tm(r.time) || prevT };
      const a = q[r.symbol] = (q[r.symbol] || []).filter(x => x.d !== d); a.push(rec); a.sort((x, y) => y.d.localeCompare(x.d)); q[r.symbol] = a.slice(0, 6);
    });
    if (d < day(-3)) done[d] = 1; got++;
  }
  // remember timing of upcoming reports so the pre/after-hours flag survives once Nasdaq drops it
  const keepUp = {}; Object.keys(up).forEach(s => keepUp[s] = up[s]);
  Object.keys(oldUp).forEach(s => { const old = oldUp[s].filter(u => u.d >= day(-3) && u.d < day(0)); if (old.length) keepUp[s] = (keepUp[s] || []).concat(old); });
  const left = need.length - Math.min(need.length, EARN_PER_RUN);
  console.log('earnings:', Object.keys(q).length, 'stocks with history ·', Object.keys(up).length, 'reporting in next 10 days · read', got, 'past days ·', left, 'days still to back-fill');
  await writeFile(new URL('earnings.json', OUT), JSON.stringify({ updated: now, asOf: etToday, done, q, up: keepUp }));
}

// ---------- NASDAQ + NYSE screener ----------
// Every liquid common stock listed on NASDAQ or NYSE (price >= $5, volume >= 300K, market cap >= $300M, best EXCH_MAX by size).
// Signals are computed here with the same rules as the Telegram bot and published as one compact file, so the app does no heavy work.
const EXCH_MAX = 2500, EXCH_BUDGET_MS = 16 * 60 * 1000;
function regPts(cal, id) { if (!cal || !cal.feats || !cal.feats[id]) return 0; const R = cal.byReg && cal.reg ? cal.byReg[cal.reg][id] : null; if (R && R.n >= 30) return R.status === 'active' ? R.pts : 0; return cal.feats[id].pts * 0.5; }
let RANKS = null; // set by rankStage: { rows, coins }
function peerGate(a, rk, rsiV, ret1m) {
  if (a === 'BUY' && (rsiV < 30 || ret1m <= -0.15)) return 'HOLD';
  if (a === 'BUY' && rk && rk.ok && rk.pct != null && rk.pct < 50) return 'HOLD';
  if (a === 'SELL' && rk && rk.ok && rk.pct != null && rk.pct > 50) return 'HOLD';
  return a;
}
function signalOf(b, cal, sym) {
  if (!b || b.length < 220) return null;
  const cl = b.map(x => x.c), hi = b.map(x => x.h != null ? x.h : x.c), lo = b.map(x => x.l != null ? x.l : x.c), v = b.map(x => x.v || 0);
  const k = cl.length - 1, p = cl[k], E10 = ema(cl, 10), E50 = ema(cl, 50), E200 = ema(cl, 200), R = rsi(cl, 14), H = macd(cl).hist;
  const f = calFeatsAt(cl, hi, lo, v, E10, E50, E200, R, H, k);
  let s = (p > E200[k] ? 1.5 : -1.5) + (E50[k] > E200[k] ? 1 : -1) + (R[k] < 30 ? 1 : R[k] > 70 ? -1 : 0) + (H[k] > 0 ? 0.5 : -0.5);
  for (const id in f) { if (f[id]) s += regPts(cal, id); }
  const lo52 = Math.min(...lo.slice(-252)), down = p < E200[k] && E50[k] < E200[k];
  let a = s >= 3 ? 'BUY' : s <= -3 ? 'SELL' : 'HOLD';
  if (a === 'BUY' && down && p < E50[k]) a = 'HOLD';
  if (a === 'SELL' && R[k] < 32 && p < lo52 * 1.06) a = 'HOLD';
  a = peerGate(a, RANKS && RANKS.rows ? RANKS.rows[sym] : null, R[k], p / cl[k - 21] - 1);
  const trend = p > E10[k] && E10[k] > E50[k] && E50[k] > E200[k] ? 'Strong up' : p > E50[k] && E50[k] > E200[k] ? 'Up' : p < E10[k] && E10[k] < E50[k] && E50[k] < E200[k] ? 'Strong down' : p < E50[k] && E50[k] < E200[k] ? 'Down' : 'Mixed';
  return { a, s: Math.round(s * 10) / 10, r: Math.round(R[k]), trend };
}
const nnum = v => { const n = parseFloat(String(v == null ? '' : v).replace(/[$,%\s]/g, '')); return isFinite(n) ? n : null; };
async function nasdaqScreener(ex) {
  for (let t = 0; t < 3; t++) {
    try {
      const r = await fetch('https://api.nasdaq.com/api/screener/stocks?tableonly=true&limit=10000&download=true&exchange=' + ex, { headers: NQ_HEADERS, signal: AbortSignal.timeout(30000) });
      if (!r.ok) throw new Error(r.status);
      const d = (await r.json()).data, rows = d && (d.rows || (d.table && d.table.rows));
      if (Array.isArray(rows) && rows.length) return rows;
      console.log('exchange: unexpected format for', ex, 'keys:', d ? Object.keys(d).join(',') : 'none');
    } catch { await sleep(2000 * (t + 1)); }
  }
  return null;
}
async function exchangeStage(now, cal) {
  const list = [];
  for (const [ex, tag] of [['nasdaq', 'Q'], ['nyse', 'N']]) {
    const rows = await nasdaqScreener(ex);
    if (!rows) { console.log('exchange: could not read the', ex, 'list, skipping'); return; }
    rows.forEach(r => { const s = String(r.symbol || '').trim().toUpperCase(), p = nnum(r.lastsale), v = nnum(r.volume), c = nnum(r.marketCap); if (/^[A-Z]{1,5}$/.test(s) && p >= 5 && v >= 3e5 && c >= 3e8) list.push({ s, x: tag, n: r.name || s, sec: r.sector || '', cap: c }); });
  }
  const seen = new Set(), uni = list.sort((a, b) => b.cap - a.cap).filter(u => !seen.has(u.s) && seen.add(u.s)).slice(0, EXCH_MAX);
  const rows = [], t0 = Date.now(); let next = 0;
  async function worker() {
    while (next < uni.length) {
      if (Date.now() - t0 > EXCH_BUDGET_MS) return;
      const u = uni[next++];
      try {
        const b = await yahooBars(u.s), g = b && signalOf(b, cal, u.s);
        if (g) {
          const n = b.length, cl = b.map(x => x.c), p = cl[n - 1], tail = cl.slice(-252), hi = Math.max(...tail), lo = Math.min(...tail);
          const dv = b.slice(-50).reduce((a, x) => a + x.c * x.v, 0) / 50;
          if (dv >= 3e6) rows.push({ s: u.s, n: u.n, x: u.x, sec: u.sec, cap: u.cap, p: Math.round(p * 100) / 100, ch: Math.round((p / cl[n - 2] - 1) * 1e4) / 100, vol: b[n - 1].v, a: g.a, sc: g.s, r: g.r, tr: g.trend, hi: p >= hi * 0.995 ? 1 : 0 });
        }
      } catch { /* skip symbol */ }
      await sleep(200);
    }
  }
  await Promise.all([worker(), worker(), worker(), worker()]);
  console.log('exchange:', rows.length, 'stocks scored of', uni.length, 'candidates');
  if (rows.length < 300) { console.log('exchange: too few stocks scored, keeping the previous file'); return; }
  await writeFile(new URL('exchange.json', OUT), JSON.stringify({ updated: now, rows }));
}


// ---------- intraday edge test (15-min and 4-hour) ----------
async function yahooIntra(sym, interval, range) {
  for (const host of ['query1', 'query2']) {
    try {
      const j = await getJSON('https://' + host + '.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(sym) + '?range=' + range + '&interval=' + interval + '&includePrePost=false', 2);
      const R = j && j.chart && j.chart.result && j.chart.result[0]; if (!R || !R.timestamp) continue;
      const q = R.indicators.quote[0], out = [];
      R.timestamp.forEach((t, i) => { if (q.close[i] == null || q.high[i] == null || q.low[i] == null) return; out.push({ t: t * 1000, h: q.high[i], l: q.low[i], c: q.close[i], v: q.volume[i] || 0 }); });
      if (out.length) return out;
    } catch { /* next host */ }
  }
  return null;
}
async function binanceIntra(sym, interval) {
  const k = await bget('/api/v3/klines?symbol=' + sym.replace('-USD', 'USDT') + '&interval=' + interval + '&limit=1000');
  return Array.isArray(k) ? k.map(x => ({ t: x[0], h: +x[2], l: +x[3], c: +x[4], v: +x[5] })) : null;
}
function to4h(b) { const o = []; for (let i = 0; i + 3 < b.length; i += 4) { const g = b.slice(i, i + 4); o.push({ t: g[3].t, h: Math.max(...g.map(x => x.h)), l: Math.min(...g.map(x => x.l)), c: g[3].c, v: g.reduce((a, x) => a + x.v, 0) }); } return o; }
function intradayEdge(series, H) {
  // series: array of bar arrays. Excess return = forward H-bar return minus that symbol's average forward return.
  const ev = {}; CAL_FEATS.forEach(([id]) => { ev[id] = []; });
  for (const b of series) {
    const n = b.length; if (n < 400) continue;
    const cl = b.map(x => x.c), hi = b.map(x => x.h), lo = b.map(x => x.l), v = b.map(x => x.v);
    if (cl.some(x => !isFinite(x) || x <= 0)) continue;
    const E10 = ema(cl, 10), E50 = ema(cl, 50), E200 = ema(cl, 200), R = rsi(cl, 14), Hh = macd(cl).hist, nextOk = {};
    let tot = 0, cnt = 0; for (let k = 260; k < n - H; k++) { tot += cl[k + H] / cl[k] - 1; cnt++; }
    if (!cnt) continue; const base = tot / cnt;
    for (let k = 260; k < n - H; k++) {
      const f = calFeatsAt(cl, hi, lo, v, E10, E50, E200, R, Hh, k), ex = (cl[k + H] / cl[k] - 1 - base) * 100;
      for (const id in f) { if (!f[id] || k < (nextOk[id] || 0)) continue; nextOk[id] = k + H; ev[id].push({ d: b[k].t, ex }); }
    }
  }
  const out = {};
  for (const id in ev) {
    const A = ev[id].sort((x, y) => x.d - y.d), n = A.length;
    if (n < 40) { out[id] = { n, status: 'too few cases', m: 0, t: 0, hit: 0 }; continue; }
    const xs = A.map(x => x.ex), m = xs.reduce((a, x) => a + x, 0) / n, sd = Math.sqrt(xs.reduce((a, x) => a + (x - m) * (x - m), 0) / Math.max(1, n - 1)) || 1e-9, t = m / (sd / Math.sqrt(n));
    const h = n >> 1, m1 = xs.slice(0, h).reduce((a, x) => a + x, 0) / h, m2 = xs.slice(h).reduce((a, x) => a + x, 0) / (n - h);
    const ok = Math.abs(t) >= 2 && Math.sign(m1) === Math.sign(m) && Math.sign(m2) === Math.sign(m);
    out[id] = { n, m: +m.toFixed(3), t: +t.toFixed(2), hit: Math.round(xs.filter(x => x > 0).length / n * 100), status: ok ? 'edge' : Math.abs(t) >= 2 ? 'inconsistent' : 'no edge', dir: ok ? (m > 0 ? 1 : -1) : 0 };
  }
  return out;
}
async function intradayStage(now, bars) {
  const t0 = Date.now(), BUDGET = 8 * 60e3;
  const liq = Object.keys(bars).filter(s => !/-USD$|\.NS$|\.BO$|^\^/.test(s)).map(s => { const b = bars[s].slice(-20); return [s, b.reduce((a, x) => a + x.c * (x.v || 0), 0)]; }).sort((a, b) => b[1] - a[1]).slice(0, 120).map(x => x[0]);
  const list = liq.map(s => ({ s, cry: false })).concat(['BTC-USD', 'ETH-USD', 'SOL-USD', 'BNB-USD', 'XRP-USD'].map(s => ({ s, cry: true })));
  const s15 = [], s4 = []; let next = 0, ok = 0;
  async function worker() {
    while (next < list.length) {
      if (Date.now() - t0 > BUDGET) return;
      const u = list[next++];
      try {
        const a = u.cry ? await binanceIntra(u.s, '15m') : await yahooIntra(u.s, '15m', '60d');
        const h = u.cry ? await binanceIntra(u.s, '1h') : await yahooIntra(u.s, '1h', '730d');
        if (a) s15.push(a); if (h) s4.push(to4h(h)); if (a || h) ok++;
      } catch { /* skip */ }
      await sleep(200);
    }
  }
  await Promise.all([worker(), worker(), worker()]);
  const res = { updated: now, symbols: ok, iv: { '15m': { H: 26, feats: intradayEdge(s15, 26) }, '4h': { H: 30, feats: intradayEdge(s4, 30) } } };
  await writeFile(new URL('intraday.json', OUT), JSON.stringify(res));
  const cnt = iv => Object.values(res.iv[iv].feats).filter(f => f.status === 'edge').length;
  console.log('intraday: ' + ok + ' symbols · 15m edges ' + cnt('15m') + ' · 4h edges ' + cnt('4h') + ' of ' + CAL_FEATS.length);
}

// ---------- peer-rank study: which signals rank winners within similar stocks, and today's peer ranks ----------
const RK_TREND = ['mom6_1', 'mom12_1', 'trend200', 'near52h'], RK_REV = ['rev1m', 'rsiLo'];
function rkRank(a) { const n = a.length, ix = a.map((v, i) => [v, i]).sort((x, y) => x[0] - y[0]), r = new Array(n); let i = 0; while (i < n) { let j = i; while (j + 1 < n && ix[j + 1][0] === ix[i][0]) j++; const m = (i + j) / 2; for (let k = i; k <= j; k++) r[ix[k][1]] = m; i = j + 1; } return r; }
function rkSpearman(x, y) { const a = rkRank(x), b = rkRank(y), n = a.length; let ma = 0, mb = 0; for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; } ma /= n; mb /= n; let sa = 0, sb = 0, sab = 0; for (let i = 0; i < n; i++) { sa += (a[i] - ma) ** 2; sb += (b[i] - mb) ** 2; sab += (a[i] - ma) * (b[i] - mb); } return sa && sb ? sab / Math.sqrt(sa * sb) : null; }
function rkFactors(b) {
  const n = b.length, cl = b.map(x => x.c), E200 = ema(cl, 200), R = rsi(cl, 14), F = { mom6_1: [], mom12_1: [], trend200: [], near52h: [], rev1m: [], rsiLo: [], vol60: [] };
  for (let i = 0; i < n; i++) {
    F.mom6_1.push(i >= 126 ? cl[i - 21] / cl[i - 126] - 1 : NaN);
    F.mom12_1.push(i >= 252 ? cl[i - 21] / cl[i - 252] - 1 : NaN);
    F.trend200.push(i >= 200 ? cl[i] / E200[i] - 1 : NaN);
    let mx = -Infinity; if (i >= 251) for (let j = i - 251; j <= i; j++) mx = Math.max(mx, cl[j]); F.near52h.push(i >= 251 ? cl[i] / mx : NaN);
    F.rev1m.push(i >= 21 ? -(cl[i] / cl[i - 21] - 1) : NaN);
    F.rsiLo.push(R[i] == null ? NaN : -R[i]);
    let s1 = 0, s2 = 0; if (i >= 60) for (let j = i - 59; j <= i; j++) { const r = Math.log(cl[j] / cl[j - 1]); s1 += r; s2 += r * r; }
    F.vol60.push(i >= 60 ? Math.sqrt(Math.max(0, s2 / 60 - (s1 / 60) ** 2)) * Math.sqrt(252) : NaN);
  }
  return { F, cl, dk: b.map(x => dayKey(x.t)), R };
}
// S: {sym: bars}, bench: bars. grouped=true splits by volatility tercile each date; false = one group ("coin").
function rankStudy(S, bench, grouped, H = 20) {
  const P = {}; for (const s in S) { const b = S[s]; if (!b || b.length < 300 || b.some(x => !isFinite(x.c) || x.c <= 0)) continue; const r = rkFactors(b), m = {}; r.dk.forEach((d, i) => { if (d != null) m[d] = i; }); P[s] = Object.assign(r, { m }); }
  const bd = bench.map(x => dayKey(x.t)), bc = {}; bench.forEach((x, i) => { if (bd[i] != null) bc[bd[i]] = x.c; });
  const names = Object.keys(P), ALL = RK_TREND.concat(RK_REV), gn = grouped ? ['low', 'mid', 'high'] : ['coin'];
  const IC = {}; gn.forEach(g => { IC[g] = {}; ALL.forEach(f => { IC[g][f] = []; }); });
  for (let bi = 280; bi + H < bd.length; bi += H) {
    const d0 = bd[bi], d1 = bd[bi + H], b0 = bc[d0], b1 = bc[d1]; if (!b0 || !b1) continue;
    const rows = []; for (const s of names) { const p = P[s], j = p.m[d0], j1 = p.m[d1]; if (j == null || j1 == null) continue; const v = p.F.vol60[j]; if (!isFinite(v)) continue; rows.push({ p, j, v, ex: p.cl[j1] / p.cl[j] - 1 - (b1 / b0 - 1) }); }
    if (rows.length < 30) continue;
    const cuts = grouped ? rows.map(r => r.v).sort((a, b) => a - b) : null, q1 = cuts && cuts[Math.floor(cuts.length / 3)], q2 = cuts && cuts[Math.floor(cuts.length * 2 / 3)];
    for (const g of gn) {
      const m = rows.filter(r => !grouped || (g === 'low' ? r.v <= q1 : g === 'mid' ? r.v > q1 && r.v <= q2 : r.v > q2)); if (m.length < 12) continue;
      for (const f of ALL) { const mm = m.filter(r => isFinite(r.p.F[f][r.j])); if (mm.length < 12) continue; const ic = rkSpearman(mm.map(r => r.p.F[f][r.j]), mm.map(r => r.ex)); if (ic != null) IC[g][f].push(ic); }
    }
  }
  const out = {};
  for (const g of gn) { out[g] = { trend: {}, rev: {} }; for (const f of ALL) {
    const a = IC[g][f], n = a.length, kind = RK_TREND.includes(f) ? 'trend' : 'rev';
    if (n < 8) { out[g][kind][f] = { n, status: 'too few', sign: 0 }; continue; }
    const mean = x => x.reduce((t, v) => t + v, 0) / x.length, m = mean(a), sd = Math.sqrt(a.reduce((t, v) => t + (v - m) ** 2, 0) / (n - 1)) || 1e-9, t = m / (sd / Math.sqrt(n));
    const h1 = mean(a.slice(0, n >> 1)), h2 = mean(a.slice(n >> 1)), ok = Math.abs(m) >= 0.03 && Math.abs(t) >= 1.5 && Math.sign(h1) === Math.sign(m) && Math.sign(h2) === Math.sign(m);
    out[g][kind][f] = { n, ic: +m.toFixed(3), t: +t.toFixed(2), h1: +h1.toFixed(3), h2: +h2.toFixed(3), status: ok ? 'edge' : Math.abs(t) >= 1.5 ? 'inconsistent' : 'no edge', sign: ok ? Math.sign(m) : 0 };
  } }
  return { groups: out, nSyms: names.length };
}
// Today's peer rank for every symbol in B (bars). stats = rankStudy().groups
function rankNow(B, stats, grouped) {
  const R = {}; for (const s in B) { const b = B[s]; if (!b || b.length < 280 || b.some(x => !isFinite(x.c) || x.c <= 0)) continue; const r = rkFactors(b), i = b.length - 1; if (!isFinite(r.F.vol60[i])) continue; R[s] = { F: r.F, i, R: r.R[i], ret1m: r.cl[i] / r.cl[i - 21] - 1 }; }
  const names = Object.keys(R), vs = names.map(s => R[s].F.vol60[R[s].i]).sort((a, b) => a - b), q1 = vs[Math.floor(vs.length / 3)], q2 = vs[Math.floor(vs.length * 2 / 3)];
  const grp = {}; names.forEach(s => { const v = R[s].F.vol60[R[s].i]; const g = !grouped ? 'coin' : v <= q1 ? 'low' : v <= q2 ? 'mid' : 'high'; (grp[g] = grp[g] || []).push(s); });
  const pctOf = (vals) => { const rk = rkRank(vals), n = vals.length; return rk.map(x => n > 1 ? x / (n - 1) * 100 : 50); };
  const rows = {};
  for (const g in grp) {
    const M = grp[g], used = RK_TREND.filter(f => stats[g] && stats[g].trend[f] && stats[g].trend[f].sign !== 0);
    const comp = new Array(M.length).fill(0), pf = {}; used.forEach(f => { const p = pctOf(M.map(s => R[s].F[f][R[s].i])); pf[f] = p; const sg = stats[g].trend[f].sign; p.forEach((v, k) => { comp[k] += (sg > 0 ? v : 100 - v) / used.length; }); });
    const cp = used.length ? pctOf(comp) : null;
    M.forEach((s, k) => { rows[s] = { g, ok: used.length > 0, pct: cp ? Math.round(cp[k]) : null, nf: used.length, oversold: (R[s].R != null && R[s].R < 30) || R[s].ret1m <= -0.15 }; });
  }
  return rows;
}
async function rankStage(now, bars) {
  const t0 = Date.now(), BUDGET = 12 * 60e3;
  const liq = Object.keys(bars).filter(s => !/-USD$|\.NS$|\.BO$|^\^|^(SPY|QQQ|IWM)$/.test(s)).map(s => { const b = bars[s].slice(-20); return [s, b.reduce((a, x) => a + x.c * (x.v || 0), 0)]; }).sort((a, b) => b[1] - a[1]).slice(0, 300).map(x => x[0]);
  const long = {}; let next = 0;
  const spy = await yahooBars('SPY', '10y'); if (!spy) throw new Error('SPY 10y missing');
  async function worker() { while (next < liq.length) { if (Date.now() - t0 > BUDGET) return; const s = liq[next++]; try { const b = await yahooBars(s, '10y'); if (b && b.length > 400) long[s] = b; } catch { /* skip */ } await sleep(200); } }
  await Promise.all([worker(), worker(), worker()]);
  const stStats = rankStudy(long, spy, true);
  const rows = rankNow(bars_ex(bars), stStats.groups, true);
  // crypto: top coins by 24h volume on Binance
  let coins = {}, cStats = null, cRows = {};
  try {
    const tk = await bget('/api/v3/ticker/24hr');
    if (!Array.isArray(tk) || !tk.length) {
      for (const c of ['BTC', 'ETH', 'BNB', 'XRP', 'SOL', 'DOGE', 'ADA', 'TRX', 'AVAX', 'LINK', 'DOT', 'LTC', 'BCH', 'XLM', 'ATOM', 'UNI', 'ETC', 'NEAR', 'AAVE', 'FIL']) { const b = await yahooBars(c + '-USD', '5y'); if (b && b.length > 400) coins[c] = b; await sleep(250); }
      if (coins.BTC) { cStats = rankStudy(coins, coins.BTC, false); cRows = rankNow(coins, cStats.groups, false); }
    }
    const top = (Array.isArray(tk) && tk.length ? tk : []).filter(x => /USDT$/.test(x.symbol) && !/(UP|DOWN|BULL|BEAR)USDT$/.test(x.symbol) && !/^(USDC|FDUSD|TUSD|BUSD|USDP|DAI|EUR|AEUR|USD1)/.test(x.symbol)).sort((a, b) => +b.quoteVolume - +a.quoteVolume).slice(0, 55).map(x => x.symbol);
    if (top.length) for (const sy of top) { const k = await bget('/api/v3/klines?symbol=' + sy + '&interval=1d&limit=1000'); if (Array.isArray(k) && k.length > 400) coins[sy.slice(0, -4)] = k.map(x => ({ t: +x[0], o: +x[1], h: +x[2], l: +x[3], c: +x[4], v: +x[5] })); await sleep(120); }
    if (top.length && coins.BTC) { cStats = rankStudy(coins, coins.BTC, false); cRows = rankNow(coins, cStats.groups, false); }
  } catch (e) { console.log('rank crypto failed:', e && e.message); }
  const res = { updated: now, study: { stocks: stStats.nSyms, coins: cStats ? cStats.nSyms : 0 }, groups: Object.assign({}, stStats.groups, cStats ? cStats.groups : {}), rows, coins: cRows };
  RANKS = res;
  await writeFile(new URL('ranks.json', OUT), JSON.stringify(res));
  const ed = Object.entries(res.groups).map(([g, v]) => g + ':' + Object.values(v.trend).filter(x => x.sign).length + '/' + RK_TREND.length).join(' ');
  for (const g in res.groups) console.log('  ranks ' + g + ': ' + RK_TREND.concat(RK_REV).map(f => { const x = res.groups[g][RK_TREND.includes(f) ? 'trend' : 'rev'][f]; return f + ' ' + (x.ic != null ? x.ic + ' t' + x.t + ' ' : '') + x.status; }).join(' | '));
  console.log('ranks: study ' + res.study.stocks + ' stocks, ' + res.study.coins + ' coins · confirmed trend signals ' + ed + ' · ranked ' + Object.keys(rows).length + ' stocks, ' + Object.keys(cRows).length + ' coins');
}
function bars_ex(bars) { const o = {}; for (const s in bars) if (!/-USD$|\.NS$|\.BO$|^\^/.test(s)) o[s] = bars[s]; return o; }
async function main() {
  await mkdir(OUT, { recursive: true });
  let prev = null; try { prev = JSON.parse(await readFile(new URL('calibration.json', OUT), 'utf8')).cal; } catch { /* first run */ }
  let prevU = null; try { prevU = JSON.parse(await readFile(new URL('universe.json', OUT), 'utf8')); } catch { /* first run */ }

  const uni = await buildUniverse(prevU);
  const bars = {}, names = {}, failed = [], t0 = Date.now();
  let next = 0;
  async function worker() {
    while (next < uni.length) {
      if (Date.now() - t0 > TIME_BUDGET_MS) return;
      const u = uni[next++];
      try { const b = await yahooBars(u.s); if (b) { bars[u.s] = b; names[u.s] = b.name; } else failed.push(u.s); } catch { failed.push(u.s); }
      await sleep(250);
    }
  }
  await Promise.all([worker(), worker(), worker()]);
  const skipped = uni.slice(next).map(u => u.s);
  const idx = {};
  for (const s of IDX) {
    try { const b = /-USD$/.test(s) ? (await binanceBars(s).catch(() => null)) || await yahooBars(s) : await yahooBars(s); if (b) idx[s] = { t: b.map(x => Math.round(x.t / 1000)), c: b.map(x => x.c) }; } catch { failed.push(s); }
    await sleep(350);
  }
  console.log('bars', Object.keys(bars).length, 'idx', Object.keys(idx).length, 'failed', failed.length, 'skipped (time budget)', skipped.length);

  // Never overwrite good data with a bad run.
  if (Object.keys(bars).length < MIN_BARS) throw new Error('Only ' + Object.keys(bars).length + ' symbols downloaded — Yahoo is probably blocking or down. Keeping the previous data.');
  const sb = bars.SPY; if (!sb) throw new Error('SPY history missing — cannot calibrate');
  const map = {}; let last = 0; sb.forEach(x => { const k = dayKey(x.t); if (k != null) { map[k] = x.c; last = Math.max(last, k); } });
  const sp = { map, last, at: k => { for (let j = 0; j < 4; j++) if (map[k - j]) return map[k - j]; return null; } };

  const cal = await runCalibration(bars, sp, prev, []);
  const hist = (prev && prev.hist) || [];
  cal.hist = hist.concat(cal.log.map(l => Object.assign({ day: cal.day }, l))).slice(-60);
  cal.source = 'server';

  const now = new Date().toISOString();
  // Compact bars: arrays per field, prices rounded, to keep the file small.
  const r4 = v => v == null ? null : Math.round(v * 1e4) / 1e4;
  const compact = {}; Object.keys(bars).forEach(s => { const b = bars[s]; compact[s] = { t: b.map(x => Math.round(x.t / 1000)), o: b.map(x => r4(x.o)), h: b.map(x => r4(x.h)), l: b.map(x => r4(x.l)), c: b.map(x => r4(x.c)), v: b.map(x => x.v) }; });

  // The app reads this to learn which symbols exist, their names, sectors and where they came from.
  const symbols = uni.filter(u => bars[u.s]).map(u => Object.assign({}, u, { n: u.n || names[u.s] || u.s }));
  await writeFile(new URL('universe.json', OUT), JSON.stringify({ updated: now, symbols }));
  await writeFile(new URL('calibration.json', OUT), JSON.stringify({ updated: now, cal, failed }));
  await writeFile(new URL('bars.json', OUT), JSON.stringify({ updated: now, bars: compact }));
  await writeFile(new URL('idx.json', OUT), JSON.stringify({ updated: now, idx }));
  await mkdir(new URL('history/', OUT), { recursive: true });
  const day = now.slice(0, 10);
  await writeFile(new URL('history/' + day + '.json', OUT), JSON.stringify({ updated: now, reg: cal.reg, stocks: cal.stocks, feats: Object.fromEntries(Object.entries(cal.feats).map(([k, f]) => [k, { pts: f.pts, status: f.status, nT: f.nT, mT: f.mT }])), byReg: cal.byReg }));
  console.log('calibrated', cal.stocks, 'stocks · regime', cal.reg, '· changes', cal.log.length);
  try { await earningsStage(now, new Set(symbols.map(u => u.s))); } catch (e) { console.log('earnings stage failed:', e && e.message); }
  try { await rankStage(now, bars); } catch (e) { console.log('rank stage failed:', e && e.message); }
  try { await exchangeStage(now, cal); } catch (e) { console.log('exchange stage failed:', e && e.message); }
  try { await intradayStage(now, bars); } catch (e) { console.log('intraday stage failed:', e && e.message); }
  try { await canadaStage(now); } catch (e) { console.log('canada stage failed:', e && e.message); }
  try { await indiaStage(now); } catch (e) { console.log('india stage failed:', e && e.message); }
}
main().catch(e => { console.error(e); process.exit(1); });
