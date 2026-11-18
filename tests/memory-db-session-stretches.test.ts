// The memory session's stretches (src/memory/db/session.ts, session-write.ts, stretches.ts): the request lists the
// stretches of her lines a batch holds, the answer writes one sentence per stretch, and the sentence is an `episodes`
// row of the kind `stretch`. A fake llm and made-up rows only; nothing leaves the process.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sweep, validateAnswer } from '../src/memory/db/session.ts';
import { pendingObjectEmbeds } from '../src/memory/db/object-vectors.ts';
import { mindOf } from '../src/memory/db/mind-read.ts';
import type { MindSettings } from '../src/memory/db/mind-read.ts';
import { storedStretches } from '../src/memory/db/stretches.ts';
import type { StretchRef } from '../src/memory/db/session-stretches.ts';
import { audienceOf, dmContext, groupContext, whereFor } from '../src/memory/db/scope.ts';
import * as memoryIds from '../src/memory/db/ids.ts';
import {
  ADA,
  CHANNEL,
  MINUTE,
  NOW,
  baseConfig,
  channelPlaceOf,
  ctxOf,
  dmPlaceOf,
  fakeLlm,
  fixture,
  guildPlaceOf,
  GUILD,
  memoryBlock,
  personOf,
  request,
  textOf,
} from './fixtures/memory-db/session-rig.ts';
import type { Db } from '../src/memory/db/types.ts';

const SALON = channelPlaceOf('c2');
const config = baseConfig({ mode: 'apply' });
const GROUP = { scope_kind: 'group', scope_iface: 'discord', scope_dm: null };
/** The owner's values of `context.memory`, as the mind-read tests set them. */
const MIND_SETTINGS: MindSettings = {
  windowMessages: 100,
  maxHops: 2,
  maxNodesRead: 2000,
  budgetTokens: 10000,
  shares: { people: 0.5, places: 0.15, lore: 0.15, recent: 0.1, found: 0.1 },
  counterpartTokens: 1500,
  candidatesMax: 3,
  commonWordEntries: 3,
  attitudeMoves: 2,
  interests: 5,
  fanOut: { accounts: 10, memberships: 20, rooms: 10, members: 8, replies: 5, about: 30 },
};
const ago = (minutes: number): number => NOW - minutes * MINUTE;

const addSalon = (db: Db): void => {
  db.prepare(
    "INSERT INTO places (id, iface, kind, native_id, parent_id, scope_kind, name, topic) VALUES (?, 'discord', 'channel', 'c2', ?, 'group', 'salon', NULL)"
  ).run(SALON, guildPlaceOf(GUILD));
};

const stretchRows = (db: Db) =>
  db
    .prepare(
      "SELECT id, place_id, start_ms, last_ms, what, audience_id, subject_id, holder_id, extra FROM episodes WHERE kind = 'stretch' ORDER BY start_ms"
    )
    .all();

/** The user content of request `n` the fake llm was sent. */
const sentOf = (llm: ReturnType<typeof fakeLlm>, n: number): string => {
  const { calls } = llm;
  const [, user] = calls[n].messages;
  return textOf(user.content);
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

test('a batch with her lines in two places lists two stretches with their places and line ranges', () => {
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

test('a silence of hers of 31 minutes makes two stretches in the request and one of 29 keeps one', () => {
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

test("her lines in an enabled diary mirror's place are no stretch of the request", () => {
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

test('a batch with no line of hers renders no stretches block', () => {
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

test("an answer's sentence is stored as a stretch row with its place, moments and the group audience", async () => {
  // Bug: the sentence is dropped, lands on another place, or takes the run's audience instead of its lines'.
  const env = fixture();
  try {
    env.say({ native: 'm1', minutesAgo: 100, text: 'Καλημέρα' });
    env.say({ native: 'm2', minutesAgo: 95, text: 'καλημέρα', kind: 'said' });
    env.say({ native: 'm3', minutesAgo: 80, text: 'τι νέα;', kind: 'said' });
    const llm = fakeLlm(memoryBlock({ stretches: [{ stretch: 's1', what: 'Είπαμε καλημέρα.' }] }));
    const result = await sweep(ctxOf(env, { llm, config }), {});
    const [run] = result.runs;
    assert.equal(run?.outcome, 'ok');
    const rows = stretchRows(env.db);
    assert.equal(rows.length, 1);
    const [row] = rows;
    assert.equal(row?.place_id, CHANNEL);
    assert.equal(row?.start_ms, ago(95));
    assert.equal(row?.last_ms, ago(80));
    assert.equal(row?.what, 'Είπαμε καλημέρα.');
    assert.equal(row?.subject_id, memoryIds.SELF_PERSON);
    assert.equal(row?.audience_id, audienceOf(GROUP).audience_id);
    const read = storedStretches(env.db, whereFor(groupContext('discord'), 'e'), {
      holders: [CHANNEL],
      from: ago(200),
      to: NOW,
    });
    assert.deepEqual(
      read.map((one) => one.what),
      ['Είπαμε καλημέρα.']
    );
  } finally {
    env.done();
  }
});

test("a sentence of a direct chat's stretch is not read under a group context", async () => {
  // Bug: the sentence takes the group audience, so a group turn reads what she talked about in private.
  const env = fixture();
  try {
    env.storeDmPlace(ADA);
    const dm = { scope_kind: 'dm', scope_iface: 'discord', scope_dm: personOf(ADA) };
    env.say({ native: 'd1', minutesAgo: 100, text: 'γεια', place: dmPlaceOf(ADA), scope: dm });
    env.say({ native: 'd2', minutesAgo: 95, text: 'γεια σου', kind: 'said', place: dmPlaceOf(ADA), scope: dm });
    const llm = fakeLlm(memoryBlock({ stretches: [{ stretch: 's1', what: 'Μιλήσαμε ιδιωτικά.' }] }));
    await sweep(ctxOf(env, { llm, config }), {});
    assert.equal(stretchRows(env.db).length, 1);
    const read = (ctx: unknown) =>
      storedStretches(env.db, whereFor(ctx, 'e'), { holders: [dmPlaceOf(ADA)], from: ago(200), to: NOW });
    assert.deepEqual(read(groupContext('discord')), []);
    assert.equal(read(dmContext(personOf(ADA), 'discord', dmPlaceOf(ADA))).length, 1);
  } finally {
    env.done();
  }
});

test('a second batch that continues the stretch replaces the sentence and extends the last moment in one row', async () => {
  // Bug: a continued talk gets a second row, or keeps the old sentence and its old end.
  const env = fixture();
  try {
    env.say({ native: 'm1', minutesAgo: 100, text: 'Καλημέρα' });
    env.say({ native: 'm2', minutesAgo: 95, text: 'καλημέρα', kind: 'said' });
    const llm = fakeLlm([
      memoryBlock({ stretches: [{ stretch: 's1', what: 'ΠΡΩΤΗ' }] }),
      memoryBlock({ stretches: [{ stretch: 's1', what: 'ΔΕΥΤΕΡΗ' }] }),
    ]);
    await sweep(ctxOf(env, { llm, config }), {});
    env.say({ native: 'm3', minutesAgo: 80, text: 'και κάτι ακόμα', kind: 'said' });
    await sweep(ctxOf(env, { llm, config }), { ignoreSweepCap: true });
    assert.equal(llm.calls.length, 2);
    assert.ok(sentOf(llm, 1).includes('ΠΡΩΤΗ'), 'the second request shows the stored sentence');
    const rows = stretchRows(env.db);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.what, 'ΔΕΥΤΕΡΗ');
    assert.equal(rows[0]?.start_ms, ago(95));
    assert.equal(rows[0]?.last_ms, ago(80));
  } finally {
    env.done();
  }
});

test('an unknown handle, an empty sentence and a duplicate are dropped with their codes and the rest is kept', () => {
  // Bug: a bad entry sinks the answer, or a second sentence for one stretch overwrites the first.
  const env = fixture();
  try {
    env.say({ native: 'm1', minutesAgo: 100, text: 'μια', kind: 'said' });
    const built = request(env);
    const long = 'λ'.repeat(5000);
    const { plan, counts } = validateAnswer(
      {
        stretches: [
          { stretch: 's9', what: 'κανένα' },
          { stretch: 's1', what: '  ' },
          { stretch: 's1', what: long },
          { stretch: 's1', what: 'πάλι' },
        ],
        claims: [{ op: 'add', subject: 'self', kind: 'self_fact', text: 'γράφει', how: 'saw', sources: ['#1'] }],
      },
      { maps: built.maps, people: built.people }
    );
    assert.equal(counts.dropped.unknown_stretch, 1);
    assert.equal(counts.dropped.no_text, 1);
    assert.equal(counts.dropped.duplicate_stretch, 1);
    assert.equal(plan.stretches.length, 1);
    const [kept] = plan.stretches;
    assert.ok(String(kept?.what).length < long.length, 'a too long sentence is cut');
    assert.equal(plan.claims.length, 1);
  } finally {
    env.done();
  }
});

/** A finished heartbeat run `id` at `at` with one step of thinking. */
function heartbeat(db: Db, id: string, at: string, think: string): void {
  db.prepare(
    "INSERT INTO wake_runs (id, kind, started_at, finished_at, status, outcome) VALUES (?, 'heartbeat', ?, ?, 'succeeded', 'skip')"
  ).run(id, at, at);
  db.prepare(
    `INSERT INTO model_requests (id, schema_version, turn_id, attempt_id, step, role, status, started_at, messages, think, tool_calls)
     VALUES (?, 1, ?, 'a1', 0, 'core', 'ok', ?, '[]', ?, NULL)`
  ).run(`${id}:0`, id, at, think);
}

test('an own-time batch of two turns lists two stretches and stores a sentence per turn under the group audience', async () => {
  // Bug: two heartbeats share one sentence, or her own time is stored under the internal audience.
  const env = fixture();
  try {
    heartbeat(env.db, 'turn:1', '2026-10-24T09:00:00.000Z', 'Ἀρχή');
    heartbeat(env.db, 'turn:2', '2026-10-24T10:00:00.000Z', 'Τέλος');
    const llm = fakeLlm(
      memoryBlock({
        stretches: [
          { stretch: 's1', what: 'Σκέφτηκα την αρχή.' },
          { stretch: 's2', what: 'Σκέφτηκα το τέλος.' },
        ],
      })
    );
    await sweep(ctxOf(env, { llm, config }), { scopes: new Set(['own:discord']) });
    const sent = sentOf(llm, 0);
    assert.ok(sent.includes('[s1]') && sent.includes('[s2]'), sent);
    const rows = stretchRows(env.db);
    assert.deepEqual(
      rows.map((row) => [
        row.holder_id,
        row.what,
        row.place_id,
        (JSON.parse(String(row.extra)) as { turn: string }).turn,
      ]),
      [
        ['turn:1', 'Σκέφτηκα την αρχή.', null, 'turn:1'],
        ['turn:2', 'Σκέφτηκα το τέλος.', null, 'turn:2'],
      ]
    );
    for (const row of rows) assert.equal(row.audience_id, audienceOf(GROUP).audience_id);
  } finally {
    env.done();
  }
});

test('a stretch row is no episode the vectors embed, so recall never lists it', async () => {
  // Bug: the sentence is embedded as an episode and comes back from memory.search as a remembered moment.
  const env = fixture();
  try {
    env.say({ native: 'm1', minutesAgo: 95, text: 'καλημέρα', kind: 'said' });
    const llm = fakeLlm(memoryBlock({ stretches: [{ stretch: 's1', what: 'Είπα καλημέρα.' }] }));
    await sweep(ctxOf(env, { llm, config }), {});
    assert.equal(stretchRows(env.db).length, 1);
    const pending = pendingObjectEmbeds(env.db, { model: 'x/embed', limit: 100 });
    assert.deepEqual(
      pending.filter((one) => one.kind === 'episode'),
      []
    );
  } finally {
    env.done();
  }
});

test("a stretch row is no recent episode of the place's memory entry", async () => {
  // Bug: the graph raises the sentence as an episode of the place, so <mind> shows it among remembered moments.
  const env = fixture();
  try {
    env.say({ native: 'm1', minutesAgo: 95, text: 'καλημέρα', kind: 'said' });
    const llm = fakeLlm(memoryBlock({ stretches: [{ stretch: 's1', what: 'Είπα καλημέρα.' }] }));
    await sweep(ctxOf(env, { llm, config }), {});
    const [row] = stretchRows(env.db);
    const seeds = { messages: [], counterpart: null, place: CHANNEL, previous: [], candidates: [] };
    const mind = mindOf(env.db, groupContext('discord'), seeds, MIND_SETTINGS, NOW);
    assert.ok(mind.places.length > 0, 'the place is raised');
    assert.deepEqual(
      mind.recent.filter((entry) => entry.episodeId === row?.id),
      []
    );
  } finally {
    env.done();
  }
});
