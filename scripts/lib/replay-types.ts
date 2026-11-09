// The shapes the replay script builds and reports: scenarios, trigger lines, tool runs and the run and loop records.

import type { Variant } from './script-routes.ts';

type Untyped = ReturnType<typeof JSON.parse>;

export type Rec = Record<string, Untyped>;

/** What `main` hands `runMain` besides the options: the engine's root, the abort signal, the random source and the answers directory and the replaced roles. */
export type RunEnv = {
  root: string;
  signal?: AbortSignal;
  rng: () => number;
  answers: Untyped;
  /** The roles the run's role flags replace (scripts/lib/script-routes.ts). */
  routes: Variant;
};

/** What an inner wake carries as the turn reads it: its kind, the items it holds and the chain it belongs to. */
export type WakeInfo = {
  kind: string;
  items: Array<{
    kind: string;
    reason: string;
    intentionIds: Array<string>;
    errandId: string | null;
    [field: string]: Untyped;
  }>;
  chainId: string;
  now: number;
  heartbeat?: Rec;
  channels?: Array<string>;
  intentions?: Array<Rec>;
  [field: string]: Untyped;
};

/** One scenario of a skills file, parsed. */
export type Scenario = {
  id: string;
  placeId: string;
  before: string | null;
  author?: string;
  text?: string;
  steps?: Array<{
    messages: Array<{ author: string; text: string } | { self: true; text: string }>;
    own: boolean;
    gapMinutes: number;
    result: string | null;
  }> | null;
  taskResult?: {
    agent: string;
    goal: string;
    state: 'done' | 'failed';
    text: string;
    files: Array<{ name: string; contentType: string; bytes: number }>;
    asker: string;
  } | null;
  grants: Array<string>;
  runs: number;
  result: string;
  discovery: 'inventory' | 'none' | Array<string>;
};

/** The chat line a scenario's trigger message is, in the shape the history lines have. */
export type TriggerLine = {
  id: string;
  placeId: string;
  channelName: string | null;
  channelTopic: string | null;
  authorId: string;
  authorName: string;
  self: boolean;
  bot: boolean;
  content: string;
  ts: number;
  mentionedAccountIds: Array<string>;
  mentionedChannelIds: Array<string>;
  replyToId: string | null;
  replyPingAccountId: string | null;
  forwardedFrom: string | null;
  attachments: Array<Rec>;
  links: Array<string>;
  forwarded: Array<Rec>;
  stickers: Array<Rec>;
  emojis: Array<Rec>;
  reactions: Array<Rec>;
};

/** What one tool run answers: the result a turn would read (its text under `data`) and what the run cost. */
export type ToolRun = {
  result: {
    status?: string;
    code?: string;
    data?: { text: string; [field: string]: Untyped };
    [field: string]: Untyped;
  };
  usage: Rec;
};

/** The tools of a replay: the searches and recall over private copies, and the runs of the persona's tools. */
export type ReplayTools = {
  searchers(): { lookup: Untyped; recall: Untyped; client: Untyped; usage: Rec };
  recallAvailable(): boolean;
  prefetch(input?: Rec): Promise<Untyped>;
  run(skill: string, args: Rec, refs?: Rec): Promise<ToolRun>;
};

/** One run of a scenario as its JSONL line. */
export type RunRecord = {
  scenario: string;
  run: number;
  decision: 'call' | 'malformed-call' | 'no-call';
  skill: string | null;
  args: Rec | null;
  callMentions?: Untyped;
  extraCalls: number;
  verdict: Rec | null;
  executed: unknown;
  result: { status: string; code: string | null } | null;
  first: Rec | null;
  followUp: Rec | null;
  tokens: { prompt: number; completion: number; cacheRead?: number; cacheWrite?: number };
  cost: number | null;
  loop?: LoopRecord;
};

/** One call of a loop step as the record keeps it. */
export type LoopCall = {
  skill: string | null;
  args: Rec | null;
  id?: string;
  verdict: Rec | null;
  executed: unknown;
  result: { status: string; code: string | null; chars: number } | null;
  ms: number | null;
  tool?: Rec;
  errand?: Rec;
};

/** One step of a turn's tool loop as the record keeps it. */
export type LoopStep = {
  step: number;
  calls: Array<LoopCall>;
  dropped: number;
  capped: unknown;
  held: boolean;
  thinkMissing: boolean;
  coerced: number;
  continuation?: boolean;
  error?: unknown;
  answer?: Rec | null;
  requestChars: number | null;
  ms: number | null;
  tokens: { prompt: number; completion: number; cacheRead: number; cacheWrite: number };
  cost: number | null;
  resultChars: number;
};

/** A turn's tool loop, summed up: its steps and the counts, tokens and cost of the turn. */
export type LoopRecord = {
  steps: Array<LoopStep>;
  calls: Array<{ step: number; skill: string | null; status: string | null; code: string | null }>;
  errands: Array<Rec>;
  drawings: Array<{ step: number; text: string; self: boolean; channel: unknown }>;
  posts: Array<{ step: number; text: string; channel: unknown }>;
  messages: Array<Rec>;
  final: Array<Rec>;
  requests: number;
  turnRequests: number;
  held: number;
  thinkMissing: number;
  coerced: number;
  capped: number;
  malformed: number;
  ms: number | null;
  tokens: { prompt: number; completion: number; cacheRead: number; cacheWrite: number };
  cost: number | null;
};
