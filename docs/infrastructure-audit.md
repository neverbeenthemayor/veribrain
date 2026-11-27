# VeriBrain — Active Infrastructure & Post-Deploy Audit Log

- **Owner:** Chief Infrastructure Engineer (CIE) · **Release Target:** `v1.2.0` (`PRG-2` · `2026-11-27`)
- **Repository:** `https://github.com/neverbeenthemayor/veribrain` (`PUBLIC` · `main`, `staging`, `pre-staging`)
- **Architecture Mode:** Local-First Node.js 24 LTS CLI + Local `stdio` MCP (NO Firebase Hosting / Cloud Run / Vector DB deploys)

| Check / Target | Status | Date / Gate | Evidence / Notes |
|---|---|---|---|
| **Public GitHub Repo & Branch/Tag Protection** | `PASS` | `2026-11-26` | `neverbeenthemayor/veribrain` (`PUBLIC`); Rulesets `28172892` (branch) & `28172893` (tags `v*`), Secret Scanning + Push Protection, Private Vulnerability Reporting, Fork PR approval, SHA-pinned GitHub-owned Actions active |
| **Live Public Releases (`v1.1.0` GitHub & npm)** | `PASS` | `2026-11-26` | Signed root `7d51715` + tag `v1.1.0`, live CI Run `45845428157` PASS (`25s`), GitHub Release `v1.1.0`, and remote `npx --yes veribrain@1.1.0 --version` verified |
| **3-Job SHA-Pinned CI (`.github/workflows/ci.yml`)** | `PASS` | `PRG-2` (`v1.2.0`) | `NODE_VERSION: '24'`, `Contributor Policy Guardrail (Runtime Deps & LF)` (`deps=@modelcontextprotocol/sdk,zod`, `LF=clean`), `timeout-minutes: 5`, `CODEOWNERS` covers new `PRG-2` commands |
| **PRG-2 `v1.2.0` Packaging & Zero-Warn Tarball (`PM-601–605`)** | `PASS` | `PRG-2` (`v1.2.0`) | `package.json` & `package-lock.json` (`v3`) synced at `veribrain@1.2.0` (`"bin": { "veribrain": "dist/cli.js" }`, `"repository.url": "git+https://github.com/neverbeenthemayor/veribrain.git"`); `npm publish --dry-run` -> `veribrain-1.2.0.tgz` (`48` files, `97.4 kB` packed / `482.7 kB` unpacked, **0 `npm warn publish` lines**, strictly `44` `dist/**` + `CHANGELOG.md`/`LICENSE`/`README.md`/`package.json`) |
| **PRG-2 `v1.2.0` Supply Chain & Node 24 LTS Parity** | `PASS` | `PRG-2` (`v1.2.0`) | Runtime `dependencies` strictly `2` (`@modelcontextprotocol/sdk@1.32.2`, `zod@4.6.7`, `95` prod lockfile entries); live `npm audit --omit=dev` -> `found 0 vulnerabilities`; `0` LLM/cloud deps |
| **CLI Shebang & Pure LF Parity (`dist/cli.js`)** | `PASS` | `PRG-2` (`v1.2.0`) | Exact pure LF shebang `#!/usr/bin/env node\n` (`0` CR bytes), `node ./dist/cli.js --version` -> `veribrain 1.2.0`, `CR_VIOLATIONS=0` across all repo/src/doc files |
| **Gates 1–4 & PRG-1 Baseline Archive** | `PASS` | `2026-11-26` | Gates 1–4 (`v1.0.0`, `32` files / `50.8 kB`, Linux `RT-PRV-18` Run `45621060408`) + `PRG-1` (`v1.1.0`, `42` files / `79.3 kB`, Run `45845428157`, npm `1.1.0`) |
| **Zero Cloud Infra & Scale-to-Zero Guardrail** | `PASS` | `2026-11-27` | Zero Firebase/Cloud Run/Vector DB deployments; `apphosting*.yaml` (`minInstances: 0`) intact for Playbook `v2.0` `--verify`; external workspace isolation enforced via `VERIBRAIN_ISOLATION_SEGMENTS` |
| **Active Register Token-Diet (`< 8,192 B`)** | `PASS` | `2026-11-27` | All 7 active registers verified `< 8,192 B` & pure LF (`0` CRLF) |
