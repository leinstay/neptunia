# Diary

The diary turns selected experience into a dated entry, with an optional illustration and publication. It is part of the persona's memory and travels with its `data/` directory.

An entry records its text and media references in the database. Original diary media lives under `data/media/`. Copying only the database leaves these references without their files. [Backup and restore](persona-migration.md#backup-and-restore) includes both.

The diary's group-memory context excludes DMs and internal material. Its configured mirror is a publication destination, not another copy of the persona's memory. Delivery failures and restarts must not be treated as permission to repost an old entry automatically.

The diary prompts supply the writing and drawing instructions. Personal replacements belong in `data/prompts/`; keep the placeholders expected by the [prompt contract](prompt-contract.md). Settings and their readers are listed in [configuration](configuration.md). Start implementation inspection in [src/behavior/diary.ts](../src/behavior/diary.ts).
