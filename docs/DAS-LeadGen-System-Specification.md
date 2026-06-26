# DAS-LeadGen — System Specification

**Internal repo / code name:** `das-leadgen` (a.k.a. "DAS-LeadGen")
**Client-facing product name:** **Danielian Pursuit Intelligence** (an "AI Pursuit Intelligence" engine)
**Client:** Danielian Associates — Irvine, CA (danielian.com)
**Prepared for:** Ravi Jain / Technijian engineering
**Status:** Specification v1.0 — ready to scaffold and build
**Date:** 2026-06-26

> **Naming discipline (important).** Inside the repo, "DAS" is fine. In **anything the client ever sees** (the weekly Brief, any UI, any document), use **"Danielian"** and **"Pursuit Intelligence"** — never the internal code "DAS" and never "lead generation." Danielian is an account-based (ABM) firm; the framing is *timing intelligence on named pursuits*, not cold lead-gen. This is a hard rule, not a preference.

---

## 1. Purpose & Scope

### 1.1 What this system does
DAS-LeadGen continuously monitors public records across Danielian's active markets (Orange County, Los Angeles, Nashville) to surface **residential development projects 3–12 months before the formal RFQ / design-team-selection moment**, enriches and scores each against Danielian's pursuit criteria, and delivers a **weekly Pursuit Intelligence Brief** to the BD team so they can activate a relationship *before* the project becomes a competitive bid.

It is a direct re-target of the proven **BBC Lead Gen engine** (`c:\vscode\bbc-leadgen\bbc-leadgen` — the "OC Luxury Home Builder" case study), swapping the signal layers, scoring rubric, and ICP from *luxury single-family resale/rebuild* to *multifamily / BTR / ADU / affordable / mixed-use development*.

### 1.2 The 4-stage engine
```
HARVEST  → scrape/poll 7 public-data signal layers across 3 metros
ENRICH   → resolve developer identity, property/deed data, contacts, Danielian relationship history
SCORE    → rank against Danielian's ICP (project type, stage, geography, scale, relationship)
DELIVER  → weekly Pursuit Intelligence Brief (Tier-1 list + account dossiers) to the BD team
```

### 1.3 In scope (pilot)
- Signal harvest, enrichment, scoring, and weekly Brief generation for **Orange County first**, then LA, then Nashville.
- Unattended weekly run via Windows Task Scheduler.
- MCP server for interactive querying by Claude.

### 1.4 Out of scope (pilot) / expansion
- Automated outbound email sequencing (ABM activation is human-led in the pilot; see §9.3).
- Two-way CRM sync (export only in pilot).
- Danielian's 6,353-project archive vector index — **stretch goal**, enables the relationship-flag layer (§8.4).

### 1.5 Business goal & success definition
Replace ~10–15 hrs/week of manual portal-watching with a curated Tier-1 pursuit feed, and measurably shorten **hours-to-first-contact** (the EOS Scorecard metric Danielian already frames this around). Pilot succeeds if it surfaces qualified pre-RFQ pursuits the BD team did not already know about, and at least one enters the pursuit pipeline.

---

## 2. Business Context (Danielian)

| Attribute | Detail | Why it matters to the build |
|---|---|---|
| Firm | Architecture + planning, Irvine; founded 1968; 3 offices OC / LA / Nashville | Defines the 3 target metros |
| Core product lines | Multifamily, Build-to-Rent (BTR), ADU, affordable, mixed-use, master-planning, some luxury SFR | Defines the **project-type fit** scoring |
| Scale | 6,353 projects · 1M+ units · 44 states | Archive = a relationship-intelligence asset (§8.4) |
| Operating system | EOS (Entrepreneurial Operating System) | Brief = a Scorecard metric; pilot = a Q3 Rock |
| "Why now" | SB 79 transit upzoning (eff. **2026-07-01**), SB 1211 (8 ADUs/lot), ADU streamlining | A dedicated **legislative-trigger** signal layer |
| Buyers | Developers + national builders (D.R. Horton, Lennar, Toll Bros, Tri Pointe, Taylor Morrison, Brookfield) + municipalities | Defines enrichment targets & dossiers |

### 2.1 Recipients (champion map)
| Name | Title | Role in the system |
|---|---|---|
| **Deborah Muro** | Director of Business Development | **Primary Brief recipient** — acts on the Tier-1 list |
| **Victor Alvarez-Duran** | Chief Technology Manager | Technical owner / implementation contact on Danielian side |
| **Jeff Schmehr** | CFO | ROI gate — wants hours-recovered + pursuit-conversion metrics |
| **John Danielian** | President | Warm sponsor (Ravi's Vistage peer); pilot sign-off |

---

## 3. System Architecture

### 3.1 Component diagram
```
                          ┌─────────────────────────────────────────────┐
                          │              ORCHESTRATOR                    │
                          │      scripts/run-all-layers.js               │
                          │  (preflight → harvest → dedup → enrich →     │
                          │   score → report → brief → email)            │
                          └───────────────┬─────────────────────────────┘
                                          │
        ┌──────────────┬──────────────┬───┴───────┬──────────────┬──────────────┬─────────────┐
        ▼              ▼              ▼           ▼              ▼              ▼             ▼
   L1 Permits     L2 Planning/   L3 CEQA/EIR  L4 Deeds/Land  L5 HCD/        L6 SB 79/    L7 Developer
   (per-metro     DRB agendas    (CEQAnet)    transfers      density-bonus  transit       /builder news
    Playwright)   (Granicus/                  (ATTOM txns)   (data.ca.gov)  triggers      (SerpAPI news)
                  Legistar/PDF)
        │              │              │           │              │              │             │
        └──────────────┴──────────────┴───────────┴──────────────┴──────────────┴─────────────┘
                                          │  raw signals (JSON per layer)
                                          ▼
                          ┌─────────────────────────────────────────────┐
                          │   CONSOLIDATE & DEDUP                        │
                          │   normalize address/APN → geocode → merge    │
                          └───────────────┬─────────────────────────────┘
                                          ▼
                          ┌─────────────────────────────────────────────┐
                          │   ENRICH  (ATTOM owner/deed · entity resolve │
                          │   · Hunter contacts · archive relationship)  │
                          └───────────────┬─────────────────────────────┘
                                          ▼
                          ┌─────────────────────────────────────────────┐
                          │   SCORE & TIER  (config/scoring.json)        │
                          └───────────────┬─────────────────────────────┘
                                          ▼
              ┌───────────────────────────┼───────────────────────────┐
              ▼                           ▼                           ▼
   data/output/*.{json,csv,xlsx}   Pursuit Intelligence Brief   MCP server
                                   (HTML email + dossiers)      (query tools)
```

### 3.2 Data flow (one weekly run)
1. **Preflight** — verify every portal reachable + every API key valid (reuse `scripts/preflight-check.js`).
2. **Harvest** — run all 7 layer agents in parallel; each writes `data/output/<layer>-YYYY-MM-DD.json`.
3. **Consolidate & dedup** — normalize address + APN, geocode, merge multi-source hits (a project seen in CEQA *and* a permit *and* a deed is one record with 3 source flags).
4. **Enrich** — ATTOM owner/deed, developer-entity resolution, Hunter contacts, archive relationship cross-ref.
5. **Score & tier** — apply `config/scoring.json`; assign Tier 1/2/3.
6. **Report** — write CSV + XLSX (full set) to `data/output/`.
7. **Brief** — generate the weekly HTML Brief (Tier-1 + dossiers) and email it (M365 Graph).
8. **Log** — per-run folder under `runs/` with screenshots, stats, and a `run-index.json` entry.

---

## 4. Signal Layers / Data Sources

This is the heart of the re-target. Each layer below names the **real source**, the **access method**, and the **build status** relative to BBC.

> Legend — **♻ Reuse:** BBC code runs as-is or with config only. **🔧 Adapt:** BBC pattern exists, retarget needed. **🆕 New:** net-new agent. **⚠ Hard:** technically involved / partly manual at MVP.

### 4.1 Layer summary

| # | Layer | Real source(s) | Access method | Lead time before RFQ | Status |
|---|---|---|---|---|---|
| L1 | **Building permits** | City permit portals: Tyler EnerGov, eTRAKiT, Accela; **LA: data.lacity.org (Socrata API)**; **Nashville: data.nashville.gov (Socrata API)** | Playwright per-jurisdiction + Socrata REST where available | 0–3 mo (architect often already chosen — lowest, but confirms activity) | 🔧 Adapt (OC ♻) |
| L2 | **Planning commission / Design Review agendas** | Granicus, Legistar, PrimeGov, CivicClerk (per city) | Playwright + `pdf-parse` on agenda PDFs | 3–9 mo (entitlement → design-team selection) | 🔧 Adapt (BBC `agents/drb`) |
| L3 | **CEQA / EIR environmental filings** | **CEQAnet** (ceqanet.opr.ca.gov — statewide State Clearinghouse) | Public search/API harvest (one central source) | 12–18 mo (earliest strong signal) | 🆕 New (CA only) |
| L4 | **Land transfers / deeds** (developer just bought a site) | **ATTOM transactions/AVM API** (preferred); fallback OC RecorderWorks / LA Registrar-Recorder | API (ATTOM key already in BBC) | 6–12 mo (site acquired → architect selection imminent) | 🔧 Adapt (BBC ATTOM + `agents/clerk-recorder`) |
| L5 | **CA HCD / density-bonus / streamlining** | data.ca.gov HCD datasets (APR, RHNA), builder's-remedy & SB 35/423 tracking | API + curated news | 6–18 mo (directly in Danielian's lines) | 🆕 New ⚠ |
| L6 | **SB 79 / transit-corridor / ADU-batch triggers** | Transit GTFS stops (OCTA, LA Metro, WeGo) × parcel/zoning GIS; local rezoning ordinances | GIS overlay + ordinance scrape | Predictive (new project *types*) | 🆕 New ⚠ (approximate at MVP) |
| L7 | **Developer & national-builder news** | **SerpAPI google_news** (reuse tech-leads `news_fetch.py`), builder newsrooms, LinkedIn, BuildZoom/Construction Monitor | API + light scrape | Variable | ♻ Reuse (tech-leads) |

### 4.2 Per-layer detail

**L1 — Building permits.**
- DAS-relevant permit types differ from BBC: filter for **new multifamily, mixed-use, apartment, condo, townhome, ADU-batch, hotel/residential, and large additions** — *not* single-family rebuilds (BBC's target). Permit-type/keyword filters live in `config/das-icp.json`.
- OC jurisdictions already built in BBC and directly reusable: Irvine (DAS HQ city), Newport Beach, Costa Mesa, Huntington Beach, Laguna Niguel, San Juan Capistrano, San Clemente, Dana Point, County of Orange. Add high-multifamily OC cities: **Santa Ana, Anaheim, Orange, Tustin, Garden Grove**.
- LA: City of LA building permits are published on **data.lacity.org via Socrata** (`/resource/...json` REST, app-token) — prefer the API over scraping LADBS. LA County unincorporated = EPIC-LA (Accela).
- Nashville: **data.nashville.gov Socrata** publishes building permits (clean API). Confirm dataset id during Phase 0.
- Per-jurisdiction portal vendor **must be verified in Phase 0** (vendors change); BBC's `agents/<city>/config.js` already encodes the OC truth.

**L2 — Planning / Design Review agendas.** Reuse BBC's `agents/drb/` multi-platform scraper (Granicus / Legistar / city CMS). Parse agenda PDFs with `pdf-parse` for project address, applicant, scope, and hearing date. This is the **entitlement signal** — a project on a planning-commission agenda is selecting its design team within 90–180 days.

**L3 — CEQA / EIR (CEQAnet).** Single statewide source — high ROI, low fragmentation. Harvest Notices of Preparation (NOP), Notices of Determination (NOD), and EIR filings; filter to residential/mixed-use ≥ a unit threshold. NOP is the **earliest** signal (12–18 mo). **CA only** — Nashville has no CEQA equivalent (federal NEPA only, low relevance for residential).

**L4 — Land transfers / deeds.** A developer recording a grant deed on a developable parcel is a strong pre-design signal. Use **ATTOM's transaction/deed endpoints** (the ATTOM key already exists in BBC) rather than scraping recorder portals where possible — cleaner, multi-county. Flag transactions where grantee is an LLC/developer entity and parcel is zoned/sized for multifamily.

**L5 — HCD / density-bonus / streamlining.** Pull HCD Annual Progress Report (APR) and RHNA datasets from data.ca.gov; track **builder's-remedy** and **SB 35 / SB 423** streamlining applications (these are exactly Danielian's affordable/density lines). Partly news-augmented at MVP — flag as ⚠.

**L6 — SB 79 / transit triggers.** SB 79 upzones parcels near major transit stops (eff. 2026-07-01). MVP approximation: overlay transit GTFS stop locations (OCTA / LA Metro / Nashville WeGo) against harvested permit/CEQA records and **flag** those within SB 79 distance tiers, rather than independently scanning all parcels. Full parcel-level scanning is a Phase-4 enhancement.

**L7 — Developer / builder news.** Reuse tech-leads' `news_fetch.py` pattern (SerpAPI `google_news`) against a curated query list (the 6 national builders + Danielian's known repeat developers). National builders announce communities months before architect selection.

### 4.3 Source reference (Appendix B has full URLs)
All source endpoints, portal vendors, and dataset IDs are catalogued in `config/signal-sources.json` (template in Appendix B) so a developer can add/disable a source without touching code.

---

## 5. Data Model

All records are JSON; persisted per-layer and consolidated. Schemas (informal):

### 5.1 PursuitRecord (the core entity)
```jsonc
{
  "id": "sha1(normalizedAddress + apn)",        // stable dedup key
  "address": "1200 Main St, Santa Ana, CA 92701",
  "normalizedAddress": "1200 main st santa ana ca 92701",
  "apn": "405-123-45",
  "geo": { "lat": 33.74, "lng": -117.86 },
  "metro": "OC | LA | NASHVILLE",
  "jurisdiction": "Santa Ana",
  "projectType": "multifamily | btr | adu-batch | affordable | mixed-use | sfr | master-plan | unknown",
  "unitCount": 84,                               // null if unknown
  "stage": "land-acquired | ceqa-nop | entitlement | permit-filed | unknown",
  "scopeText": "84-unit apartment community with ground-floor retail",
  "sources": [                                   // every layer that surfaced it
    { "layer": "L3-ceqa", "ref": "SCH#2026010123", "date": "2026-06-10", "url": "..." },
    { "layer": "L4-deed", "ref": "DOC 2026-000456", "date": "2026-05-02", "url": "..." }
  ],
  "developer": {                                 // see 5.3
    "rawName": "MAIN ST HOLDINGS LLC",
    "resolvedEntity": "Greystar / Main Street Holdings",
    "isLLC": true
  },
  "contacts": [ /* see 5.2 */ ],
  "relationship": {                              // from archive cross-ref (§8.4)
    "knownDeveloper": true,
    "lastProjectYear": 2019,
    "note": "Danielian designed Vista Apartments for this developer in 2019"
  },
  "legislative": { "sb79": true, "densityBonus": false, "builderRemedy": false },
  "score": 14,
  "tier": 1,
  "scoreBreakdown": { /* see §7 */ },
  "firstSeen": "2026-06-26",
  "lastSeen": "2026-06-26"
}
```

### 5.2 Contact (reuse BBC `agents/shared/contacts.js` schema)
```jsonc
{ "role": "developer-exec | land-acquisition | applicant | owner | gc",
  "name": "Jane Doe", "firm": "Greystar", "title": "VP Development",
  "phone": "...", "email": "...", "source": "hunter | attom | portal | news" }
```

### 5.3 AccountDossier (generated for each Tier-1 developer in the Brief)
```jsonc
{ "developer": "Greystar",
  "activePursuitsSurfaced": 3,
  "background": "national multifamily developer/operator ...",
  "priorDanielianWork": [ { "project": "Vista Apartments", "year": 2019 } ],
  "decisionMakers": [ /* contacts */ ],
  "suggestedTrigger": "Recorded deed on a 2.1-ac Santa Ana transit parcel (SB 79 corridor) on 5/2 — pre-design window open now" }
```

### 5.4 Persisted caches (idempotency)
`data/output/attom-cache.json`, `geocode-cache.json`, `archive-index/` — keyed lookups so re-runs don't re-pay API calls (BBC pattern).

---

## 6. Scoring Engine

Config-driven (`config/scoring.json`) so it can be tuned during the pilot without code changes. This is an **initial rubric — calibrate with Deborah in Week 3.**

### 6.1 Point rubric (initial)
| Signal | Points | Notes |
|---|---:|---|
| Project type = multifamily / BTR / master-plan | +5 | Danielian core |
| Project type = mixed-use / affordable | +4 | Core |
| Project type = ADU-batch (≥4 units) | +3 | SB 1211 line |
| Project type = luxury SFR / custom | +1 | Lower volume for DAS |
| Stage = land-acquired or CEQA-NOP | +4 | Earliest, highest value |
| Stage = entitlement / planning agenda | +3 | Design-team selection window |
| Stage = permit-filed | +1 | Architect likely already chosen |
| Scale ≥ 200 units | +4 | Major design engagement |
| Scale 50–199 units | +3 | |
| Scale 10–49 units | +1 | |
| Geography = active DAS metro (OC/LA/Nashville) | +2 | |
| **Relationship: known repeat developer** | +5 | Strongest activation signal (archive) |
| Known municipality relationship | +1 | |
| Legislative tailwind (SB 79 corridor / density-bonus / builder's-remedy) | +2 | "Why now" |
| Multi-source (seen in ≥2 layers) | +2 | Corroborated intent |
| **Negative:** architect-of-record already named | −3 | Too late |
| **Negative:** outside target geography | −2 | |
| **Negative:** non-residential (pure industrial/retail) | −3 | Out of ICP |

### 6.2 Tiers
- **Tier 1 (act now):** score ≥ 12 → goes in the Brief with a full dossier.
- **Tier 2 (watch):** 7–11 → Brief appendix / watchlist.
- **Tier 3 (monitor):** 3–6 → CSV only.
- **Drop:** < 3.

### 6.3 Implementation
Adapt BBC's `scripts/score-and-report.js` + `score-and-report-lib.js`. Replace the luxury-SFR rubric with the table above; replace BBC's `agents/shared/client-fit.js` (`isBurkhartFit`) with `isDanielianFit` (residential development, in target metros, not yet at permit-with-AOR stage).

---

## 7. Enrichment Pipeline

| Step | Source | Reuse | Output |
|---|---|---|---|
| Address normalize + geocode | Google Geocoding API | ♻ `scripts/enrich-geocode.js` | dedup key, lat/lng |
| Property + owner + deed | ATTOM API | ♻ `scripts/enrich-leads-attom.js` | owner, assessed value, last sale, parcel size, zoning |
| **Developer entity resolution** | CA SOS bizfile / OpenCorporates (LLC → principal) | 🆕 new module | resolved developer behind an LLC grantee |
| Decision-maker contacts | **Hunter.io** (domain → verified emails) | ♻ tech-leads `prequalify_leads.py` pattern | dev-side BD/land-acq contacts |
| Skip-trace fallback | BatchData / Spokeo | ♻ `scripts/skip-trace-leads.js`, `enrich-spokeo.js` | phone/email when Hunter is empty |
| **Relationship cross-ref** | Danielian archive index (§8.4) | 🆕 stretch | "known developer" flag + last project |

> Developer-entity resolution (LLC → real developer) is the one genuinely new enrichment problem vs. BBC (BBC enriched individual homeowners; DAS enriches development entities). Budget time for it.

---

## 8. Delivery — Pursuit Intelligence Brief

### 8.1 The deliverable
A **weekly HTML email** (rendered, on-brand "Danielian Pursuit Intelligence") to Deborah Muro + Victor, containing:
1. **Executive line** — "N new Tier-1 pursuits this week" + the EOS Scorecard metric (hours-to-first-contact trend).
2. **Tier-1 pursuit cards** — address, project type, unit count, stage, score, the surfacing sources, and a one-line *suggested trigger* (the activation hook).
3. **Account dossiers** — for each Tier-1 developer (§5.3).
4. **Relationship & legislative triggers** — "You worked with X in 2019; they just acquired Y" / "SB 79 created Z eligible parcels in your corridor."
5. **Attachments** — full XLSX (all tiers) + per-pursuit detail.

### 8.2 Channels
- **Email:** M365 Graph — reuse `scripts/email-tier1-leads.ps1` (already authenticates as RJain@technijian.com via the Technijian app registration). Retarget recipient + template.
- **Files:** `data/output/full-run-YYYY-MM-DD.{json,csv,xlsx}` + `brief-YYYY-MM-DD.html`.
- **MCP:** `mcp-server/index.js` exposes `get-tier1`, `run-pipeline`, `get-dossier`, `search-pursuits` for interactive use in Claude.

### 8.3 Brief generator
New `scripts/build-brief.js` — consumes the scored `full-run` JSON, renders the HTML Brief (model the visual on the AI Growth Report's airy style; authentic Danielian-appropriate Technijian branding). Reuse BBC's `build-full-report.js` for the XLSX.

### 8.4 Relationship layer (stretch — the differentiator)
Index Danielian's 6,353-project archive (developer name, project, year, location) into a vector/keyword store (Weaviate or a local SQLite FTS to start). At enrichment, match each surfaced developer/parcel against it to produce the **"you already know this buyer"** flag — the single most powerful activation trigger for an ABM firm. Requires the archive export from Danielian (Phase-0 discovery item).

---

## 9. The "Convert into Wins" Layer (ABM activation)

> **Clarification:** for Danielian, a "lead that converts into a client" = a surfaced **pursuit that becomes a won project**. The system finds the pursuit; the *win* comes from a relationship activated early. The conversion motion is **account-based and human-led**, never a cold blast.

### 9.1 Pilot (human-led)
The Brief hands Deborah a ranked, dossiered list. She activates relationships (call, intro, event) using the suggested triggers. The system tracks **hours-to-first-contact** and **pursuit-entered** outcomes back into the record for the EOS Scorecard.

### 9.2 Loop-closing
A lightweight `outcomes.json` (or a column Deborah edits in the XLSX) feeds back: contacted? / pursuit entered? / won? — so the pilot can be measured against baseline at Week 12.

### 9.3 Expansion (post-pilot, optional)
The tech-leads activation stack (`prep_next_touches.py` + Hunter verification + M365 send + 3-pass `proofread.py`) can draft **warm, account-specific** outreach for Deborah's approval — same machinery that runs Technijian's own pipeline, voice-profiled to Danielian. **Gated behind explicit opt-in and always human-approved** (ABM discipline).

---

## 10. Automation & Scheduling

- **Cadence:** weekly, **Monday 06:00 PT** (Brief lands at the start of Deborah's week). Configurable.
- **Mechanism:** Windows Task Scheduler — reuse `scripts/setup-weekly-schedule.ps1`. Steps: `preflight → pipeline → report → brief → email`.
- **Self-healing:** reuse BBC's `pipeline-selfheal.js` (retries failed jurisdictions) and `pipeline-learn.js` (records portal changes).
- **Logging:** per-run folder `runs/YYYY-MM-DD_HH-MM/` with per-agent logs, error screenshots, and a `runs/run-index.json` entry. Reuse BBC `scripts/run-tracker.js`.
- **Runtime budget:** target < 45 min/run for OC; scales with metros.

---

## 11. Technology Stack

| Concern | Choice | Rationale |
|---|---|---|
| Language/runtime | **Node.js 20 LTS** (CommonJS) | Maximize direct reuse of BBC's proven agents/scripts |
| Browser automation | **patchright** 1.59 (primary) + playwright 1.58 + playwright-extra/stealth (fallback) | Anti-bot; identical to BBC |
| PDF parsing | **pdf-parse** | Planning-agenda PDFs (L2) |
| Spreadsheet/doc | **xlsx**, **docx** | Reports + Brief attachments |
| Config/env | **dotenv** | Vault-first loader (`agents/shared/load-env.js`) |
| LLM (optional) | LiteLLM gateway / Claude | Agenda-scope extraction, entity resolution, news summarization |
| Vector store (stretch) | Weaviate or SQLite FTS | Archive relationship index (§8.4) |
| Email | PowerShell + Microsoft Graph | Reuse BBC email script |
| MCP | @modelcontextprotocol/sdk | Interactive querying |
| Scheduler | Windows Task Scheduler | Reuse BBC PS1 |

Python is acceptable for isolated pieces (Socrata pulls, archive indexing) but the **orchestrator and scrapers stay Node** to inherit BBC directly.

---

## 12. Repository Structure

```
das-leadgen/
├─ README.md
├─ SPEC.md                         # this document
├─ package.json
├─ .env                            # gitignored; real values in OneDrive keys vault
├─ .gitignore
├─ .mcp.json
├─ agents/
│  ├─ permits/
│  │  ├─ oc/<jurisdiction>/        # reuse/adapt BBC per-city agents (Irvine, Santa Ana, …)
│  │  ├─ la/                       # Socrata (data.lacity.org) + EPIC-LA
│  │  └─ nashville/                # Socrata (data.nashville.gov)
│  ├─ planning-drb/                # adapt BBC agents/drb (Granicus/Legistar/PDF)
│  ├─ ceqa/                        # NEW — CEQAnet harvester
│  ├─ deeds/                       # adapt BBC ATTOM txns + agents/clerk-recorder
│  ├─ hcd/                         # NEW — data.ca.gov HCD + builder's-remedy
│  ├─ sb79/                        # NEW — transit GTFS × parcel overlay
│  ├─ developer-news/              # reuse tech-leads news_fetch pattern (SerpAPI)
│  └─ shared/                      # browser.js, load-env.js, contacts.js, dedup.js,
│                                   #  geocode.js, danielian-fit.js, scoring.js
├─ scripts/
│  ├─ preflight-check.js           # ♻ BBC
│  ├─ run-all-layers.js            # ♻ BBC orchestrator (retarget layer list)
│  ├─ enrich-all-leads.js          # ♻ BBC (ATTOM/geocode/skip-trace)
│  ├─ resolve-developer-entity.js  # NEW (LLC → developer)
│  ├─ score-and-report.js          # ♻ BBC (swap rubric)
│  ├─ build-full-report.js         # ♻ BBC (XLSX/CSV)
│  ├─ build-brief.js               # NEW (weekly Pursuit Intelligence Brief HTML)
│  ├─ email-brief.ps1              # ♻ BBC email-tier1-leads.ps1 (retarget)
│  ├─ pipeline-selfheal.js         # ♻ BBC
│  ├─ run-tracker.js               # ♻ BBC
│  └─ setup-weekly-schedule.ps1    # ♻ BBC
├─ config/
│  ├─ jurisdictions.json           # metro → city → portal vendor → URL → creds-key
│  ├─ signal-sources.json          # all source endpoints/dataset-ids (Appendix B)
│  ├─ das-icp.json                 # project-type keywords, unit thresholds, geographies
│  └─ scoring.json                 # the §6 rubric (tunable)
├─ data/
│  ├─ output/                      # run artifacts + caches (gitignored)
│  └─ archive-index/               # Danielian 6,353-project index (stretch)
├─ mcp-server/
│  └─ index.js                     # ♻ BBC pattern
├─ runs/                           # per-run logs/screenshots (gitignored)
└─ docs/
   ├─ workstation.md               # setup guide (model on BBC docs/workstation.md)
   └─ phase-0-discovery.md         # §18 items to confirm with Danielian
```

---

## 13. Configuration & Secrets

### 13.1 Secrets — never in repo
All credentials load at runtime from the OneDrive keys vault (BBC pattern, `agents/shared/load-env.js`):
`C:\Users\rjain\OneDrive - Technijian, Inc\Documents\VSCODE\keys\das-leadgen.env`

| Key | Used for | Notes |
|---|---|---|
| `ATTOM_API_KEY` | Property/owner/deed (L4, enrich) | Reuse BBC key; watch trial quota |
| `GOOGLE_GEOCODING_API_KEY` | Dedup/geocode | Reuse |
| `SERPAPI_KEY` | Developer news (L7) | From tech-leads |
| `HUNTER_API_KEY` | Contact discovery | From tech-leads |
| `LA_SOCRATA_APP_TOKEN` | data.lacity.org | Free app token |
| `NASHVILLE_SOCRATA_APP_TOKEN` | data.nashville.gov | Free app token |
| `BATCHDATA_API_KEY` / `SPOKEO_*` | Skip-trace fallback | Optional |
| `GRAPH_CLIENT_ID` / `GRAPH_TENANT_ID` / `GRAPH_CLIENT_SECRET` | M365 email | Reuse Technijian app reg |
| Per-portal logins (e.g. `ETRAKIT_*`) | Authenticated permit portals | Only where required |

### 13.2 `config/jurisdictions.json` (shape)
```jsonc
{ "OC": [
    { "city": "Irvine", "vendor": "accela|energov|custom", "permitUrl": "...",
      "planningVendor": "granicus", "planningUrl": "...", "credsKey": null },
    { "city": "Santa Ana", "vendor": "...", "permitUrl": "...", "...": "..." }
  ],
  "LA": [ { "city": "Los Angeles", "vendor": "socrata",
            "dataset": "yv23-pmwf", "permitUrl": "https://data.lacity.org/resource/..." } ],
  "NASHVILLE": [ { "city": "Nashville-Davidson", "vendor": "socrata", "dataset": "...", "...": "..." } ] }
```

---

## 14. Non-Functional Requirements

- **Idempotent & incremental:** stable `id` (address+APN) dedup; persistent ATTOM/geocode caches; `firstSeen`/`lastSeen` so the Brief can show only *new* pursuits week-over-week.
- **Anti-bot / polite:** patchright; randomized delays; per-portal concurrency caps; respect robots/ToS (see §15).
- **Resfilient harvest:** one jurisdiction failing must not abort the run (BBC self-heal pattern); failures logged with screenshots, retried next run.
- **Observability:** per-run stats (records/layer, dedup ratio, enrichment yield %, tier counts) written to `runs/` and surfaced in the Brief footer.
- **Config over code:** adding a city or source = editing JSON, not writing an agent (except genuinely new portal vendors).
- **Determinism:** a re-run on the same day produces the same scored set (no randomness in scoring).

---

## 15. Security, Legal & Ethical

- **Public records only.** All sources are public government/portal data or licensed data APIs (ATTOM, Hunter, SerpAPI under their ToS). No authentication bypass; where a portal requires a login, use a legitimately provisioned account.
- **Respect ToS / rate limits.** Prefer official APIs (Socrata, CEQAnet, ATTOM) over scraping where they exist. Throttle scrapers.
- **PII:** contacts are *business* development contacts; store only what's needed for the Brief; no consumer-credit or restricted data.
- **ABM discipline (product-level):** the system surfaces intelligence for **named-account, warm activation**. It must not be wired into cold mass-email. Any activation (§9.3) is human-approved and account-specific. This is both a brand rule and a Danielian-relationship rule.
- **Secrets:** vault-only, never committed (GitHub push protection will block hardcoded secrets anyway).

---

## 16. Build Roadmap (mapped to the 90-day pilot)

> Commercial frame (from the proposal, published pricing — do not invent): My AI Lead Gen **Professional $3,499/mo → ~$10,500 for the 90-day pilot** + one-time config scoped at quote. Only the pilot is committed scope.

| Phase | Window | Deliverable | Layers / work |
|---|---|---|---|
| **0 — Discovery** | Pre-build (Week 0) | Confirmed config + seed list | §18 items: geography priority, crown-jewel developers, CRM, baseline metrics, archive export |
| **1 — MVP harvest** | Weeks 1–2 | First scored Tier-1 list (OC) | L1 (OC permits ♻), L2 (planning ♻), L3 (CEQAnet 🆕), L4 (ATTOM deeds ♻); `danielian-fit` + scoring; XLSX out |
| **2 — First Brief** | Week 3 | Weekly Pursuit Intelligence Brief delivered; thresholds calibrated with Deborah | `build-brief.js`, email, dossiers |
| **3 — Full signal set + scale** | Weeks 4–8 | L5 (HCD), L6 (SB 79 approx), L7 (news); extend to **LA**; relationship index (archive) | Scheduler live; conversion loop tracked |
| **4 — Expansion** | Weeks 9–12 + | Nashville; activation assist (§9.3); dashboard; CRM export | Post-pilot review vs baseline |

### 16.1 MVP definition (what "done" means for Phase 1)
A single `npm run pipeline` over OC produces a deduped, enriched, scored `full-run` with a non-trivial Tier-1 set, written to XLSX — proving the engine on Danielian's signals. (BBC's day-one comparable: 24 enriched Tier-1 leads in a 75-min run.)

### 16.2 Suggested first commits
1. `npm init` + copy BBC `package.json` deps + `agents/shared/{browser,load-env,contacts}.js`.
2. `config/jurisdictions.json` with OC cities (port from BBC `agents/<city>/config.js`).
3. Port one OC permit agent end-to-end (Irvine) → prove harvest.
4. `agents/ceqa/` against CEQAnet → prove the new layer.
5. `danielian-fit.js` + `scoring.json` + adapt `score-and-report.js`.
6. `build-brief.js` skeleton → first HTML Brief.

---

## 17. Success Metrics & Acceptance Criteria

| Metric | Target (pilot) |
|---|---|
| Weekly run completes unattended | Yes, by Week 4 |
| New Tier-1 pursuits surfaced / week (OC) | ≥ 5 (calibrate) |
| Pursuits the BD team did *not* already know | > 0 (the core proof) |
| Enrichment yield (owner/contact) | ≥ 60% of Tier-1 |
| Hours-to-first-contact | Trending down vs Week-1 baseline |
| Pursuits entered into pipeline from the Brief | ≥ 1 by Week 12 |
| Manual portal-watching hours replaced | ~10–15 hrs/wk |

---

## 18. Open Discovery Items (confirm with Danielian — Phase 0)

These come straight from the DAS engagement notes and **should be confirmed before/at kickoff** (put them in `docs/phase-0-discovery.md`):
1. **Geography priority** — OC only first, or OC+LA+Nashville from day one? (Spec assumes OC-first.)
2. **Crown-jewel repeat developers** — the seed list for the relationship layer + news queries.
3. **Pursuit baseline** — current pursuit volume, win rate, hours-to-proposal (the ROI anchors).
4. **CRM / pursuit-tracking stack** — for the export/loop-close target.
5. **Archive export** — can Danielian provide the 6,353-project list (developer/project/year/location) for the relationship index?
6. **Project-type weighting** — confirm the §6 rubric reflects how Deborah actually prioritizes (multifamily vs mixed-use vs affordable vs BTR).
7. **Any AI Victor is already piloting** — avoid collision / integrate.
8. **EOS Rock timing** — align the pilot to the Q3 2026 Rock cycle.

---

## Appendix A — BBC → DAS Reuse Map (file-level)

| DAS component | BBC source to start from | Action |
|---|---|---|
| Browser factory | `agents/shared/browser.js` | Reuse as-is |
| Env/vault loader | `agents/shared/load-env.js` | Reuse, point to `das-leadgen.env` |
| Contact schema + hydration | `agents/shared/contacts.js`, `tyler-contacts.js`, `etrakit-contacts.js`, `llm-contacts.js` | Reuse |
| Fit filter | `agents/shared/client-fit.js` (`isBurkhartFit`) | Fork → `danielian-fit.js` |
| Orchestrator | `scripts/run-all-layers.js` | Reuse, swap layer registry |
| Permit agents (OC) | `agents/{irvine,costa-mesa,newport-beach,…}` | Reuse, retarget permit-type filters |
| Planning/DRB | `agents/drb/` | Reuse (this is L2) |
| Deeds/financial | `agents/clerk-recorder/`, `agents/financial/` | Adapt for developer deeds (L4) |
| Scoring | `scripts/score-and-report.js` + `score-and-report-lib.js` | Reuse, swap rubric |
| Enrichment | `scripts/enrich-leads-attom.js`, `enrich-geocode.js`, `enrich-all-leads.js`, `skip-trace-leads.js`, `enrich-spokeo.js` | Reuse |
| Report (XLSX/CSV) | `scripts/build-full-report.js`, `csv-to-excel.js` | Reuse |
| Email | `scripts/email-tier1-leads.ps1` | Reuse, retarget recipient/template |
| Scheduler | `scripts/setup-weekly-schedule.ps1` | Reuse |
| Self-heal / learn / tracker | `scripts/pipeline-selfheal.js`, `pipeline-learn.js`, `run-tracker.js` | Reuse |
| Preflight | `scripts/preflight-check.js`, `preflight-smoke.js` | Reuse |
| MCP server | `mcp-server/index.js` | Reuse, retarget tools |
| News (L7) | tech-leads `scripts/news_fetch.py` | Port pattern |
| Activation (expansion) | tech-leads `prep_next_touches.py`, `proofread.py`, Hunter verify | Port (gated) |

## Appendix B — `config/signal-sources.json` (starter template)
```jsonc
{
  "L3_ceqa":     { "type": "api",    "base": "https://ceqanet.opr.ca.gov", "filters": ["residential","mixed-use"], "minUnits": 10 },
  "L1_la":       { "type": "socrata","base": "https://data.lacity.org/resource", "dataset": "<verify>", "tokenKey": "LA_SOCRATA_APP_TOKEN" },
  "L1_nashville":{ "type": "socrata","base": "https://data.nashville.gov/resource", "dataset": "<verify>", "tokenKey": "NASHVILLE_SOCRATA_APP_TOKEN" },
  "L4_deeds":    { "type": "attom",  "endpoint": "transactions", "granteeIsLLC": true },
  "L5_hcd":      { "type": "api",    "base": "https://data.ca.gov", "datasets": ["apr","rhna"] },
  "L7_news":     { "type": "serpapi","engine": "google_news", "queries": ["<national builders>","<repeat developers>"] }
  /* L1_oc / L2_planning vendors per-city live in jurisdictions.json (ported from BBC) */
}
```

---
*End of specification v1.0. Verify all per-jurisdiction portal vendors and Socrata dataset IDs during Phase 0 — they drift, and BBC's agents already encode the current OC truth.*
