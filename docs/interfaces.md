# Interfaces: the protocol between the core and an adapter

The engine has two sides: the core (the persona, its memory, its decisions about when and how to speak) and the interfaces (the chat platforms it lives on). An interface adapter translates what happens on its platform into inbound events for the core, and carries out the actions the core sends back. Each action gets a result. The contract between the two sides lives in `packages/protocol/` (`@neptunia/protocol`): plain objects, no build step, no dependencies, and no platform type on either side.

| File | What it holds |
|---|---|
| `packages/protocol/events.js` | the inbound event kinds and their shapes |
| `packages/protocol/origin.js` | the origin record of a message event (`originOf`): where it came from and whether it expects an answer |
| `packages/protocol/envelope.js` | the wire envelope (`{ v, id, type, replyTo, body }`) for when the interface is a separate process |
| `packages/protocol/actions.js` | the action names, the result shape, and the port helpers (`ok`, `notOk`, `mentionsOf`, the refusals, `declaredHooks`) |
| `packages/protocol/validate.js` | `validateEvent(event)` and `validateAction(action)` |

The engine imports the package through `src/protocol.js` (one place to switch to the bare `@neptunia/protocol` specifier once the package is an npm workspace); `src/interface/port.js` re-exports the outbound half. `src/interface/door.js` is the event door: the one entry through which every inbound event reaches the core. `src/interface/typing.js` holds the typing lease. The Discord adapter is the package `interfaces/discord/` (`@neptunia/interface-discord`, reached through `src/interface/discord.js`): `port.js` (actions) with the event builders in `collect.js` (`toEvent`, `reactionEvent`); the in-memory adapter for tests is `src/interface/fake.js`.

The core reaches Discord only through what the composition root gives it. Besides the port, `createDiscordInterface({ client })` returns a frozen capabilities object: the functions the core still asks Discord with, by name (whether the persona may read, send, attach or react in a channel, a channel's history, another channel to show, a search of the server's messages and members, a message as a protocol event and back). `src/index.js` builds it once and passes it as `discord` to every module that needs it: to a factory through its options, to an operation through its environment (`env.discord`), to a pure helper as a parameter. No other file under `src/` imports the Discord interface, so a test or a tool hands in the same functions or fakes of them.

## Rules

- Ids are opaque strings. A conversation, a message, a member, an emoji or an event id is a string only the adapter that built it knows how to read. The core compares ids but never parses them. References in actions are namespaced by the adapter's `iface` (`discord`, `fake`).
- No platform objects cross the boundary. An event or an action is a plain serialisable object. The Discord adapter, while it still lives inside the engine, also carries `raw` (and `rawPrevious` for an edit) on its events: handles to the discord.js objects, read only on the Discord side, never by `src/behavior/`, ignored by validation, and removed once the adapter moves to its own package.
- A mention is addressing. A message that mentions the persona or replies to her is one `message.received` whose `addressing` says so, not a second event.
- A direct chat is a conversation kind. A private message is a `message.received` in a conversation of kind `dm`, not a separate event kind.
- Validation never throws. Both `validateEvent` and `validateAction` return `{ ok: true }` or `{ ok: false, reason }`, where `reason` names the field and the problem (`message.at:type`, `kind:unknown`, `conversation.id:required`). The core drops an invalid inbound event with one warn line, `interface: invalid event`, carrying the kind and the reason but never the content. The fake adapter refuses an invalid action as `failed` with the code `invalid-action`.
- Validation checks shapes only. It checks kinds, required keys, string ids, finite numbers and flags. Whether a reference belongs to this interface, whether content fits its limits, and who may run a command stay with the adapter and the core.

## Inbound events

Every event has `kind`, `iface` (the adapter's namespace), `at` (milliseconds since the epoch), `id` (an opaque event id, for dedup) and, for anything that happens in a conversation, a `conversation` object:

| Field | What it holds |
|---|---|
| `id` | the conversation's id |
| `kind` | `channel`, `dm` or `thread` |
| `guildId` | the community it belongs to; null or absent for a direct chat |
| `name`, `topic`, `category` | what the people in it see; null or absent when unknown |
| `parentId` | the conversation a thread belongs to; absent or null for any other kind |

There are eight event kinds:

| Kind | Sent by | Payload |
|---|---|---|
| `message.received` | the adapter | `message`, `addressing`; `edit: true` for an edit (the same message id), `deleted: true` for a deletion (only `message.id`), `edit: true, partial: true` for an edit the adapter could not read whole (only `message.id`; the core asks the adapter for the rest) |
| `reaction.changed` | the adapter | `messageId`, `emoji` (`{ name, id? }`: `name` is a unicode emoji itself or a custom emoji's name, `id` a custom emoji's id; one of them is required), `userId`, `added` (true when put on, false when taken off) |
| `command.requested` | the adapter | `name` (`group.sub` or `sub`), `args` (an object), `requester` (`{ id, name, roles, owner }`: `name` may be null, `roles` are role ids, `owner` whether the configured owners name them, for information: the core checks the rights itself), `replyRef` (an opaque token; the answer comes back as a `command.result` action carrying it) |
| `membership.changed` | the adapter | `guildId`, `userId`, `change` (`joined`, `left` or `updated`), optional `member` (`{ id, name, bot }`: absent when the member left and the adapter no longer knows who they are). No adapter sends this kind yet: member updates still go straight to their stores |
| `voice.changed` | the adapter | `guildId`, `userId`, `conversationId` (the voice conversation the member is in now, null when none), `previousId` (the one they were in, null when none), optional flags `muted`, `deafened`, `streaming`. No adapter sends this kind yet: voice updates still go straight to their stores |
| `scheduler.tick` | the core | `at` only: the core's own clock. An adapter never sends this kind; `iface`, `id` and `conversation` are not required |
| `task.completed` | the core | `taskId`, `status`, `result` (as `src/errands` defines them); `iface`, `id` and `conversation` are not required |
| `inner.wake` | the core | `id` (always given: the wake's own), `guildId`, `wake` (the inner-life scheduler's record, `kind` one of `intention_due`, `review`, `errand_deadline`, `attend`, `feedback`, `heartbeat`; [Inner life](inner-life.md)); `iface` and `conversation` are not required |

`message`:

| Field | What it holds |
|---|---|
| `id` | the message's id |
| `author` | `{ id, name, self, bot }`: `name` is the author's display name or null; `self` is true for the persona's own messages; `bot` for another automated account |
| `content` | the text as people read it (mentions written as names) |
| `at` | when it was written |
| `replyToId` | the message it replies to, or null (a forward replies to nothing) |
| `replyPingUserId` | the replied-to author when only the reply notified them, or null |
| `forwardedFrom` | the name of the conversation a forward came from, or null |
| `attachments`, `links`, `forwarded`, `stickers`, `emojis`, `reactions` | arrays, in the shapes `interfaces/discord/collect.js#normalizeMessage` gives them |

`addressing`:

| Field | What it holds |
|---|---|
| `mentioned` | the persona is among the mentioned members |
| `replyToSelf` | the message replies to one of the persona's messages, as far as the adapter knows without asking its platform again (the core may still check) |
| `mentionedUserIds` | every member the message mentions |
| `mentionedConversationIds` | every conversation the message mentions |

A `message.received` event may carry an optional `origin` record. The adapter can send it with the event; when it does not, `originOf` (origin.js) derives one from the event's own fields.

| Field | What it holds |
|---|---|
| `chatType` | the kind of chat: `dm`, `group`, `channel` or `thread` |
| `place` | the conversation id |
| `parent` | the conversation a thread sits in, or null |
| `thread` | the thread's id when the message is in one, or null |
| `replyToAuthorId` | the author of the message it replies to, or null |
| `replyExpected` | true when the message was meant for the persona, false when it was meant for someone else, null when the adapter cannot tell. Derived from addressing and conversation kind when the adapter sends none |

## The event door

Every inbound event enters the core through one door (`src/interface/door.js`). The door validates the event at the boundary (`validateEvent`), checks its id against the ids it has already handled, and hands the event to the handler registered for its kind. An id the door has seen is answered `duplicate` and its handler does not run again. An id whose handler threw is not remembered (the answer is `failed`), so a redelivery from the sender gets another try. The seen ids are kept in memory (the newest 10,000 by default); a restart forgets them, and the interface resumes from what it last acknowledged.

The core's own events carry no id. The door derives one from the fields that make the event that event: an errand's end (`task.completed`) is identified by its task id and status, so a second delivery of the same end is the same event; a scheduler tick is identified by its time.

What enters through the door today: a new message, an edit and a deletion (`message.received`), a reaction put on (`reaction.changed`, `added: true`), an errand's end (`task.completed`), and an inner-life wake (`inner.wake`). An edit's event id includes the time the adapter received it, because Discord re-sends an edited message with the same edit stamp when it attaches an embed, and the door must treat that as a new event.

The wire envelope wraps these events for when the interface runs as a separate process (not yet the case). Its shape is `{ v, id, type, replyTo, body }`: `v` is the envelope version (1), `id` an opaque string unique to the sender (an event's envelope carries the event's own id, so a redelivery is the same envelope), `type` one of six values, `replyTo` the id of the envelope this one answers (null for an unsolicited message), and `body` the payload for the type.

| Type | Body | Direction |
|---|---|---|
| `hello` | `{ iface, capabilities?, resume? }`: who is speaking, what it offers | interface to core |
| `event` | an inbound event (events.js) | interface to core |
| `ack` | `{ status, reason? }`: whether the event was taken. Statuses: `ok`, `duplicate`, `invalid`, `unhandled`, `failed` | core to interface |
| `action` | an outbound action (actions.js) | core to interface |
| `action_result` | a port result | interface to core |
| `ping` | `{ at? }`: liveness check, answered by an ack | either direction |

`ack` and `action_result` must name what they answer in `replyTo`. No live path uses the envelope yet: while the adapter runs in the same process, the same event objects pass the door directly.

The fake adapter's `replayFixture(fixture, door)` replays a recorded list of inbound events through the door in order, the way a live interface would deliver them, so tests can drive the persona's inbound path with a fixture file.

## Actions

Every action is a plain object with an `action` name. The first six are the port's capabilities, the names an adapter lists in `capabilities().operations`:

| Action | Fields |
|---|---|
| `message.send` | `conversation` (`{ iface, conversationId }`), `content` |
| `message.edit` | `message` (`{ iface, conversationId, messageId }`), `content` |
| `message.delete` | `message` |
| `message.react.add` | `message`, `emoji` (a string) |
| `message.react.remove` | `message`, `emoji` |
| `conversation.typing` | `conversation` |
| `command.result` | `replyRef` (from `command.requested`), `text`, optional `files`, optional `ephemeral` (only the requester sees it) |

The preparing indicator (`conversation.typing`) is held as a lease (`src/interface/typing.js`): the core starts it before a turn, the lease refreshes the indicator on its own until the turn stops it, and it lapses by itself after 5 minutes (`TYPING_LEASE_MS`) so a turn that hangs or a path that forgets cannot leave the persona "typing" forever.

`content` is `{ text?, attachments?, replyTo?, mentions? }`: `attachments` are `{ name, data?, url?, contentType? }`, `replyTo` a message reference of the same interface, and `mentions` `{ users, repliedUser }`, the members the message may notify. When mentions are absent, nobody is notified. A null part counts as absent.

## Results

Every action gets a result; an adapter never throws.

| Field | What it holds |
|---|---|
| `status` | `ok`; `failed` (the action is known not to have taken effect); `unknown` (the action may have taken effect, so it must not be retried blindly); `unsupported` (this interface cannot perform the action); `forbidden` (this interface may not, for example when asked to delete someone else's message) |
| `ref` | the message as it now exists (for a send, the new message), when there is one |
| `at` | when the interface stamped the result, when it says |
| `error` | `{ code, retryable }` when the status is not `ok`: `code` is a kebab-case string (`empty-content`, `text-too-long`, `invalid-attachment`, `attachment-too-large`, `foreign-reference`, `invalid-reference`, `not-own-message`, `unknown-message`, `invalid-action`, `timeout`) or `http-<status>`, and `retryable` says whether trying again later could succeed. An adapter may add `cause` for its own logs; it never reaches the model |

An adapter edits and deletes only the persona's own messages (returning `forbidden` otherwise) and refuses a reference of another interface as `foreign-reference`.

## Not yet

The Discord adapter is a package of its own (`interfaces/discord/`) but still runs inside the engine's process, and moves out of it in a later stage. Until then the message pipeline reads the discord.js message (`raw`) for history and sends, and owner commands are answered by a direct reply rather than a `command.result` action. `scheduler.tick` is still a direct call, not an event through the door (the TODO at `src/index.js:714`).

Several gateway events still bypass the door: reaction removals (one, all, one emoji), voice state updates, presence updates and member updates go straight to their stores.
