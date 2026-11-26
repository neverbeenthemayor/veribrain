# Feature Brief: Gate 1 — Stage 1 `$0` Deterministic Compiler (`PM-101`–`PM-105`)

- **Owner:** CPM · **Gate:** Gate 1 (`17 pts <= 20-pt` cap) · **Branch:** `pre-staging` -> `staging` -> `main`
- **ICE / 125:** `Impact 5 x Confidence 5 x Ease 4 = 100 / 125`
- **Modified Fibonacci Breakdown:** `PM-101` (`3`) + `PM-102` (`5`) + `PM-103` (`3`) + `PM-104` (`3`) + `PM-105` (`3`) = **`17 pts`**
- **Authoritative Spec:** [`docs/RFC-001-veribrain-architecture.md`](../RFC-001-veribrain-architecture.md)

---

## 1. Problem & Target User
Solo founders and AI-native engineers running multi-agent workflows lose architectural decisions, inject stale environment state, bust LLM KV caches with mutable prompt headers, and risk indirect prompt injection or secret leakage when agents self-attest memory. Gate 1 ships the `$0` local deterministic TypeScript/Node 24 CLI compiler (`veribrain`) with fail-closed provenance, quarantine scrubbing, 1-screen weekly diffs, and 5 `$0` Golden Context Eval suites.

## 2. Locked Requirements (Consolidated from Security, CUDE, Bench & CIE)

### A. Packaging, Toolchain & CI Hygiene (`PM-101`, CIE Spec)
- `package.json`: `"name": "veribrain"`, `"version": "0.1.0"`, `"type": "module"`, `"engines": { "node": ">=24.0.0" }`, **`"dependencies": {}`** (zero runtime deps; Node stdlib only).
- `devDependencies`: pinned clean `typescript`, `@types/node`, `vitest`, `@biomejs/biome` + synced `package-lock.json` (`0` high/critical `npm audit`).
- `bin`: `{ "veribrain": "./dist/cli.js" }` (`#!/usr/bin/env node` LF line 1); `main: "./dist/index.js"`, `types: "./dist/index.d.ts"`, `exports`, `files: ["dist", "README.md", "LICENSE"]`.
- Scripts: `build` (clean `dist` + `tsc -p tsconfig.build.json`), `typecheck` (`tsc --noEmit`), `lint` (`biome check src tests`), `test` (`vitest run`), `test:watch` (`vitest`), `prepack` (`npm run build`).
- Dual `tsconfig`: root `tsconfig.json` (`include: ["src/**/*.ts", "tests/**/*.ts"]`, `exclude: ["dist", "node_modules", "next.config.security.example.ts"]`, `ES2024`, `NodeNext`, `strict`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, `noUnusedLocals`, `noUnusedParameters`, `noImplicitReturns`, `noEmit: true`) + `tsconfig.build.json` (`rootDir: "src"`, `outDir: "dist"`, `declaration: true`).
- `.gitattributes`: enforce `*.ts text eol=lf`, `*.js text eol=lf`, `*.json text eol=lf`, `*.md text eol=lf`.
- `biome.json`: target `src/` and `tests/`, ignore `dist/` and `next.config.security.example.ts`, error on `noEmptyBlockStatements`.

### B. Typed `.brain/` Store & Two-Zone Deterministic Compiler (`PM-101`, `PM-102`, Bench Spec)
- Support `--brain-dir <path>` (default `.brain`) and `--repo-root <path>` (default `process.cwd()`) across commands for clean read-only shadow testing.
- `veribrain init [--signed-by <human>] [--brain-dir <path>]`: creates `.brain/config.json` (with `schema_version: "1.0"`, `estimator_version: "utf8-3.5x1.15-v1"`, `chars_per_token: 3.5`, `safety_margin: 1.15`, `default_max_tokens: 8192`, `quarantine: { allowed_emails: [], allowed_domains: [], allowed_phones: [] }`), `decided/`, `observed/`, `hypotheses/`, and `< 512 B` `scars.md` header. Only writes starter `DEC-001` if `--signed-by` is explicitly passed and non-agent.
- **Zone A (Byte-Frozen Static Prefix):** UTF-8 (no BOM), NFC-normalized, LF (`\n`) only, trimmed trailing line spaces, terminated with `\n\n`. Header contains `schema_version`, `role`, `semantic_hash` (SHA-256 of canonical semantic config keys + sorted active matching `(id, priority, sha256_body)`). Zero timestamps, `--env`, `--git-sha`, `--max-tokens`, counters, or OS paths in Zone A. Sort `decided/` strictly by `(priorityRank ASC [P0=0, P1=1, P2=2], id ASC)` using pure ASCII code-point order (never `localeCompare`). Cite `DECIDED` rules inside Zone A as `Based on: <DEC-ID> (sha256:<body12>)`.
- **Zone B (Uncached Dynamic Tail):** Separated in `--format md` by `\n\n<!-- VERIBRAIN:ZONE_BOUNDARY:A_END -->\n\n`. Contains fresh non-expired `observed/` matching `--env` (and optional `--git-sha`) sorted by `claim_id ASC`, each with verbatim footer `Based on: <claim_id> (<env>@<sha>)`, followed by sanitized `<untrusted_hint>` scars and pending `hypotheses/`, plus `## Evicted (Token Budget)` lines `[EVICTED: <id>, reason=token_budget]` if overflow occurred.
- **Token Estimator & Eviction:** `estTokens(text, blocks) = Math.ceil((Buffer.byteLength(text, "utf8") / chars_per_token) * safety_margin) + (blocks * 4)`. `total_tokens_est === zone_a_tokens_est + zone_b_tokens_est`. If Zone A alone (or pinned `P0`/`P1` `DECIDED`) exceeds `--max-tokens`, **fail closed (`EXIT_BUDGET_INFEASIBLE = 3`, zero stdout)**. Otherwise evict Zone B in strict deterministic order: `hypotheses` (oldest/id) -> oldest `scars` -> lowest-priority `observed` (excluding pinned P0/P1 if any), emitting verbatim `[EVICTED: <id>, reason=token_budget]` notices.
- **`compile --format json` Telemetry Schema:** Emit `{ schema_version, estimator_version, role, env, git_sha, zone_a, zone_b, zone_a_sha256, semantic_hash, zone_a_bytes, zone_b_bytes, zone_a_tokens_est, zone_b_tokens_est, total_tokens_est, max_tokens, compile_ms, evicted_ids, excluded_stale_ids, kv_cache_floor_advisory }` where `zone_a_sha256` is 64-hex SHA-256 of exact UTF-8 `zone_a`.

### C. Fail-Closed Quarantine, Provenance & Hint Sandboxing (`PM-103`, Security Spec)
- **Secret Regexes (linear-time):** `gcp_api_key` (`AIza...`), `jwt` (`eyJ...eyJ...`), `bearer`, `pem_private`, `provider_token` (`sk-`, `gh[pousr]_`, `github_pat_`, `xox`, `AKIA`, `ya29.`, `GOCSPX-`), `oauth_kv`.
- **PII Regexes + Whitelist:** `pii_email`, `pii_phone` (E.164 `+` or explicit separators; never triggers on ISO dates/semver), skipping only exact lowercase `config.quarantine.{allowed_emails,allowed_domains,allowed_phones}`.
- **Shannon Entropy (`len >= 32`):** Mixed/base64 `H >= 4.5` (`>= 3` char classes) or `H >= 4.7` (`>= 2` classes); pure hex `H >= 3.5`. Allowlist (entropy only, never bypasses secret/PII regexes): validated `git_sha`/`sha256_body`/`zone_a_sha256`, RFC 4122 UUIDs, `sha256:<64hex>` / `commit/<40hex>`, and repo paths whose segments stay below threshold.
- **Fail-Closed Exit `2` (`EXIT_QUARANTINE_VIOLATION`):** Runs before any `compile` output, `observe` disk write, or `diff` output. Zero bytes to `stdout`, zero partial files, zero raw secret/substring/snippet echo in `stderr`.
- **`<untrusted_hint>` Sandboxing:** Zone B only; hardcoded `non_authoritative="true"`, `source` enum `"scar"|"hypothesis"`, validated `id` and repo-relative `regression_test`, XML-escaped attributes; body normalized NFKC, stripped of ASCII control & bidi/zero-width chars, all `&`/`<`/`>` escaped to `&amp;`/`&lt;`/`&gt;`; post-render assertion verifies single wrapper and zero inner `<`/`>`.
- **Write-Authority & Integrity:** `veribrain observe` writes atomically (temp -> rename) ONLY to `.brain/observed/<claim_id>.json` (`OBS-*`), requires `--issuer` in `ci | git-hook | verifier-script`, valid `env`, `git_sha`, integer `ttl` (`1..2592000`), and non-empty `--evidence`; rejects agent self-attestation (`EXIT_PROVENANCE_VIOLATION = 4`) if `--issuer` invalid or `VERIBRAIN_CALLER_ROLE=agent` / `VERIBRAIN_AGENT_MODE=1`. `eval` & `compile` verify `decided/*.md` frontmatter, non-agent `signed_by`, exact `sha256_body`, `scars.md < 4,096 B` + `<= 30d` TTL + valid `regression_test` (and file existence in `--strict`), and `hypotheses/*.json` TTL `<= 7d`.

### D. CLI Ergonomics & Weekly 1-Screen Brain Diff (`PM-104`, CUDE Spec)
- Plain ASCII only, `<= 80`-col wrap, zero ASCII art/emoji, pipe-safe (`stdout` = artifact/digest, `stderr` = diagnostics/errors). Exit codes: `0` ok, `1` error/eval-fail, `2` quarantine, `3` budget-infeasible, `4` provenance-violation.
- `veribrain diff [--since 7d]`: strictly `<= 5` bullets, `<= 25` lines total, sorted `(1) expired/unlinked scars, (2) pending hypotheses, (3) expired observed, (4) modified decided` (`id ASC` tie-break), each item carrying `   Action: [Keep] [Revert] [Promote to DECIDED]`, plus 3-line clean empty state.
- Actionable `stderr` templates for Exit `2` and Exit `3` (exact `claim_id`, `rule`, `detail`, 1-command `fix`). Concise `--help` (`<= 20` lines, `<= 80` cols) and receipt lines for `init`, `compile`, `observe`, `eval`, `diff`.

### E. Verification Gate (`PM-105`, CQE + Security + CUDE + Bench + CIE + CFOE)
- CQE independently authors/runs the 5 `$0` Golden Context Eval Vitest suites (`tests/golden/`), 100-run latency test (`p95 < 15.0 ms` + `100/100` identical `zone_a_sha256`), and strictly read-only shadow-compile test (ZERO writes outside the VeriBrain repo).
- Zero self-verification: Builder implements `src/**` + unit tests (`tests/unit/`); CQE owns `tests/golden/` & `QUALITY.md`; Security runs Red/Blue audit (`SECURITY.md`); CUDE verifies CLI/diff UX; Bench verifies latency/KV-cache telemetry; CIE verifies CI/packaging/`--verify`; CFOE issues 5-line Gate 1 FinOps verdict.

## 3. Explicit Non-Goals (Stage 1)
- No Stage 2 Google AI Studio API calls or Colab notebooks (`$0.00` strictly).
- No Stage 3 `@modelcontextprotocol/sdk` MCP server (`src/mcp/**` stays out of Stage 1).
- No cloud/Firebase/Firestore/vector DB services; ZERO writes to external repositories.
