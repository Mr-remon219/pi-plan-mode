# v0.4.0 candidate verification

Verified locally at 2026-09-06 08:29 UTC, against baseline `a0a5f6592abd9e0ebcba750672cd645f6532e130`. This is not a release approval.

## Commands

- `npm test`: **38 passed** after branch-isolation fix (previous directed candidate: 37), 0 failed/skipped (includes real SDK success, intercepted handoff and acceptance-write-failure).
- `npm run typecheck`: passed; source, tests and TypeScript benchmark included.
- `npm run smoke`: passed; real isolated CLI/RPC loader and reload/tool checks, zero extension errors and zero model starts in this smoke.
- `npm run benchmark`: passed; local deterministic storage/context fixture below.
- `git diff --check`: passed.
- `npm pack --dry-run --json`: passed; 10 package files, no bundled dependencies. Does not publish or install.

Node 24.16.0; SDK/TUI/AI 0.85.1; TypeBox 1.3.7; Node typings 22.19.19; TypeScript 7.0.2. Exact expected dependency/tool versions are checked by `scripts/verify.mjs` and listed in `verification-environment.json`.

## Evidence boundaries

The real SDK test streams a plan through Pi's actual message/turn lifecycle, then supplies native-review actions through a test UI adapter. It checks the first execution request has write tools, no planning system instruction, off state backed by disk, and one unsigned body copy. The model is an isolated deterministic provider; no actual write tool runs. Intercepted input remains pending without a second request. An acceptance-write failure remains pending and aborts.

The disk tests reopen actual JSONL files in three separate Node processes, covering planning/ready/pending after normal persistence, plus compaction records. A synthetic assistant storage fixture seeds the storage-only test; production code never fabricates assistant entries. An independent real SDK test proves that a genuine assistant response flushes the session. Memory-before-disk append failure is tested by leaving an in-memory state record and throwing; the instance stays latched and rejects exit.

Compaction context testing uses copied retained-tail messages and an actual compaction entry; it is not a full remote-model summarization benchmark. No power-failure/fsync or arbitrary crash scheduling guarantee is tested.

## Cost fixture

Each revision is 51,200 UTF-8 bytes with three state transitions. Legacy records model v0.3's whole-state writes; legacy recovery timing uses the current reader's v1 compatibility path. New capture timing includes parsing/hash and three writes, while legacy timing measures those state writes. These are **not apples-to-apples model latency measurements**.

| Revisions | Legacy JSONL bytes | v2 JSONL bytes | Outbound body copies, legacy → v2 | v2 context bytes | legacy write / restore ms | v2 capture / restore ms |
|---:|---:|---:|---:|---:|---:|---:|
| 1 | 205806 | 104612 | 1 → 1 | 51330 | 0.723 / 0.102 | 1.970 / 0.817 |
| 5 | 1028478 | 522508 | 5 → 1 | 52214 | 2.439 / 0.068 | 14.956 / 0.377 |
| 10 | 2056822 | 1044885 | 10 → 1 | 53320 | 3.567 / 0.070 | 9.230 / 0.376 |

A separate assertion confirms twenty same-body state transitions create one artifact. Transcript bodies still consume disk. Signed/reasoning/responseId-bearing messages are deliberately retained, so production context can still grow linearly; no universal token-saving claim is made.

## Directed blocker fixes (2026-09-06)

Added regressions before implementation; the three reported sequences failed on the previous candidate (`/tmp/pi-plan-directed-red.log`). After the fixes, all 37 tests pass (`/tmp/pi-plan-directed-green.log`), including an additional actual-disk reopen with a fresh full tool set. Source/tests typechecking, CLI/RPC smoke, benchmark and diff check were rerun successfully. The package dry-run above is from the earlier candidate, not rerun in this directed pass.

- **Tool drift:** immediately append narrowed `beforeTools` and `toolConflict`; restore the conflict across reload/startup and do not broaden the visible set. An append exception latches the live instance restricted. Reload also compares the inherited visible active set with the expected planning set, preserving narrowing when the previous append failed. Tests cover drift without a later plan save, failed append followed by reload, and reopening a persisted drift from disk with full launch tools.
- **Generation source:** a capture ticket now snapshots active-branch entry IDs at assistant start; an old source already present at that boundary cannot be accepted by a new same-timestamp ticket. Timestamp is no longer the sole generation boundary. The real SDK success fixture still passes.
- **Source restoration:** reparse the referenced text block, match exact start/end and artifact digest. Invalid block, both invalid offsets, and an independently refingerprinted but altered body are rejected.

The unchanged parent reproductions were rerun: drift keeps `[read, plan_read]` after reload; stale A leaves `planning`; all three source mutations throw. The readable fix-only diff is `/tmp/pi-plan-directed-fixes.diff`.

Limit: if a drift write fails and the entire process crashes, a later process with an independently broader launch policy has neither the lost observation nor its active set. No persistence/permission guarantee is claimed for that unobservable change; no journal or private API was added. Existing fresh-session limitations remain unchanged.

## Follow-up: failed recovery must not write across branches

A new regression first reproduced the reviewer's A→corrupt B sequence: the previous implementation appended two old-A records into B (expected 8 entries, actual 10). Red evidence: `/tmp/pi-plan-branch-red.log` (37 pass, 1 expected failure).

`apply()` now has a non-writing failure path: it only narrows currently active tools, bounded by the last applied set, and updates status. It does not persist or restore tools from the potentially stale previous-branch state. `save()` also rejects a latched failure, preventing later input-driven transitions from saving that old state. Normal successful recovery still validates the target before assigning and persisting its state.

The new regression checks zero appends on failed recovery, repeated failed `before_agent_start`/`session_tree` calls, rejection of a later input save, and a fresh extension reload still rejecting B's missing artifact. It deliberately uses an editor-created source-less A plan, matching the parent's reproduction. This is a harness regression, not a claim that a real host naturally emitted that sequence.

Final validation: **38/38 tests**, typecheck, real CLI/RPC smoke, benchmark and diff check all pass. Green log: `/tmp/pi-plan-branch-green.log`; benchmark: `/tmp/pi-plan-branch-benchmark.log`. All four unchanged parent `/tmp/pi-plan-{drift,stale,source,branch}-repro.ts` scripts were rerun: the first three remain fixed; branch reproduction appends **zero** entries and both target/reload reject the corrupt reference. Fix-only diff: `/tmp/pi-plan-branch-fixes.diff`.

This does not add an automatic repair path for corrupt sessions or remove the existing failure latch. Fresh-session and durability boundaries remain unchanged; independent re-review is still required.

## Unmet / deferred acceptance

1. **Fresh execution is not implemented as an executing path**: the command reports unavailable and creates no session. Pi's public API cannot prove setup-only pending persistence before the first assistant response. This is the supervisor-approved safe fallback, not full completion of the original fresh feature.
2. **Empty-session pre-first-assistant crash recovery is unavailable**. Status explicitly reports memory-only/unverified state; no verified pending means no dispatch.
3. Full crash-window enumeration, real online Provider compatibility, manual interactive end-to-end approval, and an independent implementation review remain outside this local evidence.
4. No commit, push, package publish/install, user-setting changes or changes to running target sessions were performed. Parent review owns final acceptance and release scope.
