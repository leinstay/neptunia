// The media pass keeps its own daily count and its pace (src/memory/db/session.ts#sweep, the quiet branch, and
// src/memory/db/writer-switch.ts#dueScopes): its sweeps count toward `memoryDb.session.mediaPassPerDay`, never toward
// `sweepsPerScopePerDay`, so a scope whose pass used its day still gets its ordinary session, and a pass that finds
// `maxMessages` old lines waits `everyMinutes` like any sweep. Every run here comes from a real sweep with a fake model
// and a fake clock; the told media lines and the ids are synthetic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_SCHEMA } from '../src/config/schema.ts';
import { cursorKey, scopeSweepsToday, scopesOf, sessionSettings, sweep } from '../src/memory/db/session.ts';
import type { SessionContext } from '../src/memory/db/session.ts';
import { applyMemoryWrite } from '../src/memory/db/session-write.ts';
import { dueScopes } from '../src/memory/db/writer-switch.ts';
import type { Config, Log, Row } from '../src/memory/db/types.ts';
import { fillEnvAudiences } from './fixtures/memory-db/audiences.ts';
import { memoryBlock, memoryRing, prompts } from './fixtures/memory-db/session-rig.ts';
import { AT, GENERAL, KINDS, fixture, observeLine } from './fixtures/media-memory.ts';
import type { Env } from './fixtures/media-memory.ts';
import { ROOT } from './fixtures/private-layer.ts';

const MINUTE = 60_000;
const DAY_START = Date.parse('2026-11-05T09:00:00.000Z');
const MODE = 'shadow';

/** The value under `keys` in a parsed JSON tree, or undefined. */
function valueAt(tree: unknown, keys: ReadonlyArray<string>): unknown {
  let at: unknown = tree;
  for (const key of keys) at = at && typeof at === 'object' ? (at as Record<string, unknown>)[key] : undefined;
  return at;
}

type Session = {
  maxMessages?: number;
  everyMinutes?: number;
  sweepsPerScopePerDay?: number;
  mediaPassPerDay?: number;
};

function configOf(session: Session): Config {
  return {
    bot: { timezone: 'UTC' },
    models: { base: { memory: 'x/memory' } },
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

test('a media pass the sweep runs leaves the ordinary sweeps of the day at zero', () =>
  // Catches: scopeSweepsToday counting media-pass runs with the ordinary ones, the production stall of 2026-11-06.
  withQuietScope(3, async (rig) => {
    const config = configOf({});
    await mediaPasses(rig, config, 1);
    assert.equal(rig.calls, 1, 'the quiet scope ran its media pass');
    assert.equal(scopeSweepsToday(rig.env.db, rig.scopeKey, rig.at, MODE), 0);
  }));

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

test('the sweep runs the ordinary batch of a scope whose media pass used its day', () =>
  // Catches: sweep's own cap check refusing the new lines with `capped` because media passes filled the count.
  withQuietScope(4, async (rig) => {
    const config = configOf({ sweepsPerScopePerDay: 2, mediaPassPerDay: 2 });
    await mediaPasses(rig, config, 2);
    rig.at += MINUTE;
    newLines(rig, 1, 'fresh');
    const result = await sweepAt(rig, config);
    assert.equal(result.status, 'ok');
    assert.deepEqual(
      result.runs.map((run) => run.outcome),
      ['ok']
    );
    assert.equal(rig.calls, 3);
  }));

test('the media pass stops at mediaPassPerDay while old lines are left', () =>
  // Catches: the quiet branch still comparing with sweepsPerScopePerDay, so the pass runs on all day.
  withQuietScope(4, async (rig) => {
    const config = configOf({ sweepsPerScopePerDay: 24, mediaPassPerDay: 1 });
    await mediaPasses(rig, config, 2);
    assert.equal(rig.calls, 1, 'the second pass of the day did not run');
    assert.deepEqual(dueKeys(rig, config), []);
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
  // Catches: the silent skip of 2026-11-06, and a line every minute once the scope is capped.
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

test('mediaPassPerDay falls back to the value of config.json, which the schema names', () => {
  // Catches: a code fallback that drifts from the shipped config, or a setting missing from the schema and its document.
  const shipped: unknown = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'config.json'), 'utf8'));
  const shippedValue = valueAt(shipped, ['memoryDb', 'session', 'mediaPassPerDay']);
  assert.ok(Number.isInteger(shippedValue) && Number(shippedValue) > 0, 'config.json ships a whole number of passes');
  assert.equal(sessionSettings({}).mediaPassPerDay, shippedValue);
  assert.equal(sessionSettings({ memoryDb: { session: { mediaPassPerDay: -1 } } }).mediaPassPerDay, shippedValue);
  const entry = CONFIG_SCHEMA.find((one) => one.key === 'memoryDb.session.mediaPassPerDay');
  assert.ok(entry, 'the schema names the key');
  assert.equal(entry.default, shippedValue);
});
