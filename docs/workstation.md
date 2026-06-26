# Workstation Setup

## Prerequisites
- **Node.js 20 LTS** (the orchestrator + agents are Node 20 CommonJS).
- **PowerShell** (email + scheduler scripts; Microsoft.Graph.Authentication module for sending).
- Access to the OneDrive keys vault (`…/VSCODE/keys/`) on this machine.

## Install
```bash
cd c:\vscode\das-leadgen\das-leadgen
npm install
npx playwright install chromium     # for the Playwright/patchright permit + planning agents
```

## Secrets
1. Create `…/OneDrive - Technijian, Inc/Documents/VSCODE/keys/das-leadgen.env`.
2. Add the keys listed in [.env.example](../.env.example). Most already exist in
   `bbc-leadgen.env` (auto-layered underneath) — you primarily need to add
   `SERPAPI_KEY`, `HUNTER_API_KEY`, and the `GRAPH_*` trio. Socrata + OpenCorporates
   tokens are optional.
3. Never commit secrets. `load-env.js` reads the vault at runtime; `.env*` is gitignored.

## Verify the wiring (no live sources needed)
```bash
npm run pipeline -- --skip-preflight --no-enrich --days 30
# → writes data/output/full-run-<date>.json with the layers that returned data
npm run brief
# → writes data/output/brief-<date>.html  (open it in a browser)
```

## A live OC harvest
```bash
npm run pipeline -- --skip-preflight --days 60
```
Runs CEQA + HCD + SB 79 + planning-DRB + Irvine permits (+ enrichment if keys
present), consolidates, scores, and writes the full run. Logs land in `runs/`.

## Weekly automation (production)
```powershell
npm run schedule          # registers DAS-LeadGen-Weekly, Mondays 06:00 PT
# to send the Brief for real, set DAS_EMAIL_ENABLED=true in das-leadgen.env
# and confirm recipients in scripts/email-brief.ps1
powershell -File scripts/setup-weekly-schedule.ps1 -Remove   # to unregister
```

## MCP (interactive querying in Claude)
`npm run mcp` starts the stdio server. To register it with Claude Code, add a
`das-leadgen` entry to `.mcp.json` pointing at `node mcp-server/index.js` (left
to the user — the build does not modify MCP startup config automatically).

## Troubleshooting
- **A layer returns 0 records** — expected offline or when a source drifts; the
  agent degrades to `[]` (never throws). Check `runs/` logs and the agent's
  `agent-runs/<name>.jsonl` in the memory vault for the keep-rate trend.
- **`PHASE-0 VERIFY`** — grep the repo; each marks a live endpoint/selector to confirm.
- **preflight noisy** — it still carries BBC tables; run with `--skip-preflight` until retargeted.
