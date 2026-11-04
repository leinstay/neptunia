# Keys and models

The persona's model credentials live in `data/keys.json`. Interface and skill credentials live beside the module they belong to. Use the CLI dialogs to create or change them; secret values are not printed.

## Core and extra keys

`/keys core add` adds an OpenRouter key and checks the models selected for its roles. Core keys form the normal credential pool. Named extra keys let a particular service or role use a separate account.

Use `/keys` to inspect the available commands, `/keys bind` to select an extra key for a target, and `/keys check` to check a supported target. `/model set` changes a model role. The command's result reports whether validation succeeded; a model name alone does not prove that the selected account can use it.

The base conversation roles, the memory writer and the delegated agents are distinct routes. A subscription login for an agent backend does not replace the OpenRouter keys used by the core. See [setup](setup.md#subharness-backends) for those logins.

## Quick search

Quick search has its own `web.search.model` and `search` key binding, independent of the analyzer. The engines are OpenRouter, Brave and Exa. OpenRouter uses the core key pool unless `search` is bound to a named extra key. It still sends a model request with the search plugin, so the model and its cost matter.

Use `/search` to inspect and change the engine, model and enabled state. Use `/keys bind search <name>` for an extra key and `/keys check search` to validate the binding. Brave and Exa use their own optional service keys.

[Deep search](errands.md) runs through the scout. Its availability and credentials are separate from quick search.

## Service and module keys

`/keys service set <name>` prompts for a service value. Supported service names include `youtube`, `brave`, `exa` and `videoProxy`. The [setup guide](setup.md#optional-modules) links to the YouTube API instructions.

`/interface token set discord` writes Discord's token to `data/interfaces/discord/credentials.json`. A skill's setup contract declares its own secrets. Removing a platform's credentials does not remove stored memories from it.

Back up credentials with the complete persona, keep the backup private and do not commit credentials to Git. Key files are not encrypted by the engine. [Persona migration](persona-migration.md) covers moving them without printing their values.

Read the implementation in [key management](../src/keys/) and [search commands](../src/interface/commands/search.ts).
