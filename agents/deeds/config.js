module.exports = {
  // Source metadata
  source: {
    name: 'OC Clerk-Recorder',
    id: 'recorder',
  },

  // Portal configuration
  portal: {
    name: 'OC RecorderWorks',
    baseUrl: 'https://cr.ocgov.com/recorderworks/',
    searchUrl: 'https://cr.ocgov.com/recorderworks/',
  },

  // Target document types to search
  documentTypes: {
    // High-value: funded construction loan = active project
    'construction-dot': {
      label: 'Construction Deed of Trust',
      searchTerms: ['DEED OF TRUST'],
      // Sub-filter: look for construction-related keywords in the record
      constructionKeywords: [
        'construction', 'building', 'improvement',
        'renovation', 'remodel', 'new home', 'residence',
      ],
      leadQuality: 'high',
    },
    // Intel: project just finished — too late for BBC, but useful tracking
    'notice-completion': {
      label: 'Notice of Completion',
      searchTerms: ['NOTICE OF COMPLETION'],
      constructionKeywords: [], // All NOCs are construction-related
      leadQuality: 'intel',
    },
    // Wealth signal: LLC/Trust purchase before rebuild
    'trust-transfer': {
      label: 'LLC/Trust Purchase',
      searchTerms: ['GRANT DEED'],
      // Sub-filter: grantee must be a trust or LLC
      entityKeywords: [
        'trust', 'llc', 'l.l.c.', 'living trust',
        'family trust', 'revocable trust', 'irrevocable trust',
        'holdings', 'properties', 'investments', 'capital',
      ],
      leadQuality: 'medium',
    },
  },

  // Search defaults
  search: {
    defaultDaysBack: 90,
    maxResults: 500,
    waitAfterNav: 5000,
    waitForSearch: 8000,
    waitBetweenPages: 3000,
    waitBetweenSearches: 4000,
  },

  // Target cities (Orange County BBC targets)
  targetCities: [
    'HUNTINGTON BEACH', 'NEWPORT BEACH', 'LAGUNA BEACH',
    'DANA POINT', 'SAN CLEMENTE', 'COSTA MESA', 'IRVINE',
    'LAGUNA NIGUEL', 'SAN JUAN CAPISTRANO',
  ],

  // Browser settings
  browser: {
    headless: true,
    viewport: { width: 1280, height: 900 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    timeout: 60000,
  },
};
