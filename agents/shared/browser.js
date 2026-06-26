/**
 * Shared browser launcher with 3-tier stealth fallback.
 *
 *   1. patchright              — Playwright fork that closes the leaks
 *                                playwright-extra-stealth no longer covers
 *                                (CDP, Runtime.enable). Best vs Cloudflare /
 *                                Akamai / DataDome. https://github.com/Kaliiiiiiiiii-Vinyzu/patchright
 *   2. playwright-extra+stealth — legacy stealth path, kept as fallback for
 *                                portals that don't fingerprint hard.
 *   3. plain playwright        — last resort.
 *
 * Override with DAS_BROWSER_DRIVER=patchright|stealth|playwright to force a
 * specific driver (useful for A/B testing a portal).
 *
 * Usage:
 *   const { launchBrowser } = require('../shared/browser');
 *   const { browser, driver } = await launchBrowser({ headed: false });
 */

async function launchBrowser(opts = {}) {
  const { headed = false, channel } = opts;
  const launchArgs = {
    headless: !headed,
    ...(channel ? { channel } : {}),
  };

  const force = (process.env.DAS_BROWSER_DRIVER || process.env.BBC_BROWSER_DRIVER || '').toLowerCase();
  const tryOrder = force
    ? [force]
    : ['patchright', 'stealth', 'playwright'];

  let lastErr;
  for (const driver of tryOrder) {
    try {
      if (driver === 'patchright') {
        const { chromium } = require('patchright');
        const browser = await chromium.launch(launchArgs);
        return { browser, driver: 'patchright', stealthUsed: true };
      }
      if (driver === 'stealth') {
        const { chromium } = require('playwright-extra');
        const StealthPlugin = require('puppeteer-extra-plugin-stealth');
        chromium.use(StealthPlugin());
        const browser = await chromium.launch(launchArgs);
        return { browser, driver: 'stealth', stealthUsed: true };
      }
      if (driver === 'playwright') {
        const { chromium } = require('playwright');
        const browser = await chromium.launch(launchArgs);
        return { browser, driver: 'playwright', stealthUsed: false };
      }
    } catch (err) {
      lastErr = err;
    }
  }

  throw new Error(
    `launchBrowser: no driver succeeded (tried ${tryOrder.join(', ')}): ${lastErr?.message || 'unknown'}`
  );
}

module.exports = { launchBrowser };