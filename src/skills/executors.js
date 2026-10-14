// What one `<call>` of the persona's output (src/llm/parse.js) does once the gateway
// (src/skills/gateway.js#checkSkill) let it pass. Her skills are the owner's /nep commands
// (src/skills/derive.js): a call names an operation and gives the options of the command that
// runs it as attributes. Two steps. `resolveCall` turns the tag's string attributes into the
// command's arguments on the server's side -- a channel reference she sees (`#name`, `<#id>` or an
// id) into a channel id, a member's name or mention into a stored profile's id, a role into its
// id, a transcript number `#N` or a message link (a `message` or `reply` option) into that
// message's id and channel, a whole number or `true` / `false` read strictly -- so nothing the model writes is
// taken as an id unchecked. `executeCall` then runs the operation through its slash command's own
// path (src/admin.js#runCommand: the requester's rights checked again, as for their own command),
// the persona as the actor; its answer -- an error or a refusal included -- is the text the owner
// would see. Every result is `{ status, code?, data? }`, structured and honest (RESULT_STATUSES):
// `ok` only when the operation answered ok; `denied` (a rule said no), `invalid` (the call was
// not right), `not_configured` (what it needs is not set up), `unknown` (it may have taken effect:
// never retried), `partial`, `failed`. Codes are kebab-case; no wording here: the persona reads a
// result through `labels.skills.result`.

import { clampWithEllipsis, oneLine } from '../memory/clamp.js';
import { matchChannel, MESSAGE_LINK_RE } from '../memory/mentions.js';
import { SELF_OWNED_OPS } from '../ops/effects.js';

/** The options whose value may be a transcript number `#N`: a message she can see. */
const MESSAGE_OPTIONS = Object.freeze(['message', 'reply']);

/** The operations whose success is its own answer: a message or a picture that went out. */
export const QUIET_ON_OK = Object.freeze(['message.create', 'message.edit', 'message.delete', 'message.react.add', 'message.react.remove', 'draw.create']);

/** The operations whose `text` is the persona's own writing, posted as a `<msg>` of hers is (mentions, custom emoji, links). */
const WRITTEN = Object.freeze(['message.create', 'message.edit']);

/** Every status a call result may have. */
export const RESULT_STATUSES = Object.freeze(['ok', 'denied', 'not_configured', 'invalid', 'unknown', 'partial', 'failed']);

/** The operation codes that mean what it needs is not set up (a missing channel, client, interface or guild). */
const NOT_CONFIGURED_CODES = Object.freeze(['not-configured', 'unsupported', 'no-guild']);

/** The refusal codes of a call that was not right, as opposed to a rule that said no. */
const INVALID_CODES = Object.freeze(['invalid-args', 'unknown-skill', 'unknown-member', 'unknown-message', 'target-ambiguous', 'unknown-op', 'not-found']);

/** Milliseconds a call may run before its outcome is `unknown` (`skills.callTimeoutMs`; config.json's value). */
const CALL_TIMEOUT_MS = 120_000;

/**
 * The structured status of a refusal made before anything ran (resolveCall's, the gateway's):
 * `invalid` for a call that was not right, else `denied`.
 * @param {string} code
 * @returns {'invalid'|'denied'}
 */
export function refusalStatus(code) {
  return INVALID_CODES.includes(code) ? 'invalid' : 'denied';
}

/** A refusal of the call before or instead of its execution. */
function refused(code, reason = '') {
  return { ok: false, code, reason };
}

/** NFC, lower case, trimmed: how names are compared. */
function folded(value) {
  return String(value ?? '').normalize('NFC').trim().toLocaleLowerCase();
}

/** The id inside a channel reference `<#id>` or a bare id of digits, else null. */
function channelIdOf(reference) {
  const match = /^<#(\d+)>$/.exec(reference) ?? /^(\d+)$/.exec(reference);
  return match ? match[1] : null;
}

/**
 * The conversation id a channel reference (`#name`, `name`, `<#id>`, an id) names among
 * `conversations` (`{ id, name }`, one entry per id): a name by src/memory/mentions.js#matchChannel
 * (the exact name, else the one channel with the same core: other or no leading emoji, any case
 * and accents). `'ambiguous'` when several share it, null when none.
 */
function conversationIdOf(reference, conversations) {
  const given = String(reference ?? '').trim();
  if (!given) return null;
  const id = channelIdOf(given);
  if (id) return id;
  const unique = new Map();
  for (const c of conversations ?? []) if (c && c.id !== undefined && c.id !== null && !unique.has(String(c.id))) unique.set(String(c.id), { id: String(c.id), name: c.name });
  const match = matchChannel(given.replace(/^#/, ''), unique.values());
  return match === 'ambiguous' ? 'ambiguous' : (match?.id ?? null);
}

/** The id of a role reference (`<@&id>` or an id), or of the one role of `roles` by that name; else null. */
function roleIdOf(reference, roles) {
  const given = String(reference ?? '').trim();
  const match = /^<@&(\d+)>$/.exec(given) ?? /^(\d+)$/.exec(given);
  if (match) return match[1];
  const name = folded(given.replace(/^@/, ''));
  const ids = new Set((Array.isArray(roles) ? roles : []).filter((role) => typeof role?.name === 'string' && folded(role.name) === name).map((role) => String(role.id)));
  return ids.size === 1 ? [...ids][0] : null;
}

/** The transcript number of `#N` / `N` (six digits at most: never a platform id), else null. */
function transcriptNumber(value) {
  const match = /^#?(\d{1,6})$/.exec(String(value ?? '').trim());
  return match ? Number(match[1]) : null;
}

/** The stored member a name or mention (`<@id>`, `<@!id>`, `@name`, an id) names, `{ id }` or a refusal. */
function memberOf(reference, members) {
  const given = String(reference ?? '').trim();
  const list = Array.isArray(members) ? members : [];
  const mention = /^<@!?(\d+)>$/.exec(given) ?? /^(\d+)$/.exec(given);
  if (mention) return list.some((member) => String(member?.id) === mention[1]) ? { id: mention[1] } : refused('unknown-member', 'id');
  const name = folded(given.replace(/^@/, ''));
  if (!name) return refused('unknown-member', 'empty');
  const ids = new Set();
  for (const member of list) {
    const names = [...(Array.isArray(member?.names) ? member.names : []), ...(Array.isArray(member?.aliases) ? member.aliases.map((alias) => alias?.name) : [])];
    if (names.some((candidate) => typeof candidate === 'string' && folded(candidate) === name)) ids.add(String(member.id));
  }
  if (ids.size === 1) return { id: [...ids][0] };
  return refused('unknown-member', ids.size > 1 ? 'ambiguous' : 'name');
}

/**
 * One `<call>` (`{ skill, args, body }`, src/llm/parse.js) as the arguments of the command behind
 * the skill (`view.skills`: the registry), keyed by the command's option names, or the refusal:
 * `unknown-skill` (no such skill), `invalid-args` (an attribute the command does not take, a body
 * where it has no `text` option, the text given twice, a channel or role nobody has),
 * `target-ambiguous` (a channel name several share), `unknown-member` (no stored profile by that
 * name, or several), `unknown-message` (a `#N` not in this turn's transcript, or in another
 * channel than the one named), `not-own-message` (`message.edit` / `message.delete` of a line that
 * is not hers). A `#N` of a `message` or `reply` option becomes the line's message id and, when
 * the command has a `channel` option the call left out, its channel; a reply records the replied
 * author. A Discord message link there (MESSAGE_LINK_RE, bare or in angle brackets) becomes its
 * message id and names its channel the same way (`unknown-message` when the call named another);
 * any other value -- a raw message id -- is passed on as written. Pure.
 * @param {{ skill: string, args: Record<string, string>, body: string }} call
 * @param {{ skills: Map<string, object>, conversations?: { id: string, name: string }[],
 *   messageAt?: (n: number) => ({ id: string, conversationId: string, authorId: string|null, self?: boolean } | null),
 *   members?: { id: string, names?: string[], aliases?: { name: string }[] }[], roles?: { id: string, name: string }[],
 *   selfId?: string|null }} view
 * @returns {{ ok: true, skill: string, args: object, command: object, repliedAuthorId: string|null }
 *   | { ok: false, code: string, reason: string }}
 */
export function resolveCall(call, view) {
  const name = String(call?.skill ?? '');
  const skill = view?.skills?.get?.(name);
  if (!skill?.command) return refused('unknown-skill', name);
  const { command } = skill;
  const byName = new Map(command.options.map((option) => [option.name, option]));
  const given = { ...(call?.args ?? {}) };
  for (const key of Object.keys(given)) if (!byName.has(key)) return refused('invalid-args', `args.${key}:unknown`);
  const body = typeof call?.body === 'string' ? call.body.trim() : '';
  if (body) {
    if (!command.body) return refused('invalid-args', 'args:body');
    if (Object.hasOwn(given, command.body)) return refused('invalid-args', `args.${command.body}:twice`);
    given[command.body] = body;
  }

  const args = {};
  const lines = {};
  const linked = {}; // option -> the channel id of the message link it was given
  for (const [option, raw] of Object.entries(given)) {
    const text = String(raw ?? '').trim();
    switch (byName.get(option).kind) {
      case 'integer':
        args[option] = /^[+-]?\d{1,15}$/.test(text) ? Number(text) : raw;
        break;
      case 'number':
        args[option] = /^[+-]?\d{1,15}(?:\.\d{1,15})?$/.test(text) ? Number(text) : raw;
        break;
      case 'boolean':
        args[option] = /^(?:true|false)$/i.test(text) ? text.toLowerCase() === 'true' : raw;
        break;
      case 'user': {
        const member = memberOf(text, view?.members);
        if (member.ok === false) return member;
        args[option] = member.id;
        break;
      }
      case 'channel': {
        const id = conversationIdOf(text, view?.conversations);
        if (id === 'ambiguous') return refused('target-ambiguous', 'conversation');
        if (!id) return refused('invalid-args', `args.${option}:unknown-channel`);
        args[option] = id;
        break;
      }
      case 'role': {
        const id = roleIdOf(text, view?.roles);
        if (!id) return refused('invalid-args', `args.${option}:unknown-role`);
        args[option] = id;
        break;
      }
      default: {
        const n = MESSAGE_OPTIONS.includes(option) ? transcriptNumber(text) : null;
        // A message link (in angle brackets too) names the message and its channel.
        const link = MESSAGE_OPTIONS.includes(option) && n === null ? MESSAGE_LINK_RE.exec(text.replace(/^<(.*)>$/, '$1')) : null;
        if (link) {
          linked[option] = link[1];
          args[option] = link[2];
          break;
        }
        if (n === null) {
          args[option] = raw;
          break;
        }
        const line = typeof view?.messageAt === 'function' ? view.messageAt(n) : null;
        if (!line) return refused('unknown-message', option);
        lines[option] = line;
        args[option] = String(line.id);
      }
    }
  }

  // A line names its channel: the one the call gave must be it, else it fills the channel option.
  let repliedAuthorId = null;
  for (const [option, line] of Object.entries(lines)) {
    const at = String(line.conversationId);
    if (byName.has('channel')) {
      if (args.channel === undefined) args.channel = at;
      else if (String(args.channel) !== at) return refused('unknown-message', 'conversation');
    }
    if (option === 'message' && (name === 'message.edit' || name === 'message.delete')) {
      const selfId = view?.selfId ?? null;
      const own = line.self === true || (selfId !== null && selfId !== '' && String(line.authorId) === String(selfId));
      if (!own) return refused('not-own-message', 'author');
    }
    if (option === 'reply') repliedAuthorId = line.authorId ?? null;
  }
  // A link names its channel the same way (whose message it is, the operation's port checks).
  for (const at of Object.values(linked)) {
    if (!byName.has('channel')) continue;
    if (args.channel === undefined) args.channel = at;
    else if (String(args.channel) !== at) return refused('unknown-message', 'conversation');
  }
  return { ok: true, skill: name, args, command, repliedAuthorId };
}

/** The structured status of an operation's result (src/ops/index.js#runOp): `ok`; one that may
 * have taken effect (`data.unknown`) `unknown`; a not-configured code `not_configured`; `denied`
 * and `approval_required` `denied`; `invalid` `invalid`; `partial` `partial`; else `failed`. */
function callStatus(result) {
  if (result?.status === 'ok') return 'ok';
  if (result?.data?.unknown === true) return 'unknown';
  if (NOT_CONFIGURED_CODES.includes(result?.code)) return 'not_configured';
  if (result?.status === 'denied' || result?.status === 'approval_required') return 'denied';
  if (result?.status === 'invalid') return 'invalid';
  if (result?.status === 'partial') return 'partial';
  return 'failed';
}

/** `promise`, or `{ timedOut: true }` after `ms` (a timer that never holds the process open). */
function withTimeout(promise, ms) {
  if (!Number.isFinite(ms) || ms <= 0) return promise;
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** A status card (`data.embeds`) as text: one `name: value` line per field. */
function cardText(result) {
  const card = Array.isArray(result?.data?.embeds) ? result.data.embeds[0] : null;
  const fields = Array.isArray(card?.fields) ? card.fields : [];
  return fields.map((field) => `${field.name}: ${field.value}`).join('\n');
}

/** A port result as a call result: `ok` with the message reference, else its status and code. */
function fromPort(result) {
  if (result?.status === 'ok') return { status: 'ok', ref: result.ref ?? null, at: result.at };
  const status = result?.status === 'unknown' ? 'unknown' : 'failed';
  return { status, code: result?.error?.code ?? result?.status ?? 'error', error: result?.error ?? null };
}

/**
 * Runs one resolved call (`resolved`: resolveCall's) the gateway let pass; never throws (a throw is
 * `failed` with `error`). Her arguments with the command's fixed values, mapped by the command's
 * own option mapper (`command.toCall`), must reach this very operation (else `invalid`); her own
 * writing (`message.create`, `message.edit`) is first rendered as a `<msg>` of hers is posted
 * (`deps.renderText`: the text, or `{ text, userIds }` -- mentions, custom emoji, message and
 * channel links; src/behavior/turn.js#renderPost), the members it mentions handed to the
 * operation as `mentionUserIds`, the only ones it may notify. Then `deps.runCommand(key, args, context)`
 * (src/admin.js#runCommand) -- for her own expressive operations (src/ops/effects.js#SELF_OWNED_OPS)
 * `deps.runOwnCommand` (src/admin.js#runOwnCommand: her grant alone, no requester's right) -- on
 * the call's envelope (`deps.envelope`, built by the turn, never by
 * the model: the requester's `userId` and `roleIds`, null with nobody; the invocation id) in the
 * turn's context (`deps.opContext`: `guildId`, `channelId`), the persona as the actor, the replied
 * author for a reply's notification; not back within `deps.timeoutMs` (`skills.callTimeoutMs`)
 * it is `unknown` (`timeout`), never retried. Its answer is the call's `data.text`
 * whatever the status -- the reply text, a card's fields, or the error or refusal the owner would
 * read -- with its code when it is not `ok`, and `ref` when a message went out. Files it answers
 * with (`/nep draw` without a channel) are posted to the current conversation through
 * `deps.port` (`deps.refOf`), as the owner's command shows them to the owner: the call is then
 * that post's result, never generated again.
 * @returns {Promise<{ status: string, code?: string, data?: { text: string }, ref?: object|null }>}
 */
export async function executeCall(resolved, deps) {
  try {
    const args = { ...resolved.args };
    // Her own writing as a `<msg>` of hers is posted: the members its mentions resolved to ride along.
    let mentionUserIds = [];
    if (WRITTEN.includes(resolved.skill) && typeof args.text === 'string' && typeof deps.renderText === 'function') {
      const rendered = deps.renderText(args.text);
      if (typeof rendered === 'string') args.text = rendered;
      else if (typeof rendered?.text === 'string') {
        args.text = rendered.text;
        if (Array.isArray(rendered.userIds)) mentionUserIds = rendered.userIds.filter((id) => typeof id === 'string' && id);
      }
    }
    const call = resolved.command.toCall(args);
    if (!call.args || call.op !== resolved.skill) return { status: 'invalid', code: 'invalid-args', reason: 'command' };
    // Her own expressive operations run on her grant alone; any other on the requester's right too.
    const run = SELF_OWNED_OPS.includes(resolved.skill) ? deps.runOwnCommand : deps.runCommand;
    if (typeof run !== 'function') return { status: 'not_configured', code: 'unsupported' };
    const envelope = deps.envelope ?? {};
    const requester = envelope.requester ?? null;
    const result = await withTimeout(run(call.key, call.args, {
      ...deps.opContext,
      userId: requester?.id ?? null,
      roleIds: Array.isArray(requester?.roleIds) ? [...requester.roleIds] : [],
      actor: 'persona',
      ...(envelope.invocationId ? { invocationId: envelope.invocationId } : {}),
      ...(resolved.repliedAuthorId ? { repliedAuthorId: String(resolved.repliedAuthorId) } : {}),
      ...(mentionUserIds.length > 0 ? { mentionUserIds } : {}),
    }), deps.timeoutMs ?? CALL_TIMEOUT_MS);
    // Dispatched and not back in time: it may have taken effect. Never retried.
    if (result?.timedOut === true) return { status: 'unknown', code: 'timeout', data: { text: '' } };
    const status = callStatus(result);
    const embeds = Array.isArray(result?.data?.embeds) && result.data.embeds.length > 0;
    const text = embeds ? cardText(result) : String(result?.summary ?? '');
    const out = { status, ...(status === 'ok' ? {} : { code: String(result?.code ?? 'error') }), data: { text }, ...(result?.data?.ref ? { ref: result.data.ref } : {}) };
    const files = status === 'ok' && Array.isArray(result?.data?.files) ? result.data.files : [];
    if (files.length === 0) return out;
    const attachments = files.map((file) => ({ name: String(file?.name ?? 'file'), data: file?.attachment }));
    const sent = fromPort(await deps.port.send(deps.refOf(deps.opContext?.channelId), { attachments }));
    return { ...sent, data: { text } };
  } catch (err) {
    return { status: 'failed', code: 'error', error: err };
  }
}

/**
 * Whether the persona hears back about a call (one follow-up request with its `<result>`): an
 * operation that answered, unless it is a message or a picture that went out (QUIET_ON_OK: its
 * own answer); any call that did not succeed -- but never under the full stop (`skills-off`: she
 * is silent).
 * @param {string} skill
 * @param {{ status: string, code?: string, data?: { text?: string } }} result
 * @returns {boolean}
 */
export function needsFollowUp(skill, result) {
  if (result?.code === 'skills-off') return false;
  if (result?.status === 'ok') return !QUIET_ON_OK.includes(skill) && Boolean(result.data?.text);
  return true;
}

/** The rule of a schema path (src/skills/schema.js#schemaError, resolveCall) -> the kind of its detail. */
const ARG_RULE_KINDS = Object.freeze({
  required: 'missing-arg',
  unknown: 'unknown-arg',
  twice: 'arg-twice',
  'max-length': 'too-long',
  'min-length': 'too-short',
  'unknown-channel': 'unknown-channel',
  'unknown-role': 'unknown-role',
});

/**
 * The concrete detail of a call's outcome that is not `ok`, from its code and the machine reason
 * the resolution or the gateway gave (never wording; the transcript words it through
 * `labels.transcript.callReasons`, src/discord/format.js): `{ kind, code, arg }`. An
 * `invalid-args` refusal with a schema path (`args.<arg>[.<more>]:<rule>`) names the argument and
 * what was wrong with it (`missing-arg`, `unknown-arg`, `arg-twice`, `too-long`, `too-short`,
 * `unknown-channel`, `unknown-role`, else `wrong-arg`); a body the skill does not take is
 * `no-body`; `unknown-message` names the option (`message`, `reply`) whose message was not in view,
 * or is `message-elsewhere` when that message lives in another channel than the one named;
 * `not-own-message` names `message`; `unknown-member` with several matches is `member-ambiguous`.
 * Any other code is its own kind without an argument. With `textChars` (a positive number) and
 * the operation's own message in `outcome.data.text`, that message rides along as `text`: one
 * line, cut to `textChars` with an ellipsis (src/memory/clamp.js) -- what the mark says when no
 * label words the code. Null for an `ok` outcome or one without a code. Pure.
 * @param {{ status?: string, code?: string|null, reason?: string|null, data?: { text?: string }|null }|null|undefined} outcome
 * @param {{ textChars?: number }} [options]
 * @returns {{ kind: string, code: string, arg: string|null, text?: string }|null}
 */
export function outcomeDetail(outcome, { textChars = 0 } = {}) {
  const code = typeof outcome?.code === 'string' ? outcome.code : '';
  if (!code || outcome.status === 'ok') return null;
  const reason = typeof outcome.reason === 'string' ? outcome.reason : '';
  const said = Number.isFinite(textChars) && textChars > 0 ? clampWithEllipsis(oneLine(outcome.data?.text), textChars) : '';
  const of = (kind, arg = null) => ({ kind, code, arg, ...(said ? { text: said } : {}) });
  if (code === 'invalid-args') {
    const path = /^args\.([^.:]+)(?:\.[^:]*)?:(.+)$/.exec(reason);
    if (path) return of(ARG_RULE_KINDS[path[2]] ?? 'wrong-arg', path[1]);
    return reason === 'args:body' ? of('no-body') : of(code);
  }
  if (code === 'unknown-message') {
    if (reason === 'conversation') return of('message-elsewhere');
    return MESSAGE_OPTIONS.includes(reason) ? of(code, reason) : of(code);
  }
  if (code === 'not-own-message') return of(code, 'message');
  if (code === 'unknown-member' && reason === 'ambiguous') return of('member-ambiguous');
  return of(code);
}
