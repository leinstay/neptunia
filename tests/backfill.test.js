// tools/backfill.mjs and its pure part, tools/lib/backfill.mjs: windows of connected lines, the
// dedupe of candidates against hot episodes and the archive, the cursor that moves only after a
// durable append, the dry run, and the forgetting marker and the deletion ledger before a run.
// Discord and the model are fakes; every data directory is a fresh temp one.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { advanceCursor, candidateItemId, dedupeCandidates, estimate, isThinWindow, parseExtractAnswer, readExtractAnswer, textSimilarity, windowsOf } from '../tools/lib/backfill.mjs';
import { EPISODE_CHARS } from '../src/memory/episodes.js';
import { main } from '../tools/backfill.mjs';
import { CliError } from '../tools/lib/cli.mjs';
import { tempDir } from './fixtures/tmp.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TEMP = tempDir('nep-backfill-');
after(() => fs.rmSync(TEMP, { recursive: true, force: true }));

const GUILD = '600000000000000001';
const SELF = '900000000000000001';
const ANA = '411111111111111111';
const NIKOS = '422222222222222222';
const CH = '700000000000000001';
const MIN = 60_000;
const T0 = Date.UTC(2026, 8, 23, 10, 0, 0);

/** A record-shaped line. */
function line(id, at, { channel = CH, by = ANA, replyTo = null, kind = 'seen', text = 'Καλημέρα' } = {}) {
  return { kind, messageId: id, occurredAt: new Date(at).toISOString(), scope: { channel }, ...(kind === 'said' ? {} : { by }), replyTo, text, media: [], mentions: [], participants: kind === 'said' ? [] : [by] };
}

let dirs = 0;
function tmpDir() {
  const dir = path.join(TEMP, `d${(dirs += 1)}`);
  fs.mkdirSync(path.join(dir, 'data', 'guilds', GUILD), { recursive: true });
  return dir;
}

/** Every file under `dir` with its content, for "nothing changed" checks. */
function tree(dir) {
  const out = {};
  const walk = (at) => {
    if (!fs.existsSync(at)) return;
    for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
      const full = path.join(at, entry.name);
      if (entry.isDirectory()) walk(full);
      else out[path.relative(dir, full).split(path.sep).join('/')] = fs.readFileSync(full, 'utf8');
    }
  };
  walk(dir);
  return out;
}

/** The tracked config and prompts as the tool reads them, with an analyzer prompt for the test. */
function fakeHot() {
  const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
  config.bot = { ...config.bot, guildId: GUILD, nameTriggers: ['Zoë'] };
  const prompts = {
    backfill: 'Backfill for {{name}}.',
    'memory-voice': 'Voice for {{name}}.',
    'character-card': 'Card of {{name}}.',
    labels: JSON.parse(fs.readFileSync(path.join(ROOT, 'prompts', 'labels.json'), 'utf8')),
  };
  return { config, prompts, close() {} };
}

/** A fake Discord source: one readable channel with `messages` (normalized shape), one unreadable. */
function fakeSource(messages, { pageSize = 100 } = {}) {
  const calls = [];
  return {
    calls,
    async connect() {
      return {
        guildId: GUILD,
        self: { id: SELF, name: 'Zoë' },
        channels: [
          { id: CH, name: 'général', readable: true },
          { id: '700000000000000002', name: 'κρυφό', readable: false },
        ],
        async page(channelId, { after }) {
          calls.push({ channelId, after });
          const sorted = messages.filter((m) => m.channelId === channelId && BigInt(m.id) > BigInt(after)).sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
          const taken = sorted.slice(0, pageSize);
          return { messages: taken, count: taken.length, lastId: taken.at(-1)?.id ?? null, full: taken.length === pageSize };
        },
        async close() {},
      };
    },
  };
}

/** A normalized message whose id is a snowflake of `at`. */
function message(at, { author = ANA, content = 'Γεια σου', replyToId = null, seq = 0 } = {}) {
  const id = ((BigInt(at) - 1420070400000n) << 22n) + BigInt(seq);
  return { id: id.toString(), channelId: CH, channelName: 'général', authorId: author, authorName: author === SELF ? 'Zoë' : 'Ana', self: author === SELF, bot: false, content, ts: at, replyToId, mentionedUserIds: [], attachments: [], links: [], stickers: [], emojis: [] };
}

// ---- pure helpers ---------------------------------------------------------------------------

test('backfill: groups a stream into windows by reply chains and clusterGapMinutes', () => {
  const stream = [
    line('1', T0),
    line('2', T0 + 5 * MIN),
    line('3', T0 + 2 * MIN, { channel: '700000000000000009' }),
    line('4', T0 + 50 * MIN), // a gap over 30 minutes: a new window
    line('5', T0 + 120 * MIN, { replyTo: '2' }), // a reply to the first window joins it
    line('6', T0 + 121 * MIN),
  ];
  const windows = windowsOf(stream, { gapMinutes: 30, maxLines: 120 });
  assert.deepEqual(windows.map((w) => w.lines.map((l) => l.messageId)), [['1', '2', '5', '6'], ['3'], ['4']]);
  assert.deepEqual(windows.map((w) => w.channelId), [CH, '700000000000000009', CH]);
  assert.equal(windows[0].day, '2026-09-23');
  assert.equal(windows[0].id, 'w-1');

  const capped = windowsOf([line('1', T0), line('2', T0 + MIN), line('3', T0 + 2 * MIN, { replyTo: '1' })], { gapMinutes: 30, maxLines: 2 });
  assert.deepEqual(capped.map((w) => w.lines.length), [2, 1], 'a full window takes no more lines, its reply chain included');
});

test('backfill: dedupes candidates against hot episodes and archive sourceRefs', () => {
  const refs = (...ids) => ids.map((messageId) => ({ channelId: CH, messageId }));
  const candidates = [
    { kind: 'episode', userId: ANA, date: '2026-09-23', what: 'Lost the bet about the bridge', quote: '', sourceRefs: refs('10') },
    { kind: 'episode', userId: ANA, date: '2026-09-24', what: 'Taught her a card trick', quote: '', sourceRefs: refs('20', '21') },
    { kind: 'lesson', text: 'Ζ is pronounced like zd', from: NIKOS, sourceRefs: refs('30') },
    { kind: 'lesson', text: 'Commas go inside quotes', from: NIKOS, sourceRefs: refs('40') },
    { kind: 'episode', userId: NIKOS, date: '2026-09-25', what: 'Played chess at night', quote: '', sourceRefs: refs('50') },
    { kind: 'episode', userId: NIKOS, date: '2026-09-25', what: 'played  chess at night', quote: '', sourceRefs: refs('51') },
  ];
  const hotEpisodes = [{ userId: ANA, date: '2026-09-23', what: 'lost the bet about the bridge', quote: '' }];
  const archived = [
    { itemKind: 'episode', sourceRefs: refs('21') },
    { itemKind: 'episode', sourceRefs: refs('40') }, // another kind: no match for a lesson
  ];
  const { kept, dropped } = dedupeCandidates(candidates, { hotEpisodes, archived });
  assert.deepEqual(kept.map((c) => c.text ?? c.what), ['Ζ is pronounced like zd', 'Commas go inside quotes', 'Played chess at night']);
  assert.deepEqual(dropped.map((d) => d.reason), ['hot', 'archive', 'repeat']);
  for (const candidate of kept) assert.match(candidate.itemId, candidate.kind === 'episode' ? /^ep-bf-[0-9a-f]{16}$/ : /^ln-bf-[0-9a-f]{16}$/);
  assert.equal(candidateItemId(candidates[2]), candidateItemId({ ...candidates[2] }), 'an item id is stable across runs');
});

test('backfill: the cursor advances only after a durable append', () => {
  const cursors = { [CH]: { resume: '100', last: '150', written: 3, doneUntil: null } };
  const page = { after: '150', lastId: '250', reachedEnd: false, until: '2026-10-01' };
  assert.equal(advanceCursor(cursors, CH, page, { durable: false, written: 0 }), cursors, 'a failed or unconfirmed append leaves the cursor as it was');
  const next = advanceCursor(cursors, CH, page, { durable: true, written: 2 });
  assert.deepEqual(next[CH], { resume: '150', last: '250', written: 5, doneUntil: null });
  assert.equal(cursors[CH].last, '150', 'the input is never mutated');
  const done = advanceCursor(next, CH, { after: '250', lastId: null, reachedEnd: true, until: '2026-10-01' }, { durable: true, written: 0 });
  assert.deepEqual(done[CH], { resume: '150', last: '250', written: 5, doneUntil: '2026-10-01' }, 'an empty last page keeps the overlap point');
});

test('backfill: estimate prices windows and parseExtractAnswer keeps only cited lines of the window', () => {
  assert.deepEqual(estimate([{}, {}], 8000, 0.005), { windows: 2, tokens: 16000, usd: 0.08 });
  assert.deepEqual(estimate([{ n: 1 }, { n: 3 }], (w) => w.n * 100, 1), { windows: 2, tokens: 400, usd: 0.4 });

  const window = windowsOf([line('1', T0), line('2', T0 + MIN, { kind: 'said' }), line('3', T0 + 2 * MIN, { by: NIKOS })], { gapMinutes: 30, maxLines: 120 })[0];
  const answer = JSON.stringify({
    episodes: [
      { member: ANA, what: 'Asked her about the sea', quote: 'Καλημέρα', quoteSourceId: '1', weight: 5, brief: 'she enjoyed it', sources: ['1', '2'] },
      { member: SELF, what: 'about herself', sources: ['2'] },
      { member: ANA, what: 'no source', sources: ['99'] },
    ],
    lessons: [{ text: 'Octopus has three hearts', from: NIKOS, sources: ['3'] }],
  });
  const candidates = parseExtractAnswer(answer, { window, selfId: SELF });
  assert.equal(candidates.length, 2);
  assert.deepEqual(candidates[0].sourceRefs, [{ channelId: CH, messageId: '1' }, { channelId: CH, messageId: '2' }]);
  assert.equal(candidates[0].observedAt, '2026-09-23');
  assert.equal(candidates[0].date, '2026-09-23');
  assert.equal(candidates[0].weight, 5);
  assert.equal(candidates[0].quote, 'Καλημέρα');
  assert.equal(candidates[1].kind, 'lesson');
  assert.equal(candidates[1].from, NIKOS);
  assert.deepEqual(parseExtractAnswer('not json', { window, selfId: SELF }), []);
});

const ELENA = '433333333333333333';
const refsOf = (...ids) => ids.map((messageId) => ({ channelId: CH, messageId }));
/** One window of record lines from `specs` ([id, options] pairs), a minute apart. */
const windowOf = (...specs) => windowsOf(specs.map(([id, options], i) => ({ ...line(id, T0 + i * MIN, options), ...(options?.extra ?? {}) })), { gapMinutes: 30, maxLines: 120 })[0];

test('backfill: a long what is cut at a word boundary within the episode limit and an unfinished one is counted', () => {
  const window = windowOf(['1', { text: 'Καλημέρα σε όλους' }]);
  const unfinished = `${'Ana told a long story about the harbour and the boats '.repeat(6)}and then`;
  const answer = (what) => JSON.stringify({ episodes: [{ member: ANA, what, sources: ['1'] }] });
  const { candidates, counts } = readExtractAnswer(answer(unfinished), { window, selfId: SELF, clampTolerance: 1.25 });
  const [{ what }] = candidates;
  assert.ok(Array.from(what).length <= Math.floor(EPISODE_CHARS.what * 1.25));
  assert.ok(unfinished.startsWith(what));
  assert.match(unfinished.slice(what.length), /^\s/, 'cut where a word ends, never inside one');
  assert.equal(counts.clamped, 1);

  const sentences = 'Ana told a long story about the harbour. '.repeat(8).trim();
  const finished = readExtractAnswer(answer(sentences), { window, selfId: SELF, clampTolerance: 1.25 });
  assert.match(finished.candidates[0].what, /harbour\.$/, 'cut at a sentence end');
  assert.equal(finished.counts.clamped, 0);
  assert.equal(readExtractAnswer(answer('Ana waved'), { window, selfId: SELF }).counts.clamped, 0, 'a short what without a full stop is not cut, not counted');
});

test('backfill: a quote is kept only when it is verbatim in the message quoteSourceId names', () => {
  const window = windowOf(['1', { text: 'Πάμε  για\nψάρεμα αύριο;' }], ['2', { by: NIKOS, text: 'Όχι εγώ' }]);
  const answer = JSON.stringify({
    episodes: [
      { member: ANA, what: 'Ana asked about fishing', quote: 'Πάμε για ψάρεμα', quoteSourceId: '1', sources: ['1'] },
      { member: ANA, what: 'Ana asked again', quote: 'Πάμε για ψάρεμα', quoteSourceId: '2', sources: ['1', '2'] },
      { member: NIKOS, what: 'Nikos said no', quote: 'Όχι εγώ', sources: ['2'] },
      { member: NIKOS, what: 'Nikos refused', quote: 'όχι εγώ', quoteSourceId: '2', sources: ['2'] },
      { member: NIKOS, what: 'Nikos cited a far line', sources: ['2', '99'] },
    ],
    lessons: [{ text: 'Fishing starts at dawn', from: ANA, sources: ['1', '98'] }],
  });
  const { candidates, counts } = readExtractAnswer(answer, { window, selfId: SELF });
  assert.deepEqual(candidates.map((c) => [c.what, c.quote, c.quoteSourceId ?? null]), [
    ['Ana asked about fishing', 'Πάμε για ψάρεμα', '1'],
    ['Ana asked again', '', null],
    ['Nikos said no', '', null],
    ['Nikos refused', '', null],
  ]);
  assert.equal(counts.quotesDropped, 3, 'another message, no id, not verbatim');
  assert.equal(counts.outsideWindow, 2, 'an item citing a line outside the window is dropped whole');
});

test('backfill: participants hold the actors and everyone named, mentioned only those named who did not act', () => {
  const window = windowOf(['1'], ['2', { by: NIKOS, text: 'Ναι' }]);
  const answer = JSON.stringify({
    episodes: [{ member: ANA, what: `<@${ANA}> and <@${NIKOS}> argued about <@${ELENA}>`, brief: `<@${SELF}> listened`, sources: ['1', '2'] }],
    lessons: [{ text: `<@${ANA}> spells it with one l`, from: NIKOS, sources: ['2'] }],
  });
  const [episode, lesson] = parseExtractAnswer(answer, { window, selfId: SELF });
  assert.equal(episode.userId, ANA);
  assert.deepEqual(episode.participants, [ANA, NIKOS, ELENA]);
  assert.deepEqual(episode.mentioned, [ELENA]);
  assert.deepEqual(lesson.participants, [NIKOS, ANA]);
  assert.deepEqual(lesson.mentioned, [ANA]);
});

test('backfill: the persona\'s name forms become her token in what, brief and text, never in quote', () => {
  const window = windowOf(['1', { text: 'Zoë, έλα εδώ' }]);
  const answer = JSON.stringify({
    episodes: [{ member: ANA, what: 'Ana called zoë over; Zoëlle stayed', quote: 'Zoë, έλα', quoteSourceId: '1', brief: 'ZOE came at once', sources: ['1'] }],
    lessons: [{ text: 'Zoë should greet Ana first', from: ANA, sources: ['1'] }],
  });
  const [episode, lesson] = parseExtractAnswer(answer, { window, selfId: SELF, selfNames: ['Zoë', 'Zoe'] });
  assert.equal(episode.what, `Ana called <@${SELF}> over; Zoëlle stayed`);
  assert.equal(episode.brief, `<@${SELF}> came at once`);
  assert.equal(episode.quote, 'Zoë, έλα');
  assert.equal(lesson.text, `<@${SELF}> should greet Ana first`);
  assert.equal(episode.participants.includes(SELF), false, 'the persona is never a participant');
  assert.deepEqual(lesson.mentioned, []);
});

test('backfill: dedupe merges lessons and episodes that say the same thing, per member, and counts each rule', () => {
  assert.ok(textSimilarity('Ana won the bet', 'ana WON the bet!') === 1);
  assert.equal(textSimilarity('', 'x'), 0);
  const lesson = (text, from, date, ...ids) => ({ kind: 'lesson', text, from, date, observedAt: date, weight: 3, sourceRefs: refsOf(...ids), participants: [from] });
  const episode = (what, userId, date, ...ids) => ({ kind: 'episode', what, userId, date, observedAt: date, quote: '', weight: 3, sourceRefs: refsOf(...ids), participants: [userId] });
  const candidates = [
    lesson('Νίκος wants the persona to call him Nikos, never Nick', NIKOS, '2026-09-24', '60'),
    lesson('Νίκος wants the persona to call him Nikos, never Nick, please', NIKOS, '2026-09-23', '61'),
    lesson('Nikos wants the persona to call him Nikos, never Nick at all', ANA, '2026-09-24', '62'),
    lesson('Commas go inside the quotes in English text', NIKOS, '2026-09-24', '63'),
    episode('Ana bet a coffee that the ferry would be late', ANA, '2026-09-24', '70'),
    episode('Ana won the coffee bet', ANA, '2026-09-23', '70', '71'),
    episode('Ana bet a coffee that the ferry would be late again', ANA, '2026-09-25', '72'),
    episode('Ana bet a coffee that the ferry would be late again', NIKOS, '2026-09-25', '72'),
    episode('Ana sang the harbour song at the night market twice', ANA, '2026-09-24', '96'),
    episode('Ana painted the old lighthouse blue yesterday', ANA, '2026-09-24', '97'),
  ];
  const archived = [
    { itemKind: 'lesson', sourceRefs: refsOf('90'), scope: { guild: true }, text: { text: 'Commas go inside the quotes in English' }, stored: { from: `<@${NIKOS}>` } },
    { itemKind: 'episode', sourceRefs: refsOf('95'), scope: { user: ANA }, text: { what: 'Ana sang the harbour song at the night market' } },
  ];
  const hotEpisodes = [{ userId: ANA, date: '2026-09-01', what: 'Ana painted the old lighthouse blue', quote: '' }];
  const { kept, dropped } = dedupeCandidates(candidates, { hotEpisodes, archived });
  assert.deepEqual(kept.map((c) => [c.text ?? c.what, c.date, c.sourceRefs.map((r) => r.messageId)]), [
    ['Νίκος wants the persona to call him Nikos, never Nick, please', '2026-09-23', ['60', '61']],
    ['Nikos wants the persona to call him Nikos, never Nick at all', '2026-09-24', ['62']],
    ['Ana bet a coffee that the ferry would be late again', '2026-09-23', ['70', '71', '72']],
    ['Ana bet a coffee that the ferry would be late again', '2026-09-25', ['72']],
  ]);
  assert.deepEqual(dropped.map((d) => d.reason), ['similar', 'archive-similar', 'repeat', 'similar', 'archive-similar', 'hot-similar']);
  assert.equal(kept[0].itemId, candidateItemId(kept[0]), 'the merged candidate carries its own item id');
  const again = dedupeCandidates(candidates, { hotEpisodes, archived });
  assert.deepEqual(again.kept.map((c) => c.itemId), kept.map((c) => c.itemId), 'the same input merges the same way');
});

test('backfill: a window with few content lines, no persona line and no address is thin', () => {
  const thin = windowOf(['1', { text: 'lol' }], ['2', { text: 'https://example.com/x 😀 <:cat:123456789012345678> :smile:' }], ['3', { text: 'ναι ναι ναι' }]);
  assert.equal(thin.thin, true);
  const words = (id) => [id, { text: 'αυτό είναι ωραίο' }];
  assert.equal(windowOf(words('1'), words('2'), words('3'), ['4', { text: 'ok', extra: { media: ['image'] } }]).thin, false, 'four content lines, a media line among them');
  assert.equal(windowOf(words('1'), words('2'), words('3'), ['4', { text: 'ok' }]).thin, true, 'three content lines');
  assert.equal(windowOf(['1', { text: 'lol' }], ['2', { kind: 'said', text: 'ok' }]).thin, false, 'a line by the persona');
  assert.equal(windowOf(['1', { text: 'lol?' }]).thin, false, 'a question');
  assert.equal(windowOf(['1', { text: 'lol', extra: { mentions: [NIKOS] } }]).thin, false, 'a mention of a member');
  assert.equal(isThinWindow([]), true);
});

// ---- the tool --------------------------------------------------------------------------------

test('backfill: --dry-run writes nothing', async () => {
  const dir = tmpDir();
  const hot = fakeHot();
  const source = fakeSource([message(T0), message(T0 + MIN, { author: SELF, content: 'Ναι' }), message(T0 + 2 * MIN, { replyToId: null })]);
  await main(['fetch', '--guild', GUILD, '--since', '2026-09-23', '--until', '2026-09-23'], { cwd: dir, hot, source, now: () => T0 + 30 * 86_400_000 });
  await main(['merge', '--guild', GUILD, '--since', '2026-09-23', '--until', '2026-09-23'], { cwd: dir, hot, now: () => T0 + 30 * 86_400_000 });
  const before = tree(dir);
  let calls = 0;
  const llmClient = { async complete() { calls += 1; return { text: '{}' }; } };
  const plan = await main(['extract', '--guild', GUILD, '--since', '2026-09-23', '--until', '2026-09-23', '--dry-run'], { cwd: dir, hot, llmClient, now: () => T0 + 30 * 86_400_000 });
  assert.match(plan, /windows: 1/);
  assert.match(plan, /w-\d+/);
  assert.equal(calls, 0, 'no model request');
  assert.deepEqual(tree(dir), before, 'not one file written or changed');

  const fresh = tmpDir();
  const untouched = tree(fresh);
  const channels = await main(['fetch', '--guild', GUILD, '--since', '2026-09-23', '--until', '2026-09-23', '--dry-run'], { cwd: fresh, hot, source, now: () => T0 });
  assert.match(channels, /général/);
  assert.match(channels, /κρυφό/);
  assert.deepEqual(tree(fresh), untouched, 'a dry fetch lists the channels and writes nothing');
});

test('backfill: refuses to run while a forgetting marker exists and applies the ledger first', async () => {
  const dir = tmpDir();
  const hot = fakeHot();
  const guildDir = path.join(dir, 'data', 'guilds', GUILD);
  const source = fakeSource([message(T0), message(T0 + MIN, { author: NIKOS, content: 'Ολα καλά' })]);
  fs.mkdirSync(path.join(guildDir, 'forgetting'), { recursive: true });
  fs.writeFileSync(path.join(guildDir, 'forgetting', `${NIKOS}.json`), '{}');
  const before = tree(dir);
  await assert.rejects(
    main(['fetch', '--guild', GUILD, '--since', '2026-09-23', '--until', '2026-09-23'], { cwd: dir, hot, source, now: () => T0 + 86_400_000 }),
    (err) => err instanceof CliError && /forget/.test(err.message),
  );
  assert.equal(source.calls.length, 0, 'Discord is not read');
  assert.deepEqual(tree(dir), before, 'nothing written');

  // The forget finished: the ledger names the member. A backup put back by hand left one of
  // their earlier lines in the record; the run takes it out before it fetches anything.
  fs.rmSync(path.join(guildDir, 'forgetting'), { recursive: true, force: true });
  const forgetAt = new Date(T0 + 12 * 60 * MIN).toISOString();
  fs.writeFileSync(path.join(guildDir, 'forgotten.json'), JSON.stringify([{ userId: NIKOS, at: forgetAt }]));
  const stale = { ...line('5', T0 - 60 * MIN, { by: NIKOS }), v: 1, id: 'x', guildId: GUILD, recordedAt: forgetAt, revision: 1 };
  fs.mkdirSync(path.join(guildDir, 'record', '2026-09'), { recursive: true });
  fs.writeFileSync(path.join(guildDir, 'record', '2026-09', '2026-09-23.jsonl'), `${JSON.stringify(stale)}\n`);
  await main(['fetch', '--guild', GUILD, '--since', '2026-09-23', '--until', '2026-09-23'], { cwd: dir, hot, source, now: () => T0 + 86_400_000 });
  const lines = fs.readFileSync(path.join(guildDir, 'record', '2026-09', '2026-09-23.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.some((l) => l.messageId === '5'), false, 'the earlier line of the forgotten member is gone');
  assert.equal(lines.some((l) => l.by === NIKOS), false, 'nor does the fetch bring their earlier messages back');
  assert.equal(lines.length, 1, 'the other fetched line is recorded');
  assert.ok(lines.every((l) => l.origin === 'backfill'));
});

test('backfill: fetch records seen and said lines, resumes with one page of overlap and reports gaps', async () => {
  const dir = tmpDir();
  const hot = fakeHot();
  const guildDir = path.join(dir, 'data', 'guilds', GUILD);
  const messages = [message(T0), message(T0 + MIN, { author: SELF, content: 'Ναι' }), message(T0 + 2 * MIN), message(T0 + 3 * MIN)];
  const source = fakeSource(messages, { pageSize: 2 });
  const out = await main(['fetch', '--guild', GUILD, '--since', '2026-09-23', '--until', '2026-09-23'], { cwd: dir, hot, source, now: () => T0 + 86_400_000 });
  assert.match(out, /written: 4/);
  const recorded = fs.readFileSync(path.join(guildDir, 'record', '2026-09', '2026-09-23.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(recorded.map((l) => l.kind), ['seen', 'said', 'seen', 'seen']);
  const state = JSON.parse(fs.readFileSync(path.join(guildDir, 'record', 'backfill.json'), 'utf8'));
  assert.equal(state.selfId, SELF);
  assert.equal(state.cursors[CH].last, messages[3].id);
  assert.equal(state.cursors[CH].doneUntil, '2026-09-23');
  assert.deepEqual(state.gaps.map((g) => g.id), ['700000000000000002']);

  // A later --until resumes from the last page fetched (one page of overlap): nothing twice.
  source.calls.length = 0;
  const again = await main(['fetch', '--guild', GUILD, '--since', '2026-09-23', '--until', '2026-09-24'], { cwd: dir, hot, source, now: () => T0 + 86_400_000 });
  assert.equal(source.calls[0].after, state.cursors[CH].resume, 'the overlap page is fetched again');
  assert.match(again, /written: 0/);
  assert.match(again, /duplicates: 2/);

  const report = await main(['report', '--guild', GUILD, '--since', '2026-09-23', '--until', '2026-09-24'], { cwd: dir, hot, now: () => T0 + 86_400_000 });
  assert.match(report, /général/);
  assert.match(report, /κρυφό/);
});

test('backfill: extract, dedupe and voice write candidates and archive lines, never hot memory or a felt line', async () => {
  const dir = tmpDir();
  const hot = fakeHot();
  const guildDir = path.join(dir, 'data', 'guilds', GUILD);
  const messages = [message(T0, { content: 'Πάμε για ψάρεμα;' }), message(T0 + MIN, { author: SELF, content: 'Ναι!' })];
  const opts = { cwd: dir, hot, now: () => T0 + 30 * 86_400_000 };
  await main(['fetch', '--guild', GUILD, '--since', '2026-09-23', '--until', '2026-09-23'], { ...opts, source: fakeSource(messages) });
  await main(['merge', '--guild', GUILD, '--since', '2026-09-23', '--until', '2026-09-23'], opts);
  assert.ok(fs.existsSync(path.join(guildDir, 'backfill', 'manifest-2026-09.json')));
  fs.mkdirSync(path.join(guildDir, 'users'), { recursive: true });
  fs.writeFileSync(path.join(guildDir, 'users', `${ANA}.json`), JSON.stringify({ id: ANA, names: ['Ana'], episodes: [] }));
  const hotBefore = tree(path.join(guildDir, 'users'));

  const answer = JSON.stringify({ episodes: [{ member: ANA, what: 'Invited her fishing', quote: 'Πάμε για ψάρεμα;', weight: 5, brief: 'she said yes at once', sources: [messages[0].id, messages[1].id] }], lessons: [] });
  const sent = [];
  const llmClient = {
    async complete(messagesOut, options) {
      sent.push({ messagesOut, options });
      if (options.purpose === 'memory-voice') return { text: JSON.stringify({ items: { 1: 'I still smile at that' } }), usage: { prompt_tokens: 100, completion_tokens: 10 } };
      return { text: answer, usage: { prompt_tokens: 1000, completion_tokens: 100 } };
    },
  };
  await assert.rejects(main(['extract', '--guild', GUILD, '--since', '2026-09-23', '--until', '2026-09-23'], { ...opts, llmClient }), (err) => err instanceof CliError, 'the limits are required');
  const extracted = await main(['extract', '--guild', GUILD, '--since', '2026-09-23', '--until', '2026-09-23', '--max-usd', '1', '--max-windows', '5', '--max-tokens', '50000'], { ...opts, llmClient });
  assert.match(extracted, /candidates: 1/);
  assert.equal(sent[0].options.purpose, 'backfill');
  assert.equal(sent[0].options.countAgainstDailyCap, false);
  assert.match(sent[0].messagesOut[1].content, /<roster>/);
  const candidates = fs.readFileSync(path.join(guildDir, 'backfill', 'candidates.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(candidates[0].observedAt, '2026-09-23');

  const deduped = await main(['dedupe', '--guild', GUILD], opts);
  assert.match(deduped, /archived: 1/);
  const archive = () => fs.readFileSync(path.join(guildDir, 'archive', '2026-10.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const [entry] = archive();
  assert.equal(entry.event, 'backfill');
  assert.equal(entry.origin, 'backfill');
  assert.match(entry.itemId, /^ep-bf-/);
  assert.deepEqual(entry.observedAt, { date: '2026-09-23', precision: 'day' });
  assert.equal(entry.text.feeling, '');
  assert.equal((await main(['dedupe', '--guild', GUILD], opts)).match(/archived: (\d+)/)[1], '0', 'a second dedupe archives nothing twice');

  await assert.rejects(main(['voice', '--guild', GUILD], { ...opts, llmClient }), (err) => err instanceof CliError && err.exitCode === 2, 'voice needs its own --spend');
  await main(['voice', '--guild', GUILD, '--spend', '1'], { ...opts, llmClient });
  const lines = archive();
  assert.equal(lines.length, 2);
  assert.equal(lines[1].itemId, entry.itemId);
  assert.equal(lines[1].text.feeling, 'I still smile at that');
  assert.ok(lines[1].stored.reconstructedAt);
  assert.equal(sent.at(-1).options.purpose, 'memory-voice');

  assert.deepEqual(tree(path.join(guildDir, 'users')), hotBefore, 'hot memory untouched');
  const recordLines = fs.readFileSync(path.join(guildDir, 'record', '2026-09', '2026-09-23.jsonl'), 'utf8');
  assert.equal(/"kind":"felt"/.test(recordLines), false, 'no felt line');
});

test('backfill: extract skips thin windows, never re-sends a done one, and --redo extracts a day again without doubling its candidates', async () => {
  const dir = tmpDir();
  const hot = fakeHot();
  const guildDir = path.join(dir, 'data', 'guilds', GUILD);
  const messages = [
    message(T0, { content: 'Πάμε για ψάρεμα;' }),
    message(T0 + MIN, { author: SELF, content: 'Ναι!' }),
    message(T0 + 120 * MIN, { author: NIKOS, content: 'ok' }), // a window of its own: thin
  ];
  const opts = { cwd: dir, hot, now: () => T0 + 30 * 86_400_000 };
  const day = ['--guild', GUILD, '--since', '2026-09-23', '--until', '2026-09-23'];
  const limits = ['--max-usd', '1', '--max-windows', '5', '--max-tokens', '50000'];
  await main(['fetch', ...day], { ...opts, source: fakeSource(messages) });
  await main(['merge', ...day], opts);

  const plan = await main(['extract', ...day, '--dry-run'], opts);
  assert.match(plan, /windows: 1 \(of 2; 0 done before; thin: 1, skipped\)/);
  assert.match(plan, /thin, skipped/);
  assert.match(await main(['extract', ...day, '--dry-run', '--include-thin'], opts), /windows: 2 /);

  let what = 'Ana invited <@SELF> fishing';
  let calls = 0;
  const llmClient = {
    async complete() {
      calls += 1;
      return { text: JSON.stringify({ episodes: [{ member: ANA, what: what.replace('<@SELF>', 'Zoë'), quote: 'Πάμε για ψάρεμα', quoteSourceId: messages[0].id, sources: [messages[0].id, messages[1].id] }] }) };
    },
  };
  const first = await main(['extract', ...day, ...limits], { ...opts, llmClient });
  assert.equal(calls, 1, 'the thin window is not sent');
  assert.match(first, /thin skipped: 1/);
  const read = () => fs.readFileSync(path.join(guildDir, 'backfill', 'candidates.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(read()[0].what, `Ana invited <@${SELF}> fishing`, 'the persona\'s name became her token');
  assert.equal(read()[0].quote, 'Πάμε για ψάρεμα');

  const second = await main(['extract', ...day, ...limits], { ...opts, llmClient });
  assert.equal(calls, 1, 'a done window is not sent again');
  assert.match(second, /1 done before, --redo <day> extracts a day again/);

  what = 'Ana asked <@SELF> to come fishing at dawn';
  await main(['extract', '--guild', GUILD, '--redo', '2026-09-23', ...limits], { ...opts, llmClient });
  assert.equal(calls, 2, 'the redone window is sent once more');
  assert.deepEqual(read().map((c) => c.what), [`Ana asked <@${SELF}> to come fishing at dawn`], 'the day\'s earlier candidates are replaced, not doubled');
  const state = JSON.parse(fs.readFileSync(path.join(guildDir, 'backfill', 'state.json'), 'utf8'));
  assert.equal(state.extract.done.length, 1);

  assert.match(await main(['dedupe', '--guild', GUILD], opts), /archived: 1/);
  assert.match(await main(['dedupe', '--guild', GUILD], opts), /archived: 0/, 'a second dedupe archives nothing new');
  const report = await main(['report', ...day], opts);
  assert.match(report, /thin windows skipped: 1/);
  assert.match(report, /quotes dropped: 0/);
});
