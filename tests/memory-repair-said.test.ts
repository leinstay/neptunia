// The one-off repair of her doubled lines, on synthetic rows of the shape the old writer left: the echo's row under its
// family key and a `live` row of the same message under its protocol id.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { main, repairSaid } from '../scripts/memory-repair-said.ts';
import { tableHashes } from '../scripts/memory-db.ts';
import { observationOf } from '../src/memory/db/observe-event.ts';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { createRecord } from '../src/memory/record.ts';
import { dbOf } from '../src/memory/db/types.ts';
import { openTestMemory } from './fixtures/memory-db/service.ts';
import type { Db, MemoryHandle, Row } from '../src/memory/db/types.ts';

const NOW = Date.parse('2026-11-05T12:00:00.000Z');
const SENT = Date.parse('2026-11-04T12:00:00.000Z');
const IFACE = 'synthetic';
const COMMUNITY = 'community';
const ROOM = 'room-a';
const HER = 'her-account';
const MEMBER = 'member-account';
const WORDS = 'το φανάρι στην αυλή';
const LIVE_ID = 'src:synthetic:sent-1:1:said';

type Rig = { handle: MemoryHandle; db: Db; file: string; dataDir: string; kept: string };

function lineEvent(
  id: string,
  author: string,
  at: number,
  replyToId?: string,
  mentionedAccountIds: Array<string> = []
) {
  return {
    iface: IFACE,
    at,
    conversation: { id: ROOM, kind: 'channel', chatType: 'channel', rootId: COMMUNITY },
    addressing: { mentionedAccountIds },
    message: {
      id,
      at,
      content: WORDS,
      author: { id: author, self: author === HER },
      ...(replyToId ? { replyToId } : {}),
    },
  };
}

/** The live row the old writer added beside the echo's row: the same message under its protocol id. */
function oldLiveRow(db: Db, kept: string, overrides: Row = {}): void {
  const row: Row = {
    ...db.prepare('SELECT * FROM sources WHERE id = ?').get(kept),
    id: LIVE_ID,
    native_id: 'sent-1',
    origin: 'live',
    turn_id: 't-1',
    op_id: 'op-1',
    media: '["image"]',
    author_account: null,
    position: 99,
    extra: JSON.stringify({
      v: 1,
      id: 'line-1',
      participants: [MEMBER],
      $messageLocator: { v: 1, origin: 'record-v1', iface: IFACE, conversationId: ROOM, messageId: 'sent-1' },
    }),
    ...overrides,
  };
  delete row.rowid;
  const columns = Object.keys(row);
  db.prepare(`INSERT INTO sources (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`).run(
    ...columns.map((column) => row[column])
  );
}

/** Her echoed line naming a member, a member's greeting before it and a member's reply to it, then the old live row. */
async function rig(overrides: Row = {}): Promise<Rig> {
  const memory = await openTestMemory({ now: () => NOW, iface: () => IFACE });
  const observe = async (event: ReturnType<typeof lineEvent>): Promise<string> => {
    const done = await memory.memoryDb.observeMessage(observationOf(event, { selfId: HER }), { placeId: COMMUNITY });
    return String((done as Row).sourceId);
  };
  await observe(lineEvent('hello-1', MEMBER, SENT - 1000));
  const kept = await observe(lineEvent('sent-1', HER, SENT, undefined, [MEMBER]));
  await observe(lineEvent('reply-1', MEMBER, SENT + 1000, 'sent-1'));
  await memory.close();
  const file = path.join(memory.dataDir, 'memory.db');
  const handle = openMemoryDb(file);
  const db = dbOf(handle);
  oldLiveRow(db, kept, overrides);
  return { handle, db, file, dataDir: memory.dataDir, kept };
}

const repair = (r: Rig) => repairSaid(r.handle, { now: () => NOW });
const current = (db: Db): Array<Row> =>
  db.prepare("SELECT * FROM sources WHERE kind = 'said' AND retired_at IS NULL").all();

async function withRig(run: (r: Rig) => Promise<void> | void, overrides: Row = {}): Promise<void> {
  const r = await rig(overrides);
  try {
    await run(r);
  } finally {
    r.handle.close();
  }
}

test('a doubled line keeps the observation row with the turn, the operation and the media of the live row', async () => {
  // Bug: the row replies and episodes attach to has no turn, so nothing joins it to her attempt.
  await withRig((r) => {
    repair(r);
    const rows = current(r.db);
    assert.deepEqual(
      rows.map((row) => [row.id, row.turn_id, row.op_id, row.media]),
      [[r.kept, 't-1', 'op-1', '["image"]']]
    );
    assert.equal(
      r.db.prepare('SELECT retired_at FROM sources WHERE id = ?').get(LIVE_ID)?.retired_at,
      new Date(NOW).toISOString()
    );
  });
});

test('the kept row keeps its media when the live row recorded none', async () => {
  // Bug: a live line with no media would erase what the echo saw on the message.
  await withRig(
    (r) => {
      r.db.prepare('UPDATE sources SET media = ? WHERE id = ?').run('["gif"]', r.kept);
      repair(r);
      assert.equal(current(r.db)[0]?.media, '["gif"]');
    },
    { media: null }
  );
});

test('a live row whose text differs from the echo stays apart and is counted', async () => {
  // Bug: a pair by id alone would retire a line that says something else than the row it is folded into.
  await withRig(
    (r) => {
      const done = repair(r);
      assert.equal(done.pairs, 0);
      assert.equal(done.different, 1);
      assert.equal(current(r.db).length, 2);
    },
    { text: 'άλλη κουβέντα' }
  );
});

test('a live row whose time differs from the echo stays apart', async () => {
  // Bug: the same message id at another time is not the row the pair rule proves it to be.
  await withRig(
    (r) => {
      assert.equal(repair(r).pairs, 0);
      assert.equal(current(r.db).length, 2);
    },
    { occurred_at: new Date(SENT + 5000).toISOString() }
  );
});

test('a claim citing the live row cites the kept row, once when it already cited both', async () => {
  // Bug: the claim's evidence stands on a retired row, or names one line twice.
  await withRig((r) => {
    const link = r.db.prepare('INSERT INTO claim_sources (claim_id, source_id, position) VALUES (?, ?, ?)');
    r.db.prepare("INSERT INTO claims (id) VALUES ('claim-1'), ('claim-2')").run();
    link.run('claim-1', LIVE_ID, 0);
    link.run('claim-2', LIVE_ID, 0);
    link.run('claim-2', r.kept, 1);
    repair(r);
    const live = (claim: string) =>
      r.db
        .prepare('SELECT source_id FROM claim_sources WHERE claim_id = ? AND retired_at IS NULL')
        .all(claim)
        .map((row) => row.source_id);
    assert.deepEqual(live('claim-1'), [r.kept]);
    assert.deepEqual(live('claim-2'), [r.kept]);
  });
});

test('a claim version citing the live row cites the kept row, once when it already cited both', async () => {
  // Bug: the primary key refuses the second link, or a version's sources name a retired row.
  await withRig((r) => {
    r.db.prepare("INSERT INTO claims (id) VALUES ('claim-1')").run();
    r.db.prepare("INSERT INTO claim_versions (id, claim_id) VALUES ('v-1', 'claim-1'), ('v-2', 'claim-1')").run();
    const link = r.db.prepare(
      "INSERT INTO claim_version_sources (version_id, source_id, role) VALUES (?, ?, 'supports')"
    );
    link.run('v-1', LIVE_ID);
    link.run('v-2', LIVE_ID);
    link.run('v-2', r.kept);
    repair(r);
    const rows = r.db.prepare('SELECT version_id, source_id FROM claim_version_sources ORDER BY version_id').all();
    assert.deepEqual(
      rows.map((row) => [row.version_id, row.source_id]),
      [
        ['v-1', r.kept],
        ['v-2', r.kept],
      ]
    );
  });
});

test('an episode citing the live row cites the kept row', async () => {
  // Bug: the episode's evidence reads as gone once the live row is retired.
  await withRig((r) => {
    r.db.prepare("INSERT INTO episodes (id) VALUES ('episode-1')").run();
    r.db
      .prepare("INSERT INTO episode_sources (episode_id, source_id, position) VALUES ('episode-1', ?, 0)")
      .run(LIVE_ID);
    repair(r);
    assert.equal(r.db.prepare('SELECT source_id FROM episode_sources').get()?.source_id, r.kept);
  });
});

test('a relation resolved to the live row points at the kept row', async () => {
  // Bug: a reply stays attached to the retired row and her line looks unanswered.
  await withRig((r) => {
    r.db
      .prepare(
        "INSERT INTO source_relations (source_id, predicate, target_key, target_source_id, recorded_at, resolved_at) VALUES (?, 'replies_to', 'other-target', ?, 'x', 'x')"
      )
      .run(r.db.prepare("SELECT id FROM sources WHERE native_id != 'sent-1' AND kind = 'seen'").get()?.id, LIVE_ID);
    repair(r);
    assert.equal(
      r.db.prepare('SELECT COUNT(*) AS n FROM source_relations WHERE target_source_id = ?').get(LIVE_ID)?.n,
      0
    );
  });
});

test('a relation of the live row is copied to the kept row, and one the kept row holds is not doubled', async () => {
  // Bug: the line her reply made leaves with the retired row, or the kept row replies twice to one line.
  await withRig((r) => {
    const member = r.db.prepare("SELECT id FROM sources WHERE kind = 'seen' ORDER BY rowid LIMIT 1").get()?.id;
    const add = r.db.prepare(
      "INSERT INTO source_relations (source_id, predicate, target_key, target_source_id, recorded_at, resolved_at) VALUES (?, 'replies_to', ?, ?, 'x', 'x')"
    );
    add.run(LIVE_ID, 'protocol-target', member);
    repair(r);
    const held = r.db
      .prepare("SELECT target_source_id FROM source_relations WHERE source_id = ? AND predicate = 'replies_to'")
      .all(r.kept);
    assert.deepEqual(
      held.map((row) => row.target_source_id),
      [member]
    );
    // A second relation to the same line under another key is the same reply.
    add.run(LIVE_ID, 'protocol-target-2', member);
    r.db.prepare('UPDATE sources SET retired_at = NULL WHERE id = ?').run(LIVE_ID);
    repair(r);
    assert.equal(
      r.db
        .prepare("SELECT COUNT(*) AS n FROM source_relations WHERE source_id = ? AND predicate = 'replies_to'")
        .get(r.kept)?.n,
      1
    );
  });
});

test('a vector of the live row moves to the kept row, and a second one of that row is retired', async () => {
  // Bug: meaning search joins the retired row, or one line takes two of its slots.
  await withRig((r) => {
    const rowid = (id: string) => r.db.prepare('SELECT rowid FROM sources WHERE id = ?').get(id)?.rowid;
    const add = r.db.prepare("INSERT INTO vectors (chunk_key, source_rowid, model, dims) VALUES (?, ?, 'm', 2)");
    add.run('record:sent-1:1', rowid(LIVE_ID));
    repair(r);
    assert.equal(
      r.db.prepare("SELECT source_rowid FROM vectors WHERE chunk_key = 'record:sent-1:1'").get()?.source_rowid,
      rowid(r.kept)
    );
    r.db.prepare('UPDATE sources SET retired_at = NULL WHERE id = ?').run(LIVE_ID);
    add.run('record:sent-1:1#2', rowid(LIVE_ID));
    repair(r);
    assert.equal(
      r.db.prepare("SELECT retired_at FROM vectors WHERE chunk_key = 'record:sent-1:1#2'").get()?.retired_at,
      new Date(NOW).toISOString()
    );
  });
});

test('an unlinked vector of a member line is linked with no model call', async () => {
  // Bug: 254 of 285 vectors stayed out of meaning search, because their chunk key names the protocol id.
  await withRig((r) => {
    r.db
      .prepare("INSERT INTO vectors (chunk_key, source_rowid, model, dims) VALUES ('record:reply-1:1', NULL, 'm', 2)")
      .run();
    const done = repair(r);
    assert.equal(done.vectorsLinked, 1);
    const row = r.db.prepare("SELECT source_rowid FROM vectors WHERE chunk_key = 'record:reply-1:1'").get();
    const reply = r.db
      .prepare("SELECT rowid FROM sources WHERE json_extract(extra, '$.\"$messageLocator\".messageId') = 'reply-1'")
      .get();
    assert.equal(row?.source_rowid, reply?.rowid);
  });
});

test('the daily count of her line drops to one after the repair', async () => {
  // Bug: relationship_daily keeps the count the doubled lines raised until someone recounts it.
  await withRig((r) => {
    const account = r.db.prepare('SELECT id, authority_id FROM accounts WHERE native_key = ?').get(MEMBER);
    r.db
      .prepare("INSERT INTO people (id, kind, first_seen_at) VALUES ('person:member', 'person', ?)")
      .run(new Date(SENT - 1000).toISOString());
    r.db
      .prepare(
        "INSERT INTO account_person_links (id, account_id, person_id, state, valid_from_at, recorded_at) VALUES ('link:member', ?, 'person:member', 'verified', NULL, ?)"
      )
      .run(account?.id, new Date(SENT - 1000).toISOString());
    repair(r);
    const row = r.db
      .prepare("SELECT addressed_by_her AS her FROM relationship_daily WHERE person_id = 'person:member'")
      .get();
    assert.equal(row?.her, 1);
  });
});

test('the record lists a repaired line once under its protocol id', async () => {
  // Bug: every reader of the record (a conversation read, the heartbeat view) shows it twice.
  const r = await rig();
  repair(r);
  r.handle.close();
  const memory = await openTestMemory({ dataDir: r.dataDir, now: () => NOW, iface: () => IFACE });
  try {
    const lines: Array<{ kind?: unknown; messageId?: unknown }> = [];
    for await (const item of createRecord({ ...memory, now: () => NOW }).iterate(COMMUNITY)) lines.push(item);
    assert.deepEqual(
      lines.filter((line) => line.kind === 'said').map((line) => line.messageId),
      ['sent-1']
    );
  } finally {
    await memory.close();
  }
});

test('a second run changes nothing', async () => {
  // Bug: a one-off run twice by hand must not move a row, a count or an edge.
  await withRig((r) => {
    r.db
      .prepare("INSERT INTO vectors (chunk_key, source_rowid, model, dims) VALUES ('record:reply-1:1', NULL, 'm', 2)")
      .run();
    repair(r);
    const tables = [
      'sources',
      'source_relations',
      'claim_sources',
      'claim_version_sources',
      'vectors',
      'relationship_daily',
      'graph_edges',
      'node_access',
    ];
    const before = tableHashes(r.db, tables);
    const done = repairSaid(r.handle, { now: () => NOW + 60_000 });
    assert.equal(done.pairs, 0);
    assert.equal(done.vectorsLinked, 0);
    assert.deepEqual(tableHashes(r.db, tables), before);
  });
});

test('the command writes nothing without --apply and says only counts', async () => {
  // Bug: a dry run that touches the file, or a report that carries her words out of the database.
  const r = await rig();
  r.handle.close();
  const reopen = () => {
    const h = openMemoryDb(r.file, { readOnly: true });
    const hashes = tableHashes(dbOf(h));
    h.close();
    return hashes;
  };
  const before = reopen();
  const out = await main(['--db', r.file]);
  assert.deepEqual(reopen(), before);
  assert.match(out, /pairs 1/);
  assert.equal(out.includes(WORDS), false);
});

test('the command with --apply repairs the file and says only counts', async () => {
  // Bug: the flag parses and the repair runs on a copy, so nothing is fixed.
  const r = await rig();
  r.handle.close();
  const out = await main(['--db', r.file, '--apply']);
  assert.match(out, /pairs 1/);
  assert.equal(out.includes(WORDS), false);
  const h = openMemoryDb(r.file, { readOnly: true });
  try {
    assert.equal(current(dbOf(h)).length, 1);
  } finally {
    h.close();
  }
});
