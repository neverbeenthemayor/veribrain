# VeriBrain — Design, CLI DX & Build-in-Public Strategy (CUDE)

- **Owner:** Chief User Design Engineer (CUDE) · **Baseline Date:** `2026-11-25`
- **Primary Surfaces:** Terminal CLI UX (`veribrain init / compile / eval / diff / observe`), Machine-Readable Context Output (`Zone A` + `Zone B`), and Tier 1 Build-in-Public Publishing (`gdocs` Engineering Blog + `gslides` 10-Slide Benchmark Talk Deck).

## 1. CLI & Weekly Brain Diff Ergonomics
- **Zero Rubber-Stamp Fatigue (`veribrain diff`):** Strictly capped at **`<= 5` plain-English bullets** and **`<= 25` terminal lines** total (`80`-column clean wrapping, zero ASCII art bloat). Every item ends with an explicit action (`[Keep]`, `[Revert]`, or `[Promote to DECIDED]`).
- **Explainable Citations:** Every factual assertion in Zone B prints a scannable 1-line provenance footer: `Based on: <claim_id> (<env>@<sha>)`.
- **Fail-Closed Error Messages:** Quarantine (`exit 2`) and token-budget (`exit 3`) failures state the exact `claim_id`, rule broken, and 1-command fix — never echoing raw secrets or opaque stack traces.

## 2. Tier 1 Build-in-Public Visual Standards (`gdocs` / `gslides`)
- **Voice Standard:** Direct, honest, engineer-to-engineer prose — zero AI-hype buzzwords, zero fabricated charts.
- **Deck Clarity (`docs/blog-outline-veribrain.md`):** 10-slide ceiling, max 1 core chart or architecture diagram per slide, high-contrast WCAG-legible typography, all metrics annotated with exact Stage 1 / Stage 2 test conditions.
