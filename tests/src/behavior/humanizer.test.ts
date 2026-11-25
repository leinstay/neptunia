// The humanizer (src/behavior/humanizer.ts): its settings and requests, and whole turns that post what the writer
// returned. The model is a fake that answers the humanizer's requests by purpose.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { call, toolAnswer } from '../../fixtures/tool-answers.ts';
import { createTurnRunner } from '../../../src/behavior/turn.ts';
import { objectMediaCache } from '../../../src/memory/store-media.ts';
import { labels } from '../../fixtures/labels.ts';
import { entryOf } from '../../fixtures/diary-mirror.ts';
import { directorAnswer } from '../../fixtures/scene-answer.ts';
import { contentText, coreTurn, NOW, sequenceLlm } from '../../fixtures/turn-harness.ts';
import type { ChatMessage } from '../../fixtures/turn-harness.ts';
import { runSplitTurn, splitHot, splitLlm, SPLIT_PARTS } from '../../fixtures/turn-split.ts';
import { onWorld, world, useSelf } from '../../fixtures/turn-world.ts';
import '../../../src/tools/operations/index.ts';
import { humanizeSpeech } from '../../../src/behavior/humanizer.ts';
import type { HumanizerMessage } from '../../../src/behavior/humanizer.ts';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { joinLabels } from '../../../src/config/labels.ts';
import { deepMerge } from '../../../src/config.ts';
import { withCapturedLogs } from '../../fixtures/capture-logs.ts';
import { chainsOf } from '../../fixtures/chains.ts';

const route = (model: string) => [{ via: 'api', key: 'k', model, effort: null }];

const PROMPTS = { 'humanizer/linter': 'Check the text of {{name}}.', 'humanizer/editor': 'Write {{name}} again.' };

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
    prompts: { ...PROMPTS, ...(inner ? { 'turn/inner': 'Do what the wake says.' } : {}) },
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

test("an addressed turn posts the persona's answer as written and asks no humanizer request when it is off", async () => {
  // Catches: the switch is ignored in a turn, and every long answer of a deployment that never turned it on is rewritten.
  const { run, requests } = await turnOf({ enabled: false, write: '<msg reply="#1">άλλο</msg>' });
  assert.deepEqual(sentOf(run), [
    [LONG_A, 'm0'],
    [LONG_B, 'm1'],
  ]);
  assert.equal(requests.length, 0);
});

test('an addressed turn posts the writer messages, each on the line it answers', async () => {
  // Catches: the turn posts the persona's draft after a rewrite, or the rewrite loses the two reply targets.
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

test("the writer request of an addressed turn holds the persona's think", async () => {
  // Catches: the turn hands the humanizer the persona's messages without their think, and the writer rewrites without
  // what they meant.
  const { requests } = await turnOf({
    answers: THOUGHT,
    write: `<msg reply="#1">${WRITTEN_A}</msg><msg reply="#2">${WRITTEN_B}</msg>`,
  });
  const [linter, writer] = requests.map(userOf);
  assert.ok(writer.includes('κρυφή σκέψη'));
  assert.ok(!linter.includes('κρυφή σκέψη'));
});

test("an inner turn posts the writer messages in place of the persona's lowered message.create calls", async () => {
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
  // Catches: the diary post is held before the humanizer runs, so the entry keeps the persona's draft.
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
      diary: { placeId: 'd1', world: false },
      humanizer: { enabled: true },
      models: { routes: { 'linter': route('l/m'), 'editor': route('w/m') } },
    },
    prompts: {
      main: 'SYSTEM for {{name}}',
      persona: 'CARD',
      format: 'FORMAT',
      'diary/task': 'DIARY for {{name}}',
      'diary/scene': 'SCENE_TASK',
      'diary/seeds/place': 'a pier',
      labels,
      ...PROMPTS,
    },
  };
  const rest = {
    complete: (messages: Array<ChatMessage>, options: Record<string, unknown> = {}) =>
      Promise.resolve(
        directorAnswer(messages, options) ?? {
          text: `<msg>${LONG_A}</msg><msg>${LONG_B}</msg>`,
          usage: {},
          estimated: 5,
        }
      ),
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

test('a message.create call of the persona is made with the writer text and its other arguments unchanged', async () => {
  // Catches: a post the persona writes as a tool call skips the humanizer, or its reply target is lost on the way.
  const answers = [toolAnswer('', [call('message.create', { reply: '#1', text: `${LONG_A} ${LONG_B}` })]), '<skip/>'];
  const { run } = await turnOf({ answers, write: `<msg>${WRITTEN}</msg>` });
  assert.deepEqual(sentOf(run), [[WRITTEN, 'm0']]);
});

test('two message.create calls of the persona in one answer are rewritten one at a time', async () => {
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

const LINTER = 'Check the text {{name}} is about to post.';

const WRITER = 'Write the text of {{name}} again.';

function hotOf({ enabled = true, writer = true }: { enabled?: boolean; writer?: boolean } = {}) {
  return {
    config: {
      humanizer: { enabled },
      models: {
        routes: {
          'linter': route('lint/model'),
          ...(writer ? { 'editor': route('write/model') } : {}),
        },
      },
    },
    prompts: { 'humanizer/linter': LINTER, 'humanizer/editor': WRITER },
  };
}

type Call = { messages: Array<{ role: string; content: string }>; options: Record<string, unknown> };

/** A model client that answers the linter with `lint` and the writer with `write`; an Error is thrown. */
function fakeLlm({ lint, write = '' }: { lint: string | Error; write?: string | Error }) {
  const calls: Array<Call> = [];
  return {
    calls,
    complete: (messages: Array<{ role: string; content: string }>, options: Record<string, unknown>) => {
      calls.push({ messages, options });
      const answer = options.purpose === 'humanizer-linter' ? lint : write;
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve({ text: answer });
    },
  };
}

const DRAFT: Array<HumanizerMessage> = [
  { text: LONG_A, replyTo: 3 },
  { text: LONG_B, replyTo: 5 },
];

const THINK = 'θέλω να πω για την αγορά και το τραπέζι';

const run = async (
  llm: ReturnType<typeof fakeLlm>,
  hot: { config: unknown; prompts: unknown } = hotOf(),
  messages = DRAFT
) =>
  (await humanizeSpeech({ parsed: { messages, think: THINK }, loweredCalls: [], llm, hot, name: 'Ελένη', place: 'c1' }))
    .messages;

test('posts the draft unchanged and asks no model when the humanizer is off', async () => {
  // Catches: the switch is not read, and every long answer costs two requests on a deployment that never turned it on.
  const llm = fakeLlm({ lint: LINT_YES, write: '<msg>άλλο</msg>' });
  assert.deepEqual(await run(llm, hotOf({ enabled: false })), DRAFT);
  assert.equal(llm.calls.length, 0);
});

test('posts a text under 40 words unchanged and asks no model', async () => {
  // Catches: a short answer goes to the linter, which delays every quick reply.
  const llm = fakeLlm({ lint: LINT_YES, write: '<msg>άλλο</msg>' });
  const short = [{ text: 'ναι, έρχομαι κι εγώ', replyTo: 2 }];
  assert.deepEqual(await run(llm, hotOf(), short), short);
  assert.equal(llm.calls.length, 0);
});

test('sends no request when the chains stand under the retired role names humanizer.linter and humanizer.writer', async () => {
  // Catches: the old role names read as the new ones, so a deployment that never renamed its chains keeps a humanizer
  // whose roles no command, status line or doctor check names.
  const llm = fakeLlm({
    lint: LINT_YES,
    write: `<msg reply="#3">${WRITTEN_A}</msg><msg reply="#5">${WRITTEN_B}</msg>`,
  });
  const hot = {
    ...hotOf(),
    config: {
      humanizer: { enabled: true },
      models: { routes: { 'humanizer.linter': route('lint/model'), 'humanizer.writer': route('write/model') } },
    },
  };
  assert.deepEqual(await run(llm, hot), DRAFT);
  assert.equal(llm.calls.length, 0);
});

test('posts the draft unchanged after one request when the linter says no', async () => {
  // Catches: the writer runs whatever the linter answered.
  const llm = fakeLlm({ lint: JSON.stringify({ rewrite: false, findings: [] }), write: '<msg>άλλο</msg>' });
  assert.deepEqual(await run(llm), DRAFT);
  assert.deepEqual(
    llm.calls.map((call) => [call.options.purpose, call.options.role]),
    [['humanizer-linter', 'linter']]
  );
});

test('posts the writer messages with their reply targets when the linter asks a rewrite', async () => {
  // Catches: the writer's reply attributes are dropped, and two answers to two lines lose their targets.
  const llm = fakeLlm({
    lint: LINT_YES,
    write: `<think>x</think><msg reply="#3">${WRITTEN_A}</msg><msg reply="#5">${WRITTEN_B}</msg>`,
  });
  assert.deepEqual(await run(llm), [
    { text: WRITTEN_A, replyTo: 3 },
    { text: WRITTEN_B, replyTo: 5 },
  ]);
  assert.deepEqual(
    llm.calls.map((call) => [call.options.purpose, call.options.role]),
    [
      ['humanizer-linter', 'linter'],
      ['humanizer-writer', 'editor'],
    ]
  );
});

test('the linter gets the draft as msg tags with reply targets and a strict schema', async () => {
  // Catches: the linter reads the messages without their targets, or its answer is asked in free text.
  const llm = fakeLlm({ lint: JSON.stringify({ rewrite: false, findings: [] }) });
  await run(llm);
  const [linter] = llm.calls;
  const [system, user] = linter.messages;
  assert.equal(system.content, 'Check the text Ελένη is about to post.');
  assert.ok(user.content.includes(`<msg reply="#3">${LONG_A}</msg>`));
  assert.ok(user.content.includes(`<msg reply="#5">${LONG_B}</msg>`));
  const format = linter.options.responseFormat as { name: string };
  assert.equal(format.name, 'humanizer');
});

test("the writer request holds the persona's think, the draft and the findings", async () => {
  // Catches: the writer rewrites blind, without what the persona meant or what the linter found.
  const llm = fakeLlm({ lint: LINT_YES, write: '<msg>κάτι</msg>' });
  await run(llm);
  const [, writer] = llm.calls;
  const [system, user] = writer.messages;
  assert.equal(system.content, 'Write the text of Ελένη again.');
  assert.ok(user.content.includes(THINK));
  assert.ok(user.content.includes(`<msg reply="#3">${LONG_A}</msg>`));
  assert.ok(user.content.includes('σπάσε τη συμμετρία'));
  assert.ok(user.content.includes('δύο μπλοκ ίδια'));
});

test('posts the draft when the writer puts a reply target on another position', async () => {
  // Catches: the writer swaps the two answers, and each reply lands under the other line.
  const llm = fakeLlm({
    lint: LINT_YES,
    write: `<msg reply="#5">${WRITTEN_A}</msg><msg reply="#3">${WRITTEN_B}</msg>`,
  });
  assert.deepEqual(await run(llm), DRAFT);
});

test('posts the draft when the writer answers with no message', async () => {
  // Catches: an empty rewrite posts nothing and the persona's answer is lost.
  const llm = fakeLlm({ lint: LINT_YES, write: '<think>τίποτα</think>' });
  assert.deepEqual(await run(llm), DRAFT);
});

test('posts the draft when the writer leaves a think tag broken', async () => {
  // Catches: the writer's private notes reach the chat.
  const llm = fakeLlm({ lint: LINT_YES, write: '<think>σημειώσεις <msg>κάτι</msg>' });
  assert.deepEqual(await run(llm), DRAFT);
});

test('posts the draft when the writer request fails', async () => {
  // Catches: a failed rewrite throws out of the turn and nothing is posted.
  const llm = fakeLlm({ lint: LINT_YES, write: new Error('timeout') });
  assert.deepEqual(await run(llm), DRAFT);
});

test('posts the draft when the linter answer is not strict JSON', async () => {
  // Catches: free text from the linter is read as a yes.
  const llm = fakeLlm({ lint: 'ναι, ξαναγράψε', write: '<msg>κάτι</msg>' });
  assert.deepEqual(await run(llm), DRAFT);
  assert.equal(llm.calls.length, 1);
});

test('posts the draft and asks no model when the writer role has no route', async () => {
  // Catches: the linter is paid for on a deployment whose rewrite can never run.
  const llm = fakeLlm({ lint: LINT_YES, write: '<msg>κάτι</msg>' });
  assert.deepEqual(await run(llm, hotOf({ writer: false })), DRAFT);
  assert.equal(llm.calls.length, 0);
});

test('posts the draft when the writer returns one message more or one fewer', async () => {
  // Catches: the writer changes how many messages the persona sends, which is theirs to decide.
  const more = fakeLlm({
    lint: LINT_YES,
    write: `<msg reply="#3">${WRITTEN_A}</msg><msg reply="#5">${WRITTEN_B}</msg><msg>τρία</msg>`,
  });
  assert.deepEqual(await run(more), DRAFT);
  const fewer = fakeLlm({ lint: LINT_YES, write: `<msg reply="#3">${WRITTEN_A} ${WRITTEN_B}</msg>` });
  assert.deepEqual(await run(fewer), DRAFT);
});

test('posts the draft when the writer answer is cut inside a message', async () => {
  // Catches: an answer that ends at the output cap is read as whole, and half a sentence is posted as the persona's message.
  const llm = fakeLlm({ lint: LINT_YES, write: `<msg reply="#3">${WRITTEN_A}</msg><msg reply="#5">${WRITTEN_B}` });
  assert.deepEqual(await run(llm), DRAFT);
});

test('posts the draft when the writer text holds under half the words of the draft', async () => {
  // Catches: a refusal the writer puts inside message tags, or a rewrite that dropped most of what the persona said, is posted.
  const llm = fakeLlm({
    lint: LINT_YES,
    write: '<msg reply="#3">δεν μπορώ να ξαναγράψω αυτό το κείμενο</msg><msg reply="#5">λυπάμαι</msg>',
  });
  assert.deepEqual(await run(llm), DRAFT);
});

test('posts three writer messages for a draft of three', async () => {
  // Catches: a rewrite of more than two messages is refused or cut.
  const three = [...DRAFT, { text: 'τέλος', replyTo: null }];
  const llm = fakeLlm({
    lint: LINT_YES,
    write: `<msg reply="#3">${WRITTEN_A}</msg><msg reply="#5">${WRITTEN_B}</msg><msg>τρία</msg>`,
  });
  assert.deepEqual(await run(llm, hotOf(), three), [
    { text: WRITTEN_A, replyTo: 3 },
    { text: WRITTEN_B, replyTo: 5 },
    { text: 'τρία', replyTo: null },
  ]);
});

test("strips the long dashes of the writer's text as the persona's own text loses them", async () => {
  // Catches: format.stripDashes runs on the persona's answer before the humanizer, so a dash the writer adds reaches the chat.
  const llm = fakeLlm({
    lint: LINT_YES,
    write: `<msg reply="#3">πρώτο — μέρος, ${WRITTEN_A}</msg><msg reply="#5">${WRITTEN_B}</msg>`,
  });
  assert.deepEqual(
    (await run(llm)).map((one) => one.text),
    [`πρώτο μέρος, ${WRITTEN_A}`, WRITTEN_B]
  );
});

/** The fixed words of a label before its first placeholder. */
const labelHead = (label: string) => label.split('{')[0];

// ---- the shipped layer --------------------------------------------------------

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const PROMPTS_DIR = path.join(ROOT, 'prompts');

/** The tracked prompt files at any depth, by key: the path relative to prompts/ without `.md`, `/` between the parts. */
const PROMPT_FILES = fs
  .readdirSync(PROMPTS_DIR, { recursive: true, encoding: 'utf8' })
  .filter((file) => file.endsWith('.md'))
  .map((file) => file.slice(0, -'.md'.length).split(path.sep).join('/'))
  .sort();

const BOM = String.fromCharCode(0xfeff);

/** `prompts/<name>.md` as src/hot.ts reads it: the BOM and carriage returns dropped, trimmed. */
function readPrompt(name: string) {
  const text = fs.readFileSync(path.join(PROMPTS_DIR, `${name}.md`), 'utf8');
  return (text.startsWith(BOM) ? text.slice(1) : text).replace(/\r\n/g, '\n').trim();
}

/** The tracked layer alone: config/ with the labels read joined, and prompts/, never a local override. */
const SHIPPED = {
  config: JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'config.json'), 'utf8')),
  prompts: {
    ...Object.fromEntries(PROMPT_FILES.map((name) => [name, readPrompt(name)])),
    labels: joinLabels(JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'labels.json'), 'utf8'))),
  },
};

// The shipped labels carry the keys of the contract (the fixture covers every one).
const LABELS = SHIPPED.prompts.labels as typeof labels;

/**
 * A prompt that carries `{{` or a `{key}` as text on purpose: its file name -> `{ literal, why }`.
 * The literal may remain in a request; anything else in braces may not. None today.
 */
const LITERAL_BRACES: Record<string, { literal: string; why: string }> = {};

/** `text` without the literals of LITERAL_BRACES. */
function withoutLiterals(text: string) {
  let rest = text;
  for (const { literal } of Object.values(LITERAL_BRACES)) rest = rest.split(literal).join('');
  return rest;
}

/** The shipped config.json with `overrides` deep-merged over a fresh copy. */
function shippedConfig(overrides: Record<string, unknown> = {}) {
  const on = {
    models: { routes: chainsOf({ vision: 'x/vision', video: 'x/video', drawing: 'x/drawing', speech: 'x/speech' }) },
  }; // off when shipped
  return deepMerge(deepMerge(structuredClone(SHIPPED.config), on), overrides);
}

/** A live view over the shipped layer, the config overridden as given. */
function shippedHot(overrides: Record<string, unknown> = {}) {
  return { config: shippedConfig(overrides), prompts: SHIPPED.prompts };
}

// ---- the checks -----------------------------------------------------------------

/** The text of one message content: a string as is, an array of parts as its text parts. */
function promptsShippedContentText(content: unknown) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((part) => part?.type === 'text')
    .map((part) => part.text)
    .join('\n');
}

/** Every text a request carries, as one string. */
function requestText(messages: Array<{ content: unknown }>) {
  return messages.map((message) => promptsShippedContentText(message.content)).join('\n\n');
}

/** The double-brace sequences left in `text`, LITERAL_BRACES aside. */
function strayPlaceholders(text: string) {
  return [...new Set(withoutLiterals(text).match(/\{\{[^{}\n]{0,40}\}\}|\{\{/g) ?? [])];
}

/** The single-brace `{key}` label placeholders left in `text`, LITERAL_BRACES aside. */
function strayLabelKeys(text: string) {
  return [...new Set(withoutLiterals(text).match(/\{[A-Za-z_]\w*\}/g) ?? [])];
}

/** The lines of prompt `name` without a placeholder: a request that loads the file carries each one verbatim. */
function literalLines(name: string) {
  const text = (SHIPPED.prompts as Record<string, unknown>)[name] as string;
  assert.equal(typeof text, 'string', `prompts/${name}.md is not loaded`);
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.includes('{{'));
}

/**
 * Asserts one built request: no `{{placeholder}}` and no label `{key}` left, every prompt file of
 * `files` carried whole, every block of `blocks` rendered. Returns the request's text.
 */
function assertFilled(
  messages: unknown,
  { files = [], blocks = [] }: { files?: Array<string>; blocks?: Array<string> },
  where: string
) {
  assert.ok(Array.isArray(messages) && messages.length > 0, `${where}: no request was built`);
  const text = requestText(messages);
  assert.deepEqual(strayPlaceholders(text), [], `${where}: a placeholder reached the request unfilled`);
  assert.deepEqual(strayLabelKeys(text), [], `${where}: a label placeholder reached the request unfilled`);
  for (const name of files) {
    const missing = literalLines(name).filter((line) => !text.includes(line));
    assert.equal(
      missing.length,
      0,
      `${where}: prompts/${name}.md is not carried whole, e.g. ${JSON.stringify(missing.slice(0, 2))}`
    );
  }
  for (const tag of blocks) {
    if (tag === 'tempo') {
      // Slice 2 (g): `<tempo>` is the foot of `<chat>`, not a block, so its verdict line ends the chat's body.
      const chat = /<chat>\n([\s\S]*?)\n<\/chat>/.exec(text)?.[1] ?? '';
      const verdict = labelHead(LABELS.tempo.verdict);
      assert.ok(chat.split('\n').at(-1)?.startsWith(verdict), `${where}: no tempo at the foot of <chat>`);
      continue;
    }
    assert.ok(text.includes(`<${tag}>\n`), `${where}: no <${tag}> block`);
  }
  return text;
}

const SELF_NAME = 'Zoë';

describe('with the shipped prompts', () => {
  before(() => {
    useSelf('900000000000000001');
  });
  after(() => {
    useSelf('self-id');
  });

  test('humanizeSpeech: the linter and the writer requests fill humanizer/linter.md and humanizer/editor.md', async () => {
    const hot = shippedHot({
      humanizer: { enabled: true },
      models: { routes: chainsOf({ 'linter': 'x/linter', 'editor': 'x/writer' }) },
    });
    const calls: Array<{ messages: unknown; purpose: unknown }> = [];
    // Twenty words: a rewrite is posted only when it keeps at least half the words of the draft.
    const written = Array.from({ length: 20 }, (_, i) => `χα${i}`).join(' ');
    const llm = {
      complete: async (messages: Array<{ role: string; content: string }>, options: Record<string, unknown>) => {
        calls.push({ messages, purpose: options.purpose });
        const rewrite = {
          rewrite: true,
          findings: [{ kind: 'shape', quote: '', problem: 'a report', fix: 'reorder' }],
        };
        return { text: options.purpose === 'humanizer-linter' ? JSON.stringify(rewrite) : `<msg>${written}</msg>` };
      },
    };
    // Forty words, the least the humanizer reads.
    const text = Array.from({ length: 40 }, (_, i) => `λέξη${i}`).join(' ');
    const { result } = await withCapturedLogs(() =>
      humanizeSpeech({
        parsed: { messages: [{ text, replyTo: null }], think: 'σκέψη' },
        loweredCalls: [],
        llm,
        hot,
        name: SELF_NAME,
        place: 'c1',
      })
    );
    assert.deepEqual(result.messages, [{ text: written, replyTo: null }]);
    const linter = calls.find((call) => call.purpose === 'humanizer-linter');
    const writer = calls.find((call) => call.purpose === 'humanizer-writer');
    assertFilled(linter?.messages, { files: ['humanizer/linter'] }, 'humanizer linter');
    assertFilled(
      writer?.messages,
      { files: ['humanizer/editor'], blocks: ['thoughts', 'draft', 'findings'] },
      'humanizer writer'
    );
  });
});
