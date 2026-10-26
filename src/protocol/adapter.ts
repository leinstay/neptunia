// The contract between the core and one chat platform, as types: what an adapter can do, what it
// reports back, and what it declares it can handle. No platform concept appears here, so an adapter
// for any platform fits. `deliveryOf` folds the results of a split send into one `Delivery`.

import type { Content, PortResult } from './actions.js';
import type { Conversation, Message, MessageReceived } from './events.js';

export type ConversationRef = { iface: string; conversationId: string };

export type MessageRef = {
  iface: string;
  conversationId: string;
  messageId: string;
  memberId?: string;
};

// `cause` is the platform's own error, kept for the logs and never shown to the model.
export type PortError = { code: string; retryable: boolean; retryAfterMs: number | null; cause?: unknown };

export type Delivery = {
  status: 'ok' | 'failed' | 'unknown' | 'unsupported' | 'forbidden';
  // The first part, for callers that track one message.
  ref: MessageRef | null;
  // Every platform message posted for this send.
  parts: ReadonlyArray<MessageRef>;
  at: number | null;
  idempotencyKey: string;
  error: PortError | null;
};

/**
 * How an interface writes the address of a message, when its platform has one: a template for a message of a
 * community and one for a message of a private chat, each with `{community}`, `{conversation}` and `{message}`.
 */
export type MessageUrlTemplate = { community: string; direct: string };

export type Capabilities = {
  operations: ReadonlyArray<string>;
  maxChars: number;
  maxFiles: number;
  maxFileBytes: number;
  edit: { ownOnly: boolean; windowMs: number | null };
  history: boolean;
  threads: boolean;
  reactions: boolean;
  customEmoji: boolean;
  presence: boolean;
  voiceFormats: ReadonlyArray<string>;
  publish: ReadonlyArray<string>;
  search: boolean;
  /** The wire names of the reads the interface answers (READ_ACTIONS in src/protocol/actions.js). */
  reads?: ReadonlyArray<string>;
  /** Absent or null: the platform gives a message no address. */
  messageUrl?: MessageUrlTemplate | null;
};

/**
 * What a read answers: `{ status: 'ok', ...body }`, or a status and an error. A read never throws and never
 * answers `unknown`: it changed nothing, so asking again is always safe.
 */
export type ReadResult<T> =
  ({ status: 'ok' } & T) | { status: 'failed' | 'unsupported' | 'forbidden'; error: PortError };

/** What the persona may do in a conversation: read its history, send, attach files, react. */
export type Permissions = { read: boolean; send: boolean; attach: boolean; react: boolean };

/**
 * Who can see a conversation, in the shape the audience rail compares (src/behavior/elsewhere.ts#audienceCovers):
 * `groups` are the member groups of the platform (Discord's roles), as ids. The sets of the rail are arrays on the wire.
 * `everyone`: all members of the community can view it. `groups`: the groups that can view it, each on its own.
 * `groupAllow`, `groupDeny`: the groups whose own rule allows or denies viewing. `memberAllow`, `memberDeny`: the
 * members with a rule of their own. `memberGroups`: the groups of each member a rule names, where known.
 */
export type Audience = {
  everyone: boolean;
  groups: Array<string>;
  groupAllow: Array<string>;
  groupDeny: Array<string>;
  memberAllow: Array<string>;
  memberDeny: Array<string>;
  memberGroups: Record<string, Array<string>>;
};

/**
 * A conversation with what the core reads about it: the record of events.js plus the interface it belongs to, what the
 * persona may do there, its owner (a member id, null when the platform has none), the time of its newest message,
 * whether it is a voice room, whether everyone in the community may view it, and, when asked for, its audience and
 * which of the named viewers can see it.
 */
export type ConversationInfo = Conversation & {
  iface: string;
  permissions: Permissions;
  owner: string | null;
  lastMessageAt: number | null;
  voice: boolean;
  public: boolean;
  audience?: Audience | null;
  viewers?: Record<string, boolean>;
};

/** The groups of a community: an id and the name members see. */
export type GroupInfo = { id: string; name: string };

/**
 * A message as a read returns it: the `message.received` event an interface would deliver for it. A deleted, partial
 * or edit event carries only what it knows of the message, so every field but the id may be absent; `previous` is the
 * message as it was before an edit.
 */
export type MessageEvent = Omit<MessageReceived, 'message' | 'previous'> & {
  message: Pick<Message, 'id'> & Partial<Omit<Message, 'id'>>;
  previous?: (Pick<Message, 'id'> & Partial<Omit<Message, 'id'>>) | null;
};

/** One member as `memberInfo` answers it: groups by id and the pictures, each null when unknown. */
export type MemberInfo = {
  id: string;
  name: string | null;
  bot: boolean;
  groupIds: Array<string>;
  avatar: { hash: string | null; url: string | null; largeUrl: string | null };
};

/** One hit of a message search, as the core clusters it. */
export type MessageHit = {
  ref: MessageRef;
  at: number;
  text: string;
  author: { id: string | null; handle: string | null; displayName: string | null; bot: boolean };
};

/** One hit of a member search. */
export type MemberHit = {
  id: string;
  handle: string | null;
  displayName: string | null;
  nickname: string | null;
  bot: boolean;
};

/** A custom emoji of a community with the address of its picture. */
export type EmojiInfo = { id: string; name: string; animated: boolean; url: string };

/** How a history read is anchored: at most one of `before`, `after` and `around`, a floor `since` in ms. */
export type HistoryQuery = {
  limit: number;
  before?: string;
  after?: string;
  around?: string;
  since?: number;
};

/** One message of `fetchMessages`: gone (`missing`), or its text and attachments and its whole event. */
export type FetchedMessage = {
  messageId: string;
  missing?: boolean;
  text?: string;
  attachments?: ReadonlyArray<{
    url?: string;
    name?: string;
    contentType?: string;
    size?: number;
    durationSec?: number;
    waveform?: string;
  }>;
  event?: MessageEvent;
};

export type FetchedMessages = ReadResult<{ messages: ReadonlyArray<FetchedMessage> }>;

export type Adapter = {
  iface: string;
  send(conversation: ConversationRef, content: Content): Promise<Delivery>;
  edit(message: MessageRef, content: Content): Promise<PortResult>;
  delete(message: MessageRef): Promise<PortResult>;
  react(message: MessageRef, emoji: string): Promise<PortResult>;
  unreact(message: MessageRef, emoji: string): Promise<PortResult>;
  typing(conversation: ConversationRef, lease: { untilMs: number }): Promise<PortResult>;
  fetchMessages(conversation: ConversationRef, messageIds: ReadonlyArray<string>): Promise<FetchedMessages>;
  conversationInfo(
    conversation: ConversationRef,
    options?: { audience?: boolean; viewers?: ReadonlyArray<string> }
  ): Promise<ReadResult<{ conversation: ConversationInfo }>>;
  conversations(scope: {
    communityId: string;
    audience?: boolean;
    viewers?: ReadonlyArray<string>;
  }): Promise<ReadResult<{ conversations: Array<ConversationInfo>; groups: Array<GroupInfo> }>>;
  history(
    conversation: ConversationRef,
    query: HistoryQuery
  ): Promise<ReadResult<{ events: Array<MessageEvent>; complete: boolean }>>;
  memberInfo(member: {
    communityId: string | null;
    memberId: string;
  }): Promise<ReadResult<{ member: MemberInfo | null }>>;
  searchMessages(
    scope: { communityId: string },
    query: { text?: string; authorId?: string; after?: number; before?: number; offset?: number }
  ): Promise<ReadResult<{ total: number; hits: Array<MessageHit> }>>;
  searchMembers(
    scope: { communityId: string },
    query: { prefix: string; limit: number }
  ): Promise<ReadResult<{ members: Array<MemberHit> }>>;
  emoji(scope: { communityId: string }): Promise<ReadResult<{ emoji: Array<EmojiInfo> }>>;
  parseLinks(texts: ReadonlyArray<string>): Promise<ReadResult<{ refs: Array<MessageRef | null> }>>;
  reactors(message: MessageRef, emoji: string, limit: number): Promise<ReadResult<{ memberIds: Array<string> }>>;
  capabilities(): Capabilities;
};

const portErrorOf = (error: PortResult['error']): PortError | null =>
  error === undefined
    ? null
    : {
        code: error.code,
        retryable: error.retryable,
        retryAfterMs: null,
        ...(error.cause !== undefined ? { cause: error.cause } : {}),
      };

// A first part that fails is the whole send's status and nothing was posted. A later part that
// fails leaves the earlier ones on the platform, so the outcome is `unknown` and the posted parts
// stay in the result for the caller to find.
export function deliveryOf(parts: ReadonlyArray<PortResult>, idempotencyKey: string): Delivery {
  const first = parts[0];
  if (first === undefined) {
    const error = { code: 'no-parts', retryable: false, retryAfterMs: null };
    return { status: 'failed', ref: null, parts: [], at: null, idempotencyKey, error };
  }
  if (first.status !== 'ok') {
    const error = portErrorOf(first.error);
    return { status: first.status, ref: null, parts: [], at: null, idempotencyKey, error };
  }
  const posted: Array<MessageRef> = [];
  for (const part of parts) {
    if (part.status !== 'ok') {
      const error = portErrorOf(part.error);
      const at = first.at ?? null;
      return { status: 'unknown', ref: posted[0] ?? null, parts: posted, at, idempotencyKey, error };
    }
    const ref = part.ref;
    if (ref?.messageId !== undefined) posted.push({ ...ref, messageId: ref.messageId });
  }
  return {
    status: 'ok',
    ref: posted[0] ?? null,
    parts: posted,
    at: first.at ?? null,
    idempotencyKey,
    error: null,
  };
}
