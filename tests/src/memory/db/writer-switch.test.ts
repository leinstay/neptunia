// The memory writer's switch (src/memory/db/writer-switch.ts): the open description flags and the context a flag's
// review reads in, and `dueScopes`, the list of scopes the scheduled sweep takes. Synthetic ids, a fake model and a
// fake clock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDb } from '../../../../src/memory/db/open.ts';
import { dueScopes, openFlags } from '../../../../src/memory/db/writer-switch.ts';
import { canRead } from '../../../../src/memory/db/scope.ts';
import { cursorKey, scopesOf, sweep } from '../../../../src/memory/db/session.ts';
import type { SessionContext } from '../../../../src/memory/db/session.ts';
import { applyMemoryWrite } from '../../../../src/memory/db/session-write.ts';
import type { Config, Db, Log, Row } from '../../../../src/memory/db/types.ts';
import { sqlOf, wrongly } from '../../../fixtures/loose-types.ts';
import { fillEnvAudiences } from '../../../fixtures/memory-db/audiences.ts';
import { memoryBlock, memoryRing, prompts } from '../../../fixtures/memory-db/session-rig.ts';
import { ADA, BOB, NOW, baseConfig, fixture as sessionFixture } from '../../../fixtures/memory-db/session-rig.ts';
import type { Fixture, Rec, SayArgs } from '../../../fixtures/memory-db/session-shapes.ts';
import { AT, GENERAL, KINDS, fixture, observeLine } from '../../../fixtures/media-memory.ts';
import type { Env } from '../../../fixtures/media-memory.ts';
import { chainsOf } from '../../../fixtures/chains.ts';
import { ctxOf as ownTimeCtxOf, fakeLlm } from '../../../fixtures/memory-db/session-rig.ts';
import { effectiveModels } from '../../../../src/memory/db/writer-switch.ts';

const PLACE = 'discord:dm:n1';
const AUDIENCE = `aud:dm:${PLACE}`;
const META = 'person:0b6f2c1e-0000-4000-8000-000000000001';

/** A DM session run whose partner is a meta-person, and the flag it raised on one field of `subject`. */
function flagged(subject: { kind: string; id: string }, field: string) {
  const handle = openMemoryDb(':memory:');
  const db = sqlOf(handle);
  db.prepare("INSERT INTO places (id, kind, iface, partner_account) VALUES (?, 'dm', 'discord', 'discord:n1')").run(
    PLACE
  );
  db.prepare("INSERT INTO audiences (id, kind, iface, place_id) VALUES (?, 'dm', 'discord', ?)").run(AUDIENCE, PLACE);
  db.prepare(
    `INSERT INTO session_runs (id, sweep_id, scope_key, scope_kind, scope_iface, scope_dm, mode, started_at, outcome, audience_id)
     VALUES ('run:r1', 'sweep:s1', ?, 'dm', 'discord', ?, 'apply', '2026-11-08T10:00:00.000Z', 'ok', ?)`
  ).run(`dm:discord:${PLACE}`, META, AUDIENCE);
  const scope = { scope_kind: 'dm', scope_iface: 'discord', scope_dm: META };
  db.prepare(
    `INSERT INTO decisions (id, at, by, target_kind, target_id, action, reason, extra)
     VALUES ('dec:run:r1:0', '2026-11-08T10:00:01.000Z', 'her', 'description', 'desc:x', 'flag:description', 'never written', ?)`
  ).run(
    JSON.stringify({
      run: 'run:r1',
      scope,
      op: { subjectKind: subject.kind, subjectId: subject.id, field, why: 'never written' },
    })
  );
  return wrongly<Db>(handle.db);
}

test('reads a direct chat flag in its own chat when the partner is a meta-person', () => {
  const db = flagged({ kind: 'place', id: PLACE }, 'purpose');
  const [flag] = openFlags(db, {});
  assert.ok(flag);
  assert.equal(canRead({ audience_id: AUDIENCE }, flag.readCtx), true);
});

test('keeps another direct chat out of a flag raised in one direct chat', () => {
  const db = flagged({ kind: 'person', id: META }, 'relationship');
  const [flag] = openFlags(db, {});
  assert.ok(flag);
  assert.equal(canRead({ audience_id: 'aud:dm:discord:dm:n2' }, flag.readCtx), false);
});

// ---------- a quiet scope with old media-only lines ----------

// The scheduled sweep takes only the scopes `dueScopes` returns, and the media pass runs in `sweep`'s quiet branch, so
// a scope with fewer lines than `minMessages` must still be listed while the pass has lines left. Synthetic rows.
const HOUR = 3600 * 1000;

function withDueScope(body: (env: ReturnType<typeof fixture>, key: string, cursorKeyOf: string) => void) {
  const env = fixture();
  try {
    observeLine(env, KINDS[0], 'part', { native: 'told-1', at: AT });
    env.say({ native: 'words', at: AT + 1000, text: 'words of its own', place: GENERAL });
    fillEnvAudiences(env);
    const scope = scopesOf(env.db).find((one) => one.scope.scope_kind === 'group');
    assert.ok(scope);
    // The ordinary cursor is past every line: the told image line was passed because it held no words.
    const last = Number(env.db.prepare('SELECT MAX(rowid) AS r FROM sources').get()?.r);
    const key = cursorKey('apply', scope.key);
    env.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(key, String(last));
    body(env, scope.key, key);
  } finally {
    env.done();
  }
}

test('lists a quiet scope while the media pass has old lines left and the pass is on', () =>
  withDueScope((env, scopeKey) => {
    const config = { memoryDb: { session: { mode: 'apply', mediaPass: true } } };
    const due = dueScopes(env.db, config, AT + 24 * HOUR);
    assert.deepEqual(
      due.map((one) => one.key),
      [scopeKey]
    );
  }));

test('lists nothing for a quiet scope when the media pass is off', () =>
  withDueScope((env) => {
    const config = { memoryDb: { session: { mode: 'apply' } } };
    assert.deepEqual(dueScopes(env.db, config, AT + 24 * HOUR), []);
  }));

// ---------- the daily count and the pace of the media pass ----------

// The media pass keeps its own daily count and its pace: its sweeps count toward `memoryDb.session.mediaPassPerDay`,
// never toward `sweepsPerScopePerDay`, and a pass that finds `maxMessages` old lines waits `everyMinutes` like any
// sweep. Every run here comes from a real sweep with a fake model and a fake clock; the told media lines and the ids
// are synthetic.
const MINUTE = 60_000;
const DAY_START = Date.parse('2026-11-05T09:00:00.000Z');
const MODE = 'shadow';

type Session = {
  maxMessages?: number;
  everyMinutes?: number;
  sweepsPerScopePerDay?: number;
  mediaPassPerDay?: number;
};

function configOf(session: Session): Config {
  return {
    bot: { timezone: 'UTC' },
    models: { routes: chainsOf({ memory: 'x/memory' }) },
    memoryDb: {
      session: {
        mode: MODE,
        minMessages: 1,
        minLines: 0,
        maxMessages: 1,
        everyMinutes: 0,
        sweepsPerScopePerDay: 24,
        mediaPassPerDay: 24,
        mediaPass: true,
        ...session,
      },
    },
  };
}

/** The database, the scope, a clock the test moves and the count of model calls. */
type Rig = { env: Env; scopeKey: string; at: number; calls: number };

/** A sweep's context whose model answers an empty memory to every call and counts the calls. */
function ctxOf(rig: Rig, config: Config): SessionContext {
  return {
    db: rig.env.db,
    write: (update: Row) => new Promise((resolve) => resolve(applyMemoryWrite(rig.env.handle, update))),
    llm: {
      complete() {
        rig.calls += 1;
        return Promise.resolve({ text: memoryBlock({}), usage: { prompt_tokens: 100, completion_tokens: 10 } });
      },
    },
    hot: { config, prompts },
    env: {},
    ring: memoryRing(),
    now: () => rig.at,
    log: {},
    selfName: 'Nep',
  };
}

/**
 * The group scope with `told` old image lines and one line of words, its ordinary cursor past them all: the scope is
 * quiet, and the media pass has the told lines left to read.
 */
function withQuietScope(told: number, body: (rig: Rig) => Promise<void>): Promise<void> {
  const env = fixture();
  for (let i = 0; i < told; i += 1) observeLine(env, KINDS[0], 'part', { native: `told-${i}`, at: AT + i * 1000 });
  env.say({ native: 'words', at: AT + told * 1000, text: 'words of its own', place: GENERAL });
  fillEnvAudiences(env);
  const scope = scopesOf(env.db).find((one) => one.scope.scope_kind === 'group');
  assert.ok(scope);
  const last = Number(env.db.prepare('SELECT MAX(rowid) AS r FROM sources').get()?.r);
  env.db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(cursorKey(MODE, scope.key), String(last));
  const rig: Rig = { env, scopeKey: scope.key, at: DAY_START, calls: 0 };
  return body(rig).finally(() => env.done());
}

/** `n` new lines of words in the scope, settled half an hour before the clock. */
function newLines(rig: Rig, n: number, tag: string): void {
  for (let i = 0; i < n; i += 1) {
    rig.env.say({
      native: `${tag}-${i}`,
      at: rig.at - 30 * MINUTE + i * 1000,
      text: `${tag} line ${i}`,
      place: GENERAL,
    });
  }
  fillEnvAudiences(rig.env);
}

/** One sweep of the scope at the clock's time. */
const sweepAt = (rig: Rig, config: Config) => sweep(ctxOf(rig, config), { scopes: new Set([rig.scopeKey]) });

/** `n` sweeps of the quiet scope a minute apart: each one is a media pass. */
async function mediaPasses(rig: Rig, config: Config, n: number): Promise<void> {
  for (let i = 0; i < n; i += 1) {
    rig.at += MINUTE;
    await sweepAt(rig, config);
  }
}

const dueKeys = (rig: Rig, config: Config): Array<string> =>
  dueScopes(rig.env.db, config, rig.at).map((one) => one.key);

test('dueScopes lists the scope for its new lines after the media pass used its day', () =>
  // Catches: the schedule skipping a scope at the ordinary cap that only media passes filled.
  withQuietScope(4, async (rig) => {
    const config = configOf({ sweepsPerScopePerDay: 2, mediaPassPerDay: 2 });
    await mediaPasses(rig, config, 2);
    assert.equal(rig.calls, 2);
    rig.at += MINUTE;
    newLines(rig, 1, 'fresh');
    assert.deepEqual(dueKeys(rig, config), [rig.scopeKey]);
  }));

test('the media pass comes back on the next day', () =>
  // Catches: a media count that never resets, or one read over more than the day of the clock.
  withQuietScope(4, async (rig) => {
    const config = configOf({ mediaPassPerDay: 1 });
    await mediaPasses(rig, config, 1);
    rig.at = DAY_START + 24 * 60 * MINUTE;
    assert.deepEqual(dueKeys(rig, config), [rig.scopeKey]);
  }));

test('a media pass that finds maxMessages old lines waits everyMinutes after the last sweep', () =>
  // Catches: a full media pass skipping the wait, so it runs about once a minute until a cap stops it.
  withQuietScope(4, async (rig) => {
    const config = configOf({ maxMessages: 1, everyMinutes: 60 });
    await mediaPasses(rig, config, 1);
    rig.at += 5 * MINUTE;
    assert.deepEqual(dueKeys(rig, config), [], 'five minutes after the pass');
    rig.at += 60 * MINUTE;
    assert.deepEqual(dueKeys(rig, config), [rig.scopeKey], 'an hour after the pass');
  }));

test('a media pass waits everyMinutes after an ordinary sweep of the scope', () =>
  // Catches: the wait reading only the media pass's own runs, so the pass follows an ordinary sweep at once.
  withQuietScope(4, async (rig) => {
    const config = configOf({ maxMessages: 1, everyMinutes: 60 });
    newLines(rig, 1, 'fresh');
    await sweepAt(rig, config);
    assert.equal(rig.calls, 1, 'the ordinary batch ran');
    rig.at += 5 * MINUTE;
    assert.deepEqual(dueKeys(rig, config), []);
  }));

test('ordinary new lines that fill maxMessages are full and skip the wait', () =>
  // Catches: the fix taking `full` away from ordinary lines too, so a busy scope waits an hour per batch.
  withQuietScope(1, async (rig) => {
    const config = configOf({ maxMessages: 2, everyMinutes: 60 });
    newLines(rig, 2, 'first');
    await sweepAt(rig, config);
    rig.at += 5 * MINUTE;
    newLines(rig, 2, 'second');
    const due = dueScopes(rig.env.db, config, rig.at);
    assert.deepEqual(
      due.map((one) => [one.key, one.full]),
      [[rig.scopeKey, true]]
    );
  }));

// ---------- a capped scope is said once, and the setting ----------

type Line = { message: string; fields: Row | undefined };

/** A log that keeps every line of every level. */
function journal(): { log: Log; capped: () => Array<Line> } {
  const lines: Array<Line> = [];
  const keep = (message: string, fields?: Row) => {
    lines.push({ message, fields });
  };
  return {
    log: { info: keep, warn: keep, error: keep, debug: keep },
    capped: () => lines.filter((line) => line.message === 'memory session: capped'),
  };
}

const cappedFields = (line: Line) => [line.fields?.scope, line.fields?.cap, line.fields?.count];

test('a scope at its ordinary cap is left out and logged capped once for the day', () =>
  // Catches: a silent skip, and a line every minute once the scope is capped.
  withQuietScope(1, async (rig) => {
    const config = configOf({ sweepsPerScopePerDay: 1 });
    newLines(rig, 1, 'first');
    await sweepAt(rig, config);
    rig.at += MINUTE;
    newLines(rig, 1, 'second');
    const { log, capped } = journal();
    const options = { log };
    assert.deepEqual(dueScopes(rig.env.db, config, rig.at, options), []);
    rig.at += MINUTE;
    assert.deepEqual(dueScopes(rig.env.db, config, rig.at, options), []);
    assert.deepEqual(capped().map(cappedFields), [[rig.scopeKey, 'sweepsPerScopePerDay', 1]]);
  }));

test('a scope capped again on the next day is logged again', () =>
  // Catches: a once-ever memory of the capped line, which hides every later day's stall.
  withQuietScope(1, async (rig) => {
    const config = configOf({ sweepsPerScopePerDay: 1 });
    const { log, capped } = journal();
    const options = { log };
    for (const day of [0, 1]) {
      rig.at = DAY_START + day * 24 * 60 * MINUTE;
      newLines(rig, 1, `first-${day}`);
      await sweepAt(rig, config);
      rig.at += MINUTE;
      newLines(rig, 1, `second-${day}`);
      dueScopes(rig.env.db, config, rig.at, options);
    }
    assert.equal(capped().length, 2);
  }));

test('a quiet scope at mediaPassPerDay is logged capped under the media cap', () =>
  // Catches: the media cap skipping the scope with no line, or naming the ordinary cap.
  withQuietScope(4, async (rig) => {
    const config = configOf({ mediaPassPerDay: 1 });
    await mediaPasses(rig, config, 1);
    rig.at += MINUTE;
    const { log, capped } = journal();
    assert.deepEqual(dueScopes(rig.env.db, config, rig.at, { log }), []);
    assert.deepEqual(capped().map(cappedFields), [[rig.scopeKey, 'mediaPassPerDay', 1]]);
  }));

// ---------- the join rule ----------

// Small sessions wait and join the next one of their scope; the schedule wakes a scope only when its sweep would write.
const SETTINGS = { minLines: 10, batchLines: 30, maxWaitHours: 24 };
const cfg = (over: Rec = {}): Rec => baseConfig({ ...SETTINGS, ...over });

/** `n` lines a minute apart from `startMin` minutes after NOW, by Ada and Bob in turn (the group scope unless `scope`). */
function joinLines(env: Fixture, n: number, startMin: number, tag: string, extra: Partial<SayArgs> = {}): void {
  for (let i = 0; i < n; i += 1) {
    env.say({
      native: `${tag}${i}`,
      minutesAgo: -(startMin + i),
      text: `${tag}${i} line about café`,
      author: i % 2 === 0 ? ADA : BOB,
      ...extra,
    });
  }
}

test('the schedule does not wake a scope that would only wait, and wakes it at the deadline', () => {
  // Catches: the service's due list and the sweep disagreeing, so a scope shows as due and nothing runs.
  const env = sessionFixture();
  try {
    joinLines(env, 8, 0, 'a');
    fillEnvAudiences(env);
    const config = cfg();
    assert.deepEqual(dueScopes(env.db, config as never, NOW + HOUR), []);
    assert.deepEqual(
      dueScopes(env.db, config as never, NOW + 25 * HOUR).map((s) => s.key),
      ['group:discord']
    );
    joinLines(env, 12, 70, 'b');
    fillEnvAudiences(env);
    assert.deepEqual(
      dueScopes(env.db, config as never, NOW + 3 * HOUR).map((s) => s.key),
      ['group:discord']
    );
  } finally {
    env.done();
  }
});

// The memory session of the persona's own time (src/memory/db/session.ts, scope `own:<iface>`): their heartbeat turns
// read as a batch under the interface's group context, what they keep written under the group audience. A fake llm and made-up
// rows only; nothing leaves the process.

const OWN = 'own:discord';
const config = baseConfig({ mode: 'apply' });

function heartbeat(db: Db, id: string, { think = 'a quiet hour', query = 'ήλιος', found = 'sunny pages' } = {}): void {
  const at = '2026-10-24T10:00:00.000Z';
  db.prepare(
    "INSERT INTO wake_runs (id, kind, started_at, finished_at, status, outcome) VALUES (?, 'heartbeat', ?, ?, 'succeeded', 'skip')"
  ).run(id, at, at);
  const calls = [
    { id: 'c1', name: 'web_search', arguments: JSON.stringify({ query }), parsed: { query }, parseError: null },
    { id: 'c2', name: 'conversation_read', arguments: '{"chat":"#cdm"}', parsed: { chat: '#cdm' }, parseError: null },
  ];
  const insert = db.prepare(
    `INSERT INTO model_requests (id, schema_version, turn_id, attempt_id, step, role, status, started_at, messages, think, tool_calls)
     VALUES (?, 1, ?, 'a1', ?, 'core', 'ok', ?, ?, ?, ?)`
  );
  insert.run(
    `${id}:0`,
    id,
    0,
    at,
    JSON.stringify([{ role: 'user', content: 'HEARTBEAT INPUT' }]),
    think,
    JSON.stringify(calls)
  );
  const next = [
    { role: 'user', content: 'HEARTBEAT INPUT' },
    {
      role: 'assistant',
      content: null,
      tool_calls: calls.map((call) => ({
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: call.arguments },
      })),
    },
    { role: 'tool', tool_call_id: 'c1', content: `Call succeeded: ${found}` },
    { role: 'tool', tool_call_id: 'c2', content: 'Call succeeded: a private line' },
  ];
  insert.run(`${id}:1`, id, 1, at, JSON.stringify(next), 'done looking', null);
}

test('the scope of the persona’s own time is due while a finished heartbeat run waits after its cursor', async () => {
  const env = sessionFixture();
  try {
    ownTimeCtxOf(env);
    assert.deepEqual(dueScopes(env.db, config, NOW, { iface: 'discord' }), []);
    heartbeat(env.db, 'turn:1');
    assert.deepEqual(dueScopes(env.db, config, NOW, { iface: 'discord' }), [{ key: OWN, lines: 1, full: false }]);
    await sweep(ownTimeCtxOf(env, { llm: fakeLlm(memoryBlock({})), config }), { scopes: new Set([OWN]) });
    assert.deepEqual(dueScopes(env.db, config, NOW, { iface: 'discord' }), []);
  } finally {
    env.handle.close();
  }
});

// Tests for the purposes the analyzer answers (src/llm/roles.ts#PURPOSE_ROLES, as
// src/memory/db/writer-switch.ts#effectiveModels resolves each purpose to its role and model): a purpose no request sends
// (`room`, `rewatch`) resolves to no role, and the two search purposes (`search-summary`, `quick-search`) resolve to the
// analyzer they go out on. That every purpose a request sends keeps its role is checked over
// the call sites in tests/src/llm/roles.test.ts.

const CONFIG = { models: { routes: chainsOf({ analyzer: 'x/analyzer', core: 'x/core' }) } };

/** The role each purpose resolves to, as the effective-models list gives it. */
function rolesByPurpose(): Map<string, Array<string>> {
  const roles = new Map<string, Array<string>>();
  for (const { purpose, role } of effectiveModels(CONFIG, null))
    roles.set(purpose, [...(roles.get(purpose) ?? []), role]);
  return roles;
}

test('the search purposes resolve to the analyzer', () => {
  // Quick search condenses and searches on the analyzer, so its purposes are listed there.
  // Bug: a search summary is listed on no model and key, or on another role's, while it goes out on the analyzer.
  const roles = rolesByPurpose();
  for (const purpose of ['search-summary', 'quick-search']) {
    assert.deepEqual(roles.get(purpose), ['analyzer'], purpose);
  }
});
