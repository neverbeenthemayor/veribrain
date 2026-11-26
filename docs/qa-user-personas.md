# VeriBrain — Synthetic Target-Market & Adversarial Personas (CQE)

Target Market: Solo founders, staff engineers, and AI-native dev teams running Antigravity, Claude Code, Cursor, and Codex.

Use these 5 realistic developer & red-team personas to torture-test VeriBrain's CLI DX, provenance boundaries, and documentation (zero polite AI rubber-stamping):

- **UA-01 (Solo Multi-Agent Founder):** Runs 6+ AI agents across Antigravity and Claude Code on a tight `$10-$30/mo` budget; wants `npx veribrain init` working in `< 2 minutes` and immediately cancels any tool that silently burns tokens overnight.
- **UA-02 (Skeptical Staff Security Engineer):** Assumes every agent memory store is a persistent prompt-injection backdoor; immediately tries `</untrusted_hint>` tag breakouts, fake `DECIDED` writes, and simulated API key leaks to verify exit code `2` fail-closed quarantine.
- **UA-03 (Cache-Obsessed LLM Systems Engineer):** Inspects raw `Zone A` SHA-256 diffs across commits; flags even a single timestamp or whitespace change inside the static prefix as a P0 KV-cache regression.
- **UA-04 (Impatient Cross-IDE Power User):** Switches between Antigravity, Cursor, and Codex on the same repo; refuses cloud setup or vector DB docker containers — demands zero-config local `stdio` MCP parity.
- **UA-05 (Tired Friday-Evening Maintainer):** Opens `veribrain diff` at 5:00 PM Friday; abandons the review immediately if the diff exceeds 1 screen (`> 5` bullets or `> 25` lines) or uses dense jargon.
