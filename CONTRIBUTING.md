# Contributing to VeriBrain

Thank you for your interest in contributing to **VeriBrain**. Every contribution must preserve VeriBrain's core guarantees: `$0.00/mo` deterministic compilation, zero runtime LLM SDK dependencies, fail-closed provenance, and zero raw secret echo.

---

## Prerequisites

- **Node.js `>= 24.0.0`** (Node.js 24 LTS ESM)
- **Git** with LF line endings configured (enforced by `.gitattributes`)

## Local Development Setup

```bash
git clone https://github.com/neverbeenthemayor/veribrain.git
cd veribrain
npm ci
```

## Required Local Verification Commands

Run all gates before opening a pull request:

```bash
# 1. Type-check against Node 24 LTS types
npm run typecheck

# 2. Lint and format check (Biome — 0 errors, 0 warnings)
npm run lint

# 3. Build TypeScript ESM output + declarations into dist/
npm run build

# 4. Run full Unit + Golden Context Eval + Stdio MCP test suites
npm test

# 5. Run the $0 129-case Red-Team Wind Tunnel
node benchmarks/run_redteam.mjs

# 6. Verify dependency security and package tarball contents
npm audit --audit-level=high
npm pack --dry-run
```

## Engineering & Review Standards

- **Author != Verifier:** Do not self-approve architectural, security, or compiler changes. Code changes in `src/**` should include targeted unit tests under `tests/unit/**`, while Golden Context Eval assertions (`tests/golden/**`) are reviewed independently.
- **Zero Runtime LLM / Cloud Dependencies:** Core `package.json` `dependencies` are strictly restricted to the local `stdio` MCP bridge (`@modelcontextprotocol/sdk` and `zod`). Do not add LLM SDKs, vector databases, or cloud persistence dependencies.
- **Byte-Frozen Zone A Discipline:** Never inject timestamps, git SHAs, environment names, or volatile counters into Zone A static prefix text.
- **Pure LF & Strict ESM:** Use explicit `.js` extensions on relative TypeScript ESM imports and pure LF (`\n`) line endings across all source, test, config, and Markdown files.
- **Empirical Honesty:** Any performance or benchmark claim updated in docs must come directly from reproducible scripts committed under `benchmarks/` or `tests/`.

## Security & Responsible Disclosure

- **Never commit real secrets, API keys, or personal PII** (even inside test fixtures — use clearly synthetic placeholder strings).
- If you discover a quarantine bypass, prompt-injection escape, path-traversal issue, or provenance flaw, please open a private security advisory or contact the repository maintainer via GitHub rather than posting exploitable details publicly before a fix is released.
