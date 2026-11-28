# VeriBrain — Active Quality Gate & Defect Register

- **Owner:** Chief Quality Engineer (CQE) · **Release Baseline:** `PRG-4` (`v1.4.0`, `2026-11-28`)
- **Separation of Duties:** CQE owns `QUALITY.md`, Golden Context Eval verification (`tests/golden/**`), Stage 2 Colab benchmarks, and developer personas (`docs/qa-user-personas.md`); NEVER edits `src/**`, `tests/unit/**`, or `benchmarks/**`.

## 1. Release Gate Bar (`v1.4.0`)
- **Automated CI (Node 24):** `npm audit --omit=dev`, `npx tsc --noEmit`, `npm run lint` (`0` warnings), `npm run build`, `npm test` (`23/23` Vitest Golden + Unit suites), Linux `RT-PRV-18` symlink red-team gate (`129/129`), `dist/cli.js` LF shebang check, `veribrain eval --strict`, `veribrain check-citations`, `npm publish --dry-run` (`0` warnings), and `bootstrap_startup.py --verify .`.
- **Verification Pillars:**
  1. **5 `$0` Golden Context Evals (`eval-1..5`):** Byte-identical Zone A prefix SHA-256; zero silent `P0`/`P1` truncation (`exit 3`); stale `(env, git_sha, ttl)` exclusion; fail-closed PII/secret quarantine (`exit 2`); `<untrusted_hint>` injection containment.
  2. **Stage 2 Wind Tunnel (`stage2-wind-tunnel.test.ts`):** Warm compile `p95 < 15 ms`, `129/129` red-team (`0%` escape, `0` leaks), Gemini 4 AI Studio dry-run, `3` SVGs, nbformat 4 Colab audit (`10/10`).
  3. **Stage 3–4 Local `stdio` MCP & `PRG-1`/`PRG-2` (`mcp-stdio.test.ts`, `prg1`–`prg2`):** Real `stdio` JSON-RPC (`7` tools), `decide`/`sign`/`promote`, `Zone A0+A1`, `attest-test`, `check-citations`, `env-ttl`, `retro`, tier-aware `diff`.
  4. **PRG-3 `$0` ROI Telemetry (`prg3-v1.3.test.ts`, `prg3-stats.test.ts`):** Opt-in default-off `.brain/.metrics.jsonl`, CLI+MCP source tagging, `stats` + `veribrain_stats` (`7th` tool), symlink/mirror/quarantine safety, self-healing compaction.
  5. **PRG-4 Guided Maturity (`prg4-v1.4.test.ts`, `prg4-doctor.test.ts`):** Strictly read-only `veribrain doctor` (full-tree SHA-256 invariance), `8` deterministic checks, `L0`–`L4` rubric, pre-read tier confinement (`Exit 4`), `< 4,096 B` strict scars gate, `<= 30`-line / `<= 80`-col wrapped ASCII output.

## 2. PRG-4 (`v1.4.0` · `PM-702`) Verification Sign-Off (`2026-11-28` — Verdict: `PASS`)

| Check / Suite | Verdict | Observed Evidence |
|---|---|---|
| Typecheck & Lint (`tsc`, `biome`) | `PASS` | `npx tsc --noEmit` (`0` errors), `npm run lint` (`49` files, `0` errors/warnings). |
| Full Vitest Suite (`npm test`) | `PASS` | `23/23` test files passed, `90/90` tests passed (`prg4-doctor.test.ts` `6/6`, `prg4-v1.4.test.ts` `1/1`, `cli-diff.test.ts` `3/3`). |
| PRG-4 Golden & Unit Suites | `PASS` | Proved zero-mutation tree SHA-256 (w/ `metrics.enabled: true`), `L0`–`L4` boundary fixtures (`1023`/`1024` Zone A0 tok, `3276`/`3277`/`4096 B` scars, hook-only `L3`, expired `OBSERVED`), pre-read symlink confinement (`P1-PRG4-1..3`, `P2-PRG4-1`), `.brain/` `Exit 2` rethrow, flag quarantine precedence, oversized/corrupt `.metrics.jsonl` handling, mirror `eval.strict`, and `doctor --help` `Exits:`. |
| Red-Team & Dogfood Checks | `PASS` | `run_redteam.mjs` `129/129` (`0%` escape, `0` leaks); `eval --strict`, `check-citations`, and `doctor` `exit 0`. |

## 3. Closed Gate Sign-Off History (`Gates 1–4` & `PRG-1`–`PRG-3`)
- **PRG-3 (`v1.3.0` — `PASS`, `2026-11-28`):** `21/21` suites (`83/83`), `129/129` red-team, `6/6` Chiefs (`0` open `P0`–`P2`), live at `6d8b90c` + tag `v1.3.0` + `veribrain@1.3.0` on npm (`main` ff pending).
- **PRG-2 (`v1.2.0` — `PASS`, `2026-11-27`):** `19/19` suites (`77/77`), `129/129` red-team, `6/6` Chiefs (`0` open `P0`–`P3`), live at `4aab244` + GitHub/npm `v1.2.0`.
- **PRG-1 (`v1.1.0` — `PASS`, `2026-11-26`):** `17/17` suites (`67/67`), `129/129` red-team, `6/6` Chiefs, `15/15` Security findings closed, live at `7d51715` + npm `v1.1.0`.
- **Gates 1–4 (`v1.0.0` — `PASS`, `2026-11-25`):** `15/15` suites (`56/56`), Linux `RT-PRV-18` Run `45621060408`, warm `p95=5.67–12.62 ms`, Gemini 4 KV-cache `73.13%` T2–T6 / `75.04%` peak.

## 4. Active Defect Register (`0` Open Defects)

| ID | Pri | Surface / Eval | Status | Summary / Pointer |
|---|---|---|---|---|
| **DEF-001** | `P1` | `loadBrain` / `compileContext` (`< 15 ms` p95) | `VERIFIED_CLOSED` | Stat-validated read cache + `--no-file-parallelism`: warm MCP `p95=4.728 ms`, latency bench `p95 < 15 ms`. |
| **DEF-002** | `P1` | `expandSubCandidates` (`src/quarantine.ts`) | `VERIFIED_CLOSED` | Splitting on `/[&:@]/` closes prose hash bypass while preserving validated `evidence_ref` allowlist (`eval-4` `12/12`). |
| **P2-G2-1** | `P2` | `scanDecodedJsonStrings` (`src/schema.ts`) | `VERIFIED_CLOSED` | Hash-ref exemption scoped strictly to top-level `observed/*.json` `evidence_ref` (`depth===1`). |
