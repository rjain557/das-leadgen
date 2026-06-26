# Phase 0 — Discovery & Pre-Launch Checklist

Confirm these before/at kickoff (spec §18) and as the scaffold goes live. Two
buckets: **client discovery** (ask Danielian) and **technical verification**
(confirm live — most already done in the build, flagged below).

## A. Client discovery (confirm with Danielian)
1. **Geography priority** — OC only first, or OC+LA+Nashville from day one? (Spec/scaffold assume OC-first; `config/das-icp.json → activeMetros: ["OC"]`. Flip metros' `active` flag + add to `activeMetros` to expand.)
2. **Crown-jewel repeat developers** — the seed list for the relationship layer + news queries. Put them in `config/signal-sources.json → layers.L7_news.repeatDevelopers` (currently the `__SEED_FROM_PHASE_0__` placeholder).
3. **Pursuit baseline** — current pursuit volume, win rate, hours-to-proposal (the ROI anchors for the Brief's exec line).
4. **CRM / pursuit-tracking stack** — the export/loop-close target (`outcomes.json` or an XLSX column Deborah edits).
5. **Archive export** — can Danielian provide the 6,353-project list (developer / project / year / location)? Drop it at `data/archive-index/developers.json` to light up the "you already know this buyer" relationship flag (`resolve-developer-entity.js`, the strongest activation signal, scored +5).
6. **Project-type weighting** — confirm the `config/scoring.json` rubric reflects how Deborah actually prioritizes (multifamily vs mixed-use vs affordable vs BTR). Calibrate Week 3.
7. **Any AI Victor is already piloting** — avoid collision / integrate.
8. **EOS Rock timing** — align the pilot to the Q3 2026 Rock cycle.
9. **Brief recipients** — confirm Deborah Muro's + Victor Alvarez-Duran's email addresses; set them in `email-brief.ps1` (`-Recipient`/`-Cc`). Until then it defaults to the internal sender and dry-run.

## B. Technical verification (source/key status from this build)

### Keys — already in the vault (reusable day one)
ATTOM · Google Geocoding · BatchData/BatchLeads · Spokeo · Hunter · SerpAPI · M365 Graph · LiteLLM. ✅

### Keys — to add to `…/VSCODE/keys/das-leadgen.env`
- `SERPAPI_KEY` — exists in the vault (serpapi.md / tech-leads) but must be copied into `das-leadgen.env` so `loadEnv()` exposes it (gates L7 developer-news).
- `HUNTER_API_KEY` — same (gates developer-side contact discovery).
- `GRAPH_CLIENT_ID` / `GRAPH_TENANT_ID` / `GRAPH_CLIENT_SECRET` — reuse the HiringPipeline-Automation app reg (gates the weekly email).
- `LA_SOCRATA_APP_TOKEN`, `NASHVILLE_SOCRATA_APP_TOKEN` — **optional** (free; raise rate limits). Harvest works without them.
- `OPENCORPORATES_API_KEY` — **optional** (LLC→developer resolution works on the free tier without it).

### Sources — verified live during the build
- **L1 LA permits** ✅ `data.lacity.org` dataset `pi9x-tg5x` (LADBS Building Permits) returns current data (latest issue 2026-06-21). Columns confirmed (primary_address, apn, permit_type, use_desc, issue_date, valuation, work_desc).
- **L3 CEQA** ✅ `ceqanet.opr.ca.gov/Search?DocumentType=…&County=…&StartRange=…&EndRange=…` (HTML; no JSON API; `?OutputFormat=CSV` exists). Test pull: 405 raw → 19 Danielian-fit.
- **L5 HCD** ✅ data.ca.gov CKAN APR Table A2 ("Housing Development Applications Submitted"), resource resolved live by name each run. Real density-bonus projects surfaced.
- **L6 SB 79** ✅ OCTA GTFS feed downloaded + parsed (5,247 stops); overlay-and-flag within 400/800/1600m tiers working.

### Sources — needs Phase-0 confirmation (flagged `PHASE-0 VERIFY` in code)
- **L1 Nashville permits** ⚠ `data.nashville.gov` migrated to ArcGIS Hub — the old `/resource/<id>.json` is dead. A BLDS partner feed (`permits.partner.socrata.com/resource/7ky7-xbzp.json`) works but observed data was stale (2016). Find a fresher live SODA/ArcGIS endpoint and update `config/jurisdictions.json`.
- **OC permit cities** — only Irvine is ported (and its permit-type filter still targets luxury SFR — retarget to multifamily). Port the other proven BBC OC agents (Newport Beach, Costa Mesa, Huntington Beach, etc.) and confirm Santa Ana / Anaheim / Orange / Tustin / Garden Grove vendors (high-multifamily cities — `verified:false` in jurisdictions.json).
- **CEQA detail enrichment** — list view has no street/APN; fetch the project detail page to populate them (Phase-4).
- **HCD column names** — APR schema revises ~yearly; the resolver tolerates variants but re-confirm column names.
- **SB 79 major-stop filter** — OCTA is bus-only today; tighten to rail/BRT route types when a major-transit feed exists.
- **preflight-check.js** — still carries BBC city/portal tables; retarget for das sources (non-blocking — orchestrator runs it non-fatally; use `--skip-preflight` for clean runs).

## C. MVP "done" (Phase 1)
A single `npm run pipeline` over OC produces a deduped, enriched, scored
`full-run` with a non-trivial Tier-1 set written to JSON/XLSX, and `npm run brief`
renders the weekly Pursuit Intelligence Brief. (BBC day-one comparable: 24
enriched Tier-1 leads in a 75-min run.)
