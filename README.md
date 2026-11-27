# VeriBrain (`v1.2.0`)

**Zero-dollar deterministic, provenance-verified context compiler and local `stdio` MCP shared brain for multi-agent engineering.**

VeriBrain replaces cloud vector databases and nightly LLM "sleep consolidation" daemons with a Git-tracked `.brain/` store and a local Node.js 24 TypeScript compiler (`0` runtime LLM SDK dependencies). One deterministic compiler serves **Antigravity, Claude Code, Cursor, and Codex** with byte-frozen KV-cache prefixes, cited ephemeral observations, fail-closed secret/PII quarantine, and a 1-screen weekly human diff.

### Verified Headline Metrics (Observed Stage 1–3 Artifacts)

| Metric | Observed Result | Source Artifact |
| :--- | :--- | :--- |
| **Runtime & Nightly Cost** | **`$0.00/mo`** (`0` background LLM calls; `$0.4851` total one-time live calibration spend) | [`docs/finops-ledger.md`](./docs/finops-ledger.md) |
| **Local Compile Latency** | **`5.67–12.62 ms`** warm p95 (`4.728 ms` MCP warm p95; `100/100` SHA-256 identity) | [`QUALITY.md`](./QUALITY.md), [`benchmarks/results/latency-observed.json`](./benchmarks/results/latency-observed.json) |
| **Adversarial Red-Team** | **`129/129`** passed (`125` attacks + `4` controls; **`0%`** policy escape, **`0`** canary leaks) | [`benchmarks/results/redteam-observed.json`](./benchmarks/results/redteam-observed.json) |
| **Live Gemini 4 KV-Cache** | **`73.13%`** T2–T6 avg / **`75.04%`** peak (`gemini-4-hydrogen`) vs. **`0.0%`** naive header | [`benchmarks/results/ai-studio-live.json`](./benchmarks/results/ai-studio-live.json) |
| **Offline Structural Grounding** | **`10/10`** (`100%`, `0` leaks) vs. `6/10` flat dump vs. `1/10` stale RAG (Colab non-LLM) | [`benchmarks/notebooks/veribrain_stage2_wind_tunnel.ipynb`](./benchmarks/notebooks/veribrain_stage2_wind_tunnel.ipynb) |

---

## 1-Minute Quickstart

**Prerequisites:** Node.js `>= 24.0.0` (ESM).

```bash
# 1. Scaffold .brain/ (pass --signed-by with a human name to create starter DEC-001)
npx veribrain init --signed-by "Your Name"

# 2. Verify schema, provenance, quarantine, and scars budget
npx veribrain eval --strict

# 3. Compile byte-frozen Zone A + cited Zone B context (md or json; optional Zone A0+A1 split)
npx veribrain compile --role builder --env staging --format json --zone-a-layout split

# 4. Author/sign DEC-* rules, promote HYP-* queues, audit doc citations, or run verifier tests
npx veribrain decide --id DEC-002 --priority P1 --signed-by "Your Name" --body "Rule text."
npx veribrain sign .brain/decided/DEC-002.md
npx veribrain promote HYP-SCAR-001 --to scar
npx veribrain lint-text docs/policy-draft.md
npx veribrain check-citations
npx veribrain attest-test --env local -- npm test
npx veribrain hooks install

# 5. Review weekly diffs (<= 25 lines) or run uncapped multi-role retro audit
npx veribrain diff --since 7d
npx veribrain retro --since 7d --format md

# 6. Print local stdio MCP client config (antigravity | claude-code | cursor | codex)
npx veribrain mcp --print-config antigravity
```

To record CI or Git-hook environment truth (Tier 2; agent self-attestation is denied fail-closed):

```bash
npx veribrain observe \
  --claim-id OBS-staging-ci \
  --env staging \
  --git-sha abcdef1234 \
  --ttl 3600 \
  --summary "Staging test suite green." \
  --evidence "ci:run/1001" \
  --issuer ci
```

---

## Typed `.brain/` Trust Tiers & Two-Zone Output Contract

All VeriBrain state lives inside a plain, Git-tracked `.brain/` directory:

| Directory / File | Trust Tier | Write Authority | Key Invariants |
| :--- | :--- | :--- | :--- |
| `.brain/config.json` | Config | Human Owner | Budget scalars (`3.5` B/tok x `1.15`), `semantic_keys`, explicit PII allowlists |
| `.brain/decided/*.md` | **Tier 1 (`DECIDED`)** | Human Owner (signed) | YAML frontmatter + 64-hex `sha256_body` verification + non-agent `signed_by` |
| `.brain/observed/*.json` | **Tier 2 (`OBSERVED`)** | CI / Git Hook / Verifier | Scoped by `(env, git_sha, ttl_seconds)` or bounded `env-ttl` (`<= 7d`); `issuer` in `ci \| git-hook \| verifier-script` |
| `.brain/scars.md` | **Tier 3 Caution** | Human Owner (promote/prune) | `< 4,096` UTF-8 bytes, `<= 30d` TTL, repo-relative `regression_test` file link |
| `.brain/hypotheses/*.json` | **Tier 3 (`HYPOTHESIS`)** | Coding Agents / MCP | Short TTL (`<= 7d`), isolated to Zone B, never auto-promoted |

### Two-Zone Compiled Layout

`veribrain compile` separates static policy from dynamic state using `\n\n<!-- VERIBRAIN:ZONE_BOUNDARY:A_END -->\n\n`:

1. **Zone A (Byte-Frozen Static Prefix):** UTF-8 (no BOM), NFC-normalized, LF-only, sorted canonically by `(priorityRank ASC, ASCII id ASC)`. With `schema_version: "1.1"` or `--zone-a-layout split`, `Zone A` splits into role-agnostic `Zone A0` (`roles: ["*"]`, identical SHA-256 across all engineering roles) + `Zone A1` role delta. Contains zero timestamps, git SHAs, environment names, or volatile counters.
2. **Zone B (Uncached Dynamic Tail):** Fresh `(env, git_sha, ttl)` observations with mandatory 1-line citations (`Based on: <claim_id> (<env>@<sha>)`), plus Tier 3 scars/hypotheses sandboxed inside `<untrusted_hint source="scar|hypothesis" id="..." non_authoritative="true">` after NFKC normalization, control/bidi/Unicode-Tag stripping, and full `&`/`<`/`>` escaping.

### Fail-Closed Exit Codes

| Exit Code | Meaning | Behavior |
| :---: | :--- | :--- |
| `0` | `OK` | Compilation, evaluation, diff, or config generation succeeded |
| `1` | `ERROR / EVAL_FAIL` | CLI usage error, schema violation, or failing `veribrain eval` invariant |
| `2` | `QUARANTINE_VIOLATION` | Secret, unwhitelisted PII, or high-entropy token detected (`0` stdout bytes, `0` raw secret echo) |
| `3` | `BUDGET_INFEASIBLE` | Zone A or pinned `P0`/`P1` invariants exceed `--max-tokens` (zero silent truncation) |
| `4` | `PROVENANCE_VIOLATION` | Agent self-attestation, tampered `sha256_body`, invalid `issuer`/`signed_by`, or path traversal |

---

## Local `stdio` MCP Server (`npx veribrain mcp`)

VeriBrain ships a local `stdio` MCP server (`@modelcontextprotocol/sdk`) shared identically across **Antigravity, Claude Code, Cursor, and Codex** — zero hosted servers, zero stdout logging pollution. See [`docs/mcp-clients.md`](./docs/mcp-clients.md) for POSIX/Windows setup snippets and config file paths.

| MCP Tool | Authority | Behavior & Guardrails |
| :--- | :--- | :--- |
| `veribrain_compile_context` | **Read-Only** | Compiles byte-frozen Zone A (`zone_a_sha256`), cited Zone B, `included_decided_ids`/`included_observed_ids`, and telemetry for `(role, env, git_sha)` |
| `veribrain_get_claim` | **Read-Only** | Fetches full quarantine-verified evidence for any `DEC-*`, `OBS-*`, `SCAR-*`, or `HYP-*` ID |
| `veribrain_list_claims` | **Read-Only** | Lists claims filtered by `tier`, `prefix`, `role`, and `limit` (`<= 100`) with quarantine-scrubbed snippets and total counts |
| `veribrain_record_hypothesis` | **Tier 3 Only** | Validates `HYP-*` ID (`<= 64` chars), hint (`<= 4,096 B`), roles (`<= 32`), TTL (`1..7d`), scrubs secrets, writes atomically to `.brain/hypotheses/` |
| `veribrain_propose_scar` | **Tier 3 Proposal** | Validates existing repo-relative `regression_test` & `< 4,096 B` headroom, queues `HYP-SCAR-*.json` for human `veribrain promote` / `diff` (never edits `scars.md`) |
| `veribrain_status` | **Read-Only** | Reports `.brain/` health, counts, `scars.md` byte budget, expired counts, pending scar proposals, and `eval` verdict |

---

## Observed Benchmark Summary

All numbers below come strictly from committed verification runs (zero extrapolated claims):

| Evaluation | Scope & Conditions | Observed Result | Artifact |
| :--- | :--- | :--- | :--- |
| **Stage 1 Golden Latency** | 39 files, 100 runs, warm stat-validated | `p50=4.34 ms`, `p95=5.67 ms`, `100/100` hash identity | [`QUALITY.md`](./QUALITY.md), [`Stage 0-1 Report`](./docs/archive/progress-reports-stage0-1.md) |
| **Stage 1 Read-Only Shadow** | 5 governance docs, 100 runs, `8,372` est. tok | `p95=4.11 ms`, `0` source mutation | [`QUALITY.md`](./QUALITY.md), [`Stage 0-1 Report`](./docs/archive/progress-reports-stage0-1.md) |
| **Stage 2 Warm vs. Cold** | 45 files (`5,867` est. Zone A tok), 100 runs | Warm `p50=8.48 / p95=12.62 ms` vs. Cold `p50=52.65 / p95=99.48 ms` | [`benchmarks/results/latency-observed.json`](./benchmarks/results/latency-observed.json) |
| **Stage 3 MCP Warm Compile** | Real `stdio` `dist/cli.js mcp`, 20 runs | `p50=1.769 ms`, `p95=4.728 ms`, `20/20` hash identity | [`QUALITY.md`](./QUALITY.md) |
| **Gemini 4 `countTokens`** | 9 live payloads (`gemini-4-hydrogen`) | Full Two-Zone: `7,204` actual vs. `8,743` est. (`+21.4%` safe headroom) | [`benchmarks/results/ai-studio-live.json`](./benchmarks/results/ai-studio-live.json) |
| **Gemini 4 KV-Cache A/B** | 6-turn stateful (`previous_interaction_id`), `7,112` actual-tok Zone A | Arm B: **`73.13%`** T2–T6 avg / **`75.04%`** peak (`32,938` cached tok) vs. Arm A **`0.0%`** | [`benchmarks/results/ai-studio-live.json`](./benchmarks/results/ai-studio-live.json) |
| **Red-Team Wind Tunnel** | 129 cases (`125` attacks + `4` controls across 7 families) | **`129/129` (`100%`)**, `0%` policy escape, `0` secret canary leaks | [`benchmarks/results/redteam-observed.json`](./benchmarks/results/redteam-observed.json) |
| **Offline Structural Grounding** | 10 non-LLM grounding tasks in Google Colab | VeriBrain **`10/10`** (`0` leaks) vs. Flat `6/10` (`4` leaks) vs. Stale RAG `1/10` (`4` leaks) | [`benchmarks/notebooks/veribrain_stage2_wind_tunnel.ipynb`](./benchmarks/notebooks/veribrain_stage2_wind_tunnel.ipynb) |

---

## Documentation & License

- Step-by-Step User Guide (Technical V1): [`docs/user-guide.md`](./docs/user-guide.md)
- Plain-English User Guide (General Audience): [`docs/user-guide-plain-english.md`](./docs/user-guide-plain-english.md)
- Local `stdio` MCP Client Setup: [`docs/mcp-clients.md`](./docs/mcp-clients.md)
- Architecture Specification: [`docs/RFC-001-veribrain-architecture.md`](./docs/RFC-001-veribrain-architecture.md)
- Engineering Write-Up: [`docs/blog-veribrain-post.md`](./docs/blog-veribrain-post.md)
- Reproducible Benchmark Harness: [`docs/benchmarks/README.md`](./docs/benchmarks/README.md)
- Release History: [`CHANGELOG.md`](./CHANGELOG.md) · Contributing Guide: [`CONTRIBUTING.md`](./CONTRIBUTING.md) · License: [MIT](./LICENSE)
