# Persona file migration

The offline converter in `src/setup/persona-migration.ts` prepares personal configuration and declared prompts in an isolated persona root. This document is for operators staging a stopped installation. Runtime readers, writers and watchers continue to use their existing paths. The converter has no runtime setting.

## Invocation

```text
node scripts/persona-files-move.ts --root <engine-root> --private <source-root> --data <target-root> [--apply]
```

Each required path resolves independently against the working directory. The default is a dry run. With `--apply`, the command inspects the files afresh and copies only missing destinations. It reads neither environment files nor credentials and starts no services. Use stopped or isolated roots. Source and target trees must be separate. The target may lie beneath the engine root, but it must not equal or contain that root.

## Supported files

| Source under `--private` | Destination under `--data` |
|---|---|
| `config.local/config.json` or `config.local.json` | `config/config.json` |
| `config.local/labels.json` or flat `prompts.local/labels.json` | `config/labels.json` |
| `config.local/tools.json` | `config/tools.json` |
| Top-level ordinary `prompts.local/*.md` | `prompts/*.md` |
| `prompts.local/preambles/*.md` | `prompts/preambles/*.md` |
| `prompts.local/<override>` declared by a validated shared agent profile | `agents/<id>/<prompt>` |

The copy preserves source bytes and modes. Configuration keeps nested agent and interface settings. Flat labels split by the leaf ownership in the engine's `config/labels.json`, using `labelsFileOf` and `splitLabels`. Generated labels have two-space indentation and a final newline. Supplied split labels retain their bytes after section validation and the overlap check in `joinLabels`.

JSON equality ignores object key order and whitespace. Array order and scalar types remain significant. Prompt equality compares exact bytes, including empty files. Matching destinations retain their bytes and modes. Alternate sources that differ cause a conflict.

## Held material and conflicts

Shared agent definitions pass the existing profile validator before their declared overrides authorize a copy. A custom override activates only that filename. An undeclared `agent-<id>.md` alias remains held, including development profiles with a null override. Missing declared prompts create no personal file. Existing canonical profiles remain unchanged, and `config.agents` stays in configuration without generating profiles.

The watcher prompt comes from `<legacy watcher.dir>/prompt.md`. The directory resolves against the original engine root using tracked configuration and the supplied private configuration, including its accepted old filename. Absolute and parent-relative directories are supported. Missing or blank values select `.agents/watcher`. Only the prompt copies to `agents/watcher/prompt.md`. Reports remain outside this mapping.

Unmatched agent material remains held. The converter also holds `config.local/interfaces` and unclassified entries. Held entries require later migration, so a successful copy does not establish a complete portable persona. Interface settings require reconciliation before runtime cutover.

The retired `prompts.local/skills.json` causes `legacy-tools`. Run `scripts/tools-file-move.ts` separately before retrying. Malformed JSON, invalid object shapes, overlapping label leaves, different destinations, unreadable supported inputs and unsafe paths prevent every write during preflight. Symbolic links in inspected source and destination components are refused. Unknown held directories are not traversed.

The command prints source and destination paths, operation names, counts and codes. Watcher source paths identify their resolved engine or external location. Conflicts and application failures exit `1`. A conflict-free run exits `0`, including a run that reports held material. Argument errors print usage and exit nonzero.

## Application and recovery

New directories have mode `0700` and new files have mode `0600`. The converter stages each file in its destination directory, checks the destination again and renames the staged file into place. Steps run sequentially in the returned plan's sorted source-path order. Every source remains in place.

An application failure can leave earlier files complete. The operation is not a transaction across directories or a concurrent merge utility. Fix the reported filesystem condition and rerun. Matching completed files remain unchanged while missing files are copied. A process killed during staging can leave a temporary file in the destination directory.

Source preservation supports preparation while the existing runtime remains active elsewhere. During a stopped clean reinstallation, originals belong in external backups. This converter establishes no permanent runtime fallback, receipt or drift monitor.
