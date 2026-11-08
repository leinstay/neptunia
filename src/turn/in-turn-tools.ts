// Her in-turn tools for one turn: `web.search`, `web.read`, `media.look`, `media.find`, `memory.search`,
// `conversation.read`, `draw.create` and a selfreflection post's `voice.say`, each run over the turn's own context in place of
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
import type { FrameReads } from '../memory/db/frame-reads.ts';
import { placeIdParts } from '../memory/db/ids.ts';
import { fetchSpan, recordMessages, runConversationRead } from '../tools/conversation-read.ts';
import type { ReadMessage } from '../tools/conversation-read.ts';
import {
  firstLinkIn,
  lookPerTurn,
  runMediaFind,
  runMediaLook,
  runMemorySearch,
  runWebRead,
  runWebSearch,
} from '../tools/tools.ts';
import type { LookDescriber, RecallClient, WebLookup } from '../tools/tools.ts';
import type { InTurnCall, ResolvedMessageRef } from '../tools/executors.ts';
import type { Obj } from '../tools/types.ts';
import { searchHandles } from './calls.ts';
import type { SearchRefs } from './calls.ts';
import type { DrawGif } from './draw-gif.ts';
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
  placeReads?: Pick<FrameReads, 'placeReadable' | 'around'> | null;
  linkCalls: JournalNotes['linkCalls'];
  drawTool: DrawGif['drawTool'];
};

/** What an attempt's draft holds that the in-turn tools read. */
export type InTurnDraft = NonNullable<Parameters<DrawGif['drawTool']>[1]['draft']> & {
  searchRefs?: SearchRefs;
  handleFloor?: number | null;
  selfreflectionVoice?: Parameters<typeof selfreflectionVoiceTool>[0]['held']['selfreflectionVoice'];
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
  } = ctx;

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
        runMediaFind({ store, config: hot.config, labels: hot.prompts?.labels ?? {}, placeId, args }),
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
      'conversation.read': (args) => readChat({ args, channel, snapshot, placeId, partner, selfName, draft }),
    };
  }

  /**
   * One conversation.read of a place named by its place id outside the turn's snapshot, on any interface: the stored
   * lines the turn's memory context reads, joined by the interface's own history through the router when the record
   * lacks the span. The context decides whether she may read the place at all, a gone room included; the owner's
   * command line reads every place. `not_configured` while the memory is closed. Never throws.
   */
  async function readPlace({
    args,
    placeId,
    parts,
    channel,
    selfName,
    draft,
  }: {
    args: Obj;
    placeId: string;
    parts: NonNullable<ReturnType<typeof placeIdParts>>;
    channel: ChatInfo;
    selfName: string;
    draft: InTurnDraft | null;
  }): Promise<{ status: string; code?: string; reason?: string; data?: { text: string } }> {
    const context = turnContextOf(draft, channel) as Context | null;
    if (!placeReads?.placeReadable || !context) return { status: 'not_configured', code: CODE.UNSUPPORTED };
    const config = hot.config;
    const labels = hot.prompts?.labels ?? {};
    const ref: ChatRef = { iface: parts.iface, chatId: parts.native };
    return runConversationRead({
      args: { ...args, placeId },
      labels,
      config,
      placeId,
      allowed: (id) => isIssuedInternalContext(context) || Boolean(placeReads.placeReadable?.(context, id)),
      readRecord: ({ from }) =>
        Promise.resolve(
          placeReads.around(context, placeId, clock(), PLACE_READ_LINES).flatMap((line) =>
            line.at < from
              ? []
              : [
                  {
                    id: line.id.split(':').pop() ?? line.id,
                    placeId,
                    authorId: line.authorId,
                    authorName: line.self ? selfName : '-',
                    self: line.self,
                    bot: false,
                    content: line.text,
                    ts: line.at,
                  },
                ]
          )
        ),
      fetchLive: (request) => fetchSpan(ifaceReads, ref, request as Parameters<typeof fetchSpan>[2]),
      render: { timezone: config.bot?.timezone ?? 'UTC', selfName, labels, seeReactions: true },
      refs: draft ? searchHandles(draft) : null,
      now: clock(),
      timezone: config.bot?.timezone ?? 'UTC',
    });
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
  }: {
    args: Obj;
    channel: ChatInfo;
    snapshot: Snapshot | null;
    placeId: string;
    partner: InTurnArgs['partner'];
    selfName: string;
    draft: InTurnDraft | null;
  }): Promise<{ status: string; code?: string; reason?: string; data?: { text: string } }> {
    const named = typeof args.placeId === 'string' ? placeIdParts(args.placeId) : null;
    if (named && (!snapshot || named.iface !== chatOf(channel).iface || !snapshot.get(named.native)))
      return readPlace({ args, placeId: String(args.placeId), parts: named, channel, selfName, draft });
    const asked = named ? { ...args, placeId: named.native } : args;
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
    return runConversationRead({
      args: asked,
      labels,
      config,
      placeId: String(channel.id),
      channelNameOf: (id) => channelOf(id)?.name ?? null,
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
        };
      },
      // The registry takes the lines the read hands it, as the read's own handles.
      refs: draft ? searchHandles(draft) : null,
      now: clock(),
      timezone,
      maxChars: settings?.quoteMaxChars ?? RECALL_DEFAULTS.quoteMaxChars,
    });
  }

  return { inTurnTools };
}

/** The first link of a message that a page read can open (src/media/classify.ts#collectReadableLinks). */
function firstReadableLink(message: object): string | undefined {
  return collectReadableLinks(message)[0]?.url;
}
