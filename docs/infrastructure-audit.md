# VeriBrain — Active Infrastructure & Post-Deploy Audit Log

- **Owner:** Chief Infrastructure Engineer (CIE) · **Release Target:** `v1.3.0` (`PRG-3` · `2026-11-28`)
- **Repository:** `https://github.com/neverbeenthemayor/veribrain` (`PUBLIC` · `main`, `staging`, `pre-staging`)
- **Architecture Mode:** Local-First Node.js 24 LTS CLI + Local `stdio` MCP (NO Firebase Hosting / Cloud Run / Vector DB deploys)

| Check / Target | Status | Date / Gate | Evidence / Notes |
|---|---|---|---|
| **Public GitHub Repo & Branch/Tag Protection** | `PASS` | `2026-11-26` | `neverbeenthemayor/veribrain` (`PUBLIC`); Rulesets `28172892` (branch) & `28172893` (tags `v*`), Secret Scanning + Push Protection, Private Vulnerability Reporting, Fork PR approval, SHA-pinned GitHub-owned Actions active |
| **Live Public Releases (`v1.1.0` & `v1.2.0` GitHub & npm)** | `PASS` | `2026-11-27` | Signed commits `7d51715` (`v1.1.0`) & `4aab244` (`v1.2.0`), `3/3` green CI runs on `v1.2.0`, GitHub Release `v1.2.0` (`veribrain-1.2.0.tgz` + `SHA256SUMS.txt`), and live `npx --yes veribrain@1.2.0 --version` verified |
| **3-Job SHA-Pinned CI & Governance (`.github/workflows/ci.yml`)** | `PASS` | `PRG-3` (`v1.3.0`) | `NODE_VERSION: '24'`, `Contributor Policy Guardrail` (`deps=@modelcontextprotocol/sdk,zod`, `LF=clean`), `timeout-minutes: 5`, `.gitignore` excludes `.brain/.metrics.jsonl`/`.json`, `CODEOWNERS` covers `/src/metrics.ts` & `/src/commands/stats.ts` |
| **PRG-3 `v1.3.0` Packaging & Zero-Warn Tarball (`PM-701`)** | `PASS` | `PRG-3` (`v1.3.0`) | `package.json` & `package-lock.json` (`v3`) synced at `veribrain@1.3.0` (`"bin": { "veribrain": "dist/cli.js" }`, `"repository.url": "git+https://github.com/neverbeenthemayor/veribrain.git"`); `npm publish --dry-run` -> `veribrain-1.3.0.tgz` (`52` files: `48` `dist/**` + `CHANGELOG`/`LICENSE`/`README`/`package.json`, **0 `npm warn publish` lines**, excludes `.brain/`) |
| **PRG-3 `v1.3.0` Supply Chain & Node 24 LTS Parity** | `PASS` | `PRG-3` (`v1.3.0`) | Runtime `dependencies` strictly `2` (`@modelcontextprotocol/sdk@1.32.2`, `zod@4.6.7`, `95` prod lockfile entries); live `npm audit --omit=dev` -> `found 0 vulnerabilities`; `0` LLM/cloud deps |
| **CLI Shebang & Pure LF Parity (`dist/cli.js`)** | `PASS` | `PRG-3` (`v1.3.0`) | Exact pure LF shebang `#!/usr/bin/env node\n` (`0` CR bytes), `node ./dist/cli.js --version` -> `veribrain 1.3.0`, `CR_VIOLATIONS=0` across all repo/src/doc files |
| **Zero Cloud Infra & Scale-to-Zero Guardrail** | `PASS` | `2026-11-28` | Zero Firebase/Cloud Run/Vector DB deployments; `apphosting*.yaml` (`minInstances: 0`) intact for Playbook `v2.0` `--verify`; external workspace isolation enforced via `VERIBRAIN_ISOLATION_SEGMENTS` |
| **Active Register Token-Diet (`< 8,192 B`)** | `PASS` | `2026-11-28` | All 7 active registers verified `< 8,192 B` & pure LF (`0` CRLF) |
