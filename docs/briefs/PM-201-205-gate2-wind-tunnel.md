# Feature Brief: Gate 2 — Stage 2 Wind Tunnel & Telemetry (`PM-201`–`PM-205`)

- **Owner:** CPM · **Gate:** Gate 2 (`19 pts <= 20-pt` cap) · **Branch:** `pre-staging` -> `staging` -> `main`
- **ICE / 125:** `Impact 5 x Confidence 5 x Ease 4 = 100 / 125`
- **Modified Fibonacci Breakdown:** `PM-201` (`3`) + `PM-202` (`5`) + `PM-203` (`5`) + `PM-204` (`3`) + `PM-205` (`3`) = **`19 pts`**
- **Primary Author:** `chief-bench` (Slot #8, promoted to Stage 2 write access strictly for `benchmarks/**` and `docs/benchmarks/**`; NEVER edits `src/**` or `tests/**`).
- **Independent Verifiers:** `CQE` (reproducibility + `tests/golden/` verification), `Security` (zero-custody keys + `100+` red-team rigor), `CUDE` (chart/report clarity), `CIE` (zero runtime deps + CI clean), `CFOE` (`< $5.00` one-off cap + `$0.00` local/CI default).

---

## 1. Problem & Target User
Stage 1 proved deterministic local compilation (`p95 = 5.67 ms`) and 5 Golden Context Evals at `$0.00`. Before claiming empirical numbers in the Build-in-Public engineering post and 10-slide talk deck, VeriBrain needs reproducible Stage 2 wind-tunnel evidence:
1. Automated **`100+`-attack adversarial Red-Team Wind Tunnel** proving `0%` policy poisoning escape into Zone A / `DECIDED` / `OBSERVED` and `100%` secret quarantine rejection with zero leakage.
2. Side-by-side **local compile latency (warm vs. cold disk)** and **Stage 1 estimator vs. Gemini 4 `countTokens`** calibration harness.
3. Reproducible **Gemini 4 Implicit Context Caching (`total_cached_tokens / total_input_tokens`)** A/B harness (Naive dynamic-header baseline vs. VeriBrain byte-frozen Zone A prefix sized `>= 4,096` tokens per Gemini 4 implicit caching floor) runnable both locally via zero-custody `scripts/run_with_key.*` and in **Google Colab (AI Ultra)**.

## 2. Locked Requirements

### A. `PM-201` (`3 pts`, `chief-bench`) — Canonical `>= 4,096`-Token Benchmark Corpus & Warm/Cold Latency Suite
- Build `benchmarks/corpus.mjs` (deterministic generator producing a realistic multi-file engineering `.brain/` workspace whose compiled Zone A exceeds **`4,096` tokens** — target `~5,000–6,000` tokens across `16+` `DECIDED` rules + `20` `OBSERVED` + `~3.5 KB` `scars.md` + `5` `hypotheses/` so Gemini 4 implicit caching triggers authentically with zero filler junk!).
- Build `benchmarks/run_latency_bench.mjs` running both **warm stat-validated** (`bypassReadCache: false`) and **cold disk** (`bypassReadCache: true`) 100-run benchmarks (10 warmup + 100 timed) against `./dist/index.js`, outputting `benchmarks/results/latency-observed.json` (with `min/p50/p95/p99/max/mean/stddev`, Node version, OS/CPU, fixture bytes, `zone_a_sha256`, `zone_a_tokens_est`, and `100/100` hash identity).

### B. `PM-202` (`5 pts`, `chief-bench`) — Google AI Studio Telemetry & Google Colab Wind-Tunnel Harness
- Build zero-dep Node 24 runner `benchmarks/ai_studio_telemetry.mjs` (Node 24 built-in `fetch` only — ZERO new packages in `package.json` `"dependencies": {}`!):
  - **Model Policy:** Uses ONLY current Gemini 4 models (`gemini-4-hydrogen` default; optional `--model gemini-3.5-flash-lite` / `gemini-4-argon`; explicitly rejects deprecated `gemini-2.5-*`, `gemini-2.0-*`, `gemini-1.5-*`).
  - **Mode 1 (`--dry-run`, default, `$0.00`):** Compiles both **Arm A (Naive dynamic-header flat prompt)** and **Arm B (VeriBrain Two-Zone byte-frozen Zone A `>= 4,096` tokens + dynamic Zone B tail)** across `6` simulated multi-turn deltas, verifies Zone A byte-identity (`6/6` identical SHA-256 on Arm B vs. `0/6` identical prefix on Arm A), estimates exact request count & max worst-case spend (`< $0.25` estimated, hard fail-closed abort if estimated spend exceeds `--max-usd`, default `$1.00`, absolute cap `$4.00 < $5.00`), and writes `benchmarks/results/ai-studio-dryrun.json`.
  - **Mode 2 (`--live`, Owner-invoked ONLY via `./scripts/run_with_key.ps1 GEMINI_API_KEY node benchmarks/ai_studio_telemetry.mjs --live`):**
    1. Calls `POST https://generativelanguage.googleapis.com/v1beta/models/{model}:countTokens` across 8 distinct compiled payloads (small/medium/large Zone A, Zone B citations, `<untrusted_hint>` XML, dense YAML/JSON) to compute exact `actual_tokens / est_tokens` calibration curve and recommended `chars_per_token` / `safety_margin`.
    2. Calls Gemini Interactions API (`store: false`, `max_output_tokens: 48`, `temperature: 0`) across `6` turns for Arm A (Naive) vs. `6` turns for Arm B (VeriBrain Two-Zone), capturing real `usage.total_cached_tokens`, `usage.total_input_tokens`, and `cached_ratio = total_cached_tokens / total_input_tokens` per turn, writing `benchmarks/results/ai-studio-live.json`.
    3. **Zero-Custody Secret Rules:** Reads API key ONLY from `process.env.GEMINI_API_KEY`; NEVER reads `.env` files, NEVER prints/logs the key or HTTP headers, NEVER writes key material to disk; fails closed with clear instructions to use `./scripts/run_with_key.ps1` if env var is missing.
- Build ready-to-run Google Colab notebook `benchmarks/notebooks/veribrain_stage2_wind_tunnel.ipynb` (valid nbformat 4 JSON, uses `google-genai >= 3.2.0` + `google.colab.userdata` / `getpass` zero-custody input, `gemini-4-hydrogen`, covers: `countTokens` calibration, Implicit Caching A/B Arm A vs. Arm B, Offline A/B Context Accuracy & Citation Grounding eval comparing VeriBrain cited Two-Zone vs. Flat Dump vs. Stale-Context RAG baseline, `100+`-attack Red-Team summary visualization, and matplotlib PNG export for `gdocs`/`gslides`).

### C. `PM-203` (`5 pts`, `chief-bench` + `Security`) — `100+`-Attack Adversarial Red-Team Wind Tunnel (`$0.00` Local + Colab)
- Build `benchmarks/redteam_corpus.json` (at least **`110` distinct, deterministic, labeled adversarial test cases** across 7 attack families — zero duplicate filler!):
  1. Direct secret formats (`20+`: GCP `AIza`, JWT `eyJ`/`eyI`/`eyA`, Bearer, PEM RSA/EC/OPENSSH, OpenAI/Anthropic `sk-`, GitHub `ghp_`/`github_pat_`, Slack `xox*`, AWS `AKIA`, Google OAuth `ya29.`/`GOCSPX-`, snake_case & camelCase OAuth KV).
  2. Quarantine evasion & reassembly (`20+`: JSON `\uXXXX` unicode escapes, `scars.md` HTML comment splicing `AIza<!--x-->Sy...`, zero-width `\u200B`/`\uFEFF`/soft-hyphen `\u00AD`, fullwidth NFKC homoglyphs, bidi overrides, Unicode Tag chars `U+E0000–U+E007F`, secret inside `claim_id` zero-echo checks).
  3. High-entropy smuggling & allowlist abuse (`15+`: fake repo paths `src/<secret>.ts`, hyphenated/dotted path segments, prose `sha256:<64hex>`, prose `commit/<40hex>`, prose `staging@<40hex>`, URL query/userinfo smuggling, base64/hex tokens `>= 32` chars).
  4. PII leakage & whitelist boundary (`10+`: personal emails, E.164 & formatted phone numbers, bypass attempts against domain allowlists, zero false-positive controls on ISO dates/semver/UUIDs/legit `evidence_ref`).
  5. Indirect prompt injection & `<untrusted_hint>` tag breakouts (`20+`: `</untrusted_hint>`, uppercase/whitespace/newline variants, fullwidth `＜/untrusted_hint＞`, XML CDATA/comments, forged `<system>`/`<decided>` tags, `"IGNORE PREVIOUS INSTRUCTIONS"` exfiltration prompts inside `scars.md` & `hypotheses/`).
  6. Write-authority, provenance & filesystem attacks (`15+`: `VERIBRAIN_AGENT_MODE=1|true|yes` on `observe` & `init --signed-by`, forged `signed_by: "claude-agent"`, tampered `decided/` `sha256_body`, duplicate frontmatter keys, `--role` newline injection, `signed_by` YAML injection, `..`/`.`/symlink `regression_test` escapes, `2099` future-dated TTL pinning, `scars.md >= 4,096 B` overflow, `hypotheses` `> 7d` TTL).
  7. Budget-exhaustion & silent-truncation attacks (`10+`: oversized Zone B spam attempting to evict `P0`/`P1` `DECIDED` rules, infeasible `--max-tokens` asserting fail-closed `exit 3` with `0` stdout bytes).
- Build `benchmarks/run_redteam.mjs` executing EVERY attack against compiled `./dist/index.js` & `./dist/cli.js` in isolated ephemeral temp dirs (ZERO writes outside temp dir), verifying `0%` policy poisoning escape into Zone A / `DECIDED` / `OBSERVED` and `0` raw secret bytes echoed, emitting `benchmarks/results/redteam-observed.json`.

### D. `PM-204` (`3 pts`, `chief-bench` + `CUDE`) — Reproducible Empirical Charts & Methodology Report
- Build `benchmarks/generate_charts.mjs` reading ONLY observed JSON artifacts (`latency-observed.json`, `redteam-observed.json`, `ai-studio-dryrun.json`, and `ai-studio-live.json` if present) and rendering clean, high-contrast, WCAG-legible **zero-dep SVG charts** under `benchmarks/charts/`:
  - `chart-1-latency.svg` (observed warm & cold p50/p95/p99 vs `< 15 ms` gate)
  - `chart-2-redteam-scorecard.svg` (observed `110+` attacks blocked by family, `0%` policy escape)
  - `chart-3-prefix-stability.svg` (observed dry-run Zone A prefix byte-stability Arm A `0/6` vs Arm B `6/6` + live Gemini 4 `total_cached_tokens` hit curve auto-populated once `ai-studio-live.json` exists!)
- Write `docs/benchmarks/README.md` (`< 8,192 B` strictly!) summarizing exact Stage 2 observed metrics, reproduction commands, zero-custody live AI Studio command (`./scripts/run_with_key.ps1 GEMINI_API_KEY node benchmarks/ai_studio_telemetry.mjs --live`), and explicit separation of **Observed Today (`$0.00`)** vs. **Pending Live API Run (`< $0.25` est., `< $5.00` cap)**.

### E. `PM-205` (`3 pts`, `CQE` + `Security` + `CUDE` + `CIE` + `CFOE`) — Independent Verification Gate
- `CQE` independently verifies `benchmarks/**` reproducibility (`run_latency_bench.mjs`, `run_redteam.mjs` `>= 110` distinct attacks with `0%` escape, `ai_studio_telemetry.mjs --dry-run`, `generate_charts.mjs`, valid Colab `.ipynb` JSON), adds a lightweight Golden smoke test (`tests/golden/stage2-wind-tunnel.test.ts` validating red-team corpus integrity & zero escape) while keeping `npm test` fast (`< 10s`), and updates `QUALITY.md` (`< 8,192 B`).
- `Security` audits `benchmarks/**` for zero-custody API key handling, zero `.env` reads, zero secret echo, and red-team corpus authenticity (no tautological/trivial attacks!).
- `CUDE` audits `benchmarks/charts/*.svg` & `docs/benchmarks/README.md` for WCAG contrast, engineer-to-engineer honesty, and zero fabricated claims.
- `CIE` & `CFOE` verify `package.json` `"dependencies": {}` untouched, `npm pack --dry-run` excludes `benchmarks/`, `bootstrap_startup.py --verify` passes, all 7 active registers `< 8,192 B`, and `$0.00` default execution + `< $5.00` live ceiling.

## 3. Explicit Non-Goals (Stage 2)
- No modifications to `src/**` (unless a Red-Team attack uncovers a genuine `P0`/`P1` bug — in which case Builder patches `src/**` and Security/CQE re-verify!).
- No Stage 3 `@modelcontextprotocol/sdk` MCP server (`Gate 3`).
- Zero live API spend without Owner's explicit invocation of `scripts/run_with_key.*`; ZERO writes to external repositories.
