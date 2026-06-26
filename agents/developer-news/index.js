// agents/developer-news/index.js — L7 signal agent: Developer & national-builder news.
//
// Surfaces developer/builder activity (community announcements, BTR launches,
// land-buy press) for national builders + Danielian's repeat private developers
// — a leading indicator that often precedes architect selection by months.
//
// Built on the shared 4-pillar harness. This agent supplies a CUSTOM `reason`:
// news items are DEVELOPER-ACTIVITY signals, NOT address-keyed pursuits, so the
// default ICP filter (which requires a residential street record) would wrongly
// drop every one of them. We pass the raw records straight through — tagging
// (developer, light url dedup) is done in fetch.js. The orchestrator's
// consolidator skips these for address-dedup by design; the harness still WRITES
// the output file, which the Brief/dossier layer reads.

const { defineAgent } = require('../shared/agent-harness');
const config = require('./config');
const { fetchDeveloperNews } = require('./fetch');

module.exports = defineAgent({
  name: 'developer-news',
  layer: 'L7',
  displayName: 'Developer & national-builder news',
  skill: {
    perceives: 'Google News items for national builders + Danielian repeat developers',
    sources: ['SerpAPI google_news'],
    leadTimeMonths: 'variable',
    reasons: 'tag by developer; light dedup (no address filter)',
    acts: 'emit developer-news signal records (consumed by the Brief/dossier layer)',
    learns: 'item count vs last run',
  },
  defaultDays: 30,
  async perceive(ctx) {
    return fetchDeveloperNews({ days: ctx.days, config, log: ctx.log, force: !!ctx.flags.force });
  },
  reason: (raw) => raw, // news signals; tagging done in fetch
});

if (require.main === module) module.exports.run();
