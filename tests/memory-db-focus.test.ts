// Schema v10, stage 5 (spec 2026-10-24-memory-schema-v7, section 5; section 11's resolutions on focus): the relationship
// counts recounted from the stored lines, the score, and the close and exploring sets on a fixture of 40 people over 60
// days with scripted attitudes and lines (entry, the margin held at recomputations a day apart, the weekly move cap,
// settling, precedence exclude > bot > pin > settling, bots, pins over capacity, a negative attitude never close), the
// daily job of the service on both paths, and the reader the heartbeat uses. Every test sets its own settings. Synthetic
// data only; the ids are made up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { insertRows } from '../src/memory/db/rows.ts';
import {
  MOVE_REASONS,
  affinity01,
  focusSettings,
  focusView,
  lastFocusDay,
  recountDaily,
  runFocusDay,
  scoreOf,
  setOverride,
} from '../src/memory/db/focus.ts';
import { createMemoryDb } from '../src/memory/db/service.ts';
import { tableHashes } from '../scripts/memory-db.ts';
import { buildDataDir } from './fixtures/memory-db/datadir.ts';
import type { Untyped } from '../src/tools/types.ts';
import { sqlOf, wrongly, present } from './fixtures/loose-types.ts';
import type { UntypedDb } from './fixtures/loose-types.ts';

const quiet = { info() {}, debug() {}, warn() {}, error() {} };
const DAY = 86_400_000;
const HOUR = 3_600_000;
const START = Date.parse('2026-08-01T00:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();
const native = (n: number) => `90000000000000${String(n).padStart(4, '0')}`;
const person = (n: number) => `person:discord:${native(n)}`;
const account = (n: number) => `discord:${native(n)}`;
const C1 = 'discord:channel:c1';

/** A database with `n` people, each with one verified Discord account, and one group channel. */
function peopleDb(n: number) {
  const handle = openMemoryDb(':memory:');
  insertRows(
    handle.db,
    {
      places: [
        {
          id: C1,
          iface: 'discord',
          kind: 'channel',
          native_id: 'c1',
          parent_id: null,
          scope_kind: 'group',
          name: 'general',
        },
      ],
      people: Array.from({ length: n }, (_, i) => ({ id: person(i), kind: 'person', first_seen_at: iso(START) })),
      accounts: Array.from({ length: n }, (_, i) => ({
        id: account(i),
        iface: 'discord',
        native_id: native(i),
        person_id: person(i),
        link: 'verified',
        linked_at: null,
      })),
    },
    { log: quiet, at: iso(START) }
  );
  return handle;
}

let seq = 0;
/** A stored line: `seen` by an account, or `said` (hers). */
function line(kind: string, at: number, extra = {}) {
  seq += 1;
  return {
    id: `src:discord:${seq}:1:${kind}`,
    kind,
    iface: 'discord',
    native_id: String(seq),
    revision: 1,
    place_id: C1,
    occurred_at: iso(at),
    recorded_at: iso(at),
    text: 'x',
    scope_kind: 'group',
    scope_iface: 'discord',
    scope_dm: null,
    ...extra,
  };
}

// ---------- the score ----------

// PR 7d: the focus settings are the constants FOCUS_DEFAULTS; the live config holds none.
test('focus: the score of policy 1', () => {
  const s = focusSettings();
  assert.equal(affinity01(-100), 0);
  assert.equal(affinity01(20), 0.6);
  assert.equal(affinity01(null), null);
  const now = START + 100 * DAY;
  // No attitude, no exchange: neutral affinity, neutral reciprocity and shared interest, nothing else.
  assert.deepEqual(scoreOf({ affinity: null }, now, s), {
    score: 0.4,
    parts: { affinity: 0.5, reciprocity: 0.5, sharedInterest: 0.5, recency: 0, consistency: 0, novelty: 0 },
  });
  // Affinity 100, a meaningful day today and a first one today, 8 meaningful days of the last 28.
  const full = scoreOf({ affinity: 100, lastMeaningfulAt: now, firstMeaningfulAt: now, meaningfulDays: 8 }, now, s);
  assert.equal(full.score, Math.round((0.55 + 0.15 * 0.5 + 0.1 * 0.5 + 0.1 + 0.1 + 0.12) * 1e6) / 1e6);
  // Recency and novelty halve over their half-lives; a negative attitude brings no novelty.
  const later = scoreOf(
    { affinity: 0, lastMeaningfulAt: now - 60 * DAY, firstMeaningfulAt: now - 14 * DAY, meaningfulDays: 4 },
    now,
    s
  );
  assert.equal(later.parts.recency, 0.5);
  assert.equal(later.parts.novelty, 0.06);
  assert.equal(later.parts.consistency, 0.5);
  assert.equal(scoreOf({ affinity: -1, firstMeaningfulAt: now }, now, s).parts.novelty, 0);
});

// ---------- the counts ----------

test('recountDaily: addressed both ways from the stored lines, meaningful when both, per audience; idempotent; revisions and merges count once', () => {
  const handle = peopleDb(3);
  const db = sqlOf(handle);
  try {
    const day = START + 10 * DAY;
    const dm = { scope_kind: 'dm', scope_iface: 'discord', scope_dm: person(1), place_id: null };
    // Changed with ids-by-links slice 3: no writer makes person 1's DM place from the person id, so it is stored first.
    insertRows(db, {
      places: [
        {
          id: `discord:dm:${native(1)}`,
          iface: 'discord',
          kind: 'dm',
          native_id: null,
          scope_kind: 'dm',
          partner_person: person(1),
          partner_account: account(1),
        },
      ],
    });
    const herLine = line('said', day + HOUR, { native_id: 'her-1', id: 'src:discord:her-1:1:said' });
    insertRows(
      db,
      {
        sources: [
          herLine,
          // Person 0: addresses her directly twice (one message with two revisions counts once) and she names them.
          line('seen', day + 2 * HOUR, {
            author_account: account(0),
            direct: 1,
            native_id: 'm-a',
            id: 'src:discord:m-a:1:seen',
          }),
          line('seen', day + 2 * HOUR + 1000, {
            author_account: account(0),
            direct: 1,
            native_id: 'm-a',
            revision: 2,
            id: 'src:discord:m-a:2:seen',
          }),
          line('said', day + 3 * HOUR, { mentions: JSON.stringify([native(0)]) }),
          // Person 1: replies to her line (not direct) in the group; in their DM only she speaks to them (not meaningful).
          line('seen', day + 4 * HOUR, { author_account: account(1), direct: 0, reply_to: 'her-1' }),
          line('said', day + 5 * HOUR, { ...dm, mentions: JSON.stringify([native(1)]) }),
          // Person 2: a seen line not addressed to her counts nothing; her reply to their line counts for her side.
          line('seen', day + 6 * HOUR, {
            author_account: account(2),
            direct: 0,
            native_id: 'm-c',
            id: 'src:discord:m-c:1:seen',
          }),
          line('said', day + 7 * HOUR, { reply_to: 'm-c' }),
          // Another day: not in the range.
          line('seen', day + 2 * DAY, { author_account: account(0), direct: 1 }),
        ],
      },
      { log: quiet, at: iso(day) }
    );
    const result = recountDaily(handle, { from: day, to: day });
    assert.equal(result.days, 1);
    const rows = () =>
      db
        .prepare(
          'SELECT person_id, day, audience_id, addressed_by_them AS them, addressed_by_her AS her, meaningful FROM relationship_daily ORDER BY person_id, audience_id'
        )
        .all()
        .map((row) => ({ ...row }));
    const dayKey = '2026-08-11';
    assert.deepEqual(rows(), [
      { person_id: person(0), day: dayKey, audience_id: 'aud:group:discord', them: 1, her: 1, meaningful: 1 },
      {
        person_id: person(1),
        day: dayKey,
        audience_id: 'aud:dm:discord:dm:900000000000000001',
        them: 0,
        her: 1,
        meaningful: 0,
      },
      { person_id: person(1), day: dayKey, audience_id: 'aud:group:discord', them: 1, her: 0, meaningful: 0 },
      { person_id: person(2), day: dayKey, audience_id: 'aud:group:discord', them: 0, her: 1, meaningful: 0 },
    ]);
    const hash = tableHashes(db, ['relationship_daily']);
    recountDaily(handle, { from: day, to: day + HOUR });
    assert.deepEqual(tableHashes(db, ['relationship_daily']), hash, 'a recount is idempotent');
    // Person 1 is found to be person 0: their lines count for the survivor, each line once.
    db.prepare(
      "INSERT INTO people_merges (id, from_person, into_person, at, by) VALUES ('merge-1', ?, ?, ?, 'owner')"
    ).run(person(1), person(0), iso(day));
    recountDaily(handle, { from: day, to: day });
    const merged = rows().filter((row) => row.person_id === person(0) && row.audience_id === 'aud:group:discord')[0];
    assert.deepEqual({ them: merged.them, her: merged.her }, { them: 2, her: 1 });
    assert.equal(rows().filter((row) => row.person_id === person(1)).length, 0);
  } finally {
    handle.close();
  }
});

const affinity = (db: UntypedDb, n: number, value: Untyped) =>
  db.prepare('UPDATE people SET affinity = ? WHERE id = ?').run(value, person(n));

// ---------- the 40 people over 60 days ----------

const BOTS = [38, 39];
const NEGATIVE = 37;
const LATE = [30, 31, 32, 33, 34, 35, 36];
/** The scripted attitude of person `n` on day `d`. */
function scriptedAffinity(n: number, d: Untyped) {
  if (n === 19) return d >= 45 ? -10 : 60;
  if (n < 20) return 60;
  if (n < 30) return 10;
  if (LATE.includes(n)) return d < 30 ? null : 90;
  if (n === NEGATIVE) return -50;
  return 95;
}
/** One member of a day's focus set, and one recorded move between the sets. */
type Member = { person_id: string; bucket: string; since: string };
type FocusEventRow = {
  person_id: string;
  at: string;
  old_bucket: string;
  new_bucket: string;
  reason: string;
  extra: { since: string } | null;
};
type Big = {
  handle: ReturnType<typeof peopleDb>;
  db: UntypedDb;
  days: Array<{ close: Array<Member>; exploring: Array<Member> }>;
  events: Array<FocusEventRow>;
};
let big: Big | null = null;

/**
 * 40 people over 60 days, one recomputation a day at noon. People 0-19 talk with her every day (attitude 60; person 19
 * turns negative on day 45), 20-29 every third day below the entry bar (10), 30-36 arrive on day 30 (90), 37 is negative
 * (-50), 38-39 are bots (95). Day 40: person 5 excluded, person 25 pinned (below the bar), bot 38 pinned. Day 50: people
 * 0-29 but 5 and 19 pinned (28 pins for 24 slots).
 */
function bigFixture(): Big {
  if (big) return big;
  const handle = peopleDb(40);
  const db = sqlOf(handle);
  db.prepare(`UPDATE accounts SET kind = 'bot' WHERE id IN (${BOTS.map(() => '?').join(', ')})`).run(
    ...BOTS.map(account)
  );
  const days: Big['days'] = [];
  for (let d = 0; d < 60; d += 1) {
    for (let n = 0; n < 40; n += 1) affinity(db, n, scriptedAffinity(n, d));
    const sources = [];
    for (let n = 0; n < 40; n += 1) {
      if (LATE.includes(n) && d < 30) continue;
      if (n >= 20 && n < 30 && d % 3 !== 0) continue;
      const at = START + d * DAY + 9 * HOUR + n * 60_000;
      sources.push(line('seen', at, { author_account: account(n), direct: 1 }));
      sources.push(line('said', at + 30_000, { mentions: JSON.stringify([native(n)]) }));
    }
    insertRows(db, { sources }, { log: quiet, at: iso(START + d * DAY) });
    if (d === 40) {
      setOverride(handle, { person: person(5), kind: 'exclude', approvedBy: 'owner' });
      setOverride(handle, { person: person(25), kind: 'pin', approvedBy: 'owner' });
      setOverride(handle, { person: person(38), kind: 'pin', approvedBy: 'owner' });
    }
    if (d === 50)
      for (let n = 0; n < 30; n += 1)
        if (n !== 5 && n !== 19) setOverride(handle, { person: person(n), kind: 'pin', approvedBy: 'owner' });
    runFocusDay(handle, { now: START + d * DAY + 12 * HOUR });
    const members = db
      .prepare('SELECT person_id, bucket, since FROM focus_members')
      .all()
      .map((row): Member => ({
        person_id: String(row.person_id),
        bucket: String(row.bucket),
        since: String(row.since),
      }));
    days.push({
      close: members.filter((m) => m.bucket === 'close'),
      exploring: members.filter((m) => m.bucket === 'exploring'),
    });
  }
  const events = db
    .prepare('SELECT person_id, at, old_bucket, new_bucket, reason, extra FROM focus_events ORDER BY at, rowid')
    .all()
    .map((row): FocusEventRow => ({
      person_id: String(row.person_id),
      at: String(row.at),
      old_bucket: String(row.old_bucket),
      new_bucket: String(row.new_bucket),
      reason: String(row.reason),
      extra: row.extra ? wrongly<{ since: string }>(JSON.parse(String(row.extra))) : null,
    }));
  big = { handle, db, days, events };
  return big;
}
const ids = (members: Array<Member>) => members.map((m) => m.person_id).sort();
const closeOn = (d: number, n: number) => bigFixture().days[d].close.some((m) => m.person_id === person(n));
const inAnyBucket = (d: number, n: number) =>
  closeOn(d, n) || bigFixture().days[d].exploring.some((m) => m.person_id === person(n));

test('focus fixture: the seed takes only those over the entry bar (fewer than the size), never above the size, bots and a negative attitude never close', () => {
  const { days } = bigFixture();
  assert.deepEqual(
    ids(days[0].close),
    Array.from({ length: 20 }, (_, n) => person(n)).sort(),
    'day 0: the 20 over the bar'
  );
  for (let d = 0; d < 60; d += 1) {
    assert.ok(days[d].close.length <= 24, `day ${d}: ${days[d].close.length} close`);
    assert.ok(days[d].exploring.length <= 4);
    for (const bot of BOTS)
      assert.equal(inAnyBucket(d, bot), false, `day ${d}: bot ${bot} (pinned from day 40) in no bucket`);
    assert.equal(inAnyBucket(d, NEGATIVE), false, `day ${d}: the negative person in no bucket`);
    for (const n of [20, 21, 22, 23, 24, 26, 27, 28, 29])
      if (d < 50) assert.equal(closeOn(d, n), false, `day ${d}: ${n} is below the bar`);
  }
  // Person 19 turns negative on day 45: it leaves then and is never close again.
  assert.equal(closeOn(44, 19), true);
  for (let d = 45; d < 60; d += 1) assert.equal(closeOn(d, 19), false);
  assert.ok(bigFixture().events.some((e) => e.person_id === person(19) && e.reason === 'negative_affinity'));
});

test('focus fixture: every entry was confirmed a day apart, at most two moves in any 7 days, a replaced member had settled', () => {
  const { events } = bigFixture();
  const moves = events.filter((e) => MOVE_REASONS.includes(e.reason));
  assert.ok(moves.length >= 4, `the late arrivals entered (${moves.length} moves)`);
  for (const e of moves) {
    const at = Date.parse(e.at);
    assert.ok(at - Date.parse(present(e.extra).since) >= 24 * HOUR, `${e.person_id} confirmed a day apart`);
    assert.ok(
      events.some((c) => c.person_id === e.person_id && c.reason === 'challenge' && c.at === present(e.extra).since),
      'the run started with a challenge row'
    );
    const window = moves.filter((m) => Date.parse(m.at) > at - 7 * DAY && Date.parse(m.at) <= at);
    assert.ok(window.length <= 2, `${window.length} moves in the 7 days to ${e.at}`);
  }
  for (const n of LATE) assert.equal(closeOn(30, n), false, `${n}: no entry on the day it arrived`);
  for (const e of events.filter((x) => x.reason === 'replaced')) {
    const entered = events.filter((x) => x.person_id === e.person_id && x.new_bucket === 'close' && x.at < e.at).at(-1);
    assert.ok(Date.parse(e.at) - Date.parse(present(entered).at) >= 21 * DAY, `${e.person_id} had settled`);
  }
  assert.ok(
    events.some((e) => e.reason === 'replaced'),
    'replacements happened'
  );
});

test('focus fixture: precedence exclude > bot > pin > settling, pins over capacity reported once and the size not widened', () => {
  const { events, days } = bigFixture();
  // Day 40: the excluded member leaves and is never in a bucket again; the pinned person below the bar enters.
  assert.equal(closeOn(39, 5), true);
  for (let d = 40; d < 60; d += 1) assert.equal(inAnyBucket(d, 5), false, `day ${d}: excluded`);
  assert.ok(events.some((e) => e.person_id === person(5) && e.reason === 'exclude'));
  assert.equal(closeOn(39, 25), false);
  assert.equal(closeOn(40, 25), true, 'a pin needs no entry bar');
  // Day 50: 28 pins for 24 slots: 24 pinned members, 4 reported over capacity once each, the size kept.
  const pinned = Array.from({ length: 30 }, (_, n) => n).filter((n) => n !== 5 && n !== 19);
  for (let d = 50; d < 60; d += 1) {
    assert.equal(days[d].close.length, 24);
    assert.ok(
      days[d].close.every((m) => pinned.map(person).includes(m.person_id)),
      `day ${d}: only pins`
    );
  }
  const over = events.filter((e) => e.reason === 'over_capacity');
  assert.equal(over.length, 4);
  assert.equal(new Set(over.map((e) => e.person_id)).size, 4, 'each reported once');
  assert.ok(ids(days[59].close).join() === ids(days[51].close).join(), 'pins over capacity do not take turns');
  // A pin displaces a settling member (pin > settling).
  const displaced = events.filter((e) => e.reason === 'displaced_by_pin');
  assert.ok(
    displaced.some((e) => {
      const entered = events
        .filter((x) => x.person_id === e.person_id && x.new_bucket === 'close' && x.at < e.at)
        .at(-1);
      return Date.parse(e.at) - Date.parse(present(entered).at) < 21 * DAY;
    }),
    'a settling member made room for a pin'
  );
});

test('focus fixture: the reader gives member ids of the interface, close then exploring, the best first; only focus.js selects the sets', () => {
  const { db } = bigFixture();
  const view = focusView(db, { iface: 'discord' });
  assert.equal(view.close.length, 24);
  assert.equal(view.exploring.length, 4);
  assert.ok(view.close.every((id) => /^9\d+$/.test(id)));
  const scores = db
    .prepare("SELECT score FROM focus_members WHERE bucket = 'close' ORDER BY score DESC")
    .all()
    .map((row) => row.score);
  assert.deepEqual(
    scores,
    [...scores].sort((a, b) => b - a)
  );
  assert.deepEqual(focusView(db, { iface: 'telegram' }), { close: [], exploring: [] });
  // Internal-only: no module of the engine but the focus code (and the schema) names the sets' tables.
  const readers: Array<Untyped> = [];
  const walkDir = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walkDir(abs);
      else if (
        /\.(js|ts)$/.test(entry.name) &&
        /focus_members|focus_events|relationship_daily/.test(fs.readFileSync(abs, 'utf8'))
      )
        readers.push(path.relative('src', abs));
    }
  };
  walkDir('src');
  // The browser's catalog classifies every table by name and reads none of these by it; a person merge moves their rows.
  // The schema is two modules: the baseline creates the tables and the chain of schema.ts still holds their steps.
  assert.deepEqual(readers.sort(), [
    'memory/db/focus.ts',
    'memory/db/inspection-classes.ts',
    'memory/db/person-merge.ts',
    'memory/db/schema-baseline.ts',
    'memory/db/schema.ts',
  ]);
});

// ---------- the daily job ----------

function serviceEnv({ worker = false }: { worker?: boolean } = {}) {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'memdb-focus-'));
  const data = path.join(root, 'data');
  fs.mkdirSync(data);
  buildDataDir(data);
  // PR 7d: the focus job and its measures are code (an exploring share of 0.15).
  const hot = { config: {} };
  let time = Date.UTC(2026, 9, 24, 12, 0, 0);
  const service = createMemoryDb({
    hot,
    dataDir: data,
    log: quiet,
    now: () => time,
    ...(worker ? {} : { worker: false }),
  });
  return {
    hot,
    service,
    file: path.join(data, 'memory.db'),
    advance: (ms: number) => {
      time += ms;
    },
    done: async () => {
      await service.close().catch(() => {});
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}
const focusDayOf = (file: string) => {
  const reader = openMemoryDb(file, { readOnly: true });
  try {
    return {
      day: lastFocusDay(wrongly(sqlOf(reader))),
      events: sqlOf(reader).prepare('SELECT COUNT(*) AS n FROM focus_events').get().n,
    };
  } finally {
    reader.close();
  }
};
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

test('service: the focus job runs at the first tick with no setting', async () => {
  const env = serviceEnv();
  try {
    await env.service.tick();
    await settle();
    assert.equal(focusDayOf(env.file).day, '2026-10-24');
  } finally {
    await env.done();
  }
});

// PR 7d: `memoryDb.focus.enabled` is code (owner, 2026-10-31), so the step that held nothing ran with the switch off
// is gone; the next test holds the job running with no setting.
test('service: the focus job runs once a UTC day; the reader carries the share; on the worker too', async () => {
  const env = serviceEnv();
  try {
    await env.service.tick();
    await settle();
    assert.equal(focusDayOf(env.file).day, '2026-10-24');
    const events = focusDayOf(env.file).events;
    env.advance(HOUR);
    await env.service.tick();
    await settle();
    assert.equal(focusDayOf(env.file).events, events, 'once a day');
    env.advance(DAY);
    await env.service.tick();
    await settle();
    assert.equal(focusDayOf(env.file).day, '2026-10-25');
    const view: Untyped = env.service.focusPeople();
    assert.deepEqual(Object.keys(view).sort(), ['close', 'exploring', 'exploringShare']);
    assert.equal(present(view).exploringShare, 0.15);
  } finally {
    await env.done();
  }
  const threaded = serviceEnv({ worker: true });
  try {
    await threaded.service.tick();
    await threaded.service.close();
    assert.equal(focusDayOf(threaded.file).day, '2026-10-24', 'through the worker');
    assert.equal(threaded.service.focusPeople(), null, 'closed: no sets');
  } finally {
    await threaded.done();
  }
});
