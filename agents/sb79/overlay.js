// agents/sb79/overlay.js — PERCEIVE for L6 (SB 79 / transit-corridor triggers).
//
// SB 79 (effective 2026-07-01) upzones parcels near MAJOR TRANSIT STOPS. At MVP
// this agent does NOT scan all parcels (that is the Phase-4 enhancement). It
// OVERLAYS transit-stop locations (GTFS static feeds) against records already
// harvested by the OTHER signal layers (CEQA/HCD/permits/deeds/...) and FLAGS
// the ones that fall within SB 79 distance tiers (400/800/1600 m). This is the
// spec's approved MVP approximation (signal-sources.json L6_sb79.verify).
//
// Output contract: this layer emits the SAME records it consumed (preserving
// address / apn / metro / projectType / unitCount / stage / sources / geo /
// legislative / ...), annotated with legislative.sb79=true + sb79Tier +
// nearestStop. The consolidator dedups by id = sha1(normalizedAddress|apn) and
// OR-merges legislative flags, so the SB 79 flag lands on the EXISTING pursuit
// rather than creating a duplicate. The harness reason() is identity (the
// inputs are already pursuit-shaped + ICP-filtered), so we must NOT re-filter.
//
// GTFS handling (NO new npm dependency): a GTFS feed is a .zip containing
// stops.txt (CSV: stop_id,stop_name,stop_lat,stop_lon,...). Node 20+ built-in
// fetch downloads it; we unzip stops.txt with a minimal inline reader that
// handles the two storage methods real GTFS feeds use — STORED (0) and DEFLATE
// (8, via zlib.inflateRawSync). Parsed stops are cached to
// data/output/gtfs-stops-<agency>.json so re-runs are offline-fast.
//
// GRACEFUL DEGRADATION (REQUIRED): if GTFS can't be fetched/unzipped, or no
// harvested record carries coordinates yet (enrichment/geocode hasn't run),
// we log a clear warning and return [] — this module NEVER throws. The harness
// wraps perceive() in a retry loop; an empty array is a valid empty run.
//
// !!! Anything that can drift (GTFS feed URLs, route_type semantics, the raw
// per-layer output filenames) is tagged `// PHASE-0 VERIFY:` here and/or in
// config.js — confirm live in Phase 0.

'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const config_ = require('./config');

const EARTH_RADIUS_M = 6371008.8; // mean Earth radius (meters)

// In-memory cache of loaded stops, so nearTransit() (which the orchestrator may
// call per-record during enrichment) does not reload the JSON every call.
let STOPS_CACHE = null;

// ---------------------------------------------------------------------------
// Haversine great-circle distance in meters between two lat/lng points.
// ---------------------------------------------------------------------------
function haversineMeters(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

// ---------------------------------------------------------------------------
// Minimal ZIP reader — extract a single named entry (stops.txt) from a GTFS zip
// buffer WITHOUT a third-party dependency. Reads the End-Of-Central-Directory
// record, walks the central directory, and inflates the target entry. Supports
// the only two compression methods GTFS feeds use in practice:
//   method 0  = STORED (no compression)
//   method 8  = DEFLATE (raw deflate stream → zlib.inflateRawSync)
// Returns the entry bytes as a Buffer, or null if not found / unsupported.
//
// PHASE-0 VERIFY: this is a deliberately small reader (no ZIP64, no encryption,
// no data-descriptor-only entries). GTFS static feeds from OCTA / LA Metro /
// WeGo are plain STORED/DEFLATE zips well under 4 GB, so this is sufficient. If
// a future feed ships ZIP64 or a streaming-only entry, swap in `adm-zip`
// (the one dep we'd add) and keep this as the fallback.
// ---------------------------------------------------------------------------
function readZipEntry(buf, wantName) {
  const want = String(wantName).toLowerCase();
  // Locate End Of Central Directory (EOCD) signature 0x06054b50, scanning back
  // from the end (comment field is usually empty → near the tail).
  const EOCD_SIG = 0x06054b50;
  let eocd = -1;
  const minEocd = 22;
  for (let i = buf.length - minEocd; i >= 0 && i >= buf.length - minEocd - 65536; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) return null;
  const cdCount = buf.readUInt16LE(eocd + 10);
  let cdOffset = buf.readUInt32LE(eocd + 16);

  const CEN_SIG = 0x02014b50; // central directory file header
  for (let n = 0; n < cdCount; n++) {
    if (cdOffset + 46 > buf.length || buf.readUInt32LE(cdOffset) !== CEN_SIG) break;
    const method = buf.readUInt16LE(cdOffset + 10);
    const compSize = buf.readUInt32LE(cdOffset + 20);
    const nameLen = buf.readUInt16LE(cdOffset + 28);
    const extraLen = buf.readUInt16LE(cdOffset + 30);
    const commentLen = buf.readUInt16LE(cdOffset + 32);
    const localOffset = buf.readUInt32LE(cdOffset + 42);
    const name = buf.toString('utf8', cdOffset + 46, cdOffset + 46 + nameLen);
    const advance = 46 + nameLen + extraLen + commentLen;

    // Match by basename so "stops.txt" matches even if nested in a folder.
    if (path.posix.basename(name).toLowerCase() === want) {
      return inflateLocalEntry(buf, localOffset, method, compSize);
    }
    cdOffset += advance;
  }
  return null;
}

// Read the local file header at `localOffset` and decompress its data.
function inflateLocalEntry(buf, localOffset, methodFromCen, compSizeFromCen) {
  const LOC_SIG = 0x04034b50; // local file header
  if (localOffset + 30 > buf.length || buf.readUInt32LE(localOffset) !== LOC_SIG) return null;
  const method = buf.readUInt16LE(localOffset + 8) || methodFromCen;
  const nameLen = buf.readUInt16LE(localOffset + 26);
  const extraLen = buf.readUInt16LE(localOffset + 28);
  const dataStart = localOffset + 30 + nameLen + extraLen;
  const dataEnd = dataStart + compSizeFromCen;
  const slice = buf.subarray(dataStart, Math.min(dataEnd, buf.length));
  try {
    if (method === 0) return Buffer.from(slice);                 // STORED
    if (method === 8) return zlib.inflateRawSync(slice);          // DEFLATE
  } catch { /* corrupt/short stream → null */ }
  return null; // unsupported method (e.g. bzip2/lzma — not used by GTFS)
}

// ---------------------------------------------------------------------------
// CSV parse for GTFS stops.txt. GTFS CSV is RFC-4180-ish (commas, optional
// double-quotes, "" escaping). stop_name can contain commas, so we use a small
// quote-aware line/field splitter rather than naive split(',').
// ---------------------------------------------------------------------------
function parseCsvLine(line) {
  const out = [];
  let field = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"') {
        if (line[i + 1] === '"') { field += '"'; i++; }
        else inQ = false;
      } else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { out.push(field); field = ''; }
    else field += c;
  }
  out.push(field);
  return out;
}

// Parse stops.txt content → [{ id, name, lat, lon, locationType, routeHint }].
function parseStopsTxt(text) {
  const rows = String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n').filter(l => l.length);
  if (!rows.length) return [];
  const header = parseCsvLine(rows[0]).map(h => h.trim().replace(/^﻿/, '').toLowerCase());
  const idx = {
    id: header.indexOf('stop_id'),
    name: header.indexOf('stop_name'),
    lat: header.indexOf('stop_lat'),
    lon: header.indexOf('stop_lon'),
    locType: header.indexOf('location_type'),
  };
  if (idx.lat < 0 || idx.lon < 0) return []; // not a usable stops file
  const stops = [];
  for (let r = 1; r < rows.length; r++) {
    const cols = parseCsvLine(rows[r]);
    const lat = parseFloat(cols[idx.lat]);
    const lon = parseFloat(cols[idx.lon]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    // location_type 1 = station, 0/'' = stop/platform. Skip entrances(2),
    // generic nodes(3), boarding areas(4) — they are not boardable stops.
    const locType = idx.locType >= 0 ? String(cols[idx.locType] || '').trim() : '';
    if (locType === '2' || locType === '3' || locType === '4') continue;
    stops.push({
      id: idx.id >= 0 ? String(cols[idx.id] || '').trim() : '',
      name: idx.name >= 0 ? String(cols[idx.name] || '').trim() : '',
      lat, lon,
      locationType: locType || '0',
    });
  }
  return stops;
}

// ---------------------------------------------------------------------------
// GTFS routes.txt → set of stop "majorness". SB 79 keys off MAJOR transit stops
// (rail/BRT), so where a feed lets us tell rail from bus we keep only stops on
// major routes. Tying stops→routes precisely needs trips.txt + stop_times.txt
// (large). At MVP we use a cheaper heuristic: inspect routes.txt route_type; if
// the feed has ANY major-route types we KEEP ALL stops but RECORD the feed as
// "major-capable"; if the feed is bus-only we still keep all stops (an
// over-broad transit flag beats none — humans validate downstream).
// PHASE-0 VERIFY: when OC Streetcar / a rail feed is added, tighten this to a
// real stop→route_type join (trips.txt + stop_times.txt) so only rail/BRT
// stops flag. Today OCTA is bus-only (route_type 3), so all stops are kept.
// ---------------------------------------------------------------------------
function routeTypesFromFeed(buf) {
  const routesTxt = readZipEntry(buf, 'routes.txt');
  if (!routesTxt) return null;
  const rows = routesTxt.toString('utf8').replace(/\r\n/g, '\n').split('\n').filter(Boolean);
  if (!rows.length) return null;
  const header = parseCsvLine(rows[0]).map(h => h.trim().toLowerCase());
  const ti = header.indexOf('route_type');
  if (ti < 0) return null;
  const types = new Set();
  for (let r = 1; r < rows.length; r++) {
    const t = parseInt(parseCsvLine(rows[r])[ti], 10);
    if (Number.isFinite(t)) types.add(t);
  }
  return types;
}

// ---------------------------------------------------------------------------
// Network: download a GTFS zip (Node 20+ built-in fetch, AbortController
// timeout). Returns a Buffer or null (graceful).
// ---------------------------------------------------------------------------
async function downloadZip(url, { config = config_, log } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.requestTimeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'user-agent': config.userAgent, accept: 'application/zip,application/octet-stream,*/*' },
    });
    if (!res.ok) { if (log) log(`GTFS HTTP ${res.status} for ${shortUrl(url)}`); return null; }
    const ab = await res.arrayBuffer();
    return Buffer.from(ab);
  } catch (err) {
    if (log) log(`GTFS download failed (${err.name === 'AbortError' ? 'timeout' : err.message}) for ${shortUrl(url)}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function shortUrl(u) { return String(u).replace(/^https?:\/\//, '').slice(0, 90); }

// ---------------------------------------------------------------------------
// Per-agency cached stops. cachePath = data/output/gtfs-stops-<agency>.json.
// Returns [{ id, name, lat, lon, agency }] or [] (graceful).
// ---------------------------------------------------------------------------
function cachePathFor(agency, config = config_) {
  return path.join(config.OUTPUT_DIR, `gtfs-stops-${String(agency).toLowerCase()}.json`);
}

function readCache(agency, { config = config_, log } = {}) {
  const p = cachePathFor(agency, config);
  try {
    if (!fs.existsSync(p)) return null;
    const ageDays = (Date.now() - fs.statSync(p).mtimeMs) / 86400000;
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!data || !Array.isArray(data.stops)) return null;
    return { stops: data.stops, ageDays, fresh: ageDays <= config.cacheMaxAgeDays };
  } catch (err) {
    if (log) log(`cache read failed for ${agency}: ${err.message}`);
    return null;
  }
}

function writeCache(agency, stops, meta, { config = config_, log } = {}) {
  try {
    fs.mkdirSync(config.OUTPUT_DIR, { recursive: true });
    fs.writeFileSync(cachePathFor(agency, config), JSON.stringify({
      agency, fetchedAt: new Date().toISOString(), count: stops.length, ...meta, stops,
    }, null, 2));
  } catch (err) {
    if (log) log(`cache write failed for ${agency}: ${err.message}`);
  }
}

// Load stops for ONE agency: fresh cache → use it; else download+parse+cache;
// on any failure fall back to a stale cache if one exists. Never throws.
async function loadAgencyStops(agency, { config = config_, log } = {}) {
  const url = config.gtfsFeeds[agency];
  if (!url) { if (log) log(`no GTFS URL configured for agency ${agency}`); return []; }

  const cached = readCache(agency, { config, log });
  if (cached && cached.fresh && cached.stops.length) {
    if (log) log(`${agency}: ${cached.stops.length} stops from cache (${cached.ageDays.toFixed(1)}d old)`);
    return cached.stops.map(s => ({ ...s, agency }));
  }

  if (log) log(`${agency}: fetching GTFS ${shortUrl(url)}`);
  const buf = await downloadZip(url, { config, log });
  if (!buf) {
    if (cached && cached.stops.length) {
      if (log) log(`${agency}: download failed — using STALE cache (${cached.ageDays.toFixed(1)}d old, ${cached.stops.length} stops)`);
      return cached.stops.map(s => ({ ...s, agency }));
    }
    return []; // graceful: no feed, no cache
  }

  const stopsTxt = readZipEntry(buf, 'stops.txt');
  if (!stopsTxt) {
    // Unzip failed (unsupported method) — note the PHASE-0 dep option + degrade.
    if (log) log(`${agency}: could not extract stops.txt from GTFS zip ` +
      `(unsupported compression — see PHASE-0 VERIFY in overlay.js; adm-zip would be the one dep to add).`);
    if (cached && cached.stops.length) {
      if (log) log(`${agency}: falling back to STALE cache (${cached.stops.length} stops)`);
      return cached.stops.map(s => ({ ...s, agency }));
    }
    return [];
  }

  let stops = parseStopsTxt(stopsTxt.toString('utf8'));
  // Major-stop awareness (heuristic — see routeTypesFromFeed notes).
  let routeTypes = null;
  try { routeTypes = routeTypesFromFeed(buf); } catch { /* ignore */ }
  const hasMajor = routeTypes ? [...routeTypes].some(t => config.majorRouteTypes.includes(t)) : null;
  const busOnly = routeTypes ? [...routeTypes].every(t => t === 3) : null;
  if (log) {
    const rt = routeTypes ? `route_types=[${[...routeTypes].sort((a, b) => a - b).join(',')}]` : 'route_types=?';
    log(`${agency}: ${stops.length} stops parsed (${rt}${hasMajor ? ', major-capable' : busOnly ? ', bus-only → keeping all stops' : ''})`);
  }

  writeCache(agency, stops, { url, hasMajor, busOnly, routeTypes: routeTypes ? [...routeTypes] : null }, { config, log });
  return stops.map(s => ({ ...s, agency }));
}

// ---------------------------------------------------------------------------
// PUBLIC: loadStops(config, log) → [{ id, name, lat, lon, agency }] for ALL
// active-metro agencies, cached in-process. Used by perceive() AND exported so
// the orchestrator can warm it before per-record nearTransit() calls.
// ---------------------------------------------------------------------------
async function loadStops(config = config_, log = () => {}) {
  if (STOPS_CACHE) return STOPS_CACHE;
  const agencies = config.activeAgencies();
  if (!agencies.length) {
    log(`no GTFS agencies for active metros [${config.activeMetros.join(', ')}] — nothing to load`);
    STOPS_CACHE = [];
    return STOPS_CACHE;
  }
  const all = [];
  for (const agency of agencies) {
    let stops = [];
    try { stops = await loadAgencyStops(agency, { config, log }); }
    catch (err) { log(`agency ${agency} load error (skipped): ${err.message}`); }
    for (const s of stops) all.push(s);
  }
  log(`loaded ${all.length} transit stops across ${agencies.length} agenc${agencies.length === 1 ? 'y' : 'ies'} (${agencies.join(', ')})`);
  STOPS_CACHE = all;
  return STOPS_CACHE;
}

// Reset the in-process stop cache (tests / re-runs with different config).
function _resetStopsCache() { STOPS_CACHE = null; }

// ---------------------------------------------------------------------------
// Tier resolution. distanceTiersMeters is sorted ascending [t1, t2, t3]:
//   meters <= t1 → tier 1 (closest), <= t2 → 2, <= t3 → 3, else null (outside).
// ---------------------------------------------------------------------------
function tierForMeters(meters, tiers) {
  for (let i = 0; i < tiers.length; i++) {
    if (meters <= tiers[i]) return i + 1;
  }
  return null;
}

// Nearest stop to a point over an explicit stop list (no I/O). Linear scan with
// a cheap bounding-box prefilter (skip stops > ~1 outer-tier worth of degrees
// away before computing haversine) so large feeds stay fast.
function nearestStopIn(lat, lng, stops, maxMeters) {
  // ~111,320 m per degree latitude; pad generously for the prefilter.
  const degPad = (maxMeters / 111320) * 1.5 + 0.001;
  let best = null;
  for (const s of stops) {
    if (Math.abs(s.lat - lat) > degPad || Math.abs(s.lon - lng) > degPad) continue;
    const m = haversineMeters(lat, lng, s.lat, s.lon);
    if (!best || m < best.meters) best = { meters: m, stop: s };
  }
  return best;
}

// ---------------------------------------------------------------------------
// PUBLIC: nearTransit(lat, lng) → { withinTier, meters, stopName, agency }.
// Pure-ish function over the in-process STOPS_CACHE. The orchestrator may call
// this directly during enrichment (after loadStops() has warmed the cache).
// Returns withinTier=null + meters=null if stops aren't loaded or none are in
// range. NEVER throws.
// ---------------------------------------------------------------------------
function nearTransit(lat, lng, opts = {}) {
  const config = opts.config || config_;
  const stops = opts.stops || STOPS_CACHE;
  const tiers = opts.tiers || config.distanceTiersMeters;
  const NONE = { withinTier: null, meters: null, stopName: null, agency: null };
  if (!Array.isArray(stops) || !stops.length) return NONE;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return NONE;
  const outer = tiers[tiers.length - 1];
  const near = nearestStopIn(lat, lng, stops, outer);
  if (!near) return NONE;
  const meters = Math.round(near.meters);
  return {
    withinTier: tierForMeters(meters, tiers), // 1|2|3|null
    meters,
    stopName: near.stop.name || near.stop.id || null,
    agency: near.stop.agency || null,
  };
}

// ---------------------------------------------------------------------------
// Find the most-recent raw per-layer output files (the OTHER layers' harvest
// for today), excluding sb79's own output, and return a flat list of records.
// Pattern: data/output/<agent>-leads-<date>.json (and the stable
// <agent>-leads.json the harness also writes). One file per agent — we prefer
// the dated file and de-dup by agent so we don't double-count.
// PHASE-0 VERIFY: filename convention is owned by the harness ACT() (writes
// `${name}-leads-${stamp}.json` + stable `${name}-leads.json`) and the
// orchestrator runAgent() (`${dir}-leads-${date}.json`). If that changes, update
// this glob.
// ---------------------------------------------------------------------------
function findHarvestedRecords({ config = config_, log = () => {}, selfName = 'sb79' } = {}) {
  const dir = config.OUTPUT_DIR;
  let files = [];
  try { files = fs.readdirSync(dir); } catch { return []; }

  // Group "<agent>-leads[-<date>].json" by agent, pick the newest by mtime.
  const byAgent = new Map();
  const re = /^([a-z0-9-]+)-leads(?:-(\d{4}-\d{2}-\d{2}))?\.json$/i;
  for (const f of files) {
    const m = f.match(re);
    if (!m) continue;
    const agent = m[1].toLowerCase();
    if (agent === selfName) continue;              // never overlay our own output
    if (agent === 'full-run') continue;            // safety (not -leads, but guard)
    const full = path.join(dir, f);
    let mtime = 0;
    try { mtime = fs.statSync(full).mtimeMs; } catch { continue; }
    const prev = byAgent.get(agent);
    if (!prev || mtime > prev.mtime) byAgent.set(agent, { file: full, mtime, name: f });
  }

  const records = [];
  for (const { file, name } of byAgent.values()) {
    let arr = null;
    try { arr = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { arr = null; }
    // Accept bare array or {leads|results|data|listings|matches} (orchestrator contract).
    const list = Array.isArray(arr) ? arr
      : (arr && (arr.leads || arr.results || arr.data || arr.listings || arr.matches)) || [];
    if (Array.isArray(list) && list.length) {
      log(`  overlaying ${list.length} records from ${name}`);
      for (const r of list) records.push(r);
    }
  }
  return records;
}

// Extract a usable {lat, lng} from a harvested record across the shapes the
// layers emit: geo:{lat,lng} (HCD/CEQA), top-level lat/lng, address:{lat,lng}
// (post-geocode-enrichment consolidated shape).
function coordsOf(rec) {
  if (rec && rec.geo && Number.isFinite(rec.geo.lat) && Number.isFinite(rec.geo.lng)) {
    return { lat: rec.geo.lat, lng: rec.geo.lng };
  }
  if (rec && Number.isFinite(rec.lat) && Number.isFinite(rec.lng)) {
    return { lat: rec.lat, lng: rec.lng };
  }
  if (rec && rec.address && typeof rec.address === 'object'
      && Number.isFinite(rec.address.lat) && Number.isFinite(rec.address.lng)) {
    return { lat: rec.address.lat, lng: rec.address.lng };
  }
  return null;
}

// ---------------------------------------------------------------------------
// PUBLIC: flagHarvestedRecords — the overlay PERCEIVE entrypoint.
// 1) load active-metro transit stops (cached),
// 2) read the other layers' harvested records,
// 3) for each geocoded record, compute nearest stop + SB 79 tier,
// 4) emit ONLY records within the largest tier, annotated with
//    legislative.sb79=true + sb79Tier + nearestStop (original fields preserved).
// Returns [] gracefully when stops or coordinates are unavailable.
// ---------------------------------------------------------------------------
async function flagHarvestedRecords({ config = config_, log = () => {}, days = 90 } = {}) {
  const tiers = config.distanceTiersMeters;
  const outer = tiers[tiers.length - 1];
  log(`SB 79 overlay (effective ${config.effectiveDate}); tiers=${tiers.join('/')}m; active metros=${config.activeMetros.join(', ')}`);

  // STEP 1 — transit stops.
  const stops = await loadStops(config, log);
  if (!stops.length) {
    log('WARNING: no transit stops available (GTFS unreachable/unparseable and no cache). ' +
        'Returning 0 records — see PHASE-0 VERIFY notes in overlay.js / config.js.');
    return [];
  }

  // STEP 2 — harvested records from the other layers.
  const harvested = findHarvestedRecords({ config, log, selfName: 'sb79' });
  if (!harvested.length) {
    log('WARNING: no harvested records found in data/output/*-leads-*.json yet ' +
        '(run the other layers first). Returning 0 records.');
    return [];
  }

  // STEP 3/4 — overlay.
  let withCoords = 0;
  const flagged = [];
  const tierCounts = { 1: 0, 2: 0, 3: 0 };
  for (const rec of harvested) {
    const c = coordsOf(rec);
    if (!c) continue;
    withCoords++;
    const hit = nearTransit(c.lat, c.lng, { config, stops, tiers });
    if (!hit.withinTier) continue; // outside the largest SB 79 tier → not flagged

    // Preserve the original record; annotate the SB 79 flag. legislative is
    // OR-merged by the consolidator, so we keep any existing flags and add sb79.
    const out = Object.assign({}, rec);
    out.legislative = Object.assign({}, rec.legislative || {}, { sb79: true });
    out.sb79Tier = hit.withinTier;              // 1 (<=400m) | 2 (<=800m) | 3 (<=1600m)
    out.nearestStop = { name: hit.stopName, meters: hit.meters, agency: hit.agency };
    out.sb79EffectiveDate = config.effectiveDate;
    // Provenance: keep the originating layer, but stamp our involvement too.
    out.sourceAgent = 'sb79';
    out.layer = 'L6';
    out.sb79SourceLayer = rec.layer || rec.sourceAgent || null; // which layer the parcel came from
    flagged.push(out);
    tierCounts[hit.withinTier]++;
  }

  if (!withCoords) {
    log('WARNING: harvested records carry NO coordinates yet (geocode enrichment ' +
        'has not run). Returning 0 records — re-run after enrich-geocode.');
    return [];
  }
  log(`overlay: ${withCoords}/${harvested.length} records geocoded; ` +
      `${flagged.length} within ${outer}m of a major transit stop ` +
      `(tier1=${tierCounts[1]} tier2=${tierCounts[2]} tier3=${tierCounts[3]}).`);
  return flagged;
}

module.exports = {
  flagHarvestedRecords,
  nearTransit,
  loadStops,
  // helpers exported for tests / Phase-0 verification / reuse:
  haversineMeters,
  tierForMeters,
  parseStopsTxt,
  parseCsvLine,
  readZipEntry,
  findHarvestedRecords,
  coordsOf,
  nearestStopIn,
  _resetStopsCache,
  cachePathFor,
};
