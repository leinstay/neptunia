# interfaces/

One package per chat platform the engine can talk through. Each package carries its own platform dependency (discord.js, etc.); the engine's core has none.

The core speaks a neutral protocol of events and actions (`src/protocol/`). An interface adapter translates between that protocol and its platform. See [docs/interfaces.md](../docs/interfaces.md) for the full contract.

## A package

An interface is a folder `interfaces/<name>/` with these files:

| File | What it is |
|---|---|
| `package.json` | The package and its platform dependency, installed into its own `node_modules`. |
| `index.ts` or `index.js` | The entry: it exports `start(host)`, which resolves with a running interface (`src/protocol/host.ts`). |
| `config.json` | The package's own settings, laid over the core's settings and under `data/interfaces/<name>/config.json`. |
| `setup.json` | The settings the interface declares (`src/setup/modules.ts`), asked by `neptunia setup` and `/interfaces <name> setup`. |
| `README.md` | What the interface connects to and how it runs. |

A package imports nothing of the core beyond `src/protocol/`.

## discord

Package `@neptunia/interface-discord` (`interfaces/discord/package.json`). Depends on discord.js 14. Its [README](discord/README.md) says how it runs in each mode.

Entry point: `index.ts`, which exports `start(host)` and `createDiscordInterface({ client })`. The core calls `start(host)`: it builds the discord.js client, logs in, resolves the guild, connects the link, serves the adapter and resolves with a running interface (`iface`, `open()`, `stop()`, `reconnect()`). Gateway events are held until `open()`, and an outbox under the interface's data folder keeps them until the core acknowledges them. On its first connect the session deletes every slash command its bot still has on the guild, and it registers none. [docs/interfaces.md](../docs/interfaces.md) describes the host and the fields. `createDiscordInterface` returns the outbound port (the persona's effects in Discord), a frozen capabilities object (permission checks, history, the pull rails, searches, the presence snapshot, the emoji index, the member cache warmer) and the client itself.

The modules:

| File | What |
|---|---|
| `port.ts` | The Discord adapter of the interface port: send, edit, delete, react, unreact, typing, and the chat reads it takes from `reads.ts`. Maps discord.js errors to result statuses. |
| `reads.ts` | The reads of the adapter over discord.js: the chats of a root with their permissions, audiences and viewers, the history, messages by id, members, search, emoji, links and reactors. |
| `collect.ts` | Turns discord.js messages into normalised plain objects. Builds `message.received` and `reaction.changed` protocol events (`toEvent`, `reactionEvent`). Permission checks, audience. |
| `session.ts` | `start(host)`: the client, the login, the guild, the link and every gateway event as a protocol event, held until `open()`. |
| `members.ts` | A member as the avatar queue sees it (`memberView`, `avatarHashOf`) and the `membership.changed` event. |
| `gateway.ts` | Creates the discord.js client with the intents and partials the engine needs. |
| `pull-fetch.ts` | The rails of a pull of another channel over discord.js objects, for the recall runner. A turn pulls through the reads. |
| `search.ts` | Guild message search and member search for recall. |
| `around.ts` | Voice and presence state of members, the live snapshot for `<people_now>`. |
| `emoji.js` | The server's custom emoji index. |
| `audience-warm.ts` | Fills the member cache for the audience rail. |
| `platform-types.ts` | The parts of the discord.js objects the package reads (message, channel, guild, member, reaction), every field optional. Types only. |
| `values.ts` | The package's copies of the three small helpers that read an unknown value: a thrown error's fields, a record, a scalar as text. |

## cli

Package `@neptunia/cli` (`interfaces/cli/package.json`). Depends on Ink, React, Jimp's format packages and jSquash's WebP decoder. It draws the owner's chat in his terminal, and `neptunia` (`bin/neptunia.ts`) starts it in the terminal's own process, so it has no unit and no `setup.json`, and `neptunia interface run cli` exits 2. Its [README](cli/README.md) names its modules, and [docs/cli.md](../docs/cli.md) describes the chat.

Entry point: `index.ts`, which exports `start(host)` from `link.ts` beside `runInteractive`. `start` takes the host's `connect()` and `token` with what a terminal adds: `print` for her words, `deliver` for her files, `onTurnEvent` and the `transcript` the core's history reads answer from. It says `hello` as `cli` with its names and capabilities and serves the adapter of its one chat, `cli:dm:owner`. The running interface adds the owner's console to `iface`, `open()`, `stop()` and `reconnect()`: `say`, `turn`, `ask` and `showLines`. `open()` releases nothing, because a line goes out only when the owner sends it, and no outbox is kept, because a line the core does not take stays in the input. `reconnect()` opens a new link over `host.connect()` with the same transcript, and `bin/neptunia.ts` calls it every 2 seconds while the link is down. `bin/` imports `link.ts` alone for `-p` and the one-shot commands, so they never load Ink.

## Starting the core with an interface

`startCore` in `src/core.ts` takes the interfaces as `{ name, start(host) }` and starts each over the link, so the Discord package and the fake interface (`src/interface/fake-interface.ts`) start the same way. A test passes the fake with a scripted `llm` and an `embedder`, and no platform or provider is reached. [docs/interfaces.md](../docs/interfaces.md) lists the options.

## Running an interface as a unit

The core starts with no interface, and `neptunia interface run <name>` (`bin/neptunia.ts`) runs one package in a process of its own. It connects with the token of the client `<name>` in `clients.json`, keeps the interface's data under `<data directory>/interfaces/<name>/` and opens the link again with backoff when it drops. `tests/fixtures/interfaces/fake/` is a package the tests run this way with `--interfaces-dir tests/fixtures/interfaces`. [docs/interfaces.md](../docs/interfaces.md#interfaces-as-units) describes the runner, and [deploy/README.md](../deploy/README.md) the units.
