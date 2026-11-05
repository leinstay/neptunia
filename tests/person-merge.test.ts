// The owner's merge of one person into another (`kind: 'person-merge'` through the one writer, `/memory users merge` from
// his line): everything stored about the person who goes moves to the person who stays, and nothing moves out of the
// conversation it was said in. One `people_merges` row records it, and running it again changes nothing. Real
// temporary databases over the synthetic opaque world.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseRequest } from '../bin/neptunia-request.ts';
import { createConsole } from '../src/interface/commands/console.ts';
import type { ConsoleDeps } from '../src/interface/commands/console.ts';
import { commandLineWords, parseCommandLine } from '../src/interface/commands/table.ts';
import { withIface } from '../src/memory/db/current-iface.ts';
import { reproject } from '../src/memory/db/graph.ts';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { personDetail } from '../src/memory/db/people-read.ts';
import { createOwnerAccounts } from '../src/memory/db/person-links.ts';
import { groupContext } from '../src/memory/db/scope.ts';
import { applyMemoryWrite } from '../src/memory/db/session-write.ts';
import { dbOf } from '../src/memory/db/types.ts';
import type { Db, MemoryHandle, Row } from '../src/memory/db/types.ts';
import { databaseDigest } from './fixtures/memory-db/browser-world.ts';
import {
  ANNA,
  BORIS,
  BORIS_ACCOUNT,
  BORIS_PLACE,
  addAccount,
  addClaim,
  addDmPlace,
  addEpisode,
  seedOpaqueWorld,
} from './fixtures/memory-db/opaque-people.ts';
import { openTestMemory, tempDataDir } from './fixtures/memory-db/service.ts';
import { tempDir } from './fixtures/tmp.ts';

const NOW = Date.parse('2026-11-05T12:00:00Z');
const AT = '2026-11-01T00:00:00.000Z';
const CAROL = 'person:c4r01-synthetic';
const CAROL_PLACE = 'place:dm-c31';

/** The opaque world, with Boris's line and vector in his DM, a group fact about him, and Carol's DM that mentions him. */
function seedWorld(db: Db): void {
  seedOpaqueWorld(db);
  addClaim(db, 'claim:b21-public', BORIS, 'aud:group:discord');
  addEpisode(db, 'episode:b21', BORIS, BORIS_PLACE);
  addAccount(db, { id: 'account:c31', iface: 'telegram', authority: 'telegram/global', native: 'n3', person: CAROL });
  addDmPlace(db, {
    id: CAROL_PLACE,
    iface: 'telegram',
    authority: 'telegram/global',
    account: 'account:c31',
    person: CAROL,
  });
  addClaim(db, 'claim:about-boris-in-carols-dm', BORIS, `aud:dm:${CAROL_PLACE}`);
  db.prepare("UPDATE claims SET from_person = ? WHERE id = 'claim:about-anna-in-his-dm'").run(BORIS);
  db.prepare(
    `INSERT INTO sources (id, kind, iface, place_id, author_account, author_kind, occurred_at, recorded_at, text,
       audience_id, scope_kind, scope_iface, scope_dm)
     VALUES ('source:b21', 'seen', 'telegram', ?, ?, 'account', ?, ?, 'a synthetic line', ?, 'dm', 'telegram', ?)`
  ).run(BORIS_PLACE, BORIS_ACCOUNT, AT, AT, `aud:dm:${BORIS_PLACE}`, BORIS);
  db.prepare(
    `INSERT INTO vectors (source_rowid, item_id, chunk_key, model, dims, context, occurred_at, scope_kind, scope_iface,
       scope_dm, audience_id)
     VALUES ((SELECT rowid FROM sources WHERE id = 'source:b21'), 'source:b21', 'chunk:b21', 'test/embedder', 4, '{}', ?,
       'dm', 'telegram', ?, ?)`
  ).run(AT, BORIS, `aud:dm:${BORIS_PLACE}`);
  db.prepare('UPDATE people SET affinity = 40 WHERE id = ?').run(ANNA);
  db.prepare('UPDATE people SET affinity = 5 WHERE id = ?').run(BORIS);
  for (const person of [ANNA, BORIS])
    db.prepare(
      `INSERT INTO relationship_daily (person_id, day, audience_id, addressed_by_them, addressed_by_her, meaningful)
       VALUES (?, '2026-11-01', 'aud:group:discord', 2, 1, 0)`
    ).run(person);
}

function withWorld(body: (handle: MemoryHandle, db: Db) => void): void {
  const handle = openMemoryDb(join(tempDir('nep-merge-'), 'memory.db'));
  try {
    seedWorld(dbOf(handle));
    body(handle, dbOf(handle));
  } finally {
    handle.close();
  }
}

type Merged = { ok: true; id: string; survivor: string; moved: Record<string, number> };

const merge = (handle: MemoryHandle, from: string, into: string, by = 'owner'): Merged =>
  applyMemoryWrite(handle, { kind: 'person-merge', from, into, by, reason: 'the same person', now: NOW }) as Merged;

/** Where every scoped row sits: its id and its audience, table by table. */
function audiences(db: Db): Record<string, Array<Row>> {
  const read = (sql: string) =>
    db
      .prepare(sql)
      .all()
      .map((row) => ({ ...row }));
  return {
    claims: read('SELECT id, audience_id FROM claims ORDER BY id'),
    episodes: read('SELECT id, audience_id FROM episodes ORDER BY id'),
    descriptions: read('SELECT id, audience_id FROM descriptions ORDER BY id'),
    affinity: read('SELECT id, audience_id FROM affinity_events ORDER BY id'),
    sources: read('SELECT id, audience_id FROM sources ORDER BY id'),
    vectors: read('SELECT chunk_key, audience_id FROM vectors ORDER BY chunk_key'),
  };
}

const about = (db: Db, person: string): Array<string> =>
  [
    ...db.prepare("SELECT id FROM claims WHERE subject_kind = 'person' AND subject_id = ?").all(person),
    ...db.prepare('SELECT id FROM episodes WHERE subject_id = ?').all(person),
    ...db.prepare('SELECT id FROM affinity_events WHERE person_id = ?').all(person),
  ]
    .map((row) => String(row.id))
    .sort();

test('a merge moves what is said about the person, and by them, to the person who stays', () => {
  // Bug: the merge writes its row and moves nothing, so the owner's two people stay two in every read.
  withWorld((handle, db) => {
    const answer = merge(handle, BORIS, ANNA);
    assert.equal(answer.survivor, ANNA);
    assert.deepEqual(about(db, BORIS), []);
    assert.ok(about(db, ANNA).includes('claim:b21'));
    assert.ok(about(db, ANNA).includes('claim:about-boris-in-carols-dm'));
    assert.ok(about(db, ANNA).includes('episode:b21'));
    assert.equal(
      db.prepare("SELECT from_person FROM claims WHERE id = 'claim:about-anna-in-his-dm'").get()?.from_person,
      ANNA
    );
  });
});

test('a merge moves the accounts, their links and the lines they wrote', () => {
  // Bug: the account keeps the old person, so the lines it wrote and its DM still belong to someone who is gone.
  withWorld((handle, db) => {
    merge(handle, BORIS, ANNA);
    assert.equal(db.prepare('SELECT person_id FROM accounts WHERE id = ?').get(BORIS_ACCOUNT)?.person_id, ANNA);
    assert.deepEqual(
      db
        .prepare('SELECT person_id, state FROM account_person_links WHERE account_id = ? AND valid_to_at IS NULL')
        .all(BORIS_ACCOUNT)
        .map((row) => ({ ...row })),
      [{ person_id: ANNA, state: 'verified' }]
    );
    assert.equal(
      db.prepare('SELECT COUNT(*) AS n FROM account_person_links WHERE person_id = ?').get(BORIS)?.n,
      1,
      'the old link stays, closed, as history'
    );
    assert.equal(
      db
        .prepare('SELECT a.person_id FROM sources s JOIN accounts a ON a.id = s.author_account WHERE s.id = ?')
        .get('source:b21')?.person_id,
      ANNA
    );
    assert.equal(
      db.prepare('SELECT author_account FROM sources WHERE id = ?').get('source:b21')?.author_account,
      BORIS_ACCOUNT
    );
    assert.equal(db.prepare('SELECT partner_person FROM places WHERE id = ?').get(BORIS_PLACE)?.partner_person, ANNA);
  });
});

test('a merge moves the person a line and its vector are scoped to', () => {
  // Bug: the DM scope of a line and of its vector still names the person who went, so a recall under the survivor's
  // person misses it.
  withWorld((handle, db) => {
    merge(handle, BORIS, ANNA);
    assert.equal(db.prepare("SELECT scope_dm FROM sources WHERE id = 'source:b21'").get()?.scope_dm, ANNA);
    assert.equal(db.prepare("SELECT scope_dm FROM vectors WHERE chunk_key = 'chunk:b21'").get()?.scope_dm, ANNA);
  });
});

test('a merge widens no audience: every row stays in the conversation it came from', () => {
  // Bug: the merge rewrites an audience with the person, and a private fact of one DM shows in a group or another DM.
  withWorld((handle, db) => {
    const before = audiences(db);
    merge(handle, BORIS, ANNA);
    assert.deepEqual(audiences(db), before);
    const inGroup = personDetail(db, ANNA, groupContext('discord'));
    assert.ok(inGroup.found);
    assert.deepEqual(
      inGroup.records.map((record) => record.audienceId).filter((one) => one !== 'aud:group:discord'),
      []
    );
  });
});

test('the relationship of the two adds up, and the score of the one who stays is kept', () => {
  // Bug: a day both of them spoke to her breaks the merge on its primary key, or the score of the one who went wins.
  withWorld((handle, db) => {
    merge(handle, BORIS, ANNA);
    assert.deepEqual(
      db
        .prepare('SELECT person_id, addressed_by_them, addressed_by_her FROM relationship_daily ORDER BY person_id')
        .all()
        .map((row) => ({ ...row })),
      [{ person_id: ANNA, addressed_by_them: 4, addressed_by_her: 2 }]
    );
    assert.equal(db.prepare('SELECT affinity FROM people WHERE id = ?').get(ANNA)?.affinity, 40);
  });
});

test('a merge is recorded once, and the person who went keeps a row that says where they went', () => {
  withWorld((handle, db) => {
    merge(handle, BORIS, ANNA);
    assert.deepEqual(
      db
        .prepare('SELECT from_person, into_person, by, reason FROM people_merges')
        .all()
        .map((row) => ({ ...row })),
      [{ from_person: BORIS, into_person: ANNA, by: 'owner', reason: 'the same person' }]
    );
    assert.equal(db.prepare('SELECT status FROM people WHERE id = ?').get(BORIS)?.status, `merged_into:${ANNA}`);
  });
});

test('the same merge run again changes nothing and answers the same survivor', () => {
  // Bug: a repeated command refuses with ALREADY_MERGED, so a merge that stopped half way can never be finished.
  withWorld((handle, db) => {
    merge(handle, BORIS, ANNA);
    const after = databaseDigest(db);
    const again = merge(handle, BORIS, ANNA);
    assert.equal(again.survivor, ANNA);
    assert.equal(
      Object.values(again.moved).reduce((sum, one) => sum + one, 0),
      0
    );
    assert.deepEqual(databaseDigest(db), after);
  });
});

test('a repeat finishes a merge whose record exists and whose rows never moved', () => {
  // Bug: a merge recorded by the older writer leaves its rows behind for good, because the record alone counts as done.
  withWorld((handle, db) => {
    db.prepare(
      "INSERT INTO people_merges (id, from_person, into_person, at, by) VALUES ('merge:old', ?, ?, ?, 'owner')"
    ).run(BORIS, ANNA, AT);
    merge(handle, BORIS, ANNA);
    assert.deepEqual(about(db, BORIS), []);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM people_merges').get()?.n, 1);
  });
});

test('a merge into a person who was merged lands on the one who stays at the end of the chain', () => {
  withWorld((handle, db) => {
    merge(handle, CAROL, ANNA);
    const answer = merge(handle, BORIS, CAROL);
    assert.equal(answer.survivor, ANNA);
    assert.equal(db.prepare('SELECT person_id FROM accounts WHERE id = ?').get(BORIS_ACCOUNT)?.person_id, ANNA);
  });
});

test('only the owner merges people, and a refused merge writes nothing', () => {
  // Bug: a memory session merges two people and opens one person's DMs to the other.
  withWorld((handle, db) => {
    const before = databaseDigest(db);
    assert.throws(() => merge(handle, BORIS, ANNA, 'her'), { code: 'OWNER_ONLY' });
    assert.deepEqual(databaseDigest(db), before);
  });
});

test('her own person is merged neither in nor out, and an unknown person is refused', () => {
  withWorld((handle, db) => {
    db.prepare("INSERT OR IGNORE INTO people (id, kind) VALUES ('person:self', 'self')").run();
    const before = databaseDigest(db);
    assert.throws(() => merge(handle, BORIS, 'person:self'), { code: 'SELF_PERSON' });
    assert.throws(() => merge(handle, 'person:self', ANNA), { code: 'SELF_PERSON' });
    assert.throws(() => merge(handle, 'person:nobody', ANNA), { code: 'UNKNOWN_PERSON' });
    assert.deepEqual(databaseDigest(db), before);
  });
});

test('the owner keeps his rights on every account when his owner person is the one merged away', () => {
  // Bug: `bot.ownerPerson` still names the person who went, and `isBoundTo` compares it with the survivor's id.
  withWorld((handle, db) => {
    merge(handle, BORIS, ANNA);
    const owner = createOwnerAccounts({ database: () => db, home: () => 'telegram' });
    assert.equal(
      withIface('telegram', () => owner.isBoundTo(BORIS, 'n2')),
      true
    );
    assert.equal(
      withIface('discord', () => owner.isBoundTo(BORIS, 'n1')),
      true
    );
    assert.equal(
      withIface('telegram', () => owner.isBoundTo(BORIS, 'n3')),
      false
    );
  });
});

test('the graph follows the merge: no live edge points at the person who went', () => {
  // Bug: the rows move and their projection does not, so a graph walk still finds facts under the old person.
  withWorld((handle, db) => {
    reproject(handle, { at: AT });
    merge(handle, BORIS, ANNA);
    assert.equal(
      db
        .prepare('SELECT COUNT(*) AS n FROM graph_edges WHERE dst = ? AND retired_at IS NULL AND valid_to_at IS NULL')
        .get(`person:${BORIS}`)?.n,
      0
    );
  });
});

test('the memory service merges through its one writer', async () => {
  // Bug: the command reaches a method the service never wired, so the owner's merge fails on a running core.
  const dataDir = tempDataDir('nep-merge-service-');
  const writer = openMemoryDb(join(dataDir, 'memory.db'));
  seedWorld(dbOf(writer));
  writer.close();
  const memory = await openTestMemory({ dataDir });
  try {
    const db = memory.memoryDb.readHandle()?.db as Db;
    const answer = (await memory.memoryDb.personMerge({ from: BORIS, into: ANNA, by: 'owner', now: NOW })) as Merged;
    assert.equal(answer.survivor, ANNA);
    assert.equal(
      db.prepare('SELECT into_person FROM people_merges WHERE from_person = ?').get(BORIS)?.into_person,
      ANNA
    );
  } finally {
    await memory.close();
  }
});

// ---------- the owner's command ----------

test('/memory users merge parses the same from the chat and from argv', () => {
  const line = `/memory users merge ${BORIS} ${ANNA} --reason same`;
  const fromChat = parseCommandLine(line);
  assert.ok(fromChat.ok, fromChat.ok ? '' : fromChat.reason);
  assert.equal(fromChat.name, 'memory.users.merge');
  assert.deepEqual(parseRequest(commandLineWords(line)).parsed, fromChat);
});

/** The owner's console over a read-only file of the world, with a writer that records what it is asked. */
function consoleRig(): {
  say(line: string): Promise<{ status: string; code?: string; text: string }>;
  writes: Array<Row>;
} {
  const dir = tempDir('nep-merge-console-');
  mkdirSync(join(dir, 'config'), { recursive: true });
  const file = join(dir, 'memory.db');
  const writer = openMemoryDb(file);
  seedWorld(dbOf(writer));
  writer.close();
  const reader = openMemoryDb(file, { readOnly: true });
  const writes: Array<Row> = [];
  const deps: ConsoleDeps = {
    runOp: () => Promise.resolve({ status: 'failed', code: 'NOT_FOR_A_MERGE', summary: '', data: null }),
    ownerReads: { lessons: () => '', aliases: () => '' },
    places: () => [],
    selfId: () => null,
    hot: {
      config: {
        memoryDb: { file: 'memory.db', inspection: { pageRows: 50, snapshotIdleSeconds: 60, snapshotMaxSeconds: 300 } },
      },
    },
    privateDir: dir,
    dataDir: dir,
    memoryDb: {
      database: () => dbOf(reader),
      personLink: () => Promise.resolve({ ok: true, person: null }),
      personMerge: (update: Row) => {
        writes.push(update);
        return Promise.resolve({ ok: true, id: 'merge:x', survivor: ANNA, moved: {} });
      },
    },
    usage: null,
    metrics: { samples: () => [] },
    conversationLines: () => [],
    now: () => NOW,
  };
  const desk = createConsole(deps);
  return {
    writes,
    say: async (line) => {
      const parsed = parseCommandLine(line);
      assert.ok(parsed.ok, parsed.ok ? '' : `${line}: ${parsed.reason}`);
      return desk.run(parsed.name, parsed.args, { id: 'owner' });
    },
  };
}

test('/memory users merge goes through the one writer as the owner, with his reason', async () => {
  // Bug: the console merges over its own connection, a second writer on her memory, or records the merge as nobody's.
  const rig = consoleRig();
  const answer = await rig.say(`/memory users merge ${BORIS} ${ANNA} --reason same`);
  assert.equal(answer.status, 'ok', answer.text);
  assert.deepEqual(
    rig.writes.map(({ from, into, by, reason }) => ({ from, into, by, reason })),
    [{ from: BORIS, into: ANNA, by: 'owner', reason: 'same' }]
  );
});

test('/memory users merge of a person nobody stored answers invalid and writes nothing', async () => {
  const rig = consoleRig();
  const answer = await rig.say(`/memory users merge person:nobody ${ANNA}`);
  assert.deepEqual([answer.status, answer.code], ['invalid', 'PERSON_NOT_FOUND']);
  assert.deepEqual(rig.writes, []);
});
