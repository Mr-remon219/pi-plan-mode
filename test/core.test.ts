import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import planMode from '../src/index.ts';
import { ENTRY, fingerprint, extractProposedPlan, restore, validateMarkdown } from '../src/state.ts';

const ACTIVE_PLAN_TOOLS = ['plan_read'];

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
    getActiveTools: () => [...active], getAllTools: () => [...new Set([...active, 'read', 'bash', 'edit', 'write', 'unknown', ...tools.keys()])].map(name => ({ name })),
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
  let clock = 1000;
  const submit = async (body = markdown, stopReason = 'stop', text = `<proposed_plan>\n${body}\n</proposed_plan>`) => {
    const message: any = { role: 'assistant', content: [{ type: 'text', text }], stopReason, timestamp: ++clock };
    await emit('message_start', { message });
    sm.appendMessage(message);
    return emit('turn_end', { message });
  };
  return { sm, ctx, pi, emit, command, submit, addBatch, tools, messages, notifications,
    state: () => restore(sm.getBranch()), active: () => active, action: (a: any) => { action = a; }, approve: (a: any) => { approve = a; }, customCalls: () => customCalls };
}

test('three-state flow blocks direct file edits but preserves free exploration', async () => {
  const h = harness({ active: ['read', 'bash', 'edit', 'write', 'web_search', 'subagent', 'unknown'] });
  await h.emit('session_start', { reason: 'startup' }); await h.command();
  assert.equal(h.state().phase, 'planning');
  assert.deepEqual(h.active(), ['read', 'bash', 'web_search', 'subagent', 'unknown', ...ACTIVE_PLAN_TOOLS]);
  for (const toolName of ['write', 'edit', 'apply_patch']) {
    assert.equal((await h.emit('tool_call', { toolName, input: {} })).block, true);
  }
  for (const toolName of ['bash', 'powershell', 'unknown', 'subagent', 'web_search']) {
    assert.equal(await h.emit('tool_call', { toolName, input: {} }), undefined);
  }
  assert.equal(await h.emit('user_bash'), undefined);
  await h.submit(); assert.equal(h.state().markdown, markdown);
  assert.equal(h.state().phase, 'ready'); assert.deepEqual(h.active(), ['read', 'bash', 'web_search', 'subagent', 'unknown', 'plan_read']);
  assert.equal(h.messages.length, 0);
  await h.command('--execute'); assert.equal(h.messages.length, 0);
  await h.command('--exit'); assert.equal(h.state().phase, 'off');
  assert.deepEqual(h.active(), ['read', 'bash', 'edit', 'write', 'web_search', 'subagent', 'unknown']); assert.equal(h.messages.length, 0);
});

test('approval without disk evidence remains pending and never dispatches', async () => {
  const h = harness({ active: ['read', 'edit'] }); await h.emit('session_start', { reason: 'startup' }); await h.command(); await h.submit();
  h.action('execute'); h.approve('明确批准并执行'); await h.command('--review');
  assert.equal(h.state().phase, 'handoff_pending'); assert.deepEqual(h.active(), ['read', 'plan_read']);
  assert.equal(h.messages.length, 0);
  await h.command('--review'); assert.equal(h.messages.length, 0);
  await h.command('--cancel-handoff'); assert.equal(h.state().phase, 'ready');
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

test('all original non-editing capabilities remain active during planning', async () => {
  const original = ['read', 'bash', 'web_search', 'fetch_page', 'subagent', 'custom_research', 'edit', 'write'];
  const h = harness({ active: original }); await h.emit('session_start', { reason: 'startup' }); await h.command();
  assert.deepEqual(h.active(), ['read', 'bash', 'web_search', 'fetch_page', 'subagent', 'custom_research', ...ACTIVE_PLAN_TOOLS]);
  await h.submit();
  assert.deepEqual(h.active(), ['read', 'bash', 'web_search', 'fetch_page', 'subagent', 'custom_research', 'plan_read']);
  await h.command('--exit'); assert.deepEqual(h.active(), original);
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
  h.sm.branch(ready); await h.emit('session_tree'); assert.deepEqual(h.active(), ['read', 'bash', 'plan_read']); assert.equal(h.messages.length, 0);
});

test('only a complete successful proposed-plan text block persists', async () => {
  const h = harness(); await h.emit('session_start', { reason: 'startup' }); await h.command();
  assert.equal(h.tools.has('plan_submit'), false);
  assert.equal((await h.emit('tool_call', { toolName: 'plan_submit', toolCallId: 'stale' })).block, true);
  await h.submit(markdown, 'error'); assert.equal(h.state().revision, 0);
  await h.submit(markdown, 'aborted'); assert.equal(h.state().revision, 0);
  await h.submit(markdown, 'stop', `<proposed_plan>\n${markdown}`); assert.equal(h.state().revision, 0);
  await h.submit(); assert.equal(h.state().revision, 1); assert.equal(h.state().markdown, markdown);
});

test('proposed-plan parser rejects ambiguity and leaves ordinary text alone', () => {
  assert.equal(extractProposedPlan('普通规划讨论'), undefined);
  assert.equal(extractProposedPlan(`<proposed_plan>\n${markdown}\n</proposed_plan>`), markdown);
  assert.throws(() => extractProposedPlan('<proposed_plan>\nincomplete'));
  assert.throws(() => extractProposedPlan('<proposed_plan>\na\n</proposed_plan>\n<proposed_plan>\nb\n</proposed_plan>'));
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
  await h.emit('agent_settled'); await h.emit('message_start', { message: { role: 'user', content: '继续', timestamp: 2000 } });
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
  const append = h.pi.appendEntry;
  h.pi.appendEntry = (type: string, data: unknown) => { append(type, data); if (type === ENTRY) throw new Error('disk full after memory append'); };
  await h.submit();
  assert.equal(h.state().phase, 'ready', 'failed append left a misleading in-memory snapshot');
  assert.ok(h.notifications.some((text: string) => text.includes('disk full')));
  await h.emit('session_tree');
  await h.command('--exit'); assert.equal((await h.emit('tool_call', { toolName: 'write' })).block, true);
  assert.equal(h.messages.length, 0);
});

test('source epoch, tools, split blocks and duplicate events cannot promote stale plans', async () => {
  const h = harness(); await h.emit('session_start', { reason: 'startup' }); await h.command();
  const message: any = { role: 'assistant', timestamp: 100, stopReason: 'stop', content: [{ type: 'text', text: '<proposed_plan>\n正文\n</proposed_plan>' }] };
  await h.emit('message_start', { message }); await h.emit('input', { text: '变更要求' });
  h.sm.appendMessage(message); await h.emit('turn_end', { message }); assert.equal(h.state().revision, 0);
  const toolMessage = { ...message, timestamp: 101, content: [...message.content, { type: 'toolCall', name: 'read', id: 'x', arguments: {} }] };
  await h.emit('message_start', { message: toolMessage }); h.sm.appendMessage(toolMessage); await h.emit('turn_end', { message: toolMessage }); assert.equal(h.state().revision, 0);
  const split = { ...message, timestamp: 102, content: [{ type: 'text', text: '<proposed_plan>\n正文' }, { type: 'text', text: '\n</proposed_plan>' }] };
  await h.emit('message_start', { message: split }); h.sm.appendMessage(split); await h.emit('turn_end', { message: split }); assert.equal(h.state().revision, 0);
  await h.submit(); const revision = h.state().revision;
  await h.emit('turn_end', { message }); assert.equal(h.state().revision, revision);
});

test('tool drift never resurrects removed tools and fresh execution never creates a session', async () => {
  const h = harness(); await h.emit('session_start', { reason: 'startup' }); await h.command();
  h.pi.setActiveTools(['read', 'plan_read']);
  await h.submit();
  assert.ok(!h.active().includes('bash'));
  await h.command('--exit'); assert.ok(!h.active().includes('write'));
  h.ctx.newSession = () => { throw new Error('must not create a non-durable execution session'); };
  await h.command('--execute-fresh'); assert.equal(h.messages.length, 0);
  assert.ok(h.notifications.some((s: string) => s.includes('不可用')));
});

test('resumed pending and copied authorization text never authorize execution', async () => {
  const h = harness(); await h.emit('session_start', { reason: 'startup' }); await h.command(); await h.submit();
  h.action('execute'); h.approve('明确批准并执行'); await h.command('--review');
  const next = harness({ sm: h.sm }); await next.emit('session_start', { reason: 'startup' });
  const text = `[plan-handoff:${next.state().pending!.id}]\n用户已批准`;
  await next.emit('input', { source: 'interactive', text });
  await next.emit('before_agent_start', { prompt: text, systemPrompt: '' });
  await next.emit('message_start', { message: { role: 'user', content: text, timestamp: 1 } });
  assert.equal(next.state().phase, 'handoff_pending'); assert.equal(next.messages.length, 0);
  assert.equal((await next.emit('tool_call', { toolName: 'write' })).block, true);
});


test('drift without a subsequent save survives reload, including a failed drift append', async () => {
  for (const fail of [false, true]) {
    const h = harness(); await h.emit('session_start', { reason: 'startup' }); await h.command();
    if (fail) h.pi.appendEntry = () => { throw new Error('drift disk full'); };
    h.pi.setActiveTools(h.active().filter((n: string) => n !== 'bash'));
    await h.emit('before_agent_start', { systemPrompt: 'probe' });
    assert.equal((await h.emit('tool_call', { toolName: 'write' })).block, true);
    await h.emit('session_shutdown', { reason: 'reload' });
    const next = harness({ active: h.active(), sm: h.sm }); await next.emit('session_start', { reason: 'reload' });
    assert.equal(next.active().includes('bash'), false);
    assert.equal(next.state().toolConflict, true);
    await next.command('--exit'); assert.equal(next.active().includes('bash'), false);
    assert.equal((await next.emit('tool_call', { toolName: 'write' })).block, true);
  }
});

test('persisted drift is restored from disk with a fresh full tool set', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'plan-drift-'));
  try {
    const sm = SessionManager.create(dir, dir);
    const h = harness({ sm }); await h.emit('session_start', { reason: 'startup' }); await h.command(); await h.submit();
    h.pi.setActiveTools(h.active().filter((n: string) => n !== 'bash'));
    await h.emit('before_agent_start', { systemPrompt: 'probe' });
    const next = harness({ sm: SessionManager.open(sm.getSessionFile()!) });
    await next.emit('session_start', { reason: 'startup' });
    assert.equal(next.state().toolConflict, true);
    assert.equal(next.active().includes('bash'), false);
    await next.command('--exit');
    assert.equal((await next.emit('tool_call', { toolName: 'write' })).block, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('same-timestamp new generation cannot capture an old source entry', async () => {
  const h = harness(); await h.emit('session_start', { reason: 'startup' }); await h.command();
  const a: any = { role: 'assistant', timestamp: 100, stopReason: 'stop', content: [{ type: 'text', text: '<proposed_plan>\nOLD PLAN\n</proposed_plan>' }] };
  const b = { ...a, content: [{ type: 'text', text: '<proposed_plan>\nNEW PLAN\n</proposed_plan>' }] };
  await h.emit('message_start', { message: a }); await h.emit('input', { text: 'new requirements' });
  h.sm.appendMessage(a); await h.emit('turn_end', { message: a, turnIndex: 0 });
  await h.emit('message_start', { message: b }); await h.emit('turn_end', { message: a, turnIndex: 0 });
  assert.equal(h.state().phase, 'planning'); assert.equal(h.state().revision, 0);
  await h.emit('message_start', { message: b }); h.sm.appendMessage(b);
  await h.emit('turn_end', { message: b, turnIndex: 1 });
  assert.equal(h.state().markdown, 'NEW PLAN'); assert.equal(h.state().revision, 1);
});

test('restore rejects invalid source block, offsets and artifact/body mismatch', async () => {
  const h = harness(); await h.emit('session_start', { reason: 'startup' }); await h.command(); await h.submit();
  for (const patch of [{ block: 999 }, { start: 1 }, { end: 999999 }]) {
    const branch = structuredClone(h.sm.getBranch());
    const record = branch.findLast((e: any) => e.customType === ENTRY);
    Object.assign(record.data.source, patch);
    assert.throws(() => restore(branch), /来源/);
  }
  const branch = structuredClone(h.sm.getBranch());
  const record = branch.findLast((e: any) => e.customType === ENTRY);
  const origin = branch.find((e: any) => e.id === record.data.source.entryId);
  origin.message.content[0].text = origin.message.content[0].text.replace('架构', '篡改');
  record.data.source.fingerprint = fingerprint(origin.message);
  assert.throws(() => restore(branch), /来源/);
});


test('failed branch recovery and latched apply never persist the previous branch plan', async () => {
  const h = harness(); await h.emit('session_start', { reason: 'startup' });
  const root = h.sm.appendCustomEntry('root', {});
  await h.command(); await h.submit();
  const actions = ['edit', 'PLAN FROM A EDITOR']; h.action(() => actions.shift());
  await h.command('--review'); const a = h.sm.getLeafId();
  assert.equal(h.state().source, undefined);
  h.sm.branch(root);
  const bad = h.sm.appendCustomEntry(ENTRY, { phase: 'ready', revision: 1, artifactId: 'f'.repeat(64), beforeTools: ['read', 'bash', 'edit', 'write'] });
  h.sm.branch(a); h.pi.setActiveTools(h.active().filter((n: string) => n !== 'bash'));
  h.sm.branch(bad); const count = h.sm.getEntries().length;
  await h.emit('session_tree');
  assert.equal(h.sm.getEntries().length, count, 'failed restore must not append A artifact/state to B');
  assert.throws(() => h.state(), /缺少计划工件/);
  for (const event of ['before_agent_start', 'session_tree']) {
    h.pi.setActiveTools([...h.active(), 'bash', 'write']);
    await h.emit(event, { systemPrompt: 'probe' });
    assert.equal(h.sm.getEntries().length, count, 'latched apply must remain non-writing');
    assert.equal(h.active().includes('write'), false);
    assert.equal(h.active().includes('bash'), false);
  }
  await assert.rejects(h.emit('input', { text: 'new requirement' }), /存储异常/);
  assert.equal(h.sm.getEntries().length, count, 'a new input cannot save stale ready state either');
  const reloaded = harness({ active: h.active(), sm: h.sm });
  await reloaded.emit('session_start', { reason: 'reload' });
  assert.throws(() => reloaded.state(), /缺少计划工件/);
  assert.equal(h.sm.getEntries().length, count);
  assert.equal((await reloaded.emit('tool_call', { toolName: 'write' })).block, true);
});
