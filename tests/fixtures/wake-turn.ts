// One live inner turn of a chosen wake kind over the real turn runner, the real operations, a real intention service,
// a real task board in memory and a fake model, for the tests of what a heartbeat and a selfimprovement wake may do.
// The fake interface holds the anchor channel; no network and no provider. Synthetic data only.
import { createTurnRunner as createRealTurnRunner } from '../../src/behavior/turn.ts';
import { createAdmin } from '../../src/admin.ts';
import { createFakeAdapter } from '../../src/interface/fake.ts';
import { createDiscordInterface } from '../../interfaces/discord/index.ts';
import { createIntentionService } from '../../src/intentions/service.ts';
import { createIntentionStores } from '../../src/intentions/store.ts';
import '../../src/tools/impl/index.ts';
import { skillRegistry } from '../../src/tools/registry.ts';
import type { BoardCaller } from '../../src/tools/impl/board.ts';
import type { Untyped } from '../../src/tools/types.ts';
import { withCapturedLogs } from './capture-logs.ts';
import { labels } from './labels.ts';
import { wrongly } from './loose-types.ts';
import { tempDir } from './tmp.ts';
import { completionOf } from './tool-answers.ts';
import { onWorld, useIface, world } from './turn-world.ts';

useIface('fake');
const createTurnRunner = onWorld(wrongly(createRealTurnRunner));

export const WAKE_NOW = Date.parse('2026-11-02T12:00:00Z');
export const ANCHOR_LINE = 'a line of the anchor channel';
/** Marker texts of the prompt files, so a test reads which file framed the request without reading any wording. */
export const PROMPT_MARK = {
  card: 'MARK-CHARACTER-CARD',
  inner: 'MARK-INNER-TASK',
  heartbeat: 'MARK-HEARTBEAT-TASK',
  selfimprovement: 'MARK-SELFIMPROVEMENT-WAKE',
  brief: 'MARK-EXECUTOR-BRIEF',
  diary: 'MARK-DIARY-TASK',
} as const;

const GRANTED = [
  'conversation.read',
  'lore.list',
  'lore.show',
  'memory.search',
  'memory.recent.read',
  'message.create',
  'intention.set',
  'intention.update',
  'intention.cancel',
  'errand.run',
  'web.search',
  'skill.read',
  'skill.run',
  'skill.disable',
  'board.propose',
  'board.status',
  'board.cancel',
  'board.comment',
  'board.answer',
];

export type WakeTurn = {
  result: Record<string, Untyped>;
  logs: Array<Record<string, Untyped>>;
  /** The messages of each request the model got. */
  requests: Array<Array<Record<string, Untyped>>>;
  /** The tool names offered with the first request. */
  offered: Array<string>;
  /** `skill:status:code` of each call of the turn. */
  actions: Array<string>;
  sends: number;
  intentions: Array<Record<string, Untyped>>;
};

/** A wake of `kind` as the drain hands it to the turn, on the chain `chainId`, with `facts` under its kind's key. */
export function wakeOfKind(kind: string, chainId: string, facts: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind,
    items: [{ kind, reason: kind === 'selfimprovement' ? 'daily' : kind, intentionIds: [], errandId: null }],
    intentions: [],
    now: WAKE_NOW,
    timezone: 'UTC',
    channels: [],
    chainId,
    budgets: { chain: { used: 0, cap: 3, left: 3 } },
    ...facts,
  };
}

/** The text of a request's messages: the system, the user parts and the tool results. */
export function requestText(messages: ReadonlyArray<Record<string, Untyped>>): string {
  return messages
    .map((message) =>
      typeof message.content === 'string'
        ? message.content
        : (message.content as Array<{ text?: string }>).map((part) => part.text ?? '').join('')
    )
    .join('\n');
}

/**
 * The turn of `wake` answered by `answers`. `board` is the board her operations call; `service` and `turnId` let a
 * test run the same wake twice over the same stores, as a restarted turn does.
 */
export async function wakeTurn({
  wake,
  answers,
  board,
  lore = [],
  service = null,
}: {
  wake: Record<string, unknown>;
  answers: ReadonlyArray<unknown>;
  board: BoardCaller | null;
  lore?: ReadonlyArray<Record<string, unknown>>;
  service?: ReturnType<typeof createIntentionService> | null;
}): Promise<WakeTurn> {
  const hot: Record<string, Untyped> = {
    config: {
      bot: {
        timezone: 'UTC',
        owners: ['u1'],
        access: Object.fromEntries(GRANTED.map((name) => [name, { everyone: false, roles: [], users: ['self-id'] }])),
      },
      context: {
        channelMessages: 100,
        caps: { interlocutor: 2500, aboutChat: 2500, people: 4000, neighbors: 3000 },
        vision: { fetchTimeoutMs: 10_000 },
        pull: { sameAudience: true },
      },
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
      'character-card': PROMPT_MARK.card,
      format: 'Use <msg> and <react> tags.',
      reply: 'Someone called you: {{author}}.',
      interject: 'Jump in.',
      initiate: 'Start a topic.',
      inner: PROMPT_MARK.inner,
      heartbeat: PROMPT_MARK.heartbeat,
      selfimprovement: PROMPT_MARK.selfimprovement,
      'executor-brief': PROMPT_MARK.brief,
      diary: PROMPT_MARK.diary,
      labels,
    },
  };
  const intentions =
    service ??
    createIntentionService({
      stores: createIntentionStores({ dataDir: tempDir('nep-wake-turn-'), now: () => WAKE_NOW }),
      hot,
      getGuildId: () => 'g1',
      now: () => WAKE_NOW,
      log: { info() {}, warn() {} },
    });
  const channel = world().channel({
    id: 'c1',
    name: 'general',
    guildId: 'g1',
    historyMessages: [
      {
        id: 'm0',
        channelId: 'c1',
        author: { id: 'u1', bot: false, globalName: 'Alice', username: 'Alice' },
        member: { displayName: 'Alice' },
        cleanContent: ANCHOR_LINE,
        createdTimestamp: WAKE_NOW - 120_000,
        reference: null,
        attachments: new Map(),
        stickers: new Map(),
      },
    ],
  });
  const port = createFakeAdapter({ iface: 'fake', selfId: 'self-id', now: () => WAKE_NOW });
  const reads = world().adopt(port);
  const store = {
    getGuild: () => ({}),
    getUser: () => null,
    getPrivate: () => null,
    listChannels: () => [],
    listUserProfiles: () => [],
    countUsers: () => 0,
    getLore: () => lore,
    getMediaCache: () => ({}),
    state: { data: {}, markDirty() {} },
  };
  const admin = createAdmin({
    discord: createDiscordInterface().capabilities,
    hot,
    store,
    client: { user: { id: 'self-id', username: 'Bot' } },
    getGuildId: () => 'g1',
    port,
    reads,
    intentions,
    board,
    now: () => WAKE_NOW,
  });
  const requests: WakeTurn['requests'] = [];
  const options: Array<Record<string, Untyped>> = [];
  const llm = {
    complete: (messages: Array<Record<string, Untyped>>, given: Record<string, Untyped>) => {
      requests.push(messages);
      options.push(given);
      return Promise.resolve(completionOf(answers[Math.min(requests.length - 1, answers.length - 1)]));
    },
  };
  const turns = createTurnRunner({
    hot,
    store,
    llm,
    calibrator: { ratio: 1, apply: (value: unknown) => value, observe: () => {} },
    now: () => WAKE_NOW,
    port,
    skills: skillRegistry(),
    journal: null,
    runOp: admin.runSkillOp,
    runOwnOp: admin.runOwnSkillOp,
    runInitiativeOp: admin.runInitiativeSkillOp,
    intentions,
  });
  const inner = { wake, shadow: false, mayAct: () => true, currentChannel: null };
  const { result, logs } = await withCapturedLogs(() =>
    turns.runTurn({ channel, guildId: 'g1', mode: 'inner', triggerKind: 'inner', inner })
  );
  const tools = (options[0]?.tools ?? []) as Array<{ function: { name: string } }>;
  const turn = result as { inner?: { actions?: Array<Record<string, string | null | undefined>> } };
  return {
    result,
    logs,
    requests,
    offered: tools.map((tool) => tool.function.name),
    actions: (turn.inner?.actions ?? []).map(
      (action) => `${action.skill}:${action.status}:${action.code ?? action.result}`
    ),
    sends: port.calls.filter((one: { op: string }) => one.op === 'send').length,
    intentions: intentions.list('g1', { all: true, closed: true }),
  };
}
