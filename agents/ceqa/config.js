// agents/ceqa/config.js — CEQAnet (CA environmental filings) source config.
//
// Re-exports the live values from config/signal-sources.json → layers.L3_ceqa so
// a non-developer can retune the source (doc types, min units, counties) without
// touching code (spec §14 "config over code"). Every field has a sane in-code
// fallback so the agent still runs if the config key is missing or malformed.
//
// CEQAnet query contract (confirmed live, Phase-0):
//   GET https://ceqanet.opr.ca.gov/Search
//        ?DocumentType=<NOP|NOD|EIR|MND|NOE>
//        &County=<Orange|Los Angeles>
//        &StartRange=MM/DD/YYYY      (Received-date lower bound — server-side)
//        &EndRange=MM/DD/YYYY        (Received-date upper bound)
//        [&q=<keyword>]              (optional free-text)
//   → server-rendered HTML table (schema.org/Report rows); NO JSON endpoint.
//   The base host opr.ca.gov 301-redirects to ceqanet.lci.ca.gov (fetch follows).

const fs = require('fs');
const path = require('path');

// Load config/signal-sources.json → layers.L3_ceqa (best-effort).
function loadLayerConfig() {
  try {
    const p = path.resolve(__dirname, '..', '..', 'config', 'signal-sources.json');
    const json = JSON.parse(fs.readFileSync(p, 'utf8'));
    return (json.layers && json.layers.L3_ceqa) || {};
  } catch {
    return {};
  }
}

const L3 = loadLayerConfig();

// County → metro map for the active Danielian metros. CEQAnet is CA-only, so
// only Orange (OC) and Los Angeles (LA) are in scope at MVP.
const COUNTY_TO_METRO = {
  'Orange': 'OC',
  'Los Angeles': 'LA',
};

module.exports = {
  // Source identity.
  source: { name: 'CEQAnet', id: 'ceqa', layer: 'L3' },

  // Live host. opr.ca.gov 301s to lci.ca.gov; built-in fetch follows redirects.
  base: L3.base || 'https://ceqanet.opr.ca.gov',
  searchBase: L3.searchBase || 'https://ceqanet.opr.ca.gov/Search',

  // Document types to harvest. NOP is the earliest signal (12-18mo). Order
  // matters only for query iteration, not priority.
  documentTypes: Array.isArray(L3.documentTypes) && L3.documentTypes.length
    ? L3.documentTypes
    : ['NOP', 'NOD', 'EIR', 'MND', 'NOE'],

  // Counties to scan (the active metros). Keyed name must match CEQAnet's
  // County param spelling exactly ("Los Angeles", not "LA").
  counties: Array.isArray(L3.counties) && L3.counties.length
    ? L3.counties
    : ['Orange', 'Los Angeles'],

  countyToMetro: COUNTY_TO_METRO,

  // Residential / mixed-use keyword filter hint (the real ICP gate lives in
  // danielian-fit.js via the harness; this is a coarse pre-filter on titles).
  filters: Array.isArray(L3.filters) && L3.filters.length
    ? L3.filters
    : ['residential', 'mixed-use'],

  // Minimum unit count to treat a parsed project as a development pursuit.
  minUnits: Number.isFinite(L3.minUnits) ? L3.minUnits : 10,

  stateScope: L3.stateScope || 'CA-only',

  // HTTP behavior.
  http: {
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    timeoutMs: 30000,
    // CEQAnet caps results at "latest 100 shown" per query; pagination is by
    // tightening the date range, which the harness `days` window already does.
    resultCap: 100,
  },
};
