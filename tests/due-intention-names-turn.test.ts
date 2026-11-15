// The memory read matches names in the text of a due intention (spec 2026-11-15-names-in-a-due-intention): a wake due
// for an intention seeds the graph reader with the intention's text as one more trigger line, so a person the
// intention names in plain words has an entry of `<people>` in that turn's request. A reply turn, and a wake whose
// intention names nobody, read memory as before. The turns run over the service world's memory (the room `c1` holds
// Ελένη's line) with two more people no line of the world names. Invented names in Greek; both names are indeclinable,
// so the text holds each exactly as the name index stores it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addPerson, deny, personNode } from './fixtures/memory-db/mind-world.ts';
import type { World } from './fixtures/memory-db/mind-world.ts';
import { useIface } from './fixtures/turn-world.ts';
import { C1_CHAT, TURN_NOW, replyRun, serviceTurn, serviceWake, serviceWorld } from './fixtures/service-turn.ts';
import type { ServiceRun } from './fixtures/service-turn.ts';

useIface('fake');

const MYRTO = 'person:fake:7001';
const KLEIO = 'person:fake:7002';
const MYRTO_NAME = 'Μυρτώ';
const KLEIO_NAME = 'Κλειώ';
const NAMES_MYRTO = 'να ρωτήσω τη Μυρτώ για το βιβλίο';
const NAMES_KLEIO = 'να θυμίσω στην Κλειώ την πρόβα';
const NAMES_NOBODY = 'να ποτίσω τα φυτά το απόγευμα';

type Made = { intention?: { id: string } };

/** The service world with Μυρτώ and Κλειώ stored, each with one account whose name the name index holds. */
function worldWithNamed(): World {
  const world = serviceWorld();
  addPerson(world.db, {
    id: MYRTO,
    accounts: [{ id: 'fake:7001', iface: 'fake', native: '7001', names: [MYRTO_NAME] }],
  });
  addPerson(world.db, {
    id: KLEIO,
    accounts: [{ id: 'fake:7002', iface: 'fake', native: '7002', names: [KLEIO_NAME] }],
  });
  return world;
}

/** The body of `<people>` in a request's user text, '' when the request has none. */
function peopleOf(text: string): string {
  return /<people>\n([\s\S]*?)\n<\/people>/.exec(text)?.[1] ?? '';
}

/**
 * One intention turn over `world`, its wake due for one intention per text of `purposes`: in `c1` with the intentions
 * placed there, or nowhere with intentions that have no destination when `placeless` is set.
 */
async function dueTurn(world: World, purposes: ReadonlyArray<string>, placeless = false): Promise<ServiceRun> {
  const due: Array<{ id: string; purpose: string; dueAt: number }> = [];
  return serviceTurn({
    world,
    wake: () =>
      serviceWake('intention_due', {
        items: [{ kind: 'intention_due', reason: 'due', intentionIds: due.map((one) => one.id), errandId: null }],
        intentions: due,
        chainId: due[0]?.id ?? 'none',
      }),
    seed: (service) => {
      for (const [i, purpose] of purposes.entries()) {
        const dueAt = TURN_NOW - (i + 1) * 60_000;
        const destination = placeless ? null : 'c1';
        const made = service.set({ purpose, dueAt, destination, by: 'persona' }) as Made;
        due.push({ id: made.intention?.id ?? '', purpose, dueAt });
      }
    },
    answers: ['<skip/>'],
    chat: placeless ? null : { iface: 'fake', chatId: 'c1' },
  });
}

test('a placeless wake due for an intention that names a stored person shows that person in <people>', async () => {
  // Catches: the extra seed is added on the path of a turn with a place only, so an intention with no destination, the
  // turn that most needs its text read, still wakes her with no entry of the person it is about.
  const world = worldWithNamed();
  try {
    const run = await dueTurn(world, [NAMES_MYRTO], true);
    const people = peopleOf(run.requests[0] ?? '');
    assert.ok(people.includes(MYRTO_NAME), `<people> lacks ${MYRTO_NAME}:\n${people}`);
  } finally {
    world.close();
  }
});

test('a placeless wake due for an intention that names nobody shows no entry of a stored person', async () => {
  // Catches: the placeless read raises people its intention does not name, such as every stored person it can reach.
  const world = worldWithNamed();
  try {
    const run = await dueTurn(world, [NAMES_NOBODY], true);
    assert.equal(peopleOf(run.requests[0] ?? '').includes(MYRTO_NAME), false);
  } finally {
    world.close();
  }
});

test('a wake due for an intention that names a stored person shows that person in <people>', async () => {
  // Catches: the seeds of a due wake hold only the chat's lines, so the person the intention is about has no entry and
  // she addresses them by guesswork (the wrong gender of 2026-11-15).
  const world = worldWithNamed();
  try {
    const run = await dueTurn(world, [NAMES_MYRTO]);
    const people = peopleOf(run.requests[0] ?? '');
    assert.ok(people.includes(MYRTO_NAME), `<people> lacks ${MYRTO_NAME}:\n${people}`);
  } finally {
    world.close();
  }
});

test('a wake due for an intention that names nobody shows no entry of a stored person', async () => {
  // Catches: the intention's text raises people it does not name, such as every stored person or a fuzzy match on any
  // word, which spends the memory budget on strangers to the turn.
  const world = worldWithNamed();
  try {
    const run = await dueTurn(world, [NAMES_NOBODY]);
    const people = peopleOf(run.requests[0] ?? '');
    assert.equal(people.includes(MYRTO_NAME), false, people);
    assert.equal(people.includes(KLEIO_NAME), false, people);
  } finally {
    world.close();
  }
});

test('a reply turn with an open intention not yet due raises no one from the intention text', async () => {
  // Catches: every open intention seeds the read, or a reply turn reads the intentions of `<intentions>` as lines, so a
  // person named in a plan for tomorrow shows up in every reply of the room.
  const world = worldWithNamed();
  try {
    const run = await replyRun({
      world,
      seed: (service) => {
        service.set({ purpose: NAMES_MYRTO, dueAt: TURN_NOW + 5 * 3_600_000, destination: 'c1', by: 'persona' });
      },
      steps: [{ trigger: { id: 'q1', text: 'καλημέρα σε όλους', at: TURN_NOW - 30_000 }, answers: ['<skip/>'] }],
      chat: C1_CHAT,
    });
    const [firstTurn] = run.requests;
    const text = firstTurn?.[0] ?? '';
    assert.ok(text.includes('<people>'), 'the reply request has a <people> block (Ελένη answers)');
    assert.equal(peopleOf(text).includes(MYRTO_NAME), false, peopleOf(text));
  } finally {
    world.close();
  }
});

test('a wake due for two intentions naming two people shows both in <people>', async () => {
  // Catches: only the first due intention, or only the one the wake's chain is named after, joins the seeds.
  const world = worldWithNamed();
  try {
    const run = await dueTurn(world, [NAMES_MYRTO, NAMES_KLEIO]);
    const people = peopleOf(run.requests[0] ?? '');
    assert.ok(people.includes(MYRTO_NAME), `<people> lacks ${MYRTO_NAME}:\n${people}`);
    assert.ok(people.includes(KLEIO_NAME), `<people> lacks ${KLEIO_NAME}:\n${people}`);
  } finally {
    world.close();
  }
});

test('a due intention naming a person the turn may not see shows only the visible one', async () => {
  // Catches: the intention's line is matched past the audience rule (a seed added after the read's access check), so a
  // person hidden from this room leaks into its request. Κλειώ, visible, shows that the line was read at all.
  const world = worldWithNamed();
  deny(world.db, personNode(MYRTO));
  try {
    const run = await dueTurn(world, [NAMES_MYRTO, NAMES_KLEIO]);
    const people = peopleOf(run.requests[0] ?? '');
    assert.ok(people.includes(KLEIO_NAME), `<people> lacks ${KLEIO_NAME}:\n${people}`);
    assert.equal(people.includes(MYRTO_NAME), false, people);
  } finally {
    world.close();
  }
});

test('two requests of the same due wake with nothing stored between them hold the same <people>', async () => {
  // Catches: the seed line takes an id or a time made fresh per turn (a random id, the clock) that reaches the entries
  // or their order, so the prompt cache misses on every due wake.
  const world = worldWithNamed();
  try {
    const first = peopleOf((await dueTurn(world, [NAMES_MYRTO])).requests[0] ?? '');
    const second = peopleOf((await dueTurn(world, [NAMES_MYRTO])).requests[0] ?? '');
    assert.ok(first.includes(MYRTO_NAME), `<people> lacks ${MYRTO_NAME}:\n${first}`);
    assert.equal(second, first);
  } finally {
    world.close();
  }
});
