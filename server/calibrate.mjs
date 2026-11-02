// Divergence — daily server-side calibration.
// Runs on a schedule (GitHub Actions), fetches free Yahoo/Binance data,
// re-tests every signal ingredient by market type and publishes JSON for the app.
// Node 20+, no dependencies.
import { readFile, writeFile, mkdir } from 'node:fs/promises';

import { pathToFileURL } from 'node:url';
const OUT = new URL('data/', pathToFileURL(process.cwd() + '/'));
const UNIVERSE = ["SPY","QQQ","IWM","AAPL","MSFT","NVDA","AVGO","ORCL","CRM","ADBE","AMD","INTC","MU","PLTR","CRWD","PANW","NET","SNOW","GOOGL","META","NFLX","DIS","T","VZ","TMUS","SPOT","RDDT","PINS","SNAP","AMZN","TSLA","HD","MCD","WMT","COST","PG","KO","PEP","PM","MDLZ","CL","KHC","TGT","JPM","BAC","WFC","GS","MS","V","MA","AXP","SCHW","HOOD","SOFI","PYPL","LLY","UNH","JNJ","ABBV","MRK","PFE","TMO","ISRG","VRTX","MRNA","HIMS","XOM","CVX","COP","OXY","SLB","EOG","MPC","DVN","HAL","CAT","GE","BA","HON","UPS","RTX","LMT","DE","UBER","RKLB","LIN","FCX","NEM","SHW","DOW","NUE","ALB","MP","NEE","DUK","SO","CEG","VST","OKLO","SMR","CCJ","PLD","AMT","EQIX","O","SPG","DLR","MSTR","COIN","MARA","RIOT","HUT","CLSK","IREN","CIFR","ACN","BB","NOK","BITF","WULF","APLD","CORZ","BTBT","PLUG","LCID","NIO","FUBO","AMC","GME","SNDL","TLRY","OPEN","IONQ","RGTI","QBTS","SOUN","BBAI","ACHR","JOBY","LUNR","ASTS","UPST","AFRM","CHPT","BLNK","QS","RUN","SIRI","GRAB","CELH","RXRX","NVAX","MVIS","CLOV"];
const IDX = ["^GSPC","^NDX","^DJI","^RUT","^VIX","^TNX","^FVX","^TYX","TLT","GC=F","SI=F","CL=F","NG=F","HG=F","ES=F","NQ=F","YM=F","RTY=F","ZN=F","ZB=F","6E=F","BZ=F","BTC-USD","ETH-USD","SOL-USD","DX-Y.NYB","EURUSD=X"];
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
  ['newHigh', 'New 52-week high'], ['news', 'Active news / shortage theme']
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
    const E10 = ema(cl, 10), E50 = ema(cl, 50), E200 = ema(cl, 200), R = rsi(cl, 14), H = macd(cl).hist;
    for (let k = 220; k < n - H20; k++) {
      const d0 = dayKey(b[k].t), d1 = dayKey(b[k + H20].t); if (d0 == null || d1 == null || d1 > valEnd + 30) continue;
      const s0 = spyDayClose.at(d0), s1 = spyDayClose.at(d1); if (!s0 || !s1) continue;
      const f = calFeatsAt(cl, hi, lo, v, E10, E50, E200, R, H, k);
      const ex = (cl[k + H20] / cl[k] - 1) - (s1 / s0 - 1) - COST;
      for (const id in f) { if (!f[id]) continue; const rare = id === 'macdUp' || id === 'macdDn' || id === 'confirmOS' || id === 'bbdcRev' || id === 'volUp' || id === 'volDn' || id === 'newHigh'; if (!rare && k % 5) continue; (d0 <= cutoff ? ev[id].T : d0 <= valEnd ? ev[id].V : null)?.push(ex); const rg = regAt(d0); if (rg) evR[rg][id].push(ex); }
    }
  }
  (newsLog || []).forEach(e => { if (e.ex == null) return; (e.d <= cutoff ? ev.news.T : ev.news.V).push(e.ex); const rg = regAt(e.d); if (rg) evR[rg].news.push(e.ex); });
  const stat = a => { const n = a.length; if (!n) return { n: 0, m: 0, hit: 0, sd: 0 }; const m = a.reduce((x, y) => x + y, 0) / n; let s = 0; a.forEach(x => { s += (x - m) * (x - m); }); return { n, m, hit: a.filter(x => x > 0).length / n, sd: Math.sqrt(s / Math.max(1, n - 1)) }; };
  const feats = {}, log = [];
  CAL_FEATS.forEach(([id, label]) => {
    const T = stat(ev[id].T), V = stat(ev[id].V);
    let pts = 0, status = 'active';
    if (T.n < 30) status = 'too few cases';
    else {
      const t = T.m / (T.sd / Math.sqrt(T.n) || 1);
      pts = Math.max(-3, Math.min(3, t)) * 2.5 * Math.min(1, T.n / 200);
      if (Math.abs(t) < 1.5) { pts = 0; status = 'no edge'; }
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
    const S = stat(evR[g][id]); let pts = 0, status = 'active';
    if (S.n < 30) status = 'too few cases';
    else { const t = S.m / (S.sd / Math.sqrt(S.n) || 1); pts = Math.max(-3, Math.min(3, t)) * 2.5 * Math.min(1, S.n / 200); if (Math.abs(t) < 1.5) { pts = 0; status = 'no edge'; } }
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

// Yahoo chart endpoint: full OHLCV, one symbol per call.
async function yahooBars(sym) {
  const j = await getJSON('https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(sym) + '?range=2y&interval=1d&includePrePost=false');
  const R = j && j.chart && j.chart.result && j.chart.result[0]; if (!R || !R.timestamp) return null;
  const q = R.indicators.quote[0], out = [];
  R.timestamp.forEach((t, i) => { if (q.close[i] == null) return; out.push({ t: t * 1000, o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i], v: q.volume[i] || 0 }); });
  return out.length ? out : null;
}
async function binanceBars(sym) {
  const k = await getJSON('https://api.binance.com/api/v3/klines?symbol=' + sym.replace('-USD', 'USDT') + '&interval=1d&limit=730');
  return Array.isArray(k) ? k.map(x => ({ t: x[0], o: +x[1], h: +x[2], l: +x[3], c: +x[4], v: +x[5] })) : null;
}

async function main() {
  await mkdir(OUT, { recursive: true });
  let prev = null; try { prev = JSON.parse(await readFile(new URL('calibration.json', OUT), 'utf8')).cal; } catch { /* first run */ }

  const bars = {}, failed = [];
  for (const s of UNIVERSE) { try { const b = await yahooBars(s); if (b) bars[s] = b; else failed.push(s); } catch { failed.push(s); } await sleep(350); }
  const idx = {};
  for (const s of IDX) {
    try { const b = /-USD$/.test(s) ? (await binanceBars(s).catch(() => null)) || await yahooBars(s) : await yahooBars(s); if (b) idx[s] = { t: b.map(x => Math.round(x.t / 1000)), c: b.map(x => x.c) }; } catch { failed.push(s); }
    await sleep(350);
  }
  console.log('bars', Object.keys(bars).length, 'idx', Object.keys(idx).length, 'failed', failed.length);

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

  await writeFile(new URL('calibration.json', OUT), JSON.stringify({ updated: now, cal, failed }));
  await writeFile(new URL('bars.json', OUT), JSON.stringify({ updated: now, bars: compact }));
  await writeFile(new URL('idx.json', OUT), JSON.stringify({ updated: now, idx }));
  await mkdir(new URL('history/', OUT), { recursive: true });
  const day = now.slice(0, 10);
  await writeFile(new URL('history/' + day + '.json', OUT), JSON.stringify({ updated: now, reg: cal.reg, stocks: cal.stocks, feats: Object.fromEntries(Object.entries(cal.feats).map(([k, f]) => [k, { pts: f.pts, status: f.status, nT: f.nT, mT: f.mT }])), byReg: cal.byReg }));
  console.log('calibrated', cal.stocks, 'stocks · regime', cal.reg, '· changes', cal.log.length);
}
main().catch(e => { console.error(e); process.exit(1); });
