# Commands

One slash command, `/nep` (the name is `bot.commandName`), with the top-level entries listed below. Every reply is ephemeral (only the caller sees it). The command name must be lowercase `a-z 0-9 _ -`, at most 32 characters; it re-registers when changed.

## Access

`/nep` is visible to every member. Access is gated per operation at the moment a command runs, not through Discord's visibility.

Owners (`bot.owners`) can always run everything. Everyone else needs a grant on the exact operation.

`/nep access grant <operation> [role] [user]` opens one operation to everyone (no role or user given), to a role, or to a user. A group name (e.g. `memory`) or `*` stores the individual read operations that exist at that moment, one entry each: it never opens a write, and an operation added later stays closed until granted by name. `/nep access revoke` removes the target from one operation, or from every stored operation under a group or `*`. `/nep access list` shows each operation, who holds it, and where each grant came from.

Owner-only operations are never opened by any grant, `*` included: `access.*`, `memory.private.read`, `memory.journal.read`, `memory.snapshot`, `memory.archive.read`, `memory.restore`, `inner.*`.

Operations with `member: true` are open to every member while `features.memberCommands` is on, without needing a grant: `pings.*`, `task.run`, `task.status`, `task.cancel`, `task.list`, `task.read`, `task.resolve`, `web.search`, `web.read`, `media.look`, `media.find`, `memory.search`, `conversation.read`, `places.list`, `skills.describe`.

## The operations layer

Every `/nep` command runs one named operation through `src/ops/`. The same operations are the persona's skills when granted to her (`/nep access grant <operation> user:@bot`). A skill call from the persona passes the same rights check, the same arguments and the same gateway. See the granting rules in the table notes.

Each operation has a kind (`read` or `write`) and an effect (`src/ops/effects.js`): the kind gates access (a `*` or group grant stores only the reads), the effect governs cooldowns and cost labels.

## Command table

The table follows the command tree in `src/ops/catalog.js`. Options that autocomplete are marked (ac). Several options autocomplete: `set`/`unset` autocomplete `path`, `access grant`/`access revoke` autocomplete `command`, `model set` autocompletes `id`, `route set`/`route remove` autocomplete `model`, `memory restore` autocompletes `id`.

| Command | Operation | Kind | What it does |
|---|---|---|---|
| `/nep status [field]` | `status.show` | read | The bot's state, models, keys, costs, limits, memory and speed in one card. `field` (ac) shows one field alone. A member granted `status.show` sees the card without keys, costs, inner, memory and speed |
| `/nep set <path> <value>` | `config.set` | write | Override a config value in `config.local.json`. `path` (ac) is a dotted config path; `value` is JSON or a plain string |
| `/nep unset <path>` | `config.unset` | write | Remove a config override. `path` (ac) |
| `/nep pause` | `bot.pause` | write | Pause the persona and flush memory so `data/` can be hand-edited. Deferred |
| `/nep resume` | `bot.resume` | write | Resume after a pause; refused if a `data/` file is invalid. Deferred |
| `/nep draw <text> [self] [channel]` | `draw.create` | write | Draw one picture. Spends balance. `self`: the persona is in it. `channel`: post it there as the persona. Deferred |
| `/nep pings [mode]` | `pings.get` / `pings.set` | read/write | Without `mode`: your current setting. `on`/`off`: set whether the persona's messages notify you. Member command |
| `/nep media <kind> <action> [days]` | `media.status` / `media.rescan` / `media.recache` | read/write | `kind`: `emoji`, `gifs` or `pictures` (recache only). `action`: `status`, `rescan` or `recache`. `days` (pictures recache only): days of cached descriptions to redo, 1 to 60, default 7 |
| `/nep model show` | `model.show` | read | Show every role's model, grouped as the status card is |
| `/nep model set <role> <id>` | `model.set` | write | Set the model for one role. `role`: `core`, `analyzer`, `vision`, `video`, `embedding`, `speech`, `drawing`, `scout`, `server`, `thinker`, `dev`. `id` (ac). Setting `vision` or `video` also sets `media.recacheBefore` |
| `/nep route list` | `route.list` | read | Every route, then each role's model and route |
| `/nep route set <model> <providers> [role] [fallbacks] [byok]` | `route.set` | write | Route a model prefix to these providers. `model` (ac). `role`: `core`, `analyzer`, `vision`, `video`, `embedding`, `drawing`. `byok:true` refuses answers from OpenRouter's own capacity |
| `/nep route remove <model> [role]` | `route.remove` | write | Remove a route. `model` (ac) |
| `/nep rule add <text>` | `rule.add` | write | Append a rule to `prompts.local/rules.md` |
| `/nep rule list` | `rule.list` | read | List the rules, numbered |
| `/nep rule remove <number>` | `rule.remove` | write | Remove a rule by number |
| `/nep access grant <command> [role] [user]` | `access.grant` | write | Open an operation, group or `*`. `command` (ac). Owner-only |
| `/nep access revoke <command> [role] [user]` | `access.revoke` | write | Revoke an operation, group or `*`. `command` (ac). Owner-only |
| `/nep access list` | `access.list` | read | List every access grant. Owner-only |
| `/nep message create [channel] [reply]` | `message.create` | write | Give the persona a turn now, in her own words. `reply`: a message id or link to answer. Deferred |
| `/nep message edit <message> <text> [channel]` | `message.edit` | write | Replace the text of one of the persona's messages. `message:last` picks her most recent in the channel |
| `/nep message delete <message> [channel]` | `message.delete` | write | Delete one of the persona's messages |
| `/nep message react <action> <message> <emoji> [channel]` | `message.react.add` / `message.react.remove` | write | Put or take back a reaction. `action`: `add` or `remove` |
| `/nep alias add <user> <name>` | `alias.add` | write | Add or strengthen a member's alias |
| `/nep alias remove <user> <name>` | `alias.remove` | write | Remove a member's alias |
| `/nep learning add <text>` | `learning.add` | write | Add or strengthen a learned item |
| `/nep learning remove <number>` | `learning.remove` | write | Delete a learned item |
| `/nep lore add <title> <keys> <text> [always]` | `lore.add` | write | Add or overwrite a lorebook entry |
| `/nep lore list [query]` | `lore.list` | read | List entries, optionally filtered |
| `/nep lore show <id>` | `lore.show` | read | Show one entry in full |
| `/nep lore remove <id>` | `lore.remove` | write | Delete one entry |
| `/nep memory show <user> [section] [limit] [order]` | `memory.profile.read` | read | A member's stored profile. `section`: `summary`, `character`, `style`, `relationship`, `affinity`, `aliases`, `interests`, `details`, `episodes`, `raw` |
| `/nep memory channel [channel]` | `memory.channel.read` | read | A channel's note, or a table of all stored channels |
| `/nep memory server` | `memory.server.read` | read | Server notes: patterns, starters, in-jokes, self-facts |
| `/nep memory recent` | `memory.recent.read` | read | The live recent lines, newest first |
| `/nep memory affinity <user>` | `memory.affinity.read` | read | A member's attitude score and its history |
| `/nep memory journal [day] [kind] [n] [message]` | `memory.journal.read` | read | Journal records for a UTC day. `kind`: `turn`, `action`, `memory`, `system`, `answer`, `inner`, `all`. `message`: the turn that posted it. Owner-only |
| `/nep memory archive [user] [kind] [n]` | `memory.archive.read` | read | Archived items. Deferred. Owner-only |
| `/nep memory restore <id>` | `memory.restore` | write | Restore an archived item. `id` (ac). Deferred. Owner-only |
| `/nep memory snapshot` | `memory.snapshot` | write | Copy `data/` for the tools. Deferred. Owner-only |
| `/nep memory private <user>` | `memory.private.read` | read | A member's private DM memory. Owner-only |
| `/nep memory search <question> [people] [channel] [when] [terms]` | `memory.search` | read | Search this server's message history. The messages come back quoted, no summary. Member command |
| `/nep task run <agent> <goal>` | `task.run` | write | Hand an errand to `scout` or `server`. `server` is owner-only. Member command |
| `/nep task status [id]` | `task.status` | read | One task, or the open ones. Member command |
| `/nep task cancel <id>` | `task.cancel` | write | Cancel an open task (its requester or an owner). Member command |
| `/nep task list` | `task.list` | read | The latest ten tasks. Member command |
| `/nep task intent <action> [text] [id] [due] [every] [expires] [task] [deadline] [state] [chain] [condition] [channel] [attend] [people] [settle] [perday]` | `intent.set` / `intent.update` / `intent.cancel` / `intent.list` | write/read | The persona's intentions (`features.intentions`). `add` sets one, `update` changes one by `id`, `cancel` drops one, `list` shows the open ones. `attend` makes it an attention on a channel. Times: `30m`, `6h`, `2d`, `21:00`, `mon 20:00` or ISO |
| `/nep task places [filter] [sort] [page]` | `places.list` | read | The places the interface publishes. `sort`: `recent`, `name` or `lines` |
| `/nep task inner <action>` | `inner.stop` / `inner.start` / `inner.status` | write/read | The kill switch of the persona's inner life. `stop`, `start` or `status`. Owner-only |
| `/nep task search <query> [goal]` | `web.search` | read | One quick web search. Member command |
| `/nep task read [url]` | `web.read` | read | Read one web page. Member command |
| `/nep task look <message> <question> [item]` | `media.look` | read | Look again at a picture or video. Member command |

## Persona-only operations

These operations have no slash command (the Discord command tree is at its size limit). They exist only as the persona's skills, granted by name.

| Operation | Kind | What it does |
|---|---|---|
| `voice.say` | write | Speak her text aloud as a voice message. Needs `features.speech` and the `speech` model configured |
| `conversation.read` | read | Read a channel in order. `around`, `before`, `after`, `since`, `last` parameters |
| `skills.describe` | read | Describe one skill or a family |
| `media.find` | read | Search the GIF library by stored descriptions |
| `task.read` | read | Read a finished task's result in pages |
| `task.resolve` | write | Close a finished task |

## Granting skills to the persona

The persona's skills are the same operations behind `/nep` commands. Every skill is closed until the owner grants it with `/nep access grant <operation> user:@bot`.

- A group name or `*` stores the read operations under it, one entry each, the same rule as for people. A write must be granted by its exact name.
- The persona's normal reply (speech, reactions, drawings aimed at the current conversation) counts without a grant.
- Not grantable to the persona: `memory.restore`, `config.set`, `config.unset`, `model.set`, `route.set`, `route.remove`, `access.grant`, `access.revoke`, `bot.pause`, `bot.resume`, `inner.stop`, `inner.start`. A grant naming one of them skips it.
- In-turn tools (`web.search`, `web.read`, `media.look`, `memory.search`, `conversation.read`) run inside her turn with `features.coreTools` on and return results in the same turn. None is open until granted by name.
