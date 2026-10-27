// Pure helpers and constants of the owner operations (src/tools/impl/*.ts), moved from src/admin.js:
// the rules-file and config-path functions, the profile views, the ping/route formatters, the
// media wording tables and the line formatters several operations share. No I/O but
// `treeSize` (a directory walk for the memory snapshot) and `postingConversation` (a channel
// looked up through the client it is handed).

import fs from 'node:fs';
import path from 'node:path';
import { emptyAffinity, affinityBand, roundScore } from '../../memory/index.js';
import { topByRank } from '../../memory/ranking.js';
import { fromTokens } from '../../memory/mentions.ts';
import { MODEL_ROLES } from './catalog.ts';
import { roleModel } from '../../llm/roles.js';
import { IMAGE_ROLE } from '../../llm/images.js';
import { oneLine } from '../../memory/clamp.js';
import { utcDay } from '../../time.js';
import { denied, invalid } from './registry.ts';
import { CODE } from '../codes.ts';
import { nestedRefusal } from '../access.ts';
import { isObj, objOf } from '../types.ts';
import type { Obj, Untyped } from '../types.ts';
import type { Env } from './env.ts';
import type { Reads } from '../../interface/reads.ts';
import type { Permissions } from '../../protocol/adapter.ts';

/** `/nep memory journal`'s `n`: default and bounds. */
export const JOURNAL_N_DEFAULT = 20;
export const JOURNAL_N_MAX = 50;
export const JOURNAL_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Files and bytes under `dir`, walked recursively. */
export async function treeSize(dir: string): Promise<{ bytes: number; files: number }> {
  let bytes = 0;
  let files = 0;
  for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const inner = await treeSize(full);
      bytes += inner.bytes;
      files += inner.files;
    } else if (entry.isFile()) {
      bytes += (await fs.promises.stat(full)).size;
      files += 1;
    }
  }
  return { bytes, files };
}

export const FORBIDDEN_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);

/** Config paths only an owner may change through `/nep set` and `/nep unset`: who is an owner and
 * who else may run which command. A path under one, or above one (unsetting `bot` drops both), counts. */
export const OWNER_ONLY_CONFIG_PATHS = ['bot.owners', 'bot.access'];

/** The error of every guild-bound command before the served guild resolves. */
export const NO_GUILD = 'no guild resolved yet';

/** The reply for an empty list, the same for every list command. */
export const NONE = '(none)';

// ---------------------------------------------------------------------------
// Pure functions
// ---------------------------------------------------------------------------

/**
 * Locate the bullet lines (`- …`) that belong to the rules list: those under
 * the LAST `## ` heading of the file, in whatever language it is written.
 * When the file has no `## ` heading at all, every top-level bullet counts.
 */
export function locateBullets(text: string): { lines: Array<string>; indices: Array<number> } {
  const lines = text.split('\n');
  let headingIdx = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (/^## /.test(lines[i] ?? '')) {
      headingIdx = i;
      break;
    }
  }

  let start = 0;
  let end = lines.length;

  if (headingIdx !== -1) {
    start = headingIdx + 1;
    end = lines.length;
    for (let i = start; i < lines.length; i += 1) {
      if (/^#/.test(lines[i] ?? '')) {
        end = i;
        break;
      }
    }
  }

  const indices: Array<number> = [];
  for (let i = start; i < end; i += 1) {
    if (/^- /.test(lines[i] ?? '')) indices.push(i);
  }
  return { lines, indices };
}

/**
 * Bullet texts (lines starting with `- `) under the last `## ` heading of the
 * file, in order. When the file has no `## ` heading at all, every top-level
 * `- ` bullet in the file is returned instead.
 */
export function listRules(rulesText: string | null | undefined): Array<string> {
  const { lines, indices } = locateBullets(rulesText ?? '');
  return indices.map((i) => (lines[i] ?? '').slice(2).trimEnd());
}

/**
 * Append `- <rule>` as the last line of `rulesText`. Newlines inside `rule`
 * collapse to single spaces (the file's rule list stays one bullet per
 * line). When the file has no `## ` heading at all, a plain `## Rules`
 * heading is created first — this technical fallback marker, not persona
 * text. Trailing whitespace of the result is normalized to exactly one
 * final `\n`.
 */
export function appendRule(rulesText: string | null | undefined, rule: string): string {
  let text = rulesText ?? '';
  const singleLine = rule
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join(' ');

  if (!/^## /m.test(text)) {
    text = `${text.replace(/\s*$/, '')}\n\n## Rules\n\n`;
  }

  text = `${text.replace(/\s*$/, '')}\n- ${singleLine}`;
  return `${text}\n`;
}

/**
 * Remove the 1-based n-th bullet (in `listRules` order). Returns
 * `{ text, removed }`, or null when `n` is out of range.
 */
export function removeRule(rulesText: string | null | undefined, n: unknown): { text: string; removed: string } | null {
  const text = rulesText ?? '';
  const { lines, indices } = locateBullets(text);
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > indices.length) return null;

  const lineIdx = indices[n - 1] ?? 0;
  const removed = (lines[lineIdx] ?? '').slice(2).trimEnd();
  const remaining = [...lines.slice(0, lineIdx), ...lines.slice(lineIdx + 1)].join('\n');
  const trimmed = remaining.replace(/\s*$/, '');
  return { text: trimmed ? `${trimmed}\n` : '', removed };
}

/**
 * The keys of a dotted config path. With `reference` (the live config) a key that itself holds a
 * dot is read whole: at each level the longest run of the remaining segments that is an own key
 * of the node there wins (`llm.providerByModel.openai/gpt-6.1` -> `llm`, `providerByModel`, `openai/gpt-6.1`), and a segment the reference
 * does not hold is one key. Without it every dot separates keys. A path given as an array of keys
 * is taken as it is. Throws on a forbidden segment.
 */
export function splitPath(dottedPath: string | ReadonlyArray<string>, reference?: unknown): Array<string> {
  const segments = Array.isArray(dottedPath)
    ? [...dottedPath]
    : (dottedPath as string).split('.').filter((part) => part.length > 0);
  for (const part of segments) {
    if (FORBIDDEN_SEGMENTS.has(part)) throw invalid(`forbidden path segment: ${part}`);
  }
  if (Array.isArray(dottedPath) || reference === undefined) return segments;
  const parts: Array<string> = [];
  let node: unknown = reference;
  for (let i = 0; i < segments.length;) {
    let take = 1;
    if (isObj(node)) {
      for (let end = segments.length; end > i + 1; end -= 1) {
        if (Object.hasOwn(node, segments.slice(i, end).join('.'))) {
          take = end - i;
          break;
        }
      }
    }
    const key = segments.slice(i, i + take).join('.');
    parts.push(key);
    node = isObj(node) && Object.hasOwn(node, key) ? node[key] : undefined;
    i += take;
  }
  return parts;
}

/** Deep copy of `object` with `value` set at `dottedPath` (or an array of keys, see splitPath), creating intermediate objects. */
export function setPath(object: unknown, dottedPath: string | ReadonlyArray<string>, value: unknown): Obj {
  const parts = splitPath(dottedPath);
  const root = structuredClone(object ?? {}) as Obj;
  let node: Obj = root;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const key = parts[i] ?? '';
    const child = node[key];
    const next: Obj = isObj(child) ? child : {};
    node[key] = next;
    node = next;
  }
  node[parts[parts.length - 1] ?? ''] = value;
  return root;
}

/** Deep copy of `object` with the key at `dottedPath` (or an array of keys) removed; empty parent objects are pruned. */
export function unsetPath(object: unknown, dottedPath: string | ReadonlyArray<string>): Obj {
  const parts = splitPath(dottedPath);
  const root = structuredClone(object ?? {}) as Obj;
  const chain: Array<unknown> = [root];
  for (let i = 0; i < parts.length - 1; i += 1) {
    const node = chain[chain.length - 1];
    const key = parts[i] ?? '';
    if (node === null || typeof node !== 'object' || !(key in node)) return root;
    chain.push((node as Obj)[key]);
  }

  const leaf = chain[chain.length - 1];
  if (leaf && typeof leaf === 'object') delete (leaf as Obj)[parts[parts.length - 1] ?? ''];

  for (let i = chain.length - 1; i >= 1; i -= 1) {
    const obj = chain[i];
    if (isObj(obj) && Object.keys(obj).length === 0) {
      delete (chain[i - 1] as Obj)[parts[i - 1] ?? ''];
    } else {
      break;
    }
  }
  return root;
}

/** The value at `parts` of `object`, walking own keys only (never an inherited name such as
 * `toString`): `{ found: true, value }`, or `{ found: false }`. */
export function ownValueAt(object: unknown, parts: ReadonlyArray<string>): { found: boolean; value?: unknown } {
  let node: unknown = object;
  for (const part of parts) {
    if (node === null || typeof node !== 'object' || !Object.hasOwn(node, part)) return { found: false };
    node = (node as Obj)[part];
  }
  return { found: true, value: node };
}

/** A config value's JSON type: `null`, `array`, `object`, `string`, `number` or `boolean`. */
export function jsonTypeOf(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/** `a number`, `an array`, ... for an error message. */
export function withArticle(word: string): string {
  return /^[aeiou]/.test(word) ? `an ${word}` : `a ${word}`;
}

/** True when the split config path `parts` is one of OWNER_ONLY_CONFIG_PATHS, under one or above one. */
export function touchesOwnerOnlyConfig(parts: ReadonlyArray<string>): boolean {
  const key = parts.join('.');
  if (!key) return false;
  return OWNER_ONLY_CONFIG_PATHS.some(
    (owned) => key === owned || key.startsWith(`${owned}.`) || owned.startsWith(`${key}.`)
  );
}

/** `, last YYYY-MM-DD` for `/nep memory show`, or '' when `lastSeen` is unknown. */
export function lastDateSuffix(lastSeen: unknown): string {
  return typeof lastSeen === 'string' && lastSeen ? `, last ${lastSeen.slice(0, 10)}` : '';
}

/** `YYYY-MM-DD` (UTC) for an epoch-ms timestamp, or `-` when it is not a finite number. */
export function isoDay(ts: unknown): string {
  return typeof ts === 'number' && Number.isFinite(ts) ? utcDay(ts) : '-';
}

/** Today's UTC day key, the one every daily counter in state.json is kept under (src/time.js). */
export function todayUtc(): string {
  return utcDay(Date.now());
}

/** `on` / `off` for a switch line of a status reply. */
export function onOff(value: unknown): string {
  return value ? 'on' : 'off';
}

/** `(reload ok)` / `(reload FAILED)`: the suffix of every reply that wrote a file and reloaded it. */
export function reloadNote(ok: unknown): string {
  return `(reload ${ok ? 'ok' : 'FAILED'})`;
}

/** The weight an item reaches when the owner confirms it at once (`/nep alias add`,
 * `/nep learned add`): `memory.confirmAfter` rounded up, at least 1 (default 2). */
export function confirmTarget(memoryCfg: unknown): number {
  const given = objOf(memoryCfg).confirmAfter;
  const confirmAfter = typeof given === 'number' && Number.isFinite(given) && given > 0 ? Math.ceil(given) : 2;
  return Math.max(1, confirmAfter);
}

/** The history-backfill stamp of `/nep emoji status` and `/nep gifs status`, or `never`. */
export function backfillText(stamp: Untyped): string {
  return stamp?.at ? `${stamp.at}, ${stamp.channels} channels, ${stamp.messages} messages` : 'never';
}

// ---------------------------------------------------------------------------
// `/nep memory show` — sectioned view
// ---------------------------------------------------------------------------

/** Owner-configurable list length for `/nep memory show`'s per-section views. */
export const MEMORY_SHOW_DEFAULT_LIMIT = 25;
export const MEMORY_SHOW_MAX_LIMIT = 100;

/** Hard ceiling for the `summary` section: the whole reply must fit a single
 * Discord message (2000 chars) — comfortably under that even after the
 * code-fence wrapping interfaces/discord/commands.js#respond adds. */
export const SUMMARY_MAX_CHARS = 1800;

export const DIVIDER_LINE = '-- not shown to the persona (below the shown cap) --';

/** `iso` parsed to epoch ms, or 0 when missing/unparsable — never NaN, so callers can sort safely. */
export function dateMs(iso: unknown): number {
  const ms = typeof iso === 'string' && iso ? Date.parse(iso) : NaN;
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * `value` clamped to `maxChars`, with an ellipsis and (when `sectionName` is
 * given) a pointer to the section that shows it in full, appended once it had
 * to be cut. A short-enough value passes through unchanged, with no pointer.
 */
export function truncateForSummary(value: unknown, maxChars: number, sectionName?: string): string {
  const text = typeof value === 'string' ? value : '';
  if (text.length <= maxChars) return text;
  const cut = text.slice(0, Math.max(0, maxChars - 1)).trimEnd();
  return sectionName ? `${cut}… (full text: section ${sectionName})` : `${cut}…`;
}

/**
 * `/nep memory show`'s default view: a compact, human-readable digest of one
 * profile GUARANTEED to fit a single Discord message (see `SUMMARY_MAX_CHARS`)
 * — long fields are truncated with an ellipsis and, when the full text lives
 * under its own section, a pointer to it. `<@id>` tokens in free-text fields
 * are resolved via `nameOf` the same way every other analyzer-facing text is
 * (src/memory/mentions.ts#fromTokens, mode `'analyzer'`). Pure: no I/O.
 * `memoryCfg` is `hot.config.memory`.
 */
export function buildProfileSummary(
  profile: Untyped,
  memoryCfg: Untyped = {},
  nameOf: (id: string) => string | null = () => null
): string {
  const resolve = (text: unknown): string => fromTokens(typeof text === 'string' ? text : '', nameOf, 'analyzer');

  const names = Array.isArray(profile?.names) ? profile.names : [];
  const currentName = names[0] || `id ${profile?.id}`;
  const formerNames = names.slice(1).join(', ');

  const aliasNames = (topByRank(profile?.aliases ?? [], undefined, memoryCfg.aliasHalfLifeDays) as Array<Untyped>).map(
    (a) => a.name as string
  );

  const affinity = profile?.affinity ?? emptyAffinity();
  const reason = resolve(affinity.reason);

  const topInterests = (topByRank(profile?.interests ?? [], 5, memoryCfg.interestHalfLifeDays) as Array<Untyped>).map(
    (it) => it.topic as string
  );

  const lines = [
    `name: ${currentName}`,
    `former names: ${truncateForSummary(formerNames || 'none', 150)}`,
    `aliases: ${truncateForSummary(aliasNames.join(', ') || 'none', 150, 'aliases')}`,
    `messages: ${profile?.messageCount ?? 0}`,
    `first seen: ${profile?.firstSeen ? profile.firstSeen.slice(0, 10) : '-'}`,
    `last seen: ${profile?.lastSeen ? profile.lastSeen.slice(0, 10) : '-'}`,
    `attitude: ${roundScore(affinity.score ?? 0)} (${affinityBand(affinity.score ?? 0)})${reason ? ` — ${truncateForSummary(reason, 150)}` : ''}`,
    `character: ${truncateForSummary(resolve(profile?.character) || '(empty)', 240, 'character')}`,
    `style: ${truncateForSummary(resolve(profile?.style) || '(empty)', 240, 'style')}`,
    `relationship: ${truncateForSummary(resolve(profile?.relationship) || '(empty)', 240, 'relationship')}`,
    `interests: ${profile?.interests?.length ?? 0} stored, top: ${truncateForSummary(topInterests.join(', ') || 'none', 200, 'interests')}`,
    `details: ${profile?.details?.length ?? 0} stored`,
    `episodes: ${profile?.episodes?.length ?? 0} stored`,
  ];

  let text = lines.join('\n');
  if (text.length > SUMMARY_MAX_CHARS) text = `${text.slice(0, SUMMARY_MAX_CHARS - 1).trimEnd()}…`;
  return text;
}

/**
 * Order + cap one list-shaped section of `/nep memory show` (aliases,
 * interests, details): `order: 'recent'` sorts by `dateOf` descending, no
 * divider; the default `'rank'` order reuses the persona's own rank
 * (src/memory/ranking.js#topByRank) and inserts `DIVIDER_LINE` right after
 * `maxShown` items — the ones the persona is actually shown (see
 * docs/prompt-contract.md, "More is stored than shown, and rank
 * decays with age") — before either is capped to `limit` lines. Never throws
 * on an empty/missing `items`.
 */
export function orderedSectionLines(
  items: ReadonlyArray<Untyped> | null | undefined,
  {
    order,
    limit,
    halfLifeDays,
    maxShown,
    formatLine,
    dateOf = () => 0,
  }: {
    order: 'rank' | 'recent';
    limit: number;
    halfLifeDays?: number;
    maxShown?: number;
    formatLine: (item: Untyped) => string;
    dateOf?: (item: Untyped) => number;
  }
): Array<string> {
  if (!Array.isArray(items) || items.length === 0) return [];

  if (order === 'recent') {
    return [...items]
      .sort((a, b) => dateOf(b) - dateOf(a))
      .slice(0, limit)
      .map((item) => formatLine(item));
  }

  const ranked = topByRank(items, undefined, halfLifeDays).slice(0, limit);
  const lines: Array<string> = [];
  ranked.forEach((item, index) => {
    if (Number.isInteger(maxShown) && index === maxShown) lines.push(DIVIDER_LINE);
    lines.push(formatLine(item));
  });
  return lines;
}

/** Free text as stored, `<@id>` tokens left alone: the resolver of the `raw` view. */
export function asStored(text: unknown): string {
  return typeof text === 'string' ? text : '';
}

/**
 * `/nep memory show`'s `raw` section: the whole profile as JSON, followed by
 * every stored interest/detail/alias in rank order (divider included, the
 * same lines as their sections) and every episode in stored order — `<@id>`
 * tokens are deliberately left unresolved here, unlike every other section.
 */
export function rawMemoryShowView(profile: Untyped, memoryCfg: Untyped): string {
  const lines: Array<string> = [JSON.stringify(profile, null, 2)];
  const everything = (
    items: ReadonlyArray<Untyped>,
    {
      halfLifeDays,
      maxShown,
      formatLine,
    }: { halfLifeDays?: number; maxShown?: number; formatLine: (item: Untyped) => string }
  ): Array<string> =>
    orderedSectionLines(items, {
      order: 'rank',
      limit: Infinity,
      ...(halfLifeDays === undefined ? {} : { halfLifeDays }),
      ...(maxShown === undefined ? {} : { maxShown }),
      formatLine,
    }).map((line) => `  ${line}`);
  const heading = (name: string): string =>
    `${name}: (rank order, everything stored -- see the divider for what the persona is shown)`;
  if (profile.interests?.length) {
    lines.push('', heading('interests'));
    lines.push(
      ...everything(profile.interests, {
        halfLifeDays: memoryCfg?.interestHalfLifeDays,
        maxShown: memoryCfg?.maxInterests,
        formatLine: (it: Untyped) => interestLine(it, asStored),
      })
    );
  }
  if (profile.details?.length) {
    lines.push('', heading('details'));
    lines.push(
      ...everything(profile.details, {
        halfLifeDays: memoryCfg?.detailHalfLifeDays,
        maxShown: memoryCfg?.maxDetails,
        formatLine: (d: Untyped) => detailLine(d, asStored),
      })
    );
  }
  if (profile.aliases?.length) {
    lines.push('', heading('aliases'));
    lines.push(
      ...everything(profile.aliases, {
        halfLifeDays: memoryCfg?.aliasHalfLifeDays,
        maxShown: memoryCfg?.maxAliases,
        formatLine: aliasLine,
      })
    );
  }
  if (profile.episodes?.length) {
    lines.push('', 'episodes:');
    lines.push(...(profile.episodes as Array<Untyped>).map((ep) => `  ${episodeLine(ep, asStored)}`));
  }
  return lines.join('\n');
}

/** One interest line of `/nep memory show` and `/nep private show`; `resolve` turns `<@id>` tokens into names. */
export function interestLine(it: Untyped, resolve: (text: unknown) => string): string {
  const note = resolve(it.note);
  const suffix = `[weight ${it.weight}${lastDateSuffix(it.lastSeen)}]`;
  return note ? `${it.topic} — ${note} ${suffix}` : `${it.topic} ${suffix}`;
}

/** One detail line of `/nep memory show` and `/nep private show`. */
export function detailLine(d: Untyped, resolve: (text: unknown) => string): string {
  return `#${d.id} ${resolve(d.text)} [weight ${d.weight}${lastDateSuffix(d.lastSeen)}]`;
}

/** One episode line of `/nep memory show` and `/nep private show`. */
export function episodeLine(ep: Untyped, resolve: (text: unknown) => string): string {
  const quote = ep.quote ? ` "${ep.quote}"` : '';
  return `${ep.date} [weight ${ep.weight}] ${resolve(ep.what)}${quote}`;
}

/** `[weight N, last DATE] name`, or just `[weight N] name`, used by
 * both the `raw` view (via `rawMemoryShowView`) and the `aliases` section, and by `/nep alias
 * add`/`remove`'s "resulting alias list" reply. */
export function aliasLine(alias: Untyped): string {
  return `[weight ${alias.weight}${lastDateSuffix(alias.lastSeen)}] ${alias.name}`;
}

/** The member's stored aliases, rank-ordered, one per line — the reply `/nep alias
 * add`/`remove` gives after writing. */
export function formatAliasList(profile: Untyped, memoryCfg: Untyped): string {
  const aliases = profile?.aliases ?? [];
  if (!aliases.length) return NONE;
  return (topByRank(aliases, undefined, memoryCfg?.aliasHalfLifeDays) as Array<Untyped>)
    .map((alias) => aliasLine(alias))
    .join('\n');
}

/**
 * The attitude view of `/nep memory affinity` and `/nep memory show section:affinity`: score,
 * band, reason (`-` when empty) and the last 5 history entries, every reason resolved by `resolve`.
 * `affinity` is a stored `{ score, reason, history }`.
 */
export function affinityView(affinity: Untyped, resolve: (text: unknown) => string): string {
  const current = affinity ?? emptyAffinity();
  const history = (current.history ?? [])
    .slice(-5)
    .map(
      (h: Untyped) =>
        `${h.ts} ${h.delta >= 0 ? '+' : ''}${h.delta} -> ${roundScore(h.score)}${h.reason ? `: ${resolve(h.reason)}` : ''}`
    )
    .join('\n');
  return [
    `score: ${roundScore(current.score)}`,
    `band: ${affinityBand(current.score)}`,
    `reason: ${resolve(current.reason) || '-'}`,
    history ? `history:\n${history}` : `history: ${NONE}`,
  ].join('\n');
}

export function readLocalConfig(localPath: string): Obj {
  if (!fs.existsSync(localPath)) return {};
  const raw = fs.readFileSync(localPath, 'utf8').trim();
  if (!raw) return {};
  return JSON.parse(raw) as Obj;
}

export function writeLocalConfig(localPath: string, value: unknown): void {
  fs.writeFileSync(localPath, `${JSON.stringify(value, null, 2)}\n`);
}

// ---------------------------------------------------------------------------
// Model roles and `/nep route`: pure helpers
// ---------------------------------------------------------------------------

export const MODEL_ID_RE = /^[\w.:/-]{3,100}$/;

/** Every role a route may name: the chat and embedding roles, then the drawing model's; never an
 * OpenCode role (src/llm/roles.js#OPENCODE_ROLES), whose worker reads no route. */
export const ROUTE_ROLES: ReadonlyArray<string> = [...MODEL_ROLES, IMAGE_ROLE];

/** A provider slug as OpenRouter writes it: lowercase letters, digits and `-`. */
export const PROVIDER_SLUG_RE = /^[a-z0-9-]+$/;

/** The model id one role resolves to right now (`/nep model show`, `/nep route`, the status
 * card): `models.<group>.<role>`, else the role's own default
 * (src/llm/roles.js#roleModel; no purpose, so no `models.byPurpose` entry). */
export function modelForRole(role: string, cfg: object): string | undefined {
  return roleModel(cfg, role);
}

/** The providers part of a routing object: its `only`/`order`/`ignore` lists, or the object as
 * JSON (without `allow_fallbacks` and `byok`, shown on their own) when it holds anything else. */
export function describeProviders(value: Obj): string {
  const lists = ['only', 'order', 'ignore'];
  const known = new Set([...lists, 'allow_fallbacks', 'byok']);
  const parts = lists.flatMap((field) => {
    const list = value[field];
    return Array.isArray(list) && list.length > 0 ? [`${field} ${list.join(', ')}`] : [];
  });
  if (parts.length > 0 && Object.keys(value).every((field) => known.has(field))) return parts.join('; ');
  const { allow_fallbacks: _ignored, byok: _byok, ...rest } = value;
  return JSON.stringify(rest).slice(0, 200);
}

/** `on` unless the routing object says `allow_fallbacks: false` (OpenRouter's default is on). */
export function fallbacksText(value: Obj): string {
  return onOff(value.allow_fallbacks !== false);
}

/** `on` only when the routing object says exactly `byok: true` (src/llm/openrouter.js#assertByok). */
export function byokText(value: Obj): string {
  return onOff(value.byok === true);
}

/** `(<providers>, fallbacks: on|off)` for the by-role lines, `, byok` appended for a route marked `byok: true`. */
export function routingSummary(value: Obj): string {
  return `(${describeProviders(value)}, fallbacks: ${fallbacksText(value)}${value.byok === true ? ', byok' : ''})`;
}

/** The prefix of a `/nep route` command: trimmed, required, no `@` (the role has its own
 * option), no whitespace, never an object-prototype key. */
export function routePrefixArg(args: unknown): string {
  const model = objOf(args).model;
  const prefix = (typeof model === 'string' ? model : '').trim();
  if (!prefix) throw invalid('a model id or prefix is required');
  if (prefix.includes('@')) throw invalid('the model prefix cannot contain @ (give the role in the role option)');
  if (/\s/.test(prefix)) throw invalid('the model prefix cannot contain spaces');
  if (prefix.length > 100) throw invalid('the model prefix is too long (100 chars max)');
  if (FORBIDDEN_SEGMENTS.has(prefix)) throw invalid(`forbidden model prefix: ${prefix}`);
  return prefix;
}

/** The role of a `/nep route` command, or null for any role. */
export function routeRoleArg(args: unknown): string | null {
  const role = objOf(args).role;
  if (role === undefined || role === null || role === '') return null;
  const name = typeof role === 'string' ? role : '';
  if (!ROUTE_ROLES.includes(name)) throw invalid(`unknown role: ${name} (${ROUTE_ROLES.join(', ')})`);
  return name;
}

// ---------------------------------------------------------------------------
// Access and the media commands: pure helpers
// ---------------------------------------------------------------------------

/** Why `/nep emoji rescan` did not run, by src/memory/emoji-backfill.js's skip reason (the
 * reasons every background job shares -- paused, no guild -- are worded by `skipText`). */
export const EMOJI_RESCAN_SKIPS: Record<string, string> = {
  running: 'An emoji backfill is already running.',
  disabled: 'The emoji backfill is off (context.customEmoji.backfillMessages is 0).',
};

/** Why `/nep gifs rescan` did not run, by src/memory/gif-backfill.js's skip reason. */
export const GIFS_RESCAN_SKIPS: Record<string, string> = {
  running: 'A GIF backfill is already running.',
  disabled: 'The GIF backfill is off (gifs.backfillMessages is 0).',
};

/** Why `/nep gifs recache` did not start, by src/memory/gif-recache.js's skip reason. */
export const GIFS_RECACHE_SKIPS: Record<string, string> = {
  unavailable: 'the GIF recache is not available',
  off: 'GIFs are not watched (features.mediaDescriptions or media.gif.watch is off).',
  'video-off': 'GIFs are not watched while video vision is off (features.videoDescriptions).',
  'no-prompt': 'GIFs are not watched: the describe-video prompt is missing.',
};

/** Why `/nep media kind:pictures action:recache` did not start, by src/memory/gif-recache.js#startMedia's skip reason. */
export const PICTURES_RECACHE_SKIPS: Record<string, string> = {
  unavailable: 'the media recache is not available',
  off: 'Pictures are not described (features.mediaDescriptions is off).',
  'no-prompt': 'Pictures are not described: the describe prompt is missing.',
};

// ---------------------------------------------------------------------------
// Pure line formatters shared by several operations
// ---------------------------------------------------------------------------

/** A channel's stored `topWriters` (`{ id, count }[]`) resolved to current stored names, comma
 * -separated -- an id with no stored profile (e.g. someone who left) is skipped silently, same as
 * src/memory/channels.js#renderChannel's own topWriters line. `''` when there is nothing to show. */
export function channelTopWritersText(topWriters: unknown, nameOf: (id: string) => string | null | undefined): string {
  return (Array.isArray(topWriters) ? topWriters : [])
    .map((writer): string | null => {
      const name = nameOf(writer?.id);
      return name ? `${name} (${writer.count as number})` : null;
    })
    .filter(Boolean)
    .join(', ');
}

/** One line of `/nep memory channel`'s table view (no channel given): name, activity verdict,
 * message count, last message date, whether a note exists (a non-empty `purpose`). */
export function channelTableLine(channel: Untyped, activity: string): string {
  const note = channel.purpose ? 'yes' : 'no';
  return `${channel.name || channel.id}  activity=${activity}  messages=${channel.messageCount ?? 0}  last=${isoDay(channel.lastMessageAt)}  note=${note}`;
}

/** Numbered `1. …` list of `items` (in-jokes/self facts), each resolved via `resolve`; `(none)`
 * when the list is empty. Used by `cmdMemoryServer`. */
export function numberedNotes(items: unknown, resolve: (item: unknown) => string): string {
  const list: Array<unknown> = Array.isArray(items) ? (items as Array<unknown>) : [];
  if (list.length === 0) return NONE;
  return list.map((item, i) => `${i + 1}. ${resolve(item)}`).join('\n');
}

/** One archive entry's text on one line: its text fields joined (an exchange's messages by their text), tokens resolved. */
export function archivedText(entry: unknown, resolve: (text: unknown) => string): string {
  const parts: Array<string> = [];
  for (const value of Object.values(objOf(objOf(entry).text))) {
    if (typeof value === 'string' && value.trim()) parts.push(value);
    else if (Array.isArray(value))
      parts.push(
        (value as Array<unknown>)
          .map((message) => {
            const said = objOf(message).text;
            return typeof said === 'string' ? said : '';
          })
          .filter(Boolean)
          .join(' / ')
      );
  }
  return oneLine(resolve(parts.filter(Boolean).join(' | ')));
}

export function loreLine(entry: Untyped): string {
  return `${entry.id as string}  ${entry.title as string}  keys=${(entry.keys as Array<string>).join(', ')}  source=${entry.source as string}${entry.always ? ' always' : ''}`;
}

/** `#<id> <text> — from <name> · seen <weight> · last <YYYY-MM-DD>`, the `from` part only when
 * the item has one. */
export function learnedLine(item: Untyped, resolve: (text: unknown) => string): string {
  const from = item.from ? ` — from ${resolve(item.from)}` : '';
  const last = String(item.lastSeen ?? item.firstSeen ?? '-').slice(0, 10);
  return `#${item.id} ${resolve(item.text)}${from} · seen ${item.weight} · last ${last}`;
}

/**
 * What an operation does in a conversation other than the one it runs in, and the permissions of the persona it needs
 * there (`info.permissions` of the interface's conversation info): `send` a message, `reply` to one (send, and read the
 * history the reply points into), `attach` a picture (send with a file), `read` the history to find a message (an edit,
 * a deletion, a reaction taken back), `react` to one.
 */
export const CHANNEL_NEEDS: Readonly<
  Record<'send' | 'reply' | 'attach' | 'read' | 'react', (permissions: Permissions) => boolean>
> = Object.freeze({
  send: (permissions) => permissions.send,
  reply: (permissions) => permissions.send && permissions.read,
  attach: (permissions) => permissions.send && permissions.attach,
  read: (permissions) => permissions.read,
  react: (permissions) => permissions.react,
});

/** What posting in another conversation reads of the call's context: where it runs, and the wake it is made in. */
export type PostingContext = {
  channelId?: string | null;
  ownInitiative?: boolean;
  wakeKind?: string;
  env?: Env;
};

/** The skill a channel need stands for, as a wake envelope names it (a read stands for none). */
const NEED_CAPABILITY: Readonly<Record<string, string>> = Object.freeze({
  send: 'message.create',
  reply: 'message.create',
  attach: 'message.create',
  react: 'message.react.add',
});

/**
 * The conversation an operation acting as the persona aims at (`/nep message`, `/nep draw
 * channel:`): `channelId`, else the one the command runs in. The one it runs in passes as it is;
 * any other must be a conversation of the served community (`guildId`; never a private chat) where
 * the persona holds the permissions `need` names (CHANNEL_NEEDS), as the interface reports them
 * (`reads.conversationInfo`, `iface` its name) -- the platform's permissions are the only limit on where.
 * Otherwise a `denied` error (`channel-no-permission`), a conversation the interface does not know
 * included; nothing was done.
 * On her own initiative (an inner turn: `context.ownInitiative` with `context.wakeKind`) a post or a reaction is also
 * asked of the wake's envelope (src/tools/access.ts#nestedRefusal, the live config through `context.env.hot`): a
 * `denied` error (`not-allowed`) before anything is done.
 */
export async function postingConversation({
  reads,
  iface,
  guildId,
  channelId,
  context,
  need,
}: {
  reads: Reads | null;
  iface: string;
  guildId: string | null;
  channelId: string | null | undefined;
  context: PostingContext;
  need: keyof typeof CHANNEL_NEEDS;
}): Promise<string> {
  const capability = NEED_CAPABILITY[need] ?? null;
  if (capability && context?.ownInitiative === true && typeof context.wakeKind === 'string') {
    const refusal = nestedRefusal({ config: context.env?.hot?.config, wakeKind: context.wakeKind, capability });
    if (refusal) throw denied(`the wake envelope does not allow ${capability}`, refusal.reason);
  }
  const id = channelId ? channelId : context.channelId ? context.channelId : null;
  if (!id) throw invalid('a channel is required');
  if (id === (context.channelId ?? '')) return id;
  const allowedThere = CHANNEL_NEEDS[need] as ((permissions: Permissions) => boolean) | undefined;
  if (typeof allowedThere !== 'function') throw new Error(`unknown channel need: ${need}`);
  const found = reads ? await reads.conversationInfo({ iface, conversationId: id }) : null;
  const info = found?.conversation ?? null;
  const served = info !== null && Boolean(guildId) && info.communityId === guildId;
  if (!served || info.kind === 'dm' || !allowedThere(info.permissions)) {
    throw denied(`the bot may not ${need} in channel ${id}`, CODE.CHANNEL_NO_PERMISSION);
  }
  return id;
}

/** The core's own spelling of a message in another conversation, `ref:<conversation>/<message>` (executors.ts#mediaRef). */
const MESSAGE_REF_RE = /^ref:([\w-]{1,64})\/([\w-]{1,64})$/;

/**
 * `{ channelId, messageId }` of a message id (`channelId` null), a `ref:<conversation>/<message>` the core wrote, or a
 * message link a person pasted (with or without angle brackets), which the interface reads (`reads.parseLinks`): the
 * core knows no address grammar of a platform. An `invalid` error (`unknown-message`) for anything else, a link
 * included when there are no reads or the interface does not read links.
 */
export async function messageRefOf(
  value: unknown,
  reads: Reads | null
): Promise<{ channelId: string | null; messageId: string }> {
  const text = (typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '')
    .trim()
    .replace(/^<(.*)>$/, '$1')
    .trim();
  if (/^[\w-]{1,64}$/.test(text)) return { channelId: null, messageId: text };
  const own = MESSAGE_REF_RE.exec(text);
  if (own?.[1] !== undefined && own[2] !== undefined) return { channelId: own[1], messageId: own[2] };
  if (/^https?:\/\//i.test(text) && reads) {
    const parsed = await reads.parseLinks([text]);
    const ref = parsed?.refs[0] ?? null;
    if (ref) return { channelId: ref.conversationId, messageId: ref.messageId };
  }
  throw invalid('a message id or link is required', CODE.UNKNOWN_MESSAGE);
}

/**
 * An interface port's answer (src/interface/port.js) as an operation's: `{ text, ref, at }` when
 * it went out, else a `failed` result with the port's code and `data.unknown` true when it may
 * have taken effect anyway (never retried).
 * `name` is the operation's name, for the summary, and `text` the answer when it went out.
 */
export function portAnswer(name: string, answer: unknown, text: string): Obj {
  const result = objOf(answer);
  if (result.status === 'ok') return { text, ref: result.ref ?? null, at: result.at };
  const given = objOf(result.error).code ?? result.status;
  const code = typeof given === 'string' ? given : CODE.ERROR;
  const unknown = result.status === 'unknown';
  return {
    status: 'failed',
    code,
    summary: `${name}: ${unknown ? 'unclear whether it went through' : 'failed'} (${code})`,
    data: { unknown, portStatus: result.status ?? null },
  };
}
