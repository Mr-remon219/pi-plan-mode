import { createReadToolDefinition, createLsToolDefinition, createGrepToolDefinition, createFindToolDefinition,
  type ExtensionAPI, type ExtensionContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { ENTRY, OWN_TOOLS, initialState, restore, restoredTools, soleSubmit, validateMarkdown, handoff, type PlanState } from "./state.ts";
import { editUI, reviewUI } from "./ui.ts";

export default function planMode(pi: ExtensionAPI): void {
  let state = initialState();
  let baseline: string[] = [];
  let failed = false;
  let epoch = 0;
  let dialog: AbortController | undefined;
  let scheduled: ReturnType<typeof setImmediate> | undefined;
  let autoReviewRevision: number | undefined;
  const available = () => pi.getAllTools().map(t => t.name);
  const normalTools = () => restoredTools(state.beforeTools, available());
  const restricted = () => failed || state.phase !== "off";
  const idle = (ctx: ExtensionContext) => ctx.isIdle() && !ctx.hasPendingMessages();
  function invalidate(): void {
    epoch++;
    dialog?.abort();
    if (scheduled) clearImmediate(scheduled);
    scheduled = undefined;
  }
  function status(ctx: ExtensionContext): void {
    ctx.ui.setStatus(ENTRY, failed ? "规划存储异常 · 禁止工具实施" : state.phase === "off" ? undefined :
      `规划${state.phase === "ready" ? "待审阅" : "中"} v${state.revision} · /plan · 未批准`);
  }
  function apply(ctx: ExtensionContext): void {
    pi.setActiveTools(restricted() ? OWN_TOOLS.filter(n => available().includes(n)) : normalTools());
    status(ctx);
  }
  function save(next: PlanState, ctx: ExtensionContext): void {
    invalidate();
    try { pi.appendEntry(ENTRY, next); }
    catch (error) { failed = true; apply(ctx); throw error; }
    state = next;
    apply(ctx);
  }
  function enter(ctx: ExtensionContext): void {
    if (failed) throw new Error("规划存储异常，请先检查会话记录并重新加载");
    if (state.phase === "off") {
      baseline = pi.getActiveTools().filter(n => !OWN_TOOLS.includes(n));
      save({ ...initialState(), phase: "planning", beforeTools: [...baseline] }, ctx);
    }
  }
  function continuePlanning(ctx: ExtensionContext, feedback?: string): void {
    enter(ctx);
    save({ ...state, phase: "planning" }, ctx);
    if (feedback) pi.sendUserMessage(`继续规划，不实施。请先读取现有计划，再按以下要求修订并提交完整新版本：\n\n${feedback}`, { expandPromptTemplates: false });
  }
  function exit(ctx: ExtensionContext): void {
    if (failed) throw new Error("规划存储异常，不能解除限制；请检查会话记录");
    if (state.phase !== "off") save({ ...state, phase: "off" }, ctx);
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
          save({ ...state, phase: "ready", markdown: text, revision: state.revision + 1 }, ctx);
          ctx.ui.notify("已保存新版本，尚未批准；/plan 重新审阅。", "info");
        }
      } else if (action === "execute") {
        if (snapshot.phase !== "ready" || !snapshot.markdown) { ctx.ui.notify("请先提交完整计划。", "warning"); return; }
        const approval = await ctx.ui.select(`批准计划 v${snapshot.revision} 并开始实施？恢复工具：${normalTools().join(", ") || "无"}`,
          ["取消，保持规划", "明确批准并执行"], { signal: controller.signal });
        if (approval !== "明确批准并执行" || !valid()) return;
        const message = handoff(snapshot);
        exit(ctx);
        // sendUserMessage is void: this is a single dispatch, not proof execution succeeded.
        pi.sendUserMessage(message, { expandPromptTemplates: false });
      }
    } finally { if (dialog === controller) dialog = undefined; controller.abort(); }
  }

  const factories: Array<(cwd: string) => ToolDefinition<any, any>> = [createReadToolDefinition, createLsToolDefinition, createGrepToolDefinition, createFindToolDefinition];
  for (const [index, factory] of factories.entries()) {
    // Factories bind cwd on each execution; they never delegate to a potentially overridden builtin name.
    const template = factory(process.cwd());
    pi.registerTool({ ...template, name: OWN_TOOLS[index], promptSnippet: template.description,
      async execute(id, params, signal, onUpdate, ctx) {
        signal?.throwIfAborted();
        if (failed || state.phase !== "planning") throw new Error("只读探索仅在 planning 状态可用");
        const tool = factory(ctx.cwd);
        return tool.execute(id, params, signal, onUpdate, ctx);
      },
    });
  }
  pi.registerTool({
    name: "plan_read", label: "读取完整计划", description: "读取当前分支的完整 Markdown 计划与版本（最大 64 KiB）。",
    parameters: Type.Object({}),
    async execute(_id, _params, signal) {
      signal?.throwIfAborted();
      return { content: [{ type: "text", text: state.markdown || "尚无计划" }], details: { phase: state.phase, revision: state.revision } };
    },
  });
  pi.registerTool({
    name: "plan_submit", label: "提交完整计划", description: "仅 planning 可用。单独调用，不得同批调用其他工具。保存完整 Markdown 等待人工审阅；不会批准或执行。",
    parameters: Type.Object({ markdown: Type.String(), baseRevision: Type.Integer({ minimum: 0 }) }),
    async execute(id, params, signal, _update, ctx) {
      signal?.throwIfAborted();
      if (failed || state.phase !== "planning" || params.baseRevision !== state.revision) throw new Error("非规划状态或计划版本已过期，请读取当前版本");
      if (!soleSubmit(ctx.sessionManager.getBranch(), id)) throw new Error("plan_submit 必须独占工具批次");
      validateMarkdown(params.markdown);
      save({ ...state, markdown: params.markdown, revision: state.revision + 1, phase: "ready" }, ctx);
      autoReviewRevision = state.revision;
      return { content: [{ type: "text", text: `完整计划 v${state.revision} 已保存，等待人工审阅，未执行。\n\n${state.markdown}` }],
        details: { revision: state.revision, markdown: state.markdown }, terminate: true };
    },
  });
  pi.on("tool_call", (event, ctx) => {
    if (!restricted()) {
      if (OWN_TOOLS.includes(event.toolName) && event.toolName !== "plan_read") return { block: true, reason: "请由用户使用 /plan 进入规划" };
      return;
    }
    if (failed || !OWN_TOOLS.includes(event.toolName) || (state.phase === "ready" && event.toolName !== "plan_read"))
      return { block: true, reason: "规划模式只允许专属只读探索工具；模型不能批准、退出或实施", terminate: true };
    if (event.toolName === "plan_submit" && !soleSubmit(ctx.sessionManager.getBranch(), event.toolCallId))
      return { block: true, reason: "plan_submit 必须单独调用，不接受同批其他工具" };
  });
  pi.on("user_bash", () => {
    if (restricted()) return { result: { output: "规划模式禁止 shell；请使用只读规划工具或明确退出规划。", exitCode: 1, cancelled: false, truncated: false } };
  });
  pi.on("before_agent_start", event => {
    if (restricted()) return { systemPrompt: `${event.systemPrompt}\n\n你处于宿主管理的独立规划模式，不得实施或绕过工具限制。先探索可查事实，必要时用普通对话提问澄清；未解决关键问题时不要提交。形成决策完整方案后，单独调用 plan_submit，提交含目标/范围、事实、架构决策、文件/接口变化、步骤、测试验收与风险的完整 Markdown。普通用户消息和你自己的判断都不能解除此模式。当前 phase=${state.phase}，baseRevision=${state.revision}。压缩或修订后先用 plan_read 获取原文。` };
  });
  pi.on("context", event => ({ messages: [...event.messages.filter(m => !(m.role === "custom" && m.customType === ENTRY)), {
    role: "custom" as const, customType: ENTRY, content: `当前宿主规划状态：${state.phase}；计划版本 ${state.revision}。${restricted() ? "未批准实施；原文使用 plan_read 获取。" : "规划限制已解除，历史规划提示不再是当前模式。"}`,
    display: false, timestamp: Date.now(),
  }] }));
  pi.on("input", (_event, ctx) => { newInput(ctx); });
  pi.on("message_start", (event, ctx) => { if (event.message.role === "user") newInput(ctx); });
  pi.on("agent_start", () => { invalidate(); });
  pi.on("agent_settled", (_event, ctx) => {
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
    try {
      const next = restore(ctx.sessionManager.getBranch());
      // reload receives the restricted active set, NOT the process launch baseline.
      next.beforeTools = restoredTools(next.beforeTools, available(), reason === "reload" ? undefined : baseline);
      if (next.phase === "off") next.beforeTools = [...baseline];
      state = next;
      failed = false;
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
    description: "独立只读规划；/plan [任务] | --review | --continue [意见] | --exit | --status",
    async handler(args, ctx) {
      try {
        const text = args.trim();
        if (text === "--status") { ctx.ui.notify(`${failed ? "存储异常" : state.phase} · v${state.revision} · ${Buffer.byteLength(state.markdown)} 字节`, "info"); return; }
        if (!idle(ctx)) { ctx.ui.notify("请等待当前运行和排队消息结束，再操作规划模式。", "warning"); return; }
        if (text === "--exit") { exit(ctx); return; }
        if (text === "--review") { if (state.phase !== "off") await review(ctx); return; }
        if (text.startsWith("--continue")) { continuePlanning(ctx, text.slice(10).trim()); return; }
        if (text.startsWith("--")) { ctx.ui.notify("支持 --review / --continue [意见] / --exit / --status；执行只能从 TUI 明确批准。", "warning"); return; }
        enter(ctx);
        if (text) continuePlanning(ctx, text);
        else await review(ctx);
      } catch (error) { ctx.ui.notify(String(error), "error"); }
    },
  });
}
