// src/turn/request/frame.ts: the turn frame, the facts of one turn fixed before any block of its request. The lists are
// the root tags of each turn kind's request, in their order.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  type BlockName,
  blocksOf,
  framedRequest,
  FrameError,
  frameOf,
  type TurnKind,
  turnKindOf,
} from '../../../../src/turn/request/frame.ts';
import { AUTHOR, DM, DM_CHAIN, PARTNER, ROOM_CHAIN, frameInput, wakeInput } from '../../../fixtures/frame-input.ts';
import { userText as contentText } from '../../../../src/behavior/prompt.ts';
import { createTurnRunner as createRealTurnRunner } from '../../../../src/behavior/turn.ts';
import { objectMediaCache } from '../../../../src/memory/store-media.ts';
import '../../../../src/tools/operations/index.ts';
import type { Untyped } from '../../../../src/tools/types.ts';
import { buildRequest } from '../../../fixtures/built-request.ts';
import { type LogEntry, withCapturedLogs } from '../../../fixtures/capture-logs.ts';
import type { SceneMemory } from '../../../fixtures/diary-scene.ts';
import { labels } from '../../../fixtures/labels.ts';
import { baseInput } from '../../../fixtures/prompt-rig.ts';
import { directorAnswer } from '../../../fixtures/scene-answer.ts';
import {
  blockOf,
  MARK,
  rootTags,
  type ServiceRun,
  serviceTurn,
  serviceWake,
  TURN_NOW,
} from '../../../fixtures/service-turn.ts';
import { call, completionOf, toolAnswer } from '../../../fixtures/tool-answers.ts';
import { type Channel, onWorld, useIface, useSelf, world } from '../../../fixtures/turn-world.ts';

type Mode = Parameters<typeof turnKindOf>[0];
type TriggerKind = Parameters<typeof turnKindOf>[1];
type WakeKind = Parameters<typeof turnKindOf>[2];

// The block of custom emoji and stickers is <media>, the legend, and it stands right after `<meanwhile>` in every list.
// What repeats between turns comes first, the turn's own blocks after it, and `<found>` is a root tag of its own.
const REPLY_LIST: ReadonlyArray<BlockName> = [
  'persona',
  'self',
  'surroundings',
  'memory',
  'meanwhile',
  'media',
  'chat',
  'recall',
  'found',
  'inner',
  'spatial_awareness',
  'task',
];
// `<meanwhile>` stands before the turn's own blocks.
const SERVICE_LIST: ReadonlyArray<BlockName> = [
  'persona',
  'self',
  'memory',
  'meanwhile',
  'media',
  'recall',
  'found',
  'inner',
  'spatial_awareness',
  'task',
];
// A diary entry is a service turn built as the heartbeat's, so its list holds no `<meanwhile>`, `<recall>` or
// `<found>`.
const DIARY_LIST: ReadonlyArray<BlockName> = [
  'persona',
  'self',
  'memory',
  'media',
  'inner',
  'spatial_awareness',
  'task',
];

// ---- the list of each kind ----

test('a reply reads the ordinary turn in the order of its list', () => {
  // Bug: a tag is missing from the list or out of order, and the request is built without it.
  const frame = frameOf(frameInput());
  assert.equal(frame.kind, 'reply');
  assert.deepEqual(frame.blocks, REPLY_LIST);
});

test('an errand result in a place reads the ordinary turn', () => {
  // Bug: a finished errand is taken for a service and loses the chat it answers.
  const frame = frameOf(frameInput({ triggerKind: 'errand' }));
  assert.equal(frame.kind, 'errand_result');
  assert.deepEqual(frame.blocks, REPLY_LIST);
});

test('a heartbeat reads its own list', () => {
  // Bug: the heartbeat keeps `<chat>` or `<surroundings>` of the place its wake rode in on.
  // A heartbeat lists people and places in `<memory>` and draws `<fragments>`, with no `<meanwhile>`, `<media>`,
  // `<recall>` or `<found>`.
  const frame = frameOf(wakeInput('heartbeat'));
  assert.equal(frame.kind, 'heartbeat');
  assert.deepEqual(frame.blocks, ['persona', 'self', 'memory', 'inner', 'fragments', 'spatial_awareness', 'task']);
});

test('an intention with a place reads the ordinary turn in that place', () => {
  // Bug: an intention is always nowhere, and the persona cannot see the room they meant to begin in.
  const frame = frameOf(wakeInput('intention_due', { chain: ROOM_CHAIN }));
  assert.equal(frame.kind, 'intention');
  assert.equal(frame.place?.id, 'place:room');
  assert.deepEqual(frame.blocks, REPLY_LIST);
});

test('an intention without a place reads the service list and is nowhere', () => {
  // Bug: an intention with no place throws as a reply with no place, and the due intention is lost.
  const frame = frameOf(wakeInput('intention_due'));
  assert.equal(frame.kind, 'intention');
  assert.equal(frame.place, null);
  assert.deepEqual(frame.blocks, SERVICE_LIST);
});

test('a feedback wake with a place reads the ordinary turn in that place', () => {
  // Bug: feedback about an action in a room arrives with no sight of that room.
  const frame = frameOf(wakeInput('feedback', { chain: ROOM_CHAIN }));
  assert.equal(frame.kind, 'feedback');
  assert.deepEqual(frame.blocks, REPLY_LIST);
});

test('a feedback wake without a place reads the service list and is nowhere', () => {
  // Bug: feedback with no cause place is read as a reply with no place and throws.
  const frame = frameOf(wakeInput('feedback'));
  assert.equal(frame.kind, 'feedback');
  assert.equal(frame.place, null);
  assert.deepEqual(frame.blocks, SERVICE_LIST);
});

test('a diary post reads the service list after meanwhile', () => {
  // Bug: the writer's request is still built as a reply in the mirror.
  const frame = frameOf(wakeInput(null, { mode: 'diary', triggerKind: null }));
  assert.equal(frame.kind, 'diary');
  assert.deepEqual(frame.blocks, DIARY_LIST);
});

// ---- the place, the counterpart, why the persona is awake ----

test('a reply without a place throws a FrameError with its code', () => {
  // Bug: the reply is built with no place, and the persona answers nowhere or into the wrong room.
  assert.throws(
    () => frameOf(frameInput({ chain: [] })),
    (error: unknown) => error instanceof FrameError && error.code === 'PLACE_REQUIRED'
  );
});

test('a room has its path by names from the interface down, and its root', () => {
  // Bug: the path comes in the chain's order, leaf first, and `<surroundings>` names the room before the server.
  const frame = frameOf(frameInput());
  assert.deepEqual(frame.place, {
    id: 'place:room',
    name: 'γενικά',
    kind: 'channel',
    path: ['fake', 'Αγορά', 'γενικά'],
  });
  assert.equal(frame.root?.id, 'place:root');
  assert.equal(frame.scope, 'group');
});

test('a one-to-one chat has no name and no root, and its row holds no name', () => {
  // Bug: the unnamed row renders as an empty path, or a home server is made up as its root.
  // One handle per person: a request names the partner by handle and holds no platform id.
  const frame = frameOf(frameInput({ chain: DM_CHAIN, dm: DM }));
  assert.equal(frame.place?.name, null);
  // A request reads a place in words, with no path and no scope word. The reference is tested in
  // tests/src/turn/request/text.test.ts and tests/src/turn/request/surroundings.test.ts.
  assert.equal(frame.root, null);
  assert.equal(frame.scope, 'dm');
});

test('a heartbeat has no place even when its wake rides on a room, and awake names the wake', () => {
  // Bug: the transport anchor of a wake is taken for where the persona is.
  const frame = frameOf(wakeInput('heartbeat', { chain: ROOM_CHAIN }));
  assert.equal(frame.place, null);
  assert.equal(frame.root, null);
  assert.equal(frame.scope, 'internal');
  assert.equal(frame.awake, 'wake');
  assert.equal(frame.wakeKind, 'heartbeat');
});

test('the counterpart of a group is the author of the trigger, and the frame answers that message', () => {
  // Bug: the counterpart stays empty in a group, or the answered message is lost.
  const frame = frameOf(frameInput());
  assert.deepEqual(frame.counterpart, AUTHOR);
  assert.deepEqual(frame.answers, { messageId: 'm1', authorId: '1111' });
  assert.equal(frame.awake, 'message');
});

test('the counterpart of a one-to-one chat is the partner when no message of theirs triggers the turn', () => {
  // Bug: the counterpart is read off the trigger, so an errand result in a one-to-one chat talks to nobody.
  const frame = frameOf(frameInput({ triggerKind: 'errand', chain: DM_CHAIN, dm: DM, trigger: null, author: null }));
  assert.deepEqual(frame.counterpart, PARTNER);
  assert.equal(frame.answers, null);
  assert.equal(frame.awake, 'errand');
});

test('a group turn with no trigger has no counterpart', () => {
  // Bug: an errand result whose origin message is gone invents an author.
  const frame = frameOf(frameInput({ triggerKind: 'errand', trigger: null, author: null }));
  assert.equal(frame.counterpart, null);
  assert.equal(frame.answers, null);
});

test('a diary post is nowhere and awake says so', () => {
  // Bug: the writer inherits the mirror's place, and the post reads as a reply there.
  const frame = frameOf(wakeInput(null, { mode: 'diary', triggerKind: null, chain: ROOM_CHAIN }));
  assert.equal(frame.place, null);
  assert.equal(frame.scope, 'internal');
  assert.equal(frame.awake, 'diary');
});

// ---- which requests are the frame's own ----

test("every inner turn's request is the frame's own, with a place and without", () => {
  // Bug: a service or an intention keeps the old emission with `<wake>`, so its request has no `<meanwhile>` or
  // `<memory>`.
  const inputs = [
    wakeInput('heartbeat'),
    wakeInput('intention_due'),
    wakeInput('intention_due', { chain: ROOM_CHAIN }),
    wakeInput('feedback'),
    wakeInput('feedback', { chain: ROOM_CHAIN }),
    frameInput({ triggerKind: 'errand' }),
  ];
  for (const input of inputs) {
    const frame = frameOf(input);
    assert.equal(framedRequest(frame), true, `${frame.kind} ${frame.place?.id ?? 'nowhere'}`);
  }
});

// ---- the kind of a turn ----

const KIND_CASES: ReadonlyArray<[Mode, TriggerKind, WakeKind, TurnKind]> = [
  ['reply', 'mention', null, 'reply'],
  ['reply', 'reply', null, 'reply'],
  ['reply', 'followUp', null, 'reply'],
  ['reply', 'overheard', null, 'reply'],
  ['reply', 'private', null, 'reply'],
  ['reply', 'missed', null, 'reply'],
  ['interject', null, null, 'reply'],
  ['initiate', null, null, 'reply'],
  ['elsewhere', null, null, 'reply'],
  ['reply', 'errand', null, 'errand_result'],
  ['interject', 'errand', null, 'errand_result'],
  ['inner', 'inner', 'heartbeat', 'heartbeat'],
  ['inner', 'inner', 'intention_due', 'intention'],
  ['inner', 'inner', 'attend', 'intention'],
  ['inner', 'inner', 'errand_deadline', 'intention'],
  ['inner', 'inner', 'feedback', 'feedback'],
  ['diary', null, null, 'diary'],
];

for (const [mode, triggerKind, wakeKind, kind] of KIND_CASES) {
  test(`turnKindOf gives ${kind} for mode ${mode}, trigger ${String(triggerKind)}, wake ${String(wakeKind)}`, () => {
    // Bug: the three fields the callers still pass map to the wrong list of blocks.
    assert.equal(turnKindOf(mode, triggerKind, wakeKind), kind);
  });
}

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

  test('diary: an errand is accepted, waits for its end and its result is read in the next request', async () => {
    // Bug caught: the diary turn refuses the errand as diary-draw-only, or answers queued and never reads the result.
    const hot = fakeHot();
    Object.assign(hot.config.bot, { access: { 'errand.scout': { everyone: false, roles: [], users: ['self-id'] } } });
    const waits: Array<unknown> = [];
    const runOp = (op: string, _args: unknown, context: Record<string, unknown>) => {
      waits.push(context.waitMs);
      const text = 'ΤΟ ΑΠΟΤΕΛΕΣΜΑ ΤΟΥ ΗΜΕΡΟΛΟΓΙΟΥ';
      return { status: 'ok', code: 'ok', summary: text, data: { text, task: { id: 'e1' }, waited: true } };
    };
    const errands = { budget: () => ({ spent: false, key: null, code: null }), view: () => [] };
    const llm = fakeLlm(null, [toolAnswer('', [call('errand.scout', { goal: 'find the pier' })]), '<msg>y</msg>']);
    const { logs } = await withCapturedLogs(() =>
      runner({ hot, llm, extra: { runOp, errands } }).runTurn({ channel: diaryChannel(), mode: 'diary', diary: {} })
    );
    assert.deepEqual(calledOf(logs), ['errand.scout:ok']);
    assert.ok(Number(waits[0]) > 0, 'the call carries the time it may wait');
    // Changed: the kind drawn here takes no scene and the planner is gone, so the persona's requests are the only ones.
    assert.equal(llm.calls.length, 2, 'the request with the call and the request that reads the result');
    assert.ok(JSON.stringify(llm.calls[1]).includes('ΤΟ ΑΠΟΤΕΛΕΣΜΑ ΤΟΥ ΗΜΕΡΟΛΟΓΙΟΥ'));
  });
});

const HOUR = 3_600_000;

/** A purpose past the 200 characters a line of `<intentions>` keeps, with a marker at its end. */
const DUE_PURPOSE = `${'να γράψω στον κήπο για τα λουλούδια της άνοιξης '.repeat(6)}ΤΕΛΟΣ-ΣΚΟΠΟΥ`;

type Made = { ok: boolean; intention?: { id: string } };

/** Seeds three open intentions, the due one made second, and gives its id through `due`. */
function seeded(due: { id: string }, place: string | null) {
  return (service: ServiceRun['intentions']): void => {
    service.set({ purpose: 'ΑΛΛΗ-ΠΡΩΤΗ', dueAt: TURN_NOW + 5 * HOUR, by: 'persona' });
    const made = service.set({
      purpose: DUE_PURPOSE,
      dueAt: TURN_NOW - 60_000,
      destination: place,
      by: 'persona',
    }) as Made;
    due.id = made.intention?.id ?? '';
    service.set({ purpose: 'ΑΛΛΗ-ΤΡΙΤΗ', dueAt: TURN_NOW + 6 * HOUR, by: 'persona' });
  };
}

const dueWake = (id: string): Record<string, unknown> =>
  serviceWake('intention_due', {
    items: [{ kind: 'intention_due', reason: 'due', intentionIds: [id], errandId: null }],
    intentions: [{ id, purpose: DUE_PURPOSE, dueAt: TURN_NOW - 60_000 }],
    chainId: id,
  });

describe('an intention in an inner turn', () => {
  before(() => useIface('fake'));
  after(() => useIface('discord'));

  test('an intention with a place builds the reply frame there, and <intentions> opens with the due one whole', async () => {
    // Bug: the intention turn keeps `<wake>`, loses the room it meant to begin in, or cuts the due purpose to a line.
    const due = { id: '' };
    const run = await serviceTurn({
      wake: () => dueWake(due.id),
      answers: ['<skip/>'],
      chat: { iface: 'fake', chatId: 'c1' },
      seed: seeded(due, 'c1'),
    });
    const text = run.requests[0] ?? '';
    const tags = rootTags(text);
    assert.ok(tags.includes('chat') && tags.includes('surroundings'), tags.join(' '));
    const inner = blockOf(text, 'inner');
    const intentions = /<intentions>\n([\s\S]*?)\n<\/intentions>/.exec(inner)?.[1] ?? '';
    assert.ok(intentions.includes(DUE_PURPOSE), intentions);
    assert.ok(intentions.indexOf(DUE_PURPOSE) < intentions.indexOf('ΑΛΛΗ-ΠΡΩΤΗ'), 'the due one before an older one');
    assert.ok(text.includes(MARK.inner), 'the intention task');
  });

  test('an intention without a place builds the service frame, nowhere', async () => {
    // Bug: an intention with no place runs in a recent room, or throws as a reply with no place.
    const due = { id: '' };
    const run = await serviceTurn({
      wake: () => dueWake(due.id),
      answers: ['<skip/>'],
      chat: null,
      seed: seeded(due, null),
    });
    const tags = rootTags(run.requests[0] ?? '');
    assert.equal(tags.includes('chat'), false, tags.join(' '));
    assert.equal(tags.includes('surroundings'), false, tags.join(' '));
    assert.ok(tags.includes('meanwhile'), tags.join(' '));
  });

  test("an intention in a place orders its blocks as a reply: <chat>, then <inner> with the persona's intentions, then <task>", async () => {
    // Bug: the cache layout puts the turn's
    // own blocks after `<chat>`, and an intention in a place keeps the old order, `<inner>` and `<spatial_awareness>` before
    // the chat, because only the reply's list moved.
    const order = [
      'self',
      'surroundings',
      'memory',
      'meanwhile',
      'chat',
      'recall',
      'found',
      'inner',
      'spatial_awareness',
      'task',
    ];
    const due = { id: '' };
    const run = await serviceTurn({
      wake: () => dueWake(due.id),
      answers: ['<skip/>'],
      chat: { iface: 'fake', chatId: 'c1' },
      seed: seeded(due, 'c1'),
    });
    const tags = rootTags(run.requests[0] ?? '');
    for (const tag of ['chat', 'inner', 'spatial_awareness', 'task']) assert.ok(tags.includes(tag), tags.join(' '));
    assert.deepEqual(
      tags,
      order.filter((tag) => tags.includes(tag))
    );
  });
});

const DAY = 86_400_000;

/** The service list without `persona`, which is the system message and no root tag of the user text. */
const SERVICE_TAGS = blocksOf('heartbeat', null).filter((name) => name !== 'persona');

/**
 * The tags a heartbeat request may not omit. Changed: `meanwhile` was among them; a heartbeat lists the people and
 * places memory holds in `<memory>` and holds no `<meanwhile>` (spec 2026-11-17-heartbeat-own-request).
 */
const ALWAYS = ['self', 'memory', 'spatial_awareness', 'task'];

/** Whether `tags` keep the order of `list` and hold nothing else. */
function inOrderOf(tags: ReadonlyArray<string>, list: ReadonlyArray<string>): boolean {
  let at = -1;
  for (const tag of tags) {
    const next = list.indexOf(tag, at + 1);
    if (next < 0) return false;
    at = next;
  }
  return true;
}

describe('an inner turn of a service', () => {
  before(() => useIface('fake'));
  after(() => useIface('discord'));

  test('a heartbeat request holds the service list in its order, with no <chat> and no <surroundings>', async () => {
    // Bug: the heartbeat keeps the old `<wake>` emission, or the chat and surroundings of a stand-in chat.
    const run = await serviceTurn({ wake: serviceWake('heartbeat'), answers: ['<skip/>'], chat: null });
    const text = run.requests[0] ?? '';
    const tags = rootTags(text);
    assert.ok(inOrderOf(tags, SERVICE_TAGS), tags.join(' '));
    for (const tag of ALWAYS) assert.ok(tags.includes(tag), `holds <${tag}>`);
    assert.ok(text.includes(MARK.heartbeat), 'its own task');
  });

  test("a heartbeat orders its blocks with what repeats first and the turn's own last: <memory> before <inner>", async () => {
    // Bug: the cache layout puts the turn's
    // own blocks last, and a list keeps `<inner>` with the persona's day and intentions before `<memory>`.
    // Changed: the order held `meanwhile`, `recall` and `found`; a heartbeat holds none of them and holds `<fragments>`
    // after `<inner>` (spec 2026-11-17-heartbeat-own-request).
    const order = ['self', 'memory', 'inner', 'fragments', 'spatial_awareness', 'task'];
    const run = await serviceTurn({
      wake: serviceWake('heartbeat'),
      answers: ['<skip/>'],
      chat: null,
      seed: (service) => service.set({ purpose: 'ΚΑΠΟΤΕ-ΑΡΓΟΤΕΡΑ', dueAt: TURN_NOW + DAY, by: 'persona' }),
    });
    const tags = rootTags(run.requests[0] ?? '');
    for (const tag of ['memory', 'inner', 'spatial_awareness', 'task']) assert.ok(tags.includes(tag), tags.join(' '));
    assert.deepEqual(
      tags,
      order.filter((tag) => tags.includes(tag))
    );
  });
});

test('buildRequest: a heartbeat frame emits no <chat>, whatever the other fields say', () => {
  // The fields disagree on purpose. Bug: the branch still reads `mode` and `wakeKind`, and the persona's own time carries the chat.
  const request = buildRequest(baseInput({ mode: 'reply', frame: frameOf(wakeInput('heartbeat')) }));
  const [, user] = request.messages;
  assert.doesNotMatch(contentText(user.content), /^<chat>$/m);
});

test('buildRequest: a reply frame emits <chat>, whatever the other fields say', () => {
  // The fields disagree on purpose. Bug: the old `mode` and `wakeKind` branch empties the history of a reply.
  const request = buildRequest(baseInput({ mode: 'inner', wakeKind: 'heartbeat', frame: frameOf(frameInput()) }));
  const [, user] = request.messages;
  assert.match(contentText(user.content), /^<chat>$/m);
});
