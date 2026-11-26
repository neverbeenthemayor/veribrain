---
name: feature-request-intake
description: Interactive Feature Request Intake & CPM ICE/Fibonacci Scoring workflow.
---

# Interactive Feature Request Intake & CPM Scoring

1. Collect perceived urgency (`P0-P3`), target Gate, target persona(s), and risk flags (Security, FinOps, Mobile `375x812`, Infra/Console, Data Migration).
2. Capture 4 plain-English bullets: Problem, Ideal Flow, Acceptance Criteria, Non-Goals (`<= 8 pts`).
3. Output a **CPM Feature Scorecard**:
   - **Assigned ID:** next `PM-xxx`
   - **ICE Score (`I x C x E / 125`):** 1-5 per dimension with blunt 1-line justification
   - **Modified Fibonacci Points:** `1 / 2 / 3 / 5 / 8 / 13` (`13` = mandatory split)
   - **Budgeted Gate Math:** Print before/after weekly totals vs. the `20-pt` weekly cap; auto-recommend `Post-Release Gate 1+` parking for low launch-day items (`<= 0 pts` net delay)
   - **Chiefs Required & Ruling #8 Verdict:** `ACCEPTED_TO_BRIEF` | `PARKED` | `SPLIT_REQUIRED` | `REJECTED`
