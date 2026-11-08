// One live turn over the real turn runner and the real operations, with a fake model, for the tests of her skills as
// entries of the tools array (plan 2026-11-06-turn-frame, slice 8): a reply in a room of the `discord` interface, a
// reply in the owner's chat of the command line (`cli`), or a heartbeat. Her skills come from a real skills port over a
// memory database and temporary folders (tests/fixtures/skills-rig.ts); the port's reads are counted. No network, no
// provider. Synthetic data only.
import { createTurnRunner as createRealTurnRunner } from '../../src/behavior/turn.ts';
import { createAdmin } from '../../src/admin.ts';
import { createDiscordInterface } from '../../interfaces/discord/index.ts';
import { createIntentionService } from '../../src/intentions/service.ts';
import { createIntentionStores } from '../../src/intentions/store.ts';
import type { ActiveSkill } from '../../src/skills/index-block.ts';
import type { SkillsPort } from '../../src/skills/port.ts';
import '../../src/tools/operations/index.ts';
import { skillRegistry } from '../../src/tools/registry.ts';
import type { Untyped } from '../../src/tools/types.ts';
import { withCapturedLogs } from './capture-logs.ts';
import { labels } from './labels.ts';
import { wrongly } from './loose-types.ts';
import { tempDir } from './tmp.ts';
import { completionOf } from './tool-answers.ts';
import { freshWorld, onWorld, useIface, world } from './turn-world.ts';

const createTurnRunner = onWorld(wrongly(createRealTurnRunner));

export const SKILL_TURN_NOW = Date.parse('2026-11-08T12:00:00Z');

/** Which turn: a reply in a room, a reply in the command line's owner chat, or a heartbeat with no place. */
export type SkillTurnKind = 'discord-reply' | 'cli-reply' | 'heartbeat';

/** Her grants: reads a heartbeat takes, a post, an intention change, and her skill tools. */
const GRANTED = [
  'conversation.read',
  'memory.search',
  'message.create',
  'intention.set',
  'intention.update',
  'intention.cancel',
  'web.search',
  'skill.read',
  'skill.run',
  'skill.disable',
];

export type SkillTurn = {
  /** The `tools` option of the turn's first request, as JSON. */
  toolsJson: string;
  /** The function names of the turn's first request. */
  offered: Array<string>;
  /** The messages of each request the model got. */
  requests: Array<Array<Record<string, Untyped>>>;
  /** How many times the skills port was asked for a skill's text when each request went out. */
  readsAt: Array<number>;
  /** `skill:status:code` of each call of an inner turn. */
  actions: Array<string>;
  logs: Array<Record<string, Untyped>>;
};

/** A line of the chat she answers, as the interface stub gives it. */
function line(id: string, chatId: string, text: string): Record<string, unknown> {
  return {
    id,
    placeId: chatId,
    author: { id: 'u1', bot: false, globalName: 'Eleni', username: 'Eleni' },
    member: { displayName: 'Eleni' },
    cleanContent: text,
    createdTimestamp: SKILL_TURN_NOW - 60_000,
    reference: null,
    attachments: new Map(),
    stickers: new Map(),
  };
}

/** The trigger of a reply to `raw`, as the runner reads it. */
function triggerOf(raw: Record<string, unknown>, chatId: string): Record<string, unknown> {
  return {
    id: raw.id,
    placeId: chatId,
    authorId: 'u1',
    authorName: 'Eleni',
    self: false,
    bot: false,
    content: raw.cleanContent,
    ts: raw.createdTimestamp,
    replyToId: null,
    attachments: [],
    stickers: [],
  };
}

/** The text of a request's messages: the system, the user parts and the tool results. */
export function requestText(messages: ReadonlyArray<Record<string, Untyped>>): string {
  return messages
    .map((message) =>
      typeof message.content === 'string'
        ? message.content
        : Array.isArray(message.content)
          ? (message.content as Array<{ text?: string }>).map((part) => part.text ?? '').join('')
          : ''
    )
    .join('\n');
}

/**
 * The turn `kind` answered by `answers` (the last repeats), with `skills` as her skills port: its active skills are
 * handed to the runner as `activeSkills`, and the operations read a skill's text through it.
 */
export async function skillTurn({
  kind,
  answers,
  skills,
  grants = GRANTED,
}: {
  kind: SkillTurnKind;
  answers: ReadonlyArray<unknown>;
  skills: SkillsPort;
  /** Her grants, `GRANTED` by default. */
  grants?: ReadonlyArray<string>;
}): Promise<SkillTurn> {
  useIface(kind === 'cli-reply' ? 'cli' : 'discord');
  freshWorld();
  const hot: Record<string, Untyped> = {
    config: {
      bot: {
        timezone: 'UTC',
        owners: ['u1'],
        access: Object.fromEntries(grants.map((name) => [name, { everyone: false, roles: [], users: ['self-id'] }])),
      },
      context: {
        channelMessages: 100,
        caps: { interlocutor: 2500, aboutChat: 2500, people: 4000, neighbors: 3000 },
        vision: { fetchTimeoutMs: 10_000 },
        pull: { sameAudience: true },
        chatSteps: [100, 60, 30, 10],
      },
      dm: { enabled: true },
      llm: { maxRequestTokens: 50000 },
      typing: { reactionDelayMs: [0, 0], msPerChar: [1, 1], minMs: 0, maxMs: 100, betweenMessagesMs: [0, 0] },
      models: { base: { analyzer: 'x/text' } },
      tools: {
        safeMode: false,
        transport: 'native',
        resultMaxChars: 2000,
        callTimeoutMs: 120000,
        loop: { maxSteps: 4, timeBudgetMs: 20000, maxCallsPerStep: 4 },
      },
      wakes: { mode: 'live' },
      intentions: { expiresDays: 14, maxOpen: 20 },
    },
    prompts: {
      'system-prompt': 'You are a regular member of this chat.',
      'character-card': 'You are friendly and terse.',
      format: 'Use <msg> and <react> tags.',
      reply: 'Someone called you: {{author}}.',
      interject: 'Jump in.',
      initiate: 'Start a topic.',
      inner: 'MARK-INNER-TASK',
      heartbeat: 'MARK-HEARTBEAT-TASK',
      labels,
    },
  };
  const intentions = createIntentionService({
    stores: createIntentionStores({ dataDir: tempDir('nep-skill-turn-'), now: () => SKILL_TURN_NOW }),
    hot,
    now: () => SKILL_TURN_NOW,
    log: { info() {}, warn() {} },
  });
  const chatId = kind === 'cli-reply' ? 'owner' : 'c1';
  const said = line('m1', chatId, 'πώς το κάνεις αυτό;');
  const channel =
    kind === 'cli-reply'
      ? world().channel({ id: chatId, dm: true, partnerId: 'u1', historyMessages: [said] })
      : world().channel({ id: chatId, name: 'general', placeId: 'g1', historyMessages: [said] });
  let reads = 0;
  const counted: SkillsPort = {
    ...skills,
    show: (name: string) => {
      reads += 1;
      return skills.show(name);
    },
  };
  const store = {
    topPlaces: () => ['g1'],
    getPlace: () => ({}),
    getUser: () => null,
    getPrivate: () => null,
    listChannels: () => [],
    listUserProfiles: () => [],
    countUsers: () => 0,
    getLore: () => [],
    getMediaCache: () => ({}),
    state: { data: {}, markDirty() {} },
  };
  const { port } = world();
  const admin = createAdmin({
    discord: createDiscordInterface().capabilities,
    hot,
    store,
    client: { user: { id: 'self-id', username: 'Bot' } },
    isServedRoot: (id: unknown) => id === 'g1',
    port,
    reads: world().reads,
    intentions,
    skills: counted,
    now: () => SKILL_TURN_NOW,
  });
  const requests: SkillTurn['requests'] = [];
  const options: Array<Record<string, Untyped>> = [];
  const readsAt: Array<number> = [];
  const llm = {
    complete: (messages: Array<Record<string, Untyped>>, given: Record<string, Untyped>) => {
      requests.push(messages);
      options.push(given);
      readsAt.push(reads);
      return Promise.resolve(completionOf(answers[Math.min(requests.length - 1, answers.length - 1)]));
    },
  };
  const turns = createTurnRunner({
    hot,
    store,
    llm,
    calibrator: { ratio: 1, apply: (value: unknown) => value, observe: () => {} },
    now: () => SKILL_TURN_NOW,
    skills: skillRegistry(),
    journal: null,
    runOp: admin.runSkillOp,
    runOwnOp: admin.runOwnSkillOp,
    runInitiativeOp: admin.runInitiativeSkillOp,
    intentions,
    activeSkills: (): Promise<Array<ActiveSkill>> => Promise.resolve(skills.active()),
  });
  const run = (): Promise<unknown> =>
    kind === 'heartbeat'
      ? turns.runTurn({
          channel,
          placeId: 'g1',
          mode: 'inner',
          triggerKind: 'inner',
          inner: {
            wake: {
              kind: 'heartbeat',
              items: [{ kind: 'heartbeat', reason: 'heartbeat', intentionIds: [], errandId: null }],
              intentions: [],
              now: SKILL_TURN_NOW,
              timezone: 'UTC',
              channels: [],
              chainId: 'chain-heartbeat',
            },
            shadow: false,
            mayAct: () => true,
            currentChannel: null,
          },
        })
      : turns.runTurn({
          channel,
          ...(kind === 'cli-reply' ? {} : { placeId: 'g1' }),
          mode: 'reply',
          trigger: triggerOf(said, chatId),
          triggerKind: kind === 'cli-reply' ? 'dm' : 'mention',
        });
  const { result, logs } = await withCapturedLogs(run);
  const tools = (options[0]?.tools ?? []) as Array<{ function: { name: string } }>;
  const turn = result as { inner?: { actions?: Array<Record<string, string | null | undefined>> } };
  return {
    toolsJson: JSON.stringify(options[0]?.tools ?? null),
    offered: tools.map((tool) => tool.function.name),
    requests,
    readsAt,
    actions: (turn.inner?.actions ?? []).map(
      (action) => `${action.skill}:${action.status}:${action.code ?? action.result}`
    ),
    logs,
  };
}
