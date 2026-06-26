// score-lib.js — config-driven scoring for Danielian Pursuit Intelligence.
// Implements spec §6 by reading config/scoring.json (no rubric in code, so it
// can be tuned during the pilot). Replaces BBC's hardcoded scoreLead().
const fs = require('fs');
const path = require('path');

const SCORING_PATH = path.resolve(__dirname, '..', 'config', 'scoring.json');
const ICP_PATH = path.resolve(__dirname, '..', 'config', 'das-icp.json');

let _cfg = null;
function loadScoring() {
  if (_cfg) return _cfg;
  _cfg = JSON.parse(fs.readFileSync(SCORING_PATH, 'utf8'));
  return _cfg;
}

let _icp = null;
function loadIcp() {
  if (_icp) return _icp;
  try { _icp = JSON.parse(fs.readFileSync(ICP_PATH, 'utf8')); } catch { _icp = {}; }
  return _icp;
}

function activeMetros() {
  const icp = loadIcp();
  return icp.activeMetros || Object.keys(icp.metros || { OC: 1 });
}
function allMetros() {
  const icp = loadIcp();
  return Object.keys(icp.metros || { OC: 1, LA: 1, NASHVILLE: 1 });
}

// lead: unified pursuit record (projectType, stage, unitCount, metro,
// relationship{knownDeveloper,knownMunicipality}, legislative{sb79,densityBonus,
// builderRemedy}, sources[], architectAlreadyNamed, nonResidential).
function scoreLead(lead = {}, opts = {}) {
  const cfg = loadScoring();
  const active = opts.activeMetros || activeMetros();
  const all = opts.allMetros || allMetros();
  const bd = {};
  let score = 0;
  const add = (key, pts) => { if (pts) { score += pts; bd[key] = (bd[key] || 0) + pts; } };

  // Project type
  const pt = lead.projectType || 'unknown';
  add(`projectType:${pt}`, cfg.projectTypePoints[pt] || 0);

  // Stage
  const stage = lead.stage || 'unknown';
  add(`stage:${stage}`, cfg.stagePoints[stage] || 0);

  // Scale (first matching unit band)
  const units = Number(lead.unitCount) || 0;
  if (units > 0) {
    for (const band of cfg.scalePoints) {
      if (units >= band.minUnits) { add(`scale:>=${band.minUnits}u`, band.points); break; }
    }
  }

  // Geography
  const inActive = lead.metro && active.includes(lead.metro);
  if (inActive) add('geo:activeMetro', cfg.geographyPoints.activeMetro);

  // Relationship (the strongest activation signal — archive cross-ref §8.4)
  const rel = lead.relationship || {};
  if (rel.knownDeveloper || rel.knownRepeatDeveloper) add('relationship:knownDeveloper', cfg.relationshipPoints.knownRepeatDeveloper);
  if (rel.knownMunicipality) add('relationship:knownMunicipality', cfg.relationshipPoints.knownMunicipality);

  // Legislative tailwind ("why now")
  const leg = lead.legislative || {};
  if (leg.sb79 || leg.densityBonus || leg.builderRemedy) add('legislative:tailwind', cfg.legislativePoints.anyTailwind);

  // Multi-source corroboration — requires >=2 DISTINCT layers (e.g. CEQA + deed),
  // not two rows from the same layer.
  const distinctLayers = new Set((lead.sources || []).map(s => String(s.layer || '').toUpperCase().split('-')[0])).size;
  if (distinctLayers >= 2) add('multiSource', cfg.multiSourcePoints);

  // Penalties
  if (lead.architectAlreadyNamed) add('penalty:architectNamed', cfg.penalties.architectOfRecordNamed);
  if (lead.metro && !all.includes(lead.metro)) add('penalty:outsideGeography', cfg.penalties.outsideGeography);
  if (lead.nonResidential) add('penalty:nonResidential', cfg.penalties.nonResidential);

  const tier = assignTier(score, cfg);
  return { score, tier, scoreBreakdown: bd };
}

function assignTier(score, cfg = loadScoring()) {
  if (score >= cfg.tiers.tier1) return 1;
  if (score >= cfg.tiers.tier2) return 2;
  if (score >= cfg.tiers.tier3) return 3;
  return 0; // Drop
}

function scoreAll(leads = [], opts = {}) {
  const active = opts.activeMetros || activeMetros();
  const all = opts.allMetros || allMetros();
  const counts = { 1: 0, 2: 0, 3: 0, 0: 0 };
  for (const lead of leads) {
    const { score, tier, scoreBreakdown } = scoreLead(lead, { activeMetros: active, allMetros: all });
    lead.score = score; lead.tier = tier; lead.scoreBreakdown = scoreBreakdown;
    counts[tier]++;
  }
  return { leads, tierCounts: { tier1: counts[1], tier2: counts[2], tier3: counts[3], dropped: counts[0] } };
}

module.exports = { scoreLead, scoreAll, assignTier, loadScoring, activeMetros, allMetros };
