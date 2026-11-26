---
name: pragmatic-sre
description: 5-point Pragmatic Startup SRE Checklist enforced by CIE before every infra/rules/deploy change.
---

# Pragmatic Startup SRE Mandate (CIE)

Before every merge or deploy touching infra, DB/storage rules, CI, or external APIs, verify all 5 points:
1. **Pre-Deploy Platform Limits Gate:** DB rules AST `< 1,000` expressions, payload/file caps enforced, hosting quotas verified.
2. **Zero Silent Failures:** Ban empty `.catch(() => {})` blocks; log structured non-PII diagnostics and surface calm user recovery UI.
3. **Graceful External Degradation:** Explicit bounded retry/fallback on `402`, `429`, `503`, offline, and timeout errors (never infinite loops).
4. **60-Second Rollback + Live Smoke:** Record prior known-good rollback SHA and verify live HTTP `200`, headers, and core flow immediately post-deploy.
5. **Hard `$0` Paid-SRE Ceiling:** Stay inside free-tier uptime/crash tooling and `<=$10.00/mo` total cap until CFOE signs off.
