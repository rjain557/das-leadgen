// agents/deeds/scraper.js — PERCEIVE for the L4 deeds agent.
//
// Drives OC RecorderWorks (cr.ocgov.com/recorderworks → occlerkrecorder.gov
// RecorderWorksInternet, ASP.NET WebForms, expired TLS cert) to harvest recent
// recorded documents, then keeps the ones that are deed/trust types involving a
// developer/LLC party. The grantee on a GRANT DEED / construction Deed-of-Trust
// becomes developer.rawName downstream (consolidate-lib normalizeDeveloper).
//
// Contract with the harness: export fetchDeedRecords({ days, maxPages, headed,
// config, log }) → array of raw records. NEVER throws past a hard browser
// failure (the harness retries); on a dead portal / zero results it returns []
// so the run degrades to a clean empty rather than hanging or crashing.
//
// PHASE-0 VERIFY notes are inline at each live-portal assumption.

const path = require('path');
const fs = require('fs');
const { launchBrowser } = require('../shared/browser');

const DEBUG_DIR = path.resolve(__dirname, '..', '..', 'artifacts', 'debug');

function noop() {}

// "GRANT DEED" → "Grant Deed" for a readable documentType when no target matched.
function titleCase(s) {
  return String(s || '').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()).trim();
}

function fmtDate(d) {
  return `${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}/${d.getFullYear()}`;
}

function isoDate(raw) {
  if (!raw) return null;
  const d = new Date(String(raw).trim());
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

async function debugScreenshot(page, name) {
  try {
    if (!fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR, { recursive: true });
    await page.screenshot({ path: path.join(DEBUG_DIR, `deeds-${name}-${Date.now()}.png`), fullPage: false });
  } catch { /* screenshots are best-effort */ }
}

// Set an ASP.NET date input reliably. page.fill()/type() proved flaky on this
// masked WebForms field; assigning .value + dispatching input/change/blur sticks.
// PHASE-0 VERIFY: date field ids are SearchByDocType1_FromDate / _ToDate.
async function setDateField(page, selector, value) {
  await page.evaluate((arg) => {
    const el = document.querySelector(arg.selector);
    if (!el) return false;
    el.focus();
    el.value = arg.value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));
    return true;
  }, { selector, value });
}

// Tick the target document-type checkboxes by their doctypename attribute. The
// portal REQUIRES at least one type selected before a Document-Type search will
// run (a no-types submit silently returns no grid). The server-side type filter
// is loose (a date search still returns other types too — verified live), so we
// also keep the broad client-side type filter downstream. Clicking the input
// fires the widget's OnSetSelection handler that records the choice in VIEWSTATE.
// PHASE-0 VERIFY: checkbox inputs have class .grType and attr doctypename=LABEL.
async function selectDocTypes(page, targets) {
  const wanted = targets.map((t) => String(t.match).toUpperCase());
  return page.evaluate((labels) => {
    const want = new Set(labels);
    const boxes = Array.from(document.querySelectorAll('input.grType'));
    let n = 0;
    for (const b of boxes) {
      const name = String(b.getAttribute('doctypename') || '').toUpperCase().trim();
      if (want.has(name) && !b.checked) { b.click(); n++; }
    }
    return n;
  }, wanted).catch(() => 0);
}

// Check EXACTLY ONE doc type by its doctypename, unchecking any other box first
// (so a fresh per-type search isn't polluted by a previously selected type).
// Returns true if the box was found+checked.
async function selectSingleDocType(page, matchName) {
  const want = String(matchName).toUpperCase().trim();
  return page.evaluate((wantName) => {
    const boxes = Array.from(document.querySelectorAll('input.grType'));
    for (const b of boxes) if (b.checked) b.click(); // clear all
    const target = boxes.find((b) => String(b.getAttribute('doctypename') || '').toUpperCase().trim() === wantName);
    if (!target) return false;
    if (!target.checked) target.click();
    return target.checked;
  }, want).catch(() => false);
}

// Dismiss the RecorderWorks popups (disclaimer on load, "exceeded N records"
// after a search). Best-effort; clicking a hidden/absent OK button is a no-op.
async function dismissPopups(page, cfg) {
  for (const sel of (cfg.portal.popupOkButtons || [])) {
    try {
      const btn = page.locator(sel);
      if ((await btn.count()) > 0 && (await btn.first().isVisible())) {
        await btn.first().click();
        await page.waitForTimeout(1000);
      }
    } catch { /* not present — fine */ }
  }
}

// Actively wait for the results grid to appear after a search, dismissing the
// post-search "exceeded N records" popup as it polls, with a hard cap so we
// never hang. Returns 'rows' | 'none' | 'timeout'.
async function waitForResults(page, cfg) {
  const deadline = Date.now() + cfg.search.waitAfterSearch + cfg.search.pageSettleTimeoutMs;
  while (Date.now() < deadline) {
    await page.waitForTimeout(1500);
    await dismissPopups(page, cfg);
    const state = await page.evaluate(() => {
      if (document.querySelector('tr.searchResultRow')) return 'rows';
      const txt = document.body.innerText || '';
      if (/No (Records|Results)|not found|0\s+Result\(s\)/i.test(txt)) return 'none';
      return '';
    }).catch(() => '');
    if (state === 'rows' || state === 'none') return state;
  }
  return 'timeout';
}

// Parse every result row currently rendered in the grid. Selects by CLASS, since
// the WebForms grid emits DUPLICATE ids (id="row1" + recDate/docTypeGrtGrtee
// repeat per row). Returns one entry per document with all of its party/type
// containers. VERIFIED LIVE 2026-06-29:
//   row              = tr.searchResultRow (5 <td>: checkbox, docNum, combined,
//                      recDate, pages)
//   document number  = the 2nd <td> (plain text, NO id) — id-suffix selectors do
//                      NOT match it
//   combined cell    = td[id*=docTypeGrtGrtee], holds one .docTypeGrtGrteeContainer
//                      per bundled instrument; each container has
//                      .GrtContainer (grantor <p>s), .GrteeContainer (grantee
//                      <p>s, MAY be multiple), .GrGrteeContainer, .DocTypeContainer
//   recording date   = td[id*=recDate]  (M/D/YYYY)
//   pages            = td[id*=numOfPages]
async function parseResultRows(page) {
  return page.evaluate(() => {
    const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
    // Join all <p> under a container (rows can list several grantors/grantees).
    const joinPs = (c, sel) => Array.from(c.querySelectorAll(sel + ' p'))
      .map((p) => clean(p.textContent)).filter(Boolean).join('; ');
    const rows = Array.from(document.querySelectorAll('tr.searchResultRow'));
    const out = [];
    for (const r of rows) {
      const tds = Array.from(r.children).filter((el) => el.tagName === 'TD');
      // Document number = 2nd <td> (index 1); fall back to any 20########-looking text.
      let documentNumber = clean(tds[1] && tds[1].textContent);
      if (!/^\d{6,}$/.test(documentNumber)) {
        const m = clean(r.textContent).match(/\b(20\d{2}0\d{6,})\b/);
        documentNumber = m ? m[1] : documentNumber;
      }
      if (!documentNumber) continue;

      const combined = r.querySelector('[id*="docTypeGrtGrtee"]') || tds[2];
      const containers = combined
        ? Array.from(combined.querySelectorAll('.docTypeGrtGrteeContainer')).map((c) => ({
            grantor: joinPs(c, '.GrtContainer'),
            grantee: joinPs(c, '.GrteeContainer'),
            grgrtee: joinPs(c, '.GrGrteeContainer'),
            type: clean(c.querySelector('.DocTypeContainer') && c.querySelector('.DocTypeContainer').textContent),
          }))
        : [];

      // Recording date: prefer the dedicated cell, else any M/D/YYYY td.
      const recEl = r.querySelector('[id*="recDate"]');
      let recordingDate = clean(recEl && recEl.textContent);
      if (!/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(recordingDate)) {
        recordingDate = '';
        for (const td of tds) {
          const t = clean(td.textContent);
          if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(t)) { recordingDate = t; break; }
        }
      }
      const pagesEl = r.querySelector('[id*="numOfPages"]');
      const pages = clean(pagesEl && pagesEl.textContent);

      out.push({ documentNumber, recordingDate, pages, containers });
    }
    return out;
  }).catch(() => []);
}

// Read the total result count the grid reports ("<N> Result(s)" text).
async function readResultCount(page, reSource) {
  return page.evaluate((src) => {
    const m = (document.body.innerText || '').match(new RegExp(src, 'i'));
    if (!m) return null;
    const n = parseInt(String(m[1]).replace(/[^0-9]/g, ''), 10);
    return Number.isFinite(n) ? n : null;
  }, reSource).catch(() => null);
}

// Go to page N via the WebForms paging JS (search.OnPage('N','.booking')). Waits
// for the grid to refresh (first doc number changes) with a hard timeout so we
// never hang. Returns true if it believes the page advanced.
async function gotoPage(page, n, firstDocBefore, cfg, log) {
  const ok = await page.evaluate((pageNum) => {
    try {
      if (window.search && typeof window.search.OnPage === 'function') {
        window.search.OnPage(String(pageNum), '.booking');
        return true;
      }
    } catch { /* fall through */ }
    // Fallback: click a paging cell whose onclick targets this page.
    const cells = Array.from(document.querySelectorAll('.pagingCell, td[onclick*="OnPage"]'));
    const cell = cells.find((c) => (c.getAttribute('onclick') || '').includes(`OnPage('${pageNum}'`));
    if (cell) { cell.click(); return true; }
    return false;
  }, n).catch(() => false);
  if (!ok) return false;

  // Wait until the first rendered doc number differs from before (grid replaced).
  // The doc number is the 2nd <td> of the first result row (it has no id).
  try {
    await page.waitForFunction(
      (prev) => {
        const r = document.querySelector('tr.searchResultRow');
        if (!r) return false;
        const tds = Array.from(r.children).filter((el) => el.tagName === 'TD');
        const cur = tds[1] ? tds[1].textContent.trim() : '';
        return cur && cur !== prev;
      },
      firstDocBefore,
      { timeout: cfg.search.pageSettleTimeoutMs },
    );
  } catch {
    if (log) log(`  page ${n}: grid did not refresh within ${cfg.search.pageSettleTimeoutMs}ms — stopping pagination`);
    return false;
  }
  await dismissPopups(page, cfg); // a page change can re-trigger the cap popup
  await page.waitForTimeout(cfg.search.waitBetweenPages);
  return true;
}

// Does a party string contain a developer/investment-entity keyword?
function hasDevKeyword(name, keywords) {
  const t = ` ${String(name || '').toLowerCase()} `;
  return keywords.some((k) => t.includes(k));
}

// Is this party a bank / lender / title / government entity (not a developer)?
function isInstitution(name, instKeywords) {
  const t = ` ${String(name || '').toLowerCase()} `;
  return instKeywords.some((k) => t.includes(k));
}

// A party is a "developer" when it has a developer/entity keyword and is NOT a
// financial-institution / government / title entity.
function looksLikeDeveloper(name, cfg) {
  // back-compat: allow passing the keyword array directly (used by tests/probes)
  const devKw = Array.isArray(cfg) ? cfg : cfg.developerEntityKeywords;
  const instKw = Array.isArray(cfg) ? [] : (cfg.institutionKeywords || []);
  if (!hasDevKeyword(name, devKw)) return false;
  if (isInstitution(name, instKw)) return false;
  return true;
}

// Doc-type prefixes that turn a deed type into a LENDER/admin instrument (an
// assignment / amendment / substitution / subordination of a deed of trust), NOT
// a fresh grant deed or construction deed of trust. e.g. "ASGT TRUST DEED" and
// "AMD GRANT DEED" must NOT match the "TRUST DEED" / "GRANT DEED" targets.
const NON_DEED_PREFIXES = /^(ASGT|ASSIGNMENT|AMD|AMEND|SUB|SUBSTITUTION|SUBORD|CTF|ABSTR|PARTIAL|CORR|RERECORD|RE-RECORD)\b/;

// Match a grid doc-type label to a target deed/trust type. Requires the label to
// BE the target (exact) or END with it not preceded by a lender/admin prefix, so
// "GRANT DEED" and "CORP GRANT DEED" match but "ASGT/AMD GRANT DEED" do not.
// Returns the matching config entry or null.
function matchDocType(typeLabel, targets) {
  const t = String(typeLabel || '').toUpperCase().trim();
  if (!t) return null;
  if (NON_DEED_PREFIXES.test(t)) return null;
  for (const target of targets) {
    const m = target.match.toUpperCase();
    if (t === m || t.endsWith(' ' + m) || t.startsWith(m + ' ') || t === m) return target;
  }
  return null;
}

// Turn one parsed grid row into a raw pursuit record IF a developer/LLC is a
// party (the task's #1 signal). A single recording bundles several instruments,
// each rendered as a .docTypeGrtGrteeContainer. We pick the CONTAINER that is a
// target deed/trust type (GRANT DEED → developer = grantee; TRUST DEED →
// developer = grantor/trustor), and read the developer party from the side the
// config says is the signal for that type. If no target-deed container has a
// developer party, we fall back to an acquisition companion (acceptance /
// agreement) whose GRANTEE is a developer (a builder accepting title). Pure
// person-to-person and lender/agency rows are dropped.
function toRawRecord(row, cfg, today) {
  const targets = cfg.targetDocTypes;
  const containers = (row.containers || []).filter((c) => c.type || c.grantor || c.grantee);
  const allTypes = [...new Set(containers.map((c) => c.type).filter(Boolean))];

  // Developer party for a single container, per the type's `developerParty`.
  const partyFor = (container, target) => {
    const side = target && target.developerParty === 'grantor' ? container.grantor : container.grantee;
    const other = target && target.developerParty === 'grantor' ? container.grantee : container.grantor;
    // Prefer the designated side; if it isn't a developer entity but the other
    // side is, use the other (covers builder-as-grantor on a resale grant deed).
    if (looksLikeDeveloper(side, cfg)) return { name: side, isGrantee: !(target && target.developerParty === 'grantor') };
    if (looksLikeDeveloper(other, cfg)) return { name: other, isGrantee: !!(target && target.developerParty === 'grantor') };
    if (looksLikeDeveloper(container.grgrtee, cfg)) return { name: container.grgrtee, isGrantee: false };
    return null;
  };

  const companion = (cfg.acquisitionCompanionTypes || []).map((s) => s.toUpperCase());
  const excluded = (cfg.excludeDocTypes || []).map((s) => s.toUpperCase());
  const isCompanionType = (t) => companion.some((ct) => String(t || '').toUpperCase().includes(ct));
  const isExcludedType = (t) => excluded.some((e) => String(t || '').toUpperCase().includes(e));

  // The recording's headline instrument = the highest-quality TARGET deed type
  // present in the rendered containers (label the record by it even if the
  // developer party rides on a bundled companion container).
  let headline = null; // { target, container }
  for (const c of containers) {
    const target = matchDocType(c.type, targets);
    if (!target) continue;
    if (!headline || rank(target.leadQuality) > rank(headline.target.leadQuality)) {
      headline = { target, container: c };
    }
  }
  // The grid often renders ONLY a bundled companion container for a recording
  // even though it WAS returned by (and contains) the searched deed type. If we
  // know which type was searched, treat that as the headline so the record is
  // labeled by the real instrument ("Grant Deed" / "Trust Deed"), not the
  // incidental companion ("Acceptance"). The companion container still supplies
  // the developer party below.
  const searchedTarget = row._searchedType
    ? targets.find((t) => t.match.toUpperCase() === String(row._searchedType).toUpperCase())
    : null;

  // KEEP GATE. The recording must carry a real target deed (grant/trust) OR an
  // acquisition companion (acceptance/agreement). A row whose instruments are
  // ENTIRELY lender/financing-lifecycle types (ASSIGNMENT LSE/RNT, ASGT TRUST
  // DEED, reconveyance, lien, …) is a lender instrument, not a pursuit — drop
  // it. (A TRUST DEED search returns these bundled; this is the key filter.)
  const hasCompanion = containers.some((c) => isCompanionType(c.type));
  if (!headline && !hasCompanion) return null;
  const allExcluded = allTypes.length > 0 && allTypes.every((t) => isExcludedType(t) && !isCompanionType(t));
  if (allExcluded) return null;

  // Find the developer party. Prefer the headline target container's signal
  // side; else an acquisition-companion container whose developer is the GRANTEE
  // (a builder accepting title). We do NOT pull a developer off an excluded
  // lender container.
  let chosen = null; // { container, target, party }
  if (headline) {
    const p = partyFor(headline.container, headline.target);
    if (p) chosen = { container: headline.container, target: headline.target, party: p };
  }
  if (!chosen) {
    // Any container whose developer party is the GRANTEE (a builder/LLC taking
    // or accepting title) — covers a developer riding on a bundled
    // ACCEPTANCE/AGREEMENT companion alongside the searched deed.
    for (const c of containers) {
      const devGrantee = looksLikeDeveloper(c.grantee, cfg) ? c.grantee
        : (looksLikeDeveloper(c.grgrtee, cfg) ? c.grgrtee : null);
      if (devGrantee) { chosen = { container: c, target: headline ? headline.target : null, party: { name: devGrantee, isGrantee: true } }; break; }
    }
  }

  // No DEVELOPER/LLC party anywhere on the recording → drop. This agent surfaces
  // developer-name signals only; pure person-to-person home sales (no entity
  // party) are not pursuits and are intentionally filtered out here (the grantee
  // / grantor on a kept record is always a developer-looking entity).
  if (!chosen) return null;

  const { container, party } = chosen;
  // Label by the headline target deed type if one was rendered, else by the
  // type that was actually SEARCHED (the recording contains it even when the
  // grid only renders a bundled companion container), else the container's own
  // type. This makes a builder-acquisition row read "Grant Deed", not "Acceptance".
  const labelTarget = (headline && headline.target) || searchedTarget || chosen.target;
  const documentType = labelTarget ? labelTarget.label : titleCase(container.type || 'Deed');
  // leadQuality: from the target deed type (high = construction trust deed); a
  // companion-only acquisition with no known target type is 'medium'.
  const leadQuality = labelTarget ? labelTarget.leadQuality : 'medium';

  // Surface BOTH parties from the chosen container (grantee is the headline
  // developer signal for grant deeds; grantor for trust deeds). cleanForOutput-
  // style fields below.
  const grantee = container.grantee || '';
  const grantor = container.grantor || '';

  // The recorder index exposes no APN/address; use the globally-unique document
  // number as the dedup anchor so consolidate-lib (which keys on normalizedAddress
  // + apn and DROPS records with NEITHER, and would otherwise collapse all
  // empty-key deeds into one) keeps each deed as its own record with a stable id.
  // The doc number is NOT parcel-formatted, so downstream APN-format checks skip
  // it and ATTOM (address-keyed + key-gated) never mis-fires on it.
  // PHASE-0 VERIFY: RecorderWorks grid + quick-detail expose no parcel number.
  return {
    metro: 'OC',
    apn: row.documentNumber,           // dedup anchor (see note above)
    grantee,                           // grant deed: the developer taking title
    grantor,                           // trust deed: the developer borrowing
    developerName: party.name,         // explicit hint for normalizeDeveloper
    developerParty: party.isGrantee ? 'grantee' : 'grantor',
    developerIsGrantee: !!party.isGrantee, // true = acquisition signal (land buy)
    documentType,                      // human label (e.g. "Grant Deed")
    documentTypesRaw: allTypes,        // all grid types on this recording
    documentNumber: row.documentNumber,
    recordingDate: isoDate(row.recordingDate) || row.recordingDate || null,
    pages: row.pages ? parseInt(row.pages, 10) || null : null,
    amount: null,                      // not in the recorder index
    address: '',                       // resolved later from grantee/ATTOM
    projectType: null,                 // harness/consolidator classifies
    leadQuality,
    scopeText: [documentType].concat(allTypes).join(' '), // text for the classifier
    url: cfg.portal.baseUrl,
    harvestedAt: today,
  };
}

function rank(quality) {
  return quality === 'high' ? 3 : quality === 'medium' ? 2 : 1;
}

// MAIN PERCEIVE: harvest deed/trust records over the lookback window.
async function fetchDeedRecords(options = {}) {
  const { days, maxPages, headed = false, config: cfg } = options;
  const log = options.log || noop;
  const daysBack = Number.isFinite(days) ? days : cfg.search.defaultDaysBack;
  const pageCap = Math.max(1, Math.min(Number.isFinite(maxPages) ? maxPages : cfg.search.maxPages, cfg.search.maxPages));
  const today = new Date().toISOString().slice(0, 10);

  const fromDate = new Date(Date.now() - daysBack * 86400000);
  const toDate = new Date();

  let browser;
  const rawRows = [];
  try {
    const launched = await launchBrowser({ headed });
    browser = launched.browser;
    log(`browser driver: ${launched.driver}`);

    const context = await browser.newContext({
      viewport: cfg.browser.viewport,
      userAgent: cfg.browser.userAgent,
      ignoreHTTPSErrors: true, // cr.ocgov.com / occlerkrecorder.gov: expired cert
    });
    const page = await context.newPage();
    page.setDefaultTimeout(cfg.browser.timeout);
    // Auto-dismiss any JS validation/alert dialog so it can never block the run.
    page.on('dialog', async (d) => {
      log(`  portal dialog: ${String(d.message()).slice(0, 120)}`);
      try { await d.accept(); } catch { /* ignore */ }
    });

    log(`Navigating to ${cfg.portal.searchUrl} (lookback ${daysBack}d: ${fmtDate(fromDate)} → ${fmtDate(toDate)})`);
    try {
      await page.goto(cfg.portal.searchUrl, { waitUntil: 'domcontentloaded', timeout: cfg.search.navTimeoutMs });
    } catch (e) {
      log(`Portal navigation failed: ${e.message} — returning empty (graceful)`);
      await debugScreenshot(page, 'nav-failed');
      return [];
    }
    await page.waitForTimeout(cfg.search.waitAfterNav);
    log(`Loaded: ${page.url()}`);

    // Dismiss the disclaimer / alert popup shown on load.
    await dismissPopups(page, cfg);

    // Activate the Document Type search tab.
    await page.click(cfg.portal.docTypeTab, { timeout: 8000 }).catch(() => {
      log('  could not click Document Type tab (continuing — fields may already be present)');
    });
    await page.waitForTimeout(cfg.search.waitAfterNav > 2500 ? 2500 : 1500);

    // Confirm the date fields exist (portal-shape sanity check).
    const haveForm = await page.locator(cfg.portal.docTypeFromDate).count().catch(() => 0);
    if (!haveForm) {
      log('Document Type search form not found — portal may have changed. Returning empty (graceful).');
      await debugScreenshot(page, 'no-form');
      return [];
    }

    // Search EACH target doc type SEPARATELY. Searching them together produces a
    // mixed grid where TRUST DEED contributes mostly bundled lender-assignment
    // rows on the early pages, starving GRANT DEED of page budget; a per-type
    // search gives each its own pages and lets us label rows by the searched
    // instrument. We re-fill the form per type for clean state (the page is
    // already on the Document Type tab from the initial load).
    for (let ti = 0; ti < cfg.targetDocTypes.length && rawRows.length < cfg.search.maxResults; ti++) {
      const target = cfg.targetDocTypes[ti];
      if (ti > 0) {
        // Return to a fresh search form for the next type.
        await page.click(cfg.portal.docTypeTab, { timeout: 8000 }).catch(() => {});
        await page.waitForTimeout(1500);
        if ((await page.locator(cfg.portal.docTypeFromDate).count().catch(() => 0)) === 0) {
          // Hard reload if the tab didn't re-expose the form.
          await page.goto(cfg.portal.searchUrl, { waitUntil: 'domcontentloaded', timeout: cfg.search.navTimeoutMs }).catch(() => {});
          await page.waitForTimeout(cfg.search.waitAfterNav);
          await dismissPopups(page, cfg);
          await page.click(cfg.portal.docTypeTab, { timeout: 8000 }).catch(() => {});
          await page.waitForTimeout(2000);
        }
      }

      // Recording-date range.
      await setDateField(page, cfg.portal.docTypeFromDate, fmtDate(fromDate));
      await setDateField(page, cfg.portal.docTypeToDate, fmtDate(toDate));

      // Select ONLY this doc type (clears any other checked box first).
      const ok = await selectSingleDocType(page, target.match);
      if (!ok) {
        log(`  "${target.match}" checkbox not found — skipping this type`);
        await debugScreenshot(page, `no-doctype-${target.match.replace(/\s+/g, '-')}`);
        continue;
      }
      log(`--- ${target.label} ("${target.match}") ---`);
      await page.waitForTimeout(800); // let date blur + VIEWSTATE settle before submit

      await page.click(cfg.portal.docTypeSearchBtn, { timeout: 8000 }).catch((e) => log(`  search button click: ${e.message}`));
      const gridState = await waitForResults(page, cfg);
      if (gridState !== 'rows') {
        log(`  no results grid (${gridState}) for ${target.label}`);
        continue;
      }
      await dismissPopups(page, cfg); // clear the "exceeded N records" popup
      await page.waitForTimeout(1200);

      const total = await readResultCount(page, cfg.portal.resultCountRe.source);
      const estPages = total ? Math.ceil(total / cfg.search.resultsPerPage) : null;
      log(`  results: ${total != null ? total : 'unknown'}${estPages ? ` (~${estPages} pages)` : ''}; scanning up to ${pageCap} page(s)`);

      // Parse page 1, then paginate up to the cap. Tag each row with the searched
      // type so labeling/quality is correct even when the grid renders only a
      // bundled companion container for the row.
      let pageNum = 1;
      let firstParse = await parseResultRows(page);
      const tag = (rows) => rows.map((r) => Object.assign(r, { _searchedType: target.match }));
      if (firstParse.length === 0) { log(`  ${target.label}: 0 rows on page 1`); continue; }
      rawRows.push(...tag(firstParse));
      log(`  page 1: ${firstParse.length} rows (running total ${rawRows.length})`);

      while (pageNum < pageCap && rawRows.length < cfg.search.maxResults) {
        const firstDocBefore = firstParse[0] ? firstParse[0].documentNumber : '';
        const next = pageNum + 1;
        const advanced = await gotoPage(page, next, firstDocBefore, cfg, log);
        if (!advanced) { log(`  pagination stopped at page ${pageNum}`); break; }
        pageNum = next;
        firstParse = await parseResultRows(page);
        if (firstParse.length === 0) { log(`  page ${pageNum}: 0 rows — stopping`); break; }
        rawRows.push(...tag(firstParse));
        log(`  page ${pageNum}: ${firstParse.length} rows (running total ${rawRows.length})`);
      }
    }

    if (rawRows.length === 0) {
      log('No result rows across all doc types (zero matches in window, or portal changed). Returning empty (graceful).');
      await debugScreenshot(page, 'no-rows');
      return [];
    }
  } catch (err) {
    // Hard failure: log + screenshot, then rethrow so the harness retry loop can
    // decide. The harness ultimately writes [] / exits non-zero on total failure.
    log(`Scraper error: ${err.message}`);
    if (browser) { try { const p = (await browser.contexts()[0]?.pages())?.[0]; if (p) await debugScreenshot(p, 'error'); } catch { /* ignore */ } }
    throw err;
  } finally {
    if (browser) { try { await browser.close(); } catch { /* ignore */ } }
  }

  // REASON (deed-specific): dedup by document number, keep deed/trust types with
  // a developer/LLC party, map to raw pursuit records.
  const seen = new Set();
  const records = [];
  for (const row of rawRows) {
    if (seen.has(row.documentNumber)) continue;
    seen.add(row.documentNumber);
    const rec = toRawRecord(row, cfg, today);
    if (rec) records.push(rec);
  }
  log(`Parsed ${rawRows.length} unique docs → ${records.length} developer deed/trust records`);
  return records;
}

module.exports = { fetchDeedRecords, debugScreenshot, toRawRecord, matchDocType, looksLikeDeveloper };
