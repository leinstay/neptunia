// What src/memory/migration/dm-repair.ts moves in the offline conversion beyond the lines themselves: the graph that was
// projected from a misfiled line, a DM place's own notes, and the units the moved rows land in. Over the frozen synthetic
// v28 database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { placeCollection, storageId } from '../src/memory/db/storage-keys.ts';
import { convert, rowsOf, scene } from './fixtures/memory-db/one-server.ts';
import type { Row, Scene } from './fixtures/memory-db/one-server.ts';

const DM = 'discord:dm:u1';
const DM_AUDIENCE = `aud:dm:${DM}`;
const GUILD_RECORD = 'unit:c676dd55b9f169af18945bcc0bf315e1';
const AT = '2026-10-01T12:00:00.000Z';
const LINE = 'wake-in-dm';

function said(db: DatabaseSync, id: string, conversation: string): void {
  db.prepare(
    `INSERT INTO sources (id, kind, iface, native_id, revision, place_id, occurred_at, recorded_at, text, extra,
       scope_kind, scope_iface, origin, position, authority_id, author_kind, audience_id, native_kind, generation, owner_key)
     VALUES (?, 'said', 'discord', ?, 1, ?, ?, ?, 'her words', '{"v":1}', 'group', 'discord', 'live', 90, 'discord/global',
       'self', 'aud:group:discord', 'message', 1, ?)`
  ).run(id, id, `discord:channel:${conversation}`, AT, AT, GUILD_RECORD);
}

function misfiledWithGraph(db: DatabaseSync): void {
  said(db, LINE, 'dm-native');
  const node = `source:${LINE}`;
  const addNode = db.prepare(`INSERT INTO graph_nodes (id, kind, row_id, created_at) VALUES (?, ?, ?, ?)`);
  addNode.run(node, 'source', LINE, AT);
  addNode.run('place:ghost', 'place', 'ghost', AT);
  db.prepare(
    `INSERT INTO graph_edges (id, src, predicate, dst, audience_id, evidence_id, recorded_at, projection_key, owner_key)
     VALUES ('edge-1', ?, 'located_in', 'place:ghost', 'aud:group:discord', ?, ?, 'located_in:wake', ?)`
  ).run(node, LINE, AT, GUILD_RECORD);
  const witness = db.prepare(
    `INSERT INTO node_access (node_id, audience_id, evidence_id) VALUES (?, 'aud:group:discord', ?)`
  );
  witness.run(node, node);
  witness.run('place:ghost', 'edge-1');
}

let repaired: Scene | null = null;
function withGraph(): Scene {
  if (repaired !== null) return repaired;
  const where = scene(misfiledWithGraph);
  const { status, stderr } = convert(where);
  assert.equal(status, 0, stderr);
  repaired = where;
  return where;
}

test("the graph edge of a moved line takes the DM's audience and its record unit", () => {
  // Bug: the line is repaired and the traversal from a group still walks to it.
  const edge = rowsOf(withGraph().output, 'graph_edges').find((row) => row.id === 'edge-1');
  const unit = storageId(placeCollection('record', DM, { partition: '2026-10-01' }));
  assert.deepEqual([edge?.audience_id, edge?.owner_key], [DM_AUDIENCE, unit]);
});

test('every witness of a moved line takes the DM audience', () => {
  // Bug: a witness under the group's audience keeps the line's node visible to a group.
  const left = rowsOf(withGraph().output, 'node_access').filter(
    (row) => row.evidence_id === 'edge-1' || row.evidence_id === `source:${LINE}`
  );
  assert.deepEqual(
    left.map((row) => row.audience_id),
    [DM_AUDIENCE, DM_AUDIENCE]
  );
});

test('the report counts the rows it moved, per table', () => {
  // Bug: a repair nobody can see cannot be checked against what the old database held.
  const report = JSON.parse(fs.readFileSync(withGraph().report, 'utf8')) as { movedToDm: Record<string, number> };
  assert.deepEqual([report.movedToDm.sources, report.movedToDm.graph_edges, report.movedToDm.node_access], [1, 1, 2]);
});

test('a moved line carries the private mark its partner reads it by', () => {
  // Bug: without the mark the record reader treats the line as a group's with no channel, and the partner never finds it.
  const line = rowsOf(withGraph().output, 'sources').find((row) => row.id === LINE) as Row;
  const extra = JSON.parse(String(line.extra)) as { scope: unknown };
  assert.deepEqual(extra.scope, { user: 'u1', private: true, channel: 'dm-native' });
});

test('the unit a moved line lands in counts past its last position', () => {
  // Bug: the next append in that DM takes a position a moved line holds.
  const unit = storageId(placeCollection('record', DM, { partition: '2026-10-01' }));
  const held = rowsOf(withGraph().output, 'sources').filter((row) => row.owner_key === unit);
  const row = rowsOf(withGraph().output, 'storage_units').find((one) => one.id === unit) as Row;
  assert.equal(row.lines, Math.max(...held.map((one) => Number(one.position))) + 1);
});

test("a DM place's lesson written as a group's takes the DM's scope", () => {
  // Bug: the old mapper wrote every lesson `group`, and the new one only fixes the next write.
  const where = scene((db) => {
    db.prepare(
      `INSERT INTO claims (id, subject_kind, subject_id, kind, text, scope_kind, scope_iface, audience_id, truth, shown)
       VALUES ('lesson-dm', 'place', ?, 'lesson', 'a lesson', 'group', 'discord', 'aud:group:discord', 'current', 1)`
    ).run(DM);
  });
  assert.equal(convert(where).status, 0);
  const row = rowsOf(where.output, 'claims').find((one) => one.id === 'lesson-dm');
  assert.deepEqual([row?.scope_kind, row?.scope_dm, row?.audience_id], ['dm', 'person:discord:u1', DM_AUDIENCE]);
});

test('a conversation two partners each name stays where it was', () => {
  // Bug: the first DM to name a shared id takes the lines of the other.
  const where = scene((db) => {
    said(db, 'contested', 'shared-native');
    const line = db.prepare(
      `INSERT INTO sources (id, kind, iface, native_id, revision, place_id, author_account, occurred_at, recorded_at, text, extra,
         scope_kind, scope_iface, origin, authority_id, author_kind, audience_id, native_kind, generation)
       VALUES (?, 'seen', 'discord', ?, 1, ?, ?, ?, ?, 'a line', ?, 'dm', 'discord', 'live', 'discord/global', 'account', ?, 'message', 1)`
    );
    const extra = JSON.stringify({ $messageLocator: { conversationId: 'shared-native' } });
    line.run('u1-names', 'u1-names', DM, 'discord:u1', AT, AT, extra, DM_AUDIENCE);
    line.run('u2-names', 'u2-names', 'discord:dm:u2', 'discord:u2', AT, AT, extra, 'aud:dm:discord:dm:u2');
  });
  assert.equal(convert(where).status, 0);
  const row = rowsOf(where.output, 'sources').find((one) => one.id === 'contested');
  assert.deepEqual([row?.scope_kind, row?.place_id], ['group', 'discord:channel:shared-native']);
});
