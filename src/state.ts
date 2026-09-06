import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import { readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { digest, parsePlan, validateMarkdown } from './plan.ts';
export { extractProposedPlan, validateMarkdown } from './plan.ts';

export const LEGACY_ENTRY = 'pi-plan-mode/v1';
export const ENTRY = 'pi-plan-mode/state/v2';
export const ARTIFACT = 'pi-plan-mode/artifact/v2';
export const HANDOFF = 'pi-plan-mode/handoff/v2';
export const OWN_TOOLS = ['plan_read', 'plan_submit'];
export const LOCAL_FILE_MUTATION_TOOLS = new Set(['edit', 'write', 'apply_patch']);
export interface CaptureSource { entryId: string; fingerprint: string; block: number; start: number; end: number; artifactId: string; revision: number }
export interface Pending { id: string; artifactId: string; revision: number; target: 'same' | 'fresh' }
export interface PlanState {
  phase: 'off' | 'planning' | 'ready' | 'handoff_pending';
  revision: number;
  /** Resolved in memory; never included in v2 state records. */
  markdown: string;
  artifactId?: string;
  source?: CaptureSource;
  pending?: Pending;
  beforeTools: string[];
  toolConflict?: boolean;
}
export const initialState = (): PlanState => ({ phase: 'off', revision: 0, markdown: '', beforeTools: [] });
export const fingerprint = (message: unknown): string => digest(JSON.stringify(message));
function checkState(s: PlanState): void {
  if (!s || !['off', 'planning', 'ready', 'handoff_pending'].includes(s.phase) || !Number.isSafeInteger(s.revision) || s.revision < 0 ||
      !Array.isArray(s.beforeTools) || !s.beforeTools.every(n => typeof n === 'string')) throw new Error('规划快照无效');
  if (s.toolConflict !== undefined && typeof s.toolConflict !== 'boolean') throw new Error('工具冲突记录无效');
  if (s.artifactId !== undefined && (typeof s.artifactId !== 'string' || !/^[a-f0-9]{64}$/.test(s.artifactId))) throw new Error('工件引用无效');
  if (s.source && (typeof s.source.entryId !== 'string' || typeof s.source.fingerprint !== 'string' || !Number.isSafeInteger(s.source.block) || s.source.block < 0 || !Number.isSafeInteger(s.source.start) || s.source.start < 0 || !Number.isSafeInteger(s.source.end) || s.source.end <= s.source.start || s.source.artifactId !== s.artifactId || s.source.revision !== s.revision)) throw new Error('计划来源引用无效');
  if (s.markdown) validateMarkdown(s.markdown);
  if (['ready', 'handoff_pending'].includes(s.phase) && !s.markdown?.trim()) throw new Error('待审阅计划缺少正文');
  if (s.phase === 'handoff_pending' && (!s.pending || typeof s.pending.id !== 'string' || !s.pending.id || s.pending.revision !== s.revision || s.pending.artifactId !== s.artifactId || !['same', 'fresh'].includes(s.pending.target))) throw new Error('交接引用无效');
}
export function restore(branch: SessionEntry[]): PlanState {
  const index = branch.findLastIndex(e => e.type === 'custom' && (e.customType === LEGACY_ENTRY || e.customType.startsWith('pi-plan-mode/state/')));
  if (index < 0) return initialState();
  const entry = branch[index];
  if (entry.type !== 'custom') return initialState();
  if (entry.customType !== ENTRY && entry.customType !== LEGACY_ENTRY) throw new Error('未知规划状态版本');
  const raw = entry.data as PlanState;
  if (!raw || typeof raw !== 'object') throw new Error('规划快照无效');
  let markdown = '';
  if (entry.customType === LEGACY_ENTRY) {
    if (typeof raw.markdown !== 'string') throw new Error('旧规划正文无效');
    markdown = raw.markdown;
  } else if (raw.artifactId) {
    const artifact = branch.slice(0, index).findLast(e => e.type === 'custom' && e.customType === ARTIFACT && (e.data as { id?: string })?.id === raw.artifactId);
    if (!artifact || artifact.type !== 'custom') throw new Error('活动分支缺少计划工件');
    const a = artifact.data as { id: string; sha256: string; bytes: number; markdown: string };
    if (typeof a.markdown !== 'string' || digest(a.markdown) !== a.sha256 || a.id !== a.sha256 || Buffer.byteLength(a.markdown) !== a.bytes) throw new Error('计划工件摘要不匹配');
    markdown = a.markdown;
  }
  const state = { ...raw, markdown };
  checkState(state);
  if (state.source) {
    const source = branch.slice(0, index).find(e => e.id === state.source!.entryId);
    if (!source || source.type !== 'message' || source.message.role !== 'assistant' || fingerprint(source.message) !== state.source.fingerprint) throw new Error('活动分支缺少匹配的计划来源消息');
    const block = source.message.content[state.source.block];
    try {
      const plan = block?.type === 'text' ? parsePlan(block.text) : undefined;
      if (!plan || plan.start !== state.source.start || plan.end !== state.source.end || digest(plan.markdown) !== state.artifactId) throw new Error('区间或正文摘要不匹配');
    } catch (error) { throw new Error(`计划来源块无效：${error}`); }
  }
  return { ...state, beforeTools: [...state.beforeTools] };
}
export function persist(branch: SessionEntry[], next: PlanState, append: (type: string, data: unknown) => void): PlanState {
  const artifactId = next.markdown ? digest(next.markdown) : undefined;
  const resolved = { ...next, artifactId };
  checkState(resolved);
  const existing = branch.findLast(e => e.type === 'custom' && e.customType === ARTIFACT && (e.data as { id?: string })?.id === artifactId);
  if (artifactId && existing?.type === 'custom') {
    const a = existing.data as { sha256?: string; bytes?: number; markdown?: string };
    if (a.markdown !== next.markdown || a.sha256 !== artifactId || a.bytes !== Buffer.byteLength(next.markdown)) throw new Error('已存在的计划工件损坏');
  } else if (artifactId) {
    append(ARTIFACT, { id: artifactId, sha256: artifactId, bytes: Buffer.byteLength(next.markdown), markdown: next.markdown });
  }
  const { markdown: _markdown, ...record } = resolved;
  append(ENTRY, record);
  return resolved;
}
/** Checks actual active-branch state on disk, not just file existence. Not fsync. */
export function diskMatches(file: string | undefined, leafId: string | null, expected: PlanState): boolean {
  if (!file || !leafId) return false;
  try {
    const entries = readFileSync(file, 'utf8').trim().split('\n').map(line => JSON.parse(line) as SessionEntry);
    const byId = new Map(entries.map(e => [e.id, e]));
    const branch: SessionEntry[] = []; let id: string | null = leafId;
    const seen = new Set<string>();
    while (id) { if (seen.has(id)) return false; seen.add(id); const e = byId.get(id); if (!e) return false; branch.unshift(e); id = e.parentId; }
    const actual = restore(branch);
    return isDeepStrictEqual(JSON.parse(JSON.stringify(actual)), JSON.parse(JSON.stringify(expected)));
  } catch { return false; }
}
export function restoredTools(saved: string[], available: string[], baseline?: string[]): string[] {
  return saved.filter(n => !OWN_TOOLS.includes(n) && available.includes(n) && (!baseline || baseline.includes(n)));
}
export function handoff(s: PlanState): string {
  return `用户已明确批准计划 v${s.revision}。现在按原有工具与权限实施并验证；重大偏离范围先询问用户。以下是批准的完整 Markdown 计划：\n\n${s.markdown}`;
}
