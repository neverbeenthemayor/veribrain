# VeriBrain — Active Quality Gate & Defect Register

- **Owner:** Chief Quality Engineer (CQE) · **Release Baseline:** `PRG-3` (`v1.3.0`, `2026-11-28`)
- **Separation of Duties:** CQE owns `QUALITY.md`, Golden Context Eval verification (`tests/golden/**`), Stage 2 Colab benchmarks, and developer personas (`docs/qa-user-personas.md`); NEVER edits `src/**`, `tests/unit/**`, or `benchmarks/**`.

## 1. Release Gate Bar (`v1.3.0`)
- **Automated CI (Node 24):** `npm audit --omit=dev`, `npx tsc --noEmit`, `npm run lint` (`0` warnings), `npm run build`, `npm test` (`21/21` Vitest Golden + Unit suites), Linux `RT-PRV-18` symlink red-team gate (`129/129`), `dist/cli.js` LF shebang check, `veribrain eval --strict`, `veribrain check-citations`, `npm publish --dry-run` (`0` warnings), and `bootstrap_startup.py --verify .`.
- **Verification Pillars:**
  1. **5 `$0` Golden Context Evals (`eval-1..5`):** Byte-identical Zone A prefix SHA-256; zero silent `P0`/`P1` truncation (`exit 3`); stale `(env, git_sha, ttl)` exclusion; fail-closed PII/secret quarantine (`exit 2`, zero echo); `<untrusted_hint>` injection containment.
  2. **Stage 2 Wind Tunnel (`stage2-wind-tunnel.test.ts`):** Warm compile `p95 < 15 ms`, `129/129` red-team (`0%` escape, `0` leaks), Gemini 4 AI Studio dry-run (`Arm A 0/6` vs `Arm B 6/6`), `3` SVGs, nbformat 4 Colab audit (`10/10`).
  3. **Stage 3–4 Local `stdio` MCP & `PRG-1` (`mcp-stdio.test.ts`, `prg1-customer-zero.test.ts`):** Real `node ./dist/cli.js mcp` JSON-RPC (`7` tools), `decide`/`sign`/`promote`, worktree `.brain/`, `lint-text`, safe URLs, and `hooks install`.
  4. **PRG-2 Governance & Caching (`prg2-v1.2.test.ts`, `prg2-commands.test.ts`):** `8`-role `Zone A0` byte-identity (`schema_version: "1.1"`/`split`) + `"1.0"` invariance, `attest-test`, `check-citations`, `env-ttl`, `retro`, and tier-aware `diff`.
  5. **PRG-3 `$0` ROI Telemetry (`prg3-v1.3.test.ts`, `prg3-stats.test.ts`):** Opt-in default-off `.brain/.metrics.jsonl`, CLI + MCP source tagging, `veribrain stats` & MCP `veribrain_stats` (`7th` tool), symlink/mirror/quarantine safety, self-healing tail compaction, and adjacent `lastRoleByA0Hash` handoff math.

## 2. PRG-3 (`v1.3.0` · `PM-701`) Verification Sign-Off (`2026-11-28` — Verdict: `PASS`)

| Check / Suite | Verdict | Observed Evidence |
|---|---|---|
| Typecheck & Lint (`tsc`, `biome`) | `PASS` | `npx tsc --noEmit` (`0` errors), `npm run lint` (`46` files, `0` errors/warnings). |
| Full Vitest Suite (`npm test`) | `PASS` | `21/21` test files passed, `83/83` tests passed (`prg3-stats.test.ts` `5/5`, `prg3-v1.3.test.ts` `1/1`, `mcp-stdio.test.ts` `2/2`, `mcp.test.ts` `4/4`). |
| PRG-3 Golden & Unit Suites | `PASS` | Verified opt-in disabled default, CLI+MCP recording, symlink-ancestor `--brain-dir` `Exit 4` (`P1-PRG3-1`), `lstatSync(repoRoot)` (`P2-PRG3-1`), `stats --enable`/`--disable` + `eval --strict --check-mirror` (`P2-PRG3-2`), secret `--since` `Exit 2` in CLI & MCP, adjacent `zone_a0_cross_role_hits`, bounded `1e308` rejection, corrupt-line compaction heal, and `<= 80`-col ASCII output. |
| Red-Team & Dogfood Checks | `PASS` | `run_redteam.mjs` `129/129` (`0%` escape, `0` leaks); `eval --strict` `exit 0`; `check-citations` `exit 0` (`35` files, `0` drift); `stats --format text` `exit 0`. |

## 3. Closed Gate Sign-Off History (`Gates 1–4`, `PRG-1` & `PRG-2`)
- **PRG-2 (`v1.2.0` — `PASS`, `2026-11-27`):** `19/19` suites (`77/77`: `prg2-v1.2` `5/5`, `prg2-commands` `5/5`), `129/129` red-team, `6/6` Chiefs (`0` open `P0`–`P3`), live `4aab244` across `pre-staging`/`staging`/`main` + `v1.2.0` GitHub/npm release.
- **PRG-1 (`v1.1.0` — `PASS`, `2026-11-26`):** `17/17` suites (`67/67`), `129/129` red-team, `6/6` Chiefs, `15/15` Security findings closed, published on GitHub & npm (`7d51715`).
- **Gate 4 (`PM-403`, `v1.0.0` — `PASS`, `2026-11-25`):** `15/15` suites (`56/56`), `11/11` tarball checks (`50,802 B`, LF shebang), Linux `RT-PRV-18` CI gate verified.
- **Gate 3 (`PM-304` — `PASS`, `2026-11-25`):** Real `stdio` MCP (`0` stdout pollution, `20/20` Zone A identity, warm `p95=4.728 ms`), Tier 3 confinement, `P2-G2-1` closure.
- **Gate 2 (`PM-205` — `PASS`, `2026-11-25`):** Latency bench `45` files (`5,867` Zone A tok, warm `p95=12.622 ms`, `100/100` hash), red-team `129/129`, AI Studio dry-run `Arm A 0/6` vs `Arm B 6/6` (`$0.00`), `3` SVGs + Colab audit.
- **Gate 1 (`PM-105` — `PASS`, `2026-11-25`):** `5` `$0` Golden Evals, read-only shadow-compile (`0` mutation), 39-file standalone `p95=5.67 ms`.

## 4. Active Defect Register (`0` Open Defects)

| ID | Pri | Surface / Eval | Status | Summary / Pointer |
|---|---|---|---|---|
| **DEF-001** | `P1` | `loadBrain` / `compileContext` (`< 15 ms` p95) | `VERIFIED_CLOSED` | Stat-validated read cache + `--no-file-parallelism`: 39-file `p95=5.67 ms`, 45-file `p95=12.622 ms`, warm MCP `p95=4.728 ms`. |
| **DEF-002** | `P1` | `expandSubCandidates` (`src/quarantine.ts`) | `VERIFIED_CLOSED` | Splitting on `/[&:@]/` closes prose hash bypass while preserving validated `evidence_ref` allowlist (`eval-4` `12/12`). |
| **P2-G2-1** | `P2` | `scanDecodedJsonStrings` (`src/schema.ts`) | `VERIFIED_CLOSED` | Hash-ref exemption scoped strictly to top-level `observed/*.json` `evidence_ref` (`depth===1`). |
