// The paths of the data folders of older releases, for the fixtures that build a database from such a folder: which
// paths were memory and which stayed files (`pathClass`), and the storage key each memory path names
// (`legacyStorageKey`). The engine reads no such folder. Pure: no I/O. Synthetic fixtures only.

import { accountId, channelPlaceId, dmPlaceId } from '../../../src/memory/db/ids.ts';
import type { UnitKey, UnitKind, UnitSelector, UnitSubject } from '../../../src/memory/db/unit-keys.ts';
import { asText } from '../../../src/memory/db/types.ts';
import { classify } from './legacy-classify.ts';

/** The interface the files of an older release were written by. */
const LEGACY_IFACE = 'discord';

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

/** The `kind` of an operational file, from its path (a private layer's path counts like the place's). */
function operationalKindOf(rel: string): string {
  const path = String(rel).replace(/^private\/[^/]+\//, '');
  if (path === 'voice.json') return 'voice';
  if (path === 'buffer.json') return 'buffer';
  if (path === 'inner.json') return 'inner';
  if (path === 'missed.json') return 'missed';
  if (path === 'recall-trace.jsonl') return 'recall_trace';
  if (path === 'forgotten.json') return 'forgotten';
  if (path === 'journal/.running') return 'journal_running';
  if (path === 'record/backfill.json') return 'record_backfill';
  if (/^record\/\d{4}-\d{2}\/ids\.json$/.test(path)) return 'record_ids';
  if (/^archive\/\d{4}-\d{2}\.ids\.json$/.test(path)) return 'archive_ids';
  if (/^archive\/pending[^/]*\.jsonl$/.test(path)) return 'archive_pending';
  if (path.startsWith('backfill/')) return 'backfill';
  if (path.startsWith('forgetting/')) return 'forgetting';
  if (path.startsWith('journal/requests/tools/')) return 'request_tools';
  if (path.startsWith('journal/requests/')) return 'request_dump';
  return 'file';
}

/** The semantic identity of a historical collection without merging its existing replacement boundary. */
export function legacyStorageKey(owner: string, iface = LEGACY_IFACE, legacyKind?: string): UnitKey {
  const root = rootStateKind(owner);
  if (root) return { kind: root as UnitKind, subject: { type: 'persona', id: 'persona:local' } };
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
  const kind = stored as UnitKind;
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
function legacySelector(kind: UnitKind, rel: string): UnitSelector | undefined {
  if (kind === 'intentions') return { collection: rel.endsWith('.jsonl') ? 'archive' : 'active' };
  if (kind === 'errands') return { collection: rel.endsWith('.jsonl') ? 'history' : 'value' };
  if (kind === 'requests') return { requestId: /([^/]+)\.json$/.exec(rel)![1] };
  if (kind === 'versions') {
    const [, versionKind, itemId] = /^versions\/([^/]+)\/(.+)\.json$/.exec(rel)!;
    const named = versionKind === 'guild' ? 'place' : versionKind;
    return { versionKind: named as NonNullable<UnitSelector['versionKind']>, itemId };
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
  kind: UnitKind,
  rel: string,
  iface: string,
  scope: string,
  selector?: UnitSelector
): UnitSubject {
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
