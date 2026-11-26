# VeriBrain — Product Strategy & Multi-Chief Governance (Rulings #1-#9)

- **Founder / Owner:** Ian Mayor (`@neverbeenthemayor`) · **Execution Mode:** `MULTI_AGENT`
- **Monthly Cloud Cap:** `<=$10.00/mo` · **Playbook Version:** `v2.0`

## 1. 7-Chief Core Roster + Slot #8 (Max 8 Cap)
1. **CPM / Chief of Staff** (`PRODUCT.md`, briefs, agendas, Notion sync — never edits `src/**`)
2. **Chief Builder** (`src/**`, unit tests, rules; offloads Cloud deploys to CIE & `e2e/**` to CQE)
3. **Chief Security** (`SECURITY.md`, pre-gate Red/Blue pen-tests, compliance)
4. **Chief Infra (CIE)** (CI/CD, `apphosting*.yaml`, `next.config`, Cloud deploys, Pragmatic SRE)
5. **Chief User Design (CUDE)** (`docs/design-strategy.md`, `375x812` & `1280x800` gate, WCAG 2.2 AA)
6. **Chief Quality (CQE)** (`QUALITY.md`, `e2e/**`, daily staging-only Synthetic User Agents)
7. **Chief FinOps (CFOE)** (`docs/finops-ledger.md`, unit economics, Ruling #9 token audit)
8. **Chief Benchmark & Context Scientist (`chief-bench`, Slot #8)** — KV-cache prefix mechanics, tokenizer calibration, Stage 2 Colab/AI Studio harnesses (`benchmarks/**`, `docs/benchmarks/README.md`), read-only advisory in Stage 1; never edits `src/**`, independently verified by `CQE`/`Security`/`CFOE` (`chief-cgo` retired for VeriBrain).

## 2. Binding Rulings (#1-#9)
1. **4 Sequential Launch Gates + Post-Release Gates (`PRG-1+`)**: Gate 1-4 for `v1.0`; post-launch waves named `Post-Release Gate 1`, `Post-Release Gate 2`, etc. (`<= 20 pts` each).
2. **4-State Lifecycle:** `OPEN` -> `IN_PROGRESS` -> `READY_FOR_RETEST` -> `VERIFIED_CLOSED` (zero self-verification).
3. **4-Part Feature Brief + ICE/Fibonacci:** Problem, Target User, Core Requirements (with Non-Goals), Metrics + `ICE / 125` + Budgeted Gate Math (`<= 20 pts/wk`).
4. **Tier 1 / 2 / 3 Rights:** Stop & ask Owner on credentials/billing/spend/prod irreversible actions/privacy promises (Tier 1); notify & act immediately on prod P0 outages (Tier 2); CPM clears routine Chief handoffs (Tier 3).
5. **Pre-Gate Red/Blue Security Exercises:** Safe RoE only (no live DoS); zero Gate closes with open `P0`/`P1`.
6. **3-Tier Pipeline:** `pre-staging` -> `staging` (Tue Soak) -> `main` (Wed Prod). Separate staging project `veribrain-staging`.
7. **Modified Fibonacci (`1/2/3/5/8/13`):** `13` = mandatory Epic split; `15-20 pts/week` cap.
8. **1-Commit EOD Register Batch & Daily Staging UA:** `< 8,192 B` active registers, `docs/archive/`, daily staging-only UA sweep, Fri 15-min 1-page Retro (max 2 fixes/week).
9. **6-Point Token Efficiency (CFOE):** Model tiering, daily `/compact`, zero-ack rule, shared CI truth, surgical line reads, pointer-only registers.
