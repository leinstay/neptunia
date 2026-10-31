// Her task tools (src/tools/impl/board.ts): `board.propose` files a dev task on the board as `proposed`, with her
// evidence as its description and `persona:self` as its requester, and `board.status` reads back the tasks filed for
// her with their questions and reviews. The core's board runs her calls as the builtin principal `persona`, whose
// only board role is `persona` whatever clients.json says, so she never approves, reviews or merges. Neither tool is
// granted to her in the tracked config. A memory database in memory, a fake clock, the operations' environment with a
// real board and no other subsystem.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openMemoryDb } from '../src/memory/db/open.js';
import { openBoard } from '../src/board/board.ts';
import type { Board, BoardSettings, Handoff, TaskRecord } from '../src/board/board.ts';
import { BoardError } from '../src/board/machine.ts';
import type { BoardDb } from '../src/board/schema.ts';
import { runOp } from '../src/tools/impl/index.ts';
import { createOpsEnv } from '../src/tools/impl/env.ts';
import { SKILL_DEFINITIONS } from '../src/tools/definitions.ts';
import { grantedToPersona } from '../src/tools/access.ts';
import { createDiscordInterface } from '../interfaces/discord/index.js';
import { withCapturedLogs } from './fixtures/capture-logs.js';
import { tempDir } from './fixtures/tmp.js';

const NOW = Date.parse('2026-10-31T10:00:00.000Z');
const SELF_ID = '900';
const SETTINGS: BoardSettings = {
  leaseTtlMinutes: 30,
  autoTriage: { role: 'dev', budget: 4, steps: 80, estimate: 30 },
  projects: {},
};
const HANDOFF: Handoff = {
  result: 'The tag is read.',
  evidence: [],
  artifacts: [],
  tests: [],
  open_issues: [],
};
const REPO = fileURLToPath(new URL('..', import.meta.url));

// open.js types its connection as `object`; it is node:sqlite's DatabaseSync, which has every method BoardDb names.
const dbOf = (handle: { db: object }): BoardDb => handle.db as BoardDb;

type Result = { status: string; code?: string | null; summary?: string; data?: unknown };

/**
 * A board whose clients are an owner, a worker and a client that tries to pass for her (`persona` with `owner`), and
 * the operations' environment over it.
 */
function setUp(t: { after: (fn: () => void) => void }): {
  board: Board;
  propose: (args: Record<string, unknown>, extra?: Record<string, unknown>) => Promise<Result>;
  status: () => Promise<Result>;
} {
  const dir = tempDir('nep-tools-board-');
  const clients = {
    boss: { kind: 'agent', tokenFile: 'clients/boss.token', permissions: [], boardRoles: ['owner'] },
    hand: { kind: 'agent', tokenFile: 'clients/hand.token', permissions: [], boardRoles: ['worker'] },
    persona: { kind: 'agent', tokenFile: 'clients/persona.token', permissions: [], boardRoles: ['owner'] },
  };
  fs.writeFileSync(path.join(dir, 'clients.json'), JSON.stringify(clients));
  const handle = openMemoryDb(':memory:');
  t.after(() => handle.close());
  const board = openBoard({
    db: dbOf(handle),
    privateDir: dir,
    now: () => NOW,
    settings: () => SETTINGS,
    builtins: { persona: ['persona'] },
  });
  const hot = {
    config: { bot: { owners: ['42'], access: {} }, features: {} },
    prompts: { labels: {} },
    rootDir: tempDir('nep-tools-board-root-'),
    reloadConfig: () => true,
  };
  const env = createOpsEnv({
    discord: createDiscordInterface().capabilities,
    hot,
    store: { state: { data: {}, markDirty() {} } },
    client: { channels: { cache: new Map() } },
    spontaneous: {},
    calibrator: { ratio: 1 },
    getGuildId: () => 'g1',
    board,
    now: () => NOW,
  });
  // Her own call on an inner turn: nobody asks, the actor is the persona.
  const context = (extra: Record<string, unknown> = {}) => ({
    env,
    guildId: 'g1',
    channelId: 'c1',
    userId: null,
    roleIds: [],
    actor: 'persona',
    ...extra,
  });
  return {
    board,
    propose: async (args, extra = {}) =>
      (await withCapturedLogs(() => runOp('board.propose', args, context(extra)))).result,
    status: async () => (await withCapturedLogs(() => runOp('board.status', {}, context()))).result,
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** The id of the task a propose answered, from its data `{ task }`. */
function proposedId(result: Result): string {
  assert.equal(result.status, 'ok', result.summary ?? '');
  assert.ok(isRecord(result.data) && isRecord(result.data.task) && typeof result.data.task.id === 'string');
  return result.data.task.id;
}

/** The entries of a status answer's data `{ tasks: [{ task, questions, reviews }] }`. */
function statusEntries(
  result: Result
): Array<{ task: TaskRecord; questions: Array<unknown>; reviews: Array<unknown> }> {
  assert.equal(result.status, 'ok', result.summary ?? '');
  assert.ok(isRecord(result.data) && Array.isArray(result.data.tasks), 'the data lists tasks');
  // board.status answers one entry per task filed for her, each with the board's TaskRecord and its rows.
  return result.data.tasks as Array<{ task: TaskRecord; questions: Array<unknown>; reviews: Array<unknown> }>;
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
    return 'ok';
  } catch (error) {
    if (error instanceof BoardError) return error.code;
    throw error;
  }
}

test('board.propose files a proposed dev task with her as requester and her evidence as its description', async (t) => {
  const { board, propose } = setUp(t);
  const id = proposedId(
    await propose({ title: 'Read the new tag', evidence: 'Three replies today dropped the tag the owner asked for.' })
  );
  const task = board.call('boss', 'task.show', { id }).task;
  assert.equal(task.status, 'proposed');
  assert.equal(task.lane, 'dev');
  assert.equal(task.requester, 'persona:self');
  assert.equal(task.title, 'Read the new tag');
  assert.equal(task.description, 'Three replies today dropped the tag the owner asked for.');
});

test('board.propose without evidence is invalid and files nothing beside the proposal that had it', async (t) => {
  const { board, propose } = setUp(t);
  const filed = proposedId(await propose({ title: 'With evidence', evidence: 'Dropped three times.' }));
  assert.equal((await propose({ title: 'Read the new tag' })).status, 'invalid');
  assert.deepEqual(
    board.call('boss', 'task.list', {}).map((task) => task.id),
    [filed]
  );
});

test('board.propose retried under the idempotency key of her call files one task', async (t) => {
  const { board, propose } = setUp(t);
  const args = { title: 'Read the new tag', evidence: 'Dropped three times.' };
  const first = proposedId(await propose(args, { idempotencyKey: 'turn-7:0' }));
  const again = proposedId(await propose(args, { idempotencyKey: 'turn-7:0' }));
  assert.equal(again, first);
  assert.equal(board.call('boss', 'task.list', {}).length, 1);
});

test('board.status lists only the tasks filed for her, with the review that rejected one and its note', async (t) => {
  const { board, propose, status } = setUp(t);
  const mine = proposedId(await propose({ title: 'Read the new tag', evidence: 'Dropped three times.' }));
  board.call('boss', 'task.add', { title: "the owner's own", lane: 'dev', project: 'core' });
  board.call('boss', 'task.approve', { id: mine, scope: 'plan', decision: 'reject', note: 'Not this week.' });
  const entries = statusEntries(await status());
  assert.deepEqual(
    entries.map((entry) => entry.task.id),
    [mine]
  );
  assert.equal(entries[0]?.task.status, 'rejected');
  const review = entries[0]?.reviews[0];
  assert.ok(isRecord(review));
  assert.equal(review.decision, 'reject');
  assert.equal(review.note, 'Not this week.');
});

test('board.status shows a question a worker addressed to her on her task', async (t) => {
  const { board, propose, status } = setUp(t);
  const mine = proposedId(await propose({ title: 'Read the new tag', evidence: 'Dropped three times.' }));
  const proposed = board.call('boss', 'task.show', { id: mine }).task;
  const triaged = board.call('boss', 'task.transition', {
    id: mine,
    status: 'triaged',
    revision: proposed.revision,
    set: { role: 'dev', estimate: 20, budget: 2 },
  });
  board.call('boss', 'task.approve', { id: triaged.id, scope: 'plan' });
  const held = board.call('hand', 'task.claim', { id: mine });
  board.call('hand', 'task.ask', {
    id: mine,
    generation: held.lease_generation,
    to_whom: 'persona:self',
    text: 'Which channel showed it?',
  });
  const question = statusEntries(await status())[0]?.questions[0];
  assert.ok(isRecord(question));
  assert.equal(question.text, 'Which channel showed it?');
  assert.equal(question.answered_at, null);
});

test('board.status answers an empty list when she has filed nothing', async (t) => {
  const { status } = setUp(t);
  assert.deepEqual(statusEntries(await status()), []);
});

test('her board principal never approves, reviews or merges, even when clients.json names a persona owner', (t) => {
  const { board } = setUp(t);
  const added = board.call('boss', 'task.add', { title: 'a plan', lane: 'dev', project: 'core' });
  const triaged = board.call('boss', 'task.transition', {
    id: added.id,
    status: 'triaged',
    revision: added.revision,
    set: { role: 'dev', estimate: 20, budget: 2 },
  });
  assert.equal(
    codeOf(() => board.call('persona', 'task.approve', { id: triaged.id, scope: 'plan' })),
    'forbidden'
  );
  assert.equal(board.call('boss', 'task.show', { id: triaged.id }).task.status, 'triaged');
  const work = board.call('boss', 'task.add', {
    title: 'work',
    lane: 'dev',
    project: 'core',
    auto: true,
    no_brief: true,
  });
  const held = board.call('hand', 'task.claim', { id: work.id });
  board.call('hand', 'task.submit', { id: work.id, generation: held.lease_generation, handoff: HANDOFF });
  assert.equal(
    codeOf(() => board.call('persona', 'task.review', { id: work.id, decision: 'accept' })),
    'forbidden'
  );
  assert.equal(
    codeOf(() => board.call('persona', 'task.approve', { id: work.id, scope: 'merge' })),
    'forbidden'
  );
  assert.equal(board.call('boss', 'task.show', { id: work.id }).task.status, 'needs_validation');
});

test('her task tools exist and the tracked config grants neither to her', () => {
  const names = SKILL_DEFINITIONS.map((definition) => definition.name);
  assert.ok(names.includes('board.propose'));
  assert.ok(names.includes('board.status'));
  // PR 7c: the shipped settings live in config/config.json.
  const tracked: unknown = JSON.parse(fs.readFileSync(path.join(REPO, 'config', 'config.json'), 'utf8'));
  assert.equal(grantedToPersona(tracked, SELF_ID, 'board.propose'), false);
  assert.equal(grantedToPersona(tracked, SELF_ID, 'board.status'), false);
});

test('board.propose answers failed board-unavailable when the core has no board', async () => {
  const hot = {
    config: { bot: { owners: ['42'], access: {} }, features: {} },
    prompts: { labels: {} },
    rootDir: tempDir('nep-tools-board-root-'),
    reloadConfig: () => true,
  };
  const env = createOpsEnv({
    discord: createDiscordInterface().capabilities,
    hot,
    store: { state: { data: {}, markDirty() {} } },
    client: { channels: { cache: new Map() } },
    spontaneous: {},
    calibrator: { ratio: 1 },
    getGuildId: () => 'g1',
    board: null,
  });
  const { result } = await withCapturedLogs(() =>
    runOp('board.propose', { title: 'x', evidence: 'y' }, { env, guildId: 'g1', userId: null, actor: 'persona' })
  );
  const answer = result as Result;
  assert.equal(answer.status, 'failed');
  assert.equal(answer.code, 'board-unavailable');
});
