import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { prunePlans } from '../src/context.ts';
import { initialState, persist, fingerprint } from '../src/state.ts';
import { parsePlan, digest } from '../src/plan.ts';

function sample(sm: SessionManager, n: number, extra = {}) {
  const message = { role: 'assistant' as const, content: [{ type: 'text' as const, text: '保留前言\n<proposed_plan>\n同一正文\n</proposed_plan>\n保留后语' }], timestamp: n, stopReason: 'stop' as const, ...extra };
  const id = sm.appendMessage(message as never);
  const plan = parsePlan(message.content[0].text)!;
  const source = { entryId: id, fingerprint: fingerprint(message), block: 0, start: plan.start, end: plan.end, revision: n, artifactId: digest(plan.markdown) };
  persist(sm.getBranch(), { ...initialState(), phase: 'ready', markdown: plan.markdown, revision: n, source }, (t, d) => sm.appendCustomEntry(t, d));
  return { message, id };
}
test('same body distinct sources prune only old captured text without touching transcript', () => {
  const sm = SessionManager.inMemory();
  const first = sample(sm, 1); const second = sample(sm, 2);
  const user = { role: 'user' as const, content: '不允许删除数据', timestamp: 3 };
  const result = prunePlans([first.message as never, second.message as never, user], sm.getBranch(), second.id);
  assert.ok(JSON.stringify(result.messages[0]).includes('已归档'));
  assert.ok(JSON.stringify(result.messages[0]).includes('保留前言'));
  assert.ok(JSON.stringify(result.messages[0]).includes('保留后语'));
  assert.deepEqual(result.messages[1], second.message); assert.equal(result.messages[2], user);
  assert.ok(first.message.content[0].text.includes('同一正文'));
});
test('duplicate fingerprints and signed messages are preserved', () => {
  const sm = SessionManager.inMemory();
  const signed = sample(sm, 1, { responseId: 'signed-response' });
  const first = sample(sm, 2); const second = sample(sm, 2);
  const result = prunePlans([signed.message, first.message, second.message] as never, sm.getBranch());
  assert.deepEqual(result.messages, [signed.message, first.message, second.message]);
  assert.equal(result.skipped, 3);
});

test('materialized compaction tail retains identity and tool pairs are untouched', () => {
  const sm = SessionManager.inMemory(); const old = sample(sm, 1); const current = sample(sm, 2);
  const call: any = { role: 'assistant', timestamp: 3, stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'call', name: 'read', arguments: {} }] };
  const result: any = { role: 'toolResult', timestamp: 4, toolCallId: 'call', toolName: 'read', content: [{ type: 'text', text: 'evidence' }], isError: false };
  sm.appendCompaction('summary', sm.getLeafId()!, 1000);
  // New Pi compactions materialize copies of messages in retainedTail; no object identity is assumed.
  const tail = structuredClone([old.message, current.message, call, result]);
  const pruned = prunePlans(tail, sm.getBranch(), current.id);
  assert.ok(JSON.stringify(pruned.messages[0]).includes('已归档'));
  assert.deepEqual(pruned.messages.slice(2), [call, result]);
});
