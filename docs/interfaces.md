# Interfaces

The engine talks to people through an interface adapter. The adapter translates between a chat platform and the engine's own protocol: plain serialisable objects with opaque string ids. The engine never imports a platform library. Today one adapter exists (Discord). A second one, the fake adapter, stands in for tests.

The protocol lives in `src/protocol/`. The port contract lives in `src/interface/port.js`, which re-exports the outbound half of the protocol. The event door, the single entry for all inbound events, lives in `src/interface/door.js`. The link that carries both between the core and an adapter is described in [the link](#the-link).

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
| `communityId` | The community it belongs to (null or absent for a direct chat) |
| `name`, `topic`, `category` | What the people in it see (null when unknown) |
| `parentId` | The conversation a thread belongs to (absent or null otherwise) |
| `partnerId` | The other person of a one-to-one chat (optional) |

The twelve event kinds:

| Kind | Source | What happens |
|---|---|---|
| `message.received` | adapter | A new message, an edit (`edit: true`), or a deletion (`deleted: true`). Carries the message, its author, the addressing (who was mentioned, whether the persona was replied to) and an optional origin record. An edit carries `previous`, the message as it was, or null when the adapter did not hold it. A deletion carries the message id and, when the adapter still knew them, `message.at` and `message.author`. A partial edit (`edit: true, partial: true`) carries only the message id; the core asks the adapter for the rest with a read. |
| `reaction.changed` | adapter | A reaction put on or taken off a message. Carries the emoji, the member who reacted, and `added` (true for put on, false for taken off). A clear (`cleared: 'emoji'` or `'all'`) removes many at once. |
| `command.requested` | adapter | An owner command from the chat surface. Carries the command `name`, its `args`, the `requester` and a `replyRef` token the core uses to send the answer back. |
| `membership.changed` | adapter | A member joined, left or was updated in a community. Carries the `member` with its optional `avatar`. The Discord interface sends `updated` when a member or a user changes. |
| `voice.changed` | adapter | A member's voice state changed (joined, left, moved, muted, deafened, streaming, camera). Carries the member's `name` when the adapter knows it. |
| `presence.changed` | adapter | A member's presence changed. Carries `userId`, `name` (null when unknown), a `status` (`online`, `idle`, `dnd`, `offline` or `unknown`) and the `activities` list, each with a `kind` (`playing`, `streaming`, `listening`, `watching`, `competing` or `other`), a `name`, `details` and `state`. |
| `presence.snapshot` | adapter | Every voice state and presence the adapter knows at one moment, as `voice` (the fields of `voice.changed` without the envelope) and `presence` (the fields of `presence.changed` without the envelope). |
| `conversation.changed` | adapter | A conversation was created, updated or deleted. Carries the `conversation` and a `change` of `created`, `updated` or `deleted`. The Discord interface also sends `updated` for every readable channel and cached thread at connect, so the core knows their names. |
| `connection.changed` | adapter | The adapter lost its link to the platform (`state: 'lost'`) or got it back (`'resumed'`). |
| `scheduler.tick` | core | The engine's own clock tick (`at` only). The scheduler (`src/behavior/scheduler.ts`) submits one when its earliest beat is due. |
| `errand.done` | core | One of the persona's errands ended, with an `errandId`, `status` and `result`. |
| `inner.wake` | core | The inner-life scheduler found something due (an intention, a review, a heartbeat, an errand deadline). See [inner life](inner-life.md). |

The last three are the core's own events. An adapter never sends them. They carry no `iface`, no `id` and no `conversation`.

A message looks like this:

| Field | What |
|---|---|
| `id` | The message's id |
| `author` | `{ id, name, self, bot }` and an optional `avatar`. `self` is true for the persona's own messages; `bot` for another automated account. `avatar` is `{ hash, url }`, each a string or null; `membership.changed` carries the same record on its `member`. |
| `content` | The text as people read it (mentions written as names) |
| `sourceText` | The text as the platform stores it, when it differs from `content` (optional). The core compares it to tell an edit of the words from an update of an embed. |
| `system` | True for a message the platform wrote itself, such as a join notice (optional) |
| `at` | When it was written (ms since epoch) |
| `replyToId` | The message it replies to, or null |
| `replyPingUserId` | The replied-to author when only the reply notified them, or null |
| `forwardedFrom` | The name of the conversation a forward came from, or null |
| `attachments`, `links`, `forwarded`, `stickers`, `emojis`, `reactions` | Arrays of the items on the message |
| `messageRefs` | The messages the text links to, in the order written, each `{ iface, conversationId, messageId, url, text }` (optional) |

A reference to a message names it with ids the core never parses. `text` is the span of the message text that names it, brackets included when the platform wrote them, and `url` is the message's address on its platform (null when it has none). The core replaces the `text` of a reference to a message of the turn's window with that message's `#n` and leaves every other link as written. An address in the text with no reference on the message stays text.

An attachment and a link carry `expiring`, true when the platform's address for the file stops working after a while (a signed address). An attachment also carries `previewUrl`, the address the describer downloads the picture from, sized by the adapter for its platform (`null` for a file that is no picture). A link with a thumbnail carries the `previewUrl` of that thumbnail. The core downloads `previewUrl` when it is there and the item's own `url` otherwise, and it never rewrites an address by its host. A gif that is `expiring` is not kept in the GIF library, because posted back later it would not embed.

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

### Reads

A read asks the adapter a question and changes nothing. It is not a capability and it never answers `unknown`, since asking again is always safe. Every read answers `{ status: 'ok', ...body }`, or `failed`, `unsupported` or `forbidden` with an `error`. An adapter declares the reads it answers in `capabilities().reads`, by wire name. `createReads` (`src/interface/reads.ts`) wraps an adapter for the core: a caller gets the body of an `ok` answer and null for anything else. A read the adapter does not declare is null without a call, and a failing read is logged once for each code, with names and codes only. A block of a request that depends on a read is left out when the read gives null.

The table is written from `src/protocol/adapter.ts`. `portAction` builds the wire action of a call and `validateAction` checks its shape.

| Method | Wire action | Arguments | Body of an `ok` answer |
|---|---|---|---|
| `conversationInfo` | `conversation.info` | a conversation, optional `audience` and `viewers` | `conversation`, a conversation with `iface`, `permissions` (`read`, `send`, `attach`, `react`), `owner`, `lastMessageAt`, `voice`, `public` and, when asked, `audience` and `viewers` |
| `conversations` | `conversations.list` | `communityId`, optional `audience` and `viewers` | `conversations` as above and `groups`, each `{ id, name }` |
| `fetchMessages` | `messages.fetch` | a conversation, `messageIds` | `messages`, one for each id: `missing`, or `text`, `attachments` (each with the platform's `id`) and the whole `event` |
| `history` | `messages.history` | a conversation, `limit` (1 to 10,000), at most one of `before`, `after` and `around`, optional `since` | `events` oldest first, and `complete` |
| `memberInfo` | `member.info` | `communityId` or null, `memberId` | `member` or null: `id`, `name`, `bot`, `groupIds`, `avatar` with `hash`, `url` and `largeUrl` |
| `searchMessages` | `messages.search` | `communityId`, optional `text`, `authorId`, `after`, `before`, `offset` | `total` and `hits`, each with a message reference, `at`, `text` and the author |
| `searchMembers` | `members.search` | `communityId`, `prefix`, `limit` (1 to 1,000) | `members`, each with `id`, `handle`, `displayName`, `nickname` and `bot` |
| `emoji` | `emoji.list` | `communityId` | `emoji`, each `{ id, name, animated, url }` |
| `parseLinks` | `links.parse` | `texts` (at most 50, each at most 2,000 characters) | `refs`, a message reference or null for each text |
| `reactors` | `message.reactors` | a message, an `emoji`, `limit` (at most 100) | `memberIds` |

`viewers` names at most 25 members. With `audience` the info carries who can see the conversation, as `everyone`, `groups`, `groupAllow`, `groupDeny`, `memberAllow`, `memberDeny` and `memberGroups`, where a group is what the platform calls a role. With `viewers` the info also carries `viewers`, a map from each named member to whether that member can see the conversation. `history` refuses two anchors, and refuses `since` together with `after` or `around`. An event of a read is the `message.received` event the interface would deliver for that message, so `lineOf` (`src/behavior/line-of.js`) makes the same line of it that a live event gets.

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

A `send` answers with a delivery, which is the result above plus `parts` (every message posted), `attachments` (a `{ messageId, attachmentId }` for every file posted, when there were files) and an `idempotencyKey` that names the send. Its `ref` is the first message posted. A text longer than `maxChars` is split by the adapter into several messages that join to the text, so `send` is never refused as `text-too-long`. The reply target and the files go with the first part. If a later part fails, the status is `unknown` and `parts` lists the messages already posted. `edit` cannot split and still refuses a longer text as `text-too-long`. The core cuts no text of hers.

An adapter edits and deletes only the persona's own messages (returning `forbidden` otherwise) and refuses a reference of another interface as `foreign-reference`.

### Capabilities

An adapter declares what it can do and its limits:

```js
capabilities() → {
  operations: string[],  // the action names it offers
  reads: string[],       // the read actions it answers (see Reads)
  maxChars,              // code points of text in one message
  maxFiles,              // attachments in one message
  maxFileBytes,          // bytes in one attachment
  messageUrl             // how a message is addressed: { community, direct } templates, or absent
}
```

The turn reads `maxFiles` (how many pictures of a diary set go in one message) and `maxChars` (how long a part of a mirrored prompt is) from `capabilities()` of its port. `messageUrl` holds two templates with `{community}`, `{conversation}` and `{message}`, one for a message of a community and one for a message of a private chat. The core fills them in to link a message it names (a `#n` the persona writes, a call mark, a failed message) and sends no link when the interface declares none.

A call to an action the adapter does not offer returns `unsupported` without contacting the platform. A read the adapter does not list in `reads` gives the caller null the same way.

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

The core's own events (`scheduler.tick`, `errand.done`, `inner.wake`) carry no id. The door derives one: an errand's end by its errand id and status, a tick by its time. A second delivery of the same end is the same event.

The door also accepts the wire envelope form, `{ v, id, type, replyTo, body }`. Envelope types are `hello`, `event`, `ack`, `action`, `action_result` and `ping`. The core's own events go through `door.submit` as plain objects, and an interface's events arrive as `event` envelopes over the link.

An envelope travels as one line of JSON ending in a newline. `encodeEnvelope` and `decodeEnvelope` (`src/protocol/wire.ts`) write a `Uint8Array` as `{ "$bytes": base64 }` and read it back as a `Buffer`. A `Transport` sends envelopes, reports incoming ones and reports its close with a reason. `createLoopback` gives two connected ends in one process for tests, with every envelope passing the codec. `connectSocket` is the client of a Unix socket and `listenSocket` (`src/interface/socket.ts`) is the server: it creates its folder at mode `0700`, sets the socket to `0600`, removes a stale file before listening and removes the file on close. A line longer than `maxFrameBytes` closes the link with the reason `frame-too-large`. A line that is not a valid envelope is skipped and the link stays open.

### The typing lease

The typing indicator is held as a lease (`src/interface/typing.js`). The turn starts it; the lease refreshes the platform's indicator on a timer until the turn stops it. If the turn hangs or a code path forgets, the lease expires on its own after 5 minutes (`TYPING_LEASE_MS`).

## The link

The core and the Discord side exchange envelopes over a Unix socket, even while both run in one process. `openAdapterLink` in `src/interface/link.ts` is the core's end. `serveAdapter` in `src/protocol/serve.ts` is the interface's end and holds no core state. No discord.js object crosses the socket.

### Starting up

At start `startCore` (`src/core.js`) makes a random token with `crypto.randomBytes(32)` and `listenSocket` listens on `<data directory>/run/core.sock`. The path and the largest frame are constants beside the code and not settings. A frame holds up to 150 MiB, room for ten 10 MiB files in base64. Then it calls `start(host)` of the interface it was given (see [Starting an interface](#starting-an-interface) and [Starting the core](#starting-the-core)). The interface connects with `connectSocket`, and `serveAdapter` sends `hello` first with the body `{ iface, self, community, capabilities, resume, token }`. `self` is `{ id, name }`, the persona's account on the interface and the name people see for her there. `community` is `{ id, name }`, the community the interface serves, or null when it serves none. `capabilities` is what the adapter's `capabilities()` returns. `validateEnvelope` refuses a `hello` without `self`. The core opens one link per connection and keeps `iface`, `self` and `community` for it. The namespace of every memory id, the persona's own id and the served community come from them. Her name in a request is the one the member directory of the core holds for her (`src/interface/members.ts`), which `membership.changed` events feed, and the name in `hello` before the directory knows her. The Discord interface sends the cached members of the served guild as `membership.changed` events when the core opens its door, and sends one whenever a nickname changes. Nothing that sends is built before `hello` has arrived. If the first envelope is not `hello` or carries the wrong token, the link closes and nothing reaches the door. On shutdown the link and the socket close and the socket file is removed.

### Starting an interface

An interface package exports `start(host)`, which resolves with a running interface. Both types are in `src/protocol/host.ts`. The core hands over its end of the link and what the interface reads from the core:

| Host field | What it is |
|---|---|
| `connect()` | Opens the interface's end of the link. The core connects to its socket. |
| `token` | The token of the link, sent in `hello`. |
| `env` | The environment the interface reads its own keys from. The core passes none, and the entry adds `DISCORD_TOKEN` for the Discord package. |
| `config()` | The live config. The core passes `() => hot.config`, and the interface reads it at the moment of use. |
| `onConfigChange(fn)` | Calls `fn` with `config` or `prompts` after each reload that took, and returns the unsubscribe. |
| `log` | The logger. An interface package never imports the core's. |
| `createClient` | Builds the platform client from the privileged intents asked for. Tests inject a stand-in. |

`start` builds the platform client, logs in, resolves the platform's guild, connects the link and serves the adapter over it. It rejects with a message when it cannot: `missing DISCORD_TOKEN`, a login that failed, or a guild that cannot be told (see "Guild resolution"). The running interface it resolves with has four fields:

| Field | What it is |
|---|---|
| `iface` | The interface's namespace on the link. |
| `legacy` | What the core still takes from the platform package: `serveCommands` (see "What the core still takes from the interface"). |
| `open()` | Delivers the events the interface has held since `start`, and every later one. |
| `stop()` | Closes the link and the platform client. |

The core calls `open()` once its door has its handlers, because the door answers `unhandled` to a kind it has no handler for. Until then the interface holds what it sees, at most 1,000 events. Past that the oldest is dropped and one warn line says so.

### Starting the core

`startCore(options)` in `src/core.js` is the composition root. It builds the core and starts it over what it is given, and it resolves with `{ door, stop }`.

| Option | What it is |
|---|---|
| `paths` | The checkout, the private directory and the data directory, as `resolvePaths` returns them. |
| `env` | The environment the core reads its keys from. `OPENROUTER_CORE_KEY` is required. `YOUTUBE_API_KEY`, `BRAVE_SEARCH_API_KEY`, `EXA_API_KEY`, `OPENROUTER_SIM_KEY` and `OPENROUTER_MANAGEMENT_KEY` are optional. |
| `interfaces` | The interfaces to start, each `{ name, start(host) }`. Exactly one is started. |
| `llm`, `embedder` | Replace the provider client and the embedding client. Only a test passes them, so no test calls a provider. |
| `now` | Replaces the clock of the scheduler. |

A failed startup check, such as a private directory that does not exist, a missing key or a required prompt, rejects with a one-line error and never exits the process. `stop()` ends the timers, the stores, the memory database, the interface and the link, removes the socket file and the memory database's lock file, and runs once however often it is called.

`src/index.js` is the entry. It reads the paths and the private directory's `.env`, loads `interfaces/discord/index.js` by path, calls `startCore` with the Discord token wrapped into the interface's `env`, handles `SIGINT`, `SIGTERM` and `unhandledRejection`, turns a rejected start into the exit code, and exits after `stop()`. Neither `src/index.js` nor `src/core.js` imports `discord.js` or `interfaces/`, and `structure.json` enforces it.
### Events

`emit(event)` on the interface's end checks the event with `validateEvent`, drops the `raw` and `rawPrevious` keys, sends an `event` envelope whose id is the event's own id, and resolves with the status of the `ack` that answers it: `ok`, `duplicate`, `invalid`, `unhandled` or `failed`. An event that fails validation resolves `invalid` and is not sent. A closed transport resolves `failed`. Several events can wait for their acks at once. On the core's end each `event` envelope goes to `door.receive`, its ack goes back, and envelopes are handled concurrently.

The discord.js message behind a message event stays on the Discord side. The pipeline decides on the event's own fields and asks the interface for anything else through a read.

### Actions

Every method of the core's adapter, `link.adapter`, sends one `action` envelope and resolves with the `action_result` whose `replyTo` is the action's id. The actions are the port's capabilities and the reads. A `send` carries an `idempotencyKey` the link generates. The interface's end remembers the last 1,000 keys and answers a repeated key with the stored result, without calling the adapter again. An action that fails validation is answered `failed` with the code `invalid-action`. The platform error in `error.cause` is removed before a result is sent, because it may not serialise.

At most 256 actions wait for an answer. A call past that answers `failed` with the retryable code `link-busy`. When the link closes, every waiting effect answers `unknown` with the code `link-closed` and a waiting read answers `failed`. A call made after the close gets the same answers at once. An action has no deadline.

### What crosses

Only plain data crosses the socket, that is events, results and attachments, whose bytes travel as base64. A discord.js object, a platform error or a handle never does. A read of a conversation, a message or a member crosses as the data of its answer. The live glance at voice and presence crosses as the events `voice.changed`, `presence.changed`, `presence.snapshot` and `connection.changed`. `interfaces/discord/around.js` builds them from discord.js objects and the core's around store in `src/behavior/around-store.ts` keeps what they report for the `<people_now>` block.

## Conversations and memory scope

A conversation is a direct message (`dm`), a group chat (`group_dm`), a channel of a community, or a thread. This distinction drives memory scope.

Observations from a community channel are scoped to the community (`group`). Observations from a DM are scoped to that DM conversation (tied to the partner's person when the link is verified). A DM's content never appears in a group conversation, and two unrelated DMs never see each other's content. See [memory](memory.md) for the full scope model.

## The Discord adapter

The Discord adapter lives in `interfaces/discord/` as the npm workspace package `@neptunia/interface-discord`. It depends on discord.js 14 and is the only place in the project that imports it. The entry loads it by path, and the tests and tools import `interfaces/discord/index.js`.

### What it maps

- A Discord channel, DM or thread becomes a `conversation` (id = the channel id, `iface = 'discord'`).
- A discord.js `messageCreate` becomes a `message.received` event through `collect.js#toEvent`. An `messageUpdate` becomes an edit event, a `messageDelete` a deletion event.
- Reactions become `reaction.changed` events.
- A member or user update becomes `membership.changed` with the avatar hash and url from `members.ts#memberView`. A message's author carries the same pair as `author.avatar`.
- A channel or thread that is created, edited or deleted becomes `conversation.changed`. At connect every readable channel and cached thread is announced as `updated`.
- Voice states, presences, the guild snapshot and the shard's loss and return become `voice.changed`, `presence.changed`, `presence.snapshot` and `connection.changed`.
- Slash command interactions go to the interaction handler that the session builds over the core's admin when the core calls `legacy.serveCommands(admin)`. The session registers the command tree again when `bot.commandName` or `features.adminCommands` change.
- A new or edited channel of the served guild makes the audience warmer fetch the members its overwrites name. The warmer also runs once at `open()`.

Besides the port, `createDiscordInterface` returns a frozen capabilities object: the functions the package's own modules call over discord.js objects. They include:

- Permission checks: whether the bot can read, send, attach or react in a channel.
- History: fetching the last N messages of a channel and a window around a message.
- Pulling: the rails a pull of another channel must pass, over discord.js objects (`checkPull`, `audienceAllows`). The turn pulls through the reads.
- Searching: guild message search and member search, behind the `messages.search` and `members.search` reads.
- Around: builders that turn voice states, presences and a guild's snapshot into protocol events. The core's around store keeps the live view for the `<people_now>` prompt block, never persisted and gone at restart.
- Emoji: the server's custom emoji index.
- Audience: warming the member cache for the audience rail.
- Commands: the slash command tree, registration and interaction handling.

The core reaches none of them. Everything it asks of the platform goes through the reads and the port, and a test or a tool hands in a fake adapter (`src/interface/fake.js`).

The conversation reads of the table above are answered by `interfaces/discord/reads.ts`, which `createDiscordAdapter` adds to its port. The turn, the pipeline and the wake modules take only those reads and the port: the conversations of the community, their permissions, audiences and viewers, the history, the members and the reactors come from the adapter, and the core keeps who reacted to the persona's messages in its own store (`src/behavior/reactor-store.ts`), fed by `reaction.changed`.

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

Discord allows 2000 characters per message, 10 files per message and 10 MiB per file (on a server without boosts). The adapter declares these as `maxChars`, `maxFiles` and `maxFileBytes`, and the jump-link forms as `messageUrl`.

Discord errors map to result statuses:

- HTTP 429 (rate limit): `failed`, retryable.
- HTTP 403: `forbidden`.
- Other 4xx: `failed` with an `http-<status>` code.
- 5xx, timeout or network error after the request may have left: `unknown`.
- A lookup failure before the request is sent: always `failed`.

### Mentions

Nobody is notified by default. A message notifies exactly the members named in its `mentions.users`, and the replied-to author when `mentions.repliedUser` is true. The adapter translates this to Discord's `allowedMentions` with `parse: []`.

### Guild resolution

One instance serves exactly one Discord server. The guild is resolved from `bot.guildId` in the config. When the config names no guild and the bot is in exactly one, that one is used. When it is in several or none, `start` rejects with a message that names the guilds it found.

## The fake adapter

`src/interface/fake.js` is an in-memory adapter for tests. It keeps conversations and messages in memory, records every call in order (`calls`), and lets a test queue results for any operation (`failNext`). It validates every outbound action through `validateAction`, so a test driving the persona through the fake also proves she only asks for well-formed actions.

The fake answers every read from what a test seeds: `seedConversation(info)` gives a conversation with its permissions, audience and viewers, `seedEvent(event)` puts a whole message into a conversation's history, `seedMember`, `seedGroups`, `seedEmoji` and `seedReactors` give the members, groups, emoji and reactors a read returns, and `removeConversation` takes a conversation away. The `reads` option limits which reads the fake declares, and `showSendsInHistory(false)` keeps the persona's own sends out of the history it serves.

`src/interface/fake-interface.ts` starts the fake the way a package starts: `start(host, { legacy, selfId, self, community, reads })` connects with `host.connect()`, serves the adapter with `serveAdapter` and resolves with the running interface plus `emit(event)`, which injects an inbound event and resolves with the core's ack status, and `adapter`, whose stored messages are what the persona posted. `self` and `community` are what its `hello` tells the core, and a test that names neither gets the account of `selfId` and the community `g1`. The fake has no `legacy` of its own, and a turn needs none: it reads the conversation through the fake's reads. `tests/fixtures/core-over-fake.ts` starts the whole core over the fake with temporary directories, the tracked prompts and a scripted model, and `tests/core-slice.test.ts` runs a message through it.

`replayFixture(fixture, door)` replays a recorded fixture of inbound events through the event door in order, the way a live adapter would deliver them. A `redeliver: n` field on an event sends it n extra times (the door answers `duplicate` to each), testing at-least-once delivery.

The fake offers all capabilities by default. A test can restrict it to a subset (`operations` option) to verify the engine handles `unsupported` correctly, and set its limits with the `capabilities` option (`maxChars` 2000, `maxFiles` 10 and `maxFileBytes` 8 MiB by default).

## Adding an interface

To wire up a new chat platform:

1. Create a directory under `interfaces/` with its own `package.json`. The platform library is a dependency here, not in the engine's root. The core has no platform dependencies.

2. Implement the port. Your adapter exports an object with `iface` (a unique namespace string), the six effect methods (`send`, `edit`, `delete`, `react`, `unreact`, `typing`), the ten reads of the table above, `capabilities()` with the `reads` it answers, and the three declared hooks (`onMessage`, `onEdit`, `onDelete`). Every method resolves a `PortResult` and never rejects. Every reference your adapter builds uses your `iface`.

3. Build protocol events from your platform's gateway events. Each event must match the shapes in `src/protocol/events.js` and pass `validateEvent`. Conversations, messages, authors and addressing must be filled from your platform's data with opaque string ids namespaced by your `iface`.

4. Export `start(host)` from the package's entry file. It builds the platform client, serves the adapter with `serveAdapter` over `host.connect()`, subscribes to the platform's events, builds protocol events from them and sends each through `emit`. It holds the events until `open()` is called. The entry loads the package with a dynamic `import()` and passes `start` to `startCore`, which injects the link's adapter into the engine's modules.

5. Map your platform's error responses to the result statuses. Once a request may have taken effect, the status must be `unknown`.

## What the core still takes from the interface

`start` resolves with `legacy`, an object with one field, `serveCommands(admin)`. `src/interface/legacy.ts` types it from the core's side, so the core needs no type from `interfaces/`. `serveCommands` builds the interaction handler over the core's admin, wires the slash command interactions to it and returns `{ register() }`, which pushes the command tree. `startCore` calls it. An interface that has none (the fake) serves no commands.

Everything else the core knows of the community comes through the reads: recall and search, the offline catch-up, the journal's reconciliation of the persona's own messages, the emoji index, the avatar queue and the memory backfills. The member directory and the conversation directory of the core name who and where.
