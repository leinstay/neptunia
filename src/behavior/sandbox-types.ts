// The types of the signatures in ./sandbox.ts: the inputs and results that are too long to read inline.

import type { Untyped } from '../tools/types.ts';
import type { loopSettings } from './turn.ts';
import type { CallMark, Line } from './lines.ts';
import type { PlaceChainLink } from '../memory/db/place-tree.ts';
import type { PendingPing } from './pending.ts';

export type MomentCutoffInput = {
  history?: Array<Line>;
  triggerId?: string | null;
  mode?: string | null;
  at?: number;
};

export type HiddenLaterResult = {
  episodes: number;
  affinity: number;
  reasons: number;
  details: number;
  interests: number;
  aliases: number;
  learned: number;
  lore: number;
};

/**
 * A view over the live state of one place: prompts and config are getters
 * that read `hot` at call time, memory accessors read the store at call time.
 * Nothing is copied. `calibrator` measures tokens the way a real turn does
 * (the live ratio, read at call time) and never feeds the live calibrator;
 * without a live `calibrator` it is the identity one (ratio 1).
 * `memory.getRecent` is the place's recent store (src/memory/store.js#getRecent),
 * null for a store that keeps none. A view passed instead must offer the same
 * shape (a missing `calibrator` counts as the identity one, a missing
 * `memory.getRecent` as no recent store).
 */
export type LiveViewInput = {
  hot: { prompts: Untyped; config: Untyped };
  store: Untyped;
  placeId: string;
  calibrator?: { ratio: number; apply: (n: number) => number };
};

export type LiveViewResult = {
  readonly prompts: Untyped;
  readonly config: Untyped;
  calibrator: {
    readonly ratio: number;
    apply: (n: number) => number;
    observe: (rawEstimate?: number, actualTokens?: number) => number;
  };
  memory: {
    getPlace: () => Untyped;
    getUser: (id: string | undefined) => Untyped;
    listUserProfiles: () => Array<Untyped>;
    listChannels: () => Array<Untyped>;
    getLore: () => Array<Untyped>;
    getRecent: () => { nextId: number; lines: Array<Untyped> } | null;
    selfreflectionChannelIds: () => Array<string>;
  };
};

export type SituationHistoryInput = {
  history: Array<Line>;
  triggerId?: string | null;
  kind?: string | null;
  mode?: string | null;
};

export type SampleInput = {
  llm: Untyped;
  messages: Untyped;
  options: Untyped;
  samples: Untyped;
  signal: Untyped;
  onUsage: Untyped;
  read: Untyped;
};

export type SandboxToolsetInput = {
  view: Record<string, Untyped>;
  selfId?: string | null;
  registry?: Map<string, Untyped>;
};

export type SandboxToolsetResult = {
  transport: 'native' | 'text';
  names: Array<string>;
  tools: Array<Record<string, Untyped>>;
  block: string | null;
  tokens: number;
  registry: Map<string, Untyped>;
};

/**
 * The reply sandbox: the request a real turn would send for the moment
 * (buildRequest over `sandboxRequestInput`: its mode and trigger kind when
 * recorded; memory through `view.memory`, tokens measured with
 * `view.calibrator`, so the caps trim what a real turn trims), `samples`
 * completions, each parsed with parseOutput and trimmed by
 * `features.reactions` / `features.multiMessage` like a real turn. The
 * transcript's GIF handles render as in a real turn when the caller hands in
 * the same sources the turn uses (`customEmoji`, `gifs`, `mediaCache`;
 * buildRequest applies `features.customEmoji` / `features.gifs`); so do
 * `<senses>`' line on where a call from a read-only channel is answered
 * (`elsewhereDestination`) and its search line (`searchAvailable`). `<recent>`
 * shows the view's recent lines of this channel inside `memory.recentHours`
 * at `at` and the members' moments of those hours (`recentLinesOf`; a
 * `momentView` holds the lines added before the moment). Left out, unlike a
 * real turn: every input of `SANDBOX_OMITS` (neighbours, other channels, the
 * web lookup, the server search, a drawing offer, the recent
 * lines of other channels, a private chat), pictures (a user message with
 * image parts is sent as its text-only re-render), an owner-forced turn's
 * text, the daily GIF cap, and a custom-emoji reaction is kept as written
 * (not resolved through the emoji index); nothing is sent to the interface and
 * nothing is stored. Media render with their labels only, unless the caller
 * hands in what the persona saw of them (`descriptions` / `videos`, see
 * `replayMedia`): nothing is described or watched here. Every completion
 * passes `role: 'core'`, `purpose: 'reply'` (`REPLY_REQUEST`), `origin:
 * 'replay'`, `countAgainstDailyCap: false` and `skipCalibration: true`; the
 * per-request token cap stays in force. With `samples` > 1 and a request the
 * llm client caches (src/llm/openrouter.js#cacheTtlFor: `features.promptCache`,
 * role `core`, the model), the user message is one text part carrying a
 * cache marker, so samples 2..N read the cache instead of paying for it again.
 * `skip` is true
 * when the model skipped or left nothing to do (as a real turn treats it).
 * @param input.view        From `liveView` (or a view of the same shape, e.g. `momentView`).
 *   The moment (see `situationHistory`).
 * @param input.at          The moment the turn is answered at (ms).
 * @param [input.onUsage]  Called after every completion.
 * @param [input.descriptions]  Item id -> caption, rendered as the live transcript does.
 * @param [input.videos]  Item id -> video state (`{ state: 'watched', text }`), likewise.
 * @param [input.customEmoji]  The served place's
 *   custom emoji (src/behavior/emoji-index.ts#createEmojiIndex `list()`).
 * @param [input.gifs]  The GIF library (store.getGifs); omitted, the transcript's GIFs carry no handle.
 * @param [input.mediaCache]  The describer cache (store.mediaEntries), read only, for both lists' captions.
 * @param [input.elsewhereDestination]  The channel `<senses>` names for a call from a read-only channel; omitted, no
 *   such line.
 * @param [input.searchAvailable]  Whether a web search key is configured (the lookup's
 *   `hasSearch()`); only `true` adds the search line (with `features.webLookup` on). No search is run.
 */
export type AnswerReplyInput = {
  view: SandboxView;
  situation: { history: Array<Untyped>; triggerId?: string | null; kind?: string | null; mode?: string | null };
  selfId: string;
  selfName: string;
  channel: { id: string; name?: string; topic?: string | null; iface?: string | null };
  llm: { complete: (...args: Array<Untyped>) => Untyped };
  samples: number;
  at: number;
  signal?: AbortSignal;
  onUsage?: (usage: Untyped, estimated: number) => void;
  descriptions?: Map<string, string>;
  videos?: Map<string, Untyped>;
  customEmoji?: Array<{ id: string; name: string; animated?: boolean }>;
  gifs?: Untyped;
  mediaCache?: Untyped;
  elsewhereDestination?: { name: string } | null;
  searchAvailable?: boolean;
  channelDirectory?: Untyped;
  tools?: Untyped;
  toolChoice?: Untyped;
  parallelToolCalls?: Untyped;
};

export type AnswerReplyResult = {
  request: { system: string; user: string };
  answers: Array<{
    messages: Array<{ text: string; replyTo: number | null; mentions?: Array<string>; unknownHandles?: number }>;
    reactions: Array<{ to: number; emoji: string }>;
    skip: boolean;
    think: string;
  }>;
  stopped: boolean;
};

export type ScenarioInventoryInput = {
  config: Untyped;
  selfId: string;
  texts?: Untyped;
  requester: Untyped;
  chatId: string;
  registry: Map<string, Untyped>;
  discovery?: 'inventory' | 'none' | Array<string>;
  getOp?: (...args: Array<Untyped>) => Untyped;
};

/**
 * One `<call>` of the persona (`call`, src/llm/parse.js's) taken through what a live turn does
 * before the operation runs (src/behavior/turn.ts#planToolCall and #runCall): resolved on the
 * server's side over `view` (src/tools/executors.ts#resolveCall; src/behavior/turn.ts#callViewOf),
 * checked by the gateway (src/tools/gateway.ts#checkSkill: the persona as principal, `requester`,
 * `chatId` as the audience, `config` with her grants, `selfId`, the registry of `view`,
 * no mixed requesters, no earlier destructive run, `now`, the image quota of `images`, the
 * errands' budget of `tasks` -- `{ budget(agent) }`, src/errands/store.ts#budget's answer, as a
 * live turn hands in src/errands/service.ts#budget; without it an `errand.run` is refused
 * `no-budget`), then
 * mapped by its dispatch (`dispatch.toOp` must reach this very operation). The operation never
 * runs, whatever it is -- a write, a paid effect (`draw.create` included): a call that passed is
 * recorded (`executed`: the skill and its resolved arguments) and answered with a canned `ok` whose
 * text is `resultText`. `verdict` says where it stopped (`stage`: `resolve`, `gateway` or `command`;
 * `ok`, `code`, `reason`). Whether the step's speech goes out and whether a request follows is the
 * step engine's call over the result and the skill's definition (runSkillLoop), not this function's.
 * Never throws; pure but for the gateway's reads of `images` and `tasks`.
 */
export type SimulateCallInput = {
  call: { skill: string; args: Untyped; body: string };
  view: SandboxView;
  config: Untyped;
  selfId: string;
  requester: { id: string; roleIds: Array<string> } | null;
  chatId: string;
  now: number;
  images?: Untyped;
  tasks?: { budget(agent: unknown): Untyped } | null;
  getOp?: (...args: Array<Untyped>) => Untyped;
  resultText?: string;
};

export type SimulateCallResult = {
  verdict: { stage: string; ok: boolean; code?: string; reason?: string };
  executed: { skill: string; args: Untyped } | null;
  result: { skill: string; status: string; code?: string; data?: { text: string } };
};

export type SkillScenarioRequestResult = {
  system: string;
  user: string;
  transport: string;
  tools: number;
  toolsTokens: number;
  tokens: number | null;
  limit: number | null;
  idByIndex: Map<number, string>;
};

export type CallMarkOfInput = {
  outcome: Untyped;
  placeId: string;
  at: number;
  postedId: Untyped;
  posted: Untyped;
};

export type AnswerSkillScenarioResult = {
  request: {
    system: string;
    user: string;
    tokens: number | null;
    limit: number | null;
    toolsTokens: number;
    tools: number;
  };
  runs: Array<ScenarioRun>;
  stopped: boolean;
};

export type RunSkillLoopInput = {
  run: ScenarioRun;
  read: Untyped;
  sentAt: Untyped;
  firstMs: Untyped;
  built: Untyped;
  requestArgs: Untyped;
  history: Untyped;
  view: SandboxView;
  gifs: Untyped;
  llm: Untyped;
  signal: Untyped;
  onCall: Untyped;
  settings: ReturnType<typeof loopSettings>;
  clock: Untyped;
  toolset: SandboxToolsetResult;
  registry: Untyped;
};

/**
 * One turn of a multi-step skill scenario (scripts/replay.ts `--skills` with `steps`) carried
 * into the channel the next step reads, as the channel would stand after the live turn:
 * `transcript` (the step's lines, its incoming messages last) and `callMarks` (the earlier steps'
 * calls, the shape src/format.ts#callMarksFor reads) with what the persona did in `run` (answerSkillScenario's, answered at
 * `at` in `channel`). Her messages of both passes become her lines (src/behavior/turn.ts#continuationHistory:
 * `selfName` as author), a second apart after `at` (a step's posted speech, then its calls, step after
 * step; speech a step held is not in the chat): the text with its `@handles` rendered as a live post renders them
 * (src/behavior/handles.ts#resolveHandles over the request's handles; `mentionedAccountIds` the
 * members it would mention), the reply target her `reply="#n"` names in the request that pass
 * answered, the link to the step's trigger (`triggerId`, as linkTriggers puts it on); a drawing
 * (a draw.create call) as a line of hers with a picture. Her reactions land on their lines (a normalized
 * reaction, `mine`). A call that passed and posts (message.create, draw.create) into this channel
 * leaves its post as a line of hers; into another channel nothing here but its mark; a call
 * that passed and reacts (message.react.add) on a line here leaves the reaction. Every call
 * leaves its mark (callMarkOf: `posted` every line of hers of the turn, the call's own post
 * `postedId`) for the next steps' requests. Not carried: a GIF, an edit or a deletion, the image
 * quota. Ids are snowflakes of their moments. Pure.
 */
export type AfterScenarioTurnInput = {
  transcript: Array<Untyped>;
  callMarks?: Array<Untyped>;
  run: ScenarioRun;
  at: number;
  selfId: string;
  selfName: string;
  channel: { id: string };
  triggerId?: string | null;
  config?: Untyped;
};

export type SeededSelfLineInput = {
  text: string;
  at: number;
  selfId: string;
  selfName: string;
  channel: { id: string };
};

export type BurstTurnsResult = {
  turns: Array<{
    line: Record<string, Untyped>;
    kind: PendingPing['kind'];
    queued: Array<{ id: string; text: string; author?: string }>;
  }>;
  replaced: Array<{ id: string; by: string }>;
  dropped: Array<{ id: string; reason: string }>;
};

export type SituationHistoryResult = {
  history: Array<Line>;
  trigger: Line | null;
  triggerKind: string | null;
};

/** One step of a sandbox turn's loop as the run records it. */
export type StepRecord = {
  step: number;
  answer: Untyped;
  calls: Array<Untyped>;
  dropped: number;
  capped: string | null;
  held: boolean;
  thinkMissing: Untyped;
  coerced: number;
  usage: Untyped;
  ms: number;
  requestChars: number;
  idByIndex: Untyped;
  history: Untyped;
  channelHandles: Untyped;
  continuation?: boolean;
  error?: string;
};

/** The memory a sandbox view reads: the live store's accessors or a moment's. */
export type SandboxMemory = {
  getPlace: () => Untyped;
  getUser: (id: string | undefined) => Untyped;
  listUserProfiles: () => Array<Untyped>;
  listChannels: () => Array<Untyped>;
  getLore: () => Array<Untyped>;
  getRecent?: () => { nextId: number; lines: Array<Untyped> } | null;
  selfreflectionChannelIds?: () => Array<string>;
  /** The addresses of src/memory/store-addresses.ts a replay reads its place tree through. */
  placeOfChat?: (chat: { id: string }, iface?: string) => string | null;
  placeChainOf?: (placeId: string) => ReadonlyArray<PlaceChainLink>;
  accountOf?: (nativeId: string, iface?: string) => string;
  personOfAccount?: (accountId: string) => string | null;
};

/** What a sandbox turn reads of the world: the live prompts and config, the calibrator and the memory. */
export type SandboxView = {
  readonly prompts: Record<string, Untyped>;
  readonly config: Record<string, Untyped>;
  readonly calibrator: { readonly ratio: number; apply: (n: number) => number; observe?: () => number };
  memory: SandboxMemory;
  skills?: Untyped;
};

/** One answered run of a scenario: what she said, her first call and its outcome, the loop that followed. */
export type ScenarioRun = {
  answer: Untyped;
  call: Untyped;
  callError: Untyped;
  extraCalls: number;
  usage: Untyped;
  outcome: Untyped;
  followUp: Untyped;
  callMentions?: Untyped;
  refs: { idByIndex: Untyped; handles: Untyped; channelHandles: Untyped; followUpIdByIndex: Untyped };
  loop?: { steps: Array<StepRecord>; ms: number };
};

/** The inputs of `answerReply` that shape its request, and what a skill scenario or a task result adds. */
export type SandboxRequestInput = Pick<
  AnswerReplyInput,
  | 'view'
  | 'situation'
  | 'selfId'
  | 'selfName'
  | 'channel'
  | 'at'
  | 'descriptions'
  | 'videos'
  | 'customEmoji'
  | 'gifs'
  | 'mediaCache'
  | 'elsewhereDestination'
  | 'searchAvailable'
  | 'channelDirectory'
> & {
  skillsInventory?: Untyped;
  toolset?: SandboxToolsetResult | null;
  queued?: Untyped;
  taskResult?: Untyped;
  coreTools?: Untyped;
  preTurn?: Untyped;
  /** A skill scenario's earlier steps' calls as call marks (src/format.ts#callMarksFor), put among the chat's lines. */
  callMarks?: Array<CallMark> | null;
};
