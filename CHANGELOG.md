# Changelog

## 0.2.0 — 2026-09-06

- Replace the restrictive planning-tool allowlist with an exploration-first policy.
- Preserve shell, web research, MCP, search, subagent, and other extension tools in Plan Mode.
- Block only Pi's direct local-file mutation tools: `edit`, `write`, and `apply_patch`.
- Keep non-mutating shell exploration available and document the OS-sandbox boundary honestly.

## 0.1.0 — 2026-09-06

- Initial public release.
- Add independent `off`, `planning`, and `ready` states.
- Add dedicated read-only exploration tools and default-deny tool gating.
- Add complete Markdown plan submission and active-branch persistence.
- Add native TUI review, feedback, direct editing, safe exit, and explicit execution approval.
- Add reload/session recovery, 18 focused tests, strict type checking, and real Pi CLI/RPC smoke coverage.
