// What one `<call>` of the persona's output (src/llm/parse.js) does once the gateway
// (src/tools/gateway.ts#checkSkill) let it pass. Her skills have a table of their own
// (src/tools/definitions.ts): a call names an operation and gives its arguments as attributes. Two steps. `resolveCall` turns the tag's string attributes into the
// command's arguments on the server's side -- a channel reference she sees (`#handle`, `#name`,
// `<#id>` or an id) into a channel id, a member's name or mention into a stored profile's id, a role into its
// id, a transcript number `#N` or a message link (a `message` or `reply` option) into that
// message's id and channel, a whole number or `true` / `false` read strictly -- so nothing the model writes is
// taken as an id unchecked. `executeCall` then runs the operation by its name
// (src/admin.js#runSkillOp: the requester's rights checked again, as for their own command),
// the persona as the actor; its answer -- an error or a refusal included -- is the text the owner
// would see. Every result is `{ status, code?, data? }`, structured and honest (RESULT_STATUSES):
// `ok` only when the operation answered ok; `denied` (a rule said no), `invalid` (the call was
// not right), `not_configured` (what it needs is not set up), `unknown` (it may have taken effect:
// never retried), `partial`, `failed`. Codes are kebab-case; no wording here: the persona reads a
// result through `labels.skills.result`.

import { clampWithEllipsis, oneLine } from '../memory/clamp.js';
import { channelCore, matchChannel, occursAsWholeWord } from '../memory/mentions.ts';
import { foldText } from '../memory/recent.js';
import { SELF_OWNED_OPS } from './impl/effects.ts';
import { MESSAGE_LINK_RE } from './impl/shared.ts';
import { CODE, INVALID_CODES, NOT_CONFIGURED_CODES, WHAT } from './codes.ts';
import { nestedRefusal } from './access.ts';

/** The options whose value may be a transcript number `#N`: a message she can see. */
const MESSAGE_OPTIONS = Object.freeze(['message', 'reply', 'around', 'anchor', 'media']);

/**
 * The options of conversation.read that are a message when written as `#N` or a link and a count
 * otherwise (`before=#40`, `before=5`).
 */
const ANCHOR_OPTIONS = Object.freeze({ 'conversation.read': ['before', 'after'] });

/** Whether `option` of `skill` given as `text` names a message (a transcript number or a link). */
function namesMessage(skill, option, text) {
  if (MESSAGE_OPTIONS.includes(option)) return true;
  return (
    (ANCHOR_OPTIONS[skill] ?? []).includes(option) &&
    (text.startsWith('#') || MESSAGE_LINK_RE.test(text.replace(/^<(.*)>$/, '$1')))
  );
}

/** The option of message.create that names a message of hers whose attachment is posted again. */
const MEDIA_OPTION = 'media';

/** A message link form carrying the channel with the id (`@me` stands for the guild, which the operation knows). */
function mediaRef(channelId, messageId) {
  return `https://discord.com/channels/@me/${channelId}/${messageId}`;
}

/** Whether the transcript line `line` is the persona's own (`self`, else its author is `selfId`). */
function isOwnLine(line, selfId) {
  return (
    line.self === true ||
    (selfId !== null && selfId !== undefined && selfId !== '' && String(line.authorId) === String(selfId))
  );
}

/** The options whose value is a file handle of one of her errands (`file:<task id>/<name>`). */
const FILE_OPTIONS = Object.freeze(['file']);

/** The skill whose `agent` she must name: refused `agent-required` (with the agents) when left out. */
const AGENT_SKILL = 'task.run';
/** The skills whose `people` option is a list of members (ids, names, `@handle`s, comma or space separated), resolved one by one. */
const PEOPLE_LIST_SKILLS = Object.freeze(['intent.set', 'intent.update']);

/** The operations whose `text` is the persona's own writing, posted as a `<msg>` of hers is (mentions, custom emoji, links). */
const WRITTEN = Object.freeze(['message.create', 'message.edit']);

/** Every status a call result may have. */
export const RESULT_STATUSES = Object.freeze([
  'ok',
  'denied',
  'not_configured',
  'invalid',
  'unknown',
  'partial',
  'failed',
]);

/** What a timed-out in-turn tool was doing (`{what}` of the `timeout` reason); the operations of the chat answer `chat`. */
const TIMEOUT_WHAT = Object.freeze({
  'web.search': WHAT.search,
  'memory.search': WHAT.search,
  'web.read': WHAT.page,
  'media.look': WHAT.picture,
});

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
  return String(value ?? '')
    .normalize('NFC')
    .trim()
    .toLocaleLowerCase();
}

/** The id inside a channel reference `<#id>` or a bare id of digits, else null. */
function channelIdOf(reference) {
  const match = /^<#(\d+)>$/.exec(reference) ?? /^(\d+)$/.exec(reference);
  return match ? match[1] : null;
}

/**
 * The conversation id a channel reference (`#handle`, `#name`, `name`, `<#id>`, an id) names among
 * `conversations` (`{ id, name }`, one entry per id): a handle of `channelHandles` (the request's
 * channel handle without `#` -> channel id; with or without its `#`, exactly) first, else a name by
 * src/memory/mentions.ts#matchChannel (the exact name, else the one channel with the same core:
 * other or no leading emoji, any case and accents). `'ambiguous'` when several share it, null when none.
 */
function conversationIdOf(reference, conversations, channelHandles = null) {
  const given = String(reference ?? '').trim();
  if (!given) return null;
  const id = channelIdOf(given);
  if (id) return id;
  const byHandle = channelHandles instanceof Map ? channelHandles.get(given.replace(/^#/, '')) : undefined;
  if (byHandle !== undefined && byHandle !== null && String(byHandle) !== '') return String(byHandle);
  const unique = new Map();
  for (const c of conversations ?? [])
    if (c && c.id !== undefined && c.id !== null && !unique.has(String(c.id)))
      unique.set(String(c.id), { id: String(c.id), name: c.name });
  const match = matchChannel(given.replace(/^#/, ''), unique.values());
  return match === 'ambiguous' ? 'ambiguous' : (match?.id ?? null);
}

/** The id of a role reference (`<@&id>` or an id), or of the one role of `roles` by that name; else null. */
function roleIdOf(reference, roles) {
  const given = String(reference ?? '').trim();
  const match = /^<@&(\d+)>$/.exec(given) ?? /^(\d+)$/.exec(given);
  if (match) return match[1];
  const name = folded(given.replace(/^@/, ''));
  const ids = new Set(
    (Array.isArray(roles) ? roles : [])
      .filter((role) => typeof role?.name === 'string' && folded(role.name) === name)
      .map((role) => String(role.id))
  );
  return ids.size === 1 ? [...ids][0] : null;
}

/** The transcript number of `#N` / `N` (six digits at most: never a platform id), else null. */
function transcriptNumber(value) {
  const match = /^#?(\d{1,6})$/.exec(String(value ?? '').trim());
  return match ? Number(match[1]) : null;
}

/**
 * The stored member a name or mention (`<@id>`, `<@!id>`, `@name`, an id) names, or a `@handle` of
 * `handles` (the request's, handle -> member id: resolved exactly, before any name), `{ id }` or a refusal.
 */
function memberOf(reference, members, handles = null) {
  const given = String(reference ?? '').trim();
  const list = Array.isArray(members) ? members : [];
  const mention = /^<@!?(\d+)>$/.exec(given) ?? /^(\d+)$/.exec(given);
  if (mention)
    return list.some((member) => String(member?.id) === mention[1])
      ? { id: mention[1] }
      : refused(CODE.UNKNOWN_MEMBER, 'id');
  const byHandle = handles instanceof Map && given.startsWith('@') ? handles.get(given.slice(1)) : undefined;
  if (byHandle) return { id: String(byHandle) };
  const name = folded(given.replace(/^@/, ''));
  if (!name) return refused(CODE.UNKNOWN_MEMBER, 'empty');
  const ids = new Set();
  for (const member of list) {
    const names = [
      ...(Array.isArray(member?.names) ? member.names : []),
      ...(Array.isArray(member?.aliases) ? member.aliases.map((alias) => alias?.name) : []),
    ];
    if (names.some((candidate) => typeof candidate === 'string' && folded(candidate) === name))
      ids.add(String(member.id));
  }
  if (ids.size === 1) return { id: [...ids][0] };
  return refused(CODE.UNKNOWN_MEMBER, ids.size > 1 ? 'ambiguous' : 'name');
}

/** Whether `text` names the channel `channelId`: its mention `<#id>`, one of its handles, or its name (by its core: any case, accents, emoji) as a whole word. */
function namesChannel(text, channelId, names, handles) {
  const raw = String(text ?? '');
  if (!raw.trim()) return false;
  if (raw.includes(`<#${channelId}>`)) return true;
  const folded = foldText(raw);
  return (
    handles.some((handle) => occursAsWholeWord(folded, foldText(handle))) ||
    names.some((name) => occursAsWholeWord(folded, channelCore(name)))
  );
}

/**
 * Whether a file of the errand `task` may be posted to `channelId`: the errand's origin channel
 * (`task.origin.channelId`; any channel when it has none), else a channel the errand's goal or the
 * trigger message of the turn (`view.triggerText`) names by its mention, a handle of
 * `view.channelHandles` or a name of `view.conversations`.
 */
function fileMayGo(task, channelId, view) {
  const origin = task?.origin?.channelId;
  if (origin === undefined || origin === null || origin === '' || String(origin) === channelId) return true;
  const names = (view?.conversations ?? [])
    .filter((c) => c && String(c.id) === channelId && typeof c.name === 'string' && c.name)
    .map((c) => c.name);
  const handles =
    view?.channelHandles instanceof Map
      ? [...view.channelHandles].filter(([, id]) => String(id) === channelId).map(([handle]) => handle)
      : [];
  return [task.goal, view?.triggerText].some((text) => namesChannel(text, channelId, names, handles));
}

/**
 * One call of the persona (`{ skill, args }`: a native tool call or a `<tool_call>` block, already
 * arguments by name) as the arguments of the command behind the skill (`view.skills`: the
 * registry), keyed by the command's option names, or the refusal:
 * `unknown-skill` (no such skill), `invalid-args` (an attribute the command does not take, a
 * channel or role nobody has), `agent-required` (an errand without its agent),
 * `target-ambiguous` (a channel name several share), `unknown-member` (no stored profile by that
 * name, or several), `unknown-message` (a `#N` not in this turn's transcript, a message the record holds as deleted -- reason `message-deleted` -- or in another
 * channel than the one named), `not-own-message` (`message.edit` / `message.delete` of a line that
 * is not hers), `unknown-file` (a `file` handle that names no file of an errand of hers this
 * conversation may see, `view.fileOf`), `file-expired` (the handle of a task whose files the runner has deleted), `file-elsewhere` (an errand's file bound for a channel
 * other than the one the errand was asked in that neither its goal nor the turn's trigger message,
 * `view.triggerText`, names: fileMayGo; a call without a channel posts here as ever). A `#N` of a `message` or `reply` option becomes the line's message id and, when
 * the command has a `channel` option the call left out, its channel; a reply records the replied
 * author. A Discord message link there (MESSAGE_LINK_RE, bare or in angle brackets) becomes its
 * message id and names its channel the same way (`unknown-message` when the call named another);
 * any other value -- a raw message id -- is passed on as written. An errand
 * (`task.run`) without its `agent` is refused `agent-required`, the reason the agents she may
 * name, comma-separated (the schema's choices). Pure.
 * @param {{ skill: string, args: Record<string, string> }} call
 * A channel option resolves a `#handle` of `view.channelHandles` (the request's, handle -> channel
 * id) exactly before any name; a member option a `@handle` of `view.memberHandles` (handle -> member
 * id) the same way. The `people` option of PEOPLE_LIST_SKILLS is a list of members (comma or space
 * separated), each resolved like a member option; the ids come out comma-separated.
 * @param {{ skills: Map<string, object>, conversations?: { id: string, name: string }[], channelHandles?: Map<string, string>|null, memberHandles?: Map<string, string>|null,
 *   messageAt?: (n: number) => ({ id: string, conversationId: string, authorId: string|null, self?: boolean } | null),
 *   members?: { id: string, names?: string[], aliases?: { name: string }[] }[], roles?: { id: string, name: string }[],
 *   selfId?: string|null, fileOf?: (handle: string) => object|null, triggerText?: string|null }} view
 * @returns {{ ok: true, skill: string, args: object, dispatch: object, repliedAuthorId: string|null, channelFixed?: true }
 *   | { ok: false, code: string, reason: string }}
 */
export function resolveCall(call, view) {
  const name = String(call?.skill ?? '');
  const skill = view?.skills?.get?.(name);
  if (!skill?.dispatch) return refused(CODE.UNKNOWN_SKILL, name);
  const { dispatch } = skill;
  const byName = new Map(dispatch.options.map((option) => [option.name, option]));
  const given = { ...(call?.args ?? {}) };
  for (const key of Object.keys(given)) if (!byName.has(key)) return refused(CODE.INVALID_ARGS, `args.${key}:unknown`);
  // An errand without its agent: refused naming the agents she may pick (the schema's choices), so
  // the refusal she reads says which, never a bare missing argument.
  if (name === AGENT_SKILL && !Object.hasOwn(given, 'agent') && byName.has('agent')) {
    const agents = skill.argsSchema?.properties?.agent?.enum;
    return refused(CODE.AGENT_REQUIRED, Array.isArray(agents) ? agents.join(',') : '');
  }

  const args = {};
  const lines = {};
  const linked = {}; // option -> the channel id of the message link it was given
  const errandFiles = []; // the errands whose files the call carries
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
        const member = memberOf(text, view?.members, view?.memberHandles);
        if (member.ok === false) return member;
        args[option] = member.id;
        break;
      }
      case 'channel': {
        const id = conversationIdOf(text, view?.conversations, view?.channelHandles);
        if (id === 'ambiguous') return refused(CODE.TARGET_AMBIGUOUS, 'conversation');
        if (!id) return refused(CODE.INVALID_ARGS, `args.${option}:unknown-channel`);
        args[option] = id;
        break;
      }
      case 'role': {
        const id = roleIdOf(text, view?.roles);
        if (!id) return refused(CODE.INVALID_ARGS, `args.${option}:unknown-role`);
        args[option] = id;
        break;
      }
      default: {
        // A list of people: each token a member reference, resolved as a member option is.
        if (option === 'people' && PEOPLE_LIST_SKILLS.includes(name)) {
          const ids = [];
          for (const token of text.split(/[\s,]+/).filter(Boolean)) {
            const member = memberOf(token, view?.members, view?.memberHandles);
            if (member.ok === false) return member;
            if (!ids.includes(member.id)) ids.push(member.id);
          }
          args[option] = ids.join(',');
          break;
        }
        // A file handle must name a file of one of her errands this conversation may see.
        if (FILE_OPTIONS.includes(option)) {
          const file = typeof view?.fileOf === 'function' ? view.fileOf(text) : null;
          if (file?.expired) return refused(CODE.FILE_EXPIRED, option);
          if (!file) return refused(CODE.UNKNOWN_FILE, option);
          if (file.task) errandFiles.push(file.task);
          args[option] = text;
          break;
        }
        const isMessage = namesMessage(name, option, text);
        const n = isMessage ? transcriptNumber(text) : null;
        // A message link (in angle brackets too) names the message and its channel.
        const link = isMessage && n === null ? MESSAGE_LINK_RE.exec(text.replace(/^<(.*)>$/, '$1')) : null;
        // A message the record holds as deleted and the history does not: refused as deleted.
        const deletedHere = (id) => isMessage && view?.deletedIds instanceof Set && view.deletedIds.has(String(id));
        if (link) {
          if (deletedHere(link[2])) return refused(CODE.UNKNOWN_MESSAGE, CODE.MESSAGE_DELETED);
          if (option === MEDIA_OPTION) {
            args[option] = mediaRef(link[1], link[2]);
            break;
          }
          linked[option] = link[1];
          args[option] = link[2];
          break;
        }
        if (n === null) {
          if (deletedHere(text)) return refused(CODE.UNKNOWN_MESSAGE, CODE.MESSAGE_DELETED);
          args[option] = raw;
          break;
        }
        const line = typeof view?.messageAt === 'function' ? view.messageAt(n) : null;
        if (!line) return refused(CODE.UNKNOWN_MESSAGE, option);
        if (line.deleted === true) return refused(CODE.UNKNOWN_MESSAGE, CODE.MESSAGE_DELETED);
        if (option === MEDIA_OPTION) {
          // A picture of hers to post again: its own channel is where to fetch it, never where it goes.
          if (name === 'message.create' && !isOwnLine(line, view?.selfId))
            return refused(CODE.NOT_OWN_MESSAGE, 'author');
          args[option] = mediaRef(line.conversationId, line.id);
          break;
        }
        lines[option] = line;
        args[option] = String(line.id);
      }
    }
  }
  // One attachment per post: a picture of hers beside an errand's file or a library GIF is refused.
  if (args[MEDIA_OPTION] !== undefined) {
    if (given.file !== undefined) return refused(CODE.INVALID_ARGS, 'args.media:file');
    if (given.gif !== undefined) return refused(CODE.INVALID_ARGS, 'args.media:gif');
  }

  // A line names its channel: the one the call gave must be it, else it fills the channel option.
  let repliedAuthorId = null;
  let channelFixed = false;
  for (const [option, line] of Object.entries(lines)) {
    const at = String(line.conversationId);
    if (byName.has('channel')) {
      if (args.channel === undefined) args.channel = at;
      else if (String(args.channel) !== at) {
        if (!messageChannelWins(name, option)) return refused(CODE.UNKNOWN_MESSAGE, 'conversation');
        args.channel = at;
        channelFixed = true;
      }
    }
    if (option === 'message' && (name === 'message.edit' || name === 'message.delete')) {
      if (!isOwnLine(line, view?.selfId)) return refused(CODE.NOT_OWN_MESSAGE, 'author');
    }
    if (option === 'reply') repliedAuthorId = line.authorId ?? null;
  }
  // A link names its channel the same way (whose message it is, the operation's port checks).
  for (const at of Object.values(linked)) {
    if (!byName.has('channel')) continue;
    if (args.channel === undefined) args.channel = at;
    else if (String(args.channel) !== at) {
      if (!Object.keys(linked).every((option) => messageChannelWins(name, option)))
        return refused(CODE.UNKNOWN_MESSAGE, 'conversation');
      args.channel = at;
      channelFixed = true;
    }
  }
  // An errand's file goes where the errand was asked; elsewhere only where its goal or the trigger names.
  if (args.channel !== undefined) {
    for (const task of errandFiles)
      if (!fileMayGo(task, String(args.channel), view)) return refused(CODE.FILE_ELSEWHERE, 'channel');
  }
  return { ok: true, skill: name, args, dispatch, repliedAuthorId, ...(channelFixed ? { channelFixed: true } : {}) };
}

/** The calls where the message's own channel wins over a `channel` that does not hold it. */
const OWN_CHANNEL_SKILLS = Object.freeze({
  'message.react.add': ['message'],
  'message.react.remove': ['message'],
  'message.edit': ['message'],
  'message.delete': ['message'],
  'message.create': ['reply'],
});

/** Whether, for `skill`, the channel of the message in `option` wins over the one the call gave. */
function messageChannelWins(skill, option) {
  return (OWN_CHANNEL_SKILLS[skill] ?? []).includes(option);
}

/** The structured status of an operation's result (src/tools/impl/index.ts#runOp): `ok`; one that may
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
  return { status, code: result?.error?.code ?? result?.status ?? CODE.ERROR, error: result?.error ?? null };
}

/**
 * Runs one resolved call (`resolved`: resolveCall's) the gateway let pass; never throws (a throw is
 * `failed` with `error`). Her arguments with the command's fixed values, mapped by the command's
 * own option mapper (`dispatch.toOp`), must reach this very operation (else `invalid`); her own
 * writing (`message.create`, `message.edit`) is first rendered as a `<msg>` of hers is posted
 * (`deps.renderText`: the text, or `{ text, userIds }` -- mentions, custom emoji, message and
 * channel links; src/behavior/turn.js#renderPost), the members it mentions handed to the
 * operation as `mentionUserIds`, the only ones it may notify. Then `deps.runOp(op, args, context)`
 * (src/admin.js#runSkillOp) -- for her own expressive operations (src/tools/impl/effects.ts#SELF_OWNED_OPS)
 * `deps.runOwnOp` (src/admin.js#runOwnSkillOp: her grant alone, no requester's right), and on
 * her own initiative (`envelope.ownInitiative` with no requester: an inner turn)
 * `deps.runInitiativeOp` (src/admin.js#runInitiativeSkillOp, the same for any operation) -- on
 * the call's envelope (`deps.envelope`, built by the turn, never by
 * the model: the requester's `userId` and `roleIds`, null with nobody; the invocation id) in the
 * turn's context (`deps.opContext`: `guildId`, `channelId`), the persona as the actor, the replied
 * author for a reply's notification; not back within `deps.timeoutMs` (`skills.callTimeoutMs`)
 * it is `unknown` (`timeout`), never retried. Its answer is the call's `data.text`
 * whatever the status -- the reply text, a card's fields, or the error or refusal the owner would
 * read -- with its code when it is not `ok`, `ref` when a message went out, and `taskId` when it
 * queued an errand (`task.run`). Files it answers
 * with (`/nep draw` without a channel) are posted to the current conversation through
 * `deps.port` (`deps.refOf`), as the owner's command shows them to the owner: the call is then
 * that post's result, never generated again. A skill `deps.inTurn` holds (the turn's in-turn
 * tools, features.coreTools: name -> `(args) => result`) runs there instead, on the operation's
 * arguments her call maps to (`dispatch.toOp`, as above), under the same timeout; its result is the call's as it is (a result without a
 * known status is `failed`). On her own initiative (an inner turn) the wake envelope of `envelope.wakeKind`
 * (src/tools/access.ts#nestedRefusal, over `deps.config`, the live config) is checked at the capabilities the skill
 * reaches inside its operation, before it runs and again before its files are posted: `denied` `not-allowed`.
 * @returns {Promise<{ status: string, code?: string, data?: { text: string }, ref?: object|null, taskId?: string }>}
 */
export async function executeCall(resolved, deps) {
  try {
    const args = { ...resolved.args };
    const tool = deps.inTurn && Object.hasOwn(deps.inTurn, resolved.skill) ? deps.inTurn[resolved.skill] : null;
    if (typeof tool === 'function') {
      // The operation's own arguments, mapped by its command as for the owner's command.
      const mapped = resolved.dispatch ? resolved.dispatch.toOp(args) : { op: resolved.skill, args };
      if (!mapped.args || mapped.op !== resolved.skill)
        return { status: 'invalid', code: CODE.INVALID_ARGS, reason: 'command' };
      const answered = await withTimeout(Promise.resolve(tool(mapped.args)), deps.timeoutMs ?? CALL_TIMEOUT_MS);
      if (answered?.timedOut === true)
        return {
          status: 'unknown',
          code: CODE.TIMEOUT,
          values: { what: TIMEOUT_WHAT[resolved.skill] ?? WHAT.chat },
          data: { text: '' },
        };
      return RESULT_STATUSES.includes(answered?.status) ? answered : { status: 'failed', code: CODE.ERROR };
    }
    // Her own writing as a `<msg>` of hers is posted: the members its mentions resolved to ride along.
    let mentionUserIds = [];
    if (WRITTEN.includes(resolved.skill) && typeof args.text === 'string' && typeof deps.renderText === 'function') {
      const rendered = deps.renderText(args.text);
      if (typeof rendered === 'string') args.text = rendered;
      else if (typeof rendered?.text === 'string') {
        args.text = rendered.text;
        if (Array.isArray(rendered.userIds))
          mentionUserIds = rendered.userIds.filter((id) => typeof id === 'string' && id);
      }
    }
    const call = resolved.dispatch.toOp(args);
    if (!call.args || call.op !== resolved.skill)
      return { status: 'invalid', code: CODE.INVALID_ARGS, reason: 'command' };
    // Her own expressive operations run on her grant alone; any other on the requester's right too,
    // except on her own initiative (an inner turn, nobody asked): her grant alone, the gateway's.
    const envelope = deps.envelope ?? {};
    const requester = envelope.requester ?? null;
    const initiative = envelope.ownInitiative === true && !requester;
    const run = SELF_OWNED_OPS.includes(resolved.skill)
      ? deps.runOwnOp
      : initiative
        ? deps.runInitiativeOp
        : deps.runOp;
    if (typeof run !== 'function') return { status: 'not_configured', code: CODE.UNSUPPORTED };
    // An inner turn's wake envelope, at the capabilities this skill reaches inside its operation (a picture or a voice
    // message is a post): checked before anything runs, so nothing paid is made for a post the envelope forbids.
    const wakeKind = initiative && typeof envelope.wakeKind === 'string' ? envelope.wakeKind : null;
    const nested = nestedRefusal({ config: deps.config, wakeKind, skill: resolved.skill });
    if (nested) return { status: 'denied', code: nested.reason, reason: nested.detail, data: { text: '' } };
    const result = await withTimeout(
      run(call.op, call.args, {
        ...deps.opContext,
        userId: requester?.id ?? null,
        roleIds: Array.isArray(requester?.roleIds) ? [...requester.roleIds] : [],
        actor: 'persona',
        ...(envelope.invocationId ? { invocationId: envelope.invocationId } : {}),
        // Her turn and the call's place in it: an errand records the turn, and a retry of the same
        // call cannot queue a second one (src/errands/store.js#add).
        ...(envelope.turnId ? { turnId: envelope.turnId } : {}),
        ...(envelope.idempotencyKey ? { idempotencyKey: envelope.idempotencyKey } : {}),
        // Her own initiative (an inner turn) and its causal chain: which of her candidates the call
        // may accept (src/intentions/model.js#acceptRefusal).
        ...(initiative
          ? {
              ownInitiative: true,
              ...(envelope.chainId ? { chainId: String(envelope.chainId) } : {}),
              ...(envelope.wakeKind ? { wakeKind: String(envelope.wakeKind) } : {}),
            }
          : {}),
        // The message her turn answers: where an errand she starts brings its result back (src/tools/impl/task.ts).
        ...(Array.isArray(envelope.sourceMessageIds) && envelope.sourceMessageIds.length > 0
          ? { sourceMessageId: String(envelope.sourceMessageIds[0]) }
          : {}),
        ...(resolved.repliedAuthorId ? { repliedAuthorId: String(resolved.repliedAuthorId) } : {}),
        ...(mentionUserIds.length > 0 ? { mentionUserIds } : {}),
      }),
      deps.timeoutMs ?? CALL_TIMEOUT_MS
    );
    // Dispatched and not back in time: it may have taken effect. Never retried.
    if (result?.timedOut === true)
      return { status: 'unknown', code: CODE.TIMEOUT, values: { what: WHAT.chat }, data: { text: '' } };
    const status = callStatus(result);
    const embeds = Array.isArray(result?.data?.embeds) && result.data.embeds.length > 0;
    const text = embeds ? cardText(result) : String(result?.summary ?? '');
    const out = {
      status,
      ...(status === 'ok' ? {} : { code: String(result?.code ?? CODE.ERROR) }),
      data: { text },
      ...(result?.data?.ref ? { ref: result.data.ref } : {}),
      ...(result?.data?.voice ? { voice: result.data.voice } : {}),
      ...(status === 'ok' && typeof result?.data?.task?.id === 'string' ? { taskId: result.data.task.id } : {}),
      ...(status === 'ok' && typeof result?.data?.intention?.id === 'string'
        ? { intentionId: result.data.intention.id }
        : {}),
    };
    const files = status === 'ok' && Array.isArray(result?.data?.files) ? result.data.files : [];
    if (files.length === 0) return out;
    // The post of the files is a post of hers: the wake envelope is asked again right where it happens.
    const posting = nestedRefusal({ config: deps.config, wakeKind, capability: 'message.create' });
    if (posting) return { status: 'denied', code: posting.reason, reason: posting.detail, data: { text } };
    const attachments = files.map((file) => ({ name: String(file?.name ?? 'file'), data: file?.attachment }));
    const sent = fromPort(await deps.port.send(deps.refOf(deps.opContext?.channelId), { attachments }));
    return { ...sent, data: { text } };
  } catch (err) {
    return { status: 'failed', code: CODE.ERROR, error: err };
  }
}

/** The rule of a schema path (src/tools/schema.ts#schemaError, resolveCall) -> the kind of its detail. */
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
 * `labels.transcript.callReasons`, src/format.js): `{ kind, code, arg }`. An
 * `invalid-args` refusal with a schema path (`args.<arg>[.<more>]:<rule>`) names the argument and
 * what was wrong with it (`missing-arg`, `unknown-arg`, `arg-twice`, `too-long`, `too-short`,
 * `unknown-channel`, `unknown-role`, else `wrong-arg`); `unknown-message` names the option (`message`, `reply`) whose message was not in view,
 * or is `message-elsewhere` when that message lives in another channel than the one named, or
 * `message-deleted` when the record holds it as deleted (a `#N` of a placeholder line, or an id or
 * link of one: `view.deletedIds`);
 * `not-own-message` names `message`; `unknown-member` with several matches is `member-ambiguous`;
 * `agent-required` names `agent` and carries the agents its reason lists (`values`; the mark words
 * it through `labels.skills.refusals.agentRequired`).
 * An `unknown-arg` refusal carries the arguments the skill does take (`values`, from `argNames`
 * when given and not empty), so its mark can name them (`labels.skills.refusals.unknownArg`).
 * Any other code is its own kind without an argument. With `textChars` (a positive number) and
 * the operation's own message in `outcome.data.text`, that message rides along as `text`: one
 * line, cut to `textChars` with an ellipsis (src/memory/clamp.js) -- what the mark says when no
 * specific label words the kind, ahead of the generic phrase of the code. Null for an `ok`
 * outcome or one without a code. Pure.
 * @param {{ status?: string, code?: string|null, reason?: string|null, data?: { text?: string }|null }|null|undefined} outcome
 * @param {{ textChars?: number, argNames?: string[]|null }} [options]
 * @returns {{ kind: string, code: string, arg: string|null, text?: string, values?: string[], fields?: object }|null}
 */
export function outcomeDetail(outcome, { textChars = 0, argNames = null } = {}) {
  const code = typeof outcome?.code === 'string' ? outcome.code : '';
  if (!code || outcome.status === 'ok') return null;
  const reason = typeof outcome.reason === 'string' ? outcome.reason : '';
  const said =
    Number.isFinite(textChars) && textChars > 0 ? clampWithEllipsis(oneLine(outcome.data?.text), textChars) : '';
  const fields =
    outcome.values && typeof outcome.values === 'object' && !Array.isArray(outcome.values)
      ? { ...outcome.values }
      : null;
  const of = (kind, arg = null) => ({
    kind,
    code,
    arg,
    ...(said ? { text: said } : {}),
    ...(fields ? { fields } : {}),
  });
  if (code === CODE.INVALID_ARGS) {
    const path = /^args\.([^.:]+)(?:\.[^:]*)?:(.+)$/.exec(reason);
    if (path) {
      const kind = ARG_RULE_KINDS[path[2]] ?? 'wrong-arg';
      const known =
        kind === 'unknown-arg' && Array.isArray(argNames)
          ? argNames.filter((name) => typeof name === 'string' && name)
          : [];
      return known.length > 0 ? { ...of(kind, path[1]), values: known } : of(kind, path[1]);
    }
    return of(code);
  }
  if (code === CODE.UNKNOWN_MESSAGE) {
    if (reason === 'conversation') return of('message-elsewhere');
    if (reason === CODE.MESSAGE_DELETED) return of(CODE.MESSAGE_DELETED);
    return MESSAGE_OPTIONS.includes(reason) ? of(code, reason) : of(code);
  }
  if (code === CODE.NOT_OWN_MESSAGE) return of(code, 'message');
  if (code === CODE.UNKNOWN_MEMBER && reason === 'ambiguous') return of('member-ambiguous');
  if (code === CODE.AGENT_REQUIRED) {
    const agents = reason
      .split(',')
      .map((agent) => agent.trim())
      .filter(Boolean);
    return { ...of(code, 'agent'), ...(agents.length > 0 ? { values: agents } : {}) };
  }
  return of(code);
}
