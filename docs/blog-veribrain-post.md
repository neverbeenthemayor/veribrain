# Why We Killed Our Nightly AI Memory Bot and Built a $0 Deterministic Context Compiler (VeriBrain)

**By Ian Mayor · VeriBrain Engineering (Hardened v2 · Observed Stage 1–3 Proof)**

Most "shared brain" AI memory systems fail for a simple reason: they try to cure stochastic agent forgetfulness by adding *more* stochastic LLM summarization at night. When we subjected our naive v1 shared-memory design to a cynical six-specialist engineering peer review, all six reviewers voted unanimously to kill the nightly LLM sleep bot. In its place, we built **VeriBrain** — a **$0.00/month local TypeScript/Node.js 24 deterministic context compiler and local `stdio` MCP bridge** that preserves live Gemini 4 KV-cache hits up to **75.04% peak (73.13% T2–T6 average vs. 0.0% for naive dynamic headers)**, compiles in **5.67–12.62 ms warm p95**, and achieved **0% policy-poisoning escape across 129 red-team cases (125 attacks + 4 clean controls)**.

---

## 1. The Night Our "Shared Brain" Idea Didn't Survive Six Cynical Engineers

Every engineering team running multiple coding agents — Antigravity, Claude Code, Cursor, Codex — hits the same wall: **context amnesia across terminals and sessions**. Decisions made in one session vanish in the next. Environment truth from `staging` gets mixed with `prod`. Regression lessons repeat across branches.

Our first instinct (v1) looked like every other "AI shared brain" architecture diagram on social media: dump repository notes into markdown and a vector database, and run a nightly "sleep consolidation" LLM job to summarize, deduplicate, and refresh agent memory.

Before writing a line of code, we put v1 in front of six skeptical domain reviewers (**Builder, Infrastructure, Quality, Security, User Design, and FinOps**) and told them to tear it apart. They dismantled it in one session.

---

## 2. Four Failure Modes That Killed v1

| Failure Mode | Reviewers | Why Naive Shared Memory Breaks in Production |
| :--- | :--- | :--- |
| **The Cache-Busting Trap** | CIE + CFOE | Prepending timestamps, git SHAs, or dynamic status headers at byte 0 of a system prompt invalidates provider KV caches on every turn, forfeiting 70%–95% cached-input discounts. |
| **The Nightly Consolidation Tax** | CFOE + CUDE | Nightly LLM sleep bots burn 50k–200k tokens/night generating walls of prose nobody audits carefully — creating rubber-stamp fatigue while compounding hallucinated summaries. |
| **Self-Attestation & Persistent Poisoning** | Security | Letting coding agents write directly to "verified memory" turns one indirect prompt injection or poisoned tool output into permanent executable policy across every future session. |
| **Silent Truncation & Stale SHAs** | CQE + Builder | When prompts hit token budgets, naive truncation drops `P0` constraints silently; undated environment notes leak stale `staging` or `prod` claims across commits. |

The verdict was unanimous (**6/6**): kill nightly LLM consolidation completely, ban cloud vector DBs for repository engineering memory, and treat context assembly like a **deterministic compiler with cryptographic provenance and KV-cache layout**.

---

## 3. Hardened v2: Context Assembly as a Deterministic Compiler

VeriBrain stores all state inside a plain, Git-tracked `.brain/` directory separated into strict trust tiers:

- **`decided/*.md` (Tier 1 — Immutable Human Policy):** Required YAML frontmatter (`id`, `priority` `P0|P1|P2`, `roles`, human `signed_by`, `signed_at_utc`, 64-hex `sha256_body`, `status`). Agents can never write or self-sign Tier 1.
- **`observed/*.json` (Tier 2 — Machine-Verified Ephemeral Truth):** Strictly scoped by `(env, git_sha, observed_at_utc, ttl_seconds)` and `issuer` in `ci | git-hook | verifier-script`. Stale or wrong-env/SHA claims are deterministically excluded into `excluded_stale_ids`.
- **`scars.md` (Tier 3 — Bounded Failure Memory):** Hard ceiling `< 4,096` bytes UTF-8, `<= 30`-day TTL, every entry linked to a real repo-relative `regression_test` file verified for existence and symlink confinement in `veribrain eval --strict`.
- **`hypotheses/*.json` (Tier 3 — Agent-Only Proposals):** Maximum 7-day TTL, never auto-promoted into `decided/` or `observed/`.

### The Two-Zone Output Contract

`veribrain compile` executes locally in Node.js 24 with **zero runtime LLM dependencies** and emits two strictly separated zones separated by `<!-- VERIBRAIN:ZONE_BOUNDARY:A_END -->`:

1. **Zone A (Byte-Frozen Static Prefix):** UTF-8 (no BOM), NFC-normalized, LF-only, sorted canonically by `(priorityRank ASC, ASCII id ASC)`. Contains zero timestamps, zero git SHAs, zero environment names, and zero volatile counters. `zone_a_sha256` is computed post-render so tuning budget scalars or updating `observed/` never changes a single byte of Zone A.
2. **Zone B (Uncached Dynamic Tail):** Fresh `(env, git_sha, ttl)` observations with mandatory 1-line citations (`Based on: <claim_id> (<env>@<sha>)`), plus Tier 3 scars/hypotheses wrapped strictly inside `<untrusted_hint source="scar|hypothesis" id="..." non_authoritative="true">` after NFKC normalization, control/bidi/Unicode-Tag stripping, and full `&`/`<`/`>` XML escaping.

### Fail-Closed Exit Codes & Quarantine Scrubber

Every compile, observe, eval, and diff command runs a linear-time secret, PII, and Shannon-entropy quarantine scrubber across raw text, decoded JSON strings, HTML-comment-stripped `scars.md`, NFKC-normalized text, and final rendered outputs:

- **Exit `2` (`QUARANTINE_VIOLATION`):** Aborts with zero `stdout` bytes, zero disk writes, and zero raw secret echo (`<redacted-claim-id>` / `<redacted-field>`).
- **Exit `3` (`BUDGET_INFEASIBLE`):** If Zone A or pinned `P0`/`P1` invariants exceed `--max-tokens`, compilation aborts rather than silently truncating critical rules. Otherwise Zone B evicts deterministically (`hypotheses -> oldest scars -> P2 observed`) with explicit `[EVICTED: <id>, reason=token_budget]` notices.
- **Exit `4` (`PROVENANCE_VIOLATION`):** Rejects agent self-attestation (`VERIBRAIN_AGENT_MODE=1|true|yes`, agent `VERIBRAIN_CALLER_ROLE`, or invalid `issuer`/`signed_by`).

---

## 4. Why 6/6 Reviewers Killed Nightly Sleep Bots for a 5-Bullet Git Diff

Instead of waking up to a 3-page AI summary that invites rubber-stamping, `veribrain diff` runs pure local Git diff + `.brain/` parsing at **$0.00 and 0 LLM tokens**, capped strictly at **<= 5 plain-English bullets, <= 25 lines, <= 80 ASCII columns**:

```text
VeriBrain Weekly Diff (window: 7d, showing 2 of 2)
Delta: 1 expired observed | 1 aging/unlinked scars | 0 pending hyp
1. [SCAR] SCAR-014: expired 2026-11-20, missing test file
   Action: [Keep] [Revert] [Promote to DECIDED]
2. [OBS] OBS-staging-health (staging) expired 2026-11-24
   Action: [Keep] [Revert] [Promote to DECIDED]
Next: edit .brain/ then run veribrain eval --strict.
```

---

## 5. Stage 1 & Stage 2 Proof: Benchmarks, Not Vibes

Every metric below is reproducible directly from committed repository artifacts: Stage 1 Golden suite records in `QUALITY.md`, Stage 2 JSON telemetry under `benchmarks/results/` (`latency-observed.json`, `redteam-observed.json`, `ai-studio-live.json`), our FinOps ledger in `docs/finops-ledger.md` (**$0.4851** cumulative upper-bound spend across 3 live Gemini 4 calibration runs — including **$0.1765** on the final stateful A/B run — well under our $5.00 cap), and the offline grounding notebook at `benchmarks/notebooks/veribrain_stage2_wind_tunnel.ipynb`.

### Benchmark 1: Local Compile Latency (100 Sequential Runs, $0.00)

| Corpus & Mode (Node v26.13.1, Windows 11 NTFS) | Files / Zone A | p50 | p95 | Hash Identity | Gate (< 15 ms) |
| :--- | :--- | ---: | ---: | :---: | :---: |
| **Stage 1 Canonical (39 files, warm stat-validated; `QUALITY.md`)** | 39 files | 4.34 ms | **5.67 ms** | **100/100** | **PASS** |
| **Stage 1 Read-Only Shadow-Compile (5 real governance docs; `QUALITY.md`)** | 11 files / 8,372 est. tok | — | **4.11 ms** | **100/100** | **PASS** |
| **Stage 2 Gemini 4 Corpus (45 files, warm stat-validated; `latency-observed.json`)** | 45 files / 5,867 est. tok | 8.48 ms | **12.62 ms** | **100/100** | **PASS** |
| **Stage 2 Gemini 4 Corpus (45 files, cold disk NTFS; `latency-observed.json`)** | 45 files / 5,867 est. tok | 52.65 ms | **99.48 ms** | **100/100** | ~7.9x slower cold |

*Engineering Lesson:* Sequential Windows NTFS file opens drove cold-disk compilation to `52.65 ms` p50 / `99.48 ms` p95. Adding a fail-closed, stat-validated raw-UTF-8-bytes cache (verifying `(dev, ino, size, mtimeMs, ctimeMs)` + a 50 ms freshness guard while still re-running 100% of quarantine, parsing, and hashing on every call) cut warm latency to `8.48 ms` p50 / `12.62 ms` p95 (`~7.9x` faster p95) without risking stale reads or quarantine bypasses. Chart: [chart-1-latency.svg](../benchmarks/charts/chart-1-latency.svg).

### Benchmark 2: Real Gemini 4 `countTokens` Calibration (All 9 Live Payloads)

| Payload Class (`benchmarks/results/ai-studio-live.json`) | Est. Tokens (`3.5 B/tok x 1.15`) | Actual `gemini-4-hydrogen` | UTF-8 B / Token | Est. Headroom |
| :--- | ---: | ---: | ---: | :---: |
| **Zone A Small (4 DECIDED, 4,241 B)** | 1,414 | **1,114** | 3.81 | **+26.9% safe** |
| **Zone A Medium (10 DECIDED, 10,038 B)** | 3,343 | **2,519** | 3.98 | **+32.7% safe** |
| **Zone A Canonical (18 DECIDED, 17,623 B)** | 5,867 | **4,318** | 4.08 | **+35.9% safe** |
| **Zone A Gemini 4 Cache Profile (32 DECIDED, 29,982 B)** | 9,984 | **7,112** | 4.22 | **+40.4% safe** |
| **Full Compiled Two-Zone (26,000 B)** | 8,743 | **7,204** | 3.61 | **+21.4% safe** |
| **Zone B `<untrusted_hint>` XML (4,374 B)** | 1,498 | **1,269** | 3.45 | **+18.0% safe** |
| **Zone B Observed + 40-Hex SHAs (3,961 B)** | 1,366 | **1,664** | 2.38 | **-17.9% hex-dense** |
| **Dense JSON Observed Payloads (6,958 B)** | 2,347 | **3,229** | 2.15 | **-27.3% hex-dense** |
| **Dense YAML Frontmatter (64-Hex `sha256_body`, 3,936 B)** | 1,366 | **2,466** | 1.60 | **-44.6% hex-dense** |

*Takeaway:* Across all 9 payloads, Stage 1's deterministic estimator maintained **+21.4% safe conservative headroom** on real compiled Two-Zone prompts (`7,204` actual vs. `8,743` estimated). Pure 40/64-char hex SHA blocks tokenize 1.7x–2.5x denser (`1.60–2.38 B/tok`) than Markdown prose — proving why live tokenizer calibration matters.

### Benchmark 3: Live Gemini 4 Implicit Context Caching A/B (`gemini-4-hydrogen`)

Running two controlled 6-turn sessions with identical `previous_interaction_id` chaining, identical `7,112`-token `DECIDED` policies in `system_instruction`, `thinking_level: "low"`, and `max_output_tokens: 512` (12/12 turns `"status": "completed"`, **$0.1765** upper-bound in `benchmarks/results/ai-studio-live.json`):

- **Arm A (Naive Dynamic Header):** Prepended 6 volatile lines (`turn_index`, `compiled_at_utc`, `latest_observation`) at byte 0 of `system_instruction`.
- **Arm B (VeriBrain Two-Zone):** Kept byte-frozen `7,112`-token Zone A (`sha256: f0cf3d05...`) in `system_instruction`, placing changing Zone B deltas in `input`.

| Turn | Arm A Input | Arm A Cached (%) | Arm B Input | Arm B Cached (%) | Tail Re-Process (`prev_in - cached`) |
| :---: | ---: | ---: | ---: | ---: | :---: |
| **T1 (cold)** | 7,980 | 0 (0.0%) | 7,890 | 0 (0.0%) | initial prefix write |
| **T2** | 8,389 | 0 (0.0%) | 8,301 | **5,841 (70.37%)** | **2,049 tok** |
| **T3** | 8,722 | 0 (0.0%) | 8,639 | **6,252 (72.37%)** | **2,049 tok** |
| **T4** | 9,086 | 0 (0.0%) | 8,991 | **6,590 (73.30%)** | **2,049 tok** |
| **T5** | 9,517 | 0 (0.0%) | 9,362 | **6,942 (74.15%)** | **2,049 tok** |
| **T6** | 9,913 | 0 (0.0%) | 9,745 | **7,313 (75.04%)** | **2,049 tok** |
| **T2–T6 Total** | **45,627** | **0 (0.0%)** | **45,038** | **32,938 (73.13% avg / 75.04% peak)** | **Exact 2,049-tok ceiling** |

*Three Real-World Gemini 4 Caching Discoveries We Didn't Fake:*
1. Setting `max_output_tokens: 48` under Gemini 4's default `thinking_level: "high"` aborted 12/12 turns mid-thought (`"status": "incomplete"`), yielding 0% cache hits.
2. Sending unlinked stateless `POST /v1/interactions` calls (without `previous_interaction_id`) yielded 0.0% cache hits even with 7,112 identical bytes in `system_instruction`.
3. With `previous_interaction_id` enabled on both arms, **Arm A stayed pinned at 0.0% (0 cached tokens)** while **Arm B hit Gemini 4's literal cache ceiling (`prev_input_tokens - 2,049`) on all five follow-up turns** — climbing monotonically from `70.37%` (T2) to `75.04%` (T6), averaging `73.13%` across follow-up turns T2–T6 (`62.23%` overall across all 6 turns including cold T1, `32,938` repeated tokens eligible for Gemini 4's published 95% cached-input discount rate). Mathematically, holding that `2,049`-token tail constant (`(prev_in - 2,049) / prev_in`) projects asymptotically toward `83%–90%` cache hit ratios on longer `12k–20k` token sessions. Chart: [chart-3-prefix-stability.svg](../benchmarks/charts/chart-3-prefix-stability.svg).

### Benchmark 4: 129-Case Adversarial Red-Team Wind Tunnel & Offline Structural Grounding ($0.00)

| Attack Family (`benchmarks/results/redteam-observed.json`) | Cases Passed | Policy Escapes | Secret Canary Leaks |
| :--- | :---: | :---: | :---: |
| `direct_secrets` (GCP, JWT, Bearer, PEM, OpenAI/Anthropic, GH, AWS, Slack, OAuth) | **23 / 23** | 0 | 0 |
| `quarantine_evasion` (JSON `\uXXXX` keys/vals, HTML comment splice, ZW/NFKC/bidi/Tag) | **22 / 22** | 0 | 0 |
| `entropy_smuggling` (fake repo paths, prose hash-ref abuse, `@localhost` userinfo) | **16 / 16** | 0 | 0 |
| `pii_boundary` (emails, phones, whitelist boundary + 3 clean negative controls) | **13 / 13** | 0 | 0 |
| `prompt_injection_breakout` (`</untrusted_hint>`, fullwidth, bidi, Tags, `<system>`) | **21 / 21** | 0 | 0 |
| `provenance_filesystem` (agent denials, tampered SHA, duplicate YAML, traversal, 2099 TTL) | **24 / 24** | 0 | 0 |
| `budget_exhaustion` (eviction order, pinned survival, Exit 3 0-stdout, diff caps) | **10 / 10** | 0 | 0 |
| **Total (125 attacks + 4 clean controls)** | **129 / 129 (100%)** | **0 (0%)** | **0** |

*Why Honest Red-Teaming Paid Off:* Our first unsoftened Wind Tunnel run scored **124/129** and caught **3 real bugs** in our already-audited Stage 1 compiler: a lookbehind bypass on `-`/`_`-prefixed secrets (`OBS-AKIA...`), raw secret echo via untrusted JSON object key names in `stderr`, and duplicate frontmatter exit-code misclassification. Patching all three closed the corpus cleanly to **129/129 (0% escape, 0 canary leaks)**. Chart: [chart-2-redteam-scorecard.svg](../benchmarks/charts/chart-2-redteam-scorecard.svg).

In Google Colab Cell 6 (`benchmarks/notebooks/veribrain_stage2_wind_tunnel.ipynb`), our **$0.00 deterministic offline structural grounding benchmark** (10 policy/citation/containment tasks, non-LLM evaluation): **VeriBrain Cited Two-Zone scored 10/10 (100.0%, 0 stale/uncontained leaks)** vs. **Flat Dump Baseline 6/10 (60.0%, 4 leaks)** vs. **Stale-Context RAG Baseline 1/10 (10.0%, 4 leaks)**.

---

## 6. One Brain Across Every Coding Agent (`npx veribrain mcp`)

In Stage 3, VeriBrain exposes the exact same deterministic compiler over a local **`stdio` MCP server** (`@modelcontextprotocol/sdk`) shared identically by **Antigravity, Claude Code, Cursor, and Codex** — zero cloud servers, zero vector DBs:

| MCP Tool | Authority | Behavior |
| :--- | :--- | :--- |
| `veribrain_compile_context` | Read-only | Returns Zone A (`zone_a_sha256`), Zone B, citations, and token estimates for `(role, env, git_sha)` |
| `veribrain_get_claim` | Read-only | Fetches full quarantine-scrubbed evidence for any `DEC-*`, `OBS-*`, `SCAR-*`, or `HYP-*` ID |
| `veribrain_record_hypothesis` | Tier 3 only | Appends short-TTL (`<= 7d`), scrubbed `HYP-*` JSON via atomic write (never touches `decided/` or `observed/`) |
| `veribrain_propose_scar` | Tier 3 proposal | Validates `regression_test` existence + `< 4 KB` headroom, queues `HYP-SCAR-*` for human `veribrain diff` approval |
| `veribrain_status` | Read-only | Reports `.brain/` health, `scars.md` byte budget, expired claims, and `eval` verdict |

---

## 7. Takeaway & Quickstart (`npx veribrain init`)

You do not need a managed vector database or a nightly LLM memory daemon to give multi-agent engineering teams durable, verifiable memory. Git, deterministic compilation, fail-closed provenance, and KV-cache prefix discipline beat stochastic overnight summarization on cost (**$0.00/mo**), speed (**< 15 ms warm p95**), cache efficiency (**73.13% avg / 75.04% peak live Gemini 4 hits vs. 0.0%**), and security (**0% escape across 129 red-team cases: 125 attacks + 4 clean controls**).

```bash
npx veribrain init --signed-by "Your Name"
npx veribrain eval --strict
npx veribrain compile --role builder --env staging --format json
npx veribrain diff --since 7d
npx veribrain mcp --print-config antigravity
```
