// Operations `errand.run`, `errand.status`, `errand.cancel`, `errand.list`, `errand.read` and `errand.resolve`, reached by
// `/nep task run|status|cancel|list|result|resolve`: the persona's errands handed to her agents
// (src/errands/, src/agent-runner/). Every member may use them while `features.memberCommands`
// is on (rights.member); the rest is ruled here, for every caller alike -- the owner's command,
// a member's, and the persona's own call (her skills: the requester of her turn is the caller).
// `errand.run` with `agent: server` reads this machine, so only an owner may ask for it
// (`owner-only`); `agent: scout` is any member's. An errand asked in a private chat is `dm`-scoped,
// else `group`, and the runner withholds more in a filtered scope. `errand.run` answers at once
// with the id and `queued`: the errand runs in the background (src/errands/service.ts) and its
// end opens her own turn where it was asked. `errand.cancel` is for the requester of the errand or an
// owner; `errand.status` and `errand.list` show a private chat's errands only to their requester or an
// owner. A finished errand's result stays until she has read it: `errand.status` without an id lists the
// open errands and the finished ones not read yet; `errand.read id [from]` returns the whole result in
// pages of `errands.resultMaxChars` (the error, the sources and the files with their handles and
// whether they expired come with the first page) and marks the errand read when its last page is
// returned; `errand.resolve id` closes a finished errand (read too). Both follow the same view rule. Answers are operator lines (ids, agents, states, ages), the goal cut to one short line;
// `errand.status` of one errand adds `ledger: <id>` when the errand is mirrored into the ledger. A
// `errand.run` of her turn links the intentions of that turn waiting for its errand (src/intentions/).

import { isOwnerId } from './grants.ts';
import { TASK_AGENTS } from './catalog.ts';
import { clampWithEllipsis, oneLine } from '../../memory/clamp.js';
import { MINUTE_MS } from '../../time.js';
import { fileHandle, isOpenState } from '../../errands/store.ts';
import { DEFAULT_RESULT_MAX_CHARS } from '../../errands/blocks.ts';
import { defineOp, perEnv, invalid, denied } from './registry.ts';
import { CODE } from '../codes.ts';
import { idText, textOf } from '../types.ts';
import type { Obj, OpContext } from '../types.ts';
import type { ErrandRecord, ErrandService } from '../../errands/types.ts';

/** How many errands `errand.list` shows. */
export const ERRAND_LIST_COUNT = 10;
/** The goal's length in an answer line (characters). */
const GOAL_LINE_CHARS = 80;

/** The refusal codes of the errand store and service, as an operation's status. */
const REFUSALS = Object.freeze({
  [CODE.CAP_OPEN]: 'failed',
  [CODE.CAP_TASKS]: 'failed',
  [CODE.NOT_CONFIGURED]: 'failed',
  [CODE.NO_GUILD]: 'failed',
  [CODE.UNKNOWN_AGENT]: 'invalid',
  [CODE.BAD_GOAL]: 'invalid',
});

const handlers = perEnv((env) => {
  const { hot, assertNotPaused, resolvedGuildId, now = Date.now } = env;

  /** The errand service, or an Error naming what is missing. */
  function errands(): ErrandService {
    if (!env.errands || typeof env.errands.submit !== 'function')
      throw Object.assign(new Error('the errand agents are not running'), { code: CODE.NOT_CONFIGURED });
    return env.errands;
  }

  /** Whether the caller is an owner (`bot.owners`, read now). */
  function ownerCalls(context: OpContext) {
    return isOwnerId(hot.config, context?.userId);
  }

  /** Who asks: an owner, a member, or the persona on her own (her call with nobody asking). */
  function requesterOf(context: OpContext) {
    const userId = context?.userId ? idText(context.userId) : null;
    if (!userId) return { userId: null, kind: context?.actor === 'persona' ? 'persona' : 'member' };
    return { userId, kind: ownerCalls(context) ? 'owner' : 'member' };
  }

  /** Whether the conversation the command runs in is a private chat. */
  function inPrivate(context: OpContext) {
    if (context?.privateChat === true) return true;
    return context?.channelId ? env.directory.isPrivate(idText(context.channelId)) : false;
  }

  /** Whether the caller may see `errand`: a group errand anyone; a private chat's only its requester or an owner. */
  function mayView(errand: ErrandRecord, context: OpContext): boolean {
    if (errand.scope !== 'dm') return true;
    return ownerCalls(context) || (Boolean(context?.userId) && idText(context.userId) === errand.requester?.userId);
  }

  /** One line of an errand: id, agent, state (with the error code and `files-expired`), age, goal. */
  function errandLine(errand: ErrandRecord): string {
    const minutes = Math.max(0, Math.floor((now() - (errand.createdAt ?? now())) / MINUTE_MS));
    const codes = [
      ...(errand.error && errand.state !== 'done' ? [errand.error] : []),
      ...(errand.filesExpired === true ? ['files-expired'] : []),
    ];
    const state = codes.length > 0 ? `${errand.state} (${codes.join(', ')})` : errand.state;
    return `${errand.id} ${errand.agent} ${state} ${minutes}m: ${clampWithEllipsis(oneLine(errand.goal), GOAL_LINE_CHARS)}`;
  }

  /** A refusal of the store or the service as the operation's result. */
  function refusal(code: string, errand?: ErrandRecord): Obj {
    const status = REFUSALS[code] ?? 'failed';
    return { status, code, summary: `task not started: ${code}`, data: errand ? { task: errand } : null };
  }

  /** `/nep task run agent goal`: a new errand, answered at once with its id and `queued`. */
  function cmdRun(args: Obj, context: OpContext) {
    assertNotPaused();
    const agent = textOf(args.agent).trim();
    if (!TASK_AGENTS.includes(agent)) throw invalid(`agent must be one of: ${TASK_AGENTS.join(', ')}`);
    const goal = textOf(args.goal).trim();
    if (!goal) throw invalid('a goal is required');
    const requester = requesterOf(context);
    // Only an owner may have this machine read, through the persona or not.
    if (agent === 'server' && requester.kind !== 'owner')
      throw denied('only an owner may ask for the server agent', CODE.OWNER_ONLY);
    const scope = inPrivate(context) ? 'dm' : 'group';
    // Her own call carries its turn and its idempotency key (src/tools/executors.ts); a command neither.
    const persona = context?.actor === 'persona';
    const origin = {
      channelId: context?.channelId ? idText(context.channelId) : null,
      messageId: context?.sourceMessageId ? idText(context.sourceMessageId) : null,
      ...(persona && context?.turnId ? { turnId: idText(context.turnId) } : {}),
    };
    const idempotencyKey = persona && typeof context?.idempotencyKey === 'string' ? context.idempotencyKey : null;
    const submitted = errands().submit({
      guildId: resolvedGuildId(context),
      agent,
      goal,
      requester,
      origin,
      scope,
      idempotencyKey,
    });
    if (!submitted.ok) return refusal(submitted.code);
    const { errand } = submitted;
    // An intention of the same turn waiting for the errand it hands off is linked to it now
    // (src/intentions/service.ts#linkTurnErrand); a refused errand above links nothing.
    if (origin.turnId)
      env.intentions?.linkTurnErrand?.(resolvedGuildId(context), { turnId: origin.turnId, errandId: errand.id });
    return {
      status: 'ok',
      code: CODE.OK,
      summary: `task ${errand.id}: queued (${agent})`,
      data: { text: `task ${errand.id}: queued (${agent})`, task: { id: errand.id, agent, state: errand.state } },
    };
  }

  /** `/nep task status [id]`: one errand, or every open one. */
  function cmdStatus(args: Obj, context: OpContext) {
    const store = errands().store(resolvedGuildId(context));
    if (!store) throw Object.assign(new Error('no guild'), { code: CODE.NO_GUILD });
    const id = textOf(args.id).trim();
    if (id) {
      const errand = store.get(id);
      if (!errand || !mayView(errand, context)) throw invalid(`no task ${id}`, CODE.NOT_FOUND);
      const lines = [errandLine(errand)];
      if (errand.state === 'done' && errand.result) {
        lines.push(
          `result: ${errand.result.text ? `${errand.result.text.length} chars` : 'empty'}, ${errand.result.sources?.length ?? 0} sources, ${errand.result.files?.length ?? 0} files`
        );
      }
      if (errand.usage)
        lines.push(
          `usage: ${errand.usage.steps ?? 0} steps, ${(errand.usage.usd ?? 0).toFixed(3)} USD, ${Math.round(errand.usage.seconds ?? 0)} s`
        );
      // The ledger's id of the errand's mirror (src/errands/ledger.ts), when it has one.
      if (errand.ledgerId) lines.push(`ledger: ${errand.ledgerId}`);
      return lines.join('\n');
    }
    // The open errands, then the finished ones she has not read (their result is still waiting).
    const listed = [...store.open(), ...store.unread()].filter((errand) => mayView(errand, context));
    return listed.length > 0
      ? listed
          .map((errand) => (isOpenState(errand.state) ? errandLine(errand) : `${errandLine(errand)} (unread)`))
          .join('\n')
      : 'no open tasks';
  }

  /** A finished errand of the caller's view, or an `invalid` error: not found, not viewable, still open. */
  function finishedErrand(args: Obj, context: OpContext) {
    const store = errands().store(resolvedGuildId(context));
    if (!store) throw Object.assign(new Error('no guild'), { code: CODE.NO_GUILD });
    const id = textOf(args.id).trim();
    if (!id) throw invalid('an id is required');
    const errand = store.get(id);
    if (!errand || !mayView(errand, context)) throw invalid(`no task ${id}`, CODE.NOT_FOUND);
    if (isOpenState(errand.state)) throw invalid(`task ${id} is still ${errand.state}`);
    return { store, errand };
  }

  /** `errand.read id [from]`: a finished errand's result in a page of `errands.resultMaxChars` characters. */
  function cmdRead(args: Obj, context: OpContext) {
    const { store, errand } = finishedErrand(args, context);
    const configured = hot.config?.errands?.resultMaxChars;
    const page = Number.isInteger(configured) && configured > 0 ? configured : DEFAULT_RESULT_MAX_CHARS;
    const text = typeof errand.result?.text === 'string' ? errand.result.text : '';
    const from = args.from === undefined || args.from === null || args.from === '' ? 0 : Number(args.from);
    if (!Number.isInteger(from) || from < 0 || (from > 0 && from >= text.length))
      throw invalid(`from must be between 0 and ${Math.max(0, text.length - 1)}`);
    const to = Math.min(text.length, from + page);
    const lines = [errandLine(errand)];
    if (from === 0) {
      if (errand.error && errand.state !== 'done') lines.push(`error: ${errand.error}`);
      const listedSources = errand.result?.sources;
      const sources = Array.isArray(listedSources)
        ? listedSources.filter((url) => typeof url === 'string' && url !== '')
        : [];
      for (const [i, url] of sources.entries()) lines.push(`source ${i + 1}: ${url}`);
      const listedFiles = errand.result?.files;
      for (const file of Array.isArray(listedFiles) ? listedFiles : []) {
        if (!file || typeof file.name !== 'string') continue;
        const meta = `${file.contentType || '-'}, ${Number(file.bytes) || 0} bytes`;
        lines.push(
          errand.filesExpired === true
            ? `file: ${file.name} (${meta}) expired, no handle`
            : `file: ${fileHandle(errand.id, file.name)} (${meta})`
        );
      }
    }
    lines.push(text ? `result: characters ${from}-${to} of ${text.length}` : 'result: empty');
    if (text) lines.push(text.slice(from, to));
    const more = to < text.length;
    if (more) lines.push(`next: from=${to}`);
    // Read when the last page is in her hands.
    else store.markRead(errand.id);
    return lines.join('\n');
  }

  /** `errand.resolve id`: a finished errand closed, its result dealt with. */
  function cmdResolve(args: Obj, context: OpContext) {
    const { store, errand } = finishedErrand(args, context);
    store.resolve(errand.id);
    store.markRead(errand.id);
    return `task ${errand.id}: resolved`;
  }

  /** `/nep task cancel id`: for the requester of the errand or an owner. */
  function cmdCancel(args: Obj, context: OpContext) {
    const id = textOf(args.id).trim();
    if (!id) throw invalid('an id is required');
    const service = errands();
    const store = service.store(resolvedGuildId(context));
    const errand = store?.get(id) ?? null;
    if (!errand || !mayView(errand, context)) throw invalid(`no task ${id}`, CODE.NOT_FOUND);
    const own = Boolean(context?.userId) && idText(context.userId) === errand.requester?.userId;
    const hers = context?.actor === 'persona' && errand.requester?.kind === 'persona';
    if (!ownerCalls(context) && !own && !hers)
      throw denied('only the requester of the task or an owner may cancel it', CODE.NOT_REQUESTER);
    // Who cancelled it, for the ledger's close reason.
    const by = context?.actor === 'persona' ? 'persona' : ownerCalls(context) ? 'owner' : 'requester';
    const cancelled = service.cancel({ guildId: resolvedGuildId(context), id, by });
    if (!cancelled.ok)
      return {
        status: 'failed',
        code: cancelled.code,
        summary: `task ${id}: ${cancelled.code === CODE.NOT_OPEN ? `already ${errand.state}` : cancelled.code}`,
        data: null,
      };
    return `task ${id}: cancelled`;
  }

  /** `/nep task list`: the latest ERRAND_LIST_COUNT errands, newest first. */
  function cmdList(args: Obj, context: OpContext) {
    const store = errands().store(resolvedGuildId(context));
    if (!store) throw Object.assign(new Error('no guild'), { code: CODE.NO_GUILD });
    const latest = store
      .recent(ERRAND_LIST_COUNT * 3)
      .filter((errand) => mayView(errand, context))
      .slice(0, ERRAND_LIST_COUNT);
    return latest.length > 0 ? latest.map((errand) => errandLine(errand)).join('\n') : 'no tasks yet';
  }

  return { cmdRun, cmdStatus, cmdCancel, cmdList, cmdRead, cmdResolve };
});

defineOp({
  name: 'errand.run',
  rights: { kind: 'write', member: true },
  run: (args, ctx) => handlers(ctx.env).cmdRun(args, ctx),
});
defineOp({
  name: 'errand.status',
  rights: { kind: 'read', member: true },
  run: (args, ctx) => handlers(ctx.env).cmdStatus(args, ctx),
});
defineOp({
  name: 'errand.cancel',
  rights: { kind: 'write', member: true },
  run: (args, ctx) => handlers(ctx.env).cmdCancel(args, ctx),
});
defineOp({
  name: 'errand.list',
  rights: { kind: 'read', member: true },
  run: (args, ctx) => handlers(ctx.env).cmdList(args, ctx),
});
defineOp({
  name: 'errand.read',
  rights: { kind: 'read', member: true },
  run: (args, ctx) => handlers(ctx.env).cmdRead(args, ctx),
});
defineOp({
  name: 'errand.resolve',
  rights: { kind: 'write', member: true },
  run: (args, ctx) => handlers(ctx.env).cmdResolve(args, ctx),
});
