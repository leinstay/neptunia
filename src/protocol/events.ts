// The inbound half of the protocol: what an interface tells the core. Twelve kinds, each a plain
// serialisable object -- no platform object survives into it, every id is an opaque string the
// adapter alone knows how to build -- with `kind`, `iface` (the adapter's namespace), `at` (ms
// since the epoch), `id` (an opaque event id for dedup) and, for what happens in a conversation,
// `conversation`. A direct chat is a conversation of kind `dm`, never a separate event; a mention
// of the persona is the `addressing` of a message, never a second event. `scheduler.tick`,
// `errand.done` and `inner.wake` are the core's own (its clock, its errands and its inner-life
// scheduler): an adapter never sends them.
// Contracts only: the shapes are checked by validate.ts; building them is the adapter's job.

/** The message kind: a new message, an edit (`edit`), or a deletion (`deleted`). */
export const MESSAGE_RECEIVED = 'message.received';
/** A reaction put on (`added`) or taken off a message. */
export const REACTION_CHANGED = 'reaction.changed';
/** An owner command asked through the interface; answered by a `command.result` action. */
export const COMMAND_REQUESTED = 'command.requested';
/** A member joined, left or changed in a community. */
export const MEMBERSHIP_CHANGED = 'membership.changed';
/** A member's voice state changed (joined, left or moved a voice conversation, muted, ...). */
export const VOICE_CHANGED = 'voice.changed';
/** A member's presence changed: their status or what they are doing. */
export const PRESENCE_CHANGED = 'presence.changed';
/** Everyone's voice state and presence at one moment, sent to seed or replace what the core holds. */
export const PRESENCE_SNAPSHOT = 'presence.snapshot';
/** A conversation was created, updated or deleted. */
export const CONVERSATION_CHANGED = 'conversation.changed';
/** The interface lost its connection to the platform, or got it back. */
export const CONNECTION_CHANGED = 'connection.changed';
/** The core's own clock. */
export const SCHEDULER_TICK = 'scheduler.tick';
/** One of the persona's errands ended. */
export const ERRAND_DONE = 'errand.done';
/** The inner-life scheduler found something due for the persona (src/behavior/inner.ts). */
export const INNER_WAKE = 'inner.wake';

/** Every inbound event kind. */
export const EVENT_KINDS = Object.freeze([
  MESSAGE_RECEIVED,
  REACTION_CHANGED,
  COMMAND_REQUESTED,
  SCHEDULER_TICK,
  ERRAND_DONE,
  MEMBERSHIP_CHANGED,
  VOICE_CHANGED,
  INNER_WAKE,
  PRESENCE_CHANGED,
  PRESENCE_SNAPSHOT,
  CONVERSATION_CHANGED,
  CONNECTION_CHANGED,
]);

/** The kinds the core emits itself; every other kind comes from an interface. */
export const CORE_KINDS = Object.freeze([SCHEDULER_TICK, ERRAND_DONE, INNER_WAKE]);

/** Every conversation kind. */
export const CONVERSATION_KINDS = Object.freeze(['channel', 'dm', 'thread']);

/**
 * The chat types of a conversation (`conversation.chatType`): a one-to-one chat, a group chat outside a community,
 * a channel of a community, a thread.
 */
export const CONVERSATION_CHAT_TYPES = Object.freeze(['dm', 'group_dm', 'channel', 'thread']);

/** The chat types of an origin record: a direct chat, a small group, a channel of a community, a thread. */
export const CHAT_TYPES = Object.freeze(['dm', 'group', 'channel', 'thread']);

/** What happened to a member (`membership.changed`). */
export const MEMBERSHIP_CHANGES = Object.freeze(['joined', 'left', 'updated']);

/** What a member is doing on the platform (`presence.changed`). */
export const PRESENCE_STATUSES = ['online', 'idle', 'dnd', 'offline', 'unknown'] as const;

/** The kinds of activity a presence lists. */
export const ACTIVITY_KINDS = ['playing', 'streaming', 'listening', 'watching', 'competing', 'other'] as const;

/** What happened to a conversation (`conversation.changed`). */
export const CONVERSATION_CHANGES = Object.freeze(['created', 'updated', 'deleted']);

/** The states of an interface's connection (`connection.changed`). */
export const CONNECTION_STATES = Object.freeze(['lost', 'resumed']);

/**
 * Where an event happened. `rootId`: the native id of the place at the top of the conversation's tree (none for a
 * direct chat); `name`, `topic`: what the people in it see, null when unknown.
 * `parentId`, `parentKind`: the place that contains this one, of any kind and at any depth (a server, a channel); a
 * thread with no declared kind sits in a channel. A grouping of rooms in a platform's sidebar is no place and is never
 * declared. `authorityId`: the authority that issued this conversation's id, the interface's native one when absent.
 * `chatType` (optional, CONVERSATION_CHAT_TYPES): a one-to-one chat, a group chat, a channel or a
 * thread; `partnerId` (optional): the other person of a one-to-one chat, null when unknown.
 */
export type Conversation = {
  id: string;
  kind: 'channel' | 'dm' | 'thread';
  rootId?: string | null;
  name?: string | null;
  topic?: string | null;
  parentId?: string | null;
  parentKind?: string;
  authorityId?: string;
  chatType?: 'dm' | 'group_dm' | 'channel' | 'thread';
  partnerId?: string | null;
};

/** A member's picture: `hash` identifies it, `url` is where to fetch it; either is null when unknown. */
export type Avatar = { hash: string | null; url: string | null };

/**
 * A message the text of another message links to: where it is (`iface`, `conversationId`, `messageId`), `url` (the
 * address of the message on its platform, null when it has none) and `text`, the span of the text that names it as
 * written, so the core can replace exactly that span.
 */
export type MessageReference = {
  iface: string;
  conversationId: string;
  messageId: string;
  url: string | null;
  text: string;
};

/**
 * Who wrote a message: `self` is the persona's own member, `bot` another automated one.
 * `avatar` (optional): the hash and the address of their picture, each null when unknown.
 */
export type Author = { id: string; name: string | null; self: boolean; bot: boolean; avatar?: Avatar };

/**
 * One message, as the core reads it. `content`: the text as the chat shows it (mentions read as names, links to
 * embedded media cut out). `sourceText` (optional, `content` when absent): the text as written, with mentions in the
 * core's `<@id>` grammar, which edit detection and the journal's reconciliation compare. `system` (optional, false when
 * absent): the platform's own message (a member joined, a webhook post), never a person's. `at`: when it was written. `replyToId`: the message it
 * replies to (a forward replies to nothing); `replyPingAccountId`: the replied-to author when only
 * the reply notified them; `forwardedFrom`: the name of the conversation a forward came from.
 * `attachments`, `links`, `forwarded`, `stickers`, `emojis`, `reactions` keep the shapes the
 * core's media module reads (src/media/classify.ts). `messageRefs` (optional): the messages the text links to, as
 * `MessageReference`s, in the order they are written.
 */
export type Message = {
  id: string;
  author: Author;
  content: string;
  sourceText?: string;
  system?: boolean;
  at: number;
  replyToId: string | null;
  replyPingAccountId: string | null;
  forwardedFrom: string | null;
  attachments: Array<object>;
  links: Array<object>;
  forwarded: Array<object>;
  stickers: Array<object>;
  emojis: Array<object>;
  reactions: Array<object>;
  editedAt?: number | null;
  messageRefs?: Array<MessageReference>;
};

/**
 * How a message addresses others: whether it mentions the persona (`mentioned`) or replies to
 * one of her messages (`replyToSelf`, as far as the adapter knows without asking the platform
 * again), and every member and conversation it mentions. `mentionedUsers` (optional): the name
 * the message's text reads for each mentioned member (`{ id, name }`).
 */
export type Addressing = {
  mentioned: boolean;
  replyToSelf: boolean;
  mentionedAccountIds: Array<string>;
  mentionedUsers?: Array<{ id: string; name: string }>;
  mentionedConversationIds: Array<string>;
};

/**
 * Where a message came from and whether it expects an answer: the record the mind routes by,
 * the field list of a gateway's session source. `chatType`: the kind of chat; `place`: its
 * conversation id; `parent`: the conversation a thread sits in; `thread`: the thread's id when
 * the message is in one; `replyToAuthorId`: the author of the message it replies to;
 * `replyExpected`: true when it was meant for the persona, false when it was meant for someone
 * else, null when the adapter cannot tell. An adapter may send it with the event; the core reads
 * it through `originOf` (origin.ts), which derives what an event does not carry.
 */
export type Origin = {
  chatType: 'dm' | 'group' | 'channel' | 'thread';
  place: string;
  parent: string | null;
  thread: string | null;
  replyToAuthorId: string | null;
  replyExpected: boolean | null;
};

/**
 * `message.received`. An edit carries the same message id with `edit: true` and `previous`, the message as it was
 * (null when the adapter did not hold it); a deletion carries `message.id` with `deleted: true` and, when the
 * adapter still knew them, `message.at` and `message.author`; an edit the adapter could not read whole carries only
 * `message.id` with `edit: true, partial: true` (the core asks the adapter for the rest).
 */
export type MessageReceived = {
  kind: 'message.received';
  iface: string;
  at: number;
  id: string;
  conversation: Conversation;
  message: Message | { id: string; at?: number; author?: Author };
  addressing?: Addressing;
  origin?: Origin;
  edit?: boolean;
  deleted?: boolean;
  partial?: boolean;
  previous?: Message | null;
};

/**
 * `reaction.changed`: `emoji.name` is the emoji itself (a unicode one) or a custom emoji's name,
 * `emoji.id` a custom emoji's id. `authorId` is the author of the reacted message when the
 * adapter knows it (null or absent otherwise). `cleared` marks a removal of many at once: `'emoji'`
 * (every reaction of one emoji taken off) or `'all'` (every reaction taken off); then `added` is
 * false, `accountId` may be null or absent, and with `'all'` so may `emoji`.
 */
export type ReactionChanged = {
  kind: 'reaction.changed';
  iface: string;
  at: number;
  id: string;
  conversation: Conversation;
  messageId: string;
  emoji: { name: string | null; id?: string } | null;
  accountId: string | null;
  added: boolean;
  authorId?: string | null;
  cleared?: 'emoji' | 'all';
};

/**
 * `command.requested`: the command's `name` (`group.sub` or `sub`), its `args`, who asked, and
 * `replyRef`, the opaque token a `command.result` action answers it by. A command that asked a question
 * (a `command.result` with status `ask`) is answered by a second `command.requested` with the same `name`, the
 * `dialogId` of the question and the `answer` text: the answer is a field of its own, never an entry of `args`,
 * so nothing that echoes the arguments can echo it.
 */
export type CommandRequested = {
  kind: 'command.requested';
  iface: string;
  at: number;
  id: string;
  conversation: Conversation;
  name: string;
  args: object;
  requester: { id: string; name: string | null; roles: Array<string>; owner: boolean };
  replyRef: string;
  dialogId?: string;
  answer?: string;
};

/**
 * `membership.changed`: `change` says what happened to the member `accountId` of the community
 * `placeId`; `member` is who they are now (absent when they left and the adapter no longer knows).
 */
export type MembershipChanged = {
  kind: 'membership.changed';
  iface: string;
  at: number;
  id: string;
  placeId: string;
  accountId: string;
  change: 'joined' | 'left' | 'updated';
  member?: { id: string; name: string | null; bot: boolean; avatar?: Avatar };
};

/**
 * `voice.changed`: `conversationId` is the voice conversation the member is in now (null: none),
 * `previousId` the one they were in (null: none); the flags are what the adapter knows.
 * `name` (optional): the name people see for the member, null when unknown; `camera` (optional): whether their camera is on.
 */
export type VoiceChanged = {
  kind: 'voice.changed';
  iface: string;
  at: number;
  id: string;
  placeId: string;
  accountId: string;
  name?: string | null;
  conversationId: string | null;
  previousId: string | null;
  muted?: boolean;
  deafened?: boolean;
  streaming?: boolean;
  camera?: boolean;
};

/** One thing a member is doing: its `kind`, `name`, and the `details` and `state` lines the platform shows (empty when none). */
export type Activity = {
  kind: 'playing' | 'streaming' | 'listening' | 'watching' | 'competing' | 'other';
  name: string;
  details: string;
  state: string;
};

/** A member's presence: `name` is what people see for them, null when unknown. */
export type PresenceState = {
  accountId: string;
  name: string | null;
  status: 'online' | 'idle' | 'dnd' | 'offline' | 'unknown';
  activities: Array<Activity>;
};

/** A member's voice state as a snapshot lists it: the fields of `voice.changed` without the envelope. */
export type VoiceState = Omit<VoiceChanged, 'kind' | 'iface' | 'at' | 'id'>;

/** `presence.changed`: one member's presence now. */
export type PresenceChanged = { kind: 'presence.changed'; iface: string; at: number; id: string } & PresenceState;

/** `presence.snapshot`: every voice state and presence the interface knows at `at`. It replaces what the core holds. */
export type PresenceSnapshot = {
  kind: 'presence.snapshot';
  iface: string;
  at: number;
  id: string;
  voice: Array<VoiceState>;
  presence: Array<PresenceState>;
};

/** `conversation.changed`: `conversation` as it is now (as it was, for a deletion). */
export type ConversationChanged = {
  kind: 'conversation.changed';
  iface: string;
  at: number;
  id: string;
  conversation: Conversation;
  change: 'created' | 'updated' | 'deleted';
};

/** `connection.changed`: the interface's link to its platform dropped (`lost`) or came back (`resumed`). */
export type ConnectionChanged = {
  kind: 'connection.changed';
  iface: string;
  at: number;
  id: string;
  state: 'lost' | 'resumed';
};

/** `scheduler.tick`: the core's clock, `at` only. */
export type SchedulerTick = { kind: 'scheduler.tick'; at: number };

/**
 * `errand.done`: an errand ended with `status` and its `result` (as src/errands defines them). The core derives `id` (`errandId` and
 * `status`) when it has none, so a second delivery of the same end is the same event.
 */
export type ErrandDone = {
  kind: 'errand.done';
  at: number;
  id?: string;
  errandId: string;
  status: string;
  result?: unknown;
};

/**
 * `inner.wake`: the core's inner-life scheduler (src/behavior/inner.ts) found something due: an
 * intention, a deadline of an errand she waits for, or her daily review. `id` is always given
 * (the wake's own, so a second listing of the same due item is the same event); `wake` is the
 * scheduler's record (`kind` one of `intention_due`, `review`, `errand_deadline`, `attend`, `feedback`, `heartbeat`).
 */
export type InnerWake = {
  kind: 'inner.wake';
  at: number;
  id: string;
  wake: { kind: string };
};

export type InboundEvent =
  | MessageReceived
  | ReactionChanged
  | CommandRequested
  | SchedulerTick
  | ErrandDone
  | MembershipChanged
  | VoiceChanged
  | InnerWake
  | PresenceChanged
  | PresenceSnapshot
  | ConversationChanged
  | ConnectionChanged;
