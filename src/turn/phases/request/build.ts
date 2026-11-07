// The last step of a turn's request: her tools for the turn, the request input with every block named, the request
// built (twice for a heartbeat whose handles follow the request's own lines), the record of the memory rows it carried
// and what of the window the journal names as seen. The request phase (src/turn/phases/request.ts) runs it last.

import { pageReads } from '../../../memory/db/retrieve.ts';
import { accountOf, personOfMember, placeOfConversation } from '../../../memory/addresses.ts';
import { buildRequest } from '../../../behavior/prompt.ts';
import { NO_PLACES, selfreflectionConversationIds, publicationPlaces, readMirrors } from '../../../behavior/mirror.ts';
import { turnRequestInput } from '../../../behavior/turn-input.ts';
import { wakeBlockText } from '../../../behavior/wake.ts';
import { budgetDrops } from '../../../llm/budget.ts';
import { toolsBlockText } from '../../../llm/tool-text.ts';
import { estimateTools } from '../../../llm/tokens.ts';
import { log } from '../../../log.ts';
import { PERSONA_ID } from '../../../memory/db/storage-keys.ts';
import { exposedSkillNames } from '../../../tools/discovery.ts';
import { buildTools } from '../../../tools/tools-json.ts';
import { SEARCH_HANDLE_GAP, defaultSkills, searchHandles } from '../../calls.ts';
import { portMediaPick } from '../../../interface/capabilities.ts';
import type { SearchRef } from '../../calls.ts';
import type { Draft } from '../../draft.ts';
import { droppedSections } from '../../journal.ts';
import { pickOtherProfiles } from '../../mentions.ts';
import { channelDirectoryOf } from '../../routing.ts';
import { frameOf, framedRequest } from '../../request/frame.ts';
import type { Frame, FrameParty } from '../../request/frame.ts';
import { whereaboutsOfFrame } from '../../request/spatial.ts';
import type { PlaceLink } from '../../request/spatial.ts';
import type { PhaseContext, PhaseParams } from '../context.ts';
import type { Opened } from '../preflight.ts';
import type { Gathered } from './gather.ts';
import type { Planned } from './searches.ts';
import type { Pulled } from './pulls.ts';
import type { Setup } from './setup.ts';
import type { Told } from './facts.ts';
import type { Waited } from './wait.ts';
import type { Handles } from '../../handles.ts';
import { accountId, messageSourceId } from '../../../memory/db/ids.ts';
import type { Mind, Seeds } from '../../../memory/db/mind-read.ts';
import type { FrameReads } from '../../../memory/db/frame-reads.ts';
import type { Context } from '../../../memory/db/scope.ts';
import { fill } from '../../../format.ts';
import type { Lookup } from '../../calls.ts';
import type { MeanwhileReads } from '../../request/meanwhile.ts';
import type { SurroundingsInput } from '../../request/reader.ts';
import type { LineOf } from '../../request/refs.ts';
import type { Message } from '../../request/types.ts';

/** The request as buildRequest builds it. */
/** A partner's private layer with what they said in their other linked DMs; null with neither. */
function privateProfileOf(store: PhaseContext['store'], accountId: string): object | null {
  const own = store.getPrivate(accountId) ?? null;
  const linked = Reflect.get(Object(store), 'linkedPrivateOf')
    ? (Reflect.get(Object(store), 'linkedPrivateOf') as (id: string) => Array<object>)(accountId)
    : [];
  if (linked.length === 0) return own;
  const details = Array.isArray(Reflect.get(own ?? {}, 'details'))
    ? (Reflect.get(own ?? {}, 'details') as Array<object>)
    : [];
  return { ...(own ?? {}), details: [...details, ...linked] };
}

export type BuiltRequest = ReturnType<typeof buildRequest>;

/** The wakes that run with no conversation of their own (src/behavior/inner/queue.ts#channelless). */
const OWN_SERVER_WAKES = new Set(['review', 'heartbeat', 'selfimprovement']);

/** How a frame's path names a one-to-one chat. It is a path segment for the code, no text she reads. */
const DM_WORD = 'private';

/**
 * The stored chain of the turn's place, the place first; a place the tree does not hold yet is a chain of itself. A wake
 * with no conversation place (a review, a heartbeat, a selfimprovement wake, or one in the stand-in) has none, whatever
 * channel carries it.
 */
function chainOfTurn(
  store: PhaseContext['store'],
  channel: Opened['channel'],
  wake: { kind: string | null } | null
): ReadonlyArray<PlaceLink> {
  if (wake && (OWN_SERVER_WAKES.has(wake.kind ?? '') || channel.rootId === PERSONA_ID)) return [];
  const placeId = placeOfConversation(store, channel) || String(channel.id ?? '');
  if (!placeId) return [];
  const chainOf: unknown = Reflect.get(Object(store), 'placeChainOf');
  const stored =
    typeof chainOf === 'function' ? (chainOf as (id: string) => ReadonlyArray<PlaceLink>).call(store, placeId) : [];
  return stored.length > 0 ? stored : [{ id: placeId, kind: null, name: null }];
}

/** Somebody the interface names by a native id, as the store holds them. */
function partyOf(store: PhaseContext['store'], nativeId: string, name: string | null): FrameParty {
  return { personId: personOfMember(store, nativeId), accountId: accountOf(store, nativeId), name };
}

/** The frame of a turn, from what the turn runner holds. */
function frameOfTurn(
  store: PhaseContext['store'],
  turn: {
    channel: Opened['channel'];
    isPrivate: boolean;
    mode: string;
    triggerKind: string | null;
    wakeKind: string | null;
    inner: boolean;
    trigger: { id: string; authorId: string; authorName?: string | null } | null;
    now: number;
    timezone: string;
  }
): Frame {
  const { channel, isPrivate, trigger } = turn;
  const authorName = trigger?.authorName ?? null;
  const partnerId = trigger?.authorId ?? (typeof channel.partnerId === 'string' ? channel.partnerId : null);
  return frameOf({
    mode: turn.mode,
    triggerKind: turn.triggerKind,
    wakeKind: turn.wakeKind,
    interface: typeof channel.iface === 'string' ? channel.iface : '',
    chain: chainOfTurn(store, channel, turn.inner ? { kind: turn.wakeKind } : null),
    dm: isPrivate
      ? {
          word: DM_WORD,
          nativeId: partnerId ?? '',
          partner: partnerId === null ? null : partyOf(store, partnerId, authorName),
        }
      : null,
    trigger: trigger ? { messageId: trigger.id, authorId: trigger.authorId } : null,
    author: trigger ? partyOf(store, trigger.authorId, authorName) : null,
    now: turn.now,
    timezone: turn.timezone,
  });
}

/**
 * What she did today under the turn's context, in the labels' words (`labels.myDay`), at most `context.myDay.lines`
 * read now; null on an inner turn, without a reader, a context or a positive number of lines, and on a failed read
 * (logged).
 */
function myDayLines(
  ctx: Pick<PhaseContext, 'myDay' | 'turnContextOf'>,
  turn: { draft: Draft; channel: Opened['channel']; config: Setup['config']; prompts: Gathered['prompts']; now: number }
): Array<string> | null {
  const { draft, channel, config, prompts, now } = turn;
  const settings = config.context;
  const lines = settings?.myDay?.lines;
  const memoryContext = ctx.turnContextOf(draft, channel);
  // An inner turn reads her day in its own view until it moves onto the frame (src/behavior/heartbeat-view.ts#lifeOf).
  if (draft.inner || !ctx.myDay || !memoryContext || typeof lines !== 'number' || lines <= 0) return null;
  const labels = prompts?.labels;
  try {
    const listed = ctx.myDay(memoryContext, now, String(config.bot?.timezone ?? 'UTC'), {
      lines,
      labels: (labels?.myDay as Readonly<Record<string, unknown>> | undefined) ?? null,
    });
    return listed.length > 0 ? listed : null;
  } catch (error) {
    log.warn('turn: my day not read', { channel: channel.id, error });
    return null;
  }
}

/**
 * The numbers `request` printed for its chat lines, reply parents and pulled lines (`idByIndex`, `pulledIds`) taken
 * into the turn's registry, each to its line's source: her own line `said`, anyone else's `seen`, at the revision the
 * line carries (1 when it carries none). A number the registry holds keeps its first line.
 */
function registerHandles(
  handles: Handles,
  request: BuiltRequest,
  lines: ReadonlyArray<{ id?: unknown; self?: unknown; replyParent?: unknown; revision?: unknown } | null | undefined>,
  { iface, placeId }: { iface: string; placeId: string }
): void {
  const byId = new Map(
    lines.filter((line) => line && typeof line.id === 'string').map((line) => [line!.id as string, line!])
  );
  for (const [n, messageId] of request.idByIndex) {
    const line = byId.get(messageId);
    const pulledPlace = request.pulledIds.get(messageId);
    const kind = pulledPlace ? 'pulled' : line?.replyParent === true ? 'parent' : 'chat';
    const revision = typeof line?.revision === 'number' && line.revision > 0 ? line.revision : 1;
    handles.take(n, kind, {
      sourceId: messageSourceId(iface, messageId, revision, line?.self === true ? 'said' : 'seen'),
      placeId: pulledPlace ?? placeId,
      messageId,
      revision,
    });
  }
}

/** What a framed request reads beside the old inputs; each null when the request is not on the frame. */
type FramedInputs = {
  mind: Mind | null;
  lookups: Array<Lookup> | null;
  meanwhileReads: MeanwhileReads | null;
  surroundings: SurroundingsInput | null;
  refLineOf: LineOf | null;
};

const NO_FRAMED: FramedInputs = {
  mind: null,
  lookups: null,
  meanwhileReads: null,
  surroundings: null,
  refLineOf: null,
};

/** The person she answers as the memory stores them: the account row of their platform id and its person. */
function counterpartOf(frame: Frame, reads: Pick<FrameReads, 'account' | 'person'>): Seeds['counterpart'] {
  const them = frame.counterpart;
  const native = frame.answers?.authorId ?? null;
  if (them === null) return null;
  const account = native === null ? null : reads.account(frame.interface, native);
  const person = account === null ? null : reads.person(account);
  return { personId: person ?? them.personId, accountId: account ?? them.accountId };
}

/** The window as the graph reader's seeds: each line by its stored source id, the trigger marked, oldest first. */
function seedsOf(
  frame: Frame,
  history: ReadonlyArray<Message>,
  turn: { trigger: { id: string } | null; prefetch: unknown },
  reads: Pick<FrameReads, 'account' | 'person' | 'source'>
): Seeds {
  const { trigger, prefetch } = turn;
  const iface = frame.interface;
  const lines = history.filter((line) => line.kind !== 'call' && typeof line.id === 'string');
  const sourceOf = (line: Message): string => {
    const revision: unknown = Reflect.get(line, 'revision');
    // The stored line when the memory holds it (an interface's id is not the key a line is stored under), else the
    // id a line of this message would have.
    return (
      reads.source?.(iface, line.id) ??
      messageSourceId(iface, line.id, typeof revision === 'number' ? revision : 1, line.self ? 'said' : 'seen')
    );
  };
  const byId = new Map(lines.map((line) => [line.id, sourceOf(line)]));
  // A platform id as the memory's account row, the spelled form when none is stored yet.
  const accountOf = (native: string): string => reads.account(iface, native) ?? accountId(iface, native);
  const excerpts: unknown = prefetch && typeof prefetch === 'object' ? Reflect.get(prefetch, 'excerpts') : null;
  const hits = (Array.isArray(excerpts) ? excerpts : []).flatMap((excerpt: unknown) => {
    const ids: unknown = excerpt && typeof excerpt === 'object' ? Reflect.get(excerpt, 'hitIds') : null;
    return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string' && id !== '') : [];
  });
  return {
    messages: lines.map((line) => ({
      id: sourceOf(line),
      at: new Date(line.ts).toISOString(),
      authorAccount: line.self || !line.authorId ? null : accountOf(line.authorId),
      placeId: frame.place?.id ?? null,
      replyTo: line.replyToId ? (byId.get(line.replyToId) ?? null) : null,
      mentions: (line.mentionedAccountIds ?? []).map(accountOf),
      text: line.content ?? '',
      trigger: line.id === trigger?.id,
    })),
    counterpart: counterpartOf(frame, reads),
    place: frame.place?.id ?? null,
    previous: [],
    candidates: hits.map((hit) => {
      const id = reads.source?.(iface, hit) ?? hit;
      return { nodeId: `source:${id}`, sourceIds: [id], from: 'prefetch' as const };
    }),
  };
}

/** The interface's name and its words for its kinds of place, worded for `<surroundings>`. */
function interfaceTextOf(names: { name: string | null; nouns: Record<string, string> }, labels: unknown): string {
  const nounsLabel: unknown = labels && typeof labels === 'object' ? Reflect.get(labels, 'surroundings') : null;
  const template: unknown = nounsLabel && typeof nounsLabel === 'object' ? Reflect.get(nounsLabel, 'nouns') : null;
  const nouns = Object.values(names.nouns);
  return [
    names.name ?? '',
    nouns.length > 0 && typeof template === 'string' ? fill(template, { nouns: nouns.join(', ') }) : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/**
 * The inputs of a framed request (a reply or an errand's result): what the graph reader brings to mind, her lookups still
 * anchored here, her lines elsewhere, the place's stored fields and a reader of lines by identity, all under the turn's
 * context. Nothing for any other request, and only the lookups without an open memory. A failed read of the mind is
 * logged and leaves memory empty.
 */
function framedInputsOf(
  ctx: Pick<PhaseContext, 'frameReads' | 'lookupRing' | 'turnContextOf'>,
  frame: Frame,
  draft: Draft,
  channel: Opened['channel'],
  turn: {
    history: ReadonlyArray<Message>;
    trigger: { id: string } | null;
    prefetch: unknown;
    labels: unknown;
    now: number;
  }
): FramedInputs {
  const { history, now } = turn;
  const place = frame.place;
  if (!framedRequest(frame) || place === null) return NO_FRAMED;
  draft.framePlace = { id: String(channel.id), path: [...place.path] };
  const window = history.map((line) => ({ id: String(line.id), replyTo: line.replyToId ?? null }));
  const lookups = ctx.lookupRing.forPlace(String(channel.id), window, now);
  const reads = ctx.frameReads;
  const memoryContext = ctx.turnContextOf(draft, channel) as Context | null | undefined;
  if (reads === null || !memoryContext) return { ...NO_FRAMED, lookups };
  let mind: Mind | null = null;
  try {
    mind = reads.mind(memoryContext, seedsOf(frame, history, turn, reads), now);
  } catch (error) {
    log.warn('turn: memory not read', { channel: channel.id, error });
  }
  const refLineOf: LineOf = (key) => {
    const line = reads.line(memoryContext, key);
    return line ? { ...line, messageId: line.id } : null;
  };
  // Her posted words read a line's identity back under the same context (src/turn/sends.ts#renderPost).
  draft.frameRefs = { lineOf: refLineOf, placeId: place.id, timezone: frame.timezone };
  return {
    mind,
    lookups,
    meanwhileReads: {
      ownMessages: (limit) => reads.ownLines(memoryContext, place.id, limit),
      around: (placeId, at, count) => reads.around(memoryContext, placeId, at, count),
    },
    surroundings: {
      interfaceText: interfaceTextOf(reads.interfaceNames(frame.interface), turn.labels),
      root: frame.root ? reads.placeFields(memoryContext, frame.root.id) : null,
      place: reads.placeFields(memoryContext, place.id),
    },
    refLineOf,
  };
}

/** The budget's line of a request: one entry per section (src/llm/budget.ts). */
function statsOf(request: BuiltRequest): Record<string, { dropped?: number }> {
  return request.stats as Record<string, { dropped?: number }>;
}

/** The request built from an input turnRequestInput checked. */
function requestOf(input: Record<string, unknown>): BuiltRequest {
  // turnRequestInput refuses a key buildRequest does not read and an input left undefined, so the input is
  // buildRequest's own; the result carries the member names and the memory reads its header names too.
  return buildRequest(input as Parameters<typeof buildRequest>[0]);
}

// health: allow complexity until 2027-04-01 -- moved from runTurnAttempt in src/behavior/turn.ts in stage 5c, a pure split
export function buildTurnRequest(
  ctx: PhaseContext,
  params: PhaseParams,
  draft: Draft,
  opened: Opened,
  setup: Setup,
  planned: Planned,
  pulled: Pulled,
  waited: Waited,
  gathered: Gathered,
  told: Told
): BuiltRequest {
  const { store, calibrator, skills, lookup, emoji, memoryReads, turnContextOf } = ctx;
  const { aroundInputFor, errandsInputFor, intentionsInputFor, placesInputFor, earlierThinkFor } = ctx;
  const { liveChannelName, selfreflectionChannelName, stableFreezeOf, withSeenBefore, linkCalls, linkTriggers } = ctx;
  const { callMarksOf } = ctx;
  const { trigger = null, triggerKind = null, forced = false, source = null } = params;
  const { taskResult = null } = params;
  const selfreflectionParams = params.selfreflection ?? null;
  const { channel, placeId, reading: holders, libraryPlace, isPrivate } = opened;
  const { config, transport, memoryOn, selfId, selfName, now, snapshot } = setup;
  const { serverOn } = planned;
  const { finalMode } = pulled;
  const { participationShown, participationStage, participationAudienceOf } = waited;
  const { history, neighbors, descriptions, neighborDescriptions, videos, imageAnswers, reads } = gathered;
  const { prefetchResult, drawOn, selfreflectionPrep, pulled: pulledList, readOnlyIds } = gathered;
  const { recent, prompts } = gathered;
  const { factsText, tasks, placeMemory, taggedCall, offPeriods, skillIndex } = told;
  const pulled2 = pulledList;
  // Her tools, pinned for this turn (a grant removed meanwhile is still caught at each call): the skills granted to her
  // and the carried-over ones, as native tool definitions (or `<tools>` text), within a wake's own set
  // (src/tools/wake-tools.ts). `toolNames` feeds `<senses>` and stays the same for every turn kind, so a wake shares the
  // stable part of the request. A selfreflection post has the same tools; only `draw.create` runs there (runSteps).
  const registry = skills ?? defaultSkills();
  draft.toolNames = exposedSkillNames({ config, selfId, registry });
  const wake = draft.inner?.wake;
  const wakeKind = wake?.kind ?? null;
  draft.tools = buildTools(exposedSkillNames({ config, selfId, registry, wakeKind }), {
    registry,
    texts: prompts?.tools,
    fill: { drawChars: config.image?.maxPromptChars ?? 1600 },
  });
  const toolsBlock = transport === 'text' ? toolsBlockText(draft.tools, prompts?.labels) : null;
  const toolsTokens = transport === 'native' ? estimateTools(draft.tools) : 0;
  // Every input named (turnRequestInput throws on one left undefined); null marks an absent one.
  // A heartbeat's lines carry handles (`#N`) numbered on past the request's own lines, like a memory.search's quotes:
  // the text is worded once with a provisional base, then again when the request says where its own numbering ends.
  const heartbeat = wake?.heartbeat;
  const heartbeatRefs: Array<object> = Array.isArray(heartbeat?.refs) ? (heartbeat.refs as Array<object>) : [];
  const heartbeatHandleBase = heartbeatRefs.length > 0 ? SEARCH_HANDLE_GAP + 1 : null;
  let shownHeartbeatRefs: Array<number> = [];
  const wakeTextOf = (handleBase: number | null) =>
    wakeBlockText(draft.inner?.wake as Parameters<typeof wakeBlockText>[0], prompts?.labels, {
      locale: prompts?.labels?.locale,
      handleBase,
      onRefs: (refs) => (shownHeartbeatRefs = refs),
    });
  // Her remembered calls as call marks, the place names read live (src/turn/journal-notes.ts#callMarksOf).
  const callMarks = callMarksOf({ channel, snapshot });
  const frame = frameOfTurn(store, {
    channel,
    isPrivate,
    mode: finalMode,
    triggerKind,
    wakeKind,
    inner: Boolean(draft.inner),
    trigger,
    now,
    timezone: String(config.bot?.timezone ?? 'UTC'),
  });
  const facts = { history, trigger, prefetch: prefetchResult, labels: prompts?.labels, now };
  // A routed call or a noticed comment keeps the old request (src/behavior/prompt.ts).
  const framed = source === null ? framedInputsOf(ctx, frame, draft, channel, facts) : NO_FRAMED;
  const requestInput = turnRequestInput({
    frame,
    config,
    prompts,
    calibrator,
    mode: finalMode,
    forced: forced || (selfreflectionPrep !== null && selfreflectionParams?.forced === true),
    now,
    selfName,
    // `<directory>` never lists the persona's own profile.
    selfId,
    history,
    neighbors,
    trigger,
    triggerKind,
    taggedCall,
    placeMemory: placeMemory ?? {},
    interlocutor: memoryOn && trigger ? (store.getUser(accountOf(store, trigger.authorId)) ?? null) : null,
    // A private chat: the partner's private layer joins their public profile (only there).
    privateChat: isPrivate ? { accountId: trigger?.authorId ?? null } : null,
    privateProfile:
      isPrivate && memoryOn && trigger ? privateProfileOf(store, accountOf(store, trigger.authorId)) : null,
    otherProfiles: memoryOn ? pickOtherProfiles(store, placeId, history, trigger?.authorId) : [],
    candidateProfiles: memoryOn ? store.listUserProfiles() : [],
    nameOf: memoryOn ? (id: string) => store.getUser(accountOf(store, id))?.names?.[0] ?? null : null,
    channels: memoryOn ? holders.flatMap((holder) => store.listChannels(holder) as Array<object>) : [],
    // `<channel_directory>`: every text channel the persona can read, with its handle (none in a private chat).
    channelDirectory: channelDirectoryOf(isPrivate ? null : snapshot),
    loreEntries: memoryOn ? holders.flatMap((holder) => store.getLore(holder) as Array<object>) : [],
    currentChannelId: channel.id,
    selfreflectionChannelIds: selfreflectionConversationIds(store),
    descriptions: descriptions ?? null,
    neighborDescriptions: neighborDescriptions ?? null,
    videos: videos ?? null,
    imageAnswers,
    reads: reads ?? null,
    // `<lookup>` stays in the request layout, but no turn fills it: she searches through her own tools.
    lookup: null,
    // `<retrieved>`: the automatic memory prefetch of this trigger (null: none ran).
    prefetch: prefetchResult,
    searchAvailable: typeof lookup?.hasSearch === 'function' && lookup.hasSearch() === true,
    // The search of the server's own history: the value the lookup stage used.
    recallAvailable: serverOn,
    drawOn,
    // The custom emoji the interface offers, and what it declares for them in the turn.
    customEmoji: emoji ? (emoji.list() ?? []) : [],
    mediaPickText: portMediaPick(ctx.iface)?.text ?? null,
    // The transcript's GIF handles: the shared library.
    gifs: typeof store.getGifs === 'function' ? (store.getGifs() ?? null) : null,
    // The cached captions of a custom emoji and of a library GIF in the transcript.
    mediaCache: emoji || typeof store.getGifs === 'function' ? (store.getMediaCache(libraryPlace) ?? null) : null,
    // `<channel_view>`: the channels pulled into this turn (each with the last view of it
    // shown in this channel, when one is within context.pull.seenTtlMinutes), the one it is
    // about, the chat line put to the room, where a call from a read-only channel is answered.
    // The persona's lines there name the message that started their turn (linkTriggers) and
    // the skill calls she made there (linkCalls).
    pulled: withSeenBefore(
      pulled2.map((entry) =>
        Array.isArray(entry?.messages)
          ? {
              ...entry,
              // The marks keep every line as it was.
              messages: linkCalls(linkTriggers(entry.messages), {
                channel,
                snapshot,
                placeId,
              }) as typeof entry.messages,
              // Her call marks made there, put among its lines by time.
              marks: callMarks,
            }
          : entry
      ),
      channel.id,
      now
    ),
    source,
    elsewhereDestination: null,
    tasks: tasks.input,
    readOnlyIds,
    // `<recent>`: the last hours, its live lines and the members' moments (no block without the store).
    recentLines: recent.lines ?? null,
    recentAudience: recent.audience ?? null,
    // `<participation>`: the store read now, the classifier's picks when they came in time.
    participation: participationShown
      ? {
          state: store.getParticipation(placeId),
          pickedIds:
            participationStage?.done && Array.isArray(participationStage.value) ? participationStage.value : [],
          audience: participationAudienceOf,
          channelName: liveChannelName(channel, snapshot),
        }
      : null,
    // `<senses>`: where the persona keeps its selfreflection, when one is set.
    selfreflectionChannel: selfreflectionChannelName(
      placeId,
      config,
      snapshot,
      finalMode === 'selfreflection' ? channel : null
    ),
    // A selfreflection post: its past posts, its plan and what its search found.
    selfreflection: selfreflectionPrep
      ? {
          posts: selfreflectionPrep.posts,
          plan: selfreflectionPrep.plan,
          found: selfreflectionPrep.found,
          seeds: selfreflectionPrep.seeds ?? '',
          publicationPlaces: readMirrors(store, publicationPlaces, NO_PLACES),
        }
      : null,
    offPeriods,
    // The skills catalogue text is never filled by a turn: her tools are the native definitions below.
    skillsInventory: null,
    // `<skills>`: the index of her active skills, the stable part of every request (null: no skill is active).
    skillIndex,
    // Her tools this turn: the in-turn ones for `<senses>`, the text transport's `<tools>` body, and what the native
    // transport's `tools` field costs the request (the room the sections share).
    toolsGranted: draft.toolNames,
    toolsBlock,
    toolsTokens,
    // `<people_now>`'s live part: the voice and status snapshot (null: none).
    around: aroundInputFor({ config, mode: finalMode, isPrivate, snapshot }),
    // `<errands>` and `<errand_result>`: her errands (none on a selfreflection post).
    errands:
      finalMode === 'selfreflection'
        ? null
        : errandsInputFor({ placeId, channel, isPrivate, taskResult, config, labels: prompts?.labels, now }),
    // `<intentions>`: hers and the proposed ones (features.intentions; none on a selfreflection post).
    intentions:
      finalMode === 'selfreflection'
        ? ''
        : intentionsInputFor({ placeId, channel, snapshot, isPrivate, config, labels: prompts?.labels, now }),
    // `<wake>`: an inner turn's reason to be awake (src/behavior/wake.ts); none on any other turn.
    wake: draft.inner ? wakeTextOf(heartbeatHandleBase) : factsText || null,
    // An inner turn's wake kind: a heartbeat takes `prompts.heartbeat` as its task text.
    wakeKind,
    // `<places>`: the places page on an addressed server turn, only with `context.places` exactly true (an inner turn has it in `<wake>`).
    places:
      !draft.inner && !isPrivate && finalMode !== 'selfreflection'
        ? placesInputFor({ placeId, config, labels: prompts?.labels })
        : null,
    // Her one previous think: the latest finished turn tied to this place within the window (an inner turn imports none).
    previousThink: earlierThinkFor({ channel, isPrivate, draft, mode: finalMode }),
    // `<my_day>`: what she did today, read under this turn's context (context.myDay.lines, read now).
    myDay: myDayLines(ctx, { draft, channel, config, prompts, now }),
    // Her call marks, put among the lines of `<chat>` by time.
    callMarks,
    // `<self_facts>` held per cache bucket, so a memory batch rewrites the cache once at most.
    stableFreeze: stableFreezeOf(placeId),
    // `<spatial_awareness>`: where she is, the whole nesting of the place (buildRequest names her own time's places).
    whereabouts: whereaboutsOfFrame(frame),
    // A reply and an errand's result on the frame: `<memory>`, `<recall>`, `<meanwhile>`, `<surroundings>`, references.
    ...framed,
  });
  let request = requestOf(requestInput);
  if (heartbeatRefs.length > 0) {
    const floor = Math.max(0, ...request.idByIndex.keys());
    const base = floor + SEARCH_HANDLE_GAP + 1;
    if (base !== heartbeatHandleBase) {
      requestInput.wake = wakeTextOf(base);
      request = requestOf(requestInput);
    }
    // The handles the block kept resolve in this turn and in the steps of its loop (the registry of memory.search's quotes).
    draft.handleFloor = floor;
    searchHandles(draft).take(
      shownHeartbeatRefs
        .filter((index) => heartbeatRefs[index])
        .map((index) => ({ n: base + index, ...heartbeatRefs[index] }) as SearchRef)
    );
  }
  // Every number of the request in the turn's one registry, so a reference in her stored words reads back.
  if (draft.handles)
    registerHandles(draft.handles, request, [...history, ...pulled2.flatMap((entry) => entry.messages ?? [])], {
      iface: typeof channel.iface === 'string' ? channel.iface : '',
      placeId: String(channel.id),
    });
  // What `<recent>` showed, held back or cut: counts only.
  if (request.recent) log.info('recent: shown', { channel: channel.id, ...request.recent });
  // The memory rows this request carried, for the database's per-turn record (deferred there; it never fails a turn).
  const wakeMemory = heartbeat?.memory ?? wake?.selfimprovement?.memory ?? null;
  const allReads = [...(request.memoryReads ?? []), ...(wakeMemory ? pageReads(wakeMemory, { block: 'wake' }) : [])];
  if (memoryReads && draft.started?.turnId && allReads.length > 0) {
    // One step: the steps of her tool loop add tool results to this request, never memory reads of their own.
    try {
      const readContext = turnContextOf(draft, channel) as { id?: string } | null | undefined;
      memoryReads({
        turnId: draft.started.turnId,
        step: 's0',
        placeId,
        reads: allReads,
        ...(readContext?.id ? { contextId: readContext.id } : {}),
      });
    } catch {
      /* a record, never a turn's failure */
    }
  }
  // The journal: what of the window went in, whose lines they were, what the budget dropped.
  if (draft.started && request.seen) {
    // The lines of the pulled channels whose block the request kept count as seen too, by channel.
    const pulledSeen = (request.pulledKept ?? []).map(({ placeId: conversationId, ids }) => ({
      placeId: conversationId,
      messageIds: [...ids],
    }));
    const pulledIdsSeen = pulledSeen.flatMap((entry) => entry.messageIds);
    draft.seen = {
      ...request.seen,
      messageIds: [...new Set([...request.seen.messageIds, ...pulledIdsSeen])],
      pulled: pulledSeen,
    };
    const keptIds = new Set(draft.seen.messageIds);
    const pulledLines = pulledSeen.flatMap(
      ({ placeId: conversationId }) => pulled2.find((entry) => entry.placeId === conversationId)?.messages ?? []
    );
    const authors = [...history, ...pulledLines]
      .filter((message) => keptIds.has(message.id) && !message.self)
      .map((message) => message.authorId);
    draft.participants = [
      ...new Set([...authors, trigger?.authorId].filter((id): id is string => typeof id === 'string' && Boolean(id))),
    ];
    draft.dropped = droppedSections(statsOf(request));
    budgetDrops(statsOf(request), draft.limits);
  }
  return request;
}
