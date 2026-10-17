# Interfaces: the protocol between the core and an adapter

The engine is split into a **core** (the persona: memory, decisions, turns) and **interfaces** (the chat platforms she lives on). An interface adapter turns what happens on its platform into **inbound events** for the core, and carries out the **actions** the core asks for, answering each with a **result**. The contract between the two lives in `packages/protocol/` (`@neptunia/protocol`): plain objects, no build step, no dependencies, and no platform type on either side. This page is for anyone writing an adapter.

| File | Holds |
|---|---|
| `packages/protocol/events.js` | the inbound event kinds and their shapes |
| `packages/protocol/actions.js` | the action names, the result shape and the port helpers (`ok`, `notOk`, `mentionsOf`, the refusals, `declaredHooks`) |
| `packages/protocol/validate.js` | `validateEvent(event)` and `validateAction(action)` |

The engine imports the package through `src/protocol.js` (one place to switch to the bare `@neptunia/protocol` specifier once the package is an npm workspace); `src/interface/port.js` re-exports the outbound half. The Discord adapter is `src/interface/discord.js` (actions) with the event builders in `src/discord/collect.js` (`toEvent`, `reactionEvent`); the in-memory adapter for tests is `src/interface/fake.js`.

## Rules

- **Ids are opaque strings.** A conversation, a message, a member, an emoji or an event id is a string only its adapter knows how to build or read. The core compares ids, it never parses them. References in actions are namespaced by the adapter's `iface` (`discord`, `fake`).
- **No platform objects.** An event or an action is a plain serialisable object. While the Discord adapter still lives inside the engine, its events also carry `raw` (and `rawPrevious` for an edit): its own handles to the discord.js objects, read only on the Discord side, never by `src/behavior/`, ignored by validation, and removed once the adapter is its own package.
- **A mention is addressing.** A message that mentions the persona or replies to her is one `message.received` with its `addressing` saying so, never a second event.
- **A direct chat is a conversation kind.** A private message is a `message.received` in a conversation of kind `dm`, not a separate event.
- **Validation never throws.** Both checks answer `{ ok: true }` or `{ ok: false, reason }`, where `reason` names the field and the problem (`message.at:type`, `kind:unknown`, `conversation.id:required`). The core drops an invalid inbound event with one warn line, `interface: invalid event`, carrying the kind and the reason and never the content. The fake adapter refuses an invalid action as `failed` with the code `invalid-action`.
- **Shapes only.** Validation checks kinds, required keys, string ids, finite numbers and flags. Whether a reference belongs to this interface, whether content fits its limits, and who may run a command stay with the adapter and the core.

## Inbound events

Every event has `kind`, `iface` (the adapter's namespace), `at` (milliseconds since the epoch), `id` (an opaque event id, for dedup) and, for what happens in a conversation, `conversation`:

| Field | Meaning |
|---|---|
| `id` | the conversation's id |
| `kind` | `channel`, `dm` or `thread` |
| `guildId` | the community it belongs to; null or absent for a direct chat |
| `name`, `topic`, `category` | what the people in it see; null or absent when unknown |

The five kinds:

| Kind | Sent by | Payload |
|---|---|---|
| `message.received` | the adapter | `message`, `addressing`; `edit: true` for an edit (the same message id), `deleted: true` for a deletion (only `message.id`), `edit: true, partial: true` for an edit the adapter could not read whole (only `message.id`; the core asks the adapter for the rest) |
| `reaction.changed` | the adapter | `messageId`, `emoji` (`{ name, id? }`: `name` is a unicode emoji itself or a custom emoji's name, `id` a custom emoji's id; one of them is required), `userId`, `added` (true when put on, false when taken off) |
| `command.requested` | the adapter | `name` (`group.sub` or `sub`), `args` (an object), `requester` (`{ id, name, roles, owner }`: `name` may be null, `roles` are role ids, `owner` whether the configured owners name them, for information: the core checks the rights itself), `replyRef` (an opaque token; the answer comes back as a `command.result` action carrying it) |
| `scheduler.tick` | the core | `at` only: the core's own clock. An adapter never sends it; `iface`, `id` and `conversation` are not required |
| `task.completed` | the core | `taskId`, `status`, `result` (as `src/errands` defines them); `iface`, `id` and `conversation` are not required |

`message`:

| Field | Meaning |
|---|---|
| `id` | the message's id |
| `author` | `{ id, name, self, bot }`: `name` is the author's display name or null; `self` is true for the persona's own messages; `bot` for another automated account |
| `content` | the text as people read it (mentions as names) |
| `at` | when it was written |
| `replyToId` | the message it replies to, or null (a forward replies to nothing) |
| `replyPingUserId` | the replied-to author when only the reply notified them, or null |
| `forwardedFrom` | the name of the conversation a forward came from, or null |
| `attachments`, `links`, `forwarded`, `stickers`, `emojis`, `reactions` | arrays, in the shapes `src/discord/collect.js#normalizeMessage` gives them |

`addressing`:

| Field | Meaning |
|---|---|
| `mentioned` | the persona is among the mentioned members |
| `replyToSelf` | the message replies to one of the persona's messages, as far as the adapter knows without asking its platform again (the core may still check) |
| `mentionedUserIds` | every member the message mentions |
| `mentionedConversationIds` | every conversation the message mentions |

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

`content` is `{ text?, attachments?, replyTo?, mentions? }`: `attachments` are `{ name, data?, url?, contentType? }`, `replyTo` a message reference of the same interface, and `mentions` `{ users, repliedUser }`, the only members the message may notify. Absent mentions notify nobody. A null part counts as absent.

## Results

Every action is answered by a result; an adapter never throws.

| Field | Meaning |
|---|---|
| `status` | `ok`; `failed` (known not to have taken effect); `unknown` (may have taken effect: never retried blindly); `unsupported` (this interface cannot do it); `forbidden` (it may not, for example someone else's message) |
| `ref` | the message as it now exists (a send's new message), when there is one |
| `at` | when the interface stamped it, when it says |
| `error` | `{ code, retryable }` when not `ok`: a kebab-case code (`empty-content`, `text-too-long`, `invalid-attachment`, `attachment-too-large`, `foreign-reference`, `invalid-reference`, `not-own-message`, `unknown-message`, `invalid-action`, `timeout`) or `http-<status>`, and whether trying again later could succeed. An adapter may add `cause` for its logs; it never reaches the model |

An adapter edits and deletes only the persona's own messages (`forbidden` otherwise) and refuses a reference of another interface as `foreign-reference`.

## Not yet

The Discord adapter still lives inside the engine (`src/discord/`, `src/interface/discord.js`) and moves to its own package in a later stage. Until then the message pipeline reads the normalised message rebuilt from the event, owner commands are answered by a direct reply rather than a `command.result` action, and the core's `scheduler.tick` and `task.completed` are still direct calls rather than events through one dispatcher.
