# interfaces/

One package per chat platform the engine can talk through. Each package carries its own platform dependency (discord.js, etc.); the engine's core has none.

The core speaks a neutral protocol of events and actions (`src/protocol/`). An interface adapter translates between that protocol and its platform. See [docs/interfaces.md](../docs/interfaces.md) for the full contract.

## discord

Package `@neptunia/interface-discord` (`interfaces/discord/package.json`). Depends on discord.js 14.

Entry point: `index.js`, which exports `createDiscordInterface({ client })`. That returns the outbound port (the persona's effects in Discord), a frozen capabilities object (permission checks, history, pulls, searches, reactors, the presence snapshot, the emoji index, the member cache warmer, the command tree) and the client itself.

The modules:

| File | What |
|---|---|
| `port.js` | The Discord adapter of the interface port: send, edit, delete, react, unreact, typing, fetchMessages. Maps discord.js errors to result statuses. |
| `collect.js` | Turns discord.js messages into normalised plain objects. Builds `message.received` and `reaction.changed` protocol events (`toEvent`, `reactionEvent`). History, permission checks, audience. |
| `gateway.js` | Creates the discord.js client with the intents and partials the engine needs. |
| `guild.js` | Resolves which single guild this instance serves. |
| `commands.js` | The slash command tree, registration and interaction handling. |
| `pull-fetch.js` | Fetches another channel's recent messages for the `<channel_view>` prompt block. |
| `search.js` | Guild message search and member search for recall. |
| `reactors.js` | Who reacted to the persona's messages (in-process, never persisted). |
| `around.js` | Voice and presence state of members, the live snapshot for `<people_now>`. |
| `emoji.js` | The server's custom emoji index. |
| `audience-warm.js` | Fills the member cache for the audience rail. |
