# Getting started

How to take a clone of the engine to a running persona, and how to work with it afterwards. It is for the person who installs and runs a deployment. [Setup](setup.md) describes the install command, [The neptunia command](cli.md) the chat, and [Configuration](configuration.md) every setting.

## Requirements

Node.js `>=26.13 <27` (the `engines` field of `package.json`, and `.nvmrc` names 26). Node runs the TypeScript sources by stripping their types, so there is no build step.

`ffmpeg` on `PATH` turns her voice messages into the platform's format and cuts the clips she watches, and `yt-dlp` fetches video from video sites. Without them those abilities are off and nothing else is. `neptunia doctor` checks for `ffmpeg` only.

A Discord application with a bot user and the Message Content privileged intent switched on. The Presence and Server Members intents are needed only when `discord.intents.presences` or `discord.intents.members` is `true` in the interface's settings (both default to `false`).

An OpenRouter key. `llm.baseUrl` holds the endpoint, `https://openrouter.ai/api/v1` by default.

A Linux machine with systemd, for the units that setup writes.

## Install

```bash
git clone https://github.com/leinstay/neptunia.git
cd neptunia
npm install
```

`npm install` also installs the workspaces `interfaces/discord` (discord.js) and `cli` (Ink and React, which draw the chat). `bin/neptunia.ts` is executable and starts with a Node shebang, so `./bin/neptunia.ts` runs it. This documentation writes `neptunia` for that file. The core unit runs `node src/index.ts`, and the agent, interface, watcher and selfimprovement units run `node bin/neptunia.ts <command>`.

## The persona folder

Everything that makes one persona sits in one folder: `data/` of the checkout, or the folder that `NEPTUNIA_DATA_DIR` names (a relative path resolves against the checkout). Git ignores the folder except `data/README.md`, so no pull request carries a persona. Copying the folder while the engine is stopped moves the persona to another installation of a compatible engine.

| Path | What it holds |
|---|---|
| `config/` | `config.json`, `labels.json` and `tools.json`, the personal layer over the files of the same names in the checkout's `config/` |
| `prompts/` | personal prompt files, each replacing the checkout's file of the same name, and `prompts/preambles/` |
| `keys.json` | model keys, service keys and the subharness state, mode `0600` (see [Keys](keys.md)) |
| `clients.json`, `clients/` | the clients of the core's socket and their token files |
| `interfaces/<name>/` | the settings, credentials and state of one interface |
| `skills/<name>/` | authored skills, their scripts and their state |
| `agents/<name>/` | personal fields of an agent, and the watcher's reports |
| `subharness/<backend>/` | the install, login and sessions of one agent backend |
| `memory.db`, `media/` | her memory, and the media kept for the diary |
| `cli/` | the chat's command history and an optional `picture.txt` |
| `run/core.sock` | the core's socket |

`NEPTUNIA_PRIVATE_DIR` is a legacy alias of the same folder. A value that names another path stops every `neptunia` command with `NEPTUNIA_PRIVATE_DIR must match NEPTUNIA_DATA_DIR`. The core, setup and `neptunia doctor` also refuse a folder or a checkout that still holds `config.local`, `config.local.json`, `prompts.local` or `skills.local`, with a message that names the path. [Persona file migration](persona-migration.md) moves such a layout into `data/`. Set both variables in the process environment, as the units do.

## Settings and prompts

The checkout ships the defaults: `config/config.json` with every setting, `config/labels.json` with the wording code inserts into prompts, `config/tools.json` with the texts of her tools, and `prompts/`. The persona folder overrides them, and nobody edits the shipped files.

`data/config/config.json` is deep-merged over `config/config.json`. Objects merge key by key, and an array or a scalar replaces the default whole, so the file holds only the keys you change. The chat writes it (`/config set`, `/model set`) and so does setup. `data/config/labels.json` and `data/config/tools.json` merge the same way. A file `data/prompts/<name>.md` replaces `prompts/<name>.md` whole once it holds text, and an empty file leaves the default in force.

`createHot` (`src/hot.ts`) watches both layers while the core runs, and code reads settings and prompts at the moment it uses them, so an edit applies to the next request without a restart. A file that fails to parse keeps the previous good value live and logs the error. A broken settings file at startup stops the core.

The one file you write is `data/prompts/character-card.md`: who the persona is and how she talks. Copy the example `prompts/character-card.md` and rewrite it in whatever language she speaks. The core refuses to start without the prompt files `system-prompt`, `character-card`, `format`, `reply`, `interject` and `initiate` and without the labels, and the checkout ships all of them. [Prompt contract](prompt-contract.md) lists every prompt file, placeholder, label and output tag.

## First run

Setup writes the persona folder, the key store and the units, and starts the core. Three things stay with you: the settings the core needs when interfaces run as units, the client tokens, and the start of the interface unit. The first run therefore goes in this order.

1. Make the folder with `neptunia setup folders`. `scripts/client-token.ts` refuses a folder that does not exist.

2. Write the settings the core needs into `data/config/config.json`:

   ```json
   {
     "interfaces": { "mode": "units" },
     "bot": {
       "guildId": "<your Discord server id>",
       "owners": ["<your Discord user id>"]
     }
   }
   ```

   `interfaces.mode` defaults to `inprocess`, which starts Discord inside the core with a boot token that the core accepts only while `clients.json` does not exist. The chat needs `clients.json`, so a deployment with a chat runs `units`: the core starts no interface, and each interface runs as a unit of its own. In that mode the core refuses to start without `bot.guildId`. `bot.owners` lists the Discord user ids that count as owners when someone asks her to run an operation. The chat itself needs no entry, because it always runs as the owner.

3. Make the client tokens for the chat and for Discord:

   ```bash
   node scripts/client-token.ts add cli --kind cli
   node scripts/client-token.ts add discord --kind interface --iface discord
   ```

   Each command writes `clients/<name>.token` at mode `0600` and the client's entry in `clients.json`, and prints the file's name, never the token.

4. Run `neptunia setup` at a terminal. It asks whether to set up Discord and then for its token and servers, and it asks for an optional YouTube key, the agent backends, her self-development repository, her mechanics and the watcher. It then writes the units, turns on linger and starts `neptunia-core.service`. Without a terminal it skips the questions. [Setup](setup.md) lists the steps.

5. Setup ends by opening the chat with `/keys core add` typed. Name the key (`core-1`), paste the value (nothing is shown), accept or change the four models it offers, and answer the grant question. The key is saved only when every one of the four models answers. If setup did not ask about Discord, run `/interface token set discord` and `/interface enable discord`.

6. Start the interface unit. Setup starts only the core:

   ```bash
   systemctl --user enable --now neptunia-interface@discord.service
   ```

   After a `--system` install the same command runs through `sudo` without `--user`.

7. Check the result with `neptunia doctor` and `/status`.

## Daily use

`neptunia` opens the chat and `neptunia -p "<command>"` runs one command for a script. `neptunia doctor` checks the installation with the core up or down. Prompt and settings edits take effect live.

To update the code, pull, install and restart the units that run it:

```bash
git pull && npm install
systemctl --user restart neptunia-core.service neptunia-interface@discord.service
```

A restart loses nothing, because her state is in `data/`. `/logs` and `neptunia service` call `journalctl -u` and `systemctl` without `--user`, so they address system units. After a user install, read the journal and restart with the `--user` forms.

## Tests

```bash
npm test
```

The suite runs with `node --test`, needs no network, no Discord connection and no model call, and runs in CI on every pull request. Set `TMPDIR` to a scratch folder first. During development run only the file of the module you changed: `node --test --test-reporter=dot tests/<module>.test.ts`.

### The second instance and the fault run

Two checks prove facts about the engine as a whole. `tests/second-instance.test.ts` copies the tracked tree twice (`git ls-files`) into a temporary folder and starts each copy as a child process (`tests/fixtures/instance-runner.ts`). Each instance has its own persona folder, socket, scripted model and fake interface, and one message goes through each. The test compares the files each instance created, the sockets and open files of each process (read from `/proc`), the rows of the two `memory.db` files and the prompt each model request carried. It fails when anything of one instance shows up in the other or in the checkout, and when a process does not end after `stop` or leaves a socket or a writer lock.

`scripts/fault-run.ts` counts every side effect of a run under an effect key. A key names one thing that must happen once:

- `send:<conversation>:<text>` for a message that reaches the interface
- `react:<conversation>/<message>/<emoji>` for a reaction
- `wake:<fixture>:<wake id>` for a wake a simulated week ran
- `errand:<fixture>:<task>` for an errand end
- `delivery:<key>` for the post a wake left, and `board:<title>` for a task on the board

The run passes when no key repeats and every expected effect happened once. It drives the real core (`startCore`) over a scripted model and the fake interface through these cases:

- one event id delivered at once, in sequence, after a reconnect and while the link is down
- an edit and a delete of one message that reach the core while its turn waits on the model
- a reaction cut off by `tools.callTimeoutMs`
- a core stopped mid-turn

It also plays the week fixtures of `scripts/fixtures/` over a fake clock, among them `hour-errand`, whose errand runs for an hour. The core's services read the wall clock, so the live-core scenarios run in real time and only the weeks use the fake clock. The scripted model follows the directive `do:<verb>:<word>` in the newest chat line or in the intention a wake says is due.

```bash
node scripts/fault-run.ts          # the long run: 10 rounds, 50 deliveries per repeated event, every week
node scripts/fault-run.ts --short  # the plan of tests/fault-run.test.ts: 1 round, 5 deliveries, four weeks
node scripts/fault-run.ts --rounds 3 --repeats 20 --weeks restart,promises
```

The table lists each scenario with its effect count, the keys that repeated and the expected keys that did not happen once. The exit code is 1 when either column holds a key.

## Contributing

Read [CONTRIBUTING.md](../CONTRIBUTING.md) before opening a pull request. The target branch is `main`, one change goes in one pull request, and the tests pass. The engine stays character-neutral, so a character's behaviour belongs in `data/prompts/`. Security reports go through [SECURITY.md](../SECURITY.md).
