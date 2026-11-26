# Gate 4 Brief — Stage 4 Open-Source `v1.0.0` & Blog Launch (`PM-401`–`PM-404`, `14 pts`)

- **Gate:** Gate 4 (`Stage 4 Open-Source & Blog Launch`) · **Cap:** `14 pts <= 20-pt` Weekend Cap
- **Trigger:** Explicit Owner `"GO"` (`2026-11-25`; Sat `2026-11-28` timer `task-21` cancelled)
- **Strict Separation:** `Author != Verifier`; zero writes to external repositories; zero cloud/vector DB deployments; all 7 active registers strictly `< 8,192 B` UTF-8 LF.

---

## Scope & Story Breakdown

### `PM-401` (`P0`, `5 pts` — Builder + CUDE): `v1.0.0` Package Polish, Docs & Fresh-User Dry Run
- Bump `package.json`, `src/cli.ts` (`CLI_VERSION`), and `src/mcp/server.ts` (`version`) cleanly to `1.0.0`; add open-source npm metadata (`keywords`, `repository`, `homepage`, `bugs`); include `CHANGELOG.md` in `files` (`["dist", "README.md", "LICENSE", "CHANGELOG.md"]`).
- Refresh `README.md` for `v1.0.0` open-source users: TL;DR, Quickstart (`init`, `eval --strict`, `compile`, `diff`, `mcp --print-config`), strictly observed Stage 1–3 benchmark table (100% verbatim from `QUALITY.md` & `benchmarks/results/*.json`), 5-tool MCP matrix linking `docs/mcp-clients.md`, and links to the Build-in-Public Google Doc & 10-Slide Deck.
- Author `CHANGELOG.md` (`v1.0.0` Keep-a-Changelog format, pure LF) and `CONTRIBUTING.md` (Node 24 dev setup, test/lint/wind-tunnel commands, `Author != Verifier` PR bar, responsible security disclosure; pure LF).
- Execute a fresh-user tarball dry run (`npm pack` -> unpacked temp dir -> `init`, `eval --strict`, `compile`, `diff`, `mcp --print-config`, `--version` = `1.0.0`), then remove temporary tarball/dir cleanly.

### `PM-402` (`P1`, `3 pts` — CIE + Builder + Security): Linux CI Symlink Proof (`P3-G2-2`) & `@types/node` `^24` Pin
- Pin `@types/node` in `package.json` + `package-lock.json` to an exact Node 24 LTS release (`24.x.x`) so `tsc --noEmit` guards Node 24 API compatibility at compile time.
- Add a fast Red-Team Wind Tunnel CI step in `.github/workflows/ci.yml` (`ubuntu-latest`, Node 24) that executes `node benchmarks/run_redteam.mjs` and explicitly asserts `129/129` pass, `0` escapes, `0` leaks, AND `RT-PRV-18` `symlink_created=true` on Linux — closing `P3-G2-2` live in GitHub Actions!

### `PM-403` (`P0`, `3 pts` — CQE + Security + CIE + Bench + CFOE): Final Pre-Public `v1.0.0` Multi-Chief Audit
- **CQE:** Independent `npx tsc --noEmit`, `npm run lint`, `npm test`, fresh-user `veribrain-1.0.0.tgz` tarball smoke verification, and `QUALITY.md` update (`< 8,192 B` LF).
- **Security:** Final Red/Blue pre-public audit confirming zero secrets/PII/internal host paths across tracked files, `npm pack` contents, and closure of `P3-G2-2` via real Linux CI run (`0` open `P0`–`P3`).
- **CUDE:** Open-source DX & clarity audit of `README.md`, `CHANGELOG.md`, `CONTRIBUTING.md`, and `veribrain --help`/`--version`.
- **Bench:** Numerical provenance audit of `README.md` & `CHANGELOG.md` against `benchmarks/results/*.json` & `QUALITY.md`.
- **CIE & CFOE:** Final `npm audit --audit-level=high` (`0` vulns), `veribrain-1.0.0.tgz` audit, live Linux GitHub Actions CI green verification, `$0.4851 / $10.00` MTD FinOps sign-off, and `7/7` active registers `< 8,192 B`.

### `PM-404` (`P1`, `3 pts` — CPM + Owner): `v1.0.0` Release Cut & Launch Readiness
- Archive Gate 4 backlog, update `PRODUCT.md`, `SECURITY.md`, `QUALITY.md`, `docs/finops-ledger.md`, `docs/infrastructure-audit.md`, `docs/progress-reports.md`, `docs/blog-outline-veribrain.md`, and sync full Google Drive mirror.
- Run `bootstrap_startup.py --verify <repo-root>`, promote `pre-staging` -> `staging` -> `main`, tag annotated `v1.0.0`, push branches + tag to `origin`, and verify live green `ubuntu-latest` CI run (including `RT-PRV-18` `symlink_created=true`).
- Hand Owner the final `v1.0.0` launch checklist (keeping GitHub repo private and Google Doc/Slides private until Owner chooses to flip visibility or run `npm publish`).
