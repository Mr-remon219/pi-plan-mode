import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, ModelRuntime, type ExtensionAPI, type ExtensionUIContext } from '@earendil-works/pi-coding-agent';
import { createAssistantMessageEventStream, type AssistantMessage } from '@earendil-works/pi-ai';
import planMode from '../src/index.ts';
import { restore, diskMatches, HANDOFF } from '../src/state.ts';

// No remote provider, credentials, real shell execution or fabricated session records.
for (const scenario of ['success', 'intercepted', 'acceptance-write-failure'] as const) test(`real SDK lifecycle: ${scenario}`, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'plan-lifecycle-'));
  const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const sm = SessionManager.create(dir, join(dir, 'sessions'));
  const requests: Array<{ tools: string[]; phase: string; prompt: string; planCopies: number }> = [];
  const errors: string[] = [];
  let action: string | null = null;
  const factory = (pi: ExtensionAPI) => {
    pi.registerProvider('plan-fixture', {
      baseUrl: 'http://offline.invalid', apiKey: 'fixture', api: 'openai-completions',
      models: [{ id: 'fixture', name: 'fixture', reasoning: false, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 10000 }],
      streamSimple(model, context) {
        requests.push({ tools: (context.tools || []).map(t => t.name), phase: restore(sm.getBranch()).phase, prompt: context.systemPrompt || '', planCopies: context.messages.filter(m => JSON.stringify(m).includes('只做获批事项。')).length });
        const stream = createAssistantMessageEventStream();
        const output: AssistantMessage = { role: 'assistant', api: model.api, provider: model.provider, model: model.id, content: [], timestamp: Date.now(), stopReason: 'pending', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        queueMicrotask(() => {
          stream.push({ type: 'start', partial: structuredClone(output) });
          const text = requests.length === 1 ? '<proposed_plan>\n# 计划\n只做获批事项。\n</proposed_plan>' : '收到实施交接（测试不执行工具）';
          output.content = [{ type: 'text', text }];
          stream.push({ type: 'text_delta', contentIndex: 0, delta: text, partial: structuredClone(output) });
          output.stopReason = 'stop';
          stream.push({ type: 'done', reason: 'stop', message: output }); stream.end();
        });
        return stream;
      },
    });
    planMode(new Proxy(pi, { get(target, key) {
      if (key === 'appendEntry' && scenario === 'acceptance-write-failure') return (type: string, data: unknown) => {
        if (type === HANDOFF) throw new Error('injected handoff write failure');
        target.appendEntry(type, data);
      };
      return Reflect.get(target, key);
    } }));
    if (scenario === 'intercepted') pi.on('input', event => event.text.startsWith('[plan-handoff:') ? { action: 'handled' } : undefined);
  };
  let session: Awaited<ReturnType<typeof createAgentSession>>['session'] | undefined;
  try {
    const modelRuntime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: join(dir, 'models.json'), modelsStorePath: join(dir, 'catalog.json'), allowModelNetwork: false });
    const loader = new DefaultResourceLoader({ cwd: dir, agentDir: dir, settingsManager: settings, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories: [factory] });
    await loader.reload();
    ({ session } = await createAgentSession({ cwd: dir, agentDir: dir, sessionManager: sm, settingsManager: settings, resourceLoader: loader, modelRuntime, tools: ['read', 'bash', 'write', 'edit'] }));
    await session.bindExtensions({ mode: 'tui', onError: e => errors.push(e.error), uiContext: {
      setStatus() {}, notify(message: string) { errors.push(message); }, custom: async () => action, select: async () => '明确批准并执行',
    } as unknown as ExtensionUIContext });
    const model = modelRuntime.getModel('plan-fixture', 'fixture'); assert.ok(model);
    await session.setModel(model);
    await session.prompt('/plan');
    assert.equal(existsSync(sm.getSessionFile()!), false, 'empty session deliberately has no disk record');
    await session.prompt('形成计划');
    assert.equal(restore(sm.getBranch()).phase, 'ready', JSON.stringify(errors));
    assert.ok(diskMatches(sm.getSessionFile(), sm.getLeafId(), restore(sm.getBranch())));
    assert.ok(!requests[0].tools.includes('write'));
    action = 'execute';
    await session.prompt('/plan --review');
    // sendUserMessage is fire-and-forget; wait for actual event completion rather than its void return.
    for (let i = 0; i < 100 && (requests.length < 2 || session.isStreaming); i++) await new Promise(resolve => setTimeout(resolve, 10));
    if (scenario !== 'success') {
      assert.equal(restore(sm.getBranch()).phase, 'handoff_pending', JSON.stringify(errors));
      assert.ok(diskMatches(sm.getSessionFile(), sm.getLeafId(), restore(sm.getBranch())));
      if (scenario === 'intercepted') assert.equal(requests.length, 1);
      else assert.ok(errors.some(e => e.includes('injected handoff write failure')));
      return;
    }
    assert.equal(requests.length, 2, JSON.stringify(errors));
    assert.ok(requests[1].tools.includes('write'), JSON.stringify(requests));
    assert.equal(requests[1].phase, 'off', JSON.stringify(errors));
    assert.equal(requests[1].planCopies, 1, 'handoff contains the sole unsigned plan body');
    assert.ok(!requests[1].prompt.includes('你处于宿主管理的独立规划模式'));
    assert.equal(restore(sm.getBranch()).phase, 'off');
    assert.ok(diskMatches(sm.getSessionFile(), sm.getLeafId(), restore(sm.getBranch())));
  } finally { session?.dispose(); rmSync(dir, { recursive: true, force: true }); }
});
