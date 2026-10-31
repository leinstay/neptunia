# Getting started

## Requirements

- **Node.js 26** (the major version is pinned in `package.json` and `.nvmrc`). No build step, no TypeScript.
- **ffmpeg** and **yt-dlp** on PATH, for video descriptions. Without them the persona cannot watch video clips. They are optional: everything else works without them.
- A Discord bot application with the **Message Content** privileged intent enabled.
- An API key from [OpenRouter](https://openrouter.ai/keys) or any compatible endpoint.

## Install

```bash
git clone https://github.com/leinstay/neptunia.git
cd neptunia && npm install
```

## Configuration layers

The engine reads two layers of configuration, both hot-reloaded (edits take effect on the next request, no restart needed):

**Config files.** `config/` holds three tracked files: `config.json` with every setting and its default, `labels.json` with the wording the code inserts into prompts, and `tools.json` with the texts of the persona's tools. `config.local/` (gitignored) holds your deployment's files of the same names, each deep-merged over its tracked file, so a local file holds only the keys you change. You never edit the files in `config/`: put your values in `config.local/config.json`. [docs/configuration.md](configuration.md) lists every setting.

**Prompt files.** `prompts/` holds the tracked engine defaults, including a working example character. `prompts.local/` (gitignored) holds your deployment's overrides. A file in `prompts.local/` replaces the same-named file in `prompts/` entirely.

The merge logic lives in `src/hot.js`. When a file in either layer fails to parse (a half-written JSON save, for instance), the previous good value stays live and the error is logged. On the first startup, a broken file still causes a hard failure.

The one file you must write is `prompts.local/character-card.md`: who the persona is and how it talks. Copy the example from `prompts/character-card.md` and rewrite it. Everything else works with the defaults.

The full contract between prompt files and code (every file, placeholder, label key, context block and output tag) is in [docs/prompt-contract.md](prompt-contract.md).

## Environment keys

Copy `.env.example` to `.env` and fill in the values. The file is read once at startup by a built-in KEY=VALUE parser (no external package). Variables already set in the process environment are never overridden.

| Variable | Required | What it does |
|---|---|---|
| `DISCORD_TOKEN` | yes | The bot token from the Discord Developer Portal |
| `OPENROUTER_CORE_KEY` | yes | The main API key for chat completions (the core and every role that `llm.keyByRole` does not map elsewhere) |
| `OPENROUTER_SIM_KEY` | no | A second key used only by `tools/` scripts (replay, eval, memory session). Without it a tool refuses to run. The bot never spends it |
| `OPENROUTER_MANAGEMENT_KEY` | no | An OpenRouter management key. When set, the status card shows each key's last 7 and 30 days of spending from OpenRouter's own figures. The bot only reads activity with it |
| `OPENROUTER_ERRAND_KEY` | no | The errand agents' own key (mapped via `llm.keyByRole`). The bot never sends its own requests with it |
| `OPENROUTER_DEV_KEY` | no | The development worker's own key (mapped via `llm.keyByRole`) |
| `OPENCODE_WEBSEARCH_KEY` | no | The scout errand agent's web search key |
| `MEDIA_VIDEO_PROXY` | no | A socks5h:// or http:// proxy for video fetches |
| `YOUTUBE_API_KEY` | no | YouTube Data API key, used when yt-dlp is unavailable to learn video duration |
| `BRAVE_SEARCH_API_KEY` | no | Brave Search API key for `features.webLookup` (free tier: 2,000 queries/month) |
| `EXA_API_KEY` | no | Exa API key for the `exa` search engine (`web.search.engine`) |

When `NEPTUNIA_PRIVATE_DIR` is set in the process environment, `.env`, `config.local/` and `prompts.local/` are read from that directory instead of from the checkout root. `NEPTUNIA_DATA_DIR` moves the `data/` directory. Both are described in [docs/configuration.md](configuration.md) and used by the example systemd unit.

## First run

Create `config.local/config.json` with your Discord user ID:

```json
{
  "bot": {
    "owners": ["YOUR_DISCORD_USER_ID"]
  }
}
```

```bash
npm start
```

When `bot.guildId` is empty and the bot is in exactly one server, it locks to that server automatically. If the bot is in several servers, it refuses to start; set `bot.guildId` in `config.local/config.json`.

## Dry run

Set `features.dryRun` to `true` in `config.local/config.json`. The bot runs the full pipeline (memory, triggers, LLM calls) but never sends a message or reaction. Output goes to the log. Set `bot.dryRunChannelId` to a private channel to get a readable mirror of everything the bot would post. Slash commands still work in any channel.

A good first step on a new server: enable dry run, watch the log or the mirror channel, tune the persona live with `/config set` and `/rules add` in the `neptunia` chat, then turn dry run off with `/config set features.dryRun false`.

## Running as a service

An example systemd unit is in `deploy/neptunia-bot.service`. It uses a layout that keeps private files outside the checkout:

```
/opt/neptunia/
  app/    the engine checkout (read-only to the service)
  etc/    .env, config.local/, prompts.local/       (NEPTUNIA_PRIVATE_DIR)
  data/   everything the bot writes                 (NEPTUNIA_DATA_DIR)
```

`deploy/install.sh` creates that layout (the service user, the directories, and the unit) without starting the bot. Run it with `--dry-run` first to see the commands:

```bash
sudo deploy/install.sh --dry-run
sudo deploy/install.sh
```

Fill in `.env` and `config.local/config.json` under the `etc/` directory, then enable the service:

```bash
sudo systemctl enable --now neptunia-bot
```

To update the code:

```bash
git pull && sudo systemctl restart neptunia-bot
```

A restart loses nothing; all state is on disk. Restarts are needed only after changes under `src/`. Prompt and config edits take effect live.

If you want to keep everything in the checkout instead of the separate layout, delete the two `Environment=` lines from the unit and adjust the paths. The comments in the unit file explain how.

## Tests

```bash
npm test
```

Tests run with `node --test`. No network, no Discord connection, no LLM calls needed. The same command runs in CI on every pull request.

## Contributing

Read [CONTRIBUTING.md](../CONTRIBUTING.md) before opening a pull request. Target branch is `main`, one change per PR, tests pass. The engine stays character-neutral: a specific character's behaviour belongs in `prompts.local/`. Security reports go through [SECURITY.md](../SECURITY.md).
