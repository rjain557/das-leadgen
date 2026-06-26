// agents/hcd/index.js — L5 signal agent: CA HCD / density-bonus / streamlining.
//
// Harvests CA HCD APR/RHNA housing data + SB 35 / SB 423 / builder's-remedy
// streamlining applications off data.ca.gov (CKAN). These feed Danielian's
// affordable / density-bonus product lines, a 6-18 month lead window.
//
// Built on the shared 4-pillar harness: this file declares the SKILL manifest
// and perceive(); the harness supplies CLI parsing, the Danielian ICP filter
// (REASON), output writing to -o (ACT), and the learn loop (LEARN).

const { defineAgent } = require('../shared/agent-harness');
const config = require('./config');
const { fetchHcdSignals } = require('./fetch');

module.exports = defineAgent({
  name: 'hcd',
  layer: 'L5',
  displayName: 'CA HCD / density-bonus / streamlining',
  skill: {
    perceives: 'HCD APR/RHNA + SB35/SB423/builder-remedy streamlining applications',
    sources: ['data.ca.gov (CKAN)'],
    leadTimeMonths: '6-18',
    reasons: 'filter to residential >= minUnits in active metros; flag legislative tailwinds',
    acts: 'emit raw pursuit records',
    learns: 'keep-rate via harness',
  },
  defaultDays: 180,
  async perceive(ctx) {
    return fetchHcdSignals({ days: ctx.days, config, log: ctx.log });
  },
});

if (require.main === module) module.exports.run();
