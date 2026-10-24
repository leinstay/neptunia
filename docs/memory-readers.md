# Memory readers: the file and database contract

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

- **Authority.** Fixed for the process: the service reads `memoryDb.authority` once at start and the modules ask it
  (`memoryDb.authority()`), never the config. A later change is logged as `memory db: authority change needs a
  restart` and ignored by the readers, the writers, the sync and the status alike. Under `db` the service opens the
  database only when `memoryDb.read`, `recall.backend: db` and `memoryDb.observeLive` are on (otherwise
  `memory db: start refused` with a code, and every read is `DB_CLOSED`).
- **No fallback under `db`.** A closed database (`DB_CLOSED`) or a failed query is an error to the caller, logged
  once as `memory db: read failed` with the reader's name and the code. No function reads a file then.
- **Read-after-write.** Database writes go through the service's writer thread. A write is visible to the next read
  of the same process once its promise resolved (the read connection sees every committed transaction). Under `db`
  the record's, the journal's and the meaning index's writers write the database only (`memoryDb.writeUnit`, see
  "The writers under `db`" below), so a read after an awaited write finds it; the intention and task stores and the
  store's other files still write their files in this stage.
- **Forgets.** Members under a forget marker (`forgetting/<id>.json`) are hidden by the same rule on both sides;
  under `db` the markers and the deletion ledger are read from their operational rows.
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

## Other direct reads

- The store's directory ids (`listPrivate`, `countUsers`, `listUserProfiles`, `listChannels`): under `db` from the
  database only, no directory listing.
- `/nep resume`'s check of broken JSON files: under `db` only the operational files still written (process state,
  request dumps, the backfill folder, the vault and snapshots, the GIF library, the vision cache, participation).
- The embedder's catch-up: its forgets, private layers and day checks come from the database under `db`; its lines
  always come through `record.iterate`.

## The writers under `db`

Every row the writers make is the row their unit's mapper derives, through the sync's own path
(`src/memory/db/unit-write.js`), with the unit's path as `owner_file` and the next `position` of the unit; the unit's
`files` row is kept, so the export and the directory ids list it.

| Writer | Under `db` | Under `json` |
|---|---|---|
| `record.append` | each line as the record maps it in its day's unit; a revision (or deletion) the month already holds is a duplicate, as the id index says; a line the live observation wrote first is taken over in its place | the day files and id indexes, plus the shadow of `said`, `deleted` and `felt` lines (an observation-shaped row the sync adopts) |
| the live observation (`memoryDb.observe`) | written into the line's record day (the handler waits for it), so a seen line is in the record before the analyzer's batch; an edit's revision is the database's | no owner; the sync adopts it |
| `journal.write` (every journal writer) | `day`, `decisions`, her answers' `sources` and `affinity_events` as the journal maps the line | the day file; the sync mirrors it |
| `vectors.append`, `rewrite`, `replace` | the month's rows (appended to the stored month, or a new generation whole) | the month's files |
| `store.setParticipation` | the file as always, and its episodes from each flush | the file |
| `store.appendDiaryPost` | the post appended to the diary the database holds, with its mirror's `sent` publication (destination: the diary channel); `diary.json` is not written and its first load is the database's | the file |

## Known differences on the same snapshot

- `record.stats` and the journal's `stats` are not compared: the files count from the id indexes and modification
  times, the database from the lines it holds, and the sync never imports the lines of a member under a forget
  marker or in the ledger.

## Checking parity

`node tools/memory-db.mjs reader-parity --data <dir> --db <file> [--days N]` creates every module over the files and
over the database of one frozen snapshot and compares the reads above with fixed parameters, per guild and private
layer. It prints `compared / equal / differ` per function and the first differences as key paths, and exits 1 on any
difference. It refuses data a live process holds unless `--live`.
