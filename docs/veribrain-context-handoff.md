# VeriBrain — Complete Context Transfer & Architecture Handoff Packet

- **Created:** `2026-11-25` · **Owner:** Ian Mayor (`@neverbeenthemayor`)
- **Repository:** `https://github.com/neverbeenthemayor/veribrain` (`main`, `staging`, `pre-staging`)
- **Local Workspace:** `<repo-root>`
- **External Doc Mirror:** Optional external read-only doc mirror (zero `.git` inside mirror)
- **Bootstrap Baseline:** AI-Native Multi-Chief Startup Playbook `v2.0` (`bootstrap_startup.py --verify` passing)

> **Purpose:** This document transfers 100% of VeriBrain's origin story, 6-Chief adversarial red-team decisions, locked technical architecture, tooling tiers, and weekend schedule into VeriBrain's own standalone project — ensuring **complete separation** from any external Customer-Zero repository.

---

## 1. Origin Story & The 6-Chief Cynical Peer Review (v1 -> Hardened v2)

VeriBrain began on `2026-11-25` as a curiosity-driven exploration of the "shared brain" pattern emerging across AI engineering teams (Meta, Google, Netflix, Microsoft, NVIDIA). Rather than building an uncritical v1 prototype (markdown/vector store + nightly LLM "sleep consolidation" bot), Owner Ian Mayor put v1 through a **cynical, constructive 6-Chief teardown**:

1. **Chief Builder:** Flagged unbounded markdown dumps and brittle file-path watches that break silently on refactors. Mandated a **typed Git-native `.brain/` store** (`decided/`, `observed/` keyed by `(env, git_sha, ttl_seconds)`, `scars.md` `< 4 KB` / 30-day TTL linked to regression tests) and enforcing critical architectural facts via fast Vitest/CI invariants.
2. **Chief Infrastructure Engineer (CIE):** Flagged that injecting volatile facts at the top of prompts destroys LLM prefix **KV caching**, and naive file hashing causes false cache misses on comments/whitespace. Mandated a **Two-Zone deterministic compiler** driven by *semantic* config key hashing (**Zone A** byte-frozen static prefix vs. **Zone B** uncached dynamic tail).
3. **Chief Quality Engineer (CQE):** Flagged silent truncation of `P0`/`P1` constraints under tight token budgets and stale cloud truth leaking across branches. Mandated a **`$0` Golden Context Eval** in CI asserting Zone A byte-identity, zero silent `P0`/`P1` eviction, `(env, git_sha, ttl)` expiry, and quarantine enforcement.
4. **Chief Security Agent:** Flagged agent self-attestation (`LLM -> authoritative memory`) as a persistent indirect prompt-injection and secret-exfiltration vector. Mandated **fail-closed provenance** (agents emit short-TTL `HYPOTHESIS` only; CI/hooks emit `OBSERVED`; Owner signs `DECIDED`), an automated regex+entropy PII/secret quarantine scrubber (`exit 2`), and mandatory `<untrusted_hint source="scar" non_authoritative="true">` wrapping.
5. **Chief User Design Engineer (CUDE):** Flagged nightly LLM prose digests as a guaranteed source of **rubber-stamp fatigue**. Mandated replacing nightly summaries with a **Weekly 1-Screen Brain Diff** (`<= 5` plain-English bullets, `<= 25` lines total, secret-scrubbed, explicit Keep / Revert / Promote actions).
6. **Chief FinOps Engineer (CFOE):** Flagged nightly LLM sleep consolidation as burning `50k–200k` tokens/night while mutable prompt prefixes forfeit `80%+` KV-cache savings. Result: **UNANIMOUS `6/6` KILL on nightly LLM sleep consolidation**, replaced by a **`$0.00` local deterministic context compiler**.

---

## 2. Locked Owner Decisions (`2026-11-25`)

- **Decision A1 (Strict Physical & Project Separation):** VeriBrain operates in its own project workspace, its own local Git repo (`<repo-root>`), its own GitHub repo (`neverbeenthemayor/veribrain`), and its own optional external doc mirror. **ZERO writes to external Customer-Zero repositories** (enforced via `VERIBRAIN_ISOLATION_SEGMENTS`). Any Stage 1 shadow-compile test against external docs runs **strictly read-only**.
- **Decision A2 (Weekends-Only Cadence):** Weekday focus stays on Customer-Zero production priorities. VeriBrain Stage 0 docs are locked on Wed `2026-11-25`; **Stage 1 CLI build kicks off Sat `2026-11-28` at `09:00 AM PHT`**.
- **Decision A3 (Runtime Stack):** **TypeScript 5.x + Node.js 24 LTS (ESM) + Vitest** for zero-friction open-source `npx veribrain init` packaging and official `@modelcontextprotocol/sdk` support for Stage 3 local `stdio` MCP.
- **Tier 1 Tool Promotion:** Owner promoted **Google Docs / Slides (`gdocs` / `gslides`)** to **Tier 1** so every Stage 2 Colab & AI Studio benchmark feeds directly into a Build-in-Public engineering blog post and 10-slide benchmark talk deck.

---

## 3. Locked Tooling Arsenal (Tier 1 vs. Excluded)

| Tier | Tools | Exact Purpose in VeriBrain |
| :--- | :--- | :--- |
| **Tier 1 (Core)** | **TypeScript 5.x + Node.js 24 + Vitest + Git + GitHub Actions** | `$0` deterministic compiler (`init`, `compile`, `eval`, `diff`, `observe`), fail-closed CI provenance & Golden Context Eval |
| **Tier 1 (Bridge)** | **Antigravity + Local `stdio` MCP (`@modelcontextprotocol/sdk`)** | Stage 3 cross-client local server for Antigravity, Claude Code, Cursor, and Codex |
| **Tier 1 (Wind Tunnel)** | **Google Colab (AI Ultra)** | Stage 2 offline A/B benchmark harness + `100+` adversarial prompt-injection & poisoning attack suite |
| **Tier 1 (Telemetry)** | **Google AI Studio (`countTokens` + Context Caching)** | Real Gemini tokenizer budget calibration + live `cachedContentTokenCount` KV-cache hit verification |
| **Tier 1 (Publishing)** | **Google Docs & Google Slides (`gdocs` / `gslides`)** | Build-in-Public engineering blog post + companion 10-slide benchmark talk deck |
| **Excluded (Do Not Use)** | Managed Vector DBs, Firestore, Cloud Run as brain store; Google Flow, Veo, Project Genie, Figma, Semrush | Busts KV caches, introduces cloud latency/poisoning surface, or irrelevant to a deterministic CLI/MCP tool |

---

## 4. Weekend Roadmap (Stages 0–4) & Target Metrics

- **Stage 0 (`2026-11-25` — COMPLETE):** Lock [`RFC-001`](./RFC-001-veribrain-architecture.md), [`blog-outline-veribrain.md`](./blog-outline-veribrain.md), Playbook `v2.0` Multi-Chief repo, and private GitHub remote.
- **Stage 1 (`Sat 2026-11-28` Weekend — Gate 1):** Scaffold TypeScript/Node 24 + Vitest package, implement the `~300`-line `$0` deterministic compiler (`init`, `compile`, `eval`, `diff`, `observe`), pass all 5 Golden Context Eval suites, run strictly read-only shadow-compile test, and export blog prose skeleton to Google Docs via `gdocs` upon Owner approval.
- **Stage 2 (`Sat 2026-12-05` Weekend — Gate 2):** Run Google AI Studio (`countTokens` + `cachedContentTokenCount`) calibration & Google Colab `100+`-attack red-team suite; embed empirical charts into Google Docs & Google Slides.
- **Stage 3 (`Sat 2026-12-12` Weekend — Gate 3):** Ship local `stdio` MCP (`npx veribrain mcp`) exposing read-only/fail-closed tools across Antigravity, Claude Code, Cursor, and Codex.
- **Stage 4 (`Sat 2026-12-19` Weekend — Gate 4):** Open-source packaging audit (`npx veribrain init`), final Red/Blue security sign-off, publish blog post & 10-slide talk deck.

### Target Empirical Hypotheses (To Prove in Stage 2 — Never Fabricate)
- **KV-Cache Prefix Hit Rate:** `80%–92%` (vs. `0%–25%` naive dynamic injection)
- **Local Compile Latency:** `< 15 ms` p95 (`0` LLM calls)
- **Nightly Maintenance Burn:** `$0.00` (`0` tokens vs. `50k–200k` tok/night sleep bots)
- **Policy Poisoning Escape Rate:** `0%` into Zone A / `DECIDED` / `OBSERVED`
