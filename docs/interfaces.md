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
| `command.result` | (none) | `replyRef`, `text`, optional `files`, optional `ephemeral`, optional `status` (`ok` when the command ran, else the operation's own status) |

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
| `cancelled` | The caller's signal ended a send before it went to the interface. Nothing was posted. |

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
  messageUrl,            // how a message is addressed: { community, direct } templates, or absent
  reconcile              // true when fetchMessages finds a send by its idempotency key, or absent
}
```

The turn reads `maxFiles` (how many pictures of a diary set go in one message) and `maxChars` (how long a part of a mirrored prompt is) from `capabilities()` of its port. `messageUrl` holds two templates with `{community}`, `{conversation}` and `{message}`, one for a message of a community and one for a message of a private chat. The core fills them in to link a message it names (a `#n` the persona writes, a call mark, a failed message) and sends no link when the interface declares none.

`fetchMessages(conversation, ids, { idempotencyKey })` of an adapter that declares `reconcile` also answers the messages it posted under that key. `reconcileUnknown` (`src/interface/reconcile.ts`) uses it for a send whose outcome was lost: the send is `ok` with the messages found, `failed` when none were posted, and stays `unknown` when the adapter cannot reconcile or the read fails. It never sends again.

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

An event id is scoped by the principal that sent it, so two clients may use the same id. The door keeps the newest 10,000 ids in memory and also looks each event of a client up in the `ingest` table of the memory database (`src/memory/db/ingest.ts`), so a restart still knows every event it took. Once the handler succeeds, the door commits the event's `ingest` row and only then answers `ok`. The handler gets the row as its second argument, and the observation of a message line writes it in the transaction of the line, so the event and its line are taken together. A commit that fails answers `failed` with `ingest-failed`. The live state kinds `presence.changed`, `presence.snapshot`, `voice.changed` and `connection.changed` are deduplicated in memory only, because their handlers set what is current and a repeat changes nothing. Rows older than `memoryDb.ingestKeepDays` (default `7`) are pruned.

The core's own events (`scheduler.tick`, `errand.done`, `inner.wake`) carry no id. The door derives one: an errand's end by its errand id and status, a tick by its time. A second delivery of the same end is the same event.

The door also accepts the wire envelope form, `{ v, id, type, replyTo, body }`, with `seq` on an event that an interface numbered. Envelope types are `hello`, `event`, `ack`, `action`, `action_result`, `ping` and `cancel`. The core's own events go through `door.submit` as plain objects, and an interface's events arrive as `event` envelopes over the link.

An envelope travels as one line of JSON ending in a newline. `encodeEnvelope` and `decodeEnvelope` (`src/protocol/wire.ts`) write a `Uint8Array` as `{ "$bytes": base64 }` and read it back as a `Buffer`. A `Transport` sends envelopes, reports incoming ones and reports its close with a reason. `createLoopback` gives two connected ends in one process for tests, with every envelope passing the codec. `connectSocket` is the client of a Unix socket and `listenSocket` (`src/interface/socket.ts`) is the server: it creates its folder at mode `0700`, sets the socket to `0600`, removes a stale file before listening and removes the file on close. A line longer than `maxFrameBytes` closes the link with the reason `frame-too-large`. A line that is not an envelope (`validateFrame`: version, id, type, `replyTo`, `seq` and a body object) is skipped and the link stays open. The body is checked by the receiver, so a bad body gets an answer.

### The typing lease

The typing indicator is held as a lease (`src/interface/typing.js`). The turn starts it; the lease refreshes the platform's indicator on a timer until the turn stops it. If the turn hangs or a code path forgets, the lease expires on its own after 5 minutes (`TYPING_LEASE_MS`).

## The link

The core and an interface exchange envelopes over a Unix socket, whether the interface runs in the core's process or in a unit of its own. `openAdapterLink` in `src/interface/link.ts` is the core's end. `serveAdapter` in `src/protocol/serve.ts` is the interface's end and holds no core state. No discord.js object crosses the socket.

### Starting up

At start `startCore` (`src/core.js`) makes a random token with `crypto.randomBytes(32)`, the token of the boot principal (see [Clients and principals](#clients-and-principals)), and `listenSocket` (`src/interface/socket.ts`) listens on `<data directory>/run/core.sock`. The folder is set to mode `0750` and the socket to `0660`, and both go to the group `neptunia` when the system has one, so the units of the interfaces reach the socket. A process outside that group keeps its own group and logs `socket: group not set`. The path and the largest frame are constants beside the code (`coreSocketPath`, and `MAX_FRAME_BYTES` in `src/protocol/wire.ts`) and not settings. A frame holds up to 150 MiB, room for ten 10 MiB files in base64. Then it calls `start(host)` of the interface it was given (see [Starting an interface](#starting-an-interface) and [Starting the core](#starting-the-core)). The interface connects with `connectSocket`, and `serveAdapter` sends `hello` first with the body `{ iface, self, community, capabilities, resume, token }`. `self` is `{ id, name }`, the persona's account on the interface and the name people see for her there. `community` is `{ id, name }`, the community the interface serves, or null when it serves none. `capabilities` is what the adapter's `capabilities()` returns. `validateEnvelope` refuses a `hello` without `self`. The core opens one link per connection and keeps `iface`, `self` and `community` for it. The namespace of every memory id, the persona's own id and the served community come from them. Her name in a request is the one the member directory of the core holds for her (`src/interface/members.ts`), which `membership.changed` events feed, and the name in `hello` before the directory knows her. The Discord interface sends the cached members of the served guild as `membership.changed` events when the core opens its door, and sends one whenever a nickname changes. Nothing that sends is built before `hello` has arrived. If the first envelope is not `hello`, carries a malformed body or a token that stands for no one, or names an `iface` other than its principal's, the link closes and nothing reaches the door. The core answers a good `hello` with an `ack` whose body is `{ status: 'ok', ackedSeq }`, the principal's watermark. A link that drops and comes back with the same principal takes over the core's adapter (`createLinkSwitch` in `src/interface/link.ts`), so the modules built at start reach the interface through the new link. On shutdown the link and the socket close and the socket file is removed.

### Clients and principals

Every client of the core is a principal: a `name`, a `kind` (`interface`, `cli`, `plugin` or `agent`), the `iface` an interface's events must carry, and `permissions`. `principalOfToken` in `src/interface/principals.ts` resolves a token to its principal from the private layer's `clients.json` and the token files beside it (see [Configuration](configuration.md#clients-and-their-tokens)), reading them at every call. With no `clients.json` the one principal is the boot principal: the token the core made at start, named after the interface it runs, and bound to the `iface` its `hello` names.

`openAdapterLink` takes `principalOf` and resolves the token of `hello`, and again for every later envelope, so a rotated or revoked token closes the link at its next envelope. The principal decides what the connection may do, never what `hello` claims: the `kind` or an owner named in `hello` grants nothing. After `hello`, every envelope is checked with `validateEnvelope` by its type, and the link stays open whatever it answers:

- An `event` with a malformed body is answered `invalid` with the field and the problem.
- A second `hello` is answered `invalid` with `hello:repeated`.
- An event of another `iface` is answered `invalid` with `body.iface:foreign`.
- A `command.requested` of a principal that may not send one is answered `invalid` with `body.kind:not-allowed` and logged as `link: event refused`. The `cli` principal may and so may an `agent` principal. An interface principal may not, whatever its `permissions` hold.
- An `agent` principal sends nothing but `command.requested` events whose `name` starts with `task.`. Any other event of it is answered `invalid` with `body.kind:not-allowed`, and any other command with `body.name:not-allowed`, and neither reaches the door.

The namespace `cli` belongs to the owner's command line: a `cli` principal must say `hello` as `iface: 'cli'`, and any other principal that names `cli` is refused with `iface`. The namespace `agent` belongs to the development agents of the task board in the same way: an `agent` principal must say `hello` as `iface: 'agent'`, and no other principal may.

`openAdapterLink` also takes `admit`, which the core passes to refuse a `hello` of an interface whose `interfaces.<name>.enabled` is `false`, with the reason `interface-disabled`. Every refused `hello` is logged as `link: hello refused` with its reason (`token`, `iface`, `hello-invalid` or `interface-disabled`), and the link closes.

### Starting an interface

An interface package exports `start(host)`, which resolves with a running interface. Both types are in `src/protocol/host.ts`. The core hands over its end of the link and what the interface reads from the core:

| Host field | What it is |
|---|---|
| `connect()` | Opens the interface's end of the link. The core connects to its socket. |
| `token` | The token of the link, sent in `hello`. |
| `dataDir` | A folder of the interface's own under `<data directory>/interfaces/<name>/`, for what it keeps across restarts. Absent in tests that build a host by hand. |
| `env` | The environment the interface reads its own keys from. The core passes none, and the entry adds `DISCORD_TOKEN` for the Discord package. |
| `config()` | The live config. The core passes `() => hot.config`, and the interface reads it at the moment of use. |
| `onConfigChange(fn)` | Calls `fn` with `config` or `prompts` after each reload that took, and returns the unsubscribe. |
| `log` | The logger. An interface package never imports the core's. |
| `createClient` | Builds the platform client from the privileged intents asked for. Tests inject a stand-in. |

`start` builds the platform client, logs in, resolves the platform's guild, connects the link and serves the adapter over it. It rejects with a message when it cannot: `missing DISCORD_TOKEN`, a login that failed, or a guild that cannot be told (see "Guild resolution"). The running interface it resolves with has these fields:

| Field | What it is |
|---|---|
| `iface` | The interface's namespace on the link. |
| `open()` | Delivers the events the interface has held since `start`, and every later one. |
| `stop()` | Closes the link and the platform client. |
| `reconnect()` | Optional. Opens a new link with `connect()` and says `hello` again, keeping the platform client. The fake and the Discord interfaces have it. |

The core calls `open()` once its door has its handlers, because the door answers `unhandled` to a kind it has no handler for. Until then the interface holds what it sees, at most 1,000 events. Past that the oldest is dropped and one warn line says so.

### Starting the core

`startCore(options)` in `src/core.js` is the composition root. It builds the core and starts it over what it is given, and it resolves with `{ door, stop, interfaces }`.

| Option | What it is |
|---|---|
| `paths` | The checkout, the private directory and the data directory, as `resolvePaths` returns them. |
| `env` | The environment the core reads its keys from. `OPENROUTER_CORE_KEY` is required. `YOUTUBE_API_KEY`, `BRAVE_SEARCH_API_KEY`, `EXA_API_KEY`, `OPENROUTER_SIM_KEY` and `OPENROUTER_MANAGEMENT_KEY` are optional. |
| `interfaces` | The interfaces to start in the core's process, each `{ name, start(host) }`. One or none: with none the interfaces run as units, and the core serves `bot.guildId`. |
| `llm`, `embedder` | Replace the provider client and the embedding client. Only a test passes them, so no test calls a provider. |
| `now` | Replaces the clock of the inner life and of the one-core check. The scheduler's waits are real timers and read the real clock. |

A failed startup check, such as a private directory that does not exist, a missing key, a required prompt or a second core (see [One core at a time](#one-core-at-a-time)), rejects with a one-line error and never exits the process. `stop()` ends the timers, the stores, the memory database, the interface and the link, removes the socket file and the memory database's lock file, and runs once however often it is called.

`src/index.js` is the entry. It reads the paths and the private directory's `.env`, and `interfaceMode` (`src/interface/mode.ts`) reads `interfaces.mode`. With `inprocess` it loads `interfaces/discord/index.js` by path and calls `startCore` with the Discord token wrapped into the interface's `env`. With `units` it calls `startCore` with no interface and reads no Discord token. Either way it handles `SIGINT`, `SIGTERM` and `unhandledRejection`, turns a rejected start into the exit code, and exits after `stop()`. Neither `src/index.js` nor `src/core.js` imports `discord.js` or `interfaces/`, and `structure.json` enforces it.
### Interfaces as units

With `interfaces.mode: units` each interface runs in a process of its own, `neptunia interface run <name> [--interfaces-dir <dir>]` (`bin/neptunia.ts`, the `bin` of `package.json`), which `deploy/neptunia-interface@.service` starts. The runner loads `<dir>/<name>/index.ts`, else `index.js`, from `interfaces/` in the checkout unless `--interfaces-dir` names another folder. It reads the client's token from `$NEPTUNIA_PRIVATE_DIR/clients/<name>.token`, which `tools/client-token.mjs add <name> --kind interface --iface <iface>` writes, connects to `$NEPTUNIA_DATA_DIR/run/core.sock` and calls the package's `start(host)`. The host's `dataDir` is `<data directory>/interfaces/<name>`. Its `env` is the process environment, so the unit's environment file carries the platform token. Its `config()` is `config.json`, then the package's own `config.json`, then `config.local.json` when the unit's user can read it, read again whenever one of the files changes. The runner needs no `.env`. Then it calls `open()`.

A connection the runner cannot open is tried again with backoff, from 250 milliseconds doubling to 30 seconds, and the backoff starts over once a link stayed up for 30 seconds. When the link drops, the runner calls the interface's `reconnect()` after the next wait of the backoff, and its outbox sends again what the core has not acknowledged. An interface without `reconnect()` ends the process with exit code 1, and its unit restarts it. `SIGTERM` and `SIGINT` stop the interface and exit 0.

The core serves one interface namespace. When it starts with no interface, it takes the namespace from the interface clients of `clients.json` and refuses to start when they name more than one. The first interface whose `hello` is taken becomes the core's adapter, the persona's id and name come from its `hello`, and a later link of the same client takes over as in-process. Until then every effect answers `unknown` with `link-closed` and every read `failed`, as on a link that dropped. The inner life runs without an interface: a heartbeat or a selfreflection wake runs its turn, and what it sends answers as above.

`interfaces` of the started core is the owner's view of the interfaces (`createInterfaceLinks` in `src/interface/link.ts`). `list()` answers `{ name, enabled, connected }` for every interface the core runs, every interface client of `clients.json` and every interface the settings name. `enable(name)` writes `interfaces.<name>.enabled: true` to `config.local.json`. `disable(name)` writes `false` there and reloads the config, so the next `hello` of that interface is refused. Then each of its links drains: the link takes no new action and answers each with `failed` and `interface-disabled`, the effects in flight get `interfaces.drainMs` (default `10000`) to finish, and the link closes, which ends the rest `unknown`. `disable` resolves with `{ drained, unknown }`, the counts of the two. The `/interface` commands of the `neptunia` chat run over it (see [The neptunia command](cli.md)).

### One core at a time

`claimCore` in `src/memory/db/open.js` runs at the start of `startCore`, before anything touches the socket. It takes the memory database's writer lock, so a live holder refuses the start with `memory db ... is locked by pid ...`. Then it reads the `core:alive` lease, which the inner life renews at every tick while `features.innerLife` is on (`src/behavior/inner/recovery.ts`). While another holder's lease is within its ttl, `context.turnLeaseMs`, the start lets the lock go and refuses with `core-running`. A lock left by a process that is gone means that core crashed, and its lease, fresh as it may be, no longer stops the start, so a restart after a crash never waits out the ttl. A clean `stop()` lets `core:alive` go, so the next start goes ahead at once. `deploy/neptunia-core.service` conflicts with `deploy/neptunia-bot.service` as well, so systemd never runs both.

### Events

`emit(event)` on the interface's end checks the event with `validateEvent`, drops the `raw` and `rawPrevious` keys, sends an `event` envelope whose id is the event's own id, and resolves with the status of the `ack` that answers it: `ok`, `duplicate`, `invalid`, `unhandled` or `failed`. An event that fails validation resolves `invalid` and is not sent. A closed transport resolves `failed`. Several events can wait for their acks at once. On the core's end each `event` envelope goes to `door.receive` with the link's principal, its ack goes back, and un-numbered envelopes are handled concurrently.

`serveAdapter` takes an `outbox` (`createOutbox({ dir, capacity })`, `src/protocol/outbox.ts`), a folder of the interface's own that keeps every event until the core acknowledges it. Each event gets the next `seq` of the principal, and the numbering goes on across restarts. With an outbox nothing is sent before the core answers `hello`. That answer's `ackedSeq` drops what the core already has, and every waiting event goes again, in order, before any new one. An emit on a closed link still goes into the outbox for the next connection. The core takes one conversation's numbered events one at a time in `seq` order, the conversations side by side, so a live event waits behind the replay of its conversation. The ack of a numbered event carries the contiguous watermark of the events taken, which the core writes to `ingest_cursor` before the ack goes out. An event answered `failed` holds the watermark back, so it goes again on the next connection.

A full outbox evicts nothing. The event is refused, `status()` reports `{ outbox: 'outbox-full' }`, and the interface marks the time of the first refused message of each conversation. Once acknowledgements make room, it reads those conversations back with `history(conversation, { since })`, at most 100 messages each, and queues them under the ids live ingestion gives them, so the core deduplicates what it already had. Until that gap is read back every new event joins it. An event of another kind refused meanwhile is lost, with a warning that counts it.

The fake and the Discord interfaces keep their outbox in `host.dataDir`, under `outbox/`, at most 1,000 events. A `command.requested` never enters an outbox: it goes out at once, and on a closed link its `emit` resolves `failed`.

The discord.js message behind a message event stays on the Discord side. The pipeline decides on the event's own fields and asks the interface for anything else through a read.

### Actions

Every method of the core's adapter, `link.adapter`, sends one `action` envelope and resolves with the `action_result` whose `replyTo` is the action's id. The actions are the port's capabilities and the reads. `send(conversation, content, { idempotencyKey, deadlineAt, signal })` carries the key its caller gives, and the link makes one when the caller gives none. The key of a send in her turn is the effect's record, `<turnId>:<effectIndex>:<target>`, the conversation id as the target, with no attempt in it (`src/turn/phases/tool-round.ts`, passed on by `message.create`), so another attempt of the turn reuses it. A later send of the same call, a GIF after her text, goes under `<key>:1`. The interface's end remembers the last 1,000 keys of effects and answers a repeated key with the stored result, without calling the adapter again.

`deadlineAt` is an absolute time in milliseconds since the epoch. The interface refuses an action that arrives after it with `failed` and the code `deadline-passed`, and an action that started in time keeps its result. A signal aborted before the call answers `cancelled` and sends nothing. Aborted later, it sends a `cancel` envelope whose `replyTo` is the action's id: an action that has not started ends `cancelled`, and once it has started, its result stands. An action that fails validation is answered `failed` with the code `invalid-action`. The platform error in `error.cause` is removed before a result is sent, because it may not serialise.

At most 256 actions wait for an answer. A call past that answers `failed` with the retryable code `link-busy`. When the link closes, every waiting effect answers `unknown` with the code `link-closed` and a waiting read answers `failed`. A call made after the close gets the same answers at once.

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
- The interface registers no slash command. On its first connect it lists the application commands its bot has on the guild, deletes each one and logs `interface: slash commands deleted` with the count in `deleted`. A guild that refuses the listing, as Discord does for a bot invited without the `applications.commands` scope, is logged as `interface: slash commands not deleted`, and the session carries on. An interaction that still arrives gets a short ephemeral refusal from the session and never reaches the core.
- A new or edited channel of the served guild makes the audience warmer fetch the members its overwrites name. The warmer also runs once at `open()`.

Besides the port, `createDiscordInterface` returns a frozen capabilities object: the functions the package's own modules call over discord.js objects. They include:

- Permission checks: whether the bot can read, send, attach or react in a channel.
- History: fetching the last N messages of a channel and a window around a message.
- Pulling: the rails a pull of another channel must pass, over discord.js objects (`checkPull`, `audienceAllows`). The turn pulls through the reads.
- Searching: guild message search and member search, behind the `messages.search` and `members.search` reads.
- Around: builders that turn voice states, presences and a guild's snapshot into protocol events. The core's around store keeps the live view for the `<people_now>` prompt block, never persisted and gone at restart.
- Emoji: the server's custom emoji index.
- Audience: warming the member cache for the audience rail.

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

A send with an `idempotencyKey` gives each part a message nonce, the first 25 hex characters of the SHA-256 of the key and the part's index (`nonceOf` in `interfaces/discord/port.js`), and sets `enforceNonce`, so Discord answers a repeat of the same part within its window with the message already posted. People never see a nonce. Discord gives it back on the bot's own message in the gateway's message create event and in the answer to the send, never on a message read later. The adapter keeps the nonces of the messages it posted in this process, the newest 2,000, and declares `reconcile`, so `fetchMessages` with a key finds a send whose answer was lost. A send from before the interface started is not found and stays `unknown`.

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

`src/interface/fake.js` is an in-memory adapter for tests. It keeps conversations and messages in memory, records every call in order (`calls`), and lets a test queue results for any operation (`failNext`). It validates every outbound action through `validateAction`, so a test driving the persona through the fake also proves she only asks for well-formed actions. A send keeps its `idempotencyKey` on each part it posted, and `fetchMessages` with that key answers them. The fake declares `reconcile` only when its `capabilities` option says so.

The fake answers every read from what a test seeds: `seedConversation(info)` gives a conversation with its permissions, audience and viewers, `seedEvent(event)` puts a whole message into a conversation's history, `seedMember`, `seedGroups`, `seedEmoji` and `seedReactors` give the members, groups, emoji and reactors a read returns, and `removeConversation` takes a conversation away. The `reads` option limits which reads the fake declares, and `showSendsInHistory(false)` keeps the persona's own sends out of the history it serves.

`src/interface/fake-interface.ts` starts the fake the way a package starts: `start(host, { selfId, self, community, reads })` connects with `host.connect()`, serves the adapter with `serveAdapter` and resolves with the running interface plus `emit(event)`, which injects an inbound event and resolves with the core's ack status, and `adapter`, whose stored messages are what the persona posted. `self` and `community` are what its `hello` tells the core, and a test that names neither gets the account of `selfId` and the community `g1`. With a `host.dataDir` the fake numbers its events in an outbox there. `drop()` closes its end of the link as a lost connection would, and `reconnect()` connects again, says `hello` and resends what the core has not acknowledged. A turn reads the conversation through the fake's reads. `tests/fixtures/core-over-fake.ts` starts the whole core over the fake with temporary directories, the tracked prompts and a scripted model, and `tests/core-slice.test.ts` runs a message through it.

`replayFixture(fixture, door)` replays a recorded fixture of inbound events through the event door in order, the way a live adapter would deliver them. A `redeliver: n` field on an event sends it n extra times (the door answers `duplicate` to each), testing at-least-once delivery.

The fake offers all capabilities by default. A test can restrict it to a subset (`operations` option) to verify the engine handles `unsupported` correctly, and set its limits with the `capabilities` option (`maxChars` 2000, `maxFiles` 10 and `maxFileBytes` 8 MiB by default).

## Adding an interface

To wire up a new chat platform:

1. Create a directory under `interfaces/` with its own `package.json`. The platform library is a dependency here, not in the engine's root. The core has no platform dependencies.

2. Implement the port. Your adapter exports an object with `iface` (a unique namespace string), the six effect methods (`send`, `edit`, `delete`, `react`, `unreact`, `typing`), the ten reads of the table above, `capabilities()` with the `reads` it answers, and the three declared hooks (`onMessage`, `onEdit`, `onDelete`). Every method resolves a `PortResult` and never rejects. Every reference your adapter builds uses your `iface`.

3. Build protocol events from your platform's gateway events. Each event must match the shapes in `src/protocol/events.js` and pass `validateEvent`. Conversations, messages, authors and addressing must be filled from your platform's data with opaque string ids namespaced by your `iface`.

4. Export `start(host)` from the package's entry file. It builds the platform client, serves the adapter with `serveAdapter` over `host.connect()`, subscribes to the platform's events, builds protocol events from them and sends each through `emit`. It holds the events until `open()` is called. The entry loads the package with a dynamic `import()` and passes `start` to `startCore`, which injects the link's adapter into the engine's modules.

5. Map your platform's error responses to the result statuses. Once a request may have taken effect, the status must be `unknown`.

## Commands over the link

A `command.requested` event never reaches the event door. `createCommandIntake` in `src/interface/neptunia-cli.ts` stands between each link and the door. It validates the event, acknowledges it at once and runs it on the command desk (`createCommandDesk`). The answer goes back over the same link as a `command.result` action with the command's `replyRef`, `text` and `status`. So a command and its answer never reach her memory, a turn or a request.

A command of the `cli` principal is a command of the chat's table (see [The neptunia command](cli.md#commands)) and runs as the owner. The desk answers `status`, `header`, `help` and the interface switches itself and hands every other one to the owner's console (`createConsole` in `src/interface/commands/console.ts`). The console runs an operation through `runOp` with the context flag `asOwner`, which the rights check and the owner checks inside the operations pass whatever `bot.owners` says. Only the desk sets that flag, and only for the `cli` principal. A command of an `agent` principal, and a `task.*` command of the `cli` principal, is a command of the task board, run under the principal's name with the board's own rights (see [The core](core.md#the-board-on-the-cores-socket)). The link refuses a command of an interface principal, and the desk answers one that reaches it `denied`. `serveAdapter` hands a `command.result` to its `onCommandResult` option and answers it `ok`. Without that option the action is `unsupported`.

## The owner's command line in the core

The chat's direct conversation `cli:dm:owner` is a conversation of the namespace `cli`, beside the one interface the core serves. `createIfaceRouter` in `src/interface/link.ts` puts both behind the core's one port: a call whose reference names `iface: 'cli'` goes to the link of the chat that sent the last line, and every other call to the served interface. With no chat connected such a call answers as a link that dropped. The router's capabilities are the served interface's, with the reads of the connected chat added, so the core reads the chat's conversation and history at all. A turn names a conversation under the `iface` its info gives (`conversationOf` in `src/behavior/turn.js`), so her reply in the chat goes back to the chat.

The private-chat gate lets the chat through whatever `features.privateMessages` and `bot.owners` say (`privateChatsOff` and `CLI_GATE` in `src/behavior/core-pause.ts`). Only the `cli` principal may name that namespace, so the chat is the owner's.

## What the core takes from the interface

The core takes nothing from an interface besides the link. Everything it knows of the community comes through the reads: recall and search, the offline catch-up, the journal's reconciliation of the persona's own messages, the emoji index, the avatar queue and the memory backfills. The member directory and the conversation directory of the core name who and where.
