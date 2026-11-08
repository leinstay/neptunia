// Recall in a direct chat with no root and an opaque partner: stored recall runs by the issued context, and its search
// reaches the person's DMs and nobody else's. Over the real database search and a service-issued context.
// Contract, plan 2026-11-04-cli-and-memory task 5: `hasRecallContext({ channel, partnerId, memoryContext })` has no `rootId`.
// Appendix entries: src/behavior/recall-reads.ts, src/behavior/recall-run.ts, src/behavior/recall-run-types.ts,
// src/behavior/recall.ts, src/turn/phases/request/lookup.ts, src/turn/pulls.ts.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { hasRecallContext } from '../src/behavior/recall-reads.ts';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { dbSettings, search } from '../src/memory/db/recall.ts';
import { createMemoryDb } from '../src/memory/db/service.ts';
import type { MemoryDbService } from '../src/memory/db/service.ts';
import { fillStems } from '../src/memory/db/stems.ts';
import { dbOf } from '../src/memory/db/types.ts';
import type { Db } from '../src/memory/db/types.ts';
import { wrongly } from './fixtures/loose-types.ts';
import { ANNA, BORIS_PLACE, GROUP_PLACE, seedOpaqueWorld } from './fixtures/memory-db/opaque-people.ts';
import { tempDir } from './fixtures/tmp.ts';

const NOW = Date.parse('2026-11-05T12:00:00.000Z');
const opened: Array<MemoryDbService> = [];
after(async () => {
  for (const service of opened) await service.close();
});

function line(
  db: Db,
  id: string,
  place: string,
  text: string,
  scope = 'dm',
  audience = `aud:dm:${place}`,
  ago = 1
): void {
  db.prepare(
    `INSERT INTO sources (id, kind, iface, native_id, revision, place_id, occurred_at, recorded_at, text, direct, scope_kind, audience_id)
     VALUES (?, 'seen', (SELECT iface FROM places WHERE id = ?), ?, 1, ?, ?, ?, ?, 0, ?, ?)`
  ).run(
    id,
    place,
    id,
    place,
    new Date(NOW - ago * 86400000).toISOString(),
    new Date(NOW).toISOString(),
    text,
    scope,
    audience
  );
}

/** A group line of a place on `iface`, read by every group context. */
const groupLine = (db: Db, id: string, place: string, text: string, { iface = 'discord', ago = 1 } = {}): void =>
  line(db, id, place, text, 'group', `aud:group:${iface}`, ago);

/** A group place whose native id spells nothing of its place id, with the group audience of its interface. */
function groupPlace(db: Db, id: string, iface: string, native: string): void {
  db.prepare("INSERT OR IGNORE INTO audiences (id, kind, iface) VALUES (?, 'group', ?)").run(
    `aud:group:${iface}`,
    iface
  );
  db.prepare(
    `INSERT INTO places (id, iface, kind, native_id, native_key, authority_id, generation, chat, scope_kind)
     VALUES (?, ?, 'channel', ?, ?, ?, 1, 'group', 'group')`
  ).run(id, iface, native, native, `${iface}/global`);
}

function serviceOver(more: (db: Db) => void = () => {}): MemoryDbService {
  const dataDir = tempDir('nep-recall-opaque-');
  const seed = openMemoryDb(path.join(dataDir, 'memory.db'));
  const db = dbOf(seed);
  seedOpaqueWorld(db);
  line(db, 'src:far', 'place:dm-a21', 'the synthetic beekeeping plan on the other interface');
  line(db, 'src:his', BORIS_PLACE, 'the synthetic beekeeping plan of a stranger');
  more(db);
  fillStems(db);
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

test('a DM with a partner has a recall context with no root', () => {
  // Bug: `Boolean(rootId && ...)` turns recall off in every DM that has no root.
  assert.equal(
    hasRecallContext({
      channel: { id: 'd1', kind: 'dm', rootId: null },
      partnerId: 'u1',
      memoryContext: null,
    }),
    true
  );
});

test('a private chat with no partner still has none', () => {
  // Bug: removing the root check opens stored recall to a chat nobody can be authorized for.
  assert.equal(
    hasRecallContext({ channel: { id: 'd1', kind: 'dm', rootId: null }, partnerId: null, memoryContext: null }),
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
  // Bug: widening by a native id or by subject reads a stranger's chat.
  const found = searchIn(serviceOver());
  assert.equal(JSON.stringify([found.hits, found.windows]).includes('src:his'), false);
});

const orchard = { forms: ['orchard'], who: [], from: null, to: null };
const readOf = (service: MemoryDbService) => dbOf(wrongly<Parameters<typeof dbOf>[0]>(service.readHandle()));
const groupAsking = (service: MemoryDbService) => ({
  ...service.issueContext({ kind: 'group', iface: 'discord', destination: GROUP_PLACE }),
  asker: [ANNA],
});

test('a group read is told when the opaque asker has a better match in their own DM', () => {
  // Bug: the asker's DM audience is spelled from the person id, so an opaque person's DM never gives the hint.
  const service = serviceOver((db) => line(db, 'src:own', 'place:dm-a11', 'the orchard by the river'));
  const found = search(readOf(service), { ctx: groupAsking(service), plan: orchard, now: NOW });
  assert.equal(found.hidden, true);
});

test('a group read is told nothing when the better match is an internal row', () => {
  // Bug: the spelled audience of an opaque asker resolves to the internal audience, so an internal row gives the hint.
  const service = serviceOver((db) =>
    line(db, 'src:inner', GROUP_PLACE, 'the orchard by the river', 'internal', 'aud:internal')
  );
  const found = search(readOf(service), { ctx: groupAsking(service), plan: orchard, now: NOW });
  assert.equal(found.hidden, false);
});

test('a search narrowed to a channel finds that channel by its stored native id', () => {
  // Bug: the place is spelled from the native id, so a channel whose id spells nothing is never found.
  const service = serviceOver((db) => {
    groupPlace(db, 'place:room-2', 'discord', 'n-room-2');
    groupLine(db, 'src:in-room', 'place:room-2', 'the orchard by the river');
    groupLine(db, 'src:elsewhere', GROUP_PLACE, 'the orchard by the river');
  });
  const ctx = service.issueContext({ kind: 'group', iface: 'discord', destination: GROUP_PLACE });
  const found = search(readOf(service), { ctx, plan: { ...orchard, placeId: 'n-room-2' }, now: NOW });
  assert.deepEqual(
    found.hits.map((hit) => hit.id),
    ['src:in-room']
  );
});

test('an equal hit on the interface of the read comes before one on another interface', () => {
  // Bug: the interface is read from the place id's prefix, so two opaque places of different interfaces tie.
  const service = serviceOver((db) => {
    groupPlace(db, 'place:room-2', 'discord', 'n-room-2');
    groupPlace(db, 'place:room-9', 'telegram', 'n-room-9');
    groupLine(db, 'src:near', 'place:room-2', 'the orchard by the river', { ago: 5 });
    groupLine(db, 'src:far-away', 'place:room-9', 'the orchard by the river', { iface: 'telegram' });
  });
  const ctx = service.issueContext({ kind: 'group', iface: 'discord', destination: GROUP_PLACE });
  const found = search(readOf(service), {
    ctx,
    plan: orchard,
    now: NOW,
    settings: { ...dbSettings({})!, gateShare: 0 },
  });
  assert.deepEqual(
    found.hits.map((hit) => hit.id),
    ['src:near', 'src:far-away']
  );
});

test('a DM line of an opaque partner names the native id of the partner account as its chat', () => {
  // Bug: the chat is parsed out of the place id, so a DM place whose id spells nothing names itself.
  const service = serviceOver((db) => {
    // A DM place holds no native id of its own: the chat is its partner's.
    db.prepare("UPDATE places SET native_id = NULL WHERE id = 'place:dm-a11'").run();
    line(db, 'src:own', 'place:dm-a11', 'the orchard by the river');
  });
  const ctx = service.issueContext({ kind: 'dm', iface: 'discord', person: ANNA, place: 'place:dm-a11' });
  const found = search(readOf(service), { ctx, plan: orchard, now: NOW });
  assert.deepEqual(
    found.windows.flatMap((window) => window.messages.map((message) => message.placeId)),
    ['n1']
  );
});
