import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import { ENTRY, fingerprint, type CaptureSource } from './state.ts';
import { parsePlan, digest } from './plan.ts';

type Message = Extract<SessionEntry, { type: 'message' }>['message'];
/** Never mutate transcript, signed blocks, tool messages, or ambiguous matches. */
export function prunePlans(messages: Message[], branch: SessionEntry[], currentSource?: string): { messages: Message[]; skipped: number } {
  const sources = new Map<string, CaptureSource>();
  for (const entry of branch) {
    if (entry.type !== 'custom' || entry.customType !== ENTRY) continue;
    const s = (entry.data as { source?: CaptureSource })?.source;
    if (s && s.entryId !== currentSource) sources.set(s.entryId, s);
  }
  let skipped = 0;
  const counts = new Map<string, number>();
  for (const m of messages) { const key = fingerprint(m); counts.set(key, (counts.get(key) || 0) + 1); }
  const result = messages.map(m => {
    const key = fingerprint(m);
    const matched = [...sources.values()].filter(s => s.fingerprint === key);
    if (!matched.length) return m;
    if (matched.length !== 1 || counts.get(key) !== 1 || m.role !== 'assistant' || m.content.some(b => b.type !== 'text' || Object.keys(b).some(k => !['type', 'text'].includes(k))) || Object.keys(m).some(k => /signature|responseId/i.test(k))) { skipped++; return m; }
    const source = matched[0];
    const original = branch.find(e => e.id === source.entryId);
    if (!original || original.type !== 'message' || fingerprint(original.message) !== key) { skipped++; return m; }
    const block = m.content[source.block];
    try {
      const plan = block?.type === 'text' ? parsePlan(block.text) : undefined;
      if (!plan || plan.start !== source.start || plan.end !== source.end || digest(plan.markdown) !== source.artifactId) { skipped++; return m; }
    } catch { skipped++; return m; }
    const content = m.content.map((b, i) => i === source.block && b.type === 'text'
      ? { ...b, text: b.text.slice(0, source.start) + `[计划 v${source.revision} 已归档；hash=${source.artifactId}；当前正文用 plan_read 获取]` + b.text.slice(source.end) }
      : b);
    return { ...m, content };
  });
  return { messages: result, skipped };
}
