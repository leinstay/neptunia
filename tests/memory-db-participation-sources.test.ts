// Participation and session evidence retain the observed source across qualified record adoption and later edits.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRecord } from '../src/memory/record.ts';
import { observationOf } from '../src/memory/db/observe-event.ts';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { resolveParticipationSources } from '../src/memory/db/participation-sources.ts';
import { dbOf } from '../src/memory/db/types.ts';
import type { Rows } from '../src/memory/db/types.ts';
import {
  batchOf,
  buildSessionRequest,
  parseSessionAnswer,
  resolveSessionReads,
  scopesOf,
  validateAnswer,
} from '../src/memory/db/session.ts';
import type { ParticipationState } from '../src/memory/participation.ts';
import { openTestMemory } from './fixtures/memory-db/service.ts';
import { baseConfig, memoryBlock, prompts } from './fixtures/memory-db/session-rig.ts';
import { writeUnitUpdate } from './fixtures/memory-db/unit-writes.ts';

const NOW = Date.parse('2026-10-24T12:00:00Z');
const AT = NOW - 60 * 60_000;
const NATIVE = 'same-evidence-message';
const locator = (room: string) => ({ iface: 'discord', chatId: room, messageId: NATIVE });

function envelope(room: string, text: string, edit = false) {
  const value = observationOf({
    iface: 'discord',
    at: NOW,
    edit,
    chat: { id: room, kind: 'channel', chatType: 'channel', rootId: 'root' },
    message: { id: NATIVE, at: AT, content: text, author: { id: 'member', name: 'Member' } },
  });
  if (!value) throw new Error('synthetic normalized message was refused');
  return value;
}

function sourceId(result: object | null): string {
  if (!result || !('sourceId' in result) || typeof result.sourceId !== 'string') {
    throw new Error('normalized observation returned no source');
  }
  return result.sourceId;
}

async function evidence() {
  const memory = await openTestMemory({ now: () => NOW });
  const record = createRecord({ ...memory, now: () => NOW });
  const original = sourceId(await memory.memoryDb.observeMessage(envelope('room-a', 'Original batch evidence')));
  const foreign = sourceId(await memory.memoryDb.observeMessage(envelope('room-b', 'Foreign collision evidence')));
  const db = memory.memoryDb.database();
  if (!db) throw new Error('the synthetic memory database is unavailable');
  return {
    ...memory,
    db,
    original,
    foreign,
    async edit() {
      const edited = sourceId(
        await memory.memoryDb.observeMessage(envelope('room-a', 'Edited canonical evidence', true))
      );
      const line = {
        v: 1,
        id: 'edited-record-line',
        kind: 'seen',
        messageId: NATIVE,
        revision: 2,
        occurredAt: new Date(AT).toISOString(),
        recordedAt: new Date(NOW).toISOString(),
        placeId: 'root',
        scope: { channel: 'room-a' },
        by: 'member',
        text: 'Edited canonical evidence',
        origin: 'live',
      };
      await record.append('root', [line], {
        messages: [{ lineId: line.id, locator: locator('room-a'), observedSourceId: edited }],
      });
      return edited;
    },
  };
}

test('participation links the edited chat source after observation and record adoption', async () => {
  const env = await evidence();
  try {
    const edited = await env.edit();
    const state: ParticipationState = {
      nextId: 2,
      episodes: [
        {
          id: 'p1',
          itemId: 'episode-exact-source',
          placeId: 'room-a',
          startAt: AT,
          lastAt: AT,
          lastOwnAt: null,
          continues: null,
          messages: [
            {
              id: NATIVE,
              ts: AT,
              authorId: 'member',
              name: 'Member',
              self: false,
              text: 'Edited canonical evidence',
              replyTo: null,
              caption: null,
            },
          ],
        },
      ],
    };
    await writeUnitUpdate(env.memoryDb, { op: 'value', owner: 'guilds/root/participation.json', value: state });
    const links = env.db
      .prepare('SELECT source_id FROM episode_sources WHERE episode_id = ? ORDER BY position')
      .all('episode-exact-source')
      .map((row) => row.source_id);
    assert.deepEqual(links, [edited]);
    assert.equal(links.includes(env.foreign), false);
    assert.equal(links.includes(`src:discord:${NATIVE}`), false);
  } finally {
    await env.close();
  }
});

test('a session answer cites the exact source its batch read before a later observed and recorded edit', async () => {
  const env = await evidence();
  try {
    const scope = scopesOf(env.db).find((entry) => entry.key === 'group:discord');
    if (!scope) throw new Error('the normalized sources have no group session scope');
    const batch = batchOf(env.db, scope.scope, { cursor: 0, since: null, maxMessages: 20, settleBefore: NOW });
    const request = buildSessionRequest({
      db: env.db,
      scope,
      batch,
      config: baseConfig(),
      prompts,
      selfName: 'Synthetic persona',
      now: NOW,
    });
    const sourceHandle = [...request.maps.sources].find(([, id]) => id === env.original)?.[0];
    const placeId = env.db.prepare('SELECT place_id FROM sources WHERE id = ?').get(env.original)?.place_id;
    const placeHandle = [...request.maps.places].find(([, id]) => id === placeId)?.[0];
    if (!sourceHandle || !placeHandle) throw new Error('the batch omitted its actual source or place');
    const edited = await env.edit();
    const reads = resolveSessionReads(env.db, request, 'discord');
    assert.deepEqual(
      reads.filter((row) => row.row_kind === 'sources' && row.row_id === env.original).map((row) => row.revision),
      [1]
    );
    const answer = parseSessionAnswer(
      memoryBlock({
        claims: [
          {
            op: 'add',
            subject: 'place',
            place: placeHandle,
            kind: 'injoke',
            text: 'Batch evidence claim',
            how: 'saw',
            sources: [sourceHandle],
          },
        ],
      })
    );
    if (!answer.ok) throw new Error('the synthetic session answer was refused');
    const { plan, counts } = validateAnswer(answer.value, { maps: request.maps, people: request.people });
    assert.equal(counts.kept, 1);
    assert.deepEqual(plan.claims[0]?.sources, [env.original]);
    await env.memoryDb.memoryWrite({
      kind: 'session',
      mode: 'apply',
      now: NOW,
      maxDelta: 15,
      run: {
        id: 'run:exact-batch-source',
        scopeKey: scope.key,
        scope: scope.scope,
        batchKey: 'apply|exact-batch-source',
        startedAt: new Date(NOW).toISOString(),
        finishedAt: new Date(NOW).toISOString(),
        outcome: 'ok',
        counts: {},
        errors: [],
      },
      plan,
    });
    const links = env.db
      .prepare(
        'SELECT cs.source_id FROM claim_sources cs JOIN claims c ON c.id = cs.claim_id WHERE c.text = ? ORDER BY cs.position'
      )
      .all('Batch evidence claim')
      .map((row) => row.source_id);
    assert.deepEqual(links, [env.original]);
    assert.equal(links.includes(edited), false);
    assert.equal(links.includes(env.foreign), false);
  } finally {
    await env.close();
  }
});

test('an unchanged participation flush retains its captured source after a later observed and recorded edit', async () => {
  const env = await evidence();
  try {
    const state: ParticipationState = {
      nextId: 2,
      episodes: [
        {
          id: 'p1',
          itemId: 'episode-preserved-source',
          placeId: 'room-a',
          startAt: AT,
          lastAt: AT,
          lastOwnAt: null,
          continues: null,
          messages: [
            {
              id: NATIVE,
              ts: AT,
              authorId: 'member',
              name: 'Member',
              self: false,
              text: 'Original batch evidence',
              replyTo: null,
              caption: null,
            },
          ],
        },
      ],
    };
    const links = () =>
      env.db
        .prepare('SELECT source_id FROM episode_sources WHERE episode_id = ? ORDER BY position')
        .all('episode-preserved-source')
        .map((row) => row.source_id);
    const write = () =>
      writeUnitUpdate(env.memoryDb, { op: 'value', owner: 'guilds/root/participation.json', value: state });
    await write();
    const captured = links();
    const edited = await env.edit();
    await write();
    const restored = links();
    const stored = env.db
      .prepare("SELECT json_extract(extra, '$.messages[0].text') AS text FROM episodes WHERE id = ?")
      .get('episode-preserved-source');
    assert.equal(stored?.text, 'Original batch evidence');
    assert.deepEqual(restored, captured);
    assert.deepEqual(restored, [env.original]);
    assert.equal(restored.includes(edited), false);
    assert.equal(restored.includes(env.foreign), false);
  } finally {
    await env.close();
  }
});

test('evidence in a room stored under an opaque id resolves by the room row, not by the text of its id', () => {
  // Bug: the interface was cut out of the place id, so an episode in a room stored as `place:...` linked no source.
  const handle = openMemoryDb(':memory:');
  try {
    const db = dbOf(handle);
    db.exec(`INSERT INTO places (id, iface, kind, native_id, chat, scope_kind)
        VALUES ('place:opaque-room', 'fake', 'channel', 'c3', 'group', 'group');
      INSERT INTO sources (id, kind, iface, native_id, native_kind, generation, revision, place_id, occurred_at, text,
          scope_kind, scope_iface)
        VALUES ('source:opaque-line', 'seen', 'fake', 'm-9', 'message', 1, 1, 'place:opaque-room',
          '2026-10-24T11:00:00.000Z', 'ναι', 'group', 'fake');`);
    // A link names its message by its position in the episode's messages, as the participation writer stores them; its
    // reference is not read, so one that spells nothing resolves the same.
    const mapping: Rows = {
      episodes: [
        {
          id: 'episode-opaque',
          kind: 'participation',
          place_id: 'place:opaque-room',
          extra: JSON.stringify({ messages: [{ id: 'm-9' }] }),
        },
      ],
      episode_sources: [{ episode_id: 'episode-opaque', source_id: 'reference:unread', position: 0 }],
    };
    resolveParticipationSources(db, mapping);
    const [link] = mapping.episode_sources ?? [];
    assert.equal(link?.source_id, 'source:opaque-line');
  } finally {
    handle.close();
  }
});
