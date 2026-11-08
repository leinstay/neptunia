// What the watcher reads of the analyzer's work (src/watcher/analyzer-facts.ts): `analyzerFacts` over a read connection
// counts each function's requests of the window by status and error code, counts its decisions by reading each recorded
// answer with the function's own parser, counts her effects downstream, and lists under `zeros` an enabled function that had
// inputs and did nothing. The first evidence page carries it as `analyzer`. Rows go through the memory writer, lines through
// the observation of a message event, and the effects through a real turn. Synthetic text and invented ids only.
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readConfig } from '../src/config.ts';
import { localConfigPath } from '../src/config/files.ts';
import { archivedLlm } from '../src/llm/archive.ts';
import { observeMessage } from '../src/memory/db/message-families.ts';
import { observationOf } from '../src/memory/db/observe-event.ts';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { applyMemoryWrite } from '../src/memory/db/session-write.ts';
import { dbOf } from '../src/memory/db/types.ts';
import type { MemoryHandle } from '../src/memory/db/types.ts';
import { createJournal } from '../src/memory/journal.ts';
import { serviceFamily } from '../src/service/commands.ts';
import { analyzerFacts } from '../src/watcher/analyzer-facts.ts';
import type { AnalyzerFacts, AnalyzerFunctionFacts } from '../src/watcher/analyzer-facts.ts';
import { labels } from './fixtures/labels.ts';
import { wrongly } from './fixtures/loose-types.ts';
import { openTestMemory } from './fixtures/memory-db/service.ts';
import { tempDir } from './fixtures/tmp.ts';
import { createTurnRunner } from './fixtures/turn-runner.ts';
import { freshWorld, world } from './fixtures/turn-world.ts';
import {
  NOW as TURN_NOW,
  fakeClient,
  fakeHot,
  fakeStore,
  fakeTurnChannel,
  identityCalibrator,
  normalizedTrigger,
  rawMessage,
} from './fixtures/turn-kit.ts';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const NOW = Date.parse('2026-11-05T12:00:00Z');
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const WINDOW = { from: NOW - 6 * HOUR, to: NOW };
const SILENT = { debug() {}, info() {}, warn() {}, error() {} };
/** The prompts of a deployment where every function this file looks at is on; an empty prompt turns its function off. */
const ALL_ON = { address: 'Decide.', split: 'Split.', 'media-pick': 'Pick.', merge: 'Merge.' };
const CONFIG = { split: { maxTasks: 4, minPartChars: 20 } };

beforeEach(() => {
  freshWorld();
});

function freshHandle(): MemoryHandle {
  return openMemoryDb(path.join(tempDir('nep-analyzer-facts-'), 'memory.db'));
}

/** One finished request through the writer, started a minute before it finished. */
function request(
  handle: MemoryHandle,
  id: string,
  row: { at: number; role: string; purpose: string; answer?: string | null; status?: string; errorCode?: string }
): void {
  applyMemoryWrite(handle, {
    kind: 'request-archive',
    op: 'start',
    record: {
      id,
      at: row.at - MINUTE,
      role: row.role,
      purpose: row.purpose,
      model: 'invented/model',
      system_text: 'system',
      messages: JSON.stringify([{ role: 'user', content: 'asked' }]),
    },
  });
  applyMemoryWrite(handle, {
    kind: 'request-archive',
    op: 'finish',
    id,
    at: row.at,
    status: row.status ?? 'ok',
    response_text: row.answer ?? null,
    ...(row.errorCode === undefined ? {} : { error_code: row.errorCode }),
  });
}

/** One chat line through the observation a message event gets: a group channel, or a direct chat with `partner`. */
function line(
  handle: MemoryHandle,
  id: string,
  at: number,
  where: { room: string } | { partner: string },
  self = false
): void {
  const chat =
    'room' in where
      ? { id: where.room, kind: 'channel', chatType: 'channel' }
      : { id: `dm-${where.partner}`, kind: 'dm', chatType: 'dm', partnerId: where.partner };
  const envelope = observationOf(
    {
      iface: 'synthetic',
      at,
      chat,
      message: { id, at, content: 'μια γραμμή', author: { id: self ? 'self-account' : 'member-a', self } },
    },
    { selfId: 'self-account' }
  );
  const result = observeMessage(handle, envelope, { now: () => at, log: SILENT });
  assert.equal(result.ok, true, JSON.stringify(result));
}

function read(handle: MemoryHandle, prompts: Readonly<Record<string, unknown>> = ALL_ON): AnalyzerFacts {
  return analyzerFacts(dbOf(handle), WINDOW, { config: CONFIG, prompts });
}

const fn = (facts: AnalyzerFacts, purpose: string): AnalyzerFunctionFacts =>
  facts.functions.find((one) => one.purpose === purpose) ?? assert.fail(`no function ${purpose}`);

// Bug: the count reads `model_requests` whole, so the core's replies and yesterday's requests swell the analyzer's numbers.
test('counts the requests of each analyzer function in the window by status and error code', () => {
  const handle = freshHandle();
  request(handle, 'r1', { at: NOW - HOUR, role: 'analyzer', purpose: 'address', answer: 'no' });
  request(handle, 'r2', { at: NOW - HOUR, role: 'analyzer', purpose: 'address', answer: 'yes' });
  request(handle, 'r3', {
    at: NOW - HOUR,
    role: 'analyzer',
    purpose: 'address',
    status: 'failed',
    errorCode: 'http_429',
  });
  request(handle, 'r4', { at: NOW - 2 * HOUR, role: 'core', purpose: 'reply', answer: '<msg>γεια</msg>' });
  request(handle, 'r5', { at: NOW - 30 * HOUR, role: 'analyzer', purpose: 'address', answer: 'yes' });
  const address = fn(read(handle), 'address');
  handle.close();
  assert.equal(address.requests.total, 3);
  assert.deepEqual(address.requests.byStatus, { ok: 2, failed: 1 });
  assert.deepEqual(address.requests.errorCodes, { http_429: 1 });
});

// Bug: the answers are compared as strings, so `Yes, she was` and `Overheard.` count as nothing while the engine opened a
// turn for each.
test('reads each address answer with its parser and counts yes, overheard and no', () => {
  const handle = freshHandle();
  // The lead: the address classifier answers in strict JSON since #669 (owner, 2026-11-06); an unreadable answer is
  // no decision, so a bare word is counted under none of the three.
  const answers = ['{"answer":"yes"}', '{"answer":"overheard"}', '{"answer":"no"}', '{"answer":"no"}', 'nope'];
  answers.forEach((answer, n) => {
    request(handle, `a${n}`, { at: NOW - HOUR, role: 'analyzer', purpose: 'address', answer });
  });
  const address = fn(read(handle), 'address');
  handle.close();
  assert.deepEqual(address.decisions, { yes: 1, overheard: 1, no: 2 });
});

// Bug: every split answer is counted as several, or a list the parser refuses is counted as a split that never happened.
// The lead: split, merge and missed answer in strict JSON (owner, 2026-11-06).
test('counts the splitter by one or several, as its parser reads the answer', () => {
  const handle = freshHandle();
  const several = JSON.stringify({
    parts: ['the first question stands on its own here', 'the second question stands on its own too'],
  });
  const answers = ['{"parts":[]}', '{"parts":["one thing"]}', several, '1. a numbered list the parser refuses'];
  answers.forEach((answer, n) => {
    request(handle, `s${n}`, { at: NOW - HOUR, role: 'analyzer', purpose: 'split', answer });
  });
  const split = fn(read(handle), 'split');
  handle.close();
  assert.deepEqual(split.decisions, { one: 3, several: 1 });
});

// Bug: a classifier that stopped being asked looks like a quiet day, and nobody learns that the people in a group are no
// longer heard.
test('lists an enabled function with inputs and no request under zeros, with the inputs it had', () => {
  const handle = freshHandle();
  for (const n of [1, 2, 3]) line(handle, `g${n}`, NOW - n * HOUR, { room: 'room-1' });
  const zero = read(handle).zeros.find((one) => one.purpose === 'address') ?? assert.fail('address is not listed');
  handle.close();
  assert.equal(zero.reason, 'no-requests');
  assert.equal(zero.inputs.groupLines, 3);
});

// Bug: a function the owner switched off by removing its prompt is reported as a fault every day.
test('leaves a disabled function out of zeros, though its inputs exist', () => {
  const handle = freshHandle();
  for (const n of [1, 2, 3]) line(handle, `g${n}`, NOW - n * HOUR, { room: 'room-1' });
  const facts = read(handle, { ...ALL_ON, address: '' });
  handle.close();
  assert.equal(
    facts.zeros.some((one) => one.purpose === 'address'),
    false
  );
});

// Bug: a function with nothing to judge is reported as a fault: a quiet day, or a day of direct chats only, raises an alarm.
test('leaves a function with no inputs out of zeros', () => {
  const handle = freshHandle();
  line(handle, 'd1', NOW - HOUR, { partner: 'member-b' });
  line(handle, 'g-old', NOW - 30 * HOUR, { room: 'room-1' });
  const facts = read(handle);
  handle.close();
  assert.equal(
    facts.zeros.some((one) => one.purpose === 'address'),
    false
  );
});

// Bug: her replies are counted from the whole database, so a media pick that stopped this morning hides behind last week.
test('lists the media pick under zeros when her replies of the window got no request', () => {
  const handle = freshHandle();
  line(handle, 'h1', NOW - HOUR, { room: 'room-1' }, true);
  line(handle, 'h2', NOW - 2 * HOUR, { room: 'room-1' }, true);
  const zero =
    read(handle).zeros.find((one) => one.purpose === 'media-pick') ?? assert.fail('media-pick is not listed');
  handle.close();
  assert.equal(zero.inputs.herReplies, 2);
});

/**
 * One real turn at `TURN_NOW` that reacts with an emoji and whose reply the media pick turns into a GIF, journaled and
 * archived into a test memory database. Answers the database's file, closed.
 */
async function turnWithGifAndReaction(): Promise<string> {
  const memory = await openTestMemory({ now: () => TURN_NOW });
  let n = 0;
  const journal = createJournal({
    memoryDb: memory.memoryDb,
    dataDir: memory.dataDir,
    config: () => ({ thinkChars: 4000 }),
    now: () => TURN_NOW,
    uuid: () => `effect-${(n += 1)}`,
  });
  const port = world().port as unknown as { capabilities: () => object };
  const declared = port.capabilities.bind(port);
  port.capabilities = () => ({ ...declared(), mediaPick: { gifForms: ['file', 'link'] } });
  const raws = [
    rawMessage({ id: 'm0', ts: TURN_NOW - 5000, content: 'καλημέρα' }),
    rawMessage({ id: 'm1', ts: TURN_NOW - 1000, content: 'θα έρθεις απόψε;' }),
  ];
  const channel = fakeTurnChannel({ historyMessages: raws });
  const hot = fakeHot(
    {},
    {},
    { media: { maxPerTurn: 6, filePreviewChars: 500, pick: { candidates: 5 } }, models: { base: { analyzer: 'x/a' } } }
  );
  Object.assign(hot.prompts, { 'media-pick': 'Pick for {{name}}.', labels });
  const link = 'https://tenor.com/view/invented-1';
  const entry = {
    id: 'g1',
    kind: 'link',
    url: link,
    itemId: 'item-1',
    messageId: 'm-1',
    placeId: 'c1',
    count: 3,
    last: TURN_NOW - HOUR,
    firstSeen: TURN_NOW - 2 * HOUR,
    caption: 'ναι φυσικά γνέφει',
    nativeIds: ['item-1'],
    links: [link],
    places: { c1: { count: 3, last: TURN_NOW - HOUR } },
  };
  const store = Object.assign(fakeStore({ mediaCache: { 'item-1': { text: 'ναι φυσικά γνέφει' } } }), {
    getGifs: () => ({ nextId: 2, backfill: null, entries: { k1: entry } }),
    findGif: (...given: Array<string>) => (given.at(-1) === 'g1' ? { key: 'k1', ...entry } : null),
    getEmojiRails: () => null,
    setEmojiRails: () => {},
    recordOwnGif: () => {},
  });
  const answered = {
    complete: (_messages: unknown, options: Record<string, unknown>) =>
      Promise.resolve({
        // The lead: elsewhere-pick, media-pick, query-builder and the diary planner answer in strict JSON (owner, 2026-11-06).
        text:
          options.purpose === 'media-pick'
            ? '{"pick":"gif","name":"g1"}'
            : '<react to="#1">👍</react><msg>ναι, φυσικά, έλα</msg>',
        usage: {},
        estimated: 10,
      }),
  };
  const llm = archivedLlm(answered, {
    write: (update) => memory.memoryDb.memoryWrite(update),
    log: { warn() {} },
    now: () => TURN_NOW,
  });
  const turns = createTurnRunner({
    hot,
    store,
    llm,
    calibrator: identityCalibrator(),
    client: fakeClient(),
    now: () => TURN_NOW,
    journal,
  });
  await turns.runTurn(wrongly({ channel, mode: 'reply', trigger: normalizedTrigger(raws[1]), triggerKind: 'mention' }));
  await journal.flush?.();
  const file = path.join(memory.dataDir, 'memory.db');
  await memory.close();
  return file;
}

/** The facts of the database at `file` over a window around `at`. */
function factsAt(file: string, at: number): AnalyzerFacts {
  const handle = openMemoryDb(file, { readOnly: true });
  try {
    return analyzerFacts(dbOf(handle), { from: at - HOUR, to: at + HOUR }, { config: CONFIG, prompts: ALL_ON });
  } finally {
    handle.close();
  }
}

// Bug: the effects are read from a place nothing writes, so a media pick that works reads as one that never acts.
test('counts a GIF reply, an emoji reaction and the pick that chose the GIF in the window', async () => {
  const facts = factsAt(await turnWithGifAndReaction(), TURN_NOW);
  assert.equal(facts.effects.gifReplies, 1);
  assert.equal(facts.effects.emojiReactions, 1);
  const pick = fn(facts, 'media-pick');
  assert.equal(pick.requests.total, 1);
  assert.equal(pick.decisions.gif, 1);
});

// Bug: the effects are summed over the whole journal, so yesterday's GIF covers for a pick that stopped today.
test('counts no effect of hers outside the window', async () => {
  const facts = factsAt(await turnWithGifAndReaction(), TURN_NOW + 3 * HOUR);
  assert.equal(facts.effects.gifReplies, 0);
  assert.equal(facts.effects.emojiReactions, 0);
});

// Bug: the facts exist and no report sees them, because the evidence page never carries them.
test('the first evidence page carries the analyzer facts', async () => {
  const data = tempDir('nep-analyzer-evidence-');
  fs.mkdirSync(path.dirname(localConfigPath(data)), { recursive: true });
  fs.writeFileSync(localConfigPath(data), '{}');
  fs.mkdirSync(path.join(data, 'agents', 'watcher', 'reports'), { recursive: true });
  openMemoryDb(path.join(data, 'memory.db')).close();
  const answer = await serviceFamily(
    {
      rootDir: REPO,
      privateDir: data,
      dataDir: data,
      config: () => readConfig(REPO, { privateDir: data }),
      now: () => NOW,
      env: { NEPTUNIA_UNIT_SCOPE: 'user', XDG_CONFIG_HOME: data },
      coreUp: false,
      run: () => Promise.resolve({ code: 1, stdout: '', stderr: 'unavailable here' }),
    },
    'service.watcher.evidence',
    {}
  );
  assert.equal(answer.status, 'ok');
  const { analyzer } = JSON.parse(answer.text) as { analyzer?: { functions?: unknown } | null };
  assert.ok(Array.isArray(analyzer?.functions), answer.text.slice(0, 200));
});
