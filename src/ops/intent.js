// Operations: `/nep task intent action:add|update|cancel|list` -- the persona's intentions
// (src/intentions/, docs/intentions.md): `intent.set` (a new one of hers, `pending`; its purpose
// the body of her call), `intent.update` (accept a candidate with `state:pending`, close one with
// `state:done`, edit its purpose, due time, expiry, destination, chain or completion condition, or
// set it waiting on an errand: `task:<errand id>` and/or `deadline:`; a `deadline` without a task
// waits on the errand her same turn hands off), `intent.cancel` (also how she rejects a
// candidate), `intent.list`. Her own state, so her own calls run on her grant alone
// (src/ops/effects.js#SELF_OWNED_OPS) under the gateway's rules on who asked; for people they are
// owner operations an owner may grant (no `member` right). A call never widens anything: a wait
// names only an errand the task store holds, and a destination is only recorded. Off unless
// `features.intentions` is exactly true (read now): every action answers `feature-off`. Times are
// `<n>m`, `<n>h`, `<n>d` from now or an ISO date-time (src/intentions/model.js#parseWhen).
// Answers are operator lines (ids, states, times), the purpose cut to one short line.

import { clampWithEllipsis, oneLine } from '../memory/clamp.js';
import { intentionsOn, parseWhen } from '../intentions/model.js';
import { isOwnerId } from './grants.js';
import { defineOp, perEnv, invalid } from './registry.js';

/** The purpose's length in an answer line (characters). */
const PURPOSE_LINE_CHARS = 80;

/** The service's refusal codes that mean bad arguments rather than a failure. */
const INVALID = new Set(['no-purpose', 'bad-due', 'bad-expiry', 'due-after-expiry', 'bad-deadline', 'wait-without-task', 'no-task', 'task-ended', 'bad-move', 'terminal', 'not-found']);

const handlers = perEnv((env) => {
  const { hot, client, resolvedGuildId, now = Date.now } = env;

  /** The intention service, or an Error naming what is missing. */
  function intentions() {
    if (!env.intentions || typeof env.intentions.set !== 'function') throw Object.assign(new Error('intentions are not running'), { code: 'not-configured' });
    return env.intentions;
  }

  /** The refusal with the switch off, or null. */
  function off() {
    return intentionsOn(hot.config) ? null : { status: 'failed', code: 'feature-off', summary: 'intentions are off (features.intentions)', data: null };
  }

  /** Whether the conversation the command runs in is a private chat. */
  function inPrivate(context) {
    if (context?.privateChat === true) return true;
    const channel = context?.channelId ? client?.channels?.cache?.get?.(String(context.channelId)) : null;
    return Boolean(channel) && !channel.guild;
  }

  /** `args[key]` as a moment (parseWhen), undefined when not given; an `invalid` error when it does not parse. */
  function moment(args, key) {
    const text = args?.[key];
    if (text === undefined || text === null || text === '') return undefined;
    const at = parseWhen(text, now());
    if (at === null) throw invalid(`${key}: a time like 30m, 6h, 2d or an ISO date-time`, 'bad-time');
    return at;
  }

  /** A text argument trimmed, undefined when not given. */
  function text(args, key) {
    const value = args?.[key];
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
  }

  /** The time of `ts` for an answer line (UTC, minutes). */
  function stamp(ts) {
    return new Date(ts).toISOString().slice(0, 16).replace('T', ' ');
  }

  /** One intention as an answer line. */
  function lineOf(record) {
    const parts = [`${record.id} ${record.status}`];
    if (Number.isFinite(record.dueAt)) parts.push(`due ${stamp(record.dueAt)}`);
    if (record.status === 'waiting') parts.push(`awaiting ${record.awaitingTaskId} until ${stamp(record.waitDeadline)}`);
    else if (record.outcome?.taskId) parts.push(`errand ${record.outcome.taskId} ${record.outcome.state}`);
    else if (record.note) parts.push(record.note);
    if (record.waitRequested) parts.push('wait asked');
    parts.push(`expires ${stamp(record.expiresAt)}`);
    return `${parts.join(', ')}: ${clampWithEllipsis(oneLine(record.purpose), PURPOSE_LINE_CHARS)}`;
  }

  /** A service answer as the operation's result. */
  function answer(result, verb) {
    if (result.ok) {
      const line = lineOf(result.intention);
      return { status: 'ok', code: 'ok', summary: `intention ${verb}: ${line}`, data: { text: `intention ${verb}: ${line}`, intention: { id: result.intention.id, status: result.intention.status } } };
    }
    const status = INVALID.has(result.code) ? 'invalid' : 'failed';
    return { status, code: result.code, summary: `intention not ${verb}: ${result.code}`, data: null };
  }

  /** What the caller's context says about where and when the call came from. */
  function origin(context) {
    const persona = context?.actor === 'persona';
    return {
      by: persona ? 'persona' : isOwnerId(hot.config, context?.userId) ? 'owner' : 'member',
      turnId: persona && context?.turnId ? String(context.turnId) : null,
      messageId: context?.sourceMessageId ? String(context.sourceMessageId) : null,
      channelId: context?.channelId ? String(context.channelId) : null,
      scope: inPrivate(context) ? 'dm' : 'group',
    };
  }

  /** `intent.set`: a new intention, its purpose the text. */
  function cmdSet(args, context) {
    const refused = off();
    if (refused) return refused;
    const purpose = text(args, 'text');
    if (!purpose) throw invalid('a purpose is required');
    const from = origin(context);
    const result = intentions().set(resolvedGuildId(context), {
      purpose,
      dueAt: moment(args, 'due') ?? null,
      expiresAt: moment(args, 'expires') ?? null,
      destination: text(args, 'channelId') ?? null,
      completionCondition: text(args, 'condition') ?? null,
      chainId: text(args, 'chain') ?? null,
      taskId: text(args, 'task') ?? null,
      deadline: moment(args, 'deadline') ?? null,
      ...from,
    });
    return answer(result, 'set');
  }

  /** `intent.update id ...`. */
  function cmdUpdate(args, context) {
    const refused = off();
    if (refused) return refused;
    const id = text(args, 'id');
    if (!id) throw invalid('an id is required');
    const state = text(args, 'state');
    if (state !== undefined && state !== 'pending' && state !== 'done') throw invalid('state must be pending or done');
    const from = origin(context);
    const due = moment(args, 'due');
    const result = intentions().update(resolvedGuildId(context), id, {
      ...(text(args, 'text') ? { purpose: text(args, 'text') } : {}),
      ...(due !== undefined ? { dueAt: due } : {}),
      ...(moment(args, 'expires') !== undefined ? { expiresAt: moment(args, 'expires') } : {}),
      ...(text(args, 'channelId') ? { destination: text(args, 'channelId') } : {}),
      ...(text(args, 'condition') ? { completionCondition: text(args, 'condition') } : {}),
      ...(text(args, 'chain') ? { chainId: text(args, 'chain') } : {}),
      ...(text(args, 'task') ? { taskId: text(args, 'task') } : {}),
      ...(moment(args, 'deadline') !== undefined ? { deadline: moment(args, 'deadline') } : {}),
      ...(state ? { state } : {}),
      turnId: from.turnId,
      by: from.by,
    });
    return answer(result, 'updated');
  }

  /** `intent.cancel id`. */
  function cmdCancel(args, context) {
    const refused = off();
    if (refused) return refused;
    const id = text(args, 'id');
    if (!id) throw invalid('an id is required');
    return answer(intentions().cancel(resolvedGuildId(context), id, { by: origin(context).by }), 'cancelled');
  }

  /** `intent.list`: the open intentions, a private chat's own only in that chat (an owner's command sees all). */
  function cmdList(args, context) {
    const refused = off();
    if (refused) return refused;
    const owner = context?.actor !== 'persona' && isOwnerId(hot.config, context?.userId);
    const privateChannelId = !owner && inPrivate(context) && context?.channelId ? String(context.channelId) : null;
    const records = owner ? intentions().list(resolvedGuildId(context), { all: true }) : intentions().list(resolvedGuildId(context), { privateChannelId });
    return records.length > 0 ? records.map(lineOf).join('\n') : 'no open intentions';
  }

  return { cmdSet, cmdUpdate, cmdCancel, cmdList };
});

defineOp({
  name: 'intent.set',
  rights: { kind: 'write' },
  run: (args, ctx) => handlers(ctx.env).cmdSet(args, ctx),
});
defineOp({
  name: 'intent.update',
  rights: { kind: 'write' },
  run: (args, ctx) => handlers(ctx.env).cmdUpdate(args, ctx),
});
defineOp({
  name: 'intent.cancel',
  rights: { kind: 'write' },
  run: (args, ctx) => handlers(ctx.env).cmdCancel(args, ctx),
});
defineOp({
  name: 'intent.list',
  rights: { kind: 'read' },
  run: (args, ctx) => handlers(ctx.env).cmdList(args, ctx),
});
