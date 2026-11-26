# VeriBrain — Archived Progress Reports (Gates 2 & 3)

- **Master Hub:** [`PRODUCT.md`](../../PRODUCT.md) · **Active Reports:** [`docs/progress-reports.md`](../progress-reports.md)

## Gate 2 Report — `2026-11-25` (Stage 2 Wind Tunnel & Telemetry · `VERIFIED_CLOSED`)
- **Status:** `GREEN / GATE 2 VERIFIED_CLOSED (19/19 pts · 5/5 Chief Sign-Off · Live Gemini 4 Proof Complete)`
- **Completed:**
  - Delivered `PM-201`–`PM-205` per [`PM-201-205-gate2-wind-tunnel.md`](../briefs/PM-201-205-gate2-wind-tunnel.md): **`129/129` Red-Team Wind Tunnel** (`125` attacks + `4` controls, `0%` policy escape, `0` canary leaks after patching 3 real `src/**` bugs), `45`-file warm latency **`p50 = 8.48 ms / p95 = 12.62 ms`** (`~7.9x` vs cold NTFS), 13-cell Colab notebook, and 3 WCAG SVGs.
  - **Live Gemini 4 AI Studio & Colab Proof (`$0.4851` cumulative across 3 runs `<< $5.00` cap):** Calibrated `countTokens` (`7,204` actual vs `8,743` est. `+21.4%` Two-Zone headroom; `7,112`-tok `gemini4-cache` Zone A); stateful `previous_interaction_id` A/B (`12/12` `"completed"`, `$0.1765`) proved **Arm B `73.13%` T2–T6 (`75.04%` peak, `32,938` tok cached — exact `prev_in - 2,049` ceiling) vs. Arm A `0.0%` (`0` tok)**; Colab offline structural grounding **`10/10`** vs. `6/10` Flat Dump vs. `1/10` Stale RAG.

## Gate 3 Report — `2026-11-25` (Stage 3 Local `stdio` MCP & Tier 1 Launch Assets · `VERIFIED_CLOSED`)
- **Status:** `GREEN / GATE 3 VERIFIED_CLOSED (17/17 pts · 6/6 Unanimous Chief Sign-Off · 0 Open P0/P1/P2)`
- **Completed:**
  - **Local `stdio` MCP Server (`PM-301`–`PM-303`):** Shipped `veribrain mcp` (`src/mcp/server.ts`, `src/commands/mcp.ts`) with exact pinned OSS deps (`@modelcontextprotocol/sdk@1.32.2`, `zod@4.6.7`, lazy-loaded strictly on `veribrain mcp`), exposing the 5 RFC-001 tools (`veribrain_compile_context`, `veribrain_get_claim`, `veribrain_record_hypothesis`, `veribrain_propose_scar`, `veribrain_status`), `--print-config` for Antigravity, Claude Code, Cursor, and Codex, and [`docs/mcp-clients.md`](../mcp-clients.md) (`4,430 B` LF).
  - **Adversarial Remediation & Closure (`PM-304`–`PM-305`):** Closed Stage 2 `P2-G2-1` (`depth === 1` top-level `observed.evidence_ref` scope) plus ALL Gate 3 Security & CUDE findings (`P2-G3-1` exact realpath equality, `P2-G3-2` `hint <= 4,096 B` & `roles <= 32` bounds, `P3-G3-1` unified `runCliEntrypoint` exit propagation, `P3-G3-2` 64-char `HYP-*` alignment, `P3-G3-3` TOML control-char escaping, scrubbed `--print-config` errors, and CI `npm run build` before `npm test`).
  - **Unanimous `6/6` Independent Verification:** `CQE` (`PASS`, `15/15` suites, `56/56` tests, MCP `p95=4.728 ms`), `Security` (`PASS`, `0` open `P0`–`P2`), `CUDE` (`PASS`), `CIE` (`PASS`, `0` vulns, `31` files / `48.1 kB` tarball), `Bench` (`PASS`), `CFOE` (`APPROVED`, `$0.4851 / $10.00` MTD, `$0.00` Stage 3).
  - **Build-in-Public Workspace Deliverables (`gdocs` & `gslides`):**
    - Engineering Blog Post (`docs/blog-veribrain-post.md` + 2 embedded 300-DPI Colab charts): `[Internal Workspace Draft]`
    - 10-Slide Benchmark Talk Deck (visually verified): `[Internal Workspace Draft]`
