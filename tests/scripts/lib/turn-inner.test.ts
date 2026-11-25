// The inner turn of a replay (scripts/lib/turn-inner.ts): the wakes a stored inner turn ran for, read from its wake
// run, and the parameters the drain passes `runTurn` for them, rebuilt by the drain's own steps over the copy.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DatabaseSync } from 'node:sqlite';
import { copyFacts, innerParamsOf, storedWakeRun } from '../../../scripts/lib/turn-inner.ts';
import { stageOf, storedTurn } from '../../../scripts/lib/turn-stage.ts';
import { createReads } from '../../../src/interface/reads.ts';
import type { Intention } from '../../../src/intentions/types.ts';
import { freshMemoryDb } from '../../fixtures/memory-db-copy.ts';
import { tempDir } from '../../fixtures/tmp.ts';

type Db = InstanceType<typeof DatabaseSync>;

const START = Date.parse('2026-03-04T10:02:30.000Z');
const SILENT = { info() {}, warn() {}, error() {}, debug() {} };

/** A stored inner turn `turnId` that ran for `wakes` (id, kind, payload) at START, as the drain records it. */
function seedRun(
  db: Db,
  turnId: string,
  wakes: Array<{ id: string; kind: string; payload: Record<string, unknown> }>,
  inputs: { intentions?: Array<string>; facts?: Array<string>; placeId?: string | null } = {}
): void {
  const placeId = inputs.placeId ?? null;
  db.prepare(
    `INSERT INTO day (id, at, what, place_id, turn_id, scope_iface, extra) VALUES (?, ?, 'turn.start', ?, ?, 'discord', ?)`
  ).run(
    `day:${turnId}`,
    new Date(START + 4).toISOString(),
    placeId === null ? null : `discord:channel:${placeId}`,
    turnId,
    JSON.stringify({ mode: 'inner', trigger: { kind: 'inner', messageId: null, authorId: null, wake: wakes[0].kind } })
  );
  db.prepare(
    `INSERT INTO wake_runs (id, kind, trigger, started_at, status, inputs, policy_version) VALUES (?, ?, ?, ?, 'succeeded', ?, 1)`
  ).run(
    turnId,
    wakes[0].kind,
    wakes[0].id,
    new Date(START).toISOString(),
    JSON.stringify({
      wakes: wakes.map((wake) => wake.id),
      intentions: (inputs.intentions ?? []).map((id) => ({ id, updatedAt: START - 1 })),
      facts: inputs.facts ?? [],
      placeId,
    })
  );
  const row = db.prepare(
    `INSERT INTO wakes (id, kind, due_at, queued_at, payload, state, turn_id, attempt, claimed_at) VALUES (?, ?, ?, ?, ?, 'handled', ?, 1, ?)`
  );
  for (const wake of wakes)
    row.run(
      wake.id,
      wake.kind,
      START - 1000,
      START - 1000,
      JSON.stringify({ ...wake.payload, id: wake.id }),
      turnId,
      START
    );
}

const heartbeat = {
  id: 'inner.wake:heartbeat:1',
  kind: 'heartbeat',
  payload: { kind: 'heartbeat', reason: 'heartbeat', intentionIds: [], chainId: 'heartbeat:1', dueAt: START - 1000 },
};

/** The parameters of `turnId` rebuilt over `db`, every place of discord served from it. */
async function paramsOf(db: Db, turnId: string, intentionOf: (id: string) => Intention | null = () => null) {
  const turn = storedTurn(db, turnId);
  const stage = stageOf({
    db,
    dataDir: tempDir('nep-inner-'),
    turn,
    selfId: 'self',
    now: () => START,
    tmpDir: tempDir('nep-inner-tmp-'),
  });
  let n = 0;
  return innerParamsOf(storedWakeRun(db, turnId), {
    hot: { config: { wakes: { mode: 'shadow' } } },
    dataDir: tempDir('nep-inner-life-'),
    reads: createReads(stage.port, SILENT, () => null),
    port: stage.port,
    iface: 'discord',
    intentionOf,
    uuid: () => `harness-${(n += 1)}`,
    now: () => START,
  });
}

test('refuses a stored turn that has no wake run', () => {
  const handle = freshMemoryDb();
  assert.throws(() => storedWakeRun(handle.db as Db, 't-none'), /no wake run/);
  handle.close();
});

test('rebuilds a heartbeat turn nowhere, under the stored turn id, with its wake read at the run start', async () => {
  // Catches: the replay builds the wake at the turn row's time or under a turn id of its own.
  const handle = freshMemoryDb();
  const db = handle.db as Db;
  seedRun(db, 't-hhhh-1', [heartbeat]);
  const { params } = await paramsOf(db, 't-hhhh-1');
  const { wake } = params.inner;
  assert.deepEqual(
    [params.chat, params.mode, params.journalTurn, wake.kind, wake.now],
    [null, 'inner', { turnId: 't-hhhh-1', attemptId: 1 }, 'heartbeat', START]
  );
  handle.close();
});

test('shows the intention a due wake served as the copy stores it, though it is closed now', async () => {
  // Catches: the drain's open-only lookup on today's copy drops an intention the turn ran for and has closed since.
  const handle = freshMemoryDb();
  const db = handle.db as Db;
  const due = {
    id: 'inner.wake:intention_due:i1:1',
    kind: 'intention_due',
    payload: { kind: 'intention_due', reason: 'due', intentionIds: ['i1'], chainId: 'i1', dueAt: START - 1000 },
  };
  seedRun(db, 't-iiii-1', [due], { intentions: ['i1'] });
  const closed = { id: 'i1', status: 'done', purpose: 'p', updatedAt: START + 5000 } as unknown as Intention;
  const { params } = await paramsOf(db, 't-iiii-1', (id) => (id === 'i1' ? closed : null));
  const { wake } = params.inner;
  assert.deepEqual(
    wake.intentions.map((record) => record.id),
    ['i1']
  );
  handle.close();
});

test('carries the facts a feedback wake was queued with, untold, though the copy has told them since', async () => {
  // Catches: a feedback turn replayed on today's state, whose facts are told or gone, shows no facts at all.
  const handle = freshMemoryDb();
  const db = handle.db as Db;
  const feedback = {
    id: 'inner.wake:feedback:t-before',
    kind: 'feedback',
    payload: {
      kind: 'feedback',
      reason: 'feedback',
      intentionIds: [],
      chainId: 'c1',
      dueAt: START - 1000,
      placeId: null,
      dmChat: false,
      turnId: 't-before',
      facts: [{ kind: 'callFailed', code: 'unavailable' }],
      factIds: ['fx-1'],
    },
  };
  seedRun(db, 't-ffff-1', [feedback], { facts: ['fx-1'] });
  const { params } = await paramsOf(db, 't-ffff-1');
  const { wake } = params.inner;
  const [item] = wake.items as Array<{ facts?: Array<{ kind?: unknown; code?: unknown }> }>;
  assert.deepEqual(
    (item.facts ?? []).map((fact) => [fact.kind, fact.code]),
    [['callFailed', 'unavailable']]
  );
  handle.close();
});

test('runs a feedback turn in the stored place its wake names, found through the reads', async () => {
  // Catches: an inner turn with a place replayed nowhere, so its request lacks the chat it ran in.
  const handle = freshMemoryDb();
  const db = handle.db as Db;
  db.prepare(
    `INSERT INTO places (id, iface, kind, native_id, scope_kind) VALUES ('discord:guild:800', 'discord', 'guild', '800', 'group')`
  ).run();
  db.prepare(
    `INSERT INTO places (id, iface, kind, native_id, scope_kind, chat, parent_id) VALUES ('discord:channel:900', 'discord', 'channel', '900', 'group', 'group', 'discord:guild:800')`
  ).run();
  const feedback = {
    id: 'inner.wake:feedback:t-before',
    kind: 'feedback',
    payload: {
      kind: 'feedback',
      reason: 'feedback',
      intentionIds: [],
      chainId: 'c1',
      dueAt: START - 1000,
      placeId: '900',
      dmChat: false,
      here: '900',
      turnId: 't-before',
      facts: [],
      factIds: [],
    },
  };
  seedRun(db, 't-ffff-2', [feedback], { placeId: '900' });
  const { params } = await paramsOf(db, 't-ffff-2');
  assert.deepEqual([params.chat, params.inner.currentChannel], [{ iface: 'discord', chatId: '900' }, '900']);
  handle.close();
});

test('shows a chat the facts of the copy as they stood at the turn, untold, and none kept after it', () => {
  // Catches: a reply turn replayed with the runner's own empty facts, where the live turn read the inner life's.
  const handle = freshMemoryDb();
  const db = handle.db as Db;
  const fact = (id: string, at: number, told: number | null) => ({
    id,
    kind: 'callFailed',
    code: 'unavailable',
    placeId: '900',
    dmChat: false,
    at,
    scopePlaceId: null,
    chat: { iface: 'discord', chatId: '900' },
    ...(told === null ? {} : { told }),
  });
  db.prepare("INSERT INTO operational (kind, owner, value) VALUES ('inner', 'persona:local', ?)").run(
    JSON.stringify({ facts: [fact('fx-told-later', START - 10, START + 10), fact('fx-later', START + 5, null)] })
  );
  const facts = copyFacts(db, { iface: 'discord', now: () => START });
  assert.deepEqual(
    facts.pending({ placeId: '900', dmChat: false }).map((one) => one.id),
    ['fx-told-later']
  );
  facts.markTold(['fx-told-later']);
  assert.deepEqual(facts.pending({ placeId: '900', dmChat: false }), []);
  handle.close();
});
