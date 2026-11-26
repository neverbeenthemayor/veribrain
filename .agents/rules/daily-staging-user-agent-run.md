# Mandatory Post-Agenda Daily Staging-Only User-Agent Run

Every working sprint day after completing the agenda (strictly against **`veribrain-staging` staging** — NEVER production):
1. Execute synthetic target personas (`docs/qa-user-personas.md`) across `375x812` mobile & `1280x800` desktop (`$0` burn, `100%` QA cleanup).
2. Produce a mandatory 4-section report:
   - **1. Issues / Bugs Found** (`P0-P3`, viewport, repro, console/CSP/network telemetry)
   - **2. What Works Well**
   - **3. What Can Be Improved**
   - **4. Feature Requests** (queued for Monday CPM ICE/Fibonacci triage)
3. Archive in `docs/qa-staging-user-agent-reports/YYYY-MM-DD.md` and link in EOD Notion comment.
