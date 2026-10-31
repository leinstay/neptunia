// Tests for src/tools/impl/: the typed operations behind the owner commands -- the registry, the rights
// check of runOp, the result shape, and the old command keys of the stored grants (legacyGrantOps).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { listOps, runOp } from '../src/tools/impl/index.ts';
// PR 7b: the old command keys of the stored grants are read in src/config-moves.ts, beside the other old config keys.
import { legacyGrantOps } from '../src/config-moves.ts';
import { createOpsEnv } from '../src/tools/impl/env.ts';
import { createDiscordInterface } from '../interfaces/discord/index.js';
import { tempDir } from './fixtures/tmp.js';
import { createErrandStore } from '../src/errands/store.ts';
import { withCapturedLogs } from './fixtures/capture-logs.js';
import { openMemoryDb } from '../src/memory/db/open.js';
import { openBoard } from '../src/board/board.ts';

// The Discord interface's capabilities object, as src/index.js injects it.
const DISCORD = createDiscordInterface().capabilities;

/** The operation names the commands-cleanup plan agreed on (its wildcards spelled out), `/nep talk` since merged into `message.create`. */
const AGREED = new Set([
  'board.propose',
  'board.status',
  'status.show',
  'config.set',
  'config.unset',
  'bot.pause',
  'bot.resume',
  'draw.create',
  'voice.say',
  'pings.get',
  'pings.set',
  'media.status',
  'media.rescan',
  'media.recache',
  'model.show',
  'model.set',
  'route.list',
  'route.set',
  'route.remove',
  'rule.add',
  'rule.list',
  'rule.remove',
  'access.grant',
  'access.revoke',
  'access.list',
  'alias.add',
  'alias.remove',
  'learning.add',
  'learning.remove',
  'lore.add',
  'lore.list',
  'lore.show',
  'lore.remove',
  'memory.profile.read',
  'memory.channel.read',
  'memory.server.read',
  'memory.recent.read',
  'memory.affinity.read',
  'memory.journal.read',
  'memory.archive.read',
  'memory.restore',
  'memory.snapshot',
  'memory.private.read',
  'message.create',
  'message.edit',
  'message.delete',
  'message.react.add',
  'message.react.remove',
  'errand.run',
  'errand.status',
  'errand.cancel',
  'errand.list',
  'errand.read',
  'errand.resolve',
  'web.search',
  'web.read',
  'media.look',
  'media.find',
  'memory.search',
  'intention.set',
  'intention.update',
  'intention.cancel',
  'intention.list',
  'places.list',
  'tools.describe',
  'conversation.read',
  'inner.stop',
  'inner.start',
  'inner.status',
]);

/** Owner-only per the plan: no grant ever opens them. */
const OWNER_ONLY = [
  'access.grant',
  'access.revoke',
  'access.list',
  'memory.private.read',
  'memory.journal.read',
  'memory.snapshot',
  'memory.archive.read',
  'memory.restore',
  'inner.stop',
  'inner.start',
  'inner.status',
];

function makeEnv({ access = {}, emojiBackfill } = {}) {
  const rootDir = tempDir('nep-ops-');
  fs.mkdirSync(path.join(rootDir, 'prompts'));
  fs.writeFileSync(path.join(rootDir, 'prompts', 'rules.md'), '## Rules\n\n- be kind\n');
  const hot = {
    config: { bot: { owners: ['42'], access }, llm: { model: 'x/y', maxRequestsPerDay: 10 } },
    prompts: { labels: {} },
    promptSources: {},
    promptsDir: path.join(rootDir, 'prompts'),
    localPromptsDir: path.join(rootDir, 'prompts.local'),
    rootDir,
    reloadConfig: () => true,
    reloadPrompts: () => true,
  };
  const store = {
    state: { data: {}, markDirty() {} },
    flush() {},
    getUser: () => null,
    getGuild: () => ({ emojiUsage: {} }),
  };
  return createOpsEnv({
    discord: DISCORD,
    hot,
    store,
    client: {},
    spontaneous: {},
    calibrator: { ratio: 1 },
    getGuildId: () => 'g1',
    emojiBackfill,
  });
}

test('ops: every registered op has a rights kind and a name in the agreed list', () => {
  const ops = listOps();
  assert.ok(ops.length > 0);
  for (const op of ops) {
    assert.ok(AGREED.has(op.name), `${op.name} is not an agreed operation name`);
    assert.ok(op.rights.kind === 'read' || op.rights.kind === 'write', `${op.name} has no rights kind`);
  }
  const byName = new Map(ops.map((op) => [op.name, op]));
  for (const name of AGREED) assert.ok(byName.has(name), `${name} is not registered`);
  for (const name of OWNER_ONLY) assert.equal(byName.get(name).rights.ownerOnly, true, `${name} must be owner-only`);
  assert.equal(byName.get('memory.affinity.read').rights.kind, 'read');
  assert.equal(byName.has('memory.affinity.set'), false, 'the attitude changes through the analyzer alone');
});

test('ops: runOp denies a non-owner on an owner-only op with a code, even under a * grant', async () => {
  const everyone = { everyone: true, roles: [], users: [] };
  const env = makeEnv({ access: { '*': everyone, memory: everyone, access: everyone, 'rule.list': everyone } });
  for (const name of OWNER_ONLY) {
    const result = await runOp(
      name,
      { userId: '7', confirm: 'g1' },
      { env, guildId: 'g1', userId: '999', roleIds: [] }
    );
    assert.equal(result.status, 'denied', name);
    assert.equal(result.code, 'owner-only', name);
    assert.equal(typeof result.summary, 'string');
  }
  // a grant on the operation's own name does open a grantable read
  const open = await runOp('rule.list', {}, { env, guildId: 'g1', userId: '999', roleIds: [] });
  assert.equal(open.status, 'ok');
  // no grant at all: denied, with its own code
  const bare = makeEnv();
  const refused = await runOp('rule.list', {}, { env: bare, guildId: 'g1', userId: '999', roleIds: [] });
  assert.equal(refused.status, 'denied');
  assert.equal(refused.code, 'not-granted');
});

test('ops: runOp returns invalid with a human summary for missing args', async () => {
  const env = makeEnv();
  const owner = { env, guildId: 'g1', userId: '42' };
  const result = await runOp('rule.add', {}, owner);
  assert.equal(result.status, 'invalid');
  assert.equal(typeof result.code, 'string');
  assert.equal(result.summary, 'rule text is required');

  const affinity = await runOp('memory.affinity.set', { userId: '7' }, owner);
  assert.equal(affinity.status, 'invalid', 'a set without a score never falls back to a read');

  const unknown = await runOp('no.such.op', {}, owner);
  assert.equal(unknown.status, 'invalid');
  assert.equal(unknown.code, 'unknown-op');
});

test('ops: an exception becomes failed with its code', async () => {
  const emojiBackfill = {
    run: async () => {
      throw Object.assign(new Error('disk unreadable'), { code: 'EIO' });
    },
  };
  const env = makeEnv({ emojiBackfill });
  const result = await runOp('media.rescan', { kind: 'emoji' }, { env, guildId: 'g1', userId: '42' });
  assert.deepEqual(result, { status: 'failed', code: 'EIO', summary: 'disk unreadable', data: null });

  const plain = makeEnv({
    emojiBackfill: {
      run: async () => {
        throw new Error('boom');
      },
    },
  });
  const other = await runOp('media.rescan', { kind: 'emoji' }, { env: plain, guildId: 'g1', userId: '42' });
  assert.equal(other.status, 'failed');
  assert.equal(other.code, 'error');
});

test('ops: no memory refresh, forget, wipe or purge operation is left', () => {
  const ops = listOps();
  const gone = ['memory.refresh', 'memory.forget', 'memory.wipe', 'memory.private.forget', 'memory.private.purge'];
  assert.deepEqual(
    ops.filter((op) => gone.some((name) => op.name === name || op.name.startsWith(`${name}.`))).map((op) => op.name),
    []
  );
});

test('ops: a stored grant on a command or group that runs no operation any more is dropped', () => {
  for (const key of ['ping', 'reload', 'learned.list', 'removed', 'removed.run'])
    assert.equal(legacyGrantOps(key), null, key);
  assert.deepEqual(legacyGrantOps('status'), { from: null, names: ['status.show'] });
});

// PR 7b: with `/nep` gone no embed is built; the card is its fields, which the chat prints as sections and her call
// reads as lines.
test('status.show answers the card as its fields, with no embed', async () => {
  const env = makeEnv();
  const result = await runOp('status.show', { field: 'features' }, { env, guildId: 'g1', userId: '42', roleIds: [] });
  assert.equal(result.status, 'ok');
  const data = /** @type {{ fields?: Array<{ name: string }> }} */ (result.data);
  assert.deepEqual(
    [Object.hasOwn(data, 'embeds'), (data.fields ?? []).map((field) => field.name)],
    [false, ['features']]
  );
});

// PR 7b: status.show answers the card as its fields, with no embed; the names and values asserted are unchanged.
test('createOpsEnv: the simulator key, the management key and the extra role keys reach the owner status card', async () => {
  const rootDir = tempDir('nep-ops-');
  const costs = {
    keyLead: 'main',
    simKeyLead: 'sim',
    simKeyNotSet: 'sim: not set',
    roleKeyLead: '{roles} key',
    keyLimitPlain: '{lead} {spent}/{limit}',
    keyNonePlain: '{lead} none',
    keyUnavailable: '{lead} unavailable',
  };
  const hot = {
    config: { bot: { owners: ['42'] }, llm: { maxRequestsPerDay: 10, probeTimeoutMs: 50 } },
    prompts: { labels: { status: { costs } } },
    promptSources: {},
    rootDir,
  };
  const store = { state: { data: {}, markDirty() {} }, flush() {} };
  const reads = [];
  const llm = {
    roleKeys: () => [{ roles: ['core'] }],
    async keyInfo(options) {
      reads.push(options.apiKey ?? options.role ?? 'main');
      const limit = options.apiKey ? 5 : options.role ? 200 : 30;
      return { ok: true, status: 200, json: { data: { limit, limit_remaining: limit } } };
    },
    keyHash: ({ role } = {}) => (role ? 'hash-core' : 'hash-main'),
    async activity(options) {
      activity.push([options.apiKey, options.keyHash]);
      return { ok: false, status: 403, json: null };
    },
  };
  const activity = [];
  const env = createOpsEnv({
    discord: DISCORD,
    hot,
    store,
    client: {},
    getGuildId: () => null,
    llm,
    simKey: 'sim-test-key',
    managementKey: 'mgmt-test',
  });
  assert.equal(env.simKey, 'sim-test-key');
  assert.equal(env.managementKey, 'mgmt-test');
  const result = await runOp('status.show', { field: 'keys.base' }, { env, guildId: null, userId: '42', roleIds: [] });
  assert.deepEqual(
    result.data.fields.map((field) => field.name),
    ['keys.base']
  );
  const value = result.data.fields[0].value;
  assert.deepEqual(
    value.split('\n'),
    ['main 0.00/30.00', 'sim 0.00/5.00', 'core key 0.00/200.00'],
    'a failed activity read: the lines as without it'
  );
  assert.deepEqual(reads.sort(), ['core', 'main', 'sim-test-key']);
  const simHash = crypto.createHash('sha256').update('sim-test-key').digest('hex');
  assert.deepEqual(
    activity.sort(),
    [
      ['mgmt-test', 'hash-main'],
      ['mgmt-test', 'hash-core'],
      ['mgmt-test', simHash],
    ].sort(),
    'one activity read per key, by its hash, with the management key'
  );
});

// PR 7b: status.show answers the card as its fields, with no embed; the names and values asserted are unchanged.
test('status keys: a role on the simulator key (here the vision role) is shown on the simulator line, never on a line of its own', async () => {
  const rootDir = tempDir('nep-ops-');
  const costs = {
    keyLead: 'main',
    simKeyLead: 'sim',
    simKeyNotSet: 'sim: not set',
    roleKeyLead: '{roles} key',
    keyLimitPlain: '{lead} {spent}/{limit}',
    keyNonePlain: '{lead} none',
    keyUnavailable: '{lead} unavailable',
  };
  const hot = {
    config: { bot: { owners: ['42'] }, llm: { maxRequestsPerDay: 10, probeTimeoutMs: 50 } },
    prompts: { labels: { status: { costs } } },
    promptSources: {},
    rootDir,
  };
  const store = { state: { data: {}, markDirty() {} }, flush() {} };
  const simHash = crypto.createHash('sha256').update('sim-test-key').digest('hex');
  const reads = [];
  const llm = {
    roleKeys: () => [{ roles: ['dev'] }, { roles: ['vision'] }],
    async keyInfo(options) {
      reads.push(options.apiKey ?? options.role ?? 'main');
      const limit = options.apiKey ? 5 : options.role ? 200 : 30;
      return { ok: true, status: 200, json: { data: { limit, limit_remaining: limit } } };
    },
    keyHash: ({ role } = {}) => (role === 'vision' ? simHash : role ? 'hash-dev' : 'hash-main'),
  };
  const env = createOpsEnv({
    discord: DISCORD,
    hot,
    store,
    client: {},
    getGuildId: () => null,
    llm,
    simKey: 'sim-test-key',
  });
  const result = await runOp('status.show', { field: 'keys.base' }, { env, guildId: null, userId: '42', roleIds: [] });
  const value = result.data.fields[0].value;
  assert.deepEqual(
    value.split('\n'),
    ['main 0.00/30.00', 'sim 0.00/5.00', 'dev key 0.00/200.00'],
    'no line for the vision role: the simulator line is its line'
  );
  assert.deepEqual(reads.sort(), ['dev', 'main', 'sim-test-key'], 'the simulator key is read once');
  const noSim = createOpsEnv({ discord: DISCORD, hot, store, client: {}, getGuildId: () => null, llm });
  const without = await runOp(
    'status.show',
    { field: 'keys.base' },
    { env: noSim, guildId: null, userId: '42', roleIds: [] }
  );
  assert.ok(
    without.data.fields[0].value.split('\n').includes('vision key 0.00/200.00'),
    'with no simulator key on the card, the role keeps a line of its own'
  );
});

// PR 7b: status.show answers the card as its fields, with no embed; the names and values asserted are unchanged.
test("status keys.base and costs.errands: the errand agents' key has no line and no read; their spend comes from the task records, the agents without records show no runs", async () => {
  const rootDir = tempDir('nep-ops-');
  const costs = {
    keyLead: 'main',
    simKeyLead: 'sim',
    simKeyNotSet: 'sim: not set',
    roleKeyLead: '{roles} key',
    roleSeparator: '+',
    keyLimitPlain: '{lead} {spent}/{limit}',
    partSeparator: ' | ',
    agentLine: '{agent}: {parts}',
    agentWindow: '{window} {runs}r {in}/{out} {usd}',
    agentWindows: { today: 'D', last7: 'W', last30: 'M' },
    agentNoRuns: '{agent}: none',
    agentEstimate: 'est.',
  };
  const NOW = Date.parse('2026-10-18T12:00:00Z');
  const config = {
    bot: { owners: ['42'] },
    llm: { maxRequestsPerDay: 10, probeTimeoutMs: 50 },
    agents: { scout: { daily: { tasks: 40 } }, server: { daily: { tasks: 40 } } },
  };
  const hot = { config, prompts: { labels: { status: { costs } } }, promptSources: {}, rootDir };
  const store = { state: { data: {}, markDirty() {} }, flush() {} };
  const reads = [];
  const llm = {
    roleKeys: () => [{ roles: ['server', 'scout'] }, { roles: ['dev', 'thinker'] }],
    async keyInfo(options) {
      reads.push(options.role ?? 'main');
      return {
        ok: true,
        status: 200,
        json: { data: { limit: options.role ? 200 : 30, limit_remaining: options.role ? 200 : 30 } },
      };
    },
  };
  const clock = { t: NOW - 10 * 24 * 60 * 60 * 1000 };
  const tasks = createErrandStore({
    dataDir: tempDir('nep-ops-data-'),
    guildId: 'g1',
    now: () => clock.t,
    config: () => config,
  });
  const run = (agent, usage) => {
    const { errand: task } = tasks.add({
      agent,
      goal: 'look it up',
      requester: { userId: 'u1', kind: 'member' },
      origin: {},
      scope: 'group',
    });
    tasks.start(task.id);
    tasks.finish(task.id, { status: 'done', result: { text: 'ok' }, usage });
  };
  await withCapturedLogs(() => {
    run('scout', { input: 40_000, output: 2_000, usd: 0.5 });
    clock.t = NOW;
    run('scout', { input: 12_400, output: 3_100, usd: 0.12 });
    run('server', { input: 1_000, output: 100, usd: 0.01 });
  });
  const errands = { store: (guildId) => (guildId === 'g1' ? tasks : null) };
  const env = createOpsEnv({ discord: DISCORD, hot, store, client: {}, getGuildId: () => 'g1', llm, errands });
  const card = async (field) =>
    (await runOp('status.show', { field }, { env, guildId: 'g1', userId: '42', roleIds: [] })).data.fields;

  const [keys] = await card('keys.base');
  assert.deepEqual(
    keys.value.split('\n'),
    ['main 0.00/30.00', 'sim: not set', 'dev+thinker key 0.00/200.00'],
    'the development key stays, the agents key is gone'
  );
  assert.deepEqual(reads.sort(), ['dev', 'main'], 'the agents key is not read');

  const [agents] = await card('costs.errands');
  assert.equal(agents.name, 'costs.errands');
  assert.deepEqual(agents.value.split('\n'), [
    'scout: D 1r 12k/3.1k 0.12 | W 1r 12k/3.1k 0.12 | M 2r 52k/5.1k 0.62',
    'server: D 1r 1.0k/100 0.01 | W 1r 1.0k/100 0.01 | M 1r 1.0k/100 0.01',
    'est.',
  ]);
  assert.deepEqual(
    tasks.today('scout'),
    { tasks: 1, usd: 0.12, caps: { tasks: 40 } },
    'the scout cap reads the same today'
  );

  const noErrands = createOpsEnv({ discord: DISCORD, hot, store, client: {}, getGuildId: () => 'g1', llm });
  const [empty] = (
    await runOp('status.show', { field: 'costs.errands' }, { env: noErrands, guildId: 'g1', userId: '42', roleIds: [] })
  ).data.fields;
  assert.deepEqual(
    empty.value.split('\n'),
    ['scout: none', 'server: none', 'est.'],
    'no errands: every agent with no runs'
  );
});

// This test read thinker and dev from the ledger mirror (src/errands/ledger.ts). PR 6e removes the mirror, and the
// card reads the board in memory.db instead: the thinker's runs from board_agent_runs, and dev from the dev-lane
// attempts whose role is an implementing one (dev or writer), whoever ran them, as the ledger counted them. The worker
// runs every attempt under its own principal, so a card keyed by principal would show dev with no runs.
const BOARD_SETTINGS = {
  leaseTtlMinutes: 30,
  autoTriage: { role: 'dev', budget: 4, steps: 80, estimate: 30 },
  projects: {},
};
const COST_LABELS = {
  partSeparator: ' | ',
  agentLine: '{agent}: {parts}',
  agentWindow: '{window} {runs}r {in}/{out} {usd}',
  agentWindows: { today: 'D', last7: 'W', last30: 'M' },
  agentNoRuns: '{agent}: none',
  agentContext: '{agent} wave {wave}: {turns}t ctx {mean}/{peak} {usd}',
  agentEstimate: 'est.',
};

/**
 * The `costs.development` field over a board in memory whose rows `seed` writes.
 * @param {(db: import('../src/board/schema.ts').BoardDb) => void} seed
 * @returns {Promise<Array<string>>}
 */
// PR 7b: status.show answers the card as its fields, with no embed; the names and values asserted are unchanged.
async function developmentField(seed) {
  const now = Date.parse('2026-10-31T10:00:00.000Z');
  const privateDir = tempDir('nep-ops-board-');
  fs.writeFileSync(
    path.join(privateDir, 'clients.json'),
    JSON.stringify({
      thinker: { kind: 'agent', tokenFile: 'clients/thinker.token', permissions: [], boardRoles: ['reviewer'] },
      dispatcher: { kind: 'agent', tokenFile: 'clients/dispatcher.token', permissions: [], boardRoles: ['worker'] },
    })
  );
  const handle = openMemoryDb(':memory:');
  try {
    // open.js types its connection as `object`; it is node:sqlite's DatabaseSync, which has every method BoardDb names.
    const db = /** @type {import('../src/board/schema.ts').BoardDb} */ (handle.db);
    seed(db);
    const board = openBoard({ db, privateDir, now: () => now, settings: () => BOARD_SETTINGS });
    const config = { bot: { owners: ['42'] }, llm: { maxRequestsPerDay: 10 } };
    const hot = {
      config,
      prompts: { labels: { status: { costs: COST_LABELS } } },
      promptSources: {},
      rootDir: tempDir('nep-ops-'),
    };
    const store = { state: { data: {}, markDirty() {} }, flush() {} };
    const env = createOpsEnv({
      discord: DISCORD,
      hot,
      store,
      client: {},
      getGuildId: () => 'g1',
      board,
      now: () => now,
    });
    const answer = await runOp(
      'status.show',
      { field: 'costs.development' },
      { env, guildId: 'g1', userId: '42', roleIds: [] }
    );
    const value = /** @type {{ fields: Array<{ value: string }> }} */ (answer.data).fields[0]?.value;
    return String(value).split('\n');
  } finally {
    handle.close();
  }
}

test("status costs.development: thinker from the board's agent runs, dev from the dev attempts of the worker by role", async () => {
  const lines = await developmentField((db) => {
    db.prepare(
      `INSERT INTO board_tasks (id, lane, title, requester, role, status, created_at, updated_at)
       VALUES ('T-aaaaaa', 'dev', 'a task', 'lead', 'dev', 'done', '2026-10-28T09:00:00.000Z', '2026-10-31T09:00:00.000Z')`
    ).run();
    const attempt = db.prepare(
      `INSERT INTO board_attempts (id, task_id, n, principal, role, started_at, ended_at, tokens_in, tokens_out,
       tokens_reasoning, cost_est_usd, outcome) VALUES (?, 'T-aaaaaa', ?, 'dispatcher', ?, ?, ?, ?, ?, ?, ?, 'done')`
    );
    attempt.run('A-aaaaa1', 1, 'dev', '2026-10-28T10:00:00.000Z', '2026-10-28T11:00:00.000Z', 50000, 3000, 1000, 0.4);
    attempt.run('A-aaaaa2', 2, 'writer', '2026-10-31T08:00:00.000Z', '2026-10-31T08:30:00.000Z', 10000, 800, 200, 0.1);
    db.prepare(
      `INSERT INTO board_agent_runs (id, agent, wave, started_at, ended_at, steps, tokens_in, tokens_out, cost_est_usd,
       context_mean, context_peak) VALUES ('W-aaaaaa', 'thinker', 3, '2026-10-31T09:00:00.000Z',
       '2026-10-31T09:10:00.000Z', 4, 300000, 9000, 1.5, 120000, 210000)`
    ).run();
  });
  assert.deepEqual(lines, [
    'thinker: D 1r 300k/9.0k 1.50 | W 1r 300k/9.0k 1.50 | M 1r 300k/9.0k 1.50',
    'thinker wave 3: 1t ctx 120k/210k 1.50',
    'dev: D 1r 10k/1.0k 0.10 | W 2r 60k/5.0k 0.50 | M 2r 60k/5.0k 0.50',
    'est.',
  ]);
});

test('status costs.development: thinker and dev show no runs over an empty board', async () => {
  assert.deepEqual(await developmentField(() => {}), ['thinker: none', 'dev: none', 'est.']);
});

test('ops: /nep task inner stops, starts and reports the inner life for an owner only', async () => {
  const calls = [];
  const inner = {
    stop: (guildId, { by }) => (calls.push(['stop', guildId, by]), { ok: true, already: false, dropped: 2 }),
    start: (guildId, { by }) => (calls.push(['start', guildId, by]), { ok: true, already: false }),
    status: () => ({
      on: true,
      mode: 'shadow',
      stopped: false,
      stoppedAt: null,
      queue: [{ id: 'w', kind: 'review', dueAt: 0, capped: null }],
      review: { day: '2026-10-19', at: 0, done: false },
      budgets: { day: { used: 1, cap: 24, resetAt: 0 }, hour: { used: 1, cap: 4 }, posts: { used: 0, cap: 2 } },
    }),
  };
  const env = { ...makeEnv(), inner };
  const owner = { env, userId: '42', guildId: 'g1' };
  const stopped = await runOp('inner.stop', {}, owner);
  assert.equal(stopped.status, 'ok');
  assert.match(stopped.summary, /stopped; 2 queued wakes dropped/);
  assert.equal((await runOp('inner.start', {}, owner)).status, 'ok');
  const status = await runOp('inner.status', {}, owner);
  assert.match(status.summary, /mode shadow, running/);
  assert.match(status.summary, /queue: 1 \(review/);
  assert.deepEqual(
    calls.map((call) => call[0]),
    ['stop', 'start']
  );
  const member = await runOp('inner.stop', {}, { env, userId: '7', guildId: 'g1' });
  assert.equal(member.status, 'denied');
  assert.equal(member.code, 'owner-only');
});
