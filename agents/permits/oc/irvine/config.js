module.exports = {
  // Portal configuration — City of Irvine custom ASP.NET permit portal
  // Note: Irvine selected Clariti Enterprise in Nov 2024 to replace this system,
  // but the migration is not yet live. Use this legacy portal until further notice.
  portal: {
    name: 'City of Irvine',
    baseUrl: 'https://permits.cityofirvine.org/irvinepermits',
    searchPath: '/Default.asp?Build=PM.pmPermit.SearchForm',
    detailPath: '/Default.asp?Build=PM.pmPermit.PermitDetail',
  },

  // No login required - public plan check inquiry
  credentials: null,

  // Search defaults
  search: {
    pageSize: 50,
    maxPages: 100,
    waitAfterLogin: 0,
    waitBetweenPages: 2000,
    waitForFirstPage: 5000,
  },

  // Permit types for plan check (Irvine uses "Building" permit type for plan checks)
  planCheckTypes: [
    'BUILDING',
    'PLAN CHECK',
    'RESIDENTIAL',
    'NEW DWELLING',
    'ADDITION',
    'REMODEL',
    'GRADING',
  ],

  // Plan statuses considered "active" in Irvine's system
  activeStatuses: [
    'Plan Check',
    'Issued',
    'Under Review',
    'Corrections Required',
    'Pending',
    'In Process',
    'Active',
  ],

  // Plan statuses considered "completed"
  completedStatuses: [
    'Final',
    'Closed',
    'Expired',
    'Cancelled',
    'Void',
    'Withdrawn',
  ],

  // Historical records portal (Hyland OnBase, for older permits pre-2010)
  historicalPortal: {
    name: 'IrvineQuickRecords (OnBase)',
    url: 'https://irvinequickrecords.com/',
    note: 'Free account required for full access',
  },

  // Browser settings
  browser: {
    headless: true,
    viewport: { width: 1280, height: 900 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    timeout: 120000,
  },
};
