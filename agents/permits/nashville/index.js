#!/usr/bin/env node
// agents/permits/nashville/index.js — L1 signal agent: Metro Nashville building permits.
//
// Metro Nashville-Davidson publishes building permits via the Socrata (Tyler Data
// & Insights) SODA API. The 0-3 month lead-time signal: a multifamily / mixed-use
// / ADU permit filing. We harvest the SODA API, lightly trim to residential-like
// rows, and emit raw permit records.
//
// Mirrors agents/permits/la/index.js (same shared Socrata client). This file lives
// TWO levels below agents/ (agents/permits/nashville/), so the harness require path
// is '../../shared/agent-harness' and the shared client is one level up at
// '../shared-socrata'. PERCEIVE is the only pillar implemented here; the harness
// supplies REASON (Danielian ICP filter), ACT (output), and LEARN.
//
// NOTE: the agent name is distinct ('nashville-permits' vs 'la-permits') because
// the harness ACT writes output keyed by the agent name; the orchestrator also
// passes -o explicitly so the filename is controlled there.

const { defineAgent } = require('../../shared/agent-harness');
const config = require('./config');
const { fetchSocrataPermits } = require('../shared-socrata');

module.exports = defineAgent({
  name: 'nashville-permits',
  layer: 'L1',
  displayName: 'Nashville building permits (Socrata)',
  skill: {
    perceives: 'Metro Nashville building permit issuance for residential/multifamily',
    sources: ['data.nashville.gov'],
    leadTimeMonths: '0-3',
    reasons: 'filter to multifamily/mixed-use permit types',
    acts: 'emit raw permit records',
    learns: 'count vs last run',
  },
  defaultDays: 90,
  async perceive(ctx) {
    return fetchSocrataPermits({
      metro: 'NASHVILLE',
      config,
      days: ctx.days,
      maxPages: ctx.maxPages,
      log: ctx.log,
    });
  },
});

if (require.main === module) module.exports.run();
