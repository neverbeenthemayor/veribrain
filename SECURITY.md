# VeriBrain — Active Security Scorecard & Risk Register

- **Owner:** Chief Security Agent · **Baseline Date:** `2026-11-28` (`v1.4.0` / `PRG-4`)
- **Scope:** Fail-closed provenance (`DECIDED` / `OBSERVED` / `HYPOTHESIS`), regex+entropy PII/secret quarantine scrubber, `<untrusted_hint>` indirect prompt-injection sandboxing, zero-custody Stage 2 API keys, local `stdio` MCP (`7` tools), `shell: false` local test attestation, zero-PII `.brain/.metrics.jsonl`, and read-only `veribrain doctor`.

## 1. Active Security Gates

| Control | Target | Status | Verification Evidence |
|---|---|---|---|
| **Write-Authority Separation** | Agents emit `HYPOTHESIS` only; never self-attest `OBSERVED`/`DECIDED` or toggle metrics | `PASS` | Gate 1–`PRG-3` CLI/schema/MCP guards + `PRG-4` read-only `doctor` (zero write/mkdir/unlink/subprocess/network, `recordMetrics: false`, allowed in agent mode, `(human)`/`(human/CI)` fix badges) |
| **PII & Secret Quarantine Scrubber** | Fail-closed (`EXIT_QUARANTINE_VIOLATION = 2`), zero raw secret echo | `PASS` | `74/74` red-team + `P2-G2-1` + `P1-PRG2-1` + `PRG-3` + `PRG-4` (`P3-PRG4-2`): raw `doctor --format/--role/--env` pre-quarantined (`Exit 2` wins over `Exit 1`, zero echo), `.brain/` secrets rethrow `Exit 2`, rendered `text`/`md`/`json` scrubbed |
| **Indirect Prompt-Injection Containment** | Scars/hypotheses & `Zone B` untrusted content never enter `Zone A` / `A0` | `PASS` | `21/21` breakout suite (`0%` escape) + `renderZoneA0` takes zero role or Tier 2/3 inputs + escaped `<untrusted_hint non_authoritative="true">` + `.metrics.jsonl` isolated from compiler/eval/diff/retro/mirror |
| **Safe Subprocess & FS Confinement** | Zero `shell: true`, bounded DoS, strict repo realpath confinement | `PASS` | `PRG-2`/`PRG-3` confinement + `PRG-4` (`P1-PRG4-1..3`, `P2-PRG4-1`): pre-read confinement of `config.json`/`scars.md`/all tier dirs & files (`Exit 4`), `lstatSync(repoRoot)` + `ENOTDIR` safe handling, `allowWorktreeFallback: false`, depth-0 `.git` + `<gitDir>/gitdir` backlink hook check (`<= 64 KiB`) |
| **Zero-Custody & Cloudless Surface** | `.gitignore` blocks keys/metrics; RAM-only Stage 2; local Git + `stdio` only | `PASS` | Zero Firestore/Vector DB/Cloud Run brain store; `.gitignore` ignores `.brain/.metrics*`; local `stdio` MCP (`@modelcontextprotocol/sdk@1.32.2`, `zod@4.6.7`); Rulesets `28172892`/`28172893`, Secret Scanning + Push Protection, `CODEOWNERS` covers `/src/commands/doctor.ts` |
| **Pre-Gate Red/Blue Exercise** | Safe RoE adversarial audit before closing every Gate | `PASS (PRG-4 / v1.4.0)` | `2026-11-28` PRG-4 Red/Blue audit & re-verify (`PM-702`): `6/6` findings `VERIFIED_CLOSED` (`P1-PRG4-1..3`, `P2-PRG4-1`, `P3-PRG4-1..2`); `129/129` red-team (`0%` escape); `0` open `P0`–`P3` |

## 2. Open Vulnerabilities (`P0-P3`)
- Zero open `P0`/`P1`/`P2`/`P3` vulnerabilities (`Gate 1`–`PRG-1` `15/15`, `PRG-2` `8/8`, `PRG-3` `5/5`, `PRG-4` `6/6` closed `2026-11-28`).
