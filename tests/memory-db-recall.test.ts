// Recall over the memory database (src/memory/db/recall.ts) and the stems the unit writes fill (src/memory/db/stems.ts), on
// synthetic Greek and accented Latin text: inflected forms, phrases, the trigram fallback, fusion, date ranking, scope
// filtering with the hidden marker, and window reads at the edges and across a hidden line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRecall } from '../src/behavior/recall-run.ts';
import { snapshotOf } from '../src/behavior/snapshot.ts';
import { channel as channelInfo, privateChannel } from './fixtures/reads-rig.ts';
import { memorySearchText, runMemorySearch } from '../src/tools/tools.ts';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { search, window, quotesOf, dbSettings } from '../src/memory/db/recall.ts';
import { loadStemmer, stemsOf } from '../src/memory/db/stems.ts';
import { seedUnits } from './fixtures/memory-db/seed.ts';
import { insertRows } from '../src/memory/db/rows.ts';
import { fillEnvAudiences } from './fixtures/memory-db/audiences.ts';
import { channelPlaceId, dmPlaceId, messageSourceId, personId } from '../src/memory/db/ids.ts';
import { dmContext, dmScope, groupContext, groupScope, internalContext } from '../src/memory/db/scope.ts';
import { dmOfMember, dmSpecOf, fixture, storedDmOf, storedPersonOf } from './fixtures/memory-db-recall.ts';
import { labels } from './fixtures/labels.ts';
import { buildDataDir, guildDir, MEMBER, CHANNEL } from './fixtures/memory-db/datadir.ts';
import { dbOf, type Db, type Statement } from '../src/memory/db/types.ts';

// The runner answers more than its types name (the quotes, the hidden marker and the outcome the tests read), so it is
// read through the shape the tests use; the fake reads of the interface carry only the calls a search makes.
type RecallInput = Parameters<typeof createRecall>[0];
const asReads = (reads: object) => reads as RecallInput['reads'];
const asRecall = (input: (Omit<RecallInput, 'reads'> & { reads: RecallInput['reads'] }) | object) =>
  createRecall(input as RecallInput) as unknown as {
    run(args: Record<string, unknown>): Promise<Found>;
    window(args: Record<string, unknown>): Promise<Found>;
    prefetch(args: Record<string, unknown>): Promise<{ status?: string } | null>;
  };

type Found = {
  outcome: { kind: string; degraded?: boolean };
  quotes: Array<{
    channelName: string;
    lines: string;
    entries: Array<{
      id: string;
      message: { authorName: string; attachments: Array<{ id: string; kind: string; name: string }> };
    }>;
  }>;
  hidden: boolean;
};

const DAY = 86400000;
const NOW = Date.parse('2026-10-24T12:00:00.000Z');
const MAIN = channelPlaceId('discord', 'main');
const OTHER = channelPlaceId('discord', 'other');
const ALICE = 'u-alice';
const BOB = 'u-bob';
const CAROL = 'u-carol';
const group = groupContext('discord');

const plan = (forms: Array<string>, extra: Record<string, unknown> = {}) => ({
  forms,
  who: [],
  from: null,
  to: null,
  ...extra,
});
const ids = (result: { hits: Array<{ messageId: unknown }> }) => result.hits.map((hit) => hit.messageId);
const run = (
  env: ReturnType<typeof fixture>,
  forms: Array<string>,
  { plan: given = {}, ...rest }: { plan?: Record<string, unknown>; [key: string]: unknown } = {},
  ctx = group
) => search(env.db, { ctx, plan: plan(forms, given), now: NOW, ...rest });

test('stems: the unit writes fill them, learns the endings from the database text and stamps again only what changed', () => {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'memdb-stems-'));
  const data = path.join(root, 'data');
  fs.mkdirSync(data);
  buildDataDir(data);
  const handle = openMemoryDb(path.join(root, 'memory.db'));
  try {
    const first = seedUnits(handle, data);
    assert.equal(first.errors, 0);
    const db = dbOf(handle);
    const empty = db.prepare('SELECT COUNT(*) AS n FROM sources WHERE text IS NOT NULL AND stems IS NULL').get()!.n;
    assert.equal(empty, 0, 'every row with text has stems');
    const row = db.prepare("SELECT text, stems FROM sources WHERE text LIKE '%café at noon%'").get()!;
    assert.equal(row.stems, 'a cafe at noon', 'folded, one key per word');
    assert.ok(db.prepare("SELECT value FROM meta WHERE key = 'stemmer'").get(), 'the learned stemmer is kept in meta');
    // The FTS table reads the stems column.
    assert.equal(
      db.prepare('SELECT COUNT(*) AS n FROM sources_fts WHERE sources_fts MATCH \'{stems} : "cafe"\'').get()!.n,
      1
    );
    // A changed text loses its stems and gets new ones; an unchanged row keeps its own.
    db.prepare("UPDATE sources SET stems = 'kept' WHERE text = 'Καλημέρα'").run();
    const again = seedUnits(handle, data);
    assert.equal(again.errors, 0);
    assert.equal(
      db.prepare("SELECT stems FROM sources WHERE text = 'Καλημέρα'").get()!.stems,
      'kept',
      'a write that changed nothing stems nothing'
    );
    const file = path.join(guildDir(data), 'record', '2026-10', '2026-10-20.jsonl');
    const lines = fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    lines.push({ ...lines[0], id: 'r-new', messageId: '400000000000000077', text: 'ένα νέο μήνυμα' });
    fs.writeFileSync(file, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
    seedUnits(handle, data);
    assert.equal(
      db.prepare("SELECT stems FROM sources WHERE native_id = '400000000000000077'").get()!.stems,
      'ενα νεο μηνυμα'
    );
    assert.equal(db.prepare("SELECT stems FROM sources WHERE text = 'Καλημέρα'").get()!.stems, 'kept');
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
    assert.equal(
      env.db.prepare("SELECT stems FROM sources WHERE native_id = 'a1'").get()!.stems,
      stemsOf(stem, 'ο δασκαλος του σπιτου')
    );
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
    env.say({
      native: 'p3',
      at: NOW - 3 * DAY,
      text: 'ένα σπιτι και ένας δασκαλος',
      place: channelPlaceId('discord', 'third'),
    });
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
    assert.deepEqual(
      whole.hits.map((hit) => hit.streams),
      [['words']]
    );
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
    env.say({ native: 'f-words', at, text: 'το σπιτι του δασκαλου', place: channelPlaceId('discord', 'c1') });
    env.say({ native: 'f-meaning', at, text: 'τιποτα κοινο', place: channelPlaceId('discord', 'c2') });
    env.say({ native: 'f-both', at, text: 'ο δασκαλος και το σπιτι', place: channelPlaceId('discord', 'c3') });
    env.say({ native: 'f-far', at, text: 'ασχετο κειμενο', place: channelPlaceId('discord', 'c4') });
    env.stem();
    env.vector('f-meaning', [1, 0, 0, 0]);
    env.vector('f-both', [0.9, 0.3, 0, 0]);
    env.vector('f-far', [0, 0, 1, 0]);
    const found = search(env.db, {
      ctx: group,
      plan: plan(['σπιτι', 'δασκαλου']),
      vector: [1, 0, 0, 0],
      now: NOW,
      settings: { ...dbSettings({})!, gateShare: 0, minMeaning: 0.5 },
    });
    assert.deepEqual(ids(found), ['f-both', 'f-words', 'f-meaning']);
    const byId = new Map(found.hits.map((hit) => [hit.messageId, hit]));
    assert.deepEqual(byId.get('f-both')!.streams, ['words', 'meaning']);
    assert.deepEqual(byId.get('f-words')!.streams, ['words']);
    assert.deepEqual(byId.get('f-meaning')!.streams, ['meaning']);
    assert.ok(byId.get('f-both')!.score > byId.get('f-words')!.score);
    assert.ok(byId.get('f-both')!.cosine! > 0.9 && byId.get('f-words')!.cosine === null);
    assert.equal(found.stats.meaning, 2, 'the line under the cosine floor is no meaning hit');
  } finally {
    env.done();
  }
});

test('gate: a hit far below the best is dropped', () => {
  const env = fixture();
  try {
    const at = NOW - DAY;
    env.say({ native: 'g1', at, text: 'σπιτι', place: channelPlaceId('discord', 'c1') });
    env.say({ native: 'g2', at, text: 'ενα ασχετο μηνυμα', place: channelPlaceId('discord', 'c2') });
    env.stem();
    env.vector('g1', [1, 0, 0, 0]);
    env.vector('g2', [0.6, 0.8, 0, 0]);
    const loose = search(env.db, {
      ctx: group,
      plan: plan(['σπιτι']),
      vector: [1, 0, 0, 0],
      now: NOW,
      settings: { ...dbSettings({})!, gateShare: 0, minMeaning: 0 },
    });
    assert.deepEqual(ids(loose).sort(), ['g1', 'g2']);
    const strict = search(env.db, {
      ctx: group,
      plan: plan(['σπιτι']),
      vector: [1, 0, 0, 0],
      now: NOW,
      settings: { ...dbSettings({})!, gateShare: 0.9, minMeaning: 0 },
    });
    assert.deepEqual(ids(strict), ['g1']);
  } finally {
    env.done();
  }
});

test('date ranking: among relevant lines the nearest to the asked range comes first, else the newest', () => {
  const env = fixture();
  try {
    const day = (n: number) => NOW - n * DAY;
    env.say({ native: 'd-old', at: day(30), text: 'το σπιτι', place: channelPlaceId('discord', 'c1') });
    env.say({ native: 'd-mid', at: day(15), text: 'το σπιτι', place: channelPlaceId('discord', 'c2') });
    env.say({ native: 'd-new', at: day(1), text: 'το σπιτι', place: channelPlaceId('discord', 'c3') });
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
    env.say({
      native: 'w1',
      at: NOW - 2 * DAY,
      text: 'καλημερα σε ολους',
      author: ALICE,
      place: channelPlaceId('discord', 'c1'),
    });
    env.say({ native: 'w2', at: NOW - DAY, text: 'καλησπερα', author: BOB, place: channelPlaceId('discord', 'c2') });
    env.say({ native: 'w3', at: NOW - DAY, text: 'ο Νικος ηρθε', author: BOB, place: channelPlaceId('discord', 'c3') });
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

test("stretches: reply chain, neighbours and the followed chat come with a hit, and the turn's own lines stay out", () => {
  const env = fixture();
  try {
    const minute = (n: number) => NOW - 3 * DAY + n * 60000;
    for (let i = 0; i < 12; i += 1)
      env.say({
        native: `s${i}`,
        at: minute(i),
        text: i === 6 ? 'το σπιτι του δασκαλου' : `γραμμη ${i}`,
        replyTo: i === 6 ? 's1' : null,
      });
    env.say({ native: 'later', at: minute(12) + 3 * 3600000, text: 'πολυ αργοτερα' });
    env.stem();
    const result = search(env.db, {
      ctx: group,
      plan: plan(['σπιτι']),
      now: NOW,
      settings: { ...dbSettings({})!, recordContext: 2, followMessages: 3, followGapMinutes: 5 },
      exclude: new Set(['s5']),
    });
    assert.equal(result.windows.length, 1);
    const [one] = result.windows;
    assert.deepEqual(
      one.messages.map((message) => message.id),
      ['s1', 's4', 's6', 's7', 's8', 's9', 's10', 's11']
    );
    assert.deepEqual([...one.hitIds], ['s6']);
    assert.equal(one.overlapsChat, true);
    assert.ok(!one.messages.some((message) => message.id === 'later'), 'a long silence ends the followed chat');
    assert.equal(one.placeId, 'main');
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
    env.say({ native: 'g1', at: NOW - 2 * DAY, text: 'ενα σπιτι εδω', place: channelPlaceId('discord', 'c1') });
    env.say({
      native: 'dm1',
      at: NOW - DAY,
      text: secret,
      place: dmPlaceId('discord', ALICE),
      scope: dmScope(personId('discord', ALICE), 'discord'),
    });
    env.say({
      native: 'dm2',
      at: NOW - DAY,
      text: `${secret} ξανα`,
      place: dmPlaceId('discord', ALICE),
      scope: dmScope(personId('discord', ALICE), 'discord'),
    });
    env.stem();
    const asking = { ...group, asker: [personId('discord', ALICE)] };
    const result = run(env, ['σπιτι του δασκαλου'], {}, asking);
    assert.equal(result.hidden, true);
    assert.equal(run(env, ['σπιτι του δασκαλου']).hidden, false, 'a context with no asker is told nothing');
    assert.deepEqual(
      ids(result),
      [],
      'the phrase is only in the DM; the lone word of the group does not match the phrase'
    );
    const wide = run(env, ['σπιτι', 'δασκαλου'], {}, asking);
    assert.deepEqual(ids(wide), ['g1']);
    assert.equal(wide.hidden, true);
    const dump = JSON.stringify({ windows: wide.windows, hits: wide.hits, stats: wide.stats });
    assert.ok(!dump.includes('μυστικο') && !dump.includes('dm1') && !dump.includes('dm2'));
    assert.deepEqual(Object.keys(wide.stats).sort(), ['meaning', 'people', 'trigram', 'words']);
    assert.equal(wide.stats.words, 1, 'the DM lines are not counted');
    // The owner of the DM reads it in their DM, and sees no marker.
    const own = search(env.db, {
      ctx: dmOfMember(ALICE),
      plan: plan(['σπιτι του δασκαλου']),
      now: NOW,
    });
    assert.deepEqual(ids(own).sort(), ['dm1', 'dm2']);
    assert.equal(own.hidden, false);
    // Someone else's DM and the internal context.
    const other = search(env.db, {
      ctx: dmOfMember(BOB),
      plan: plan(['σπιτι του δασκαλου']),
      now: NOW,
    });
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
    env.say({ native: 'g1', at: NOW - 2 * DAY, text: 'σπιτι δασκαλου', place: channelPlaceId('discord', 'c1') });
    env.say({
      native: 'dm1',
      at: NOW - DAY,
      text: 'σπιτι',
      place: dmPlaceId('discord', ALICE),
      scope: dmScope(personId('discord', ALICE), 'discord'),
    });
    env.say({
      native: 'dm2',
      at: NOW - DAY,
      text: 'κανενα κοινο',
      place: dmPlaceId('discord', ALICE),
      scope: dmScope(personId('discord', ALICE), 'discord'),
    });
    env.stem();
    env.vector('dm2', [1, 0, 0, 0], { scope: dmScope(personId('discord', ALICE), 'discord') });
    const result = search(env.db, {
      ctx: group,
      plan: plan(['σπιτι', 'δασκαλου']),
      vector: [1, 0, 0, 0],
      now: NOW,
      settings: { ...dbSettings({})!, gateShare: 0, minMeaning: 0 },
    });
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
    const idsOf = (result: { windows: Array<{ messages: Array<{ id: unknown }> }> }) =>
      result.windows.flatMap((one) => one.messages.map((message) => message.id));
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
    const bySource = window(env.db, {
      ctx: group,
      anchor: messageSourceId('discord', 'w5', 1, 'seen'),
      move: 'up',
      minutes: 2,
    });
    assert.deepEqual(idsOf(bySource), ['w3', 'w4']);
    // Both limits: the smaller wins.
    assert.deepEqual(idsOf(window(env.db, { ctx: group, anchor: 'w9', move: 'up', minutes: 5, messages: 2 })), [
      'w7',
      'w8',
    ]);
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
        native: `h${i}`,
        at: NOW - (9 - i) * 60000,
        text: hiddenLine ? 'κρυφη γραμμη' : `γραμμη ${i}`,
        ...(hiddenLine ? { scope: dmScope(personId('discord', ALICE), 'discord') } : {}),
      });
    }
    env.stem();
    const idsOf = (result: { windows: Array<{ messages: Array<{ id: unknown }> }> }) =>
      result.windows.flatMap((one) => one.messages.map((message) => message.id));
    const up = window(env.db, { ctx: group, anchor: 'h6', move: 'up', messages: 5 });
    assert.deepEqual(idsOf(up), ['h5']);
    assert.equal(up.stopped, 'hidden');
    const down = window(env.db, { ctx: group, anchor: 'h2', move: 'down', messages: 5 });
    assert.deepEqual(idsOf(down), ['h3']);
    assert.equal(down.stopped, 'hidden');
    assert.ok(!JSON.stringify([up, down]).includes('κρυφη'));
    // The partner of that DM reads straight through.
    const through = window(env.db, {
      ctx: dmOfMember(ALICE),
      anchor: 'h6',
      move: 'up',
      messages: 5,
    });
    assert.deepEqual(idsOf(through), ['h1', 'h2', 'h3', 'h4', 'h5']);
    // A hidden anchor is unknown, as if it did not exist.
    assert.equal(window(env.db, { ctx: group, anchor: 'h4', move: 'up', messages: 2 }).unknown, true);
    // A hit's stretch stops at the hidden line too.
    const found = search(env.db, {
      ctx: group,
      plan: plan(['γραμμη']),
      now: NOW,
      limit: 1,
      settings: { ...dbSettings({})!, recordContext: 3 },
    });
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
    assert.equal(quotes[0].placeId, 'main');
    assert.equal(quotes[0].startTs, Date.parse('2026-10-20T10:00:00.000Z'));
    assert.deepEqual(
      quotes[0].entries.map((entry) => entry.id),
      ['q1', 'q2']
    );
    assert.ok(quotes[0].lines.includes('Αλίκη') && quotes[0].lines.includes('το σπιτι του δασκαλου'));
    assert.deepEqual(quotesOf([], { render: {}, stretchChars: 1500 }), []);
  } finally {
    env.done();
  }
});

// ---------- the runner and the tool over the database ----------

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// PR 7c: the shipped settings live in config/config.json.
const SHIPPED = JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'config.json'), 'utf8'));
const withHidden = {
  ...labels,
  tools: {
    ...labels.tools,
    tools: { ...labels.tools.tools, memory: { ...labels.tools.tools.memory, hidden: 'ΚΡΥΦΟ-ΣΗΜΑ' } },
  },
};

/**
 * A runner over a fake guild (#general c1, #secret c4 that @everyone cannot see) and the fixture database, whose
 * places rows hold both channels and Bob's DM (`places: false`: none; the runner's place rule reads them).
 */
function runner(
  env: ReturnType<typeof fixture>,
  {
    open = true,
    meaning = false,
    embed = null,
    places = true,
  }: {
    open?: boolean;
    meaning?: boolean;
    embed?: ((texts: Array<string>, options: { purpose: string }) => Promise<Array<Float32Array>>) | null;
    places?: boolean;
  } = {}
) {
  // PR 7d: every context reads through `audience_id`, so the rows the fixture wrote carry it.
  fillEnvAudiences(env);
  if (places) {
    insertRows(
      env.db,
      {
        places: [
          {
            id: channelPlaceId('discord', 'c1'),
            iface: 'discord',
            kind: 'channel',
            native_id: 'c1',
            scope_kind: 'group',
            name: 'general',
          },
          {
            id: channelPlaceId('discord', 'c4'),
            iface: 'discord',
            kind: 'channel',
            native_id: 'c4',
            scope_kind: 'group',
            name: 'secret',
          },
          {
            id: dmPlaceId('discord', BOB),
            iface: 'discord',
            kind: 'dm',
            native_id: null,
            scope_kind: 'dm',
            partner_person: personId('discord', BOB),
          },
        ],
      },
      { log: { info() {}, debug() {}, warn() {}, error() {} } }
    );
  }
  // The interface is asked for nothing here: every search answers empty and every history read nothing, and each ask is noted.
  const rest: Array<string> = [];
  const reads = {
    searchMessages: (scope: { placeId: string }) => {
      rest.push(`/guilds/${scope.placeId}/messages/search`);
      return Promise.resolve({ total: 0, hits: [] });
    },
    searchMembers: (scope: { placeId: string }) => {
      rest.push(`/guilds/${scope.placeId}/members/search`);
      return Promise.resolve({ members: [] });
    },
    history: () => Promise.resolve({ events: [], complete: true }),
  };
  // #general (c1) and #secret (c4), which the root's everyone cannot view; Bob's private chat is the partner's.
  const channel = channelInfo('c1', { name: 'general' });
  const secret = { ...privateChannel('c4', []), name: 'secret' };
  const snapshot = snapshotOf('g1', { chats: [channel, secret], groups: [] });
  const dm = channelInfo('dm-bob', { kind: 'dm', rootId: null, chatType: 'dm', partnerId: BOB, audience: null });
  const config = structuredClone(SHIPPED);
  config.bot = { ...config.bot, timezone: 'UTC' };
  config.features = { ...config.features, meaningSearch: meaning, recall: true };
  config.models = { ...config.models, base: { ...config.models?.base, embedding: 'test/embedder' } };
  const data = {};
  const store = {
    state: {
      get data() {
        return data;
      },
      markDirty() {},
    },
    listUserProfiles: () => [],
    personOfAccount: storedPersonOf,
    dmHomeOf: storedDmOf,
  };
  const llmCalls: Array<Array<unknown>> = [];
  const llm = {
    capLeft: () => 100,
    complete: async (...call: Array<unknown>) => {
      llmCalls.push(call);
      return { text: '' };
    },
  };
  const hot = { config, prompts: { 'recall-summary': 'x', labels: withHidden } };
  const recaller = asRecall({
    reads: asReads(reads),
    hot,
    store,
    llm,
    now: () => NOW,
    embed,
    memoryDb: { database: () => (open ? env.db : null) },
  });
  return {
    recaller,
    channel,
    dm,
    rest,
    hot,
    llmCalls,
    args: {
      placeId: 'g1',
      snapshot,
      channel,
      partnerId: null,
      selfId: 'self',
      selfName: 'Ζωή',
      history: [],
      candidate: { id: 'q', content: 'το σπιτι' },
    },
  };
}

test('recall.run: stored group stretches follow memory scope without a live interface request or summary', async () => {
  const env = fixture();
  try {
    env.account(ALICE, ['Αλίκη']);
    const ownSourceId = env.say({
      native: 'r1',
      at: NOW - 3 * DAY,
      text: 'το σπιτι του δασκαλου',
      place: channelPlaceId('discord', 'c1'),
    });
    env.say({
      native: 'r2',
      at: NOW - 3 * DAY + 60000,
      text: 'ναι ηταν μεγαλο',
      place: channelPlaceId('discord', 'c1'),
    });
    env.say({ native: 'r3', at: NOW - 2 * DAY, text: 'κρυφο σπιτι', place: channelPlaceId('discord', 'c4') });
    env.say({
      native: 'r4',
      at: NOW - DAY,
      text: 'ιδιωτικο σπιτι',
      place: dmPlaceId('discord', BOB),
      scope: dmScope(personId('discord', BOB), 'discord'),
    });
    env.stem();
    const s = runner(env);
    const found = await s.recaller.run({
      ...s.args,
      candidate: { ...s.args.candidate, authorId: BOB },
      server: { forms: ['σπιτι'], who: [], from: null, to: null },
      quotes: true,
    });
    assert.equal(found.outcome.kind, 'searched');
    assert.deepEqual(
      found.quotes.map((quote) => quote.channelName),
      ['secret', 'general']
    );
    // Policy 2 shares stored group evidence independently of the live pull permission.
    assert.deepEqual(
      found.quotes[1].entries.map((entry) => entry.id),
      ['r1', 'r2']
    );
    assert.ok(found.quotes[1].lines.includes('Αλίκη'));
    assert.ok(JSON.stringify(found).includes('κρυφο'));
    assert.equal(JSON.stringify(found).includes('ιδιωτικο'), false);
    assert.deepEqual(s.rest, [], 'no request to Discord');
    assert.equal(s.llmCalls.length, 0, 'no summary');
    // Policy 2 exposes the stronger secret-group match, so the asker's weaker DM match needs no hint.
    assert.equal(found.hidden, false);
    const stranger = await s.recaller.run({
      ...s.args,
      candidate: { ...s.args.candidate, authorId: ALICE },
      server: { forms: ['σπιτι'], who: [], from: null, to: null },
      quotes: true,
    });
    assert.equal(stranger.hidden, false, "the DM is another person's");
    // Policy 2 also permits a named stored group independently of live pull permission.
    const named = await s.recaller.run({
      ...s.args,
      server: { forms: ['σπιτι'], who: [], from: null, to: null, placeId: 'c4' },
      quotes: true,
    });
    assert.equal(named.outcome.kind, 'searched');
    assert.deepEqual(
      named.quotes.flatMap((quote) => quote.entries.map((entry) => entry.id)),
      ['r3']
    );
    // Generic stored rows require exact source identity for history exclusion, without an invented native route.
    const seen = await s.recaller.run({
      ...s.args,
      history: [
        {
          id: 'r1',
          placeId: 'c1',
          ts: NOW,
          self: false,
          bot: false,
          authorName: 'x',
          content: 'y',
          stored: { sourceId: ownSourceId, placeId: channelPlaceId('discord', 'c1'), iface: 'discord' },
        },
      ],
      server: { forms: ['σπιτι'], who: [], from: null, to: null },
      quotes: true,
    });
    assert.ok(!seen.quotes.some((quote) => quote.entries.some((entry) => entry.id === 'r1')));
  } finally {
    env.done();
  }
});

test('recall.run: with no open database the stretches are not configured, and nothing asks Discord', async () => {
  const env = fixture();
  try {
    env.say({ native: 'r1', at: NOW - DAY, text: 'το σπιτι', place: channelPlaceId('discord', 'c1') });
    env.stem();
    const s = runner(env, { open: false });
    const found = await s.recaller.run({
      ...s.args,
      server: { forms: ['σπιτι'], who: [], from: null, to: null },
      quotes: true,
    });
    assert.equal(found.outcome.kind, 'not-configured');
    assert.equal(found.quotes?.length ?? 0, 0);
    assert.deepEqual(s.rest, []);
    const open = runner(env, { places: false });
    const again = await open.recaller.run({
      ...open.args,
      server: { forms: ['σπιτι'], who: [], from: null, to: null },
      quotes: true,
    });
    assert.equal(again.quotes.length, 1, 'the open database answers');
  } finally {
    env.done();
  }
});

test('recall.run: the question is embedded once for the meaning search, and a failed embedding leaves words only', async () => {
  const env = fixture();
  try {
    env.say({ native: 'r1', at: NOW - DAY, text: 'ασχετο κειμενο', place: channelPlaceId('discord', 'c1') });
    env.say({ native: 'r2', at: NOW - 2 * DAY, text: 'ακομα ενα', place: channelPlaceId('discord', 'c1') });
    env.stem();
    env.vector('r1', [1, 0, 0, 0]);
    const calls: Array<unknown> = [];
    const good = runner(env, {
      meaning: true,
      embed: async (texts: Array<string>, options: { purpose: string }) => {
        calls.push([texts, options.purpose]);
        return [Float32Array.from([1, 0, 0, 0])];
      },
    });
    const found = await good.recaller.run({
      ...good.args,
      server: { forms: ['τιποτα'], who: [], from: null, to: null },
      quotes: true,
    });
    assert.deepEqual(calls, [[['το σπιτι'], 'recall-query']]);
    assert.deepEqual(
      found.quotes.flatMap((quote) => quote.entries.map((entry) => entry.id)).sort(),
      ['r1', 'r2'],
      'the meaning hit r1 and its neighbour'
    );
    assert.equal(found.outcome.degraded, false);
    const bad = runner(env, {
      meaning: true,
      embed: async () => {
        throw new Error('down');
      },
    });
    const words = await bad.recaller.run({
      ...bad.args,
      server: { forms: ['ασχετο'], who: [], from: null, to: null },
      quotes: true,
    });
    assert.equal(words.outcome.degraded, true);
    assert.equal(words.quotes.length, 1);
  } finally {
    env.done();
  }
});

test('recall.window: reads stored group lines through memory scope and refuses an unknown anchor', async () => {
  const env = fixture();
  try {
    for (let i = 1; i <= 5; i += 1)
      env.say({
        native: `x${i}`,
        at: NOW - (6 - i) * 60000,
        text: `γραμμη ${i}`,
        place: channelPlaceId('discord', 'c1'),
      });
    env.say({ native: 'y0', at: NOW - 120000, text: 'πριν αλλου', place: channelPlaceId('discord', 'c4') });
    env.say({ native: 'y1', at: NOW - 60000, text: 'αλλου', place: channelPlaceId('discord', 'c4') });
    env.stem();
    const s = runner(env);
    const down = await s.recaller.window({ ...s.args, anchor: 'x2', move: 'down', messages: 2 });
    assert.deepEqual(
      down.quotes[0].entries.map((entry) => entry.id),
      ['x3', 'x4']
    );
    assert.equal(down.quotes[0].channelName, 'general');
    // Policy 2 permits stored group windows even when live pull permission excludes the channel.
    const stored = await s.recaller.window({ ...s.args, anchor: 'y1', move: 'up', messages: 2 });
    assert.equal(stored.outcome.kind, 'searched');
    assert.deepEqual(
      stored.quotes.flatMap((quote) => quote.entries.map((entry) => entry.id)),
      ['y0']
    );
    assert.equal((await s.recaller.window({ ...s.args, anchor: 'zzz', move: 'up' })).outcome.kind, 'unknown-anchor');
    const off = runner(env, { open: false, places: false });
    assert.equal((await off.recaller.window({ ...off.args, anchor: 'x2' })).outcome.kind, 'not-configured');
  } finally {
    env.done();
  }
});

test('recall.window: the place rule reads the place row; a DM place with one opens for its partner, a place with none is refused', async () => {
  const env = fixture();
  try {
    env.say({
      native: 'p1',
      at: NOW - 120000,
      text: 'γραμμη ενα',
      place: dmPlaceId('discord', BOB),
      scope: dmScope(personId('discord', BOB), 'discord'),
    });
    env.say({
      native: 'p2',
      at: NOW - 60000,
      text: 'γραμμη δυο',
      place: dmPlaceId('discord', BOB),
      scope: dmScope(personId('discord', BOB), 'discord'),
    });
    // A line Bob may read, in a DM place the database holds no row for.
    env.say({
      native: 'u1',
      at: NOW - 30000,
      text: 'αγνωστη θεση',
      place: dmPlaceId('discord', CAROL),
      scope: dmScope(personId('discord', BOB), 'discord'),
    });
    env.say({ native: 'c1', at: NOW - 60000, text: 'γραμμη στο καναλι', place: channelPlaceId('discord', 'c1') });
    env.say({ native: 'c2', at: NOW - 30000, text: 'και αλλη', place: channelPlaceId('discord', 'c1') });
    env.stem();
    const s = runner(env);
    const dm = { ...s.args, channel: s.dm, partnerId: BOB };
    const read = await s.recaller.window({ ...dm, anchor: 'p2', move: 'up', messages: 2 });
    assert.deepEqual(
      read.quotes[0].entries.map((entry) => entry.id),
      ['p1']
    );
    assert.equal(
      (await s.recaller.window({ ...dm, anchor: 'u1', move: 'up', messages: 2 })).outcome.kind,
      'unknown-anchor',
      'no row: refused'
    );
    assert.deepEqual(
      (await s.recaller.window({ ...s.args, anchor: 'c2', move: 'up', messages: 2 })).quotes[0].entries.map(
        (entry) => entry.id
      ),
      ['c1']
    );
    // Without the rows, the channel the pull rail lets through is refused all the same.
    const bare = fixture();
    try {
      bare.say({ native: 'c1', at: NOW - 60000, text: 'γραμμη στο καναλι', place: channelPlaceId('discord', 'c1') });
      bare.say({ native: 'c2', at: NOW - 30000, text: 'και αλλη', place: channelPlaceId('discord', 'c1') });
      const none = runner(bare, { places: false });
      assert.equal(
        (await none.recaller.window({ ...none.args, anchor: 'c2', move: 'up', messages: 2 })).outcome.kind,
        'unknown-anchor'
      );
    } finally {
      bare.done();
    }
  } finally {
    env.done();
  }
});

test("recall: the turn's execution context is used when it fits the read; a read it does not fit is issued its own", async () => {
  const env = fixture();
  try {
    env.say({ native: 'r1', at: NOW - DAY, text: 'το σπιτι', place: channelPlaceId('discord', 'c1') });
    env.stem();
    const s = runner(env);
    const issued: Array<{ kind: string; person?: string }> = [];
    const recaller = asRecall({
      reads: asReads({
        searchMessages: () => Promise.resolve(null),
        searchMembers: () => Promise.resolve(null),
        history: () => Promise.resolve(null),
      }),
      hot: s.hot,
      store: { state: { data: {}, markDirty() {} }, listUserProfiles: () => [], personOfAccount: storedPersonOf },
      llm: { capLeft: () => 100, complete: async () => ({ text: '' }) },
      now: () => NOW,
      memoryDb: {
        database: () => env.db,
        issueContext: (spec: { kind: string; person?: string }) => {
          issued.push(spec);
          return {
            iface: 'discord',
            kind: spec.kind,
            ...(spec.person ? { person: spec.person } : {}),
            id: `ctx:issued:${issued.length}`,
          };
        },
      },
    });
    const turn = { iface: 'discord', kind: 'group', id: 'ctx:turn' };
    const found = await recaller.run({
      ...s.args,
      server: { forms: ['σπιτι'], who: [], from: null, to: null },
      quotes: true,
      memoryContext: turn,
    });
    assert.equal(found.quotes.length, 1);
    assert.deepEqual(issued, [], "the turn's own context, none issued");
    await recaller.window({ ...s.args, anchor: 'r1', move: 'up', messages: 2, memoryContext: turn, asker: ALICE });
    assert.deepEqual(issued, []);
    // A DM read does not take a group context: it is issued for its partner.
    await recaller.window({
      ...s.args,
      channel: s.dm,
      partnerId: BOB,
      anchor: 'r1',
      move: 'up',
      messages: 2,
      memoryContext: turn,
    });
    assert.deepEqual(
      issued.map((spec: { kind: string; person?: string }) => [spec.kind, spec.person]),
      [['dm', personId('discord', BOB)]]
    );
  } finally {
    env.done();
  }
});

test('memory.search: the hidden marker is one label line, with or without stretches; an anchor makes the call a window read', async () => {
  const quote = {
    placeId: 'c1',
    channelName: 'general',
    startTs: Date.UTC(2026, 9, 20),
    lines: '[10:00] Αλίκη: γεια',
  };
  assert.ok(memorySearchText([quote], { labels: withHidden, hidden: true }).endsWith('ΚΡΥΦΟ-ΣΗΜΑ'));
  assert.equal(memorySearchText([quote], { labels: withHidden }).includes('ΚΡΥΦΟ-ΣΗΜΑ'), false);
  const none = memorySearchText([], { labels: withHidden, hidden: true });
  assert.ok(none.includes(withHidden.tools.tools.memory.none) && none.endsWith('ΚΡΥΦΟ-ΣΗΜΑ'));
  assert.equal(
    memorySearchText([], { labels: { tools: { tools: { memory: { none: 'N' } } } }, hidden: true }),
    'N',
    'a missing label adds nothing'
  );

  const seen: Array<Array<unknown>> = [];
  const recall = {
    available: () => true,
    run: async (call: { server: unknown }) => {
      seen.push(['run', call.server]);
      return { quotes: [quote], hidden: true, outcome: { kind: 'searched', degraded: false, failed: 0, total: 1 } };
    },
    window: async (call: { anchor: string; move: string; messages: number; minutes: number | null }) => {
      seen.push(['window', call.anchor, call.move, call.messages, call.minutes]);
      return call.anchor === 'bad'
        ? { quotes: [], outcome: { kind: 'unknown-anchor' } }
        : { quotes: [quote], outcome: { kind: 'searched' } };
    },
  };
  const base = {
    recall,
    store: { listUserProfiles: () => [] },
    config: { ...SHIPPED, bot: { ...SHIPPED.bot, timezone: 'UTC' } },
    labels: withHidden,
    placeId: 'g1',
    // Changed with the contract: the channel is the chat's info (a root chat has `rootId`).
    channel: { rootId: 'g1' },
    now: NOW,
  };
  // The fake recall carries the calls a memory search makes, so each call reads it as the input it stands for.
  const searchWith = (extra: object) =>
    runMemorySearch({ ...base, ...extra } as unknown as Parameters<typeof runMemorySearch>[0]);
  const searched = await searchWith({ args: { question: 'το σπιτι του δασκαλου' } });
  assert.equal(searched.status, 'ok');
  assert.ok(searched.data!.text.endsWith('ΚΡΥΦΟ-ΣΗΜΑ'));
  const read = await searchWith({ args: { anchor: 'x2', move: 'down', messages: 3, minutes: 0 } });
  assert.deepEqual([read.status, seen.at(-1)], ['ok', ['window', 'x2', 'down', 3, null]]);
  assert.ok(!read.data!.text.includes('ΚΡΥΦΟ-ΣΗΜΑ'));
  assert.deepEqual(seen.filter(([kind]) => kind === 'run').length, 1, 'the window read did not search');
  const up = await searchWith({ args: { anchor: 'x2' } });
  assert.deepEqual([up.status, seen.at(-1)], ['ok', ['window', 'x2', 'up', null, null]]);
  assert.deepEqual(await searchWith({ args: { anchor: 'bad' } }), {
    status: 'invalid',
    code: 'unknown-message',
    reason: 'args.anchor',
  });
  assert.equal(
    (await searchWith({ recall: { available: () => true, run: recall.run }, args: { anchor: 'x2' } })).status,
    'not_configured'
  );
});

test('recall-eval: the database is --db, else <data>/memory.db, and the file must exist', async () => {
  const { main } = await import('../scripts/recall-eval.ts');
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'memdb-eval-'));
  try {
    const data = path.join(root, 'data');
    fs.mkdirSync(path.join(data, 'guilds', '300000000000000001'), { recursive: true });
    const questions = path.join(root, 'questions.json');
    fs.writeFileSync(
      questions,
      JSON.stringify([
        {
          id: 'q1',
          placeId: '100000000000000001',
          askerId: '200000000000000001',
          question: 'πού είναι το κουνέλι;',
          expected: ['300000000000000001'],
          kind: 'exact',
        },
      ])
    );
    const base = [questions, '--data', data, '--dry'];
    await assert.rejects(main(base), /no database at .*memory\.db/);
    await assert.rejects(main([...base, '--db', path.join(root, 'missing.db')]), /no database at .*missing\.db/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('words: a wide pool is ranked by the distinct terms a line holds; relevance beats recency unless the plan names a date', () => {
  const env = fixture();
  try {
    for (let i = 0; i < 12; i += 1)
      env.say({
        native: `w-new-${i}`,
        at: NOW - (1 + i / 100) * DAY,
        text: 'σπιτι σπιτι σπιτι',
        place: channelPlaceId('discord', `n${i}`),
      });
    env.say({
      native: 'w-old',
      at: NOW - 60 * DAY,
      text: 'το σπιτι, ο δασκαλος και το αυτοκινητο',
      place: channelPlaceId('discord', 'old'),
    });
    env.stem();
    const settings = { ...dbSettings({})!, gateShare: 0, candidates: 3, wordPool: 100 };
    const forms = ['σπιτι', 'δασκαλος', 'αυτοκινητο'];
    const found = run(env, forms, { settings });
    assert.equal(ids(found)[0], 'w-old', 'three distinct terms beat a recent line of one');
    assert.equal(found.hits[0].terms, 3);
    const one = run(env, forms, { settings, limit: 1 });
    assert.ok(
      one.windows[0].messages.some((message) => message.id === 'w-old'),
      "the one window kept is the best-ranked hit's"
    );
    const aimed = run(env, forms, { settings, plan: { from: NOW - 3 * DAY, to: NOW } });
    assert.ok(
      ids(aimed).every((id) => (id as string).startsWith('w-new-')),
      'a named date ranks toward it'
    );
  } finally {
    env.done();
  }
});

test('gate: a hit holding the most distinct terms passes even under the share of the best fused score', async () => {
  const { passGate } = await import('../src/memory/db/recall.ts');
  const visible = [
    { id: 'a', score: 0.032 },
    { id: 'b', score: 0.016 },
    { id: 'c', score: 0.012 },
    { id: 'd', score: 0.011 },
  ];
  const held: Record<string, number> = { a: 1, b: 3, c: 1, d: 0 };
  const kept = passGate(visible, (e) => held[e.id], 0.5).map((e) => e.id);
  assert.deepEqual(kept, ['a', 'b']);
  const single = passGate(visible, (e) => ({ a: 1, b: 1, c: 1, d: 0 })[e.id as 'a'], 0.5).map((e) => e.id);
  assert.deepEqual(single, ['a', 'b'], 'one term is no reason to pass the gate');
});

// ---------- the place rule and the order of candidates (fix 2 of the store review) ----------

/** A db whose statements are recorded with every row they return, to prove which text was ever loaded. */
function recording(db: Db) {
  const rows: Array<unknown> = [];
  const wrap = (statement: Statement) => ({
    all: (...args: Array<unknown>) => {
      const out = statement.all(...args);
      rows.push(...out);
      return out;
    },
    get: (...args: Array<unknown>) => {
      const out = statement.get(...args);
      if (out) rows.push(out);
      return out;
    },
    *iterate(...args: Array<unknown>) {
      for (const row of statement.iterate(...args)) {
        rows.push(row);
        yield row;
      }
    },
  });
  return {
    rows,
    db: new Proxy(db, {
      get: (target, key) => (key === 'prepare' ? (sql: string) => wrap(target.prepare(sql)) : Reflect.get(target, key)),
    }),
  };
}

test('place rule: a refused place and a DM never crowd an allowed line out of the candidates', () => {
  const env = fixture();
  try {
    for (let i = 0; i < 6; i += 1) {
      env.say({
        native: `refused-${i}`,
        at: NOW - DAY,
        text: 'σπιτι σπιτι σπιτι δασκαλου',
        place: channelPlaceId('discord', 'secret'),
      });
      env.say({
        native: `dm-${i}`,
        at: NOW - DAY,
        text: 'σπιτι σπιτι σπιτι δασκαλου',
        place: dmPlaceId('discord', ALICE),
        scope: dmScope(personId('discord', ALICE), 'discord'),
      });
    }
    env.say({ native: 'open', at: NOW - 5 * DAY, text: 'ενα σπιτι', place: channelPlaceId('discord', 'c1') });
    env.stem();
    const settings = { ...dbSettings({})!, gateShare: 0, candidates: 3, wordPool: 3 };
    const allowPlace = (placeId: string) =>
      placeId !== channelPlaceId('discord', 'secret') && !String(placeId).startsWith('discord:dm:');
    const found = run(env, ['σπιτι'], { settings, allowPlace });
    assert.deepEqual(ids(found), ['open'], 'the word stream picked among the allowed places only');
    assert.equal(found.stats.words, 1);
    // The meaning stream: the refused lines are closer to the question than the allowed one.
    for (let i = 0; i < 6; i += 1) env.vector(`refused-${i}`, [1, 0, 0, 0]);
    env.vector('open', [0.8, 0.6, 0, 0]);
    const meaning = run(env, ['ανυπαρκτο'], {
      settings: { ...settings, minMeaning: 0 },
      allowPlace,
      vector: [1, 0, 0, 0],
    });
    assert.deepEqual(ids(meaning), ['open']);
    assert.equal(meaning.stats.meaning, 1);
    // The people stream.
    env.account(CAROL, ['Μπομπ']);
    for (let i = 0; i < 6; i += 1)
      env.say({
        native: `bob-secret-${i}`,
        at: NOW - 60000 * i,
        text: `ξεχωριστο ${i}`,
        place: channelPlaceId('discord', 'secret'),
        author: CAROL,
      });
    env.say({
      native: 'bob-open',
      at: NOW - 40 * DAY,
      text: 'κατι αλλο',
      place: channelPlaceId('discord', 'c1'),
      author: CAROL,
    });
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
    const settings = { ...dbSettings({})!, gateShare: 0, minMeaning: 0 };
    const found = run(env, ['ανυπαρκτο'], { settings, vector: [1, 0, 0, 0], model: 'test/embedder' });
    assert.deepEqual(ids(found).sort(), ['c'], 'a: another model; b: its vector is of the old text; d: deleted');
    const any = run(env, ['ανυπαρκτο'], { settings, vector: [1, 0, 0, 0] });
    assert.deepEqual(ids(any).sort(), ['a', 'c'], 'no model asked: matched by dims');
    env.db.prepare('UPDATE vectors SET model = NULL').run();
    assert.deepEqual(
      ids(run(env, ['ανυπαρκτο'], { settings, vector: [1, 0, 0, 0], model: 'test/embedder' })).sort(),
      ['a', 'c'],
      'a row with no model is taken by its dims'
    );
  } finally {
    env.done();
  }
});

test("hidden marker: only the asker's own DM of this interface; another person's DM, another interface and internal rows give none", () => {
  const env = fixture();
  try {
    env.say({
      native: 'own',
      at: NOW - DAY,
      text: 'σπιτι δασκαλου μυστικο',
      place: dmPlaceId('discord', ALICE),
      scope: dmScope(personId('discord', ALICE), 'discord'),
    });
    env.say({
      native: 'foreign',
      at: NOW - DAY,
      text: 'βιβλιο κοσμου μυστικο',
      place: dmPlaceId('discord', BOB),
      scope: dmScope(personId('discord', BOB), 'discord'),
    });
    env.say({
      native: 'abroad',
      at: NOW - DAY,
      text: 'παιδι νερου μυστικο',
      place: 'other:dm:x',
      scope: dmScope(personId('discord', ALICE), 'other'),
    });
    env.say({
      native: 'inner',
      at: NOW - DAY,
      text: 'δρομος καιρου μυστικο',
      place: dmPlaceId('discord', ALICE),
      scope: { scope_kind: 'internal', scope_iface: null, scope_dm: null },
    });
    env.stem();
    // The asker is one id or a list; the context types the list.
    const asked = (forms: Array<string>, asker: string | Array<string>) =>
      run(env, forms, {}, { ...group, asker: asker as Array<string> }).hidden;
    assert.equal(asked(['σπιτι δασκαλου'], [personId('discord', ALICE)]), true);
    assert.equal(asked(['σπιτι δασκαλου'], personId('discord', ALICE)), true, 'one id or a list');
    assert.equal(asked(['σπιτι δασκαλου'], [personId('discord', BOB)]), false, 'the DM is not theirs');
    assert.equal(
      asked(['σπιτι δασκαλου'], [personId('discord', BOB), personId('discord', ALICE)]),
      true,
      'any of the linked persons'
    );
    assert.equal(asked(['βιβλιο κοσμου'], [personId('discord', ALICE)]), false, "another person's DM");
    assert.equal(asked(['παιδι νερου'], [personId('discord', ALICE)]), false, "another interface's DM");
    assert.equal(asked(['δρομος καιρου'], [personId('discord', ALICE)]), false, 'an internal row');
    assert.equal(asked(['σπιτι δασκαλου'], []), false);
    // Another person's DM ranking above the asker's own does not hide it: the shared word is in both.
    assert.equal(
      asked(['μυστικο'], [personId('discord', ALICE)]),
      true,
      "the asker's DM found past a better-ranked foreign DM"
    );
    assert.equal(asked(['μυστικο'], [personId('discord', '100000000000000999')]), false, "nobody's DM of theirs");
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
        native: `h${i}`,
        at: NOW - (9 - i) * 60000,
        text: hiddenLine ? 'κρυφη γραμμη ΜΥΣΤΙΚΟ' : `γραμμη ${i}`,
        ...(hiddenLine ? { scope: dmScope(personId('discord', ALICE), 'discord') } : {}),
        ...(i === 5 ? { replyTo: 'h4' } : {}),
      });
    }
    env.stem();
    const seen = recording(env.db);
    const leaked = () => JSON.stringify(seen.rows).includes('ΜΥΣΤΙΚΟ');
    window(seen.db, { ctx: group, anchor: 'h6', move: 'up', messages: 5 });
    window(seen.db, { ctx: group, anchor: 'h2', move: 'down', messages: 5 });
    window(seen.db, { ctx: group, anchor: 'h4', move: 'up', messages: 2 });
    window(seen.db, { ctx: group, anchor: messageSourceId('discord', 'h4', 1, 'seen'), move: 'down', messages: 2 });
    assert.equal(leaked(), false, 'windows');
    search(seen.db, {
      ctx: group,
      plan: plan(['γραμμη 5']),
      now: NOW,
      settings: { ...dbSettings({})!, recordContext: 3 },
    });
    assert.equal(leaked(), false, "a hit's stretch, its reply parent and its neighbours");
    // Control: the partner of that DM does read it, so the recorder sees the text.
    window(seen.db, { ctx: dmOfMember(ALICE), anchor: 'h6', move: 'up', messages: 5 });
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
    const claim = (id: string, text: string, scope: ReturnType<typeof groupScope>, subject: string) =>
      env.db
        .prepare(
          `INSERT INTO claims (id, subject_kind, subject_id, kind, text, scope_kind, scope_iface, scope_dm)
      VALUES (?, 'person', ?, 'alias', ?, ?, ?, ?)`
        )
        .run(id, subject, text, scope.scope_kind, scope.scope_iface, scope.scope_dm);
    claim('c1', 'Λικα', groupScope('discord'), personId('discord', ALICE));
    claim('c2', 'Μπομπακι', dmScope(personId('discord', ALICE), 'discord'), personId('discord', CAROL));
    const who = (name: string, ctx = group) => ids(search(env.db, { ctx, plan: plan([], { who: [name] }), now: NOW }));
    assert.deepEqual(who('Λικα'), ['a1']);
    assert.deepEqual(who('Μπομπακι'), [], 'a claim of a DM is no alias for the group');
    assert.deepEqual(who('Μπομπακι', dmOfMember(ALICE)), ['b1']);
    env.db.prepare("UPDATE accounts SET link = 'pending' WHERE id = ?").run(`discord:${ALICE}`);
    assert.deepEqual(who('Λικα'), [], 'an unverified link resolves nothing');
    assert.deepEqual(who('Αλίκη'), ['a1'], "the account's own name still does");
  } finally {
    env.done();
  }
});

test('recall.prefetch reads the database without throwing, and the asker it is given is the asker of its read', async () => {
  const env = fixture();
  try {
    env.account(ALICE, ['Αλίκη']);
    env.say({ native: 'p1', at: NOW - 3 * DAY, text: 'το σπιτι του δασκαλου', place: channelPlaceId('discord', 'c1') });
    env.say({
      native: 'p2',
      at: NOW - 3 * DAY + 60000,
      text: 'ναι ηταν μεγαλο',
      place: channelPlaceId('discord', 'c1'),
    });
    env.stem();
    const s = runner(env);
    const warned: Array<unknown> = [];
    const found = await s.recaller.prefetch({ ...s.args, asker: BOB, lanes: [{ kind: 'trigger', text: 'το σπιτι' }] });
    assert.notEqual(found?.status, 'unavailable', 'the database prefetch ran');
    assert.deepEqual(warned, []);
  } finally {
    env.done();
  }
});

test('recall finds another interface group before a candidate cap without exposing closer private matches', () => {
  // Catches filtering foreign groups or filling the candidate budget with inaccessible private evidence.
  const env = fixture();
  try {
    for (let i = 0; i < 6; i++)
      env.say({
        native: `private-cross-${i}`,
        at: NOW - i * 60_000,
        text: 'σπιτι σπιτι σπιτι δασκαλου',
        place: dmPlaceId('discord', BOB),
        scope: dmScope(personId('discord', BOB), 'discord'),
      });
    env.say({
      native: 'foreign-group',
      iface: 'other',
      at: NOW - 5 * DAY,
      text: 'ενα σπιτι',
      place: channelPlaceId('other', 'foreign'),
      scope: groupScope('other'),
    });
    env.stem();
    fillEnvAudiences(env);
    const settings = { ...dbSettings({})!, gateShare: 0, candidates: 2, wordPool: 2 };
    for (const ctx of [groupContext('discord'), dmOfMember(ALICE)]) {
      const found = search(env.db, {
        ctx: { ...ctx, audienceColumn: true },
        plan: plan(['σπιτι']),
        now: NOW,
        settings,
      });
      assert.deepEqual(ids(found), ['foreign-group']);
      assert.equal(found.hidden, false, "another person's private matches do not produce a hint");
    }
    env.vector('foreign-group', [0.8, 0.6, 0, 0], { scope: groupScope('other') });
    for (let i = 0; i < 6; i++)
      env.vector(`private-cross-${i}`, [1, 0, 0, 0], { scope: dmScope(personId('discord', BOB), 'discord') });
    fillEnvAudiences(env);
    const meaning = search(env.db, {
      ctx: { ...groupContext('discord'), audienceColumn: true },
      plan: plan(['ανυπαρκτο']),
      now: NOW,
      settings: { ...settings, minMeaning: 0 },
      vector: [1, 0, 0, 0],
    });
    assert.deepEqual(ids(meaning), ['foreign-group']);
  } finally {
    env.done();
  }
});

test('an issued internal context reads another DM through search and window without changing its scope', async () => {
  const env = fixture();
  try {
    env.account(BOB, ['Benoît']);
    const place = dmPlaceId('discord', BOB);
    env.say({
      native: 'owner-private-first',
      at: NOW - DAY,
      text: 'το κουνέλι private-first',
      place,
      author: BOB,
      scope: dmScope(personId('discord', BOB), 'discord'),
    });
    env.say({
      native: 'owner-private-anchor',
      at: NOW - DAY + 60_000,
      text: 'το κουνέλι private-anchor',
      place,
      author: BOB,
      scope: dmScope(personId('discord', BOB), 'discord'),
    });
    env.stem();
    const s = runner(env);
    const { issueContext } = await import('../src/memory/db/scope.ts');
    const memoryContext = issueContext({ kind: 'internal', newId: () => 'ctx:owner-private', now: () => NOW });
    const before = env.db
      .prepare('SELECT audience_id, scope_kind, scope_iface, scope_dm FROM sources WHERE native_id = ?')
      .get('owner-private-anchor');
    const found = await s.recaller.run({
      ...s.args,
      server: { forms: ['κουνέλι'], who: ['benoît'], from: NOW - DAY, to: NOW },
      quotes: true,
      memoryContext,
    });
    assert.ok(found.quotes.flatMap((quote) => quote.entries).some((entry) => entry.id === 'owner-private-anchor'));
    const expanded = await s.recaller.window({
      ...s.args,
      anchor: 'owner-private-anchor',
      move: 'up',
      messages: 2,
      memoryContext,
    });
    assert.ok(expanded.quotes.flatMap((quote) => quote.entries).some((entry) => entry.id === 'owner-private-first'));
    const ordinary = await s.recaller.run({
      ...s.args,
      server: { forms: ['κουνέλι'], who: [], from: null, to: null },
      quotes: true,
    });
    assert.deepEqual(ordinary.quotes, []);
    assert.deepEqual(
      env.db
        .prepare('SELECT audience_id, scope_kind, scope_iface, scope_dm FROM sources WHERE native_id = ?')
        .get('owner-private-anchor'),
      before
    );
  } finally {
    env.done();
  }
});

test('an ordinary DM retains its own evidence and public groups while another private chat stays excluded', async () => {
  const env = fixture();
  try {
    env.account(BOB, ['Benoit']);
    env.account(CAROL, ['Carol']);
    env.say({
      native: 'own-private',
      at: NOW - DAY,
      text: 'το κουνέλι own-private-marker',
      place: dmPlaceId('discord', BOB),
      author: BOB,
      scope: dmScope(personId('discord', BOB), 'discord'),
    });
    env.say({
      native: 'unrelated-private',
      at: NOW - DAY,
      text: 'το κουνέλι unrelated-private-marker',
      place: dmPlaceId('discord', CAROL),
      author: CAROL,
      scope: dmScope(personId('discord', CAROL), 'discord'),
    });
    env.say({
      native: 'shared-group',
      at: NOW - DAY,
      text: 'το κουνέλι shared-group-marker',
      place: channelPlaceId('discord', 'c1'),
    });
    env.stem();
    const s = runner(env);
    const found = await s.recaller.run({
      ...s.args,
      channel: s.dm,
      partnerId: BOB,
      server: { forms: ['κουνέλι'], who: [], from: null, to: null },
      quotes: true,
    });
    const entries = found.quotes.flatMap((quote) => quote.entries.map((entry) => entry.id));
    assert.ok(entries.includes('own-private'));
    assert.ok(entries.includes('shared-group'), JSON.stringify(found));
    assert.equal(entries.includes('unrelated-private'), false);
    const denied = await s.recaller.window({
      ...s.args,
      channel: s.dm,
      partnerId: BOB,
      anchor: 'unrelated-private',
      move: 'up',
      messages: 2,
    });
    assert.equal(denied.outcome.kind, 'unknown-anchor');
  } finally {
    env.done();
  }
});

test('search, window and prefetch retain one issued internal context rather than issuing narrower readers', async () => {
  const env = fixture();
  try {
    const { issueContext } = await import('../src/memory/db/scope.ts');
    const { rig } = await import('./fixtures/reads-rig.ts');
    env.account(BOB, ['Benoit']);
    env.say({
      native: 'owner-shared-reader-before',
      at: NOW - DAY - 60_000,
      text: 'το κουνέλι shared-reader-marker',
      place: dmPlaceId('discord', BOB),
      author: BOB,
      scope: dmScope(personId('discord', BOB), 'discord'),
    });
    env.say({
      native: 'owner-shared-reader',
      at: NOW - DAY,
      text: 'το κουνέλι shared-reader-marker',
      place: dmPlaceId('discord', BOB),
      author: BOB,
      scope: dmScope(personId('discord', BOB), 'discord'),
    });
    env.stem();
    const s = runner(env);
    const issued: Array<Parameters<typeof issueContext>[0]> = [];
    const recaller = createRecall({
      reads: rig().reads,
      hot: s.hot,
      store: { state: { data: {}, markDirty() {} }, listUserProfiles: () => [], personOfAccount: storedPersonOf },
      llm: {
        capLeft: () => 100,
        complete: () => Promise.reject(new Error('quoted database reads do not summarize')),
      },
      now: () => NOW,
      memoryDb: {
        database: () => env.db,
        issueContext: (spec: Parameters<typeof issueContext>[0]) => {
          issued.push(spec);
          return issueContext({ ...spec, newId: () => `ctx:unexpected:${issued.length}`, now: () => NOW });
        },
      },
    });
    const memoryContext = issueContext({ kind: 'internal', newId: () => 'ctx:shared-reader', now: () => NOW });
    const found = await recaller.run({
      ...s.args,
      server: { forms: ['κουνέλι'], who: [], from: null, to: null },
      quotes: true,
      memoryContext,
    });
    assert.ok(JSON.stringify(found).includes('shared-reader-marker'));
    const expanded = await recaller.window({
      ...s.args,
      anchor: 'owner-shared-reader',
      move: 'up',
      messages: 1,
      memoryContext,
    });
    assert.ok(JSON.stringify(expanded).includes('shared-reader-marker'));
    const prefetched = await recaller.prefetch({
      ...s.args,
      lanes: [{ kind: 'message', text: 'το κουνέλι', words: 'το κουνέλι' }],
      memoryContext,
    });
    assert.ok(JSON.stringify(prefetched).includes('shared-reader-marker'));
    assert.deepEqual(issued, []);
  } finally {
    env.done();
  }
});

for (const memoryContext of [
  { internal: true, mode: 'internal', id: '' },
  { internal: true, mode: 'outward', id: 'ctx:wrong-mode' },
  { mode: 'internal', id: 'ctx:missing-marker' },
]) {
  test(`a malformed internal reader fails closed for ${memoryContext.id || 'empty ID'}`, async () => {
    const env = fixture();
    try {
      env.say({
        native: 'malformed-hidden',
        at: NOW - DAY,
        text: 'το κουνέλι malformed-hidden-marker',
        place: dmPlaceId('discord', BOB),
        author: BOB,
        scope: dmScope(personId('discord', BOB), 'discord'),
      });
      env.stem();
      const s = runner(env);
      const found = await s.recaller.run({
        ...s.args,
        server: { forms: ['κουνέλι'], who: [], from: null, to: null },
        quotes: true,
        memoryContext,
      });
      assert.deepEqual(found.quotes, []);
      const expanded = await s.recaller.window({
        ...s.args,
        anchor: 'malformed-hidden',
        move: 'up',
        messages: 1,
        memoryContext,
      });
      assert.equal(expanded.outcome.kind, 'unknown-anchor');
      const prefetched = await s.recaller.prefetch({
        ...s.args,
        lanes: [{ kind: 'message', text: 'το κουνέλι', words: 'το κουνέλι' }],
        memoryContext,
      });
      assert.equal(JSON.stringify(prefetched).includes('malformed-hidden-marker'), false);
    } finally {
      env.done();
    }
  });
}

for (const kind of ['group', 'dm'] as const) {
  test(`a ${kind} reader searches and expands an offline foreign group outside its live snapshot`, async () => {
    const env = fixture();
    try {
      for (const [native, minute] of [
        ['offline-before', 0],
        ['offline-anchor', 1],
      ] as const) {
        env.say({
          native,
          iface: 'other',
          at: NOW - DAY + minute * 60_000,
          text: `το κουνέλι ${native}`,
          place: channelPlaceId('other', 'offline'),
          scope: groupScope('other'),
        });
      }
      env.stem();
      const s = runner(env);
      insertRows(env.db, {
        places: [
          {
            id: channelPlaceId('other', 'offline'),
            iface: 'other',
            kind: 'channel',
            native_id: 'offline',
            scope_kind: 'group',
            name: 'offline group',
          },
        ],
      });
      const context = kind === 'dm' ? dmOfMember(BOB) : groupContext('discord');
      assert.deepEqual(ids(run(env, ['κουνέλι'], {}, { ...context, audienceColumn: true })).sort(), [
        'offline-anchor',
        'offline-before',
      ]);
      const args = { ...s.args, ...(kind === 'dm' ? { channel: s.dm, partnerId: BOB } : {}) };
      const found = await s.recaller.run({
        ...args,
        server: { forms: ['κουνέλι'], who: [], from: null, to: null },
        quotes: true,
      });
      assert.ok(found.quotes.flatMap((quote) => quote.entries).some((entry) => entry.id === 'offline-anchor'));
      assert.ok(found.quotes.some((quote) => quote.channelName === 'offline group'));
      const expanded = await s.recaller.window({ ...args, anchor: 'offline-anchor', move: 'up', messages: 2 });
      assert.ok(expanded.quotes.flatMap((quote) => quote.entries).some((entry) => entry.id === 'offline-before'));
      const prefetched = await s.recaller.prefetch({
        ...args,
        lanes: [{ kind: 'message', text: 'το κουνέλι', words: 'το κουνέλι' }],
      });
      assert.ok(JSON.stringify(prefetched).includes('offline-before'));
      assert.deepEqual(s.rest, [], 'stored evidence needs no live interface search');
    } finally {
      env.done();
    }
  });
}

for (const reader of ['run', 'window', 'prefetch'] as const) {
  test(`an internal ${reader} without a guild reads SQLite without consulting legacy guild data`, async () => {
    const env = fixture();
    try {
      const { issueContext } = await import('../src/memory/db/scope.ts');
      const { rig } = await import('./fixtures/reads-rig.ts');
      env.account(BOB, ['Benoit']);
      for (const [native, offset] of [
        ['null-guild-before', 60_000],
        ['null-guild-anchor', 0],
      ] as const) {
        env.say({
          native,
          at: NOW - DAY - offset,
          text: 'το κουνέλι null-guild-private-evidence',
          place: dmPlaceId('discord', BOB),
          author: BOB,
          scope: dmScope(personId('discord', BOB), 'discord'),
        });
      }
      env.stem();
      const s = runner(env);
      const calls: Array<string> = [];
      const reject = (name: string) => () => {
        calls.push(name);
        throw new Error(`unexpected legacy guild read: ${name}`);
      };
      const recaller = createRecall({
        reads: rig().reads,
        hot: s.hot,
        store: {
          state: { data: {}, markDirty() {} },
          listUserProfiles: reject('profiles'),
          getLore: reject('lore'),
          getPlace: reject('guild'),
          getRecent: reject('recent'),
          getPrivate: reject('private'),
        },
        memberName: reject('member name'),
        describer: { cachedDescriptions: reject('captions') },
        llm: { capLeft: () => 100, complete: () => Promise.reject(new Error('SQLite evidence needs no model')) },
        now: () => NOW,
        memoryDb: { database: () => env.db },
      });
      const args = {
        ...s.args,
        placeId: null,
        snapshot: null,
        channel: s.dm,
        memoryContext: issueContext({ kind: 'internal', newId: () => `ctx:null-guild-${reader}`, now: () => NOW }),
      };
      const found =
        reader === 'run'
          ? await recaller.run({ ...args, server: { forms: ['κουνέλι'], who: [], from: null, to: null }, quotes: true })
          : reader === 'window'
            ? await recaller.window({ ...args, anchor: 'null-guild-anchor', move: 'up', messages: 1 })
            : await recaller.prefetch({
                ...args,
                lanes: [{ kind: 'message', text: 'το κουνέλι', words: 'το κουνέλι' }],
              });
      assert.deepEqual(calls, []);
      assert.ok(JSON.stringify(found).includes('null-guild-private-evidence'));
    } finally {
      env.done();
    }
  });
}

test('an internal window retains stored media without reading captions for a null guild', async () => {
  const env = fixture();
  try {
    const { issueContext } = await import('../src/memory/db/scope.ts');
    const { rig } = await import('./fixtures/reads-rig.ts');
    env.account(BOB, ['Benoit']);
    const source = env.say({
      native: 'media-before',
      at: NOW - DAY - 60000,
      text: 'Stored picture evidence',
      place: dmPlaceId('discord', BOB),
      author: BOB,
      scope: dmScope(personId('discord', BOB), 'discord'),
    });
    // The kinds of a line live on its links: one bare item, as the migration leaves an old picture.
    env.db.exec("INSERT INTO media (id, kind, availability) VALUES ('media:bare:b', 'image', 'unknown')");
    env.db.prepare("INSERT INTO media_links VALUES ('source', ?, 0, 'media:bare:b')").run(source);
    env.say({
      native: 'media-anchor',
      at: NOW - DAY,
      text: 'Window anchor',
      place: dmPlaceId('discord', BOB),
      author: BOB,
      scope: dmScope(personId('discord', BOB), 'discord'),
    });
    const s = runner(env);
    let captions = 0;
    const recaller = asRecall({
      reads: rig().reads,
      hot: s.hot,
      store: {},
      now: () => NOW,
      memoryDb: { database: () => env.db },
      describer: {
        cachedDescriptions: () => {
          captions += 1;
          return new Map();
        },
      },
    });
    const found = await recaller.window({
      ...s.args,
      placeId: null,
      snapshot: null,
      channel: s.dm,
      memoryContext: issueContext({ kind: 'internal', newId: () => 'ctx:media-window', now: () => NOW }),
      anchor: 'media-anchor',
      move: 'up',
      messages: 1,
    });
    assert.equal(captions, 0);
    assert.equal(found.outcome.kind, 'searched');
    assert.deepEqual(
      found.quotes.flatMap((quote) => quote.entries.map((entry) => entry.id)),
      ['media-before']
    );
    assert.ok(found.quotes[0].lines.includes('Stored picture evidence'));
    assert.deepEqual(found.quotes[0].entries[0].message.attachments, [
      { id: 'media-before#m0', kind: 'image', name: 'image' },
    ]);
  } finally {
    env.done();
  }
});

for (const hasProfiles of [true, false]) {
  test(`a database window ${hasProfiles ? 'prefers an approved profile name to the stored account name' : 'returns stored evidence and names without an optional profile reader'}`, async () => {
    const env = fixture();
    try {
      const { rig } = await import('./fixtures/reads-rig.ts');
      env.account(ALICE, ['Stored account']);
      for (const [native, offset] of [
        ['profile-before', 60000],
        ['profile-anchor', 0],
      ] as const) {
        env.say({ native, at: NOW - DAY - offset, text: 'Profile evidence', place: channelPlaceId('discord', 'c1') });
      }
      const s = runner(env);
      const recaller = asRecall({
        reads: rig().reads,
        hot: s.hot,
        now: () => NOW,
        store: hasProfiles ? { listUserProfiles: () => [{ id: ALICE, names: ['Approved profile'] }] } : {},
        memoryDb: { database: () => env.db },
      });
      const found = await recaller.window({ ...s.args, anchor: 'profile-anchor', move: 'up', messages: 1 });
      assert.equal(found.outcome.kind, 'searched');
      assert.deepEqual(
        found.quotes.flatMap((quote) => quote.entries.map((entry) => entry.id)),
        ['profile-before']
      );
      assert.ok(found.quotes[0].lines.includes('Profile evidence'));
      assert.equal(found.quotes[0].entries[0].message.authorName, hasProfiles ? 'Approved profile' : 'Stored account');
    } finally {
      env.done();
    }
  });
}

for (const supplied of ['other-dm', 'group', 'current-dm'] as const) {
  test(`a DM search reads only its current partner when supplied an issued ${supplied} context`, async () => {
    const env = fixture();
    try {
      const { issueContext } = await import('../src/memory/db/scope.ts');
      for (const author of [BOB, CAROL]) {
        env.account(author, [author]);
        env.say({
          native: `context-${author}`,
          at: NOW - DAY,
          text: `το κουνέλι evidence-${author}`,
          place: dmPlaceId('discord', author),
          author,
          scope: dmScope(personId('discord', author), 'discord'),
        });
      }
      env.stem();
      const s = runner(env);
      const memoryContext = issueContext({
        ...(supplied === 'group'
          ? { kind: 'group' as const }
          : { kind: 'dm' as const, ...dmSpecOf(supplied === 'other-dm' ? CAROL : BOB) }),
        iface: 'discord',
        newId: () => `ctx:supplied-${supplied}`,
        now: () => NOW,
      });
      const found = await s.recaller.run({
        ...s.args,
        channel: s.dm,
        partnerId: BOB,
        memoryContext,
        server: { forms: ['κουνέλι'], who: [], from: null, to: null },
        quotes: true,
      });
      assert.deepEqual(
        found.quotes.flatMap((quote) => quote.entries.map((entry) => entry.id)),
        [`context-${BOB}`]
      );
      assert.ok(found.quotes[0].lines.includes(`evidence-${BOB}`));
      assert.equal(
        found.quotes.some((quote) => quote.lines.includes(`evidence-${CAROL}`)),
        false
      );
    } finally {
      env.done();
    }
  });
}
