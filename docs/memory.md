# Memory

Everything the persona remembers lives in one SQLite file (`data/memory.db`). The engine uses Node's built-in `node:sqlite`, FTS5 for word and trigram search, and int8 vectors scanned in place. There are no npm dependencies for storage.

Beside the database, her diary pictures and voice files sit under `data/media/diary/`.

## Core concepts

| Concept | What it is | Tables |
|---|---|---|
| Source | One observed or produced line: a message she saw (`seen`), her own line (`said`), a deletion (`deleted`), a feeling (`felt`), a whole memory-session answer, a diary entry's text. Carries a native id, revision, place, author, two timestamps (`occurred_at` for when it happened, `observed_at` for when the engine saw it), text, word stems, media, mentions, audience | `sources`, `sources_fts` (word index), `sources_tri` (trigram index), `source_relations` |
| Person | A human or the persona herself. An opaque id; her own row is `person:self` | `people`, `people_merges` |
| Account | An identity on one interface (a Discord user, later a handle on another platform). Linked to a person by an explicit, evidenced link: proposed, verified or revoked. Two accounts are never the same person because a name or avatar matches | `accounts`, `account_person_links` |
| Participant | A poster known only inside a thread or site (a per-thread token, a display-name-only poster). Never a person unless her memory session promotes it | `participants`, `participant_links` |
| Place | Where lines live: a server, a channel, a thread, a DM conversation | `places`, `memberships` |
| Audience | Who may see a row: `none` (no source, visible everywhere), `group(<interface>)`, `dm(<DM place>)`, `internal` (never shown outward) | `audiences` |
| Claim | One thing she believes about a person, place or herself: a detail, interest, alias, in-joke, self fact, lesson or pattern. Carries how she knows it, a truth value, versions and evidence | `claims`, `claim_versions`, `claim_sources`, `claim_version_sources` |
| Description | A living text about a subject and field (a person's character, style, relationship; a place's purpose, topics, tone), in her words, versioned | `descriptions`, `description_versions` |
| Episode | A remembered moment between the persona and a person | `episodes`, `episode_sources` |
| Affinity | Her attitude to a person: a number from -100 to 100, moved by her memory session with a reason and a capped delta | `people.affinity`, `affinity_events` |
| Her day | Every turn, action, wake and system event | `day`, `decisions` |
| Diary | Her diary entries (real or imagined), with media; interface posts are mirrors | `diary`, `diary_mirrors`, `publications`, `publication_grants`, `media` |
| Intention, work | Her intentions and her errands with events | `intentions`, `work`, `work_events` |
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

There is one writer: every write goes through a worker thread (`src/memory/db/writer-worker.js`) that owns the database and holds one transaction per write. The engine's main loop never holds a write transaction. Readers use a separate read-only connection.

The module seams stay as they were before the database: `record`, `journal`, `archive`, `vectors`, the intention and errand stores keep their public functions. Underneath they read and write the database. The store (`src/memory/store.js`) keeps an in-memory cache of profiles, places, lore and other units; a dirty unit flushes as a whole value through its mapper into rows.

## Data model

Schema version 17 (`src/memory/db/schema.js`; migrations appended, never edited). Version 14 renames the errand units (`guilds/<g>/tasks.json` and `tasks.jsonl` become `errands.json` and `errands.jsonl`) in every table that stores a unit path, and renames the errand fields of the open intention records. `currentUnitPath` in `src/memory/db/paths.js` maps the old unit names on the way in, so a write that waited in `memory-pending/` across the upgrade lands in the current unit.

Version 17 is a data step: it sets back what the unit sync wrote over her memory session's changes (`src/memory/db/session-repair.ts`). A claim takes the text and the last-seen time of her newest version, and the truth of a retire, and becomes hers. Her newest review becomes the current version of its description again, and a person she moved takes the reason of her newest move. Each repair applies only when her version is newer than the file's last change of the row: the claim's first or last seen time, the newest legacy description version, or the file's newest attitude move. The step asks no model and sends nothing, and one `decisions` row (`migration:v17:session_rows_repaired`) counts what it set back.

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
| `work` | Errands |
| `work_events` | The steps of an errand |

### Internal bookkeeping

| Table | What it holds |
|---|---|
| `session_runs` | One row per memory-session request: scope, mode, cursor range, counts, outcome |
| `decisions` | Why the engine or she changed memory (proposals, rejections, quarantines) |
| `turn_reads` | Which rows each request carried, in which context and by which reader |
| `execution_contexts` | The contexts the engine issued for turns, sessions and wakes |
| `relationship_daily` | How often she and each person addressed each other per day and audience (counts, recounted from `sources`) |
| `focus_members` | Her current close and exploring sets (built, off by default) |
| `focus_events` | Every change of those sets (append-only) |
| `focus_overrides` | The owner's pins and exclusions |
| `wake_runs` | One row per inner wake run (built, off by default) |
| `wake_actions` | Each action of a wake run (append-only) |
| `skills` | Registered skills by name, with lifecycle and active version (built, off by default) |
| `skill_versions` | Each version of a skill, with content hash, manifest hash and engine commit |
| `skill_evaluations` | Tests, trials and outcome checks of skill versions (append-only) |
| `index_policy` | The tier of each source line (`a`, `b`, `c`) and the touches that keep a vector alive (built, off by default) |
| `operational` | State files kept verbatim (request dumps, buffers, queues) |
| `ingest` | One row per event the core took from a client: the principal, its `seq`, the event id, kind and conversation, and when it was committed (schema v16). An event id and a `seq` are each unique within a principal |
| `ingest_cursor` | The contiguous watermark of numbered events acknowledged to each principal (schema v16) |
| `ledger_tasks` through `ledger_outbox` | Reserved tables for the task ledger (not used yet) |

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
| `group(<interface>)` | Visible in any group context of that interface, and in any DM context of that interface |
| `dm(<DM place>)` | Visible only in that DM conversation and in the internal context |
| `internal` | Never shown in an outward context. Used for derived rows whose inputs come from incompatible audiences |

**Contexts a read may name:**

- Group context of interface X: reads `none` and `group(X)` rows.
- DM context with a place: reads `none`, `group(X)` and `dm(this place)` rows.
- Internal context (her sessions, the owner's CLI): reads everything.

**The narrowest-wins rule:** a derived row (a claim revised with evidence from both a group and a DM) takes the narrowest audience of its inputs. Group plus DM of the same interface becomes that DM. Two different DMs or two different interfaces become `internal`. Unknown or malformed provenance becomes `internal`, never `none`.

## Writing memory

### 1. A message arrives

When a message comes in (live or through the start-up catch-up of the newest 50 per channel), the adapter's event becomes a versioned observation. `observe()` resolves the authority, place and author (an account or participant, never a person: promotion is her session's job), then writes the source with its audience, its relations and its graph projection in one transaction. A replay of the same native tuple writes nothing.

The interface of every id the core builds comes from the event's `iface` (`src/memory/db/ids.ts` takes it as its first argument). A Discord event gives the strings stored since the first import (`person:discord:<id>`, `discord:channel:<id>`, `src:discord:<message>:<revision>:<kind>`, `discord/global`), and an event of the command line or the fake gives `person:cli:<id>`, `src:fake:<message>:...` and so on. An observed account of the first generation, and an observed channel, guild or DM place, get the spelling the store's unit mappers write for their interface (`interfaceAccountId` and `interfacePlaceOf`), so a unit write that brings the row an observation made lands on it. The legacy record files and the migrations that read them name their namespace through `LEGACY_IFACE` in `src/memory/db/legacy-namespace.ts`. A member inside a stored text is the core's own token `<@id>` (`src/memory/mentions.ts`), whatever the interface, and a name written in the text is replaced with the current name when the text is shown.

The audience comes from the place's conversation: `group` becomes `aud:group:<interface>`, `dm` becomes `aud:dm:<place>`. Anything else becomes `aud:internal`.

The event door hands the observation the event's `ingest` row, and `observe()` writes it in the same transaction as the line, so the event and its line commit together before the interface gets its ack (see [Interfaces](interfaces.md#the-event-door)). `createIngestRecord` in `src/memory/db/ingest.ts` is the door's and the link's way to the record: it reads `ingest` and `ingest_cursor` on the read connection and writes through `memoryWrite`, with the kinds `ingest` and `ingest-ack`. While the database is not open a read finds nothing and a write is refused, so an event taken then is answered `failed`.

### 2. Her turn

Her turn writes her `said` lines with turn and operation ids, her day events, participation episodes and the turn's read record. A diary turn writes her entry as a `diary` row with its full text before anything is posted, and the diary's mirrors (`src/behavior/mirror.ts`) write one `publications` row for each mirror they post it to, through the same writer (`memoryWrite`, kind `publication`).

### 3. The embedder

The embedder (`src/memory/embedder.js`) sends new lines to the embedding model in batches. An hourly catch-up (`embed.catchUpEveryMinutes`, default 60) covers the last 72 hours, so a line has its vector within an hour. Off unless `features.meaningSearch` and `features.embedIndex` are both true.

### 4. Code-made counters

`touchMemory` (`src/memory/update.js`) writes per line: first and last seen timestamps, message counts, emoji use, address counts. No model is involved.

### 5. Affinity decay

Every stored attitude drifts toward zero at `relationships.decayPerDay` (default 0.04) per day. The sweep runs hourly (`src/core.js`), but counts only the time the persona was running: a gap of more than two sweep intervals is treated as downtime, and the gap is skipped. The decay is applied to both public and private scores by `src/memory/store.js#decayAffinities`.

### The store, the outbox and pending writes

The store keeps an in-memory cache of profiles, places, lore and other memory units. A dirty unit flushes as a whole value through its mapper to the database. The outbox (`src/memory/db/unit-outbox.js`) queues units for the writer: a newer value of the same unit replaces the one waiting; lines of a JSONL unit are appended in order. A failed write stays in the outbox and is retried at the next flush.

At shutdown, a unit the writer still cannot take goes to `data/memory-pending/` as a JSON file. At the next start, each pending file is replayed through the writer before anything reads the database. A replay that fails keeps its file and the database does not open (`PENDING_REPLAY`).

Observations that arrive before the database opens wait in a bounded queue (5000 entries). A shutdown writes the waiting ones before it closes. If the queue is full, the oldest is dropped with a warning.

### Her session's rows and the store's files

Two writers change the rows of a member's profile: the store's flush of the cached file (`users/<id>.json`, `private/<id>.json`) and her memory session (`src/memory/db/session-write.js`). Every row a file's mapper wrote carries the file's path as `owner_file`. A row her session adds has no `owner_file`, and a claim she confirms, revises or retires loses its `owner_file` in the same transaction, so it becomes hers. A unit write never updates, retires or re-owns a row without an `owner_file`, and it skips the file's copy of such a row (`src/memory/db/upsert.js`).

The profile the store reads (`export.js#unitRows`) holds the file's rows and, in the file's scope, the rows her session wrote about the person (`src/memory/db/session-rows.ts`): the claims she shows (truth `current` or `disputed`), her episodes and her attitude moves. The public profile takes the group of the person's interface, the private layer the DM with the person. Her claims and episodes follow the file's in the order she made them, and her moves join the file's history by time, each with its event id as the `itemId`. A description shows the version its `current_version` names.

A person's attitude and a description keep columns of both writers. Her last move of an attitude is her newest `affinity_events` row about the person, and the profile names it as `affinity.moveId`. A file that names an older move was read before her later ones. Its write keeps her reason, and its score is the file's score plus her later moves, clamped to -100..100, so a decay tick in the cache and her move both count. A file that names no move leaves her score, reason and decay stamp as they are. When a description's current version is a review, it stays current while the file brings the review's text or its own earlier text. A file that brings a new text makes its own version current again.

When her session moves someone's attitude, `noteAffinityMoves` in the store drops that member's cached profile, whatever interface the person id names. A clean entry goes at once, a changed one once its write has landed, and the next read takes the database's profile with the moves in its history.

## Her memory session

There is no model role that decides what the persona remembers. She decides herself.

The session runs on its own model role (`memory`) and its own key (configured through `llm.keyByRole.memory`, which names the `.env` variable to read). Without the key, the session refuses to run.

### Schedule

Controlled by the `memoryDb.session` config block. A scope (the public channels of an interface together, or one DM conversation) sweeps when:

- at least `minMessages` (default 5) settled lines sit after its cursor
- `settleMinutes` (default 10) have passed since the newest of those lines
- `everyMinutes` (default 60) have passed since the last sweep of this scope, or the scope has `maxMessages` (default 200) waiting lines

One sweep at a time. At most `sweepsPerScopePerDay` (default 24) sweeps of one scope per UTC day.

### The batch

Lines are read by arrival from the cursor (none is skipped), shown in event time. When a batch holds more people than `maxPeople` (default 12), the same lines are sent again with the next page of people, one request per page.

### What she receives

Her own system text (card, rules), then `prompts/memory-session.md`, then her self claims, the places with handles, the people of the batch with their profiles (the same rendering her turns use), open episodes, open intentions, and the batch lines.

### What she may answer

- Claims: add, confirm, revise, retire.
- Episodes.
- Attitude moves (a delta with a reason and sources).
- Description flags (flag a description for review).
- `people:add` (promote an account or participant that spoke with her on two days, in a DM, or that she wants to remember).

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

**Four search streams:**

| Stream | How it works |
|---|---|
| Words | The plan's forms as stems (learned from the database's own text by `src/memory/db/stems.js`, the same stemmer that stamped `sources.stems`) through `sources_fts`. A one-word form is a word match; a longer form is a phrase match. Ranked by BM25 |
| Trigrams | A form the word stream finds nothing for, searched as a substring through `sources_tri`. Catches typos and stems the learned endings did not cover |
| Meaning | The stored vectors within the context's scope. A plain scan with cosine similarity on the int8 rows (the question's embedding is the caller's). Candidates limited by `recall.db.candidates` (default 40) |
| People | The lines of the members the plan's name forms point at |

The streams are fused by reciprocal rank (k=60). A relevance gate drops hits far below the best. The rest are ranked by closeness to the plan's date range when one exists; without a date, by what terms a hit holds.

**Stretches:** around the best hits, a window is built: the reply chain, context lines on each side, then the conversation followed forward while it continues (`recall.followMessages` lines, up to the first silence longer than `recall.followGapMinutes` minutes). Windows that share a line are merged.

**The hidden marker:** a group context that has a better match only in the querier's own DM gets a `hidden` marker and nothing else: no text, no count.

### Prefetch

The automatic prefetch (`src/behavior/prefetch.js`) runs before a turn the persona will answer. It searches the record and the meaning index with the triggering message, without any model choosing the query. The terms come from the message's rarest words and phrases (by document frequency in the record). Short or deictic triggers also pick up the lines just before them. Trivial triggers (a greeting, a bare "ok") are not searched.

The prefetch keeps only hits that pass a relevance threshold (a rare phrase, two distinctive terms, or one term confirmed by its cosine score), fuses the lanes by reciprocal rank, and returns a few excerpts under a token cap.

## Nothing is forgotten

There is no forget path, no wipe command, no way to delete memory rows through the engine. Precision falls through tiers: the context window is the most precise, then word search, then meaning search, then the journal. Rows leave hot memory through caps, but the archive (`src/memory/archive.js`) keeps a copy before anything is removed, and the record (`src/memory/record.js`) holds every line for good.

A retired row keeps its history. `removeLore` (`/nep lore remove`) takes one lorebook entry out on the owner's word; that is the only removal.

## What stays as files

Operational state that the process writes stays on disk as JSON files. The exact list is `OPERATIONAL_PATTERNS` in `src/memory/db/paths.js`:

- `state.json`, `usage.json`, `metrics.json` (top-level and per-guild)
- Per-guild: `inner.json`, `missed.json`, `participation.json`, `gifs.json` (the GIF library), `media.json` (the vision cache)
- `recall-trace.jsonl` (when `features.recallTrace` is on)
- `journal/.running` (the running marker) and `journal/requests/` (request dumps)
- The backfill folders and `record/backfill.json`
- `archive/pending*.jsonl` (the archive's pending queue)
- `vault/`, `snapshots/`
- `memory-pending/` (unit writes a shutdown could not complete)
- `media/diary/` (her diary pictures and voice files)
- `memory.db*` (the database's own files)

Everything else (profiles, places, channels, lore, the record's day files, the journal's day files, the archive months, vectors, intentions, errands) lives only in the database.

## The derived graph

The graph (`graph_nodes`, `graph_edges`, `node_access`) is entirely derived from the typed tables. The manifest (`src/memory/db/graph-manifest.js`) names every node kind and every edge predicate, and says which typed table and columns each comes from. Every write transaction projects the affected rows into the graph at the same time.

The graph is rebuildable: `tools/memory-db.mjs rebuild` drops and rebuilds it from the typed tables. An edge retired because its source row no longer produces it is history the typed tables do not hold; a rebuild does not bring it back.

Each edge carries the audience of the row it came from. `node_access` holds one witness per (node, audience, evidence): a node with its own audience (a source, a claim) witnesses itself; every live edge witnesses both of its ends. A graph walk follows only edges the context may read.

## Operations

### Backups

`tools/memory-db.mjs backup` (or the service's daily job at `memoryDb.backup.hour` UTC, default 3, when `memoryDb.backup.enabled` is on): `VACUUM INTO` a copy, the diary media, and a manifest with SHA-256 hashes of every file, the schema version, the engine commit and the row count of every table. The newest `memoryDb.backup.keep` (default 7) backups are kept; older ones and unfinished ones are pruned.

### Restore

`tools/memory-db.mjs restore --from <backup> --db <target>`: checks every file in the backup against its manifest, copies the database (which must not exist, nor its WAL or SHM files), copies the diary media under the data directory, and checks the restored file's schema version and row counts.

### Restore test

`tools/memory-db.mjs restore-test --from <backup>`: proves a backup in a temporary directory by restoring it and verifying everything matches.

### Inspection

| Command | What it does |
|---|---|
| `tools/memory-db.mjs stats` | Row counts per table, per scope kind, per audience |
| `tools/memory-db.mjs hash` | Content hash (SHA-256) per table, to verify round-trip integrity |
| `tools/memory-db.mjs reproject` | Re-projects every typed row into the graph |
| `tools/memory-db.mjs rebuild` | Drops and rebuilds the graph and full-text indexes |
| `tools/memory-db.mjs index-policy` | Shows (or with `--apply` writes) the tier of every line and which vectors would be evicted |
| `tools/memory-db.mjs media-check` | Checks which diary media files are present or missing |
| `tools/memory-session.mjs` | Runs her memory session once, in shadow, on a copy of the database |
| `tools/recall-eval.mjs` | Recall against questions with known answers |

### A read-only copy

You can copy `memory.db` and its `-wal` file while the bot runs (the copy will not be locked). Open the copy; a read-only open of the live file cannot apply the WAL.

## Configuration

The memory system reads these config groups from `config.json` (and `config.local.json`). The full reference of every key is in [configuration.md](configuration.md).

| Group | What it controls |
|---|---|
| `memoryDb` | The database file, session schedule, backups, focus, wake runs, skills registry, observation timeout |
| `recall` | Search parameters: forms, clusters, windows, follow, time ranges, the `db` subgroup (word pool, vector days, eviction), the `prefetch` subgroup |
| `embed` | Embedding dimensions, batch size, flush interval, catch-up window |
| `capture` | Foreign capture defaults (ancestors, context lines, watch intervals) |
| `graph` | Walk depth and row limits |
| `focus` | Policy version, set sizes, weights, decay, novelty, consistency |
| `relationships` | Delta cap, history size, decay rate, damping, rewrite triggers, text length |

Feature switches that gate memory behavior:

| Switch | Default | What it gates |
|---|---|---|
| `features.recall` | on | Recall search (the `memory.search` tool and the runner) |
| `features.record` | on | Writing lines to the record |
| `features.archive` | on | Archiving items that leave hot memory |
| `features.relationships` | on | Attitude tracking and decay |
| `features.meaningSearch` | off (`=== true`) | Vector search in recall |
| `features.embedIndex` | off (`=== true`) | The live embedding queue |
| `features.journal` | on (`=== true`) | Writing journal entries |
| `features.recallTrace` | off | Writing the recall trace file |
| `memoryDb.session.mode` | `"off"` | Her memory session (`"off"`, `"shadow"`, `"apply"`) |
| `memoryDb.backup.enabled` | `false` | The daily backup job |

## Built but off

| Feature | Switch | State |
|---|---|---|
| Focus (close and exploring sets for her heartbeat) | `memoryDb.focus.enabled` | Built, off |
| Wake runs and wake actions | `memoryDb.wakeRuns` | Built, off |
| Skills registry | `memoryDb.skillsRegistry` | Built, off |
| Vector eviction (drop bytes of old, uncited vectors) | `recall.db.vectorEviction` | Built, off |
| Re-embedding on touch | `recall.db.reembed` | Built, off |
| Foreign capture (threads, boards) | Live in schema; no adapter emits capture events yet | Built, no adapter |
| Diary media fetch | `memoryDb.diaryMedia` | Built, off |

## Appendix: who may read each table

Every table of the memory database (`data/memory.db`, schema `src/memory/db/schema.js`) is in one of four classes.
A read of the persona's memory always names a context (a group of an interface, one DM conversation, or internal);
the class says how a row's visibility in that context is decided.

- **audience-scoped**: the row carries its own audience (`audience_id`, and the scope columns `scope_kind`,
  `scope_iface`, `scope_dm` that it replaces). A group context of interface I reads `aud:none` and `aud:group:I`; a DM
  context also reads `aud:dm:<its DM place>`; only the internal context reads `aud:internal`. The groups context of the
  diary's entry (`groupsContext` in `src/memory/db/scope.ts`) reads `aud:none` and the groups of every interface, no DM
  and nothing internal.
- **inherits from &lt;parent&gt;**: the row has no audience of its own and is read only through its parent row, with
  the parent's audience.
- **internal-only**: never shown in an outward context (a group or a DM); the persona's own bookkeeping.
- **structural**: identity and bookkeeping that holds no remembered content by itself (ids, names of namespaces,
  file signatures). Where a structural row has a name a context may not see, the reader says so below.

The full-text tables' own storage tables (`sources_fts_*`, `sources_tri_*`) belong to `sources_fts` and `sources_tri`.
`tests/memory-db-v7.test.js` reads the table below and fails on any table of the schema it does not list.

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
| `work` | audience-scoped | errands |
| `work_events` | inherits from work | the steps of an errand |
| `session_runs` | internal-only | one row per memory session request; its audience names the scope the run read |
| `decisions` | internal-only | why the engine or she changed memory (proposals, rejections, quarantines) |
| `turn_reads` | internal-only | which rows each request carried, in which context and by which reader |
| `execution_contexts` | internal-only | the contexts the core issued for turns, sessions and wakes |
| `relationship_daily` | internal-only | how often she and each person addressed each other, per day and audience (counts only, recounted from `sources`) |
| `focus_members` | internal-only | her current close and exploring sets; only the focus code and her internal wakes read it (`src/memory/db/focus.js`) |
| `focus_events` | internal-only | every change of those sets, every challenge and its end (append-only) |
| `focus_overrides` | internal-only | the owner's pins and exclusions |
| `wake_runs` | internal-only | one row per inner wake run: its kind, state, the ids and versions its view showed, the envelope's policy version and the outcome |
| `wake_actions` | inherits from wake_runs | each action of a run once, keyed by the run and its number |
| `index_policy` | internal-only | the tier of each stored line (by its graph node), why, a pin, and how long a touch lasts; derived from the typed tables |
| `skill_evaluations` | internal-only | the tests, trials, outcome reviews and audience checks of each skill version, with the hashes they evaluated (append-only); the evidence they name keeps its own audience |
| `capture_watches` | internal-only | when a bundle is looked at again, and how that went |
| `operational` | internal-only | state files kept verbatim (request dumps, buffers, queues) |
| `ledger_tasks` | internal-only | the task ledger's copy |
| `ledger_attempts` | internal-only | the task ledger's copy |
| `ledger_questions` | internal-only | the task ledger's copy |
| `ledger_approvals` | internal-only | the task ledger's copy |
| `ledger_results` | internal-only | the task ledger's copy |
| `ledger_comments` | internal-only | the task ledger's copy |
| `ledger_events` | internal-only | the task ledger's copy |
| `ledger_outbox` | internal-only | the task ledger's copy |
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
| `skills` | structural | the engine's skills by name, the active version, the lifecycle and a pin; code in the repository, no remembered content |
| `skill_versions` | structural | each version of a skill: its content hash, manifest hash, engine commit, status and manifest |
| `graph_nodes` | structural | one node per typed row of a node kind (derived, rebuildable); whether a context may see a node is `node_access`'s answer |
| `graph_edges` | audience-scoped | the edges between nodes, each with the audience of the typed row it came from (derived, rebuildable); a walk follows only edges the context may read |
| `node_access` | internal-only | which audiences may see each node, one witness row per node, audience and evidence (derived, rebuildable); the walks read it, nothing shows it |
