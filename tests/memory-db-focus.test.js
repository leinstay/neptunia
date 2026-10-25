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
import { openMemoryDb } from '../src/memory/db/open.js';
import { insertRows } from '../src/memory/db/rows.js';
import {
  FOCUS_DEFAULTS, MOVE_REASONS, affinity01, focusSettings, focusView, lastFocusDay, recompute, recountDaily, runFocusDay, scoreOf, setOverride,
} from '../src/memory/db/focus.js';
import { createMemoryDb } from '../src/memory/db/service.js';
import { tableHashes } from '../tools/memory-db.mjs';
import { buildDataDir } from './fixtures/memory-db/datadir.js';

const quiet = { info() {}, debug() {}, warn() {}, error() {} };
const DAY = 86_400_000;
const HOUR = 3_600_000;
const START = Date.parse('2026-08-01T00:00:00.000Z');
const iso = (ms) => new Date(ms).toISOString();
const native = (n) => `90000000000000${String(n).padStart(4, '0')}`;
const person = (n) => `person:discord:${native(n)}`;
const account = (n) => `discord:${native(n)}`;
const C1 = 'discord:channel:c1';

/** A database with `n` people, each with one verified Discord account, and one group channel. */
function peopleDb(n) {
  const handle = openMemoryDb(':memory:');
  insertRows(handle.db, {
    places: [{ id: C1, iface: 'discord', kind: 'channel', native_id: 'c1', parent_id: null, scope_kind: 'group', name: 'general' }],
    people: Array.from({ length: n }, (_, i) => ({ id: person(i), kind: 'person', first_seen_at: iso(START) })),
    accounts: Array.from({ length: n }, (_, i) => ({ id: account(i), iface: 'discord', native_id: native(i), person_id: person(i), link: 'verified', linked_at: null })),
  }, { log: quiet, at: iso(START) });
  return handle;
}

let seq = 0;
/** A stored line: `seen` by an account, or `said` (hers). */
function line(kind, at, extra = {}) {
  seq += 1;
  return {
    id: `src:discord:${seq}:1:${kind}`, kind, iface: 'discord', native_id: String(seq), revision: 1, place_id: C1, occurred_at: iso(at), recorded_at: iso(at),
    text: 'x', scope_kind: 'group', scope_iface: 'discord', scope_dm: null, ...extra,
  };
}

// ---------- the score ----------

test('focus: the score of policy 1 and its settings', () => {
  const s = focusSettings({ focus: { ...FOCUS_DEFAULTS } });
  assert.deepEqual(focusSettings({ focus: { size: 'x', margin: -1, weights: { affinity: 0.4 } } }).size, 24);
  assert.equal(focusSettings({ focus: { weights: { affinity: 0.4 } } }).weights.affinity, 0.4);
  assert.equal(affinity01(-100), 0);
  assert.equal(affinity01(20), 0.6);
  assert.equal(affinity01(null), null);
  const now = START + 100 * DAY;
  // No attitude, no exchange: neutral affinity, neutral reciprocity and shared interest, nothing else.
  assert.deepEqual(scoreOf({ affinity: null }, now, s), { score: 0.4, parts: { affinity: 0.5, reciprocity: 0.5, sharedInterest: 0.5, recency: 0, consistency: 0, novelty: 0 } });
  // Affinity 100, a meaningful day today and a first one today, 8 meaningful days of the last 28.
  const full = scoreOf({ affinity: 100, lastMeaningfulAt: now, firstMeaningfulAt: now, meaningfulDays: 8 }, now, s);
  assert.equal(full.score, Math.round((0.55 + 0.15 * 0.5 + 0.1 * 0.5 + 0.1 + 0.1 + 0.12) * 1e6) / 1e6);
  // Recency and novelty halve over their half-lives; a negative attitude brings no novelty.
  const later = scoreOf({ affinity: 0, lastMeaningfulAt: now - 60 * DAY, firstMeaningfulAt: now - 14 * DAY, meaningfulDays: 4 }, now, s);
  assert.equal(later.parts.recency, 0.5);
  assert.equal(later.parts.novelty, 0.06);
  assert.equal(later.parts.consistency, 0.5);
  assert.equal(scoreOf({ affinity: -1, firstMeaningfulAt: now }, now, s).parts.novelty, 0);
});

// ---------- the counts ----------

test('recountDaily: addressed both ways from the stored lines, meaningful when both, per audience; idempotent; revisions and merges count once', () => {
  const handle = peopleDb(3);
  const { db } = handle;
  try {
    const day = START + 10 * DAY;
    const dm = { scope_kind: 'dm', scope_iface: 'discord', scope_dm: person(1), place_id: null };
    const herLine = line('said', day + HOUR, { native_id: 'her-1', id: 'src:discord:her-1:1:said' });
    insertRows(db, {
      sources: [
        herLine,
        // Person 0: addresses her directly twice (one message with two revisions counts once) and she names them.
        line('seen', day + 2 * HOUR, { author_account: account(0), direct: 1, native_id: 'm-a', id: 'src:discord:m-a:1:seen' }),
        line('seen', day + 2 * HOUR + 1000, { author_account: account(0), direct: 1, native_id: 'm-a', revision: 2, id: 'src:discord:m-a:2:seen' }),
        line('said', day + 3 * HOUR, { mentions: JSON.stringify([native(0)]) }),
        // Person 1: replies to her line (not direct) in the group; in their DM only she speaks to them (not meaningful).
        line('seen', day + 4 * HOUR, { author_account: account(1), direct: 0, reply_to: 'her-1' }),
        line('said', day + 5 * HOUR, { ...dm, mentions: JSON.stringify([native(1)]) }),
        // Person 2: a seen line not addressed to her counts nothing; her reply to their line counts for her side.
        line('seen', day + 6 * HOUR, { author_account: account(2), direct: 0, native_id: 'm-c', id: 'src:discord:m-c:1:seen' }),
        line('said', day + 7 * HOUR, { reply_to: 'm-c' }),
        // Another day: not in the range.
        line('seen', day + 2 * DAY, { author_account: account(0), direct: 1 }),
      ],
    }, { log: quiet, at: iso(day) });
    const result = recountDaily(handle, { from: day, to: day });
    assert.equal(result.days, 1);
    const rows = () => db.prepare('SELECT person_id, day, audience_id, addressed_by_them AS them, addressed_by_her AS her, meaningful FROM relationship_daily ORDER BY person_id, audience_id').all().map((row) => ({ ...row }));
    const dayKey = '2026-08-11';
    assert.deepEqual(rows(), [
      { person_id: person(0), day: dayKey, audience_id: 'aud:group:discord', them: 1, her: 1, meaningful: 1 },
      { person_id: person(1), day: dayKey, audience_id: 'aud:dm:discord:dm:900000000000000001', them: 0, her: 1, meaningful: 0 },
      { person_id: person(1), day: dayKey, audience_id: 'aud:group:discord', them: 1, her: 0, meaningful: 0 },
      { person_id: person(2), day: dayKey, audience_id: 'aud:group:discord', them: 0, her: 1, meaningful: 0 },
    ]);
    const hash = tableHashes(db, ['relationship_daily']);
    recountDaily(handle, { from: day, to: day + HOUR });
    assert.deepEqual(tableHashes(db, ['relationship_daily']), hash, 'a recount is idempotent');
    // Person 1 is found to be person 0: their lines count for the survivor, each line once.
    db.prepare("INSERT INTO people_merges (id, from_person, into_person, at, by) VALUES ('merge-1', ?, ?, ?, 'owner')").run(person(1), person(0), iso(day));
    recountDaily(handle, { from: day, to: day });
    const merged = rows().filter((row) => row.person_id === person(0) && row.audience_id === 'aud:group:discord')[0];
    assert.deepEqual({ them: merged.them, her: merged.her }, { them: 2, her: 1 });
    assert.equal(rows().filter((row) => row.person_id === person(1)).length, 0);
  } finally {
    handle.close();
  }
});

// ---------- the anti-churn rules, small ----------

/** Puts one meaningful day for each named person on `day` straight into the counts (the recount is tested above). */
function meaningful(db, day, ...people) {
  for (const id of people) {
    db.prepare(`INSERT OR REPLACE INTO relationship_daily (person_id, day, audience_id, addressed_by_them, addressed_by_her, meaningful, last_contact_at)
      VALUES (?, ?, 'aud:group:discord', 1, 1, 1, ?)`).run(id, new Date(day).toISOString().slice(0, 10), iso(day));
  }
}
const affinity = (db, n, value) => db.prepare('UPDATE people SET affinity = ? WHERE id = ?').run(value, person(n));
const bucketOf = (db, n) => db.prepare('SELECT bucket FROM focus_members WHERE person_id = ?').get(person(n))?.bucket ?? null;
const reasonsOf = (db, n) => db.prepare('SELECT reason FROM focus_events WHERE person_id = ? ORDER BY at, rowid').all(person(n)).map((row) => row.reason);
const ONE_SLOT = { focus: { size: 1, exploring: 0, settleDays: 0, maxMovesPerWeek: 2, margin: 0.08, confirmHours: 24, entryAffinity: 0.6 } };

test('recompute: a challenger beats the lowest member by the margin at recomputations a day apart; half a day is not enough; a lapse starts over', () => {
  const handle = peopleDb(2);
  const { db } = handle;
  try {
    const t0 = START + DAY;
    affinity(db, 0, 40);
    meaningful(db, t0, person(0), person(1));
    recompute(handle, { now: t0, config: ONE_SLOT });
    assert.equal(bucketOf(db, 0), 'close');
    assert.deepEqual(reasonsOf(db, 0), ['seed']);
    // The challenger: 0.55 * (1.0 - 0.7) = 0.165 above the member, over the margin.
    affinity(db, 1, 100);
    const t1 = t0 + HOUR;
    recompute(handle, { now: t1, config: ONE_SLOT });
    assert.deepEqual(reasonsOf(db, 1), ['challenge']);
    recompute(handle, { now: t1 + 12 * HOUR, config: ONE_SLOT });
    assert.equal(bucketOf(db, 1), null, 'half a day is not a second confirmation');
    // Its lead goes for one recomputation: the run lapses, and the next lead is a new run.
    affinity(db, 1, 45);
    recompute(handle, { now: t1 + 18 * HOUR, config: ONE_SLOT });
    affinity(db, 1, 100);
    recompute(handle, { now: t1 + 25 * HOUR, config: ONE_SLOT });
    assert.equal(bucketOf(db, 1), null, 'a lapse in between: no promotion');
    assert.deepEqual(reasonsOf(db, 1), ['challenge', 'challenge_lapsed', 'challenge']);
    recompute(handle, { now: t1 + 37 * HOUR, config: ONE_SLOT });
    assert.equal(bucketOf(db, 1), null);
    recompute(handle, { now: t1 + 49 * HOUR, config: ONE_SLOT });
    assert.equal(bucketOf(db, 1), 'close');
    assert.equal(bucketOf(db, 0), null);
    assert.deepEqual(reasonsOf(db, 1), ['challenge', 'challenge_lapsed', 'challenge', 'challenge_won']);
    assert.deepEqual(reasonsOf(db, 0), ['seed', 'replaced']);
    // A lead under the margin is no challenge at all.
    affinity(db, 0, 100);
    affinity(db, 1, 95);
    recompute(handle, { now: t1 + 80 * HOUR, config: ONE_SLOT });
    assert.equal(reasonsOf(db, 0).at(-1), 'replaced', '0.55 * 0.025 is under the margin');
  } finally {
    handle.close();
  }
});

test('recompute: a settling member cannot be replaced; the first computation seeds; a negative attitude leaves and never enters', () => {
  const handle = peopleDb(3);
  const { db } = handle;
  try {
    const config = { focus: { ...ONE_SLOT.focus, settleDays: 21 } };
    // No member and no event ever: the first computation seeds without confirmation.
    affinity(db, 0, 40);
    recompute(handle, { now: START, config });
    assert.equal(bucketOf(db, 0), 'close');
    affinity(db, 1, 100);
    for (let d = 1; d <= 25; d += 1) recompute(handle, { now: START + d * DAY, config });
    const won = db.prepare("SELECT at FROM focus_events WHERE person_id = ? AND reason = 'challenge_won'").get(person(1));
    assert.ok(won, 'promoted once the member settled');
    assert.ok(Date.parse(won.at) >= START + 21 * DAY, `not before 21 days (${won.at})`);
    // A close member whose attitude turns negative leaves; a negative person with every other input high never enters.
    affinity(db, 1, -5);
    affinity(db, 2, -80);
    meaningful(db, START + 26 * DAY, person(2));
    recompute(handle, { now: START + 26 * DAY, config });
    assert.equal(bucketOf(db, 1), null);
    assert.equal(reasonsOf(db, 1).at(-1), 'negative_affinity');
    assert.notEqual(bucketOf(db, 2), 'close');
    assert.equal(bucketOf(db, 2), null, 'not even exploring');
  } finally {
    handle.close();
  }
});

// ---------- the 40 people over 60 days ----------

const BOTS = [38, 39];
const NEGATIVE = 37;
const LATE = [30, 31, 32, 33, 34, 35, 36];
/** The scripted attitude of person `n` on day `d`. */
function scriptedAffinity(n, d) {
  if (n === 19) return d >= 45 ? -10 : 60;
  if (n < 20) return 60;
  if (n < 30) return 10;
  if (LATE.includes(n)) return d < 30 ? null : 90;
  if (n === NEGATIVE) return -50;
  return 95;
}
const BIG = { focus: { size: 24, exploring: 4, exploringShare: 0.15, entryAffinity: 0.6, margin: 0.08, confirmHours: 24, maxMovesPerWeek: 2, settleDays: 21, policyVersion: 1 } };
let big = null;

/**
 * 40 people over 60 days, one recomputation a day at noon. People 0-19 talk with her every day (attitude 60; person 19
 * turns negative on day 45), 20-29 every third day below the entry bar (10), 30-36 arrive on day 30 (90), 37 is negative
 * (-50), 38-39 are bots (95). Day 40: person 5 excluded, person 25 pinned (below the bar), bot 38 pinned. Day 50: people
 * 0-29 but 5 and 19 pinned (28 pins for 24 slots).
 */
function bigFixture() {
  if (big) return big;
  const handle = peopleDb(40);
  const { db } = handle;
  db.prepare(`UPDATE accounts SET kind = 'bot' WHERE id IN (${BOTS.map(() => '?').join(', ')})`).run(...BOTS.map(account));
  const days = [];
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
    if (d === 50) for (let n = 0; n < 30; n += 1) if (n !== 5 && n !== 19) setOverride(handle, { person: person(n), kind: 'pin', approvedBy: 'owner' });
    runFocusDay(handle, { now: START + d * DAY + 12 * HOUR, config: BIG });
    const members = db.prepare('SELECT person_id, bucket, since FROM focus_members').all().map((row) => ({ ...row }));
    days.push({ close: members.filter((m) => m.bucket === 'close'), exploring: members.filter((m) => m.bucket === 'exploring') });
  }
  const events = db.prepare('SELECT person_id, at, old_bucket, new_bucket, reason, extra FROM focus_events ORDER BY at, rowid').all().map((row) => ({ ...row, extra: row.extra ? JSON.parse(row.extra) : null }));
  big = { handle, db, days, events };
  return big;
}
const ids = (members) => members.map((m) => m.person_id).sort();
const closeOn = (d, n) => bigFixture().days[d].close.some((m) => m.person_id === person(n));
const inAnyBucket = (d, n) => closeOn(d, n) || bigFixture().days[d].exploring.some((m) => m.person_id === person(n));

test('focus fixture: the seed takes only those over the entry bar (fewer than the size), never above the size, bots and a negative attitude never close', () => {
  const { days } = bigFixture();
  assert.deepEqual(ids(days[0].close), Array.from({ length: 20 }, (_, n) => person(n)).sort(), 'day 0: the 20 over the bar');
  for (let d = 0; d < 60; d += 1) {
    assert.ok(days[d].close.length <= 24, `day ${d}: ${days[d].close.length} close`);
    assert.ok(days[d].exploring.length <= 4);
    for (const bot of BOTS) assert.equal(inAnyBucket(d, bot), false, `day ${d}: bot ${bot} (pinned from day 40) in no bucket`);
    assert.equal(inAnyBucket(d, NEGATIVE), false, `day ${d}: the negative person in no bucket`);
    for (const n of [20, 21, 22, 23, 24, 26, 27, 28, 29]) if (d < 50) assert.equal(closeOn(d, n), false, `day ${d}: ${n} is below the bar`);
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
    assert.ok(at - Date.parse(e.extra.since) >= 24 * HOUR, `${e.person_id} confirmed a day apart`);
    assert.ok(events.some((c) => c.person_id === e.person_id && c.reason === 'challenge' && c.at === e.extra.since), 'the run started with a challenge row');
    const window = moves.filter((m) => Date.parse(m.at) > at - 7 * DAY && Date.parse(m.at) <= at);
    assert.ok(window.length <= 2, `${window.length} moves in the 7 days to ${e.at}`);
  }
  for (const n of LATE) assert.equal(closeOn(30, n), false, `${n}: no entry on the day it arrived`);
  for (const e of events.filter((x) => x.reason === 'replaced')) {
    const entered = events.filter((x) => x.person_id === e.person_id && x.new_bucket === 'close' && x.at < e.at).at(-1);
    assert.ok(Date.parse(e.at) - Date.parse(entered.at) >= 21 * DAY, `${e.person_id} had settled`);
  }
  assert.ok(events.some((e) => e.reason === 'replaced'), 'replacements happened');
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
    assert.ok(days[d].close.every((m) => pinned.map(person).includes(m.person_id)), `day ${d}: only pins`);
  }
  const over = events.filter((e) => e.reason === 'over_capacity');
  assert.equal(over.length, 4);
  assert.equal(new Set(over.map((e) => e.person_id)).size, 4, 'each reported once');
  assert.ok(ids(days[59].close).join() === ids(days[51].close).join(), 'pins over capacity do not take turns');
  // A pin displaces a settling member (pin > settling).
  const displaced = events.filter((e) => e.reason === 'displaced_by_pin');
  assert.ok(displaced.some((e) => {
    const entered = events.filter((x) => x.person_id === e.person_id && x.new_bucket === 'close' && x.at < e.at).at(-1);
    return Date.parse(e.at) - Date.parse(entered.at) < 21 * DAY;
  }), 'a settling member made room for a pin');
});

test('focus fixture: the reader gives member ids of the interface, close then exploring, the best first; only focus.js selects the sets', () => {
  const { db } = bigFixture();
  const view = focusView(db, { iface: 'discord' });
  assert.equal(view.close.length, 24);
  assert.equal(view.exploring.length, 4);
  assert.ok(view.close.every((id) => /^9\d+$/.test(id)));
  const scores = db.prepare("SELECT score FROM focus_members WHERE bucket = 'close' ORDER BY score DESC").all().map((row) => row.score);
  assert.deepEqual(scores, [...scores].sort((a, b) => b - a));
  assert.deepEqual(focusView(db, { iface: 'telegram' }), { close: [], exploring: [] });
  // Internal-only: no module of the engine but the focus code (and the schema) names the sets' tables.
  const readers = [];
  const walkDir = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) walkDir(abs);
      else if (entry.name.endsWith('.js') && /focus_members|focus_events|relationship_daily/.test(fs.readFileSync(abs, 'utf8'))) readers.push(path.relative('src', abs));
    }
  };
  walkDir('src');
  assert.deepEqual(readers.sort(), ['memory/db/focus.js', 'memory/db/schema.js']);
});

// ---------- the daily job ----------

function serviceEnv({ worker = false } = {}) {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'memdb-focus-'));
  const data = path.join(root, 'data');
  fs.mkdirSync(data);
  buildDataDir(data);
  const hot = { config: { memoryDb: { focus: { enabled: true } }, focus: { size: 3, exploring: 1, exploringShare: 0.25 } } };
  let time = Date.UTC(2026, 9, 24, 12, 0, 0);
  const service = createMemoryDb({ hot, dataDir: data, log: quiet, now: () => time, ...(worker ? {} : { worker: false }) });
  return {
    hot, service, file: path.join(data, 'memory.db'), advance: (ms) => { time += ms; },
    done: async () => { await service.close().catch(() => {}); fs.rmSync(root, { recursive: true, force: true }); },
  };
}
const focusDayOf = (file) => {
  const reader = openMemoryDb(file, { readOnly: true });
  try { return { day: lastFocusDay(reader.db), events: reader.db.prepare('SELECT COUNT(*) AS n FROM focus_events').get().n }; } finally { reader.close(); }
};
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

test('service: the focus job runs once a UTC day when switched on, off by default; the reader carries the share; on the worker too', async () => {
  const env = serviceEnv();
  try {
    env.hot.config.memoryDb.focus.enabled = false;
    await env.service.tick();
    await settle();
    assert.equal(focusDayOf(env.file).day, null, 'off: nothing ran');
    env.hot.config.memoryDb.focus.enabled = true;
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
    const view = env.service.focusPeople();
    assert.deepEqual(Object.keys(view).sort(), ['close', 'exploring', 'exploringShare']);
    assert.equal(view.exploringShare, 0.25);
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
