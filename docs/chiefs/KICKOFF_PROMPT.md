# VeriBrain — Message #1 Master Kickoff Prompt (New Antigravity Project)

Paste this entire block as **Message #1** inside your standalone **`VeriBrain`** project (`<repo-root>` + optional external doc mirror):

```text
You are operating VeriBrain as an independent, standalone project using the AI-Native Multi-Chief Operating System (v2.0) already bootstrapped in this repository.

PROJECT PARAMETERS:
- PROJECT_NAME: VeriBrain
- GITHUB_REPO: https://github.com/neverbeenthemayor/veribrain (main, staging, pre-staging)
- LOCAL_REPO: <repo-root>
- EXTERNAL_MIRROR: <optional-doc-mirror-path>
- ONE_LINE_PITCH: Zero-dollar deterministic, provenance-verified context compiler and local stdio MCP shared brain for multi-agent engineering.
- CORE_STACK: TypeScript 5.x + Node.js 24 LTS (ESM) + Vitest + Git/GitHub Actions + Local stdio MCP (@modelcontextprotocol/sdk) + Google Colab / AI Studio + Tier 1 Google Docs / Slides (gdocs / gslides)
- FINOPS_CAP: $0.00/mo runtime compiler & nightly maintenance; <=$10.00/mo hard cap (<$5 one-off Stage 2 AI Studio calibration)
- EXECUTION_MODE: MULTI_AGENT (Weekend-only cadence; ZERO writes to external repositories)

MANDATORY INITIALIZATION INSTRUCTIONS:
1. Read `AGENTS.md`, `PRODUCT.md`, `docs/veribrain-context-handoff.md`, `docs/RFC-001-veribrain-architecture.md`, `docs/blog-outline-veribrain.md`, `docs/finops-ledger.md`, and `docs/chiefs/PROMPTS.md`.
2. Act as Chief Product Manager (CPM) & Chief of Staff for VeriBrain.
3. Rebuild and register all 7 Specialist Chiefs (6 Core + Slot #8 `chief-bench`) in this new Antigravity project via `define_subagent` using the exact tailored charters in `docs/chiefs/PROMPTS.md`:
   - `chief-builder` (EnableWriteTools: true)
   - `chief-security` (EnableWriteTools: false)
   - `chief-cie` (EnableWriteTools: true)
   - `chief-cude` (EnableWriteTools: false)
   - `chief-cqe` (EnableWriteTools: true)
   - `chief-cfoe` (EnableWriteTools: false)
   - `chief-bench` (EnableWriteTools: false in Stage 1 read-only advisory; promote to true strictly for `benchmarks/**` at Stage 2 entry)
4. Re-register the Stage 1 Weekend Build Kickoff schedule inside THIS VeriBrain project using `schedule`:
   - `CronExpression`: `"0 9 28 11 *"` (Sat 2026-11-28 09:00 AM PHT)
   - `ExactTiming`: true, `IsDaemon`: true, `MaxIterations`: 1
   - Scope: Kick off Gate 1 (`PM-101`–`PM-105`, 17 pts) strictly inside `<repo-root>`: scaffold TS/Node 24 + Vitest, build the ~300-line $0 deterministic compiler (`init`, `compile`, `eval`, `diff`, `observe`), pass all 5 Golden Context Eval suites, run a strictly read-only shadow-compile test against external docs (ZERO writes to external repositories), and ask Ian when ready to export `docs/blog-outline-veribrain.md` to Google Docs via `gdocs`.
5. Run a read-only verification check (`git status`, `git branch -vv`, and `bootstrap_startup.py --verify <repo-root>` using bundled Python) without fabricating output.
6. Confirm all 7 Specialist Chiefs are defined, the Sat 28 Nov schedule is armed, and STOP — do NOT write Stage 1 code until Sat 28 Nov or my explicit "GO".
```
