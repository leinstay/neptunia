# Persona file migration

`scripts/persona-files-move.ts` copies a legacy private layer into the persona folder (`data/`, see [Getting started](getting-started.md#the-persona-folder)). It is for an operator who stages a stopped installation or an isolated copy of one. The converter lives in `src/setup/persona-migration.ts`, has no runtime setting, starts no service and makes no provider call.

## Invocation

```text
node scripts/persona-files-move.ts --root <engine-root> --private <source-root> --data <target-root> [--apply]
```

All three paths are required and each resolves against the working directory. The default is a dry run. With `--apply` the command inspects the files afresh and copies only the destinations that are missing. `NEPTUNIA_PRIVATE_DIR` does not replace the explicit paths and does not prevent the inspection of a legacy source. Source and target must be separate trees, and the target may lie beneath the engine root but must not equal or contain it. A violation is the conflict `unsafe-path` on `.`.

The command prints a summary line: `dry-run` or `apply`, then the counts of steps, unchanged files, held items and conflicts. One line follows for each step (`copy <source> -> <target>`, or `split-labels` for a flat labels file), unchanged file, held item (`held <path> <reason>`) and conflict (`<path> <code>`). Values of credentials never appear in the output. A run with conflicts exits 1, and so does an argument error, which prints the usage. A run without conflicts exits 0, even when it reports held material.

## Supported files

| Source under `--private` | Destination under `--data` |
|---|---|
| `config.local/config.json` or `config.local.json` | `config/config.json` |
| `config.local/labels.json`, or the flat `prompts.local/labels.json` | `config/labels.json` |
| `config.local/tools.json` | `config/tools.json` |
| Top-level `prompts.local/*.md` | `prompts/*.md` |
| `prompts.local/preambles/*.md` | `prompts/preambles/*.md` |
| `prompts.local/<override>` that a shared agent profile declares | `agents/<id>/<prompt>` |
| `keys.json` and `clients.json` | the same paths |
| `.env` | `keys.json` and `interfaces/discord/credentials.json` (see below) |
| `clients/`, `agents/`, `interfaces/` and `cli/` | the same paths |
| `skills.local/<name>/` | `skills/<name>/` |
| `config.local/interfaces/<name>.json` | `interfaces/<name>/config.json` |
| `subharness/<backend>/home/` and `subharness/gh/` | the same paths |
| `package.json`, `package-lock.json` and `npm-shrinkwrap.json` of a backend | the same paths |

The copy leaves the sources unchanged. Authored packages and the native login and session files of a backend keep their exact bytes, and executable scripts keep their execute bits. Platform settings found in the core settings move to the matching interface configuration, and the unrelated core settings stay. A flat labels file splits into the `model` and `owner` sections by the leaf ownership in the engine's `config/labels.json` (`labelsFileOf` and `splitLabels`). Labels that are already split keep their bytes after `joinLabels` has checked the sections and their overlap. The settings of an interface combine the source's `interfaces/<name>/config.json`, the platform settings found in the core file and the dedicated `config.local/interfaces/<name>.json`, and the dedicated file wins.

Settings JSON compares equal when its objects hold the same keys, whatever the key order or the whitespace. Array order and scalar types count. Package and login files compare as bytes, `.json` files among them. Prompts compare as exact bytes, an empty file included. A destination that already matches keeps its bytes and mode, and two sources for one destination that differ are a conflict.

## Credentials

Without a key store in the source, the converter imports the legacy `OPENROUTER_*_KEY` variables of `.env` through `src/keys/import.ts`, which keeps the role bindings and the grants (see [Keys](keys.md)). The import runs in a private temporary key store that the converter removes afterwards. A key store that exists stays authoritative for the model keys and keeps its other sections. The variables `YOUTUBE_API_KEY`, `BRAVE_SEARCH_API_KEY`, `EXA_API_KEY` and `MEDIA_VIDEO_PROXY` become `services.youtube`, `services.brave`, `services.exa` and `services.videoProxy`, and `DISCORD_TOKEN` becomes the `token` of `interfaces/discord/credentials.json`. Every other variable that is not an `OPENROUTER_*_KEY` is held as `.env:<NAME>` with the reason `unclassified`. Settings keep their `${env:NAME}` references for the runtime resolver, so a credential value never enters a settings file.

## Held material and conflicts

A prompt file `prompts.local/agent-<id>.md` is copied only when the shared profile of that agent declares it as its `override`. The profiles pass the profile validator first. An `agent-<id>.md` that no profile declares stays held with the reason `agent-contract`, development profiles with a null override included. A declared prompt that is missing creates no personal file.

The watcher prompt comes from `<watcher.dir>/prompt.md` of the source settings, laid over the tracked ones. The directory resolves against the engine root and may be absolute or relative to it. A missing or blank `watcher.dir` selects `.agents/watcher`. Only the prompt is copied, to `agents/watcher/prompt.md`, and the old reports stay where they are.

Held items stay in the source: unmatched agent material, the installed binaries of a backend (only its home and its version-selection files copy), and everything the table does not name. The reasons are `agent-contract`, `interface-contract` and `unclassified`, and a held directory is not traversed. A successful copy therefore does not prove that the persona is complete.

The conflict codes are `different-content`, `invalid-json`, `invalid-shape`, `unreadable`, `unsafe-path` and `legacy-tools`. `prompts.local/skills.json` produces `legacy-tools`, and the command then asks for `scripts/tools-file-move.ts` first (`--dry-run` or `--apply`, with `--dir <private dir>`). Malformed JSON, an object of the wrong shape, overlapping label leaves, a different destination, an unreadable input and an unsafe path stop the run in the preflight, before any write. A symbolic link in a source or destination component is `unsafe-path`.

## Application and recovery

New directories get mode `0700` and new files `0600`, with the execute bits of an executable source kept. The converter stages each file in its destination directory, checks the destination again and renames the staged file into place. Steps run one after the other in the sorted order of their source paths, and every source stays in place.

The operation is no transaction. A failure (`<target>: install-failed`) can leave earlier files complete. Fix the filesystem condition and rerun: matching files stay unchanged and missing ones are copied. A process killed during staging can leave a `.persona-<uuid>` file in a destination directory.

Keeping the sources supports preparing a persona while the old installation still runs elsewhere. For a stopped, clean reinstall the originals belong in an external backup.

## What the runtime refuses

`resolvePaths` (`src/paths.ts`) selects one persona folder from `NEPTUNIA_DATA_DIR`, `data/` of the checkout by default. A `NEPTUNIA_PRIVATE_DIR` that names another path is an error. `assertPersonaLayout` (`src/config/files.ts`) refuses `config.local`, `config.local.json`, `prompts.local` and `skills.local` in the persona folder and in the checkout, with a message that names the path and this script. The runtime has no fallback to the legacy places, and a prepared persona needs no access to the old private folder.
