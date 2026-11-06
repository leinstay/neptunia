// `/memory selfreflection remove <id>`: the owner's removal of a selfreflection entry, run by the console
// (src/interface/commands/console.ts) over the memory service's `removeSelfreflectionEntry`
// (src/memory/db/selfreflection-remove.ts), deleting on the platform through the console's `port`. Only the `cli`
// principal reaches it, and no operation of hers names it. The answer counts what went by table and says in one line
// what the removal leaves alone; a refusal answers its code. The wording is `labels.selfreflectionRemoval`, and with no
// labels the answer is the bare result as JSON. No text of the entry ever reaches the answer.

import { fill } from '../../format.ts';
import type { DeletePort, EntryRemoval } from '../../memory/db/selfreflection-remove.ts';
import { callMethod, objOf } from '../../tools/types.ts';

type Answer = { text: string; status: string; code?: string };

const COMMAND = '/memory selfreflection remove';

/** `labels.selfreflectionRemoval.<path>` as a string, or null when the label is missing or empty. */
function labelAt(hot: unknown, ...path: ReadonlyArray<string>): string | null {
  let at: unknown = objOf(objOf(objOf(hot).prompts).labels).selfreflectionRemoval;
  for (const key of path) at = objOf(at)[key];
  return typeof at === 'string' && at !== '' ? at : null;
}

/** The answer of a removal that went through: the counts by table, then what it left alone. */
function removedText(hot: unknown, removal: Extract<EntryRemoval, { ok: true }>): string {
  const lead = labelAt(hot, 'removed');
  if (lead === null) return JSON.stringify(removal);
  const row = labelAt(hot, 'row') ?? '{table} {count}';
  const rows = Object.entries(removal.removed)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([table, count]) => fill(row, { table, count }));
  const text = fill(lead, {
    entry: removal.entryId,
    deleted: removal.deleted,
    rows: rows.length > 0 ? rows.join(labelAt(hot, 'rowSeparator') ?? ', ') : (labelAt(hot, 'noRows') ?? '0'),
  });
  const untouched = labelAt(hot, 'untouched');
  return untouched === null ? text : `${text}\n${untouched}`;
}

/** The answer of a refusal: its label, or the command, the code and the platform's code. */
function refusedText(hot: unknown, entryId: string, refusal: Extract<EntryRemoval, { ok: false }>): string {
  const platformCode = 'platformCode' in refusal ? refusal.platformCode : '';
  const label = labelAt(hot, 'refused', refusal.code);
  if (label !== null) return fill(label, { entry: entryId, platformCode });
  return `${COMMAND}: ${refusal.code}${platformCode === '' ? '' : ` (${platformCode})`}`;
}

/** The command's answer, for the owner. */
export async function selfreflectionRemoveCommand(
  { memoryDb, hot, port }: { memoryDb: unknown; hot: unknown; port?: DeletePort | null },
  args: Readonly<Record<string, unknown>>
): Promise<Answer> {
  const entryId = typeof args.id === 'string' ? args.id : '';
  const request = { entryId, by: 'owner', port: port ?? (() => null) };
  // The memory service's method answers the removal's own result (src/memory/db/selfreflection-remove.ts).
  const running = callMethod(memoryDb, 'removeSelfreflectionEntry', request) as Promise<EntryRemoval> | undefined;
  if (running === undefined) return { text: `${COMMAND}: the memory database is closed`, status: 'failed' };
  let removal: EntryRemoval;
  try {
    removal = await running;
  } catch (error) {
    const reason = objOf(error).code;
    return {
      text: `${COMMAND}: the removal failed (${typeof reason === 'string' ? reason : 'error'})`,
      status: 'failed',
    };
  }
  if (removal.ok) return { text: removedText(hot, removal), status: 'ok' };
  const status = removal.code === 'unknown-entry' ? 'invalid' : 'failed';
  return { text: refusedText(hot, entryId, removal), status, code: removal.code };
}
