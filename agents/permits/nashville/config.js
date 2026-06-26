// agents/permits/nashville/config.js — Metro Nashville-Davidson building-permit source config.
//
// Re-exports the "Nashville-Davidson" jurisdiction entry from
// config/jurisdictions.json (vendor 'socrata') with in-code fallbacks (spec §14
// "config over code").
//
// PHASE-0 VERIFY — DATASET DRIFT FOUND 2026-06-26:
//   * The spec's placeholder data.nashville.gov/resource/3h5w-q8b7.json is DEAD:
//     data.nashville.gov has migrated its public portal to ArcGIS Hub and every
//     /resource/<id>.json SODA path now 302-redirects to hub.arcgis.com/legacy.
//   * The WORKING Socrata (SODA) feed for Nashville building permits is the Tyler
//     Data & Insights BLDS partner host:
//       https://permits.partner.socrata.com/resource/7ky7-xbzp.json
//     (dataset "Nashville Building Permits – BLDS"). It answers the SODA API and
//     returns real rows in the standardized BLDS schema: permitnum, description,
//     applieddate, issueddate, originaladdress1/city/state/zip, permitclassmapped,
//     workclassmapped, estprojectcostdec, contractorcompanyname, parcel.
//   * CAVEAT: the partner BLDS feed's latest issueddate observed was stale (2016).
//     If the live ArcGIS Hub "Building Permits Issued" dataset (3h5w-q8b7) regains
//     a SODA/JSON endpoint, or a fresher Tyler BLDS id is published, update
//     permitUrl/dataset in config/jurisdictions.json. A short lookback may
//     legitimately yield 0 rows from the stale partner feed → the agent degrades
//     to [] (graceful), which is the intended behavior, not a bug.
//
// Socrata SODA contract (confirmed live, partner host):
//   GET https://permits.partner.socrata.com/resource/7ky7-xbzp.json
//        ?$where=issueddate > '<ISO>'&$limit=1000&$offset=<n>&$order=issueddate DESC
//        [header X-App-Token: <token> — optional]

const fs = require('fs');
const path = require('path');

const FALLBACK = {
  city: 'Nashville-Davidson',
  vendor: 'socrata',
  // Working SODA endpoint (Tyler BLDS partner host). See PHASE-0 VERIFY above.
  permitUrl: 'https://permits.partner.socrata.com/resource/7ky7-xbzp.json',
  dataset: '7ky7-xbzp',
  tokenKey: 'NASHVILLE_SOCRATA_APP_TOKEN',
};

// Load config/jurisdictions.json → NASHVILLE[] → the socrata entry.
function loadJurisdictionEntry() {
  try {
    const p = path.resolve(__dirname, '..', '..', '..', 'config', 'jurisdictions.json');
    const json = JSON.parse(fs.readFileSync(p, 'utf8'));
    const list = Array.isArray(json.NASHVILLE) ? json.NASHVILLE : [];
    const entry = list.find((j) => j.vendor === 'socrata' && /nashville/i.test(j.city || ''))
      || list.find((j) => j.vendor === 'socrata')
      || {};
    return entry;
  } catch {
    return {};
  }
}

const entry = loadJurisdictionEntry();

module.exports = {
  metro: 'NASHVILLE',
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
  _jurisdiction: entry,
};
