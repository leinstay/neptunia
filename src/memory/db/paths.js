// What is a file under data/ and what is only a unit of the memory database (spec 2026-10-24-memory-authority, section
// 0 and section 6 item 8): the path allowlist as code. Every path is relative to the data directory, with forward
// slashes (`guilds/<g>/users/<u>.json`, `state.json`).
//
//   OPERATIONAL_PATTERNS  what is written as a file: the process's operational
//                         state (`state.json`, `usage.json`, `metrics.json`, a guild's `inner.json` and `missed.json`),
//                         the participation file, the GIF library and the vision cache (`gifs.json`, `media.json`), the
//                         recall trace, the journal's `.running` marker and request dumps (`journal/` is a mixed
//                         directory: only its day files retire), the backfill folders and the backfill cursor
//                         (`record/backfill.json`), the archive's pending queue, the vault, the snapshots, the unit
//                         writes a shutdown could not make (`memory-pending/`), her diary media (`media/diary/`), the
//                         database's own files (`memory.db*`), the tools' output folders, and the leftovers of any file
//                         (`*.bak*`, `*.unreadable-*`, `*.tmp`, `*.tmp-*`, `*.torn-*`).
//   MEMORY_PATTERNS       the memory paths, which no module writes as a file any more (the database holds their units;
//                         the JSON memory they once were was deleted at the switch), by exact pattern: a guild's `users/`,
//                         `channels/`, `versions/`, `vectors/`, `forgetting/` and `private/` trees (but the operational
//                         paths of a private layer), `record/` (but the backfill cursor), `archive/` (but the pending
//                         queue), the journal's day files only, `guild.json`, `lore.json`, `recent.json`, `diary.json`,
//                         `buffer.json`, `voice.json`, `forgotten.json`, `intentions*.json[l]`, `errands*.json[l]` and `tasks*.json[l]` (the
//                         names an errand unit had before `errands.json`).
// The two lists never share a path (tests/memory-db-paths.test.js enumerates every path the mappers map or skip and the
// data layout, and fails on a path in neither or both). A path in neither is unknown: not memory the mappers map, and
// not on the allowlist.
//
//   pathClass(rel)     'operational' | 'memory' | null
//   isOperational(rel) / isMemoryPath(rel)
//
// Pure: no I/O.

/** A pattern of the allowlist: the glob it documents and the expression that decides it. */
const pattern = (glob, source) => Object.freeze({ glob, re: new RegExp(`^${source}$`) });

const G = 'guilds/[^/]+/';
/** A private layer's prefix inside a guild, optional. */
const P = '(?:private/[^/]+/)?';
/** The leftover endings: copies, unreadable sets aside, temporary files, torn tails. */
const LEFTOVER = '(?:\\.bak(?:[-.][^/]*)?|\\.unreadable-[^/]*|\\.tmp(?:-[^/]*)?|\\.torn-[^/]*)';
/** No leftover ending (a leftover is operational whatever it is the leftover of). */
const NOT_LEFTOVER = `(?!.*${LEFTOVER}$)`;
/** The operational files a guild (or a private layer) keeps by name. */
const GUILD_STATE = '(?:state|usage|metrics|inner|missed|participation|gifs|media)\\.json';
/** The tools' output folders. */
const TOOL_OUTPUT = '(?:mentor|recall-eval|vision-compare)(?:/.*)?';

/** What is written as a file (see the head of this file). */
export const OPERATIONAL_PATTERNS = Object.freeze([
  pattern('{state,usage,metrics}.json', '(?:state|usage|metrics)\\.json'),
  pattern(
    'guilds/*/[private/*/]{state,usage,metrics,inner,missed,participation,gifs,media}.json',
    `${G}${P}${GUILD_STATE}`
  ),
  pattern('guilds/*/recall-trace.jsonl', `${G}recall-trace\\.jsonl`),
  pattern('guilds/*/[private/*/]journal/.running', `${G}${P}journal/\\.running`),
  pattern('guilds/*/[private/*/]journal/requests/**', `${G}${P}journal/requests/.+`),
  pattern('guilds/*/[private/*/]backfill/**', `${G}${P}backfill/.+`),
  pattern('guilds/*/[private/*/]record/backfill.json', `${G}${P}record/backfill\\.json`),
  pattern('guilds/*/[private/*/]archive/pending*.jsonl', `${G}${P}archive/pending[^/]*\\.jsonl`),
  pattern('vault/**', 'vault/.+'),
  pattern('snapshots/**', 'snapshots/.+'),
  pattern('memory-pending/**', 'memory-pending/.+'),
  pattern('media/diary/**', 'media/diary/.+'),
  pattern('memory.db*', 'memory\\.db[^/]*'),
  pattern('{mentor,recall-eval,vision-compare}/**', TOOL_OUTPUT),
  pattern('guilds/*/{mentor,recall-eval,vision-compare}/**', `${G}${TOOL_OUTPUT}`),
  pattern('**/*{.bak*,.unreadable-*,.tmp,.tmp-*,.torn-*}', `.*${LEFTOVER}`),
]);

/** The operational paths of a private layer, relative to the layer's directory. */
const PRIVATE_OPERATIONAL = `(?:${GUILD_STATE}|journal/\\.running|journal/requests/.+|backfill/.+|record/backfill\\.json|archive/pending[^/]*\\.jsonl)`;

/** The memory paths, units of the database only (see the head of this file). */
export const MEMORY_PATTERNS = Object.freeze([
  pattern('guilds/*/users/**', `${NOT_LEFTOVER}${G}users/.+`),
  pattern('guilds/*/channels/**', `${NOT_LEFTOVER}${G}channels/.+`),
  pattern(
    'guilds/*/{guild,lore,recent,diary,buffer,voice,forgotten}.json',
    `${NOT_LEFTOVER}${G}(?:guild|lore|recent|diary|buffer|voice|forgotten)\\.json`
  ),
  pattern('guilds/*/forgetting/**', `${NOT_LEFTOVER}${G}forgetting/.+`),
  pattern('guilds/*/versions/**', `${NOT_LEFTOVER}${G}versions/.+`),
  pattern('guilds/*/archive/** (not archive/pending*.jsonl)', `${NOT_LEFTOVER}${G}archive/(?!pending[^/]*\\.jsonl$).+`),
  pattern('guilds/*/record/** (not record/backfill.json)', `${NOT_LEFTOVER}${G}record/(?!backfill\\.json$).+`),
  pattern('guilds/*/journal/<YYYY-MM-DD>.jsonl', `${NOT_LEFTOVER}${G}journal/\\d{4}-\\d{2}-\\d{2}\\.jsonl`),
  pattern(
    "guilds/*/private/** (not a layer's operational paths)",
    `${NOT_LEFTOVER}${G}private/(?![^/]+/${PRIVATE_OPERATIONAL}$).+`
  ),
  pattern('guilds/*/intentions*.json[l]', `${NOT_LEFTOVER}${G}intentions[^/]*\\.jsonl?`),
  pattern('guilds/*/errands*.json[l]', `${NOT_LEFTOVER}${G}errands[^/]*\\.jsonl?`),
  pattern('guilds/*/tasks*.json[l]', `${NOT_LEFTOVER}${G}tasks[^/]*\\.jsonl?`),
  pattern('guilds/*/vectors/**', `${NOT_LEFTOVER}${G}vectors/.+`),
]);

const normal = (rel) =>
  String(rel ?? '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '');
const matches = (list, rel) => list.some((entry) => entry.re.test(rel));

/** Whether a path is written as a file. */
export function isOperational(rel) {
  return matches(OPERATIONAL_PATTERNS, normal(rel));
}

/** Whether a path is a memory path (a unit of the database, never a file). */
export function isMemoryPath(rel) {
  return matches(MEMORY_PATTERNS, normal(rel));
}

/**
 * The current name of a unit path: the errand units of an earlier release, `guilds/<g>/tasks.json` and `tasks.jsonl`,
 * become `errands.json` and `errands.jsonl`. Only a path directly under a guild maps (a private layer's path and every
 * other path stay as they are). The one alias table for unit paths: the unit writer and the importers read an owner
 * through it.
 * @param {unknown} rel
 * @returns {string}
 */
export function currentUnitPath(rel) {
  return String(rel).replace(/^(guilds\/[^/]+\/)tasks(\.jsonl?)$/, '$1errands$2');
}

/**
 * The list a path is in.
 * @param {string} rel  relative to the data directory
 * @returns {'operational'|'memory'|null}
 */
export function pathClass(rel) {
  const name = normal(rel);
  if (matches(OPERATIONAL_PATTERNS, name)) return 'operational';
  if (matches(MEMORY_PATTERNS, name)) return 'memory';
  return null;
}
