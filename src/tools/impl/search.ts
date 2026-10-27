// Operations: the persona's in-turn tools as the owner's commands -- `web.search` (`/nep task
// search`: one web search through the existing engines, the results raw), `web.read` (`/nep task
// read`: one page's own text, cut, no summary), `media.look` (`/nep task look`: a picture or a
// video of a message looked at again with a question, through the describer's second look) and
// `memory.search` (`/nep memory search`: the server's own message history through the recall
// runner, quoted as it was, no summary) and `conversation.read` (a channel read in order, from the
// record and the interface's history; hers alone, no slash command: catalog.js `personaOnly`).
// Her own calls of them run inside her turn with its context (src/behavior/turn.js, the tool
// loop of features.coreTools); a command runs the same code (src/tools/tools.ts) over what an
// operation knows: the channel it was typed in, no chat window to leave out. Reads, open to
// every member while features.memberCommands is on (rights.member), as `errand.status` is.

import { firstLinkIn, runMediaFind, runMediaLook, runMemorySearch, runWebRead, runWebSearch } from '../tools.ts';
import { fetchSpan, recordMessages, runConversationRead } from '../conversation-read.ts';
import { RECALL_DEFAULTS, recallSettings } from '../../behavior/recall.js';
import { lineOf } from '../../behavior/line-of.js';
import { checkPull } from '../../behavior/pull-fetch.ts';
import { takeSnapshot } from '../../behavior/snapshot.ts';
import { messageRefOf } from './shared.ts';
import { defineOp, perEnv, invalid } from './registry.ts';
import { CODE } from '../codes.ts';
import { idText, objOf } from '../types.ts';
import type { Obj, OpContext, Untyped } from '../types.ts';

/** A tool result as the operation's: ok with its text; anything else `failed` with its code (`what` names the tool in the summary). */
function asOpResult(answer: unknown, what = 'search'): Obj {
  const result = objOf(answer);
  const text = idText(objOf(result.data).text);
  const code = typeof result.code === 'string' ? result.code : null;
  if (result.status === 'ok') return { status: 'ok', code: CODE.OK, summary: text, data: { text } };
  if (result.status === 'partial') return { status: 'partial', code: code ?? 'partial', summary: text, data: { text } };
  if (result.status === 'invalid') throw invalid(`not run: ${code ?? CODE.INVALID_ARGS}`, code ?? CODE.INVALID_ARGS);
  return {
    status: 'failed',
    code: code ?? CODE.ERROR,
    summary: `${what} not run: ${code ?? CODE.ERROR}`,
    data: null,
  };
}

const handlers = perEnv((env) => {
  const { hot, store, resolvedGuildId, now = Date.now } = env;
  const { reads } = env;

  /** The interface's name for the conversation the command or call came from. */
  const refOf = (context: { channelId?: string | null }): { iface: string; conversationId: string } => ({
    iface: (env.port?.iface as string | undefined) ?? '',
    conversationId: idText(context.channelId),
  });

  /** The whole `message.received` event of message `messageId` in the command's conversation, or null. */
  async function eventOf(messageId: unknown, context: { channelId?: string | null }): Promise<Untyped> {
    if (!context.channelId || !reads) return null;
    const found = await reads.fetchMessages(refOf(context), [idText(messageId)]);
    return found?.messages[0]?.event ?? null;
  }

  /** The conversation the command came from as the interface describes it, or null. */
  async function infoOf(context: OpContext) {
    if (!context?.channelId || !reads) return null;
    return (await reads.conversationInfo(refOf(context)))?.conversation ?? null;
  }

  /** `/nep task search query [goal]`. */
  async function cmdWebSearch(args: Obj, context: OpContext) {
    const result = await runWebSearch({
      lookup: env.lookup ?? null,
      config: hot.config,
      labels: hot.prompts?.labels ?? {},
      guildId: resolvedGuildId(context),
      args,
    });
    return asOpResult(result);
  }

  /**
   * The first http(s) link of the message `messageId` in the conversation the command or call came
   * from (its text, then its embeds), or null: what web.read reads when given a message.
   */
  async function linkOfMessage(messageId: string, context: OpContext): Promise<string | null> {
    const message = (await eventOf(messageId, context))?.message;
    if (!message) return null;
    const links: Array<Untyped> = Array.isArray(message.links) ? message.links : [];
    return (
      firstLinkIn(message.sourceText ?? message.content) ??
      links.map((link) => firstLinkIn(link?.url)).find(Boolean) ??
      null
    );
  }

  /** `/nep task read url`; the persona's call may name a message instead (`message`). */
  async function cmdWebRead(args: Obj, context: OpContext) {
    const result = await runWebRead({
      lookup: env.lookup ?? null,
      config: hot.config,
      labels: hot.prompts?.labels ?? {},
      guildId: resolvedGuildId(context),
      args,
      linkOf: (messageId) => linkOfMessage(messageId, context),
    });
    return asOpResult(result);
  }

  /**
   * The message `reference` names in the conversation the command came from (an id, or a message
   * link), as the line a turn sees (the interface's event through `lineOf`), or null.
   */
  async function normalizedMessage(reference: unknown, context: OpContext): Promise<unknown> {
    let ref: Awaited<ReturnType<typeof messageRefOf>>;
    try {
      ref = await messageRefOf(reference, reads);
    } catch {
      return null;
    }
    const event = await eventOf(ref.messageId, ref.channelId ? { channelId: ref.channelId } : context);
    return event ? lineOf(event) : null;
  }

  /** `/nep task look message question [item]`: the describer's second look with that question. */
  async function cmdMediaLook(args: Obj, context: OpContext) {
    const result = await runMediaLook({
      describer: env.describer ?? null,
      config: hot.config,
      labels: hot.prompts?.labels ?? {},
      guildId: resolvedGuildId(context),
      args,
      mediaOf: (messageId) => normalizedMessage(messageId, context),
    });
    return asOpResult(result, 'look');
  }

  /** `/nep memory search question [people] [channel] [when] [terms]`, in the channel it was typed in. */
  async function cmdMemorySearch(args: Obj, context: OpContext) {
    const channel = await infoOf(context);
    const guildId = resolvedGuildId(context);
    const snapshot = channel?.communityId != null && reads ? await takeSnapshot(reads, channel.communityId, []) : null;
    const result = await runMemorySearch({
      recall: env.recall ?? null,
      store,
      config: hot.config,
      labels: hot.prompts?.labels ?? {},
      guildId,
      snapshot,
      channel,
      selfId: env.selfId() ?? null,
      selfName: env.getSelfName(guildId),
      args,
      now: now(),
    });
    return asOpResult(result);
  }

  /** `/nep task find query [n]`: her GIF library searched by the stored descriptions. */
  function cmdMediaFind(args: Obj, context: OpContext) {
    return asOpResult(
      runMediaFind({
        store,
        config: hot.config,
        labels: hot.prompts?.labels ?? {},
        guildId: resolvedGuildId(context),
        args,
      }),
      'find'
    );
  }

  /**
   * `conversation.read` outside a turn (a command key `task.conversation`, never in the Discord tree): a
   * channel read in order (src/tools/conversation-read.ts), the lines rendered like the chat, without
   * handles (no turn to number them in). The channel the call came from by default; another must pass
   * the pull rail.
   */
  async function cmdConversationRead(args: Obj, context: OpContext) {
    const here = await infoOf(context);
    if (!here || here.communityId == null || !reads)
      return asOpResult({ status: 'not_configured', code: CODE.NOT_CONFIGURED }, 'conversation');
    const communityId = here.communityId;
    const snapshot = await takeSnapshot(reads, communityId, []);
    const config = hot.config;
    const labels = hot.prompts?.labels ?? {};
    const guildId = resolvedGuildId(context);
    const channelOf = (id: unknown): { name?: string | null } | null =>
      idText(id) === here.id ? here : (snapshot?.get(idText(id)) ?? null);
    const selfName = env.getSelfName(guildId);
    const nameOf = (id: unknown): string | null => env.memberNameOf(communityId, idText(id));
    const timezone = config.bot?.timezone ?? 'UTC';
    const result = await runConversationRead({
      args,
      labels,
      config,
      channelId: String(here.id),
      channelNameOf: (id) => channelOf(id)?.name ?? null,
      allowed: (id) =>
        String(id) === String(here.id) ||
        checkPull({ snapshot, channelId: String(id), destination: here, config, now: now() }).skip === null,
      readRecord: ({ channelId, from }) =>
        config.features?.record === true && env.record && guildId
          ? recordMessages(env.record, guildId, { channelId, from, nameOf, selfName })
          : Promise.resolve([]),
      fetchLive: (request) =>
        fetchSpan(
          reads,
          { iface: (env.port?.iface as string | undefined) ?? '', conversationId: request.channelId },
          {
            mode: request.mode,
            limit: request.limit,
            minTs: request.minTs,
            ...(request.anchor === null ? {} : { anchor: request.anchor }),
          }
        ),
      render: () => ({
        timezone,
        gapMinutes: config.context?.gapMarkerMinutes,
        maxChars: config.context?.maxMessageChars ?? 2000,
        selfName,
        labels,
        seeReactions: config.features?.seeReactions !== false,
        reactionsPerMessage: config.context?.reactionsPerMessage,
      }),
      now: now(),
      timezone,
      maxChars: recallSettings(config)?.quoteMaxChars ?? RECALL_DEFAULTS.quoteMaxChars,
    });
    return asOpResult(result, 'conversation');
  }

  return { cmdWebSearch, cmdWebRead, cmdMediaLook, cmdMediaFind, cmdMemorySearch, cmdConversationRead };
});

defineOp({
  name: 'web.search',
  rights: { kind: 'read', member: true },
  run: (args, ctx) => handlers(ctx.env).cmdWebSearch(args, ctx),
});
defineOp({
  name: 'web.read',
  rights: { kind: 'read', member: true },
  run: (args, ctx) => handlers(ctx.env).cmdWebRead(args, ctx),
});
defineOp({
  name: 'media.look',
  rights: { kind: 'read', member: true },
  run: (args, ctx) => handlers(ctx.env).cmdMediaLook(args, ctx),
});
defineOp({
  name: 'media.find',
  rights: { kind: 'read', member: true },
  run: (args, ctx) => handlers(ctx.env).cmdMediaFind(args, ctx),
});
defineOp({
  name: 'memory.search',
  rights: { kind: 'read', member: true },
  run: (args, ctx) => handlers(ctx.env).cmdMemorySearch(args, ctx),
});
defineOp({
  name: 'conversation.read',
  rights: { kind: 'read', member: true },
  run: (args, ctx) => handlers(ctx.env).cmdConversationRead(args, ctx),
});
