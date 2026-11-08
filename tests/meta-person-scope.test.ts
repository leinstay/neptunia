// The scope of a direct chat under the meta-person (plan 2026-11-08-meta-person, slice 5 and fault 2): a unit's line
// that names a member's direct chat is scoped to that member's stored direct chat and meta-person, never to an id spelled
// from the interface and the native id, and the unit comes back from its rows exactly. A direct chat reads the private
// layer of its person across every account of that person, the owner's command line included, and no one else's.
// Synthetic ids and text only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { storageMapper } from '../src/memory/db/map/index.ts';
import { personOfAccount } from '../src/memory/db/meta-person.ts';
import { observe, OBSERVATION_VERSION } from '../src/memory/db/observe.ts';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { allowedAudience, dmAudienceId, readContextSpec } from '../src/memory/db/scope.ts';
import { createMemoryDb } from '../src/memory/db/service.ts';
import { applyMemoryWrite } from '../src/memory/db/session-write.ts';
import { journalKey, placeCollection, storageId } from '../src/memory/db/storage-keys.ts';
import { dbOf } from '../src/memory/db/types.ts';
import type { Db, MemoryHandle, Row } from '../src/memory/db/types.ts';
import { tempDir } from './fixtures/tmp.ts';

const AT = '2026-11-08T10:00:00.000Z';
const NOW = Date.parse('2026-11-08T12:00:00.000Z');
const UUID_PERSON = /^person:[0-9a-f]{8}-[0-9a-f]{4}-/;
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

const journalMapper = (db: Db) => {
  const key = journalKey('discord:channel:c1', '2026-11-08');
  return storageMapper(db, key, storageId(key)).mapper;
};

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
    assert.equal(rows.affinity_events?.[0]?.person_id, personOf(db, 'discord:700'));
    assert.deepEqual(mapper.fromRows(rows), line);
  });
});

test("a lesson's teacher is the teacher's meta-person and the place's notes come back exactly", () => {
  // Bug: the teacher of a lesson is spelled `person:discord:<native>` from the mention.
  withDb((db, handle) => {
    seeDm(handle, 'discord', '700');
    const key = placeCollection('place', 'discord:channel:c1');
    const { mapper } = storageMapper(db, key, storageId(key));
    const notes: Row = { learned: [{ id: 'l1', text: 'synthetic lesson', from: '<@700>', weight: 1 }] };
    const rows = mapper.toRows('n', notes, {});
    const lesson = (rows.claims ?? []).find((claim) => claim.kind === 'lesson');
    assert.equal(lesson?.from_person, personOf(db, 'discord:700'));
    assert.deepEqual(mapper.fromRows(rows), notes);
  });
});

test("a read's direct chat context names the person its resolver gives, never a spelled one", () => {
  // Bug: the spec names `person:cli:owner`, which no row holds, for the owner's command line chat.
  const asked: Array<string> = [];
  const spec = readContextSpec('cli', 'discord', 'owner', 'owner', (iface, native) => {
    asked.push(`${iface} ${native}`);
    return 'person:00000000-0000-4000-8000-000000000001';
  });
  assert.deepEqual(asked, ['cli owner']);
  assert.deepEqual(spec, { iface: 'cli', kind: 'dm', person: 'person:00000000-0000-4000-8000-000000000001' });
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
