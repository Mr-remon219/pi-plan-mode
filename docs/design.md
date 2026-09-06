# Design: v0.4

## Contract

Plan Mode is an exploration-first Pi extension, not an OS sandbox or an execution orchestrator. It retains shell, web, MCP and subagent capabilities. Only `edit`, `write`, `apply_patch` are directly blocked; prompts forbid indirect implementation. `ready` means syntactically valid and awaiting review, not professionally validated.

## Stream capture

Plans use standalone `<proposed_plan>` lines in normal assistant text. A line parser handles fences and CRLF (normalized to LF for the artifact). Nested, duplicate, stray and incomplete delimiters are rejected. Delimiters inside fences are examples, not control signals. Tags spanning content blocks are conservatively rejected. Only a current assistant message begun in planning, ending with `stop` and no tool calls, can be captured. Captures bind epoch, revision, timestamp, unique persisted entry identity, full-message fingerprint and block offsets. Replayed turn_end events cannot create another revision.

## Branch-local records

- `pi-plan-mode/artifact/v2`: immutable Markdown, SHA-256 ID, byte count. Reuse is limited to artifacts on the active branch and validated before reuse.
- `pi-plan-mode/state/v2`: phase, revision, artifact reference, original tool baseline, capture source and optional pending handoff. No Markdown body.
- `pi-plan-mode/handoff/v2`: approval identity and observed acceptance, not proof implementation completed.

`restore` follows the active branch only and validates hashes, bytes, schemas and pending references. v1 snapshots remain readable and migrate through new appended artifact/state entries. Orphan artifacts are not approvals. Write errors latch failure in the extension instance; re-reading in-memory state does not clear the latch. Recovery checks disk when a session file exists. This is read-back verification, not fsync or power-loss durability.

## Context versus disk

State snapshots no longer repeat the body. The transcript still stores the original assistant plan and any handoff message. `context` pruning works on a copy, never on the transcript: only uniquely fingerprint-matched source messages have the specific captured block replaced. Preamble/postscript and non-plan messages remain unchanged. The current candidate stays in context until its matching accepted handoff is present.

Signed/responseId-bearing messages, non-text blocks, unknown block metadata and ambiguous matches are retained. This is deliberately conservative and can mean **no token saving for a given Provider**, especially reasoning/signed responses. The deterministic benchmark uses unsigned text messages and does not establish production-model cost parity. Explicit `plan_read` results can also repeat the body.

## Approval handoff

`off → planning → ready → handoff_pending → off`.

A TUI review and second confirmation create a random in-process approval capability bound to revision/hash. Pending state is appended and its active disk reference chain read back before `sendUserMessage`. Its void result is not success. The extension observes matching extension-source input, then `before_agent_start` prepares the first tool snapshot while leaving pending state and the tool gate in place. Matching `message_start` for that user prompt records acceptance and off; failure restores restrictions and aborts. The real SDK fixture verifies that the first execution request sees the intended tools and no planning prompt. No tool is executed by that fixture.

Restarted pending state has no in-process capability. It never automatically dispatches or trusts pasted markers. `/plan --review` offers retry review or cancellation; `/plan --retry` reopens review, `/plan --cancel-handoff` returns to ready. Request acceptance is not exactly-once execution or completion. Trusted in-process extensions remain outside the security boundary.

## Public API limitation: fresh execution

Pi 0.85.1 delays initial session disk writes until an assistant message exists (`SessionManager._persist`, implementation inspected; not called by the extension). There is no public extension flush. A new-session setup containing only artifacts/state is not a durable authorization boundary.

Supervisor-approved fallback: `/plan --execute-fresh` reports unavailable without creating or dispatching a session. Empty-session `/plan` remains memory-only until a genuine assistant response triggers Pi persistence. We neither fabricate assistant messages in production nor add a journal/private API. Full fresh execution and pre-first-assistant crash recovery are **not delivered**.

## Tool drift

The extension tracks its last applied set. Observed external changes trigger a conflict warning, intersect saved restoration permissions with the current set and do not silently restore removed tools. Approval is blocked during a conflict. Exit preserves the conservative set; explicitly reentering establishes a new baseline. This cannot detect hidden policy changes or create a host permission overlay.

## Verification

`npm test`: parser, origin identity, artifact deduplication, v1 migration, corrupt/sibling references, pending behavior, real disk reads in fresh processes, compaction records, UI and real SDK stream.

`npm run smoke`: isolated real CLI/RPC loader, command/reload and tools (no remote model).

`npm run benchmark`: 50 KiB unsigned plans, 1/5/10 revisions, three transitions per revision, actual JSONL byte sizes and context body copies. Timings are local fixture timings, not network/token/model benchmarks. The legacy fixture models v0.3 whole-state writes; its restore uses the v2 reader's v1 compatibility path.

The checked SDK/TUI/AI/TypeBox/Node typings/TypeScript versions are in `verification-environment.json`. Tests are included in strict TypeScript checking. No runtime dependency was added.

## References

- [Pi extensions](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)
- [Codex Plan Mode](https://github.com/openai/codex/blob/main/codex-rs/collaboration-mode-templates/templates/plan.md)
- [Claude Code permission modes](https://code.claude.com/docs/en/permission-modes)

The lifecycle and persistence decisions were verified against the local Pi 0.85.1 documentation/types/source, not assumed from a moving main branch.
