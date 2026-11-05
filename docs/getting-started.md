# Getting started

This guide installs one persona on Linux with systemd and connects it to Discord. You need Git, Node.js `>=26.13 <27`, npm, an OpenRouter key and a Discord bot token. Enable Message Content Intent in the Discord Developer Portal. Enable member or presence intents only if your interface settings request them.

## Install

```bash
git clone https://github.com/leinstay/neptunia.git
cd neptunia
npm ci
```

Node runs the TypeScript sources directly. There is no build step. The install includes the Discord and CLI workspace dependencies.

The commands below use `./bin/neptunia.ts` from the checkout. Elsewhere in these guides, `neptunia` means this executable installed on your `PATH`.

## The persona folder

The default persona root is `data/` in the checkout. To use another location, set `NEPTUNIA_DATA_DIR` before running setup, scripts or the CLI. Setup carries that path into its units. Keep the same selection for every command of this installation.

Settings live in `data/config/config.json`. Personal prompt files live in `data/prompts/`. See [the data directory](../data/README.md) for the full layout and [memory](memory.md) for what the database holds. Do not reuse one live persona directory for two cores.

## First run

Run the interactive setup:

```bash
./bin/neptunia.ts setup
```

Choose Discord, enter its bot token and servers, then select the optional services and agent backends you need. Setup sets `interfaces.mode` to `units`, writes the private tokens of the owner CLI and of Discord without printing them, installs user units, and starts Discord and the core. These tokens are separate from your Discord and model credentials. At the end it opens the owner chat with `/keys core add` ready. Add an OpenRouter key there; the dialog checks the selected models before saving it.

Check the installation:

```bash
./bin/neptunia.ts doctor
./bin/neptunia.ts
```

In the chat, `/status` shows the core and its connections. Ordinary text talks to the persona; slash commands administer the installation. A large paste stays one chip with its text whole, and Ctrl+V or `/attach <file>` adds an image. [CLI](cli.md) covers daily use and [setup](setup.md) covers system units, the setup flow and what a chat needs to open.

## Make it your persona

Copy only the prompt files you want to replace into `data/prompts/`, keeping their names. Start with `character-card.md` and `rules.md`. A nonempty personal file replaces its default. The rules are the `- ` bullets under the last `## ` heading of `rules.md`: the file reaches a request whole while it holds a bullet, and adds nothing to a request while it holds none. Settings in `data/config/config.json` merge over the shipped defaults, with arrays replaced whole. Both layers reload while the core runs.

Use [the prompt contract](prompt-contract.md) when editing files with placeholders or output tags. Keep engine defaults unchanged so an engine update does not overwrite your persona.

## When something does not work

Run `neptunia doctor` for local installation checks and `/status` for the core's current view. For a user-unit install:

```bash
systemctl --user status neptunia-core.service neptunia-interface@discord.service
journalctl --user -u neptunia-core.service -n 80
```

A missing socket usually means the core is down or the CLI selected a different data root. A refused client needs a matching entry in `clients.json` and its token file. A connected interface still needs platform permissions for its channels.

`ffmpeg` and `yt-dlp` support the [media](media.md) features. Agent-backed memory and errands need an installed, authenticated [backend](setup.md#subharness-backends). Check those separately from the OpenRouter key.

## The second instance and the fault run

For development, `tests/second-instance.test.ts` exercises isolated personas and `scripts/fault-run.ts --short` exercises event delivery with fake models and interfaces. These are development checks, not instructions to start another bot against your live `data/`. Follow [CONTRIBUTING.md](../CONTRIBUTING.md) for tests and changes.
