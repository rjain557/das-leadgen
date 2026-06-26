/**
 * DRB / Planning Commission Scraper Configuration
 * Layer 2: Design Review Board agenda scraping
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
    altUrl: 'https://www.lagunabeachcity.net/government/departments/community-development/planning-zoning/current-projects',
    boardName: 'Design Review Board',
    schedule: 'Monthly (2nd Thursday)',
    priority: 'highest',
  },
  'irvine': {
    name: 'Irvine Planning Commission',
    slug: 'irvine',
    platform: PLATFORM.GRANICUS,
    granicusUrl: 'https://irvine.granicus.com',
    boardName: 'Planning Commission',
    schedule: '1st and 3rd Thursday',
    priority: 'high',
  },
  'san-juan-capistrano': {
    name: 'San Juan Capistrano Design Review Committee',
    slug: 'san-juan-capistrano',
    platform: PLATFORM.GRANICUS,
    granicusUrl: 'https://sjc.granicus.com',
    boardName: 'Design Review Committee',
    altBoardName: 'Cultural Heritage Commission',
    schedule: 'As needed',
    priority: 'high',
  },
  'newport-beach': {
    name: 'Newport Beach Planning Commission',
    slug: 'newport-beach',
    platform: PLATFORM.LEGISTAR,
    legistarClient: 'newportbeach',
    legistarUrl: 'https://newportbeach.legistar.com',
    gisUrl: 'https://nbgis.newportbeachca.gov/gispub/Dashboards/PlanningCasesDash.htm',
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
    boardName: 'Design Review Committee',
    schedule: 'As needed',
    priority: 'medium',
  },
  'san-clemente': {
    name: 'San Clemente Design Review Subcommittee',
    slug: 'san-clemente',
    platform: PLATFORM.CITY_CMS,
    agendaUrl: 'https://www.san-clemente.org/government/commissions-committees/design-review-subcommittee/agendas-packets/-folder-6642',
    boardName: 'Design Review Subcommittee',
    schedule: 'As needed',
    priority: 'medium',
  },
  'dana-point': {
    name: 'Dana Point Planning Commission',
    slug: 'dana-point',
    platform: PLATFORM.CITY_CMS,
    agendaUrl: 'https://www.danapoint.org/City-Government/Community-Development/Planning-Commission',
    boardName: 'Planning Commission',
    schedule: '2nd and 4th Wednesday',
    priority: 'medium',
  },
  'laguna-niguel': {
    name: 'Laguna Niguel Planning Commission',
    slug: 'laguna-niguel',
    platform: PLATFORM.CITY_CMS,
    agendaUrl: 'https://www.cityoflagunaniguel.org/AgendaCenter/Planning-Commission-8',
    boardName: 'Planning Commission',
    schedule: '2nd and 4th Tuesday',
    priority: 'medium',
  },
  'county-of-orange': {
    name: 'County of Orange Planning Commission',
    slug: 'county-of-orange',
    platform: PLATFORM.CITY_CMS,
    agendaUrl: 'https://ocds.ocpublicworks.com/',
    boardName: 'Planning Commission',
    schedule: 'As needed',
    priority: 'low',
  },
};

// Residential keywords for filtering agenda items
const RESIDENTIAL_KEYWORDS = [
  'residential', 'single family', 'single-family', 'sfr', 'sfd',
  'addition', 'remodel', 'new construction', 'demolition', 'demo',
  'new home', 'new residence', 'new dwelling', 'custom home',
  'duplex', 'accessory dwelling', 'adu', 'guest house',
  'second story', 'second floor', '2nd floor', '2nd story',
  'rebuild', 'renovation', 'alteration', 'basement',
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
  timeout: 60000,
  navigationTimeout: 30000,
};

module.exports = {
  PLATFORM,
  cities,
  RESIDENTIAL_KEYWORDS,
  APPROVAL_KEYWORDS,
  DENIAL_KEYWORDS,
  browser,
};
