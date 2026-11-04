# Memory

Everything the persona remembers lives in one SQLite file (`data/memory.db`), and the same file holds the task board and the archive of every model request. The engine uses Node's built-in `node:sqlite`, FTS5 for word and trigram search, and int8 vectors scanned in place. Storage has no npm dependency. This document is for someone who runs the database, reads her memory, or changes `src/memory/`.

Beside the database, her diary pictures and voice files sit under `data/media/diary/`.

## Core concepts

| Concept | What it is | Tables |
|---|---|---|
| Source | One observed or produced line: a message she saw (`seen`), her own line (`said`), a deletion (`deleted`), a feeling (`felt`), a whole memory-session answer, a diary entry's text. Carries a native id, revision, place, author, two timestamps (`occurred_at` for when it happened, `observed_at` for when the engine saw it), text, word stems, media, mentions, audience | `sources`, `sources_fts` (word index), `sources_tri` (trigram index), `source_relations` |
| Person | A human or the persona herself. An opaque id; her own row is `person:self` | `people`, `people_merges` |
| Account | An identity on one interface (a Discord user, or a handle on another interface). Linked to a person by an explicit, evidenced link: proposed, verified or revoked. Two accounts are never the same person because a name or avatar matches, and only the owner's `/memory bind` joins them ([One person, several accounts](#one-person-several-accounts)) | `accounts`, `account_person_links` |
| Participant | A poster known only inside a thread or site (a per-thread token, a display-name-only poster). Never a person unless her memory session promotes it | `participants`, `participant_links` |
| Place | Where lines live: a server, a channel, a thread, a DM conversation | `places`, `memberships` |
| Audience | Who may see a row: `none` (no source, visible everywhere), `group(<interface>)`, `dm(<DM place>)`, `internal` (never shown outward) | `audiences` |
| Claim | One thing she believes about a person, place or herself: a detail, interest, alias, in-joke, self fact, lesson or pattern. Carries how she knows it, a truth value, versions and evidence | `claims`, `claim_versions`, `claim_sources`, `claim_version_sources` |
| Description | A living text about a subject and field (a person's character, style, relationship; a place's purpose, topics, tone), in her words, versioned | `descriptions`, `description_versions` |
| Episode | A remembered moment between the persona and a person | `episodes`, `episode_sources` |
| Affinity | Her attitude to a person: a number from -100 to 100, moved by her memory session with a reason and a capped delta | `people.affinity`, `affinity_events` |
| Her day | Every turn, action, wake and system event. The journal's records of a turn hold its whole `<think>` | `day`, `decisions` |
| Request | Every model request with its whole system text, messages, tools, answer, think and usage. Never read by a turn or by recall, and never pruned | `model_requests` |
| Diary | Her diary entries (real or imagined), with media; interface posts are mirrors | `diary`, `diary_mirrors`, `publications`, `publication_grants`, `media` |
| Intention, work | Her intentions, and her errands as tasks of the task board's errand lane | `intentions`, `board_tasks`, and the errand archive `work` and `work_events` |
| Vector | A 1024-dimensional int8 embedding of a source or consolidated row (`text-embedding-3-large`) | `vectors`, `index_policy` |
| Graph | A derived projection of every typed row into nodes and typed edges (`authored_by`, `located_in`, `replies_to`, `about`, `account_of`, `published_as`, and others), with the audience of its source row | `graph_nodes`, `graph_edges`, `node_access` |

## Architecture

```
interface adapter                         engine core
─────────────────────────    ───────────────────────────────────────────
normalised event  ──────────▶ observe()                       ─┐
                               store cache                     ─┼─▶ unit outbox ─▶ writer worker ─▶ memory.db
her turn / inner turn / diary  record, journal, participation,  │    (one worker,
                               vectors, intentions, errands    ─┘     one transaction
her memory session ──────────▶ validated plan ─▶ session-write ──────▶ per write, graph
                                                                      projected in it)
readers ◀─ read connection ◀─ execution context (audience filter)
```

The database has one writer. Every write goes through a worker thread (`src/memory/db/writer-worker.ts`) that owns the database and holds one transaction per write, so the engine's main loop never holds a write transaction. Readers use a separate read-only connection.

`record`, `journal`, `archive`, `vectors` and the intention store expose public functions that read and write the database underneath. The store (`src/memory/store.ts`) keeps an in-memory cache of profiles, places, lore and other units, and a dirty unit flushes as a whole value through its mapper into rows.

The explicit `importCoreJsonState(handle, { dataDir })` entry in `src/memory/db/core-state-import.ts` copies legacy core JSON through a writable database handle. Root `state.json`, `usage.json` and `metrics.json` values use `operational` with `core-state-import` provenance in `files`. Existing unit writers map guild `inner`, `missed`, `participation`, `gifs` and `media` JSON. Values and markers commit in one transaction. Repeated imports skip completed units, preserve newer database values and leave source bytes unchanged. The memory service invokes this entry on its writer connection before replaying pending writes and exposing readers. `memoryDb.open()` is a readiness barrier without maintenance jobs. Core startup awaits it before constructing durable stores.

## Data model

Schema version 26 (`src/memory/db/schema.ts`; migrations are appended, never edited). The task board keeps its own tables in the same file with a version of its own (see [The task board's tables](#the-task-boards-tables)). Version 26 adds `model_requests` ([The request archive](#the-request-archive)). Version 14 renames the errand units (`guilds/<g>/tasks.json` and `tasks.jsonl` become `errands.json` and `errands.jsonl`) in every table that stores a unit path, and renames the errand fields of the open intention records. `currentUnitPath` in `src/memory/db/paths.ts` maps the old unit names on the way in, so a write that waited in `memory-pending/` across the upgrade lands in the current unit. Version 22 adds `skill_uses` and the `source` column of `skill_versions`, and deletes every row of `skill_evaluations`, `skill_versions` and `skills`, which only the engine's old tool registry had written.

`message_families` binds an interface, protocol conversation, message ID and generation to one observation family. `src/memory/db/message-families.ts` exposes `observeMessage` through the writer service. It validates the mapper's conversation descriptor and commits family allocation, observation and ingest receipt in one transaction. Generic `observe` retains its native tuple semantics. Core create and complete edit events use `observeMessage`, and deletion events use `deleteMessage`.

Participation evidence resolves by the episode conversation and interface in `src/memory/db/participation-sources.ts`. An unchanged message keeps its captured source revision when the episode is flushed after an edit. New evidence resolves to the stored source in its qualified family.

The normalized writer associates `ingest.source_id` with the exact source committed for an accepted event. Replaying that receipt returns its original source and revision, even after later edits. Older standalone receipts keep a null source. `deleteMessage` reserves or resolves the same family and writes an authorless tombstone with its receipt. The deletion keeps archival text and excludes the family from current reads. A later observation preserves that exclusion.

A normalized reply carries a trusted `messageReply` descriptor. The writer reserves its parent's family in that conversation before storing the relation. Source metadata keeps the raw reply locator under `$messageReply` for record export. An arriving parent resolves the waiting relation through the reserved family.

`RecordStore.append` accepts trusted per-line `messages` descriptors outside record JSON. The writer validates the line's native ID, conversation and optional observed source before creating a mapper identity. A matching observation keeps its canonical source and verified metadata while adopting record metadata. Qualified `newestRevision` queries use the family catalog. The inverse mapper exports raw message and reply IDs. Calls without descriptors retain the legacy record path.

`createMessageProducers` carries the door receipt beside the protocol event through the message handler, private gate, paused observation and edit and deletion handlers. `createObserve` uses the normalized writer for those events and for local calls without a receipt. Its fourth argument supplies the trusted accepted-event carrier. It claims that event's receipt before mapping and sends a copied ingestion row with the observation. Its deadline remains `memoryDb.observeTimeoutMs`, default `5000`, and receipt retention follows `memoryDb.ingestKeepDays`, default `7`. A timeout leaves the write pending without standalone acknowledgement. The carrier never enters a wire event or model argument. Partial edits and DM events without a named `partnerId` remain deliberately unobserved.


Schema version 23 adopts verified historical families without rewriting source IDs. The migration and recall share `src/memory/db/source-locator.ts` for locator provenance. All retained revisions participate, including retired sources. Conflicting family assignments refuse the migration with `CONVERSATION_CONFLICT` and roll back its schema changes. Unknown provenance remains uncatalogued. The dedicated writer also adopts verified families written after migration. Indexed queries select the requested message, then validation reads every retained revision of each candidate family. Unrelated conflicting history does not block a new family. The catalog is structural bookkeeping, included in whole-database backups and restores, and has no content graph projection.


Version 17 is a data step: it sets back what the unit sync wrote over her memory session's changes (`src/memory/db/session-repair.ts`). A claim takes the text and the last-seen time of her newest version, and the truth of a retire, and becomes hers. Her newest review becomes the current version of its description again, and a person she moved takes the reason of her newest move. Each repair applies only when her version is newer than the file's last change of the row: the claim's first or last seen time, the newest legacy description version, or the file's newest attitude move. The step asks no model and sends nothing, and one `decisions` row (`migration:v17:session_rows_repaired`) counts what it set back.

Version 18 adds the inner life's wake queue (`src/memory/db/wake-queue.ts`). A `wakes` row is one wake: `queued`, `running` under the lease `wake:<id>`, `handled`, or `slept` when it fell due while the core was down or paused. A `leases` row is a time-limited claim on a name, and its token rises with every grant, so a writer holding an older token is refused. A `deliveries` row is what a completed wake leaves to send, keyed by its effect key `<turnId>:<effectIndex>:<target>`. The data step moves each guild's `inner.json` queue, handled set and in-flight mark into `wakes` with their ids, then drops those fields from the file. Every later open that knows the data directory runs the same import for a file an earlier opener could not reach or write, and a file without queue fields is left as it is. A row the table already holds is never imported twice.

Version 19 adds `held` to `ingest`: the whole `message.received` event of a message that arrived while the core was paused, null for every other row (`src/behavior/core-pause.ts`). The door writes it with the event's row, before the ack, and the resume clears it once it replayed the message. A held row is never pruned.

Version 20 rebuilds `deliveries` with three more states and a `receipt` column (`src/memory/db/wake-queue.ts`). A row is `queued` when the wake's completion records it, `sending` from just before the inner life calls the port, then `sent`, `unknown` or `failed`. An `unknown` row is a send whose answer was lost and that the adapter could not tell, a `failed` one a send the interface refused. `receipt` keeps what the send answered: the ids of the messages it became, or its error code. The files of a held post are `media` rows of kind `delivery`, owned by the delivery's key, under `media/deliveries/`. Pruning deletes a delivery whose send is over together with its files, and then its wake ([Inner life](inner-life.md#a-wakes-sends)).

### Identity

| Table | What it holds |
|---|---|
| `people` | One row per known person; `person:self` is the persona |
| `accounts` | One row per account on an interface (a Discord user, a handle elsewhere) |
| `account_person_links` | Which person an account belongs to, with state (`proposed`, `verified`, `revoked`) and validity dates |
| `participants` | Posters known only inside a thread or site: a thread token, a site token, a post number, a display name, or nothing. Never a person unless her session promotes it |
| `participant_links` | Which account or person a participant is, with state and validity |
| `people_merges` | When one person turned out to be another (the writer refuses cycles; chains resolve to the final survivor) |
| `interfaces` | The integrations: `discord`, `cli`, `core` and any added by events |
| `authorities` | The namespaces of native ids: `discord/global`, one `discord/guild:<id>` per guild, `core/local`, `legacy/local` for old id spellings |
| `connections` | Adapter logins (do not define identity or audience) |
| `external_keys` | Every native and legacy id of each person, account, place and source, with generation (a reused native id is a new generation) and validity |

### Places and conversations

| Table | What it holds |
|---|---|
| `places` | Servers, channels, threads, DM conversations. Each declares its conversation kind: `dm`, `group`, or null for a container (a server, a category) |
| `memberships` | An account's nick, roles and display address in a server |

### Content

| Table | What it holds |
|---|---|
| `sources` | Every observed or produced line, with full-text indexes |
| `sources_fts` | FTS5 word index over `sources` (stems and text) |
| `sources_tri` | FTS5 trigram index over `sources` (text) |
| `source_relations` | What a line replies to, quotes, reposts, mentions, edits or refers to. A target not yet stored keeps its native key until the target arrives |
| `vectors` | One embedding per chunk, with the scope of its source line |
| `claims` | What she believes, with evidence, truth and versions |
| `claim_versions` | The history of a claim's text |
| `claim_sources` | Claim-level evidence (legacy; new evidence goes to `claim_version_sources`) |
| `claim_version_sources` | Per-version evidence: which lines support or conflict with each version |
| `descriptions` | Her living text about a subject and field |
| `description_versions` | Each revision of a description |
| `episodes` | Remembered moments |
| `episode_sources` | The lines an episode rests on |
| `affinity_events` | Each change of her attitude to a person |
| `day` | What she did, turn by turn |
| `diary` | Her diary entries |
| `diary_mirrors` | Where an entry made before schema v15 was posted on an interface |
| `mirrors` | The places the diary's entries are posted to, one row each, set up by the owner (schema v15) |
| `publications` | Every outward send of something of hers: the exact rendered text, its SHA-256 hash, the destination, the state and the receipts. Append-only; the content hash is immutable once set |
| `publication_grants` | The owner's exceptions allowing specific content to specific destinations |
| `media` | Pictures and audio she keeps |
| `intentions` | What she means to do |
| `work` | The archive of her errands that board version 3 moved to the board, neither written nor read by the engine |
| `work_events` | The steps of an archived errand |

### Internal bookkeeping

| Table | What it holds |
|---|---|
| `session_runs` | One row per memory-session request: scope, mode, cursor range, counts, outcome |
| `decisions` | Why the engine or she changed memory (proposals, rejections, quarantines) |
| `turn_reads` | Which rows each request carried, in which context and by which reader |
| `execution_contexts` | The contexts the engine issued for turns, sessions and wakes |
| `relationship_daily` | How often she and each person addressed each other per day and audience (counts, recounted from `sources`) |
| `focus_members` | Her current close and exploring sets |
| `focus_events` | Every change of those sets (append-only) |
| `focus_overrides` | The owner's pins and exclusions |
| `wake_runs` | One row per inner wake run |
| `wake_actions` | Each action of a wake run (append-only) |
| `skills` | Her skills by name, with lifecycle, active version, who activated it and her or the owner's switch ([Skills](skills.md)) |
| `skill_versions` | Each version of a skill: the content hash of its `SKILL.md`, the manifest of its tools, the text it was read from (`source`, schema v22) and its status (`candidate`, `active` or `retired`) |
| `skill_evaluations` | Evaluations of skill versions (append-only; no code writes it) |
| `skill_uses` | How her turns used a skill: one row per skill, version, turn and kind (`discovered`, `read`, `tried`, `succeeded`, `corrected`, `declined`), append-only (schema v22) |
| `index_policy` | The tier of each source line (`a`, `b`, `c`) and the touches that keep a vector alive (built, off by default) |
| `operational` | State files kept verbatim: the root state, usage and metrics, buffers, queues, the recall trace, backfill state, and the rows of the old request dump files |
| `ingest` | One row per event the core took from a client: the principal, its `seq`, the event id, kind and conversation, and when it was committed (schema v16). `source_id` names the exact normalized source committed with the receipt (schema v24). An event id and a `seq` are each unique within a principal. `held` keeps the event of a message the pause holds (schema v19) |
| `ingest_cursor` | The contiguous watermark of numbered events acknowledged to each principal (schema v16) |
| `wakes` | One row per wake of the inner life: its state, its lease, the turn id it runs under and its outcome (schema v18) |
| `leases` | Time-limited claims whose token rises with every grant: `wake:<id>`, `attention:*` or `attention:<conversation>`, and `core:alive` (schema v18) |
| `deliveries` | What a completed wake leaves to send, by effect key: `queued`, `sending`, then `sent`, `unknown` or `failed`, with the send's receipt (schema v18, states and `receipt` v20) |

### The task board's tables

The task board (`src/board/`) keeps eleven tables in `memory.db`, `board_tasks` through `board_agent_runs`, and its own version table, `board_schema_version` (`src/board/schema.ts`). Board version 2 gives `board_tasks` the columns `lease_generation`, `blocked_reason` and `unblocks` after the ledger's, the status `blocked`, the result kind `handoff` and the review decisions `accept` and `changes`. A task of version 1 starts at generation 0. `openMemoryDb` runs the board's migrations after the memory's, in a transaction of their own. When a board migration fails, the memory stays migrated, open and writable, the handle's `board.ok` is false, and every board operation answers `board-unavailable`. A read-only open migrates neither part. No graph projection, recall, export or sync reads the board's tables, and no foreign key joins them to her memory. How the board is used, restored and filled from a ledger's history is in [The task board](board.md).

Board version 3 is a data step (`MOVE_ARCHIVE_SQL` in `src/board/archive.ts`). Every `work` row of kind errand becomes a task of lane `errand` with the same id, and every `work_events` line of it a `status` event in line order, `queued` mapped to `approved` and `running` to `in_progress`. From then on the errands live on the board (see [Errands](errands.md#where-errands-are-kept)). `work` and `work_events` stay in the file as an archive that no code writes or reads. The unit writer (`src/memory/db/unit-write.ts`) accepts a write of an errand unit, `errands.json` or `errands.jsonl`, writes nothing and returns its count as `skipped`, and the memory service logs `memory db: errand unit skipped` with that count. An action line of an errand in her journal references its task: the `day` row's `work_id` holds the errand's id (`src/memory/db/map/journal.ts`).

### Structural

| Table | What it holds |
|---|---|
| `audiences` | The audience ids rows point at |
| `meta` | Cursors, switches and marks of the database |
| `files` | The signature of every memory unit the migration read |
| `co_owners` | Rows two servers' files both map |
| `schema_version` | The migrations applied |
| `graph_nodes` | One node per typed row (derived, rebuildable) |
| `graph_edges` | Typed edges between nodes, each with the audience of its source row (derived, rebuildable) |
| `node_access` | Which audiences may see each node, one witness per (node, audience, evidence) (derived, rebuildable) |

## Audiences and visibility

Every content row carries an `audience_id`. A read always names an execution context the engine issues; the audience filter runs inside the SQL query before any limit, count or ranking.

**Audience kinds:**

| Audience | Who sees it |
|---|---|
| `none` | A row with no source (an unprompted line, a self fact). Visible everywhere |
| `group(<interface>)` | Visible in every group and ordinary DM context, across interfaces |
| `dm(<DM place>)` | Visible only in that DM conversation and in the internal context |
| `internal` | Never shown in an outward context. Used for derived rows whose inputs come from incompatible audiences |

A group context reads source-free rows and every valid group audience. A DM context also reads its exact `aud:dm:<place>` audience. The groups-only context reads source-free and group rows. A trusted internal context reads everything. An interface name such as `cli` grants no internal access.

`src/memory/db/scope.ts` implements this rule in `allowed`, `whereFor`, `allowedAudience` and `audienceWhere`. Compatibility groups require a nonempty interface. Normalized groups require a nonempty `aud:group:` suffix. Both reject literal NUL characters and preserve encoded text such as `%00`. The identifiers retain source provenance. Compatibility DM matching requires both interface and partner, while normalized DM matching requires the exact conversation place. A partner triple cannot distinguish two explicit DM places with that same partner.

A derived row takes the intersection of its inputs' visibility through `narrowest` or `narrowestAudience`. Groups from different interfaces remain group-visible and retain the first group identifier as their stored representative. Any group combined with a DM becomes that DM. Different DM places, internal evidence and malformed provenance produce internal memory. Source-free evidence does not narrow visibility. Session claims, episodes and affinity events use this rule through `src/memory/db/session-write.ts`. Stored internal rows retain their existing audience.

The core issues an internal context for a live message authenticated as a CLI principal. `src/pipeline/` carries it separately from the event into the turn, including an in-memory busy queue. `src/turn/lookup.ts` separates prefetch results by execution context ID. Split attempts retain the supplied ID, and another turn receives its own context. `src/behavior/recall-run.ts` preserves that context through quoted search, anchor windows and automatic prefetch.

Database recall checks source audiences and requires the source's place to exist. Stored group evidence remains readable when its interface is offline or absent from the live conversation snapshot. Live interface searches and history pulls retain their own permission checks. Private place names remain hidden from ordinary outward reads, while group place names are visible across interfaces. These reads preserve source provenance and do not change the reply destination.

An issued internal turn restricts direct generated publication to its exact origin interface and conversation. `src/tools/publication.ts` binds publishing adapter methods without changing the shared adapter. The executor checks publishing calls before their operations or generators run. Returned attachments and direct turn effects use the same restriction. Read tools, deletion, reaction removal and the private CLI answer remain available. `conversation.read` in an issued internal turn passes every stored conversation and reads the record in that conversation's own community (`src/turn/in-turn-tools.ts`), while publication stays restricted to the origin. An explicit owner message command starts an ordinary turn at its destination without forwarding the caller's private transcript.

`src/tools/send-hold.ts` checks the restriction before accepting a held send. The persisted delivery payload retains the restrictive descriptor, never the issued read context. `src/behavior/inner/deliveries.ts` validates a present descriptor before sending and marks malformed or foreign-origin deliveries failed. Records without a descriptor retain their existing delivery behavior. Diary mirrors intersect their standing grant with the entry’s saved publication restriction, as described in [Diary](diary.md). Deferred task provenance has a separate publication contract.

Stored recall resolves authors through the source's exact account ID and places through its exact place ID. Native IDs shared by different interfaces do not share names. An account or group place in the reader's interface keeps its profile or snapshot naming precedence. Foreign accounts and places use their own stored names. A retired account retains its native ID and interface for attribution, while its stored name is excluded. An ordinary DM read hides its private place name before consulting a callback, while an internal read retains access to that name. Lines of kind `said` use the supplied persona name.

Database recall messages and quote entries carry exact source and place references separately from native message IDs. Search merges and ranks windows by source identity. A structured source anchor opens that exact non-retired source, including an opaque ID or a historical revision. A structured native anchor requires a verified interface, conversation and message locator. Raw anchor text succeeds only when one current source matches across source IDs and native keys. Every selection still passes the caller's audience check. Reply expansion resolves parents within the originating place and interface.

The protocol observation mapper stores a versioned `$messageLocator` in source metadata. The writer validates its dedicated envelope field and preserves the locator on repeated observations. Generic observation extras cannot issue this route. The record mapper derives a locator from a version-one record's actual channel and message ID, and omits internal metadata when rebuilding the record. Historic record rows require the recognized record-day layout and retained version-one identity. Sources without verified routing metadata remain readable through exact source references.

`issueContext` records policy version `2` for newly issued contexts. Existing context rows retain their recorded version. This eligibility rule has no configuration switch and leaves recall ranking and candidate limits unchanged.

## Writing memory

### 1. A message arrives

When a message comes in (live or through the start-up catch-up of the newest 50 per channel), the adapter's event becomes a versioned observation. `observe()` resolves the authority, place and author (an account or participant, never a person: promotion is her session's job), then writes the source with its audience, its relations and its graph projection in one transaction. A replay of the same native tuple writes nothing.

The interface of every id the core builds comes from the event's `iface` (`src/memory/db/ids.ts` takes it as its first argument). A Discord event gives the strings stored since the first import (`person:discord:<id>`, `discord:channel:<id>`, `src:discord:<message>:<revision>:<kind>`, `discord/global`), and an event of the command line or the fake gives `person:cli:<id>`, `src:fake:<message>:...` and so on. An observed account of the first generation, and an observed channel, guild or DM place, get the spelling the store's unit mappers write for their interface (`interfaceAccountId` and `interfacePlaceOf`), so a unit write that brings the row an observation made lands on it. The legacy record files and the migrations that read them name their namespace through `LEGACY_IFACE` in `src/memory/db/legacy-namespace.ts`. A member inside a stored text is the core's own token `<@id>` (`src/memory/mentions.ts`), whatever the interface, and a name written in the text is replaced with the current name when the text is shown.

The audience comes from the place's conversation: `group` becomes `aud:group:<interface>`, `dm` becomes `aud:dm:<place>`. Anything else becomes `aud:internal`.

The event door hands the observation the event's `ingest` row, and `observe()` writes it in the same transaction as the line, so the event and its line commit together before the interface gets its ack (see [Interfaces](interfaces.md#the-event-door)). `createIngestRecord` in `src/memory/db/ingest.ts` is the door's and the link's way to the record: it reads `ingest` and `ingest_cursor` on the read connection and writes through `memoryWrite`, with the kinds `ingest` and `ingest-ack`. While the database is not open a read finds nothing and a write is refused, so an event taken then is answered `failed`.

### 2. Her turn

Her turn writes her `said` lines with turn and operation ids, her day events, participation episodes and the turn's read record. The journal record of the turn keeps the model's `<think>` whole, with no length cap, and the journal never shows it back to the model (`src/memory/journal.ts`). The request itself is archived in `model_requests` ([The request archive](#the-request-archive)). A diary turn writes her entry as a `diary` row with its full text before anything is posted, and the diary's mirrors (`src/behavior/mirror.ts`) write one `publications` row for each mirror they post it to, through the same writer (`memoryWrite`, kind `publication`).

### 3. The embedder

The embedder (`src/memory/embedder.ts`) sends new lines to the embedding model in batches. An hourly catch-up (`CATCH_UP_EVERY_MINUTES`, 60) covers the last 72 hours (`CATCH_UP_HOURS`), so a line has its vector within an hour.

### 4. Code-made counters

`touchMemory` (`src/memory/update.ts`) writes per line: first and last seen timestamps, message counts, emoji use, address counts. No model is involved.

### 5. Affinity decay

Every stored attitude drifts toward zero at 0.04 per day (`RELATIONSHIP_LIMITS.decayPerDay` in `src/memory/text-limits.ts`). The sweep runs hourly (`sweepAffinityDecay` in `src/core.ts`), does nothing while she is paused, and counts only the time the persona was running: a gap of more than two sweep intervals is treated as downtime, and the gap is skipped. The decay is applied to both public and private scores by `src/memory/store.ts#decayAffinities`.

### The store, the outbox and pending writes

The store keeps an in-memory cache of profiles, places, lore and other memory units. A dirty unit flushes as a whole value through its mapper to the database. The outbox (`src/memory/db/unit-outbox.ts`) queues units for the writer: a newer value of the same unit replaces the one waiting; lines of a JSONL unit are appended in order. A failed write stays in the outbox and is retried at the next flush.

At shutdown, a unit the writer still cannot take goes to `data/memory-pending/` as a JSON file. At the next start, each pending file is replayed through the writer before anything reads the database. A replay that fails keeps its file and the database does not open (`PENDING_REPLAY`).

Observations that arrive before the database opens wait in a bounded queue (5000 entries). A shutdown writes the waiting ones before it closes. If the queue is full, the oldest is dropped with a warning.

### Her session's rows and the store's files

The store's cached profile and her memory session (`src/memory/db/session-write.ts`) both write through the database writer. A mapped row carries an `owner_key` referencing `storage_units`. The collection key contains its kind, subject, scope and any partition or selector (`src/memory/db/storage-keys.ts`). A session row has no `owner_key`. A claim she confirms, revises or retires loses its `owner_key` in the same transaction. A unit write preserves session-owned rows and skips their cached copies (`src/memory/db/upsert.ts`).

The catalog stores collection lifecycle and append positions (`src/memory/db/storage-units.ts`). Migration 25 preserves entity IDs and references while assigning neutral ownership keys. `legacy_unit_aliases` maps imported paths to catalog identities, and retained `owner_file` values describe historical provenance. They do not select active ownership.

The profile the store reads (`unitRows` in `src/memory/db/export.ts`) holds the file's rows and, in the file's scope, the rows her session wrote about the person (`src/memory/db/session-rows.ts`): the claims she shows (truth `current` or `disputed`), her episodes and her attitude moves. The public profile takes the group of the person's interface, the private layer the DM with the person. Her claims and episodes follow the file's in the order she made them, and her moves join the file's history by time, each with its event id as the `itemId`. A description shows the version its `current_version` names.

A person's attitude and a description keep columns of both writers. Her last move of an attitude is her newest `affinity_events` row about the person, and the profile names it as `affinity.moveId`. A file that names an older move was read before her later ones. Its write keeps her reason, and its score is the file's score plus her later moves, clamped to -100..100, so a decay tick in the cache and her move both count. A file that names no move leaves her score, reason and decay stamp as they are. When a description's current version is a review, it stays current while the file brings the review's text or its own earlier text. A file that brings a new text makes its own version current again.

When her session moves someone's attitude, `noteAffinityMoves` in the store drops that member's cached profile, whatever interface the person id names. A clean entry goes at once, a changed one once its write has landed, and the next read takes the database's profile with the moves in its history.

## Her memory session

No helper model decides what the persona remembers. She decides herself, in a session of her own that runs on the `memory` model role.

While `keys.json` exists its key is the one the key ring routes `memory` to, the extra key the role is bound to or the core key in use ([Keys](keys.md#the-core-keys-and-the-ring)). Without the store the key is the `.env` variable that `llm.keyByRole.memory` names. Without a key, the session refuses to run.

### The writer's path

The session's request goes out on one of two paths, which `memoryWriterClient` (`src/subharness/memory-writer.ts`) reads from `subharness.memory` of `keys.json` at every request. With no record it takes the direct path, a request on the `memory` role's key. `/model set memory --via <backend> <model> [--effort <level>]` moves it to the subharness path after one reply on that model and effort, and `/model set memory <model>` brings it back once the direct model passed its check (`src/subharness/memory-path.ts`). Only `codex` and `claude` carry the writer, because `opencode run` takes no system prompt of its own.

On the subharness path the request is one run of the backend installed in the private layer, with no tools. `claude -p` gets the system text as `--system-prompt`, the batch on stdin and `--output-format json`, and the answer is the envelope's `result`. `codex exec` runs `read-only` whatever the agents' modes are. It gets the system text, a blank line and the batch on stdin, and writes its answer under `--output-schema` as one JSON field, `answer`. Either answer goes to the same `parseSessionAnswer`. A run that is refused (`subharness-off`, `not-installed`, `timeout`, `exit-<n>`, `empty-answer` or `backend-error`) is recorded like a failed request: outcome `llm_error`, the error `llm:<code>`, and the batch waits for the next sweep. The usage store counts a subharness run under `memory` with its tokens at cost 0 and no key, and the direct path is counted by the `llm: usage` line like every role. The description reviews stay on the direct path.

### The memory probe

`createMemoryWatch` (`src/subharness/memory-probe.ts`) probes the writer's path at core start, every `memory.probeMinutes` (default 30) and right after a refused writer run. On the direct path the probe is the request `/keys check memory` sends. On the subharness path it is one one-word reply through the backend, because the subscriptions' five-hour and weekly limits cannot be read. A failed probe while she runs pauses her with the reason `memory-down`, shown on `/status`, and the interfaces stay connected and answer nothing. The next passing probe resumes her. Neither touches a pause of another reason, so the owner's pause and `no-core-key` stay as they are. While `memoryDb.session.mode` is not `apply` there is no writer to probe, and the probe passes.

### Schedule

Controlled by the `memoryDb.session` config block. A scope (the public channels of an interface together, or one DM conversation) sweeps when:

- at least `minMessages` (default 5) settled lines sit after its cursor
- ten minutes have passed since the newest of those lines (a constant, `DEFAULTS.settleMinutes` in `src/memory/db/session.ts`)
- the join rule below says write
- `everyMinutes` (default 60) have passed since the last sweep of this scope, or the scope has `maxMessages` (default 200) waiting lines

One sweep at a time. At most `sweepsPerScopePerDay` (default 24) sweeps of one scope per UTC day.

### Small sessions wait

A session is a run of settled lines in event time; a gap of ten minutes or more starts the next one. `joinOf` in `src/memory/db/session.ts` decides from the lines after a scope's cursor, first match winning. A scope is written when `minLines` is 0 (default 0, which writes every session at once), when one session holds more than `minLines` lines, when the joined lines reach `batchLines` (default 30), or when the oldest waiting line is `maxWaitHours` old (default 24). Otherwise the scope waits: the sweep reports `waiting` for it, sends no request, writes no `session_runs` row, leaves the cursor and the sweep count alone, and `dueScopes` in `src/memory/db/writer-switch.ts` does not list it. The waiting lines go out with the next batch of the same scope, so none is dropped. A group and each private conversation wait on their own and never join each other.

### The batch

Lines are read by arrival from the cursor (none is skipped), shown in event time. When a batch holds more people than `maxPeople` (default 12), the same lines are sent again with the next page of people, one request per page.

### What she receives

Her own system text (card, rules), then `prompts/memory-session.md`, then her self claims, the places with handles, the people of the batch with their profiles (the same rendering her turns use), open episodes, open intentions, and the batch lines. The stable blocks come first and the batch lines last, so the provider's prompt cache can serve the system text and the stable blocks on the next run of the scope (the sweep asks for the cache marker with `cache: true`). Each run records `counts.sessions`, the sessions the batch joined, and `counts.cacheRead`, the tokens the provider read from its cache (`0` when it reports none).

### What she may answer

Her answer holds claims to add, confirm, revise or retire, episodes, attitude moves (a delta with a reason and sources), flags that send a description to review, and `people:add`, which promotes an account or participant that spoke with her on two days, in a DM, or that she wants to remember.

### Validation

The engine checks every part of her answer against what it sent. Every source must be a line of the batch. Reasons are required for revise, retire, attitude and flags. A place claim must name its place. A claim edit carries the version it saw as a base (compare-and-set): a stale base is refused.

### Idempotency and the cursor

Applying is idempotent per batch: a retried batch applies nothing twice (a unique index on the batch key among applied runs enforces this). The cursor moves by compare-and-set in the same transaction as the last write. A batch where every operation was dropped stays pending; after `retryLimit` (default 3) tries it is skipped, the cursor moves, and a `decisions` row records why.

### Description reviews

She reviews a flagged description in two calls (draft, check) at most `reviewsPerDay` (default 6) per day. The version advances only on apply, with a version-conflict check. The review keeps its exact evidence.

## Reading and recall

### Prompt blocks

A turn's memory blocks (profiles of the people present, place notes, lore, recent lines, participation, self facts) come from the store's cache, populated from the database.

### Recall

Recall is the search behind the persona's `memory.search` tool and the automatic prefetch that runs before a turn. It reads only what the execution context allows: the audience filter runs inside every query, before any limit, ranking or scoring.

The turn registry in `src/turn/calls.ts` keeps the exact stored source behind each displayed `#N` handle. `src/tools/executors.ts` carries that identity separately from model arguments into anchor reads. The recall runner applies the current audience rules again when opening the source. Lines removed by quote limits receive no usable handle.

SQLite recall removes visible history by exact source identity or a verified interface, conversation and message locator. `src/behavior/recall-run.ts` derives these exclusions for group, private and CLI turns. Stored metadata takes precedence over native metadata. Ordinary history uses the trusted conversation reference supplied by the turn. Malformed metadata excludes nothing and cannot fall back to an unqualified message ID.

The database reader resolves exclusions once per read. An explicit exclusion list replaces the compatibility native-ID set, including when the list is empty. Compatibility IDs require exactly one current source in the execution context's interface. Internal contexts ignore unqualified exclusions. `src/turn/lookup.ts` separates prefetch results by both the conversation reference and the execution context ID. The legacy record search retains its separate exclusion contract.

Cached `web.read` and `media.look` calls in `src/turn/in-turn-tools.ts` select the quoted source by its exact ID. They never substitute a current conversation message with the same native ID. Native references match the interface, conversation and message together and refuse ambiguous matches. Live message actions require a verified locator on the current interface. A stored source without that route remains readable as memory but cannot name a live action.

**Four search streams:**

| Stream | How it works |
|---|---|
| Words | The plan's forms as stems (learned from the database's own text by `src/memory/db/stems.ts`, the same stemmer that stamped `sources.stems`) through `sources_fts`. A one-word form is a word match; a longer form is a phrase match. Ranked by BM25 |
| Trigrams | A form the word stream finds nothing for, searched as a substring through `sources_tri`. Catches typos and stems the learned endings did not cover |
| Meaning | The stored vectors within the context's scope. A plain scan with cosine similarity on the int8 rows (the question's embedding is the caller's). Candidates limited to 40 (`RECALL_DEFAULTS.db.candidates` in `src/behavior/recall.ts`) |
| People | The lines of the members the plan's name forms point at |

The streams are fused by reciprocal rank (k=60). A relevance gate drops hits far below the best. The rest are ranked by closeness to the plan's date range when one exists; without a date, by what terms a hit holds.

Around the best hits the search builds a window of the reply chain, context lines on each side, then the conversation followed forward while it continues (`RECALL_DEFAULTS.followMessages`, 24 lines, up to the first silence longer than `followGapMinutes`, five minutes). Windows that share a line are merged.

A group context that has a better match only in the querier's own DM gets a `hidden` marker and nothing else, with no text and no count.

### Prefetch

The automatic prefetch (`src/behavior/prefetch.ts`) runs before a turn the persona will answer. It searches the record and the meaning index with the triggering message, without any model choosing the query. The terms come from the message's rarest words and phrases (by document frequency in the record). Short or deictic triggers also pick up the lines just before them. Trivial triggers (a greeting, a bare "ok") are not searched.

The prefetch keeps only hits that pass a relevance threshold (a rare phrase, two distinctive terms, or one term confirmed by its cosine score), fuses the lanes by reciprocal rank, and returns a few excerpts under a token cap.

## Nothing is forgotten

There is no forget path, no wipe command, no way to delete memory rows through the engine. Precision falls through tiers: the context window is the most precise, then word search, then meaning search, then the journal. Rows leave hot memory through caps, but the archive (`src/memory/archive.ts`) keeps a copy before anything is removed, and the record (`src/memory/record.ts`) holds every line for good.

A retired row keeps its history. The owner's command line edits three small lists by hand: `/memory lore remove` takes one lorebook entry out, `/memory aliases remove` one alias of a member, and `/memory lessons remove` one lesson. Nothing in the engine removes a claim, an episode, a line or a request.

## The request archive

Every model request is a row of `model_requests` (`src/memory/db/request-archive.ts`), kept for later review and never read by a turn or by recall. No setting governs it and nothing prunes it: the table keeps every request, and the daily backup and `restore-tables --part memory` carry it with the rest of the file.

`archivedLlm` in `src/llm/archive.ts` wraps the core's chat client and the memory writer's client. That covers her turns and their tool steps, the memory session on either path, the analyzer, quick search, the media describer, routing, participation and speech preparation. The wrapper writes the row as `pending` before the request goes out and waits for the write, so a request the provider saw is on disk. The row holds the whole system text, the messages, the tools and the tool choice, the role, model and purpose, and the turn, attempt and step that `withRequestMeta` opens for each turn. The wrapper then closes the row `ok` with the answer, its `<think>` block, the tool calls and the usage, or `failed` with an error code. A failed archive write is logged and the call goes on.

A picture in a message is stored as an `image_marker` with its message id and byte size, and the media tables hold what was kept of the picture. Embeddings and picture generation do not pass the chat client and are not archived. A subharness agent's run keeps its native session under `<private>/subharness/<backend>/home/` instead.

When the database opens, a row a dead process left `pending` becomes `unknown`, so no answer is invented and nothing is sent again. The old request dump files under `journal/requests/` are read in once, each by its path, with `source` set to `dump`. A dump whose shared tools file is gone keeps its row with the error code `tools-file-missing`, and an unreadable dump is counted and skipped (`importRequestDumps`). The files are inputs of that import only, and no module writes them. A live row has `source` `live`.

## What stays as files

Root state, usage and metrics use `operational` rows with their existing JSON shapes. Guild inner state, missed messages, participation, GIFs and media descriptions use their existing unit mappers. `store`, inner, missed, usage and metrics read the supplied database without a file fallback and save through `writeUnit`. Shutdown waits for their existing save and flush methods before closing the database. The GIF library and media descriptions remain caches with their existing versions and retention.

The remaining operational files are listed by `OPERATIONAL_PATTERNS` in `src/memory/db/paths.ts`:

- Per-guild `state.json`, `usage.json` and `metrics.json`, and private operational state
- `recall-trace.jsonl`
- `journal/.running` (the running marker) and `journal/requests/` (the old request dump files, read once into `model_requests` and never written again)
- The backfill folders and `record/backfill.json`
- `archive/pending*.jsonl` (the archive's pending queue)
- `vault/`, `snapshots/`
- `memory-pending/` (unit writes a shutdown could not complete)
- `media/diary/` (her diary pictures and voice files)
- `media/deliveries/` (the files of a wake's held posts until they are sent and pruned)
- `memory.db*` (the database's own files)

Everything else (profiles, places, channels, lore, the record's day files, the journal's day files, the archive months, vectors, intentions, errands) lives only in the database.

## The derived graph

The graph (`graph_nodes`, `graph_edges`, `node_access`) is entirely derived from the typed tables. The manifest (`src/memory/db/graph-manifest.ts`) names every node kind and every edge predicate, and says which typed table and columns each comes from. Every write transaction projects the affected rows into the graph at the same time.

`scripts/memory-db.ts rebuild` drops the graph and builds it again from the typed tables. An edge retired because its source row no longer produces it is history the typed tables do not hold; a rebuild does not bring it back.

Each edge carries the audience of the row it came from. `node_access` holds one witness per (node, audience, evidence): a node with its own audience (a source, a claim) witnesses itself; every live edge witnesses both of its ends. `src/memory/db/graph.ts` applies `audienceWhere` independently to each edge and to node witnesses. A graph walk follows only readable edges and reaches only nodes with a readable witness. A visible node does not expose its private edges.

## Operations

### Backups

`scripts/memory-db.ts backup` (or the service's daily job at `memoryDb.backup.hour` UTC, default 3, when `memoryDb.backup.enabled` is on): `VACUUM INTO` a copy, the diary media, and a manifest with SHA-256 hashes of every file, the schema version, the engine commit and the row count of every table. The newest `memoryDb.backup.keep` (default 7) backups are kept; older ones and unfinished ones are pruned.

### Restore

`scripts/memory-db.ts restore --from <backup> --db <target>` checks every file in the backup against its manifest, copies the database (which must not exist, nor its WAL or SHM files), copies the diary media under the data directory, and checks the restored file's schema version and row counts.

### Restoring one part

The board and her memory share the file, and `scripts/memory-db.ts restore-tables --part board|memory --from <backup> --db <file>` brings one of them back from a backup while the other stays as it is. It checks the backup against its manifest, takes the writer lock and replaces, in one transaction, every `board_*` table (`--part board`) or every other table (`--part memory`) with the backup's. A memory restore drops the triggers for the copy and makes them again, rebuilds the full-text indexes from the restored lines and checks the foreign keys before it commits. It refuses, and changes nothing, when the part's schema version in the backup differs from the file's, when the bot holds the lock, or when the backup fails its manifest.

### Restore test

`scripts/memory-db.ts restore-test --from <backup>` proves a backup in a temporary directory by restoring it and verifying that everything matches.

### Inspection

| Command | What it does |
|---|---|
| `scripts/memory-db.ts stats` | Row counts per table, per scope kind, per audience |
| `scripts/memory-db.ts hash` | Content hash (SHA-256) per table, to verify round-trip integrity |
| `scripts/memory-db.ts reproject` | Re-projects every typed row into the graph |
| `scripts/memory-db.ts rebuild` | Drops and rebuilds the graph and full-text indexes |
| `scripts/memory-db.ts index-policy` | Shows (or with `--apply` writes) the tier of every line and which vectors would be evicted |
| `scripts/memory-db.ts media-check` | Checks which diary media files are present or missing |
| `scripts/memory-db.ts board list` | Every task of the board, read-only, also while the bot runs (`--json` prints the answer of `task.list`) |
| `scripts/memory-db.ts board show <id>` | One task with its dependencies, attempts, questions, reviews, results, comments and latest events (`--json` prints the answer of `task.show`, its latest handoff included) |
| `scripts/memory-db.ts board verify-errands` | Every errand of the `work` archive compared with its board task field by field, read-only; exit 1 on any difference (`--json` prints `{ checked, mismatches: [{ id, field }] }`, the field `missing` for an errand with no task) |
| `scripts/memory-session.ts` | Runs her memory session once, in shadow, on a copy of the database |
| `scripts/recall-eval.ts` | Recall against questions with known answers |

### A read-only copy

You can copy `memory.db` and its `-wal` file while the bot runs (the copy will not be locked). Open the copy; a read-only open of the live file cannot apply the WAL.

## One person, several accounts

A person may hold any number of accounts on any interfaces, the owner and the persona included. Four subcommands of `/memory` in the owner's command line manage them (`src/interface/commands/console.ts`):

- `/memory bind <iface> <account> <iface> <account>` joins the first account to the person of the second.
- `/memory bind <iface> <account> self` joins an account to the persona herself, `person:self`.
- `/memory unbind <iface> <account>` closes the account's link and gives the account back its own person, `person:<iface>:<account>`.
- `/memory accounts <iface> <account>` lists the verified accounts of the person that account belongs to.

A binding is a verified `account_person_links` row with the reason `owner command`, written through the memory writer (`applyPersonLinkWrite` in `src/memory/db/person-links.ts`). Each account named must be one she has met. For an unknown account the command refuses and says to bind it after its first message. No model proposal, name match or claimed id links accounts. A DM context carries the person's other DMs in `linked` (`linkedDmScopes`), so a DM reads the person's history while each row keeps the audience of the DM it came from. Affinity is one score on the `people` row, and an affinity event keeps its scope. The same native id on two interfaces is two accounts until the owner binds them.

## Configuration

The memory system reads these config groups from `config/config.json` and `config.local/config.json`. [Configuration](configuration.md) lists every key.

| Group | What it controls |
|---|---|
| `memoryDb` | The database file, the session's schedule and limits, backups, the observation timeout, how long receipts are kept |
| `recall` | The search's timeout, output and memory tokens, record days, the `db` subgroup (vector days, touch days, eviction, re-embedding), the `prefetch` subgroup (deadline, tokens, word lists) |
| `embed` | Embedding dimensions |
| `memory` | The vault directory, the main channels and the memory probe's interval `probeMinutes` (default 30) |

The other measures of memory are constants in the module that reads them: the capture's `CAPTURE_DEFAULTS` in `src/memory/db/observe.ts`, the graph walk's `DEFAULTS` in `src/memory/db/graph.ts`, `FOCUS_DEFAULTS` in `src/memory/db/focus.ts`, the embedding queue's in `src/memory/embedder.ts`, and `MEMORY_LIMITS`, `RELATIONSHIP_LIMITS` and `LORE_LIMITS` in `src/memory/text-limits.ts`.

Two switches gate memory behaviour:

| Switch | Default | What it gates |
|---|---|---|
| `memoryDb.session.mode` | `"off"` | Her memory session (`"off"`, `"shadow"`, `"apply"`) |
| `memoryDb.backup.enabled` | `false` | The daily backup job |

## Built but off

| Feature | Switch | State |
|---|---|---|
| Vector eviction (drop bytes of old, uncited vectors) | `recall.db.vectorEviction` | Built, off |
| Re-embedding on touch | `recall.db.reembed` | Built, off |
| Foreign capture (threads, boards) | The schema holds the capture tables, and no adapter emits capture events | Built, no adapter |

## Appendix: who may read each table

Every table of the memory database (`data/memory.db`, schema `src/memory/db/schema.ts`) is in one of four classes.
A read of the persona's memory always names a context (a group of an interface, one DM conversation, or internal);
the class says how a row's visibility in that context is decided.

An audience-scoped row carries its own audience (`audience_id`, and the scope columns `scope_kind`, `scope_iface` and `scope_dm` that it replaces). Group and DM contexts read `aud:none` and every valid `aud:group:<interface>`. A DM context also reads `aud:dm:<its DM place>`, and only the trusted internal context reads `aud:internal`. The groups context of the diary's entry (`groupsContext` in `src/memory/db/scope.ts`) reads source-free and group rows.

A row that inherits from a parent has no audience of its own and is read only through its parent row, with the parent's audience.

An internal-only row is never shown in an outward context, a group or a DM. It is the persona's own bookkeeping.

A structural row is identity or bookkeeping that holds no remembered content by itself, such as ids, names of namespaces and file signatures. Where a structural row has a name a context may not see, the table below says so.

The full-text tables' own storage tables (`sources_fts_*`, `sources_tri_*`) belong to `sources_fts` and `sources_tri`.
`tests/memory-db-v7.test.ts` reads the table below and fails on any table of the schema it does not list.

| Table | Class | Note |
|---|---|---|
| `sources` | audience-scoped | every observed or said line, her answers and her session answers (internal) |
| `sources_fts` | inherits from sources | the word index; a search joins back to `sources` and filters there before any limit |
| `sources_tri` | inherits from sources | the trigram index, as `sources_fts` |
| `source_relations` | inherits from sources | what a line replies to, quotes, reposts, mentions, edits or refers to; read with the replying line's audience, and the target line keeps its own |
| `capture_bundles` | inherits from sources | the context stored around one line in a foreign place, read with the audience of its anchor line |
| `capture_members` | inherits from capture_bundles | the lines of a bundle and their roles; each line keeps its own audience |
| `capture_events` | inherits from capture_bundles | each step a bundle grew by, with the coverage after it (append-only) |
| `vectors` | audience-scoped | one embedding per chunk, with the scope of its line |
| `claims` | audience-scoped | what she holds true about a person, a place or herself |
| `claim_versions` | inherits from claims | the history of a claim |
| `claim_sources` | inherits from claims | the lines a claim rests on (each line keeps its own audience) |
| `claim_version_sources` | inherits from claim_versions | the lines each version of a claim rests on, or that speak against it; rows copied from `claim_sources` by the migration to schema 9 are marked `legacy` |
| `descriptions` | audience-scoped | her account of a subject in one field |
| `description_versions` | inherits from descriptions | the texts of a description |
| `episodes` | audience-scoped | remembered moments |
| `episode_sources` | inherits from episodes | the lines an episode rests on |
| `affinity_events` | audience-scoped | each change of her attitude to a person |
| `day` | audience-scoped | what she did, turn by turn |
| `diary` | audience-scoped | her diary entries |
| `diary_mirrors` | inherits from diary | where an entry made before schema v15 was posted |
| `mirrors` | internal-only | the places the diary's entries are posted to, an enabled row being the owner's grant for every entry to its place |
| `publications` | internal-only | every outward send of something of hers: the exact text and its hash, the destination, the context, the grant, the state and the receipts; what was sent is read outward through the lines it became, never through this table |
| `publication_grants` | internal-only | the owner's exceptions: one content hash of one row allowed to these destinations |
| `media` | audience-scoped | pictures and audio she keeps, with the audience of what they belong to |
| `intentions` | audience-scoped | what she means to do |
| `work` | audience-scoped | the archive of her errands, moved to `board_tasks` by board version 3 |
| `work_events` | inherits from work | the steps of an archived errand |
| `session_runs` | internal-only | one row per memory session request; its audience names the scope the run read |
| `decisions` | internal-only | why the engine or she changed memory (proposals, rejections, quarantines) |
| `turn_reads` | internal-only | which rows each request carried, in which context and by which reader |
| `execution_contexts` | internal-only | the contexts the core issued for turns, sessions and wakes |
| `relationship_daily` | internal-only | how often she and each person addressed each other, per day and audience (counts only, recounted from `sources`) |
| `focus_members` | internal-only | her current close and exploring sets; only the focus code and her internal wakes read it (`src/memory/db/focus.ts`) |
| `focus_events` | internal-only | every change of those sets, every challenge and its end (append-only) |
| `focus_overrides` | internal-only | the owner's pins and exclusions |
| `wake_runs` | internal-only | one row per inner wake run: its kind, state, the ids and versions its view showed, the envelope's policy version and the outcome |
| `wake_actions` | inherits from wake_runs | each action of a run once, keyed by the run and its number |
| `index_policy` | internal-only | the tier of each stored line (by its graph node), why, a pin, and how long a touch lasts; derived from the typed tables |
| `skill_evaluations` | internal-only | the tests, trials, outcome reviews and audience checks of each skill version, with the hashes they evaluated (append-only); the evidence they name keeps its own audience |
| `skill_uses` | internal-only | which skill of her index a turn showed, read, tried, finished or set aside, by turn id (append-only) |
| `capture_watches` | internal-only | when a bundle is looked at again, and how that went |
| `operational` | internal-only | state files kept verbatim (root state, usage and metrics, buffers, queues, the recall trace, backfill state, the rows of the old request dump files) |
| `model_requests` | internal-only | every model request: its whole system text, messages and tools, the answer, its think, the tool calls, the usage and the outcome; no index reaches recall |
| `board_schema_version` | internal-only | the version of the task board's tables |
| `board_tasks` | internal-only | one row per task of the board |
| `board_dependencies` | internal-only | which task waits on which, and how |
| `board_attempts` | internal-only | each run of an agent on a task, with its accounting |
| `board_questions` | internal-only | the questions a task's holder asked and their answers |
| `board_reviews` | internal-only | the approvals of a task's plan, merge and deploy, and the `accept` and `changes` of its review |
| `board_results` | internal-only | what a task produced: handoffs, summaries, diffs, pull requests, files, prompts and specs |
| `board_comments` | internal-only | the comments on a task |
| `board_events` | internal-only | every change of the board, in one sequence |
| `board_outbox` | internal-only | what the board has to tell a principal, until it is pulled |
| `board_idempotency` | internal-only | the stored answers of the mutations that carried an idempotency key, for 24 hours |
| `board_agent_runs` | internal-only | one row per turn of an agent outside any task |
| `people` | structural | one row per person (hers is `person:self`); the attitude columns mirror the public profile, the DM attitude lives in `affinity_events` |
| `accounts` | structural | one row per account on an interface; names are what the interface shows everyone |
| `account_person_links` | structural | which person an account belongs to, with its state (proposed, verified, revoked) and validity |
| `participants` | structural | posters known only inside a thread or a site (a thread token, a site token, a post number, a display name or nothing), never a person by themselves; the display name is what the place shows everyone there |
| `participant_links` | structural | which account or person a participant is, with its state and validity |
| `people_merges` | structural | which person was found to be another one, when, by whom and why |
| `places` | structural | servers, channels and DM conversations; a DM place's name is read only by the internal context |
| `memberships` | inherits from places | an account's nick, roles and address in a server |
| `interfaces` | structural | the integrations (`discord`, `cli`, `core`, ...) |
| `authorities` | structural | the namespaces of native ids (`discord/global`, `discord/guild:<id>`, `legacy/local`, ...) |
| `connections` | structural | the adapter logins; they never define identity or audience |
| `external_keys` | structural | native and legacy ids of each node, with generation and validity |
| `audiences` | structural | the audiences rows point at |
| `meta` | structural | cursors, switches and marks of the database itself |
| `files` | structural | the signature of every memory file the sync read |
| `co_owners` | structural | rows two servers' files both map |
| `schema_version` | structural | the migrations applied |
| `skills` | structural | her skills by name, the active version, the lifecycle, the switch and who activated the version; the skill files stay in the repository and the private layer |
| `skill_versions` | structural | each version of a skill: its content hash, manifest hash, the commit `skill-file`, status, manifest and the text it was read from |
| `graph_nodes` | structural | one node per typed row of a node kind (derived, rebuildable); whether a context may see a node is `node_access`'s answer |
| `graph_edges` | audience-scoped | the edges between nodes, each with the audience of the typed row it came from (derived, rebuildable); a walk follows only edges the context may read |
| `node_access` | internal-only | which audiences may see each node, one witness row per node, audience and evidence (derived, rebuildable); the walks read it, nothing shows it |
