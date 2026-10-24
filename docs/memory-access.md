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
| `vectors` | audience-scoped | one embedding per chunk, with the scope of its line |
| `claims` | audience-scoped | what she holds true about a person, a place or herself |
| `claim_versions` | inherits from claims | the history of a claim |
| `claim_sources` | inherits from claims | the lines a claim rests on (each line keeps its own audience) |
| `descriptions` | audience-scoped | her account of a subject in one field |
| `description_versions` | inherits from descriptions | the texts of a description |
| `episodes` | audience-scoped | remembered moments |
| `episode_sources` | inherits from episodes | the lines an episode rests on |
| `affinity_events` | audience-scoped | each change of her attitude to a person |
| `day` | audience-scoped | what she did, turn by turn |
| `diary` | audience-scoped | her diary entries |
| `diary_mirrors` | inherits from diary | where an entry was posted |
| `media` | audience-scoped | pictures and audio she keeps, with the audience of what they belong to |
| `intentions` | audience-scoped | what she means to do |
| `work` | audience-scoped | errands and tasks |
| `work_events` | inherits from work | the steps of a task |
| `session_runs` | internal-only | one row per memory session request; its audience names the scope the run read |
| `decisions` | internal-only | why the engine or she changed memory (proposals, rejections, quarantines) |
| `turn_reads` | internal-only | which rows each request carried, in which context and by which reader |
| `execution_contexts` | internal-only | the contexts the core issued for turns, sessions and wakes |
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
