// agents/developer-news/fetch.js — PERCEIVE for L7 (Developer & national-builder news).
//
// Ports the tech-leads scripts/news_fetch.py pattern to Node CommonJS:
//   - SerpAPI google_news GET per query (engine=google_news&gl=us&hl=en&num=10)
//   - per-query result parsing (handles flat items AND nested "stories")
//   - fail-soft: any network/parse failure logs and yields [] (never throws)
//   - date-keyed raw cache: data/output/news-cache-<YYYY-MM-DD>.json, reused if
//     today's cache already exists (skip re-fetch) unless --force
//   - polite ~1.2s sleep between queries
//
// These are DEVELOPER-ACTIVITY signals, not address-keyed pursuits: each record
// carries the developer it targeted but NO address/apn. The orchestrator's
// consolidator intentionally skips news records for address-dedup; the agent
// still WRITES its output file (the harness ACT) which the Brief generator reads
// for account dossiers. So we just emit clean, de-duplicated records.
//
// NO new npm deps — Node 20 built-in fetch only.
//
// !!! PHASE-0 VERIFY markers below flag everything that must be confirmed live in
// Phase 0 (the SERPAPI_KEY env var especially).

'use strict';

const fs = require('fs');
const path = require('path');
const config_ = require('./config');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const OUTPUT_DIR = path.join(REPO_ROOT, 'data', 'output');

// ---------------------------------------------------------------------------
// Auth — resolve the SerpAPI key from the environment (loadEnv() already ran in
// the harness before perceive()). PHASE-0 VERIFY: the key is named SERPAPI_KEY
// in signal-sources.json (tokenKey) and must be present in das-leadgen.env in
// the OneDrive key vault. SERPAPI_API_KEY is accepted as a fallback alias.
// ---------------------------------------------------------------------------
function getSerpApiKey() {
  const k = process.env.SERPAPI_KEY || process.env.SERPAPI_API_KEY;
  return (k && String(k).trim()) || null;
}

// ---------------------------------------------------------------------------
// Date-keyed cache (mirror news_fetch.py CACHE_DIR/{YYYY-MM-DD}.json).
// We cache the RAW per-query SerpAPI pull so a re-run the same day is free and
// the harness LEARN loop can still diff. Cache lives next to the agent output.
// ---------------------------------------------------------------------------
function today() { return new Date().toISOString().slice(0, 10); }
function cachePath(stamp = today()) { return path.join(OUTPUT_DIR, `news-cache-${stamp}.json`); }

function readCache(stamp = today()) {
  try {
    const p = cachePath(stamp);
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch { return null; }
}

function writeCache(payload, { stamp = today(), log } = {}) {
  try {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    fs.writeFileSync(cachePath(stamp), JSON.stringify(payload, null, 2));
    if (log) log(`cached raw news pull → ${path.relative(REPO_ROOT, cachePath(stamp))}`);
  } catch (err) {
    if (log) log(`could not write news cache (${err.message}) — continuing`);
  }
}

// ---------------------------------------------------------------------------
// Low-level: one SerpAPI google_news GET. Returns a list of parsed news items
// { headline, source, date, url, snippet }. Empty list on any failure (logged).
// Ported from fetch_news_serpapi() in news_fetch.py.
// ---------------------------------------------------------------------------
async function serpNews(query, key, { config = config_, log } = {}) {
  const params = new URLSearchParams({
    engine: config.engine,         // google_news
    q: query,
    api_key: key,
    gl: 'us',
    hl: 'en',
    num: String(config.num),       // 10
  });
  const url = `${config.serpapiUrl}?${params.toString()}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.requestTimeoutMs);
  let data;
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'accept': 'application/json', 'user-agent': config.userAgent },
    });
    if (!res.ok) {
      if (log) log(`[serpapi] HTTP ${res.status} for ${JSON.stringify(query)}`);
      return [];
    }
    data = await res.json();
  } catch (err) {
    const why = err.name === 'AbortError' ? 'timeout' : err.message;
    if (log) log(`[serpapi] request failed (${why}) for ${JSON.stringify(query)}`);
    return []; // graceful: never throw
  } finally {
    clearTimeout(timer);
  }

  // SerpAPI sometimes returns an error object instead of HTTP non-2xx.
  if (data && data.error) {
    if (log) log(`[serpapi] error for ${JSON.stringify(query)}: ${data.error}`);
    return [];
  }

  const results = (data && Array.isArray(data.news_results)) ? data.news_results : [];
  const out = [];
  for (const r of results.slice(0, config.num)) {
    // google_news returns either flat items or a nested "stories" array
    // (topic/cluster results). Mirror news_fetch.py: prefer the flat item,
    // else the first story.
    const item = (r && r.title) ? r : ((r && Array.isArray(r.stories) && r.stories[0]) || {});
    const title = String(item.title || '').trim();
    if (!title) continue;
    const srcRaw = item.source;
    const source = (srcRaw && typeof srcRaw === 'object')
      ? (srcRaw.name || '')
      : (srcRaw || '');
    out.push({
      headline: title,
      source: String(source || '').trim(),
      date: item.date || '',
      url: item.link || '',
      snippet: String(item.snippet || '').slice(0, 400), // truncate to 400 chars
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Date parsing — google_news returns strings like "06/24/2026, 07:00 AM, +0000 UTC"
// or relative ("2 days ago"). Return an ISO date (YYYY-MM-DD) if parseable, else null.
// ---------------------------------------------------------------------------
function parseNewsDate(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  // SerpAPI's "MM/DD/YYYY, HH:MM AM, +0000 UTC" form: take the leading MM/DD/YYYY.
  const m = s.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) {
    const [, mm, dd, yyyy] = m;
    const d = new Date(Date.UTC(+yyyy, +mm - 1, +dd));
    if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  }
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
  return null; // relative strings ("3 days ago") aren't reliably parseable
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// buildQueries — re-export from config so callers/tests have one source.
// ---------------------------------------------------------------------------
function buildQueries(config = config_) { return config.buildQueries(); }

// ---------------------------------------------------------------------------
// Shape one parsed SerpAPI item → the L7 raw record contract.
// ---------------------------------------------------------------------------
function toRecord(item, qmeta) {
  return {
    developerName: qmeta.developerName,   // the builder/developer the query targeted
    developerType: qmeta.developerType,   // 'national' | 'repeat' (extra context; harmless)
    headline: item.headline,
    source: item.source || null,          // publisher
    date: parseNewsDate(item.date),       // ISO if parseable, else null
    url: item.url || null,
    snippet: item.snippet || '',          // already <=400 chars
    query: qmeta.q,
    metro: null,                          // national — not metro-scoped
    projectType: null,
    isNewsSignal: true,
  };
}

// ---------------------------------------------------------------------------
// Public entrypoint used by index.js perceive().
//   { days, config, log, force }  → array of raw L7 news-signal records.
// `force` (from the orchestrator/CLI --force) bypasses today's cache.
// ---------------------------------------------------------------------------
async function fetchDeveloperNews({ days = 30, config = config_, log = () => {}, force = false } = {}) {
  const queries = buildQueries(config);
  if (!queries.length) {
    log('no developer queries built (nationalBuilders + repeatDevelopers both empty in signal-sources.json) — nothing to fetch');
    return [];
  }
  const nNational = config.nationalBuilders.length;
  const nRepeat = config.repeatDevelopers.length;
  log(`built ${queries.length} google_news queries (${nNational} national builders, ${nRepeat} repeat developers), lookback ${days}d`);
  if (!nRepeat) {
    log('note: repeatDevelopers is unseeded (signal-sources.json L7_news still has the __SEED_FROM_PHASE_0__ placeholder) — national builders only. PHASE-0 VERIFY.');
  }

  // ---- Cache: reuse today's raw pull unless --force (mirror news_fetch.py) ----
  const stamp = today();
  let rawByQuery = null;
  const cached = force ? null : readCache(stamp);
  if (cached && Array.isArray(cached.queries)) {
    log(`reusing today's news cache (${path.relative(REPO_ROOT, cachePath(stamp))}; ${cached.queries.length} queries). Use --force to re-fetch.`);
    rawByQuery = cached.queries;
  }

  // ---- Live fetch (only if no usable cache) ----------------------------------
  if (!rawByQuery) {
    const key = getSerpApiKey();
    if (!key) {
      // The single most important fail-soft path: no key ⇒ warn + [] (never throw).
      log(`WARNING: no SerpAPI key in env (looked for ${config.tokenKey} / SERPAPI_API_KEY). ` +
          `Returning 0 records. PHASE-0 VERIFY: add ${config.tokenKey}=<key> to das-leadgen.env ` +
          `in the OneDrive key vault (…/VSCODE/keys/) so loadEnv() exposes it.`);
      return [];
    }

    rawByQuery = [];
    for (let i = 0; i < queries.length; i++) {
      const qmeta = queries[i];
      const items = await serpNews(qmeta.q, key, { config, log });
      log(`  [${i + 1}/${queries.length}] ${qmeta.developerName}: ${items.length} items`);
      rawByQuery.push({
        developerName: qmeta.developerName,
        developerType: qmeta.developerType,
        q: qmeta.q,
        items,
      });
      if (i < queries.length - 1) await sleep(config.sleepBetweenMs); // polite delay
    }
    // Persist the raw pull so a same-day re-run is free.
    writeCache({ asOf: stamp, engine: config.engine, generator: 'developer-news fetch.js v1', queries: rawByQuery }, { stamp, log });
  }

  // ---- Flatten → records, dedup by url ---------------------------------------
  const seen = new Set();
  const records = [];
  let total = 0;
  for (const block of rawByQuery) {
    const qmeta = { developerName: block.developerName, developerType: block.developerType, q: block.q };
    for (const item of (block.items || [])) {
      total++;
      const rec = toRecord(item, qmeta);
      // Light dedup (no address filter): key on url when present, else
      // developer+headline so url-less items still de-duplicate.
      const key = (rec.url ? rec.url : `${rec.developerName}|${rec.headline}`).toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      records.push(rec);
    }
  }

  log(`fetched ${total} raw news items → ${records.length} unique developer-news signals`);
  return records;
}

module.exports = {
  fetchDeveloperNews,
  // helpers exported for tests / Phase-0 verification / reuse:
  serpNews,
  buildQueries,
  getSerpApiKey,
  parseNewsDate,
  readCache,
  writeCache,
  cachePath,
};
