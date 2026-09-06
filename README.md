# Pi Plan Mode

A native, stateful Plan Mode for [Pi](https://github.com/earendil-works/pi): explore safely, stream a complete Markdown plan, review it in the TUI, and explicitly approve before execution.

Pi 原生、独立、有状态的 `/plan` 规划模式。它不是“少开几个工具”的提示词，也不是 todo 列表：规划状态、完整计划工件和执行批准由扩展管理。

## Features

- **Independent state** — `off → planning → ready`, persisted on the active Pi session branch.
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

When the plan is ready, the TUI provides:

1. Continue planning
2. Send revision feedback
3. Edit the complete plan
4. Exit without execution
5. Approve the current revision and execute

Approval requires a second explicit confirmation. Pi then restores the tools that were active before Plan Mode and sends one execution message containing the full approved plan.

## How it works

The extension combines three Pi-native controls:

1. A planning system-prompt injection that defines planning behavior.
2. The existing tool set, minus Pi's direct local-file mutation tools (`edit`, `write`, and `apply_patch`).
3. A `tool_call` gate that blocks those direct file-editing tools while leaving shell, web, research, MCP, subagent, and unknown extension tools available.

A successfully completed assistant turn containing exactly one `<proposed_plan>` block transitions `planning → ready`. The plan streams directly in the transcript; interrupted, malformed, or ambiguous blocks remain unapproved. The deprecated `plan_submit` tool is not registered, so large plans no longer depend on completing a giant JSON tool call.

State and full Markdown are stored once in versioned `CustomEntry` records and reconstructed with `SessionManager.getBranch()`. Compaction summaries and abandoned branches are not treated as authoritative state.

The captured plan body is limited to 64 KiB and is rejected rather than silently truncated. Direct editing uses Pi's native multiline editor; Enter saves and Shift+Enter inserts a newline.

## Security model

This extension deliberately favors exploration freedom over a restrictive allowlist. It hard-blocks Pi's direct `edit`, `write`, and `apply_patch` tools. The planning prompt also forbids modifying local project files through shell, subagents, or other tools while allowing non-mutating shell commands, tests, web research, and delegated read-only exploration.

This is **not an operating-system sandbox**. Shell and third-party tools are general-purpose capabilities, so a malicious or disobedient model could still find an indirect write path. Use an OS/container sandbox with a read-only workspace when filesystem-level enforcement is required. Trusted in-process extensions, other slash commands, SDK host code, and external terminals are outside this extension's boundary. Pi may write session data, caches, build artifacts, and search-tool support files.

If persistent state cannot be written, the extension fails closed for the current process and does not automatically restore implementation tools.

## Requirements

- Pi `0.85.1` or newer
- Node.js `24` or newer

The published package has no bundled runtime dependencies. Pi supplies its extension API, TUI, and TypeBox as peer dependencies.

## Development

Clone the repository and run:

```sh
npm run typecheck
npm test
npm run smoke
```

The verification script resolves the SDK from an existing Pi installation; it does not run `npm install` or `npx`. The test suite contains 19 focused tests. The smoke test launches the real Pi CLI in isolated RPC mode and validates extension loading, `/plan`, free shell exploration, removal of direct edit tools, reload, and exact tool restoration.

See [docs/design.md](docs/design.md) for the researched design and architecture decisions.

## Limitations

- The review panel shows lossless Markdown source rather than a rich rendered preview.
- No production-model end-to-end test is included; event capture is covered through Pi lifecycle tests and the real CLI loader/RPC smoke test.
- Desktop IME behavior relies on Pi's native editor and has automated focus/paste coverage, but no manual cross-terminal certification.
- Shell and third-party tools are intentionally available; the prompt forbids local project writes through them, but strong enforcement requires a read-only OS/container mount.
- Multiple extensions that independently replace Pi's active tool set are not supported together.

## License

[MIT](LICENSE) © 2026 Mr-remon219
