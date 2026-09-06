import { createHash } from 'node:crypto';

export const digest = (text: string): string => createHash('sha256').update(text).digest('hex');
export function validateMarkdown(markdown: string): void {
  if (!markdown.trim()) throw new Error('计划正文不能为空');
  if (Buffer.byteLength(markdown, 'utf8') > 65536) throw new Error('计划超过 64 KiB；不会截断保存');
  if (/[\x00-\x08\x0b-\x1f\x7f-\x9f]/u.test(markdown)) throw new Error('计划包含不支持的终端控制字符');
}
export interface PlanBlock { markdown: string; start: number; end: number }
/** Offsets refer to the original text. Only structural lines outside fences count. */
export function parsePlan(text: string): PlanBlock | undefined {
  let fence: { char: string; length: number } | undefined;
  let opening: { start: number; body: number } | undefined;
  let result: PlanBlock | undefined;
  let offset = 0;
  for (const raw of text.split(/(?<=\n)/)) {
    const line = raw.replace(/\r?\n$/, '');
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (marker && marker[1][0] === fence.char && marker[1].length >= fence.length && !marker[2].trim()) fence = undefined;
    } else if (marker) {
      fence = { char: marker[1][0], length: marker[1].length };
    } else if (/^<proposed_plan>[ \t]*$/.test(line)) {
      if (opening || result) throw new Error('计划块不能嵌套或重复');
      opening = { start: offset, body: offset + raw.length };
    } else if (/^<\/proposed_plan>[ \t]*$/.test(line)) {
      if (!opening || result) throw new Error('计划存在多余结束标签');
      const markdown = text.slice(opening.body, offset).replace(/\r?\n$/, '').replaceAll('\r\n', '\n');
      validateMarkdown(markdown);
      result = { markdown, start: opening.start, end: offset + line.length };
      opening = undefined;
    } else if (line.includes('<proposed_plan>') || line.includes('</proposed_plan>')) {
      throw new Error('计划标签必须独占一行');
    }
    offset += raw.length;
  }
  if (opening) throw new Error('计划块不完整');
  return result;
}
export const extractProposedPlan = (text: string): string | undefined => parsePlan(text)?.markdown;
