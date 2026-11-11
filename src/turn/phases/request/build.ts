// The last step of a turn's request: her tools for the turn, the request input with every block named, the request
// built (twice for a heartbeat whose handles follow the request's own lines), the record of the memory rows it carried
// and what of the window the journal names as seen. The request phase (src/turn/phases/request.ts) runs it last. Beside
// it, the selfreflection planner's request on the same frame (`plannerRequest`), which the setup step hands the plan.

import { accountOf, personOfMember, placeOfChat } from '../../../memory/addresses.ts';
import { reactorIdsOf } from '../../../format.ts';
import { handleOf } from '../../../behavior/handles.ts';
import type { InterfaceNames } from '../../../protocol/serve.ts';
import { buildRequest } from '../../../behavior/prompt.ts';
import { NO_PLACES, selfreflectionChatIds, publicationPlaces, readMirrors } from '../../../behavior/mirror.ts';
import { turnRequestInput } from '../../../behavior/turn-input.ts';
import { awakeLines, feedbackText } from '../../../behavior/wake.ts';
import type { WakeBlockInput } from '../../../behavior/wake.ts';
import { boardLines, landedLines, selfimprovementReason, workLines } from '../../../behavior/selfimprovement-text.ts';
import { budgetDrops } from '../../../llm/budget.ts';
import { toolsBlockText } from '../../../llm/tool-text.ts';
import { estimateTools } from '../../../llm/tokens.ts';
import { log } from '../../../log.ts';
import { exposedSkillNames, placeSkillNames } from '../../../tools/discovery.ts';
import { buildTools } from '../../../tools/tools-json.ts';
import { objOf } from '../../../tools/types.ts';
import { defaultSkills, searchHandles } from '../../calls.ts';
import { portAt, portCustomEmoji, portMediaPick, portOperations } from '../../../interface/capabilities.ts';
import type { Draft } from '../../draft.ts';
import { droppedSections } from '../../journal.ts';
import { pickOtherProfiles } from '../../mentions.ts';
import { PLANNER_MODE, frameOf, framedRequest } from '../../request/frame.ts';
import { entriesShownOf } from '../../request/selfreflection.ts';
import type { PlanParts } from '../../selfreflection.ts';
import type { PastEntry } from '../../../memory/db/selfreflection-past.ts';
import type { Frame, FrameParty } from '../../request/frame.ts';
import { whereaboutsOfFrame } from '../../request/spatial.ts';
import type { PlaceLink } from '../../request/spatial.ts';
import type { PhaseContext, PhaseParams } from '../context.ts';
import type { Prepared } from '../request.ts';
import type { Handles } from '../../handles.ts';
import { messageSourceId, PERSONA_ID } from '../../../memory/db/ids.ts';
import type { Mind, Seeds } from '../../../memory/db/mind-read.ts';
import type { FrameReads } from '../../../memory/db/frame-reads.ts';
import type { Context } from '../../../memory/db/scope.ts';
import { fill, formatClock, formatDate } from '../../../format.ts';
import type { Lookup } from '../../calls.ts';
import { meanwhileSettingsOf, meanwhileWindows } from '../../request/meanwhile.ts';
import type { MeanwhileLine, MeanwhileReads, MeanwhileWindow, OwnMessage } from '../../request/meanwhile.ts';
import { seedRefsOf } from '../../seed-ring.ts';
import type { SurroundingsInput } from '../../request/reader.ts';
import type { LineOf } from '../../request/refs.ts';
import type { SourceRetired } from '../../request/reader.ts';
import type { Message, PlacePathView } from '../../request/types.ts';

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

/** The tool a skill entry of the tools array is read through (src/tools/operations/skill.ts#cmdRead). */
const READ_TOOL = 'skill.read';

/** `labels.skills.procedure`, read now: the sentence after a skill's line that a call returns a procedure to follow. */
function procedureSentence(labels: unknown): string {
  const sentence = objOf(objOf(labels).skills).procedure;
  return typeof sentence === 'string' ? sentence : '';
}

/** The wakes that run with no chat of their own (src/behavior/inner/queue.ts#channelless). */
const OWN_SERVER_WAKES = new Set(['heartbeat', 'selfimprovement']);

/** How a frame's path names a one-to-one chat. It is a path segment for the code, no text she reads. */
const DM_WORD = 'private';

/**
 * The stored chain of the turn's place, the place first; a place the tree does not hold yet is a chain of itself. A wake
 * with no chat place (a heartbeat, a selfimprovement wake, or a turn that is nowhere) has none.
 */
function chainOfTurn(
  store: PhaseContext['store'],
  channel: Prepared['channel'],
  wake: { kind: string | null } | null,
  directPlace: string | null
): ReadonlyArray<PlaceLink> {
  if (wake && (OWN_SERVER_WAKES.has(wake.kind ?? '') || channel.rootId === PERSONA_ID)) return [];
  // A direct chat is keyed by its partner, so the chat alone does not name its stored place: the turn's place does.
  const placeId = directPlace || placeOfChat(store, channel) || String(channel.id ?? '');
  if (!placeId) return [];
  const chainOf: unknown = Reflect.get(Object(store), 'placeChainOf');
  const stored =
    typeof chainOf === 'function' ? (chainOf as (id: string) => ReadonlyArray<PlaceLink>).call(store, placeId) : [];
  return stored.length > 0 ? stored : [{ id: placeId, kind: null, name: null }];
}

/** Somebody the interface names by a native id, as the store holds them. */
function partyOf(store: PhaseContext['store'], nativeId: string, name: string | null): FrameParty {
  return { personId: personOfMember(store, nativeId), accountId: accountOf(store, nativeId), nativeId, name };
}

/** The frame of a turn, from what the turn runner holds. */
function frameOfTurn(
  store: PhaseContext['store'],
  turn: {
    channel: Prepared['channel'];
    isDm: boolean;
    mode: string;
    triggerKind: string | null;
    wakeKind: string | null;
    inner: boolean;
    trigger: { id: string; authorId: string; authorName?: string | null } | null;
    now: number;
    timezone: string;
    /** The stored place of the turn, given for a direct chat. */
    placeId?: string;
  }
): Frame {
  const { channel, isDm, trigger } = turn;
  const authorName = trigger?.authorName ?? null;
  const partnerId = trigger?.authorId ?? (typeof channel.partnerId === 'string' ? channel.partnerId : null);
  return frameOf({
    mode: turn.mode,
    triggerKind: turn.triggerKind,
    wakeKind: turn.wakeKind,
    interface: typeof channel.iface === 'string' ? channel.iface : '',
    chain: chainOfTurn(
      store,
      channel,
      turn.inner ? { kind: turn.wakeKind } : null,
      isDm ? (turn.placeId ?? null) : null
    ),
    dm: isDm
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
  turn: {
    draft: Draft;
    channel: Prepared['channel'];
    config: Prepared['config'];
    prompts: Prepared['prompts'];
    now: number;
  }
): Array<string> | null {
  const { draft, channel, config, prompts, now } = turn;
  const settings = config.context;
  const lines = settings?.myDay?.lines;
  const memoryContext = ctx.turnContextOf(draft, channel);
  if (!ctx.myDay || !memoryContext || typeof lines !== 'number' || lines <= 0) return null;
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
      iface,
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
  isSourceRetired: SourceRetired | null;
  chatIdOf: ((placeId: string) => string | null) | null;
};

const NO_FRAMED: FramedInputs = {
  mind: null,
  lookups: null,
  meanwhileReads: null,
  surroundings: null,
  refLineOf: null,
  isSourceRetired: null,
  chatIdOf: null,
};

/**
 * How a request names people and places (docs/prompt-contract.md, "Mention handles"): what a member's handle is cut
 * from by a platform id of `iface` (frame-reads.ts#memberKeyOf), the account key the store gives one no row holds yet,
 * and a stored place by its path with a direct chat's partner (frame-reads.ts#placeViewOf). Without the reads only the
 * store's account keys.
 */
function namesInputOf(
  reads: FrameReads | null,
  store: unknown,
  iface: string
): {
  memberKeyOf: ((native: string) => string | null) | null;
  accountKeyOf: (native: string) => string;
  placePathOf: ((placeId: string) => PlacePathView | null) | null;
} {
  return {
    memberKeyOf: reads?.memberKey ? (native) => reads.memberKey?.(iface, native) ?? null : null,
    accountKeyOf: (native) => accountOf(store, native, iface),
    placePathOf: reads?.placeView
      ? (placeId) => {
          const view = reads.placeView?.(placeId) ?? null;
          return view === null
            ? null
            : {
                iface: view.iface,
                chain: view.chain,
                ...(view.names === undefined ? {} : { names: view.names }),
                dm: view.dm,
                partnerKey: view.partnerKey ?? null,
              };
        }
      : null,
  };
}

/** What an interface declared of itself, in the shape of its hello; undefined when the memory holds no name of it. */
function declaredNames(reads: Pick<FrameReads, 'interfaceNames'>, iface: string): InterfaceNames | undefined {
  const { name, nouns, dm } = reads.interfaceNames(iface);
  return name === null ? undefined : { interface: name, nouns, dm: dm ?? '' };
}

/** The handle (with `@`) of a one-to-one chat's partner, by the key their lines carry; null in any other chat. */
function partnerHandleOf(frame: Frame, reads: Pick<FrameReads, 'memberKey'> | null): string | null {
  const partner = frame.scope === 'dm' ? frame.counterpart : null;
  if (partner === null) return null;
  return `@${handleOf(reads?.memberKey?.(frame.interface, partner.nativeId) ?? partner.accountId)}`;
}

/** The chat id of a stored place from its row, null for a place no row holds an address of; each place read once a request. */
function chatIdReader(reads: Pick<FrameReads, 'placeRef'>): (placeId: string) => string | null {
  const known = new Map<string, string | null>();
  return (placeId) => {
    if (!known.has(placeId)) {
      const ref = reads.placeRef?.(placeId) ?? null;
      known.set(placeId, ref === null ? null : ref.nativeId);
    }
    return known.get(placeId) ?? null;
  };
}

/**
 * The person she answers as the memory stores them: the account row of their platform id and its person. Null when no
 * row links a person, since a graph seed names a person node.
 */
function counterpartOf(frame: Frame, reads: Pick<FrameReads, 'account' | 'person'>): Seeds['counterpart'] {
  const them = frame.counterpart;
  const native = frame.answers?.authorId ?? null;
  if (them === null) return null;
  const account = native === null ? null : reads.account(frame.interface, native);
  const personId = (account === null ? null : reads.person(account)) ?? them.personId;
  return personId === null ? null : { personId, accountId: account ?? them.accountId };
}

/** The window as the graph reader's seeds: each line by its stored source id, the trigger marked, oldest first. */
function seedsOf(
  frame: Frame,
  history: ReadonlyArray<Message>,
  turn: { trigger: { id: string } | null; prefetch: unknown },
  reads: Pick<FrameReads, 'account' | 'person' | 'source' | 'sourceInPlace'>
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
  // A platform id as the memory's account row, null when none is stored yet.
  const accountOf = (native: string): string | null => reads.account(iface, native);
  const excerpts: unknown = prefetch && typeof prefetch === 'object' ? Reflect.get(prefetch, 'excerpts') : null;
  // A find is a message id of the place it was found in, which may be on another interface than this turn's (the
  // command line reads every interface), so it is resolved on its own place's interface first.
  const hits = (Array.isArray(excerpts) ? excerpts : []).flatMap((excerpt: unknown) => {
    const ids: unknown = excerpt && typeof excerpt === 'object' ? Reflect.get(excerpt, 'hitIds') : null;
    const found: unknown = excerpt && typeof excerpt === 'object' ? Reflect.get(excerpt, 'place') : null;
    const placeId = typeof found === 'string' && found !== '' ? found : null;
    const named = Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string' && id !== '') : [];
    return named.map(
      (hit) => (placeId === null ? null : reads.sourceInPlace?.(placeId, hit)) ?? reads.source?.(iface, hit) ?? hit
    );
  });
  // The people who reacted to her lines seed the reader like the authors of lines, so each named at her reaction has an
  // entry; a reaction whose reactors nobody read names nobody.
  const reactors = reactorIdsOf(lines as Array<Record<string, unknown>>).flatMap((native, i) => {
    const account = accountOf(native);
    return account === null
      ? []
      : [
          {
            id: `reaction:${i}`,
            at: new Date(lines.at(-1)?.ts ?? 0).toISOString(),
            authorAccount: account,
            placeId: frame.place?.id ?? null,
            replyTo: null,
            mentions: [],
            text: '',
            trigger: false,
          },
        ];
  });
  return {
    messages: [
      ...reactors,
      ...lines.map((line) => ({
        id: sourceOf(line),
        at: new Date(line.ts).toISOString(),
        authorAccount: line.self || !line.authorId ? null : accountOf(line.authorId),
        placeId: frame.place?.id ?? null,
        replyTo: line.replyToId ? (byId.get(line.replyToId) ?? null) : null,
        mentions: (line.mentionedAccountIds ?? []).flatMap((native) => accountOf(native) ?? []),
        text: line.content ?? '',
        trigger: line.id === trigger?.id,
      })),
    ],
    counterpart: counterpartOf(frame, reads),
    place: frame.place?.id ?? null,
    previous: [],
    candidates: hits.map((id) => ({ kind: 'source', rowId: id, sourceIds: [id], from: 'prefetch' as const })),
  };
}

/**
 * The reads of `<meanwhile>`, each answer kept for the request: the graph reader's seeds and the block are built from
 * the same windows, and the memory is read for them once.
 */
function readOnce(reads: MeanwhileReads): MeanwhileReads {
  const own = new Map<number, ReadonlyArray<OwnMessage>>();
  const around = new Map<string, ReadonlyArray<MeanwhileLine>>();
  return {
    ownMessages(limit) {
      const kept = own.get(limit) ?? reads.ownMessages(limit);
      own.set(limit, kept);
      return kept;
    },
    around(placeId, at, count) {
      const key = `${placeId}\u0000${at}\u0000${count}`;
      const kept = around.get(key) ?? reads.around(placeId, at, count);
      around.set(key, kept);
      return kept;
    },
  };
}

/**
 * The stored source ids of the lines a reply shows beyond its chat, for the graph reader's `seen`: every line of the
 * `<meanwhile>` windows, by its message's source on its place or the source it was read from, and the lines her
 * lookups in `<recall>` quote. Each id once.
 */
function seenOf(
  windows: ReadonlyArray<MeanwhileWindow>,
  lookups: ReadonlyArray<Lookup>,
  reads: Pick<FrameReads, 'sourceInPlace'>
): Array<string> {
  const lines = windows.flatMap((window) => window.lines);
  const ids = [
    ...lines.map((line) => reads.sourceInPlace?.(line.placeId, line.id) ?? line.sourceId ?? null),
    ...lookups.flatMap((lookup) => lookup.sourceIds),
  ];
  return [...new Set(ids.filter((id): id is string => typeof id === 'string' && id !== ''))];
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
  ctx: Pick<PhaseContext, 'frameReads' | 'lookupRing' | 'seedRing' | 'turnContextOf' | 'hot' | 'intentionRefsFor'>,
  frame: Frame,
  draft: Draft,
  channel: Prepared['channel'],
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
  if (!framedRequest(frame)) return NO_FRAMED;
  if (place === null) return serviceInputsOf(ctx, frame, draft, channel, now);
  // The place by the names of its chain from the interface down, kept with a lookup of hers (the journal's form).
  const names = frame.chain.flatMap((link) => (link.name === null ? [] : [link.name])).reverse();
  draft.framePlace = { id: String(channel.id), path: [frame.interface, ...names] };
  const window = history.map((line) => ({ id: String(line.id), replyTo: line.replyToId ?? null }));
  const lookups = ctx.lookupRing.forPlace(String(channel.id), window, now);
  const reads = ctx.frameReads;
  const memoryContext = ctx.turnContextOf(draft, channel) as Context | null | undefined;
  if (reads === null || !memoryContext) return { ...NO_FRAMED, lookups };
  const meanwhileReads = readOnce({
    ownMessages: (limit) => reads.ownLines(memoryContext, place.id, limit),
    around: (placeId, at, count) => reads.around(memoryContext, placeId, at, count),
  });
  let mind: Mind | null = null;
  try {
    const windows = frame.blocks.includes('meanwhile')
      ? meanwhileWindows(meanwhileReads, frame, meanwhileSettingsOf(ctx.hot.config, frame))
      : [];
    const turnId = draft.started?.turnId ?? null;
    const seeds: Seeds = {
      ...seedsOf(frame, history, turn, reads),
      previous: turnId === null ? [] : ctx.seedRing.previous(place.id, turnId),
      seen: seenOf(windows, frame.blocks.includes('recall') ? lookups : [], reads),
    };
    mind = reads.mind(memoryContext, seeds, now);
    const raised = seedRefsOf(mind);
    if (turnId !== null) ctx.seedRing.note(place.id, turnId, raised);
    // The turn record keeps them, so a restart refills the ring (src/memory/journal.ts#seedsOfRecords).
    draft.seeds = { placeId: place.id, refs: raised };
  } catch (error) {
    log.warn('turn: memory not read', { channel: channel.id, error });
  }
  const refLineOf: LineOf = (key) => {
    const line = reads.line(memoryContext, key);
    return line ? { ...line, messageId: line.id } : null;
  };
  const isSourceRetired: SourceRetired | null = reads.sourceRetired
    ? (sourceId) => reads.sourceRetired?.(memoryContext, sourceId) ?? true
    : null;
  // Her posted words read a line's identity back under the same context (src/turn/sends.ts#renderPost).
  draft.frameRefs = { lineOf: refLineOf, placeId: place.id, timezone: frame.timezone };
  return {
    mind,
    lookups,
    meanwhileReads,
    surroundings: {
      interfaceText: interfaceTextOf(reads.interfaceNames(frame.interface), turn.labels),
      names: declaredNames(reads, frame.interface),
      root: frame.root ? reads.placeFields(memoryContext, frame.root.id) : null,
      place: reads.placeFields(memoryContext, place.id),
      versions: [
        ...(frame.root ? (reads.placeVersions?.(memoryContext, frame.root.id) ?? []) : []),
        ...(reads.placeVersions?.(memoryContext, place.id) ?? []),
      ],
    },
    refLineOf,
    isSourceRetired,
    chatIdOf: chatIdReader(reads),
  };
}

/** A line's identity in a stored text (src/turn/request/refs.ts), as the key the reader of lines takes. */
const IDENTITY = /\bsrc:([\w-]+):((?:[\w.-]+:)*?[\w.-]+):\d+(?!\w|[.:]\w|-(?!src:)\w)/gu;

/**
 * What her open intentions refer to, as the graph reader's candidates: each line an identity in a purpose names, with
 * its place and its author's person, and each place an intention begins in. A line the context cannot read gives none.
 */
function intentionCandidatesOf(
  refs: { texts: ReadonlyArray<string>; places: ReadonlyArray<string> },
  reads: Pick<FrameReads, 'line' | 'account' | 'person' | 'sourceInPlace' | 'placeRef'>,
  ctx: Context
): Seeds['candidates'] {
  const out: Seeds['candidates'] = [];
  const add = (kind: string, rowId: string, sourceIds: Array<string> = []): void => {
    if (!out.some((one) => one.kind === kind && one.rowId === rowId))
      out.push({ kind, rowId, sourceIds, from: 'query' });
  };
  for (const text of refs.texts)
    for (const [, iface = '', messageId = ''] of text.matchAll(IDENTITY)) {
      const line = reads.line(ctx, `src:${iface}:${messageId}`);
      if (line === null || line.deleted) continue;
      const sourceId = reads.sourceInPlace?.(line.placeId, line.id) ?? null;
      if (sourceId !== null) add('source', sourceId, [sourceId]);
      add('place', line.placeId, sourceId === null ? [] : [sourceId]);
      const account = line.authorId === null ? null : reads.account(iface, line.authorId);
      const person = account === null ? null : reads.person(account);
      if (person !== null) add('person', person, sourceId === null ? [] : [sourceId]);
    }
  for (const place of refs.places) if ((reads.placeRef?.(place) ?? null) !== null) add('place', place);
  return out;
}

/**
 * Her lines of a service's `<meanwhile>` with the lines around them, as the graph reader's seeds, oldest first, and
 * what her open intentions refer to as candidates. A line's seed id is its stored source: the message's newest source
 * on its place's interface, else the source row the line was read from. A line with neither is no seed.
 */
function serviceSeedsOf(
  windows: ReadonlyArray<MeanwhileWindow>,
  reads: Pick<FrameReads, 'account' | 'sourceInPlace' | 'placeRef'>,
  candidates: Seeds['candidates']
): Seeds {
  const lines = windows.flatMap((window) => window.lines).sort((a, b) => a.at - b.at);
  // Each place's interface from its row, read once per place of the windows.
  const ifaces = new Map<string, string | null>();
  const ifaceOf = (placeId: string): string | null => {
    if (!ifaces.has(placeId)) ifaces.set(placeId, reads.placeRef?.(placeId)?.iface ?? null);
    return ifaces.get(placeId) ?? null;
  };
  return {
    messages: lines.flatMap((line) => {
      const iface = ifaceOf(line.placeId);
      const native = line.authorId;
      const id = reads.sourceInPlace?.(line.placeId, line.id) ?? line.sourceId ?? null;
      if (id === null) return [];
      return {
        id,
        at: new Date(line.at).toISOString(),
        authorAccount: line.self || native === null || iface === null ? null : reads.account(iface, native),
        placeId: line.placeId,
        replyTo: null,
        mentions: [],
        text: line.text,
        trigger: false,
      };
    }),
    counterpart: null,
    place: null,
    previous: [],
    candidates,
  };
}

/**
 * The inputs of a turn that is nowhere (a service, an intention without a place): her last lines over the rooms of every
 * group as `<meanwhile>`, and what they raise as `<memory>`, read as herself. No surroundings and no lookups of an
 * earlier turn. A failed read of the mind is logged and leaves memory empty.
 */
function serviceInputsOf(
  ctx: Pick<PhaseContext, 'frameReads' | 'turnContextOf' | 'hot' | 'intentionRefsFor'>,
  frame: Frame,
  draft: Draft,
  channel: Prepared['channel'],
  now: number
): FramedInputs {
  const reads = ctx.frameReads;
  const memoryContext = ctx.turnContextOf(draft, channel) as Context | null | undefined;
  if (reads === null || !memoryContext) return { ...NO_FRAMED, lookups: [] };
  const meanwhileReads = readOnce({
    ownMessages: (limit) => reads.ownLines(memoryContext, null, limit),
    around: (placeId, at, count) => reads.around(memoryContext, placeId, at, count),
  });
  let mind: Mind | null = null;
  try {
    const windows = meanwhileWindows(meanwhileReads, frame, meanwhileSettingsOf(ctx.hot.config, frame));
    const candidates = intentionCandidatesOf(ctx.intentionRefsFor(), reads, memoryContext);
    mind = reads.mind(memoryContext, serviceSeedsOf(windows, reads, candidates), now);
  } catch (error) {
    log.warn('turn: memory not read', { channel: null, error });
  }
  const refLineOf: LineOf = (key) => {
    const line = reads.line(memoryContext, key);
    return line ? { ...line, messageId: line.id } : null;
  };
  return {
    mind,
    lookups: [],
    meanwhileReads,
    surroundings: null,
    refLineOf,
    isSourceRetired: null,
    chatIdOf: chatIdReader(reads),
  };
}

/**
 * Why an inner turn is awake (src/behavior/wake.ts#awakeLines) and, on a turn that is nowhere, the interfaces she runs
 * on by their names (`labels.spatial.interfaces` with `{interfaces}`), an interface with no stored name by its id.
 */
function awakeTextOf(
  wake: WakeBlockInput | null,
  frame: Frame,
  reads: FrameReads | null,
  labels: Parameters<typeof awakeLines>[1]
): string | null {
  const locale: unknown = labels && typeof labels === 'object' ? Reflect.get(labels, 'locale') : undefined;
  const lines = awakeLines(wake, labels, typeof locale === 'string' ? { locale } : {});
  const spatial: unknown = labels && typeof labels === 'object' ? Reflect.get(labels, 'spatial') : null;
  const template: unknown = spatial && typeof spatial === 'object' ? Reflect.get(spatial, 'interfaces') : null;
  const ids = frame.place === null && reads ? (reads.interfaceIds?.() ?? []) : [];
  if (ids.length > 0 && typeof template === 'string' && template !== '') {
    const names = ids.map((id) => reads?.interfaceNames(id).name ?? id);
    lines.push(fill(template, { interfaces: names.join(', ') }));
  }
  return lines.join('\n') || null;
}

/** The intentions a wake is due for: they lead `<intentions>`, each whole. */
function dueIds(wake: { items?: ReadonlyArray<unknown> } | null | undefined): Array<string> {
  return (wake?.items ?? []).flatMap((item: unknown) => {
    const ids: unknown = item && typeof item === 'object' ? Reflect.get(item, 'intentionIds') : null;
    return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [];
  });
}

/** A selfimprovement wake's `<work>` and `<board>` bodies in the labels' words, null on any other turn. */
function serviceInnerOf(
  wake: { items?: ReadonlyArray<unknown>; timezone?: string; selfimprovement?: unknown } | null | undefined,
  labels: unknown
): { work: string; board: string } | null {
  const facts = wake?.selfimprovement as Parameters<typeof workLines>[0];
  if (!facts) return null;
  const words: unknown = labels && typeof labels === 'object' ? Reflect.get(labels, 'wake') : null;
  const own = (key: string): unknown => (words && typeof words === 'object' ? Reflect.get(words, key) : null);
  const locale: unknown = labels && typeof labels === 'object' ? Reflect.get(labels, 'locale') : undefined;
  const timezone = wake?.timezone || 'UTC';
  const at = typeof locale === 'string' ? locale : undefined;
  const when = (ts: unknown): string =>
    typeof ts === 'number' && Number.isFinite(ts)
      ? `${formatDate(ts, timezone, at)} ${formatClock(ts, timezone, at)}`
      : '';
  const work = workLines(facts, own('selfimprovement'), when, selfimprovementReason(wake?.items)).join('\n');
  const board = [...boardLines(facts, own('selfimprovement')), ...landedLines([facts.news.landed], own('landed'))].join(
    '\n'
  );
  return work || board ? { work, board } : null;
}

/**
 * Her newest selfreflection entries the turn's context may read, as many as `entriesShownOf` says, oldest first, read
 * from memory alone (src/memory/db/selfreflection-past.ts#readSelfreflection). None without a reader or a context.
 */
function pastEntriesOf(
  ctx: Pick<PhaseContext, 'frameReads' | 'turnContextOf'>,
  draft: Draft,
  channel: Prepared['channel'],
  config: Prepared['config']
): Array<PastEntry> {
  const memoryContext = ctx.turnContextOf(draft, channel) as Context | null | undefined;
  if (!memoryContext) return [];
  return ctx.frameReads?.selfreflection?.(memoryContext, entriesShownOf(config)) ?? [];
}

/**
 * The selfreflection planner's request on the turn frame: the kind `selfreflection_plan`, nowhere, with the service
 * template's `<memory>`, `<meanwhile>` and `<my_day>`, the world, her past entries and what it chooses from in `<inner>`,
 * and prompts/selfreflection-planner.md as its task. Nothing of a chat: it answers nobody and offers no tool.
 */
export function plannerRequest(
  ctx: PhaseContext,
  draft: Draft,
  turn: Pick<Prepared, 'channel' | 'isDm' | 'config' | 'selfName' | 'selfId' | 'now'>,
  parts: PlanParts
): BuiltRequest {
  const { channel, isDm, config, selfName, selfId, now } = turn;
  const prompts = ctx.hot.prompts;
  const timezone = String(config.bot?.timezone ?? 'UTC');
  const frame = frameOfTurn(ctx.store, {
    channel,
    isDm,
    mode: PLANNER_MODE,
    triggerKind: null,
    wakeKind: null,
    inner: false,
    trigger: null,
    now,
    timezone,
  });
  const facts = { history: [], trigger: null, prefetch: null, labels: prompts?.labels, now };
  const framed = framedInputsOf(ctx, frame, draft, channel, facts);
  return requestOf(
    turnRequestInput({
      frame,
      config,
      prompts,
      calibrator: ctx.calibrator,
      mode: PLANNER_MODE,
      now,
      selfName,
      selfId,
      history: [],
      trigger: null,
      triggerKind: null,
      taggedCall: null,
      placeMemory: {},
      interlocutor: null,
      dmChat: null,
      privateProfile: null,
      otherProfiles: [],
      candidateProfiles: [],
      nameOf: null,
      currentChannelId: null,
      descriptions: null,
      videos: null,
      imageAnswers: null,
      reads: null,
      prefetch: null,
      searchAvailable: false,
      recallAvailable: false,
      drawOn: false,
      customEmoji: [],
      mediaPickText: null,
      mediaCache: null,
      gifs: null,
      tasks: null,
      selfreflectionChannel: null,
      selfreflectionChannelIds: [],
      elsewhereDestination: null,
      offPeriods: null,
      selfreflection: { entries: pastEntriesOf(ctx, draft, channel, config), ...parts },
      skillsInventory: null,
      toolsGranted: null,
      toolsBlock: null,
      toolsTokens: 0,
      around: null,
      errands: null,
      intentions: '',
      wake: null,
      awake: null,
      serviceInner: null,
      wakeKind: null,
      previousThink: null,
      callMarks: null,
      stableFreeze: null,
      myDay: myDayLines(ctx, { draft, channel, config, prompts, now }),
      whereabouts: whereaboutsOfFrame(frame),
      ...framed,
      ...namesInputOf(ctx.frameReads, ctx.store, frame.interface),
    })
  );
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

/** What the build step reads of the attempt. */
type BuildNeeds = Pick<
  Prepared,
  | 'channel'
  | 'placeId'
  | 'libraryPlace'
  | 'isDm'
  | 'config'
  | 'transport'
  | 'memoryOn'
  | 'selfId'
  | 'selfName'
  | 'now'
  | 'snapshot'
  | 'serverOn'
  | 'finalMode'
  | 'history'
  | 'descriptions'
  | 'videos'
  | 'imageAnswers'
  | 'reads'
  | 'prefetchResult'
  | 'drawOn'
  | 'selfreflectionPrep'
  | 'prompts'
  | 'factsText'
  | 'tasks'
  | 'placeMemory'
  | 'taggedCall'
  | 'offPeriods'
  | 'activeSkills'
>;

// health: allow complexity until 2027-04-01 -- moved from runTurnAttempt in src/behavior/turn.ts in stage 5c, a pure split
export function buildTurnRequest(ctx: PhaseContext, params: PhaseParams, draft: Draft, turn: BuildNeeds): BuiltRequest {
  const { store, calibrator, skills, lookup, emoji, memoryReads, turnContextOf } = ctx;
  const { aroundInputFor, errandsInputFor, intentionsInputFor, earlierThinkFor } = ctx;
  const { selfreflectionChannelName, stableFreezeOf } = ctx;
  const { callMarksOf } = ctx;
  const { trigger = null, triggerKind = null } = params;
  const { taskResult = null } = params;
  const { channel, placeId, libraryPlace, isDm, config, transport, memoryOn, selfId, selfName, now, snapshot } = turn;
  const { serverOn, finalMode, history, descriptions, videos, imageAnswers, reads } = turn;
  const { prefetchResult, drawOn, selfreflectionPrep, prompts } = turn;
  const { factsText, tasks, placeMemory, taggedCall, offPeriods, activeSkills } = turn;
  // Her tools, pinned for this turn (a grant removed meanwhile is still caught at each call): the skills granted to her
  // and the carried-over ones, as native tool definitions (or `<tools>` text), then one entry per active skill she can
  // use. The array is the same for every turn kind, so every turn shares one cached prefix: a wake refuses a call outside
  // its own set when the call is made (src/tools/wake-tools.ts#wakeRefusalCode). A selfreflection post has the same
  // tools; only `draw.create` runs there (runSteps). A tool the interface of the turn's place cannot carry out (a reaction
  // in the owner's command line) is left out, so a turn of another interface has a prefix of its own.
  const registry = skills ?? defaultSkills();
  const placePort = portAt(ctx.iface, ctx.chatOf(channel));
  const toolNames = placeSkillNames(
    exposedSkillNames({ config, selfId, registry }),
    registry,
    portOperations(placePort)
  );
  const wake = draft.inner?.wake;
  const wakeKind = wake?.kind ?? null;
  // The wake as its words read it (src/behavior/wake.ts): the drain's WakeInfo.
  const wakeWords = (wake ?? null) as WakeBlockInput | null;
  // A skill entry is read through `skill.read`, so her grant of it decides whether her skills are offered at all.
  const offered = toolNames.includes(READ_TOOL) ? activeSkills.filter((skill) => skill.missing.length === 0) : [];
  draft.offeredSkills = new Map(offered.map((skill) => [skill.name, skill.versionId]));
  draft.skillsIndexed = offered.map(({ name, versionId, tools }) => ({ name, versionId, tools }));
  draft.tools = buildTools(
    toolNames.filter((name) => name !== READ_TOOL),
    {
      registry,
      texts: prompts?.tools,
      fill: { drawChars: config.image?.maxPromptChars ?? 1600 },
      skills: offered,
      procedure: procedureSentence(prompts?.labels),
    }
  );
  const toolsBlock = transport === 'text' ? toolsBlockText(draft.tools, prompts?.labels) : null;
  const toolsTokens = transport === 'native' ? estimateTools(draft.tools) : 0;
  // Every input named (turnRequestInput throws on one left undefined); null marks an absent one.
  // Her remembered calls as call marks, the place names read live (src/turn/journal-notes.ts#callMarksOf).
  const callMarks = callMarksOf({ channel, snapshot });
  const frame = frameOfTurn(store, {
    channel,
    isDm,
    mode: finalMode,
    triggerKind,
    wakeKind,
    inner: Boolean(draft.inner),
    trigger,
    now,
    timezone: String(config.bot?.timezone ?? 'UTC'),
    placeId,
  });
  const facts = { history, trigger, prefetch: prefetchResult, labels: prompts?.labels, now };
  const framed = framedInputsOf(ctx, frame, draft, channel, facts);
  const requestInput = turnRequestInput({
    frame,
    config,
    prompts,
    calibrator,
    mode: finalMode,
    now,
    selfName,
    // `<directory>` never lists the persona's own profile.
    selfId,
    history,
    trigger,
    triggerKind,
    taggedCall,
    placeMemory: placeMemory ?? {},
    interlocutor: memoryOn && trigger ? (store.getUser(accountOf(store, trigger.authorId)) ?? null) : null,
    // A private chat: the partner's private layer joins their public profile (only there).
    dmChat: isDm ? { accountId: trigger?.authorId ?? null } : null,
    privateProfile: isDm && memoryOn && trigger ? privateProfileOf(store, accountOf(store, trigger.authorId)) : null,
    otherProfiles: memoryOn ? pickOtherProfiles(store, placeId, history, trigger?.authorId) : [],
    candidateProfiles: memoryOn ? store.listUserProfiles() : [],
    // A stored profile's name, else the name an account row holds on any interface: the command line reads them all.
    nameOf: memoryOn
      ? (id: string) =>
          store.getUser(accountOf(store, id))?.names?.[0] ?? ctx.frameReads?.accountName?.(frame.interface, id) ?? null
      : null,
    currentChannelId: channel.id,
    selfreflectionChannelIds: selfreflectionChatIds(store),
    descriptions: descriptions ?? null,
    videos: videos ?? null,
    imageAnswers,
    reads: reads ?? null,
    // `<retrieved>`: the automatic memory prefetch of this trigger (null: none ran).
    prefetch: prefetchResult,
    searchAvailable: typeof lookup?.hasSearch === 'function' && lookup.hasSearch() === true,
    // The search of the server's own history: the value the lookup stage used.
    recallAvailable: serverOn,
    drawOn,
    // The custom emoji the interface of the place offers, and what it declares for them in the turn.
    customEmoji: emoji && portCustomEmoji(placePort) ? (emoji.list() ?? []) : [],
    mediaPickText: portMediaPick(placePort)?.text ?? null,
    // The transcript's GIF handles: the shared library.
    gifs: typeof store.getGifs === 'function' ? (store.getGifs() ?? null) : null,
    // The cached captions of a custom emoji and of a library GIF in the transcript.
    mediaCache:
      emoji || typeof store.getGifs === 'function' ? (key: string) => store.mediaEntry(libraryPlace, key) : null,
    elsewhereDestination: null,
    tasks: tasks.input,
    // `<senses>`: where the persona keeps its selfreflection, when one is set.
    selfreflectionChannel: selfreflectionChannelName(placeId, config, snapshot, null),
    // A selfreflection post: its past entries from memory, its plan, what its search found and the mirrors.
    selfreflection: selfreflectionPrep
      ? {
          posts: selfreflectionPrep.posts,
          entries: pastEntriesOf(ctx, draft, channel, config),
          plan: selfreflectionPrep.plan,
          found: selfreflectionPrep.found,
          seeds: selfreflectionPrep.seeds ?? '',
          publicationPlaces: readMirrors(store, publicationPlaces, NO_PLACES),
        }
      : null,
    offPeriods,
    // The skills catalogue text is never filled by a turn: her tools are the native definitions below.
    skillsInventory: null,
    // Her tools this turn: the in-turn ones for `<senses>`, the text transport's `<tools>` body, and what the native
    // transport's `tools` field costs the request (the room the sections share).
    toolsGranted: toolNames,
    toolsBlock,
    toolsTokens,
    // `<people_now>`'s live part: the voice and status snapshot (null: none).
    around: aroundInputFor({ config, mode: finalMode, isDm, snapshot }),
    // `<errands>` and `<errand_result>`: her errands (none on a selfreflection post).
    errands:
      finalMode === 'selfreflection'
        ? null
        : errandsInputFor({ placeId, channel, isDm, taskResult, config, labels: prompts?.labels, now }),
    // `<intentions>`: hers and the proposed ones (features.intentions; none on a selfreflection post).
    intentions:
      finalMode === 'selfreflection'
        ? ''
        : intentionsInputFor({
            ...{ placeId, channel, snapshot, isDm, config, now },
            labels: prompts?.labels,
            due: dueIds(wakeWords),
          }),
    // `<feedback>`: what did not go through and she has not been told (src/behavior/wake.ts).
    wake: draft.inner
      ? feedbackText(wakeWords, prompts?.labels, { locale: prompts?.labels?.locale }) || null
      : factsText || null,
    // Why an inner turn is awake, for `<spatial_awareness>`, and a selfimprovement wake's `<work>` and `<board>`.
    awake: draft.inner ? awakeTextOf(wakeWords, frame, ctx.frameReads, prompts?.labels) : null,
    serviceInner: serviceInnerOf(wakeWords, prompts?.labels),
    // An inner turn's wake kind: a heartbeat takes `prompts.heartbeat` as its task text.
    wakeKind,
    // Her one previous think: the latest finished turn tied to this place within the window (an inner turn imports none).
    previousThink: earlierThinkFor({ channel, isDm, draft, mode: finalMode }),
    // `<my_day>`: what she did today, read under this turn's context (context.myDay.lines, read now).
    myDay: myDayLines(ctx, { draft, channel, config, prompts, now }),
    // Her call marks, put among the lines of `<chat>` by time.
    callMarks,
    // `<self_facts>` held per cache bucket, so a memory batch rewrites the cache once at most.
    stableFreeze: stableFreezeOf(placeId),
    // `<spatial_awareness>`: where she is, the whole nesting of the place in the interface's own nouns (buildRequest
    // names her own time's places).
    whereabouts: whereaboutsOfFrame(
      frame,
      ctx.frameReads?.interfaceNames(frame.interface).nouns ?? {},
      partnerHandleOf(frame, ctx.frameReads)
    ),
    // A reply and an errand's result on the frame: `<memory>`, `<recall>`, `<meanwhile>`, `<surroundings>`, references.
    ...framed,
    // What a person's handle is cut from, and a place by its path: every block names people and places by them.
    ...namesInputOf(ctx.frameReads, store, frame.interface),
  });
  const request = requestOf(requestInput);
  // Her `@handle` in a post, a read's authors and its places take the request's names for the rest of the turn.
  draft.requestRefs = request.refs ?? null;
  // Every number of the request in the turn's one registry, so a reference in her stored words reads back.
  if (draft.handles)
    registerHandles(draft.handles, request, history, {
      iface: typeof channel.iface === 'string' ? channel.iface : '',
      placeId: String(channel.id),
    });
  // The numbers `<recall>` gave the lines of her earlier reads, numbered on past the chat's as a read of the turn is.
  if (request.recallRefs && request.recallRefs.length > 0) {
    draft.handleFloor = Math.max(0, ...request.idByIndex.keys());
    searchHandles(draft).take(request.recallRefs);
  }
  // The memory rows this request carried, for the database's per-turn record (deferred there; it never fails a turn).
  const allReads = request.memoryReads ?? [];
  // The people this request shows, so a read of the turn tells only of others (src/turn/in-turn-tools.ts).
  draft.memoryPeople = new Set(allReads.filter((read) => read.kind === 'people').map((read) => read.id));
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
    draft.seen = { ...request.seen, pulled: [] };
    const keptIds = new Set(draft.seen.messageIds);
    const authors = history
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
