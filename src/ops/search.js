// Operations: the persona's in-turn tools as the owner's commands -- `web.search` (`/nep task
// search`: one web search through the existing engines, the results raw), `web.read` (`/nep task
// read`: one page's own text, cut, no summary), `media.look` (`/nep task look`: a picture or a
// video of a message looked at again with a question, through the describer's second look) and
// `memory.search` (`/nep memory search`: the server's own message history through the recall
// runner, quoted as it was, no summary).
// Her own calls of them run inside her turn with its context (src/behavior/turn.js, the tool
// loop of features.coreTools); a command runs the same code (src/skills/tools.js) over what an
// operation knows: the channel it was typed in, no chat window to leave out. Reads, open to
// every member while features.memberCommands is on (rights.member), as `task.status` is.

import { firstLinkIn, runMediaLook, runMemorySearch, runWebRead, runWebSearch } from '../skills/tools.js';
import { defineOp, perEnv, invalid } from './registry.js';

/** A tool result as the operation's: ok with its text; anything else `failed` with its code (`what` names the tool in the summary). */
function asOpResult(result, what = 'search') {
  const text = String(result?.data?.text ?? '');
  if (result?.status === 'ok') return { status: 'ok', code: 'ok', summary: text, data: { text } };
  if (result?.status === 'invalid') throw invalid(`not run: ${result.code ?? 'invalid-args'}`, result.code ?? 'invalid-args');
  return { status: 'failed', code: String(result?.code ?? 'error'), summary: `${what} not run: ${result?.code ?? 'error'}`, data: null };
}

const handlers = perEnv((env) => {
  const { hot, store, client, resolvedGuildId, now = Date.now } = env;

  /** `/nep task search query [goal]`. */
  async function cmdWebSearch(args, context) {
    const result = await runWebSearch({ lookup: env.lookup ?? null, config: hot.config, labels: hot.prompts?.labels ?? {}, guildId: resolvedGuildId(context), args });
    return asOpResult(result);
  }

  /**
   * The first http(s) link of the message `messageId` in the channel the command or call came
   * from (its text, then its embeds), or null: what web.read reads when given a message.
   */
  async function linkOfMessage(messageId, context) {
    const channel = context?.channelId ? (client?.channels?.cache?.get?.(String(context.channelId)) ?? null) : null;
    if (typeof channel?.messages?.fetch !== 'function') return null;
    let message;
    try {
      message = await channel.messages.fetch(String(messageId));
    } catch {
      return null;
    }
    const embeds = Array.isArray(message?.embeds) ? message.embeds : [];
    return firstLinkIn(message?.content) ?? embeds.map((embed) => firstLinkIn(embed?.url)).find(Boolean) ?? null;
  }

  /** `/nep task read url`; the persona's call may name a message instead (`message`). */
  async function cmdWebRead(args, context) {
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
   * The message `reference` names in the channel the command came from (an id, or a message
   * link: its last id), normalized as a turn sees it (the interface's fetchMessage and
   * normalizeMessage, `env.discord`), or null.
   */
  async function normalizedMessage(reference, context) {
    const channel = context?.channelId ? (client?.channels?.cache?.get?.(String(context.channelId)) ?? null) : null;
    const discord = env.discord;
    const id = /(\d+)\D*$/.exec(String(reference ?? '').trim())?.[1] ?? null;
    if (!channel || !id || typeof discord?.fetchMessage !== 'function' || typeof discord.normalizeMessage !== 'function') return null;
    const raw = await discord.fetchMessage(channel, id);
    if (!raw) return null;
    const options = typeof discord.normalizeOptions === 'function' ? discord.normalizeOptions(hot.config) : {};
    return discord.normalizeMessage(raw, client?.user?.id ?? null, options);
  }

  /** `/nep task look message question [item]`: the describer's second look with that question. */
  async function cmdMediaLook(args, context) {
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
  async function cmdMemorySearch(args, context) {
    const channel = context?.channelId ? (client?.channels?.cache?.get?.(String(context.channelId)) ?? null) : null;
    const result = await runMemorySearch({
      recall: env.recall ?? null,
      store,
      config: hot.config,
      labels: hot.prompts?.labels ?? {},
      guild: channel?.guild ?? null,
      guildId: resolvedGuildId(context),
      channel,
      selfId: client?.user?.id ?? null,
      selfName: channel?.guild?.members?.me?.displayName ?? client?.user?.username ?? '',
      args,
      now: now(),
    });
    return asOpResult(result);
  }

  return { cmdWebSearch, cmdWebRead, cmdMediaLook, cmdMemorySearch };
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
  name: 'memory.search',
  rights: { kind: 'read', member: true },
  run: (args, ctx) => handlers(ctx.env).cmdMemorySearch(args, ctx),
});
