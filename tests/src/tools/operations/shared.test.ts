// messageRefOf (src/tools/operations/shared.ts): the message an operation's argument names, a bare id or a link a person
// pasted. A link is read by the interface (`parseLinks`, the wire action `links.parse`), so the core holds no platform
// address grammar. The fake adapter writes and reads message addresses as `https://discord.com/channels/...` shaped
// templates, so the links below are the ones it would hand out.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { channel, IFACE, message, ROOT as POSTING_NEEDS_ROOT, rig, type Rig } from '../../../fixtures/reads-rig.ts';
import {
  messageRefOf,
  postingChat,
  type PostingContext,
  splitPath,
  writablePlace,
} from '../../../../src/tools/operations/shared.ts';
import { createFakeAdapter } from '../../../../scripts/lib/fake.ts';
import { buildProfileSummary, createAdmin, setPath, unsetPath } from '../../../../src/admin.ts';
import { guardMirrorPort } from '../../../../src/behavior/mirror.ts';
import { createTurnRunner } from '../../../../src/behavior/turn.ts';
import { createReads } from '../../../../src/interface/reads.ts';
import { frameReadsOver } from '../../../../src/memory/db/frame-reads.ts';
import { applyMemoryWrite } from '../../../../src/memory/db/session-write.ts';
import type { Permissions } from '../../../../src/protocol/adapter.ts';
import '../../../../src/tools/operations/index.ts';
import { skillRegistry } from '../../../../src/tools/registry.ts';
import { createSendHold, type SendHold } from '../../../../src/tools/send-hold.ts';
import { withCapturedLogs } from '../../../fixtures/capture-logs.ts';
import { dbOf, seedMirror } from '../../../fixtures/diary-mirror.ts';
import { wrongly } from '../../../fixtures/loose-types.ts';
import {
  addDm,
  addPerson,
  addRoom,
  noteInterface,
  openWorld,
  rootId,
  type World,
} from '../../../fixtures/memory-db/mind-world.ts';
import { openTestMemory } from '../../../fixtures/memory-db/service.ts';
import { type ServiceRun, serviceTurn, serviceWake, serviceWorld, TURN_NOW } from '../../../fixtures/service-turn.ts';
import { call, toolAnswer } from '../../../fixtures/tool-answers.ts';
import { DISCORD, fakeStore, hotWith, personaGrants, rawMessage, sequenceLlm } from '../../../fixtures/turn-harness.ts';
import { freshWorld, type Fake as PlaceNamesInterfacesFake, useIface, world } from '../../../fixtures/turn-world.ts';

const ROOT_LINK = 'https://discord.com/channels/g1/c42/m77';
const DIRECT_LINK = 'https://discord.com/channels/@me/dm9/m5';

test('takes a bare id as it is and asks the interface nothing', async () => {
  const { reads, asked } = rig();
  const ref = await messageRefOf('m77', reads);
  assert.deepEqual(ref, { placeId: null, messageId: 'm77' });
  assert.deepEqual(asked('parseLinks'), []);
});

test('reads a pasted link through the interface into its chat and message', async () => {
  const { reads, asked } = rig();
  const ref = await messageRefOf(ROOT_LINK, reads);
  assert.deepEqual(ref, { placeId: 'c42', messageId: 'm77' });
  assert.deepEqual(asked('parseLinks'), [[ROOT_LINK]]);
});

test('reads the link of a private chat the same way', async () => {
  const { reads } = rig();
  assert.deepEqual(await messageRefOf(DIRECT_LINK, reads), { placeId: 'dm9', messageId: 'm5' });
});

test('strips the angle brackets and the spaces around a link before asking', async () => {
  const { reads, asked } = rig();
  const ref = await messageRefOf(`  <${ROOT_LINK}>  `, reads);
  assert.deepEqual(ref, { placeId: 'c42', messageId: 'm77' });
  assert.deepEqual(asked('parseLinks'), [[ROOT_LINK]]);
});

test('refuses a link of another platform as an unknown message', async () => {
  const { reads } = rig();
  await assert.rejects(messageRefOf('https://example.com/channels/g1/c42/m77', reads), {
    status: 'invalid',
    code: 'unknown-message',
  });
});

test('refuses text that is neither an id nor a link without asking the interface', async () => {
  const { reads, asked } = rig();
  await assert.rejects(messageRefOf('that message from yesterday', reads), {
    status: 'invalid',
    code: 'unknown-message',
  });
  assert.deepEqual(asked('parseLinks'), []);
});

test('refuses a link when the interface cannot read links, and still takes a bare id', async () => {
  const { reads } = rig({ reads: ['messages.fetch'] });
  await assert.rejects(messageRefOf(ROOT_LINK, reads), { status: 'invalid', code: 'unknown-message' });
  assert.deepEqual(await messageRefOf('m77', reads), { placeId: null, messageId: 'm77' });
});

test('refuses a link when there are no reads at all, and still takes a bare id', async () => {
  await assert.rejects(messageRefOf(ROOT_LINK, null), { status: 'invalid', code: 'unknown-message' });
  assert.deepEqual(await messageRefOf('m77', null), { placeId: null, messageId: 'm77' });
});

test('refuses an empty value', async () => {
  const { reads } = rig();
  await assert.rejects(messageRefOf('   ', reads), { status: 'invalid', code: 'unknown-message' });
});

// The Discord interface's capabilities object, as src/index.js injects it.

// ---------------------------------------------------------------------------
// setPath / unsetPath
// ---------------------------------------------------------------------------

test('setPath: overwrites an existing value without touching its siblings', () => {
  const result = setPath({ a: { b: 1, c: 2 } }, 'a.b', 99);
  assert.deepEqual(result, { a: { b: 99, c: 2 } });
});

test('setPath: rejects paths containing __proto__, constructor or prototype', () => {
  assert.throws(() => setPath({}, 'a.__proto__.polluted', 1));
  assert.throws(() => setPath({}, 'constructor.prototype.polluted', 1));
  assert.throws(() => setPath({}, 'a.prototype.b', 1));
});

test('setPath / unsetPath / splitPath: a key holding a dot, given as an array of keys or read against a reference, is one key', () => {
  assert.deepEqual(setPath({ routes: { a: 'v' } }, ['routes', 'x/m-6.1'], 'w'), { routes: { a: 'v', 'x/m-6.1': 'w' } });
  assert.deepEqual(unsetPath({ routes: { 'x/m-6.1': 'w', a: 'v' } }, ['routes', 'x/m-6.1']), { routes: { a: 'v' } });
  const reference = {
    routes: { 'x/m-6.1': 'w', 'x/m-6': { x: 1 } },
    llm: { providerByModel: { 'openai/gpt-6.1': 'K' } },
  };
  assert.deepEqual(splitPath('routes.x/m-6.1', reference), ['routes', 'x/m-6.1'], 'the longest own key wins');
  assert.deepEqual(splitPath('routes.x/m-6.x', reference), ['routes', 'x/m-6', 'x']);
  assert.deepEqual(splitPath('llm.providerByModel.openai/gpt-6.1', reference), [
    'llm',
    'providerByModel',
    'openai/gpt-6.1',
  ]);
  assert.deepEqual(
    splitPath('routes.new.key', reference),
    ['routes', 'new', 'key'],
    'a key the reference lacks: every dot separates'
  );
  assert.deepEqual(splitPath('routes.x/m-6.1'), ['routes', 'x/m-6', '1'], 'no reference: every dot separates');
  assert.throws(() => splitPath(['roles', '__proto__']), /forbidden path segment/);
  assert.throws(() => setPath({}, ['a', 'constructor'], 1), /forbidden path segment/);
});

test('unsetPath: removes a key and prunes an emptied parent object', () => {
  const result = unsetPath({ a: { b: 1 } }, 'a.b');
  assert.deepEqual(result, {});
});

test('unsetPath: removes a key but keeps siblings on the parent', () => {
  const result = unsetPath({ a: { b: 1, c: 2 } }, 'a.b');
  assert.deepEqual(result, { a: { c: 2 } });
});

test('unsetPath: does not mutate its input and is a no-op for a missing path', () => {
  const input = { a: { b: 1 } };
  const result = unsetPath(input, 'a.x.y');
  assert.deepEqual(input, { a: { b: 1 } });
  assert.deepEqual(result, { a: { b: 1 } });
});

// ---------------------------------------------------------------------------
// buildProfileSummary (pure)
// ---------------------------------------------------------------------------

test('buildProfileSummary: never exceeds 2000 chars, even for a huge profile, and points to the full sections', () => {
  const profile = {
    id: '123',
    names: Array.from({ length: 10 }, (_, i) => `VeryLongDisplayNameNumber${i}`),
    messageCount: 999999,
    firstSeen: '2020-01-01T00:00:00.000Z',
    lastSeen: '2026-09-20T00:00:00.000Z',
    affinity: { score: 99, reason: 'x'.repeat(500) },
    character: 'c'.repeat(5000),
    style: 's'.repeat(5000),
    relationship: 'r'.repeat(5000),
    interests: Array.from({ length: 40 }, (_, i) => ({ topic: `Topic number ${i} is quite long`, weight: i })),
    details: Array.from({ length: 40 }, (_, i) => ({ id: i, text: 'd'.repeat(200), weight: i })),
    episodes: Array.from({ length: 20 }, () => ({})),
    aliases: Array.from({ length: 15 }, (_, i) => ({ name: `AliasNumber${i}longenough`, weight: i })),
  };

  const text = buildProfileSummary(profile, {});

  assert.ok(text.length <= 2000, `expected <= 2000 chars, got ${text.length}`);
  assert.ok(text.includes('(full text: section character)'));
  assert.ok(text.includes('(full text: section style)'));
  assert.ok(text.includes('(full text: section relationship)'));
  assert.ok(text.includes('(full text: section aliases)'));
  assert.ok(
    text.includes('interests: 40 stored'),
    'the top-5 interest topics stay short by construction, so this is not truncated'
  );
});

test('buildProfileSummary: resolves <@id> tokens in free-text fields via nameOf', () => {
  const otherId = '999999999999999999';
  const profile = { id: '123', names: ['Bob'], character: `trusts <@${otherId}>` };
  const nameOf = (id: string) => (id === otherId ? 'Zoe' : null);

  const text = buildProfileSummary(profile, {}, nameOf);
  assert.ok(text.includes(`character: trusts Zoe (id:${otherId})`));
});

const NOW = Date.parse('2026-10-17T12:00:00Z');

const ROOT = 'g1';

const MIRROR = 'd1';

/** The memory databases the scenes opened, closed when the file is done. */
const OPEN: Array<{ close(): unknown }> = [];

after(async () => {
  for (const item of OPEN.splice(0)) await item.close();
});

type Fake = ReturnType<typeof createFakeAdapter>;

/**
 * A root with `general` (c1), where Alice wrote last, and `journal` (d1), the diary's mirror (enabled unless
 * `enabled` is false), on a fake interface whose outbound port is the guarded one. Memory is a real database.
 */
async function root({ enabled = true }: { enabled?: boolean } = {}) {
  const memory = await openTestMemory({ now: () => NOW });
  OPEN.push(memory);
  seedMirror(memory.memoryDb, { iface: 'fake', chatId: MIRROR, name: 'journal', enabled, at: NOW });
  freshWorld();
  const line = (placeId: string) => ({
    ...rawMessage({ id: `m-${placeId}`, ts: NOW - 30_000, content: 'γεια' }),
    placeId,
  });
  world().channel({ id: 'c1', name: 'general', placeId: ROOT, historyMessages: [line('c1')] });
  world().channel({ id: MIRROR, name: 'journal', placeId: ROOT, historyMessages: [line(MIRROR)] });
  const adapter: Fake = createFakeAdapter({ iface: 'fake', selfId: 'self-id', now: () => NOW });
  const reads = world().adopt(adapter);
  const port = guardMirrorPort(adapter, { memoryDb: memory.memoryDb });
  /** Every send that reached the interface to `chatId`. */
  const sendsTo = (chatId: string) =>
    adapter.calls.filter((entry) => entry.op === 'send' && (entry.args[0] as { chatId?: string }).chatId === chatId);
  return { memory, adapter, reads, port, sendsTo };
}

type Root = Awaited<ReturnType<typeof root>>;

/**
 * One turn of the persona in `here` over `core`, answered with `answers`: an ordinary reply to Alice, or an inner turn for
 * `wake`, whose posts wait in `hold` when it is a live wake turn. Their tools run through a real admin over the same
 * guarded port. Returns the logs of the turn.
 */
async function turnIn(
  core: Root,
  {
    here,
    answers,
    wake = null,
    hold = null,
    llm = sequenceLlm(answers),
  }: {
    here: string;
    answers: Array<unknown>;
    wake?: object | null;
    hold?: SendHold | null;
    llm?: ReturnType<typeof sequenceLlm>;
  }
) {
  const hot = hotWith({
    tools: { loop: { maxSteps: 3, timeBudgetMs: 20000, maxCallsPerStep: 4 } },
    access: personaGrants(['message.create', 'message.edit', 'draw.create', 'voice.say']),
  });
  Object.assign(hot.prompts, { 'turn/inner': 'Nobody wrote to you; read the wake block.', draw: 'DRAW {{request}}' });
  const store = Object.assign(fakeStore(), {
    findGif: () => ({ id: 'g1', url: 'https://media.example/g1.gif', file: null }),
    recordOwnGif: () => {},
    // The memory database the mirror is seeded in, read as the memory store reads it.
    readMemory: <TResult>(read: (db: unknown) => TResult): TResult => read(dbOf(core.memory.memoryDb)),
  });
  const client = { user: { id: 'self-id', username: 'Bot' }, channels: { cache: new Map() } };
  const images = {
    quota: () => ({ used: 0, cap: 10, userUsed: 0, userCap: 5, spent: false, userSpent: false }),
    generate: () => Promise.resolve({ buffer: Buffer.from('png'), mediaType: 'image/png', seconds: 1, cost: 0 }),
  };
  const speech = {
    quota: () => ({ used: 0, cap: 10, spent: false }),
    say: ({ text }: { text: string }) =>
      Promise.resolve({ ogg: Buffer.from('ogg'), durationSecs: 1, waveform: 'AA', voiced: text, chars: 4, cost: 0 }),
  };
  const admin = createAdmin({
    discord: DISCORD,
    hot,
    store,
    client,
    isServedRoot: (id: unknown) => id === ROOT,
    port: core.port,
    reads: core.reads,
    images,
    speech,
  });
  const turns = createTurnRunner({
    hot,
    store,
    llm,
    calibrator: { ratio: 1, apply: (n: number) => n, observe: () => {} },
    // What the runner takes and this scene has none of: no describer, search, emoji or routes.
    describer: undefined,
    lookup: undefined,
    emoji: undefined,
    now: () => NOW,
    port: core.port,
    reads: core.reads,
    selfId: () => 'self-id',
    getSelfName: () => 'Bot',
    images,
    speech,
    skills: skillRegistry(),
    journal: null,
    runOp: admin.runSkillOp,
    runOwnOp: admin.runOwnSkillOp,
    runInitiativeOp: admin.runInitiativeSkillOp,
  });
  const chat = { iface: 'fake', chatId: here };
  // One call per kind of turn, each written in the call, so runTurn's declared parameter types it.
  const run = () =>
    wake
      ? turns.runTurn({
          chat,
          placeId: ROOT,
          mode: 'inner',
          triggerKind: 'inner',
          inner: { wake, shadow: false, mayAct: () => true, hold },
        })
      : turns.runTurn({
          chat,
          mode: 'reply',
          triggerKind: 'mention',
          trigger: {
            id: `m-${here}`,
            placeId: here,
            authorId: 'u1',
            authorName: 'Alice',
            self: false,
            bot: false,
            content: 'γεια',
            ts: NOW - 30_000,
            replyToId: null,
            attachments: [],
            stickers: [],
          },
        });
  const { logs } = await withCapturedLogs(run);
  return logs as Array<Record<string, unknown>>;
}

/** The `skills: called` lines of a turn, as `skill:status/code`. */
const calledOf = (logs: Array<Record<string, unknown>>) =>
  logs
    .filter((entry) => entry.msg === 'skills: called')
    .map(
      (entry) =>
        `${String(entry.skill)}:${String(entry.status)}${typeof entry.code === 'string' ? `/${entry.code}` : ''}`
    );

/** Whether any log line of the turn names the code `diary-mirror` (a send refused through the guarded port). */
const namesTheCode = (logs: Array<Record<string, unknown>>) => JSON.stringify(logs).includes('"diary-mirror"');

/** The intention's wake whose turn runs in the mirror place: what was promised there is due. */
const intentionWake = {
  kind: 'intention_due',
  items: [{ kind: 'intention_due', reason: 'due', intentionIds: ['i1'], errandId: null }],
  intentions: [{ id: 'i1', purpose: 'πες καλημέρα', dueAt: NOW - 60_000, placeId: MIRROR }],
  placeId: MIRROR,
  now: NOW,
  timezone: 'UTC',
  channels: [],
};

// ---- a send aimed at a mirror place -----------------------------------------------------------------------------

test('a message, a picture and a voice from an ordinary turn elsewhere are refused diary-mirror', async () => {
  const core = await root();
  const logs = await turnIn(core, {
    here: 'c1',
    answers: [
      toolAnswer('', [
        call('message.create', { place: '#journal', text: 'από εδώ' }),
        call('draw.create', { people: [], place: '#journal', text: 'a pier' }),
        call('voice.say', { place: '#journal', text: 'από εδώ' }),
      ]),
      '<skip/>',
    ],
  });
  assert.deepEqual(core.sendsTo(MIRROR), [], 'nothing reaches the interface there');
  // The posting check refuses a post there before any send or any picture is made
  // (src/tools/operations/shared.ts#postingRef), a refusal with the status `denied`.
  assert.deepEqual(calledOf(logs), [
    'message.create:denied/diary-mirror',
    'draw.create:denied/diary-mirror',
    'voice.say:denied/diary-mirror',
  ]);
});

test("the persona's message and GIF in an intention turn that runs in a mirror place are refused diary-mirror", async () => {
  const core = await root();
  const logs = await turnIn(core, {
    here: MIRROR,
    wake: intentionWake,
    answers: ['<msg>καλημέρα</msg><gif>g1</gif>', '<skip/>'],
  });
  assert.deepEqual(core.sendsTo(MIRROR), [], 'nothing reaches the interface there');
  assert.ok(namesTheCode(logs), 'the refusal names diary-mirror');
});

test("the persona's message in a live intention turn in a mirror place is refused diary-mirror at the call and held nowhere", async () => {
  const core = await root();
  const hold = createSendHold();
  const logs = await turnIn(core, {
    here: MIRROR,
    wake: intentionWake,
    hold,
    answers: ['<msg>καλημέρα</msg>', '<skip/>'],
  });
  assert.deepEqual(calledOf(logs), ['message.create:denied/diary-mirror']);
  assert.deepEqual(hold.sends, [], 'no delivery waits for the wake to complete');
});

test('a message aimed at a mirror place from a live intention turn elsewhere is refused diary-mirror and held nowhere', async () => {
  const core = await root();
  const hold = createSendHold();
  const logs = await turnIn(core, {
    here: 'c1',
    wake: { ...intentionWake, placeId: 'c1', intentions: [{ ...intentionWake.intentions[0], placeId: 'c1' }] },
    hold,
    answers: [toolAnswer('', [call('message.create', { place: '#journal', text: 'από εδώ' })]), '<skip/>'],
  });
  assert.deepEqual(calledOf(logs), ['message.create:denied/diary-mirror']);
  assert.deepEqual(hold.sends, [], 'no delivery waits for the wake to complete');
});

test('an edit of a message in a mirror place is refused diary-mirror', async () => {
  const core = await root();
  const logs = await turnIn(core, {
    here: 'c1',
    answers: [
      toolAnswer('', [call('message.edit', { place: '#journal', message: `m-${MIRROR}`, text: 'αλλιώς' })]),
      '<skip/>',
    ],
  });
  assert.deepEqual(calledOf(logs), ['message.edit:denied/diary-mirror']);
  const { adapter } = core;
  assert.deepEqual(
    adapter.calls.filter((entry) => entry.op === 'edit'),
    [],
    'nothing reaches the interface'
  );
});

test("a disabled mirror row lets the persona's message there through", async () => {
  const core = await root({ enabled: false });
  const logs = await turnIn(core, {
    here: 'c1',
    answers: [toolAnswer('', [call('message.create', { place: '#journal', text: 'από εδώ' })]), '<skip/>'],
  });
  assert.deepEqual(calledOf(logs), ['message.create:ok']);
  assert.equal(core.sendsTo(MIRROR).length, 1);
});

const PLACE_CHAT_NOW = Date.parse('2026-11-02T10:00:00.000Z');

const OWNER = 'person:owner';

const PARTNER = '777';

const DM_CHAT = 'dm-chat-41';

const LINE = 'a line of the owner in his direct chat';

/** The owner with a direct chat on the fake interface whose place holds `address`; the turn stands in the command line. */
function ownerWorld(address: string | null): { world: World; place: string } {
  const world = openWorld();
  noteInterface(world, 'fake', [{ id: 'g1', name: 'Agora' }]);
  addPerson(world.db, {
    id: OWNER,
    accounts: [
      { id: 'fake:777', iface: 'fake', native: PARTNER, names: ['Orestis'] },
      { id: 'cli:owner', iface: 'cli', native: 'owner', names: ['Orestis'] },
    ],
  });
  const place = addDm(world.db, { iface: 'fake', native: PARTNER, person: OWNER, account: 'fake:777' });
  addDm(world.db, { iface: 'cli', native: 'owner', person: OWNER, account: 'cli:owner' });
  world.db.prepare('UPDATE places SET native_id = ? WHERE id = ?').run(address, place);
  return { world, place };
}

/** The fake interface holding the owner's direct chat `DM_CHAT` with one line of theirs. */
function dmRig(): Rig {
  const io = rig();
  const dm = channel(DM_CHAT, { kind: 'dm', rootId: null, public: false });
  io.fake.seedChat(dm);
  io.fake.seedEvent(message(dm, 'm1', PLACE_CHAT_NOW - 60_000, LINE, { authorId: PARTNER, authorName: 'Orestis' }));
  return io;
}

/** The address the place holds. */
const addressOf = (world: World, place: string): unknown => {
  const row = world.db.prepare('SELECT native_id FROM places WHERE id = ?').get(place);
  return row?.native_id;
};

/** A post of the persona from the command line chat to the place `place`, with direct chats on: the chat it would go to. */
function postTo(world: World, io: Rig, place: string): Promise<string> {
  const reads = frameReadsOver(
    () => world.db,
    () => ({})
  );
  return postingChat({
    reads: io.reads,
    store: {
      placeRefOf: (id: string) => reads.placeRef?.(id) ?? null,
      notePlaceAddress: (placeId: string, address: string) =>
        Promise.resolve(applyMemoryWrite(world.db, { kind: 'place-address', placeId, address })),
    },
    iface: 'cli',
    chatId: place,
    context: {
      placeId: 'cli:dm:owner',
      env: wrongly<NonNullable<PostingContext['env']>>({ hot: { config: { dm: { enabled: true } } } }),
    },
    need: 'send',
  });
}

test('a post to a direct chat from another place goes to the address its place holds', async () => {
  // Bug: the persona's message into a person's direct chat was addressed to the user id, which the platform answers with 404.
  const { world, place } = ownerWorld(DM_CHAT);
  try {
    const io = dmRig();
    assert.equal(await postTo(world, io, place), DM_CHAT);
    assert.equal(io.asked('dmChatOf').length, 0);
  } finally {
    world.close();
  }
});

test("the persona's first post to a direct chat that holds no address opens it once through dm.chat and stores it", async () => {
  // Bug: writing first to a person whose direct chat holds no address went nowhere.
  const { world, place } = ownerWorld(null);
  try {
    const io = dmRig();
    io.fake.seedDmChat(PARTNER, DM_CHAT);
    assert.equal(await postTo(world, io, place), DM_CHAT);
    assert.equal(await postTo(world, io, place), DM_CHAT);
    assert.equal(io.asked('dmChatOf').length, 1);
    assert.equal(addressOf(world, place), DM_CHAT);
  } finally {
    world.close();
  }
});

const THINK = '<think>STEP 4. So: do it.</think>';

/** The second interface, holding the room `k1` where the persona may read and not write. */
function teleAdapter(): PlaceNamesInterfacesFake {
  const tele = createFakeAdapter({ iface: 'tele', selfId: 'self-id', now: () => TURN_NOW });
  tele.seedChat({
    iface: 'tele',
    id: 'k1',
    kind: 'channel',
    name: 'λιμάνι',
    rootId: 't1',
    topic: null,
    permissions: { read: true, send: false, attach: false, react: false },
    owner: null,
    lastMessageAt: null,
    voice: false,
    public: true,
  });
  return tele;
}

/** One case: the interface, the name the persona writes, and where a post there would land. */
type Case = { iface: string; written: string; sentThere: (run: ServiceRun, tele: PlaceNamesInterfacesFake) => number };

const CASES: ReadonlyArray<Case> = [
  {
    iface: 'fake',
    written: 'Ανακοινωσεις',
    sentThere: (run) => run.port.messagesIn('c3').length,
  },
  {
    iface: 'tele',
    written: 'ΛΙΜΑΝΙ',
    sentThere: (_run, tele) => tele.calls.filter((one) => one.op === 'send').length,
  },
];

/** An intention turn nowhere whose one step calls `skill` with `args`, over the world with the room `c3` stored too. */
async function callNowhere(
  skill: string,
  args: Record<string, unknown>
): Promise<{ run: ServiceRun; tele: PlaceNamesInterfacesFake }> {
  const world = serviceWorld();
  addRoom(world.db, { iface: 'fake', native: 'c3', root: rootId('fake', 'g1'), name: 'ανακοινώσεις' });
  const tele = teleAdapter();
  const due = { id: '' };
  try {
    const run = await serviceTurn({
      world,
      adapters: [tele],
      wake: () =>
        serviceWake('intention_due', {
          items: [{ kind: 'intention_due', reason: 'due', intentionIds: [due.id], errandId: null }],
          intentions: [{ id: due.id, purpose: 'ΚΟΙΤΑ-ΕΚΕΙ', dueAt: TURN_NOW - 60_000 }],
          chainId: due.id,
        }),
      seed: (service) => {
        const made = service.set({ purpose: 'ΚΟΙΤΑ-ΕΚΕΙ', dueAt: TURN_NOW - 60_000, by: 'persona' }) as {
          intention?: { id: string };
        };
        due.id = made.intention?.id ?? '';
      },
      answers: [toolAnswer(THINK, [call(skill, args)]), '<skip/>'],
      chat: null,
    });
    return { run, tele };
  } finally {
    world.close();
  }
}

/** `skill:status:code` of the turn's first call, split. The status is the action's (`executed` once the operation ran,
 * whatever it answered), so the code carries the refusal. */
function firstAction(run: ServiceRun): { skill: string; status: string; code: string } {
  const [skill = '', status = '', code = ''] = (run.actions[0] ?? '').split(':');
  return { skill, status, code };
}

describe('place names across interfaces', () => {
  before(() => useIface('fake'));
  after(() => useIface('discord'));

  for (const one of CASES) {
    test(`a write named by place to a room of ${one.iface} that grants no send is refused with channel-no-permission`, async () => {
      // Bug: the name does not resolve across interfaces, or the write goes out where the interface said the persona may only read.
      const { run, tele } = await callNowhere('message.create', { place: one.written, text: 'καλημέρα' });
      const action = firstAction(run);
      assert.deepEqual([action.skill, action.code], ['message.create', 'channel-no-permission'], run.actions.join(' '));
      assert.equal(one.sentThere(run, tele), 0, 'nothing was posted there');
    });
  }
});

type Need = 'send' | 'reply' | 'attach' | 'read' | 'react';

/** The permissions each need requires, as the keys that must all be true. */
const REQUIRES: Record<Need, Array<keyof Permissions>> = {
  send: ['send'],
  reply: ['send', 'read'],
  attach: ['send', 'attach'],
  read: ['read'],
  react: ['react'],
};

const KEYS: Array<keyof Permissions> = ['read', 'send', 'attach', 'react'];

/** Every combination of the four permissions. */
function combinations(): Array<Permissions> {
  return Array.from({ length: 16 }, (_, bits) => ({
    read: (bits & 1) !== 0,
    send: (bits & 2) !== 0,
    attach: (bits & 4) !== 0,
    react: (bits & 8) !== 0,
  }));
}

const describePermissions = (permissions: Permissions): string =>
  KEYS.filter((key) => permissions[key]).join('+') || 'none';

for (const need of Object.keys(REQUIRES) as Array<Need>) {
  test(`lets a ${need} reach another chat exactly when the permissions it needs are all true`, async () => {
    const outcome: Record<string, boolean> = {};
    for (const permissions of combinations()) {
      const { reads, fake } = rig();
      fake.seedChat(channel('c2', { permissions }));
      const allowed = await postingChat({
        reads,
        store: null,
        iface: IFACE,
        chatId: 'c2',
        context: { placeId: POSTING_NEEDS_ROOT },
        need,
      })
        .then(() => true)
        .catch((error: { status?: string; code?: string }) => {
          assert.deepEqual([error.status, error.code], ['denied', 'channel-no-permission']);
          return false;
        });
      outcome[describePermissions(permissions)] = allowed;
    }
    const expected = Object.fromEntries(
      combinations().map((permissions) => [
        describePermissions(permissions),
        REQUIRES[need].every((key) => permissions[key]),
      ])
    );
    assert.deepEqual(outcome, expected);
  });
}

test('returns the id of the chat it runs in without asking the interface', async () => {
  const { reads, asked } = rig();
  const id = await postingChat({
    reads,
    store: null,
    iface: IFACE,
    chatId: null,
    context: { placeId: 'c1' },
    need: 'attach',
  });
  assert.equal(id, 'c1');
  assert.deepEqual(asked('chatInfo'), []);
});

// A chat of another root where the persona may send is a
// destination like any other.
test('accepts a chat of another root where the persona may send', async () => {
  const { reads, fake } = rig();
  fake.seedChat(channel('c2', { rootId: 'g2' }));
  const id = await postingChat({
    reads,
    store: null,
    iface: IFACE,
    chatId: 'c2',
    context: { placeId: POSTING_NEEDS_ROOT },
    need: 'send',
  });
  assert.equal(id, 'c2');
});

test('refuses a private chat even with every permission', async () => {
  const { reads, fake } = rig();
  fake.seedChat(channel('dm2', { kind: 'dm', rootId: POSTING_NEEDS_ROOT, chatType: 'dm', partnerId: 'u9' }));
  await assert.rejects(
    postingChat({
      reads,
      store: null,
      iface: IFACE,
      chatId: 'dm2',
      context: { placeId: POSTING_NEEDS_ROOT },
      need: 'send',
    }),
    // Slice 7: a post to a direct chat while private chats are off is refused with its own code, dm-disabled.
    { status: 'denied', code: 'dm-disabled' }
  );
});

test('refuses a chat the interface does not know', async () => {
  const { reads } = rig();
  await assert.rejects(
    postingChat({
      reads,
      store: null,
      iface: IFACE,
      chatId: 'gone',
      context: { placeId: POSTING_NEEDS_ROOT },
      need: 'send',
    }),
    // The interface's own code: `channel-no-permission` told the persona of a missing right where the chat was missing.
    { status: 'invalid', code: 'unknown-conversation' }
  );
});

test('refuses another chat when the interface cannot describe chats', async () => {
  const { reads } = rig({ reads: ['messages.fetch'] });
  await assert.rejects(
    postingChat({
      reads,
      store: null,
      iface: IFACE,
      chatId: 'c2',
      context: { placeId: POSTING_NEEDS_ROOT },
      need: 'send',
    }),
    { status: 'denied', code: 'channel-no-permission' }
  );
});

test('refuses a call with neither a target nor a current chat', async () => {
  const { reads } = rig();
  await assert.rejects(
    postingChat({
      reads,
      store: null,
      iface: IFACE,
      chatId: undefined,
      context: {},
      need: 'send',
    }),
    { status: 'invalid' }
  );
});

/** The owner's command line chat as its interface describes it: a direct chat of `cli`. */
const cliChat = (): ReturnType<typeof channel> =>
  channel('cli:dm:owner', { kind: 'dm', rootId: null, iface: 'cli', name: 'owner', partnerId: 'owner' });

/** Reads over a fake command line that knows its one chat. */
function cliReads(): ReturnType<typeof createReads> {
  const fake = createFakeAdapter({ iface: 'cli', selfId: 'self' });
  fake.seedChat(cliChat());
  return createReads(fake, { info() {}, warn() {}, error() {} });
}

/** A context whose live config has direct chats off. */
const dmOff = {
  placeId: POSTING_NEEDS_ROOT,
  env: wrongly<NonNullable<PostingContext['env']>>({ hot: { config: { dm: { enabled: false } } } }),
};

// docs/cli.md under Access: the owner's command line is their own chat, so it stays open while `dm.enabled` is
// false, at the gate and at every other place that asks.
test("lets a post reach the owner's command line while direct chats are off", async () => {
  // Bug: the gate let the owner's line through and the persona answered, yet their own post to that chat came back dm-disabled.
  const id = await postingChat({
    reads: cliReads(),
    store: null,
    iface: IFACE,
    chatId: 'cli:dm:owner',
    context: dmOff,
    need: 'send',
  });
  assert.equal(id, 'cli:dm:owner');
});

test("takes the owner's command line as an intention's place while direct chats are off", async () => {
  // Bug: the persona could not promise the owner a reminder in the owner's own chat while direct chats were off.
  // writablePlace reads a place's chat from its row through the store (plan 2026-11-08 ids-by-links, slice 7b); this
  // case needs none.
  const target = await writablePlace({
    reads: cliReads(),
    store: null,
    iface: IFACE,
    id: 'cli:dm:owner',
    context: dmOff,
  });
  assert.deepEqual(target, { iface: 'cli', chatId: 'cli:dm:owner' });
});

test('still refuses an intention in a direct chat of another interface while direct chats are off', async () => {
  const { reads, fake } = rig();
  fake.seedChat(channel('dm2', { kind: 'dm', rootId: null, partnerId: 'u9' }));
  await assert.rejects(writablePlace({ reads, store: null, iface: IFACE, id: 'dm2', context: dmOff }), {
    status: 'denied',
    code: 'dm-disabled',
  });
});
