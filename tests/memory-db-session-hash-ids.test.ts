// The ids of the stored items in a memory session's request (src/memory/db/session.ts): her claims about herself, the
// claims about people and places, and the open episodes go by a short hash of the row's own id, `k` and four base-36
// characters, so a chat line's stable names (`:e2:`, `[sticker s1]`) never share a token with a stored item. The hash
// is injected as `hash` (row id -> base-36 text), as `rng` and `now` are elsewhere. Synthetic content only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { batchOf, buildSessionRequest, scopesOf, validateAnswer } from '../src/memory/db/session.ts';
import * as memoryIds from '../src/memory/db/ids.ts';
import {
  ADA,
  MINUTE,
  NOW,
  baseConfig,
  chat,
  fixture,
  personOf,
  prompts,
  textOf,
} from './fixtures/memory-db/session-rig.ts';

type Env = ReturnType<typeof fixture>;

const HASHES: Record<string, string> = {
  'cl-self': 'q7m2ab90',
  'cl-ada': 'w8n4cd12',
  'ep-1': 'r5t6ef34',
};
const fakeHash = (table: Record<string, string>) => (id: string) => table[id] ?? 'zzzz0000';

function stored(env: Env): void {
  chat(env);
  env.claim({
    id: 'cl-self',
    subjectKind: 'self',
    subjectId: memoryIds.SELF_PERSON,
    kind: 'self_fact',
    text: 'keeps a small garden',
  });
  env.claim({ id: 'cl-ada', subjectId: personOf(ADA), text: 'likes café mornings' });
  env.db
    .prepare(
      "INSERT INTO episodes (id, kind, subject_id, date, what, feeling, status, scope_kind, scope_iface) VALUES ('ep-1', 'profile', ?, '2026-10-10', 'Ada helped with the move', 'warm', 'open', 'group', 'discord')"
    )
    .run(personOf(ADA));
}

function requestWith(env: Env, hash?: (id: string) => string) {
  const scope = scopesOf(env.db)[0];
  const batch = batchOf(env.db, scope.scope, {
    cursor: 0,
    since: null,
    maxMessages: 200,
    settleBefore: NOW - 10 * MINUTE,
  });
  const given = { db: env.db, scope, batch, config: baseConfig(), prompts, selfName: 'Nep', now: NOW };
  return buildSessionRequest(hash ? { ...given, hash } : given);
}

const idOf = (map: Map<string, string>, rowId: string): string | undefined =>
  [...map.entries()].find(([, id]) => id === rowId)?.[0];

test('her own claim is printed and mapped under its hash id', () => {
  // Bug: `s1` of `<self>` is the same token as the stable name of a sticker in the batch.
  const env = fixture();
  try {
    stored(env);
    const built = requestWith(env, fakeHash(HASHES));
    assert.equal(built.maps.claims.get('kq7m2'), 'cl-self');
    assert.match(textOf(built.messages[1].content), /<self>\n\[kq7m2\] self_fact: keeps a small garden/);
  } finally {
    env.done();
  }
});

test("a person's claim is printed and mapped under its hash id", () => {
  // Bug: `c1` of `<people>` is a numbered id a mis-copy moves onto the neighbouring claim.
  const env = fixture();
  try {
    stored(env);
    const built = requestWith(env, fakeHash(HASHES));
    assert.equal(built.maps.claims.get('kw8n4'), 'cl-ada');
    assert.match(textOf(built.messages[1].content), /\[kw8n4\] interest: likes café mornings/);
  } finally {
    env.done();
  }
});

test('an open episode is printed and mapped under its hash id', () => {
  // Bug: `e1` of `<episodes>` is the same token as the stable name of a custom emoji, `:e1:`.
  const env = fixture();
  try {
    stored(env);
    const built = requestWith(env, fakeHash(HASHES));
    assert.deepEqual([...built.maps.episodes.entries()], [['kr5t6', 'ep-1']]);
    assert.match(textOf(built.messages[1].content), /\[kr5t6\] 2026-10-10 Ada: Ada helped with the move/);
  } finally {
    env.done();
  }
});

test('a row keeps its id in a later request that shows one more claim before it', () => {
  // Bug: a numbered id follows the row's rank, so the same claim is `c1` in one request and `c2` in the next.
  const env = fixture();
  try {
    stored(env);
    const first = idOf(requestWith(env).maps.claims, 'cl-ada');
    env.claim({ id: 'cl-ada-2', subjectId: personOf(ADA), text: 'reads poetry aloud' });
    env.db.prepare("UPDATE claims SET last_seen_at = '2026-10-21' WHERE id = 'cl-ada-2'").run();
    const second = idOf(requestWith(env).maps.claims, 'cl-ada');
    assert.match(first ?? '', /^k[0-9a-z]{4}$/);
    assert.equal(second, first);
  } finally {
    env.done();
  }
});

test('no id has the shape of a letter followed only by digits when the hash is all digits', () => {
  // Bug: an id such as `k1234` reads as a numbered id of another kind.
  const env = fixture();
  try {
    stored(env);
    const built = requestWith(env, () => '12345678');
    const ids = [...built.maps.claims.keys(), ...built.maps.episodes.keys()];
    assert.deepEqual(
      ids.filter((id) => /^[a-z]\d+$/.test(id)),
      []
    );
  } finally {
    env.done();
  }
});

test('two rows whose hashes collide in one request get ids one character longer that differ', () => {
  // Bug: the second row overwrites the first in the map, and an answer about one lands on the other.
  const env = fixture();
  try {
    stored(env);
    const built = requestWith(env, fakeHash({ 'cl-self': 'abcd1xyz', 'cl-ada': 'abcd2xyz', 'ep-1': 'mnop3xyz' }));
    assert.deepEqual(
      [built.maps.claims.get('kabcd1'), built.maps.claims.get('kabcd2'), built.maps.episodes.get('kmnop3')],
      ['cl-self', 'cl-ada', 'ep-1']
    );
  } finally {
    env.done();
  }
});

test('an answer naming an id one character off an issued one is refused as unknown', () => {
  // Bug: a mis-copied id is matched to the nearest issued id and the confirm lands on another claim.
  const env = fixture();
  try {
    stored(env);
    const built = requestWith(env, fakeHash(HASHES));
    const { plan, counts } = validateAnswer(
      { claims: [{ op: 'confirm', id: 'kw8n5', sources: ['#1'] }] },
      { maps: built.maps, people: built.people }
    );
    assert.deepEqual([plan.claims, counts.dropped], [[], { unknown_id: 1 }]);
  } finally {
    env.done();
  }
});

test('an answer naming an old numbered id is refused as unknown', () => {
  // Bug: `s1` from a stale habit of the model still resolves to her first claim.
  const env = fixture();
  try {
    stored(env);
    const built = requestWith(env, fakeHash(HASHES));
    const { plan, counts } = validateAnswer(
      {
        claims: [
          { op: 'confirm', id: 's1', sources: ['#1'] },
          { op: 'confirm', id: 'c1', sources: ['#1'] },
        ],
      },
      { maps: built.maps, people: built.people }
    );
    assert.deepEqual([plan.claims, counts.dropped], [[], { unknown_id: 2 }]);
  } finally {
    env.done();
  }
});

test('an answer naming an issued hash id resolves to its row', () => {
  // Bug: the answer's id is read through another map than the one the request printed.
  const env = fixture();
  try {
    stored(env);
    const built = requestWith(env, fakeHash(HASHES));
    const { plan } = validateAnswer(
      { claims: [{ op: 'confirm', id: 'kq7m2', sources: ['#1'] }] },
      { maps: built.maps, people: built.people }
    );
    assert.deepEqual(
      plan.claims.map((entry) => entry.id),
      ['cl-self']
    );
  } finally {
    env.done();
  }
});
