// agents/permits/la/config.js — City of Los Angeles building-permit source config.
//
// Re-exports the LA "Los Angeles" jurisdiction entry from config/jurisdictions.json
// (vendor 'socrata') so a non-developer can retune the dataset id / host / token
// key without touching code (spec §14 "config over code"). Every field has a sane
// in-code fallback so the agent still runs if the config key is missing/malformed.
//
// Socrata SODA contract (confirmed live, Phase-0 2026-06-26):
//   GET https://data.lacity.org/resource/pi9x-tg5x.json
//        ?$where=issue_date > '<ISO>'&$limit=1000&$offset=<n>&$order=issue_date DESC
//        [header X-App-Token: <token> — optional, raises rate limits]
//   Dataset: LADBS "Building Permits" (pi9x-tg5x). Latest issue_date observed
//   2026-06-21 (current). Columns: primary_address, apn, pin_nbr, permit_nbr,
//   permit_type, permit_sub_type, use_desc, issue_date, status_desc, valuation,
//   work_desc, lat/lon. App token is OPTIONAL (anonymous queries work).

const fs = require('fs');
const path = require('path');

const FALLBACK = {
  city: 'Los Angeles',
  vendor: 'socrata',
  permitUrl: 'https://data.lacity.org/resource/pi9x-tg5x.json',
  dataset: 'pi9x-tg5x',
  tokenKey: 'LA_SOCRATA_APP_TOKEN',
};

// Load config/jurisdictions.json → LA[] → the socrata "Los Angeles" entry.
function loadJurisdictionEntry() {
  try {
    const p = path.resolve(__dirname, '..', '..', '..', 'config', 'jurisdictions.json');
    const json = JSON.parse(fs.readFileSync(p, 'utf8'));
    const laList = Array.isArray(json.LA) ? json.LA : [];
    const entry = laList.find((j) => j.vendor === 'socrata' && /los angeles/i.test(j.city || ''))
      || laList.find((j) => j.vendor === 'socrata')
      || {};
    return entry;
  } catch {
    return {};
  }
}

const entry = loadJurisdictionEntry();

module.exports = {
  metro: 'LA',
  city: entry.city || FALLBACK.city,
  vendor: entry.vendor || FALLBACK.vendor,
  permitUrl: entry.permitUrl || FALLBACK.permitUrl,
  dataset: entry.dataset || FALLBACK.dataset,
  tokenKey: entry.tokenKey || FALLBACK.tokenKey,
  verified: entry.verified === true,
  http: {
    timeoutMs: 30000,
    pageSize: 1000,
  },
  // Surface the raw entry for debugging / future fields.
  _jurisdiction: entry,
};
