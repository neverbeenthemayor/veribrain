# Brief: PM-701 (`PRG-3` · `v1.3.0` — Local `$0` ROI & Token-Savings Telemetry)

- **Gate:** Post-Release Gate 3 (`PRG-3`, `v1.3.0`, release train `pre-staging` -> `staging` -> `main`)
- **Feature:** `PM-701` (`veribrain stats` + opt-in local `.brain/.metrics.jsonl` + MCP `veribrain_stats`)
- **Story Points & Priority:** `3 pts` (Fibonacci) · `P1` · **ICE:** `0.80` (`Impact 8` × `Confidence 9` × `Ease 10` / `900`)
- **Parked (`PRG-3+`):** `PM-505` (`3 pts`, Calibrated tokenizer profiles `--tokenizer gemini4 | default`, ICE `0.48`) remains `PARKED`.
- **Owners:** Author: `Builder` · Verifiers: `Security`, `CQE`, `CIE`, `CUDE`, `Bench`, `CFOE` (zero self-verification)

---

## 1. Customer Problem & Scope

Engineers adopting VeriBrain via CLI and local `stdio` MCP lack an audited, `$0`-cost local way to measure how much prompt volume and Zone A0 constitutional prefix context VeriBrain reuses across sessions and roles.

`PM-701` introduces **strictly opt-in, local-only, zero-custody compile telemetry** and an offline reporting surface (`veribrain stats` and read-only MCP `veribrain_stats`) without adding runtime dependencies, external network calls, or prompt/claim content logging.

---

## 2. Requirements & Architecture Invariants

### A. Opt-In Local Metrics Ledger (`src/metrics.ts` & `.gitignore`)
- **Disabled by Default:** `compileContext` does NOT create or append `.brain/.metrics.jsonl` unless opt-in is active (`options.recordMetrics === true`, `config.metrics?.enabled === true`, or explicit env opt-in).
- **Gitignored & Compiler-Isolated:** Add `.brain/.metrics.jsonl` and `.brain/.metrics.json` to `.gitignore`. Ignored by `eval`, `diff`, `retro`, `check-citations`, and `mirror`. Never leaks into `.brain/compiled/` orZone A/B outputs.
- **Zero-PII / Zero-Secret JSONL Schema (`CompileMetricEvent`):**
  - Store only `{ ts, source: "cli" | "mcp", role, env, layout: "split" | "legacy", zone_a0_sha256, zone_a_sha256, zone_a0_tokens, zone_a_tokens, zone_b_tokens, total_tokens, compile_ms }`.
  - Hashes MUST be truncated `12`-hex SHA-256 prefixes. Never store prompts, claim titles, claim bodies, file contents, user identifiers, or raw file paths.
- **Symlink & Boundary Confinement (`Exit 4`):** Check `isUncOrDevicePath`, `isBlockedSystemOrIsolationPath`, `lstatSync` symlink rejection, non-regular-file rejection, and `realpathSync` confinement within `brainDir`/`repoRoot` BEFORE reading, writing, compacting, or deleting `.metrics.jsonl` or `config.json`.
- **Bounded File Growth:** Validate `metrics.max_bytes` within `1024..10485760` (default `2_097_152` bytes / `2 MiB`). When an append would exceed `max_bytes`, atomically compact to keep the newest ~50% tail. Tolerate and count corrupted JSONL lines without crashing.

### B. CLI Command (`veribrain stats`) & Agent Safety
- **Syntax:** `veribrain stats [--since 30d|7d|24h|all] [--baseline-paths <csv>] [--format text|md|json] [--enable | --disable | --reset] [--brain-dir <dir>] [--repo-root <dir>]`
- **Agent-Mode Mutator Refusal (`Exit 4`):** Pre-flag guard in `cli.ts` AND inside `runStats` refuses `--enable`, `--disable`, and `--reset` in agent mode with `Exit 4`. Read-only `veribrain stats` works in agent mode and via MCP. Mutually-exclusive flags exit cleanly with `Exit 1`.
- **Baseline Docs Measurement (`--baseline-paths`):** Confined inside `repoRoot` BEFORE `lstatSync` (`Exit 4` on escape without echoing out-of-repo paths); rejects UNC/blocked isolation paths and symlinks; capped at `<= 500` files, `<= 512 KB` per file, depth `<= 32`.
- **Metrics & Methodology Transparency:**
  - Compute `compiles_total`, `cli_compiles`, `mcp_compiles`, `zone_a0_eligible_compiles`, `zone_a0_repeat_hits`, `zone_a0_cross_role_hits`, `zone_a0_cacheable_tokens_reused`, `estimated_cache_discount_tokens_at_90pct`, `avg_*` token/latency stats, baseline doc counts/tokens, `tokens_avoided_vs_baseline_docs`, and `compression_ratio_pct`.
  - Include an explicit `methodology_note` separating **measured local telemetry** from **estimated figures** (`~4 chars/token` approximation, nominal `90%` KV-cache discount model; no external billing claims).
- **Output Hygiene & UX Limits:** Run `assertQuarantineClean` on rendered output (`Exit 2` on failure). `veribrain --help` `<= 20` lines / `<= 80` cols plain ASCII; `veribrain stats --help` `<= 12` lines / `<= 80` cols plain ASCII; `--format text` `<= 80` cols plain ASCII.

### C. Local `stdio` MCP (`veribrain_stats`) & Release Parity (`v1.3.0`)
- Register read-only `veribrain_stats` (`readOnlyHint: true`, `idempotentHint: true`, `{ since?, format?: "json" | "md" }`) as the 7th MCP tool in `src/mcp/server.ts`.
- Tag MCP compile events with `metricSource: "mcp"`.
- Bump version to `1.3.0` across `package.json`, `package-lock.json`, `src/cli.ts`, and `src/mcp/server.ts` while preserving zero new runtime deps, `"bin": { "veribrain": "dist/cli.js" }`, `"repository.url": "git+https://github.com/neverbeenthemayor/veribrain.git"`, and `npm publish --dry-run` with `0` warnings.
- Update `.github/CODEOWNERS` for `/src/metrics.ts` and `/src/commands/stats.ts`.

---

## 3. Acceptance & Verification Bar

1. `npm run build && npm run typecheck && npm run lint && npm test` green (100% pass).
2. `node benchmarks/run_redteam.mjs`, `node dist/cli.js eval --strict`, `node dist/cli.js check-citations` green.
3. `npm publish --dry-run` exits `0` with `0` publish warnings and excludes `.brain/`.
4. Independent `6/6` Chief sign-off (`Security`, `CQE`, `CIE`, `CUDE`, `Bench`, `CFOE`) with `0` open `P0`–`P2` findings.
