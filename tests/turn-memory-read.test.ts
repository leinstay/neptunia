// memory.read through the in-turn tools (src/turn/in-turn-tools.ts): one read of what memory holds about one subject, a
// person, a place or a lore entry, rendered as the `<memory>` block renders it and read under the turn's memory context.
// Slice 12 of the lookup loop. The handler is called as `conversation.read` is, with the subject as she writes it:
//   handlers['memory.read']({ subject, section?, limit? }) -> { status; code?; reason?; data?: { text } }
// `ok` carries the rendered entry in `data.text`. A subject that matches nothing answers `invalid` / `not-found`, one
// that matches two persons `invalid` / `target-ambiguous` with the candidates in `data.text`, an unknown section
// `invalid` / `invalid-args` / `args.section` with the sections in `data.text`. A real memory database, invented Greek.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import '../src/tools/operations/index.ts';
import { createInTurnTools } from '../src/turn/in-turn-tools.ts';
import { turnRoutes } from '../src/behavior/turn-ability-route.ts';
import { frameReadsOver } from '../src/memory/db/frame-reads.ts';
import { dmContext, groupContext } from '../src/memory/db/scope.ts';
import type { Context } from '../src/memory/db/scope.ts';
import { insertRows } from '../src/memory/db/rows.ts';
import { CHANNEL_HANDLE_PREFIX, HANDLE_DIGITS, handleOf } from '../src/behavior/handles.ts';
import {
  AT,
  NOW,
  addClaim,
  addDm,
  addPerson,
  addRoom,
  noteInterface,
  openWorld,
  rootId,
} from './fixtures/memory-db/mind-world.ts';
import type { World } from './fixtures/memory-db/mind-world.ts';
import { channel, rig } from './fixtures/reads-rig.ts';
import { labels } from './fixtures/labels.ts';
import type { Db } from '../src/memory/db/types.ts';

const ROOT = rootId('fake', 'g1');
const ELENI = 'person:eleni';
const CHARACTER = 'ΗΣΥΧΗ-ΚΗΠΟΥΡΟΣ-ΠΟΥ-ΓΕΛΑΕΙ-ΑΡΓΑ';
const RELATION = 'ΦΙΛΗ-ΤΩΝ-ΒΟΤΑΝΩΝ';
const SECRET = 'ΜΥΣΤΙΚΟ-ΠΟΥ-ΕΙΠΕ-ΜΟΝΟ-ΣΕ-ΕΜΕΝΑ';
const EPISODE = 'ΜΑΖΕΨΑΜΕ-ΕΛΙΕΣ-ΣΤΟΝ-ΚΗΠΟ';
const PURPOSE = 'ΤΟΠΟΣ-ΓΙΑ-ΣΠΟΡΟΥΣ-ΚΑΙ-ΦΥΤΑ';
const LORE_TITLE = 'Ο θρύλος του πηγαδιού';
const LORE_TEXT =
  'Λένε πως το παλιό πηγάδι στην άκρη της αγοράς δεν στέρεψε ποτέ, ούτε το καλοκαίρι της μεγάλης ξηρασίας. ' +
  'Όποιος ρίξει μέσα ένα κουκούτσι ελιάς και πει το όνομα ενός φίλου, θα τον ξαναδεί πριν πέσουν τα φύλλα. ' +
  'Τέλος-του-θρύλου.';
const NIKOS_A = 'ΨΑΡΑΣ-ΑΠΟ-ΤΟ-ΛΙΜΑΝΙ';
const NIKOS_B = 'ΦΟΥΡΝΑΡΗΣ-ΑΠΟ-ΤΗ-ΓΕΙΤΟΝΙΑ';

/** The owner's values of 2026-11-06 for `context.memory`. */
const MEMORY_SETTINGS = {
  windowMessages: 100,
  serviceMessages: 100,
  maxHops: 2,
  maxNodesRead: 2000,
  budgetTokens: 10000,
  shares: { people: 0.5, places: 0.15, lore: 0.15, recent: 0.1, found: 0.1 },
  counterpartTokens: 1500,
  candidatesMax: 3,
  commonWordEntries: 3,
  fanOut: { accounts: 10, memberships: 20, rooms: 10, members: 8, replies: 5, about: 30 },
};

type Answer = { status: string; code?: string; reason?: string; data?: { text: string } };

/** One current description of a subject, in the groups of `fake` or in one direct chat. */
function describe(
  db: Db,
  { id, kind, subject, field, text }: { id: string; kind: string; subject: string; field: string; text: string }
): void {
  insertRows(db, {
    descriptions: [
      {
        id,
        subject_kind: kind,
        subject_id: subject,
        field,
        current_version: `${id}:v1`,
        scope_kind: 'group',
        scope_iface: 'fake',
      },
    ],
    description_versions: [
      { id: `${id}:v1`, description_id: id, text, author: 'her', written_at: AT, chars: text.length, origin: 'review' },
    ],
  });
}

/**
 * The root Agora of `fake` with the room κήπος, Eleni with her description and relation, an episode she shares with her
 * in the room, a claim Eleni told her in their direct chat, the room's purpose, and a lore entry of the root.
 */
function seed(world: World): { room: string; dm: string } {
  noteInterface(world, 'fake', [{ id: 'g1', name: 'Αγορά' }]);
  const room = addRoom(world.db, { iface: 'fake', native: 'c7', root: ROOT, name: 'κήπος' });
  addPerson(world.db, { id: ELENI, accounts: [{ id: 'fake:u1', iface: 'fake', native: 'u1', names: ['Ελένη'] }] });
  describe(world.db, { id: 'd:eleni:c', kind: 'person', subject: ELENI, field: 'character', text: CHARACTER });
  describe(world.db, { id: 'd:eleni:r', kind: 'person', subject: ELENI, field: 'relationship', text: RELATION });
  describe(world.db, { id: 'd:room:p', kind: 'place', subject: room, field: 'purpose', text: PURPOSE });
  const dm = addDm(world.db, { iface: 'fake', native: 'u1', person: ELENI, account: 'fake:u1' });
  addClaim(world.db, {
    id: 'claim:secret',
    person: ELENI,
    kind: 'fact',
    text: SECRET,
    audience: { dm, iface: 'fake', person: ELENI },
  });
  insertRows(world.db, {
    episodes: [
      {
        id: 'episode:olives',
        subject_id: ELENI,
        place_id: room,
        date: '2026-10-30',
        what: EPISODE,
        scope_kind: 'group',
        scope_iface: 'fake',
        created_at: AT,
      },
    ],
    claims: [
      {
        id: 'lore:well',
        subject_kind: 'place',
        subject_id: ROOT,
        kind: 'lore',
        text: LORE_TEXT,
        truth: 'current',
        shown: 1,
        created_at: AT,
        extra: JSON.stringify({ title: LORE_TITLE, keys: ['πηγάδι'], always: false }),
        scope_kind: 'group',
        scope_iface: 'fake',
      },
    ],
  });
  return { room, dm };
}

/** memory.read of a turn under `context`, standing in the chat `where`, over the memory of `world`. */
function scene(
  world: World,
  context: Context,
  where = channel('here')
): (args: Record<string, unknown>) => Promise<Answer> {
  const io = rig();
  const hot = {
    config: { bot: { timezone: 'UTC' }, features: { coreTools: true }, context: { memory: MEMORY_SETTINGS } },
    prompts: { labels },
  };
  const tools = createInTurnTools({
    hot,
    store: { listUserProfiles: () => [] },
    recall: null,
    speech: null,
    record: null,
    routes: turnRoutes(hot, null),
    clock: () => NOW,
    ifaceReads: io.reads,
    lookup: undefined,
    describer: undefined,
    memberOf: () => null,
    chatOf: (current) => ({ iface: 'fake', chatId: current.id }),
    turnContextOf: () => context,
    placeReads: frameReadsOver(
      () => world.db,
      () => hot.config
    ),
    linkCalls: (lines) => lines,
    drawTool: () => Promise.reject(new Error('drawing is outside this fixture')),
  });
  const handlers = tools.inTurnTools({
    channel: where,
    placeId: 'g1',
    selfId: 'self',
    selfName: 'Synthetic persona',
    history: [],
    draft: {},
  });
  return async (args) => (await handlers['memory.read'](args)) as Answer;
}

/** A read under the groups of `fake`, in the room `here` of Agora. */
const groupRead = (world: World) => scene(world, groupContext('fake'));

/** Eleni's handle as she writes it. */
const ELENI_HANDLE = `@${handleOf('u1')}`;

/** The text of an `ok` answer, failing the test on any other status. */
function okText(answer: Answer): string {
  assert.equal(answer.status, 'ok', JSON.stringify(answer));
  return answer.data?.text ?? '';
}

test('returns what memory holds about a person named by handle, with their stored description', async () => {
  // Bug: the read finds no person for an @handle, or renders the person at name detail without the description.
  const world = openWorld();
  try {
    seed(world);
    const text = okText(await groupRead(world)({ subject: ELENI_HANDLE }));
    assert.ok(text.includes(CHARACTER), text);
  } finally {
    world.close();
  }
});

test("returns a place's stored notes for a place named by its #handle", async () => {
  // Bug: a #handle is taken as a person's name, or the place's purpose is left out of the answer.
  const world = openWorld();
  try {
    seed(world);
    const handle = `#${handleOf('c7', HANDLE_DIGITS, CHANNEL_HANDLE_PREFIX)}`;
    const text = okText(await groupRead(world)({ subject: handle }));
    assert.ok(text.includes(PURPOSE), text);
  } finally {
    world.close();
  }
});

test("returns a lore entry's full text for its title", async () => {
  // Bug: the title is matched against people and places only, or the entry comes back cut.
  const world = openWorld();
  try {
    seed(world);
    const text = okText(await groupRead(world)({ subject: LORE_TITLE }));
    assert.ok(text.includes(LORE_TEXT), text);
  } finally {
    world.close();
  }
});

test('answers not-found and reads nothing for a name that matches nothing', async () => {
  // Bug: an unknown name falls back to the person she answers or to the first person stored.
  const world = openWorld();
  try {
    seed(world);
    const answer = await groupRead(world)({ subject: 'Θεόφιλος' });
    assert.deepEqual([answer.status, answer.code], ['invalid', 'not-found'], JSON.stringify(answer));
    const told = JSON.stringify(answer);
    assert.equal(
      [CHARACTER, RELATION, PURPOSE, EPISODE].some((stored) => told.includes(stored)),
      false,
      told
    );
  } finally {
    world.close();
  }
});

test('names both candidates and reads neither when a name matches two persons', async () => {
  // Bug: the first of two people with one name is read as if she meant them.
  const world = openWorld();
  try {
    seed(world);
    addPerson(world.db, {
      id: 'person:nikos-a',
      accounts: [{ id: 'fake:u2', iface: 'fake', native: 'u2', names: ['Νίκος'] }],
    });
    addPerson(world.db, {
      id: 'person:nikos-b',
      accounts: [{ id: 'fake:u3', iface: 'fake', native: 'u3', names: ['Νίκος'] }],
    });
    describe(world.db, { id: 'd:na:c', kind: 'person', subject: 'person:nikos-a', field: 'character', text: NIKOS_A });
    describe(world.db, { id: 'd:nb:c', kind: 'person', subject: 'person:nikos-b', field: 'character', text: NIKOS_B });
    const answer = await groupRead(world)({ subject: 'Νίκος' });
    assert.deepEqual([answer.status, answer.code], ['invalid', 'target-ambiguous'], JSON.stringify(answer));
    const text = answer.data?.text ?? '';
    assert.ok(text.includes(`@${handleOf('u2')}`) && text.includes(`@${handleOf('u3')}`), text);
    assert.equal(text.includes(NIKOS_A) || text.includes(NIKOS_B), false, text);
  } finally {
    world.close();
  }
});

test('leaves out a claim kept in the direct chat with the subject when the turn is in a shared place', async () => {
  // Bug: the read runs as the owner's command, so what Eleni told her alone is shown in a room.
  const world = openWorld();
  try {
    seed(world);
    const text = okText(await groupRead(world)({ subject: ELENI_HANDLE }));
    assert.ok(text.includes(RELATION), text);
    assert.equal(text.includes(SECRET), false, text);
  } finally {
    world.close();
  }
});

test('returns the claim kept in the direct chat with the subject when the turn is that chat', async () => {
  // Bug: the read takes the groups' audience whatever the turn, so their own chat loses what she was told there.
  const world = openWorld();
  try {
    const { dm } = seed(world);
    const read = scene(world, dmContext(ELENI, 'fake', dm), channel('u1', { kind: 'dm', rootId: null }));
    const text = okText(await read({ subject: ELENI_HANDLE }));
    assert.ok(text.includes(SECRET), text);
  } finally {
    world.close();
  }
});

test('returns only the shared episodes with section episodes', async () => {
  // Bug: the section is ignored and the whole entry comes back, or the episodes are missing from it.
  const world = openWorld();
  try {
    seed(world);
    const text = okText(await groupRead(world)({ subject: ELENI_HANDLE, section: 'episodes' }));
    assert.ok(text.includes(EPISODE), text);
    assert.equal(text.includes(CHARACTER) || text.includes(RELATION), false, text);
  } finally {
    world.close();
  }
});

test('answers invalid-args with the sections for an unknown section', async () => {
  // Bug: an unknown section falls back to the summary, so she never learns which sections exist.
  const world = openWorld();
  try {
    seed(world);
    const answer = await groupRead(world)({ subject: ELENI_HANDLE, section: 'φόροι' });
    assert.deepEqual(
      [answer.status, answer.code, answer.reason],
      ['invalid', 'invalid-args', 'args.section'],
      JSON.stringify(answer)
    );
    const text = answer.data?.text ?? '';
    assert.ok(
      ['summary', 'episodes', 'changes'].every((section) => text.includes(section)),
      text
    );
    assert.equal(text.includes(CHARACTER), false, text);
  } finally {
    world.close();
  }
});

test("renders a person read as a <people> entry and carries none of the owner's command lines", async () => {
  // Bug: the read reuses memory.profile.read's view, with `updatedAt:`, `first seen:` and counts she cannot use.
  const world = openWorld();
  try {
    seed(world);
    const text = okText(await groupRead(world)({ subject: ELENI_HANDLE }));
    assert.match(text, new RegExp(`<people>[\\s\\S]*${CHARACTER}[\\s\\S]*</people>`), text);
    const operator = /^(updatedAt|first seen|last seen|messages|former names|aliases|attitude|episodes): /m;
    assert.equal(operator.test(text), false, text);
  } finally {
    world.close();
  }
});
