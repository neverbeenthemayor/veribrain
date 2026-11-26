# VeriBrain Stage 2 Wind Tunnel — Empirical Benchmarks & Methodology

- **Owner:** Chief Benchmark & Context Scientist (`benchmarks/**`, `docs/benchmarks/**`)
- **Status:** **Stage 2 COMPLETE** — Local `$0.00` (`129/129` Red-Team, `12.62 ms` warm p95) + Live `gemini-4-hydrogen` (`countTokens` + **`73.1%` T2–T6 / `75.0%` peak** vs. **`0.0%`** Arm A)
- **Stage 2 Runtime Dependencies Added:** `0` (Stage 2 runners use Node 24 stdlib + `fetch` only; Stage 3 later added local `stdio` MCP deps `@modelcontextprotocol/sdk` + `zod`)

> **Honesty Contract:** Every figure below comes verbatim from committed JSON outputs in `benchmarks/results/` (`latency-observed.json`, `redteam-observed.json`, `ai-studio-dryrun.json`, `ai-studio-live.json`).

---

## 1. Local Compile Latency & Red-Team Wind Tunnel (`$0.00`)

### A. Warm vs. Cold Local Compile Latency (`PM-201`)
Source: [`latency-observed.json`](../../benchmarks/results/latency-observed.json) · Chart: [`chart-1-latency.svg`](../../benchmarks/charts/chart-1-latency.svg) (`Node v26.13.1`, `win32/x64`, `45` files / `35,365 B`, `eval --strict` PASS)

| Mode (`10` warmup + `100` timed) | min | p50 | p95 | p99 | max | mean (sd) | Hash Identity | Gate (`< 15 ms`) |
| :--- | ---: | ---: | ---: | ---: | ---: | ---: | :---: | :---: |
| **Warm Stat-Validated** (`bypassReadCache: false`) | `6.39 ms` | `8.48 ms` | **`12.62 ms`** | `16.29 ms` | `17.84 ms` | `8.86 ms` (`2.04`) | **`100/100`** | **PASS** |
| **Cold Disk** (`bypassReadCache: true`) | `24.24 ms` | `52.65 ms` | **`99.48 ms`** | `131.31 ms` | `167.43 ms` | `57.67 ms` (`23.27`) | **`100/100`** | NTFS cold I/O |

### B. Adversarial Red-Team Wind Tunnel (`PM-203` — `129` Cases)
Source: [`redteam-observed.json`](../../benchmarks/results/redteam-observed.json) · Chart: [`chart-2-redteam-scorecard.svg`](../../benchmarks/charts/chart-2-redteam-scorecard.svg)

| Family | Passed | Escapes | Leaks | Pre-Patch Discovery -> Post-Patch Proof |
| :--- | :---: | :---: | :---: | :--- |
| `direct_secrets` / `quarantine_evasion` | **`45 / 45`** | `0` | `0` | Pre-patch (`124/129`) caught lookbehind bypass (`RT-EVA-17/18/20`) & JSON-key echo (`RT-EVA-04`) |
| `entropy_smuggling` / `pii_boundary` | **`29 / 29`** | `0` | `0` | Fake repo paths, prose hash-ref abuse, `@localhost` userinfo, 4 clean controls |
| `prompt_injection_breakout` | **`21 / 21`** | `0` | `0` | `</untrusted_hint>`, NFKC fullwidth, bidi, Unicode Tags, XML/heading spoofing |
| `provenance_filesystem` / `budget_exhaustion` | **`34 / 34`** | `0` | `0` | Pre-patch caught duplicate-frontmatter exit code (`RT-PRV-11`); agent exit `4`, budget exit `3` |
| **Total (`125` attacks + `4` controls)** | **`129 / 129`** | **`0` (`0%`)** | **`0`** | **Builder patched all 3 catches -> `129/129`, `0%` escape, `0` canary leaks** |

---

## 2. Live Gemini 4 AI Studio Telemetry (`PM-202`, `gemini-4-hydrogen`)
Source: [`ai-studio-live.json`](../../benchmarks/results/ai-studio-live.json) · Chart: [`chart-3-prefix-stability.svg`](../../benchmarks/charts/chart-3-prefix-stability.svg) · Colab: [`veribrain_stage2_wind_tunnel.ipynb`](../../benchmarks/notebooks/veribrain_stage2_wind_tunnel.ipynb)

### A. Real `countTokens` Calibration (`9` Payloads, `$0.00`)
- **Full Compiled Two-Zone (`26,000 B`):** `8,743` est. vs. **`7,204` actual** (`3.61 B/tok`, **`+21.4%` conservative headroom**).
- **Zone A Static Prefix:** canonical `18 DECIDED` = **`4,318` actual** (`4.08 B/tok`, `+35.9%` headroom); `gemini4-cache` `32 DECIDED` (`29,982 B`) = **`7,112` actual** (`4.22 B/tok`, clears `4,096 + 2,050 = 6,146` window).
- **Hex-SHA Density Discovery:** `zone_b_observed_citations` (`2.38 B/tok`, `-17.9%`), `dense_json_observed` (`2.15 B/tok`, `-27.3%`), and `dense_yaml_frontmatter` (`1.60 B/tok`, `-44.6%`) tokenize `1.7x–2.5x` denser than Markdown prose due to 40/64-char hex digests.

### B. Live Implicit Context Caching A/B (`previous_interaction_id`, `store: true`, `thinking_level: "low"`, `max_output_tokens: 512`)
Both arms chained identical `previous_interaction_id` sessions (`12/12` `"status": "completed"`). Arm A prepended a volatile 6-line dynamic header at byte 0 of `system_instruction`; Arm B sent exact byte-frozen `7,112`-token Zone A (`sha256: f0cf3d05...`).

| Turn | Arm A Input | Arm A Cached (`%`) | Arm B Input | Arm B Cached (`%`) | Tail Window (`prev_in - cached`) |
| :---: | ---: | ---: | ---: | ---: | :---: |
| **T1** *(cold)* | `7,980` | `0` (`0.0%`) | `7,890` | `0` (`0.0%`) | *(initial prefix write)* |
| **T2** | `8,389` | `0` (`0.0%`) | `8,301` | **`5,841` (`70.37%`)** | `2,049` tok |
| **T3** | `8,722` | `0` (`0.0%`) | `8,639` | **`6,252` (`72.37%`)** | `2,049` tok |
| **T4** | `9,086` | `0` (`0.0%`) | `8,991` | **`6,590` (`73.30%`)** | `2,049` tok |
| **T5** | `9,517` | `0` (`0.0%`) | `9,362` | **`6,942` (`74.15%`)** | `2,049` tok |
| **T6** | `9,913` | `0` (`0.0%`) | `9,745` | **`7,313` (`75.04%`)** | `2,049` tok |
| **T2–T6 Avg / Peak** | `45,627` | **`0` (`0.0%`)** | `45,038` | **`32,938` (`73.13%` / `75.04%`)** | **Exact `2,049`-tok ceiling** |

- **Empirical Diagnostic Log (`$0.4851` cumulative upper-bound across 3 runs `<< $5.00` cap):**
  1. Run 1 (`$0.1368`): `max_output_tokens=48` under Gemini 4's default `thinking_level="high"` aborted `12/12` turns `"incomplete"` (`0%` hits) and calibrated `countTokens`.
  2. Run 2 (`$0.1718`): `12/12` `"completed"` with `7,112`-tok Zone A, but unlinked stateless Interactions (`no previous_interaction_id`) saw `0.0%` hits — confirming Google's Interactions caching docs.
  3. Run 3 (`$0.1765`): Chaining `previous_interaction_id` on both arms proved **Arm A stayed pinned at `0.0%`** while **Arm B hit Gemini 4's exact mathematical cache ceiling (`prev_input - 2,049` tok on every turn)** — `73.1%` follow-up average, `75.0%` peak by Turn 6 (and asymptotically `83%–90%` on longer sessions).
- **Colab Offline A/B Context Grounding (`10` tasks, `$0.00`):** VeriBrain Cited Two-Zone **`10/10` (`100%`, `0` leaks)** vs. Flat Dump **`6/10` (`60%`, `4` leaks)** vs. Stale-Context RAG **`1/10` (`10%`, `4` leaks)**.

---

## 3. Reproduction Commands
```powershell
npm run build
node benchmarks/run_latency_bench.mjs
node benchmarks/run_redteam.mjs
node benchmarks/ai_studio_telemetry.mjs --dry-run
# Optional live re-run (zero-custody RAM-only key, ~$0.18 worst-case):
./scripts/run_with_key.ps1 GEMINI_API_KEY node benchmarks/ai_studio_telemetry.mjs --live
node benchmarks/generate_charts.mjs
```
