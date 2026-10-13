# Commands

Channels, roles and users are picked from Discord's own pickers; `set`/`unset` autocomplete `path`, `access grant`/`access revoke` autocomplete `command`, `model set` autocompletes `id` (the model ids in use), `route set`/`route remove` autocomplete `model`, and `memory restore` autocompletes `id` (the newest archive entries).

`/nep` is visible to every member from the start; access is gated per operation at the moment a command runs, never through Discord's own command visibility. Each command runs one named operation, and reading and changing are separate operations: `/nep memory show` runs `memory.profile.read`, `/nep memory affinity <user>` runs `memory.affinity.read`, and `/nep memory affinity <user> <score>` runs `memory.affinity.set`. Owners (`bot.owners`) can always run everything. Everyone else needs a grant on the exact operation: `/nep access grant <operation> [role] [user]` opens one operation (e.g. `memory.profile.read`) to everyone (no role/user given), a role, or a user. A group (e.g. `memory`) or `*` is accepted too, but it is stored as the read operations that exist at that moment, one grant each: it never opens a write, and an operation added later stays closed until it is granted by name. `/nep access revoke` removes the target from the operation, or from every stored operation under a group or `*`; `/nep access list` shows each operation with who holds it and, for a grant that came from a group or `*`, where it came from. Without a grant, a non-owner gets an ephemeral "Not allowed" reply. Owner-only operations (`access.*`, `diary.*`, `memory.private.*`, `memory.journal.read`, `memory.snapshot`, `memory.forget`, `memory.wipe`, `memory.archive.read`, `memory.restore`) are never opened by any grant, `*` included.

**After the deploy that keyed access by operation.** On the first start, every stored grant is converted once: an old command key becomes the operation it ran; an old group or `*` becomes the read operations it covered; owner-only operations are dropped. A journal `system` record `access-migrated` lists what each old grant covers now. Then run `/nep access revoke * everyone` followed by `/nep access grant memory.profile.read everyone`, and re-grant any other operation by name (check `/nep access list`).

The table below is generated from the command table (`src/discord/commands.js#COMMAND_TABLE`): each command, the operation it runs, how it answers (ephemeral, or visible to the channel; deferred when the operation may outlast Discord's three-second reply window) and its description. An interaction Discord delivers twice runs once.

| Command | Operation | Reply | What it does |
|---|---|---|---|
| `/nep status [detail]` | `status.show` | ephemeral | What the bot is doing now: one card |
| `/nep set <path> <value>` | `config.set` | ephemeral | Override a config value in config.local.json; `path` autocompletes |
| `/nep unset <path>` | `config.unset` | ephemeral | Remove a config override; `path` autocompletes |
| `/nep pause` | `bot.pause` | ephemeral, deferred | Pause the persona and flush memory so data/ can be hand-edited |
| `/nep resume` | `bot.resume` | ephemeral, deferred | Resume after a pause; refused if a data/ file is invalid |
| `/nep draw <text> [self]` | `draw.create` | visible, deferred | Draw one picture in this channel. Spends balance |
| `/nep talk <action:interject\|initiate> [channel]` | `talk.interject`, `talk.initiate` | visible, deferred | Make the persona speak now |
| `/nep media <kind:emoji\|gifs> <action:status\|rescan\|recache>` | `media.status`, `media.rescan`, `media.recache` | ephemeral, deferred for `media.rescan` | The custom emoji ranking and the GIF library |
| `/nep model show` | `model.show` | ephemeral | Show the model of each role |
| `/nep model set <role:voice\|analyzer\|classifier.text\|classifier.media\|classifier.video\|mentor\|image> <id>` | `model.set` | ephemeral | Set the model for one role; `id` autocompletes |
| `/nep route list` | `route.list` | ephemeral | Every route, then each role's current model and route |
| `/nep route set <model> <providers> [role:voice\|analyzer\|classifier.text\|classifier.media\|classifier.video\|mentor\|image] [fallbacks]` | `route.set` | ephemeral | Route a model prefix, for one role or any, to these providers only; `model` autocompletes |
| `/nep route remove <model> [role:voice\|analyzer\|classifier.text\|classifier.media\|classifier.video\|mentor\|image]` | `route.remove` | ephemeral | Remove a model prefix's route, for one role or any; `model` autocompletes |
| `/nep rule add <text>` | `rule.add` | ephemeral | Append a rule |
| `/nep rule list` | `rule.list` | ephemeral | List the rules, numbered |
| `/nep rule remove <number>` | `rule.remove` | ephemeral | Remove a rule by number |
| `/nep access grant <command> [role] [user]` | `access.grant` | ephemeral | Open an operation, group or * to everyone, a role or a user; `command` autocompletes |
| `/nep access revoke <command> [role] [user]` | `access.revoke` | ephemeral | Revoke an operation, group or * from everyone, a role or a user; `command` autocompletes |
| `/nep access list` | `access.list` | ephemeral | List every access grant |
| `/nep warmup run` | `warmup.run` | ephemeral, deferred | Start or resume the run: channels, people, then server |
| `/nep warmup users [user]` | `warmup.users` | ephemeral, deferred | (Re)profile one member now, or all qualifying ones in the background |
| `/nep warmup channels [channel]` | `warmup.channels` | ephemeral, deferred | (Re)describe one channel now, or all readable ones in the background |
| `/nep warmup server` | `warmup.server` | ephemeral, deferred | (Re)build the server-wide notes and lore now |
| `/nep warmup people` | `warmup.people` | ephemeral, deferred | Who qualifies for the sample now |
| `/nep warmup status` | `warmup.status` | ephemeral, deferred | Phase, progress, tokens used and the next target |
| `/nep warmup stop` | `warmup.stop` | ephemeral, deferred | Cancel warmup work in flight, the current model call included |
| `/nep warmup reset` | `warmup.reset` | ephemeral, deferred | Clear warmup progress, never written memory; refused while running |
| `/nep diary set <channel>` | `diary.set` | ephemeral, deferred | Set the diary channel |
| `/nep diary show` | `diary.show` | ephemeral | Diary state today |
| `/nep diary off` | `diary.off` | ephemeral | Stop the diary |
| `/nep diary post [kind] [topic]` | `diary.post` | visible, deferred | Post one entry now |
| `/nep alias add <user> <name>` | `alias.add` | ephemeral | Add or strengthen a member's alias |
| `/nep alias remove <user> <name>` | `alias.remove` | ephemeral | Remove a member's alias |
| `/nep learning add <text>` | `learning.add` | ephemeral | Add or strengthen a learned item |
| `/nep learning remove <number>` | `learning.remove` | ephemeral | Delete a learned item |
| `/nep lore add <title> <keys> <text> [always]` | `lore.add` | ephemeral | Add or overwrite an entry (it becomes an owner entry) |
| `/nep lore list [query]` | `lore.list` | ephemeral | List entries, optionally filtered |
| `/nep lore show <id>` | `lore.show` | ephemeral | Show one entry in full |
| `/nep lore remove <id>` | `lore.remove` | ephemeral | Delete one entry |
| `/nep memory show <user> [section:summary\|character\|style\|relationship\|affinity\|aliases\|interests\|details\|episodes\|raw] [limit] [order:rank\|recent]` | `memory.profile.read` | ephemeral | Show a member's stored profile |
| `/nep memory channel [channel]` | `memory.channel.read` | ephemeral | Show a channel's note, or a table of all stored channels |
| `/nep memory server` | `memory.server.read` | ephemeral | Show server notes: patterns, starters, in-jokes, self facts |
| `/nep memory recent` | `memory.recent.read` | ephemeral | Show the live recent lines, newest first |
| `/nep memory refresh <user>` | `memory.refresh` | ephemeral, deferred | Rewrite a member's portrait now, ignoring the refresh-hours rail |
| `/nep memory forget <user>` | `memory.forget` | ephemeral, deferred | Delete a member's profile and private memory |
| `/nep memory affinity <user> [score] [reason]` | `memory.affinity.read`, `memory.affinity.set` | ephemeral | Show or set a member's attitude score |
| `/nep memory wipe <confirm>` | `memory.wipe` | ephemeral, deferred | Delete ALL server memory (profiles, private memory, habits, channels, lore) |
| `/nep memory journal [day] [kind:turn\|action\|memory\|system\|all] [n]` | `memory.journal.read` | ephemeral | Journal records |
| `/nep memory archive [user] [kind] [n]` | `memory.archive.read` | ephemeral, deferred | Archived items |
| `/nep memory restore <id>` | `memory.restore` | ephemeral, deferred | Restore an archived item; `id` autocompletes |
| `/nep memory snapshot` | `memory.snapshot` | ephemeral, deferred | Snapshot data/ for the tools |
| `/nep memory private <action:show\|forget\|purge> <user>` | `memory.private.read`, `memory.private.forget`, `memory.private.purge` | ephemeral, deferred for `memory.private.forget`, `memory.private.purge` | A member's private memory: what they said in DMs |

## Member commands

`/nep pings` is the one command every server member may run without a `bot.access` grant. `features.memberCommands: false` restricts it to owners.

| Command | What it does |
|---|---|
| `/nep pings [mode]` | Show or change whether the persona's messages notify you. Without `mode`: your current setting. `on` / `off`: set the preference. When off, replies to your messages carry no reply ping and @mentions of you in the persona's text still render but send no notification. The wording is the same either way. Ephemeral reply: `Pings: on` or `Pings: off`. Stored per server, survives restarts, cleared by `/nep memory wipe` |
