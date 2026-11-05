// Participation and session evidence retain the observed source across qualified record adoption and later edits.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRecord } from '../src/memory/record.ts';
import { observationOf } from '../src/memory/db/observe-event.ts';
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

const NOW = Date.parse('2026-10-24T12:00:00Z');
const AT = NOW - 60 * 60_000;
const NATIVE = 'same-evidence-message';
const locator = (room: string) => ({ iface: 'discord', conversationId: room, messageId: NATIVE });

function envelope(room: string, text: string, edit = false) {
  const value = observationOf({
    iface: 'discord',
    at: NOW,
    edit,
    conversation: { id: room, kind: 'channel', chatType: 'channel', communityId: 'community' },
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
        placeId: 'community',
        scope: { channel: 'room-a' },
        by: 'member',
        text: 'Edited canonical evidence',
        origin: 'live',
      };
      await record.append('community', [line], {
        messages: [{ lineId: line.id, locator: locator('room-a'), observedSourceId: edited }],
      });
      return edited;
    },
  };
}

test('participation links the edited conversation source after observation and record adoption', async () => {
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
    await env.memoryDb.writeUnit({ op: 'value', owner: 'guilds/community/participation.json', value: state });
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
      env.memoryDb.writeUnit({ op: 'value', owner: 'guilds/community/participation.json', value: state });
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
