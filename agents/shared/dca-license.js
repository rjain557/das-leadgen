/**
 * California DCA License Lookup
 *
 * The California Department of Consumer Affairs runs a public license search
 * at https://search.dca.ca.gov/. The endpoint is:
 *
 *   POST https://search.dca.ca.gov/results
 *
 * Form-encoded body:
 *   boardCode=10                 # 10 = California Architects Board (CAB)
 *                                # 1   = Contractors State License Board (CSLB)
 *   licenseType=ALL
 *   licenseNumber=               # one of these is required
 *   firstName=
 *   lastName=
 *   businessName=
 *
 * The HTML response contains a single results table per license. We parse it
 * with simple regex (no extra deps). For higher-volume use, this fetcher
 * caches by query so back-to-back identical lookups don't re-hit DCA.
 *
 * Boards we hit:
 *   - California Architects Board (CAB) — boardCode=10
 *   - California Board for Professional Engineers, Land Surveyors, and
 *     Geologists (BPELSG) — boardCode=09 (used for engineers / structural)
 */

const BOARD_CODES = {
  architect: '10',
  engineer: '09',
  contractor: '7',  // CSLB has a separate site, but DCA wraps it
};

const SEARCH_URL = 'https://search.dca.ca.gov/results';

function clean(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

function buildBody({ boardCode = '10', licenseNumber = '', firstName = '', lastName = '', businessName = '' }) {
  const params = new URLSearchParams();
  params.set('boardCode', boardCode);
  params.set('licenseType', 'ALL');
  params.set('licenseNumber', licenseNumber);
  params.set('firstName', firstName);
  params.set('lastName', lastName);
  params.set('businessName', businessName);
  return params.toString();
}

/**
 * Parse the DCA results HTML for license records.
 * Each match in the results table is rendered as a panel-style block. We grab
 * the obvious fields (license #, name, address, status) via regex over the
 * rendered text.
 */
function parseResults(html) {
  if (!html || typeof html !== 'string') return [];
  const records = [];

  // The DCA layout wraps each hit in a .row.licenseSearchRow / .panel container
  // — but the version is unstable. We split on a marker the page reliably emits:
  //   "License Number" appears once per record.
  const blocks = html.split(/License Number/i).slice(1);
  for (const block of blocks) {
    // Bound the block at the next "License Number" or end of HTML
    const text = block.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
    const license = (text.match(/^[\s:]*([A-Z]?\d[\d\-]+)/) || [])[1] || '';
    const status = (text.match(/License Status[:\s]+([A-Za-z][A-Za-z &\-]+?)(?:\s{2,}|License Type|Expiration|Issue|Address|City|$)/i) || [])[1] || '';
    const issued = (text.match(/Issue Date[:\s]+([\d\/\-]+)/i) || [])[1] || '';
    const expires = (text.match(/Expiration Date[:\s]+([\d\/\-]+)/i) || [])[1] || '';
    const name = (text.match(/Name[:\s]+([A-Z][A-Za-z\s,\.&\-']{2,80}?)(?:\s+(?:Doing Business As|Business Name|Address|City|License|$))/i) || [])[1] || '';
    const dba = (text.match(/Doing Business As[:\s]+([A-Za-z0-9\s,\.&\-']{2,120}?)(?:\s+(?:Address|City|License|$))/i) || [])[1] || '';
    const address = (text.match(/Address[:\s]+([A-Za-z0-9\s,\.\-#'&]{2,160}?)(?:\s+(?:City|State|Zip|License|$))/i) || [])[1] || '';
    const city = (text.match(/City[:\s]+([A-Za-z\s\-]+?)(?:\s+(?:State|Zip|$))/i) || [])[1] || '';
    const stateZ = (text.match(/State[:\s]+([A-Z]{2})/i) || [])[1] || '';
    const zip = (text.match(/Zip[:\s]+(\d{5}(?:-\d{4})?)/i) || [])[1] || '';

    if (!license && !name) continue;

    records.push({
      license: clean(license),
      status: clean(status),
      issuedDate: clean(issued),
      expirationDate: clean(expires),
      name: clean(name),
      dba: clean(dba),
      mailingAddress: clean([address, city, stateZ, zip].filter(Boolean).join(', ')),
    });
  }

  return records;
}

async function postSearch(body) {
  // Node 18+ has global fetch
  const res = await fetch(SEARCH_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': 'Mozilla/5.0 (compatible; bbc-leadgen/1.0; +contact via permits)',
      'Accept': 'text/html,application/xhtml+xml',
    },
    body,
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`DCA search HTTP ${res.status}`);
  return await res.text();
}

const _cache = new Map();
function cacheKey(opts) { return JSON.stringify(opts); }

/**
 * Search the CA Architects Board (or another DCA board) by license number,
 * person name, or business name.
 *
 * @param {object} opts
 * @param {'architect'|'engineer'|'contractor'} [opts.kind='architect']
 * @param {string} [opts.licenseNumber]
 * @param {string} [opts.firstName]
 * @param {string} [opts.lastName]
 * @param {string} [opts.businessName]
 * @param {boolean} [opts.useCache=true]
 * @returns {Promise<{license, status, name, dba, mailingAddress, ...}[]>}
 */
async function searchLicense(opts = {}) {
  const kind = opts.kind || 'architect';
  const boardCode = BOARD_CODES[kind] || BOARD_CODES.architect;
  const params = {
    boardCode,
    licenseNumber: clean(opts.licenseNumber),
    firstName: clean(opts.firstName),
    lastName: clean(opts.lastName),
    businessName: clean(opts.businessName),
  };
  if (!params.licenseNumber && !params.lastName && !params.businessName) {
    return [];
  }
  const useCache = opts.useCache !== false;
  if (useCache && _cache.has(cacheKey(params))) return _cache.get(cacheKey(params));

  const body = buildBody(params);
  let html = '';
  try {
    html = await postSearch(body);
  } catch (err) {
    if (process.env.DEBUG) console.error(`DCA search failed: ${err.message}`);
    return [];
  }
  const records = parseResults(html);
  if (useCache) _cache.set(cacheKey(params), records);
  return records;
}

/**
 * Best-effort: split a single name string into firstName/lastName for DCA.
 * Returns { firstName, lastName }.
 */
function splitName(name) {
  if (!name) return { firstName: '', lastName: '' };
  // "Smith, John" → John Smith
  if (name.includes(',')) {
    const [last, first] = name.split(',').map(s => s.trim());
    return { firstName: first || '', lastName: last || '' };
  }
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return { firstName: '', lastName: parts[0] };
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
}

module.exports = {
  searchLicense,
  splitName,
  parseResults,    // exported for tests
  buildBody,
  BOARD_CODES,
};
