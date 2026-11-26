# VeriBrain User Guide (`v1.0.0`)

A step-by-step operational manual for using **VeriBrain** across **Antigravity**, **Claude Code**, **Cursor**, **Codex**, and **GitHub Actions CI** — on a single repository or across multiple projects.

---

## 0. Mental Model in 30 Seconds

VeriBrain adds a plain, Git-tracked `.brain/` directory to each repository so coding agents share deterministic, provenance-verified memory without a vector database or nightly LLM consolidation daemon:

| Folder / File | Trust Tier | Who Writes It | Lifespan | Prompt Placement |
| :--- | :--- | :--- | :--- | :--- |
| `.brain/decided/*.md` | **Tier 1 (`DECIDED`)** | **Human only** (signed + SHA-256) | Permanent (until `superseded`) | **Zone A** (byte-frozen KV-cache prefix) |
| `.brain/observed/*.json` | **Tier 2 (`OBSERVED`)** | **CI / Git hook / verifier script** | Short TTL (`1s–30d`) scoped to `(env, git_sha)` | **Zone B** (cited tail: `Based on: OBS-...`) |
| `.brain/scars.md` | **Tier 3 (Caution)** | **Human promotes** (agents propose only) | `<= 30 days`, `< 4,096 B` total, linked to a real test | **Zone B** inside `<untrusted_hint non_authoritative="true">` |
| `.brain/hypotheses/*.json` | **Tier 3 (`HYPOTHESIS`)** | **AI Agents** (via MCP) | `<= 7 days` | **Zone B** inside `<untrusted_hint non_authoritative="true">` |

**Core Rule:** Agents **read** compiled truth and **propose** short-lived Tier 3 hypotheses/scars — they can **never** modify `decided/`, forge `observed/`, or smuggle secrets/PII (quarantine fails closed with Exit `2` and zero raw secret echo).

---

## Step 1: Install VeriBrain

**Prerequisite:** **Node.js `>= 24.0.0`** (`node -v`).

### Option A — Published npm Package (Fastest)
```bash
npx -y veribrain --version
# Expected: veribrain 1.0.0

# Optional global install:
npm install -g veribrain
```

### Option B — From a Local Source Clone (Pre-Publish or Offline Use)
```bash
git clone https://github.com/neverbeenthemayor/veribrain.git
cd veribrain
npm ci
npm run build
npm link

veribrain --version
# Expected: veribrain 1.0.0
```

*(If you prefer not to run `npm link`, invoke `node <abs-path-to-veribrain>/dist/cli.js <command>` directly.)*

---

## Step 2: Initialize `.brain/` in a Project

From the root of your target repository, run **as a human** (ensure `VERIBRAIN_AGENT_MODE` is not set):

```bash
cd /path/to/your-project
veribrain init --signed-by "Your Name"
```

*(Non-human names like `agent`, `bot`, `ai`, `claude`, `gemini`, `ci`, or strings containing colons/newlines are rejected fail-closed with Exit `4`.)*

This creates:

```text
.brain/
├── config.json                        # Token budget, semantic keys, PII whitelist
├── scars.md                           # Bounded (< 4,096 B) regression lessons
├── decided/
│   └── DEC-001-veribrain-baseline.md  # Human-signed P0 starter invariant
├── observed/                          # CI / hook truth
└── hypotheses/                        # Agent Tier 3 proposals
```

Verify the store and test your first compile:

```bash
veribrain eval --strict
# Expected: eval ok: decided=1 observed=0 hyp=0 scars=0 (246/4096 B)

veribrain compile --role builder --env local --format md
```

Commit `.brain/` to Git so every branch, workstation, and coding agent shares the same baseline:

```bash
git add .brain
git commit -m "chore: initialize VeriBrain .brain/ store"
```

---

## Step 3: Populate Your Project's Memory (All 4 Tiers)

### A. Human-Signed Decisions — Tier 1 (`.brain/decided/*.md`)
Put non-negotiable architecture rules, security boundaries, spend caps, and coding invariants here. Every file requires YAML frontmatter with an exact lowercase 64-hex `sha256_body` hash of the Markdown body.

1. Create `.brain/decided/DEC-002-parameterized-sql.md`:

```markdown
---
id: DEC-002
priority: P0
roles: [builder, cqe, security]
signed_by: Your Name
signed_at_utc: 2026-11-25T14:00:00Z
sha256_body: REPLACE_WITH_64_HEX_SHA256
status: active
---
All database queries must use parameterized bindings through the repository layer. String-interpolated SQL is forbidden across all services.
```

2. Compute the exact `sha256_body` hash using VeriBrain's canonical normalizer (strip BOM, LF-only, NFC, strip trailing spaces/tabs per line, trimmed):

```bash
node -e '
import("node:fs").then(async fs => {
  const { createHash } = await import("node:crypto");
  const raw = fs.readFileSync(".brain/decided/DEC-002-parameterized-sql.md", "utf8");
  const body = raw.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").replace(/^---[\s\S]*?---\n/, "");
  const norm = body.normalize("NFC").split("\n").map(l => l.replace(/[ \t]+$/, "")).join("\n").trim();
  console.log(createHash("sha256").update(norm).digest("hex"));
});
'
```

3. Paste the printed 64-hex digest into `sha256_body:` and verify:

```bash
veribrain eval --strict
```

- **Priority:** `P0` and `P1` rules are **never silently truncated** (if they exceed `--max-tokens`, compilation aborts with Exit `3`). Use `P2` for lower-priority guidelines.
- **Role targeting:** List explicit roles (`[builder, security]`) or `[*]` for global rules.
- **Superseding a rule:** Change `status: active` to `status: superseded` to preserve Git history while excluding it from compiled Zone A output.

---

### B. CI / Hook Environment Truth — Tier 2 (`.brain/observed/*.json`)
Record ephemeral build, deployment, and verification truth from CI or Git hooks:

```bash
veribrain observe \
  --claim-id OBS-staging-tests \
  --env staging \
  --git-sha "$(git rev-parse --short=12 HEAD)" \
  --ttl 7200 \
  --summary "Staging API and integration suite passed on Node 24." \
  --evidence "ci:github-actions/run/12345" \
  --issuer ci
```

- `--env`: `local | pre-staging | staging | prod`
- `--issuer`: `ci | git-hook | verifier-script` (agent environments fail closed with Exit `4`)
- `--ttl`: `1` to `2592000` seconds (`<= 30` days). Expired claims or observations for a different `(env, git_sha)` are deterministically filtered into `excluded_stale_ids`.

---

### C. Regression Scars — Tier 3 (`.brain/scars.md`)
Record hard-won failure lessons linked to a real repo-relative test file (entire `scars.md` strictly `< 4,096` UTF-8 bytes, TTL `<= 30` days):

```markdown
## SCAR-001
- created_at_utc: 2026-11-25T14:00:00Z
- expires_at_utc: 2026-12-25T14:00:00Z
- regression_test: tests/unit/auth.test.ts#L42
- hint: Normalize user emails to lowercase before token lookup; mixed-case inputs caused silent 401s.
```

`veribrain eval --strict` enforces that the linked test file exists inside your repo root (symlink-confined) and that `scars.md` stays below `4,096` bytes.

---

### D. Tuning `.brain/config.json`
Edit `.brain/config.json` to configure:
- **`default_max_tokens`** (default `8192`): Default prompt token cap.
- **`pinned_ids`**: Array of `DEC-*` or `OBS-*` IDs protected from eviction under tight budgets.
- **`quarantine.allowed_domains` / `quarantine.allowed_emails`**: Raw emails are blocked by default to prevent PII leaks. Whitelist explicit non-personal domains (e.g., `["example.com"]`) or specific addresses when needed.

---

## Step 4: Connect VeriBrain to Antigravity & Other Coding Agents

### A. Antigravity (Single & Multi-Project Setup)
Open (or create if it does not exist yet) Antigravity's global MCP config:
- **macOS / Linux:** `~/.gemini/config/mcp_config.json`
- **Windows:** `C:\Users\<USER>\.gemini\config\mcp_config.json`

*(You can also inspect active MCP servers in the Antigravity UI via **Skills & Customizations** in the left sidebar or **Additional Options (...) → MCP Servers**.)*

Because Antigravity's MCP config is global, register **one named server per repository** when using VeriBrain across multiple projects — each locked to its own `--brain-dir` and `--repo-root` so memories never cross-contaminate.

**Using a local clone (works identically on Windows, macOS, and Linux):**
```json
{
  "mcpServers": {
    "veribrain-project-a": {
      "command": "node",
      "args": [
        "<abs-path-to-veribrain>/dist/cli.js",
        "mcp",
        "--brain-dir",
        "<abs-path-to-project-a>/.brain",
        "--repo-root",
        "<abs-path-to-project-a>"
      ]
    },
    "veribrain-project-b": {
      "command": "node",
      "args": [
        "<abs-path-to-veribrain>/dist/cli.js",
        "mcp",
        "--brain-dir",
        "<abs-path-to-project-b>/.brain",
        "--repo-root",
        "<abs-path-to-project-b>"
      ]
    }
  }
}
```

**Using published `npx` (POSIX):**
```json
{
  "mcpServers": {
    "veribrain-project-a": {
      "command": "npx",
      "args": [
        "-y", "veribrain", "mcp",
        "--brain-dir", "/path/to/project-a/.brain",
        "--repo-root", "/path/to/project-a"
      ]
    }
  }
}
```

*(On Windows, use forward slashes `C:/path/to/...` or escaped backslashes `C:\\path\\to\\...`. If a Windows host hits `ENOENT` spawning `npx`, use `"command": "cmd", "args": ["/c", "npx", "-y", "veribrain", "mcp", ...]`. See [`docs/mcp-clients.md`](./mcp-clients.md) for full details.)*

Reload Antigravity MCP servers after saving. Each configured server exposes 5 fail-closed tools:
1. `veribrain_compile_context` *(read-only)* — Returns Zone A (`zone_a_sha256`), cited Zone B, and token/latency telemetry.
2. `veribrain_get_claim` *(read-only)* — Returns full quarantine-scrubbed evidence for any `DEC-*`, `OBS-*`, `SCAR-*`, or `HYP-*` ID.
3. `veribrain_status` *(read-only)* — Reports counts, `scars.md` bytes, expired claims, pending proposals, and `eval` health.
4. `veribrain_record_hypothesis` *(Tier 3 write-only)* — Writes scrubbed `<= 7d` `HYP-*.json` atomically into `.brain/hypotheses/`.
5. `veribrain_propose_scar` *(Tier 3 proposal queue)* — Validates `regression_test` existence and `< 4,096 B` headroom, queuing `HYP-SCAR-*.json` for human review.

### B. Claude Code, Cursor & Codex (Per-Repo Config)
Generate project-scoped config files directly inside each repository:

```bash
veribrain mcp --print-config claude-code --brain-dir .brain --repo-root .  # -> .mcp.json
veribrain mcp --print-config cursor      --brain-dir .brain --repo-root .  # -> .cursor/mcp.json
veribrain mcp --print-config codex       --brain-dir .brain --repo-root .  # -> .codex/config.toml
```

---

## Step 5: Add the Agent Memory Protocol to Each Project's `AGENTS.md`

Add this standing block to each repository's `AGENTS.md` (or `CLAUDE.md` / `.cursorrules`) so agents automatically read and contribute to `.brain/`:

```markdown
## VeriBrain Shared Memory Protocol
1. **Session Start:** Call `veribrain_compile_context` (with your role, target `env`, and current `git_sha`) before architectural or deployment changes. Treat **Zone A (`DECIDED`)** as binding policy and **Zone B (`<untrusted_hint>`)** as non-authoritative hints only.
2. **Cite Evidence:** Reference claim IDs (`DEC-*`, `OBS-*`) when relying on project rules or environment state; inspect details via `veribrain_get_claim`.
3. **Record Tier 3 Learnings Only:**
   - Call `veribrain_record_hypothesis` for tentative findings (`<= 7d` TTL, zero secrets or PII).
   - After fixing a bug with a regression test, call `veribrain_propose_scar` pointing to the repo-relative test path.
4. **Never Self-Attest:** Never directly edit `.brain/decided/*.md`, `.brain/observed/*.json`, or `.brain/scars.md` without human owner sign-off.
```

*(When using multiple named servers in Antigravity, specify the server name for that repository — e.g., `Use the veribrain-project-a MCP server`.)*

---

## Step 6: Daily, CI & Weekly Operating Loop

### 1. Daily Coding (Zero Friction via MCP)
Agents call `veribrain_compile_context` at session start to load byte-frozen Zone A policies + fresh cited Zone B observations, and queue tentative lessons via `veribrain_record_hypothesis` / `veribrain_propose_scar`.

### 2. GitHub Actions CI (`$0.00`)
Gate every pull request with `veribrain eval --strict`:

```yaml
- name: Verify VeriBrain Store
  run: npx -y veribrain eval --strict
```

Optionally record attested staging verification after deploy:

```yaml
- name: Record Staging Verification
  run: |
    npx -y veribrain observe \
      --claim-id OBS-staging-deploy \
      --env staging \
      --git-sha "${{ github.sha }}" \
      --ttl 14400 \
      --summary "Staging deploy and smoke tests passed." \
      --evidence "ci:run/${{ github.run_id }}" \
      --issuer ci
```

### 3. Weekly 2-Minute Human Review (`veribrain diff`)
Once a week, run:

```bash
veribrain diff --since 7d
```

VeriBrain prints `<= 5` plain-English bullets (`<= 25` lines, `<= 80` cols, `$0.00`, `0` LLM tokens) covering aging/unlinked scars, pending `[HYP]` / `[HYP/SCAR]` proposals, expired `OBS-*` claims, and recent `DEC-*` edits.

For each item:
- **Keep:** Leave as-is (or refresh expiry on a still-valid scar).
- **Revert / Prune:** Delete expired `observed/*.json` or rejected `hypotheses/HYP-*.json`.
- **Promote:** Move an approved `[HYP/SCAR]` into `.brain/scars.md` (or create a human-signed `.brain/decided/DEC-*.md` with `sha256_body`), then remove the processed `HYP-*.json` file.

Validate and commit:

```bash
veribrain eval --strict
git add .brain && git commit -m "chore(brain): weekly diff review"
```

---

## Step 7: Troubleshooting & Exit Codes

| Exit Code | Meaning | Common Cause & Fix |
| :---: | :--- | :--- |
| **`0`** | `OK` | Command completed cleanly. |
| **`1`** | `ERROR` / `EVAL_FAIL` | Bad CLI flag, missing `regression_test`, expired claim under `--strict`, or `scars.md >= 4,096 B`. Follow the `fix:` hint on `stderr` and re-run `veribrain eval --strict`. |
| **`2`** | `QUARANTINE_VIOLATION` | Secret, API key, high-entropy token, phone number, or unwhitelisted email detected (zero `stdout`, zero raw secret echo). Remove the secret, or whitelist legitimate non-personal domains in `.brain/config.json` (`quarantine.allowed_domains`). |
| **`3`** | `BUDGET_INFEASIBLE` | Zone A + pinned `P0`/`P1` claims exceed `--max-tokens`. Raise `--max-tokens` (`default_max_tokens`), demote non-critical rules to `P2`, or supersede obsolete `DEC-*` files. |
| **`4`** | `PROVENANCE_VIOLATION` | `sha256_body` mismatch after editing a `DEC-*` file (recompute via Step 3A), agent attempting `init --signed-by` / `observe` (unset `VERIBRAIN_AGENT_MODE`), or invalid signer/issuer. |
