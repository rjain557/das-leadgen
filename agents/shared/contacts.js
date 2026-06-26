/**
 * Shared contacts schema + helpers.
 *
 * Every layer (permits, drb, cdp, recorder, just-sold) populates the same
 * `contacts: Contact[]` array on each lead. Downstream code (dedup, scoring,
 * reporting) reads from this single source of truth.
 *
 *   Contact = {
 *     role:           'Architect' | 'Designer' | 'Professional' | 'Engineer'
 *                   | 'Applicant' | 'Owner' | 'Contractor' | 'Buyer Agent'
 *                   | 'Listing Agent' | 'Other',
 *     name:           string,    // person name if individual
 *     firmName:       string,    // company / firm name
 *     phone:          string,    // E.164-ish or as-published
 *     email:          string,
 *     mailingAddress: string,
 *     license:        string,    // CA license number where known
 *     source:         string,    // 'tyler-contacts' | 'etrakit' | 'dca' | 'pdf' | …
 *     confidence:     'high' | 'medium' | 'low',
 *   }
 *
 * Roles are normalised on insert. Canonical labels are the keys of ROLE_MAP.
 */

const ROLE_MAP = {
  // Architect family
  architect: 'Architect',
  designer: 'Designer',
  professional: 'Professional',
  engineer: 'Engineer',
  'design professional': 'Professional',
  'project architect': 'Architect',
  'architect of record': 'Architect',
  // Owner / applicant
  applicant: 'Applicant',
  'applicant of record': 'Applicant',
  owner: 'Owner',
  'owner of record': 'Owner',
  'property owner': 'Owner',
  // Contractor
  contractor: 'Contractor',
  'general contractor': 'Contractor',
  builder: 'Contractor',
  // Real-estate
  'buyer agent': 'Buyer Agent',
  'buyers agent': 'Buyer Agent',
  'listing agent': 'Listing Agent',
  agent: 'Listing Agent',
};

const ARCHITECT_ROLES = new Set(['Architect', 'Designer', 'Professional', 'Engineer']);

function canonicalRole(raw) {
  const k = String(raw || '').trim().toLowerCase();
  return ROLE_MAP[k] || (k ? raw.trim() : 'Other');
}

function normalizePhone(p) {
  const digits = String(p || '').replace(/\D/g, '');
  if (digits.length === 10) return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
  if (digits.length === 11 && digits.startsWith('1')) {
    return `(${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`;
  }
  return String(p || '').trim();
}

function clean(s) {
  return String(s || '').replace(/\s+/g, ' ').trim();
}

function makeContact(input) {
  const c = {
    role: canonicalRole(input.role),
    name: clean(input.name),
    firmName: clean(input.firmName || input.firm || input.company),
    phone: normalizePhone(input.phone),
    email: clean(input.email).toLowerCase(),
    mailingAddress: clean(input.mailingAddress || input.address),
    license: clean(input.license).toUpperCase(),
    source: clean(input.source) || 'unknown',
    confidence: input.confidence || 'medium',
  };
  // Drop entirely empty contacts
  if (!c.name && !c.firmName && !c.phone && !c.email) return null;
  return c;
}

/**
 * Merge a new contact into an existing array, deduping by (role, name|firm, email|phone).
 * Existing contact wins on most fields; new contact fills in blanks.
 */
function mergeContacts(existing, incoming) {
  const out = [...(existing || [])];
  for (const raw of (incoming || [])) {
    const c = raw && raw.role ? raw : makeContact(raw || {});
    if (!c) continue;
    const dup = out.find(x =>
      x.role === c.role &&
      ((x.name && c.name && x.name.toLowerCase() === c.name.toLowerCase())
        || (x.firmName && c.firmName && x.firmName.toLowerCase() === c.firmName.toLowerCase())
        || (x.email && c.email && x.email === c.email)
        || (x.phone && c.phone && x.phone.replace(/\D/g, '') === c.phone.replace(/\D/g, '')))
    );
    if (dup) {
      dup.firmName = dup.firmName || c.firmName;
      dup.phone = dup.phone || c.phone;
      dup.email = dup.email || c.email;
      dup.mailingAddress = dup.mailingAddress || c.mailingAddress;
      dup.license = dup.license || c.license;
      // Track the union of sources
      if (dup.source !== c.source) {
        dup.source = Array.from(new Set(`${dup.source},${c.source}`.split(','))).join(',');
      }
    } else {
      out.push(c);
    }
  }
  return out;
}

/**
 * Pick the best architect contact from a contacts[] array.
 * Order of preference: Architect → Designer → Professional → Engineer → applicant
 * whose name/firm strongly suggests an architecture or design practice.
 *
 * The applicant heuristic is the workhorse — most municipal portals only file
 * a single "Applicant" role, even when the applicant is the architect of
 * record. We catch as many of those as we can without polluting downstream
 * scoring (e.g. excluding contractors who happen to have "Builders" in their
 * name).
 */
function pickArchitect(contacts) {
  if (!Array.isArray(contacts) || contacts.length === 0) return null;
  const archRoles = ['Architect', 'Designer', 'Professional', 'Engineer'];
  for (const role of archRoles) {
    const hit = contacts.find(c => c.role === role);
    if (hit) return hit;
  }
  // Strong positive signals — high specificity for architecture / design firms.
  const strong = /\b(architect(ure|s)?|aia|architectural|archt\.?|design\s+studio|design\s+group|interior\s+design|interiors|atelier)\b/i;
  // Weak signals — broader words that need to be paired with absence of strong
  // negatives (e.g. "Builders", "Construction", "Plumbing") to avoid false
  // positives on contractors whose names happen to include "design".
  const weakHint = /\b(design|studio|drafting|planning)\b/i;
  const negative = /\b(builder|builders|construction|contractors?|electric(al)?|plumbing|mechanical|hvac|roofing|paint(ing)?|landscaping)\b/i;

  // Pass 1: strong signal on firm or name.
  const strongHit = contacts.find(c =>
    c.role === 'Applicant' && (strong.test(c.firmName) || strong.test(c.name))
  );
  if (strongHit) return strongHit;
  // Pass 2: weak signal AND no contractor negative.
  return contacts.find(c =>
    c.role === 'Applicant' &&
    (weakHint.test(c.firmName) || weakHint.test(c.name)) &&
    !negative.test(c.firmName) && !negative.test(c.name)
  ) || null;
}

function pickByRole(contacts, role) {
  if (!Array.isArray(contacts)) return null;
  return contacts.find(c => c.role === role) || null;
}

/**
 * Promote contacts[] entries into the legacy top-level fields on a lead.
 * Backward-compatible: existing top-level fields win if already populated.
 */
function promoteContactsToLead(lead) {
  if (!lead || !Array.isArray(lead.contacts) || lead.contacts.length === 0) return lead;
  const arch = pickArchitect(lead.contacts);
  const owner = pickByRole(lead.contacts, 'Owner');
  const applicant = pickByRole(lead.contacts, 'Applicant');
  const contractor = pickByRole(lead.contacts, 'Contractor');

  if (arch) {
    lead.architect = lead.architect || {};
    lead.architect.name = lead.architect.name || arch.name;
    lead.architect.firmName = lead.architect.firmName || arch.firmName;
    lead.architect.phone = lead.architect.phone || arch.phone;
    lead.architect.email = lead.architect.email || arch.email;
    lead.architect.license = lead.architect.license || arch.license;
  }
  if (applicant) {
    lead.applicant = lead.applicant || {};
    lead.applicant.name = lead.applicant.name || applicant.name || applicant.firmName;
    lead.applicant.role = lead.applicant.role || applicant.role;
  }
  if (owner && (!lead.owner || !lead.owner.name)) {
    lead.owner = lead.owner || {};
    lead.owner.name = lead.owner.name || owner.name;
    lead.owner.phone = lead.owner.phone || owner.phone;
    lead.owner.email = lead.owner.email || owner.email;
    lead.owner.mailingAddress = lead.owner.mailingAddress || owner.mailingAddress;
  }
  if (contractor) {
    lead.contractor = lead.contractor || {};
    lead.contractor.name = lead.contractor.name || contractor.name || contractor.firmName;
    lead.contractor.isAssigned = true;
  }
  return lead;
}

module.exports = {
  ROLE_MAP,
  ARCHITECT_ROLES,
  canonicalRole,
  normalizePhone,
  makeContact,
  mergeContacts,
  pickArchitect,
  pickByRole,
  promoteContactsToLead,
};
