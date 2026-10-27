// Operations `intention.set`, `intention.update`, `intention.cancel` and `intention.list`, reached by
// `/nep task intent action:add|update|cancel|list`: the persona's intentions
// (src/intentions/, docs/inner-life.md). `intention.set` (a new one of hers, `pending`; its purpose
// the body of her call), `intention.update` (accept a candidate with `state:pending`, close one with
// `state:done`, drop it with `state:dropped` and a `reason:` (a desire she considered and let go; also
// `intention.set state:dropped reason:...` records one born dropped), edit its purpose, due time, expiry, destination, chain or completion condition, or
// set it waiting on an errand: `errand:<errand id>` and/or `deadline:`; a `deadline` without an errand
// waits on the errand her same turn hands off), `intention.cancel` (also how she rejects a
// candidate), `intention.list`. Her own state, so her own calls run on her grant alone
// (src/tools/impl/effects.ts#SELF_OWNED_OPS) under the gateway's rules on who asked; for people they are
// owner operations an owner may grant (no `member` right). A call never widens anything: a wait
// names only an errand the errand store holds, and a destination is only recorded; a candidate is
// accepted only where its origin allows (src/intentions/model.ts#acceptRefusal). An update or a
// cancel without `id=` whose body is one bare intention id takes that as the id (isIntentionId);
// any other body stays the update's purpose (or is ignored by the cancel). Off unless
// `features.intentions` is exactly true (read now): every action answers `feature-off`. Times are
// `<n>m`, `<n>h`, `<n>d` from now, an ISO date-time, or a wall clock in `bot.timezone` --
// `HH:MM`, `<weekday> HH:MM` (src/intentions/model.ts#parseWhen); `every=` (`day`, `week`, `<n>h`,
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

import { formatClock, formatDate } from '../../format.js';
import { clampWithEllipsis, oneLine } from '../../memory/clamp.js';
import { HEARTBEAT_ORIGIN, intentionsOn, isIntentionId, parseEvery, parseWhen } from '../../intentions/model.ts';
import { isOwnerId } from './grants.ts';
import { defineOp, perEnv, invalid } from './registry.ts';
import { CODE } from '../codes.ts';
import { idText } from '../types.ts';
import type { Obj, OpContext, Untyped } from '../types.ts';

/** The purpose's length in an answer line (characters). */
const PURPOSE_LINE_CHARS = 80;

/** The service's refusal codes that mean bad arguments rather than a failure. */
const INVALID = new Set([
  'no-purpose',
  'bad-due',
  'bad-every',
  'every-without-due',
  'bad-expiry',
  'due-after-expiry',
  'bad-deadline',
  'wait-without-errand',
  'no-errand',
  'errand-ended',
  'bad-move',
  'terminal',
  'not-found',
  'bad-attend',
  'attend-with-due',
  'attend-with-every',
  'not-attend',
  'reason-required',
]);

const handlers = perEnv((env) => {
  const { hot, resolvedGuildId, now = Date.now } = env;

  /** The intention service, or an Error naming what is missing. */
  function intentions() {
    if (!env.intentions || typeof env.intentions.set !== 'function')
      throw Object.assign(new Error('intentions are not running'), { code: CODE.NOT_CONFIGURED });
    return env.intentions;
  }

  /** The refusal with the switch off, or null. */
  function off() {
    return intentionsOn(hot.config)
      ? null
      : { status: 'failed', code: CODE.FEATURE_OFF, summary: 'intentions are off (features.intentions)', data: null };
  }

  /** Whether the conversation the command runs in is a private chat. */
  function inPrivate(context: OpContext) {
    if (context?.privateChat === true) return true;
    return context?.channelId ? env.directory.isPrivate(idText(context.channelId)) : false;
  }

  /** `args[key]` as a moment (parseWhen, the wall-clock forms in `bot.timezone`), undefined when not given; an `invalid` error when it does not parse. */
  function moment(args: Obj, key: string): number | undefined {
    const given = args[key];
    if (given === undefined || given === null || given === '') return undefined;
    const at = parseWhen(idText(given), now(), { timezone: hot.config?.bot?.timezone ?? 'UTC' });
    if (at === null)
      throw invalid(`${key}: a time like 30m, 6h, 2d, 21:00, mon 20:00 or an ISO date-time`, CODE.BAD_TIME);
    return at;
  }

  /** `args.every` as the record's recurrence (parseEvery), undefined when not given; an `invalid` error when it does not parse. */
  function every(args: Obj) {
    const text = args.every;
    if (text === undefined || text === null || text === '') return undefined;
    const parsed = parseEvery(text);
    if (!parsed.ok) throw invalid('every: day, week, <n>h, <n>d or none', CODE.BAD_EVERY);
    return parsed.every;
  }

  /** A text argument trimmed, undefined when not given. */
  function text(args: Obj, key: string): string | undefined {
    const value = args[key];
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
  }

  /** `args.people` as ids (comma or space separated; `<@id>` unwrapped), undefined when not given. */
  function peopleOf(args: Obj) {
    const value = text(args, 'people');
    if (value === undefined) return undefined;
    return value
      .split(/[\s,]+/)
      .map((token) => token.replace(/^<@!?(\d+)>$/, '$1').trim())
      .filter(Boolean);
  }

  /** `args[key]` as a whole number >= `min`, undefined when not given; an `invalid` error (`bad-attend`) otherwise. */
  function integer(args: Obj, key: string, min: number): number | undefined {
    const value = args[key];
    if (value === undefined || value === null || value === '') return undefined;
    const written = idText(value).trim();
    const n = typeof value === 'number' ? value : /^\d{1,9}$/.test(written) ? Number(written) : NaN;
    if (!Number.isInteger(n) || n < min) throw invalid(`${key}: a whole number of at least ${min}`, CODE.BAD_ATTEND);
    return n;
  }

  /** The attention arguments given (`people`, `settle`, `perday`), or null when none is. */
  function attendPatch(args: Obj) {
    const people = peopleOf(args);
    const settle = integer(args, 'settle', 0);
    const perDay = integer(args, 'perday', 1);
    if (people === undefined && settle === undefined && perDay === undefined) return null;
    return {
      ...(people !== undefined ? { people } : {}),
      ...(settle !== undefined ? { settle } : {}),
      ...(perDay !== undefined ? { perDay } : {}),
    };
  }

  /**
   * The id of `intention.update` / `intention.cancel`: `id` when given, else the call's body (its
   * `text`) when that is one bare token shaped like an intention id (isIntentionId): she wrote
   * the id in the body and nothing else. Any other body stays what it is (the update's purpose).
   * Returns `{ id, args }`, the args without the text that was the id.
   */
  function idOf(args: Obj) {
    const id = text(args, 'id');
    if (id) return { id, args };
    const body = text(args, 'text');
    if (body && isIntentionId(body)) return { id: body, args: { ...args, text: undefined } };
    return { id: undefined, args };
  }

  /**
   * The time of `ts` for an answer line: the date and the clock in `bot.timezone`, as the
   * `<intentions>` block writes them (src/intentions/blocks.ts#when), so a due she set reads
   * against the clock her prompt shows and never as a UTC figure she takes for a past moment.
   */
  function stamp(ts: number): string {
    const timezone = hot.config?.bot?.timezone ?? 'UTC';
    const locale = hot.prompts?.labels?.locale ?? 'en-US';
    return `${formatDate(ts, timezone, locale)} ${formatClock(ts, timezone, locale)}`;
  }

  /** One intention as an answer line. */
  function lineOf(record: Untyped): string {
    const parts = [`${record.id} ${record.status}`];
    // A dropped one is over: its reason and its purpose only, no due or expiry to act on.
    if (record.status === 'dropped')
      return `${parts[0]}, reason ${clampWithEllipsis(oneLine(record.reason ?? ''), PURPOSE_LINE_CHARS)}: ${clampWithEllipsis(oneLine(record.purpose), PURPOSE_LINE_CHARS)}`;
    if (Number.isFinite(record.dueAt)) parts.push(`due ${stamp(record.dueAt)}`);
    // A pending intention nothing wakes her for: said at once, so a due left in the purpose text is caught in the turn.
    else if (record.status === 'pending' && !record.every?.period && !record.attend?.place) parts.push('no due');
    if (record.every?.period) parts.push(`every ${record.every.period}`);
    if (record.attend?.place) {
      parts.push(`attend ${record.attend.place}`);
      if (record.attend.people.length > 0) parts.push(`people ${record.attend.people.join(',')}`);
      parts.push(`settle ${record.attend.settle}s`, `today ${record.attend.today?.wakes ?? 0}/${record.attend.perDay}`);
    }
    if (record.status === 'waiting')
      parts.push(`awaiting ${record.awaitingErrandId} until ${stamp(record.waitDeadline)}`);
    else if (record.outcome?.errandId) parts.push(`errand ${record.outcome.errandId} ${record.outcome.state}`);
    else if (record.note) parts.push(record.note);
    if (record.waitRequested) parts.push('wait asked');
    parts.push(`expires ${stamp(record.expiresAt)}`);
    return `${parts.join(', ')}: ${clampWithEllipsis(oneLine(record.purpose), PURPOSE_LINE_CHARS)}`;
  }

  /** A service answer as the operation's result. */
  function answer(result: Untyped, verb: string): Obj {
    if (result.ok) {
      const line = lineOf(result.intention);
      return {
        status: 'ok',
        code: CODE.OK,
        summary: `intention ${verb}: ${line}`,
        data: {
          text: `intention ${verb}: ${line}`,
          intention: { id: result.intention.id, status: result.intention.status },
        },
      };
    }
    const status = INVALID.has(result.code) ? 'invalid' : 'failed';
    // A heartbeat's cap names the open ones from heartbeats, so she can update or cancel one instead.
    const open =
      Array.isArray(result.open) && result.open.length > 0
        ? `; open from heartbeats: ${(result.open as Array<Untyped>).map((record: Untyped) => `${record.id} (${clampWithEllipsis(oneLine(record.purpose), PURPOSE_LINE_CHARS)}${record.every?.period ? `, every ${record.every.period}` : ''})`).join('; ')}`
        : '';
    return { status, code: result.code, summary: `intention not ${verb}: ${result.code}${open}`, data: null };
  }

  /** The members of the call's conversation: who asked, whom her turn answered, whom she mentioned. */
  function participantsOf(context: OpContext) {
    const ids = [
      context?.userId,
      context?.repliedAuthorId,
      ...(Array.isArray(context?.mentionUserIds) ? context.mentionUserIds : []),
    ];
    return [...new Set(ids.filter((id) => (typeof id === 'string' && id) || typeof id === 'number').map(String))];
  }

  /**
   * Where the caller is, for the service's visibility rule: an owner's own command sees every
   * intention; anyone else (her own call included) a private chat's only in that chat.
   */
  function whereOf(context: OpContext) {
    const owner = context?.actor !== 'persona' && isOwnerId(hot.config, context?.userId);
    return {
      all: owner,
      privateChannelId: !owner && inPrivate(context) && context?.channelId ? idText(context.channelId) : null,
    };
  }

  /** What the caller's context says about where and when the call came from. */
  function origin(context: OpContext) {
    const persona = context?.actor === 'persona';
    return {
      by: persona ? 'persona' : isOwnerId(hot.config, context?.userId) ? 'owner' : 'member',
      turnId: persona && context?.turnId ? idText(context.turnId) : null,
      messageId: context?.sourceMessageId ? idText(context.sourceMessageId) : null,
      channelId: context?.channelId ? idText(context.channelId) : null,
      scope: inPrivate(context) ? 'dm' : 'group',
      participants: participantsOf(context),
      // The engine's stamp: what her heartbeat turn creates (the wake kind comes from the envelope, never from her words).
      origin: persona && context?.wakeKind === HEARTBEAT_ORIGIN ? HEARTBEAT_ORIGIN : null,
    };
  }

  /** `intention.set`: a new intention, its purpose the text; with `attend` an attention on that place. */
  function cmdSet(args: Obj, context: OpContext): Obj {
    const refused = off();
    if (refused) return refused;
    const place = text(args, 'attend');
    const purpose = text(args, 'text') ?? place;
    if (!purpose) throw invalid('a purpose is required');
    const from = origin(context);
    const state = text(args, 'state');
    if (state !== undefined && state !== 'dropped') throw invalid('state must be dropped');
    const result = intentions().set(resolvedGuildId(context), {
      purpose,
      ...(state ? { state, reason: text(args, 'reason') ?? null } : {}),
      attend: place ? { place, ...(attendPatch(args) ?? {}) } : null,
      dueAt: moment(args, 'due') ?? null,
      every: every(args) ?? null,
      expiresAt: moment(args, 'expires') ?? null,
      destination: text(args, 'channelId') ?? null,
      completionCondition: text(args, 'condition') ?? null,
      chainId: text(args, 'chain') ?? null,
      errandId: text(args, 'errand') ?? null,
      deadline: moment(args, 'deadline') ?? null,
      ...from,
    });
    return answer(result, 'set');
  }

  /** `intention.update id ...` (the id alone in the body counts as `id`, idOf). */
  function cmdUpdate(given: Obj, context: OpContext): Obj {
    const refused = off();
    if (refused) return refused;
    const { id, args } = idOf(given);
    if (!id) throw invalid('an id is required');
    const state = text(args, 'state');
    if (state !== undefined && state !== 'pending' && state !== 'done' && state !== 'dropped')
      throw invalid('state must be pending, done or dropped');
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
      ...(text(args, 'errand') ? { errandId: text(args, 'errand') } : {}),
      ...(moment(args, 'deadline') !== undefined ? { deadline: moment(args, 'deadline') } : {}),
      ...(state ? { state } : {}),
      ...(state === 'dropped' ? { reason: text(args, 'reason') ?? null } : {}),
      turnId: from.turnId,
      by: from.by,
      // An inner turn's call (her own initiative) and its chain: which candidates it may accept.
      ...(context?.ownInitiative === true
        ? { initiative: true, callerChain: context?.chainId ? idText(context.chainId) : null }
        : {}),
      ...whereOf(context),
    });
    return answer(result, 'updated');
  }

  /** `intention.cancel id` (the id alone in the body counts as `id`, idOf). */
  function cmdCancel(given: Obj, context: OpContext): Obj {
    const refused = off();
    if (refused) return refused;
    const { id } = idOf(given);
    if (!id) throw invalid('an id is required');
    return answer(
      intentions().cancel(resolvedGuildId(context), id, { by: origin(context).by, ...whereOf(context) }),
      'cancelled'
    );
  }

  /** `intention.list`: the open intentions, a private chat's own only in that chat (an owner's command sees all). */
  function cmdList(args: Obj, context: OpContext): Obj | string {
    const refused = off();
    if (refused) return refused;
    const records = intentions().list(resolvedGuildId(context), whereOf(context));
    return records.length > 0 ? records.map(lineOf).join('\n') : 'no open intentions';
  }

  return { cmdSet, cmdUpdate, cmdCancel, cmdList };
});

defineOp({
  name: 'intention.set',
  rights: { kind: 'write' },
  run: (args, ctx) => handlers(ctx.env).cmdSet(args, ctx),
});
defineOp({
  name: 'intention.update',
  rights: { kind: 'write' },
  run: (args, ctx) => handlers(ctx.env).cmdUpdate(args, ctx),
});
defineOp({
  name: 'intention.cancel',
  rights: { kind: 'write' },
  run: (args, ctx) => handlers(ctx.env).cmdCancel(args, ctx),
});
defineOp({
  name: 'intention.list',
  rights: { kind: 'read' },
  run: (args, ctx) => handlers(ctx.env).cmdList(args, ctx),
});
