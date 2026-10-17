// Operations: `/nep task run|status|cancel|list`: the persona's errands handed to her agents
// (src/errands/, src/agent-runner/). Every member may use them while `features.memberCommands`
// is on (rights.member); the rest is ruled here, for every caller alike -- the owner's command,
// a member's, and the persona's own call (her skills: the requester of her turn is the caller).
// `task.run` with `agent: server` reads this machine, so only an owner may ask for it
// (`owner-only`); `agent: web` is any member's. A task asked in a private chat is `dm`-scoped,
// else `group`, and the runner withholds more in a filtered scope. `task.run` answers at once
// with the id and `queued`: the errand runs in the background (src/errands/service.js) and its
// end opens her own turn where it was asked. `task.cancel` is for the requester of the task or an
// owner; `task.status` and `task.list` show a private chat's tasks only to their requester or an
// owner. Answers are operator lines (ids, agents, states, ages), the goal cut to one short line;
// `task.status` of one task adds `ledger: <id>` when the task is mirrored into the ledger.
// `task.show <id>` (owner-only) reads one task of the ledger itself (any lane, by its ledger id)
// over `agents.ledger.socket` and prints it whole (src/errands/ledger-view.js#ledgerTaskText,
// every word from `labels.tasks.ledger`); a text longer than SHOW_INLINE_CHARS comes as a file
// attachment instead, with one short line. Without the socket, or when the ledger does not
// answer, it answers `labels.tasks.ledger.off`.

import { isOwnerId } from './grants.js';
import { TASK_AGENTS } from './catalog.js';
import { clampWithEllipsis, oneLine } from '../memory/clamp.js';
import { MINUTE_MS } from '../time.js';
import { defineOp, perEnv, invalid, denied } from './registry.js';
import { readLedger } from '../errands/ledger.js';
import { ledgerTaskText } from '../errands/ledger-view.js';
import { fill } from '../format.js';

/** How many tasks `task.list` shows. */
export const TASK_LIST_COUNT = 10;
/** The goal's length in an answer line (characters). */
const GOAL_LINE_CHARS = 80;
/**
 * The longest `task.show` text answered inline: the reply's chunk size
 * (interfaces/discord/commands.js REPLY_CHUNK_CHARS), which keeps a code-fenced reply under
 * Discord's 2000 characters; a longer one is a file attachment.
 */
export const SHOW_INLINE_CHARS = 1900;
/** The longest ledger task id `task.show` takes. */
const LEDGER_ID_CHARS = 64;

/** A label of `labels.tasks.ledger` filled, else `fallback` (a code, never wording). */
function ledgerLabel(labels, key, values, fallback) {
  const template = labels?.tasks?.ledger?.[key];
  return typeof template === 'string' && template ? fill(template, values) : fallback;
}

/** Whether a ledger refusal code says the task does not exist. */
function notFoundCode(code) {
  return /not[-_ ]?found|no[-_ ]?such|unknown[-_ ]?task/i.test(String(code ?? ''));
}

/** The refusal codes of the task store and service, as an operation's status. */
const REFUSALS = Object.freeze({
  'cap-open': 'failed',
  'cap-tasks': 'failed',
  'cap-usd': 'failed',
  'not-configured': 'failed',
  'no-guild': 'failed',
  'unknown-agent': 'invalid',
  'bad-goal': 'invalid',
});

const handlers = perEnv((env) => {
  const { hot, client, assertNotPaused, resolvedGuildId, now = Date.now } = env;

  /** The errand service, or an Error naming what is missing. */
  function errands() {
    if (!env.errands || typeof env.errands.submit !== 'function') throw Object.assign(new Error('the errand agents are not running'), { code: 'not-configured' });
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
    const codes = [...(task.error && task.state !== 'done' ? [task.error] : []), ...(task.filesExpired === true ? ['files-expired'] : [])];
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
    if (agent === 'server' && requester.kind !== 'owner') throw denied('only an owner may ask for the server agent', 'owner-only');
    const scope = inPrivate(context) ? 'dm' : 'group';
    const origin = { channelId: context?.channelId ? String(context.channelId) : null, messageId: context?.sourceMessageId ? String(context.sourceMessageId) : null };
    const submitted = errands().submit({ guildId: resolvedGuildId(context), agent, goal, requester, origin, scope });
    if (!submitted.ok) return refusal(submitted.code);
    const { task } = submitted;
    return { status: 'ok', code: 'ok', summary: `task ${task.id}: queued (${agent})`, data: { text: `task ${task.id}: queued (${agent})`, task: { id: task.id, agent, state: task.state } } };
  }

  /** `/nep task status [id]`: one task, or every open one. */
  function cmdStatus(args, context) {
    const store = errands().store(resolvedGuildId(context));
    if (!store) throw Object.assign(new Error('no guild'), { code: 'no-guild' });
    const id = String(args?.id ?? '').trim();
    if (id) {
      const task = store.get(id);
      if (!task || !mayView(task, context)) throw invalid(`no task ${id}`, 'not-found');
      const lines = [taskLine(task)];
      if (task.state === 'done' && task.result) {
        lines.push(`result: ${task.result.text ? `${task.result.text.length} chars` : 'empty'}, ${task.result.sources?.length ?? 0} sources, ${task.result.files?.length ?? 0} files`);
      }
      if (task.usage) lines.push(`usage: ${task.usage.steps ?? 0} steps, ${(task.usage.usd ?? 0).toFixed(3)} USD, ${Math.round(task.usage.seconds ?? 0)} s`);
      // The ledger's id of the task's mirror (src/errands/ledger.js), when it has one.
      if (task.ledgerId) lines.push(`ledger: ${task.ledgerId}`);
      return lines.join('\n');
    }
    const open = store.open().filter((task) => mayView(task, context));
    return open.length > 0 ? open.map(taskLine).join('\n') : 'no open tasks';
  }

  /** `/nep task cancel id`: for the requester of the task or an owner. */
  function cmdCancel(args, context) {
    const id = String(args?.id ?? '').trim();
    if (!id) throw invalid('an id is required');
    const service = errands();
    const store = service.store(resolvedGuildId(context));
    const task = store?.get(id) ?? null;
    if (!task || !mayView(task, context)) throw invalid(`no task ${id}`, 'not-found');
    const own = Boolean(context?.userId) && String(context.userId) === task.requester?.userId;
    const hers = context?.actor === 'persona' && task.requester?.kind === 'persona';
    if (!ownerCalls(context) && !own && !hers) throw denied('only the requester of the task or an owner may cancel it', 'not-requester');
    // Who cancelled it, for the ledger's close reason.
    const by = context?.actor === 'persona' ? 'persona' : ownerCalls(context) ? 'owner' : 'requester';
    const cancelled = service.cancel({ guildId: resolvedGuildId(context), id, by });
    if (!cancelled.ok) return { status: 'failed', code: cancelled.code, summary: `task ${id}: ${cancelled.code === 'not-open' ? `already ${task.state}` : cancelled.code}`, data: null };
    return `task ${id}: cancelled`;
  }

  /** `/nep task list`: the latest TASK_LIST_COUNT tasks, newest first. */
  function cmdList(args, context) {
    const store = errands().store(resolvedGuildId(context));
    if (!store) throw Object.assign(new Error('no guild'), { code: 'no-guild' });
    const tasks = store.recent(TASK_LIST_COUNT * 3).filter((task) => mayView(task, context)).slice(0, TASK_LIST_COUNT);
    return tasks.length > 0 ? tasks.map(taskLine).join('\n') : 'no tasks yet';
  }

  /**
   * `/nep task show id`: one ledger task whole (`task.show` over `agents.ledger.socket`, read now),
   * inline up to SHOW_INLINE_CHARS, else attached as `<id>.txt` with `labels.tasks.ledger.attached`.
   */
  async function cmdShow(args) {
    const labels = hot.prompts?.labels;
    const id = String(args?.id ?? '').trim();
    if (!id || id.length > LEDGER_ID_CHARS) throw invalid(ledgerLabel(labels, 'noId', {}, 'invalid-args'));
    const outcome = await readLedger(hot.config?.agents?.ledger?.socket ?? null, 'task.show', { id, full: true });
    if (!outcome.ok) {
      if (outcome.refused && notFoundCode(outcome.code)) return { status: 'invalid', code: 'not-found', summary: ledgerLabel(labels, 'notFound', { id }, 'not-found'), data: null };
      if (outcome.refused) return { status: 'failed', code: 'ledger-refused', summary: ledgerLabel(labels, 'refused', { code: outcome.code }, outcome.code), data: null };
      const code = outcome.code === 'off' ? 'ledger-off' : 'ledger-unreachable';
      return { status: 'failed', code, summary: ledgerLabel(labels, 'off', {}, code), data: null };
    }
    const text = ledgerTaskText(outcome.result, labels) || '-';
    if (text.length <= SHOW_INLINE_CHARS) return text;
    const name = `${id.replace(/[^A-Za-z0-9._-]/g, '_')}.txt`;
    return { text: ledgerLabel(labels, 'attached', { id, chars: text.length, file: name }, name), files: [{ attachment: Buffer.from(text, 'utf8'), name }] };
  }

  return { cmdRun, cmdStatus, cmdCancel, cmdList, cmdShow };
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
  name: 'task.show',
  rights: { kind: 'read', ownerOnly: true },
  run: (args, ctx) => handlers(ctx.env).cmdShow(args, ctx),
});
