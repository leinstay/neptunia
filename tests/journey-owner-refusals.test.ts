// Task 17.2: what the owner's commands refuse or report, each with its own code and each leaving the world as it was. A
// non-owner principal is refused at the desk. A closed memory database and a missing core answer their codes. An expired
// snapshot cursor and a stale model selection are refused. A model check that fails is reported with its reason, native
// usage that cannot be read automatically is stated with the hand-off, and an image that cannot be staged is refused
// before the core sees the caption. In every case no model request goes out (the provider is a fetch that fails the
// test, and a backend run is counted), the memory database holds the same rows, and no key file moved but by the one
// choice a test makes on purpose. Synthetic content only.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseRequest } from '../bin/neptunia-request.ts';
import { createCommandDesk } from '../src/interface/neptunia-cli.ts';
import { createConsole } from '../src/interface/commands/console.ts';
import type { Answer, ConsoleDeps } from '../src/interface/commands/console.ts';
import type { BackendResult } from '../src/agent-runner/backend.ts';
import { readClaudeUsage } from '../src/subharness/usage/claude.ts';
import type { BackendUsage } from '../src/subharness/usage.ts';
import { databaseDigest } from './fixtures/memory-db/browser-world.ts';
import { fakeVendor } from './fixtures/fake-vendor.ts';
import { readKeysFile, writeKeysFile } from './fixtures/keys-file.ts';
import { fakeFetch } from './fixtures/keys-rig.ts';
import { openTestMemory } from './fixtures/memory-db/service.ts';
import type { TestMemory } from './fixtures/memory-db/service.ts';
import { addSource, semanticWorld } from './fixtures/memory-db/semantic-world.ts';
import {
  CLI_CLIENT,
  addClient,
  folders,
  query,
  runCli,
  spawnCli,
  startUnitsCore,
  withRig,
} from './fixtures/core-units.ts';
import { syntheticPng } from './fixtures/synthetic-png.ts';
import { tempDir } from './fixtures/tmp.ts';

const T0 = Date.parse('2026-11-05T12:00:00.000Z');
const BOUNDS = { pageRows: 25, snapshotIdleSeconds: 60, snapshotMaxSeconds: 300, maxSnapshots: 8 };
const OWNER = { id: 'owner' };
const CAPTION = 'Explain this chart, quince-staging.';

const memories: Array<TestMemory> = [];
after(async () => {
  for (const memory of memories) await memory.close();
});

/** The provider and the network as a test sees them: every request is recorded and fails. */
function noNetwork() {
  const reached: Array<string> = [];
  const real = globalThis.fetch;
  globalThis.fetch = (input) => {
    reached.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    return Promise.reject(new Error('the test reached the network'));
  };
  return { reached, restore: () => void (globalThis.fetch = real) };
}

type Rig = {
  memory: TestMemory;
  dir: string;
  clock: { at: number };
  checks: Array<{ model: string | undefined }>;
  run(line: string): Promise<Answer>;
  say(...words: Array<string>): Promise<Answer>;
  desk: ReturnType<typeof createConsole>;
  deps: ConsoleDeps;
};

/**
 * The console over the real memory service and a key file, with a backend check that is counted. `check` answers the
 * check of a model, and `extra` adds dependencies of the test.
 */
async function rig(
  check: (model: string | undefined) => BackendResult | Promise<BackendResult> = () => ({
    ok: true,
    text: 'ok',
    exitCode: 0,
  }),
  extra: Partial<ConsoleDeps> = {}
): Promise<Rig> {
  const world = semanticWorld();
  addSource(world, 'alex', 'quince-private: kept for the DM alone');
  world.handle.close();
  const dir = dirname(world.file);
  mkdirSync(join(dir, 'config'), { recursive: true });
  writeKeysFile(dir, { subharness: { key: null, modes: {}, backends: ['claude', 'codex'] } });
  fakeVendor(dir, 'claude', { loggedIn: true });
  fakeVendor(dir, 'codex', { loggedIn: true });
  const clock = { at: T0 };
  const memory = await openTestMemory({
    dataDir: dir,
    config: { memoryDb: { inspection: BOUNDS } },
    now: () => clock.at,
  });
  memories.push(memory);
  const checks: Rig['checks'] = [];
  const deps: ConsoleDeps = {
    runOp: () => Promise.resolve({ status: 'failed', code: 'NOT_FOR_THIS_CASE', summary: '', data: null }),
    ownerReads: { lessons: () => '', aliases: () => '' },
    places: () => ['g1'],
    selfId: () => null,
    hot: { config: { bot: { owners: [] }, memoryDb: { inspection: BOUNDS } } },
    privateDir: dir,
    dataDir: memory.dataDir,
    memoryDb: memory.memoryDb,
    usage: {
      byRole: () => [],
      sumDays: () => ({
        rows: [],
        interfaces: [],
        total: { requests: 0, promptTokens: 0, cachedTokens: 0, completionTokens: 0, cost: 0 },
        since: '2026-11-05',
        partial: false,
      }),
    },
    metrics: { samples: () => [] },
    conversationLines: () => [],
    now: () => clock.at,
    subharness: {
      runBackend: (_name, _brief, model) => {
        checks.push({ model });
        return Promise.resolve(check(model));
      },
      fetch: fakeFetch().fetch,
      helpOf: () => Promise.resolve('Options:\n  --effort <level>\n'),
      applyMode: () => Promise.resolve('the unit took it'),
    },
    ...extra,
  };
  const desk = createConsole(deps);
  const say = (...words: Array<string>): Promise<Answer> => {
    const parsed = parseRequest(words).parsed;
    assert.ok(parsed.ok, parsed.ok ? '' : `${words.join(' ')}: ${parsed.reason}`);
    return desk.run(parsed.name, parsed.args, OWNER);
  };
  return { memory, dir, clock, checks, desk, deps, say, run: (line) => say(...line.split(' ')) };
}

const fileHash = (file: string): string => createHash('sha256').update(readFileSync(file)).digest('hex');
const digestOf = (one: Rig) => {
  // The memory service is named so the chain stays under the code-health depth (tests by the lead).
  const { memoryDb } = one.memory;
  const db = memoryDb.database();
  assert.ok(db);
  return databaseDigest(db);
};

test('a principal that is not the owner is refused at the desk and nothing behind it runs', async () => {
  // Bug: a link that says hello as an interface reaches the owner's console, which reads and writes everything.
  const one = await rig();
  const before = digestOf(one);
  const network = noNetwork();
  const reached: Array<string> = [];
  const desk = createCommandDesk({
    console: {
      run: (name) => {
        reached.push(name);
        return Promise.resolve({ text: 'ran', status: 'ok', data: null });
      },
    },
    interfaces: { list: () => [], enable: () => undefined, disable: () => Promise.resolve({ drained: 0, unknown: 0 }) },
    facts: () => {
      throw new Error('a refused command reads no fact');
    },
    tasks: {
      command: (_principal, name) => {
        reached.push(name);
        return Promise.resolve({ text: 'ran', status: 'ok', data: null });
      },
    },
  });
  try {
    for (const name of ['memory.users.list', 'memory.inspect.export', 'model.set', 'status']) {
      const answer = await desk.run(
        { name, args: {}, conversation: { id: 'c1' }, requester: { id: 'u1', roles: [] } },
        { kind: 'interface', name: 'fake' }
      );
      assert.equal(answer.status, 'denied', name);
    }
  } finally {
    network.restore();
  }
  assert.deepEqual(reached, []);
  assert.deepEqual(network.reached, []);
  assert.deepEqual(digestOf(one), before);
});

test('a closed memory database answers its code, asks no model and leaves the file as it was', async () => {
  // Bug: a read on a closed core throws through the console, or reopens the database to answer.
  const one = await rig();
  const file = join(one.memory.dataDir, 'memory.db');
  await one.memory.close();
  const before = fileHash(file);
  const network = noNetwork();
  let answer: Answer;
  try {
    answer = await one.say('memory', 'users', 'list');
  } finally {
    network.restore();
  }
  assert.notEqual(answer.status, 'ok');
  assert.equal(answer.status, 'failed');
  assert.ok(answer.text.includes('closed'), answer.text);
  assert.ok(
    typeof answer.code === 'string' && answer.code !== '',
    `the refusal names no code: ${JSON.stringify(answer)}`
  );
  assert.deepEqual(network.reached, []);
  assert.deepEqual(one.checks, []);
  assert.equal(fileHash(file), before);
});

test('a command with no core listening exits 1 with the reason on stderr and nothing on stdout', async () => {
  // Bug: the command line hangs on a missing socket, or prints an empty answer and exits 0.
  const dirs = folders();
  addClient(dirs.privateDir, CLI_CLIENT);
  const run = await runCli(dirs, ['memory', 'users', 'list']);
  assert.equal(run.code, 1);
  assert.equal(run.stdout, '');
  assert.ok(run.stderr.includes('no core listens'), run.stderr);
});

test('a snapshot page continued after its snapshot expired is refused with the expiry code', async () => {
  // Bug: an old cursor reads a later moment of the database and the owner takes it for the one he opened.
  const one = await rig();
  const first = await one.say('memory', 'inspect', 'rows', 'meta', '--limit', '1');
  assert.equal(first.status, 'ok', first.text);
  const page = JSON.parse(first.text) as { snapshot: string; next: string | null };
  assert.ok(page.next, 'the first page leaves a cursor');
  const before = digestOf(one);
  one.clock.at += (BOUNDS.snapshotIdleSeconds + 1) * 1000;
  const network = noNetwork();
  let expired: Answer;
  try {
    expired = await one.say(
      'memory',
      'inspect',
      'rows',
      'meta',
      '--snapshot',
      page.snapshot,
      '--limit',
      '1',
      '--cursor',
      page.next
    );
  } finally {
    network.restore();
  }
  assert.notEqual(expired.status, 'ok');
  assert.equal(expired.code, 'INSPECTION_EXPIRED');
  assert.deepEqual(network.reached, []);
  assert.deepEqual(digestOf(one), before);
});

test('a model check that finished after the owner chose again is refused as stale and saves nothing', async () => {
  // The lead: routes are named direct-api, claude-harness, codex-harness and opencode-harness (owner, 2026-11-06).
  // Bug: the slow check of the first choice is written last, so the owner's newer choice silently disappears.
  let release: (value: BackendResult) => void = () => undefined;
  const held = new Promise<BackendResult>((resolve) => {
    release = resolve;
  });
  const one = await rig((model) => (model === 'slow' ? held : { ok: true, text: 'ok', exitCode: 0 }));
  const before = digestOf(one);
  const slow = one.say('model', 'set', 'thinker', 'slow', '--via', 'claude-harness');
  await new Promise((resolve) => setTimeout(resolve, 20));
  const quick = await one.say('model', 'set', 'thinker', 'quick', '--via', 'codex-harness');
  assert.equal(quick.status, 'ok', quick.text);
  release({ ok: true, text: 'ok', exitCode: 0 });
  const stale = await slow;
  assert.notEqual(stale.status, 'ok');
  assert.equal(stale.code, 'selection-changed');
  const stored = readKeysFile(one.dir).subharness;
  assert.deepEqual([stored.uses?.thinker, stored.models?.thinker], ['codex', 'quick']);
  assert.deepEqual(
    one.checks.map((entry) => entry.model),
    ['slow', 'quick']
  );
  assert.deepEqual(digestOf(one), before);
});

test('a model check that fails is reported with the reason it gave and saves nothing', async () => {
  // The lead: routes are named direct-api, claude-harness, codex-harness and opencode-harness (owner, 2026-11-06).
  // Bug: "gave no reply" for a rejection, or a model saved on a backend that refused it.
  const one = await rig(() => ({ ok: false, text: '', exitCode: 1, detail: 'that model is not on this plan' }));
  const before = digestOf(one);
  const network = noNetwork();
  let answer: Answer;
  try {
    answer = await one.say('model', 'set', 'thinker', 'sonnet', '--via', 'claude-harness');
  } finally {
    network.restore();
  }
  assert.notEqual(answer.status, 'ok');
  assert.equal(answer.code, 'model-rejected');
  assert.ok(answer.text.includes('that model is not on this plan'), answer.text);
  const stored = readKeysFile(one.dir).subharness;
  assert.equal(stored.uses?.thinker, undefined);
  assert.equal(stored.models?.thinker, undefined);
  assert.equal(one.checks.length, 1, 'the one check the owner asked for');
  assert.deepEqual(network.reached, []);
  assert.deepEqual(digestOf(one), before);
});

test('native usage that cannot be read automatically is stated with its hand-off and starts no run', async () => {
  // Bug: empty metrics read as an unused account, or the read spends a generated turn on the subscription.
  const privateDir = tempDir('nep-refusals-usage-');
  const vendor = fakeVendor(privateDir, 'claude', { loggedIn: true });
  const spawned: Array<ReadonlyArray<string>> = [];
  const read = (): Promise<ReadonlyArray<BackendUsage>> =>
    readClaudeUsage({
      privateDir,
      now: () => T0,
      spawn: (_binary, args) => {
        spawned.push(args);
        throw new Error('this test starts no child');
      },
    }).then((usage) => [usage]);
  const one = await rig(undefined, { backendUsage: read });
  const before = digestOf(one);
  const network = noNetwork();
  let answer: Answer;
  try {
    answer = await one.say('usage');
  } finally {
    network.restore();
  }
  assert.equal(answer.status, 'ok', answer.text);
  assert.ok(answer.text.includes('no automatic read for this source'), answer.text);
  assert.ok(answer.text.includes('by hand:'), answer.text);
  assert.deepEqual(spawned, []);
  for (const call of vendor.calls()) assert.ok(['auth status', '--help', '--version'].includes(call), call);
  assert.deepEqual(one.checks, []);
  assert.deepEqual(digestOf(one), before);
});

test('an image that cannot be staged is refused before the core sees the caption', async () => {
  // Bug: a text file named .png sends an empty image part and a turn over nothing.
  await withRig(
    { config: { models: { base: { vision: 'example/vision-model' } } } },
    async ({ dirs, llm, clis, cores }) => {
      cores.push(await startUnitsCore(dirs, llm));
      const file = join(dirs.root, 'not-an-image.png');
      writeFileSync(file, 'not-an-image');
      const cli = spawnCli(dirs, ['-p', CAPTION, '--attach', file]);
      clis.push(cli);
      const exit = await cli.exited;
      assert.notEqual(exit.code, 0);
      assert.notEqual(cli.stderr(), '', 'the failure is said');
      assert.equal(cli.stdout().includes(CAPTION), false);
      assert.equal(llm.requests.length, 0, 'no model request');
      assert.deepEqual(query(dirs, 'SELECT text FROM sources WHERE text = ?', CAPTION), [], 'no stored line');
      // A good image staged after the refusal still reaches the core: the refusal left no half-open state behind.
      const good = join(dirs.root, 'chart.png');
      writeFileSync(good, syntheticPng(3));
      const sent = spawnCli(dirs, ['-p', CAPTION, '--attach', good]);
      clis.push(sent);
      assert.deepEqual(await sent.exited, { code: 0, signal: null });
    }
  );
});
