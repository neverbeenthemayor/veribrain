# VeriBrain — Closed Gate Archive: Post-Release Gate 1 (`PRG-1` · `v1.1.0`)

- **Gate:** `Post-Release Gate 1 (PRG-1)` · **Release Tag:** `v1.1.0` (`2026-11-26`)
- **Point Budget:** `18 / 20 pts` (`<= 20-pt` weekend wave cap)
- **Customer-Zero Intake Source:** [Customer-Zero Feedback Log](../feedback/customer-zero-feedback-log.md) (`HYP-PP-FB-20261126-AUTH`, `HYP-PP-FB-20261126-FIELD`, `HYP-PP-FB-20261126-INNOV`)
- **Feature Brief:** [`PM-501-504-prg1-customer-zero.md`](../briefs/PM-501-504-prg1-customer-zero.md)

## 1. Delivered Scope (`PM-501`–`PM-504`)

| ID | Story | Pts | Status | Verified Summary |
|---|---|---:|---|---|
| **PM-501** | `veribrain decide` / `sign` + Mirror Sync (`--check-mirror`) + `init` `"*"` | `5` | `VERIFIED_CLOSED` | Human-only (`Exit 4` NFKC/delimiter-hardened) CLI author/signer with LF normalization, `sha256_body` hashing, confined `mirror_dirs` (blocks isolated prefixes configured via `VERIBRAIN_ISOLATION_SEGMENTS`, UNC/device paths `\\\\`/`//`, nested `.brain/`), `eval --check-mirror`, and starter `DEC-001` `"*"` wildcard. |
| **PM-502** | `veribrain promote <HYP-*>` Human Review CLI | `5` | `VERIFIED_CLOSED` | Human-only (`Exit 4`) scar & `DEC-*` promoter enforcing quarantine (`Exit 2`), `scars.md` symlink confinement & `< 4,096 B` cap, `roles` validation, duplicate `DEC-*` guard, atomic post-eval (`eval --strict`) rollback before mirror/unlink. |
| **PM-503** | Worktrees, `veribrain_list_claims`, `lint-text`, Safe URLs & JSON IDs | `5` | `VERIFIED_CLOSED` | Pure-fs `.git` worktree discovery (non-symlink `HEAD`/`objects/`/`config`), `included_decided_ids`/`included_observed_ids` preserving `zone_a_sha256`, 6th MCP tool `veribrain_list_claims` (`<untrusted_hint>` escaped), `isSafeHostnameToken` (aggregate split-segment entropy guard), `lint-text`, friendly `--env` hints. |
| **PM-504** | Pre-Commit & CI Git Hook Installer (`veribrain hooks install`) | `3` | `VERIFIED_CLOSED` | POSIX LF hooks (`pre-commit`, `post-checkout`, `post-merge`), broken-symlink confinement, `--print-ci` with `permissions: contents: read`, `concurrency`, `timeout-minutes: 5`, and `env:`-safe GitHub context vars. |

## 2. Unanimous `6/6` Independent Verification Sign-Off
- **CQE:** `PASS` (`17/17` Vitest files, `67/67` tests [`32` unit + `35` golden], `129/129` red-team, `eval --strict` exit `0`, `QUALITY.md` `5,891 B`).
- **Security:** `PASS / VERIFIED_CLOSED` (`0` open `P0`–`P3`; all `P1-PRG1-1..8`, `P2-PRG1-1..4`, `P3-PRG1-1..3` verified closed line-by-line).
- **CIE:** `PASS` (`veribrain-1.1.0.tgz` `42` files / `79.3 kB` packed, LF `#!/usr/bin/env node` shebang, CI aligned).
- **CUDE:** `PASS` (`0` `P0`–`P2` findings across `HELP_TEXT` `19L/74c`, `README.md`, `CHANGELOG.md`, `docs/mcp-clients.md`).
- **Bench:** `PASS` (`SCHEMA_VERSION = "1.0"`, `renderZoneA`, and `buildSemanticHash` byte-invariant).
- **CFOE:** `APPROVED` (`$0.00` incremental spend, `$0.4851 / $10.00` MTD, `7/7` active registers `< 8,192 B`).
- **Customer-Zero Regression (`customer-zero-mcp` read-only):** `healthy: true`, `eval_exit_code: 0`, `decided: 6`, `zone_a_sha256: da997a88f069e8276deb34b880b6674d3c80594e4f91c6d5e4307c4daa1c35da` (`0` diff).
