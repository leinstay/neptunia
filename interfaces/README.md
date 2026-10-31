# interfaces/

One package per chat platform the engine can talk through. Each package carries its own platform dependency (discord.js, etc.); the engine's core has none.

The core speaks a neutral protocol of events and actions (`src/protocol/`). An interface adapter translates between that protocol and its platform. See [docs/interfaces.md](../docs/interfaces.md) for the full contract.

## A package

An interface is a folder `interfaces/<name>/` with these files:

| File | What it is |
|---|---|
| `package.json` | The package and its platform dependency, installed into its own `node_modules`. |
| `index.ts` or `index.js` | The entry: it exports `start(host)`, which resolves with a running interface (`src/protocol/host.ts`). |
| `config.json` | The package's own settings, laid over the core's `config.json` and under `config.local.json` when the interface runs as a unit. |
| `setup.ts` | The setup of the interface, run by the `neptunia` CLI. |
| `README.md` | What the interface connects to and how it runs. |

A package imports nothing of the core beyond `src/protocol/`.

## discord

Package `@neptunia/interface-discord` (`interfaces/discord/package.json`). Depends on discord.js 14. Its [README](discord/README.md) says how it runs in each mode.

Entry point: `index.js`, which exports `start(host)` and `createDiscordInterface({ client })`. The core calls `start(host)`: it builds the discord.js client, logs in, resolves the guild, connects the link, serves the adapter and resolves with a running interface (`iface`, `open()`, `stop()`, `reconnect()`). Gateway events are held until `open()`, and an outbox under the interface's data folder keeps them until the core acknowledges them. On its first connect the session deletes every slash command its bot still has on the guild, and it registers none. [docs/interfaces.md](../docs/interfaces.md) describes the host and the fields. `createDiscordInterface` returns the outbound port (the persona's effects in Discord), a frozen capabilities object (permission checks, history, the pull rails, searches, the presence snapshot, the emoji index, the member cache warmer) and the client itself.

The modules:

| File | What |
|---|---|
| `port.js` | The Discord adapter of the interface port: send, edit, delete, react, unreact, typing, and the conversation reads it takes from `reads.ts`. Maps discord.js errors to result statuses. |
| `reads.ts` | The reads of the adapter over discord.js: the conversations of a community with their permissions, audiences and viewers, the history, messages by id, members, search, emoji, links and reactors. |
| `collect.js` | Turns discord.js messages into normalised plain objects. Builds `message.received` and `reaction.changed` protocol events (`toEvent`, `reactionEvent`). Permission checks, audience. |
| `session.ts` | `start(host)`: the client, the login, the guild, the link and every gateway event as a protocol event, held until `open()`. |
| `members.ts` | A member as the avatar queue sees it (`memberView`, `avatarHashOf`) and the `membership.changed` event. |
| `gateway.js` | Creates the discord.js client with the intents and partials the engine needs. |
| `guild.js` | Resolves which single guild this instance serves. |
| `pull-fetch.js` | The rails of a pull of another channel over discord.js objects, for the recall runner. A turn pulls through the reads. |
| `search.js` | Guild message search and member search for recall. |
| `around.js` | Voice and presence state of members, the live snapshot for `<people_now>`. |
| `emoji.js` | The server's custom emoji index. |
| `audience-warm.js` | Fills the member cache for the audience rail. |

## Starting the core with an interface

`startCore` in `src/core.js` takes the interfaces as `{ name, start(host) }` and starts each over the link, so the Discord package and the fake interface (`src/interface/fake-interface.ts`) start the same way. A test passes the fake with a scripted `llm` and an `embedder`, and no platform or provider is reached. [docs/interfaces.md](../docs/interfaces.md) lists the options.

## Running an interface as a unit

With `interfaces.mode: units` the core starts with no interface, and `neptunia interface run <name>` (`bin/neptunia.ts`) runs one package in a process of its own. It connects with the token of the client `<name>` in `clients.json`, keeps the interface's data under `<data directory>/interfaces/<name>/` and opens the link again with backoff when it drops. `tests/fixtures/interfaces/fake/` is a package the tests run this way with `--interfaces-dir tests/fixtures/interfaces`. [docs/interfaces.md](../docs/interfaces.md#interfaces-as-units) describes the runner, and [deploy/README.md](../deploy/README.md) the units.
