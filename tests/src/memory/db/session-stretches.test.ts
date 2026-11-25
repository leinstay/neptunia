// The memory session's stretches (src/memory/db/session.ts, session-write.ts, stretches.ts): the request lists the
// stretches of the persona's lines a batch holds, the answer writes one sentence per stretch, and the sentence is an `episodes`
// row of the kind `stretch`. A fake llm and made-up rows only; nothing leaves the process.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { StretchRef } from '../../../../src/memory/db/session-stretches.ts';
import {
  CHANNEL,
  MINUTE,
  NOW,
  channelPlaceOf,
  fixture,
  guildPlaceOf,
  GUILD,
  request,
  textOf,
} from '../../../fixtures/memory-db/session-rig.ts';
import type { Db } from '../../../../src/memory/db/types.ts';

const SALON = channelPlaceOf('c2');

const ago = (minutes: number): number => NOW - minutes * MINUTE;

const addSalon = (db: Db): void => {
  db.prepare(
    "INSERT INTO places (id, iface, kind, native_id, parent_id, scope_kind, name, topic) VALUES (?, 'discord', 'channel', 'c2', ?, 'group', 'salon', NULL)"
  ).run(SALON, guildPlaceOf(GUILD));
};
/** The user content of a built request, and its part after the cached one. */
const userOf = (built: ReturnType<typeof request>): { text: string; tail: string } => {
  const [, user] = built.messages;
  const [, tail] = user.content;
  return { text: textOf(user.content), tail: tail.text };
};
/** The stretches a built request lists. */
const listedOf = (built: ReturnType<typeof request>): Array<StretchRef> => [
  ...(built.maps.stretches ?? new Map<string, StretchRef>()).values(),
];

test('a batch with the persona’s lines in two places lists two stretches with their places and line ranges', () => {
  // Bug: the stretches are cut over every place at once, or their ranges name lines of another place.
  const env = fixture();
  try {
    addSalon(env.db);
    env.say({ native: 'm1', minutesAgo: 100, text: 'Καλημέρα' });
    env.say({ native: 'm2', minutesAgo: 95, text: 'καλημέρα κι εσένα', kind: 'said' });
    env.say({ native: 'm3', minutesAgo: 90, text: 'café?', place: SALON });
    env.say({ native: 'm4', minutesAgo: 85, text: 'ναι', kind: 'said', place: SALON });
    const built = request(env);
    const stretches = [...(built.maps.stretches ?? new Map<string, StretchRef>()).entries()].map(([handle, one]) => ({
      handle,
      placeId: one.placeId,
      at: one.at,
      end: one.end,
      from: one.from,
      to: one.to,
    }));
    assert.deepEqual(stretches, [
      { handle: 's1', placeId: CHANNEL, at: ago(95), end: ago(95), from: 1, to: 2 },
      { handle: 's2', placeId: SALON, at: ago(85), end: ago(85), from: 3, to: 4 },
    ]);
    const { text } = userOf(built);
    assert.ok(text.includes('<stretches>\n[s1] [p1]') && text.includes('[s2] [p2]'), text);
  } finally {
    env.done();
  }
});

test('a silence of the persona of 31 minutes makes two stretches in the request and one of 29 keeps one', () => {
  // Bug: the session cuts with another rule than the day, so a sentence lands on half a conversation.
  for (const [gap, n] of [
    [31, 2],
    [29, 1],
  ] as const) {
    const env = fixture();
    try {
      env.say({ native: 'm1', minutesAgo: 100, text: 'πρώτα', kind: 'said' });
      env.say({ native: 'm2', minutesAgo: 100 - gap, text: 'μετά', kind: 'said' });
      const ranges = listedOf(request(env)).map((one) => [one.from, one.to]);
      assert.deepEqual(
        ranges,
        n === 2
          ? [
              [1, 1],
              [2, 2],
            ]
          : [[1, 2]],
        `a gap of ${gap} minutes`
      );
    } finally {
      env.done();
    }
  }
});

test("the persona's lines in an enabled diary mirror's place are no stretch of the request", () => {
  // Bug: the mirror's copies of diary entries get sentences that no <my_day> line ever reads.
  const env = fixture();
  try {
    addSalon(env.db);
    env.db
      .prepare(
        "INSERT INTO mirrors (id, row_kind, place_id, enabled, created_at, created_by) VALUES ('mirror:salon', 'diary', ?, 1, ?, 'owner')"
      )
      .run(SALON, new Date(ago(1000)).toISOString());
    env.say({ native: 'm1', minutesAgo: 95, text: 'καλημέρα', kind: 'said' });
    env.say({ native: 'm2', minutesAgo: 90, text: 'ημερολόγιο', kind: 'said', place: SALON });
    assert.deepEqual(
      listedOf(request(env)).map((one) => one.placeId),
      [CHANNEL]
    );
  } finally {
    env.done();
  }
});

test('a batch with no line of the persona renders no stretches block', () => {
  // Bug: an empty block is rendered, so every request of a quiet scope changes its bytes.
  const env = fixture();
  try {
    env.say({ native: 'm1', minutesAgo: 100, text: 'Καλημέρα' });
    const built = request(env);
    const { tail } = userOf(built);
    assert.ok(!tail.includes('<stretches>'), tail);
    assert.ok(tail.endsWith('</batch>'), tail);
    assert.deepEqual(listedOf(built), []);
  } finally {
    env.done();
  }
});
