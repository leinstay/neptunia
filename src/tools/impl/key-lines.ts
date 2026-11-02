// The key lines of the owner's `keys.base` field: which key each role with a key list runs on (`keyStateLines`), and what is
// left of each core key's grant (`keyGrantLines`, balances from src/llm/key-grants.ts). Names and figures, never a key.
// The sources are read as unknown: a client or accumulator that lacks a reader gives no line.

import { fill } from '../../format.ts';
import { coreKeyBalances } from '../../llm/key-grants.ts';
import type { KeyBalance } from '../../llm/key-grants.ts';
import { utcMinute } from '../../time.ts';
import { isObj, objOf } from '../types.ts';
import type { Obj } from '../types.ts';
import { keyStateLines } from './usage.ts';

/** `labels.status.costs` as a plain record of words, or null when the labels hold none. */
function costsWords(labels: unknown): Obj | null {
  const costs = objOf(objOf(labels).status).costs;
  return isObj(costs) ? costs : null;
}

/** A label filled, or null when it is missing. */
function line(template: unknown, values: Record<string, string>): string | null {
  return typeof template === 'string' && template ? fill(template, values) : null;
}

/**
 * The lines of the core keys' grants (`llm.keys`): per key `keyGrant` (`{key}`, `{left}`, `{grant}` in dollars to two
 * decimals, `{day}` the reset day) or, for a key with no grant, `keyUnconfigured` (`{key}`). [] without the labels. Pure.
 */
export function keyGrantLines({ rows, labels }: { rows: ReadonlyArray<KeyBalance>; labels: unknown }): Array<string> {
  const words = costsWords(labels);
  if (!words) return [];
  const lines = rows.map((row) =>
    row.left === null || row.grant === null || row.resetDay === null
      ? line(words.keyUnconfigured, { key: row.name })
      : line(words.keyGrant, {
          key: row.name,
          left: row.left.toFixed(2),
          grant: row.grant.toFixed(2),
          day: String(row.resetDay),
        })
  );
  return lines.filter((text): text is string => text !== null);
}

type KeyStates = { keyStates?: () => Array<{ role: string; key: string; switchedAt: number | null }> };

/** `lines` and then the state lines of `llm.keyStates()` and the grant lines of the core keys, as the field's text. */
export function withKeyLines(lines: ReadonlyArray<string>, sources: KeySources): string {
  return [...lines, ...keyStateAndGrantLines(sources)].join('\n');
}

type KeySources = { llm: unknown; usage: unknown; hot: unknown; config: unknown; now: number };

function keyStateAndGrantLines({ llm, usage, hot, config, now }: KeySources): Array<string> {
  const labels = (hot as { prompts?: { labels?: unknown } } | null)?.prompts?.labels;
  const states = (llm as KeyStates | null)?.keyStates?.() ?? [];
  const rows = coreKeyBalances({ llm, usage, config, now });
  return [...keyStateLines({ states, labels, when: utcMinute }), ...keyGrantLines({ labels, rows })];
}
