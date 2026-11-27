# VeriBrain — Active Cloud, CI & Token FinOps Ledger

- **Owner:** Chief FinOps Engineer (CFOE) · **Effective Date:** `2026-11-25`
- **Hard Monthly Cash Cap:** **`<= $10.00/mo`** (Core VeriBrain CLI & MCP runtime is strictly **`$0.00/mo`**)
- **Billing Alerts:** **`$5.00 (50%)`** / **`$9.00 (90%)`** / **`$10.00 (100%)`**
- **CFOE Early-Warning Review Trigger:** **`$2.00/mo`**
- **Prepay / LLM API Guardrail:** Always keep **`Auto-reload: OFF`**; **UNANIMOUS `6/6` BAN** on nightly LLM sleep consolidation (`50k–200k` tok/night eliminated -> `$0.00`).

## 1. Zero-Dollar Runtime & Bounded Stage 2 Benchmark Budget

| Surface | Hard Configured Guardrail | Target Spend |
|---|---|---|
| **VeriBrain CLI Compiler (`Stage 1`)** | Zero runtime LLM SDK dependencies, pure local Node.js 24 (`< 15 ms`) | **`$0.00/mo`** |
| **Weekly Brain Diff (`veribrain diff`)** | Pure local Git diff + metadata parser (`<= 5` bullets, `0` LLM tokens) | **`$0.00/mo`** |
| **Local `stdio` MCP (`Stage 3`)** | Local `@modelcontextprotocol/sdk` process; zero hosted Vector DB/Cloud Run | **`$0.00/mo`** |
| **Stage 2 AI Studio Calibration** | Bounded `countTokens` + `cachedContentTokenCount` benchmark runs (`run_with_key.*`) | **`< $5.00` one-off** |
| **Stage 2 Google Colab Harness** | Included in Owner's existing Google AI Ultra subscription (no extra GPU top-up) | **`$0.00` incremental** |
| **GitHub Actions CI (`ci.yml`)** | `paths-ignore: ['docs/**', '*.md']`, concurrency cancel, `<= 5m` Node 24 job | **`$0.00` (`< 2,000` free min)** |
| **Active Chief Registers (`Ruling #9`)** | `< 8,192 B` UTF-8 byte cap enforced by CI & `bootstrap_startup.py --verify` | `~60-80%` token reduction |
| **Playbook `apphosting*.yaml` Guards** | Retained strictly at `minInstances: 0` for `--verify` compliance (not deployed) | **`$0.00/mo`** |

## 2. Weekend Gate Spend Packet (5 Lines)
1. MTD Cash vs. `$10.00` cap (`$0.00` expected in Stages 0, 1, 3, 4; `< $5.00` in Stage 2).
2. GitHub Actions CI `% of 2,000` free private min/mo.
3. Observed Gemini KV-cache hit savings (`cachedContentTokenCount / promptTokenCount`, target `80%–92%`).
4. All 7 active Chief registers verified `< 8,192 B`.
5. Binding FinOps Verdict: `APPROVED` | `OPTIMIZE_FIRST` | `REJECTED`.

## 3. Observed Gate Verdicts
- **Gate 1 (`2026-11-25`):** `$0.00 / $10.00` MTD (`"dependencies": {}`, `0` network calls, `0` cloud resources, `< 0.5%` CI free tier, `7/7` active registers `< 8,192 B`) — **`APPROVED`** (CFOE).
- **Gate 2 (`2026-11-25`):** **`$0.4851 / $10.00` MTD upper-bound** (`$0.1368 + $0.1718 + $0.1765` across 3 live `gemini-4-hydrogen` calibration runs; `9.7%` of `< $5.00` Stage 2 cap, below `$2.00` CFOE trigger; live Arm B **`73.1%` T2–T6 / `75.0%` peak** cached vs. **`0.0%`** Arm A, `32,938` tokens discounted `95%`; `"dependencies": {}` untouched, `0` nightly LLM jobs, `8/8` docs `< 8,192 B`) — **`APPROVED`** (CFOE).
- **Gate 3 (`2026-11-25`):** **`$0.4851 / $10.00` MTD** (`$0.00` Stage 3 incremental; local `stdio` MCP adds only OSS `@modelcontextprotocol/sdk@1.32.2` + `zod@4.6.7`, lazy-loaded on `veribrain mcp`, `0` LLM SDKs, `0` outbound network/cloud calls, `< 1%` CI free tier, `7/7` active registers `< 8,192 B`) — **`APPROVED`** (CFOE).
- **Gate 4 (`2026-11-25`, `v1.0.0` Release):** **`$0.4851 / $10.00` MTD** (`$0.00` Stage 4 incremental; runtime strictly `$0.00/mo` with zero LLM SDKs, zero cloud infra, zero nightly jobs; Linux CI `19s` `quality` job incl. `run_redteam.mjs` `< 2%` of 2,000 free min/mo; `7/7` active registers `< 8,192 B`) — **`APPROVED`** (CFOE).
- **PRG-1 (`2026-11-26`, `v1.1.0` Customer-Zero Wave):** **`$0.4851 / $10.00` MTD** (`$0.00` incremental across `PM-501`–`PM-504`; `0` new runtime deps, `0` paid APIs/LLM SDKs/cloud calls, `$0` POSIX Git hooks & event-driven CI snippet, Zone A KV-cache prefix invariant preserved, `7/7` active registers `< 8,192 B`) — **`APPROVED`** (CFOE).
- **PRG-2 (`2026-11-27`, `v1.2.0` Constitutional Cache & Verifier Wave):** **`$0.4851 / $10.00` MTD** (`$0.00` incremental across `PM-601`–`PM-605`; `0` new runtime deps enforced by CI policy gate, `$0` Zone `A0`+`A1` cross-role KV prefix split, `$0` `attest-test`/`check-citations`/`retro`, `< 2%` CI free tier, `7/7` active registers `< 8,192 B`) — **`APPROVED`** (CFOE).
