# Memory readers: the file and database contract

<!-- writer: the JSON memory is gone; the intro, the "under `db`" phrasing and the files-or-database cells below still describe two backends and need rewording for the database alone. -->

The memory modules read either their JSON files or the memory database, chosen by `memoryDb.authority` (see
[configuration.md](configuration.md)). Under `json` (the default) every read below is the file read it always was.
Under `db` the same functions answer from the database through `src/memory/db/readers/`, and return what the file
read returns for the same data: the same objects, field names, order, `revision` and `origin` values, and dates as
the file holds them. No caller learns which backend answered.

## How a database read is built

Each memory file is a unit: one file (a record day, a journal day, an archive month, `intentions.json`) or one
directory (a month of the meaning index). Every row a unit's mapper writes carries the unit's path as `owner_file`.
A reader rebuilds the unit the way the export does (`src/memory/db/export.js`: `unitRows`, `filesOfUnit`, the
mapper's `fromRows`), then the module runs its own code over the rebuilt lines: its filters, joins, ordering and
limits exist once and serve both backends. A directory listing is the distinct `owner_file` values under the
directory's path, sorted as bytes (the order of a sorted listing of ASCII names). Retired rows are never read.

## Rules that hold for every function

- **No fallback under `db`.** A closed database (`DB_CLOSED`) or a failed query is an error to the caller, logged
  once as `memory db: read failed` with the reader's name and the code. No function reads a file then.
- **Read-after-write.** Database writes go through the service's writer thread. A write is visible to the next read
  of the same process once its promise resolved (the read connection sees every committed transaction). Under `db`
  the record's, the journal's and the meaning index's writers write the database only (`memoryDb.writeUnit`, see
  "The writers under `db`" below), so a read after an awaited write finds it. The store's cache and the intention
  and task stores keep their values in memory and hand their writes to an outbox: what they read back is their own
  value, never an older one from the database or a file.
- **Logs.** Codes and counts only, never a path, a name or a text.

## Record (`src/memory/record.js`)

| Function | Consumers | Shape | Order, ties, bounds | Revisions and deletions | Scope |
|---|---|---|---|---|---|
| `iterate(guildId, { from, to, channelIds, privateUserId })` | recall and its runner, the embedder (rings, catch-up), heartbeat view, inner life, deleted lines, conversation read, GIF recache, the record index, tools | async, lazy: one day unit at a time | oldest day first, file order inside a day (append order: `position`, then insertion); `from` and `to` inclusive on `occurredAt` (a line without a readable time passes the bounds) | every revision of an edited message is its own line, `deleted` lines are yielded too; the caller picks the newest revision | the guild record, or one member's private record with `privateUserId`; a private record is never mixed into the guild's |
| `newestRevision(guildId, messageId, occurredAt, { privateUserId })` | `appendRevision` (edits) | async, serialised with the appends | the month of `occurredAt` only | highest revision of `seen` / `said` lines; a line without a usable revision counts as 1; `deleted` does not count; null when none. Files: the month's id index; database: the month's rows | the layer named |
| `stats(guildId)` | the status card's record line | async | over all months | `messages`: distinct message ids (files: the month id indexes; database: the lines held) | guild record only |

## Archive (`src/memory/archive.js`)

| Function | Consumers | Shape | Order, ties, bounds | Stubs and restores | Scope |
|---|---|---|---|---|---|
| `iterate(guildId, { from, to, scope, kinds, privateUserId })` | admin, status, `/nep memory` operations, recall runner, tools | async, lazy: one month at a time | oldest month first, file order inside; an entry repeated by a retried write is yielded once (by `id`); `from` and `to` inclusive on `recordedAt` | `restored` is a lifecycle line like any other; archived items that are no hot claim are stub claims in the database but the reader yields the archive lines only | guild archive or one member's private archive |
| `find(guildId, itemId)` | `/nep memory` operations | async, whole | every entry of the item from the guild and every private archive, sorted by `recordedAt` (stable: guild first, then members in byte order) | as above | all layers of the guild |

The pending queue (`pending.jsonl`, `drainPending`, `stats`) is writer state and stays on files.

## Journal (`src/memory/journal.js`)

| Function | Consumers | Shape | Order, ties, bounds | Joins and partial turns | Scope |
|---|---|---|---|---|---|
| `read(guildId, { day, kind, n, privateUserId })` | heartbeat view, status, `/nep memory`, missed answers, and every function below | async, one day whole | file order; the last `n` records, newest last | a `turn` record carries its think and posted ids (database: the turn's answer source); a `memory` record its attitude rows | the guild journal, or one member's private journal |
| `timeline(guildId, { from })` | off periods of the turn | async | from the UTC day of `from` to now, sorted by time, ties in file order | none | guild journal only |
| `findTurn(guildId, { messageId, at })` | `/nep memory`, the intention service, replay | async | the day of `at` and the next; a turn found without its start looks one day back | a turn closed after midnight is joined with its start | guild journal only |
| `turnOperations(guildId, { turnId, days, privateUserId })` | inner life | async | operations in first-seen order | `open` when started and not closed, `proposed` when never started | the layer named |
| `pending`, `reconcile`'s scan, `triggerLinks`, `callMarks` | turn start, the start-up reconcile, the turn | async | days in the order given | as `read` | guild journal only |
| `stats(guildId, { now })` | the status card's storage line | async | the day of `now` and the day before | files: the newer modification time; database: the latest `recordedAt` of their lines | guild journal only |

Request dumps (`journal/requests/`) and the `.running` marker stay on files.

## Meaning index (`src/memory/vectors.js`)

| Function | Consumers | Shape | Order and selection | Model, generation, score | Scope |
|---|---|---|---|---|---|
| `search(guildId, query, { months, from, to, filter, k, privateUserId })` | recall runner, tools | async | top `k` by score, best first; months asked or all; `from` and `to` inclusive on `occurredAt` | the current generation of each month (its manifest); a month whose dims differ from the query is skipped; score = cosine (int8 dot product times the row's scale over both norms); a month whose files fail their checksum is skipped | the guild index or one member's private index; members under a marker or in the ledger left out |
| `has(guildId, month, { privateUserId })` | the embedder's catch-up, the index tool | async | a set of `kind:id:revision` keys | the current generation | the layer named |
| `stats(guildId, { privateUserId })` | the embedder, the index tool | async | months, rows, bytes from the manifests | | the layer named |

Under `db` an evicted vector (its bytes dropped by the index policy) cannot be scored: it is left out of its month,
which is then read with a manifest counting the rows left.

## Intention and task stores (`src/intentions/store.js`, `src/errands/store.js`)

| Function | Consumers | Shape | Notes |
|---|---|---|---|
| intentions `list`, `get` | the intention service | sync, from the list loaded once when the guild's store is created | the load is the database's `intentions.json` under `db`; records that break the model's invariants are left out on both sides |
| intentions `archived` | tools | sync | the archive file's lines, oldest first |
| tasks `open`, `recent`, `unseen`, `unread`, `get`, `costs`, `today`, `budget` | the errand service, the skills gateway, the status card | sync, from the list and spend records loaded once | the load is the database's `tasks.json` and `tasks.jsonl` under `db` |

Under `db` a store whose load failed is not kept: `get(guildId)` throws the coded error and tries again next time.

## The store's cache (`src/memory/store.js`)

Under `db` a cache entry of a memory unit (a profile, a private layer, a channel, the guild, lore, recent, a version
file, the diary, the voice queue, the buffer) is loaded from the database (`unitValue`): a unit the database does not
hold starts as a missing file does, a closed database throws `DB_CLOSED`. Whether a profile, a channel or a private
layer exists is the database's `files` row, and the forget markers are the database's. The operational files (the
process state, the GIF library, the vision cache, participation) are read as files. `memoryRead.value` (the read
switch) answers from the database alone under `db`: no disk check, a closed database throws.

## Other direct reads

- The store's directory ids (`listPrivate`, `countUsers`, `listUserProfiles`, `listChannels`): under `db` from the
  database only, no directory listing.
- `/nep resume`'s check of broken JSON files: under `db` only the operational files still written (process state,
  request dumps, the backfill folder, the vault and snapshots, the GIF library, the vision cache, participation,
  `memory-pending/`). The voice queue and the buffer are database units under `db` and are not checked.
- The embedder's catch-up: its forgets, private layers and day checks come from the database under `db`; its lines
  always come through `record.iterate`.

## The writers under `db`

Every row the writers make is the row their unit's mapper derives, through the sync's own path
(`src/memory/db/unit-write.js`), with the unit's path as `owner_file` and the next `position` of the unit; the unit's
`files` row is kept, so the export and the directory ids list it.

| Writer | Writes |
|---|---|
| `record.append` | each line as the record maps it in its day's unit; a revision (or deletion) the month already holds is a duplicate, as the id index says; a line the live observation wrote first is taken over in its place |
| the live observation (`memoryDb.observe`) | written into the line's record day (the handler waits for it), so a seen line is in the record before the analyzer's batch; an edit's revision is the database's |
| `journal.write` (every journal writer) | `day`, `decisions`, her answers' `sources` and `affinity_events` as the journal maps the line |
| `vectors.append`, `rewrite`, `replace` | the month's rows (appended to the stored month, or a new generation whole) |
| `store.setParticipation` | the file as always, and its episodes from each flush |
| `store.appendDiaryPost` | the diary flushed at once: the whole diary the store holds, with its mirror's `sent` publication (destination: the diary channel); `diary.json` is not written and its first load is the database's |
| every other cache entry of the store (its mutators unchanged) | a flush hands the entry's whole value to the outbox (op `value`), mapped as a sync maps the file, the rows it no longer holds retired; `media.json` is written as a file and also sent (the `media` rows) |
| the archive (`archive.append`, the store's queued appends) | the month's lines (op `lines`), with the retired `historical` claim of an item hot memory does not hold; the month's keys come from the database's lines; no segment and no id index is written; a failed write goes to the pending queue (`archive/pending.jsonl`, still a file) |
| the intention store | `intentions.json` whole (op `value`) and the records moved out (`intentions-archive.jsonl`, op `lines`), through the outbox |
| the task store | `tasks.json` whole (op `value`) and each transition line (`tasks.jsonl`, op `lines`), through the outbox |

The outbox (`src/memory/db/unit-outbox.js`) keeps a unit until its write resolved: a newer value replaces the one
waiting, lines keep their order, a failed write goes again at the next flush (the store's 30 s flush, the module
stores' `flush`). At shutdown (`store.flushSettled({ final: true })`, the module stores' `flush({ final: true })`)
what still fails is written to `data/memory-pending/<sha1 of the unit's path>.json` (`{ owner, op, value | lines, at }`,
logged as an error with the count), and the next start replays each file through the writer before anything reads
the database, deleting it once its write resolved. A replay that fails keeps its file and the database is not opened
(`PENDING_REPLAY`).
