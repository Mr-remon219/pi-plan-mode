import test from 'node:test';
import assert from 'node:assert/strict';
import { KeybindingsManager, TUI_KEYBINDINGS, visibleWidth, CURSOR_MARKER } from '@earendil-works/pi-tui';
import { ReviewView, PlanEditor, reviewUI } from '../src/ui.ts';

const theme: any = { fg: (_color: string, text: string) => text };
const kb: any = new KeybindingsManager(TUI_KEYBINDINGS);
const tui: any = { terminal: { rows: 20, columns: 80 }, requestRender() {} };

test('Unicode/full source viewport, narrow resize, scrolling reaches tail', () => {
  const body = Array.from({ length: 100 }, (_, i) => `${i}: 中文👩‍💻 https://example.test/${'long'.repeat(30)}`).join('\n') + '\nFINAL_TAIL';
  const view = new ReviewView(body, 1, tui, theme, kb, () => {});
  for (const width of [1, 3, 4, 20, 40, 80, 120]) {
    for (const line of view.render(width)) assert.ok(visibleWidth(line) <= width, `${width}: ${line}`);
    view.invalidate();
  }
  for (let i = 0; i < 1000; i++) { view.handleInput('\x1b[6~'); view.render(40); }
  assert.ok(view.render(40).some(line => line.includes('FINAL_TAIL')));
  tui.terminal.rows = 8;
  assert.ok(view.render(20).every(line => visibleWidth(line) <= 20));
  tui.terminal.rows = 20;
});

test('safe default action and configured keys; cancel is never approval', () => {
  let result: any = undefined;
  const keys: any = new KeybindingsManager(TUI_KEYBINDINGS, { 'tui.select.cancel': 'ctrl+x', 'tui.input.tab': 'ctrl+y' });
  const view = new ReviewView('正文', 1, tui, theme, keys, value => { result = value; });
  view.render(40); view.handleInput('\x19'); view.handleInput('\r');
  assert.equal(result, 'continue');
  view.handleInput('\x18'); assert.equal(result, null);
});

test('modal cancellation closes once, even if abort follows explicit cancel', async () => {
  const controller = new AbortController();
  let closes = 0;
  const ctx: any = { ui: { custom: (factory: any) => new Promise(resolve => {
    const view = factory(tui, theme, kb, (value: any) => { closes++; resolve(value); });
    view.handleInput('\x1b'); controller.abort();
  }) } };
  assert.equal(await reviewUI(ctx, '正文', 1, controller.signal), null);
  assert.equal(closes, 1);
});

test('native PlanEditor Enter saves prefilled plan text', () => {
  let result: string | null | undefined;
  const body = '# 完整计划\n\n- 保留中文正文 🧪\n- 验证保存';
  const view = new PlanEditor('编辑完整计划', body, tui, theme, kb, value => { result = value; });
  view.handleInput('\r');
  assert.equal(result, body);
  assert.equal(view.editor.getExpandedText(), '', 'native Editor clears its buffer before onSubmit');
});

test('native PlanEditor Enter saves expanded multiline Chinese feedback paste', () => {
  let result: string | null | undefined;
  const body = Array.from({ length: 20 }, (_, i) => `${i + 1}. 修改意见：保留完整正文与中文 🧪`).join('\n');
  const view = new PlanEditor('修改意见', '', tui, theme, kb, value => { result = value; });
  view.handleInput(`\x1b[200~${body}\x1b[201~`);
  assert.notEqual(view.editor.getText(), body, 'exercise native collapsed-paste expansion');
  assert.equal(view.editor.getExpandedText(), body);
  view.handleInput('\r');
  assert.equal(result, body);
  assert.equal(view.editor.getExpandedText(), '', 'native Editor clears paste cache on submit');
});

test('native Editor preserves Chinese paste and propagates IME focus; escape discards', () => {
  let result: any = undefined;
  const view = new PlanEditor('正文', '# 计划', tui, theme, kb, value => { result = value; });
  view.focused = true; assert.equal(view.editor.focused, true);
  view.handleInput('\x1b[200~中文修改\n第二行 🧪\x1b[201~');
  assert.ok(view.editor.getExpandedText().includes('中文修改'));
  assert.ok(view.render(40).join('\n').includes(CURSOR_MARKER));
  for (const width of [1, 3, 4, 20, 80]) assert.ok(view.render(width).every(line => visibleWidth(line) <= width));
  view.handleInput('\x1b'); assert.equal(result, null);
  view.focused = false; assert.equal(view.editor.focused, false);
});
