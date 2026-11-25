import { test, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { topPlaceSpelled } from '../../../../src/memory/db/ids.ts';
import { lineMedia, mediaMessageParts } from '../../../../src/memory/db/media-store.ts';
import { storedMediaTags } from '../../../../src/format.ts';
import { peopleOfHandle, directChatsOf } from '../../../../src/memory/db/direct-chats.ts';
import { observationOf } from '../../../../src/memory/db/observe-event.ts';
import { internalContext, groupContext } from '../../../../src/memory/db/scope.ts';
import { createRecord, toRecordLine } from '../../../../src/memory/record.ts';
import { SELF_ID, KINDS, LABELS, eventOf } from '../../../fixtures/media-memory.ts';
import { openTestMemory } from '../../../fixtures/memory-db/service.ts';
import type { Kind } from '../../../fixtures/media-memory.ts';
import type { Db, Row } from '../../../../src/memory/db/types.ts';
import { handleOf } from '../../../../src/behavior/handles.ts';
import { pendingObjectEmbeds } from '../../../../src/memory/db/object-vectors.ts';
import { insertRows } from '../../../../src/memory/db/rows.ts';
import { applyMemoryWrite } from '../../../../src/memory/db/session-write.ts';
import { graphNodeId } from '../../../../src/memory/db/graph.ts';
import {
  AT,
  addDm,
  addLine,
  addPerson,
  noteInterface,
  openWorld,
  rekeyNode,
} from '../../../fixtures/memory-db/mind-world.ts';
import type { World } from '../../../fixtures/memory-db/mind-world.ts';

const internal = internalContext();
const named = (name: string) => KINDS.find((kind) => kind.name === name) as Kind;

// ---------- the persona's own voice message ----------

const MEMORY_NOW = Date.parse('2026-10-24T12:00:00.000Z');
const SENT = MEMORY_NOW - 60_000;
const IFACE = 'synthetic';
const TOP = topPlaceSpelled(IFACE, 'root');

type Memory = Awaited<ReturnType<typeof openTestMemory>>;

// ---------- the marks on what the persona made ----------

const ROOM = { id: 'room-a', kind: 'channel', chatType: 'channel', rootId: 'root' };

/** A line of Alice's in the room, so Alice's account and person exist; answers the person id. */
async function aliceSpeaks(memory: Memory): Promise<string> {
  const event = eventOf(named('image'), 'alice-1', [false, false], {
    at: SENT - 1000,
    iface: IFACE,
    chat: ROOM,
    author: { id: 'u-alice', name: 'Alice' },
  });
  const envelope = observationOf(event, { selfId: SELF_ID });
  assert.ok(envelope);
  await memory.memoryDb.observeMessage(envelope, { placeId: TOP });
  const db = memory.memoryDb.database() as Db;
  const person = db.prepare("SELECT person_id FROM accounts WHERE iface = ? AND native_id = 'u-alice'").get(IFACE);
  return person?.person_id as string;
}

async function echoDrawing(memory: Memory) {
  const event = eventOf(named('image'), 'drawn-1', [false, false], {
    at: SENT,
    iface: IFACE,
    chat: ROOM,
    author: { id: SELF_ID, self: true },
  });
  (event.message as Row).attachments = [{ id: 'pic-1', kind: 'image', name: 'drawing.png' }];
  const envelope = observationOf(event, { selfId: SELF_ID });
  assert.ok(envelope);
  await memory.memoryDb.observeMessage(envelope, { placeId: TOP });
}

/** The record line of the persona's posted drawing, with the marks of their draw.create call: the persona and Alice. */
async function recordDrawing(memory: Memory) {
  const line = toRecordLine(
    {
      id: 'drawn-1',
      placeId: 'room-a',
      content: '',
      ts: SENT,
      replyToId: null,
      mentionedAccountIds: [],
      attachments: [{ id: 'pic-1', kind: 'image' }],
      marks: { self: true, accounts: ['u-alice'] },
    },
    { kind: 'said', now: () => MEMORY_NOW, turnId: 't-2', opId: 'op-2' }
  );
  await createRecord({ ...memory, now: () => MEMORY_NOW }).append(TOP, [line], {});
}

const MARK_LABELS = {
  ...LABELS,
  transcript: {
    ...LABELS.transcript,
    mediaMade: '[MADE]',
    mediaDepicts: '[SHOWS {names}]',
    mediaDepictsSelf: 'HERSELF',
  },
};

/** The tags of the persona's line `drawn-1` as a request renders a stored line, after its picture was told `a fox`. */
function drawnTags(memory: Memory): Array<string> {
  const db = memory.memoryDb.database() as Db;
  const source = String(db.prepare("SELECT id FROM sources WHERE kind = 'said'").get()?.id);
  db.prepare("UPDATE media SET description = 'a fox', availability = 'present' WHERE native_ref = 'pic-1'").run();
  const rows = lineMedia(db, [source], internal, 'source').get(source) ?? [];
  return storedMediaTags(mediaMessageParts(rows, source), MARK_LABELS);
}

test('the handle a mark shows resolves to the person it depicts, with no chat window at hand', async () => {
  // Bug: the mark shows a name or a handle of one request only, which a person argument read elsewhere cannot resolve.
  const memory = await openTestMemory({ now: () => MEMORY_NOW, iface: () => IFACE });
  try {
    const alice = await aliceSpeaks(memory);
    await echoDrawing(memory);
    await recordDrawing(memory);
    const shown = /\[SHOWS HERSELF, @(\S+)\]/u.exec(drawnTags(memory).at(-1) ?? '')?.[1] ?? '';
    assert.deepEqual([...peopleOfHandle(memory.memoryDb.database() as Db, shown)], [alice]);
  } finally {
    await memory.close();
  }
});

const worlds: Array<World> = [];

const OWNER = 'person:owner';

/** The owner with an account on the fake interface and one on the command line, a direct chat on each. */
function world(): { w: World; fakeDm: string; cliDm: string } {
  const w = openWorld();
  worlds.push(w);
  noteInterface(w, 'fake', [{ id: 'g1', name: 'Αγορά' }]);
  addPerson(w.db, {
    id: OWNER,
    accounts: [
      { id: 'fake:777', iface: 'fake', native: '777', names: ['Ορέστης'] },
      { id: 'cli:owner', iface: 'cli', native: 'owner', names: ['Ορέστης'] },
    ],
  });
  const fakeDm = addDm(w.db, { iface: 'fake', native: '777', person: OWNER, account: 'fake:777' });
  const cliDm = addDm(w.db, { iface: 'cli', native: 'owner', person: OWNER, account: 'cli:owner' });
  addLine(w.db, {
    id: 'f1',
    iface: 'fake',
    place: fakeDm,
    author: 'fake:777',
    text: 'γεια',
    at: '2026-11-01T09:00:00.000Z',
    audience: { dm: fakeDm, iface: 'fake', person: OWNER },
  });
  addLine(w.db, {
    id: 'c1',
    iface: 'cli',
    place: cliDm,
    author: 'cli:owner',
    text: 'καλημέρα',
    at: '2026-11-01T11:00:00.000Z',
    audience: { dm: cliDm, iface: 'cli', person: OWNER },
  });
  return { w, fakeDm, cliDm };
}

describe('memory db direct chats', () => {
  after(() => {
    for (const world of worlds) world.close();
  });

  test('a person named by name has the direct chats of all their accounts, newest first', () => {
    // Bug: a direct chat has no handle, so the persona has no way to name the owner's chat on another interface in a call.
    const { w, fakeDm, cliDm } = world();
    assert.deepEqual(directChatsOf(w.db, internalContext(), 'Ορέστης'), {
      kind: 'chats',
      personId: OWNER,
      places: [cliDm, fakeDm],
    });
  });

  test('a person named by the handle a request showed has the same direct chats', () => {
    // Bug: only a name resolves, so the @handle the persona sees in their memory names nobody.
    // The handle a request shows is the person's, cut from the meta-person id, so it names the person on every
    // interface.
    const { w, fakeDm, cliDm } = world();
    const found = directChatsOf(w.db, internalContext(), `@${handleOf(OWNER)}`);
    assert.deepEqual(found, { kind: 'chats', personId: OWNER, places: [cliDm, fakeDm] });
  });

  test('words that name nobody give the people the graph ranks for them, with their handles', () => {
    // Bug: a description of a person is refused bare, and the persona asks the owner for an id instead of which person was meant.
    const { w } = world();
    const text = 'Ζωγραφίζει κάστρα με κάρβουνο.';
    insertRows(w.db, {
      descriptions: [
        {
          id: 'd:owner:c',
          subject_kind: 'person',
          subject_id: OWNER,
          field: 'character',
          current_version: 'd:owner:c:v1',
          scope_kind: 'group',
          scope_iface: 'fake',
        },
      ],
      description_versions: [
        {
          id: 'd:owner:c:v1',
          description_id: 'd:owner:c',
          text,
          author: 'her',
          written_at: AT,
          chars: text.length,
          origin: 'review',
        },
      ],
    });
    const found = directChatsOf(w.db, groupContext('fake'), 'κάστρα κάρβουνο');
    const people = found.kind === 'found' ? found.people : [];
    assert.deepEqual(
      people.map((person) => person.id),
      [OWNER]
    );
    const back = directChatsOf(w.db, groupContext('fake'), `@${people[0]?.handle ?? ''}`);
    assert.equal(
      back.kind === 'chats' ? back.personId : null,
      OWNER,
      'the handle the persona is given names the person again'
    );
  });

  test('a reference nothing fits finds no person', () => {
    // Bug: an empty or unknown reference picks some person's chat.
    const { w } = world();
    assert.deepEqual(directChatsOf(w.db, internalContext(), 'Θεόφιλος'), { kind: 'none' });
    assert.deepEqual(directChatsOf(w.db, internalContext(), '  '), { kind: 'none' });
  });

  test('words that fit nobody find a person by the vector of their names, and say no word fit in full', () => {
    // Bug: a person named in another language than their names is never offered, so the read ends unknown.
    const { w } = world();
    const pending = pendingObjectEmbeds(w.db, { model: 'test/embedder', limit: 1000 }).find(
      (one) => one.kind === 'names' && one.itemId === `person:${OWNER}`
    );
    assert.ok(pending, 'the owner has a name set to embed');
    const { kind, itemId, audienceId, hash } = pending;
    applyMemoryWrite(w.handle, {
      kind: 'object-embedding',
      model: 'test/embedder',
      now: Date.parse(AT),
      items: [{ kind, itemId, audienceId, hash, vector: [1, 0, 0] }],
    });
    assert.deepEqual(directChatsOf(w.db, internalContext(), 'Orestes'), { kind: 'none' });
    const found = directChatsOf(w.db, internalContext(), 'Orestes', {}, { vector: [1, 0, 0], model: 'test/embedder' });
    assert.equal(found.kind, 'found');
    assert.deepEqual(found.kind === 'found' ? found.people.map((one) => [one.id, one.hasEveryWord]) : [], [
      [OWNER, false],
    ]);
  });

  test("a person named by name has their direct chats whatever their graph node's id spells", () => {
    // Bug: the person was cut out of the text of the name's graph node id, so a node whose id does not spell
    // `person:<row id>` named nobody. The node's row id is stored in `graph_nodes.row_id`.
    const { w, fakeDm, cliDm } = world();
    rekeyNode(w.db, graphNodeId('person', OWNER), 'node-7f3a');
    assert.deepEqual(directChatsOf(w.db, internalContext(), 'Ορέστης'), {
      kind: 'chats',
      personId: OWNER,
      places: [cliDm, fakeDm],
    });
  });
});
