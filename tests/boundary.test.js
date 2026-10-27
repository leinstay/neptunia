// The boundary tests of the core extraction (plan 2026-10-25, stage 1): six properties every later stage is measured
// by, driven through public exports over the fake interface adapter, the real event door, the real turn runner and a
// real memory database, with a scripted model. Some hold today and are asserted; the ones the extraction builds are
// `test.todo` with the stage that removes the mark. No Discord client is started and no model is called.
import { describe, test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createMemoryDb } from '../src/memory/db/service.js';
import { lockPathOf, openMemoryDb } from '../src/memory/db/open.js';
import { createAdmin } from '../src/admin.js';
import { createEventDoor } from '../src/interface/door.js';
import { createFakeAdapter, replayFixture } from '../src/interface/fake.js';
import { createDiary } from '../src/behavior/diary.js';
import { heartbeatWake } from '../src/behavior/inner.js';
import { skillRegistry } from '../src/tools/registry.ts';
import { createTurnRunner, fakeStore, hotWith, sequenceLlm } from './fixtures/turn-harness.js';
import { GUILD, MINUTE, START, innerRig, newHistory, replyTo, rowsOf } from './fixtures/boundary.js';
import { openTestMemory, tempDataDir } from './fixtures/memory-db/service.js';
import { createStore } from '../src/memory/store.js';

const SILENT = { info() {}, warn() {}, error() {}, debug() {} };

/** The rigs and services a test opened; closed when the file is done. */
/** @type {Array<{ close(): unknown }>} */
const OPEN = [];
after(async () => {
  for (const item of OPEN) await item.close();
});

/**
 * The real turn runner over `port`, with a scripted `llm` and no Discord client.
 * @param {{ port: ReturnType<typeof createFakeAdapter>, hot: ReturnType<typeof hotWith>, llm: { complete: Function }, store?: ReturnType<typeof fakeStore> }} options
 */
function runnerOver({ port, hot, llm, store = fakeStore() }) {
  const calibrator = { ratio: 1, apply: (/** @type {number} */ value) => value, observe: () => {} };
  // The runner's declared parameters ask for more than a test passes (a describer, a fetch), and the fakes are narrower
  // than the real client and port, so the whole argument is cast.
  return createTurnRunner(
    /** @type {never} */ ({
      hot,
      store,
      llm,
      calibrator,
      now: () => START,
      port,
      skills: skillRegistry(),
      journal: null,
    })
  );
}

/** @param {Parameters<typeof innerRig>[0]} [options] */
async function rig(options) {
  const opened = await innerRig(options);
  OPEN.push(opened.memory);
  return opened;
}

describe('inner turns with no interface', () => {
  test('a heartbeat turn runs to the end on the fake interface and its run is in memory', async () => {
    const core = await rig();
    await core.beat();
    await core.settle();
    assert.equal(core.llm.calls.length, 1, 'one model request, one turn');
    const runs = core.wakeRuns();
    assert.deepEqual(
      runs.map((run) => `${run.kind}:${run.status}:${run.outcome}`),
      ['heartbeat:succeeded:skip']
    );
  });

  // Stage 3, item "The inner life and the diary" (inner.js without client.channels): today a heartbeat needs a channel
  // object from the Discord client to run in, so with nothing connected it is dropped as `no-channel`.
  test.todo('a heartbeat turn runs to the end with no interface connected and its run is in memory', async () => {
    const core = await rig({ interface: false });
    await core.beat();
    await core.settle();
    assert.equal(core.llm.calls.length, 1);
    assert.deepEqual(
      core.wakeRuns().map((run) => `${run.kind}:${run.status}`),
      ['heartbeat:succeeded']
    );
  });

  // Stage 3, same item: the diary is the `selfreflection` wake. The turn runs with no conversation and records the entry
  // in memory before anything is published: a `diary` row with her full text. No mirror is set up and no reads of an
  // interface are given to the scheduler, so nothing is sent anywhere, and no `diary.channelId` is set.
  test('a selfreflection turn leaves its entry in memory with no interface connected', async () => {
    const memory = await openTestMemory({ now: () => START });
    OPEN.push(memory);
    const store = createStore({ dataDir: memory.dataDir, memoryDb: memory.memoryDb });
    const hot = hotWith({
      features: { diary: true },
      config: {
        diary: {
          world: false,
          kinds: { status: 1 },
          maxPerDay: 3,
          maxMessages: 2,
          historyPosts: 40,
          gistChars: 60,
          seedSets: 1,
          planMaxOutputTokens: 250,
          planTimeoutMs: 15000,
        },
      },
    });
    Object.assign(hot.prompts, {
      diary: 'Write your diary.',
      'diary-plan': 'Plan the entry.',
      'diary-seeds': '# place\na pier',
      world: 'The world.',
    });
    const plan = JSON.stringify({ kind: 'status', brief: 'a quiet day', search: '', picture: false });
    const llm = {
      complete: (/** @type {unknown} */ _messages, /** @type {{ purpose?: string }} */ options) =>
        Promise.resolve({
          text: options?.purpose === 'diary-plan' ? plan : '<msg>μια ήσυχη μέρα</msg>',
          usage: {},
          estimated: 5,
        }),
    };
    const port = createFakeAdapter({ iface: 'fake', selfId: 'self-id', now: () => START });
    const diary = createDiary({
      hot,
      store,
      reads: null,
      iface: () => 'fake',
      turns: runnerOver({ port, hot, llm, store }),
      getGuildId: () => GUILD,
      now: () => START,
    });
    await diary.force({ kind: 'status' });
    await store.flushSettled({});
    assert.deepEqual(
      rowsOf(memory.memoryDb, 'SELECT kind, text FROM diary'),
      [{ kind: 'status', text: 'μια ήσυχη μέρα' }],
      'the entry exists in memory with its text'
    );
    assert.deepEqual(
      port.calls.filter((call) => call.op === 'send'),
      [],
      'nothing is sent'
    );
  });
});

describe('one writer', () => {
  /** The memory service over its own data directory, the writer on its thread as in production. */
  async function service() {
    const dataDir = tempDataDir('boundary-writer-');
    const hot = { config: { memoryDb: { session: { mode: 'off' } } }, prompts: {} };
    const memoryDb = createMemoryDb({ hot, dataDir, log: SILENT, now: () => START });
    OPEN.push({ close: () => memoryDb.close() });
    await memoryDb.tick();
    return { memoryDb, dataDir };
  }
  const OWNER = 'guilds/g1/journal/2026-10-26.jsonl';
  const line = (/** @type {string} */ id) => ({
    id,
    kind: 'turn.start',
    occurredAt: '2026-10-26T12:00:00.000Z',
    turnId: id,
  });

  test('two callers writing at once both land, in the order they asked', async () => {
    const { memoryDb } = await service();
    const first = memoryDb.writeUnit({ op: 'lines', owner: OWNER, lines: [line('a1'), line('a2')] });
    const second = memoryDb.writeUnit({ op: 'lines', owner: OWNER, lines: [line('b1')] });
    await Promise.all([first, second]);
    const rows = rowsOf(memoryDb, 'SELECT id FROM day WHERE owner_file = ? ORDER BY position', OWNER);
    assert.deepEqual(
      rows.map((row) => row.id),
      ['a1', 'a2', 'b1']
    );
  });

  test('a writer lock held by another live process refuses the open and leaves the file alone', async () => {
    const dataDir = tempDataDir('boundary-writer-');
    const dbPath = path.join(dataDir, 'memory.db');
    fs.writeFileSync(lockPathOf(dbPath), JSON.stringify({ pid: process.ppid, startedAt: '2026-10-26T11:00:00.000Z' }));
    assert.throws(() => openMemoryDb(dbPath), /is locked by pid/);
    const hot = { config: { memoryDb: { session: { mode: 'off' } } }, prompts: {} };
    const rival = createMemoryDb({ hot, dataDir, log: SILENT, now: () => START });
    OPEN.push({ close: () => rival.close() });
    await rival.tick();
    assert.equal(rival.readHandle(), null, 'the service did not open the database');
    await assert.rejects(rival.writeUnit({ op: 'lines', owner: OWNER, lines: [line('x1')] }), { code: 'DB_CLOSED' });
    assert.match(
      fs.readFileSync(lockPathOf(dbPath), 'utf8'),
      new RegExp(`"pid":${process.ppid}\\b`),
      'the holder keeps its lock'
    );
  });
});

describe('a duplicate wake', () => {
  const WAKE_AT = START + 10 * MINUTE;
  const wakeEvent = () => ({
    kind: 'inner.wake',
    at: WAKE_AT,
    id: heartbeatWake(WAKE_AT).id,
    guildId: GUILD,
    wake: heartbeatWake(WAKE_AT),
  });

  test('delivered twice through the door it opens one inner turn', async () => {
    const core = await rig({ innerLife: { heartbeat: { enabled: false } } });
    const answers = [await core.door.submit(wakeEvent()), await core.door.submit(wakeEvent())];
    await core.inner.tick();
    await core.inner.tick();
    await core.settle();
    assert.deepEqual(
      answers.map((answer) => answer.status),
      ['ok', 'duplicate']
    );
    assert.equal(core.llm.calls.length, 1);
    assert.equal(core.wakeRuns().length, 1);
  });

  test('delivered again after a restart it opens no second inner turn', async () => {
    const core = await rig({ innerLife: { heartbeat: { enabled: false } } });
    await core.door.submit(wakeEvent());
    await core.inner.tick();
    await core.settle();
    const restarted = await core.restart();
    const answer = await restarted.door.submit(wakeEvent());
    await restarted.inner.tick();
    await restarted.settle();
    assert.equal(
      /** @type {{ status: string }} */ (answer.result).status,
      'duplicate',
      'the door is new, the inner life remembers the wake'
    );
    assert.equal(core.llm.calls.length, 1);
    assert.equal(core.wakeRuns().length, 1);
  });
});

describe('a replay after a reconnect', () => {
  const conversation = { id: 'c1', kind: 'channel', guildId: 'g1', name: 'general', topic: null, category: null };
  const received = (/** @type {string} */ id, /** @type {string} */ text, /** @type {number} */ redeliver) => ({
    kind: 'message.received',
    at: START,
    id: `fake:message:${id}`,
    conversation,
    message: {
      id,
      author: { id: 'u1', name: 'Alice', self: false, bot: false },
      content: text,
      at: START,
      replyToId: null,
      replyPingUserId: null,
      forwardedFrom: null,
      attachments: [],
      links: [],
      forwarded: [],
      stickers: [],
      emojis: [],
      reactions: [],
    },
    addressing: { mentioned: true, replyToSelf: false, mentionedUserIds: ['self-id'], mentionedConversationIds: [] },
    origin: {
      chatType: 'channel',
      place: 'c1',
      parent: null,
      thread: null,
      replyToAuthorId: null,
      replyExpected: true,
    },
    redeliver,
  });

  test('events delivered again make one turn each and she answers each only once', async () => {
    const port = createFakeAdapter({ iface: 'fake', selfId: 'self-id', now: () => START });
    const hot = hotWith({ features: { journal: false } });
    const llm = sequenceLlm(['<msg>γεια</msg>']);
    const turns = runnerOver({ port, hot, llm });
    const history = newHistory();
    const door = createEventDoor({
      handlers: {
        'message.received': (event) => {
          const { message, at } = /** @type {{ message: { id: string, content: string }, at: number }} */ (event);
          return replyTo(turns, history, { id: message.id, content: message.content, at });
        },
      },
      log: SILENT,
    });
    const fixture = { iface: 'fake', events: [received('m1', 'καλημέρα', 2), received('m2', 'τι κάνεις', 1)] };
    const answers = await replayFixture(fixture, door, { port });
    assert.deepEqual(
      answers.map((answer) => `${answer.id}:${answer.status}`),
      [
        'fake:message:m1:ok',
        'fake:message:m1:duplicate',
        'fake:message:m1:duplicate',
        'fake:message:m2:ok',
        'fake:message:m2:duplicate',
      ]
    );
    assert.equal(llm.calls.length, 2, 'one turn for each message');
    assert.equal(port.calls.filter((call) => call.op === 'send').length, 2, 'one answer for each message');
  });
});

describe('an adapter that claims the owner', () => {
  // Stage 4, item "The core as a process on its socket with client tokens": today the owner is whoever's id is in
  // `bot.owners`, so a caller that supplies that id is the owner, and the door has no notion of a connection's
  // authority. When the core authenticates clients, a `hello` that names the owner's id gains nothing, and only the
  // connection authenticated with the owner's local token runs an owner-only operation. The handler below believes
  // the requester's id as the core does today; that stage replaces it, with `connect`, by the real wiring.
  test.todo('a hello that names the owner gains no owner authority', async () => {
    const OWNER = 'owner-1';
    const store = Object.assign(fakeStore(), { flush: () => Promise.resolve() });
    const hot = hotWith({ config: { bot: { timezone: 'UTC', owners: [OWNER], access: {} } } });
    const client = { user: { id: 'self-id' }, channels: { cache: new Map() } };
    const admin = createAdmin({ hot, store, client, getGuildId: () => GUILD });
    const door = createEventDoor({
      handlers: {
        'command.requested': (event) => {
          const { name, args, requester } = /** @type {{ name: string, args: object, requester: { id: string } }} */ (
            event
          );
          return admin.runCommand(name, args, { guildId: GUILD, userId: requester.id });
        },
      },
      log: SILENT,
    });
    const connect = (/** @type {string} */ iface, token = null) =>
      door.receive({
        v: 1,
        id: `hello:${iface}`,
        type: 'hello',
        replyTo: null,
        body: { iface, ownerId: OWNER, token },
      });
    const pause = (/** @type {string} */ iface) => ({
      kind: 'command.requested',
      iface,
      at: START,
      id: `command:${iface}`,
      conversation: { id: 'c1', kind: 'channel' },
      name: 'pause',
      args: {},
      replyRef: 'r1',
      requester: { id: OWNER, name: 'Owner', roles: [], owner: true },
    });
    await connect('hostile');
    const refused = await door.submit(pause('hostile'));
    assert.notEqual(
      /** @type {{ status: string }} */ (refused.result).status,
      'ok',
      'the owner-only operation was refused'
    );
    assert.notEqual(/** @type {{ paused?: boolean }} */ (store.state.data).paused, true, 'nothing was paused');
  });
});

describe('a delivery that changes no character', () => {
  // Her text as generated: Greek, emoji, an em dash, spaces before a line break and a line break.
  const BLOCK = 'Καλημέρα κόσμε \u2014 ώρα για καφέ \u2615\u{1F31E}  \nδεύτερη γραμμή με κενά  \nτρίτη';
  const GENERATED = `${BLOCK}\n${BLOCK}\n${BLOCK}`;

  /** One reply turn whose model answer is `<msg>` + `text`, on a fake interface with `capabilities`; the port after it. */
  /** @param {string} text @param {object} [capabilities] */
  async function runDelivery(text, capabilities = {}) {
    const port = createFakeAdapter({ iface: 'fake', selfId: 'self-id', now: () => START, capabilities });
    // format.stripDashes is the one character swap the core makes; this test is about the delivery, so it is off.
    const hot = hotWith({ config: { format: { stripDashes: false } } });
    const turns = runnerOver({ port, hot, llm: sequenceLlm([`<msg>${text}</msg>`]) });
    port.seed('c1', { authorId: 'u1', messageId: 'm1', text: 'hey' });
    await replyTo(turns, [], { id: 'm1', content: 'hey', at: START });
    return port;
  }

  /** The texts she handed to the interface, one per `send` call. */
  /** @param {string} text */
  async function deliver(text) {
    const port = await runDelivery(text);
    return port.calls
      .filter((call) => call.op === 'send')
      .map((call) => /** @type {{ text: string }} */ (call.args[1]).text);
  }

  test('the fake interface stores what it is sent byte for byte', async () => {
    const port = createFakeAdapter({ iface: 'fake', selfId: 'self-id', now: () => START });
    const text = `${GENERATED}   \n `;
    const sent = await port.send({ iface: 'fake', conversationId: 'c1' }, { text });
    const fetched = await port.fetchMessages({ iface: 'fake', conversationId: 'c1' }, [sent.ref?.messageId ?? '']);
    const [stored] = fetched.status === 'ok' ? fetched.messages : [];
    assert.equal(stored?.text, text);
  });

  test('her turn sends the generated text to the interface unchanged', async () => {
    assert.deepEqual(await deliver(GENERATED), [GENERATED]);
  });

  // One `send` call posts several parts when the text outgrows the interface, so counting calls says nothing.
  // The test reads the parts the interface stored: her messages of the conversation, in the order they landed.
  test('a text longer than the interface limit arrives as parts that join to the original', async () => {
    const limit = 60;
    const port = await runDelivery(GENERATED, { maxChars: limit });
    const parts = port
      .messagesIn('c1')
      .filter((message) => /** @type {{ authorId: string }} */ (message).authorId === 'self-id')
      .map((message) => /** @type {{ text: string }} */ (message).text);
    assert.ok(parts.length > 1, 'the text needed splitting');
    assert.ok(parts.every((part) => Array.from(part).length <= limit));
    assert.equal(parts.join(''), GENERATED);
  });
});
