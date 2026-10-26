// The reads of the adapter contract on the wire: their action names, the action object each method call becomes
// (`readAction`, used by `portAction`), and the boundary check of a read action (`readActionProblem`, used by
// `validateAction`). Shapes only, like validate.js: whether a reference belongs to an interface and what a read finds
// stay with the adapter. The methods and their results are typed in src/protocol/adapter.ts.

/** The read action that fetches messages by id. It changes nothing, so it is not a capability. */
export const MESSAGES_FETCH = 'messages.fetch';

/**
 * Every read action of the port, each answered `{ status: 'ok', ...body }` or a status and an error. A read changes
 * nothing, so none is a capability; an interface declares the ones it offers in `capabilities().reads`.
 */
export const READ_ACTIONS: ReadonlyArray<string> = Object.freeze([
  'conversation.info',
  'conversations.list',
  MESSAGES_FETCH,
  'messages.history',
  'member.info',
  'messages.search',
  'members.search',
  'emoji.list',
  'links.parse',
  'message.reactors',
]);

type Fields = Record<string, unknown>;

const isObject = (value: unknown): value is Fields =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** The own keys of `value` that are not undefined (the options of a read), as a fresh object. */
function definedOnly(value: unknown): Fields {
  if (!isObject(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

/**
 * The action object of a read call: `operation` is the adapter method's name and `args` its arguments in order. An
 * operation that is no read gives null.
 */
export function readAction(operation: string, args: ReadonlyArray<unknown>): Fields | null {
  const [target, second, third] = args;
  const scope = isObject(target) ? target : {};
  const options = isObject(second) ? second : {};
  switch (operation) {
    case 'fetchMessages':
      return { action: MESSAGES_FETCH, conversation: target, messageIds: second };
    case 'conversationInfo':
      return { action: 'conversation.info', conversation: target, ...definedOnly(second) };
    case 'conversations':
      return { action: 'conversations.list', ...definedOnly(target) };
    case 'history':
      return { action: 'messages.history', conversation: target, ...definedOnly(second) };
    case 'memberInfo':
      return { action: 'member.info', communityId: scope.communityId, memberId: scope.memberId };
    case 'searchMessages':
      return { action: 'messages.search', communityId: scope.communityId, ...definedOnly(second) };
    case 'searchMembers':
      return { action: 'members.search', communityId: scope.communityId, prefix: options.prefix, limit: options.limit };
    case 'emoji':
      return { action: 'emoji.list', communityId: scope.communityId };
    case 'parseLinks':
      return { action: 'links.parse', texts: target };
    case 'reactors':
      return { action: 'message.reactors', message: target, emoji: second, limit: third };
    default:
      return null;
  }
}

/** Whether `name` is the action of a read. */
export const isReadAction = (name: unknown): boolean => typeof name === 'string' && READ_ACTIONS.includes(name);

/** The most viewers a conversation read names, the texts and characters of a link parse, and the read limits. */
const MAX_VIEWERS = 25;
const MAX_LINK_TEXTS = 50;
const MAX_LINK_TEXT_CHARS = 2000;
const MAX_HISTORY_LIMIT = 10_000;
const MAX_MEMBER_LIMIT = 1000;
const MAX_REACTOR_LIMIT = 100;

/** A refusal: the field and what is wrong with it, written `field:problem` by the caller. */
type Problem = readonly [field: string, problem: string];

const isId = (value: unknown): value is string => typeof value === 'string' && value !== '';
const isIntegerFrom =
  (min: number, max: number) =>
  (value: unknown): boolean =>
    Number.isInteger(value) && (value as number) >= min && (value as number) <= max;

/** The first problem of `value` at `field`, or null: `required: false` lets an absent one through. */
function field(value: unknown, name: string, check: (value: unknown) => boolean, required = true): Problem | null {
  if (value === undefined) return required ? [name, 'required'] : null;
  return check(value) ? null : [name, 'type'];
}

/** The first problem among `problems`, evaluated in order and only as far as needed. */
function firstOf(...problems: Array<() => Problem | null>): Problem | null {
  for (const make of problems) {
    const problem = make();
    if (problem !== null) return problem;
  }
  return null;
}

function reference(value: unknown, name: string, needMessage: boolean): Problem | null {
  if (!isObject(value)) return [name, value === undefined ? 'required' : 'type'];
  return firstOf(
    () => field(value.iface, `${name}.iface`, isId),
    () => field(value.conversationId, `${name}.conversationId`, isId),
    () => field(value.messageId, `${name}.messageId`, isId, needMessage)
  );
}

function ids(value: unknown, name: string, required: boolean): Problem | null {
  if (value === undefined) return required ? [name, 'required'] : null;
  if (!Array.isArray(value)) return [name, 'type'];
  const bad = value.findIndex((id) => !isId(id));
  return bad >= 0 ? [`${name}.${bad}`, 'type'] : null;
}

function audience(action: Fields): Problem | null {
  return firstOf(
    () => field(action.audience, 'audience', (value) => typeof value === 'boolean', false),
    () => ids(action.viewers, 'viewers', false),
    () => (Array.isArray(action.viewers) && action.viewers.length > MAX_VIEWERS ? ['viewers', 'too-many'] : null)
  );
}

function history(action: Fields): Problem | null {
  const anchors = ['before', 'after', 'around'].filter((key) => action[key] !== undefined);
  return firstOf(
    () => reference(action.conversation, 'conversation', false),
    () => field(action.limit, 'limit', isIntegerFrom(1, MAX_HISTORY_LIMIT)),
    () => firstOf(...anchors.map((key) => () => field(action[key], key, isId))),
    () => (anchors.length > 1 ? ['history', 'anchors'] : null),
    () => field(action.since, 'since', Number.isFinite, false),
    () =>
      action.since !== undefined && (action.after !== undefined || action.around !== undefined)
        ? ['history', 'since']
        : null
  );
}

function messageSearch(action: Fields): Problem | null {
  return firstOf(
    () => field(action.communityId, 'communityId', isId),
    () => field(action.text, 'text', (value) => typeof value === 'string', false),
    () => field(action.authorId, 'authorId', isId, false),
    () => field(action.after, 'after', Number.isFinite, false),
    () => field(action.before, 'before', Number.isFinite, false),
    () => field(action.offset, 'offset', isIntegerFrom(0, Number.MAX_SAFE_INTEGER), false)
  );
}

function linkTexts(action: Fields): Problem | null {
  const { texts } = action;
  if (!Array.isArray(texts)) return ['texts', texts === undefined ? 'required' : 'type'];
  if (texts.length > MAX_LINK_TEXTS) return ['texts', 'too-many'];
  for (const [index, text] of texts.entries()) {
    if (typeof text !== 'string') return [`texts.${index}`, 'type'];
    if (text.length > MAX_LINK_TEXT_CHARS) return [`texts.${index}`, 'too-long'];
  }
  return null;
}

/**
 * The first problem of a read action's own fields, as `[field, problem]`, or null when it is well-formed. An action
 * that is no read, and `messages.fetch` (checked beside the effects), give null.
 */
export function readActionProblem(given: unknown): Problem | null {
  const action: Fields = isObject(given) ? given : {};
  const community = (): Problem | null => field(action.communityId, 'communityId', isId);
  switch (action.action) {
    case 'conversation.info':
      return firstOf(
        () => reference(action.conversation, 'conversation', false),
        () => audience(action)
      );
    case 'conversations.list':
      return firstOf(community, () => audience(action));
    case 'messages.history':
      return history(action);
    case 'member.info':
      return firstOf(
        () => field(action.communityId, 'communityId', (value) => value === null || isId(value)),
        () => field(action.memberId, 'memberId', isId)
      );
    case 'messages.search':
      return messageSearch(action);
    case 'members.search':
      return firstOf(
        community,
        () => field(action.prefix, 'prefix', (value) => typeof value === 'string'),
        () => field(action.limit, 'limit', isIntegerFrom(1, MAX_MEMBER_LIMIT))
      );
    case 'emoji.list':
      return community();
    case 'links.parse':
      return linkTexts(action);
    case 'message.reactors':
      return firstOf(
        () => reference(action.message, 'message', true),
        () => field(action.emoji, 'emoji', (value) => typeof value === 'string'),
        () => field(action.limit, 'limit', isIntegerFrom(1, MAX_REACTOR_LIMIT))
      );
    default:
      return null;
  }
}

/**
 * The first problem of the fields a message event carries beyond the old shape: `sourceText` and `system` when
 * present, what a deletion still knows (`message.at`, `message.author`) and `previous` of an edit. `isWholeMessage`
 * is validate.js's own check of a whole message, applied to `previous`.
 */
export function messageExtrasProblem(given: unknown, isWholeMessage: (message: Fields) => boolean): Problem | null {
  const event: Fields = isObject(given) ? given : {};
  const message = isObject(event.message) ? event.message : {};
  if (event.deleted === true) {
    const author = message.author;
    return firstOf(
      () => field(message.at, 'message.at', Number.isFinite, false),
      () => field(author, 'message.author', isObject, false),
      () => (isObject(author) ? field(author.id, 'message.author.id', isId) : null)
    );
  }
  if (event.partial === true) return null;
  const { previous } = event;
  return firstOf(
    () => field(message.sourceText, 'message.sourceText', (value) => typeof value === 'string', false),
    () => field(message.system, 'message.system', (value) => typeof value === 'boolean', false),
    () => field(previous, 'previous', (value) => value === null || isObject(value), false),
    () => (isObject(previous) && !isWholeMessage(previous) ? ['previous', 'type'] : null)
  );
}
