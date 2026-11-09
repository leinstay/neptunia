// The key lines of the owner's `keys.base` field: which key each role with a key list runs on (`keyStateLines`). Names,
// never a key. The client is read as unknown: one that lacks the reader gives no line.

import { utcMinute } from '../../time.ts';
import { keyStateLines } from './usage.ts';

type KeyStates = { keyStates?: () => Array<{ role: string; key: string; switchedAt: number | null }> };

type KeySources = { llm: unknown; hot: unknown };

/** `lines` and then the state lines of `llm.keyStates()`, as the field's text. */
export function withKeyLines(lines: ReadonlyArray<string>, { llm, hot }: KeySources): string {
  const labels = (hot as { prompts?: { labels?: unknown } } | null)?.prompts?.labels;
  const states = (llm as KeyStates | null)?.keyStates?.() ?? [];
  return [...lines, ...keyStateLines({ states, labels, when: utcMinute })].join('\n');
}
