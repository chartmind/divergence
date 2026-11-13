// Divergence — Telegram bot, morning/evening briefs and alerts.
// Usage: node bot.mjs poll | am | pm      (run by GitHub Actions)
// Secrets: TELEGRAM_TOKEN (required), BOT_INVITE (optional join code)
import { readFile, writeFile, mkdir } from 'node:fs/promises';

const TOKEN = process.env.TELEGRAM_TOKEN, INVITE = (process.env.BOT_INVITE || '').trim();
const REPO = process.env.GITHUB_REPOSITORY || '';
const APP = process.env.APP_URL || (REPO ? 'https://' + REPO.split('/')[0].toLowerCase() + '.github.io/' + REPO.split('/')[1] + '/' : '');
const MODE = process.argv[2] || 'poll';
const UA = { 'User-Agent': 'Mozilla/5.0 (compatible; divergence-bot/1.0)' };
const UNIVERSE = ["SPY","QQQ","IWM","AAPL","MSFT","NVDA","AVGO","ORCL","CRM","ADBE","AMD","INTC","MU","PLTR","CRWD","PANW","NET","SNOW","GOOGL","META","NFLX","DIS","T","VZ","TMUS","SPOT","RDDT","PINS","SNAP","AMZN","TSLA","HD","MCD","WMT","COST","PG","KO","PEP","PM","MDLZ","CL","KHC","TGT","JPM","BAC","WFC","GS","MS","V","MA","AXP","SCHW","HOOD","SOFI","PYPL","LLY","UNH","JNJ","ABBV","MRK","PFE","TMO","ISRG","VRTX","MRNA","HIMS","XOM","CVX","COP","OXY","SLB","EOG","MPC","DVN","HAL","CAT","GE","BA","HON","UPS","RTX","LMT","DE","UBER","RKLB","LIN","FCX","NEM","SHW","DOW","NUE","ALB","MP","NEE","DUK","SO","CEG","VST","OKLO","SMR","CCJ","PLD","AMT","EQIX","O","SPG","DLR","MSTR","COIN","MARA","RIOT","HUT","CLSK","IREN","CIFR","ACN","BB","NOK","BITF","WULF","APLD","CORZ","BTBT","PLUG","LCID","NIO","FUBO","AMC","GME","SNDL","TLRY","OPEN","IONQ","RGTI","QBTS","SOUN","BBAI","ACHR","JOBY","LUNR","ASTS","UPST","AFRM","CHPT","BLNK","QS","RUN","SIRI","GRAB","CELH","RXRX","NVAX","MVIS","CLOV"];
const STATE_F = '.botstate/state.json', SIG_F = 'data/signals.json', BRIEF_F = 'data/brief.json';
const sleep = ms => new Promise(r => setTimeout(r, ms));
if (!TOKEN) { console.log('TELEGRAM_TOKEN not set — skipping bot.'); process.exit(0); }

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
  const syms = Object.keys(barsMap).filter(s => barsMap[s] && barsMap[s].length >= 300 && !/-USD$|\.NS$|\.BO$|^\^/.test(s)).slice(0, 350);
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

// ---------- io ----------
async function readJSON(f, d) { try { return JSON.parse(await readFile(f, 'utf8')); } catch { return d; } }
async function writeJSON(f, v) { await mkdir(f.split('/').slice(0, -1).join('/') || '.', { recursive: true }); await writeFile(f, JSON.stringify(v)); }
async function getJSON(url, tries = 3) {
  for (let t = 0; t < tries; t++) {
    try { const r = await fetch(url, { headers: UA }); if (r.status === 429) { await sleep(4000 * (t + 1)); continue; } if (!r.ok) return null; return await r.json(); }
    catch { await sleep(1500 * (t + 1)); }
  }
  return null;
}
async function tg(method, body) {
  const r = await fetch('https://api.telegram.org/bot' + TOKEN + '/' + method, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return r.json().catch(() => ({}));
}
const send = (chat, text) => tg('sendMessage', { chat_id: chat, text: text.slice(0, 4000), parse_mode: 'HTML', disable_web_page_preview: true });

// ---------- data ----------
async function chartBars(sym, range = '2y') {
  const j = await getJSON('https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(sym) + '?range=' + range + '&interval=1d');
  const R = j && j.chart && j.chart.result && j.chart.result[0]; if (!R || !R.timestamp) return null;
  const q = R.indicators.quote[0], out = [];
  R.timestamp.forEach((t, i) => { if (q.close[i] != null) out.push({ t: t * 1000, o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i], v: q.volume[i] || 0 }); });
  return out.length ? { bars: out, name: R.meta && (R.meta.shortName || R.meta.longName) || sym, prev: R.meta && R.meta.chartPreviousClose } : null;
}
async function quotes(syms) {
  const out = {};
  for (let i = 0; i < syms.length; i += 20) {
    const part = syms.slice(i, i + 20);
    const j = await getJSON('https://query1.finance.yahoo.com/v7/finance/spark?symbols=' + part.map(encodeURIComponent).join(',') + '&range=1d&interval=5m');
    const res = j && j.spark && j.spark.result; if (!res) continue;
    res.forEach(r => { const R = r.response && r.response[0]; if (!R) return; const c = (R.indicators.quote[0].close || []).filter(v => v != null); const p = c.length ? c[c.length - 1] : R.meta && R.meta.regularMarketPrice; if (p) out[r.symbol] = { p, prev: R.meta && (R.meta.chartPreviousClose || R.meta.previousClose) }; });
    await sleep(400);
  }
  return out;
}
function expandBars(x) { return x.t.map((t, i) => ({ t: t * 1000, o: x.o[i], h: x.h[i], l: x.l[i], c: x.c[i], v: x.v[i] })); }
function regPts(cal, id) { if (!cal || !cal.feats || !cal.feats[id]) return 0; const R = cal.byReg && cal.reg ? cal.byReg[cal.reg][id] : null; if (R && R.n >= 30) return R.status === 'active' ? R.pts : 0; return cal.feats[id].pts * 0.5; }

// Daily signal: trend + RSI + MACD base, plus today's calibrated points for the current market type.
let RANKS = null;
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
  const why = [];
  for (const id in f) { if (!f[id]) continue; const pt = regPts(cal, id); if (pt) { s += pt; why.push([id, pt]); } }
  let tr = 0; for (let i = k - 13; i <= k; i++) tr += Math.max(hi[i] - lo[i], Math.abs(hi[i] - cl[i - 1]), Math.abs(lo[i] - cl[i - 1])); const atr = tr / 14;
  const lo52 = Math.min(...lo.slice(-252)), down = p < E200[k] && E50[k] < E200[k];
  let a = s >= 3 ? 'BUY' : s <= -3 ? 'SELL' : 'HOLD', gate = '';
  if (a === 'BUY' && down && p < E50[k]) { a = 'HOLD'; gate = 'buy blocked: downtrend'; }
  if (a === 'SELL' && R[k] < 32 && p < lo52 * 1.06) { a = 'HOLD'; gate = 'sell held: near 52-week low'; }
  { const a0 = a; a = peerGate(a, RANKS && (RANKS.rows[sym] || RANKS.coins[sym]), R[k], p / cl[k - 21] - 1); if (a !== a0) gate = a0 === 'BUY' ? 'buy held: weak vs peers or oversold dip' : 'sell held: strong vs peers'; }
  const sup = Math.min(...lo.slice(-20)), res = Math.max(...hi.slice(-20));
  const stop = Math.min(sup, p - 1.5 * atr), target = Math.max(res, p + 2 * atr);
  return { a, s: Math.round(s * 10) / 10, p, r: Math.round(R[k]), e10: E10[k], e50: E50[k], e200: E200[k], atr, sup, res, stop, target, rr: (target - p) / Math.max(1e-9, p - stop), gate, why: why.sort((x, y) => Math.abs(y[1]) - Math.abs(x[1])).slice(0, 3).map(([id, pt]) => (CAL_FEATS.find(c => c[0] === id) || [id, id])[1] + ' ' + (pt > 0 ? '+' : '') + pt.toFixed(1)) };
}
const $ = v => v == null ? '—' : v >= 1000 ? '$' + v.toLocaleString('en-US', { maximumFractionDigits: 0 }) : v >= 1 ? '$' + v.toFixed(2) : '$' + v.toPrecision(3);
const pct = v => (v >= 0 ? '+' : '') + v.toFixed(2) + '%';
const icon = a => a === 'BUY' ? '🟢' : a === 'SELL' ? '🔴' : '⚪';
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const link = APP ? '\n\n<a href="' + APP + '">Open Divergence</a> · Not investment advice.' : '\n\nNot investment advice.';

async function normSym(raw) {
  let s = raw.toUpperCase().replace(/[^A-Z0-9.\-=^]/g, ''); if (!s) return null;
  for (const c of [s, s + '-USD', s + '.NS']) { const x = await chartBars(c, '5d'); if (x) return { sym: c, name: x.name }; await sleep(300); }
  return null;
}

// ---------- commands ----------
const HELP = '<b>Divergence alerts</b>\n' +
  '/add NVDA AMD — watch stocks, crypto (BTC), futures (ES=F)\n/remove NVDA\n/list — your list with today’s signal\n' +
  '/level NVDA 120 — alert when price reaches 120\n/levels — your price levels\n/signal NVDA — signal right now\n/brief — latest brief\n/stop — unsubscribe\n\n' +
  'You also get a brief before the open (8am ET) and after the close (about 5pm ET): market type, best setups, and any BUY↔SELL flips on your list.';
async function handle(st, sigs, m) {
  const chat = String(m.chat.id), txt = (m.text || '').trim(), [cmd0, ...args] = txt.split(/\s+/), cmd = cmd0.toLowerCase().split('@')[0];
  let u = st.users[chat];
  if (cmd === '/start') {
    if (INVITE && args[0] !== INVITE && !u) return send(chat, 'This bot is invite-only for now. Send /start followed by your invite code.');
    st.users[chat] = u || { name: (m.from && m.from.first_name) || '', list: [], levels: {}, joined: Date.now() };
    return send(chat, 'Welcome' + (u ? ' back' : '') + '! ' + HELP);
  }
  if (!u) return send(chat, 'Send /start' + (INVITE ? ' with your invite code' : '') + ' to subscribe.');
  if (cmd === '/help') return send(chat, HELP);
  if (cmd === '/stop') { delete st.users[chat]; return send(chat, 'Unsubscribed. Send /start any time to come back.'); }
  if (cmd === '/add') {
    const ok = [], bad = [];
    for (const r of args.slice(0, 15)) { const n = await normSym(r); if (n) { if (!u.list.includes(n.sym)) u.list.push(n.sym); ok.push(n.sym); } else bad.push(r); }
    u.list = u.list.slice(-40);
    return send(chat, (ok.length ? 'Watching: ' + ok.join(', ') : '') + (bad.length ? '\nNot found: ' + bad.join(', ') : '') + (ok.length ? '\nTheir signals appear in tonight’s brief, or use /signal now.' : ''));
  }
  if (cmd === '/remove') { const r = args.map(x => x.toUpperCase()); u.list = u.list.filter(s => !r.includes(s) && !r.includes(s.replace(/-USD$|\.NS$/, ''))); r.forEach(s => { delete u.levels[s]; }); return send(chat, 'Removed. /list to see what’s left.'); }
  if (cmd === '/list') {
    if (!u.list.length) return send(chat, 'Your list is empty. Try /add NVDA BTC');
    return send(chat, '<b>Your list</b> (signal from last close)\n' + u.list.map(s => { const g = sigs[s]; return g ? icon(g.a) + ' <b>' + s + '</b> ' + g.a + ' ' + g.s + ' · ' + $(g.p) + ' · RSI ' + g.r : '⏳ <b>' + s + '</b> — in tonight’s brief'; }).join('\n') + link);
  }
  if (cmd === '/level') {
    const n = await normSym(args[0] || ''), p = parseFloat(args[1]);
    if (!n || !isFinite(p)) return send(chat, 'Usage: /level NVDA 120');
    const q = (await quotes([n.sym]))[n.sym]; const dir = q && q.p > p ? 'below' : 'above';
    (u.levels[n.sym] = u.levels[n.sym] || []).push({ p, dir }); if (!u.list.includes(n.sym)) u.list.push(n.sym);
    return send(chat, 'OK — I’ll alert you when ' + n.sym + ' goes ' + dir + ' ' + $(p) + (q ? ' (now ' + $(q.p) + ')' : '') + '. Checked every 15 min in market hours.');
  }
  if (cmd === '/levels') { const L = Object.entries(u.levels).flatMap(([s, a]) => a.map(x => s + ' ' + x.dir + ' ' + $(x.p))); return send(chat, L.length ? '<b>Your price levels</b>\n' + L.join('\n') : 'No levels yet. Try /level NVDA 120'); }
  if (cmd === '/signal') {
    const n = await normSym(args[0] || ''); if (!n) return send(chat, 'Usage: /signal NVDA');
    const x = await chartBars(n.sym), cal = (await readJSON('data/calibration.json', {})).cal; RANKS = await readJSON('data/ranks.json', null); const g = x && signalOf(x.bars, cal, n.sym);
    if (!g) return send(chat, 'Not enough history for ' + n.sym + ' yet.');
    return send(chat, icon(g.a) + ' <b>' + n.sym + '</b> ' + esc(n.name) + '\n<b>' + g.a + '</b> · score ' + g.s + (g.gate ? ' (' + g.gate + ')' : '') + '\nPrice ' + $(g.p) + ' · RSI ' + g.r + '\nSupport ' + $(g.sup) + ' · resistance ' + $(g.res) + '\nEMA 50 ' + $(g.e50) + ' · EMA 200 ' + $(g.e200) + (g.why.length ? '\nWorking now: ' + g.why.join(', ') : '') + link);
  }
  if (cmd === '/brief') { const B = await readJSON(BRIEF_F, null); return send(chat, B ? B.text + link : 'No brief yet — the first one arrives after today’s close.'); }
  return send(chat, 'I didn’t understand that. ' + HELP);
}

async function pollUpdates(st, sigs) {
  const j = await tg('getUpdates', { offset: st.offset || 0, timeout: 0, allowed_updates: ['message'] });
  for (const up of (j.result || [])) { st.offset = up.update_id + 1; if (up.message && up.message.text) { try { await handle(st, sigs, up.message); } catch (e) { console.error('cmd', e.message); } } }
}

async function checkLevels(st) {
  const syms = [...new Set(Object.values(st.users).flatMap(u => Object.keys(u.levels || {})))]; if (!syms.length) return;
  const q = await quotes(syms);
  for (const [chat, u] of Object.entries(st.users)) for (const s of Object.keys(u.levels || {})) {
    const now = q[s]; if (!now) continue;
    const keep = [];
    for (const L of u.levels[s]) { const hit = L.dir === 'above' ? now.p >= L.p : now.p <= L.p; if (hit) await send(chat, '🔔 <b>' + s + '</b> is ' + L.dir + ' your level ' + $(L.p) + ' — now ' + $(now.p) + (now.prev ? ' (' + pct((now.p / now.prev - 1) * 100) + ' today)' : '') + link); else keep.push(L); }
    if (keep.length) u.levels[s] = keep; else delete u.levels[s];
  }
}

const REG_LBL = { bullCalm: 'Uptrend · calm', bullVol: 'Uptrend · volatile', bearCalm: 'Downtrend · calm', bearVol: 'Downtrend · volatile' };
function bestSetups(sigs, n = 5) {
  return Object.entries(sigs).filter(([s, g]) => g.a === 'BUY' && g.r < 68 && g.p / g.e10 < 1.05 && g.rr >= 2 && !/-USD$|=F$|\^/.test(s)).sort((a, b) => b[1].s - a[1].s).slice(0, n);
}
function setupLine([s, g]) { return '🟢 <b>' + s + '</b> ' + $(g.p) + ' → ' + $(g.target) + ' · stop ' + $(g.stop) + ' · R:R 1:' + g.rr.toFixed(1); }

async function pmBrief(st) {
  const cal = (await readJSON('data/calibration.json', {})).cal; RANKS = await readJSON('data/ranks.json', null);
  const B = await readJSON('data/bars.json', {}), prevSigs = (await readJSON(SIG_F, {})).sigs || {};
  const sigs = {};
  for (const [s, x] of Object.entries(B.bars || {})) { const g = signalOf(expandBars(x), cal, s); if (g) sigs[s] = g; }
  const extra = [...new Set(Object.values(st.users).flatMap(u => u.list))].filter(s => !sigs[s]);
  for (const s of extra) { const x = await chartBars(s); const g = x && signalOf(x.bars, cal, s); if (g) sigs[s] = g; await sleep(300); }
  const spx = B.bars && B.bars.SPY ? expandBars(B.bars.SPY) : null, spCh = spx ? (spx[spx.length - 1].c / spx[spx.length - 2].c - 1) * 100 : null;
  const reg = cal && cal.reg, regChanged = st.lastReg && reg && st.lastReg !== reg;
  const best = bestSetups(sigs), nb = Object.values(sigs).filter(g => g.a === 'BUY').length, ns = Object.values(sigs).filter(g => g.a === 'SELL').length;
  const working = cal && cal.byReg && reg ? Object.entries(cal.byReg[reg]).filter(([, r]) => r.status === 'active' && r.pts > 0).sort((a, b) => b[1].pts - a[1].pts).slice(0, 3).map(([id]) => (CAL_FEATS.find(c => c[0] === id) || [id, id])[1]) : [];
  const head = '<b>🌙 Evening brief</b>\n' + (reg ? 'Market: <b>' + REG_LBL[reg] + '</b>' + (regChanged ? ' ⚠️ changed from ' + REG_LBL[st.lastReg] : '') + '\n' : '') + (spCh != null ? 'SPY ' + pct(spCh) + ' · ' : '') + nb + ' BUY / ' + ns + ' SELL across ' + Object.keys(sigs).length + ' symbols\n' + (working.length ? 'Working in this market: ' + working.join(', ') + '\n' : '');
  const bestTxt = best.length ? '\n<b>Best setups</b>\n' + best.map(setupLine).join('\n') : '\nNo clean BUY setups with R:R ≥ 2 today.';
  for (const [chat, u] of Object.entries(st.users)) {
    const flips = u.list.filter(s => sigs[s] && prevSigs[s] && sigs[s].a !== prevSigs[s].a && (sigs[s].a !== 'HOLD' || prevSigs[s].a !== 'HOLD'));
    const mine = u.list.filter(s => sigs[s]).map(s => icon(sigs[s].a) + ' <b>' + s + '</b> ' + sigs[s].a + ' ' + sigs[s].s + ' · ' + $(sigs[s].p) + ' · RSI ' + sigs[s].r).join('\n');
    const fl = flips.length ? '\n<b>⚡ Signal changes on your list</b>\n' + flips.map(s => '<b>' + s + '</b> ' + prevSigs[s].a + ' → ' + icon(sigs[s].a) + ' ' + sigs[s].a + ' (' + $(sigs[s].p) + ')').join('\n') : '';
    await send(chat, head + fl + bestTxt + (mine ? '\n\n<b>Your list</b>\n' + mine : '\n\nAdd stocks with /add NVDA') + link);
    await sleep(60);
  }
  const text = head + bestTxt;
  await writeJSON(SIG_F, { updated: new Date().toISOString(), reg, sigs });
  await writeJSON(BRIEF_F, { updated: new Date().toISOString(), kind: 'pm', reg, regPrev: regChanged ? st.lastReg : null, spCh, nb, ns, working, best: best.map(([s, g]) => ({ s, p: g.p, target: g.target, stop: g.stop, rr: g.rr, score: g.s })), text });
  st.lastReg = reg || st.lastReg; st.lastPm = Date.now();
  return sigs;
}

async function amBrief(st) {
  const S = await readJSON(SIG_F, {}), sigs = S.sigs || {}, cal = (await readJSON('data/calibration.json', {})).cal;
  const fut = await quotes(['ES=F', 'NQ=F', 'YM=F', 'RTY=F', '^VIX', 'BTC-USD', 'CL=F', 'GC=F']);
  const nm = { 'ES=F': 'S&P fut', 'NQ=F': 'Nasdaq fut', 'YM=F': 'Dow fut', 'RTY=F': 'Russell fut', '^VIX': 'VIX', 'BTC-USD': 'Bitcoin', 'CL=F': 'Oil', 'GC=F': 'Gold' };
  const fl = Object.entries(fut).map(([s, q]) => nm[s] + ' ' + (q.prev ? pct((q.p / q.prev - 1) * 100) : $(q.p))).join(' · ');
  const best = bestSetups(sigs);
  const head = '<b>☀️ Morning brief</b>\n' + (cal && cal.reg ? 'Market: <b>' + REG_LBL[cal.reg] + '</b>\n' : '') + (fl ? fl + '\n' : '');
  const bestTxt = best.length ? '\n<b>Setups to watch at the open</b> (from last close)\n' + best.map(setupLine).join('\n') : '';
  const allSyms = [...new Set(Object.values(st.users).flatMap(u => u.list))], q = await quotes(allSyms);
  for (const [chat, u] of Object.entries(st.users)) {
    const near = u.list.filter(s => sigs[s] && q[s]).map(s => { const g = sigs[s], p = q[s].p; const ds = (p / g.sup - 1) * 100, dr = (g.res / p - 1) * 100; return ds < 2 ? '⚠️ <b>' + s + '</b> ' + $(p) + ' near support ' + $(g.sup) : dr < 2 ? '⚠️ <b>' + s + '</b> ' + $(p) + ' near resistance ' + $(g.res) : null; }).filter(Boolean);
    await send(chat, head + bestTxt + (near.length ? '\n\n<b>Levels to watch today</b>\n' + near.join('\n') : '') + link);
    await sleep(60);
  }
  await writeJSON(BRIEF_F, Object.assign(await readJSON(BRIEF_F, {}), { am: { updated: new Date().toISOString(), futures: fut, text: head + bestTxt } }));
  st.lastAm = Date.now();
}

async function main() {
  const st = await readJSON(STATE_F, { offset: 0, users: {} });
  const sigs = (await readJSON(SIG_F, {})).sigs || {};
  await pollUpdates(st, sigs);
  if (MODE === 'pm') await pmBrief(st);
  else if (MODE === 'am') await amBrief(st);
  else await checkLevels(st);
  await pollUpdates(st, sigs);
  await writeJSON(STATE_F, st);
  console.log(MODE, 'done ·', Object.keys(st.users).length, 'subscribers');
}
main().catch(e => { console.error(e); process.exit(1); });
