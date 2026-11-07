// The memory session writes an alias of a place as it writes one of a person, and the name index finds it under
// the place's audience: a group room's in the groups of its interface, a direct chat's in that chat only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sweep } from '../src/memory/db/session.ts';
import { dmContext, groupContext } from '../src/memory/db/scope.ts';
import { namesOf } from '../src/memory/db/names.ts';
import {
  ADA,
  BOB,
  CHANNEL,
  baseConfig,
  chat,
  ctxOf,
  dmPlaceOf,
  fakeLlm,
  fixture,
  memoryBlock,
  personOf,
} from './fixtures/memory-db/session-rig.ts';

// Place aliases (plan 2026-11-06, slice 9 c): a place alias goes through the session as a person's does and the name
// index reads it under the place's audience.
const DM_ADA = { scope_kind: 'dm', scope_iface: 'discord', scope_dm: personOf(ADA) };
const placeNode = (placeId: string): string => `place:${placeId}`;
const aliasOf = (place: string, text: string, sources: Array<string>) => ({
  op: 'add',
  subject: 'place',
  place,
  kind: 'alias',
  text,
  how: 'said',
  sources,
});
const DM_ADA_KEY = 'dm:discord:person:discord:u-ada';
/** Ada's direct chat as a stored place and two lines in it, the second hers, for a session of that scope alone. */
function dmChat(env: ReturnType<typeof fixture>): void {
  env.db
    .prepare(
      "INSERT INTO places (id, iface, kind, native_id, conversation, scope_kind, partner_account, partner_person) VALUES (?, 'discord', 'dm', ?, 'dm', 'dm', ?, ?)"
    )
    .run(dmPlaceOf(ADA), ADA, `discord:${ADA}`, personOf(ADA));
  env.say({
    native: 'd1',
    minutesAgo: 50,
    text: 'we call this chat the Κήπος',
    scope: DM_ADA,
    place: dmPlaceOf(ADA),
    direct: 1,
  });
  env.say({
    native: 'd2',
    minutesAgo: 45,
    text: 'the Κήπος it is',
    scope: DM_ADA,
    place: dmPlaceOf(ADA),
    kind: 'said',
  });
}

test('a session answer with a place alias writes a claim with subject_kind place', async () => {
  const env = fixture();
  try {
    chat(env);
    const llm = fakeLlm(() => memoryBlock({ claims: [aliasOf('p1', 'Αγορά', ['#1'])] }));
    const result = await sweep(ctxOf(env, { llm, config: baseConfig({ mode: 'apply' }) }));
    assert.equal(result.runs[0].outcome, 'ok');
    const rows = env.db.prepare("SELECT subject_kind, subject_id, kind, text FROM claims WHERE author = 'her'").all();
    assert.deepEqual(
      rows.map((row) => [row.subject_kind, row.subject_id, row.kind, row.text]),
      [['place', CHANNEL, 'alias', 'Αγορά']]
    );
  } finally {
    env.done();
  }
});

test("a group room's alias from a session is found by namesOf in a group context of its interface", async () => {
  const env = fixture();
  try {
    chat(env);
    const llm = fakeLlm(() => memoryBlock({ claims: [aliasOf('p1', 'Αγορά', ['#1'])] }));
    await sweep(ctxOf(env, { llm, config: baseConfig({ mode: 'apply' }) }));
    const hits = namesOf(env.db, groupContext('discord'), ['Αγορά']).filter((hit) => hit.nodeId === placeNode(CHANNEL));
    assert.deepEqual(
      hits.map((hit) => [hit.kind, hit.match]),
      [['alias', 'exact']]
    );
  } finally {
    env.done();
  }
});

test("a direct chat's alias from a session is found by namesOf in that chat only, never in the group or another chat", async () => {
  const env = fixture();
  try {
    dmChat(env);
    const llm = fakeLlm(() => memoryBlock({ claims: [aliasOf('p1', 'Κήπος', ['#1'])] }));
    const result = await sweep(ctxOf(env, { llm, config: baseConfig({ mode: 'apply' }) }), {
      scope: DM_ADA_KEY,
      ignoreSweepCap: true,
    });
    assert.equal(result.runs[0].outcome, 'ok');
    const node = placeNode(dmPlaceOf(ADA));
    const found = (ctx: Parameters<typeof namesOf>[1]): Array<string> =>
      namesOf(env.db, ctx, ['Κήπος'])
        .filter((hit) => hit.nodeId === node)
        .map((hit) => hit.kind);
    assert.deepEqual(found(dmContext(personOf(ADA), 'discord', dmPlaceOf(ADA))), ['alias'], 'read in its own chat');
    assert.deepEqual(found(groupContext('discord')), [], 'never in the group');
    assert.deepEqual(found(dmContext(personOf(BOB), 'discord', dmPlaceOf(BOB))), [], 'never in another chat');
  } finally {
    env.done();
  }
});
