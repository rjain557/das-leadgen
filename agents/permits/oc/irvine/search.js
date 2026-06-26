// Irvine — Custom ASP.NET permit portal (Hyland/CSG pmPermit system)
// Portal: https://permits.cityofirvine.org/irvinepermits/
// Form POSTs to: Default.asp?Build=PM.pmPermit.ResultsList
//
// Field names confirmed by browser inspection (02-2026):
//   Mine                               = N (all permits, not just mine)
//   pmPermit..APPROVAL_STATE           = pending|issued|approved|final|* (all)
//   pmPermit..PERMIT_TYPE_CODE         = permit type code (select dropdown)
//   pmPermit..APPLICATION_DATE         = date, supports QBE (e.g. >01/01/2022)
//   pmPermit..PermitAddr               = street address filter
//   Button                             = submit ("Search for Permits")
//
// Results table columns: Permit#, App. Date, Street Address, Type, Description, Map, Lot
// Permit number format: 00870216-RNEW

const config = require('./config');
// Irvine lives at agents/permits/oc/irvine → shared is three levels up.
// PHASE-0: BBC_PERMIT_TYPES below target luxury SFR; retarget the permit-type
// filter to multifamily/mixed-use/ADU per config/das-icp.json before going live.
const { isDanielianFit: isBurkhartFit, isLikelyRecent } = require('../../../shared/danielian-fit');

// Permit types for Burkhart Brothers default run.
// NOTE: rra/rbp/rbpd/gpre return "too many records" without a very tight date (>01/01/2025).
// They are excluded from the default to keep runs fast and reliable.
// Use --date-from ">01/01/2025" if you want to add rra back.
// NOTE: 'rnew' (Residential New SFD) excluded — these are already under construction per Kurtis.
// We only want pre-construction leads (demo/plan check stage).
const BBC_PERMIT_TYPES = [
  { code: 'cdrd', label: 'Building Demo PC' },
  { code: 'rra',  label: 'Residential Remodel/Addition PC' },
  { code: 'rbpr', label: 'Res Alt/Add/2nd Story Deck Permit' },
  { code: 'dem',  label: 'Whole Building Demolition Permit' },
];

function defaultDateFrom() {
  // Rolling 90-day window. The Irvine portal returns "too many records" when
  // the date window grows wide enough that any permit type exceeds the
  // server-side cap — even with per-status retries. A rolling 90 days is the
  // longest window observed (2026-04-28) that consistently completes for
  // rra/rbpr without retries. BBC wants pre-construction leads, which surface
  // within this window anyway.
  const d = new Date();
  d.setDate(d.getDate() - 90);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `>${mm}/${dd}/${d.getFullYear()}`;
}

async function searchPermits(page, options = {}) {
  const {
    permitTypes = BBC_PERMIT_TYPES,
    dateFrom = defaultDateFrom(),
    address = '',
    maxPages = config.search.maxPages,
  } = options;

  const allResults = [];
  const seen = new Set();

  console.log(`Navigating to ${config.portal.name} permit search (date filter: ${dateFrom})...`);

  // Bound every Playwright op so a stalled portal can't hang the agent
  // forever. Individual ops that pass an explicit timeout still win.
  page.setDefaultTimeout(60000);

  for (let i = 0; i < permitTypes.length; i++) {
    const permitType = permitTypes[i];
    // Pause between searches to avoid server rate-limiting
    if (i > 0) await page.waitForTimeout(3000);
    console.log(`  Searching: ${permitType.code} (${permitType.label})...`);
    const typeResults = await searchByType(page, permitType.code, dateFrom, address, maxPages);
    let added = 0;
    for (const r of typeResults) {
      if (!seen.has(r.permitNumber)) {
        seen.add(r.permitNumber);
        allResults.push(r);
        added++;
      }
    }
    console.log(`    → ${typeResults.length} found, ${added} new`);
  }

  console.log(`Total permits fetched: ${allResults.length}`);
  return allResults;
}

async function searchByType(page, typeCode, dateFrom, address, maxPages) {
  const results = await _searchByTypeWithDate(page, typeCode, dateFrom, address, maxPages);

  // If "too many records", retry with the 'pending' status only. BBC wants
  // pre-construction leads, which sit in pending plan check; the previous
  // approach of also retrying issued + approved tripled the per-type latency
  // and frequently still hit the cap on every status, hanging the run.
  if (results.length === 0 && results._tooMany) {
    console.log(`    Retrying ${typeCode} with status=pending (BBC scope)...`);
    const sResults = await _searchByTypeWithDate(page, typeCode, dateFrom, address, maxPages, 'pending');
    if (sResults._tooMany) {
      console.warn(`        Still too many records — skipping ${typeCode}. Consider tightening the date window.`);
    } else {
      for (const r of sResults) {
        if (!results.some(existing => existing.permitNumber === r.permitNumber)) {
          results.push(r);
        }
      }
      console.log(`        Found ${sResults.length} pending results`);
    }
    delete results._tooMany;
  }

  return results;
}

async function _searchByTypeWithDate(page, typeCode, dateFrom, address, maxPages, statusFilter = null) {
  const results = [];

  try {
    const searchUrl = `${config.portal.baseUrl}${config.portal.searchPath}`;
    await page.goto(searchUrl, { timeout: config.browser.timeout, waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(config.search.waitForFirstPage);

    // Set Mine = N (all permits, not just mine)
    await page.evaluate(() => {
      const mineN = document.querySelector('input[name="Mine"][value="N"]');
      if (mineN) mineN.checked = true;
    });

    // Set status filter — use specific status if provided, else * (all)
    const statusVal = statusFilter || '*';
    await page.evaluate((sv) => {
      const radio = document.querySelector(`input[name="pmPermit..APPROVAL_STATE"][value="${sv}"]`);
      if (radio) radio.checked = true;
    }, statusVal);

    // Set permit type code
    await page.selectOption('select[name="pmPermit..PERMIT_TYPE_CODE"]', typeCode);

    // Set date filter using QBE syntax (>01/01/2022 = "applied after Jan 1 2022")
    if (dateFrom) {
      await page.fill('input[name="pmPermit..APPLICATION_DATE"]', dateFrom);
    }

    // Set address filter if provided
    if (address) {
      await page.fill('input[name="pmPermit..PermitAddr"]', address);
    }

    // Submit the form — the ASP.NET server can be very slow (30-60s).
    // Use Promise.all to wait for navigation alongside the click.
    await Promise.all([
      page.waitForNavigation({ timeout: config.browser.timeout, waitUntil: 'domcontentloaded' }).catch(() => {}),
      page.locator('input[name="Button"]').click({ timeout: config.browser.timeout }),
    ]);
    await page.waitForTimeout(config.search.waitForFirstPage);

    // Handle "too many records" — need narrower date filter
    const bodyText = await page.locator('body').innerText().catch(() => '');
    if (bodyText.includes('too many records')) {
      console.warn(`    Too many records for ${typeCode} with date ${dateFrom}${statusFilter ? ' status=' + statusFilter : ''}`);
      results._tooMany = true;
      return results;
    }
    if (bodyText.includes('no records')) {
      return results;
    }

    let pageNum = 1;
    let hasNextPage = true;

    while (hasNextPage && pageNum <= maxPages) {
      const pageResults = await extractResults(page);
      results.push(...pageResults);

      const nextBtn = page.locator('a:has-text("Next"), input[value="Next >"], input[value=">"]').first();
      if (await nextBtn.isVisible().catch(() => false)) {
        await nextBtn.click();
        await page.waitForTimeout(config.search.waitBetweenPages);
        pageNum++;
      } else {
        hasNextPage = false;
      }
    }
  } catch (error) {
    console.error(`  Error searching type ${typeCode}: ${error.message}`);
  }

  return results;
}

// Header keyword → output field. Used to map columns by name so the extractor
// survives portal redesigns that reorder or insert columns.
const COLUMN_KEYWORDS = {
  permitNumber: /permit\s*(#|num|no\b)/i,
  appDate:      /\bdate\b/i,
  address:      /address|street|location/i,
  permitType:   /^\s*type\b/i,
  description:  /\bdescription\b|\bscope\b/i,
};

// A real results-table header has roughly column-count cells. Irvine wraps the
// results in a deep layout table whose outer <tr> reports hundreds of cells
// (querySelectorAll on th,td recurses into nested tables). Those layout rows must
// be skipped — only narrow rows with a plausible column count can be the header.
const MAX_HEADER_CELLS = 15;

async function findHeaderRow(rows) {
  for (let i = 0; i < Math.min(rows.length, 20); i++) {
    const cells = await rows[i].locator('th, td').all();
    if (cells.length < 4 || cells.length > MAX_HEADER_CELLS) continue;
    const texts = await Promise.all(
      cells.map(c => c.innerText().then(t => t.trim()).catch(() => ''))
    );
    const map = {};
    for (const [field, rx] of Object.entries(COLUMN_KEYWORDS)) {
      const idx = texts.findIndex(t => rx.test(t));
      if (idx >= 0) map[field] = idx;
    }
    // Require all five columns we extract — a partial match means we've landed on
    // a layout/sub-header row, and using it would silently produce empty fields.
    const required = ['permitNumber', 'appDate', 'address', 'permitType', 'description'];
    if (required.every(f => map[f] !== undefined)) {
      return { map, index: i };
    }
  }
  return null;
}

async function extractResults(page) {
  const results = [];

  try {
    const rows = await page.locator('table tr').all();
    const header = await findHeaderRow(rows);

    // Fallback matches the historical Irvine column order: Permit#, Date, Address, Type, Description.
    const POSITIONAL_FALLBACK = { permitNumber: 0, appDate: 1, address: 2, permitType: 3, description: 4 };
    const map = header?.map ?? POSITIONAL_FALLBACK;
    const startIdx = header ? header.index + 1 : 0;
    if (!header) {
      console.warn('    Header row not detected — falling back to positional extraction');
    }

    for (let i = startIdx; i < rows.length; i++) {
      const cells = await rows[i].locator('td').all();
      if (cells.length < 4) continue;

      const cellAt = async (field) => {
        const idx = map[field];
        if (idx === undefined || idx >= cells.length) return '';
        return (await cells[idx].innerText()).trim();
      };

      const permitNumber = (await cellAt('permitNumber')).replace(/\s+/g, ' ');

      // Permit numbers follow format: 00870216-RNEW (or similar alphanumeric).
      // This guard also filters out header/footer rows.
      if (!permitNumber.match(/^\d{6,10}-[A-Z0-9]+$/i)) continue;

      const appDate     = await cellAt('appDate');
      // Address split across two lines: "4822 KRON ST\nIRVINE, CA 92604"
      const address     = (await cellAt('address')).replace(/\n+/g, ', ');
      const permitType  = await cellAt('permitType');
      const description = await cellAt('description');

      results.push({ permitNumber, appDate, address, permitType, description });
    }
  } catch (error) {
    console.error(`  Error extracting results: ${error.message}`);
  }

  return results;
}

function filterPlanCheck(results) {
  // Results are already filtered by permit type codes during search.
  // This secondary filter keeps only the BBC-relevant types by permit number suffix.
  // RNEW is explicitly excluded — those are already under construction.
  const bbcCodes = BBC_PERMIT_TYPES.map(t => t.code.toUpperCase());
  const EXCLUDED_SUFFIXES = ['RNEW'];
  return results.filter(r => {
    const suffix = (r.permitNumber || '').split('-')[1] || '';
    if (EXCLUDED_SUFFIXES.includes(suffix)) {
      return false;
    }
    if (!bbcCodes.includes(suffix)) {
      return false;
    }
    if (!isLikelyRecent(r.appDate, { daysBack: 90 })) {
      return false;
    }
    return isBurkhartFit({
      permitNumber: r.permitNumber,
      type: r.permitType,
      description: r.description,
      address: r.address,
    });
  });
}

function getTypeBreakdown(results) {
  const counts = {};
  for (const r of results) {
    const type = r.permitType || 'Unknown';
    counts[type] = (counts[type] || 0) + 1;
  }
  return counts;
}

function formatProperty(permit) {
  return {
    permitNumber: permit.permitNumber,
    type: permit.permitType,
    address: permit.address,
    appDate: permit.appDate,
    description: permit.description,
    source: config.portal.name,
    sourceType: 'City Permit',
  };
}

function toCSV(properties) {
  const header = 'Permit Number,Source,Source Type,Type,Address,App Date,Description\n';
  const rows = properties.map(p => [
    p.permitNumber,
    `"${p.source || config.portal.name}"`,
    `"${p.sourceType || 'City Permit'}"`,
    `"${(p.type || '').replace(/"/g, '""')}"`,
    `"${(p.address || '').replace(/"/g, '""')}"`,
    p.appDate || '',
    `"${(p.description || '').replace(/"/g, '""').substring(0, 300)}"`,
  ].join(','));
  return header + rows.join('\n');
}

module.exports = { searchPermits, filterPlanCheck, getTypeBreakdown, formatProperty, toCSV, BBC_PERMIT_TYPES };
