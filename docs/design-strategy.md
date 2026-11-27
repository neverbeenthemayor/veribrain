# VeriBrain — Design, CLI DX & Build-in-Public Strategy (CUDE)

- **Owner:** Chief User Design Engineer (CUDE) · **Baseline Date:** `2026-11-28` (`v1.3.0` / `PRG-3`)
- **Primary Surfaces:** Terminal CLI UX (`veribrain init / compile / eval / diff / retro / observe / attest-test / check-citations / stats`), Machine-Readable Context Output (`Zone A0`+`A1` & `Zone B`), Local `stdio` MCP (`7` tools incl. `veribrain_stats`), and Tier 1 Build-in-Public Publishing (`gdocs` Engineering Blog + `gslides` 10-Slide Benchmark Talk Deck + Launch Announcement Kit).

## 1. CLI, Diff, Telemetry & Weekly Retro Ergonomics
- **Zero Rubber-Stamp Fatigue (`veribrain diff`):** Strictly capped at **`<= 5` plain-English bullets** and **`<= 25` terminal lines** total (`<= 80`-column clean wrapping, plain ASCII). Actions are **tier-aware**: `[DEC]` (with concise title/slug) shows `[Keep] [Revise] [Deprecate/Revert]`, `[HYP]` shows `[Promote to DECIDED] [Promote to SCAR] [Discard]`, `[OBS]` shows `[Re-verify] [Prune]`, and `[SCAR]` shows `[Keep] [Renew] [Prune]`.
- **Honest Local ROI UX (`veribrain stats` & `veribrain_stats`):** `--format text` stays strictly `<= 80` cols plain ASCII (`20`-line global `--help`, `11`-line `stats --help`), pairs opt-in disabled/empty states with copy-pasteable 1-line tips, marks estimated rows `(est.)`, and ships an explicit `methodology_note` separating measured local counts/hashes from `~4 B/tok` & nominal `90%` cache estimates (`no provider billing telemetry`).
- **Uncapped Deep Audit (`veribrain retro`):** Outputs structured plain-ASCII Markdown/JSON covering health/`eval --strict`, 8-role `>= 1,024`-token KV-cache floor readiness, expiring `48h` items, `scars.md` test-link verification, and copy-pasteable `veribrain promote` hints.
- **Explainable Citations & Zero-Drift Docs:** Zone B assertions print `Based on: <claim_id> (<env>@<sha>)` (plus `, env-ttl` for bounded cross-commit observations); `veribrain check-citations` catches missing/superseded doc IDs deterministically.
- **Fail-Closed Error Messages:** Quarantine (`exit 2`), token-budget (`exit 3`), and provenance (`exit 4`) failures state exact rule + 1-command fix cleanly without leaking raw secrets or child stdout/stderr.

## 2. Tier 1 Build-in-Public Visual Standards (`gdocs` / `gslides`)
- **Voice Standard:** Direct, verified, engineer-to-engineer prose — zero AI-hype buzzwords, all quickstart snippets & metrics verified (`v1.1.0` public Blog Doc, 10-Slide Deck, and Announcement Kit).
- **Deck Clarity (`docs/blog-outline-veribrain.md`):** 10-slide ceiling, max 1 core chart or architecture diagram per slide, high-contrast WCAG-legible typography, all metrics annotated with exact test conditions.
