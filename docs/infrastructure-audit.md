# VeriBrain — Active Infrastructure & Post-Deploy Audit Log

- **Owner:** Chief Infrastructure Engineer (CIE) · **Release Target:** `v1.4.0` (`PRG-4` · `2026-11-28`)
- **Repository:** `https://github.com/neverbeenthemayor/veribrain` (`PUBLIC` · `main`, `staging`, `pre-staging`)
- **Architecture Mode:** Local-First Node.js 24 LTS CLI + Local `stdio` MCP (`7` tools; NO Firebase Hosting / Cloud Run / Vector DB deploys)

| Check / Target | Status | Date / Gate | Evidence / Notes |
|---|---|---|---|
| **Public GitHub Repo & Branch/Tag Protection** | `PASS` | `2026-11-26` | `neverbeenthemayor/veribrain` (`PUBLIC`); Rulesets `28172892` (branch) & `28172893` (tags `v*`), Secret Scanning + Push Protection, Private Vulnerability Reporting, Fork PR approval, SHA-pinned GitHub-owned Actions active |
| **Live Public Releases (`v1.1.0`, `v1.2.0`, `v1.3.0`)** | `PASS` | `2026-11-28` | Signed `7d51715` (`v1.1.0`), `4aab244` (`v1.2.0`), & `6d8b90c` (`v1.3.0` live on `pre-staging`/`staging`, signed tag `v1.3.0`, live `npm view veribrain version` = `1.3.0`; `origin/main` fast-forward from `4aab244` pending owner promotion) |
| **3-Job SHA-Pinned CI & Governance (`.github/workflows/ci.yml`)** | `PASS` | `PRG-4` (`v1.4.0`) | `NODE_VERSION: '24'`, `Contributor Policy Guardrail` (`deps=@modelcontextprotocol/sdk,zod`, `LF=clean`), `timeout-minutes: 5`, `.gitignore` excludes `.brain/.metrics.jsonl`/`.json`, `CODEOWNERS` covers `/src/commands/doctor.ts` |
| **PRG-4 `v1.4.0` Packaging & Zero-Warn Tarball (`PM-702`)** | `PASS` | `PRG-4` (`v1.4.0`) | `package.json` & `package-lock.json` (`v3`) synced at `veribrain@1.4.0` (`"bin": { "veribrain": "dist/cli.js" }`, `"repository.url": "git+https://github.com/neverbeenthemayor/veribrain.git"`); `npm publish --dry-run` -> `veribrain-1.4.0.tgz` (`54` files: `50` `dist/**` incl. `dist/commands/doctor.{js,d.ts}` + `CHANGELOG`/`LICENSE`/`README`/`package.json`, **0 `npm warn publish` lines**, excludes `.brain/`) |
| **PRG-4 `v1.4.0` Supply Chain & Node 24 LTS Parity** | `PASS` | `PRG-4` (`v1.4.0`) | Runtime `dependencies` strictly `2` (`@modelcontextprotocol/sdk@1.32.2`, `zod@4.6.7`, `95` prod lockfile entries); live `npm audit --omit=dev` -> `found 0 vulnerabilities`; `0` LLM/cloud deps |
| **CLI Shebang & Pure LF Parity (`dist/cli.js`)** | `PASS` | `PRG-4` (`v1.4.0`) | Exact pure LF shebang `#!/usr/bin/env node\n` (`0` CR bytes), `node ./dist/cli.js --version` -> `veribrain 1.4.0`, `CR_VIOLATIONS=0` across all modified/added repo & `dist/` files |
| **Zero Cloud Infra & Scale-to-Zero Guardrail** | `PASS` | `2026-11-28` | Zero Firebase/Cloud Run/Vector DB deployments; `apphosting*.yaml` (`minInstances: 0`) intact for Playbook `v2.0` `--verify`; external workspace isolation enforced via `VERIBRAIN_ISOLATION_SEGMENTS` |
| **Active Register Token-Diet (`< 8,192 B`)** | `PASS` | `2026-11-28` | All 7 active registers verified `< 8,192 B` & pure LF (`0` CRLF) |
