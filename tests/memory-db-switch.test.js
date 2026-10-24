// Stage W3 of the memory writer switch (spec 2026-10-24-memory-authority, section 6 item 7): her memory session is the
// memory writer under authority `db`. The live schedule (thresholds, caps, no overlap, a failure told), the handoff
// from the analyzer (the cursor at its boundary, idempotent, nothing twice and nothing skipped), the analyzer's memory
// path and the extractor off under `db` on a scripted day (a fake llm records every request), the effective models,
// the refused forgets, and the day comparison tool on a fake model. Synthetic Greek and accented Latin text only;
// nothing leaves the process.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { openMemoryDb } from '../src/memory/db/open.js';
import { applyMemoryWrite } from '../src/memory/db/session-write.js';
import { batchOf, cursorKey, scopesOf, sessionSettings, sweep } from '../src/memory/db/session.js';
import { HANDOFF_KEY, applyCursorKey, handoff } from '../src/memory/db/handoff.js';
import { dueScopes, effectiveModels, effectiveModelsLine, openFlags, reviewsToday } from '../src/memory/db/writer-switch.js';
import { createMemoryDb } from '../src/memory/db/service.js';
import { FORGET_REFUSED } from '../src/memory/db/authority.js';
import { channelPlaceId, dmPlaceId, guildPlaceId, messageSourceId, personId } from '../src/memory/db/ids.js';
import { roleApiKey } from '../src/llm/openrouter.js';
import { MEMORY_ROLE, PURPOSE_AT_SWITCH, PURPOSE_ROLES, retiredAtSwitch } from '../src/llm/roles.js';
import { createStore } from '../src/memory/store.js';
import { createMemoryUpdater } from '../src/memory/update.js';
import { createWarmup } from '../src/memory/warmup.js';
import { createIntentionStore } from '../src/intentions/store.js';
import { createTaskStore } from '../src/errands/store.js';
import { runOpPrechecked } from '../src/ops/index.js';
import { createCalibrator } from '../src/llm/tokens.js';
import { runCompare } from '../tools/memory-session.mjs';
import { labels } from './fixtures/labels.js';
import { tempDir } from './fixtures/tmp.js';

const NOW = Date.parse('2026-10-25T12:00:00.000Z');
const MINUTE = 60_000;
const ADA = 'u-ada';
const BOB = 'u-bob';
const GUILD = 'G1';
const CHANNEL = channelPlaceId('c1');
const SELF_ACCOUNT = 'discord:u-self';
const GROUP = { scope_kind: 'group', scope_iface: 'discord', scope_dm: null };
const ADA_DM = { scope_kind: 'dm', scope_iface: 'discord', scope_dm: personId(ADA) };

const prompts = {
  'system-prompt': 'SYSTEM {{name}}',
  'character-card': 'CARD {{name}}',
  rules: 'RULES',
  format: 'FORMAT',
  'memory-session': 'SESSION {{name}}',
  'description-draft': 'DRAFT',
  'description-check': 'CHECK',
  labels,
};

const memoryBlock = (value) => `<think>reading</think>\n<memory>\n${JSON.stringify(value)}\n</memory>`;
const meta = (db, key) => db.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value ?? null;
const rowidOf = (db, id) => db.prepare('SELECT rowid FROM sources WHERE id = ?').get(id).rowid;

/** The people, accounts and places of the fixture, in `db`. */
function seed(db) {
  db.prepare("INSERT INTO people (id, kind, affinity) VALUES (?, 'member', 5)").run(personId(ADA));
  db.prepare("INSERT INTO people (id, kind, affinity) VALUES (?, 'member', 0)").run(personId(BOB));
  db.prepare("INSERT INTO accounts (id, iface, native_id, person_id, names) VALUES (?, 'discord', ?, ?, ?)").run(`discord:${ADA}`, ADA, personId(ADA), JSON.stringify(['Ada']));
  db.prepare("INSERT INTO accounts (id, iface, native_id, person_id, names) VALUES (?, 'discord', ?, ?, ?)").run(`discord:${BOB}`, BOB, personId(BOB), JSON.stringify(['Βασίλης']));
  db.prepare("INSERT INTO places (id, iface, kind, native_id, parent_id, scope_kind, name, topic) VALUES (?, 'discord', 'guild', ?, NULL, 'group', 'Server', NULL)").run(guildPlaceId(GUILD), GUILD);
  db.prepare("INSERT INTO places (id, iface, kind, native_id, parent_id, scope_kind, name, topic) VALUES (?, 'discord', 'channel', 'c1', ?, 'group', 'general', 'chat')").run(CHANNEL, guildPlaceId(GUILD));
}

/** One chat line: `at` (ms) its time; returns its source id. */
function say(db, { native, at, text, author = ADA, kind = 'seen', scope = GROUP, place = CHANNEL }) {
  const iso = new Date(at).toISOString();
  db.prepare(`INSERT INTO sources (id, kind, iface, native_id, revision, place_id, author_account, occurred_at, recorded_at, text, direct,
    scope_kind, scope_iface, scope_dm) VALUES (?, ?, 'discord', ?, 1, ?, ?, ?, ?, ?, 0, ?, ?, ?)`)
    .run(messageSourceId(native, 1, kind), kind, String(native), place, kind === 'said' ? SELF_ACCOUNT : `discord:${author}`, iso, iso, text, scope.scope_kind, scope.scope_iface, scope.scope_dm);
  return messageSourceId(native, 1, kind);
}

/** The analyzer's buffer at shutdown, as stage W2b keeps it (a `buffer` operational row of the file's value). */
function buffer(db, owner, ids) {
  db.prepare("INSERT INTO operational (kind, owner, value, owner_file) VALUES ('buffer', ?, ?, ?)").run(owner, JSON.stringify(ids.map((id) => ({ id, content: 'x' }))), owner);
}

/** A fake llm: `answer(messages, options, n)` (a string or an Error), every request recorded. */
function fakeLlm(answer) {
  const calls = [];
  return {
    calls,
    async complete(messages, options) {
      calls.push({ messages, options });
      const next = typeof answer === 'function' ? await answer(messages, options, calls.length) : answer;
      if (next instanceof Error) throw next;
      return { text: next, usage: { prompt_tokens: 1000, completion_tokens: 50, cost: 0.01 } };
    },
  };
}

const sessionConfig = (session = {}, extra = {}) => ({
  bot: { timezone: 'UTC' },
  features: { memoryDb: true },
  models: { base: { memory: 'x/memory' } },
  llm: { temperature: 1, keyByRole: { memory: 'OPENROUTER_MEMORY_KEY' } },
  relationships: { maxDeltaPerUpdate: 5 },
  recall: { backend: 'db' },
  memoryDb: { authority: 'db', read: true, observeLive: true, session: { mode: 'apply', minMessages: 3, maxMessages: 50, settleMinutes: 0, everyMinutes: 60, ...session }, ...extra },
});

// ---------- the schedule ----------

test('dueScopes: enough settled lines, then every everyMinutes or at maxMessages, under the per-scope cap', () => {
  const handle = openMemoryDb(':memory:');
  const { db } = handle;
  try {
    seed(db);
    for (let n = 1; n <= 2; n += 1) say(db, { native: `m${n}`, at: NOW - 30 * MINUTE + n, text: `línea ${n}` });
    const config = sessionConfig({ minMessages: 3, maxMessages: 4, everyMinutes: 60, sweepsPerScopePerDay: 2 });
    assert.deepEqual(dueScopes(db, config, NOW), [], 'two lines wait for a third');
    say(db, { native: 'm3', at: NOW - 20 * MINUTE, text: 'τρίτη' });
    assert.deepEqual(dueScopes(db, config, NOW), [{ key: 'group:discord', lines: 3, full: false }], 'no run yet counts as long ago');
    // a run 10 minutes ago: the scope waits for everyMinutes ...
    const run = (id, minutesAgo, sweepId = id) => db.prepare("INSERT INTO session_runs (id, sweep_id, scope_key, mode, started_at, outcome) VALUES (?, ?, 'group:discord', 'apply', ?, 'ok')")
      .run(id, sweepId, new Date(NOW - minutesAgo * MINUTE).toISOString());
    run('r1', 10);
    assert.deepEqual(dueScopes(db, config, NOW), []);
    assert.equal(dueScopes(db, config, NOW + 51 * MINUTE).length, 1, 'everyMinutes passed');
    // ... unless maxMessages lines wait
    say(db, { native: 'm4', at: NOW - 5 * MINUTE, text: 'cuarta' });
    assert.deepEqual(dueScopes(db, config, NOW), [{ key: 'group:discord', lines: 4, full: true }]);
    // a line newer than the settle time is not counted
    assert.equal(dueScopes(db, sessionConfig({ minMessages: 3, maxMessages: 4, settleMinutes: 10, everyMinutes: 0 }), NOW)[0].lines, 3);
    // the per-scope cap of the UTC day
    run('r2', 5);
    assert.deepEqual(dueScopes(db, config, NOW), [], 'two sweeps of the scope today');
    assert.equal(dueScopes(db, config, Date.parse('2026-10-26T01:00:00.000Z')).length, 1, 'a new UTC day');
  } finally {
    handle.close();
  }
});

test('sessionSettings: the per-scope cap reads the old daily key while its own is missing', () => {
  assert.equal(sessionSettings({ memoryDb: { session: { sweepsPerDay: 3 } } }).sweepsPerScopePerDay, 3);
  assert.equal(sessionSettings({ memoryDb: { session: { sweepsPerDay: 3, sweepsPerScopePerDay: 7 } } }).sweepsPerScopePerDay, 7);
  const set = sessionSettings({ memoryDb: { session: { everyMinutes: 15, reviewsPerDay: 0 } } });
  assert.deepEqual([set.everyMinutes, set.reviewsPerDay], [15, 0]);
});

test('sweep: a scope at its daily cap is left, the other scopes run; every scope capped is a refused sweep', async () => {
  const handle = openMemoryDb(':memory:');
  const { db } = handle;
  try {
    seed(db);
    for (let n = 1; n <= 3; n += 1) say(db, { native: `g${n}`, at: NOW - 60 * MINUTE + n, text: `ομάδα ${n}` });
    for (let n = 1; n <= 3; n += 1) say(db, { native: `d${n}`, at: NOW - 60 * MINUTE + n, text: `privé ${n}`, scope: ADA_DM, place: dmPlaceId(ADA) });
    db.prepare("INSERT INTO session_runs (id, sweep_id, scope_key, mode, started_at, outcome) VALUES ('r0', 's0', 'group:discord', 'apply', ?, 'ok')").run(new Date(NOW - MINUTE).toISOString());
    const llm = fakeLlm(memoryBlock({}));
    let clock = NOW;
    const ctx = (config) => ({ db, write: async (update) => applyMemoryWrite(handle, { ...update, authority: 'db' }), llm, hot: { config, prompts }, env: { OPENROUTER_MEMORY_KEY: 'k' }, now: () => (clock += 1000), log: {}, selfName: 'Nep' });
    const result = await sweep(ctx(sessionConfig({ sweepsPerScopePerDay: 1 })));
    assert.equal(result.status, 'ok');
    assert.deepEqual(result.runs.map((run) => [run.scope, run.outcome]), [['dm:discord:person:discord:u-ada', 'ok'], ['group:discord', 'capped']]);
    for (let n = 4; n <= 6; n += 1) say(db, { native: `d${n}`, at: NOW - 30 * MINUTE + n, text: `privé ${n}`, scope: ADA_DM, place: dmPlaceId(ADA) });
    const capped = await sweep(ctx(sessionConfig({ sweepsPerScopePerDay: 1 })));
    assert.deepEqual([capped.status, capped.code], ['refused', 'sweep_cap']);
    assert.equal(llm.calls.length, 1);
  } finally {
    handle.close();
  }
});

/** A data directory with a database holding `prepare(db)`, and the service over it (no worker; its own handle kept). */
function serviceFixture({ config, prepareDb, llm, onSessionFailure = null, logs = [] }) {
  const dataDir = tempDir('nep-w3-');
  const file = path.join(dataDir, 'memory.db');
  const first = openMemoryDb(file);
  try {
    seed(first.db);
    prepareDb?.(first.db);
    first.db.prepare("INSERT INTO meta (key, value) VALUES ('service_import_done', '1')").run();
  } finally {
    first.close();
  }
  const hot = { config, prompts };
  const clock = { at: NOW };
  const log = { info: (message, fields) => logs.push({ level: 'info', message, ...fields }), warn: (message, fields) => logs.push({ level: 'warn', message, ...fields }), error: (message, fields) => logs.push({ level: 'error', message, ...fields }), debug() {} };
  const held = { handle: null };
  const service = createMemoryDb({
    hot, dataDir, log, now: () => clock.at, defer: (fn) => setImmediate(fn),
    open: (target, options) => (held.handle = openMemoryDb(target, options)),
    sessionLlm: () => llm, sessionEnv: () => ({ OPENROUTER_MEMORY_KEY: 'secret-memory-value' }), onSessionFailure, selfName: () => 'Nep',
  });
  return { dataDir, hot, clock, service, held, logs };
}

test('the service: the handoff at the first start, then one scheduled sweep of the due scope through the writer', async () => {
  const llm = fakeLlm(memoryBlock({}));
  const logs = [];
  const fx = serviceFixture({
    config: sessionConfig(),
    llm,
    logs,
    prepareDb: (db) => {
      for (let n = 1; n <= 4; n += 1) say(db, { native: `m${n}`, at: NOW - 90 * MINUTE + n, text: `línea ${n}` });
      // the analyzer had consumed nothing yet: every line is in its buffer
      buffer(db, `guilds/${GUILD}/buffer.json`, ['m1', 'm2', 'm3', 'm4']);
    },
  });
  try {
    await fx.service.tick();
    await fx.service.waitSession();
    const { db } = fx.held.handle;
    assert.ok(meta(db, HANDOFF_KEY), 'the handoff ran');
    assert.equal(llm.calls.length, 1);
    assert.deepEqual([llm.calls[0].options.role, llm.calls[0].options.purpose], [MEMORY_ROLE, 'memory-session']);
    assert.equal(Number(meta(db, cursorKey('apply', 'group:discord'))), rowidOf(db, messageSourceId('m4', 1, 'seen')), 'the cursor moved with the applied run');
    assert.equal(fx.service.status().session.handoff, true);
    const models = logs.find((line) => line.message === 'memory db: effective models');
    assert.ok(models?.purposes.includes('memory-session=x/memory@OPENROUTER_MEMORY_KEY'));
    assert.ok(!JSON.stringify(logs).includes('secret-memory-value'), 'never a key value');
    // new lines: the scope waits everyMinutes since its last run, the look itself once a minute
    for (let n = 5; n <= 8; n += 1) say(db, { native: `m${n}`, at: NOW - 10 * MINUTE + n, text: `línea ${n}` });
    fx.clock.at = NOW + 2 * MINUTE;
    await fx.service.tick();
    await fx.service.waitSession();
    assert.equal(llm.calls.length, 1, 'everyMinutes not passed');
    fx.clock.at = NOW + 61 * MINUTE;
    await fx.service.tick();
    await fx.service.waitSession();
    assert.equal(llm.calls.length, 2, 'due again');
    const files = fs.readdirSync(fx.dataDir).filter((name) => !name.startsWith('memory.db'));
    assert.deepEqual(files, [], 'no file written');
  } finally {
    await fx.service.close();
  }
});

test('the service: never two sweeps at once', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const llm = fakeLlm(async () => { await gate; return memoryBlock({}); });
  const fx = serviceFixture({
    config: sessionConfig(),
    llm,
    prepareDb: (db) => {
      for (let n = 1; n <= 4; n += 1) say(db, { native: `m${n}`, at: NOW - 90 * MINUTE + n, text: `línea ${n}` });
      buffer(db, `guilds/${GUILD}/buffer.json`, ['m1', 'm2', 'm3', 'm4']);
    },
  });
  try {
    await fx.service.tick();
    for (let i = 0; i < 50 && llm.calls.length === 0; i += 1) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(llm.calls.length, 1);
    assert.equal(fx.service.status().session.running, true);
    fx.clock.at = NOW + 5 * MINUTE;
    await fx.service.tick();
    fx.clock.at = NOW + 120 * MINUTE;
    await fx.service.tick();
    assert.equal(llm.calls.length, 1, 'the second look waits for the first sweep');
    release();
    await fx.service.waitSession();
    assert.equal(fx.service.status().session.running, false);
  } finally {
    release();
    await fx.service.close();
  }
});

test('the service: a failed run is a warning, the status and one fact for her per failing scope, never a file', async () => {
  const told = [];
  const logs = [];
  const llm = fakeLlm(Object.assign(new Error('provider down'), { code: 'HTTP_503' }));
  const fx = serviceFixture({
    config: sessionConfig(),
    llm,
    logs,
    onSessionFailure: (failure) => told.push(failure),
    prepareDb: (db) => {
      for (let n = 1; n <= 4; n += 1) say(db, { native: `m${n}`, at: NOW - 90 * MINUTE + n, text: `línea ${n}` });
      buffer(db, `guilds/${GUILD}/buffer.json`, ['m1', 'm2', 'm3', 'm4']);
    },
  });
  try {
    await fx.service.tick();
    await fx.service.waitSession();
    const { db } = fx.held.handle;
    assert.equal(meta(db, cursorKey('apply', 'group:discord')), null, 'the lines stay for the next try');
    assert.equal(told.length, 1);
    assert.deepEqual([told[0].scopeKind, told[0].code, told[0].lines], ['group', 'llm_error', 4]);
    assert.equal(fx.service.status().session.lastFailure.code, 'llm_error');
    assert.ok(logs.some((line) => line.level === 'warn' && line.message === 'memory session: run failed' && line.code === 'llm_error'));
    fx.clock.at = NOW + 61 * MINUTE;
    await fx.service.tick();
    await fx.service.waitSession();
    assert.equal(llm.calls.length, 2, 'tried again');
    assert.equal(told.length, 1, 'told once per failing scope');
    assert.deepEqual(fs.readdirSync(fx.dataDir).filter((name) => !name.startsWith('memory.db')), []);
  } finally {
    await fx.service.close();
  }
});

test('the service: the description reviews follow her flags, at most reviewsPerDay', async () => {
  const purposes = [];
  const llm = fakeLlm((messages, options) => {
    purposes.push(options.purpose);
    if (options.purpose === 'memory-session') {
      return memoryBlock({ descriptions: [{ subject: 'Ada', field: 'character', why: 'moved' }, { subject: 'Βασίλης', field: 'character', why: 'new' }] });
    }
    return '<think>t</think><description>Ada, café mornings</description><reason>new lines</reason>';
  });
  const fx = serviceFixture({
    config: sessionConfig({ reviewsPerDay: 1 }),
    llm,
    prepareDb: (db) => {
      say(db, { native: 'm1', at: NOW - 90 * MINUTE, text: 'Καλημέρα' });
      say(db, { native: 'm2', at: NOW - 89 * MINUTE, text: 'ναι', author: BOB });
      say(db, { native: 'm3', at: NOW - 88 * MINUTE, text: 'café ?' });
      buffer(db, `guilds/${GUILD}/buffer.json`, ['m1', 'm2', 'm3']);
    },
  });
  try {
    await fx.service.tick();
    await fx.service.waitSession();
    const { db } = fx.held.handle;
    assert.deepEqual(purposes, ['memory-session', 'description-draft', 'description-check']);
    assert.equal(reviewsToday(db, NOW), 1);
    assert.equal(openFlags(db, fx.hot.config).length, 1, 'the other flag waits for tomorrow');
    fx.clock.at = Date.parse('2026-10-26T09:00:00.000Z');
    await fx.service.tick();
    await fx.service.waitSession();
    assert.deepEqual(purposes.slice(3), ['description-draft', 'description-check']);
    assert.equal(openFlags(db, fx.hot.config).length, 0);
  } finally {
    await fx.service.close();
  }
});

test('openFlags: one per description, the focus close set first, then by the flag age; a review since closes a flag', () => {
  const handle = openMemoryDb(':memory:');
  const { db } = handle;
  try {
    seed(db);
    const flag = (id, at, subjectId, field = 'character') => db.prepare(
      "INSERT INTO decisions (id, at, by, target_kind, target_id, action, reason, extra) VALUES (?, ?, 'her', 'description', NULL, 'flag:description', 'why', ?)",
    ).run(id, at, JSON.stringify({ run: 'r', scope: GROUP, op: { subjectKind: 'person', subjectId, field, why: 'why' } }));
    flag('f1', '2026-10-25T08:00:00.000Z', personId(ADA));
    flag('f2', '2026-10-25T09:00:00.000Z', personId(BOB));
    flag('f3', '2026-10-25T10:00:00.000Z', personId(ADA));
    assert.deepEqual(openFlags(db, {}).map((entry) => [entry.subject.id, entry.at, entry.subject.name]), [[personId(ADA), '2026-10-25T08:00:00.000Z', 'Ada'], [personId(BOB), '2026-10-25T09:00:00.000Z', 'Βασίλης']]);
    db.prepare("INSERT INTO focus_members (person_id, bucket, since, score, policy_version) VALUES (?, 'close', '2026-10-20', 9, 1)").run(personId(BOB));
    assert.deepEqual(openFlags(db, { memoryDb: { focus: { enabled: true } } }).map((entry) => entry.subject.id), [personId(BOB), personId(ADA)]);
    assert.deepEqual(openFlags(db, {}).map((entry) => entry.subject.id), [personId(ADA), personId(BOB)], 'focus off: by age');
    const [ada] = openFlags(db, {});
    // a review at 08:30 answers the flag of 08:00; the flag of 10:00 opens the description again
    db.prepare("INSERT INTO description_versions (id, description_id, text, author, written_at, origin) VALUES ('dv1', ?, 'x', 'her', '2026-10-25T08:30:00.000Z', 'review')").run(ada.key);
    assert.deepEqual(openFlags(db, {}).map((entry) => [entry.subject.id, entry.at]), [[personId(BOB), '2026-10-25T09:00:00.000Z'], [personId(ADA), '2026-10-25T10:00:00.000Z']]);
    // a shadow review answers nothing
    db.prepare("INSERT INTO description_versions (id, description_id, text, author, written_at, origin) VALUES ('dv2', ?, 'x', 'her', '2026-10-25T11:00:00.000Z', 'shadow')").run(ada.key);
    assert.equal(openFlags(db, {}).length, 2);
    db.prepare("INSERT INTO description_versions (id, description_id, text, author, written_at, origin) VALUES ('dv3', ?, 'x', 'her', '2026-10-25T10:30:00.000Z', 'review')").run(ada.key);
    assert.deepEqual(openFlags(db, {}).map((entry) => entry.subject.id), [personId(BOB)]);
    assert.deepEqual(openFlags(db, {}, { skip: new Set([openFlags(db, {})[0].key]) }), []);
  } finally {
    handle.close();
  }
});

// ---------- the handoff ----------

test('handoff: the cursor at the analyzer boundary, the buffered lines read next, idempotent', async () => {
  const handle = openMemoryDb(':memory:');
  const { db } = handle;
  try {
    seed(db);
    const ids = [];
    for (let n = 1; n <= 6; n += 1) ids.push(say(db, { native: `m${n}`, at: NOW - 90 * MINUTE + n * MINUTE, text: `línea número ${n}` }));
    for (let n = 1; n <= 2; n += 1) say(db, { native: `d${n}`, at: NOW - 80 * MINUTE + n * MINUTE, text: `privé ${n}`, scope: ADA_DM, place: dmPlaceId(ADA) });
    buffer(db, `guilds/${GUILD}/buffer.json`, ['m5', 'm6']);
    buffer(db, `guilds/${GUILD}/private/${ADA}/buffer.json`, ['d1', 'd2']);
    const done = handoff(handle, { now: NOW });
    assert.deepEqual([done.already, done.scopes, done.set, done.buffered, done.behind], [false, 2, 1, 4, 0]);
    assert.equal(Number(meta(db, applyCursorKey('group:discord'))), rowidOf(db, ids[3]), 'after m4, the last consumed line');
    assert.equal(meta(db, applyCursorKey('dm:discord:person:discord:u-ada')), null, 'every DM line is buffered: from its first line');
    assert.equal(applyCursorKey('group:discord'), cursorKey('apply', scopesOf(db)[1].key), 'the session reads this very key');
    // idempotent
    say(db, { native: 'm7', at: NOW - 5 * MINUTE, text: 'later' });
    const again = handoff(handle, { now: NOW + MINUTE });
    assert.equal(again.already, true);
    assert.equal(Number(meta(db, applyCursorKey('group:discord'))), rowidOf(db, ids[3]));
    // nothing twice, nothing skipped: her first apply batch is exactly what the analyzer had not consumed
    const llm = fakeLlm(memoryBlock({}));
    const ctx = { db, write: async (update) => applyMemoryWrite(handle, { ...update, authority: 'db' }), llm, hot: { config: sessionConfig({ minMessages: 1 }), prompts }, env: { OPENROUTER_MEMORY_KEY: 'k' }, now: () => NOW, log: {}, selfName: 'Nep' };
    await sweep(ctx, { scope: 'group:discord' });
    const sent = llm.calls[0].messages[1].content;
    for (const n of [1, 2, 3, 4]) assert.ok(!sent.includes(`línea número ${n}`), `m${n} was consumed by the analyzer`);
    for (const n of [5, 6]) assert.ok(sent.includes(`línea número ${n}`), `m${n} waited in its buffer`);
    assert.ok(sent.includes('later'), 'a line after the switch');
    await sweep(ctx, { scope: 'dm:discord:person:discord:u-ada' });
    assert.ok(llm.calls[1].messages[1].content.includes('privé 1') && llm.calls[1].messages[1].content.includes('privé 2'));
    // written only with the database as the writer
    assert.throws(() => applyMemoryWrite(handle, { kind: 'handoff', authority: 'json', now: NOW }), { code: 'HANDOFF_JSON_WRITER' });
  } finally {
    handle.close();
  }
});

test('handoff: a buffered line behind a consumed one is counted, a cursor already there is kept', () => {
  const handle = openMemoryDb(':memory:');
  const { db } = handle;
  try {
    seed(db);
    say(db, { native: 'm1', at: NOW - 60 * MINUTE, text: 'uno' });
    say(db, { native: 'mB', at: NOW - 59 * MINUTE, text: 'buffered' });
    const last = say(db, { native: 'm2', at: NOW - 58 * MINUTE, text: 'dos' });
    say(db, { native: 'd1', at: NOW - 50 * MINUTE, text: 'privé', scope: ADA_DM, place: dmPlaceId(ADA) });
    db.prepare("INSERT INTO meta (key, value) VALUES (?, '1')").run(applyCursorKey('dm:discord:person:discord:u-ada'));
    buffer(db, `guilds/${GUILD}/buffer.json`, ['mB']);
    const done = handoff(handle, { now: NOW });
    assert.deepEqual([done.set, done.kept, done.behind], [1, 1, 1]);
    assert.equal(Number(meta(db, applyCursorKey('group:discord'))), rowidOf(db, last));
    assert.equal(meta(db, applyCursorKey('dm:discord:person:discord:u-ada')), '1');
  } finally {
    handle.close();
  }
});

test('handoff: a private layer\'s buffer counts, and every buffered line without a record unit is written into its layer\'s', () => {
  const handle = openMemoryDb(':memory:');
  const { db } = handle;
  try {
    seed(db);
    const owned = (id, owner, position) => db.prepare('UPDATE sources SET owner_file = ?, position = ? WHERE id = ?').run(owner, position, id);
    const dayUnit = `guilds/${GUILD}/record/2026-10/2026-10-25.jsonl`;
    const dmUnit = `guilds/${GUILD}/private/${ADA}/record/2026-10/2026-10-25.jsonl`;
    // Consumed lines the record holds, then lines the live observation wrote while they waited in the buffers.
    owned(say(db, { native: 'm1', at: NOW - 60 * MINUTE, text: 'uno' }), dayUnit, 0);
    const waiting = say(db, { native: 'm2', at: NOW - 59 * MINUTE, text: 'dos' });
    owned(say(db, { native: 'd1', at: NOW - 50 * MINUTE, text: 'privé un', scope: ADA_DM, place: dmPlaceId(ADA) }), dmUnit, 0);
    const privateWaiting = say(db, { native: 'd2', at: NOW - 49 * MINUTE, text: 'privé deux', scope: ADA_DM, place: dmPlaceId(ADA) });
    db.prepare("INSERT INTO files (path, kind, lines) VALUES (?, 'record', 1), (?, 'record', 1)").run(dayUnit, dmUnit);
    buffer(db, `guilds/${GUILD}/buffer.json`, ['m2']);
    // A private layer keeps its buffer in its own value (the `private` operational row of private/<id>.json).
    db.prepare("INSERT INTO operational (kind, owner, value, owner_file) VALUES ('private', ?, ?, ?)")
      .run(personId(ADA), JSON.stringify({ buffer: [{ id: 'd2', content: 'x' }], $has: [] }), `guilds/${GUILD}/private/${ADA}.json`);
    const done = handoff(handle, { now: NOW });
    assert.deepEqual([done.buffered, done.adopted, done.behind], [2, 2, 0]);
    const unitOf = (id) => db.prepare('SELECT owner_file, position FROM sources WHERE id = ?').get(id);
    assert.deepEqual({ ...unitOf(waiting) }, { owner_file: dayUnit, position: 1 });
    assert.deepEqual({ ...unitOf(privateWaiting) }, { owner_file: dmUnit, position: 1 });
    assert.equal(db.prepare('SELECT lines FROM files WHERE path = ?').get(dmUnit).lines, 2);
    // The private buffered line is not taken for consumed: the DM cursor stays before it.
    const dmCursor = Number(meta(db, applyCursorKey('dm:discord:person:discord:u-ada')));
    assert.ok(dmCursor < rowidOf(db, privateWaiting), 'her session reads the private buffered line');
    // Run once: a second call adopts nothing more.
    assert.equal(handoff(handle, { now: NOW + MINUTE }).already, true);
  } finally {
    handle.close();
  }
});

// ---------- the analyzer's memory path and the extractor off under db ----------

const analyzerHot = () => ({
  config: {
    bot: { timezone: 'UTC' },
    context: { gapMarkerMinutes: 20, maxMessageChars: 800 },
    models: { base: { core: 'x/core', extractor: 'x/extractor' } },
    llm: { temperature: 1, maxOutputTokens: 700, maxRequestTokens: 50000, safetyMargin: 0.9, timeoutMs: 1000, retries: 0, maxRequestsPerDay: 100 },
    memory: { batchMessages: 4, minBatchMessages: 2, maxBatchAgeMinutes: 1, maxOutputTokens: 4000, fieldChars: 400, maxDetails: 15, maxInjokes: 15, maxSelfFacts: 20 },
    features: { memoryTwoStage: true },
    relationships: { textChars: 600 },
  },
  prompts: { memory: 'memory system prompt', 'memory-decide': 'decide system prompt', 'memory-voice': 'voice system prompt', labels },
});

const message = (n, authorId = '1') => ({
  id: `msg${n}`, channelId: 'c1', channelName: 'general', authorId, authorName: authorId === '1' ? 'Zoé' : 'Νίκος', self: false, bot: false,
  content: `bonjour ${n}`, ts: NOW - 30 * MINUTE + n * MINUTE, attachments: [], embeds: [], stickers: [], emojis: [],
});

/** One scripted day of the analyzer's side: lines observed (public and private), an inner episode, ticks, direct calls. */
async function scriptedDay(authority) {
  const dataDir = tempDir('nep-w3-day-');
  const store = createStore({ dataDir });
  const hot = analyzerHot();
  const llm = fakeLlm('{}');
  const updater = createMemoryUpdater({ hot, store, llm, calibrator: createCalibrator(), getSelfName: () => 'Nep', now: () => NOW, authority: () => authority });
  for (let n = 1; n <= 8; n += 1) updater.observe(GUILD, message(n, n % 2 ? '1' : '2'));
  for (let n = 9; n <= 11; n += 1) updater.observe(GUILD, message(n, '2'), { private: '2' });
  updater.observeInner(GUILD, { thinking: 'je pense', actions: [], found: [] });
  await updater.tick();
  await updater.tick();
  if (authority === 'db') {
    await updater.run(GUILD);
    await updater.runPrivate(GUILD, '2');
    await updater.runVoice(GUILD);
    assert.equal((await updater.analyze(GUILD, [message(1)])).reason, 'authority-db');
    assert.equal((await updater.analyzePrivate(GUILD, '2', [message(9, '2')])).reason, 'authority-db');
  }
  const warmup = createWarmup({
    hot, store, client: { guilds: { cache: new Map() } }, discord: { readableChannels: () => [], fetchHistoryWindow: async () => [] }, llm, calibrator: createCalibrator(),
    getSelfName: () => 'Nep', now: () => NOW, sleep: async () => {}, authority: () => authority,
  });
  const refused = authority === 'db' ? {
    portrait: await warmup.refreshPortrait(GUILD, '1', 'due', { force: true }),
    channel: await warmup.refreshChannelNotes(GUILD, 'c1'),
    server: await warmup.refreshServerNotes(GUILD),
    run: await warmup.run(GUILD),
    users: await warmup.runUsers(GUILD),
  } : null;
  return { store, llm, refused };
}

test('under db a scripted day sends no request of the analyzer memory path or the extractor; the counters stay', async () => {
  const day = await scriptedDay('db');
  assert.equal(day.llm.calls.length, 0, 'no batch, no voice run, no warmup family');
  assert.ok(day.llm.calls.every((call) => !retiredAtSwitch(call.options?.role, call.options?.purpose)));
  assert.deepEqual(day.store.getBuffer(GUILD), [], 'no buffer push');
  assert.ok(day.store.getUser(GUILD, '1'), 'touchMemory still counts the member');
  for (const outcome of Object.values(day.refused)) assert.equal(outcome.reason, 'authority-db');
  // the same day under json goes through the analyzer as before
  const json = await scriptedDay('json');
  assert.ok(json.llm.calls.length > 0);
  assert.ok(json.llm.calls.some((call) => call.options?.role === 'extractor'), 'the extractor batch under json');
});

test('the purpose table: every purpose is classified, the gates stay on the analyzer, the memory path goes', () => {
  for (const purpose of Object.keys(PURPOSE_ROLES)) assert.ok(Object.hasOwn(PURPOSE_AT_SWITCH, purpose), purpose);
  for (const gate of ['address', 'route-channel', 'participation-pick', 'gif-pick', 'missed', 'split', 'planner', 'diary-plan', 'speech', 'web-search', 'read-link', 'lookup', 'recall-summary', 'search-summary']) {
    assert.equal(PURPOSE_AT_SWITCH[gate], 'stays', gate);
    assert.equal(PURPOSE_ROLES[gate], 'analyzer', gate);
    assert.equal(retiredAtSwitch('analyzer', gate), false, gate);
  }
  for (const gone of ['memory-voice', 'backfill']) assert.equal(PURPOSE_AT_SWITCH[gone], 'removed');
  assert.equal(retiredAtSwitch('extractor'), true);
  for (const own of ['memory-session', 'description-draft', 'description-check']) assert.equal(PURPOSE_AT_SWITCH[own], 'memory');
});

test('effectiveModels: the memory role on its own key or none, the remaining purposes with theirs', () => {
  const config = {
    models: { base: { memory: 'x/memory', analyzer: 'x/analyzer', core: 'x/core' }, byPurpose: { address: 'x/address' } },
    llm: { keyByRole: { memory: 'OPENROUTER_MEMORY_KEY', analyzer: 'OPENROUTER_HELPER_KEY' } },
  };
  const env = { OPENROUTER_MEMORY_KEY: 'k', OPENROUTER_HELPER_KEY: 'h', OPENROUTER_CORE_KEY: 'main' };
  const list = effectiveModels(config, env);
  const of = (purpose) => list.find((entry) => entry.purpose === purpose);
  assert.deepEqual(of('memory-session'), { purpose: 'memory-session', role: MEMORY_ROLE, model: 'x/memory', key: 'OPENROUTER_MEMORY_KEY' });
  assert.deepEqual([of('description-check').model, of('description-check').key], ['x/memory', 'OPENROUTER_MEMORY_KEY']);
  assert.deepEqual([of('address').model, of('address').key], ['x/address', 'OPENROUTER_HELPER_KEY']);
  assert.deepEqual([of('reply').model, of('reply').key], ['x/core', 'OPENROUTER_CORE_KEY']);
  assert.equal(of('memory-voice'), undefined);
  assert.equal(of('backfill'), undefined);
  // no fallback for the memory role: its key unset is no key at all, never the main one
  const keyless = { OPENROUTER_HELPER_KEY: 'h', OPENROUTER_CORE_KEY: 'main' };
  assert.equal(effectiveModels(config, keyless).find((entry) => entry.purpose === 'memory-session').key, null);
  assert.equal(roleApiKey(config, keyless, MEMORY_ROLE, 'main'), '');
  assert.equal(roleApiKey(config, env, MEMORY_ROLE, 'main'), 'k');
  assert.ok(effectiveModelsLine(list).includes('memory-session=x/memory@OPENROUTER_MEMORY_KEY'));
  assert.ok(!effectiveModelsLine(list).join(' ').includes('main'));
});

// ---------- forget, purge and wipe ----------

test('under db forget, purge and wipe are refused with a code; nothing is touched', async () => {
  const dataDir = tempDir('nep-w3-forget-');
  const dbHandle = openMemoryDb(':memory:');
  try {
    const memoryDb = { authority: () => 'db', readHandle: () => dbHandle, writeUnit: async () => ({}), reader: { value: () => ({ found: false, reason: 'missing' }), ids: () => [] } };
    const store = createStore({ dataDir, memoryDb, memoryRead: memoryDb.reader });
    await assert.rejects(store.forgetUser(GUILD, '123'), { code: FORGET_REFUSED });
    assert.throws(() => store.wipeGuild(GUILD), { code: FORGET_REFUSED });
    assert.throws(() => store.forgetPrivate(GUILD, '123'), { code: FORGET_REFUSED });
    const intentions = createIntentionStore({ dataDir, guildId: GUILD, memoryDb, authorityOf: () => 'db' });
    assert.throws(() => intentions.forgetUser('123'), { code: FORGET_REFUSED });
    assert.throws(() => intentions.wipe(), { code: FORGET_REFUSED });
    const tasks = createTaskStore({ dataDir, guildId: GUILD, memoryDb, authorityOf: () => 'db' });
    assert.throws(() => tasks.forgetUser('123'), { code: FORGET_REFUSED });
    assert.throws(() => tasks.wipe(), { code: FORGET_REFUSED });
    for (const op of ['memory.forget', 'memory.wipe', 'memory.private.forget', 'memory.private.purge']) {
      const result = await runOpPrechecked(op, { userId: '123', confirm: 'Server' }, { env: { memoryDb }, guildId: GUILD });
      assert.deepEqual([result.status, result.code], ['denied', 'refused'], op);
    }
    assert.deepEqual(fs.readdirSync(dataDir), [], 'nothing written');
  } finally {
    dbHandle.close();
  }
});

// ---------- the day against the analyzer ----------

test('compare: her shadow session over one day beside what the analyzer wrote that day', async () => {
  const handle = openMemoryDb(':memory:');
  const { db } = handle;
  try {
    seed(db);
    const DAY = '2026-10-24';
    const at = (hh) => Date.parse(`${DAY}T${hh}:00:00.000Z`);
    say(db, { native: 'y1', at: Date.parse('2026-10-23T22:00:00.000Z'), text: 'yesterday' });
    say(db, { native: 'm1', at: at('09'), text: 'I like café mornings' });
    say(db, { native: 'm2', at: at('10'), text: 'ναι, σωστά', author: BOB });
    say(db, { native: 'm3', at: at('11'), text: 'I moved to Thessaloniki' });
    say(db, { native: 't1', at: Date.parse('2026-10-25T08:00:00.000Z'), text: 'tomorrow' });
    // the analyzer's writes of the day (through the sync): two claims, an episode, an attitude move
    const claim = (id, subject, kind, text) => {
      db.prepare("INSERT INTO claims (id, subject_kind, subject_id, kind, text, how, author, truth, shown, scope_kind, scope_iface, scope_dm) VALUES (?, 'person', ?, ?, ?, 'legacy', 'import', 'current', 1, 'group', 'discord', NULL)").run(id, subject, kind, text);
      db.prepare("INSERT INTO claim_versions (id, claim_id, text, recorded_at, event, by, origin) VALUES (?, ?, ?, ?, 'added', 'analyzer', 'sync')").run(`cv:${id}`, id, text, `${DAY}T12:00:00.000Z`);
    };
    claim('c-a', personId(ADA), 'interest', 'likes café mornings');
    claim('c-b', personId(BOB), 'detail', 'answers in Greek');
    db.prepare("INSERT INTO episodes (id, kind, subject_id, what, scope_kind, scope_iface, scope_dm, created_at) VALUES ('e-a', 'moment', ?, 'Ada told of her move', 'group', 'discord', NULL, ?)").run(personId(ADA), `${DAY}T12:00:00.000Z`);
    db.prepare("INSERT INTO affinity_events (id, person_id, at, delta, reason, scope_kind, scope_iface, scope_dm) VALUES ('a-a', ?, ?, 2, 'kind', 'group', 'discord', NULL)").run(personId(ADA), `${DAY}T12:00:00.000Z`);
    const answer = memoryBlock({
      claims: [
        { op: 'add', subject: 'Ada', kind: 'interest', text: 'café mornings, she likes them', how: 'said', sources: ['#1'] },
        { op: 'add', subject: 'Ada', kind: 'detail', text: 'lives in Thessaloniki now', how: 'said', sources: ['#3'] },
      ],
      affinity: [{ person: 'Ada', delta: 1, reason: 'warm', sources: ['#1'] }],
      descriptions: [{ subject: 'Ada', field: 'character', why: 'moved' }],
    });
    const llm = fakeLlm(answer);
    const usage = { requests: 0, prompt: 0, completion: 0, cost: null };
    const counted = { complete: async (messages, options) => { const done = await llm.complete(messages, options); usage.requests += 1; usage.prompt += done.usage.prompt_tokens; usage.completion += done.usage.completion_tokens; usage.cost = (usage.cost ?? 0) + done.usage.cost; return done; } };
    const hot = { config: sessionConfig({ mode: 'off' }, { authority: 'json' }), prompts };
    const lines = await runCompare({ handle, llm: counted, hot, env: { OPENROUTER_MEMORY_KEY: 'k' }, day: DAY, selfName: 'Nep', usage });
    assert.equal(llm.calls.length, 1, 'one request: the day is one batch');
    const sent = llm.calls[0].messages[1].content;
    assert.ok(sent.includes('I like café mornings') && !sent.includes('yesterday') && !sent.includes('tomorrow'), 'the lines of that day only');
    assert.ok(lines.includes('scope group:discord: hers 3, the analyzer\'s 4; both 2, only hers 1, only the analyzer\'s 2; scope violations 0, unsupported 0, description flags 1'), lines.join('\n'));
    assert.ok(lines.at(-1).startsWith('requests 1, tokens 1000 prompt, 50 completion, cost 0.01 USD'));
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM claims WHERE id NOT IN ('c-a', 'c-b')").get().n, 0, 'shadow: no claim written');
    // --shadow: the proposals the copy holds, no request
    const stored = await runCompare({ handle, llm: null, hot, env: {}, day: DAY, shadowOnly: true });
    assert.ok(stored.includes('scope group:discord: hers 3, the analyzer\'s 4; both 2, only hers 1, only the analyzer\'s 2; scope violations 0, unsupported 0, description flags 1'), stored.join('\n'));
    assert.equal(llm.calls.length, 1);
  } finally {
    handle.close();
  }
});
