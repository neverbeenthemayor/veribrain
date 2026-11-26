# VeriBrain Operating Guardrails (v2.0)

1. **Strict Media QA Gate (`0s` Start + Every Seam + End):** Inspect `t = 0.5s`, every cut boundary, and final slate on generated media before declaring ready.
2. **Pre-Flight Check Tool Limits & Shutdowns First:** Verify API versions (`v1beta`), free-tier quotas, MCP permissions, and deprecation notices (`< 60s`) before writing scripts or charters.
3. **Budgeted Gate Math on Every New Triage:** Print before/after weekly point totals against the `20-pt` cap whenever scoring new `PM-*` items; auto-recommend `Post-Release Gate 1+` parking for low launch-day items (`<= 0 pts` net delay).
4. **Plain, Conversational English + Tighter Daily Threads:** Zero hype, jargon, or cheesy hashtags on founder outreach; split Ops/Marketing threads from Engineering sprints (or run `/compact` mid-day).
5. **Post-Release Gate Naming:** Label post-`v1.0` waves `Post-Release Gate 1`, `Post-Release Gate 2`, `Post-Release Gate 3` (`PRG-1+`), capped at `<= 20 pts` each.
