// The contract between the core and one chat platform, as types: what an adapter can do, what it
// reports back, and what it declares it can handle. No platform concept appears here, so an adapter
// for any platform fits. `deliveryOf` folds the results of a split send into one `Delivery`.

import type { Content, PortResult } from './actions.ts';
import type { Chat, Message, MessageReceived } from './events.ts';

export type ChatRef = { iface: string; chatId: string };

export type MessageRef = {
  iface: string;
  chatId: string;
  messageId: string;
  accountId?: string;
};

// `cause` is the platform's own error, kept for the logs and never shown to the model.
export type PortError = { code: string; retryable: boolean; retryAfterMs: number | null; cause?: unknown };

// `cancelled`: the caller's signal ended the send before it went to the interface, so nothing was posted.
export type Delivery = {
  status: 'ok' | 'failed' | 'unknown' | 'unsupported' | 'forbidden' | 'cancelled';
  // The first part, for callers that track one message.
  ref: MessageRef | null;
  // Every platform message posted for this send.
  parts: ReadonlyArray<MessageRef>;
  at: number | null;
  idempotencyKey: string;
  error: PortError | null;
  // The files the send posted, each named by the platform's attachment id with the message that carries it, in the
  // order they were given; absent when the interface does not say.
  attachments?: ReadonlyArray<{ messageId: string; attachmentId: string }>;
  // True when the interface kept the post for a chat that is not open now: it is stored as sent and shown once the
  // chat opens (src/interface/cli-chat.ts). Absent for a post that reached its chat.
  deferred?: boolean;
};

/**
 * How an interface writes the address of a message, when its platform has one: a template for a message of a
 * root and one for a message of a private chat, each with `{root}`, `{chat}` and `{message}`.
 */
export type MessageUrlTemplate = { root: string; direct: string };

/**
 * What an interface declares for the media pick (docs/interfaces.md, "Media pick"): the forms it posts a library GIF in,
 * and for its custom emoji the actions it supports and the template that renders one (`{name}` and `{id}`). `text` goes
 * into the persona's turn as it stands. An interface with none of it never triggers the pick.
 */
export type MediaPickCapability = {
  gifForms: ReadonlyArray<'file' | 'link'>;
  emoji?: {
    actions: ReadonlyArray<'append' | 'replace'>;
    render: { still: string; animated?: string };
  };
  text?: string;
};

export type Capabilities = {
  operations: ReadonlyArray<string>;
  maxChars: number;
  maxFiles: number;
  maxFileBytes: number;
  edit?: { ownOnly: boolean; windowMs: number | null };
  history?: boolean;
  threads?: boolean;
  reactions?: boolean;
  customEmoji?: boolean;
  /** False when a mention has no form of its own: a member her words name reads as their name. Absent: it has one. */
  mentions?: boolean;
  /** False when a channel link has no form of its own: a channel her words name reads as its name. Absent: it has one. */
  channelLinks?: boolean;
  presence?: boolean;
  voiceFormats?: ReadonlyArray<string>;
  publish?: ReadonlyArray<string>;
  search?: boolean;
  /** The wire names of the reads the interface answers (READ_ACTIONS in src/protocol/actions.ts). */
  reads?: ReadonlyArray<string>;
  /** Absent or null: the platform gives a message no address. */
  messageUrl?: MessageUrlTemplate | null;
  /** True when `fetchMessages` finds a send by its idempotency key (src/interface/reconcile.ts); absent: it cannot. */
  reconcile?: boolean;
  mediaPick?: MediaPickCapability;
};

/**
 * What a send carries beside its content: the key that names the effect (a repeat under the same key posts nothing
 * new), the moment past which the interface must not start it (ms since the epoch), and a signal that cancels it.
 */
export type SendOptions = { idempotencyKey?: string; deadlineAt?: number; signal?: AbortSignal };

/** A fetch by the key of a send: the messages the adapter posted under `idempotencyKey`, beside the ids asked for. */
export type FetchOptions = { idempotencyKey?: string };

/**
 * What a read answers: `{ status: 'ok', ...body }`, or a status and an error. A read never throws and never
 * answers `unknown`: it changed nothing, so asking again is always safe.
 */
export type ReadResult<T> =
  ({ status: 'ok' } & T) | { status: 'failed' | 'unsupported' | 'forbidden'; error: PortError };

/** What the persona may do in a chat: read its history, send, attach files, react. */
export type Permissions = { read: boolean; send: boolean; attach: boolean; react: boolean };

/**
 * Who can see a chat, in the shape the audience rail compares (src/behavior/elsewhere.ts#audienceCovers):
 * `groups` are the member groups of the platform (the roles of a root), as ids. The sets of the rail are arrays on the wire.
 * `everyone`: all members of the root can view it. `groups`: the groups that can view it, each on its own.
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
 * A chat with what the core reads about it: the record of events.ts plus the interface it belongs to, what the
 * persona may do there, its owner (a member id, null when the platform has none), the time of its newest message,
 * whether it is a voice room, whether everyone in the root may view it, and, when asked for, its audience and
 * which of the named viewers can see it.
 */
export type ChatInfo = Chat & {
  iface: string;
  permissions: Permissions;
  owner: string | null;
  lastMessageAt: number | null;
  voice: boolean;
  public: boolean;
  audience?: Audience | null;
  viewers?: Record<string, boolean>;
};

/** The groups of a root: an id and the name members see. */
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

/** A custom emoji of a root with the address of its picture. */
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
    // The platform's own id of the attachment.
    id?: string;
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
  send(chat: ChatRef, content: Content, options?: SendOptions): Promise<Delivery>;
  edit(message: MessageRef, content: Content): Promise<PortResult>;
  delete(message: MessageRef): Promise<PortResult>;
  react(message: MessageRef, emoji: string): Promise<PortResult>;
  unreact(message: MessageRef, emoji: string): Promise<PortResult>;
  typing(chat: ChatRef, lease: { untilMs: number }): Promise<PortResult>;
  fetchMessages(chat: ChatRef, messageIds: ReadonlyArray<string>, options?: FetchOptions): Promise<FetchedMessages>;
  chatInfo(
    chat: ChatRef,
    options?: { audience?: boolean; viewers?: ReadonlyArray<string> }
  ): Promise<ReadResult<{ chat: ChatInfo }>>;
  chats(scope: {
    placeId: string;
    audience?: boolean;
    viewers?: ReadonlyArray<string>;
  }): Promise<ReadResult<{ chats: Array<ChatInfo>; groups: Array<GroupInfo> }>>;
  history(chat: ChatRef, query: HistoryQuery): Promise<ReadResult<{ events: Array<MessageEvent>; complete: boolean }>>;
  memberInfo(member: { placeId: string | null; accountId: string }): Promise<ReadResult<{ member: MemberInfo | null }>>;
  /** The private chat with an account, opened on the platform if need be, with no message sent. Asking twice answers the same id. */
  dmChatOf(partner: { iface: string; accountId: string }): Promise<ReadResult<{ chatId: string }>>;
  searchMessages(
    scope: { placeId: string },
    query: { text?: string; authorId?: string; after?: number; before?: number; offset?: number }
  ): Promise<ReadResult<{ total: number; hits: Array<MessageHit> }>>;
  searchMembers(
    scope: { placeId: string },
    query: { prefix: string; limit: number }
  ): Promise<ReadResult<{ members: Array<MemberHit> }>>;
  emoji(scope: { placeId: string | null }): Promise<ReadResult<{ emoji: Array<EmojiInfo> }>>;
  parseLinks(texts: ReadonlyArray<string>): Promise<ReadResult<{ refs: Array<MessageRef | null> }>>;
  reactors(message: MessageRef, emoji: string, limit: number): Promise<ReadResult<{ accountIds: Array<string> }>>;
  /** The link that adds the persona to a new root of the interface. One that has none answers `unsupported`. */
  inviteLink(scope: { iface: string }): Promise<ReadResult<{ url: string }>>;
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
