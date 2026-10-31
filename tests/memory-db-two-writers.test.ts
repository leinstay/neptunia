// The memory database has two writers of one member's profile (spec 2026-10-31-memory-two-writers): her memory
// session (src/memory/db/session-write.js) and the unit sync of the store's cached file (src/memory/db/upsert.js). Each
// test runs a session write, then a unit flush of the same file through the store, then reads the profile back the
// way her turns read it (`store.getUser`, export.js#exportOne). What the session wrote must survive the flush and be
// in the profile. Two suspects of the same shape close the file: the diary's fetched text and an observation's update
// of an account. Synthetic data only (Greek or accented Latin for non-ASCII); the ids are made up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createMemoryDb } from '../src/memory/db/service.js';
import { openMemoryDb } from '../src/memory/db/open.js';
import { exportOne } from '../src/memory/db/export.js';
import { applyDiaryUpdate } from '../src/memory/db/diary-media.js';
import { observe } from '../src/memory/db/observe.js';
import { createStore } from '../src/memory/store.js';
import { relationshipStaleOf, strongestMoves } from '../src/memory/affinity.js';
import { seedUnits } from './fixtures/memory-db/seed.js';
import { CHANNEL, GUILD, MEMBER, seen, writeJson, writeLines } from './fixtures/memory-db/datadir.js';
import { tempDir } from './fixtures/tmp.js';

type Row = Record<string, unknown>;
type Statement = {
  all(...params: Array<unknown>): Array<Row>;
  get(...params: Array<unknown>): Row | undefined;
};
type Db = { prepare(sql: string): Statement };
type Move = { ts?: unknown; reason?: unknown; appliedDelta?: unknown; delta?: unknown };
type Item = { itemId?: unknown; text?: unknown; topic?: unknown; what?: unknown; lastSeen?: unknown };
type Profile = {
  details?: Array<Item>;
  interests?: Array<Item>;
  episodes?: Array<Item>;
  character?: unknown;
  relationship?: unknown;
  relationshipScore?: unknown;
  relationshipWrittenAt?: unknown;
  affinity?: { score?: unknown; reason?: unknown; history?: Array<Move> };
};
type Scope = { scope_kind: string; scope_iface: string; scope_dm: string | null };

const NOW = Date.parse('2026-10-31T12:00:00.000Z');
const AT = new Date(NOW).toISOString();
const quiet = { info(): void {}, debug(): void {}, warn(): void {}, error(): void {} };
const PERSON = `person:discord:${MEMBER}`;
const USER_REL = `guilds/${GUILD}/users/${MEMBER}.json`;
const PRIVATE_REL = `guilds/${GUILD}/private/${MEMBER}.json`;
const GROUP: Scope = { scope_kind: 'group', scope_iface: 'discord', scope_dm: null };
const DM: Scope = { scope_kind: 'dm', scope_iface: 'discord', scope_dm: PERSON };
const GROUP_LINE = '400000000000000001';
const DM_LINE = '400000000000000005';
const DIARY_POST = 'd-1';

/** The stored profile of the member: two details, an empty interest list, one episode, two texts, one old move. */
const PROFILE = {
  id: MEMBER,
  names: ['Ada'],
  firstSeen: '2026-09-01T00:00:00.000Z',
  lastSeen: '2026-10-29T00:00:00.000Z',
  messageCount: 10,
  details: [
    {
      itemId: 'det-cafe',
      text: 'drinks a café at nine',
      weight: 1,
      firstSeen: '2026-09-01T00:00:00.000Z',
      lastSeen: '2026-09-02T00:00:00.000Z',
    },
    {
      itemId: 'det-sea',
      text: 'swims in the sea',
      weight: 1,
      firstSeen: '2026-09-01T00:00:00.000Z',
      lastSeen: '2026-09-03T00:00:00.000Z',
    },
  ],
  interests: [],
  episodes: [
    {
      itemId: 'ep-file',
      date: '2026-09-05',
      what: 'told the story of a long swim',
      weight: 1,
      addedAt: '2026-09-05T00:00:00.000Z',
    },
  ],
  character: 'Calm, answers slowly.',
  relationship: 'We talk about the sea.',
  relationshipWrittenAt: '2026-10-01T00:00:00.000Z',
  relationshipScore: 10,
  affinity: {
    score: 10,
    reason: 'shared a swim story',
    history: [{ ts: '2026-09-20T00:00:00.000Z', delta: 2, appliedDelta: 2, score: 10, reason: 'shared a swim story' }],
  },
};

/** The memory units of the scene, written as files, seeded into the database and taken off the disk again. */
function seededDataDir(): string {
  const data = path.join(tempDir('memdb-two-writers-'), 'data');
  const guild = path.join(data, 'guilds', GUILD);
  const files = [
    path.join(guild, 'users', `${MEMBER}.json`),
    path.join(guild, 'private', `${MEMBER}.json`),
    path.join(guild, 'channels', `${CHANNEL}.json`),
    path.join(guild, 'diary.json'),
    path.join(guild, 'record', '2026-10', '2026-10-30.jsonl'),
    path.join(guild, 'private', MEMBER, 'record', '2026-10', '2026-10-30.jsonl'),
  ] as const;
  writeJson(files[0], PROFILE);
  writeJson(files[1], { details: [], interests: [], episodes: [] });
  writeJson(files[2], {
    id: CHANNEL,
    name: 'γενικά',
    messageCount: 1,
    firstMessageAt: null,
    lastMessageAt: null,
    days: {},
  });
  writeJson(files[3], {
    updatedAt: NOW - 86_400_000,
    posts: [
      {
        at: NOW - 86_400_000,
        kind: 'day',
        gist: 'a quiet day',
        picture: null,
        messageIds: ['500000000000000001'],
        search: null,
        itemId: DIARY_POST,
      },
    ],
  });
  writeLines(files[4], [seen(GROUP_LINE, 1, 'Πάμε για μπάνιο αύριο;')]);
  writeLines(files[5], [
    seen(DM_LINE, 1, 'a private plan for the winter', { scope: { channel: '200000000000000099' }, direct: true }),
  ]);
  const handle = openMemoryDb(path.join(data, 'memory.db'));
  try {
    assert.equal(seedUnits(handle, data, { now: () => NOW - 86_400_000 }).errors, 0);
  } finally {
    handle.close();
  }
  for (const file of files) fs.rmSync(file);
  return data;
}

/** The node:sqlite connection of a handle (open.js and service.js are untyped JS; both hand out `{ db }`). */
const dbOf = (handle: unknown): Db => (handle as { db: Db }).db;

/** The real service over `data`, on the calling thread, opened; `iface` is the live interface it stamps unit writes with. */
async function openService(data: string, iface: string | null = null) {
  const hot = { config: { memoryDb: { session: { mode: 'off' } } }, prompts: {} };
  const service = createMemoryDb({
    hot,
    dataDir: data,
    log: quiet,
    worker: false,
    now: () => NOW,
    defer: (fn: () => void) => setImmediate(fn),
    iface: () => iface,
  });
  await service.tick();
  await service.tick();
  assert.ok(service.readHandle(), 'the database is open');
  return service;
}

type Service = Awaited<ReturnType<typeof openService>>;

/** One scene: the seeded data directory, the service over it and the store whose cached files the sync writes. */
async function scene(iface: string | null = null) {
  const data = seededDataDir();
  const service = await openService(data, iface);
  let ids = 0;
  const store = createStore({ dataDir: data, newId: () => `id-${(ids += 1)}`, memoryDb: service });
  const db = () => dbOf(service.readHandle());
  const sourceOf = (native: string): string => {
    const row = db().prepare('SELECT id FROM sources WHERE native_id = ? AND retired_at IS NULL').get(native);
    assert.ok(row && typeof row.id === 'string', `the line ${native} is stored`);
    return row.id;
  };
  return { data, service, store, db, sourceOf, done: () => service.close() };
}

/** Every cached file the store holds goes to the database, and the writes have landed. */
async function flush(store: ReturnType<typeof createStore>): Promise<void> {
  store.flush();
  await store.flushSettled({});
}

/** The member's profile as a store that caches nothing yet reads it: the database's view, as the next start sees it. */
function freshProfile(data: string, service: Service, userId = MEMBER): Profile {
  // store.js is untyped JS; `getUser` returns the user file's value, whose shape is the user mapper's (map/user.js).
  return createStore({ dataDir: data, memoryDb: service }).getUser(GUILD, userId) as Profile;
}

/** The member's profile as the store her turns use holds it, its cache included. */
function liveProfile(store: ReturnType<typeof createStore>, userId: string): Profile {
  // store.js is untyped JS; `getUser` returns the user file's value, whose shape is the user mapper's (map/user.js).
  return store.getUser(GUILD, userId) as Profile;
}

/** One JSON unit rebuilt from the database alone (export.js#exportOne). */
function exported(service: Service, rel: string): Profile {
  const out = exportOne(service.readHandle(), rel);
  assert.ok(out.found, `the unit ${rel} is in the database`);
  // exportOne's value is the unit's JSON (`any` in its JSDoc); for a users or private file it is a profile.
  return out.value as Profile;
}

let runs = 0;

/** One applied run of her memory session in `scope`; `plan` is laid over an empty plan. */
function sessionApply(service: Service, plan: Record<string, Array<Record<string, unknown>>>, scope = GROUP) {
  runs += 1;
  const id = `run-two-writers-${runs}`;
  // memoryWrite is untyped JS; a session write resolves to its counts (session-write.js#applyMemoryWrite).
  return service.memoryWrite({
    kind: 'session',
    mode: 'apply',
    now: NOW,
    maxDelta: 5,
    run: {
      id,
      sweepId: `sweep-${id}`,
      scopeKey: scope.scope_kind === 'dm' ? `dm:discord:${PERSON}` : 'group:discord',
      scope,
      batchKey: `apply|${id}`,
      startedAt: AT,
      finishedAt: AT,
      outcome: 'ok',
      counts: {},
      errors: [],
    },
    plan: { claims: [], episodes: [], affinity: [], descriptions: [], people: [], ...plan },
  }) as Promise<Record<string, number>>;
}

const texts = (items: Array<Item> | undefined, key: 'text' | 'topic' | 'what'): Array<unknown> =>
  (items ?? []).map((item) => item[key]);

test("F1: her session's attitude moves end the profile's history after a flush, so the moves can be shown and counted", async () => {
  const env = await scene();
  try {
    assert.ok(env.store.getUser(GUILD, MEMBER), 'the profile is cached');
    env.store.touchUser(GUILD, MEMBER, 'Ada', NOW);
    const groupLine = env.sourceOf(GROUP_LINE);
    const first = await sessionApply(env.service, {
      affinity: [{ personId: PERSON, delta: 3, reason: 'helped with the boat', sources: [groupLine] }],
    });
    const second = await sessionApply(env.service, {
      affinity: [{ personId: PERSON, delta: -1, reason: 'was curt about the trip', sources: [groupLine] }],
    });
    assert.deepEqual([first.affinity, second.affinity], [1, 1], 'both moves were applied');
    await flush(env.store);

    for (const [name, profile] of [
      ['a fresh store', freshProfile(env.data, env.service)],
      ['the export', exported(env.service, USER_REL)],
    ] as const) {
      const history = profile.affinity?.history ?? [];
      assert.deepEqual(
        history.slice(-2).map((move) => [move.ts, move.reason]),
        [
          [AT, 'helped with the boat'],
          [AT, 'was curt about the trip'],
        ],
        `${name}: the history ends with her two moves`
      );
      // strongestMoves returns the history entries it picked, typed `object[]` in its JSDoc.
      const shown = strongestMoves(history, {
        max: 3,
        currentReason: typeof profile.affinity?.reason === 'string' ? profile.affinity.reason : '',
      }) as Array<Move>;
      assert.ok(
        shown.some((move) => move.reason === 'helped with the boat'),
        `${name}: the earlier move can be shown`
      );
      const stale = relationshipStaleOf(
        {
          text: typeof profile.relationship === 'string' ? profile.relationship : '',
          score: typeof profile.affinity?.score === 'number' ? profile.affinity.score : 0,
          writtenScore: typeof profile.relationshipScore === 'number' ? profile.relationshipScore : 0,
          writtenAt: typeof profile.relationshipWrittenAt === 'string' ? profile.relationshipWrittenAt : '',
          history,
        },
        { rewriteOnBandChange: false, rewriteOnDrift: 0, rewriteAfterMoves: 2 }
      );
      assert.equal(stale?.cause, 'moves', `${name}: the two moves since the text count for a rewrite`);
    }
  } finally {
    await env.done();
  }
});

test('F3: a description review is the profile text after a flush, and the review stays the current version', async () => {
  const env = await scene();
  const descriptionId = `desc:${PERSON}:character`;
  const reviewId = `${descriptionId}:review-1`;
  const reviewed = 'Calm, answers slowly, and laughs at her own jokes.';
  try {
    assert.ok(env.store.getUser(GUILD, MEMBER), 'the profile is cached');
    await env.service.memoryWrite({
      kind: 'description',
      mode: 'apply',
      row: { id: reviewId, descriptionId, text: reviewed, writtenAt: AT },
      subject: { kind: 'person', id: PERSON, field: 'character' },
      scope: GROUP,
      expectCurrent: `${descriptionId}:legacy`,
      now: NOW,
    });
    env.store.touchUser(GUILD, MEMBER, 'Ada', NOW);
    await flush(env.store);

    assert.equal(freshProfile(env.data, env.service).character, reviewed, 'a fresh store reads the review');
    assert.equal(exported(env.service, USER_REL).character, reviewed, 'the export reads the review');
    assert.equal(
      env.db().prepare('SELECT current_version FROM descriptions WHERE id = ?').get(descriptionId)?.current_version,
      reviewId,
      'the flush left the review current'
    );
  } finally {
    await env.done();
  }
});

test("F4: a revise and a confirm of the file's claims keep the new text and the new last-seen time after a flush", async () => {
  const env = await scene();
  const revised = 'drinks a freddo café at ten';
  try {
    assert.ok(env.store.getUser(GUILD, MEMBER), 'the profile is cached');
    const groupLine = env.sourceOf(GROUP_LINE);
    const counts = await sessionApply(env.service, {
      claims: [
        {
          op: 'revise',
          id: 'det-cafe',
          text: revised,
          how: 'said',
          sources: [groupLine],
          reason: 'she said it herself',
        },
        { op: 'confirm', id: 'det-sea', sources: [groupLine] },
      ],
    });
    assert.deepEqual([counts.revised, counts.confirmed], [1, 1], 'both claim ops were applied');
    env.store.touchUser(GUILD, MEMBER, 'Ada', NOW);
    await flush(env.store);

    for (const [name, profile] of [
      ['a fresh store', freshProfile(env.data, env.service)],
      ['the export', exported(env.service, USER_REL)],
    ] as const) {
      const byId = new Map((profile.details ?? []).map((item) => [item.itemId, item]));
      assert.equal(byId.get('det-cafe')?.text, revised, `${name}: the revised text`);
      assert.equal(byId.get('det-sea')?.lastSeen, AT, `${name}: the confirmed claim was seen now`);
    }
  } finally {
    await env.done();
  }
});

test('F5: claims and an episode her session added are in the profile of their scope, and a private one only there', async () => {
  const env = await scene();
  const interest = 'θάλασσα το πρωί';
  const episode = 'μιλήσαμε για το λιμάνι';
  const secret = 'plans a winter trip alone';
  try {
    const groupLine = env.sourceOf(GROUP_LINE);
    const dmLine = env.sourceOf(DM_LINE);
    const group = await sessionApply(env.service, {
      claims: [
        {
          op: 'add',
          subjectKind: 'person',
          subjectId: PERSON,
          kind: 'interest',
          text: interest,
          how: 'said',
          sources: [groupLine],
          when: null,
        },
      ],
      episodes: [{ subjectId: PERSON, what: episode, feeling: '', sources: [groupLine] }],
    });
    const dm = await sessionApply(
      env.service,
      {
        claims: [
          {
            op: 'add',
            subjectKind: 'person',
            subjectId: PERSON,
            kind: 'detail',
            text: secret,
            how: 'said',
            sources: [dmLine],
            when: null,
          },
        ],
      },
      DM
    );
    assert.deepEqual([group.added, group.episodes, dm.added], [1, 1, 1], 'every op was applied');
    env.store.touchUser(GUILD, MEMBER, 'Ada', NOW);
    env.store.touchPrivateSeen(GUILD, MEMBER, NOW);
    await flush(env.store);

    for (const [name, profile] of [
      ['a fresh store', freshProfile(env.data, env.service)],
      ['the export', exported(env.service, USER_REL)],
    ] as const) {
      assert.ok(texts(profile.interests, 'topic').includes(interest), `${name}: the group interest is shown`);
      assert.ok(texts(profile.episodes, 'what').includes(episode), `${name}: the group episode is shown`);
      assert.ok(
        texts(profile.episodes, 'what').includes('told the story of a long swim'),
        `${name}: the file's episode stays`
      );
      assert.ok(
        !texts(profile.details, 'text').includes(secret),
        `${name}: the private claim stays out of the group profile`
      );
    }
    assert.ok(
      texts(exported(env.service, PRIVATE_REL).details, 'text').includes(secret),
      'the private claim is in the private layer'
    );
  } finally {
    await env.done();
  }
});

test('F6: a move for a person spelled in another interface keeps its score and reason through the flush of a changed profile', async () => {
  const env = await scene('nebula');
  const member = '100000000000000077';
  const person = `person:nebula:${member}`;
  try {
    env.store.touchUser(GUILD, member, 'Νόρα', NOW - 3_600_000);
    await flush(env.store);
    assert.ok(
      env.db().prepare('SELECT 1 AS ok FROM people WHERE id = ?').get(person),
      'the profile is stored under its interface'
    );
    env.store.touchUser(GUILD, member, 'Νόρα', NOW);
    const counts = await sessionApply(env.service, {
      affinity: [{ personId: person, delta: 3, reason: 'brought pastries', sources: [env.sourceOf(GROUP_LINE)] }],
    });
    assert.equal(counts.affinity, 1, 'the move was applied');
    await flush(env.store);

    const row = env.db().prepare('SELECT affinity, affinity_reason FROM people WHERE id = ?').get(person);
    assert.deepEqual([row?.affinity, row?.affinity_reason], [3, 'brought pastries'], 'the stored person');
    for (const [name, profile] of [
      ['the live store', liveProfile(env.store, member)],
      ['a fresh store', freshProfile(env.data, env.service, member)],
    ] as const)
      assert.deepEqual(
        [profile.affinity?.score, profile.affinity?.reason],
        [3, 'brought pastries'],
        `${name}: the score and the reason`
      );
  } finally {
    await env.done();
  }
});

test("F6: a move keeps its reason through the flush of a changed profile in the store's own spelling", async () => {
  const env = await scene();
  try {
    assert.ok(env.store.getUser(GUILD, MEMBER), 'the profile is cached');
    env.store.touchUser(GUILD, MEMBER, 'Ada', NOW);
    const counts = await sessionApply(env.service, {
      affinity: [{ personId: PERSON, delta: 2, reason: 'fixed the net with me', sources: [env.sourceOf(GROUP_LINE)] }],
    });
    assert.equal(counts.affinity, 1, 'the move was applied');
    await flush(env.store);

    const row = env.db().prepare('SELECT affinity, affinity_reason FROM people WHERE id = ?').get(PERSON);
    assert.deepEqual([row?.affinity, row?.affinity_reason], [12, 'fixed the net with me'], 'the stored person');
    for (const [name, profile] of [
      ['the live store', liveProfile(env.store, MEMBER)],
      ['a fresh store', freshProfile(env.data, env.service)],
    ] as const)
      assert.deepEqual(
        [profile.affinity?.score, profile.affinity?.reason],
        [12, 'fixed the net with me'],
        `${name}: the score and the reason`
      );
  } finally {
    await env.done();
  }
});

test("the diary's fetched text survives a flush of the diary file", async () => {
  const data = seededDataDir();
  const handle = openMemoryDb(path.join(data, 'memory.db'));
  try {
    applyDiaryUpdate(handle, { id: DIARY_POST, text: 'Σήμερα ήταν ήσυχα στο λιμάνι.', media: [] });
  } finally {
    handle.close();
  }
  const service = await openService(data);
  try {
    const store = createStore({ dataDir: data, memoryDb: service });
    store.appendDiaryPost(
      GUILD,
      { at: NOW, kind: 'day', gist: 'a windy day', picture: null, messageIds: [], search: '', itemId: 'd-2' },
      { max: 10, now: NOW }
    );
    await flush(store);
    const db = dbOf(service.readHandle());
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM diary WHERE id = 'd-2'").get()?.n, 1, 'the new post is stored');
    assert.equal(
      db.prepare('SELECT text FROM diary WHERE id = ?').get(DIARY_POST)?.text,
      'Σήμερα ήταν ήσυχα στο λιμάνι.'
    );
  } finally {
    await service.close();
  }
});

test("an observation's account kind and place times survive a flush of the member's and the channel's files", async () => {
  const data = seededDataDir();
  const handle = openMemoryDb(path.join(data, 'memory.db'));
  try {
    // observe is untyped JS; it resolves to `{ ok, ... }` or `{ ok: false, code }`.
    const result = observe(
      handle,
      {
        v: 1,
        iface: 'discord',
        authority: 'discord/global',
        native: { kind: 'message', key: '400000000000000033', revision: 1 },
        place: { authority: 'discord/global', key: `channel:${CHANNEL}`, kind: 'channel', conversation: 'group' },
        author: { kind: 'account', key: MEMBER, account_kind: 'bot', display: 'Ada' },
        occurredAt: AT,
        observedAt: AT,
        text: 'beep',
      },
      { now: () => NOW, log: quiet }
    ) as { ok?: unknown };
    assert.equal(result.ok, true, 'the observation is stored');
  } finally {
    handle.close();
  }
  const service = await openService(data);
  try {
    const store = createStore({ dataDir: data, memoryDb: service });
    store.touchUser(GUILD, MEMBER, 'Ada', NOW);
    store.touchChannel(GUILD, CHANNEL, { name: 'γενικά' }, NOW, MEMBER);
    await flush(store);
    const db = dbOf(service.readHandle());
    assert.equal(db.prepare('SELECT kind FROM accounts WHERE id = ?').get(`discord:${MEMBER}`)?.kind, 'bot');
    const place = db
      .prepare('SELECT conversation, seen_to_at FROM places WHERE id = ?')
      .get(`discord:channel:${CHANNEL}`);
    assert.deepEqual([place?.conversation, place?.seen_to_at], ['group', AT], 'the observed place');
  } finally {
    await service.close();
  }
});
