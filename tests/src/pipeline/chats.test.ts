import test, { after, describe, before } from 'node:test';
import { EventEmitter } from 'node:events';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { guardMirrorPort } from '../../../src/behavior/mirror.ts';
import { createMessageHandler } from '../../../src/behavior/pipeline.ts';
import { createTagHistory } from '../../../src/behavior/mention.ts';
import { createTurnRunner } from '../../../src/behavior/turn.ts';
import { createStore } from '../../../src/memory/store.ts';
import { createMemoryUpdater } from '../../../src/memory/update.ts';
import type { MessageReceived } from '../../../src/protocol/events.ts';
import { createFakeAdapter } from '../../../scripts/lib/fake.ts';
import { skillRegistry } from '../../../src/tools/registry.ts';
import { dbOf, seedMirror } from '../../fixtures/diary-mirror.ts';
import { openTestMemory } from '../../fixtures/memory-db/service.ts';
import { hotWith, rawMessage, sequenceLlm } from '../../fixtures/turn-harness.ts';
import { freshWorld, world, useIface, useSelf } from '../../fixtures/turn-world.ts';
import { tempDir } from '../../fixtures/tmp.ts';
import '../../../src/tools/operations/index.ts';
import { memoryAt } from '../../fixtures/store-kit.ts';
import { MessageReferenceType } from 'discord.js';
import {
  baseConfig,
  fakeChannel,
  fakeGuild,
  fakeMessage,
  fakeSpontaneous,
  fakeTurns,
  makeHandler,
  rawHistoryMessage,
  scripted,
} from '../../fixtures/events-rig.ts';
import { withCapturedLogs } from '../../fixtures/capture-logs.ts';
import type { Untyped } from '../../../src/tools/types.ts';
import { ownedBy } from '../../fixtures/owner-accounts.ts';

// A mirror place is not the persona's to write in: only the diary's publisher writes there. An event
// in a mirror place is recorded in memory and opens no turn of the persona's. The core's outbound port
// (src/behavior/mirror.ts#guardMirrorPort) refuses every send to a mirror place with the code `diary-mirror`, whether
// the send comes from an ordinary turn elsewhere or an intention's turn that runs there, and the tool result
// names the code. The publisher, which holds the unguarded port, still publishes there. A disabled mirror row makes the
// place ordinary again. Real turn runner, admin, message handler and memory database over the fake interface, with a
// scripted model. Synthetic text only.

const NOW = Date.parse('2026-10-17T12:00:00Z');
const ROOT = 'g1';
const MIRROR = 'd1';
/** The tracked settings of the message handler's rails (config.json), so the handler runs as it ships. */
// PR 7c: the shipped settings live in config/config.json.
const TRACKED = JSON.parse(fs.readFileSync(new URL('../../../config/config.json', import.meta.url), 'utf8')) as Record<
  string,
  unknown
>;

/** The memory databases the scenes opened, closed when the file is done. */
const OPEN: Array<{ close(): unknown }> = [];

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

// ---- an event in a mirror place ---------------------------------------------------------------------------------

/** A mention of the persona by Alice in `chatId`, as the interface delivers it. */
function mention(chatId: string): MessageReceived {
  return {
    kind: 'message.received',
    iface: 'fake',
    at: NOW,
    id: `fake:message:e-${chatId}`,
    chat: {
      id: chatId,
      kind: 'channel',
      rootId: ROOT,
      name: chatId,
      topic: null,
    },
    message: {
      id: `e-${chatId}`,
      author: { id: 'u1', name: 'Alice', self: false, bot: false },
      content: 'καλημέρα, τι γράφεις;',
      at: NOW,
      replyToId: null,
      replyPingAccountId: null,
      forwardedFrom: null,
      attachments: [],
      links: [],
      forwarded: [],
      stickers: [],
      emojis: [],
      reactions: [],
    },
    addressing: { mentioned: true, replyToSelf: false, mentionedAccountIds: ['self-id'], mentionedChatIds: [] },
  };
}

/** The message handler over `core` with a turn runner that only counts the turns it is asked for. */
function handlerOver(core: Root) {
  const asked: Array<unknown> = [];
  // The handler's live settings are an event emitter that holds the config and the prompts, as src/hot.js makes them.
  const hot = Object.assign(new EventEmitter(), hotWith({ config: { mention: TRACKED.mention, pace: TRACKED.pace } }));
  const store = createStore(memoryAt(tempDir('nep-guard-store-')));
  // A real turn runner whose turns are only counted: the handler gets everything a runner has.
  const runner = createTurnRunner({
    hot,
    store,
    llm: sequenceLlm(['<skip/>']),
    calibrator: { ratio: 1, apply: (n: number) => n, observe: () => {} },
    // What the runner takes and this scene has none of: no describer, search, emoji or routes.
    describer: undefined,
    lookup: undefined,
    emoji: undefined,
    images: undefined,
    now: () => NOW,
    port: core.port,
    reads: core.reads,
    selfId: () => 'self-id',
    getSelfName: () => 'Bot',
    skills: skillRegistry(),
    journal: null,
  });
  const handler = createMessageHandler({
    hot,
    store,
    reads: core.reads,
    selfId: () => 'self-id',
    getSelfName: () => 'Bot',
    isServedRoot: (id: unknown) => id === ROOT,
    turns: {
      ...runner,
      runTurn: (params) => {
        asked.push(params);
        return Promise.resolve({ outcome: 'spoke' as const });
      },
    },
    memory: createMemoryUpdater({ hot, store }),
    tagHistory: createTagHistory(),
    memoryDb: core.memory.memoryDb,
    port: core.port,
    rng: () => 0.5,
    now: () => NOW,
    sleep: () => Promise.resolve(),
  });
  return { handler, asked };
}

// The catalog owns native IDs. Include unmatched rows so an orphan duplicate fails the same text assertion.
const linesOf = (core: Root, chatId: string, messageId: string) =>
  dbOf(core.memory.memoryDb)
    .prepare(
      `SELECT s.kind, s.text FROM sources s
      LEFT JOIN message_families f ON f.iface = s.iface AND f.authority_id = s.authority_id
        AND f.native_kind = s.native_kind AND f.native_key = s.native_id AND f.generation = s.generation
      WHERE s.iface = 'fake' AND s.native_kind = 'message'
        AND ((f.conversation_id = ? AND f.message_id = ?) OR f.native_key IS NULL)`
    )
    .all(chatId, messageId)
    .map((row) => ({ kind: row.kind, text: row.text }));
describe('chats of a mirror', () => {
  after(async () => {
    for (const item of OPEN.splice(0)) await item.close();
  });

  test('a mention in a mirror place opens no turn, and its line is in memory', async () => {
    const core = await root();
    const { handler, asked } = handlerOver(core);
    await handler(mention(MIRROR));
    assert.deepEqual(asked, [], 'no turn of the persona');
    assert.deepEqual(linesOf(core, MIRROR, `e-${MIRROR}`), [{ kind: 'seen', text: 'καλημέρα, τι γράφεις;' }]);
  });

  test('a disabled mirror row lets a mention there open a turn again', async () => {
    const core = await root({ enabled: false });
    const { handler, asked } = handlerOver(core);
    await handler(mention(MIRROR));
    assert.equal(asked.length, 1);
  });
});

const settle = () => new Promise((resolve) => setImmediate(resolve));

function recordingTurns(result = { outcome: 'spoke' }, extra = {}) {
  const calls: Array<Untyped> = [];
  const turns: Record<string, Untyped> = fakeTurns({
    runTurn: async (args: Record<string, Untyped>) => {
      calls.push(args);
      return result;
    },
    ...extra,
  });
  turns.calls = calls;
  return turns;
}
describe('events of the pipeline', () => {
  let stopOwners: Array<() => void> = [];
  before(() => {
    useIface('fake');
    useSelf('self1');
    stopOwners = [ownedBy(['owner1'])];
  });
  after(() => {
    useIface('discord');
    useSelf('self-id');
    for (const stop of stopOwners) stop();
  });

  test('events: a reply to its own message is detected as kind "reply"', async () => {
    let seenArgs: Untyped = null;
    const turns = fakeTurns({
      runTurn: async (args: Record<string, Untyped>) => {
        seenArgs = args;
        return { outcome: 'spoke' };
      },
    });
    const guild = fakeGuild();
    const channel = fakeChannel('c1', guild, {
      messages: { cache: new Map([['m100', { author: { id: 'self1' } }]]), fetch: async () => null },
    });
    const handler = makeHandler({ turns, rng: scripted([0.99]) });

    const message = fakeMessage({
      guild,
      channel,
      placeId: 'c1',
      cleanContent: 'έχεις δίκιο',
      reference: { messageId: 'm100' },
    });
    await handler(message);
    await Promise.resolve();

    assert.ok(seenArgs);
    assert.equal(seenArgs.triggerKind, 'reply');
  });

  test("events: forwarding one of the persona's own messages is not a reply to it", async () => {
    const turns = recordingTurns();
    const spontaneous = fakeSpontaneous();
    const guild = fakeGuild();
    const channel = fakeChannel('c1', guild, {
      messages: { cache: new Map([['m100', { author: { id: 'self1' } }]]), fetch: async () => null },
    });
    const config = baseConfig({ bot: { nameTriggers: [] } });
    const handler = makeHandler({ config, turns, spontaneous, rng: scripted([]) });

    await handler(
      fakeMessage({
        guild,
        channel,
        placeId: 'c1',
        cleanContent: '',
        reference: { messageId: 'm100', placeId: 'c1', type: MessageReferenceType.Forward },
      })
    );
    await settle();

    assert.equal(turns.calls.length, 0, 'a forward is no trigger');
  });

  test('events: a message that replies to nothing fetches no message; a reply target missing from the cache is fetched', async () => {
    const fetched: Array<Untyped> = [];
    const guild = fakeGuild();
    const channel = fakeChannel('c1', guild);
    world().seed('c1', [
      rawHistoryMessage({ id: 'm0', authorId: 'self1', authorName: 'Neptunia', ts: Date.now() - 1000, placeId: 'c1' }),
    ]);
    world().tap('fetchMessages', ([ref, ids]: Array<Untyped>) => {
      if (ref.chatId === 'c1') fetched.push(...ids);
    });
    const turns = recordingTurns();
    const config = baseConfig({ bot: { nameTriggers: [] } });
    const handler = makeHandler({ config, turns, rng: () => 0.99 });

    const { logs } = await withCapturedLogs(async () => {
      await handler(fakeMessage({ id: 'm1', guild, channel, placeId: 'c1', cleanContent: 'καλημέρα' }));
      assert.deepEqual(fetched, [], 'no reply: nothing to look up, not even a page of the channel');

      await handler(
        fakeMessage({ id: 'm2', guild, channel, placeId: 'c1', cleanContent: 'ναι', reference: { messageId: 'm0' } })
      );
      await settle();
      assert.deepEqual(fetched, ['m0'], 'the reply target is fetched by its id');
      assert.deepEqual(
        turns.calls.map((args: Record<string, Untyped>) => [args.trigger.id, args.triggerKind]),
        [['m2', 'reply']]
      );

      // A target that cannot be fetched is no reply to the persona, and nothing escapes the handler.
      world().failRead('fetchMessages', 'c1');
      await handler(
        fakeMessage({ id: 'm3', guild, channel, placeId: 'c1', cleanContent: 'όχι', reference: { messageId: 'm9' } })
      );
      await settle();
    });
    assert.deepEqual(fetched, ['m0', 'm9']);
    assert.equal(turns.calls.length, 1, 'the unresolved reply runs no turn');
    assert.equal(
      logs.some((entry) => entry.msg === 'events: message handler failed'),
      false
    );
  });
});
