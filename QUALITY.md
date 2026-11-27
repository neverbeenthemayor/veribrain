# VeriBrain — Active Quality Gate & Defect Register

- **Owner:** Chief Quality Engineer (CQE) · **Release Baseline:** `PRG-2` (`v1.2.0`, `2026-11-27`)
- **Separation of Duties:** CQE owns `QUALITY.md`, Golden Context Eval verification (`tests/golden/**`), Stage 2 Colab benchmarks, and developer personas (`docs/qa-user-personas.md`); NEVER edits `src/**`, `tests/unit/**`, or `benchmarks/**`.

## 1. Release Gate Bar (`v1.2.0`)
- **Automated CI (Node 24):** `npm audit --audit-level=high`, `npx tsc --noEmit`, `npm run lint` (`0` warnings), `npm run build`, `npm test` (`19/19` Vitest Golden + Unit suites), Linux `RT-PRV-18` symlink red-team gate (`129/129`), `dist/cli.js` LF shebang check, `veribrain eval --strict`, `veribrain check-citations`, `npm pack --dry-run`, and `bootstrap_startup.py --verify .`.
- **Verification Pillars:**
  1. **5 `$0` Golden Context Evals (`eval-1..5`):** Byte-identical Zone A prefix SHA-256; zero silent `P0`/`P1` truncation (`exit 3`); stale `(env, git_sha, ttl)` exclusion; fail-closed PII/secret quarantine (`exit 2`, zero echo); `<untrusted_hint>` injection containment.
  2. **Stage 2 Wind Tunnel (`stage2-wind-tunnel.test.ts`):** Warm compile `p95 < 15 ms`, `129/129` red-team (`0%` escape, `0` leaks), Gemini 4 AI Studio dry-run (`Arm A 0/6` vs `Arm B 6/6`), `3` SVGs, nbformat 4 Colab audit (`10/10`).
  3. **Stage 3–4 Local `stdio` MCP & `PRG-1` (`mcp-stdio.test.ts`, `prg1-customer-zero.test.ts`):** Real `node ./dist/cli.js mcp` JSON-RPC (`6` tools), `decide`/`sign`/`promote`, worktree `.brain/`, `lint-text`, safe URLs, and `hooks install`.
  4. **PRG-2 Governance & Constitutional Caching (`prg2-v1.2.test.ts`, `prg2-commands.test.ts`):** `8`-role `Zone A0` byte-identity (`schema_version: "1.1"`/`split`) + `"1.0"` invariance, `attest-test` `shell: false` & raw pre-truncation quarantine, `check-citations` repo confinement & drift checks, `env-ttl` (`<= 7d`), `retro` MD/JSON audit, and tier-aware `diff` labels & slugs.

## 2. PRG-2 (`v1.2.0` · `PM-601–PM-605`) Verification Sign-Off (`2026-11-27` — Verdict: `PASS`)

| Check / Suite | Verdict | Observed Evidence |
|---|---|---|
| Typecheck & Lint (`tsc`, `biome`) | `PASS` | `npx tsc --noEmit` (`0` errors), `npm run lint` (`42` files, `0` errors/warnings). |
| Full Vitest Suite (`npm test`) | `PASS` | `19/19` test files passed, `77/77` tests passed (`vitest run --no-file-parallelism`: `37` unit + `40` golden tests). |
| PRG-2 Golden Suite (`prg2-v1.2.test.ts`) | `PASS` | `5/5` passed: `8`-role `Zone A0` byte-identity (`zone_a0_sha256` identical across `cpm`, `builder`, `cqe`, `security`, `cude`, `cie`, `cfoe`, `bench`) + real `stdio` MCP `1.2.0` split identity + legacy `"1.0"` zero drift; `attest-test` receipt passing `eval --strict` + raw secret `--dry-run` `Exit 2` + `Exit 4` agent denial; `check-citations` drift kinds & traversal `Exit 4`; `env-ttl` cross-commit & env isolation; tier-aware `diff` & `retro`. |
| PRG-2 Command Unit Suite (`prg2-commands.test.ts`) | `PASS` | `5/5` passed incl. `P1-PRG2-1..3` / `P2-PRG2-1..2` / `P3-PRG2-2` regressions: pre-truncation secret block, Windows `npm-cli.js`, `--timeout 100` `Exit 1`, `../outside` `Exit 4` non-echo, oversized root `> 512 KB` `Exit 1`, symlink `.brain/observed` `Exit 4`, split `Exit 3`, `> 32` retro roles `Exit 1`, zero contiguous secret literals (`P3-1`). |
| Red-Team Wind Tunnel (`run_redteam.mjs`) | `PASS` | `129/129` passed (`100%`: `125` attacks + `4` clean controls); `0%` policy escape, `0` canary leaks. |
| Dogfood Checks (`dist/cli.js`) | `PASS` | `eval --strict` `exit 0` (`decided=1 observed=0 hyp=0 scars=0 (246/4096 B)`); `check-citations` `exit 0` (`35` files, `3` citations, `0` drift); `retro --since 7d --format md` `exit 0`. |

## 3. Closed Gate Sign-Off History (`Gates 1–4` & `PRG-1`)
- **PRG-1 (`v1.1.0` — `PASS`, `2026-11-26`):** `17/17` suites (`67/67`), `129/129` red-team, `6/6` Chiefs, `15/15` Security findings closed, Customer-Zero live MCP zero-regression, published on GitHub & npm.
- **Gate 4 (`PM-403`, `v1.0.0` — `PASS`, `2026-11-25`):** `15/15` suites (`56/56`), `11/11` `veribrain-1.0.0.tgz` checks (`50,802 B`, LF shebang), Linux `RT-PRV-18` CI gate verified.
- **Gate 3 (`PM-304` — `PASS`, `2026-11-25`):** Real `stdio` MCP (`0` stdout pollution, `20/20` Zone A identity, warm `p95=4.728 ms`), Tier 3 confinement, `P2-G2-1` closure.
- **Gate 2 (`PM-205` — `PASS`, `2026-11-25`):** Latency bench `45` files (`5,867` Zone A tok, warm `p95=12.622 ms`, `100/100` hash), red-team `129/129`, AI Studio dry-run `Arm A 0/6` vs `Arm B 6/6` (`$0.00`), `3` SVGs + Colab audit.
- **Gate 1 (`PM-105` — `PASS`, `2026-11-25`):** `5` `$0` Golden Evals, read-only shadow-compile (`0` mutation), 39-file standalone `p95=5.67 ms`.

## 4. Active Defect Register (`0` Open Defects)

| ID | Pri | Surface / Eval | Status | Summary / Pointer |
|---|---|---|---|---|
| **DEF-001** | `P1` | `loadBrain` / `compileContext` (`< 15 ms` p95) | `VERIFIED_CLOSED` | Stat-validated read cache + `--no-file-parallelism`: 39-file `p95=5.67 ms`, 45-file `p95=12.622 ms`, warm MCP `p95=4.728 ms`. |
| **DEF-002** | `P1` | `expandSubCandidates` (`src/quarantine.ts`) | `VERIFIED_CLOSED` | Splitting on `/[&:@]/` closes prose hash bypass while preserving validated `evidence_ref` allowlist (`eval-4` `12/12`). |
| **P2-G2-1** | `P2` | `scanDecodedJsonStrings` (`src/schema.ts`) | `VERIFIED_CLOSED` | Hash-ref exemption scoped strictly to top-level `observed/*.json` `evidence_ref` (`depth===1`). |
