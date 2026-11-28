# Brief: PM-702 (`PRG-4` · `v1.4.0` — `veribrain doctor` Guided Maturity Report)

- **Gate:** Post-Release Gate 4 (`PRG-4`, `v1.4.0`, release train `pre-staging` -> `staging` -> `main`)
- **Feature:** `PM-702` (`veribrain doctor`, read-only CLI + library export)
- **Story Points & Priority:** `3 pts` · `P1` · **ICE:** `0.80` (`4 x 5 x 5 / 125`)
- **Deferred:** `PM-703` (`stats --repos`, `3 pts`, `PROPOSED`) and `PM-505` (calibrated tokenizer profiles, `3 pts`, `PARKED`) are NOT built in this wave.
- **Owners:** Author: `Builder` · Verifiers: `Security`, `CQE`, `CIE`, `CUDE`, `Bench`, `CFOE` (zero self-verification)

---

## 1. Customer Problem

Customer-Zero reached Tier 1 (`DECIDED` rules, split `Zone A0`) and Tier 3 (first scar) but Tier 2 (`OBSERVED`) stays empty and telemetry is off. Adopters have no single command that says where their `.brain/` stands and exactly which human commands to run next.

## 2. Requirements

### A. Command & Safety
- `veribrain doctor [--format text|md|json] [--role <role>] [--env <env>] [--strict] [--brain-dir <dir>] [--repo-root <dir>]` (defaults: role `builder`, env `local`, format `text`).
- **Strictly read-only:** zero writes, mkdir, unlink, subprocess, or network. Any `compileContext` call passes `recordMetrics: false`. Allowed in agent mode (no `Exit 4` agent refusal).
- **Confinement:** `lstatSync(repoRoot)` before `realpathSync` (symlink/non-directory -> `Exit 4`, missing -> `Exit 1`), UNC/blocked/isolation rejection, repo-relative paths only, zero out-of-repo path echo.
- **Quarantine:** raw `--role`/`--env`/`--format` values quarantine-checked before validation (`Exit 2`, zero reflection); rendered output of every format passes `assertQuarantineClean` (`Exit 2`).

### B. Deterministic Checks (`{ id, tier, status: PASS|WARN|FAIL|INFO, summary, fix[] }`)
`brain.present`, `eval.strict`, `tier1.decided`, `zone_a0.floor` (`>= 1024` tok in split), `tier2.observed` (+ managed pre-commit hook detection), `tier3.scars` (budget, expiry, regression-test links, pending proposals), `tier3.hypotheses`, `telemetry.stats`. Fix hints use placeholders only (never concrete claim IDs).

### C. Maturity & Exit Codes
- Maturity `L0`–`L4`: L0 no brain / eval fail; L1 eval pass + decided; L2 + split `Zone A0 >= 1024` tok; L3 + (observed or managed hook); L4 + scar with all tests present + telemetry enabled.
- Exit `0` when no `FAIL`; `1` on any `FAIL`; `--strict` also `1` on any `WARN`; `2` quarantine; `4` confinement.

### D. UX & Release Parity
- `--format text` `<= 30` lines, `<= 80` cols, plain ASCII. `doctor --help` `<= 12` lines. Global `--help` stays `<= 20` lines via a single combined `eval / doctor` line.
- Bump to `1.4.0` (`package.json`, `package-lock.json`, CLI, MCP metadata); MCP stays `7` tools; zero new runtime deps; `/src/commands/doctor.ts` in `CODEOWNERS`; `npm publish --dry-run` with `0` warnings.

## 3. Acceptance Bar
1. `npm run build && npm run typecheck && npm run lint && npm test` green; `129/129` red-team; `eval --strict`, `check-citations`, `doctor` exit `0`.
2. Read-only proof: full repo-tree hash identical before/after `doctor` (including with metrics enabled).
3. `6/6` Chief sign-off with `0` open `P0`–`P2`.
