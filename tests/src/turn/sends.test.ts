// Tests for src/turn/sends.ts#renderPost: how the persona's words are rendered for a place. The core serves one
// interface and routes the command line (src/interface/link.ts#createIfaceRouter). On a place whose interface declares
// no mention, channel link, custom emoji or jump link form, a mention reads as the person's name, a channel handle as
// the place's name, an unknown emoji as written and a `#N` as the number the command line shows on that line. On the
// served interface each form stays. Synthetic ids and names, no provider.
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { CHANNEL_HANDLE_PREFIX, handleOf } from '../../../src/behavior/handles.ts';
import { createFakeAdapter } from '../../../scripts/lib/fake.ts';
import { createIfaceRouter } from '../../../src/interface/link.ts';
import type { Capabilities } from '../../../src/protocol/adapter.ts';
import { createSends } from '../../../src/turn/sends.ts';
import type { RenderedPost } from '../../../src/turn/sends.ts';
import type { HandleTarget } from '../../../src/turn/request/types.ts';
import { frameOf } from '../../../src/turn/request/frame.ts';
import type { FrameParty } from '../../../src/turn/request/frame.ts';
import type { Lookup } from '../../../src/turn/calls.ts';
import { buildRequest } from '../../fixtures/built-request.ts';
import type { Built } from '../../fixtures/built-request.ts';
import { ROOM_CHAIN, frameInput } from '../../fixtures/frame-input.ts';
import { line, meanwhileReads } from '../../fixtures/meanwhile-reads.ts';
import type { FakePlace } from '../../fixtures/meanwhile-reads.ts';
import { mindOfEntries, personEntry, placeEntry } from '../../fixtures/mind-entries.ts';
import {
  MIN,
  NOW as RIG_NOW,
  baseInput,
  exactly,
  fakeConfig,
  fakePrompts,
  makeMessage,
} from '../../fixtures/prompt-rig.ts';
import { shippedLabels } from '../../fixtures/shipped-labels.ts';
import { labels } from '../../fixtures/labels.ts';
import { world, useIface } from '../../fixtures/turn-world.ts';
import { createTurnRunner } from '../../fixtures/turn-runner.ts';
import { objectMediaCache } from '../../../src/memory/store-media.ts';
import { addDm, addLine, addPerson } from '../../fixtures/memory-db/mind-world.ts';
import type { World } from '../../fixtures/memory-db/mind-world.ts';
import { OWNER_PERSON } from '../../fixtures/owner-accounts.ts';
import { call, toolAnswer } from '../../fixtures/tool-answers.ts';
import { CLI_CHAT, TURN_NOW, replyRun, serviceWorld } from '../../fixtures/service-turn.ts';
import type { ReplyRun, ReplyStep } from '../../fixtures/service-turn.ts';

const MEMBER = '410000000000000001';
const MEMBER_NAME = 'Robin';
const ROOM = '520000000000000002';
const ROOM_NAME = 'general';
const MEMBER_HANDLE = handleOf(MEMBER);
const ROOM_HANDLE = handleOf(ROOM, undefined, CHANNEL_HANDLE_PREFIX);
const WAVE = { id: '7', name: 'e1', platformName: 'wave', animated: false };
/** The stored line the persona's request numbered `#2`, and the number the command line shows on it. */
const QUOTED = 'cli-message-2';
const OWNER_NUMBER = 41;

type Port = { capabilities: () => Capabilities };

/** Replaces what `port` declares with `change` of it. */
function declare(port: Port, change: (own: Capabilities) => Capabilities): void {
  const own = port.capabilities.bind(port);
  port.capabilities = () => change(own());
}

/** A router serving `served` that routes `cli`, which declares no markup of its own. */
function routerOf(): ReturnType<typeof createIfaceRouter> {
  const served = createFakeAdapter({ iface: 'served' });
  const cli = createFakeAdapter({ iface: 'cli' });
  declare(cli, (caps) => ({
    ...caps,
    messageUrl: null,
    customEmoji: false,
    mentions: false,
    channelLinks: false,
  }));
  return createIfaceRouter(
    served,
    (iface) => (iface === 'cli' ? cli : null),
    () => [cli]
  );
}

/** The sends over the router, an emoji index that knows `e1`, and a store that numbers the lines of the command line. */
function sendsOf(): ReturnType<typeof createSends> {
  return createSends({
    hot: { config: { features: { customEmoji: true, messageLinks: true, channelLinks: true } }, prompts: null },
    store: {
      lineNumberOf: (placeId: string, messageId: string) =>
        placeId === 'cli:dm:owner' && messageId === QUOTED ? OWNER_NUMBER : null,
    },
    emoji: { byName: (name: string) => (name === WAVE.name ? WAVE : null) },
    chatName: (id: string) => (id === ROOM ? ROOM_NAME : null),
    clock: () => 0,
    schedule: () => null,
    activity: null,
    iface: routerOf(),
  });
}

/** `written` rendered for a direct chat of `iface`, with the member and the room under their handles. */
function render(written: string, iface: 'cli' | 'served'): RenderedPost {
  const chat = iface === 'cli' ? 'cli:dm:owner' : 'd1';
  return sendsOf().renderPost(written, {
    channel: { id: chat, rootId: null, iface },
    placeId: chat,
    dmChat: true,
    idByIndex: new Map([[2, QUOTED]]),
    knownNames: [{ name: MEMBER_NAME, id: MEMBER }],
    handles: new Map([[MEMBER_HANDLE, MEMBER]]),
    channelHandles: new Map([[ROOM_HANDLE, ROOM]]),
  });
}

test('a mention in the command line reads as the person name and notifies nobody', () => {
  // Bug: the terminal showed `<@410000000000000001>` where the persona named someone.
  const post = render(`ask @${MEMBER_HANDLE} about it`, 'cli');
  assert.equal(post.text, `ask ${MEMBER_NAME} about it`);
  assert.deepEqual(post.accountIds, []);
});

test('a channel handle in the command line reads as the place name', () => {
  // Bug: the terminal showed `<#520000000000000002>` where the persona named a channel.
  assert.equal(render(`see #${ROOM_HANDLE}`, 'cli').text, `see ${ROOM_NAME}`);
});

// An emoji and a sticker go by a stable name of the engine.
test('a custom emoji name in the command line stays as the persona wrote it', () => {
  // Bug: the terminal showed the served platform's `<:wave:7>` markup.
  assert.equal(render('hi :e1:', 'cli').text, 'hi :e1:');
});

test('a numbered line in the command line reads as the number the command line shows on it', () => {
  // Bug: `#2` counted the lines of the persona's request, so the reader looked up the wrong line, or got a
  // served-platform link.
  assert.equal(render('as in #2', 'cli').text, `as in #${OWNER_NUMBER}`);
});

test('a number the command line cannot place stays as the persona wrote it', () => {
  assert.equal(render('as in #3', 'cli').text, 'as in #3');
});

test('a mention whose person has no known name keeps the handle the persona wrote', () => {
  // Bug: an unnamed member vanished from the persona's sentence, or showed as a raw id.
  const post = sendsOf().renderPost('ask @uzzzz', {
    channel: { id: 'cli:dm:owner', rootId: null, iface: 'cli' },
    placeId: 'cli:dm:owner',
    dmChat: true,
    idByIndex: null,
    handles: new Map([['uzzzz', '999']]),
  });
  assert.equal(post.text, 'ask @uzzzz');
});

// An emoji and a sticker go by a stable name of the engine.
test('the served interface keeps its mention, channel link, emoji and jump link forms', () => {
  const post = render(`@${MEMBER_HANDLE} #${ROOM_HANDLE} :e1: #2`, 'served');
  assert.ok(post.text.includes(`<@${MEMBER}>`), post.text);
  assert.ok(post.text.includes(`<#${ROOM}>`), post.text);
  assert.ok(post.text.includes('<:wave:7>'), post.text);
  assert.ok(post.text.includes(`/${QUOTED}`), post.text);
  assert.deepEqual(post.accountIds, [MEMBER]);
});

/** A person the request held by their key, and the handle cut from it. */
const PERSON = 'person:p1';
const PERSON_HANDLE = handleOf(PERSON);
const NO_ACCOUNT: HandleTarget = { name: null, accounts: [] };

/** `written` posted in a direct chat of the served interface, over a store that links accounts `m1` and `m2`. */
function renderServed(
  written: string,
  over: {
    targets: ReadonlyMap<string, HandleTarget>;
    directory: () => Array<{ id: string; name: string }>;
  }
): RenderedPost {
  const persons: Record<string, string> = { m1: PERSON, m2: 'person:p2' };
  const sends = createSends({
    hot: { config: { features: {} }, prompts: null },
    store: { personOfAccount: (account: string) => persons[account] ?? null },
    emoji: { byName: () => null },
    chatName: () => null,
    clock: () => 0,
    schedule: () => null,
    activity: null,
    iface: routerOf(),
  });
  return sends.renderPost(written, {
    channel: { id: 'd1', rootId: null, iface: 'served' },
    placeId: 'd1',
    dmChat: true,
    idByIndex: null,
    handles: new Map([[PERSON_HANDLE, PERSON]]),
    targets: over.targets,
    directory: over.directory,
  });
}

test('a handle held by its key with no account mentions the directory member whose person it names', () => {
  // Catches: the key the map holds goes out as `<@person:p1>` instead of the member's platform id.
  const post = renderServed(`ask @${PERSON_HANDLE}`, {
    targets: new Map([[PERSON_HANDLE, NO_ACCOUNT]]),
    directory: () => [{ id: 'm1', name: 'Ann' }],
  });
  assert.equal(post.text, 'ask <@m1>');
  assert.deepEqual(post.accountIds, ['m1']);
});

test('a handle held by its key with no account and no member in the directory stays as the persona wrote it', () => {
  // Catches: with no member to resolve to, the handle still goes out as a raw `<@person:p1>` token or notifies someone.
  const post = renderServed(`ask @${PERSON_HANDLE}`, {
    targets: new Map([[PERSON_HANDLE, NO_ACCOUNT]]),
    directory: () => [{ id: 'm2', name: 'Bo' }],
  });
  assert.equal(post.text, `ask @${PERSON_HANDLE}`);
  assert.deepEqual(post.accountIds, []);
});

test('a handle whose target has an account on the served interface mentions that account without the directory', () => {
  // Catches: the fix sends every handle through the directory, so a person with a known account loses the mention or
  // the directory is read on every post.
  let asked = 0;
  const post = renderServed(`ask @${PERSON_HANDLE}`, {
    targets: new Map([[PERSON_HANDLE, { name: 'Ann', accounts: [{ iface: 'served', native: 'm9' }] }]]),
    directory: () => {
      asked += 1;
      return [{ id: 'm1', name: 'Ann' }];
    },
  });
  assert.equal(post.text, 'ask <@m9>');
  assert.deepEqual(post.accountIds, ['m9']);
  assert.equal(asked, 0);
});

test('a posted identity of a line in another place of this interface links through the chat its place row holds', () => {
  // Bug: the link took the interface and the chat parsed out of the place ids, so a line in a place with an opaque id
  // went out as a quote, or as a link to a chat that does not exist.
  const club = { iface: 'served', kind: 'channel', nativeId: 'c-club', partnerNativeId: null };
  const here = { iface: 'served', kind: 'dm', nativeId: null, partnerNativeId: MEMBER };
  const sends = createSends({
    hot: { config: { features: { messageLinks: true } }, prompts: null },
    store: { placeRefOf: (id: string) => (id === 'place:club' ? club : id === 'place:here' ? here : null) },
    emoji: { byName: () => null },
    chatName: () => null,
    clock: () => 0,
    schedule: () => null,
    activity: null,
    iface: routerOf(),
  });
  const line = { placeId: 'place:club', messageId: 'm77', path: ['served', 'club'], at: 0, text: 'x', revision: 1 };
  const post = sends.renderPost('see src:served:m77:1', {
    channel: { id: 'd1', rootId: null, iface: 'served' },
    placeId: 'place:here',
    dmChat: true,
    idByIndex: null,
    refs: {
      placeId: 'place:here',
      lineOf: (key) => (key === 'src:served:m77' ? { ...line, deleted: false, dm: false } : null),
      timezone: 'UTC',
    },
  });
  assert.ok(post.text.includes('/c-club/m77'), post.text);
});

const TIMEZONE = 'Europe/Moscow';

const ELENI = personEntry('111', 'Ελένη', { evidence: 'counterpart', relation: 'ΣΧΕΣΗ-ΕΛΕΝΗΣ' });

// A party carries the id the interface names them by (plan 2026-11-08 ids-by-links, slice 7b): the request no longer
// parses it out of the account id.
const AS_ELENI: FrameParty = { personId: ELENI.personId, accountId: 'fake:111', nativeId: '111', name: 'Ελένη' };

const CLUB = placeEntry('place:club', 'λέσχη', { purpose: 'ΣΚΟΠΟΣ-ΛΕΣΧΗΣ' });

const FRAME = frameOf(
  frameInput({ now: RIG_NOW, timezone: TIMEZONE, author: AS_ELENI, trigger: { messageId: 'm1', authorId: '111' } })
);

const WHEREABOUTS = { kind: 'place', iface: 'fake', private: false, chain: ROOM_CHAIN };

const CONTEXT = {
  meanwhile: { messages: 8, around: 2 },
  recall: { extractChars: 1200, maxItems: 6 },
};

const HISTORY = [makeMessage('m1', RIG_NOW - MIN, { authorId: '111', authorName: 'Ελένη', content: 'γεια σου' })];

const LOOKUP: Lookup = {
  turnId: 'turn:7',
  at: RIG_NOW - 2 * MIN,
  tool: 'memory.search',
  args: { query: 'ΕΡΩΤΗΜΑ-ΚΗΠΟΣ' },
  place: { id: 'place:room', path: ['fake', 'Αγορά', 'γενικά'] },
  status: 'ok',
  extract: 'ΑΠΟΣΠΑΣΜΑ-ΚΗΠΟΥ',
  sourceIds: ['src:fake:m50:1:seen'],
  anchorMessageIds: ['m1'],
};

/** The club with a line of the persona's among three of Eleni's. */
const CLUB_LINES: FakePlace = {
  id: 'place:club',
  path: ['fake', 'Αγορά', 'λέσχη'],
  dm: false,
  lines: [
    line('place:club', 'c1', RIG_NOW - 40 * MIN, '111', 'πρώτη'),
    line('place:club', 'c2', RIG_NOW - 39 * MIN, '111', 'δεύτερη'),
    line('place:club', 'c3', RIG_NOW - 38 * MIN, null, 'δική της'),
    line('place:club', 'c4', RIG_NOW - 37 * MIN, '111', 'τρίτη'),
  ],
};

const nameOf = (id: string): string | null => (id === '111' ? 'Ελένη' : null);

function request(over: Record<string, unknown> = {}): Built {
  return buildRequest(
    baseInput({
      config: fakeConfig({ context: CONTEXT }),
      prompts: fakePrompts({ labels: shippedLabels }),
      frame: FRAME,
      whereabouts: WHEREABOUTS,
      history: HISTORY,
      trigger: HISTORY[0],
      triggerKind: 'mention',
      nameOf,
      mind: mindOfEntries({ people: [ELENI], places: [CLUB] }),
      lookups: [LOOKUP],
      myDay: ['09:00 έγραψα στη λέσχη'],
      meanwhileReads: meanwhileReads([CLUB_LINES]),
      ...over,
    })
  );
}

/**
 * Ann is on the persona's mind behind a crowd that fills `<people>` under a tight request, Ann is no member of the chat and wrote
 * in no window, and `<attitudes>` still shows Ann's handle.
 */
const ANN = personEntry('555', 'Ann', { relation: 'relation '.repeat(60) });

const ANN_HANDLE = handleOf(ANN.personId);

const AHEAD = Array.from({ length: 60 }, (_, i) =>
  personEntry(String(6000 + i), `Someone-${i}`, { relation: 'relation '.repeat(60) })
);

function annOnlyInAttitudes(): Built {
  return request({
    mind: mindOfEntries({ people: [ELENI, ...AHEAD, ANN] }),
    attitudes: {
      list: [{ person: ANN.personId, score: 90, at: '2026-11-01T00:00:00Z' }],
      names: { [ANN.personId]: 'Ann' },
    },
    config: fakeConfig({ context: CONTEXT, llm: { maxRequestTokens: exactly(3000) } }),
  });
}

test('a post rendered with the handles and targets of a request mentions only platform ids', () => {
  // Catches: the reader and renderPost disagree on a handle held by its key, and a raw `<@person:…>` goes out.
  const built = annOnlyInAttitudes();
  const sends = createSends({
    hot: { config: { features: {} }, prompts: null },
    store: { personOfAccount: (account: string) => (account === '555' ? ANN.personId : null) },
    emoji: { byName: () => null },
    chatName: () => null,
    clock: () => 0,
    schedule: () => null,
    activity: null,
    iface: createFakeAdapter({ iface: 'fake' }),
  });
  const post = sends.renderPost(`hi @${ANN_HANDLE}`, {
    channel: { id: 'd1', rootId: null, iface: 'fake' },
    placeId: 'd1',
    dmChat: true,
    idByIndex: null,
    handles: built.handles,
    targets: built.refs?.targets ?? null,
    directory: () => [{ id: '555', name: 'Ann' }],
  });
  assert.equal(post.text, 'hi <@555>');
  assert.deepEqual(post.accountIds, ['555']);
});

const NOW = Date.UTC(2026, 8, 20, 12, 0, 0);

const LINKED_ID = '323456789012345678';

function rawMessage({ id, content = 'γεια' }: { id: string; content?: string }) {
  return {
    id,
    placeId: 'c1',
    author: { id: 'u1', bot: false, globalName: 'Alice', username: 'Alice' },
    member: { displayName: 'Alice' },
    cleanContent: content,
    createdTimestamp: NOW - 1000,
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

/** A guild channel whose guild knows one text channel `γενικά`, which the persona cannot read (no neighbour reads); the non-text `φωνή` is no chat. */
function fakeTurnChannel(historyMessages: Array<Record<string, unknown>>) {
  world().channel({ id: LINKED_ID, name: 'γενικά', permissions: { read: false } });
  return world().channel({ id: 'c1', name: 'chat', placeId: 'g1', historyMessages, permissions: { attach: false } });
}

function fakeLlm(responseText: string) {
  return { complete: async () => ({ text: responseText, usage: {}, estimated: 10 }) };
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

async function runLinkTurn(answer = '<msg>δες στο #γενικά και στο #φωνή</msg>') {
  const raw = rawMessage({ id: 'm1' });
  const channel = fakeTurnChannel([raw]);
  const turns = createTurnRunner({
    hot: fakeHot(),
    store: fakeStore(),
    llm: fakeLlm(answer),
    calibrator: { ratio: 1, apply: (n: number) => n, observe: () => {} },
  });
  const result = await turns.runTurn({
    channel,
    mode: 'reply',
    trigger: normalizedTrigger(raw),
    triggerKind: 'mention',
  });
  return { result, channel };
}

test('runTurn: a #name of a guild text channel is sent as its <#id> link', async () => {
  const { result, channel } = await runLinkTurn();
  assert.equal(result.outcome, 'spoke');
  assert.equal(channel.sent.length, 1);
  const sent = channel.sent;
  assert.equal(sent[0].content, `δες στο <#${LINKED_ID}> και στο #φωνή`);
});

test('runTurn: a URL in a <msg> is posted exactly as written; a #name and an @handle outside it still turn into links', async () => {
  const handle = handleOf('u1');
  const url = `https://www.youtube.com/@${handle}/#γενικά?si=Ab_9&t=5`;
  const { result, channel } = await runLinkTurn(`<msg>@${handle} δες ${url} στο #γενικά</msg>`);
  assert.equal(result.outcome, 'spoke');
  const sent = channel.sent;
  assert.equal(sent[0].content, `<@u1> δες ${url} στο <#${LINKED_ID}>`);
});

test('runTurn: a #handle of a guild text channel the request did not show is still sent as its <#id> link', async () => {
  // Bug: a handle the persona carries over from an earlier request (an intention, their last think) went out as plain text,
  // because only the channels of this request were in the handle map.
  const handle = handleOf(LINKED_ID, 4, 'c');
  const { result, channel } = await runLinkTurn(`<msg>δες στο #${handle}</msg>`);
  assert.equal(result.outcome, 'spoke');
  const [sent] = channel.sent;
  assert.equal(sent.content, `δες στο <#${LINKED_ID}>`);
});

test('runTurn: an @handle of a known member who wrote nothing in the chat is still sent as a mention', async () => {
  // Bug: a member's handle the persona carries over from an earlier request went out as plain `@handle`, because only the
  // authors of this request's lines were in the handle map.
  const turns = createTurnRunner({
    hot: fakeHot(),
    store: { ...fakeStore(), listUserProfiles: () => [{ id: 'u7', names: ['Zoe'], aliases: [] }] },
    llm: fakeLlm(`<msg>@${handleOf('u7')} έτοιμο</msg>`),
    calibrator: { ratio: 1, apply: (n: number) => n, observe: () => {} },
  });
  const raw = rawMessage({ id: 'm1' });
  const channel = fakeTurnChannel([raw]);
  const result = await turns.runTurn({
    channel,
    mode: 'reply',
    trigger: normalizedTrigger(raw),
    triggerKind: 'mention',
  });
  assert.equal(result.outcome, 'spoke');
  const [sent] = channel.sent;
  // Changed: content carries no mentions, so the resolved `<@u7>` in the text is what is checked.
  assert.equal(sent.content, '<@u7> έτοιμο');
});

const MESSAGE_ID = '900000000000000001';

function messageLinkChannel(historyMessages: Array<Record<string, unknown>>, { dm = false }: { dm?: boolean } = {}) {
  return world().channel({
    id: 'c1',
    name: 'chat',
    placeId: 'g1',
    dm,
    historyMessages,
    permissions: { attach: false },
  });
}

async function runMessageLinkTurn(responseText: string, { dm = false }: { dm?: boolean } = {}) {
  const raw = rawMessage({ id: MESSAGE_ID });
  const channel = messageLinkChannel([raw], { dm });
  const turns = createTurnRunner({
    hot: fakeHot(),
    store: fakeStore(),
    llm: { complete: async () => ({ text: responseText, usage: {}, estimated: 10 }) },
    calibrator: { ratio: 1, apply: (n: number) => n, observe: () => {} },
  });
  const result = await turns.runTurn({
    channel,
    mode: 'reply',
    trigger: normalizedTrigger(raw),
    triggerKind: 'mention',
    placeId: 'g1',
  });
  return { result, channel };
}

test('runTurn: a transcript number in the text becomes its message link', async () => {
  const { result, channel } = await runMessageLinkTurn('<msg>see #1 and #1, not #77 or x#1</msg>');
  assert.equal(result.outcome, 'spoke');
  const url = `https://discord.com/channels/g1/c1/${MESSAGE_ID}`;
  const sent = channel.sent;
  assert.equal(sent[0].content, `see ${url} and ${url}, not #77 or x#1`);
});

test('runTurn: a private chat links with @me instead of the guild id', async () => {
  const { channel } = await runMessageLinkTurn('<msg>see #1</msg>', { dm: true });
  const sent = channel.sent;
  assert.equal(sent[0].content, `see https://discord.com/channels/@me/c1/${MESSAGE_ID}`);
});

// The cases above run on the Discord-shaped world; these run over the memory world on the fake interface.
describe('an @handle in a post to another interface', () => {
  before(() => {
    useIface('fake');
  });

  const MIN = 60_000;

  const THINK = '<think>STEP 4. So: answer.</think>';

  const SAY = `${THINK}<msg>εντάξει</msg>`;

  const iso = (at: number): string => new Date(at).toISOString();

  const NIKOS = 'person:fake:4242';

  const GIANNIS = 'person:tele:88';

  /** The texts of the world's lines, each unique so a test finds its line in one block. */
  const LINE = {
    ownerGarden: 'ΠΕΤΡΟΣ-ΣΤΟΝ-ΚΗΠΟ',
    ownerRoom: 'ΠΕΤΡΟΣ-ΣΤΟ-ΓΕΝΙΚΑ',
    ownerCli: 'ΠΟΙΟΣ-ΕΓΡΑΨΕ-ΣΤΟΝ-ΚΗΠΟ',
    giannisHarbour: 'ΓΙΑΝΝΗΣ-ΣΤΟ-ΛΙΜΑΝΙ',
    eleniGarden: 'ΕΛΕΝΗ-ΣΤΟΝ-ΚΗΠΟ',
    nikosOne: 'ΝΙΚΟΣ-ΑΠΟ-ΤΟ-ΕΝΑ',
    nikosTwo: 'ΝΙΚΟΣ-ΑΠΟ-ΤΟ-ΔΥΟ',
  } as const;

  /** The name the owner's command line account carries, and the one their account on the fake interface carries. */
  const OWNER_CLI_NAME = 'ΠΕΤΡΟΣ-ΚΟΝΣΟΛΑ';

  const OWNER_FAKE_NAME = 'Πέτρος';

  /**
   * The service world, with the owner holding an account on the command line and one on the fake interface, their line in
   * the garden `c2` right after the persona's, and Γιάννης, who has an account on `tele` alone and wrote in the harbour `k1` right
   * after the persona's line there. Ελένη's line before the persona's in the garden mentions nobody; the owner's mentions Ελένη.
   */
  function handleWorld(): World {
    const world = serviceWorld();
    addPerson(world.db, {
      id: OWNER_PERSON,
      accounts: [
        { id: 'cli:owner', iface: 'cli', native: 'owner', names: [OWNER_CLI_NAME] },
        { id: 'fake:u1', iface: 'fake', native: 'u1', names: [OWNER_FAKE_NAME] },
      ],
    });
    addDm(world.db, { iface: 'cli', native: 'owner', person: OWNER_PERSON, account: 'cli:owner' });
    addLine(world.db, {
      id: 'o1',
      iface: 'fake',
      place: 'fake:channel:c2',
      author: 'fake:u1',
      text: `${LINE.ownerGarden} <@111>`,
      at: iso(TURN_NOW - 49 * MIN),
    });
    addPerson(world.db, {
      id: GIANNIS,
      accounts: [{ id: 'tele:88', iface: 'tele', native: '88', names: ['Γιάννης'] }],
    });
    addLine(world.db, {
      id: 'y1',
      iface: 'tele',
      place: 'tele:channel:k1',
      author: 'tele:88',
      text: LINE.giannisHarbour,
      at: iso(TURN_NOW - 39 * MIN),
    });
    addPerson(world.db, {
      id: NIKOS,
      accounts: [
        { id: 'fake:4242', iface: 'fake', native: '4242', names: ['Νίκος'] },
        { id: 'fake:4243', iface: 'fake', native: '4243', names: ['Νικόλαος'] },
      ],
    });
    return world;
  }

  /** The owner's line on the command line. */
  const ownerSays = (id: string, text: string, at: number) => ({
    id,
    text,
    at,
    authorId: 'owner',
    authorName: 'owner',
  });

  /** Reply turns on the owner's command line over a fresh handle world. */
  async function onCli(steps: ReadonlyArray<ReplyStep>): Promise<ReplyRun> {
    const world = handleWorld();
    try {
      return await replyRun({ world, chat: CLI_CHAT, steps });
    } finally {
      world.close();
    }
  }

  /** The bodies of every `<people>` of a text: the request's own and the one a read result carries. */
  const peopleBodies = (text: string): Array<string> =>
    [...text.matchAll(/<people>\n?([\s\S]*?)\n?<\/people>/g)].map((match) => match[1] ?? '');

  /** The entries of every `<people>` of a text, one text each. */
  const entriesOf = (text: string): Array<string> =>
    peopleBodies(text).flatMap((body) => body.split(/\n\s*\n/).filter((entry) => entry.trim() !== ''));

  /** The `@u…` handle an entry opens with, null when its first line holds none. */
  const entryHandle = (entry: string): string | null => /@u[0-9a-z]+/.exec(entry.split('\n')[0] ?? '')?.[0] ?? null;

  /** The entry of `<people>` that holds `name`, '' when none does. */
  const entryWith = (text: string, name: string): string => entriesOf(text).find((entry) => entry.includes(name)) ?? '';

  /** The `@u…` handle of the entry holding `name` in a request, as the scripted model reads it to write back. */
  const handleIn = (request: string, name: string): string => entryHandle(entryWith(request, name)) ?? '@unone';

  test("the persona's @handle in a post to another interface mentions the person's account there", async () => {
    // Bug: the handle the persona saw on the command line stands for the owner's command line account, which the room's
    // interface does not know, so the post names nobody.
    const run = await onCli([
      {
        trigger: ownerSays('m1', 'πες τους ότι έρχεσαι', TURN_NOW - MIN),
        answers: [
          (request: string) =>
            toolAnswer(THINK, [
              call('message.create', { place: 'γενικά', text: `${handleIn(request, OWNER_FAKE_NAME)} ΕΡΧΟΜΑΙ` }),
            ]),
          SAY,
        ],
      },
    ]);
    const post = run.sends.find((one) => one.iface === 'fake' && one.text.includes('ΕΡΧΟΜΑΙ'));
    assert.ok(post, JSON.stringify(run.sends));
    // Changed: content carries no mentions, so the mention in the text is what is checked.
    assert.ok(post.text.includes('<@u1>'), post.text);
  });

  test("the persona's @handle of a person with no account on the interface they write to carries the name and no mention", async () => {
    // Bug: the handle resolves to the person's account on another interface, and the room gets a mention of an account
    // it does not have.
    const run = await onCli([
      {
        trigger: ownerSays('m1', 'πες τους για τον Γιάννη', TURN_NOW - MIN),
        answers: [
          (request: string) =>
            toolAnswer(THINK, [
              call('message.create', { place: 'γενικά', text: `${handleIn(request, 'Γιάννης')} ΗΡΘΕ` }),
            ]),
          SAY,
        ],
      },
    ]);
    const post = run.sends.find((one) => one.iface === 'fake' && one.text.includes('ΗΡΘΕ'));
    assert.ok(post, JSON.stringify(run.sends));
    // Changed: content carries no mentions, so the text alone shows that none was made.
    assert.ok(post.text.includes('Γιάννης'), post.text);
    assert.doesNotMatch(post.text, /<@|@u[0-9a-z]+/);
  });
});
