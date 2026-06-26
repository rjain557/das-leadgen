#!/usr/bin/env node
// agents/permits/la/index.js — L1 signal agent: City of Los Angeles building permits.
//
// LADBS (LA Dept. of Building & Safety) publishes permit issuance as a Socrata
// open-data dataset (data.lacity.org/resource/pi9x-tg5x.json). The 0-3 month
// lead-time signal: a multifamily / mixed-use / ADU permit filing. We harvest the
// SODA API, lightly trim to residential-like rows, and emit raw permit records.
//
// This file lives TWO levels below agents/ (agents/permits/la/), so the harness
// require path is '../../shared/agent-harness' and the shared Socrata client is
// one level up at '../shared-socrata'. The 4-pillar harness supplies CLI parsing,
// the Danielian ICP filter + project-type classification (REASON), output writing
// (ACT), and the keep-rate learn loop (LEARN). We only implement PERCEIVE here,
// delegating to the shared client.

const { defineAgent } = require('../../shared/agent-harness');
const config = require('./config');
const { fetchSocrataPermits } = require('../shared-socrata');

module.exports = defineAgent({
  name: 'la-permits',
  layer: 'L1',
  displayName: 'LA City building permits (Socrata)',
  skill: {
    perceives: 'LA City building & safety permit issuance for residential/multifamily',
    sources: ['data.lacity.org'],
    leadTimeMonths: '0-3',
    reasons: 'filter to multifamily/mixed-use permit types',
    acts: 'emit raw permit records',
    learns: 'count vs last run',
  },
  defaultDays: 90,
  async perceive(ctx) {
    return fetchSocrataPermits({
      metro: 'LA',
      config,
      days: ctx.days,
      maxPages: ctx.maxPages,
      log: ctx.log,
    });
  },
});

if (require.main === module) module.exports.run();
