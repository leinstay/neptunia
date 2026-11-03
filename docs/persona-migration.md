# Persona file migration

The offline converter in `src/setup/persona-migration.ts` prepares personal files and credentials in an isolated persona root. This document is for operators staging a stopped installation. Runtime readers, writers and watchers continue to use their existing paths. The converter has no runtime setting.

## Invocation

```text
node scripts/persona-files-move.ts --root <engine-root> --private <source-root> --data <target-root> [--apply]
```

Each required path resolves independently against the working directory. The default is a dry run. With `--apply`, the command inspects the files afresh and copies only missing destinations. It starts no services and makes no provider calls. Legacy credential conversion uses a private temporary key store during inspection and removes it afterwards. Use stopped or isolated roots. Source and target trees must be separate. The target may lie beneath the engine root, but it must not equal or contain that root.

## Supported files

| Source under `--private` | Destination under `--data` |
|---|---|
| `config.local/config.json` or `config.local.json` | `config/config.json` |
| `config.local/labels.json` or flat `prompts.local/labels.json` | `config/labels.json` |
| `config.local/tools.json` | `config/tools.json` |
| Top-level ordinary `prompts.local/*.md` | `prompts/*.md` |
| `prompts.local/preambles/*.md` | `prompts/preambles/*.md` |
| `prompts.local/<override>` declared by a validated shared agent profile | `agents/<id>/<prompt>` |
| `keys.json` and `clients.json` | Same relative paths |
| `clients/` | `clients/` |
| `skills.local/<name>/` | `skills/<name>/` |
| Personal `agents/`, `interfaces/` and `cli/` | Same relative paths |
| `config.local/interfaces/<name>.json` | `interfaces/<name>/config.json` |
| `subharness/<backend>/home/` and `subharness/gh/` | Same relative paths |
| Backend package version-selection files | Same relative paths |

The copy leaves sources unchanged. Authored packages and native authentication and session files retain their exact bytes. Executable scripts retain their execute bits with private access permissions. Configuration keeps nested agent settings and interface management settings. Platform settings move to the matching interface configuration. Flat labels split by the leaf ownership in the engine's `config/labels.json`, using `labelsFileOf` and `splitLabels`. Generated labels have two-space indentation and a final newline. Supplied split labels retain their bytes after section validation and the overlap check in `joinLabels`.

Configuration JSON equality ignores object key order and whitespace. Opaque package and authentication files compare as bytes, including files with a `.json` extension. Array order and scalar types remain significant. Prompt equality compares exact bytes, including empty files. Matching destinations retain their bytes and modes. Alternate sources that differ cause a conflict.

## Credentials

Without a source key store, the converter imports legacy OpenRouter variables through `src/keys/import.ts`, preserving model-role bindings and grants. An existing key store remains authoritative for model credentials and retains its other sections.

Optional service credentials use `services.youtube`, `services.brave` and `services.exa` in `keys.json`. The private proxy URL uses `services.videoProxy`. Configuration references remain for the runtime resolver, so credential values do not enter configuration selected for Git. Discord owns `interfaces/discord/credentials.json` with a `token` field. Other environment variable names appear in the held report for classification. Values never appear in plan or command output.

Native login files and sessions inside the declared persona-owned backend homes copy together. Independent owner homes and historical development-session backups are outside these source roots.

## Held material and conflicts

Shared agent definitions pass the existing profile validator before their declared overrides authorize a copy. A custom override activates only that filename. An undeclared `agent-<id>.md` alias remains held, including development profiles with a null override. Missing declared prompts create no personal file. Existing canonical profiles remain unchanged, and `config.agents` stays in configuration without generating profiles.

The watcher prompt comes from `<legacy watcher.dir>/prompt.md`. The directory resolves against the original engine root using tracked configuration and the supplied private configuration, including its accepted old filename. Absolute and parent-relative directories are supported. Missing or blank values select `.agents/watcher`. Only the prompt copies to `agents/watcher/prompt.md`. Reports remain outside this mapping.

Unmatched agent material and unclassified entries remain held. Backend installation binaries remain separate from copied homes and version-selection files. Held entries require later migration, so a successful copy does not establish a complete portable persona. Interface configuration combines settings classified for Discord with dedicated overrides, with the dedicated file taking precedence. Unrelated core settings and interface management configuration remain in the copied core configuration.

The retired `prompts.local/skills.json` causes `legacy-tools`. Run `scripts/tools-file-move.ts` separately before retrying. Malformed JSON, invalid object shapes, overlapping label leaves, different destinations, unreadable supported inputs and unsafe paths prevent every write during preflight. Symbolic links in inspected source and destination components are refused. Unknown held directories are not traversed.

The command prints source and destination paths, operation names, counts and codes. Watcher source paths identify their resolved engine or external location. Conflicts and application failures exit `1`. A conflict-free run exits `0`, including a run that reports held material. Argument errors print usage and exit nonzero.

## Application and recovery

New directories have mode `0700`. New files have mode `0600`, with source execute bits retained for executable files. The converter stages each file in its destination directory, checks the destination again and renames the staged file into place. Steps run sequentially in the returned plan's sorted source-path order. Every source remains in place.

An application failure can leave earlier files complete. The operation is not a transaction across directories or a concurrent merge utility. Fix the reported filesystem condition and rerun. Matching completed files remain unchanged while missing files are copied. A process killed during staging can leave a temporary file in the destination directory.

Source preservation supports preparation while the existing runtime remains active elsewhere. During a stopped clean reinstallation, originals belong in external backups. This converter establishes no permanent runtime fallback, receipt or drift monitor.
