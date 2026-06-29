// agents/deeds/index.js — L4 signal agent: land transfers / deeds.
//
// Harvests recent GRANT DEEDS + construction DEEDS OF TRUST from the OC Clerk-
// Recorder (RecorderWorks) where a developer/LLC is a party. The GRANTEE on
// these records is the single most valuable *developer-name* signal in the
// pipeline — it becomes developer.rawName (consolidate-lib.normalizeDeveloper),
// which feeds Apollo people-match and the Danielian archive relationship flag.
// Lead window ~6-12 months (land acquired → RFQ).
//
// Built on the shared 4-pillar harness: this file declares the SKILL manifest +
// perceive(); the harness supplies CLI parsing (--days/-o/-f/--max-pages/...),
// output writing to -o as a bare JSON array (ACT), exit-code handling, the self-
// healing retry loop, and the learn loop (LEARN). PERCEIVE lives in scraper.js.
//
// Custom REASON: like developer-news (L7), deed records are DEVELOPER-NAME
// signals, not residential-street pursuits, so the harness's default ICP filter
// (which requires a residential project-type keyword) would wrongly drop them.
// The scraper already constrains to developer/LLC deed/trust types, so here we
// pass records through, attach layer/agent metadata, and best-effort classify
// project type (usually 'unknown' for a bare deed — the consolidator/scorer
// handle that; stage is inferred to 'land-acquired' from the L4 layer).

const { defineAgent } = require('../shared/agent-harness');
const fit = require('../shared/danielian-fit');
const config = require('./config');
const { fetchDeedRecords } = require('./scraper');

const today = () => new Date().toISOString().slice(0, 10);

module.exports = defineAgent({
  name: 'deeds',
  layer: 'L4',
  displayName: 'Land transfers / deeds (OC RecorderWorks)',
  skill: {
    perceives: 'Recent grant deeds + construction deeds of trust with a developer/LLC grantee',
    sources: ['cr.ocgov.com/recorderworks (OC Clerk-Recorder)'],
    leadTimeMonths: '6-12',
    reasons: 'keep deed/trust types with a developer/LLC party; grantee → developer.rawName',
    acts: 'emit raw pursuit records (grantee, grantor, documentType, documentNumber, recordingDate)',
    learns: 'developer-deed count + keep-rate vs last run via harness',
  },
  defaultDays: config.search.defaultDaysBack, // 30 — deeds are frequent
  async perceive(ctx) {
    return fetchDeedRecords({
      days: ctx.days,
      maxPages: ctx.maxPages,
      headed: ctx.headed,
      config,
      log: ctx.log,
    });
  },
  // Pass-through REASON (no residential-keyword filter; scraper already filtered).
  reason(rawRecords, ctx) {
    const out = [];
    for (const raw of rawRecords || []) {
      const rec = Object.assign({}, raw);
      rec.layer = 'L4';
      rec.sourceAgent = 'deeds';
      rec.harvestedAt = rec.harvestedAt || today();
      // Best-effort project-type classification (usually 'unknown' for a bare
      // deed). Leave null → 'unknown' rather than forcing a guess.
      if (rec.projectType == null) {
        const pt = fit.classifyProjectType(rec);
        rec.projectType = pt === 'unknown' ? null : pt;
      }
      out.push(rec);
    }
    if (ctx && ctx.log) ctx.log(`REASON: ${out.length} developer deed/trust records (L4 → stage land-acquired)`);
    return out;
  },
});

if (require.main === module) module.exports.run();
