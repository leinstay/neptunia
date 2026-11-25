// Tests for src/turn/handles.ts: the turn's one handle registry. Every `#n` of a request is issued here, and
// `canonical` replaces each reference in a text bound for a durable row by the line's identity
// `src:<iface>:<message id>:<revision>` and cuts a number that resolves to nothing, so a reference survives the turn.
// The identity is written from the target's interface, message id and revision, the columns of the line's source row,
// never from the text of its source id. Pure.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHandles, targetOfSource } from '../../../src/turn/handles.ts';
import { readFileSync, rmSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { start } from '../../../scripts/lib/fake-interface.ts';
import { startCore } from '../../../src/core.ts';
import { objectMediaCache } from '../../../src/memory/store-media.ts';
import type { MessageEvent } from '../../../src/protocol/adapter.ts';
import { withCapturedLogs } from '../../fixtures/capture-logs.ts';
import { chainsOf } from '../../fixtures/chains.ts';
import { channelInfo, lineEvent, SELF, until } from '../../fixtures/core-over-fake.ts';
import { addClient, CLI_CLIENT, FAKE_CLIENT, folders, query, runCli } from '../../fixtures/core-units.ts';
import { labels } from '../../fixtures/labels.ts';
import { blockOf, replyTurns, serviceWorld, TURN_NOW } from '../../fixtures/service-turn.ts';
import { call, type Completion, toolAnswer } from '../../fixtures/tool-answers.ts';
import { createTurnRunner } from '../../fixtures/turn-runner.ts';
import { useIface, world } from '../../fixtures/turn-world.ts';

const PLACE = 'discord:channel:room-1';

/** A registry holding fifteen chat lines, numbered `#1` to `#15` in order, `#n` being message `m-<n>` at revision 1. */
function fifteenLines() {
  const handles = createHandles();
  const numbers: Array<number> = [];
  for (let i = 1; i <= 15; i += 1)
    numbers.push(
      handles.issue('chat', {
        sourceId: `src:discord:m-${i}:1:seen`,
        iface: 'discord',
        placeId: PLACE,
        messageId: `m-${i}`,
        revision: 1,
      })
    );
  assert.deepEqual(
    numbers,
    Array.from({ length: 15 }, (_, i) => i + 1),
    'the chat lines are numbered from 1 in order'
  );
  return { handles };
}

test('canonical replaces a chat line, a reply parent, a pulled line and a search handle by distinct identities, and cuts an unknown number', () => {
  // Bug: two producers number from 1 and collide, or a number nobody can read back is stored as it is.
  const handles = createHandles();
  const chat = handles.issue('chat', {
    sourceId: 'src:discord:m-1:1:seen',
    iface: 'discord',
    placeId: PLACE,
    messageId: 'm-1',
    revision: 1,
  });
  const parent = handles.issue('parent', {
    sourceId: 'src:discord:m-2:3:seen',
    iface: 'discord',
    placeId: PLACE,
    messageId: 'm-2',
    revision: 3,
  });
  const pulled = handles.issue('pulled', {
    sourceId: 'src:telegram:m-3:1:seen',
    iface: 'telegram',
    placeId: 'telegram:channel:g-9',
    messageId: 'm-3',
    revision: 1,
  });
  const search = handles.issue('search', {
    sourceId: 'src:discord:m-4:2:said',
    iface: 'discord',
    placeId: PLACE,
    messageId: 'm-4',
    revision: 2,
  });
  assert.equal(new Set([chat, parent, pulled, search]).size, 4);
  const unknown = Math.max(chat, parent, pulled, search) + 7;
  const out = handles.canonical(`a #${chat} b #${parent} c #${pulled} d #${search} e #${unknown} f`);
  assert.ok(out.startsWith('a src:discord:m-1:1 b src:discord:m-2:3 c src:telegram:m-3:1 d src:discord:m-4:2 e'), out);
  assert.ok(out.endsWith(' f'), out);
  assert.ok(!/#\d/.test(out), out);
});

test('canonical leaves a number glued to a letter or to a word before it as it is', () => {
  // Bug: a hashtag, a colour or an issue number in the persona's words is rewritten into a line's identity.
  const { handles } = fifteenLines();
  for (const text of ['#12a', 'x#12', 'issue#12 here', '#12b and #12c'])
    assert.equal(handles.canonical(text), text, text);
});

test('canonical reads a bare number, a number in parentheses and a range as references', () => {
  // Bug: only the bare form is recognised, so `(#12)` and `#12-#15` survive into stored text.
  const { handles } = fifteenLines();
  assert.equal(handles.canonical('#12'), 'src:discord:m-12:1');
  assert.equal(handles.canonical('(#12)'), '(src:discord:m-12:1)');
  const range = handles.canonical('#12-#15');
  assert.ok(range.includes('src:discord:m-12:1') && range.includes('src:discord:m-15:1'), range);
  assert.ok(!range.includes('#'), range);
});

test("canonical writes a line's identity from its interface, message id and revision, whatever its source id spells", () => {
  // Bug: the identity was cut out of the source id's text, so a source stored under an opaque id or an older spelling
  // left the persona's words naming a line no reader finds.
  const handles = createHandles();
  const opaque = handles.issue('chat', {
    sourceId: 'source:7f3a',
    iface: 'discord',
    placeId: PLACE,
    messageId: 'm-8',
    revision: 2,
  });
  const respelled = handles.issue('search', {
    sourceId: 'src:discord:family-key:1:seen',
    iface: 'discord',
    placeId: PLACE,
    messageId: 'm-9',
    revision: 3,
  });
  assert.equal(handles.canonical(`#${opaque} #${respelled}`), 'src:discord:m-8:2 src:discord:m-9:3');
});

test('canonical keeps the source id of a line whose interface nobody stored', () => {
  // Bug: a line with no interface became `src:null:...`, an identity that names nothing.
  const handles = createHandles();
  const n = handles.issue('search', {
    sourceId: 'source:legacy-1',
    iface: null,
    placeId: PLACE,
    messageId: 'm-1',
    revision: 1,
  });
  assert.equal(handles.canonical(`#${n}`), 'source:legacy-1');
});

test("a quoted line's target takes the revision its stored source holds, whatever the source id spells", () => {
  // Bug: the revision was cut out of the source id's text, so a source under an opaque id was always revision 1.
  const target = targetOfSource({ sourceId: 'source:7f3a', placeId: PLACE, iface: 'discord', revision: 3 }, 'm-8');
  assert.equal(target.revision, 3);
});

const NOW = Date.parse('2026-10-24T12:00:00Z');

const NATIVE = 'same-native-message';

type Running = Awaited<ReturnType<typeof start>>;

function event(eventId: string, room: string, text: string, edit = false): MessageEvent {
  const input = lineEvent({ id: NATIVE, chatId: room, text, at: NOW - 60_000 });
  return { ...input, id: eventId, at: NOW, edit };
}

async function boot(complete?: (messages: unknown, options?: unknown) => Promise<Completion>) {
  const dirs = folders({
    bot: { timezone: 'UTC', placeId: 'g1', owners: ['u1'] },
    models: { routes: chainsOf({ video: false }) },
    gifs: { backfillMessages: 0 },
    features: {
      spontaneous: false,
      eavesdrop: false,
      followUp: false,
      participation: false,
      offlineCatchUp: false,
      diary: false,
      mediaDescriptions: false,
      channelRoute: false,
      memoryPrefetch: false,
      channelPull: false,
      elsewhere: false,
      speech: false,
      pauseNotice: false,
    },
    tools: { loop: { maxSteps: 4, timeBudgetMs: 15_000, maxCallsPerStep: 2 } },
  });
  addClient(dirs.privateDir, CLI_CLIENT);
  addClient(dirs.privateDir, FAKE_CLIENT);
  let running: Running | null = null;
  const core = await startCore({
    paths: dirs.paths,
    env: { OPENROUTER_CORE_KEY: 'test-key' },
    now: () => NOW,
    llm: { complete: complete ?? (() => Promise.reject(new Error('this producer scenario asks no model'))) },
    embedder: { embed: () => Promise.resolve([]) },
    interfaces: [
      {
        name: 'fake',
        start: async (host) => {
          running = await start(
            { ...host, token: readFileSync(`${dirs.privateDir}/clients/fake.token`, 'utf8').trim() },
            { self: SELF, root: { id: 'g1', name: 'Synthetic root' } }
          );
          return running;
        },
      },
    ],
  });
  if (running === null) throw new Error('the core did not start the fake interface');
  const live: Running = running;
  for (const room of ['room-a', 'room-b']) live.adapter.seedChat(channelInfo(room));
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    await core.stop();
  };
  return {
    dirs,
    live,
    stop,
    async send(input: MessageEvent) {
      live.adapter.seedEvent(input);
      return live.emit(input);
    },
    async close() {
      try {
        await stop();
      } finally {
        rmSync(dirs.root, { recursive: true, force: true });
      }
    },
  };
}

function toolText(messages: unknown): string {
  if (!Array.isArray(messages)) throw new Error('the scripted model requires a message array');
  return messages
    .filter(
      (message: unknown) =>
        message !== null && typeof message === 'object' && 'role' in message && message.role === 'tool'
    )
    .map((message: unknown) =>
      message !== null && typeof message === 'object' && 'content' in message && typeof message.content === 'string'
        ? message.content
        : JSON.stringify(message)
    )
    .join('\n');
}

// Split, merge and missed answer in strict JSON.
test('a handle recalled from a real received event reads and replies with its native chat and message IDs', async () => {
  await withCapturedLogs(async () => {
    let step = 0;
    let recalledText = '';
    const rig = await boot((messages, options) => {
      const purpose = options !== null && typeof options === 'object' && 'purpose' in options ? options.purpose : null;
      if (purpose === 'address') return Promise.resolve(toolAnswer('yes'));
      if (purpose === 'lookup' || purpose === 'elsewhere-pick') return Promise.resolve(toolAnswer('none'));
      if (purpose === 'split') return Promise.resolve(toolAnswer('{"parts":[]}'));
      step += 1;
      if (step === 1) return Promise.resolve(toolAnswer('', [call('memory.search', { question: 'gardenrabbit731' })]));
      if (step === 2) {
        recalledText = toolText(messages);
        const handle = recalledText.match(/^#(\d+) .*gardenrabbit731/m)?.[1];
        if (!handle) return Promise.resolve(toolAnswer('<skip/>'));
        return Promise.resolve(
          toolAnswer('', [
            call('conversation.read', { place: '#room-room-b', around: `#${handle}`, last: 1 }),
            call('message.create', { reply: `#${handle}`, text: 'native reply 842' }),
          ])
        );
      }
      return Promise.resolve(toolAnswer('<skip/>'));
    });
    try {
      for (const skill of ['memory.search', 'conversation.read', 'message.create']) {
        const granted = await runCli(rig.dirs, ['-p', `/tools grant ${skill}`]);
        assert.equal(granted.code, 0, granted.stderr);
      }
      assert.equal(await rig.send(event('decoy', 'room-a', 'Other chat evidence')), 'ok');
      assert.equal(await rig.send(event('target', 'room-b', 'gardenrabbit731 target evidence')), 'ok');
      const trigger = lineEvent({
        id: 'question',
        chatId: 'room-a',
        text: 'Please find the stored gardenrabbit731 message.',
        at: NOW,
        mention: true,
      });
      assert.equal(await rig.send(trigger), 'ok');
      await until(() => step >= 2, 5000);
      assert.ok(recalledText.includes('gardenrabbit731 target evidence'), recalledText);
      await until(() => step >= 3, 5000);
      // The adapter contract permits history anchors and direct fetches. The native route is independent of page size.
      const rigAdapter = rig.live.adapter;
      const reads = rigAdapter.calls.filter((entry) => entry.op === 'history' || entry.op === 'fetchMessages');
      assert.ok(
        reads.some(({ op, args }) => {
          if (!isDeepStrictEqual(args[0], { iface: 'fake', chatId: 'room-b' })) {
            return false;
          }
          if (op === 'fetchMessages') {
            return isDeepStrictEqual(args[1], [NATIVE]);
          }
          const query = args[1];
          return query !== null && typeof query === 'object' && 'around' in query && query.around === NATIVE;
        })
      );
      const adapter2 = rig.live.adapter;
      const replies = adapter2.messagesIn('room-b').filter((message) => message.text === 'native reply 842');
      assert.deepEqual(
        replies.map((message) => message.replyTo),
        [{ iface: 'fake', chatId: 'room-b', messageId: NATIVE }]
      );
      const storageKeys = query(
        rig.dirs,
        'SELECT id, native_id FROM sources WHERE text = ?',
        'gardenrabbit731 target evidence'
      );
      assert.equal(storageKeys.length, 1);
      const adapter3 = rig.live.adapter;
      const adapterCalls = JSON.stringify(adapter3.calls);
      for (const source of storageKeys) {
        assert.equal(adapterCalls.includes(String(source.id)), false);
        assert.notEqual(source.native_id, NATIVE);
        assert.equal(adapterCalls.includes(String(source.native_id)), false);
      }
    } finally {
      await rig.close();
    }
  });
});

const MIN = 60_000;

const THINK = '<think>STEP 4. So: answer.</think>';

const SAY = `${THINK}<msg>γεια</msg>`;

// The `#N` numbers of `<recall>` (plan 2026-11-10 tools-and-reads, item 22). An extract repeats a read of an earlier
// turn, and a number is valid only in the request that issued it, so every number the extract shows must name, in this
// turn's calls, the line it named when it was read, and a line memory no longer holds is shown with no number. The
// turn reads the garden `c2` of the service world, Ελένη's line and the persona's after it; a call `around` a number with no line
// before or after it reads back exactly the line the number names.

const GARDEN = { eleni: 'ΕΛΕΝΗ-ΣΤΟΝ-ΚΗΠΟ', persona: 'ΔΙΚΗ-ΤΗΣ-ΚΗΠΟΣ' } as const;

/** The persona's answer that reads the garden by its name. */
const READ_GARDEN = toolAnswer(THINK, [call('conversation.read', { place: 'κήπος', last: 10 })]);

/** The line of `text` that holds `marker`, '' when none does. */
const lineWith = (text: string, marker: string): string => text.split('\n').find((line) => line.includes(marker)) ?? '';

/** The `#N` that opens the line of `text` holding `marker`, null when the line opens with none. */
const numberOf = (text: string, marker: string): string | null => /^#\d+\b/.exec(lineWith(text, marker))?.[0] ?? null;

/** What follows the `<task>` of a request: the persona's answers and the results of their calls in a tool round. */
const afterTask = (request: string): string => request.split('</task>').slice(1).join('</task>');

/** How many times `marker` stands in `text`. */
const countOf = (text: string, marker: string): number => text.split(marker).length - 1;

/** The persona's answer that reads the garden around the number that opens the line of `marker` in `<recall>`, that line alone. */
const aroundRecalled =
  (marker: string) =>
  (request: string): unknown =>
    toolAnswer(THINK, [
      call('conversation.read', {
        place: 'κήπος',
        around: numberOf(blockOf(request, 'recall'), marker) ?? '#0',
        before: '0',
        after: '0',
      }),
    ]);

describe('memory in a reply turn', () => {
  before(() => useIface('fake'));
  after(() => useIface('discord'));

  test('a number of a line in <recall> reads that line in a call of the next turn', async () => {
    // Bug: the extract keeps the numbers the earlier turn's read issued and this turn never registered, so a call with
    // the number the persona sees in <recall> is refused as a message not in the chat, while the read said its numbers work in
    // their calls (turn t-7ff3389c, media.look).
    const world = serviceWorld();
    try {
      const [, second = []] = await replyTurns({
        world,
        steps: [
          { trigger: { id: 'r2', text: 'τι γράφουν στον κήπο;', at: TURN_NOW - 3 * MIN }, answers: [READ_GARDEN, SAY] },
          {
            trigger: { id: 'r3', text: 'τι είπε η Ελένη;', at: TURN_NOW - MIN },
            answers: [aroundRecalled(GARDEN.eleni), SAY],
          },
        ],
      });
      assert.match(
        numberOf(blockOf(second[0] ?? '', 'recall'), GARDEN.eleni) ?? '',
        /^#\d+$/,
        'the line of Ελένη has a number'
      );
      const result = afterTask(second[1] ?? '');
      assert.equal(countOf(result, GARDEN.eleni), 1, result);
      assert.equal(countOf(result, GARDEN.persona), 0, 'the call read the line the number names and no other');
    } finally {
      world.close();
    }
  });

  test('no number in <recall> is the number of a line of <chat> in the same request', async () => {
    // Bug: the earlier turn numbered its read on past its own short window, and this turn's window is long enough to
    // issue the same numbers to its own lines, so one number stands for two lines and a call takes the chat's.
    const world = serviceWorld();
    try {
      const chatter = Array.from({ length: 30 }, (_, i) => ({
        id: `n${i}`,
        text: `ΚΟΥΒΕΝΤΑ-${i}`,
        at: TURN_NOW - 2 * MIN + i * 1000,
      }));
      const [, second = []] = await replyTurns({
        world,
        steps: [
          { trigger: { id: 'r2', text: 'τι γράφουν στον κήπο;', at: TURN_NOW - 3 * MIN }, answers: [READ_GARDEN, SAY] },
          { lines: chatter, trigger: { id: 'r3', text: 'καλά', at: TURN_NOW - MIN }, answers: [SAY] },
        ],
      });
      const request = second[0] ?? '';
      const recall = blockOf(request, 'recall');
      assert.ok(recall.includes(GARDEN.eleni), 'the read stands in <recall>');
      const chatNumbers = new Set(blockOf(request, 'chat').match(/^#\d+\b/gm) ?? []);
      assert.ok(chatNumbers.size >= 30, 'the window numbers its lines');
      const shared = (recall.match(/(?<![\p{L}\p{N}_])#\d+\b/gu) ?? []).filter((n) => chatNumbers.has(n));
      assert.deepEqual(shared, []);
    } finally {
      world.close();
    }
  });

  test('a number of a line in <recall> still reads that line after a read of the same turn', async () => {
    // Bug: a read numbers its lines on from the turn's next free number, and a number <recall> shows but the registry
    // never counted is issued again to a line of the new read, which takes it over.
    const world = serviceWorld();
    try {
      const [, second = []] = await replyTurns({
        world,
        steps: [
          { trigger: { id: 'r2', text: 'τι γράφουν στον κήπο;', at: TURN_NOW - 3 * MIN }, answers: [READ_GARDEN, SAY] },
          {
            trigger: { id: 'r3', text: 'και εδώ;', at: TURN_NOW - MIN },
            answers: [toolAnswer(THINK, [call('conversation.read', { last: 10 })]), aroundRecalled(GARDEN.eleni), SAY],
          },
        ],
      });
      assert.match(
        numberOf(blockOf(second[0] ?? '', 'recall'), GARDEN.eleni) ?? '',
        /^#\d+$/,
        'the line of Ελένη has a number'
      );
      const before = afterTask(second[1] ?? '');
      const after = afterTask(second[2] ?? '');
      assert.equal(countOf(after, GARDEN.eleni) - countOf(before, GARDEN.eleni), 1, after);
      assert.equal(countOf(after, GARDEN.persona), countOf(before, GARDEN.persona), 'the call read no other line');
    } finally {
      world.close();
    }
  });

  test('a number of a read reads its line in a later call of the same turn', async () => {
    // Guard: the numbers a read issues are registered in the turn's registry, and the call after it resolves them; a
    // renumbering of <recall> must leave the turn's own reads as they are.
    const world = serviceWorld();
    try {
      const aroundRead = (request: string): unknown =>
        toolAnswer(THINK, [
          call('conversation.read', {
            place: 'κήπος',
            around: numberOf(afterTask(request), GARDEN.eleni) ?? '#0',
            before: '0',
            after: '0',
          }),
        ]);
      const [first = []] = await replyTurns({
        world,
        steps: [
          {
            trigger: { id: 'r2', text: 'τι γράφουν στον κήπο;', at: TURN_NOW - 3 * MIN },
            answers: [READ_GARDEN, aroundRead, SAY],
          },
        ],
      });
      const before = afterTask(first[1] ?? '');
      const after = afterTask(first[2] ?? '');
      assert.equal(countOf(after, GARDEN.eleni) - countOf(before, GARDEN.eleni), 1, after);
      assert.equal(countOf(after, GARDEN.persona), countOf(before, GARDEN.persona), 'the call read no other line');
    } finally {
      world.close();
    }
  });
});

const TURN_MESSAGE_LINKS_NOW = Date.UTC(2026, 8, 20, 12, 0, 0);

const MESSAGE_ID = '900000000000000001';

function rawMessage({ id, content = 'γεια' }: { id: string; content?: string }) {
  return {
    id,
    placeId: 'c1',
    author: { id: 'u1', bot: false, globalName: 'Alice', username: 'Alice' },
    member: { displayName: 'Alice' },
    cleanContent: content,
    createdTimestamp: TURN_MESSAGE_LINKS_NOW - 1000,
    reference: null,
    attachments: new Map(),
    stickers: new Map(),
  };
}

function normalizedTrigger(raw: ReturnType<typeof rawMessage>) {
  return {
    id: raw.id,
    placeId: raw.placeId,
    authorId: raw.author.id,
    authorName: raw.author.globalName,
    self: false,
    bot: false,
    content: raw.cleanContent,
    ts: raw.createdTimestamp,
    replyToId: null,
    attachments: [],
    stickers: [],
  };
}

function fakeTurnChannel(historyMessages: Array<Record<string, unknown>>, { dm = false }: { dm?: boolean } = {}) {
  return world().channel({
    id: 'c1',
    name: 'chat',
    placeId: 'g1',
    dm,
    historyMessages,
    permissions: { attach: false },
  });
}

function fakeStore() {
  return {
    getPlace: () => ({}),
    getUser: () => null,
    getPrivate: () => null,
    listChannels: () => [],
    listUserProfiles: () => [],
    getLore: () => [],
    liveRules: () => [],
    ...objectMediaCache({}),
    state: { data: {}, markDirty() {} },
  };
}

function fakeHot() {
  return {
    config: {
      bot: { timezone: 'UTC' },
      context: {
        channelMessages: 100,
        caps: { interlocutor: 2500, aboutChat: 2500, people: 4000, neighbors: 3000 },
        vision: { fetchTimeoutMs: 10_000 },
        pull: { sameAudience: true },
      },
      llm: { maxRequestTokens: 50000 },
      typing: { reactionDelayMs: [0, 0], msPerChar: [1, 1], minMs: 0, maxMs: 100, betweenMessagesMs: [0, 0] },
    },
    prompts: {
      main: 'You are a regular member of this chat, not an assistant.',
      persona: 'You are friendly and terse.',
      format: 'Use <msg> and <react> tags.',
      'turn/reply': 'Someone called you: {{author}}.',
      labels,
    },
  };
}

// The other direction: a link in a message of the window to another message of the window reads as that message's
// number in the request, through the reference the Discord package put on the message.
test('runTurn: a message link in the window reads as the #n of the message it names', async () => {
  const first = rawMessage({ id: MESSAGE_ID, content: 'γεια' });
  const second = {
    ...rawMessage({ id: '900000000000000002', content: `see https://discord.com/channels/1/2/${MESSAGE_ID} please` }),
    createdTimestamp: TURN_MESSAGE_LINKS_NOW - 500,
  };
  const channel = fakeTurnChannel([first, second]);
  const requests: Array<string> = [];
  const turns = createTurnRunner({
    hot: fakeHot(),
    store: fakeStore(),
    llm: {
      complete: (messages: unknown) => {
        requests.push(JSON.stringify(messages));
        return Promise.resolve({ text: '<skip/>', usage: {}, estimated: 10 });
      },
    },
    calibrator: { ratio: 1, apply: (n: number) => n, observe: () => {} },
  });
  await turns.runTurn({
    channel,
    mode: 'reply',
    trigger: normalizedTrigger(second),
    triggerKind: 'mention',
    placeId: 'g1',
  });
  assert.equal(requests.length, 1);
  assert.ok(requests[0]?.includes('see #1 please'), 'the link is the number of the first line');
  assert.equal(requests[0]?.includes('discord.com/channels'), false, 'the address is not in the request');
});
