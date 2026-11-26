# VeriBrain — Product Specification

- **One-Line Pitch:** Zero-dollar deterministic, provenance-verified context compiler and local stdio MCP shared brain for multi-agent engineering.
- **Target Market:** Solo founders, staff engineers, and AI-native dev teams running Antigravity, Claude Code, Cursor, and Codex.
- **Core Stack:** TypeScript 5.x + Node.js 24 LTS (ESM) + Vitest + Git/GitHub Actions + Local `stdio` MCP (`@modelcontextprotocol/sdk`) + Google Colab / AI Studio + Google Docs / Slides (`gdocs` / `gslides`).
- **Target `v1.0` Open-Source Release:** `2026-12-20` (4 weekend sprints).
- **Authoritative Technical Spec:** [`docs/RFC-001-veribrain-architecture.md`](./RFC-001-veribrain-architecture.md) · **Origin Context:** [`docs/veribrain-context-handoff.md`](./veribrain-context-handoff.md)

---

## 1. Core Developer Workflow (Stages 1–4)

1. **Initialize Typed `.brain/` Store (`npx veribrain init`):** Scaffolds Git-versioned `decided/` (human-signed immutable), `observed/` (CI/hook facts keyed by `(env, git_sha, ttl_seconds)`), `hypotheses/` (agent-only short TTL), `scars.md` (`< 4,096 B`, `<= 30d` TTL + regression test link), and `config.json`.
2. **Compile Two-Zone Context (`veribrain compile --role <r> --env <e>`):** Pure deterministic local TypeScript (`0` LLM calls, `< 15 ms` p95) emitting a **byte-frozen Zone A static prefix** (preserving `80%–92%` LLM KV-cache hits) plus an **uncached Zone B dynamic tail** with mandatory `"Based on: <claim_id> (<env>@<sha>)"` citations and `<untrusted_hint>` scar sandboxing.
3. **Gate in CI & Review Weekly (`veribrain eval` & `veribrain diff`):** Runs `$0` Golden Context Eval on every PR/commit and replaces nightly LLM sleep bots with a 1-screen `<= 5`-bullet, `<= 25`-line secret-scrubbed Weekly Brain Diff (`Keep / Revert / Promote`).
4. **Share Across Every Coding Agent (`npx veribrain mcp`):** Stage 3 local `stdio` MCP server exposing compiled context and Tier 3 hypothesis proposals identically to Antigravity, Claude Code, Cursor, and Codex without any cloud vector DB.

---

## 2. Non-Functional Bars

- **Zero Runtime Cost:** `$0.00` local compilation and `$0.00` nightly maintenance (`0` background LLM calls).
- **Deterministic Latency:** `< 15 ms` p95 local compilation across 100 consecutive runs.
- **Fail-Closed Safety:** Exit code `2` on secret/PII quarantine violation; exit code `3` if pinned `P0`/`P1` `DECIDED` invariants cannot fit inside `--max-tokens` (zero silent truncation).
- **Build-in-Public Transparency:** Every performance, KV-cache, and red-team number published in [`docs/blog-outline-veribrain.md`](./blog-outline-veribrain.md) (`gdocs`/`gslides`) must come strictly from reproducible Stage 1 & Stage 2 runs.
