// The inbound half of the protocol: what an interface tells the core. Eight kinds, each a plain
// serialisable object -- no platform object survives into it, every id is an opaque string the
// adapter alone knows how to build -- with `kind`, `iface` (the adapter's namespace), `at` (ms
// since the epoch), `id` (an opaque event id for dedup) and, for what happens in a conversation,
// `conversation`. A direct chat is a conversation of kind `dm`, never a separate event; a mention
// of the persona is the `addressing` of a message, never a second event. `scheduler.tick`,
// `task.completed` and `inner.wake` are the core's own (its clock, its errands and its inner-life
// scheduler): an adapter never sends them.
// Contracts only: the shapes are checked by validate.js; building them is the adapter's job.

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
/** The core's own clock. */
export const SCHEDULER_TICK = 'scheduler.tick';
/** One of the persona's errands ended. */
export const TASK_COMPLETED = 'task.completed';
/** The inner-life scheduler found something due for the persona (src/behavior/inner.js). */
export const INNER_WAKE = 'inner.wake';

/** Every inbound event kind. */
export const EVENT_KINDS = Object.freeze([MESSAGE_RECEIVED, REACTION_CHANGED, COMMAND_REQUESTED, SCHEDULER_TICK, TASK_COMPLETED, MEMBERSHIP_CHANGED, VOICE_CHANGED, INNER_WAKE]);

/** The kinds the core emits itself; every other kind comes from an interface. */
export const CORE_KINDS = Object.freeze([SCHEDULER_TICK, TASK_COMPLETED, INNER_WAKE]);

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

/**
 * Where an event happened. `guildId`: the community the conversation belongs to (none for a
 * direct chat); `name`, `topic`, `category`: what the people in it see, null when unknown.
 * `parentId`: the conversation a thread belongs to (absent or null for any other).
 * `chatType` (optional, CONVERSATION_CHAT_TYPES): a one-to-one chat, a group chat, a channel or a
 * thread; `partnerId` (optional): the other person of a one-to-one chat, null when unknown.
 * @typedef {{ id: string, kind: 'channel'|'dm'|'thread', guildId?: string|null, name?: string|null,
 *   topic?: string|null, category?: string|null, parentId?: string|null,
 *   chatType?: 'dm'|'group_dm'|'channel'|'thread', partnerId?: string|null }} Conversation
 */

/**
 * Who wrote a message: `self` is the persona's own member, `bot` another automated one.
 * @typedef {{ id: string, name: string|null, self: boolean, bot: boolean }} Author
 */

/**
 * One message, as the core reads it. `at`: when it was written. `replyToId`: the message it
 * replies to (a forward replies to nothing); `replyPingUserId`: the replied-to author when only
 * the reply notified them; `forwardedFrom`: the name of the conversation a forward came from.
 * `attachments`, `links`, `forwarded`, `stickers`, `emojis`, `reactions` keep the shapes of
 * src/discord/collect.js#normalizeMessage.
 * @typedef {{ id: string, author: Author, content: string, at: number, replyToId: string|null,
 *   replyPingUserId: string|null, forwardedFrom: string|null, attachments: object[], links: object[],
 *   forwarded: object[], stickers: object[], emojis: object[], reactions: object[] }} Message
 */

/**
 * How a message addresses others: whether it mentions the persona (`mentioned`) or replies to
 * one of her messages (`replyToSelf`, as far as the adapter knows without asking the platform
 * again), and every member and conversation it mentions. `mentionedUsers` (optional): the name
 * the message's text reads for each mentioned member (`{ id, name }`).
 * @typedef {{ mentioned: boolean, replyToSelf: boolean, mentionedUserIds: string[],
 *   mentionedUsers?: { id: string, name: string }[], mentionedConversationIds: string[] }} Addressing
 */

/**
 * Where a message came from and whether it expects an answer: the record the mind routes by,
 * the field list of a gateway's session source. `chatType`: the kind of chat; `place`: its
 * conversation id; `parent`: the conversation a thread sits in; `thread`: the thread's id when
 * the message is in one; `replyToAuthorId`: the author of the message it replies to;
 * `replyExpected`: true when it was meant for the persona, false when it was meant for someone
 * else, null when the adapter cannot tell. An adapter may send it with the event; the core reads
 * it through `originOf` (origin.js), which derives what an event does not carry.
 * @typedef {{ chatType: 'dm'|'group'|'channel'|'thread', place: string, parent: string|null,
 *   thread: string|null, replyToAuthorId: string|null, replyExpected: boolean|null }} Origin
 */

/**
 * `message.received`. An edit carries the same message id with `edit: true`; a deletion carries
 * only `message.id` with `deleted: true`; an edit the adapter could not read whole carries only
 * `message.id` with `edit: true, partial: true` (the core asks the adapter for the rest).
 * @typedef {{ kind: 'message.received', iface: string, at: number, id: string, conversation: Conversation,
 *   message: Message|{ id: string }, addressing?: Addressing, origin?: Origin, edit?: boolean, deleted?: boolean,
 *   partial?: boolean }} MessageReceived
 */

/**
 * `reaction.changed`: `emoji.name` is the emoji itself (a unicode one) or a custom emoji's name,
 * `emoji.id` a custom emoji's id. `authorId` is the author of the reacted message when the
 * adapter knows it (null or absent otherwise). `cleared` marks a removal of many at once: `'emoji'`
 * (every reaction of one emoji taken off) or `'all'` (every reaction taken off); then `added` is
 * false, `userId` may be null or absent, and with `'all'` so may `emoji`.
 * @typedef {{ kind: 'reaction.changed', iface: string, at: number, id: string, conversation: Conversation,
 *   messageId: string, emoji: { name: string|null, id?: string }|null, userId: string|null, added: boolean,
 *   authorId?: string|null, cleared?: 'emoji'|'all' }} ReactionChanged
 */

/**
 * `command.requested`: the command's `name` (`group.sub` or `sub`), its `args`, who asked, and
 * `replyRef`, the opaque token a `command.result` action answers it by.
 * @typedef {{ kind: 'command.requested', iface: string, at: number, id: string, conversation: Conversation,
 *   name: string, args: object, requester: { id: string, name: string|null, roles: string[], owner: boolean },
 *   replyRef: string }} CommandRequested
 */

/**
 * `membership.changed`: `change` says what happened to the member `userId` of the community
 * `guildId`; `member` is who they are now (absent when they left and the adapter no longer knows).
 * @typedef {{ kind: 'membership.changed', iface: string, at: number, id: string, guildId: string,
 *   userId: string, change: 'joined'|'left'|'updated', member?: { id: string, name: string|null, bot: boolean } }} MembershipChanged
 */

/**
 * `voice.changed`: `conversationId` is the voice conversation the member is in now (null: none),
 * `previousId` the one they were in (null: none); the flags are what the adapter knows.
 * @typedef {{ kind: 'voice.changed', iface: string, at: number, id: string, guildId: string, userId: string,
 *   conversationId: string|null, previousId: string|null, muted?: boolean, deafened?: boolean,
 *   streaming?: boolean }} VoiceChanged
 */

/**
 * `scheduler.tick`: the core's clock, `at` only.
 * @typedef {{ kind: 'scheduler.tick', at: number }} SchedulerTick
 */

/**
 * `task.completed`: an errand ended with `status` and its `result` (as src/errands defines them);
 * `guildId` is the community whose ledger holds the task. The core derives `id` (`taskId` and
 * `status`) when it has none, so a second delivery of the same end is the same event.
 * @typedef {{ kind: 'task.completed', at: number, id?: string, guildId?: string|null, taskId: string, status: string,
 *   result?: unknown }} TaskCompleted
 */

/**
 * `inner.wake`: the core's inner-life scheduler (src/behavior/inner.js) found something due: an
 * intention, a deadline of an errand she waits for, or her daily review. `id` is always given
 * (the wake's own, so a second listing of the same due item is the same event); `wake` is the
 * scheduler's record (`kind` one of `intention_due`, `review`, `errand_deadline`, `attend`, `feedback`, `heartbeat`).
 * @typedef {{ kind: 'inner.wake', at: number, id: string, guildId?: string|null, wake: { kind: string } }} InnerWake
 */

/**
 * @typedef {MessageReceived|ReactionChanged|CommandRequested|SchedulerTick|TaskCompleted|MembershipChanged|VoiceChanged|InnerWake} InboundEvent
 */
