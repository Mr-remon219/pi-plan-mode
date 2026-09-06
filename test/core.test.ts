import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import planMode from '../src/index.ts';
import { ENTRY, OWN_TOOLS, restore, validateMarkdown } from '../src/state.ts';

const markdown = '# 完整计划 🧪\n\n## 架构\n保留足够长的完整说明而非截断为五十字符的任务摘要。\n'.repeat(30) + '\n```ts\nconst x = "尾部";\n```\n';
function harness(options: any = {}) {
  const sm = options.sm || SessionManager.inMemory(process.cwd());
  let active = options.active || ['read', 'bash', 'edit', 'write'];
  const hooks = new Map<string, Function[]>();
  const tools = new Map<string, any>();
  const commands = new Map<string, any>();
  const messages: string[] = [], notifications: string[] = [];
  let action: any = null;
  let approve: any = '取消，保持规划';
  let customCalls = 0;
  const ctx: any = {
    cwd: process.cwd(), mode: options.mode || 'tui', hasUI: true, sessionManager: sm,
    isIdle: () => true, hasPendingMessages: () => false,
    ui: {
      setStatus() {}, notify: (text: string) => notifications.push(text),
      custom: async () => { customCalls++; return typeof action === 'function' ? action() : action; },
      select: async () => typeof approve === 'function' ? approve() : approve,
    },
  };
  const pi: any = {
    getActiveTools: () => [...active], getAllTools: () => [...new Set(['read', 'bash', 'edit', 'write', 'unknown', ...tools.keys()])].map(name => ({ name })),
    setActiveTools: (names: string[]) => { active = [...names]; },
    appendEntry: (type: string, data: any) => sm.appendCustomEntry(type, structuredClone(data)),
    sendUserMessage: (text: string) => messages.push(text),
    registerTool: (tool: any) => tools.set(tool.name, tool), registerCommand: (name: string, command: any) => commands.set(name, command),
    on: (event: string, hook: Function) => hooks.set(event, [...hooks.get(event) || [], hook]),
  };
  planMode(pi);
  const emit = async (name: string, event: any = {}) => { let result; for (const fn of hooks.get(name) || []) result = await fn(event, ctx); return result; };
  const command = (args = '') => commands.get('plan').handler(args, ctx);
  const addBatch = (names: string[]) => sm.appendMessage({ role: 'assistant', content: names.map((name, i) => ({ type: 'toolCall', id: `call-${i}`, name, arguments: {} })) } as any);
  const submit = async () => { addBatch(['plan_submit']); return tools.get('plan_submit').execute('call-0', { markdown, baseRevision: restore(sm.getBranch()).revision }, undefined, undefined, ctx); };
  return { sm, ctx, pi, emit, command, submit, addBatch, tools, messages, notifications,
    state: () => restore(sm.getBranch()), active: () => active, action: (a: any) => { action = a; }, approve: (a: any) => { approve = a; }, customCalls: () => customCalls };
}

test('three-state flow, unknown mutation gate, no agent approval, exit sends nothing', async () => {
  const h = harness(); await h.emit('session_start', { reason: 'startup' }); await h.command();
  assert.equal(h.state().phase, 'planning'); assert.deepEqual(h.active(), OWN_TOOLS);
  for (const toolName of ['write', 'edit', 'bash', 'powershell', 'unknown', 'delegate', 'approve_plan', 'plan_execute']) {
    assert.equal((await h.emit('tool_call', { toolName, input: {} })).block, true);
  }
  assert.equal((await h.emit('user_bash')).result.exitCode, 1);
  const result = await h.submit(); assert.equal(result.terminate, true); assert.equal(h.state().markdown, markdown);
  assert.equal(h.state().phase, 'ready'); assert.equal(h.messages.length, 0);
  await h.command('--execute'); assert.equal(h.messages.length, 0);
  await h.command('--exit'); assert.equal(h.state().phase, 'off');
  assert.deepEqual(h.active(), ['read', 'bash', 'edit', 'write']); assert.equal(h.messages.length, 0);
});

test('approval hands off exactly one full artifact and restores only original tools', async () => {
  const h = harness({ active: ['read', 'edit'] }); await h.emit('session_start', { reason: 'startup' }); await h.command(); await h.submit();
  h.action('execute'); h.approve('明确批准并执行'); await h.command('--review');
  assert.equal(h.state().phase, 'off'); assert.deepEqual(h.active(), ['read', 'edit']);
  assert.equal(h.messages.length, 1); assert.ok(h.messages[0].endsWith(markdown));
  await h.command('--review'); assert.equal(h.messages.length, 1);
});

test('reload uses saved pre-planning tools, including original restrictions', async () => {
  for (const original of [['read', 'bash', 'edit', 'write'], ['read', 'edit']]) {
    const h = harness({ active: original }); await h.emit('session_start', { reason: 'startup' }); await h.command(); await h.submit();
    await h.emit('session_shutdown', { reason: 'reload' });
    const reloaded = harness({ active: h.active(), sm: h.sm }); await reloaded.emit('session_start', { reason: 'reload' });
    assert.equal(reloaded.state().markdown, markdown); assert.equal(reloaded.messages.length, 0);
    await reloaded.command('--exit'); assert.deepEqual(reloaded.active(), original);
  }
});

test('real read factory reads only, supports cancellation, and never delegates to builtin overrides', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'plan-read-'));
  try {
    const file = join(dir, 'source.txt'); await writeFile(file, '只读测试正文');
    const h = harness(); h.ctx.cwd = dir; await h.emit('session_start', { reason: 'startup' }); await h.command();
    const tool = h.tools.get('plan_read_file');
    const result = await tool.execute('read-id', { path: 'source.txt' }, undefined, undefined, h.ctx);
    assert.equal(result.content[0].text, '只读测试正文'); assert.equal(await readFile(file, 'utf8'), '只读测试正文');
    await assert.rejects(tool.execute('read-id', { path: file }, AbortSignal.abort(), undefined, h.ctx));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('fresh startup respects stricter baseline through a later reload', async () => {
  const h = harness(); await h.emit('session_start', { reason: 'startup' }); await h.command(); await h.submit();
  const restarted = harness({ sm: h.sm, active: ['read'] }); await restarted.emit('session_start', { reason: 'startup' });
  const reload = harness({ sm: h.sm, active: restarted.active() }); await reload.emit('session_start', { reason: 'reload' });
  await reload.command('--exit'); assert.deepEqual(reload.active(), ['read']);
});

test('active branch restoration ignores compaction summaries and other branches', async () => {
  const h = harness(); await h.emit('session_start', { reason: 'startup' });
  const root = h.sm.appendCustomEntry('unrelated', {}); await h.command(); await h.submit();
  const ready = h.sm.getLeafId();
  h.sm.appendCompaction('approved OTHER PLAN', ready, 1000);
  assert.equal(restore(h.sm.getBranch()).markdown, markdown);
  h.sm.branch(root); await h.emit('session_tree'); assert.equal(h.active().includes('write'), true); assert.equal(restore(h.sm.getBranch()).phase, 'off');
  h.sm.branch(ready); await h.emit('session_tree'); assert.deepEqual(h.active(), OWN_TOOLS); assert.equal(h.messages.length, 0);
});

test('same-batch submit fails, cancelled submit never persists', async () => {
  const h = harness(); await h.emit('session_start', { reason: 'startup' }); await h.command();
  h.addBatch(['plan_submit', 'plan_read_file']);
  assert.equal((await h.emit('tool_call', { toolName: 'plan_submit', toolCallId: 'call-0' })).block, true);
  await assert.rejects(h.tools.get('plan_submit').execute('call-0', { markdown, baseRevision: 0 }, undefined, undefined, h.ctx), /独占/);
  h.addBatch(['plan_submit']);
  await assert.rejects(h.tools.get('plan_submit').execute('call-0', { markdown, baseRevision: 0 }, AbortSignal.abort(), undefined, h.ctx));
  assert.equal(h.state().revision, 0);
});

test('cancel, stale input/navigation and queued confirmation cannot approve', async () => {
  for (const invalidate of ['cancel', 'input', 'session_before_tree', 'session_before_compact', 'pending', 'busy']) {
    const h = harness(); await h.emit('session_start', { reason: 'startup' }); await h.command(); await h.submit();
    h.action('execute'); h.approve(async () => {
      if (invalidate === 'cancel') return undefined;
      if (invalidate === 'pending') h.ctx.hasPendingMessages = () => true;
      else if (invalidate === 'busy') h.ctx.isIdle = () => false;
      else await h.emit(invalidate);
      return '明确批准并执行';
    });
    await h.command('--review'); assert.equal(h.messages.length, 0, invalidate); assert.equal(h.active().includes('write'), false);
  }
});

test('settled scheduling does not await UI, queued continuation invalidates ready', async () => {
  const h = harness(); await h.emit('session_start', { reason: 'startup' }); await h.command(); await h.submit();
  const count = h.customCalls();
  await h.emit('agent_settled'); await h.emit('message_start', { message: { role: 'user' } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.customCalls(), count); assert.equal(h.state().phase, 'planning');
  await h.submit(); h.action(null); await h.emit('agent_settled');
  await new Promise(resolve => setImmediate(resolve)); assert.equal(h.customCalls(), count + 1);
  await h.emit('agent_settled'); await new Promise(resolve => setImmediate(resolve)); assert.equal(h.customCalls(), count + 1);
});

test('RPC and headless never use custom UI or approve', async () => {
  for (const mode of ['rpc', 'print', 'json']) {
    const h = harness({ mode }); await h.emit('session_start', { reason: 'startup' }); await h.command(); await h.submit();
    h.action('execute'); h.approve('明确批准并执行'); await h.command('--review'); await h.emit('agent_settled');
    assert.equal(h.customCalls(), 0); assert.equal(h.messages.length, 0); assert.equal(h.state().phase, 'ready');
  }
});

test('continue, feedback and native editor save are not approvals', async () => {
  const h = harness(); await h.emit('session_start', { reason: 'startup' }); await h.command(); await h.submit();
  let values = ['edit', markdown + '\n修订尾部']; h.action(() => values.shift()); await h.command('--review');
  assert.equal(h.state().revision, 2); assert.ok(h.state().markdown.endsWith('修订尾部')); assert.equal(h.messages.length, 0);
  h.action('continue'); await h.command('--review'); assert.equal(h.state().phase, 'planning');
  await h.submit(); values = ['feedback', '补充测试']; h.action(() => values.shift()); await h.command('--review');
  assert.equal(h.state().phase, 'planning'); assert.equal(h.messages.length, 1); assert.ok(h.messages[0].includes('不实施'));
});

test('invalid markdown and storage errors keep gate restricted', async () => {
  assert.throws(() => validateMarkdown('x'.repeat(65537))); assert.throws(() => validateMarkdown('\x1b[31m bad'));
  const h = harness(); await h.emit('session_start', { reason: 'startup' }); await h.command();
  h.pi.appendEntry = () => { throw new Error('disk full'); }; await assert.rejects(h.submit(), /disk full/);
  await h.command('--exit'); assert.equal((await h.emit('tool_call', { toolName: 'write' })).block, true);
  assert.equal(h.messages.length, 0);
});
