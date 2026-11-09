// The memory writer made cheaper (item 0.3 of the final plan): small sessions wait and join the next one of their scope,
// the request puts its stable part first under the cache marker, and a run records the sessions it joined and the
// cache tokens the provider read. A scripted model and a fake clock; nothing leaves the process.
import type { KeyRing } from '../src/keys/ring.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSessionRequest,
  batchOf,
  cursorKey,
  joinOf,
  scopesOf,
  sessionSettings,
  sweep,
} from '../src/memory/db/session.ts';
import { dueScopes } from '../src/memory/db/writer-switch.ts';
import { fillEnvAudiences } from './fixtures/memory-db/audiences.ts';
import { withCacheMarker } from '../src/llm/openrouter.ts';
import { MEMORY_ROLE } from '../src/llm/roles.ts';
import {
  ADA,
  BOB,
  HOUR,
  MINUTE,
  NOW,
  baseConfig,
  ctxOf,
  dmPlaceOf,
  fixture,
  memoryBlock,
  personOf,
  prompts,
  textOf,
} from './fixtures/memory-db/session-rig.ts';
import type { Fixture, LlmCall, Rec, SayArgs } from './fixtures/memory-db/session-shapes.ts';

const SETTINGS = { minLines: 10, batchLines: 30, maxWaitHours: 24 };
const cfg = (over: Rec = {}): Rec => baseConfig({ ...SETTINGS, ...over });

/** `n` lines a minute apart from `startMin` minutes after NOW, by Ada and Bob in turn (the group scope unless `scope`). */
function lines(env: Fixture, n: number, startMin: number, tag: string, extra: Partial<SayArgs> = {}): void {
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

type Usage = { prompt_tokens: number; completion_tokens: number; prompt_tokens_details?: { cached_tokens: number } };
/** A scripted model: an empty memory answer to every call, the given usage, the calls recorded. */
function scripted(usage: Usage = { prompt_tokens: 1000, completion_tokens: 50 }) {
  const calls: Array<LlmCall> = [];
  return {
    calls,
    complete(messages: LlmCall['messages'], options: LlmCall['options']) {
      calls.push({ messages, options });
      return Promise.resolve({ text: memoryBlock({}), usage });
    },
  };
}

/** A context whose clock stands at `minutes` after NOW. */
const ctxAt = (
  env: Fixture,
  minutes: number,
  llm: ReturnType<typeof scripted>,
  config: Rec = cfg(),
  ring?: KeyRing | null
) => ({
  ...ctxOf(env, { llm, config, ...(ring === undefined ? {} : { ring }) }),
  now: () => NOW + minutes * MINUTE,
});
const runs = (env: Fixture) => env.db.prepare('SELECT * FROM session_runs ORDER BY started_at').all();
const countsOf = (row: Rec): Rec => JSON.parse(row.counts as string) as Rec;
const cursorOf = (env: Fixture): unknown =>
  env.db.prepare('SELECT value FROM meta WHERE key = ?').get(cursorKey('shadow', 'group:discord'))?.value ?? null;

// ---------- the join rule ----------

test('settings: no waiting, batchLines 30, maxWaitHours 24 by default; a wrong value falls back to the default', () => {
  // minLines defaults to 0 on the owner's word of 2026-11-02: a short session is written at once, never held a day.
  const given = sessionSettings({});
  assert.deepEqual([given.minLines, given.batchLines, given.maxWaitHours], [0, 30, 24]);
  const bad = sessionSettings({ memoryDb: { session: { minLines: -3, batchLines: 'x', maxWaitHours: 0 } } });
  assert.deepEqual([bad.minLines, bad.batchLines, bad.maxWaitHours], [0, 30, 24]);
  assert.equal(sessionSettings({ memoryDb: { session: { minLines: 0 } } }).minLines, 0, '0 switches waiting off');
});

test('a settled session of ten lines waits: no request, no run row, the cursor stays', async () => {
  // Catches: a tiny session sent at the full price of the stable part (47 runs, 1.37M tokens for 35 facts).
  const env = fixture();
  try {
    lines(env, 10, 0, 'a');
    const llm = scripted();
    const result = await sweep(ctxAt(env, 30, llm));
    assert.deepEqual(
      result.runs.map((r) => [r.outcome, r.lines]),
      [['waiting', 10]]
    );
    assert.equal(llm.calls.length, 0);
    assert.equal(runs(env).length, 0);
    assert.equal(cursorOf(env), null);
  } finally {
    env.done();
  }
});

test('a session of eleven lines is written as before, joining nothing', async () => {
  // Catches: a wait rule that holds back a session over minLines.
  const env = fixture();
  try {
    lines(env, 11, 0, 'a');
    const llm = scripted();
    await sweep(ctxAt(env, 30, llm));
    assert.equal(llm.calls.length, 1);
    const [row] = runs(env);
    assert.equal(row.sources_n, 11);
    assert.equal(countsOf(row).sessions, 1);
  } finally {
    env.done();
  }
});

test('small sessions of one scope join: ten, ten and ten lines go out as one request that records three sessions', async () => {
  // Catches: waiting sessions written separately (no saving), or lost when the next one comes.
  const env = fixture();
  try {
    lines(env, 10, 0, 'a');
    const llm = scripted();
    await sweep(ctxAt(env, 30, llm));
    lines(env, 10, 60, 'b');
    await sweep(ctxAt(env, 100, llm));
    assert.equal(llm.calls.length, 0, 'twenty lines in two small sessions still wait');
    lines(env, 10, 120, 'c');
    await sweep(ctxAt(env, 200, llm));
    assert.equal(llm.calls.length, 1);
    const text = textOf(llm.calls[0].messages[1].content);
    for (const tag of ['a0 ', 'a9 ', 'b0 ', 'c9 '])
      assert.ok(text.includes(`${tag.trim()} line`), `the joined request holds ${tag}`);
    const [row] = runs(env);
    assert.equal(row.sources_n, 30);
    assert.equal(countsOf(row).sessions, 3);
    assert.match(String(cursorOf(env)), /^\d+$/, 'the cursor moved past every joined line');
  } finally {
    env.done();
  }
});

test('twenty-nine joined lines still wait; the thirtieth sends them', async () => {
  // Catches: an off-by-one at batchLines.
  const env = fixture();
  try {
    lines(env, 10, 0, 'a');
    lines(env, 10, 60, 'b');
    lines(env, 9, 120, 'c');
    const llm = scripted();
    await sweep(ctxAt(env, 200, llm));
    assert.equal(llm.calls.length, 0);
    lines(env, 1, 130, 'd');
    await sweep(ctxAt(env, 200, llm));
    assert.equal(llm.calls.length, 1);
  } finally {
    env.done();
  }
});

test('a waiting session and a later one over ten lines go out together', async () => {
  // Catches: the waiting lines left behind when a large session arrives.
  const env = fixture();
  try {
    lines(env, 5, 0, 'a');
    const llm = scripted();
    await sweep(ctxAt(env, 30, llm));
    lines(env, 12, 60, 'b');
    await sweep(ctxAt(env, 120, llm));
    assert.equal(llm.calls.length, 1);
    assert.ok(textOf(llm.calls[0].messages[1].content).includes('a0 line'));
    const [row] = runs(env);
    assert.equal(row.sources_n, 17);
    assert.equal(countsOf(row).sessions, 2);
  } finally {
    env.done();
  }
});

test('two small sessions whose sum passes ten do not count as a large one', async () => {
  // Catches: the rule comparing the joined total with minLines instead of each session.
  const env = fixture();
  try {
    lines(env, 8, 0, 'a');
    lines(env, 8, 60, 'b');
    const llm = scripted();
    await sweep(ctxAt(env, 120, llm));
    assert.equal(llm.calls.length, 0);
  } finally {
    env.done();
  }
});

test('the day ends: a waiting session is written when its oldest line is maxWaitHours old, and not a minute before', async () => {
  // Catches: lines that wait for ever in a quiet scope (a loss); a deadline counted from the wrong end.
  const env = fixture();
  try {
    lines(env, 4, 0, 'a'); // the oldest line is at NOW + 0
    const llm = scripted();
    const before = await sweep(ctxAt(env, 24 * 60 - 1, llm));
    assert.equal(llm.calls.length, 0);
    assert.equal(before.runs[0].outcome, 'waiting');
    await sweep(ctxAt(env, 24 * 60, llm));
    assert.equal(llm.calls.length, 1);
    assert.equal(runs(env)[0].sources_n, 4);
    const again = await sweep(ctxAt(env, 24 * 60 + 5, llm));
    assert.equal(llm.calls.length, 1, 'the written lines are not read twice');
    assert.equal(again.runs[0].outcome, 'quiet');
  } finally {
    env.done();
  }
});

test('maxWaitHours is read from the live config', async () => {
  // Catches: the wait fixed at a constant.
  const env = fixture();
  try {
    lines(env, 4, 0, 'a');
    const llm = scripted();
    await sweep(ctxAt(env, 60, llm, cfg({ maxWaitHours: 2 })));
    assert.equal(llm.calls.length, 0, 'an hour into a two-hour wait');
    await sweep(ctxAt(env, 3 * 60, llm, cfg({ maxWaitHours: 2 })));
    assert.equal(llm.calls.length, 1);
  } finally {
    env.done();
  }
});

test('a private chat waits and joins on its own, never with the group', async () => {
  // Catches: a small private session joined into the group request (a leak across scopes), or the group held back by it.
  const env = fixture();
  try {
    env.storeDmPlace(ADA); // Changed with ids-by-links slice 3: no writer makes the DM place from her person id.
    const dm = { scope_kind: 'dm', scope_iface: 'discord', scope_dm: personOf(ADA) };
    lines(env, 12, 0, 'g');
    lines(env, 4, 0, 'p', { scope: dm, place: dmPlaceOf(ADA) });
    const llm = scripted();
    const result = await sweep(ctxAt(env, 60, llm));
    assert.deepEqual(
      result.runs.map((r) => [r.scope, r.outcome]),
      [
        ['dm:discord:person:discord:u-ada', 'waiting'],
        ['group:discord', 'ok'],
      ]
    );
    assert.equal(llm.calls.length, 1);
    assert.ok(
      !textOf(llm.calls[0].messages[1].content).includes('p0 line'),
      'the private lines are not in the group request'
    );
  } finally {
    env.done();
  }
});

test('minLines 0 writes every session as before', async () => {
  // Catches: no way to switch the waiting off.
  const env = fixture();
  try {
    lines(env, 2, 0, 'a');
    const llm = scripted();
    await sweep(ctxAt(env, 30, llm, cfg({ minLines: 0 })));
    assert.equal(llm.calls.length, 1);
  } finally {
    env.done();
  }
});

test('joinOf counts sessions by the settle gap and answers wait, large, batch, deadline', () => {
  // Catches: the pure rule drifting from the sweep: the gap that splits sessions, the order of the reasons.
  const settings = sessionSettings({ memoryDb: { session: SETTINGS } });
  const at = (minutes: number): never => ({ at: NOW + minutes * MINUTE, rowid: minutes }) as never;
  const small = [at(0), at(1), at(2), at(20), at(21)]; // a 9-minute gap would not split; 18 does
  assert.deepEqual(joinOf(small, settings, NOW + HOUR), { write: false, sessions: 2, reason: 'wait' });
  assert.equal(joinOf([at(0), at(9)], settings, NOW + HOUR).sessions, 1, 'a gap under settleMinutes joins');
  assert.equal(joinOf([], settings, NOW).sessions, 0);
  const large = Array.from({ length: 11 }, (_, i) => at(i));
  assert.equal(joinOf(large, settings, NOW + HOUR).reason, 'large');
  const many = Array.from({ length: 30 }, (_, i) => at(i * 30));
  assert.equal(joinOf(many, settings, NOW + 30 * HOUR).reason, 'batch');
  assert.equal(joinOf([at(0)], settings, NOW + 24 * HOUR).reason, 'deadline');
  assert.equal(joinOf([at(0)], { ...settings, minLines: 0 }, NOW + HOUR).reason, 'off');
});

test('the schedule does not wake a scope that would only wait, and wakes it at the deadline', () => {
  // Catches: the service's due list and the sweep disagreeing, so a scope shows as due and nothing runs.
  const env = fixture();
  try {
    lines(env, 8, 0, 'a');
    fillEnvAudiences(env);
    const config = cfg();
    assert.deepEqual(dueScopes(env.db, config as never, NOW + HOUR), []);
    assert.deepEqual(
      dueScopes(env.db, config as never, NOW + 25 * HOUR).map((s) => s.key),
      ['group:discord']
    );
    lines(env, 12, 70, 'b');
    fillEnvAudiences(env);
    assert.deepEqual(
      dueScopes(env.db, config as never, NOW + 3 * HOUR).map((s) => s.key),
      ['group:discord']
    );
  } finally {
    env.done();
  }
});

// ---------- the request layout ----------

function build(env: Fixture, now: number, config: Rec = cfg()) {
  const scope = scopesOf(env.db)[0];
  const batch = batchOf(env.db, scope.scope, {
    cursor: 0,
    since: null,
    maxMessages: 200,
    settleBefore: now - 10 * MINUTE,
  });
  return buildSessionRequest({ db: env.db, scope, batch, config, prompts, selfName: 'Nep', now });
}
type Part = { type: string; text: string; cacheSegment?: string; cache_control?: unknown };
const partsOf = (content: unknown): Array<Part> => {
  assert.ok(Array.isArray(content), 'the user content is a list of text parts');
  return content as Array<Part>;
};

test('the stable blocks come first under the cache marker, the batch lines last and unmarked', () => {
  // Catches: the lines inside the cached prefix (never read twice) or the memory outside it (sent uncached each run).
  const env = fixture();
  try {
    lines(env, 6, 0, 'a');
    env.claim({ id: 'cl-ada', subjectId: personOf(ADA), kind: 'interest', text: 'likes café mornings' });
    const built = build(env, NOW + HOUR);
    assert.match(built.messages[0].content, /^SYSTEM Nep\n\nCARD Nep/, 'the system text stays a string');
    const parts = partsOf(built.messages[1].content);
    assert.equal(parts.length, 2);
    assert.equal(parts[0].cacheSegment, 'stable');
    assert.equal(parts[1].cacheSegment, undefined);
    assert.ok(parts[0].text.includes('<place>'));
    assert.ok(parts[0].text.includes('<people>') && parts[0].text.includes('likes café mornings'));
    assert.ok(!parts[0].text.includes('<batch>') && !parts[0].text.includes('a0 line'));
    assert.ok(parts[1].text.startsWith('<batch>') && parts[1].text.includes('a5 line'));
    assert.ok(!parts[1].text.includes('<people>'));
    const sent = withCacheMarker(built.messages as never, '1h') as unknown as Array<{ content: Array<Part> | string }>;
    const sentParts = sent[1].content as Array<Part>;
    assert.ok(sentParts[0].cache_control, 'the stable part carries the marker');
    assert.equal(sentParts[1].cache_control, undefined, 'the lines carry none');
    assert.equal(sentParts[0].cacheSegment, undefined, 'the neutral tag never reaches the provider');
    assert.ok(Array.isArray(sent[0].content) && sent[0].content.at(-1)!.cache_control, 'the system text is marked too');
  } finally {
    env.done();
  }
});

test('the stable part is byte-identical between two runs of a scope while nothing in it changed, and moves when a claim does', () => {
  // Catches: a clock, a counter or a line in the prefix (the cache never hits), and a cached prefix that outlives a changed memory.
  const env = fixture();
  try {
    lines(env, 6, 0, 'a');
    env.claim({
      id: 'cl-self',
      subjectKind: 'self',
      subjectId: 'self',
      kind: 'self_fact',
      text: 'keeps a small garden',
    });
    const first = partsOf(build(env, NOW + 2 * HOUR).messages[1].content)[0].text;
    lines(env, 6, 90, 'b');
    const second = partsOf(build(env, NOW + 5 * HOUR).messages[1].content);
    assert.equal(second[0].text, first);
    assert.ok(second[1].text.includes('b5 line'), 'the new lines are in the batch part');
    env.db.prepare("UPDATE claims SET text = 'keeps a large garden' WHERE id = 'cl-self'").run();
    const changed = partsOf(build(env, NOW + 6 * HOUR).messages[1].content)[0].text;
    assert.notEqual(changed, first);
    assert.ok(changed.includes('large garden'));
  } finally {
    env.done();
  }
});

// ---------- the model and the record ----------

test('the run goes to models.base.memory with the memory role and a forced cache marker, never to the core model', async () => {
  // Catches: the writer sent to another model or role, or without the cache request.
  const env = fixture();
  try {
    lines(env, 11, 0, 'a');
    const llm = scripted();
    const config = { ...cfg(), models: { base: { memory: 'x/the-writer', core: 'x/the-core' } } };
    await sweep(ctxAt(env, 60, llm, config));
    assert.equal(llm.calls.length, 1);
    const options = llm.calls[0].options as Rec;
    assert.equal(options.model, 'x/the-writer');
    assert.equal(options.role, MEMORY_ROLE);
    assert.equal(options.cache, true);
    assert.equal(runs(env)[0].model, 'x/the-writer');
    assert.ok(!JSON.stringify(llm.calls[0]).includes('x/the-core'));
  } finally {
    env.done();
  }
});

test('without a key ring no request is made', async () => {
  // Catches: the writer sending a request with no key behind it. A core key in `.env` stood here: the session reads its
  // key from the key ring alone, so the case is a missing ring.
  const env = fixture();
  try {
    lines(env, 11, 0, 'a');
    const llm = scripted();
    const result = await sweep(ctxAt(env, 60, llm, cfg(), null));
    assert.equal(result.status, 'refused');
    assert.equal(llm.calls.length, 0);
  } finally {
    env.done();
  }
});

test('a run records the cache tokens the provider read, and zero when it reported none', async () => {
  // Catches: the saving unmeasurable.
  const env = fixture();
  try {
    lines(env, 11, 0, 'a');
    const llm = scripted({
      prompt_tokens: 3000,
      completion_tokens: 40,
      prompt_tokens_details: { cached_tokens: 2400 },
    });
    await sweep(ctxAt(env, 60, llm));
    const [row] = runs(env);
    assert.equal(countsOf(row).cacheRead, 2400);
    assert.equal(row.tokens_prompt, 3000);
  } finally {
    env.done();
  }
  const bare = fixture();
  try {
    lines(bare, 11, 0, 'a');
    await sweep(ctxAt(bare, 60, scripted()));
    assert.equal(countsOf(runs(bare)[0]).cacheRead, 0);
  } finally {
    bare.done();
  }
});
