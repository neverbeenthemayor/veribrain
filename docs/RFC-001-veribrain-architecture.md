# RFC-001: VeriBrain Architecture (Hardened v2)

- **Status:** `LOCKED (Stage 0 — Ready for Sat 2026-11-28 Stage 1 Weekend Build)`
- **Date:** `2026-11-25`
- **Runtime & Packaging:** TypeScript 5.x, Node.js 24 LTS (ESM), Vitest, zero runtime LLM SDK dependencies in core compiler, distributable via `npx veribrain <cmd>`
- **Stage 3 Bridge Dependency:** `@modelcontextprotocol/sdk` (local `stdio` transport only)

---

## 1. Problem Statement & 6-Chief Red-Team Critique Summary

Shared-memory frameworks for multi-agent engineering commonly degrade into expensive, noisy, or compromised prompt prefixes. Before writing implementation code, VeriBrain v1 was subjected to an adversarial review by six engineering specialists:

| Chief | v1 Vulnerability Identified | Hardened v2 Design Mandate |
| :--- | :--- | :--- |
| **Builder** | Unstructured markdown knowledge dumps + brittle file-path watches fail silently on refactors. | Typed Git-native `.brain/` store (`decided/`, `observed/`, `scars.md` `< 4 KB` / 30d TTL + regression test link); architectural invariants enforced by fast Vitest/CI checks. |
| **CIE** | Dynamic memory injection at the top of prompts invalidates KV caches; naive file hashing triggers spurious rebuilds on timestamps/comments. | Two-Zone prompt compilation (**Zone A** byte-frozen static prefix vs. **Zone B** uncached dynamic tail) driven by *semantic* config key hashing. |
| **CQE** | No deterministic check prevents silent truncation of `P0`/`P1` rules or stale environment claims leaking across branches. | `$0` Golden Context Eval in CI asserting prefix byte-identity, zero silent P0/P1 eviction, `(env, git_sha, ttl)` expiry, and quarantine enforcement. |
| **Security** | Agents writing directly to authoritative memory creates persistent indirect prompt-injection & secret-exfiltration channels. | Fail-closed provenance matrix (`HYPOTHESIS` only from agents), automated PII/secret quarantine scrubber, and mandatory `<untrusted_hint>` sandboxing for scars. |
| **CUDE** | Nightly LLM digests produce walls of prose nobody audits (`rubber-stamp fatigue`). | Replaced nightly summarization with a 1-screen weekly **Brain Diff** (`<= 5` bullets, `<= 25` lines, Keep/Revert/Promote actions). |
| **CFOE** | Nightly LLM sleep consolidation burns `50k–200k` tokens/night while mutable prefixes forfeit `80%+` KV-cache savings. | Unanimous `6/6` kill on nightly LLM sleep bot; `$0` local deterministic compiler preserving stable KV-cache prefixes. |

---

## 2. `.brain/` Storage Schema & Trust Tiers

All VeriBrain state lives inside a plain, Git-tracked `.brain/` directory at repository root.

```text
.brain/
  config.json                # Compiler budgets, semantic key schemas, pinned P0/P1 IDs
  decided/                   # Tier 1 Trust: human-signed immutable decisions (*.md + YAML frontmatter)
    DEC-001-runtime.md
  observed/                  # Tier 2 Trust: CI/hook-verified facts keyed by (env, git_sha, ttl_seconds)
    OBS-staging-health.json
  hypotheses/                # Tier 3 Trust: agent-proposed notes (short TTL, non-authoritative)
    HYP-2026-11-28-001.json
  scars.md                   # Tier 3 Caution: capped < 4,096 B, <= 30d TTL, regression-test linked
```

### Record Schemas

1. **`decided/*.md` (Immutable Human-Signed Policy)**
   - Required frontmatter: `id`, `priority` (`P0` | `P1` | `P2`), `roles` (`string[]`), `signed_by`, `signed_at_utc`, `sha256_body`, `status` (`active` | `superseded`).
   - Immutability rule: modifying an active `decided/` rule requires either a new `DEC-*` superseding record or a fresh human signature.
2. **`observed/*.json` (Machine-Verified Ephemeral Truth)**
   - Required fields: `claim_id`, `env` (`local` | `pre-staging` | `staging` | `prod`), `git_sha`, `observed_at_utc`, `ttl_seconds`, `issuer` (`ci` | `git-hook` | `verifier-script`), `roles`, `summary`, `evidence_ref`.
   - Expiration invariant: expired (`now > observed_at_utc + ttl_seconds`) or mismatched `env`/`git_sha` claims are excluded by `compile` (never silently treated as current).
3. **`scars.md` (Bounded Failure Memory)**
   - Hard file size ceiling: `< 4,096` bytes UTF-8.
   - Required fields per entry: `scar_id`, `created_at_utc`, `expires_at_utc` (`<= 30` days), `regression_test` (file path + test name), `hint` (single factual anti-pattern).
   - Entries missing `regression_test` or past `expires_at_utc` fail `veribrain eval` / are pruned cleanly during `veribrain diff`.
4. **`hypotheses/*.json` (Agent-Only Proposals)**
   - Short default TTL (`<= 7` days), isolated from Zone A, never promoted automatically.

---

## 3. Fail-Closed Provenance Matrix & Quarantine Scrubber

### Write-Authority Matrix

| Trust Tier / Artifact | LLM / Coding Agent | Local Git Hook / CI Pipeline | Human Owner |
| :--- | :--- | :--- | :--- |
| `decided/*.md` | **DENY (Fail Closed)** | Validate signature only | **ALLOW (Signed)** |
| `observed/*.json` | **DENY (Fail Closed)** | **ALLOW (Deterministic Attestation)** | **ALLOW** |
| `hypotheses/*.json` | **ALLOW (Short TTL)** | Validate schema & scrub | **ALLOW** |
| `scars.md` | Propose via `HYP` only | Enforce `< 4 KB`, TTL & test link | **ALLOW (Promote/Prune)** |

### PII / Secret Quarantine Scrubber
Before `compile`, `observe`, or `diff` emits output (and enforced in CI):
- Scans all inputs against high-precision secret & PII regexes (GCP/Gemini keys `AIza...`, Bearer/JWT tokens, PEM private blocks, OAuth client secrets, personal emails/phones unless explicitly whitelisted, high-entropy hex/base64 strings `>= 32` chars).
- **Fail-Closed Policy:** Any match aborts compilation with non-zero exit code (`EXIT_QUARANTINE_VIOLATION = 2`), names the offending `claim_id`/line number without echoing the raw secret, and blocks artifact emission.

### Non-Authoritative Hint Sandboxing
All `scars.md` and `hypotheses/` items injected into Zone B MUST be wrapped strictly inside explicit boundary tags and escaped against closing-tag breakouts:

```xml
<untrusted_hint source="scar" id="SCAR-014" regression_test="tests/eval.test.ts#L42" non_authoritative="true">
Do not rewrite static prefix ordering when appending environment deltas.
</untrusted_hint>
```

Agents and system instructions treat `<untrusted_hint>` strictly as advisory context — never executable policy or credential instructions.

---

## 4. `$0` Deterministic Context Compiler Design

- **Zero Runtime LLM Calls:** Pure synchronous/filesystem TypeScript (`0` network calls, target `< 15 ms` runtime).
- **Semantic Config Key Hashing:** Hash only stable semantic keys (`role`, sorted `decided` IDs + body hashes, normalized `config.json` budget settings) rather than volatile timestamps, comments, or whitespace, preventing spurious Zone A cache invalidation.

### Strict Two-Zone Compiled Output

1. **Zone A — Byte-Frozen Static Prefix (KV-Cache Target: `80%–92%` hits)**
   - Header metadata (`schema_version`, `role`, `zone_a_sha256`).
   - Role contract + all active `DECIDED` rules matching `role`, canonically sorted by `(priority ASC, id ASC)`.
   - Zero timestamps, zero git SHAs, zero volatile counters anywhere inside Zone A.
2. **Zone B — Uncached Dynamic Tail**
   - Fresh, non-expired `OBSERVED` records filtered by `--env` and optional `--git-sha`, sorted deterministically by `claim_id`.
   - Every factual `OBSERVED` or `DECIDED` assertion rendered with a mandatory 1-line citation:
     `Based on: <claim_id> (<env>@<sha>)`
   - Active `<untrusted_hint>` scars (bounded, sanitized) + optional explicit truncation manifest if token budget required Zone B eviction.

### Deterministic Overflow Eviction Policy
Given `--max-tokens <N>` (estimated deterministically via configurable chars/token ratio in Stage 1, calibrated against AI Studio `countTokens` in Stage 2):
1. **Invariant:** `P0` and `P1` `DECIDED` records are **never** silently truncated. If Zone A alone exceeds `--max-tokens`, `veribrain compile` **fails closed** (`EXIT_BUDGET_INFEASIBLE = 3`) rather than dropping safety/architecture invariants.
2. Overflow eviction removes lowest-priority Zone B items first in strict deterministic order: `hypotheses` → oldest non-critical `scars` → lowest-priority `P2` `observed` records, always emitting an explicit `[EVICTED: <id>, reason=token_budget]` notice in Zone B.

---

## 5. Weekly 1-Screen Brain Diff (`veribrain diff`)

Replacing nightly LLM sleep consolidation (`6/6` Chief kill):
- Aggregates changes over the past window (`--since 7d`) using pure Git diff + `.brain/` metadata parsing (`0` LLM tokens).
- Outputs a fixed 1-screen terminal/markdown digest:
  - **Hard Limits:** `<= 5` plain-English bullets, `<= 25` total lines, guaranteed secret-scrubbed.
  - Shows: newly expired `observed/` claims, aging/unlinked `scars.md` entries, pending `hypotheses/` awaiting Owner decision, and explicit `[Keep] / [Revert] / [Promote to DECIDED]` checklist prompts for Friday Retro.

---

## 6. Stage 1 CLI Surface

Packaged under `bin: { "veribrain": "./dist/cli.js" }` for `npx veribrain <command>`:

| Command | Purpose |
| :--- | :--- |
| `veribrain init` | Scaffolds `.brain/` (`config.json`, sample `decided/`, `observed/`, `scars.md`) in target repo |
| `veribrain compile --role <role> --env <env> [--git-sha <sha>] [--max-tokens <n>] [--format md\|json]` | Deterministically compiles Zone A + Zone B context artifact and prints `zone_a_sha256` & latency |
| `veribrain observe --claim-id <id> --env <env> --git-sha <sha> --ttl <sec> --summary <text> --evidence <ref>` | Writes a validated Tier 2 `observed/` JSON record after running quarantine scrubber |
| `veribrain eval [--strict]` | Runs the `$0` deterministic invariant & quarantine checks across `.brain/` |
| `veribrain diff [--since 7d]` | Renders the `<= 5`-bullet, `<= 25`-line secret-scrubbed Weekly Brain Diff |

---

## 7. Stage 1 `$0` Golden Context Eval Assertions (Vitest CI Gate)

Every Stage 1 build MUST pass five non-negotiable deterministic test suites:
1. **Byte-Identical Zone A Prefix:** Compiling twice with updated `observed/` facts, reordered JSON keys, or new timestamps produces the **exact same SHA-256** for Zone A.
2. **Zero Silent `P0`/`P1` Truncation:** Under an artificially tight `--max-tokens` cap, either low-priority Zone B items evict with explicit audit notices or compilation fails closed — `P0`/`P1` rules never vanish silently.
3. **Stale `(env, git_sha, ttl)` Auto-Expiry:** Expired `observed/` claims or mismatched-environment claims are deterministically excluded and flagged as stale.
4. **Fail-Closed PII & Secret Quarantine:** Fixtures containing simulated API keys, JWTs, PEM headers, or high-entropy secrets abort with exit code `2` and leak zero raw secret characters in stdout/stderr.
5. **Indirect Prompt Injection Containment:** Adversarial strings inside `scars.md` or `hypotheses/` (including attempted `</untrusted_hint>` tag-breakouts and `"IGNORE PREVIOUS INSTRUCTIONS"`) remain escaped and sandboxed inside Zone B `<untrusted_hint>` blocks — never entering Zone A.

---

## 8. Stage 2 Benchmark & Red-Team Wind Tunnel Spec

1. **Google AI Studio (`countTokens` + Context Caching):**
   - Replace Stage 1 heuristic token estimator margins with exact Gemini `countTokens` calibration curves.
   - Measure live `cachedContentTokenCount / promptTokenCount` across multi-turn agent workloads comparing naive flat markdown vs. VeriBrain Two-Zone compilation.
2. **Google Colab (AI Ultra) Harness:**
   - Offline A/B accuracy/hallucination benchmark (`veribrain` cited context vs. flat prompt dump vs. RAG baseline).
   - `100+` adversarial indirect prompt-injection & secret-exfiltration red-team corpus run automatically against the quarantine scrubber and compiler.

---

## 9. Stage 3 Cross-Client Local `stdio` MCP Spec

Using `@modelcontextprotocol/sdk` over local `stdio` (`npx veribrain mcp`) so **Antigravity, Claude Code, Cursor, and Codex** share identical provenance-verified context without cloud infrastructure:

| MCP Tool Name | Authority | Behavior |
| :--- | :--- | :--- |
| `veribrain_compile_context` | Read-only | Returns Zone A (with `zone_a_sha256`), Zone B, citations, and token estimate for `(role, env, git_sha)` |
| `veribrain_get_claim` | Read-only | Fetches full verifiable evidence for a specific `DEC-*`, `OBS-*`, or `SCAR-*` ID |
| `veribrain_record_hypothesis` | Tier 3 only | Appends a short-TTL scrubbed `HYP-*` JSON proposal (never writes `DECIDED` or `OBSERVED`) |
| `veribrain_propose_scar` | Tier 3 proposal | Validates regression-test link + scrubs secrets; queues scar candidate for human `veribrain diff` approval |
| `veribrain_status` | Read-only | Reports `.brain/` health, `scars.md` byte budget, expired claims, and last eval status |

---

## 10. Target Empirical Metrics (Hypotheses to Prove in Stage 2)

| Metric | Naive v1 Baseline | VeriBrain Hardened v2 Target | Measurement Method |
| :--- | :--- | :--- | :--- |
| **KV-Cache Prefix Hit Rate** | `0%–25%` (cache busted by tail/header churn) | **`80%–92%`** | Gemini AI Studio `cachedContentTokenCount` |
| **Local Context Compile Latency** | `2s–15s` (embedding / LLM retrieval) | **`< 15 ms`** | Node.js `performance.now()` p95 over 100 runs |
| **Nightly Maintenance Burn** | `50k–200k` tokens/night | **`$0.00` (`0` tokens)** | Zero background LLM calls invariant |
| **Agent Policy-Poisoning Rate** | Unbounded on untrusted scar/note writes | **`0%` into Zone A / `DECIDED` / `OBSERVED`** | Stage 2 Colab `100+`-attack red-team suite |
