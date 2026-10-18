// Operations: the persona's in-turn tools as the owner's commands -- `web.search` (`/nep task
// search`: one web search through the existing engines, the results raw), `web.read` (`/nep task
// read`: one page's own text, cut, no summary) and `memory.search` (`/nep memory search`:
// the server's own message history through the recall runner, quoted as it was, no summary).
// Her own calls of them run inside her turn with its context (src/behavior/turn.js, the tool
// loop of features.coreTools); a command runs the same code (src/skills/tools.js) over what an
// operation knows: the channel it was typed in, no chat window to leave out. Reads, open to
// every member while features.memberCommands is on (rights.member), as `task.status` is.

import { firstLinkIn, runMemorySearch, runWebRead, runWebSearch } from '../skills/tools.js';
import { defineOp, perEnv, invalid } from './registry.js';

/** A tool result as the operation's: ok with its text; anything else `failed` with its code. */
function asOpResult(result) {
  const text = String(result?.data?.text ?? '');
  if (result?.status === 'ok') return { status: 'ok', code: 'ok', summary: text, data: { text } };
  if (result?.status === 'invalid') throw invalid(`not run: ${result.code ?? 'invalid-args'}`, result.code ?? 'invalid-args');
  return { status: 'failed', code: String(result?.code ?? 'error'), summary: `search not run: ${result?.code ?? 'error'}`, data: null };
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

  return { cmdWebSearch, cmdWebRead, cmdMemorySearch };
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
  name: 'memory.search',
  rights: { kind: 'read', member: true },
  run: (args, ctx) => handlers(ctx.env).cmdMemorySearch(args, ctx),
});
