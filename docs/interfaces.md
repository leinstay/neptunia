# Interfaces

The engine talks to people through an interface adapter. The adapter translates between a chat platform and the engine's own protocol: plain serialisable objects with opaque string ids. The engine never imports a platform library. Today one adapter exists (Discord). A second one, the fake adapter, stands in for tests.

The protocol lives in `src/protocol/`. The port contract lives in `src/interface/port.js` (which re-exports the outbound half of the protocol). The event door, the single entry for all inbound events, lives in `src/interface/door.js`.

## The protocol

Two halves: inbound events (what an adapter tells the engine) and outbound actions (what the engine asks the adapter to do).

### Inbound events

An adapter sends events as plain objects. Every event from an adapter carries `kind`, `iface` (the adapter's namespace, e.g. `discord`), `at` (ms since the epoch), `id` (an opaque string for deduplication) and, when the event happens in a conversation, a `conversation` record.

A conversation has:

| Field | What |
|---|---|
| `id` | The conversation's opaque id |
| `kind` | `channel`, `dm` or `thread` |
| `chatType` | `dm`, `group_dm`, `channel` or `thread` (optional) |
| `guildId` | The community it belongs to (null or absent for a direct chat) |
| `name`, `topic`, `category` | What the people in it see (null when unknown) |
| `parentId` | The conversation a thread belongs to (absent or null otherwise) |
| `partnerId` | The other person of a one-to-one chat (optional) |

The twelve event kinds:

| Kind | Source | What happens |
|---|---|---|
| `message.received` | adapter | A new message, an edit (`edit: true`), or a deletion (`deleted: true`). Carries the message, its author, the addressing (who was mentioned, whether the persona was replied to) and an optional origin record. A partial edit (`edit: true, partial: true`) carries only the message id; the core asks the adapter for the rest. |
| `reaction.changed` | adapter | A reaction put on or taken off a message. Carries the emoji, the member who reacted, and `added` (true for put on, false for taken off). A clear (`cleared: 'emoji'` or `'all'`) removes many at once. |
| `command.requested` | adapter | An owner command from the chat surface. Carries the command `name`, its `args`, the `requester` and a `replyRef` token the core uses to send the answer back. |
| `membership.changed` | adapter | A member joined, left or was updated in a community. |
| `voice.changed` | adapter | A member's voice state changed (joined, left, moved, muted, deafened, streaming, camera). Carries the member's `name` when the adapter knows it. |
| `presence.changed` | adapter | A member's presence changed. Carries `userId`, `name` (null when unknown), a `status` (`online`, `idle`, `dnd`, `offline` or `unknown`) and the `activities` list, each with a `kind` (`playing`, `streaming`, `listening`, `watching`, `competing` or `other`), a `name`, `details` and `state`. |
| `presence.snapshot` | adapter | Every voice state and presence the adapter knows at one moment, as `voice` (the fields of `voice.changed` without the envelope) and `presence` (the fields of `presence.changed` without the envelope). |
| `conversation.changed` | adapter | A conversation was created, updated or deleted. Carries the `conversation` and a `change` of `created`, `updated` or `deleted`. |
| `connection.changed` | adapter | The adapter lost its link to the platform (`state: 'lost'`) or got it back (`'resumed'`). |
| `scheduler.tick` | core | The engine's own clock tick (`at` only). |
| `task.completed` | core | One of the persona's errands ended, with a `taskId`, `status` and `result`. |
| `inner.wake` | core | The inner-life scheduler found something due (an intention, a review, a heartbeat, an errand deadline). See [inner life](inner-life.md). |

The last three are the core's own events. An adapter never sends them. They carry no `iface`, no `id` and no `conversation`.

A message looks like this:

| Field | What |
|---|---|
| `id` | The message's id |
| `author` | `{ id, name, self, bot }` and an optional `avatar`. `self` is true for the persona's own messages; `bot` for another automated account. `avatar` is `{ hash, url }`, each a string or null; `membership.changed` carries the same record on its `member`. |
| `content` | The text as people read it (mentions written as names) |
| `at` | When it was written (ms since epoch) |
| `replyToId` | The message it replies to, or null |
| `replyPingUserId` | The replied-to author when only the reply notified them, or null |
| `forwardedFrom` | The name of the conversation a forward came from, or null |
| `attachments`, `links`, `forwarded`, `stickers`, `emojis`, `reactions` | Arrays of the items on the message |

The addressing record:

| Field | What |
|---|---|
| `mentioned` | The persona is among the mentioned members |
| `replyToSelf` | The message replies to one of the persona's messages (as far as the adapter knows without asking again) |
| `mentionedUserIds` | Every member the message mentions |
| `mentionedConversationIds` | Every conversation the message mentions |

A `message.received` event may carry an `origin` record. When the adapter sends none, `originOf` (origin.js) derives one from the event's fields.

| Field | What |
|---|---|
| `chatType` | `dm`, `group`, `channel` or `thread` |
| `place` | The conversation id |
| `parent` | The conversation a thread sits in, or null |
| `thread` | The thread's id when the message is in one, or null |
| `replyToAuthorId` | The author of the replied-to message, or null |
| `replyExpected` | True when the message was meant for the persona, false when it was meant for someone else, null when the adapter cannot tell |

### Outbound actions

Every effect the persona has in a conversation is one named action. The first six are the port's capabilities:

| Action | Target | Payload |
|---|---|---|
| `message.send` | `conversation` | `content` |
| `message.edit` | `message` | `content` |
| `message.delete` | `message` | (none) |
| `message.react.add` | `message` | `emoji` (a string) |
| `message.react.remove` | `message` | `emoji` |
| `conversation.typing` | `conversation` | (none) |
| `command.result` | (none) | `replyRef`, `text`, optional `files`, optional `ephemeral` |

A `conversation` reference is `{ iface, conversationId }`. A `message` reference is `{ iface, conversationId, messageId }`, with an optional `memberId` for the author.

`content` is `{ text?, attachments?, replyTo?, mentions? }`. Attachments are `{ name, data?, url?, contentType? }` (bytes or a URL). `replyTo` is a message reference of the same interface. `mentions` is `{ users, repliedUser }`, the members the message may notify. When mentions are absent, nobody is notified.

An adapter also exposes `fetchMessages(conversation, messageIds)`, which reads messages by id (their text and attachments, or `missing` for a gone message). This is a read, not a capability.

### Results

Every action returns a result. An adapter never throws.

| Status | Meaning |
|---|---|
| `ok` | The action succeeded. `ref` carries the message as it now exists; `at` carries the timestamp. |
| `failed` | The action did not take effect, and the adapter knows it (e.g. rate limit, invalid target). May carry a `retryable` flag. |
| `unknown` | The action may have taken effect (e.g. a timeout after the request left the process). The caller never retries it blindly. |
| `unsupported` | This adapter cannot perform the action (the capability is not offered). |
| `forbidden` | The adapter may not (e.g. editing someone else's message). |

When the status is not `ok`, the result carries `error: { code, retryable }`. The code is a kebab-case string (`empty-content`, `text-too-long`, `not-own-message`, `timeout`, etc.) or `http-<status>`. An adapter may add `cause` for its own logs; it never reaches the model.

An adapter edits and deletes only the persona's own messages (returning `forbidden` otherwise) and refuses a reference of another interface as `foreign-reference`.

### Capabilities

An adapter declares what it can do and its limits:

```js
capabilities() → {
  operations: Set<string>,  // the action names it offers
  limits: { maxTextLength, maxAttachments, maxAttachmentBytes }
}
```

A call to an action the adapter does not offer returns `unsupported` without contacting the platform.

### Validation

Both `validateEvent` and `validateAction` return `{ ok: true }` or `{ ok: false, reason }`. The `reason` names the field and the problem (`message.at:type`, `kind:unknown`, `conversation.id:required`). They never throw, whatever they are given.

Validation checks shapes only: known kinds, required keys, string ids, finite numbers, boolean flags. Whether a reference belongs to this interface, whether content fits its limits, and who may run a command stay with the adapter and the core.

## The event door

All inbound events enter the core through one door (`src/interface/door.js`). The door validates an event with `validateEvent`, checks its id against those already handled, and hands it to the handler registered for its kind.

- An id the door has seen returns `duplicate`. The handler does not run again.
- An id whose handler threw returns `failed`. The id is not remembered, so a redelivery gets another try.
- A malformed event returns `invalid` with one log line (kind and reason, never content).
- An event whose kind has no handler returns `unhandled`.

The door keeps the newest 10,000 ids in memory. A restart forgets them; the interface resumes from what it last acknowledged.

The core's own events (`scheduler.tick`, `task.completed`, `inner.wake`) carry no id. The door derives one: an errand's end by its task id and status, a tick by its time. A second delivery of the same end is the same event.

The door also accepts the wire envelope form (`{ v, id, type, replyTo, body }`), designed for the future process boundary between the core and its adapters. Envelope types: `hello`, `event`, `ack`, `action`, `action_result`, `ping`. Today everything runs in one process, so events go through the door as plain objects.

An envelope travels as one line of JSON ending in a newline. `encodeEnvelope` and `decodeEnvelope` (`src/protocol/wire.ts`) write a `Uint8Array` as `{ "$bytes": base64 }` and read it back as a `Buffer`. A `Transport` sends envelopes, reports incoming ones and reports its close with a reason. `createLoopback` gives two connected ends in one process for tests, with every envelope passing the codec. `connectSocket` is the client of a Unix socket and `listenSocket` (`src/interface/socket.ts`) is the server: it creates its folder at mode `0700`, sets the socket to `0600`, removes a stale file before listening and removes the file on close. A line longer than `maxFrameBytes` closes the link with the reason `frame-too-large`. A line that is not a valid envelope is skipped and the link stays open. Nothing listens yet.

### The typing lease

The typing indicator is held as a lease (`src/interface/typing.js`). The turn starts it; the lease refreshes the platform's indicator on a timer until the turn stops it. If the turn hangs or a code path forgets, the lease expires on its own after 5 minutes (`TYPING_LEASE_MS`).

## Conversations and memory scope

A conversation is a direct message (`dm`), a group chat (`group_dm`), a channel of a community, or a thread. This distinction drives memory scope.

Observations from a community channel are scoped to the community (`group`). Observations from a DM are scoped to that DM conversation (tied to the partner's person when the link is verified). A DM's content never appears in a group conversation, and two unrelated DMs never see each other's content. See [memory](memory.md) for the full scope model.

## The Discord adapter

The Discord adapter lives in `interfaces/discord/` as the npm workspace package `@neptunia/interface-discord`. It depends on discord.js 14 and is the only place in the project that imports it. The engine reaches it through `src/interface/discord.js`.

### What it maps

- A Discord channel, DM or thread becomes a `conversation` (id = the channel id, `iface = 'discord'`).
- A discord.js `messageCreate` becomes a `message.received` event through `collect.js#toEvent`. An `messageUpdate` becomes an edit event, a `messageDelete` a deletion event.
- Reactions become `reaction.changed` events.
- Slash command interactions become `command.requested` events.

Besides the port, `createDiscordInterface` returns a frozen capabilities object: the functions the core calls by name for everything it still asks Discord. These include:

- Permission checks: whether the bot can read, send, attach or react in a channel.
- History: fetching the last N messages of a channel, a window around a message, reply parents, neighbour channels.
- Pulling: fetching another channel's recent messages for the `<channel_view>` prompt block.
- Searching: guild message search and member search for recall.
- Reactors: who reacted to the persona's messages (in-process, never persisted).
- Around: voice and presence state of members, a live snapshot for the `<people_now>` prompt block (never persisted, gone at restart).
- Emoji: the server's custom emoji index.
- Audience: warming the member cache for the audience rail.
- Commands: the slash command tree, registration and interaction handling.

The core imports none of these directly. `src/index.js` builds them once and passes them as `discord` to every module that needs them. A test or a tool hands in plain fakes of the same shape.

### Gateway intents

The client requests these gateway intents:

| Intent | Privileged | Why |
|---|---|---|
| Guilds | no | Channel and guild structure |
| GuildMessages | no | Messages in guild channels |
| MessageContent | no | The text of messages |
| DirectMessages | no | DM conversations |
| GuildExpressions | no | Custom emoji |
| GuildVoiceStates | no | Voice channel presence for the `<people_now>` block |
| GuildMessageReactions | no | Reaction events for the reactor store |
| GuildPresences | yes | Online/idle/dnd status. Off by default (`discord.intents.presences`). |
| GuildMembers | yes | Member join/leave/update events. Off by default (`discord.intents.members`). |

The two privileged intents are controlled by `discord.intents.presences` (default `false`) and `discord.intents.members` (default `false`). Turn them on when the bot is approved for them in the Discord Developer Portal.

### Limits and error mapping

Discord allows 2000 characters per message, 10 files per message and 10 MiB per file (on a server without boosts). The adapter declares these as its `limits`.

Discord errors map to result statuses:

- HTTP 429 (rate limit): `failed`, retryable.
- HTTP 403: `forbidden`.
- Other 4xx: `failed` with an `http-<status>` code.
- 5xx, timeout or network error after the request may have left: `unknown`.
- A lookup failure before the request is sent: always `failed`.

### Mentions

Nobody is notified by default. A message notifies exactly the members named in its `mentions.users`, and the replied-to author when `mentions.repliedUser` is true. The adapter translates this to Discord's `allowedMentions` with `parse: []`.

### Guild resolution

One instance serves exactly one Discord server. The guild is resolved from `bot.guildId` in the config. When the config names no guild and the bot is in exactly one, that one is used. When it is in several or none, the start fails with a message.

## The fake adapter

`src/interface/fake.js` is an in-memory adapter for tests. It keeps conversations and messages in memory, records every call in order (`calls`), and lets a test queue results for any operation (`failNext`). It validates every outbound action through `validateAction`, so a test driving the persona through the fake also proves she only asks for well-formed actions.

`replayFixture(fixture, door)` replays a recorded fixture of inbound events through the event door in order, the way a live adapter would deliver them. A `redeliver: n` field on an event sends it n extra times (the door answers `duplicate` to each), testing at-least-once delivery.

The fake offers all capabilities by default. A test can restrict it to a subset (`operations` option) to verify the engine handles `unsupported` correctly.

## Adding an interface

To wire up a new chat platform:

1. Create a directory under `interfaces/` with its own `package.json`. The platform library is a dependency here, not in the engine's root. The core has no platform dependencies.

2. Implement the port. Your adapter exports an object with `iface` (a unique namespace string), the seven methods (`send`, `edit`, `delete`, `react`, `unreact`, `typing`, `fetchMessages`), `capabilities()`, and the three declared hooks (`onMessage`, `onEdit`, `onDelete`). Every method resolves a `PortResult` and never rejects. Every reference your adapter builds uses your `iface`.

3. Build protocol events from your platform's gateway events. Each event must match the shapes in `src/protocol/events.js` and pass `validateEvent`. Conversations, messages, authors and addressing must be filled from your platform's data with opaque string ids namespaced by your `iface`.

4. Wire it into the composition root (`src/index.js`): create the adapter, subscribe to your platform's gateway events, build protocol events from them, and submit them to the event door. Inject your adapter's port and capabilities into the engine's modules.

5. Map your platform's error responses to the result statuses. Once a request may have taken effect, the status must be `unknown`.

## Not built yet

The core and its adapters run in one process. The wire envelope protocol (`src/protocol/envelope.js`) and its transports (`src/protocol/wire.ts`) define the format for when they become separate processes. Several gateway events (voice state updates, presence updates, member updates) still bypass the event door and go straight to their stores. The scheduler tick is still a direct call, not a `scheduler.tick` event through the door.
