// consolidate-lib.js — normalize, dedup, and merge multi-source pursuit signals
// into the unified PursuitRecord (spec §5.1). A project seen in CEQA AND a
// permit AND a deed becomes ONE record with three source flags.
const crypto = require('crypto');

function normalizeAddress(addr) {
  return String(addr || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\b(street|avenue|boulevard|road|drive|lane|court|place|parkway|highway)\b/g, m => ({
      street: 'st', avenue: 'ave', boulevard: 'blvd', road: 'rd', drive: 'dr',
      lane: 'ln', court: 'ct', place: 'pl', parkway: 'pkwy', highway: 'hwy',
    }[m] || m))
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanApn(apn) {
  return String(apn || '').replace(/[^0-9]/g, '');
}

// Stable dedup key: sha1(normalizedAddress + apn), 16 hex chars (spec §5.1 id).
function pursuitId(normAddr, apn) {
  return crypto.createHash('sha1').update(`${normAddr}|${cleanApn(apn)}`).digest('hex').slice(0, 16);
}

function pickAddress(raw) {
  if (typeof raw.address === 'string') return raw.address;
  if (raw.address && typeof raw.address === 'object') return raw.address.full || raw.address.line1 || '';
  return raw.siteAddress || raw.propertyAddress || raw.projectAddress || raw.fullAddress || '';
}

// Map one raw agent record → unified PursuitRecord (spec §5.1).
function toPursuitRecord(raw, today) {
  const address = pickAddress(raw);
  const normalizedAddress = normalizeAddress(address);
  const apn = raw.apn || raw.parcel || raw.APN || '';
  const layer = raw.layer || raw.sourceLayer || raw.sourceAgent || 'unknown';
  const ref = raw.ref || raw.caseNumber || raw.permitNumber || raw.documentNumber ||
    raw.schNumber || raw.applicationNumber || '';
  const date = raw.date || raw.appliedDate || raw.recordingDate || raw.meetingDate ||
    raw.filedDate || raw.harvestedAt || today;
  return {
    id: pursuitId(normalizedAddress, apn),
    address, normalizedAddress, apn,
    geo: raw.geo || (raw.lat && raw.lng ? { lat: raw.lat, lng: raw.lng } : null),
    metro: raw.metro || null,
    jurisdiction: raw.jurisdiction || raw.city || raw.sourceCity || null,
    projectType: raw.projectType || 'unknown',
    unitCount: raw.unitCount != null ? raw.unitCount : null,
    stage: raw.stage || inferStage(layer, raw),
    scopeText: raw.scopeText || raw.scope || raw.description || raw.title || '',
    sources: [{ layer, ref, date, url: raw.url || raw.pdfUrl || raw.staffReportUrl || null }],
    developer: raw.developer || normalizeDeveloper(raw),
    contacts: Array.isArray(raw.contacts) ? raw.contacts : [],
    relationship: raw.relationship || { knownDeveloper: false },
    legislative: raw.legislative || { sb79: false, densityBonus: false, builderRemedy: false },
    architectAlreadyNamed: !!raw.architectAlreadyNamed,
    nonResidential: !!raw.nonResidential,
    score: 0, tier: 0, scoreBreakdown: {},
    firstSeen: raw.firstSeen || today,
    lastSeen: today,
    _raw: undefined, // kept lean
  };
}

function inferStage(layer, raw) {
  const l = String(layer).toLowerCase();
  if (l.includes('deed') || l.includes('l4')) return 'land-acquired';
  if (l.includes('ceqa') || l.includes('l3')) return 'ceqa-nop';
  if (l.includes('planning') || l.includes('drb') || l.includes('l2')) return 'entitlement';
  if (l.includes('permit') || l.includes('l1')) return 'permit-filed';
  return 'unknown';
}

function normalizeDeveloper(raw) {
  const rawName = raw.developerName || raw.grantee || raw.applicant || raw.ownerName || '';
  return rawName ? { rawName, resolvedEntity: null, isLLC: /\bllc\b|\bl\.l\.c\b|\binc\b|\bl\.p\b|\blp\b/i.test(rawName) } : null;
}

// Merge two PursuitRecords that resolved to the same id.
function mergeRecords(base, incoming) {
  base.sources = base.sources.concat(incoming.sources);
  base.firstSeen = [base.firstSeen, incoming.firstSeen].filter(Boolean).sort()[0];
  base.lastSeen = [base.lastSeen, incoming.lastSeen].filter(Boolean).sort().slice(-1)[0];
  // Fill blanks from incoming; keep richer values.
  for (const f of ['apn', 'geo', 'metro', 'jurisdiction', 'unitCount', 'scopeText', 'developer']) {
    if (!base[f] && incoming[f]) base[f] = incoming[f];
  }
  // Prefer the more specific (higher-value) project type / earlier stage.
  const STAGE_RANK = { 'land-acquired': 5, 'ceqa-nop': 4, 'entitlement': 3, 'permit-filed': 1, unknown: 0 };
  if ((STAGE_RANK[incoming.stage] || 0) > (STAGE_RANK[base.stage] || 0)) base.stage = incoming.stage;
  if (base.projectType === 'unknown' && incoming.projectType !== 'unknown') base.projectType = incoming.projectType;
  // Merge contacts, relationship, legislative (logical OR).
  base.contacts = dedupeContacts(base.contacts.concat(incoming.contacts || []));
  base.relationship = orFlags(base.relationship, incoming.relationship);
  base.legislative = orFlags(base.legislative, incoming.legislative);
  base.architectAlreadyNamed = base.architectAlreadyNamed || incoming.architectAlreadyNamed;
  return base;
}

function orFlags(a = {}, b = {}) {
  const out = Object.assign({}, a);
  for (const k of Object.keys(b)) out[k] = out[k] || b[k];
  return out;
}

function dedupeContacts(contacts) {
  const seen = new Set(); const out = [];
  for (const c of contacts) {
    const key = `${c.role}|${c.name || ''}|${c.email || ''}|${c.phone || ''}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key); out.push(c);
  }
  return out;
}

// Consolidate a flat list of raw agent records → deduped unified PursuitRecords.
function consolidate(rawRecords, today) {
  const byId = new Map();
  let merged = 0;
  for (const raw of rawRecords) {
    const rec = toPursuitRecord(raw, today);
    if (!rec.normalizedAddress && !rec.apn) continue; // unusable
    const existing = byId.get(rec.id);
    if (existing) { mergeRecords(existing, rec); merged++; }
    else byId.set(rec.id, rec);
  }
  const leads = Array.from(byId.values());
  // multi-source = corroborated by >=2 DISTINCT layers (not 2 rows from one layer)
  for (const l of leads) l.multiSource = distinctLayerCount(l.sources) >= 2;
  return { leads, stats: { rawCount: rawRecords.length, deduped: leads.length, merged } };
}

function distinctLayerCount(sources) {
  return new Set((sources || []).map(s => String(s.layer || '').toUpperCase().split('-')[0])).size;
}

module.exports = { normalizeAddress, cleanApn, pursuitId, toPursuitRecord, mergeRecords, consolidate };
