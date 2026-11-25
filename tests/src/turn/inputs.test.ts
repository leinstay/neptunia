import assert from 'node:assert/strict';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { after, before, describe, test } from 'node:test';
import { reproject } from '../../../src/memory/db/graph.ts';
import type { Db } from '../../../src/memory/db/types.ts';
import '../../../src/tools/operations/index.ts';
import { blockOf, FRAME_NOW, TEXT as FRAME_TEXT, frameTurn } from '../../fixtures/diary-frame.ts';
import { entryOf } from '../../fixtures/diary-mirror.ts';
import type { SceneMemory } from '../../fixtures/diary-scene.ts';
import { wrongly } from '../../fixtures/loose-types.ts';
import { addAccount, addAuthority, addClaim, addDmPlace } from '../../fixtures/memory-db/opaque-people.ts';
import { mirrorScene } from '../../fixtures/mirror-scene.ts';
import {
  blockOf as replyTurnTailLinesBlockOf,
  serviceTurn,
  serviceWake,
  serviceWorld,
  TURN_NOW,
} from '../../fixtures/service-turn.ts';
import { shippedLabels } from '../../fixtures/shipped-labels.ts';
import { useIface, useSelf } from '../../fixtures/turn-world.ts';
import {
  directIn,
  mentionIn,
  postedIn,
  type Rig,
  type Running,
  seedDm,
  seedRoom,
  waitFor,
  withFakes,
} from '../../fixtures/two-fakes.ts';

const OPAQUE = 'person:4c9e77d1';

async function dmTurn(running: Running, chat: string, author: string, id: string): Promise<void> {
  seedDm(running, chat, author);
  await directIn(running, chat, author, id);
  await waitFor(() => postedIn(running, chat).length > 0, `the answer on ${running.iface}`);
}

/**
 * Rows the writer did not make, over a plain connection because the running core holds the writer's lock. Only before
 * the first event, and only rows no cache holds yet. It waits out a write of the core's start, which a loaded machine can still be in.
 */
function seedOver(rig: Rig, body: (db: Db) => void): void {
  const connection = new DatabaseSync(join(rig.dataDir, 'memory.db'), { timeout: 5000 });
  try {
    body(wrongly<Db>(connection));
  } finally {
    connection.close();
  }
}

test('a group turn issues its context for the place row of its room, not one spelled from the chat id', async () => {
  // Bug: src/turn/inputs.ts spelled `<iface>:channel:<id>`, so a room stored under an opaque id got a context of no place.
  await withFakes({ owners: ['u1'], names: ['one'] }, async (rig) => {
    const one = await rig.connect('one', [{ id: 'g1', name: 'Alpha' }]);
    seedOver(rig, (db) => {
      addAuthority(db, 'one', 'one/global');
      db.prepare(
        `INSERT INTO places (id, iface, kind, native_id, native_key, authority_id, generation, chat, scope_kind)
         VALUES ('place:opaque-r1', 'one', 'channel', 'r1', 'channel:r1', 'one/global', 1, 'group', 'group')`
      ).run();
    });
    seedRoom(one, 'r1', 'g1');
    await mentionIn(one, 'r1', 'g1', 'm1');
    await waitFor(() => postedIn(one, 'r1').length > 0, 'the answer in the room');
    const issued = rig.rows(
      "SELECT DISTINCT destination_place_id AS place FROM execution_contexts WHERE mode = 'outward'"
    );
    assert.deepEqual(
      issued.map((row) => row.place),
      ['place:opaque-r1']
    );
  });
});

test('a DM turn issues its context for the person stored on the account, not one spelled from the native id', async () => {
  // Bug: src/turn/inputs.ts manufactures `person:<iface>:<native>`, so an opaque person gets a context of nobody.
  await withFakes({ ownerPerson: OPAQUE, names: ['one'] }, async (rig) => {
    const one = await rig.connect('one', []);
    seedOver(rig, (db) => {
      addAccount(db, { id: 'account:u1', iface: 'one', authority: 'one/global', native: 'u1', person: OPAQUE });
    });
    await dmTurn(one, 'dm-1', 'u1', 'm1');
    const issued = rig.rows("SELECT partner_person_id FROM execution_contexts WHERE mode = 'outward'");
    assert.ok(issued.length > 0);
    assert.deepEqual([...new Set(issued.map((row) => row.partner_person_id))], [OPAQUE]);
  });
});

test('what the person said in a linked DM on another interface reaches the request, and a stranger DM does not', async () => {
  // Bug: the request reads one root's unit of one account, so a private-only person arrives with empty memory.
  await withFakes({ ownerPerson: OPAQUE, names: ['one'] }, async (rig) => {
    const one = await rig.connect('one', []);
    seedOver(rig, (db) => {
      addAccount(db, { id: 'account:u1', iface: 'one', authority: 'one/global', native: 'u1', person: OPAQUE });
      addAccount(db, { id: 'account:far', iface: 'far', authority: 'far/global', native: 'n1', person: OPAQUE });
      addAccount(db, {
        id: 'account:else',
        iface: 'far',
        authority: 'far/global',
        native: 'n2',
        person: 'person:else',
      });
      addDmPlace(db, {
        id: 'place:far',
        iface: 'far',
        authority: 'far/global',
        account: 'account:far',
        person: OPAQUE,
      });
      addDmPlace(db, {
        id: 'place:else',
        iface: 'far',
        authority: 'far/global',
        account: 'account:else',
        person: 'person:else',
      });
      addClaim(db, 'claim:far', OPAQUE, 'aud:dm:place:far', 'keeps bees on a synthetic roof');
      addClaim(db, 'claim:else', OPAQUE, 'aud:dm:place:else', 'owes a synthetic debt');
      // Slice 4: the request reads memory through the graph reader, so the seeded rows get the projection every writer
      // of the memory makes in its own transaction (src/memory/db/graph.ts#projectRow), as a live database has it.
      reproject(db, { tables: ['interfaces', 'authorities', 'people', 'accounts', 'places', 'claims'] });
    });
    await dmTurn(one, 'dm-1', 'u1', 'm1');
    const requests = JSON.stringify(rig.requests);
    assert.ok(requests.includes('keeps bees on a synthetic roof'));
    assert.equal(requests.includes('owes a synthetic debt'), false);
  });
});

useSelf('self-id');

// The diary wake keeps the id of its turn on the entry as `extra.turnId`, written through the one writer. The
// wake runs the real turn runner over tests/fixtures/diary-scene.ts with a real journal. Invented ids and
// synthetic text only.

/** The scenes a test opened, closed when the file is done. */
const OPEN: Array<SceneMemory> = [];

after(async () => {
  for (const scene of OPEN.splice(0)) await scene.memory.close();
});

describe('a diary turn', () => {
  before(() => useIface('fake'));
  after(() => useIface('discord'));

  test('the diary turn lists the group rooms of two interfaces in <memory>, no direct chat, and holds no <meanwhile>', async () => {
    // Bug: the diary keeps the chat turns' `<meanwhile>`, reads one interface, or lets a private chat in.
    const run = await frameTurn({ memorySettings: { openPrivate: false } });
    const text = run.writer[0] ?? '';
    const memory = blockOf(text, 'memory');
    assert.ok(memory.includes('"κήπος"'), memory);
    assert.ok(memory.includes('"λιμάνι"'), memory);
    assert.ok(!memory.includes('dm with'), memory);
    assert.equal(blockOf(text, 'meanwhile'), '');
  });

  test('with context.memory.openPrivate on, the diary turn lists the direct chat and the group entry reaches its mirror', async () => {
    // Bug: the switch opens the persona's memory, but the diary still reads the groups alone, or the open read leaks into the
    // entry's audience and the publication boundary refuses the copy.
    const scene = await mirrorScene({ start: FRAME_NOW, config: { context: { memory: { openPrivate: true } } } });
    const run = await frameTurn({ memory: scene.memory, entries: 0, memorySettings: { openPrivate: true } });
    assert.ok(blockOf(run.writer[0] ?? '', 'memory').includes('dm with'));
    const stored = scene.db.prepare('SELECT scope_kind, scope_dm FROM diary').all();
    assert.deepEqual(
      stored.map((row) => [row.scope_kind, row.scope_dm]),
      [['group', null]]
    );
    const mirrors = scene.publisher();
    await mirrors.publishEntry(entryOf(run.result));
    await mirrors.drainQueued();
    assert.deepEqual(scene.transport('fake').posted('d1'), [FRAME_TEXT.entry]);
  });
});

const MIN = 60_000;

/** The `#c…` handle of the garden's entry of `<places>`: the entry whose heading holds its name. */
function gardenHandle(request: string): string {
  const places = /<places>\n?([\s\S]*?)\n?<\/places>/.exec(replyTurnTailLinesBlockOf(request, 'memory'))?.[1] ?? '';
  const entry = places.split(/\n\s*\n/).find((one) => (one.split('\n')[0] ?? '').includes('κήπος')) ?? '';
  return /#c[0-9a-z]+/.exec(entry)?.[0] ?? '';
}

const bodyOf = (request: string, tag: string): string =>
  new RegExp(`<${tag}>\\n([\\s\\S]*?)\\n</${tag}>`).exec(request)?.[1] ?? '';

/** The line of `<intentions>` that holds the purpose of the intention the turns below seed, '' when none does. */
function intentionLine(request: string): string {
  const lines = bodyOf(request, 'intentions').split('\n');
  return lines.find((one) => one.includes('ΣΚΟΠΟΣ-ΣΤΟ-ΔΩΜΑΤΙΟ')) ?? '';
}

/** The intention turn of the room `c1` with one open intention that begins in that room. */
async function intentionTurn(destination = 'c1'): Promise<string> {
  const world = serviceWorld();
  try {
    const due = { id: '' };
    const run = await serviceTurn({
      world,
      wake: () =>
        serviceWake('intention_due', {
          items: [{ kind: 'intention_due', reason: 'due', intentionIds: [due.id], errandId: null }],
          intentions: [{ id: due.id, purpose: 'ΣΚΟΠΟΣ-ΣΤΟ-ΔΩΜΑΤΙΟ', dueAt: TURN_NOW - MIN }],
          chainId: due.id,
        }),
      answers: ['<skip/>'],
      chat: { iface: 'fake', chatId: 'c1' },
      seed: (service) => {
        const made = service.set({
          purpose: 'ΣΚΟΠΟΣ-ΣΤΟ-ΔΩΜΑΤΙΟ',
          dueAt: TURN_NOW - MIN,
          destination,
          by: 'persona',
        }) as { intention?: { id: string } };
        due.id = made.intention?.id ?? '';
      },
    });
    return run.requests[0] ?? '';
  } finally {
    world.close();
  }
}

describe('the tail lines of a reply turn', () => {
  before(() => useIface('fake'));
  after(() => useIface('discord'));

  test('the destination of an intention in a stored place the interface snapshot lacks reads as that place handle', async () => {
    // Bug: the destination is named through the interface's chat snapshot alone, so the garden, which memory holds and the
    // snapshot lacks, reads as the word for an unnamed place.
    const request = await intentionTurn('c2');
    const handle = gardenHandle(request);
    assert.match(handle, /^#c[0-9a-z]+$/, 'the garden has an entry of <places> with a handle');
    const line = intentionLine(request);
    assert.ok(line.includes(handle), line);
    const { spatial } = shippedLabels;
    const unnamed: unknown = spatial?.unnamed;
    assert.ok(typeof unnamed === 'string' && unnamed !== '' && !line.includes(unnamed), line);
  });
});
