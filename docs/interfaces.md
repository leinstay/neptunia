# Interfaces

An interface connects a platform to the persona. It translates platform messages into protocol events and executes the actions the core returns. Discord is the shipped implementation; another platform uses the same contract.

## Package contract

Start with [InterfaceHost](../src/protocol/host.ts), [events](../src/protocol/events.ts) and the [adapter types](../src/protocol/adapter.ts). A package exports `start(host)` and returns a `RunningInterface` with `iface`, `open()` and `stop()`. It may provide `reconnect()`.

The host supplies a connection, client token, live settings, logger and a directory for interface state. `open()` releases incoming events after the core has installed its handlers. `stop()` closes the link first, and the interface sends no event after it. The Discord session drops the `connection.changed` lost that `client.destroy()` fires while it stops, since no link is left to carry it. Declare capabilities such as history, reactions, attachments and search honestly; unsupported operations return an explicit result.

`toEvent` in `interfaces/discord/collect.ts` marks a message `system` when discord.js reports it as Discord's own notice (`message.system`: a member joined, a pin, a boost), and the core records no system message. A webhook's post and a bot's message carry their author with `bot: true` and are lines like any other.

Keep platform SDK imports in the interface package. The interface imports only the shared protocol from the engine. It never opens `memory.db`. Use [the fake interface package](../tests/fixtures/interfaces/fake/) for a small executable reference, [Discord](../interfaces/discord/) for a full implementation, and [the command line](../interfaces/cli/) for one that lives in the owner's terminal, with no data folder, no outbox and no unit.

## Identity and audience

Every account and chat belongs to an interface namespace. Preserve native IDs as identifiers, not display names. Supply root, chat, author, timestamps and visibility information in the event shape. A direct chat is private even when its participant also belongs to a server.

[Neutral addresses](../src/protocol/identity.ts) name a place and an account by the interface, the authority inside it and the native id, with a generation for an account. `chatKey` and `accountKey` serialize them as a tuple, so no character inside a native id can forge another address. A chat may declare `authorityId` when one interface serves several tenants, and an event without it is addressed under `nativeAuthorityOf(iface)`.

An interface reports `addressing.mentioned` and `addressing.replyToSelf` as facts. Whether a line was said to the persona is the core's address classifier ([The door](core.md#the-door)), and a platform-specific rail against spam, if one is ever needed, lives in that interface and is off by default. A chat with `rootId` null is a DM unless its `chatType` is `group_dm`, which is a group that is its own root.

A chat declares what contains it with `parentId` and `parentKind`, of any kind and at any depth, and `validateEvent` refuses a `parentKind` or an `authorityId` that is not a nonempty string. The place key is `<parentKind>:<parentId>`, and a thread with no declared kind sits in `channel:<parentId>`. A container between a room and its root is not declared and a chat carries no category, so the Discord adapter declares a channel's root as a parent of kind `server`, whatever sidebar grouping the channel shows under. A thread declares its room. `validateEvent` drops a `category` field without a refusal, and `parentPlaceOf` in `src/memory/db/observe.ts` puts a room that still declares a parent of kind `category` under the envelope's top and stores nothing for the parent. Discord's objects end inside `interfaces/discord/collect.ts`.

A root id is native to its interface, so two interfaces may name the same one. [Root routes](../src/core-routing.ts) keep each interface's roots as its `hello` declares them. A read inside an event or a turn goes to that event's interface when it serves the root, and any other read goes to the first interface serving it whose link is up. Hello order, a reconnect and another interface's disconnect leave a route in place. The core holds a root by its canonical place; `src/interface/reads.ts` asks the interface by the native id, and answers a read that names a DM or the persona with null without asking.

A `hello` may carry `names`, what the interface says of itself: `{ interface, nouns, dm }`, its name, its noun for each kind of place it reports (`{ server: 'server', channel: 'channel' }`) and its word for a direct chat. `noteRoots` in `src/memory/db/roots.ts` writes the name to `interfaces.name` and the nouns and the word to `interfaces.extra`. The name index of the graph reader takes the name and the nouns as names of the interface, so the interface's name raises its top places and a noun raises the places of its kind ([How a turn remembers](memory.md#how-a-turn-remembers)). A `hello` without `names` is accepted, and the interface's id stands as the name of an interface that has none yet. The nouns are the only platform words a request carries. They name the interface's kinds of place in `<interface>` of `<surroundings>` and fill `{noun}` of `spatial.kind` in `<spatial_awareness>`, while the labels and the tools speak of places only. Text an interface declares with its capabilities, such as the `text` of `mediaPick`, reaches `<interface>` as it is, so what a platform's own stickers are is said there. `validateEnvelope` refuses `names` whose fields are not strings. Discord sends its names from `interfaces/discord/session.ts` and the command line from `interfaces/cli/link.ts`.

The core serves one interface and routes the others through `createIfaceRouter` in `src/interface/link.ts`, so a send, an edit or a read goes to the adapter of its reference's `iface`. What the core asks about a turn's place goes the same way. `capabilitiesOf(ref)` answers what the interface of the reference declares, and nothing for an interface no adapter answers. `portAt` in `src/interface/capabilities.ts` turns the port into that interface's view. The `<interface>` text, the custom emoji, the media pick's forms, the address of a message link and the tools of a turn all come from the place's interface. `interfaces/cli/link.ts` declares `customEmoji: false`, `mentions: false`, `channelLinks: false`, no `mediaPick`, no `messageUrl` and only `message.send` and `chat.typing` as operations. A command line turn therefore carries no emoji or sticker text of the served interface and runs no media pick. It offers no reaction, edit or delete tool. `renderPost` in `src/turn/sends.ts` writes her text in the forms the place's interface declares. With `mentions: false` a member she names reads as their name and nobody is notified, and with `channelLinks: false` a channel reads as its name. A custom emoji stays as she wrote it without `customEmoji`. With no `messageUrl` a `#N` of a stored line of the place reads as the number the owner's chat draws on that line (`lineNumberOf` in `src/memory/db/chat-lines.ts`), and any other `#N` stays as written. `capabilities()` of the router answers the served interface's declaration with the reads of the routed ones added, for the questions about the served interface.

A direct message needs no root and never borrows one. The private gate in `src/pipeline/private-gate.ts` takes the author and the interface: the owner passes without a stored profile, a person with a profile passes on its score, and with roots served on that interface a stranger must be a member of one. A queued message gets the same answer when `src/pipeline/drain.ts` takes it. The core starts with no root at all, and the interface's own settings name the servers it serves (`servers` in `interfaces/discord/config.json`).

Inside the core every chat is a place, and every function takes one `placeId`: a server, a channel, a thread, a group or a direct message. An account is an `accountId`. A chat's native `id` and `rootId`, the native id of the top of its tree, stay at the protocol, and [the reads](../src/interface/reads.ts) turn a place back into the native id an interface knows through `rootPlaceOf` in `src/memory/store-addresses.ts`, so a read may name any place of a tree. No place stands in as a home: a turn in a direct message reads the servers of its interface, a turn of the persona's own reads every server, and a call written where she cannot write is dropped with the log line `mention: dropped` and the reason `cannot-send`. An `emoji.list` read with `placeId` null asks for what the interface offers outside any tree, which on Discord is the emoji of every server it serves. The avatar scan covers every served place, and `reaction.changed` keeps the reactions of any place an interface serves. The read `dmChatOf`, on the wire `dm.chat`, answers the private chat with an account as an opaque id, opening it on the platform when it does not exist and sending no message. Discord does this with `users.createDM`. The core asks it only for a DM whose place holds no address, since a message of a DM stores the chat id it came from on its place (see [memory](memory.md)). `answer` in `src/interface/reads.ts` runs any read and keeps its status and code for a caller that acts on why it came to nothing, where the plain reads answer null.

Account linking is performed by the owner's [memory commands](memory.md#one-person-several-accounts). An interface must not infer that matching names or native IDs on another platform refer to the same person.

Delivery reports distinguish success, failure and unknown outcome. Preserve the idempotency key across split messages. After a connection loss, an uncertain delivery must not become an unconditional retry days later.

The selfreflection's publisher passes `idempotencyKey` on each send and keeps it stable on a retry. When a platform can find a send by its key, declare `capabilities().reconcile` and have `fetchMessages(chat, ids, { idempotencyKey })` answer the messages posted under it. An `ok` answer with no message is a claim that the send did not happen, and the publisher then sends again. An adapter that cannot know, such as one asked about a key from before its restart, answers a failed read, which leaves the send uncertain. On a platform with no lookup, only the owner's `/mirror reconcile` settles it.

## Media of a message

An interface reports a message's media in its `attachments`, `links`, `stickers` and `emojis`, and `mediaItemsOf` in `src/memory/db/media-store.ts` turns them into items of the closed kinds, in that order. An item's `id` is kept as its `native_ref` and never parsed, so any shape of reference works. A reference must name the same item whenever it comes back, because that is how a message and the describer's cache find one row. A sticker with no `url` is unreadable. A link's `text` is its text form at once, origin `embed`. An attachment's file address is used to read it and never stored.

## Media pick

The media pick is a short classifier call after the persona's reply. It may post one GIF of the shared library in place of a short first message, or put one custom emoji after that message or in its place. The core owns the call, its prompt, its rails and its parse, because an interface never calls a model and the request and daily caps stay in one place. Declare `mediaPick` in `capabilities()` to take part. An interface without it gets nothing: no block in the turn and no call.

`gifForms` lists how the interface posts a library GIF, `file` for the cached file and `link` for the native link. Discord declares both, because it embeds a tenor or giphy link. `gifPostForm` in `src/media/gif-post.ts` takes the link of a link GIF where it is declared and the file of an attached GIF, whose link expires, and an interface that declares `file` alone is offered only GIFs with a cached file.

`emoji` declares custom emoji. `actions` lists `append`, which puts the emoji after the first message, and `replace`, which posts it alone. `render` holds the templates of one emoji, `still` and optionally `animated`, with `{name}` and `{id}`. Discord declares `<:{name}:{id}>` and `<a:{name}:{id}>`. A sticker that needs a file is not a template, and takes a later change of this contract. The inventory is the `emoji.list` read an interface already answers, and the place's counts come from `src/memory/emoji-usage.ts`. `text` is one line the persona's turn reads in `<senses>` while the inventory is not empty, so that an interface says there what she can write herself. It is the interface's own words, because the turn holds no rule of a platform's emoji.

The core searches the library's captions by words and by vector for the reply and the line it answers, and hands at most `media.pick.candidates` GIFs to the classifier with the place's most used emoji, at most `media.pick.emojiCandidates`. One request covers both forms. The prompt is `prompts/media-pick.md`, the answer the JSON object of `mediaPickFormat`, a `pick` of `none`, `gif`, `emoji` or `replace` with the `name` it chose, and `none` is the normal result. The core counts the rails per place in `media.pick.emojiPerReplies` and `media.pick.emojiCooldownMinutes`, and `0` switches one off. A `:name:` the place does not have stays text. A chosen GIF goes through the interface's `send` as a file attachment or as text holding the link. Refuse what the platform cannot post, such as a file past its size limit, with an explicit result: the first message then goes out as written, so the reply is never lost. A chosen emoji goes out in the text of the first message, as the interface rendered it.

## Setup contract

The package's `setup.json` declares a `settings` array. Each setting has `key`, `question`, `kind` and optional `required`. Kinds are `text`, `list` and `secret`.

```json
{
  "settings": [
    { "key": "token", "question": "Platform token", "kind": "secret", "required": true },
    { "key": "servers", "question": "Server IDs", "kind": "list" }
  ]
}
```

The shared setup stores values under `data/interfaces/<name>/`. Secrets go to `credentials.json`; other values go to `config.json`. Technical state belongs in that directory too. Disabling the package preserves both its state and the core's memories.

## Phrase codes

A phrase code is six distinct words that prove an account belongs to someone. `createPhraseCodes` in `src/interface/phrase-codes.ts` draws them from a word list with `node:crypto` and keeps only a seal: a random salt and the SHA-256 hash of the six words in list order. A message holds the phrase when all six words stand in it, in any order and in any grammatical form, and when it holds at most 18 words of the list, so a pasted list fails. Two words match when they share a key: the word itself, its key under the memory's learned stemmer (`loadStemmer` in `src/memory/db/stems.ts`), or the word without one of the stemmer's learned endings. While the memory database is closed only the exact word matches. Six distinct words of a 2048-word list give C(2048, 6), about 2^57 phrases, since the order does not count.

The list is one of two files in `src/mnemonic/`, `bip-en` and `bip-ru`, each with 2048 words, one per line, and no comment. `bip-en` is the English list of BIP-39, published under the MIT License. `bot.mnemonic` picks the file by its language, `en` or `ru`, default `en`, and `wordListOf` reads it at each use. The owner types `/mnemonic` to see the language and `/mnemonic en` or `/mnemonic ru` to switch it, in the chat and as `neptunia -p "/mnemonic ru"`. A member granted `config set` cannot change `bot.mnemonic`, and neither can she.

A switch takes effect for the phrases issued after it. A phrase issued before it holds words of the other list, so it is refused when it is typed and a new one must be asked for. The seals in `pairing-codes.json` stay until their hour ends.

## Pairing the owner's account

On a fresh install only the command line is connected, and its account is the owner's first account under his meta-person, `bot.ownerPerson`. The owner proves his account on any other interface by pairing, after the rules of Hermes's `gateway/pairing.py`. `/interfaces setup <name>` ends, once every required value is stored, by opening pairing on that interface and asking for the phrase in the chat with `labels.pairing.ask`. `/interfaces pair open <name>` opens it later, and `neptunia setup` names that command for each interface it set up, since the core is not running during its questions.

While pairing is open on an interface, an hour from the moment it opened, a direct message to her there from an account that is not the owner's starts no turn. `createOwnerPairing` in `src/interface/owner-pairing.ts` answers it in the same chat with a one-time phrase of six words worded by `labels.pairing.code`, and the line is only observed, so its account is stored. The owner types the six words with `/interfaces pair <phrase>` in any order, or at the setup's question. A phrase whose first word is `open` is shown with that word last, so it never reads as `/interfaces pair open`. The account that asked is then bound to his meta-person by the rules of `/memory bind` (`bindAccount` in `src/memory/db/person-bind.ts`): an account with a meta-person of its own merges into his, and the approval stands for the yes of that merge. An approval closes pairing on its interface and voids its other phrases.

The phrase follows [Phrase codes](#phrase-codes), and `createPairing` in `src/interface/pairing.ts` keeps the limits. A phrase lives one hour, three phrases wait on an interface at most, and an account gets one phrase per ten minutes. Five wrong phrases lock the approvals for an hour. The seals, the open windows and the limits are written to `pairing-codes.json` in the data directory, so a restart neither drops a waiting phrase nor reopens a used one or a lock. Logs say that a phrase was sent and never the phrase. Her own line that carries a phrase is never observed, and `readHistory` in `src/turn/tool-round.ts` leaves it out of the chat a turn reads, so a phrase reaches no request.

Changing the owner's account on an interface is the same pairing. The newly paired account becomes one more child of his meta-person and his account on that interface (`ownerAccountOf` in `src/memory/db/person-links.ts`, the account whose owner link came last), and the earlier account stays his. A command line turn reads a root's channels as the owner's account on that root's interface.

## Clients and principals

The core socket authenticates each client against `clients.json` and its token file. An interface client has kind `interface` and a fixed `iface`. It supplies platform events, not owner administrative commands. CLI and agent clients have separate kinds and permissions.

The token decides what a client may do, and the message fields and the order of connecting add nothing to it. [The link](../src/interface/link.ts) answers `invalid` to an event that names a `cli:` chat unless the client has kind `cli`. While a client serves an interface, `createLinkSwitch` closes the link of another client of the same `iface` and keeps the live one. A reconnect of the same client replaces its own link.

```bash
node scripts/client-token.ts add NAME --kind interface --iface NAME
```

See [setup](setup.md) for where the selected data root is stored. Tokens must be readable by the user running that client.

## Delivery of events

An interface with a data folder keeps each event in its outbox (`src/protocol/outbox.ts`) under the next `seq` until the core acknowledges it, and the Discord session's outbox holds 1000. [The link](../src/interface/link.ts) answers each event with an `ack` whose `ackedSeq` is the highest `seq` up to which the core took every event, and the outbox drops everything at or below it. An event the core answers `failed` holds that watermark back, as a line does whose memory write outlasts `memoryDb.observeTimeoutMs` (default `5000`). `serveAdapter` in `src/protocol/serve.ts` sends such an event again after 5 seconds, and each further `failed` doubles the wait up to 5 minutes, until the core takes it or the link closes. A retry whose first write has landed meanwhile is answered `duplicate`, and the watermark moves past it.

The core's answer to `hello` carries its watermark, and the interface sends every event after it before any new one. A retry and an event left by an earlier connection go marked `replayed`, which the core keeps as history without starting a turn. A full outbox refuses a new event and keeps nothing of it, logs `link: event lost while the outbox is full` and reports `outbox-full` on `status()`.

## Interfaces as units

Run a package through `neptunia interface run <name>` or its `neptunia-interface@<name>.service` unit. The core and the interface must select the same persona root and matching socket credentials. `neptunia interface run cli` exits 2, because the command line runs in the owner's terminal and `neptunia` starts it.

An authored package can live under `data/interfaces/<name>/`; otherwise the loader uses `interfaces/<name>/` from the engine. Personal interface code therefore travels with a whole-persona backup. Package dependencies still need installation on the destination machine.
