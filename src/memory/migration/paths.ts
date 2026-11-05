// What is a file under data/ and what is only a unit of the memory database (spec 2026-10-24-memory-authority, section
// 0 and section 6 item 8): the path allowlist as code. Every path is relative to the data directory, with forward
// slashes (`guilds/<g>/users/<u>.json`, `state.json`).
//
//   OPERATIONAL_PATTERNS  what is written as a file: the process's operational
//                         state outside the inventoried root and guild units, the
//                         recall trace, the journal's `.running` marker and request dumps (`journal/` is a mixed
//                         directory: only its day files retire), the backfill folders and the backfill cursor
//                         (`record/backfill.json`), the archive's pending queue, the vault, the snapshots, the unit
//                         writes a shutdown could not make (`memory-pending/`), her selfreflection media (`media/selfreflection/`, `media/diary/` until the migration moves it), the
//                         database's own files (`memory.db*`), the tools' output folders, and the leftovers of any file
//                         (`*.bak*`, `*.unreadable-*`, `*.tmp`, `*.tmp-*`, `*.torn-*`).
//   MEMORY_PATTERNS       the memory paths, which no module writes as a file any more (the database holds their units;
//                         the JSON memory they once were was deleted at the switch), by exact pattern: a guild's `users/`,
//                         `channels/`, `versions/`, `vectors/`, `forgetting/` and `private/` trees (but the operational
//                         paths of a private layer), `record/` (but the backfill cursor), `archive/` (but the pending
//                         queue), the journal's day files only, `guild.json`, `lore.json`, `recent.json`, `diary.json`,
//                         `buffer.json`, `voice.json`, `forgotten.json`, `intentions*.json[l]`, `errands*.json[l]` and `tasks*.json[l]` (the
//                         names an errand unit had before `errands.json`), root `state.json`, `usage.json` and
//                         `metrics.json`, and guild `inner.json`, `missed.json`, `participation.json`, `gifs.json` and `media.json`.
// The two lists never share a path (tests/memory-db-paths.test.js enumerates every path the mappers map or skip and the
// data layout, and fails on a path in neither or both). A path in neither is unknown: not memory the mappers map, and
// not on the allowlist.
//
//   pathClass(rel)     'operational' | 'memory' | null
//   isOperational(rel) / isMemoryPath(rel)
//
// Pure: no I/O.

import { accountId, channelPlaceId, dmPlaceId } from '../db/ids.ts';
import { LEGACY_IFACE } from '../db/legacy-namespace.ts';
import { operationalKindOf } from '../db/map/verbatim.ts';
import type { StorageKey, StorageKind, StorageSelector, StorageSubject } from '../db/storage-keys.ts';
import { asText } from '../db/types.ts';
import { classify } from './classify.ts';

/** The place id a shipped database gives a server. */
export const legacyServerPlaceId = (iface: unknown, native: unknown): string =>
  `${String(iface)}:guild:${String(native)}`;

/** One pattern of the allowlist: the glob it documents and the expression that decides it. */
type PathPattern = Readonly<{ glob: string; re: RegExp }>;

/** A pattern of the allowlist: the glob it documents and the expression that decides it. */
const pattern = (glob: string, source: string): PathPattern => Object.freeze({ glob, re: new RegExp(`^${source}$`) });

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
  pattern(
    'guilds/*/{state,usage,metrics}.json and private core state',
    `${G}(?:(?:state|usage|metrics)\\.json|private/[^/]+/${GUILD_STATE})`
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
  pattern('media/selfreflection/**', 'media/selfreflection/.+'),
  pattern('memory.db*', 'memory\\.db[^/]*'),
  pattern('{mentor,recall-eval,vision-compare}/**', TOOL_OUTPUT),
  pattern('guilds/*/{mentor,recall-eval,vision-compare}/**', `${G}${TOOL_OUTPUT}`),
  pattern('**/*{.bak*,.unreadable-*,.tmp,.tmp-*,.torn-*}', `.*${LEFTOVER}`),
]);

/** The operational paths of a private layer, relative to the layer's directory. */
const PRIVATE_OPERATIONAL = `(?:${GUILD_STATE}|journal/\\.running|journal/requests/.+|backfill/.+|record/backfill\\.json|archive/pending[^/]*\\.jsonl)`;

/** The memory paths, units of the database only (see the head of this file). */
export const MEMORY_PATTERNS = Object.freeze([
  pattern('{state,usage,metrics}.json', '(?:state|usage|metrics)\\.json'),
  pattern(
    'guilds/*/{inner,missed,participation,gifs,media}.json',
    `${G}(?:inner|missed|participation|gifs|media)\\.json`
  ),
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

const normal = (rel: unknown): string =>
  asText(rel ?? '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '');
const matches = (list: ReadonlyArray<PathPattern>, rel: string): boolean => list.some((entry) => entry.re.test(rel));

/** Whether a path is written as a file. */
export function isOperational(rel: unknown): boolean {
  return matches(OPERATIONAL_PATTERNS, normal(rel));
}

/** Whether a path is a memory path (a unit of the database, never a file). */
export function isMemoryPath(rel: unknown): boolean {
  return matches(MEMORY_PATTERNS, normal(rel));
}

/**
 * The current name of a unit path: the errand units of an earlier release, `guilds/<g>/tasks.json` and `tasks.jsonl`,
 * become `errands.json` and `errands.jsonl`. Only a path directly under a guild maps (a private layer's path and every
 * other path stay as they are). The one alias table for unit paths: the unit writer and the importers read an owner
 * through it.
 */
export function currentUnitPath(rel: unknown): string {
  return String(rel).replace(/^(guilds\/[^/]+\/)tasks(\.jsonl?)$/, '$1errands$2');
}

/**
 * The list a path is in. `rel` is relative to the data directory.
 */
export function pathClass(rel: unknown): 'operational' | 'memory' | null {
  const name = normal(rel);
  if (matches(OPERATIONAL_PATTERNS, name)) return 'operational';
  if (matches(MEMORY_PATTERNS, name)) return 'memory';
  return null;
}

/** The root operational row used by the core-state writer, or null for another unit. */
export function rootStateKind(owner: unknown): string | null {
  return typeof owner === 'string' ? (/^(state|usage|metrics)\.json$/.exec(owner)?.[1] ?? null) : null;
}

/** The inventoried core state kept in database rows, with its legacy relative owner preserved. */
export function isCoreStatePath(owner: unknown): boolean {
  return (
    rootStateKind(owner) !== null ||
    (typeof owner === 'string' &&
      /^(?:guilds|places)\/[^/]+\/(?:inner|missed|participation|gifs|media)\.json$/.test(owner))
  );
}

/** The semantic identity of a historical collection without merging its existing replacement boundary. */
export function legacyStorageKey(owner: string, iface = LEGACY_IFACE, legacyKind?: string): StorageKey {
  const root = rootStateKind(owner);
  if (root) return { kind: root as StorageKind, subject: { type: 'persona', id: 'persona:local' } };
  // An earlier release kept this marker at the data root, and its retired row stays with the persona.
  if (owner === 'journal/.running')
    return { kind: 'journal_running', subject: { type: 'persona', id: 'persona:local' } };
  const canonical = currentUnitPath(owner);
  const info =
    classify(/\/vectors\/\d{4}-\d{2}$/.test(canonical) ? `${canonical}/manifest.json` : canonical) ??
    historicalTaskUnit(canonical, legacyKind);
  if (!info || 'skipped' in info || !info.guildId)
    throw Object.assign(new Error('UNIT_UNMAPPED'), { code: 'UNIT_UNMAPPED' });
  const scopePlaceId = legacyServerPlaceId(iface, info.guildId);
  const stored = info.kind === 'verbatim' ? operationalKindOf(info.unit) : info.kind;
  const kind = stored as StorageKind;
  const rel = info.unit;
  const selector = legacySelector(kind, rel);
  const subject = legacySubject(kind, rel, iface, scopePlaceId, selector);
  const partition =
    kind === 'record' || kind === 'journal' || kind === 'requests'
      ? /\d{4}-\d{2}-\d{2}/.exec(rel)?.[0]
      : ['archive', 'vectors', 'record_ids', 'archive_ids'].includes(kind)
        ? /\d{4}-\d{2}/.exec(rel)?.[0]
        : undefined;
  return { kind, subject, ...(partition ? { partition } : {}), ...(selector ? { selector } : {}) };
}

/** V14 deliberately preserves private task units; their explicit stored kind identifies that historical collection. */
function historicalTaskUnit(owner: string, kind?: string): { kind: 'errands'; unit: string; guildId: string } | null {
  const match = /^guilds\/([^/]+)\/(private\/[^/]+\/tasks\.jsonl?)$/.exec(owner);
  return kind === 'tasks' && match ? { kind: 'errands', guildId: match[1], unit: match[2] } : null;
}

/** Selectors retain distinct legacy collections and individual request and version records. */
function legacySelector(kind: StorageKind, rel: string): StorageSelector | undefined {
  if (kind === 'intentions') return { collection: rel.endsWith('.jsonl') ? 'archive' : 'active' };
  if (kind === 'errands') return { collection: rel.endsWith('.jsonl') ? 'history' : 'value' };
  if (kind === 'requests') return { requestId: /([^/]+)\.json$/.exec(rel)![1] };
  if (kind === 'versions') {
    const [, versionKind, itemId] = /^versions\/([^/]+)\/(.+)\.json$/.exec(rel)!;
    const named = versionKind === 'guild' ? 'place' : versionKind;
    return { versionKind: named as NonNullable<StorageSelector['versionKind']>, itemId };
  }
  if (['backfill', 'forgetting', 'request_tools', 'archive_pending'].includes(kind))
    return {
      itemId: rel
        .split('/')
        .pop()!
        .replace(/\.jsonl?$/, ''),
    };
  return undefined;
}

/** Whether `owner` is the file path the selfreflection unit was stored under before the units had keys. */
export const isLegacySelfreflectionFile = (owner: string): boolean => /\/diary\.json$/.test(owner);

/** A legacy wrapper's community scope stays separate from its exact account or place subject. */
function legacySubject(
  kind: StorageKind,
  rel: string,
  iface: string,
  scope: string,
  selector?: StorageSelector
): StorageSubject {
  if (['selfreflection', 'intentions', 'errands', 'inner'].includes(kind))
    return { type: 'persona', id: 'persona:local' };
  const itemId = /([^/]+)\.json$/.exec(rel)?.[1];
  if (kind === 'user' || kind === 'private') return { type: 'account', id: accountId(iface, itemId) };
  if (kind === 'channel') return { type: 'place', id: channelPlaceId(iface, itemId) };
  if (selector?.versionKind === 'users') return { type: 'account', id: accountId(iface, selector.itemId) };
  if (selector?.versionKind === 'channels') return { type: 'place', id: channelPlaceId(iface, selector.itemId) };
  const privateUser = /^private\/([^/]+)\//.exec(rel)?.[1];
  return privateUser ? { type: 'place', id: dmPlaceId(iface, privateUser) } : { type: 'place', id: scope };
}
