# VeriBrain — Tier 1 Owner Console & FinOps Setup Checklist

Complete these Tier 1 steps manually (never commit credentials or paste API keys in chat):

## 1. Separate Cloud Projects (Option B — Doubles Free Tiers)
- [ ] Create Production project: **`veribrain`**
- [ ] Create Dedicated Staging project: **`veribrain-staging`**
- [ ] Link both projects to your Billing Account.

## 2. Hard FinOps Billing & Retention Guardrails (`<= $10.00/mo`)
- [ ] Configure Billing Budget Alerts at **`$5.00 (50%)`**, **`$9.00 (90%)`**, and **`$10.00 (100%)`**.
- [ ] Internal CFOE early-warning review trigger: **`$2.00/mo`**.
- [ ] Set **`Auto-reload: OFF`** on any AI/LLM prepay wallet.
- [ ] Set **Artifact Registry cleanup policy (`keep-most-recent: 3`)** on **BOTH** `veribrain` and `veribrain-staging`.

## 3. Browser API Key HTTP-Referrer Lockdown & Black-Box Check
- [ ] Restrict public browser keys to **exact prod & staging origins only** (zero `*.hosted.app` wildcards) and only required client APIs.
- [ ] Enable Firebase App Check (reCAPTCHA Enterprise Essentials — `10k/mo` free).
- [ ] Verify lockdown via `curl` (replace `<KEY>` and `<LIVE_URL>`):
```bash
# Expect HTTP 403 (no Referer)
curl -s -o /dev/null -w "%{http_code}\n" "https://identitytoolkit.googleapis.com/v1/accounts:createAuthUri?key=<KEY>"
# Expect HTTP 403 (evil Referer)
curl -s -o /dev/null -w "%{http_code}\n" -H "Referer: https://evil.example.com/" "https://identitytoolkit.googleapis.com/v1/accounts:createAuthUri?key=<KEY>"
```
