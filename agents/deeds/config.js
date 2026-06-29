// agents/deeds/config.js — L4 land-transfer / deeds signal-layer config.
//
// Source: OC Clerk-Recorder "RecorderWorks". The party taking title on a recent
// GRANT DEED (the GRANTEE) and the borrower on a construction TRUST DEED (the
// GRANTOR/trustor) are the single most valuable *developer-name* signals in the
// pipeline — they become developer.rawName downstream (consolidate-lib
// normalizeDeveloper), feeding people-match + the Danielian archive flag.
// Config-over-code per spec §14: tune target doc types / cities here, no JS.
//
// PHASE-0 VERIFY (live, 2026-06-29): https://cr.ocgov.com/recorderworks/ 301s to
// https://cr.occlerkrecorder.gov/RecorderWorksInternet/ (NEW .gov host) — a
// jQuery-UI-tabbed ASP.NET WebForms app. HTTP 200, NO Imperva, NO login; keep
// ignoreHTTPSErrors:true. Search flow (all selectors verified live this date):
//   1. dismiss the disclaimer popup (#MainContent_AlertMessageBox_btnOK)
//   2. click the "Document Type" tab  (a[href="#tabs-nohdr-4"])
//   3. fill FromDate/ToDate (MM/DD/YYYY)
//   4. CHECK the target doc-type checkbox(es): each <input.grType> carries a
//      doctypename="<NAME>" attr. OC uses "GRANT DEED" and "TRUST DEED" — there
//      is NO literal "DEED OF TRUST". The checkbox DOES filter server-side
//      (verified: GRANT-DEED-only returns ONLY GRANT DEED + its companion
//      ACCEPTANCE AGM rows, never unrelated types). At least one type MUST be
//      checked or the search returns no grid.
//   5. click the Search <div> (#MainContent_MainMenu1_SearchByDocType1_btnSearch)
//   6. dismiss the post-search "exceeded N records" popup (same AlertMessageBox)
//   7. parse tr.searchResultRow. Per row: 2nd <td> = document number (plain text,
//      no id); 3rd <td id*=docTypeGrtGrtee> holds one .docTypeGrtGrteeContainer
//      per bundled instrument, each with .GrtContainer (grantor <p>s),
//      .GrteeContainer (grantee <p>s), .GrGrteeContainer, .DocTypeContainer;
//      td[id*=recDate] = recording date (M/D/YYYY); td[id*=numOfPages] = pages.
//      The grid exposes NO APN / street address (those are behind the per-doc
//      detail page), so deeds are dedup-keyed by their globally-unique document
//      number and address/apn are left ''.
// The portal hard-caps any single result set at ~521 rows, so keep the date
// window tight and the page cap modest.

module.exports = {
  source: { name: 'OC Clerk-Recorder', id: 'recorder' },

  portal: {
    name: 'OC RecorderWorks',
    // Live app host (the cr.ocgov.com/recorderworks/ landing 301s here). Point
    // straight at the live .gov app — the redirect still resolves either way.
    baseUrl: 'https://cr.occlerkrecorder.gov/RecorderWorksInternet/',
    searchUrl: 'https://cr.occlerkrecorder.gov/RecorderWorksInternet/',
    legacyUrl: 'https://cr.ocgov.com/recorderworks/',
    // jQuery-UI tab anchor that reveals the Document Type search panel.
    docTypeTab: 'a[href="#tabs-nohdr-4"]',
    // ASP.NET control ids (verified live 2026-06-29).
    docTypeFromDate: '#MainContent_MainMenu1_SearchByDocType1_FromDate',
    docTypeToDate: '#MainContent_MainMenu1_SearchByDocType1_ToDate',
    docTypeSearchBtn: '#MainContent_MainMenu1_SearchByDocType1_btnSearch', // clickable <div>
    // Popups: the disclaimer + the post-search "exceeded N records" alert.
    popupOkButtons: [
      '#MainContent_AlertMessageBox_btnOK',
      '#MainContent_MessageBox1_btnOK',
    ],
    // The result count is rendered as "<N> Result(s)" text in the results title
    // bar (there is no stable #...resultCount span), so it is read via regex.
    resultCountRe: /([\d,]+)\s+Result\(s\)/i,
  },

  // Target recorder document types. `match` is the EXACT doctypename attr on the
  // live checkbox (also used to classify a parsed row's container by substring,
  // case-insensitive). `developerParty` = which side is the developer-name
  // signal (grant deed -> grantee took title; trust deed -> grantor/trustor is
  // the borrower building). leadQuality drives downstream scoring.
  targetDocTypes: [
    {
      match: 'GRANT DEED', code: '5', label: 'Grant Deed',
      developerParty: 'grantee', leadQuality: 'medium',
    },
    {
      match: 'TRUST DEED', code: '1', label: 'Trust Deed (Deed of Trust)',
      developerParty: 'grantor', leadQuality: 'high',
    },
  ],

  // Companion instruments bundled onto a GRANT DEED recording (the recorder
  // shows e.g. ACCEPTANCE AGM + GRANT DEED on one document). When the literal
  // deed container isn't the developer side, fall back to one of these. Kept in
  // the GRANTEE direction only (a developer accepting title = an acquisition).
  acquisitionCompanionTypes: ['ACCEPTANCE AGM', 'ACCEPTANCE', 'AGREEMENT', 'GRANT & RESERVE'],

  // Lender / financing-lifecycle instruments that ride bundled on a TRUST DEED
  // search (verified live: a TRUST DEED search returns mostly ASSIGNMENT LSE/RNT
  // + ASGT TRUST DEED — assignments of leases/rents and of the deed of trust,
  // i.e. the lender selling the loan, NOT a developer building). A row whose
  // containers are ENTIRELY these is dropped — it is not a pursuit. (substring,
  // case-insensitive.)
  excludeDocTypes: [
    'ASSIGNMENT LSE', 'ASSIGNMENT RNT', 'ASGT TRUST DEED', 'ASGT RENTS',
    'ASGT LEASE', 'ASSIGNMENT', 'ASGT', 'RECONVEYANCE', 'SUBORDINATION',
    'SUBSTITUTION', 'RELEASE', 'LIEN', 'NOTICE OF DEFAULT', 'MODIFICATION',
    'UCC', 'REQUEST FOR NOTICE', 'CTF', 'ABSTRACT',
  ],

  // A grantor/grantee that looks like a developer / investment entity (not an
  // individual homeowner). Used to keep developer-name signals and flag them for
  // scoring. The harness ICP filter still applies on top; cleanForOutput never
  // drops a row on this alone.
  developerEntityKeywords: [
    'llc', 'l.l.c', 'inc', 'l.p', ' lp', 'lp ', 'ltd', 'corp', 'corporation',
    'company', ' co ', 'holdings', 'properties', 'property', 'investments',
    'investment', 'capital', 'development', 'developments', 'developer', 'homes',
    'communities', 'residential', 'builders', 'builder', 'partners',
    'partnership', 'group', 'realty', 'ventures', 'land', 'estates', 'fund',
    'enterprises',
  ],

  // Financial-institution / government / HOA / hard-money names that are NOT the
  // developer party even with an LLC/INC suffix. When a party is purely one of
  // these it is not treated as the developer (these are lender/agency
  // instruments — mortgage assignments, liens, reconveyances — not pursuits).
  institutionKeywords: [
    'bank', ' n a', 'n.a', 'mortgage', 'lending', 'loan', 'loans', 'financial',
    'federal', 'savings', 'credit union', 'trustee corp', 'trustee services',
    'reconveyance', 'default services', 'fargo', 'jpmorgan', 'chase', 'citibank',
    'us bank', 'u s bank', 'flagstar', 'mortgage electronic', 'mers',
    'freddie mac', 'fannie mae', 'department of', 'county of', 'city of',
    'state of', 'franchise tax', 'internal revenue', 'united states',
    'water district', 'school district', 'home loans', 'funding', 'servicing',
    'title company', 'title insurance', 'escrow',
    // HOAs / maintenance corps — appear as grantee on dedication docs.
    'maintenance corporation', 'maintenance corp', 'community association',
    'owners association', 'homeowners', 'master association',
    'condominium association', 'association inc',
    // Hard-money lenders / debt funds (trust-deed financing side, not the builder).
    'lone oak fund', 'genesis capital', 'conventus', 'civic financial',
    'finance of america', 'kiavi', 'anchor loans', 'roc capital',
  ],

  // Search defaults + HARD caps so a run always finishes in a few minutes and
  // never hangs (orchestrator contract). 20 rows render per result page.
  search: {
    defaultDaysBack: 30,
    resultsPerPage: 20,
    maxPages: 6,           // pagination cap per doc type (~120 rows/type)
    maxResults: 300,       // absolute cap on parsed rows
    navTimeoutMs: 45000,   // per page.goto
    waitAfterNav: 5000,    // let the WebForms app + JS settle after load
    waitAfterSearch: 6000, // base wait for the results grid postback
    waitBetweenPages: 3500, // between pagination clicks (postback)
    pageSettleTimeoutMs: 22000, // max wait for a page's grid to refresh
  },

  // Orange County development hotspots (informational; the recorder index has no
  // city column, so geography is resolved later by ATTOM enrichment).
  targetCities: [
    'IRVINE', 'HUNTINGTON BEACH', 'NEWPORT BEACH', 'ANAHEIM', 'SANTA ANA',
    'COSTA MESA', 'ORANGE', 'TUSTIN', 'LAGUNA NIGUEL', 'MISSION VIEJO',
    'RANCHO MISSION VIEJO', 'LAKE FOREST', 'BREA', 'FULLERTON', 'PLACENTIA',
  ],

  browser: {
    headless: true,
    viewport: { width: 1366, height: 1000 },
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    timeout: 45000,
  },
};
