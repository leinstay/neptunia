# Migration codecs

The offline conversion to places (`convert.ts`) and the only decoders of the identifiers and paths a shipped database still spells. Active code calls `legacyStorageKey` for a pending write that names an old path and nothing else from here.

`convert.ts` builds the output in a work folder beside it and moves the database in last, after the config and the report, all readable by the owner alone. `dm-repair.ts` is its repair of what a shipped engine filed under a group while it belonged to a DM, by ids only. `convert-map.ts` holds the pure maps of a storage key, a scope and a day plan.
