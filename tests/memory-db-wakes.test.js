// Schema v11, stage 6 (spec 2026-10-24-memory-schema-v7, sections 6 and 11): wake runs with their states and
// idempotent actions, the inner life recording its runs through the service's writer (behind memoryDb.wakeRuns), stale
// runs interrupted at start-up, and the skills registry with the agents' activation rule (three bound hashes, no new
// capability, a rollback target). Synthetic data only; the ids are made up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openMemoryDb, schemaVersion, MIGRATIONS } from '../src/memory/db/open.js';
import { V11_TABLES } from '../src/memory/db/schema.js';
import {
  actionKey,
  applyWakeWrite,
  finishRun,
  interruptStale,
  recordAction,
  startRun,
  wakeRunOf,
} from '../src/memory/db/wakes.js';
import {
  activateVersion,
  addEvaluation,
  canonicalJson,
  manifestOf,
  newCapabilities,
  registerSkills,
  reviewsDue,
  rollback,
  skillVersionsOf,
} from '../src/memory/db/skills.js';
import { applyMemoryWrite } from '../src/memory/db/session-write.js';
import { createMemoryDb, engineCommit, opSources } from '../src/memory/db/service.js';
import { createInnerLife } from '../src/behavior/inner.js';
import { createEventDoor } from '../src/interface/door.js';
import { SKILL_DEFINITIONS } from '../src/skills/definitions.js';
import { NESTED_CAPABILITIES, WAKE_POLICY_VERSION } from '../src/skills/access.js';
import { buildDataDir } from './fixtures/memory-db/datadir.js';
import { tempDir } from './fixtures/tmp.js';

const NOW = Date.parse('2026-10-24T12:00:00.000Z');
const MINUTE = 60_000;
const SILENT = { info() {}, warn() {}, error() {}, debug() {} };
const count = (db, sql, ...params) => db.prepare(sql).get(...params).n;

test('v11: the tables exist, the schema is at its last version, constraints hold', () => {
  const handle = openMemoryDb(':memory:');
  try {
    assert.equal(schemaVersion(handle.db), MIGRATIONS.length);
    assert.ok(MIGRATIONS.length >= 11);
    for (const table of V11_TABLES)
      assert.ok(
        handle.db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?").get(table),
        table
      );
    const columns = (table) =>
      handle.db
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .map((column) => column.name);
    assert.ok(columns('sources').includes('tier'));
    assert.ok(columns('vectors').includes('evicted_at'));
    assert.ok(columns('media').includes('availability'));
    startRun(handle, { id: 'run-1', kind: 'heartbeat', startedAt: NOW });
    // The key must spell the run and the number; an unknown status is refused.
    assert.throws(
      () =>
        handle.db
          .prepare(
            "INSERT INTO wake_actions (run_id, n, idempotency_key, kind, status, at) VALUES ('run-1', 1, 'wake:other:1', 'x', 'executed', 'now')"
          )
          .run(),
      /CHECK/
    );
    assert.throws(
      () =>
        handle.db.prepare("INSERT INTO wake_runs (id, kind, status) VALUES ('run-2', 'heartbeat', 'sleeping')").run(),
      /CHECK/
    );
    assert.throws(
      () =>
        handle.db
          .prepare(
            "INSERT INTO wake_actions (run_id, n, idempotency_key, kind, status, at) VALUES ('nope', 1, 'wake:nope:1', 'x', 'executed', 'now')"
          )
          .run(),
      /FOREIGN KEY/
    );
    assert.deepEqual(handle.db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    handle.close();
  }
});

test('wakes: a restarted run creates no duplicate action; a finished run is not started or finished again', () => {
  const handle = openMemoryDb(':memory:');
  try {
    const inputs = {
      wakes: ['inner.wake:heartbeat:1'],
      intentions: [{ id: 'i1', updatedAt: NOW - MINUTE }],
      facts: ['f1'],
    };
    assert.deepEqual(
      startRun(handle, {
        id: 'run-1',
        kind: 'heartbeat',
        trigger: 'inner.wake:heartbeat:1',
        startedAt: NOW,
        inputs,
        policyVersion: WAKE_POLICY_VERSION,
      }),
      { id: 'run-1', created: true, status: 'running' }
    );
    const first = recordAction(handle, {
      runId: 'run-1',
      n: 1,
      kind: 'intent.set',
      target: { channel: 'c1' },
      status: 'executed',
      at: NOW + 1000,
    });
    assert.equal(first.created, true);
    assert.equal(first.key, actionKey('run-1', 1));
    recordAction(handle, { runId: 'run-1', n: 2, kind: 'message.create', status: 'proposed', at: NOW + 2000 });
    // The process dies: at start-up the run is interrupted; the restart takes the same run id and replays its actions.
    assert.equal(interruptStale(handle, { now: NOW + 10 * MINUTE, limitMs: 3 * MINUTE }), 1);
    assert.equal(wakeRunOf(handle.db, 'run-1').status, 'interrupted');
    assert.deepEqual(startRun(handle, { id: 'run-1', kind: 'heartbeat', startedAt: NOW + 11 * MINUTE }), {
      id: 'run-1',
      created: false,
      status: 'running',
    });
    const again = recordAction(handle, {
      runId: 'run-1',
      n: 1,
      kind: 'intent.set',
      target: { channel: 'c1' },
      status: 'executed',
      at: NOW + 12 * MINUTE,
    });
    assert.equal(again.created, false);
    assert.deepEqual(again.row, first.row, 'the second record of the same key returns the first row');
    recordAction(handle, { runId: 'run-1', n: 3, kind: 'intent.update', status: 'executed', at: NOW + 13 * MINUTE });
    assert.equal(count(handle.db, 'SELECT COUNT(*) AS n FROM wake_actions WHERE run_id = ?', 'run-1'), 3);
    assert.equal(
      finishRun(handle, { id: 'run-1', status: 'succeeded', outcome: 'spoke', finishedAt: NOW + 14 * MINUTE }),
      true
    );
    assert.equal(finishRun(handle, { id: 'run-1', status: 'failed', outcome: 'error' }), false, 'ended once');
    assert.deepEqual(startRun(handle, { id: 'run-1', kind: 'heartbeat' }), {
      id: 'run-1',
      created: false,
      status: 'succeeded',
    });
    const run = wakeRunOf(handle.db, 'run-1');
    assert.equal(run.status, 'succeeded');
    assert.equal(run.outcome, 'spoke');
    assert.equal(run.started_at, new Date(NOW).toISOString(), 'the first start is kept');
    assert.deepEqual(JSON.parse(run.inputs), inputs);
    assert.equal(run.policy_version, WAKE_POLICY_VERSION);
    assert.deepEqual(
      run.actions.map((action) => action.idempotency_key),
      ['wake:run-1:1', 'wake:run-1:2', 'wake:run-1:3']
    );
    assert.equal(run.actions[0].target, JSON.stringify({ channel: 'c1' }));
    assert.throws(() => recordAction(handle, { runId: 'nope', n: 1, kind: 'x', status: 'executed' }), {
      code: 'UNKNOWN_WAKE_RUN',
    });
  } finally {
    handle.close();
  }
});

test('wakes: only running rows older than the turn limit become interrupted; the writer path takes every op', () => {
  const handle = openMemoryDb(':memory:');
  try {
    startRun(handle, { id: 'old', kind: 'review', startedAt: NOW - 10 * MINUTE });
    startRun(handle, { id: 'young', kind: 'review', startedAt: NOW - MINUTE });
    startRun(handle, { id: 'done', kind: 'review', startedAt: NOW - 20 * MINUTE });
    finishRun(handle, { id: 'done', status: 'failed', outcome: 'error', finishedAt: NOW - 19 * MINUTE });
    assert.deepEqual(applyMemoryWrite(handle, { kind: 'wake', op: 'interrupt', now: NOW, limitMs: 3 * MINUTE }), {
      interrupted: 1,
    });
    const status = Object.fromEntries(
      handle.db
        .prepare('SELECT id, status FROM wake_runs')
        .all()
        .map((row) => [row.id, row.status])
    );
    assert.deepEqual(status, { old: 'interrupted', young: 'running', done: 'failed' });
    // A context issued for a run is recorded with it.
    applyWakeWrite(handle, {
      kind: 'wake',
      op: 'start',
      run: {
        id: 'ctx',
        kind: 'heartbeat',
        startedAt: NOW,
        context: { id: 'ctx:1', mode: 'internal', iface: null, issued_at: new Date(NOW).toISOString() },
      },
    });
    assert.equal(wakeRunOf(handle.db, 'ctx').context_id, 'ctx:1');
    assert.equal(count(handle.db, 'SELECT COUNT(*) AS n FROM execution_contexts WHERE id = ?', 'ctx:1'), 1);
    assert.deepEqual(
      applyMemoryWrite(handle, {
        kind: 'wake',
        op: 'actions',
        actions: [
          { runId: 'ctx', n: 1, kind: 'memory.search', status: 'executed', at: NOW },
          { runId: 'ctx', n: 1, kind: 'memory.search', status: 'executed', at: NOW },
        ],
      }),
      { recorded: 1 }
    );
    assert.throws(() => applyMemoryWrite(handle, { kind: 'wake', op: 'nope' }), { code: 'BAD_UPDATE' });
    assert.deepEqual(handle.db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    handle.close();
  }
});

// ---------- the inner life records its runs ----------

function innerHarness({ wakeRuns, actions = [], outcome = 'spoke' }) {
  const handle = openMemoryDb(':memory:');
  const writes = [];
  const memoryDb = {
    recordWake: async (update) => {
      writes.push(update);
      return applyMemoryWrite(handle, update);
    },
  };
  const records = [
    {
      id: 'i1',
      status: 'pending',
      purpose: 'say hello',
      dueAt: NOW - MINUTE,
      chainId: null,
      destination: null,
      provenance: { kind: 'self', channelId: 'c1', scope: 'group' },
      createdAt: NOW - 86_400_000,
      updatedAt: NOW - 3600_000,
      expiresAt: NOW + 7 * 86_400_000,
    },
  ];
  const intentions = {
    due: () => records.filter((r) => r.status === 'pending').map((r) => ({ intention: r, reason: 'due', at: r.dueAt })),
    reconcile: () => ({ arrived: 0, missing: 0, deadline: 0, expired: 0 }),
    list: () => records,
    store: () => ({ get: (id) => records.find((r) => r.id === id) ?? null, list: () => records }),
  };
  const calls = [];
  const turns = {
    isAnyBusy: () => false,
    runTurn: async (params) => {
      calls.push(params);
      return { outcome, inner: { actions, turnId: 'turn-x' } };
    },
  };
  const channels = new Map([['c1', { id: 'c1', name: 'general', guild: { id: 'g1' } }]]);
  const hot = {
    config: {
      bot: { timezone: 'UTC' },
      features: { innerLife: true, intentions: true, journal: false },
      mention: { oneAtATime: true },
      memoryDb: { wakeRuns },
      innerLife: {
        mode: 'shadow',
        tickSeconds: 60,
        queueMax: 20,
        chatMessages: 30,
        review: { enabled: false, historyDays: 14 },
        heartbeat: { enabled: false },
        caps: { perChain: 3 },
      },
    },
  };
  let inner;
  const door = createEventDoor({ handlers: { 'inner.wake': (event) => inner.onWake(event) }, log: SILENT });
  let n = 0;
  inner = createInnerLife({
    hot,
    dataDir: tempDir('nep-wakes-'),
    turns,
    intentions,
    client: { channels: { cache: channels, fetch: async (id) => channels.get(id) ?? null } },
    discord: { canSend: () => true },
    submit: (event) => door.submit(event),
    store: { state: { data: {} } },
    getGuildId: () => 'g1',
    meter: { run: async (fn) => ({ result: await fn(), usd: 0, requests: 1, voice: 0 }) },
    now: () => NOW,
    uuid: () => `u${(n += 1)}`,
    memoryDb,
    log: SILENT,
  });
  return { handle, writes, inner, calls };
}

const settle = async () => {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

test('inner life: with memoryDb.wakeRuns on, a turn is one wake run with its inputs, its actions once each, and its end', async () => {
  const actions = [
    { skill: 'memory.search', status: 'executed', result: 'ok', target: {} },
    { skill: 'message.create', status: 'proposed', result: 'ok', target: { channel: 'c1' } },
  ];
  const run = innerHarness({ wakeRuns: true, actions });
  try {
    await run.inner.tick();
    await settle();
    assert.equal(run.calls.length, 1);
    const runs = run.handle.db.prepare('SELECT * FROM wake_runs').all();
    assert.equal(runs.length, 1);
    const stored = wakeRunOf(run.handle.db, runs[0].id);
    assert.equal(stored.id, run.calls[0].journalTurn.turnId, 'the run is the in-flight turn');
    assert.equal(stored.kind, 'intention_due');
    assert.equal(stored.status, 'succeeded');
    assert.equal(stored.outcome, 'spoke');
    assert.equal(stored.policy_version, WAKE_POLICY_VERSION);
    const inputs = JSON.parse(stored.inputs);
    assert.deepEqual(inputs.intentions, [{ id: 'i1', updatedAt: NOW - 3600_000 }], 'ids with their versions');
    assert.equal(inputs.wakes.length, 1);
    assert.deepEqual(
      stored.actions.map((action) => `${action.n}:${action.kind}:${action.status}`),
      ['1:memory.search:executed', '2:message.create:proposed']
    );
    // A replay of the same writes (a restarted writer) adds nothing.
    for (const update of run.writes.filter((write) => write.op === 'actions')) applyMemoryWrite(run.handle, update);
    assert.equal(count(run.handle.db, 'SELECT COUNT(*) AS n FROM wake_actions'), 2);
  } finally {
    run.handle.close();
  }
});

test('inner life: with memoryDb.wakeRuns off (the default) nothing is written; a failed turn ends its run failed', async () => {
  const off = innerHarness({ wakeRuns: false, actions: [{ skill: 'memory.search', status: 'executed' }] });
  try {
    await off.inner.tick();
    await settle();
    assert.equal(off.calls.length, 1, 'the turn runs as before');
    assert.equal(off.writes.length, 0);
    assert.equal(count(off.handle.db, 'SELECT COUNT(*) AS n FROM wake_runs'), 0);
  } finally {
    off.handle.close();
  }
  const failed = innerHarness({ wakeRuns: true, outcome: 'error' });
  try {
    await failed.inner.tick();
    await settle();
    const row = failed.handle.db.prepare('SELECT status, outcome FROM wake_runs').get();
    assert.deepEqual({ ...row }, { status: 'failed', outcome: 'error' });
  } finally {
    failed.handle.close();
  }
});

test('service: recordWake writes only with memoryDb.wakeRuns on; an open interrupts the stale runs a dead process left', async () => {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'memdb-wakes-'));
  const data = path.join(root, 'data');
  fs.mkdirSync(data);
  buildDataDir(data);
  try {
    // A run a dead process left running.
    const before = openMemoryDb(path.join(data, 'memory.db'));
    startRun(before, { id: 'left', kind: 'heartbeat', startedAt: NOW - 30 * MINUTE });
    before.close();
    const hot = { config: { memoryDb: { wakeRuns: false }, innerLife: { loop: { timeBudgetMs: 3 * MINUTE } } } };
    let service = createMemoryDb({ hot, dataDir: data, log: SILENT, worker: false, now: () => NOW });
    await service.tick();
    await settle();
    assert.equal(
      service.recordWake({ kind: 'wake', op: 'start', run: { id: 'r1', kind: 'heartbeat', startedAt: NOW } }),
      null,
      'off: nothing'
    );
    await service.close();
    let reader = openMemoryDb(path.join(data, 'memory.db'), { readOnly: true });
    assert.equal(
      reader.db.prepare("SELECT status FROM wake_runs WHERE id = 'left'").get().status,
      'running',
      'off: no interrupt'
    );
    reader.close();
    hot.config.memoryDb.wakeRuns = true;
    service = createMemoryDb({ hot, dataDir: data, log: SILENT, worker: false, now: () => NOW });
    await service.tick();
    await settle();
    await service.recordWake({ kind: 'wake', op: 'start', run: { id: 'r1', kind: 'heartbeat', startedAt: NOW } });
    await service.close();
    reader = openMemoryDb(path.join(data, 'memory.db'), { readOnly: true });
    const status = Object.fromEntries(
      reader.db
        .prepare('SELECT id, status FROM wake_runs')
        .all()
        .map((row) => [row.id, row.status])
    );
    reader.close();
    assert.deepEqual(status, { left: 'interrupted', r1: 'running' });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---------- the skills registry ----------

const DEF = (name, extra = {}) => ({
  name,
  api: name.replace('.', '_'),
  op: name,
  params: { type: 'object', properties: {}, required: [] },
  refs: {},
  body: null,
  effects: 'read',
  costClass: 'free',
  feature: null,
  result: 'data',
  toArgs: () => ({}),
  ...extra,
});
let evalSeq = 0;
const evaluate = (handle, version, kind, { passed = true, hashes = null } = {}) =>
  addEvaluation(handle, {
    id: `eval-${(evalSeq += 1)}`,
    versionId: version.id,
    kind,
    passed,
    at: NOW,
    result: { cases: 3 },
    contentHash: hashes?.content ?? version.content_hash,
    manifestHash: hashes?.manifest ?? version.manifest_hash,
    commitSha: hashes?.commit ?? version.commit_sha,
  });
const versionsOf = (db, name) =>
  db
    .prepare('SELECT * FROM skill_versions WHERE skill_id = ? ORDER BY created_at, rowid')
    .all(`skill:${name}`)
    .map((row) => ({ ...row }));

test('skills registry: every definition registers with three hashes; the first version is active; a new commit is a candidate', () => {
  const handle = openMemoryDb(':memory:');
  try {
    const sources = opSources();
    assert.ok(sources.get('draw.create')?.includes("name: 'draw.create'"), "the operation's source file");
    const entries = skillVersionsOf({
      definitions: SKILL_DEFINITIONS,
      nested: NESTED_CAPABILITIES,
      sourceOf: (op) => sources.get(op) ?? '',
      commit: 'a'.repeat(40),
    });
    assert.equal(entries.length, SKILL_DEFINITIONS.length);
    for (const entry of entries) {
      assert.match(entry.contentHash, /^[0-9a-f]{64}$/);
      assert.match(entry.manifestHash, /^[0-9a-f]{64}$/);
      assert.equal(entry.commitSha, 'a'.repeat(40));
    }
    assert.deepEqual(
      entries.find((entry) => entry.name === 'draw.create').manifest.tools,
      ['draw.create', 'message.create'],
      'a picture is a post'
    );
    assert.deepEqual(registerSkills(handle, entries, { at: NOW }), {
      skills: entries.length,
      versions: entries.length,
      stale: 0,
    });
    assert.deepEqual(registerSkills(handle, entries, { at: NOW }), { skills: 0, versions: 0, stale: 0 }, 'idempotent');
    assert.equal(
      count(handle.db, "SELECT COUNT(*) AS n FROM skills WHERE active_version IS NOT NULL AND lifecycle = 'active'"),
      entries.length
    );
    const next = skillVersionsOf({
      definitions: SKILL_DEFINITIONS.slice(1),
      nested: NESTED_CAPABILITIES,
      sourceOf: (op) => sources.get(op) ?? '',
      commit: 'b'.repeat(40),
    });
    assert.deepEqual(registerSkills(handle, next, { at: NOW + 1 }), { skills: 0, versions: next.length, stale: 1 });
    assert.equal(count(handle.db, "SELECT COUNT(*) AS n FROM skill_versions WHERE status = 'candidate'"), next.length);
    assert.equal(
      handle.db.prepare('SELECT lifecycle FROM skills WHERE name = ?').get(SKILL_DEFINITIONS[0].name).lifecycle,
      'stale'
    );
    // Without a commit the registry says so; a hash column is never rewritten.
    assert.equal(skillVersionsOf({ definitions: [DEF('x.read')] })[0].commitSha, 'unknown');
    assert.match(engineCommit(), /^([0-9a-f]{7,64}|unknown)$/);
    assert.throws(() => handle.db.prepare("UPDATE skill_versions SET content_hash = 'x'").run(), /keeps its hashes/);
  } finally {
    handle.close();
  }
});

test('skills registry: activation refuses without the three bound hashes, with a new capability, without a rollback target; rollback restores', () => {
  const handle = openMemoryDb(':memory:');
  try {
    const v1 = skillVersionsOf({ definitions: [DEF('x.read')], commit: 'c1' });
    registerSkills(handle, v1, { at: NOW });
    const [first] = versionsOf(handle.db, 'x.read');
    assert.equal(first.status, 'active');
    // The bootstrap version itself has nothing to roll back to.
    assert.deepEqual(activateVersion(handle, first.id), { ok: false, code: 'already-active' });

    registerSkills(handle, skillVersionsOf({ definitions: [DEF('x.read')], commit: 'c2' }), { at: NOW + 1 });
    const candidate = versionsOf(handle.db, 'x.read')[1];
    assert.equal(candidate.status, 'candidate');
    assert.deepEqual(activateVersion(handle, candidate.id), { ok: false, code: 'no-tests' });
    evaluate(handle, candidate, 'tests', { hashes: { commit: 'c1' } });
    assert.deepEqual(
      activateVersion(handle, candidate.id),
      { ok: false, code: 'no-tests' },
      'tests of another commit do not count'
    );
    evaluate(handle, candidate, 'tests', { passed: false });
    assert.deepEqual(
      activateVersion(handle, candidate.id),
      { ok: false, code: 'no-tests' },
      'a failed run does not count'
    );
    evaluate(handle, candidate, 'tests');
    assert.deepEqual(activateVersion(handle, candidate.id), { ok: false, code: 'no-audience-check' });
    evaluate(handle, candidate, 'audience_check', { hashes: { manifest: 'f'.repeat(64) } });
    assert.deepEqual(
      activateVersion(handle, candidate.id),
      { ok: false, code: 'no-audience-check' },
      'a check of another manifest does not count'
    );
    evaluate(handle, candidate, 'audience_check');
    assert.equal(activateVersion(handle, candidate.id, { at: NOW + 2 }).ok, true);
    assert.equal(
      handle.db.prepare("SELECT active_version FROM skills WHERE name = 'x.read'").get().active_version,
      candidate.id
    );

    // A version that asks a new capability waits for the owner, whatever its evaluations.
    registerSkills(
      handle,
      skillVersionsOf({
        definitions: [DEF('x.read', { refs: { channel: 'channel' }, effects: 'write' })],
        commit: 'c3',
      }),
      { at: NOW + 3 }
    );
    const wider = versionsOf(handle.db, 'x.read')[2];
    evaluate(handle, wider, 'tests');
    evaluate(handle, wider, 'audience_check');
    const refused = activateVersion(handle, wider.id);
    assert.equal(refused.ok, false);
    assert.equal(refused.code, 'new-capability');
    assert.deepEqual(refused.added, ['destinations:current', 'destinations:other-channel', 'capabilities:write']);

    // Rollback: the version before the current one is active again; then nothing is left to roll back to.
    const back = rollback(handle, 'x.read', { at: NOW + 4 });
    assert.deepEqual(back, { ok: true, active: first.id, retired: candidate.id });
    assert.deepEqual(rollback(handle, 'x.read'), { ok: false, code: 'no-rollback' });
    // With no active version to roll back to (a skill whose version was never active), activation refuses no-rollback.
    handle.db.prepare("UPDATE skills SET active_version = NULL WHERE name = 'x.read'").run();
    assert.deepEqual(activateVersion(handle, candidate.id), { ok: false, code: 'no-rollback' });
    assert.throws(() => handle.db.prepare('DELETE FROM skill_evaluations').run(), /append-only/);
    assert.deepEqual(handle.db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    handle.close();
  }
});

test('skills registry: five uses or fourteen days after an agent activation is a monitoring reminder, until an outcome review', () => {
  const handle = openMemoryDb(':memory:');
  try {
    registerSkills(handle, skillVersionsOf({ definitions: [DEF('x.read'), DEF('y.read')], commit: 'c1' }), { at: NOW });
    registerSkills(handle, skillVersionsOf({ definitions: [DEF('x.read'), DEF('y.read')], commit: 'c2' }), { at: NOW });
    for (const name of ['x.read', 'y.read']) {
      const candidate = versionsOf(handle.db, name)[1];
      evaluate(handle, candidate, 'tests');
      evaluate(handle, candidate, 'audience_check');
      assert.equal(activateVersion(handle, candidate.id, { at: NOW }).ok, true);
    }
    const uses = { 'x.read': 5, 'y.read': 1 };
    assert.deepEqual(
      reviewsDue(handle.db, { now: NOW + 86_400_000, usesOf: (name) => uses[name] }).map(
        (due) => `${due.skill}:${due.reason}`
      ),
      ['x.read:uses']
    );
    assert.deepEqual(
      reviewsDue(handle.db, { now: NOW + 14 * 86_400_000, usesOf: (name) => uses[name] }).map(
        (due) => `${due.skill}:${due.reason}`
      ),
      ['x.read:uses', 'y.read:days']
    );
    const active = handle.db.prepare("SELECT active_version FROM skills WHERE name = 'x.read'").get().active_version;
    evaluate(handle, handle.db.prepare('SELECT * FROM skill_versions WHERE id = ?').get(active), 'outcome');
    assert.deepEqual(
      reviewsDue(handle.db, { now: NOW + 14 * 86_400_000, usesOf: (name) => uses[name] }).map((due) => due.skill),
      ['y.read']
    );
  } finally {
    handle.close();
  }
});

test('skills manifest: what a definition declares, and what a next version adds (pure)', () => {
  assert.deepEqual(manifestOf(DEF('web.search')), {
    tools: ['web.search'],
    destinations: [],
    network: ['web'],
    fileAccess: [],
    capabilities: ['read'],
  });
  assert.deepEqual(
    manifestOf(
      DEF('message.create', {
        effects: 'write',
        refs: { channel: 'channel' },
        params: { type: 'object', properties: { file: {} } },
        feature: 'x',
      })
    ),
    {
      tools: ['message.create'],
      destinations: ['current', 'other-channel'],
      network: [],
      fileAccess: ['errand-files'],
      capabilities: ['feature:x', 'write'],
    }
  );
  assert.deepEqual(newCapabilities({ tools: ['a'], network: [] }, { tools: ['a', 'b'], network: ['provider'] }), [
    'tools:b',
    'network:provider',
  ]);
  assert.equal(canonicalJson({ b: 1, a: [2, { d: 3, c: 4 }] }), '{"a":[2,{"c":4,"d":3}],"b":1}');
});
