# VeriBrain — Active Security Scorecard & Risk Register

- **Owner:** Chief Security Agent · **Baseline Date:** `2026-11-25` (`v1.0.0`)
- **Scope:** Fail-closed provenance (`DECIDED` / `OBSERVED` / `HYPOTHESIS`), regex+entropy PII/secret quarantine scrubber, `<untrusted_hint>` indirect prompt-injection sandboxing, zero-custody Stage 2 API keys, local `stdio` MCP surface.

## 1. Active Security Gates

| Control | Target | Status | Verification Evidence |
|---|---|---|---|
| **Write-Authority Separation** | Agents emit `HYPOTHESIS` only; never self-attest `OBSERVED` / `DECIDED` | `PASS` | Gate 1 CLI/schema/env guards + Gate 2 `24/24` red-team + Gate 3 MCP 5-tool boundary (`PM-305`): atomic Tier 3 writes strictly confined to `.brain/hypotheses/HYP-*.json` (exact realpath equality), bounded (`hint <= 4,096 B`, `roles <= 32`, ID `<= 64` chars), zero writes to `decided/`/`observed/`/`scars.md` |
| **PII & Secret Quarantine Scrubber** | Fail-closed (`EXIT_QUARANTINE_VIOLATION = 2`), zero raw secret echo | `PASS` | Gate 1 + Gate 2 `74/74` red-team + Gate 3 `P2-G2-1` closed (`depth === 1` top-level `observed.evidence_ref` only), MCP `toMcpError` zero-echo & scrubbed `--print-config` errors verified |
| **Indirect Prompt-Injection Containment** | Scars/hypotheses strictly escaped inside `<untrusted_hint non_authoritative="true">` | `PASS` | Stage 1 wrapper/NFKC/bidi/Tag guards + Stage 2 `21/21` breakout suite (`0%` escape) + Stage 3 MCP `get_claim`/write tools emit escaped `<untrusted_hint>` only |
| **Zero-Custody Secrets** | `.gitignore` blocks `.env*`/keys; RAM-only `scripts/run_with_key.*` | `PASS` | Verified `bootstrap_startup.py --verify` + Stage 2 `ai_studio_telemetry.mjs`/`ai-studio-live.json` & Colab (`del _key`) + Stage 3/4 zero credential custody in MCP or npm tarball |
| **Zero Cloud Persistence Surface** | No Firestore/vector DB/Cloud Run brain store; local Git + `stdio` only | `PASS` | Local `stdio` MCP only (`@modelcontextprotocol/sdk@1.32.2`, `zod@4.6.7`, lazy-loaded on `veribrain mcp`); zero network/shell calls in `src/mcp/**` & `src/commands/mcp.ts` |
| **Pre-Gate Red/Blue Exercise** | Safe RoE adversarial prompt/CLI fuzzing before closing every Gate | `PASS (PRG-1 / v1.1.0)` | `2026-11-26` PRG-1 Red/Blue audit & re-verify (`PM-501`–`PM-504`: mirror confinement, `isSafeHostnameToken`, `decide`/`sign`/`promote` provenance, `hooks`/worktree `.git`, `lint-text`, `veribrain_list_claims` 6-tool MCP): `0` open `P0`–`P3` (`P1-PRG1-1..8`, `P2-PRG1-1..4`, `P3-PRG1-1..3` `VERIFIED_CLOSED`) |

## 2. Open Vulnerabilities (`P0-P3`)
- Zero open `P0`/`P1`/`P2`/`P3` vulnerabilities (`Gate 1`–`Gate 4` & `PRG-1` closed `2026-11-26`; `P1-PRG1-1..8`, `P2-PRG1-1..4`, `P3-PRG1-1..3` `VERIFIED_CLOSED`).
