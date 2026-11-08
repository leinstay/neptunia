// The types of the signatures in ./prompt.ts: the inputs and results that are too long to read inline.

import type { Frame } from '../turn/request/frame.ts';
import type { Mind } from '../memory/db/mind-read.ts';
import type { Lookup as RingLookup } from '../turn/calls.ts';
import type { MeanwhileReads } from '../turn/request/meanwhile.ts';
import type { SurroundingsInput } from '../turn/request/reader.ts';
import type { LineOf, SourceLineOf } from '../turn/request/refs.ts';
import type { BlockRecord } from '../turn/request/tail.ts';
import type { Whereabouts } from '../turn/request/spatial.ts';
import type { Untyped } from '../tools/types.ts';
import type { CallMark } from './lines.ts';
import type { Prompts, RequestConfig, RequestInput } from '../turn/request/types.ts';
import type { sectionCost } from '../llm/budget.ts';

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
  mode: 'reply' | 'interject' | 'inner';
  now: number;
  selfName: string;
  selfId?: string | null;
  history: RequestInput['history'];
  trigger: RequestInput['trigger'];
  triggerKind: string | null;
  taggedCall?: boolean | null;
  placeMemory: RequestInput['placeMemory'];
  interlocutor: RequestInput['interlocutor'];
  dmChat?: { accountId: string } | null;
  privateProfile?: RequestInput['privateProfile'];
  otherProfiles: Array<Untyped>;
  candidateProfiles?: Array<Untyped>;
  nameOf?: (id: string) => string | null;
  currentChannelId?: string | null;
  descriptions?: Map<string, string>;
  videos?: Map<string, Untyped>;
  imageAnswers?: Map<string, { question: string; text: string }> | null;
  reads?: Map<string, string>;
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
  tasks?: {
    part: { index: number; total: number; parts: Array<string> } | null;
    queued: Array<string>;
    queuedOthers?: Array<{ author: string; text: string }>;
    added: Array<string>;
    failedEarlier?: Array<{ author: string; messageId: string; link?: string; at: number; code: string }>;
  } | null;
  elsewhereDestination?: { name: string } | null;
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
  toolsGranted?: Array<string> | null;
  toolsBlock?: string | null;
  toolsTokens?: number | null;
  around?: { snapshot: Untyped; channelNameOf?: (placeId: string) => string | null } | null;
  errands?: { list?: string; result?: string } | null;
  intentions?: string | null;
  wake?: string | null;
  awake?: string | null;
  serviceInner?: { work: string; board: string } | null;
  wakeKind?: string | null;
  previousThink?: { text: string; relation: 'same' | 'earlier'; ageMs?: number } | null;
  myDay?: ReadonlyArray<string> | null;
  callMarks?: ReadonlyArray<CallMark> | null;
  stableFreeze?: Map<string, Untyped> | null;
  whereabouts?: Whereabouts | null;
  /** The facts of the turn (src/turn/request/frame.ts): every request is built on it. */
  frame?: Frame | null;
  /** What the graph reader brought to her mind (src/memory/db/mind-read.ts#mindOf): `<memory>` of the frame's request. */
  mind?: Mind | null;
  /** Her lookups still anchored in this place's window (src/turn/calls.ts#createLookupRing): `<recall>`. */
  lookups?: ReadonlyArray<RingLookup> | null;
  /** The reads of `<meanwhile>`: her lines elsewhere and the lines around them (src/turn/request/meanwhile.ts). */
  meanwhileReads?: MeanwhileReads | null;
  /** The interface's text and the stored fields of the place and its root: `<surroundings>`. */
  surroundings?: SurroundingsInput | null;
  /** Reads a line by its identity under the turn's scope, for the references in stored texts (src/turn/request/refs.ts). */
  refLineOf?: LineOf | null;
  /** Reads the line of a lookup's source by its row, for the sources `<recall>` leaves out (src/turn/request/reader.ts). */
  refSourceLineOf?: SourceLineOf | null;
};

/** One text part of a request's user message; the cache marker is the provider's. */
export type RequestPart = { type: string; text: string; cache_control?: Untyped };

/** A message of a request: its role and its text, whole or as the parts the cache segments cut it into. */
export type RequestMessage = { role: string; content: string | Array<RequestPart> };

export type BuildRequestResult = {
  messages: Array<RequestMessage>;
  stats: Record<string, Untyped>;
  segments: Array<{ segment: 'stable' | 'surroundings' | 'tail'; chars: number; hash: string }>;
  /** Every block of the user message, empty ones too, for the archive row (src/llm/archive.ts). */
  blocks: Array<BlockRecord>;
  idByIndex: Map<number, string>;
  tempo: Untyped;
  handles: Map<string, string> | null;
  channelHandles: Map<string, string> | null;
  pulledIds: Map<string, string>;
  peopleShown: Array<{ id: string; names: Array<string> }>;
  seen: { messageIds: Array<string>; parents: Array<string>; parts: { filePreviews: Array<string> } };
  memoryReads: Array<{ kind: string; id: string; block?: string; ord: number }>;
  memberNames: Map<string, Array<string>> | null;
};
