// Tests for the places of the inner life (src/behavior/inner/places.ts): the wake an attention makes from the settled
// lines of its place, and the page of the places list.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attendWake, placesPage, refreshPlaces } from '../../../../src/behavior/inner/places.ts';
import { HOUR_MS, MINUTE_MS, DAY_MS } from '../../../../src/time.ts';
import { NOW, SILENT, clock, fakeClient, fakeTurns, hotWith, seeded } from '../../../fixtures/inner-rig.ts';
import { present, wrongly } from '../../../fixtures/loose-types.ts';
import { innerSettings } from '../../../../src/behavior/inner/settings.ts';
import type { InnerContext } from '../../../../src/behavior/inner/types.ts';
import { createInnerLife } from '../../../../src/behavior/inner.ts';
import { createEventDoor } from '../../../../src/interface/door.ts';
import { createIntentionStores } from '../../../../src/intentions/store.ts';
import { createIntentionService } from '../../../../src/intentions/service.ts';
import { tempDir } from '../../../fixtures/tmp.ts';
import { useIface } from '../../../fixtures/turn-world.ts';
import type { Untyped } from '../../../../src/tools/types.ts';

test("attendWake: lines of others since the persona's last look, settled, make one wake named by the newest line; the persona's own lines and other people never count", () => {
  const record = { id: 'ia', attend: { place: 'c2', people: [], settle: 60, perDay: 12, today: null } };
  const lines = [
    { id: 'm1', at: NOW - 3 * MINUTE_MS, by: 'u1' },
    { id: 'm2', at: NOW - 2 * MINUTE_MS, by: 'u2' },
    { id: 'm3', at: NOW - 90_000, by: null, said: true },
  ];
  const wake = attendWake(record, lines, { now: NOW, since: NOW - HOUR_MS });
  assert.equal(present(wake).id, 'inner.wake:attend:ia:m2', "the newest line that counts, not the persona's own");
  assert.deepEqual(
    [present(wake).kind, present(wake).placeId, present(wake).chainId, present(wake).dueAt, present(wake).intentionIds],
    ['attend', 'c2', 'attend:ia:m2', NOW - 2 * MINUTE_MS + 60_000, ['ia']]
  );
  assert.deepEqual(present(wake).attend, {
    place: 'c2',
    lines: 2,
    people: ['u1', 'u2'],
    since: NOW - HOUR_MS,
    newestAt: NOW - 2 * MINUTE_MS,
    newestId: 'm2',
  });
  assert.equal(
    attendWake(record, lines, { now: NOW - 100_000 }),
    null,
    'the newest line is younger than the settle: the place is still talking'
  );
  assert.equal(attendWake(record, [lines[2]], { now: NOW }), null, "the persona's own line alone wakes nobody");
  assert.equal(attendWake(record, [], { now: NOW }), null);
  const only = { ...record, attend: { ...record.attend, people: ['u2'] } };
  assert.deepEqual(present(present(attendWake(only, lines, { now: NOW })).attend).people, ['u2']);
  assert.equal(
    attendWake(only, [lines[0]], { now: NOW }),
    null,
    'a line by someone else does not count for a people attention'
  );
  assert.equal(
    present(
      attendWake({ ...record, attend: { ...record.attend, settle: 0 } }, [{ id: 'm9', at: NOW, by: 'u1' }], {
        now: NOW,
      })
    ).id,
    'inner.wake:attend:ia:m9',
    'settle 0 wakes at once'
  );
});

test('placesPage: filtered by name, sorted recent, name or lines, paged with the total and how many more', () => {
  const rows = [
    { id: 'a', name: 'alpha', lines: 3, people: 2, newestAt: NOW - HOUR_MS },
    { id: 'b', name: 'bêta', lines: 9, people: 4, newestAt: NOW },
    { id: 'c', name: 'gamma', lines: 0, people: 0, newestAt: null },
    { id: 'd', name: 'alps', lines: 1, people: 1, newestAt: NOW - 2 * HOUR_MS },
  ];
  assert.deepEqual(
    placesPage(rows).items.map((r) => r.id),
    ['b', 'a', 'd', 'c'],
    'recent: the newest first, a silent place last'
  );
  assert.deepEqual(
    placesPage(rows, { sort: 'name' }).items.map((r) => r.id),
    ['a', 'd', 'b', 'c']
  );
  assert.deepEqual(
    placesPage(rows, { sort: 'lines' }).items.map((r) => r.id),
    ['b', 'a', 'd', 'c']
  );
  assert.deepEqual(
    placesPage(rows, { filter: 'ALP' }).items.map((r) => r.id),
    ['a', 'd']
  );
  assert.deepEqual(
    placesPage(rows, { filter: 'beta' }).items.map((r) => r.id),
    ['b'],
    'accents folded'
  );
  const first = placesPage(rows, { pageSize: 3 });
  assert.deepEqual([first.total, first.page, first.pageSize, first.more, first.items.length], [4, 1, 3, 1, 3]);
  const second = placesPage(rows, { pageSize: 3, page: 2 });
  assert.deepEqual([second.more, second.items.map((r) => r.id)], [0, ['c']]);
  assert.deepEqual(placesPage(rows, { pageSize: 3, page: 9 }).items, []);
});

const T0 = Date.parse('2026-11-12T01:00:00Z');

const MINUTE = 60_000;

const iso = (ms: number): string => new Date(ms).toISOString();

function line(kind: 'said' | 'seen', revision: number, at: number, by: string | undefined) {
  return {
    kind,
    messageId: 'm1',
    revision,
    occurredAt: iso(at),
    scope: { channel: 'c1' },
    by,
    text: 'the kettle is on',
  };
}

// When the scan meets both rows of an edited line of the persona, the index holds the line once, as the persona's, at
// the moment it was written. The edit's row, which names the persona's account and a later moment, adds nothing.
test("the place index holds the persona's edited line once, as theirs, at the moment it was said", async () => {
  const lines = [line('said', 1, T0, undefined), line('seen', 2, T0 + 93 * MINUTE, 'cli:self')];
  const life = {
    placeIndexes: new Map(),
    record: { iterate: () => lines },
    log: { warn() {} },
  } as unknown as InnerContext;
  const index = await refreshPlaces(life, T0 + 120 * MINUTE, innerSettings({}));
  assert.deepEqual(index.places.get('c1')?.lines, [{ id: 'm1', at: T0, by: null, said: true }]);
});

useIface('fake');

const settle = () => new Promise((resolve) => setImmediate(resolve));

test.beforeEach(() => void (clock.t = NOW));

// ---- recurring intentions ------------------------------------------------------------

/** The production intention service over the inner life's temp data directory. */
function realIntentions(hot: Record<string, Untyped>, dataDir: string) {
  hot.config.intentions = {
    expiresDays: 14,
    recurringExpiresDays: 30,
    maxOpen: 20,
  };
  return createIntentionService({
    stores: createIntentionStores({ dataDir, now: () => clock.t, log: SILENT }),
    hot,
    now: () => clock.t,
    log: SILENT,
  });
}

// ---- the persona's attention --------------------------------------------------------------------

/** A fake record over `lines` (`{ kind, messageId, occurredAt, by, scope }`): iterate filters by `from`. */
function fakeRecord(lines: Array<Record<string, Untyped>>) {
  return {
    lines,
    async *iterate({ from }: { from?: string | null } = {}) {
      const since = from ? Date.parse(from) : -Infinity;
      for (const line of lines) if (Date.parse(String(line.occurredAt)) >= since) yield line;
    },
  };
}

/** One observed line of `by` in `channel` at `at` (the persona's own when `said`). */
function seen(
  id: string,
  {
    channel = 'c2',
    by = 'u1',
    at = NOW - 5 * MINUTE_MS,
    said = false,
  }: { channel?: string; by?: string; at?: number; said?: boolean } = {}
) {
  return {
    kind: said ? 'said' : 'seen',
    messageId: id,
    occurredAt: new Date(at).toISOString(),
    ...(said ? {} : { by }),
    scope: { channel },
  };
}

/** An inner life over the real service with an attention on `place`, the clock at NOW. */
function attentionSetup({
  place = 'c2',
  people = [],
  settle = 60,
  perDay = 12,
  lines = [],
  turns = fakeTurns(),
  wakes = {},
  places = null,
  nameOf = null,
  canSend = () => true,
}: {
  place?: string;
  people?: Array<Untyped>;
  settle?: number;
  perDay?: number;
  lines?: Array<Untyped>;
  turns?: ReturnType<typeof fakeTurns>;
  wakes?: Record<string, Untyped>;
  places?: Untyped;
  nameOf?: Untyped;
  canSend?: Untyped;
} = {}) {
  const dataDir = tempDir('nep-inner-');
  const hot = hotWith({ wakes });
  const service = realIntentions(hot, dataDir);
  const record = fakeRecord(lines);
  const journal: Array<Record<string, Untyped>> = [];
  let inner: ReturnType<typeof createInnerLife>;
  const door = createEventDoor({ handlers: { 'inner.wake': (event) => inner.onWake(event) }, log: SILENT });
  inner = createInnerLife({
    hot,
    dataDir,
    turns,
    intentions: service,
    record,
    places,
    nameOf,
    journal: { inner: async (fields) => journal.push(fields) },
    reads: fakeClient(undefined, canSend).reads,
    iface: () => 'fake',
    submit: (event) => door.submit(event),
    store: { state: { data: {} } },
    meter: { run: async (fn) => ({ result: await fn(), usd: 0.1, requests: 1, voice: 1 }) },
    rng: seeded(3),
    now: () => clock.t,
    log: SILENT,
  });
  // Set an hour ago: lines before an attention was set are never new to it.
  clock.t = NOW - HOUR_MS;
  const set = service.set({
    purpose: 'listen there',
    attend: { place, people, settle, perDay },
    placeId: 'c1',
    scope: 'group',
  });
  clock.t = NOW;
  assert.equal(set.ok, true, wrongly(set.code));
  return { inner, turns, journal, service, record, id: set.intention.id, hot };
}

test(`inner: an attention wakes the persona on the place's settled lines since their last look, with the whole burst; the places page counts them; nothing elsewhere; the same lines never twice`, async () => {
  const lines = [
    seen('m1', { by: 'u1', at: NOW - 4 * MINUTE_MS }),
    seen('m2', { by: 'u2', at: NOW - 3 * MINUTE_MS }),
    seen('m3', { channel: 'c3', by: 'u3', at: NOW - 3 * MINUTE_MS }),
  ];
  // The places page is the inner life's page (the persona's places.list), read here inside the attend turn, before
  // the look is handled.
  const seenPage: { page: ReturnType<typeof run.inner.places> | null } = { page: null };
  const turns = fakeTurns({
    answer: () => {
      seenPage.page = run.inner.places();
      return { outcome: 'skip', reason: 'nothing-to-do', inner: { actions: [], turnId: 't-1' } };
    },
  });
  const run = attentionSetup({
    lines,
    turns,
    nameOf: (id: string) =>
      new Map([
        ['u1', 'Ana'],
        ['u2', 'Nikos'],
      ]).get(id) ?? null,
    places: () => [
      { id: 'c1', name: 'general', writable: true },
      { id: 'c2', name: 'garden', writable: true },
      { id: 'c3', name: 'news', writable: false },
    ],
  });
  const first = await run.inner.tick();
  assert.equal(first.submitted, 1, 'the attended place only');
  const calls = run.turns.calls;
  assert.equal(calls.length, 1);
  const inner2 = calls[0].inner;
  const wake = inner2.wake;
  const calls2 = run.turns.calls;
  assert.equal(present(calls2[0].chat).chatId, 'c2');
  assert.equal(wake.kind, 'attend');
  assert.equal(wake.chainId, `attend:${run.id}:m2`);
  const item = wake.items[0];
  const attend = present(item.attend);
  assert.deepEqual(
    [item.kind, item.intentionIds, attend.place, attend.placeName, attend.lines, attend.people, attend.peopleNames],
    ['attend', [run.id], 'c2', 'garden', 2, ['u1', 'u2'], ['Ana', 'Nikos']]
  );
  assert.equal(
    attend.since,
    present(present(run.service.store()).get(run.id)).createdAt,
    'nothing before the attention was set is new'
  );
  assert.deepEqual(
    wake.intentions.map((r: Record<string, Untyped>) => r.id),
    [run.id]
  );
  // The places page: every published place, the lines since the persona's last look, the read-only one listed.
  const page = present(seenPage.page);
  assert.equal(page.total, 3);
  assert.deepEqual(
    page.items.map((p: Record<string, Untyped>) => [p.id, p.lines, p.people, p.writable, p.attended]),
    [
      ['c2', 2, 2, true, true],
      ['c3', 1, 1, false, false],
      ['c1', 0, 0, true, false],
    ]
  );
  assert.equal(present(run.journal.find((r) => r.event === 'wake')).wake.id, `inner.wake:attend:${run.id}:m2`);
  assert.deepEqual(present(run.journal.find((r) => r.event === 'wake')).wake.place, 'c2');
  assert.deepEqual(run.service.attendToday(run.id), { day: '2026-10-19', wakes: 1 });
  // The same lines wake the persona no more: the look is the handled wake.
  clock.t = NOW + 5 * MINUTE_MS;
  const second = await run.inner.tick();
  assert.equal(second.submitted, 0);
  const calls3 = run.turns.calls;
  assert.equal(calls3.length, 1);
  assert.deepEqual(
    present(run.inner.places().items.find((p) => p.id === 'c2')).lines,
    0,
    "the page counts from the persona's last look"
  );
  // A new line after the look, settled: a new wake named by it.
  const lines2 = run.record.lines;
  lines2.push(seen('m4', { by: 'u1', at: NOW + 6 * MINUTE_MS }));
  clock.t = NOW + 6 * MINUTE_MS + 30_000;
  await run.inner.tick();
  const calls4 = run.turns.calls;
  assert.equal(calls4.length, 1, 'still talking: the settle has not passed');
  clock.t = NOW + 8 * MINUTE_MS;
  await run.inner.tick();
  const calls5 = run.turns.calls;
  assert.equal(calls5.length, 2);
  const inner3 = calls5[1].inner;
  const items = inner3.wake.items;
  assert.equal(present(items[0].attend).lines, 1);
  assert.deepEqual(run.service.attendToday(run.id), { day: '2026-10-19', wakes: 2 });
  const turnNote = run.journal.filter((r) => r.event === 'turn').at(-1);
  assert.deepEqual(
    [present(turnNote).wakes[0].kind, present(turnNote).wakes[0].place, present(turnNote).wakes[0].lines],
    ['attend', 'c2', 1]
  );
});

test(`inner: the persona's own line in the place is a look; a newer burst replaces the queued wake, nothing lost; with people only their lines count`, async () => {
  const turns = fakeTurns();
  turns.busy = true;
  const lines = [
    seen('m1', { by: 'u1', at: NOW - 10 * MINUTE_MS }),
    seen('m2', { at: NOW - 8 * MINUTE_MS, said: true }),
    seen('m3', { by: 'u2', at: NOW - 4 * MINUTE_MS }),
  ];
  const run = attentionSetup({ lines, turns, people: ['u2', 'u3'] });
  await run.inner.tick();
  let queue = run.inner.state().queue;
  assert.deepEqual(
    queue.map((w: Record<string, Untyped>) => [w.id, w.attend.lines]),
    [[`inner.wake:attend:${run.id}:m3`, 1]],
    "only u2's line after the persona's own line counts"
  );
  // More lines while the attention is held: the queued wake takes the newest line's id.
  const lines2 = run.record.lines;
  lines2.push(seen('m4', { by: 'u1', at: NOW + MINUTE_MS }), seen('m5', { by: 'u3', at: NOW + 2 * MINUTE_MS }));
  clock.t = NOW + 4 * MINUTE_MS;
  await run.inner.tick();
  queue = run.inner.state().queue;
  assert.deepEqual(
    queue.map((w: Record<string, Untyped>) => [w.id, w.attend.lines, w.attend.people]),
    [[`inner.wake:attend:${run.id}:m5`, 2, ['u2', 'u3']]],
    'one queued wake per attention'
  );
  assert.deepEqual(
    run.journal.filter((r) => r.event === 'replaced').map((r) => [r.wake.id, r.by]),
    [[`inner.wake:attend:${run.id}:m3`, `inner.wake:attend:${run.id}:m5`]]
  );
  turns.busy = false;
  await run.inner.tick();
  const calls = run.turns.calls;
  assert.equal(calls.length, 1);
  const inner = calls[0].inner;
  const items = inner.wake.items;
  assert.equal(present(items[0].attend).lines, 2);
  assert.equal(run.inner.state().queue.length, 0);
});

test("inner: past the attention's own perDay the wake waits as capped and runs the next local day; the other wakes go on; a read-only place still wakes the persona", async () => {
  const lines = [seen('m1', { by: 'u1', at: NOW - 5 * MINUTE_MS })];
  const run = attentionSetup({ lines, perDay: 1, canSend: (channel: Record<string, Untyped>) => channel.id !== 'c2' });
  // A due intention elsewhere and the attention: both run; the attention in a place the persona cannot write in.
  run.service.set({ purpose: 'say hi', dueAt: NOW - MINUTE_MS, placeId: 'c1', scope: 'group' });
  await run.inner.tick();
  await run.inner.tick();
  const calls = run.turns.calls;
  assert.deepEqual(calls.map(({ chat, inner }: Record<string, Untyped>) => [chat.chatId, inner.wake.kind]).sort(), [
    ['c1', 'intention_due'],
    ['c2', 'attend'],
  ]);
  // The second burst of the day waits.
  const lines2 = run.record.lines;
  lines2.push(seen('m2', { by: 'u2', at: NOW + 10 * MINUTE_MS }));
  clock.t = NOW + 12 * MINUTE_MS;
  const capped = await run.inner.tick();
  assert.deepEqual(capped.drained, { refused: 'attend-per-day' });
  const calls2 = run.turns.calls;
  assert.equal(calls2.length, 2);
  await settle();
  assert.deepEqual(
    run.journal.filter((r) => r.event === 'capped').map((r) => r.cap),
    ['attend-per-day']
  );
  assert.equal(run.inner.state().queue[0].capped, 'attend-per-day');
  const status = run.inner.status();
  assert.deepEqual(status.attention, { open: 1, listed: 2, run: 1, spoken: 0, skipped: 1, waiting: 1 });
  // Another due intention is not held back by it.
  run.service.set({ purpose: 'say bye', dueAt: NOW + 11 * MINUTE_MS, placeId: 'c1', scope: 'group' });
  clock.t = NOW + 13 * MINUTE_MS;
  await run.inner.tick();
  const calls3 = run.turns.calls;
  assert.equal(calls3.length, 3);
  const inner = calls3[2].inner;
  assert.equal(inner.wake.kind, 'intention_due');
  assert.equal(run.inner.state().queue.length, 1, 'the capped attend wake still waits');
  // The next local day it runs, and counts on that day.
  clock.t = NOW + DAY_MS;
  await run.inner.tick();
  const calls4 = run.turns.calls;
  assert.equal(calls4.length, 4);
  const inner2 = calls4[3].inner;
  assert.equal(inner2.wake.kind, 'attend');
  assert.deepEqual(run.service.attendToday(run.id), { day: '2026-10-20', wakes: 1 });
  assert.equal(run.journal.filter((r) => r.event === 'capped').length, 1, 'journalled once per wake');
});

test('inner: a cancelled attention wakes the persona no more and its queued wake is stale; places() lists, filters and pages the published places', async () => {
  const turns = fakeTurns();
  turns.busy = true;
  const lines = [
    seen('m1', { by: 'u1', at: NOW - 5 * MINUTE_MS }),
    seen('m2', { channel: 'c3', by: 'u2', at: NOW - 2 * MINUTE_MS }),
  ];
  const run = attentionSetup({
    lines,
    turns,
    places: () => [
      { id: 'c1', name: 'general', writable: true },
      { id: 'c2', name: 'garden', writable: true },
      { id: 'c3', name: 'news', writable: false },
    ],
  });
  await run.inner.tick();
  assert.equal(run.inner.state().queue.length, 1);
  const page = run.inner.places({ sort: 'name', pageSize: 2 });
  assert.deepEqual([page.total, page.more, page.items.map((p) => p.name)], [3, 1, ['garden', 'general']]);
  assert.deepEqual(
    run.inner.places({ filter: 'new' }).items.map((p) => [p.name, p.lines, p.writable, p.attended]),
    [['news', 1, false, false]]
  );
  assert.deepEqual(
    run.inner.places({ sort: 'lines', page: 2, pageSize: 2 }).items.map((p) => p.name),
    ['general']
  );
  assert.equal(run.service.cancel(run.id).ok, true);
  turns.busy = false;
  await run.inner.tick();
  const calls = run.turns.calls;
  assert.equal(calls.length, 0);
  assert.equal(run.inner.state().queue.length, 0);
  assert.equal(run.inner.state().handled[`inner.wake:attend:${run.id}:m1`].outcome, 'stale');
  const lines2 = run.record.lines;
  lines2.push(seen('m3', { by: 'u1', at: NOW + MINUTE_MS }));
  clock.t = NOW + 5 * MINUTE_MS;
  await run.inner.tick();
  const calls2 = run.turns.calls;
  assert.equal(calls2.length, 0, 'nothing reseeds a cancelled attention');
  assert.deepEqual(run.inner.status().attention, {
    open: 0,
    listed: 1,
    run: 0,
    spoken: 0,
    skipped: 0,
    waiting: 0,
  });
});
