/**
 * DRB / Planning Commission Scraper Configuration  (L2 — entitlement signal)
 * ---------------------------------------------------------------------------
 * Surfaces planning-commission / design-review agenda items for RESIDENTIAL
 * DEVELOPMENT (multifamily / mixed-use / affordable / master-plan / BTR / ADU-
 * batch) across Orange County. A project on a planning agenda is selecting its
 * design team within 90-180 days, and the APPLICANT named on the agenda is the
 * developer — a high-value contact-name signal.
 *
 * Ported from the BBC `drb` agent (which targeted luxury single-family) and
 * RETARGETED for Danielian's multifamily ICP. Per-city platform + URL was
 * re-verified live 2026-06 (see PHASE-0 VERIFY notes inline — confirm each is
 * still the live agenda surface, since OC cities rotate platforms/view_ids).
 */

const PLATFORM = {
  GRANICUS: 'granicus',
  LEGISTAR: 'legistar',
  CITY_CMS: 'city-cms',
};

const cities = {
  'laguna-beach': {
    name: 'Laguna Beach Design Review Board',
    slug: 'laguna-beach',
    platform: PLATFORM.GRANICUS,
    granicusUrl: 'https://lagunabeachcity.granicus.com',
    // PHASE-0 VERIFY: Laguna Beach DRB lives on Granicus view_id=3 (the combined
    // City Council / DRB / PC media+agenda archive). Confirmed 2026-06 — root
    // view_id=1 now 404s; agenda rows render client-side as AgendaViewer.php PDFs.
    granicusViewId: 3,
    altUrl: 'https://www.lagunabeachcity.net/government/departments/community-development/planning/design-review-process',
    boardName: 'Design Review Board',
    schedule: 'Twice monthly',
    priority: 'highest',
  },
  'irvine': {
    name: 'Irvine Planning Commission',
    slug: 'irvine',
    platform: PLATFORM.GRANICUS,
    granicusUrl: 'https://irvine.granicus.com',
    // PHASE-0 VERIFY: Irvine Planning Commission is Granicus view_id=81
    // ("Planning Commission Meetings V2"). Confirmed 2026-06 — auto-discovery
    // from the Granicus root failed; this view_id is required.
    granicusViewId: 81,
    boardName: 'Planning Commission',
    schedule: '1st and 3rd Thursday',
    priority: 'high',
  },
  'san-juan-capistrano': {
    name: 'San Juan Capistrano Planning Commission',
    slug: 'san-juan-capistrano',
    platform: PLATFORM.GRANICUS,
    granicusUrl: 'https://sjc.granicus.com',
    // PHASE-0 VERIFY: SJC Planning Commission + DRC share Granicus view_id=3.
    // Confirmed 2026-06 (MetaViewer/GeneratedAgendaViewer links present). The
    // listing is large/old-heavy, so the scraper caps rows + filters by date.
    granicusViewId: 3,
    boardName: 'Planning Commission',
    altBoardName: 'Design Review Committee',
    schedule: 'As needed',
    priority: 'high',
  },
  'newport-beach': {
    name: 'Newport Beach Planning Commission',
    slug: 'newport-beach',
    platform: PLATFORM.LEGISTAR,
    legistarClient: 'newportbeach',
    legistarUrl: 'https://newportbeach.legistar.com',
    // PHASE-0 VERIFY: Legistar OData API live (webapi.legistar.com/v1/newportbeach).
    // Confirmed 2026-06 — returns events + EventItems + matter attachments (PDF).
    boardName: 'Planning Commission',
    schedule: '1st and 3rd Thursday',
    priority: 'high',
  },
  'costa-mesa': {
    name: 'Costa Mesa Planning Commission',
    slug: 'costa-mesa',
    platform: PLATFORM.LEGISTAR,
    legistarClient: 'costamesa',
    legistarUrl: 'https://costamesa.legistar.com',
    // PHASE-0 VERIFY: Legistar OData API live (webapi.legistar.com/v1/costamesa).
    boardName: 'Planning Commission',
    schedule: '2nd and 4th Monday',
    priority: 'medium',
  },
  'city-of-orange': {
    name: 'City of Orange Design Review Committee',
    slug: 'city-of-orange',
    platform: PLATFORM.LEGISTAR,
    legistarClient: 'cityoforange',
    legistarUrl: 'https://cityoforange.legistar.com',
    // PHASE-0 VERIFY: Legistar OData API live (webapi.legistar.com/v1/cityoforange).
    boardName: 'Design Review Committee',
    altBoardName: 'Planning Commission',
    schedule: 'As needed',
    priority: 'medium',
  },
  'dana-point': {
    name: 'Dana Point Planning Commission',
    slug: 'dana-point',
    platform: PLATFORM.CITY_CMS,
    // PHASE-0 VERIFY: Dana Point Planning Commission landing page (200 OK 2026-06);
    // agenda PDFs render client-side, so the scraper follows agenda/packet links.
    agendaUrl: 'https://www.danapoint.org/City-Government/Community-Development/Planning-Commission',
    boardName: 'Planning Commission',
    schedule: '2nd and 4th Wednesday',
    priority: 'medium',
  },
  'laguna-niguel': {
    name: 'Laguna Niguel Planning Commission',
    slug: 'laguna-niguel',
    platform: PLATFORM.CITY_CMS,
    // PHASE-0 VERIFY: CivicPlus AgendaCenter (200 OK 2026-06). AgendaCenter rows
    // expose Agenda/Packet PDF links per meeting date.
    agendaUrl: 'https://www.cityoflagunaniguel.org/AgendaCenter/Planning-Commission-8',
    boardName: 'Planning Commission',
    schedule: '2nd and 4th Tuesday',
    priority: 'medium',
  },
  'san-clemente': {
    name: 'San Clemente Planning Commission',
    slug: 'san-clemente',
    platform: PLATFORM.CITY_CMS,
    // PHASE-0 VERIFY: San Clemente migrated san-clemente.org -> sanclemente.gov
    // (CivicEngage/AgendaCenter). The old DRS folder URL 404s; this AgendaCenter
    // path is the current Planning Commission agenda surface (confirm group id).
    agendaUrl: 'https://www.sanclemente.gov/government/agendas-minutes',
    boardName: 'Planning Commission',
    schedule: '1st and 3rd Wednesday',
    priority: 'medium',
  },
  'county-of-orange': {
    name: 'County of Orange Planning Commission',
    slug: 'county-of-orange',
    platform: PLATFORM.CITY_CMS,
    // PHASE-0 VERIFY: ocds.ocpublicworks.com now redirects to pwds.oc.gov
    // (OC Development Services). Hearing/agenda surface is JS-rendered; this is a
    // low-priority/best-effort source (county unincorporated has few MF agendas).
    agendaUrl: 'https://pwds.oc.gov/',
    boardName: 'Planning Commission',
    schedule: 'As needed',
    priority: 'low',
  },
};

// ---------------------------------------------------------------------------
// Keyword filter — RETARGETED for Danielian's multifamily/mixed-use ICP.
// The BBC original keyed on single-family ("custom home", "second story", ...).
// Here we gate on residential-DEVELOPMENT signals so SFR rebuilds and pure-
// commercial items (patio expansions, medical plazas) are dropped at harvest.
// The consolidator re-checks with the full danielian-fit ICP, so this is the
// coarse first pass; it is intentionally development-biased, not exhaustive.
// ---------------------------------------------------------------------------
const RESIDENTIAL_KEYWORDS = [
  // multifamily
  'multifamily', 'multi-family', 'multi family', 'apartment', 'apartments',
  'condominium', 'condominiums', 'condo', 'condos', 'townhome', 'townhomes',
  'townhouse', 'townhouses', 'rowhome', 'rowhomes', 'rowhouse', 'flats',
  'dwelling units', 'residential units', 'attached residential', 'mfr',
  'senior living', 'assisted living', 'independent living', 'student housing',
  // mixed-use
  'mixed use', 'mixed-use', 'live/work', 'live-work', 'residential over retail',
  // affordable / streamlining
  'affordable', 'low income', 'low-income', 'lihtc', 'tax credit',
  'inclusionary', 'density bonus', 'supportive housing', 'workforce housing',
  'sb 35', 'sb35', 'sb 423', 'sb423', "builder's remedy", 'builders remedy',
  // build-to-rent
  'build-to-rent', 'build to rent', 'btr', 'rental community', 'for-rent community',
  // master plan / specific plan
  'master plan', 'master-plan', 'master planned', 'specific plan',
  'planned community', 'planned unit development', 'planned development',
  // batch ADU (SB 1211) — multi-unit ADU only; lone "adu" stays out of the gate
  'adu project', 'accessory dwelling units',
  // generic development signals (kept broad; consolidator narrows)
  'residential development', 'residential project', 'housing development',
  'new residential', 'subdivision', 'tentative tract', 'tentative parcel map',
  'tract map', 'vesting tentative',
];

// Approval recommendation keywords
const APPROVAL_KEYWORDS = [
  'recommendation for approval',
  'recommend approval',
  'approval recommended',
  'staff recommends approval',
  'recommends approval',
  'recommended for approval',
  'approve',
];

const DENIAL_KEYWORDS = [
  'recommend denial',
  'recommendation for denial',
  'staff recommends denial',
  'deny',
];

const browser = {
  headless: true,
  viewport: { width: 1280, height: 900 },
  userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  timeout: 30000,
  navigationTimeout: 25000,
};

// Pagination + politeness caps so the whole multi-city run finishes in a few
// minutes and never hangs (orchestrator contract: NEVER hang; cap waits).
const limits = {
  maxMeetingsPerCity: 12,   // agenda PDFs/pages to open per Granicus/CMS city
  maxAgendaPdfBytes: 12 * 1024 * 1024, // skip absurdly large PDFs
  pdfParseTimeoutMs: 20000, // per-PDF parse hard cap
  fetchTimeoutMs: 20000,    // per-HTTP-fetch hard cap
  legistarMaxEvents: 40,    // events to scan per Legistar city
  throttleMs: 400,          // politeness delay between requests
};

module.exports = {
  PLATFORM,
  cities,
  RESIDENTIAL_KEYWORDS,
  APPROVAL_KEYWORDS,
  DENIAL_KEYWORDS,
  browser,
  limits,
};
