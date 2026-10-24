// The fixture of the database reader tests (stage W1): the synthetic data directory of datadir.js, a second guild,
// and, in the first guild only, a few more files so every read path has something to return (a second record day with every line kind, a
// member under a forget marker, a private journal and archive, a vector month of a private layer, an archived
// intention), imported into a database with tools/memory-db.mjs. Synthetic text only; the ids are made up.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main } from '../../../tools/memory-db.mjs';
import { openMemoryDb } from '../../../src/memory/db/open.js';
import { createVectors } from '../../../src/memory/vectors.js';
import { CHANNEL, GUILD, MEMBER, buildDataDir, buildSecondGuild, envelope, guildDir, seen, writeJson, writeLines } from './datadir.js';

export { CHANNEL, GUILD, MEMBER };
export { GUILD_2 } from './datadir.js';
/** A member under a forget marker: every line naming them is hidden from every read. */
export const HIDDEN = '100000000000000003';
export const OTHER = '100000000000000002';
export const CHANNEL_B = '200000000000000005';

const silent = { info() {}, debug() {}, warn() {}, error() {} };

/** The extra files, written before the import. */
async function addExtra(data) {
  const g = guildDir(data);
  writeLines(path.join(g, 'record', '2026-10', '2026-10-21.jsonl'), [
    seen('400000000000000011', 1, 'Χαίρετε, a second day', { occurredAt: '2026-10-21T08:00:00.000Z', recordedAt: '2026-10-21T08:00:01.000Z' }),
    seen('400000000000000012', 1, 'in the other room', { occurredAt: '2026-10-21T08:05:00.000Z', recordedAt: '2026-10-21T08:05:01.000Z', scope: { channel: CHANNEL_B }, by: OTHER, participants: [OTHER] }),
    seen('400000000000000013', 1, 'a word of the hidden one', { occurredAt: '2026-10-21T08:06:00.000Z', recordedAt: '2026-10-21T08:06:01.000Z', by: HIDDEN, participants: [HIDDEN] }),
    {
      v: 1, id: 'r-said-1', kind: 'said', messageId: '400000000000000014', revision: 1, occurredAt: '2026-10-21T08:07:00.000Z',
      recordedAt: '2026-10-21T08:07:01.000Z', guildId: GUILD, scope: { channel: CHANNEL }, replyTo: '400000000000000011', text: 'Ναι, of course',
      media: [], mentions: [], turnId: 'turn-2', opId: 'op-2', participants: [MEMBER], sourceMessageIds: ['400000000000000014'], origin: 'live',
    },
    {
      v: 1, id: 'r-del-1', kind: 'deleted', messageId: '400000000000000012', occurredAt: '2026-10-21T08:09:00.000Z', recordedAt: '2026-10-21T08:09:01.000Z',
      guildId: GUILD, scope: { channel: CHANNEL_B }, participants: [OTHER], sourceMessageIds: ['400000000000000012'], origin: 'live',
    },
    seen('400000000000000011', 2, 'Χαίρετε, a second day (edited)', { occurredAt: '2026-10-21T08:00:00.000Z', recordedAt: '2026-10-21T08:10:01.000Z' }),
  ]);
  writeJson(path.join(g, 'forgetting', `${HIDDEN}.json`), { userId: HIDDEN, at: '2026-10-21T09:00:00.000Z', step: 'record' });
  writeLines(path.join(g, 'journal', '2026-10-21.jsonl'), [
    envelope('turn.start', { id: 'j2-start', turnId: 'turn-2', attemptId: 1, mode: 'reply', occurredAt: '2026-10-21T08:06:30.000Z', recordedAt: '2026-10-21T08:06:30.000Z' }),
    envelope('action', { id: 'j2-a1', turnId: 'turn-2', opId: 'op-2', name: 'post', by: 'persona', phase: 'started', intent: { replyTo: '400000000000000011', text: 'Ναι' }, occurredAt: '2026-10-21T08:06:40.000Z', recordedAt: '2026-10-21T08:06:40.000Z' }),
    envelope('action', { id: 'j2-a2', turnId: 'turn-2', opId: 'op-2', name: 'post', by: 'persona', phase: 'succeeded', result: { messageId: '400000000000000014' }, occurredAt: '2026-10-21T08:07:00.000Z', recordedAt: '2026-10-21T08:07:00.000Z' }),
    envelope('action', { id: 'j2-a3', turnId: 'turn-2', opId: 'op-3', name: 'react', by: 'persona', phase: 'started', occurredAt: '2026-10-21T08:07:10.000Z', recordedAt: '2026-10-21T08:07:10.000Z' }),
    envelope('turn', {
      id: 'j2-turn', turnId: 'turn-2', attemptId: 1, mode: 'reply', outcome: 'spoke', reason: null, think: 'à demain',
      posted: [{ messageId: '400000000000000014', replyTo: '400000000000000011', opId: 'op-2' }], occurredAt: '2026-10-21T08:07:20.000Z', recordedAt: '2026-10-21T08:07:20.000Z',
    }),
    envelope('system', { id: 'j2-system', event: 'stop', by: 'owner', occurredAt: '2026-10-21T20:00:00.000Z', recordedAt: '2026-10-21T20:00:00.000Z', scope: { guild: true } }),
    envelope('action', { id: 'j2-hidden', turnId: 'turn-2', opId: 'op-4', name: 'post', by: 'persona', phase: 'started', participants: [HIDDEN], occurredAt: '2026-10-21T08:08:00.000Z', recordedAt: '2026-10-21T08:08:00.000Z' }),
  ]);
  writeLines(path.join(g, 'private', MEMBER, 'journal', '2026-10-20.jsonl'), [
    envelope('action', { id: 'jp-a1', turnId: 'turn-p', opId: 'op-p', name: 'post', by: 'persona', phase: 'started', scope: { user: MEMBER, private: true }, input: { skill: 'msg' } }),
    envelope('action', { id: 'jp-a2', turnId: 'turn-p', opId: 'op-p', name: 'post', by: 'persona', phase: 'failed', result: { code: 'x' }, scope: { user: MEMBER, private: true } }),
  ]);
  writeLines(path.join(g, 'private', MEMBER, 'archive', '2026-10.jsonl'), [{
    v: 1, id: 'arp-1', kind: 'archive', event: 'expired', itemKind: 'detail', itemId: 'gone-item', revisionId: 'rv-arp-1',
    scope: { user: MEMBER, private: true }, participants: [MEMBER], observedAt: { date: '2026-10-03', precision: 'day' }, lastSeen: null,
    text: { text: 'a private café note' }, weight: 0.4, origin: 'live', by: 'archive', occurredAt: '2026-10-03T00:00:00.000Z',
    recordedAt: '2026-10-01T00:00:00.000Z', guildId: GUILD,
  }]);
  writeJson(path.join(g, 'intentions.json'), {
    intentions: [
      {
        id: 'i2', purpose: 'ask how the café went', status: 'pending', createdAt: 1792000000000, updatedAt: 1792000001000, dueAt: 1792100000000,
        expiresAt: 1793000000000, provenance: { kind: 'self', turnId: 't-2', channelId: CHANNEL, scope: 'group', participants: [MEMBER] }, history: [],
      },
      {
        id: 'i3', purpose: 'a private reminder', status: 'pending', createdAt: 1792000002000, updatedAt: 1792000003000, dueAt: null,
        expiresAt: 1793000000000, provenance: { kind: 'self', turnId: 't-3', channelId: null, scope: 'dm', participants: [MEMBER] }, history: [],
      },
    ],
  });
  writeLines(path.join(g, 'intentions-archive.jsonl'), [{
    id: 'i0', purpose: 'an old plan', status: 'done', createdAt: 1791000000000, updatedAt: 1791000001000, dueAt: null,
    provenance: { kind: 'self', turnId: 't-0', channelId: CHANNEL, scope: 'group' }, history: [],
  }]);
  // Vector months written by the engine itself: a private layer's, and a second guild month.
  const vectors = createVectors({ dataDir: data, log: silent });
  const row = (id, occurredAt, vector, extra = {}) => ({ meta: { kind: 'record', id, revision: 1, occurredAt, channelId: CHANNEL, by: MEMBER, participants: [MEMBER], sourceIds: [id], ...extra }, vector });
  await vectors.append(GUILD, [row('400000000000000005', '2026-10-20T09:00:00.000Z', [0.5, -0.2, 0.1, 0.9])], { privateUserId: MEMBER, model: 'test/embedder' });
  await vectors.append(GUILD, [
    row('400000000000000021', '2026-09-10T09:00:00.000Z', [0.1, 0.2, 0.3, 0.4]),
    row('400000000000000022', '2026-09-11T09:00:00.000Z', [-0.4, 0.3, 0.2, 0.1]),
    row('400000000000000023', '2026-09-12T09:00:00.000Z', [0.9, 0.1, -0.3, 0.2], { by: HIDDEN, participants: [HIDDEN] }),
  ], { model: 'test/embedder' });
}

/**
 * The data directory and its database: `data`, `dbFile`, `handle` (read-only), `memoryDb` (a service-shaped object
 * with authority `db` over `handle`), `closedDb` (authority `db`, nothing open), `jsonDb` (authority `json`, with a
 * handle that must never be asked), `log` (warns collected in `warns`), `done()`.
 */
export async function readerEnv() {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'memdb-readers-'));
  const data = path.join(root, 'data');
  fs.mkdirSync(data);
  buildDataDir(data);
  buildSecondGuild(data);
  await addExtra(data);
  const dbFile = path.join(root, 'memory.db');
  const out = [];
  const code = main(['import', '--data', data, '--db', dbFile], { out: (line) => out.push(line), err: (line) => out.push(line) });
  if (code !== 0) throw new Error(`import failed: ${out.join('\n')}`);
  const handle = openMemoryDb(dbFile, { readOnly: true });
  const warns = [];
  const log = { info() {}, debug() {}, error() {}, warn: (message, fields) => warns.push({ message, ...fields }) };
  let asked = 0;
  return {
    root, data, dbFile, handle, warns, log,
    memoryDb: { authority: () => 'db', readHandle: () => handle },
    closedDb: { authority: () => 'db', readHandle: () => null },
    jsonDb: { authority: () => 'json', readHandle: () => { asked += 1; return handle; } },
    handleAsked: () => asked,
    done: () => { try { handle.close(); } catch { /* closed */ } fs.rmSync(root, { recursive: true, force: true }); },
  };
}

/** Every value of an async iterable. */
export async function all(iterable) {
  const out = [];
  for await (const value of iterable) out.push(value);
  return out;
}

/** An fs (promises) whose every call fails: proof that a read under `db` never touches the files. */
export const noFs = new Proxy({}, { get: () => () => { throw Object.assign(new Error('the files were read'), { code: 'FILE_READ' }); } });
