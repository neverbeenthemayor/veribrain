---
name: Feature Request
about: Propose a new capability or DX improvement for VeriBrain CLI or local stdio MCP
title: "[FR] "
labels: enhancement
---

## 1. Problem Statement & User Pain

- Who experiences this pain?
- What workaround is required today?

## 2. Proposed CLI / MCP Flow

- Entry point (CLI subcommand/flags or MCP tool schema):
- End-to-end flow and expected exit codes (`0`–`4`) / error behavior:

## 3. Acceptance Criteria ("Done Looks Like...")

- [ ] Criterion 1
- [ ] Deterministic output and targeted unit/golden test coverage

## 4. Non-Goals

- Out of scope for the initial change:

## 5. Invariant & Risk Check

- [ ] Preserves `$0.00/mo` runtime and zero new runtime dependencies beyond `@modelcontextprotocol/sdk` and `zod`
- [ ] Preserves byte-frozen Zone A KV-cache prefix invariance
- [ ] Preserves fail-closed provenance (`DECIDED` / `OBSERVED` / `HYPOTHESIS`) and quarantine rules (`0` raw secret echo)
