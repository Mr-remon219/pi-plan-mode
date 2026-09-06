import { Editor, SelectList, Text, truncateToWidth, type Component, type Focusable, type TUI } from "@earendil-works/pi-tui";
import type { ExtensionContext, KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";

export type ReviewAction = "continue" | "feedback" | "edit" | "exit" | "execute";
const items = [
  { value: "continue", label: "继续规划" },
  { value: "feedback", label: "提出修改意见" },
  { value: "edit", label: "直接编辑正文" },
  { value: "exit", label: "退出规划，不执行" },
  { value: "execute", label: "批准当前计划并执行…" },
];
const listTheme = (theme: Theme) => ({
  selectedPrefix: (s: string) => theme.fg("accent", s), selectedText: (s: string) => theme.fg("accent", s),
  description: (s: string) => theme.fg("muted", s), scrollInfo: (s: string) => theme.fg("dim", s), noMatch: (s: string) => s,
});

/** Source Markdown is deliberately shown verbatim: code, tables and long URLs remain reachable. */
export class ReviewView implements Component {
  private text: Text;
  private menu: SelectList;
  private offset = 0;
  private maxOffset = 0;
  private page = 1;
  private selected = 0;
  private actionsFocused = false;
  constructor(private markdown: string, private revision: number, private tui: TUI, private theme: Theme,
    private kb: KeybindingsManager, private done: (action: ReviewAction | null) => void) {
    this.text = new Text(markdown.replaceAll("\t", "    "), 0, 0);
    this.menu = new SelectList(items, 1, listTheme(theme));
  }
  invalidate(): void { this.text.invalidate(); this.menu.invalidate(); }
  render(width: number): string[] {
    if (width < 4 || this.tui.terminal.rows < 6) return [truncateToWidth("窗口过小；取消可返回", width, "")];
    const lines = this.text.render(width);
    this.page = Math.max(1, Math.min(24, this.tui.terminal.rows - 7));
    this.maxOffset = Math.max(0, lines.length - this.page);
    this.offset = Math.min(this.maxOffset, this.offset);
    const hint = `${this.kb.getKeys("tui.input.tab").join("/")} 切换正文/动作；${this.kb.getKeys("tui.select.cancel").join("/")} 取消`;
    return [
      this.theme.fg("accent", `计划 v${this.revision} · 未批准 · Markdown 全文 ${this.offset + 1}/${lines.length}`),
      ...lines.slice(this.offset, this.offset + this.page),
      this.actionsFocused ? "── 动作（上下选择，确认） ──" : "── 正文（上下/翻页滚动） ──",
      ...this.menu.render(width), hint,
    ].map(line => truncateToWidth(line, width, ""));
  }
  handleInput(data: string): void {
    if (this.kb.matches(data, "tui.select.cancel")) { this.done(null); return; }
    if (this.kb.matches(data, "tui.input.tab")) this.actionsFocused = !this.actionsFocused;
    else if (this.kb.matches(data, "tui.select.confirm")) {
      if (this.actionsFocused) this.done(items[this.selected].value as ReviewAction);
      else this.actionsFocused = true;
    } else {
      let delta = 0;
      if (this.kb.matches(data, "tui.select.up")) delta = -1;
      if (this.kb.matches(data, "tui.select.down")) delta = 1;
      if (this.kb.matches(data, "tui.select.pageUp")) delta = -this.page;
      if (this.kb.matches(data, "tui.select.pageDown")) delta = this.page;
      if (this.actionsFocused) {
        this.selected = Math.max(0, Math.min(items.length - 1, this.selected + Math.sign(delta)));
        this.menu.setSelectedIndex(this.selected);
      } else this.offset = Math.max(0, Math.min(this.maxOffset, this.offset + delta));
    }
    this.tui.requestRender();
  }
}

export class PlanEditor implements Component, Focusable {
  readonly editor: Editor;
  get focused(): boolean { return this.editor.focused; }
  set focused(value: boolean) { this.editor.focused = value; }
  constructor(private title: string, text: string, private tui: TUI, theme: Theme,
    private kb: KeybindingsManager, private done: (text: string | null) => void) {
    this.editor = new Editor(tui, { borderColor: s => theme.fg("accent", s), selectList: listTheme(theme) });
    this.editor.setText(text);
    this.editor.onSubmit = (text) => done(text);
  }
  render(width: number): string[] {
    if (width < 4) return [truncateToWidth("扩大窗口或取消", width, "")];
    return [truncateToWidth(`${this.title} · Enter 保存；Shift+Enter 换行；Esc 取消`, width, ""), ...this.editor.render(width)]
      .map(line => truncateToWidth(line, width, ""));
  }
  handleInput(data: string): void {
    if (this.kb.matches(data, "tui.select.cancel")) this.done(null);
    else this.editor.handleInput(data);
    this.tui.requestRender();
  }
  invalidate(): void { this.editor.invalidate(); }
}

/** custom() has no AbortSignal option; close through the documented done callback. */
export async function reviewUI(ctx: ExtensionContext, markdown: string, revision: number, signal: AbortSignal): Promise<ReviewAction | null> {
  return ctx.ui.custom<ReviewAction | null>((tui, theme, kb, done) => {
    let finished = false;
    const finish = (value: ReviewAction | null) => {
      if (finished) return;
      finished = true;
      signal.removeEventListener("abort", cancel);
      done(value);
    };
    const cancel = () => finish(null);
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) queueMicrotask(cancel);
    const view = new ReviewView(markdown, revision, tui, theme, kb, finish);
    return Object.assign(view, { dispose: () => signal.removeEventListener("abort", cancel) });
  });
}
export async function editUI(ctx: ExtensionContext, title: string, text: string, signal: AbortSignal): Promise<string | null> {
  return ctx.ui.custom<string | null>((tui, theme, kb, done) => {
    let finished = false;
    const finish = (value: string | null) => {
      if (finished) return;
      finished = true;
      signal.removeEventListener("abort", cancel);
      done(value);
    };
    const cancel = () => finish(null);
    signal.addEventListener("abort", cancel, { once: true });
    if (signal.aborted) queueMicrotask(cancel);
    const view = new PlanEditor(title, text, tui, theme, kb, finish);
    return Object.assign(view, { dispose: () => signal.removeEventListener("abort", cancel) });
  });
}
