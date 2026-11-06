# Persona migration

A persona consists of its complete `data/` directory: database, preserved media, prompts, settings, credentials, skills, interface state, agent overrides and backend sessions. Moving only `memory.db` does not move the whole persona.

## Convert a legacy layout

`scripts/persona-files-move.ts` copies recognized personal files from a legacy private layer into a selected data root. It defaults to a dry run:

```bash
node scripts/persona-files-move.ts --root /path/to/new/engine --private /path/to/old/private --data /path/to/staged/data
```

Inspect its conflicts and held files. Add `--apply` to copy accepted material. Existing conflicting destinations are not silently overwritten, and unknown material needs classification. The converter is not a substitute for a complete backup or for database migrations.

The runtime refuses ambiguous legacy and canonical layouts. `NEPTUNIA_PRIVATE_DIR`, when supplied, must name the same directory as `NEPTUNIA_DATA_DIR`. Remove old launch overrides only after verifying the staged persona no longer depends on them.

## Convert the database to places

`scripts/memory-convert-places.ts` is the one offline rebuild of a schema 28 database into neutral places, with its config. Stop every writer first. It reads a private copy of the input, builds an empty database of the current schema and carries every row over, so the input stays as it was. The converter takes the writer lock beside the input (`<input>.lock`) for its whole run and releases it on success and on failure, so a core started during the conversion is refused instead of opening the old database; a live holder makes the converter itself refuse with `DATABASE_OPEN`:

```bash
node scripts/memory-convert-places.ts --input <memory.db> --output <new memory.db> \
  --config-in <config folder> --config-out <new config folder> --report <report.json> --now <iso time>
```

Exit code `0` means converted, `1` means refused or failed with `failures` in the report and no output, and `2` is a usage error that names the argument: an `--input` that is no file, a `--config-in` that is no folder (it holds `config.json` and, beside it, `interfaces/discord/config.json`), a `--now` that is no date. The database moves into place last, after the config and the report are written, so a run that fails leaves no database. The output database, the report and every config file are mode `0600` and the config folders `0700`. A failure the conversion did not expect reports the error's code. The refusals are `DATABASE_OPEN` (a live lock or frames in the write-ahead log), `TARGET_EXISTS`, `UNSUPPORTED_SCHEMA`, `BAD_UNIT_KEY`, `ORPHAN_OWNER` and `NO_DM_PLACE`, with `MERGE_CONFLICT`, `INTEGRITY`, `FOREIGN_KEY` and `NO_PLACE_ROW` from its own checks.

The report holds `tables`, one row of `input`, `preserved`, `transformed`, `merged`, `removed`, `added` and `output` per table, and `contradictions`, the descriptions that came from two partitions of one account and disagree. Both stay. `contentHash` is the same for every run over the same input, and converting the output changes nothing. A community partition becomes the account, the DM place or the persona its collection belongs to, `bot.guildId` is added to `servers` in `interfaces/discord/config.json` (the file the Discord interface reads, with its other keys kept), and the retired channel fallback setting goes. The selfreflection's `selfreflection[<community>]` day plan moves to `selfreflection.persona` with its `done` and `hunger`, the newest day winning when several communities held one. Ids, `model_requests` and `sources.text` stay byte for byte.

Audiences stay as well, except for what a shipped engine filed under a group while it belonged to a DM. `src/memory/migration/dm-repair.ts` finds a DM's native conversation in the locators of its partner's own lines and reads no line's words. A row under that conversation's spelled channel place moves to the DM: a `sources` line to the DM's `record` unit of its day and a `day` row to its `journal` unit, with their place, scope and audience. Their `vectors`, `graph_edges` and `node_access` rows take the DM's audience, and a DM place's `claims` and `descriptions` written as a group's take the DM's scope. A conversation no partner's lines name, or that two partners' lines both name, stays where it is. `movedToDm` in the report counts the moved rows per table.

An engine at this schema refuses an unconverted database with `MEMORY_NEEDS_CONVERSION` when it opens one. Keep the old database, code and config together for a rollback before message handling resumes, and read [verify and recover](#verify-and-recover) before a rollback after it.

## Backup and restore

With `memoryDb.backup.enabled`, the core saves one backup per UTC day after `memoryDb.backup.hour` (default 03:00 UTC). `memoryDb.backup.keep` retains the latest seven completed backups by default. Files live in `memoryDb.backup.dir`, resolved against `data/`; the default is `../backups/memory`, which lands in `backups/memory` inside a default checkout, and `.gitignore` covers `/backups/`.

Each backup includes a consistent SQLite snapshot and the regular files throughout `data/`: prompts, configuration, media, skills, interface state, agent overrides and subharness files. It holds no credential. `src/memory/db/secret-files.ts` names what stays out: `keys.json`, every `credentials.json` and `.credentials.json`, the `auth.json` of a subharness login, `clients.json` and the `clients/` folder, `.env` and `*.env` files, the `backups/` folder, and any file whose text holds an OpenRouter, Anthropic or Google key. The manifest counts the files left out per class in `leftOut` and never names a value. A restore never writes a secret file, and skips one that an older manifest lists. Every folder a backup creates is mode 700 and every file in it mode 600. The manifest records each file's mode and a restore gives it back, so executable permissions survive. Runtime sockets, `run/`, and the main database's WAL, SHM and lock files are omitted. A backup destination inside `data/` is refused.

Restoring a persona on a new host therefore means entering its keys and logins again with `neptunia keys` and the interface and backend login commands. File checkpoints of a development worktree (`src/development/checkpoints.ts`) leave the same files out.

The database snapshot is consistent; files are copied during the run and are not an atomic filesystem snapshot. Stop services for a migration checkpoint that must represent one exact moment. `scripts/memory-db.ts restore` restores all manifest files and checks database row counts. Older database-and-selfreflection backups remain readable but do not contain a complete persona.

Stop the core and all services or timers that can write to or restart this persona before making a whole-directory copy. For an online database snapshot, use SQLite's backup facilities; copying a live `.db` file alone can omit committed WAL data.

1. Save the complete persona outside the installation, together with engine revision and service definitions. Keep credentials and private conversations inaccessible to other users.
2. Verify extraction into an isolated location. Check database integrity, referenced media, prompts, settings, skills and retained sessions.
3. Install the compatible engine and dependencies at the destination. Restore `data/` before any setup step that starts the core.
4. Recreate host-specific service paths and permissions. Do not restore stale sockets or process locks as running state.
5. Start exactly one core, then its configured interfaces. Check CLI status, memory readiness and actual connections.

Private Git is useful for prompt and configuration history, but it does not replace a backup of the database and media. Credentials are in neither, so keep them where the owner keeps them. Reinstall recorded backend versions when necessary while preserving their homes.

## Verify and recover

Rehearse migrations on a copy first. Check row preservation, schema integrity and media references, then open the restored persona at a different path to find hidden dependencies on the old installation.

An interrupted outward action is not automatically repeated at startup. If the new installation has already accepted events, preserve its data before rolling back code. Replacing it blindly with the old backup loses everything learned since that backup.

Read the implementation in [file converter](../scripts/persona-files-move.ts), [persona migration](../src/setup/persona-migration.ts) and [database open and migration](../src/memory/db/open.ts).
