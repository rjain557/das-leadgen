# das-leadgen — Danielian Pursuit Intelligence

> Internal code: `das-leadgen`. Client-facing: **Danielian Pursuit Intelligence**.
> An AI pursuit-intelligence engine that surfaces residential development projects
> **3–12 months before the RFQ / design-team-selection moment**, scores them against
> Danielian's pursuit criteria, and delivers a **weekly Pursuit Intelligence Brief**
> to the BD team — so they activate a relationship *before* it becomes a competitive bid.

Re-target of the proven BBC Lead Gen engine. Full spec:
[docs/DAS-LeadGen-System-Specification.md](docs/DAS-LeadGen-System-Specification.md).
Architecture: [docs/AGENT-ARCHITECTURE.md](docs/AGENT-ARCHITECTURE.md) ·
Kickoff items: [docs/phase-0-discovery.md](docs/phase-0-discovery.md) ·
Setup: [docs/workstation.md](docs/workstation.md).

## The 4-stage engine
```
HARVEST → 7 public-data signal layers across 3 metros   (PERCEIVE)
ENRICH  → developer identity, deeds, contacts, archive  (REASON)
SCORE   → rank against Danielian's ICP                   (REASON)
DELIVER → weekly Pursuit Intelligence Brief              (ACT)  + improve each run (LEARN)
```
Every agent follows **Perceive → Reason → Act → Learn** (see AGENT-ARCHITECTURE.md).

## Signal layers
| # | Layer | Source | Status in this build |
|---|---|---|---|
| L1 | Building permits | OC portals (Playwright) · LA/Nashville Socrata | LA dataset **verified live** (`pi9x-tg5x`); Irvine ported; OC cities Phase-1 |
| L2 | Planning / Design-Review agendas | Granicus / Legistar / PDF | Ported from BBC (`agents/planning-drb`) |
| L3 | CEQA / EIR | CEQAnet | **New, verified live** (405→19 fit in a test pull) |
| L4 | Land transfers / deeds | ATTOM / OC RecorderWorks | Ported from BBC (`agents/deeds`) |
| L5 | HCD / density-bonus / streamlining | data.ca.gov CKAN | **New, verified live** (APR Table A2; real density-bonus projects) |
| L6 | SB 79 / transit triggers | OCTA / LA Metro / WeGo GTFS | **New, verified live** (5,247 OCTA stops; overlay-and-flag) |
| L7 | Developer / builder news | SerpAPI google_news | **New** (needs `SERPAPI_KEY` in das-leadgen.env) |

## Quickstart
```bash
npm install
# structural dry run (no live portals/keys needed — proves the wiring):
npm run pipeline -- --skip-preflight --no-enrich --days 30
# a live OC harvest (CEQA + HCD + SB79 + planning + Irvine permits):
npm run pipeline -- --skip-preflight --days 60
npm run brief                 # writes data/output/brief-<date>.html
```
Per-agent: `npm run agent:ceqa -- --days 30 -f summary` (also `agent:hcd`, `agent:sb79`, `agent:news`).
MCP server: `npm run mcp` (tools: `get-tier1`, `run-pipeline`, `get-dossier`, `search-pursuits`).
Weekly automation: `npm run schedule` (Windows Task Scheduler, Mon 06:00 PT).

## Repo structure
```
agents/
  shared/          browser, load-env (vault paths), contacts, danielian-fit, agent-harness
  permits/{oc,la,nashville}/   L1 permit agents (Irvine ported; LA+Nashville Socrata)
  planning-drb/    L2 (Granicus/Legistar/PDF, ported)
  ceqa/ hcd/ sb79/ developer-news/   L3/L5/L6/L7 (new, on the harness)
  deeds/           L4 (ATTOM/recorder, ported)
scripts/
  run-all-layers.js     orchestrator (4-pillar pipeline)
  consolidate-lib.js    normalize/dedup/merge → PursuitRecord
  score-lib.js          config-driven scoring (config/scoring.json)
  resolve-developer-entity.js   LLC → developer + archive relationship cross-ref
  build-brief.js        weekly Pursuit Intelligence Brief (HTML)
  email-brief.ps1 · setup-weekly-schedule.ps1 · preflight/selfheal/learn/run-tracker (reused)
config/   jurisdictions · signal-sources · das-icp · scoring   (all tunable, no code)
mcp-server/index.js     interactive querying
data/output/ runs/      artifacts + logs (gitignored)
```

## Secrets & vaults
Secrets load at runtime from the OneDrive keys vault (`das-leadgen.env`, with
`bbc-leadgen.env` layered under it). Most keys already exist (ATTOM, Google,
BatchData, Hunter, SerpAPI, M365 Graph). See [.env.example](.env.example) and
[docs/phase-0-discovery.md](docs/phase-0-discovery.md) for what to add. The three
vault locations (keys / memory / cortex) are defined once in `agents/shared/load-env.js`.

## Status
Engine scaffold **complete and wired end-to-end**; the four new layers verified
against live data. Remaining before pilot launch = the Phase-0 items
(seed lists, archive export, real recipients) and porting the rest of the OC
permit cities. Grep `PHASE-0 VERIFY` for every live-endpoint confirmation point.
