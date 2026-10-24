// A synthetic data directory for the sync, export and verify tests: one guild, one member with a public profile and
// a private layer, a record, a journal with a turn and its request dump, an archive, a vector month and the small
// state files. Synthetic text only (Greek or accented Latin for non-ASCII); the ids are made up.
import fs from 'node:fs';
import path from 'node:path';
import { generated } from './roundtrip.js';

export const GUILD = '300000000000000001';
export const MEMBER = '100000000000000001';
export const CHANNEL = '200000000000000001';
export const HOT_ITEM = 'details[].itemId#1';

/** The generated fixtures repeat one literal itemId in a list; a data directory needs them apart. */
function withUniqueItemIds(value) {
  const out = JSON.parse(JSON.stringify(value));
  for (const list of Object.values(out)) {
    if (Array.isArray(list)) list.forEach((item, index) => { if (item && typeof item.itemId === 'string') item.itemId = `${item.itemId}#${index}`; });
  }
  return out;
}

export const guildDir = (root) => path.join(root, 'guilds', GUILD);

export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

export function writeLines(file, lines) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, lines.map((line) => `${JSON.stringify(line)}\n`).join(''));
}

export const envelope = (kind, extra = {}) => ({
  v: 1, id: `j-${kind}`, kind, occurredAt: '2026-10-20T10:00:00.000Z', recordedAt: '2026-10-20T10:00:01.000Z', guildId: GUILD,
  scope: { channel: CHANNEL }, participants: [MEMBER], sourceMessageIds: ['400000000000000001'], origin: 'live', ...extra,
});

export const seen = (messageId, revision, text, extra = {}) => ({
  v: 1, id: `r-${messageId}-${revision}`, kind: 'seen', messageId, revision, occurredAt: '2026-10-20T09:00:00.000Z',
  recordedAt: '2026-10-20T09:00:01.000Z', guildId: GUILD, scope: { channel: CHANNEL }, by: MEMBER, replyTo: null, text,
  media: [], mentions: [], direct: false, participants: [MEMBER], sourceMessageIds: [messageId], origin: 'live', ...extra,
});

export const turnLine = (extra = {}) => envelope('turn', {
  id: 'j-turn', turnId: 'turn-1', attemptId: 1, mode: 'reply', outcome: 'spoke', reason: null,
  posted: [{ messageId: '400000000000000009', replyTo: '400000000000000001', opId: 'op-1' }], think: 'Καλημέρα. A café thought.', ...extra,
});

export const dump = () => ({
  v: 1, turnId: 'turn-1', attemptId: 1, step: 1, recordedAt: '2026-10-20T10:00:00.000Z', system: 'rules',
  parts: [{ type: 'text', text: 'hi' }], raw: '<think>she waits</think>Hello', usage: { prompt: 1, cached: 0, completion: 2 },
});

export const archiveLine = (id, itemId, extra = {}) => ({
  v: 1, id, kind: 'archive', event: 'expired', itemKind: 'detail', itemId, revisionId: `rv-${id}`,
  scope: { user: MEMBER }, participants: [MEMBER], observedAt: { date: '2026-10-01', precision: 'day' }, lastSeen: null,
  text: { text: 'café at noon' }, weight: 0.5, origin: 'live', by: 'archive', occurredAt: '2026-10-01T00:00:00.000Z',
  recordedAt: '2026-10-02T00:00:00.000Z', guildId: GUILD, ...extra,
});

const DIMS = 4;
export function vectorMonth() {
  const lines = [0, 1].map((row) => ({
    row, kind: 'record', id: `40000000000000000${row + 1}`, revision: 1, occurredAt: '2026-10-20T09:00:00.000Z', channelId: CHANNEL,
    by: MEMBER, participants: [MEMBER], sourceIds: [`40000000000000000${row + 1}`], scale: 0.01, norm: 0.99,
  }));
  const meta = lines.map((line) => `${JSON.stringify(line)}\n`).join('');
  const i8 = Buffer.from([1, 2, 3, 4, 250, 251, 252, 253]);
  const manifest = { v: 1, gen: 1, rows: 2, bytes: i8.length, metaBytes: Buffer.byteLength(meta), model: 'test/embedder', dims: DIMS, checksum: 'fnv1a32:00000000:00000000' };
  return { manifest, meta, i8 };
}

/** Builds the directory under `root` (which must exist). Returns the guild directory. */
export function buildDataDir(root) {
  const g = guildDir(root);
  fs.mkdirSync(g, { recursive: true });
  writeJson(path.join(root, 'state.json'), { not: 'memory' });
  writeJson(path.join(g, 'users', `${MEMBER}.json`), { ...withUniqueItemIds(generated('user')[0]), id: MEMBER });
  writeJson(path.join(g, 'private', `${MEMBER}.json`), withUniqueItemIds(generated('private')[0]));
  writeJson(path.join(g, 'channels', `${CHANNEL}.json`), { ...generated('channel')[0], id: CHANNEL });
  writeJson(path.join(g, 'guild.json'), generated('guild')[0]);
  writeJson(path.join(g, 'lore.json'), generated('lore')[0]);
  writeJson(path.join(g, 'forgotten.json'), []);
  writeLines(path.join(g, 'record', '2026-10', '2026-10-20.jsonl'), [
    seen('400000000000000001', 1, 'Καλημέρα'),
    seen('400000000000000001', 2, 'Καλημέρα (edited)'),
    seen('400000000000000002', 1, 'a café at noon'),
  ]);
  writeLines(path.join(g, 'private', MEMBER, 'record', '2026-10', '2026-10-20.jsonl'), [
    seen('400000000000000005', 1, 'a private word', { scope: { channel: '200000000000000099' }, direct: true }),
  ]);
  writeLines(path.join(g, 'journal', '2026-10-20.jsonl'), [
    envelope('turn.start', { id: 'j-start', turnId: 'turn-1', attemptId: 1, mode: 'reply' }),
    turnLine(),
    envelope('system', { id: 'j-system', event: 'start', by: 'owner' }),
    envelope('memory', {
      id: 'j-memory', batchId: 'b-1', stage: 'applied', note: 'a batch',
      attitude: [{ userId: MEMBER, delta: 3, applied: 2, reason: 'was kind' }],
    }),
  ]);
  writeJson(path.join(g, 'journal', 'requests', '2026-10-20', 'turn-1-s1.json'), dump());
  writeJson(path.join(g, 'versions', 'users', `${MEMBER}.json`), { character: [{ at: '2026-10-01', by: 'analyzer', chars: 3, before: 'a', after: 'b', text: 'old' }] });
  writeLines(path.join(g, 'archive', '2026-10.jsonl'), [archiveLine('ar-1', HOT_ITEM), archiveLine('ar-2', 'gone-item')]);
  const month = vectorMonth();
  fs.mkdirSync(path.join(g, 'vectors', '2026-10'), { recursive: true });
  fs.writeFileSync(path.join(g, 'vectors', '2026-10', 'manifest.json'), JSON.stringify(month.manifest));
  fs.writeFileSync(path.join(g, 'vectors', '2026-10', '1.i8'), month.i8);
  fs.writeFileSync(path.join(g, 'vectors', '2026-10', '1.jsonl'), month.meta);
  writeJson(path.join(g, 'participation.json'), {
    nextId: 2,
    episodes: [{
      id: 'p-1', channelId: CHANNEL, startAt: 1792000000000, lastAt: 1792000060000, lastOwnAt: 1792000050000, continues: null, itemId: 'ep-1',
      messages: [{ id: '400000000000000001', ts: 1792000000000, authorId: MEMBER, name: 'Ada', self: false, text: 'Καλημέρα', replyTo: null, caption: null }],
    }],
  });
  writeJson(path.join(g, 'recent.json'), {
    nextId: 2, lines: [{ id: 1, at: 1792000000000, addedAt: '2026-10-20T10:00:00.000Z', channelId: CHANNEL, text: 'café', who: [MEMBER], weight: 0.5, itemId: 'rc-1' }],
  });
  writeJson(path.join(g, 'diary.json'), {
    updatedAt: 1792000000000, posts: [{ at: 1792000000000, kind: 'day', gist: 'a quiet day', picture: null, messageIds: ['500000000000000001'], search: null, itemId: 'd-1' }],
  });
  writeJson(path.join(g, 'intentions.json'), {
    intentions: [{
      id: 'i1', purpose: 'ask about the trip', status: 'open', createdAt: 1792000000000, updatedAt: 1792000001000, dueAt: null,
      provenance: { kind: 'self', turnId: 't-1', channelId: CHANNEL, scope: 'group' }, history: [],
    }],
  });
  writeLines(path.join(g, 'intentions-archive.jsonl'), []);
  writeJson(path.join(g, 'tasks.json'), { tasks: [{ id: 't1', state: 'done', createdAt: 1792000000000, requester: { userId: MEMBER }, scope: 'group', seen: true }] });
  writeLines(path.join(g, 'tasks.jsonl'), [{ at: 1792000000500, id: 't1', state: 'running' }]);
  writeJson(path.join(g, 'media.json'), { '1555006398444736533': { text: 'a photo of a café', ts: 1792000000000 } });
  writeJson(path.join(g, 'gifs.json'), { nextId: 2, entries: {} });
  writeJson(path.join(g, 'voice.json'), []);
  writeJson(path.join(g, 'inner.json'), { v: 1, stopped: false, queue: [] });
  writeLines(path.join(g, 'recall-trace.jsonl'), [{ at: '2026-10-20T10:00:00.000Z', channelId: CHANNEL, hits: 0 }]);
  return g;
}
