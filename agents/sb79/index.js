// agents/sb79/index.js — L6 signal agent: SB 79 / transit-corridor triggers.
//
// SB 79 (effective 2026-07-01) upzones parcels near MAJOR TRANSIT STOPS. At MVP
// this agent does NOT scan all parcels (Phase-4); it OVERLAYS transit-stop
// locations (GTFS static feeds) against records ALREADY harvested by the other
// layers and FLAGS those within SB 79 distance tiers (400/800/1600 m). This is
// the spec's approved MVP approximation (signal-sources.json L6_sb79.verify).
//
// Built on the shared 4-pillar harness. NOTE: this agent supplies a CUSTOM
// reason() that is the IDENTITY function — its inputs are already pursuit-shaped
// AND ICP-filtered (they came from the other layers' outputs), and they are
// already SB 79-annotated by perceive(). It must NOT re-run the Danielian ICP
// filter, or it would drop perfectly-good annotated records. The harness still
// supplies CLI parsing, output writing to -o (ACT), and the learn loop (LEARN).
//
// We also export nearTransit() so the orchestrator / other layers can call the
// haversine tier check directly during enrichment (after loadStops warms it).

'use strict';

const { defineAgent } = require('../shared/agent-harness');
const config = require('./config');
const { flagHarvestedRecords, nearTransit, loadStops } = require('./overlay');

module.exports = defineAgent({
  name: 'sb79',
  layer: 'L6',
  displayName: 'SB 79 / transit-corridor triggers',
  skill: {
    perceives: 'transit GTFS stops (OCTA/LA Metro/WeGo) overlaid on harvested pursuit records',
    sources: ['OCTA', 'LA Metro', 'Nashville WeGo GTFS'],
    leadTimeMonths: 'predictive',
    reasons: 'flag records within SB 79 distance tiers (400/800/1600m)',
    acts: 'emit only flagged records with legislative.sb79=true + sb79Tier',
    learns: 'flag-rate via harness',
  },
  defaultDays: 90,
  async perceive(ctx) {
    return flagHarvestedRecords({ config, log: ctx.log, days: ctx.days });
  },
  // Identity reason: records are already pursuit-shaped + flagged; do NOT
  // re-filter through the Danielian ICP (that would drop annotated records).
  reason: (raw) => raw,
});

// Export the helpers for the orchestrator / other layers (enrichment-time use).
module.exports.nearTransit = nearTransit;
module.exports.loadStops = loadStops;

if (require.main === module) module.exports.run();
