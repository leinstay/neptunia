// The persona's first live skills (the skills design, phase 1): what one `<call>` of her output
// (src/llm/parse.js) does once the gateway (src/skills/gateway.js#checkSkill) let it pass. Two
// steps. `resolveCall` turns the tag's string attributes into the registry's arguments on the
// server's side -- a channel reference she sees (`#name`, `<#id>` or an id) into a conversation
// id, a transcript number `#N` into a message id with its author and conversation, a member's
// name or mention into a stored profile's id -- so nothing the model writes is taken as an id
// unchecked. `executeCall` then runs the skill: messages through the interface port
// (src/interface/port.js), reads through the operations (src/ops: `memory.profile.read`,
// `status.show`) or the catalogue, a picture through the image client and then the port. Every
// result is `{ status, code?, data? }` with the port's honesty: `ok`, `failed`, `unknown` (may
// have taken effect: never retried), `refused` (a rule said no, nothing was done). Codes are
// kebab-case; no wording here: the persona reads a result through `labels.skills.result`.

import { isOwnerId } from '../discord/access.js';
import { ImageCapError, ImageGenError } from '../llm/images.js';
import { matchChannel } from '../memory/mentions.js';
import { rightsRefusal } from '../ops/rights.js';

/**
 * The tag form of each callable skill: the attributes it takes (strings) and which argument its
 * body fills (null: a body is refused). A skill not listed here cannot be called with `<call>`.
 */
export const CALL_FORMS = Object.freeze({
  'message.send': Object.freeze({ attrs: Object.freeze(['conversation', 'replyTo', 'text']), body: 'text' }),
  'message.edit': Object.freeze({ attrs: Object.freeze(['message', 'text']), body: 'text' }),
  'message.delete': Object.freeze({ attrs: Object.freeze(['message']), body: null }),
  'memory.read': Object.freeze({ attrs: Object.freeze(['member']), body: null }),
  'status.show': Object.freeze({ attrs: Object.freeze([]), body: null }),
  'skills.list': Object.freeze({ attrs: Object.freeze([]), body: null }),
  draw: Object.freeze({ attrs: Object.freeze(['conversation', 'prompt']), body: 'prompt' }),
});

/** The skills whose answer is data the persona reads (a follow-up request carries it). */
export const READ_SKILLS = Object.freeze(['memory.read', 'status.show', 'skills.list']);

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

/** The transcript number of `#N` / `N`, else null. */
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
 * One `<call>` (`{ skill, args, body }`, src/llm/parse.js) as the registry's arguments, resolved
 * on the server's side, or the refusal: `unknown-skill` (no tag form), `invalid-args` (an
 * attribute the skill does not take, a body where none is taken, the text given twice),
 * `target-not-allowed` (a conversation that is neither the current one nor one of
 * `allowedConversationIds`, or one no reference names), `unknown-message` (a `#N` not in this
 * turn's transcript, or a reply target outside the conversation written to), `not-own-message`
 * (an edit or delete of someone else's message), `unknown-member` (no stored profile by that
 * name, or several). Pure.
 * @param {{ skill: string, args: Record<string, string>, body: string }} call
 * @param {{ currentConversationId: string, allowedConversationIds?: string[], conversations?: { id: string, name: string }[],
 *   messageAt?: (n: number) => ({ id: string, conversationId: string, authorId: string|null, self?: boolean } | null),
 *   members?: { id: string, names?: string[], aliases?: { name: string }[] }[], selfId?: string|null }} view
 * @returns {{ ok: true, skill: string, args: object, targetMessage: object|null, repliedAuthorId: string|null }
 *   | { ok: false, code: string, reason: string }}
 */
export function resolveCall(call, view) {
  const skill = String(call?.skill ?? '');
  const form = Object.hasOwn(CALL_FORMS, skill) ? CALL_FORMS[skill] : null;
  if (!form) return refused('unknown-skill', skill);
  const given = { ...(call?.args ?? {}) };
  for (const key of Object.keys(given)) if (!form.attrs.includes(key)) return refused('invalid-args', `args.${key}:unknown`);
  const body = typeof call?.body === 'string' ? call.body.trim() : '';
  if (body) {
    if (!form.body) return refused('invalid-args', 'args:body');
    if (Object.hasOwn(given, form.body)) return refused('invalid-args', `args.${form.body}:twice`);
    given[form.body] = body;
  }

  const current = String(view?.currentConversationId ?? '');
  const allowed = new Set([current, ...(Array.isArray(view?.allowedConversationIds) ? view.allowedConversationIds.map(String) : [])]);
  /** The conversation `reference` names (current when absent), or the refusal. */
  const conversation = (reference) => {
    if (reference === undefined) return { id: current };
    const id = conversationIdOf(reference, view?.conversations);
    if (id === 'ambiguous') return refused('target-ambiguous', 'conversation');
    return id && allowed.has(id) ? { id } : refused('target-not-allowed', 'conversation');
  };
  /** The transcript line `#N` names, or null. */
  const line = (value) => {
    const n = transcriptNumber(value);
    return n === null || typeof view?.messageAt !== 'function' ? null : (view.messageAt(n) ?? null);
  };

  const args = {};
  let targetMessage = null;
  let repliedAuthorId = null;
  if (skill === 'message.send' || skill === 'draw') {
    const target = conversation(given.conversation);
    if (target.ok === false) return target;
    const conversationId = target.id;
    args.conversationId = conversationId;
    if (skill === 'draw') {
      if (given.prompt !== undefined) args.prompt = given.prompt;
    } else {
      if (given.text !== undefined) args.text = given.text;
      if (given.replyTo !== undefined) {
        const target = line(given.replyTo);
        if (!target) return refused('unknown-message', 'reply');
        if (String(target.conversationId) !== conversationId) return refused('unknown-message', 'conversation');
        args.replyTo = String(target.id);
        repliedAuthorId = target.authorId ?? null;
      }
    }
  } else if (skill === 'message.edit' || skill === 'message.delete') {
    const target = line(given.message);
    if (!target) return refused('unknown-message', 'message');
    if (!allowed.has(String(target.conversationId))) return refused('target-not-allowed', 'conversation');
    const selfId = view?.selfId ?? null;
    const own = target.self === true || (selfId !== null && selfId !== '' && String(target.authorId) === String(selfId));
    if (!own) return refused('not-own-message', 'author');
    args.conversationId = String(target.conversationId);
    args.messageId = String(target.id);
    if (skill === 'message.edit' && given.text !== undefined) args.text = given.text;
    targetMessage = { id: String(target.id), authorId: own ? String(selfId ?? target.authorId) : String(target.authorId), conversationId: String(target.conversationId) };
  } else if (skill === 'memory.read') {
    const member = memberOf(given.member, view?.members);
    if (member.ok === false) return member;
    args.memberId = member.id;
  }
  return { ok: true, skill, args, targetMessage, repliedAuthorId };
}

/**
 * Null when `requester` may read stored memory about a member here, else the refusal: an owner
 * may; anyone else as a member running `/nep memory show` may (src/ops/rights.js#rightsRefusal on
 * the `memory.profile.read` operation: a grant on it, read now). No requester (nobody asked) is
 * held to the same rule with no id: only a grant to everyone opens it.
 */
function memoryReaderRefusal(requester, { config, getOp }) {
  if (requester?.id && isOwnerId(config, requester.id)) return null;
  const op = typeof getOp === 'function' ? getOp('memory.profile.read') : null;
  if (!op) return refused('requester-denied', 'no-operation');
  const code = rightsRefusal(op, { userId: requester?.id ?? null, roleIds: requester?.roleIds ?? [], config });
  return code ? refused('requester-denied', code) : null;
}

/** A port result as a call result: `ok` with the message reference, else its status and code. */
function fromPort(result) {
  if (result?.status === 'ok') return { status: 'ok', ref: result.ref ?? null, at: result.at };
  const status = result?.status === 'unknown' ? 'unknown' : 'failed';
  return { status, code: result?.error?.code ?? result?.status ?? 'error', error: result?.error ?? null };
}

/** An operation result as a call result: `ok` with its data, else `failed` with its code. */
function fromOp(result, toData) {
  if (result?.status === 'ok') return { status: 'ok', data: toData(result) };
  return { status: result?.status === 'denied' ? 'refused' : 'failed', code: result?.code ?? 'error' };
}

/** The member-level status card as text: one `name: value` block per field. */
function statusText(result) {
  const card = Array.isArray(result?.data?.embeds) ? result.data.embeds[0] : null;
  const fields = Array.isArray(card?.fields) ? card.fields : [];
  return { text: fields.map((field) => `${field.name}: ${field.value}`).join('\n') };
}

/**
 * Runs one resolved call (`resolved`: resolveCall's) the gateway let pass, and resolves its
 * result; never throws (a throw is `failed` with `error`). `deps` (the turn's, read at the moment
 * of use): `port` and `refOf(conversationId)` (the port's conversation reference); `renderText`
 * (her text as it is posted: custom emoji); `pingsOff(userId)`; `requester` (`{ id, roleIds? }`
 * or null); `config` (live) and `getOp` (the operations registry); `runOp(name, args, ctx)` (an
 * operation without the caller's rights check: the check that applies is made here) and `opContext`
 * (`{ guildId, channelId }`); `catalogue()` (the catalogue rows of this requester, listSkills);
 * `generate(prompt)` (one picture: `{ buffer, mediaType }`, throwing ImageCapError /
 * ImageGenError), `fileName(mediaType)`, and `recheck()` (the gateway again, right before a
 * picture already paid for is published: `{ ok }` or the refusal).
 *
 * - `message.send`: the text to the conversation, replying to `replyTo` when given; it notifies
 *   nobody but the replied author (unless that member turned pings off), like her replies.
 * - `message.edit` / `message.delete`: her own message, through the port (which refuses anyone
 *   else's on its own too).
 * - `memory.read`: the summary view of `/nep memory show` for the member, never the private layer,
 *   only when the requester may read it (memoryReaderRefusal): `refused` `requester-denied` else.
 * - `status.show`: the member-level status card (no owner field, whoever asks).
 * - `skills.list`: the catalogue rows (`data.rows`).
 * - `draw`: one generation, then one publication; a publication that fails after it is `failed` or
 *   `unknown` and nothing is generated again. An image cap is `refused` `daily-cap`.
 * Results carry `data` (`{ text }` or `{ rows }`) for a read, `ref` for a message, `cost` and
 * `bytes` for a picture.
 * @returns {Promise<{ status: 'ok'|'failed'|'unknown'|'refused', code?: string, data?: object, ref?: object|null }>}
 */
export async function executeCall(resolved, deps) {
  const { skill, args } = resolved;
  try {
    switch (skill) {
      case 'message.send': {
        const repliedAuthorId = resolved.repliedAuthorId ?? null;
        const replyTo = args.replyTo ? { ...deps.refOf(args.conversationId), messageId: String(args.replyTo) } : null;
        const content = {
          text: deps.renderText ? deps.renderText(args.text) : args.text,
          ...(replyTo ? { replyTo } : {}),
          mentions: { users: [], repliedUser: Boolean(replyTo && repliedAuthorId && !deps.pingsOff?.(repliedAuthorId)) },
        };
        return fromPort(await deps.port.send(deps.refOf(args.conversationId), content));
      }
      case 'message.edit': {
        const ref = { ...deps.refOf(args.conversationId), messageId: String(args.messageId) };
        return fromPort(await deps.port.edit(ref, { text: deps.renderText ? deps.renderText(args.text) : args.text }));
      }
      case 'message.delete': {
        const ref = { ...deps.refOf(args.conversationId), messageId: String(args.messageId) };
        return fromPort(await deps.port.delete(ref));
      }
      case 'memory.read': {
        const refusal = memoryReaderRefusal(deps.requester, deps);
        if (refusal) return { status: 'refused', code: refusal.code, reason: refusal.reason };
        if (typeof deps.runOp !== 'function') return { status: 'failed', code: 'unsupported' };
        const result = await deps.runOp('memory.profile.read', { userId: args.memberId, section: 'summary' }, { ...deps.opContext, userId: deps.requester?.id ?? null });
        return fromOp(result, (ok) => ({ text: String(ok.summary ?? '') }));
      }
      case 'status.show': {
        if (typeof deps.runOp !== 'function') return { status: 'failed', code: 'unsupported' };
        // Nobody's id: the card of a member, whoever asked.
        const result = await deps.runOp('status.show', {}, { ...deps.opContext, userId: null });
        return fromOp(result, statusText);
      }
      case 'skills.list':
        return { status: 'ok', data: { rows: typeof deps.catalogue === 'function' ? deps.catalogue() : [] } };
      case 'draw': {
        if (typeof deps.generate !== 'function') return { status: 'failed', code: 'unsupported' };
        let picture;
        try {
          picture = await deps.generate(args.prompt);
        } catch (err) {
          if (err instanceof ImageCapError) return { status: 'refused', code: 'daily-cap', error: err };
          return { status: 'failed', code: err instanceof ImageGenError && err.reason && err.reason !== 'empty' ? String(err.reason) : 'error', error: err };
        }
        const bytes = picture?.buffer?.length ?? 0;
        // Paid for: checked again right before it is published, and never generated again.
        const verdict = typeof deps.recheck === 'function' ? deps.recheck() : { ok: true };
        if (!verdict.ok) return { status: 'refused', code: verdict.code, reason: verdict.reason, generated: true, bytes };
        const attachment = { name: deps.fileName(picture.mediaType), data: picture.buffer, contentType: picture.mediaType };
        const sent = fromPort(await deps.port.send(deps.refOf(args.conversationId), { attachments: [attachment] }));
        return { ...sent, generated: true, bytes, cost: picture.cost ?? null };
      }
      default:
        return { status: 'refused', code: 'unknown-skill' };
    }
  } catch (err) {
    return { status: 'failed', code: 'error', error: err };
  }
}

/**
 * Whether the persona hears back about a call: a read that succeeded (its data), or any call
 * that did not succeed -- but never under the full stop (`skills-off`: she is silent). A send,
 * an edit, a delete or a picture that succeeded is its own answer.
 * @param {string} skill
 * @param {{ status: string, code?: string }} result
 * @returns {boolean}
 */
export function needsFollowUp(skill, result) {
  if (result?.code === 'skills-off') return false;
  if (result?.status === 'ok') return READ_SKILLS.includes(skill);
  return true;
}
