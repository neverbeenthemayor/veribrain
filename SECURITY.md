# VeriBrain — Active Security Scorecard & Risk Register

- **Owner:** Chief Security Agent · **Baseline Date:** `2026-11-28` (`v1.3.0` / `PRG-3`)
- **Scope:** Fail-closed provenance (`DECIDED` / `OBSERVED` / `HYPOTHESIS`), regex+entropy PII/secret quarantine scrubber, `<untrusted_hint>` indirect prompt-injection sandboxing, zero-custody Stage 2 API keys, local `stdio` MCP (`7` tools), `shell: false` local test attestation, and zero-PII opt-in `.brain/.metrics.jsonl` telemetry.

## 1. Active Security Gates

| Control | Target | Status | Verification Evidence |
|---|---|---|---|
| **Write-Authority Separation** | Agents emit `HYPOTHESIS` only; never self-attest `OBSERVED` / `DECIDED` or toggle metrics | `PASS` | Gate 1–`PRG-2` CLI/schema/MCP guards + `PRG-3` pre-flag `Exit 4` agent denial for `stats --enable`/`--disable`/`--reset` (`cli.ts` + `runStats`) while read-only `stats` & MCP `veribrain_stats` (`readOnlyHint: true`) remain safe |
| **PII & Secret Quarantine Scrubber** | Fail-closed (`EXIT_QUARANTINE_VIOLATION = 2`), zero raw secret echo | `PASS` | `74/74` red-team + `P2-G2-1` + `P1-PRG2-1` + `PRG-3` (`P2-PRG3-2`): `--since`/`--format` pre-quarantined (`Exit 2`, zero truncated prefix leak, static CLI/MCP errors), zero-PII 12-hex metrics schema disabled by default, rendered `stats` outputs quarantined |
| **Indirect Prompt-Injection Containment** | Scars/hypotheses & `Zone B` untrusted content never enter `Zone A` / `A0` | `PASS` | `21/21` breakout suite (`0%` escape) + `renderZoneA0` takes zero role or Tier 2/3 inputs + escaped `<untrusted_hint non_authoritative="true">` + `.metrics.jsonl` completely isolated from `compileContext`, `eval`, `diff`, `retro`, `check-citations`, and `mirror` |
| **Safe Subprocess & FS Confinement** | Zero `shell: true`, bounded DoS, strict repo realpath confinement | `PASS` | `attest-test` (`shell: false`, `--timeout` bounds); `check-citations` & `stats --baseline-paths` pre-`lstatSync` confinement (`Exit 4`, `500` files / `512 KB` / depth `32`); `metrics.ts`/`stats.ts` enforce `O_NOFOLLOW`, `0o600`, symlink-ancestor walk BEFORE `mkdirSync` (`P1-PRG3-1`), `lstatSync(repoRoot)` before `realpathSync` (`P2-PRG3-1`), leading-slash config path denial, and `2 MiB` bounded self-healing tail compaction |
| **Zero-Custody & Cloudless Surface** | `.gitignore` blocks keys/metrics; RAM-only Stage 2; local Git + `stdio` only | `PASS` | Zero Firestore/Vector DB/Cloud Run brain store; `.gitignore` ignores `.brain/.metrics.jsonl`/`.json`; local `stdio` MCP (`@modelcontextprotocol/sdk@1.32.2`, `zod@4.6.7`); GitHub Rulesets `28172892`/`28172893`, Secret Scanning + Push Protection, `CODEOWNERS` covers `/src/metrics.ts` & `/src/commands/stats.ts` |
| **Pre-Gate Red/Blue Exercise** | Safe RoE adversarial audit before closing every Gate | `PASS (PRG-3 / v1.3.0)` | `2026-11-28` PRG-3 Red/Blue audit & re-verify (`PM-701`): `5/5` findings `VERIFIED_CLOSED` (`P1-PRG3-1`, `P2-PRG3-1..2`, `P3-PRG3-1..2`); `129/129` red-team (`0%` escape); `0` open `P0`–`P3` |

## 2. Open Vulnerabilities (`P0-P3`)
- Zero open `P0`/`P1`/`P2`/`P3` vulnerabilities (`Gate 1`–`Gate 4` & `PRG-1` `15/15` closed `2026-11-26`; `PRG-2` `8/8` closed `2026-11-27`; `PRG-3` `5/5` closed `2026-11-28`).
