// The persona's skill calls as a turn makes them: who asks for a call, what a call is resolved against, the handles of
// the lines a memory.search quoted, the envelope of a call, the split of an answer into speech and calls, the words of
// a call that failed, the options of the reply request and the in-process caps of the call marks and trigger links.
// src/behavior/turn.ts calls them for every answer; the replay's skill scenarios (scripts/replay.ts) and the tests read
// the exported ones through its re-exports.

import type { Chat } from '../protocol/events.ts';
import { randomUUID } from 'node:crypto';
import type { StoredSourceRef } from '../memory/db/recall.ts';

import { parseToolCallBlocks } from '../llm/tool-text.ts';
import { REPLY_REQUEST } from '../llm/openrouter.ts';
import { thinkLeakOf } from '../llm/parse.ts';
import { clampWithEllipsis, oneLine } from '../memory/clamp.ts';
import { CHANNEL_HANDLE_PREFIX, idText, widenHandles } from '../behavior/handles.ts';
import { readablePlaces } from '../behavior/readable-places.ts';
import type { Snapshot } from '../behavior/snapshot.ts';
import type { ChatInfo } from '../protocol/adapter.ts';
import type { CallView } from '../tools/executors.ts';
import { toolsWith } from '../tools/definitions.ts';
import { skillRegistry } from '../tools/registry.ts';
import { normalizeCalls } from '../tools/tool-calls.ts';
import type { NormalCall } from '../tools/tool-calls.ts';
import type { SkillMap } from '../tools/types.ts';
import { paceSettings } from './settings.ts';
import { TOO_SLOW } from './timers.ts';
import { targetOfSource } from './handles.ts';
import type { Handles } from './handles.ts';

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
 * (scripts/replay.ts `--skills`), which build their requester exactly so. `trigger` is `{ authorId?: string }` or
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
  stored?: StoredSourceRef;
  n: number;
  id: string | number;
  placeId?: string | null;
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
  bySourceId?: Map<string, SearchRef>;
};

/** A stored channel or thread a `#handle` may name: its place id and its native id, null when its row holds none. */
export type KnownPlace = { readonly id: string; readonly nativeId: string | null };

/** A store of the memory, as far as a call view reads it. */
type ViewStore = {
  listChannels?: (
    placeId: string
  ) => ReadonlyArray<{ id?: string | number | null; name?: unknown } | null> | null | undefined;
  listUserProfiles: () => CallView['members'] | null | undefined;
};

/**
 * The channel handles a call resolves: `shown` (the request's, handle -> channel id) and, behind it, the handle of
 * every channel of `chatIds` (the turn's own, by native id) and of every place of `knownPlaces` (the memory's channels
 * and threads of every interface, by place id with its stored native id; a place without one has no channel handle), a
 * handle two ids share left out (widenHandles). A native id of a known place outside the turn's chats becomes that
 * place's id, the form a call names a place on any interface in; a native id two known places share stays as it is.
 * Pure.
 */
function callChannelHandles(
  shown: ReadonlyMap<string, string>,
  chatIds: ReadonlyArray<string>,
  knownPlaces: ReadonlyArray<KnownPlace>
): Map<string, string> {
  const chats = new Set(chatIds);
  const placeOfNative = new Map<string, string | null>();
  for (const { id, nativeId } of knownPlaces) {
    if (nativeId === null || chats.has(nativeId)) continue;
    const before = placeOfNative.get(nativeId);
    placeOfNative.set(nativeId, before === undefined || before === id ? id : null);
  }
  const unique = [...placeOfNative].flatMap(([native, id]) => (id === null ? [] : [native]));
  const widened = widenHandles(shown, [...chats, ...unique], CHANNEL_HANDLE_PREFIX);
  for (const [handle, id] of widened) widened.set(handle, placeOfNative.get(id) ?? id);
  return widened;
}

/**
 * What a `<call>` of the persona is resolved against (src/tools/executors.ts#resolveCall), read
 * now: the turn's channel as the current chat, the channels she can name (the chats of the
 * turn's `snapshot`, then the stored channel notes, the turn's own channel; where she may act is the
 * operation's rule, src/tools/operations/shared.ts#postingChat), this turn's transcript numbers (`idByIndex`;
 * a pulled line lives in its own channel, `pulledIds`; its author from `lines`), the stored
 * profiles (only with memory on), her own id (`selfId`), the root's groups, the request's channel
 * handles (`channelHandles`: handle -> channel id, a `#handle` resolved exactly before any name, widened over the
 * turn's chats and `knownPlaces`, callChannelHandles), the request's
 * member handles (`memberHandles`: handle -> member id, her `@handle` in a member argument) and the skill registry
 * (`skills`: a skill's options are resolved by its dispatch), `places` (the channels a read call may name, from the
 * snapshot by the pull rail with `partnerId` as the reader of a private chat or the command line; left out without a
 * `config` or a snapshot), `stem` (the loaded stemmer, `stem` as given), `placesNamed` (the name index of the memory under the turn's context), `placesFound` (the places the memory graph ranks for words that name no place, under the turn's context), `placeRef` (a stored place by its id, so a place id of any shape names its place), `searchRefs` (the turn's quoted lines
 * of a memory.search, searchHandles), and `fileOf` (a file handle
 * of one of her errands -> the file, null when this chat may not use it), and `triggerText` (the
 * trigger message's text: a channel it names may take an errand's file). Reads `store` only. Exported
 * for the replay's skill scenarios, which resolve a call exactly as a live turn does.
 */
// health: allow complexity until 2027-04-01 -- moved whole from src/behavior/turn.ts in stage 5a, a pure move
export function callViewOf({
  channel,
  currentIface,
  snapshot = null,
  placeId,
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
  partnerId = null,
  config = null,
  stem = null,
  placesNamed = null,
  placesFound = null,
  placeRef = null,
  findMeaning = null,
  knownPlaces = null,
}: {
  // The interface's description of the chat: a private chat (`rootId` null) lists no channels.
  channel: Pick<Chat, 'rootId'> & { id: string | number; name?: unknown };
  currentIface?: string;
  snapshot?: Snapshot | null;
  placeId?: string | null;
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
  partnerId?: string | null;
  config?: Record<string, unknown> | null;
  stem?: ((word: string) => string) | null;
  placesNamed?: CallView['placesNamed'];
  placesFound?: CallView['placesFound'];
  placeRef?: CallView['placeRef'];
  findMeaning?: CallView['findMeaning'];
  // The memory's channels and threads on every interface with their native ids (frame-reads.ts#chatPlacesOf).
  knownPlaces?: ReadonlyArray<KnownPlace> | null;
}): CallView & { currentChatId: string } {
  const chats: Array<{ id: string; name: string }> = [];
  // A private chat shows no channel of the root: only the turn's own.
  const listing = channel?.rootId === null ? null : snapshot;
  for (const entry of listing?.chats ?? []) {
    if (entry.id && typeof entry.name === 'string') chats.push({ id: String(entry.id), name: entry.name });
  }
  if (placeId && typeof store?.listChannels === 'function') {
    for (const note of store.listChannels(placeId) ?? [])
      if (note?.id && typeof note.name === 'string') chats.push({ id: String(note.id), name: note.name });
  }
  if (typeof channel.name === 'string' && channel.name) chats.push({ id: String(channel.id), name: channel.name });
  // The channels a read call may name: the pull rail's verdict over the snapshot, a private chat's too.
  const places =
    config && snapshot
      ? readablePlaces({
          snapshot,
          destination: channel as ChatInfo,
          partnerId,
          config,
          handles: channelHandles instanceof Map ? (channelHandles as Map<string, string>) : null,
        })
      : null;
  const members =
    memoryOn && placeId && typeof store?.listUserProfiles === 'function' ? (store.listUserProfiles() ?? []) : [];
  // The request's handle maps and the record's deleted ids hold strings: handle -> id, and message ids. Behind each, the
  // handle of every channel and member the view knows, for a handle she carries from an earlier request.
  const shownChannels = channelHandles instanceof Map ? (channelHandles as Map<string, string>) : null;
  const shownMembers = memberHandles instanceof Map ? (memberHandles as Map<string, string>) : null;
  return {
    currentChatId: String(channel.id),
    currentIface,
    chats,
    ...(places ? { places } : {}),
    ...(stem ? { stem } : {}),
    ...(placesNamed ? { placesNamed } : {}),
    ...(placesFound ? { placesFound } : {}),
    ...(placeRef ? { placeRef } : {}),
    ...(findMeaning ? { findMeaning } : {}),
    channelHandles: shownChannels
      ? callChannelHandles(
          shownChannels,
          chats.map((chat) => chat.id),
          knownPlaces ?? []
        )
      : null,
    memberHandles: shownMembers
      ? widenHandles(
          shownMembers,
          members.flatMap((member) => idText(member?.id))
        )
      : null,
    messageAt: (n) => {
      // A line a memory.search of the turn quoted: its number was numbered on past the request's own.
      const found = searchRefs && n >= searchRefs.base ? searchRefs.byNumber.get(n) : null;
      const storedNative = found?.stored?.native;
      if (found)
        return {
          id: String(found.id),
          stored: found.stored,
          native:
            storedNative ??
            (!found.stored && currentIface
              ? {
                  iface: currentIface,
                  chatId: String(found.placeId ?? channel.id),
                  messageId: String(found.id),
                }
              : undefined),
          chatId: storedNative?.chatId ?? String(found.placeId ?? channel.id),
          authorId: found.authorId ?? null,
          self: found.self === true,
          ...(found.deleted === true ? { deleted: true } : {}),
        };
      const id = idByIndex?.get(n);
      if (!id) return null;
      const line = (lines ?? []).find((entry) => entry.id === id);
      return {
        id: String(id),
        native: currentIface
          ? { iface: currentIface, chatId: String(pulledIds?.get(id) ?? channel.id), messageId: String(id) }
          : undefined,
        chatId: String(pulledIds?.get(id) ?? channel.id),
        authorId: line?.authorId ?? null,
        self: line?.self === true,
        ...(line?.deleted === true ? { deleted: true } : {}),
      };
    },
    members,
    selfId: selfId ?? null,
    skills,
    // Messages the record holds as deleted that the history lacks (their ids or links are refused as deleted).
    ...(deletedIds instanceof Set && deletedIds.size > 0 ? { deletedIds: deletedIds as Set<string> } : {}),
    // A file handle of one of her errands (`file:<task id>/<name>`), resolved for this chat.
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
 * (`{ n, id, placeId, authorId, self, message }`).
 */
export function searchHandles(draft: {
  searchRefs?: SearchRefs;
  handleFloor?: number | null;
  handles?: Handles | null;
}): {
  next(): number;
  advance(n: number): void;
  take(shown: Iterable<SearchRef>): void;
} {
  const registry = (): SearchRefs =>
    (draft.searchRefs ??= {
      base: (draft.handleFloor ?? 0) + SEARCH_HANDLE_GAP + 1,
      next: (draft.handleFloor ?? 0) + SEARCH_HANDLE_GAP + 1,
      byNumber: new Map(),
      byId: new Map(),
      bySourceId: new Map(),
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
        const sameId = [...refs.byNumber.values()].filter((entry) => String(entry.id) === String(ref.id));
        const identities = new Set(
          sameId.map((entry) => entry.stored?.sourceId ?? JSON.stringify([entry.placeId, entry.id]))
        );
        if (identities.size === 1) refs.byId.set(String(ref.id), ref);
        else refs.byId.delete(String(ref.id));
        if (ref.stored) (refs.bySourceId ??= new Map()).set(ref.stored.sourceId, ref);
        refs.next = Math.max(refs.next, ref.n + 1);
        // The turn's one registry holds the handle too, so a reference to it in her stored words reads back.
        const stored = ref.stored;
        if (stored && draft.handles)
          draft.handles.take(ref.n, 'search', targetOfSource(stored, String(stored.native?.messageId ?? ref.id)));
      }
    },
  };
}

/** The skills whose text she writes, a post or an edit: the trait `written` of their definitions. */
export const WRITTEN_SKILLS = toolsWith('written');

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
 * bundle naming more than one author), the source message ids (the trigger and
 * the lines folded into it), the origin channel, and a fresh invocation id the call's journal
 * lines and its operation carry. The follow-up pass inherits it; a tool's output never adds a
 * requester.
 * `turnId` (the journal's turn, else one id per attempt) and `idempotencyKey` (that turn, the call's
 * index and the chat it acts in, no attempt) go with every call: an errand records the turn, and the
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
 * the calls are `completion.toolCalls`. Text: the calls are the `<tool_call>` blocks of the text (src/llm/tool-text.ts)
 * and the speech text is what is left of it. The calls come out as records, ids made unique within the answer
 * (src/tools/tool-calls.ts#normalizeCalls; `step` numbers them `s<step>c<n>`, 1 for the reply's answer). Pure.
 */
export function answerOf(
  completion: { text?: unknown; toolCalls?: ReadonlyArray<unknown> | null; finishReason?: string | null } | null,
  {
    transport = 'native',
    step = 1,
    registry = skillRegistry(),
    procedures = null,
  }: {
    transport?: 'native' | 'text';
    step?: number;
    registry?: SkillMap;
    /** Her skills the tools array offered, by name (src/tools/tool-calls.ts#normalizeCalls). */
    procedures?: ReadonlyMap<string, unknown> | null;
  } = {}
): { rawText: string; speechText: string; calls: Array<NormalCall> } {
  const rawText = typeof completion?.text === 'string' ? completion.text : '';
  const finishReason = completion?.finishReason ?? null;
  if (transport === 'text') {
    const found = parseToolCallBlocks(rawText, { finishReason });
    return {
      rawText,
      speechText: found.rest,
      calls: normalizeCalls({ calls: found.calls, transport, finishReason, step, registry, procedures }),
    };
  }
  return {
    rawText,
    speechText: rawText,
    calls: normalizeCalls({ calls: completion?.toolCalls ?? [], transport, finishReason, step, registry, procedures }),
  };
}

/**
 * Whether a completion is an answer whose `<think>` leaked (src/llm/parse.ts#thinkLeakOf), which is never acted on. An unclosed
 * think cut at the output cap is no leak: that answer ends on the cut-off path.
 */
export function answerLeaked(
  completion: Parameters<typeof answerOf>[0],
  options: NonNullable<Parameters<typeof answerOf>[1]>
): boolean {
  const leak = thinkLeakOf(answerOf(completion, options).speechText);
  return leak === 'unopened' || (leak === 'unclosed' && completion?.finishReason !== 'length');
}

/**
 * One request of a turn under the think standard: `ask` runs once more when its answer leaked, with `onLeak` called per leak.
 * `ended`: the second answer leaked too, so the turn ends here and nothing of `completion` is acted on.
 */
export async function askUnleaked<TCompletion>(
  ask: () => Promise<TCompletion>,
  leaked: (completion: TCompletion) => boolean,
  onLeak: () => void
): Promise<{ completion: TCompletion; ended: boolean }> {
  const completion = await ask();
  if (!leaked(completion)) return { completion, ended: false };
  onLeak();
  const again = await ask();
  if (!leaked(again)) return { completion: again, ended: false };
  onLeak();
  return { completion: again, ended: true };
}

/** How many things her speech holds that a step may post or hold: messages, reactions, the picture, an inner turn's lowered calls. */
export function speechItemsOf(
  parsed:
    | {
        messages?: ReadonlyArray<unknown> | null;
        reactions?: ReadonlyArray<unknown> | null;
        draw?: unknown;
        loweredCalls?: ReadonlyArray<unknown> | null;
      }
    | null
    | undefined
): number {
  return (
    (parsed?.messages?.length ?? 0) +
    (parsed?.reactions?.length ?? 0) +
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

/** The length of an operation's own words on a call mark. Production value, config cut of 2026-10-31. */
export const MARK_TEXT_CHARS = 200;

/** The operation's own words of a call that did not work, as `{ text }` (one line, cut to `maxChars`), or {}. */
export function callTextOf(
  result: { data?: { text?: unknown } | null } | null | undefined,
  maxChars = MARK_TEXT_CHARS
): { text?: string } {
  const text = clampWithEllipsis(oneLine(typeof result?.data?.text === 'string' ? result.data.text : ''), maxChars);
  return text ? { text } : {};
}

/**
 * `{ iface }` naming the interface of the chat the attempt answers (`draft.info`, set by its preflight), for
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

/**
 * One lookup of hers (a call of a read tool such as `memory.search`), as `<recall>` renders it on the next turns of the
 * place it was made in: the turn and the time, the tool and its arguments, the place called from, the status, a bounded
 * extract of the result with the source ids it quotes, and the messages that anchor it to the window.
 */
export type Lookup = {
  turnId: string;
  at: number;
  tool: string;
  args: Record<string, unknown>;
  place: { id: string; path: Array<string> };
  status: string;
  extract: string;
  sourceIds: Array<string>;
  anchorMessageIds: Array<string>;
};

/** The settings a lookup is noted under (`context.recall`). */
export type LookupSettings = { maxItems: number; extractChars: number };

/** A line of the window a lookup is anchored in: its id and the id of the line it replies to. */
export type WindowLine = { id: string; replyTo: string | null };

/** The ring of her lookups per place. */
export type LookupRing = {
  /** Keeps `lookup`, replacing an earlier one of the same tool and arguments in its place, under `settings`. */
  note(lookup: Lookup, settings: LookupSettings): void;
  /**
   * The lookups of `placeId` still anchored in `window`: a line that replies to an anchor becomes an anchor itself, and a
   * lookup none of whose anchors is in the window leaves the ring.
   */
  forPlace(placeId: string, window: ReadonlyArray<WindowLine>, now: number): Array<Lookup>;
  /** Removes the one lookup of `placeId` with this tool and these arguments. */
  drop(placeId: string, tool: string, args: Record<string, unknown>): void;
  /** Makes `toId` an anchor of every lookup anchored at `fromId`: her line posted in answer to a lookup's trigger. */
  follow(fromId: string, toId: string): void;
};

/** `value` as JSON with every object's keys sorted, so the same arguments in another order give the same text. */
function sortedJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(sortedJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${sortedJson(Reflect.get(value, key))}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

const lookupKey = (tool: string, args: Record<string, unknown>): string => `${tool}\u0000${sortedJson(args)}`;

/**
 * A ring of her lookups, seeded with `seed` (the journal's lookups of the last days, oldest first, src/memory/journal.ts):
 * one entry per place, tool and arguments, at most `maxItems` per place with the one noted earliest dropped first, each
 * extract cut to `extractChars`. In process.
 */
export function createLookupRing(seed: ReadonlyArray<Lookup>): LookupRing {
  const byPlace = new Map<string, Map<string, Lookup>>();
  const placeOf = (placeId: string): Map<string, Lookup> => {
    let entries = byPlace.get(placeId);
    if (!entries) byPlace.set(placeId, (entries = new Map<string, Lookup>()));
    return entries;
  };
  const keep = (lookup: Lookup, maxItems: number): void => {
    const entries = placeOf(lookup.place.id);
    const key = lookupKey(lookup.tool, lookup.args);
    entries.delete(key);
    entries.set(key, { ...lookup, anchorMessageIds: [...new Set(lookup.anchorMessageIds)] });
    for (const oldest of entries.keys()) {
      if (entries.size <= Math.max(0, maxItems)) break;
      entries.delete(oldest);
    }
  };
  for (const lookup of seed) keep(lookup, Number.MAX_SAFE_INTEGER);
  return {
    note(lookup, { maxItems, extractChars }) {
      const extract = clampWithEllipsis(lookup.extract, Math.max(1, extractChars));
      keep({ ...lookup, extract }, maxItems);
    },
    forPlace(placeId, window) {
      const entries = byPlace.get(placeId);
      if (!entries) return [];
      const ids = new Set(window.map((line) => line.id));
      const kept: Array<Lookup> = [];
      for (const [key, lookup] of entries) {
        const anchors = new Set(lookup.anchorMessageIds);
        for (const line of window) if (line.replyTo !== null && anchors.has(line.replyTo)) anchors.add(line.id);
        if (![...anchors].some((id) => ids.has(id))) {
          entries.delete(key);
          continue;
        }
        const anchored = { ...lookup, anchorMessageIds: [...anchors] };
        entries.set(key, anchored);
        kept.push(anchored);
      }
      return kept;
    },
    drop(placeId, tool, args) {
      byPlace.get(placeId)?.delete(lookupKey(tool, args));
    },
    follow(fromId, toId) {
      for (const entries of byPlace.values())
        for (const [key, lookup] of entries)
          if (lookup.anchorMessageIds.includes(fromId) && !lookup.anchorMessageIds.includes(toId))
            entries.set(key, { ...lookup, anchorMessageIds: [...lookup.anchorMessageIds, toId] });
    },
  };
}

/** `context.recall`, read now: how many lookups a place keeps and how long an extract is. */
export function lookupSettingsOf(config: unknown): LookupSettings {
  const context: unknown = config && typeof config === 'object' ? Reflect.get(config, 'context') : null;
  const given: unknown = context && typeof context === 'object' ? Reflect.get(context, 'recall') : null;
  const read = (key: string, fallback: number): number => {
    const value: unknown = given && typeof given === 'object' ? Reflect.get(given, key) : undefined;
    return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback;
  };
  return { maxItems: read('maxItems', 6), extractChars: read('extractChars', 1200) };
}

/** The plain arguments of a call (text, numbers, booleans), the ones a lookup is told apart by. */
function plainArgs(args: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(args).filter(([, value]) => ['string', 'number', 'boolean'].includes(typeof value))
  );
}

/**
 * The lookup a call of a read tool is, to be kept for `<recall>`: null for any other call, a call with no place to be
 * read back in, or a turn with no id. The result's text is its extract, the turn's trigger its first anchor.
 */
export function lookupOfCall(call: {
  read: boolean;
  place: { id: string; path: Array<string> } | null;
  turnId: string | null | undefined;
  at: number;
  tool: string;
  args: Record<string, unknown>;
  status: string;
  text: unknown;
  sourceIds: ReadonlyArray<string>;
  anchorIds: ReadonlyArray<string | null | undefined>;
}): Lookup | null {
  if (!call.read || call.place === null || !call.turnId) return null;
  return {
    turnId: call.turnId,
    at: call.at,
    tool: call.tool,
    args: plainArgs(call.args),
    place: call.place,
    status: call.status,
    extract: typeof call.text === 'string' ? call.text : '',
    sourceIds: [...call.sourceIds],
    anchorMessageIds: call.anchorIds.filter((id): id is string => typeof id === 'string' && id !== ''),
  };
}
