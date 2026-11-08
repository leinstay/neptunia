// A DM nobody linked to a person: every line has no `scope_dm`, because the place names no partner person. The memory
// session sweeps it by the audience of its lines, so someone who only ever talks to her in a DM still leaves her with
// something learned, and the DM's scope and cursor outlive a later link, so none of its lines is read twice. Synthetic ids
// and text only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { auditMemory } from '../src/memory/db/audit.ts';
import { linkOwnerAccount } from '../src/memory/db/identity-links.ts';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { observationOf } from '../src/memory/db/observe-event.ts';
import { observe } from '../src/memory/db/observe.ts';
import { linkAccount } from '../src/memory/db/person-links.ts';
import { cursorKey, scopesOf, sweep } from '../src/memory/db/session.ts';
import type { SweepScope } from '../src/memory/db/session.ts';
import { applyMemoryWrite } from '../src/memory/db/session-write.ts';
import { dbOf } from '../src/memory/db/types.ts';
import type { Db, MemoryHandle } from '../src/memory/db/types.ts';
import { CLI_PLACE, CURSOR_KEY, productionWorld } from './fixtures/memory-audit-production.ts';
import { HOUR, baseConfig, ctxOf, fakeLlm, fixture, memoryBlock, textOf } from './fixtures/memory-db/session-rig.ts';
import type { Fixture } from './fixtures/memory-db/session-shapes.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const REPAIR = path.join(ROOT, 'scripts', 'memory-repair-audit.ts');
const PLACE = 'chat:dm:n7';
const AUDIENCE = 'aud:dm:chat:dm:n7';
const ACCOUNT = 'chat:n7';
const LINKED = 'person:0p4que';
const FIRST_AT = Date.parse('2026-10-24T02:00:00.000Z');

/** One line of the DM, `n` minutes after the first, from the partner. */
function say(handle: MemoryHandle, n: number, text = 'a synthetic line'): void {
  const at = FIRST_AT + n * 60_000;
  const envelope = observationOf(
    {
      kind: 'message.received',
      iface: 'chat',
      at,
      chat: { id: 'n7', kind: 'dm', chatType: 'dm', partnerId: 'n7' },
      message: { id: `line-${n}`, at, content: text, author: { id: 'n7', name: 'someone' } },
    },
    { connection: 'conn:chat', direct: true }
  );
  assert.ok(envelope);
  assert.equal(observe(handle, envelope, { now: () => at }).ok, true);
}

const dmScopes = (db: Db): Array<SweepScope> =>
  scopesOf(db, { audienceColumn: true }).filter((one) => one.scope.scope_iface === 'chat');

const onlyScope = (db: Db): SweepScope => {
  const scopes = dmScopes(db);
  assert.equal(scopes.length, 1);
  return scopes[0];
};

const applying = baseConfig({ mode: 'apply' });

/** A sweep that answers with `plan`; returns the texts of the requests it sent. */
async function swept(env: Fixture, plan: unknown = {}): Promise<Array<string>> {
  const llm = fakeLlm(() => memoryBlock(plan));
  const result = await sweep(ctxOf(env, { llm, config: applying }), { ignoreSweepCap: true });
  for (const run of result.runs) assert.equal(run.errors?.length ?? 0, 0, String(run.errors));
  return llm.calls.map((call) => textOf(call.messages[1]?.content));
}

test('a DM with no link is one scope that reads its lines, under its audience, with no person to its name', () => {
  // Bug: a triple with no partner names no audience, so the sweep drops the DM and she never learns from it.
  const env = fixture();
  try {
    say(env.handle, 1);
    say(env.handle, 2);
    const rows = env.db.prepare('SELECT DISTINCT scope_dm, audience_id FROM sources WHERE place_id = ?').all(PLACE);
    assert.deepEqual(
      rows.map((row) => ({ ...row })),
      [{ scope_dm: null, audience_id: AUDIENCE }]
    );
    const scope = onlyScope(env.db);
    assert.equal(scope.audienceId, AUDIENCE);
    assert.equal(scope.scope.scope_dm, null);
    assert.equal(scope.ctx.place, PLACE);
  } finally {
    env.done();
  }
});

test('a DM place with no partner account and no partner person is no scope', () => {
  // Boundary: nothing says who the DM is with, so nothing can be learned about them.
  const env = fixture();
  try {
    say(env.handle, 1);
    env.db.exec('PRAGMA foreign_keys = OFF');
    env.db.prepare('UPDATE places SET partner_account = NULL WHERE id = ?').run(PLACE);
    assert.deepEqual(dmScopes(env.db), []);
  } finally {
    env.done();
  }
});

test('a session on a DM with no link keeps what it learned in that DM, and the audit stays clean', async () => {
  // Bug: the row takes the spelled person of a place, or falls to internal, and the DM's own next turn cannot read it.
  const env = fixture();
  try {
    say(env.handle, 1, 'I keep bees on the roof');
    const before = auditMemory(env.db).findings;
    const requests = await swept(env, {
      claims: [
        { op: 'add', subject: 'self', kind: 'self_fact', text: 'heard about the bees', how: 'said', sources: ['#1'] },
      ],
    });
    assert.equal(requests.length, 1);
    assert.match(requests[0], /bees on the roof/);
    const row = env.db
      .prepare("SELECT scope_kind, scope_iface, scope_dm, audience_id FROM claims WHERE text = 'heard about the bees'")
      .get();
    assert.deepEqual({ ...row }, { scope_kind: 'dm', scope_iface: 'chat', scope_dm: null, audience_id: AUDIENCE });
    assert.equal(auditMemory(env.db).findings, before);
    assert.deepEqual(await swept(env), [], 'a second sweep reads nothing');
  } finally {
    env.done();
  }
});

test('a session on a DM with no link reads no claim of another DM', async () => {
  // Bug: a run with no partner runs under an internal context, which reads and confirms every row of the memory.
  const env = fixture();
  try {
    say(env.handle, 1);
    env.db.exec(`
      INSERT INTO places (id, iface, kind, chat, scope_kind, partner_person, partner_account)
        VALUES ('chat:dm:other', 'chat', 'dm', 'dm', 'dm', 'person:chat:other', NULL);
      INSERT INTO audiences (id, kind, iface, place_id) VALUES ('aud:dm:chat:dm:other', 'dm', 'chat', 'chat:dm:other');
      INSERT INTO claims (id, subject_kind, subject_id, kind, text, how, author, truth, shown, created_at, audience_id, scope_kind, scope_iface, scope_dm)
        VALUES ('claim:elsewhere', 'self', 'person:self', 'self_fact', 'told in another chat', 'said', 'her', 'current', 1, '2026-10-24T00:00:00.000Z', 'aud:dm:chat:dm:other', 'dm', 'chat', 'person:chat:other');
    `);
    const requests = await swept(env);
    assert.doesNotMatch(requests[0], /told in another chat/);
    applyMemoryWrite(env.handle, {
      kind: 'session',
      mode: 'apply',
      run: {
        id: 'run:probe',
        scopeKey: 'probe',
        scope: { scope_kind: 'dm', scope_iface: 'chat', scope_dm: null },
        audienceId: AUDIENCE,
        startedAt: '2026-10-24T03:00:00.000Z',
        finishedAt: '2026-10-24T03:00:00.000Z',
        outcome: 'ok',
      },
      plan: { claims: [{ op: 'confirm', id: 'claim:elsewhere', sources: [] }] },
      now: FIRST_AT + HOUR,
    });
    const claim = env.db.prepare("SELECT last_seen_at FROM claims WHERE id = 'claim:elsewhere'").get();
    assert.equal(claim?.last_seen_at, null, 'a confirm from this DM does not reach another DM');
  } finally {
    env.done();
  }
});

/** The DM swept once over two lines, then a third line after `link` ran. */
async function assertLinkKeepsTheScope(env: Fixture, link: () => void): Promise<void> {
  say(env.handle, 1);
  say(env.handle, 2);
  assert.equal((await swept(env)).length, 1);
  const before = onlyScope(env.db);
  const cursor = env.db.prepare('SELECT value FROM meta WHERE key = ?').get(cursorKey('apply', before.key))?.value;
  assert.ok(Number(cursor) > 0);
  link();
  say(env.handle, 3, 'a line after the link');

  const after = onlyScope(env.db);
  assert.equal(after.key, before.key, 'the link leaves the scope where it was');
  assert.equal(after.ctx.person, LINKED);
  assert.deepEqual(
    env.db
      .prepare('SELECT DISTINCT scope_dm, audience_id FROM sources WHERE place_id = ?')
      .all(PLACE)
      .map((row) => ({ ...row })),
    [{ scope_dm: LINKED, audience_id: AUDIENCE }],
    'every line of the DM names the person now, in the audience it had'
  );
  const requests = await swept(env);
  assert.equal(requests.length, 1);
  assert.match(requests[0], /a line after the link/);
  assert.doesNotMatch(requests[0], /a synthetic line/, 'the lines already read are not read again');
}

test('a later link by the owner reads no line of the DM twice', async () => {
  // Bug: the key of the scope follows the partner, the new key starts at cursor 0, and the whole DM is summarised again.
  const env = fixture();
  try {
    await assertLinkKeepsTheScope(env, () => {
      linkOwnerAccount(env.db, ACCOUNT, LINKED, '2026-10-24T03:00:00.000Z');
    });
  } finally {
    env.done();
  }
});

test('a link the next line finds reads no line of the DM twice, and the earlier lines take the person', async () => {
  // Bug: a place fills its partner from the account when the next line arrives, and the lines before it fork the DM.
  const env = fixture();
  try {
    await assertLinkKeepsTheScope(env, () => {
      env.db.prepare("INSERT OR IGNORE INTO people (id, first_seen_at) VALUES (?, '2026-10-24')").run(LINKED);
      linkAccount(env.db, ACCOUNT, LINKED, '2026-10-24T03:00:00.000Z', { by: 'owner', reason: 'a test link' });
    });
  } finally {
    env.done();
  }
});

test('the repair moves the cursor kept under the place to the key of the scope, and the furthest cursor wins', async () => {
  // Bug: a cursor left under a key the sweep no longer walks is lost, the scope starts at 0 and the DM is read again.
  const held = JSON.stringify({ from: 1, to: 2, tries: 1 });
  const file = await productionWorld((raw) => {
    const put = raw.prepare('INSERT INTO meta (key, value) VALUES (?, ?)');
    put.run(`memory_session.cursor.apply.dm:cli:${CLI_PLACE}`, '999999');
    put.run(`memory_session.pending.apply.dm:cli:${CLI_PLACE}`, held);
  });
  const done = spawnSync(process.execPath, [REPAIR, '--db', file, '--apply'], { cwd: ROOT, encoding: 'utf8', env: {} });
  assert.equal(done.status, 0, done.stderr);
  assert.equal((JSON.parse(done.stdout) as { cursorsMoved: number }).cursorsMoved, 2);
  const handle = openMemoryDb(file, { readOnly: true });
  try {
    const meta = dbOf(handle).prepare('SELECT value FROM meta WHERE key = ?');
    assert.equal(meta.get(CURSOR_KEY)?.value, '999999');
    assert.equal(meta.get('memory_session.pending.apply.dm:cli:person:cli:owner')?.value, held);
    assert.equal(meta.get(`memory_session.cursor.apply.dm:cli:${CLI_PLACE}`), undefined);
    assert.equal(meta.get(`memory_session.pending.apply.dm:cli:${CLI_PLACE}`), undefined);
  } finally {
    handle.close();
  }
});
