// Divergence — daily institutional holdings scan (SEC Form 13F).
// For each tracked fund: finds the latest two 13F-HR filings, reads the holdings tables, maps issuer names
// to tickers and writes data/institutions.json in the same shape the app already uses.
// 13F reports are quarterly and filed up to 45 days after quarter end, so most days nothing is new:
// the job only downloads a fund again when it has filed something new. Node 20+, no dependencies.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
const OUT = new URL('data/', pathToFileURL(process.cwd() + '/'));
// The SEC blocks automated requests whose User-Agent has no contact email (HTTP 403). Set the SEC_CONTACT secret to your own email to replace the default.
const UA = { 'User-Agent': 'Divergence research ' + (process.env.SEC_CONTACT || 'chartmind@users.noreply.github.com'), 'Accept-Encoding': 'gzip, deflate' };
let lastStatus = 0;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const KEEP = 400; // largest holdings kept per filing
// [cik, short name, manager, text the SEC entity name must contain (guards against a wrong CIK)]
const FUNDS = [
  ['1067983', 'Berkshire Hathaway', 'Warren Buffett', 'BERKSHIRE'], ['1336528', 'Pershing Square', 'Bill Ackman', 'PERSHING'], ['1350694', 'Bridgewater', 'Ray Dalio', 'BRIDGEWATER'],
  ['1536411', 'Duquesne', 'Stanley Druckenmiller', 'DUQUESNE'], ['1656456', 'Appaloosa', 'David Tepper', 'APPALOOSA'], ['1029160', 'Soros Fund', 'George Soros', 'SOROS'],
  ['1040273', 'Third Point', 'Dan Loeb', 'THIRD POINT'], ['1061768', 'Baupost', 'Seth Klarman', 'BAUPOST'], ['1079114', 'Greenlight', 'David Einhorn', 'GREENLIGHT'],
  ['1167483', 'Tiger Global', 'Chase Coleman', 'TIGER GLOBAL'], ['1135730', 'Coatue', 'Philippe Laffont', 'COATUE'], ['1697748', 'ARK Investment', 'Cathie Wood', 'ARK'],
  ['921669', 'Icahn', 'Carl Icahn', 'ICAHN'], ['1061165', 'Lone Pine', 'Stephen Mandel', 'LONE PINE'], ['1103804', 'Viking Global', 'Andreas Halvorsen', 'VIKING'], ['1649339', 'Scion', 'Michael Burry', 'SCION'],
  ['102909', 'Vanguard', 'Index giant', 'VANGUARD'], ['1364742', 'BlackRock', 'Index giant', 'BLACKROCK'], ['93751', 'State Street', 'Index giant', 'STATE STREET'],
  ['315066', 'Fidelity (FMR)', 'Mutual fund giant', 'FMR'], ['1113169', 'T. Rowe Price', 'Mutual fund giant', 'PRICE'], ['902219', 'Wellington', 'Mutual fund giant', 'WELLINGTON'],
  ['1423053', 'Citadel Advisors', 'Ken Griffin', 'CITADEL'], ['1037389', 'Renaissance Tech', 'Quant fund', 'RENAISSANCE'], ['1179392', 'Two Sigma', 'Quant fund', 'TWO SIGMA'],
  ['1273931', 'Millennium', 'Izzy Englander', 'MILLENNIUM'], ['1009207', 'D. E. Shaw', 'Quant fund', 'SHAW'], ['1167557', 'AQR', 'Cliff Asness', 'AQR'],
  ['1603466', 'Point72', 'Steve Cohen', 'POINT72'], ['1791786', 'Elliott', 'Paul Singer', 'ELLIOTT'], ['895421', 'Morgan Stanley', 'Bank', 'MORGAN STANLEY'],
  ['886982', 'Goldman Sachs', 'Bank', 'GOLDMAN'], ['19617', 'JPMorgan', 'Bank', 'JPMORGAN'], ['1374170', 'Norges Bank', 'Norway sovereign fund', 'NORGES'],
  ['1595888', 'Jane Street', 'Trading firm', 'JANE STREET'], ['1446194', 'Susquehanna', 'Trading firm', 'SUSQUEHANNA'], ['934639', 'Maverick', 'Lee Ainslie', 'MAVERICK'],
  ['1138995', 'Glenview', 'Larry Robbins', 'GLENVIEW'], ['1541617', 'Altimeter', 'Brad Gerstner', 'ALTIMETER']
].map(([cik, short, mgr, chk]) => ({ cik, short, mgr, chk }));

const NM_AB = { FINL: 'FINANCIAL', BK: 'BANK', INTL: 'INTERNATIONAL', AMER: 'AMERICA', AMERN: 'AMERICAN', PPTYS: 'PROPERTIES', SVCS: 'SERVICES', MGMT: 'MANAGEMENT', PETE: 'PETROLEUM', RES: 'RESOURCES', TECHNOLOGIES: 'TECH', TECHNOLOGY: 'TECH', TECHNOLOGIE: 'TECH', SYS: 'SYSTEMS', COMMUNICATIONS: 'COMM', COMMUNICATN: 'COMM', HLTH: 'HEALTH', HEALTHCARE: 'HEALTH', PHARMACEUTICALS: 'PHARMA', PHARMACEUTICAL: 'PHARMA', MFG: 'MANUFACTURING', ENTMT: 'ENTERTAINMENT', ENTERPRISES: 'ENTERPRISE', LABS: 'LABORATORIES', INDS: 'INDUSTRIES', BANCORPORATION: 'BANCORP', SOLUTIONS: 'SOLUTION', PRODS: 'PRODUCTS', ELEC: 'ELECTRIC', CHEM: 'CHEMICAL', MTRS: 'MOTORS', MTR: 'MOTOR', NATL: 'NATIONAL', GEN: 'GENERAL', SVC: 'SERVICE', CMNTY: 'COMMUNITY', WHSL: 'WHOLESALE', STORES: 'STORE', INVT: 'INVESTMENT', RLTY: 'REALTY', INS: 'INSURANCE', HOTELS: 'HOTEL', RESORTS: 'RESORT', PWR: 'POWER', SCIENCES: 'SCIENCE', SEMICONDUCTOR: 'SEMI', SEMICONDUCTORS: 'SEMI', DEVICES: 'DEVICE', INSTRS: 'INSTRUMENTS', AIRLS: 'AIRLINES', BRANDS: 'BRAND' };
const NM_DROP = new Set(['INC', 'CORP', 'CORPORATION', 'CO', 'COS', 'COMPANY', 'COMPANIES', 'LTD', 'LIMITED', 'PLC', 'NV', 'SA', 'AG', 'SE', 'HLDGS', 'HLDG', 'HOLDINGS', 'HOLDING', 'GROUP', 'GRP', 'THE', 'NEW', 'DEL', 'LP', 'LLC', 'CL', 'CLASS', 'COM', 'SHS', 'ORD', 'ADR', 'SPONSORED', 'SPON', 'INCORPORATED', 'ADS', 'REIT']);
function nmNorm(s) { return String(s || '').toUpperCase().replace(/\/[A-Z]{2,3}\/?$/, '').replace(/&/g, ' AND ').replace(/[^A-Z0-9 ]+/g, ' ').split(/\s+/).filter(w => w && w.length > 0).map(w => NM_AB[w] || w).filter(w => !NM_DROP.has(w) && !(w.length === 1 && /[A-C]/.test(w))).join(' '); }
const F13_RE = {}; ['putcall', 'cusip', 'nameofissuer', 'value', 'sshprnamt'].forEach(t => { F13_RE[t] = new RegExp('<(?:\\w+:)?' + t + '>([^<]*)<', 'i'); });
function parse13f(xml) {
  const out = {};
  (xml.match(/<(?:\w+:)?infotable>[\s\S]*?<\/(?:\w+:)?infotable>/gi) || []).forEach(s => {
    const f = t => { const m = s.match(F13_RE[t]); return m ? m[1].trim() : ''; };
    if (f('putcall')) return;
    const c = f('cusip').toUpperCase(); if (!c) return;
    const o = out[c] = out[c] || [c, f('nameofissuer'), 0, 0];
    o[2] += +f('value') || 0; o[3] += +f('sshprnamt') || 0;
  });
  return Object.values(out);
}

// If the SEC refuses the GitHub runner (HTTP 403), the job switches to the r.jina.ai relay, the same one the app uses in the browser.
let viaJina = false;
const pace = () => sleep(viaJina ? 1500 : 220);
async function get(url, tries = 3, html = false) {
  for (let t = 0; t < tries; t++) {
    try {
      const r = await fetch(viaJina ? 'https://r.jina.ai/' + url : url, { headers: viaJina ? (html ? { 'X-Return-Format': 'html' } : {}) : UA });
      lastStatus = r.status;
      if (r.status === 403 && !viaJina) { console.log('SEC answered 403 for the runner, switching to the relay'); viaJina = true; t--; continue; }
      if (r.status === 429) { await sleep(10000 * (t + 1)); continue; }
      if (!r.ok) return null;
      return await r.text();
    } catch (e) { await sleep(2000 * (t + 1)); }
  }
  return null;
}
const jget = async u => { const t = await get(u); await pace(); if (!t) return null; const a = t.indexOf('{'); if (a < 0) return null; try { return JSON.parse(t.slice(a, t.lastIndexOf('}') + 1)); } catch { return null; } };

async function tickerMaps() {
  const j = await jget('https://www.sec.gov/files/company_tickers.json'); if (!j) { console.log('company_tickers.json failed, last HTTP status ' + lastStatus); return null; }
  const M = {}, C = {}, W = {};
  for (const k of Object.keys(j)) { const x = j[k]; if (!x || !x.ticker) continue; const n = nmNorm(x.title); if (!n) continue; if (!M[n]) { M[n] = x.ticker.replace('.', '-'); const w0 = n.split(' ')[0]; (W[w0] = W[w0] || []).push(n); } const c = n.replace(/ /g, ''); if (!C[c]) C[c] = x.ticker.replace('.', '-'); }
  return { M, C, W };
}
function tickerFor(T, name) {
  const n = nmNorm(name); if (!n) return null;
  if (T.M[n]) return T.M[n];
  const c = n.replace(/ /g, ''); if (T.C[c]) return T.C[c];
  const w = n.split(' '), cand = T.W[w[0]] || [];
  if (cand.length && cand.length < 400) for (let L = w.length - 1; L >= 1; L--) { const p = w.slice(0, L).join(' '); if (p.length < 4) break; const hit = cand.filter(x => x === p || x.indexOf(p + ' ') === 0); if (hit.length === 1) return T.M[hit[0]]; if (hit.length > 1) break; }
  return null;
}
async function holdings(cik, acc, T) {
  const dir = 'https://www.sec.gov/Archives/edgar/data/' + cik + '/' + acc.replace(/-/g, '') + '/';
  const ix = await jget(dir + 'index.json'); const items = ix && ix.directory && ix.directory.item ? ix.directory.item : [];
  const xmlF = items.filter(i => /\.xml$/i.test(i.name) && !/primary_doc/i.test(i.name)).sort((a, b) => (+b.size || 0) - (+a.size || 0))[0];
  if (!xmlF) return null;
  const t = await get(dir + xmlF.name, 3, true); await pace(); if (!t) return null;
  const rows = parse13f(t).sort((a, b) => b[2] - a[2]).slice(0, KEEP);
  rows.forEach(r => { r[4] = tickerFor(T, r[1]); });
  return rows;
}

async function main() {
  await mkdir(OUT, { recursive: true });
  let old = {}; try { old = JSON.parse(await readFile(new URL('institutions.json', OUT), 'utf8')); } catch { /* first run */ }
  const prevF = old.funds || {}, T = await tickerMaps();
  if (!T) { console.log('institutions: ticker list unavailable, keeping the previous file'); process.exitCode = 1; return; }
  const funds = {}, fresh = [], skipped = []; let checked = 0;
  for (const f of FUNDS) {
    const sub = await jget('https://data.sec.gov/submissions/CIK' + f.cik.padStart(10, '0') + '.json');
    if (!sub || !sub.filings) { if (prevF[f.cik]) funds[f.cik] = prevF[f.cik]; skipped.push(f.short + ' (no data)'); continue; }
    if (String(sub.name || '').toUpperCase().indexOf(f.chk) < 0) { skipped.push(f.short + ' (SEC name "' + sub.name + '" does not match)'); continue; }
    checked++;
    const R = sub.filings.recent, fl = [];
    R.form.forEach((x, k) => { if (x === '13F-HR' && fl.length < 2) fl.push({ acc: R.accessionNumber[k], filed: R.filingDate[k], period: R.reportDate[k] }); });
    if (!fl.length) { skipped.push(f.short + ' (no 13F-HR)'); continue; }
    const o = prevF[f.cik];
    if (o && o.acc === fl[0].acc) { funds[f.cik] = o; continue; }
    const cur = await holdings(f.cik, fl[0].acc, T); if (!cur || !cur.length) { if (o) funds[f.cik] = o; skipped.push(f.short + ' (holdings unreadable)'); continue; }
    const prev = fl[1] ? (o && o.acc === fl[1].acc ? o.hold : await holdings(f.cik, fl[1].acc, T)) : null;
    funds[f.cik] = { name: sub.name, short: f.short, mgr: f.mgr, acc: fl[0].acc, filed: fl[0].filed, period: fl[0].period, prevPeriod: fl[1] ? fl[1].period : null, hold: cur, prev: prev || null };
    fresh.push(f.short + ' (' + fl[0].filed + ')');
  }
  if (!checked) { console.log('institutions: no fund could be read, keeping the previous file'); process.exitCode = 1; return; }
  const res = { updated: new Date().toISOString(), funds, list: FUNDS.map(f => ({ cik: f.cik, short: f.short, mgr: f.mgr })) };
  await writeFile(new URL('institutions.json', OUT), JSON.stringify(res));
  console.log('institutions: ' + Object.keys(funds).length + '/' + FUNDS.length + ' funds · new filings ' + (fresh.length ? fresh.join(', ') : 'none') + (skipped.length ? ' · skipped: ' + skipped.join('; ') : ''));
}
main().catch(e => { console.error('institutions failed:', e && e.message); process.exitCode = 1; });
