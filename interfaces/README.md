# interfaces/

One package per chat platform the engine can talk through. Each package carries its own platform dependency (discord.js, etc.); the engine's core has none.

The core speaks a neutral protocol of events and actions (`src/protocol/`). An interface adapter translates between that protocol and its platform. See [docs/interfaces.md](../docs/interfaces.md) for the full contract.

## discord

Package `@neptunia/interface-discord` (`interfaces/discord/package.json`). Depends on discord.js 14.

Entry point: `index.js`, which exports `start(host)` and `createDiscordInterface({ client })`. The core calls `start(host)`: it builds the discord.js client, logs in, resolves the guild, connects the link, serves the adapter and resolves with a running interface (`iface`, `legacy`, `open()`, `stop()`). Gateway events are held until `open()`. `legacy` lists what the core's subsystems still read from discord.js, and `legacy.serveCommands(admin)` builds the slash command handler over the core's admin. [docs/interfaces.md](../docs/interfaces.md) describes the host and the fields. `createDiscordInterface` returns the outbound port (the persona's effects in Discord), a frozen capabilities object (permission checks, history, the pull rails, searches, the presence snapshot, the emoji index, the member cache warmer, the command tree) and the client itself.

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
| `commands.js` | The slash command tree, registration and interaction handling. |
| `pull-fetch.js` | The rails of a pull of another channel over discord.js objects, for the recall runner. A turn pulls through the reads. |
| `search.js` | Guild message search and member search for recall. |
| `around.js` | Voice and presence state of members, the live snapshot for `<people_now>`. |
| `emoji.js` | The server's custom emoji index. |
| `audience-warm.js` | Fills the member cache for the audience rail. |

## Starting the core with an interface

`startCore` in `src/core.js` takes the interfaces as `{ name, start(host) }` and starts each over the link, so the Discord package and the fake interface (`src/interface/fake-interface.ts`) start the same way. A test passes the fake with a scripted `llm` and an `embedder`, and no platform or provider is reached. [docs/interfaces.md](../docs/interfaces.md) lists the options.
