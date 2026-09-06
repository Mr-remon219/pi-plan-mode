import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { ENTRY, HANDOFF, LOCAL_FILE_MUTATION_TOOLS, OWN_TOOLS, initialState, restore, persist, diskMatches, fingerprint, restoredTools, validateMarkdown, handoff, type PlanState } from "./state.ts";
import { parsePlan, digest } from './plan.ts';
import { prunePlans } from './context.ts';
import { editUI, reviewUI } from "./ui.ts";

export default function planMode(pi: ExtensionAPI): void {
  let state = initialState();
  let baseline: string[] = [];
  let failed = false;
  let epoch = 0;
  let dialog: AbortController | undefined;
  let scheduled: ReturnType<typeof setImmediate> | undefined;
  let autoReviewRevision: number | undefined;
  let lastApplied: string[] | undefined;
  let conflict = false;
  let capture: { epoch: number; revision: number; timestamp: number; priorEntries: Set<string> } | undefined;
  let authorized: { id: string; text: string; input: boolean; prepared: boolean } | undefined;
  const disk = (ctx: ExtensionContext) => diskMatches(ctx.sessionManager.getSessionFile(), ctx.sessionManager.getLeafId(), state);
  const available = () => pi.getAllTools().map(t => t.name);
  const normalTools = () => restoredTools(state.beforeTools, available());
  const planningTools = () => [...new Set([
    ...normalTools().filter(name => !LOCAL_FILE_MUTATION_TOOLS.has(name)),
    "plan_read",
  ])].filter(name => available().includes(name));
  const restricted = () => failed || conflict || state.phase !== "off";
  const idle = (ctx: ExtensionContext) => ctx.isIdle() && !ctx.hasPendingMessages();
  function invalidate(): void {
    epoch++;
    capture = undefined;
    dialog?.abort();
    if (scheduled) clearImmediate(scheduled);
    scheduled = undefined;
  }
  function status(ctx: ExtensionContext): void {
    ctx.ui.setStatus(ENTRY, failed ? "规划存储异常 · 禁止工具实施" : conflict ? '工具集合冲突 · 保持受限' : state.phase === "off" ? undefined :
      `${state.phase === 'handoff_pending' ? '批准交接待确认' : state.phase === "ready" ? "规划待审阅" : "规划中"} v${state.revision} · /plan · ${disk(ctx) ? '磁盘已核验' : '仅内存/磁盘未核验'}`);
  }
  function apply(ctx: ExtensionContext): void {
    const current = pi.getActiveTools();
    if (failed) {
      // State may still belong to the previous branch. Never persist or restore
      // permissions from it while the target branch has not been validated.
      const next = current.filter(n => !LOCAL_FILE_MUTATION_TOOLS.has(n) && (!lastApplied || lastApplied.includes(n)));
      pi.setActiveTools(next);
      lastApplied = [...next];
      status(ctx);
      return;
    }
    if (lastApplied && (current.length !== lastApplied.length || current.some(n => !lastApplied!.includes(n)))) {
      conflict = true;
      state = { ...state, beforeTools: state.beforeTools.filter(n => current.includes(n)), toolConflict: true };
      // Persist drift immediately, not only on the next plan/state transition.
      try { state = persist(ctx.sessionManager.getBranch(), state, (type, data) => pi.appendEntry(type, data)); }
      catch (error) { failed = true; authorized = undefined; ctx.ui.notify(`工具收窄存储失败，保持受限：${error}`, 'error'); }
      ctx.ui.notify(`工具集合发生外部变化；不恢复旧快照。当前：${current.join(', ')}。请退出后重新进入规划以重新建立基线。`, 'warning');
    }
    const next = conflict ? planningTools().filter(n => current.includes(n)) : restricted() ? planningTools() : normalTools();
    pi.setActiveTools(next);
    lastApplied = [...next];
    status(ctx);
  }
  function save(next: PlanState, ctx: ExtensionContext): void {
    if (failed) throw new Error('规划存储异常，不能写入未经验证的分支状态');
    invalidate();
    if (lastApplied && (pi.getActiveTools().length !== lastApplied.length || pi.getActiveTools().some(n => !lastApplied!.includes(n)))) {
      apply(ctx);
      next = { ...next, beforeTools: next.beforeTools.filter(n => state.beforeTools.includes(n)), toolConflict: true };
      if (failed) throw new Error('工具收窄存储失败，不能继续状态转换');
    }
    try { state = persist(ctx.sessionManager.getBranch(), next, (type, data) => pi.appendEntry(type, data)); }
    catch (error) { failed = true; authorized = undefined; apply(ctx); throw error; }
    apply(ctx);
  }
  function enter(ctx: ExtensionContext): void {
    if (failed) throw new Error("规划存储异常，请先检查会话记录并重新加载");
    if (state.phase === "off") {
      conflict = false;
      lastApplied = undefined;
      baseline = pi.getActiveTools().filter(n => !OWN_TOOLS.includes(n));
      save({ ...initialState(), phase: "planning", beforeTools: [...baseline] }, ctx);
    }
  }
  function continuePlanning(ctx: ExtensionContext, feedback?: string): void {
    enter(ctx);
    authorized = undefined;
    save({ ...state, phase: "planning", pending: undefined }, ctx);
    if (feedback) pi.sendUserMessage(`继续规划，不实施。请先读取现有计划，再按以下要求修订并提交完整新版本：\n\n${feedback}`, { expandPromptTemplates: false });
  }
  function exit(ctx: ExtensionContext): void {
    if (failed) throw new Error("规划存储异常，不能解除限制；请检查会话记录");
    authorized = undefined;
    if (state.phase !== "off") save({ ...state, phase: "off", pending: undefined }, ctx);
  }
  function newInput(ctx: ExtensionContext): void {
    invalidate();
    autoReviewRevision = undefined;
    if (state.phase === "ready") save({ ...state, phase: "planning" }, ctx);
  }
  async function review(ctx: ExtensionContext): Promise<void> {
    if (ctx.mode !== "tui" || !ctx.hasUI) {
      ctx.ui.notify("仅原生 TUI 支持审阅批准；当前不执行。全文保存在规划 CustomEntry / plan_read 中。", "info");
      return;
    }
    if (!idle(ctx) || dialog || failed) return;
    apply(ctx);
    if (state.phase === 'handoff_pending') {
      const snapshot = state; const ticket = epoch; const controller = new AbortController();
      dialog = controller;
      let action: string | undefined;
      try {
        action = await ctx.ui.select('交接未确认；不会自动执行', ['保持受限', '重新审阅并批准', '取消交接，返回待审阅'], { signal: controller.signal });
        if (controller.signal.aborted) return;
      } finally { if (dialog === controller) dialog = undefined; controller.abort(); }
      if (!idle(ctx) || failed || state !== snapshot || epoch !== ticket || state.phase !== 'handoff_pending') return;
      if (action === '重新审阅并批准' || action === '取消交接，返回待审阅') {
        authorized = undefined;
        save({ ...state, phase: 'ready', pending: undefined }, ctx);
        if (action === '重新审阅并批准') await review(ctx);
      }
      return;
    }
    const snapshot = state;
    const ticket = epoch;
    const controller = new AbortController();
    dialog = controller;
    const valid = () => !controller.signal.aborted && ticket === epoch && snapshot === state && idle(ctx) && !failed;
    try {
      const action = await reviewUI(ctx, snapshot.markdown || "尚未提交计划。可继续规划、提出要求或退出。", snapshot.revision, controller.signal);
      if (!valid() || !action) return;
      if (action === "exit") exit(ctx);
      else if (action === "continue") continuePlanning(ctx);
      else if (action === "feedback" || action === "edit") {
        const text = await editUI(ctx, action === "edit" ? "编辑完整计划" : "修改意见", action === "edit" ? snapshot.markdown : "", controller.signal);
        if (!valid() || text === null) return;
        if (action === "feedback") { if (text.trim()) continuePlanning(ctx, text); }
        else {
          validateMarkdown(text);
          save({ ...state, phase: "ready", markdown: text, source: undefined, revision: state.revision + 1 }, ctx);
          ctx.ui.notify("已保存新版本，尚未批准；/plan 重新审阅。", "info");
        }
      } else if (action === "execute") {
        if (snapshot.phase !== "ready" || !snapshot.markdown) { ctx.ui.notify("请先提交完整计划。", "warning"); return; }
        const approval = await ctx.ui.select(`批准计划 v${snapshot.revision} 并开始实施？恢复工具：${normalTools().join(", ") || "无"}`,
          ["取消，保持规划", "明确批准并执行"], { signal: controller.signal });
        if (approval !== "明确批准并执行" || !valid()) return;
        if (conflict) { ctx.ui.notify('工具配置冲突，保持受限；请重新建立规划基线。', 'warning'); return; }
        const id = randomUUID();
        save({ ...state, phase: 'handoff_pending', pending: { id, artifactId: digest(state.markdown), revision: state.revision, target: 'same' } }, ctx);
        if (conflict) { ctx.ui.notify('审批期间工具集合变化，保持 pending，不派发。', 'warning'); return; }
        if (!disk(ctx)) { ctx.ui.notify('交接仅在内存中；未核验磁盘记录，保持 pending，不派发。', 'warning'); return; }
        const message = `[plan-handoff:${id}]\n${handoff(state)}`;
        authorized = { id, text: message, input: false, prepared: false };
        try { pi.sendUserMessage(message, { expandPromptTemplates: false }); }
        catch (error) { authorized = undefined; apply(ctx); ctx.ui.notify(`交接派发失败：${error}`, 'error'); }
      }
    } finally { if (dialog === controller) dialog = undefined; controller.abort(); }
  }

  pi.registerTool({
    name: "plan_read", label: "读取完整计划", description: "读取当前分支的完整 Markdown 计划与版本（最大 64 KiB）。",
    parameters: Type.Object({}),
    async execute(_id, _params, signal) {
      signal?.throwIfAborted();
      return { content: [{ type: "text", text: state.markdown || "尚无计划" }], details: { phase: state.phase, revision: state.revision } };
    },
  });
  pi.on("tool_call", event => {
    if (event.toolName === "plan_submit")
      return { block: true, reason: "plan_submit 已弃用；请直接输出完整的 <proposed_plan> Markdown 块", terminate: true };
    if (restricted() && LOCAL_FILE_MUTATION_TOOLS.has(event.toolName))
      return { block: true, reason: "Plan Mode 禁止直接修改本地文件；请继续自由探索并完善计划", terminate: true };
  });
  pi.on("before_agent_start", (event, ctx) => {
    if (restricted()) apply(ctx);
    if (authorized?.input && event.prompt === authorized.text && state.phase === 'handoff_pending' && state.pending?.id === authorized.id && !failed && !conflict && disk(ctx)) {
      pi.setActiveTools(normalTools());
      lastApplied = pi.getActiveTools();
      authorized.prepared = true;
      return;
    }
    if (restricted()) return { systemPrompt: `${event.systemPrompt}\n\n你处于宿主管理的独立规划模式。除修改本地文件和直接实施计划外，你拥有进入模式前的全部探索能力：可以运行非修改性的 shell 命令、搜索网页、调用研究工具、分析代码、运行只读检查，并可委派只读探索。不得使用 edit/write/apply_patch，不得通过 shell、子代理或其他工具修改本地项目文件；对子代理必须明确要求只读。先探索可查事实，必要时用普通对话提问澄清。形成决策完整方案后，在最终回答中直接输出一个且仅一个完整计划块：开始标签 \`<proposed_plan>\` 与结束标签 \`</proposed_plan>\` 必须各自独占一行，标签之间是包含目标/范围、事实、架构决策、文件/接口变化、步骤、测试验收与风险的完整 Markdown。不要把计划放进工具参数，不要调用 plan_submit；宿主会从成功结束的普通文本流中保存计划。普通用户消息和你自己的判断都不能解除此模式。当前 phase=${state.phase}，baseRevision=${state.revision}。压缩或修订后先用 plan_read 获取原文。` };
  });
  pi.on("context", (event, ctx) => {
    const branch = ctx.sessionManager.getBranch();
    const handedOff = branch.some(e => e.type === 'custom' && e.customType === HANDOFF && (e.data as { artifactId?: string }).artifactId === state.artifactId && event.messages.some(m => m.role === 'user' && fingerprint(m) === (e.data as { messageFingerprint?: string }).messageFingerprint));
    const pruned = prunePlans(event.messages, branch, handedOff ? undefined : state.source?.entryId);
    if (pruned.skipped) ctx.ui.notify(`保留 ${pruned.skipped} 条签名或身份不明确的计划消息，未压缩。`, 'info');
    return { messages: [...pruned.messages.filter(m => !(m.role === "custom" && m.customType === ENTRY)), {
    role: "custom" as const, customType: ENTRY, content: `当前宿主规划状态：${state.phase}；计划版本 ${state.revision}。${restricted() ? "未批准实施；原文使用 plan_read 获取。" : "规划限制已解除，历史规划提示不再是当前模式。"}`,
    display: false, timestamp: Date.now(),
  }] };
  });
  pi.on("input", (event, ctx) => {
    if (authorized && event.source === 'extension' && event.text === authorized.text && state.pending?.id === authorized.id) { authorized.input = true; return; }
    authorized = undefined;
    newInput(ctx);
  });
  pi.on("message_start", (event, ctx) => {
    if (event.message.role === 'user') {
      const content = event.message.content;
      const text = typeof content === 'string' ? content : content.filter(b => b.type === 'text').map(b => b.text).join('');
      if (authorized?.prepared && text === authorized.text && state.pending?.id === authorized.id && !failed) {
        try {
          pi.appendEntry(HANDOFF, { ...state.pending, result: 'accepted', messageFingerprint: fingerprint(event.message) });
          save({ ...state, phase: 'off', pending: undefined }, ctx);
          if (!disk(ctx)) { failed = true; apply(ctx); throw new Error('交接状态磁盘核验失败，保持受限'); }
        } catch (error) { failed = true; apply(ctx); ctx.abort(); ctx.ui.notify(String(error), 'error'); }
        authorized = undefined;
      } else newInput(ctx);
    } else if (event.message.role === 'assistant' && state.phase === 'planning') {
      capture = { epoch, revision: state.revision, timestamp: event.message.timestamp, priorEntries: new Set(ctx.sessionManager.getBranch().map(e => e.id)) };
    }
  });
  pi.on("agent_start", () => { invalidate(); });
  pi.on("turn_end", (event, ctx) => {
    if (failed || state.phase !== "planning" || event.message.role !== "assistant" || event.message.stopReason !== "stop" || event.message.content.some(b => b.type === 'toolCall')) return;
    const ticket = capture; capture = undefined;
    if (!ticket || ticket.epoch !== epoch || ticket.revision !== state.revision || ticket.timestamp !== event.message.timestamp) return;
    try {
      const plans = event.message.content.flatMap((block, index) => {
        if (block.type !== 'text') return [];
        const plan = parsePlan(block.text);
        return plan ? [{ ...plan, block: index }] : [];
      });
      if (!plans.length) return;
      if (plans.length !== 1) throw new Error('一次只能输出一个计划块');
      const messageFingerprint = fingerprint(event.message);
      const entries = ctx.sessionManager.getBranch().filter(e => e.type === 'message' && e.message.role === 'assistant' && e.message.timestamp === event.message.timestamp && fingerprint(e.message) === messageFingerprint);
      if (entries.length !== 1 || ticket.priorEntries.has(entries[0].id)) throw new Error('计划来源不属于当前生成或身份不唯一，未捕获');
      const plan = plans[0];
      const source = { entryId: entries[0].id, fingerprint: messageFingerprint, block: plan.block, start: plan.start, end: plan.end, artifactId: digest(plan.markdown), revision: state.revision + 1 };
      save({ ...state, markdown: plan.markdown, source, revision: state.revision + 1, phase: "ready" }, ctx);
      autoReviewRevision = state.revision;
      ctx.ui.notify(`完整计划 v${state.revision} 已从文本流保存，等待人工审阅，未执行。`, "info");
    } catch (error) {
      ctx.ui.notify(String(error), "warning");
    }
  });
  pi.on("agent_settled", (_event, ctx) => {
    if (authorized) { authorized = undefined; apply(ctx); }
    if (autoReviewRevision !== state.revision || state.phase !== "ready" || ctx.mode !== "tui" || !idle(ctx) || dialog || scheduled) return;
    const ticket = epoch;
    scheduled = setImmediate(() => {
      scheduled = undefined;
      if (ticket !== epoch || !idle(ctx)) return;
      autoReviewRevision = undefined;
      void review(ctx).catch(error => ctx.ui.notify(String(error), "error"));
    });
  });
  function recover(ctx: ExtensionContext, reason: string): void {
    invalidate();
    autoReviewRevision = undefined;
    authorized = undefined;
    if (failed) { apply(ctx); return; }
    try {
      const next = restore(ctx.sessionManager.getBranch());
      const file = ctx.sessionManager.getSessionFile();
      if (file && existsSync(file) && !diskMatches(file, ctx.sessionManager.getLeafId(), next)) throw new Error('内存分支与磁盘记录不一致，保持受限');
      // reload receives the restricted active set, NOT the process launch baseline.
      next.beforeTools = restoredTools(next.beforeTools, available(), reason === "reload" ? undefined : baseline);
      if (next.phase === "off" && !next.toolConflict) next.beforeTools = [...baseline];
      state = next;
      conflict = state.toolConflict === true;
      failed = false;
      // Reload preserves visible narrowing even if its previous append failed.
      // Hidden policy changes are not observable through active-tool names.
      if (reason === 'reload' && state.phase !== 'off') lastApplied = planningTools();
      apply(ctx);
      // Persist a stricter fresh-process baseline so subsequent reload cannot widen it.
      if (reason !== "reload" && state.phase !== "off") save(state, ctx);
    } catch (error) { failed = true; apply(ctx); ctx.ui.notify(String(error), "error"); }
  }
  pi.on("session_start", (event, ctx) => {
    baseline = pi.getActiveTools().filter(n => !OWN_TOOLS.includes(n));
    if (event.reason === "reload") {
      try { const old = restore(ctx.sessionManager.getBranch()); if (old.phase !== "off") baseline = restoredTools(old.beforeTools, available()); }
      catch { /* recover reports and keeps the gate closed */ }
    }
    recover(ctx, event.reason);
  });
  pi.on("session_tree", (_event, ctx) => { recover(ctx, "tree"); });
  pi.on("session_before_tree", () => { invalidate(); });
  pi.on("session_before_switch", () => { invalidate(); });
  pi.on("session_before_fork", () => { invalidate(); });
  pi.on("session_before_compact", () => { invalidate(); });
  pi.on("session_shutdown", (_event, ctx) => { invalidate(); ctx.ui.setStatus(ENTRY, undefined); });
  pi.registerCommand("plan", {
    description: "自由探索规划；/plan [任务] | --review | --retry | --cancel-handoff | --execute-fresh | --continue [意见] | --exit | --status",
    async handler(args, ctx) {
      try {
        const text = args.trim();
        if (text === "--status") { ctx.ui.notify(`${failed ? "存储异常" : state.phase} · v${state.revision} · ${Buffer.byteLength(state.markdown)} 字节 · ${disk(ctx) ? '磁盘已核验（非 fsync 保证）' : '仅内存/磁盘未核验'}`, "info"); return; }
        if (text === '--execute-fresh') { ctx.ui.notify('当前 Pi 新会话在首条 assistant 前不持久化；无法安全持久化批准记录，新会话执行不可用。请使用已落盘会话的 /plan --review。', 'warning'); return; }
        if (text === '--retry' && state.phase === 'handoff_pending' && idle(ctx)) { save({ ...state, phase: 'ready', pending: undefined }, ctx); await review(ctx); return; }
        if (text === '--cancel-handoff' && state.phase === 'handoff_pending' && idle(ctx)) { authorized = undefined; save({ ...state, phase: 'ready', pending: undefined }, ctx); return; }
        if (!idle(ctx)) { ctx.ui.notify("请等待当前运行和排队消息结束，再操作规划模式。", "warning"); return; }
        if (text === "--exit") { exit(ctx); return; }
        if (text === "--review") { if (state.phase !== "off") await review(ctx); return; }
        if (text.startsWith("--continue")) { continuePlanning(ctx, text.slice(10).trim()); return; }
        if (text.startsWith("--")) { ctx.ui.notify("支持 --review / --retry / --cancel-handoff / --execute-fresh（当前 API 不可用）/ --continue [意见] / --exit / --status；执行只能从 TUI 明确批准。", "warning"); return; }
        enter(ctx);
        if (text) continuePlanning(ctx, text);
        else await review(ctx);
      } catch (error) { ctx.ui.notify(String(error), "error"); }
    },
  });
}
