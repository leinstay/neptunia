// The idempotency key of an effect of her turn (src/behavior/turn.js) is the effect's record,
// `<turnId>:<effectIndex>:<target>`. It names no attempt, so a later attempt of the same turn (the journal's
// `journalTurn`) carries the key a first attempt would have carried. A retry or a rerun of the turn then never posts
// twice. Here the first attempt fails at the model before it sends anything and the second attempt sends. The key is
// read where her tool call runs (the admin's `runSkillOp` context) and where her send reaches the interface (a fake
// port that records the key of each send). Real turn runner, admin and journal over a test memory database, with
// a scripted model. Synthetic text only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTurnRunner } from '../src/behavior/turn.js';
import { createAdmin } from '../src/admin.js';
import { createFakeAdapter } from '../src/interface/fake.js';
import { skillRegistry } from '../src/tools/registry.ts';
import { withCapturedLogs } from './fixtures/capture-logs.js';
import { call, toolAnswer } from './fixtures/tool-answers.js';
import {
  DISCORD,
  fakeStore,
  hotWith,
  journalOverMemory,
  personaGrants,
  rawMessage,
  sequenceLlm,
} from './fixtures/turn-harness.js';
import { freshWorld, world } from './fixtures/turn-world.ts';
import '../src/tools/impl/index.ts';

const NOW = Date.parse('2026-10-17T12:00:00Z');
const GUILD = 'g1';
const TURN = 'turn-1';

type Fake = ReturnType<typeof createFakeAdapter>;

test('a second attempt of a turn whose first attempt failed before its send carries the key with no attempt in it', async () => {
  freshWorld();
  world().channel({
    id: 'c1',
    name: 'general',
    guildId: GUILD,
    historyMessages: [{ ...rawMessage({ id: 'm1', ts: NOW - 30_000, content: 'γεια' }), channelId: 'c1' }],
  });
  const adapter: Fake = createFakeAdapter({ iface: 'fake', selfId: 'self-id', now: () => NOW });
  const reads = world().adopt(adapter);
  // The key of every send that reaches the interface, as its third argument gives it.
  const sentKeys: Array<string | null> = [];
  const port: Fake = {
    ...adapter,
    send(conversation, content, options?: { idempotencyKey?: string }) {
      sentKeys.push(options?.idempotencyKey ?? null);
      return adapter.send(conversation, content);
    },
  };
  const hot = hotWith({
    features: { coreTools: true, journal: true },
    tools: { loop: { maxSteps: 3, timeBudgetMs: 20000, maxCallsPerStep: 4 } },
    access: personaGrants(['message.create']),
  });
  const store = fakeStore();
  const client = { user: { id: 'self-id', username: 'Bot' }, channels: { cache: new Map() } };
  const admin = createAdmin({ discord: DISCORD, hot, store, client, getGuildId: () => GUILD, port, reads });
  // The key of each `message.create` call, as the turn hands it to the admin (her own operations or a member's).
  const callKeys: Array<string | null> = [];
  type RunOp = typeof admin.runSkillOp;
  const recording =
    (run: RunOp): RunOp =>
    (key, args, context) => {
      // The admin types a call's context loosely; the key is read from it as data.
      const given: unknown = (context as Record<string, unknown> | undefined)?.idempotencyKey;
      if (key === 'message.create') callKeys.push(typeof given === 'string' ? given : null);
      return run(key, args, context);
    };
  const llm = sequenceLlm([
    () => {
      throw new Error('the provider is down');
    },
    toolAnswer('<think>x</think>', [call('message.create', { text: 'γεια σου' })]),
    '<skip/>',
  ]);
  const turns = createTurnRunner({
    hot,
    store,
    llm,
    calibrator: { ratio: 1, apply: (n: number) => n, observe: () => {} },
    describer: undefined,
    lookup: undefined,
    emoji: undefined,
    routeChannels: undefined,
    now: () => NOW,
    port,
    reads,
    selfId: () => 'self-id',
    getSelfName: () => 'Bot',
    skills: skillRegistry(),
    journal: journalOverMemory().journal,
    runOp: recording(admin.runSkillOp),
    runOwnOp: recording(admin.runOwnSkillOp),
    runInitiativeOp: admin.runInitiativeSkillOp,
  });
  const attempt = (attemptId: number) =>
    turns.runTurn({
      conversation: { iface: 'fake', conversationId: 'c1' },
      mode: 'reply',
      triggerKind: 'mention',
      journalTurn: { turnId: TURN, attemptId },
      trigger: {
        id: 'm1',
        channelId: 'c1',
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
  await withCapturedLogs(async () => {
    // The first attempt ends at the model, before any call or send; whether it rejects or answers is not the point.
    await attempt(1).catch(() => null);
    assert.deepEqual(sentKeys, [], 'the first attempt sent nothing');
    await attempt(2);
  });
  assert.deepEqual(callKeys, [`${TURN}:0:c1`], 'the call of the second attempt names no attempt');
  assert.deepEqual(sentKeys, [`${TURN}:0:c1`], 'the send reaches the interface under the same key');
});
