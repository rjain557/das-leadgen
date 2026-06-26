// agents/sb79/config.js — L6 SB 79 / transit-corridor overlay config.
//
// "Config over code" (spec §14): the GTFS static feed URLs (transit agencies
// rotate these — see the PHASE-0 VERIFY note below), the SB 79 distance tiers,
// and the law's effective date are read from
//   config/signal-sources.json → layers.L6_sb79
// and the active metros from
//   config/das-icp.json → activeMetros / metros
// with hard-coded fallbacks so a fresh clone (no edits) still runs.
//
// Everything the overlay NEEDS but should not hardcode lives here, so the GTFS
// endpoints can be re-pointed (they DO drift) without touching overlay.js.

'use strict';

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const CONFIG_DIR = path.join(REPO_ROOT, 'config');
const OUTPUT_DIR = path.join(REPO_ROOT, 'data', 'output');

function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}

const signalSources = readJson(path.join(CONFIG_DIR, 'signal-sources.json'), { layers: {} });
const icp = readJson(path.join(CONFIG_DIR, 'das-icp.json'), {});

const L6 = (signalSources.layers && signalSources.layers.L6_sb79) || {};

// --- GTFS static feeds per transit agency (signal-sources.json w/ fallbacks) --
// PHASE-0 VERIFY: transit agencies rotate these static-feed URLs periodically.
// Confirm each live in Phase 0 and (preferably) keep the confirmed value in
// config/signal-sources.json → layers.L6_sb79.gtfs (this object just mirrors it
// with a fallback so a fresh clone still runs).
const GTFS_FALLBACK = {
  OCTA: 'https://octa.net/current/google_transit.zip',
  LA_METRO: 'https://gitlab.com/LACMTA/gtfs_bus/-/raw/master/gtfs_bus.zip',
  NASHVILLE_WEGO: 'https://www.wegotransit.com/google_transit.zip',
};
const gtfsFeeds = Object.assign({}, GTFS_FALLBACK, L6.gtfs || {});

// Which GTFS agency feed(s) serve each metro. Only feeds for ACTIVE metros are
// downloaded/parsed (LA/Nashville stay dark until their metro is flipped on in
// das-icp.json). OC → OCTA by default.
const METRO_AGENCIES = {
  OC: ['OCTA'],
  LA: ['LA_METRO'],
  NASHVILLE: ['NASHVILLE_WEGO'],
};

// --- SB 79 distance tiers (meters), largest last ----------------------------
// Tier 1 = closest (highest upzoning), Tier 3 = outer band. The overlay keeps
// any record within the LARGEST tier and records which tier it falls in.
const distanceTiersMeters = (Array.isArray(L6.distanceTiersMeters) && L6.distanceTiersMeters.length === 3)
  ? L6.distanceTiersMeters.slice().sort((a, b) => a - b)
  : [400, 800, 1600];

const effectiveDate = L6.effectiveDate || '2026-07-01';

// --- ICP: active metros (das-icp.json with fallbacks) -----------------------
const activeMetros = (icp.activeMetros && icp.activeMetros.length) ? icp.activeMetros.slice() : ['OC'];

// Resolve the set of GTFS agencies to load for the active metros (deduped).
function activeAgencies() {
  const set = new Set();
  for (const metro of activeMetros) {
    for (const agency of (METRO_AGENCIES[metro] || [])) {
      if (gtfsFeeds[agency]) set.add(agency);
    }
  }
  return Array.from(set);
}

module.exports = {
  // endpoints
  gtfsFeeds,
  METRO_AGENCIES,
  activeAgencies,
  // SB 79 rules
  distanceTiersMeters,
  effectiveDate,
  // ICP
  activeMetros,
  // paths
  OUTPUT_DIR,
  REPO_ROOT,
  // GTFS route-type filter — SB 79 keys off "major transit stops": rail + BRT.
  // GTFS route_type: 0=tram/light-rail, 1=subway/metro, 2=rail, 3=bus,
  // 5=cable, 11=trolleybus, BRT often tagged 3 with a route flag. We KEEP
  // 0/1/2 (and 11) as "major"; if a feed is bus-only (route_types ⊆ {3}) we
  // fall back to keeping ALL stops (better an over-broad flag than none).
  // PHASE-0 VERIFY: confirm OCTA's rail/BRT (OC Streetcar) route_type once the
  // OC Streetcar feed is published; today OCTA is largely bus (route_type 3).
  majorRouteTypes: [0, 1, 2, 11],
  // network / cache knobs
  requestTimeoutMs: 30000,
  cacheMaxAgeDays: 30,        // re-download a cached stops file older than this
  userAgent: 'das-leadgen/sb79 (Danielian Pursuit Intelligence; +https://danielian.com)',
};
