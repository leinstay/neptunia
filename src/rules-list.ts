// The rules block of a system text: the rules prompt (`prompts/rules.md`) followed by the owner's live rules, one
// `labels.rules.line` each. With no live rule there is no block, so an empty list costs a request nothing.

import { fill } from './format.ts';

/** The rules prompt and one line per rule in `rules`, or nothing while `rules` is empty. */
export function rulesPromptOf(prompt: unknown, rules: ReadonlyArray<{ text: string }>, labels: unknown): string {
  if (rules.length === 0 || typeof prompt !== 'string') return '';
  const line = (labels as { rules?: { line?: string } } | null | undefined)?.rules?.line ?? '';
  return [prompt.trimEnd(), rules.map((rule) => fill(line, { text: rule.text })).join('\n')].join('\n\n');
}
