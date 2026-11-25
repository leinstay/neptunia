import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openTestMemory } from '../../../fixtures/memory-db/service.ts';
import { storageContext } from '../../../../src/memory/db/storage-context.ts';
import { lineHolderOf } from '../../../../src/memory/db/line-holder.ts';
import { journalLineOf, journalRows } from '../../../../src/memory/db/journal-lines.ts';
import { personOfAccount } from '../../../../src/memory/db/meta-person.ts';
import { observe, OBSERVATION_VERSION } from '../../../../src/memory/db/observe.ts';
import { openMemoryDb } from '../../../../src/memory/db/open.ts';
import { dmAudienceId } from '../../../../src/memory/db/scope.ts';
import { placeCollection } from '../../../../src/memory/db/unit-keys.ts';
import { resolveRow } from '../../../../src/memory/db/rows.ts';
import { dbOf } from '../../../../src/memory/db/types.ts';
import type { Db, MemoryHandle, Row, Rows } from '../../../../src/memory/db/types.ts';
import { addAccount } from '../../../fixtures/memory-db/opaque-people.ts';

const NOW = Date.parse('2026-11-09T10:00:00.000Z');
const ROOT = 'synthetic:root:1';

type Memory = Awaited<ReturnType<typeof openTestMemory>>;

async function fresh(): Promise<Memory> {
  return openTestMemory({ now: () => NOW, iface: () => 'synthetic' });
}

test('a write whose lines are not a list is refused with a code', async () => {
  const memoryDb = (await fresh()).memoryDb;
  try {
    await assert.rejects(memoryDb.writeJournalLines({ placeId: ROOT, lines: 'none' as never }), {
      code: 'JOURNAL_LINES_LINES',
    });
  } finally {
    await memoryDb.close();
  }
});

const AT = '2026-11-08T10:00:00.000Z';
const SCOPE_NOW = Date.parse('2026-11-08T12:00:00.000Z');
const UUID_PERSON = /^person:[0-9a-f]{8}-[0-9a-f]{4}-/;
const META = 'person:00000000-0000-4000-8000-000000000001';
const quiet = { info() {}, debug() {}, warn() {}, error() {} };
const OPTS = { now: () => SCOPE_NOW, log: quiet };
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

/** A journal line of a group's day with the persona's answer in a member's direct chat, as an old release logged it. */
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
  const key = placeCollection('journal', 'discord:channel:c1', { partition: '2026-11-08' });
  // The interface of the write names the place's, since no row holds it.
  const ctx = storageContext(db, key, 'discord');
  // A journal day's key always names its owner columns (line-holder.ts#lineHolderOf).
  const holder = lineHolderOf(key)!;
  return {
    toRows: (_rel: string, line: Row, { position }: { position: number }) =>
      journalRows(line, ctx, { line: holder, position }),
    fromRows: (rows: Rows) => journalLineOf(rows, ctx),
  };
};

function withDb(body: (db: Db, handle: MemoryHandle) => void): void {
  const handle = openMemoryDb(':memory:');
  try {
    body(dbOf(handle), handle);
  } finally {
    handle.close();
  }
}

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
