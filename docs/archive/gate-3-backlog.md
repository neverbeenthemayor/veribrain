# VeriBrain — Archived Gate 3 Backlog Register (`VERIFIED_CLOSED`)

- **Closed:** `2026-11-25` (`17/17 pts`, `6/6` Chiefs `PASS` / `APPROVED`, `0` open `P0`/`P1`/`P2`).
- **Brief:** [`docs/briefs/PM-301-305-gate3-stdio-mcp.md`](../briefs/PM-301-305-gate3-stdio-mcp.md)

| ID | Item | Pri | Pts | Status | Owner | Verification Evidence |
|---|---|---:|---:|---|---|---|
| **PM-301** | Local `stdio` MCP server (`src/mcp/server.ts`, `veribrain mcp`, 5 RFC-001 tools, lazy load) | `P0` | `5` | `VERIFIED_CLOSED` | Builder + CQE + Bench | `StdioClientTransport` E2E (`5` exact tools, `0` stdout pollution, warm compile `p95=4.728 ms`, lazy load verified) |
| **PM-302** | Fail-closed MCP Tier 3 write boundary, zero secret echo & `P2-G2-1` hash-exempt scope fix | `P0` | `3` | `VERIFIED_CLOSED` | Builder + Security | `P2-G2-1`, `P2-G3-1..2`, `P3-G3-1..3` all `VERIFIED_CLOSED`; atomic `.brain/hypotheses/HYP-*.json` confinement (`0` echo, `0` Tier 1/2 writes) |
| **PM-303** | Cross-client config printer (`--print-config`) & `docs/mcp-clients.md` (Antigravity/Claude/Cursor/Codex) | `P1` | `3` | `VERIFIED_CLOSED` | Builder + CUDE | Valid JSON/TOML for all 4 clients, Windows `cmd /c npx` + local clone docs (`4,430 B` LF), unified `runCliEntrypoint` exit propagation |
| **PM-304** | Real `stdio` JSON-RPC Golden suite (`tests/golden/mcp-stdio.test.ts`) & Red/Blue MCP audit | `P0` | `3` | `VERIFIED_CLOSED` | CQE + Security | `15/15` files, `56/56` tests pass (`9.62s`), `0` tsc/Biome warnings, `0` open `P0`/`P1`/`P2` |
| **PM-305** | Stage 3 packaging/audit/FinOps sign-off + Tier 1 Build-in-Public `gdocs` Blog & `gslides` 10-Slide Deck | `P1` | `3` | `VERIFIED_CLOSED` | CPM + CIE + CFOE + CUDE + Bench | `npm audit` `0` vulns, `31` files / `48.1 kB` tarball, `$0.4851 / $10.00` MTD (`$0.00` Stage 3), Google Doc + 10-Slide Deck published & verified |
