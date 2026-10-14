// Pure helpers and constants of the owner operations (src/ops/*.js), moved from src/admin.js:
// the rules-file and config-path functions, the profile views, the ping/route formatters, the
// media wording tables and the line formatters several operations share. No I/O but
// `treeSize` (a directory walk for the memory snapshot).

import fs from 'node:fs';
import path from 'node:path';
import { emptyAffinity, affinityBand, roundScore } from '../memory/affinity.js';
import { topByRank } from '../memory/ranking.js';
import { fromTokens } from '../memory/mentions.js';
import { MODEL_ROLES } from '../discord/commands.js';
import { helperModel } from '../behavior/mention.js';
import { IMAGE_ROLE } from '../llm/images.js';
import { oneLine } from '../memory/clamp.js';
import { utcDay } from '../time.js';
import { invalid } from './registry.js';

/** `/nep memory journal`'s `n`: default and bounds. */
export const JOURNAL_N_DEFAULT = 20;
export const JOURNAL_N_MAX = 50;
export const JOURNAL_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** Files and bytes under `dir`, walked recursively. */
export async function treeSize(dir) {
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
export function locateBullets(text) {
  const lines = text.split('\n');
  let headingIdx = -1;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (/^## /.test(lines[i])) {
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
      if (/^#/.test(lines[i])) {
        end = i;
        break;
      }
    }
  }

  const indices = [];
  for (let i = start; i < end; i += 1) {
    if (/^- /.test(lines[i])) indices.push(i);
  }
  return { lines, indices };
}

/**
 * Bullet texts (lines starting with `- `) under the last `## ` heading of the
 * file, in order. When the file has no `## ` heading at all, every top-level
 * `- ` bullet in the file is returned instead.
 */
export function listRules(rulesText) {
  const { lines, indices } = locateBullets(String(rulesText ?? ''));
  return indices.map((i) => lines[i].slice(2).trimEnd());
}

/**
 * Append `- <rule>` as the last line of `rulesText`. Newlines inside `rule`
 * collapse to single spaces (the file's rule list stays one bullet per
 * line). When the file has no `## ` heading at all, a plain `## Rules`
 * heading is created first — this technical fallback marker, not persona
 * text. Trailing whitespace of the result is normalized to exactly one
 * final `\n`.
 */
export function appendRule(rulesText, rule) {
  let text = String(rulesText ?? '');
  const singleLine = String(rule)
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
export function removeRule(rulesText, n) {
  const text = String(rulesText ?? '');
  const { lines, indices } = locateBullets(text);
  if (!Number.isInteger(n) || n < 1 || n > indices.length) return null;

  const lineIdx = indices[n - 1];
  const removed = lines[lineIdx].slice(2).trimEnd();
  const remaining = [...lines.slice(0, lineIdx), ...lines.slice(lineIdx + 1)].join('\n');
  const trimmed = remaining.replace(/\s*$/, '');
  return { text: trimmed ? `${trimmed}\n` : '', removed };
}

export function splitPath(dottedPath) {
  const parts = String(dottedPath).split('.').filter((part) => part.length > 0);
  for (const part of parts) {
    if (FORBIDDEN_SEGMENTS.has(part)) throw invalid(`forbidden path segment: ${part}`);
  }
  return parts;
}

/** Deep copy of `object` with `value` set at `dottedPath`, creating intermediate objects. */
export function setPath(object, dottedPath, value) {
  const parts = splitPath(dottedPath);
  const root = structuredClone(object ?? {});
  let node = root;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const key = parts[i];
    const child = node[key];
    node[key] = child && typeof child === 'object' && !Array.isArray(child) ? child : {};
    node = node[key];
  }
  node[parts[parts.length - 1]] = value;
  return root;
}

/** Deep copy of `object` with the key at `dottedPath` removed; empty parent objects are pruned. */
export function unsetPath(object, dottedPath) {
  const parts = splitPath(dottedPath);
  const root = structuredClone(object ?? {});
  const chain = [root];
  for (let i = 0; i < parts.length - 1; i += 1) {
    const node = chain[chain.length - 1];
    const key = parts[i];
    if (node === null || typeof node !== 'object' || !(key in node)) return root;
    chain.push(node[key]);
  }

  const leaf = chain[chain.length - 1];
  if (leaf && typeof leaf === 'object') delete leaf[parts[parts.length - 1]];

  for (let i = chain.length - 1; i >= 1; i -= 1) {
    const obj = chain[i];
    if (obj && typeof obj === 'object' && !Array.isArray(obj) && Object.keys(obj).length === 0) {
      delete chain[i - 1][parts[i - 1]];
    } else {
      break;
    }
  }
  return root;
}

/** The value at `parts` of `object`, walking own keys only (never an inherited name such as
 * `toString`): `{ found: true, value }`, or `{ found: false }`. */
export function ownValueAt(object, parts) {
  let node = object;
  for (const part of parts) {
    if (node === null || typeof node !== 'object' || !Object.hasOwn(node, part)) return { found: false };
    node = node[part];
  }
  return { found: true, value: node };
}

/** A config value's JSON type: `null`, `array`, `object`, `string`, `number` or `boolean`. */
export function jsonTypeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/** `a number`, `an array`, ... for an error message. */
export function withArticle(word) {
  return /^[aeiou]/.test(word) ? `an ${word}` : `a ${word}`;
}

/** True when the split config path `parts` is one of OWNER_ONLY_CONFIG_PATHS, under one or above one. */
export function touchesOwnerOnlyConfig(parts) {
  const key = parts.join('.');
  if (!key) return false;
  return OWNER_ONLY_CONFIG_PATHS.some((owned) => key === owned || key.startsWith(`${owned}.`) || owned.startsWith(`${key}.`));
}

/** `, last YYYY-MM-DD` for `/nep memory show`, or '' when `lastSeen` is unknown. */
export function lastDateSuffix(lastSeen) {
  return typeof lastSeen === 'string' && lastSeen ? `, last ${lastSeen.slice(0, 10)}` : '';
}

/** `YYYY-MM-DD` (UTC) for an epoch-ms timestamp, or `-` when it is not a finite number. */
export function isoDay(ts) {
  return Number.isFinite(ts) ? utcDay(ts) : '-';
}

/** Today's UTC day key, the one every daily counter in state.json is kept under (src/time.js). */
export function todayUtc() {
  return utcDay(Date.now());
}

/** `on` / `off` for a switch line of a status reply. */
export function onOff(value) {
  return value ? 'on' : 'off';
}

/** `(reload ok)` / `(reload FAILED)`: the suffix of every reply that wrote a file and reloaded it. */
export function reloadNote(ok) {
  return `(reload ${ok ? 'ok' : 'FAILED'})`;
}

/** The weight an item reaches when the owner confirms it at once (`/nep alias add`,
 * `/nep learned add`): `memory.confirmAfter` rounded up, at least 1 (default 2). */
export function confirmTarget(memoryCfg) {
  const confirmAfter = Number.isFinite(memoryCfg?.confirmAfter) && memoryCfg.confirmAfter > 0 ? Math.ceil(memoryCfg.confirmAfter) : 2;
  return Math.max(1, confirmAfter);
}

/** The history-backfill stamp of `/nep emoji status` and `/nep gifs status`, or `never`. */
export function backfillText(stamp) {
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
 * code-fence wrapping src/discord/commands.js#respond adds. */
export const SUMMARY_MAX_CHARS = 1800;

export const DIVIDER_LINE = '-- not shown to the persona (below the shown cap) --';

/** `iso` parsed to epoch ms, or 0 when missing/unparsable — never NaN, so callers can sort safely. */
export function dateMs(iso) {
  const ms = typeof iso === 'string' && iso ? Date.parse(iso) : NaN;
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * `value` clamped to `maxChars`, with an ellipsis and (when `sectionName` is
 * given) a pointer to the section that shows it in full, appended once it had
 * to be cut. A short-enough value passes through unchanged, with no pointer.
 */
export function truncateForSummary(value, maxChars, sectionName) {
  const text = String(value ?? '');
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
 * (src/memory/mentions.js#fromTokens, mode `'analyzer'`). Pure: no I/O.
 * @param {object} profile
 * @param {object} [memoryCfg]  hot.config.memory
 * @param {(id: string) => (string|null)} [nameOf]
 * @returns {string}
 */
export function buildProfileSummary(profile, memoryCfg = {}, nameOf = () => null) {
  const resolve = (text) => fromTokens(typeof text === 'string' ? text : '', nameOf, 'analyzer');

  const names = Array.isArray(profile?.names) ? profile.names : [];
  const currentName = names[0] || `id ${profile?.id}`;
  const formerNames = names.slice(1).join(', ');

  const aliasNames = topByRank(profile?.aliases ?? [], undefined, memoryCfg.aliasHalfLifeDays).map((a) => a.name);

  const affinity = profile?.affinity ?? emptyAffinity();
  const reason = resolve(affinity.reason);

  const topInterests = topByRank(profile?.interests ?? [], 5, memoryCfg.interestHalfLifeDays).map((it) => it.topic);

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
 * @param {object[]} items
 * @param {{ order: 'rank'|'recent', limit: number, halfLifeDays?: number,
 *   maxShown?: number, formatLine: (item: object) => string, dateOf?: (item: object) => number }} opts
 * @returns {string[]}
 */
export function orderedSectionLines(items, { order, limit, halfLifeDays, maxShown, formatLine, dateOf }) {
  if (!Array.isArray(items) || items.length === 0) return [];

  if (order === 'recent') {
    return [...items]
      .sort((a, b) => dateOf(b) - dateOf(a))
      .slice(0, limit)
      .map(formatLine);
  }

  const ranked = topByRank(items, undefined, halfLifeDays).slice(0, limit);
  const lines = [];
  ranked.forEach((item, index) => {
    if (Number.isInteger(maxShown) && index === maxShown) lines.push(DIVIDER_LINE);
    lines.push(formatLine(item));
  });
  return lines;
}

/** Free text as stored, `<@id>` tokens left alone: the resolver of the `raw` view. */
export function asStored(text) {
  return typeof text === 'string' ? text : '';
}

/**
 * `/nep memory show`'s `raw` section: the whole profile as JSON, followed by
 * every stored interest/detail/alias in rank order (divider included, the
 * same lines as their sections) and every episode in stored order — `<@id>`
 * tokens are deliberately left unresolved here, unlike every other section.
 */
export function rawMemoryShowView(profile, memoryCfg) {
  const lines = [JSON.stringify(profile, null, 2)];
  const everything = (items, { halfLifeDays, maxShown, formatLine }) =>
    orderedSectionLines(items, { order: 'rank', limit: Infinity, halfLifeDays, maxShown, formatLine }).map((line) => `  ${line}`);
  const heading = (name) => `${name}: (rank order, everything stored -- see the divider for what the persona is shown)`;
  if (profile.interests?.length) {
    lines.push('', heading('interests'));
    lines.push(
      ...everything(profile.interests, {
        halfLifeDays: memoryCfg?.interestHalfLifeDays,
        maxShown: memoryCfg?.maxInterests,
        formatLine: (it) => interestLine(it, asStored),
      }),
    );
  }
  if (profile.details?.length) {
    lines.push('', heading('details'));
    lines.push(
      ...everything(profile.details, {
        halfLifeDays: memoryCfg?.detailHalfLifeDays,
        maxShown: memoryCfg?.maxDetails,
        formatLine: (d) => detailLine(d, asStored),
      }),
    );
  }
  if (profile.aliases?.length) {
    lines.push('', heading('aliases'));
    lines.push(
      ...everything(profile.aliases, {
        halfLifeDays: memoryCfg?.aliasHalfLifeDays,
        maxShown: memoryCfg?.maxAliases,
        formatLine: aliasLine,
      }),
    );
  }
  if (profile.episodes?.length) {
    lines.push('', 'episodes:');
    lines.push(...profile.episodes.map((ep) => `  ${episodeLine(ep, asStored)}`));
  }
  return lines.join('\n');
}

/** One interest line of `/nep memory show` and `/nep private show`; `resolve` turns `<@id>` tokens into names. */
export function interestLine(it, resolve) {
  const note = resolve(it.note);
  const suffix = `[weight ${it.weight}${lastDateSuffix(it.lastSeen)}]`;
  return note ? `${it.topic} — ${note} ${suffix}` : `${it.topic} ${suffix}`;
}

/** One detail line of `/nep memory show` and `/nep private show`. */
export function detailLine(d, resolve) {
  return `#${d.id} ${resolve(d.text)} [weight ${d.weight}${lastDateSuffix(d.lastSeen)}]`;
}

/** One episode line of `/nep memory show` and `/nep private show`. */
export function episodeLine(ep, resolve) {
  const quote = ep.quote ? ` "${ep.quote}"` : '';
  return `${ep.date} [weight ${ep.weight}] ${resolve(ep.what)}${quote}`;
}

/** `[weight N, last DATE] name`, or just `[weight N] name`, used by
 * both the `raw` view (via `rawMemoryShowView`) and the `aliases` section, and by `/nep alias
 * add`/`remove`'s "resulting alias list" reply. */
export function aliasLine(alias) {
  return `[weight ${alias.weight}${lastDateSuffix(alias.lastSeen)}] ${alias.name}`;
}

/** The member's stored aliases, rank-ordered, one per line — the reply `/nep alias
 * add`/`remove` gives after writing. */
export function formatAliasList(profile, memoryCfg) {
  const aliases = profile?.aliases ?? [];
  if (!aliases.length) return NONE;
  return topByRank(aliases, undefined, memoryCfg?.aliasHalfLifeDays).map(aliasLine).join('\n');
}

/**
 * The attitude view of `/nep memory affinity` and `/nep memory show section:affinity`: score,
 * band, reason (`-` when empty) and the last 5 history entries, every reason resolved by `resolve`.
 * @param {object|null|undefined} affinity  A stored `{ score, reason, history }`.
 * @param {(text: unknown) => string} resolve
 * @returns {string}
 */
export function affinityView(affinity, resolve) {
  const current = affinity ?? emptyAffinity();
  const history = (current.history ?? [])
    .slice(-5)
    .map((h) => `${h.ts} ${h.delta >= 0 ? '+' : ''}${h.delta} -> ${roundScore(h.score)}${h.reason ? `: ${resolve(h.reason)}` : ''}`)
    .join('\n');
  return [
    `score: ${roundScore(current.score)}`,
    `band: ${affinityBand(current.score)}`,
    `reason: ${resolve(current.reason) || '-'}`,
    history ? `history:\n${history}` : `history: ${NONE}`,
  ].join('\n');
}

export function readLocalConfig(localPath) {
  if (!fs.existsSync(localPath)) return {};
  const raw = fs.readFileSync(localPath, 'utf8').trim();
  if (!raw) return {};
  return JSON.parse(raw);
}

export function writeLocalConfig(localPath, value) {
  fs.writeFileSync(localPath, `${JSON.stringify(value, null, 2)}\n`);
}

/** The oldest id of a page of messages, by snowflake order (the next page's `before`). */
export function oldestMessageId(batch) {
  let oldest = batch[batch.length - 1].id;
  for (const message of batch) {
    try {
      if (BigInt(message.id) < BigInt(oldest)) oldest = message.id;
    } catch {
      return batch[batch.length - 1].id;
    }
  }
  return oldest;
}

// ---------------------------------------------------------------------------
// Model roles and `/nep route`: pure helpers
// ---------------------------------------------------------------------------

export const MODEL_ID_RE = /^[\w.:/-]{3,100}$/;

/** Every role a route may name: the `/nep model` roles, then the drawing model's. */
export const ROUTE_ROLES = [...MODEL_ROLES, IMAGE_ROLE];

/** A provider slug as OpenRouter writes it: lowercase letters, digits and `-`. */
export const PROVIDER_SLUG_RE = /^[a-z0-9-]+$/;

/** The model id one role resolves to right now (`/nep model show`, the status card). */
export function modelForRole(role, cfg) {
  // The one model that speaks as the persona: its replies and its memory wording.
  if (role === 'voice') return cfg?.llm?.model || undefined;
  if (role === 'analyzer') return cfg?.memory?.model || cfg?.llm?.model || undefined;
  // A helper role: its own model with its fallback chain (no purpose, so no byPurpose entry).
  return helperModel(cfg, { role });
}

/** The model one route role uses now: the `/nep model` roles as `modelForRole`, `image` as `image.model`. */
export function modelForRouteRole(role, cfg) {
  if (role === IMAGE_ROLE) return cfg?.image?.model || undefined;
  return modelForRole(role, cfg);
}

/** The providers part of a routing object: its `only`/`order`/`ignore` lists, or the object as
 * JSON (without `allow_fallbacks`, shown on its own) when it holds anything else. */
export function describeProviders(value) {
  const lists = ['only', 'order', 'ignore'];
  const known = new Set([...lists, 'allow_fallbacks']);
  const parts = lists
    .filter((field) => Array.isArray(value[field]) && value[field].length > 0)
    .map((field) => `${field} ${value[field].join(', ')}`);
  if (parts.length > 0 && Object.keys(value).every((field) => known.has(field))) return parts.join('; ');
  const { allow_fallbacks: _ignored, ...rest } = value;
  return JSON.stringify(rest).slice(0, 200);
}

/** `on` unless the routing object says `allow_fallbacks: false` (OpenRouter's default is on). */
export function fallbacksText(value) {
  return onOff(value.allow_fallbacks !== false);
}

/** `(<providers>, fallbacks: on|off)` for the by-role lines. */
export function routingSummary(value) {
  return `(${describeProviders(value)}, fallbacks: ${fallbacksText(value)})`;
}

/** The prefix of a `/nep route` command: trimmed, required, no `@` (the role has its own
 * option), no whitespace, never an object-prototype key. */
export function routePrefixArg(args) {
  const prefix = String(args?.model ?? '').trim();
  if (!prefix) throw invalid('a model id or prefix is required');
  if (prefix.includes('@')) throw invalid('the model prefix cannot contain @ (give the role in the role option)');
  if (/\s/.test(prefix)) throw invalid('the model prefix cannot contain spaces');
  if (prefix.length > 100) throw invalid('the model prefix is too long (100 chars max)');
  if (FORBIDDEN_SEGMENTS.has(prefix)) throw invalid(`forbidden model prefix: ${prefix}`);
  return prefix;
}

/** The role of a `/nep route` command, or null for any role. */
export function routeRoleArg(args) {
  const role = args?.role;
  if (role === undefined || role === null || role === '') return null;
  if (!ROUTE_ROLES.includes(String(role))) throw invalid(`unknown role: ${role} (${ROUTE_ROLES.join(', ')})`);
  return String(role);
}

// ---------------------------------------------------------------------------
// Access and the media commands: pure helpers
// ---------------------------------------------------------------------------

/** A refused warmup or portrait outcome as the owner reads it: its message, else its reason code. */
export function outcomeText(outcome, fallback) {
  return outcome?.message ?? outcome?.reason ?? fallback;
}

/** Why `/nep emoji rescan` did not run, by src/memory/emoji-backfill.js's skip reason (the
 * reasons every background job shares -- paused, no guild -- are worded by `skipText`). */
export const EMOJI_RESCAN_SKIPS = {
  running: 'An emoji backfill is already running.',
  disabled: 'The emoji backfill is off (context.customEmoji.backfillMessages is 0).',
};

/** Why `/nep gifs rescan` did not run, by src/memory/gif-backfill.js's skip reason. */
export const GIFS_RESCAN_SKIPS = {
  running: 'A GIF backfill is already running.',
  disabled: 'The GIF backfill is off (gifs.backfillMessages is 0).',
};

/** Why `/nep gifs recache` did not start, by src/memory/gif-recache.js's skip reason. */
export const GIFS_RECACHE_SKIPS = {
  unavailable: 'the GIF recache is not available',
  off: 'GIFs are not watched (features.mediaDescriptions or media.gif.watch is off).',
  'video-off': 'GIFs are not watched while video vision is off (features.videoDescriptions).',
  'no-prompt': 'GIFs are not watched: the describe-video prompt is missing.',
};

// ---------------------------------------------------------------------------
// Pure line formatters shared by several operations
// ---------------------------------------------------------------------------

/** A channel's stored `topWriters` (`{ id, count }[]`) resolved to current stored names, comma
 * -separated -- an id with no stored profile (e.g. someone who left) is skipped silently, same as
 * src/memory/channels.js#renderChannel's own topWriters line. `''` when there is nothing to show. */
export function channelTopWritersText(topWriters, nameOf) {
  return (Array.isArray(topWriters) ? topWriters : [])
    .map((writer) => {
      const name = nameOf(writer?.id);
      return name ? `${name} (${writer.count})` : null;
    })
    .filter(Boolean)
    .join(', ');
}

/** One line of `/nep memory channel`'s table view (no channel given): name, activity verdict,
 * message count, last message date, whether a note exists (a non-empty `purpose`). */
export function channelTableLine(channel, activity) {
  const note = channel.purpose ? 'yes' : 'no';
  return `${channel.name || channel.id}  activity=${activity}  messages=${channel.messageCount ?? 0}  last=${isoDay(channel.lastMessageAt)}  note=${note}`;
}

/** Numbered `1. …` list of `items` (in-jokes/self facts), each resolved via `resolve`; `(none)`
 * when the list is empty. Used by `cmdMemoryServer`. */
export function numberedNotes(items, resolve) {
  const list = Array.isArray(items) ? items : [];
  if (list.length === 0) return NONE;
  return list.map((item, i) => `${i + 1}. ${resolve(item)}`).join('\n');
}

/** One archive entry's text on one line: its text fields joined (an exchange's messages by their text), tokens resolved. */
export function archivedText(entry, resolve) {
  const parts = [];
  for (const value of Object.values(entry?.text ?? {})) {
    if (typeof value === 'string' && value.trim()) parts.push(value);
    else if (Array.isArray(value)) parts.push(value.map((message) => (typeof message?.text === 'string' ? message.text : '')).filter(Boolean).join(' / '));
  }
  return oneLine(resolve(parts.filter(Boolean).join(' | ')));
}

export function loreLine(entry) {
  return `${entry.id}  ${entry.title}  keys=${entry.keys.join(', ')}  source=${entry.source}${entry.always ? ' always' : ''}`;
}

/** `#<id> <text> — from <name> · seen <weight> · last <YYYY-MM-DD>`, the `from` part only when
 * the item has one. */
export function learnedLine(item, resolve) {
  const from = item.from ? ` — from ${resolve(item.from)}` : '';
  const last = String(item.lastSeen ?? item.firstSeen ?? '-').slice(0, 10);
  return `#${item.id} ${resolve(item.text)}${from} · seen ${item.weight} · last ${last}`;
}
