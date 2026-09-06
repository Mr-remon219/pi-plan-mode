# Design notes

Pi Plan Mode was designed after comparing three families of implementations:

- Codex CLI treats Plan Mode as a collaboration state distinct from its task checklist.
- Claude Code couples read-only exploration with an explicit plan review and approval transition.
- Existing Pi examples demonstrate the extension APIs, but commonly infer plans from assistant text or disable only built-in write tools.

This extension adapts those ideas to Pi rather than copying another client's permission model.

## Architecture decisions

1. **Extension, not host fork.** Pi's public extension API provides commands, tools, lifecycle hooks, session entries, prompt injection, and native TUI components.
2. **State is authoritative.** `off`, `planning`, and `ready` are explicit extension states. Assistant prose and todo markers do not change modes.
3. **The plan is an artifact.** `plan_submit` stores complete Markdown with a revision. The UI never reconstructs a plan from numbered-list regexes.
4. **The host owns approval.** The model has no exit or approve tool. Only the user-facing TUI can approve execution.
5. **Exploration-first policy.** Plan Mode keeps existing shell, web, MCP, research, and subagent capabilities. Only Pi's direct local-file mutation tools are removed and blocked; the system prompt forbids indirect project writes.
6. **Branch-local persistence.** State is reconstructed from the active `SessionManager.getBranch()` path, not the last entry in the entire session tree and not a lossy compaction summary.
7. **Pi-native UI.** The review surface uses Pi TUI components and keybindings, including its multiline editor and focus propagation for IME support.
8. **No automatic replay.** Reloading or resuming restores planning state but never resends an execution request.

## Mode flow

```text
off --/plan--> planning --plan_submit--> ready
 ^                 ^                       |
 |                 |--continue/feedback----|
 |                 |--direct edit----------|
 |                                         |
 +--exit without execution-----------------+
 +--explicit approval + one handoff---------+
```

`ready` means that a complete plan is awaiting a human decision. It does not mean implementation is complete.

## Tool policy

During `planning`, the extension preserves every tool that was active on entry except direct local-file mutation tools: `edit`, `write`, and `apply_patch`. It adds `plan_read` and `plan_submit`. In `ready`, exploration remains available and only `plan_submit` is removed.

The `tool_call` hook blocks the three direct mutation tools even if another tool-set change exposes them again. Shell, web research, MCP, dynamic discovery, and subagent tools remain usable. The system prompt requires shell and delegated agents to stay non-mutating and read-only with respect to local project files.

This freedom is intentional, but it is not an OS sandbox: general-purpose or third-party tools can have indirect write capabilities. Strong filesystem enforcement requires running Pi in a container/VM or sandbox with the workspace mounted read-only.

## Review and execution transition

The complete Markdown source is scrollable. The review actions are deliberately asymmetric: continuing, feedback, editing, and cancellation are immediate safe actions; execution requires a second confirmation. After confirmation, the extension revalidates that the plan revision is unchanged, Pi is idle, and no messages are queued. It restores only the tools that were active before Plan Mode and dispatches a single message containing the complete approved plan.

## Recovery

Each relevant transition appends a versioned custom entry. Tree navigation reconstructs from the selected active branch. Reload restores the saved pre-planning tool names against the current registry; a fresh process also intersects them with its startup baseline so stricter CLI tool settings are not widened. Any recovered plan remains non-executing until the user approves it again.

## Sources

- [OpenAI Codex CLI slash commands](https://developers.openai.com/codex/cli/slash-commands)
- [OpenAI Codex Plan Mode prompt](https://github.com/openai/codex/blob/main/codex-rs/collaboration-mode-templates/templates/plan.md)
- [Claude Code permission modes](https://code.claude.com/docs/en/permission-modes)
- [Pi extension documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)
- [Pi official Plan Mode example](https://github.com/earendil-works/pi/tree/main/packages/coding-agent/examples/extensions/plan-mode)
