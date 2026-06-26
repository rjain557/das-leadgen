function normalize(value) {
  return String(value || '').toLowerCase();
}

function compactText(parts) {
  return parts
    .map(normalize)
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function includesAny(text, keywords) {
  return keywords.some(keyword => text.includes(keyword));
}

function includesAll(text, keywords) {
  return keywords.every(keyword => text.includes(keyword));
}

function parseDate(rawValue) {
  if (!rawValue) return null;
  if (rawValue instanceof Date && !Number.isNaN(rawValue.getTime())) return rawValue;

  const asString = String(rawValue).trim();
  if (!asString) return null;

  const parsed = new Date(asString);
  if (!Number.isNaN(parsed.getTime())) return parsed;
  return null;
}

const DEFAULT_COMPLETED_STATUS_KEYWORDS = [
  'cleared',
  'completed',
  'complete',
  'denied',
  'expired',
  'void',
  'withdrawn',
  'cancelled',
  'final',
  'closed',
  'processed',
  'declined',
  // NOTE: 'approved' and 'issued' deliberately EXCLUDED — for County of Orange
  // and other portals, these mean "permit granted, construction starting" which
  // is exactly the lead window BBC wants. They are NOT completed statuses.
];

const ACTIVE_STATUS_HINTS = [
  'plan check',
  'under review',
  'in review',
  'in process',
  'pending',
  'submitted',
  'submission',
  'correction',
  'recheck',
  'verifying submittal',
  'application accepted',
  'additional info',
  'ready to issue',
  'preparing',
  'fees due',
];

const RESIDENTIAL_HINTS = [
  'residential',
  'single family',
  'new sfd',
  'sfd',
  'sfr',
  'combo residential',
  'new dwelling',
  'new residence',
  'custom home',
  'adu',
  'jadu',
  'guest house',
  'dwelling unit',
];

const MAJOR_SCOPE_HINTS = [
  'new construction',
  'new single family',
  'new dwelling',
  'new residence',
  'new sfd',
  'new sfr',
  'addition',
  'add/alter',
  'alteration',
  'remodel',
  'renovation',
  'rebuild',
  'demo',
  'demolition',
  'second floor',
  '2nd floor',
  'basement',
  'subterranean',
  '3-car',
  'three car',
];

const NON_TARGET_HINTS = [
  'commercial',
  'tenant improvement',
  'public works',
  'cip',
  'cell site',
  'antenna',
  'code enforcement',
  'mechanical',
  'electrical',
  'plumbing',
  'photovoltaic',
  'solar',
  'storm drain',
  'retail',
  'office',
  'school',
  'church',
  'hotel',
  'restaurant',
  'gas station',
  'industrial',
  'multifamily',
  'multi-family',
  'apartment',
  'condo',
  'condominium',
  'mfr',
];

const MINOR_ONLY_HINTS = [
  'reroof',
  're-roof',
  'window replacement',
  'door replacement',
  'fence',
  'wall',
  'patio cover',
  'trellis',
  'repair',
  'waterproofing',
  'repipe',
  'sprinkler',
  'pool demolition',
];

const TEST_HINTS = [
  'test record',
  'test permit',
  'this report is optional',
  // NOTE: 'confidential' deliberately EXCLUDED — County of Orange Maintstar
  // uses "(Confidential)" as the description for ALL public records. It's not
  // test data, it's the portal hiding descriptions publicly.
];

function isLikelyActiveStatus(status, options = {}) {
  const statusText = normalize(status);
  const completedStatuses = (options.completedStatuses || []).map(normalize);

  if (!statusText) return true;

  const allCompleted = DEFAULT_COMPLETED_STATUS_KEYWORDS.concat(completedStatuses);
  if (includesAny(statusText, allCompleted)) return false;

  if (includesAny(statusText, ACTIVE_STATUS_HINTS)) return true;

  // If status is neither obviously closed nor obviously active, keep it.
  return true;
}

function isBurkhartFit(record = {}) {
  const text = compactText([
    record.type,
    record.workClass,
    record.subType,
    record.category,
    record.msType,
    record.status,
    record.description,
    record.address,
    record.permitNumber,
    record.planNumber,
  ]);

  if (!text) return false;
  // Strip "(confidential)" from text — Maintstar portals use this for all records
  const cleanText = text.replace(/\(confidential\)/g, '').replace(/\s+/g, ' ').trim();
  if (includesAny(cleanText, TEST_HINTS)) return false;
  if (includesAny(cleanText, NON_TARGET_HINTS)) return false;

  const hasResidentialSignal = includesAny(cleanText, RESIDENTIAL_HINTS);
  const hasMajorScope = includesAny(cleanText, MAJOR_SCOPE_HINTS);
  const hasMinorOnlySignal = includesAny(cleanText, MINOR_ONLY_HINTS);

  const isAduOnly =
    includesAny(cleanText, [' adu', 'adu ', ' jadu', 'jadu ']) &&
    !includesAny(cleanText, ['single family', 'sfd', 'sfr', 'addition', 'remodel', 'rebuild', 'demo', 'new residence', 'new dwelling']);

  if (isAduOnly) return false;
  if (hasMinorOnlySignal && !hasMajorScope) return false;

  if (!hasResidentialSignal) {
    const inferredResidential =
      includesAny(cleanText, ['new sfd', 'new sfr', 'single family', 'custom home']) ||
      (includesAll(cleanText, ['new', 'garage']) && !includesAny(cleanText, ['commercial', 'industrial']));
    if (!inferredResidential) return false;
  }

  return hasMajorScope;
}

function isLikelyRecent(appliedDate, options = {}) {
  const parsed = parseDate(appliedDate);
  if (!parsed) return true;

  const now = new Date();
  let cutoff;

  if (Number.isFinite(options.daysBack)) {
    cutoff = new Date(now.getTime() - options.daysBack * 24 * 60 * 60 * 1000);
  } else {
    const yearsBack = Number.isFinite(options.yearsBack) ? options.yearsBack : 3;
    cutoff = new Date(now.getFullYear() - yearsBack, 0, 1);
  }

  return parsed >= cutoff;
}

function isPlanCheckPhase(status) {
  const s = normalize(status);
  return s.includes('plan check') || s.includes('plancheck');
}

module.exports = {
  isBurkhartFit,
  isLikelyActiveStatus,
  isLikelyRecent,
  isPlanCheckPhase,
};
