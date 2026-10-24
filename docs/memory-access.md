# Memory database: who may read each table

Every table of the memory database (`data/memory.db`, schema `src/memory/db/schema.js`) is in one of four classes.
A read of the persona's memory always names a context (a group of an interface, one DM conversation, or internal);
the class says how a row's visibility in that context is decided.

- **audience-scoped**: the row carries its own audience (`audience_id`, and the scope columns `scope_kind`,
  `scope_iface`, `scope_dm` that it replaces). A group context of interface I reads `aud:none` and `aud:group:I`; a DM
  context also reads `aud:dm:<its DM place>`; only the internal context reads `aud:internal`.
- **inherits from &lt;parent&gt;**: the row has no audience of its own and is read only through its parent row, with
  the parent's audience.
- **internal-only**: never shown in an outward context (a group or a DM); the persona's own bookkeeping.
- **structural**: identity and bookkeeping that holds no remembered content by itself (ids, names of namespaces,
  file signatures). Where a structural row has a name a context may not see, the reader says so below.

The full-text tables' own storage tables (`sources_fts_*`, `sources_tri_*`) belong to `sources_fts` and `sources_tri`.
`tests/memory-db-v7.test.js` reads this table and fails on any table of the schema it does not list.

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
| `diary_mirrors` | inherits from diary | where an entry was posted |
| `publications` | internal-only | every outward send of something of hers: the exact text and its hash, the destination, the context, the grant, the state and the receipts; what was sent is read outward through the lines it became, never through this table |
| `publication_grants` | internal-only | the owner's exceptions: one content hash of one row allowed to these destinations |
| `media` | audience-scoped | pictures and audio she keeps, with the audience of what they belong to |
| `intentions` | audience-scoped | what she means to do |
| `work` | audience-scoped | errands and tasks |
| `work_events` | inherits from work | the steps of a task |
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

## Columns filled by the migration to schema 7

The migration fills the new columns from the columns that were there; most are exact, these are approximations:

- `sources.observed_at`: the time the core saw a line. Rows from before schema 7 get their `recorded_at` (the time
  the line was written to its file), which is the closest the old files hold; rows written later get the same value
  from the writer.
- `sources.author_kind`: `self` for her own kinds (`said`, `answer`, `felt`, `memory_session`, `description_review`),
  `account` for a line with an author account, empty for a line with neither.
- `account_person_links`: one row per account that names a person; `verified` only where the account's `link` was
  `verified`, `proposed` otherwise, `by` `migration`.
- `places.conversation`: `dm` for a DM place, empty for a container (a server, a category), `group` otherwise.
- `recorded_at` of the keys, links and quarantine decisions the migration writes: the time of the last sync before
  the migration (the time the legacy rows are as of), so two copies migrated from the same rows agree.

## Columns filled by the migration to schema 8

- `sources.native_kind`: `message` for every Discord line with a message id (the native object a line is); empty
  otherwise. `sources.generation`: 1 (no native key had been reused before schema 8).
- `source_relations`: one `replies_to` row for every Discord line with a `reply_to`, its target key the replied
  message on the line's own authority (any revision); resolved to the first stored revision of that message where the
  record holds it, left waiting otherwise. Its `recorded_at` and `resolved_at` are the time of the last sync before the
  migration. A line that arrives later fills in the relations waiting for it.

A DM observed on an interface where the partner is no known person yet carries the audience of its DM place
(`aud:dm:<place>`) and a scope triple with an empty partner, which the triple reader shows in no context: it fails
closed until the partner becomes a person.

## Columns and rows filled by the migration to schema 9

- `claim_version_sources`: every live `claim_sources` row whose line is stored is copied to its claim's newest live
  version (by recorded time, then row order) with role `supports` and `legacy` 1: the claim rested on that line, which
  version first did is not known. A claim with no version keeps its lines in `claim_sources` only.
- `claim_sources.id`, `episode_sources.id`, `diary_mirrors.id`: a durable id from the link's natural key (a link a file
  holds: its parent and position; a link the database wrote: its parent and line; a mirror: its entry, interface and
  place), a repeated key suffixed with `#dup` and the row number. Every later row gets its id the same way.
- `graph_nodes`, `graph_edges`, `node_access`: created empty; the projection of the existing rows is left pending and
  done by the next full sync pass, in slices. Until then a walk sees only what was written since.

## Rows filled by the migration to schema 10

- `publications`: one `sent` row per `diary_mirrors` row, with the mirror's id, the entry it posted (`row_kind`
  `diary`), the entry's text as `rendered` and its SHA-256 as `content_hash` (both empty while the entry's text is not
  stored yet; filled once when it is, never changed after), the mirror's place as the destination when that place is
  stored (the diary mirrors name none today), the mirror's message ids as receipts, the key `diary:<entry>:<place>` and
  the mirror's owner file. `created_at` is the mirror's posting time, else the time of the last sync before the
  migration. Each is projected into the graph (`published_as` from the entry, `publication_source` to each stored line
  a receipt names). Later mirrors get theirs from the sync the same way.
- `publication_grants`, `relationship_daily`, `focus_members`, `focus_events`, `focus_overrides`: created empty.

## Columns and rows of schema 11

- `wake_runs`, `wake_actions`, `skills`, `skill_versions`, `skill_evaluations`, `index_policy`: created empty. The wake
  runs are written only with `memoryDb.wakeRuns` on, the registry only with `memoryDb.skillsRegistry` on, the policy
  only by `recall.db.vectorEviction` (and the touches it implies) or `tools/memory-db.mjs index-policy --apply`.
- `sources.tier`: empty until the index policy runs; then `a` (hers, addressed to her, in a DM, cited, pinned or
  touched), `b` (seen) or `c` (captured from a foreign place), the same tier `index_policy` holds.
- `vectors.evicted_at`: empty. An evicted vector keeps its row, `model`, `dims`, `scale`, `norm` and `context`; only
  `bytes` is dropped, and recall does not read it. Under `memoryDb.authority: json` the vector month files keep the
  bytes, so `verify` reports an evicted row's month as different.
- `media.availability`: `unknown` for every row; `tools/memory-db.mjs media-check` sets her diary media to `present`
  or `missing`.
