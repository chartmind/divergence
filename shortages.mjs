// Divergence — daily shortage & supply-theme scan.
// Runs on GitHub Actions. For each theme: reads the last 30 days of Google News headlines, counts shortage
// language, checks the commodity/ETF price trend, finds early signs, ranks the related stocks, and
// writes data/shortages.json. Node 20+, no dependencies.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
const OUT = new URL('data/', pathToFileURL(process.cwd() + '/'));
const UA = { 'User-Agent': 'Mozilla/5.0 (compatible; divergence-shortages/1.0)' };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const SPEC = [
 {
  "id": "diesel",
  "q": "diesel prices",
  "kw": "diesel|fuel price|gasoline|distillate|refin",
  "shortage": true,
  "proxy": [
   "HO=F"
  ],
  "picks": [
   "VLO",
   "MPC",
   "PSX",
   "ADM",
   "BG"
  ]
 },
 {
  "id": "fert",
  "q": "fertilizer shortage",
  "kw": "fertili[sz]er|potash|nitrogen|ammonia|urea|phosphate",
  "shortage": true,
  "proxy": [
   "CF",
   "MOS",
   "NTR",
   "UAN"
  ],
  "picks": [
   "CF",
   "NTR",
   "MOS",
   "IPI",
   "UAN"
  ]
 },
 {
  "id": "food",
  "q": "food prices inflation",
  "kw": "food price|grocery|food inflation|crop price|wheat|corn price|beef price|egg price",
  "shortage": true,
  "proxy": [
   "DBA"
  ],
  "picks": [
   "CTVA",
   "ADM",
   "TSN",
   "CALM",
   "DBA"
  ]
 },
 {
  "id": "oil",
  "q": "oil natural gas supply prices",
  "kw": "opec|crude|oil supply|oil price|brent|sanction|natural gas|LNG|henry hub|gas price|pipeline",
  "shortage": true,
  "proxy": [
   "CL=F"
  ],
  "picks": [
   "XOM",
   "CVX",
   "OXY",
   "EQT",
   "AR",
   "RRC",
   "LNG",
   "FRO",
   "FLNG",
   "CL=F",
   "NG=F"
  ]
 },
 {
  "id": "rare",
  "q": "rare earth export restrictions critical minerals",
  "kw": "rare earth|critical mineral|gallium|germanium|antimony|tungsten|export ban|export control",
  "shortage": true,
  "proxy": [
   "REMX"
  ],
  "picks": [
   "MP",
   "USAR",
   "UAMY",
   "TMC",
   "NB"
  ]
 },
 {
  "id": "coal",
  "q": "coal prices shortage",
  "kw": "coal|met coal|coking|thermal coal",
  "shortage": true,
  "proxy": [
   "KOL"
  ],
  "picks": [
   "BTU",
   "ARLP",
   "HCC",
   "AMR",
   "CNR"
  ]
 },
 {
  "id": "softs",
  "q": "cocoa coffee sugar prices shortage",
  "kw": "cocoa|coffee|sugar|orange juice|drought|harvest",
  "shortage": true,
  "proxy": [
   "CC=F",
   "SB=F",
   "KC=F"
  ],
  "picks": [
   "CC=F",
   "SB=F",
   "ADM",
   "BG"
  ]
 },
 {
  "id": "helium",
  "q": "helium neon shortage semiconductor",
  "kw": "helium|neon|industrial gas|specialty gas|chip material",
  "shortage": true,
  "proxy": [],
  "picks": [
   "LIN",
   "APD",
   "ENTG"
  ]
 },
 {
  "id": "ai",
  "q": "data center power demand AI",
  "kw": "data cent|power demand|electricity|gigawatt|AI infrastructure|nuclear",
  "shortage": false,
  "proxy": [],
  "picks": [
   "CEG",
   "VST",
   "VRT",
   "ETN",
   "CRWV"
  ]
 },
 {
  "id": "uranium",
  "q": "uranium nuclear reactor",
  "kw": "uranium|nuclear|reactor|SMR",
  "shortage": false,
  "proxy": [
   "URA"
  ],
  "picks": [
   "CCJ",
   "UEC",
   "LEU",
   "OKLO",
   "SMR"
  ]
 },
 {
  "id": "defense",
  "q": "defense spending military conflict",
  "kw": "defen[cs]e|military|missile|NATO|war|conflict|drone",
  "shortage": false,
  "proxy": [
   "ITA"
  ],
  "picks": [
   "LMT",
   "RTX",
   "NOC",
   "LHX",
   "KTOS"
  ]
 },
 {
  "id": "gold",
  "q": "gold price safe haven",
  "kw": "gold|silver|safe haven|central bank buying",
  "shortage": false,
  "proxy": [
   "GC=F"
  ],
  "picks": [
   "GC=F",
   "NEM",
   "AEM",
   "WPM",
   "SI=F"
  ]
 },
 {
  "id": "copper",
  "q": "copper shortage supply",
  "kw": "copper|mine disruption|electrification",
  "shortage": true,
  "proxy": [
   "HG=F"
  ],
  "picks": [
   "FCX",
   "SCCO",
   "TECK",
   "HG=F"
  ]
 },
 {
  "id": "rates",
  "q": "Fed rate cut",
  "kw": "rate cut|fed cut|dovish|lower rates|easing",
  "shortage": false,
  "proxy": [],
  "picks": [
   "DHI",
   "LEN",
   "IWM",
   "SOFI",
   "GC=F"
  ]
 },
 {
  "id": "tariff",
  "q": "tariffs steel imports",
  "kw": "tariff|import dut|trade war|section 232",
  "shortage": false,
  "proxy": [],
  "picks": [
   "NUE",
   "STLD",
   "CLF",
   "MP"
  ]
 },
 {
  "id": "shipping",
  "q": "shipping disruption freight rates",
  "kw": "shipping|freight|red sea|suez|panama canal|container rate",
  "shortage": false,
  "proxy": [],
  "picks": [
   "ZIM",
   "MATX",
   "FRO",
   "STNG"
  ]
 },
 {
  "id": "crypto",
  "q": "bitcoin ETF inflows regulation",
  "kw": "bitcoin|crypto|ETF inflow|stablecoin|SEC approv",
  "shortage": false,
  "proxy": [
   "BTC-USD"
  ],
  "picks": [
   "BTC",
   "ETH",
   "COIN",
   "MSTR",
   "HUT"
  ]
 },
 {
  "id": "bird",
  "q": "bird flu egg prices",
  "kw": "bird flu|avian|egg",
  "shortage": false,
  "proxy": [],
  "picks": [
   "CALM",
   "VITL"
  ]
 },
 {
  "id": "memory",
  "q": "DRAM memory chip shortage",
  "kw": "\\bdram\\b|\\bhbm\\b|memory chip|\\bnand\\b|memory price",
  "shortage": true,
  "proxy": [
   "MU"
  ],
  "picks": [
   "MU",
   "SNDK",
   "WDC",
   "LRCX"
  ]
 },
 {
  "id": "alum",
  "q": "aluminium shortage smelter premium",
  "kw": "alumin(i)?um|smelter|alumina|bauxite",
  "shortage": true,
  "proxy": [
   "ALI=F"
  ],
  "picks": [
   "AA",
   "CENX",
   "ALI=F"
  ]
 }
];
const SHORT_LANG = /shortage|short supply|supply crunch|tight suppl|supply deficit|deficit|stockout|out of stock|rationing|supply disruption|sold out|lowest (stocks|inventor)|inventories (fall|drop|dwindle)|export (ban|curb|restriction)|force majeure|allocation/i;
const UP_LANG = /(rise|rising|surge|soar|jump|spike|climb|higher|tight|record|rally|hike)/i;

async function getText(url, tries = 3) {
  for (let t = 0; t < tries; t++) {
    try { const r = await fetch(url, { headers: UA }); if (r.status === 429) { await sleep(4000 * (t + 1)); continue; } if (!r.ok) throw new Error(r.status); return await r.text(); }
    catch (e) { if (t === tries - 1) return null; await sleep(1500 * (t + 1)); }
  }
  return null;
}
const dec = s => s.replace(/<!\[CDATA\[|\]\]>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").trim();
function parseRss(xml) {
  const out = []; if (!xml) return out;
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const g = k => { const x = m[1].match(new RegExp('<' + k + '[^>]*>([\\s\\S]*?)</' + k + '>')); return x ? dec(x[1]) : ''; };
    const t = Date.parse(g('pubDate')); if (!isFinite(t)) continue;
    let title = g('title'), src = g('source'); if (src && title.endsWith(' - ' + src)) title = title.slice(0, -(src.length + 3));
    out.push({ title, link: g('link'), src, t });
  }
  return out;
}
async function news(q) {
  const u = 'https://news.google.com/rss/search?q=' + encodeURIComponent(q + ' when:30d') + '&hl=en-US&gl=US&ceid=US:en';
  const items = parseRss(await getText(u));
  const seen = new Set(), out = [];
  for (const x of items) { const k = x.title.toLowerCase().slice(0, 60); if (seen.has(k)) continue; seen.add(k); out.push(x); }
  return out;
}
async function bars(sym) {
  for (const host of ['query1', 'query2']) {
    const t = await getText('https://' + host + '.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(sym) + '?range=1y&interval=1d&includePrePost=false', 2);
    if (!t) continue;
    try { const R = JSON.parse(t).chart.result[0]; const c = R.indicators.quote[0].close; const o = []; R.timestamp.forEach((ts, i) => { if (c[i] != null && c[i] > 0) o.push({ t: ts * 1000, c: c[i] }); }); if (o.length > 60) return o; } catch { /* next */ }
  }
  return null;
}
const ema = (a, p) => { const k = 2 / (p + 1); const o = [a[0]]; for (let i = 1; i < a.length; i++) o.push(a[i] * k + o[i - 1] * (1 - k)); return o; };
function trendOf(b) {
  const c = b.map(x => x.c), n = c.length, i = n - 1, E200 = ema(c, 200), E50 = ema(c, 50);
  const r = d => n > d ? (c[i] / c[i - d] - 1) * 100 : null;
  return { px: c[i], ch1m: r(21), ch3m: r(63), above200: c[i] > E200[i], above50: c[i] > E50[i] };
}
const r1 = v => v == null ? null : Math.round(v * 10) / 10;

async function main() {
  await mkdir(OUT, { recursive: true });
  const now = Date.now(), DAY = 864e5;
  let prev = {}; try { prev = JSON.parse(await readFile(new URL('shortages.json', OUT), 'utf8')).themes || {}; } catch { /* first run */ }
  const spy = await bars('SPY'), spy3 = spy ? trendOf(spy).ch3m : null;
  const cache = {}; const get = async s => (s in cache ? cache[s] : (cache[s] = await bars(s), await sleep(250), cache[s]));
  const themes = {}; let nNews = 0;
  for (const T of SPEC) {
    const kw = new RegExp(T.kw, 'i'), all = await news(T.q); await sleep(600);
    const hits = all.filter(x => kw.test(x.title)); if (all.length) nNews++;
    const age = x => (now - x.t) / DAY;
    const n7 = hits.filter(x => age(x) <= 7).length, n14 = hits.filter(x => age(x) <= 14).length, n30 = hits.length;
    const base = Math.max(1, (n30 - n7) / (23 / 7)), surge = +(n7 / base).toFixed(2);
    const sl14 = hits.filter(x => age(x) <= 14 && SHORT_LANG.test(x.title)).length;
    let heat = 0; hits.filter(x => age(x) <= 14).forEach(x => { heat += (age(x) < 2 ? 3 : age(x) < 7 ? 2 : 1) * (UP_LANG.test(x.title) ? 1.5 : 1); });
    // price confirmation from the commodity / ETF proxy
    let price = null;
    if (T.proxy.length) {
      const ts = []; for (const s of T.proxy) { const b = await get(s); if (b) ts.push(Object.assign({ sym: s }, trendOf(b))); }
      if (ts.length) { const avg = k => { const v = ts.map(x => x[k]).filter(x => x != null); return v.length ? v.reduce((a, x) => a + x, 0) / v.length : null; };
        price = { syms: ts.map(x => x.sym), ch1m: r1(avg('ch1m')), ch3m: r1(avg('ch3m')), above200: ts.filter(x => x.above200).length > ts.length / 2 }; }
    }
    const priceUp = !!price && price.ch3m != null && price.ch3m >= 8 && price.above200, priceTurn = !!price && price.ch1m != null && price.ch1m >= 4;
    let status = null, why = '';
    if (T.shortage) {
      if (sl14 >= 3 && priceUp) { status = 'Confirmed'; why = sl14 + ' shortage headlines in 14 days and the price is up ' + price.ch3m + '% in 3 months'; }
      else if (sl14 >= 3) { status = 'Emerging'; why = sl14 + ' shortage headlines, but the price trend does not confirm yet'; }
      else if (priceUp && n14 >= 3) { status = 'Emerging'; why = 'price up ' + price.ch3m + '% in 3 months with news support, shortage language still light'; }
      else if ((surge >= 1.5 && n7 >= 3) || (priceTurn && n14 >= 2) || (sl14 >= 1 && n14 >= 3)) { status = 'Early signs'; why = surge >= 1.5 ? 'headline volume is ' + surge + 'x its recent pace' : price && priceTurn ? 'price turned up ' + price.ch1m + '% in a month' : 'first shortage mentions in the news'; }
      else if (!T.proxy.length && n14 < 3) { status = 'Quiet'; why = 'little news and no price proxy'; }
      else { status = 'Quiet'; why = 'no news surge and no price confirmation'; }
    }
    // related stocks, ranked by chart strength vs the market
    const picks = [];
    for (const s of T.picks) {
      const b = await get(s); if (!b) continue; const t = trendOf(b);
      const rs3 = t.ch3m != null && spy3 != null ? t.ch3m - spy3 : null;
      const score = (t.ch1m || 0) * 0.5 + (t.ch3m || 0) * 0.3 + (rs3 || 0) * 0.2 + (t.above200 ? 5 : -5);
      picks.push({ sym: s, px: r1(t.px), ch1m: r1(t.ch1m), ch3m: r1(t.ch3m), rs3m: r1(rs3), above200: t.above200, score: Math.round(score) });
    }
    picks.sort((a, b) => b.score - a.score);
    const ev = hits.slice().sort((a, b) => (SHORT_LANG.test(b.title) ? 1 : 0) - (SHORT_LANG.test(a.title) ? 1 : 0) || b.t - a.t).filter(x => age(x) <= 21).slice(0, 4).map(x => ({ title: x.title, src: x.src, t: Math.round(x.t / 1000), link: x.link }));
    const p0 = prev[T.id], since = p0 && p0.status === status && p0.since ? p0.since : new Date(now).toISOString().slice(0, 10);
    themes[T.id] = { status, why, prev: p0 ? p0.status : null, since, level: heat >= 12 ? 'Hot' : heat >= 6 ? 'Building' : heat > 0 ? 'Early' : 'Quiet', heat: Math.round(heat), n7, n14, n30, surge, sl14, price, picks, ev };
  }
  if (nNews === 0) { console.log('no news could be read, keeping the previous file'); process.exitCode = 1; return; }
  const res = { updated: new Date(now).toISOString(), newsThemes: nNews, themes };
  await writeFile(new URL('shortages.json', OUT), JSON.stringify(res));
  const rows = Object.entries(themes).filter(([, v]) => v.status).map(([k, v]) => k + ':' + v.status + (v.prev && v.prev !== v.status ? '(was ' + v.prev + ')' : ''));
  console.log('shortages: news read for ' + nNews + '/' + SPEC.length + ' themes · ' + rows.join(' · '));
}
main().catch(e => { console.error('shortages failed:', e && e.message); process.exitCode = 1; });
