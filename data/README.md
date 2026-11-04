# Persona data

The persona root: everything that makes one deployment's persona, kept apart from the engine's code. Copying this directory while the engine is stopped moves the persona to another installation of a compatible engine. `NEPTUNIA_DATA_DIR` selects it, with `data/` of the checkout as the default.

| Path | What it holds |
|---|---|
| `memory.db` | The memory database: memory, the journal, the request archive, media descriptions, intentions and tasks. |
| `media/` | The media originals kept for the diary. |
| `config/` | Personal settings over the defaults of the engine's `config/`. |
| `prompts/` | Personal prompts, each replacing the engine's file of the same name. |
| `keys.json` | Model keys and service credentials, mode `0600`. |
| `agents/<name>/` | Personal prompt and profile fields of an agent from the engine's `agents/`, and the watcher's reports. |
| `skills/<name>/` | Authored skills, their scripts and their state. |
| `interfaces/<name>/` | The settings, credentials and technical state of one interface. |
| `subharness/<backend>/` | The native homes, logins and sessions of the agent backends. |
| `clients.json`, `clients/` | Local client authentication and service environment files. |
| `cli/` | Owner CLI history. |
| `run/` | Runtime sockets, recreated when services start. |

SQLite also creates working sidecars beside `memory.db`; the writer holds `memory.db.lock` while running. These are runtime files, not additional memory stores.

This README is the only file of the directory in the public repository.
