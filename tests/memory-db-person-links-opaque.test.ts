// src/memory/db/person-links.ts over opaque identities: the DMs a context reads come from stored accounts and places,
// never from the spelling of a person id. Over the real memory service, so a bind or an unbind is seen by the next
// context it issues. Plan 2026-11-04-cli-and-memory task 4.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { allowed, allowedAudience } from '../src/memory/db/scope.ts';
import { createMemoryDb } from '../src/memory/db/service.ts';
import type { MemoryDbService } from '../src/memory/db/service.ts';
import { mergePeople } from '../src/memory/db/session-write.ts';
import { dbOf } from '../src/memory/db/types.ts';
import {
  ANNA,
  BORIS,
  BORIS_PLACE,
  addAccount,
  addDmPlace,
  addPerson,
  seedOpaqueWorld,
} from './fixtures/memory-db/opaque-people.ts';
import { tempDir } from './fixtures/tmp.ts';

const opened: Array<MemoryDbService> = [];
after(async () => {
  for (const service of opened) await service.close();
});

function serviceOver(seed: (handle: ReturnType<typeof openMemoryDb>) => void): MemoryDbService {
  const dataDir = tempDir('nep-links-opaque-');
  const handle = openMemoryDb(path.join(dataDir, 'memory.db'));
  seed(handle);
  handle.close();
  const service = createMemoryDb({
    dataDir,
    hot: { config: { memoryDb: { session: { mode: 'off' } } } },
    log: { info() {}, debug() {}, warn() {}, error() {} },
    worker: false,
  });
  service.tick();
  opened.push(service);
  return service;
}

const worldService = (): MemoryDbService => serviceOver((handle) => seedOpaqueWorld(dbOf(handle)));
const hersIn = (service: MemoryDbService) =>
  service.issueContext({ kind: 'dm', iface: 'discord', person: ANNA, place: 'place:dm-a11' });

test('a context issued for an opaque person carries the actual DM places of every linked account', () => {
  // Bug: `linkedDmScopes` answers nothing for an id that does not start with `person:<iface>:`.
  const ctx = hersIn(worldService());
  assert.deepEqual(ctx.linked?.map((one) => one.place).sort(), ['place:dm-a12', 'place:dm-a21']);
  assert.equal(allowedAudience({ audience_id: 'aud:dm:place:dm-a12' }, ctx), true);
  assert.equal(allowedAudience({ audience_id: 'aud:dm:place:dm-a21' }, ctx), true);
  assert.equal(allowedAudience({ audience_id: `aud:dm:${BORIS_PLACE}` }, ctx), false);
});

test('the scope columns of a linked DM on another interface pass the same context', () => {
  // Bug: the triple check knows only the chat's interface, so the audience and the triple disagree.
  const ctx = hersIn(worldService());
  assert.equal(allowed({ scope_kind: 'dm', scope_iface: 'telegram', scope_dm: ANNA }, ctx), true);
  assert.equal(allowed({ scope_kind: 'dm', scope_iface: 'telegram', scope_dm: BORIS }, ctx), false);
});

test('a context issued after an unbind stops reading that DM, and the one issued before keeps what it was given', async () => {
  // Bug: a revoked link stays readable because the place list comes from a cached person.
  const service = worldService();
  const before = hersIn(service);
  await service.personLink({ op: 'unbind', accountId: 'account:a12' });
  const next = hersIn(service);
  assert.equal(allowedAudience({ audience_id: 'aud:dm:place:dm-a12' }, next), false);
  assert.equal(allowedAudience({ audience_id: 'aud:dm:place:dm-a21' }, next), true);
  assert.equal(allowedAudience({ audience_id: 'aud:dm:place:dm-a12' }, before), true);
});

test('a context issued after a bind reads the DM the link brought', async () => {
  // Bug: a binding reaches only the accounts seen when the person was first read.
  const service = serviceOver((handle) => {
    const db = dbOf(handle);
    seedOpaqueWorld(db);
    addAccount(db, { id: 'account:new', iface: 'matrix', authority: 'matrix/global', native: 'n5', person: null });
    addDmPlace(db, {
      id: 'place:dm-new',
      iface: 'matrix',
      authority: 'matrix/global',
      account: 'account:new',
      person: null,
    });
  });
  assert.equal(allowedAudience({ audience_id: 'aud:dm:place:dm-new' }, hersIn(service)), false);
  await service.personLink({ op: 'bind', accountId: 'account:new', target: { accountId: 'account:a11' } });
  assert.equal(allowedAudience({ audience_id: 'aud:dm:place:dm-new' }, hersIn(service)), true);
});

test('a context of the survivor of an owner merge reads the DMs of the merged person', () => {
  // Bug: `accountLinks` compares `person_id` to the one id it was given and never follows `people_merges`.
  const service = serviceOver((handle) => {
    const db = dbOf(handle);
    seedOpaqueWorld(db);
    addAccount(db, {
      id: 'account:merged',
      iface: 'matrix',
      authority: 'matrix/global',
      native: 'n6',
      person: 'person:merged',
    });
    addDmPlace(db, {
      id: 'place:dm-merged',
      iface: 'matrix',
      authority: 'matrix/global',
      account: 'account:merged',
      person: 'person:merged',
    });
    addPerson(db, 'person:merged');
    mergePeople(handle, 'person:merged', ANNA, { by: 'owner', now: 1000 });
  });
  assert.equal(allowedAudience({ audience_id: 'aud:dm:place:dm-merged' }, hersIn(service)), true);
});

test('a context issued for a person id that was merged away reads as its survivor', () => {
  // Bug: a turn holding the old id gets a context with no linked DMs from the moment of the merge.
  const service = serviceOver((handle) => {
    const db = dbOf(handle);
    seedOpaqueWorld(db);
    addPerson(db, 'person:old');
    mergePeople(handle, 'person:old', ANNA, { by: 'owner', now: 1000 });
  });
  const ctx = service.issueContext({ kind: 'dm', iface: 'discord', person: 'person:old', place: 'place:dm-a11' });
  assert.equal(allowedAudience({ audience_id: 'aud:dm:place:dm-a21' }, ctx), true);
});

test('another person with an equal native id on another interface is not linked', () => {
  // Bug: `telegram n1`, hers, and `discord n1`, also hers, are joined through the number and Boris's `telegram n2` follows `discord n2`.
  const ctx = worldService().issueContext({ kind: 'dm', iface: 'telegram', person: BORIS, place: BORIS_PLACE });
  assert.deepEqual(ctx.linked ?? [], []);
  assert.equal(allowedAudience({ audience_id: 'aud:dm:place:dm-a12' }, ctx), false);
});

test("a context reads the DM of the account its person id spells when it was issued in the person's other DM", () => {
  // Bug: the linked DMs leave out the account whose id the person id spells, not the place the context was issued in.
  const service = serviceOver((handle) => {
    const db = dbOf(handle);
    addAccount(db, {
      id: 'discord:n7',
      iface: 'discord',
      authority: 'discord/global',
      native: 'n7',
      person: 'person:discord:n7',
    });
    addAccount(db, {
      id: 'account:n8',
      iface: 'discord',
      authority: 'discord/global',
      native: 'n8',
      person: 'person:discord:n7',
    });
    for (const [id, account] of [
      ['place:dm-n7', 'discord:n7'],
      ['place:dm-n8', 'account:n8'],
    ] as const)
      addDmPlace(db, { id, iface: 'discord', authority: 'discord/global', account, person: 'person:discord:n7' });
  });
  const ctx = service.issueContext({ kind: 'dm', iface: 'discord', person: 'person:discord:n7', place: 'place:dm-n8' });
  assert.deepEqual(
    ctx.linked?.map((one) => one.place),
    ['place:dm-n7']
  );
});
