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

`scripts/memory-convert-places.ts` is the one offline rebuild of a schema 28 database into neutral places, with its config. Stop every writer first. It reads a private copy of the input, builds an empty database of the current schema and carries every row over, so the input stays as it was:

```bash
node scripts/memory-convert-places.ts --input <memory.db> --output <new memory.db> \
  --config-in <config.local> --config-out <new config.local> --report <report.json> --now <iso time>
```

Exit code `0` means converted, `1` means refused with `failures` in the report and no output, and `2` is a usage error. The refusals are `DATABASE_OPEN` (a live lock or frames in the write-ahead log), `TARGET_EXISTS`, `UNSUPPORTED_SCHEMA`, `BAD_UNIT_KEY`, `ORPHAN_OWNER` and `NO_DM_PLACE`, with `MERGE_CONFLICT`, `INTEGRITY`, `FOREIGN_KEY` and `NO_PLACE_ROW` from its own checks.

The report holds `tables`, one row of `input`, `preserved`, `transformed`, `merged`, `removed`, `added` and `output` per table, and `contradictions`, the descriptions that came from two partitions of one account and disagree. Both stay. `contentHash` is the same for every run over the same input, and converting the output changes nothing. A community partition becomes the account, the DM place or the persona its collection belongs to, `bot.guildId` moves to `interfaces/discord.json#servers`, and the retired channel fallback setting goes. Ids, audiences, `model_requests` and `sources.text` stay byte for byte.

An engine at this schema refuses an unconverted database with `MEMORY_NEEDS_CONVERSION` when it opens one. Keep the old database, code and config together for a rollback before message handling resumes, and read [verify and recover](#verify-and-recover) before a rollback after it.

## Backup and restore

With `memoryDb.backup.enabled`, the core saves one backup per UTC day after `memoryDb.backup.hour` (default 03:00 UTC). `memoryDb.backup.keep` retains the latest seven completed backups by default. Files live in `memoryDb.backup.dir`, resolved against `data/`; the default is `../backups/memory`, which lands in `backups/memory` inside a default checkout, and `.gitignore` covers `/backups/`.

Each backup includes a consistent SQLite snapshot and the regular files throughout `data/`: prompts, configuration, credentials, media, skills, interface state, agent overrides and subharness files. Every folder a backup creates is mode 700 and every file in it mode 600. The manifest records each file's mode and a restore gives it back, so executable and private file permissions survive, with `keys.json` at 600 even from a looser source. Runtime sockets, `run/`, and the main database's WAL, SHM and lock files are omitted. A backup destination inside `data/` is refused.

The database snapshot is consistent; files are copied during the run and are not an atomic filesystem snapshot. Stop services for a migration checkpoint that must represent one exact moment. `scripts/memory-db.ts restore` restores all manifest files and checks database row counts. Older database-and-diary backups remain readable but do not contain a complete persona.

Stop the core and all services or timers that can write to or restart this persona before making a whole-directory copy. For an online database snapshot, use SQLite's backup facilities; copying a live `.db` file alone can omit committed WAL data.

1. Save the complete persona outside the installation, together with engine revision and service definitions. Keep credentials and private conversations inaccessible to other users.
2. Verify extraction into an isolated location. Check database integrity, referenced media, prompts, settings, keys, skills and retained sessions.
3. Install the compatible engine and dependencies at the destination. Restore `data/` before any setup step that starts the core.
4. Recreate host-specific service paths and permissions. Do not restore stale sockets or process locks as running state.
5. Start exactly one core, then its configured interfaces. Check CLI status, memory readiness and actual connections.

Private Git is useful for prompt and configuration history, but it does not replace a backup of the database, media and excluded credentials. Reinstall recorded backend versions when necessary while preserving their homes.

## Verify and recover

Rehearse migrations on a copy first. Check row preservation, schema integrity and media references, then open the restored persona at a different path to find hidden dependencies on the old installation.

An interrupted outward action is not automatically repeated at startup. If the new installation has already accepted events, preserve its data before rolling back code. Replacing it blindly with the old backup loses everything learned since that backup.

Read the implementation in [file converter](../scripts/persona-files-move.ts), [persona migration](../src/setup/persona-migration.ts) and [database open and migration](../src/memory/db/open.ts).
