// The owner's removal of a selfreflection entry and the later turns that saw its message (the lead's rehearsal on a copy
// of production, 2026-11-06): a turn's `day` row lists the messages it saw in `extra.seen.messageIds`, besides
// `extra.sourceMessageIds`. The removal takes the removed message out of that list and leaves the row otherwise whole.
// The scene is tests/fixtures/selfreflection-removal.ts. Invented ids and synthetic text only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { insertRows } from '../src/memory/db/rows.ts';
import { HOUR, T0, removalScene } from './fixtures/selfreflection-removal.ts';
import type { RemovalScene } from './fixtures/selfreflection-removal.ts';

const SEEN_EXTRA = (ids: ReadonlyArray<string>) => ({
  seen: { messageIds: ids, parents: ['fake-parent-1'], parts: { filePreviews: [] } },
  sourceMessageIds: ['fake-other-1'],
  mode: 'reply',
  participants: ['someone'],
});

/** A later turn's day row that saw `ids` in the diary channel. */
function laterTurn(rig: RemovalScene, id: string, ids: ReadonlyArray<string>): void {
  const stamp = new Date(T0 + 3 * HOUR).toISOString();
  insertRows(
    rig.db,
    {
      day: [
        {
          id,
          at: stamp,
          what: 'turn',
          outcome: 'spoke',
          place_id: rig.mirror.placeId,
          turn_id: `turn-${id}`,
          extra: JSON.stringify(SEEN_EXTRA(ids)),
          scope_kind: 'group',
          scope_iface: 'fake',
          scope_dm: null,
        },
      ],
    },
    { at: stamp }
  );
}

/** One `day` row, parsed: its columns and its `extra`. */
function dayRow(rig: RemovalScene, id: string): { columns: Record<string, unknown>; extra: unknown } {
  const row = rig.db.prepare('SELECT * FROM day WHERE id = ?').get(id);
  assert.ok(row, `the day row ${id} is there`);
  const { extra, ...columns } = row;
  return { columns, extra: typeof extra === 'string' ? (JSON.parse(extra) as unknown) : null };
}

test("a later turn's day row loses the removed message from seen.messageIds, and no day row names it after", async () => {
  // Bug: only `sourceMessageIds` is cleaned, and the turns that saw the post keep a record that it existed.
  const rig = await removalScene();
  const seeded = await rig.published({ id: 'entry-north-pier', picture: false });
  const [message] = seeded.messageIds;
  assert.ok(message);
  laterTurn(rig, 'day-later-saw', ['fake-other-1', message, 'fake-other-2']);
  const before = dayRow(rig, 'day-later-saw');
  const removal = await rig.remove(seeded.entryId);
  assert.equal(removal.ok, true, JSON.stringify(removal));
  const after = dayRow(rig, 'day-later-saw');
  assert.deepEqual(after.columns, before.columns);
  assert.deepEqual(after.extra, SEEN_EXTRA(['fake-other-1', 'fake-other-2']));
  const naming = rig.db
    .prepare('SELECT id, extra FROM day')
    .all()
    .filter((row) => typeof row.extra === 'string' && row.extra.includes(JSON.stringify(message)))
    .map((row) => String(row.id));
  assert.deepEqual(naming, []);
});
