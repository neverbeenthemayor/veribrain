# VeriBrain — Active Security Scorecard & Risk Register

- **Owner:** Chief Security Agent · **Baseline Date:** `2026-11-27` (`v1.2.0` / `PRG-2`)
- **Scope:** Fail-closed provenance (`DECIDED` / `OBSERVED` / `HYPOTHESIS`), regex+entropy PII/secret quarantine scrubber, `<untrusted_hint>` indirect prompt-injection sandboxing, zero-custody Stage 2 API keys, local `stdio` MCP surface, and `shell: false` local test attestation.

## 1. Active Security Gates

| Control | Target | Status | Verification Evidence |
|---|---|---|---|
| **Write-Authority Separation** | Agents emit `HYPOTHESIS` only; never self-attest `OBSERVED` / `DECIDED` | `PASS` | Gate 1 CLI/schema/env guards + Gate 2 `24/24` red-team + Gate 3 MCP boundary (`.brain/hypotheses/HYP-*.json` exact realpath equality) + `PRG-1` (`decide`/`promote`) + `PRG-2` (`attest-test` Exit `4` pre-flag check, `observe.ts` `lstatSync`/`realpathSync` confinement) |
| **PII & Secret Quarantine Scrubber** | Fail-closed (`EXIT_QUARANTINE_VIOLATION = 2`), zero raw secret echo | `PASS` | `74/74` red-team + `P2-G2-1` (`depth === 1` `observed.evidence_ref` only) + `P1-PRG2-1` raw unstripped/untruncated argv pre-scan & unconditional dry-run/receipt scrub + zero echo of raw child output |
| **Indirect Prompt-Injection Containment** | Scars/hypotheses & `Zone B` untrusted content never enter `Zone A` / `A0` | `PASS` | `21/21` breakout suite (`0%` escape) + `renderZoneA0` takes zero role or Tier 2/3 inputs + escaped `<untrusted_hint non_authoritative="true">` |
| **Safe Subprocess & FS Confinement** | Zero `shell: true`, bounded DoS, strict repo realpath confinement | `PASS` | `attest-test` rejects shell metacharacters & `\0`/bidi chars (`shell: false`, bounded `--timeout` `100..600_000 ms`, Windows Node `npm-cli.js` dispatch); `check-citations` rejects out-of-repo/UNC/blocked-isolation paths before `lstatSync` (`Exit 4`) & enforces `500` files / `512 KB` / depth `32` (`P1-PRG2-2..3`) |
| **Zero-Custody & Cloudless Surface** | `.gitignore` blocks keys; RAM-only Stage 2; local Git + `stdio` only | `PASS` | Zero Firestore/Vector DB/Cloud Run brain store; local `stdio` MCP (`@modelcontextprotocol/sdk@1.32.2`, `zod@4.6.7`); GitHub Rulesets `28172892`/`28172893`, Secret Scanning + Push Protection, Fork PR approval |
| **Pre-Gate Red/Blue Exercise** | Safe RoE adversarial audit before closing every Gate | `PASS (PRG-2 / v1.2.0)` | `2026-11-27` PRG-2 Red/Blue audit & re-verify (`PM-601`–`PM-605`): `8/8` findings `VERIFIED_CLOSED` (`P1-PRG2-1..3`, `P2-PRG2-1..2`, `P3-PRG2-1..3`); `129/129` red-team (`0%` escape); `0` open `P0`–`P3` |

## 2. Open Vulnerabilities (`P0-P3`)
- Zero open `P0`/`P1`/`P2`/`P3` vulnerabilities (`Gate 1`–`Gate 4` & `PRG-1` `15/15` closed `2026-11-26`; `PRG-2` `8/8` closed `2026-11-27`).
