/**
 * DRB / Planning Agenda PDF Parser  (L2)
 *
 * Two jobs:
 *   1. parseDRBPdf(url)        — pull architect / owner / address / scope from a
 *                                single staff-report PDF (used by the Legistar
 *                                matter-attachment path).
 *   2. parseAgendaPdfItems(..) — split a whole meeting-agenda PDF (the Granicus
 *                                "Agenda" link serves a PDF) into per-item
 *                                records, keeping only residential-development
 *                                items, with address / applicant / case # / scope.
 *
 * Uses pdf-parse (a declared dependency). Every fetch + parse is hard-capped on
 * time + size and degrades gracefully: a failed/oversized/scanned PDF yields an
 * empty result (or []) rather than throwing — one bad PDF never aborts a run.
 */

const pdfParse = require('pdf-parse');

const DEFAULT_LIMITS = {
  maxAgendaPdfBytes: 12 * 1024 * 1024,
  pdfParseTimeoutMs: 20000,
  fetchTimeoutMs: 20000,
};

// Fetch a URL with an AbortController timeout + byte cap. Returns a Buffer or
// null (never throws for the caller's flow).
async function fetchPdfBuffer(url, limits = DEFAULT_LIMITS) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), limits.fetchTimeoutMs || 20000);
  try {
    const response = await fetch(url, {
      signal: ac.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
    });
    if (!response.ok) {
      console.log(`  [pdf-parser] HTTP ${response.status} for ${url.slice(0, 80)}`);
      return null;
    }
    const len = parseInt(response.headers.get('content-length') || '0', 10);
    if (len && len > (limits.maxAgendaPdfBytes || DEFAULT_LIMITS.maxAgendaPdfBytes)) {
      console.log(`  [pdf-parser] PDF too large (${len} bytes), skipping`);
      return null;
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > (limits.maxAgendaPdfBytes || DEFAULT_LIMITS.maxAgendaPdfBytes)) {
      console.log(`  [pdf-parser] PDF too large (${buffer.length} bytes), skipping`);
      return null;
    }
    return buffer;
  } catch (err) {
    console.log(`  [pdf-parser] fetch failed: ${String(err.message || err).slice(0, 80)}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Parse a PDF buffer to text with a hard time cap. Returns '' on failure.
async function pdfToText(buffer, limits = DEFAULT_LIMITS) {
  if (!buffer) return '';
  try {
    const data = await Promise.race([
      pdfParse(buffer),
      new Promise((_, rej) => setTimeout(() => rej(new Error('pdf parse timeout')), limits.pdfParseTimeoutMs || 20000)),
    ]);
    return (data && data.text) || '';
  } catch (err) {
    console.log(`  [pdf-parser] parse failed: ${String(err.message || err).slice(0, 80)}`);
    return '';
  }
}

// ---------------------------------------------------------------------------
// Field extractors (shared by both parse paths).
// ---------------------------------------------------------------------------
// Tidy a captured name: collapse whitespace, stop at the next role label that
// bled in (Owner/Applicant/Architect/Project Manager…), drop trailing role
// words / punctuation, and reject junk (a lone role word, or text starting with
// a lowercase connector like "and the City…").
function cleanName(raw) {
  let s = clean(raw);
  // Cut at a following role label (PDFs often run "Name OWNER" / "Name Architect").
  s = s.split(/\b(?:OWNER|APPLICANT|ARCHITECT|DESIGNER|PROJECT MANAGER|AGENT|ENGINEER OF RECORD|REPRESENTATIVE|CONTACT)\b/i)[0];
  // Cut at staff-report boilerplate that commonly trails a captured name.
  s = s.split(/\b(?:both dated|dated|revised|Attachment|Attachments|Exhibit|prepared|submitted|pursuant|located|requesting|proposes?)\b/i)[0];
  s = s.replace(/[\s,;:.&/-]+$/, '').trim();
  if (!s) return '';
  if (/^(?:and|the|of|for|to|with|a|an)\b/i.test(s)) return ''; // sentence fragment, not a name
  if (s.length < 4) return '';
  if (/^(owner|applicant|architect|designer|none|n\/a|tbd|various|same|staff)$/i.test(s)) return '';
  // Reject staff-initials / code fragments like "DL/jl" (no real word of 3+ letters).
  if (!/[A-Za-z]{3,}/.test(s)) return '';
  if (/^[A-Za-z]{1,3}\/[A-Za-z]{1,3}$/.test(s)) return '';
  return s;
}
function extractOwner(text) {
  const pats = [
    /(?:Applicant\/Owner|Owner\/Applicant|Property Owner|Applicant|Owner)[:\s]+([A-Z][A-Za-z0-9\s,.'&\/-]{3,60})/im,
    /(?:Name of Applicant|Name of Owner)[:\s]+([A-Z][A-Za-z0-9\s,.'&\/-]{3,60})/im,
  ];
  for (const p of pats) { const m = text.match(p); if (m) { const n = cleanName(m[1]); if (n) return n; } }
  return '';
}
function extractArchitect(text) {
  const pats = [
    /(?:Architect|Designer|Design Professional)[:\s]+([A-Z][A-Za-z0-9\s,.'&\/-]{3,60})/im,
    /(?:Prepared by|Designed by|Plans by)[:\s]+([A-Z][A-Za-z0-9\s,.'&\/-]{3,60})/im,
    /([A-Z][A-Za-z&.\s]{2,40} (?:Architect(?:s|ure)?|AIA))\b/m,
  ];
  for (const p of pats) { const m = text.match(p); if (m) { const n = cleanName(m[1]); if (n) return n; } }
  return '';
}
function extractAddress(text) {
  const pats = [
    /(?:Project (?:Address|Location|Site)|Site Address|Property Address|Location)[:\s]+([0-9][^\n]{6,70})/im,
    /\b(\d{1,6}\s+[A-Z][A-Za-z]+(?:\s+[A-Za-z]+){0,4}\s+(?:Street|St|Avenue|Ave|Boulevard|Blvd|Drive|Dr|Road|Rd|Lane|Ln|Way|Court|Ct|Circle|Cir|Place|Pl|Terrace|Ter|Highway|Hwy|Parkway|Pkwy)\.?)\b/i,
  ];
  for (const p of pats) { const m = text.match(p); if (m) return clean(m[1]); }
  return '';
}
function extractScope(text) {
  const pats = [
    /(?:Project Description|Scope of Work|Description|Proposal|Request)[:\s]+([^\n]{12,220})/im,
    /(?:requesting|proposes?|proposal to|to construct|to allow)[:\s]*([^\n]{12,220})/im,
  ];
  for (const p of pats) { const m = text.match(p); if (m) return clean(m[1]).slice(0, 300); }
  return '';
}
function extractLicense(text) {
  const m = text.match(/(?:LICENSE|LIC\.?\s*(?:NO\.?|#))[:\s]*([CB]?\d{3,6})/im);
  return m ? m[1] : '';
}
function clean(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }

/**
 * Parse a single staff-report PDF for architect/owner info.
 * @param {string} pdfUrl
 * @param {object} [limits]
 * @returns {Promise<{architect,owner,address,scope,designer,license:string}>}
 */
async function parseDRBPdf(pdfUrl, limits = DEFAULT_LIMITS) {
  const result = { architect: '', owner: '', address: '', scope: '', designer: '', license: '' };
  const buffer = await fetchPdfBuffer(pdfUrl, limits);
  const text = await pdfToText(buffer, limits);
  if (!text || text.length < 50) {
    if (buffer) console.log(`  [pdf-parser] PDF text too short (${text.length} chars) — likely scanned; skipping`);
    return result;
  }
  result.owner = extractOwner(text);
  result.architect = extractArchitect(text);
  if (result.architect) result.designer = result.architect;
  result.license = extractLicense(text);
  result.address = extractAddress(text);
  result.scope = extractScope(text);
  const found = Object.values(result).filter(Boolean).length;
  console.log(`  [pdf-parser] extracted ${found} fields from staff report`);
  return result;
}

/**
 * Split a full meeting-agenda PDF into per-item residential-development records.
 *
 * Granicus serves the "Agenda" link as a PDF. We download it once, segment the
 * text by agenda-item delimiters, keep only items matching the (multifamily)
 * keyword gate, and emit a lightweight record per item. The caller stamps
 * sourceCity / meetingDate / url etc.
 *
 * @param {string} pdfUrl
 * @param {object} opts
 * @param {(text:string)=>boolean} opts.matchesResidential  keyword gate
 * @param {(text:string)=>string}  opts.extractCaseNumber    case-# extractor
 * @param {(text:string)=>string|null} opts.detectRecommendation
 * @param {object} [opts.limits]
 * @returns {Promise<Array<{address,applicant,architect,caseNumber,scope,recommendation:string}>>}
 */
async function parseAgendaPdfItems(pdfUrl, opts = {}) {
  const limits = opts.limits || DEFAULT_LIMITS;
  const matchesResidential = opts.matchesResidential || (() => true);
  const extractCaseNumber = opts.extractCaseNumber || (() => '');
  const detectRecommendation = opts.detectRecommendation || (() => null);

  const buffer = await fetchPdfBuffer(pdfUrl, limits);
  const text = await pdfToText(buffer, limits);
  if (!text || text.length < 80) {
    if (buffer) console.log(`  [pdf-parser] agenda PDF text too short (${text.length}) — likely scanned; skipping`);
    return [];
  }

  // Segment into agenda items. Planning/DRB agendas number items ("1.", "B.1",
  // "ITEM 3", "CASE NO. ..."). Split on those boundaries; fall back to the whole
  // doc as one block if no structure is found.
  const rawSegments = text.split(/(?=\n\s*(?:ITEM\s+\d|CASE\s+(?:NO\.?|#)|AGENDA\s+ITEM\s+\d|[A-D]?\.?\s*\d{1,2}\.\s+[A-Z]))/i);
  const segments = rawSegments.length > 1 ? rawSegments : [text];

  const out = [];
  const seen = new Set();
  for (const seg of segments) {
    const block = clean(seg);
    if (block.length < 40) continue;
    if (!matchesResidential(block)) continue;

    const address = extractAddress(block);
    const applicant = extractOwner(block);
    const caseNumber = extractCaseNumber(block);
    // Need at least an address or a case number to be a usable lead.
    if (!address && !caseNumber) continue;

    const key = `${address}|${caseNumber}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    out.push({
      address,
      applicant,
      architect: extractArchitect(block),
      caseNumber,
      scope: (extractScope(block) || block.slice(0, 240)).replace(/\s+/g, ' ').trim(),
      recommendation: detectRecommendation(block),
    });
    if (out.length >= 60) break; // safety cap on a single huge agenda
  }
  console.log(`  [pdf-parser] agenda PDF -> ${out.length} residential item(s)`);
  return out;
}

module.exports = { parseDRBPdf, parseAgendaPdfItems, fetchPdfBuffer, pdfToText, cleanName };
