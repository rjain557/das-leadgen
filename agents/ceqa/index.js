#!/usr/bin/env node
// agents/ceqa/index.js — L3 signal agent: CEQA / EIR environmental filings.
//
// The earliest pre-RFQ signal (12-18 months out): a developer files a Notice of
// Preparation / EIR / MND with the State Clearinghouse long before any permit or
// RFQ. We harvest CEQAnet, filter to residential / mixed-use, and emit raw
// pursuit records. The 4-pillar harness (../shared/agent-harness) supplies CLI
// parsing, the Danielian ICP filter + project-type classification (REASON),
// output writing (ACT), and the keep-rate learn loop (LEARN). We only implement
// PERCEIVE here via fetch.js.

const { defineAgent } = require('../shared/agent-harness');
const config = require('./config');
const { fetchCeqaFilings } = require('./fetch');

module.exports = defineAgent({
  name: 'ceqa',
  layer: 'L3',
  displayName: 'CEQA / EIR (CEQAnet)',
  skill: {
    perceives: 'CA environmental filings (NOP/NOD/EIR/MND) for residential & mixed-use projects',
    sources: ['ceqanet.opr.ca.gov'],
    leadTimeMonths: '12-18',
    reasons: 'filter to residential/mixed-use >= minUnits; classify project type',
    acts: 'emit raw pursuit records',
    learns: 'keep-rate vs last run via harness',
  },
  // NOP/EIR cadence is slow; a wider default window surfaces more signal.
  defaultDays: 120,
  async perceive(ctx) {
    return fetchCeqaFilings({
      days: ctx.days,
      maxPages: ctx.maxPages,
      headed: ctx.headed,
      config,
      log: ctx.log,
    });
  },
});

if (require.main === module) module.exports.run();
