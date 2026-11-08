// The owner's `/memory bind` over the memory database (plan 2026-11-08-meta-person, slice 6): an account binds to a
// meta-person and only to one. An account with no person is attached. An account under its own meta-person asks one
// Y/n naming the person it removes, and on yes that person merges into the target: claims, episodes and accounts move,
// the lines follow, both descriptions of a field are joined by the memory model with the target's text first, and the
// person who went stays as an alias. Real temporary databases, a fake model client and synthetic text only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { bindAccount } from '../src/memory/db/person-bind.ts';
import type { BindConfirm, BindDeps, BindResult, BindTarget } from '../src/memory/db/person-bind.ts';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { applyMemoryWrite } from '../src/memory/db/session-write.ts';
import type { Completion } from '../src/memory/db/session.ts';
import { dbOf } from '../src/memory/db/types.ts';
import type { Db, MemoryHandle, Row } from '../src/memory/db/types.ts';
import { databaseDigest } from './fixtures/memory-db/browser-world.ts';
import { addAccount, addAuthority, addPerson } from './fixtures/memory-db/opaque-people.ts';
import { tempDir } from './fixtures/tmp.ts';

const AT = '2026-11-01T00:00:00.000Z';
const NOW = Date.parse('2026-11-08T12:00:00Z');
const TARGET = 'person:7a1e0000-target';
const OTHER = 'person:3c9d0000-other';
const LEGACY = 'person:5b2e0000-legacy';
const GROUP = 'aud:group:discord';
const MERGE_PROMPT = 'MERGE PROMPT for {{name}}';

type Call = { messages: ReadonlyArray<Row>; options: Row };
type FakeLlm = { calls: Array<Call>; complete(messages: ReadonlyArray<Row>, options: Row): Promise<Completion> };

/** The body of `<tag>` in a request's user message, as block() writes it. */
function blockOf(text: string, tag: string): string {
  const found = new RegExp(`<${tag}>\\n([\\s\\S]*?)\\n</${tag}>`).exec(text);
  return found?.[1] ?? '';
}

const textOf = (value: unknown): string => (typeof value === 'string' ? value : '');

/** A model that joins the two texts it is given, the kept one first, or one that fails every call. */
function fakeLlm(fail = false): FakeLlm {
  const calls: Array<Call> = [];
  return {
    calls,
    complete(messages, options) {
      calls.push({ messages, options });
      if (fail) return Promise.reject(Object.assign(new Error('down'), { code: 'llm_down' }));
      const user = textOf(messages.at(-1)?.content);
      const joined = `${blockOf(user, 'kept')} (also: ${blockOf(user, 'merged')})`;
      return Promise.resolve({ text: `<think>joining</think><description>${joined}</description><reason>r</reason>` });
    },
  };
}

function addMeta(db: Db, id: string): void {
  addPerson(db, id);
  db.prepare('UPDATE people SET meta = 1, affinity = ? WHERE id = ?').run(id === TARGET ? 30 : -5, id);
}

/** An account under a meta-person: its `accounts` row with the verified link, and its `person_accounts` row. */
function addMetaAccount(
  db: Db,
  seed: { id: string; iface: string; native: string; person: string; name: string }
): void {
  addAccount(db, {
    id: seed.id,
    iface: seed.iface,
    authority: `${seed.iface}/global`,
    native: seed.native,
    person: seed.person,
  });
  db.prepare(
    `INSERT INTO person_accounts (id, person_id, iface, platform_id, display_name, recorded_at) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(seed.id, seed.person, seed.iface, seed.native, seed.name, AT);
}

function addGroupAudience(db: Db): void {
  addAuthority(db, 'discord', 'discord/global');
  db.prepare("INSERT OR IGNORE INTO audiences (id, kind, iface) VALUES (?, 'group', 'discord')").run(GROUP);
}

function addDescription(db: Db, id: string, subject: string, field: string, text: string): void {
  db.prepare(
    `INSERT INTO descriptions (id, subject_kind, subject_id, field, audience_id, scope_kind, scope_iface, current_version)
     VALUES (?, 'person', ?, ?, ?, 'group', 'discord', ?)`
  ).run(id, subject, field, GROUP, `${id}:v1`);
  db.prepare(
    `INSERT INTO description_versions (id, description_id, text, author, written_at, chars, origin)
     VALUES (?, ?, ?, 'her', ?, ?, 'review')`
  ).run(`${id}:v1`, id, text, AT, text.length);
}

function addLine(db: Db, id: string, account: string, person: string | null): void {
  db.prepare(
    `INSERT INTO sources (id, kind, iface, place_id, author_account, author_person, author_kind, occurred_at, recorded_at,
       text, audience_id, scope_kind, scope_iface)
     VALUES (?, 'seen', 'discord', 'place:room-1', ?, ?, 'account', ?, ?, 'a synthetic line', ?, 'group', 'discord')`
  ).run(id, account, person, AT, AT, GROUP);
}

/**
 * The target with one account and a character, the other person with two accounts, a character, a style, a claim, an
 * episode, an affinity event and a line, an account nobody holds with a line, and a legacy person not marked meta.
 */
function seed(db: Db): void {
  addGroupAudience(db);
  addMeta(db, TARGET);
  addMeta(db, OTHER);
  addMetaAccount(db, { id: 'account:t1', iface: 'discord', native: 't1', person: TARGET, name: 'Mira' });
  addMetaAccount(db, { id: 'account:o1', iface: 'telegram', native: 'o1', person: OTHER, name: 'Dima' });
  addMetaAccount(db, { id: 'account:o2', iface: 'telegram', native: 'o2', person: OTHER, name: 'Dima two' });
  addAccount(db, {
    id: 'account:n1',
    iface: 'discord',
    authority: 'discord/global',
    native: 'n1',
    person: null,
    link: 'proposed',
  });
  addPerson(db, LEGACY);
  addDescription(db, 'desc:target:character', TARGET, 'character', 'Target character text');
  addDescription(db, 'desc:other:character', OTHER, 'character', 'Other character text');
  addDescription(db, 'desc:other:style', OTHER, 'style', 'Other style text');
  db.prepare(
    `INSERT INTO claims (id, subject_kind, subject_id, kind, text, truth, shown, audience_id, scope_kind, created_at)
     VALUES ('claim:other', 'person', ?, 'detail', 'a synthetic claim', 'current', 1, ?, 'group', ?)`
  ).run(OTHER, GROUP, AT);
  db.prepare(
    `INSERT INTO episodes (id, kind, subject_id, place_id, date, what, audience_id, scope_kind, created_at)
     VALUES ('episode:other', 'shared', ?, 'place:room-1', '2026-11-01', 'a synthetic event', ?, 'group', ?)`
  ).run(OTHER, GROUP, AT);
  db.prepare(
    `INSERT INTO affinity_events (id, person_id, at, delta, applied, score, reason, audience_id, scope_kind)
     VALUES ('affinity:other', ?, ?, 2, 2, -5, 'synthetic', ?, 'group')`
  ).run(OTHER, AT, GROUP);
  addLine(db, 'source:o1', 'account:o1', OTHER);
  addLine(db, 'source:n1', 'account:n1', null);
}

type Env = { handle: MemoryHandle; db: Db; llm: FakeLlm; deps: BindDeps };

async function withEnv(
  body: (env: Env) => Promise<void>,
  options: { fail?: boolean; prompt?: string } = {}
): Promise<void> {
  const handle = openMemoryDb(path.join(tempDir('nep-person-bind-'), 'memory.db'));
  const db = dbOf(handle);
  seed(db);
  const llm = fakeLlm(options.fail === true);
  const deps: BindDeps = {
    db,
    write: (update) => Promise.resolve(applyMemoryWrite(handle, update)),
    llm,
    hot: { config: { bot: { ownerPerson: '' } }, prompts: { 'description-merge': options.prompt ?? MERGE_PROMPT } },
    selfName: 'Ayla',
    now: () => NOW,
  };
  try {
    await body({ handle, db, llm, deps });
  } finally {
    handle.close();
  }
}

/** A confirmation that records what it was asked and answers `yes`. */
function answering(yes: boolean): { asked: Array<{ removed: BindTarget; into: BindTarget }>; confirm: BindConfirm } {
  const asked: Array<{ removed: BindTarget; into: BindTarget }> = [];
  return {
    asked,
    confirm: (question) => {
      asked.push(question);
      return Promise.resolve(yes);
    },
  };
}

const personOf = (db: Db, account: string): unknown =>
  db.prepare('SELECT person_id FROM person_accounts WHERE id = ?').get(account)?.person_id;
const currentText = (db: Db, subject: string, field: string): unknown =>
  db
    .prepare(
      `SELECT v.text FROM descriptions d JOIN description_versions v ON v.id = d.current_version
       WHERE d.subject_kind = 'person' AND d.subject_id = ? AND d.field = ?`
    )
    .all(subject, field)
    .map((row) => row.text);

test('an account no person holds is attached to the meta-person without a question', async () => {
  // Bug: a new account asks for a merge, stays out of person_accounts, or its lines keep no author person.
  await withEnv(async ({ db, llm, deps }) => {
    const { asked, confirm } = answering(true);
    const result: BindResult = await bindAccount(deps, { accountId: 'account:n1', personId: TARGET }, confirm);
    assert.deepEqual(result, { status: 'attached', person: TARGET });
    assert.equal(asked.length, 0);
    assert.equal(llm.calls.length, 0);
    assert.equal(personOf(db, 'account:n1'), TARGET);
    assert.equal(db.prepare('SELECT person_id FROM accounts WHERE id = ?').get('account:n1')?.person_id, TARGET);
    assert.equal(db.prepare("SELECT author_person FROM sources WHERE id = 'source:n1'").get()?.author_person, TARGET);
  });
});

test('an account under its own meta-person asks one Y/n naming the person it removes, by id and name', async () => {
  // Bug: the question names the target instead of the person who goes, or the owner cannot tell who that is.
  await withEnv(async ({ deps }) => {
    const { asked, confirm } = answering(false);
    await bindAccount(deps, { accountId: 'account:o1', personId: TARGET }, confirm);
    assert.equal(asked.length, 1);
    const [question] = asked;
    assert.deepEqual(question?.removed, { id: OTHER, name: 'Dima' });
    assert.equal(question?.into.id, TARGET);
  });
});

test('on yes the other person merges into the target: records, accounts and lines move, the alias stays', async () => {
  // Bug: a merge leaves claims, episodes, a second account or the author person of a line on the person who went.
  await withEnv(async ({ db, deps }) => {
    const result = await bindAccount(deps, { accountId: 'account:o1', personId: TARGET }, answering(true).confirm);
    assert.deepEqual(result, { status: 'merged', person: TARGET, removed: OTHER });
    assert.equal(db.prepare("SELECT subject_id FROM claims WHERE id = 'claim:other'").get()?.subject_id, TARGET);
    assert.equal(db.prepare("SELECT subject_id FROM episodes WHERE id = 'episode:other'").get()?.subject_id, TARGET);
    assert.equal(
      db.prepare("SELECT person_id FROM affinity_events WHERE id = 'affinity:other'").get()?.person_id,
      TARGET
    );
    assert.equal(personOf(db, 'account:o1'), TARGET);
    assert.equal(personOf(db, 'account:o2'), TARGET);
    assert.equal(db.prepare("SELECT author_person FROM sources WHERE id = 'source:o1'").get()?.author_person, TARGET);
    const merge = db.prepare('SELECT into_person, by FROM people_merges WHERE from_person = ?').get(OTHER);
    assert.equal(merge?.into_person, TARGET);
    assert.equal(merge?.by, 'owner');
    const gone = db.prepare('SELECT status, meta FROM people WHERE id = ?').get(OTHER);
    assert.equal(gone?.status, `merged_into:${TARGET}`);
    assert.equal(gone?.meta, 0);
  });
});

test('on yes the memory model joins the two descriptions of a field with the target first', async () => {
  // Bug: the target ends with two current descriptions of one field, loses its own text, or a field only the other
  // person had is dropped.
  await withEnv(async ({ db, llm, deps }) => {
    await bindAccount(deps, { accountId: 'account:o1', personId: TARGET }, answering(true).confirm);
    assert.equal(llm.calls.length, 1);
    const call = llm.calls[0];
    assert.equal(call?.options.role, 'memory');
    assert.equal(call?.options.purpose, 'description-merge');
    const [system] = call?.messages ?? [];
    assert.ok(textOf(system?.content).includes('MERGE PROMPT for Ayla'));
    assert.deepEqual(currentText(db, TARGET, 'character'), ['Target character text (also: Other character text)']);
    assert.deepEqual(currentText(db, TARGET, 'style'), ['Other style text']);
    // The other person's own character stays with the alias as history, never current for the target.
    assert.equal(
      db.prepare("SELECT subject_id FROM descriptions WHERE id = 'desc:other:character'").get()?.subject_id,
      OTHER
    );
  });
});

test('the target keeps its own affinity score when the other person merges in', async () => {
  // Bug: the merged person's score overwrites the target's, so the person who stays loses how she feels.
  await withEnv(async ({ db, deps }) => {
    await bindAccount(deps, { accountId: 'account:o1', personId: TARGET }, answering(true).confirm);
    assert.equal(db.prepare('SELECT affinity FROM people WHERE id = ?').get(TARGET)?.affinity, 30);
  });
});

test('on no nothing changes and the model is never asked', async () => {
  // Bug: a declined merge still moves rows or spends a model call.
  await withEnv(async ({ db, llm, deps }) => {
    const before = databaseDigest(db);
    const result = await bindAccount(deps, { accountId: 'account:o1', personId: TARGET }, answering(false).confirm);
    assert.deepEqual(result, { status: 'declined', removed: OTHER });
    assert.equal(llm.calls.length, 0);
    assert.deepEqual(databaseDigest(db), before);
  });
});

test('a merge with no way to ask writes nothing', async () => {
  // Bug: a command run with no dialog merges two people without the owner's yes.
  await withEnv(async ({ db, deps }) => {
    const before = databaseDigest(db);
    const result = await bindAccount(deps, { accountId: 'account:o1', personId: TARGET }, null);
    assert.deepEqual(result, { status: 'unconfirmed', removed: OTHER });
    assert.deepEqual(databaseDigest(db), before);
  });
});

test('binding to a person not marked meta is refused before anything is asked', async () => {
  // Bug: an account hangs under a legacy person or an alias, outside the meta-person tree.
  await withEnv(async ({ db, deps }) => {
    const before = databaseDigest(db);
    const { asked, confirm } = answering(true);
    const result = await bindAccount(deps, { accountId: 'account:n1', personId: LEGACY }, confirm);
    assert.deepEqual(result, { status: 'refused', code: 'NOT_META' });
    assert.equal(asked.length, 0);
    assert.deepEqual(databaseDigest(db), before);
  });
});

test('a failed model call writes nothing and says so', async () => {
  // Bug: the merge goes ahead with one description lost, or the failure is silent.
  await withEnv(
    async ({ db, deps }) => {
      const before = databaseDigest(db);
      const result = await bindAccount(deps, { accountId: 'account:o1', personId: TARGET }, answering(true).confirm);
      assert.deepEqual(result, { status: 'failed', code: 'llm_down' });
      assert.deepEqual(databaseDigest(db), before);
    },
    { fail: true }
  );
});

test("the owner's meta-person is never merged into another person", async () => {
  // Bug: binding one of the owner's accounts elsewhere turns the owner into an alias and takes his rights away.
  await withEnv(async ({ db, deps }) => {
    const before = databaseDigest(db);
    const owned: BindDeps = { ...deps, hot: { ...deps.hot, config: { bot: { ownerPerson: OTHER } } } };
    const { asked, confirm } = answering(true);
    const result = await bindAccount(owned, { accountId: 'account:o1', personId: TARGET }, confirm);
    assert.deepEqual(result, { status: 'refused', code: 'OWNER_PERSON' });
    assert.equal(asked.length, 0);
    assert.deepEqual(databaseDigest(db), before);
  });
});

test('an account already under the target is left as it is', async () => {
  // Bug: a repeated bind merges a person into itself or writes a second link.
  await withEnv(async ({ db, deps }) => {
    const before = databaseDigest(db);
    const result = await bindAccount(deps, { accountId: 'account:t1', personId: TARGET }, answering(true).confirm);
    assert.deepEqual(result, { status: 'bound', person: TARGET });
    assert.deepEqual(databaseDigest(db), before);
  });
});
