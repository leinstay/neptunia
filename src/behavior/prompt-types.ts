// The types of the signatures in ./prompt.ts: the inputs and results that are too long to read inline.

import type { Untyped } from '../tools/types.ts';
import type { Prompts, RequestConfig, RequestInput } from '../turn/request/types.ts';
import type { sectionCost } from '../llm/budget.ts';
import type { PulledChannel } from './pull-fetch.ts';

export type ClassifierTranscriptArg2 = {
  config: Untyped;
  selfName: string;
  labels: Untyped;
  descriptions?: Map<string, unknown>;
  videos?: Map<string, unknown>;
  reads?: Map<string, unknown>;
};

export type BuildDrawPromptInput = {
  prompts: { appearance?: string; draw?: string; labels?: { draw?: { when?: string } } };
  selfName: string;
  request: string;
  self: boolean;
  when?: string;
};

export type BuildRequestInput = {
  config: RequestConfig;
  prompts: Prompts;
  calibrator: Parameters<typeof sectionCost>[0];
  mode: 'reply' | 'interject' | 'initiate' | 'elsewhere' | 'inner';
  forced?: boolean;
  now: number;
  selfName: string;
  selfId?: string | null;
  history: RequestInput['history'];
  neighbors: Array<{ placeId?: string; channelName: string; messages: Array<Untyped> }>;
  trigger: RequestInput['trigger'];
  triggerKind: string | null;
  taggedCall?: boolean | null;
  placeMemory: RequestInput['placeMemory'];
  interlocutor: RequestInput['interlocutor'];
  privateChat?: { accountId: string } | null;
  privateProfile?: RequestInput['privateProfile'];
  otherProfiles: Array<Untyped>;
  candidateProfiles?: Array<Untyped>;
  nameOf?: (id: string) => string | null;
  channels?: Array<Untyped>;
  channelDirectory?: Array<{ id: string; name: string; category?: string | null }>;
  loreEntries?: Array<Untyped>;
  currentChannelId?: string | null;
  descriptions?: Map<string, string>;
  neighborDescriptions?: Map<string, string>;
  videos?: Map<string, Untyped>;
  imageAnswers?: Map<string, { question: string; text: string }> | null;
  reads?: Map<string, string>;
  lookup?: {
    query?: string;
    text?: string;
    sources?: Array<Untyped>;
    cached?: boolean;
    server?: {
      text: string | null;
      stretch: { placeId: string; channelName: string | null; startTs: number; lines: string } | null;
      people: Array<Untyped>;
    };
  } | null;
  prefetch?: {
    status: 'ok' | 'none' | 'timeout' | 'unavailable';
    basis: Array<string>;
    excerpts: Array<Untyped>;
  } | null;
  searchAvailable?: boolean;
  recallAvailable?: boolean;
  drawOn?: boolean;
  customEmoji?: Array<{ id: string; name: string; animated?: boolean }>;
  mediaPickText?: string | null;
  mediaCache?: RequestInput['mediaCache'];
  gifs?: RequestInput['gifs'];
  pulled?: Array<PulledChannel> | null;
  source?: { placeId: string; reason: 'routed' | 'noticed' } | null;
  tasks?: {
    part: { index: number; total: number; parts: Array<string> } | null;
    queued: Array<string>;
    queuedOthers?: Array<{ author: string; text: string }>;
    added: Array<string>;
    failedEarlier?: Array<{ author: string; messageId: string; link?: string; at: number; code: string }>;
  } | null;
  elsewhereDestination?: { name: string } | null;
  readOnlyIds?: Set<string> | Array<string>;
  recentLines?: Array<Untyped>;
  recentAudience?: (placeId: string | null) => boolean;
  participation?: {
    state: Untyped;
    pickedIds?: Array<string>;
    audience?: (placeId: string) => boolean;
    channelName?: (placeId: string) => string | null;
  } | null;
  selfreflectionChannel?: string | null;
  selfreflectionChannelIds?: Iterable<string>;
  selfreflection?: {
    posts?: Array<Untyped>;
    plan?: { kind: string | null; brief: string; picture: boolean; topic?: string } | null;
    found?: string | null;
    seeds?: string;
  } | null;
  offPeriods?: Array<{ kind: 'paused' | 'stopped'; from: number; to: number }> | null;
  skillsInventory?: Array<{ name: string; title: string; whenToUse: string; allowed: boolean; reason: string }> | null;
  skillIndex?: string | null;
  toolsGranted?: Array<string> | null;
  toolsBlock?: string | null;
  toolsTokens?: number | null;
  around?: { snapshot: Untyped; channelNameOf?: (placeId: string) => string | null } | null;
  errands?: { list?: string; result?: string } | null;
  intentions?: string | null;
  wake?: string | null;
  wakeKind?: string | null;
  places?: string | null;
  previousThink?: { text: string; relation: 'same' | 'earlier'; ageMs?: number } | null;
  stableFreeze?: Map<string, Untyped> | null;
};

/** One text part of a request's user message; the cache marker is the provider's. */
export type RequestPart = { type: string; text: string; cache_control?: Untyped };

/** A message of a request: its role and its text, whole or as the parts the cache segments cut it into. */
export type RequestMessage = { role: string; content: string | Array<RequestPart> };

export type BuildRequestResult = {
  messages: Array<RequestMessage>;
  stats: Record<string, Untyped>;
  segments: Array<{ segment: 'stable' | 'profiles' | 'tail'; chars: number; hash: string }>;
  idByIndex: Map<number, string>;
  tempo: Untyped;
  handles: Map<string, string> | null;
  channelHandles: Map<string, string> | null;
  pulledIds: Map<string, string>;
  pulledKept: Array<{ placeId: string; ids: Array<string>; newestId: string; newestTs: number }>;
  pulledViews: Array<{ placeId: string; hashes: Map<string, string>; oldestTs: number; oldestId: string | number }>;
  peopleShown: Array<{ id: string; names: Array<string> }>;
  recent: { lines: number; episodes: number; cut: number; hidden: number; repeated: number; unnamed: number } | null;
  seen: { messageIds: Array<string>; parents: Array<string>; parts: { filePreviews: Array<string> } };
  memoryReads: Array<{ kind: string; id: string; block?: string; ord: number }>;
  memberNames: Map<string, Array<string>> | null;
};

export type BuildSelfreflectionPlanRequestInput = {
  /** Whether a place's audience covers the post's readers; a place it refuses is not named. Absent: every place is. */
  placeAudience?: ((placeId: string) => boolean) | null;
  config: Record<string, Untyped>;
  prompts: Record<string, Untyped>;
  calibrator: Untyped;
  now: number;
  selfName: string;
  history?: Array<Untyped>;
  placeMemory?: Untyped;
  channels?: Array<Untyped>;
  loreEntries?: Array<Untyped>;
  currentChannelId?: string | null;
  selfreflectionChannelIds?: Iterable<string>;
  recentLines?: Array<Untyped> | null;
  recentAudience?: ((placeId: string | null) => boolean) | null;
  candidateProfiles?: Array<Untyped>;
  nameOf?: ((id: string) => string | null) | null;
  posts?: Array<Untyped>;
  kinds?: Record<string, number>;
  seedsText?: string;
  topicText?: string;
};
