# Pi Plan Mode

A native, stateful Plan Mode for [Pi](https://github.com/earendil-works/pi): explore safely, stream a complete Markdown plan, review it in the TUI, and explicitly approve before execution.

Pi 原生、独立、有状态的 `/plan` 规划模式。它不是“少开几个工具”的提示词，也不是 todo 列表：规划状态、完整计划工件和执行批准由扩展管理。

## Features

- **Independent state** — `off → planning → ready → handoff_pending`, recovered from the active Pi session branch with explicit disk-evidence checks.
- **Free exploration** — keeps your existing shell, web research, search, MCP, and subagent tools available while planning.
- **Streamed plan artifact** — the model outputs ordinary `<proposed_plan>` Markdown; the host captures it after a successful turn, without a giant tool-call argument.
- **Native TUI review** — scroll the full plan, continue planning, send feedback, edit the plan directly, exit without executing, or approve execution.
- **Explicit approval** — the model cannot approve its own plan. Cancellation never executes.
- **Session-aware recovery** — restores state across reload, resume, tree navigation, and compaction without replaying execution.
- **Safe headless behavior** — RPC, JSON, and print modes never auto-approve a plan.

## Install

One command:

```sh
pi install npm:@mr_remon/pi-plan-mode
```

Then start a new Pi session, or run `/reload` in an existing session.

To remove it:

```sh
pi remove npm:@mr_remon/pi-plan-mode
```

> Do not load this together with another extension that owns `/plan` or replaces the active tool set.

## Usage

```text
/plan Design a migration from REST polling to webhooks
```

Useful commands:

| Command | Action |
| --- | --- |
| `/plan <task>` | Enter Plan Mode and start planning |
| `/plan` | Enter Plan Mode or open the current plan review |
| `/plan --review` | Reopen the review TUI |
| `/plan --continue [feedback]` | Continue planning, optionally with revision feedback |
| `/plan --status` | Show the current state, revision, and plan size |
| `/plan --exit` | Exit Plan Mode without executing |
| `/plan --retry` | Reopen explicit review of a pending handoff |
| `/plan --cancel-handoff` | Cancel pending handoff, return to ready |
| `/plan --execute-fresh` | Explain the current Pi API limitation; does not create or execute a new session |

When the plan is ready, the TUI provides:

1. Continue planning
2. Send revision feedback
3. Edit the complete plan
4. Exit without execution
5. Approve the current revision and execute

Approval requires a second explicit confirmation. A pending record is saved and verified on disk before dispatch. Only a matching in-process approval and actual user-message lifecycle acceptance release the implementation gate. A resumed pending handoff never executes automatically. Tool-set conflicts prevent silent restoration of obsolete permissions.

## How it works

The extension combines three Pi-native controls:

1. A planning system-prompt injection that defines planning behavior.
2. The existing tool set, minus Pi's direct local-file mutation tools (`edit`, `write`, and `apply_patch`).
3. A `tool_call` gate that blocks those direct file-editing tools while leaving shell, web, research, MCP, subagent, and unknown extension tools available.

A successfully completed assistant turn containing exactly one `<proposed_plan>` block transitions `planning → ready`. The plan streams directly in the transcript; interrupted, malformed, or ambiguous blocks remain unapproved. The deprecated `plan_submit` tool is not registered, so large plans no longer depend on completing a giant JSON tool call.

Markdown artifacts are deduplicated by SHA-256 on the active branch; v2 state records reference them without repeating the body. v1 snapshots migrate append-only. Assistant transcript and handoff messages still contain full plans. On outbound context copies, uniquely identified older unsigned text plans are replaced with references; signed/ambiguous messages are preserved, so savings depend on the Provider. Compaction summaries and abandoned branches are not authoritative state.

The captured plan body is limited to 64 KiB and is rejected rather than silently truncated. Direct editing uses Pi's native multiline editor; Enter saves and Shift+Enter inserts a newline.

## Security model

This extension deliberately favors exploration freedom over a restrictive allowlist. It hard-blocks Pi's direct `edit`, `write`, and `apply_patch` tools. The planning prompt also forbids modifying local project files through shell, subagents, or other tools while allowing non-mutating shell commands, tests, web research, and delegated read-only exploration.

This is **not an operating-system sandbox**. Shell and third-party tools are general-purpose capabilities, so a malicious or disobedient model could still find an indirect write path. Use an OS/container sandbox with a read-only workspace when filesystem-level enforcement is required. Trusted in-process extensions, other slash commands, SDK host code, and external terminals are outside this extension's boundary. Pi may write session data, caches, build artifacts, and search-tool support files.

If persistent state cannot be written, the extension fails closed for the current process and does not automatically restore implementation tools.

## Requirements

- Pi `>=0.85.1 <0.86.0` (verified: `0.85.1`)
- Node.js `24` or newer

The published package has no bundled runtime dependencies. Pi supplies its extension API, TUI, and TypeBox as peer dependencies.

## Development

Clone the repository and run:

```sh
npm run typecheck
npm test
npm run smoke
npm run benchmark
```

The verification script resolves the SDK from an existing Pi installation; it does not run `npm install` or `npx`. Exact checked dependency/tool versions are recorded in `verification-environment.json`; mismatches fail explicitly. Tests and source are typechecked. Tests include an offline deterministic real SDK stream and fresh-process disk restoration. The CLI smoke validates loading, `/plan`, free shell exploration, edit-tool removal, reload, and tool restoration. The benchmark measures storage/context fixture costs, not model quality or network latency.

See [docs/design.md](docs/design.md) for the researched design and architecture decisions.

## Limitations

- The review panel shows lossless Markdown source rather than a rich rendered preview.
- No production-model end-to-end test is included. A deterministic real SDK stream verifies capture and first-request handoff tools; UI decisions are supplied by a test adapter.
- Pi 0.85.1 does not initially write an empty session until an assistant message exists. `/plan --status` distinguishes verified disk state from memory-only state. Memory-only approval is not dispatched.
- Fresh-context execution is unavailable under that public API limitation; `/plan --execute-fresh` is an explicit non-executing diagnostic. Pre-first-assistant crash recovery is not guaranteed.
- Signed, reasoning or responseId-bearing messages are conservatively retained; the benchmark's context savings do not apply universally.
- Disk read-back is not fsync; request acceptance does not prove implementation success or exactly-once execution.
- Desktop IME behavior relies on Pi's native editor and has automated focus/paste coverage, but no manual cross-terminal certification.
- Shell and third-party tools are intentionally available; the prompt forbids local project writes through them, but strong enforcement requires a read-only OS/container mount.
- Multiple extensions that independently replace Pi's active tool set are not supported together.

## License

[MIT](LICENSE) © 2026 Mr-remon219
