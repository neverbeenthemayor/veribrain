# VeriBrain — Active Quality Gate & Defect Register

- **Owner:** Chief Quality Engineer (CQE) · **Release Baseline:** `PRG-1` (`v1.1.0`, `2026-11-26`)
- **Separation of Duties:** CQE owns `QUALITY.md`, Golden Context Eval verification (`tests/golden/**`), Stage 2 Colab benchmarks, and developer personas (`docs/qa-user-personas.md`); NEVER edits `src/**`, `tests/unit/**`, or `benchmarks/**`.

## 1. Release Gate Bar (`v1.1.0`)
- **Automated CI (Node 24):** `npm audit --audit-level=high`, `npx tsc --noEmit`, `npm run lint` (`0` warnings), `npm run build`, `npm test` (`17/17` Vitest Golden + Unit suites), Linux `RT-PRV-18` symlink red-team gate (`129/129`), `dist/cli.js` LF shebang check, `veribrain eval --strict`, `npm pack --dry-run`, and `bootstrap_startup.py --verify .`.
- **Verification Pillars:**
  1. **5 `$0` Golden Context Evals (`eval-1..5`):** Byte-identical Zone A prefix SHA-256; zero silent `P0`/`P1` truncation (`exit 3`); stale `(env, git_sha, ttl)` exclusion; fail-closed PII/secret quarantine (`exit 2`, zero echo, `<redacted-claim-id>`); indirect prompt-injection containment inside `<untrusted_hint ... non_authoritative="true">`.
  2. **Stage 2 Wind Tunnel (`stage2-wind-tunnel.test.ts`):** Warm compile `p95 < 15 ms` (Zone A `>= 4,096` tok), `129/129` red-team attacks (`0%` escape, `0` canary leaks), Gemini 4 AI Studio dry-run (`Arm A 0/6` vs `Arm B 6/6`), `3` SVGs, nbformat 4 Colab audit.
  3. **Stage 3–4 Local `stdio` MCP & Packaging (`mcp-stdio.test.ts`):** Real `node ./dist/cli.js mcp` JSON-RPC over `StdioClientTransport`, all `6` tools (incl. `veribrain_list_claims`), `< 15 ms` warm compile, Tier 3 `.brain/hypotheses/` confinement, `P2-G2-1` closure, clean tarball.
  4. **PRG-1 Customer-Zero Governance (`prg1-customer-zero.test.ts`):** Human-only `decide`/`sign` + mirror sync & drift checks, `promote` (scar + decided), pure-fs worktree `.brain/` discovery + JSON included IDs, `lint-text` + safe URL hostnames + friendly `--env` hints, and `hooks install` + `--print-ci`.

## 2. PRG-1 (`v1.1.0` · `PM-501–PM-504` Pre-Public Generalization) Verification Sign-Off (`2026-11-26` — Verdict: `PASS`)

| Check / Suite | Verdict | Observed Evidence |
|---|---|---|
| Typecheck & Lint (`tsc`, `biome`) | `PASS` | `npx tsc --noEmit` (`0` errors), `npm run lint` (`37` files, `0` errors/warnings). |
| Full Vitest Suite (`npm test`) | `PASS` | `17/17` test files passed, `67/67` tests passed (`vitest run --no-file-parallelism`: `32` unit + `35` golden tests). |
| Updated Stdio MCP Suite (`mcp-stdio.test.ts`) | `PASS` | `2/2` passed over real `dist/cli.js mcp` `StdioClientTransport`: asserts all `6` tools incl. `veribrain_list_claims` (`readOnlyHint`, `idempotentHint`, tier/prefix/role/limit filtering, `DEC-001` `"*"` wildcard matching `cpm`, XML-escaped `<untrusted_hint ... non_authoritative="true">` wrapping for scar/hyp summaries per `P1-PRG1-4`, secret prefix quarantine), `included_decided_ids`/`included_observed_ids`, `0` stdout pollution. |
| PRG-1 Golden Suite (`prg1-customer-zero.test.ts`) | `PASS` | `5/5` passed on real `dist/cli.js` + public exports (incl. `P1-PRG1-1..8` security & `VERIBRAIN_ISOLATION_SEGMENTS` regressions): `PM-501` (`decide`/`sign`, `--mirror-dir`, `eval --check-mirror` parity & drift, `exit 4` NFKC/delimiter `isAgentSigner` + `VERIBRAIN_ISOLATION_SEGMENTS` (`isolated-app`, `isolated-app-pm503`) + UNC `\\\\`/`//` mirror refusal, `exit 2` secret refusal, `init` `"*"` wildcard), `PM-502` (`promote` scar & decided, `--dry-run`, `< 4,096 B` cap, `HYP-*.json` cleanup, duplicate `DEC-*` refusal, post-eval rollback guard, `exit 4`/`exit 2`), `PM-503A` (non-symlink real `.git` metadata `HEAD`/`objects/`/`config` worktree guard + JSON included IDs preserving `zone_a_sha256`), `PM-503B` (`lint-text`, `isSafeHostnameToken` split-segment/case-insensitive secret blocks, `--env production` hint), `PM-504` (`hooks install` standard/worktree/non-clobber/`--force` + `--print-ci`). |
| Red-Team Wind Tunnel (`run_redteam.mjs`) | `PASS` | `129/129` passed (`100%`: `125` attacks + `4` clean controls across all `7` families); `0` policy poisoning escapes (`0%`), `0` secret canary leaks. |
| Repo Strict Eval (`dist/cli.js eval --strict`) | `PASS` | `exit 0` (`eval ok: decided=1 observed=0 hyp=0 scars=0 (246/4096 B)`). |

## 3. Closed Gate Sign-Off History (Gates 1–4)
- **Gate 4 (`PM-403`, `v1.0.0` — `PASS`, `2026-11-25`):** `15/15` suites (`56/56`), `11/11` fresh-user `veribrain-1.0.0.tgz` tarball checks (`50,802 B`, LF shebang), Linux `RT-PRV-18` CI gate verified.
- **Gate 3 (`PM-304` — `PASS`, `2026-11-25`):** Real `stdio` MCP (`0` stdout pollution, `20/20` Zone A identity, warm `p95=4.728 ms`), Tier 3 confinement, `P2-G2-1` closure.
- **Gate 2 (`PM-205` — `PASS`, `2026-11-25`):** Latency bench `45` files (`5,867` Zone A tok, warm `p95=12.622 ms`, `100/100` hash), red-team `129/129`, AI Studio dry-run `Arm A 0/6` vs `Arm B 6/6` (`$0.00`), `3` SVGs + nbformat 4 Colab audit.
- **Gate 1 (`PM-105` — `PASS`, `2026-11-25`):** `5` `$0` Golden Evals, read-only shadow-compile (`0` source mutation, `0` Customer-Zero external-repo writes), 39-file standalone `p95=5.67 ms`.

## 4. Active Defect Register (`0` Open Defects)

| ID | Pri | Surface / Eval | Status | Summary / Pointer |
|---|---|---|---|---|
| **DEF-001** | `P1` | `loadBrain` / `compileContext` (`< 15 ms` p95) | `VERIFIED_CLOSED` | Stat-validated read cache + `--no-file-parallelism`: 39-file `p95=5.67 ms`, 45-file `p95=12.622 ms`, warm MCP `p95=4.728 ms`. |
| **DEF-002** | `P1` | `expandSubCandidates` (`src/quarantine.ts`) | `VERIFIED_CLOSED` | Splitting on `/[&:@]/` closes prose `staging@<40hex>` bypass while preserving validated `evidence_ref` allowlist (`eval-4` `12/12`). |
| **P2-G2-1** | `P2` | `scanDecodedJsonStrings` (`src/schema.ts`) | `VERIFIED_CLOSED` | Hash-ref exemption scoped strictly to top-level `observed/*.json` `evidence_ref` (`depth===1`); nested/config/hypothesis bypasses blocked. |
