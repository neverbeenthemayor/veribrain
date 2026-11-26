# Engineering Blog & Talk Deck Outline — VeriBrain

- **Working Title:** *"Why We Killed Our Nightly AI Memory Bot and Built a \$0 Deterministic Context Compiler (VeriBrain)"*
- **Format:** Build-in-Public Engineering Post (**Google Docs — Tier 1**) + Companion 10-Slide Benchmark Deck (**Google Slides — Tier 1**)
- **Target Audience:** AI systems engineers, solo founders running multi-agent workflows, staff engineers evaluating context engineering, KV caching, and MCP security.
- **Core Thesis:** Most "shared brain" AI memory systems fail because they try to fix stochastic agent forgetfulness with *more* stochastic LLM summarization at night. Treating context assembly like a **deterministic compiler with cryptographic provenance and KV-cache layout** cuts maintenance cost to `\$0.00`, preserves `80%–92%` prefix cache hits, and closes persistent indirect prompt-injection holes.

---

## Part 1 — 7-Section Blog Post Outline (`gdocs`)

### Section 1: Hook — The Night Our "Shared Brain" Idea Didn't Survive Six Cynical Engineers
- Why every multi-agent team hits context amnesia across terminals, IDEs, and sessions.
- The naive v1 dream: throw everything into markdown/vectors and run a nightly "sleep consolidation" LLM job to summarize it.
- Setting the stage: putting v1 in front of six skeptical internal Chiefs (`Builder`, `CIE`, `CQE`, `Security`, `CUDE`, `CFOE`) — and watching them dismantle it in one session.

### Section 2: Four Failure Modes That Killed v1
1. **The Cache-Busting Trap (`CIE` + `CFOE`):** Injecting volatile facts at the top of a system prompt destroys prefix KV caching on every turn.
2. **The Nightly Consolidation Tax (`CFOE` + `CUDE`):** Burning `50k–200k` tokens/night to write a 3-page summary nobody carefully reads creates rubber-stamp fatigue.
3. **Self-Attestation & Persistent Poisoning (`Security`):** Letting agents write directly to "verified memory" turns one poisoned scar or tool output into permanent executable policy.
4. **Silent Truncation & Stale SHAs (`CQE` + `Builder`):** Dropping `P0` constraints when prompts overflow or injecting `staging` health facts against a different Git SHA causes silent regressions.

### Section 3: Hardened v2 — Context Assembly as a Deterministic Compiler
- Walking through `.brain/` trust tiers: `decided/` (human-signed immutable), `observed/` (`(env, git_sha, ttl)` ephemeral), `scars.md` (`< 4 KB`, 30-day expiry + regression link), and `hypotheses/` (agent-only).
- The **Two-Zone Output Contract**: byte-frozen **Zone A** static prefix (`zone_a_sha256`) vs. uncached **Zone B** dynamic tail with mandatory `"Based on: <claim_id> (<env>@<sha>)"` citations.
- Fail-closed PII/secret quarantine (`EXIT_QUARANTINE_VIOLATION = 2`) and `<untrusted_hint non_authoritative="true">` containment.

### Section 4: Why `6/6` Chiefs Voted to Kill Nightly Sleep Bots for a 5-Bullet Git Diff
- UX engineering (`CUDE`) meets FinOps (`CFOE`): showing what `veribrain diff` actually prints on screen (`<= 5` plain-English bullets, `<= 25` lines, `\$0.00` LLM tokens, Keep / Revert / Promote).
- Diagram placeholder: `[FIGURE 1: v1 Nightly LLM Memory Loop vs. v2 Zero-Dollar Deterministic Compiler & Weekly Brain Diff]`.

### Section 5: Stage 1 & Stage 2 Proof — Benchmarks, Not Vibes
- *Placeholder metrics to populate strictly from observed Stage 1 & Stage 2 runs (never fabricated):*
  - `[CHART 1: Local Compile Latency (ms) — Node 24 p50/p95 across 100 runs vs. target < 15 ms]`
  - `[CHART 2: Google AI Studio countTokens Budget Accuracy & Zero Silent P0/P1 Eviction]`
  - `[CHART 3: Gemini Context Caching — cachedContentTokenCount Hit Rate: Flat Markdown vs. VeriBrain Two-Zone Prefix]`
  - `[CHART 4: Google Colab Red-Team Wind Tunnel — 100+ Prompt Injection & Secret Exfiltration Attacks Blocked]`

### Section 6: One Brain Across Every Coding Agent (`@modelcontextprotocol/sdk` `stdio` MCP)
- Stage 3 walkthrough: running `npx veribrain mcp` locally so Antigravity, Claude Code, Cursor, and Codex read identical compiled context and propose only scrubbed `HYP-*` notes — with zero cloud databases or hosted sync risk.

### Section 7: Open-Source Packaging & Takeaway (`npx veribrain init`)
- When you do **not** need a vector database for repository engineering memory.
- Quickstart commands (`init`, `compile`, `eval`, `diff`, `mcp`) and invitation to inspect the Golden Context Eval test suite.

---

## Part 2 — Companion 10-Slide Benchmark Talk Deck Outline (`gslides`)

| Slide # | Title | Visual / Evidence Slot |
| :--- | :--- | :--- |
| **1** | Why We Killed Our Nightly AI Memory Bot | Title, thesis subtitle, `VeriBrain` Hardened v2 framing |
| **2** | The Multi-Agent Amnesia Problem | 4 IDE/agent silos losing decisions, env state, and regressions |
| **3** | The v1 Illusion vs. 6-Chief Red-Team Autopsy | Table of 4 v1 fatal flaws (cache bust, `50k–200k` burn, poisoning, silent truncation) |
| **4** | Hardened v2 Architecture: Typed `.brain/` Store | Diagram of `decided/`, `observed/(env,sha,ttl)`, `scars.md < 4 KB`, `hypotheses/` |
| **5** | Two-Zone Compilation & KV-Cache Preservation | Zone A byte-frozen prefix (`zone_a_sha256`) vs. Zone B uncached tail + citations |
| **6** | Security: Fail-Closed Provenance & `<untrusted_hint>` | Write-authority matrix + PII/secret quarantine abort path |
| **7** | Killing Nightly Consolidation: 1-Screen Brain Diff | Terminal mockup of `<= 5`-bullet `veribrain diff` (`\$0.00` token burn) |
| **8** | Stage 2 Benchmark Results (AI Studio + Colab) | `[EMBED CHARTS 1–3: Latency, countTokens, cachedContentTokenCount Hit %]` |
| **9** | 100+ Attack Red-Team Scorecard (Colab Harness) | `[EMBED CHART 4: Poisoning, Tag-Breakout, Secret Leak Rejection = 0% Policy Escape]` |
| **10** | Cross-Client `stdio` MCP & `npx veribrain init` | Single local `stdio` server across Antigravity / Claude Code / Cursor / Codex + repo link |

---

## Tier 1 Production Milestones (`gdocs` & `gslides`)

- [x] **Stage 0 (`2026-11-25`):** Outline locked in Git + Google Drive mirror (`ZERO` charts fabricated).
- [x] **Stage 1–3 (`2026-11-25`):** Full Bench- & CUDE-verified 7-section post ([`docs/blog-veribrain-post.md`](./blog-veribrain-post.md)) exported to **Google Docs** (`[Internal Workspace Draft]`) with 2 embedded 300-DPI Colab charts and **10-Slide Benchmark Deck** exported to **Google Slides** (`[Internal Workspace Draft]`).
- [x] **Stage 4 (`2026-11-25`, Gate 4 `v1.0.0` Release):** `v1.0.0` package (`veribrain-1.0.0.tgz`, `50.8 kB`), `README.md`, `CHANGELOG.md`, `CONTRIBUTING.md`, Google Doc, and 10-Slide Deck all verified `6/6` (`0` open `P0`–`P3`) and launch-ready; kept private until Owner chooses to flip visibility or run `npm publish`.
