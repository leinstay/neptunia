// Recall over the memory database (src/memory/db/recall.js) and the stems the sync fills (src/memory/db/stems.js), on
// synthetic Greek and accented Latin text: inflected forms, phrases, the trigram fallback, fusion, date ranking, scope
// filtering with the hidden marker, and window reads at the edges and across a hidden line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRecall } from '../src/behavior/recall-run.js';
import { createDiscordInterface } from '../src/interface/discord.js';
import { memorySearchText, runMemorySearch } from '../src/skills/tools.js';
import { openMemoryDb } from '../src/memory/db/open.js';
import { search, window, quotesOf, dbSettings } from '../src/memory/db/recall.js';
import { fillStems, loadStemmer, stemsOf } from '../src/memory/db/stems.js';
import { syncOnce } from '../src/memory/db/sync.js';
import { channelPlaceId, dmPlaceId, messageSourceId, personId } from '../src/memory/db/ids.js';
import { dmContext, dmScope, groupContext, groupScope, internalContext } from '../src/memory/db/scope.js';
import { quantize } from '../src/memory/vectors.js';
import { labels } from './fixtures/labels.js';
import { buildDataDir, guildDir, MEMBER, CHANNEL } from './fixtures/memory-db/datadir.js';

const DAY = 86400000;
const NOW = Date.parse('2026-10-24T12:00:00.000Z');
const MAIN = channelPlaceId('main');
const OTHER = channelPlaceId('other');
const ALICE = 'u-alice';
const BOB = 'u-bob';
const CAROL = 'u-carol';
const group = groupContext();

/** Filler chat that teaches the stemmer its Greek endings: twelve stems, each seen with five endings. */
const FILLER_STEMS = ['βιβλι', 'παιδ', 'δρομ', 'λογ', 'ανθρωπ', 'καιρ', 'φιλ', 'χρον', 'τοπ', 'κοσμ', 'νερ', 'ουραν'];
const FILLER_ENDINGS = ['ος', 'ου', 'ο', 'οι', 'ων'];

function fixture() {
  const handle = openMemoryDb(':memory:');
  const { db } = handle;
  let rowid = 0;
  const api = {
    handle,
    db,
    /** Inserts one chat line; returns its source id. `at` is epoch ms. */
    say({ native, at, text, place = MAIN, author = ALICE, kind = 'seen', scope = groupScope(), revision = 1, replyTo = null, extra = null }) {
      rowid += 1;
      const id = messageSourceId(native, revision, kind);
      db.prepare(`INSERT INTO sources (id, kind, iface, native_id, revision, place_id, author_account, reply_to, occurred_at, recorded_at, text, direct,
        scope_kind, scope_iface, scope_dm, extra) VALUES (?, ?, 'discord', ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`)
        .run(id, kind, String(native), revision, place, `discord:${author}`, replyTo, new Date(at).toISOString(), new Date(at).toISOString(), text,
          scope.scope_kind, scope.scope_iface, scope.scope_dm, extra);
      return id;
    },
    deleted(native, at) {
      db.prepare(`INSERT INTO sources (id, kind, iface, native_id, place_id, occurred_at, scope_kind, scope_iface)
        VALUES (?, 'deleted', 'discord', ?, ?, ?, 'group', 'discord')`).run(`src:discord:${native}:none:deleted:x`, String(native), MAIN, new Date(at).toISOString());
    },
    account(userId, names) {
      db.prepare("INSERT INTO accounts (id, iface, native_id, person_id, link, names) VALUES (?, 'discord', ?, ?, 'verified', ?)")
        .run(`discord:${userId}`, userId, personId(userId), JSON.stringify(names));
    },
    /** A vector row for a source (by native id): the vector is stored as int8 the way the engine stores it. */
    vector(native, vector, { scope = groupScope(), at = NOW } = {}) {
      const source = db.prepare('SELECT rowid AS rowid FROM sources WHERE native_id = ? ORDER BY rowid LIMIT 1').get(String(native));
      const { bytes, scale, norm } = quantize(vector);
      db.prepare(`INSERT INTO vectors (source_rowid, item_id, chunk_key, model, dims, scale, norm, bytes, context, occurred_at, scope_kind, scope_iface, scope_dm)
        VALUES (?, ?, ?, 'test/embedder', ?, ?, ?, ?, '{}', ?, ?, ?, ?)`)
        .run(source.rowid, String(native), `record:${native}:1`, vector.length, scale, norm, bytes, new Date(at).toISOString(), scope.scope_kind, scope.scope_iface, scope.scope_dm);
    },
    /** Teaches the stemmer from the filler chat, then stamps every row. */
    stem() {
      FILLER_STEMS.forEach((stem, i) => FILLER_ENDINGS.forEach((ending, j) => api.say({
        native: `filler-${i}-${j}`, at: NOW - 400 * DAY, text: `${stem}${ending}`, place: channelPlaceId('filler'), author: BOB,
      })));
      return fillStems(db);
    },
    done() { handle.close(); },
  };
  return api;
}

const plan = (forms, extra = {}) => ({ forms, who: [], from: null, to: null, ...extra });
const ids = (result) => result.hits.map((hit) => hit.messageId);
const run = (env, forms, { plan: given = {}, ...rest } = {}, ctx = group) => search(env.db, { ctx, plan: plan(forms, given), now: NOW, ...rest });

test('stems: the sync fills them, learns the endings from the database text and stamps again only what changed', () => {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'memdb-stems-'));
  const data = path.join(root, 'data');
  fs.mkdirSync(data);
  buildDataDir(data);
  const handle = openMemoryDb(path.join(root, 'memory.db'));
  try {
    const first = syncOnce(handle, data);
    assert.equal(first.errors, 0);
    const db = handle.db;
    const empty = db.prepare("SELECT COUNT(*) AS n FROM sources WHERE text IS NOT NULL AND stems IS NULL").get().n;
    assert.equal(empty, 0, 'every row with text has stems');
    const row = db.prepare("SELECT text, stems FROM sources WHERE text LIKE '%café at noon%'").get();
    assert.equal(row.stems, 'a cafe at noon', 'folded, one key per word');
    assert.ok(db.prepare("SELECT value FROM meta WHERE key = 'stemmer'").get(), 'the learned stemmer is kept in meta');
    // The FTS table reads the stems column.
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sources_fts WHERE sources_fts MATCH '{stems} : \"cafe\"'").get().n, 1);
    // A changed text loses its stems and gets new ones; an unchanged row keeps its own.
    db.prepare("UPDATE sources SET stems = 'kept' WHERE text = 'Καλημέρα'").run();
    const again = syncOnce(handle, data);
    assert.equal(again.errors, 0);
    assert.equal(db.prepare("SELECT stems FROM sources WHERE text = 'Καλημέρα'").get().stems, 'kept', 'a pass that wrote nothing stems nothing');
    const file = path.join(guildDir(data), 'record', '2026-10', '2026-10-20.jsonl');
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
    lines.push({ ...lines[0], id: 'r-new', messageId: '400000000000000077', text: 'ένα νέο μήνυμα' });
    fs.writeFileSync(file, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(file, later, later);
    syncOnce(handle, data);
    assert.equal(db.prepare("SELECT stems FROM sources WHERE native_id = '400000000000000077'").get().stems, 'ενα νεο μηνυμα');
    assert.equal(db.prepare("SELECT stems FROM sources WHERE text = 'Καλημέρα'").get().stems, 'kept');
    assert.ok(MEMBER && CHANNEL);
  } finally {
    handle.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('stems: the learned stemmer gives the inflected forms of a word one key, the query side uses the same one', () => {
  const env = fixture();
  try {
    env.say({ native: 'a1', at: NOW - DAY, text: 'ο δασκαλος του σπιτου' });
    env.say({ native: 'a2', at: NOW - 2 * DAY, text: 'το σπιτος δασκαλου' });
    env.stem();
    const { stem, endings } = loadStemmer(env.db);
    assert.ok(endings.includes('ου') && endings.includes('ος'));
    assert.equal(stem('σπιτου'), stem('σπιτος'));
    assert.equal(env.db.prepare("SELECT stems FROM sources WHERE native_id = 'a1'").get().stems, stemsOf(stem, 'ο δασκαλος του σπιτου'));
  } finally {
    env.done();
  }
});

test('words: an inflected form finds the line with another form of the word, an accent or a case does not matter', () => {
  const env = fixture();
  try {
    env.say({ native: 'm1', at: NOW - 3 * DAY, text: 'Ο δάσκαλος του σπίτου ήρθε' });
    env.say({ native: 'm2', at: NOW - 2 * DAY, text: 'το σπιτος ειναι μεγαλο' });
    env.say({ native: 'm3', at: NOW - DAY, text: 'Un café très chaud, des cafés, le CAFÉ du matin' });
    env.say({ native: 'm4', at: NOW - DAY, text: 'ούτε λέξη εδώ', place: OTHER });
    env.say({ native: 'm5', at: NOW - 4 * DAY, text: 'των σπιτων', place: OTHER });
    env.stem();
    const greek = run(env, ['σπιτοι']);
    assert.deepEqual(ids(greek).sort(), ['m1', 'm2', 'm5']);
    assert.deepEqual(greek.hits[0].streams, ['words']);
    assert.deepEqual(ids(run(env, ['ΉΡΘΕ'])), ['m1'], 'case and accent do not matter');
    const latin = run(env, ['Cafe']);
    assert.deepEqual(ids(latin), ['m3']);
    assert.equal(latin.windows.length, 1);
    assert.ok(latin.windows[0].messages.some((message) => message.id === 'm3'));
  } finally {
    env.done();
  }
});

test('words: a form of several words is a phrase and matches only the words side by side in order', () => {
  const env = fixture();
  try {
    env.say({ native: 'p1', at: NOW - 5 * DAY, text: 'το μεγαλο σπιτι του δασκαλου', place: MAIN });
    env.say({ native: 'p2', at: NOW - 4 * DAY, text: 'του δασκαλου το σπιτι', place: OTHER });
    env.say({ native: 'p3', at: NOW - 3 * DAY, text: 'ένα σπιτι και ένας δασκαλος', place: channelPlaceId('third') });
    env.stem();
    const result = run(env, ['σπιτι του δασκαλου']);
    assert.deepEqual(ids(result), ['p1']);
    assert.equal(result.hits[0].phrases, 1);
  } finally {
    env.done();
  }
});

test('trigram: a part of a word the stems do not hold is found by its letters, and says so', () => {
  const env = fixture();
  try {
    env.say({ native: 't1', at: NOW - 2 * DAY, text: 'η παρακαλουσα ηρθε αργα' });
    env.say({ native: 't2', at: NOW - DAY, text: 'οι ευχαριστιες μας', place: OTHER });
    env.stem();
    const parts = run(env, ['ρακαλου']);
    assert.deepEqual(ids(parts), ['t1']);
    assert.deepEqual(parts.hits[0].streams, ['trigram']);
    assert.equal(parts.stats.words, 0);
    // A form the words find is not searched by letters.
    const whole = run(env, ['ευχαριστιες']);
    assert.deepEqual(whole.hits.map((hit) => hit.streams), [['words']]);
    assert.equal(whole.stats.trigram, 0);
    // Under three letters there is no trigram.
    assert.deepEqual(ids(run(env, ['ηρ'])), []);
  } finally {
    env.done();
  }
});

test('fusion: a line found by two streams outranks lines found by one, and every hit says which streams found it', () => {
  const env = fixture();
  try {
    const at = NOW - 2 * DAY;
    env.say({ native: 'f-words', at, text: 'το σπιτι του δασκαλου', place: channelPlaceId('c1') });
    env.say({ native: 'f-meaning', at, text: 'τιποτα κοινο', place: channelPlaceId('c2') });
    env.say({ native: 'f-both', at, text: 'ο δασκαλος και το σπιτι', place: channelPlaceId('c3') });
    env.say({ native: 'f-far', at, text: 'ασχετο κειμενο', place: channelPlaceId('c4') });
    env.stem();
    env.vector('f-meaning', [1, 0, 0, 0]);
    env.vector('f-both', [0.9, 0.3, 0, 0]);
    env.vector('f-far', [0, 0, 1, 0]);
    const found = search(env.db, { ctx: group, plan: plan(['σπιτι', 'δασκαλου']), vector: [1, 0, 0, 0], now: NOW, settings: { ...dbSettings({}), gateShare: 0, minMeaning: 0.5 } });
    assert.deepEqual(ids(found), ['f-both', 'f-words', 'f-meaning']);
    const byId = new Map(found.hits.map((hit) => [hit.messageId, hit]));
    assert.deepEqual(byId.get('f-both').streams, ['words', 'meaning']);
    assert.deepEqual(byId.get('f-words').streams, ['words']);
    assert.deepEqual(byId.get('f-meaning').streams, ['meaning']);
    assert.ok(byId.get('f-both').score > byId.get('f-words').score);
    assert.ok(byId.get('f-both').cosine > 0.9 && byId.get('f-words').cosine === null);
    assert.equal(found.stats.meaning, 2, 'the line under the cosine floor is no meaning hit');
  } finally {
    env.done();
  }
});

test('gate: a hit far below the best is dropped', () => {
  const env = fixture();
  try {
    const at = NOW - DAY;
    env.say({ native: 'g1', at, text: 'σπιτι', place: channelPlaceId('c1') });
    env.say({ native: 'g2', at, text: 'ενα ασχετο μηνυμα', place: channelPlaceId('c2') });
    env.stem();
    env.vector('g1', [1, 0, 0, 0]);
    env.vector('g2', [0.6, 0.8, 0, 0]);
    const loose = search(env.db, { ctx: group, plan: plan(['σπιτι']), vector: [1, 0, 0, 0], now: NOW, settings: { ...dbSettings({}), gateShare: 0, minMeaning: 0 } });
    assert.deepEqual(ids(loose).sort(), ['g1', 'g2']);
    const strict = search(env.db, { ctx: group, plan: plan(['σπιτι']), vector: [1, 0, 0, 0], now: NOW, settings: { ...dbSettings({}), gateShare: 0.9, minMeaning: 0 } });
    assert.deepEqual(ids(strict), ['g1']);
  } finally {
    env.done();
  }
});

test('date ranking: among relevant lines the nearest to the asked range comes first, else the newest', () => {
  const env = fixture();
  try {
    const day = (n) => NOW - n * DAY;
    env.say({ native: 'd-old', at: day(30), text: 'το σπιτι', place: channelPlaceId('c1') });
    env.say({ native: 'd-mid', at: day(15), text: 'το σπιτι', place: channelPlaceId('c2') });
    env.say({ native: 'd-new', at: day(1), text: 'το σπιτι', place: channelPlaceId('c3') });
    env.stem();
    assert.deepEqual(ids(run(env, ['σπιτι'])), ['d-new', 'd-mid', 'd-old'], 'no date: toward now');
    const aimed = run(env, ['σπιτι'], { plan: { from: day(33), to: day(27) } });
    assert.deepEqual(ids(aimed), ['d-old'], 'the range bounds the search');
    const wide = run(env, ['σπιτι'], { plan: { from: day(35), to: day(5) } });
    assert.deepEqual(ids(wide), ['d-mid', 'd-old'], 'the middle of the range first');
    const open = run(env, ['σπιτι'], { plan: { from: day(16) } });
    assert.deepEqual(ids(open), ['d-mid', 'd-new'], 'an open range: toward its given end');
    const oldFirst = run(env, ['σπιτι'], { plan: { to: day(29) } });
    assert.deepEqual(ids(oldFirst), ['d-old']);
  } finally {
    env.done();
  }
});

test('people: a member named by the plan locates their lines; a name that is no account is searched as a word', () => {
  const env = fixture();
  try {
    env.account(ALICE, ['Αλίκη']);
    env.account(BOB, ['Βασίλης']);
    env.say({ native: 'w1', at: NOW - 2 * DAY, text: 'καλημερα σε ολους', author: ALICE, place: channelPlaceId('c1') });
    env.say({ native: 'w2', at: NOW - DAY, text: 'καλησπερα', author: BOB, place: channelPlaceId('c2') });
    env.say({ native: 'w3', at: NOW - DAY, text: 'ο Νικος ηρθε', author: BOB, place: channelPlaceId('c3') });
    env.stem();
    const alice = search(env.db, { ctx: group, plan: { forms: [], who: ['αλικη'], from: null, to: null }, now: NOW });
    assert.deepEqual(ids(alice), ['w1']);
    assert.deepEqual(alice.hits[0].streams, ['people']);
    const unknown = search(env.db, { ctx: group, plan: { forms: [], who: ['νικος'], from: null, to: null }, now: NOW });
    assert.deepEqual(ids(unknown), ['w3']);
  } finally {
    env.done();
  }
});

test('stretches: reply chain, neighbours and the followed conversation come with a hit, and the turn\'s own lines stay out', () => {
  const env = fixture();
  try {
    const minute = (n) => NOW - 3 * DAY + n * 60000;
    for (let i = 0; i < 12; i += 1) env.say({ native: `s${i}`, at: minute(i), text: i === 6 ? 'το σπιτι του δασκαλου' : `γραμμη ${i}`, replyTo: i === 6 ? 's1' : null });
    env.say({ native: 'later', at: minute(12) + 3 * 3600000, text: 'πολυ αργοτερα' });
    env.stem();
    const result = search(env.db, { ctx: group, plan: plan(['σπιτι']), now: NOW, settings: { ...dbSettings({}), recordContext: 2, followMessages: 3, followGapMinutes: 5 }, exclude: new Set(['s5']) });
    assert.equal(result.windows.length, 1);
    const [one] = result.windows;
    assert.deepEqual(one.messages.map((message) => message.id), ['s1', 's4', 's6', 's7', 's8', 's9', 's10', 's11']);
    assert.deepEqual([...one.hitIds], ['s6']);
    assert.equal(one.overlapsChat, true);
    assert.ok(!one.messages.some((message) => message.id === 'later'), 'a long silence ends the followed conversation');
    assert.equal(one.channelId, 'main');
  } finally {
    env.done();
  }
});

test('revisions: only the newest revision of a message is searched and shown, a deleted message is gone', () => {
  const env = fixture();
  try {
    env.say({ native: 'e1', at: NOW - DAY, text: 'παλιο σπιτι', revision: 1 });
    env.say({ native: 'e1', at: NOW - DAY, text: 'νεο δασκαλος', revision: 2 });
    env.say({ native: 'e2', at: NOW - DAY + 1000, text: 'σβησμενο σπιτι', place: OTHER });
    env.deleted('e2', NOW - DAY + 2000);
    env.db.prepare("UPDATE sources SET place_id = ? WHERE native_id = 'e2'").run(MAIN);
    env.stem();
    assert.deepEqual(ids(run(env, ['σπιτι'])), []);
    const now = run(env, ['δασκαλος']);
    assert.deepEqual(ids(now), ['e1']);
    assert.equal(now.windows[0].messages[0].editedAt !== null, true);
  } finally {
    env.done();
  }
});

test('scope: a DM line is never in a group result; the group is told a better match exists, without text or count', () => {
  const env = fixture();
  try {
    const secret = 'μυστικο σπιτι του δασκαλου';
    env.say({ native: 'g1', at: NOW - 2 * DAY, text: 'ενα σπιτι εδω', place: channelPlaceId('c1') });
    env.say({ native: 'dm1', at: NOW - DAY, text: secret, place: dmPlaceId(ALICE), scope: dmScope(personId(ALICE)) });
    env.say({ native: 'dm2', at: NOW - DAY, text: `${secret} ξανα`, place: dmPlaceId(ALICE), scope: dmScope(personId(ALICE)) });
    env.stem();
    const asking = { ...group, asker: [personId(ALICE)] };
    const result = run(env, ['σπιτι του δασκαλου'], {}, asking);
    assert.equal(result.hidden, true);
    assert.equal(run(env, ['σπιτι του δασκαλου']).hidden, false, 'a context with no asker is told nothing');
    assert.deepEqual(ids(result), [], 'the phrase is only in the DM; the lone word of the group does not match the phrase');
    const wide = run(env, ['σπιτι', 'δασκαλου'], {}, asking);
    assert.deepEqual(ids(wide), ['g1']);
    assert.equal(wide.hidden, true);
    const dump = JSON.stringify({ windows: wide.windows, hits: wide.hits, stats: wide.stats });
    assert.ok(!dump.includes('μυστικο') && !dump.includes('dm1') && !dump.includes('dm2'));
    assert.deepEqual(Object.keys(wide.stats).sort(), ['meaning', 'people', 'trigram', 'words']);
    assert.equal(wide.stats.words, 1, 'the DM lines are not counted');
    // The owner of the DM reads it in their DM, and sees no marker.
    const own = search(env.db, { ctx: dmContext(personId(ALICE)), plan: plan(['σπιτι του δασκαλου']), now: NOW });
    assert.deepEqual(ids(own).sort(), ['dm1', 'dm2']);
    assert.equal(own.hidden, false);
    // Someone else's DM and the internal context.
    const other = search(env.db, { ctx: dmContext(personId(BOB)), plan: plan(['σπιτι του δασκαλου']), now: NOW });
    assert.deepEqual(ids(other), []);
    assert.equal(other.hidden, false, 'only a group is told about a DM');
    const inside = search(env.db, { ctx: internalContext(), plan: plan(['σπιτι του δασκαλου']), now: NOW });
    assert.deepEqual(ids(inside).sort(), ['dm1', 'dm2']);
    assert.throws(() => search(env.db, { plan: plan(['σπιτι']), now: NOW }), /scope context/);
  } finally {
    env.done();
  }
});

test('scope: no marker when the group has the better match, and the meaning stream stays inside the scope too', () => {
  const env = fixture();
  try {
    env.say({ native: 'g1', at: NOW - 2 * DAY, text: 'σπιτι δασκαλου', place: channelPlaceId('c1') });
    env.say({ native: 'dm1', at: NOW - DAY, text: 'σπιτι', place: dmPlaceId(ALICE), scope: dmScope(personId(ALICE)) });
    env.say({ native: 'dm2', at: NOW - DAY, text: 'κανενα κοινο', place: dmPlaceId(ALICE), scope: dmScope(personId(ALICE)) });
    env.stem();
    env.vector('dm2', [1, 0, 0, 0], { scope: dmScope(personId(ALICE)) });
    const result = search(env.db, { ctx: group, plan: plan(['σπιτι', 'δασκαλου']), vector: [1, 0, 0, 0], now: NOW, settings: { ...dbSettings({}), gateShare: 0, minMeaning: 0 } });
    assert.deepEqual(ids(result), ['g1']);
    assert.equal(result.hidden, false, 'the group line matches more than the DM one');
    assert.equal(result.stats.meaning, 0, 'a DM vector is not scanned for a group');
  } finally {
    env.done();
  }
});

test('window: up and down from an anchor in time order, the anchor left out, edges reported', () => {
  const env = fixture();
  try {
    for (let i = 1; i <= 10; i += 1) env.say({ native: `w${i}`, at: NOW - (11 - i) * 60000, text: `γραμμη ${i}` });
    env.stem();
    const idsOf = (result) => result.windows.flatMap((one) => one.messages.map((message) => message.id));
    const up = window(env.db, { ctx: group, anchor: 'w5', move: 'up', messages: 3 });
    assert.deepEqual(idsOf(up), ['w2', 'w3', 'w4']);
    assert.equal(up.stopped, null);
    const down = window(env.db, { ctx: group, anchor: 'w5', move: 'down', messages: 3 });
    assert.deepEqual(idsOf(down), ['w6', 'w7', 'w8']);
    const top = window(env.db, { ctx: group, anchor: 'w2', move: 'up', messages: 5 });
    assert.deepEqual(idsOf(top), ['w1']);
    assert.equal(top.stopped, 'edge');
    const none = window(env.db, { ctx: group, anchor: 'w1', move: 'up', messages: 5 });
    assert.deepEqual(none.windows, []);
    assert.equal(none.stopped, 'edge');
    assert.equal(none.unknown, false);
    const bottom = window(env.db, { ctx: group, anchor: 'w9', move: 'down', messages: 5 });
    assert.deepEqual(idsOf(bottom), ['w10']);
    assert.equal(bottom.stopped, 'edge');
    // By source id, by minutes: the lines within two minutes before w5.
    const bySource = window(env.db, { ctx: group, anchor: messageSourceId('w5', 1, 'seen'), move: 'up', minutes: 2 });
    assert.deepEqual(idsOf(bySource), ['w3', 'w4']);
    // Both limits: the smaller wins.
    assert.deepEqual(idsOf(window(env.db, { ctx: group, anchor: 'w9', move: 'up', minutes: 5, messages: 2 })), ['w7', 'w8']);
    // An unknown anchor.
    assert.equal(window(env.db, { ctx: group, anchor: 'nope', move: 'up', messages: 2 }).unknown, true);
    assert.equal(window(env.db, { ctx: group, anchor: '', move: 'up', messages: 2 }).unknown, true);
    assert.throws(() => window(env.db, { anchor: 'w5', move: 'up' }), /scope context/);
  } finally {
    env.done();
  }
});

test('window: a line the context may not open ends the read there and is never counted or shown', () => {
  const env = fixture();
  try {
    for (let i = 1; i <= 8; i += 1) {
      const hiddenLine = i === 4;
      env.say({
        native: `h${i}`, at: NOW - (9 - i) * 60000, text: hiddenLine ? 'κρυφη γραμμη' : `γραμμη ${i}`,
        ...(hiddenLine ? { scope: dmScope(personId(ALICE)) } : {}),
      });
    }
    env.stem();
    const idsOf = (result) => result.windows.flatMap((one) => one.messages.map((message) => message.id));
    const up = window(env.db, { ctx: group, anchor: 'h6', move: 'up', messages: 5 });
    assert.deepEqual(idsOf(up), ['h5']);
    assert.equal(up.stopped, 'hidden');
    const down = window(env.db, { ctx: group, anchor: 'h2', move: 'down', messages: 5 });
    assert.deepEqual(idsOf(down), ['h3']);
    assert.equal(down.stopped, 'hidden');
    assert.ok(!JSON.stringify([up, down]).includes('κρυφη'));
    // The partner of that DM reads straight through.
    const through = window(env.db, { ctx: dmContext(personId(ALICE)), anchor: 'h6', move: 'up', messages: 5 });
    assert.deepEqual(idsOf(through), ['h1', 'h2', 'h3', 'h4', 'h5']);
    // A hidden anchor is unknown, as if it did not exist.
    assert.equal(window(env.db, { ctx: group, anchor: 'h4', move: 'up', messages: 2 }).unknown, true);
    // A hit's stretch stops at the hidden line too.
    const found = search(env.db, { ctx: group, plan: plan(['γραμμη']), now: NOW, limit: 1, settings: { ...dbSettings({}), recordContext: 3 } });
    assert.ok(!JSON.stringify(found.windows).includes('κρυφη'));
  } finally {
    env.done();
  }
});

test('quotes: windows become the stretches recall returns, with entries per line', () => {
  const env = fixture();
  try {
    env.account(ALICE, ['Αλίκη']);
    env.say({ native: 'q1', at: Date.parse('2026-10-20T10:00:00.000Z'), text: 'το σπιτι του δασκαλου' });
    env.say({ native: 'q2', at: Date.parse('2026-10-20T10:01:00.000Z'), text: 'ναι ακριβως', author: BOB });
    env.stem();
    const found = run(env, ['σπιτι']);
    const quotes = quotesOf(found.windows, { render: { labels, timezone: 'UTC', selfName: 'Ζ' }, stretchChars: 1500 });
    assert.equal(quotes.length, 1);
    assert.equal(quotes[0].channelId, 'main');
    assert.equal(quotes[0].startTs, Date.parse('2026-10-20T10:00:00.000Z'));
    assert.deepEqual(quotes[0].entries.map((entry) => entry.id), ['q1', 'q2']);
    assert.ok(quotes[0].lines.includes('Αλίκη') && quotes[0].lines.includes('το σπιτι του δασκαλου'));
    assert.deepEqual(quotesOf([], { render: {}, stretchChars: 1500 }), []);
  } finally {
    env.done();
  }
});

// ---------- the runner and the tool over the database ----------

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHIPPED = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const DISCORD = createDiscordInterface().capabilities;
const withHidden = { ...labels, skills: { ...labels.skills, tools: { ...labels.skills.tools, memory: { ...labels.skills.tools.memory, hidden: 'ΚΡΥΦΟ-ΣΗΜΑ' } } } };

/** A runner over a fake guild (#general c1, #secret c4 that @everyone cannot see) and the fixture database. */
function runner(env, { backend = 'db', memoryDb = true, open = true, meaning = false, embed = null } = {}) {
  const rest = [];
  const guild = { id: 'g1', members: { me: { id: 'self' } }, roles: { everyone: { id: 'g1' }, cache: new Map() }, channels: { cache: new Map() }, client: { rest: { get: async (route) => { rest.push(route); return route.endsWith('/members/search') ? [] : { total_results: 0, messages: [] }; } } } };
  const addChannel = (id, name, everyone) => {
    const channel = { id, name, guild, viewable: true, lastMessageId: null, isTextBased: () => true, isThread: () => false, permissionsFor: (target) => ({ has: () => everyone || target?.id === 'self' }), permissionOverwrites: { cache: new Map() }, messages: { fetch: async () => new Map() } };
    guild.channels.cache.set(id, channel);
    return channel;
  };
  const channel = addChannel('c1', 'general', true);
  addChannel('c4', 'secret', false);
  const config = structuredClone(SHIPPED);
  config.bot = { ...config.bot, timezone: 'UTC' };
  config.features = { ...config.features, memoryDb, meaningSearch: meaning, recall: true };
  config.recall = { ...config.recall, backend };
  config.models = { ...config.models, helpers: { ...config.models?.helpers, embedding: 'test/embedder' } };
  const data = {};
  const store = { state: { get data() { return data; }, markDirty() {} }, listUserProfiles: () => [] };
  const llmCalls = [];
  const llm = { capLeft: () => 100, complete: async (...call) => { llmCalls.push(call); return { text: '' }; } };
  const hot = { config, prompts: { 'recall-summary': 'x', labels: withHidden } };
  const recaller = createRecall({ discord: DISCORD, hot, store, llm, now: () => NOW, embed, memoryDb: { database: () => (open ? env.db : null) } });
  return { recaller, guild, channel, rest, hot, llmCalls, args: { guild, guildId: 'g1', channel, selfId: 'self', selfName: 'Ζωή', history: [], candidate: { id: 'q', content: 'το σπιτι' } } };
}

test('recall.run with backend db: the stretches come from the database, in scope and behind the pull rail, with no Discord request and no summary', async () => {
  const env = fixture();
  try {
    env.account(ALICE, ['Αλίκη']);
    env.say({ native: 'r1', at: NOW - 3 * DAY, text: 'το σπιτι του δασκαλου', place: channelPlaceId('c1') });
    env.say({ native: 'r2', at: NOW - 3 * DAY + 60000, text: 'ναι ηταν μεγαλο', place: channelPlaceId('c1') });
    env.say({ native: 'r3', at: NOW - 2 * DAY, text: 'κρυφο σπιτι', place: channelPlaceId('c4') });
    env.say({ native: 'r4', at: NOW - DAY, text: 'ιδιωτικο σπιτι', place: dmPlaceId(BOB), scope: dmScope(personId(BOB)) });
    env.stem();
    const s = runner(env);
    const found = await s.recaller.run({ ...s.args, candidate: { ...s.args.candidate, authorId: BOB }, server: { forms: ['σπιτι'], who: [], from: null, to: null }, quotes: true });
    assert.equal(found.outcome.kind, 'searched');
    assert.deepEqual(found.quotes.map((quote) => quote.channelName), ['general']);
    assert.deepEqual(found.quotes[0].entries.map((entry) => entry.id), ['r1', 'r2']);
    assert.ok(found.quotes[0].lines.includes('Αλίκη'));
    assert.ok(!JSON.stringify(found).includes('κρυφο') && !JSON.stringify(found).includes('ιδιωτικο'));
    assert.deepEqual(s.rest, [], 'no request to Discord');
    assert.equal(s.llmCalls.length, 0, 'no summary');
    // The DM line of the asker matched better than the group's: the marker, nothing else.
    assert.equal(found.hidden, true);
    const stranger = await s.recaller.run({ ...s.args, candidate: { ...s.args.candidate, authorId: ALICE }, server: { forms: ['σπιτι'], who: [], from: null, to: null }, quotes: true });
    assert.equal(stranger.hidden, false, 'the DM is another person\'s');
    // The channel she names is refused by the pull rail.
    const named = await s.recaller.run({ ...s.args, server: { forms: ['σπιτι'], who: [], from: null, to: null, channelId: 'c4' }, quotes: true });
    assert.equal(named.outcome.kind, 'not-visible');
    // The turn's own lines are left out.
    const seen = await s.recaller.run({ ...s.args, history: [{ id: 'r1', channelId: 'c1', ts: NOW, self: false, bot: false, authorName: 'x', content: 'y' }], server: { forms: ['σπιτι'], who: [], from: null, to: null }, quotes: true });
    assert.ok(!seen.quotes.some((quote) => quote.entries.some((entry) => entry.id === 'r1')));
  } finally {
    env.done();
  }
});

test('recall.run: the backend is read at the moment of use; discord, the switch off or no open database mean the old way', async () => {
  const env = fixture();
  try {
    env.say({ native: 'r1', at: NOW - DAY, text: 'το σπιτι', place: channelPlaceId('c1') });
    env.stem();
    for (const options of [{ backend: 'discord' }, { memoryDb: false }, { open: false }]) {
      const s = runner(env, options);
      const found = await s.recaller.run({ ...s.args, server: { forms: ['σπιτι'], who: [], from: null, to: null }, quotes: true });
      assert.ok(s.rest.length > 0, `the Discord search ran: ${JSON.stringify(options)}`);
      assert.deepEqual(found.quotes, []);
    }
    const s = runner(env, { backend: 'discord' });
    s.hot.config.recall.backend = 'db';
    const found = await s.recaller.run({ ...s.args, server: { forms: ['σπιτι'], who: [], from: null, to: null }, quotes: true });
    assert.equal(found.quotes.length, 1, 'switched live, no restart');
    assert.deepEqual(s.rest, []);
  } finally {
    env.done();
  }
});

test('recall.run with backend db: the question is embedded once for the meaning search, and a failed embedding leaves words only', async () => {
  const env = fixture();
  try {
    env.say({ native: 'r1', at: NOW - DAY, text: 'ασχετο κειμενο', place: channelPlaceId('c1') });
    env.say({ native: 'r2', at: NOW - 2 * DAY, text: 'ακομα ενα', place: channelPlaceId('c1') });
    env.stem();
    env.vector('r1', [1, 0, 0, 0]);
    const calls = [];
    const good = runner(env, { meaning: true, embed: async (texts, options) => { calls.push([texts, options.purpose]); return [Float32Array.from([1, 0, 0, 0])]; } });
    const found = await good.recaller.run({ ...good.args, server: { forms: ['τιποτα'], who: [], from: null, to: null }, quotes: true });
    assert.deepEqual(calls, [[['το σπιτι'], 'recall-query']]);
    assert.deepEqual(found.quotes.flatMap((quote) => quote.entries.map((entry) => entry.id)).sort(), ['r1', 'r2'], 'the meaning hit r1 and its neighbour');
    assert.equal(found.outcome.degraded, false);
    const bad = runner(env, { meaning: true, embed: async () => { throw new Error('down'); } });
    const words = await bad.recaller.run({ ...bad.args, server: { forms: ['ασχετο'], who: [], from: null, to: null }, quotes: true });
    assert.equal(words.outcome.degraded, true);
    assert.equal(words.quotes.length, 1);
  } finally {
    env.done();
  }
});

test('recall.window: reads up or down from a message through the same rails; an anchor it cannot open is unknown', async () => {
  const env = fixture();
  try {
    for (let i = 1; i <= 5; i += 1) env.say({ native: `x${i}`, at: NOW - (6 - i) * 60000, text: `γραμμη ${i}`, place: channelPlaceId('c1') });
    env.say({ native: 'y1', at: NOW - 60000, text: 'αλλου', place: channelPlaceId('c4') });
    env.stem();
    const s = runner(env);
    const down = await s.recaller.window({ ...s.args, anchor: 'x2', move: 'down', messages: 2 });
    assert.deepEqual(down.quotes[0].entries.map((entry) => entry.id), ['x3', 'x4']);
    assert.equal(down.quotes[0].channelName, 'general');
    assert.equal((await s.recaller.window({ ...s.args, anchor: 'y1', move: 'up', messages: 2 })).outcome.kind, 'unknown-anchor', 'a place the pull rail refuses');
    assert.equal((await s.recaller.window({ ...s.args, anchor: 'zzz', move: 'up' })).outcome.kind, 'unknown-anchor');
    const off = runner(env, { backend: 'discord' });
    assert.equal((await off.recaller.window({ ...off.args, anchor: 'x2' })).outcome.kind, 'not-configured');
  } finally {
    env.done();
  }
});

test('memory.search: the hidden marker is one label line, with or without stretches; an anchor makes the call a window read', async () => {
  const quote = { channelId: 'c1', channelName: 'general', startTs: Date.UTC(2026, 9, 20), lines: '[10:00] Αλίκη: γεια' };
  assert.ok(memorySearchText([quote], { labels: withHidden, hidden: true }).endsWith('ΚΡΥΦΟ-ΣΗΜΑ'));
  assert.equal(memorySearchText([quote], { labels: withHidden }).includes('ΚΡΥΦΟ-ΣΗΜΑ'), false);
  const none = memorySearchText([], { labels: withHidden, hidden: true });
  assert.ok(none.includes(withHidden.skills.tools.memory.none) && none.endsWith('ΚΡΥΦΟ-ΣΗΜΑ'));
  assert.equal(memorySearchText([], { labels: { skills: { tools: { memory: { none: 'N' } } } }, hidden: true }), 'N', 'a missing label adds nothing');

  const seen = [];
  const recall = {
    available: () => true,
    run: async (call) => { seen.push(['run', call.server]); return { quotes: [quote], hidden: true, outcome: { kind: 'searched', degraded: false, failed: 0, total: 1 } }; },
    window: async (call) => { seen.push(['window', call.anchor, call.move, call.messages, call.minutes]); return call.anchor === 'bad' ? { quotes: [], outcome: { kind: 'unknown-anchor' } } : { quotes: [quote], outcome: { kind: 'searched' } }; },
  };
  const base = { recall, store: { listUserProfiles: () => [] }, config: { ...SHIPPED, bot: { ...SHIPPED.bot, timezone: 'UTC' } }, labels: withHidden, guild: {}, guildId: 'g1', channel: { guild: {} }, now: NOW };
  const searched = await runMemorySearch({ ...base, args: { question: 'το σπιτι του δασκαλου' } });
  assert.equal(searched.status, 'ok');
  assert.ok(searched.data.text.endsWith('ΚΡΥΦΟ-ΣΗΜΑ'));
  const read = await runMemorySearch({ ...base, args: { anchor: 'x2', move: 'down', messages: 3, minutes: 0 } });
  assert.deepEqual([read.status, seen.at(-1)], ['ok', ['window', 'x2', 'down', 3, null]]);
  assert.ok(!read.data.text.includes('ΚΡΥΦΟ-ΣΗΜΑ'));
  assert.deepEqual(seen.filter(([kind]) => kind === 'run').length, 1, 'the window read did not search');
  const up = await runMemorySearch({ ...base, args: { anchor: 'x2' } });
  assert.deepEqual([up.status, seen.at(-1)], ['ok', ['window', 'x2', 'up', null, null]]);
  assert.deepEqual(await runMemorySearch({ ...base, args: { anchor: 'bad' } }), { status: 'invalid', code: 'unknown-message', reason: 'args.anchor' });
  assert.equal((await runMemorySearch({ ...base, recall: { available: () => true, run: recall.run }, args: { anchor: 'x2' } })).status, 'not_configured');
});

test('recall-eval: --backend db goes with --db <file> and only with it, and the file must exist', async () => {
  const { main } = await import('../tools/recall-eval.mjs');
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'memdb-eval-'));
  try {
    const data = path.join(root, 'data');
    fs.mkdirSync(path.join(data, 'guilds', '300000000000000001'), { recursive: true });
    const questions = path.join(root, 'questions.json');
    fs.writeFileSync(questions, JSON.stringify([{ id: 'q1', channelId: '100000000000000001', askerId: '200000000000000001', question: 'πού είναι το κουνέλι;', expected: ['300000000000000001'], kind: 'exact' }]));
    const base = [questions, '--data', data, '--dry'];
    await assert.rejects(main([...base, '--backend', 'db']), /goes with --db/);
    await assert.rejects(main([...base, '--db', path.join(root, 'x.db')]), /goes with --db/);
    await assert.rejects(main([...base, '--backend', 'sqlite']), /db, json or discord/);
    await assert.rejects(main([...base, '--backend', 'db', '--db', path.join(root, 'missing.db')]), /no database/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('words: a wide pool is ranked by the distinct terms a line holds; relevance beats recency unless the plan names a date', () => {
  const env = fixture();
  try {
    for (let i = 0; i < 12; i += 1) env.say({ native: `w-new-${i}`, at: NOW - (1 + i / 100) * DAY, text: 'σπιτι σπιτι σπιτι', place: channelPlaceId(`n${i}`) });
    env.say({ native: 'w-old', at: NOW - 60 * DAY, text: 'το σπιτι, ο δασκαλος και το αυτοκινητο', place: channelPlaceId('old') });
    env.stem();
    const settings = { ...dbSettings({}), gateShare: 0, candidates: 3, wordPool: 100 };
    const forms = ['σπιτι', 'δασκαλος', 'αυτοκινητο'];
    const found = run(env, forms, { settings });
    assert.equal(ids(found)[0], 'w-old', 'three distinct terms beat a recent line of one');
    assert.equal(found.hits[0].terms, 3);
    const one = run(env, forms, { settings, limit: 1 });
    assert.ok(one.windows[0].messages.some((message) => message.id === 'w-old'), 'the one window kept is the best-ranked hit\'s');
    const aimed = run(env, forms, { settings, plan: { from: NOW - 3 * DAY, to: NOW } });
    assert.ok(ids(aimed).every((id) => id.startsWith('w-new-')), 'a named date ranks toward it');
  } finally {
    env.done();
  }
});

test('gate: a hit holding the most distinct terms passes even under the share of the best fused score', async () => {
  const { passGate } = await import('../src/memory/db/recall.js');
  const visible = [{ id: 'a', score: 0.032 }, { id: 'b', score: 0.016 }, { id: 'c', score: 0.012 }, { id: 'd', score: 0.011 }];
  const held = { a: 1, b: 3, c: 1, d: 0 };
  const kept = passGate(visible, (e) => held[e.id], 0.5).map((e) => e.id);
  assert.deepEqual(kept, ['a', 'b']);
  const single = passGate(visible, (e) => ({ a: 1, b: 1, c: 1, d: 0 })[e.id], 0.5).map((e) => e.id);
  assert.deepEqual(single, ['a', 'b'], 'one term is no reason to pass the gate');
});

// ---------- the place rule and the order of candidates (fix 2 of the store review) ----------

/** A db whose statements are recorded with every row they return, to prove which text was ever loaded. */
function recording(db) {
  const rows = [];
  const wrap = (statement) => ({
    all: (...args) => { const out = statement.all(...args); rows.push(...out); return out; },
    get: (...args) => { const out = statement.get(...args); if (out) rows.push(out); return out; },
    *iterate(...args) { for (const row of statement.iterate(...args)) { rows.push(row); yield row; } },
  });
  return { rows, db: new Proxy(db, { get: (target, key) => (key === 'prepare' ? (sql) => wrap(target.prepare(sql)) : Reflect.get(target, key)) }) };
}

test('place rule: a refused place and a DM never crowd an allowed line out of the candidates', () => {
  const env = fixture();
  try {
    for (let i = 0; i < 6; i += 1) {
      env.say({ native: `refused-${i}`, at: NOW - DAY, text: 'σπιτι σπιτι σπιτι δασκαλου', place: channelPlaceId('secret') });
      env.say({ native: `dm-${i}`, at: NOW - DAY, text: 'σπιτι σπιτι σπιτι δασκαλου', place: dmPlaceId(ALICE), scope: dmScope(personId(ALICE)) });
    }
    env.say({ native: 'open', at: NOW - 5 * DAY, text: 'ενα σπιτι', place: channelPlaceId('c1') });
    env.stem();
    const settings = { ...dbSettings({}), gateShare: 0, candidates: 3, wordPool: 3 };
    const allowPlace = (placeId) => placeId !== channelPlaceId('secret') && !String(placeId).startsWith('discord:dm:');
    const found = run(env, ['σπιτι'], { settings, allowPlace });
    assert.deepEqual(ids(found), ['open'], 'the word stream picked among the allowed places only');
    assert.equal(found.stats.words, 1);
    // The meaning stream: the refused lines are closer to the question than the allowed one.
    for (let i = 0; i < 6; i += 1) env.vector(`refused-${i}`, [1, 0, 0, 0]);
    env.vector('open', [0.8, 0.6, 0, 0]);
    const meaning = run(env, ['ανυπαρκτο'], { settings: { ...settings, minMeaning: 0 }, allowPlace, vector: [1, 0, 0, 0] });
    assert.deepEqual(ids(meaning), ['open']);
    assert.equal(meaning.stats.meaning, 1);
    // The people stream.
    env.account(CAROL, ['Μπομπ']);
    for (let i = 0; i < 6; i += 1) env.say({ native: `bob-secret-${i}`, at: NOW - 60000 * i, text: `ξεχωριστο ${i}`, place: channelPlaceId('secret'), author: CAROL });
    env.say({ native: 'bob-open', at: NOW - 40 * DAY, text: 'κατι αλλο', place: channelPlaceId('c1'), author: CAROL });
    const talk = run(env, [], { settings, allowPlace, plan: { who: ['Μπομπ'] } });
    assert.deepEqual(ids(talk), ['bob-open']);
  } finally {
    env.done();
  }
});

test('meaning: vectors of another model, an older revision with changed text and a deleted line are not matched', () => {
  const env = fixture();
  try {
    env.say({ native: 'a', at: NOW - DAY, text: 'ενα κειμενο' });
    env.say({ native: 'b', at: NOW - DAY, text: 'παλιο κειμενο', revision: 1 });
    env.say({ native: 'b', at: NOW - DAY + 1000, text: 'νεο κειμενο', revision: 2 });
    env.say({ native: 'c', at: NOW - DAY, text: 'ιδιο κειμενο', revision: 1 });
    env.say({ native: 'c', at: NOW - DAY + 1000, text: 'ιδιο κειμενο', revision: 2 });
    env.say({ native: 'd', at: NOW - DAY, text: 'διαγραμμενο' });
    env.deleted('d', NOW);
    env.stem();
    for (const native of ['a', 'b', 'c', 'd']) env.vector(native, [1, 0, 0, 0]);
    env.db.prepare("UPDATE vectors SET model = 'other/embedder' WHERE item_id = 'a'").run();
    const settings = { ...dbSettings({}), gateShare: 0, minMeaning: 0 };
    const found = run(env, ['ανυπαρκτο'], { settings, vector: [1, 0, 0, 0], model: 'test/embedder' });
    assert.deepEqual(ids(found).sort(), ['c'], 'a: another model; b: its vector is of the old text; d: deleted');
    const any = run(env, ['ανυπαρκτο'], { settings, vector: [1, 0, 0, 0] });
    assert.deepEqual(ids(any).sort(), ['a', 'c'], 'no model asked: matched by dims');
    env.db.prepare('UPDATE vectors SET model = NULL').run();
    assert.deepEqual(ids(run(env, ['ανυπαρκτο'], { settings, vector: [1, 0, 0, 0], model: 'test/embedder' })).sort(), ['a', 'c'], 'a row with no model is taken by its dims');
  } finally {
    env.done();
  }
});

test('hidden marker: only the asker\'s own DM of this interface; another person\'s DM, another interface and internal rows give none', () => {
  const env = fixture();
  try {
    env.say({ native: 'own', at: NOW - DAY, text: 'σπιτι δασκαλου μυστικο', place: dmPlaceId(ALICE), scope: dmScope(personId(ALICE)) });
    env.say({ native: 'foreign', at: NOW - DAY, text: 'βιβλιο κοσμου μυστικο', place: dmPlaceId(BOB), scope: dmScope(personId(BOB)) });
    env.say({ native: 'abroad', at: NOW - DAY, text: 'παιδι νερου μυστικο', place: 'other:dm:x', scope: dmScope(personId(ALICE), 'other') });
    env.say({ native: 'inner', at: NOW - DAY, text: 'δρομος καιρου μυστικο', place: dmPlaceId(ALICE), scope: { scope_kind: 'internal', scope_iface: null, scope_dm: null } });
    env.stem();
    const asked = (forms, asker) => run(env, forms, {}, { ...group, asker }).hidden;
    assert.equal(asked(['σπιτι δασκαλου'], [personId(ALICE)]), true);
    assert.equal(asked(['σπιτι δασκαλου'], personId(ALICE)), true, 'one id or a list');
    assert.equal(asked(['σπιτι δασκαλου'], [personId(BOB)]), false, 'the DM is not theirs');
    assert.equal(asked(['σπιτι δασκαλου'], [personId(BOB), personId(ALICE)]), true, 'any of the linked persons');
    assert.equal(asked(['βιβλιο κοσμου'], [personId(ALICE)]), false, 'another person\'s DM');
    assert.equal(asked(['παιδι νερου'], [personId(ALICE)]), false, 'another interface\'s DM');
    assert.equal(asked(['δρομος καιρου'], [personId(ALICE)]), false, 'an internal row');
    assert.equal(asked(['σπιτι δασκαλου'], []), false);
  } finally {
    env.done();
  }
});

test('window: the text of a line the context may not open is never loaded, at a boundary, an anchor or a reply parent', () => {
  const env = fixture();
  try {
    for (let i = 1; i <= 8; i += 1) {
      const hiddenLine = i === 4;
      env.say({
        native: `h${i}`, at: NOW - (9 - i) * 60000, text: hiddenLine ? 'κρυφη γραμμη ΜΥΣΤΙΚΟ' : `γραμμη ${i}`,
        ...(hiddenLine ? { scope: dmScope(personId(ALICE)) } : {}),
        ...(i === 5 ? { replyTo: 'h4' } : {}),
      });
    }
    env.stem();
    const seen = recording(env.db);
    const leaked = () => JSON.stringify(seen.rows).includes('ΜΥΣΤΙΚΟ');
    window(seen.db, { ctx: group, anchor: 'h6', move: 'up', messages: 5 });
    window(seen.db, { ctx: group, anchor: 'h2', move: 'down', messages: 5 });
    window(seen.db, { ctx: group, anchor: 'h4', move: 'up', messages: 2 });
    window(seen.db, { ctx: group, anchor: messageSourceId('h4', 1, 'seen'), move: 'down', messages: 2 });
    assert.equal(leaked(), false, 'windows');
    search(seen.db, { ctx: group, plan: plan(['γραμμη 5']), now: NOW, settings: { ...dbSettings({}), recordContext: 3 } });
    assert.equal(leaked(), false, 'a hit\'s stretch, its reply parent and its neighbours');
    // Control: the partner of that DM does read it, so the recorder sees the text.
    window(seen.db, { ctx: dmContext(personId(ALICE)), anchor: 'h6', move: 'up', messages: 5 });
    assert.equal(leaked(), true);
  } finally {
    env.done();
  }
});

test('names: an alias claim resolves only through verified accounts and only when the context may see the claim', () => {
  const env = fixture();
  try {
    env.account(ALICE, ['Αλίκη']);
    env.account(CAROL, ['Μπομπ']);
    env.say({ native: 'a1', at: NOW - DAY, text: 'γεια απο την Αλικη', author: ALICE });
    env.say({ native: 'b1', at: NOW - DAY, text: 'γεια απο τον Μπομπ', author: CAROL });
    env.stem();
    const claim = (id, text, scope, subject) => env.db.prepare(`INSERT INTO claims (id, subject_kind, subject_id, kind, text, scope_kind, scope_iface, scope_dm)
      VALUES (?, 'person', ?, 'alias', ?, ?, ?, ?)`).run(id, subject, text, scope.scope_kind, scope.scope_iface, scope.scope_dm);
    claim('c1', 'Λικα', groupScope(), personId(ALICE));
    claim('c2', 'Μπομπακι', dmScope(personId(ALICE)), personId(CAROL));
    const who = (name, ctx = group) => ids(search(env.db, { ctx, plan: plan([], { who: [name] }), now: NOW }));
    assert.deepEqual(who('Λικα'), ['a1']);
    assert.deepEqual(who('Μπομπακι'), [], 'a claim of a DM is no alias for the group');
    assert.deepEqual(who('Μπομπακι', dmContext(personId(ALICE))), ['b1']);
    env.db.prepare("UPDATE accounts SET link = 'pending' WHERE id = ?").run(`discord:${ALICE}`);
    assert.deepEqual(who('Λικα'), [], 'an unverified link resolves nothing');
    assert.deepEqual(who('Αλίκη'), ['a1'], 'the account\'s own name still does');
  } finally {
    env.done();
  }
});
