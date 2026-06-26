// agents/developer-news/config.js — L7 Developer & national-builder news config.
//
// "Config over code" (spec §14): the SerpAPI engine, the national-builder list,
// the repeat-developer list, and the metro/scope query terms are read from
//   config/signal-sources.json → layers.L7_news
// (nationalBuilders / repeatDevelopers) and
//   config/das-icp.json → activeMetros / metros (for the geo OR-clause)
// with hard-coded fallbacks so a fresh clone (no edits) still runs.
//
// This agent re-exports the developer query LIST (built here) so fetch.js never
// hardcodes a builder name — add/disable a developer by editing signal-sources.json.
//
// PHASE-0 VERIFY: layers.L7_news.repeatDevelopers in signal-sources.json is still
// the "__SEED_FROM_PHASE_0__" placeholder. The crown-jewel repeat-developer
// queries (Danielian's recurring private developers) MUST be seeded in Phase 0
// (discovery item 2). Until then only the national builders produce queries.

'use strict';

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const CONFIG_DIR = path.join(REPO_ROOT, 'config');

function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}

const signalSources = readJson(path.join(CONFIG_DIR, 'signal-sources.json'), { layers: {} });
const icp = readJson(path.join(CONFIG_DIR, 'das-icp.json'), {});

const L7 = (signalSources.layers && signalSources.layers.L7_news) || {};

// --- SerpAPI source knobs (signal-sources.json with fallbacks) -------------
const serpapiUrl = 'https://serpapi.com/search.json';
const engine = L7.engine || 'google_news';

// PHASE-0 VERIFY: env var name. signal-sources.json declares tokenKey "SERPAPI_KEY".
// fetch.js reads process.env.SERPAPI_KEY first, then SERPAPI_API_KEY as a fallback.
// The SerpAPI key exists in the OneDrive vault but may still need to be added to
// das-leadgen.env (in …/VSCODE/keys/) as SERPAPI_KEY=... so loadEnv() exposes it.
const tokenKey = L7.tokenKey || 'SERPAPI_KEY';

// --- National builders (signal-sources.json with fallbacks) ----------------
const FALLBACK_NATIONAL = ['D.R. Horton', 'Lennar', 'Toll Brothers', 'Tri Pointe', 'Taylor Morrison', 'Brookfield'];
const nationalBuilders = (Array.isArray(L7.nationalBuilders) && L7.nationalBuilders.length)
  ? L7.nationalBuilders.slice()
  : FALLBACK_NATIONAL.slice();

// --- Repeat developers (Phase-0-seeded; placeholder is filtered out) --------
// The config ships "__SEED_FROM_PHASE_0__" until Danielian's recurring private
// developers are discovered. We strip any unseeded placeholder so it never
// becomes a literal query.
const repeatDevelopers = (Array.isArray(L7.repeatDevelopers) ? L7.repeatDevelopers : [])
  .map(s => String(s || '').trim())
  .filter(s => s && !/^__.*__$/.test(s));

// --- Geo / scope terms for the query OR-clause -----------------------------
// Built from the ICP active metros so queries track wherever Danielian is live.
// Fallback covers the spec's named markets (OC + LA + Nashville).
const METRO_QUERY_TERMS = {
  OC: ['Orange County', 'Irvine'],
  LA: ['Los Angeles'],
  NASHVILLE: ['Nashville'],
};
function geoTerms() {
  const activeMetros = (icp.activeMetros && icp.activeMetros.length) ? icp.activeMetros : ['OC', 'LA', 'NASHVILLE'];
  const terms = [];
  for (const code of activeMetros) {
    for (const t of (METRO_QUERY_TERMS[code] || [])) if (!terms.includes(t)) terms.push(t);
    // pull a couple of city names from das-icp.json metros[code].cities if present
    const cities = (icp.metros && icp.metros[code] && icp.metros[code].cities) || [];
    for (const c of cities.slice(0, 2)) {
      const name = String(c || '').trim();
      if (name && !terms.includes(name)) terms.push(name);
    }
  }
  return terms.length ? terms : ['Orange County', 'Irvine', 'Los Angeles', 'Nashville'];
}

// Product-type terms — the residential/BTR signal Danielian cares about.
const productTerms = ['apartments', 'multifamily', '"build-to-rent"', 'community'];

// --- Query builder ----------------------------------------------------------
// Builds one google_news query per developer:
//   "<developer>" (apartments OR multifamily OR "build-to-rent" OR community) (Orange County OR Irvine OR Los Angeles OR Nashville)
// developerType: 'national' | 'repeat' is carried through so fetch.js can tag records.
function buildQueries() {
  const geo = geoTerms();
  const geoClause = `(${geo.join(' OR ')})`;
  const productClause = `(${productTerms.join(' OR ')})`;
  const out = [];
  const push = (developerName, developerType) => {
    out.push({
      developerName,
      developerType,
      q: `"${developerName}" ${productClause} ${geoClause}`,
    });
  };
  for (const b of nationalBuilders) push(b, 'national');
  for (const d of repeatDevelopers) push(d, 'repeat');
  return out;
}

module.exports = {
  // source
  serpapiUrl,
  engine,
  tokenKey,
  // developer universe
  nationalBuilders,
  repeatDevelopers,
  // query construction
  productTerms,
  geoTerms,
  buildQueries,
  // network / politeness knobs
  num: 10,                 // results per query (SerpAPI &num=10)
  requestTimeoutMs: 20000, // 20s per the spec
  sleepBetweenMs: 1200,    // ~1.2s polite delay between queries (mirror news_fetch.py)
  userAgent: 'das-leadgen/developer-news (Danielian Pursuit Intelligence; +https://danielian.com)',
};
