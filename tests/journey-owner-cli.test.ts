// Task 17.1: one synthetic owner journey through both spellings of the command line, over the real console, the real
// memory service and a database the one writer filled. The owner's argv (`neptunia memory users show ...`, parsed by
// bin/neptunia-request.ts) and the chat's line (`/memory users show ...`, parsed by the table) reach the same desk, so a
// step runs once on each path and the two answers are the same text with the same status. The journey chooses a model
// whose check is a fake backend run, inspects one person and the DM of that person, runs a heartbeat on a real inner
// life over a fake turn runner and reads its clock back through `services`, reads the memory and exports it. No model is
// asked outside the one fake check, no request leaves the process, and the export reconciles with the database.
// Synthetic content only.
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseRequest } from '../bin/neptunia-request.ts';
import { createInnerLife } from '../src/behavior/inner.ts';
import { createEventDoor } from '../src/interface/door.ts';
import { createIntentionService } from '../src/intentions/service.ts';
import { createIntentionStores } from '../src/intentions/store.ts';
import { createConsole } from '../src/interface/commands/console.ts';
import type { Answer } from '../src/interface/commands/console.ts';
import { parseCommandLine } from '../src/interface/commands/table.ts';
import { wakeClockOf } from '../src/service/commands.ts';
import type { BackendResult } from '../src/agent-runner/backend.ts';
import { actualTableNames, countOf } from './fixtures/memory-db/browser-world.ts';
import { fakeVendor } from './fixtures/fake-vendor.ts';
import { readKeysFile, writeKeysFile } from './fixtures/keys-file.ts';
import { fakeFetch } from './fixtures/keys-rig.ts';
import { openTestMemory } from './fixtures/memory-db/service.ts';
import type { TestMemory } from './fixtures/memory-db/service.ts';
import { ALEX, DM_ALEX, addSource, semanticWorld } from './fixtures/memory-db/semantic-world.ts';
import { tempDir } from './fixtures/tmp.ts';
import { useIface, world as turnWorld } from './fixtures/turn-world.ts';

useIface('fake');

const BOUNDS = { pageRows: 25, snapshotIdleSeconds: 60, snapshotMaxSeconds: 300, maxSnapshots: 8 };
const PRIVATE_LINE = 'zinnia-private: the garden plan is between us';
const PUBLIC_LINE = 'zinnia-public: the room agreed on the garden plan';
const START = Date.parse('2026-11-05T05:00:00Z');
const HOUR = 3_600_000;
const SILENT = { info() {}, warn() {}, error() {}, debug() {} };

type Journey = {
  memory: TestMemory;
  dir: string;
  checks: Array<{ model: string | undefined }>;
  fetched: Array<string>;
  clock: { t: number };
  life: ReturnType<typeof createInnerLife>;
  config: Record<string, unknown>;
  /** The owner's argv words, parsed as `neptunia <words>` and run on the desk. */
  argv(...words: Array<string>): Promise<Answer>;
  /** The chat's line, parsed by the table and run on the same desk. */
  chat(line: string): Promise<Answer>;
};

let journey: Journey;

before(async () => {
  const worldOfMemory = semanticWorld();
  addSource(worldOfMemory, 'public', PUBLIC_LINE);
  addSource(worldOfMemory, 'alex', PRIVATE_LINE);
  worldOfMemory.handle.close();
  const dir = dirname(worldOfMemory.file);
  mkdirSync(join(dir, 'config'), { recursive: true });
  writeKeysFile(dir, { subharness: { key: null, modes: {}, backends: ['claude'] } });
  fakeVendor(dir, 'claude', { loggedIn: true });
  const memory = await openTestMemory({ dataDir: dir, config: { memoryDb: { inspection: BOUNDS } } });

  // A heartbeat on a real inner life: the turn runner is a fake that skips, so the wake is handled and nothing is sent.
  const clock = { t: START };
  const config = {
    bot: { timezone: 'UTC', owners: [], placeId: 'g1' },
    features: { wakes: true, intentions: true, journal: true },
    mention: { oneAtATime: true },
    wakes: { mode: 'shadow', tickSeconds: 60, review: { enabled: false, historyDays: 14 }, caps: { perChain: 3 } },
    heartbeat: { enabled: true, schedule: 'every 4h', jitterMinutes: 0 },
    selfimprovement: { enabled: false },
    memoryDb: { inspection: BOUNDS },
  };
  const hot = { config, prompts: {} };
  turnWorld().channel({ id: 'c1', name: 'chan-c1', placeId: 'g1', permissions: { send: true } });
  const service = createIntentionService({
    stores: createIntentionStores({ dataDir: tempDir('nep-journey-'), now: () => clock.t, log: SILENT }),
    hot,
    now: () => clock.t,
    log: SILENT,
  });
  let life: ReturnType<typeof createInnerLife> | null = null;
  const door = createEventDoor({ handlers: { 'inner.wake': (event: object) => life?.onWake(event) }, log: SILENT });
  life = createInnerLife({
    hot,
    dataDir: tempDir('nep-journey-inner-'),
    turns: {
      isAnyBusy: () => false,
      runTurn: () =>
        Promise.resolve({ outcome: 'skip', reason: 'nothing-to-do', inner: { actions: [], turnId: 't-1' } }),
    },
    intentions: service,
    journal: { inner: () => Promise.resolve(), read: () => [] },
    reads: turnWorld().reads,
    iface: () => 'fake',
    chatName: (id: string) => `chan-${id}`,
    submit: (event: object) => door.submit(event),
    store: { state: { data: {} } },
    meter: { run: async (fn: () => unknown) => ({ result: await fn(), usd: 0, requests: 1, voice: 0 }) },
    selfimprovement: {
      granted: () => [],
      skills: () => [],
      proposals: () => Promise.resolve({ entries: [], outbox: [] }),
      ackOutbox: () => Promise.resolve(),
    },
    rng: () => 0.5,
    now: () => clock.t,
    log: SILENT,
  });

  const checks: Journey['checks'] = [];
  const fetched: Array<string> = [];
  const provider = fakeFetch();
  const desk = createConsole({
    runOp: () => Promise.resolve({ status: 'failed', code: 'NOT_FOR_THIS_JOURNEY', summary: '', data: null }),
    ownerReads: { lessons: () => '', aliases: () => '' },
    places: () => ['g1'],
    selfId: () => null,
    hot: { config, prompts: {} },
    privateDir: dir,
    dataDir: memory.dataDir,
    memoryDb: memory.memoryDb,
    usage: null,
    metrics: { samples: () => [] },
    chatLines: () => [],
    now: () => clock.t,
    serviceManager: () => Promise.resolve({ code: 0, stdout: '', stderr: '' }),
    wakeClock: (name) =>
      wakeClockOf(name, {
        now: clock.t,
        inner: life,
        selfreflection: { status: () => ({ slots: [], done: [] }) },
      }),
    subharness: {
      runBackend: (_name, _brief, model): Promise<BackendResult> => {
        checks.push({ model });
        return Promise.resolve({ ok: true, text: 'ok', exitCode: 0 });
      },
      fetch: provider.fetch,
      helpOf: () => Promise.resolve('Options:\n  --effort <level>\n'),
      applyMode: () => Promise.resolve('the unit took it'),
    },
  });
  const run = async (command: { name: string; args: Record<string, unknown> }): Promise<Answer> => {
    const real = globalThis.fetch;
    globalThis.fetch = (input) => {
      fetched.push(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      return Promise.reject(new Error('the journey reached the network'));
    };
    try {
      return await desk.run(command.name, command.args, { id: 'owner' });
    } finally {
      globalThis.fetch = real;
    }
  };
  journey = {
    memory,
    dir,
    checks,
    fetched,
    clock,
    life,
    config,
    argv: (...words) => {
      const parsed = parseRequest(words).parsed;
      assert.ok(parsed.ok, parsed.ok ? '' : `${words.join(' ')}: ${parsed.reason}`);
      return run(parsed);
    },
    chat: (line) => {
      const parsed = parseCommandLine(line);
      assert.ok(parsed.ok, parsed.ok ? '' : `${line}: ${parsed.reason}`);
      return run(parsed);
    },
  };
});

after(async () => {
  await journey?.memory.close();
});

const same = (one: Answer, two: Answer): void => {
  assert.equal(one.status, 'ok', one.text.slice(0, 300));
  assert.equal(two.status, 'ok', two.text.slice(0, 300));
  assert.equal(two.text, one.text);
};

test('a model chosen on argv and another on the chat are each checked once, saved, and read the same on both paths', async () => {
  // The lead: routes are named direct-api, claude-harness, codex-harness and opencode-harness (owner, 2026-11-06).
  // Bug: one spelling saves a choice the check never ran, or `model show` answers differently on the two paths.
  const first = await journey.argv('model', 'set', 'thinker', 'sonnet', '--via', 'claude-harness');
  assert.equal(first.status, 'ok', first.text);
  const second = await journey.chat('/model set scout haiku --via claude-harness');
  assert.equal(second.status, 'ok', second.text);
  assert.deepEqual(
    journey.checks.map((one) => one.model),
    ['sonnet', 'haiku']
  );
  const stored = readKeysFile(journey.dir).subharness;
  assert.deepEqual([stored.uses?.thinker, stored.models?.thinker], ['claude', 'sonnet']);
  assert.deepEqual([stored.uses?.scout, stored.models?.scout], ['claude', 'haiku']);
  const sources = await journey.argv('model', 'sources', 'thinker');
  same(sources, await journey.chat('/model sources thinker'));
});

test('the same person is the same answer on argv and on the chat', async () => {
  // Bug: the two parsers hand the handler different arguments, so one spelling shows another record.
  const argv = await journey.argv('memory', 'users', 'show', ALEX);
  same(argv, await journey.chat(`/memory users show ${ALEX}`));
  assert.ok(argv.text.includes(ALEX), 'the answer names the person');
});

test('the same DM is the same answer on both paths, and its private line is the DM source alone', async () => {
  // Bug: a DM read on one path drops its audience, so the private line reaches the other as a public record.
  same(await journey.argv('memory', 'users', 'private', ALEX), await journey.chat(`/memory users private ${ALEX}`));
  same(await journey.argv('memory', 'places', 'show', DM_ALEX), await journey.chat(`/memory places show ${DM_ALEX}`));
  const dmSource = await journey.argv('memory', 'sources', 'show', 'src:2');
  same(dmSource, await journey.chat('/memory sources show src:2'));
  assert.ok(dmSource.text.includes(PRIVATE_LINE), 'the DM source shows its private line');
  const publicSource = await journey.argv('memory', 'sources', 'show', 'src:1');
  assert.equal(publicSource.text.includes(PRIVATE_LINE), false);
});

test('a heartbeat runs on the inner life and both paths read its clock the same', async () => {
  // Bug: the status reads another field of the wake state than the run wrote, or one path shows a stale clock.
  await journey.life.tick();
  const before = await journey.argv('services', 'heartbeat', 'status');
  same(before, await journey.chat('/services heartbeat status'));
  assert.deepEqual(Object.keys(journey.life.state()?.handled ?? {}), []);
  journey.clock.t = START + 4 * HOUR + 60_000;
  await journey.life.tick();
  await journey.life.tick();
  const handled = Object.keys(journey.life.state()?.handled ?? {}).filter((id) => id.includes('heartbeat'));
  assert.equal(handled.length, 1, 'the heartbeat wake was handled once');
  const after = await journey.argv('services', 'heartbeat', 'status');
  same(after, await journey.chat('/services heartbeat status'));
  assert.notEqual(after.text, before.text, 'the status moved with the run');
  assert.ok(after.text.includes(new Date(journey.clock.t).toISOString().slice(0, 16)), after.text);
});

test('the memory export is the same row counts on both paths and reconciles with the database', async () => {
  // Bug: the export is short of a table the browser lists, or the two spellings write different files.
  const files = [join(journey.dir, 'argv.jsonl'), join(journey.dir, 'chat.jsonl')];
  const argv = await journey.argv('memory', 'inspect', 'export', files[0] ?? '');
  const chat = await journey.chat(`/memory inspect export ${files[1]}`);
  assert.equal(argv.status, 'ok', argv.text);
  assert.equal(chat.status, 'ok', chat.text);
  const manifests = [argv, chat].map(
    (one) => (JSON.parse(one.text) as { manifest: { rows: Record<string, number> } }).manifest.rows
  );
  assert.deepEqual(manifests[1], manifests[0]);
  // The memory service is named so the chain stays under the code-health depth (tests by the lead).
  const { memoryDb } = journey.memory;
  const db = memoryDb.database();
  assert.ok(db);
  assert.deepEqual(manifests[0], Object.fromEntries(actualTableNames(db).map((table) => [table, countOf(db, table)])));
  const exported = readFileSync(files[0] ?? '', 'utf8')
    .split('\n')
    .filter((line) => line !== '');
  const rows = exported.filter((line) => (JSON.parse(line) as { kind: string }).kind === 'row');
  assert.equal(
    rows.length,
    Object.values(manifests[0] ?? {}).reduce((sum, n) => sum + n, 0)
  );
});

test('no step reached the network or asked a model beyond the two fake checks', () => {
  // Bug: a read command starts a provider request or a backend run the owner never asked for.
  assert.deepEqual(journey.fetched, []);
  assert.equal(journey.checks.length, 2);
});
