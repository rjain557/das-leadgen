// resolve-ca-sos.js — FREE California Secretary of State "bizfile" resolver.
//
// Given an opaque owner-of-record LLC/LP (the entity that holds a development
// site), resolve it to a REAL human — the registered agent for service of
// process — straight from CA SOS bizfile Online (https://bizfileonline.sos.ca.gov).
// Public records, free, no API key, no credentials. This is the fallback for the
// opaque local SPE/holding LLCs that Apollo/Hunter can't resolve.
//
// ─── HOW IT WORKS (reverse-engineered live, 2026-06-26) ────────────────────────
// bizfile is a React SPA backed by an internal JSON API, fronted by Imperva
// (Incapsula) bot protection. A cold `fetch` (node, curl, even a cookie-jar
// replay) is 403'd by Imperva's "reese84" JS sensor. The ONLY reliable path is a
// real (patchright/stealth) Chromium that:
//   1. navigates to /search/business  → Imperva JS challenge runs in-browser, the
//      React app bootstraps (anonymous /api/Auth returns 200 — no login needed for
//      SEARCH), and the search box (input.search-input) mounts.
//   2. types the name + Enter         → the app issues the genuine XHR
//      POST /api/Records/businesssearch  which Imperva ALLOWS (real browser
//      request w/ correct fingerprint). We capture the response via
//      page.waitForResponse — NOT page.evaluate(fetch), which Imperva 403s.
//
// PHASE-0 VERIFY: search request body schema (the React app sends this exact
// shape — only SEARCH_VALUE / SEARCH_FILTER_TYPE_ID:"0" / SEARCH_TYPE_ID:"1" are
// load-bearing; the rest are defaults the API tolerates):
//   POST /api/Records/businesssearch
//   { SEARCH_VALUE, SEARCH_FILTER_TYPE_ID:"0", SEARCH_TYPE_ID:"1", FILING_TYPE_ID:"",
//     STATUS_ID:"", FILING_DATE:{start:null,end:null}, CORPORATION_BANKRUPTCY_YN:false,
//     CORPORATION_LEGAL_PROCEEDINGS_YN:false, OFFICER_OBJECT:{FIRST_NAME,MIDDLE_NAME,
//     LAST_NAME}, NUMBER_OF_FEMALE_DIRECTORS:"99", NUMBER_OF_UNDERREPRESENTED_DIRECTORS:"99",
//     COMPENSATION_FROM:"", COMPENSATION_TO:"", SHARES_YN:false, OPTIONS_YN:false,
//     BANKRUPTCY_YN:false, FRAUD_YN:false, LOANS_YN:false, AUDITOR_NAME:"" }
//
// PHASE-0 VERIFY: search response shape (this is the FREE data we harvest):
//   { template:[…], rows:{ "<ID>": { TITLE:["NAME (FILE_NO)"], ID, FILING_DATE,
//     FORMED_IN, AGENT:"<registered agent name>", STATUS:"Active|Terminated|…",
//     ENTITY_TYPE:"Limited Liability Company - CA|…", STANDING } , … } }
//   NOTE: `rows` is an OBJECT keyed by entity ID, NOT an array.
//
// PHASE-0 VERIFY / LIMITATION: the full Filing Detail drawer (agent ADDRESS +
// principals/managers/officers + mailing address) lives at
//   GET /api/FilingDetail/business/{ID}/false
// but that endpoint is LOGIN-GATED — anonymous access 403s and the UI bounces to
// /auth (Sign In). The managers/members list is otherwise only in the Statement
// of Information PDF (often scanned/image). Per the brief we DO NOT build login or
// OCR — we surface the registered AGENT (a real human for the ~half of SPEs that
// self-agent) + entity metadata from the free search response, and flag the rest
// as commercial-agent-shielded. The agent name alone is the activation contact.
//
// House style: CommonJS, Node 20 fetch (unused here — we go through the browser),
// graceful degradation (NEVER throws — logs + returns null), caching, polite
// rate-limiting (>=500ms between live searches), no new npm deps, no secrets.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { launchBrowser } = require('../agents/shared/browser');

const REPO_ROOT = path.resolve(__dirname, '..');
const CACHE_FILE = path.join(REPO_ROOT, 'data', 'output', 'ca-sos-cache.json');
const BIZFILE_SEARCH_URL = 'https://bizfileonline.sos.ca.gov/search/business';
const SEARCH_API = '/api/Records/businesssearch';
const SOURCE_BASE = 'https://bizfileonline.sos.ca.gov/search/business';
const MIN_GAP_MS = 600;           // polite spacing between live searches (>500ms)
const NAV_TIMEOUT = 60000;
const RESP_TIMEOUT = 25000;

// ─── Commercial registered-agent services (NOT a useful human contact) ─────────
// Case-insensitive. When the agent matches one of these, the entity is
// "agent-shielded" — we keep the agent for the record but mark isCommercial:true
// and do NOT surface it as a person.
const COMMERCIAL_AGENT_PATTERNS = [
  /\bc\s*t\s*corporation\b/i,                 // CT Corporation / C T Corporation
  /\bct\s*corporation\s*system\b/i,
  /corporation service company/i,             // CSC
  /\bcsc\b/i,
  /lawyers incorporating service/i,           // CSC's CA d/b/a
  /national registered agents/i,
  /\bregistered agents?,?\s*inc\.?\b/i,        // Registered Agents Inc
  /registered agent solutions/i,
  /cogency global/i,
  /\bcogency\b/i,
  /\bincorp\b/i,                              // InCorp
  /incorporating services/i,
  /northwest registered agent/i,
  /\blegalzoom\b/i,
  /harvard business services/i,
  /united states corporation agents/i,
  /capitol corporate services/i,
  /\bparacorp\b/i,
  /paralegal corporation/i,
  /spiegel\s*&?\s*utrera/i,
];

function isCommercialAgent(name) {
  const n = String(name || '').trim();
  if (!n) return false;
  return COMMERCIAL_AGENT_PATTERNS.some(re => re.test(n));
}

// bizfile placeholders for "no agent on file" — these are NOT real people and
// must never be surfaced as a contact.
const AGENT_PLACEHOLDER_RE = /^(no agent|none|n\/?a|not? available|tbd|unknown|pending|--+)\.?$/i;
function isPlaceholderAgent(name) {
  const n = String(name || '').trim();
  return !n || AGENT_PLACEHOLDER_RE.test(n);
}

// A usable human agent = present, not a placeholder, not a commercial service.
function isHumanAgent(name) {
  return !isPlaceholderAgent(name) && !isCommercialAgent(name);
}

// ─── Name normalisation (cache key + similarity) ───────────────────────────────
// IMPORTANT: drop ALL punctuation FIRST so acronyms with internal periods join up
// ("K.H.I.K." → "khik") instead of fragmenting into single letters, and so legal
// suffixes spelled "L.P."/"L.L.C." don't leave stray "l"/"p" tokens. THEN strip
// whole-word legal suffixes.
const LEGAL_SUFFIX_RE = /\b(llc|inc|incorporated|corp|corporation|company|co|lp|ltd|llp)\b/g;
function normName(n) {
  return String(n || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')   // strip punctuation first (joins K.H.I.K → k h i k → handled below)
    .replace(/\s+/g, ' ')
    .replace(/\bk h i k\b/g, 'khik') // (defensive, harmless) common spaced-acronym collapse
    .replace(LEGAL_SUFFIX_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Alphanumeric squash (no spaces) — lets an acronym form match a spelled form
// even when token counts differ ("khik" vs "k h i k" both squash to "khik").
function squash(n) {
  return normName(n).replace(/\s+/g, '');
}

// Similarity (0..1): max of token-overlap and squash containment. Robust to
// acronyms, embedded periods, and legal-suffix noise.
function nameSimilarity(a, b) {
  const ta = new Set(normName(a).split(' ').filter(Boolean));
  const tb = new Set(normName(b).split(' ').filter(Boolean));
  let tokenSim = 0;
  if (ta.size && tb.size) {
    let inter = 0;
    for (const t of ta) if (tb.has(t)) inter++;
    tokenSim = inter / Math.max(ta.size, tb.size);
  }
  const sa = squash(a), sb = squash(b);
  let squashSim = 0;
  if (sa && sb) {
    if (sa === sb) squashSim = 1;
    else if (sa.includes(sb) || sb.includes(sa)) {
      squashSim = Math.min(sa.length, sb.length) / Math.max(sa.length, sb.length);
    }
  }
  return Math.max(tokenSim, squashSim);
}

// ─── Cache ─────────────────────────────────────────────────────────────────────
function loadCache() {
  try { return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch { return {}; }
}
function saveCache(c) {
  try { fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true }); fs.writeFileSync(CACHE_FILE, JSON.stringify(c, null, 2)); } catch { /* ignore */ }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── Browser executable resolution ─────────────────────────────────────────────
// The repo pins patchright/playwright 1.61 which expects Chromium build 1228, but
// the host commonly has earlier full builds (…/chromium-1223/chrome-win64). The
// shared launchBrowser() will throw "Executable doesn't exist" on that mismatch.
// So we discover an installed FULL chromium (headed-capable — headless_shell is
// detected harder by Imperva) and pass it as executablePath. Falls back to the
// default (no override) so a correctly-installed environment still works.
function findInstalledChromium() {
  const local = process.env.PLAYWRIGHT_BROWSERS_PATH
    || path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'ms-playwright');
  try {
    if (!fs.existsSync(local)) return null;
    const dirs = fs.readdirSync(local)
      .filter(d => /^chromium-\d+$/.test(d))
      .sort((a, b) => parseInt(b.split('-')[1], 10) - parseInt(a.split('-')[1], 10)); // newest first
    for (const d of dirs) {
      for (const sub of ['chrome-win64', 'chrome-win']) {
        const exe = path.join(local, d, sub, 'chrome.exe');
        if (fs.existsSync(exe)) return exe;
      }
      // mac/linux layouts (best-effort; CA SOS work is Windows-first)
      for (const rel of ['chrome-mac/Chromium.app/Contents/MacOS/Chromium', 'chrome-linux/chrome']) {
        const exe = path.join(local, d, rel);
        if (fs.existsSync(exe)) return exe;
      }
    }
  } catch { /* ignore */ }
  return null;
}

// ─── Shared warm browser session (one Imperva-solved page reused for all names) ──
let _session = null; // { browser, context, page }

async function ensureSession() {
  if (_session) return _session;
  const exe = findInstalledChromium();
  if (exe) process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH = exe; // hint only; we pass directly below
  // launchBrowser does the patchright→stealth→playwright fallback; we layer the
  // executablePath override on top so the build-version mismatch can't brick us.
  let browser, driver;
  try {
    const launched = await launchBrowserWithExe(exe);
    browser = launched.browser; driver = launched.driver;
  } catch (e) {
    console.warn(`  [ca-sos] browser launch failed (${e.message}). bizfile resolution unavailable this run.`);
    return null;
  }
  try {
    const context = await browser.newContext({
      viewport: { width: 1366, height: 900 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    });
    const page = await context.newPage();
    await page.goto(BIZFILE_SEARCH_URL, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
    // Wait for the SPA to clear Imperva + mount the search box.
    await page.waitForSelector('input.search-input', { timeout: 30000 });
    await page.waitForTimeout(2000); // let /api/Auth + settings settle
    _session = { browser, context, page, driver };
    console.log(`  [ca-sos] bizfile session ready (driver=${driver}).`);
    return _session;
  } catch (e) {
    console.warn(`  [ca-sos] bizfile SPA did not become ready (${e.message}). Resolution unavailable.`);
    try { await browser.close(); } catch { /* ignore */ }
    return null;
  }
}

// launchBrowser() can't take executablePath, so replicate its 3-tier fallback
// here with the override. Returns { browser, driver }.
async function launchBrowserWithExe(exe) {
  const force = (process.env.DAS_BROWSER_DRIVER || process.env.BBC_BROWSER_DRIVER || '').toLowerCase();
  const tryOrder = force ? [force] : ['patchright', 'stealth', 'playwright'];
  const launchArgs = { headless: false }; // headed: Imperva reese84 passes; headless_shell does not
  if (exe) launchArgs.executablePath = exe;
  let lastErr;
  for (const driver of tryOrder) {
    try {
      if (driver === 'patchright') {
        const { chromium } = require('patchright');
        return { browser: await chromium.launch(launchArgs), driver: 'patchright' };
      }
      if (driver === 'stealth') {
        const { chromium } = require('playwright-extra');
        const StealthPlugin = require('puppeteer-extra-plugin-stealth');
        chromium.use(StealthPlugin());
        return { browser: await chromium.launch(launchArgs), driver: 'stealth' };
      }
      if (driver === 'playwright') {
        const { chromium } = require('playwright');
        return { browser: await chromium.launch(launchArgs), driver: 'playwright' };
      }
    } catch (err) { lastErr = err; }
  }
  // Last resort: let the shared launcher try its own resolution (no exe override).
  try { return await launchBrowser({ headed: true }); } catch { /* ignore */ }
  throw new Error(`no driver succeeded: ${lastErr && lastErr.message || 'unknown'}`);
}

async function closeSession() {
  if (_session && _session.browser) { try { await _session.browser.close(); } catch { /* ignore */ } }
  _session = null;
}

// ─── Parse a captured /api/Records/businesssearch response ─────────────────────
// rows is an object keyed by ID. Each row: { TITLE:["NAME (FILENO)"], ID, AGENT,
// STATUS, ENTITY_TYPE, FILING_DATE, FORMED_IN, STANDING }.
function rowsFromBody(body) {
  let j;
  try { j = JSON.parse(body); } catch { return []; }
  const rows = j && j.rows;
  if (!rows || typeof rows !== 'object') return [];
  return Object.values(rows).map(r => {
    const titleRaw = Array.isArray(r.TITLE) ? r.TITLE.join(' ') : String(r.TITLE || '');
    const m = titleRaw.match(/^(.*?)\s*\(([^)]+)\)\s*$/);
    return {
      entityName: (m ? m[1] : titleRaw).trim(),
      entityNumber: m ? m[2].trim() : '',
      id: r.ID,
      agent: String(r.AGENT || '').trim(),
      status: String(r.STATUS || '').trim(),
      entityType: String(r.ENTITY_TYPE || '').trim(),
      registrationDate: String(r.FILING_DATE || '').trim(),
      jurisdiction: String(r.FORMED_IN || '').trim(),
      standing: String(r.STANDING || '').trim(),
    };
  });
}

// Pick the best matching row for the query name.
// Preference: exact-ish name match → Active status → most recent filing.
function pickBestRow(rows, queryName) {
  if (!rows.length) return null;
  const scored = rows.map(r => {
    const sim = nameSimilarity(queryName, r.entityName);
    const activeBonus = /active/i.test(r.status) ? 0.25 : 0;
    // recency: parse mm/dd/yyyy
    let recency = 0;
    const dm = r.registrationDate.match(/(\d{2})\/(\d{2})\/(\d{4})/);
    if (dm) recency = (parseInt(dm[3], 10) - 1990) / 1000; // tiny tiebreaker
    return { r, score: sim + activeBonus + recency, sim };
  }).sort((a, b) => b.score - a.score);
  return scored[0];
}

// ─── Public: resolveEntity(name, opts?) ────────────────────────────────────────
// Returns:
//   { entityName, entityNumber, status, entityType, registrationDate,
//     agent: { name, address, isCommercial } | null,
//     principals: [{ name, title, address }],   // [] — login/PDF gated (see limitation)
//     jurisdiction, sourceUrl } | null
//
// opts: { cache?, noCache?, minMatch? } (minMatch default 0.34 token-overlap)
async function resolveEntity(name, opts = {}) {
  const raw = String(name || '').trim();
  if (!raw) return null;
  const key = normName(raw);
  if (!key) return null;

  const cache = opts.cache || loadCache();
  if (!opts.noCache && Object.prototype.hasOwnProperty.call(cache, key)) {
    return cache[key];
  }

  // Default 0.55: rejects partial/wrong-company matches (e.g. "WEST ST
  // INVESTMENTS" vs "WEST COAST STRATEGIC INVESTMENTS" = 0.50) while admitting
  // exact + acronym + minor-suffix matches (KHIK 1.0, ORANGE 702 0.82). A missing
  // contact is better than a wrong one for a client-facing ABM brief.
  const minMatch = typeof opts.minMatch === 'number' ? opts.minMatch : 0.55;
  let result = null;
  try {
    result = await searchLive(raw, minMatch);
  } catch (e) {
    // NEVER throw — log + degrade.
    console.warn(`  [ca-sos] resolveEntity("${raw}") error: ${e.message}`);
    result = null;
  }

  // Cache both hits and clean misses (null) so re-runs are cheap. A null caches a
  // "looked, found nothing" — acceptable; clear ca-sos-cache.json to force re-look.
  cache[key] = result;
  if (!opts.cache) saveCache(cache); // only auto-persist when we own the cache
  return result;
}

// Perform one live search against the warm session and shape the result.
async function searchLive(raw, minMatch) {
  const session = await ensureSession();
  if (!session) return null;
  const { page } = session;

  // Polite spacing.
  const now = Date.now();
  if (searchLive._last && now - searchLive._last < MIN_GAP_MS) {
    await sleep(MIN_GAP_MS - (now - searchLive._last));
  }

  // Drive the real search box and capture the genuine XHR (Imperva-allowed).
  let body = null, status = 0;
  try {
    await page.fill('input.search-input', '');
    await page.fill('input.search-input', raw);
    const waitResp = page.waitForResponse(
      r => r.url().includes(SEARCH_API) && r.request().method() === 'POST',
      { timeout: RESP_TIMEOUT }
    ).catch(() => null);
    await page.keyboard.press('Enter');
    const resp = await waitResp;
    if (resp) { status = resp.status(); try { body = await resp.text(); } catch { /* ignore */ } }
  } finally {
    searchLive._last = Date.now();
  }

  if (status !== 200 || !body) {
    if (status && status !== 200) console.warn(`  [ca-sos] search "${raw}" → HTTP ${status} (Imperva/transient); skipping.`);
    return null;
  }

  const rows = rowsFromBody(body);
  if (!rows.length) return null;

  const best = pickBestRow(rows, raw);
  if (!best) return null;

  // Guard against weak fuzzy matches (e.g. "WEST ST INVESTMENTS" matching
  // "WEST COAST STRATEGIC INVESTMENTS"): require a minimum token overlap, else
  // treat as not-found rather than surfacing a wrong company.
  if (best.sim < minMatch) {
    console.warn(`  [ca-sos] best match for "${raw}" was "${best.r.entityName}" (similarity ${best.sim.toFixed(2)} < ${minMatch}); treating as not-found.`);
    return null;
  }

  const r = best.r;
  const agentName = r.agent || '';
  // Treat bizfile "NO AGENT"/"N/A" placeholders as no agent at all.
  const agent = (agentName && !isPlaceholderAgent(agentName))
    ? { name: agentName, address: '', isCommercial: isCommercialAgent(agentName) }
    : null;

  return {
    entityName: r.entityName,
    entityNumber: r.entityNumber,
    status: r.status,
    entityType: r.entityType,
    registrationDate: r.registrationDate,
    standing: r.standing,
    agent,                       // { name, address:'' (detail login-gated), isCommercial }
    principals: [],              // login/PDF-gated — see LIMITATION note at top
    jurisdiction: r.jurisdiction || 'CALIFORNIA',
    matchSimilarity: Number(best.sim.toFixed(2)),
    sourceUrl: `${SOURCE_BASE}?SearchType=BUSINESS&SearchCriteria=${encodeURIComponent(r.entityName)}`,
    source: 'ca-sos',
    resolvedAt: new Date().toISOString(),
  };
}

// Batch helper (keeps one warm session for the whole list, closes at the end).
async function resolveMany(names = [], opts = {}) {
  const cache = opts.cache || loadCache();
  const out = {};
  try {
    for (const name of names) {
      out[name] = await resolveEntity(name, { ...opts, cache });
    }
  } finally {
    saveCache(cache);
    if (!opts.keepOpen) await closeSession();
  }
  return out;
}

module.exports = {
  resolveEntity,
  resolveMany,
  closeSession,
  isCommercialAgent,
  isPlaceholderAgent,
  isHumanAgent,
  normName,
  nameSimilarity,
  // cache accessors (let callers share one cache object across many lookups)
  loadCacheFile: loadCache,
  saveCacheFile: saveCache,
  // exported for tests / reuse
  rowsFromBody,
  pickBestRow,
  COMMERCIAL_AGENT_PATTERNS,
};

// ─── CLI: node scripts/resolve-ca-sos.js "KHIK CO LLC" [more names…] ────────────
if (require.main === module) {
  const args = process.argv.slice(2).filter(a => a && !a.startsWith('--'));
  const noCache = process.argv.includes('--no-cache');
  if (!args.length) {
    console.log('Usage: node scripts/resolve-ca-sos.js "ENTITY NAME" ["ANOTHER NAME" …] [--no-cache]');
    process.exit(0);
  }
  (async () => {
    const cache = loadCache();
    for (const name of args) {
      const r = await resolveEntity(name, { cache, noCache });
      console.log(`\n=== ${name} ===`);
      if (!r) { console.log('  → not found / unresolved (clean null)'); continue; }
      console.log(`  Entity:   ${r.entityName} (${r.entityNumber})`);
      console.log(`  Status:   ${r.status}  |  Type: ${r.entityType}  |  Formed: ${r.jurisdiction}  |  Filed: ${r.registrationDate}`);
      if (r.agent) {
        console.log(`  Agent:    ${r.agent.name}  ${r.agent.isCommercial ? '[COMMERCIAL registered-agent service — entity is agent-shielded]' : '[REAL HUMAN — usable contact]'}`);
      } else {
        console.log('  Agent:    (none listed)');
      }
      console.log(`  Match:    similarity ${r.matchSimilarity}`);
      console.log(`  Source:   ${r.sourceUrl}`);
    }
    saveCache(cache);
    await closeSession();
    process.exit(0);
  })().catch(e => { console.error('[ca-sos] fatal', e.message); closeSession().finally(() => process.exit(1)); });
}
