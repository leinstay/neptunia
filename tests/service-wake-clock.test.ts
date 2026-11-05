// `wakeClockOf` (src/service/commands.ts), the core's reading of a persona wake for `/services <name> status`: the running
// inner life and the running diary as src/core.ts hands them over, answered through the console as the owner reads it.
// The inner life and the diary are the real ones over a fake turn runner and an injected clock, so the state the clock
// reads is the state they write. The tests assert on the `key: value` lines of the answer, never on wording.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createInnerLife } from '../src/behavior/inner.ts';
import { createDiary } from '../src/behavior/diary.ts';
import { createEventDoor } from '../src/interface/door.ts';
import { createConsole } from '../src/interface/commands/console.ts';
import { parseCommandLine } from '../src/interface/commands/table.ts';
import { createIntentionService } from '../src/intentions/service.ts';
import { createIntentionStores } from '../src/intentions/store.ts';
import { wakeClockOf } from '../src/service/commands.ts';
import type { WakeClock } from '../src/service/commands.ts';
import type { ServiceName } from '../src/service/schedule.ts';
import { openTestMemorySync } from './fixtures/memory-db/service.ts';
import { tempDir } from './fixtures/tmp.ts';
import { useIface, world } from './fixtures/turn-world.ts';

useIface('fake');

const GUILD = 'g1';
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const SILENT = { info() {}, warn() {}, error() {}, debug() {} };
const iso = (ms: number): string => new Date(ms).toISOString();
const at = (text: string): number => Date.parse(text);

const OPENED: Array<{ close(): unknown }> = [];
after(async () => {
  for (const memory of OPENED.splice(0)) await memory.close();
});

/** What `/services <name> status` answers in a core whose wakes `wakeClock` reads. */
async function statusOf(
  name: ServiceName,
  config: unknown,
  now: number,
  wakeClock: (name: ServiceName) => WakeClock | null
): Promise<Map<string, string>> {
  const dir = tempDir('nep-clock-console-');
  const desk = createConsole({
    runOp: () => Promise.resolve({ status: 'ok', code: '', summary: 'done', data: null }),
    ownerReads: { lessons: () => '', aliases: () => '' },
    guildId: () => GUILD,
    selfId: () => 'self-1',
    hot: { config },
    privateDir: dir,
    dataDir: dir,
    memoryDb: null,
    usage: null,
    metrics: null,
    conversationLines: () => [],
    now: () => now,
    wakeClock,
  });
  const parsed = parseCommandLine(`/services ${name} status`);
  assert.ok(parsed.ok, parsed.ok ? '' : parsed.reason);
  const answer = await desk.run(parsed.name, parsed.args, { id: 'owner-1' });
  assert.equal(answer.status, 'ok', answer.text);
  return new Map(
    answer.text.split('\n').flatMap((line): Array<[string, string]> => {
      const found = /^([a-z ]+): (.*)$/.exec(line);
      return found === null ? [] : [[found[1] ?? '', found[2] ?? '']];
    })
  );
}

/** A real inner life over `sections`, whose turn runner waits for `release` when `held`. */
function lifeWith(sections: Record<string, unknown>, start: number) {
  const clock = { t: start };
  world().channel({ id: 'c1', name: 'chan-c1', guildId: GUILD, permissions: { send: true } });
  const hot = {
    config: {
      bot: { timezone: 'UTC' },
      features: { wakes: true, intentions: true, journal: true },
      mention: { oneAtATime: true },
      wakes: { mode: 'shadow', tickSeconds: 60, review: { enabled: false, historyDays: 14 }, caps: { perChain: 3 } },
      heartbeat: { enabled: false },
      selfimprovement: { enabled: false },
      ...sections,
    },
  };
  const service = createIntentionService({
    stores: createIntentionStores({ dataDir: tempDir('nep-clock-'), now: () => clock.t, log: SILENT }),
    hot,
    getGuildId: () => GUILD,
    now: () => clock.t,
    log: SILENT,
  });
  const gate = { held: false, entered: 0, release: () => {} };
  const turns = {
    isAnyBusy: () => false,
    runTurn: async () => {
      gate.entered += 1;
      if (gate.held) await new Promise<void>((resolve) => (gate.release = resolve));
      return { outcome: 'skip', reason: 'nothing-to-do', inner: { actions: [], turnId: `t-${gate.entered}` } };
    },
  };
  let life: ReturnType<typeof createInnerLife> | null = null;
  const door = createEventDoor({ handlers: { 'inner.wake': (event: object) => life?.onWake(event) }, log: SILENT });
  life = createInnerLife({
    hot,
    dataDir: tempDir('nep-clock-inner-'),
    turns,
    intentions: service,
    journal: { inner: () => Promise.resolve(), read: () => [] },
    reads: world().reads,
    iface: () => 'fake',
    conversationName: (id: string) => `chan-${id}`,
    submit: (event: object) => door.submit(event),
    store: { state: { data: {} } },
    getGuildId: () => GUILD,
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
  return { clock, life, gate, hot };
}

/** A real diary whose every post speaks, on the schedule of `selfreflection`. */
function diaryWith(schedule: string, start: number) {
  const clock = { t: start };
  const memory = openTestMemorySync({ now: () => start });
  OPENED.push(memory);
  const hot = {
    config: { bot: { timezone: 'UTC' }, selfreflection: { enabled: true, schedule, quietDayChance: 0 } },
    prompts: { labels: {} },
  };
  const store = {
    state: { data: {}, markDirty() {} },
    getDiary: () => ({ posts: [], updatedAt: 0 }),
    readMemory: (read: (db: unknown) => unknown) => read(memory.memoryDb.readHandle()?.db),
  };
  const diary = createDiary({
    hot,
    // @ts-expect-error: the stand-in store holds only the part of DiaryStore that the tick reads
    store,
    reads: world().reads,
    iface: () => 'fake',
    turns: {
      runTurn: () =>
        Promise.resolve({ outcome: 'spoke', diary: { kind: 'status', picture: false, search: false, messages: 1 } }),
    },
    getGuildId: () => GUILD,
    rng: () => 0.5,
    now: () => clock.t,
  });
  return { clock, diary, hot };
}

test('a heartbeat that has drawn its moment shows that moment as next due, none as last and no run', async () => {
  // Catches: the clock reads another field of the state, so status shows the schedule's time, not the drawn one.
  const start = at('2026-11-04T05:00:00Z');
  const run = lifeWith({ heartbeat: { schedule: 'every 4h', jitterMinutes: 0 } }, start);
  await run.life.tick();
  const read = (name: ServiceName) =>
    wakeClockOf(name, {
      guildId: GUILD,
      now: start,
      inner: run.life,
      diary: { status: () => ({ slots: [], done: [] }) },
    });
  const fields = await statusOf('heartbeat', run.hot.config, start, read);
  assert.equal(fields.get('next due'), iso(start + 4 * HOUR));
  assert.equal(fields.get('last result'), 'none');
  assert.equal(fields.get('running'), 'false');
});

test('a selfimprovement turn in flight shows as running for its own name alone, and its end moves the last result', async () => {
  // Catches: `inflight` is matched by another key than the turn's kind, so a running wake always reads as idle, or any
  // running turn reads as every mechanic's.
  const start = at('2026-11-04T14:00:00Z');
  const run = lifeWith(
    { selfimprovement: { enabled: true, schedule: 'at 15:00', failuresPerShape: 3 }, heartbeat: { enabled: false } },
    start
  );
  await run.life.tick();
  const due = at('2026-11-04T15:00:00Z');
  run.clock.t = due;
  run.gate.held = true;
  const ticking = run.life.tick();
  for (let i = 0; i < 200 && run.gate.entered === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(run.gate.entered, 1, 'the turn started');
  const read = (name: ServiceName) =>
    wakeClockOf(name, {
      guildId: GUILD,
      now: due,
      inner: run.life,
      diary: { status: () => ({ slots: [], done: [] }) },
    });
  assert.equal(read('selfimprovement')?.running, true);
  assert.equal(read('heartbeat')?.running, false);
  run.gate.release();
  await ticking;
  await run.life.tick();
  const finished = read('selfimprovement');
  assert.equal(finished?.running, false);
  assert.ok((finished?.lastAt ?? 0) >= start, 'the committed wake moved the clock');
  const fields = await statusOf('selfimprovement', run.hot.config, due, read);
  assert.equal(fields.get('running'), 'false');
  assert.equal(fields.get('last result'), iso(finished?.lastAt ?? 0));
});

test('with no community known yet a wake reads unknown, apart from its saved flag', async () => {
  // Catches: a core before its first hello throws on `inner.state(null)`, so status fails in the window it is most read.
  const inner = {
    state: () => assert.fail('no community, nothing to read'),
  };
  const read = (name: ServiceName) =>
    wakeClockOf(name, { guildId: null, now: 0, inner, diary: { status: () => ({ slots: [], done: [] }) } });
  const fields = await statusOf('heartbeat', { heartbeat: { enabled: true, schedule: 'every 4h' } }, 0, read);
  assert.equal(fields.get('enabled'), 'true');
  assert.equal(fields.get('running'), 'unknown');
  assert.equal(fields.get('last result'), 'unknown');
});

test('a diary between its slots names the next slot not yet done and the slot that ran', async () => {
  // Catches: the next slot is the first of the plan, so status promises a post that already went out.
  const run = diaryWith('at 09:00,10:00', at('2026-11-04T08:00:00Z'));
  await run.diary.tick();
  run.clock.t = at('2026-11-04T09:05:00Z');
  await run.diary.tick();
  const now = run.clock.t;
  const read = (name: ServiceName) =>
    wakeClockOf(name, { guildId: GUILD, now, inner: lifeWith({}, now).life, diary: run.diary });
  const fields = await statusOf('selfreflection', run.hot.config, now, read);
  assert.equal(fields.get('next due'), iso(at('2026-11-04T10:00:00Z')));
  assert.equal(fields.get('last result'), iso(at('2026-11-04T09:00:00Z')));
});

test('a diary past its last slot of the day names the first slot of tomorrow', async () => {
  // Catches: an empty remainder of the plan reads as no next time for an enabled service.
  const run = diaryWith('at 09:00', at('2026-11-04T08:00:00Z'));
  await run.diary.tick();
  run.clock.t = at('2026-11-04T09:05:00Z');
  await run.diary.tick();
  const now = run.clock.t;
  const read = (name: ServiceName) =>
    wakeClockOf(name, { guildId: GUILD, now, inner: lifeWith({}, now).life, diary: run.diary });
  const fields = await statusOf('selfreflection', run.hot.config, now, read);
  assert.equal(fields.get('next due'), iso(at('2026-11-05T09:00:00Z')));
});

test('a diary slot dropped past its grace is no last result: only a slot that ran is', async () => {
  // Catches: the dropped slot joins `done`, so status reports a post at a time when nothing was written.
  const run = diaryWith('at 09:00,10:00', at('2026-11-04T08:00:00Z'));
  await run.diary.tick();
  run.clock.t = at('2026-11-04T09:05:00Z');
  await run.diary.tick();
  run.clock.t = at('2026-11-04T15:00:00Z');
  await run.diary.tick();
  const now = run.clock.t;
  const read = (name: ServiceName) =>
    wakeClockOf(name, { guildId: GUILD, now, inner: lifeWith({}, now).life, diary: run.diary });
  const fields = await statusOf('selfreflection', run.hot.config, now, read);
  assert.equal(fields.get('last result'), iso(at('2026-11-04T09:00:00Z')));
});

test("a diary's last result survives midnight", async () => {
  // Catches: the clock reads only today's plan, so every new day reads "none" for a diary that posted last night.
  const run = diaryWith('at 22:00', at('2026-11-04T21:00:00Z'));
  await run.diary.tick();
  run.clock.t = at('2026-11-04T22:05:00Z');
  await run.diary.tick();
  run.clock.t = at('2026-11-05T01:00:00Z');
  await run.diary.tick();
  const now = run.clock.t;
  const read = (name: ServiceName) =>
    wakeClockOf(name, { guildId: GUILD, now, inner: lifeWith({}, now).life, diary: run.diary });
  const fields = await statusOf('selfreflection', run.hot.config, now, read);
  assert.equal(fields.get('last result'), iso(at('2026-11-04T22:00:00Z')));
});
