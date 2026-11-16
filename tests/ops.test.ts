// Tests for src/tools/operations/: the typed operations behind the owner commands -- the registry, runOp with no
// caller check and the result shape.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { listOps, runOp } from '../src/tools/operations/index.ts';
import { createOpsEnv } from '../src/tools/operations/env.ts';
import { NOT_GRANTABLE_TO_PERSONA } from '../src/tools/access.ts';
import { createDiscordInterface } from '../interfaces/discord/index.ts';
import { tempDir } from './fixtures/tmp.ts';
import { createErrandStore } from '../src/errands/store.ts';
import { withCapturedLogs } from './fixtures/capture-logs.ts';
import { OWNER_PERSON, ownedBy } from './fixtures/owner-accounts.ts';

/** The fields of a status card answer: `status.show` carries them in its data. */
const fieldsOf = (result: { data: unknown }) =>
  (result.data as { fields: Array<{ name: string; value: string }> }).fields;

// The Discord interface's capabilities object, as src/index.ts injects it.
const DISCORD = createDiscordInterface().capabilities;

/** The operation names the commands-cleanup plan agreed on (its wildcards spelled out), `/nep talk` since merged into `message.create`. */
const AGREED = new Set([
  'skill.read',
  'skill.disable',
  'skill.run',
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
  'errand.list',
  'errand.cancel',
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
  // Changed: memory.read, her read of one subject, runs only inside a turn (lookup loop slice 12).
  'memory.read',
  'person.link',
]);

function makeEnv({
  access = {},
  emojiBackfill,
  memoryDb,
  dataDir,
}: {
  access?: object;
  emojiBackfill?: { run: () => Promise<unknown> };
  memoryDb?: { database: () => DatabaseSync };
  dataDir?: string;
} = {}) {
  const rootDir = tempDir('nep-ops-');
  fs.mkdirSync(path.join(rootDir, 'prompts'));
  fs.writeFileSync(path.join(rootDir, 'prompts', 'rules.md'), '## Rules\n\n- be kind\n');
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
  };
  return createOpsEnv({
    discord: DISCORD,
    hot,
    store,
    client: {},
    spontaneous: {},
    calibrator: { ratio: 1 },
    isServedRoot: (id: unknown) => id === 'g1',
    emojiBackfill,
    ...(memoryDb === undefined ? {} : { memoryDb }),
    ...(dataDir === undefined ? {} : { dataDir }),
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
  // Every name of the lists below is registered, as the line above asserts.
  for (const name of AGREED) assert.ok(byName.has(name), `${name} is not registered`);
  // The owner's decision of 2026-11-10 cut the member rights layer: an operation declares its kind and nothing else.
  for (const op of ops) assert.deepEqual(Object.keys(op.rights), ['kind'], op.name);
  assert.equal(byName.get('memory.profile.read')!.rights.kind, 'read');
  // Merged into `memory.profile.read` and `errand.list`: no operation of the old name is registered.
  assert.equal(byName.has('memory.affinity.read'), false);
  assert.equal(byName.has('errand.status'), false);
  assert.equal(byName.has('memory.affinity.set'), false, 'the attitude changes through the analyzer alone');
});

// The owner's decision of 2026-11-10: only he types commands, so runOp checks no caller and no member grant.
test('ops: runOp runs an operation that was owner-only for any caller, with no grant stored', async () => {
  const env = makeEnv();
  const callers: Array<[string, Parameters<typeof runOp>[2]]> = [
    ['a member account', { env, placeId: 'g1', accountId: '999', roleIds: [] }],
    ['no account', { env, placeId: 'g1' }],
  ];
  for (const [label, ctx] of callers) {
    assert.equal((await runOp('access.list', {}, ctx)).status, 'ok', label);
    assert.equal((await runOp('rule.list', {}, ctx)).status, 'ok', label);
  }
});

test('ops: runOp returns invalid with a human summary for missing args', async () => {
  const env = makeEnv();
  const owner = { env, placeId: 'g1', accountId: '42' };
  const result = await runOp('rule.add', {}, owner);
  assert.equal(result.status, 'invalid');
  assert.equal(typeof result.code, 'string');
  assert.equal(result.summary, 'rule text is required');

  const affinity = await runOp('memory.affinity.set', { accountId: '7' }, owner);
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
  const result = await runOp('media.rescan', { kind: 'emoji' }, { env, placeId: 'g1', accountId: '42' });
  assert.deepEqual(result, { status: 'failed', code: 'EIO', summary: 'disk unreadable', data: null });

  const plain = makeEnv({
    emojiBackfill: {
      run: async () => {
        throw new Error('boom');
      },
    },
  });
  const other = await runOp('media.rescan', { kind: 'emoji' }, { env: plain, placeId: 'g1', accountId: '42' });
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

// PR 7b: with `/nep` gone no embed is built; the card is its fields, which the chat prints as sections and her call
// reads as lines.
test('status.show answers the card as its fields, with no embed', async () => {
  const env = makeEnv();
  // PR 7d: the `features` field went with the switches; `limits` is the one field asked here.
  const result = await runOp('status.show', { field: 'limits' }, { env, placeId: 'g1', accountId: '42', roleIds: [] });
  assert.equal(result.status, 'ok');
  const data = result.data as { fields?: Array<{ name: string }> };
  assert.deepEqual(
    [Object.hasOwn(data, 'embeds'), (data.fields ?? []).map((field) => field.name)],
    [false, ['limits']]
  );
});

// PR 7b: status.show answers the card as its fields, with no embed; the names and values asserted are unchanged.
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

// PR 7b: status.show answers the card as its fields, with no embed; the names and values asserted are unchanged.
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
    ['scout: none', 'server: none', 'est.'],
    'no errands: every agent with no runs'
  );
});

// Changed: the `costs.development` field is gone with the development agents (maintainer, 2026-11-16).

// The owner of these configs: `bot.ownerPerson` and the accounts bound to it (tests/fixtures/owner-accounts.ts).
ownedBy(['42']);

test("no grant opens rule.add to her, since the rules are the owner's", () => {
  // Bug: `rule.add` could be granted to her while `rule.remove` could not, so she could write the owner's rules.
  assert.ok(NOT_GRANTABLE_TO_PERSONA.includes('rule.add'));
});

test('memory.snapshot copies the memory database alone, as a database that opens, and leaves keys and tokens out', async () => {
  // Bug: the snapshot copied the whole data folder file by file, the live WAL database half-written beside keys.json
  // and the client tokens.
  const dataDir = tempDir('nep-ops-snapshot-');
  fs.writeFileSync(path.join(dataDir, 'keys.json'), '{"secret":"k"}');
  fs.mkdirSync(path.join(dataDir, 'clients'));
  fs.writeFileSync(path.join(dataDir, 'clients', 'cli.token'), 't');
  const db = new DatabaseSync(path.join(dataDir, 'memory.db'));
  db.exec("PRAGMA journal_mode = WAL; CREATE TABLE notes (text TEXT); INSERT INTO notes VALUES ('kept')");
  try {
    const env = makeEnv({ memoryDb: { database: () => db }, dataDir });
    const result = await runOp('memory.snapshot', {}, { env, placeId: 'g1', accountId: '42' });
    assert.equal(result.status, 'ok', result.summary);
    const root = path.join(dataDir, 'snapshots');
    const copies = fs
      .readdirSync(root, { recursive: true })
      .map((name) => path.join(root, String(name)))
      .filter((file) => fs.statSync(file).isFile());
    assert.deepEqual(
      copies.map((file) => path.basename(file)),
      ['memory.db']
    );
    const copy = copies[0];
    assert.equal(fs.statSync(copy).mode & 0o777, 0o600);
    const opened = new DatabaseSync(copy, { readOnly: true });
    try {
      assert.deepEqual({ ...opened.prepare('SELECT text FROM notes').get() }, { text: 'kept' });
    } finally {
      opened.close();
    }
  } finally {
    db.close();
  }
});
