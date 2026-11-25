// The scopes of a memory session (src/memory/db/session-scopes.ts): a DM whose audience names no stored place gives no
// scope, and the context of a DM nobody linked names no person. Synthetic content only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scopesOf } from '../../../../src/memory/db/session.ts';
import { KAI_ACCOUNT, dmAudience, semanticWorld } from '../../../fixtures/memory-db/semantic-world.ts';
import { addDmPlace } from '../../../fixtures/memory-db/opaque-people.ts';
import type { World } from '../../../fixtures/memory-db/semantic-world.ts';
import { observationOf } from '../../../../src/memory/db/observe-event.ts';
import { observe } from '../../../../src/memory/db/observe.ts';
import type { SweepScope } from '../../../../src/memory/db/session.ts';
import { dbOf, type Db, type MemoryHandle } from '../../../../src/memory/db/types.ts';
import { fixture } from '../../../fixtures/memory-db/session-rig.ts';

/** One DM line with `person` in its triple and its audience, if any, written as an older release stored it. */
function addDmLine(world: World, audience: string | null, place: string | null, person: string | null): void {
  if (audience !== null)
    world.db
      .prepare("INSERT OR IGNORE INTO audiences (id, kind, iface, place_id) VALUES (?, 'dm', 'discord', ?)")
      .run(audience, place);
  const at = '2026-11-05T10:00:00.000Z';
  world.db
    .prepare(
      `INSERT INTO sources (id, kind, iface, native_id, revision, place_id, author_kind, occurred_at, recorded_at, text,
        scope_kind, scope_iface, scope_dm, audience_id)
       VALUES (?, 'seen', 'discord', ?, 1, ?, 'account', ?, ?, 'a line', 'dm', 'discord', ?, ?)`
    )
    .run(`src:${person ?? String(place)}`, `m:${person ?? String(place)}`, place, at, at, person, audience);
}

test('the sweep finds no scope for a DM line whose audience names no stored place', () => {
  // Bug: the sweep spells a DM out of the line's person id and reads a chat no stored place holds.
  const world = semanticWorld();
  addDmLine(world, null, null, 'person:discord:n9');
  assert.deepEqual(
    scopesOf(world.db).filter((one) => one.scope.scope_kind === 'dm'),
    []
  );
  world.handle.close();
});

test('the context the sweep reads a DM nobody linked in names no person, and reads that DM', () => {
  // Bug: the context of such a DM is given a person spelled out of its place id, which no row holds.
  const world = semanticWorld();
  addDmPlace(world.db, {
    id: 'place:dm-kai',
    iface: 'discord',
    authority: 'discord/global',
    account: KAI_ACCOUNT,
    person: null,
  });
  addDmLine(world, dmAudience('place:dm-kai'), 'place:dm-kai', null);
  const found = scopesOf(world.db).find((one) => one.audienceId === dmAudience('place:dm-kai'));
  assert.equal(found?.ctx.person, undefined);
  assert.equal(found?.ctx.place, 'place:dm-kai');
  world.handle.close();
});

// A DM nobody linked to a person: every line has no `scope_dm`, because the place names no partner person. The memory
// session sweeps it by the audience of its lines, so someone who only ever talks to the persona in a DM still leaves them with
// something learned, and the DM's scope and cursor outlive a later link, so none of its lines is read twice. Synthetic ids
// and text only.

const PLACE = 'chat:dm:n7';
const AUDIENCE = 'aud:dm:chat:dm:n7';
const ACCOUNT = 'chat:n7';
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
  asBeforeMetaPersons(dbOf(handle));
}

/**
 * A new account gets a meta-person with its first line, so a DM nobody linked arises only
 * from rows written before that release. The core's link of the partner is taken back here, with what it wrote, to
 * keep the DM in that older state. A link written by anyone else stays.
 */
function asBeforeMetaPersons(db: Db): void {
  const core = db
    .prepare("SELECT person_id FROM account_person_links WHERE account_id = ? AND by = 'core' AND valid_to_at IS NULL")
    .get(ACCOUNT);
  if (typeof core?.person_id !== 'string') return;
  db.prepare("DELETE FROM account_person_links WHERE account_id = ? AND by = 'core'").run(ACCOUNT);
  db.prepare('DELETE FROM person_accounts WHERE id = ?').run(ACCOUNT);
  db.prepare('UPDATE accounts SET person_id = NULL, link = NULL, linked_by = NULL, linked_at = NULL WHERE id = ?').run(
    ACCOUNT
  );
  db.prepare('UPDATE places SET partner_person = NULL WHERE id = ?').run(PLACE);
  db.prepare('UPDATE sources SET scope_dm = NULL, author_person = NULL WHERE place_id = ?').run(PLACE);
}

const dmScopes = (db: Db): Array<SweepScope> =>
  scopesOf(db, { audienceColumn: true }).filter((one) => one.scope.scope_iface === 'chat');

const onlyScope = (db: Db): SweepScope => {
  const scopes = dmScopes(db);
  assert.equal(scopes.length, 1);
  return scopes[0];
};

test('a DM with no link is one scope that reads its lines, under its audience, with no person to its name', () => {
  // Bug: a triple with no partner names no audience, so the sweep drops the DM and the persona never learns from it.
  const env = fixture();
  try {
    say(env.handle, 1);
    say(env.handle, 2);
    const rows = env.db.prepare('SELECT DISTINCT scope_dm, audience_id FROM sources WHERE place_id = ?').all(PLACE);
    assert.deepEqual(
      rows.map((row) => ({ ...row })),
      [{ scope_dm: null, audience_id: AUDIENCE }]
    );
    const scopeEntry = onlyScope(env.db);
    assert.equal(scopeEntry.audienceId, AUDIENCE);
    assert.equal(scopeEntry.scope.scope_dm, null);
    assert.equal(scopeEntry.ctx.place, PLACE);
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
