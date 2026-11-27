# VeriBrain — Master Product Hub & Active Register

- **Owner:** Ian Mayor (`@neverbeenthemayor`) · **Release:** **`v1.3.0` (`2026-11-28`)** (`PRG-3` cut ready on `pre-staging` · `Playbook v2.0` · `npm`: `veribrain@1.2.0` live on GitHub & npm)
- **Pitch:** Zero-dollar deterministic, provenance-verified context compiler and local stdio MCP shared brain for multi-agent engineering.
- **Stack:** TypeScript 5.x + Node.js 24 LTS (ESM) + Vitest + Git/GitHub Actions + Local `stdio` MCP (`@modelcontextprotocol/sdk`) + Google Colab / AI Studio + `gdocs`/`gslides`
- **GitHub:** `https://github.com/neverbeenthemayor/veribrain` (Public · `main` / `staging` / `pre-staging` · Tag `v1.2.0` live, `v1.3.0` cut ready) · **Local-First CLI (Zero Cloud Hosting)**
- **Pointers:** [README](./README.md) · [RFC-001](./docs/RFC-001-veribrain-architecture.md) · [Feedback Log](./docs/feedback/customer-zero-feedback-log.md) · [PRG-3 Brief](./docs/briefs/PM-701-prg3-stats-v1.3.md) · [PRG-2 Brief](./docs/briefs/PM-601-605-prg2-v1.2.md) · [CHANGELOG](./CHANGELOG.md)

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
| **Post-Release Gate 2 (`PRG-2`)** | `v1.2.0` | `VERIFIED_CLOSED` | Constitutional Cache & Verifier DX (`PM-601`–`PM-605`, `18/20 pts`): `6/6` Chiefs, `19/19` suites (`77/77` tests), `129/129` red-team; live (`4aab244`, `v1.2.0`) |
| **Post-Release Gate 3 (`PRG-3`)** | `v1.3.0` | `VERIFIED_CLOSED` | Local `$0` ROI Telemetry (`PM-701`, `3/20 pts`): `6/6` Chiefs, `21/21` suites (`83/83` tests), `129/129` red-team, `0` open `P0`–`P2`; `PM-505` (`3 pts`) `PARKED` |

---

## 2. `PRG-3` (`v1.3.0`, `3/20 pts`) & Parked Queue (`PRG-2` & [PRG-1 Archives](./docs/archive/prg-1-backlog.md))

| ID | Capability (`PRG-3` · `v1.3.0` & Parked) | Pri | ICE | Pts | Status | Owner |
|---|---|---:|---:|---:|---|---|
| **PM-701** | `veribrain stats` + opt-in `.metrics.jsonl` + MCP `veribrain_stats` (`$0` local ROI) | `P1` | `0.80` | `3` | `VERIFIED_CLOSED` | Builder + CUDE/Bench |
| **PM-505** | Calibrated tokenizer profiles (`--tokenizer gemini4 \| default`) | `P2` | `0.48` | `3` | `PARKED` | Bench + Builder |

*Closed `PRG-2` (`v1.2.0`, `18/20 pts` — `VERIFIED_CLOSED` at `4aab244`):* `PM-601` (`Zone A0+A1`, `5 pts`), `PM-602` (`attest-test`, `5 pts`), `PM-603` (`check-citations`, `3 pts`), `PM-604` (`retro` + `env-ttl`, `3 pts`), `PM-605` (`diff` UX + `npm pkg fix`, `2 pts`).

---

## 3. Standing Cadence Rules
- **Register Cap:** Keep all 7 active Chief registers strictly `< 8,192 B`; archive closed stages under `docs/archive/`.
- **Weekend Isolation:** Zero weekday interrupts to external repositories (`VERIBRAIN_ISOLATION_SEGMENTS`); never write into external isolated directories.
- **Tier 1 Launch Assets:** Live Google Doc & 10-Slide Google Slides URLs tracked in [`docs/blog-outline-veribrain.md`](./docs/blog-outline-veribrain.md) and [`docs/progress-reports.md`](./docs/progress-reports.md).
