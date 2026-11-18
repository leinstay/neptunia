// The humanizer (src/behavior/humanizer.ts) in whole turns: an addressed turn, an inner turn, a diary post and a turn
// split into parts post what the writer returned. The model is a fake that answers the humanizer's two requests by
// purpose and every other request from the turn's script. Each test names the bug it catches.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../src/tools/operations/index.ts';
import { call, toolAnswer } from './fixtures/tool-answers.ts';
import { createTurnRunner } from '../src/behavior/turn.ts';
import { objectMediaCache } from '../src/memory/store-media.ts';
import { labels } from './fixtures/labels.ts';
import { entryOf } from './fixtures/diary-mirror.ts';
import { planAnswerText } from './fixtures/plan-answer.ts';
import { contentText, coreTurn, NOW, sequenceLlm } from './fixtures/turn-harness.ts';
import type { ChatMessage } from './fixtures/turn-harness.ts';
import { runSplitTurn, splitHot, splitLlm, SPLIT_PARTS } from './fixtures/turn-split.ts';
import { onWorld, world } from './fixtures/turn-world.ts';

const route = (model: string) => [{ via: 'api', key: 'k', model, effort: null }];
const PROMPTS = { 'humanizer-linter': 'Check the text of {{name}}.', 'humanizer-writer': 'Write {{name}} again.' };

// 24 words each, so the two make a text over the 40 words.
const LONG_A =
  'το πρωί πήγα στην αγορά και βρήκα φρέσκα ψάρια, ντομάτες, ελιές και ψωμί από τον φούρνο της γειτονιάς που ανοίγει πολύ νωρίς κάθε μέρα';
const LONG_B =
  'μετά γύρισα σπίτι, μαγείρεψα για όλους και κάτσαμε στην αυλή ως το βράδυ μιλώντας για το ταξίδι που σχεδιάζουμε στα νησιά το καλοκαίρι';
// The fake writer's texts, 15 and 14 words: a rewrite is posted only when it keeps at least half the words of the draft.
const WRITTEN_A = 'πρώτα πήγα στην αγορά το πρωί και πήρα ψάρια, ντομάτες, ελιές και ψωμί του φούρνου';
const WRITTEN_B = 'μετά μαγείρεψα για όλους και μείναμε στην αυλή ως αργά μιλώντας για το ταξίδι';
const WRITTEN = `${WRITTEN_A} ${WRITTEN_B}`;
const LINT_YES = JSON.stringify({
  rewrite: true,
  findings: [{ kind: 'shape', quote: '', problem: 'δύο μπλοκ ίδια', fix: 'σπάσε τη συμμετρία' }],
});

type Completion = { text: unknown; usage: object; estimated: number };
type Request = { messages: Array<ChatMessage>; options: Record<string, unknown> };
type Complete = (messages: Array<ChatMessage>, options: Record<string, unknown>) => Promise<unknown>;

/** Answers the linter and the writer, and hands every other request to `rest`. */
type Write = string | ((draft: string) => string);

function humanizerLlm(rest: { complete: Complete }, write: Write) {
  const requests: Array<Request> = [];
  return {
    requests,
    complete: (messages: Array<ChatMessage>, options: Record<string, unknown> = {}): Promise<Completion> => {
      if (options.purpose === 'humanizer-linter' || options.purpose === 'humanizer-writer') {
        requests.push({ messages, options });
        const draft = contentText(messages[1]?.content);
        const text =
          options.purpose === 'humanizer-linter' ? LINT_YES : typeof write === 'string' ? write : write(draft);
        return Promise.resolve({ text, usage: {}, estimated: 5 });
      }
      return rest.complete(messages, options) as Promise<Completion>;
    },
  };
}

const WAKE = {
  kind: 'intention_due',
  items: [{ kind: 'intention_due', reason: 'due', intentionIds: ['i1'], errandId: null }],
  intentions: [{ id: 'i1', purpose: 'πες κάτι', dueAt: NOW - 60_000 }],
  now: NOW,
  timezone: 'UTC',
  channels: [],
};

const ANSWERS = [`<msg reply="#1">${LONG_A}</msg><msg reply="#2">${LONG_B}</msg>`, '<skip/>'];

async function turnOf({
  enabled = true,
  inner = null as Record<string, unknown> | null,
  write = '' as Write,
  answers = ANSWERS as Array<unknown>,
}) {
  const llm = humanizerLlm(sequenceLlm(answers), write);
  const run = await coreTurn({
    answers,
    allowed: ['message.create'],
    inner,
    prompts: { ...PROMPTS, ...(inner ? { inner: 'Do what the wake says.' } : {}) },
    config: inner ? { wakes: { mode: 'live', chatMessages: 2 } } : {},
    withHot: (hot) => {
      Object.assign(hot.config, { humanizer: { enabled } });
      Object.assign((hot.config.models as { routes: object }).routes, {
        'linter': route('l/m'),
        'editor': route('w/m'),
      });
    },
    runner: { llm },
  });
  return { run, requests: llm.requests };
}

const userOf = (request: Request): string => {
  const [, user] = request.messages;
  return contentText(user?.content);
};
const sentOf = (run: Awaited<ReturnType<typeof coreTurn>>) =>
  run.sends.map((send) => [send.text, (send.replyTo as { messageId?: string } | undefined)?.messageId ?? null]);

test('an addressed turn posts her answer as written and asks no humanizer request when it is off', async () => {
  // Catches: the switch is ignored in a turn, and every long answer of a deployment that never turned it on is rewritten.
  const { run, requests } = await turnOf({ enabled: false, write: '<msg reply="#1">άλλο</msg>' });
  assert.deepEqual(sentOf(run), [
    [LONG_A, 'm0'],
    [LONG_B, 'm1'],
  ]);
  assert.equal(requests.length, 0);
});

test('an addressed turn posts the writer messages, each on the line it answers', async () => {
  // Catches: the turn posts her draft after a rewrite, or the rewrite loses the two reply targets.
  const { run, requests } = await turnOf({
    write: `<msg reply="#1">${WRITTEN_A}</msg><msg reply="#2">${WRITTEN_B}</msg>`,
  });
  assert.deepEqual(sentOf(run), [
    [WRITTEN_A, 'm0'],
    [WRITTEN_B, 'm1'],
  ]);
  assert.deepEqual(
    requests.map((request) => request.options.purpose),
    ['humanizer-linter', 'humanizer-writer']
  );
});

const THOUGHT = [`<think>κρυφή σκέψη</think><msg reply="#1">${LONG_A}</msg><msg reply="#2">${LONG_B}</msg>`, '<skip/>'];

test('the writer request of an addressed turn holds her think', async () => {
  // Catches: the turn hands the humanizer her messages without her think, and the writer rewrites without what she meant.
  const { requests } = await turnOf({
    answers: THOUGHT,
    write: `<msg reply="#1">${WRITTEN_A}</msg><msg reply="#2">${WRITTEN_B}</msg>`,
  });
  const [linter, writer] = requests.map(userOf);
  assert.ok(writer.includes('κρυφή σκέψη'));
  assert.ok(!linter.includes('κρυφή σκέψη'));
});

test('an inner turn posts the writer messages in place of her lowered message.create calls', async () => {
  // Catches: an inner turn's speech skips the humanizer, as it is lowered into calls before postSpeech.
  const { run, requests } = await turnOf({
    inner: WAKE,
    write: `<msg reply="#1">${WRITTEN_A}</msg><msg reply="#2">${WRITTEN_B}</msg>`,
  });
  assert.deepEqual(sentOf(run), [
    [WRITTEN_A, 'm0'],
    [WRITTEN_B, 'm1'],
  ]);
  assert.ok(userOf(requests[0]).includes(LONG_A), 'the linter read the lowered messages');
});

test('a turn split into two parts sends the speech of each part to the humanizer by itself', async () => {
  // Catches: the parts' speech is joined, or only the first part's passes, so one part goes out unchecked.
  const hot = splitHot();
  Object.assign(hot.config, { humanizer: { enabled: true } });
  Object.assign((hot.config.models as { routes: object }).routes, {
    'linter': route('l/m'),
    'editor': route('w/m'),
  });
  Object.assign(hot.prompts, PROMPTS);
  const rest = splitLlm({
    split: JSON.stringify({ parts: SPLIT_PARTS.slice(0, 2) }),
    talk: (index) => `<msg reply="#2">μέρος ${index} ${LONG_A} ${LONG_B}</msg>`,
  });
  const llm = humanizerLlm(rest, `<msg reply="#2">${WRITTEN}</msg>`);
  const { channel } = await runSplitTurn({ hot, llm: { ...rest, complete: llm.complete } });
  const linted = llm.requests.filter((request) => request.options.purpose === 'humanizer-linter').map(userOf);
  assert.equal(linted.length, 2);
  assert.ok(linted[0].includes('μέρος 0') && !linted[0].includes('μέρος 1'));
  assert.ok(linted[1].includes('μέρος 1') && !linted[1].includes('μέρος 0'));
  assert.deepEqual(
    channel.sent.map((payload) => payload.content),
    [WRITTEN, WRITTEN]
  );
});

test("a diary post stores the writer's text as its entry", async () => {
  // Catches: the diary post is held before the humanizer runs, so the entry keeps her draft.
  const hot = {
    config: {
      bot: { timezone: 'UTC' },
      context: {
        channelMessages: 50,
        caps: { interlocutor: 2500, aboutChat: 2500, people: 4000, neighbors: 3000 },
        vision: { fetchTimeoutMs: 10_000 },
        pull: { sameAudience: true },
      },
      llm: { maxRequestTokens: 50000 },
      typing: { reactionDelayMs: [0, 0], msPerChar: [0, 0], minMs: 0, maxMs: 0, betweenMessagesMs: [0, 0] },
      image: {},
      diary: { placeId: 'd1', world: false, planMaxOutputTokens: 250, planTimeoutMs: 15000 },
      humanizer: { enabled: true },
      models: { routes: { 'linter': route('l/m'), 'editor': route('w/m') } },
    },
    prompts: {
      'system-prompt': 'SYSTEM for {{name}}',
      'character-card': 'CARD',
      format: 'FORMAT',
      diary: 'DIARY for {{name}}',
      'diary-planner': 'PLAN for {{name}}',
      'diary-seeds': '# place\na pier',
      labels,
      ...PROMPTS,
    },
  };
  const rest = {
    complete: (_messages: Array<ChatMessage>, options: Record<string, unknown> = {}) =>
      Promise.resolve({
        text:
          options.purpose === 'diary-planner'
            ? planAnswerText({ kind: 'status', brief: 'x', search: '', picture: false }, options)
            : `<msg>${LONG_A}</msg><msg>${LONG_B}</msg>`,
        usage: {},
        estimated: 5,
      }),
  };
  const llm = humanizerLlm(rest, `<msg>${WRITTEN_A}</msg><msg>${WRITTEN_B}</msg>`);
  const store = {
    appended: [] as Array<unknown>,
    getPlace: () => ({}),
    getUser: () => null,
    getPrivate: () => null,
    listChannels: () => [],
    listUserProfiles: () => [],
    getLore: () => [],
    liveRules: () => [],
    ...objectMediaCache({}),
    getDiary: () => ({ posts: [], updatedAt: 0 }),
    appendDiaryPost: (post: unknown, opts: unknown) => store.appended.push({ post, opts }),
    state: { data: {}, markDirty() {} },
  };
  const turns = onWorld((options) => createTurnRunner(options as Parameters<typeof createTurnRunner>[0]))({
    hot,
    store,
    llm,
    calibrator: { ratio: 1, apply: (n: number) => n, observe: () => {} },
    images: null,
    lookup: null,
    rng: () => 0.5,
    now: () => NOW,
  });
  world().channel({ id: 'd1', name: 'journal', placeId: 'g1', permissions: { attach: true }, historyMessages: [] });
  const result = await turns.runTurn({ channel: { id: 'd1' }, mode: 'diary', diary: {} });
  assert.deepEqual(entryOf(result).messages, [WRITTEN_A, WRITTEN_B]);
});

test('a message.create call of hers is made with the writer text and its other arguments unchanged', async () => {
  // Catches: a post she writes as a tool call skips the humanizer, or its reply target is lost on the way.
  const answers = [toolAnswer('', [call('message.create', { reply: '#1', text: `${LONG_A} ${LONG_B}` })]), '<skip/>'];
  const { run } = await turnOf({ answers, write: `<msg>${WRITTEN}</msg>` });
  assert.deepEqual(sentOf(run), [[WRITTEN, 'm0']]);
});

test('two message.create calls of hers in one answer are rewritten one at a time', async () => {
  // Catches: the two posts are read as one text, so text moves from one place to the other.
  const answers = [
    toolAnswer('', [
      call('message.create', { text: `πρώτο ${LONG_A} ${LONG_B}` }),
      call('message.create', { text: `δεύτερο ${LONG_A} ${LONG_B}` }),
    ]),
    '<skip/>',
  ];
  const write = (draft: string) => `<msg>${draft.includes('πρώτο') ? 'ένα' : 'δύο'} ${WRITTEN}</msg>`;
  const { run, requests } = await turnOf({ answers, write });
  const linted = requests.filter((request) => request.options.purpose === 'humanizer-linter').map(userOf);
  assert.equal(linted.length, 2);
  assert.ok(linted.every((text) => !(text.includes('πρώτο') && text.includes('δεύτερο'))));
  assert.deepEqual(
    run.sends.map((send) => send.text),
    [`ένα ${WRITTEN}`, `δύο ${WRITTEN}`]
  );
});
