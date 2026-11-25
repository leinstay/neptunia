// The shapes the replay script builds: the options of a mode, scenarios and trigger lines.

import type { Hot } from '../../src/hot.ts';
import type { ReplayArgs } from './replay-args.ts';
import type { Variant } from './script-routes.ts';

type Untyped = ReturnType<typeof JSON.parse>;

export type Rec = Record<string, Untyped>;

/** What `main` hands `runMain` besides the options: the engine's root, the abort signal, the answers directory and the replaced roles. */
export type RunEnv = {
  root: string;
  signal?: AbortSignal;
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

/** The part of the live view the script reads: the settings and the prompt files. */
type HotView = Pick<Hot, 'config' | 'prompts'>;

/** What one mode of the script is handed: the parsed options and the objects `runMain` builds, read by name. */
export type ModeCtx = { args: ReplayArgs; root: string; hot: HotView; signal?: AbortSignal; [key: string]: Untyped };
