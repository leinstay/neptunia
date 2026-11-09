// The comparison of a rebuilt first request with the request a live turn archived (`model_requests`), for
// scripts/turn-replay.ts `--compare`. The parts are the system text, the tool names, each tool's schema and every block
// of the user message by tag. A part is equal, or has its two sizes and the character offset of the first difference.
// Nothing here carries a part's content out. `foldRepeats` reads a `<chat>` block with consecutive repeated lines
// folded into one and the `#N` numbers counted again, so a block that differs only by repeats can be shown equal.

/** The request parts compared, as one request holds them. */
export type RequestParts = { system: string; user: string; tools: ReadonlyArray<unknown> };

/** One compared part: equal, or the sizes and the first offset where they differ. */
export type PartRow = {
  part: string;
  equal: boolean;
  rebuilt: number | null;
  archived: number | null;
  offset: number | null;
};

/** The tags of the user message compared, outer before inner. */
export const BLOCK_TAGS = [
  'self',
  'senses',
  'self_facts',
  'surroundings',
  'memory',
  'people',
  'places',
  'lore',
  'recent',
  'found',
  'recall',
  'inner',
  'my_day',
  'intentions',
  'meanwhile',
  'spatial_awareness',
  'chat',
  'task',
] as const;

/** The first block `<tag>` ... `</tag>` of `text`, tags included; null when it has none. */
export function blockOf(text: string, tag: string): string | null {
  const open = new RegExp(`(^|\\n)<${tag}(?:[ >])`).exec(text);
  if (open === null) return null;
  const start = open.index + open[1].length;
  const close = text.indexOf(`</${tag}>`, start);
  return close < 0 ? null : text.slice(start, close + tag.length + 3);
}

/** The offset of the first character where `a` and `b` differ; null when they are equal. */
export function firstDifference(a: string, b: string): number | null {
  if (a === b) return null;
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i += 1) if (a[i] !== b[i]) return i;
  return length;
}

function row(part: string, rebuilt: string | null, archived: string | null): PartRow {
  const equal = rebuilt === archived;
  return {
    part,
    equal,
    rebuilt: rebuilt?.length ?? null,
    archived: archived?.length ?? null,
    offset: equal || rebuilt === null || archived === null ? null : firstDifference(rebuilt, archived),
  };
}

/** A tool's name and schema as a request's `tools` entry holds them. */
function toolOf(entry: unknown): { name: string; schema: string } {
  const fn = (entry as { function?: { name?: unknown } } | null)?.function;
  return { name: typeof fn?.name === 'string' ? fn.name : '?', schema: JSON.stringify(fn ?? entry) };
}

/** The parts of `rebuilt` against `archived`, in the order of the head of this file. */
export function compareRequests(rebuilt: RequestParts, archived: RequestParts): Array<PartRow> {
  const rows: Array<PartRow> = [row('system', rebuilt.system, archived.system)];
  const mine = rebuilt.tools.map(toolOf);
  const theirs = archived.tools.map(toolOf);
  rows.push(row('tools.names', mine.map((one) => one.name).join(','), theirs.map((one) => one.name).join(',')));
  const names = [...new Set([...theirs, ...mine].map((one) => one.name))];
  for (const name of names)
    rows.push(
      row(
        `tool ${name}`,
        mine.find((one) => one.name === name)?.schema ?? null,
        theirs.find((one) => one.name === name)?.schema ?? null
      )
    );
  for (const tag of BLOCK_TAGS) rows.push(row(`<${tag}>`, blockOf(rebuilt.user, tag), blockOf(archived.user, tag)));
  rows.push(row('user', rebuilt.user, archived.user));
  return rows;
}

/** `block` with each line equal to the one before it dropped and the `#N` numbers at the line starts counted again. */
export function foldRepeats(block: string): string {
  const kept: Array<string> = [];
  const numbered = /^(\s*)#(\d+)\b/;
  const bare = (line: string) => line.replace(numbered, '$1#');
  for (const line of block.split('\n')) {
    const previous = kept.at(-1);
    if (previous !== undefined && numbered.test(line) && bare(previous) === bare(line)) continue;
    kept.push(line);
  }
  const renumber = new Map<string, number>();
  return kept
    .map((line) =>
      line.replace(numbered, (_whole, space: string, n: string) => {
        if (!renumber.has(n)) renumber.set(n, renumber.size + 1);
        return `${space}#${renumber.get(n)}`;
      })
    )
    .join('\n');
}

/** The rows as text: one line per part, `equal` or the sizes and the offset. */
export function rowsText(rows: ReadonlyArray<PartRow>): string {
  return rows
    .map((one) =>
      one.equal
        ? `${one.part}: equal${one.rebuilt === null ? ' (absent in both)' : ''}`
        : `${one.part}: rebuilt ${one.rebuilt ?? 'absent'}, archived ${one.archived ?? 'absent'}${
            one.offset === null ? '' : `, first difference at ${one.offset}`
          }`
    )
    .join('\n');
}
