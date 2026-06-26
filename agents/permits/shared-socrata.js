// agents/permits/shared-socrata.js — shared Socrata open-data REST client for the
// L1 permit agents whose jurisdiction publishes building permits on a Socrata /
// Tyler Data & Insights (SODA) endpoint. LA (data.lacity.org) and Nashville
// (Tyler BLDS partner host) are nearly identical API surfaces, so this is the one
// client both agents call from their perceive().
//
// Design notes (per task + spec §4.1 / §13.2):
//   * Node 20 BUILT-IN fetch only. No npm deps, no Playwright — SODA is a plain
//     JSON REST API, so the whole harvest is HTTP GETs with SoQL query params.
//   * The app token is OPTIONAL. Socrata answers WITHOUT a token at a lower rate
//     limit, so a missing token env var degrades gracefully (we still query and
//     just log a note). If present (process.env[tokenKey]) we send X-App-Token.
//   * Column names DIFFER PER DATASET and DRIFT over time (the spec calls this out
//     explicitly). We therefore never hardcode a single field name — a tolerant
//     resolver inspects the first returned row and picks the address / date /
//     type / valuation / units / ref / parcel / applicant columns by matching
//     known field-name variants. See resolveColumns() — PHASE-0 VERIFY there.
//   * GRACEFUL DEGRADATION is mandatory: any unreachable endpoint, HTTP error,
//     bad JSON, OR a row shape where we cannot resolve an address/date column →
//     log a clear warning and return [] (NEVER throw). The harness retry + learn
//     loop owns emptiness; an exception would abort the orchestrator step.
//
// Raw-record shape returned (loosely typed; the harness REASON pillar +
// scripts/consolidate-lib.js toPursuitRecord finish normalization/scoring):
//   { address, apn, metro, jurisdiction, projectType:null, unitCount, stage,
//     description, scope/scopeText, ref, date(ISO), url, developerName, ... }

// ---------------------------------------------------------------------------
// Column resolver — the heart of drift-tolerance.
// ---------------------------------------------------------------------------
// For each logical field we keep an ORDERED list of candidate Socrata column
// names (most-specific / most-common first). resolveColumns() walks the first
// row's actual keys and binds each logical field to the first candidate present.
//
// PHASE-0 VERIFY: these candidate lists were assembled from the live LA
// (data.lacity.org/resource/pi9x-tg5x — primary_address / issue_date /
// permit_type / valuation / apn / pin_nbr / work_desc / permit_nbr) and Nashville
// Tyler-BLDS (permits.partner.socrata.com/resource/7ky7-xbzp — originaladdress1 /
// issueddate / permittypemapped / estprojectcostdec / parcel / permitnum /
// description / contractorcompanyname) schemas on 2026-06-26, plus the common
// Socrata building-permit variants across Chicago/Seattle/LA-legacy datasets.
// If a dataset is swapped or restyled, confirm the live column names here.
const COLUMN_CANDIDATES = {
  // Full street address in one column.
  address: [
    'primary_address', 'address', 'originaladdress1', 'original_address1',
    'location', 'address1', 'site_address', 'full_address', 'property_address',
    'street_address', 'project_address', 'address_full', 'permit_address',
  ],
  // House-number column when the address is split (LA legacy: address_start +
  // street_name). Combined with street parts by buildAddress().
  addressStart: ['address_start', 'house_number', 'street_number', 'addr_number', 'number'],
  addressEnd: ['address_end'],
  streetDirection: ['street_direction', 'direction', 'pre_direction', 'st_direction'],
  streetName: ['street_name', 'streetname', 'street', 'st_name'],
  streetSuffix: ['street_suffix', 'suffix', 'st_suffix', 'street_type'],
  // City + zip (used to enrich the address / jurisdiction).
  city: ['originalcity', 'city', 'original_city', 'jurisdiction', 'municipality'],
  zip: ['zip_code', 'originalzip', 'zip', 'zipcode', 'postal_code', 'original_zip'],
  // Issue/application/status date — prefer the issuance date.
  date: [
    'issue_date', 'issued_date', 'issueddate', 'permit_issue_date', 'date_issued',
    'application_date', 'applieddate', 'applied_date', 'status_date', 'permit_creation_date',
    'file_date', 'filed_date', 'created_date', 'application_start_date', 'permit_date',
  ],
  // Permit type / class / sub-type / work classification.
  permitType: ['permit_type', 'permittypemapped', 'permit_type_mapped', 'permittype', 'type', 'permit_category'],
  permitSubType: ['permit_sub_type', 'permit_subtype', 'permitsubtype', 'sub_type', 'subtype'],
  permitClass: ['permit_class', 'permitclassmapped', 'permit_class_mapped', 'permitclass', 'class', 'use_desc', 'use_code_desc', 'use_type'],
  workClass: ['workclassmapped', 'work_class', 'work_class_mapped', 'workclass', 'permit_category'],
  // Free-text scope / work description.
  description: ['work_desc', 'work_description', 'description', 'purpose_extra', 'scope', 'scope_of_work', 'job_description', 'permit_description', 'project_description'],
  // Project valuation (used only as a coarse signal; not required).
  valuation: ['valuation', 'estprojectcostdec', 'est_project_cost', 'estimated_cost', 'job_value', 'project_cost', 'reported_cost', 'declared_valuation', 'total_job_valuation', 'cost'],
  // Residential dwelling-unit count.
  units: [
    'of_residential_dwelling_units', 'number_of_dwelling_units', 'dwelling_units',
    'residential_units', 'number_of_units', 'units', 'unit_count', 'num_units',
    'total_units', 'housing_units', 'new_units', 'net_units', 'no_of_dwelling_units',
  ],
  // Permit number / reference.
  ref: ['permit_nbr', 'permit_number', 'permitnum', 'permit_num', 'permit', 'permit_id', 'record_id', 'application_number', 'permit_no'],
  // Parcel / APN / PIN identifier.
  apn: ['apn', 'assessor_parcel', 'parcel', 'parcel_number', 'parcel_id', 'pin', 'pin_nbr', 'ain', 'parcelid', 'parcel_no', 'tax_parcel'],
  // Applicant / contractor / owner — best-available developer name at list level.
  developer: [
    'contractors_business_name', 'contractorcompanyname', 'contractor_company_name',
    'contractor_name', 'contractor', 'applicant_name', 'applicant', 'owner_name',
    'owner', 'business_name', 'company_name', 'firm_name', 'developer',
  ],
  // A status string (helps the ICP active-status gate downstream).
  status: ['status_desc', 'status', 'latest_status', 'permit_status', 'current_status', 'statuscurrent'],
};

// Bind each logical field to a concrete column present in this dataset's rows.
function resolveColumns(sampleRow) {
  const keys = new Set(Object.keys(sampleRow || {}));
  const resolved = {};
  for (const [logical, candidates] of Object.entries(COLUMN_CANDIDATES)) {
    resolved[logical] = candidates.find((c) => keys.has(c)) || null;
  }
  return resolved;
}

// ---------------------------------------------------------------------------
// Residential / multifamily inclusion filter (lean inclusive — the harness's
// danielian-fit applies the precise ICP gate downstream; this just trims the
// obvious non-fits so we do not ship reroofs and water heaters as "pursuits").
// ---------------------------------------------------------------------------
const INCLUDE_KEYWORDS = [
  'multifamily', 'multi-family', 'multi family', 'apartment', 'apartments',
  'condo', 'condominium', 'townhome', 'townhouse', 'townhomes', 'rowhouse',
  'mixed use', 'mixed-use', 'adu', 'accessory dwelling', 'jadu',
  'dwelling unit', 'dwelling units', 'residential units', 'duplex', 'triplex',
  'fourplex', 'four-plex', '4-plex', 'flats', 'senior living', 'assisted living',
  'student housing', 'build-to-rent', 'build to rent', 'btr', 'attached',
  // BLDS permitclassmapped value + LADBS sub-type value:
  'residential', '1 or 2 family', 'family dwelling',
];
const EXCLUDE_KEYWORDS = [
  'reroof', 're-roof', 'roofing', 'water heater', 'hvac', 'mechanical only',
  'solar', 'photovoltaic', ' pv ', 'pool', 'spa', 'fence', 'window replacement',
  'repipe', 're-pipe', 'sign permit', 'gas station', 'cell site', 'antenna',
  'monopole', 'self storage', 'self-storage', 'warehouse', 'industrial',
  'tenant improvement', 'demolition only', 'grading only', 'sewer', 'driveway',
  'retaining wall', 'patio cover', 'carport only', 'electrical only',
  'plumbing only', 'furnace', 'air conditioning', 'ev charger', 'generator',
];

function includesAny(text, words) { return words.some((w) => text.includes(w)); }

// Keep rows that look residential/multifamily; drop obvious single-trade/SFR-noise.
// Inclusive bias: if there is ANY residential signal, keep it even when an
// excludeword is also present (mixed-use legitimately mentions retail etc.).
function isResidentialLike(text) {
  const t = ' ' + String(text || '').toLowerCase() + ' ';
  if (!t.trim()) return false;
  const inc = includesAny(t, INCLUDE_KEYWORDS);
  if (inc) {
    // 1/2-family + a minor-trade word with no multi signal → likely SFR trade work; drop.
    const multi = includesAny(t, ['multifamily', 'multi-family', 'multi family', 'apartment',
      'condo', 'condominium', 'townhome', 'townhouse', 'mixed use', 'mixed-use',
      'dwelling units', 'residential units', 'duplex', 'triplex', 'fourplex', 'adu', 'accessory dwelling']);
    if (!multi && includesAny(t, EXCLUDE_KEYWORDS)) return false;
    return true;
  }
  return false; // no residential signal at all → out (lets harness focus on real dev)
}

// ---------------------------------------------------------------------------
// Small helpers.
// ---------------------------------------------------------------------------
function firstVal(row, col) {
  if (!col) return null;
  const v = row[col];
  if (v == null) return null;
  const s = String(v).trim();
  return s || null;
}

function toIsoDate(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;          // already ISO date
  const m = s.match(/^(\d{4}-\d{2}-\d{2})T/);            // Socrata floating ts
  if (m) return m[1];
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}

// Best-effort dwelling-unit count: explicit units column first, else parse text.
function parseUnits(row, cols) {
  const direct = firstVal(row, cols.units);
  if (direct != null) {
    const n = parseInt(String(direct).replace(/[^\d]/g, ''), 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  const text = [firstVal(row, cols.description), firstVal(row, cols.permitSubType)]
    .filter(Boolean).join(' ');
  const m = text.match(/(\d{1,4})\s*(?:-\s*)?(?:unit|units|dwelling units|du\b|apartments|condos|townhomes)/i);
  return m ? parseInt(m[1], 10) : null;
}

// Assemble a street address from either a single column or split house/street parts.
function buildAddress(row, cols) {
  const single = firstVal(row, cols.address);
  if (single) return single;
  const parts = [
    firstVal(row, cols.addressStart),
    firstVal(row, cols.streetDirection),
    firstVal(row, cols.streetName),
    firstVal(row, cols.streetSuffix),
  ].filter(Boolean);
  return parts.length ? parts.join(' ') : null;
}

// Compose a permit-detail URL when derivable, else fall back to the dataset URL.
function buildUrl(metro, permitUrl, ref, domainHost) {
  // LA City exposes a public permit-status page keyed by PCIS permit #.
  if (metro === 'LA' && ref) {
    return `https://www.ladbsservices2.lacity.org/OnlineServices/PermitReport/PcisPermitDetail?PERMIT_NBR=${encodeURIComponent(ref)}`;
  }
  // Generic: the dataset itself is the only reliable public locator.
  return permitUrl || (domainHost ? `https://${domainHost}/` : null);
}

// ---------------------------------------------------------------------------
// One SODA page fetch. Returns parsed array, or null on ANY failure (caller
// treats null as "stop paginating / degrade").
// ---------------------------------------------------------------------------
async function fetchPage({ permitUrl, dateCol, sinceIso, limit, offset, appToken, timeoutMs, log }) {
  if (typeof fetch !== 'function') { // < Node 18 safety; this project targets Node 20
    log && log('  built-in fetch unavailable (Node < 18) — cannot query Socrata');
    return null;
  }
  // Build SoQL. When we know the date column, constrain + order by it server-side;
  // otherwise pull an unordered page (used only for the first probe before the
  // resolver has run).
  const params = new URLSearchParams();
  params.set('$limit', String(limit));
  params.set('$offset', String(offset));
  if (dateCol) {
    params.set('$where', `${dateCol} > '${sinceIso}'`);
    params.set('$order', `${dateCol} DESC`);
  }
  const url = `${permitUrl}?${params.toString()}`;

  const headers = { Accept: 'application/json' };
  if (appToken) headers['X-App-Token'] = appToken;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers, redirect: 'follow', signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) {
      log && log(`  SODA HTTP ${res.status} for ${url}`);
      return null;
    }
    // A migrated/dead Socrata path can 200 with an ArcGIS/HTML body — guard the
    // content-type so we never JSON.parse an error page.
    const ctype = (res.headers.get('content-type') || '').toLowerCase();
    if (!ctype.includes('json')) {
      log && log(`  SODA returned non-JSON (${ctype || 'unknown'}) — endpoint likely moved/retired`);
      return null;
    }
    const body = await res.json();
    if (!Array.isArray(body)) {
      log && log('  SODA response was not a JSON array — unexpected shape');
      return null;
    }
    return body;
  } catch (err) {
    clearTimeout(timer);
    log && log(`  SODA fetch error: ${err.message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Public API.
// ---------------------------------------------------------------------------
/**
 * Harvest residential/multifamily building permits from a jurisdiction's Socrata
 * (SODA) dataset for the lookback window. Never throws — returns [] on any
 * failure so the harness retry/learn loop stays in control.
 *
 * @param {object}   opts
 * @param {string}   opts.metro     metro code ('LA' | 'NASHVILLE') — used for
 *                                  config lookup + URL derivation + tagging.
 * @param {object}   opts.config    the jurisdiction config (from ./<metro>/config.js):
 *                                  { permitUrl, dataset, tokenKey, city, ... }.
 * @param {number}   [opts.days]    lookback window in days (default 90).
 * @param {number}   [opts.maxPages] cap pages of 1000 (smoke/self-heal).
 * @param {Function} [opts.log]     logger (ctx.log from the harness).
 * @returns {Promise<object[]>} raw permit records.
 */
async function fetchSocrataPermits(opts = {}) {
  const log = opts.log || (() => {});
  const cfg = opts.config || {};
  const metro = opts.metro || cfg.metro || null;

  const permitUrl = cfg.permitUrl;
  const dataset = cfg.dataset || null;
  const tokenKey = cfg.tokenKey || null;
  const city = cfg.city || cfg.jurisdiction || null;
  const timeoutMs = (cfg.http && cfg.http.timeoutMs) || 30000;
  const pageSize = (cfg.http && cfg.http.pageSize) || 1000;

  // PHASE-0 VERIFY: the dataset id + base host below come from config/jurisdictions.json
  // for this metro. Socrata/Tyler dataset ids and host domains DRIFT (Nashville
  // moved its public portal to ArcGIS Hub; the working SODA feed is the Tyler BLDS
  // partner host). Re-confirm permitUrl/dataset live before trusting a zero result.
  if (!permitUrl) {
    log(`Socrata[${metro}]: no permitUrl in config — cannot query (degrading to []).`);
    return [];
  }

  const days = Number.isFinite(opts.days) ? opts.days : 90;
  const sinceIso = new Date(Date.now() - days * 86400000).toISOString().slice(0, 19); // floating ts
  const domainHost = (() => { try { return new URL(permitUrl).host; } catch { return null; } })();

  // Token is OPTIONAL — degrade gracefully when absent.
  const appToken = tokenKey ? process.env[tokenKey] : null;
  if (tokenKey && !appToken) {
    log(`Socrata[${metro}]: no app token (env ${tokenKey} unset) — querying anonymously at lower rate limits.`);
  } else if (appToken) {
    log(`Socrata[${metro}]: using app token from env ${tokenKey}.`);
  }

  log(`Socrata[${metro}]: harvest ${dataset || domainHost} since ${sinceIso} (${days}d), pageSize ${pageSize}` +
      (Number.isFinite(opts.maxPages) ? `, maxPages ${opts.maxPages}` : ''));

  // --- Probe page 1 to resolve columns. We must learn the date column BEFORE we
  // can apply the server-side $where; so page 1 is fetched unordered, the resolver
  // runs, then subsequent pages use the resolved date column. ---
  const probe = await fetchPage({
    permitUrl, dateCol: null, sinceIso, limit: pageSize, offset: 0, appToken, timeoutMs, log,
  });
  if (probe == null) {
    log(`Socrata[${metro}]: dataset unreachable or returned an error — degrading to [] (graceful).`);
    return [];
  }
  if (probe.length === 0) {
    log(`Socrata[${metro}]: 0 rows returned from probe page — nothing to harvest.`);
    return [];
  }

  const cols = resolveColumns(probe[0]);
  if (!cols.address || !cols.date) {
    // The two load-bearing columns. Without them we cannot make a usable pursuit
    // record or apply the date window → degrade rather than emit garbage.
    log(`Socrata[${metro}]: column resolver could not find ${!cols.address ? 'an ADDRESS' : ''}` +
        `${!cols.address && !cols.date ? ' and ' : ''}${!cols.date ? 'a DATE' : ''} column ` +
        `(keys seen: ${Object.keys(probe[0]).slice(0, 12).join(', ')}…). ` +
        `Dataset schema may have drifted — degrading to [] (graceful). See resolveColumns PHASE-0 VERIFY.`);
    return [];
  }
  log(`Socrata[${metro}]: resolved columns → address=${cols.address} date=${cols.date} ` +
      `type=${cols.permitType || cols.permitClass || 'n/a'} units=${cols.units || 'n/a'} ` +
      `ref=${cols.ref || 'n/a'} apn=${cols.apn || 'n/a'}`);

  // --- Now harvest with the resolved date column, applying the window server-side.
  // Re-fetch page 0 (so it's date-filtered + ordered too), then paginate. ---
  const rawRows = [];
  let offset = 0;
  let page = 0;
  const maxPages = Number.isFinite(opts.maxPages) && opts.maxPages > 0 ? opts.maxPages : Infinity;
  while (page < maxPages) {
    const rows = await fetchPage({
      permitUrl, dateCol: cols.date, sinceIso, limit: pageSize, offset, appToken, timeoutMs, log,
    });
    if (rows == null) {
      // Mid-pagination failure: keep what we have rather than throwing.
      log(`Socrata[${metro}]: page ${page + 1} failed — stopping with ${rawRows.length} rows so far (graceful).`);
      break;
    }
    rawRows.push(...rows);
    log(`  page ${page + 1}: ${rows.length} rows (running total ${rawRows.length})`);
    if (rows.length < pageSize) break; // last page
    offset += pageSize;
    page += 1;
  }

  // --- Map + filter to residential/multifamily raw records. ---
  const out = [];
  let dropped = 0;
  for (const row of rawRows) {
    const typeText = [
      firstVal(row, cols.permitType), firstVal(row, cols.permitSubType),
      firstVal(row, cols.permitClass), firstVal(row, cols.workClass),
      firstVal(row, cols.description),
    ].filter(Boolean).join(' ');

    if (!isResidentialLike(typeText)) { dropped++; continue; }

    const address = buildAddress(row, cols);
    const date = toIsoDate(firstVal(row, cols.date));
    if (!address && !firstVal(row, cols.apn)) { dropped++; continue; } // unusable locator

    const ref = firstVal(row, cols.ref);
    const scope = [firstVal(row, cols.description), firstVal(row, cols.permitType),
      firstVal(row, cols.permitSubType)].filter(Boolean).join(' — ');

    out.push({
      address: address || null,
      apn: firstVal(row, cols.apn),
      metro: metro || null,
      jurisdiction: firstVal(row, cols.city) || city || null,
      projectType: null,                 // let the harness classify (danielian-fit)
      unitCount: parseUnits(row, cols),
      stage: 'permit-filed',
      description: firstVal(row, cols.description) || scope || null,
      scope,
      scopeText: scope,
      ref: ref || null,
      permitNumber: ref || null,
      date: date || null,
      url: buildUrl(metro, permitUrl, ref, domainHost),
      developerName: firstVal(row, cols.developer),
      status: firstVal(row, cols.status),
      valuation: firstVal(row, cols.valuation),
      zip: firstVal(row, cols.zip),
      source: dataset || domainHost,
      vendor: 'socrata',
    });
  }

  log(`Socrata[${metro}]: ${rawRows.length} fetched → ${out.length} residential/multifamily kept ` +
      `(${dropped} non-residential dropped).`);
  return out;
}

module.exports = {
  fetchSocrataPermits,
  // Exported for unit-testing / reuse by the per-metro configs and any future agent.
  resolveColumns,
  isResidentialLike,
  toIsoDate,
  parseUnits,
  buildAddress,
  COLUMN_CANDIDATES,
};
