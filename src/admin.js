// Owner commands, driven by Discord slash commands (src/discord/commands.js)
// so the owner can tune the running bot from Discord without a restart and
// without ever touching data/: live rules (prompts.local/rules.md, seeded
// from prompts/rules.md), config overrides (config.local.json, hot-reloaded),
// status, a manual interject/initiate of the spontaneous scheduler, and
// profile inspection/deletion, plus one member command, `/nep pings` (cmdPings: a
// member's own notification switch, open to everyone while
// `features.memberCommands` is on). This is the ONLY place in the project that ever
// deletes stored memory, through the three functions store.js allows for it:
// store.forgetUser (one profile, private layer included), store.forgetPrivate
// (one member's private layer only, `/nep private forget` and
// `/nep private purge`) and
// store.wipeGuild (a whole guild's memory,
// `/nep memory wipe`, gated by the served guild's exact name). The tracked
// prompts/ layer is never written at runtime — live corrections always land
// in the untracked prompts.local/ layer.
//
// This module knows nothing about discord.js: `createAdmin(deps).run` takes
// a `commandKey` (e.g. `'memory.forget'`), a plain `args` object and a
// `context` (`{ guildId, channelId, userId }`) and returns the reply text
// (or, for `/nep draw` and `/nep mentor show`, `{ text, files }` with the
// picture or the report file), or throws an
// `Error` with an operator-facing message on bad input. Mapping a
// discord.js interaction's options onto `args` is src/discord/commands.js's
// job. Everything below the pure-function section is thin I/O glued around
// them; the pure functions (listRules, appendRule, removeRule, setPath,
// unsetPath, buildProfileSummary) are unit-tested directly with no filesystem
// or Discord involved.

import fs from 'node:fs';
import path from 'node:path';
import { isPlainObject } from './config.js';
import { emptyAffinity, affinityBand, roundScore } from './memory/affinity.js';
import { topByRank, sortByRank } from './memory/ranking.js';
import { fromTokens } from './memory/mentions.js';
import { sortEpisodesForDisplay } from './memory/episodes.js';
import { channelActivity } from './memory/channels.js';
import { normalizeTopic } from './memory/interests.js';
import { applyAliasOps } from './memory/aliases.js';
import { rankEmojiUsage } from './memory/emoji-usage.js';
import { rankGifs } from './memory/gifs.js';
import { gifCaptionCounts, gifFormatCounts } from './memory/gif-recache.js';
import { gifPostsToday, gifWatchesToday } from './memory/gif-watch.js';
import { commandKeys, leafPaths, MEMORY_SHOW_SECTIONS, MODEL_ROLES, MODEL_SET_PATHS, MODEL_SET_ROLES, PINGS_MODES } from './discord/commands.js';
import {
  isAllowed as accessIsAllowed,
  isOwnerId,
  isOwnerOnly,
  isMemberCommand,
  grant as accessGrant,
  revoke as accessRevoke,
  hasGrant,
} from './discord/access.js';
import { avatarReference } from './discord/fetch-image.js';
import { classifierTextModel, classifierMediaModel, classifierVideoModel } from './behavior/mention.js';
import { buildDrawPrompt } from './behavior/prompt.js';
import { imageFileName } from './behavior/turn.js';
import { initiateCooldownUntil } from './behavior/spontaneous.js';
import { effectiveAffinity, privateRepliesToday } from './behavior/private.js';
import { ImageCapError, ImageGenError, UnsupportedImageModelError, familyOf as imageFamilyOf, IMAGE_ROLE } from './llm/images.js';
import { matchRoute, resolveProvider, llmCountToday } from './llm/openrouter.js';
import { PAGE, canAttach, canRead, canSend } from './discord/collect.js';
import { backfillDiary } from './behavior/diary.js';
import { anchorMax, checkCaseText } from './mentor/cases.js';
import { renderCard, renderFile, renderLastRun } from './mentor/report.js';
import { log } from './log.js';
import { clampAtBoundary, oneLine } from './memory/clamp.js';
import { ARCHIVE_KINDS, archiveEntry } from './memory/archive.js';
import { countToday, utcDay, zonedDay } from './time.js';
import { formatClock } from './discord/format.js';
import { liveRecent, recentSettings } from './memory/recent.js';
import { VOICE_DAILY } from './memory/update.js';
import { PORTRAIT_SLOTS, portraitSettings } from './memory/portrait.js';

/** `/nep access grant/revoke`'s command keys that ONLY read — everything else (including every
 * group and `*`) is treated as opening a write command, and gets the "changes memory or config"
 * note in the grant reply. The owner-only `private`, `mentor` and `access` commands are never grantable at all
 * (src/discord/access.js#isOwnerOnly), so they are not listed here. docs/en/owner-commands.md
 * describes each command; a new read-only command is simply added here. `ping` writes nothing
 * but spends balance outside the daily request cap: its grant reply says so (SPENDS_BALANCE_KEYS). */
const READ_ONLY_ACCESS_KEYS = new Set([
  'status',
  'ping',
  'memory.show',
  'memory.channel',
  'memory.server',
  'memory.recent',
  'memory.archive',
  'rule.list',
  'lore.list',
  'lore.show',
  'learned.list',
  'model.show',
  'emoji.status',
  'gifs.status',
  'warmup.status',
  'warmup.people',
  'route.list',
  'diary.show',
]);

/** Command keys whose every call spends OpenRouter balance outside `llm.maxRequestsPerDay`
 * (`/nep ping`: up to one request per role); their grant reply says so. */
const SPENDS_BALANCE_KEYS = new Set(['ping']);

/** How `/nep access grant` names each owner-only group (src/discord/access.js#OWNER_ONLY_GROUPS) when it refuses it. */
const OWNER_ONLY_NAMES = { private: 'private memory', mentor: 'the mentor', access: 'access management', diary: 'the diary' };

const FORBIDDEN_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);

/** Config paths only an owner may change through `/nep set` and `/nep unset`: who is an owner and
 * who else may run which command. A path under one, or above one (unsetting `bot` drops both), counts. */
const OWNER_ONLY_CONFIG_PATHS = ['bot.owners', 'bot.access'];

/** The error of every guild-bound command before the served guild resolves. */
const NO_GUILD = 'no guild resolved yet';

/** The reply for an empty list, the same for every list command. */
const NONE = '(none)';

// ---------------------------------------------------------------------------
// Pure functions
// ---------------------------------------------------------------------------

/**
 * Locate the bullet lines (`- …`) that belong to the rules list: those under
 * the LAST `## ` heading of the file, in whatever language it is written.
 * When the file has no `## ` heading at all, every top-level bullet counts.
 */
function locateBullets(text) {
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

function splitPath(dottedPath) {
  const parts = String(dottedPath).split('.').filter((part) => part.length > 0);
  for (const part of parts) {
    if (FORBIDDEN_SEGMENTS.has(part)) throw new Error(`forbidden path segment: ${part}`);
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
function ownValueAt(object, parts) {
  let node = object;
  for (const part of parts) {
    if (node === null || typeof node !== 'object' || !Object.hasOwn(node, part)) return { found: false };
    node = node[part];
  }
  return { found: true, value: node };
}

/** A config value's JSON type: `null`, `array`, `object`, `string`, `number` or `boolean`. */
function jsonTypeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/** `a number`, `an array`, ... for an error message. */
function withArticle(word) {
  return /^[aeiou]/.test(word) ? `an ${word}` : `a ${word}`;
}

/** True when the split config path `parts` is one of OWNER_ONLY_CONFIG_PATHS, under one or above one. */
function touchesOwnerOnlyConfig(parts) {
  const key = parts.join('.');
  if (!key) return false;
  return OWNER_ONLY_CONFIG_PATHS.some((owned) => key === owned || key.startsWith(`${owned}.`) || owned.startsWith(`${key}.`));
}

/** `, last YYYY-MM-DD` for `/nep memory show`, or '' when `lastSeen` is unknown. */
function lastDateSuffix(lastSeen) {
  return typeof lastSeen === 'string' && lastSeen ? `, last ${lastSeen.slice(0, 10)}` : '';
}

/** `YYYY-MM-DD` (UTC) for an epoch-ms timestamp, or `-` when it is not a finite number. */
function isoDay(ts) {
  return Number.isFinite(ts) ? utcDay(ts) : '-';
}

/** Today's UTC day key, the one every daily counter in state.json is kept under (src/time.js). */
function todayUtc() {
  return utcDay(Date.now());
}

/** `on` / `off` for a switch line of a status reply. */
function onOff(value) {
  return value ? 'on' : 'off';
}

/** `(reload ok)` / `(reload FAILED)`: the suffix of every reply that wrote a file and reloaded it. */
function reloadNote(ok) {
  return `(reload ${ok ? 'ok' : 'FAILED'})`;
}

/** The weight an item reaches when the owner confirms it at once (`/nep alias add`,
 * `/nep learned add`): `memory.confirmAfter` rounded up, at least 1 (default 2). */
function confirmTarget(memoryCfg) {
  const confirmAfter = Number.isFinite(memoryCfg?.confirmAfter) && memoryCfg.confirmAfter > 0 ? Math.ceil(memoryCfg.confirmAfter) : 2;
  return Math.max(1, confirmAfter);
}

/** The history-backfill stamp of `/nep emoji status` and `/nep gifs status`, or `never`. */
function backfillText(stamp) {
  return stamp?.at ? `${stamp.at}, ${stamp.channels} channels, ${stamp.messages} messages` : 'never';
}

// ---------------------------------------------------------------------------
// `/nep memory show` — sectioned view
// ---------------------------------------------------------------------------

/** Owner-configurable list length for `/nep memory show`'s per-section views. */
const MEMORY_SHOW_DEFAULT_LIMIT = 25;
const MEMORY_SHOW_MAX_LIMIT = 100;

/** Hard ceiling for the `summary` section: the whole reply must fit a single
 * Discord message (2000 chars) — comfortably under that even after the
 * code-fence wrapping src/discord/commands.js#respond adds. */
const SUMMARY_MAX_CHARS = 1800;

const DIVIDER_LINE = '-- not shown to the persona (below the shown cap) --';

/** `iso` parsed to epoch ms, or 0 when missing/unparsable — never NaN, so callers can sort safely. */
function dateMs(iso) {
  const ms = typeof iso === 'string' && iso ? Date.parse(iso) : NaN;
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * `value` clamped to `maxChars`, with an ellipsis and (when `sectionName` is
 * given) a pointer to the section that shows it in full, appended once it had
 * to be cut. A short-enough value passes through unchanged, with no pointer.
 */
function truncateForSummary(value, maxChars, sectionName) {
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
function orderedSectionLines(items, { order, limit, halfLifeDays, maxShown, formatLine, dateOf }) {
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
function asStored(text) {
  return typeof text === 'string' ? text : '';
}

/**
 * `/nep memory show`'s `raw` section: the whole profile as JSON, followed by
 * every stored interest/detail/alias in rank order (divider included, the
 * same lines as their sections) and every episode in stored order — `<@id>`
 * tokens are deliberately left unresolved here, unlike every other section.
 */
function rawMemoryShowView(profile, memoryCfg) {
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
function interestLine(it, resolve) {
  const note = resolve(it.note);
  const suffix = `[weight ${it.weight}${lastDateSuffix(it.lastSeen)}]`;
  return note ? `${it.topic} — ${note} ${suffix}` : `${it.topic} ${suffix}`;
}

/** One detail line of `/nep memory show` and `/nep private show`. */
function detailLine(d, resolve) {
  return `#${d.id} ${resolve(d.text)} [weight ${d.weight}${lastDateSuffix(d.lastSeen)}]`;
}

/** One episode line of `/nep memory show` and `/nep private show`. */
function episodeLine(ep, resolve) {
  const quote = ep.quote ? ` "${ep.quote}"` : '';
  return `${ep.date} [weight ${ep.weight}] ${resolve(ep.what)}${quote}`;
}

/** `[weight N, last DATE] name`, or just `[weight N] name`, used by
 * both the `raw` view (via `rawMemoryShowView`) and the `aliases` section, and by `/nep alias
 * add`/`remove`'s "resulting alias list" reply. */
function aliasLine(alias) {
  return `[weight ${alias.weight}${lastDateSuffix(alias.lastSeen)}] ${alias.name}`;
}

/** The member's stored aliases, rank-ordered, one per line — the reply `/nep alias
 * add`/`remove` gives after writing. */
function formatAliasList(profile, memoryCfg) {
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
function affinityView(affinity, resolve) {
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

function readLocalConfig(localPath) {
  if (!fs.existsSync(localPath)) return {};
  const raw = fs.readFileSync(localPath, 'utf8').trim();
  if (!raw) return {};
  return JSON.parse(raw);
}

function writeLocalConfig(localPath, value) {
  fs.writeFileSync(localPath, `${JSON.stringify(value, null, 2)}\n`);
}

/** The oldest id of a page of messages, by snowflake order (the next page's `before`). */
function oldestMessageId(batch) {
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
// Model roles, `/nep ping` and `/nep route`: pure helpers
// ---------------------------------------------------------------------------

const MODEL_ID_RE = /^[\w.:/-]{3,100}$/;

/** `/nep ping classifier` pings the three classifier roles together. */
const PING_GROUPS = { classifier: MODEL_ROLES.filter((role) => role.startsWith('classifier.')) };

/** Every role a route may name: the `/nep model` roles, then the drawing model's. */
const ROUTE_ROLES = [...MODEL_ROLES, IMAGE_ROLE];

/** A provider slug as OpenRouter writes it: lowercase letters, digits and `-`. */
const PROVIDER_SLUG_RE = /^[a-z0-9-]+$/;

/** The order the model lines of `/nep ping` are printed in (a display rule only: the speaking
 * model first, then the subprocessors); the image line follows them, the API checks come last. */
const PING_DISPLAY_ORDER = ['voice', 'analyzer', 'classifier.text', 'classifier.media', 'classifier.video', 'mentor'];

/** The roles one `/nep ping` argument stands for: one role, a group, the image check, or (anything else)
 * all of them, the image check last. */
function pingRolesFor(role) {
  if (MODEL_ROLES.includes(role)) return [role];
  if (PING_GROUPS[role]) return PING_GROUPS[role];
  if (role === IMAGE_ROLE) return [IMAGE_ROLE];
  return [...MODEL_ROLES, IMAGE_ROLE];
}

/** The model id one role resolves to right now — used by model show and ping alike. */
function modelForRole(role, cfg) {
  // The one model that speaks as the persona: its replies and its memory wording.
  if (role === 'voice') return cfg?.llm?.model || undefined;
  if (role === 'analyzer') return cfg?.memory?.model || cfg?.llm?.model || undefined;
  if (role === 'classifier.text') return classifierTextModel(cfg);
  if (role === 'classifier.media') return classifierMediaModel(cfg);
  if (role === 'classifier.video') return classifierVideoModel(cfg);
  // No fallback to the voice model: an unset mentor model means the mentor is not configured.
  if (role === 'mentor') return cfg?.mentor?.model || undefined;
  return undefined;
}

/** The model one route role uses now: the `/nep model` roles as `modelForRole`, `image` as `image.model`. */
function modelForRouteRole(role, cfg) {
  if (role === IMAGE_ROLE) return cfg?.image?.model || undefined;
  return modelForRole(role, cfg);
}

/** `entry.step`/`.name`/`.stage`, or `'step'` when a routing-funnel entry names itself none of those. */
function funnelStepName(entry) {
  return entry?.step ?? entry?.name ?? entry?.stage ?? 'step';
}

/** `entry.endpoint_count` (OpenRouter's real key, verbatim from a captured 404 body) first, then a
 * few other plausible spellings, so a future rename does not silently go blank. */
function funnelEndpointCount(entry) {
  return entry?.endpoint_count ?? entry?.endpoints ?? entry?.count ?? entry?.remaining ?? entry?.endpointCount;
}

function describeFunnelStep(entry) {
  const count = funnelEndpointCount(entry);
  return count == null ? funnelStepName(entry) : `${funnelStepName(entry)} -> ${count} endpoints`;
}

/**
 * The last `routing_funnel` step out of an OpenRouter error body, when present -- the diagnostic
 * that actually tells "wrong provider keys" apart from a genuine outage. A real captured 404 body
 * carries it at `error.metadata.routing_funnel` (checked first); a
 * couple of other plausible locations are tried too, and it never throws on a body that is not
 * JSON or carries no such field. When the step that first hit 0 endpoints is not the last step
 * (the funnel kept going after already emptying out), both are shown -- the first zero is usually
 * the actually useful one to fix, the last is what the request ultimately failed at.
 */
function extractRoutingFunnel(rawBody) {
  if (!rawBody) return null;
  let parsed;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return null;
  }
  const funnel = parsed?.error?.metadata?.routing_funnel ?? parsed?.routing_funnel ?? parsed?.error?.routing_funnel;
  if (!Array.isArray(funnel) || funnel.length === 0) return null;
  const last = funnel[funnel.length - 1];
  if (!last || typeof last !== 'object') return null;

  const firstZero = funnel.find((entry) => funnelEndpointCount(entry) === 0);
  const lastLine = `funnel: ${describeFunnelStep(last)}`;
  if (firstZero && firstZero !== last) {
    return `${lastLine} (first hit 0 at ${describeFunnelStep(firstZero)})`;
  }
  return lastLine;
}

/** One role's line on a successful ping. */
function formatPingSuccess(role, model, result, ms) {
  const parts = [`${role}: ${model} — ok, ${ms}ms`];
  if (result.provider) parts.push(`provider=${result.provider}`);
  const usage = result.usage ?? {};
  if (usage.prompt_tokens != null || usage.completion_tokens != null) {
    parts.push(`tokens ${usage.prompt_tokens ?? '?'}/${usage.completion_tokens ?? '?'}`);
  }
  return parts.join(', ');
}

/** One role's line on a failed ping: the HTTP status is already folded into `err.message` by
 * src/llm/openrouter.js, so this only trims it and appends the routing-funnel diagnostic, if any. */
function formatPingFailure(role, model, err, ms) {
  const message = String(err?.message ?? err ?? 'error').slice(0, 200);
  const parts = [`${role}: ${model} — FAIL, ${ms}ms, ${message}`];
  const funnel = extractRoutingFunnel(err?.body);
  if (funnel) parts.push(funnel);
  return parts.join(' | ');
}

/** The YouTube line of `/nep ping video`: the state of the Data API key given which duration
 * source works here (src/memory/youtube-check.js). No duration, no detail. */
function formatYoutubeLine(result) {
  const status = result?.status;
  const keySet = Boolean(result?.keySet);
  let state;
  if (status === 'api') state = 'ok';
  else if (status === 'ytdlp') state = 'not needed (yt-dlp ok)';
  else if (status === 'page') state = keySet ? 'failed (page only, unreliable)' : 'missing (page only, unreliable)';
  else state = keySet ? 'failed (blocked)' : 'missing (blocked)';
  return `youtube: API key — ${state}`;
}

/** `lines` with the YouTube line appended: an API check, so it follows every model line. */
function withYoutubeLine(lines, youtubeLine) {
  if (youtubeLine == null) return lines;
  return [...lines, youtubeLine];
}

/** `lines` with the image line appended, after the other model lines and before the API checks. */
function withImageLine(lines, imageLine) {
  if (imageLine == null) return lines;
  return [...lines, imageLine];
}

/** The providers part of a routing object: its `only`/`order`/`ignore` lists, or the object as
 * JSON (without `allow_fallbacks`, shown on its own) when it holds anything else. */
function describeProviders(value) {
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
function fallbacksText(value) {
  return onOff(value.allow_fallbacks !== false);
}

/** `(<providers>, fallbacks: on|off)` for the by-role lines. */
function routingSummary(value) {
  return `(${describeProviders(value)}, fallbacks: ${fallbacksText(value)})`;
}

/** The prefix of a `/nep route` command: trimmed, required, no `@` (the role has its own
 * option), no whitespace, never an object-prototype key. */
function routePrefixArg(args) {
  const prefix = String(args?.model ?? '').trim();
  if (!prefix) throw new Error('a model id or prefix is required');
  if (prefix.includes('@')) throw new Error('the model prefix cannot contain @ (give the role in the role option)');
  if (/\s/.test(prefix)) throw new Error('the model prefix cannot contain spaces');
  if (prefix.length > 100) throw new Error('the model prefix is too long (100 chars max)');
  if (FORBIDDEN_SEGMENTS.has(prefix)) throw new Error(`forbidden model prefix: ${prefix}`);
  return prefix;
}

/** The role of a `/nep route` command, or null for any role. */
function routeRoleArg(args) {
  const role = args?.role;
  if (role === undefined || role === null || role === '') return null;
  if (!ROUTE_ROLES.includes(String(role))) throw new Error(`unknown role: ${role} (${ROUTE_ROLES.join(', ')})`);
  return String(role);
}

// ---------------------------------------------------------------------------
// Warmup, mentor, access and the media commands: pure helpers
// ---------------------------------------------------------------------------

/** `N s ago` / `N min ago` / `N h ago` before `now`, or `never` when `lastActivityAt` is unknown. */
function humanizeAgo(lastActivityAt, now) {
  if (!Number.isFinite(lastActivityAt)) return 'never';
  const deltaMs = Math.max(0, now - lastActivityAt);
  const seconds = Math.round(deltaMs / 1000);
  if (seconds < 60) return `${seconds} s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  return `${Math.round(minutes / 60)} h ago`;
}

/** One `phase: …` line's TEXT from a warmup status's in-memory `activity` snapshot (see
 * src/memory/warmup.js's `touchActivity`) -- falls back to `s.phase` (the coarser "running" /
 * "not started" / "finished" / "aborted (reason)" / "idle" summary) whenever `activity` carries
 * nothing more specific yet (e.g. right after a restart, before the first channel is fetched).
 * Never throws on a missing/partial snapshot. */
function formatWarmupPhase(s) {
  const a = s?.activity;
  const d = a?.detail ?? {};
  switch (a?.phase) {
    case 'fetching':
      return `fetching history, ${d.channelsFetched ?? 0}/${d.channelsTotal ?? 0} channels`;
    case 'channel': {
      const label = d.name ? `#${d.name}` : d.id ? `id:${d.id}` : 'a channel';
      const count = d.total ? ` (${d.index ?? '?'} of ${d.total})` : '';
      return `describing channel ${label}${count}`;
    }
    case 'person': {
      const who = `${d.name ?? '?'} (id:${d.id ?? '?'})`;
      const count = d.total ? ` (${d.index ?? '?'} of ${d.total})` : '';
      const chunk = d.chunk ? `, chunk ${d.chunk.k}/${d.chunk.n}` : '';
      return `profiling ${who}${count}${chunk}`;
    }
    case 'server':
      return 'building the server notes';
    case 'waiting-rate-limit': {
      const until = Number.isFinite(d.until) ? `${new Date(d.until).toISOString().slice(11, 16)} UTC` : '?';
      return `waiting for the provider rate limit until ${until} (wait ${d.waits ?? 1})`;
    }
    case 'paused':
      return 'paused';
    case 'stopped':
      return 'stopped';
    case 'finished':
      return 'finished';
    case 'aborted':
      return `aborted (${d.reason ?? s?.aborted ?? 'unknown'})`;
    default:
      return s?.phase ?? 'idle';
  }
}

/** A refused warmup or portrait outcome as the owner reads it: its message, else its reason code. */
function outcomeText(outcome, fallback) {
  return outcome?.message ?? outcome?.reason ?? fallback;
}

const MENTOR_CASE_TEXT_SHOWN = 80;
const MENTOR_STATES = ['new', 'passing', 'failing', 'retired'];

/** Why `/nep emoji rescan` did not run, by src/memory/emoji-backfill.js's skip reason (the
 * reasons every background job shares -- paused, no guild -- are worded by `skipText`). */
const EMOJI_RESCAN_SKIPS = {
  running: 'An emoji backfill is already running.',
  disabled: 'The emoji backfill is off (context.customEmoji.backfillMessages is 0).',
};

/** Why `/nep gifs rescan` did not run, by src/memory/gif-backfill.js's skip reason. */
const GIFS_RESCAN_SKIPS = {
  running: 'A GIF backfill is already running.',
  disabled: 'The GIF backfill is off (gifs.backfillMessages is 0).',
};

/** Why `/nep gifs recache` did not start, by src/memory/gif-recache.js's skip reason. */
const GIFS_RECACHE_SKIPS = {
  unavailable: 'the GIF recache is not available',
  off: 'GIFs are not watched (features.mediaDescriptions or media.gif.watch is off).',
  'video-off': 'GIFs are not watched while video vision is off (features.videoDescriptions).',
  'no-prompt': 'GIFs are not watched: the describe-video prompt is missing.',
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * `hot`, `store` — see src/hot.js, src/memory/store.js.
 * `client` — a discord.js Client (used for channels.fetch, guilds.cache, and users.fetch +
 *   createDM for `/nep private purge`).
 * `spontaneous` — the spontaneous scheduler: `force(channel, mode)` and `status()`.
 * `calibrator` — token calibrator (src/llm/tokens.js), read for `.ratio`.
 * `getGuildId` — the single guild this instance serves, or null before it resolves.
 * `isWarmingUp` — `() => boolean`, optional: true while the memory warmup runner
 *   (src/memory/warmup.js) is in flight. Read by `cmdMemoryWipe`, `cmdMemoryRefresh`,
 *   `/nep warmup run` and `cmdStatus`. Default: never warming up.
 * `turns` — from createTurnRunner() (src/behavior/turn.js), optional: `waitIdle()`, used by
 *   `/nep pause` to wait out a turn already in flight. Absent -> the wait is simply skipped.
 * `memory` — from createMemoryUpdater() (src/memory/update.js), optional: `waitIdle()`, used by
 *   `/nep pause` to wait out a live-analyzer `run()` or a voice run (`runVoice`, the two-stage
 *   analyzer's stage B) already in flight (an LLM call can take 30-90s; a voice answer that
 *   arrives once paused writes nothing) before the pause flushes and drops the store's caches, and by `/nep memory forget`,
 *   `/nep private forget` and `/nep memory wipe` before they delete (the run would re-create what
 *   they removed). Absent -> the wait is skipped.
 * `pending` — `{ clear() }`, optional: clears src/discord/events.js's pending-ping queue on pause.
 *   Absent -> nothing to clear.
 * `llm` — from createLlm() (src/llm/openrouter.js), optional: `complete()`, used by `/nep ping`
 *   to reach each role's model directly, and `modelEndpoints()`, its free check of the drawing
 *   model. Absent -> `/nep ping` reports it is not available.
 * `warmup` — from createWarmup() (src/memory/warmup.js), optional: the sample-based
 *   memory warmup -- `peopleReport` (read-only), `run`/`runPerson`/`runChannel`/`runServer`/
 *   `runUsers`/`runChannels`/`status`/`reset` (write under data/), `refreshPortrait`, `waitIdle`
 *   (awaited by `/nep pause`, same shape as `memory`/`turns`; it also covers portrait refreshes
 *   in flight). Absent -> every `warmup.*`/
 *   `memory.refresh` command reports it is not available.
 * `describer` — from createDescriber() (src/memory/describe.js), optional: `checkYoutube()`, used by
 *   `/nep ping` (video role) to add a line saying which YouTube duration source works on this host.
 *   Absent -> no such line.
 * `lookup` — from createLookup() (src/web/lookup.js), optional: `hasSearch()`, used by `/nep ping`
 *   (classifier.text role) to add a line saying whether the web lookup is on and has a search key.
 *   Absent -> no such line.
 * `images` — from createImageGen() (src/llm/images.js), optional: `generate()` for `/nep draw`,
 *   `quota()` and `familyOf()` for the image lines of `/nep status` and `/nep model show`.
 *   Absent -> `/nep draw` reports it is not available and `/nep status` has no image lines.
 * `imageFetcher` — from createImageFetcher() (src/discord/fetch-image.js), optional: downloads the
 *   bot's avatar as the reference of a `/nep draw self` picture. Absent -> no reference is sent.
 * `emojiBackfill` — from createEmojiBackfill() (src/memory/emoji-backfill.js), optional: `run` (with
 *   `force`, awaited by `/nep emoji rescan`) and `isRunning` (a note in `/nep emoji status`).
 *   Absent -> `/nep emoji rescan` reports it is not available; `/nep emoji status` still works.
 * `gifBackfill` — from createGifBackfill() (src/memory/gif-backfill.js), optional: `run` (with
 *   `force`, awaited by `/nep gifs rescan`) and `isRunning` (a note in `/nep gifs status`).
 *   Absent -> `/nep gifs rescan` reports it is not available; `/nep gifs status` still works.
 * `gifRecache` — from createGifRecache() (src/memory/gif-recache.js), optional: `start` (started by
 *   `/nep gifs recache`, never awaited to the end), `isRunning` (a note in `/nep gifs status`) and
 *   `waitIdle` (`/nep pause` waits for a run in flight). Absent -> `/nep gifs recache` reports it is
 *   not available.
 * `mentor` — from createMentor() (src/mentor/mentor.js), optional: `run`/`check` (started by
 *   `/nep mentor run|check`, never awaited to the end), `readAnchor` (reads the moment of a
 *   message for `/nep mentor add|anchor`), `stop`, `status`; `isRunning` and
 *   `waitIdle` let `/nep pause` stop a run in flight and wait for it. Absent -> every `mentor.*`
 *   command reports it is not available.
 * `mentorCases` — from createCaseStore() (src/mentor/cases.js), optional: the cases, their runs and
 *   the owner's feedback. Absent -> every `mentor.*` command reports it is not available.
 * `mentorBudget` — from createMentorBudget() (src/mentor/budget.js), optional: `snapshot()` for the
 *   token line of `/nep mentor status`. Absent -> that line shows `-`.
 * `diary` — from createDiary() (src/behavior/diary.js), optional: `force({ kind })` (`/nep diary post`)
 *   and `status()` (`/nep diary show`, the plan in the `set` reply). Absent -> `show` prints the
 *   channel and the history size only, and `post` reports the diary is not running.
 * `archive` — from createArchive() (src/memory/archive.js), optional: `iterate` (`/nep memory
 *   archive`), `find` and `append` (`/nep memory restore`, with the store's `restoreArchived`).
 *   Absent -> both report the archive is not available.
 *
 * `run(commandKey, args, context)` throws a plain `Error` (operator-facing
 * message) on bad input; it never touches discord.js.
 */
export function createAdmin({
  hot,
  store,
  client,
  spontaneous,
  calibrator,
  getGuildId,
  isWarmingUp = () => false,
  turns,
  memory,
  pending,
  llm,
  warmup,
  describer,
  lookup,
  images,
  imageFetcher,
  emojiBackfill,
  gifBackfill,
  gifRecache,
  mentor,
  mentorCases,
  mentorBudget,
  diary,
  archive = null,
}) {
  /** Owner, or `bot.access` granted the command by exact key, group, or `*`, or a member
   * command while `features.memberCommands` is on (read now) — see
   * src/discord/access.js#isAllowed. `roleIds` -- the caller's Discord role ids -- comes from
   * src/discord/commands.js#createInteractionHandler, which reads them off the interaction. */
  function isAllowed(commandKey, { userId, roleIds } = {}) {
    return accessIsAllowed({
      commandKey,
      userId,
      roleIds,
      owners: hot.config?.bot?.owners ?? [],
      access: hot.config?.bot?.access ?? {},
      memberCommands: hot.config?.features?.memberCommands !== false,
    });
  }

  /** `/<command name> <rest>`, the command name read now (`bot.commandName`, default `nep`):
   * every reply that points the owner at another command says it this way. */
  function slash(rest) {
    return `/${hot.config?.bot?.commandName || 'nep'} ${rest}`;
  }

  /** The refusal of a data/ write while paused. */
  function pausedText() {
    return `paused -- run ${slash('resume')} first`;
  }

  /** The one wording of "a warmup is running", for a refused command and a skipped job alike. */
  function warmupBusyText() {
    return `a warmup is running: follow it with ${slash('warmup status')}, end it with ${slash('warmup stop')}`;
  }

  /** A background job's skip reason as the owner reads it: the job's own `skips` first, then the
   * reasons every job shares (paused, a warmup running, no guild), else `fallback`. */
  function skipText(skips, reason, fallback) {
    if (Object.hasOwn(skips, String(reason))) return skips[reason];
    if (reason === 'paused') return pausedText();
    if (reason === 'warmup') return warmupBusyText();
    if (reason === 'no-guild') return NO_GUILD;
    return fallback;
  }

  /**
   * `/nep pause`: refuse a command that would write under `data/` while
   * paused, with a hint to resume first. Guards interject, initiate,
   * alias.add, alias.remove, memory.forget, private.forget, private.purge, memory.wipe, memory.affinity (when
   * setting a score), memory.refresh, lore.add, lore.remove, learned.add,
   * learned.remove, warmup.run, warmup.users, warmup.channels, warmup.server,
   * warmup.reset, emoji.rescan, gifs.rescan, gifs.recache, draw (it counts against the image rail in state.json) and
   * mentor.add, mentor.anchor, mentor.remove, mentor.run, mentor.check and mentor.wrong.
   */
  function assertNotPaused() {
    if (store.state.data.paused) {
      throw new Error(pausedText());
    }
  }

  /**
   * A read-only command must see a hand-edit made while paused, even a
   * second one made between two calls of the same command -- `dropCaches`
   * only drops what a WRITE would otherwise dirty (users/guild/channels/lore
   * /media/buffer), so this is safe to call before every read while paused.
   * A no-op when not paused, so callers can call it unconditionally.
   */
  function freshenIfPaused() {
    if (store.state.data.paused && typeof store.dropCaches === 'function') store.dropCaches();
  }

  /** The served guild: the interaction's, else the one this instance resolved; null before then. */
  function resolvedGuildId(context) {
    return context?.guildId ?? getGuildId?.() ?? null;
  }

  /** The served guild, or an Error before it resolves. */
  function requireGuildId(context) {
    const guildId = resolvedGuildId(context);
    if (!guildId) throw new Error(NO_GUILD);
    return guildId;
  }

  /** `nameOf` (a member's current stored name, or null) and `resolve` (`<@id>` -> `name (id:…)`,
   * an id with no stored name keeping its token) for this guild: the resolution every view of
   * analyzer-written text uses (src/memory/mentions.js#fromTokens, mode `'analyzer'`). */
  function tokenResolver(guildId) {
    const nameOf = (id) => store.getUser(guildId, id)?.names?.[0] ?? null;
    const resolve = (text) => fromTokens(typeof text === 'string' ? text : '', nameOf, 'analyzer');
    return { nameOf, resolve };
  }

  /** Waits out a live-analyzer run already in flight -- its answer lands after its model call and
   * would re-create what a delete just removed -- then refuses if a pause landed meanwhile. */
  async function waitForAnalyzer() {
    await memory?.waitIdle?.();
    assertNotPaused();
  }

  // ---------------------------------------------------------------------
  // rules and config: prompts.local/rules.md and config.local.json
  // ---------------------------------------------------------------------

  function localRulesFile() {
    return path.join(hot.localPromptsDir, 'rules.md');
  }

  function baseRulesFile() {
    return path.join(hot.promptsDir, 'rules.md');
  }

  /** The effective rules text: the local override when it exists, else the base file, else empty. */
  function readRules() {
    const localFile = localRulesFile();
    if (fs.existsSync(localFile)) return fs.readFileSync(localFile, 'utf8');
    const baseFile = baseRulesFile();
    return fs.existsSync(baseFile) ? fs.readFileSync(baseFile, 'utf8') : '';
  }

  /** Write `text` to prompts.local/rules.md, creating the directory when needed, and reload the
   * prompts; the reload's outcome. The tracked base file is never touched. */
  function writeLocalRules(text) {
    const file = localRulesFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    return hot.reloadPrompts();
  }

  function cmdRuleAdd(args) {
    const rule = String(args?.text ?? '').trim();
    if (!rule) throw new Error('rule text is required');
    const ok = writeLocalRules(appendRule(readRules(), rule));
    return `Rule added: ${rule} ${reloadNote(ok)}`;
  }

  function cmdRuleList() {
    const rules = listRules(readRules());
    if (!rules.length) return NONE;
    return rules.map((rule, i) => `${i + 1}. ${rule}`).join('\n');
  }

  function cmdRuleRemove(args) {
    const n = args?.number;
    if (!Number.isInteger(n)) throw new Error('a rule number is required');
    const result = removeRule(readRules(), n);
    if (!result) throw new Error(`no rule #${n}`);
    const ok = writeLocalRules(result.text);
    return `Removed rule #${n}: ${result.removed} ${reloadNote(ok)}`;
  }

  function localConfigFile() {
    return path.join(hot.rootDir, 'config.local.json');
  }

  /** config.local.json passed through `edit` (object in, object out), written back, and the
   * config reloaded; the reload's outcome. Every config writer goes through here. */
  function editLocalConfig(edit) {
    const file = localConfigFile();
    writeLocalConfig(file, edit(readLocalConfig(file)));
    return hot.reloadConfig();
  }

  /** `value` written at `dottedPath` of config.local.json, then reloaded; the reload's outcome. */
  function writeLocalPath(dottedPath, value) {
    return editLocalConfig((local) => setPath(local, dottedPath, value));
  }

  /** The value at `dottedPath` as of the last write: config.local.json's when it holds the path,
   * else the live config's -- so a read right after a write sees it even a moment before the
   * reload lands. */
  function localOrLive(dottedPath) {
    const parts = splitPath(dottedPath);
    const local = ownValueAt(readLocalConfig(localConfigFile()), parts);
    return local.found ? local.value : ownValueAt(hot.config, parts).value;
  }

  /** Refuses a change under `bot.owners` / `bot.access` (see OWNER_ONLY_CONFIG_PATHS) unless the
   * caller is an owner: a member granted `set` must never make themselves one. */
  function assertMayChangeConfig(parts, context) {
    if (touchesOwnerOnlyConfig(parts) && !isOwnerId(hot.config, context?.userId)) {
      throw new Error(`only an owner may change ${parts.join('.')}`);
    }
  }

  /**
   * `/nep set`: one leaf of the live config (a path autocomplete offers, src/discord/commands.js
   * #leafPaths, walked over own keys only) overridden in config.local.json. The value is JSON, or
   * the raw text when it does not parse -- or when the setting is a string, so an id typed bare
   * stays text. Its JSON type must be the current one's (any type when the current is null).
   */
  function cmdSet(args, context) {
    const dottedPath = String(args?.path ?? '').trim();
    const rawValue = String(args?.value ?? '').trim();
    if (!dottedPath) throw new Error('a config path is required');
    const parts = splitPath(dottedPath);
    const key = parts.join('.');
    assertMayChangeConfig(parts, context);

    const current = ownValueAt(hot.config, parts);
    if (!key || !current.found) throw new Error(`unknown config path: ${dottedPath}`);
    if (!leafPaths(hot.config).includes(key)) throw new Error(`${key} is a section, not a value: set one of its keys`);

    let value;
    try {
      value = JSON.parse(rawValue);
    } catch {
      value = rawValue;
    }
    if (typeof current.value === 'string' && typeof value !== 'string') value = rawValue;
    const expected = jsonTypeOf(current.value);
    if (expected !== 'null' && jsonTypeOf(value) !== expected) {
      throw new Error(`${key} expects ${withArticle(expected)}, got ${withArticle(jsonTypeOf(value))}`);
    }

    const ok = writeLocalPath(key, value);
    return `Set ${key} = ${JSON.stringify(value)} ${reloadNote(ok)}`;
  }

  function cmdUnset(args, context) {
    const dottedPath = String(args?.path ?? '').trim();
    if (!dottedPath) throw new Error('a config path is required');
    const parts = splitPath(dottedPath);
    const key = parts.join('.');
    if (!key) throw new Error('a config path is required');
    assertMayChangeConfig(parts, context);
    const ok = editLocalConfig((local) => unsetPath(local, key));
    return `Unset ${key} ${reloadNote(ok)}`;
  }

  function cmdReload() {
    const configOk = hot.reloadConfig();
    const promptsOk = hot.reloadPrompts();
    return `config reload: ${configOk ? 'ok' : 'FAILED'}\nprompts reload: ${promptsOk ? 'ok' : 'FAILED'}`;
  }

  // ---------------------------------------------------------------------
  // pause / resume: a maintenance mode so the owner can edit files
  // under data/ by hand while the process stays up. See src/memory/store.js
  // (dropCaches/reloadState/validate) and the module header comments of
  // src/behavior/turn.js (waitIdle), src/behavior/spontaneous.js and
  // src/memory/update.js (both no-op while paused).
  // ---------------------------------------------------------------------

  /**
   * Sets `paused`/`pausedAt` in state.json FIRST (so a crash or restart
   * mid-pause comes back paused), then waits out a turn already running, AND
   * a live-analyzer `run()` or voice run already in flight (its LLM call can take
   * 30-90s; `tick()`/`observe()` are already no-ops from the moment `paused`
   * is set, so no NEW run can start -- this only waits out one that started
   * before the pause), a warmup run or portrait refresh, and a mentor run in flight (stopped
   * first, then waited for until it has saved and reported; the reply says
   * so). Only once all are idle does it clear the pending-ping
   * queue, flush everything and drop every cache except state.json itself, so
   * nothing stale (or a late in-flight write) can land in data/ after the
   * owner starts editing it. Idempotent: a second call just reports the
   * state.
   */
  async function cmdPause() {
    const state = store.state.data;
    if (state.paused) {
      return [
        `Already paused (since ${state.pausedAt ?? '?'}).`,
        `Files under data/ can be edited freely. Run ${slash('resume')} when done.`,
      ].join('\n');
    }

    state.paused = true;
    state.pausedAt = new Date().toISOString();
    store.state.markDirty();
    store.flush();

    if (turns && typeof turns.waitIdle === 'function') {
      await turns.waitIdle();
    }

    // The live analyzer's own in-flight run (if any) must land on disk
    // BEFORE the flush + dropCaches below -- see the header comment above.
    // Its waitIdle also covers a voice run in flight, which writes nothing
    // once it sees `paused`.
    if (memory && typeof memory.waitIdle === 'function') {
      await memory.waitIdle();
    }

    // A warmup run/one-off target or a portrait refresh already in flight:
    // same rule. The run's loop stops after the request in flight once
    // `paused` is seen; a refresh whose answer arrives now writes nothing.
    if (warmup && typeof warmup.waitIdle === 'function') {
      await warmup.waitIdle();
    }

    // A GIF recache in flight writes the media cache: it stops before its
    // next GIF once `paused` is seen; wait for the one in flight.
    if (gifRecache && typeof gifRecache.waitIdle === 'function') {
      await gifRecache.waitIdle();
    }

    // A mentor run in flight saves its run and charges state.json: stop it
    // (the request in flight is aborted) and wait until it has saved and
    // reported. `/nep mentor run|check` are refused from here on.
    let mentorStopped = false;
    if (mentor && typeof mentor.isRunning === 'function' && mentor.isRunning()) {
      mentor.stop();
      mentorStopped = true;
      if (typeof mentor.waitIdle === 'function') await mentor.waitIdle();
    }

    if (pending && typeof pending.clear === 'function') {
      pending.clear();
    }

    store.flush();
    const dropped = typeof store.dropCaches === 'function' ? store.dropCaches() : 0;

    log.info('admin: paused', { dropped, mentorStopped });

    return [
      'Paused. Memory is flushed to disk -- files under data/ can be edited safely now.',
      ...(mentorStopped ? ['A mentor run in flight was stopped.'] : []),
      `Run ${slash('resume')} when done.`,
    ].join('\n');
  }

  /**
   * Reports "Not paused." when called while not paused, before anything else
   * (idempotent). Otherwise refuses (staying paused) if any `*.json` under
   * data/ fails to parse, naming the offending paths; else re-reads
   * state.json (the owner may have hand-edited data/ while paused) and clears
   * the pause flags, letting every other cache lazily re-populate from disk.
   */
  function cmdResume() {
    if (!store.state.data.paused) return 'Not paused.';

    const badFiles = typeof store.validate === 'function' ? store.validate() : [];
    if (badFiles.length > 0) {
      return [
        'Still paused: found invalid JSON under data/, fix or restore these files and try again:',
        ...badFiles.map((file) => `  ${file}`),
      ].join('\n');
    }

    if (typeof store.reloadState === 'function') store.reloadState();
    const state = store.state.data;
    if (!state.paused) {
      return 'Not paused.';
    }

    delete state.paused;
    delete state.pausedAt;
    store.state.markDirty();
    store.flush();

    log.info('admin: resumed', {});

    return 'Resumed.';
  }

  /** The next spontaneous turn of `guildId` as an ISO time: src/behavior/spontaneous.js#status
   * keeps `{ [guildId]: epochMs }`. Null when there is none (or no scheduler). */
  function nextSpontaneousFor(guildId) {
    const ms = spontaneous?.status?.()?.[guildId];
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
  }

  function cmdStatus() {
    freshenIfPaused(); // read the freshest data/ even mid-pause
    const cfg = hot.config;
    const data = store.state.data ?? {};
    const dryRunOn = cfg?.features?.dryRun === true;
    const dryRunChannelId = cfg?.bot?.dryRunChannelId || '';
    const dryRunTarget = dryRunOn ? ` → log${dryRunChannelId ? ` + #${dryRunChannelId}` : ''}` : '';
    const lines = [
      `dry-run: ${onOff(dryRunOn)}${dryRunTarget}`,
      `model: ${cfg?.llm?.model ?? '-'}`,
      `calibration ratio: ${calibrator ? calibrator.ratio.toFixed(3) : '-'}`,
      `llm requests today: ${llmCountToday(data, Date.now())} / ${cfg?.llm?.maxRequestsPerDay ?? '-'} (day: ${todayUtc()})`,
      `paused: ${onOff(data.paused)}${data.paused ? ` (since ${data.pausedAt ?? '?'})` : ''}`,
      `warming up: ${onOff(isWarmingUp())}`,
    ];

    if (images) {
      const quota = images.quota({ userId: null });
      lines.push(`images today: ${quota.used}/${quota.cap ?? '-'}`, `image model: ${imageModelLabel(cfg)}`);
    }

    // GIF watches have their own daily cap (media.gif.maxPerDay), apart from the video one.
    const gifWatches = gifWatchesToday(data, cfg, todayUtc());
    lines.push(`gif watches today: ${gifWatches.used}/${gifWatches.cap}`);

    // Portraits share one daily cap (memory.portraitRefreshPerDay) between the analyzer and the owner.
    const portraitsToday = countToday(data, PORTRAIT_SLOTS, todayUtc());
    lines.push(`portraits refreshed today: ${portraitsToday}/${portraitSettings(cfg).perDay}`);

    if (warmup && typeof warmup.summary === 'function') {
      const summary = warmup.summary();
      lines.push(
        `warmup: channels=${summary.doneChannels} people=${summary.donePeople} server=${summary.doneServer ? 'done' : 'pending'} ` +
          `tokens=${summary.tokensUsed} requests=${summary.requests} aborted=${summary.aborted ?? 'no'}`,
      );
    }

    const guildId = getGuildId?.() ?? null;
    if (guildId) {
      const guildName = client?.guilds?.cache?.get(guildId)?.name;
      const label = guildName ? `${guildName} (${guildId})` : guildId;
      const profiles = store.countUsers(guildId);
      const buffer = store.getBuffer(guildId);
      const next = nextSpontaneousFor(guildId);
      lines.push(`guild: ${label} profiles=${profiles} buffer=${buffer.length} nextSpontaneous=${next ?? '-'}`);
      // The pause after a topic the persona started (spontaneous.initiateCooldownHours), only while it holds.
      const initiateUntil = initiateCooldownUntil(data, guildId, Date.now(), cfg?.spontaneous);
      if (initiateUntil !== null) lines.push(`initiate cooldown until ${new Date(initiateUntil).toISOString()}`);
      // The voice lines exist only while the two-stage analyzer is on (features.memoryTwoStage).
      if (cfg?.features?.memoryTwoStage === true) {
        const voiceCap = cfg?.memory?.voice?.maxPerDay;
        lines.push(
          `voice queue: ${store.getVoiceQueue(guildId).length}`,
          `voice requests today: ${countToday(data, VOICE_DAILY, todayUtc())}/${Number.isFinite(voiceCap) ? voiceCap : 100}`,
        );
      }
    } else {
      lines.push('guild: not resolved yet');
    }

    const privateChat = onOff(cfg?.features?.privateMessages === true);
    lines.push(guildId ? `private chat: ${privateChat} · ${store.listPrivate(guildId).length} private files` : `private chat: ${privateChat}`);

    const prompts = hot.prompts ?? {};
    const sources = hot.promptSources ?? {};
    for (const name of Object.keys(prompts)) {
      if (name === 'labels') {
        lines.push(`prompt labels: locale=${prompts.labels?.locale ?? '-'} source=${sources.labels ?? '-'}`);
        continue;
      }
      lines.push(`prompt ${name}: ${prompts[name].length} chars source=${sources[name] ?? '-'}`);
    }

    return lines.join('\n');
  }

  /**
   * Shared handler for `/nep interject` and `/nep initiate`: force a
   * spontaneous turn right now, in `context.channelId` unless a channel
   * argument overrides it, bypassing the schedule.
   */
  async function cmdForce(mode, args, context) {
    assertNotPaused();
    const channelId = args?.channelId || context?.channelId;
    if (!channelId) throw new Error('a channel is required');

    const channel = await client.channels.fetch(channelId);
    if (!channel) throw new Error(`no channel ${channelId}`);

    const result = await spontaneous.force(channel, mode);
    return `${mode} on ${channel.id}: ${JSON.stringify(result) ?? 'ok'}`;
  }

  /**
   * `/nep draw`: one picture through the same prompt a turn builds (prompts
   * read now, the request clamped to `image.maxPromptChars`, the avatar as
   * reference for `self` when `image.reference` is `'avatar'`), counted
   * against `image.maxPerDay` only (no member). Answers `{ text, files }`:
   * one line with the model, seconds and cost, plus the picture. A rail or
   * generation failure throws with its reason and HTTP status; the prompt is
   * never logged.
   */
  async function cmdDraw(args, context) {
    if (!images) return 'image generation is not available';
    assertNotPaused();
    const request = String(args?.text ?? '').trim();
    if (!request) throw new Error('text is required');

    const imageCfg = hot.config.image ?? {};
    if (!images.familyOf(imageCfg.model)) {
      return `unsupported image model: ${imageCfg.model ?? '-'} (no supported family); nothing was generated`;
    }

    const self = args?.self === true;
    const guildId = resolvedGuildId(context);
    const selfName = client?.guilds?.cache?.get(guildId)?.members?.me?.displayName ?? client?.user?.username ?? '';
    const clamped = clampAtBoundary(request, imageCfg.maxPromptChars);
    const prompt = buildDrawPrompt({ prompts: hot.prompts, selfName, request: clamped, self });

    let reference = null;
    let referenceMissing = false;
    if (self && imageCfg.reference === 'avatar') {
      reference = await avatarReference({ client, imageFetcher, config: hot.config });
      referenceMissing = reference === null;
      if (referenceMissing) log.warn('admin: draw avatar reference unavailable', {});
    }

    let picture;
    try {
      picture = await images.generate({ prompt, reference, userId: null });
    } catch (err) {
      if (err instanceof ImageCapError || err instanceof ImageGenError) {
        const status = err.statusCode ? `, HTTP ${err.statusCode}` : '';
        throw new Error(`draw failed (${err.reason}${status}): ${err.message}`);
      }
      if (err instanceof UnsupportedImageModelError) throw new Error(`draw failed: ${err.message}`);
      throw err;
    }

    log.info('admin: drew', { model: picture.model, seconds: picture.seconds, cost: picture.cost, self, bytes: picture.buffer?.length ?? 0 });

    const cost = picture.cost == null ? 'cost unknown' : `cost ${picture.cost}`;
    const parts = [picture.model, `${picture.seconds}s`, cost];
    if (referenceMissing) parts.push('no avatar reference');
    return {
      text: parts.join(' · '),
      files: [{ attachment: picture.buffer, name: imageFileName(picture.mediaType) }],
    };
  }

  // ---------------------------------------------------------------------
  // memory: one member's profile, the channel map and the server notes
  // ---------------------------------------------------------------------

  /** The stored profile of `userId`, or an Error `no profile for <id>`: a write command never
   * creates a profile for a member the persona has not met. */
  function requireProfile(guildId, userId) {
    const profile = store.getUser(guildId, userId);
    if (!profile) throw new Error(`no profile for ${userId}`);
    return profile;
  }

  /**
   * Sectioned, human-readable view of one member's profile — see
   * src/discord/commands.js#MEMORY_SHOW_SECTIONS for the choices and the header
   * comments of `buildProfileSummary`/`orderedSectionLines`/
   * `rawMemoryShowView` for what each section does. `section` defaults to
   * `'summary'`; `order` to `'rank'`; `limit` to 25 (1..100) — anything else
   * given falls back to these defaults rather than throwing, since this is a
   * read-only command. Every section except `'raw'` resolves `<@id>` tokens
   * in free text via `fromTokens(..., 'analyzer')`, the same as the analyzer's
   * own input view.
   */
  function cmdMemoryShow(args, context) {
    freshenIfPaused();
    const userId = args?.userId;
    if (!userId) throw new Error('a user is required');

    const guildId = requireGuildId(context);
    const profile = requireProfile(guildId, userId);

    const memoryCfg = hot.config?.memory ?? {};
    const section = MEMORY_SHOW_SECTIONS.includes(args?.section) ? args.section : 'summary';
    const order = args?.order === 'recent' ? 'recent' : 'rank';
    const limit =
      Number.isInteger(args?.limit) && args.limit >= 1 && args.limit <= MEMORY_SHOW_MAX_LIMIT
        ? args.limit
        : MEMORY_SHOW_DEFAULT_LIMIT;
    const { nameOf, resolve } = tokenResolver(guildId);

    if (section === 'raw') return rawMemoryShowView(profile, memoryCfg);

    if (section === 'character') return resolve(profile.character) || '(empty)';
    if (section === 'style') return resolve(profile.style) || '(empty)';
    if (section === 'relationship') return resolve(profile.relationship) || '(empty)';

    if (section === 'affinity') return affinityView(profile.affinity, resolve);

    if (section === 'aliases') {
      const lines = orderedSectionLines(profile.aliases ?? [], {
        order,
        limit,
        halfLifeDays: memoryCfg.aliasHalfLifeDays,
        maxShown: memoryCfg.maxAliases,
        formatLine: aliasLine,
        dateOf: (a) => dateMs(a.lastSeen ?? a.firstSeen),
      });
      return lines.length ? lines.join('\n') : NONE;
    }

    if (section === 'interests') {
      const lines = orderedSectionLines(profile.interests ?? [], {
        order,
        limit,
        halfLifeDays: memoryCfg.interestHalfLifeDays,
        maxShown: memoryCfg.maxInterests,
        formatLine: (it) => interestLine(it, resolve),
        dateOf: (it) => dateMs(it.lastSeen ?? it.firstSeen),
      });
      return lines.length ? lines.join('\n') : NONE;
    }

    if (section === 'details') {
      const lines = orderedSectionLines(profile.details ?? [], {
        order,
        limit,
        halfLifeDays: memoryCfg.detailHalfLifeDays,
        maxShown: memoryCfg.maxDetails,
        formatLine: (d) => detailLine(d, resolve),
        dateOf: (d) => dateMs(d.lastSeen ?? d.firstSeen),
      });
      return lines.length ? lines.join('\n') : NONE;
    }

    if (section === 'episodes') {
      const episodes = profile.episodes ?? [];
      if (!episodes.length) return NONE;
      const ordered =
        order === 'recent'
          ? [...episodes].sort((a, b) => dateMs(b.addedAt ?? b.date) - dateMs(a.addedAt ?? a.date))
          : sortEpisodesForDisplay(episodes);
      return ordered
        .slice(0, limit)
        .map((ep) => episodeLine(ep, resolve))
        .join('\n');
    }

    return buildProfileSummary(profile, memoryCfg, nameOf);
  }

  // ---------------------------------------------------------------------
  // memory.channel / memory.server: read-only views of the server-wide
  // memory -- the channel map (src/memory/channels.js) and the guild notes
  // (src/memory/store.js#getGuild) -- alongside `memory.show`'s per-member
  // view. Both read fresh data even mid-pause (`freshenIfPaused`, same as
  // `memory.show`) and never write anything.
  // ---------------------------------------------------------------------

  /** `hot.config.memory.mainChannelIds`, normalized to a string Set -- mirrors
   * src/memory/update.js#mainChannelSet and src/memory/warmup.js's own copies. */
  function mainChannelIdSet() {
    return new Set((hot.config?.memory?.mainChannelIds ?? []).map(String));
  }

  /** A channel's stored `topWriters` (`{ id, count }[]`) resolved to current stored names, comma
   * -separated -- an id with no stored profile (e.g. someone who left) is skipped silently, same as
   * src/memory/channels.js#renderChannel's own topWriters line. `''` when there is nothing to show. */
  function channelTopWritersText(topWriters, nameOf) {
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
  function channelTableLine(channel, activity) {
    const note = channel.purpose ? 'yes' : 'no';
    return `${channel.name || channel.id}  activity=${activity}  messages=${channel.messageCount ?? 0}  last=${isoDay(channel.lastMessageAt)}  note=${note}`;
  }

  /**
   * `/nep memory channel [channel]`: with a channel, that channel's full stored note (Discord
   * facts, the analyzer/warmup-written purpose/topics/tone, counters, activity verdict and top
   * writers); without one, a compact table of every stored channel, sorted by last message desc.
   * `<@id>` tokens in `purpose`/`topics`/`tone` are resolved the same way `memory.show` resolves
   * free-text fields (`fromTokens(..., 'analyzer')`).
   */
  function cmdMemoryChannel(args, context) {
    freshenIfPaused();
    const guildId = requireGuildId(context);

    const activityCfg = hot.config?.context?.channelActivity ?? {};
    const now = Date.now();
    const { nameOf, resolve } = tokenResolver(guildId);

    const channelId = args?.channelId;
    if (channelId) {
      const channel = store.getChannel(guildId, channelId);
      if (!channel) throw new Error(`no channel entry for ${channelId}`);

      const activity = channelActivity(channel, now, activityCfg);
      const isMain = mainChannelIdSet().has(String(channelId));
      const writers = channelTopWritersText(channel.topWriters, nameOf);

      return [
        `name: ${channel.name || '-'}`,
        `category: ${channel.category || '-'}`,
        `topic: ${channel.topic || '-'}`,
        `main: ${onOff(isMain)}`,
        `purpose: ${resolve(channel.purpose) || '(empty)'}`,
        `topics: ${resolve(channel.topics) || '(empty)'}`,
        `tone: ${resolve(channel.tone) || '(empty)'}`,
        `messages: ${channel.messageCount ?? 0}`,
        `first message: ${isoDay(channel.firstMessageAt)}`,
        `last message: ${isoDay(channel.lastMessageAt)}`,
        `activity: ${activity}`,
        `top writers: ${writers || NONE}`,
        `updatedAt: ${channel.updatedAt ?? '-'}`,
      ].join('\n');
    }

    const channels = store.listChannels(guildId);
    if (channels.length === 0) return NONE;

    return [...channels]
      .sort((a, b) => (b.lastMessageAt ?? 0) - (a.lastMessageAt ?? 0))
      .map((channel) => channelTableLine(channel, channelActivity(channel, now, activityCfg)))
      .join('\n');
  }

  /** Numbered `1. …` list of `items` (in-jokes/self facts), each resolved via `resolve`; `(none)`
   * when the list is empty. Used by `cmdMemoryServer`. */
  function numberedNotes(items, resolve) {
    const list = Array.isArray(items) ? items : [];
    if (list.length === 0) return NONE;
    return list.map((item, i) => `${i + 1}. ${resolve(item)}`).join('\n');
  }

  /**
   * `/nep memory server`: the stored guild-wide notes (`patterns`, `starters`, numbered
   * in-jokes and self facts -- src/memory/store.js#getGuild) plus counts of what else this guild has
   * stored (profiles, channel notes, lore entries) and when the guild notes were last updated.
   * `<@id>` tokens are resolved the same way `memory.show`/`memory.channel` resolve free text.
   */
  function cmdMemoryServer(_args, context) {
    freshenIfPaused();
    const guildId = requireGuildId(context);

    const guild = store.getGuild(guildId);
    const { resolve } = tokenResolver(guildId);

    return [
      `patterns: ${resolve(guild.patterns) || '(empty)'}`,
      `starters: ${resolve(guild.starters) || '(empty)'}`,
      `in-jokes:\n${numberedNotes(guild.injokes, resolve)}`,
      `self facts:\n${numberedNotes(guild.self, resolve)}`,
      `profiles stored: ${store.countUsers(guildId)}`,
      `channel notes stored: ${store.listChannels(guildId).length}`,
      `lore entries: ${store.getLore(guildId).length}`,
      `updatedAt: ${guild.updatedAt ?? '-'}`,
    ].join('\n');
  }

  /**
   * `/nep memory recent`: the guild's live recent lines (src/memory/recent.js#liveRecent over
   * `memory.recentHours`), newest moment first, one per line: date and time in `bot.timezone`, the
   * source channel (`#name` when a channel note stores one, else its id), the weight and the text
   * with `<@id>` tokens resolved like the other memory views. Expired lines are not shown. Read
   * only, so it works while paused (`freshenIfPaused`); the reply is chunked by
   * src/discord/commands.js#respond like every long view.
   */
  function cmdMemoryRecent(_args, context) {
    freshenIfPaused();
    const guildId = requireGuildId(context);

    const settings = recentSettings(hot.config);
    if (!settings) return 'recent memory is off';

    const live = liveRecent(store.getRecent(guildId).lines, { now: Date.now(), hours: settings.hours });
    if (live.length === 0) return 'no live recent lines';

    const timezone = hot.config?.bot?.timezone || 'UTC';
    const { resolve } = tokenResolver(guildId);
    const channelText = (channelId) => {
      const name = store.getChannel(guildId, channelId)?.name;
      return name ? `#${name}` : String(channelId);
    };
    const lines = [...live]
      .sort((a, b) => b.at - a.at || (Number(b.id) || 0) - (Number(a.id) || 0))
      .map((line) => `${zonedDay(line.at, timezone)} ${formatClock(line.at, timezone)}  ${channelText(line.channelId)}  w${line.weight}  ${resolve(line.text)}`);
    return [`recent lines: ${live.length} live, window ${settings.hours} h`, ...lines].join('\n');
  }

  /** One archive entry's text on one line: its text fields joined (an exchange's messages by their text), tokens resolved. */
  function archivedText(entry, resolve) {
    const parts = [];
    for (const value of Object.values(entry?.text ?? {})) {
      if (typeof value === 'string' && value.trim()) parts.push(value);
      else if (Array.isArray(value)) parts.push(value.map((message) => (typeof message?.text === 'string' ? message.text : '')).filter(Boolean).join(' / '));
    }
    return oneLine(resolve(parts.filter(Boolean).join(' | ')));
  }

  /**
   * `/nep memory archive [user] [kind] [n]`: the newest `n` (1..100, default 20) entries of the
   * guild's archive (src/memory/archive.js), newest first: with a member, those scoped to them;
   * without one, the server-level ones (no member scope). `kind` narrows to one item kind. The
   * private archives are never read here. One line each: the UTC day the item left, the event,
   * the kind, the item id and its text (tokens resolved, cut to 160 characters). Read only; the
   * archive is streamed and only the newest `n` are kept in memory.
   */
  async function cmdMemoryArchive(args, context) {
    const guildId = requireGuildId(context);
    if (!archive) return 'the archive is not available';
    const kind = args?.kind ?? null;
    if (kind !== null && !ARCHIVE_KINDS.includes(kind)) throw new Error(`unknown kind; one of: ${ARCHIVE_KINDS.join(', ')}`);
    const n = Number.isInteger(args?.n) ? Math.min(100, Math.max(1, args.n)) : 20;
    const userId = args?.userId ? String(args.userId) : null;
    const newest = [];
    for await (const entry of archive.iterate(guildId, { scope: userId ? { user: userId } : null, kinds: kind ? [kind] : null })) {
      if (!userId && typeof entry?.scope?.user === 'string') continue;
      newest.push(entry);
      if (newest.length > n) newest.shift();
    }
    if (newest.length === 0) return NONE;
    const { resolve } = tokenResolver(guildId);
    return newest
      .reverse()
      .map((entry) => `${String(entry.recordedAt ?? '').slice(0, 10)}  ${entry.event}  ${entry.itemKind}  ${entry.itemId}  ${clampAtBoundary(archivedText(entry, resolve), 160)}`)
      .join('\n');
  }

  /**
   * `/nep memory restore <itemId>`: the item's newest archived version back into its hot list
   * (store.restoreArchived: under its own id, not pinned), then a `restored` line in the archive
   * (by `owner`). Idempotent: an item already hot changes nothing and writes nothing. Waits for
   * a running analyzer batch first; refused while paused.
   */
  async function cmdMemoryRestore(args, context) {
    assertNotPaused();
    const guildId = requireGuildId(context);
    const itemId = String(args?.itemId ?? '').trim();
    if (!itemId) throw new Error('an item id is required');
    if (!archive || typeof store.restoreArchived !== 'function') throw new Error('the archive is not available');
    await waitForAnalyzer();
    const versions = (await archive.find(guildId, itemId)).filter((entry) => entry.event !== 'restored');
    if (versions.length === 0) throw new Error(`no archived item ${itemId}`);
    const latest = versions.at(-1);
    const result = store.restoreArchived(guildId, latest);
    if (!result.restored) {
      if (result.reason === 'hot') return `${latest.itemKind} ${itemId} is already in memory; nothing changed`;
      if (result.reason === 'no-profile') throw new Error(`no stored memory to restore ${itemId} into`);
      throw new Error(`a ${latest.itemKind} cannot be restored`);
    }
    const item = typeof result.item === 'string' ? { itemId: latest.itemId, text: result.item } : result.item;
    const line = archiveEntry(item, { itemKind: latest.itemKind, event: 'restored', scope: latest.scope, by: 'owner', participants: latest.participants });
    const privateUserId = latest.scope?.private === true ? latest.scope.user : null;
    try {
      await archive.append(guildId, [line], privateUserId ? { privateUserId } : {});
    } catch (error) {
      return `restored ${latest.itemKind} ${itemId}; the archive line failed (${error?.code ?? 'error'})`;
    }
    return `restored ${latest.itemKind} ${itemId}`;
  }

  /**
   * `/nep alias add`: confirms the alias at once instead of
   * waiting for it to be sighted `memory.confirmAfter` times naturally —
   * store.applyProfileOps/src/memory/aliases.js has no option to set a
   * weight directly, so this calls it repeatedly with `confirmGapHours: 0`
   * (every call then counts as a fresh sighting regardless of the gap, see
   * src/memory/interests.js#applyRankedOps's `isFarEnough`) and the SAME
   * `seenAt`/`now` for every call, so the resulting item's `firstSeen` and
   * `lastSeen` both land on that one instant. Idempotent: already at or past
   * the target weight -> no call at all, nothing changes. Clamping to 40
   * chars and dropping a name equal to one of the member's display names are
   * both src/memory/aliases.js#applyAliasOps's own behaviour; the stored form
   * is worked out through that same function. A member with no profile is an error.
   */
  function cmdAliasAdd(args, context) {
    assertNotPaused();
    const userId = args?.userId;
    if (!userId) throw new Error('a user is required');
    const guildId = requireGuildId(context);

    const name = String(args?.name ?? '').trim();
    if (!name) throw new Error('a name is required');

    const before = requireProfile(guildId, userId);
    const memoryCfg = hot.config?.memory ?? {};
    const target = confirmTarget(memoryCfg);

    // The identity the store keeps for `name` (clamped the store's way), to find it once stored.
    const key = normalizeTopic(applyAliasOps([], { add: [name] }, [])[0]?.name ?? name);
    const currentWeight = before.aliases?.find((a) => normalizeTopic(a.name) === key)?.weight ?? 0;
    const needed = Math.max(0, target - currentWeight);

    const now = Date.now();
    for (let i = 0; i < needed; i += 1) {
      store.applyProfileOps(
        guildId,
        userId,
        { aliases: { add: [name] } },
        {
          confirmGapHours: 0,
          seenAt: now,
          now,
          maxAliases: memoryCfg.maxAliases,
          maxAliasesStored: memoryCfg.maxAliasesStored,
          aliasHalfLifeDays: memoryCfg.aliasHalfLifeDays,
        },
      );
    }

    const after = store.getUser(guildId, userId);
    return formatAliasList(after, memoryCfg);
  }

  /** `/nep alias remove`: removes by name, case-insensitively (store.applyProfileOps
   * matches an alias's identity the same way, see src/memory/interests.js#normalizeTopic).
   * A member with no profile is an error. */
  function cmdAliasRemove(args, context) {
    assertNotPaused();
    const userId = args?.userId;
    if (!userId) throw new Error('a user is required');
    const guildId = requireGuildId(context);

    const name = String(args?.name ?? '').trim();
    if (!name) throw new Error('a name is required');

    requireProfile(guildId, userId);
    const memoryCfg = hot.config?.memory ?? {};
    store.applyProfileOps(
      guildId,
      userId,
      { aliases: { remove: [name] } },
      {
        maxAliases: memoryCfg.maxAliases,
        maxAliasesStored: memoryCfg.maxAliasesStored,
        aliasHalfLifeDays: memoryCfg.aliasHalfLifeDays,
      },
    );

    const after = store.getUser(guildId, userId);
    return formatAliasList(after, memoryCfg);
  }

  /** `/nep memory forget`: one member's profile and private layer (store.forgetUser), once a
   * live-analyzer run in flight has landed. Refused while paused. */
  async function cmdMemoryForget(args, context) {
    assertNotPaused();
    const userId = args?.userId;
    if (!userId) throw new Error('a user is required');
    const guildId = requireGuildId(context);

    await waitForAnalyzer();
    store.forgetUser(guildId, userId); // cascades to the member's private layer
    return `Forgot ${userId} (public profile and private memory).`;
  }

  // ---------------------------------------------------------------------
  // private: a member's private layer (what they said in direct messages)
  // ---------------------------------------------------------------------

  /**
   * `/nep private show`: one member's private layer, with the same line
   * formats as `memory show`'s sections, under the public profile's current
   * name (the user id when there is none). Adds the private and the effective
   * attitude (src/behavior/private.js#effectiveAffinity -- what the persona
   * feels in the DM), today's DM reply count against the member's cap (the
   * numbers the gate decides on, src/behavior/private.js#privateRepliesToday) and the
   * buffer SIZE -- never the buffered messages themselves. No "shown cap"
   * divider: in a DM the private items are ranked together with the public
   * ones. No private layer -> a plain answer, not an error.
   */
  function cmdPrivateShow(args, context) {
    freshenIfPaused();
    const userId = args?.userId;
    if (!userId) throw new Error('a user is required');
    const guildId = requireGuildId(context);

    const publicProfile = store.getUser(guildId, userId);
    const name = publicProfile?.names?.[0];
    const label = name ? `${name} (id:${userId})` : String(userId);

    const priv = store.getPrivate(guildId, userId);
    if (!priv) return `No private memory for this member: ${label}.`;

    const memoryCfg = hot.config?.memory ?? {};
    const { resolve } = tokenResolver(guildId);

    const privateAffinity = priv.affinity ?? emptyAffinity();
    const effective = effectiveAffinity(publicProfile?.affinity, privateAffinity);
    const privateReason = resolve(privateAffinity.reason);

    const replies = privateRepliesToday({
      config: hot.config,
      isOwner: isOwnerId(hot.config, userId),
      replies: priv.replies,
      today: todayUtc(),
    });
    const bufferSize = Array.isArray(priv.buffer) ? priv.buffer.length : 0;

    const section = (title, items, lines) => [`${title} (${items.length} stored):`, ...lines.map((line) => `  ${line}`)];
    const interests = priv.interests ?? [];
    const details = priv.details ?? [];
    const episodes = priv.episodes ?? [];

    return [
      `private memory: ${label}`,
      `private affinity: ${roundScore(privateAffinity.score ?? 0)} (${affinityBand(privateAffinity.score ?? 0)})${privateReason ? ` — ${privateReason}` : ''}`,
      `effective affinity: ${roundScore(effective.score)} (${affinityBand(effective.score)})`,
      `replies today: ${replies.used} / ${replies.cap}`,
      `buffer: ${bufferSize} messages`,
      `first seen: ${priv.firstSeen ? priv.firstSeen.slice(0, 10) : '-'} · last seen: ${priv.lastSeen ? priv.lastSeen.slice(0, 10) : '-'}`,
      `relationship: ${resolve(priv.relationship) || '(empty)'}`,
      ...section(
        'interests',
        interests,
        orderedSectionLines(interests, {
          order: 'rank',
          limit: MEMORY_SHOW_DEFAULT_LIMIT,
          halfLifeDays: memoryCfg.interestHalfLifeDays,
          formatLine: (it) => interestLine(it, resolve),
          dateOf: (it) => dateMs(it.lastSeen ?? it.firstSeen),
        }),
      ),
      ...section(
        'details',
        details,
        orderedSectionLines(details, {
          order: 'rank',
          limit: MEMORY_SHOW_DEFAULT_LIMIT,
          halfLifeDays: memoryCfg.detailHalfLifeDays,
          formatLine: (d) => detailLine(d, resolve),
          dateOf: (d) => dateMs(d.lastSeen ?? d.firstSeen),
        }),
      ),
      ...section(
        'episodes',
        episodes,
        sortEpisodesForDisplay(episodes)
          .slice(0, MEMORY_SHOW_DEFAULT_LIMIT)
          .map((ep) => episodeLine(ep, resolve)),
      ),
    ].join('\n');
  }

  /** `/nep private forget`: deletes one member's private layer only (store.forgetPrivate), once a
   * live-analyzer run in flight has landed; the public profile stays. Refused while paused, like
   * `memory forget`. */
  async function cmdPrivateForget(args, context) {
    assertNotPaused();
    const userId = args?.userId;
    if (!userId) throw new Error('a user is required');
    const guildId = requireGuildId(context);

    await waitForAnalyzer();
    store.forgetPrivate(guildId, userId);
    return `Forgot the private memory of ${userId}; the public profile is kept.`;
  }

  /**
   * `/nep private purge`: deletes the bot's own messages in the direct-message chat with one
   * member, then that member's private layer (store.forgetPrivate). Pages back through the DM
   * `PAGE` (100) at a time until a short page or `private.purgeMaxMessages` scanned messages (default
   * 5000), deleting sequentially; a failed delete is counted, never thrown. The member's own
   * messages cannot be deleted by a bot and stay. A user that cannot be fetched or a DM that
   * cannot be opened, or a first history page that cannot be read, throws before anything is
   * deleted; a later page fetch that fails stops the scan and the purge finishes with what it
   * had. Refused while paused; a pause that lands mid-run keeps the private layer.
   */
  async function cmdPrivatePurge(args, context) {
    assertNotPaused();
    const userId = args?.userId;
    if (!userId) throw new Error('a user is required');
    const guildId = requireGuildId(context);

    const selfId = client?.user?.id;
    if (!selfId) throw new Error('the bot is not logged in yet');

    let dm;
    try {
      const user = await client.users.fetch(userId);
      dm = await user.createDM();
    } catch (err) {
      log.warn('admin: private purge could not open the dm', { error: err });
      throw new Error(`cannot open the private chat with ${userId}; nothing was deleted`);
    }

    const configured = hot.config?.private?.purgeMaxMessages;
    const maxScanned = Number.isFinite(configured) && configured > 0 ? Math.floor(configured) : 5000;

    let scanned = 0;
    let deleted = 0;
    let failed = 0;
    let before;
    while (scanned < maxScanned) {
      let page;
      try {
        page = await dm.messages.fetch(before ? { limit: PAGE, before } : { limit: PAGE });
      } catch (err) {
        log.warn('admin: private purge page fetch failed', { scanned, error: err });
        if (!before) throw new Error(`cannot read the private chat with ${userId}; nothing was deleted`);
        break;
      }
      const batch = [...page.values()];
      if (batch.length === 0) break;

      for (const message of batch) {
        if (scanned >= maxScanned) break;
        scanned += 1;
        if (message.author?.id !== selfId) continue;
        try {
          await message.delete();
          deleted += 1;
        } catch {
          failed += 1;
        }
      }

      before = oldestMessageId(batch);
      if (batch.length < PAGE) break;
    }

    // A `/nep pause` that landed during a long purge: data/ must not be written any more.
    const pausedMidway = Boolean(store.state.data.paused);
    if (!pausedMidway) store.forgetPrivate(guildId, userId);
    log.info('admin: private purged', { deleted, failed, scanned });
    const capped = scanned >= maxScanned ? `; stopped at the ${maxScanned}-message scan cap, run again for older ones` : '';
    const memoryPart = pausedMidway ? `private memory kept (paused meanwhile, run again after ${slash('resume')})` : 'private memory removed';
    return [
      `Purged ${deleted} own messages in the private chat (${failed} failed, ${scanned} scanned${capped}); ${memoryPart}.`,
      "The member's own messages stay; only they can delete those.",
    ].join('\n');
  }

  /**
   * A deliberate, owner-only clean start: wipes this guild's whole stored
   * memory (store.wipeGuild) once a live-analyzer run in flight has landed.
   * Runs only when `confirm` matches the served guild's name exactly
   * (trimmed, case-sensitive) — otherwise nothing changes and the reply says
   * what it deletes and what to type.
   */
  async function cmdMemoryWipe(args, context) {
    assertNotPaused();
    const guildId = requireGuildId(context);
    if (isWarmingUp()) throw new Error(warmupBusyText());

    const guildName = client?.guilds?.cache?.get(guildId)?.name || guildId;
    const confirm = String(args?.confirm ?? '').trim();
    if (confirm !== guildName) {
      return (
        'This deletes everything remembered about this server: every member profile and private memory, the server habits, ' +
        'the learned list, the emoji ranking, the voice queue, the recent lines, the channel map, analyzer lore and the warmup progress. ' +
        `To confirm, run again with confirm: ${guildName}`
      );
    }

    await waitForAnalyzer();
    if (isWarmingUp()) throw new Error(warmupBusyText());
    const counts = store.wipeGuild(guildId);
    log.info('admin: memory wiped', counts);

    return [
      `Memory wiped for ${guildName}.`,
      `users removed: ${counts.users} (with their private memory)`,
      `channels removed: ${counts.channels}`,
      `lore removed: ${counts.loreRemoved} (kept: ${counts.loreKept})`,
      `buffer messages cleared: ${counts.bufferMessages}`,
      'Also removed: the server habits, the learned list, the emoji ranking, the voice queue, the recent lines and the warmup progress.',
      'Kept: owner lore, the GIF library, the media description cache, token calibration, the daily request counts and the spontaneous schedule.',
    ].join('\n');
  }

  /** `/nep memory affinity`: without a score, the attitude view (`affinityView`); with one, sets
   * it exactly for a member who has a profile (refused while paused). The owner's `reason` is
   * stored as given; none given stores `labels.affinity.ownerSet` (read at the moment of use), or an
   * empty one when that label is missing (src/memory/affinity.js#applyDelta then keeps the previous
   * reason). */
  function cmdMemoryAffinity(args, context) {
    const userId = args?.userId;
    if (!userId) throw new Error('a user is required');
    const guildId = requireGuildId(context);

    const score = args?.score;
    if (score === undefined || score === null) {
      freshenIfPaused();
      const profile = requireProfile(guildId, userId);
      return affinityView(profile.affinity, tokenResolver(guildId).resolve);
    }

    assertNotPaused();
    if (!Number.isInteger(score) || score < -100 || score > 100) {
      throw new Error('score must be an integer between -100 and 100');
    }

    const profile = requireProfile(guildId, userId);
    // No reason given: the stored reason says the owner set it (`labels.affinity.ownerSet`, read now).
    const reason = String(args?.reason ?? '').trim() || (hot.prompts.labels?.affinity?.ownerSet ?? '');
    const current = profile.affinity?.score ?? 0;
    const relCfg = hot.config?.relationships ?? {};
    const affinity = store.adjustAffinity(guildId, userId, score - current, reason, {
      maxDelta: Infinity, // the owner's explicit override bypasses maxDeltaPerUpdate
      historySize: relCfg.historySize ?? 10,
      now: Date.now(),
      damping: false, // an absolute set is never damped
      truncate: false, // `current` may carry two decimals (a damped score); land on `score` exactly
    });
    return `Set affinity for ${userId} to ${roundScore(affinity.score)} (${affinityBand(affinity.score)}).`;
  }

  // ---------------------------------------------------------------------
  // lore: the owner's side of the server lorebook (src/memory/lore.js)
  // ---------------------------------------------------------------------

  function loreLine(entry) {
    return `${entry.id}  ${entry.title}  keys=${entry.keys.join(', ')}  source=${entry.source}${entry.always ? ' always' : ''}`;
  }

  function cmdLoreAdd(args, context) {
    assertNotPaused();
    const guildId = requireGuildId(context);

    const title = String(args?.title ?? '').trim();
    if (!title) throw new Error('a title is required');
    const keys = String(args?.keys ?? '')
      .split(',')
      .map((k) => k.trim())
      .filter(Boolean);
    const text = String(args?.text ?? '').trim();
    if (!text) throw new Error('text is required');

    const maxEntries = hot.config?.lore?.maxEntries ?? Infinity;
    const upserted = store.setLore(guildId, [{ title, keys, text, always: Boolean(args?.always) }], {
      source: 'owner',
      by: 'owner',
      now: Date.now(),
      maxEntries,
      textChars: hot.config?.lore?.textChars,
      clampTolerance: hot.config?.memory?.clampTolerance,
    });
    if (upserted === 0) {
      throw new Error('invalid lore entry: needs a title, at least one key of 2+ characters, and non-empty text');
    }
    return `Lore entry saved: ${title}`;
  }

  function cmdLoreList(args, context) {
    freshenIfPaused();
    const guildId = requireGuildId(context);

    const query = String(args?.query ?? '').trim().toLowerCase();
    let entries = store.getLore(guildId);
    if (query) {
      entries = entries.filter(
        (entry) => entry.title.toLowerCase().includes(query) || entry.keys.some((key) => key.includes(query)),
      );
    }
    if (entries.length === 0) return NONE;
    return entries.map(loreLine).join('\n');
  }

  function cmdLoreShow(args, context) {
    freshenIfPaused();
    const guildId = requireGuildId(context);

    const id = String(args?.id ?? '').trim();
    const entry = store.getLore(guildId).find((e) => e.id === id);
    if (!entry) throw new Error(`no lore entry ${id}`);
    return JSON.stringify(entry, null, 2);
  }

  function cmdLoreRemove(args, context) {
    assertNotPaused();
    const guildId = requireGuildId(context);

    const id = String(args?.id ?? '').trim();
    const entry = store.getLore(guildId).find((e) => e.id === id);
    if (!entry) throw new Error(`no lore entry ${id}`);
    store.removeLore(guildId, id);
    return `Removed lore entry ${id}: ${entry.title}`;
  }

  // ---------------------------------------------------------------------
  // learned: the owner's side of the guild's list of things people taught
  // the persona (store.js#applyLearnedOps). Items are detail-shaped
  // (`{ id, text, weight, firstSeen, lastSeen, from? }`); `from` is the
  // teacher as a `<@id>` token. The owner's own adds carry no `from`.
  // ---------------------------------------------------------------------

  /** `#<id> <text> — from <name> · seen <weight> · last <YYYY-MM-DD>`, the `from` part only when
   * the item has one. */
  function learnedLine(item, resolve) {
    const from = item.from ? ` — from ${resolve(item.from)}` : '';
    const last = String(item.lastSeen ?? item.firstSeen ?? '-').slice(0, 10);
    return `#${item.id} ${resolve(item.text)}${from} · seen ${item.weight} · last ${last}`;
  }

  /** `/nep learned list`: every stored item, rank order (`memory.learnedHalfLifeDays`). */
  function cmdLearnedList(_args, context) {
    freshenIfPaused();
    const guildId = requireGuildId(context);

    const learned = store.getGuild(guildId).learned ?? [];
    if (learned.length === 0) return NONE;
    const { resolve } = tokenResolver(guildId);
    return sortByRank(learned, hot.config?.memory?.learnedHalfLifeDays)
      .map((item) => learnedLine(item, resolve))
      .join('\n');
  }

  /**
   * `/nep learned add`: an `add` op with no `from` that confirms the lesson at once, the same way
   * `/nep alias add` confirms an alias: repeated sightings with `confirmGapHours: 0` and ONE
   * `seenAt` (an add of a stored text counts as a sighting of it) until the item's weight reaches
   * `memory.confirmAfter` (default 2). A lesson already at or past that weight gets one ordinary
   * sighting under the live `config.memory` (so `confirmGapHours` applies) -- never more than the
   * analyzer seeing it again would give. Every other limit is the live `config.memory`. Replies
   * with the resulting item's line.
   */
  function cmdLearnedAdd(args, context) {
    assertNotPaused();
    const guildId = requireGuildId(context);

    const text = String(args?.text ?? '').trim();
    if (!text) throw new Error('text is required');

    const memoryCfg = hot.config?.memory ?? {};
    const target = confirmTarget(memoryCfg);

    const key = normalizeTopic(text);
    const before = store.getGuild(guildId).learned ?? [];
    const beforeIds = new Set(before.map((item) => item.id));
    const seenAt = Date.now();
    const seenIso = new Date(seenAt).toISOString();
    // The item this command added or sighted: a fresh id, else the same text, else the one
    // stamped just now (a text the store clamped no longer matches `key`).
    const locate = (items) =>
      items.find((it) => !beforeIds.has(it.id)) ??
      items.find((it) => normalizeTopic(it.text) === key) ??
      items.find((it) => it.lastSeen === seenIso);

    const existing = before.find((it) => normalizeTopic(it.text) === key);
    let item;
    if (existing && existing.weight >= target) {
      item = locate(store.applyLearnedOps(guildId, { add: [{ text }] }, { ...memoryCfg, seenAt }));
    } else {
      for (let i = 0; i < target; i += 1) {
        item = locate(store.applyLearnedOps(guildId, { add: [{ text }] }, { ...memoryCfg, confirmGapHours: 0, seenAt }));
        if (!item || item.weight >= target) break;
      }
    }
    if (!item) throw new Error('the item was not kept (the learned list is full)');
    return learnedLine(item, tokenResolver(guildId).resolve);
  }

  /** `/nep learned remove`: deletes one item by id; an id that is not stored is an error. */
  function cmdLearnedRemove(args, context) {
    assertNotPaused();
    const guildId = requireGuildId(context);

    const id = args?.id;
    if (!Number.isInteger(id)) throw new Error('an item id is required');
    const existing = (store.getGuild(guildId).learned ?? []).find((item) => item.id === id);
    if (!existing) throw new Error(`no learned item #${id}`);

    store.applyLearnedOps(guildId, { remove: [id] }, { ...(hot.config?.memory ?? {}), seenAt: Date.now() });
    return `Removed learned item #${id}: ${tokenResolver(guildId).resolve(existing.text)}`;
  }

  // ---------------------------------------------------------------------
  // model: which model serves each role
  // ---------------------------------------------------------------------

  /** `image.model` for status and model show, `-` when unset, flagged when src/llm/images.js
   * has no request mapping for its family (every generation would be refused). */
  function imageModelLabel(cfg) {
    const model = cfg?.image?.model;
    if (!model) return '-';
    const family = (images?.familyOf ?? imageFamilyOf)(model);
    return family ? model : `${model} (unsupported family)`;
  }

  function cmdModelShow() {
    const cfg = hot.config;
    const lines = [
      ...MODEL_ROLES.map((role) => `${role}: ${modelForRole(role, cfg) ?? '-'}`),
      `${IMAGE_ROLE}: ${imageModelLabel(cfg)}`,
      `mediaDescriptions: ${onOff(cfg?.features?.mediaDescriptions === true)}`,
    ];
    return lines.join('\n');
  }

  function cmdModelSet(args) {
    const role = String(args?.role ?? '');
    const dottedPath = Object.hasOwn(MODEL_SET_PATHS, role) ? MODEL_SET_PATHS[role] : null;
    if (!dottedPath) throw new Error(`unknown role: ${role} (${MODEL_SET_ROLES.join(', ')})`);

    const id = String(args?.id ?? '').trim();
    if (!MODEL_ID_RE.test(id)) throw new Error('id must look like a model id, e.g. anthropic/claude-haiku-4.5 (3-100 chars)');

    const ok = writeLocalPath(dottedPath, id);
    return `Set ${role} model to ${id} ${reloadNote(ok)}`;
  }

  // ---------------------------------------------------------------------
  // diary: the channel where the persona posts on its own (src/behavior/diary.js)
  // ---------------------------------------------------------------------

  /** The post kinds the diary may use: the keys of `diary.kinds` with a weight above zero, read now. */
  function diaryKindKeys() {
    return Object.entries(hot.config.diary?.kinds ?? {})
      .filter(([, weight]) => Number(weight) > 0)
      .map(([key]) => key);
  }

  /** Today's slots as local `HH:MM` times (a done one marked), one line; [] without a plan. */
  function diaryPlanLines(status) {
    if (!status || !Array.isArray(status.slots)) return [];
    const timezone = hot.config.bot?.timezone || 'UTC';
    const done = new Set(Array.isArray(status.done) ? status.done : []);
    const slots = status.slots.map((slot) => `${formatClock(slot, timezone)}${done.has(slot) ? ' done' : ''}`);
    return [`today${status.day ? ` (${status.day})` : ''}: ${slots.length > 0 ? slots.join(', ') : 'no posts planned'}`];
  }

  /**
   * `/nep diary set`: the channel must be one the bot can see, read, send and attach files in;
   * then `diary.channelId` is written to config.local.json, an empty `diary.json` is filled from
   * the persona's own past posts there (src/behavior/diary.js#backfillDiary), and the reply names
   * the channel, the backfilled count and today's plan when the diary is running.
   */
  async function cmdDiarySet(args, context) {
    assertNotPaused();
    const guildId = requireGuildId(context);
    const channelId = String(args?.channelId ?? '').trim();
    if (!channelId) throw new Error('a channel is required');
    const channel = await client.channels.fetch(channelId).catch(() => null);
    if (!channel) throw new Error(`no channel ${channelId}`);
    if (!canRead(channel)) throw new Error(`cannot view or read the history of ${channelId}; nothing was changed`);
    if (!canSend(channel)) throw new Error(`cannot send messages in ${channelId}; nothing was changed`);
    if (!canAttach(channel)) throw new Error(`cannot attach files in ${channelId}; nothing was changed`);

    const ok = writeLocalPath('diary.channelId', channelId);
    let backfilled = 0;
    let note = '';
    try {
      backfilled = await backfillDiary({
        store,
        channel,
        guildId,
        selfId: client.user?.id,
        config: hot.config,
        labels: hot.prompts?.labels,
      });
    } catch (err) {
      log.warn('admin: diary backfill failed', { error: err });
      note = ' (the backfill failed; it is retried before the first post)';
    }
    const lines = [`Diary channel set to ${channelId} ${reloadNote(ok)}; backfilled ${backfilled} posts${note}.`];
    lines.push(...diaryPlanLines(diary?.status?.()));
    return lines.join('\n');
  }

  /**
   * `/nep diary show`: the channel, today's slots, posts and pictures used today, each window's
   * hunger with the quiet streak, the history size.
   */
  function cmdDiaryShow(args, context) {
    freshenIfPaused();
    const status = diary?.status?.() ?? null;
    const channelId = hot.config.diary?.channelId || '';
    const guildId = resolvedGuildId(context);
    const history = status?.history ?? (guildId ? store.getDiary(guildId).posts.length : '-');
    const lines = [`diary channel: ${channelId || 'off'}`, ...diaryPlanLines(status)];
    if (status) {
      lines.push(`posts today: ${status.posts ?? 0}`, `pictures today: ${status.pictures ?? 0}`);
      const hunger = Array.isArray(status.hunger) && status.hunger.length > 0 ? status.hunger.join('/') : '-';
      lines.push(`hunger: ${hunger} (quiet streak ${status.quietStreak ?? 0})`);
    }
    lines.push(`history: ${history}`);
    return lines.join('\n');
  }

  /** `/nep diary off`: clears `diary.channelId`; `diary.json` stays. */
  function cmdDiaryOff() {
    const ok = editLocalConfig((local) => unsetPath(local, 'diary.channelId'));
    return `Diary off ${reloadNote(ok)}; its memory file is kept.`;
  }

  /** `/nep diary post [kind] [topic]`: one forced post now; an unknown kind is refused with the list. */
  async function cmdDiaryPost(args) {
    assertNotPaused();
    if (typeof diary?.force !== 'function') throw new Error('diary not running');
    const kind = String(args?.kind ?? '').trim() || undefined;
    const kinds = diaryKindKeys();
    if (kind !== undefined && !kinds.includes(kind)) {
      throw new Error(`unknown kind: ${kind} (kinds: ${kinds.join(', ')})`);
    }
    // The owner's topic nudges the post's subject; blank is none (src/behavior/diary.js#diaryTopic clamps it).
    const topic = String(args?.topic ?? '').trim();
    const outcome = await diary.force(topic ? { kind, topic } : { kind });
    const text = typeof outcome === 'string' ? outcome : (outcome?.outcome ?? JSON.stringify(outcome) ?? 'ok');
    // A refusal by a cap names the setting and the day's counts; any other reason is shown as its code.
    const limit = outcome && typeof outcome === 'object' ? outcome.limit : null;
    const reason = limit?.key
      ? ` (${limit.key} ${limit.used}/${limit.cap})`
      : outcome && typeof outcome === 'object' && outcome.reason ? ` (${outcome.reason})` : '';
    return `diary post${kind ? ` ${kind}` : ''}: ${text}${reason}`;
  }

  // ---------------------------------------------------------------------
  // ping: one minimal chat completion per role's model, in parallel,
  // to tell the owner in seconds whether each one is actually reachable.
  // Never touches the daily request cap or token calibration
  // (src/llm/openrouter.js#complete's `countAgainstDailyCap`
  // / `skipCalibration` options), never writes under data/.
  // The drawing model cannot take a chat completion and a generation costs
  // money and counts against the image caps, so the `image` role is checked
  // against the provider's public model listing instead: one free GET
  // (src/llm/openrouter.js#modelEndpoints).
  // ---------------------------------------------------------------------

  /** Start the YouTube check when the classifier.video role is pinged and a describer is wired; never rejects. */
  function startPingYoutube(requested) {
    if (!requested.includes('classifier.video') || typeof describer?.checkYoutube !== 'function') return null;
    return Promise.resolve()
      .then(() => describer.checkYoutube())
      .then(formatYoutubeLine, () => 'youtube: API key — unknown');
  }

  /**
   * `lines` with the web lookup line appended when the classifier.text role (the
   * page and search condensers' model) is pinged and a lookup is wired: whether
   * the lookup is on (features.webLookup, a missing key counts as OFF) and a
   * search key is configured. No network call; never the key itself.
   */
  function withWebLine(lines, requested) {
    if (!requested.includes('classifier.text') || typeof lookup?.hasSearch !== 'function') return lines;
    let line;
    if (hot.config?.features?.webLookup !== true) line = 'web: API key — off';
    else line = lookup.hasSearch() ? 'web: API key — ok' : 'web: API key — missing';
    return [...lines, line];
  }

  /** The image line before the drawing switch note: one free GET of the provider's public
   * listing through the llm client, or none at all when no model is set or its family is
   * refused. Never rejects; never generates, never counts against a cap, never writes state. */
  async function checkImageListing(cfg) {
    const model = cfg?.image?.model;
    if (!model) return `${IMAGE_ROLE}: (no model configured)`;
    if (!(images?.familyOf ?? imageFamilyOf)(model)) return `${IMAGE_ROLE}: ${model} — unsupported family`;
    if (typeof llm?.modelEndpoints !== 'function') return `${IMAGE_ROLE}: ${model} — not checked (the llm client has no listing)`;

    const start = Date.now();
    let listing;
    try {
      listing = await llm.modelEndpoints(model, { timeoutMs: cfg?.llm?.pingTimeoutMs ?? 30000 });
    } catch (err) {
      const reason = err?.name === 'TimeoutError' || err?.name === 'AbortError' ? 'timeout' : 'network';
      return `${IMAGE_ROLE}: ${model} — failed: ${reason}`;
    }
    if (listing.status === 404) return `${IMAGE_ROLE}: ${model} — not listed (HTTP 404)`;
    if (!listing.ok) return `${IMAGE_ROLE}: ${model} — failed: HTTP ${listing.status}`;

    const modalities = listing.json?.data?.architecture?.output_modalities;
    if (!Array.isArray(modalities) || !modalities.includes('image')) {
      return `${IMAGE_ROLE}: ${model} — listed, but no image output`;
    }
    const endpoints = Array.isArray(listing.json.data.endpoints) ? listing.json.data.endpoints.length : 0;
    return `${IMAGE_ROLE}: ${model} — listed, image output, ${endpoints} endpoint(s), ${Date.now() - start} ms`;
  }

  /** Start the image check when the image role is requested; never rejects. The line notes when
   * drawing is switched off (features.imageGeneration false; a missing key counts as on). */
  function startPingImage(requested, cfg) {
    if (!requested.includes(IMAGE_ROLE)) return null;
    const off = cfg?.features?.imageGeneration === false;
    return checkImageListing(cfg).then((line) => (off ? `${line} (features.imageGeneration is off)` : line));
  }

  async function cmdPing(args) {
    if (!llm) return 'ping is not available (no llm client configured)';

    const requested = pingRolesFor(args?.role);
    const modelRoles = PING_DISPLAY_ORDER.filter((role) => requested.includes(role));
    const cfg = hot.config;
    const roleModel = new Map(modelRoles.map((role) => [role, modelForRole(role, cfg)]));

    const youtube = startPingYoutube(modelRoles);
    const image = startPingImage(requested, cfg);

    // The model lines come first (the image line among them), the API checks after.
    const assemble = async (lines) => withWebLine(withYoutubeLine(withImageLine(lines, await image), await youtube), modelRoles);

    // One request per distinct (model, route): roles sharing a model share a ping unless a
    // role-specific `llm.providerByModel` key routes one of them elsewhere. Each request is
    // sent as the first role that needs it, so it goes out exactly as that role's would.
    const targetOf = (role) => {
      const model = roleModel.get(role);
      const route = resolveProvider(model, { byModel: cfg?.llm?.providerByModel, fallback: cfg?.llm?.provider, role });
      return `${model}\n${JSON.stringify(route ?? null)}`;
    };

    const promptText = hot.prompts?.labels?.ping?.prompt;
    if (!promptText) {
      const skipped = modelRoles.map((role) => `${role}: ${roleModel.get(role) ?? '(no model configured)'} — skipped: label missing`);
      return (await assemble(skipped)).join('\n');
    }

    const targets = new Map();
    for (const role of modelRoles) {
      const model = roleModel.get(role);
      if (model && !targets.has(targetOf(role))) targets.set(targetOf(role), { model, role });
    }
    const results = new Map();

    await Promise.all(
      [...targets].map(async ([target, { model, role }]) => {
        const start = Date.now();
        try {
          const result = await llm.complete([{ role: 'user', content: promptText }], {
            model,
            role,
            maxOutputTokens: 16,
            countAgainstDailyCap: false,
            skipCalibration: true,
            timeoutMs: cfg?.llm?.pingTimeoutMs ?? 30000,
          });
          results.set(target, { ok: true, ms: Date.now() - start, result });
        } catch (err) {
          results.set(target, { ok: false, ms: Date.now() - start, err });
        }
      }),
    );

    const lines = modelRoles.map((role) => {
      const model = roleModel.get(role);
      if (!model) return `${role}: (no model configured)`;
      const outcome = results.get(targetOf(role));
      return outcome.ok
        ? formatPingSuccess(role, model, outcome.result, outcome.ms)
        : formatPingFailure(role, model, outcome.err, outcome.ms);
    });
    return (await assemble(lines)).join('\n');
  }

  // ---------------------------------------------------------------------
  // route: which providers serve each model, per role -- the keys of
  // `llm.providerByModel` (`"<prefix>"` for any role, `"<prefix>@<role>"`
  // for one; resolved by src/llm/openrouter.js#matchRoute), written to
  // config.local.json like `/nep set`, never touching data/.
  // ---------------------------------------------------------------------

  /** `llm.providerByModel` as of the last write (`localOrLive`), `{}` when it is not a map. */
  function effectiveRoutes() {
    const routes = localOrLive('llm.providerByModel');
    return isPlainObject(routes) ? routes : {};
  }

  /** config.local.json with `llm.providerByModel` replaced by `edit(copyOfTheLocalMap)`'s result;
   * an emptied map, then an emptied `llm`, are pruned. Reloads the config; the reload's outcome. */
  function writeRoutes(edit) {
    return editLocalConfig((local) => {
      const next = structuredClone(local);
      const llmCfg = isPlainObject(next.llm) ? next.llm : {};
      const map = edit(isPlainObject(llmCfg.providerByModel) ? { ...llmCfg.providerByModel } : {});
      if (Object.keys(map).length > 0) llmCfg.providerByModel = map;
      else delete llmCfg.providerByModel;
      if (Object.keys(llmCfg).length > 0) next.llm = llmCfg;
      else delete next.llm;
      return next;
    });
  }

  /** One by-role line of `/nep route list`: the model and the routing it gets now. */
  function routeRoleLine(role, cfg, byModel) {
    const model = modelForRouteRole(role, cfg);
    if (!model) return `  ${role}: (no model configured)`;
    const match = matchRoute(model, byModel, role);
    const fallbackName = role === IMAGE_ROLE ? 'image.provider' : 'llm.provider';
    const fallback = role === IMAGE_ROLE ? cfg?.image?.provider : cfg?.llm?.provider;
    let applied = 'none';
    if (match) applied = `${match.key} ${routingSummary(match.value)}`;
    else if (isPlainObject(fallback)) applied = `${fallbackName} ${routingSummary(fallback)}`;
    const pin = cfg?.media?.video?.provider;
    const pinned = role === 'classifier.video' && isPlainObject(pin) ? `; direct-URL videos: media.video.provider ${routingSummary(pin)}` : '';
    return `  ${role}: ${model} -> ${applied}${pinned}`;
  }

  /** `/nep route list`: every route, one line each (prefix | role or any | providers | fallbacks),
   * then each role with the model it uses now and the routing that applies to it. */
  function cmdRouteList() {
    const cfg = hot.config;
    const byModel = effectiveRoutes();
    const roleRank = (role) => (role === null ? -1 : ROUTE_ROLES.includes(role) ? ROUTE_ROLES.indexOf(role) : ROUTE_ROLES.length);
    const routes = Object.entries(byModel)
      .filter(([, value]) => isPlainObject(value))
      .map(([key, value]) => {
        const at = key.lastIndexOf('@');
        return at === -1 ? { prefix: key, role: null, value } : { prefix: key.slice(0, at), role: key.slice(at + 1), value };
      })
      .sort((a, b) => (a.prefix === b.prefix ? roleRank(a.role) - roleRank(b.role) : a.prefix < b.prefix ? -1 : 1));
    const lines = routes.length === 0 ? [`routes: ${NONE}`] : ['routes:'];
    for (const route of routes) {
      lines.push(`  ${route.prefix} | ${route.role ?? 'any'} | ${describeProviders(route.value)} | fallbacks: ${fallbacksText(route.value)}`);
    }
    lines.push('by role:', ...ROUTE_ROLES.map((role) => routeRoleLine(role, cfg, byModel)));
    return lines.join('\n');
  }

  /** `/nep route set`: `{ only: [providers], allow_fallbacks }` under `<prefix>` or `<prefix>@<role>`. */
  function cmdRouteSet(args) {
    const prefix = routePrefixArg(args);
    const role = routeRoleArg(args);
    const providers = [...new Set(String(args?.providers ?? '').split(',').map((slug) => slug.trim()).filter(Boolean))];
    if (providers.length === 0) throw new Error('at least one provider slug is required, e.g. google-vertex');
    const invalid = providers.find((slug) => !PROVIDER_SLUG_RE.test(slug));
    if (invalid) throw new Error(`invalid provider slug: ${invalid} (lowercase letters, digits and -)`);
    const allowFallbacks = args?.fallbacks === true;

    const key = role ? `${prefix}@${role}` : prefix;
    const ok = writeRoutes((map) => ({ ...map, [key]: { only: providers, allow_fallbacks: allowFallbacks } }));
    return `Route ${key} (${role ?? 'any role'}): only ${providers.join(', ')}, fallbacks: ${onOff(allowFallbacks)} ${reloadNote(ok)}`;
  }

  /** `/nep route remove`: drops the `<prefix>` or `<prefix>@<role>` key from config.local.json. */
  function cmdRouteRemove(args) {
    const prefix = routePrefixArg(args);
    const role = routeRoleArg(args);
    const key = role ? `${prefix}@${role}` : prefix;
    const local = readLocalConfig(localConfigFile());
    const localMap = isPlainObject(local?.llm?.providerByModel) ? local.llm.providerByModel : {};
    if (!Object.hasOwn(localMap, key)) {
      const live = hot.config?.llm?.providerByModel;
      const fromBase = isPlainObject(live) && Object.hasOwn(live, key) ? ' in config.local.json (it is set in config.json)' : '';
      throw new Error(`no route ${key}${fromBase}`);
    }
    const ok = writeRoutes((map) => {
      delete map[key];
      return map;
    });
    return `Removed route ${key} ${reloadNote(ok)}`;
  }

  // ---------------------------------------------------------------------
  // warmup: the sample-based memory warmup -- see the module header of
  // src/memory/warmup.js. `people`/`status` stay read-only, never guarded
  // by assertNotPaused(); everything else writes under data/ and is.
  // ---------------------------------------------------------------------

  function formatWarmupPeople(report) {
    if (!report.ok) return outcomeText(report, 'not done');
    const lines = report.people.map((p, i) => {
      const topChannels = Object.entries(p.byChannel)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([cid, count]) => `${cid}:${count}`)
        .join(', ');
      return `${i + 1}. ${p.name} (id:${p.id}) — ${p.messages} messages, ${isoDay(p.firstTs)}..${isoDay(p.lastTs)}, top channels: ${topChannels || '-'}`;
    });
    if (lines.length === 0) lines.push(NONE);
    lines.push('');
    lines.push(`channels read: ${report.totals.channelsRead}`);
    lines.push(`messages read: ${report.totals.messagesRead}`);
    lines.push(`people below the threshold: ${report.totals.belowThreshold}`);
    return lines.join('\n');
  }

  async function cmdWarmupPeople(_args, context) {
    const guildId = requireGuildId(context);
    return formatWarmupPeople(await warmup.peopleReport(guildId));
  }

  /** `/nep warmup run`: starts the whole run and answers at once. A run that ends early without
   * throwing (`{ ok: false }`: a missing prompt, no guild, ...) is logged with its reason. */
  async function cmdWarmupRun(_args, context) {
    const guildId = requireGuildId(context);
    assertNotPaused();
    if (isWarmingUp()) return warmupBusyText();

    // Fire and forget: a full run takes many minutes, far beyond an interaction's lifetime.
    // Progress is persisted after every request; /nep warmup status follows it.
    warmup
      .run(guildId)
      .then((result) => {
        if (!result?.ok) log.warn('admin: warmup run ended early', { reason: outcomeText(result, null) });
      })
      .catch((err) => log.warn('admin: warmup run failed', { error: err }));
    return `warmup started: channels, then people, then the server. Follow it with ${slash('warmup status')}.`;
  }

  /** `/nep warmup stop`: ends any warmup work in flight for good -- the full run, a
   * `users`/`channels` bulk redo, or a synchronous one-off -- including cancelling the model call
   * actually in progress (see src/memory/warmup.js#stop). Reads no `data/` itself, so not
   * guarded by assertNotPaused(). */
  function cmdWarmupStop() {
    const result = warmup.stop();
    return result.ok ? 'warmup stopped' : 'no warmup in flight';
  }

  /** `/nep warmup users user:<member>`: a short summary of what was actually written -- sample
   * size, tokens, counts of interests/details/episodes/aliases, and the first ~300 chars of the
   * character field. Relays `outcome.message` unchanged when nothing was written (missing prompt
   * file, no messages in the window, a bad model answer, a stop mid-flight, ...). */
  function formatWarmupUserWritten(outcome) {
    if (!outcome.ok) return outcomeText(outcome, 'not done');
    const { member, answer, sample, tokensUsed, chunks } = outcome;
    const a = answer ?? {};
    const characterExcerpt = String(a.character ?? '').slice(0, 300) || '(empty)';
    const chunkNote = chunks > 1 ? `, ${chunks} chunks` : '';
    return [
      `profiled ${member.name} (id:${member.id})`,
      `sample: ${sample?.ownCount ?? '?'} own / ${sample?.contextCount ?? '?'} context lines${chunkNote}`,
      `tokens used: ${tokensUsed ?? '?'}`,
      `interests: ${a.interests?.length ?? 0}, details: ${a.details?.length ?? 0}, episodes: ${a.episodes?.length ?? 0}, aliases: ${a.aliases?.length ?? 0}`,
      `character: ${characterExcerpt}`,
    ].join('\n');
  }

  /** `/nep warmup users [user]`: a `user` given
   * -> (re)profiles exactly that member now, synchronously; omitted -> starts a background redo of
   * every qualifying member, sharing every rail with the full run. */
  async function cmdWarmupUsers(args, context) {
    const guildId = requireGuildId(context);
    assertNotPaused();

    const userId = args?.userId;
    if (userId) {
      const result = await warmup.runPerson(guildId, userId);
      return formatWarmupUserWritten(result.ok ? result.outcome : result);
    }

    const result = await warmup.runUsers(guildId);
    if (!result.ok) return outcomeText(result, 'not started');
    return `started ${result.count} members`;
  }

  /** `/nep warmup channels channel:<channel>`: the note actually written (purpose/topics/tone),
   * plus the counters and top writers `store.setChannelFacts` just filled in -- the same lines as
   * `/nep memory channel` (writers as `name (count)`, an id with no profile skipped; the last
   * message as a date). Relays `outcome.message` unchanged when nothing was written. */
  function formatWarmupChannelWritten(outcome, guildId) {
    if (!outcome.ok) return outcomeText(outcome, 'not done');
    const { channel, result, facts } = outcome;
    const lines = [
      `described #${channel.name} (id:${channel.id})`,
      `purpose: ${result.purpose || '(empty)'}`,
      `topics: ${result.topics || '(empty)'}`,
      `tone: ${result.tone || '(empty)'}`,
    ];
    if (facts) {
      lines.push(`messages seen: ${facts.messageCount}`);
      lines.push(`last message: ${isoDay(facts.lastMessageAt)}`);
      const writers = channelTopWritersText(facts.topWriters, tokenResolver(guildId).nameOf);
      if (writers) lines.push(`top writers: ${writers}`);
    }
    return lines.join('\n');
  }

  /** `/nep warmup channels [channel]`: a
   * `channel` given -> (re)describes exactly that channel now, synchronously; omitted -> starts a
   * background redo of every readable channel, sharing every rail with the full run. */
  async function cmdWarmupChannels(args, context) {
    const guildId = requireGuildId(context);
    assertNotPaused();

    const channelId = args?.channelId;
    if (channelId) {
      const result = await warmup.runChannel(guildId, channelId);
      return formatWarmupChannelWritten(result.ok ? result.outcome : result, guildId);
    }

    const result = await warmup.runChannels(guildId);
    if (!result.ok) return outcomeText(result, 'not started');
    return `started ${result.count} channels`;
  }

  /** `/nep warmup server`: counts of what was written (patterns/starters lengths, injokes, lore
   * entries). Relays `outcome.message` unchanged when nothing was written. */
  function formatWarmupServerWritten(outcome) {
    if (!outcome.ok) return outcomeText(outcome, 'not done');
    const c = outcome.counts;
    return `server notes updated: patterns ${c.patternsChars} chars, starters ${c.startersChars} chars, injokes ${c.injokes}, lore entries ${c.lore}`;
  }

  async function cmdWarmupServer(_args, context) {
    const guildId = requireGuildId(context);
    assertNotPaused();

    const result = await warmup.runServer(guildId);
    return formatWarmupServerWritten(result.ok ? result.outcome : result);
  }

  async function cmdWarmupStatus(_args, context) {
    const guildId = requireGuildId(context);
    const s = await warmup.status(guildId); // synchronous in the real runner; awaiting a plain value is harmless
    return [
      `phase: ${formatWarmupPhase(s)}`,
      `last activity: ${humanizeAgo(s.activity?.lastActivityAt, Date.now())}`,
      `channels: ${s.doneChannels}/${s.channelsEligible ?? '?'}`,
      `people: ${s.donePeople}/${s.peopleEligible ?? '?'}`,
      `server: ${s.doneServer ? 'done' : 'pending'}`,
      `tokens used: ${s.tokensUsed} / ${hot.config.warmup?.maxTokens ?? '-'}`,
      `requests: ${s.requests}`,
      `started: ${s.startedAt ?? '-'}`,
      `finished: ${s.finishedAt ?? '-'}`,
      `aborted: ${s.aborted ?? 'no'}`,
      `next target: ${s.nextTarget ?? '-'}`,
    ].join('\n');
  }

  /** `/nep warmup reset`: clears warmup progress only (stored profiles/channel/guild data
   * untouched). Writes `state.json`, so refused while paused like the other warmup commands. */
  function cmdWarmupReset() {
    assertNotPaused();
    const result = warmup.reset();
    return result.ok ? 'Warmup progress reset (stored profiles/channel/guild data untouched).' : outcomeText(result, 'not done');
  }

  /** `/nep memory refresh user:<member>`: forces a portrait refresh (character/style only),
   * ignoring the hours rail, not the daily request cap. No hint is sent with it: the profile
   * prompt then has no `<hint>` block. Refused while paused or while a warmup runs. */
  async function cmdMemoryRefresh(args, context) {
    if (!warmup) return 'warmup is not available';
    assertNotPaused();
    const userId = args?.userId;
    if (!userId) throw new Error('a user is required');
    const guildId = requireGuildId(context);
    if (isWarmingUp()) return `Refresh not performed: ${warmupBusyText()}`;

    const result = await warmup.refreshPortrait(guildId, userId, '', { force: true });
    if (!result.ok) {
      const why = result.reason === 'warming-up' ? warmupBusyText() : outcomeText(result, 'unknown reason');
      return `Refresh not performed: ${why}`;
    }
    if (result.characterQueued) {
      return `Portrait refreshed for ${userId}; its character text lands after the next voice run.`;
    }
    return `Portrait refreshed for ${userId}.`;
  }

  // ---------------------------------------------------------------------
  // mentor: the manual mentor (src/mentor/*). Cases go through
  // `mentorCases`, runs through `mentor`, numbers through `mentorBudget`.
  // `cases`/`show`/`status`/`stop` only read or abort, so they are never
  // guarded by assertNotPaused(); the rest write under data/ and are.
  // ---------------------------------------------------------------------

  /** The `id` option as a positive integer, or an Error. */
  function mentorCaseId(args) {
    const id = Number(args?.id);
    if (!Number.isInteger(id) || id < 1) throw new Error('a case id is required');
    return id;
  }

  /** The case `id` of `guildId`, or an Error `no case <id>`. */
  function requireCase(guildId, id) {
    const item = mentorCases.get(guildId, id);
    if (!item) throw new Error(`no case ${id}`);
    return item;
  }

  /** The `message` option: a message link or id, or an Error. */
  function mentorMessageRef(args) {
    const ref = typeof args?.message === 'string' ? args.message.trim() : '';
    if (!ref) throw new Error('a message link or id is required');
    return ref;
  }

  /** `moment <id>: <n> messages up to the trigger, an answer of <m> messages`. */
  function momentLine(anchor) {
    return `moment ${anchor.id}: ${anchor.history.length} messages up to the trigger, an answer of ${anchor.original.length} messages`;
  }

  /** A case is a message of the persona plus the owner's comment: both are required, the target is
   * always `reply`. The comment is checked before the message is read; reading it spends no tokens. */
  async function cmdMentorAdd(args, context) {
    assertNotPaused();
    const guildId = requireGuildId(context);
    const ref = mentorMessageRef(args);
    const text = checkCaseText(args?.text);
    const anchor = await mentor.readAnchor(ref, { channelId: context?.channelId ?? null });
    const item = mentorCases.add(guildId, { text, target: 'reply', anchor });
    return `case ${item.id} added (${item.target}), ${momentLine(item.anchors[0])}`;
  }

  /** Adds another moment to a case, at most `mentor.anchor.max` (read now); a case that cannot take
   * one more is refused before the message is read. */
  async function cmdMentorAnchor(args, context) {
    assertNotPaused();
    const guildId = requireGuildId(context);
    const id = mentorCaseId(args);
    const ref = mentorMessageRef(args);
    const item = requireCase(guildId, id);
    const max = anchorMax(hot.config.mentor?.anchor?.max);
    const held = Array.isArray(item.anchors) ? item.anchors.length : 0;
    if (held >= max) throw new Error(`case ${id} has ${held} moments; at most ${max} (mentor.anchor.max)`);
    const anchor = await mentor.readAnchor(ref, { channelId: context?.channelId ?? null });
    const { item: updated, anchor: added } = mentorCases.addAnchor(guildId, id, anchor, { max });
    return `case ${id}: ${momentLine(added)} (${updated.anchors.length} of ${max})`;
  }

  /** One line per active case: `<id> [<state>] <target> <score or -> <text clipped to 80>`, with
   * `moments <n>` before the text for a case that has any. */
  function cmdMentorCases(_args, context) {
    const list = mentorCases.list(requireGuildId(context));
    if (list.length === 0) return NONE;
    return list
      .map((item) => {
        const score = typeof item.lastScore === 'number' && Number.isFinite(item.lastScore) ? String(item.lastScore) : '-';
        const text = String(item.text ?? '').replace(/\s+/g, ' ');
        const shown = text.length > MENTOR_CASE_TEXT_SHOWN ? `${text.slice(0, MENTOR_CASE_TEXT_SHOWN - 3)}...` : text;
        const moments = Array.isArray(item.anchors) && item.anchors.length > 0 ? `moments ${item.anchors.length} ` : '';
        return `${item.id} [${item.state}] ${item.target} ${score} ${moments}${shown}`;
      })
      .join('\n');
  }

  function cmdMentorRemove(args, context) {
    assertNotPaused();
    const guildId = requireGuildId(context);
    const id = mentorCaseId(args);
    requireCase(guildId, id);
    const item = mentorCases.retire(guildId, id);
    return `case ${item.id} retired`;
  }

  /** Starts the run and answers at once: the run ends far beyond an interaction's lifetime. With an
   * admin channel (`bot.dryRunChannelId`, read now) the mentor posts its report there; without one
   * the reply points at `status` and `show`. An unknown case is refused here, like `show` and
   * `anchor`; a guard of the mentor rejects here too. */
  async function cmdMentorRun(args, context) {
    assertNotPaused();
    const guildId = requireGuildId(context);
    const id = mentorCaseId(args);
    requireCase(guildId, id);
    await mentor.run(id);
    if (hot.config.bot?.dryRunChannelId) return `run started for case ${id}; the report will come to the admin channel`;
    return `run started for case ${id}; follow it with ${slash('mentor status')}, read the report with ${slash(`mentor show ${id}`)}`;
  }

  /** Starts a check of every case with a run; answers at once, like `run`, and the same way
   * points at `status` and `show` when there is no admin channel. */
  async function cmdMentorCheck() {
    assertNotPaused();
    const { cases } = await mentor.check();
    if (hot.config.bot?.dryRunChannelId) return `check started for ${cases} cases`;
    return `check started for ${cases} cases; follow it with ${slash('mentor status')}, read each report with ${slash('mentor show <id>')}`;
  }

  /** Aborts the run in flight; reads no `data/` itself, so not guarded by assertNotPaused(). */
  function cmdMentorStop() {
    return mentor.stop().ok ? 'stopping' : 'nothing is running';
  }

  /** The case's last run (a `check` run the same way): the card, with the full report attached. */
  function cmdMentorShow(args, context) {
    const guildId = requireGuildId(context);
    const id = mentorCaseId(args);
    requireCase(guildId, id);
    const lastRun = mentorCases.lastRun(guildId, id);
    if (!lastRun) throw new Error(`case ${id} has no run yet`);
    const file = renderFile(lastRun);
    return { text: renderCard(lastRun), files: [{ attachment: Buffer.from(file.text, 'utf8'), name: file.name }] };
  }

  /** The owner says the mentor judged a case wrongly; the case store refuses a case without a run. */
  function cmdMentorWrong(args, context) {
    assertNotPaused();
    const guildId = requireGuildId(context);
    const id = mentorCaseId(args);
    requireCase(guildId, id);
    mentorCases.addFeedback(guildId, { caseId: id, reason: args?.reason });
    return `noted for case ${id}`;
  }

  /** The `last:` line: the newest `finishedAt` among the last runs of every case, retired ones
   * included. A run file or case list that cannot be read gives `last: cannot be read`, never a throw. */
  function mentorLastLine(guildId) {
    let latest = null;
    let latestMs = -Infinity;
    try {
      for (const item of mentorCases.list(guildId, { includeRetired: true })) {
        const lastRun = mentorCases.lastRun(guildId, item.id);
        if (!lastRun) continue;
        const ms = Date.parse(lastRun.finishedAt ?? '');
        const rank = Number.isFinite(ms) ? ms : -Infinity;
        if (!latest || rank > latestMs) {
          latest = lastRun;
          latestMs = rank;
        }
      }
    } catch {
      return 'last: cannot be read';
    }
    return renderLastRun(latest);
  }

  /** Works with the mentor off or without a model -- it is how the owner sees why nothing runs.
   * The last line is always the most recent finished run (`last:`). */
  function cmdMentorStatus(_args, context) {
    const lines = [
      `enabled: ${onOff(hot.config.features?.mentor === true)}`,
      `model: ${hot.config.mentor?.model || '-'}`,
    ];
    if (mentorBudget) {
      const { used, cap, left } = mentorBudget.snapshot();
      lines.push(`tokens today: ${used} / ${cap} (${left} left)`);
    } else {
      lines.push('tokens today: -');
    }
    const guildId = resolvedGuildId(context);
    if (guildId) {
      const counts = Object.fromEntries(MENTOR_STATES.map((state) => [state, 0]));
      for (const item of mentorCases.list(guildId, { includeRetired: true })) {
        if (Object.hasOwn(counts, item.state)) counts[item.state] += 1;
      }
      lines.push(`cases: ${MENTOR_STATES.map((state) => `${counts[state]} ${state}`).join(', ')}`);
    } else {
      lines.push('cases: -');
    }
    const s = mentor.status();
    lines.push(s?.running ? `running: ${s.kind} case ${s.caseId}, ${s.phase}, ${s.tokens} tokens so far${s.stopping ? ', stopping' : ''}` : 'running: no');
    lines.push(guildId ? mentorLastLine(guildId) : 'last: -');
    return lines.join('\n');
  }

  // ---------------------------------------------------------------------
  // access: who besides owners may run which commands (src/discord/access.js)
  // ---------------------------------------------------------------------

  /** `key` is grantable when it is `*`, a known subcommand-group name, or a known
   * `<group>.<name>`/bare top-level command key (src/discord/commands.js#commandKeys). */
  function isKnownAccessKey(key) {
    if (key === '*') return true;
    const { keys, groups } = commandKeys();
    return keys.has(key) || groups.has(key);
  }

  /** The command keys a grant of `key` opens: every one for `*`, a group's commands for a group,
   * else the key itself -- owner-only ones never (src/discord/access.js#isOwnerOnly), nor the
   * member commands, open without a grant (src/discord/access.js#isMemberCommand). */
  function keysOpenedBy(key) {
    const { keys, groups } = commandKeys();
    let opened = [key];
    if (key === '*') opened = [...keys];
    else if (groups.has(key)) opened = [...keys].filter((full) => full.startsWith(`${key}.`));
    return opened.filter((full) => !isOwnerOnly(full) && !isMemberCommand(full));
  }

  /** `bot.access` as of the last write (`localOrLive`): config.local.json already holds the whole
   * merged object the moment one grant/revoke writes it (see `writeAccess`), so reading it back
   * first keeps repeated grant/revoke/list calls consistent even a moment before the next reload
   * lands. Falls back to `hot.config.bot.access` (the base config.json default, `{}`) before
   * anything has ever been written locally. */
  function effectiveAccess() {
    return localOrLive('bot.access') ?? {};
  }

  /** Writes `nextAccess` to `bot.access` in config.local.json and reloads config -- the same
   * mechanism cmdSet uses; the reload's outcome. */
  function writeAccess(nextAccess) {
    return writeLocalPath('bot.access', nextAccess);
  }

  /** `{ what, label }` for whichever one target option (or neither) was given: `what` is the
   * argument of src/discord/access.js#grant/#revoke/#hasGrant, `label` reads `role id:<id>`,
   * `user id:<id>` or `everyone` (plain text: a multi-line reply is code-fenced, where a mention
   * would show as raw markup). */
  function accessTargetArgs(args) {
    const roleId = args?.roleId;
    const userId = args?.userId;
    if (roleId && userId) throw new Error('give a role or a user, not both');
    if (roleId) return { what: { roleId: String(roleId) }, label: `role id:${roleId}` };
    if (userId) return { what: { userId: String(userId) }, label: `user id:${userId}` };
    return { what: { everyone: true }, label: 'everyone' };
  }

  // ---------------------------------------------------------------------
  // pings: a member's own notification switch (`/nep pings`)
  // ---------------------------------------------------------------------

  /** `/nep pings [on|off]`: the caller's own notifications from the persona in this guild
   * (store.setPingsOff; src/behavior/turn.js reads them when it posts). No mode shows the state.
   * A member's own switch, not memory: it works while paused too (read fresh off disk then, and
   * written at once by the store). */
  function cmdPings(args, context) {
    const guildId = requireGuildId(context);
    const userId = context?.userId;
    if (!userId) throw new Error('no user');
    const mode = args?.mode;
    freshenIfPaused();
    if (mode === undefined || mode === null || mode === '') return pingsText(!store.isPingsOff(guildId, userId));
    if (!PINGS_MODES.includes(mode)) throw new Error(`mode must be one of: ${PINGS_MODES.join(', ')}`);
    const off = store.setPingsOff(guildId, userId, mode === 'off');
    log.info('admin: pings set', { guildId, userId, off });
    return pingsText(!off);
  }

  /** The one reply of `/nep pings`: the caller's state after the call. */
  function pingsText(on) {
    return on ? 'Pings: on' : 'Pings: off';
  }

  function cmdAccessGrant(args) {
    const key = String(args?.command ?? '').trim();
    if (!key) throw new Error('a command key is required');
    if (isMemberCommand(key)) throw new Error(`${key} is open to every member and cannot be granted`);
    if (!isKnownAccessKey(key)) throw new Error(`unknown command key: ${key}`);
    if (isOwnerOnly(key)) {
      const group = key.split('.')[0];
      throw new Error(`${OWNER_ONLY_NAMES[group] ?? group} is owner-only and cannot be granted: ${key}`);
    }

    const target = accessTargetArgs(args);
    const ok = writeAccess(accessGrant(effectiveAccess(), key, target.what));

    const opened = keysOpenedBy(key);
    const notes = [];
    if (opened.some((full) => !READ_ONLY_ACCESS_KEYS.has(full))) notes.push('Note: this opens commands that change memory or config.');
    if (opened.some((full) => SPENDS_BALANCE_KEYS.has(full))) {
      notes.push('Note: this opens ping, whose every call spends OpenRouter balance outside llm.maxRequestsPerDay.');
    }
    return [`Granted ${key} to ${target.label} ${reloadNote(ok)}`, ...notes].join('\n');
  }

  function cmdAccessRevoke(args) {
    const key = String(args?.command ?? '').trim();
    if (!key) throw new Error('a command key is required');
    if (!isKnownAccessKey(key)) throw new Error(`unknown command key: ${key}`);

    const target = accessTargetArgs(args);
    const currentAccess = effectiveAccess();
    if (!hasGrant(currentAccess, key, target.what)) return 'Nothing to revoke';

    const ok = writeAccess(accessRevoke(currentAccess, key, target.what));
    return `Revoked ${key} from ${target.label} ${reloadNote(ok)}`;
  }

  /** Every grant, one line each (`everyone`, `role id:<id>`, `user id:<id>`); a stale grant on an
   * owner-only command (it opens nothing, see src/discord/access.js#isOwnerOnly) is left out. */
  function cmdAccessList() {
    const access = effectiveAccess();
    const keys = Object.keys(access).filter((key) => !isOwnerOnly(key));
    if (keys.length === 0) return NONE;

    return keys
      .map((key) => {
        const entry = access[key];
        const parts = [];
        if (entry?.everyone === true) parts.push('everyone');
        if (Array.isArray(entry?.roles)) parts.push(...entry.roles.map((id) => `role id:${id}`));
        if (Array.isArray(entry?.users)) parts.push(...entry.users.map((id) => `user id:${id}`));
        return `${key}: ${parts.join(', ')}`;
      })
      .join('\n');
  }

  // ---------------------------------------------------------------------
  // emoji and gifs: the custom emoji ranking and the GIF library
  // ---------------------------------------------------------------------

  /** `/nep emoji status`: how many emoji the ranking holds, the top 10 (rank order,
   * `context.customEmoji.halfLifeDays`) with their counts, and the history backfill stamp. */
  function cmdEmojiStatus(_args, context) {
    freshenIfPaused();
    const guildId = requireGuildId(context);

    const guild = store.getGuild(guildId);
    const ranked = rankEmojiUsage(guild.emojiUsage, hot.config?.context?.customEmoji?.halfLifeDays ?? 30);
    const running = emojiBackfill?.isRunning?.() ? ' (running now)' : '';
    return [
      `ranking: ${ranked.length} emoji`,
      ranked.length > 0 ? 'top 10:' : `top 10: ${NONE}`,
      ...ranked.slice(0, 10).map((entry) => `  :${entry.name}: x${entry.count}`),
      `backfill: ${backfillText(guild.emojiBackfill)}${running}`,
    ].join('\n');
  }

  /** `/nep emoji rescan`: clears `emojiUsage` and recounts it from channel history (the backfill
   * with `force`), awaited to the end. Writes under data/, so refused while paused. */
  async function cmdEmojiRescan(_args, context) {
    if (!emojiBackfill) return 'the emoji backfill is not available';
    assertNotPaused();
    const guildId = requireGuildId(context);

    const result = await emojiBackfill.run(guildId, { force: true });
    if (!result.ok) return skipText(EMOJI_RESCAN_SKIPS, result.reason, `not done (${result.reason})`);
    return `Emoji rescan done: ${result.channels} channels, ${result.messages} messages read, ${result.emoji} emoji uses counted.`;
  }

  /** `/nep gifs status`: how many GIFs the library holds, the top 10 (rank order,
   * `gifs.halfLifeDays`) as `g<n> xCOUNT — caption or name`, the history backfill stamp, how
   * many GIFs the persona posted today (UTC) against `gifs.maxPerDay`
   * (src/memory/gif-watch.js#gifPostsToday), how many GIFs it watched
   * today against `media.gif.maxPerDay` (src/memory/gif-watch.js), and -- last, unless the
   * library is empty and no recache runs -- how the library's captions stand (watched /
   * one-frame / failed watch / none, see src/memory/gif-recache.js#gifCaptionCounts) with a
   * note while a recache runs, then the move to three-field captions (watched with fields /
   * watched in the old format, still to re-describe / unwatched, gifFormatCounts). Counts only. */
  function cmdGifsStatus(_args, context) {
    freshenIfPaused();
    const guildId = requireGuildId(context);

    const library = store.getGifs(guildId);
    const ranked = rankGifs(library, hot.config?.gifs?.halfLifeDays ?? 30);
    const cache = store.getMediaCache(guildId);
    const captionOf = (entry) => {
      const cached = cache?.[entry.itemId];
      return cached && !cached.miss && typeof cached.text === 'string' ? cached.text.trim() : '';
    };
    const running = gifBackfill?.isRunning?.() ? ' (running now)' : '';
    const data = store.state.data;
    const today = todayUtc();
    const posts = gifPostsToday(data, hot.config, today);
    const watches = gifWatchesToday(data, hot.config, today);
    const captions = gifCaptionCounts(library, cache);
    const format = gifFormatCounts(library, cache);
    const recaching = gifRecache?.isRunning?.() ? ' (recache running now)' : '';
    return [
      `library: ${ranked.length} gifs`,
      ranked.length > 0 ? 'top 10:' : `top 10: ${NONE}`,
      ...ranked
        .slice(0, 10)
        .map((entry) => `  ${entry.id} x${entry.count} — ${captionOf(entry) || entry.name || entry.site || entry.url}`),
      `backfill: ${backfillText(library.backfill)}${running}`,
      `posted today: ${posts.used}/${posts.cap}`,
      `watched today: ${watches.used}/${watches.cap}`,
      // Nothing to count in an empty library, unless a recache is running.
      ...(ranked.length > 0 || recaching
        ? [
            `captions: ${captions.watched} watched, ${captions['one-frame']} one-frame, ${captions.failed} failed, ${captions.none} none${recaching}`,
            `caption format: ${format.fields} watched with fields, ${format.oldFormat} watched in the old format (to re-describe), ${format.unwatched} unwatched`,
          ]
        : []),
    ].join('\n');
  }

  /** `/nep gifs rescan`: resets the library's use counts (every entry and handle is kept) and
   * recounts them from channel history, then captions the top ones (the backfill with `force`),
   * awaited to the end. Writes under data/, so refused while paused. */
  async function cmdGifsRescan(_args, context) {
    if (!gifBackfill) return 'the GIF backfill is not available';
    assertNotPaused();
    const guildId = requireGuildId(context);

    const result = await gifBackfill.run(guildId, { force: true });
    if (!result.ok) return skipText(GIFS_RESCAN_SKIPS, result.reason, `not done (${result.reason})`);
    return `GIF rescan done: ${result.channels} channels, ${result.messages} messages read, ${result.gifs} GIF uses counted, ${result.described} described.`;
  }

  /** `/nep gifs recache`: drops the one-frame GIF captions outside the library at once, then
   * re-describes up to `gifs.recachePerRun` library GIFs by watching them, in the background
   * (src/memory/gif-recache.js). Replies at once. Writes under data/, so refused while paused. */
  function cmdGifsRecache(_args, context) {
    if (!gifRecache) return 'the GIF recache is not available';
    assertNotPaused();
    const guildId = requireGuildId(context);

    const result = gifRecache.start(guildId);
    if (!result.ok) {
      if (result.reason === 'running') return `A GIF recache is already running: see ${slash('gifs status')}.`;
      return skipText(GIFS_RECACHE_SKIPS, result.reason, `not started (${result.reason})`);
    }
    return [
      `GIF recache started: ${result.queued} library GIFs to watch, ${result.dropped} one-frame captions dropped from the media cache.`,
      `Follow it with ${slash('gifs status')}.`,
    ].join('\n');
  }

  /** Wraps a `warmup.*` handler so both report the same thing when the dependency is absent. */
  function withWarmup(fn) {
    return (args, context) => {
      if (!warmup) return 'warmup is not available';
      return fn(args, context);
    };
  }

  /** Wraps a `mentor.*` handler so all of them report the same thing when a dependency is absent. */
  function withMentor(fn) {
    return (args, context) => {
      if (!mentor || !mentorCases) return 'the mentor is not available';
      return fn(args, context);
    };
  }

  const commands = {
    status: () => cmdStatus(),
    ping: (args) => cmdPing(args),
    pings: (args, context) => cmdPings(args, context),
    reload: () => cmdReload(),
    pause: () => cmdPause(),
    resume: () => cmdResume(),
    interject: (args, context) => cmdForce('interject', args, context),
    initiate: (args, context) => cmdForce('initiate', args, context),
    draw: (args, context) => cmdDraw(args, context),
    set: (args, context) => cmdSet(args, context),
    unset: (args, context) => cmdUnset(args, context),
    'rule.add': (args) => cmdRuleAdd(args),
    'rule.list': () => cmdRuleList(),
    'rule.remove': (args) => cmdRuleRemove(args),
    'memory.show': (args, context) => cmdMemoryShow(args, context),
    'memory.channel': (args, context) => cmdMemoryChannel(args, context),
    'memory.server': (args, context) => cmdMemoryServer(args, context),
    'memory.recent': (args, context) => cmdMemoryRecent(args, context),
    'memory.archive': (args, context) => cmdMemoryArchive(args, context),
    'memory.restore': (args, context) => cmdMemoryRestore(args, context),
    'memory.forget': (args, context) => cmdMemoryForget(args, context),
    'memory.wipe': (args, context) => cmdMemoryWipe(args, context),
    'memory.affinity': (args, context) => cmdMemoryAffinity(args, context),
    'memory.refresh': (args, context) => cmdMemoryRefresh(args, context),
    'private.show': (args, context) => cmdPrivateShow(args, context),
    'private.forget': (args, context) => cmdPrivateForget(args, context),
    'private.purge': (args, context) => cmdPrivatePurge(args, context),
    'alias.add': (args, context) => cmdAliasAdd(args, context),
    'alias.remove': (args, context) => cmdAliasRemove(args, context),
    'lore.add': (args, context) => cmdLoreAdd(args, context),
    'lore.list': (args, context) => cmdLoreList(args, context),
    'lore.show': (args, context) => cmdLoreShow(args, context),
    'lore.remove': (args, context) => cmdLoreRemove(args, context),
    'learned.list': (args, context) => cmdLearnedList(args, context),
    'learned.add': (args, context) => cmdLearnedAdd(args, context),
    'learned.remove': (args, context) => cmdLearnedRemove(args, context),
    'emoji.status': (args, context) => cmdEmojiStatus(args, context),
    'emoji.rescan': (args, context) => cmdEmojiRescan(args, context),
    'gifs.status': (args, context) => cmdGifsStatus(args, context),
    'gifs.rescan': (args, context) => cmdGifsRescan(args, context),
    'gifs.recache': (args, context) => cmdGifsRecache(args, context),
    'model.show': () => cmdModelShow(),
    'model.set': (args) => cmdModelSet(args),
    'diary.set': (args, context) => cmdDiarySet(args, context),
    'diary.show': (args, context) => cmdDiaryShow(args, context),
    'diary.off': () => cmdDiaryOff(),
    'diary.post': (args) => cmdDiaryPost(args),
    'route.list': () => cmdRouteList(),
    'route.set': (args) => cmdRouteSet(args),
    'route.remove': (args) => cmdRouteRemove(args),
    'warmup.people': withWarmup((args, context) => cmdWarmupPeople(args, context)),
    'warmup.run': withWarmup((args, context) => cmdWarmupRun(args, context)),
    'warmup.stop': withWarmup(() => cmdWarmupStop()),
    'warmup.users': withWarmup((args, context) => cmdWarmupUsers(args, context)),
    'warmup.channels': withWarmup((args, context) => cmdWarmupChannels(args, context)),
    'warmup.server': withWarmup((args, context) => cmdWarmupServer(args, context)),
    'warmup.status': withWarmup((args, context) => cmdWarmupStatus(args, context)),
    'warmup.reset': withWarmup(() => cmdWarmupReset()),
    'mentor.add': withMentor((args, context) => cmdMentorAdd(args, context)),
    'mentor.anchor': withMentor((args, context) => cmdMentorAnchor(args, context)),
    'mentor.cases': withMentor((args, context) => cmdMentorCases(args, context)),
    'mentor.remove': withMentor((args, context) => cmdMentorRemove(args, context)),
    'mentor.run': withMentor((args, context) => cmdMentorRun(args, context)),
    'mentor.check': withMentor(() => cmdMentorCheck()),
    'mentor.stop': withMentor(() => cmdMentorStop()),
    'mentor.show': withMentor((args, context) => cmdMentorShow(args, context)),
    'mentor.wrong': withMentor((args, context) => cmdMentorWrong(args, context)),
    'mentor.status': withMentor((args, context) => cmdMentorStatus(args, context)),
    'access.grant': (args) => cmdAccessGrant(args),
    'access.revoke': (args) => cmdAccessRevoke(args),
    'access.list': () => cmdAccessList(),
  };

  /**
   * Run one command. `commandKey` is `'<name>'` for a top-level command or
   * `'<group>.<name>'` for a grouped one. Throws an operator-facing `Error`
   * on bad input or an unknown key; never touches discord.js.
   */
  async function run(commandKey, args = {}, context = {}) {
    const handler = Object.hasOwn(commands, commandKey) ? commands[commandKey] : null;
    if (!handler) throw new Error(`unknown command: ${commandKey}`);
    return handler(args, context);
  }

  return { isAllowed, run };
}
