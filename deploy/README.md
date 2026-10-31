# Deployment

The systemd units of the engine and the script that installs them. `deploy/install.sh` sets up the layout under one root (`/opt/neptunia/app`, `etc` and `data`), creates the service user and installs every unit below without starting or enabling any. Its header lists the steps and the options, and `--dry-run` prints them.

| Unit | What it runs |
|---|---|
| `neptunia-bot.service` | The core with the Discord interface in its process (`interfaces.mode: inprocess`). |
| `neptunia-core.service` | The core with no interface of its own (`interfaces.mode: units`). It conflicts with `neptunia-bot.service`. |
| `neptunia-interface@.service` | One interface, `neptunia interface run %i`, as the user `neptunia-%i-interface`. |
| `neptunia-agent-scout.service`, `neptunia-agent-server.service` | The errand agents, `neptunia errand-runner --profile <name>`. Their headers say how to install them. |

## Running the interfaces as units

In this mode the core and each interface are separate processes under separate users. The core holds the memory and the keys. The interface holds the platform client, its client token and its outbox. They meet at `<data>/run/core.sock`, which the core creates at mode `0660` in a folder at `0750`, both in the group `neptunia`. A client is let in by its token alone. [docs/interfaces.md](../docs/interfaces.md#interfaces-as-units) describes the runner.

The core runs as the service user of `install.sh` (`--user`, default `neptunia-bot`), the same user `neptunia-bot.service` runs as, so the data directory keeps its owner. The interface's user must be another one, because it must not read the memory.

The owner commands (`/nep`) keep working: the Discord unit sends each one to the core as a `command.requested` event, and the core runs it when the client `discord` has the permission `commands`. The owner's chat, `neptunia`, is the client `cli` (see [docs/cli.md](../docs/cli.md)).

### Preparing the server

Every step is done once, as root, with the paths of the default layout.

1. Create the shared group and put the core's user in it: `groupadd --system neptunia` and `usermod -aG neptunia neptunia-bot`.
2. Create the interface's user in that group: `useradd --system --no-create-home --shell /usr/sbin/nologin --gid neptunia neptunia-discord-interface`.
3. Let the group pass through the data directory without reading it, and give the interface its own folder:
   ```bash
   chgrp neptunia /opt/neptunia/data && chmod 0710 /opt/neptunia/data
   install -d -o neptunia-bot -g neptunia -m 0710 /opt/neptunia/data/interfaces
   install -d -o neptunia-discord-interface -g neptunia -m 0700 /opt/neptunia/data/interfaces/discord
   ```
4. Make the client and its token. The core reads `clients.json` and every token file at each envelope, and the interface reads its own token, so the token belongs to the interface's user and the core's group:
   ```bash
   NEPTUNIA_PRIVATE_DIR=/opt/neptunia/etc node tools/client-token.mjs add discord --kind interface --iface discord --permission commands
   chown neptunia-bot /opt/neptunia/etc/clients.json
   chmod 0711 /opt/neptunia/etc/clients
   chown neptunia-discord-interface:neptunia-bot /opt/neptunia/etc/clients/discord.token
   chmod 0640 /opt/neptunia/etc/clients/discord.token
   ```
   While `clients.json` exists the core lets in only the clients it names, and the boot token of an in-process interface counts for nothing. Without `--permission commands` the core refuses every `/nep` of the unit.
5. Make the owner's client the same way, its token readable by the owner's user and the core's group, and put the owner's user in the group `neptunia` (`usermod -aG neptunia <owner>`) so it reaches the socket:
   ```bash
   NEPTUNIA_PRIVATE_DIR=/opt/neptunia/etc node tools/client-token.mjs add cli --kind cli
   chown <owner>:neptunia-bot /opt/neptunia/etc/clients/cli.token
   chmod 0640 /opt/neptunia/etc/clients/cli.token
   ```
6. Move the platform token out of the core's `.env` into the interface's environment file, `/opt/neptunia/etc/clients/discord.env`, as `DISCORD_TOKEN=...`, owned by root at mode `0600`. systemd reads it before it drops to the interface's user.
7. Let the interface read the settings: `chgrp neptunia /opt/neptunia/etc/config.local /opt/neptunia/etc/config.local/config.json && chmod 0750 /opt/neptunia/etc/config.local && chmod 0640 /opt/neptunia/etc/config.local/config.json`. Without this it runs on `config/config.json` alone, with no `bot.guildId` and the default intents. Settings for this interface only go into `config.local/interfaces/discord.json`, which `neptunia interface run discord` lays over the others, readable by the same group.
8. Set `"interfaces": { "mode": "units" }` and a non-empty `bot.guildId` in `config.local/config.json`. `neptunia-bot.service` reads the mode too, so from here on it starts a core with no interface.

### The cutover

1. Stop the in-process core: `systemctl disable --now neptunia-bot`.
2. Start the core: `systemctl enable --now neptunia-core`. `journalctl -u neptunia-core` shows `index: ready`. A start refused with `locked` or `core-running` means another core still runs over the data: find it and stop it.
3. Start the interface: `systemctl enable --now neptunia-interface@discord`. The core's log shows `link: hello` with the principal `discord`.
4. Check from the owner's shell in `/opt/neptunia/app`: `NEPTUNIA_PRIVATE_DIR=/opt/neptunia/etc NEPTUNIA_DATA_DIR=/opt/neptunia/data node bin/neptunia.ts -p "/interface list"` names `discord` as connected, and `/nep status` in Discord answers.

One core runs at a time. `neptunia-core.service` conflicts with `neptunia-bot.service`, so starting one stops the other. The core also refuses to start while a live process holds the memory database's lock or another core renewed `core:alive` within its ttl. After a crash the lock names a process that is gone, so the next start goes ahead at once.

### Going back

1. Stop both: `systemctl disable --now neptunia-interface@discord neptunia-core`.
2. Set `interfaces.mode` back to `inprocess`, put `DISCORD_TOKEN` back into the core's `.env`, remove the client with `node tools/client-token.mjs revoke discord`, and delete `/opt/neptunia/etc/clients.json` when no client is left in it, so the boot token of the in-process interface counts again.
3. Start the in-process core: `systemctl enable --now neptunia-bot`.

The errand units run `neptunia errand-runner` in both modes.
