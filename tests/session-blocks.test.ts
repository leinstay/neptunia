// Two blocks of a memory session's request: what the session's context may read, and nothing beside it. Synthetic content.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { episodeLinesOf, intentionLinesOf } from '../src/memory/db/session-blocks.ts';
import { ALEX, semanticWorld } from './fixtures/memory-db/semantic-world.ts';

const PERSON = { id: ALEX, native: 'n1', name: 'Alex' };
const episode = (world: ReturnType<typeof semanticWorld>, id: string, audience: string, what: string): void => {
  world.db
    .prepare('INSERT INTO episodes (id, subject_id, what, date, audience_id, scope_kind) VALUES (?, ?, ?, ?, ?, ?)')
    .run(id, ALEX, what, '2026-11-01', audience, audience.includes(':dm:') ? 'dm' : 'group');
};

test('a group session sees the public episode under its handle and never a private one', () => {
  // Bug: the session's write about a group rests on what was said in a DM.
  const world = semanticWorld();
  episode(world, 'ep:open', 'aud:group:discord', 'shared a joke');
  episode(world, 'ep:dm', 'aud:dm:place:dm-alex', 'a private worry');
  const episodes = new Map<string, string>();
  const reads: Array<unknown> = [];
  const lines = episodeLinesOf(world.db, world.contexts.group, [PERSON], {
    max: 10,
    cutoffIso: '2030-01-01T00:00:00.000Z',
    episodes,
    read: (_kind, id) => reads.push(id),
  });
  assert.deepEqual(lines, ['[e1] 2026-11-01 Alex: shared a joke']);
  assert.equal(episodes.get('e1'), 'ep:open');
  assert.deepEqual(reads, ['ep:open']);
  world.handle.close();
});

test('nobody on the page reads no episode, and no open intention reads no line', () => {
  // Bug: an empty `IN ()` throws and the session's whole request fails.
  const world = semanticWorld();
  const read = () => {};
  assert.deepEqual(
    episodeLinesOf(world.db, world.contexts.group, [], {
      max: 10,
      cutoffIso: '2030-01-01T00:00:00.000Z',
      episodes: new Map(),
      read,
    }),
    []
  );
  assert.deepEqual(intentionLinesOf(world.db, world.contexts.group, [], [], read), []);
  world.handle.close();
});

test("an open intention about a room stored under an opaque id concerns the batch through the room's native id", () => {
  // Bug: the room's native id was cut out of the text of its place id, which an opaque id does not spell.
  const world = semanticWorld();
  world.db.exec(`INSERT INTO places (id, iface, kind, native_id, chat, scope_kind)
      VALUES ('place:opaque-garden', 'discord', 'channel', 'c-garden', 'group', 'group');
    INSERT INTO intentions (id, record, status, created_ms, archived, audience_id, scope_kind, scope_iface)
      VALUES ('i1', '{"status":"pending","purpose":"water the garden","attend":{"chatId":"c-garden"}}', 'pending', 1, 0,
        'aud:group:discord', 'group', 'discord');`);
  const reads: Array<unknown> = [];
  const lines = intentionLinesOf(world.db, world.contexts.group, [], ['place:opaque-garden'], (_kind, id) =>
    reads.push(id)
  );
  assert.deepEqual([lines, reads], [['pending: water the garden'], ['i1']]);
  world.handle.close();
});
