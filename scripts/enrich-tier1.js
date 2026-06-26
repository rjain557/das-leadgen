#!/usr/bin/env node
// enrich-tier1.js — focused enrichment of the Tier-1 pursuits only (keeps API
// quota sane vs enriching all ~1,400 leads). For each Tier-1 pursuit:
//   1. ATTOM expandedprofile (by APN+FIPS, else by address) → owner, assessed
//      value, last sale, mailing address, corporate-owner flag
//   2. Hunter domain/company search → developer-side decision-maker contacts
//      (CEO/CTO/VP-Development/Land-Acquisition titles)
//   3. resolve-developer-entity → LLC → principal + Danielian archive cross-ref
// Writes the enriched leads back into the latest full-run JSON, then the Brief
// can render dossiers with owners + contacts. Cached + graceful (never throws).
const fs = require('fs');
const path = require('path');
const { loadEnv } = require('../agents/shared/load-env');
const { makeContact, mergeContacts } = require('../agents/shared/contacts');
const entity = require('./resolve-developer-entity');
const caSos = require('./resolve-ca-sos'); // FREE CA SOS bizfile resolver (Apollo fallback)

loadEnv();
const OUT = path.resolve(__dirname, '..', 'data', 'output');
const CACHE = path.join(OUT, 'enrich-cache.json');
const ATTOM_BASE = 'https://api.gateway.attomdata.com/propertyapi/v1.0.0';
const FIPS = { OC: '06059', LA: '06037', NASHVILLE: '47037' };
const sleep = ms => new Promise(r => setTimeout(r, ms));

function loadCache() { try { return JSON.parse(fs.readFileSync(CACHE, 'utf8')); } catch { return {}; } }
function saveCache(c) { try { fs.writeFileSync(CACHE, JSON.stringify(c, null, 2)); } catch {} }
function latestFullRun() {
  const files = fs.readdirSync(OUT).filter(f => /^full-run-.*\.json$/.test(f)).sort();
  return files.length ? path.join(OUT, files[files.length - 1]) : null;
}
const isCorporate = name => /\b(llc|l\.l\.c|inc|incorporated|corp|company|co|lp|l\.p|ltd|holdings|partners|trust|communities|properties|development|group|capital|residential|homes|builders?)\b/i.test(name || '');

// Hunter company-search on opaque SPE/holding LLCs ("RCR BRISTOL LLC",
// "RAJO INVESTMENTS LLC") returns confidently-WRONG contacts (matched a UK
// hospital, a Brazilian firm). For a client-facing ABM Brief, a wrong contact
// is worse than none. So only run Hunter for owners that map to a recognizable
// developer with a reliable domain. The proper path for the rest is
// entity-resolution (OpenCorporates → domain), gated on that signup. Until then
// we surface the verified owner name + mailing address (real, from ATTOM).
const KNOWN_DEVELOPERS = [
  'meritage', 'lennar', 'd.r. horton', 'dr horton', 'toll brothers', 'tri pointe',
  'tripointe', 'taylor morrison', 'brookfield', 'city ventures', 'greystar',
  'related', 'avalonbay', 'shea', 'kb home', 'pulte', 'centex', 'tpg',
  'trumark', 'landsea', 'william lyon', 'irvine company', 'the new home company',
];
const isKnownDeveloper = name => {
  const n = String(name || '').toLowerCase();
  return KNOWN_DEVELOPERS.find(d => n.includes(d)) || null;
};

async function attomFetch(url, apikey) {
  try {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 15000);
    const res = await fetch(url, { headers: { apikey, Accept: 'application/json' }, signal: ctl.signal });
    clearTimeout(t);
    if (!res.ok) return { error: res.status };
    const data = await res.json();
    const p = (data.property || [])[0];
    if (!p) return { error: 'not-found' };
    const owner = p.assessment?.owner || {};
    return {
      ownerName: owner.owner1?.fullName || '',
      corporate: owner.corporateIndicator === 'Y' || isCorporate(owner.owner1?.fullName),
      mailingAddress: owner.mailingAddressOneLine || '',
      assessedValue: p.assessment?.assessed?.assdTtlValue || null,
      saleAmount: p.sale?.amount?.saleAmt || null,
      saleDate: p.sale?.saleTransDate || null,
      apn: p.identifier?.apn || null,
      lotSize: p.lot?.lotSize2 || null,
      zoning: p.lot?.siteZoningIdent || null,
    };
  } catch { return { error: 'fetch' }; }
}

async function attomLookup(lead, cache) {
  const key = `attom:${lead.apn || lead.normalizedAddress}`;
  if (cache[key]) return cache[key];
  const apikey = process.env.ATTOM_API_KEY;
  if (!apikey) return null;
  const fips = FIPS[lead.metro] || FIPS.OC;
  // Try APN first, then fall back to address (pre-development parcels often
  // miss on APN but resolve by address, and vice-versa).
  const urls = [];
  if (lead.apn) urls.push(`${ATTOM_BASE}/property/expandedprofile?apn=${encodeURIComponent(String(lead.apn).replace(/[^0-9]/g, ''))}&fips=${fips}`);
  if (lead.address) {
    const parts = String(lead.address).split(',').map(s => s.trim()).filter(Boolean);
    if (parts.length >= 2) {
      const street = parts[0], city = parts[1];
      const zip = (String(lead.address).match(/\b(\d{5})\b/) || [])[1] || '';
      urls.push(`${ATTOM_BASE}/property/expandedprofile?address1=${encodeURIComponent(street)}&address2=${encodeURIComponent(`${city}, CA ${zip}`.trim())}`);
    }
  }
  let last = { error: 'no-query' };
  for (const url of urls) {
    const r = await attomFetch(url, apikey);
    if (r && !r.error) { cache[key] = r; return r; }
    last = r;
    await sleep(150);
  }
  return last;                                          // not cached → retried next run
}

async function hunterContacts(company, cache) {
  const key = `hunter:${String(company).toLowerCase().trim()}`;
  if (cache[key]) return cache[key];
  const apiKey = process.env.HUNTER_API_KEY;
  if (!apiKey || !company) return [];
  const url = `https://api.hunter.io/v2/domain-search?company=${encodeURIComponent(company)}&limit=10&api_key=${apiKey}`;
  try {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 15000);
    const res = await fetch(url, { signal: ctl.signal });
    clearTimeout(t);
    if (!res.ok) { cache[key] = []; return []; }
    const data = await res.json();
    const emails = data?.data?.emails || [];
    const DM = /(chief|ceo|cto|coo|cfo|president|vp|vice president|principal|partner|director|development|acquisition|land|managing)/i;
    const contacts = emails
      .filter(e => e.type !== 'generic')
      .map(e => ({ ...e, _dm: DM.test(e.position || '') }))
      // Require a real person name AND a decision-maker title — Hunter company
      // search on opaque SPE/holding LLC names otherwise returns wrong-company
      // emails. Quality over quantity until entity-resolution provides a domain.
      .filter(e => e.first_name && e.last_name && e._dm)
      .sort((a, b) => ((b.confidence || 0) - (a.confidence || 0)))
      .slice(0, 4)
      .map(e => makeContact({
        role: e._dm ? 'developer-exec' : 'Other',
        name: [e.first_name, e.last_name].filter(Boolean).join(' '),
        firmName: data.data.organization || company,
        title: e.position || '', email: e.value || '', source: 'hunter',
        confidence: e.confidence >= 80 ? 'high' : 'medium',
      })).filter(Boolean);
    cache[key] = contacts; return contacts;
  } catch { cache[key] = []; return []; }
}

// --- Apollo.io: org → decision-makers (better than Hunter for B2B titles) ----
const DEV_TITLES = ['VP Development', 'Vice President of Development', 'Director of Development',
  'Chief Development Officer', 'Director of Land Acquisition', 'VP Acquisitions', 'Land Acquisition',
  'Development Manager', 'Managing Director', 'Principal', 'President', 'Partner', 'Vice President',
  'Chief Executive Officer', 'Owner'];
let _apolloReveals = 0; const APOLLO_REVEAL_CAP = 12; // bound paid email-reveal credits

// Strip SPE/legal noise so an opaque owner-of-record maps to a searchable firm.
function cleanCompany(name) {
  let s = String(name || '').toLowerCase();
  s = s.replace(/\b(llc|l\.l\.c|lp|l\.p|inc|incorporated|corp|corporation|co|ltd|llp)\b\.?/g, ' ');
  s = s.replace(/\b(owner|borrower|holding|holdings|campus|fund|trust|series|spe|ii|iii|iv)\b/g, ' ');
  s = s.replace(/\b\d+\b/g, ' ').replace(/\s+/g, ' ').trim();
  return s;
}

async function apolloPeopleSearch(company, cache) {
  const ck = `apollo:search:${String(company).toLowerCase()}`;
  if (cache[ck]) return cache[ck];
  const apiKey = process.env.APOLLO_API_KEY;
  if (!apiKey || !company) return [];
  try {
    const res = await fetch('https://api.apollo.io/api/v1/mixed_people/search', {
      method: 'POST',
      headers: { 'X-Api-Key': apiKey, 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' },
      body: JSON.stringify({ q_organization_name: company, person_titles: DEV_TITLES, per_page: 5, page: 1 }),
      signal: AbortSignal.timeout(20000),
    });
    if (res.status === 401 && !apolloPeopleSearch._warned) {
      apolloPeopleSearch._warned = true;
      console.warn('  [apollo] 401 Invalid access credentials — refresh the API key in the vault (apollo.md) or confirm the plan has API access. Skipping Apollo for this run.');
    }
    if (!res.ok) { return []; }
    const data = await res.json();
    const people = (data.people || []).map(p => ({
      id: p.id, first_name: p.first_name, last_name: p.last_name,
      name: p.name || [p.first_name, p.last_name].filter(Boolean).join(' '),
      title: p.title || '', org: (p.organization && p.organization.name) || company,
      domain: (p.organization && (p.organization.primary_domain || p.organization.website_url)) || '',
      linkedin: p.linkedin_url || '', email: p.email || '',
    }));
    cache[ck] = people; return people;
  } catch { return []; }
}

async function apolloMatch(person, cache) {
  const ck = `apollo:match:${String(person.name).toLowerCase()}|${String(person.org).toLowerCase()}`;
  if (cache[ck]) return cache[ck];
  const apiKey = process.env.APOLLO_API_KEY;
  if (!apiKey || _apolloReveals >= APOLLO_REVEAL_CAP) return null;
  _apolloReveals++;
  try {
    const res = await fetch('https://api.apollo.io/api/v1/people/match', {
      method: 'POST',
      headers: { 'X-Api-Key': apiKey, 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' },
      body: JSON.stringify({ first_name: person.first_name, last_name: person.last_name, organization_name: person.org, reveal_personal_emails: false }),
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const m = data.person || {};
    const out = { email: m.email || '', phone: (m.phone_numbers && m.phone_numbers[0] && m.phone_numbers[0].sanitized_number) || '' };
    cache[ck] = out; return out;
  } catch { return null; }
}

const masked = e => !e || /email_not_unlocked|not_unlocked|domain\.com$/i.test(e);

async function apolloContacts(ownerName, cache) {
  const company = isKnownDeveloper(ownerName) || cleanCompany(ownerName);
  if (!company || company.length < 3) return [];
  const people = await apolloPeopleSearch(company, cache);
  const out = [];
  for (const person of people.slice(0, 3)) {
    let email = masked(person.email) ? '' : person.email;
    let phone = '';
    if (!email) { const m = await apolloMatch(person, cache); if (m) { email = masked(m.email) ? '' : m.email; phone = m.phone || ''; } }
    const c = makeContact({ role: 'developer-exec', name: person.name, firmName: person.org, title: person.title, email, phone, source: 'apollo', confidence: 'high' });
    if (c) { if (person.linkedin) c.linkedin = person.linkedin; out.push(c); }
  }
  return out;
}

// CA SOS bizfile fallback: when Apollo yields nothing for a corporate owner,
// resolve the owner LLC → registered agent (a real human for ~half of opaque
// SPEs) + entity metadata from the FREE public bizfile search. Adds a contact
// only when the agent is a real person (not a commercial registered-agent
// service); always records the entity metadata on lead.developer.caSos.
// Returns true if a real (non-commercial) bizfile contact was added.
async function bizfileFallback(lead, ownerName, casCache) {
  let resolved = null;
  try {
    resolved = await caSos.resolveEntity(ownerName, { cache: casCache });
  } catch (e) {
    // resolveEntity never throws, but belt-and-suspenders — degrade silently.
    if (!bizfileFallback._warned) { bizfileFallback._warned = true; console.warn(`  [ca-sos] resolution unavailable: ${e.message}`); }
    return false;
  }
  if (!resolved) return false;

  // Record entity metadata for the dossier regardless of agent type.
  lead.developer = lead.developer || {};
  lead.developer.resolvedEntity = resolved.entityName || lead.developer.resolvedEntity || ownerName;
  lead.developer.caSos = {
    entityNumber: resolved.entityNumber || '',
    status: resolved.status || '',
    entityType: resolved.entityType || '',
    registrationDate: resolved.registrationDate || '',
    jurisdiction: resolved.jurisdiction || '',
    agent: resolved.agent || null,                 // { name, address, isCommercial }
    agentShielded: !!(resolved.agent && resolved.agent.isCommercial),
    sourceUrl: resolved.sourceUrl || '',
  };

  // Only surface a person when the agent is a real human (not CSC/CT/etc. and not
  // a "NO AGENT" placeholder). resolved.agent is already null for placeholders.
  const agent = resolved.agent;
  if (!agent || !agent.name || agent.isCommercial || caSos.isPlaceholderAgent(agent.name)) return false;

  const c = makeContact({
    role: 'Registered Agent',                      // NOTE: NOT 'agent' — that aliases to "Listing Agent" in contacts.ROLE_MAP
    name: agent.name,
    firmName: resolved.entityName || ownerName,
    mailingAddress: agent.address || '',           // '' — full address is login-gated
    source: 'ca-sos',
    confidence: 'medium',
  });
  if (!c) return false;
  c.title = 'Registered Agent';
  if (resolved.sourceUrl) c.sourceUrl = resolved.sourceUrl;
  lead.contacts = mergeContacts(lead.contacts, [c]);
  return true;
}

async function main() {
  const file = latestFullRun();
  if (!file) { console.error('No full-run JSON.'); process.exit(1); }
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  const tier1 = (doc.leads || []).filter(l => l.tier === 1);
  console.log(`[enrich-tier1] enriching ${tier1.length} Tier-1 pursuits (ATTOM → Apollo → bizfile → entity)…`);
  const cache = loadCache();
  // bizfile keeps its own on-disk cache (data/output/ca-sos-cache.json). Load it
  // once and pass it through so all lookups share it; persist once at the end.
  const casCache = caSos.loadCacheFile();
  let withOwner = 0, withContacts = 0, attomHits = 0, bizfileResolved = 0;

  for (let i = 0; i < tier1.length; i++) {
    const lead = tier1[i];
    // Clear prior discovery-sourced contacts so re-runs don't accumulate noise.
    lead.contacts = (lead.contacts || []).filter(c => c.source !== 'hunter' && c.source !== 'apollo' && c.source !== 'ca-sos');
    const a = await attomLookup(lead, cache);
    if (a && !a.error) {
      attomHits++;
      lead.owner = { name: a.ownerName, mailingAddress: a.mailingAddress, corporate: a.corporate };
      lead.financial = { assessedTotal: a.assessedValue, salePrice: a.saleAmount, saleDate: a.saleDate, lotSize: a.lotSize, zoning: a.zoning };
      if (!lead.apn && a.apn) lead.apn = a.apn;
      if (a.ownerName) withOwner++;
      if (a.corporate && a.ownerName) {
        lead.developer = Object.assign({ rawName: a.ownerName, isLLC: true }, lead.developer || {});
        // Apollo: org → development decision-makers (titles), with capped reveal.
        const contacts = await apolloContacts(a.ownerName, cache);
        if (contacts.length) { lead.contacts = mergeContacts(lead.contacts, contacts); withContacts++; }
        // Fallback for opaque local LLCs Apollo can't crack: CA SOS bizfile →
        // registered agent (real human ~half the time) + entity metadata. FREE.
        else {
          const added = await bizfileFallback(lead, a.ownerName, casCache);
          if (added) bizfileResolved++;
        }
      }
    }
    saveCache(cache);
    if ((i + 1) % 5 === 0) console.log(`  …${i + 1}/${tier1.length}`);
    await sleep(250);
  }
  // Persist the bizfile cache once and release the headless browser session.
  caSos.saveCacheFile(casCache);
  await caSos.closeSession();

  // LLC → principal + Danielian archive cross-ref (the relationship flag)
  await entity.enrichLeads(tier1);

  fs.writeFileSync(file, JSON.stringify(doc, null, 2));
  console.log(`[enrich-tier1] done. ATTOM hits=${attomHits}/${tier1.length}, owner names=${withOwner}, pursuits with Apollo contacts=${withContacts}, bizfile resolved=${bizfileResolved}, Apollo email-reveals used=${_apolloReveals}/${APOLLO_REVEAL_CAP}.`);
  console.log(`  Updated ${path.basename(file)}. Run "npm run brief" to render dossiers with owners + contacts.`);
}

main().catch(e => { console.error('[enrich-tier1] fatal', e); process.exit(1); });
