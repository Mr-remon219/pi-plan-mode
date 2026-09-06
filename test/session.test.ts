import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { ARTIFACT, ENTRY, LEGACY_ENTRY, persist, restore, initialState, diskMatches, type PlanState } from '../src/state.ts';
import { digest } from '../src/plan.ts';

test('v1 migrates append-only; twenty transitions reuse one validated artifact', () => {
  const sm = SessionManager.inMemory();
  const old = { ...initialState(), phase: 'ready' as const, revision: 1, markdown: '# 原计划', beforeTools: ['read', 'write'] };
  sm.appendCustomEntry(LEGACY_ENTRY, old);
  let s = restore(sm.getBranch());
  for (let i = 0; i < 20; i++) s = persist(sm.getBranch(), { ...s, phase: i % 2 ? 'ready' : 'planning' }, (t, d) => sm.appendCustomEntry(t, d));
  assert.equal(sm.getBranch().filter(e => e.type === 'custom' && e.customType === ARTIFACT).length, 1);
  assert.equal(sm.getBranch().filter(e => e.type === 'custom' && e.customType === LEGACY_ENTRY).length, 1);
  assert.equal(restore(sm.getBranch()).markdown, old.markdown);
  for (const e of sm.getBranch()) if (e.type === 'custom' && e.customType === ENTRY) assert.equal('markdown' in (e.data as object), false);
});

test('broken references, hash mismatches, future schemas and sibling artifacts fail closed', () => {
  const sm = SessionManager.inMemory();
  const root = sm.appendCustomEntry('root', {});
  const s = persist(sm.getBranch(), { ...initialState(), phase: 'ready', revision: 1, markdown: '正文' }, (t, d) => sm.appendCustomEntry(t, d));
  sm.branch(root);
  const { markdown: _m, ...record } = s;
  sm.appendCustomEntry(ENTRY, record);
  assert.throws(() => restore(sm.getBranch()), /缺少/);
  sm.appendCustomEntry(ARTIFACT, { id: s.artifactId, sha256: s.artifactId, bytes: 1, markdown: '正文' });
  sm.appendCustomEntry(ENTRY, record);
  assert.throws(() => restore(sm.getBranch()), /摘要/);
  sm.appendCustomEntry('pi-plan-mode/state/v99', record);
  assert.throws(() => restore(sm.getBranch()), /未知/);
});

test('real disk planning/ready/pending survive fresh processes and compaction; empty session does not', () => {
  const dir = mkdtempSync(join(tmpdir(), 'plan-session-'));
  try {
    const sm = SessionManager.create(dir, dir);
    let s = persist(sm.getBranch(), { ...initialState(), phase: 'planning' }, (t, d) => sm.appendCustomEntry(t, d));
    assert.equal(diskMatches(sm.getSessionFile(), sm.getLeafId(), s), false);
    // A synthetic conversation fixture tests storage only. Production never manufactures assistant entries.
    sm.appendMessage({ role: 'assistant', content: [{ type: 'text', text: 'fixture' }], stopReason: 'stop', timestamp: 1 } as never);
    for (const phase of ['planning', 'ready', 'handoff_pending'] as const) {
      s = persist(sm.getBranch(), { ...s, phase, markdown: '# 持久化', revision: 1, pending: phase === 'handoff_pending' ? { id: 'approval', artifactId: digest('# 持久化'), revision: 1, target: 'same' } : undefined }, (t, d) => sm.appendCustomEntry(t, d));
      sm.appendCompaction('summary', sm.getLeafId()!, 1000);
      assert.ok(diskMatches(sm.getSessionFile(), sm.getLeafId(), s));
      const child = JSON.parse(execFileSync(process.execPath, ['--experimental-transform-types', 'test/fixtures/disk-probe.ts', sm.getSessionFile()!], { cwd: resolve('.'), encoding: 'utf8' }));
      assert.equal(child.phase, phase); assert.equal(child.markdown, '# 持久化');
    }
    assert.ok(readFileSync(sm.getSessionFile()!, 'utf8').includes('handoff_pending'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('artifact write/state write failures do not commit a new state', () => {
  for (const boundary of [1, 2]) {
    const sm = SessionManager.inMemory();
    let count = 0;
    assert.throws(() => persist(sm.getBranch(), { ...initialState(), phase: 'ready', revision: 1, markdown: '新计划' }, (t, d) => {
      if (++count === boundary) throw new Error('disk full');
      sm.appendCustomEntry(t, d);
    }), /disk full/);
    assert.equal(restore(sm.getBranch()).phase, 'off');
  }
});
