// Operations: `/nep task intent action:add|update|cancel|list` -- the persona's intentions
// (src/intentions/, docs/intentions.md): `intent.set` (a new one of hers, `pending`; its purpose
// the body of her call), `intent.update` (accept a candidate with `state:pending`, close one with
// `state:done`, edit its purpose, due time, expiry, destination, chain or completion condition, or
// set it waiting on an errand: `task:<errand id>` and/or `deadline:`; a `deadline` without a task
// waits on the errand her same turn hands off), `intent.cancel` (also how she rejects a
// candidate), `intent.list`. Her own state, so her own calls run on her grant alone
// (src/ops/effects.js#SELF_OWNED_OPS) under the gateway's rules on who asked; for people they are
// owner operations an owner may grant (no `member` right). A call never widens anything: a wait
// names only an errand the task store holds, and a destination is only recorded; a candidate is
// accepted only where its origin allows (src/intentions/model.js#acceptRefusal). An update or a
// cancel without `id=` whose body is one bare intention id takes that as the id (isIntentionId);
// any other body stays the update's purpose (or is ignored by the cancel). Off unless
// `features.intentions` is exactly true (read now): every action answers `feature-off`. Times are
// `<n>m`, `<n>h`, `<n>d` from now, an ISO date-time, or a wall clock in `bot.timezone` --
// `HH:MM`, `<weekday> HH:MM` (src/intentions/model.js#parseWhen); `every=` (`day`, `week`, `<n>h`,
// `<n>d`; `none` on an update) makes an intention recurring (model.js#parseEvery). `attend=<place>`
// makes an attention (docs/inner-life.md "Her attention"): the place's address (a channel option,
// so her `#handle` resolves as any channel argument does), `people=` (ids, comma or space
// separated; her `@handle`s are resolved to ids before the call reaches here), `settle=` seconds
// and `perday=` her own daily bound (defaults `innerLife.attention.settleSeconds` /
// `perDayDefault`; the option is lowercase as Discord wants it, the record's field is `perDay`);
// the body is its purpose, the place's address when she gives none. An update may change
// `people`, `settle`, `perday` and `expires`; `due=` and `every=` on an attention are
// refused (`attend-with-due`, `attend-with-every`).
// Answers are operator lines (ids, states, times, the recurrence, the place), the purpose cut to one short line.

import { clampWithEllipsis, oneLine } from '../memory/clamp.js';
import { intentionsOn, isIntentionId, parseEvery, parseWhen } from '../intentions/model.js';
import { isOwnerId } from './grants.js';
import { defineOp, perEnv, invalid } from './registry.js';

/** The purpose's length in an answer line (characters). */
const PURPOSE_LINE_CHARS = 80;

/** The service's refusal codes that mean bad arguments rather than a failure. */
const INVALID = new Set(['no-purpose', 'bad-due', 'bad-every', 'every-without-due', 'bad-expiry', 'due-after-expiry', 'bad-deadline', 'wait-without-task', 'no-task', 'task-ended', 'bad-move', 'terminal', 'not-found', 'bad-attend', 'attend-with-due', 'attend-with-every', 'not-attend']);

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

  /** `args[key]` as a moment (parseWhen, the wall-clock forms in `bot.timezone`), undefined when not given; an `invalid` error when it does not parse. */
  function moment(args, key) {
    const text = args?.[key];
    if (text === undefined || text === null || text === '') return undefined;
    const at = parseWhen(text, now(), { timezone: hot.config?.bot?.timezone ?? 'UTC' });
    if (at === null) throw invalid(`${key}: a time like 30m, 6h, 2d, 21:00, mon 20:00 or an ISO date-time`, 'bad-time');
    return at;
  }

  /** `args.every` as the record's recurrence (parseEvery), undefined when not given; an `invalid` error when it does not parse. */
  function every(args) {
    const text = args?.every;
    if (text === undefined || text === null || text === '') return undefined;
    const parsed = parseEvery(text);
    if (!parsed.ok) throw invalid('every: day, week, <n>h, <n>d or none', 'bad-every');
    return parsed.every;
  }

  /** A text argument trimmed, undefined when not given. */
  function text(args, key) {
    const value = args?.[key];
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
  }

  /** `args.people` as ids (comma or space separated; `<@id>` unwrapped), undefined when not given. */
  function peopleOf(args) {
    const value = text(args, 'people');
    if (value === undefined) return undefined;
    return value.split(/[\s,]+/).map((token) => token.replace(/^<@!?(\d+)>$/, '$1').trim()).filter(Boolean);
  }

  /** `args[key]` as a whole number >= `min`, undefined when not given; an `invalid` error (`bad-attend`) otherwise. */
  function integer(args, key, min) {
    const value = args?.[key];
    if (value === undefined || value === null || value === '') return undefined;
    const n = typeof value === 'number' ? value : /^\d{1,9}$/.test(String(value).trim()) ? Number(String(value).trim()) : NaN;
    if (!Number.isInteger(n) || n < min) throw invalid(`${key}: a whole number of at least ${min}`, 'bad-attend');
    return n;
  }

  /** The attention arguments given (`people`, `settle`, `perday`), or null when none is. */
  function attendPatch(args) {
    const people = peopleOf(args);
    const settle = integer(args, 'settle', 0);
    const perDay = integer(args, 'perday', 1);
    if (people === undefined && settle === undefined && perDay === undefined) return null;
    return { ...(people !== undefined ? { people } : {}), ...(settle !== undefined ? { settle } : {}), ...(perDay !== undefined ? { perDay } : {}) };
  }

  /**
   * The id of `intent.update` / `intent.cancel`: `id` when given, else the call's body (its
   * `text`) when that is one bare token shaped like an intention id (isIntentionId): she wrote
   * the id in the body and nothing else. Any other body stays what it is (the update's purpose).
   * Returns `{ id, args }`, the args without the text that was the id.
   */
  function idOf(args) {
    const id = text(args, 'id');
    if (id) return { id, args };
    const body = text(args, 'text');
    if (body && isIntentionId(body)) return { id: body, args: { ...args, text: undefined } };
    return { id: undefined, args };
  }

  /** The time of `ts` for an answer line (UTC, minutes). */
  function stamp(ts) {
    return new Date(ts).toISOString().slice(0, 16).replace('T', ' ');
  }

  /** One intention as an answer line. */
  function lineOf(record) {
    const parts = [`${record.id} ${record.status}`];
    if (Number.isFinite(record.dueAt)) parts.push(`due ${stamp(record.dueAt)}`);
    if (record.every?.period) parts.push(`every ${record.every.period}`);
    if (record.attend?.place) {
      parts.push(`attend ${record.attend.place}`);
      if (record.attend.people.length > 0) parts.push(`people ${record.attend.people.join(',')}`);
      parts.push(`settle ${record.attend.settle}s`, `today ${record.attend.today?.wakes ?? 0}/${record.attend.perDay}`);
    }
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

  /** The members of the call's conversation: who asked, whom her turn answered, whom she mentioned. */
  function participantsOf(context) {
    const ids = [context?.userId, context?.repliedAuthorId, ...(Array.isArray(context?.mentionUserIds) ? context.mentionUserIds : [])];
    return [...new Set(ids.filter((id) => (typeof id === 'string' && id) || typeof id === 'number').map(String))];
  }

  /**
   * Where the caller is, for the service's visibility rule: an owner's own command sees every
   * intention; anyone else (her own call included) a private chat's only in that chat.
   */
  function whereOf(context) {
    const owner = context?.actor !== 'persona' && isOwnerId(hot.config, context?.userId);
    return { all: owner, privateChannelId: !owner && inPrivate(context) && context?.channelId ? String(context.channelId) : null };
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
      participants: participantsOf(context),
    };
  }

  /** `intent.set`: a new intention, its purpose the text; with `attend` an attention on that place. */
  function cmdSet(args, context) {
    const refused = off();
    if (refused) return refused;
    const place = text(args, 'attend');
    const purpose = text(args, 'text') ?? place;
    if (!purpose) throw invalid('a purpose is required');
    const from = origin(context);
    const result = intentions().set(resolvedGuildId(context), {
      purpose,
      attend: place ? { place, ...(attendPatch(args) ?? {}) } : null,
      dueAt: moment(args, 'due') ?? null,
      every: every(args) ?? null,
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

  /** `intent.update id ...` (the id alone in the body counts as `id`, idOf). */
  function cmdUpdate(given, context) {
    const refused = off();
    if (refused) return refused;
    const { id, args } = idOf(given);
    if (!id) throw invalid('an id is required');
    const state = text(args, 'state');
    if (state !== undefined && state !== 'pending' && state !== 'done') throw invalid('state must be pending or done');
    const from = origin(context);
    const due = moment(args, 'due');
    const recurrence = every(args);
    const attend = attendPatch(args);
    const result = intentions().update(resolvedGuildId(context), id, {
      ...(text(args, 'text') ? { purpose: text(args, 'text') } : {}),
      ...(due !== undefined ? { dueAt: due } : {}),
      ...(recurrence !== undefined ? { every: recurrence } : {}),
      ...(attend ? { attend } : {}),
      ...(moment(args, 'expires') !== undefined ? { expiresAt: moment(args, 'expires') } : {}),
      ...(text(args, 'channelId') ? { destination: text(args, 'channelId') } : {}),
      ...(text(args, 'condition') ? { completionCondition: text(args, 'condition') } : {}),
      ...(text(args, 'chain') ? { chainId: text(args, 'chain') } : {}),
      ...(text(args, 'task') ? { taskId: text(args, 'task') } : {}),
      ...(moment(args, 'deadline') !== undefined ? { deadline: moment(args, 'deadline') } : {}),
      ...(state ? { state } : {}),
      turnId: from.turnId,
      by: from.by,
      // An inner turn's call (her own initiative) and its chain: which candidates it may accept.
      ...(context?.ownInitiative === true ? { initiative: true, callerChain: context?.chainId ? String(context.chainId) : null } : {}),
      ...whereOf(context),
    });
    return answer(result, 'updated');
  }

  /** `intent.cancel id` (the id alone in the body counts as `id`, idOf). */
  function cmdCancel(given, context) {
    const refused = off();
    if (refused) return refused;
    const { id } = idOf(given);
    if (!id) throw invalid('an id is required');
    return answer(intentions().cancel(resolvedGuildId(context), id, { by: origin(context).by, ...whereOf(context) }), 'cancelled');
  }

  /** `intent.list`: the open intentions, a private chat's own only in that chat (an owner's command sees all). */
  function cmdList(args, context) {
    const refused = off();
    if (refused) return refused;
    const records = intentions().list(resolvedGuildId(context), whereOf(context));
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
