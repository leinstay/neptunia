# Interfaces

An interface connects a platform to the persona. It translates platform messages into protocol events and executes the actions the core returns. Discord is the shipped implementation; another platform uses the same contract.

## Package contract

Start with [InterfaceHost](../src/protocol/host.ts), [events](../src/protocol/events.ts) and the [adapter types](../src/protocol/adapter.ts). A package exports `start(host)` and returns a `RunningInterface` with `iface`, `open()` and `stop()`. It may provide `reconnect()`.

The host supplies a connection, client token, live settings, logger and a directory for interface state. `open()` releases incoming events after the core has installed its handlers. Declare capabilities such as history, reactions, attachments and search honestly; unsupported operations return an explicit result.

Keep platform SDK imports in the interface package. The interface imports only the shared protocol from the engine. It never opens `memory.db`. Use [the fake interface package](../tests/fixtures/interfaces/fake/) for a small executable reference, and [Discord](../interfaces/discord/) for a full implementation.

## Identity and audience

Every account and conversation belongs to an interface namespace. Preserve native IDs as identifiers, not display names. Supply community, conversation, author, timestamps and visibility information in the event shape. A direct conversation is private even when its participant also belongs to a server.

[Neutral addresses](../src/protocol/identity.ts) name a place and an account by the interface, the authority inside it and the native id, with a generation for an account. `conversationKey` and `accountKey` serialize them as a tuple, so no character inside a native id can forge another address. A conversation may declare `authorityId` when one interface serves several tenants, and an event without it is addressed under `nativeAuthorityOf(iface)`.

A conversation declares what contains it with `parentId` and `parentKind`, of any kind and at any depth, and `validateEvent` refuses a `parentKind` or an `authorityId` that is not a nonempty string. The place key is `<parentKind>:<parentId>`, and a thread with no declared kind sits in `channel:<parentId>`. Containment is apart from `kind`: the Discord adapter declares a channel's category as a parent of kind `category`, and that channel stays a channel. Discord's objects end inside `interfaces/discord/collect.ts`.

A community id is native to its interface, so two interfaces may name the same one. [Community routes](../src/core-routing.ts) keep each interface's communities as its `hello` declares them. A read inside an event or a turn goes to that event's interface when it serves the community, and any other read goes to the first interface serving it whose link is up. Hello order, a reconnect and another interface's disconnect leave a route in place. The core holds a community by its canonical place; `src/interface/reads.ts` asks the interface by the native id, and answers a read that names a DM or the persona with null without asking.

A direct message needs no community and never borrows one. The private gate in `src/pipeline/private-gate.ts` takes the author and the interface: the owner passes without a stored profile, a person with a profile passes on its score, and with communities served on that interface a stranger must be a member of one. A queued message gets the same answer when `src/pipeline/drain.ts` takes it. The core starts with no community at all, and the interface's own settings name the servers it serves (`servers` in `interfaces/discord/config.json`).

Inside the core every conversation is a place, and every function takes one `placeId`: a server, a channel, a thread, a group or a direct message. An account is an `accountId`. A conversation's native `id` and `rootId`, the native id of the top of its tree, stay at the protocol, and [the reads](../src/interface/reads.ts) turn a place back into the native id an interface knows through `rootPlaceOf` in `src/memory/store-addresses.ts`, so a read may name any place of a tree. No place stands in as a home: a turn in a direct message reads the servers of its interface, a turn of the persona's own reads every server, and a call written where she cannot write is dropped with the log line `mention: dropped` and the reason `cannot-send`. An `emoji.list` read with `placeId` null asks for what the interface offers outside any tree, which on Discord is the emoji of every server it serves. The avatar scan covers every served place, and `reaction.changed` keeps the reactions of any place an interface serves.

Account linking is performed by the owner's [memory commands](memory.md#one-person-several-accounts). An interface must not infer that matching names or native IDs on another platform refer to the same person.

Delivery reports distinguish success, failure and unknown outcome. Preserve the idempotency key across split messages. After a connection loss, an uncertain delivery must not become an unconditional retry days later.

The diary's publisher passes `idempotencyKey` on each send and keeps it stable on a retry. When a platform can find a send by its key, declare `capabilities().reconcile` and have `fetchMessages(conversation, ids, { idempotencyKey })` answer the messages posted under it. An `ok` answer with no message is a claim that the send did not happen, and the publisher then sends again. An adapter that cannot know, such as one asked about a key from before its restart, answers a failed read, which leaves the send uncertain. On a platform with no lookup, only the owner's `/mirror reconcile` settles it.

## Media pick

The media pick is a short classifier call after the persona's reply. It may post one GIF of the shared library in place of a short first message. The core owns the call, because an interface never calls a model and the request and daily caps stay in one place. Declare `mediaPick` in `capabilities()` to take part. An interface without it gets nothing: no block in the turn and no call.

`gifForms` lists how the interface posts a library GIF, `file` for the cached file and `link` for the native link. Discord declares both, because it embeds a tenor or giphy link. `gifPostForm` in `src/media/gif-post.ts` takes the link of a link GIF where it is declared and the file of an attached GIF, whose link expires, and an interface that declares `file` alone is offered only GIFs with a cached file.

The core searches the library's captions by words and by vector for the reply and the line it answers, and hands at most `media.pick.candidates` GIFs to the classifier. The prompt is `prompts/media-pick.md`, the answer `none` or `gif <handle>`, and `none` is the normal result. A chosen GIF goes through the interface's `send` as a file attachment or as text holding the link. Refuse what the platform cannot post, such as a file past its size limit, with an explicit result: the first message then goes out as written, so the reply is never lost.

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

## Clients and principals

The core socket authenticates each client against `clients.json` and its token file. An interface client has kind `interface` and a fixed `iface`. It supplies platform events, not owner administrative commands. CLI and agent clients have separate kinds and permissions.

The token decides what a client may do, and the message fields and the order of connecting add nothing to it. [The link](../src/interface/link.ts) answers `invalid` to an event that names a `cli:` conversation unless the client has kind `cli`. While a client serves an interface, `createLinkSwitch` closes the link of another client of the same `iface` and keeps the live one. A reconnect of the same client replaces its own link.

```bash
node scripts/client-token.ts add NAME --kind interface --iface NAME
```

See [setup](setup.md) for where the selected data root is stored. Tokens must be readable by the user running that client.

## Interfaces as units

With `interfaces.mode` set to `units`, run a package through `neptunia interface run <name>` or its `neptunia-interface@<name>.service` unit. The core and the interface must select the same persona root and matching socket credentials.

An authored package can live under `data/interfaces/<name>/`; otherwise the loader uses `interfaces/<name>/` from the engine. Personal interface code therefore travels with a whole-persona backup. Package dependencies still need installation on the destination machine.
