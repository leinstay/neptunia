import assert from 'node:assert/strict';
import { after, before, describe, test } from 'node:test';
import { createTurnRunner as createRealTurnRunner } from '../../../../src/behavior/turn.ts';
import { ImageGenError } from '../../../../src/llm/images.ts';
import { objectMediaCache } from '../../../../src/memory/store-media.ts';
import { createStore } from '../../../../src/memory/store.ts';
import '../../../../src/tools/operations/index.ts';
import type { Untyped } from '../../../../src/tools/types.ts';
import { diaryRows, entryOf, publishTo, seedMirror } from '../../../fixtures/diary-mirror.ts';
import { ROOT, sceneRunner } from '../../../fixtures/diary-requests-recorded.ts';
import type { SceneMemory } from '../../../fixtures/diary-scene.ts';
import { labels } from '../../../fixtures/labels.ts';
import { mirrorScene, type Scene, T0 } from '../../../fixtures/mirror-scene.ts';
import { asRecord } from '../../../fixtures/records.ts';
import { directorAnswer } from '../../../fixtures/scene-answer.ts';
import { call, completionOf, toolAnswer } from '../../../fixtures/tool-answers.ts';
import { contentText, coreTurn, type FakeLlm } from '../../../fixtures/turn-harness.ts';
import {
  type Channel,
  type Fake,
  freshWorld,
  onWorld,
  useIface,
  useSelf,
  world,
} from '../../../fixtures/turn-world.ts';

const TEXT = 'ήσυχο βράδυ στο λιμάνι';

const BAD = `<audience>place:fake:channel:nowhere</audience><msg>${TEXT}</msg>`;

/** Two interfaces with one mirror each, and one store over their memory. */
async function setting() {
  const scene = await mirrorScene({ ifaces: ['fake', 'other'] });
  seedMirror(scene.memory.memoryDb, { iface: 'fake', chatId: 'd1', at: T0 });
  seedMirror(scene.memory.memoryDb, { iface: 'other', chatId: 'd1', at: T0 });
  return { scene, store: createStore({ dataDir: scene.memory.dataDir, memoryDb: scene.memory.memoryDb }) };
}

type Setting = { scene: Scene; store: ReturnType<typeof createStore> };

/** One diary turn in which the persona's writer answers `answer`, or fails when it is null: the result and the writer's request. */
async function turn({ store }: Setting, answer: string | null, extra: Record<string, unknown> = {}) {
  freshWorld();
  world().channel({ id: 'd1', name: 'journal', placeId: ROOT });
  const calls: Array<unknown> = [];
  const model = {
    calls,
    complete: (messages: unknown, options?: { purpose?: string }) => {
      calls.push(structuredClone(messages));
      const scene = directorAnswer(messages, options);
      if (scene) return Promise.resolve(scene);
      if (answer === null) return Promise.reject(Object.assign(new Error('provider down'), { statusCode: 500 }));
      return Promise.resolve({ text: answer, usage: {}, estimated: 5 });
    },
  };
  const result = await sceneRunner(model, store).runTurn({
    mode: 'diary',
    diary: { kind: 'thought', forced: true },
    placeId: ROOT,
    ...extra,
  });
  await store.flushSettled({});
  return { result, writer: calls.at(-1) };
}

/** Every string of a request, joined. */
function requestText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(requestText).join('\n');
  if (value && typeof value === 'object') return Object.values(value).map(requestText).join('\n');
  return '';
}

/**
 * The body of the request's `<feedback>` part of `<inner>`, or null when it has none. In these scenes nothing else
 * failed, so the part holds the refused audiences alone.
 */
function refusalBlock(request: unknown): string | null {
  // Slice 6: the refused audiences are told in `<feedback>` inside `<inner>`, which replaces `<audience_refused>`.
  return /<feedback>([\s\S]*?)<\/feedback>/.exec(requestText(request))?.[1] ?? null;
}

/** Whether the request tells the persona of a refused audience. */
const tells = (request: unknown): boolean => refusalBlock(request) !== null;

test('a request the model never answered does not count as telling the persona', async () => {
  // Catches: the mark set as the request is built, so a provider failure loses the only notice the persona would get.
  const setup = await setting();
  await turn(setup, BAD);
  assert.equal(tells((await turn(setup, null)).writer), true);
  assert.equal(tells((await turn(setup, `<msg>${TEXT}</msg>`)).writer), true);
});

// The records come back typed as `object` or `unknown`; the tests read their fields through `loose`.
const loose = (value: unknown): Record<string, Untyped> => value as Record<string, Untyped>;

useSelf('self-id');

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

const DAY = 24 * 60 * 60 * 1000;

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

/** The persona's own earlier post as discord.js hands it over. */
function ownRaw(id: string, ts: number, content: string) {
  return {
    id,
    placeId: 'd1',
    author: { id: 'self-id', bot: true, globalName: 'Bot', username: 'Bot' },
    member: { displayName: 'Bot' },
    cleanContent: content,
    createdTimestamp: ts,
    reference: null,
    attachments: new Map(),
    stickers: new Map(),
  };
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
  // The lead: the code draws the diary's kind.
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

// The diary wake keeps the id of its turn on the entry as `extra.turnId`, written through the one writer. The
// wake runs the real turn runner over tests/fixtures/diary-scene.ts with a real journal. Invented ids and
// synthetic text only.

/** The scenes a test opened, closed when the file is done. */
const OPEN: Array<SceneMemory> = [];

after(async () => {
  for (const scene of OPEN.splice(0)) await scene.memory.close();
});

describe('a diary turn', () => {
  before(() => useIface('fake'));
  after(() => useIface('discord'));

  test('diary turn: reactions and gifs are dropped, reply attributes ignored, urls stripped', async () => {
    const history = [ownRaw('m1', NOW - DAY, 'hier')];
    const llm = fakeLlm(
      null,
      '<react to="#1">👍</react><msg reply="#1">see https://example.org/a now</msg><msg>https://example.org/b</msg><msg>deux</msg><msg>trois</msg><gif>g1</gif>'
    );
    const channel = diaryChannel({ historyMessages: history });
    const result = await runner({ llm }).runTurn({ channel, mode: 'diary', diary: {} });
    assert.equal(loose(result).outcome, 'spoke');
    // Stage 3: the turn sends nothing; the expectation below is what the mirror's publication of the entry sends.
    await published(result, channel);
    assert.deepEqual(
      channel.sent.map((payload) => payload.content),
      ['see now', 'deux\ntrois'],
      'links removed, a message left empty dropped, the fourth joined into the third by the parser'
    );
    assert.ok(
      channel.sent.every((payload) => payload.reply === undefined),
      'nothing posted as a reply'
    );
    assert.equal(channel.reactCalls.length, 0);
    assert.equal(loose(result).diary.messages, 2);
  });

  test("diary turn: an audience named beside a call holds when the persona's messages come in a later answer", async () => {
    // Catches: only the last answer's tag being read, so the restriction the persona named first falls open to unrestricted.
    const llm = fakeLlm(null, [
      drawAnswer('<audience>interface:nowhere</audience><msg>brume</msg>'),
      '<msg>brume sans image</msg>',
    ]);
    const images = fakeImages({ fail: new ImageGenError('error') });
    const result = await runner({ llm, store: fakeStore(), images }).runTurn({
      channel: diaryChannel(),
      mode: 'diary',
      diary: {},
    });
    const { audience } = (result as { diary: { audience: unknown } }).diary;
    assert.deepEqual(audience, { ok: false, code: 'audience-unknown-interface' });
  });
});

/** A model whose plan is a thought and whose writer says `answer`; it keeps every request. */
function modelSaying(answer: string) {
  const calls: Array<unknown> = [];
  return {
    calls,
    complete: (messages: unknown, options?: { purpose?: string }) => {
      calls.push(structuredClone(messages));
      return Promise.resolve(directorAnswer(messages, options) ?? { text: answer, usage: {}, estimated: 5 });
    },
  };
}

/**
 * Two interfaces that share native ids: `fake` and `other`, each with a root `g1` and a channel `d1`, `fake` with
 * another channel `d2` and a channel `d3` outside the root, a private chat, and enabled mirrors as named.
 */
async function places(mirrorOn: ReadonlyArray<'fake:d1' | 'fake:d2' | 'fake:d3' | 'other:d1'> = []) {
  const scene = await mirrorScene({ ifaces: ['fake', 'other'] });
  const fakeRoot = scene.place({ iface: 'fake', native: 'g1', kind: 'root' });
  const otherRoot = scene.place({ iface: 'other', native: 'g1', kind: 'root' });
  scene.place({ iface: 'fake', native: 'd1', parent: fakeRoot });
  scene.place({ iface: 'fake', native: 'd2', parent: fakeRoot });
  scene.place({ iface: 'fake', native: 'd3' });
  scene.place({ iface: 'other', native: 'd1', parent: otherRoot });
  scene.place({ iface: 'fake', native: 'u1', kind: 'dm' });
  for (const one of mirrorOn) {
    const [iface, chatId] = one.split(':') as [string, string];
    scene.db
      .prepare(
        "INSERT INTO mirrors (id, row_kind, place_id, enabled, created_at, created_by, extra) VALUES (?, 'diary', ?, 1, ?, 'owner', NULL)"
      )
      .run(`mirror:test:${one}`, `${iface}:channel:${chatId}`, new Date(T0).toISOString());
  }
  return scene;
}

/** One diary turn in which the persona answers `answer`, over the scene's memory: the turn's result and the model's requests. */
async function writeEntry(scene: Scene, answer: string) {
  freshWorld();
  world().channel({ id: 'd1', name: 'journal', placeId: ROOT });
  const store = createStore({ dataDir: scene.memory.dataDir, memoryDb: scene.memory.memoryDb });
  const model = modelSaying(answer);
  const result = await sceneRunner(model, store).runTurn({
    mode: 'diary',
    diary: { kind: 'thought', forced: true },
    placeId: ROOT,
  });
  await store.flushSettled({});
  return { result, entry: entryOf(result), store, writer: model.calls.at(-1) };
}

test('the audience tag is no part of what the persona says', async () => {
  // Text outside the tags is never sent since 2026-11-13 (specs/2026-11-13-bare-text-is-never-sent.md): the answer is
  // written in `<msg>` now, as the untagged path that this test used no longer makes an entry.
  // Catches: the audience tag staying in the persona's words and being posted on the channel.
  const scene = await places(['fake:d1']);
  const { entry } = await writeEntry(scene, `<audience>interface:fake</audience><msg>${TEXT}</msg>`);
  assert.deepEqual(entry.messages, [TEXT]);
  await scene.publisher().publishEntry(entry);
  assert.deepEqual(scene.transport('fake').posted('d1'), [TEXT]);
  assert.equal(diaryRows(scene.memory.memoryDb)[0]?.text, TEXT);
});

const MARKER = 'BARE-TEXT-NOT-SENT';

/** The test's own wording of the diagnostic: its marker, then the count of characters. */
const WORDED = `${MARKER} {chars}`;

const replyLabels = {
  ...labels,
  tools: { ...labels.tools, diagnostics: { ...labels.tools.diagnostics, bareText: WORDED } },
};

/** The persona's working words, outside every tag, each word one no message of these tests holds. */
const BARE = 'ετοιμάζω πρώτα εικόνα έπειτα γράφω';

const BARE_OTHER = 'ξανασκέφτομαι αλλιώς μάλλον περιμένω';

const MARKED = `${MARKER} ${BARE.length}`;

const THINK = '<think>σχέδιο</think>';

const SAY = '<think>τώρα σωστά</think><msg>ναι εντάξει</msg>';

const texts = (sends: ReadonlyArray<Record<string, unknown>>): Array<string> => sends.map((send) => String(send.text));

/** The texts the adapter was asked to send, in order, whenever the turn that sent them ran. */
function sentTexts(port: Fake): Array<string> {
  const { calls } = port;
  return calls.filter((one) => one.op === 'send').map((one) => String((one.args[1] as { text?: string }).text));
}

/** How many requests the model got. */
function requestCount(llm: FakeLlm): number {
  const { calls } = llm;
  return calls.length;
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

// ---------- a <thinking> block is the persona's think ----------

// The second spelling of the persona's thinking: a whole `<thinking>` block is read as
// `<think>`, so it is no bare text, it is the turn's think, and their earlier answer stands in the next request with the
// block as `<think>`. Their last answer holds no think of its own, so the think the record keeps can only be the block's.
const THINKING_TEXT = 'κοιτάζω πρώτα τον κατάλογο';

const THINKING = `<thinking>${THINKING_TEXT}</thinking>`;

const SAY_NO_THINK = '<msg>ναι εντάξει</msg>';

describe('a reply of bare text', () => {
  before(() => useIface('fake'));
  after(() => useIface('discord'));

  // ---------- a reply turn ----------

  test('a reply whose first answer is bare text posts nothing and asks once more with the diagnostic', async () => {
    // Bug: the bare words go out as one message, or the turn gives up without asking again.
    const run = await coreTurn({ answers: [`${THINK}${BARE}`, SAY], prompts: { labels: replyLabels } });
    assert.equal(requestCount(run.llm), 2);
    assert.equal(wholeRequest(run.llm, 0).includes(MARKER), false, 'the first request holds no diagnostic yet');
    assert.ok(
      wholeRequest(run.llm, 1).includes(MARKED),
      'the second request tells the persona the count of characters'
    );
    assert.deepEqual(texts(run.sends), ['ναι εντάξει']);
    assertNoWordOf(BARE, texts(run.sends));
    assert.equal(asRecord(run.result).outcome, 'spoke');
  });

  test('a reply whose two answers are both bare text posts nothing and ends after two requests', async () => {
    // Bug: the second bare answer is posted because only the first was held back, or the turn keeps asking.
    const run = await coreTurn({
      answers: [`${THINK}${BARE}`, `${THINK}${BARE_OTHER}`, SAY],
      prompts: { labels: replyLabels },
    });
    assert.equal(requestCount(run.llm), 2);
    assert.deepEqual(texts(run.sends), []);
    assert.equal(asRecord(run.result).outcome, 'skip');
  });

  test('the next request after a turn ended on bare text twice carries the diagnostic as a fact', async () => {
    // Bug: the turn ends in silence and the persona never learns their words were not posted (no silent failure).
    const run = await coreTurn({
      answers: [`${THINK}${BARE}`, `${THINK}${BARE_OTHER}`, SAY],
      prompts: { labels: replyLabels },
    });
    await run.again();
    assert.equal(requestCount(run.llm), 3, "the next turn asked once, and the persona's answer in it stood");
    assert.ok(wholeRequest(run.llm, 2).includes(MARKER), 'the next turn tells the persona');
    // `run.sends` is a snapshot of the first turn: the adapter's record holds the second turn's post too.
    assert.deepEqual(sentTexts(run.port), ['ναι εντάξει']);
  });

  test('a reply whose last request answers with bare text posts nothing and asks no more', async () => {
    // Bug: the last request has no request left to follow it, so the fallback posted its words as the final say.
    const run = await coreTurn({
      answers: [toolAnswer(THINK, [call('lore.list')]), `${THINK}${BARE}`, SAY],
      loop: { maxSteps: 1 },
      prompts: { labels: replyLabels },
    });
    assert.equal(requestCount(run.llm), 2, 'the read, then the last request');
    assert.deepEqual(texts(run.sends), []);
    assertNoWordOf(BARE, texts(run.sends));
  });

  test("a turn that ended on bare text at its last request leaves the diagnostic for the persona's next request", async () => {
    // Bug: the last request has nowhere to tell the persona in the turn, and the fact is dropped with it.
    const run = await coreTurn({
      answers: [toolAnswer(THINK, [call('lore.list')]), `${THINK}${BARE}`, SAY],
      loop: { maxSteps: 1 },
      prompts: { labels: replyLabels },
    });
    assert.equal(wholeRequest(run.llm, 1).includes(MARKER), false, 'the last request is the answer to it');
    await run.again();
    assert.ok(wholeRequest(run.llm, 2).includes(MARKER), 'the next turn tells the persona');
  });

  test('a reply whose only answer is a <thinking> block and a <msg> posts the message and is not asked again', async () => {
    // Catches: the block taken for a broken think or bare text, so the message is held back and the turn asks once more.
    const run = await coreTurn({ answers: [`${THINKING}${SAY_NO_THINK}`, SAY], prompts: { labels: replyLabels } });
    assert.equal(requestCount(run.llm), 1);
    assert.deepEqual(texts(run.sends), ['ναι εντάξει']);
  });
});
