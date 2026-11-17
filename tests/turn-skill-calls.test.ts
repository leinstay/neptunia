// What the result of one of her calls tells her (src/turn/skill-calls.ts), here for a post the interface kept for a
// chat that is not open (`deferred` on the send's answer, src/interface/cli-chat.ts): the call stays ok and its
// result carries `labels.tools.result.storedUntilOpen`. One turn over the fake adapter.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { labels } from './fixtures/labels.ts';
import { call, toolAnswer, textAnswer } from './fixtures/tool-answers.ts';
import {
  appended,
  contentText,
  coreTurn,
  journalOverMemory,
  NOW,
  rawMessage,
  toolResults,
} from './fixtures/turn-harness.ts';
import type { FakeLlm } from './fixtures/turn-harness.ts';
import { withCapturedLogs } from './fixtures/capture-logs.ts';
import type { LogEntry } from './fixtures/capture-logs.ts';

test('a message.create the interface kept for a closed chat is ok, and its result says it is shown when the chat opens', async () => {
  // Bug: she reads a plain success and believes the owner saw the message, though no chat was open to show it.
  const run = await coreTurn({
    answers: [toolAnswer('<think>x</think>', [call('message.create', { text: 'good night' })]), '<skip/>'],
    allowed: ['message.create'],
    setup(port) {
      const send = port.send.bind(port);
      port.send = async (...args: Parameters<typeof send>) => ({ ...(await send(...args)), deferred: true });
    },
  });
  const [first] = run.sends;
  assert.equal(first?.text, 'good night');
  const result = contentText(appended(run.llm, 1).find((message) => message.role === 'tool')?.content);
  const { result: words } = labels.tools;
  assert.ok(result.startsWith(words.ok), 'the call is ok');
  assert.ok(result.includes(words.storedUntilOpen), 'the result says the post waits for the chat');
});

// A voice message she sends through `voice.say` leaves a said line whose voice item keeps what she voiced
// (src/turn/skill-calls.ts, src/turn/journal-notes.ts#recordSaid), so memory can answer what she said in it. Fake model, fake
// operation; the line as `record.append` receives it.

const VOICED = '[sighs] "собор на закате"';

type SaidLine = {
  kind?: unknown;
  messageId?: unknown;
  text?: unknown;
  media?: unknown;
  voiced?: unknown;
  marks?: unknown;
};

async function voiceTurn(outcome: unknown) {
  const appended: Array<SaidLine> = [];
  await coreTurn({
    answers: [toolAnswer('', [call('voice.say', { text: 'ignored' })]), textAnswer('')],
    allowed: ['voice.say'],
    runner: {
      runOwnOp: () => Promise.resolve(outcome),
      record: {
        append: (_place: string, lines: Array<SaidLine>) => {
          appended.push(...lines);
          return Promise.resolve({ written: lines.length, duplicates: 0 });
        },
      },
    },
  });
  return appended.filter((line) => line.kind === 'said');
}

test('a sent voice message is one said line, its words empty and its voiced text kept', async () => {
  const said = await voiceTurn({
    status: 'ok',
    code: 'ok',
    summary: 'voice message posted',
    data: {
      text: 'voice message posted',
      ref: { chatId: 'c1', messageId: 'voice-1' },
      voice: { text: VOICED, durationSecs: 2.5 },
    },
  });
  assert.equal(said.length, 1);
  assert.equal(said[0].messageId, 'voice-1');
  assert.equal(said[0].text, '');
  assert.deepEqual(said[0].media, ['voice']);
  assert.equal(said[0].voiced, VOICED);
});

test('a sent voice message is marked as made by her, with her own person in it', async () => {
  // Bug: the clip she spoke reaches memory with no mark and reads later as anybody's voice clip.
  const said = await voiceTurn({
    status: 'ok',
    code: 'ok',
    summary: 'voice message posted',
    data: {
      text: 'voice message posted',
      ref: { chatId: 'c1', messageId: 'voice-1' },
      voice: { text: VOICED, durationSecs: 2.5 },
    },
  });
  assert.deepEqual(said[0]?.marks, { self: true, accounts: [] });
});

test('a voice message that failed leaves no said line', async () => {
  const said = await voiceTurn({ status: 'failed', code: 'speech-not-configured', summary: 'no' });
  assert.deepEqual(said, []);
});

// A destructive call holds the cooldown of its skill in its chat (`destructiveRuns` of src/turn/skill-calls.ts, checked
// by src/tools/gateway.ts#cooldownRefusal) only when its operation answered `ok`. Every other result, a timeout and a
// thrown error leave the cooldown as it was. Her turns over one runner on an injected clock, each one step of
// `message.delete` calls on her own line, then a skip; fake operations answer.

const COOLDOWN_MINUTES = 10;
const MINUTE_MS = 60_000;
const HER_LINE = rawMessage({
  id: 's1',
  authorId: 'self-id',
  authorName: 'Bot',
  ts: NOW - 9000,
  content: 'a typo here',
});
const DELETED = { status: 'ok', code: 'ok', summary: 'message deleted' };
const NOT_FOUND = { status: 'failed', code: 'http-404', summary: 'no such message' };
const HALF_DONE = { status: 'partial', code: 'partial', summary: 'one of two removed' };

/** What the fake operation does for one `message.delete`: answers this, never answers, or throws. */
type DeleteAnswer = object | 'never' | 'throw';
/** One turn of hers: the clock while it runs and how many deletions its first step asks for. */
type DeleteTurn = { at: number; calls?: number };

const deletions = (count: number) =>
  toolAnswer(
    '',
    Array.from({ length: count }, () => call('message.delete', { message: 's1' }))
  );

/** The codes of the refusals of `message.delete` among `logs`, in order. */
const refusalCodes = (logs: Array<LogEntry>): Array<string> =>
  logs
    .filter((entry) => entry.msg === 'skill: refused' && entry.skill === 'message.delete')
    .map((entry) => String(entry.code));

/** Runs `turns` over one runner; `answers` answer the operations in order. How many ran, the refusals of each turn. */
async function deleteTurns(
  turns: Array<DeleteTurn>,
  answers: Array<DeleteAnswer>,
  { callTimeoutMs = 120_000 }: { callTimeoutMs?: number } = {}
) {
  let ran = 0;
  const clock = { t: turns[0].at };
  const runOwnOp = (op: string): Promise<unknown> => {
    if (op !== 'message.delete') return Promise.resolve(DELETED);
    const answer = answers[ran];
    ran += 1;
    if (answer === 'never') return new Promise(() => {});
    if (answer === 'throw') return Promise.reject(new Error('socket closed'));
    return Promise.resolve(answer);
  };
  const run = await coreTurn({
    answers: turns.flatMap((turn) => [deletions(turn.calls ?? 1), '<skip/>']),
    allowed: ['message.delete'],
    earlier: [HER_LINE],
    withHot(hot) {
      const { tools } = hot.config;
      tools.destructiveCooldownMinutes = COOLDOWN_MINUTES;
      tools.callTimeoutMs = callTimeoutMs;
    },
    runner: { now: () => clock.t, runOwnOp },
  });
  const refusals = [refusalCodes(run.logs)];
  for (const turn of turns.slice(1)) {
    clock.t = turn.at;
    const { logs } = await withCapturedLogs(() => run.again());
    refusals.push(refusalCodes(logs));
  }
  return { ran: () => ran, refusals, llm: run.llm };
}

/** Whether the first tool result of request `i` begins as the label of `status` does. */
function firstResultIs(llm: FakeLlm, i: number, status: 'ok' | 'failed' | 'unknown'): boolean {
  const words = labels.tools.result;
  const [prefix] = words[status].split('{reason}');
  const line = toolResults(llm, i)[0] ?? '';
  return line.slice(line.indexOf(': ') + 2).startsWith(prefix);
}

test('a destructive call that failed holds no cooldown: the corrected call four seconds later runs', async () => {
  // Bug: a message.delete that came back failed (http-404) refused the corrected call with cooldown, and nothing was deleted.
  const { ran, refusals, llm } = await deleteTurns([{ at: NOW }, { at: NOW + 4000 }], [NOT_FOUND, DELETED]);
  assert.equal(firstResultIs(llm, 1, 'failed'), true, 'the first call failed');
  assert.deepEqual(refusals, [[], []]);
  assert.equal(ran(), 2);
});

test('a destructive call that answered ok refuses the next one of its skill from its chat with cooldown', async () => {
  // Bug: a call that did delete took no cooldown, so a second deletion followed at once.
  const { ran, refusals } = await deleteTurns([{ at: NOW }, { at: NOW + 4000 }], [DELETED, DELETED]);
  assert.deepEqual(refusals, [[], ['cooldown']]);
  assert.equal(ran(), 1);
});

test('a destructive call that timed out holds no cooldown: the next call runs', async () => {
  // Bug: a call that timed out (unknown) took the cooldown, though the cooldown counts a full success only.
  const { ran, refusals, llm } = await deleteTurns([{ at: NOW }, { at: NOW + 4000 }], ['never', DELETED], {
    callTimeoutMs: 20,
  });
  assert.equal(firstResultIs(llm, 1, 'unknown'), true, 'the first call timed out');
  assert.deepEqual(refusals, [[], []]);
  assert.equal(ran(), 2);
});

test('a destructive call whose operation threw holds no cooldown: the next call runs', async () => {
  // Bug: a failed result that holds a thrown error took the cooldown, though nothing reported a success.
  const { ran, refusals, llm } = await deleteTurns([{ at: NOW }, { at: NOW + 4000 }], ['throw', DELETED]);
  assert.equal(firstResultIs(llm, 1, 'failed'), true, 'the first call failed');
  assert.deepEqual(refusals, [[], []]);
  assert.equal(ran(), 2);
});

test('a destructive call that answered partial holds no cooldown: the next call runs', async () => {
  // Bug: a partial result counted as a success and refused the call that finishes the job.
  const { ran, refusals } = await deleteTurns([{ at: NOW }, { at: NOW + 4000 }], [HALF_DONE, DELETED]);
  assert.deepEqual(refusals, [[], []]);
  assert.equal(ran(), 2);
});

test('a call the cooldown refused moves nothing: the next one runs once the cooldown of the first call is over', async () => {
  // Bug: the call the cooldown refused wrote its own time and stretched the cooldown past the first call's.
  const { ran, refusals } = await deleteTurns(
    [{ at: NOW }, { at: NOW + MINUTE_MS }, { at: NOW + COOLDOWN_MINUTES * MINUTE_MS }],
    [DELETED, DELETED]
  );
  assert.deepEqual(refusals, [[], ['cooldown'], []]);
  assert.equal(ran(), 2);
});

test('a failed call after an earlier cooldown ran out leaves that cooldown over, so the next call runs at once', async () => {
  // Bug: the failed call kept its own time as the last run and refused the corrected call made right after it.
  const later = NOW + COOLDOWN_MINUTES * MINUTE_MS;
  const { ran, refusals } = await deleteTurns(
    [{ at: NOW }, { at: later }, { at: later }],
    [DELETED, NOT_FOUND, DELETED]
  );
  assert.deepEqual(refusals, [[], [], []]);
  assert.equal(ran(), 3);
});

test('two deletions in one step, the first ok: the second is refused with cooldown', async () => {
  // Bug: the time of a successful call was written too late for the next call of the same step to see it.
  const { ran, refusals } = await deleteTurns([{ at: NOW, calls: 2 }], [DELETED, DELETED]);
  assert.deepEqual(refusals, [['cooldown']]);
  assert.equal(ran(), 1);
});

test('two deletions in one step, the first failed: the second runs', async () => {
  // Bug: a failed call took the cooldown at dispatch and refused the corrected call of the same step.
  const { ran, refusals, llm } = await deleteTurns([{ at: NOW, calls: 2 }], [NOT_FOUND, DELETED]);
  assert.equal(firstResultIs(llm, 1, 'failed'), true, 'the first call failed');
  assert.deepEqual(refusals, [[]]);
  assert.equal(ran(), 2);
});

const LONG_EXTRACT = 'Η παράδοση του κήπου λέει πως οι λεμονιές φυτεύτηκαν πριν από έναν αιώνα. '.repeat(30).trim();

/** A reply turn whose one `lore.list` call reads `LONG_EXTRACT`, with `summarize` wired; the extract its closing line keeps. */
async function keptExtract(summarize: (text: string, options: { maxChars: number; kind: 'text' }) => Promise<string>) {
  const { journal, lines } = journalOverMemory();
  await coreTurn({
    answers: [toolAnswer('<think>x</think>', [call('lore.list')]), '<skip/>'],
    journal,
    runner: { summarize },
    wrapCommand: () => () => Promise.resolve({ status: 'ok', code: 'ok', summary: LONG_EXTRACT }),
  });
  return lines.map(({ record }) => extractOf(record)).find((extract) => extract !== undefined);
}

/** The extract of the lookup a closing line keeps, or undefined for any other line. */
function extractOf(record: unknown): string | undefined {
  if (!record || typeof record !== 'object' || !('result' in record)) return undefined;
  const { result } = record;
  if (!result || typeof result !== 'object' || !('lookup' in result)) return undefined;
  const { lookup } = result;
  if (!lookup || typeof lookup !== 'object' || !('extract' in lookup)) return undefined;
  return typeof lookup.extract === 'string' ? lookup.extract : undefined;
}

// The owner on 2026-11-16: no text she reads is cut silently.
test('a lookup whose extract runs past extractChars goes to summarize once and keeps its answer', async () => {
  const calls: Array<{ maxChars: number; kind: 'text' }> = [];
  const extract = await keptExtract((_text, options) => {
    calls.push(options);
    return Promise.resolve('Οι λεμονιές του κήπου είναι εκατό χρονών.');
  });
  assert.deepEqual(calls, [{ maxChars: 1200, kind: 'text' }]);
  assert.equal(extract, 'Οι λεμονιές του κήπου είναι εκατό χρονών.');
});

// The owner on 2026-11-16: no text she reads is cut silently.
test('a lookup whose extract is summarized still over extractChars keeps that summary whole', async () => {
  const still = `${LONG_EXTRACT} Και κάτι ακόμη.`;
  const extract = await keptExtract(() => Promise.resolve(still));
  assert.equal(extract, still);
});
