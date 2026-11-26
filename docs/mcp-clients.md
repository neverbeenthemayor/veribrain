# VeriBrain Local `stdio` MCP Client Setup

VeriBrain exposes its `$0` deterministic context compiler and fail-closed Tier 3 hypothesis intake over a **local `stdio` MCP server** (`npx -y veribrain mcp`). No cloud server, no vector DB, no background LLM calls, and zero agent write authority over `decided/`, `observed/`, or `scars.md`.

---

## 1. 1-Minute Setup by Client

Generate copy-pasteable config directly from the CLI:

```bash
npx veribrain mcp --print-config antigravity --brain-dir .brain --repo-root .
npx veribrain mcp --print-config claude-code --brain-dir .brain --repo-root .
npx veribrain mcp --print-config cursor      --brain-dir .brain --repo-root .
npx veribrain mcp --print-config codex       --brain-dir .brain --repo-root .
```

### Antigravity / Claude Code / Cursor (JSON)

```json
{
  "mcpServers": {
    "veribrain": {
      "command": "npx",
      "args": ["-y", "veribrain", "mcp", "--brain-dir", ".brain", "--repo-root", "."]
    }
  }
}
```

### Codex CLI (TOML)

```toml
[mcp_servers.veribrain]
command = "npx"
args = ["-y", "veribrain", "mcp", "--brain-dir", ".brain", "--repo-root", "."]
```

---

## 2. Windows vs. POSIX & Config Locations

| Client | Config File Path | Format |
| :--- | :--- | :--- |
| **Antigravity** | `~/.gemini/config/mcp_config.json` (create if absent; or plugin `mcp_config.json`) | JSON |
| **Claude Code** | `.mcp.json` (project) or `~/.claude.json` (user) | JSON |
| **Cursor** | `.cursor/mcp.json` | JSON |
| **Codex CLI** | `.codex/config.toml` (project) or `~/.codex/config.toml` (user) | TOML |

- **Windows `npx` `ENOENT` Fix:** Some Windows MCP hosts do not resolve `.cmd` shims directly. If your host fails with `ENOENT` invoking `npx`, wrap via `cmd`:

```json
{
  "mcpServers": {
    "veribrain": {
      "command": "cmd",
      "args": ["/c", "npx", "-y", "veribrain", "mcp", "--brain-dir", ".brain", "--repo-root", "C:/path/to/repo"]
    }
  }
}
```

- **Windows Path Escaping:** Use forward slashes (`C:/Projects/myrepo`) or escaped backslashes (`C:\\Projects\\myrepo`) in both JSON and TOML strings.
- **Pre-npm-Publish / Local Clone Setup:** Build once with `npm run build`, then invoke `node` directly (works identically on Windows and POSIX without npm registry lookup):

```json
{
  "mcpServers": {
    "veribrain": {
      "command": "node",
      "args": ["<abs-path>/dist/cli.js", "mcp", "--brain-dir", ".brain", "--repo-root", "."]
    }
  }
}
```

---

## 3. Exposed MCP Tools & Fail-Closed Write-Authority Matrix

| MCP Tool | Authority | Read/Write Surface | Fail-Closed Guardrails |
| :--- | :--- | :--- | :--- |
| `veribrain_compile_context` | **Read-Only** (`readOnlyHint: true`) | Reads `.brain/` (worktree fallback supported) | Byte-frozen Zone A (`zone_a_sha256`), Zone B citations, `included_decided_ids`/`included_observed_ids`, `<untrusted_hint>` sandboxing, exit-2 quarantine & exit-3 P0/P1 budget guards |
| `veribrain_get_claim` | **Read-Only** (`readOnlyHint: true`) | Reads `.brain/` (`DEC-*`, `OBS-*`, `SCAR-*`, `HYP-*`) | Quarantine-verified lookup; returns structured `isError: true` on missing/invalid ID without crashing server |
| `veribrain_list_claims` | **Read-Only** (`readOnlyHint: true`) | Reads `.brain/` | Filters by `tier` (`all\|decided\|observed\|hypothesis\|scar`), `prefix`, `role`, and `limit` (`<= 100`); returns quarantine-scrubbed snippets + counts |
| `veribrain_record_hypothesis` | **Tier 3 Write Only** | Atomic write to `.brain/hypotheses/HYP-*.json` | `^HYP-[A-Za-z0-9._-]{1,60}$` (<= 64 chars, blocks `..`/`/`/`\`), hint <= 4,096 B, roles <= 32, TTL `1..7d`, full secret/PII quarantine before disk write; never touches `decided/`, `observed/`, or `scars.md` |
| `veribrain_propose_scar` | **Tier 3 Proposal Only** | Atomic write to `.brain/hypotheses/HYP-SCAR-*.json` | Validates repo-relative `regression_test` exists inside `repoRoot` (symlink-confined), checks `scars.md < 4,096 B` headroom, queues for human `veribrain promote` / `diff`; never mutates `scars.md` directly |
| `veribrain_status` | **Read-Only** (`readOnlyHint: true`) | Reads `.brain/` | Reports `.brain/` health, counts, `scars.md` byte budget, expired counts, pending scar proposals, and `veribrain eval` verdict |

---

## 4. Security & Transport Invariants

- **Strict `stdio` Purity:** `veribrain mcp` emits strictly JSON-RPC frames on `stdout`; operational errors go to `stderr`.
- **Zero Secret Echo:** Any secret or unwhitelisted PII passed to MCP tools returns `{ isError: true }` with redacted identifiers and zero raw secret characters.
- **Human-in-the-Loop Governance (`v1.1.0`):** Agents can only propose Tier 3 hypotheses and scar candidates. Humans author/sign Tier 1 rules via `veribrain decide` / `veribrain sign`, promote queued hypotheses via `veribrain promote <HYP-ID>`, dry-run prose via `veribrain lint-text <file>`, install Git hooks via `veribrain hooks install`, and gate parity with `veribrain eval --strict --check-mirror`.
