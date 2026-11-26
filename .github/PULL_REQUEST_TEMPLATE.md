## Summary & Linked Issue

- Fixes / Implements: #
- What changed and why:

## Verification Checklist

Run locally before requesting review (see `CONTRIBUTING.md`):

- [ ] `npm run typecheck` (`0` errors against Node 24 LTS types)
- [ ] `npm run lint` (`biome check src tests` — `0` errors, `0` warnings)
- [ ] `npm run build`
- [ ] `npm test` (Unit + Golden Context Eval + Stdio MCP suites passing)
- [ ] `node benchmarks/run_redteam.mjs` (`129/129`, `0` escapes, `0` canary leaks; restore `benchmarks/results/redteam-observed.json` if only timestamp changed)
- [ ] `npm pack --dry-run`

## VeriBrain Invariants Checklist

- [ ] **Zero new runtime dependencies:** `package.json` `dependencies` remains strictly `@modelcontextprotocol/sdk` and `zod` (no LLM SDKs, vector DBs, or cloud clients)
- [ ] **Byte-frozen Zone A preserved:** No timestamps, git SHAs, environment names, or volatile counters injected into Zone A static prefix text
- [ ] **Pure LF & strict ESM:** Explicit `.js` extensions on relative TS ESM imports and pure LF (`\n`, zero CRLF) line endings
- [ ] **Synthetic fixtures only:** Zero real API keys, tokens, credentials, or personal PII in code, tests, or fixtures
- [ ] **Signed commits:** Commits in this PR are cryptographically signed (SSH/GPG)
