#!/usr/bin/env node
// The rehearsal of the memory writer switch (spec 2026-10-24-memory-authority, section 6 items 9 and 10; stage W5):
// the switch protocol run on copies of a frozen data directory and its database, then a real day replayed with the
// database as the only writer, the cutover boundary, injected failures, ordering and duplicates, the restore of the
// backup, each a row PASS or FAIL with its numbers, written as a Markdown report. There is no legacy fallback row: after
// the switch the JSON memory is deleted and the database backups are the only way back (spec section 7).
//
//   node tools/memory-rehearsal.mjs --data <frozen copy of data/> --db <copy of memory.db> --day <YYYY-MM-DD>
//        [--session fake|memory-key] [--report <file.md>] [--keep]
//
// The given paths are only read: everything runs on copies the tool makes in a temporary root under TMPDIR (removed at
// the end unless --keep, then its path is printed). A path under /opt/neptunia is refused. The database is copied with
// `VACUUM INTO` (a consistent copy of a file a live process may hold).
//
// The core is wired as src/index.js wires it (the same factories: the memory service, the record and its embedding
// hook, the meaning index, the archive, the journal, the store, the embedding queue, the task and intention stores, the
// intention service, the analyzer, the message pipeline behind the event door), with no Discord client: a fake
// discord.js layer the interface's own `toEvent` turns into the protocol's normalised events, a stub turn runner, a
// model that answers nothing but her memory session, and a fake embedder (vectors from a hash of the text). The
// config is the checkout's (config.json and the private layer) with the rehearsal's switches over it (the memory
// database on, the observation path, the record, the journal, the meaning index, private chats with permissive gates,
// the helpers that would call a model off).
//
// The rows, in this order:
//   1. baseline       one sync of the copies, then `reader-parity` and `parity` (tools/memory-db.mjs).
//   2. switch         the protocol of spec 6.10 on the copies: a process under `json` holding the cutover state of
//                     row 4, producers paused, the cache, the append stores and the embedding queue flushed, the last
//                     sync, the shadow writes drained, `verify` and `observe-check --data` at the barrier, a backup with
//                     its counts and watermarks, a new process under `db` opened (the pending replay and the handoff
//                     done) before the catch-up delivers anything.
//   3. sole authority the memory files (paths.js#MEMORY_PATTERNS) deleted from the copy; the day `--day` replayed from
//                     its record and journal lines (both layers) as events in their arrival order: seen lines, edits and
//                     deletions through the pipeline, her said lines and her turns' journal lines as the turn writes them,
//                     their participation, the diary posts of the day, embeddings; her session sweeping on its schedule
//                     (`fake`: fixed plans; `memory-key`: her real session on the memory key, the lead's choice); then
//                     every consumer reads. Every file access under the copy is watched: a read or a write of a memory
//                     path fails the row. The day's message ids are replayed under new ids (`8` before the id), so the
//                     day lands as new lines beside the copy's own past. Every line of the day must be a source: her
//                     own lines are `said` rows whatever posted them (a line of hers the record kept as `seen`, such as
//                     a diary post, is counted apart). Every line the meaning index takes (the newest revision of each
//                     message with text, chunks.js#newestRevisions) must have its vector; the older revisions of an
//                     edited message and the lines without text are counted apart, never embedded.
//   4. cutover        what row 2's `json` process held at the switch (a dirty cache entry, a queued archive append,
//                     buffered public and private lines, an in-flight turn's said line, an embedding backlog), a late
//                     edit of a line from before the switch, and the start-up catch-up delivering the boundary lines
//                     again: each in the database once, none read twice by her session.
//   5. failures       each case on a fresh copy of the state after the day: a write that committed and whose answer was
//                     lost (an observation, her session's apply, an intention, a task transition), a write lost before
//                     its commit (her session's plan, a diary post's row), a write broken off inside its transaction
//                     (the graph projection), a backup that failed, the database locked, the observation queue
//                     overflowing, a stale base (her session's compare-and-set); then a restart. Each ends with exactly
//                     one logical effect, the pending folder replayed and empty, or a failure the status shows.
//   6. ordering       duplicate deliveries, an edit before its original, a deletion before its edit, the same text twice
//                     by one author, lines across midnight, the catch-up and the gateway delivering the same lines, an
//                     affinity decay and a session apply on one person at once: one row per logical event, both moves
//                     counted.
//   7. restore        `restore-test` of row 2's backup.
//
// Storage parity is what this tool checks (fixed plans through the persistence paths); writer quality (her proposals
// against the analyzer's) is tools/memory-session.mjs compare, linked from the report.
// The report is counts, codes and ids of rows, never a text of the chat. Nothing here starts the bot, connects to
// Discord or calls a model unless `--session memory-key` (then only her memory session's requests, on the memory key).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';
import { CliError, parseFlags, privateDirOf, runCli } from './lib/cli.mjs';
import { deepMerge } from '../src/config.js';
import { onLog } from '../src/log.js';
import { openMemoryDb } from '../src/memory/db/open.js';
import { createMemoryDb } from '../src/memory/db/service.js';
import { pathClass } from '../src/memory/db/paths.js';
import { HANDOFF_KEY, applyCursorKey } from '../src/memory/db/handoff.js';
import { scopesOf } from '../src/memory/db/session.js';
import { newestClaimVersion } from '../src/memory/db/session-write.js';
import { observationOf } from '../src/memory/db/observe-event.js';
import { groupContext } from '../src/memory/db/scope.js';
import { search as dbSearch } from '../src/memory/db/recall.js';
import { graphNodeId } from '../src/memory/db/graph.js';
import { newestRevisions } from '../src/memory/chunks.js';
import { recordLayers } from '../src/memory/db/readers/record.js';
import { decayAffinity } from '../src/memory/affinity.js';
import { createAppendStore } from '../src/memory/append-store.js';
import { createRecord, toRecordLine } from '../src/memory/record.js';
import { createJournal } from '../src/memory/journal.js';
import { createArchive } from '../src/memory/archive.js';
import { createVectors } from '../src/memory/vectors.js';
import { createStore } from '../src/memory/store.js';
import { createEmbedder as createEmbedQueue } from '../src/memory/embedder.js';
import { createMemoryUpdater } from '../src/memory/update.js';
import { participationSettings, recordOwnLine } from '../src/memory/participation.js';
import { createIntentionStores } from '../src/intentions/store.js';
import { createIntentionService } from '../src/intentions/service.js';
import { createTaskStores } from '../src/errands/store.js';
import { createMessageHandler } from '../src/behavior/pipeline.js';
import { createEventDoor } from '../src/interface/door.js';
import { createDiscordInterface, normalizeOptions, toEvent } from '../src/interface/discord.js';
import { createTagHistory } from '../src/behavior/mention.js';
import { createActivity } from '../src/behavior/activity.js';
import { createCalibrator } from '../src/llm/tokens.js';
import { roleGroup } from '../src/llm/roles.js';
import { buildHeartbeatFacts } from '../src/behavior/heartbeat-view.js';
import { recordMessages } from '../src/skills/conversation-read.js';
import { memoryDbStatusLine } from '../src/ops/status.js';
import { main as memoryDbTool } from './memory-db.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const USAGE = `usage: node tools/memory-rehearsal.mjs --data <frozen copy of data/> --db <copy of memory.db> --day <YYYY-MM-DD>
       [--session fake|memory-key] [--report <file.md>] [--keep]`;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY_MS = 86_400_000;
const PRODUCTION_ROOT = '/opt/neptunia';
const DB_FILES = /^memory\.db(?:-wal|-shm|\.lock)?$/;
/** The prefix a replayed message id gets: no real message id of today's length starts with it. */
const ID_PREFIX = '8';
/** The rows, in their order. */
export const ROWS = Object.freeze([
  ['baseline', 'Baseline: reader parity over the untouched past'],
  ['switch', 'The switch protocol (spec 6.10)'],
  ['sole', 'Sole authority, memory files gone: the day replayed'],
  ['cutover', 'The cutover boundary'],
  ['failures', 'Failure injection and restart'],
  ['ordering', 'Ordering and duplicates'],
  ['restore', 'Restore of the backup'],
]);

const codeOf = (error) => error?.code ?? error?.name ?? 'ERROR';
const iso = (ms) => new Date(ms).toISOString();
const settle = async (rounds = 8) => { for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve)); };
const parse = (text) => { try { return JSON.parse(text); } catch { return null; } };
const count = (db, sql, ...params) => db.prepare(sql).get(...params)?.n ?? 0;

// ---------------------------------------------------------------- paths and copies

/** Throws when `target` (or what it resolves to) is under the production root. */
export function refuseProduction(target, what) {
  const abs = path.resolve(target);
  let real = abs;
  try { real = fs.realpathSync(abs); } catch { /* not there yet: the path itself */ }
  for (const candidate of [abs, real]) {
    if (candidate === PRODUCTION_ROOT || candidate.startsWith(`${PRODUCTION_ROOT}/`)) {
      throw new CliError(`memory-rehearsal: ${what} is under ${PRODUCTION_ROOT}; give a frozen copy`);
    }
  }
  return abs;
}

/** Every regular file under `dir`: relative paths with forward slashes, in name order. */
function filesUnder(dir, rel = '', out = []) {
  let entries = [];
  try { entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true }); } catch { return out; }
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const child = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) filesUnder(dir, child, out);
    else if (entry.isFile()) out.push(child);
  }
  return out;
}

/** A copy of a data directory without its database files. */
function copyData(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const rel of filesUnder(from)) {
    if (DB_FILES.test(rel)) continue;
    const target = path.join(to, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(from, rel), target);
  }
}

/** A consistent copy of a database (`VACUUM INTO`), read-only on the source. */
function copyDatabase(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  const handle = openMemoryDb(from, { readOnly: true });
  try {
    handle.db.exec(`VACUUM INTO '${to.replaceAll("'", "''")}'`);
  } finally {
    handle.close();
  }
}

/** A whole data directory with its database copied (`from` holds `memory.db`; the database is vacuumed). */
function cloneState(from, to) {
  copyData(from, to);
  copyDatabase(path.join(from, 'memory.db'), path.join(to, 'memory.db'));
}

/** The memory files of a data directory (paths.js), relative. */
function memoryFilesOf(dataDir) {
  return filesUnder(dataDir).filter((rel) => pathClass(rel) === 'memory');
}

/** Deletes every memory file of `dataDir` (the switch deletes the JSON memory, spec section 7); returns how many. */
function deleteMemoryFiles(dataDir) {
  let deleted = 0;
  for (const rel of memoryFilesOf(dataDir)) {
    fs.rmSync(path.join(dataDir, rel));
    deleted += 1;
  }
  return deleted;
}

/** The only guild of a data directory (the bot serves one). */
function guildOf(dataDir) {
  let names = [];
  try { names = fs.readdirSync(path.join(dataDir, 'guilds'), { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name); } catch { names = []; }
  if (names.length !== 1) throw new CliError(`memory-rehearsal: ${names.length === 0 ? 'no guild' : 'several guilds'} under ${path.join(dataDir, 'guilds')}`);
  return names[0];
}

/** The names of the private layers of a guild that hold a record or a journal. */
function privateLayers(dataDir, guildId) {
  try {
    return fs.readdirSync(path.join(dataDir, 'guilds', guildId, 'private'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------- the file watch

/**
 * Watches every file access of this thread (node:fs, its promises and the builtin ESM bindings): an access to a memory
 * path (paths.js) under one of the watched data directories is noted, a read or a write. A directory listed whose
 * children would be memory paths counts as a read. `pause()` / `resume()` around the tool's own file work.
 */
function createFileWatch() {
  const roots = new Set();
  const hits = [];
  let active = false;
  const classify = (target, dir = false) => {
    if (!active || typeof target !== 'string' && !(target instanceof URL) && !Buffer.isBuffer(target)) return null;
    const abs = path.resolve(target instanceof URL ? fileURLToPath(target) : String(target));
    for (const root of roots) {
      const rel = path.relative(root, abs).split(path.sep).join('/');
      if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) continue;
      if (pathClass(rel) === 'memory' || (dir && pathClass(`${rel}/x.json`) === 'memory' && pathClass(`${rel}/x`) === 'memory')) return rel;
    }
    return null;
  };
  const note = (op, kind, target, dir = false) => {
    const rel = classify(target, dir);
    if (rel !== null) hits.push({ op, kind, rel });
  };
  const READS = ['readFileSync', 'existsSync', 'statSync', 'lstatSync', 'openSync', 'accessSync', 'createReadStream'];
  const WRITES = ['writeFileSync', 'appendFileSync', 'mkdirSync', 'rmSync', 'unlinkSync', 'createWriteStream', 'truncateSync'];
  const PROMISE_READS = ['readFile', 'stat', 'lstat', 'open', 'access'];
  const PROMISE_WRITES = ['writeFile', 'appendFile', 'mkdir', 'rm', 'unlink', 'truncate'];
  const originals = [];
  const wrap = (holder, name, kind, { dir = false, pair = false } = {}) => {
    const original = holder[name];
    if (typeof original !== 'function') return;
    originals.push([holder, name, original]);
    holder[name] = function watched(...args) {
      const flags = name === 'openSync' || name === 'open' ? String(args[1] ?? 'r') : 'r';
      note(name, kind === 'read' && /[wa+]/.test(flags) ? 'write' : kind, args[0], dir);
      if (pair) note(name, kind, args[1], dir);
      return original.apply(this, args);
    };
  };
  function install() {
    for (const name of READS) wrap(fs, name, 'read');
    for (const name of WRITES) wrap(fs, name, 'write');
    wrap(fs, 'readdirSync', 'read', { dir: true });
    wrap(fs, 'renameSync', 'write', { pair: true });
    wrap(fs, 'copyFileSync', 'write', { pair: true });
    for (const name of PROMISE_READS) wrap(fs.promises, name, 'read');
    for (const name of PROMISE_WRITES) wrap(fs.promises, name, 'write');
    wrap(fs.promises, 'readdir', 'read', { dir: true });
    wrap(fs.promises, 'rename', 'write', { pair: true });
    wrap(fs.promises, 'copyFile', 'write', { pair: true });
    syncBuiltinESMExports();
  }
  function uninstall() {
    for (const [holder, name, original] of originals.reverse()) holder[name] = original;
    originals.length = 0;
    syncBuiltinESMExports();
  }
  return {
    install,
    uninstall,
    watch: (root) => roots.add(path.resolve(root)),
    unwatch: (root) => roots.delete(path.resolve(root)),
    pause: () => { active = false; },
    resume: () => { active = true; },
    hits,
    take: () => hits.splice(0, hits.length),
  };
}

// ---------------------------------------------------------------- logs

/** A log that keeps every warning and error (message and code) and drops the rest; `global` follows src/log.js too. */
function createLogs() {
  const entries = [];
  const add = (level) => (message, fields) => { entries.push({ level, message: String(message), code: fields?.code ?? fields?.reason ?? null, fields }); };
  const log = { info() {}, debug() {}, warn: add('warn'), error: add('error') };
  const stop = onLog((entry) => {
    if (entry.level === 'warn' || entry.level === 'error') entries.push({ level: entry.level, message: entry.msg, code: entry.code ?? entry.reason ?? entry.error?.code ?? null, fields: entry, global: true });
  });
  return { log, entries, stop, since: (n) => entries.slice(n), mark: () => entries.length };
}

/** The warnings and errors that say a write or a read did not go through (a failure the run must not hide). */
const FAILURE_RE = /failed|refused|lost|dropped|unreadable|not told|slow/;
const failuresIn = (entries) => entries.filter((entry) => FAILURE_RE.test(entry.message));
const summarize = (entries) => {
  const by = new Map();
  for (const entry of entries) {
    const key = `${entry.message}${entry.code ? ` (${entry.code})` : ''}`;
    by.set(key, (by.get(key) ?? 0) + 1);
  }
  return [...by].map(([key, n]) => `${key} x${n}`);
};

// ---------------------------------------------------------------- config

/** The rehearsal's switches over the deployment's config (see the head of this file). */
export function rehearsalConfig(base, { authority, guildId, dims = null, model = null, keyName = 'OPENROUTER_MEMORY_KEY' }) {
  const given = structuredClone(base ?? {});
  const session = given.memoryDb?.session ?? {};
  return deepMerge(given, {
    bot: { guildId, dryRunChannelId: '' },
    features: {
      memoryDb: true, record: true, journal: true, archive: true, meaningSearch: true, embedIndex: true, privateMessages: true,
      memory: true, relationships: true, participation: true, diary: true, intentions: true, offlineCatchUp: true, embedUpdates: true,
      followUp: false, spontaneous: false, eavesdrop: false, mediaDescriptions: false, videoDescriptions: false, gifs: false,
      turnPlanner: false, channelRoute: false, webLookup: false, innerLife: false, avatars: false, portraitRefresh: false,
      notesRefresh: false, memoryTwoStage: false, customEmoji: false, splitTasks: false, missedAnswers: false, missedRecovery: false,
      pauseNotice: false, imageGeneration: false, speech: false, recallTrace: false,
    },
    memoryDb: {
      authority, read: true, observeLive: true, syncSeconds: 60, backup: { enabled: false }, focus: { enabled: false },
      session: { ...session, mode: authority === 'db' ? 'apply' : 'off' },
    },
    recall: { backend: 'db' },
    llm: { keyByRole: { memory: keyName } },
    private: { minAffinity: -1000, maxPerUserPerDay: 1_000_000, maxPerOwnerPerDay: 1_000_000 },
    ...(dims ? { embed: { dimensions: dims } } : {}),
    ...(model ? { models: { [roleGroup('embedding')]: { embedding: model } } } : {}),
  });
}

// ---------------------------------------------------------------- the models

/** The batch's people (`id: <@native>`) and its numbered lines, from her session's request. */
function requestParts(messages) {
  const user = (messages ?? []).filter((message) => message?.role === 'user').map((message) => (typeof message.content === 'string' ? message.content : Array.isArray(message.content) ? message.content.map((part) => part?.text ?? '').join('\n') : '')).join('\n');
  const people = [...user.matchAll(/^id: (<@[0-9A-Za-z_:.-]+>)$/gm)].map((match) => match[1]);
  const lines = [...user.matchAll(/^(?:→ )?#(\d+) /gm)].map((match) => Number(match[1]));
  return { people, lines };
}

/**
 * Her memory session on a fixed plan: for each request one claim (`detail`) and one attitude move (+1) about the first
 * person on the page, citing the first line; nothing when the page names nobody. `marker` makes the claim's text
 * recognisable (`rehearsal plan <n>`). Every other purpose is refused: no model runs.
 */
export function createFakeModel({ planOf = null } = {}) {
  const calls = [];
  let n = 0;
  return {
    calls,
    async complete(messages, options = {}) {
      calls.push({ purpose: options.purpose ?? null, role: options.role ?? null });
      if (options.purpose !== 'memory-session') throw Object.assign(new Error('the rehearsal runs no model'), { code: 'REHEARSAL_NO_MODEL' });
      n += 1;
      const { people, lines } = requestParts(messages);
      const plan = planOf ? planOf({ people, lines, n }) : (people.length > 0 && lines.length > 0 ? {
        claims: [{ op: 'add', subject: people[0], kind: 'detail', text: `rehearsal plan ${n}`, how: 'said', sources: [`#${lines[0]}`] }],
        affinity: [{ person: people[0], delta: 1, reason: `rehearsal plan ${n}`, sources: [`#${lines[0]}`] }],
      } : {});
      return { text: `<think>-</think>\n<memory>\n${JSON.stringify(plan)}\n</memory>`, usage: { prompt_tokens: 0, completion_tokens: 0, cost: 0 } };
    },
  };
}

/** Embeddings from a hash of each text: `dims` numbers in [-1, 1], the same text the same vector. */
export function fakeEmbed(dims) {
  const size = Number.isInteger(dims) && dims > 0 ? dims : 8;
  const calls = { requests: 0, texts: 0 };
  const embed = async (texts) => {
    calls.requests += 1;
    calls.texts += texts.length;
    return texts.map((text) => {
      const out = [];
      let seed = createHash('sha256').update(String(text)).digest();
      while (out.length < size) {
        for (const byte of seed) { if (out.length < size) out.push(byte / 127.5 - 1); }
        seed = createHash('sha256').update(seed).digest();
      }
      return out;
    });
  };
  embed.calls = calls;
  return embed;
}

// ---------------------------------------------------------------- the fake Discord layer

/**
 * discord.js-shaped objects for one guild: channels, DM channels, members and messages, as the pipeline and the
 * interface's `toEvent` read them; `sent` keeps what was posted through `send` (the diary's posts).
 */
function createFakeDiscord({ guildId, selfId, selfName, names }) {
  const members = new Map();
  const channels = new Map();
  const dms = new Map();
  const guild = {
    id: guildId,
    name: 'guild',
    members: { me: { id: selfId, displayName: selfName }, cache: members, fetch: async (id) => members.get(String(id)) ?? null },
    channels: { cache: channels },
  };
  const self = { id: selfId, bot: true, username: selfName, globalName: selfName };
  const client = { user: self, guilds: { cache: new Map([[guildId, guild]]) }, channels: { cache: new Map() }, users: { cache: new Map() } };
  const sent = [];
  const nameOf = (id) => names(id) ?? 'member';
  const member = (id) => {
    const key = String(id);
    if (!members.has(key)) members.set(key, { id: key, displayName: nameOf(key), user: { id: key, bot: false, username: nameOf(key) } });
    return members.get(key);
  };
  const base = (id) => ({
    id,
    messages: { cache: new Map(), fetch: async (ref) => (typeof ref === 'string' ? null : new Map()) },
    isThread: () => false,
    isTextBased: () => true,
    viewable: true,
    permissionsFor: () => ({ has: () => true }),
    async send(payload) {
      const at = Date.now();
      const message = { id: `${ID_PREFIX}${String(at)}${sent.length}`, content: typeof payload === 'string' ? payload : payload?.content ?? '', createdTimestamp: at };
      sent.push({ channelId: id, ...message });
      return message;
    },
  });
  function channelOf(id) {
    const key = String(id);
    if (!channels.has(key)) {
      const channel = { ...base(key), type: 0, name: `channel-${key.slice(-4)}`, topic: null, parent: null, guild, guildId };
      channels.set(key, channel);
      client.channels.cache.set(key, channel);
    }
    return channels.get(key);
  }
  function dmOf(id, partnerId) {
    const key = String(id);
    if (!dms.has(key)) {
      const channel = { ...base(key), type: 1, recipientId: String(partnerId), recipient: { id: String(partnerId) }, isDMBased: () => true, guild: null, guildId: null };
      dms.set(key, channel);
      client.channels.cache.set(key, channel);
    }
    return dms.get(key);
  }
  /** A message: `{ id, authorId, at, text, channelId, dm?: partnerId, replyTo?, mentions?, editedAt? }`. */
  function messageOf(spec) {
    const own = String(spec.authorId) === String(selfId);
    const channel = spec.dm ? dmOf(spec.channelId, spec.dm) : channelOf(spec.channelId);
    if (!own) member(spec.authorId);
    const author = own ? self : { id: String(spec.authorId), bot: false, username: nameOf(spec.authorId), globalName: nameOf(spec.authorId) };
    const mentioned = new Map((spec.mentions ?? []).map((id) => [String(id), { id: String(id) }]));
    const message = {
      id: String(spec.id),
      system: false,
      webhookId: null,
      partial: false,
      type: 0,
      author,
      member: spec.dm ? null : (own ? guild.members.me : member(spec.authorId)),
      guild: spec.dm ? null : guild,
      guildId: spec.dm ? null : guildId,
      channel,
      channelId: channel.id,
      content: spec.text ?? '',
      cleanContent: spec.text ?? '',
      createdTimestamp: spec.at,
      editedTimestamp: spec.editedAt ?? null,
      reference: spec.replyTo ? { messageId: String(spec.replyTo) } : null,
      mentions: { users: mentioned, roles: new Map(), channels: new Map(), everyone: false, has: (id) => mentioned.has(String(id)) },
      attachments: new Map(),
      stickers: new Map(),
      embeds: [],
      reactions: { cache: new Map() },
    };
    channel.messages.cache.set(message.id, message);
    return message;
  }
  return { client, guild, channelOf, dmOf, messageOf, member, sent };
}

// ---------------------------------------------------------------- the core, wired as src/index.js wires it

/**
 * One process of the core over `dataDir`: the memory modules, the analyzer and the message pipeline behind the event
 * door. `hot` is `{ config, prompts }`; `clock` is `{ at }` (every module's `now`). `service` replaces the memory
 * service (the failure rows wrap it); `open` is the service's opener (the failure rows give it a handle that fails).
 */
function wireCore({ dataDir, hot, clock, logs, llm, sessionLlm, sessionEnv, embed, selfId, selfName, guildId, names, worker = true, open = undefined, onSessionFailure = null }) {
  const now = () => clock.at;
  const log = logs.log;
  let ids = 0;
  const uuid = () => `rh-${clock.at}-${(ids += 1)}`;
  const serviceOptions = {
    hot, dataDir, log, now,
    embed: (texts, options) => embed(texts, options),
    selfName: () => selfName,
    sessionLlm: () => sessionLlm,
    sessionEnv: () => sessionEnv,
    onSessionFailure: (failure) => onSessionFailure?.(failure),
    ...(open ? { open, worker: false } : { worker }),
  };
  const memoryDb = createMemoryDb(serviceOptions);
  const appendStore = createAppendStore({ fsyncMs: 500, retryMax: 1000, log, now });
  const recordAppendStore = createAppendStore({ fsyncMs: 500, retryMax: 1000, log, now });
  const archiveAppendStore = createAppendStore({ fsyncMs: 500, retryMax: 1000, log, now });
  let journal = null;
  const recordWriter = createRecord({ appendStore: recordAppendStore, dataDir, log, now, uuid, writerGate: () => journal.waitUnlocked(), memoryDb });
  const vectors = createVectors({ dataDir, log, now, writerGate: () => journal.waitUnlocked(), memoryDb });
  let embedQueue = null;
  const record = {
    ...recordWriter,
    async append(g, lines, opts) {
      const result = await recordWriter.append(g, lines, opts);
      if (embedQueue && result?.written > 0) {
        try { embedQueue.enqueue(g, lines, opts ?? {}); } catch (error) { log.warn('index: embed enqueue failed', { code: codeOf(error) }); }
      }
      return result;
    },
  };
  const archive = createArchive({ appendStore: archiveAppendStore, dataDir, log, now, uuid, writerGate: () => journal.waitUnlocked(), memoryDb });
  journal = createJournal({ appendStore, dataDir, config: () => hot.config.journal ?? {}, now, uuid, log, lockStores: [recordAppendStore, archiveAppendStore], memoryDb });
  const store = createStore({
    dataDir, newId: uuid, memoryRead: memoryDb.reader, afterFlush: () => memoryDb.requestSync(), record,
    recordOn: () => hot.config.features?.record === true, archive, archiveOn: () => hot.config.features?.archive === true, vectors, memoryDb,
  });
  const calibrator = createCalibrator(undefined);
  embedQueue = createEmbedQueue({
    hot, vectors, embed: (texts, options) => embed(texts, options), record: recordWriter, dataDir, log, now,
    nameOf: (g, userId) => names(userId), selfName: () => selfName, paused: () => store.state.data.paused === true, memoryDb,
  });
  const taskStores = createTaskStores({ dataDir, config: () => hot.config, journal, now, log, memoryDb });
  const intentionStores = createIntentionStores({ dataDir, now, log, memoryDb });
  const intentions = createIntentionService({ stores: intentionStores, hot, journal, getGuildId: () => guildId, now, uuid, log });
  const memory = createMemoryUpdater({
    hot, store, llm, calibrator, getSelfName: () => selfName, journal, record, archive, now, uuid,
    authority: () => memoryDb.authority(),
  });
  const discordFake = createFakeDiscord({ guildId, selfId, selfName, names });
  const turnsCalls = [];
  const turns = {
    notePost() {},
    runTurn: async (args) => { turnsCalls.push(args?.mode ?? null); return { outcome: 'skip' }; },
    isBusy: () => false,
    isAnyBusy: () => false,
    lastPostAt: () => 0,
  };
  const timers = { set: (fn, ms) => { const timer = setTimeout(fn, ms); timer.unref?.(); return timer; }, clear: (timer) => clearTimeout(timer) };
  const onMessage = createMessageHandler({
    hot, store, client: discordFake.client, discord: createDiscordInterface().capabilities, turns, spontaneous: { onMessage: () => false },
    memory, tagHistory: createTagHistory(), getGuildId: () => guildId, getSelfName: () => selfName, isWarmingUp: () => false,
    describer: null, llm, lookup: null, now, timers, activity: createActivity(), record, missed: null, memoryDb,
  });
  const door = createEventDoor({
    handlers: {
      'message.received': (event) => {
        if (event.deleted) return onMessage.onMessageDelete(event);
        return event.edit ? onMessage.onMessageUpdate(event) : onMessage(event);
      },
    },
    log,
  });
  const options = () => normalizeOptions(hot.config);
  const events = {
    message: (message) => toEvent(message, selfId, { ...options(), now }),
    edit: (message, previous) => toEvent(message, selfId, { ...options(), edit: true, previous, now }),
    deletion: (message) => toEvent(message, selfId, { deleted: true, now }),
  };

  /** The periodic work of src/index.js at one tick (the store's flush, the database's tick, the module stores, the embeddings). */
  async function tick() {
    store.flush();
    await memoryDb.tick();
    await memoryDb.waitSession();
    await Promise.all([intentionStores.flush(), taskStores.flush()]);
    await embedQueue.tick(guildId);
  }

  /** The shutdown of src/index.js, in its order (once). */
  let stopped = null;
  function shutdown() {
    stopped ??= stop();
    return stopped;
  }
  async function stop() {
    onMessage.stop();
    await embedQueue.close().catch((error) => log.warn('index: embed queue close failed', { code: codeOf(error) }));
    await store.flushSettled({ holdMaxMs: hot.config.archive?.holdMaxMs ?? 5000, final: true });
    await appendStore.close().catch(() => {});
    await recordAppendStore.close().catch(() => {});
    await archiveAppendStore.close().catch(() => {});
    await intentionStores.flush({ final: true }).catch((error) => log.warn('index: intentions flush failed', { code: codeOf(error) }));
    await taskStores.flush({ final: true }).catch((error) => log.warn('index: tasks flush failed', { code: codeOf(error) }));
    await memoryDb.close().catch((error) => log.warn('index: memory db close failed', { code: codeOf(error) }));
  }

  return {
    hot, clock, memoryDb, record, recordWriter, vectors, archive, journal, store, embedQueue, taskStores, intentionStores, intentions,
    memory, onMessage, door, events, discord: discordFake, turnsCalls, tick, shutdown, llm,
    stores: { appendStore, recordAppendStore, archiveAppendStore },
  };
}

// ---------------------------------------------------------------- the day's script

/** The message ids a record line names (its message, its reply, its sources). */
function lineIds(line) {
  return [line?.messageId, line?.replyTo, ...(Array.isArray(line?.sourceMessageIds) ? line.sourceMessageIds : [])].filter((id) => typeof id === 'string' && id);
}

/** Every string of `value` that `map` holds replaced (deep, a copy). */
function mapDeep(value, map) {
  if (typeof value === 'string') return map.get(value) ?? value;
  if (Array.isArray(value)) return value.map((item) => mapDeep(item, map));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, mapDeep(item, map)]));
  return value;
}

/**
 * The day `day` of a data directory as a script: the record lines of the guild and of every private layer and the
 * journal records of both, read by the engine's own readers (authority `json`), in arrival order (`recordedAt`, then
 * file order), and the diary posts of the day. Message ids whose first line is in the day get new ids (`8` + id);
 * turn and operation ids a suffix. Returns `{ events, ids, posts, counts }`.
 */
async function readDay({ dataDir, guildId, day, log }) {
  const from = `${day}T00:00:00.000Z`;
  const to = `${day}T23:59:59.999Z`;
  const appendStore = createAppendStore({ log });
  const record = createRecord({ appendStore, dataDir, log, authorityOf: () => 'json' });
  const journal = createJournal({ appendStore, dataDir, log, authorityOf: () => 'json' });
  const layers = [null, ...privateLayers(dataDir, guildId)];
  const lines = [];
  const records = [];
  let order = 0;
  for (const layer of layers) {
    for await (const line of record.iterate(guildId, { from, to, privateUserId: layer })) lines.push({ line, layer, order: (order += 1) });
    for (const entry of await journal.read(guildId, { day, n: Number.MAX_SAFE_INTEGER, privateUserId: layer })) records.push({ record: entry, layer, order: (order += 1) });
  }
  await appendStore.close();
  const ids = new Map();
  for (const { line } of lines) {
    if ((line.kind === 'seen' || line.kind === 'said') && (line.revision ?? 1) === 1 && typeof line.messageId === 'string' && /^\d{1,19}$/.test(line.messageId)) {
      ids.set(line.messageId, `${ID_PREFIX}${line.messageId}`);
    }
  }
  const turnIds = new Map();
  const suffix = (id) => `${id}~rh`;
  for (const { record: entry } of records) {
    for (const key of ['turnId', 'opId', 'batchId']) if (typeof entry[key] === 'string' && entry[key]) turnIds.set(entry[key], suffix(entry[key]));
    for (const posted of Array.isArray(entry.posted) ? entry.posted : []) if (typeof posted?.opId === 'string') turnIds.set(posted.opId, suffix(posted.opId));
  }
  for (const { line } of lines) for (const key of ['turnId', 'opId']) if (typeof line[key] === 'string' && line[key]) turnIds.set(line[key], suffix(line[key]));
  const all = new Map([...ids, ...turnIds]);
  const at = (value, fallback) => { const ms = Date.parse(value); return Number.isFinite(ms) ? ms : fallback; };
  const events = [
    ...lines.map(({ line, layer, order: n }) => ({ type: 'line', at: at(line.recordedAt, at(line.occurredAt, 0)), order: n, layer, line: mapDeep(line, all), original: line })),
    ...records.map(({ record: entry, layer, order: n }) => ({ type: 'journal', at: at(entry.recordedAt, at(entry.occurredAt, 0)), order: n, layer, record: mapDeep(entry, all) })),
  ].sort((a, b) => a.at - b.at || a.order - b.order);
  let diary = null;
  try { diary = JSON.parse(fs.readFileSync(path.join(dataDir, 'guilds', guildId, 'diary.json'), 'utf8')); } catch { diary = null; }
  const dayStart = Date.parse(from);
  const posts = (Array.isArray(diary?.posts) ? diary.posts : []).filter((post) => Number.isFinite(post?.at) && post.at >= dayStart && post.at < dayStart + DAY_MS)
    .map((post) => ({ ...structuredClone(post), messageIds: (post.messageIds ?? []).map((id) => `${ID_PREFIX}${id}`) }));
  for (const post of posts) events.push({ type: 'diary', at: post.at, order: 0, post });
  events.sort((a, b) => a.at - b.at || a.order - b.order);
  const kinds = {};
  for (const { line } of lines) kinds[line.kind] = (kinds[line.kind] ?? 0) + 1;
  const journalKinds = {};
  for (const { record: entry } of records) journalKinds[entry.kind] = (journalKinds[entry.kind] ?? 0) + 1;
  return { events, ids, posts, counts: { lines: lines.length, kinds, journal: records.length, journalKinds, posts: posts.length, layers: layers.length - 1 } };
}

/** The journal records the day replays, by kind (the analyzer's `memory` records retire with its memory path). */
const JOURNAL_REPLAY = new Set(['turn.start', 'turn', 'action', 'system', 'answer', 'inner']);
const ENVELOPE = new Set(['v', 'id', 'kind', 'occurredAt', 'recordedAt', 'guildId', 'scope', 'participants', 'sourceMessageIds', 'origin']);

/**
 * Replays the script through `core`: each event at its arrival time on the clock, the core's tick once a simulated
 * minute between them. Returns what it delivered and what it skipped, by kind.
 */
async function replayDay(core, script, { guildId, selfId, selfName, names, onTick = null }) {
  const out = { delivered: {}, skipped: {}, statuses: {}, said: 0, participation: 0, posts: 0, journal: {} };
  const bump = (slot, key) => { slot[key] = (slot[key] ?? 0) + 1; };
  const lastText = new Map();
  const channelLines = new Map();
  let lastTick = -Infinity;
  const deliver = async (event) => {
    const answer = await core.door.submit(event);
    bump(out.statuses, answer.status);
    return answer;
  };
  for (const event of script.events) {
    if (event.at - lastTick >= MINUTE) {
      core.clock.at = Math.max(core.clock.at, event.at);
      await core.tick();
      await onTick?.();
      lastTick = event.at;
    }
    core.clock.at = Math.max(core.clock.at, event.at);
    if (event.type === 'diary') {
      const channelId = core.hot.config.diary?.channelId;
      if (typeof channelId === 'string' && channelId) await core.discord.channelOf(channelId).send({ content: '-' });
      core.store.appendDiaryPost(guildId, event.post, { max: core.hot.config.diary?.historyPosts ?? 150, now: event.at });
      out.posts += 1;
      continue;
    }
    if (event.type === 'journal') {
      const entry = event.record;
      if (!JOURNAL_REPLAY.has(entry.kind)) { bump(out.skipped, `journal:${entry.kind}`); continue; }
      const fields = Object.fromEntries(Object.entries(entry).filter(([key]) => !ENVELOPE.has(key)));
      const common = { channelId: entry.scope?.channel ?? null, privateUserId: event.layer, participants: entry.participants, sourceMessageIds: entry.sourceMessageIds };
      if (entry.kind === 'turn.start') core.journal.start(guildId, { ...common, mode: fields.mode ?? null, trigger: fields.trigger ?? null, turnId: fields.turnId, attemptId: fields.attemptId });
      else if (entry.kind === 'turn') await core.journal.turn(guildId, { ...fields, ...common, occurredAt: entry.occurredAt });
      else await core.journal[entry.kind](guildId, { ...fields, ...common, occurredAt: entry.occurredAt });
      bump(out.journal, entry.kind);
      continue;
    }
    const { line, layer } = event;
    const channelId = line.scope?.channel ?? null;
    const ts = Date.parse(line.occurredAt);
    const dm = layer ? String(layer) : null;
    if (!channelId || !Number.isFinite(ts)) { bump(out.skipped, `line:${line.kind}:no-place`); continue; }
    if (line.kind === 'felt') { bump(out.skipped, 'line:felt'); continue; }
    if (line.kind === 'seen') {
      const spec = { id: line.messageId, authorId: line.by, at: ts, text: line.text ?? '', channelId, dm, replyTo: line.replyTo, mentions: line.mentions };
      if ((line.revision ?? 1) <= 1) {
        await deliver(core.events.message(core.discord.messageOf(spec)));
        bump(out.delivered, 'seen');
        if (!dm) {
          const list = channelLines.get(channelId) ?? [];
          list.push({ id: line.messageId, ts, authorId: line.by, name: names(line.by) ?? 'member', self: false, text: line.text ?? '', replyTo: line.replyTo ?? null });
          channelLines.set(channelId, list.slice(-20));
        }
      } else {
        const previous = core.discord.messageOf({ ...spec, text: lastText.get(line.messageId) ?? '' });
        const edited = core.discord.messageOf({ ...spec, editedAt: Date.parse(line.recordedAt) || ts });
        await deliver(core.events.edit(edited, previous));
        bump(out.delivered, 'edit');
      }
      lastText.set(line.messageId, line.text ?? '');
      continue;
    }
    if (line.kind === 'deleted') {
      await deliver(core.events.deletion(core.discord.messageOf({ id: line.messageId, authorId: line.by ?? selfId, at: ts, text: lastText.get(line.messageId) ?? '', channelId, dm })));
      bump(out.delivered, 'deleted');
      continue;
    }
    if (line.kind === 'said') {
      // As the turn writes it: the record's said line (with its turn and operation), then the gateway's echo of her post.
      const slim = { id: line.messageId, channelId, authorId: selfId, ts, content: line.text ?? '', replyToId: line.replyTo ?? null, replyToAuthorId: line.replyAuthor ?? null, mentionedUserIds: line.mentions ?? [] };
      await core.record.append(guildId, [toRecordLine(slim, { kind: 'said', now: () => core.clock.at, turnId: line.turnId ?? null, opId: line.opId ?? null })], dm ? { privateUserId: dm } : undefined);
      await deliver(core.events.message(core.discord.messageOf({ id: line.messageId, authorId: selfId, at: ts, text: line.text ?? '', channelId, dm, replyTo: line.replyTo })));
      bump(out.delivered, 'said');
      out.said += 1;
      if (!dm) {
        const before = channelLines.get(channelId) ?? [];
        const state = recordOwnLine(core.store.getParticipation(guildId), {
          channelId, own: { id: line.messageId, ts, authorId: selfId, name: selfName, self: true, text: line.text ?? '', replyTo: line.replyTo ?? null }, before,
        }, participationSettings(core.hot.config), core.clock.at);
        core.store.setParticipation(guildId, state, { now: core.clock.at });
        out.participation += 1;
      }
      continue;
    }
    bump(out.skipped, `line:${line.kind}`);
  }
  return out;
}

// ---------------------------------------------------------------- checks over a database

/** The handle of a service (its read connection), or a read-only connection of the file. */
function readOf(core) {
  return core.memoryDb.readHandle();
}

/**
 * The day's replayed lines against the sources: missing ones, duplicated ones, ones outside a record unit. A line of
 * hers (`said`, or a `seen` line whose author is she: one the record kept from the gateway because no turn wrote it,
 * such as a diary post) is her `said` row in the database, which writes every line of hers as said (observe-event.js);
 * the `seen` ones are counted apart (`own`). A missing line is named with what the database holds of its message
 * instead (`other kinds`: its rows of another kind or revision, or `no row`).
 */
function linesAsSources(db, script, selfId) {
  const missing = [];
  const duplicated = [];
  const ownerless = [];
  let checked = 0;
  let own = 0;
  const lineRows = db.prepare("SELECT COUNT(*) AS n, SUM(CASE WHEN owner_file GLOB '*/record/*' THEN 1 ELSE 0 END) AS owned FROM sources WHERE native_id = ? AND kind = ? AND revision = ? AND retired_at IS NULL");
  const deleted = db.prepare("SELECT COUNT(*) AS n, SUM(CASE WHEN owner_file GLOB '*/record/*' THEN 1 ELSE 0 END) AS owned FROM sources WHERE native_id = ? AND kind = 'deleted' AND retired_at IS NULL");
  const held = db.prepare('SELECT kind, revision FROM sources WHERE native_id = ? AND retired_at IS NULL ORDER BY kind, revision');
  for (const event of script.events) {
    if (event.type !== 'line') continue;
    const { line } = event;
    if (!['seen', 'said', 'deleted'].includes(line.kind) || !line.messageId) continue;
    if (!line.messageId.startsWith(ID_PREFIX)) continue;
    checked += 1;
    const hers = line.kind === 'seen' && selfId !== null && String(line.by ?? '') === String(selfId) && (line.revision ?? 1) === 1;
    if (hers) own += 1;
    const kind = hers ? 'said' : line.kind;
    const row = kind === 'deleted' ? deleted.get(line.messageId) : lineRows.get(line.messageId, kind, line.revision ?? 1);
    const n = row?.n ?? 0;
    const name = `${line.kind}:${line.messageId}:${line.revision ?? 1}`;
    if (n === 0) {
      const other = held.all(line.messageId).map((entry) => `${entry.kind}${entry.revision ? `/${entry.revision}` : ''}`);
      missing.push(`${name} (${other.length ? `other kinds ${other.join(' ')}` : 'no row'})`);
    } else if (n > 1) duplicated.push(name);
    if (n > 0 && (row?.owned ?? 0) === 0) ownerless.push(`${line.kind}:${line.messageId}`);
  }
  return { checked, missing, duplicated, ownerless, own };
}

/**
 * The meaning index over the day's replayed lines, as the embedder takes them (chunks.js#newestRevisions over the
 * record the core reads): `wanted` (each message's newest revision with text), `indexed` (those with a live vector),
 * `backlog` (wanted, no vector: the drain did not reach them), and apart the rows the index never embeds: `superseded`
 * (an older revision of an edited message) and `textless` (no text, only media). `rows` is every seen and said row.
 */
async function embeddingsOfDay(core, db, { guildId, day }) {
  const from = `${day}T00:00:00.000Z`;
  const to = `${day}T23:59:59.999Z`;
  const layers = [null, ...recordLayers(db, guildId)];
  const lines = [];
  for (const layer of layers) {
    for await (const line of core.record.iterate(guildId, { from, to, privateUserId: layer })) {
      if ((line.kind === 'seen' || line.kind === 'said') && String(line.messageId ?? '').startsWith(ID_PREFIX)) lines.push(line);
    }
  }
  const wanted = newestRevisions(lines);
  const vector = db.prepare('SELECT COUNT(*) AS n FROM vectors v JOIN sources s ON s.rowid = v.source_rowid WHERE v.retired_at IS NULL AND s.native_id = ? AND s.revision = ?');
  const backlog = wanted.filter((line) => vector.get(line.messageId, line.revision ?? 1).n === 0);
  const textless = lines.filter((line) => typeof line.text !== 'string' || line.text.trim() === '').length;
  return { rows: lines.length, wanted: wanted.length, indexed: wanted.length - backlog.length, backlog, superseded: lines.length - textless - wanted.length, textless };
}

/** Her session's cursor of every scope against the scope's newest line. */
function cursorsAtEnd(db) {
  const behind = [];
  const scopes = scopesOf(db);
  for (const scope of scopes) {
    const cursor = Number(db.prepare('SELECT value FROM meta WHERE key = ?').get(applyCursorKey(scope.key))?.value ?? 0);
    const where = scope.scope.scope_kind === 'dm'
      ? { sql: 'scope_kind = ? AND scope_iface = ? AND scope_dm = ?', params: [scope.scope.scope_kind, scope.scope.scope_iface, scope.scope.scope_dm] }
      : { sql: 'scope_kind = ? AND scope_iface = ?', params: [scope.scope.scope_kind, scope.scope.scope_iface] };
    const newest = db.prepare(`SELECT MAX(rowid) AS n FROM sources WHERE kind IN ('seen', 'said') AND retired_at IS NULL AND ${where.sql}`).get(...where.params)?.n ?? 0;
    const skipped = db.prepare("SELECT value FROM meta WHERE key = ?").get(`memory_session.pending.apply.${scope.key}`)?.value ?? null;
    if (cursor < newest) behind.push({ scope: scope.key.split(':')[0], left: count(db, `SELECT COUNT(*) AS n FROM sources WHERE kind IN ('seen', 'said') AND retired_at IS NULL AND rowid > ? AND ${where.sql}`, cursor, ...where.params), pending: skipped !== null });
  }
  return { scopes: scopes.length, behind };
}

/** References that do not resolve: claim, version and episode sources, vectors, publications of diary mirrors. */
function danglingRefs(db) {
  const has = (table) => db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !== undefined;
  const out = {};
  out.claimSources = count(db, 'SELECT COUNT(*) AS n FROM claim_sources cs LEFT JOIN sources s ON s.id = cs.source_id LEFT JOIN claims c ON c.id = cs.claim_id WHERE s.id IS NULL OR c.id IS NULL');
  out.episodeSources = count(db, 'SELECT COUNT(*) AS n FROM episode_sources es LEFT JOIN sources s ON s.id = es.source_id LEFT JOIN episodes e ON e.id = es.episode_id WHERE (s.id IS NULL OR e.id IS NULL) AND es.retired_at IS NULL');
  if (has('claim_version_sources')) out.versionSources = count(db, 'SELECT COUNT(*) AS n FROM claim_version_sources v LEFT JOIN sources s ON s.id = v.source_id LEFT JOIN claim_versions c ON c.id = v.version_id WHERE s.id IS NULL OR c.id IS NULL');
  out.vectors = count(db, 'SELECT COUNT(*) AS n FROM vectors v LEFT JOIN sources s ON s.rowid = v.source_rowid WHERE v.retired_at IS NULL AND v.source_rowid IS NOT NULL AND s.rowid IS NULL');
  if (has('diary_mirrors') && has('publications')) out.mirrors = count(db, 'SELECT COUNT(*) AS n FROM diary_mirrors m JOIN diary d ON d.id = m.diary_id LEFT JOIN publications p ON p.id = m.id WHERE d.retired_at IS NULL AND p.id IS NULL');
  out.affinityPeople = count(db, 'SELECT COUNT(*) AS n FROM affinity_events a LEFT JOIN people p ON p.id = a.person_id WHERE p.id IS NULL');
  return out;
}

const sumOf = (refs) => Object.values(refs).reduce((n, value) => n + value, 0);
const newRefs = (before, after) => Object.fromEntries(Object.entries(after).map(([key, value]) => [key, Math.max(0, value - (before[key] ?? 0))]).filter(([, value]) => value > 0));

/** Watermarks of a database: the newest source rowid and time, the rows of the main tables. */
function watermarks(db) {
  const tables = ['sources', 'claims', 'claim_versions', 'episodes', 'affinity_events', 'day', 'decisions', 'diary', 'vectors', 'intentions', 'work', 'work_events', 'publications'];
  const rows = {};
  for (const table of tables) {
    try { rows[table] = count(db, `SELECT COUNT(*) AS n FROM "${table}" WHERE retired_at IS NULL`); } catch { try { rows[table] = count(db, `SELECT COUNT(*) AS n FROM "${table}"`); } catch { rows[table] = null; } }
  }
  const newest = db.prepare('SELECT MAX(rowid) AS rowid, MAX(occurred_at) AS at FROM sources').get();
  return { rowid: newest?.rowid ?? 0, at: newest?.at ?? null, rows };
}

/** Every consumer's reads over a core under `db`, each caught; returns `{ ok, failed: [{ name, code }], numbers }`. */
async function runConsumers(core, { guildId, day, selfId }) {
  const failed = [];
  const numbers = {};
  const from = Date.parse(`${day}T00:00:00.000Z`);
  const to = from + DAY_MS - 1;
  const at = core.clock.at;
  const attempt = async (name, fn) => {
    try {
      numbers[name] = await fn();
    } catch (error) {
      failed.push({ name, code: codeOf(error) });
    }
  };
  const collect = async (iterable) => { const out = []; for await (const value of iterable) out.push(value); return out; };
  await attempt('record.iterate', async () => (await collect(core.record.iterate(guildId, { from: iso(from), to: iso(to) }))).length);
  await attempt('journal.read', async () => (await core.journal.read(guildId, { day, n: Number.MAX_SAFE_INTEGER })).length);
  await attempt('journal.timeline', async () => (await core.journal.timeline(guildId, { from })).length);
  await attempt('archive.iterate', async () => (await collect(core.archive.iterate(guildId, {}))).length);
  await attempt('vectors.stats', async () => (await core.vectors.stats(guildId)).rows ?? 0);
  await attempt('heartbeat view', async () => {
    const facts = await buildHeartbeatFacts({
      guildId, now: at, since: from, profiles: core.store.listUserProfiles(guildId), selfId, record: core.record, journal: core.journal,
      intentions: core.intentions.list(guildId), tasks: core.taskStores.get(guildId).recent(100), diary: core.store.getDiary(guildId).posts ?? [],
      log: { warn: (message, fields) => failed.push({ name: `heartbeat view: ${message}${fields?.source ? ` (${fields.source})` : ''}`, code: fields?.code ?? 'WARN' }) },
    });
    return Object.keys(facts ?? {}).length;
  });
  await attempt('inner (record reads)', async () => (await collect(core.record.iterate(guildId, { from: iso(from) }))).filter((line) => line.kind === 'said' || line.kind === 'seen').length);
  await attempt('missed (journal answers)', async () => (await core.journal.read(guildId, { day, kind: 'answer', n: Number.MAX_SAFE_INTEGER })).length);
  await attempt('intentions service', async () => {
    await core.intentions.reconcile(guildId);
    // Every record the store holds, closed and private ones too (a read of fewer would hide some).
    const read = core.intentions.list(guildId, { closed: true, all: true }).length;
    const held = core.intentionStores.get(guildId).list().length;
    if (read !== held) throw Object.assign(new Error('the service reads fewer'), { code: `READ_${read}_OF_${held}` });
    return read;
  });
  await attempt('tasks', async () => core.taskStores.get(guildId).recent(100).length);
  await attempt('status', async () => {
    const state = core.memoryDb.status();
    if (!state.open) throw Object.assign(new Error('closed'), { code: 'DB_CLOSED' });
    memoryDbStatusLine(state, core.hot.prompts?.labels ?? {}, at);
    return state.rows ?? 0;
  });
  await attempt('conversation read', async () => {
    let total = 0;
    const channels = new Set();
    for await (const line of core.record.iterate(guildId, { from: iso(from), to: iso(to) })) if (typeof line?.scope?.channel === 'string') channels.add(line.scope.channel);
    for (const channelId of [...channels].slice(0, 5)) total += (await recordMessages(core.record, guildId, { channelId, from })).length;
    return total;
  });
  await attempt('recall (database)', async () => {
    const db = core.memoryDb.database();
    if (!db) throw Object.assign(new Error('closed'), { code: 'DB_CLOSED' });
    const word = db.prepare("SELECT text FROM sources WHERE kind = 'seen' AND text IS NOT NULL AND length(text) > 3 AND retired_at IS NULL ORDER BY rowid DESC LIMIT 1").get()?.text?.split(/\s+/).find((part) => part.length > 3) ?? 'rehearsal';
    const found = dbSearch(db, { ctx: groupContext('discord'), plan: { forms: [word], from, to }, now: at });
    return found.hits.length;
  });
  await attempt('profiles', async () => {
    const profiles = core.store.listUserProfiles(guildId);
    for (const profile of profiles.slice(0, 20)) core.store.getUser(guildId, profile.id);
    core.store.getGuild(guildId);
    core.store.listChannels(guildId);
    core.store.getLore(guildId);
    return profiles.length;
  });
  return { ok: failed.length === 0, failed, numbers };
}

// ---------------------------------------------------------------- the report

/** One row: `{ key, title, pass, numbers: [string], notes: [string] }`. */
function rowOf(key, pass, numbers = [], notes = []) {
  const title = ROWS.find(([name]) => name === key)?.[1] ?? key;
  return { key, title, pass: Boolean(pass), numbers, notes };
}

/** The report in Markdown. */
export function reportOf({ rows, meta }) {
  const lines = ['# Memory writer switch: rehearsal', ''];
  lines.push(`- day replayed: ${meta.day}; session: ${meta.session}; engine: ${meta.commit ?? 'unknown'}; run at ${meta.at}`);
  lines.push(`- verdict: ${rows.every((row) => row.pass) ? 'every row PASS' : `${rows.filter((row) => !row.pass).length} row(s) FAIL`}`);
  lines.push('- writer quality (her proposals against the analyzer\'s) is not this tool: `node tools/memory-session.mjs compare --db <copy> --day <day>`');
  lines.push('', '| # | Row | Result |', '|---|---|---|');
  rows.forEach((row, i) => lines.push(`| ${i + 1} | ${row.title} | ${row.pass ? 'PASS' : 'FAIL'} |`));
  rows.forEach((row, i) => {
    lines.push('', `## ${i + 1}. ${row.title}: ${row.pass ? 'PASS' : 'FAIL'}`, '');
    for (const number of row.numbers) lines.push(`- ${number}`);
    for (const note of row.notes) lines.push(`- note: ${note}`);
  });
  return `${lines.join('\n')}\n`;
}

/** The output lines of a memory-db.mjs command, with its exit code. */
async function tool(argv) {
  const lines = [];
  const code = await memoryDbTool(argv, { out: (line) => lines.push(line), err: (line) => lines.push(line) });
  return { code, lines };
}

const lastLine = (result) => result.lines.at(-1) ?? '';

// ---------------------------------------------------------------- the rows

/**
 * The rehearsal (see the head of this file).
 * @param {{ data: string, db: string, day: string, session?: 'fake'|'memory-key', base: { config: object, prompts: object },
 *   env?: object, sessionLlm?: object|null, root?: string|null, keep?: boolean, worker?: boolean,
 *   faults?: { dropLine?: boolean } }} options
 *   `base` is the deployment's config and prompts; `sessionLlm` her session's client for `memory-key` (`fake`: the fixed
 *   plans); `faults.dropLine` (the tool's own test) makes the writer drop one line of the day.
 * @returns {Promise<{ rows: object[], report: string, root: string }>}
 */
export async function rehearse({ data, db, day, session = 'fake', base, env = {}, sessionLlm = null, root = null, keep = false, worker = true, faults = {}, commit = null }) {
  if (!DAY_RE.test(day) || !Number.isFinite(Date.parse(`${day}T00:00:00.000Z`))) throw new CliError(`memory-rehearsal: --day is a date, YYYY-MM-DD\n${USAGE}`);
  const dataPath = refuseProduction(data, '--data');
  const dbPath = refuseProduction(db, '--db');
  if (!fs.existsSync(path.join(dataPath, 'guilds'))) throw new CliError(`memory-rehearsal: no guilds folder under ${dataPath}`);
  if (!fs.existsSync(dbPath)) throw new CliError(`memory-rehearsal: no database at ${dbPath}`);
  const work = root ?? fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'memory-rehearsal-'));
  const logs = createLogs();
  const watch = createFileWatch();
  const rows = new Map();
  const startedAt = Date.now();
  watch.install();
  try {
    // ---- the copies
    const pristine = path.join(work, 'pristine');
    const live = path.join(work, 'live');
    copyData(dataPath, pristine);
    copyDatabase(dbPath, path.join(pristine, 'memory.db'));
    const guildId = guildOf(pristine);
    copyData(pristine, live);
    copyDatabase(path.join(pristine, 'memory.db'), path.join(live, 'memory.db'));
    const liveDb = path.join(live, 'memory.db');

    // The names and her own id, from the database.
    const facts = (() => {
      const handle = openMemoryDb(liveDb, { readOnly: true });
      try {
        const names = new Map();
        for (const row of handle.db.prepare("SELECT native_id, names FROM accounts WHERE iface = 'discord' AND native_id IS NOT NULL").all()) {
          const list = parse(row.names);
          if (Array.isArray(list) && typeof list[0] === 'string' && list[0]) names.set(String(row.native_id), list[0]);
        }
        let self = null;
        try { self = handle.db.prepare("SELECT native_id FROM accounts WHERE kind = 'self' AND native_id IS NOT NULL LIMIT 1").get()?.native_id ?? null; } catch { self = null; }
        if (!self) self = handle.db.prepare("SELECT a.native_id AS id FROM sources s JOIN accounts a ON a.id = s.author_account WHERE s.kind = 'said' LIMIT 1").get()?.id ?? null;
        // The meaning index's newest month: its dimensions and model are the fake embedder's (a month refuses another).
        let dims = null;
        let model = null;
        try {
          for (const row of handle.db.prepare("SELECT value FROM operational WHERE kind = 'vectors' AND retired_at IS NULL ORDER BY owner DESC").all()) {
            const manifest = parse(row.value)?.manifest;
            if (Number.isInteger(manifest?.dims) && manifest.dims > 0) { dims = manifest.dims; model = typeof manifest.model === 'string' ? manifest.model : null; break; }
          }
        } catch { dims = null; }
        return { names, self: self ? String(self) : '100000000000000009', dims, model };
      } finally { handle.close(); }
    })();
    const names = (id) => facts.names.get(String(id)) ?? null;
    const selfName = names(facts.self) ?? 'self';
    const embed = fakeEmbed(facts.dims ?? base.config?.embed?.dimensions ?? 8);
    const keyName = base.config?.llm?.keyByRole?.memory ?? 'OPENROUTER_MEMORY_KEY';
    const fakeModel = createFakeModel();
    const herLlm = session === 'fake' ? fakeModel : sessionLlm;
    const herEnv = session === 'fake' ? { [keyName]: 'rehearsal' } : env;
    const coreLlm = createFakeModel({ planOf: () => ({}) });
    const hotOf = (authority) => ({ config: rehearsalConfig(base.config, { authority, guildId, dims: facts.dims, model: facts.model, keyName }), prompts: base.prompts });
    const coreOf = (dataDir, authority, clock, extra = {}) => wireCore({
      dataDir, hot: hotOf(authority), clock, logs, llm: coreLlm, sessionLlm: herLlm, sessionEnv: herEnv, embed, selfId: facts.self, selfName, guildId, names, worker, ...extra,
    });

    // ---- the day's script, from the frozen copy's files (before anything changes)
    const script = await readDay({ dataDir: pristine, guildId, day, log: logs.log });
    const dayStart = Date.parse(`${day}T00:00:00.000Z`);
    const collisions = (() => {
      const handle = openMemoryDb(liveDb, { readOnly: true });
      try {
        const probe = handle.db.prepare('SELECT 1 AS ok FROM sources WHERE native_id = ? LIMIT 1');
        return [...script.ids.values()].filter((id) => probe.get(id)).length;
      } finally { handle.close(); }
    })();
    if (collisions > 0) throw new CliError(`memory-rehearsal: ${collisions} replay ids are already in the database; the day cannot be replayed beside the past`);

    // ---------------- row 1: baseline
    {
      const sync = await tool(['sync', '--data', live, '--db', liveDb]);
      const readers = await tool(['reader-parity', '--data', live, '--db', liveDb]);
      const parity = await tool(['parity', '--data', live, '--db', liveDb]);
      rows.set('baseline', rowOf('baseline', sync.code === 0 && readers.code === 0 && parity.code === 0, [
        `sync: ${sync.lines.filter((line) => line.startsWith('files:') || line.startsWith('rows:')).join('; ') || `exit ${sync.code}`}`,
        `reader-parity: ${lastLine(readers)}`,
        ...readers.lines.filter((line) => /differ [1-9]/.test(line) || /^ {2}/.test(line)).slice(0, 12).map((line) => `  ${line.trim()}`),
        `parity: ${parity.lines.join('; ')}`,
      ]));
    }

    // ---------------- row 2 (with row 4's state): the json process at the switch
    const clock = { at: Math.max(Date.now(), dayStart) };
    // The json process runs at the copy's own present, which may be before the day; its clock is the copy's newest line.
    {
      const handle = openMemoryDb(liveDb, { readOnly: true });
      try { const newest = Date.parse(handle.db.prepare('SELECT MAX(recorded_at) AS at FROM sources').get()?.at ?? ''); clock.at = Number.isFinite(newest) ? newest + MINUTE : dayStart; } finally { handle.close(); }
    }
    const switchStart = clock.at;
    const boundary = { public: [], private: [], said: null, archive: null, lore: null, edit: null, embedded: [] };
    const switchNumbers = [];
    const switchNotes = [];
    let switchOk = true;
    let backupDir = null;
    let handoff = null;
    {
      const core = coreOf(live, 'json', clock);
      await core.memoryDb.tick();
      if (!core.memoryDb.status().open) { switchOk = false; switchNotes.push(`the json process did not open the database (${core.memoryDb.status().refused ?? 'unknown'})`); }
      // Row 4's state: buffered public and private lines (observed, held by the analyzer's buffer), an in-flight turn's
      // said line, a dirty cache entry, a queued archive append, an embedding backlog.
      const channelId = (() => { const h = core.memoryDb.readHandle(); return h?.db.prepare("SELECT native_id AS id FROM places WHERE kind = 'channel' AND native_id IS NOT NULL ORDER BY id LIMIT 1").get()?.id ?? null; })();
      const partner = privateLayers(live, guildId)[0] ?? null;
      const author = [...facts.names.keys()].find((id) => id !== facts.self && core.store.getUser(guildId, id)) ?? partner;
      const base = `${ID_PREFIX}9${String(clock.at).slice(-9)}`;
      const mid = (n) => `${base}${String(n).padStart(6, '0')}`;
      if (channelId && author) {
        for (let n = 1; n <= 3; n += 1) {
          clock.at += 1000;
          const id = mid(n);
          await core.door.submit(core.events.message(core.discord.messageOf({ id, authorId: author, at: clock.at, text: `boundary line ${n} café`, channelId })));
          boundary.public.push(id);
        }
        // the in-flight turn: started, her post sent, the said line handed to the record, nothing awaited yet
        clock.at += 1000;
        const started = core.journal.start(guildId, { channelId, mode: 'reply', turnId: `turn-boundary-${clock.at}` });
        boundary.said = mid(9);
        const said = toRecordLine({ id: boundary.said, channelId, authorId: facts.self, ts: clock.at, content: 'boundary answer', replyToId: boundary.public[0] }, { kind: 'said', now: () => clock.at, turnId: started.turnId, opId: 'op-boundary' });
        boundary.inFlight = [
          core.record.append(guildId, [said]),
          core.door.submit(core.events.message(core.discord.messageOf({ id: boundary.said, authorId: facts.self, at: clock.at, text: 'boundary answer', channelId, replyTo: boundary.public[0] }))),
          core.journal.turn(guildId, { channelId, turnId: started.turnId, attemptId: 1, outcome: 'spoke', think: '-', posted: [{ messageId: boundary.said, replyTo: boundary.public[0], opId: 'op-boundary' }] }),
        ];
      }
      if (partner) {
        const dmChannel = (() => { const h = core.memoryDb.readHandle(); return h?.db.prepare("SELECT native_id AS id FROM places WHERE kind = 'dm' AND native_id IS NOT NULL ORDER BY id LIMIT 1").get()?.id ?? `dm-${partner}`; })();
        clock.at += 1000;
        const id = mid(20);
        await core.door.submit(core.events.message(core.discord.messageOf({ id, authorId: partner, at: clock.at, text: 'boundary private line', channelId: dmChannel, dm: partner })));
        boundary.private.push(id);
      }
      // a dirty cache entry (lore by the owner, kept in the cache until the flush) and a queued archive append
      clock.at += 1000;
      boundary.lore = `boundary lore ${clock.at}`;
      core.store.setLore(guildId, [{ title: boundary.lore, keys: ['boundary'], text: 'kept across the switch' }], { source: 'owner', now: clock.at });
      boundary.archive = `boundary-archive-${clock.at}`;
      boundary.archiveWrite = core.archive.append(guildId, [{
        v: 1, id: boundary.archive, kind: 'archive', event: 'expired', itemKind: 'detail', itemId: boundary.archive, revisionId: `rv-${boundary.archive}`,
        scope: { user: author ?? partner ?? facts.self }, participants: [], observedAt: { date: day, precision: 'day' }, lastSeen: null, text: { text: 'boundary archive' },
        weight: 0.5, origin: 'live', by: 'archive', occurredAt: iso(clock.at), recordedAt: iso(clock.at), guildId,
      }]);
      // the embedding backlog: lines in the queue, not flushed
      if (boundary.public.length > 0) {
        const lines = boundary.public.map((id, i) => toRecordLine({ id, channelId, authorId: author, ts: clock.at - 4000 + i * 1000, content: `boundary line ${i + 1} café` }, { now: () => clock.at }));
        core.embedQueue.enqueue(guildId, lines, {});
        boundary.embedded = [...boundary.public];
      }
      const stateMark = logs.mark();

      // ---- the protocol: producers paused (no event is delivered from here on), in-flight work finished, every store flushed
      await Promise.allSettled([...(boundary.inFlight ?? []), boundary.archiveWrite]);
      const flushed = await core.store.flushSettled({ holdMaxMs: 5000 });
      const embedded = await core.embedQueue.flush();
      switchNumbers.push(`json process: ${boundary.public.length} public and ${boundary.private.length} private lines buffered, 1 in-flight said line, a dirty lore entry, a queued archive line, ${boundary.embedded.length} lines waiting for embeddings`);
      switchNumbers.push(`flushed: store ${JSON.stringify(flushed ?? {})}; embeddings ${embedded?.embedded ?? 0} written, ${embedded?.left ?? 0} left`);
      await core.shutdown();
      const failures = failuresIn(logs.since(stateMark));
      if (failures.length) { switchOk = false; switchNotes.push(`failures before the barrier: ${summarize(failures).join(', ')}`); }
    }
    // ---- the last sync, the barrier
    {
      const sync = await tool(['sync', '--data', live, '--db', liveDb]);
      const verify = await tool(['verify', '--data', live, '--db', liveDb]);
      const observed = await tool(['observe-check', '--db', liveDb, '--since', iso(switchStart - HOUR), '--data', live]);
      switchNumbers.push(`final sync: ${sync.lines.filter((line) => line.startsWith('files:')).join('') || `exit ${sync.code}`}`);
      switchNumbers.push(`verify: ${lastLine(verify)}`);
      for (const line of verify.lines.filter((text) => /^ {4}/.test(text)).slice(0, 8)) switchNumbers.push(`  ${line.trim()}`);
      switchNumbers.push(`observe-check --data: ${observed.lines.join('; ')}`);
      if (sync.code !== 0 || verify.code !== 0 || observed.code !== 0) switchOk = false;
    }
    // ---- the backup with counts and watermarks
    let before = null;
    {
      backupDir = path.join(work, 'backup');
      const done = await tool(['backup', '--db', liveDb, '--to', backupDir, '--data', live]);
      const handle = openMemoryDb(liveDb, { readOnly: true });
      try { before = { marks: watermarks(handle.db), refs: danglingRefs(handle.db) }; } finally { handle.close(); }
      switchNumbers.push(`backup: ${done.lines.join('; ')}`);
      switchNumbers.push(`watermarks: newest source rowid ${before.marks.rowid} at ${before.marks.at}; rows ${Object.entries(before.marks.rows).map(([table, n]) => `${table} ${n}`).join(', ')}`);
      if (done.code !== 0) switchOk = false;
    }

    // ---------------- the db process: opened before the catch-up, the memory files gone
    watch.pause();
    const deleted = deleteMemoryFiles(live);
    watch.watch(live);
    const switchedAt = Date.now();
    clock.at = Math.max(clock.at + MINUTE, dayStart);
    const dbFailures = [];
    const dbCore = coreOf(live, 'db', clock, { onSessionFailure: (failure) => dbFailures.push(failure) });
    const markDb = logs.mark();
    watch.resume();
    await dbCore.memoryDb.tick();
    {
      const state = dbCore.memoryDb.status();
      const read = dbCore.memoryDb.readHandle();
      handoff = read ? parse(read.db.prepare('SELECT value FROM meta WHERE key = ?').get(HANDOFF_KEY)?.value ?? 'null') : null;
      switchNumbers.push(`db process: open ${state.open}, authority ${state.authority}, sync off ${state.syncOff}, handoff ${state.session?.handoff} (${handoff ? `scopes ${handoff.scopes}, set ${handoff.set}, kept ${handoff.kept}, buffered ${handoff.buffered}, behind ${handoff.behind}` : 'none'}); ${deleted} memory files deleted`);
      const pending = fs.existsSync(path.join(live, 'memory-pending')) ? filesUnder(path.join(live, 'memory-pending')).length : 0;
      switchNumbers.push(`pending folder after the open: ${pending} files`);
      if (!state.open || state.authority !== 'db' || state.session?.handoff !== true || !handoff || pending > 0) switchOk = false;
      if (handoff && handoff.behind > 0) switchNotes.push(`${handoff.behind} buffered lines sit behind their scope's cursor: her session would not read them`);
    }
    rows.set('switch', rowOf('switch', switchOk, switchNumbers, switchNotes));

    // ---------------- row 4 (the start): the catch-up delivers the boundary lines again; a late edit
    const cutoverNumbers = [];
    const cutoverNotes = [];
    let cutoverOk = true;
    {
      const read = readOf(dbCore).db;
      const sourcesOf = (id) => count(read, 'SELECT COUNT(*) AS n FROM sources WHERE native_id = ? AND retired_at IS NULL', id);
      const beforeCatchUp = [...boundary.public, ...boundary.private].map(sourcesOf);
      // the start-up catch-up: the boundary's public lines fetched again and handed to the handler (and one to the gateway too)
      const channelId = boundary.public.length ? read.prepare("SELECT p.native_id AS id FROM sources s JOIN places p ON p.id = s.place_id WHERE s.native_id = ? LIMIT 1").get(boundary.public[0])?.id : null;
      const caught = {};
      for (const [i, id] of boundary.public.entries()) {
        const message = dbCore.discord.messageOf({ id, authorId: read.prepare('SELECT a.native_id AS id FROM sources s JOIN accounts a ON a.id = s.author_account WHERE s.native_id = ? LIMIT 1').get(id)?.id ?? facts.self, at: clock.at - 10_000 + i, text: `boundary line ${i + 1} café`, channelId });
        const answer = await dbCore.onMessage.catchUp(dbCore.events.message(message), { trigger: false });
        caught[answer] = (caught[answer] ?? 0) + 1;
        if (i === 0) await dbCore.door.submit(dbCore.events.message(message));
      }
      await dbCore.tick();
      const afterCatchUp = [...boundary.public, ...boundary.private].map(sourcesOf);
      const doubled = afterCatchUp.filter((n, i) => n !== beforeCatchUp[i]).length;
      cutoverNumbers.push(`catch-up: ${JSON.stringify(caught)}; boundary lines whose source count changed: ${doubled}`);
      if (doubled > 0) cutoverOk = false;
      // a late edit of a line from before the switch
      const old = read.prepare("SELECT s.native_id AS id, s.text AS text, s.occurred_at AS at, a.native_id AS author, p.native_id AS place FROM sources s JOIN accounts a ON a.id = s.author_account JOIN places p ON p.id = s.place_id WHERE s.kind = 'seen' AND s.scope_kind = 'group' AND s.retired_at IS NULL AND p.kind = 'channel' AND s.native_id NOT LIKE ? ORDER BY s.rowid DESC LIMIT 1").get(`${ID_PREFIX}%`);
      if (old) {
        const revisionBefore = await dbCore.record.newestRevision(guildId, old.id, old.at);
        const previous = dbCore.discord.messageOf({ id: old.id, authorId: old.author, at: Date.parse(old.at), text: old.text ?? '', channelId: old.place });
        const edited = dbCore.discord.messageOf({ id: old.id, authorId: old.author, at: Date.parse(old.at), text: `${old.text ?? ''} (edited after the switch)`, channelId: old.place, editedAt: clock.at });
        await dbCore.door.submit(dbCore.events.edit(edited, previous));
        const revisionAfter = await dbCore.record.newestRevision(guildId, old.id, old.at);
        const rows4 = count(read, "SELECT COUNT(*) AS n FROM sources WHERE native_id = ? AND kind = 'seen' AND revision = ? AND retired_at IS NULL AND owner_file GLOB '*/record/*'", old.id, revisionAfter ?? -1);
        boundary.edit = { id: old.id, before: revisionBefore, after: revisionAfter };
        cutoverNumbers.push(`late edit of a line from before the switch: revision ${revisionBefore} -> ${revisionAfter}, rows of the new revision in its record unit ${rows4}`);
        if (!(revisionAfter === (revisionBefore ?? 1) + 1 && rows4 === 1)) cutoverOk = false;
      } else {
        cutoverNotes.push('no public line before the switch to edit');
      }
    }

    // ---------------- row 3: the day under db
    const soleNumbers = [];
    const soleNotes = [];
    let soleOk = true;
    let replayed = null;
    {
      if (faults.dropLine) {
        // The tool's own test: a writer that drops the first seen line of the day.
        const realObserve = dbCore.memoryDb.observe;
        let dropped = false;
        dbCore.memoryDb.observe = (envelope, where) => {
          if (!dropped && String(envelope?.native?.key ?? '').startsWith(ID_PREFIX)) { dropped = true; return Promise.resolve({ ok: true, revision: 1 }); }
          return realObserve(envelope, where);
        };
      }
      const markDay = logs.mark();
      replayed = await replayDay(dbCore, script, { guildId, selfId: facts.self, selfName, names });
      // after the day: her session drains every scope (minMessages 1 for the drain), the embeddings caught up
      dbCore.hot.config.memoryDb.session.minMessages = 1;
      const settleMs = (dbCore.hot.config.memoryDb.session.settleMinutes ?? 10) * MINUTE;
      const everyMs = (dbCore.hot.config.memoryDb.session.everyMinutes ?? 60) * MINUTE;
      clock.at = Math.max(clock.at, dayStart + DAY_MS) + settleMs + MINUTE;
      let rounds = 0;
      for (; rounds < 48; rounds += 1) {
        await dbCore.tick();
        const behind = cursorsAtEnd(readOf(dbCore).db).behind;
        if (behind.length === 0) break;
        clock.at += everyMs + MINUTE;
      }
      await dbCore.embedQueue.flush();
      await dbCore.embedQueue.catchUp(guildId).catch((error) => soleNotes.push(`embedding catch-up failed: ${codeOf(error)}`));
      await dbCore.embedQueue.flush();
      await dbCore.tick();
      const consumers = await runConsumers(dbCore, { guildId, day, selfId: facts.self });
      const read = readOf(dbCore).db;
      const sources = linesAsSources(read, script, facts.self);
      const cursors = cursorsAtEnd(read);
      const refs = danglingRefs(read);
      const added = newRefs(before.refs, refs);
      const index = await embeddingsOfDay(dbCore, read, { guildId, day });
      const runs = read.prepare("SELECT outcome, COUNT(*) AS n FROM session_runs WHERE mode = 'apply' GROUP BY outcome ORDER BY outcome").all();
      const failures = failuresIn(logs.since(markDb));
      const hits = watch.take();
      const reads = hits.filter((hit) => hit.kind === 'read');
      const writes = hits.filter((hit) => hit.kind === 'write');
      const memoryNow = memoryFilesOf(live);
      const retire = await tool(['retire-check', '--data', live, '--since', iso(switchedAt)]);
      soleNumbers.push(`script: ${script.counts.lines} record lines (${Object.entries(script.counts.kinds).map(([k, n]) => `${k} ${n}`).join(', ') || 'none'}) in ${script.counts.layers + 1} layers, ${script.counts.journal} journal records (${Object.entries(script.counts.journalKinds).map(([k, n]) => `${k} ${n}`).join(', ') || 'none'}), ${script.counts.posts} diary posts`);
      soleNumbers.push(`delivered: ${JSON.stringify(replayed.delivered)}; door ${JSON.stringify(replayed.statuses)}; journal ${JSON.stringify(replayed.journal)}; participation ${replayed.participation}; diary ${replayed.posts}; skipped ${JSON.stringify(replayed.skipped)}`);
      soleNumbers.push(`lines of the day as sources: ${sources.checked} checked (${sources.own} of them her own lines the record kept as seen, her said rows here), ${sources.missing.length} missing, ${sources.duplicated.length} duplicated, ${sources.ownerless.length} outside a record unit${sources.missing.length ? ` (first: ${sources.missing.slice(0, 3).join(', ')})` : ''}`);
      soleNumbers.push(`her session: ${runs.map((row) => `${row.outcome} ${row.n}`).join(', ') || 'no run'}; requests ${herLlm === fakeModel ? fakeModel.calls.length : 'n/a'}; scopes ${cursors.scopes}, behind ${cursors.behind.length}${cursors.behind.length ? ` (${cursors.behind.slice(0, 3).map((entry) => `${entry.scope} ${entry.left} left`).join(', ')})` : ''}; drain rounds ${rounds}; failures told ${dbFailures.length}`);
      soleNumbers.push(`embeddings: ${index.indexed} of the ${index.wanted} lines the index takes (each message's newest revision with text) have their vector, ${index.backlog.length} wait${index.backlog.length ? ` (first: ${index.backlog.slice(0, 3).map((line) => `${line.kind}:${line.messageId}:${line.revision ?? 1}`).join(', ')})` : ''}; never embedded: ${index.superseded} older revisions of edited messages, ${index.textless} lines without text (of ${index.rows} seen and said rows); fake embedder ${embed.calls.requests} requests, ${embed.calls.texts} texts`);
      soleNumbers.push(`references: ${sumOf(refs)} dangling now, ${sumOf(before.refs)} before the switch; new ${JSON.stringify(added)}`);
      soleNumbers.push(`consumers read: ${Object.entries(consumers.numbers).map(([name, n]) => `${name} ${n}`).join(', ')}; ${consumers.failed.length === 0 ? 'none failed' : `${consumers.failed.length} failed: ${consumers.failed.map((entry) => `${entry.name} (${entry.code})`).join(', ')}`}`);
      soleNumbers.push(`files: memory files in the copy now ${memoryNow.length}; reads of a retired path ${reads.length}, writes ${writes.length}${hits.length ? ` (${[...new Set(hits.map((hit) => `${hit.kind} ${hit.op} ${hit.rel}`))].slice(0, 5).join('; ')})` : ''}; retire-check: ${lastLine(retire)}`);
      soleNumbers.push(`warnings and errors: ${failures.length}${failures.length ? ` (${summarize(failures).slice(0, 6).join(', ')})` : ''}; the core's own model calls ${coreLlm.calls.length}`);
      soleOk = sources.missing.length === 0 && index.backlog.length === 0 && sources.duplicated.length === 0 && sources.ownerless.length === 0 && cursors.behind.length === 0
        && Object.keys(added).length === 0 && consumers.ok && memoryNow.length === 0 && hits.length === 0 && retire.code === 0 && failures.length === 0
        && dbFailures.length === 0 && (runs.length > 0 || script.counts.lines === 0);
      void markDay;
    }
    rows.set('sole', rowOf('sole', soleOk, soleNumbers, soleNotes));

    // ---------------- row 4 (the end): each boundary item in the database once, none read twice by her session
    {
      const read = readOf(dbCore).db;
      const once = (sql, ...params) => count(read, sql, ...params);
      const publicRows = boundary.public.map((id) => once("SELECT COUNT(*) AS n FROM sources WHERE native_id = ? AND kind = 'seen' AND revision = 1 AND retired_at IS NULL", id));
      const privateRows = boundary.private.map((id) => once("SELECT COUNT(*) AS n FROM sources WHERE native_id = ? AND kind = 'seen' AND revision = 1 AND retired_at IS NULL", id));
      const inRecord = [...boundary.public, ...boundary.private].map((id) => once("SELECT COUNT(*) AS n FROM sources WHERE native_id = ? AND retired_at IS NULL AND owner_file GLOB '*/record/*'", id));
      const saidRows = boundary.said ? once("SELECT COUNT(*) AS n FROM sources WHERE native_id = ? AND kind = 'said' AND retired_at IS NULL", boundary.said) : 1;
      const loreRows = once("SELECT COUNT(*) AS n FROM claims WHERE kind = 'lore' AND retired_at IS NULL AND extra LIKE ?", `%${boundary.lore}%`);
      const loreRead = (dbCore.store.getLore(guildId) ?? []).filter((entry) => entry?.title === boundary.lore).length;
      const archiveRows = once("SELECT COUNT(*) AS n FROM claim_versions WHERE retired_at IS NULL AND (id LIKE ? OR revision_id LIKE ? OR claim_id LIKE ?)", `%${boundary.archive}%`, `%${boundary.archive}%`, `%${boundary.archive}%`);
      const archived = [];
      for await (const entry of dbCore.archive.iterate(guildId, {})) if (entry?.id === boundary.archive) archived.push(entry);
      const vectorRows = boundary.embedded.map((id) => once('SELECT COUNT(*) AS n FROM vectors v JOIN sources s ON s.rowid = v.source_rowid WHERE s.native_id = ? AND v.retired_at IS NULL', id));
      const twice = read.prepare(`SELECT COUNT(*) AS n FROM (SELECT t.row_id FROM turn_reads t JOIN session_runs r ON r.id = t.turn_id
        WHERE t.reader_kind = 'session' AND t.row_kind = 'sources' AND t.block = 'batch' AND r.mode = 'apply' AND r.outcome IN ('ok', 'applied_before')
        GROUP BY t.row_id HAVING COUNT(DISTINCT t.turn_id) > 1)`).get()?.n ?? 0;
      const boundaryRead = [...boundary.public, ...boundary.private].map((id) => read.prepare(`SELECT COUNT(DISTINCT t.turn_id) AS n FROM turn_reads t JOIN sources s ON s.id = t.row_id JOIN session_runs r ON r.id = t.turn_id
        WHERE t.reader_kind = 'session' AND t.row_kind = 'sources' AND t.block = 'batch' AND r.mode = 'apply' AND s.native_id = ?`).get(id)?.n ?? 0);
      cutoverNumbers.push(`buffered lines: public rows ${JSON.stringify(publicRows)}, private rows ${JSON.stringify(privateRows)}, in a record unit ${JSON.stringify(inRecord)}; read by her session ${JSON.stringify(boundaryRead)}`);
      cutoverNumbers.push(`in-flight said line rows ${saidRows}; dirty lore entry: read back ${loreRead}, rows holding it ${loreRows}; queued archive line: rows ${archiveRows}, read back ${archived.length}; embedding backlog: vectors ${JSON.stringify(vectorRows)}`);
      cutoverNumbers.push(`sources read by more than one applied session batch: ${twice}`);
      const exactlyOne = (list) => list.every((n) => n === 1);
      if (!(exactlyOne(publicRows) && exactlyOne(privateRows) && exactlyOne(inRecord) && saidRows === 1 && loreRead === 1 && loreRows === 1 && archived.length === 1 && exactlyOne(vectorRows) && twice === 0
        && boundaryRead.every((n) => n === 1))) cutoverOk = false;
      if (boundary.public.length === 0) { cutoverOk = false; cutoverNotes.push('no channel and member to build the boundary lines with'); }
    }
    rows.set('cutover', rowOf('cutover', cutoverOk, cutoverNumbers, cutoverNotes));

    // ---- the state after the day, closed (the copy each later row starts from)
    watch.pause();
    await dbCore.shutdown();
    const afterDay = path.join(work, 'after-day');
    cloneState(live, afterDay);
    watch.resume();

    // ---------------- row 5: failure injection
    rows.set('failures', await failureRows({ work, afterDay, coreOf, logs, watch, guildId, selfId: facts.self, clock: { at: clock.at + HOUR } }));
    // ---------------- row 6: ordering and duplicates
    rows.set('ordering', await orderingRow({ work, afterDay, coreOf, logs, watch, guildId, selfId: facts.self, clock: { at: clock.at + 2 * HOUR } }));

    watch.pause();
    // ---------------- row 7: restore of the backup
    {
      const restored = await tool(['restore-test', '--from', backupDir]);
      rows.set('restore', rowOf('restore', restored.code === 0, [`restore-test: ${lastLine(restored)}`, ...restored.lines.filter((line) => /differ [1-9]|FAILED|could not/.test(line)).slice(0, 8)]));
    }
  } finally {
    watch.uninstall();
    logs.stop();
  }
  const ordered = ROWS.map(([key]) => rows.get(key) ?? rowOf(key, false, [], ['not run: an earlier step stopped the rehearsal']));
  const report = reportOf({ rows: ordered, meta: { day, session, commit, at: iso(startedAt) } });
  if (!keep && !root) fs.rmSync(work, { recursive: true, force: true });
  return { rows: ordered, report, root: work };
}

// ---------------------------------------------------------------- row 5

/**
 * The opener of a memory service whose connection fails on demand (`fault.arm(mode, { times, when })`): `after` lets
 * a transaction commit and then throws (its answer lost: a writer that died after the commit), `before` throws at the
 * end of the transaction (rolled back: a writer that died inside it), `locked` throws before it as a busy database
 * does, `vacuum` makes a `VACUUM INTO` (the backup) throw. `when(db)` picks the transaction: it is asked after the
 * transaction's work ran (inside it for `before`, after the commit for `after`); a transaction it refuses goes through.
 * `times` transactions fail, then the fault is off.
 */
function faultyOpener() {
  const state = { mode: null, times: 0, failed: 0, when: null };
  const fault = {
    arm(mode, { times = 1, when = null } = {}) { state.mode = mode; state.times = times; state.when = when; },
    disarm() { state.mode = null; state.times = 0; state.when = null; },
    get failed() { return state.failed; },
  };
  const coded = (code, message) => Object.assign(new Error(message), { code });
  const consume = () => {
    state.times -= 1;
    state.failed += 1;
    if (state.times <= 0) fault.disarm();
  };
  const open = (target, options) => {
    const real = openMemoryDb(target, options);
    const db = new Proxy(real.db, {
      get(holder, prop) {
        if (prop === 'exec' || prop === 'prepare') {
          return (sql) => {
            if (state.mode === 'vacuum' && state.times > 0 && /^\s*VACUUM\s+INTO/i.test(String(sql))) {
              consume();
              const full = coded('SQLITE_FULL', 'database or disk is full');
              if (prop === 'exec') throw full;
              return { run() { throw full; }, get() { throw full; }, all() { throw full; } };
            }
            return holder[prop](sql);
          };
        }
        const value = holder[prop];
        return typeof value === 'function' ? value.bind(holder) : value;
      },
    });
    return {
      ...real,
      db,
      transaction(fn) {
        const mode = state.times > 0 ? state.mode : null;
        if (mode === 'locked') {
          consume();
          throw coded('ERR_SQLITE_ERROR', 'database is locked');
        }
        if (mode === 'before') {
          let hit = false;
          try {
            return real.transaction(() => {
              const result = fn();
              if (!state.when || state.when(real.db)) { hit = true; throw coded('WORKER_EXIT', 'the writer died inside the transaction'); }
              return result;
            });
          } catch (error) {
            if (hit) consume();
            throw error;
          }
        }
        const result = real.transaction(fn);
        if (mode === 'after' && (!state.when || state.when(real.db))) {
          consume();
          throw coded('WORKER_EXIT', 'the writer died after the commit');
        }
        return result;
      },
    };
  };
  return { open, fault };
}

/** A fresh copy of the state after the day, a process over it with a faulty opener, and its restart. */
async function withCopy({ work, afterDay, name, coreOf, logs, watch, clock }, run) {
  const dir = path.join(work, 'faults', name);
  watch.pause();
  cloneState(afterDay, dir);
  watch.watch(dir);
  watch.resume();
  const { open, fault } = faultyOpener();
  const mark = logs.mark();
  const start = () => coreOf(dir, 'db', clock, { open });
  let core = start();
  await core.memoryDb.tick();
  const restart = async () => {
    await core.shutdown();
    fault.disarm();
    core = start();
    await core.memoryDb.tick();
    return core;
  };
  try {
    return await run({ core: () => core, fault, restart, dir, logs: () => logs.since(mark) });
  } finally {
    watch.pause();
    await core.shutdown().catch(() => {});
    watch.unwatch(dir);
    watch.resume();
  }
}

const pendingCount = (dir) => (fs.existsSync(path.join(dir, 'memory-pending')) ? filesUnder(path.join(dir, 'memory-pending')).length : 0);

async function failureRows({ work, afterDay, coreOf, logs, watch, guildId, selfId, clock }) {
  const cases = [];
  const ctx = { work, afterDay, coreOf, logs, watch, clock };
  const channelOf = (db) => db.prepare("SELECT native_id AS id FROM places WHERE kind = 'channel' AND native_id IS NOT NULL ORDER BY id LIMIT 1").get()?.id ?? null;
  const authorOf = (db) => db.prepare("SELECT a.native_id AS id FROM people p JOIN accounts a ON a.person_id = p.id WHERE p.kind = 'member' AND p.retired_at IS NULL AND a.native_id IS NOT NULL AND a.native_id != ? ORDER BY p.id LIMIT 1").get(selfId)?.id ?? null;
  let serial = 0;
  const newId = () => `${ID_PREFIX}7${String(clock.at).slice(-9)}${String((serial += 1)).padStart(6, '0')}`;
  const say = async (core, { id = newId(), text = 'a line of the failure rows' } = {}) => {
    const db = core.memoryDb.readHandle().db;
    clock.at += 1000;
    const message = core.discord.messageOf({ id, authorId: authorOf(db), at: clock.at, text, channelId: channelOf(db) });
    const answer = await core.door.submit(core.events.message(message));
    return { id, message, answer };
  };
  const sourcesOf = (core, id) => count(core.memoryDb.readHandle().db, 'SELECT COUNT(*) AS n FROM sources WHERE native_id = ? AND retired_at IS NULL', id);
  const run = async (name, fn) => {
    try {
      cases.push(await withCopy({ ...ctx, name: name.replace(/[^a-z0-9]+/gi, '-').toLowerCase().slice(0, 40) }, fn));
    } catch (error) {
      cases.push({ name, pass: false, detail: `the case threw: ${codeOf(error)} ${String(error?.message ?? '').slice(0, 120)}` });
    }
  };

  // 1. an observation committed, its answer lost; the restart's catch-up delivers it again
  await run('observation', async ({ core, fault, restart, dir }) => {
    const id = newId();
    fault.arm('after', { when: (db) => count(db, 'SELECT COUNT(*) AS n FROM sources WHERE native_id = ?', id) > 0 });
    const line = await say(core(), { id });
    await core().tick();
    const next = await restart();
    const caught = await next.onMessage.catchUp(next.events.message(next.discord.messageOf({ id, authorId: line.message.author.id, at: line.message.createdTimestamp, text: line.message.content, channelId: line.message.channelId })), { trigger: false });
    await next.tick();
    const rows = sourcesOf(next, id);
    const owned = count(next.memoryDb.readHandle().db, "SELECT COUNT(*) AS n FROM sources WHERE native_id = ? AND owner_file GLOB '*/record/*' AND retired_at IS NULL", id);
    return { name: 'an observation committed, its answer lost; a restart and the catch-up', pass: fault.failed === 1 && rows === 1 && owned === 1 && pendingCount(dir) === 0, detail: `fault hit ${fault.failed}, catch-up ${caught}, rows ${rows}, in its record unit ${owned}, pending ${pendingCount(dir)}` };
  });

  // 2-3. her session: the plan lost before its apply; the apply committed and its answer lost
  const sessionCase = (name, mode) => run(name, async ({ core, fault, restart, dir }) => {
    for (let n = 0; n < 6; n += 1) await say(core(), { text: `failure row line ${n}` });
    const config = () => core().hot.config.memoryDb.session;
    config().minMessages = 1;
    const db = () => core().memoryDb.readHandle().db;
    const runsBefore = count(db(), "SELECT COUNT(*) AS n FROM session_runs WHERE mode = 'apply'");
    const claimsBefore = count(db(), "SELECT COUNT(*) AS n FROM claims WHERE text LIKE 'rehearsal plan %' AND retired_at IS NULL");
    const movesBefore = count(db(), "SELECT COUNT(*) AS n FROM affinity_events WHERE reason LIKE 'rehearsal plan %'");
    fault.arm(mode, { when: (d) => count(d, "SELECT COUNT(*) AS n FROM session_runs WHERE mode = 'apply'") > runsBefore });
    const step = ((config().settleMinutes ?? 10) + (config().everyMinutes ?? 60) + 1) * MINUTE;
    clock.at += step;
    await core().tick();
    const status = core().memoryDb.status().session;
    const next = await restart();
    next.hot.config.memoryDb.session.minMessages = 1;
    for (let round = 0; round < 3; round += 1) { clock.at += step; await next.tick(); }
    const d = next.memoryDb.readHandle().db;
    const claims = count(d, "SELECT COUNT(*) AS n FROM claims WHERE text LIKE 'rehearsal plan %' AND retired_at IS NULL") - claimsBefore;
    const moves = count(d, "SELECT COUNT(*) AS n FROM affinity_events WHERE reason LIKE 'rehearsal plan %'") - movesBefore;
    const runs = d.prepare("SELECT outcome, COUNT(*) AS n FROM session_runs WHERE mode = 'apply' GROUP BY outcome ORDER BY outcome").all();
    const left = cursorsAtEnd(d).behind.length;
    return {
      name,
      pass: fault.failed === 1 && claims === 1 && moves === 1 && left === 0 && status.lastFailure !== null && pendingCount(dir) === 0,
      detail: `fault hit ${fault.failed}; the plan's claims ${claims}, attitude moves ${moves}; scopes behind ${left}; the status before the restart: ${status.lastFailure?.code ?? 'no failure'}; runs ${runs.map((row) => `${row.outcome} ${row.n}`).join(', ')}`,
    };
  });
  await sessionCase('her session: the plan answered, the writer gone inside the apply (rolled back)', 'before');
  await sessionCase('her session: the apply committed, its answer lost', 'after');

  // 4. a diary post sent, its row's write never committed; the shutdown keeps it pending, the restart replays it
  await run('diary', async ({ core, fault, restart, dir }) => {
    const gist = `rehearsal diary ${clock.at}`;
    const channelId = core().hot.config.diary?.channelId;
    if (typeof channelId === 'string' && channelId) await core().discord.channelOf(channelId).send({ content: '-' });
    fault.arm('before', { times: 1000, when: (db) => count(db, 'SELECT COUNT(*) AS n FROM diary WHERE gist = ?', gist) > 0 });
    core().store.appendDiaryPost(guildId, { at: clock.at, kind: 'day', gist, picture: null, messageIds: [newId()], search: null }, { max: 150, now: clock.at });
    await settle();
    const read = (core().store.getDiary(guildId).posts ?? []).filter((post) => post.gist === gist).length;
    await core().shutdown();
    const kept = pendingCount(dir);
    const next = await restart();
    const d = next.memoryDb.readHandle().db;
    const rows = count(d, 'SELECT COUNT(*) AS n FROM diary WHERE gist = ? AND retired_at IS NULL', gist);
    const after = (next.store.getDiary(guildId).posts ?? []).filter((post) => post.gist === gist).length;
    return { name: 'a diary post sent, its row never committed; the shutdown and a restart', pass: read === 1 && kept >= 1 && rows === 1 && after === 1 && pendingCount(dir) === 0, detail: `read back before the stop ${read}, kept pending at the stop ${kept}, rows after the restart ${rows}, read back ${after}, pending now ${pendingCount(dir)}` };
  });

  // 5. an intention and a task transition committed, their answers lost
  await run('intention-task', async ({ core, fault, restart, dir }) => {
    const intentionId = `rehearsal-intention-${clock.at}`;
    const intentions = core().intentionStores.get(guildId);
    fault.arm('after', { when: (db) => count(db, 'SELECT COUNT(*) AS n FROM intentions WHERE id LIKE ?', `%${intentionId}%`) > 0 });
    const added = intentions.add({ id: intentionId, purpose: 'rehearsal intention', status: 'pending', createdAt: clock.at, updatedAt: clock.at, expiresAt: clock.at + DAY_MS, dueAt: null, provenance: { kind: 'self', turnId: 't-rh', channelId: null, scope: 'group' }, history: [] });
    await settle();
    await core().intentionStores.flush();
    const intentionHit = fault.failed;
    const tasks = core().taskStores.get(guildId);
    const transitions = (store) => {
      const task = store.add({ agent: 'scout', goal: 'rehearsal task', requester: { userId: selfId, kind: 'self' }, origin: { channelId: null, messageId: null }, scope: 'group' });
      if (!task.ok) return null;
      store.start(task.task.id);
      store.finish(task.task.id, { status: 'done', result: { text: '-', sources: [], files: [] }, usage: { input: 0, output: 0, usd: 0, steps: 1, seconds: 1 } });
      return task.task.id;
    };
    const lineCount = (db, id) => count(db, 'SELECT COUNT(*) AS n FROM work_events WHERE retired_at IS NULL AND (work_id LIKE ? OR record LIKE ?)', `%${id}%`, `%${id}%`);
    // a control task without a fault, then the same transitions with every task write's answer lost once
    const control = transitions(tasks);
    await settle();
    await core().taskStores.flush();
    const eventsBefore = count(core().memoryDb.readHandle().db, 'SELECT COUNT(*) AS n FROM work_events');
    fault.arm('after', { times: 2, when: (db) => count(db, 'SELECT COUNT(*) AS n FROM work_events') > eventsBefore });
    const faulted = transitions(tasks);
    await settle();
    await core().taskStores.flush();
    const next = await restart();
    const d = next.memoryDb.readHandle().db;
    const intentionRows = count(d, 'SELECT COUNT(*) AS n FROM intentions WHERE id LIKE ? AND retired_at IS NULL', `%${intentionId}%`);
    const intentionRead = next.intentionStores.get(guildId).list().filter((entry) => entry.id === intentionId).length;
    const expected = control ? lineCount(d, control) : -1;
    const got = faulted ? lineCount(d, faulted) : -2;
    const state = faulted ? next.taskStores.get(guildId).get(faulted)?.state ?? null : null;
    return {
      name: 'an intention and a task transition committed, their answers lost; a restart',
      pass: added.ok && intentionHit === 1 && intentionRows === 1 && intentionRead === 1 && expected > 0 && got === expected && state === 'done' && pendingCount(dir) === 0,
      detail: `intention: fault hit ${intentionHit}, rows ${intentionRows}, read back ${intentionRead}; task: transition lines ${got} (a task without a fault has ${expected}), state ${state}; faults hit ${fault.failed}; pending ${pendingCount(dir)}`,
    };
  });

  // 6. a write broken off inside its transaction: the line and its graph projection roll back together, the queue retries
  // (at the next tick, or at once when the open is still writing what waited), and the retry projects the line
  await run('projection', async ({ core, fault, restart, dir }) => {
    const id = newId();
    fault.arm('before', { when: (db) => count(db, 'SELECT COUNT(*) AS n FROM sources WHERE native_id = ?', id) > 0 });
    await say(core(), { id });
    const during = sourcesOf(core(), id);
    await core().tick();
    await core().memoryDb.waitObservations();
    const before = sourcesOf(core(), id);
    const next = await restart();
    await next.tick();
    const d = next.memoryDb.readHandle().db;
    const rows = sourcesOf(next, id);
    const sourceId = d.prepare('SELECT id FROM sources WHERE native_id = ? LIMIT 1').get(id)?.id ?? null;
    const nodes = sourceId ? count(d, 'SELECT COUNT(*) AS n FROM graph_nodes WHERE id = ?', graphNodeId('source', sourceId)) : 0;
    const pendingGraph = count(d, "SELECT COUNT(*) AS n FROM meta WHERE key = 'graph_pending'");
    return { name: 'a write broken off inside its transaction (the line and its projection), retried', pass: fault.failed === 1 && before === 1 && rows === 1 && nodes === 1 && pendingCount(dir) === 0, detail: `fault hit ${fault.failed}, rows right after ${during}, after the retry ${before}, after a restart ${rows}, its graph node ${nodes}${pendingGraph ? ' (the projection pending)' : ''}, pending ${pendingCount(dir)}` };
  });

  // 7. a backup that failed (the copy refused), in the status; the next try an hour later
  await run('backup', async ({ core, fault, dir }) => {
    const target = path.join(dir, '..', `${path.basename(dir)}-backups`);
    core().hot.config.memoryDb.backup = { enabled: true, hour: 0, dir: target, keep: 2 };
    fault.arm('vacuum');
    await core().memoryDb.tick();
    await core().memoryDb.waitBackup();
    const first = core().memoryDb.status().backup;
    clock.at += HOUR + MINUTE;
    await core().memoryDb.tick();
    await core().memoryDb.waitBackup();
    const second = core().memoryDb.status().backup;
    const names = fs.existsSync(target) ? fs.readdirSync(target) : [];
    const partials = names.filter((entry) => entry.endsWith('.partial')).length;
    const whole = names.filter((entry) => !entry.endsWith('.partial')).length;
    return { name: 'a backup that failed, then the next one', pass: fault.failed === 1 && first?.lastFailure?.code === 'SQLITE_FULL' && second?.lastFailure === null && whole === 1 && partials === 0, detail: `the status after the failure: ${first?.lastFailure?.code ?? 'no failure'}; after the next try: ${second?.lastName ? 'a backup' : 'none'}; backups ${whole}, partial folders ${partials}` };
  });

  // 8. the database locked: the observation waits in its queue and lands once
  await run('locked', async ({ core, fault, restart, dir }) => {
    fault.arm('locked', { times: 2 });
    const line = await say(core());
    for (let n = 0; n < 4; n += 1) await core().tick();
    const rows = sourcesOf(core(), line.id);
    const next = await restart();
    const after = sourcesOf(next, line.id);
    return { name: 'the database locked twice: the observation retried from its queue', pass: fault.failed === 2 && rows === 1 && after === 1 && pendingCount(dir) === 0, detail: `faults hit ${fault.failed}, rows ${rows}, after a restart ${after}, pending ${pendingCount(dir)}` };
  });

  // 9. the observation queue overflowing while the database is not open yet: the loss is in the status
  await run('overflow', async ({ core, restart, dir, logs }) => {
    const db = core().memoryDb.readHandle().db;
    const author = authorOf(db);
    const channel = channelOf(db);
    await core().shutdown();
    // A process whose database is not open yet (the start's catch-up runs before the open) takes them into its queue.
    const fresh = coreOf(dir, 'db', clock, {});
    const total = 5001;
    const first = newId();
    let last = first;
    for (let n = 0; n < total; n += 1) {
      const id = n === 0 ? first : newId();
      last = id;
      const message = fresh.discord.messageOf({ id, authorId: author, at: clock.at + n, text: 'overflow', channelId: channel });
      fresh.memoryDb.observe(observationOf(fresh.events.message(message), { selfId }), { guildId });
    }
    const status = fresh.memoryDb.status();
    await fresh.memoryDb.tick();
    await fresh.memoryDb.tick();
    const left = await fresh.memoryDb.waitObservations();
    const d = fresh.memoryDb.readHandle().db;
    const firstRows = count(d, 'SELECT COUNT(*) AS n FROM sources WHERE native_id = ?', first);
    const lastRows = count(d, 'SELECT COUNT(*) AS n FROM sources WHERE native_id = ?', last);
    const written = count(d, "SELECT COUNT(*) AS n FROM sources WHERE native_id GLOB ? AND text = 'overflow' AND owner_file GLOB '*/record/*'", `${ID_PREFIX}7*`);
    const after = fresh.memoryDb.status().observe ?? null;
    await fresh.shutdown();
    await restart();
    const dropped = status.observe?.dropped ?? null;
    const told = logs().filter((entry) => entry.message === 'memory db: observations dropped' && entry.fields?.count === 1).length;
    return {
      name: 'the observation queue overflowing before the open',
      pass: dropped === 1 && after?.dropped === 1 && told === 1 && firstRows === 0 && lastRows === 1 && written === total - 1 && left === 0,
      detail: `queued ${total}, the status says dropped ${dropped ?? 'nothing (the status does not carry it)'}, told with its count ${told}; written after the open ${written} (the oldest ${firstRows}, the newest ${lastRows}), left ${left}`,
    };
  });

  // 10. a stale base: two revises of the same claim version, the second refused
  await run('cas', async ({ core }) => {
    const db = core().memoryDb.readHandle().db;
    const claim = db.prepare("SELECT id FROM claims WHERE text LIKE 'rehearsal plan %' AND retired_at IS NULL ORDER BY id LIMIT 1").get()?.id ?? null;
    if (!claim) return { name: 'a stale base (compare-and-set)', pass: false, detail: 'no claim of her session to revise' };
    const base = newestClaimVersion(db, claim);
    const source = db.prepare('SELECT source_id FROM claim_sources WHERE claim_id = ? LIMIT 1').get(claim)?.source_id ?? null;
    const runOf = (id) => ({ id, sweepId: `sweep-${id}`, scopeKey: 'group:discord', scope: { scope_kind: 'group', scope_iface: 'discord', scope_dm: null }, batchKey: `apply|${id}`, startedAt: iso(clock.at), finishedAt: iso(clock.at), outcome: 'ok', counts: {}, errors: [] });
    const plan = (text) => ({ claims: [{ op: 'revise', id: claim, text, how: 'said', sources: [source], reason: 'rehearsal', base }], episodes: [], affinity: [], descriptions: [], people: [] });
    const second = `rh-cas-2-${clock.at}`;
    await core().memoryDb.memoryWrite({ kind: 'session', mode: 'apply', run: runOf(`rh-cas-1-${clock.at}`), plan: plan('rehearsal revised once'), now: clock.at });
    await core().memoryDb.memoryWrite({ kind: 'session', mode: 'apply', run: runOf(second), plan: plan('rehearsal revised twice'), now: clock.at + 1 });
    const text = db.prepare('SELECT text FROM claims WHERE id = ?').get(claim)?.text ?? null;
    const refused = count(db, "SELECT COUNT(*) AS n FROM decisions WHERE action = 'rejected:stale_base' AND extra LIKE ?", `%${second}%`);
    return { name: 'a stale base: the second revise of the same version refused', pass: text === 'rehearsal revised once' && refused === 1, detail: `the claim holds the first revise: ${text === 'rehearsal revised once'}; the second refused as stale: ${refused}` };
  });

  const pass = cases.length > 0 && cases.every((entry) => entry.pass);
  return rowOf('failures', pass, cases.map((entry) => `${entry.pass ? 'PASS' : 'FAIL'} ${entry.name}: ${entry.detail}`));
}

// ---------------------------------------------------------------- row 6

async function orderingRow({ work, afterDay, coreOf, logs, watch, guildId, selfId, clock }) {
  const checks = [];
  const result = await withCopy({ work, afterDay, name: 'ordering', coreOf, logs, watch, clock }, async ({ core, dir }) => {
    const c = core();
    const db = c.memoryDb.readHandle().db;
    const channel = db.prepare("SELECT native_id AS id FROM places WHERE kind = 'channel' AND native_id IS NOT NULL ORDER BY id LIMIT 1").get()?.id;
    const person = db.prepare("SELECT p.id AS person, a.native_id AS id FROM people p JOIN accounts a ON a.person_id = p.id WHERE p.kind = 'member' AND a.native_id IS NOT NULL AND a.native_id != ? AND p.retired_at IS NULL ORDER BY p.id LIMIT 1").get(selfId);
    let serial = 0;
    const newId = () => `${ID_PREFIX}6${String(clock.at).slice(-9)}${String((serial += 1)).padStart(6, '0')}`;
    const rows = (id, kind = null, revision = null) => count(db, `SELECT COUNT(*) AS n FROM sources WHERE native_id = ? AND retired_at IS NULL${kind ? ' AND kind = ?' : ''}${revision ? ' AND revision = ?' : ''}`, ...[id, kind, revision].filter((value) => value !== null));
    const msg = (spec) => c.discord.messageOf({ authorId: person.id, channelId: channel, ...spec });
    const check = (name, pass, detail) => checks.push({ name, pass, detail });

    // duplicate deliveries of one message (the door, then the gateway again with a new event id)
    clock.at += 1000;
    const dup = msg({ id: newId(), at: clock.at, text: 'one message delivered three times' });
    const event = c.events.message(dup);
    const answers = [(await c.door.submit(event)).status, (await c.door.submit(event)).status, (await c.door.submit(c.events.message(dup))).status];
    await c.onMessage(c.events.message(dup));
    check('duplicate deliveries of one message', rows(dup.id) === 1, `rows ${rows(dup.id)} (the door: ${answers.join(', ')}; once more past the door)`);

    // an edit before its original
    clock.at += 1000;
    const early = newId();
    const editFirst = msg({ id: early, at: clock.at, text: 'the edited text', editedAt: clock.at + 500 });
    await c.door.submit(c.events.edit(editFirst, null));
    await c.door.submit(c.events.message(msg({ id: early, at: clock.at, text: 'the original text' })));
    check('an edit before its original', rows(early, 'seen', 1) === 1 && rows(early, 'seen', 2) === 1 && rows(early, 'seen') === 2, `revision 1 rows ${rows(early, 'seen', 1)}, revision 2 rows ${rows(early, 'seen', 2)}`);

    // a deletion before its edit
    clock.at += 1000;
    const gone = newId();
    await c.door.submit(c.events.message(msg({ id: gone, at: clock.at, text: 'soon deleted' })));
    await c.door.submit(c.events.deletion(msg({ id: gone, at: clock.at, text: 'soon deleted' })));
    await c.door.submit(c.events.edit(msg({ id: gone, at: clock.at, text: 'edited after its deletion', editedAt: clock.at + 900 }), null));
    check('a deletion before its edit', rows(gone, 'deleted') === 1 && rows(gone, 'seen', 1) === 1 && rows(gone, 'seen', 2) <= 1, `deleted rows ${rows(gone, 'deleted')}, seen revisions ${rows(gone, 'seen')}`);

    // the same text twice by one author: two lines
    clock.at += 1000;
    const a = newId();
    const b = newId();
    await c.door.submit(c.events.message(msg({ id: a, at: clock.at, text: 'ναι ναι' })));
    await c.door.submit(c.events.message(msg({ id: b, at: clock.at + 1, text: 'ναι ναι' })));
    check('the same text twice by one author', rows(a) === 1 && rows(b) === 1, `rows ${rows(a)} and ${rows(b)}`);

    // lines across midnight: two record day units
    const midnight = Math.ceil(clock.at / DAY_MS) * DAY_MS;
    const late = newId();
    const early2 = newId();
    clock.at = midnight - 500;
    await c.door.submit(c.events.message(msg({ id: late, at: midnight - 1000, text: 'just before midnight' })));
    clock.at = midnight + 500;
    await c.door.submit(c.events.message(msg({ id: early2, at: midnight + 1000, text: 'just after midnight' })));
    const unitOf = (id) => db.prepare('SELECT owner_file FROM sources WHERE native_id = ? AND retired_at IS NULL LIMIT 1').get(id)?.owner_file ?? '';
    const dayBefore = iso(midnight - 1000).slice(0, 10);
    const dayAfter = iso(midnight + 1000).slice(0, 10);
    check('lines across midnight', unitOf(late).endsWith(`${dayBefore}.jsonl`) && unitOf(early2).endsWith(`${dayAfter}.jsonl`), `units ${unitOf(late).split('/').pop()} and ${unitOf(early2).split('/').pop()}`);

    // the catch-up and the gateway delivering the same lines, in both orders
    clock.at += 1000;
    const viaGateway = newId();
    const viaCatchUp = newId();
    const g = msg({ id: viaGateway, at: clock.at, text: 'gateway first' });
    await c.door.submit(c.events.message(g));
    const caught1 = await c.onMessage.catchUp(c.events.message(g), { trigger: false });
    const k = msg({ id: viaCatchUp, at: clock.at + 1, text: 'catch-up first' });
    const caught2 = await c.onMessage.catchUp(c.events.message(k), { trigger: false });
    await c.door.submit(c.events.message(k));
    check('the catch-up and the gateway delivering the same lines', rows(viaGateway) === 1 && rows(viaCatchUp) === 1, `rows ${rows(viaGateway)} and ${rows(viaCatchUp)} (catch-up answers ${caught1}, ${caught2})`);

    // an affinity decay tick and a session apply on one person at once: both counted
    const before = db.prepare('SELECT affinity FROM people WHERE id = ?').get(person.person)?.affinity ?? 0;
    const eventsBefore = count(db, 'SELECT COUNT(*) AS n FROM affinity_events WHERE person_id = ?', person.person);
    const held = structuredClone(c.store.getUser(guildId, person.id)?.affinity ?? null);
    const source = db.prepare("SELECT id FROM sources WHERE native_id = ? AND kind = 'seen' LIMIT 1").get(a)?.id;
    const runId = `rh-order-${clock.at}`;
    const session = c.memoryDb.memoryWrite({
      kind: 'session', mode: 'apply', now: clock.at,
      run: { id: runId, sweepId: `sweep-${runId}`, scopeKey: 'group:discord', scope: { scope_kind: 'group', scope_iface: 'discord', scope_dm: null }, batchKey: `apply|${runId}`, startedAt: iso(clock.at), finishedAt: iso(clock.at), outcome: 'ok', counts: {}, errors: [] },
      plan: { claims: [], episodes: [], affinity: [{ personId: person.person, delta: 3, reason: 'rehearsal move', sources: [source] }], descriptions: [], people: [] },
    });
    const decayAt = clock.at + 3 * DAY_MS;
    const decayCfg = { decayPerDay: 0.5, decayPower: 1 };
    const decayed = c.store.decayAffinities(guildId, decayAt, decayCfg);
    await session;
    c.store.flush();
    await c.store.flushSettled({});
    await c.tick();
    const after = db.prepare('SELECT affinity FROM people WHERE id = ?').get(person.person)?.affinity ?? 0;
    const eventsAfter = count(db, 'SELECT COUNT(*) AS n FROM affinity_events WHERE person_id = ?', person.person);
    const sessionEvent = count(db, "SELECT COUNT(*) AS n FROM affinity_events WHERE person_id = ? AND reason = 'rehearsal move'", person.person);
    const cached = c.store.getUser(guildId, person.id)?.affinity?.score ?? null;
    // Both counted, in either order: the move then the decay of the moved score, or the decay then the move.
    const clamp2 = (score) => Math.round(Math.max(-100, Math.min(100, score)) * 100) / 100;
    const base = held ?? { score: before };
    const decayOf = (affinity) => decayAffinity(affinity, decayAt, decayCfg).affinity.score;
    const expected = [decayOf({ ...base, score: clamp2(base.score + 3) }), clamp2(decayOf(base) + 3)];
    const both = expected.some((value) => Math.abs(after - value) < 1e-9);
    check('an affinity decay and a session apply on one person at once', sessionEvent === 1 && both && cached !== null && Math.abs(after - cached) < 1e-9,
      `affinity ${before} -> ${after} (the store reads ${cached}; both counted: ${expected.join(' or ')}); decayed ${decayed.decayed}; events ${eventsBefore} -> ${eventsAfter}, the session's ${sessionEvent}`);
    return { pending: pendingCount(dir) };
  });
  const pass = checks.every((entry) => entry.pass) && result.pending === 0;
  return rowOf('ordering', pass, [...checks.map((entry) => `${entry.pass ? 'PASS' : 'FAIL'} ${entry.name}: ${entry.detail}`), `pending folder ${result.pending}`]);
}

// ---------------------------------------------------------------- the command line

/**
 * @param {string[]} argv
 * @returns {Promise<string>} the report's summary (the report itself goes to --report)
 */
export async function main(argv) {
  const flags = parseFlags(argv, { values: ['--data', '--db', '--day', '--session', '--report'], switches: ['--keep'], usage: USAGE });
  if (flags._.length > 0 || !flags['--data'] || !flags['--db'] || !flags['--day']) throw new CliError(USAGE);
  const session = flags['--session'] ?? 'fake';
  if (session !== 'fake' && session !== 'memory-key') throw new CliError(`memory-rehearsal: --session is fake or memory-key\n${USAGE}`);
  if (flags['--report']) refuseProduction(flags['--report'], '--report');
  const { createHot } = await import('../src/hot.js');
  const hot = createHot({ rootDir: ROOT, privateDir: privateDirOf(ROOT) });
  const base = { config: structuredClone(hot.config), prompts: hot.prompts };
  hot.close?.();
  let env = {};
  let sessionLlm = null;
  if (session === 'memory-key') {
    const { env: loaded, loadDotEnv } = await import('../src/config.js');
    loadDotEnv(privateDirOf(ROOT));
    env = loaded;
    const keyName = base.config?.llm?.keyByRole?.memory;
    if (typeof keyName !== 'string' || !env[keyName]) throw new CliError('memory-rehearsal: the memory role has no key of its own (llm.keyByRole.memory in .env)');
    const { createLlm } = await import('../src/llm/openrouter.js');
    sessionLlm = createLlm({ apiKey: env.OPENROUTER_CORE_KEY ?? '', env, getConfig: () => base.config, calibrator: createCalibrator(undefined), state: { data: {}, markDirty() {} } });
  }
  const { engineCommit } = await import('../src/memory/db/service.js');
  const done = await rehearse({ data: flags['--data'], db: flags['--db'], day: flags['--day'], session, base, env, sessionLlm, keep: flags['--keep'] === true, commit: engineCommit() });
  if (flags['--report']) fs.writeFileSync(path.resolve(flags['--report']), done.report);
  const lines = done.rows.map((row, i) => `${i + 1}. ${row.title}: ${row.pass ? 'PASS' : 'FAIL'}`);
  if (flags['--keep']) lines.push(`copies kept in ${done.root}`);
  return `${flags['--report'] ? '' : done.report}${lines.join('\n')}\n`;
}

runCli(import.meta.url, main);
