# Feature Brief: Gate 3 — Stage 3 Cross-Client Local `stdio` MCP (`PM-301`–`PM-305`)

- **Owner:** CPM · **Gate:** Gate 3 (`17 pts <= 20-pt` cap) · **Branch:** `pre-staging` -> `staging` -> `main`
- **ICE / 125:** `Impact 5 x Confidence 5 x Ease 4 = 100 / 125`
- **Modified Fibonacci Breakdown:** `PM-301` (`5`) + `PM-302` (`3`) + `PM-303` (`3`) + `PM-304` (`3`) + `PM-305` (`3`) = **`17 pts`**
- **Authoritative Spec:** [`docs/RFC-001-veribrain-architecture.md`](../RFC-001-veribrain-architecture.md) (Section 9)

---

## 1. Problem & Target User
Developers using **Antigravity, Claude Code, Cursor, and Codex** on the same repository suffer context fragmentation across IDE/agent boundaries. Gate 3 exposes VeriBrain's `$0` deterministic compiler and fail-closed Tier 3 hypothesis intake over a **local `stdio` MCP server (`npx veribrain mcp`)** using `@modelcontextprotocol/sdk` — zero cloud servers, zero vector DBs, zero agent write authority over `decided/`, `observed/`, or `scars.md`.

## 2. Locked Requirements

### A. `PM-301` (`5 pts`, `Builder`) — Local `stdio` MCP Server (`src/mcp/server.ts`, `veribrain mcp`)
- Add official `@modelcontextprotocol/sdk` (plus `zod` if required by SDK peer dep) to `package.json` `dependencies` — **ZERO LLM SDKs, ZERO cloud/network runtime deps**, `npm audit --audit-level=high` = `0` vulnerabilities.
- Lazy-load `./mcp/server.js` dynamically inside `src/cli.ts` ONLY when subcommand === `"mcp"` so non-MCP CLI commands (`init`, `compile`, `observe`, `eval`, `diff`) incur zero MCP startup overhead.
- Strictly **zero non-JSON-RPC bytes on `stdout`** during `veribrain mcp` execution (all operational diagnostics go strictly to `stderr`).
- Expose the exact **5 RFC-001 Section 9 MCP tools** via `McpServer` + `StdioServerTransport`:
  1. **`veribrain_compile_context`** (`readOnlyHint: true`): Params `{ role, env, git_sha?, max_tokens?, format?: "md"|"json" }`. Runs deterministic `compileContext(...)` with fail-closed quarantine & budget guard; returns structured JSON text containing `zone_a`, `zone_b`, `zone_a_sha256`, `semantic_hash`, `zone_a_tokens_est`, `zone_b_tokens_est`, `total_tokens_est`, `compile_ms`, `evicted_ids`, `excluded_stale_ids`, and rendered `markdown` (when `format === "md"`).
  2. **`veribrain_get_claim`** (`readOnlyHint: true`): Params `{ claim_id }`. Fetches full verified evidence for a specific `DEC-*`, `OBS-*`, `SCAR-*`, or `HYP-*` record (quarantine-scrubbed before return; returns structured `isError: true` not-found without crashing server).
  3. **`veribrain_record_hypothesis`** (`Tier 3 only`): Params `{ hint, roles?, ttl_days? (default 7, max 7), id? }`. Validates schema, enforces TTL `<= 7` days, runs full fail-closed quarantine scrubber (rejects with `isError: true` and zero raw secret echo), and writes atomically (`wx` temp -> `renameSync`) ONLY into `.brain/hypotheses/HYP-*.json` (`issuer: "agent"`). NEVER writes `decided/`, `observed/`, or `scars.md`.
  4. **`veribrain_propose_scar`** (`Tier 3 proposal`): Params `{ hint, regression_test, roles?, ttl_days? (default 30, max 30), id? }`. Validates `regression_test` (strict `isValidRepoRelativeTestRef` + symlink-confined file existence inside `repoRoot`), checks `scars.md` `< 4,096 B` headroom, runs full quarantine scrubber, and writes atomically ONLY as a Tier 3 proposal `.brain/hypotheses/HYP-SCAR-*.json` (with `kind: "scar_proposal"`, `regression_test`, `proposed_ttl_days`, short `<= 7d` hypothesis TTL) queued for human `veribrain diff` approval — NEVER mutates `scars.md` directly!
  5. **`veribrain_status`** (`readOnlyHint: true`): Params `{}` (optional `env?`). Reports `.brain/` health, counts (`decided`, `observed`, `hypotheses`, `scars`), `scars_bytes` vs `4,096 B`, expired claims, pending scar proposals, and `evaluateBrain` verdict.
- Export `createVeriBrainMcpServer({ brainDir, repoRoot })` from `src/mcp/server.ts` (and re-export cleanly) for direct testability.

### B. `PM-302` (`3 pts`, `Builder` + `Security`) — Fail-Closed MCP Authority & `P2-G2-1` Closure
- **Strict Write-Authority Boundary:** MCP server has ZERO tools to write `decided/`, `observed/`, `scars.md`, or `config.json`. All `record_hypothesis` / `propose_scar` IDs are strictly validated against `/^HYP-[A-Za-z0-9._-]{1,64}$/` (blocking path traversal `..`/`/`/`\`).
- **Zero Secret Echo in MCP Errors:** All tool errors pass through `VeriBrainError` / `sanitizeQuarantineClaimId` / `sanitizeQuarantineField` and `scanTextForQuarantine` fallback redaction before returning `{ isError: true, content: [...] }`!
- **Close Stage 2 `P2-G2-1` (`SECURITY.md`):** Tighten `HASH_EXEMPT_FIELDS` in `src/schema.ts` (`scanDecodedJsonStrings`) so hash-ref entropy exemption (`sha256:`, `commit/`, `<env>@<40hex>`) applies **ONLY** to top-level `evidence_ref` / `git_sha` inside `observed/*.json`, NEVER to arbitrary nested keys in `config.json` or `hypotheses/*.json`!

### C. `PM-303` (`3 pts`, `Builder` + `CUDE`) — Cross-Client MCP Config Templates & DX
- Add `veribrain mcp --help` (`<= 12` lines, `<= 80` cols) and `veribrain mcp --print-config <antigravity|claude-code|cursor|codex>` emitting clean copy-pasteable JSON/TOML local `stdio` config pointing to `npx -y veribrain mcp --brain-dir .brain --repo-root <repo>` (without starting the stdio server when `--print-config` is passed).
- Write `docs/mcp-clients.md` (`< 8,192 B`) documenting exact 1-minute setup for **Antigravity**, **Claude Code**, **Cursor**, and **Codex**, plus tool authority matrix (`read-only` vs `Tier 3 only`).

### D. `PM-304` (`3 pts`, `CQE` + `Security`) — Independent Real `stdio` JSON-RPC Golden Test Suite
- Author `tests/golden/mcp-stdio.test.ts` spawning real `node ./dist/cli.js mcp --brain-dir <tmp> --repo-root <tmp>` over `StdioClientTransport` using `@modelcontextprotocol/sdk/client`:
  - Lists exact 5 tools and calls every tool end-to-end over real `stdio`.
  - Verifies zero stdout pollution, byte-identical `zone_a_sha256` across calls, and `< 15 ms` in-process compile telemetry.
  - Adversarial tests: secret in `veribrain_record_hypothesis` / `veribrain_propose_scar` rejected (`isError: true`, zero raw secret echo, zero file created); `../` path traversal ID rejected; `regression_test` symlink/`..`/non-existent file rejected; verifies `decided/`, `observed/`, and `scars.md` remain 100% unmodified after hypothesis & scar proposals; verifies `P2-G2-1` closure (nested `evidence_ref` in `hypotheses/*.json` or `config.json` no longer bypasses prose hex check!).

### E. `PM-305` (`3 pts`, `CIE` + `CFOE` + `Bench` + `CUDE`) — Packaging/CI/FinOps Audit & Tier 1 Publishing
- Verify `npm audit --audit-level=high` (`0` vulns), `npm pack --dry-run`, pure LF, `$0.00/mo` runtime, `< 8,192 B` active registers.
- Export full Build-in-Public **Engineering Blog Post** (`gdocs`) and **10-Slide Benchmark Talk Deck** (`gslides`) populated strictly with verified observed Stage 1–3 numbers!

## 3. Explicit Non-Goals (Stage 3)
- No HTTP/SSE remote MCP transport (local `stdio` only).
- No hosted vector DB, Firestore, or cloud sync; ZERO writes to external repositories.
