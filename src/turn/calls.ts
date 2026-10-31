// The persona's skill calls as a turn makes them: who asks for a call, what a call is resolved against, the handles of
// the lines a memory.search quoted, the envelope of a call, the split of an answer into speech and calls, the words of
// a call that failed, the options of the reply request and the in-process caps of the call marks and trigger links.
// src/behavior/turn.js calls them for every answer; the replay's skill scenarios (tools/replay.mjs) and the tests read
// the exported ones through its re-exports.

import { randomUUID } from 'node:crypto';

import { parseToolCallBlocks } from '../llm/tool-text.js';
import { REPLY_REQUEST } from '../llm/openrouter.js';
import { clampWithEllipsis, oneLine } from '../memory/clamp.js';
import type { Snapshot } from '../behavior/snapshot.ts';
import type { CallView } from '../tools/executors.ts';
import { skillRegistry } from '../tools/registry.ts';
import { normalizeCalls } from '../tools/tool-calls.ts';
import type { NormalCall } from '../tools/tool-calls.ts';
import type { SkillMap } from '../tools/types.ts';
import { paceSettings } from './settings.ts';
import { TOO_SLOW } from './timers.ts';

// How many of the persona's posted messages keep the link to their turn's trigger in process
// (far more than two days of her lines; the oldest go first).
export const TRIGGER_LINKS_MAX = 5000;

// How many of the persona's skill calls her transcript lines keep showing, in process (far more
// than two days of them; the oldest go first), and how many of her posts keep the channel of the
// turn that posted them from elsewhere.
export const CALL_MARKS_MAX = 500;
export const POSTED_FROM_MAX = 2000;

/** The values a coded outcome's reason takes (`{status}`, `{what}`), as the journal keeps them so a mark reseeded after a restart words the same. */
export function valuesOf(result: { values?: unknown } | null | undefined): { values?: Record<string, unknown> } {
  const values = result?.values;
  return values && typeof values === 'object' && !Array.isArray(values) && Object.keys(values).length > 0
    ? { values: { ...values } }
    : {};
}

/** Whether a list argument is a list (a JavaScript caller may pass anything). */
function isList<TItem>(value: ReadonlyArray<TItem> | null | undefined): value is ReadonlyArray<TItem> {
  return Array.isArray(value);
}

/** The persona as the principal of her skill calls (src/tools/gateway.ts). */
export const PERSONA = Object.freeze({ kind: 'persona' });

export type Requester = { id: string; roleIds: Array<string> };

/**
 * The requester of a skill call: `trigger`'s author (`{ id, roleIds }`, `roleIds` the ids of the groups
 * the interface says they hold, none when it does not know the member), or null when nobody
 * asked (a turn without a trigger author). Exported for the replay's skill scenarios
 * (tools/replay.mjs `--skills`), which build their requester exactly so. `trigger` is `{ authorId?: string }` or
 * null, `roleIds` a list of group ids.
 */
export function requesterOf(
  trigger: { authorId?: string | number | null } | null | undefined,
  roleIds: ReadonlyArray<string | number> = []
): Requester | null {
  if (!trigger?.authorId) return null;
  return { id: String(trigger.authorId), roleIds: roleIds.map(String) };
}

/** A line a memory.search of the turn quoted, as its handle resolves it. */
export type SearchRef = {
  n: number;
  id: string | number;
  channelId?: string | null;
  authorId?: string | null;
  self?: boolean;
  deleted?: boolean;
  message?: unknown;
};

/** The turn's registry of the lines a memory.search quoted (`draft.searchRefs`). */
export type SearchRefs = {
  base: number;
  next: number;
  byNumber: Map<number, SearchRef>;
  byId: Map<string, SearchRef>;
};

/** A store of the memory, as far as a call view reads it. */
type ViewStore = {
  listChannels?: (
    guildId: string
  ) => ReadonlyArray<{ id?: string | number | null; name?: unknown } | null> | null | undefined;
  listUserProfiles?: (guildId: string) => CallView['members'] | null | undefined;
};

/**
 * What a `<call>` of the persona is resolved against (src/tools/executors.ts#resolveCall), read
 * now: the turn's channel as the current conversation, the channels she can name (the conversations of the
 * turn's `snapshot`, then the stored channel notes, the turn's own channel; where she may act is the
 * operation's rule, src/tools/impl/shared.ts#postingConversation), this turn's transcript numbers (`idByIndex`;
 * a pulled line lives in its own channel, `pulledIds`; its author from `lines`), the stored
 * profiles (only with memory on), her own id (`selfId`), the community's groups, the request's channel
 * handles (`channelHandles`: handle -> channel id, a `#handle` resolved exactly before any name), the request's
 * member handles (`memberHandles`: handle -> member id, her `@handle` in a member argument) and the skill registry
 * (`skills`: a skill's options are resolved by its dispatch), `searchRefs` (the turn's quoted lines
 * of a memory.search, searchHandles), and `fileOf` (a file handle
 * of one of her errands -> the file, null when this conversation may not use it), and `triggerText` (the
 * trigger message's text: a channel it names may take an errand's file). Reads `store` only. Exported
 * for the replay's skill scenarios, which resolve a call exactly as a live turn does.
 */
// health: allow complexity until 2027-04-01 -- moved whole from src/behavior/turn.js in stage 5a, a pure move
export function callViewOf({
  channel,
  snapshot = null,
  guildId,
  idByIndex,
  lines,
  pulledIds,
  memoryOn,
  store,
  selfId,
  skills,
  channelHandles = null,
  memberHandles = null,
  fileOf = null,
  triggerText = null,
  deletedIds = null,
  searchRefs = null,
}: {
  channel: { id: string | number; name?: unknown; communityId?: string | null };
  snapshot?: Snapshot | null;
  guildId?: string | null;
  idByIndex?: ReadonlyMap<number, string> | null;
  lines?: ReadonlyArray<{ id?: unknown; authorId?: string | null; self?: unknown; deleted?: unknown }> | null;
  pulledIds?: ReadonlyMap<string, string> | null;
  memoryOn?: boolean;
  store?: ViewStore | null;
  selfId?: string | null;
  skills?: SkillMap;
  channelHandles?: unknown;
  memberHandles?: unknown;
  fileOf?: CallView['fileOf'] | null;
  triggerText?: unknown;
  deletedIds?: unknown;
  searchRefs?: Pick<SearchRefs, 'base' | 'byNumber'> | null;
}): CallView & { currentConversationId: string } {
  const conversations: Array<{ id: string; name: string }> = [];
  // A private chat shows no channel of the community: only the turn's own.
  const listing = channel?.communityId === null ? null : snapshot;
  for (const entry of listing?.conversations ?? []) {
    if (entry.id && typeof entry.name === 'string') conversations.push({ id: String(entry.id), name: entry.name });
  }
  if (guildId && typeof store?.listChannels === 'function') {
    for (const note of store.listChannels(guildId) ?? [])
      if (note?.id && typeof note.name === 'string') conversations.push({ id: String(note.id), name: note.name });
  }
  if (typeof channel.name === 'string' && channel.name)
    conversations.push({ id: String(channel.id), name: channel.name });
  // The community's groups a skill's role option may name.
  const roles: Array<{ id: string; name: string }> = [];
  for (const group of listing?.groups ?? []) {
    if (group.id && typeof group.name === 'string') roles.push({ id: String(group.id), name: group.name });
  }
  // The request's handle maps and the record's deleted ids hold strings: handle -> id, and message ids.
  return {
    currentConversationId: String(channel.id),
    conversations,
    channelHandles: channelHandles instanceof Map ? (channelHandles as Map<string, string>) : null,
    memberHandles: memberHandles instanceof Map ? (memberHandles as Map<string, string>) : null,
    messageAt: (n) => {
      // A line a memory.search of the turn quoted: its number was numbered on past the request's own.
      const found = searchRefs && n >= searchRefs.base ? searchRefs.byNumber.get(n) : null;
      if (found)
        return {
          id: String(found.id),
          conversationId: String(found.channelId ?? channel.id),
          authorId: found.authorId ?? null,
          self: found.self === true,
          ...(found.deleted === true ? { deleted: true } : {}),
        };
      const id = idByIndex?.get(n);
      if (!id) return null;
      const line = (lines ?? []).find((entry) => entry.id === id);
      return {
        id: String(id),
        conversationId: String(pulledIds?.get(id) ?? channel.id),
        authorId: line?.authorId ?? null,
        self: line?.self === true,
        ...(line?.deleted === true ? { deleted: true } : {}),
      };
    },
    members:
      memoryOn && guildId && typeof store?.listUserProfiles === 'function'
        ? (store.listUserProfiles(guildId) ?? [])
        : [],
    selfId: selfId ?? null,
    roles,
    skills,
    // Messages the record holds as deleted that the history lacks (their ids or links are refused as deleted).
    ...(deletedIds instanceof Set && deletedIds.size > 0 ? { deletedIds: deletedIds as Set<string> } : {}),
    // A file handle of one of her errands (`file:<task id>/<name>`), resolved for this conversation.
    ...(typeof fileOf === 'function' ? { fileOf } : {}),
    // The trigger message's text: a channel it names may take an errand's file.
    ...(typeof triggerText === 'string' && triggerText ? { triggerText } : {}),
  };
}

/** The numbers left free between a request's own lines and the handles of a memory.search of the turn (its later steps add a few lines). */
export const SEARCH_HANDLE_GAP = 20;

/**
 * The turn's registry of the lines a memory.search quoted (`draft.searchRefs`): handles numbered
 * on past the request's own numbering (`draft.handleFloor`, its highest line number, plus
 * SEARCH_HANDLE_GAP, so the steps of the loop, which rebuild the transcript, keep them clear),
 * each resolving to its message (channel and id) for the turn and its loop steps. `next()` is the
 * next free number, `take(shown)` registers the quoted lines the result kept
 * (`{ n, id, channelId, authorId, self, message }`).
 */
export function searchHandles(draft: { searchRefs?: SearchRefs; handleFloor?: number | null }): {
  next(): number;
  advance(n: number): void;
  take(shown: Iterable<SearchRef>): void;
} {
  const registry = () =>
    (draft.searchRefs ??= {
      base: (draft.handleFloor ?? 0) + SEARCH_HANDLE_GAP + 1,
      next: (draft.handleFloor ?? 0) + SEARCH_HANDLE_GAP + 1,
      byNumber: new Map(),
      byId: new Map(),
    });
  return {
    next: () => registry().next,
    advance: (n) => {
      const refs = registry();
      refs.next = Math.max(refs.next, n);
    },
    take: (shown) => {
      const refs = registry();
      for (const ref of shown) {
        refs.byNumber.set(ref.n, ref);
        refs.byId.set(String(ref.id), ref);
        refs.next = Math.max(refs.next, ref.n + 1);
      }
    },
  };
}

/** The skills whose text she writes: a post (`message.create`) or an edit (`message.edit`). */
export const WRITTEN_SKILLS = Object.freeze(['message.create', 'message.edit']);

export type CallEnvelope = Readonly<{
  actor: 'persona';
  requester: Readonly<{ id: string; roleIds: ReadonlyArray<string> }> | null;
  mixed: boolean;
  sourceMessageIds: ReadonlyArray<string>;
  originChannelId: string;
  invocationId: string;
  turnId?: string;
  idempotencyKey?: string;
  ownInitiative?: true;
  chainId?: string;
  wakeKind?: string;
}>;

/**
 * The immutable envelope of the persona's skill call, built by code from the turn, never from
 * what the model wrote: the actor (the persona), the requester (the person who asked for the
 * turn, `requester` -- `/nep message create` -- else the author of the request the turn answers,
 * requesterOf; a recovery turn's trigger is the original candidate, so its author; null when
 * nobody asked), whether the turn answers several people at once (`mixed`: a recovery
 * bundle naming more than one author -- no write then), the source message ids (the trigger and
 * the lines folded into it), the origin channel, and a fresh invocation id the call's journal
 * lines and its operation carry. The follow-up pass inherits it; a tool's output never adds a
 * requester.
 * `turnId` (the journal's turn, else one id per attempt) and `idempotencyKey` (that turn, the call's
 * index and the conversation it acts in, no attempt) go with every call: an errand records the turn, and the
 * same call made twice queues one errand (src/errands/store.ts#add).
 */
export function callEnvelope({
  trigger,
  channel,
  added = null,
  missed = null,
  requester: asked = null,
  requesterGroups = [],
  turnId = null,
  idempotencyKey = null,
  ownInitiative = false,
  chainId = null,
  wakeKind = null,
}: {
  trigger: { id?: string | number | null; authorId?: string | number | null } | null | undefined;
  channel: { id: string | number };
  added?: ReadonlyArray<{ id?: string | number | null } | null> | null;
  missed?: ReadonlyArray<{ author?: unknown } | null> | null;
  requester?: { id?: string | number | null; roleIds?: ReadonlyArray<string | number> | null } | null;
  requesterGroups?: ReadonlyArray<string | number>;
  turnId?: string | number | null;
  idempotencyKey?: string | number | null;
  ownInitiative?: boolean;
  chainId?: string | number | null;
  wakeKind?: string | null;
}): CallEnvelope {
  const requester = asked?.id
    ? {
        id: String(asked.id),
        roleIds: isList(asked.roleIds) ? asked.roleIds.map(String) : [],
      }
    : requesterOf(trigger, requesterGroups);
  const authors = new Set(
    (isList(missed) ? missed : []).map((line) => line?.author).filter((author) => typeof author === 'string' && author)
  );
  const sources = [trigger?.id, ...(isList(added) ? added.map((line) => line?.id) : [])].filter(Boolean).map(String);
  return Object.freeze({
    actor: 'persona',
    requester: requester ? Object.freeze({ id: requester.id, roleIds: Object.freeze([...requester.roleIds]) }) : null,
    mixed: authors.size > 1,
    sourceMessageIds: Object.freeze(sources),
    originChannelId: String(channel.id),
    invocationId: randomUUID(),
    // The turn whose call this is and the call's index in it: one errand per call, whatever retries.
    ...(turnId ? { turnId: String(turnId) } : {}),
    ...(idempotencyKey ? { idempotencyKey: String(idempotencyKey) } : {}),
    // An inner turn: her own initiative, nobody asked (src/tools/executors.ts#executeCall), and
    // its causal chain (which of her candidates it may accept, src/intentions/model.ts#acceptRefusal).
    ...(ownInitiative
      ? {
          ownInitiative: true,
          ...(chainId ? { chainId: String(chainId) } : {}),
          ...(wakeKind ? { wakeKind: String(wakeKind) } : {}),
        }
      : {}),
  });
}

/** The skill registry a runner checks against when none is injected: every operation's (src/tools/registry.ts). */
export function defaultSkills(): SkillMap {
  return skillRegistry();
}

/**
 * One answer of the model split into its speech and its tool calls. Native: the speech text is `completion.text` and
 * the calls are `completion.toolCalls`. Text: the calls are the `<tool_call>` blocks of the text (src/llm/tool-text.js)
 * and the speech text is what is left of it. The calls come out as records, ids made unique within the answer
 * (src/tools/tool-calls.ts#normalizeCalls; `step` numbers them `s<step>c<n>`, 1 for the reply's answer). Pure.
 */
export function answerOf(
  completion: { text?: unknown; toolCalls?: ReadonlyArray<unknown> | null; finishReason?: string | null } | null,
  {
    transport = 'native',
    step = 1,
    registry = skillRegistry(),
  }: { transport?: 'native' | 'text'; step?: number; registry?: SkillMap } = {}
): { rawText: string; speechText: string; calls: Array<NormalCall> } {
  const rawText = typeof completion?.text === 'string' ? completion.text : '';
  const finishReason = completion?.finishReason ?? null;
  if (transport === 'text') {
    const found = parseToolCallBlocks(rawText, { finishReason });
    return {
      rawText,
      speechText: found.rest,
      calls: normalizeCalls({ calls: found.calls, transport, finishReason, step, registry }),
    };
  }
  return {
    rawText,
    speechText: rawText,
    calls: normalizeCalls({ calls: completion?.toolCalls ?? [], transport, finishReason, step, registry }),
  };
}

/** How many things her speech holds that a step may post or hold: messages, reactions, the GIF, the picture, an inner turn's lowered calls. */
export function speechItemsOf(
  parsed:
    | {
        messages?: ReadonlyArray<unknown> | null;
        reactions?: ReadonlyArray<unknown> | null;
        gif?: unknown;
        draw?: unknown;
        loweredCalls?: ReadonlyArray<unknown> | null;
      }
    | null
    | undefined
): number {
  return (
    (parsed?.messages?.length ?? 0) +
    (parsed?.reactions?.length ?? 0) +
    (parsed?.gif ? 1 : 0) +
    (parsed?.draw ? 1 : 0) +
    (parsed?.loweredCalls?.length ?? 0)
  );
}

/** The statuses of a call that did not go well, as a `callFailed` fact names them. */
export const CALL_STATUS_NAMES: ReadonlySet<unknown> = new Set([
  'failed',
  'partial',
  'invalid',
  'denied',
  'not_configured',
  'refused',
  'unknown',
  'timeout',
]);

/** The operation's own words of a call that did not work, as `{ text }` (one line, cut to `tools.markTextMaxChars`), or {}. */
export function callTextOf(
  result: { data?: { text?: unknown } | null } | null | undefined,
  maxChars = 200
): { text?: string } {
  const text = clampWithEllipsis(oneLine(typeof result?.data?.text === 'string' ? result.data.text : ''), maxChars);
  return text ? { text } : {};
}

/**
 * `{ iface }` naming the interface of the conversation the attempt answers (`draft.info`, set by its preflight), for
 * the usage line's interface; nothing before the preflight read it. Never part of the request body.
 */
export function ifaceOption(draft: { info?: { iface?: string } | null }): { iface?: string } {
  const iface = draft.info?.iface;
  return typeof iface === 'string' && iface !== '' ? { iface } : {};
}

/**
 * The reply request's options (role `core`, purpose `reply`): with a bar, each attempt's timeout is the smaller of
 * llm.timeoutMs and the time left, and the bar's signal aborts it; nothing is asked once no time is left. With a bar the
 * request is also hedged (pace.replyHedgeMs): no answer by then, a second identical request is sent and the first answer
 * wins, the whole call still cut at the same timeout. A journalled attempt tells its collector what it hit, and every
 * attempt names its interface (ifaceOption).
 */
export function replyOptionsOf(
  config: { llm?: { timeoutMs?: unknown } | null } & Record<string, unknown>,
  {
    draft,
    bar,
    barAbort,
  }: {
    draft: { started?: unknown; limits?: unknown; info?: { iface?: string } | null };
    bar: { leftMs(): number | null };
    barAbort: AbortController;
  }
): Record<string, unknown> {
  const journalLimits = { ...(draft.started ? { limits: draft.limits } : {}), ...ifaceOption(draft) };
  const left = bar.leftMs();
  if (left === null) return { ...REPLY_REQUEST, ...journalLimits };
  // The bar's signal: a symbol runTurnOnce catches, never an error.
  // eslint-disable-next-line @typescript-eslint/only-throw-error
  if (left <= 0) throw TOO_SLOW;
  const configured = config.llm?.timeoutMs;
  const timeoutMs =
    typeof configured === 'number' && Number.isFinite(configured) && configured > 0 ? Math.min(configured, left) : left;
  const hedgeMs = paceSettings(config).replyHedgeMs;
  const hedge = hedgeMs !== null && hedgeMs < timeoutMs ? { hedge: { afterMs: hedgeMs, timeoutMs } } : {};
  return { ...REPLY_REQUEST, timeoutMs, signal: barAbort.signal, ...hedge, ...journalLimits };
}
