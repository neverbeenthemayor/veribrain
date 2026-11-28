# Changelog

All notable changes to **VeriBrain** are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.4.0] - 2026-11-28

Guided `.brain/` Maturity & Readiness Diagnostics Wave (`PRG-4`: `PM-702`, `3/20 pts`; `PM-703` `PROPOSED`, `PM-505` `PARKED`), adding a strictly read-only CLI diagnostic surface while leaving the `7`-tool MCP server and `Zone A` compilation untouched (`$0.00/mo` runtime, zero new dependencies).

### Added & Changed

- **Guided Read-Only Maturity Diagnostics (`veribrain doctor`, `PM-702`):**
  - Added `veribrain doctor [--format text|md|json] [--role <role>] [--env <env>] [--strict] [--brain-dir <dir>] [--repo-root <dir>]` (`src/commands/doctor.ts`) plus `runDoctor`, `formatDoctorText`, and `formatDoctorMarkdown` library exports (`src/index.ts`).
  - Strictly read-only (`recordMetrics: false` on split-layout `compileContext`, zero writes/mkdir/unlink/subprocess/network calls) and safe in agent mode (`VERIBRAIN_AGENT=1`), while tagging interactive/CI actions `(human)` or `(human/CI)` and copying-safe `veribrain decide --id DEC-NNN ... --signed-by "<Your Name>" --body "<rule>"` suggestions.
  - Executes `8` deterministic checks (`brain.present`, `eval.strict`, `tier1.decided`, `zone_a0.floor` vs `1,024`-token split floor, `tier2.observed` + depth-`0` worktree-backlink verified `VERIBRAIN_HOOK_MARKER` pre-commit hook detection, `tier3.scars` `< 4,096 B` strict budget & regression test links, `tier3.hypotheses`, and read-only `telemetry.stats`) to grade deterministic maturity `L0`–`L4` (`Exit 0` clean, `Exit 1` FAIL or `--strict` WARN, `Exit 2` quarantine, `Exit 4` confinement).
  - Enforces pre-read `.brain/` tier + symlink confinement (`lstatSync` before `realpathSync` on `--repo-root`, `ENOTDIR` normalization, zero raw path echo, raw flag quarantine before validation), `<= 30`-line / `<= 80`-col plain-ASCII wrapped text output, `11`-line `doctor --help` with exit codes, `20`-line global `--help` (`eval / doctor`), `/src/commands/doctor.ts` in `.github/CODEOWNERS`, and `1.4.0` package/CLI/MCP parity.

## [1.3.0] - 2026-11-28

Local `$0` ROI & Token-Savings Telemetry Wave (`PRG-3`: `PM-701`, `3/20 pts`; `PM-505` `3 pts` remains `PARKED`), preserving 100% byte-identical backward compatibility across `Zone A` / `Zone A0` compilation and strictly opt-in zero-PII local telemetry (`$0.00/mo` runtime, zero new dependencies).

### Added & Changed

- **Opt-In Zero-PII Local Metrics Ledger (`src/metrics.ts`, `.gitignore`):**
  - Added `.brain/.metrics.jsonl` (gitignored alongside `.brain/.metrics.json`, disabled by default; records only when `config.metrics.enabled === true`, `VERIBRAIN_METRICS=1|true`, or `recordMetrics: true`, with `veribrain retro` passing `recordMetrics: false` to avoid inflating stats).
  - Stores strictly 12 scalar/digest fields (`ts`, `source`, `role`, `env`, `layout`, `zone_a0_sha256` & `zone_a_sha256` 12-hex prefixes, token counts, `compile_ms`) — zero prompt/rule text, secrets, PII, or raw paths; rejects corrupt/overflow lines, enforces `O_NOFOLLOW` + `lstatSync`/`realpathSync` confinement, atomically compacts ~50% self-healing tail at `metrics.max_bytes` (`1024..10485760`, default `2 MiB`), and is ignored by `eval`, `diff`, `retro`, `check-citations`, and `mirror`.
- **CLI ROI & Telemetry Reporter (`veribrain stats`):**
  - Added `veribrain stats [--since 30d|7d|24h|all] [--baseline-paths <csv>] [--format text|md|json] [--enable | --disable | --reset]`.
  - Enforces pre-flag `Exit 4` agent refusal for `--enable`/`--disable`/`--reset` while keeping read-only `stats` available in agent mode and MCP; checks symlink ancestors (`Exit 4`) before `.brain/` creation, validates `--repo-root` via `lstatSync` prior to `realpathSync`, syncs `config.mirror_dirs` on toggle, pre-quarantines `--since`/`--format` (`Exit 2`, zero truncated secret reflection), scans bounded baseline docs (`<= 500` files / `512 KB` / depth `32`), tracks adjacent `zone_a0_cross_role_hits`, and prints explicit measured-vs-estimated `methodology_note` (`<= 80` cols plain ASCII text output).
- **7th MCP Tool & Release Parity (`veribrain_stats`, `v1.3.0`):**
  - Registered read-only MCP tool `veribrain_stats` (`readOnlyHint: true`, `idempotentHint: true`, `{ since?, format?: "json" | "md" }`), tagged `veribrain_compile_context` events with `metricSource: "mcp"`, covered `/src/metrics.ts` and `/src/commands/stats.ts` in `.github/CODEOWNERS`, and bumped CLI/MCP/package metadata to `1.3.0`.

## [1.2.0] - 2026-11-27

Constitutional Prefix Split, Test Attestation, Doc Drift Audit & Retro DX Wave (`PRG-2`: `PM-601`–`PM-605`, `18/20 pts`), preserving 100% byte-identical backward compatibility with `schema_version: "1.0"` legacy Zone A compilation (`$0.00/mo` runtime, zero new dependencies).

### Added & Changed

- **Zone `A0` + `A1` Constitutional Prefix Split (`PM-601`):**
  - Added `VALID_SCHEMA_VERSIONS = ["1.0", "1.1"]`, `ZoneALayout = "legacy" | "split"`, `ZONE_A0_BOUNDARY_MARKER`, `BrainConfig.zone_a_layout`, CLI `compile --zone-a-layout legacy|split`, and MCP `veribrain_compile_context` (`zone_a_layout`).
  - In `"split"` mode, shared constitutional rules (`roles: ["*"]`) compile into a role-agnostic `zone_a0` prefix (`zone_a0_sha256` 100% byte-identical across all 8 engineering roles), followed by role-specific `zone_a1`, plus additive `zone_a0*`/`zone_a1*` telemetry in `CompileResult` and `1,024`-token floor advisories.
- **Tamper-Evident Local Test Attestation (`PM-602`):**
  - Added `veribrain attest-test` (human/verifier-only `Exit 4` pre-flag agent denial, zero `shell: true`, shell-metacharacter rejection, safe Windows `npm-cli.js`/`npx-cli.js` Node resolution, bounded `--timeout`/`maxBuffer`, raw-arg pre-truncation quarantine scanning, zero raw output echo, `output_sha256` & `git_diff_stat_sha256` digests, and Tier 2 `OBS-VERIFY-*` receipt writing via `--record-failure`/`--dry-run`).
- **Zero-LLM Citation Drift Auditor (`PM-603`):**
  - Added `veribrain check-citations` scanning repo-confined Markdown (`Exit 4` pre-`lstatSync` escape/system/isolation rejection, `<= 500` files / `<= 512 KB` / depth `<= 32` bounds, fenced-code & placeholder exclusions) to catch missing/superseded `DEC-*` and missing/expired `OBS-*` IDs.
- **Weekly Retro Digest & Optional `env-ttl` Tier 2 Mode (`PM-604`):**
  - Added `veribrain retro [--since 7d] [--format md|json] [--env <env>] [--zone-a-layout legacy|split]` generating uncapped, quarantine-scrubbed Markdown/JSON reports covering `eval --strict`, 8-role `1,024`-token KV-cache floor audits, expiring claims (`<= 48h`), `scars.md` regression test checks, and promote commands.
  - Added `ObservedTtlMode = "sha-pinned" | "env-ttl"` (`<= 7d` / `604,800s` max TTL enforced at write/eval time, strict env match, cross-commit validity, explicit `(env@sha, env-ttl)` citations).
- **Tier-Aware Diff Actions, Rule Slugs & Package Hygiene (`PM-605`):**
  - Updated `veribrain diff` with category-specific action prompts (`[DEC]`, `[HYP]`, `[OBS]`, `[SCAR]`) and concise rule titles/slugs within strict `<= 5` bullets / `<= 25` lines / `<= 80` ASCII cols.
  - Normalized `package.json` (`"bin": { "veribrain": "dist/cli.js" }`, `"repository.url": "git+https://github.com/neverbeenthemayor/veribrain.git"`) for zero-warning `npm publish`, and aligned CLI/MCP metadata to `1.2.0`.

## [1.1.0] - 2026-11-26

Customer-Zero DX & Governance Wave (`PRG-1`: `PM-501`–`PM-504`), fully backward-compatible with `schema_version: "1.0"`, `renderZoneA`, and `buildSemanticHash` formatting (`$0.00/mo` runtime, zero new runtime dependencies).

### Added

- **Human Governance & Mirror Sync (`PM-501`):**
  - `veribrain decide` (`--id`, `--priority`, `--roles`, `--envs`, `--signed-by`, `--title`, `--supersedes`, `--file | --body`, repeatable `--mirror-dir`, `--dry-run`) and `veribrain sign <path>` with fail-closed human provenance (`Exit 4` under `VERIBRAIN_AGENT=1`, `VERIBRAIN_AGENT_MODE=1`, or non-human `--issuer`/`--signed-by`), LF normalization, quarantine scanning, and automatic `sha256_body` hashing.
  - `BrainConfig.mirror_dirs` with strict symlink/system/isolation (`VERIBRAIN_ISOLATION_SEGMENTS`) confinement and `veribrain eval --check-mirror` byte-for-byte SHA-256 drift auditing across `.brain/decided/*.md`, `.brain/scars.md`, and `.brain/config.json`.
  - Starter `DEC-001` from `veribrain init --signed-by` now includes `"*"` in `roles` so shared rules compile for custom roles (e.g. `cpm`) out of the box.
- **Human Review Promotion CLI (`PM-502`):**
  - `veribrain promote <HYP-ID>` (human-only `Exit 4`, `--to scar|decided`, `--dry-run`) validating quarantine (`Exit 2`), `regression_test` existence, and `< 4,096 B` `scars.md` ceiling, updating target tier + configured mirrors atomically, removing promoted `.brain/hypotheses/<HYP-ID>.json`, and gating with `eval --strict`.
- **Worktrees, `veribrain_list_claims`, `lint-text`, Safe Hostnames & JSON IDs (`PM-503`):**
  - Pure-filesystem Git worktree `.brain/` discovery (`resolveGitContext` + `resolveWorktreeHeadSha`, zero shell exec) with read-only primary-repo `.brain/` fallback (disabled in `initBrain` and write commands), `--brain` flag alias, and `--git-sha HEAD` resolution.
  - Explicit `included_decided_ids` and `included_observed_ids` arrays in `CompileResult` without modifying a single byte of `zone_a`, `zone_b`, or `zone_a_sha256`.
  - 6th read-only MCP tool `veribrain_list_claims` (`tier`, `prefix`, `role`, `limit <= 100`) returning quarantine-scrubbed metadata and total counts.
  - `isSafeHostnameToken()` quarantine exemption for clean `https?://` hostnames/paths while failing closed on userinfo `@`, query secrets `?`, embedded secret prefixes, and high-entropy subdomains/paths, plus dry-run `veribrain lint-text <file> [--format text|json]`.
  - Actionable `invalid_env` fix hint mapping `production -> prod` and `development -> local` while keeping strict validation.
- **Pre-Commit & CI Git Hook Installer (`PM-504`):**
  - `veribrain hooks install [--force] [--print-ci]` resolving normal `.git/hooks` and worktree `<commonDir>/hooks`, installing non-clobbering POSIX `pre-commit` (`eval --strict`), `post-checkout`, and `post-merge` (`observe --issuer git-hook`) scripts (`0o755`), plus a `$0` GitHub Actions YAML template.

## [1.0.0] - 2026-11-25

First open-source release of VeriBrain — a `$0.00/mo` deterministic, provenance-verified context compiler and local `stdio` MCP shared brain for Node.js 24 LTS.

### Added

- **Stage 1 — `$0` Deterministic Two-Zone Context Compiler & CLI:**
  - Typed Git-native `.brain/` store supporting human-signed `decided/*.md` (YAML frontmatter + 64-hex `sha256_body` integrity + non-agent `signed_by`), CI/hook `observed/*.json` keyed by `(env, git_sha, ttl_seconds)`, bounded `scars.md` (`< 4,096` UTF-8 bytes, `<= 30d` TTL, repo-relative `regression_test`), and short-TTL `hypotheses/*.json` (`<= 7d` TTL).
  - Byte-frozen **Zone A** static prefix (UTF-8 no BOM, NFC, LF-only, ASCII `(priorityRank ASC, id ASC)` sort, zero volatile metadata) separated from uncached **Zone B** cited tail (`Based on: <claim_id> (<env>@<sha>)`) via `<!-- VERIBRAIN:ZONE_BOUNDARY:A_END -->`.
  - Fail-closed exit codes (`0` ok, `1` error/eval fail, `2` quarantine violation, `3` P0/P1 budget infeasible, `4` provenance violation) and deterministic Zone B eviction (`hypotheses -> oldest scars -> P2 observed`) with `[EVICTED: <id>, reason=token_budget]` notices.
  - Linear-time PII, secret, and Shannon-entropy quarantine scrubber with zero raw secret echo (`<redacted-claim-id>`, `<redacted-field>`), dual raw + NFKC/zero-width/bidi/Unicode-Tag reassembly detection, decoded JSON string re-scan, and `<untrusted_hint ... non_authoritative="true">` sandboxing.
  - CLI commands: `veribrain init`, `veribrain compile`, `veribrain observe` (atomic temp-to-rename write with anti-self-attestation guard), `veribrain eval [--strict]`, and 1-screen `veribrain diff` (`<= 5` bullets, `<= 25` lines, `<= 80` ASCII cols).
  - Stat-validated raw-UTF-8-bytes read cache (`(dev, ino, size, mtimeMs, ctimeMs)` + `50 ms` freshness guard; zero caching of parsed records or quarantine verdicts) achieving `5.67–12.62 ms` warm p95 compile latency.
- **Stage 2 — Empirical Wind Tunnel & Live Gemini 4 Calibration:**
  - Reproducible `$0` 129-case Red-Team Wind Tunnel (`125` attacks + `4` clean controls across 7 families) passing `129/129` (`0%` policy escape, `0` canary leaks) and fixing prefixed-secret lookbehind, JSON object-key zero-echo redaction, and duplicate-frontmatter classification.
  - Live `gemini-4-hydrogen` `countTokens` calibration across 9 payload classes (`+21.4%` safe conservative headroom on full Two-Zone payloads) and stateful 6-turn implicit KV-cache A/B proof (`73.13%` T2–T6 avg / `75.04%` peak vs. `0.0%` naive dynamic header; `$0.4851` total live calibration spend).
  - Google Colab non-LLM offline structural grounding notebook (`10/10` VeriBrain vs. `6/10` flat dump vs. `1/10` stale RAG).
- **Stage 3 — Cross-Client Local `stdio` MCP Server:**
  - Local `stdio` MCP server (`veribrain mcp`) built on `@modelcontextprotocol/sdk` (`1.32.2`) and `zod` (`4.6.7`), lazily imported ONLY on MCP server invocations so non-MCP CLI commands incur zero MCP startup cost.
  - Five RFC-001 tools with strict read-only vs. Tier 3 boundaries: `veribrain_compile_context`, `veribrain_get_claim`, `veribrain_record_hypothesis`, `veribrain_propose_scar`, and `veribrain_status`.
  - Cross-client `--print-config` generator (`antigravity`, `claude-code`, `cursor`, `codex`) and setup guide in `docs/mcp-clients.md` (covering POSIX, Windows `cmd /c npx`, and local clone execution).
  - Hardened `.brain/hypotheses/` exact-directory symlink confinement, `<= 4,096 B` hypothesis hint cap, `<= 32` roles cap, `<= 64`-char `HYP-*` ID limit, and top-level `observed/*.json`-only hash-ref exemption (`P2-G2-1`).
- **Stage 4 — Open-Source `v1.0.0` Release Hardening:**
  - Aligned package, CLI (`--version`), and MCP server metadata at `1.0.0`, pinned `@types/node` to Node 24 LTS (`24.19.4`), added npm package discovery metadata (`keywords`, `repository`, `homepage`, `bugs`), and shipped `README.md`, `CHANGELOG.md`, and `CONTRIBUTING.md`.
