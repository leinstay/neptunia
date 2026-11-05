// Recall in a direct chat with no community and an opaque partner: stored recall runs by the issued context, and its search
// reaches the person's DMs and nobody else's. Over the real database search and a service-issued context.
// Contract, plan 2026-11-04-cli-and-memory task 5: `hasRecallContext({ channel, partnerId, memoryContext })` has no `guildId`.
// Appendix entries: src/behavior/recall-reads.ts, src/behavior/recall-run.ts, src/behavior/recall-run-types.ts,
// src/behavior/recall.ts, src/turn/phases/request/lookup.ts, src/turn/pulls.ts.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { hasRecallContext } from '../src/behavior/recall-reads.ts';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { search } from '../src/memory/db/recall.ts';
import { createMemoryDb } from '../src/memory/db/service.ts';
import type { MemoryDbService } from '../src/memory/db/service.ts';
import { dbOf } from '../src/memory/db/types.ts';
import type { Db } from '../src/memory/db/types.ts';
import { wrongly } from './fixtures/loose-types.ts';
import { ANNA, BORIS_PLACE, seedOpaqueWorld } from './fixtures/memory-db/opaque-people.ts';
import { tempDir } from './fixtures/tmp.ts';

const NOW = Date.parse('2026-11-05T12:00:00.000Z');
const opened: Array<MemoryDbService> = [];
after(async () => {
  for (const service of opened) await service.close();
});

function line(db: Db, id: string, place: string, text: string): void {
  db.prepare(
    `INSERT INTO sources (id, kind, iface, native_id, revision, place_id, occurred_at, recorded_at, text, direct, scope_kind, audience_id)
     VALUES (?, 'seen', (SELECT iface FROM places WHERE id = ?), ?, 1, ?, ?, ?, ?, 0, 'dm', ?)`
  ).run(
    id,
    place,
    id,
    place,
    new Date(NOW - 86400000).toISOString(),
    new Date(NOW).toISOString(),
    text,
    `aud:dm:${place}`
  );
}

function serviceOver(): MemoryDbService {
  const dataDir = tempDir('nep-recall-opaque-');
  const seed = openMemoryDb(path.join(dataDir, 'memory.db'));
  const db = dbOf(seed);
  seedOpaqueWorld(db);
  line(db, 'src:far', 'place:dm-a21', 'the synthetic beekeeping plan on the other interface');
  line(db, 'src:his', BORIS_PLACE, 'the synthetic beekeeping plan of a stranger');
  seed.close();
  const service = createMemoryDb({
    hot: { config: { memoryDb: { session: { mode: 'off' } } } },
    dataDir,
    log: { info() {}, debug() {}, warn() {}, error() {} },
    worker: false,
  });
  service.tick();
  opened.push(service);
  return service;
}

const searchIn = (service: MemoryDbService) => {
  const ctx = service.issueContext({ kind: 'dm', iface: 'discord', person: ANNA, place: 'place:dm-a11' });
  return search(dbOf(wrongly<Parameters<typeof dbOf>[0]>(service.readHandle())), {
    ctx,
    plan: { forms: ['beekeeping'], who: [], from: null, to: null },
    now: NOW,
  });
};

test('a DM with a partner has a recall context with no community', () => {
  // Bug: `Boolean(guildId && ...)` turns recall off in every DM that has no community.
  assert.equal(
    hasRecallContext({
      channel: { id: 'd1', kind: 'dm', communityId: null },
      partnerId: 'u1',
      memoryContext: null,
    }),
    true
  );
});

test('a private chat with no partner still has none', () => {
  // Bug: removing the community check opens stored recall to a conversation nobody can be authorized for.
  assert.equal(
    hasRecallContext({ channel: { id: 'd1', kind: 'dm', communityId: null }, partnerId: null, memoryContext: null }),
    false
  );
});

test('the search of an opaque person finds what they said in a linked DM on another interface', () => {
  // Bug: the context carries no linked places, so recall in one DM forgets the same person's other DM.
  const found = searchIn(serviceOver());
  const texts = JSON.stringify(found.hits);
  assert.ok(texts.includes('src:far'), texts);
});

test('the search of an opaque person never finds the DM of another person', () => {
  // Bug: widening by a native id or by subject reads a stranger's conversation.
  const found = searchIn(serviceOver());
  assert.equal(JSON.stringify([found.hits, found.windows]).includes('src:his'), false);
});
