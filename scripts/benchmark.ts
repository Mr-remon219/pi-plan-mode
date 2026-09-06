import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { initialState, persist, fingerprint, LEGACY_ENTRY, restore } from '../src/state.ts';
import { parsePlan, digest } from '../src/plan.ts';
import { prunePlans } from '../src/context.ts';

// Storage/context algorithm fixture, not a model/provider speed benchmark.
const dir = mkdtempSync(join(tmpdir(), 'plan-cost-'));
try {
  const rows = [];
  for (const revisions of [1, 5, 10]) {
    const legacy = SessionManager.create(dir, join(dir, `old-${revisions}`));
    const modern = SessionManager.create(dir, join(dir, `new-${revisions}`));
    let state = initialState(); let captureMs = 0; let legacyCaptureMs = 0;
    for (let n = 1; n <= revisions; n++) {
      const markdown = `# Revision ${n}\n`.padEnd(50 * 1024, 'x');
      const message = { role: 'assistant' as const, content: [{ type: 'text' as const, text: `<proposed_plan>\n${markdown}\n</proposed_plan>` }], timestamp: n, stopReason: 'stop' as const };
      legacy.appendMessage(message as never);
      const id = modern.appendMessage(message as never);
      // v0.3 stores a full state on ready, continue, and exit/reload-like transitions.
      const legacyStart = performance.now();
      for (const phase of ['ready', 'planning', 'ready']) legacy.appendCustomEntry(LEGACY_ENTRY, { phase, revision: n, markdown, beforeTools: ['read', 'write'] });
      legacyCaptureMs += performance.now() - legacyStart;
      const start = performance.now();
      const plan = parsePlan(message.content[0].text)!;
      const source = { entryId: id, fingerprint: fingerprint(message), block: 0, start: plan.start, end: plan.end, artifactId: digest(markdown), revision: n };
      for (const phase of ['ready', 'planning', 'ready'] as const) state = persist(modern.getBranch(), { ...state, phase, revision: n, markdown, source }, (t, d) => modern.appendCustomEntry(t, d));
      captureMs += performance.now() - start;
    }
    const messages = modern.getBranch().flatMap(e => e.type === 'message' ? [e.message] : []);
    const pruned = prunePlans(messages, modern.getBranch(), state.source?.entryId);
    const start = performance.now(); restore(modern.getBranch()); const restoreMs = performance.now() - start;
    const legacyStart = performance.now(); restore(legacy.getBranch()); const legacyRestoreMs = performance.now() - legacyStart;
    rows.push({ revisions, legacyCaptureMs: +legacyCaptureMs.toFixed(3), legacyRestoreMs: +legacyRestoreMs.toFixed(3), legacySessionBytes: statSync(legacy.getSessionFile()!).size, v2SessionBytes: statSync(modern.getSessionFile()!).size, legacyPlanCopies: revisions, v2PlanCopies: pruned.messages.filter(m => JSON.stringify(m).includes('<proposed_plan>')).length, v2ContextBytes: Buffer.byteLength(JSON.stringify(pruned.messages)), captureMs: +captureMs.toFixed(3), restoreMs: +restoreMs.toFixed(3) });
  }
  console.log(JSON.stringify({ kind: 'deterministic storage/context fixture; no model tokens or provider latency measured', bodyBytes: 51200, rows }, null, 2));
} finally { rmSync(dir, { recursive: true, force: true }); }
