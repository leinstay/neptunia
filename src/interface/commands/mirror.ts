// `/mirror`: the owner's commands over the selfreflection's mirrors (src/behavior/mirror-desk.ts). Each handler checks what the
// words say before it changes anything, so a bad value answers `invalid` and writes nothing. A refused answer starts with
// the command as the owner typed it. The text is for the owner alone.

import type { BackfillChange, MirrorDesk, MirrorStatus } from '../../behavior/mirror-desk.ts';

type Answer = { text: string; status: string };

const UNITS: Readonly<Record<string, number>> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** A duration as the owner types it (`90s`, `30m`, `4h`, `1d`) in ms, or null when it is no positive duration. */
export function durationOf(word: string): number | null {
  const found = /^(\d+)([smhd])$/.exec(word);
  const unit = found ? UNITS[found[2] ?? ''] : undefined;
  const count = Number(found?.[1]);
  return unit !== undefined && count > 0 ? count * unit : null;
}

const WHY: Readonly<Record<string, string>> = {
  'unknown-place': 'no known channel has that id; give its interface-qualified place id',
  'ambiguous-place': 'more than one interface has that id; give its interface-qualified place id',
  'unknown-mirror': 'no mirror has that id or place',
  'no-interval': '--backfill true needs --every, such as --every 4h',
  'unknown-entry': 'no selfreflection entry has that id, so nothing was recorded',
  'no-selection': 'name entries with --entries, or a boundary entry with --through; --absent takes --entries alone',
  'not-uncertain': 'that entry has no uncertain send on this mirror, so nothing was queued',
};

const word = (args: Readonly<Record<string, unknown>>, key: string): string | undefined =>
  typeof args[key] === 'string' ? args[key] : undefined;

/** The flags of a backfill: a change, or the reason a value is refused. */
function backfillOf(args: Readonly<Record<string, unknown>>): BackfillChange | undefined | string {
  const backfill = word(args, 'backfill');
  const every = word(args, 'every');
  if (backfill === undefined && every === undefined) return undefined;
  if (backfill !== undefined && backfill !== 'true' && backfill !== 'false')
    return `--backfill is true or false, not "${backfill}"`;
  const intervalMs = every === undefined ? null : durationOf(every);
  if (every !== undefined && intervalMs === null) return `--every is a duration such as 30m or 4h, not "${every}"`;
  return {
    ...(backfill === undefined ? {} : { enabled: backfill === 'true' }),
    ...(intervalMs === null ? {} : { intervalMs }),
  };
}

const when = (ms: number | null): string => (ms === null ? 'never' : new Date(ms).toISOString());

/** The lines of one mirror's status. */
function statusLines(mirror: MirrorStatus): Array<string> {
  const { backfill } = mirror;
  const lines = [
    `${mirror.placeId}: ${mirror.enabled ? 'enabled' : 'disabled'}, interface ${mirror.interfaceConnected ? 'connected' : 'not connected'}, ${mirror.queued} queued`,
  ];
  for (const one of mirror.failed)
    lines.push(`  failed ${one.entryId}: ${one.code ?? 'no code'}${one.retryable ? ' (retries by itself)' : ''}`);
  for (const one of mirror.incomplete) lines.push(`  incomplete ${one.entryId}: ${one.code ?? 'no code'}`);
  for (const one of mirror.uncertain) lines.push(`  uncertain ${one.entryId}: reconcile it, or say --absent`);
  for (const one of mirror.audienceBlocked) lines.push(`  blocked ${one.entryId}: ${one.code} (${one.reason})`);
  for (const one of mirror.deliveredOutsideAudience) lines.push(`  delivered outside its audience ${one.entryId}`);
  if (backfill.enabled || backfill.highWater !== null)
    lines.push(
      `  backfill ${backfill.enabled ? 'on' : 'off'}: every ${backfill.intervalMs ?? '?'} ms, up to ${backfill.highWater ?? 'nothing'}, ${backfill.remaining} left, next ${when(backfill.nextDueAt)}, done ${when(backfill.completedAt)}`
    );
  if (backfill.blocked) lines.push(`  backfill blocked at ${backfill.blocked.entryId}: ${backfill.blocked.code}`);
  return lines;
}

/** What every handler reads: the desk, the words, who asks, and how a refusal or a change is answered. */
type Call = {
  desk: MirrorDesk;
  args: Readonly<Record<string, unknown>>;
  by: string;
  mirror: string;
  refused: (why: string) => Answer;
  changed: (answer: { ok: boolean; code?: string }, done: string) => Answer;
};

function list({ desk }: Call): Answer {
  const mirrors = desk.listMirrors();
  if (mirrors.length === 0) return { text: 'no mirror', status: 'ok' };
  const lines = mirrors.map((one) => `${one.placeId}  ${one.enabled ? 'enabled' : 'disabled'}`);
  return { text: lines.join('\n'), status: 'ok' };
}

function status({ desk }: Call): Answer {
  const mirrors = desk.mirrorStatus();
  return { text: mirrors.length === 0 ? 'no mirror' : mirrors.flatMap(statusLines).join('\n'), status: 'ok' };
}

async function add({ desk, args, by, refused, changed }: Call): Promise<Answer> {
  const backfill = backfillOf(args);
  if (typeof backfill === 'string') return refused(backfill);
  const destination = word(args, 'destination') ?? '';
  const answer = await desk.addMirror({ destination, by, ...(backfill ? { backfill } : {}) });
  return changed(
    answer,
    answer.ok && answer.reused ? `${answer.mirror.placeId}: already a mirror` : `${destination}: added`
  );
}

async function configure({ desk, args, by, mirror, refused, changed }: Call): Promise<Answer> {
  const backfill = backfillOf(args);
  if (typeof backfill === 'string') return refused(backfill);
  const enabled = word(args, 'enabled');
  if (enabled !== undefined && enabled !== 'true' && enabled !== 'false')
    return refused(`--enabled is true or false, not "${enabled}"`);
  if (enabled === undefined && !backfill) return refused('name what changes: --enabled, --backfill or --every');
  const answer = await desk.configureMirror({
    mirror,
    by,
    ...(enabled === undefined ? {} : { enabled: enabled === 'true' }),
    ...(backfill ? { backfill } : {}),
  });
  return changed(answer, `${mirror}: changed`);
}

async function reconcile({ desk, args, by, mirror, refused }: Call): Promise<Answer> {
  const listed = word(args, 'entries');
  const through = word(args, 'through');
  if (args.absent !== undefined && args.absent !== 'true') return refused('--absent takes no value');
  const answer = await desk.reconcileReceipts({
    mirror,
    by,
    ...(through === undefined ? {} : { through }),
    ...(listed === undefined ? {} : { entries: listed.split(',').filter((id) => id !== '') }),
    absent: args.absent === 'true',
  });
  if (!answer.ok) {
    const named = answer.entryId === undefined ? '' : ` (${answer.entryId})`;
    return refused(`${WHY[answer.code] ?? answer.code}${named}`);
  }
  return {
    text:
      args.absent === 'true'
        ? `${mirror}: ${answer.requeued} queued again`
        : `${mirror}: ${answer.recorded} recorded as published, ${answer.kept} already had receipts`,
    status: 'ok',
  };
}

const HANDLERS: Readonly<Record<string, (call: Call) => Answer | Promise<Answer>>> = {
  'mirror.list': list,
  'mirror.status': status,
  'mirror.add': add,
  'mirror.configure': configure,
  'mirror.remove': async ({ desk, by, mirror, changed }) =>
    changed(await desk.removeMirror({ mirror, by }), `${mirror}: removed, its delivery history kept`),
  'mirror.reconcile': reconcile,
};

/** One `/mirror` command for `requester`. */
export async function mirrorCommand(
  desk: MirrorDesk | null | undefined,
  name: string,
  args: Readonly<Record<string, unknown>>,
  requester: { id: string }
): Promise<Answer> {
  if (!desk) return { text: 'the selfreflection publisher is not running', status: 'failed' };
  const typed =
    `/mirror ${name.slice('mirror.'.length)} ${word(args, 'destination') ?? word(args, 'mirror') ?? ''}`.trim();
  const refused = (why: string): Answer => ({ text: `${typed}: ${why}`, status: 'invalid' });
  const handler = HANDLERS[name];
  if (!handler) return refused('no such command; type /help');
  return handler({
    desk,
    args,
    by: requester.id,
    mirror: word(args, 'mirror') ?? '',
    refused,
    changed: (answer, done) =>
      answer.ok ? { text: done, status: 'ok' } : refused(WHY[answer.code ?? ''] ?? answer.code ?? 'refused'),
  });
}
