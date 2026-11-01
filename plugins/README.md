# Plugins

A plugin gives the persona tools the core does not have. It runs as a process of its own, connects to the core's socket, registers the tools its `plugin.json` declares and answers each call the core sends. The core lists a plugin's tools beside its own: the same grants, the same schema check and the same rights apply, and the plugin's answer is the tool result she reads in the same turn. The core imports no plugin and a plugin imports nothing of the core beyond `src/protocol/`. [docs/plugins.md](../docs/plugins.md) describes what the core does with a plugin, and this page is for whoever writes one.

A tracked plugin lives in `plugins/<name>/` in the checkout, a private one in `plugins.local/<name>/` in the deployment's private layer, which git ignores. A local plugin replaces the tracked plugin of the same name whole.

## A package

A plugin is a folder with these files.

| File | What it is |
|---|---|
| `package.json` | The package. A plugin that needs a library lists it here and installs it into its own `node_modules`. |
| `plugin.json` | What the core may accept from the plugin: its tools, the environment keys it reads and the skills it ships. |
| `index.ts` or `index.js` | The entry. It exports `start(host)`, which resolves with `{ stop() }`. |
| `skills/<skill>/SKILL.md` | The skills it ships, one folder each, in the format of [skills/README.md](../skills/README.md). |
| `README.md` | What the plugin connects to, which keys it needs and what its tools do. |

The folder name, the `name` in `plugin.json` and the unit's name are the same: lowercase letters, digits and hyphens, starting with a letter.

## plugin.json

```json
{
  "name": "echo",
  "description": "Says back the text it is given.",
  "env": ["ECHO_PREFIX"],
  "skills": ["echo-say"],
  "tools": [
    {
      "name": "echo.say",
      "schema": {
        "type": "object",
        "properties": { "text": { "type": "string", "minLength": 1, "maxLength": 500 } },
        "required": ["text"],
        "additionalProperties": false
      },
      "wording": {
        "title": "Say it back",
        "whenToUse": "You want a line repeated exactly.",
        "whenNotToUse": "Anything that needs a real answer."
      },
      "effect": "read",
      "cost": "free",
      "rights": { "kind": "read" }
    }
  ]
}
```

| Key | What it holds |
|---|---|
| `name` | The plugin's name, equal to its folder. |
| `description` | One line the owner reads in `/plugins list`. |
| `env` | The environment keys the plugin reads, in upper snake case. The runner hands `host.env` these keys and no others. May be empty or left out. |
| `skills` | The names of the skills it ships. Each needs a `skills/<name>/SKILL.md`, or the whole plugin is refused. May be empty or left out. |
| `tools` | The tools it registers. May be empty. |

A tool has these fields, all required.

| Field | What it holds |
|---|---|
| `name` | `<plugin>.<verb>`, dotted, and no name repeats. The model's tool name is the same with the dot written `_`, so `echo.say` is `echo_say`. |
| `schema` | The arguments, in the few keywords `src/tools/schema.ts` reads: `type`, `properties`, `required`, `additionalProperties`, `minLength`, `maxLength`, `minimum`, `maximum`, `enum`, `items`, `minItems`, `maxItems` and `anyOf`. The core checks every call against it before the call reaches the plugin. |
| `wording` | `title`, `whenToUse` and `whenNotToUse`, the words she reads about the tool. The owner's `config.local/tools.json` may replace them. |
| `effect` | What the tool does to the world: `read`, `write`, `destructive`, `administrative` or `paid`. A tool that is not a `read` counts as changing shared state. |
| `cost` | `free` or `paid`. |
| `rights` | `kind` (`read` or `write`), and optionally `ownerOnly` (only an owner may have the tool run) and `member` (open to every member). |

The core takes a tool only when the plugin registers exactly what `plugin.json` declares, under the plugin's own prefix. A tool outside the file, a tool under another plugin's prefix and a tool whose schema, effect, cost or rights differ from the file is refused with its reason, and the plugin's other tools stand. A plugin therefore cannot widen its own rights. A `plugin.json` that does not parse, or declares a tool with a missing field, is refused whole, and `/plugins list` names the folder and the reason.

## index.ts

The entry exports `start(host)`. The host carries what the plugin needs from the core (`PluginHost` in `src/protocol/plugin.ts`).

| Host field | What it is |
|---|---|
| `name`, `manifest` | The plugin's name and its `plugin.json` as the core knows it. |
| `dataDir` | `<data>/plugins/<name>`, the plugin's own folder for what it keeps across restarts. A plugin keeps its state here and nowhere else. |
| `env` | The environment keys `plugin.json` lists. |
| `config()` | The core's settings, read at the moment of use. |
| `log` | The logger. Write counts and names, never what a person said. |
| `serve(handle)` | Connects to the core, says hello, registers the tools and answers each call through `handle`. Resolves with `{ registered, stop() }`. |

`handle(call)` gets `{ tool, args, requester, conversationId, deadlineAt, idempotencyKey }` and answers `{ status, code?, data?: { text } }`. `data.text` is what she reads. `status` is `ok`, `denied`, `not_configured`, `invalid`, `unknown`, `partial` or `failed`, and a `code` names the reason. A call is made once, so a plugin that has an effect keeps the `idempotencyKey` and answers a repeat with the first result. `requester` is the person whose message led to the call, or null when nobody asked.

```ts
import type { PluginHost, RunningPlugin, ToolCallBody } from '../../src/protocol/plugin.ts';

export async function start(host: PluginHost): Promise<RunningPlugin> {
  const prefix = host.env.ECHO_PREFIX ?? 'echo: ';
  const served = await host.serve((call: ToolCallBody) => ({
    status: 'ok',
    data: { text: `${prefix}${typeof call.args.text === 'string' ? call.args.text : ''}` },
  }));
  return { stop: () => served.stop() };
}
```

The import holds types only, so type stripping drops it and the package needs no path to the checkout at run time. `serve` opens the link again with backoff when it drops, starting at a quarter second and doubling to 30 seconds, and registers the tools again. The plugin answers within the deadline of the call. `deadlineAt` is the moment the core stops waiting: past `plugins.callDeadlineMs` (default 30 seconds) the core gives her the result `plugin-no-answer` and drops a late answer. A call that arrives with its deadline already passed is refused by `servePlugin` and never reaches `handle`. A handler that throws answers `failed` with `handler-threw`.

## Connecting a plugin

1. Put the folder in `plugins/` or `plugins.local/`. `/plugins list` shows it, off and not connected.
2. Create the plugin's unit user and folder, and put its environment keys into `clients/<name>.env`, as [deploy/README.md](../deploy/README.md#running-a-plugin-as-a-unit) says. `/plugins setup <name>` lists the keys and whether each is set. Values are never printed.
3. `/plugins enable <name>` writes the plugin's client and token, switches it on and starts `neptunia-plugin@<name>`. In a shell on the server, `neptunia plugin run <name>` runs the same package in the foreground.
4. The core logs `plugins: tools registered` with the counts when the plugin connects. The first time a plugin registers a tool, the core wakes her once with the cause `ability.added` and the tool names, so she learns the tool exists.
5. A tool is closed to her until the owner opens it with `/tools grant <tool>`, which names the tool once the plugin has registered it. The skills the plugin ships appear in `/skills pending`, and an activation grants no tool.
6. `/plugins disable <name>` stops the unit, revokes the token and drops the plugin's tools. The next enable announces them again.

`tools/client-token.mjs add <name> --kind plugin` writes the client entry and token by hand, for a deployment that does not use `/plugins enable`. The core lets a plugin in only while `plugins.<name>.enabled` is `true`, whoever wrote its token.

## Testing a plugin

`tests/fixtures/plugins/echo/` is the smallest plugin and the one the engine's own tests use. A plugin's test calls `servePlugin` over `createLoopback()` from `src/protocol/` with a hand-driven core end, or runs the whole mechanism the way `tests/plugins-core.test.ts` does. No test reaches the network or a real private layer.
