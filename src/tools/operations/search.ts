// Operations: the owner's `memory.search` (the server's own message history through the recall runner, quoted as it
// was, no summary), typed in a chat. The persona's other read tools (`web.search`, `web.read`, `media.look`,
// `media.find`, `conversation.read`, `memory.read`) and `person.link` run only inside their turn, over its context
// (src/turn/in-turn-tools.ts); called anywhere else they answer `unsupported`.

import { runMemorySearch } from '../tools.ts';
import { takeSnapshot } from '../../behavior/snapshot.ts';
import { defineOp, perEnv, invalid } from './registry.ts';
import { CODE } from '../codes.ts';
import { idText, objOf } from '../types.ts';
import type { Obj, OpContext } from '../types.ts';

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
  const { hot, store, resolvedPlaceId, now = Date.now } = env;
  const { reads } = env;

  /** The interface's name for a native chat. */
  const refOf = (chatId: string): { iface: string; chatId: string } => ({
    iface: (env.port?.iface as string | undefined) ?? '',
    chatId,
  });

  /** The chat the command came from as the interface describes it, or null. */
  async function infoOf(context: OpContext) {
    const here = env.chatOf(context);
    if (!here || !reads) return null;
    return (await reads.chatInfo(refOf(here)))?.chat ?? null;
  }

  /** `memory.search question [people] [channel] [when] [terms]`, in the channel it was typed in. */
  async function cmdMemorySearch(args: Obj, context: OpContext) {
    const channel = await infoOf(context);
    const placeId = resolvedPlaceId(context);
    const snapshot = channel?.rootId != null && reads ? await takeSnapshot(reads, channel.rootId, []) : null;
    const result = await runMemorySearch({
      recall: env.recall ?? null,
      store,
      config: hot.config,
      labels: hot.prompts?.labels ?? {},
      placeId,
      snapshot,
      channel,
      selfId: env.selfId() ?? null,
      selfName: env.getSelfName(placeId),
      args,
      now: now(),
    });
    return asOpResult(result);
  }

  return { cmdMemorySearch };
});

/**
 * A read the persona makes only inside a turn, over its place and its chat window (src/turn/in-turn-tools.ts): called
 * anywhere else it has no turn to read for and answers `unsupported`.
 */
function inTurnOnly(name: string, what: string): void {
  defineOp({
    name,
    rights: { kind: 'read' },
    run: () => asOpResult({ status: 'not_configured', code: CODE.UNSUPPORTED }, what),
  });
}

inTurnOnly('web.search', 'search');
inTurnOnly('web.read', 'search');
inTurnOnly('media.look', 'look');
inTurnOnly('media.find', 'find');
defineOp({
  name: 'memory.search',
  rights: { kind: 'read' },
  run: (args, ctx) => handlers(ctx.env).cmdMemorySearch(args, ctx),
});
inTurnOnly('conversation.read', 'conversation');
// The persona's read of what memory holds about one subject runs only inside a turn, under the turn's memory context
// (src/turn/memory-read.ts, through src/turn/in-turn-tools.ts); called anywhere else it has no context to read under.
defineOp({
  name: 'memory.read',
  rights: { kind: 'read' },
  run: () => asOpResult({ status: 'not_configured', code: CODE.UNSUPPORTED }, 'read'),
});
// The persona's link tool runs only inside a turn, over the account they talk with (src/interface/person-link.ts, through
// src/turn/in-turn-tools.ts); called anywhere else it has no conversation to link.
defineOp({
  name: 'person.link',
  rights: { kind: 'write' },
  run: () => asOpResult({ status: 'not_configured', code: CODE.UNSUPPORTED }, 'link'),
});
