/**
 * Granicus Scraper — L2 (Laguna Beach DRB, Irvine PC, San Juan Capistrano PC/DRC)
 *
 * Granicus exposes each meeting two ways:
 *   - GeneratedAgendaViewer.php?view_id=N&event_id=M  -> an HTML agenda whose
 *     item text (scope, "(Applicant: …)", "at <address>", "(APN …)") renders
 *     client-side. This is the rich, parseable surface.
 *   - AgendaViewer.php?...                            -> the same agenda as a
 *     downloadable PDF (sometimes scanned / sometimes an HTML stub).
 *
 * Flow:
 *   1. Render ViewPublisher.php?view_id=<granicusViewId> in a (stealth) browser
 *      and read each meeting row's date + event_id.
 *   2. For each row within --days (capped at limits.maxMeetingsPerCity), render
 *      GeneratedAgendaViewer for that event_id, split body text into numbered
 *      agenda items, keep residential-development items, and extract address /
 *      applicant / APN / case# / scope inline.
 *   3. If the agenda link is a PDF and HTML extraction yields nothing, fall back
 *      to downloading + pdf-parsing it.
 *
 * Uses the shared 3-tier stealth browser launcher. One city failing returns []
 * (logged) — it never throws to the orchestrator. Waits + counts are capped so
 * the run never hangs.
 *
 * PHASE-0 VERIFY: per-city granicusViewId in config.js was confirmed live 2026-06.
 * Granicus rotates view_ids occasionally — re-confirm if a city returns 0.
 */

const { launchBrowser } = require('../shared/browser');
const { browser: browserConfig, RESIDENTIAL_KEYWORDS, APPROVAL_KEYWORDS, DENIAL_KEYWORDS, limits } = require('./config');
const { parseAgendaPdfItems } = require('./pdf-parser');

function matchesResidential(text) {
  const lower = (text || '').toLowerCase();
  return RESIDENTIAL_KEYWORDS.some(kw => lower.includes(kw));
}
function detectRecommendation(text) {
  const lower = (text || '').toLowerCase();
  if (APPROVAL_KEYWORDS.some(kw => lower.includes(kw))) return 'approval';
  if (DENIAL_KEYWORDS.some(kw => lower.includes(kw))) return 'denial';
  return null;
}
function extractCaseNumber(text) {
  if (!text) return '';
  const patterns = [
    /\b(DR[PCS]?[-\s]?\d{2,4}[-\s]?\d{1,5})\b/i,
    /\b(PA[-\s]?\d{2,4}[-\s]?\d{1,5})\b/i,
    /\b(CDP[-\s]?\d{2,4}[-\s]?\d{1,5})\b/i,
    /\b(CUP[-\s]?\d{2,4}[-\s]?\d{1,5})\b/i,
    /\b(TTM[-\s]?\d{2,5}(?:[-\s]?\d{1,4})?)\b/i,
    /\b(TPM[-\s]?\d{2,5})\b/i,
    /\b(AC[-\s]?\d{2,4}[-\s]?\d{1,5})\b/i,
    /\b(GPA[-\s]?\d{2,4}[-\s]?\d{1,5})\b/i,
    /\b(SP[-\s]?\d{2,4}[-\s]?\d{1,5})\b/i,
    /\b(ZC[-\s]?\d{2,4}[-\s]?\d{1,5})\b/i,
    /\b(\d{8}-[A-Z]{2,4})\b/, // Irvine master-plan ids e.g. 00873726-PMP
  ];
  for (const p of patterns) { const m = text.match(p); if (m) return m[1].trim().toUpperCase(); }
  return '';
}

// Inline extractors tuned to OC agenda phrasing.
function extractAddressInline(text) {
  const pats = [
    // "... located at 30700 Rancho Viejo Road" / "at 31341 Don Juan Avenue"
    /\b(?:located at|at)\s+(\d{1,6}\s+[A-Z][A-Za-z]+(?:\s+[A-Za-z]+){0,4}\s+(?:Street|St|Avenue|Ave|Boulevard|Blvd|Drive|Dr|Road|Rd|Lane|Ln|Way|Court|Ct|Circle|Cir|Place|Pl|Terrace|Ter|Highway|Hwy|Parkway|Pkwy)\.?)/i,
    // bare "123 Main Street"
    /\b(\d{1,6}\s+[A-Z][A-Za-z]+(?:\s+[A-Za-z]+){0,4}\s+(?:Street|St|Avenue|Ave|Boulevard|Blvd|Drive|Dr|Road|Rd|Lane|Ln|Way|Court|Ct|Circle|Cir|Place|Pl|Terrace|Ter|Highway|Hwy|Parkway|Pkwy)\.?)\b/i,
  ];
  for (const p of pats) {
    const m = text.match(p);
    if (m) return trimAddress(m[1]);
  }
  return '';
}
// Normalize a captured address: collapse spaces, cut trailing context that the
// greedy {0,4} words can absorb ("… DRIVE IN PLANNING AREA", parentheticals).
function trimAddress(s) {
  return String(s).replace(/\s+/g, ' ').trim()
    .replace(/\s+(?:IN|AT|WITHIN|LOCATED)\b.*$/i, '')
    .replace(/\s*[(,].*$/, '')
    .trim();
}
function extractApn(text) {
  const m = text.match(/\bAPN[:\s]*([0-9]{3}[-\s]?[0-9]{2,3}[-\s]?[0-9]{2,3})/i)
    || text.match(/Assessor\s+Parcel\s+Number[:\s]*([0-9]{3}[-\s]?[0-9]{2,3}[-\s]?[0-9]{2,3})/i);
  return m ? m[1].replace(/\s+/g, '').trim() : '';
}
function extractApplicantInline(text) {
  const pats = [
    // "(Applicant: Peter Vanek, Integral Partners Funding, LLC)"
    /\(\s*Applicant[:\s]+([^)]{3,80}?)\)/i,
    // "FILED BY HUNSAKER & ASSOCIATES, ON BEHALF OF IRVINE COMPANY COMMUNITY DEVELOPMENT"
    /ON BEHALF OF\s+([A-Z][A-Za-z0-9&.,'\s-]{3,70}?)(?:\.|;|$|\s{2,})/i,
    /FILED BY\s+([A-Z][A-Za-z0-9&.,'\s-]{3,70}?)(?:,?\s+ON BEHALF OF|\.|;|$)/i,
    /Applicant[:\s]+([A-Z][A-Za-z0-9&.,'\s-]{3,70}?)(?:\)|\.|;|\(Project)/i,
  ];
  for (const p of pats) { const m = text.match(p); if (m) return m[1].replace(/\s+/g, ' ').trim().replace(/[,.]$/, ''); }
  return '';
}
function extractArchitectInline(text) {
  const m = text.match(/\b(?:Architect|Designer|Design Professional)[:\s]+([A-Z][A-Za-z0-9&.,'\s-]{3,60}?)(?:\)|\.|;|\(Project)/i);
  return m ? m[1].replace(/\s+/g, ' ').trim().replace(/[,.]$/, '') : '';
}

function parseDate(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return null;
  // Sanity window: reject parses that landed far outside plausible meeting dates
  // (e.g. a street number "16972" parsed as year 16972).
  const y = d.getFullYear();
  const nowY = new Date().getFullYear();
  if (y < 2000 || y > nowY + 2) return null;
  return d.toISOString().split('T')[0];
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Turn a meeting row's agenda/clip URL into the GeneratedAgendaViewer HTML URL.
function toGeneratedAgendaUrl(base, viewId, agendaUrl) {
  try {
    const u = new URL(agendaUrl);
    const eventId = u.searchParams.get('event_id');
    const clipId = u.searchParams.get('clip_id');
    if (eventId) return `${base}/GeneratedAgendaViewer.php?view_id=${viewId}&event_id=${eventId}`;
    if (clipId) return `${base}/GeneratedAgendaViewer.php?view_id=${viewId}&clip_id=${clipId}`;
  } catch { /* fall through */ }
  return null;
}

// Render a GeneratedAgendaViewer HTML agenda and extract residential items.
async function extractItemsFromHtmlAgenda(page, gavUrl) {
  await page.goto(gavUrl, { waitUntil: 'domcontentloaded', timeout: browserConfig.navigationTimeout });
  await page.waitForTimeout(2000);
  const bodyText = await page.evaluate(() => document.body.innerText || '');
  if (!bodyText || bodyText.length < 80) return [];

  // Split into numbered agenda items ("1.\t…", "2. …", "ITEM 3", "B.1").
  const segments = bodyText.split(/(?=\n\s*(?:\d{1,2}\.\s)|(?:ITEM\s+\d)|(?:[A-D]\.\d))/i);
  const items = [];
  const seen = new Set();
  for (const seg of segments) {
    const block = seg.replace(/\s+/g, ' ').trim();
    if (block.length < 40) continue;
    if (!matchesResidential(block)) continue;
    const address = extractAddressInline(block);
    const caseNumber = extractCaseNumber(block);
    const apn = extractApn(block);
    // Reject the commissioner-roster / meeting preamble that repeats on every
    // agenda (it can incidentally contain an address/project name from a later
    // item). A genuine item never leads with the full roster yet lacks a case#.
    const isRoster = /\bChair\b[\s\S]{0,80}\bVice Chair\b[\s\S]{0,120}\bCommissioner\b/i.test(block);
    if (isRoster && !caseNumber && !apn) continue;
    // Anchor: a case # or APN is the strongest anchor. WITHOUT one, only keep the
    // item if it has an address AND an explicit applicant/"located at" cue — this
    // drops continuation/notice blocks that merely name a project (they reappear
    // as the real cased item) while keeping genuine "located at … (Applicant: …)".
    const hasApplicantCue = /\(\s*Applicant[:\s]|FILED BY|ON BEHALF OF|\blocated at\b/i.test(block);
    if (!caseNumber && !apn && !(address && hasApplicantCue)) continue;
    const key = `${address}|${caseNumber}|${apn}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({
      address,
      apn,
      applicant: extractApplicantInline(block),
      architect: extractArchitectInline(block),
      caseNumber,
      scope: block.slice(0, 300),
      recommendation: detectRecommendation(block),
    });
    if (items.length >= 40) break;
  }
  return items;
}

/**
 * Scrape one Granicus city for residential-development agenda items.
 * @returns {Promise<object[]>}
 */
async function scrapeGranicus(cityConfig, options = {}) {
  const { days = 90, headed = false } = options;
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - days);

  const viewId = cityConfig.granicusViewId || 1;
  const base = cityConfig.granicusUrl;
  const listUrl = `${base}/ViewPublisher.php?view_id=${viewId}`;
  const results = [];
  let browserHandle;

  try {
    const launched = await launchBrowser({ headed });
    browserHandle = launched.browser;
    const context = await browserHandle.newContext({
      viewport: browserConfig.viewport,
      userAgent: browserConfig.userAgent,
      acceptDownloads: false,
    });
    const page = await context.newPage();
    page.setDefaultTimeout(browserConfig.timeout);

    console.log(`[granicus] ${cityConfig.name} (driver=${launched.driver}) -> ${listUrl}`);
    await page.goto(listUrl, { waitUntil: 'domcontentloaded', timeout: browserConfig.navigationTimeout });
    await page.waitForTimeout(3500);

    // Meeting rows: row text (for the date) + the agenda link (PDF or viewer).
    const rows = await page.$$eval('tr', (trs) => {
      const out = [];
      for (const tr of trs) {
        const text = (tr.textContent || '').replace(/\s+/g, ' ').trim();
        if (!text) continue;
        const links = Array.from(tr.querySelectorAll('a'))
          .map(a => ({ text: (a.textContent || '').trim(), href: a.href }))
          .filter(l => l.href);
        const agenda = links.find(l => /AgendaViewer\.php|GeneratedAgendaViewer\.php/i.test(l.href))
          || links.find(l => /agenda/i.test(l.text) && /\.pdf|MetaViewer/i.test(l.href));
        if (!agenda) continue;
        out.push({ text: text.slice(0, 200), agendaUrl: agenda.href });
      }
      return out;
    });

    // Keep rows within the lookback window, cap count (front of list = newest).
    const dated = [];
    for (const row of rows) {
      // Require a real date: "Month DD, YYYY" or MM/DD/YYYY (4-digit year) so a
      // street number can't be misread as a date.
      const dm = row.text.match(/((?:January|February|March|April|May|June|July|August|September|October|November|December|\w{3,9})\s+\d{1,2},?\s*(?:19|20)\d{2})|(\b\d{1,2}\/\d{1,2}\/(?:19|20)\d{2}\b)/);
      const iso = dm ? parseDate(dm[0]) : null;
      // Skip rows older than the window; keep undated rows (newest-first) so a
      // city whose rows render without a parseable date still gets scanned.
      if (iso && new Date(iso) < cutoffDate) continue;
      dated.push({ ...row, meetingDate: iso });
    }
    const meetings = dated.slice(0, limits.maxMeetingsPerCity);
    console.log(`[granicus] ${cityConfig.slug}: ${rows.length} agenda rows, ${meetings.length} within ${days}d (cap ${limits.maxMeetingsPerCity})`);

    for (const meeting of meetings) {
      let items = [];
      const gavUrl = toGeneratedAgendaUrl(base, viewId, meeting.agendaUrl);
      // Primary: render the HTML agenda.
      if (gavUrl) {
        try {
          items = await extractItemsFromHtmlAgenda(page, gavUrl);
        } catch (err) {
          console.warn(`[granicus] ${cityConfig.slug}: HTML agenda error: ${String(err.message).slice(0, 70)}`);
        }
      }
      // Fallback: if HTML yielded nothing and the link is a PDF, parse the PDF.
      if (items.length === 0 && /AgendaViewer\.php|\.pdf/i.test(meeting.agendaUrl)) {
        try {
          const pdfItems = await parseAgendaPdfItems(meeting.agendaUrl, {
            matchesResidential, extractCaseNumber, detectRecommendation, limits,
          });
          items = pdfItems.map(it => ({ ...it, apn: extractApn(it.scope || '') }));
        } catch (err) {
          console.warn(`[granicus] ${cityConfig.slug}: PDF fallback error: ${String(err.message).slice(0, 70)}`);
        }
      }

      for (const it of items) {
        results.push({
          source: 'planning-drb',
          sourceCity: cityConfig.slug,
          sourceName: cityConfig.name,
          metro: 'OC',
          meetingDate: meeting.meetingDate,
          caseNumber: it.caseNumber || null,
          apn: it.apn || null,
          address: it.address || null,
          applicant: it.applicant || null,
          architect: it.architect || null,
          scope: it.scope || null,
          recommendation: it.recommendation || null,
          staffReportUrl: gavUrl || meeting.agendaUrl,
          url: gavUrl || meeting.agendaUrl,
          projectType: null,
        });
      }
      await sleep(limits.throttleMs);
    }

    console.log(`[granicus] ${cityConfig.slug}: extracted ${results.length} residential agenda items`);
  } catch (err) {
    console.error(`[granicus] ${cityConfig.slug}: FAILED - ${String(err.message).slice(0, 120)}`);
  } finally {
    if (browserHandle) { try { await browserHandle.close(); } catch { /* ignore */ } }
  }

  return results;
}

module.exports = { scrapeGranicus };
