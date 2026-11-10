// Tests for the record and the journal scripts/replay.ts hands the inner life in `--inner`: the inner life reads
// them as the persona's (`record.iterate(query)`, `journal.read(query)`), so the replay must wrap the place stores as
// src/core.ts does (personaRecord, personaJournal over the served places), not pass the place stores raw.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { innerSourcesOf } from '../scripts/replay.ts';
import { createJournal } from '../src/memory/journal.ts';
import { createRecord, toRecordLine } from '../src/memory/record.ts';
import { legacyServerPlaceId } from './fixtures/memory-db/legacy-paths.ts';
import { openTestMemory } from './fixtures/memory-db/service.ts';

const quiet = { info() {}, warn() {}, error() {} };
const NOW = Date.UTC(2026, 10, 6, 6, 0, 0);
const SAID_AT = Date.UTC(2026, 10, 5, 23, 1, 0);
const PLACE = legacyServerPlaceId('discord', 'g1');

async function scene() {
  const mem = await openTestMemory();
  const record = createRecord({ dataDir: mem.dataDir, log: quiet, now: () => NOW, memoryDb: mem.memoryDb });
  const journal = createJournal({ dataDir: mem.dataDir, memoryDb: mem.memoryDb, now: () => NOW, log: quiet });
  const done = async () => {
    await mem.close();
    fs.rmSync(mem.dataDir, { recursive: true, force: true });
  };
  return { record, journal, done };
}

const said = toRecordLine(
  {
    id: 'm1',
    placeId: 'c1',
    channelName: 'general',
    authorId: 'self1',
    authorName: 'Her',
    self: true,
    bot: false,
    content: 'hello',
    ts: SAID_AT,
    replyToId: null,
    attachments: [],
    links: [],
    stickers: [],
    emojis: [],
    direct: false,
  },
  { kind: 'said', turnId: 't-1', opId: 'op-1', now: () => NOW, uuid: () => 'u-1' }
) as never;

test('the record handed to the inner life reads a served place by a query alone, as the core does', async () => {
  // Bug: the raw place record took the query as the place id, so every inner read died with BAD_COLLECTION_ID.
  const { record, journal, done } = await scene();
  try {
    await record.append(PLACE, [said]);
    const sources = innerSourcesOf({
      record,
      journal,
      store: { rootPlaceOf: (id: string) => id },
      places: () => [PLACE],
      hide: { any: false, channels: new Set(), messages: new Set() },
    });
    const ids: Array<unknown> = [];
    for await (const line of sources.record.iterate({ from: new Date(NOW - 86_400_000).toISOString() }))
      ids.push((line as { messageId?: unknown; id?: unknown }).messageId ?? (line as { id?: unknown }).id);
    assert.deepEqual(ids, ['m1']);
  } finally {
    await done();
  }
});

test('the journal handed to the inner life reads by a query alone, as the core does', async () => {
  // Bug: the raw journal took the query as the place id, so the heartbeat view read nothing.
  const { record, journal, done } = await scene();
  try {
    const sources = innerSourcesOf({
      record,
      journal,
      store: { rootPlaceOf: (id: string) => id },
      places: () => [PLACE],
      hide: { any: false, channels: new Set(), messages: new Set() },
    });
    // The lead: the persona journal's read takes a day, as its type says.
    assert.deepEqual(await sources.journal.read({ day: '2026-11-06', n: 5 }), []);
  } finally {
    await done();
  }
});
