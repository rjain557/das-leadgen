// agents/hcd/config.js — L5 CA HCD / density-bonus / streamlining config.
//
// "Config over code" (spec §14): the live source endpoints, dataset search
// terms, and tracked-legislation flags are read from
//   config/signal-sources.json → layers.L5_hcd
// and the ICP unit floor from
//   config/das-icp.json → minUnitsThreshold / activeMetros / metros
// with hard-coded fallbacks so a fresh clone (no edits) still runs.
//
// Everything here is data the agent NEEDS but does not hardcode in fetch.js, so
// the HCD APR/RHNA endpoints can be re-pointed (they DO drift — see the
// PHASE-0 VERIFY notes in fetch.js) without touching agent logic.

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const CONFIG_DIR = path.join(REPO_ROOT, 'config');

function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}

const signalSources = readJson(path.join(CONFIG_DIR, 'signal-sources.json'), { layers: {} });
const icp = readJson(path.join(CONFIG_DIR, 'das-icp.json'), {});

const L5 = (signalSources.layers && signalSources.layers.L5_hcd) || {};

// --- Live source endpoints (signal-sources.json with fallbacks) ------------
const base = L5.base || 'https://data.ca.gov';
// CKAN datastore_search endpoint (per-resource row query).
const ckanDatastoreApi = L5.ckanResourceApi || `${base}/api/3/action/datastore_search`;
// CKAN package_search endpoint (dataset discovery) — derived from base; the
// signal-sources entry only carries the datastore url.
const ckanPackageApi = `${base}/api/3/action/package_search`;

// Dataset search terms used by ckanPackageSearch() to resolve the CURRENT
// HCD APR + RHNA packages on data.ca.gov (resource ids rotate yearly).
const datasetSearchTerms = (L5.datasets && L5.datasets.length)
  ? L5.datasets.slice()
  : ['housing-element-annual-progress-report', 'regional-housing-needs-allocation-rhna'];

// Legislative streamlining/tailwind programs to track + flag.
const track = (L5.track && L5.track.length) ? L5.track.slice() : ['builders-remedy', 'sb35', 'sb423'];

// --- ICP: unit floor + active metros (das-icp.json with fallbacks) ---------
const minUnits = Number.isFinite(icp.minUnitsThreshold) ? icp.minUnitsThreshold : 10;
const activeMetros = (icp.activeMetros && icp.activeMetros.length) ? icp.activeMetros.slice() : ['OC'];

// Build {metro: [city,...]} and a flat lowercase jurisdiction lookup for the
// active metros only (LA/Nashville stay dark until their metro is flipped on
// in das-icp.json). County names (e.g. "Orange") double as match targets so
// county-level APR rows resolve to a metro too.
const metroCities = {};
const metroCounties = { OC: 'orange', LA: 'los angeles', NASHVILLE: 'davidson' };
for (const code of activeMetros) {
  const m = (icp.metros && icp.metros[code]) || {};
  metroCities[code] = (m.cities || []).map(c => String(c).toLowerCase());
}

// data.ca.gov APR data is CA-statewide; we keep only rows whose jurisdiction or
// county maps to an ACTIVE metro. This list is the query/filter driver.
function activeJurisdictions() {
  const out = [];
  for (const code of activeMetros) {
    for (const city of (metroCities[code] || [])) out.push({ metro: code, name: city, kind: 'city' });
    if (metroCounties[code]) out.push({ metro: code, name: metroCounties[code], kind: 'county' });
  }
  return out;
}

module.exports = {
  // endpoints
  base,
  ckanDatastoreApi,
  ckanPackageApi,
  // discovery + tracking
  datasetSearchTerms,
  track,
  // ICP
  minUnits,
  activeMetros,
  metroCities,
  metroCounties,
  activeJurisdictions,
  // pagination / network knobs
  pageLimit: 1000,          // CKAN datastore_search hard max is 32000; 1000 is courteous
  maxPagesPerJuris: 5,      // cap rows pulled per jurisdiction (smoke/cost guard)
  requestTimeoutMs: 20000,
  userAgent: 'das-leadgen/hcd (Danielian Pursuit Intelligence; +https://danielian.com)',
};
