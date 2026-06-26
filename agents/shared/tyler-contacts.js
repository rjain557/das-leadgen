/**
 * Tyler EnerGov case-detail contacts fetcher.
 *
 * Tyler's PublicAccess SPA loads a case detail page at:
 *   <portal>/EnerGov_Prod/SelfService#/CaseSummary/CaseId/<guid>
 *
 * Behind the scenes it issues several JSON requests; the one we want carries
 * the case's contact roster (Applicant, Owner, Architect/Designer/Professional,
 * Contractor). The exact endpoint name varies by Tyler version
 * (`GetCaseContacts`, `GetCaseInfo`, `GetCaseSummary` etc.), so this fetcher
 * captures *every* JSON response during the navigation and looks for shapes
 * that contain contact-like data — robust to naming variation.
 *
 * Heuristic: any JSON containing an array whose elements have at least one of
 *   { ContactType, ContactRole, RoleType, Role, ContactTypeDescription }
 * along with a name-ish field is treated as a contact list.
 */

const { makeContact, mergeContacts } = require('./contacts');
const { extractContactsLLM } = require('./llm-contacts');

const NAME_KEYS = ['ContactName', 'FullName', 'Name', 'CompanyName', 'BusinessName'];
const ROLE_KEYS = ['ContactType', 'ContactRole', 'RoleType', 'Role', 'ContactTypeDescription', 'ContactTypeName'];
const PHONE_KEYS = ['Phone', 'PhoneNumber', 'PrimaryPhone', 'CellPhone', 'BusinessPhone', 'HomePhone'];
const EMAIL_KEYS = ['Email', 'EmailAddress', 'PrimaryEmail'];
const FIRM_KEYS = ['CompanyName', 'BusinessName', 'OrganizationName'];
const ADDR_KEYS = ['MailingAddress', 'Address', 'FullAddress', 'AddressDisplay'];
const LIC_KEYS = ['LicenseNumber', 'License', 'StateLicenseNumber', 'ProfessionalLicenseNumber'];

function pickFirst(obj, keys) {
  for (const k of keys) {
    const v = obj?.[k];
    if (v != null && String(v).trim().length > 0) return String(v).trim();
  }
  return '';
}

function flattenAddress(obj) {
  if (!obj) return '';
  if (typeof obj === 'string') return obj;
  const parts = [
    obj.AddressLine1, obj.AddressLine2, obj.AddressLine3,
    obj.City, obj.StateName || obj.State, obj.PostalCode || obj.Zip,
  ].filter(Boolean);
  return parts.join(', ');
}

function looksLikeContactList(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return false;
  const sample = arr.find(x => x && typeof x === 'object') || {};
  const hasRole = ROLE_KEYS.some(k => k in sample);
  const hasName = NAME_KEYS.some(k => k in sample);
  return hasRole && hasName;
}

/**
 * Walk a JSON value, yielding any nested array that looks like a contact list.
 * Handles wrappers like { Result: { Contacts: [...] } } or { Contacts: [...] }.
 */
function* findContactArrays(value, depth = 0) {
  if (depth > 6 || value == null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    if (looksLikeContactList(value)) yield value;
    return;
  }
  for (const k of Object.keys(value)) {
    yield* findContactArrays(value[k], depth + 1);
  }
}

function rowToContact(row, source) {
  const role = pickFirst(row, ROLE_KEYS);
  const fullName = pickFirst(row, NAME_KEYS);
  const firm = pickFirst(row, FIRM_KEYS);
  const phone = pickFirst(row, PHONE_KEYS);
  const email = pickFirst(row, EMAIL_KEYS);
  const license = pickFirst(row, LIC_KEYS);

  let mailingAddress = pickFirst(row, ADDR_KEYS);
  if (!mailingAddress && row.MailingAddress && typeof row.MailingAddress === 'object') {
    mailingAddress = flattenAddress(row.MailingAddress);
  }

  return makeContact({
    role,
    name: firm && fullName === firm ? '' : fullName,
    firmName: firm || (fullName && /\b(LLC|Inc|Corp|Architects?|Studio|Design|Group)\b/i.test(fullName) ? fullName : ''),
    phone,
    email,
    mailingAddress,
    license,
    source: source || 'tyler-contacts',
    confidence: 'high',
  });
}

/**
 * Visit a case detail page in the SPA and return the contacts roster.
 * @param {import('playwright').Page} page  authenticated SPA page
 * @param {object} opts
 * @param {string} opts.portalBaseUrl  e.g. 'https://aca-prod.accela.com/...' or Tyler equivalent
 * @param {string} opts.caseSummaryHash  e.g. 'EnerGov_Prod/SelfService#/CaseSummary'
 * @param {string} opts.caseId  GUID
 * @param {number} [opts.timeoutMs=20000]
 * @param {string} [opts.source='tyler-contacts']
 * @returns {Promise<Contact[]>}
 */
async function fetchCaseContacts(page, opts) {
  const {
    portalBaseUrl, caseSummaryHash, caseId,
    // 8s navigation timeout (was 20s). The case-detail page either renders
    // its contacts JSON within ~1-2s of domcontentloaded or doesn't have it.
    // The conservative 20s budget accumulated to ~30 min on cities with 100+
    // cases when even one case stalled — pushing past the orchestrator's
    // per-agent timeout. 8s is enough on a healthy portal and surfaces stalls
    // fast on a slow one.
    timeoutMs = 8000, source = 'tyler-contacts',
  } = opts;
  if (!caseId) return [];

  const captured = [];
  const handler = async (response) => {
    const url = response.url();
    if (!/case|contact|info|summary|detail/i.test(url)) return;
    if (response.status() < 200 || response.status() >= 300) return;
    try {
      const ct = response.headers()['content-type'] || '';
      if (!ct.includes('json')) return;
      const data = await response.json();
      for (const arr of findContactArrays(data)) {
        captured.push({ url, arr });
      }
    } catch { /* not JSON or parse error */ }
  };
  page.on('response', handler);

  let contacts = [];
  try {
    const url = `${portalBaseUrl.replace(/\/$/, '')}${caseSummaryHash.startsWith('/') ? '' : '/'}${caseSummaryHash}/CaseId/${caseId}`;
    await page.goto(url, { timeout: timeoutMs, waitUntil: 'domcontentloaded' });
    // Tyler EnerGov populates the contacts JSON within ~1s of domcontentloaded.
    // Was 2500ms; trimmed to 1200ms. If the JSON didn't arrive in 1.2s it
    // usually never will (a stalled SPA would also miss the old 2.5s window).
    await page.waitForTimeout(1200);

    // Some Tyler installations gate the contacts panel behind a tab click.
    // Only attempt if we haven't already captured contacts in the network
    // pass — saves ~3-5s per case on the common case where contacts arrived
    // alongside the initial load.
    if (captured.length === 0) {
      try {
        const tab = page.locator('a, button, [role="tab"]').filter({ hasText: /^\s*contacts?\s*$/i }).first();
        if (await tab.count() > 0) {
          await tab.click({ timeout: 2000 }).catch(() => {});
          await page.waitForTimeout(1000);
        }
      } catch { /* tab not present */ }
    }

    for (const { arr, url: respUrl } of captured) {
      const sourceTag = `${source}:${respUrl.split('?')[0].split('/').slice(-2).join('/')}`;
      const rows = arr.map(r => rowToContact(r, sourceTag)).filter(Boolean);
      contacts = mergeContacts(contacts, rows);
    }
  } catch {
    // Fallthrough: navigation failed; return whatever we captured before the throw
    for (const { arr, url: respUrl } of captured) {
      const sourceTag = `${source}:${respUrl.split('?')[0].split('/').slice(-2).join('/')}`;
      const rows = arr.map(r => rowToContact(r, sourceTag)).filter(Boolean);
      contacts = mergeContacts(contacts, rows);
    }
  } finally {
    page.off('response', handler);
  }

  // LLM fallback: if DOM/JSON capture produced nothing, ask Claude to extract
  // contacts from the rendered page text. Opt-in — silent no-op if SDK or
  // ANTHROPIC_API_KEY are missing.
  if (contacts.length === 0) {
    try {
      const text = await page.evaluate(() => document.body?.innerText || '');
      if (text && text.trim().length > 100) {
        const llm = await extractContactsLLM(text, {
          context: `Tyler EnerGov case ${caseId}`,
          source: `${source}:llm`,
        });
        if (llm.length > 0) contacts = mergeContacts(contacts, llm);
      }
    } catch { /* never fail the fetch on a fallback error */ }
  }

  return contacts;
}

/**
 * Hydrate an array of leads with contacts. Caches by caseId on a Map you pass
 * in (lets multiple agents share a cache across invocations within a run).
 */
async function hydrateContacts(page, leads, opts = {}) {
  const {
    portalBaseUrl, caseSummaryHash, source = 'tyler-contacts',
    cache = new Map(),
    // Default cap of 80 cases per city. Costa Mesa, Newport Beach, and
    // Huntington Beach can each return 100+ active permits; hydrating all
    // of them at ~3-4s each was the dominant cause of orchestrator timeouts
    // (commit 35601c3 introduced unbounded hydration). Override per-call or
    // via the BBC_CONTACTS_MAX env var when you need full coverage.
    max = parseInt(process.env.DAS_CONTACTS_MAX || process.env.BBC_CONTACTS_MAX, 10) || 80,
    perCaseDelayMs = 150,
  } = opts;
  let processed = 0;
  let skipped = 0;
  for (const lead of leads) {
    if (processed >= max) { skipped = leads.length - processed; break; }
    const id = lead.caseId || lead.CaseId;
    if (!id) continue;
    let contacts = cache.get(id);
    if (!contacts) {
      contacts = await fetchCaseContacts(page, {
        portalBaseUrl, caseSummaryHash, caseId: id, source,
      });
      cache.set(id, contacts);
      if (perCaseDelayMs > 0) await page.waitForTimeout(perCaseDelayMs);
    }
    lead.contacts = mergeContacts(lead.contacts || [], contacts);
    processed++;
  }
  if (skipped > 0) {
    console.warn(`  hydrateContacts: capped at ${max} cases, ${skipped} not hydrated. Set BBC_CONTACTS_MAX env var to raise the limit.`);
  }
  return leads;
}

module.exports = {
  fetchCaseContacts,
  hydrateContacts,
  // Exported for tests
  _internals: { findContactArrays, rowToContact, looksLikeContactList },
};
