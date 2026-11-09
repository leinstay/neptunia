// The scope of a direct chat under the meta-person (plan 2026-11-08-meta-person, slice 5 and fault 2): a unit's line
// that names a member's direct chat is scoped to that member's stored direct chat and meta-person, never to an id spelled
// from the interface and the native id, and the unit comes back from its rows exactly. A direct chat reads the private
// layer of its person across every account of that person, the owner's command line included, and no one else's.
// Synthetic ids and text only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { storageContext } from '../src/memory/db/map/index.ts';
import { lineOwnerOf } from '../src/memory/db/line-owner.ts';
import { journalLineOf, journalRows } from '../src/memory/db/journal-lines.ts';
import { archiveRows } from '../src/memory/db/archive-lines.ts';
import { personOfAccount } from '../src/memory/db/meta-person.ts';
import { observe, OBSERVATION_VERSION } from '../src/memory/db/observe.ts';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { allowedAudience, dmAudienceId, dmUserOf, issueContext, readContextSpec } from '../src/memory/db/scope.ts';
import { createMemoryDb } from '../src/memory/db/service.ts';
import { applyMemoryWrite } from '../src/memory/db/session-write.ts';
import { journalKey, placeCollection, storageId } from '../src/memory/db/storage-keys.ts';
import { resolveRow } from '../src/memory/db/rows.ts';
import { unitValue } from '../src/memory/db/readers/common.ts';
import { dbOf } from '../src/memory/db/types.ts';
import type { Db, MemoryHandle, Row, Rows } from '../src/memory/db/types.ts';
import { addAccount } from './fixtures/memory-db/opaque-people.ts';
import { tempDir } from './fixtures/tmp.ts';

const AT = '2026-11-08T10:00:00.000Z';
const NOW = Date.parse('2026-11-08T12:00:00.000Z');
const UUID_PERSON = /^person:[0-9a-f]{8}-[0-9a-f]{4}-/;
const META = 'person:00000000-0000-4000-8000-000000000001';
const quiet = { info() {}, debug() {}, warn() {}, error() {} };
const OPTS = { now: () => NOW, log: quiet };
const AUTHORITY: Record<string, string> = { discord: 'discord/global', telegram: 'telegram/global', cli: 'cli/local' };

/** Observes one direct chat line from `native` on `iface` and answers the place it was stored under. */
function seeDm(handle: MemoryHandle, iface: string, native: string, key = `${native}:1`): string {
  const authority = AUTHORITY[iface] ?? `${iface}/global`;
  const result = observe(
    handle,
    {
      v: OBSERVATION_VERSION,
      iface,
      authority,
      native: { kind: 'message', key, revision: 1 },
      place: { authority, key: `dm:${native}`, kind: 'dm', chat: 'dm', partner: { key: native } },
      author: { kind: 'account', key: native },
      occurredAt: AT,
      observedAt: AT,
      text: `synthetic line ${key}`,
    },
    OPTS
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  return String(result.placeId);
}

const personOf = (db: Db, account: string): string => String(personOfAccount(db, account));

/** A journal line of a group's day with her answer in a member's direct chat, as an old release logged it. */
const answerLine = (native: string): Row => ({
  id: 'j1',
  kind: 'turn',
  occurredAt: AT,
  turnId: 't1',
  scope: { user: native },
  think: 'synthetic think',
  posted: ['m1'],
});

/** A journal line's rows and the line back, in a day unit of a place, as the journal writer and reader build them. */
const journalMapper = (db: Db) => {
  const key = journalKey('discord:channel:c1', '2026-11-08');
  const ctx = storageContext(db, key);
  // A journal day's key always names its owner columns (line-owner.ts#lineOwnerOf).
  const owner = lineOwnerOf(key)!;
  return {
    toRows: (_rel: string, line: Row, { position }: { position: number }) =>
      journalRows(line, ctx, { id: storageId(key), line: owner, position }),
    fromRows: (rows: Rows) => journalLineOf(rows, ctx),
  };
};

/** A place's notes written through their write kind (place-notes.ts): the teacher its lesson names and the notes read back. */
function writtenNotes(handle: MemoryHandle, notes: Row): { teacher: unknown; back: unknown } {
  const placeId = 'discord:channel:c1';
  applyMemoryWrite(handle, { kind: 'place-notes', placeId, value: notes, iface: 'discord', now: Date.parse(AT) });
  const db = dbOf(handle);
  const teacher = db.prepare("SELECT from_person FROM claims WHERE kind = 'lesson'").get()?.from_person;
  const read = unitValue(db, placeCollection('place', placeId));
  return { teacher, back: read.found ? read.value : null };
}

function withDb(body: (db: Db, handle: MemoryHandle) => void): void {
  const handle = openMemoryDb(':memory:');
  try {
    body(dbOf(handle), handle);
  } finally {
    handle.close();
  }
}

test("a unit's line in a member's direct chat carries the member's meta-person and the chat's audience", () => {
  // Bug: the line is scoped to `person:discord:<native>`, a person with no row, beside the member's meta-person.
  withDb((db, handle) => {
    const place = seeDm(handle, 'discord', '700');
    const rows = journalMapper(db).toRows('j', answerLine('700'), { position: 0 });
    const source = rows.sources?.[0];
    assert.match(String(source?.scope_dm), UUID_PERSON);
    assert.equal(source?.scope_dm, personOf(db, 'discord:700'));
    assert.equal(source?.audience_id, dmAudienceId(place));
  });
});

test('a line in a direct chat whose place id names no native id comes back from its rows exactly', () => {
  // Bug: the line's `scope.user` is rebuilt from the person id, which a meta-person no longer spells, and is lost.
  withDb((db, handle) => {
    seeDm(handle, 'discord', '700');
    const mapper = journalMapper(db);
    const line = answerLine('700');
    assert.deepEqual(mapper.fromRows(mapper.toRows('j', line, { position: 0 })), line);
  });
});

test("an attitude toward a member is the member's meta-person's and its line comes back exactly", () => {
  // Bug: the affinity event lands on `person:discord:<native>`, so the meta-person's score never moves.
  withDb((db, handle) => {
    seeDm(handle, 'discord', '700');
    const mapper = journalMapper(db);
    const line: Row = {
      id: 'mem1',
      kind: 'memory',
      occurredAt: AT,
      batchId: 'b1',
      stage: 'attitude',
      scope: { channel: 'c1' },
      attitude: [{ accountId: '700', delta: 2, applied: 1, reason: 'synthetic' }],
    };
    const rows = mapper.toRows('j', line, { position: 0 });
    const [event] = rows.affinity_events ?? [];
    assert.equal(event?.person_id, personOf(db, 'discord:700'));
    assert.deepEqual(mapper.fromRows(rows), line);
  });
});

test("a lesson's teacher is the teacher's meta-person and the place's notes come back exactly", () => {
  // Bug: the teacher of a lesson is spelled `person:discord:<native>` from the mention.
  withDb((db, handle) => {
    seeDm(handle, 'discord', '700');
    const notes: Row = { learned: [{ id: 'l1', text: 'synthetic lesson', from: '<@700>', weight: 1 }] };
    const { teacher, back } = writtenNotes(handle, notes);
    assert.equal(teacher, personOf(db, 'discord:700'));
    assert.deepEqual(back, notes);
  });
});

test("a read's direct chat context names the person its resolver gives, never a spelled one", () => {
  // Bug: the spec names `person:cli:owner`, which no row holds, for the owner's command line chat.
  const asked: Array<string> = [];
  const spec = readContextSpec({
    chatIface: 'cli',
    home: 'discord',
    chatId: 'owner',
    privateAccountId: 'owner',
    personOf: (iface, native) => {
      asked.push(`${iface} ${native}`);
      return 'person:00000000-0000-4000-8000-000000000001';
    },
    dmPlaceOf: () => null,
    chatPlaceOf: () => null,
  });
  assert.deepEqual(asked, ['cli owner']);
  assert.deepEqual(spec, { iface: 'cli', kind: 'dm', person: 'person:00000000-0000-4000-8000-000000000001' });
});

test("a read's direct chat context of a partner no row names reads as the interface's group", () => {
  // Bug: the resolver finds no person, and the spec names none, so issuing the context throws and the turn reads nothing.
  const spec = readContextSpec({
    chatIface: 'discord',
    home: 'discord',
    chatId: 'c1',
    privateAccountId: '700',
    personOf: () => null,
    dmPlaceOf: () => null,
    chatPlaceOf: () => 'place:room',
  });
  assert.deepEqual(spec, { iface: 'discord', kind: 'group', destination: null });
});

test("a read's group context is issued for the place the chat's row holds, never one spelled from the chat id", () => {
  // Bug: the destination was spelled `<iface>:channel:<id>`, a place no row holds when the room's id is opaque.
  const asked: Array<string> = [];
  const spec = readContextSpec({
    chatIface: 'discord',
    home: 'discord',
    chatId: 'c1',
    privateAccountId: null,
    personOf: () => null,
    dmPlaceOf: () => null,
    chatPlaceOf: (iface, native) => {
      asked.push(`${iface} ${native}`);
      return 'place:opaque-room';
    },
  });
  assert.deepEqual(
    [asked, spec],
    [['discord c1'], { iface: 'discord', kind: 'group', destination: 'place:opaque-room' }]
  );
});

/** A service over a database seeded by `seed`, closed after `body`. */
async function withService(
  seed: (handle: MemoryHandle) => void,
  body: (service: ReturnType<typeof createMemoryDb>, db: Db) => void
): Promise<void> {
  const dataDir = tempDir('nep-meta-scope-');
  const seeded = openMemoryDb(path.join(dataDir, 'memory.db'));
  seed(seeded);
  seeded.close();
  const service = createMemoryDb({
    dataDir,
    hot: { config: {} },
    log: { info() {}, warn() {}, error() {} },
    embed: () => Promise.resolve([]),
  });
  await service.open();
  try {
    body(service, service.database() as Db);
  } finally {
    await service.close();
  }
}

const dmContextOf = (
  service: ReturnType<typeof createMemoryDb>,
  db: Db,
  iface: string,
  account: string,
  place: string
) => service.issueContext({ kind: 'dm', iface, person: personOf(db, account), place });

const placeOfAccount = (db: Db, account: string): string =>
  String(db.prepare('SELECT id FROM places WHERE partner_account = ?').get(account)?.id);

test("from the owner's command line chat, his direct chat on another interface is readable", async () => {
  // Bug: his command line chat and his chat on the platform are two audiences, so she cannot read one from the other.
  await withService(
    (handle) => {
      seeDm(handle, 'discord', '900');
      seeDm(handle, 'cli', 'owner');
      applyMemoryWrite(handle, {
        kind: 'person-link',
        op: 'bind',
        accountId: 'cli:owner',
        target: { accountId: 'discord:900' },
        now: NOW,
      });
    },
    (service, db) => {
      const ctx = dmContextOf(service, db, 'cli', 'cli:owner', placeOfAccount(db, 'cli:owner'));
      assert.equal(allowedAudience({ audience_id: dmAudienceId(placeOfAccount(db, 'discord:900')) }, ctx), true);
    }
  );
});

test("another person's direct chat stays closed to a person's direct chat", async () => {
  // Bug: widening the private layer to every account opens the direct chat of someone who is not the same person.
  await withService(
    (handle) => {
      seeDm(handle, 'discord', '900');
      seeDm(handle, 'cli', 'owner');
      seeDm(handle, 'discord', '901');
      applyMemoryWrite(handle, {
        kind: 'person-link',
        op: 'bind',
        accountId: 'cli:owner',
        target: { accountId: 'discord:900' },
        now: NOW,
      });
    },
    (service, db) => {
      const ctx = dmContextOf(service, db, 'cli', 'cli:owner', placeOfAccount(db, 'cli:owner'));
      assert.equal(allowedAudience({ audience_id: dmAudienceId(placeOfAccount(db, 'discord:901')) }, ctx), false);
    }
  );
});

test('a member with two accounts reads their private layer from either account', async () => {
  // Bug: only the owner's accounts share a private layer, so a member bound to two accounts stays two audiences.
  await withService(
    (handle) => {
      seeDm(handle, 'discord', '700');
      seeDm(handle, 'telegram', '800');
      applyMemoryWrite(handle, {
        kind: 'person-link',
        op: 'bind',
        accountId: 'telegram:800',
        target: { accountId: 'discord:700' },
        now: NOW,
      });
    },
    (service, db) => {
      const discordDm = placeOfAccount(db, 'discord:700');
      const telegramDm = placeOfAccount(db, 'telegram:800');
      const fromDiscord = dmContextOf(service, db, 'discord', 'discord:700', discordDm);
      const fromTelegram = dmContextOf(service, db, 'telegram', 'telegram:800', telegramDm);
      assert.equal(allowedAudience({ audience_id: dmAudienceId(telegramDm) }, fromDiscord), true);
      assert.equal(allowedAudience({ audience_id: dmAudienceId(discordDm) }, fromTelegram), true);
    }
  );
});

/** Observes one line from `native` in a group channel, so the member has an account and a meta-person and no direct chat. */
function seeInGroup(handle: MemoryHandle, native: string, key = `g${native}:1`): void {
  const authority = AUTHORITY.discord ?? 'discord/global';
  const result = observe(
    handle,
    {
      v: OBSERVATION_VERSION,
      iface: 'discord',
      authority,
      native: { kind: 'message', key, revision: 1 },
      place: { authority, key: 'channel:c1', kind: 'channel', chat: 'channel' },
      author: { kind: 'account', key: native },
      occurredAt: AT,
      observedAt: AT,
      text: `synthetic line ${key}`,
    },
    OPTS
  );
  assert.equal(result.ok, true, JSON.stringify(result));
}

/** The audience the writer gives a mapped row, `conflict` when it refuses the row's pair. */
const writtenAudience = (db: Db, row: Row | undefined): unknown => {
  const resolved = resolveRow(db, row ?? {});
  return resolved.conflict ? 'conflict' : resolved.audience_id;
};

test('a line naming the direct chat of a member with no stored direct chat is internal, never a spelled person', () => {
  // Bug: with no stored direct chat, `scopeColumns` spells `person:discord:<native>` and the DM place from the native id.
  withDb((db, handle) => {
    seeInGroup(handle, '701');
    const mapper = journalMapper(db);
    const line = answerLine('701');
    const rows = mapper.toRows('j', line, { position: 0 });
    const source = rows.sources?.[0];
    assert.equal(source?.scope_kind, 'internal');
    assert.equal(source?.scope_dm, null);
    assert.equal(writtenAudience(db, source), 'aud:internal');
    assert.deepEqual(mapper.fromRows(rows), line);
  });
});

test('an intention for one member with no stored direct chat is internal, never a spelled person', () => {
  // Bug: `stringScope` falls back to the spelled person when the member has no stored direct chat.
  withDb((db, handle) => {
    seeInGroup(handle, '701');
    // The intentions write stores the row (src/memory/db/intentions-write.ts), which the mapper built before.
    applyMemoryWrite(handle, {
      kind: 'intentions',
      op: 'value',
      intentions: [{ id: 'i1', status: 'open', provenance: { scope: 'dm', participants: ['701'] } }],
    });
    const row = db.prepare('SELECT scope_kind, scope_dm FROM intentions WHERE id = ?').get('i1');
    assert.equal(row?.scope_kind, 'internal');
    assert.equal(row?.scope_dm, null);
  });
});

test("an archived item of a member with no stored direct chat names the member's meta-person and stays internal", () => {
  // Bug: the stub claim of an archived private item spells the member's person in its scope.
  withDb((db, handle) => {
    seeInGroup(handle, '701');
    const key = placeCollection('archive', 'discord:channel:c1', { partition: '2026-11' });
    const entry: Row = { id: 'ar1', kind: 'archive', event: 'expired', itemId: 'c9', scope: { user: '701' } };
    // An archive month's key always names its owner columns (line-owner.ts#lineOwnerOf).
    const owner = { id: storageId(key), line: lineOwnerOf(key)!, position: 0 };
    const [stub] = archiveRows(entry, storageContext(db, key), owner, new Set<string>()).claims ?? [];
    assert.equal(stub?.subject_id, personOf(db, 'discord:701'));
    assert.equal(stub?.scope_kind, 'internal');
  });
});

test("a direct chat whose place names no partner person scopes its lines to its partner account's meta-person", () => {
  // Bug: a stored DM place with no partner person gives its lines `person:discord:<native>`, spelled from the place id.
  withDb((db, handle) => {
    const place = seeDm(handle, 'discord', '700');
    db.prepare('UPDATE places SET partner_person = NULL WHERE id = ?').run(place);
    const mapper = journalMapper(db);
    const rows = mapper.toRows('j', answerLine('700'), { position: 0 });
    const source = rows.sources?.[0];
    assert.equal(source?.scope_dm, personOf(db, 'discord:700'));
    assert.equal(writtenAudience(db, source), dmAudienceId(place));
  });
});

test('a mention of an account no row holds stores no spelled person and comes back exactly', () => {
  // Bug: the teacher of a lesson is spelled `person:discord:<native>` when no stored account holds the mention.
  withDb((_db, handle) => {
    const notes: Row = { learned: [{ id: 'l2', text: 'synthetic lesson', from: '<@999>', weight: 1 }] };
    const { teacher, back } = writtenNotes(handle, notes);
    assert.equal(teacher, null);
    assert.deepEqual(back, notes);
  });
});

test('the partner of a direct chat is read from the stored place its audience names', () => {
  // Bug: the partner is parsed out of the audience id, so a place whose id spells nobody gives back no member.
  const row = { scope_kind: 'dm', scope_iface: 'discord', scope_dm: META, audience_id: dmAudienceId('place:opaque') };
  assert.equal(
    dmUserOf(row, (audienceId) => (audienceId === dmAudienceId('place:opaque') ? '700' : null)),
    '700'
  );
});

test("a read's direct chat context of a meta-person reads the lines of the account's direct chat", () => {
  // Bug: the spec names no place, a meta-person spells none, so the issued context reads nothing private.
  const spec = readContextSpec({
    chatIface: 'discord',
    home: 'discord',
    chatId: 'c1',
    privateAccountId: '700',
    personOf: () => META,
    dmPlaceOf: (iface, native) => `${iface}:dm:${native}`,
    chatPlaceOf: () => null,
  });
  const ctx = issueContext({ ...spec, now: () => NOW });
  assert.equal(allowedAudience({ audience_id: dmAudienceId('discord:dm:700') }, ctx), true);
});

test("a mention names the person of the interface's own account when another authority holds the same platform id", () => {
  // Bug: the platform id is looked up on the interface alone, so an account of another authority that sorts first wins.
  withDb((db) => {
    addAccount(db, {
      id: 'account:other-authority',
      iface: 'discord',
      authority: 'discord/other',
      native: '700',
      person: 'person:elsewhere',
    });
    addAccount(db, { id: 'discord:700', iface: 'discord', authority: 'discord/global', native: '700', person: META });
    const mapper = journalMapper(db);
    const line: Row = {
      id: 'mem2',
      kind: 'memory',
      occurredAt: AT,
      batchId: 'b2',
      stage: 'attitude',
      scope: { channel: 'c1' },
      attitude: [{ accountId: '700', delta: 1, applied: 1, reason: 'synthetic' }],
    };
    const [event] = mapper.toRows('j', line, { position: 0 }).affinity_events ?? [];
    assert.equal(event?.person_id, META);
  });
});
