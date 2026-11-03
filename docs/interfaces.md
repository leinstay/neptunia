# Interfaces

The engine talks to people through interface adapters. An adapter translates between a chat platform and the engine's own protocol: plain serialisable objects with opaque string ids. The engine never imports a platform library. One adapter ships, for Discord, and a fake adapter stands in for tests. Several interfaces can connect to one core at once. This document is for whoever writes an adapter, runs interfaces beside the core, or changes the link.

The protocol lives in `src/protocol/`. The port contract lives in `src/interface/port.ts`, which re-exports the outbound half of the protocol. The event door, the single entry for all inbound events, lives in `src/interface/door.ts`. The link that carries both between the core and an adapter is described in [the link](#the-link).

## The protocol

The protocol has two halves: inbound events, which an adapter tells the engine, and outbound actions, which the engine asks the adapter to do.

### Inbound events

An adapter sends events as plain objects. Every event from an adapter carries `kind`, `iface` (the adapter's namespace, such as `discord`), `at` (ms since the epoch), `id` (an opaque string for deduplication) and, when the event happens in a conversation, a `conversation` record.

A conversation has these fields:

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
| `message.received` | adapter | A new message, an edit (`edit: true`) or a deletion (`deleted: true`). It carries the message, its author, the addressing (who was mentioned, whether the persona was replied to) and an optional origin record. An edit carries `previous`, the message as it was, or null when the adapter did not hold it. A deletion carries the message id and, when the adapter still knew them, `message.at` and `message.author`. A partial edit (`edit: true, partial: true`) carries only the message id, and the core asks the adapter for the rest with a read. |
| `reaction.changed` | adapter | A reaction put on or taken off a message. It carries the emoji, the member who reacted and `added` (true for put on, false for taken off). A clear (`cleared: 'emoji'` or `'all'`) removes many at once. |
| `command.requested` | adapter | An owner command from a chat surface. It carries the command `name`, its `args`, the `requester` and a `replyRef` token the core uses to send the answer back. The answer to a question of a command (a `command.result` of status `ask`) is a second `command.requested` with the same `name`, the `dialogId` of the question and the `answer` text. Both are fields of the event and never entries of `args`, and either without the other is `invalid`. |
| `membership.changed` | adapter | A member joined, left or was updated in a community. It carries the `member` with its optional `avatar`. |
| `voice.changed` | adapter | A member's voice state changed (joined, left, moved, muted, deafened, streaming, camera). It carries the member's `name` when the adapter knows it. |
| `presence.changed` | adapter | A member's presence changed. It carries `userId`, `name` (null when unknown), a `status` (`online`, `idle`, `dnd`, `offline` or `unknown`) and the `activities` list, each with a `kind` (`playing`, `streaming`, `listening`, `watching`, `competing` or `other`), a `name`, `details` and `state`. |
| `presence.snapshot` | adapter | Every voice state and presence the adapter knows at one moment, as `voice` (the fields of `voice.changed` without the envelope) and `presence` (the fields of `presence.changed` without the envelope). |
| `conversation.changed` | adapter | A conversation was created, updated or deleted. It carries the `conversation` and a `change` of `created`, `updated` or `deleted`. |
| `connection.changed` | adapter | The adapter lost its link to the platform (`state: 'lost'`) or got it back (`'resumed'`). |
| `scheduler.tick` | core | The engine's own clock tick (`at` only). The scheduler (`src/behavior/scheduler.ts`) submits one when its earliest beat is due. |
| `errand.done` | core | One of the persona's errands ended, with an `errandId`, `status` and `result`. |
| `inner.wake` | core | The inner-life scheduler found something due: an intention, a review, a heartbeat or an errand deadline. See [inner life](inner-life.md). |

The last three are the core's own events. An adapter never sends them, and they carry no `iface` and no `conversation`. `scheduler.tick` and `errand.done` carry no `id` of their own, and `inner.wake` always has one.

A message has these fields:

| Field | What |
|---|---|
| `id` | The message's id |
| `author` | `{ id, name, self, bot }` and an optional `avatar`. `self` is true for the persona's own messages and `bot` for another automated account. `avatar` is `{ hash, url }`, each a string or null, and `membership.changed` carries the same record on its `member`. |
| `content` | The text as people read it, with mentions written as names |
| `sourceText` | The text with mentions in the core's `<@id>` grammar, when it differs from `content` (optional). The core compares it to tell an edit of the words from an update of an embed. |
| `system` | True for a message the platform wrote itself, such as a join notice (optional) |
| `at` | When it was written (ms since the epoch) |
| `replyToId` | The message it replies to, or null |
| `replyPingUserId` | The replied-to author when only the reply notified them, or null |
| `forwardedFrom` | The name of the conversation a forward came from, or null |
| `attachments`, `links`, `forwarded`, `stickers`, `emojis`, `reactions` | Arrays of the items on the message |
| `messageRefs` | The messages the text links to, in the order written, each `{ iface, conversationId, messageId, url, text }` (optional) |

A reference to a message names it with ids the core never parses. `text` is the span of the message text that names it, brackets included when the platform wrote them, and `url` is the message's address on its platform (null when it has none). The core replaces the `text` of a reference to a message of the turn's window with that message's `#n` and leaves every other link as written. An address in the text with no reference on the message stays text.

An attachment and a link carry `expiring`, true when the platform's address for the file stops working after a while, as a signed address does. An attachment also carries `previewUrl`, the address the describer downloads the picture from, sized by the adapter for its platform (`null` for a file that is no picture). A link with a thumbnail carries the `previewUrl` of that thumbnail. The core downloads `previewUrl` when it is there and the item's own `url` otherwise, and it never rewrites an address by its host. A GIF that is `expiring` is not kept in the GIF library, because posted back later it would not embed.

The addressing record:

| Field | What |
|---|---|
| `mentioned` | The persona is among the mentioned members |
| `replyToSelf` | The message replies to one of the persona's messages, as far as the adapter knows without asking again |
| `mentionedUserIds` | Every member the message mentions |
| `mentionedUsers` | The name the text reads for each mentioned member, `{ id, name }` (optional) |
| `mentionedConversationIds` | Every conversation the message mentions |

A `message.received` event may carry an `origin` record. When the adapter sends none, `originOf` (`src/protocol/origin.ts`) derives one from the event's fields.

| Field | What |
|---|---|
| `chatType` | `dm`, `group`, `channel` or `thread` |
| `place` | The conversation id |
| `parent` | The conversation a thread sits in, or null |
| `thread` | The thread's id when the message is in one, or null |
| `replyToAuthorId` | The author of the replied-to message, or null |
| `replyExpected` | True when the message was meant for the persona, false when it was meant for someone else, null when the adapter cannot tell |

An event that an interface sends again after a lost link carries `replayed: true`. The interface sets it, never the platform ([Events](#events)).

### Outbound actions

Every effect the persona has in a conversation is one named action. The first six are the port's capabilities:

| Action | Target | Payload |
|---|---|---|
| `message.send` | `conversation` | `content` |
| `message.edit` | `message` | `content` |
| `message.delete` | `message` | none |
| `message.react.add` | `message` | `emoji`, a string |
| `message.react.remove` | `message` | `emoji` |
| `conversation.typing` | `conversation` | none |
| `command.result` | none | `replyRef`, `text`, optional `files`, optional `ephemeral` and optional `status`. `status` is `ok` when the command ran, else the operation's own status. Status `ask` is a question: it adds `dialogId`, `prompt`, `secret` (the answer is typed unseen) and optional `choices`, and `text` repeats the prompt. |

A `conversation` reference is `{ iface, conversationId }`. A `message` reference is `{ iface, conversationId, messageId }`, with an optional `memberId` for the author.

`content` is `{ text?, attachments?, replyTo?, mentions? }`. An attachment is `{ name, data?, url?, contentType?, voice? }`: its bytes or a URL, and `voice` (`{ durationSecs, waveform }`) for a voice message. `replyTo` is a message reference of the same interface. `mentions` is `{ users, repliedUser }`, the members the message may notify. When mentions are absent, nobody is notified.

### Reads

A read asks the adapter a question and changes nothing. It is not a capability and it never answers `unknown`, since asking again is always safe. Every read answers `{ status: 'ok', ...body }`, or `failed`, `unsupported` or `forbidden` with an `error`. An adapter declares the reads it answers in `capabilities().reads`, by wire name. `createReads` (`src/interface/reads.ts`) wraps an adapter for the core, so a caller gets the body of an `ok` answer and null for anything else. A read the adapter does not declare is null without a call, and a failing read is logged once for each code, with names and codes only. A block of a request that depends on a read is left out when the read gives null.

The table follows `src/protocol/adapter.ts`. `portAction` builds the wire action of a call and `validateAction` checks its shape.

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

`viewers` names at most 25 members. With `audience` the info carries who can see the conversation, as `everyone`, `groups`, `groupAllow`, `groupDeny`, `memberAllow`, `memberDeny` and `memberGroups`, where a group is what the platform calls a role. With `viewers` the info also carries `viewers`, a map from each named member to whether that member can see the conversation. `history` refuses two anchors, and refuses `since` together with `after` or `around`. An event of a read is the `message.received` event the interface would deliver for that message, so `lineOf` (`src/behavior/line-of.ts`) makes the same line of it that a live event gets.

### Results

Every action returns a result. An adapter never throws.

| Status | Meaning |
|---|---|
| `ok` | The action succeeded. `ref` carries the message as it now exists and `at` carries the timestamp. |
| `failed` | The action did not take effect, and the adapter knows it, for example on a rate limit or an invalid target. It may carry a `retryable` flag. |
| `unknown` | The action may have taken effect, for example on a timeout after the request left the process. The caller never retries it blindly. |
| `unsupported` | This adapter cannot perform the action. |
| `forbidden` | The adapter may not, for example when editing someone else's message. |
| `cancelled` | The caller's signal ended a send before it went to the interface. Nothing was posted. |

When the status is not `ok`, the result carries `error: { code, retryable }`. The code is a kebab-case string (`empty-content`, `text-too-long`, `not-own-message`, `timeout`) or `http-<status>`. An adapter may add `cause` for its own logs, and it never reaches the model.

A `send` answers with a delivery, which is the result above plus `parts` (every message posted), `attachments` (a `{ messageId, attachmentId }` for every file posted, when there were files) and an `idempotencyKey` that names the send. Its `ref` is the first message posted. An adapter splits a text longer than `maxChars` into several messages that join to the text (`splitText`, `src/protocol/split-text.ts`), so `send` is never refused as `text-too-long`. The reply target and the files go with the first part. If a later part fails, the status is `unknown` and `parts` lists the messages already posted. `edit` cannot split and still refuses a longer text as `text-too-long`. The core cuts no text of hers.

An adapter edits and deletes only the persona's own messages, returning `forbidden` otherwise, and refuses a reference of another interface as `foreign-reference`.

### Capabilities

An adapter declares what it can do and its limits:

```ts
capabilities() => {
  operations: Array<string>, // the action names it offers
  reads: Array<string>,      // the read actions it answers
  maxChars,                  // code points of text in one message
  maxFiles,                  // attachments in one message
  maxFileBytes,              // bytes in one attachment
  messageUrl,                // how a message is addressed, { community, direct } templates, or absent
  reconcile,                 // true when fetchMessages finds a send by its idempotency key, or absent
  presence,                  // true when the interface reports presences, or absent
}
```

The type in `src/protocol/adapter.ts` also lists the optional flags `edit`, `history`, `threads`, `reactions`, `customEmoji`, `voiceFormats`, `publish` and `search`, which the core does not read. The core reads `presence` (the around store keeps presences only when it is true), `maxFiles` (how many pictures of a diary set go in one message) and `maxChars` (how long a part of a mirrored prompt is) from `capabilities()` of its port. `messageUrl` holds two templates with `{community}`, `{conversation}` and `{message}`, one for a message of a community and one for a message of a private chat. The core fills them in to link a message it names, such as a `#n` the persona writes, a call mark or a failed message, and it sends no link when the interface declares none.

`fetchMessages(conversation, ids, { idempotencyKey })` of an adapter that declares `reconcile` also answers the messages it posted under that key. `reconcileUnknown` (`src/interface/reconcile.ts`) uses it for a send whose outcome was lost: the send is `ok` with the messages found, `failed` when none were posted, and stays `unknown` when the adapter cannot reconcile or the read fails. It never sends again. The wake deliveries (`src/behavior/inner/deliveries.ts`) call it.

A call to an action the adapter does not offer returns `unsupported` without contacting the platform. A read the adapter does not list in `reads` gives the caller null the same way.

### Validation

`validateEvent` and `validateAction` return `{ ok: true }` or `{ ok: false, reason }`. The `reason` names the field and the problem (`message.at:type`, `kind:unknown`, `conversation.id:required`). They never throw, whatever they are given.

Validation checks shapes only: known kinds, required keys, string ids, finite numbers and boolean flags. Whether a reference belongs to this interface, whether content fits its limits and who may run a command stay with the adapter and the core.

## The event door

All inbound events enter the core through one door (`src/interface/door.ts`). The door validates an event with `validateEvent`, checks its id against those already handled and hands it to the handler registered for its kind.

The link supplies the authenticated sender's name and kind separately from the event. The door passes this identity to the handler beside its ingestion row, and wire fields cannot replace it. An internal submission without this metadata receives `authenticated: null`. A principal name alone grants no authenticated identity, and a mismatch between the principal name and the supplied sender returns `invalid` before deduplication or ingestion.

| Answer | When |
|---|---|
| `duplicate` | The door has seen the id. The handler does not run again. |
| `failed` | The handler threw, or the observation of the line did not commit. The id is not remembered, so a redelivery gets another try. |
| `invalid` | The event is malformed. One log line names the kind and the reason, never the content. |
| `unhandled` | The event's kind has no handler. |

An event id is scoped by the principal that sent it, so two clients may use the same id. The door keeps the newest 10,000 ids in memory and also looks each event of a client up in the `ingest` table of the memory database (`src/memory/db/ingest.ts`), so a restart still knows every event it took. Once the handler succeeds, the door commits the event's `ingest` row and only then answers `ok`. The handler gets the row as its second argument, and the observation of a message line writes it in the transaction of the line, so the event and its line are taken together. A commit that fails answers `failed` with `ingest-failed`. The live state kinds `presence.changed`, `presence.snapshot`, `voice.changed` and `connection.changed` are deduplicated in memory only, because their handlers set what is current and a repeat changes nothing. The setting `memoryDb.ingestKeepDays` (default `7`) prunes older rows.

The door derives an id for a core event that has none: an errand's end by its errand id and status, a tick by its time. A second delivery of the same end is the same event.

The door also accepts the wire envelope form, `{ v, id, type, replyTo, body }`, with `seq` on an event that an interface numbered. Envelope types are `hello`, `event`, `ack`, `action`, `action_result`, `ping` and `cancel`. The core's own events go through `door.submit` as plain objects, and an interface's events arrive as `event` envelopes over the link.

An envelope travels as one line of JSON ending in a newline. `encodeEnvelope` and `decodeEnvelope` (`src/protocol/wire.ts`) write a `Uint8Array` as `{ "$bytes": base64 }` and read it back as a `Buffer`. A `Transport` sends envelopes, reports incoming ones and reports its close with a reason. `createLoopback` gives two connected ends in one process for tests, with every envelope passing the codec. `connectSocket` is the client of a Unix socket and `listenSocket` (`src/interface/socket.ts`) is the server. A line longer than `MAX_FRAME_BYTES` closes the link with the reason `frame-too-large`. A line that is not an envelope (`validateFrame` checks the version, id, type, `replyTo`, `seq` and that the body is an object) is skipped and the link stays open. The receiver checks the body, so a bad body gets an answer.

### The typing lease

The typing indicator is held as a lease (`src/interface/typing.ts`). The turn starts it (`src/turn/typing.ts`), and the lease sends the indicator again on a timer until the turn stops it. If the turn hangs or a code path forgets, the lease expires on its own after 5 minutes (`TYPING_LEASE_MS`). The `conversation.typing` action itself carries no lease, since the platform's indicator ends by itself.

## The link

The core and an interface exchange envelopes over a Unix socket, whether the interface runs in the core's process or in a unit of its own. `openAdapterLink` in `src/interface/link.ts` is the core's end. `serveAdapter` in `src/protocol/serve.ts` is the interface's end and holds no core state. No platform object crosses the socket.

### Starting up

At start `startCore` (`src/core.ts`) makes a random token with `crypto.randomBytes(32)`, the token of the boot principal ([Clients and principals](#clients-and-principals)), and `listenSocket` listens on `data/run/core.sock`. The folder is set to mode `0750` and the socket to `0660`, and both go to the group `neptunia` when the system has one, so the units of the interfaces reach the socket. A process outside that group keeps its own group and logs `socket: group not set`. A stale socket file is removed before listening and the file is removed on close. The path (`coreSocketPath`) and the largest frame (`MAX_FRAME_BYTES` in `src/protocol/wire.ts`) are constants beside the code, not settings. A frame holds up to 150 MiB, room for ten 10 MiB files in base64.

The interface connects with `connectSocket`, and `serveAdapter` sends `hello` first with the body `{ iface, self, community, communities, capabilities, resume, token }`. `self` is `{ id, name }`, the persona's account on the interface and the name people see for her there. `community` is `{ id, name }`, the first community the interface serves, or null when it serves none, and `communities` lists all of them. `capabilities` is what the adapter's `capabilities()` returns. `validateEnvelope` refuses a `hello` without `self`.

The core opens one link per connection and keeps `iface`, `self` and `community` for it. The namespace of every memory id, the persona's own id and the served community come from them. Her name in a request is the one the member directory of the core holds for her (`src/interface/members.ts`), which `membership.changed` events feed, and the name in `hello` before the directory knows her. The Discord interface sends the cached members of the served servers as `membership.changed` events when the core opens its door, and sends one whenever a member's name or avatar changes. Nothing that sends is built before `hello` has arrived.

If the first envelope is not `hello`, or it carries a malformed body or a token that stands for no one, or it names an `iface` other than its principal's, the link closes and nothing reaches the door. The core answers a good `hello` with an `ack` whose body is `{ status: 'ok', ackedSeq }`, the principal's watermark. A link that drops and comes back with the same principal takes over the adapter of that interface (`createLinkSwitch` in `src/interface/link.ts`), so the modules built at start reach the interface through the new link. On shutdown the link and the socket close and the socket file is removed.

### Clients and principals

Every client of the core is a principal: a `name`, a `kind` (`interface`, `cli` or `agent`), the `iface` an interface's events must carry, and `permissions`. `principalOfToken` in `src/interface/principals.ts` resolves a token to its principal from `data/clients.json` and the token files beside it, `data/clients/<name>.token` (see [Configuration](configuration.md#clients-and-their-tokens)), reading them at every call. With no `clients.json` the one principal is the boot principal: the token the core made at start, named after the interface it runs, and bound to the `iface` its `hello` names. A `clients.json` that cannot be read lets no token in. `scripts/client-token.ts` writes both files.

`openAdapterLink` takes `principalOf`, which resolves the token of `hello` and again the token of every later envelope, so a rotated or revoked token closes the link at its next envelope. The principal decides what the connection may do, never what `hello` claims. After `hello`, `validateEnvelope` checks every envelope by its type, and the link stays open whatever it answers:

- An `event` with a malformed body is answered `invalid` with the field and the problem.
- A second `hello` is answered `invalid` with `hello:repeated`.
- An event of another `iface` is answered `invalid` with `body.iface:foreign`.
- A `command.requested` of a principal that may not send one is answered `invalid` with `body.kind:not-allowed` and logged as `link: event refused`. The `cli` principal and an `agent` principal may send one. An interface principal may not, whatever its `permissions` hold.
- An `agent` principal sends nothing but `command.requested` events whose `name` starts with `task.`. Any other event of it is answered `invalid` with `body.kind:not-allowed`, any other command with `body.name:not-allowed`, and neither reaches the door.

The namespace `cli` belongs to the owner's command line. A `cli` principal must say `hello` as `iface: 'cli'`, and any other principal that names `cli` is refused with `iface`. The namespace `agent` belongs to the development agents of the task board in the same way. An `agent` principal must say `hello` as `iface: 'agent'`, and no other principal may.

`openAdapterLink` also takes `admit`, which the core uses to refuse a `hello` of an interface whose `interfaces.<name>.enabled` is `false`, with the reason `interface-disabled`. Every refused `hello` is logged as `link: hello refused` with its reason (`token`, `iface`, `hello-invalid` or `interface-disabled`), and the link closes. A first envelope that is no `hello` and a token revoked later close the link too, each with its own log line.

### Several interfaces

Several interfaces connect to one core at once when they run as units. `connectInterface` in `src/core.ts` keeps one link switch for each `iface` and records which interface serves each community named in `hello` (`community` and `communities`). `createIfaceRouter` in `src/interface/link.ts` sends an effect by the `iface` of its reference, and a read of a community by the community it names. A call with no reference to route by, `parseLinks`, goes to the core's served interface.

The first namespace of `clients.json` is the home interface of what no conversation addresses, such as wakes and the diary. The core refuses to start in units mode while `bot.guildId` is unset, because that setting names the community the core serves before any interface has said hello. In process the core starts one interface at most.

The Discord package serves every server listed in the `servers` setting of its setup, else the one of `bot.guildId`, else the only server the bot is in.

### Starting an interface

An interface package exports `start(host)`, which resolves with a running interface. Both types are in `src/protocol/host.ts`. The core hands over its end of the link and what the interface reads from the core:

| Host field | What it is |
|---|---|
| `connect()` | Opens the interface's end of the link. The core connects to its socket. |
| `token` | The token of the link, sent in `hello`. |
| `dataDir` | A folder of the interface's own, `data/interfaces/<name>/`, for what it keeps across restarts. Absent in tests that build a host by hand. |
| `env` | The environment the interface reads its own keys from. It holds one variable, the interface's platform token under the name `tokenVariableOf` gives (`DISCORD_TOKEN` for Discord), read from `data/interfaces/<name>/credentials.json`. |
| `config()` | The live settings. The interface reads them at the moment of use. |
| `onConfigChange(fn)` | Calls `fn` with `config` or `prompts` after each reload that took, and returns the unsubscribe. |
| `log` | The logger. An interface package never imports the core's. |
| `createClient` | Builds the platform client from the privileged intents asked for. Tests inject a stand-in. |

`start` builds the platform client, logs in, resolves the platform's servers, connects the link and serves the adapter over it. It rejects with a message when it cannot: `missing DISCORD_TOKEN`, a login that failed, or servers that cannot be told (see "Server resolution"). The running interface it resolves with has these fields:

| Field | What it is |
|---|---|
| `iface` | The interface's namespace on the link. |
| `open()` | Delivers the events the interface has held since `start`, and every later one. |
| `stop()` | Closes the link and the platform client. |
| `reconnect()` | Optional. Opens a new link with `connect()` and says `hello` again, keeping the platform client. The fake and the Discord interfaces have it. |

The core calls `open()` once its door has its handlers, because the door answers `unhandled` to a kind it has no handler for. Until then the interface holds what it sees, at most 1,000 events. Past that the oldest is dropped and one warning says so.

### Starting the core

`startCore(options)` in `src/core.ts` is the composition root. It builds the core and starts it over what it is given, and it resolves with `{ door, stop, interfaces }`.

| Option | What it is |
|---|---|
| `paths` | The checkout, the persona data directory and its alias the private directory, as `resolvePaths` returns them. The two directories must be the same. |
| `env` | The process environment. Model and service keys come from `keys.json` ([Keys](keys.md)). |
| `interfaces` | The interfaces to start in the core's process, each `{ name, start(host) }`. One or none. With none the interfaces run as units, and the core serves `bot.guildId`. |
| `llm`, `embedder` | Replace the provider client and the embedding client. Only a test passes them, so no test calls a provider. |
| `now` | Replaces the clock of the inner life and of the one-core check. The scheduler's waits are real timers and read the real clock. |

A failed startup check rejects with a one-line error and never exits the process. Such a check is a data directory that is not the persona root, a legacy layout that needs `scripts/persona-files-move.ts`, a required prompt that is missing, a skill registry that names an unknown tool, an unset `bot.guildId` in units mode, or a second core ([One core at a time](#one-core-at-a-time)). `stop()` ends the timers, the stores, the memory database, the interface and the link, removes the socket file and the memory database's lock file, and runs once however often it is called.

`src/index.ts` is the entry. It reads the paths, and `interfaceMode` (`src/interface/mode.ts`) reads `interfaces.mode` (default `inprocess`). With `inprocess` it loads the Discord package by path and calls `startCore` with the Discord token read from `data/interfaces/discord/credentials.json` wrapped into the interface's `env`. With `units` it calls `startCore` with no interface and reads no Discord token. Either way it handles `SIGINT`, `SIGTERM` and `unhandledRejection`, turns a rejected start into the exit code, and exits after `stop()`. Neither `src/index.ts` nor `src/core.ts` imports `discord.js` or `interfaces/`, and the structure manifest enforces it.

### Interface packages

An interface package is `interfaces/<name>/` in the checkout. A package at `data/interfaces/<name>/` with an `index.ts` or `index.js` replaces the engine's package of that name (`interfacePackageDir` in `src/config/files.ts`). The settings of an interface are the core's settings (`config/config.json` and `data/config/config.json`), then the package's own `config.json`, then `data/interfaces/<name>/config.json`.

A package that has the values of its own to ask for declares them in `setup.json`, the setup contract shared with executable skills ([Setup](setup.md#the-setup-contract-of-a-module)). The values land in `data/interfaces/<name>/`: plain ones in `config.json` and secrets in `credentials.json` at mode `0600`. `/interface setup <name>`, `/interface settings <name>`, `/interface set|clear|add|remove` and `neptunia setup` write through it, and `/interface token set <name>` writes the platform token. The Discord package declares `token` and `servers`, a list of any number of server ids.

### Interfaces as units

With `interfaces.mode: units` each interface runs in a process of its own, `neptunia interface run <name> [--interfaces-dir <dir>]` (`bin/neptunia.ts`), which `deploy/neptunia-interface@.service` starts. The runner loads `<dir>/<name>/index.ts`, else `index.js`. The folder `<dir>` defaults to the one that holds the package `interfacePackageDir` selects, and `--interfaces-dir` names another. The runner reads the client's token from `data/clients/<name>.token`, which `scripts/client-token.ts add <name> --kind interface --iface <iface>` writes, connects to `data/run/core.sock` and calls the package's `start(host)`. The host's `dataDir` is `data/interfaces/<name>`, its `env` holds the platform token from `data/interfaces/<name>/credentials.json`, and its `config()` is the layered settings above, read again whenever one of the files changes. The runner needs no other key. Then it calls `open()`.

A connection the runner cannot open is tried again with backoff, from 250 milliseconds doubling to 30 seconds, and the backoff starts over once a link stayed up for 30 seconds. When the link drops, the runner calls the interface's `reconnect()` after the next wait of the backoff, and the interface's outbox sends again what the core has not acknowledged. An interface without `reconnect()` ends the process with exit code 1, and its unit restarts it. `SIGTERM` and `SIGINT` stop the interface and exit 0.

The first interface whose `hello` is taken becomes the core's served adapter, and the persona's id and name come from its `hello`. A later link of the same client takes over as in process. Until then every effect answers `unknown` with `link-closed` and every read `failed`, as on a link that dropped. The inner life runs without an interface: a heartbeat or a selfreflection wake runs its turn, and what it sends answers as above.

`interfaces` of the started core is the owner's view of the interfaces (`createInterfaceLinks` in `src/interface/link.ts`). `list()` answers `{ name, enabled, connected }` for every interface the core runs, every interface client of `clients.json` and every interface the settings name. `enable(name)` writes `interfaces.<name>.enabled: true` to `data/config/config.json`. `disable(name)` writes `false` there and reloads the settings, so the next `hello` of that interface is refused. Then each of its links drains: it takes no new action and answers each with `failed` and `interface-disabled`, the effects in flight get `interfaces.drainMs` (default `10000`) to finish, and the link closes, which ends the rest `unknown`. `disable` resolves with `{ drained, unknown }`, the counts of the two. The `/interface` commands of the `neptunia` chat run over it ([The neptunia command](cli.md)).

### One core at a time

`claimCore` in `src/memory/db/open.ts` runs at the start of `startCore`, before anything touches the socket. It takes the memory database's writer lock, so a live holder refuses the start with `memory db ... is locked by pid ...`. Then it reads the `core:alive` lease, which the inner life renews at every tick (`src/behavior/inner/recovery.ts`). While another holder's lease is within its ttl, `context.turnLeaseMs` (default `300000`), the start lets the lock go and refuses with `core-running`. A lock left by a process that is gone means that core crashed, and its lease, fresh as it may be, does not stop the start, so a restart after a crash never waits out the ttl. A clean `stop()` lets `core:alive` go, so the next start goes ahead at once. `deploy/neptunia-core.service` conflicts with `deploy/neptunia-bot.service`, so systemd never runs both.

### Events

`emit(event)` on the interface's end checks the event with `validateEvent`, drops the `raw` and `rawPrevious` keys, sends an `event` envelope whose id is the event's own id, and resolves with the status of the `ack` that answers it: `ok`, `duplicate`, `invalid`, `unhandled` or `failed`. An event that fails validation resolves `invalid` and is not sent. A closed transport resolves `failed`. Several events can wait for their acks at once. On the core's end each `event` envelope goes to `door.receive` with the link's principal, its ack goes back, and un-numbered envelopes are handled concurrently.

`serveAdapter` takes an `outbox` (`createOutbox({ dir, capacity })`, `src/protocol/outbox.ts`), a folder of the interface's own that keeps every event until the core acknowledges it. Each event gets the next `seq` of the principal, and the numbering goes on across restarts. With an outbox nothing is sent before the core answers `hello`. That answer's `ackedSeq` drops what the core already has, and every waiting event goes again, in order, before any new one. An emit on a closed link still goes into the outbox for the next connection. The core takes one conversation's numbered events one at a time in `seq` order, the conversations side by side, so a live event waits behind the replay of its conversation. The ack of a numbered event carries the contiguous watermark of the events taken, which the core writes to `ingest_cursor` before the ack goes out. An event answered `failed` holds the watermark back, so it goes again on the next connection.

Nothing reads missed conversation back from the platform. An event that was already in the outbox when the interface connected, left by an earlier link or an earlier run, goes out marked `replayed: true`. An event that merely waited in this connection for the answer to `hello` goes as a live one. The core keeps a replayed `message.received` as history through the same observation as a live line and starts no turn over it (`src/behavior/core-message-producers.ts`). The start of the core reads no history, and a resume after a pause keeps the community messages that arrived while paused as history too. A send that was interrupted reaches her in her next turn as a fact. Only a fresh decision of hers sends again.

A full outbox evicts nothing. It refuses the event, which is lost with a warning that counts it, and `status()` reports `{ outbox: 'outbox-full' }`. The fake and the Discord interfaces keep their outbox in `host.dataDir`, under `outbox/`, at most 1,000 events. A `command.requested` never enters an outbox. It goes out at once, and on a closed link its `emit` resolves `failed`.

The platform's own message object behind a message event stays on the interface's side. The pipeline decides on the event's own fields and asks the interface for anything else through a read.

### Actions

Every method of the core's adapter, `link.adapter`, sends one `action` envelope and resolves with the `action_result` whose `replyTo` is the action's id. The actions are the port's capabilities and the reads. `send(conversation, content, { idempotencyKey, deadlineAt, signal })` carries the key its caller gives, and the link makes one when the caller gives none. The key of a send in her turn is the effect's record, `<turnId>:<effectIndex>:<target>`, with the conversation id as the target and no attempt in it (`src/turn/phases/tool-round.ts`, passed on by `message.create`), so another attempt of the turn reuses it. A later send of the same call, a GIF after her text, goes under `<key>:1`. The interface's end remembers the last 1,000 keys of effects and answers a repeated key with the stored result, without calling the adapter again.

`deadlineAt` is an absolute time in milliseconds since the epoch. The interface refuses an action that arrives after it with `failed` and the code `deadline-passed`, and an action that started in time keeps its result. A signal aborted before the call answers `cancelled` and sends nothing. Aborted later, it sends a `cancel` envelope whose `replyTo` is the action's id: an action that has not started ends `cancelled`, and once it has started, its result stands. An action that fails validation is answered `failed` with the code `invalid-action`. The platform error in `error.cause` is removed before a result is sent, because it may not serialise.

At most 256 actions wait for an answer. A call past that answers `failed` with the retryable code `link-busy`. When the link closes, every waiting effect answers `unknown` with the code `link-closed` and a waiting read answers `failed`. A call made after the close gets the same answers at once.

### What crosses

Only plain data crosses the socket: events, results and attachments, whose bytes travel as base64. A platform object, a platform error or a handle never does. A read of a conversation, a message or a member crosses as the data of its answer. The live glance at voice and presence crosses as the events `voice.changed`, `presence.changed`, `presence.snapshot` and `connection.changed`. `interfaces/discord/around.ts` builds them, and the core's around store in `src/behavior/around-store.ts` keeps what they report for the `<people_now>` block.

## Conversations and memory scope

A conversation is a direct message (`dm`), a group chat (`group_dm`), a channel of a community, or a thread. This distinction drives memory scope.

Observations from a community channel are scoped to the community (`group`). Observations from a DM are scoped to that DM conversation, tied to the partner's person when the link is verified. A DM's content never appears in a group conversation, and two unrelated DMs never see each other's content. See [memory](memory.md) for the full scope model.

## The Discord adapter

The Discord adapter lives in `interfaces/discord/` as the npm workspace package `@neptunia/interface-discord`. It depends on discord.js 14 and is the only place in the project that imports it. The entry loads it by path, and the tests and tools import `interfaces/discord/index.ts`.

### What it maps

- A Discord channel, DM or thread becomes a `conversation` with the channel id as its id and `iface` set to `discord`.
- A discord.js `messageCreate` becomes a `message.received` event through `toEvent` in `collect.ts`. A `messageUpdate` becomes an edit event and a `messageDelete` a deletion event.
- Reactions become `reaction.changed` events.
- A member or user update becomes `membership.changed` with the avatar hash and url from `memberView` in `members.ts`. A message's author carries the same pair as `author.avatar`.
- A channel or thread that is created, edited or deleted becomes `conversation.changed`. At connect, and again on each shard ready, every readable channel and cached thread is announced as `updated`.
- Voice states, presences, the server snapshot and the shard's loss and return become `voice.changed`, `presence.changed`, `presence.snapshot` and `connection.changed`.
- The interface registers no slash command. On its first connect it lists the application commands its bot has on each served server, deletes each one and logs `interface: slash commands deleted` with the count in `deleted`. A server that refuses the listing, as Discord does for a bot invited without the `applications.commands` scope, is logged as `interface: slash commands not deleted`, and the session carries on. An interaction that still arrives gets a short ephemeral refusal from the session and never reaches the core.
- A new or edited channel of a served server makes the audience warmer fetch the members its overwrites name. The warmer also runs once at `open()`.

Besides the port, `createDiscordInterface` returns a frozen capabilities object: the functions the package's own modules call over discord.js objects. It holds the permission checks (whether the bot can read, send, attach or react in a channel), the history fetches (the last messages of a channel and a window around a message) and the pull rails over discord.js objects (`checkPull`, `audienceAllows`), though the turn pulls through the reads. It holds the message search and member search of a server behind the `messages.search` and `members.search` reads, and the builders that turn voice states, presences and a server's snapshot into protocol events. The core's around store keeps that live view for the `<people_now>` prompt block, never persisted and gone at restart. Last come the server's custom emoji index and the warmer of the member cache for the audience rail.

The core reaches none of them. Everything it asks of the platform goes through the reads and the port, and a test or a tool hands in a fake adapter (`src/interface/fake.ts`).

`interfaces/discord/reads.ts` answers the conversation reads of the table above, and `createDiscordAdapter` adds them to its port. The turn, the pipeline and the wake modules take only those reads and the port. The conversations of the community, their permissions, audiences and viewers, the history, the members and the reactors come from the adapter, and the core keeps who reacted to the persona's messages in its own store (`src/behavior/reactor-store.ts`), fed by `reaction.changed`.

### Gateway intents

The client requests these gateway intents:

| Intent | Privileged | Why |
|---|---|---|
| Guilds | no | Channel and server structure |
| GuildMessages | no | Messages in server channels |
| MessageContent | no | The text of messages |
| DirectMessages | no | DM conversations |
| GuildExpressions | no | Custom emoji |
| GuildVoiceStates | no | Voice channel presence for the `<people_now>` block |
| GuildMessageReactions | no | Reaction events for the reactor store |
| GuildPresences | yes | Online, idle and dnd status. Off by default (`discord.intents.presences`). |
| GuildMembers | yes | Member join, leave and update events. Off by default (`discord.intents.members`). |

`discord.intents.presences` and `discord.intents.members` are settings of the Discord package in `interfaces/discord/config.json`, both `false` by default. Turn them on when the bot is approved for them in the Discord Developer Portal. The presence intent also sets `presence: true` in the `capabilities` of `hello`.

### Limits and error mapping

Discord allows 2000 characters per message, 10 files per message and 10 MiB per file (on a server without boosts). The adapter declares these as `maxChars`, `maxFiles` and `maxFileBytes` (`DISCORD_LIMITS`), and the jump-link forms as `messageUrl`.

A send with an `idempotencyKey` gives each part a message nonce, the first 25 hex characters of the SHA-256 of the key and the part's index (`nonceOf` in `interfaces/discord/port.ts`), and sets `enforceNonce`, so Discord answers a repeat of the same part within its window with the message already posted. People never see a nonce. Discord gives it back on the bot's own message in the gateway's message create event and in the answer to the send, never on a message read later. The adapter keeps the nonces of the messages it posted in this process, the newest 2,000, and declares `reconcile`, so `fetchMessages` with a key finds a send whose answer was lost. A send from before the interface started is not found and stays `unknown`.

Discord errors map to result statuses:

| Discord answer | Status |
|---|---|
| HTTP 429, a rate limit | `failed`, retryable |
| HTTP 403 | `forbidden` |
| Another 4xx | `failed` with an `http-<status>` code |
| A 5xx, a timeout or a network error after the request may have left | `unknown` |
| A lookup failure before the request is sent | `failed`, always |

### Mentions

Nobody is notified by default. A message notifies exactly the members named in its `mentions.users`, and the replied-to author when `mentions.repliedUser` is true. The adapter translates this to Discord's `allowedMentions` with `parse: []`.

### Server resolution

One interface instance serves one or several Discord servers. `resolveGuilds` (`interfaces/discord/guild.ts`) picks them in this order:

1. The `servers` setting, a list of server ids stored in `data/interfaces/discord/config.json` by the interface's setup. Each listed server the bot is in is served, and a listed server it is not in is logged as `interface: listed servers the bot is not in` without stopping the others. When the bot is in none of them, `start` rejects.
2. Without a list, `bot.guildId` from the core's settings. When the bot is not in that server, `start` rejects with a message that names the servers it found.
3. Without either, the only server the bot is in. When it is in several or none, `start` rejects with a message that names the servers it found.

The first served server is the `community` of `hello` and every served server is in `communities`.

## The fake adapter

`src/interface/fake.ts` is an in-memory adapter for tests. It keeps conversations and messages in memory, records every call in order (`calls`), and lets a test queue results for any operation (`failNext`). It validates every outbound action through `validateAction`, so a test driving the persona through the fake also proves she only asks for well-formed actions. A send keeps its `idempotencyKey` on each part it posted, and `fetchMessages` with that key answers them. The fake declares `reconcile` only when its `capabilities` option says so.

The fake answers every read from what a test seeds. `seedConversation(info)` gives a conversation with its permissions, audience and viewers, and `seedEvent(event)` puts a whole message into a conversation's history. `seedMember`, `seedGroups`, `seedEmoji` and `seedReactors` give the members, groups, emoji and reactors a read returns, and `removeConversation` takes a conversation away. The `reads` option limits which reads the fake declares, and `showSendsInHistory(false)` keeps the persona's own sends out of the history it serves.

`src/interface/fake-interface.ts` starts the fake the way a package starts. `start(host, { adapter, selfId, self, community, communities, reads })` connects with `host.connect()`, serves the adapter with `serveAdapter` and resolves with the running interface plus `emit(event)`, which injects an inbound event and resolves with the core's ack status, and `adapter`, whose stored messages are what the persona posted. `adapter` is a fake adapter the caller keeps, which the interface serves instead of making its own, so the chat outlives a restart of the core. `self` and `community` are what its `hello` tells the core, and `communities` lists several. A test that names none gets the account of `selfId` and the community `g1`. With a `host.dataDir` the fake numbers its events in an outbox there. `drop()` closes its end of the link as a lost connection would, and `reconnect()` connects again, says `hello` and resends what the core has not acknowledged. A turn reads the conversation through the fake's reads. `tests/fixtures/core-over-fake.ts` starts the whole core over the fake with temporary directories, the tracked prompts and a scripted model, and `tests/core-slice.test.ts` runs a message through it.

`replayFixture(fixture, door)` replays a recorded fixture of inbound events through the event door in order, the way a live adapter would deliver them. A `redeliver: n` field on an event sends it n extra times, and the door answers `duplicate` to each, which tests at-least-once delivery.

The fake offers all capabilities by default. A test can restrict it to a subset with the `operations` option, to verify that the engine handles `unsupported`, and set its limits with the `capabilities` option (`maxChars` 2000, `maxFiles` 10 and `maxFileBytes` 8 MiB by default).

## Adding an interface

To wire up a new chat platform:

1. Create a directory under `interfaces/` with its own `package.json`. The platform library is a dependency there, not in the engine's root. The core has no platform dependencies.

2. Implement the port. Your adapter exports an object with `iface` (a unique namespace string), the six effect methods (`send`, `edit`, `delete`, `react`, `unreact`, `typing`), the ten reads of the table above, `capabilities()` with the `reads` it answers, and the three declared hooks (`onMessage`, `onEdit`, `onDelete`). Every method resolves a result and never rejects. Every reference your adapter builds uses your `iface`.

3. Build protocol events from your platform's gateway events. Each event must match the shapes in `src/protocol/events.ts` and pass `validateEvent`. Conversations, messages, authors and addressing must be filled from your platform's data with opaque string ids namespaced by your `iface`.

4. Export `start(host)` from the package's entry file. It builds the platform client, serves the adapter with `serveAdapter` over `host.connect()`, subscribes to the platform's events, builds protocol events from them and sends each through `emit`. It holds the events until `open()` is called. If the interface has settings of its own, declare them in `setup.json`.

5. Map your platform's error responses to the result statuses. Once a request may have taken effect, the status must be `unknown`.

6. Make a client for it with `node scripts/client-token.ts add <name> --kind interface --iface <iface>` and run it with `neptunia interface run <name>`.

## Commands over the link

A `command.requested` event never reaches the event door. `createCommandIntake` in `src/interface/neptunia-cli.ts` stands between each link and the door. It validates the event, acknowledges it at once and runs it on the command desk (`createCommandDesk`). The answer goes back over the same link as a `command.result` action with the command's `replyRef`, `text` and `status`. So a command and its answer never reach her memory, a turn or a request.

A command of the `cli` principal is a command of the chat's table (see [The neptunia command](cli.md#commands)) and runs as the owner. The desk answers `status`, `header`, `help` and the interface switches itself and hands every other command to the owner's console (`createConsole` in `src/interface/commands/console.ts`). The console runs an operation through `runOp` with the context flag `asOwner`, which the rights check and the owner checks inside the operations accept whatever `bot.owners` says. Only the desk sets that flag, and only for the `cli` principal. A command of an `agent` principal that starts with `skill.` is a skill command ([Skills](skills.md#the-agents-commands)). Any other command of an `agent` principal, and a `task.*` command of the `cli` principal, is a command of the task board, run under the principal's name with the board's own rights ([The core](core.md#the-task-board)). The link refuses a command of an interface principal, and the desk answers one that reaches it `denied`. `serveAdapter` hands a `command.result` to its `onCommandResult` option and answers it `ok`. Without that option the action is `unsupported`.

A command that needs more than its line asks through a question. The desk answers its `command.requested` with a `command.result` of status `ask`, whose `dialogId`, `prompt`, `secret` and optional `choices` describe the question, and keeps the command waiting in `createDialogBroker` (`src/interface/commands/dialogs.ts`). The owner's reply is a second `command.requested` of the same `name` that carries the `dialogId` and the `answer`. The desk hands the text to the waiting command and answers this request with the command's next question or its result. The broker keeps open questions in the core's memory for five minutes (`DIALOG_EXPIRY_MS`). A reply after that, to another command or to an unknown `dialogId` is answered `invalid`. An answer is never an entry of `args`, so a refusal that echoes the arguments cannot echo it, and the core neither logs nor stores it. The `neptunia` chat asks a secret question without echo (see [Keys](keys.md#the-questions)).

## The owner's command line in the core

The chat's direct conversation `cli:dm:owner` is a conversation of the namespace `cli`, beside the interfaces the core serves. `createIfaceRouter` puts them behind the core's one port: a call whose reference names `iface: 'cli'` goes to the link of the chat that sent the last line, and every other call to its own interface. With no chat connected such a call answers as a link that dropped. The router's capabilities are the served interface's, with the reads of the connected chat added, so the core can read the chat's conversation and history at all. A turn names a conversation under the `iface` its info gives (`conversationOf` in `src/behavior/turn.ts`), so her reply in the chat goes back to the chat.

The private-chat gate lets the chat through whatever `private.enabled` and `bot.owners` say (`privateChatsOff` and `CLI_GATE` in `src/behavior/core-pause.ts`). Only the `cli` principal may name that namespace, so the chat is the owner's.

## What the core takes from the interface

The core takes nothing from an interface besides the link. Everything it knows of the community comes through the reads: recall and search, the journal's reconciliation of the persona's own messages, the emoji index, the avatar queue and the memory backfills. The member directory and the conversation directory of the core name who and where.
