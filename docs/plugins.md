# Plugins

This document describes what the core does with a plugin: how a plugin connects, which tools it may register, how a call to one runs inside her turn, how she learns that a tool exists and which commands switch a plugin. It is for someone who changes the engine around plugins. How to write a plugin is in [`plugins/README.md`](../plugins/README.md).

A plugin is a process of its own that gives her tools the core does not have. The core imports no plugin, and a plugin imports nothing of the core beyond `src/protocol/`. A plugin's tools stand beside the core's own in the gateway's registry, so her grants, the schema check and the requester's right apply to them as to any tool.

## Where plugins live

The tracked plugins are `plugins/<name>/` in the checkout. A deployment's own are `plugins.local/<name>/` in its private layer, which git ignores, and a local plugin replaces the tracked plugin of the same name whole. `src/plugins/folders.ts` reads both folders at each call. A folder with no `plugin.json` is no plugin. A `plugin.json` that does not parse (`src/plugins/manifest.ts`), or that declares a skill with no `skills/<skill>/SKILL.md`, is no plugin and never stops the others, and `/plugins list` names its folder and the reason. No plugin ships with the engine.

## The client and the link

A plugin is a client of the core with the kind `plugin`: an entry of the private layer's `clients.json` and a token file `clients/<name>.token` (see [Clients and principals](interfaces.md#clients-and-principals)). `/plugins enable` writes both, and `tools/client-token.mjs add <name> --kind plugin` writes them by hand. A plugin principal has no `iface` and no permissions.

The first envelope of a connection decides which link it becomes. `routeConnection` (`src/plugins/link.ts`) hands a connection whose first envelope is a `hello` under the namespace `plugin` to `openPluginLink`, and any other connection to the interface link (`openAdapterLink`, `src/interface/link.ts`). The plugin link closes, and its `hello` rejects with the reason, when the first envelope is not a `hello`, when the body is malformed, when the token stands for no one, when the token's principal is not a `plugin` principal, or when `admit` refuses it. The core's `admit` refuses a plugin that is not on with `plugin-disabled`, read at each `hello`. Every refused `hello` is logged as `link: hello refused` with its reason, and the accepted one as `link: hello` with `kind: 'plugin'`.

The token is resolved again for every envelope, so a rotated or revoked token closes the link at its next envelope. After `hello` the link answers three kinds of envelope with an `ack` of status `invalid` and stays open. An `event` is answered `body.kind:not-allowed` and reaches no one, because a plugin sends no event. A second `hello` is answered `hello:repeated`. A `tool.register` with a malformed body is answered with the field and the problem.

## Envelopes

`src/protocol/envelope.ts` adds two envelope types, and `src/protocol/plugin.ts` holds their bodies and checks.

| Envelope | Direction | Body | Answered by |
|---|---|---|---|
| `tool.register` | plugin to core | `{ tools }`, a list of objects each with a string `name` | an `ack` with `{ status: 'ok', accepted, refused }`, or `invalid` for a malformed body |
| `tool.call` | core to plugin | `{ tool, args, requester, conversationId, deadlineAt, idempotencyKey }` | an `action_result` whose `replyTo` is the call's envelope id |

`servePlugin` is the plugin's end. It says `hello` with `iface: 'plugin'`, `self: { id: name, name }` and the token, sends one `tool.register` once the `hello` is acked `ok`, and resolves `registered` with the ack's `accepted` and `refused`. A refused `hello` rejects `registered` with `hello refused`. It answers a `tool.call` with a bad body `invalid` (`invalid-call`), a call whose `deadlineAt` has passed `failed` (`deadline-passed`) without running the handler, a tool it did not register `invalid` (`unknown-tool`), and a handler that throws or rejects `failed` (`handler-threw`). Otherwise the answer is the handler's.

## The registry

`createPluginRegistry` (`src/plugins/registry.ts`) takes the tools of a `tool.register`. The manifests it checks against are those of the enabled plugins, read at the moment of the call. For each tool, in this order, the registry refuses it with `unknown-plugin` (no enabled manifest for the plugin), `wrong-prefix` (the name does not start with `<plugin>.`), `not-declared` (the name is not in the manifest), `invalid-declaration` (the object is not shaped as a declaration) or `differs-from-manifest` (its schema, effect, cost or rights differ from the manifest's). A refused tool is not registered and the plugin's other tools are. The `ack` names each refusal, and `plugins: tools registered` logs the two counts.

A registered tool is a skill of the gateway's registry: `family` is the plugin's name, `kind` and `ownerOnly` come from `rights`, `argsSchema` from `schema`, `effects` from `effect`, `costClass` from `cost`, and its result is data. Its words come from the manifest's `wording`, and the owner's tool texts replace them. `src/tools/registry.ts#setExtraSkills` lays these skills over `skillRegistry()` at each call, and a plugin's tool never shadows a core tool of the same name. Her grant is `bot.access['<tool>']` like any other, the arguments are checked against the manifest's schema, and the requester's right is checked by `checkSkill` (`src/tools/gateway.ts`): a tool with `ownerOnly` runs only for an owner, and a tool that changes state runs for a member only when the owner granted it to them.

A tool that registered stays registered, and stays in her tool list and in `/skills list`, after its plugin disconnects, until the owner disables the plugin. Her grants and her tool list do not flicker with a restart of the plugin.

## A call

A registered tool runs as an in-turn tool of her turn (`src/turn/in-turn-tools.ts`), like `web.search`. Her call passes the gateway, then `createPluginRegistry().call` sends a `tool.call` through the plugin's link with the requester, the conversation and the call's idempotency key, and the plugin's answer is the tool message of the call in the same turn. The API name of a tool is its dotted name with `.` written `_`.

`PluginLink.callTool` (`src/plugins/link.ts`) sets `deadlineAt` to `now() + plugins.callDeadlineMs`. The result she reads when the call does not go through:

| Code | Status | When |
|---|---|---|
| `plugin-no-answer` | `unknown` | The plugin did not answer by the deadline. The call may have gone through, and a late answer is dropped. |
| `plugin-not-connected` | `unknown` | The link closed while the call waited. |
| `plugin-not-connected` | `failed` | No link was open, so nothing was sent. |
| `invalid-answer` | `failed` | The plugin answered a status the engine does not know. |

An answer keeps `data.text` only when it is text. The words of each code are `labels.tools.result.reasons.<code>` ([Prompt contract](prompt-contract.md)).

## How she learns of a tool

The first time a plugin registers a tool it was not announced for, the core queues one `heartbeat` wake with the reason `ability.added` and the tool names (`src/plugins/announce.ts`). The wake has no place and no intention, its id is `inner.wake:heartbeat:ability:<plugin>:<at>`, and her `<wake>` shows `labels.wake.abilityAdded` with the names after the heartbeat's own line. A reconnect registers the same tools and raises no wake. `<data>/plugins-announced.json` keeps what was announced per plugin, and a disable forgets the plugin, so the next enable announces again. A heartbeat wake waits in the queue while `innerLife.heartbeat.enabled` is `false`, because its turn is a heartbeat turn.

## Skills a plugin ships

The `skills/` folder of each enabled plugin is read beside `skills/` and `skills.local/` (`src/skills/load.ts`, `pluginDirs`). A plugin's skill replaces a tracked skill of the same name and a local skill replaces both. The skills are `/skills pending` like any other, an activation grants no tool, and the registered tool names count as registered for `/skills list`. A disabled plugin's skills are not read.

## The owner's commands

`/plugins` runs over `createPluginControl` (`src/plugins/control.ts`) and `src/interface/commands/plugins.ts`.

| Command | What it does |
|---|---|
| `/plugins` or `/plugins list` | One line per plugin: its name, enabled or disabled, connected or not and its registered tools, then a line for each folder the loader refused. |
| `/plugins enable <name>` | Writes the plugin's client and token if it has none, writes `plugins.<name>.enabled: true` to the private settings file and starts `neptunia-plugin@<name>` through `systemctl`. A unit that does not start answers `failed` and leaves the client, the token and the switch in place. |
| `/plugins disable <name>` | Writes `false`, stops the unit, removes the client and the token, drops the plugin's tools and the announcement, and closes its link. |
| `/plugins setup <name>` | One line per environment key of the manifest, `set` or `missing` by `clients/<name>.env`. Values are never read out. |

Enabling a plugin writes `clients.json`, and while that file exists the boot token of an in-process interface counts for nothing (see [Clients and principals](interfaces.md#clients-and-principals)), so plugins belong to a core that runs its interfaces as units (`interfaces.mode: units`). `neptunia plugin run <name>` runs a plugin, as `deploy/neptunia-plugin@.service` does ([The neptunia command](cli.md)).

## Settings and modules

| Setting | Default | What it does |
|---|---|---|
| `plugins.callDeadlineMs` | 30000 | How long a call to a plugin's tool may take before `plugin-no-answer` |
| `plugins.<name>.enabled` | false | Whether the plugin is on |

`src/plugins/manifest.ts` parses a `plugin.json`, `folders.ts` reads the two folders, `registry.ts` holds the registered tools, `link.ts` is the core's end of a plugin's connection and routes a new connection, `announce.ts` is the ability wake and its record, `control.ts` is the owner's switch and `settings.ts` reads the two settings. The settings table is in [Configuration](configuration.md#plugins).
