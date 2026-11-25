// What a heartbeat accepts (src/tools/wake-tools.ts): every call that only looks, as the tools' own definitions
// declare it, the errand calls and any number of intention changes; every other call is refused with heartbeat-only.
import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { wakeGoesOn, wakeRefusalCode } from '../../../src/tools/wake-tools.ts';
import { JOBS, SKILL_DEFINITIONS } from '../../../src/tools/definitions.ts';
import { CODE } from '../../../src/tools/codes.ts';
import { createDiscordInterface } from '../../../interfaces/discord/index.ts';
import { createFakeAdapter } from '../../../scripts/lib/fake.ts';
import { createAdmin } from '../../../src/admin.ts';
import { createTurnRunner as createRealTurnRunner } from '../../../src/behavior/turn.ts';
import { createIntentionService } from '../../../src/intentions/service.ts';
import { createIntentionStores } from '../../../src/intentions/store.ts';
import { objectMediaCache } from '../../../src/memory/store-media.ts';
import '../../../src/tools/operations/index.ts';
import { skillRegistry } from '../../../src/tools/registry.ts';
import type { Untyped } from '../../../src/tools/types.ts';
import { withCapturedLogs } from '../../fixtures/capture-logs.ts';
import { chainsOf } from '../../fixtures/chains.ts';
import { labels } from '../../fixtures/labels.ts';
import { wrongly } from '../../fixtures/loose-types.ts';
import { skillTurn } from '../../fixtures/skill-tool-turns.ts';
import { skillsRig, type SkillsRig, skillText } from '../../fixtures/skills-rig.ts';
import { tempDir } from '../../fixtures/tmp.ts';
import { call, completionOf, toolAnswer } from '../../fixtures/tool-answers.ts';
import { onWorld, useIface, world } from '../../fixtures/turn-world.ts';

// memory.profile.read declares `read`, and a heartbeat takes every read, since in a heartbeat the persona looks at
// whatever they want before they decide. The call refused here is a post.
// Bug caught: the heartbeat's set misses memory.read, or takes a post.
test('accepts memory.read in a heartbeat and refuses message.create', () => {
  assert.deepEqual(
    [wakeRefusalCode('heartbeat', 'memory.read'), wakeRefusalCode('heartbeat', 'message.create')],
    [null, CODE.HEARTBEAT_ONLY]
  );
});

// A heartbeat takes several intention changes, so a change is read back and the turn goes on after it.
// Bug caught: the heartbeat refuses the errand it is to wait for, or an intention change ends the turn before the
// persona makes a second one.
test('accepts errand.scout and errand.read in a heartbeat, and the turn goes on after an intention change', () => {
  assert.deepEqual(
    [
      wakeRefusalCode('heartbeat', 'errand.scout'),
      wakeRefusalCode('heartbeat', 'errand.read'),
      wakeGoesOn('heartbeat', 'errand.read'),
      wakeGoesOn('heartbeat', 'intention.set'),
    ],
    [null, null, false, true]
  );
});

// Bug caught: a read tool, one added later among them, is refused in a heartbeat, or a tool that changes something
// outside the persona (a post, a reaction, a drawing, a setting) slips into the heartbeat's set.
test('a heartbeat takes every tool that declares read, the errand calls and the intention changes, and refuses the rest', () => {
  const decided = new Set([...JOBS, 'intention.set', 'intention.update', 'intention.cancel']);
  const wrong = SKILL_DEFINITIONS.filter(
    (definition) =>
      (wakeRefusalCode('heartbeat', definition.name) === null) !==
      (definition.effects === 'read' || decided.has(definition.name))
  ).map((definition) => definition.name);
  assert.deepEqual(wrong, []);
});

const createTurnRunner = onWorld(wrongly(createRealTurnRunner));

const DISCORD = createDiscordInterface().capabilities;

const NOW = Date.parse('2026-10-19T12:00:00Z');

const INNER_TASK = 'Nobody wrote to you; read the wake block.';

function rawMessage({
  id,
  authorId = 'u1',
  authorName = 'Alice',
  ts = NOW - 60_000,
  content = 'καλημέρα',
}: {
  id: string;
  authorId?: string;
  authorName?: string;
  ts?: number;
  content?: string;
}) {
  return {
    id,
    placeId: 'c1',
    author: { id: authorId, bot: false, globalName: authorName, username: authorName },
    member: { displayName: authorName },
    cleanContent: content,
    createdTimestamp: ts,
    reference: null,
    attachments: new Map(),
    stickers: new Map(),
  };
}

function fakeStore() {
  return {
    getPlace: () => ({}),
    getUser: () => null,
    getPrivate: () => null,
    listChannels: () => [],
    listUserProfiles: () => [],
    countUsers: () => 0,
    getLore: () => [],
    liveRules: () => [],
    ...objectMediaCache({}),
    state: { data: {}, markDirty() {} },
  };
}

// PR 7d: the switches are code, the heartbeat holds to intention changes and its caps (3 open, 1 recurring) are
// constants, so the config holds only the keys that are still settings.
function hotWith({ access = {}, wakes = {} } = {}) {
  return {
    config: {
      bot: { timezone: 'UTC', owners: ['u1'], access },
      context: {
        channelMessages: 100,
        caps: { interlocutor: 2500, aboutChat: 2500, people: 4000, neighbors: 3000 },
        vision: { fetchTimeoutMs: 10_000 },
        pull: { sameAudience: true },
      },
      llm: { maxRequestTokens: 50000 },
      typing: { reactionDelayMs: [0, 0], msPerChar: [1, 1], minMs: 0, maxMs: 100, betweenMessagesMs: [0, 0] },
      models: { routes: chainsOf({ analyzer: 'x/text' }) },
      tools: {
        safeMode: false,
        resultMaxChars: 2000,
        callTimeoutMs: 120000,
        loop: { maxSteps: 3, timeBudgetMs: 20000, maxCallsPerStep: 4 },
      },
      wakes: { mode: 'shadow', ...wakes },
    },
    prompts: {
      main: 'You are a regular member of this chat, not an assistant.',
      persona: 'You are friendly and terse.',
      format: 'Use <msg> and <react> tags.',
      'turn/reply': 'Someone called you: {{author}}.',
      interject: 'Jump into the chat.',
      initiate: 'Start a topic.',
      'turn/inner': INNER_TASK,
      labels,
    },
  };
}

function personaGrants(names: Array<string>) {
  return Object.fromEntries(names.map((name) => [name, { everyone: false, roles: [], users: ['self-id'] }]));
}

function sequenceLlm(answers: Array<unknown>, { onCall = null }: { onCall?: ((calls: number) => void) | null } = {}) {
  const calls: Array<Untyped> = [];
  return {
    calls,
    complete: async (messages: Record<string, Untyped>) => {
      calls.push(messages);
      const answer: unknown = answers[Math.min(calls.length - 1, answers.length - 1)];
      if (onCall) onCall(calls.length);
      return completionOf(answer);
    },
  };
}

const BEAT_WAKE = {
  kind: 'heartbeat',
  items: [{ kind: 'heartbeat', reason: 'heartbeat', intentionIds: [], errandId: null }],
  intentions: [],
  now: NOW,
  timezone: 'UTC',
  channels: [],
  chainId: 'heartbeat:1',
};

const DUE_WAKE = {
  ...BEAT_WAKE,
  kind: 'intention_due',
  items: [{ kind: 'intention_due', reason: 'due', intentionIds: ['i1'], errandId: null }],
  chainId: 'i1',
};

const GRANTS = [
  'conversation.read',
  'lore.show',
  'lore.list',
  'message.create',
  'intention.set',
  'intention.update',
  'intention.cancel',
  'web.search',
  'web.read',
  'media.look',
];

/** A real intention service over a temp data dir (guild g1) and a clock fixed at NOW. */
function intentionService(hot: Record<string, Untyped>) {
  const stores = createIntentionStores({ dataDir: tempDir('nep-hb-intents-'), now: () => NOW });
  return createIntentionService({ stores, hot, now: () => NOW, log: { info() {}, warn() {} } });
}

/**
 * One live inner turn in #general answered with `answers`, over the real intention service. `wake` is the turn's
 * wake (a heartbeat by default), `seed(service)`
 * what exists before the turn.
 */
async function liveTurn({
  answers,
  wake = BEAT_WAKE,
  seed = null,
  intentionsCfg = {},
  lore = [],
  lookup = null,
}: Record<string, Untyped>) {
  const history = [rawMessage({ id: 'm0', ts: NOW - 120_000, content: 'πρώτο' })];
  const hot: Record<string, Untyped> = hotWith({
    access: personaGrants(GRANTS),
    wakes: { mode: 'live' },
  });
  hot.config.intentions = { expiresDays: 14, maxOpen: 20, ...intentionsCfg };
  const intentions = intentionService(hot);
  seed?.(intentions);
  const channel = world().channel({ id: 'c1', name: 'general', placeId: 'g1', historyMessages: history });
  const port = createFakeAdapter({ iface: 'fake', selfId: 'self-id', now: () => NOW });
  const reads = world().adopt(port);
  const client = { user: { id: 'self-id', username: 'Bot' } };
  const store = fakeStore();
  store.getLore = () => lore;
  const admin = createAdmin({
    discord: DISCORD,
    hot,
    store,
    client,
    isServedRoot: (id: unknown) => id === 'g1',
    port,
    reads,
    intentions,
    now: () => NOW,
  });
  const llm = sequenceLlm(typeof answers === 'function' ? answers(intentions) : answers);
  const calibrator = { ratio: 1, apply: (value: Record<string, Untyped>) => value, observe: () => {} };
  const turns = createTurnRunner({
    hot,
    store,
    llm,
    calibrator,
    now: () => NOW,
    port,
    skills: skillRegistry(),
    journal: null,
    runOp: admin.runSkillOp,
    runOwnOp: admin.runOwnSkillOp,
    runInitiativeOp: admin.runInitiativeSkillOp,
    intentions,
    lookup,
  });
  const inner = { wake, shadow: false, mayAct: () => true, currentChannel: null };
  const { result, logs } = await withCapturedLogs(() =>
    turns.runTurn({ channel, placeId: 'g1', mode: 'inner', triggerKind: 'inner', inner })
  );
  const sends = port.calls.filter((call) => call.op === 'send');
  return { result, logs, llm, sends, intentions, hot, list: () => intentions.list({ all: true, closed: true }) };
}

const THINK = '<think>STEP 4. So: write it.</think>';

describe('the intents of a heartbeat', () => {
  before(() => useIface('fake'));
  after(() => useIface('discord'));

  test('an intention_due turn is not limited to intention changes', async () => {
    const run = await liveTurn({
      wake: { ...DUE_WAKE, intentions: [{ id: 'i1', purpose: 'say hello', dueAt: NOW }] },
      answers: [toolAnswer(`${THINK}`, [call('message.create', { place: `#general`, text: `γεια` })]), '<skip/>'],
    });
    assert.equal(run.sends.length, 1);
  });
});

const BODY = 'Search first, then read the best hit and say where it came from.';

/** A rig with one active skill, `look-it-up`, which needs `web.search`. */
function withSkill(t: { after: (fn: () => void) => void }): SkillsRig {
  const rig = skillsRig(t);
  rig.writeLocal('look-it-up', skillText('look-it-up', 'I check the web first', ['web.search'], BODY));
  rig.port.activate('look-it-up', 'agent:hand');
  return rig;
}

test('a heartbeat refuses a call of a skill outside its set with heartbeat-only', async (t) => {
  // Bug: a skill in the one tools array lets a heartbeat act before it decides on an intention.
  const rig = withSkill(t);
  const run = await skillTurn({
    kind: 'heartbeat',
    answers: [toolAnswer('', [call('look-it-up')]), 'ok'],
    skills: rig.port,
  });
  assert.ok(run.actions.includes('look-it-up:refused:heartbeat-only'), run.actions.join(', '));
  assert.equal(run.readsAt.at(-1), 0, 'the refused skill is never read');
});
