// Tests for src/turn/tool-round.ts: the steps of a turn, what a step posts or holds and the request that follows it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTurnRunner as createRealTurnRunner } from '../../../src/behavior/turn.ts';
import { ImageGenError } from '../../../src/llm/images.ts';
import { labels } from '../../fixtures/labels.ts';
import { withCapturedLogs } from '../../fixtures/capture-logs.ts';
import type { LogEntry } from '../../fixtures/capture-logs.ts';
import { call, completionOf, toolAnswer } from '../../fixtures/tool-answers.ts';
import type { Completion, ToolCall } from '../../fixtures/tool-answers.ts';
import { contentText, coreTurn } from '../../fixtures/turn-harness.ts';
import type { FakeLlm } from '../../fixtures/turn-harness.ts';
import '../../../src/tools/operations/index.ts';
import { onWorld, useIface, world } from '../../fixtures/turn-world.ts';
import type { Channel, Fake } from '../../fixtures/turn-world.ts';
import { publishTo } from '../../fixtures/diary-mirror.ts';
import type { Untyped } from '../../../src/tools/types.ts';
import { directorAnswer } from '../../fixtures/scene-answer.ts';
import { objectMediaCache } from '../../../src/memory/store-media.ts';
import { asRecord } from '../../fixtures/records.ts';
import { shippedLabels } from '../../fixtures/shipped-labels.ts';
import { TURN_NOW, serviceTurn, serviceWake } from '../../fixtures/service-turn.ts';

useIface('fake');

// The records come back typed as `object` or `unknown`; the tests read their fields through `loose`.
const loose = (value: unknown): Record<string, Untyped> => value as Record<string, Untyped>;

// The diary channel is held by a fake interface named `fake`; the persona is `self-id`.

// onWorld takes a creator of any options; the real runner takes its own input type, so the options are cast once, here.
const createWorldRunner = onWorld((options) =>
  createRealTurnRunner(options as Parameters<typeof createRealTurnRunner>[0])
);

/**
 * A turn runner whose `runTurn` first opens the chat a test gave as a diary channel (see diaryChannel).
 */
function createTurnRunner(options: Parameters<typeof createWorldRunner>[0]) {
  const turns = createWorldRunner(options);
  return {
    ...turns,
    runTurn: (params: Record<string, unknown> & { channel?: { open?: () => unknown } }) => {
      params.channel?.open?.();
      return turns.runTurn(params);
    },
  };
}

const NOW = Date.UTC(2026, 9, 6, 19, 30, 0);

const TZ = 'Europe/Athens';

/**
 * A diary channel the persona owns: every permission, Attach Files only when `attachFiles`. The chat is made in
 * the test's world when a turn runs in it (`open`), and `sent` and `reactCalls` read what the persona did there.
 */
function diaryChannel({
  attachFiles = true,
  historyMessages = [],
}: { attachFiles?: boolean; historyMessages?: Array<Rec> } = {}) {
  let handle: Channel | null = null;
  return {
    id: 'd1',
    open() {
      handle ??= world().channel({
        id: 'd1',
        name: 'journal',
        placeId: 'g1',
        permissions: { attach: attachFiles },
        historyMessages,
      });
      return handle;
    },
    get sent() {
      return handle?.sent ?? [];
    },
    get reactCalls() {
      return handle?.reactCalls ?? [];
    },
  };
}

/**
 * The diary wake: a diary turn records the persona's entry and sends nothing itself, and the diary's mirror
 * publishes the entry (src/behavior/mirror.ts). The cases that asserted the turn's send call this where the send used
 * to happen: it checks that the turn sent nothing to `channel`, then publishes the entry to a mirror on `d1` of `port`,
 * so what `channel.sent` or the adapter shows after it is what the publication sent.
 * @param result  The diary turn's result.
 * @param channel  The diary channel of the case, or null when the case reads the adapter.
 */
async function published(result: Untyped, channel: Untyped, port = world().port) {
  assert.deepEqual(channel?.sent ?? [], [], 'the turn itself sends nothing');
  return publishTo(result, port, { now: NOW });
}

/**
 * An LLM that answers the director with `scene` (a scene's text, an Error it throws, or `{ raw }` sent as it is), then
 * the persona's requests with `post` (a list: one answer per request, the last repeated). `calls` holds every request,
 * the director's first.
 */
function fakeLlm(scene: string | Error | { raw: string } | null, post: Untyped) {
  const calls: Array<Untyped> = [];
  const options: Array<Untyped> = [];
  let composed = 0;
  return {
    calls,
    options,
    complete: async (messages: Untyped, opts: Untyped) => {
      calls.push(messages);
      options.push(opts);
      if (opts?.purpose === 'diary-scene') {
        if (scene instanceof Error) throw scene;
        if (scene !== null && typeof scene === 'object') return { text: scene.raw, usage: {}, estimated: 5 };
        return directorAnswer(messages, opts, typeof scene === 'string' ? scene : undefined);
      }
      const answer = Array.isArray(post) ? post[Math.min(composed, post.length - 1)] : post;
      composed += 1;
      return completionOf(answer);
    },
  };
}

/** The persona's draw.create calls (`n` of them; the first with self when `self`), as one answer with `text` ahead of them. */
const withDraws = (text: string, n: Untyped, self = false) => drawAnswer(text, n, self);

const drawAnswer = (text: string, n = 1, self = false) =>
  toolAnswer(
    text,
    Array.from({ length: n }, (_, i) =>
      call('draw.create', {
        people: [],
        text: n === 1 ? 'a pier at night' : `scene ${i + 1}`,
        ...(self && i === 0 ? { self: true } : {}),
      })
    )
  );

/** The `skills: called` lines of a run, as `skill:status/code`. */
const calledOf = (logs: Array<LogEntry>) =>
  logs
    .filter((entry) => entry.msg === 'skills: called')
    .map((entry) => `${entry.skill}:${entry.status}${entry.code ? `/${entry.code}` : ''}`);

type Rec = Record<string, Untyped>;

function fakeStore({ posts = [], data = {} }: { posts?: Array<Rec>; data?: Rec } = {}) {
  const appended: Array<Untyped> = [];
  return {
    appended,
    getPlace: () => ({}),
    getUser: () => null,
    getPrivate: () => null,
    listChannels: () => [],
    listUserProfiles: () => [],
    getLore: () => [],
    liveRules: () => [],
    ...objectMediaCache({}),
    getDiary: () => ({ posts, updatedAt: 0 }),
    appendDiaryPost: (post: Untyped, opts: Untyped) => appended.push({ post, opts }),
    state: { data: { ...data }, markDirty() {} },
  };
}

function fakeImages({ used = 0, cap = 10, fail = null }: { used?: number; cap?: number; fail?: Error | null } = {}) {
  const prompts: Array<Untyped> = [];
  return {
    prompts,
    quota: () => ({ used, cap, userUsed: 0, userCap: 5, spent: used >= cap, userSpent: false }),
    generate: async ({ prompt }: { prompt: Untyped }) => {
      prompts.push(prompt);
      if (fail) throw fail;
      return { buffer: Buffer.from('png'), mediaType: 'image/png', seconds: 1, cost: 0 };
    },
  };
}

// PR 7d: the switches are code, the dry run and the daily caps are gone, and the diary's kinds, sets, gist length and
// message count are constants of src/behavior/diary.ts, so the config holds only the keys that are still settings.
function fakeHot({ diary = {}, prompts = {} }: { diary?: Untyped; prompts?: Untyped } = {}) {
  return {
    config: {
      bot: { timezone: TZ },
      context: {
        channelMessages: 50,
        caps: { interlocutor: 2500, aboutChat: 2500, people: 4000, neighbors: 3000 },
        vision: { fetchTimeoutMs: 10_000 },
        pull: { sameAudience: true },
      },
      llm: { maxRequestTokens: 50000 },
      typing: { reactionDelayMs: [0, 0], msPerChar: [0, 0], minMs: 0, maxMs: 0, betweenMessagesMs: [0, 0] },
      image: {},
      diary: {
        placeId: 'd1',
        world: false,
        ...diary,
      },
    },
    prompts: {
      main: 'SYSTEM for {{name}}',
      persona: 'CARD_TEXT',
      format: 'FORMAT_TEXT',
      'diary/task': 'DIARY_TASK for {{name}}',
      'diary/scene': 'SCENE_TASK',
      'diary/kinds/thought': 'THOUGHT_TASK',
      'diary/kinds/story': 'STORY_TASK',
      'diary/seeds/place': 'a pier',
      'diary/seeds/setting': 'fog',
      draw: 'DRAW for {{name}}\n{{when}}\n{{request}}',
      labels,
      ...prompts,
    },
  };
}

function runner({
  hot = fakeHot(),
  store = fakeStore(),
  llm,
  images = fakeImages(),
  lookup = null,
  // The code draws the diary's kind.
  rng = () => 0.5,
  extra = {},
}: {
  hot?: Untyped;
  store?: Untyped;
  llm?: Untyped;
  images?: Untyped;
  lookup?: Untyped;
  rng?: () => number;
  extra?: Record<string, unknown>;
} = {}) {
  return createTurnRunner({
    hot,
    store,
    llm,
    calibrator: { ratio: 1, apply: (n: Untyped) => n, observe: () => {} },
    images,
    lookup,
    rng,
    now: () => NOW,
    ...extra,
  });
}

test('diary turn: a failed drawing is a result the persona reads before anything is posted; the post goes out without the picture', async () => {
  const llm = fakeLlm(null, [drawAnswer('<msg>brume</msg>'), '<msg>brume sans image</msg>']);
  const store = fakeStore();
  const images = fakeImages({ fail: new ImageGenError('error') });
  const channel = diaryChannel();
  const { result, logs } = await withCapturedLogs(() =>
    runner({ llm, store, images }).runTurn({ channel, mode: 'diary', diary: {} })
  );
  assert.equal(loose(result).outcome, 'spoke');
  assert.equal(loose(result).drawFailed, undefined);
  // Changed: the kind drawn here takes no scene and the planner is gone, so no request comes before the persona's.
  assert.equal(llm.calls.length, 2, 'the request with the draw, the request after the result');
  assert.deepEqual(calledOf(logs), ['draw.create:failed/image-error']);
  assert.ok(logs.some((l) => l.msg === 'turn: speech held'));
  // Stage 3: the turn sends nothing; the expectation below is what the mirror's publication of the entry sends.
  await published(result, channel);
  assert.deepEqual(
    channel.sent.map((payload) => payload.content),
    ['brume sans image'],
    'the first speech was held and never posted'
  );
  const appendedItem = store.appended[0];
  assert.equal(appendedItem.post.picture, null);
});

// ---- set posts (diary.setKinds): several pictures, generated before anything is sent ----------

/** An image client that answers each generate call by the next step: a byte count, or an error to throw. */
function fakeSetImages(steps: Untyped, events: Array<string> = []) {
  const prompts: Array<Untyped> = [];
  let call = 0;
  return {
    prompts,
    events,
    quota: () => ({ used: 0, cap: 50, userUsed: 0, userCap: 5, spent: false, userSpent: false }),
    generate: async ({ prompt, accountId }: { prompt: Untyped; accountId: Untyped }) => {
      prompts.push({ prompt, accountId });
      const step = steps[call] ?? 10;
      call += 1;
      events.push(`generate ${call}`);
      if (step instanceof Error) throw step;
      return { buffer: Buffer.alloc(step, 1), mediaType: 'image/png', seconds: 1, cost: 0 };
    },
  };
}

test('diary set: one failure in a set holds the speech and the staged pictures; step 2 sees the result and posts with the five that came out', async () => {
  // The code draws the diary's kind.
  const images = fakeSetImages([10, 10, new ImageGenError('error'), 10, 10, 10]);
  const store = fakeStore();
  const channel = diaryChannel();
  const llm = fakeLlm(null, [withDraws('<msg>une promenade</msg>', 6), '<msg>cinq images sur six</msg>']);
  const { result, logs } = await withCapturedLogs(() =>
    runner({ llm, store, images }).runTurn({
      channel,
      mode: 'diary',
      diary: { kind: 'photoset', forced: false },
    })
  );
  assert.equal(loose(result).outcome, 'spoke');
  assert.equal(llm.calls.length, 3, 'the plan and two post requests');
  assert.ok(logs.some((l) => l.msg === 'turn: speech held'));
  assert.deepEqual(calledOf(logs), [
    'draw.create:ok/staged',
    'draw.create:ok/staged',
    'draw.create:failed/image-error',
    'draw.create:ok/staged',
    'draw.create:ok/staged',
    'draw.create:ok/staged',
  ]);
  // Stage 3: the turn sends nothing; the expectation below is what the mirror's publication of the entry sends.
  await published(result, channel);
  // Step 2 sees all six results and the held notice.
  const step2 = llm.calls[2];
  assert.equal(step2.filter((message: Untyped) => message.role === 'tool').length, 6);
  const task = labels.task;
  assert.ok(contentText(step2.at(-1).content).includes(task.step.held));
  assert.deepEqual(
    channel.sent.filter((payload) => payload.content).map((payload) => payload.content),
    ['cinq images sur six'],
    'the held speech never went out'
  );
  assert.equal(loose(channel.sent.at(-1)).files.length, 5);
  assert.equal(loose(result).diary.pictures, 5);
  const appendedItem = store.appended[0];
  assert.equal(appendedItem.post.pictures, 5);
});

test('diary: a call other than draw.create is refused diary-draw-only and never runs; the picture beside it does', async () => {
  const images = fakeSetImages([10]);
  const channel = diaryChannel();
  const llm = fakeLlm(null, [
    toolAnswer('<msg>x</msg>', [
      call('message.create', { text: 'hello' }),
      call('draw.create', { people: [], text: 'a pier' }),
    ]),
    '<msg>y</msg>',
  ]);
  const { result, logs } = await withCapturedLogs(() =>
    runner({ llm, images }).runTurn({ channel, mode: 'diary', diary: {} })
  );
  assert.deepEqual(
    calledOf(logs).sort(),
    ['draw.create:ok/staged', 'message.create:denied/diary-draw-only'],
    'only the picture ran'
  );
  assert.ok(
    logs.some((l) => l.msg === 'skill: refused' && l.skill === 'message.create' && l.code === 'diary-draw-only')
  );
  assert.equal(images.prompts.length, 1);
  // Stage 3: the turn sends nothing; the expectation below is what the mirror's publication of the entry sends.
  await published(result, channel);
  assert.deepEqual(
    channel.sent.filter((payload) => payload.content).map((payload) => payload.content),
    ['y']
  );
  // Changed: the kind drawn here takes no scene and the planner is gone, so the persona's requests are the only ones.
  assert.equal(llm.calls.length, 2, 'the refusal is a result the persona reads');
  const labelsResult = labels.tools.result;
  const llmCalls = llm.calls;
  assert.ok(
    contentText(llmCalls[1].find((message: Untyped) => message.role === 'tool').content).includes(
      labelsResult.reasons['diary-draw-only']
    )
  );
});

test('diary: a call that only looks runs, the picture runs, and a post is refused diary-draw-only', async () => {
  // Bug caught: the diary turn refuses a search or a read of memory, so the persona cannot look anything up for news.
  const hot = fakeHot();
  Object.assign(hot.config.bot, { access: { 'lore.list': { everyone: false, roles: [], users: ['self-id'] } } });
  const ran: Array<string> = [];
  const runOp = (op: string) => {
    ran.push(op);
    return { status: 'ok', code: 'ok', summary: 'ΤΟ ΛΗΜΜΑ', data: { text: 'ΤΟ ΛΗΜΜΑ' } };
  };
  const llm = fakeLlm(null, [
    toolAnswer('', [
      call('lore.list', {}),
      call('draw.create', { people: [], text: 'a pier' }),
      call('message.create', { text: 'hello' }),
    ]),
    '<msg>y</msg>',
  ]);
  const { logs } = await withCapturedLogs(() =>
    runner({ hot, llm, extra: { runOp } }).runTurn({
      channel: diaryChannel(),
      mode: 'diary',
      diary: { kind: 'picture', forced: true },
    })
  );
  assert.deepEqual(
    calledOf(logs).sort(),
    ['draw.create:ok/staged', 'lore.list:ok', 'message.create:denied/diary-draw-only'],
    'the read and the picture ran, the post did not'
  );
});

const MARKER = 'BARE-TEXT-NOT-SENT';

/** The test's own wording of the diagnostic: its marker, then the count of characters. */
const WORDED = `${MARKER} {chars}`;

const replyLabels = {
  ...labels,
  tools: { ...labels.tools, diagnostics: { ...labels.tools.diagnostics, bareText: WORDED } },
};

const shippedTools = asRecord(shippedLabels.tools);

const innerLabels = {
  ...shippedLabels,
  tools: { ...shippedTools, diagnostics: { ...asRecord(shippedTools.diagnostics), bareText: WORDED } },
};

/** The persona's working words, outside every tag, each word one no message of these tests holds. */
const BARE = 'ετοιμάζω πρώτα εικόνα έπειτα γράφω';

const MARKED = `${MARKER} ${BARE.length}`;

const THINK = '<think>σχέδιο</think>';

const SAY = '<think>τώρα σωστά</think><msg>ναι εντάξει</msg>';

/** The texts the adapter was asked to send, in order, whenever the turn that sent them ran. */
function sentTexts(port: Fake): Array<string> {
  const { calls } = port;
  return calls.filter((one) => one.op === 'send').map((one) => String((one.args[1] as { text?: string }).text));
}

/** Every message of request `i`, their texts joined: the marker may stand in any of them. */
function wholeRequest(llm: FakeLlm, i: number): string {
  const request = llm.calls[i];
  return request.map((message) => contentText(message.content)).join('\n');
}

/** Asserts that no word of `bare` stands in any of `posted`. */
function assertNoWordOf(bare: string, posted: ReadonlyArray<string>): void {
  for (const word of bare.split(' ')) {
    for (const text of posted) assert.equal(text.includes(word), false, `"${word}" was posted in "${text}"`);
  }
}

// ---------- an intention turn ----------

const HOUR = 3_600_000;

/** An answer whose call is made when the model is asked: the id of the due intention is known only once the turn seeded it. */
function lateAnswer(text: string, make: () => ToolCall): Completion {
  return {
    text,
    usage: {},
    estimated: 10,
    finishReason: 'stop',
    get toolCalls(): Array<ToolCall> {
      return [make()];
    },
  };
}

test('an intention turn with bare text beside the call that closes it runs the call, posts nothing and asks once more', async () => {
  // Bug: the sentences go out in the chat, the intention is closed and the promised post is never written.
  const due = { id: '' };
  const run = await serviceTurn({
    wake: () =>
      serviceWake('intention_due', {
        items: [{ kind: 'intention_due', reason: 'due', intentionIds: [due.id], errandId: null }],
        intentions: [{ id: due.id, purpose: 'να γράψω στον κήπο', dueAt: TURN_NOW - 60_000 }],
        chainId: due.id,
      }),
    seed: (service) => {
      const made = service.set({
        purpose: 'να γράψω στον κήπο',
        dueAt: TURN_NOW - 60_000,
        destination: 'c1',
        by: 'persona',
      }) as { intention?: { id: string } };
      due.id = made.intention?.id ?? '';
      service.set({ purpose: 'ΑΛΛΗ-ΜΕΛΛΟΝΤΙΚΗ', dueAt: TURN_NOW + 5 * HOUR, by: 'persona' });
    },
    answers: [lateAnswer(`${THINK}${BARE}`, () => call('intention.update', { id: due.id, state: 'done' })), SAY],
    chat: { iface: 'fake', chatId: 'c1' },
    currentChannel: 'fake:channel:c1',
    labels: innerLabels,
  });
  assert.equal(run.requests.length, 2);
  assert.equal(run.actions[0], 'intention.update:executed:ok', 'the call ran as it does');
  const [, second = ''] = run.requests;
  assert.ok(second.includes(MARKED), 'the second request carries the diagnostic');
  const posted = sentTexts(run.port);
  assert.deepEqual(posted, ['ναι εντάξει'], 'the <msg> of the second answer, in the turn’s place');
  assertNoWordOf(BARE, posted);
});

// ---------- a <thinking> block is the persona's think ----------

// The second spelling of the persona's thinking: a whole `<thinking>` block is read as
// `<think>`, so it is no bare text, it is the turn's think, and the persona's earlier answer stands in the next request with the
// block as `<think>`. The last answer holds no think of its own, so the think the record keeps can only be the block's.
const THINKING_TEXT = 'κοιτάζω πρώτα τον κατάλογο';

const THINKING = `<thinking>${THINKING_TEXT}</thinking>`;

const SAY_NO_THINK = '<msg>ναι εντάξει</msg>';

test("the request after a <thinking> block and a call shows the persona's answer with the block as <think>", async () => {
  // Catches: the persona reads the second spelling back in their own earlier answer and keeps writing it.
  const run = await coreTurn({
    answers: [toolAnswer(THINKING, [call('lore.list')]), SAY_NO_THINK],
    prompts: { labels: replyLabels },
  });
  const [, second = []] = run.llm.calls;
  const answer = second[2];
  assert.equal(answer.role, 'assistant');
  assert.equal(answer.content, `<think>${THINKING_TEXT}</think>`);
  assert.equal(wholeRequest(run.llm, 1).includes('<thinking>'), false);
});
