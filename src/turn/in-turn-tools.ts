// Her in-turn tools for one turn: `web.search`, `web.read`, `media.look`, `media.find`, `memory.search`,
// `conversation.read`, `memory.read` (src/turn/memory-read.ts), `draw.create`, `person.link` and a selfreflection post's `voice.say`, each run over the turn's own context in place of
// the operation's command (src/tools/executors.ts#executeCall). createTurnRunner (src/behavior/turn.ts) builds it once
// per runner with createInTurnTools; the attempt hands the tools to its calls.

import { selfreflectionVoiceTool } from '../behavior/selfreflection-turn.ts';
import { pullPictures } from '../behavior/pull.ts';
import { checkPull } from '../behavior/pull-fetch.ts';
import { RECALL_DEFAULTS, recallSettings } from '../behavior/recall.ts';
import type { Snapshot } from '../behavior/snapshot.ts';
import type { TurnRoutes } from '../behavior/turn-ability-route.ts';
import type { Reads } from '../interface/reads.ts';
import { collectReadableLinks } from '../media/classify.ts';
import type { ChatInfo, ChatRef } from '../protocol/adapter.ts';
import { CODE } from '../tools/codes.ts';
import { isIssuedInternalContext } from '../memory/db/scope.ts';
import type { Context } from '../memory/db/scope.ts';
import type { FrameLine, FrameReads } from '../memory/db/frame-reads.ts';
import type { FindMeaningSource } from '../memory/db/graph-find.ts';
import type { Seeds } from '../memory/db/mind-read.ts';
import { peopleMemoryOf } from './request/memory-block.ts';
import { runMemoryRead } from './memory-read.ts';
import type { Labels } from './request/types.ts';
import { nativeChatOf } from '../memory/db/frame-reads.ts';
import { lineItemParts } from '../memory/db/media-store.ts';
import { fetchSpan, recordMessages, runConversationRead } from '../tools/conversation-read.ts';
import type { LiveLines, ReadMessage } from '../tools/conversation-read.ts';
import { chatOfStoredPlace } from '../interface/place-chat.ts';
import { accountOf, notePlaceAddress, personOfMember, placeOfChat } from '../memory/addresses.ts';
import { handleOf } from '../behavior/handles.ts';
import { escapeStored } from './request/text.ts';
import type { RequestRefs } from './request/types.ts';
import {
  firstLinkIn,
  lookPerTurn,
  mediaFind,
  runMediaLook,
  runChatFind,
  runMemorySearch,
  runWebRead,
  runWebSearch,
} from '../tools/tools.ts';
import type { ChatFind, LookDescriber, RecallClient, WebLookup, runMediaFind } from '../tools/tools.ts';
import type { InTurnCall, ResolvedMessageRef } from '../tools/executors.ts';
import { idText, objOf } from '../tools/types.ts';
import type { Obj } from '../tools/types.ts';
import { fill } from '../format.ts';
import { searchHandles } from './calls.ts';
import type { SearchRefs } from './calls.ts';
import type { DrawGif } from './draw-gif.ts';
import type { PersonLinks } from '../interface/person-link.ts';
import type { JournalNotes } from './journal-notes.ts';
import { inRoot } from './routing.ts';
import type { TriggerKind } from './triggers.ts';

type CheckPullArgs = Parameters<typeof checkPull>[0];

/** The live config, as far as the in-turn tools read it; the tools read their own sections. */
export type InTurnConfig = CheckPullArgs['config'] & {
  bot?: { timezone?: string };
};

/** The describer (src/memory/describe.ts#createDescriber), as the in-turn tools use it. */
export type InTurnDescriber = LookDescriber & {
  cachedDescriptions?: (placeId: string, items: Array<object>) => unknown;
};

/** The memory store, as the in-turn tools read it. */
type InTurnStore = NonNullable<Parameters<typeof runMediaFind>[0]['store']> & {
  listUserProfiles: () => ReadonlyArray<{ id?: unknown; names?: Array<unknown> } | null> | null;
  /** Stores the chat an interface opened for a place as its address (src/memory/store.ts). */
  notePlaceAddress?: (placeId: string, address: string) => Promise<unknown>;
};

/** The stored lines a read of a place outside the turn's snapshot takes from the memory, at most (conversation.read's own cap). */
const PLACE_READ_LINES = 60;

/** What createInTurnTools reads: the dependencies and the functions of the other topic modules it calls. */
export type InTurnToolsContext = {
  hot: { readonly config: InTurnConfig; readonly prompts: { labels?: unknown } | null | undefined };
  store: InTurnStore;
  lookup: WebLookup | undefined;
  describer: InTurnDescriber | undefined;
  recall: RecallClient | null;
  speech: unknown;
  record: Parameters<typeof recordMessages>[0];
  routes: TurnRoutes;
  clock: () => number;
  ifaceReads: Reads;
  memberOf: (placeId: string, accountId: string) => { name?: string | null } | null;
  chatOf: (channel: { id: string }) => ChatRef;
  turnContextOf: (draft: InTurnDraft | null | undefined, channel: ChatInfo) => unknown;
  /** The memory's reads of a place by its id, on any interface (src/memory/db/frame-reads.ts); null while closed. */
  placeReads?: Pick<
    FrameReads,
    | 'placeReadable'
    | 'memberKey'
    | 'around'
    | 'since'
    | 'placeName'
    | 'directChats'
    | 'mind'
    | 'account'
    | 'placeRef'
    | 'mediaTexts'
    | 'subject'
    | 'affinityChanges'
  > | null;
  linkCalls: JournalNotes['linkCalls'];
  drawTool: DrawGif['drawTool'];
  /** The turn's embeddings for the finder and media.find, one memo per draft (graph-find.ts#createFindMeaning). */
  findMeaningFor?: (draft: InTurnDraft | null) => FindMeaningSource | null;
  /** Her link tool over the account she talks with (src/interface/person-link.ts); absent, `person.link` is not offered. */
  personLinks?: Pick<PersonLinks, 'start'> | null;
};

/** What an attempt's draft holds that the in-turn tools read. */
export type InTurnDraft = NonNullable<Parameters<DrawGif['drawTool']>[1]['draft']> & {
  searchRefs?: SearchRefs;
  handleFloor?: number | null;
  selfreflectionVoice?: Parameters<typeof selfreflectionVoiceTool>[0]['held']['selfreflectionVoice'];
  /** The people this turn's request showed in `<memory>` and its reads told of since (people rows by person id). */
  memoryPeople?: Set<string>;
  /** The request's people and places for the rest of the turn (src/behavior/handles.ts#handleBook). */
  requestRefs?: RequestRefs | null;
};

/** A message of the turn's history, as a tool finds it by its id. */
type HistoryMessage = Obj & { id?: unknown; content?: unknown };

/** Resolve cached content within the identity supplied by the executor. */
function cachedMessage(
  ref: ResolvedMessageRef | undefined,
  messageId: string,
  refs: SearchRefs | undefined,
  history: ReadonlyArray<HistoryMessage>,
  current: ChatRef
): HistoryMessage | null {
  // Registered message payloads originate in the same history and quote readers.
  const payload = (value: unknown): HistoryMessage | null =>
    value && typeof value === 'object' && !Array.isArray(value) ? (value as HistoryMessage) : null;
  if (ref?.kind === 'stored') return payload(refs?.bySourceId?.get(ref.stored.sourceId)?.message);
  if (ref?.kind === 'native') {
    const native = ref.native;
    const matches = new Map<string, HistoryMessage>();
    for (const entry of refs?.byNumber.values() ?? []) {
      const locator = entry.stored
        ? entry.stored.native
        : {
            iface: current.iface,
            chatId: entry.placeId ?? current.chatId,
            messageId: String(entry.id),
          };
      if (locator?.iface !== native.iface || locator.chatId !== native.chatId || locator.messageId !== native.messageId)
        continue;
      const message = payload(entry.message);
      if (message) {
        const key = entry.stored
          ? JSON.stringify(['stored', entry.stored.sourceId])
          : JSON.stringify(['native', locator.iface, locator.chatId, locator.messageId]);
        matches.set(key, message);
      }
    }
    if (matches.size > 0) return matches.size === 1 ? [...matches.values()][0] : null;
    if (current.iface !== native.iface || current.chatId !== native.chatId) return null;
    const found = history.filter((message) => String(message.id) === native.messageId);
    return found.length === 1 ? found[0] : null;
  }
  const found = history.filter((message) => String(message.id) === messageId);
  return found.length === 1 ? found[0] : null;
}

export type InTurnArgs = {
  channel: ChatInfo;
  snapshot?: Snapshot | null;
  placeId: string;
  partner?: { id?: string | null } | null;
  selfId: string | null;
  selfName: string;
  history: ReadonlyArray<HistoryMessage> | null | undefined;
  draft?: InTurnDraft | null;
  trigger?: (Parameters<DrawGif['drawTool']>[1]['trigger'] & { authorId?: string | null }) | null;
  triggerKind?: TriggerKind | null;
  mode?: string | null;
  plain?: boolean;
};

export type InTurnTools = {
  inTurnTools: (args: InTurnArgs) => Record<string, (args: Obj, call?: InTurnCall) => unknown>;
};

// health: allow function-length until 2027-04-01 -- the tools share the runner state of src/behavior/turn.ts, moved whole in stage 5b
export function createInTurnTools(ctx: InTurnToolsContext): InTurnTools {
  const {
    hot,
    store,
    lookup,
    describer,
    recall,
    speech,
    record,
    routes,
    clock,
    ifaceReads,
    memberOf,
    chatOf,
    turnContextOf,
    placeReads = null,
    linkCalls,
    drawTool,
    personLinks = null,
    findMeaningFor = null,
  } = ctx;

  /** A person's handle as the turn's request gives it (src/behavior/handles.ts#handleBook), else cut from the key alone. */
  const personHandleOf = (draft: InTurnDraft | null, key: string): string =>
    draft?.requestRefs?.personHandle(key) ?? handleOf(key);

  /** What the handle of a member of `iface` is cut from: the person the memory holds, else the account. */
  const memberKeyOn = (iface: string, native: string): string =>
    placeReads?.memberKey?.(iface, native) ?? personOfMember(store, native, iface) ?? accountOf(store, native, iface);

  /**
   * The handle of every other author of a read's lines by platform id, so a read names each line's author as the
   * request does (`authors.line`): cut from the key the stored line carries, else from the member of `iface`.
   */
  function authorHandles(
    draft: InTurnDraft | null,
    iface: string,
    slice: ReadonlyArray<ReadMessage>
  ): Map<string, string> {
    const handles = new Map<string, string>();
    for (const line of slice) {
      const native = idText(line.authorId);
      if (line.self === true || native === '') continue;
      const stored: unknown = Reflect.get(line, 'authorKey');
      const key = typeof stored === 'string' && stored !== '' ? stored : memberKeyOn(iface, native);
      handles.set(native, personHandleOf(draft, key));
    }
    return handles;
  }

  /** A place as the turn's request names it (`places.ref`), else `fallback` escaped. */
  const placeNamed = (draft: InTurnDraft | null, placeId: string, fallback: string | null): string =>
    draft?.requestRefs?.placeRef(placeId) ?? escapeStored(fallback ?? '');

  /**
   * Her in-turn tools for one turn (src/tools/tools.ts): skill name -> `(args) =>
   * result`, run by src/tools/executors.ts#executeCall in place of the operation's command, over the turn's own context
   * -- `web.search` through the turn's `lookup`, `web.read` too (a `#N` message she names read as its first link in
   * `history`: an embedded one, else one written in its text), `media.look` through the turn's `describer` (a `#N`
   * message she names found in `history`; at most `media.look.maxPerTurn` second looks in the turn, read at each call),
   * `memory.search` through its `recall` over the served root (`snapshot`; a private chat on its `partner`'s
   * behalf), the turn's `history` left out of the hits and her call marks on the quoted lines (linkCalls), and
   * `draw.create` through drawTool; `draw.create` and `media.look` go on the route of their model role
   * (src/behavior/turn-ability-route.ts#turnRoutes).
   */
  function inTurnTools({
    channel,
    snapshot = null,
    placeId,
    partner = null,
    selfId,
    selfName,
    history,
    draft = null,
    trigger = null,
    triggerKind = null,
    mode = null,
    plain = false,
  }: InTurnArgs): Record<string, (args: Obj, call?: InTurnCall) => unknown> {
    // The second looks this turn took (media.look): every step of the loop shares the count.
    let looks = 0;
    const where = { channel, placeId, trigger, triggerKind, selfName, draft, mode, plain };
    const messageOf = (messageId: string, call?: InTurnCall): HistoryMessage | null =>
      cachedMessage(call?.messageRef, messageId, draft?.searchRefs, history ?? [], chatOf(channel));
    return {
      'draw.create': (args) => routes.tool('drawing', (model) => drawTool(args, where, model)),
      // The account she links is the one she answers, in the conversation she stands in.
      'person.link': (args) => {
        const native = trigger?.authorId ?? null;
        if (personLinks === null) return { status: 'not_configured', code: CODE.UNSUPPORTED };
        if (native === null) return { status: 'invalid', code: CODE.TARGET_REQUIRED };
        const iface = chatOf(channel).iface;
        return personLinks.start({
          iface,
          native,
          chatId: channel.id,
          person: typeof args.person === 'string' ? args.person : '',
        });
      },
      // The attempt always hands its draft to a selfreflection post's tools.
      ...(mode === 'selfreflection' ? selfreflectionVoiceTool({ speech, held: draft as InTurnDraft }) : {}),
      'web.search': (args) =>
        runWebSearch({ lookup: lookup ?? null, config: hot.config, labels: hot.prompts?.labels ?? {}, placeId, args }),
      'web.read': (args, call) =>
        runWebRead({
          lookup: lookup ?? null,
          config: hot.config,
          labels: hot.prompts?.labels ?? {},
          placeId,
          args,
          linkOf: (messageId) => {
            const message = messageOf(messageId, call);
            return message ? (firstReadableLink(message) ?? firstLinkIn(message.content)) : null;
          },
        }),
      'media.look': (args, call) =>
        runMediaLook({
          describer: describer ?? null,
          config: hot.config,
          labels: hot.prompts?.labels ?? {},
          placeId,
          args,
          mediaOf: (messageId) => messageOf(messageId, call),
          takeTurnSlot: () => {
            if (looks >= lookPerTurn()) return false;
            looks += 1;
            return true;
          },
          onRoute: routes.look,
        }),
      'media.find': (args) =>
        mediaFind({
          store,
          config: hot.config,
          labels: hot.prompts?.labels ?? {},
          placeId,
          args,
          findMeaning: findMeaningFor?.(draft) ?? null,
        }),
      'memory.search': (args, call) =>
        runMemorySearch({
          recall,
          store,
          config: hot.config,
          labels: hot.prompts?.labels ?? {},
          placeId,
          snapshot,
          channel,
          partnerId: partner?.id ?? null,
          selfId,
          selfName,
          // The turn's history as the attempt gave it.
          history: history as ReadonlyArray<unknown>,
          decorate: (lines: Array<object>) => linkCalls(lines, { channel, snapshot, placeId }),
          asker: trigger?.authorId ?? null,
          memoryContext: turnContextOf(draft, channel),
          resolvedAnchor: call?.memoryAnchor,
          historyRef: chatOf(channel),
          args,
          now: clock(),
          // The registry takes the quoted lines the search hands it, as the read's own handles.
          ...(draft ? { refs: searchHandles(draft) } : {}),
        }),
      'conversation.read': (args) => {
        const scene = {
          channel,
          snapshot,
          placeId,
          partner,
          selfId,
          selfName,
          asker: trigger?.authorId ?? null,
          draft,
        };
        return readChat({ args, channel, snapshot, placeId, partner, selfName, draft, scene });
      },
      // What memory holds about one subject, under the turn's memory context, rendered as `<memory>` renders it.
      'memory.read': (args) =>
        runMemoryRead({
          args,
          reads: placeReads,
          context: turnContextOf(draft, channel) as Context | null,
          here: { iface: chatOf(channel).iface, rootNative: channel.rootId ?? null },
          labels: hot.prompts?.labels ?? {},
          timezone: hot.config.bot?.timezone ?? 'UTC',
          now: clock(),
        }),
    };
  }

  /**
   * The `find` of a read of the stored place `place` (runChatFind): memory.search's search narrowed to that place, under
   * the turn's memory context, the read's window left out. `windowOf` turns the window's lines into the history lines the
   * search leaves out, `windowRef` the chat a line without a stored row stands in.
   */
  function finderOf(
    scene: FindScene,
    place: string,
    windowOf: (window: ReadonlyArray<ReadMessage>) => Array<Obj>,
    windowRef: ChatRef | null
  ): (window: ReadonlyArray<ReadMessage>, words: string) => Promise<ChatFind> {
    const { channel, snapshot, placeId, partner, selfId, selfName, asker, draft } = scene;
    return (window, words) =>
      runChatFind({
        recall,
        store,
        config: hot.config,
        placeId,
        place,
        words,
        window: windowOf(window),
        ...(windowRef ? { windowRef } : {}),
        channel,
        snapshot,
        partnerId: partner?.id ?? null,
        selfId,
        selfName,
        asker,
        memoryContext: turnContextOf(draft, channel),
        now: clock(),
      });
  }

  /**
   * A read's answer with what the graph reader raises from the other authors of the lines it returned
   * (`data.authors`, platform ids of `iface`) as `memory`: the people only, cut to the budget of `context.memory`, and
   * none the turn's request or an earlier read of the turn showed (`draft.memoryPeople`, which takes the ones told
   * here). The answer as it was when the read failed, named nobody, or the memory is closed. Never throws.
   */
  function withReadMemory(
    answer: ReadAnswer & { data?: { text: string; authors?: Array<string> } },
    where: { iface: string; placeId: string | null; channel: ChatInfo; draft: InTurnDraft | null }
  ): ReadAnswer {
    const { data, ...rest } = answer;
    const plain: ReadAnswer = data ? { ...rest, data: { text: data.text } } : rest;
    const authors = data?.authors ?? [];
    const context = turnContextOf(where.draft, where.channel) as Context | null;
    if (answer.status !== 'ok' || authors.length === 0 || !placeReads?.mind || !placeReads.account || !context)
      return plain;
    try {
      const at = new Date(clock()).toISOString();
      const seeds: Seeds = {
        messages: authors.map((native, i) => ({
          id: `read:${i}`,
          at,
          authorAccount: placeReads.account?.(where.iface, native) ?? null,
          placeId: where.placeId,
          replyTo: null,
          mentions: [],
          text: '',
          trigger: false,
        })),
        counterpart: null,
        place: null,
        previous: [],
        candidates: [],
      };
      const mind = placeReads.mind(context, seeds, clock());
      const shown = where.draft?.memoryPeople ?? new Set<string>();
      const people = mind.people.filter((person) => !shown.has(person.personId));
      const labels = (hot.prompts?.labels ?? {}) as Labels;
      const memory = peopleMemoryOf(
        people,
        mind.leftOut.people ?? 0,
        { interface: where.iface, timezone: hot.config.bot?.timezone ?? 'UTC', counterpart: null },
        labels,
        () => null,
        null,
        (key) => personHandleOf(where.draft, key)
      );
      if (memory === '') return plain;
      for (const person of people) shown.add(person.personId);
      if (where.draft) where.draft.memoryPeople = shown;
      return { ...plain, memory };
    } catch {
      return plain;
    }
  }

  /**
   * The interface of a stored place and the address its row holds (frame-reads.ts#placeRefOf), `chatId` null for a
   * direct chat that holds none yet; null without a row.
   */
  function storedChatOf(placeId: string): StoredChat | null {
    const ref = placeReads?.placeRef?.(placeId) ?? null;
    return ref === null ? null : { iface: ref.iface, chatId: nativeChatOf(ref) };
  }

  /** The interface's history of a stored place: through the address its row holds, a direct chat opened once if none. */
  async function fetchStored(placeId: string, request: Parameters<typeof fetchSpan>[2]): Promise<LiveLines> {
    const live = await chatOfStoredPlace({
      placeId,
      ref: placeReads?.placeRef?.(placeId) ?? null,
      reads: ifaceReads,
      note: (id, address) => notePlaceAddress(store, id, address),
    });
    return live.ok ? fetchSpan(ifaceReads, live.chat, request) : { failed: live.code };
  }

  /**
   * One conversation.read of a place named by its place id outside the turn's snapshot, on any interface: the stored
   * lines the turn's memory context reads (the first ones from the moment of a `since`, else the newest), each with its
   * media, under a source line that names the place, joined by the interface's own history through the router
   * when the record lacks the span, whose pictures take the descriptions the memory holds through their lines. The context decides whether she may read the place at all, a gone room included; the owner's
   * command line reads every place. `not_configured` while the memory is closed. Never throws.
   */
  async function readPlace({
    args,
    placeId,
    ref,
    channel,
    selfName,
    draft,
    scene,
  }: {
    args: Obj;
    placeId: string;
    ref: StoredChat;
    channel: ChatInfo;
    selfName: string;
    draft: InTurnDraft | null;
    scene: FindScene;
  }): Promise<ReadAnswer> {
    const context = turnContextOf(draft, channel) as Context | null;
    if (!placeReads?.placeReadable || !context) return { status: 'not_configured', code: CODE.UNSUPPORTED };
    // The stored lines the reads met, by their message id, and the newest of them: what `find` and the closing line read.
    const sources = new Map<string, string>();
    let newest: number | null = null;
    const storedOf = (window: ReadonlyArray<ReadMessage>): Array<Obj> =>
      window.map((line) => {
        const sourceId = sources.get(idText(line.id));
        return sourceId ? { stored: { sourceId, placeId, iface: ref.iface } } : { id: line.id, placeId: line.placeId };
      });
    const config = hot.config;
    const labels = hot.prompts?.labels ?? {};
    // The stored name of the author, else the name of a member the core has been told of.
    const authorNameOf = (line: FrameLine): string =>
      line.authorName ?? (line.authorId === null ? null : memberOf(placeId, line.authorId)?.name) ?? '-';
    /** The stored lines a read takes: from the moment on for `since`, else the newest; the newest line noted either way. */
    const storedLines = (from: number, mode: string): Array<FrameLine> => {
      const newestLines = placeReads.around(context, placeId, clock(), mode === 'since' ? 0 : PLACE_READ_LINES);
      for (const line of newestLines) if (newest === null || line.at > newest) newest = line.at;
      return mode === 'since' ? (placeReads.since?.(context, placeId, from, PLACE_READ_LINES) ?? []) : newestLines;
    };
    const answer = await runConversationRead({
      args: { ...args, placeId },
      labels,
      config,
      placeId,
      // The source line names the place as the request does, by its handle and path, on whatever interface it is.
      channelNameOf: (id) => placeNamed(draft, id, placeReads.placeName?.(id) ?? null),
      allowed: (id) => isIssuedInternalContext(context) || Boolean(placeReads.placeReadable?.(context, id)),
      readRecord: ({ from, mode }) =>
        Promise.resolve(
          storedLines(from, mode).flatMap((line) => {
            sources.set(line.id, line.sourceId);
            return line.at < from
              ? []
              : [
                  {
                    id: line.id,
                    placeId,
                    authorId: line.authorId,
                    authorName: line.self ? selfName : authorNameOf(line),
                    authorKey: line.authorKey,
                    self: line.self,
                    bot: false,
                    content: line.text,
                    ts: line.at,
                    // The stored line, so a lookup of this read names its lines for the next turns' memory.
                    sourceId: line.sourceId,
                    // A line with no platform id is no anchor the interface can take (runConversationRead).
                    ...(line.platformId ? {} : { liveAnchor: false }),
                    ...lineItemParts(line.media, line.id),
                  },
                ];
          })
        ),
      fetchLive: (request) => fetchStored(placeId, request as Parameters<typeof fetchSpan>[2]),
      // A line the platform gives carries its pictures bare: the memory's descriptions of them, read through their lines.
      render: (slice: ReadonlyArray<ReadMessage>) => ({
        timezone: config.bot?.timezone ?? 'UTC',
        selfName,
        labels,
        seeReactions: true,
        handles: authorHandles(draft, ref.iface, slice),
        iface: ref.iface,
        descriptions: placeReads.mediaTexts?.(
          context,
          placeId,
          slice.filter(holdsMedia).map(({ id }) => String(id))
        ),
      }),
      refs: draft ? searchHandles(draft) : null,
      now: clock(),
      timezone: config.bot?.timezone ?? 'UTC',
      newestAt: () => newest,
      openDate: true,
      find: finderOf(scene, placeId, storedOf, ref.chatId === null ? null : { iface: ref.iface, chatId: ref.chatId }),
    });
    return withReadMemory(answer, { iface: ref.iface, placeId, channel, draft });
  }

  /**
   * One conversation.read of the direct chat of the person she names (`args.person`: a member handle or a name the
   * memory holds, src/memory/db/direct-chats.ts): their newest direct chat on any interface other than the one she
   * stands in, the newest one the turn's context reads first, read as readPlace reads any stored place, so the same
   * audience rule decides. Words that name nobody answer `unknown-member` with the people the memory graph ranks for
   * them (`labels.tools.tools.person`); a person with no other direct chat answers `PLACE_NOT_FOUND`. Never throws.
   */
  async function readPerson({
    args,
    channel,
    placeId,
    selfName,
    draft,
    scene,
  }: {
    args: Obj;
    channel: ChatInfo;
    placeId: string;
    selfName: string;
    draft: InTurnDraft | null;
    scene: FindScene;
  }): Promise<ReadAnswer> {
    const context = turnContextOf(draft, channel) as Context | null;
    if (!placeReads?.directChats || !context) return { status: 'not_configured', code: CODE.UNSUPPORTED };
    const reference = String(args.person);
    let found = placeReads.directChats(context, reference);
    // Words that fit nobody in full are embedded once in the turn, within the finder's deadline (createFindMeaning).
    const finder = findMeaningFor?.(draft) ?? null;
    const fits = found.kind === 'chats' || (found.kind === 'found' && found.people.some((one) => one.hasEveryWord));
    if (!fits && finder) {
      const meaning = await finder.fetch(reference.trim().replace(/^@/, ''));
      if (meaning) found = placeReads.directChats(context, reference, meaning);
    }
    if (found.kind !== 'chats') {
      const text = found.kind === 'found' ? personChoicesText(found.people, hot.prompts?.labels, reference) : '';
      return { status: 'invalid', code: CODE.UNKNOWN_MEMBER, ...(text ? { data: { text } } : {}) };
    }
    const here = new Set([placeId, String(channel.id)]);
    const others = found.places.filter((id) => !here.has(id));
    const readable = (id: string): boolean =>
      isIssuedInternalContext(context) || Boolean(placeReads.placeReadable?.(context, id));
    const chosen = others.find(readable) ?? others[0];
    const ref = chosen === undefined ? null : storedChatOf(chosen);
    if (chosen === undefined || ref === null) return { status: 'invalid', code: CODE.PLACE_NOT_FOUND };
    // The read takes the chat's place id; the person and any place she wrote beside it are not its arguments.
    const rest = Object.fromEntries(
      Object.entries(args).filter(([key]) => !['person', 'place', 'placeId'].includes(key))
    );
    return readPlace({ args: rest, placeId: chosen, ref, channel, selfName, draft, scene });
  }

  /**
   * One conversation.read of hers (src/tools/conversation-read.ts): the channel she names (default
   * this one) read in order from the record first, the interface's history when the record lacks
   * the span, rendered like the chat with each line's `#N` handle in the turn's registry
   * (searchHandles). Another channel passes the pull rail (checkPull: readable, the audience rule
   * toward this turn's channel, a private chat on its partner's behalf); this channel always does.
   * `not_configured` without the root's snapshot or in a private chat without its partner. Never throws.
   */
  async function readChat({
    args,
    channel,
    snapshot,
    placeId,
    partner,
    selfName,
    draft,
    scene,
  }: {
    args: Obj;
    channel: ChatInfo;
    snapshot: Snapshot | null;
    placeId: string;
    partner: InTurnArgs['partner'];
    selfName: string;
    draft: InTurnDraft | null;
    scene: FindScene;
  }): Promise<ReadAnswer> {
    if (typeof args.person === 'string' && args.person.trim() !== '')
      return readPerson({ args, channel, placeId, selfName, draft, scene });
    const named = typeof args.placeId === 'string' ? storedChatOf(args.placeId) : null;
    const inSnapshot = named?.chatId != null && snapshot !== null && Boolean(snapshot.get(named.chatId));
    if (named && (named.iface !== chatOf(channel).iface || !inSnapshot))
      return readPlace({ args, placeId: String(args.placeId), ref: named, channel, selfName, draft, scene });
    const asked = named?.chatId != null ? { ...args, placeId: named.chatId } : args;
    if (!snapshot || (!inRoot(channel) && !partner)) return { status: 'not_configured', code: CODE.UNSUPPORTED };
    const config = hot.config;
    const labels = hot.prompts?.labels ?? {};
    const channelOf = (id: string): ChatInfo | null =>
      String(id) === String(channel.id) ? channel : (snapshot.get(String(id)) ?? null);
    const profiles = typeof store.listUserProfiles === 'function' ? (store.listUserProfiles() ?? []) : [];
    const stored = new Map(profiles.filter((p) => p?.id).map((p) => [String(p?.id), p]));
    const nameOf = (id: string): string | null => {
      const names = stored.get(String(id))?.names;
      return (typeof names?.[0] === 'string' ? names[0] : null) ?? memberOf(placeId, String(id))?.name ?? null;
    };
    const settings = recallSettings(config);
    const timezone = config.bot?.timezone ?? 'UTC';
    const iface = chatOf(channel).iface;
    const { chatId, place } = findTargetOf(store, { args, asked, named, channel, iface });
    const answer = await runConversationRead({
      args: asked,
      labels,
      config,
      placeId: String(channel.id),
      channelNameOf: (id) => placeNamed(draft, placeOfChat(store, { id }, iface), channelOf(id)?.name ?? null),
      allowed: (id) => {
        if (String(id) === String(channel.id) && inRoot(channel)) return true;
        // The owner's authenticated command line reads every stored chat; its publication stays restricted.
        if (isIssuedInternalContext(draft?.memoryContext)) return true;
        try {
          return (
            checkPull({
              snapshot,
              placeId: String(id),
              destination: channel,
              partnerId: partner?.id ?? null,
              config,
              now: clock(),
            }).skip === null
          );
        } catch {
          return false;
        }
      },
      readRecord: ({ placeId: chatId, from }) =>
        // Every chat the pull rail lets her read sits in the turn's tree, whose record is under its top.
        recordMessages(record, placeId, {
          placeId: chatId,
          from,
          nameOf,
          selfName,
        }),
      fetchLive: (request) => {
        const source = channelOf(request.placeId);
        // fetchSpan takes the request as it comes, its anchor included.
        return fetchSpan(ifaceReads, source ? chatOf(source) : null, request as Parameters<typeof fetchSpan>[2]);
      },
      render: (slice: ReadonlyArray<ReadMessage>) => {
        let descriptions: unknown;
        if (typeof describer?.cachedDescriptions === 'function') {
          const { items, rest, emoji } = pullPictures(slice as Array<object>, 0);
          const wanted = [...items, ...rest, ...emoji];
          try {
            if (wanted.length > 0) descriptions = describer.cachedDescriptions(placeId, wanted) ?? undefined;
          } catch {
            descriptions = undefined;
          }
        }
        return {
          timezone,
          selfName,
          labels,
          descriptions,
          seeReactions: true,
          handles: authorHandles(draft, iface, slice),
          iface,
        };
      },
      // The registry takes the lines the read hands it, as the read's own handles.
      refs: draft ? searchHandles(draft) : null,
      now: clock(),
      timezone,
      maxChars: settings?.quoteMaxChars ?? RECALL_DEFAULTS.quoteMaxChars,
      openDate: true,
      find: finderOf(scene, place, windowIn(chatId), { iface, chatId }),
    });
    return withReadMemory(answer, {
      iface,
      placeId: named ? String(args.placeId) : null,
      channel,
      draft,
    });
  }

  return { inTurnTools };
}

/** Whether a message of a read carries an attachment, a sticker or an emoji. */
const holdsMedia = (message: ReadMessage): boolean =>
  [message.attachments, message.stickers, message.emojis].some((list) => Array.isArray(list) && list.length > 0);

/** What a read answers before anything is read. */
type ReadAnswer = {
  status: string;
  code?: string;
  reason?: string;
  values?: Record<string, unknown>;
  data?: { text: string };
  memory?: string;
};

/**
 * What a `find` of a read of a chat in the snapshot searches: the chat read (the native id she named, else this one)
 * and its stored place (the place she named, else the place the store keeps for that chat).
 */
function findTargetOf(
  store: unknown,
  {
    args,
    asked,
    named,
    channel,
    iface,
  }: { args: Obj; asked: Obj; named: StoredChat | null; channel: ChatInfo; iface: string }
): { chatId: string; place: string } {
  const chatId = typeof asked.placeId === 'string' && asked.placeId ? asked.placeId : String(channel.id);
  return { chatId, place: named ? String(args.placeId) : placeOfChat(store, { id: chatId }, iface) };
}

/** The lines of a read's window as the history a search leaves out, each by its id in the chat `chatId`. */
const windowIn =
  (chatId: string) =>
  (window: ReadonlyArray<ReadMessage>): Array<Obj> =>
    window.map(({ id }) => ({ id, placeId: chatId }));

/** The turn a `find` of conversation.read searches for: where she stands, who she answers and the attempt's draft. */
type FindScene = {
  channel: ChatInfo;
  snapshot: Snapshot | null;
  /** The place the turn's searches run for (memory.search's `placeId`). */
  placeId: string;
  partner: InTurnArgs['partner'];
  selfId: string | null;
  selfName: string;
  asker: string | null;
  draft: InTurnDraft | null;
};

/** A stored place's interface and the address its row holds, null for a direct chat that holds none yet. */
type StoredChat = { iface: string; chatId: string | null };

/**
 * The people the memory graph ranked for words that name nobody, as the text of a tool result: the lead of
 * `labels.tools.tools.person.found` (`{given}`, `{count}`) and one `.line` per person (`{ref}`, the handle to write,
 * `{name}`, and `{about}` through `.lineAbout` when a character is stored). Reads the labels now.
 */
function personChoicesText(
  people: ReadonlyArray<{ id: string; name: string; about: string | null; handle: string | null }>,
  labels: unknown,
  given: string
): string {
  const words = objOf(objOf(objOf(objOf(labels).tools).tools).person);
  const word = (key: string): string => (typeof words[key] === 'string' ? words[key] : '');
  const lines = people.map((person) => {
    const ref = person.handle ? `@${person.handle}` : person.id;
    return person.about && word('lineAbout')
      ? fill(word('lineAbout'), { ref, name: person.name, about: person.about })
      : fill(word('line'), { ref, name: person.name });
  });
  return [fill(word('found'), { given, count: people.length }), ...lines].filter(Boolean).join('\n');
}

/** The first link of a message that a page read can open (src/media/classify.ts#collectReadableLinks). */
function firstReadableLink(message: object): string | undefined {
  return collectReadableLinks(message)[0]?.url;
}
