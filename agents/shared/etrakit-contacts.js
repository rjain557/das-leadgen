/**
 * eTRAKiT (CentralSquare) case-detail contacts fetcher.
 *
 * eTRAKiT is server-rendered (ASP.NET WebForms / postback). The case detail
 * page typically has a "Contacts" panel listing each contact's role, name,
 * company, phone, email. URL shape varies per tenant:
 *   <portal>/CapDetail.aspx?capID=<plan_no>
 *   <portal>/Search/permit_detail.aspx?caseno=<plan_no>
 *   <portal>/etrakit/Search/permit.aspx?activityNo=<plan_no>
 *
 * This fetcher walks each lead's permit detail page and scrapes the contacts
 * panel via DOM heuristics — robust to the table-vs-grid variations across
 * eTRAKiT versions.
 */

const { makeContact, mergeContacts } = require('./contacts');
const { extractContactsLLM } = require('./llm-contacts');

const ROLE_KEYWORDS = [
  'architect', 'designer', 'professional', 'engineer',
  'applicant', 'owner', 'contractor', 'agent',
];

/**
 * Try a list of detail-page URL templates until one returns 200 with contact-like markup.
 */
async function fetchCaseDetailPage(page, baseUrl, planNumber, templates) {
  for (const tpl of templates) {
    const url = `${baseUrl.replace(/\/$/, '')}${tpl.startsWith('/') ? '' : '/'}${tpl.replace('{planNumber}', encodeURIComponent(planNumber))}`;
    try {
      const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
      if (resp && resp.ok()) {
        await page.waitForTimeout(1500);
        // Look for any element mentioning a known role — quick sanity check
        const hasContacts = await page.evaluate((roles) => {
          const text = (document.body.innerText || '').toLowerCase();
          return roles.some(r => text.includes(r));
        }, ROLE_KEYWORDS);
        if (hasContacts) return { url, ok: true };
      }
    } catch { /* try next template */ }
  }
  return { url: null, ok: false };
}

/**
 * Scrape the contacts panel from the currently loaded page.
 * Heuristics:
 *   - Find tables/lists/divs whose nearest header contains "Contact"
 *   - Or fall back to whole-page text search for "Role: <name>" / "<role>: <name>" patterns
 */
async function scrapeContactsFromPage(page) {
  const rows = await page.evaluate(() => {
    function clean(s) { return (s || '').replace(/\s+/g, ' ').trim(); }
    function txt(el) { return clean(el?.innerText || el?.textContent || ''); }

    const out = [];

    // ── Strategy 1: structured tables under a "Contacts" heading ──
    const headings = Array.from(document.querySelectorAll('h1,h2,h3,h4,legend,caption,div,span,th'))
      .filter(h => /contact/i.test(txt(h)));
    for (const h of headings) {
      // Look for a sibling/descendant table or list near each "Contacts" heading
      const container = h.closest('section,fieldset,div,table') || h.parentElement;
      if (!container) continue;
      const tables = Array.from(container.querySelectorAll('table'));
      for (const t of tables) {
        const headerCells = Array.from(t.querySelectorAll('thead th, tr:first-child th, tr:first-child td'))
          .map(c => txt(c).toLowerCase());
        if (headerCells.length === 0) continue;
        const idx = (kw) => headerCells.findIndex(h => h.includes(kw));
        const iRole = idx('type') >= 0 ? idx('type') : idx('role') >= 0 ? idx('role') : idx('relationship');
        const iName = idx('name') >= 0 ? idx('name') : idx('contact');
        const iFirm = idx('company') >= 0 ? idx('company') : idx('firm') >= 0 ? idx('firm') : idx('business');
        const iPhone = idx('phone');
        const iEmail = idx('email');
        const iAddr = idx('address');
        if (iRole < 0 && iName < 0) continue;
        const dataRows = Array.from(t.querySelectorAll('tbody tr, tr')).slice(headerCells.length ? 1 : 0);
        for (const r of dataRows) {
          const cells = Array.from(r.querySelectorAll('td')).map(c => txt(c));
          if (cells.length === 0) continue;
          const role = iRole >= 0 ? cells[iRole] : '';
          const name = iName >= 0 ? cells[iName] : '';
          if (!role && !name) continue;
          out.push({
            role, name,
            firmName: iFirm >= 0 ? cells[iFirm] : '',
            phone: iPhone >= 0 ? cells[iPhone] : '',
            email: iEmail >= 0 ? cells[iEmail] : '',
            mailingAddress: iAddr >= 0 ? cells[iAddr] : '',
          });
        }
      }
    }

    // ── Strategy 2: label/value pairs on a People/Contacts panel ──
    if (out.length === 0) {
      const labels = Array.from(document.querySelectorAll('label, dt, span, b, strong, td'))
        .filter(l => /^(applicant|owner|architect|designer|professional|engineer|contractor|agent)\b/i.test(txt(l)));
      for (const l of labels) {
        const role = txt(l).replace(/[:\s].*$/, '').trim();
        // Find nearby value
        let val = '';
        const next = l.nextElementSibling || l.parentElement?.nextElementSibling;
        if (next) val = txt(next);
        if (!val && l.parentElement) {
          const sibText = txt(l.parentElement).replace(txt(l), '').replace(/^[:\s-]+/, '').trim();
          val = sibText;
        }
        if (val) out.push({ role, name: val });
      }
    }

    return out;
  });

  return rows.map(r => makeContact({
    ...r, source: 'etrakit', confidence: 'medium',
  })).filter(Boolean);
}

/**
 * Hydrate a single lead's contacts from its eTRAKiT detail page.
 */
async function fetchCaseContacts(page, opts) {
  const { portalBaseUrl, detailUrlTemplates, planNumber, source = 'etrakit' } = opts;
  if (!planNumber) return [];
  const { ok } = await fetchCaseDetailPage(page, portalBaseUrl, planNumber, detailUrlTemplates);
  if (!ok) return [];
  let rows = (await scrapeContactsFromPage(page)).map(r => ({ ...r, source: `${source}:${planNumber}` }));

  // LLM fallback when DOM scrape fails (eTRAKiT layouts vary widely between tenants)
  if (rows.length === 0) {
    try {
      const text = await page.evaluate(() => document.body?.innerText || '');
      if (text && text.trim().length > 100) {
        const llm = await extractContactsLLM(text, {
          context: `eTRAKiT permit ${planNumber}`,
          source: `${source}:${planNumber}:llm`,
        });
        if (llm.length > 0) rows = mergeContacts(rows, llm);
      }
    } catch { /* never fail the fetch on a fallback error */ }
  }
  return rows;
}

/**
 * Hydrate an array of leads. Caches by planNumber.
 */
async function hydrateContacts(page, leads, opts = {}) {
  const {
    portalBaseUrl, detailUrlTemplates,
    source = 'etrakit', cache = new Map(),
    max = Infinity, perCaseDelayMs = 400,
  } = opts;
  let processed = 0;
  for (const lead of leads) {
    if (processed >= max) break;
    const id = lead.planNumber || lead.caseNumber || lead.permitNumber;
    if (!id) continue;
    let contacts = cache.get(id);
    if (!contacts) {
      contacts = await fetchCaseContacts(page, {
        portalBaseUrl, detailUrlTemplates, planNumber: id, source,
      });
      cache.set(id, contacts);
      if (perCaseDelayMs > 0) await page.waitForTimeout(perCaseDelayMs);
    }
    lead.contacts = mergeContacts(lead.contacts || [], contacts);
    processed++;
  }
  return leads;
}

module.exports = {
  fetchCaseContacts,
  hydrateContacts,
  scrapeContactsFromPage,
};
