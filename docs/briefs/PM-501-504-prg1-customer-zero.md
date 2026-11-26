# Feature Brief: `PRG-1` (`v1.1.0`) — Customer-Zero DX & Governance Wave (`PM-501`–`PM-504`, `18/20 pts`)

- **Author:** VeriBrain CPM
- **Customer-Zero Driver:** Customer-Zero CPM (`HYP-PP-FB-20261126-AUTH`, `HYP-PP-FB-20261126-FIELD`, `HYP-PP-FB-20261126-INNOV`)
- **Authorization:** Ian Mayor (`GO` on `2026-11-26 18:02 PHT`) · **Branch:** `pre-staging` -> `staging` -> `main` (`v1.1.0`)
- **Hard Guardrails:**
  - `AGENTS.md` Rule #2 (`Author != Verifier`), Rule #3 (zero touches inside external isolated repositories), Rule #5 (registers `< 8,192 B` UTF-8 LF), Rule #6 (fail-closed human provenance & quarantine), zero incremental cost (`$0.00/mo`).
  - Zero breaking changes to `SCHEMA_VERSION` (`"1.0"`), `renderZoneA`, or `buildSemanticHash` formatting (`customer-zero-mcp` must compile `DEC-001`..`DEC-006` with zero regression).

---

## 1. Story Specs (`18/20 pts`)

### `PM-501` (`5 pts`) — `veribrain decide` / `veribrain sign` + Mirror Sync + `init` Wildcard
1. **Human Provenance Guard:** Enforce `issuer=human` & fail closed with `EXIT_PROVENANCE` (`4`) when called in agent mode (`VERIBRAIN_AGENT=1`, `--issuer agent|ci|git-hook`, etc.). Validate `signed_by` is present, non-empty, and never generic `"agent"`/`"unknown"`.
2. **`veribrain decide`:** Accept `--id DEC-NNN`, `--priority P0|P1|P2`, `--roles ...`, `--envs ...` (default `*`), `--signed-by ...`, `--supersedes ...` (optional), `--file <draft.md>` or `--body <text>`, plus optional `--mirror-dir <dir>` (repeatable). Normalize LF (`\n`), validate `title`/`status`/`DEC-NNN` (`assertValidClaimId`), scan with `assertQuarantineClean`, compute `sha256_body` via `computeDecidedBodyHash`, write `.brain/decided/<ID>.md`, and mirror `.brain/decided/<ID>.md` into validated mirror roots (`--mirror-dir` + `config.mirror_dirs`).
3. **`veribrain sign <path>`:** Accept a `.brain/decided/*.md` file inside repo root, normalize body LF, optionally set `--signed-by`, recompute `sha256_body`, pass quarantine, rewrite cleanly, and sync mirrors.
4. **Mirror Confinement & Drift Check:** Extend `BrainConfig` (`config.json`) with optional `mirror_dirs?: string[]`. Resolve paths cleanly, reject non-existent/non-directory/unsafe symlinked paths (including `VERIBRAIN_ISOLATION_SEGMENTS` / out-of-repo system paths if flagged, with explicit `mirror_dirs` validation), and add `veribrain eval --check-mirror` to compare byte-for-byte SHA-256 of `.brain/decided/*.md`, `.brain/scars.md`, `.brain/config.json` against configured mirrors.
5. **`init.ts` Fix:** Include `"*"` in starter `DEC-001` frontmatter `roles` (`["*", "builder", "cqe", "security", "cude", "cie", "cfoe"]`) so shared rules compile for `cpm` and custom roles out of the box.

### `PM-502` (`5 pts`) — `veribrain promote <HYP-ID>` Human Review CLI
1. **Human-Only Gate:** Fail closed with `EXIT_PROVENANCE` (`4`) under `VERIBRAIN_AGENT=1` or non-human flags.
2. **Reads `.brain/hypotheses/<HYP-ID>.json`** (validated via `assertValidClaimId`), scans content with `assertQuarantineClean` (`Exit 2`).
3. **Scar Promotion (`kind === "hypothesis_scar"` or `--to scar`):** Validate `regression_test` exists on disk under repo root, check current `.brain/scars.md` + formatted bullet size against `scars_max_bytes` (`4,096 B`), write updated `scars.md` atomically, sync configured mirrors, delete `.brain/hypotheses/<HYP-ID>.json`, and run `evaluateBrain` (`strict: true`).
4. **Decided Promotion (`--to decided`):** Require `--id DEC-NNN`, `--priority`, `--signed-by` (optional `--roles`, `--envs`, `--title`), build normalized Tier 1 `DEC-*` markdown with `sha256_body`, write `.brain/decided/<ID>.md` + mirrors, delete `.brain/hypotheses/<HYP-ID>.json`, and run `evaluateBrain` (`strict: true`). Supports `--dry-run` with zero writes.

### `PM-503` (`5 pts`) — Worktrees, `veribrain_list_claims`, `lint-text`, Safe URLs & JSON IDs
1. **Worktree `.brain/` Discovery:** Pure-filesystem resolution (`fs.statSync`/reading `.git` gitdir file & `commondir` up to 8 parent dirs — zero shell `exec` needed). If cwd has `.git` file (`gitdir: ...`) pointing to `<common>/.git/worktrees/<name>` and no local `.brain/`, fall back read-only to the primary repo `.brain/` (confined cleanly; disabled in `initBrain` via `allowWorktreeFallback = false`). Also support optional `--brain <dir>` explicit override if safe, and resolve worktree `.git/HEAD` for `git_sha`.
2. **`CompileResult` JSON IDs:** Add `included_decided_ids: string[]` and `included_observed_ids: string[]` to `CompileResult` returned by `compileContext()` without changing a single byte of `zone_a`, `zone_b`, or `zone_a_sha256`.
3. **6th MCP Tool (`veribrain_list_claims`):** Read-only MCP tool (`readOnlyHint: true`, `idempotentHint: true`) filtering by `tier?: "all" | "decided" | "observed" | "hypothesis" | "scar"`, `prefix?: string`, `role?: string`, `limit?: number` (capped `<= 100`), returning structured metadata (`id`, `kind`, `title`/`summary` scrubbed via `scanTextForQuarantine`, `issuer`, `priority`/`expires_at_utc`, `sha256_body` or `regression_test`) + total counts.
4. **Quarantine Hostname Exemption & `veribrain lint-text`:** Add `isSafeHostnameToken(token)` in `src/quarantine.ts` recognizing `https?://` URLs with hostname-like segments containing dots and hyphens (and zero auth/userInfo `@`, zero high-entropy query tokens `?token=...`), while failing closed on tokens containing `AIza`, `ghp_`, `sk-`, `AKIA`, `xoxb-`, `eyJ`, or long base64/hex secrets. Add `veribrain lint-text <file> [--format json|text]` dry-run quarantine explainer listing rule matches without touching `.brain/`.
5. **Friendly `--env` Hint:** When `invalid_env` occurs (e.g., `--env production` or `--env development`), include an explicit actionable fix hint (`Accepted envs: local, staging, prod. Map production -> prod, development -> local.`). Keep strict validation (zero silent acceptance of arbitrary strings, preserving existing golden tests!).

### `PM-504` (`3 pts`) — Pre-Commit & CI Git Hook Installer (`veribrain hooks install`)
1. Zero-dependency `veribrain hooks install [--force] [--print-ci]`: resolves actual `.git/hooks` (handling both normal `.git/hooks` and `.git` worktree gitdirs cleanly), writes portable POSIX `pre-commit` (`veribrain eval --strict`), `post-checkout`, and `post-merge` (`veribrain observe` CI/git-hook stubs with `issuer: git-hook`), checks existing hooks without clobbering unless `--force`, sets `0o755` executable mode, and supports `--print-ci` printing a zero-cost GitHub Actions YAML snippet.
