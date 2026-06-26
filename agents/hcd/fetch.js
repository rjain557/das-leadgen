// agents/hcd/fetch.js — PERCEIVE for L5 (CA HCD / density-bonus / streamlining).
//
// Source: data.ca.gov, a CKAN portal. Two-step harvest:
//   1) ckanPackageSearch() resolves the CURRENT HCD APR + RHNA packages and
//      grabs a datastore-active resource_id (ids rotate yearly — never hardcode).
//      We TARGET "APR Table A2" (Housing Development Applications Submitted):
//      project-level rows carrying STREET_ADDRESS + per-income unit counts +
//      APPROVE_SB35 + DENSITY_BONUS_* — exactly the streamlining signal Danielian
//      wants (6-18mo lead). If A2 can't be resolved we fall back to Table A
//      (permits-by-project) and then RHNA (jurisdiction-level progress).
//   2) ckanDatastoreSearch() pulls rows for each ACTIVE-metro jurisdiction
//      (full-text q on the city/county name), filters to residential unit
//      counts >= minUnits, and emits one raw record per qualifying row.
//
// HCD APR rows can be jurisdiction-level housing-element progress rather than
// individual projects — that's expected (spec flags this layer ⚠ hard-mvp /
// partly news-augmented). We emit whatever carries a unit count + jurisdiction
// and prefer project/permit-level rows (Table A2) when available.
//
// GRACEFUL DEGRADATION: any network/resolve failure logs a clear warning and
// returns [] (or whatever was gathered) — this function NEVER throws. The
// harness wraps perceive() in a retry loop; returning [] is a valid empty run.
//
// !!! Resource ids and COLUMN NAMES on data.ca.gov drift. Every dependency on a
// specific id / column is tagged `// PHASE-0 VERIFY:` below — confirm live in
// Phase 0 and (preferably) move confirmed ids into config/signal-sources.json.

'use strict';

const config_ = require('./config');

// ---------------------------------------------------------------------------
// Low-level CKAN HTTP (Node 20+ built-in fetch; no deps).
// ---------------------------------------------------------------------------
async function ckanGet(url, { config = config_, log } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.requestTimeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'accept': 'application/json', 'user-agent': config.userAgent },
    });
    if (!res.ok) {
      if (log) log(`CKAN HTTP ${res.status} for ${shortUrl(url)}`);
      return null;
    }
    const json = await res.json();
    if (!json || json.success !== true) {
      if (log) log(`CKAN returned success=false for ${shortUrl(url)}`);
      return null;
    }
    return json.result;
  } catch (err) {
    if (log) log(`CKAN request failed (${err.name === 'AbortError' ? 'timeout' : err.message}) for ${shortUrl(url)}`);
    return null; // graceful: caller treats null as "source unreachable"
  } finally {
    clearTimeout(timer);
  }
}

function shortUrl(u) { return String(u).replace(/^https?:\/\//, '').slice(0, 90); }

// ---------------------------------------------------------------------------
// CKAN package_search — discover datasets by term, return matching packages.
// ---------------------------------------------------------------------------
async function ckanPackageSearch(term, { config = config_, log, rows = 10 } = {}) {
  const url = `${config.ckanPackageApi}?q=${encodeURIComponent(term)}&rows=${rows}`;
  const result = await ckanGet(url, { config, log });
  return (result && Array.isArray(result.results)) ? result.results : [];
}

// ---------------------------------------------------------------------------
// CKAN datastore_search — pull rows from one resource.
//   opts: { q, filters, limit, offset } (filters = object → exact field match)
// ---------------------------------------------------------------------------
async function ckanDatastoreSearch(resourceId, opts = {}, { config = config_, log } = {}) {
  const { q, filters, limit = config.pageLimit, offset = 0 } = opts;
  const params = new URLSearchParams({ resource_id: resourceId, limit: String(limit), offset: String(offset) });
  if (q) params.set('q', q);
  if (filters && Object.keys(filters).length) params.set('filters', JSON.stringify(filters));
  const url = `${config.ckanDatastoreApi}?${params.toString()}`;
  const result = await ckanGet(url, { config, log });
  if (!result) return { records: [], total: 0, fields: [] };
  return {
    records: Array.isArray(result.records) ? result.records : [],
    total: Number.isFinite(result.total) ? result.total : 0,
    fields: Array.isArray(result.fields) ? result.fields.map(f => f.id) : [],
  };
}

// ---------------------------------------------------------------------------
// Resolve a datastore-active resource id from a discovered package, preferring
// the target table by name (e.g. "Table A2").
// ---------------------------------------------------------------------------
function pickResource(pkg, { preferNames = [], avoidFormats = ['DOCX', 'DOC', 'PDF', 'ZIP'] } = {}) {
  const resources = (pkg && pkg.resources) || [];
  const active = resources.filter(r => r.datastore_active && !avoidFormats.includes(String(r.format || '').toUpperCase()));
  const pool = active.length ? active : resources.filter(r => !avoidFormats.includes(String(r.format || '').toUpperCase()));
  for (const want of preferNames) {
    const hit = pool.find(r => String(r.name || '').toLowerCase().includes(want.toLowerCase()));
    if (hit) return hit;
  }
  return pool[0] || null;
}

// Resolve the HCD APR Table A2 (or best fallback) resource id, live.
async function resolveAprResource({ config = config_, log } = {}) {
  // PHASE-0 VERIFY: package name + Table A2 resource id. Confirmed live
  // 2026-06-26 as package "housing-element-annual-progress-report-apr-data-by-
  // jurisdiction-and-year", Table A2 resource fe505d9b-8c36-42ba-ba30-08bc4f34e022
  // (datastore_active). These rotate — re-resolve by search, never hardcode.
  const term = config.datasetSearchTerms.find(t => /housing.?element|apr|annual.?progress/i.test(t))
    || 'housing element annual progress report';
  const pkgs = await ckanPackageSearch(term, { config, log });
  if (!pkgs.length) { if (log) log(`no APR package matched "${term}"`); return null; }

  // Prefer the jurisdiction/year APR data package (has the Table A* resources).
  const aprPkg = pkgs.find(p => /annual.?progress|\bapr\b/i.test(`${p.name} ${p.title}`)
    && /table\s*a/i.test(JSON.stringify(p.resources || []))) || pkgs[0];

  // PHASE-0 VERIFY: resource display names. Target "Table A2" (applications
  // submitted = project-level, the strongest streamlining signal). Fall back to
  // "Table A" (permits by project) — both share the per-income unit columns.
  const res = pickResource(aprPkg, { preferNames: ['Table A2', 'Table A'] });
  if (!res) { if (log) log(`APR package "${aprPkg.name}" had no datastore-active table`); return null; }
  const isA2 = /a2/i.test(res.name || '');
  if (log) log(`resolved APR ${isA2 ? 'Table A2 (applications)' : `"${res.name}"`} → ${res.id}`);
  return { resourceId: res.id, table: isA2 ? 'A2' : 'A', resourceName: res.name, pkg: aprPkg.name };
}

// ---------------------------------------------------------------------------
// Row mapping. APR Table A2 column schema (PHASE-0 VERIFY — confirmed live
// 2026-06-26 on resource fe505d9b…; HCD revises the APR schema ~yearly):
//   JURIS_NAME, CNTY_NAME, YEAR, APN, STREET_ADDRESS, STD_ADDRESS, PROJECT_NAME,
//   JURS_TRACKING_ID, ENT_APPROVE_DT1, BP_ISSUE_DT1, APPROVE_SB35 (Y/N),
//   DENSITY_BONUS_TOTAL, DENSITY_BONUS_INCENTIVES, LATITUDE, LONGITUDE, and the
//   per-income unit columns (…_INCOME_DR / …_INCOME_NDR / ABOVE_MOD_INCOME and
//   the BP_-prefixed building-permit equivalents) summed for the unit count.
// ---------------------------------------------------------------------------

// Affordability/unit columns at the ENTITLEMENT stage (DR = deed-restricted,
// NDR = non-deed-restricted). Summed → total proposed units on the application.
const ENT_UNIT_COLS = [
  'ACUTELY_LOW_INCOME_DR', 'ACUTELY_LOW_INCOME_NDR',
  'EXTREMELY_LOW_INCOME_DR', 'EXTREMELY_LOW_INCOME_NDR',
  'VLOW_INCOME_DR', 'VLOW_INCOME_NDR',
  'LOW_INCOME_DR', 'LOW_INCOME_NDR',
  'MOD_INCOME_DR', 'MOD_INCOME_NDR',
  'ABOVE_MOD_INCOME',
];
// Building-permit-stage equivalents (fallback when entitlement units are 0).
const BP_UNIT_COLS = ENT_UNIT_COLS.map(c => c === 'ABOVE_MOD_INCOME' ? 'BP_ABOVE_MOD_INCOME' : `BP_${c}`);
// Deed-restricted (affordable) columns only — any > 0 ⇒ projectType 'affordable'.
const AFFORDABLE_COLS = ENT_UNIT_COLS.filter(c => /_DR$/.test(c) || /^EXTR/.test(c))
  .concat(['EXTR_LOW_INCOME_UNITS']);

function num(v) { const n = parseInt(v, 10); return Number.isFinite(n) ? n : 0; }
function sumCols(row, cols) { return cols.reduce((s, c) => s + num(row[c]), 0); }
function truthyYN(v) {
  const s = String(v == null ? '' : v).trim().toLowerCase();
  return s === 'y' || s === 'yes' || s === 'true' || s === '1';
}

// Derive 'OC' | 'LA' | null from a row's county/jurisdiction (active metros only).
function deriveMetro(jurisName, countyName, config) {
  const j = String(jurisName || '').toLowerCase();
  const c = String(countyName || '').toLowerCase();
  for (const code of config.activeMetros) {
    const county = config.metroCounties[code];
    if (county && (c.includes(county) || j.includes(county))) return code;
    for (const city of (config.metroCities[code] || [])) {
      // city list includes "county of orange"; guard against empty
      if (city && (j.includes(city) || j === city)) return code;
    }
  }
  return null;
}

function firstDate(row, keys) {
  for (const k of keys) {
    const v = row[k];
    if (v && String(v).trim() && !/^0+$/.test(String(v).trim())) {
      const d = new Date(String(v).trim());
      if (!Number.isNaN(d.getTime())) return d.toISOString().slice(0, 10);
    }
  }
  return null;
}

// Map one APR Table A2/A row → the raw record contract. Returns null if the row
// carries no usable unit count + jurisdiction.
function mapAprRow(row, ctx) {
  const { config, table } = ctx;
  const jurisName = row.JURIS_NAME || row.JURISDICTION || row.JURS_NAME || null; // PHASE-0 VERIFY: jurisdiction col
  const countyName = row.CNTY_NAME || row.COUNTY || null;                         // PHASE-0 VERIFY: county col
  if (!jurisName && !countyName) return null;

  const entUnits = sumCols(row, ENT_UNIT_COLS);
  const bpUnits = sumCols(row, BP_UNIT_COLS);
  const unitCount = entUnits || bpUnits || null;

  const affordableUnits = sumCols(row, AFFORDABLE_COLS);
  const dbTotal = num(row.DENSITY_BONUS_TOTAL);
  const dbIncentives = String(row.DENSITY_BONUS_INCENTIVES || '').trim();
  const sb35 = truthyYN(row.APPROVE_SB35);                                        // PHASE-0 VERIFY: SB35 col (Y/N)

  const addressRaw = row.STD_ADDRESS || row.STREET_ADDRESS || null;              // PHASE-0 VERIFY: address cols
  const address = (addressRaw && String(addressRaw).trim()) || jurisName || countyName;
  const metro = deriveMetro(jurisName, countyName, config);

  const date = firstDate(row, ['ENT_APPROVE_DT1', 'BP_ISSUE_DT1', 'YEAR'])       // PHASE-0 VERIFY: date cols
    || (row.YEAR ? `${String(row.YEAR).trim()}-01-01` : null);

  const projectName = (row.PROJECT_NAME && String(row.PROJECT_NAME).trim()) || null;
  const ref = (row.JURS_TRACKING_ID && String(row.JURS_TRACKING_ID).trim()) || null;
  const lat = parseFloat(row.LATITUDE), lng = parseFloat(row.LONGITUDE);

  const densityBonus = dbTotal > 0 || dbIncentives.length > 0;
  const builderRemedy = false; // not a discrete APR column; flagged via news-augmentation (spec) — see PHASE-0 note
  const isAffordable = affordableUnits > 0 || sb35 || densityBonus;

  const scopeBits = [
    projectName ? `Project: ${projectName}.` : null,
    `${jurisName || countyName} APR Table ${table} ${row.YEAR ? `(${row.YEAR})` : ''}`.trim() + '.',
    unitCount ? `${unitCount} units` + (affordableUnits ? ` (${affordableUnits} deed-restricted/affordable)` : '') + '.' : null,
    sb35 ? 'SB 35 streamlining approved.' : null,
    densityBonus ? `Density bonus${dbTotal ? ` (+${dbTotal} units)` : ''}${dbIncentives ? `; incentives: ${dbIncentives}` : ''}.` : null,
    (row.NOTES && String(row.NOTES).trim()) ? `Notes: ${String(row.NOTES).trim()}` : null,
  ].filter(Boolean).join(' ');

  return {
    address,
    apn: (row.APN && String(row.APN).trim()) || null,
    metro,
    jurisdiction: jurisName || countyName,
    projectType: isAffordable ? 'affordable' : null, // null ⇒ let harness classify
    unitCount,
    stage: 'entitlement',
    scopeText: scopeBits,
    description: scopeBits,
    title: projectName || `${jurisName || countyName} housing application` + (ref ? ` ${ref}` : ''),
    ref,
    date,
    url: `${config.base}/dataset/housing-element-annual-progress-report-apr-data-by-jurisdiction-and-year`,
    developerName: null, // APR carries no applicant/developer name column (PHASE-0 VERIFY: confirm none added)
    legislative: { densityBonus, builderRemedy, sb35 },
    geo: (Number.isFinite(lat) && Number.isFinite(lng)) ? { lat, lng } : undefined,
    source: 'hcd-apr',
    sourceTable: `APR-${table}`,
    reportYear: row.YEAR != null ? String(row.YEAR) : null,
    affordableUnits: affordableUnits || null,
  };
}

// ---------------------------------------------------------------------------
// Per-jurisdiction harvest: full-text q on the jurisdiction name, paginate up
// to maxPagesPerJuris, map + filter rows. Keeps only rows that qualify (unit
// count >= minUnits AND derived metro matches an active metro).
// ---------------------------------------------------------------------------
async function harvestJurisdiction(apr, juris, ctx) {
  const { config, log, minUnits, sinceYear } = ctx;
  const out = [];
  for (let page = 0; page < config.maxPagesPerJuris; page++) {
    const offset = page * config.pageLimit;
    const { records, total } = await ckanDatastoreSearch(
      apr.resourceId,
      { q: juris.name, limit: config.pageLimit, offset },
      { config, log },
    );
    if (!records.length) break;
    for (const row of records) {
      const rec = mapAprRow(row, { config, table: apr.table });
      if (!rec) continue;
      // Confirm the row actually belongs to this active metro (q is fuzzy).
      if (!rec.metro) continue;
      // Recency: APR YEAR vs the lookback window (data is annual, so this is a
      // coarse year filter — a 90-day window keeps the latest report year+).
      if (sinceYear && rec.reportYear && Number(rec.reportYear) < sinceYear) continue;
      // Unit floor (spec: residential >= minUnits).
      if (rec.unitCount == null || rec.unitCount < minUnits) continue;
      out.push(rec);
    }
    if (offset + records.length >= total) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Public entrypoint used by index.js perceive().
// ---------------------------------------------------------------------------
async function fetchHcdSignals({ days = 180, config = config_, log = () => {} } = {}) {
  const minUnits = config.minUnits;
  // APR data is annual; convert the day window to a "report year floor" so a
  // routine run still surfaces the most recent published APR cycle.
  const nowYear = new Date().getFullYear();
  const sinceYear = nowYear - Math.max(1, Math.ceil(days / 365)) - 1; // generous floor (APR lags ~1-2yr)

  const jurisdictions = config.activeJurisdictions();
  if (!jurisdictions.length) {
    log('no active-metro jurisdictions configured (das-icp.json activeMetros empty) — nothing to harvest');
    return [];
  }
  log(`active metros: ${config.activeMetros.join(', ')} (${jurisdictions.length} jurisdictions), minUnits=${minUnits}, reportYear>=${sinceYear}`);

  // STEP 1 — resolve the live APR Table A2/A resource (graceful on failure).
  const apr = await resolveAprResource({ config, log });
  if (!apr) {
    log('WARNING: could not resolve an HCD APR datastore resource on data.ca.gov ' +
        '(CKAN unreachable or schema moved). Returning 0 records — see PHASE-0 VERIFY notes in fetch.js.');
    return [];
  }

  // STEP 2 — harvest each active jurisdiction.
  const seen = new Set();
  const results = [];
  for (const juris of jurisdictions) {
    let rows = [];
    try {
      rows = await harvestJurisdiction(apr, juris, { config, log, minUnits, sinceYear });
    } catch (err) {
      log(`jurisdiction "${juris.name}" harvest error (skipped): ${err.message}`);
      continue; // never let one jurisdiction abort the run
    }
    for (const r of rows) {
      // Dedup across overlapping city/county queries.
      const key = [r.apn, r.address, r.ref, r.reportYear].map(x => String(x || '')).join('|').toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      results.push(r);
    }
    if (rows.length) log(`  ${juris.metro}/${juris.name}: +${rows.length} qualifying rows`);
  }

  log(`fetched ${results.length} HCD streamlining/density-bonus pursuit rows (table ${apr.table})`);
  return results;
}

module.exports = {
  fetchHcdSignals,
  // helpers exported for tests / Phase-0 verification / reuse:
  ckanPackageSearch,
  ckanDatastoreSearch,
  resolveAprResource,
  mapAprRow,
  deriveMetro,
};
