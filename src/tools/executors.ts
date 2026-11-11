// What one `<call>` of the persona's output (src/llm/parse.ts) does once the gateway
// (src/tools/gateway.ts#checkSkill) let it pass. Her skills have a table of their own
// (src/tools/definitions.ts): a call names an operation and gives its arguments as attributes. Two steps. `resolveCall` turns the tag's string attributes into the
// command's arguments on the server's side -- a channel reference she sees (`#handle`, `#name`,
// `<#id>` or an id) into a channel id, a member's name or mention into a stored profile's id, a role into its
// id, a transcript number `#N` or a message link (a `message` or `reply` option) into that
// message's id and channel, a whole number or `true` / `false` read strictly -- so nothing the model writes is
// taken as an id unchecked. `executeCall` then runs the operation by its name
// (src/admin.ts#runSkillOp), the persona as the actor, on the grant the gateway checked: who asked
// adds no rights check. Its answer -- an error or a refusal included -- is the text the owner
// would see. Every result is `{ status, code?, data? }`, structured and honest (RESULT_STATUSES):
// `ok` only when the operation answered ok; `denied` (a rule said no), `invalid` (the call was
// not right), `not_configured` (what it needs is not set up), `unknown` (it may have taken effect:
// never retried), `partial`, `failed`. Codes are kebab-case; no wording here: the persona reads a
// result through `labels.tools.result`.

import type { PublicationBoundary } from './publication.ts';
import type { NativeMessageLocator, ResolvedRecallAnchor, StoredSourceRef } from '../memory/db/recall.ts';
import type { FindMeaning } from '../memory/db/graph-find.ts';
import { clampWithEllipsis, oneLine } from '../memory/clamp.ts';
import { cliChatRef } from '../interface/cli-chat.ts';
import type { PlaceRef } from '../memory/db/frame-reads.ts';
import { channelCore, matchChannel, occursAsWholeWord } from '../memory/mentions.ts';
import { foldText } from '../memory/recent.ts';
import { CODE, INVALID_CODES, NOT_CONFIGURED_CODES, WHAT } from './codes.ts';
import { nestedRefusal } from './access.ts';
import { hasTrait } from './definitions.ts';
import { bindPublicationPort, publicationRefusal } from './publication.ts';
import { heldPort } from './send-hold.ts';
import { idText, isObj, listOf, objOf, textOf } from './types.ts';
import type { Obj, Skill, SkillMap } from './types.ts';
import type { Refusal } from './gateway.ts';
import { foundPlaces, indexedPlace, matchPlace } from './place-names.ts';
import type { PlaceCandidate, PlaceMatch } from './place-names.ts';
import type { Reads } from '../interface/reads.ts';
import type { ChatRef } from '../protocol/adapter.ts';

/** A message of this turn's transcript as the view finds it by its number. */
export type ViewLine = {
  stored?: StoredSourceRef;
  native?: NativeMessageLocator;
  id: string;
  chatId: string;
  authorId?: string | null;
  self?: boolean;
  deleted?: boolean;
};

/** What the server knows of the turn that resolves a call: the skills, the names it may resolve and the transcript. */
export type CallView = {
  currentIface?: string;
  skills?: SkillMap;
  chats?: ReadonlyArray<{ id: unknown; name?: unknown }>;
  /** The places a read call may name (src/behavior/readable-places.ts); without it a read names `chats`. */
  places?: ReadonlyArray<PlaceCandidate>;
  /** The stemmer a place name is compared with, when one is loaded. */
  stem?: ((word: string) => string) | null;
  /** The live places a name names in the memory's name index, under the turn's context (names.ts#placesNamed). */
  placesNamed?: ((name: string) => ReadonlyArray<{ id: string; name: string }>) | null;
  /**
   * The places the memory graph ranks for words that name no place, best first, under the turn's context (graph-find.ts),
   * by words alone or fused with the words' embedding when one is given.
   */
  placesFound?:
    | ((
        words: string,
        meaning?: FindMeaning
      ) => ReadonlyArray<{ id: string; name: string; about: string | null; hasEveryWord?: boolean }>)
    | null;
  /** The turn's embeddings for the finder (graph-find.ts#createFindMeaning): one already made, or one made now. */
  findMeaning?: {
    known: (text: string) => FindMeaning | null;
    fetch: (text: string) => Promise<FindMeaning | null>;
  } | null;
  /** A stored place by its id as its interface knows it, null without a row (frame-reads.ts#placeRefOf). */
  placeRef?: ((placeId: string) => PlaceRef | null) | null;
  channelHandles?: ReadonlyMap<string, string> | null;
  memberHandles?: ReadonlyMap<string, string> | null;
  links?: ReadonlyMap<string, { chatId: string; messageId: string } | null> | null;
  messageAt?: (n: number) => ViewLine | null;
  members?: ReadonlyArray<{ id: unknown; names?: ReadonlyArray<unknown>; aliases?: ReadonlyArray<{ name?: unknown }> }>;
  roles?: ReadonlyArray<{ id: unknown; name?: unknown }>;
  selfId?: string | null;
  fileOf?: (handle: string) => { expired?: boolean; errand?: Obj | null } | null;
  triggerText?: string | null;
  deletedIds?: ReadonlySet<string>;
};

/** The trusted identity selected for cached message contents. */
export type ResolvedMessageRef =
  Readonly<{ kind: 'stored'; stored: StoredSourceRef }> | Readonly<{ kind: 'native'; native: NativeMessageLocator }>;

/** A call resolved to the arguments of its operation. */
export type Resolved = {
  memoryAnchor?: ResolvedRecallAnchor;
  messageRef?: ResolvedMessageRef;
  ok: true;
  skill: string;
  args: Obj;
  dispatch: NonNullable<Skill['dispatch']>;
  repliedAuthorId: string | null;
  channelFixed?: true;
};

/** What a call came to: its status and what she reads of it. Further fields carry the operation's answer. */
export type CallResult = { status: string; code?: string; reason?: string; data?: Obj; [key: string]: unknown };

/** The text of a value an argument may carry: a string, a number or a boolean; else empty. */
const argText = (value: unknown): string =>
  typeof value === 'string' ? value : typeof value === 'number' || typeof value === 'boolean' ? String(value) : '';
/**
 * What an operation's result carries for her turn beside its text: the values its code's label names, the route
 * of a model role's call that went to the core model or did not happen (src/tools/gateway.ts#callOnRoute), read off
 * the result or, for an `ok` reply, its data, and `deferred` for a post kept for a chat that is not open.
 */
function carriedOf(result: Obj): Obj {
  const route = result.route ?? objOf(result.data).route;
  return {
    ...(isObj(result.values) ? { values: result.values } : {}),
    ...(route === 'core' || route === 'unavailable' ? { route } : {}),
    // A post the interface kept for a chat that is not open (src/interface/cli-chat.ts).
    ...(objOf(result.data).deferred === true ? { deferred: true } : {}),
  };
}
/** The options whose value may be a transcript number `#N`: a message she can see. */
const MESSAGE_OPTIONS: ReadonlyArray<string> = Object.freeze(['message', 'reply', 'around', 'anchor', 'media']);

/**
 * The options of conversation.read that are a message when written as `#N` or a link and a count
 * otherwise (`before=#40`, `before=5`).
 */
const ANCHOR_OPTIONS: Readonly<Record<string, ReadonlyArray<string>>> = Object.freeze({
  'conversation.read': ['before', 'after'],
});

/** The text of a pasted link as the view's `links` keys it: without angle brackets. */
export function linkKey(text: unknown): string {
  return argText(text)
    .trim()
    .replace(/^<(.*)>$/, '$1');
}

/**
 * The message links in the arguments of `calls` that the interface can read, for one step: link text (as `linkKey`
 * writes it) -> the message it names, or null when it names none. One `parseLinks` read for all of them (at most 50
 * links of 2,000 characters); null when there is no link or the interface does not read links.
 */
export async function linksOfCalls(
  reads: Reads | null | undefined,
  calls: unknown
): Promise<Map<string, { chatId: string; messageId: string } | null> | null> {
  const found = new Set<string>();
  for (const call of listOf(calls))
    for (const value of Object.values(objOf(objOf(call).args))) {
      const text = linkKey(value);
      if (/^https?:\/\//i.test(text) && text.length <= 2000) found.add(text);
    }
  const texts = [...found].slice(0, 50);
  if (texts.length === 0 || !reads) return null;
  const parsed = await reads.parseLinks(texts);
  return parsed === null ? null : new Map(texts.map((text, i) => [text, parsed.refs[i] ?? null]));
}

/** The message a pasted link names, from the view's `links` (the interface read it), or null. */
function linkedMessage(view: CallView | undefined, text: string): { placeId: string; messageId: string } | null {
  const ref = view?.links instanceof Map ? (view.links.get(linkKey(text)) ?? null) : null;
  return ref ? { placeId: idText(ref.chatId), messageId: idText(ref.messageId) } : null;
}

/** Whether `option` of `skill` given as `text` names a message (a transcript number or a link). */
function namesMessage(skill: string, option: string, text: string, view: CallView | undefined): boolean {
  if (MESSAGE_OPTIONS.includes(option)) return true;
  return (ANCHOR_OPTIONS[skill] ?? []).includes(option) && (text.startsWith('#') || linkedMessage(view, text) !== null);
}

/** The option of message.create that names a message of hers whose attachment is posted again. */
const MEDIA_OPTION = 'media';

/** The core's own form of a message in a chat, carrying the channel with the id (src/tools/operations/shared.ts#messageRefOf reads it). */
function mediaRef(placeId: string, messageId: string): string {
  return `ref:${placeId}/${messageId}`;
}

/** Whether the transcript line `line` is the persona's own (`self`, else its author is `selfId`). */
function isOwnLine(line: ViewLine, selfId: string | null | undefined): boolean {
  return (
    line.self === true || (selfId !== null && selfId !== undefined && selfId !== '' && idText(line.authorId) === selfId)
  );
}

/** The options whose value is a file handle of one of her errands (`file:<task id>/<name>`). */
const FILE_OPTIONS: ReadonlyArray<string> = Object.freeze(['file']);

/** The skill whose `agent` she must name: refused `agent-required` (with the agents) when left out. */
const AGENT_SKILL = 'errand.run';
/** The skills whose `people` option is a list of members (ids, names, `@handle`s, comma or space separated), resolved one by one. */
const PEOPLE_LIST_SKILLS: ReadonlyArray<string> = Object.freeze(['intention.set', 'intention.update']);

/** Every status a call result may have. */
export const RESULT_STATUSES: ReadonlyArray<string> = Object.freeze([
  'ok',
  'denied',
  'not_configured',
  'invalid',
  'unknown',
  'partial',
  'failed',
]);

/** What a timed-out in-turn tool was doing (`{what}` of the `timeout` reason); the operations of the chat answer `chat`. */
const TIMEOUT_WHAT: Readonly<Record<string, string | undefined>> = Object.freeze({
  'web.search': WHAT.search,
  'memory.search': WHAT.search,
  'web.read': WHAT.page,
  'media.look': WHAT.picture,
});

/** Milliseconds a call may run before its outcome is `unknown` (`tools.callTimeoutMs`; config.json's value). */
const CALL_TIMEOUT_MS = 120_000;

/**
 * The structured status of a refusal made before anything ran (resolveCall's, the gateway's):
 * `invalid` for a call that was not right, else `denied`.
 */
export function refusalStatus(code: string): 'invalid' | 'denied' {
  return INVALID_CODES.includes(code) ? 'invalid' : 'denied';
}

/** A refusal of the call before or instead of its execution. */
function refused(code: string, reason = ''): Refusal {
  return { ok: false, code, reason };
}

/** NFC, lower case, trimmed: how names are compared. */
function folded(value: unknown): string {
  return argText(value).normalize('NFC').trim().toLocaleLowerCase();
}

/** The id inside a channel reference `<#id>` or a bare id of digits, else null. */
function channelIdOf(reference: string): string | null {
  const match = /^<#(\d+)>$/.exec(reference) ?? /^(\d+)$/.exec(reference);
  return match?.[1] ?? null;
}

/**
 * The chat id a channel reference (`#handle`, `#name`, `name`, `<#id>`, an id) names among
 * `chats` (`{ id, name }`, one entry per id): a handle of `channelHandles` (the request's
 * channel handle without `#` -> channel id; with or without its `#`, exactly) first, else a name by
 * src/memory/mentions.ts#matchChannel (the exact name, else the one channel with the same core:
 * other or no leading emoji, any case and accents). `'ambiguous'` when several share it, null when none.
 */
function chatIdOf(
  reference: unknown,
  chats: CallView['chats'],
  channelHandles: CallView['channelHandles'] = null
): string | null {
  const given = argText(reference).trim();
  if (!given) return null;
  const id = channelIdOf(given);
  if (id) return id;
  const byHandle = channelHandles instanceof Map ? channelHandles.get(given.replace(/^#/, '')) : undefined;
  if (byHandle !== undefined && byHandle !== null && idText(byHandle) !== '') return idText(byHandle);
  const unique = new Map<string, { id: string; name: string }>();
  for (const c of chats ?? [])
    if (c && c.id !== undefined && c.id !== null && !unique.has(idText(c.id)))
      unique.set(idText(c.id), { id: idText(c.id), name: textOf(c.name) });
  const match = matchChannel(given.replace(/^#/, ''), unique.values());
  return match === 'ambiguous' ? 'ambiguous' : idText(match?.id) || null;
}

/** The read skills that name a place among the ones she may read (`view.places`). */
const READ_PLACE_SKILLS: ReadonlyArray<string> = Object.freeze(['memory.search', 'conversation.read']);

/** The refusal of a place name that is not one place, with what she may choose among. */
function placeRefusal(match: Exclude<PlaceMatch, { kind: 'one' }>, given: string, option: string): Refusal {
  const several = match.kind === 'several';
  return {
    ...refused(
      several ? CODE.TARGET_AMBIGUOUS : CODE.INVALID_ARGS,
      several ? 'chat' : `args.${option}:unknown-channel`
    ),
    choices: match.choices,
    place: { match, given },
  };
}

/** The place the name index of the memory finds for `given`, or null when the view reads no index or finds none. */
function indexedOf(given: string, view: CallView | undefined): PlaceMatch | null {
  if (typeof view?.placesNamed !== 'function') return null;
  const match = indexedPlace(given, view.placesNamed);
  return match.kind === 'none' ? null : match;
}

/**
 * The places the memory graph ranks for `given`, as choices with the handle each has in this call view (the request's
 * or a widened one, by place id or by the native id of a chat of the turn); null when the view reads no graph or the
 * graph finds none.
 */
function graphFoundOf(given: string, view: CallView | undefined, misses: Set<string> | null): PlaceMatch | null {
  if (typeof view?.placesFound !== 'function') return null;
  const handles = new Map<string, string>();
  for (const [handle, id] of view.channelHandles ?? []) if (!handles.has(idText(id))) handles.set(idText(id), handle);
  const words = given.replace(/^#/, '').trim();
  const meaning = view.findMeaning?.known(words) ?? null;
  const found = meaning === null ? view.placesFound(words) : view.placesFound(words, meaning);
  // Words no candidate holds in full are worth an embedding (resolveCallWithMeaning); a full match is answer enough.
  if (meaning === null && view.findMeaning && !found.some((place) => place.hasEveryWord === true)) misses?.add(words);
  return foundPlaces(found, (id) => {
    return handles.get(id) ?? handles.get(view.placeRef?.(id)?.nativeId ?? '') ?? null;
  });
}

/**
 * The place a read call names: an id (of digits, or of a chat of the view) or mention and a handle of the request go through as before (the operation's
 * rails still judge the place), any other name is matched among `view.places` (src/tools/place-names.ts#matchPlace),
 * then in the name index, then by the memory graph (graphFoundOf), and one that is not one place is refused with the
 * places she may read, or the places the graph ranked for her words, as `choices`.
 */
function placeOf(given: string, option: string, view: CallView, misses: Set<string> | null): { id: string } | Refusal {
  const id = channelIdOf(given) ?? ((view.chats ?? []).some((c) => idText(c.id) === given) ? given : null);
  if (id) return { id };
  const byHandle = view.channelHandles?.get(given.replace(/^#/, ''));
  if (byHandle !== undefined && idText(byHandle) !== '') return { id: idText(byHandle) };
  const listed = matchPlace(given, view.places ?? [], view.stem ? { stem: view.stem } : {});
  const match =
    listed.kind === 'none' ? (indexedOf(given, view) ?? graphFoundOf(given, view, misses) ?? listed) : listed;
  return match.kind === 'one' ? { id: match.id } : placeRefusal(match, given, option);
}

/**
 * The place a `place` option names: a place id of any interface for the calls that take one, among the places she may
 * read for the read skills, else among the chats of the view, then in the name index of the memory, which
 * holds the places of every interface by their stored names and aliases, and last by the memory graph (graphFoundOf).
 */
function channelOf(
  skill: string,
  given: string,
  option: string,
  view: CallView | undefined,
  misses: Set<string> | null
): { id: string } | Refusal {
  // A stored place's id names it on any interface, and the command line's place id names his chat whether or not a row
  // holds it yet; the operation asks that interface whether she may act there.
  const asPlace = given.trim();
  if (cliChatRef(asPlace) !== null || (view?.placeRef?.(asPlace) ?? null) !== null) return { id: asPlace };
  if (READ_PLACE_SKILLS.includes(skill) && view?.places) return placeOf(given, option, view, misses);
  const id = chatIdOf(given, view?.chats, view?.channelHandles);
  if (id === 'ambiguous') return refused(CODE.TARGET_AMBIGUOUS, 'chat');
  if (id) return { id };
  const indexed = indexedOf(given, view) ?? graphFoundOf(given, view, misses);
  if (indexed === null) return refused(CODE.INVALID_ARGS, `args.${option}:unknown-channel`);
  return indexed.kind === 'one' ? { id: indexed.id } : placeRefusal(indexed, given, option);
}

/** The id of a role reference (`<@&id>` or an id), or of the one role of `roles` by that name; else null. */
function roleIdOf(reference: unknown, roles: CallView['roles']): string | null {
  const given = argText(reference).trim();
  const match = /^<@&(\d+)>$/.exec(given) ?? /^(\d+)$/.exec(given);
  if (match) return match[1] ?? null;
  const name = folded(given.replace(/^@/, ''));
  const ids = new Set(
    (Array.isArray(roles) ? roles : [])
      .filter((role) => typeof role.name === 'string' && folded(role.name) === name)
      .map((role) => idText(role.id))
  );
  return ids.size === 1 ? ([...ids][0] ?? null) : null;
}

/** The transcript number of `#N` / `N` (six digits at most: never a platform id), else null. */
function transcriptNumber(value: unknown): number | null {
  const match = /^#?(\d{1,6})$/.exec(argText(value).trim());
  return match ? Number(match[1]) : null;
}

/**
 * The stored member a name or mention (`<@id>`, `<@!id>`, `@name`, an id) names, or a `@handle` of
 * `handles` (the request's, handle -> member id: resolved exactly, before any name), `{ id }` or a refusal.
 */
function memberOf(
  reference: unknown,
  members: CallView['members'],
  handles: CallView['memberHandles'] = null
): { id: string } | Refusal {
  const given = argText(reference).trim();
  const list = Array.isArray(members) ? (members as NonNullable<CallView['members']>) : [];
  const mention = /^<@!?(\d+)>$/.exec(given) ?? /^(\d+)$/.exec(given);
  if (mention?.[1] !== undefined) {
    const wanted = mention[1];
    return list.some((member) => idText(member.id) === wanted) ? { id: wanted } : refused(CODE.UNKNOWN_MEMBER, 'id');
  }
  const byHandle = handles instanceof Map && given.startsWith('@') ? handles.get(given.slice(1)) : undefined;
  if (byHandle) return { id: idText(byHandle) };
  const name = folded(given.replace(/^@/, ''));
  if (!name) return refused(CODE.UNKNOWN_MEMBER, 'empty');
  const ids = new Set<string>();
  for (const member of list) {
    const names: Array<unknown> = [
      ...(Array.isArray(member.names) ? member.names : []),
      ...(Array.isArray(member.aliases) ? member.aliases.map((alias) => alias.name) : []),
    ];
    if (names.some((candidate) => typeof candidate === 'string' && folded(candidate) === name))
      ids.add(idText(member.id));
  }
  if (ids.size === 1) return { id: [...ids][0] ?? '' };
  return refused(CODE.UNKNOWN_MEMBER, ids.size > 1 ? 'ambiguous' : 'name');
}

/** Whether `text` names the channel `placeId`: its mention `<#id>`, one of its handles, or its name (by its core: any case, accents, emoji) as a whole word. */
function namesChannel(
  text: unknown,
  placeId: string,
  names: ReadonlyArray<string>,
  handles: ReadonlyArray<string>
): boolean {
  const raw = argText(text);
  if (!raw.trim()) return false;
  if (raw.includes(`<#${placeId}>`)) return true;
  const folded = foldText(raw);
  return (
    handles.some((handle) => occursAsWholeWord(folded, foldText(handle))) ||
    names.some((name) => occursAsWholeWord(folded, channelCore(name)))
  );
}

/**
 * Whether a file of the errand `task` may be posted to `placeId`: the errand's origin channel
 * (`task.origin.placeId`; any channel when it has none), else a channel the errand's goal or the
 * trigger message of the turn (`view.triggerText`) names by its mention, a handle of
 * `view.channelHandles` or a name of `view.chats`.
 */
function fileMayGo(task: Obj, placeId: string, view: CallView | undefined): boolean {
  const origin = objOf(task.origin).placeId;
  if (origin === undefined || origin === null || origin === '' || idText(origin) === placeId) return true;
  const names = (view?.chats ?? [])
    .filter((c) => idText(c.id) === placeId && typeof c.name === 'string' && c.name)
    .map((c) => textOf(c.name));
  const handles =
    view?.channelHandles instanceof Map
      ? [...view.channelHandles].filter(([, id]) => idText(id) === placeId).map(([handle]) => handle)
      : [];
  return [task.goal, view?.triggerText].some((text) => namesChannel(text, placeId, names, handles));
}

/** Select trusted memory identity or refuse an unroutable live reference. */
function referenceOf(
  name: string,
  option: string,
  line: ViewLine,
  view: CallView | undefined
): Pick<Resolved, 'memoryAnchor' | 'messageRef'> | null {
  const native = line.stored
    ? line.stored.native
    : (line.native ??
      (view?.currentIface
        ? {
            iface: view.currentIface,
            chatId: line.chatId,
            messageId: line.id,
          }
        : undefined));
  if (name === 'memory.search' && option === 'anchor') {
    if (line.stored) return { memoryAnchor: { kind: 'source', sourceId: line.stored.sourceId } };
    return native ? { memoryAnchor: { kind: 'native', locator: native } } : null;
  }
  if ((name === 'web.read' || name === 'media.look') && option === 'message') {
    if (line.stored) return { messageRef: { kind: 'stored', stored: line.stored } };
    return native ? { messageRef: { kind: 'native', native } } : {};
  }
  if (line.stored && (!native || native.iface !== view?.currentIface)) return null;
  return {};
}

function transcriptReference({
  n,
  name,
  option,
  view,
}: {
  n: number;
  name: string;
  option: string;
  view: CallView | undefined;
}): { line: ViewLine; identity: Pick<Resolved, 'memoryAnchor' | 'messageRef'> } | Refusal {
  let line = typeof view?.messageAt === 'function' ? view.messageAt(n) : null;
  if (!line) return refused(CODE.UNKNOWN_MESSAGE, option);
  if (line.deleted === true) return refused(CODE.UNKNOWN_MESSAGE, CODE.MESSAGE_DELETED);
  const identity = referenceOf(name, option, line, view);
  if (!identity) return refused(CODE.UNKNOWN_MESSAGE, option);
  const native = line.stored?.native;
  if (native) line = { ...line, id: native.messageId, chatId: native.chatId };
  if (line.deleted === true) return refused(CODE.UNKNOWN_MESSAGE, CODE.MESSAGE_DELETED);
  return { line, identity };
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
 * chat may see, `view.fileOf`), `file-expired` (the handle of a task whose files the runner has deleted), `file-elsewhere` (an errand's file bound for a channel
 * other than the one the errand was asked in that neither its goal nor the turn's trigger message,
 * `view.triggerText`, names: fileMayGo; a call without a channel posts here as ever). A `#N` of a `message` or `reply` option becomes the line's message id and, when
 * the command has a `channel` option the call left out, its channel; a reply records the replied
 * author. A message link there (`view.links`, which the interface read, bare or in angle brackets) becomes its
 * message id and names its channel the same way (`unknown-message` when the call named another);
 * any other value -- a raw message id -- is passed on as written. An errand
 * (`errand.run`) without its `agent` is refused `agent-required`, the reason the agents she may
 * name, comma-separated (the schema's choices). Pure.
 * `call` is `{ skill, args }`, `args` the strings she wrote. A channel option resolves a `#handle` of `view.channelHandles` (the request's, handle -> channel
 * id) exactly before any name; a member option a `@handle` of `view.memberHandles` (handle -> member
 * id) the same way. The `people` option of PEOPLE_LIST_SKILLS is a list of members (comma or space
 * separated), each resolved like a member option; the ids come out comma-separated.
 */

export function resolveCall(
  call: { skill?: unknown; args?: unknown } | null | undefined,
  view: CallView | undefined,
  misses: Set<string> | null = null
): Resolved | Refusal {
  const name = argText(call?.skill);
  const skill = view?.skills?.get(name);
  if (!skill?.dispatch) return refused(CODE.UNKNOWN_SKILL, name);
  const { dispatch } = skill;
  const byName = new Map(dispatch.options.map((option) => [option.name, option]));
  const given: Obj = { ...objOf(call?.args) };
  for (const key of Object.keys(given)) if (!byName.has(key)) return refused(CODE.INVALID_ARGS, `args.${key}:unknown`);
  // An errand without its agent: refused naming the agents she may pick (the schema's choices), so
  // the refusal she reads says which, never a bare missing argument.
  if (name === AGENT_SKILL && !Object.hasOwn(given, 'agent') && byName.has('agent')) {
    const { properties } = skill.argsSchema;
    const agents = properties?.agent?.enum;
    return refused(CODE.AGENT_REQUIRED, Array.isArray(agents) ? agents.join(',') : '');
  }

  const args: Obj = {};
  const references: Pick<Resolved, 'memoryAnchor' | 'messageRef'> = {};
  const lines: Record<string, ViewLine> = {};
  const linked: Record<string, string> = {}; // option -> the channel id of the message link it was given
  const errandFiles: Array<Obj> = []; // the errands whose files the call carries
  for (const [option, raw] of Object.entries(given)) {
    const text = argText(raw).trim();
    switch (byName.get(option)?.kind ?? '') {
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
        if ('ok' in member) return member;
        args[option] = member.id;
        break;
      }
      case 'place': {
        const channel = channelOf(name, text, option, view, misses);
        if ('ok' in channel) return channel;
        args[option] = channel.id;
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
          const ids: Array<string> = [];
          for (const token of text.split(/[\s,]+/).filter(Boolean)) {
            const member = memberOf(token, view?.members, view?.memberHandles);
            if ('ok' in member) return member;
            if (!ids.includes(member.id)) ids.push(member.id);
          }
          args[option] = ids.join(',');
          break;
        }
        // A file handle must name a file of one of her errands this chat may see.
        if (FILE_OPTIONS.includes(option)) {
          const file = typeof view?.fileOf === 'function' ? view.fileOf(text) : null;
          if (file?.expired) return refused(CODE.FILE_EXPIRED, option);
          if (!file) return refused(CODE.UNKNOWN_FILE, option);
          if (file.errand) errandFiles.push(file.errand);
          args[option] = text;
          break;
        }
        const isMessage = namesMessage(name, option, text, view);
        const n = isMessage ? transcriptNumber(text) : null;
        // A message link (in angle brackets too) names the message and its channel, as the interface read it.
        const link = isMessage && n === null ? linkedMessage(view, text) : null;
        // A message the record holds as deleted and the history does not: refused as deleted.
        const deletedHere = (id: string): boolean =>
          isMessage && view?.deletedIds instanceof Set && view.deletedIds.has(id);
        if (link) {
          if (deletedHere(link.messageId)) return refused(CODE.UNKNOWN_MESSAGE, CODE.MESSAGE_DELETED);
          const identity = referenceOf(
            name,
            option,
            {
              id: link.messageId,
              chatId: link.placeId,
              native: view?.currentIface
                ? { iface: view.currentIface, chatId: link.placeId, messageId: link.messageId }
                : undefined,
            },
            view
          );
          if (!identity) return refused(CODE.UNKNOWN_MESSAGE, `args.${option}`);
          Object.assign(references, identity);
          if (option === MEDIA_OPTION) {
            args[option] = mediaRef(link.placeId, link.messageId);
            break;
          }
          linked[option] = link.placeId;
          args[option] = link.messageId;
          break;
        }
        if (n === null) {
          if (deletedHere(text)) return refused(CODE.UNKNOWN_MESSAGE, CODE.MESSAGE_DELETED);
          args[option] = raw;
          break;
        }
        const selected = transcriptReference({ n, name, option, view });
        if ('ok' in selected) return selected;
        const { line, identity } = selected;
        Object.assign(references, identity);
        if (option === MEDIA_OPTION) {
          // A picture of hers to post again: its own channel is where to fetch it, never where it goes.
          if (name === 'message.create' && !isOwnLine(line, view?.selfId))
            return refused(CODE.NOT_OWN_MESSAGE, 'author');
          args[option] = mediaRef(line.chatId, line.id);
          break;
        }
        lines[option] = line;
        args[option] = idText(line.id);
      }
    }
  }
  // One attachment per post: a picture of hers beside an errand's file or a library GIF is refused.
  if (args[MEDIA_OPTION] !== undefined) {
    if (given.file !== undefined) return refused(CODE.INVALID_ARGS, 'args.media:file');
    if (given.gif !== undefined) return refused(CODE.INVALID_ARGS, 'args.media:gif');
  }

  // A line names its channel: the one the call gave must be it, else it fills the channel option.
  let repliedAuthorId: string | null = null;
  let channelFixed = false;
  for (const [option, line] of Object.entries(lines)) {
    const at = idText(line.chatId);
    if (byName.has('place')) {
      if (args.place === undefined) args.place = at;
      else if (idText(args.place) !== at) {
        if (!messageChannelWins(name, option)) return refused(CODE.UNKNOWN_MESSAGE, 'chat');
        args.place = at;
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
    if (!byName.has('place')) continue;
    if (args.place === undefined) args.place = at;
    else if (idText(args.place) !== at) {
      if (!Object.keys(linked).every((option) => messageChannelWins(name, option)))
        return refused(CODE.UNKNOWN_MESSAGE, 'chat');
      args.place = at;
      channelFixed = true;
    }
  }
  // An errand's file goes where the errand was asked; elsewhere only where its goal or the trigger names.
  if (args.place !== undefined) {
    for (const task of errandFiles)
      if (!fileMayGo(task, idText(args.place), view)) return refused(CODE.FILE_ELSEWHERE, 'place');
  }
  return {
    ok: true,
    skill: name,
    args,
    dispatch,
    repliedAuthorId,
    ...references,
    ...(channelFixed ? { channelFixed: true } : {}),
  };
}

/**
 * resolveCall, with the finder's embedding: a place name whose words the memory graph fits to no place in full is embedded
 * once (`view.findMeaning`, within its deadline) and the call resolved again with the words' meaning. A name the words
 * answer in full, a view with no embedder and a late or failed embedding leave the answer of the words.
 */
export async function resolveCallWithMeaning(
  call: { skill?: unknown; args?: unknown } | null | undefined,
  view: CallView | undefined
): Promise<Resolved | Refusal> {
  const misses = new Set<string>();
  const first = resolveCall(call, view, misses);
  const finder = view?.findMeaning;
  if (misses.size === 0 || !finder) return first;
  const meant = await Promise.all([...misses].map((words) => finder.fetch(words)));
  return meant.some((one) => one !== null) ? resolveCall(call, view, null) : first;
}

/**
 * The calls where the message's own channel wins over a `channel` that does not hold it: they act on that
 * message, so their channel only locates it. `message.create` is not one of them, its channel is where the post goes.
 */
const OWN_CHANNEL_SKILLS: Readonly<Record<string, ReadonlyArray<string>>> = Object.freeze({
  'message.react.add': ['message'],
  'message.react.remove': ['message'],
  'message.edit': ['message'],
  'message.delete': ['message'],
});

/** Whether, for `skill`, the channel of the message in `option` wins over the one the call gave. */
function messageChannelWins(skill: string, option: string): boolean {
  return (OWN_CHANNEL_SKILLS[skill] ?? []).includes(option);
}

/** The structured status of an operation's result (src/tools/operations/index.ts#runOp): `ok`; one that may
 * have taken effect (`data.unknown`) `unknown`; a not-configured code `not_configured`; `denied`
 * and `approval_required` `denied`; `invalid` `invalid`; `partial` `partial`; else `failed`. */
function callStatus(answer: unknown): string {
  const result = objOf(answer);
  if (result.status === 'ok') return 'ok';
  if (objOf(result.data).unknown === true) return 'unknown';
  if (typeof result.code === 'string' && NOT_CONFIGURED_CODES.includes(result.code)) return 'not_configured';
  if (result.status === 'denied' || result.status === 'approval_required') return 'denied';
  if (result.status === 'invalid') return 'invalid';
  if (result.status === 'partial') return 'partial';
  return 'failed';
}

/** `promise`, or `{ timedOut: true }` after `ms` (a timer that never holds the process open). */
function withTimeout(promise: Promise<unknown>, ms: number): Promise<unknown> {
  if (!Number.isFinite(ms) || ms <= 0) return promise;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<{ timedOut: true }>((resolve) => {
    timer = setTimeout(() => resolve({ timedOut: true }), ms);
    timer.unref();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** A status card (`data.fields`) as text: one `name: value` line per field. */
function cardText(result: unknown): string {
  const fields = objOf(objOf(result).data).fields;
  return (Array.isArray(fields) ? (fields as Array<unknown>) : [])
    .map((entry) => {
      const field = objOf(entry);
      return `${argText(field.name)}: ${argText(field.value)}`;
    })
    .join('\n');
}

/** A port result as a call result: `ok` with the message reference, else its status and code. */
function fromPort(answer: unknown): CallResult {
  const result = objOf(answer);
  if (result.status === 'ok') return { status: 'ok', ref: result.ref ?? null, at: result.at };
  const status = result.status === 'unknown' ? 'unknown' : 'failed';
  const error = objOf(result.error);
  return {
    status,
    code: textOf(error.code) || textOf(result.status) || CODE.ERROR,
    error: result.error ?? null,
  };
}

/** What an in-turn tool is told about the call it answers: who asked, where, and the call's key. */
function inTurnCallOf(deps: ExecuteDeps, resolved: Resolved): InTurnCall {
  const asked = deps.envelope?.requester ?? null;
  return {
    ...(resolved.skill === 'memory.search' && resolved.memoryAnchor ? { memoryAnchor: resolved.memoryAnchor } : {}),
    ...((resolved.skill === 'web.read' || resolved.skill === 'media.look') && resolved.messageRef
      ? { messageRef: resolved.messageRef }
      : {}),
    requester: asked === null ? null : { id: asked.id ?? null, roleIds: [...(asked.roleIds ?? [])] },
    chatId: deps.here?.chatId ?? null,
    idempotencyKey: deps.envelope?.idempotencyKey ?? deps.envelope?.invocationId ?? null,
  };
}

/** A line of this chat her text named by its identity is the reply of a post here that names none. */
function replyNamed(skill: string, args: Record<string, unknown>, named: unknown): void {
  if (skill === 'message.create' && typeof named === 'string' && named !== '' && !args.place && !args.reply)
    args.reply = named;
}

/** Refuse a publishing call before an operation or in-turn generator runs. */
function callPublicationRefusal(
  resolved: Resolved,
  deps: ExecuteDeps,
  boundary: PublicationBoundary | null | undefined
) {
  if (boundary == null) return null;
  if (!hasTrait(resolved.skill, 'publishes')) return null;
  if (
    resolved.skill === 'message.create' &&
    resolved.args.selfreflection === true &&
    !resolved.args.place &&
    !resolved.args.replyTo
  )
    return null;
  const channel = resolved.args.place;
  return publicationRefusal(
    boundary,
    typeof channel === 'string' ? deps.refOf(channel) : (deps.here ?? deps.refOf(null))
  );
}

/** Post returned attachments through the turn's publication and hold checks. */
async function postReturnedFiles(
  resultData: Obj,
  out: CallResult,
  {
    deps,
    envelope,
    wakeKind,
    boundary,
    text,
  }: {
    deps: ExecuteDeps;
    envelope: CallEnvelope;
    wakeKind: string | null;
    boundary: PublicationBoundary | null | undefined;
    text: string;
  }
): Promise<CallResult> {
  const files: Array<unknown> = out.status === 'ok' && Array.isArray(resultData.files) ? resultData.files : [];
  if (files.length === 0) return out;
  // The post of the files is a post of hers: the wake envelope is asked again right where it happens.
  const posting = nestedRefusal({ config: deps.config, wakeKind, capability: 'message.create' });
  if (posting) return { status: 'denied', code: posting.reason, reason: posting.detail, data: { text } };
  const attachments = files.map((entry) => {
    const file = objOf(entry);
    return { name: argText(file.name ?? 'file'), data: file.attachment };
  });
  // A wake turn's post of them is held for its end (src/tools/send-hold.ts), under the call's key.
  const destination = deps.here ?? deps.refOf(null);
  const refusal = publicationRefusal(boundary, destination);
  if (refusal) return refusal;
  const port = heldPort(bindPublicationPort(deps.port, boundary), {
    hold: deps.opContext?.hold,
    idempotencyKey: envelope.idempotencyKey,
    publicationBoundary: boundary,
  });
  const sent = fromPort(await port.send(destination, { attachments }));
  return { ...sent, data: { text } };
}

/**
 * Runs one resolved call (`resolved`: resolveCall's) the gateway let pass; never throws (a throw is
 * `failed` with `error`). Her arguments with the command's fixed values, mapped by the command's
 * own option mapper (`dispatch.toOp`), must reach this very operation (else `invalid`); her own
 * writing (`message.create`, `message.edit`) is first rendered as a `<msg>` of hers is posted
 * (`deps.renderText`: the text, or `{ text, accountIds }` -- mentions, custom emoji, message and
 * channel links; src/behavior/turn.ts#renderPost), the members it mentions handed to the
 * operation as `mentionAccountIds`, the only ones it may notify. Then `deps.runOp(op, args, context)`
 * (src/admin.ts#runSkillOp, which runs a call of hers on her grant alone) -- for her own expressive operations
 * (src/tools/definitions.ts, trait `self`) `deps.runOwnOp` (src/admin.ts#runOwnSkillOp), and on
 * her own initiative (`envelope.ownInitiative` with no requester: an inner turn)
 * `deps.runInitiativeOp` (src/admin.ts#runInitiativeSkillOp) -- on
 * the call's envelope (`deps.envelope`, built by the turn, never by
 * the model: the requester's `accountId` and `roleIds`, null with nobody; the invocation id) in the
 * turn's context (`deps.opContext`: `placeId`, the place the call runs in), the persona as the actor, the replied
 * author for a reply's notification; not back within `deps.timeoutMs` (`tools.callTimeoutMs`)
 * it is `unknown` (`timeout`), never retried. Its answer is the call's `data.text`
 * whatever the status -- the reply text, a card's fields, or the error or refusal the owner would
 * read -- with its code when it is not `ok`, `ref` when a message went out, and `taskId` when it
 * queued an errand (`errand.run`). Files it answers
 * with (`/nep draw` without a channel) are posted to the current chat through
 * `deps.port` (`deps.here`), as the owner's command shows them to the owner: the call is then
 * that post's result, never generated again. A skill `deps.inTurn` holds (the turn's in-turn
 * tools: name -> `(args) => result`) runs there instead, on the operation's
 * arguments her call maps to (`dispatch.toOp`, as above), under the same timeout; its result is the call's as it is (a result without a
 * known status is `failed`). On her own initiative (an inner turn) the wake envelope of `envelope.wakeKind`
 * (src/tools/access.ts#nestedRefusal, over `deps.config`, the live config) is checked at the capabilities the skill
 * reaches inside its operation, before it runs and again before its files are posted: `denied` `not-allowed`.
 */
export async function executeCall(resolved: Resolved, deps: ExecuteDeps): Promise<CallResult> {
  try {
    const args: Obj = { ...resolved.args };
    const boundary = deps.publicationBoundary ?? deps.opContext?.publicationBoundary;
    const refusal = callPublicationRefusal(resolved, deps, boundary);
    if (refusal) return refusal;
    const tool = deps.inTurn && Object.hasOwn(deps.inTurn, resolved.skill) ? deps.inTurn[resolved.skill] : null;
    if (typeof tool === 'function') {
      // The operation's own arguments, mapped by its command as for the owner's command.
      const mapped = resolved.dispatch ? resolved.dispatch.toOp(args) : { op: resolved.skill, args };
      if (!mapped.args || mapped.op !== resolved.skill)
        return { status: 'invalid', code: CODE.INVALID_ARGS, reason: 'command' };
      const answered = objOf(
        await withTimeout(
          Promise.resolve(tool(mapped.args, inTurnCallOf(deps, resolved))),
          deps.timeoutMs ?? CALL_TIMEOUT_MS
        )
      );
      if (answered.timedOut === true)
        return {
          status: 'unknown',
          code: CODE.TIMEOUT,
          values: { what: TIMEOUT_WHAT[resolved.skill] ?? WHAT.chat },
          data: { text: '' },
        };
      return typeof answered.status === 'string' && RESULT_STATUSES.includes(answered.status)
        ? (answered as CallResult)
        : { status: 'failed', code: CODE.ERROR };
    }
    // Her own writing as a `<msg>` of hers is posted: the members its mentions resolved to ride along.
    let mentionAccountIds: Array<string> = [];
    if (hasTrait(resolved.skill, 'written') && typeof args.text === 'string' && typeof deps.renderText === 'function') {
      const rendered = deps.renderText(args.text, typeof args.place === 'string' ? args.place : null);
      if (typeof rendered === 'string') args.text = rendered;
      else if (typeof rendered.text === 'string') {
        args.text = rendered.text;
        if (Array.isArray(rendered.accountIds))
          mentionAccountIds = rendered.accountIds.filter((id): id is string => typeof id === 'string' && id !== '');
        replyNamed(resolved.skill, args, rendered.replyTo);
      }
    }
    const call = resolved.dispatch.toOp(args);
    if (!call.args || call.op !== resolved.skill)
      return { status: 'invalid', code: CODE.INVALID_ARGS, reason: 'command' };
    // Every call of hers runs on her grant alone, the gateway's, whoever asked. Her own expressive operations take
    // their own runner, and a call on her own initiative (an inner turn, nobody asked) the initiative's.
    const envelope: CallEnvelope = deps.envelope ?? {};
    const requester = envelope.requester ?? null;
    const initiative = envelope.ownInitiative === true && !requester;
    const run = hasTrait(resolved.skill, 'self') ? deps.runOwnOp : initiative ? deps.runInitiativeOp : deps.runOp;
    if (typeof run !== 'function') return { status: 'not_configured', code: CODE.UNSUPPORTED };
    // An inner turn's wake envelope, at the capabilities this skill reaches inside its operation (a picture or a voice
    // message is a post): checked before anything runs, so nothing paid is made for a post the envelope forbids.
    const wakeKind = initiative && typeof envelope.wakeKind === 'string' ? envelope.wakeKind : null;
    const nested = nestedRefusal({ config: deps.config, wakeKind, skill: resolved.skill });
    if (nested) return { status: 'denied', code: nested.reason, reason: nested.detail, data: { text: '' } };
    const result = objOf(
      await withTimeout(
        Promise.resolve(
          run(call.op, call.args, {
            ...deps.opContext,
            ...(boundary ? { publicationBoundary: boundary } : {}),
            accountId: requester?.id ?? null,
            roleIds: Array.isArray(requester?.roleIds) ? [...requester.roleIds] : [],
            actor: 'persona',
            ...(envelope.invocationId ? { invocationId: envelope.invocationId } : {}),
            // Her turn and the call's place in it: an errand records the turn, and a retry of the same
            // call cannot queue a second one (src/errands/store.ts#add).
            ...(envelope.turnId ? { turnId: envelope.turnId } : {}),
            ...(envelope.idempotencyKey ? { idempotencyKey: envelope.idempotencyKey } : {}),
            // Her own initiative (an inner turn) and its causal chain: which of her candidates the call
            // may accept (src/intentions/model.ts#acceptRefusal).
            ...(initiative
              ? {
                  ownInitiative: true,
                  ...(envelope.chainId ? { chainId: String(envelope.chainId) } : {}),
                  ...(envelope.wakeKind ? { wakeKind: String(envelope.wakeKind) } : {}),
                }
              : {}),
            // The message her turn answers: where an errand she starts brings its result back (src/tools/operations/errand.ts).
            ...(Array.isArray(envelope.sourceMessageIds) && envelope.sourceMessageIds.length > 0
              ? { sourceMessageId: String(envelope.sourceMessageIds[0]) }
              : {}),
            ...(resolved.repliedAuthorId ? { repliedAuthorId: String(resolved.repliedAuthorId) } : {}),
            ...(mentionAccountIds.length > 0 ? { mentionAccountIds } : {}),
          })
        ),
        deps.timeoutMs ?? CALL_TIMEOUT_MS
      )
    );
    // Dispatched and not back in time: it may have taken effect. Never retried.
    if (result.timedOut === true)
      return { status: 'unknown', code: CODE.TIMEOUT, values: { what: WHAT.chat }, data: { text: '' } };
    const status = callStatus(result);
    const resultData = objOf(result.data);
    const taskId = objOf(resultData.task).id;
    const intentionId = objOf(resultData.intention).id;
    const card = Array.isArray(resultData.fields) && resultData.fields.length > 0;
    const text = card ? cardText(result) : argText(result.summary);
    const out: CallResult = {
      status,
      ...(status === 'ok' ? {} : { code: argText(result.code ?? CODE.ERROR) }),
      data: { text },
      ...(resultData.ref ? { ref: resultData.ref } : {}),
      ...(resultData.voice ? { voice: resultData.voice } : {}),
      ...carriedOf(result),
      ...(status === 'ok' && typeof taskId === 'string' ? { taskId } : {}),
      ...(status === 'ok' && typeof intentionId === 'string' ? { intentionId } : {}),
    };
    return await postReturnedFiles(resultData, out, { deps, envelope, wakeKind, boundary, text });
  } catch (err) {
    return { status: 'failed', code: CODE.ERROR, error: err };
  }
}

/** The rule of a schema path (src/tools/schema.ts#schemaError, resolveCall) -> the kind of its detail. */
const ARG_RULE_KINDS: Readonly<Record<string, string>> = Object.freeze({
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
 * `labels.transcript.callReasons`, src/format.ts): `{ kind, code, arg }`. An
 * `invalid-args` refusal with a schema path (`args.<arg>[.<more>]:<rule>`) names the argument and
 * what was wrong with it (`missing-arg`, `unknown-arg`, `arg-twice`, `too-long`, `too-short`,
 * `unknown-channel`, `unknown-role`, else `wrong-arg`); `unknown-message` names the option (`message`, `reply`) whose message was not in view,
 * or is `message-elsewhere` when that message lives in another channel than the one named, or
 * `message-deleted` when the record holds it as deleted (a `#N` of a placeholder line, or an id or
 * link of one: `view.deletedIds`);
 * `not-own-message` names `message`; `unknown-member` with several matches is `member-ambiguous`;
 * `agent-required` names `agent` and carries the agents its reason lists (`values`; the mark words
 * it through `labels.tools.refusals.agentRequired`).
 * An `unknown-arg` refusal carries the arguments the skill does take (`values`, from `argNames`
 * when given and not empty), so its mark can name them (`labels.tools.refusals.unknownArg`).
 * Any other code is its own kind without an argument. With `textChars` (a positive number) and
 * the operation's own message in `outcome.data.text`, that message rides along as `text`: one
 * line, cut to `textChars` with an ellipsis (src/memory/clamp.ts) -- what the mark says when no
 * specific label words the kind, ahead of the generic phrase of the code. Null for an `ok`
 * outcome or one without a code. Pure.
 */
export function outcomeDetail(
  outcome:
    | { status?: string; code?: string | null; reason?: string | null; values?: unknown; data?: unknown }
    | null
    | undefined,
  { textChars = 0, argNames = null }: { textChars?: number; argNames?: ReadonlyArray<unknown> | null } = {}
): OutcomeDetail | null {
  const { code, status, reason, values, data } = outcomePartsOf(outcome);
  if (!code || status === 'ok') return null;
  const said = Number.isFinite(textChars) && textChars > 0 ? clampWithEllipsis(oneLine(data.text), textChars) : '';
  const fields = isObj(values) ? { ...values } : null;
  const of = (kind: string, arg: string | null = null): OutcomeDetail => ({
    kind,
    code,
    arg,
    ...(said ? { text: said } : {}),
    ...(fields ? { fields } : {}),
  });
  if (code === CODE.INVALID_ARGS) {
    const path = /^args\.([^.:]+)(?:\.[^:]*)?:(.+)$/.exec(reason);
    if (path) {
      const kind = ARG_RULE_KINDS[idText(path[2])] ?? 'wrong-arg';
      const arg = path[1] ?? null;
      const known =
        kind === 'unknown-arg' && Array.isArray(argNames)
          ? argNames.filter((name): name is string => typeof name === 'string' && name !== '')
          : [];
      return known.length > 0 ? { ...of(kind, arg), values: known } : of(kind, arg);
    }
    return of(code);
  }
  if (code === CODE.UNKNOWN_MESSAGE) {
    if (reason === 'chat') return of('message-elsewhere');
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

/** The fields of an outcome `outcomeDetail` reads, each empty when it is missing or of another type. */
function outcomePartsOf(outcome: unknown): {
  code: string;
  status: string;
  reason: string;
  values: unknown;
  data: Obj;
} {
  const given = objOf(outcome);
  return {
    code: textOf(given.code),
    status: textOf(given.status),
    reason: textOf(given.reason),
    values: given.values,
    data: objOf(given.data),
  };
}

/** The concrete detail of a call's outcome that is not `ok` (see `outcomeDetail`). */
export type OutcomeDetail = {
  kind: string;
  code: string;
  arg: string | null;
  text?: string;
  values?: Array<string>;
  fields?: Obj;
};

/** The envelope of one call, built by the turn: who asked, the invocation and the wake it belongs to. */
export type CallEnvelope = {
  requester?: { id?: string | null; roleIds?: ReadonlyArray<string> } | null;
  ownInitiative?: boolean;
  wakeKind?: string | null;
  invocationId?: string | null;
  turnId?: string | null;
  idempotencyKey?: string | null;
  chainId?: string | null;
  sourceMessageIds?: ReadonlyArray<unknown>;
};

/** What an in-turn tool is told about the call it answers: who asked, where, and the call's key. */
export type InTurnCall = {
  memoryAnchor?: ResolvedRecallAnchor;
  messageRef?: ResolvedMessageRef;
  requester: { id: string | null; roleIds: Array<string> } | null;
  chatId: string | null;
  idempotencyKey: string | null;
};

/** How an operation is run for a call: its name, the arguments and the context of the call. */
export type RunOperation = (op: string, args: Obj, context: Obj) => unknown;

/** What `executeCall` needs from the turn. */
export type ExecuteDeps = {
  publicationBoundary?: PublicationBoundary;
  inTurn?: Record<string, (args: Obj, call?: InTurnCall) => unknown>;
  /** Her text as posted, `place` the place it goes to as the call resolved it (null: the turn's own). */
  renderText?: (
    text: string,
    place?: string | null
  ) => string | { text?: unknown; accountIds?: unknown; replyTo?: unknown };
  envelope?: CallEnvelope;
  runOp?: RunOperation;
  runOwnOp?: RunOperation;
  runInitiativeOp?: RunOperation;
  config?: unknown;
  opContext?: Obj & { placeId?: unknown; publicationBoundary?: PublicationBoundary };
  timeoutMs?: number;
  port: { send(ref: unknown, body: unknown): Promise<unknown> };
  /** The chat the turn speaks in, as its interface names it. */
  here?: ChatRef;
  refOf(chatId: unknown): ChatRef;
};
