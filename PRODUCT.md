# VeriBrain — Master Product Hub & Active Register

- **Owner:** Ian Mayor (`@neverbeenthemayor`) · **Release:** **`v1.2.0` (`2026-11-27`)** (`PRG-2` · `Playbook v2.0` · `npm`: `veribrain@1.1.0` live, `v1.2.0` cut ready)
- **Pitch:** Zero-dollar deterministic, provenance-verified context compiler and local stdio MCP shared brain for multi-agent engineering.
- **Stack:** TypeScript 5.x + Node.js 24 LTS (ESM) + Vitest + Git/GitHub Actions + Local `stdio` MCP (`@modelcontextprotocol/sdk`) + Google Colab / AI Studio + `gdocs`/`gslides`
- **GitHub:** `https://github.com/neverbeenthemayor/veribrain` (Public · `main` / `staging` / `pre-staging` · Tag `v1.1.0`, `v1.2.0` staged) · **Local-First CLI (Zero Cloud Hosting)**
- **Pointers:** [README](./README.md) · [RFC-001](./docs/RFC-001-veribrain-architecture.md) · [Feedback Log](./docs/feedback/customer-zero-feedback-log.md) · [PRG-2 Brief](./docs/briefs/PM-601-605-prg2-v1.2.md) · [Blog Post](./docs/blog-veribrain-post.md) · [CHANGELOG](./CHANGELOG.md)

---

## 1. Program Gate Dashboard (Weekend-Only Cadence · Cap: `15-20 pts`)

| Gate | Completed | Status | Focus |
|---|---|---|---|
| **Gate 0: Stage 0 Architecture Lock** | `2026-11-25` | `VERIFIED_CLOSED` | 6-Chief Red-Team -> Hardened v2 RFC-001, Blog Outline, Playbook v2.0 + GitHub repo |
| **Gate 1: Stage 1 Deterministic Compiler** | `2026-11-25` | `VERIFIED_CLOSED` | TS/Node 24 CLI (`init`, `compile`, `eval`, `diff`, `observe`), Quarantine Scrubber, 5 `$0` Golden Evals (`44/44`), read-only shadow (`p95=5.67ms`) |
| **Gate 2: Stage 2 Wind Tunnel & Telemetry** | `2026-11-25` | `VERIFIED_CLOSED` | `129/129` Red-Team (`0%` escape), `12.62 ms` warm p95, **Live `gemini-4-hydrogen`: `73.13%` T2–T6 (`75.04%` peak) vs `0.0%` Arm A**, `countTokens` (`7,112` tok) + Colab `10/10` |
| **Gate 3: Stage 3 Cross-Client `stdio` MCP** | `2026-11-25` | `VERIFIED_CLOSED` | Local `npx veribrain mcp` (`@modelcontextprotocol/sdk`, 5 tools, `56/56` tests, `0` open `P0`-`P2`, `6/6` Chiefs) + Google Doc & 10-Slide Deck exported |
| **Gate 4: Stage 4 Open-Source `v1.0.0` Launch** | `2026-11-25` | `VERIFIED_CLOSED` | `v1.0.0` package (`50.8 kB`, `32` files, `@types/node@24.19.4`), `README`/`CHANGELOG`/`CONTRIBUTING`, live Linux CI Run `45621060408` `RT-PRV-18` (`0` open `P0`-`P3`) |
| **Post-Release Gate 1 (`PRG-1`)** | `v1.1.0` | `VERIFIED_CLOSED` | Customer-Zero DX (`PM-501`–`PM-504`): `18/20 pts`, `6/6` Chiefs, `67/67` tests, `129/129` red-team, `0` open `P0`–`P3`; live on GitHub & npm |
| **Post-Release Gate 2 (`PRG-2`)** | `v1.2.0` | `VERIFIED_CLOSED` | Constitutional Cache & Verifier DX (`PM-601`–`PM-605`, `18/20 pts`): `6/6` Chiefs, `19/19` suites (`77/77` tests), `129/129` red-team, `0` open `P0`–`P3` |
| **Post-Release Gate 3 (`PRG-3`)** | `v1.3.0` | `QUEUED` | `PM-505` (calibrated tokenizer profiles `3 pts`, `PARKED`) + future field intake |

---

## 2. `PRG-2` (`v1.2.0`, `18/20 pts`) & Parked Queue ([Closed Gate Archives](./docs/archive/prg-1-backlog.md))

| ID | Capability (`PRG-2` · `v1.2.0` & Parked `PRG-3`) | Pri | ICE | Pts | Status | Owner |
|---|---|---:|---:|---:|---|---|
| **PM-601** | Zone `A0` + `A1` constitutional prefix split (`8x` Chief KV-cache hit) | `P1` | `0.80` | `5` | `VERIFIED_CLOSED` | Builder + Bench |
| **PM-602** | `veribrain attest-test` (`OBS-VERIFY-*` `$0`-LLM gate receipts) | `P1` | `0.80` | `5` | `VERIFIED_CLOSED` | Builder + CQE |
| **PM-603** | `veribrain check-citations` zero-LLM doc `DEC-*`/`OBS-*` drift auditor | `P1` | `0.64` | `3` | `VERIFIED_CLOSED` | Builder + CQE |
| **PM-604** | `veribrain retro --since 7d --format md` + optional `env-ttl` Tier 2 | `P1` | `0.64` | `3` | `VERIFIED_CLOSED` | Builder + CUDE |
| **PM-605** | `veribrain diff` tier-aware actions & slugs + `npm pkg fix` hygiene | `P1` | `0.80` | `2` | `VERIFIED_CLOSED` | Builder + CUDE |
| **PM-505** | Calibrated tokenizer profiles (`--tokenizer gemini4 \| default`) | `P2` | `0.48` | `3` | `PARKED` | Bench + Builder |

---

## 3. Standing Cadence Rules
- **Register Cap:** Keep all 7 active Chief registers strictly `< 8,192 B`; archive closed stages under `docs/archive/`.
- **Weekend Isolation:** Zero weekday interrupts to external repositories (`VERIBRAIN_ISOLATION_SEGMENTS`); never write into external isolated directories.
- **Tier 1 Launch Assets:** Live Google Doc & 10-Slide Google Slides URLs tracked in [`docs/blog-outline-veribrain.md`](./docs/blog-outline-veribrain.md) and [`docs/progress-reports.md`](./docs/progress-reports.md).
