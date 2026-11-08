// `/memory users` and `/memory places` from the owner's line to the answer, over the command table and the core's console.
// A browser read answers the reader's own result as JSON, so a script and a panel see the same typed ids, and it asks no
// model, touches no setting and writes no row. Plan 2026-11-04-cli-and-memory task 8 and the command naming spec.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseRequest } from '../bin/neptunia-request.ts';
import { createConsole } from '../src/interface/commands/console.ts';
import type { Answer, ConsoleDeps } from '../src/interface/commands/console.ts';
import { commandLineWords, parseCommandLine } from '../src/interface/commands/table.ts';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { listPeople, personDetail } from '../src/memory/db/people-read.ts';
import { listPlaces, placeDetail } from '../src/memory/db/places-read.ts';
import { privateByPerson } from '../src/memory/db/private-read.ts';
import { internalContext } from '../src/memory/db/scope.ts';
import { dbOf } from '../src/memory/db/types.ts';
import type { Db, MemoryHandle, Row } from '../src/memory/db/types.ts';
import { addDescription, addPlace, databaseDigest } from './fixtures/memory-db/browser-world.ts';
import { ANNA, BORIS, addAccount, seedOpaqueWorld } from './fixtures/memory-db/opaque-people.ts';
import { tempDir } from './fixtures/tmp.ts';

const NOW = Date.parse('2026-11-05T12:00:00Z');
const BOUNDS = { pageRows: 50, snapshotIdleSeconds: 60, snapshotMaxSeconds: 300, maxSnapshots: 8 };

type Rig = {
  db: Db;
  writes: Array<Row>;
  ops: Array<string>;
  say(line: string): Promise<Answer>;
  close(): void;
};

/** A console over a file-backed database opened read-only, so a direct write would fail, with a recording writer. */
function rig(seed: (db: Db) => void = seedBrowser, memory: { closed: boolean } = { closed: false }): Rig {
  const dir = tempDir('nep-commands-memory-');
  mkdirSync(join(dir, 'config'), { recursive: true });
  const file = join(dir, 'memory.db');
  const writer = openMemoryDb(file);
  seed(dbOf(writer));
  writer.close();
  const reader: MemoryHandle = openMemoryDb(file, { readOnly: true });
  const writes: Array<Row> = [];
  const ops: Array<string> = [];
  const deps: ConsoleDeps = {
    runOp: (op) => {
      ops.push(op);
      return Promise.resolve({ status: 'failed', code: 'NOT_FOR_A_BROWSER_READ', summary: '', data: null });
    },
    ownerReads: { lessons: () => '', aliases: () => '' },
    places: () => [],
    selfId: () => null,
    hot: { config: { memoryDb: { file: 'memory.db', inspection: BOUNDS } } },
    privateDir: dir,
    dataDir: dir,
    memoryDb: {
      database: () => (memory.closed ? null : dbOf(reader)),
      personLink: (update: Row) => {
        writes.push(update);
        return Promise.resolve({ ok: true, person: null });
      },
    },
    usage: null,
    metrics: { samples: () => [] },
    chatLines: () => [],
    now: () => NOW,
  };
  const desk = createConsole(deps);
  return {
    db: dbOf(reader),
    writes,
    ops,
    say: async (line) => {
      const parsed = parseCommandLine(line);
      assert.ok(parsed.ok, parsed.ok ? '' : `${line}: ${parsed.reason}`);
      const real = globalThis.fetch;
      globalThis.fetch = () => Promise.reject(new Error('a memory read reached the network'));
      try {
        return await desk.run(parsed.name, parsed.args, { id: 'owner' });
      } finally {
        globalThis.fetch = real;
      }
    },
    close: () => reader.close(),
  };
}

function seedBrowser(db: Db): void {
  seedOpaqueWorld(db);
  addAccount(db, {
    id: 'account:u1',
    iface: 'discord',
    authority: 'discord/global',
    native: 'n9',
    person: null,
    link: 'proposed',
  });
  addPlace(db, { id: 'place:server', iface: 'zeta', authority: 'zeta/one', kind: 'server' });
  addPlace(db, { id: 'place:room', iface: 'zeta', authority: 'zeta/one', parent: 'place:server' });
  addPlace(db, { id: 'place:deep', iface: 'zeta', authority: 'zeta/one', parent: 'place:room' });
  addDescription(db, {
    id: 'desc:deep',
    subjectKind: 'place',
    subject: 'place:deep',
    field: 'topic',
    audience: 'aud:group:zeta',
    text: 'βαθιά',
  });
  db.prepare(
    `INSERT INTO claims (id, subject_kind, subject_id, kind, text, truth, shown, audience_id, scope_kind, created_at)
     VALUES ('claim:lore', 'place', 'place:server', 'lore', 'the lore', 'current', 1, 'aud:group:zeta', 'group', '2026-11-01T00:00:00.000Z')`
  ).run();
}

async function withRig(body: (one: Rig) => Promise<void>, seed?: (db: Db) => void): Promise<void> {
  const one = rig(seed);
  try {
    await body(one);
  } finally {
    one.close();
  }
}

/** The JSON of an answer that must have succeeded. */
function data(answer: Answer): unknown {
  assert.equal(answer.status, 'ok', answer.text);
  return JSON.parse(answer.text);
}
const json = (value: unknown): unknown => JSON.parse(JSON.stringify(value));
const NO_FILTERS = { name: null, interfaceId: null, authorityId: null };
const PLACES = { interfaceId: null, authorityId: null, rootsOnly: false };

// ---------- the table ----------

const LINES = [
  ['/memory users list', 'memory.users.list'],
  [
    '/memory users list --name Ελένη --interface discord --authority discord/global --limit 5 --cursor c1',
    'memory.users.list',
  ],
  ['/memory users show person:x', 'memory.users.show'],
  ['/memory users accounts person:x', 'memory.users.accounts'],
  ['/memory users names person:x', 'memory.users.names'],
  ['/memory users relationship person:x', 'memory.users.relationship'],
  ['/memory users private person:x', 'memory.users.private'],
  ['/memory users link person:x account:y', 'memory.users.link'],
  ['/memory users unlink person:x account:y', 'memory.users.unlink'],
  ['/memory places list --interface zeta --authority zeta/one --roots --limit 5 --cursor c1', 'memory.places.list'],
  ['/memory places tree place:x --limit 5', 'memory.places.tree'],
  ['/memory places show place:x --include-children', 'memory.places.show'],
  ['/memory places lore place:x', 'memory.places.lore'],
] as const;

for (const [line, name] of LINES) {
  test(`${line} parses to ${name}, the same from the chat and from argv`, () => {
    // Bug: a leaf added to one path, so a script and the chat disagree on the operation or its typed arguments.
    const fromChat = parseCommandLine(line);
    assert.ok(fromChat.ok, fromChat.ok ? '' : fromChat.reason);
    assert.equal(fromChat.name, name);
    assert.deepEqual(parseRequest(commandLineWords(line)).parsed, fromChat);
  });
}

const RETIRED = [
  ['/memory profile u1', '/memory users show'],
  ['/memory accounts discord n1', '/memory users accounts'],
  ['/memory unbind discord n1', '/memory users unlink'],
  ['/memory aliases list u1', '/memory users names'],
  ['/memory affinity u1', '/memory users relationship'],
  ['/memory private u1', '/memory users private'],
  ['/memory server', '/memory places show'],
  ['/memory lore list', '/memory places lore'],
  ['/memory person u1', '/memory places show'],
] as const;

for (const [line, replacement] of RETIRED) {
  test(`${line} is refused and names ${replacement}`, () => {
    // Bug: a functional alias survives, or the old word falls through as an unknown leaf with no way forward.
    const parsed = parseCommandLine(line);
    assert.equal(parsed.ok, false);
    assert.ok(!parsed.ok && parsed.reason.includes(replacement), parsed.ok ? '' : parsed.reason);
  });
}

// ---------- users ----------

test('/memory users list answers the reader page itself', async () => {
  // Bug: a panel-shaped text list that a script has to parse, with the typed ids lost in the wording.
  await withRig(async (one) => {
    const expected = listPeople(one.db, {
      context: internalContext(),
      filters: NO_FILTERS,
      limit: BOUNDS.pageRows,
      cursor: null,
    });
    assert.deepEqual(data(await one.say('/memory users list')), json(expected));
  });
});

test('the limit and cursor flags walk the whole list, and a page reports what it left out', async () => {
  await withRig(async (one) => {
    const whole = data(await one.say('/memory users list')) as { items: Array<{ id: string }>; total: number };
    const seen: Array<string> = [];
    let line = '/memory users list --limit 1';
    for (let turn = 0; turn < whole.total + 1; turn += 1) {
      const page = data(await one.say(line)) as {
        items: Array<{ id: string }>;
        next: string | null;
        total: number;
        truncated: boolean;
      };
      assert.equal(page.total, whole.total);
      seen.push(...page.items.map((item) => item.id));
      if (page.next === null) break;
      assert.equal(page.truncated, true);
      line = `/memory users list --limit 1 --cursor ${page.next}`;
    }
    assert.deepEqual(
      seen,
      whole.items.map((item) => item.id)
    );
  });
});

test('the page bound comes from memoryDb.inspection when no limit is given', async () => {
  await withRig(
    async (one) => {
      const page = data(await one.say('/memory users list')) as { items: Array<unknown> };
      assert.ok(page.items.length <= BOUNDS.pageRows);
      const many = data(await one.say('/memory users list --limit 100000')) as { items: Array<unknown> };
      assert.ok(many.items.length <= BOUNDS.pageRows);
    },
    (db) => {
      seedBrowser(db);
      const add = db.prepare('INSERT INTO people (id, first_seen_at) VALUES (?, ?)');
      for (let n = 0; n < BOUNDS.pageRows + 5; n += 1) add.run(`person:bulk-${n}`, '2026-11-01T00:00:00.000Z');
    }
  );
});

test('/memory users show answers the reader detail itself', async () => {
  await withRig(async (one) => {
    assert.deepEqual(
      data(await one.say(`/memory users show ${ANNA}`)),
      json(personDetail(one.db, ANNA, internalContext()))
    );
  });
});

test('/memory users private answers the person-wide private view', async () => {
  // Bug: the leaf keeps reading one interface's profile, so a second account's DM is missing.
  await withRig(async (one) => {
    assert.deepEqual(
      data(await one.say(`/memory users private ${ANNA}`)),
      json(privateByPerson(one.db, ANNA, internalContext()))
    );
  });
});

test('/memory users accounts, names and relationship answer their part of the detail', async () => {
  await withRig(async (one) => {
    const detail = personDetail(one.db, ANNA, internalContext());
    assert.ok(detail.found);
    assert.deepEqual(
      data(await one.say(`/memory users accounts ${ANNA}`)),
      json({ accounts: detail.accounts, links: detail.links })
    );
    assert.deepEqual(data(await one.say(`/memory users names ${ANNA}`)), json({ names: detail.names }));
    assert.deepEqual(data(await one.say(`/memory users relationship ${ANNA}`)), json({ affinity: detail.affinity }));
  });
});

test('a person nobody stored answers invalid with its code', async () => {
  await withRig(async (one) => {
    const answer = await one.say('/memory users show person:unknown');
    assert.deepEqual([answer.status, answer.code], ['invalid', 'PERSON_NOT_FOUND']);
  });
});

test('a bad cursor answers invalid with its code and no partial page', async () => {
  await withRig(async (one) => {
    const answer = await one.say('/memory users list --cursor garbage');
    assert.deepEqual([answer.status, answer.code], ['invalid', 'INSPECTION_BAD_CURSOR']);
  });
});

test('linking goes through the one writer, by typed ids', async () => {
  // Bug: the console writes the link over its own connection, a second writer on her memory.
  await withRig(async (one) => {
    const answer = await one.say(`/memory users link ${ANNA} account:u1`);
    assert.equal(answer.status, 'ok', answer.text);
    assert.deepEqual(one.writes, [{ op: 'bind', accountId: 'account:u1', target: { personId: ANNA } }]);
  });
});

test('unlinking goes through the one writer, for an account of that person only', async () => {
  // Bug: `/memory users unlink <person> <account>` ignores the person, and a typo unlinks someone else.
  await withRig(async (one) => {
    assert.equal((await one.say(`/memory users unlink ${ANNA} account:a11`)).status, 'ok');
    assert.deepEqual(one.writes, [{ op: 'unbind', accountId: 'account:a11' }]);
    const wrong = await one.say(`/memory users unlink ${BORIS} account:a12`);
    assert.equal(wrong.status, 'invalid');
    assert.equal(one.writes.length, 1);
  });
});

test('linking an account nobody stored answers invalid and writes nothing', async () => {
  await withRig(async (one) => {
    assert.equal((await one.say(`/memory users link ${ANNA} account:unknown`)).status, 'invalid');
    assert.deepEqual(one.writes, []);
  });
});

// ---------- places ----------

test('/memory places list answers the reader page, with its filters', async () => {
  await withRig(async (one) => {
    const expected = listPlaces(one.db, {
      context: internalContext(),
      filters: { ...PLACES, interfaceId: 'zeta', rootsOnly: true },
      limit: BOUNDS.pageRows,
      cursor: null,
    });
    assert.deepEqual(data(await one.say('/memory places list --interface zeta --roots')), json(expected));
  });
});

test('/memory places show with include-children reaches descendant descriptions', async () => {
  // Bug: the retired `/memory server` read one level, and the flag is parsed but not passed down.
  await withRig(async (one) => {
    const wide = placeDetail(one.db, 'place:server', { context: internalContext(), includeChildren: true });
    assert.deepEqual(data(await one.say('/memory places show place:server --include-children')), json(wide));
    const narrow = placeDetail(one.db, 'place:server', { context: internalContext(), includeChildren: false });
    assert.deepEqual(data(await one.say('/memory places show place:server')), json(narrow));
    assert.ok(wide.found && wide.descriptions.some((entry) => entry.id === 'desc:deep'));
  });
});

test('/memory places tree answers the descendants with their depth', async () => {
  await withRig(async (one) => {
    const tree = data(await one.say('/memory places tree place:server')) as {
      descendants: Array<{ id: string; depth: number }>;
    };
    assert.deepEqual(
      tree.descendants.map((entry) => [entry.id, entry.depth]),
      [
        ['place:room', 1],
        ['place:deep', 2],
      ]
    );
  });
});

test('/memory places lore answers the lore of that place by id', async () => {
  await withRig(async (one) => {
    const lore = data(await one.say('/memory places lore place:server')) as {
      records: Array<{ table: string; id: string }>;
    };
    assert.deepEqual(lore.records, [{ table: 'claims', id: 'claim:lore' }]);
    const none = data(await one.say('/memory places lore place:deep')) as { records: Array<unknown> };
    assert.deepEqual(none.records, []);
  });
});

test('a place nobody stored answers invalid with its code', async () => {
  await withRig(async (one) => {
    const answer = await one.say('/memory places show place:unknown');
    assert.deepEqual([answer.status, answer.code], ['invalid', 'PLACE_NOT_FOUND']);
  });
});

// ---------- every read ----------

const READS = [
  '/memory users list',
  `/memory users show ${ANNA}`,
  `/memory users accounts ${ANNA}`,
  `/memory users names ${ANNA}`,
  `/memory users relationship ${ANNA}`,
  `/memory users private ${ANNA}`,
  '/memory places list',
  '/memory places tree place:server',
  '/memory places show place:server --include-children',
  '/memory places lore place:server',
];

test('a browser read runs no operation, reaches no network and changes no row', async () => {
  // Bug: a read goes through `runOp` and a tool that records a turn read, or through the model's memory path.
  await withRig(async (one) => {
    const before = databaseDigest(one.db);
    for (const line of READS) assert.equal((await one.say(line)).status, 'ok', line);
    assert.deepEqual(one.ops, []);
    assert.deepEqual(one.writes, []);
    assert.deepEqual(databaseDigest(one.db), before);
  });
});

test('a closed database answers failed and throws nothing', async () => {
  const memory = { closed: true };
  const one = rig(seedBrowser, memory);
  try {
    for (const line of READS) assert.equal((await one.say(line)).status, 'failed', line);
  } finally {
    one.close();
  }
});
