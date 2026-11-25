// The edge rows of the reference harness (scripts/lib/harness-edges.ts): a synthetic data folder with one corpus turn
// in a channel, stored attitudes, a session move on each side of the cut, a stretch, and an archived read of a second
// channel, enlarged by `applyEdges`. Synthetic Greek and accented Latin text only; nothing leaves the process.

import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { applyEdges } from '../../../scripts/lib/harness-edges.ts';
import { DELETED_LINES_MAX } from '../../../src/behavior/deleted-lines.ts';
import { CHANNEL_HANDLE_PREFIX, handleOf } from '../../../src/behavior/handles.ts';
import { applyMemoryWrite } from '../../../src/memory/db/session-write.ts';
import { fillEnvAudiences } from '../../fixtures/memory-db/audiences.ts';
import {
  ADA,
  BOB,
  CHANNEL,
  GUILD,
  MINUTE,
  NOW,
  baseConfig,
  channelPlaceOf,
  fixture,
  guildPlaceOf,
  personOf,
} from '../../fixtures/memory-db/session-rig.ts';
import { tempDir } from '../../fixtures/tmp.ts';

const ROOT = path.resolve(import.meta.dirname, '../../..');
const TURN = 't-1';
const TURN_AT = NOW - 10 * MINUTE;
const TRIGGER_AT = NOW - 60 * MINUTE;
const OTHER = channelPlaceOf('c2');
/** How many lines the archived read asks of the second channel, which holds two. */
const ASKED = 5;
const iso = (ms: number): string => new Date(ms).toISOString();

/** A line of `author` in the native channel `chat`, as the record stores it, with its message reference. */
function line(n: number, chat: string, author: string, at: number, text: string) {
  return {
    line: {
      v: 1,
      id: `line-${n}`,
      kind: 'seen',
      messageId: `m${n}`,
      revision: 1,
      occurredAt: iso(at),
      recordedAt: iso(at),
      scope: { channel: chat },
      by: author,
      replyTo: null,
      text,
      media: [],
      mentions: [],
      direct: false,
      participants: [author],
      sourceMessageIds: [`m${n}`],
      origin: 'live',
    },
    messages: [{ lineId: `line-${n}`, locator: { iface: 'discord', chatId: chat, messageId: `m${n}` } }],
  };
}

/** A line of the persona in the native channel `chat`, as the record stores it, with its message reference. */
function said(n: number, chat: string, at: number, text: string) {
  const { line: seen, messages } = line(n, chat, '', at, text);
  // A line of the persona's names no author and no address.
  const own: Record<string, unknown> = { ...seen, kind: 'said', participants: [], turnId: null, opId: null };
  delete own.by;
  delete own.direct;
  return { line: own as typeof seen, messages };
}

/** A data folder holding the corpus turn `TURN`, answering the trigger line `m5` of Ada in the channel. */
function dataFolder(): string {
  const dir = tempDir('nep-harness-edges-data-');
  fs.mkdirSync(path.join(dir, 'config'));
  fs.writeFileSync(path.join(dir, 'config', 'config.json'), JSON.stringify(baseConfig()));
  const env = fixture();
  try {
    const { db } = env;
    db.prepare(
      "INSERT INTO places (id, iface, kind, native_id, parent_id, scope_kind, chat, name) VALUES (?, 'discord', 'channel', 'c2', ?, 'group', 'group', 'off-topic')"
    ).run(OTHER, guildPlaceOf(GUILD));
    db.prepare("UPDATE places SET chat = 'group' WHERE id = ?").run(CHANNEL);
    const written = [
      ...['Καλημέρα', 'ναι, σωστά', 'café?', 'ωραία', 'I moved to Thessaloniki'].map((text, index) => ({
        place: CHANNEL,
        ...line(index + 1, 'c1', index % 2 === 0 ? ADA : BOB, TRIGGER_AT - (4 - index) * 10 * MINUTE, text),
      })),
      // The persona's own line in the channel, the day the turn starts.
      { place: CHANNEL, ...said(8, 'c1', TRIGGER_AT - 15 * MINUTE, 'γεια σας') },
      { place: OTHER, ...line(6, 'c2', BOB, NOW - 50 * MINUTE, 'Ἀθήνα') },
      { place: OTHER, ...line(7, 'c2', BOB, NOW - 40 * MINUTE, 'σήμερα') },
    ];
    for (const one of written)
      applyMemoryWrite(env.handle, {
        kind: 'record-lines',
        placeId: one.place,
        lines: [one.line],
        messages: one.messages,
        iface: 'discord',
        now: Date.parse(one.line.occurredAt),
      });
    fillEnvAudiences(env);
    const trigger = { kind: 'mention', messageId: 'm5', authorId: ADA };
    db.prepare("INSERT INTO day (id, at, what, place_id, turn_id, extra) VALUES ('d-1', ?, 'turn.start', ?, ?, ?)").run(
      iso(TURN_AT),
      CHANNEL,
      TURN,
      JSON.stringify({ mode: 'reply', trigger })
    );
    // Ada's attitude is the strongest, moved by a session before the cut; Bob's is moved by a session after it.
    db.prepare('UPDATE people SET meta = 1 WHERE id = ?').run(personOf(ADA));
    db.prepare(
      "INSERT INTO person_accounts (id, person_id, iface, platform_id, display_name, recorded_at) VALUES (?, ?, 'discord', ?, 'Ἄδα', ?)"
    ).run(`discord:${ADA}`, personOf(ADA), ADA, iso(NOW - 1000 * MINUTE));
    const move = db.prepare(
      "INSERT INTO affinity_events (id, person_id, at, delta, applied, score, reason, audience_id, writer) VALUES (?, ?, ?, 5, 5, ?, 'κάτι', 'aud:group:discord', 'session')"
    );
    move.run('aff:1', personOf(ADA), iso(NOW - 300 * MINUTE), -60);
    move.run('aff:2', personOf(BOB), iso(NOW - 5 * MINUTE), 30);
    db.prepare(
      `INSERT INTO episodes (id, kind, subject_id, place_id, what, start_ms, last_ms, scope_kind, scope_iface, created_at,
         audience_id, writer, holder_id)
       VALUES ('stretch:1', 'stretch', 'person:self', ?, 'μια κουβέντα', ?, ?, 'group', 'discord', ?, 'aud:group:discord', 'stretch', ?)`
    ).run(CHANNEL, TRIGGER_AT - 40 * MINUTE, TRIGGER_AT, iso(TRIGGER_AT), CHANNEL);
    const call = {
      name: 'conversation_read',
      parsed: { place: `#${handleOf('c2', 4, CHANNEL_HANDLE_PREFIX)}`, last: ASKED },
    };
    db.prepare(
      `INSERT INTO model_requests (id, schema_version, purpose, status, started_at, messages, turn_id, step, tool_calls)
       VALUES ('rq-1', 1, 'reply', 'ok', ?, '[]', ?, 0, ?)`
    ).run(iso(TURN_AT), TURN, JSON.stringify([call]));
    db.exec(`VACUUM INTO '${path.join(dir, 'memory.db')}'`);
  } finally {
    env.done();
  }
  return dir;
}

/** The folder after `applyEdges`, its counts and a read-only connection to its memory. */
async function edged(dir = dataFolder()) {
  const counts = await applyEdges({ root: ROOT, dataDir: dir, corpus: [{ group: 'reply:mention', turnId: TURN }] });
  return { dir, counts, db: new DatabaseSync(path.join(dir, 'memory.db'), { readOnly: true }) };
}

test('retires the people a session moved after the cut, before the cut, and no one moved only earlier', async () => {
  // Catches: a session move after the cut that meets only live people, so no replayed move reaches a retired one.
  const { db } = await edged();
  const retired = db.prepare('SELECT id, retired_at FROM people WHERE retired_at IS NOT NULL').all();
  assert.deepEqual(
    retired.map((row) => row.id),
    [personOf(BOB)]
  );
  assert.ok(String(retired[0]?.retired_at) < iso(TURN_AT));
});

test('names the person of the strongest attitude with markup', async () => {
  // Catches: an attitudes block whose names never hold a character a request must escape.
  const { db } = await edged();
  const names = db.prepare('SELECT person_id, display_name FROM person_accounts').all();
  assert.deepEqual(
    names.map((row) => [row.person_id, String(row.display_name).includes('<')]),
    [[personOf(ADA), true]]
  );
});

test('adds to the place the persona wrote in before the turn a retired stretch that outlasts its stretches', async () => {
  // Catches: a retired stretch that a live one outlasts, which the day of a request would never pick.
  const { db } = await edged();
  const rows = db
    .prepare(
      "SELECT last_ms, retired_at FROM episodes WHERE holder_id = ? AND retired_at IS NOT NULL AND kind = 'stretch'"
    )
    .all(CHANNEL);
  assert.equal(rows.length, 1);
  assert.ok(Number(rows[0]?.last_ms) > TURN_AT);
  assert.ok(String(rows[0]?.retired_at) < iso(TURN_AT));
});

test('records one more deleted line than a window keeps, right before the trigger of the corpus turn', async () => {
  // Catches: deletions that fit the window's cap, so the newest and the oldest of them are the same placeholders.
  const { db } = await edged();
  const deleted = db
    .prepare("SELECT occurred_at FROM sources WHERE place_id = ? AND kind = 'deleted' ORDER BY occurred_at")
    .all(CHANNEL);
  assert.equal(deleted.length, DELETED_LINES_MAX + 1);
  assert.ok(String(deleted.at(-1)?.occurred_at) < iso(TRIGGER_AT));
  assert.ok(String(deleted[0]?.occurred_at) > iso(TRIGGER_AT - 10 * MINUTE));
});

test('fills the place an archived read names up to exactly the count it asked, before the turn', async () => {
  // Catches: a read that finds more or fewer lines than it asked, so `enough` reads the same at either bound.
  const { db } = await edged();
  const lines = db
    .prepare("SELECT occurred_at FROM sources WHERE place_id = ? AND kind = 'seen' AND occurred_at < ?")
    .all(OTHER, iso(TURN_AT));
  assert.equal(lines.length, ASKED);
});

test('writes byte-identical databases into two copies of one folder', async () => {
  // Catches: a random id or a wall time in an edge row, which makes two runs of one tree differ.
  const first = dataFolder();
  const second = tempDir('nep-harness-edges-copy-');
  fs.cpSync(first, second, { recursive: true });
  const a = await edged(first);
  const b = await edged(second);
  a.db.close();
  b.db.close();
  assert.deepEqual(b.counts, a.counts);
  assert.ok(fs.readFileSync(path.join(first, 'memory.db')).equals(fs.readFileSync(path.join(second, 'memory.db'))));
});
