// danielian-fit.js — ICP (Ideal Customer Profile) classifier for Danielian
// Pursuit Intelligence. This is the FORK of BBC's client-fit.js, inverted:
// BBC targeted luxury single-family and REJECTED multifamily; Danielian is a
// multifamily / BTR / ADU / affordable / mixed-use / master-planning firm, so
// those project types are exactly what we want to surface.
//
// Keyword sets default in-code but are OVERRIDABLE via config/das-icp.json so a
// non-developer can tune the ICP without touching code (per spec §14
// "config over code"). Exports the same helper surface BBC agents expect
// (isLikelyActiveStatus / isLikelyRecent / isPlanCheckPhase) so ported permit
// agents keep working, plus classifyProjectType() which feeds the scorer.
const fs = require('fs');
const path = require('path');

function normalize(value) { return String(value || '').toLowerCase(); }
function compactText(parts) {
  return parts.map(normalize).filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}
function includesAny(text, keywords) { return keywords.some(k => text.includes(k)); }

function parseDate(rawValue) {
  if (!rawValue) return null;
  if (rawValue instanceof Date && !Number.isNaN(rawValue.getTime())) return rawValue;
  const s = String(rawValue).trim();
  if (!s) return null;
  const parsed = new Date(s);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

// --- Project-type vocabularies (defaults; overridable via das-icp.json) -----
const DEFAULTS = {
  projectTypeKeywords: {
    'master-plan': ['master plan', 'master-plan', 'master planned', 'master-planned',
      'specific plan', 'planned community', 'planned unit development', ' pud ', 'village'],
    'mixed-use': ['mixed use', 'mixed-use', 'live/work', 'live-work', 'ground floor retail',
      'ground-floor retail', 'residential over retail', 'vertical mixed'],
    'affordable': ['affordable', 'low income', 'low-income', 'lihtc', 'tax credit',
      'inclusionary', 'density bonus', 'supportive housing', 'workforce housing',
      'permanent supportive', 'transitional housing', 'sb 35', 'sb35', 'sb 423', 'sb423',
      "builder's remedy", 'builders remedy'],
    'btr': ['build-to-rent', 'build to rent', ' btr ', 'rental community', 'for-rent community',
      'single family rental', 'sfr community', 'horizontal apartment', 'detached rental'],
    'multifamily': ['multifamily', 'multi-family', 'multi family', 'apartment', 'apartments',
      'condominium', 'condo', 'townhome', 'townhouse', 'townhomes', ' mfr ', 'flats',
      'senior living', 'assisted living', 'independent living', 'student housing',
      'dwelling units', 'residential units', 'attached residential', 'rowhouse', 'rowhomes'],
    'adu-batch': ['adu', 'jadu', 'accessory dwelling', 'accessory dwelling unit'],
    'sfr': ['single family', 'single-family', ' sfd', ' sfr', 'custom home', 'new residence',
      'new dwelling', 'detached home'],
  },
  // Hard rejects ONLY when no residential signal is present (mixed-use legitimately
  // contains retail/office, so these are not absolute).
  nonResidentialHints: ['tenant improvement', 'industrial', 'warehouse', 'distribution center',
    'self storage', 'self-storage', 'gas station', 'cell site', 'antenna', 'monopole',
    'parking structure only', 'data center', 'manufacturing', 'pure retail', 'pure office'],
  // Minor scope = not a development pursuit.
  minorScopeHints: ['reroof', 're-roof', 'water heater', 'window replacement', 'fence',
    'patio cover', 'repair', 'repipe', 'pool', 'spa', 'sign permit', 'demolition only',
    'temporary', 'grading only'],
  testHints: ['test record', 'test permit', 'this report is optional', 'sample data'],
  // ADU is "batch" (a Danielian line under SB 1211) only at this unit count or above.
  aduBatchMinUnits: 4,
  // Statuses that mean the pursuit window is closed.
  completedStatusKeywords: ['cleared', 'completed', 'complete', 'denied', 'expired', 'void',
    'withdrawn', 'cancelled', 'final', 'closed', 'declined', 'certificate of occupancy', 'c of o'],
  activeStatusHints: ['plan check', 'under review', 'in review', 'in process', 'pending',
    'submitted', 'submission', 'application accepted', 'entitlement', 'notice of preparation',
    'nop', 'environmental review', 'scoping', 'hearing', 'agenda', 'preliminary'],
  // Phrases that mean the architect is already chosen → "too late" (scoring penalty).
  architectOfRecordHints: ['architect of record', 'architect:', 'designed by', 'aor:',
    'design architect', 'project architect'],
};

let CFG = null;
function loadIcpConfig() {
  if (CFG) return CFG;
  CFG = JSON.parse(JSON.stringify(DEFAULTS));
  try {
    const p = path.resolve(__dirname, '..', '..', 'config', 'das-icp.json');
    if (fs.existsSync(p)) {
      const override = JSON.parse(fs.readFileSync(p, 'utf8'));
      CFG = Object.assign(CFG, override, {
        projectTypeKeywords: Object.assign({}, CFG.projectTypeKeywords, override.projectTypeKeywords || {}),
      });
    }
  } catch { /* fall back to defaults */ }
  return CFG;
}

function recordText(record = {}) {
  return compactText([
    record.type, record.workClass, record.subType, record.category, record.msType,
    record.projectType, record.status, record.stage, record.description, record.scope,
    record.scopeText, record.title, record.address, record.permitNumber, record.planNumber,
    record.caseNumber, record.documentType,
  ]);
}

// Returns one of: master-plan | mixed-use | affordable | btr | adu-batch |
// multifamily | sfr | unknown. Priority order favors Danielian's higher-value lines.
function classifyProjectType(record = {}) {
  const cfg = loadIcpConfig();
  const text = ' ' + recordText(record) + ' ';
  const units = Number.isFinite(record.unitCount) ? record.unitCount
    : parseInt(record.unitCount, 10) || extractUnitCount(text);

  const k = cfg.projectTypeKeywords;
  if (includesAny(text, k['master-plan'])) return 'master-plan';
  if (includesAny(text, k['affordable'])) return 'affordable';
  if (includesAny(text, k['mixed-use'])) return 'mixed-use';
  if (includesAny(text, k['btr'])) return 'btr';
  if (includesAny(text, k['multifamily'])) return 'multifamily';
  if (includesAny(text, k['adu-batch'])) {
    return (units && units >= cfg.aduBatchMinUnits) ? 'adu-batch' : 'sfr';
  }
  if (includesAny(text, k['sfr'])) return 'sfr';
  return 'unknown';
}

// Best-effort unit count from free text: "84-unit", "84 units", "84 dwelling units".
function extractUnitCount(text) {
  const m = String(text).match(/(\d{1,4})\s*(?:-\s*)?(?:unit|units|dwelling units|du\b|apartments|condos|townhomes)/i);
  return m ? parseInt(m[1], 10) : null;
}

// Is this record in Danielian's ICP at all (residential development in scope)?
function isDanielianFit(record = {}) {
  const cfg = loadIcpConfig();
  const text = recordText(record);
  if (!text) return false;
  if (includesAny(text, cfg.testHints)) return false;

  const type = classifyProjectType(record);
  const hasResidentialDev = type !== 'unknown';

  // Pure non-residential with no residential signal → out of ICP.
  if (!hasResidentialDev && includesAny(text, cfg.nonResidentialHints)) return false;
  // Minor-scope-only with no development signal → out.
  if (!hasResidentialDev && includesAny(text, cfg.minorScopeHints)) return false;

  // Keep anything classified as a residential development type. Lone "sfr" is
  // kept (low value, scored down) — BTR/master-plan can read as SFR at MVP.
  return hasResidentialDev;
}

function hasNamedArchitectOfRecord(record = {}) {
  const cfg = loadIcpConfig();
  const text = recordText(record);
  if (record.architect && String(record.architect).trim()) return true;
  if (record.contacts && record.contacts.some(c => /architect/i.test(c.role || ''))) return true;
  return includesAny(text, cfg.architectOfRecordHints);
}

function isLikelyActiveStatus(status, options = {}) {
  const cfg = loadIcpConfig();
  const s = normalize(status);
  if (!s) return true;
  const completed = cfg.completedStatusKeywords.concat((options.completedStatuses || []).map(normalize));
  if (includesAny(s, completed)) return false;
  if (includesAny(s, cfg.activeStatusHints)) return true;
  return true;
}

function isLikelyRecent(appliedDate, options = {}) {
  const parsed = parseDate(appliedDate);
  if (!parsed) return true;
  const now = new Date();
  let cutoff;
  if (Number.isFinite(options.daysBack)) {
    cutoff = new Date(now.getTime() - options.daysBack * 86400000);
  } else {
    const yearsBack = Number.isFinite(options.yearsBack) ? options.yearsBack : 2;
    cutoff = new Date(now.getFullYear() - yearsBack, 0, 1);
  }
  return parsed >= cutoff;
}

function isPlanCheckPhase(status) {
  const s = normalize(status);
  return s.includes('plan check') || s.includes('plancheck');
}

module.exports = {
  isDanielianFit,
  classifyProjectType,
  extractUnitCount,
  hasNamedArchitectOfRecord,
  isLikelyActiveStatus,
  isLikelyRecent,
  isPlanCheckPhase,
  // Back-compat alias so any directly-ported BBC agent that imports the old
  // name keeps running while it is retargeted.
  isBurkhartFit: isDanielianFit,
};
