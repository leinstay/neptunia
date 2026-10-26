// Operations: `/nep task run|status|cancel|list|result|resolve`: the persona's errands handed to her agents
// (src/errands/, src/agent-runner/). Every member may use them while `features.memberCommands`
// is on (rights.member); the rest is ruled here, for every caller alike -- the owner's command,
// a member's, and the persona's own call (her skills: the requester of her turn is the caller).
// `task.run` with `agent: server` reads this machine, so only an owner may ask for it
// (`owner-only`); `agent: scout` is any member's. A task asked in a private chat is `dm`-scoped,
// else `group`, and the runner withholds more in a filtered scope. `task.run` answers at once
// with the id and `queued`: the errand runs in the background (src/errands/service.js) and its
// end opens her own turn where it was asked. `task.cancel` is for the requester of the task or an
// owner; `task.status` and `task.list` show a private chat's tasks only to their requester or an
// owner. A finished task's result stays until she has read it: `task.status` without an id lists the
// open tasks and the finished ones not read yet; `task.read id [from]` returns the whole result in
// pages of `agents.resultMaxChars` (the error, the sources and the files with their handles and
// whether they expired come with the first page) and marks the task read when its last page is
// returned; `task.resolve id` closes a finished task (read too). Both follow the same view rule. Answers are operator lines (ids, agents, states, ages), the goal cut to one short line;
// `task.status` of one task adds `ledger: <id>` when the task is mirrored into the ledger. A
// `task.run` of her turn links the intentions of that turn waiting for its errand (src/intentions/).

import { isOwnerId } from './grants.js';
import { TASK_AGENTS } from './catalog.js';
import { clampWithEllipsis, oneLine } from '../memory/clamp.js';
import { MINUTE_MS } from '../time.js';
import { fileHandle, isOpenState } from '../errands/store.js';
import { DEFAULT_RESULT_MAX_CHARS } from '../errands/blocks.js';
import { defineOp, perEnv, invalid, denied } from './registry.js';
import { CODE } from '../skills/codes.js';

/** How many tasks `task.list` shows. */
export const TASK_LIST_COUNT = 10;
/** The goal's length in an answer line (characters). */
const GOAL_LINE_CHARS = 80;

/** The refusal codes of the task store and service, as an operation's status. */
const REFUSALS = Object.freeze({
  [CODE.CAP_OPEN]: 'failed',
  [CODE.CAP_TASKS]: 'failed',
  [CODE.NOT_CONFIGURED]: 'failed',
  [CODE.NO_GUILD]: 'failed',
  [CODE.UNKNOWN_AGENT]: 'invalid',
  [CODE.BAD_GOAL]: 'invalid',
});

const handlers = perEnv((env) => {
  const { hot, client, assertNotPaused, resolvedGuildId, now = Date.now } = env;

  /** The errand service, or an Error naming what is missing. */
  function errands() {
    if (!env.errands || typeof env.errands.submit !== 'function')
      throw Object.assign(new Error('the errand agents are not running'), { code: CODE.NOT_CONFIGURED });
    return env.errands;
  }

  /** Whether the caller is an owner (`bot.owners`, read now). */
  function ownerCalls(context) {
    return isOwnerId(hot.config, context?.userId);
  }

  /** Who asks: an owner, a member, or the persona on her own (her call with nobody asking). */
  function requesterOf(context) {
    const userId = context?.userId ? String(context.userId) : null;
    if (!userId) return { userId: null, kind: context?.actor === 'persona' ? 'persona' : 'member' };
    return { userId, kind: ownerCalls(context) ? 'owner' : 'member' };
  }

  /** Whether the conversation the command runs in is a private chat. */
  function inPrivate(context) {
    if (context?.privateChat === true) return true;
    const channel = context?.channelId ? client?.channels?.cache?.get?.(String(context.channelId)) : null;
    return Boolean(channel) && !channel.guild;
  }

  /** Whether the caller may see `task`: a group task anyone; a private chat's only its requester or an owner. */
  function mayView(task, context) {
    if (task.scope !== 'dm') return true;
    return ownerCalls(context) || (Boolean(context?.userId) && String(context.userId) === task.requester?.userId);
  }

  /** One line of a task: id, agent, state (with the error code and `files-expired`), age, goal. */
  function taskLine(task) {
    const minutes = Math.max(0, Math.floor((now() - (task.createdAt ?? now())) / MINUTE_MS));
    const codes = [
      ...(task.error && task.state !== 'done' ? [task.error] : []),
      ...(task.filesExpired === true ? ['files-expired'] : []),
    ];
    const state = codes.length > 0 ? `${task.state} (${codes.join(', ')})` : task.state;
    return `${task.id} ${task.agent} ${state} ${minutes}m: ${clampWithEllipsis(oneLine(task.goal), GOAL_LINE_CHARS)}`;
  }

  /** A refusal of the store or the service as the operation's result. */
  function refusal(code, task) {
    const status = REFUSALS[code] ?? 'failed';
    return { status, code, summary: `task not started: ${code}`, data: task ? { task } : null };
  }

  /** `/nep task run agent goal`: a new errand, answered at once with its id and `queued`. */
  function cmdRun(args, context) {
    assertNotPaused();
    const agent = String(args?.agent ?? '').trim();
    if (!TASK_AGENTS.includes(agent)) throw invalid(`agent must be one of: ${TASK_AGENTS.join(', ')}`);
    const goal = String(args?.goal ?? '').trim();
    if (!goal) throw invalid('a goal is required');
    const requester = requesterOf(context);
    // Only an owner may have this machine read, through the persona or not.
    if (agent === 'server' && requester.kind !== 'owner')
      throw denied('only an owner may ask for the server agent', CODE.OWNER_ONLY);
    const scope = inPrivate(context) ? 'dm' : 'group';
    // Her own call carries its turn and its idempotency key (src/skills/executors.js); a command neither.
    const persona = context?.actor === 'persona';
    const origin = {
      channelId: context?.channelId ? String(context.channelId) : null,
      messageId: context?.sourceMessageId ? String(context.sourceMessageId) : null,
      ...(persona && context?.turnId ? { turnId: String(context.turnId) } : {}),
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
    const { task } = submitted;
    // An intention of the same turn waiting for the errand it hands off is linked to it now
    // (src/intentions/service.js#linkTurnTask); a refused errand above links nothing.
    if (origin.turnId)
      env.intentions?.linkTurnTask?.(resolvedGuildId(context), { turnId: origin.turnId, taskId: task.id });
    return {
      status: 'ok',
      code: CODE.OK,
      summary: `task ${task.id}: queued (${agent})`,
      data: { text: `task ${task.id}: queued (${agent})`, task: { id: task.id, agent, state: task.state } },
    };
  }

  /** `/nep task status [id]`: one task, or every open one. */
  function cmdStatus(args, context) {
    const store = errands().store(resolvedGuildId(context));
    if (!store) throw Object.assign(new Error('no guild'), { code: CODE.NO_GUILD });
    const id = String(args?.id ?? '').trim();
    if (id) {
      const task = store.get(id);
      if (!task || !mayView(task, context)) throw invalid(`no task ${id}`, CODE.NOT_FOUND);
      const lines = [taskLine(task)];
      if (task.state === 'done' && task.result) {
        lines.push(
          `result: ${task.result.text ? `${task.result.text.length} chars` : 'empty'}, ${task.result.sources?.length ?? 0} sources, ${task.result.files?.length ?? 0} files`
        );
      }
      if (task.usage)
        lines.push(
          `usage: ${task.usage.steps ?? 0} steps, ${(task.usage.usd ?? 0).toFixed(3)} USD, ${Math.round(task.usage.seconds ?? 0)} s`
        );
      // The ledger's id of the task's mirror (src/errands/ledger.js), when it has one.
      if (task.ledgerId) lines.push(`ledger: ${task.ledgerId}`);
      return lines.join('\n');
    }
    // The open tasks, then the finished ones she has not read (their result is still waiting).
    const listed = [...store.open(), ...store.unread()].filter((task) => mayView(task, context));
    return listed.length > 0
      ? listed.map((task) => (isOpenState(task.state) ? taskLine(task) : `${taskLine(task)} (unread)`)).join('\n')
      : 'no open tasks';
  }

  /** A finished task of the caller's view, or an `invalid` error: not found, not viewable, still open. */
  function finishedTask(args, context) {
    const store = errands().store(resolvedGuildId(context));
    if (!store) throw Object.assign(new Error('no guild'), { code: CODE.NO_GUILD });
    const id = String(args?.id ?? '').trim();
    if (!id) throw invalid('an id is required');
    const task = store.get(id);
    if (!task || !mayView(task, context)) throw invalid(`no task ${id}`, CODE.NOT_FOUND);
    if (isOpenState(task.state)) throw invalid(`task ${id} is still ${task.state}`);
    return { store, task };
  }

  /** `task.read id [from]`: a finished task's result in a page of `agents.resultMaxChars` characters. */
  function cmdRead(args, context) {
    const { store, task } = finishedTask(args, context);
    const configured = hot.config?.agents?.resultMaxChars;
    const page = Number.isInteger(configured) && configured > 0 ? configured : DEFAULT_RESULT_MAX_CHARS;
    const text = typeof task.result?.text === 'string' ? task.result.text : '';
    const from = args?.from === undefined || args?.from === null || args?.from === '' ? 0 : Number(args.from);
    if (!Number.isInteger(from) || from < 0 || (from > 0 && from >= text.length))
      throw invalid(`from must be between 0 and ${Math.max(0, text.length - 1)}`);
    const to = Math.min(text.length, from + page);
    const lines = [taskLine(task)];
    if (from === 0) {
      if (task.error && task.state !== 'done') lines.push(`error: ${task.error}`);
      const sources = Array.isArray(task.result?.sources)
        ? task.result.sources.filter((url) => typeof url === 'string' && url)
        : [];
      for (const [i, url] of sources.entries()) lines.push(`source ${i + 1}: ${url}`);
      for (const file of Array.isArray(task.result?.files) ? task.result.files : []) {
        if (!file || typeof file.name !== 'string') continue;
        const meta = `${file.contentType || '-'}, ${Number(file.bytes) || 0} bytes`;
        lines.push(
          task.filesExpired === true
            ? `file: ${file.name} (${meta}) expired, no handle`
            : `file: ${fileHandle(task.id, file.name)} (${meta})`
        );
      }
    }
    lines.push(text ? `result: characters ${from}-${to} of ${text.length}` : 'result: empty');
    if (text) lines.push(text.slice(from, to));
    const more = to < text.length;
    if (more) lines.push(`next: from=${to}`);
    // Read when the last page is in her hands.
    else store.markRead(task.id);
    return lines.join('\n');
  }

  /** `task.resolve id`: a finished task closed, its result dealt with. */
  function cmdResolve(args, context) {
    const { store, task } = finishedTask(args, context);
    store.resolve(task.id);
    store.markRead(task.id);
    return `task ${task.id}: resolved`;
  }

  /** `/nep task cancel id`: for the requester of the task or an owner. */
  function cmdCancel(args, context) {
    const id = String(args?.id ?? '').trim();
    if (!id) throw invalid('an id is required');
    const service = errands();
    const store = service.store(resolvedGuildId(context));
    const task = store?.get(id) ?? null;
    if (!task || !mayView(task, context)) throw invalid(`no task ${id}`, CODE.NOT_FOUND);
    const own = Boolean(context?.userId) && String(context.userId) === task.requester?.userId;
    const hers = context?.actor === 'persona' && task.requester?.kind === 'persona';
    if (!ownerCalls(context) && !own && !hers)
      throw denied('only the requester of the task or an owner may cancel it', CODE.NOT_REQUESTER);
    // Who cancelled it, for the ledger's close reason.
    const by = context?.actor === 'persona' ? 'persona' : ownerCalls(context) ? 'owner' : 'requester';
    const cancelled = service.cancel({ guildId: resolvedGuildId(context), id, by });
    if (!cancelled.ok)
      return {
        status: 'failed',
        code: cancelled.code,
        summary: `task ${id}: ${cancelled.code === CODE.NOT_OPEN ? `already ${task.state}` : cancelled.code}`,
        data: null,
      };
    return `task ${id}: cancelled`;
  }

  /** `/nep task list`: the latest TASK_LIST_COUNT tasks, newest first. */
  function cmdList(args, context) {
    const store = errands().store(resolvedGuildId(context));
    if (!store) throw Object.assign(new Error('no guild'), { code: CODE.NO_GUILD });
    const tasks = store
      .recent(TASK_LIST_COUNT * 3)
      .filter((task) => mayView(task, context))
      .slice(0, TASK_LIST_COUNT);
    return tasks.length > 0 ? tasks.map(taskLine).join('\n') : 'no tasks yet';
  }

  return { cmdRun, cmdStatus, cmdCancel, cmdList, cmdRead, cmdResolve };
});

defineOp({
  name: 'task.run',
  rights: { kind: 'write', member: true },
  run: (args, ctx) => handlers(ctx.env).cmdRun(args, ctx),
});
defineOp({
  name: 'task.status',
  rights: { kind: 'read', member: true },
  run: (args, ctx) => handlers(ctx.env).cmdStatus(args, ctx),
});
defineOp({
  name: 'task.cancel',
  rights: { kind: 'write', member: true },
  run: (args, ctx) => handlers(ctx.env).cmdCancel(args, ctx),
});
defineOp({
  name: 'task.list',
  rights: { kind: 'read', member: true },
  run: (args, ctx) => handlers(ctx.env).cmdList(args, ctx),
});
defineOp({
  name: 'task.read',
  rights: { kind: 'read', member: true },
  run: (args, ctx) => handlers(ctx.env).cmdRead(args, ctx),
});
defineOp({
  name: 'task.resolve',
  rights: { kind: 'write', member: true },
  run: (args, ctx) => handlers(ctx.env).cmdResolve(args, ctx),
});
