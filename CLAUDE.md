# VeriBrain — Standing Engineering & Multi-Chief Rules (v2.0)

- **One-Line Pitch:** Zero-dollar deterministic, provenance-verified context compiler and local stdio MCP shared brain for multi-agent engineering.
- **Core Stack:** TypeScript 5.x + Node.js 24 LTS (ESM) + Vitest + Git/GitHub Actions + Local stdio MCP (`@modelcontextprotocol/sdk`) + Google Colab / AI Studio + Google Docs / Slides (`gdocs` / `gslides`).
- **Hard Spend Cap:** `<=$10.00/mo` (Alerts: `$5.00` / `$9.00` / `$10.00`; CFOE trigger `$2.00`; core CLI compiler runs strictly at `$0.00/mo`, Stage 2 AI Studio calibration bounded `< $5.00`).
- **Project Type Note:** VeriBrain is a **local CLI + local `stdio` MCP package** (NO Firebase, Firestore, vector DB, or Cloud Run deployments). Baseline `apphosting*.yaml` / `firebase.json` files from `bootstrap_startup.py` are retained strictly as `minInstances: 0` Playbook `v2.0` `--verify` compliance guardrails.

## Non-Negotiable Standing Rules
1. **Git Is Single Source of Truth:** Every decision, RFC, brief, audit, and SHA lives in versioned Markdown. Read `docs/veribrain-context-handoff.md` and `docs/RFC-001-veribrain-architecture.md` before proposing architectural changes.
2. **Zero Self-Verification:** No Chief marks their own code or security claim `VERIFIED_CLOSED`. Pair Builder with CQE/Security.
3. **Strict Isolation & Weekend-Only Cadence:** Never write files, hooks, branches, or commits into external repositories configured in `VERIBRAIN_ISOLATION_SEGMENTS`. Shadow testing against external repos is strictly **read-only**.
4. **3-Tier Release Train:** `pre-staging` -> `staging` (soak/eval verification) -> `main` (clean milestone cuts). Cap weekend trains at `15-20 pts`.
5. **Active Register Diet (`< 8,192 B`):** Keep `PRODUCT.md`, `SECURITY.md`, `QUALITY.md`, `docs/finops-ledger.md`, `docs/progress-reports.md`, `docs/infrastructure-audit.md`, and `docs/design-strategy.md` strictly `< 8 KB`; archive closed stages under `docs/archive/`.
6. **Zero-Custody Secrets & Fail-Closed Provenance:** Never paste API keys in chat or commit `.env` files. Use `scripts/run_with_key.*` masked stdin launchers for Stage 2 AI Studio tests. Agents emit `HYPOTHESIS` only — never self-attest `OBSERVED` or `DECIDED`.
7. **Post-Release Gate Naming:** Label post-`v1.0` waves `Post-Release Gate 1`, `Post-Release Gate 2`, `Post-Release Gate 3` (`PRG-1+`), capped at `<= 20 pts` each.
