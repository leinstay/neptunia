// What one `<call>` of the persona's output (src/llm/parse.js) does once the gateway
// (src/skills/gateway.js#checkSkill) let it pass. Her skills are the owner's /nep commands
// (src/skills/derive.js): a call names an operation and gives the options of the command that
// runs it as attributes. Two steps. `resolveCall` turns the tag's string attributes into the
// command's arguments on the server's side -- a channel reference she sees (`#handle`, `#name`,
// `<#id>` or an id) into a channel id, a member's name or mention into a stored profile's id, a role into its
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
import { channelCore, matchChannel, MESSAGE_LINK_RE, occursAsWholeWord } from '../memory/mentions.js';
import { foldText } from '../memory/recent.js';
import { SELF_OWNED_OPS } from '../ops/effects.js';

/** The options whose value may be a transcript number `#N`: a message she can see. */
const MESSAGE_OPTIONS = Object.freeze(['message', 'reply']);

/** The options whose value is a file handle of one of her errands (`file:<task id>/<name>`). */
const FILE_OPTIONS = Object.freeze(['file']);

/** A whole errand file handle, as src/errands/store.js reads one. */
const FILE_HANDLE_RE = /^file:[A-Za-z0-9_-]{1,64}\/[^/\\]{1,200}$/;

/** The skill whose `agent` she must name: refused `agent-required` (with the agents) when left out. */
const AGENT_SKILL = 'task.run';

/**
 * The operations whose success is its own answer: a message or a picture that went out, and an
 * errand accepted (its id is in her `<tasks>` block from her next turn on; she does not wait).
 */
export const QUIET_ON_OK = Object.freeze(['message.create', 'message.edit', 'message.delete', 'message.react.add', 'message.react.remove', 'draw.create', 'task.run']);

/** The operations whose `text` is the persona's own writing, posted as a `<msg>` of hers is (mentions, custom emoji, links). */
const WRITTEN = Object.freeze(['message.create', 'message.edit']);

/** Every status a call result may have. */
export const RESULT_STATUSES = Object.freeze(['ok', 'denied', 'not_configured', 'invalid', 'unknown', 'partial', 'failed']);

/** The operation codes that mean what it needs is not set up (a missing channel, client, interface or guild). */
const NOT_CONFIGURED_CODES = Object.freeze(['not-configured', 'unsupported', 'no-guild']);

/** The refusal codes of a call that was not right, as opposed to a rule that said no. */
const INVALID_CODES = Object.freeze(['invalid-args', 'agent-required', 'unknown-skill', 'unknown-member', 'unknown-message', 'unknown-file', 'target-ambiguous', 'unknown-op', 'not-found']);

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
 * The conversation id a channel reference (`#handle`, `#name`, `name`, `<#id>`, an id) names among
 * `conversations` (`{ id, name }`, one entry per id): a handle of `channelHandles` (the request's
 * channel handle without `#` -> channel id; with or without its `#`, exactly) first, else a name by
 * src/memory/mentions.js#matchChannel (the exact name, else the one channel with the same core:
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

/** Whether `text` names the channel `channelId`: its mention `<#id>`, one of its handles, or its name (by its core: any case, accents, emoji) as a whole word. */
function namesChannel(text, channelId, names, handles) {
  const raw = String(text ?? '');
  if (!raw.trim()) return false;
  if (raw.includes(`<#${channelId}>`)) return true;
  const folded = foldText(raw);
  return handles.some((handle) => occursAsWholeWord(folded, foldText(handle))) || names.some((name) => occursAsWholeWord(folded, channelCore(name)));
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
  const names = (view?.conversations ?? []).filter((c) => c && String(c.id) === channelId && typeof c.name === 'string' && c.name).map((c) => c.name);
  const handles = view?.channelHandles instanceof Map ? [...view.channelHandles].filter(([, id]) => String(id) === channelId).map(([handle]) => handle) : [];
  return [task.goal, view?.triggerText].some((text) => namesChannel(text, channelId, names, handles));
}

/** A line break written as an HTML tag in a call's body. */
const BODY_BREAK_RE = /<br\s*\/?>/gi;
/** One `<name>value</name>` at the start of what is left of a body. */
const BODY_TAG_RE = /^<([A-Za-z][A-Za-z0-9_]*)>([\s\S]*?)<\/\1\s*>/;
/** One `name: value` / `name = value` line at the start of what is left of a body. */
const BODY_LINE_RE = /^([A-Za-z][A-Za-z0-9_]*)[ \t]*[:=]([^\n]*)/;

/**
 * The arguments a call's body spells out when the model wrote them there instead of as
 * attributes: `{ name: value }` when the whole body (a `<br>` read as a line break, blank lines
 * left out) is `name: value` or `name = value` lines and `<name>value</name>` tags, every name one
 * of `names` (the command's option names) and given once, every value non-empty (trimmed); else
 * null -- any other line, an unknown or repeated name, or an empty body. Pure.
 * @param {string} body
 * @param {Iterable<string>} names
 * @returns {Record<string, string>|null}
 */
export function bodyArguments(body, names) {
  const known = new Set(names ?? []);
  let rest = String(body ?? '').replace(BODY_BREAK_RE, '\n').trim();
  if (!rest) return null;
  const out = {};
  while (rest) {
    const match = BODY_TAG_RE.exec(rest) ?? BODY_LINE_RE.exec(rest);
    if (!match) return null;
    const [all, name, raw] = match;
    const value = raw.trim();
    if (!known.has(name) || Object.hasOwn(out, name) || !value) return null;
    out[name] = value;
    rest = rest.slice(all.length).trim();
  }
  return out;
}

/**
 * One `<call>` (`{ skill, args, body }`, src/llm/parse.js) as the arguments of the command behind
 * the skill (`view.skills`: the registry), keyed by the command's option names, or the refusal:
 * `unknown-skill` (no such skill), `invalid-args` (an attribute the command does not take, the
 * text given twice, a channel or role nobody has), `agent-required` (an errand without its agent),
 * `target-ambiguous` (a channel name several share), `unknown-member` (no stored profile by that
 * name, or several), `unknown-message` (a `#N` not in this turn's transcript, or in another
 * channel than the one named), `not-own-message` (`message.edit` / `message.delete` of a line that
 * is not hers), `unknown-file` (a `file` handle that names no file of an errand of hers this
 * conversation may see, `view.fileOf`), `file-elsewhere` (an errand's file bound for a channel
 * other than the one the errand was asked in that neither its goal nor the turn's trigger message,
 * `view.triggerText`, names: fileMayGo; a call without a channel posts here as ever). A `#N` of a `message` or `reply` option becomes the line's message id and, when
 * the command has a `channel` option the call left out, its channel; a reply records the replied
 * author. A Discord message link there (MESSAGE_LINK_RE, bare or in angle brackets) becomes its
 * message id and names its channel the same way (`unknown-message` when the call named another);
 * any other value -- a raw message id -- is passed on as written. A non-empty body fills the
 * skill's body argument (`command.body`, src/skills/derive.js#BODY_ARGS: an errand's `goal`, her
 * `text`) when the call left it out -- `invalid-args` (`args.<arg>:twice`) when it gave it as an
 * attribute too -- and the result names it (`bodyArg`) for the caller to log. When the command
 * takes a `file` the call left out, an errand's file handle on a line of its own in that body
 * becomes the `file` and leaves the text (`fileFromBody: true`; an empty text is a file-only
 * post); two or more are refused `unknown-file` (`file:several`). An errand
 * (`task.run`) without its `agent` is refused `agent-required`, the reason the agents she may
 * name, comma-separated (the schema's choices). A non-empty body for a command
 * without a body option that spells out its options (bodyArguments: `name: value` lines,
 * `<name>value</name>` tags) gives those arguments, an attribute given explicitly winning; the
 * result counts the ones taken (`bodyArgs`) for the caller to log. Any other such body (her
 * comment on the call) is left out and the call goes on with its attributes; the result says so
 * (`bodyIgnored: true`) for the caller to log. Pure.
 * @param {{ skill: string, args: Record<string, string>, body: string }} call
 * A channel option resolves a `#handle` of `view.channelHandles` (the request's, handle -> channel
 * id) exactly before any name.
 * @param {{ skills: Map<string, object>, conversations?: { id: string, name: string }[], channelHandles?: Map<string, string>|null,
 *   messageAt?: (n: number) => ({ id: string, conversationId: string, authorId: string|null, self?: boolean } | null),
 *   members?: { id: string, names?: string[], aliases?: { name: string }[] }[], roles?: { id: string, name: string }[],
 *   selfId?: string|null, fileOf?: (handle: string) => object|null, triggerText?: string|null }} view
 * @returns {{ ok: true, skill: string, args: object, command: object, repliedAuthorId: string|null, bodyArg?: string, fileFromBody?: true, bodyIgnored?: true, bodyArgs?: number }
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
  // A body where the command takes none: its options spelled out (an attribute wins), else her
  // comment on the call, left out -- never a refusal.
  const fromBody = body && !command.body ? bodyArguments(body, byName.keys()) : null;
  const bodyIgnored = Boolean(body) && !command.body && !fromBody;
  let bodyArgs = 0;
  for (const [key, value] of Object.entries(fromBody ?? {})) {
    if (Object.hasOwn(given, key)) continue;
    given[key] = value;
    bodyArgs += 1;
  }
  let fileFromBody = false;
  if (body && command.body) {
    if (Object.hasOwn(given, command.body)) return refused('invalid-args', `args.${command.body}:twice`);
    given[command.body] = body;
    // An errand's file handle on a line of its own there, the call giving no file: the attachment,
    // out of the text (an empty text left is a file-only post); several: refused as an unknown file.
    if (byName.has('file') && !Object.hasOwn(given, 'file')) {
      const lines = body.split('\n');
      const handles = lines.filter((line) => FILE_HANDLE_RE.test(line.trim()));
      if (handles.length > 1) return refused('unknown-file', 'file:several');
      if (handles.length === 1) {
        given.file = handles[0].trim();
        given[command.body] = lines.filter((line) => !FILE_HANDLE_RE.test(line.trim())).join('\n').trim();
        fileFromBody = true;
      }
    }
  }
  // An errand without its agent: refused naming the agents she may pick (the schema's choices), so
  // the refusal she reads says which, never a bare missing argument.
  if (name === AGENT_SKILL && !Object.hasOwn(given, 'agent') && byName.has('agent')) {
    const agents = skill.argsSchema?.properties?.agent?.enum;
    return refused('agent-required', Array.isArray(agents) ? agents.join(',') : '');
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
        const member = memberOf(text, view?.members);
        if (member.ok === false) return member;
        args[option] = member.id;
        break;
      }
      case 'channel': {
        const id = conversationIdOf(text, view?.conversations, view?.channelHandles);
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
        // A file handle must name a file of one of her errands this conversation may see.
        if (FILE_OPTIONS.includes(option)) {
          const file = typeof view?.fileOf === 'function' ? view.fileOf(text) : null;
          if (!file) return refused('unknown-file', option);
          if (file.task) errandFiles.push(file.task);
          args[option] = text;
          break;
        }
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
  // An errand's file goes where the errand was asked; elsewhere only where its goal or the trigger names.
  if (args.channel !== undefined) {
    for (const task of errandFiles) if (!fileMayGo(task, String(args.channel), view)) return refused('file-elsewhere', 'channel');
  }
  return { ok: true, skill: name, args, command, repliedAuthorId, ...(body && command.body ? { bodyArg: command.body } : {}), ...(fileFromBody ? { fileFromBody: true } : {}), ...(bodyIgnored ? { bodyIgnored: true } : {}), ...(fromBody ? { bodyArgs } : {}) };
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
 * `deps.runOwnCommand` (src/admin.js#runOwnCommand: her grant alone, no requester's right), and on
 * her own initiative (`envelope.ownInitiative` with no requester: an inner turn)
 * `deps.runInitiativeCommand` (src/admin.js#runInitiativeCommand, the same for any operation) -- on
 * the call's envelope (`deps.envelope`, built by the turn, never by
 * the model: the requester's `userId` and `roleIds`, null with nobody; the invocation id) in the
 * turn's context (`deps.opContext`: `guildId`, `channelId`), the persona as the actor, the replied
 * author for a reply's notification; not back within `deps.timeoutMs` (`skills.callTimeoutMs`)
 * it is `unknown` (`timeout`), never retried. Its answer is the call's `data.text`
 * whatever the status -- the reply text, a card's fields, or the error or refusal the owner would
 * read -- with its code when it is not `ok`, `ref` when a message went out, and `taskId` when it
 * queued an errand (`task.run`: an inner turn binds the errand's dollar hold to it). Files it answers
 * with (`/nep draw` without a channel) are posted to the current conversation through
 * `deps.port` (`deps.refOf`), as the owner's command shows them to the owner: the call is then
 * that post's result, never generated again. A skill `deps.inTurn` holds (the turn's in-turn
 * tools, features.coreTools: name -> `(args) => result`) runs there instead, on the operation's
 * arguments her call maps to (`command.toCall`, as above), under the same timeout; its result is the call's as it is (a result without a
 * known status is `failed`).
 * @returns {Promise<{ status: string, code?: string, data?: { text: string }, ref?: object|null, taskId?: string }>}
 */
export async function executeCall(resolved, deps) {
  try {
    const args = { ...resolved.args };
    const tool = deps.inTurn && Object.hasOwn(deps.inTurn, resolved.skill) ? deps.inTurn[resolved.skill] : null;
    if (typeof tool === 'function') {
      // The operation's own arguments, mapped by its command as for the owner's command.
      const mapped = resolved.command ? resolved.command.toCall(args) : { op: resolved.skill, args };
      if (!mapped.args || mapped.op !== resolved.skill) return { status: 'invalid', code: 'invalid-args', reason: 'command' };
      const answered = await withTimeout(Promise.resolve(tool(mapped.args)), deps.timeoutMs ?? CALL_TIMEOUT_MS);
      if (answered?.timedOut === true) return { status: 'unknown', code: 'timeout', data: { text: '' } };
      return RESULT_STATUSES.includes(answered?.status) ? answered : { status: 'failed', code: 'error' };
    }
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
    // Her own expressive operations run on her grant alone; any other on the requester's right too,
    // except on her own initiative (an inner turn, nobody asked): her grant alone, the gateway's.
    const envelope = deps.envelope ?? {};
    const requester = envelope.requester ?? null;
    const initiative = envelope.ownInitiative === true && !requester;
    const run = SELF_OWNED_OPS.includes(resolved.skill) ? deps.runOwnCommand : initiative ? deps.runInitiativeCommand : deps.runCommand;
    if (typeof run !== 'function') return { status: 'not_configured', code: 'unsupported' };
    const result = await withTimeout(run(call.key, call.args, {
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
      ...(initiative ? { ownInitiative: true, ...(envelope.chainId ? { chainId: String(envelope.chainId) } : {}) } : {}),
      // The message her turn answers: where an errand she starts brings its result back (src/ops/task.js).
      ...(Array.isArray(envelope.sourceMessageIds) && envelope.sourceMessageIds.length > 0 ? { sourceMessageId: String(envelope.sourceMessageIds[0]) } : {}),
      ...(resolved.repliedAuthorId ? { repliedAuthorId: String(resolved.repliedAuthorId) } : {}),
      ...(mentionUserIds.length > 0 ? { mentionUserIds } : {}),
    }), deps.timeoutMs ?? CALL_TIMEOUT_MS);
    // Dispatched and not back in time: it may have taken effect. Never retried.
    if (result?.timedOut === true) return { status: 'unknown', code: 'timeout', data: { text: '' } };
    const status = callStatus(result);
    const embeds = Array.isArray(result?.data?.embeds) && result.data.embeds.length > 0;
    const text = embeds ? cardText(result) : String(result?.summary ?? '');
    const out = { status, ...(status === 'ok' ? {} : { code: String(result?.code ?? 'error') }), data: { text }, ...(result?.data?.ref ? { ref: result.data.ref } : {}), ...(status === 'ok' && typeof result?.data?.task?.id === 'string' ? { taskId: result.data.task.id } : {}) };
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
 * `labels.transcript.callReasons`, src/format.js): `{ kind, code, arg }`. An
 * `invalid-args` refusal with a schema path (`args.<arg>[.<more>]:<rule>`) names the argument and
 * what was wrong with it (`missing-arg`, `unknown-arg`, `arg-twice`, `too-long`, `too-short`,
 * `unknown-channel`, `unknown-role`, else `wrong-arg`); `unknown-message` names the option (`message`, `reply`) whose message was not in view,
 * or is `message-elsewhere` when that message lives in another channel than the one named;
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
 * @returns {{ kind: string, code: string, arg: string|null, text?: string, values?: string[] }|null}
 */
export function outcomeDetail(outcome, { textChars = 0, argNames = null } = {}) {
  const code = typeof outcome?.code === 'string' ? outcome.code : '';
  if (!code || outcome.status === 'ok') return null;
  const reason = typeof outcome.reason === 'string' ? outcome.reason : '';
  const said = Number.isFinite(textChars) && textChars > 0 ? clampWithEllipsis(oneLine(outcome.data?.text), textChars) : '';
  const of = (kind, arg = null) => ({ kind, code, arg, ...(said ? { text: said } : {}) });
  if (code === 'invalid-args') {
    const path = /^args\.([^.:]+)(?:\.[^:]*)?:(.+)$/.exec(reason);
    if (path) {
      const kind = ARG_RULE_KINDS[path[2]] ?? 'wrong-arg';
      const known = kind === 'unknown-arg' && Array.isArray(argNames) ? argNames.filter((name) => typeof name === 'string' && name) : [];
      return known.length > 0 ? { ...of(kind, path[1]), values: known } : of(kind, path[1]);
    }
    return of(code);
  }
  if (code === 'unknown-message') {
    if (reason === 'conversation') return of('message-elsewhere');
    return MESSAGE_OPTIONS.includes(reason) ? of(code, reason) : of(code);
  }
  if (code === 'not-own-message') return of(code, 'message');
  if (code === 'unknown-member' && reason === 'ambiguous') return of('member-ambiguous');
  if (code === 'agent-required') {
    const agents = reason.split(',').map((agent) => agent.trim()).filter(Boolean);
    return { ...of(code, 'agent'), ...(agents.length > 0 ? { values: agents } : {}) };
  }
  return of(code);
}
