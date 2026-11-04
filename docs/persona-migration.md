# Persona migration

A persona consists of its complete `data/` directory: database, preserved media, prompts, settings, credentials, skills, interface state, agent overrides and backend sessions. Moving only `memory.db` does not move the whole persona.

## Convert a legacy layout

`scripts/persona-files-move.ts` copies recognized personal files from a legacy private layer into a selected data root. It defaults to a dry run:

```bash
node scripts/persona-files-move.ts --root /path/to/new/engine --private /path/to/old/private --data /path/to/staged/data
```

Inspect its conflicts and held files. Add `--apply` to copy accepted material. Existing conflicting destinations are not silently overwritten, and unknown material needs classification. The converter is not a substitute for a complete backup or for database migrations.

The runtime refuses ambiguous legacy and canonical layouts. `NEPTUNIA_PRIVATE_DIR`, when supplied, must name the same directory as `NEPTUNIA_DATA_DIR`. Remove old launch overrides only after verifying the staged persona no longer depends on them.

## Backup and restore

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
