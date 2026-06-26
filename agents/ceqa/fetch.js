// agents/ceqa/fetch.js — CEQAnet harvester (the PERCEIVE body for the L3 agent).
//
// Strategy (per spec + task): Node 20 built-in `fetch` first. CEQAnet's /Search
// endpoint answers a plain GET with query params and returns server-rendered
// HTML (there is NO JSON/OData export — `?format=json` is ignored; only
// `?OutputFormat=CSV` exists). So we GET each (documentType × county) pair with a
// server-side `StartRange`/`EndRange` date window and parse the results table.
// If `fetch` itself is unavailable/blocked, we fall back to the shared stealth
// browser. Any unreachable endpoint or unrecognized HTML shape logs a warning and
// yields [] for that query — never throws (the harness retry + learn loop owns
// emptiness).
//
// Confirmed live HTML shape (Phase-0): each result row is
//   <tr itemscope itemtype="http://schema.org/Report">
//     <td><a href="/<SCH>" ...><span itemprop="reportNumber">2026060895</span></a></td>
//     <td>...<span itemprop="articleSection">NOP </span>...</td>
//     <td itemprop="sourceOrganization">City of San Juan Capistrano</td>
//     <td><time datetime="2026-06-18" itemprop="dateCreated">6/18/2026 </time></td>
//     <td itemprop="name">Paseo Espada</td>
//   </tr>
// Project links are either `/<schNumber>` or `/Project/<id>`.

const config = require('./config');

// --- small helpers ----------------------------------------------------------
function pad2(n) { return String(n).padStart(2, '0'); }

// CEQAnet wants MM/DD/YYYY for StartRange/EndRange.
function toUsDate(d) {
  return `${pad2(d.getMonth() + 1)}/${pad2(d.getDate())}/${d.getFullYear()}`;
}

// Decode the handful of HTML entities CEQAnet emits in titles/agencies.
function decodeEntities(s) {
  return String(s || '')
    .replace(/&amp;/g, '&')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripTags(s) { return decodeEntities(String(s || '').replace(/<[^>]*>/g, ' ')); }

// Build the exact CEQAnet search URL for one (docType, county, window) query.
function buildSearchUrl(docType, county, sinceDate, untilDate) {
  const qs = new URLSearchParams({
    DocumentType: docType,
    County: county,
    StartRange: toUsDate(sinceDate),
    EndRange: toUsDate(untilDate),
  });
  return `${config.searchBase}?${qs.toString()}`;
}

// --- HTML row parser (exported helper) --------------------------------------
// Parses the CEQAnet results table into loosely-typed row objects. Resilient:
// returns [] if the table/rows aren't found.
//
// PHASE-0 VERIFY: the itemprop microdata names (reportNumber / articleSection /
// sourceOrganization / dateCreated / name) and the <tr itemtype=".../Report">
// row marker were confirmed live on 2026-06-26. If CEQAnet restyles the results
// grid, re-confirm these selectors here.
function parseRows(html) {
  const out = [];
  if (!html || typeof html !== 'string') return out;

  // Split into individual <tr ...schema.org/Report...> ... </tr> blocks.
  const rowRe = /<tr[^>]*itemtype="http:\/\/schema\.org\/Report"[^>]*>([\s\S]*?)<\/tr>/gi;
  let m;
  while ((m = rowRe.exec(html)) !== null) {
    const row = m[1];
    try {
      const rec = parseRow(row);
      if (rec) out.push(rec);
    } catch { /* skip malformed row */ }
  }
  return out;
}

function parseRow(row) {
  // SCH number (State Clearinghouse #) — primary ref.
  const sch = matchProp(row, 'reportNumber');
  // Document type token (e.g. "NOP", "EIR").
  const docType = matchProp(row, 'articleSection');
  // Lead / public agency.
  const agency = matchProp(row, 'sourceOrganization');
  // Received date — prefer the machine-readable datetime attribute.
  const dateAttr = (row.match(/<time[^>]*datetime="([^"]+)"/i) || [])[1];
  const dateText = matchProp(row, 'dateCreated');
  // Project title.
  const title = matchProp(row, 'name');

  // Detail-page link: first <a href> in the row (the SCH or /Project/<id> link).
  const href = (row.match(/<a[^>]*href="([^"]+)"/i) || [])[1] || (sch ? `/${sch}` : '');

  if (!sch && !title) return null; // unusable row

  return {
    sch: sch || null,
    docType: docType || null,
    agency: agency || null,
    date: normalizeDate(dateAttr || dateText),
    title: title || null,
    href: href || null,
  };
}

// Pull the text of <... itemprop="X" ...>TEXT</...> (handles nested <span>/<a>).
function matchProp(row, prop) {
  const re = new RegExp(`itemprop="${prop}"[^>]*>([\\s\\S]*?)<`, 'i');
  const direct = row.match(re);
  if (direct) {
    // The capture stops at the next '<'; for nested markup, fall back to a
    // broader element-scoped strip.
    const txt = decodeEntities(direct[1]);
    if (txt) return txt;
  }
  // Broader: capture the whole element that carries the itemprop, then strip.
  const elRe = new RegExp(`itemprop="${prop}"[^>]*>([\\s\\S]*?)<\\/(?:span|td|a|time)>`, 'i');
  const el = row.match(elRe);
  return el ? stripTags(el[1]) : null;
}

function normalizeDate(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  // Already ISO (yyyy-mm-dd) from the <time datetime> attribute.
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

// --- raw-record shaping ------------------------------------------------------
// Map one parsed CEQAnet row → the loosely-typed raw record the consolidator
// maps (see scripts/consolidate-lib.js toPursuitRecord).
function toRawRecord(parsed, county, metro) {
  const sch = parsed.sch;
  const title = parsed.title || '';
  const agency = parsed.agency || '';
  const dt = (parsed.docType || '').toUpperCase();

  // CEQAnet's results grid has NO street address — the location lives on the
  // detail page. Synthesize a stable address so the record survives dedup
  // (consolidate-lib drops records with no normalizedAddress AND no apn). The
  // title + lead agency is the best available locator at list level.
  // PHASE-0 VERIFY: to populate a true APN / street address, fetch the project
  // detail page (/<sch> or /Project/<id>) and parse its location block — a
  // Phase-4 enrichment, intentionally out of scope for the list harvest.
  const address = [title, agency].filter(Boolean).join(' — ') ||
    (sch ? `CEQA SCH# ${sch}` : '');

  // NOP is the pre-application environmental-scoping signal → 'ceqa-nop'.
  // Everything else (NOD/EIR/MND/NOE) is further along → 'entitlement'.
  const stage = dt === 'NOP' ? 'ceqa-nop' : 'entitlement';

  const url = absUrl(parsed.href, sch);

  return {
    address,
    apn: null,                 // CEQAnet list view carries no APN
    metro: metro || null,      // derived from county (Orange→OC, Los Angeles→LA)
    jurisdiction: agency || null,
    projectType: null,         // let the harness classify from title/description
    unitCount: null,           // harness extracts from title via danielian-fit
    stage,
    scopeText: title,          // list view has no abstract; title is the scope text
    description: title,
    title,
    ref: sch || null,          // SCH# — consolidate-lib reads ref/schNumber
    schNumber: sch || null,
    date: parsed.date || null, // received/posted date (ISO)
    url,
    developerName: agency || null, // lead agency is the only named party at list level
    county,
    documentType: dt || null,
    legislative: { densityBonus: false },
  };
}

function absUrl(href, sch) {
  if (href && /^https?:\/\//i.test(href)) return href;
  if (href) return `${config.base}${href.startsWith('/') ? '' : '/'}${href}`;
  if (sch) return `${config.base}/${sch}`;
  return config.searchBase;
}

// --- fetchers ----------------------------------------------------------------
// Try built-in fetch; on any failure return null so the caller can fall back.
async function fetchHtml(url, log) {
  if (typeof fetch !== 'function') return null; // < Node 18 — let browser handle it
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), config.http.timeoutMs);
    const res = await fetch(url, {
      headers: { 'User-Agent': config.http.userAgent, 'Accept': 'text/html' },
      redirect: 'follow', // opr.ca.gov 301 → lci.ca.gov
      signal: controller.signal,
    });
    clearTimeout(t);
    if (!res.ok) { log && log(`  fetch ${res.status} for ${url}`); return null; }
    return await res.text();
  } catch (err) {
    log && log(`  fetch error (${err.message}) for ${url}`);
    return null;
  }
}

// Fallback: load the URL through the shared stealth browser. Lazy-required so a
// missing Playwright install never breaks the primary fetch path (the repo has
// no node_modules committed; offline structural runs must still work).
async function fetchHtmlViaBrowser(url, headed, log) {
  let launchBrowser;
  try {
    ({ launchBrowser } = require('../shared/browser'));
  } catch {
    log && log('  browser fallback unavailable (shared/browser not loadable)');
    return null;
  }
  let browser;
  try {
    ({ browser } = await launchBrowser({ headed: !!headed }));
    const ctx = await browser.newContext({ userAgent: config.http.userAgent });
    const page = await ctx.newPage();
    await page.goto(url, { timeout: config.http.timeoutMs, waitUntil: 'domcontentloaded' });
    return await page.content();
  } catch (err) {
    log && log(`  browser fallback error: ${err.message.split('\n')[0]}`);
    return null;
  } finally {
    if (browser) { try { await browser.close(); } catch { /* ignore */ } }
  }
}

// --- public API --------------------------------------------------------------
/**
 * Harvest CEQAnet filings across the configured document types × counties for
 * the lookback window, returning loosely-typed raw records.
 *
 * @param {object}   opts
 * @param {number}   [opts.days]      lookback window in days (default 120)
 * @param {number}   [opts.maxPages]  cap on (docType×county) queries issued
 * @param {object}   [opts.config]    config override (defaults to ./config)
 * @param {Function} [opts.log]       logger
 * @param {boolean}  [opts.headed]    run the browser fallback headed
 * @returns {Promise<object[]>} raw records (never throws)
 */
async function fetchCeqaFilings(opts = {}) {
  const cfg = opts.config || config;
  const log = opts.log || (() => {});
  const days = Number.isFinite(opts.days) ? opts.days : 120;
  const untilDate = new Date();
  const sinceDate = new Date(Date.now() - days * 86400000);

  const docTypes = cfg.documentTypes || config.documentTypes;
  const counties = cfg.counties || config.counties;
  const metroOf = cfg.countyToMetro || config.countyToMetro;

  // Build the query matrix (docType × county), capped by maxPages if given.
  const queries = [];
  for (const county of counties) {
    for (const docType of docTypes) queries.push({ docType, county });
  }
  const capped = Number.isFinite(opts.maxPages) && opts.maxPages > 0
    ? queries.slice(0, opts.maxPages)
    : queries;

  log(`CEQAnet harvest: ${capped.length} quer${capped.length === 1 ? 'y' : 'ies'} ` +
      `(${docTypes.length} doc types × ${counties.length} counties), ` +
      `${days}d window ${toUsDate(sinceDate)}–${toUsDate(untilDate)}`);

  const all = [];
  const seen = new Set(); // dedup by SCH# within this run (same SCH appears across counties/types)

  for (const { docType, county } of capped) {
    const url = buildSearchUrl(docType, county, sinceDate, untilDate);

    let html = await fetchHtml(url, log);
    if (html == null) {
      log(`  ${docType}/${county}: built-in fetch unavailable — trying browser fallback`);
      html = await fetchHtmlViaBrowser(url, opts.headed, log);
    }
    if (html == null) {
      log(`  ${docType}/${county}: unreachable — skipping (graceful)`);
      continue; // graceful degradation: no throw
    }

    const rows = parseRows(html);
    if (rows.length === 0) {
      // Either genuinely 0 results or the HTML shape changed. Distinguish by the
      // results-count line CEQAnet always prints.
      const countLine = (html.match(/([\d,]+)\s+document\(s\)\s+found/i) || [])[1];
      if (countLine && countLine !== '0') {
        log(`  ${docType}/${county}: WARNING — ${countLine} documents reported but 0 rows parsed. ` +
            `CEQAnet results HTML may have changed (see parseRows PHASE-0 VERIFY).`);
      } else {
        log(`  ${docType}/${county}: 0 results`);
      }
      continue;
    }

    const metro = metroOf[county] || null;
    let kept = 0;
    for (const parsed of rows) {
      const key = parsed.sch || `${parsed.title}|${parsed.date}`;
      if (seen.has(key)) continue;
      seen.add(key);
      all.push(toRawRecord(parsed, county, metro));
      kept++;
    }
    log(`  ${docType}/${county}: ${rows.length} rows, ${kept} new`);
  }

  log(`CEQAnet harvest complete: ${all.length} raw records`);
  return all;
}

module.exports = { fetchCeqaFilings, parseRows, buildSearchUrl, toRawRecord };
