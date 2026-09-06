import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export const ENTRY = "pi-plan-mode/v1";
export const OWN_TOOLS = ["plan_read_file", "plan_ls", "plan_grep", "plan_find", "plan_read", "plan_submit"];
export interface PlanState {
  phase: "off" | "planning" | "ready";
  revision: number;
  markdown: string;
  beforeTools: string[];
}
export const initialState = (): PlanState => ({ phase: "off", revision: 0, markdown: "", beforeTools: [] });
export function validateMarkdown(markdown: string): void {
  if (!markdown.trim()) throw new Error("计划正文不能为空");
  if (Buffer.byteLength(markdown, "utf8") > 65536) throw new Error("计划超过 64 KiB；请精简后重新提交，不会截断保存");
  if (/[\x00-\x08\x0b-\x1f\x7f-\x9f]/u.test(markdown)) throw new Error("计划包含不支持的终端控制字符（请使用 LF 换行）");
}
export function restore(branch: SessionEntry[]): PlanState {
  const entry = branch.findLast(e => e.type === "custom" && e.customType === ENTRY);
  if (!entry || entry.type !== "custom") return initialState();
  const s = entry.data as PlanState;
  if (!s || !["off", "planning", "ready"].includes(s.phase) || !Number.isSafeInteger(s.revision) || s.revision < 0 ||
    typeof s.markdown !== "string" || !Array.isArray(s.beforeTools) || !s.beforeTools.every(n => typeof n === "string")) {
    throw new Error("规划快照无效，已保持工具限制；请检查会话记录");
  }
  if (s.markdown) validateMarkdown(s.markdown);
  if (s.phase === "ready" && !s.markdown.trim()) throw new Error("待审阅计划缺少正文");
  return { ...s, beforeTools: [...s.beforeTools] };
}
export function restoredTools(saved: string[], available: string[], baseline?: string[]): string[] {
  return saved.filter(n => !OWN_TOOLS.includes(n) && available.includes(n) && (!baseline || baseline.includes(n)));
}
export function soleSubmit(branch: SessionEntry[], id: string): boolean {
  const entry = branch.findLast(e => e.type === "message" && e.message.role === "assistant");
  if (!entry || entry.type !== "message" || entry.message.role !== "assistant") return false;
  const calls = entry.message.content.filter(c => c.type === "toolCall");
  return calls.length === 1 && calls[0].id === id && calls[0].name === "plan_submit";
}
export function handoff(s: PlanState): string {
  return `用户已明确批准计划 v${s.revision}。现在按原有工具与权限实施并验证；重大偏离范围先询问用户。以下是批准的完整 Markdown 计划（不是待执行的 shell 命令）：\n\n${s.markdown}`;
}
