// Tests for src/tools/operations/status.ts: the owner's status card answered by `status.show` as its fields. The keys
// and the costs come from fake model clients, a usage accumulator and a real task store in a temporary directory, the
// inner life is a fake with the real status shape, and the fields are worded through the labels. No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runOp } from '../../../../src/tools/operations/index.ts';
import { createOpsEnv } from '../../../../src/tools/operations/env.ts';
import { createDiscordInterface } from '../../../../interfaces/discord/index.ts';
import { innerLines } from '../../../../src/tools/operations/status.ts';
import { createErrandStore } from '../../../../src/errands/store.ts';
import { usageTap, createUsage } from '../../../../src/tools/operations/usage.ts';
import { withCapturedLogs } from '../../../fixtures/capture-logs.ts';
import { tempDir } from '../../../fixtures/tmp.ts';
import { OWNER_PERSON, ownedBy } from '../../../fixtures/owner-accounts.ts';
import { familyOf } from '../../../../src/llm/images.ts';
import { ROLE_DEFAULTS } from '../../../../src/llm/roles.ts';
import { createMetrics } from '../../../../src/tools/operations/metrics.ts';
import type { Untyped } from '../../../../src/tools/types.ts';
import { makeAdmin, makeRoot } from '../../../fixtures/admin-rig.ts';
import { makeStore } from '../../../fixtures/admin-store.ts';
import { chainsOf } from '../../../fixtures/chains.ts';
import { labels } from '../../../fixtures/labels.ts';

const DISCORD = createDiscordInterface().capabilities;

const AT = Date.parse('2026-10-19T12:30:00Z');

const LABELS = {
  modeLine: 'mode {mode} / {state}',
  running: 'running',
  stopped: 'stopped since {at}',
  turnsLine: 'turns {used}, chains {chains}',
  usdLine: 'usd {spent}',
  nextLine: 'next {at} ({kind})',
  nextNone: 'next: none',
  heartbeatLine: 'heartbeat {at}',
  heartbeatOff: 'heartbeat off',
  nextKinds: { queue: 'queued', intention: 'intention', review: 'review' },
  lastLine: 'last {outcome} at {at}',
  lastNone: 'last: none',
  lastErrorLine: 'error {code} at {at}',
  outcomeUnknown: '?',
  intentionsLine: 'open {pending}/{waiting}',
  attentionLine: 'attention {open} open, wakes {listed}/{run}/{spoken}/{skipped}/{waiting}',
  tokensLine: 'core tokens {prompt} ({cached}) + {completion}',
};

const STATUS = {
  on: true,
  mode: 'shadow',
  stopped: false,
  stoppedAt: null,
  turnsToday: 3,
  chains: 2,
  spentUsd: 0.6,
  intentions: { pending: 2, waiting: 1 },
  attention: { open: 1, listed: 5, run: 4, spoken: 1, skipped: 3, waiting: 1 },
  next: { at: AT + 3600000, kind: 'review' },
  lastTurn: { at: AT, outcome: 'skip' },
};

function envOf({ status = STATUS, usage = null }: { status?: typeof STATUS; usage?: unknown } = {}) {
  const hot = {
    config: {
      bot: { ownerPerson: OWNER_PERSON },
      llm: { maxRequestsPerDay: 10, probeTimeoutMs: 50 },
    },
    prompts: { labels: { status: { inner: LABELS } } },
    promptSources: {},
    rootDir: tempDir('nep-status-inner-'),
  };
  const store = { state: { data: {}, markDirty() {} }, flush() {} };
  const seen: Array<string> = [];
  const inner = { status: (placeId: string) => (seen.push(placeId), status) };
  return {
    env: createOpsEnv({
      discord: DISCORD,
      hot,
      store,
      client: {},
      isServedRoot: (id: unknown) => id === 'g1',
      inner,
      usage,
    }),
    seen,
  };
}

/** A field of the card that `status.show` answers in its data. */
type Field = { name: string; value: string };

const fieldsOf = (result: { data: unknown }) => (result.data as { fields: Array<Field> }).fields;

type Env = ReturnType<typeof envOf>['env'];

const show = async (env: Env, args: Record<string, unknown>, accountId: string) =>
  fieldsOf(await runOp('status.show', args, { env, placeId: 'g1', accountId, roleIds: [] }));

const showMember = async (env: Env, args: Record<string, unknown>) =>
  fieldsOf(await runOp('status.show', args, { env, placeId: 'g1', accountId: '7', roleIds: ['staff'] }));

test("status inner: the owner reads the inner life's lines through the labels; field:inner shows it alone", async () => {
  const { env, seen } = envOf();
  const fields = await show(env, { field: 'inner' }, '42');
  assert.deepEqual(
    fields.map((f) => f.name),
    ['inner']
  );
  const [innerField] = fields;
  assert.deepEqual(innerField.value.split('\n'), [
    'mode shadow / running',
    'turns 3, chains 2',
    'usd 0.60',
    'next 2026-10-19 13:30 UTC (review)',
    'last skip at 2026-10-19 12:30 UTC',
    'open 2/1',
    'attention 1 open, wakes 5/4/1/3/1',
  ]);
  // The card's reads are the persona's: the inner field names no place.
  assert.deepEqual(seen, [undefined]);
});

test("status inner: the core role's tokens today come from the usage accumulator; without a row the line is left out", async () => {
  const usage = {
    byRole: () => [
      { role: 'analyzer', requests: 9, promptTokens: 1, cachedTokens: 0, completionTokens: 1, cost: 0 },
      { role: 'core', requests: 3, promptTokens: 12000, cachedTokens: 9000, completionTokens: 800, cost: 0.4 },
    ],
  };
  const { env } = envOf({ usage });
  const lines = (await show(env, { field: 'inner' }, '42'))[0].value.split('\n');
  assert.equal(lines.at(-1), 'core tokens 12000 (9000) + 800');
  const none = envOf({ usage: { byRole: () => [] } });
  assert.ok(!(await show(none.env, { field: 'inner' }, '42'))[0].value.includes('core tokens'));
  assert.deepEqual(
    innerLines(
      { ...STATUS, attention: null },
      { status: { inner: LABELS } },
      { tokens: { prompt: 1, cached: 2, completion: 3 } }
    ).at(-1),
    'core tokens 1 (2) + 3'
  );
});

test('status inner: in the whole card, between costs.errands and limits', async () => {
  const { env } = envOf();
  const names = (await show(env, {}, '42')).map((f) => f.name);
  assert.ok(
    names.indexOf('inner') > names.indexOf('costs.errands') && names.indexOf('inner') < names.indexOf('limits'),
    names.join()
  );
});

test('status inner: hidden from a member', async () => {
  const { env, seen } = envOf();
  assert.ok(!(await showMember(env, {})).some((f) => f.name === 'inner'));
  assert.ok(
    !(await showMember(env, { field: 'inner' })).some((f) => f.name === 'inner'),
    'a member asking for it gets the card without it'
  );
  assert.deepEqual(seen, []);
});

test('status inner: a stopped inner life, no wake known, no turn yet', () => {
  const lines = innerLines(
    {
      ...STATUS,
      mode: 'live',
      stopped: true,
      stoppedAt: AT,
      next: null,
      lastTurn: null,
      intentions: null,
      attention: null,
    },
    { status: { inner: LABELS } }
  );
  assert.deepEqual(lines, [
    'mode live / stopped since 2026-10-19 12:30 UTC',
    'turns 3, chains 2',
    'usd 0.60',
    'next: none',
    'last: none',
  ]);
  assert.equal(
    innerLines({ ...STATUS, lastTurn: { at: AT, outcome: null } }, { status: { inner: LABELS } })[4],
    'last ? at 2026-10-19 12:30 UTC'
  );
  assert.deepEqual(innerLines(STATUS, {}), [], 'no labels, no lines');
});

test('innerLines: the last failed turn shows its code and moment after the last-turn line; none without one', () => {
  const lines = innerLines({ ...STATUS, lastError: { at: AT, code: 'provider-limit' } }, { status: { inner: LABELS } });
  assert.equal(lines[5], 'error provider-limit at 2026-10-19 12:30 UTC');
  assert.equal(
    innerLines({ ...STATUS, lastError: null }, { status: { inner: LABELS } }).some((line) => line.startsWith('error ')),
    false
  );
});

test('status inner: the next heartbeat has its own line; off says so; a status without the field adds nothing', () => {
  const labels = { status: { inner: LABELS } };
  const lines = (heartbeat: { nextAt: number | null; lastAt: number | null } | null) =>
    innerLines({ ...STATUS, heartbeat }, labels);
  assert.ok(lines({ nextAt: AT + 7200000, lastAt: null }).includes('heartbeat 2026-10-19 14:30 UTC'));
  assert.ok(lines(null).includes('heartbeat off'));
  assert.ok(!lines({ nextAt: null, lastAt: null }).some((line) => line.startsWith('heartbeat')));
  assert.ok(!innerLines(STATUS, labels).some((line) => line.startsWith('heartbeat')));
});

const NOW = Date.parse('2026-10-18T12:00:00Z');

const COSTS = {
  keyLead: 'main',
  roleKeyLead: '{roles} key',
  roleSeparator: '+',
  keyLimitPlain: '{lead} {spent}/{limit}',
  partSeparator: ' | ',
  role: '{role}: {requests} req {cost}',
  byRoleEmpty: 'none',
  agentLine: '{agent}: {parts}',
  agentWindow: '{window} {runs}r {in}/{out} {usd}',
  agentWindows: { today: 'D', last7: 'W', last30: 'M' },
  agentNoRuns: '{agent}: none',
  agentEstimate: 'est.',
};

function setup() {
  const config = {
    bot: { ownerPerson: OWNER_PERSON },
    llm: {
      maxRequestsPerDay: 10,
      probeTimeoutMs: 50,
    },
    errands: { maxOpen: 3 },
  };
  const hot = {
    config,
    prompts: { labels: { status: { costs: COSTS } } },
    promptSources: {},
    rootDir: tempDir('nep-status-drawing-'),
  };
  // `dataDir` is a stale option of an earlier store; the options variable keeps it out of the excess property check.
  const storeOptions = {
    dataDir: tempDir('nep-status-drawing-data-'),
    placeId: 'g1',
    now: () => NOW,
    config: () => config,
  };
  const tasks = createErrandStore(storeOptions);
  // The accumulator the status card reads: a voice request and a picture's `images: generated` line.
  const usage = createUsage({ dataDir: tempDir('nep-status-drawing-usage-'), now: () => NOW });
  const tap = usageTap(usage);
  tap({ msg: 'llm: usage', role: 'core', promptTokens: 100, completionTokens: 10, cost: 0.4 });
  tap({ msg: 'images: generated', cost: 0.03 });
  const reads: Array<string> = [];
  const llm = {
    roleKeys: () => [{ roles: ['drawing', 'scout'] }],
    async keyInfo(options: { role?: string }) {
      reads.push(options.role ?? 'main');
      return { ok: true, status: 200, json: { data: { limit: 30, limit_remaining: 30 } } };
    },
  };
  const errands = { store: (placeId: string) => (placeId === 'g1' ? tasks : null) };
  const store = { state: { data: {}, markDirty() {} }, flush() {} };
  const env = createOpsEnv({
    discord: DISCORD,
    hot,
    store,
    client: {},
    isServedRoot: (id: unknown) => id === 'g1',
    llm,
    errands,
    usage,
  });
  const card = async (field: string) => {
    const { fields } = (await runOp('status.show', { field }, { env, placeId: 'g1', accountId: '42', roleIds: [] }))
      .data as { fields: Array<{ value: string }> };
    const [first] = fields;
    return first?.value.split('\n');
  };
  return { card, reads };
}

test("status: drawing's spend is a row of costs.base from the usage accumulator, never a line of costs.errands", async () => {
  const { card } = setup();
  const { result } = await withCapturedLogs(async () => ({
    errands: await card('costs.errands'),
    base: await card('costs.base'),
  }));
  // The agents are read from disk: `code`, `scout` and `server`.
  assert.deepEqual(
    result.errands,
    ['code: none', 'scout: none', 'server: none', 'est.'],
    'the pictures are not an errand'
  );
  assert.deepEqual(result.base, ['core: 1 req 0.40', 'drawing: 1 req 0.03']);
});

test("status: keys.base leaves the agents' key out when the drawing role is on it, and never reads it", async () => {
  const { card, reads } = setup();
  const { result } = await withCapturedLogs(() => card('keys.base'));
  assert.deepEqual(result, ['main 0.00/30.00']);
  assert.deepEqual(reads, ['main'], 'the agents key (scout and drawing) is not read');
});

function makeEnv({
  access = {},
  journal,
}: {
  access?: object;
  journal?: { read: () => Promise<unknown> };
} = {}) {
  const rootDir = tempDir('nep-ops-');
  fs.mkdirSync(path.join(rootDir, 'prompts'));
  const hot = {
    config: { bot: { ownerPerson: OWNER_PERSON, access }, llm: { model: 'x/y', maxRequestsPerDay: 10 } },
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
    getPlace: () => ({ emojiUsage: {} }),
    // The owner's rules: none stored.
    liveRules: () => [],
  };
  return createOpsEnv({
    discord: DISCORD,
    hot,
    store,
    client: {},
    spontaneous: {},
    calibrator: { ratio: 1 },
    isServedRoot: (id: unknown) => id === 'g1',
    ...(journal === undefined ? {} : { journal }),
  });
}

// No embed is built: the card is its fields, which the chat prints as sections and the persona's call reads as
// lines.
test('status.show answers the card as its fields, with no embed', async () => {
  const env = makeEnv();
  // `limits` is the one field asked here.
  const result = await runOp('status.show', { field: 'limits' }, { env, placeId: 'g1', accountId: '42', roleIds: [] });
  assert.equal(result.status, 'ok');
  const data = result.data as { fields?: Array<{ name: string }> };
  assert.deepEqual(
    [Object.hasOwn(data, 'embeds'), (data.fields ?? []).map((field) => field.name)],
    [false, ['limits']]
  );
});

test('createOpsEnv: the management key and the extra role keys reach the owner status card', async () => {
  const rootDir = tempDir('nep-ops-');
  const costs = {
    keyLead: 'main',
    roleKeyLead: '{roles} key',
    keyLimitPlain: '{lead} {spent}/{limit}',
    keyNonePlain: '{lead} none',
    keyUnavailable: '{lead} unavailable',
  };
  const hot = {
    config: { bot: { ownerPerson: OWNER_PERSON }, llm: { maxRequestsPerDay: 10, probeTimeoutMs: 50 } },
    prompts: { labels: { status: { costs } } },
    promptSources: {},
    rootDir,
  };
  const store = { state: { data: {}, markDirty() {} }, flush() {} };
  const reads: Array<string> = [];
  const llm = {
    roleKeys: () => [{ roles: ['core'] }],
    async keyInfo(options: { apiKey?: string; role?: string }) {
      reads.push(options.apiKey ?? options.role ?? 'main');
      const limit = options.apiKey ? 5 : options.role ? 200 : 30;
      return { ok: true, status: 200, json: { data: { limit, limit_remaining: limit } } };
    },
    keyHash: ({ role }: { role?: string } = {}) => (role ? 'hash-core' : 'hash-main'),
    async activity(options: { apiKey: string; keyHash: string }) {
      activity.push([options.apiKey, options.keyHash]);
      return { ok: false, status: 403, json: null };
    },
  };
  const activity: Array<Array<string>> = [];
  const env = createOpsEnv({
    discord: DISCORD,
    hot,
    store,
    client: {},
    isServedRoot: (id: unknown) => id === null,
    llm,
    managementKey: 'mgmt-test',
  });
  assert.equal(env.managementKey, 'mgmt-test');
  const result = await runOp(
    'status.show',
    { field: 'keys.base' },
    { env, placeId: null, accountId: '42', roleIds: [] }
  );
  assert.deepEqual(
    fieldsOf(result).map((field) => field.name),
    ['keys.base']
  );
  const value = fieldsOf(result)[0].value;
  assert.deepEqual(
    value.split('\n'),
    ['main 0.00/30.00', 'core key 0.00/200.00'],
    'a failed activity read: the lines as without it'
  );
  assert.deepEqual(reads.sort(), ['core', 'main']);
  assert.deepEqual(
    activity.sort(),
    [
      ['mgmt-test', 'hash-main'],
      ['mgmt-test', 'hash-core'],
    ].sort(),
    'one activity read per key, by its hash, with the management key'
  );
});

test("status keys.base and costs.errands: the errand agents' key has no line and no read; their spend comes from the task records, the agents without records show no runs", async () => {
  const rootDir = tempDir('nep-ops-');
  const costs = {
    keyLead: 'main',
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
    bot: { ownerPerson: OWNER_PERSON },
    llm: { maxRequestsPerDay: 10, probeTimeoutMs: 50 },
    agents: { scout: { daily: { tasks: 40 } }, server: { daily: { tasks: 40 } } },
  };
  const hot = { config, prompts: { labels: { status: { costs } } }, promptSources: {}, rootDir };
  const store = { state: { data: {}, markDirty() {} }, flush() {} };
  const reads: Array<string> = [];
  const llm = {
    roleKeys: () => [{ roles: ['server', 'scout'] }, { roles: ['dev', 'thinker'] }],
    async keyInfo(options: { apiKey?: string; role?: string }) {
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
    // @ts-expect-error the store takes no dataDir; the test passes one and the store ignores it
    dataDir: tempDir('nep-ops-data-'),
    placeId: 'g1',
    now: () => clock.t,
    config: () => config,
  });
  const run = (agent: string, usage: object) => {
    const { errand: task } = tasks.add({
      agent,
      goal: 'look it up',
      requester: { accountId: 'u1', kind: 'member' },
      origin: {},
      scope: 'group',
    });
    tasks.start(task!.id);
    tasks.finish(task!.id, { status: 'done', result: { text: 'ok' }, usage });
  };
  await withCapturedLogs(() => {
    run('scout', { input: 40_000, output: 2_000, usd: 0.5 });
    clock.t = NOW;
    run('scout', { input: 12_400, output: 3_100, usd: 0.12 });
    run('server', { input: 1_000, output: 100, usd: 0.01 });
  });
  const errands = { store: () => tasks };
  const env = createOpsEnv({
    discord: DISCORD,
    hot,
    store,
    client: {},
    isServedRoot: (id: unknown) => id === 'g1',
    llm,
    errands,
  });
  const card = async (field: string) =>
    fieldsOf(await runOp('status.show', { field }, { env, placeId: 'g1', accountId: '42', roleIds: [] }));

  const [keys] = await card('keys.base');
  assert.deepEqual(
    keys.value.split('\n'),
    ['main 0.00/30.00', 'dev+thinker key 0.00/200.00'],
    'the development key stays, the agents key is gone'
  );
  assert.deepEqual(reads.sort(), ['dev', 'main'], 'the agents key is not read');

  const [agents] = await card('costs.errands');
  assert.equal(agents.name, 'costs.errands');
  // The agents are read from disk: `code`, `scout` and `server`.
  assert.deepEqual(agents.value.split('\n'), [
    'code: none',
    'scout: D 1r 12k/3.1k 0.12 | W 1r 12k/3.1k 0.12 | M 2r 52k/5.1k 0.62',
    'server: D 1r 1.0k/100 0.01 | W 1r 1.0k/100 0.01 | M 1r 1.0k/100 0.01',
    'est.',
  ]);
  assert.deepEqual(
    tasks.today('scout'),
    { tasks: 1, usd: 0.12, caps: { tasks: 40 } },
    'the scout cap reads the same today'
  );

  const noErrands = createOpsEnv({
    discord: DISCORD,
    hot,
    store,
    client: {},
    isServedRoot: (id: unknown) => id === 'g1',
    llm,
  });
  const [empty] = fieldsOf(
    await runOp(
      'status.show',
      { field: 'costs.errands' },
      { env: noErrands, placeId: 'g1', accountId: '42', roleIds: [] }
    )
  );
  assert.deepEqual(
    empty.value.split('\n'),
    // The agents are read from disk: `code`, `scout` and `server`.
    ['code: none', 'scout: none', 'server: none', 'est.'],
    'no errands: every agent with no runs'
  );
});

// The owner of these configs: `bot.ownerPerson` and the accounts bound to it (tests/fixtures/owner-accounts.ts).
ownedBy(['42']);

type AdminField = { name: string; value: string };

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

// PR 7b: status.show answers the card as its fields, with no embed; the names and values asserted are unchanged.
test('status: the card carries the fields in order and the member variant drops the storage line, memory and speed', async () => {
  const rootDir = makeRoot();
  const journalDir = tempDir('nep-status-journal-');
  const dayFile = path.join(journalDir, 'today.jsonl');
  fs.writeFileSync(dayFile, '{}\n');
  const journal = { dayFile: () => dayFile, stalled: () => true };
  const archive = { stats: () => ({ pending: 3 }) };
  const client = { ws: { ping: 41.6 }, guilds: { cache: new Map() } };
  const { admin, hot, store } = makeAdmin(rootDir, { journal, archive, client });
  hot.config.context = { ...hot.config.context, channelMessages: 60 };
  hot.config.models = {
    ...hot.config.models,
    agents: { via: { scout: 'claude' }, model: { scout: 'claude-sonnet-4.6' } },
  };
  const storeData = store.state.data;
  storeData.paused = true;
  const data2 = store.state.data;
  data2.pausedAt = '2026-10-13T08:30:00.000Z';
  const data3 = store.state.data;
  data3.pausedBy = '42';

  const owner = await admin.run('status.show', {}, { accountId: '42' });
  assert.equal(owner.text, '', 'the card alone, no long form');
  const fields = owner.fields;
  assert.deepEqual(
    fields.map((f: AdminField) => f.name),
    [
      'state',
      'tasks',
      'models.base',
      'keys.base',
      'costs.base',
      'models.errands',
      'costs.errands',
      // Changed: the development fields are gone with the development agents (maintainer, 2026-11-16).
      'inner',
      'limits',
      'memory',
      'speed',
    ]
  );
  const value = (name: string) => fields.find((f: AdminField) => f.name === name).value;
  const stateLines = value('state').split('\n');
  assert.deepEqual(
    stateLines.slice(0, 3),
    [
      'paused since 2026-10-13 08:30 UTC by <@42>',
      'storage: append store stalled; 3 archive copies pending',
      // The gateway's latency is no longer shown (the interface gives the core no such figure): the connection field
      // is the last reconnect alone.
      'last reconnect none',
    ],
    'the state, then the connection'
  );
  assert.match(stateLines[3], /^uptime (\d+d )?(\d+h )?\d+m$/, 'the uptime last');
  assert.equal(stateLines.length, 4);
  assert.equal(value('tasks'), 'archive drain: 3 pending');
  assert.equal(
    value('models.base'),
    [
      'core · anthropic/claude-opus-4.6',
      `memory · ${ROLE_DEFAULTS.core}`,
      `analyzer · ${ROLE_DEFAULTS.analyzer}`,
      // Changed: an optional role with no chain is off (spec 2026-11-09-model-routes, slice 4).
      'vision · no model configured',
      'video · no model configured',
      `embedding · ${ROLE_DEFAULTS.embedding}`,
      'speech · no model configured',
      'drawing · no model configured',
    ].join('\n'),
    'no llm client: one line per base role with its own model, unprobed, drawing last'
  );
  assert.equal(
    value('models.errands'),
    // Changed: an agent's line is its route, harness and model.
    // Changed: the agents are read from disk: `code`, `scout` and `server`.
    ['code · no model configured', 'scout · claude-harness · claude-sonnet-4.6', 'server · no model configured'].join(
      '\n'
    ),
    'one line per errand agent with its route'
  );
  // PR 7d: the daily caps of videos, recall and lookups are gone, so the limits field is the request rail alone.
  assert.match(value('limits'), /^requests \d+\/300\nresets 00:00 UTC$/);
  assert.deepEqual(
    value('memory')
      .split('\n')
      .map((line: string) => line.slice(0, line.indexOf(':'))),
    [
      'chat window',
      'record',
      'index',
      'archive',
      'profiles',
      'server notes',
      'channels',
      'recent lines',
      'participation fragments',
    ]
  );
  assert.match(value('memory'), /^chat window: last 60 messages in the active channel\n/);
  assert.ok(!/buffer|pending|journal/.test(value('memory')), 'no buffer, archive queue or journal line in memory');
  assert.equal(value('speed'), 'not available', 'no metrics wired');
  for (const field of fields) assert.ok(field.value.length > 0 && field.value.length <= 1024, field.name);

  const member = await admin.run('status.show', {}, { accountId: '999' });
  const memberFields = member.fields;
  assert.deepEqual(
    memberFields.map((f: AdminField) => f.name),
    ['state', 'tasks', 'models.base', 'models.errands', 'limits']
  );
  const memberFieldsValue = memberFields[0].value;
  assert.deepEqual(
    memberFieldsValue.split('\n').slice(0, 2),
    ['paused since 2026-10-13 08:30 UTC by <@42>', 'last reconnect none'],
    'no storage line for a member'
  );
  assert.equal(member.text, '', 'a member never gets the long form');
});

// PR 7b: status.show answers the card as its fields, with no embed; the names and values asserted are unchanged.
test('status: the owner card shows the limit of each key with its usage under it, then today by role, with no credits read; a member gets neither field and no read', async () => {
  const rootDir = makeRoot();
  const reads: Array<Untyped> = [];
  const key = {
    label: 'sk-or-v1-hidden',
    limit: 30,
    limit_reset: 'daily',
    budgets: [
      {
        scope: 'key_limit',
        limit_usd: 30,
        spend_usd: 8.45,
        reset_interval: 'daily',
        resets_at: '2026-10-16T00:00:00.000Z',
        include_byok: true,
      },
    ],
    usage_daily: 0.1,
  };
  const llm = {
    async keyInfo(options: Untyped) {
      reads.push(['key', options?.timeoutMs]);
      return { ok: true, status: 200, json: { data: key } };
    },
    async credits() {
      reads.push(['credits']);
      return { ok: true, status: 200, json: { data: {} } };
    },
  };
  let rows = [
    { role: 'core', requests: 38, promptTokens: 974_000, cachedTokens: 342_000, completionTokens: 9_300, cost: 4.03 },
  ];
  const usage = { byRole: () => rows };
  const { admin, hot } = makeAdmin(rootDir, { llm, usage });
  hot.prompts.labels = labels;
  hot.config.llm.probeTimeoutMs = 1234;

  const fieldOf = async (name: string) =>
    (await admin.run('status.show', {}, { accountId: '42' })).fields.find((f: AdminField) => f.name === name).value;
  // Changed: the simulator key's line left the card with the simulation.
  assert.deepEqual((await fieldOf('keys.base')).split('\n'), [
    'main 8.45/30.00 USD (resets daily at 2026-10-16 00:00 UTC; BYOK in)',
    'usage day 0.10 USD',
  ]);
  assert.deepEqual(
    (await fieldOf('costs.base')).split('\n'),
    ['core: 38 req, in 974k (cached 342k), out 9.3k, 4.03 USD'],
    'no header, no total'
  );
  assert.deepEqual(
    reads,
    [
      ['key', 1234],
      ['key', 1234],
    ],
    'the key read with the probe timeout, once per card; never the credits'
  );

  // Too many roles for one field: whole lines are cut from the bottom.
  rows = Array.from({ length: 40 }, (_, i) => ({
    role: `role-${i}`,
    requests: 1,
    promptTokens: 1000,
    cachedTokens: 0,
    completionTokens: 10,
    cost: 0.01,
  }));
  const long = await fieldOf('costs.base');
  assert.ok(long.length <= 1024);
  assert.match(
    long.split('\n').at(-1),
    /^role-\d+: 1 req, in 1\.0k \(cached 0\), out 10, 0\.01 USD$/,
    'the last line is whole'
  );
  rows = [];
  assert.equal(await fieldOf('costs.base'), 'today by role: none');

  const member = await admin.run('status.show', {}, { accountId: '999' });
  assert.ok(!member.fields.some((f: AdminField) => f.name.startsWith('costs')), 'no costs field for a member');
  assert.equal(reads.length, 4, 'a member card sends no account read');
});

// PR 7b: status.show answers the card as its fields, with no embed; the names and values asserted are unchanged.
test('status: the field option renders that field alone and runs only its work', async () => {
  const rootDir = makeRoot();
  const reads: Array<Untyped> = [];
  const llm: ProbeLlm = fakeProbeLlm(() => ({ provider: 'Prov' }));
  llm.keyInfo = async () => {
    reads.push('key');
    return { ok: true, status: 200, json: { data: { limit: 10, limit_remaining: 10 } } };
  };
  llm.activity = async () => {
    reads.push('activity');
    return { ok: true, status: 200, json: { data: [] } };
  };
  llm.keyHash = () => 'h';
  const usage = {
    byRole: () => [{ role: 'core', requests: 1, promptTokens: 1, cachedTokens: 0, completionTokens: 1, cost: 0.5 }],
  };
  const { admin, hot } = makeAdmin(rootDir, {
    llm,
    usage,
    images: fakeImages({ quota: { used: 0, cap: 5 } }),
    managementKey: 'mgmt-test',
  });
  probeConfig(hot);
  const hotLabels = hot.prompts.labels;
  hotLabels.status.costs = labels.status.costs;
  hot.config.llm.maxRequestsPerDay = 300;

  const only = async (field: string, accountId = '42') =>
    (await admin.run('status.show', { field }, { accountId })).fields;
  const limits = await only('limits');
  assert.deepEqual(
    limits.map((f: AdminField) => f.name),
    ['limits']
  );
  assert.match(limits[0].value, /^requests \d+\/300\n/);
  assert.deepEqual(
    [llm.calls.length, llm.listings.length, reads.length],
    [0, 0, 0],
    'no probe, no listing, no key read'
  );

  assert.deepEqual(
    (await only('costs.base')).map((f: AdminField) => f.name),
    ['costs.base']
  );
  assert.deepEqual([llm.calls.length, reads.length], [0, 0], 'the role costs read no key');

  const keys = await only('keys.base');
  assert.deepEqual(
    keys.map((f: AdminField) => f.name),
    ['keys.base']
  );
  assert.deepEqual(reads.sort(), ['activity', 'key'], 'the key and its activity read once each');
  assert.equal(llm.calls.length, 0, 'no model probe for the key field');

  assert.deepEqual(
    (await only('models.errands')).map((f: AdminField) => f.name),
    ['models.errands']
  );
  // Changed: the development fields are gone with the development agents (maintainer, 2026-11-16).
  assert.deepEqual([llm.calls.length, llm.listings.length], [0, 0], 'the errand field probes nothing');
  assert.deepEqual(
    (await only('models.base')).map((f: AdminField) => f.name),
    ['models.base']
  );
  assert.ok(llm.calls.length > 0, 'the models.base field probes');
  assert.equal(llm.listings.length, 1, 'the models.base field reads the drawing listing');

  // An owner-only field asked by a member, or an unknown one: the whole card the caller may see.
  hot.config.bot.access = { 'status.show': { everyone: true, roles: [], users: [] } };
  assert.deepEqual(
    (await only('memory', '999')).map((f: AdminField) => f.name),
    ['state', 'tasks', 'models.base', 'models.errands', 'limits']
  );
  // PR 7d: the inner life is code, so the whole card carries its `inner` field too.
  // Changed: the development fields are gone with the development agents (maintainer, 2026-11-16).
  assert.equal((await only('nonsense')).length, 11);
});

/** A clock the test moves by hand. */
function handClock(start: number) {
  const state = { at: start };
  const now = () => state.at;
  now.advance = (ms: number) => {
    state.at += ms;
  };
  return now;
}

// PR 7b: status.show answers the card as its fields, with no embed; the names and values asserted are unchanged.
test('status: the memory field shows the coverage of every kind of memory, computed at most once a minute', async () => {
  const rootDir = makeRoot();
  const now = handClock(Date.parse('2026-10-14T12:00:00.000Z'));
  // The record: four messages on four days since the first one.
  const record = { stats: async () => ({ messages: 4, days: 4, first: '2026-09-30' }) };
  const archiveEntries = [
    { event: 'backfill', observedAt: { date: '2026-03-01', precision: 'day' } },
    { event: 'evicted', observedAt: { date: '2026-10-13T10:00:00.000Z', precision: 'time' } },
    { event: 'evicted', observedAt: { date: '2026-05-02', precision: 'day' } },
    { event: 'replaced', observedAt: { date: '2026-06-01', precision: 'approx' } },
  ];
  const archive = {
    stats: () => ({ pending: 0 }),
    async *iterate() {
      yield* archiveEntries;
    },
  };
  const coverageAsked: Array<Untyped> = [];
  const embedQueue = {
    indexSummary() {
      return Promise.resolve({ rows: 1234, missing: 5 });
    },
    async coverage(placeId: string, options: Untyped) {
      coverageAsked.push([placeId, options.hours]);
      return { messages: 200, indexed: 150, missing: 50, oldestMissing: '2026-10-12T08:00:00.000Z' as string | null };
    },
  };
  const { admin, store } = makeAdmin(rootDir, { record, archive, embedQueue, now });
  // PR 7d: the index switches are code and `embed.catchUpHours` is the constant 72.
  store.profiles.set('u1', {
    id: 'u1',
    character: 'Ήσυχη και αστεία',
    episodes: [{}, {}, {}],
    details: [{}, {}],
    aliases: [{}],
    realName: { name: 'Éloïse' },
  });
  store.profiles.set('u2', { id: 'u2', character: '', episodes: [{}], details: [], aliases: [] });
  store.profiles.set('u3', { id: 'u3', character: 'Ζωηρός', episodes: [], details: [], aliases: [] });
  store.lore.set('g1', [{ id: 1 }, { id: 2 }]);
  store.guilds.set('g1', {
    patterns: '',
    starters: '',
    injokes: ['α', 'β'],
    self: ['γ'],
    learned: [{}, {}, {}],
    updatedAt: null,
  });
  store.channels.set('g1:c1', { id: 'c1', purpose: 'chat', topics: '', tone: '' });
  store.channels.set('g1:c2', { id: 'c2', purpose: '', topics: '', tone: '' });
  store.channels.set('g1:c3', { id: 'c3', purpose: '', topics: '', tone: 'calm' });
  store.channels.set('g1:c4', { id: 'c4' });
  store.recent.set('g1', {
    nextId: 3,
    lines: [{ at: Date.parse('2026-10-12T10:00:00.000Z') }, { at: Date.parse('2026-10-14T09:00:00.000Z') }],
  });
  store.participation.set('g1', {
    nextId: 3,
    episodes: [
      { startAt: Date.parse('2026-10-13T23:00:00.000Z'), lastAt: Date.parse('2026-10-14T01:00:00.000Z') },
      { startAt: Date.parse('2026-10-10T10:00:00.000Z'), lastAt: Date.parse('2026-10-10T11:00:00.000Z') },
    ],
  });
  const memoryLines = async () =>
    (await admin.run('status.show', {}, { accountId: '42' })).fields
      .find((f: AdminField) => f.name === 'memory')
      .value.split('\n');

  assert.deepEqual(await memoryLines(), [
    'record: 4 messages · 2026-09-30..2026-10-14 · 27% of days have lines',
    'index: 1234 rows · 75% of record messages indexed (last 72 h) · oldest missing 2026-10-12',
    'archive: 4 entries · evicted 2, replaced 1, backfill 1 · observed 2026-03-01..2026-10-13',
    'profiles: 3 · 67% with a portrait · 4 episodes (1.3 per profile) · 2 details · 1 aliases · 1 real names set',
    'server notes: 2 lore entries · 3 lessons · 1 self facts · 2 in-jokes',
    'channels: 2 with notes / 4 seen (50%)',
    'recent lines: 2 · 2026-10-12..2026-10-14',
    'participation fragments: 2 · 2026-10-10..2026-10-14',
  ]);
  assert.deepEqual(coverageAsked, [['g1', 72]]);

  // Within the minute the cached field is shown, whatever changed.
  store.profiles.set('u4', { id: 'u4', character: 'Νέος', episodes: [], details: [], aliases: [] });
  now.advance(30_000);
  assert.equal((await memoryLines())[3].split(' · ')[0], 'profiles: 3', 'cached');
  assert.equal(coverageAsked.length, 1, 'no second coverage read');
  now.advance(31_000);
  assert.equal((await memoryLines())[3].split(' · ')[0], 'profiles: 4', 'a minute later it is read again');
  assert.equal(coverageAsked.length, 2);

  embedQueue.coverage = async () => ({ messages: 0, indexed: 0, missing: 0, oldestMissing: null });
  now.advance(61_000);
  assert.equal((await memoryLines())[1], 'index: 1234 rows · - of record messages indexed (last 72 h) · none missing');
});

// PR 7b: status.show answers the card as its fields, with no embed; the names and values asserted are unchanged.
test('status: the speed field gives the median and the mean of the last 24 h with the count', async () => {
  const rootDir = makeRoot();
  const now = handClock(Date.parse('2026-10-14T12:00:00.000Z'));
  const metrics = createMetrics({ dataDir: path.join(rootDir, 'data'), now });
  metrics.record('reply', 4000);
  metrics.record('reply', 6000);
  metrics.record('analyzer batch', 120);
  const { admin } = makeAdmin(rootDir, { metrics, now });
  const speedLines = async () =>
    (await admin.run('status.show', {}, { accountId: '42' })).fields
      .find((f: AdminField) => f.name === 'speed')
      .value.split('\n');

  // Changed: the recall rows went with the recall log lines that fed them.
  assert.deepEqual(await speedLines(), [
    'reply: median 5.0 s · mean 5.0 s (2)',
    'analyzer batch: median 120 ms · mean 120 ms (1)',
    'embedding flush: -',
  ]);
});

// PR 7b: status.show answers the card as its fields, with no embed; the names and values asserted are unchanged.
test("status: the speed field ends with today's missed-answer figures from the journal", async () => {
  const rootDir = makeRoot();
  const now = handClock(Date.parse('2026-10-14T12:00:00.000Z'));
  const asked: Array<Untyped> = [];
  const journal = {
    dayFile: () => path.join(rootDir, 'no-day.jsonl'),
    stalled: () => false,
    read: async (placeId: string, query: Untyped) => {
      asked.push([placeId, query]);
      return [
        { kind: 'answer', event: 'fact', reason: 'gate-failed', messageId: 'm1' },
        { kind: 'answer', event: 'fact', reason: 'turn-error', messageId: 'm2' },
        { kind: 'answer', event: 'verdict', verdict: 'owed', messageId: 'm1' },
        { kind: 'answer', event: 'recovery', outcome: 'spoke', messageIds: ['m1'] },
      ];
    },
  };
  const { admin } = makeAdmin(rootDir, { journal, now });
  const speed = async (accountId = '42') =>
    (await admin.run('status.show', {}, { accountId })).fields.find((f: AdminField) => f.name === 'speed')?.value;
  assert.equal(await speed(), 'not available\nmissed: 2 candidates, 1 owed, 1 recovered');
  assert.deepEqual(asked, [['g1', { day: '2026-10-14', kind: 'answer', n: Number.MAX_SAFE_INTEGER }]]);
  assert.equal(await speed('999'), undefined, 'a member has no speed field');
});

// PR 7b: status.show answers the card as its fields, with no embed; the names and values asserted are unchanged.
test('status: the card reads every top place, never only the first', async () => {
  // Bug: a second server's memory and missed answers are invisible on the owner's card.
  const rootDir = makeRoot();
  const store = makeStore();
  store.topPlaces = () => ['g1', 'g2'];
  store.guilds.set('g1', { name: 'One', injokes: [], self: [], learned: [] });
  store.guilds.set('g2', { name: 'Two', injokes: [], self: [], learned: [] });
  store.channels.set('g1:c1', { id: 'c1', purpose: 'chat' });
  store.channels.set('g2:c8', { id: 'c8', purpose: '' });
  store.channels.set('g2:c9', { id: 'c9', purpose: '' });
  const asked: Array<unknown> = [];
  const journal = {
    ...fakeJournal(),
    read: async (placeId: string) => {
      asked.push(placeId);
      return [];
    },
  };
  const { admin } = makeAdmin(rootDir, { store, journal });
  const card = (await admin.run('status.show', {}, { accountId: '42' })).fields;
  const memory = card.find((f: AdminField) => f.name === 'memory').value;

  assert.match(memory, /One\n[\s\S]*channels: 1 with notes \/ 1 seen/);
  assert.match(memory, /Two\n[\s\S]*channels: 0 with notes \/ 2 seen/);
  assert.deepEqual(asked, ['g1', 'g2']);
});

test('status: the storage line flags a journal that stopped writing while turns happen', async () => {
  const rootDir = makeRoot();
  let lastWriteMs: number | null = null;
  const journal = { stats: async () => ({ lastWriteMs }), stalled: () => false };
  const metrics = createMetrics({ dataDir: path.join(rootDir, 'data') });
  const { admin } = makeAdmin(rootDir, { journal, metrics });
  const storage = async () => {
    const { fields } = await admin.run('status.show', {}, { accountId: '42' });
    const storageField = fields[0];
    return storageField.value.split('\n')[1];
  };

  assert.equal(await storage(), 'storage ok', 'no turn in the last hour: nothing to judge');
  metrics.record('reply', 3000);
  assert.equal(await storage(), 'storage: journal not written today while turns happen');
  lastWriteMs = Date.now() - 2 * 3_600_000;
  assert.match(
    await storage(),
    /^storage: journal not written since \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC while turns happen$/
  );
  lastWriteMs = Date.now();
  assert.equal(await storage(), 'storage ok');
});

/** A fake llm client for the status probes: `complete` answers each role through `answer` (a
 * function of the role, throwing to fail), recording every call; `modelEndpoints` returns `listing`. */
type ProbeLlm = ReturnType<typeof fakeProbeLlm> & Record<string, Untyped>;

function fakeProbeLlm(
  answer: Untyped,
  listing = {
    ok: true,
    status: 200,
    json: { data: { architecture: { output_modalities: ['image'] }, endpoints: [{}, {}] } },
  }
) {
  const calls: Array<Untyped> = [];
  const listings: Array<Untyped> = [];
  return {
    calls,
    listings,
    async complete(messages: Untyped, options: Untyped) {
      calls.push({ messages, options });
      return answer(options.role);
    },
    async modelEndpoints(model: string, options: Untyped) {
      listings.push({ model, options });
      return listing;
    },
  };
}

/** The probe tests' config: a model per role (the drawing model included), the probe timeout and label. */
function probeConfig(hot: Untyped) {
  // Changed: each role runs on its chain (slice 4); speech, which the old config left on its default, gets one too.
  hot.config.models = {
    routes: chainsOf({
      core: 'anthropic/claude-opus-4.6',
      analyzer: 'x/text',
      vision: 'x/media',
      video: 'x/video',
      embedding: 'x/embed',
      speech: ROLE_DEFAULTS.speech,
      drawing: 'openai/gpt-image-1',
    }),
  };
  hot.config.llm.probeTimeoutMs = 1234;
  const hotLabels = hot.prompts.labels;
  hotLabels.status = { probe: 'Answer with one word: Ωmega' };
}

/** The models field's lines. */
const roleLinesOf = (value: Untyped) => value.split('\n');

// PR 7b: status.show answers the card as its fields, with no embed; the names and values asserted are unchanged.
test('status: the card lists one item per line in every field, the models one line per role with no heading', async () => {
  const rootDir = makeRoot();
  const journal = { dayFile: () => path.join(rootDir, 'none.jsonl'), stalled: () => false };
  const archive = { stats: () => ({ pending: 2 }) };
  const emojiBackfill = { isRunning: () => true };
  const gifBackfill = { isRunning: () => true };
  const llm: ProbeLlm = fakeProbeLlm(() => ({ provider: 'Prov', usage: { prompt_tokens: 9, completion_tokens: 1 } }));
  const client = { ws: { ping: 12 }, guilds: { cache: new Map() } };
  const { admin, hot } = makeAdmin(rootDir, {
    journal,
    archive,
    emojiBackfill,
    gifBackfill,
    images: fakeImages({ quota: { used: 2, cap: 5 } }),
    llm,
    client,
  });
  probeConfig(hot);

  const { fields } = await admin.run('status.show', {}, { accountId: '42' });
  const lines = (name: string) => fields.find((f: AdminField) => f.name === name).value.split('\n');
  assert.deepEqual(
    fields.map((f: AdminField) => f.name),
    [
      'state',
      'tasks',
      'models.base',
      'keys.base',
      'costs.base',
      'models.errands',
      'costs.errands',
      // Changed: the development fields are gone with the development agents (maintainer, 2026-11-16).
      'inner',
      'limits',
      'memory',
      'speed',
    ]
  );
  // No gateway latency any more (the interface gives the core no such figure): the connection field is the last reconnect.
  assert.deepEqual(lines('state').slice(0, 3), ['running', 'storage: 2 archive copies pending', 'last reconnect none']);
  assert.match(lines('state')[3], /^uptime /);
  assert.deepEqual(lines('tasks'), ['emoji backfill running', 'GIF backfill running', 'archive drain: 2 pending']);
  assert.deepEqual(
    lines('limits').map((line: string) => line.replace(/^requests \d+/, 'requests N')),
    // PR 7d: the daily caps are gone, so the request rail is the one limit left; the inner life is code (`inner`).
    ['requests N/300', 'resets 00:00 UTC']
  );
  const head = (line: string) => line.split(' · ').slice(0, 2).join(' · ');
  for (const name of ['models.base', 'models.errands']) {
    assert.ok(!lines(name).some((line: string) => line.startsWith('**')), `${name}: no bold heading`);
    assert.ok(!lines(name).some((line: string) => line.startsWith(' ')), `${name}: no detail line under a role`);
  }
  assert.deepEqual(
    lines('models.base').map(head),
    [
      'core · anthropic/claude-opus-4.6',
      `memory · ${ROLE_DEFAULTS.core}`,
      'analyzer · x/text',
      'vision · x/media',
      'video · x/video',
      'embedding · x/embed',
      `speech · ${ROLE_DEFAULTS.speech}`,
      'drawing · openai/gpt-image-1',
    ],
    'each line starts with its role and its model, drawing last'
  );
  // Changed: an agent's line is its route, harness and model, and these rigs give no agent a route.
  // Changed: the agents are read from disk: `code`, `scout` and `server`.
  assert.deepEqual(lines('models.errands').map(head), [
    'code · no model configured',
    'scout · no model configured',
    'server · no model configured',
  ]);
  for (const field of fields) assert.ok(field.value.length > 0 && field.value.length <= 1024, field.name);
});

// PR 7b: status.show answers the card as its fields, with no embed; the names and values asserted are unchanged.
test('status: the limits field names the web search engine (one word), off when no search can run', async () => {
  const rootDir = makeRoot();
  const lookup = {
    engine: 'exa',
    ready: true,
    searchEngine() {
      return this.engine;
    },
    hasSearch() {
      return this.ready;
    },
  };
  const { admin, hot } = makeAdmin(rootDir, { lookup });
  hot.config.web = { quickSearch: { enabled: true } };
  const searchLine = async () => {
    const { fields } = await admin.run('status.show', { field: 'limits' }, { accountId: '42' });
    const fieldsValue = fields[0].value;
    return fieldsValue.split('\n').filter((line: string) => line.startsWith('search'));
  };
  assert.deepEqual(await searchLine(), ['search: exa']);
  lookup.engine = 'openrouter';
  assert.deepEqual(await searchLine(), ['search: openrouter']);
  lookup.engine = 'brave';
  lookup.ready = false;
  assert.deepEqual(await searchLine(), ['search: off'], 'the chosen engine cannot run (no Brave key)');
  lookup.ready = true;
  hot.config.web.quickSearch.enabled = false;
  assert.deepEqual(await searchLine(), ['search: off']);
});

// PR 7b: status.show answers the card as its fields, with no embed; the names and values asserted are unchanged.
test("status: the owner card probes every role's model and shows its provider and latency, or the failure", async () => {
  const rootDir = makeRoot();
  const funnel = JSON.stringify({
    error: {
      metadata: {
        routing_funnel: [
          { step: 'model', endpoint_count: 3 },
          { step: 'provider', endpoint_count: 0 },
        ],
      },
    },
  });
  const llm: ProbeLlm = fakeProbeLlm((role: string) => {
    if (role === 'vision') throw Object.assign(new Error('HTTP 503: upstream down'), { body: funnel });
    return { provider: 'Prov', usage: { prompt_tokens: 9, completion_tokens: 1 } };
  });
  const { admin, hot } = makeAdmin(rootDir, { images: fakeImages({ quota: { used: 2, cap: 5 } }), llm });
  probeConfig(hot);
  const modelOf = { core: 'anthropic/claude-opus-4.6', analyzer: 'x/text', vision: 'x/media', video: 'x/video' };

  const { result, logs } = await withCapturedLogs(() => admin.run('status.show', {}, { accountId: '42' }));
  const lines = roleLinesOf(result.fields.find((f: AdminField) => f.name === 'models.base').value);
  const errands = roleLinesOf(result.fields.find((f: AdminField) => f.name === 'models.errands').value);

  assert.deepEqual(
    llm.calls.map((call) => call.options.role).sort(),
    Object.keys(modelOf).sort(),
    'one probe per role model'
  );
  for (const { messages, options } of llm.calls) {
    assert.deepEqual(messages, [{ role: 'user', content: 'Answer with one word: Ωmega' }]);
    assert.equal(options.model, modelOf[options.role as keyof typeof modelOf]);
    assert.equal(options.countAgainstDailyCap, false, 'never counted against llm.maxRequestsPerDay');
    assert.equal(options.skipCalibration, true);
    assert.equal(options.origin, 'status');
    assert.equal(options.timeoutMs, 1234);
  }
  assert.deepEqual(llm.listings, [{ model: 'openai/gpt-image-1', options: { timeoutMs: 1234 } }]);

  assert.match(lines[0], /^core · anthropic\/claude-opus-4\.6 · Prov · ok \d+ ms$/);
  assert.equal(lines[1], `memory · ${ROLE_DEFAULTS.core} · not checked (memory)`);
  assert.match(lines[2], /^analyzer · x\/text · Prov · ok \d+ ms$/);
  assert.ok(
    lines.includes('vision · x/media · failed: HTTP 503: upstream down (funnel: provider -> 0 endpoints)'),
    'the failing role shows its reason and the routing funnel'
  );
  assert.deepEqual(
    errands,
    // Changed: an agent's line is its route, and this rig gives no agent a route.
    // Changed: the agents are read from disk: `code`, `scout` and `server`.
    ['code · no model configured', 'scout · no model configured', 'server · no model configured'],
    'just role and model'
  );
  // Changed: whether the model draws is checked once when it is set (`/model set drawing`), so status reads only
  // what changes between runs, whether the provider lists the model and how many endpoints serve it.
  assert.match(lines.at(-1), /^drawing · openai\/gpt-image-1 · listed, 2 endpoint\(s\), \d+ ms$/);
  assert.ok(
    !llm.calls.some((call) => ['scout', 'server'].includes(call.options.role)),
    'no request goes out on an OpenCode role'
  );

  const probed = logs.filter((entry) => entry.msg === 'status: probed');
  assert.equal(probed.length, 1);
  assert.equal(probed[0].ok, 3);
  assert.equal(probed[0].failed, 1);
});

// PR 7b: status.show answers the card as its fields, with no embed; the names and values asserted are unchanged.
test('status: the member card shows the models one line per role without probing', async () => {
  const rootDir = makeRoot();
  const llm: ProbeLlm = fakeProbeLlm(() => ({ provider: 'Prov' }));
  const { admin, hot } = makeAdmin(rootDir, { images: fakeImages({ quota: { used: 2, cap: 5 } }), llm });
  probeConfig(hot);
  hot.config.bot.access = { 'status.show': { everyone: true, roles: [], users: [] } };

  const { fields } = await admin.run('status.show', {}, { accountId: '999' });
  const valueOf = (name: string) => fields.find((f: AdminField) => f.name === name).value;
  assert.equal(
    valueOf('models.base'),
    [
      'core · anthropic/claude-opus-4.6',
      `memory · ${ROLE_DEFAULTS.core}`,
      'analyzer · x/text',
      'vision · x/media',
      'video · x/video',
      'embedding · x/embed',
      `speech · ${ROLE_DEFAULTS.speech}`,
      'drawing · openai/gpt-image-1',
    ].join('\n')
  );
  assert.equal(
    valueOf('models.errands'),
    // Changed: an agent's line is its route, and this rig gives no agent a route.
    // Changed: the agents are read from disk: `code`, `scout` and `server`.
    ['code · no model configured', 'scout · no model configured', 'server · no model configured'].join('\n')
  );
  assert.equal(llm.calls.length, 0, 'no probe request');
  assert.equal(llm.listings.length, 0, 'no listing request');
});

// PR 7b: status.show answers the card as its fields, with no embed; the names and values asserted are unchanged.
test('status: identical probes are sent once, each role shows its own model, the overrides follow their role, the embedding role gets an embedding probe', async () => {
  const rootDir = makeRoot();
  const llm: ProbeLlm = fakeProbeLlm(() => ({ provider: 'Prov', usage: { prompt_tokens: 9, completion_tokens: 1 } }));
  const embedCalls: Array<Untyped> = [];
  const embedder = {
    async embed(texts: Untyped, options: Untyped) {
      embedCalls.push({ texts, options });
      return [new Float32Array(8)];
    },
  };
  const { admin, hot } = makeAdmin(rootDir, { images: fakeImages({ quota: { used: 0, cap: 5 } }), llm, embedder });
  probeConfig(hot);
  Object.assign(hot.config.models.routes, chainsOf({ video: 'x/media' }));
  hot.config.models.byPurpose = { lookup: 'x/pinned', describe: 'x/seen' };
  // A role-specific route keeps the video role's probe apart although its model is the vision one.
  hot.config.llm.providerByModel = { 'x/@video': { only: ['video-host'] } };

  const { result, logs } = await withCapturedLogs(() => admin.run('status.show', {}, { accountId: '42' }));
  const lines = roleLinesOf(result.fields.find((f: AdminField) => f.name === 'models.base').value);

  assert.deepEqual(
    llm.calls.map((call) => [call.options.role, call.options.model]).sort(),
    [
      ['analyzer', 'x/text'],
      ['core', 'anthropic/claude-opus-4.6'],
      ['video', 'x/media'],
      ['vision', 'x/media'],
    ],
    'one chat probe per (model, route)'
  );
  assert.deepEqual(
    embedCalls.map((call) => call.texts),
    [['Answer with one word: Ωmega']],
    'one embedding request of one input'
  );
  const embedCallsOptions = embedCalls[0].options;
  assert.equal(embedCallsOptions.countAgainstDailyCap, false);
  assert.equal(embedCallsOptions.origin, 'status');
  assert.equal(embedCallsOptions.timeoutMs, 1234);
  assert.equal(embedCallsOptions.config, hot.config);
  assert.equal(
    llm.calls.some((call) => call.options.model === 'x/embed'),
    false,
    'the embedding model is never sent a chat completion'
  );

  assert.equal(lines[3], 'byPurpose lookup · x/pinned', 'an override of a lookup purpose follows the analyzer');
  assert.equal(lines[5], 'byPurpose describe · x/seen', 'a vision override follows the vision role');
  assert.match(lines[7], /^embedding · x\/embed · - · ok \d+ ms$/, 'an embedding answer names no provider');
  assert.equal(logs.find((entry) => entry.msg === 'status: probed')?.requests, 5);
});

// PR 7b: status.show answers the card as its fields, with no embed; the names and values asserted are unchanged.
test('status: without an embedding client the embedding role is shown unchecked; an embedding failure shows its reason', async () => {
  const rootDir = makeRoot();
  const llm: ProbeLlm = fakeProbeLlm(() => ({ provider: 'Prov' }));
  const none = makeAdmin(rootDir, { llm });
  probeConfig(none.hot);
  const unchecked = await none.admin.run('status.show', {}, { accountId: '42' });
  assert.ok(
    unchecked.fields
      .find((f: AdminField) => f.name === 'models.base')
      .value.split('\n')
      .includes('embedding · x/embed · not checked (no embedding client)')
  );

  const embedder = {
    embed: async () => {
      throw Object.assign(new Error('HTTP 404: no such model'), { statusCode: 404 });
    },
  };
  const failing = makeAdmin(makeRoot(), { llm, embedder });
  probeConfig(failing.hot);
  const { result } = await withCapturedLogs(() => failing.admin.run('status.show', {}, { accountId: '42' }));
  assert.ok(
    result.fields
      .find((f: AdminField) => f.name === 'models.base')
      .value.split('\n')
      .includes('embedding · x/embed · failed: HTTP 404: no such model')
  );
});

// ---------------------------------------------------------------------------
// draw / the image lines of status and model.show (src/llm/images.ts)
// ---------------------------------------------------------------------------

/** A fake image client: records every generate() call, answers with `picture` or throws `error`. */
function fakeImages({ picture, error, quota }: { picture?: Untyped; error?: Error; quota?: Untyped } = {}) {
  const calls: Array<Untyped> = [];
  return {
    calls,
    familyOf,
    async generate(args: Untyped) {
      calls.push(args);
      if (error) throw error;
      return (
        picture ?? {
          buffer: Buffer.from('fake-png'),
          mediaType: 'image/png',
          cost: 0.042,
          usage: {},
          model: 'openai/image-model',
          seconds: 12.3,
        }
      );
    },
    quota: () => quota ?? { used: 3, cap: 50, userUsed: 0, userCap: 50, spent: false, userSpent: false },
  };
}

// ---------------------------------------------------------------------------
// the journal: system records, /nep journal
// ---------------------------------------------------------------------------

/** A journal fake: records every write and call; `read` serves `days[day]` filtered like the real one. */
function fakeJournal(days: Record<string, Array<Untyped>> = {}) {
  const calls: Array<Untyped> = [];
  return {
    calls,
    system: async (record: Untyped) => {
      calls.push(['system', record]);
    },
    read: async (placeId: string, { day, kind = null, n = 50 }: { day: string; kind?: string | null; n?: number }) => {
      calls.push(['read', placeId, { day, kind, n }]);
      return (days[day] ?? []).filter((record: Untyped) => !kind || record.kind === kind).slice(-n);
    },
    forgetUser: async (placeId: string, accountId: string) => {
      calls.push(['forgetUser', placeId, accountId]);
      return { files: 2, dropped: 5 };
    },
    removeGuild: async (placeId: string) => {
      calls.push(['removeGuild', placeId]);
      return { files: 3 };
    },
  };
}
