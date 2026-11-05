// `scripts/memory-repair-identity.ts`, run as a process over a database closed the way a stopped core leaves it. The
// fixture has the shape an install that ran before the identity links leaves: the owner bound on one interface with the
// owner column of his account lost, his command line unlinked under `cli/global` with a tentative person she proposed
// for it, her own account with no person, her facts about herself, feelings kept in his DM, and a stranger with no
// person. Synthetic ids and text only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { withIface } from '../src/memory/db/current-iface.ts';
import { observationOf } from '../src/memory/db/observe-event.ts';
import { observe } from '../src/memory/db/observe.ts';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { personDetail } from '../src/memory/db/people-read.ts';
import { createOwnerAccounts } from '../src/memory/db/person-links.ts';
import { internalContext } from '../src/memory/db/scope.ts';
import { dbOf } from '../src/memory/db/types.ts';
import type { Db, Row } from '../src/memory/db/types.ts';
import { databaseDigest } from './fixtures/memory-db/browser-world.ts';
import { addAuthority } from './fixtures/memory-db/opaque-people.ts';
import { tempDir } from './fixtures/tmp.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SCRIPT = path.join(ROOT, 'scripts', 'memory-repair-identity.ts');
const OWNER = 'person:discord:9001';
const DOUBLE = 'person:0d0d0d0d-synthetic';
const HER = 'discord:9999';
const AT = '2026-11-04T03:47:17.948Z';

/** The shape the production database had before the repair, in synthetic rows. */
function seedInstall(db: Db): void {
  addAuthority(db, 'discord', 'discord/global');
  addAuthority(db, 'cli', 'cli/global');
  const person = db.prepare('INSERT INTO people (id, kind, status, affinity, first_seen_at) VALUES (?, ?, ?, ?, ?)');
  person.run(OWNER, 'member', 'active', 45.5, AT);
  person.run(DOUBLE, 'person', 'active', null, AT);
  const account = db.prepare(
    `INSERT INTO accounts (id, iface, native_id, native_key, authority_id, generation, kind, person_id, link, linked_by, names)
     VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, NULL, ?)`
  );
  account.run('discord:9001', 'discord', '9001', '9001', 'discord/global', 'user', OWNER, 'verified', '["Owner Name"]');
  account.run(HER, 'discord', '9999', '9999', 'discord/global', 'self', null, null, '["Her Name"]');
  account.run('discord:9003', 'discord', '9003', '9003', 'discord/global', 'user', null, null, '["Her Name"]');
  account.run('cli:owner', 'cli', 'owner', 'owner', 'cli/global', 'user', null, null, null);
  const key = db.prepare(
    'INSERT INTO external_keys (authority_id, object_kind, native_key, generation, node_id, recorded_at) VALUES (?, ?, ?, 1, ?, ?)'
  );
  key.run('cli/global', 'account', 'owner', 'cli:owner', AT);
  key.run('cli/global', 'place', 'dm:owner', 'cli:dm:owner', AT);
  key.run('discord/global', 'account', '9999', HER, AT);
  const link = db.prepare(
    `INSERT INTO account_person_links (id, account_id, person_id, state, by, reason, evidence_id, valid_from_at, valid_to_at, recorded_at)
     VALUES (?, ?, ?, ?, ?, 'synthetic', ?, ?, ?, ?)`
  );
  link.run('link:9001:migration', 'discord:9001', OWNER, 'verified', 'migration', null, AT, AT, AT);
  link.run('link:9001:owner', 'discord:9001', OWNER, 'verified', 'owner', null, AT, null, AT);
  const place = db.prepare(
    `INSERT INTO places (id, iface, kind, native_id, native_key, authority_id, generation, conversation, scope_kind, partner_account, partner_person)
     VALUES (?, ?, 'dm', ?, ?, ?, 1, 'dm', 'dm', ?, ?)`
  );
  place.run('cli:dm:owner', 'cli', 'owner', 'dm:owner', 'cli/global', 'cli:owner', null);
  place.run('discord:dm:9001', 'discord', '9001', 'dm:9001', 'discord/global', 'discord:9001', OWNER);
  const audience = db.prepare("INSERT INTO audiences (id, kind, iface, place_id) VALUES (?, 'dm', ?, ?)");
  audience.run('aud:dm:cli:dm:owner', 'cli', 'cli:dm:owner');
  audience.run('aud:dm:discord:dm:9001', 'discord', 'discord:dm:9001');
  db.prepare(
    "INSERT OR IGNORE INTO audiences (id, kind, iface) VALUES ('aud:group:discord', 'group', 'discord')"
  ).run();
  const source = db.prepare(
    `INSERT INTO sources (id, kind, iface, place_id, author_account, author_kind, occurred_at, recorded_at, text, audience_id,
       scope_kind, scope_iface, scope_dm)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'synthetic', ?, 'dm', ?, ?)`
  );
  source.run(
    'source:cli-seen',
    'seen',
    'cli',
    'cli:dm:owner',
    'cli:owner',
    'account',
    AT,
    AT,
    'aud:dm:cli:dm:owner',
    'cli',
    null
  );
  source.run(
    'source:cli-said',
    'said',
    'cli',
    'cli:dm:owner',
    null,
    'self',
    AT,
    AT,
    'aud:dm:cli:dm:owner',
    'cli',
    'person:cli:owner'
  );
  for (const n of [1, 2, 3])
    source.run(
      `source:felt-${n}`,
      'felt',
      'discord',
      null,
      null,
      'self',
      AT,
      AT,
      'aud:dm:discord:dm:9001',
      'discord',
      OWNER
    );
  db.prepare(
    `INSERT INTO vectors (source_rowid, item_id, chunk_key, model, dims, context, occurred_at, scope_kind, scope_iface, scope_dm, audience_id)
     VALUES ((SELECT rowid FROM sources WHERE id = 'source:cli-said'), 'source:cli-said', 'chunk:cli', 'test/embedder', 4, '{}', ?,
       'dm', 'cli', 'person:cli:owner', 'aud:dm:cli:dm:owner')`
  ).run(AT);
  link.run('link:cli:owner:double', 'cli:owner', DOUBLE, 'proposed', 'her', 'source:cli-seen', AT, null, AT);
  db.prepare(
    `INSERT INTO decisions (id, at, by, target_kind, target_id, action, reason)
     VALUES ('dec:run:synthetic:2', ?, 'her', 'person', ?, 'people_add', 'synthetic')`
  ).run(AT, DOUBLE);
  const claim = db.prepare(
    `INSERT INTO claims (id, subject_kind, subject_id, kind, text, truth, shown, audience_id, created_at)
     VALUES (?, ?, ?, ?, 'synthetic', 'current', 1, ?, ?)`
  );
  claim.run('claim:self-group', 'self', 'person:self', 'self_fact', 'aud:group:discord', AT);
  claim.run('claim:self-dm', 'self', 'person:self', 'lesson', 'aud:dm:discord:dm:9001', AT);
  claim.run('claim:owner-group', 'person', OWNER, 'detail', 'aud:group:discord', AT);
}

function install(): string {
  const file = path.join(tempDir('nep-repair-identity-'), 'memory.db');
  const handle = openMemoryDb(file);
  try {
    seedInstall(dbOf(handle));
  } finally {
    handle.close();
  }
  return file;
}

function run(file: string, ...flags: Array<string>) {
  const result = spawnSync(process.execPath, [SCRIPT, '--db', file, ...flags], { cwd: ROOT, encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function read<T>(file: string, body: (db: Db) => T): T {
  const handle = openMemoryDb(file, { readOnly: true });
  try {
    return body(dbOf(handle));
  } finally {
    handle.close();
  }
}

const rows = (db: Db, sql: string, ...args: Array<unknown>): Array<Row> =>
  db
    .prepare(sql)
    .all(...args)
    .map((row) => ({ ...row }));

/** Every scoped row with its audience, the map a repair must leave exactly as it found it. */
const audienceMap = (db: Db) => ({
  sources: rows(db, 'SELECT id, audience_id FROM sources ORDER BY id'),
  claims: rows(db, 'SELECT id, audience_id FROM claims ORDER BY id'),
  vectors: rows(db, 'SELECT chunk_key, audience_id FROM vectors ORDER BY chunk_key'),
});

const applied = (file: string) => {
  const result = run(file, '--owner-person', OWNER, '--apply');
  assert.equal(result.status, 0, result.stderr);
  return result;
};

test('the repair links the command line to the owner and merges the person she made for it', () => {
  // Bug: the owner's chat and her tracked double of him stay apart, and what he says in the chat lands on nobody.
  const file = install();
  applied(file);
  read(file, (db) => {
    assert.deepEqual(rows(db, "SELECT person_id, link FROM accounts WHERE id = 'cli:owner'"), [
      { person_id: OWNER, link: 'verified' },
    ]);
    assert.deepEqual(
      rows(
        db,
        "SELECT person_id, state, by FROM account_person_links WHERE account_id = 'cli:owner' AND valid_to_at IS NULL"
      ),
      [{ person_id: OWNER, state: 'verified', by: 'owner' }]
    );
    assert.equal(
      rows(db, "SELECT 1 FROM account_person_links WHERE id = 'link:cli:owner:double'").length,
      1,
      'kept as history'
    );
    assert.deepEqual(rows(db, 'SELECT from_person, into_person, by FROM people_merges'), [
      { from_person: DOUBLE, into_person: OWNER, by: 'owner' },
    ]);
    assert.deepEqual(rows(db, "SELECT partner_person FROM places WHERE id = 'cli:dm:owner'"), [
      { partner_person: OWNER },
    ]);
  });
});

test('after the repair the owner has his rights on Discord and on the command line', () => {
  // Bug: the owner column of his account was lost by an older unit write, so `isBoundTo` refuses him on Discord.
  const file = install();
  applied(file);
  read(file, (db) => {
    const owner = createOwnerAccounts({ database: () => db, home: () => 'discord' });
    assert.equal(
      withIface('discord', () => owner.isBoundTo(OWNER, '9001')),
      true
    );
    assert.equal(
      withIface('cli', () => owner.isBoundTo(OWNER, 'owner')),
      true
    );
  });
});

test('after the repair her account is hers, and the stranger under her name is not', () => {
  const file = install();
  applied(file);
  read(file, (db) => {
    assert.deepEqual(rows(db, 'SELECT person_id, link FROM accounts WHERE id = ?', HER), [
      { person_id: 'person:self', link: 'verified' },
    ]);
    assert.deepEqual(rows(db, "SELECT person_id FROM accounts WHERE id = 'discord:9003'"), [{ person_id: null }]);
    const view = personDetail(db, 'person:self', internalContext());
    assert.ok(view.found);
    assert.deepEqual(view.records.map((record) => record.id).sort(), ['claim:self-dm', 'claim:self-group']);
  });
});

test('the repair moves no row out of the conversation it was said in', () => {
  // Bug: a repair that rewrites scopes moves the feelings kept in his DM, or her lines in his chat, into a wider audience.
  const file = install();
  const before = read(file, audienceMap);
  applied(file);
  assert.deepEqual(read(file, audienceMap), before);
});

test('after the repair a new line of the command line lands on the same account and place', () => {
  // Bug: the repaired rows sit under `cli/global` while the next line arrives under the native authority, so the chat
  // gets a second account and a second DM with no person.
  const file = install();
  applied(file);
  const handle = openMemoryDb(file);
  try {
    const at = Date.parse('2026-11-05T10:00:00Z');
    const envelope = observationOf(
      {
        kind: 'message.received',
        iface: 'cli',
        at,
        conversation: { id: 'cli:dm:owner', kind: 'dm', chatType: 'dm', partnerId: 'owner' },
        message: { id: 'line-after', at, content: 'synthetic', author: { id: 'owner', name: 'owner' } },
      },
      { connection: 'conn:cli', direct: true }
    );
    assert.ok(envelope);
    observe(handle, envelope, { now: () => at });
    const db = dbOf(handle);
    assert.deepEqual(rows(db, "SELECT id FROM accounts WHERE iface = 'cli'"), [{ id: 'cli:owner' }]);
    assert.deepEqual(rows(db, "SELECT id FROM places WHERE iface = 'cli'"), [{ id: 'cli:dm:owner' }]);
  } finally {
    handle.close();
  }
});

test('a dry run prints counts, names nobody and writes nothing', () => {
  const file = install();
  const before = read(file, databaseDigest);
  const result = run(file, '--owner-person', OWNER);
  assert.equal(result.status, 0, result.stderr);
  assert.equal((JSON.parse(result.stdout) as { mode: string }).mode, 'dry-run');
  assert.equal(result.stdout.includes('9001'), false, 'the output carries counts, no ids');
  assert.deepEqual(read(file, databaseDigest), before);
});

test('a second run finds nothing to do and changes nothing', () => {
  const file = install();
  applied(file);
  const after = read(file, databaseDigest);
  applied(file);
  assert.deepEqual(read(file, databaseDigest), after);
});

test('a proposed person who holds another account of someone verified is not merged into the owner', () => {
  // Bug: she proposed the same tentative person for the chat and for a stranger who was later verified, and the repair
  // hands the stranger's memory to the owner.
  const file = install();
  const writer = openMemoryDb(file);
  try {
    const db = dbOf(writer);
    db.prepare(
      `INSERT INTO accounts (id, iface, native_id, native_key, authority_id, generation, kind, person_id, link, linked_by)
       VALUES ('discord:9004', 'discord', '9004', '9004', 'discord/global', 1, 'user', ?, 'verified', 'owner')`
    ).run(DOUBLE);
  } finally {
    writer.close();
  }
  applied(file);
  read(file, (db) => {
    assert.deepEqual(rows(db, "SELECT person_id FROM accounts WHERE id = 'cli:owner'"), [{ person_id: OWNER }]);
    assert.deepEqual(rows(db, 'SELECT from_person FROM people_merges'), []);
    assert.deepEqual(rows(db, "SELECT person_id FROM accounts WHERE id = 'discord:9004'"), [{ person_id: DOUBLE }]);
  });
});

test('an owner person nobody stored is refused, and nothing is written', () => {
  const file = install();
  const before = read(file, databaseDigest);
  const result = run(file, '--owner-person', 'person:nobody', '--apply');
  assert.equal(result.status, 1);
  assert.deepEqual(read(file, databaseDigest), before);
});

test('a run with no owner person named is a usage error', () => {
  const result = run(install());
  assert.equal(result.status, 2);
});

test('a fresh database has nothing to repair', () => {
  const file = path.join(tempDir('nep-repair-identity-empty-'), 'memory.db');
  openMemoryDb(file).close();
  const handle = openMemoryDb(file);
  dbOf(handle).prepare("INSERT INTO people (id, kind) VALUES (?, 'member')").run(OWNER);
  handle.close();
  const before = read(file, databaseDigest);
  applied(file);
  assert.deepEqual(read(file, databaseDigest), before);
});
