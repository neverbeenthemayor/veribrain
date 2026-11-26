# Security Policy

## Supported Versions

| Version | Supported |
| --- | --- |
| `1.1.x` | Yes |
| `< 1.1.0` | No (please upgrade to the latest `1.1.x` release) |

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues, discussions, or pull requests.**

Report vulnerabilities privately through GitHub's Private Vulnerability Reporting flow:

- <https://github.com/neverbeenthemayor/veribrain/security/advisories/new>

Include a clear description of the issue, affected version (`veribrain --version`), and minimal reproduction steps.

## In-Scope Threat Classes

- **Quarantine & Secret Leaks:** Bypassing `Exit 2` detection or leaking raw secrets, tokens, or unwhitelisted PII in CLI/MCP output or compiled context
- **Prompt-Injection Escapes:** Breaking `<untrusted_hint non_authoritative="true">` containment via encoding, NFKC, bidi, or tag smuggling
- **Provenance & Write-Authority Bypasses (`Exit 4`):** Allowing agents or unverified inputs to self-attest `DECIDED` rules, `OBSERVED` claims, `.brain/scars.md`, or `signed_by` identity checks
- **Filesystem & Worktree Confinement:** Symlink escapes, UNC/device-path probes, path traversal in `mirror_dirs`, `.git` worktree/hook resolution, `promote`, or `.brain/hypotheses/` writes

## Safe Reproduction Rules

- Use **strictly synthetic placeholder data** in every report and proof of concept — never submit real API keys, credentials, personal PII, or external user data.
- Test strictly against local disposable `.brain/` directories on your own machine; never probe third-party repositories, accounts, or hosted services.
