// Her in-turn tools for one turn: `web.search`, `web.read`, `media.look`, `media.find`, `memory.search`,
// `conversation.read`, `draw.create` and a diary post's `voice.say`, each run over the turn's own context in place of
// the operation's command (src/tools/executors.ts#executeCall). createTurnRunner (src/behavior/turn.js) builds it once
// per runner with createInTurnTools; the attempt hands the tools to its calls.

import { diaryVoiceTool } from '../behavior/diary-turn.ts';
import { pullPictures } from '../behavior/pull.js';
import { checkPull } from '../behavior/pull-fetch.ts';
import { RECALL_DEFAULTS, recallSettings } from '../behavior/recall.js';
import type { Snapshot } from '../behavior/snapshot.ts';
import type { TurnRoutes } from '../behavior/turn-ability-route.ts';
import type { Reads } from '../interface/reads.ts';
import { collectReadableLinks } from '../media/classify.js';
import type { ConversationInfo, ConversationRef } from '../protocol/adapter.ts';
import { CODE } from '../tools/codes.ts';
import { fetchSpan, recordMessages, runConversationRead } from '../tools/conversation-read.ts';
import type { HandleRefs, ReadMessage } from '../tools/conversation-read.ts';
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
import type { Obj } from '../tools/types.ts';
import { searchHandles } from './calls.ts';
import type { SearchRefs } from './calls.ts';
import type { DrawGif } from './draw-gif.ts';
import type { JournalNotes } from './journal-notes.ts';
import { inCommunity } from './routing.ts';
import type { TriggerKind } from './triggers.ts';

type CheckPullArgs = Parameters<typeof checkPull>[0];

/** The live config, as far as the in-turn tools read it; the tools read their own sections. */
export type InTurnConfig = CheckPullArgs['config'] & {
  bot?: { timezone?: string; dryRunChannelId?: unknown };
  features?: { record?: unknown; mediaDescriptions?: unknown; seeReactions?: unknown; elsewhere?: unknown };
  context?: {
    gapMarkerMinutes?: number;
    maxMessageChars?: number;
    reactionsPerMessage?: number;
  } | null;
};

/** The describer (src/memory/describe.js#createDescriber), as the in-turn tools use it. */
export type InTurnDescriber = LookDescriber & {
  cachedDescriptions?: (guildId: string, items: Array<object>) => unknown;
};

/** The memory store, as the in-turn tools read it. */
type InTurnStore = NonNullable<Parameters<typeof runMediaFind>[0]['store']> & {
  listUserProfiles?: (guildId: string) => ReadonlyArray<{ id?: unknown; names?: Array<unknown> } | null> | null;
};

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
  memberOf: (communityId: string, memberId: string) => { name?: string | null } | null;
  conversationOf: (channel: { id: string }) => ConversationRef;
  turnContextOf: (draft: InTurnDraft | null | undefined, channel: ConversationInfo) => unknown;
  linkCalls: JournalNotes['linkCalls'];
  drawTool: DrawGif['drawTool'];
};

/** What an attempt's draft holds that the in-turn tools read. */
export type InTurnDraft = NonNullable<Parameters<DrawGif['drawTool']>[1]['draft']> & {
  searchRefs?: SearchRefs;
  handleFloor?: number | null;
  diaryVoice?: Parameters<typeof diaryVoiceTool>[0]['held']['diaryVoice'];
};

/** A message of the turn's history, as a tool finds it by its id. */
type HistoryMessage = Obj & { id?: unknown; content?: unknown };

export type InTurnArgs = {
  channel: ConversationInfo;
  snapshot?: Snapshot | null;
  guildId: string;
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
  inTurnTools: (args: InTurnArgs) => Record<string, (args: Obj) => unknown>;
};

// health: allow function-length until 2027-04-01 -- the tools share the runner state of src/behavior/turn.js, moved whole in stage 5b
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
    conversationOf,
    turnContextOf,
    linkCalls,
    drawTool,
  } = ctx;

  /**
   * Her in-turn tools for one turn (src/tools/tools.ts, whatever features.coreTools says): skill name -> `(args) =>
   * result`, run by src/tools/executors.ts#executeCall in place of the operation's command, over the turn's own context
   * -- `web.search` through the turn's `lookup`, `web.read` too (a `#N` message she names read as its first link in
   * `history`: an embedded one, else one written in its text), `media.look` through the turn's `describer` (a `#N`
   * message she names found in `history`; at most `media.look.maxPerTurn` second looks in the turn, read at each call),
   * `memory.search` through its `recall` over the served community (`snapshot`; a private chat on its `partner`'s
   * behalf), the turn's `history` left out of the hits and her call marks on the quoted lines (linkCalls), and
   * `draw.create` through drawTool; `draw.create` and `media.look` go on the route of their model role
   * (src/behavior/turn-ability-route.ts#turnRoutes).
   */
  function inTurnTools({
    channel,
    snapshot = null,
    guildId,
    partner = null,
    selfId,
    selfName,
    history,
    draft = null,
    trigger = null,
    triggerKind = null,
    mode = null,
    plain = false,
  }: InTurnArgs): Record<string, (args: Obj) => unknown> {
    // The second looks this turn took (media.look): every step of the loop shares the count.
    let looks = 0;
    const where = { channel, guildId, trigger, triggerKind, selfName, draft, mode, plain };
    // A message the turn's history lacks but one of its memory.search results quoted.
    const quotedMessage = (messageId: string): HistoryMessage | null =>
      (draft?.searchRefs?.byId.get(String(messageId))?.message as HistoryMessage | undefined) ?? null;
    return {
      'draw.create': (args) => routes.tool('drawing', (model) => drawTool(args, where, model)),
      // The attempt always hands its draft to a diary post's tools.
      ...(mode === 'diary' ? diaryVoiceTool({ speech, held: draft as InTurnDraft }) : {}),
      'web.search': (args) =>
        runWebSearch({ lookup: lookup ?? null, config: hot.config, labels: hot.prompts?.labels ?? {}, guildId, args }),
      'web.read': (args) =>
        runWebRead({
          lookup: lookup ?? null,
          config: hot.config,
          labels: hot.prompts?.labels ?? {},
          guildId,
          args,
          linkOf: (messageId) => {
            const message =
              (history ?? []).find((item) => String(item?.id) === String(messageId)) ?? quotedMessage(messageId);
            return message ? (firstReadableLink(message) ?? firstLinkIn(message.content)) : null;
          },
        }),
      'media.look': (args) =>
        runMediaLook({
          describer: describer ?? null,
          config: hot.config,
          labels: hot.prompts?.labels ?? {},
          guildId,
          args,
          mediaOf: (messageId) =>
            (history ?? []).find((item) => String(item?.id) === String(messageId)) ?? quotedMessage(messageId),
          takeTurnSlot: () => {
            if (looks >= lookPerTurn(hot.config)) return false;
            looks += 1;
            return true;
          },
          onRoute: routes.look,
        }),
      'media.find': (args) =>
        runMediaFind({ store, config: hot.config, labels: hot.prompts?.labels ?? {}, guildId, args }),
      'memory.search': (args) =>
        runMemorySearch({
          recall,
          store,
          config: hot.config,
          labels: hot.prompts?.labels ?? {},
          guildId,
          snapshot,
          channel,
          partnerId: partner?.id ?? null,
          selfId,
          selfName,
          // The turn's history as the attempt gave it.
          history: history as ReadonlyArray<unknown>,
          decorate: (lines: Array<object>) => linkCalls(lines, { channel, snapshot, guildId }),
          asker: trigger?.authorId ?? null,
          memoryContext: turnContextOf(draft, channel),
          args,
          now: clock(),
          // The registry takes the quoted lines the search hands it, as the read's own handles.
          ...(draft ? { refs: searchHandles(draft) as HandleRefs } : {}),
        }),
      'conversation.read': (args) => readConversation({ args, channel, snapshot, guildId, partner, selfName, draft }),
    };
  }

  /**
   * One conversation.read of hers (src/tools/conversation-read.ts): the channel she names (default
   * this one) read in order from the record first, the interface's history when the record lacks
   * the span, rendered like the chat with each line's `#N` handle in the turn's registry
   * (searchHandles). Another channel passes the pull rail (checkPull: readable, the audience rule
   * toward this turn's channel, a private chat on its partner's behalf); this channel always does.
   * `not_configured` without the community's snapshot or in a private chat without its partner. Never throws.
   */
  async function readConversation({
    args,
    channel,
    snapshot,
    guildId,
    partner,
    selfName,
    draft,
  }: {
    args: Obj;
    channel: ConversationInfo;
    snapshot: Snapshot | null;
    guildId: string;
    partner: InTurnArgs['partner'];
    selfName: string;
    draft: InTurnDraft | null;
  }): Promise<{ status: string; code?: string; reason?: string; data?: { text: string } }> {
    if (!snapshot || (!inCommunity(channel) && !partner)) return { status: 'not_configured', code: CODE.UNSUPPORTED };
    const config = hot.config;
    const labels = hot.prompts?.labels ?? {};
    const channelOf = (id: string): ConversationInfo | null =>
      String(id) === String(channel.id) ? channel : (snapshot.get(String(id)) ?? null);
    const profiles = typeof store.listUserProfiles === 'function' ? (store.listUserProfiles(guildId) ?? []) : [];
    const stored = new Map(profiles.filter((p) => p?.id).map((p) => [String(p?.id), p]));
    const nameOf = (id: string): string | null => {
      const names = stored.get(String(id))?.names;
      return (typeof names?.[0] === 'string' ? names[0] : null) ?? memberOf(guildId, String(id))?.name ?? null;
    };
    const settings = recallSettings(config);
    const timezone = config.bot?.timezone ?? 'UTC';
    return runConversationRead({
      args,
      labels,
      config,
      channelId: String(channel.id),
      channelNameOf: (id) => channelOf(id)?.name ?? null,
      allowed: (id) => {
        if (String(id) === String(channel.id) && inCommunity(channel)) return true;
        try {
          return (
            checkPull({
              snapshot,
              channelId: String(id),
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
      readRecord: ({ channelId, from }) =>
        config.features?.record === true
          ? recordMessages(record, guildId, { channelId, from, nameOf, selfName })
          : Promise.resolve([]),
      fetchLive: (request) => {
        const source = channelOf(request.channelId);
        // fetchSpan takes the request as it comes, its anchor included.
        return fetchSpan(
          ifaceReads,
          source ? conversationOf(source) : null,
          request as Parameters<typeof fetchSpan>[2]
        );
      },
      render: (slice: ReadonlyArray<ReadMessage>) => {
        let descriptions: unknown;
        if (config.features?.mediaDescriptions === true && typeof describer?.cachedDescriptions === 'function') {
          const { items, rest, emoji } = pullPictures(slice as Array<object>, 0);
          const wanted = [...items, ...rest, ...emoji];
          try {
            if (wanted.length > 0) descriptions = describer.cachedDescriptions(guildId, wanted) ?? undefined;
          } catch {
            descriptions = undefined;
          }
        }
        return {
          timezone,
          gapMinutes: config.context?.gapMarkerMinutes,
          maxChars: config.context?.maxMessageChars ?? 2000,
          selfName,
          labels,
          descriptions,
          seeReactions: config.features?.seeReactions !== false,
          reactionsPerMessage: config.context?.reactionsPerMessage,
        };
      },
      // The registry takes the lines the read hands it, as the read's own handles.
      refs: draft ? (searchHandles(draft) as HandleRefs) : null,
      now: clock(),
      timezone,
      maxChars: settings?.quoteMaxChars ?? RECALL_DEFAULTS.quoteMaxChars,
    });
  }

  return { inTurnTools };
}

/** The first link of a message that a page read can open (src/media/classify.js#collectReadableLinks). */
function firstReadableLink(message: object): string | undefined {
  return collectReadableLinks(message)[0]?.url;
}
